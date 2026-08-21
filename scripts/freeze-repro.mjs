/**
 * 🧊 GUEST-FREEZE soak repro - two real headless-Chrome clients in a chaos
 * room, playing like humans for ~90s: REAL mouse aim (mousemove), click-ish
 * firing via the solved-shot hook, weapon-slot keys 2-4 (crates are constant
 * in chaos, so cluster/guided/tomahawk all fly), drive, jump, die, respawn.
 *
 * Freeze detection (two layers):
 *   1. Runtime.exceptionThrown - an uncaught error in the game's rAF frame
 *      kills the loop → frozen canvas (the reported bug class)
 *   2. game-loop liveness probe: after any shot, the shooter's reload clock
 *      (tank.cd) must tick 1 → 0 - it only moves inside update()
 *
 * Run the server first (long match clock):
 *   CHAOS_DURATION_MS=180000 CHAOS_RESPAWN_MS=2500 CHAOS_FIRE_GRACE_MS=1 PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 PLAY_S=90 node scripts/freeze-repro.mjs
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { writeFileSync } from 'node:fs';

const BASE = process.env.URL || 'http://localhost:3210';
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOM = 'frz' + Math.random().toString(36).slice(2, 7);
const PLAY_S = Number(process.env.PLAY_S || 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('✅ ' + m);
const fail = (m) => { console.error('❌ ' + m); failed = true; };
const info = (m) => console.log('ℹ️  ' + m);

async function launch(port, tag) {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/bot-frz-${port}`,
    '--window-size=1600,900', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let k = 0; k < 30 && !target; k++) {
    await sleep(400);
    try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((t) => t.type === 'page'); } catch { /* retry */ }
  }
  if (!target) throw new Error(`no CDP target for ${tag}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const txt = (d?.exception?.description ?? d?.text ?? '') + (d?.stackTrace ? ' | ' + d.stackTrace.callFrames.map((f) => `${f.functionName}@${f.url.split('/').pop()}:${f.lineNumber}`).join(' ← ') : '');
      exceptions.push(txt);
      console.log(`💥 [${tag}] EXCEPTION:`, txt.slice(0, 500));
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  const evalJs = async (expr, ms = 15000) => {
    const res = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ __timeout: true })),
    ]);
    if (res?.__timeout) throw new Error(`[${tag}] EVAL TIMEOUT (page wedged): ${expr.slice(0, 90)}`);
    if (res?.exceptionDetails) throw new Error(`[${tag}] eval: ` + (res.exceptionDetails.exception?.description ?? 'failed').slice(0, 300));
    return res?.result?.value;
  };
  const poll = async (expr, label, ms = 40000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await evalJs(expr); } catch { /* page still loading */ }
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`poll timeout: ${label}`);
      await sleep(300);
    }
  };
  return { chrome, send, evalJs, poll, tag, exceptions };
}

const t0 = Date.now();
const tsec = () => ((Date.now() - t0) / 1000).toFixed(1);
await fetch(`${BASE}/room/warmup`).catch(() => {});

const a = await launch(9261, 'A-host');
const b = await launch(9262, 'B-guest');
const spec = io(BASE, { transports: ['websocket'] });
let lastGs = null;
spec.on('game-state', (g) => { lastGs = g; });
try {
  await a.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Alice&mode=chaos&test=1` });
  await sleep(1200);
  await b.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Bob&test=1` });
  info(`room ${ROOM} - host first, guest second (invite order)`);

  await a.poll(`!![...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start') && !x.disabled)`, 'start button', 30000);
  for (let k = 0; k < 5; k++) {
    try { await a.evalJs(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start'))?.click()`, 8000); } catch { /* retry */ }
    if (await a.evalJs(`!!window.__bot`, 8000).catch(() => false)) break;
    await sleep(1000);
  }
  await a.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'A in-game', 60000);
  await b.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'B in-game', 60000);
  ok(`both in a chaos game (t=${tsec()}s)`);
  spec.emit('join-room', { roomId: ROOM, name: 'Spec', cid: 'spec-' + ROOM }, () => {});
  const aId = await a.evalJs(`__bot.myId()`);
  const bId = await b.evalJs(`__bot.myId()`);

  const CODE = { a: 'KeyA', d: 'KeyD', w: 'KeyW', 2: 'Digit2', 3: 'Digit3', 4: 'Digit4' };
  const key = (c, type, k) => c.evalJs(`window.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}', code: '${CODE[k] ?? k}', bubbles: true }))`).catch(() => {});
  // real mouse aim: move the cursor over the canvas so onMove runs every tick
  const mouseWiggle = (c) => c.evalJs(`(() => {
    const cv = document.querySelector('canvas'); if (!cv) return;
    const r = cv.getBoundingClientRect();
    const x = r.left + Math.random() * r.width, y = r.top + Math.random() * r.height * 0.6;
    cv.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  })()`).catch(() => {});

  // per-client human-ish driver: steer to crates, hold-and-refresh keys
  // (watchdog flushes 1.2s-stale holds), jump when wedged, pick slot 2-4 when
  // stocked, fire solved shots (mouse-aimed angles land via onMove too)
  const drive = async (c, myId, endAt) => {
    let held = null, lastX = null, stuckN = 0;
    const steer = async (dir) => {
      if (held === dir) { if (held) await key(c, 'keydown', held); return; }
      if (held) await key(c, 'keyup', held);
      held = dir;
      if (held) await key(c, 'keydown', held);
    };
    let probes = { fired: 0, loopDead: 0 };
    while (Date.now() < endAt) {
      await mouseWiggle(c);
      const tMe = lastGs?.tanks?.find((t) => t.id === myId);
      if (!tMe) { await sleep(300); continue; }
      if (!tMe.dead && !tMe.para) {
        // weapon slots: spend specials when stocked (2=cluster 3=guided 4=tomahawk)
        if ((tMe.inv?.tomahawk | 0) > 0) { await key(c, 'keydown', '4'); await key(c, 'keyup', '4'); }
        else if ((tMe.inv?.guided | 0) > 0) { await key(c, 'keydown', '3'); await key(c, 'keyup', '3'); }
        else if ((tMe.inv?.cluster | 0) > 0) { await key(c, 'keydown', '2'); await key(c, 'keyup', '2'); }
        const crate = (lastGs?.crates ?? []).filter((k) => !k.taken && k.landed)
          .sort((k1, k2) => Math.abs(k1.x - tMe.x) - Math.abs(k2.x - tMe.x))[0];
        const dx = crate ? crate.x - tMe.x : (tMe.x < 300 ? 1 : tMe.x > 1600 ? -1 : 0) * 999;
        if (Math.abs(dx) > 8) await steer(dx > 0 ? 'd' : 'a'); else await steer(null);
        if (lastX != null && Math.abs(tMe.x - lastX) < 0.3 && Math.abs(dx) > 30) {
          if (++stuckN >= 4) { stuckN = 0; await key(c, 'keydown', 'w'); await sleep(90); await key(c, 'keyup', 'w'); }
        } else stuckN = 0;
        lastX = tMe.x;
        // fire when the gun is live and the foe is shootable
        const foe = lastGs?.tanks?.find((t) => t.id !== myId && !t.dead);
        if (foe && (Date.now() - (tMe.cdAt || 0) > 900)) {
          const sol = await c.evalJs(`__bot.fireAt(${foe.x}, ${foe.y}, ${foe.para ? '__bot.PARA_FALL' : 0})`).catch(() => null);
          if (sol?.ok) {
            probes.fired++;
            // 🔎 game-loop liveness: the reload clock only ticks inside update()
            const cd0 = (await c.evalJs(`__bot.tanks()`)).find((t) => t.id === myId)?.cd ?? 0;
            await sleep(1400);
            const me1 = (await c.evalJs(`__bot.tanks()`)).find((t) => t.id === myId);
            const cd1 = me1?.cd ?? 9;
            // cd only ticks for a LIVE, LANDED tank (dead/para legitimately pause it)
            if (cd0 > 0.05 && cd1 > 0.05 && me1 && !me1.dead && !me1.para) {
              probes.loopDead++;
              fail(`[${c.tag}] GAME LOOP DEAD - reload clock frozen at ${cd1.toFixed(2)}s (canvas is frozen!) t=${tsec()}s`);
              return probes;
            }
          }
        }
      } else await steer(null);
      await sleep(350);
    }
    await steer(null);
    return probes;
  };

  const endAt = Date.now() + PLAY_S * 1000;
  const [pa, pb] = await Promise.all([drive(a, aId, endAt), drive(b, bId, endAt)]);
  info(`shots fired: A=${pa.fired}, B=${pb.fired}`);

  // final sweep: both loops alive, both clients consistent, zero exceptions
  const av = await a.evalJs(`__bot.tanks()`).catch(() => null);
  const bv = await b.evalJs(`__bot.tanks()`).catch(() => null);
  info(`A view: ${JSON.stringify(av)}`);
  info(`B view: ${JSON.stringify(bv)}`);
  info(`exceptions: A=${a.exceptions.length}, B=${b.exceptions.length}`);
  if (a.exceptions.length || b.exceptions.length) fail('uncaught exceptions (see above)');
  if (!pa.loopDead && !pb.loopDead) ok(`no freeze after ${PLAY_S}s of realistic 2-player chaos`);
  await a.send('Page.captureScreenshot', { format: 'png' }).then((s) => writeFileSync('/tmp/frz-A.png', Buffer.from(s.data, 'base64'))).catch(() => {});
  await b.send('Page.captureScreenshot', { format: 'png' }).then((s) => writeFileSync('/tmp/frz-B.png', Buffer.from(s.data, 'base64'))).catch(() => {});
} catch (e) {
  fail(e.message);
} finally {
  a.chrome.kill(); b.chrome.kill(); spec.close();
}
await sleep(200);
if (failed) { console.error('\n💥 freeze soak FAILED'); process.exit(1); }
console.log('\n🎉 freeze soak passed - both clients stayed live');
process.exit(0);
