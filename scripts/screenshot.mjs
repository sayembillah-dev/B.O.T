// 📸 dev-only screenshot harness — drives headless Chrome over CDP.
// Single page:  node scripts/screenshot.mjs <url> <outfile> [waitMs=9000] [click=x,y,afterMs]
// Multi-page:   node scripts/screenshot.mjs '<json>'
//   pages: [{ "url", "out", "wait"=9000, "evals": [{ "at": ms, "js": "…" }] }]
//   — all pages open in ONE Chrome (shared origin/session), navigate together,
//     run their scheduled JS evals, and each gets captured after `wait` ms.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , url, out, waitMs = '9000'] = process.argv;
if (!url) { console.error('usage: node scripts/screenshot.mjs <url> <outfile> [waitMs] | \'<json pages>\''); process.exit(2); }

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const PORT = 9222;

// 1) launch headless chrome with a debug port (ignore if already running)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1600,900',
  '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

/** attach a CDP WebSocket to one page target; returns a send() + console tap */
async function attach(target, tag) {
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
      console.log(`💥 [${tag}]`, JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? m.params).slice(0, 400));
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      console.log(`🔸 [${tag}] ${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  return { ws, send };
}

const listTargets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

if (url.startsWith('[')) {
  // ── multi-page mode: ONE Chrome instance per page (own port + profile), so
  //    every page is the foreground tab — background rAF throttling would
  //    otherwise freeze the game loop on all but one page ──
  const pages = JSON.parse(url);
  const t0 = Date.now();
  const instances = pages.map((pg, i) => ({ pg, port: PORT + i + 1 }));
  for (const inst of instances) {
    inst.chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${inst.port}`, `--user-data-dir=/tmp/bot-shot-${inst.port}`,
      '--window-size=1600,900', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  }
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.all(instances.map(async ({ pg, port }, i) => {
    const tag = pg.tag || `p${i}`;
    let target = null;
    for (let k = 0; k < 20 && !target; k++) {
      try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((t) => t.type === 'page'); } catch { /* retry */ }
      if (!target) await new Promise((r) => setTimeout(r, 300));
    }
    if (!target) { console.error(`no CDP page target [${tag}]`); return; }
    const { send } = await attach(target, tag);
    if (pg.delay) await new Promise((r) => setTimeout(r, pg.delay - (Date.now() - t0))); // stagger joins (room host = first)
    await send('Page.navigate', { url: pg.url });
    const runEval = async (ev, base) => {
      const delay = ev.at - (Date.now() - base);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await send('Runtime.evaluate', { expression: `(() => { ${ev.js} })()`, returnByValue: true });
      if (res?.exceptionDetails) console.log(`💥 [${tag}] eval failed:`, res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails).slice(0, 300));
      else if (ev.log) console.log(`ℹ️ [${tag}] eval →`, JSON.stringify(res?.result?.value));
    };
    // absolute-time evals (t0-based) — e.g. clicking Start in the lobby
    for (const ev of pg.preEvals ?? []) await runEval(ev, t0);
    let base = t0;
    if (pg.waitFor) { // poll until the page reports ready (e.g. terrain done) — then rebase
      const deadline = Date.now() + (pg.waitForTimeout ?? 90000);
      for (;;) {
        const r = await send('Runtime.evaluate', { expression: pg.waitFor, returnByValue: true });
        if (r?.result?.value) { console.log(`✅ [${tag}] ready after ${((Date.now() - t0) / 1000).toFixed(1)}s`); break; }
        if (Date.now() > deadline) { console.log(`⏳ [${tag}] waitFor timed out — shooting anyway`); break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      base = Date.now();
    }
    for (const ev of pg.evals ?? []) await runEval(ev, base);
    const lastAt = (pg.evals ?? []).reduce((m, ev) => Math.max(m, ev.at), 0);
    const shotAt = pg.shotAt ?? (lastAt + 2500);
    const remain = shotAt - (Date.now() - base);
    if (remain > 0) await new Promise((r) => setTimeout(r, remain));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(pg.out, Buffer.from(shot.data, 'base64'));
    console.log(`📸 [${tag}] ${pg.out}`);
  }));
  for (const inst of instances) inst.chrome.kill();
  process.exit(0);
}

// ── legacy single-page mode ──
if (!out) { console.error('usage: node scripts/screenshot.mjs <url> <outfile> [waitMs]'); process.exit(2); }
let target = null;
for (let i = 0; i < 20 && !target; i++) {
  try {
    target = (await listTargets()).find((t) => t.type === 'page');
  } catch { /* retry */ }
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
if (!target) { console.error('no CDP page target'); process.exit(1); }
const { send } = await attach(target, 'p0');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(waitMs))); // let terrain gen + first turn settle

// optional interaction: click=x,y,afterMs — aim at (x,y), click to fire, wait, then shoot
const clickArg = process.argv.find((a) => a.startsWith('click='));
if (clickArg) {
  const [cx, cy, afterMs = '1500'] = clickArg.slice(6).split(',');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: Number(cx), y: Number(cy), button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  await new Promise((r) => setTimeout(r, Number(afterMs)));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`📸 ${out}`);
chrome.kill();
process.exit(0);
