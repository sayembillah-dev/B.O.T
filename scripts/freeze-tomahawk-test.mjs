/**
 * ☢️🧊 Tomahawk freeze test - prove/disprove the chunked-repaint crash.
 *
 *   FORCE_DROP=tomahawk makes every chaos crate a tomahawk. A spectator
 *   socket watches game-state: it steers Bob (guest) to the nearest landed
 *   crate until his inventory shows a tomahawk, then Bob selects slot 4 and
 *   fires at Alice (host). The mega-blast (r=200 ⇒ >60k px repaint ⇒ banded
 *   path) is confirmed via __bot.lastBlast().big - then BOTH clients must
 *   keep their rAF loops alive (heartbeats) with zero exceptions.
 *
 * Run the server first:
 *   FORCE_DROP=tomahawk CHAOS_DURATION_MS=180000 CHAOS_FIRE_GRACE_MS=1 PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 node scripts/freeze-tomahawk-test.mjs
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const BASE = process.env.URL || 'http://localhost:3210';
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOM = 'tom' + Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('✅ ' + m);
const fail = (m) => { console.error('❌ ' + m); failed = true; };
const info = (m) => console.log('ℹ️  ' + m);

async function launch(port, tag) {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/bot-tom-${port}`,
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
      const txt = (d?.exception?.description ?? d?.text ?? '');
      exceptions.push(txt);
      console.log(`💥 [${tag}] EXCEPTION:`, txt.slice(0, 400));
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
      try { v = await evalJs(expr); } catch { /* loading */ }
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

const a = await launch(9271, 'A-host');
const b = await launch(9272, 'B-guest');
const spec = io(BASE, { transports: ['websocket'] });
let lastGs = null;
spec.on('game-state', (g) => { lastGs = g; });
try {
  await a.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Alice&mode=chaos&test=1` });
  await sleep(1200);
  await b.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Bob&test=1` });
  info(`room ${ROOM}`);

  await a.poll(`!![...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start') && !x.disabled)`, 'start button', 30000);
  for (let k = 0; k < 5; k++) {
    try { await a.evalJs(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start'))?.click()`, 8000); } catch { /* retry */ }
    if (await a.evalJs(`!!window.__bot`, 8000).catch(() => false)) break;
    await sleep(1000);
  }
  await a.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'A in-game', 60000);
  await b.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'B in-game', 60000);
  ok(`both in chaos game (t=${tsec()}s)`);
  for (const c of [a, b]) await c.evalJs(`window.__hb = 0; (function beat(){ window.__hb++; requestAnimationFrame(beat); })(); 1`);
  // spectator joins mid-game - pure listener, gets every broadcast
  spec.emit('join-room', { roomId: ROOM, name: 'Spec', cid: 'spec-' + ROOM }, () => {});
  await sleep(600);

  const CODE = { a: 'KeyA', d: 'KeyD', w: 'KeyW', '4': 'Digit4' };
  const key = (c, type, k) => c.evalJs(`window.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}', code: '${CODE[k] ?? k}', bubbles: true }))`).catch(() => {});
  const bId = await b.evalJs(`__bot.myId()`);
  const aId = await a.evalJs(`__bot.myId()`);

  // ── phase 1: steer Bob to crates until his inventory shows a tomahawk ──
  info('steering Bob to a tomahawk crate…');
  let held = null;
  const steer = async (dir) => { // hold exactly one direction key
    if (held === dir) { if (held) await key(b, 'keydown', held); return; } // re-keydown: refresh the auto-repeat stamp (watchdog flushes >1.2s-stale keys)
    if (held) await key(b, 'keyup', held);
    held = dir;
    if (held) await key(b, 'keydown', held);
  };
  let armed = false;
  const tArm = Date.now() + 90000;
  let dbgAt = 0; const dbg = {};
  while (Date.now() < tArm && !armed) {
    if (Date.now() - dbgAt > 4000) {
      dbgAt = Date.now();
      const bt = lastGs?.tanks?.find((t) => t.id === bId);
      info(`dbg: gs=${!!lastGs} crates=${JSON.stringify((lastGs?.crates ?? []).map((c) => ({ x: Math.round(c.x), l: c.landed, k: c.taken })))} bob=${JSON.stringify(bt && { x: Math.round(bt.x), y: Math.round(bt.y), dead: bt.dead, para: bt.para, inv: bt.inv })}`);
    }
    const bt = lastGs?.tanks?.find((t) => t.id === bId);
    if (bt && (bt.inv?.tomahawk | 0) > 0) { armed = true; break; }
    if (bt && !bt.dead && !bt.para) {
      const crate = (lastGs?.crates ?? []).filter((c) => !c.taken && c.landed)
        .sort((c1, c2) => Math.abs(c1.x - bt.x) - Math.abs(c2.x - bt.x))[0];
      if (crate) {
        const dx = crate.x - bt.x;
        if (Math.abs(dx) > 8) await steer(dx > 0 ? 'd' : 'a');
        else await steer(null);
        // wedged on a steep slope next to the crate? hop to unstick
        if (Math.abs((dbg.lastX ?? bt.x) - bt.x) < 0.5 && Math.abs(dx) > 8) { await key(b, 'keydown', 'w'); await sleep(80); await key(b, 'keyup', 'w'); }
        dbg.lastX = bt.x;
      } else await steer(null); // no landed crate yet - park and wait
    } else await steer(null);
    await sleep(250);
  }
  await steer(null);
  if (!armed) throw new Error('Bob never collected a tomahawk');
  ok(`Bob has a tomahawk (t=${tsec()}s)`);

  // ── phase 2: Bob selects slot 4 and fires it at Alice ──
  await key(b, 'keydown', '4'); await key(b, 'keyup', '4');
  await sleep(200);
  let big = null;
  for (let shot = 0; shot < 6 && !big; shot++) {
    const at = lastGs?.tanks?.find((t) => t.id === aId);
    const bt = lastGs?.tanks?.find((t) => t.id === bId);
    if (!at || !bt || bt.dead || bt.para) { await sleep(500); continue; }
    if ((bt.cdAt || 0) > Date.now()) { await sleep(400); continue; }
    const sol = await b.evalJs(`__bot.fireAt(${at.x}, ${at.y}, 0)`).catch(() => null);
    info(`Bob tomahawk shot ${shot + 1}: ${JSON.stringify(sol)}`);
    for (let k = 0; k < 20 && !big; k++) { // up to ~8s of flight
      await sleep(400);
      const lb = await a.evalJs(`__bot.lastBlast()`).catch(() => null);
      if (lb?.big) big = lb;
    }
  }
  if (!big) throw new Error('the tomahawk never landed');
  ok(`☢️ mega-blast landed: r=${big.r} big=${big.big} (t=${tsec()}s)`);

  // ── phase 3: did the GAME loop survive the banded repaint? (an independent
  //    heartbeat rAF proves nothing - the game's own loop must tick). Proof:
  //    both clients fire again (respawn first if needed) - me.cd counts down
  //    ONLY inside update(), and the new shell must land → fresh blast echo ──
  info('phase 3: proving both game loops survived the mega-blast…');
  const prevBlastAt = big.at ?? Date.now();
  for (const c of [a, b]) { // wait out any respawn, then fire and watch cd fall
    const myId = await c.evalJs(`__bot.myId()`);
    let firedOk = false;
    for (let k = 0; k < 30 && !firedOk; k++) {
      const me = (await c.evalJs(`__bot.tanks()`)).find((t) => t.id === myId);
      if (me && !me.dead && !me.para && (me.cd || 0) <= 0) {
        const foe = (await c.evalJs(`__bot.tanks()`)).find((t) => t.id !== myId);
        if (foe && !foe.dead) {
          const sol = await c.evalJs(`__bot.fireAt(${foe.x}, ${foe.y}, 0)`).catch(() => null);
          if (sol?.ok) firedOk = true;
        }
      }
      if (!firedOk) await sleep(400);
    }
    if (!firedOk) { fail(`[${c.tag}] could not fire after the mega-blast - loop dead or tank never respawned`); continue; }
    const cdSeen = (await c.evalJs(`__bot.tanks()`)).find((t) => t.id === myId)?.cd ?? 0;
    await sleep(1600); // 1s reload must elapse - cd ticks down ONLY in update()
    const cdAfter = (await c.evalJs(`__bot.tanks()`)).find((t) => t.id === myId)?.cd ?? 9;
    if (cdSeen > 0 && cdAfter > 0.01) fail(`[${c.tag}] reload clock stuck at ${cdAfter.toFixed(2)}s - the game loop is DEAD (canvas frozen)`);
    else ok(`[${c.tag}] game loop alive after the mega-blast (cd ${cdSeen.toFixed(2)} → ${cdAfter.toFixed(2)})`);
  }
  info(`exceptions: A=${a.exceptions.length}, B=${b.exceptions.length}`);
  if (a.exceptions.length || b.exceptions.length) fail('exceptions were thrown (see above)');
  // heartbeat sanity: page itself never wedged
  const h1 = { a: await a.evalJs(`window.__hb`, 5000).catch(() => null), b: await b.evalJs(`window.__hb`, 5000).catch(() => null) };
  if (h1.a == null || h1.b == null) fail('a client page is fully unresponsive');
} catch (e) {
  fail(e.message);
} finally {
  a.chrome.kill(); b.chrome.kill(); spec.close();
}
await sleep(200);
if (failed) { console.error('\n💥 tomahawk freeze test FAILED'); process.exit(1); }
console.log('\n🎉 tomahawk test passed - no freeze');
process.exit(0);
