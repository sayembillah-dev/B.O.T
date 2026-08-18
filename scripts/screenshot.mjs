// 📸 dev-only screenshot harness — drives headless Chrome over CDP.
// Usage: node scripts/screenshot.mjs <url> <outfile> [waitMs=9000]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , url, out, waitMs = '9000'] = process.argv;
if (!url || !out) { console.error('usage: node scripts/screenshot.mjs <url> <outfile> [waitMs]'); process.exit(2); }

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222;

// 1) launch headless chrome with a debug port (ignore if already running)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1600,900',
  '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

// 2) find the page target
let target = null;
for (let i = 0; i < 20 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* retry */ }
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
if (!target) { console.error('no CDP page target'); process.exit(1); }

// 3) drive it over the built-in WebSocket
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
    console.log('💥', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? m.params).slice(0, 400));
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    console.log(`🔸 ${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
};
await new Promise((r) => { ws.onopen = r; });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
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
ws.close();
chrome.kill();
process.exit(0);
