/**
 * 🪂⚡ Chaos parachute IMMUNITY test - two real headless-Chrome clients.
 *
 *   1. Alice (host) + Bob join a chaos room, both drop in by parachute, land.
 *   2. CONTROL: Alice shoots Bob ON THE GROUND until he dies → proves the
 *      normal kill path works end-to-end in real browsers.
 *   3. LIVE CHUTE PROBE: Alice fires SOLVED intercepts at Bob mid-descent.
 *      Any blast report that catches him must show d:0 and unchanged HP -
 *      a parachuting tank is UNTOUCHABLE.
 *   4. FROZEN CHUTE (hard check): on a later respawn Bob's JS is frozen
 *      mid-descent (Debugger.pause ≈ background tab). Alice's view of Bob
 *      must hold at the last streamed y, and a shot dead-on at the frozen
 *      chute must be BLOCKED (d:0, HP unchanged).
 *   5. WINDOW CLOSES: after resume + touchdown, the very next shot must hurt -
 *      immunity ends the frame the tracks touch dirt.
 *
 * Run the server first (LONG match clock - the test needs ~60s of match time):
 *   CHAOS_DURATION_MS=120000 CHAOS_RESPAWN_MS=2500 CHAOS_FIRE_GRACE_MS=1 PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 node scripts/chaos-para-test.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.URL || 'http://localhost:3210';
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOM = 'para' + Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('✅ ' + m);
const fail = (m) => { console.error('❌ ' + m); failed = true; };
const info = (m) => console.log('ℹ️  ' + m);

/** attach a CDP WebSocket to one Chrome instance's page target */
async function launch(port, tag) {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/bot-para-${port}`,
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
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log(`💥 [${tag}]`, JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300));
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Debugger.enable');
  const evalJs = async (expr, ms = 20000) => {
    const res = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => ({ __timeout: true })),
    ]);
    if (res?.__timeout) throw new Error(`[${tag}] eval timeout: ${expr.slice(0, 90)}`);
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
  return { chrome, send, evalJs, poll, tag };
}

const t0 = Date.now();
const tsec = () => ((Date.now() - t0) / 1000).toFixed(1);
const a = await launch(9251, 'A');
const b = await launch(9252, 'B');
try {
  await a.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Alice&mode=chaos&test=1` });
  await sleep(1200); // stagger - Alice becomes host
  await b.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Bob&test=1` });
  info(`room ${ROOM} - both clients navigating`);

  // Alice: wait for the lobby start button, click it (retry - the click can
  // orphan its eval when the lobby unmounts mid-roundtrip)
  await a.poll(`!![...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start') && !x.disabled)`, 'start button', 30000);
  for (let k = 0; k < 5; k++) {
    try { await a.evalJs(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start'))?.click()`, 8000); } catch { /* retry */ }
    const started = await a.evalJs(`!!window.__bot`, 8000).catch(() => false);
    if (started) break;
    await sleep(1000);
  }
  info('start clicked');

  // both in-game with the hook live
  await a.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'A in-game', 60000);
  await b.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'B in-game', 60000);
  ok(`both clients in a chaos game (t=${tsec()}s)`);

  const aMyId = await a.evalJs(`__bot.myId()`);
  const tanksA = await a.evalJs(`__bot.tanks()`);
  info(`A sees: ${JSON.stringify(tanksA)}`);

  // ── wait for both landed on A's screen + countdown over + A's gun live ──
  await a.poll(`__bot.tanks().every((t) => !t.para) && __bot.turn().countdown <= 0`, 'everyone landed (A view)', 30000);
  await b.poll(`__bot.tanks().every((t) => !t.para)`, 'everyone landed (B view)', 30000);
  ok(`both tanks touched down (t=${tsec()}s)`);

  // ═══ CONTROL: kill Bob on the ground ═══
  let bDead = false;
  for (let shot = 0; shot < 8 && !bDead; shot++) {
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    const sol = await a.evalJs(`__bot.fireAt(${bt.x}, ${bt.y}, 0)`);
    info(`kill shot ${shot + 1}: ${JSON.stringify(sol)} (B at ${Math.round(bt.x)},${Math.round(bt.y)} hp=${bt.hp})`);
    for (let k = 0; k < 12 && !bDead; k++) { // ~3.6s watch for the death
      await sleep(300);
      bDead = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId)?.dead === true;
    }
  }
  if (!bDead) throw new Error('control kill failed - cannot even damage a LANDED tank');
  ok(`control: Bob died on the ground under fire (t=${tsec()}s)`);

  // ═══ Bob respawns → LIVE mid-chute probe: every blast that catches him
  //     must report d:0 - a tank under canopy is untouchable ═══
  await a.poll(`__bot.tanks().some((t) => t.id !== ${JSON.stringify(aMyId)} && !t.dead && t.para)`, 'Bob respawned (A view)', 15000);
  ok(`Bob respawned, parachuting (t=${tsec()}s)`);
  const fallRate0 = await a.evalJs(`__bot.PARA_FALL`);
  let liveBlock = null, liveHurt = null;
  for (let shot = 0; shot < 5 && !liveBlock && !liveHurt; shot++) {
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    if (!bt || bt.dead || !bt.para) { await sleep(250); continue; }
    if ((bt.y ?? 999) > 420) { await sleep(250); continue; } // too low - he could touch down mid-flight (inconclusive)
    const prevAt = await a.evalJs(`__bot.lastBlast()?.at ?? 0`);
    const sol = await a.evalJs(`__bot.fireAt(${bt.x}, ${bt.y}, ${fallRate0})`); // lead the falling chute
    info(`live chute shot ${shot + 1}: ${JSON.stringify(sol)} at falling B (${Math.round(bt.x)},${Math.round(bt.y)})`);
    for (let k = 0; k < 12 && !liveBlock && !liveHurt; k++) {
      await sleep(300);
      const rep = await a.evalJs(`__bot.lastBlast()`);
      if (!rep || (rep.at ?? 0) <= prevAt) continue; // still waiting for this shot's report
      const entry = (rep.dmg ?? []).find((d) => d.id === bt.id);
      const cur = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
      if (!entry) break; // missed him entirely - no verdict, fire again
      if (entry.d === 0 && !entry.dead) liveBlock = { hp: entry.hp };
      else if (cur?.para) liveHurt = { d: entry.d, hp: cur?.hp }; // damaged WHILE para - hard fail
      else break; // he touched down before impact - inconclusive, fire again
    }
  }
  if (liveHurt) fail(`a live parachute tank TOOK ${liveHurt.d} damage mid-chute - immunity broken`);
  else if (liveBlock) ok(`🪂🛡️ LIVE mid-chute shot BLOCKED: d=0, Bob still ${liveBlock.hp} hp`);
  else info('live chute probe inconclusive (never caught him mid-chute) - the frozen case below is the hard check');

  // ═══ frozen case: kill Bob again if he survived + landed, then freeze his
  //     client mid-descent (backgrounded tab - the classic "dead 5s, check
  //     your phone" scenario) ═══
  for (let k = 0; k < 30; k++) { // wait until Bob is dead or firmly on the ground
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    if (!bt || bt.dead || !bt.para) break;
    await sleep(300);
  }
  for (let shot = 0; shot < 8; shot++) { // if he's alive on the ground, finish him
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    if (!bt || bt.dead) break;
    if (bt.para) { await sleep(300); continue; }
    const sol = await a.evalJs(`__bot.fireAt(${bt.x}, ${bt.y}, 0)`);
    info(`re-kill shot ${shot + 1}: ${JSON.stringify(sol)} (B hp=${bt.hp})`);
    for (let k = 0; k < 12; k++) {
      await sleep(300);
      if ((await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId)?.dead) break;
    }
  }
  await a.poll(`__bot.tanks().some((t) => t.id !== ${JSON.stringify(aMyId)} && t.dead)`, 'Bob dead again', 20000);
  await a.poll(`__bot.tanks().some((t) => t.id !== ${JSON.stringify(aMyId)} && !t.dead && t.para)`, 'Bob parachuting again', 20000);
  const respawnAt = Date.now(); // 🪂 PARA_MAX_MS (9s) force-stows a stalled chute - the frozen assertions must beat that deadline
  await a.poll(`(__bot.tanks().find((t) => t.id !== ${JSON.stringify(aMyId)})?.y ?? -999) > 100`, 'Bob mid-descent again', 15000);
  ok(`Bob respawned + dropping in for the frozen case (t=${tsec()}s)`);
  await b.send('Debugger.pause'); // 🧊 Bob's JS frozen - rAF stops, tank-move stream stalls
  await sleep(700);
  ok(`Bob's client frozen mid-chute (simulates his tab in the background)`);

  // what does Alice see? (Bob's y must FREEZE near the last stream)
  const y1 = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId)?.y;
  await sleep(1200);
  const bt2 = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
  info(`A sees Bob: y ${Math.round(y1)} → ${Math.round(bt2.y)} over 1.2s (frozen=${Math.abs(bt2.y - y1) < 8})`);
  const froze = Math.abs(bt2.y - y1) < 8;
  if (!froze) fail(`Bob kept falling on Alice's screen after his stream stalled (y ${Math.round(y1)} → ${Math.round(bt2.y)}) - the ghost descends without its owner!`);
  else ok(`Bob's tank froze on Alice's screen where his stream stopped (y≈${Math.round(bt2.y)})`);

  // ═══ THE TEST: bombard the frozen, visibly-parachuting Bob. Shells pass
  //     THROUGH the canopy by design, so most shots detonate on dirt far
  //     beyond him - the hard invariants: his HP never moves, he never dies,
  //     he is never knocked, and ANY blast report that does include him
  //     (a blast within range) must report d:0. (The deterministic d:0
  //     server-rule proof lives in chaos-para-immune-test.mjs at socket level)
  const before = { hp: bt2.hp, x: bt2.x, y: bt2.y };
  let sawBlock = null, sawHurt = null;
  for (let shot = 0; shot < 3 && !sawHurt; shot++) {
    if (Date.now() - respawnAt > 7500) { info('chute deadline (PARA_MAX_MS) nearing - stopping frozen probes'); break; }
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    if (!bt || bt.dead) break;
    const prevAt = await a.evalJs(`__bot.lastBlast()?.at ?? 0`);
    const sol = await a.evalJs(`__bot.fireAt(${bt.x}, ${bt.y}, 0)`); // frozen - aim where he IS, no lead
    info(`frozen-chute shot ${shot + 1}: ${JSON.stringify(sol)} at frozen B (${Math.round(bt.x)},${Math.round(bt.y)} para=${bt.para})`);
    for (let k = 0; k < 12; k++) { // ~3.5s for shell flight + blast echo
      await sleep(300);
      const rep = await a.evalJs(`__bot.lastBlast()`);
      if (!rep || (rep.at ?? 0) <= prevAt) continue;
      const entry = (rep.dmg ?? []).find((d) => d.id === bt.id);
      if (entry) { if (entry.d > 0 || entry.dead) sawHurt = entry; else sawBlock = entry; }
      break; // report consumed - next shot
    }
  }
  await a.send('Page.captureScreenshot', { format: 'png' }).then((s) => writeFileSync('/tmp/para-A.png', Buffer.from(s.data, 'base64'))).catch(() => {});
  const afterB = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
  if (sawHurt) fail(`frozen parachute tank TOOK ${sawHurt.d} damage${sawHurt.dead ? ' and DIED' : ''} - chute immunity broken`);
  else if (afterB && (afterB.hp < before.hp || afterB.dead)) fail(`frozen chute lost HP under fire (${before.hp} → ${afterB.hp})`);
  else if (afterB && Math.hypot(afterB.x - before.x, afterB.y - before.y) > 6) fail('frozen chute was KNOCKED by a blast - blocked means no knockback either');
  else ok(`🪂🛡️ frozen mid-chute bombardment blocked everything: hp ${before.hp}, never knocked${sawBlock ? ', blast report said d:0' : ' (shells passed through - no in-range blast)'}`);

  // ═══ the window CLOSES on touchdown: resume Bob, let him land, and the
  //     very next ground shot must hurt - immunity ends with the chute ═══
  await b.send('Debugger.resume').catch(() => {});
  await a.poll(`__bot.tanks().some((t) => t.id !== ${JSON.stringify(aMyId)} && !t.dead && !t.para)`, 'Bob touched down after resume', 25000);
  ok('Bob touched down after resume - chute stowed');
  let landed = null;
  for (let shot = 0; shot < 6 && !landed; shot++) {
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    if (!bt || bt.dead || bt.para) break;
    const sol = await a.evalJs(`__bot.fireAt(${bt.x}, ${bt.y}, 0)`);
    info(`post-touchdown shot ${shot + 1}: ${JSON.stringify(sol)} (B hp=${bt.hp})`);
    for (let k = 0; k < 12 && !landed; k++) {
      await sleep(300);
      const cur = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
      if (cur && (cur.hp < bt.hp || cur.dead)) landed = { before: bt.hp, after: cur.hp, dead: cur.dead };
    }
  }
  if (!landed) fail('Bob took NO damage after touchdown - the immunity window never closed');
  else ok(`🪂→🎯 post-touchdown hit lands: ${landed.before} → ${landed.dead ? 'shot down!' : landed.after + ' hp'} - the window closed on landing`);

  await sleep(800);
  const bView2 = await b.evalJs(`__bot.tanks()`).catch(() => null);
  info(`B's own view after resume: ${JSON.stringify(bView2)}`);
  if (bView2) {
    const bSelf = bView2.find((t) => t.id !== aMyId);
    if (bSelf && (landed ? (bSelf.hp <= landed.after || bSelf.dead) : bSelf.hp === 100)) ok('Bob\'s own client agrees with Alice\'s');
    else fail(`Bob's own client DIVERGED (hp=${bSelf?.hp})`);
  }
} catch (e) {
  fail(e.message);
} finally {
  a.chrome.kill(); b.chrome.kill();
}
await sleep(200);
if (failed) { console.error('\n💥 parachute immunity test FAILED'); process.exit(1); }
console.log('\n🎉 parachute immunity test passed - untouchable under canopy, mortal on touchdown');
process.exit(0);
