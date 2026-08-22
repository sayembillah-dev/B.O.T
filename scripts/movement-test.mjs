// 🎮 movement feel test - boots a prod server + headless Chrome, drives the
// tank right with synthetic keys (incl. auto-repeat), jumps mid-drive, samples
// window.__bot tank state at 10 Hz, and asserts smoothness + air control.
//   node scripts/movement-test.mjs [port=3102]
// Exits 0 with a PASS summary, 1 on any failed assertion.
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 3102);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP = 9777;
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const procs = [];
const killAll = () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } };
process.on('exit', killAll);

// ── 1. prod server (build must exist) ────────────────────────────────
const server = spawn('node', ['server.js'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(server);
server.stderr.on('data', (d) => console.log('[server]', String(d).slice(0, 200)));

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500));
  up = await fetch(BASE).then((r) => r.ok).catch(() => false);
}
if (!up) { console.log('FAIL: server never came up'); process.exit(1); }
console.log('server up on', BASE);

// ── 2. headless Chrome over CDP ──────────────────────────────────────
const profile = join(tmpdir(), `move-test-${PORT}`);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* first run */ }
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
procs.push(chrome);
await new Promise((r) => setTimeout(r, 2000));

const targets = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('[page-err]', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300));
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Page.enable'); await send('Runtime.enable');
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

await send('Page.navigate', { url: `${BASE}/room/movetest?solo=1&test=1` });

// ── 3. wait until the round is live (countdown done, turn open) ──────
let live = false;
for (let i = 0; i < 50 && !live; i++) {
  await new Promise((r) => setTimeout(r, 400));
  const v = await evalJs(`window.__bot ? JSON.stringify(window.__bot.turn()) : ''`);
  if (v) { const t = JSON.parse(v); if (t.phase === 'open' && t.countdown <= 0) live = true; }
}
if (!live) { console.log('FAIL: game never went live'); process.exit(1); }
console.log('game live - driving right 2.6s, jump, keep driving 2.6s');

// ── 4. scripted input + sampling inside the page ─────────────────────
await evalJs(`(() => {
  const down = (c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c }));
  const up = (c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c }));
  const B = window.__bot;
  const me = () => B.tanks().find((t) => t.id === B.myId());
  const out = { samples: [], jumpAt: null };
  const t0 = performance.now();
  down('KeyD');
  const rep = setInterval(() => down('KeyD'), 250);          // synthetic OS auto-repeat
  const iv = setInterval(() => {
    const t = me(); if (!t) return;
    out.samples.push({ ms: Math.round(performance.now() - t0), x: t.x, y: t.y, s: t.s });
  }, 100);
  setTimeout(() => { down('Space'); setTimeout(() => up('Space'), 80); out.jumpAt = 2600; }, 2600);
  setTimeout(() => { clearInterval(rep); clearInterval(iv); up('KeyD'); window.__moveTest = out; }, 5400);
})(); 1`);

await new Promise((r) => setTimeout(r, 6200));
const raw = await evalJs('JSON.stringify(window.__moveTest || null)');
if (!raw) { console.log('FAIL: no samples collected'); process.exit(1); }
const { samples, jumpAt } = JSON.parse(raw);

// final screenshot for the eyeball pass
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('scripts/_movement-shot.png', Buffer.from(shot.data, 'base64'));

// ── 5. assertions ────────────────────────────────────────────────────
const drive = samples.filter((s) => s.ms < jumpAt - 300);            // clean grounded driving
const air = samples.filter((s) => s.ms >= jumpAt - 100 && s.ms <= jumpAt + 1200);
const fails = [];
const say = (ok2, label, detail) => { console.log(`${ok2 ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`); if (!ok2) fails.push(label); };

const dist = drive.length ? drive[drive.length - 1].x - drive[0].x : 0;
say(dist > 40, 'drive makes forward progress', `${Math.round(dist)}px in ${drive.length / 10}s (terrain-dependent)`);

let backtracks = 0, stalls = 0, maxDy = 0, maxDx = 0;
for (let i = 1; i < drive.length; i++) {
  if (drive[i].x < drive[i - 1].x - 5) backtracks++;
  if (drive[i].x - drive[i - 1].x < 0.3) stalls++;
  maxDy = Math.max(maxDy, Math.abs(drive[i].y - drive[i - 1].y));
  maxDx = Math.max(maxDx, drive[i].x - drive[i - 1].x);
}
say(stalls <= Math.ceil(drive.length * 0.1), 'never stalls out while held (old surge/stop oscillation)', `${stalls}/${drive.length} stalled samples`);
const sMax = Math.max(...samples.map((s) => s.s));
say(sMax >= 170, 'reaches full 175 cruise when terrain opens up', `peak s = ${sMax}`);
say(backtracks === 0, 'no backward snaps while driving right', `${backtracks} backtracks`);
// big single-frame drops are legit ballistics when launching off a crest at 175px/s
// (the render-y ease + suspension absorb those visually) - what must NOT happen is
// repeated buzz: many large up/down steps = the old per-pixel stair-jitter
let bigSteps = 0;
for (let i = 1; i < drive.length; i++) if (Math.abs(drive[i].y - drive[i - 1].y) > 25) bigSteps++;
say(maxDy < 45, 'no insane vertical snaps', `max |dy|/100ms = ${Math.round(maxDy)}px`);
say(bigSteps <= 2, 'no repeated vertical buzz (crest launches are fine, jitter is not)', `${bigSteps} big steps`);
say(maxDx < 30, 'horizontal speed steady (no surging)', `max dx/100ms = ${Math.round(maxDx)}px`);

// jump: left the ground AND kept moving sideways while airborne
let minY = Infinity, airX0 = null, airX1 = null, groundY = null;
for (const s of samples) {
  if (s.ms < jumpAt) { groundY = s.y; continue; }
  if (s.ms > jumpAt + 1400) break;
  if (airX0 == null) airX0 = s.x;
  airX1 = s.x;
  minY = Math.min(minY, s.y);
}
const rose = groundY != null && minY < groundY - 25;                 // ~y-down: rose = smaller y
const airDrift = airX0 != null && airX1 != null ? airX1 - airX0 : 0;
say(rose, 'jump leaves the ground', `apex ${Math.round(groundY - minY)}px above ground`);
say(airDrift > 50, 'sideways drift survives the jump', `${Math.round(airDrift)}px airborne x-progress`);

// full sample dump for the eyeball
console.log('\nsamples (ms, x, y, s):');
for (const s of samples) console.log(` ${String(s.ms).padStart(5)}  x=${String(s.x).padStart(7)}  y=${String(s.y).padStart(7)}  s=${String(s.s).padStart(7)}${s.ms >= jumpAt && s.ms < jumpAt + 100 ? '  <-- JUMP' : ''}`);

console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL MOVEMENT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
