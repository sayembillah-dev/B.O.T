/**
 * 🪂🔬 Chaos parachute JITTER test - two real headless-Chrome clients.
 *
 * Bob drops in by parachute holding D (steering right at full glide).
 * rAF samplers on BOTH clients record Bob's tank every frame:
 *
 *   A's view (remote, 12Hz stream):  y must descend smoothly (dead-reckoned),
 *                                    no staircase from snapshot-chasing.
 *   B's view (owner):                y-fall constant; x-glide ACCELERATES
 *                                    smoothly (no 0→170px/s snap); the chute
 *                                    SWAY oscillation stays continuous while
 *                                    steering (was: sway phase was coupled to
 *                                    t.x → ±10px/frame jitter at full glide).
 *
 * Metrics printed + asserted. Run the server first (LONG match clock):
 *   CHAOS_DURATION_MS=120000 CHAOS_RESPAWN_MS=2500 CHAOS_FIRE_GRACE_MS=1 PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 node scripts/chaos-para-jitter-test.mjs
 */
import { spawn } from 'node:child_process';

const BASE = process.env.URL || 'http://localhost:3210';
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOM = 'jitter' + Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('✅ ' + m);
const fail = (m) => { console.error('❌ ' + m); failed = true; };
const info = (m) => console.log('ℹ️  ' + m);

async function launch(port, tag) {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/bot-jitter-${port}`,
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

// ── in-page rAF sampler: waits for a FRESH drop-in (para && y < -20), then
//    records {t,x,y,sway,s} every rendered frame until touchdown. Bob's copy
//    also steers: holds D from the top of the drop, releases at +1.7s. ──
const SAMPLER = (idExpr, steer) => `new Promise((resolve) => {
  const out = [];
  let started = false, t0 = 0;
  const tick = () => {
    const tk = __bot.tanks().find((t) => t.id === ${idExpr});
    if (!started && tk && tk.para && tk.y < -20) { // 🪂 fresh drop-in from the sky
      started = true; t0 = performance.now();
      ${steer ? `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' })), 1700);` : ''}
    }
    if (started && tk) out.push({ t: performance.now() - t0, x: tk.x, y: tk.y, sway: tk.sway, s: tk.s, para: tk.para });
    if (started && tk && !tk.para) return resolve(out); // touchdown
    if (performance.now() - t0 > 45000) return resolve(out); // safety
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

/** per-frame step sizes from a sampled track */
const deltas = (tr, key) => tr.slice(1).map((p, i) => (p[key] - tr[i][key]) / Math.max(1, p.t - tr[i].t) * 16.7); // px per 60fps-frame
/** linear fit y≈a+bt → residuals: THE smoothness metric, immune to rAF
    sampler phase (two rAF callbacks can swap order within one vsync, which
    fakes a "big step" in naive per-frame deltas - residuals don't care). */
const linfit = (tr, key) => {
  const n = tr.length;
  const mt = tr.reduce((a, p) => a + p.t, 0) / n, my = tr.reduce((a, p) => a + p[key], 0) / n;
  let num = 0, den = 0;
  for (const p of tr) { num += (p.t - mt) * (p[key] - my); den += (p.t - mt) ** 2; }
  const b = num / den, a0 = my - b * mt;
  const res = tr.map((p) => p[key] - (a0 + b * p.t));
  const sd = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / n);
  return { rate: b, sd, max: Math.max(...res.map(Math.abs)) };
};
/** residual from a LOCAL LINEAR FIT over ±4 frames (position vs real time) =
    true high-frequency jitter. (A moving average in frame-index space is biased
    by irregular rAF cadence; a global linear fit flags smooth accel curvature.
    Smooth motion is locally linear even under erratic frame timing.) */
const hires = (tr, key) => {
  const res = new Array(tr.length).fill(0);
  for (let i = 0; i < tr.length; i++) {
    const lo = Math.max(0, i - 4), hi = Math.min(tr.length - 1, i + 4);
    const w = tr.slice(lo, hi + 1);
    if (w.length < 3) continue;
    const n = w.length;
    const mt = w.reduce((a, p) => a + p.t, 0) / n, my = w.reduce((a, p) => a + p[key], 0) / n;
    let num = 0, den = 0;
    for (const p of w) { num += (p.t - mt) * (p[key] - my); den += (p.t - mt) ** 2; }
    const b = den > 0 ? num / den : 0, a0 = my - b * mt;
    res[i] = tr[i][key] - (a0 + b * tr[i].t);
  }
  const sd = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / res.length);
  return { sd, max: Math.max(...res.map(Math.abs)) };
};
const stats = (ds) => {
  const n = ds.length;
  const mean = ds.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(ds.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const sorted = [...ds].map(Math.abs).sort((a, b) => a - b);
  return { n, mean, sd, p95: sorted[Math.floor(n * 0.95)], max: sorted[n - 1] };
};
const f = (v, d = 2) => (+v).toFixed(d);

// warm the dev-server route compile - a cold compile stalls first navigation
await fetch(`${BASE}/room/warmup`).catch(() => { /* prod or already warm */ });

const a = await launch(9351, 'A');
const b = await launch(9352, 'B');
try {
  await a.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Alice&mode=chaos&test=1` });
  await sleep(1200);
  await b.send('Page.navigate', { url: `${BASE}/room/${ROOM}?name=Bob&mode=chaos&test=1` });
  info(`room ${ROOM}`);

  await a.poll(`!![...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start') && !x.disabled)`, 'start button', 30000);
  for (let k = 0; k < 5; k++) {
    try { await a.evalJs(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start'))?.click()`, 8000); } catch { /* retry */ }
    if (await a.evalJs(`!!window.__bot`, 8000).catch(() => false)) break;
    await sleep(1000);
  }
  await a.poll(`window.__bot && __bot.tanks().length === 2 && __bot.turn().phase === 'open'`, 'A in-game', 60000);
  await b.poll(`window.__bot && __bot.tanks().length === 2`, 'B in-game', 60000);
  const aMyId = await a.evalJs(`__bot.myId()`);
  const bId = await b.evalJs(`__bot.myId()`);
  ok(`both in chaos, Bob = ${bId}`);

  const dumpWorst = (tr, key, label) => { // 🔬 show the 3 biggest steps with neighbors
    const ds = tr.slice(1).map((p, i) => ({ i: i + 1, d: (p[key] - tr[i][key]) / Math.max(1, p.t - tr[i].t) * 16.7 }));
    ds.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    console.log(`🔬 worst ${label} steps:`);
    for (const w of ds.slice(0, 3)) {
      console.log('   ' + tr.slice(Math.max(0, w.i - 2), w.i + 2).map((p) =>
        `{t:${f(p.t, 0)} ${key}:${f(p[key], 1)} sway:${f(p.sway, 1)} s:${f(p.s, 0)} para:${p.para ? 1 : 0}}`).join(' '));
    }
  };

  // wait for both landed from the initial drop-in (so the kill is clean)
  await a.poll(`__bot.tanks().every((t) => !t.para) && __bot.turn().countdown <= 0`, 'everyone landed (A view)', 30000);
  await b.poll(`__bot.tanks().every((t) => !t.para)`, 'everyone landed (B view)', 30000);

  // install the gated samplers BEFORE the kill - they auto-start the moment
  // Bob's respawn chute appears at the top of the sky
  const bIdQ = JSON.stringify(bId);
  const sampleA = a.evalJs(SAMPLER(bIdQ, false), 60000);
  const sampleB = b.evalJs(SAMPLER(bIdQ, true), 60000);
  info('samplers armed - killing Bob to capture his respawn descent…');

  // ═══ kill Bob on the ground → he respawns at y=-60, full descent ═══
  let bDead = false;
  for (let shot = 0; shot < 8 && !bDead; shot++) {
    const bt = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId);
    if (!bt || bt.dead) break;
    if (bt.para) { await sleep(300); continue; }
    const sol = await a.evalJs(`__bot.fireAt(${bt.x}, ${bt.y}, 0)`);
    info(`kill shot ${shot + 1}: ${JSON.stringify(sol)} (B at ${Math.round(bt.x)},${Math.round(bt.y)} hp=${bt.hp})`);
    for (let k = 0; k < 12 && !bDead; k++) {
      await sleep(300);
      bDead = (await a.evalJs(`__bot.tanks()`)).find((t) => t.id !== aMyId)?.dead === true;
    }
  }
  if (!bDead) throw new Error('kill failed - cannot capture a respawn descent');

  const [trackA, trackB] = await Promise.all([sampleA, sampleB]);
  if (trackA.length < 40 || trackB.length < 40) throw new Error(`sampler short: A=${trackA.length} B=${trackB.length} frames`);

  // only the airborne, steering portion
  const airA = trackA.filter((p) => p.para);
  const airB = trackB.filter((p) => p.para);
  info(`frames: A(remote)=${trackA.length} (${airA.length} para)  B(owner)=${trackB.length} (${airB.length} para)`);

  // ── 1) REMOTE FALL SMOOTHNESS (A watches Bob fall 230px/s via 12Hz stream) ──
  //    residual from the linear fit: a staircase shows as sawtooth residuals
  const midA = airA.slice(8, -8); // skip spawn + touchdown transients
  const fitA = linfit(midA, 'y');
  info(`A remote fall: rate=${f(fitA.rate * 1000, 0)}px/s residual sd=${f(fitA.sd)}px max=${f(fitA.max)}px  (staircase = sawtooth residual)`);
  if (fitA.sd < 2 && fitA.max < 7) ok('remote fall is smooth - no 12Hz staircase');
  else { dumpWorst(midA, 'y', 'A-y'); fail(`remote fall STAIRCASES: residual sd=${f(fitA.sd)}px max=${f(fitA.max)}px`); }

  // ── 2) OWNER FALL SMOOTHNESS ──
  const midB = airB.slice(8, -8);
  const fitB = linfit(midB, 'y');
  info(`B owner fall:  rate=${f(fitB.rate * 1000, 0)}px/s residual sd=${f(fitB.sd)}px max=${f(fitB.max)}px`);
  if (fitB.sd < 1.2 && fitB.max < 4) ok('owner fall is smooth');
  else { dumpWorst(midB, 'y', 'B-y'); fail(`owner fall jitters: residual sd=${f(fitB.sd)}px max=${f(fitB.max)}px`); }

  // ── 3) GLIDE ACCEL: no 0→170px/s snap on the owner ──
  const glideB = deltas(airB, 'x');
  const t90 = airB.findIndex((p) => p.s >= 153); // 90% of PARA_DRIFT=170
  const t90ms = t90 > 0 ? airB[t90].t - airB[0].t : -1;
  info(`B glide accel: first steps ${glideB.slice(0, 6).map((v) => f(v, 1)).join(' ')} …  90% speed after ${f(t90ms, 0)}ms`);
  if (glideB[0] < 1.5 && t90ms > 60) ok('glide eases in - no instant 0→max snap');
  else fail(`glide SNAPS: first step=${f(glideB[0])}px, 90% speed in ${f(t90ms, 0)}ms`);

  // ── 4) SWAY CONTINUITY WHILE STEERING (the phase-coupled jitter bug) ──
  //    old code: sway phase included t.x → at 170px/s the sine phase raced at
  //    170 rad/s → |swayΔ| up to ~10px/frame. Fixed: stable phase → ≤~0.6px.
  const full = airB.filter((p) => p.s > 150); // at full glide
  const swayD = deltas(full, 'sway').map(Math.abs);
  const swayMax = Math.max(...swayD);
  const swayP95 = [...swayD].sort((x, y) => x - y)[Math.floor(swayD.length * 0.95)];
  info(`B sway at full glide: |Δ| p95=${f(swayP95)}px max=${f(swayMax)}px/frame  (old bug: up to ~10)`);
  if (swayMax < 1.5) ok('chute sway stays continuous while steering - phase decoupled from x');
  else { dumpWorst(full, 'sway', 'B-sway'); fail(`chute sway JITTERS while steering: max |Δ|=${f(swayMax)}px/frame`); }

  // ── 5) REMOTE RENDERED-X SMOOTHNESS at full glide (x + sway as drawn) ──
  //    window derived from BOB's own track: full speed (s>150) until release;
  //    metric = high-frequency residual (smooth accel/decel ≠ jitter)
  const tFull = (airB.find((p) => p.s >= 150)?.t ?? 0) + 120;
  const tEnd = Math.min(1700, airB[airB.length - 1]?.t ?? 0) - 120;
  const glideWin = airA.filter((p) => p.t > tFull && p.t < tEnd).map((p) => ({ ...p, rx: p.x + p.sway }));
  if (glideWin.length > 15) {
    const hf = hires(glideWin, 'rx');
    const rate = linfit(glideWin, 'rx').rate * 1000;
    info(`A remote glide: rate=${f(rate, 0)}px/s high-freq residual sd=${f(hf.sd)}px max=${f(hf.max)}px  (${glideWin.length} frames @ full glide)`);
    if (hf.sd < 1.5 && hf.max < 4) ok('remote glide is smooth - dead reckoning works');
    else { dumpWorst(glideWin, 'x', 'A-x'); fail(`remote glide jitters: high-freq sd=${f(hf.sd)}px max=${f(hf.max)}px`); }
  } else info('(glide window too short - skipped)');

  // ── 6) decel on the timed key release also eases (no instant stop) ──
  const rel = airB.filter((p) => p.t > 1650 && p.t < 2600);
  const sD = rel.slice(1).map((p, i) => p.s - rel[i].s);
  const minDrop = sD.length ? Math.min(...sD) : 0;
  info(`B decel after keyup: sharpest Δs = ${f(minDrop, 1)}px/s in one frame (instant stop ≈ -170; eased ≈ -25)`);
  if (sD.length && minDrop > -60) ok('glide eases out on key release');
  else if (!sD.length) info('(release transient not captured - skipped)');
  else fail(`glide STOPS instantly on keyup: Δs=${f(minDrop, 1)}`);

  ok('🪂 jitter metrics complete');
} finally {
  a.chrome.kill(); b.chrome.kill();
}
process.exit(failed ? 1 : 0);
