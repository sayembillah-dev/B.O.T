/**
 * 🚀 Fly power-up check (run the server with FORCE_DROP=fly):
 *   1. 2P classic game; crate drops (~10s in), falls, lands.
 *   2. Alice streams herself onto the crate -> crate-taken with type 'fly', by Alice.
 *   3. Next game-state carries flyUntil ~7s in the future for Alice's tank.
 *   4. The volatile tank-move relay carries the fly flag both ways (jet on/off).
 *
 * Run the server first:  set PORT=3210&& set FORCE_DROP=fly&& node server.js
 * Usage: URL=http://localhost:3210 node scripts/fly-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'fly' + Math.floor(Math.random() * 100000);
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(name + ' connect timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));

const a = await connect();
const ra = await join(a, 'Alice');
if (!ra?.ok) fail('Alice join: ' + ra?.error);
const b = await connect();
const rb = await join(b, 'Bob');
if (!rb?.ok) fail('Bob join: ' + rb?.error);
console.log('✅ both joined');

let gs = null, landed = null, taken = null;
const flyRelays = [];
b.on('game-state', (g) => { if (g?.tanks?.length === 2) gs = g; });
b.on('game-event', (e) => {
  if (e.kind === 'crate-land' && !landed) { landed = e; console.log(`🛬 crate landed at x=${Math.round(e.x)}`); }
  if (e.kind === 'crate-taken') taken = e;
});
b.on('tank-move', (m) => { if (m.id === a.id && typeof m.fly === 'boolean') flyRelays.push(m.fly); });

a.emit('start-game');

// wait for the first crate to land (drop ~10s in + a few seconds of fall)
const t0 = Date.now();
while (!landed && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 200));
if (!landed) fail('no crate landed within 40s');

// Alice drives (streams) onto the crate
const cx = Math.round(landed.x), cy = Math.round(landed.y);
const drive = setInterval(() => a.emit('tank-move', { x: cx, y: cy, s: 0 }), 100);
const t1 = Date.now();
while (!taken && Date.now() - t1 < 15000) await new Promise((r) => setTimeout(r, 150));
clearInterval(drive);
if (!taken) fail('crate never collected');
if (taken.type !== 'fly') fail(`expected a fly crate, got ${taken.type} (server started with FORCE_DROP=fly?)`);
if (taken.by !== a.id) fail('collected by the wrong tank');
console.log('✅ crate-taken: type=fly, by=Alice');

// the server stamped flyUntil ~7s out
const t2 = Date.now();
let left = 0;
while (Date.now() - t2 < 5000) {
  await new Promise((r) => setTimeout(r, 300));
  const me = gs?.tanks?.find((t) => t.id === a.id);
  if (me?.flyUntil) { left = (me.flyUntil - Date.now()) / 1000; break; }
}
if (!left) fail('game-state never carried flyUntil');
if (left <= 3 || left > 7.2) fail(`flyUntil out of range: ${left.toFixed(1)}s of flight left`);
console.log(`✅ flyUntil stamped - ${left.toFixed(1)}s of flight left`);

// the fly flag rides the volatile relay both ways
a.emit('tank-move', { x: cx, y: cy - 80, fly: true });
await new Promise((r) => setTimeout(r, 250));
a.emit('tank-move', { x: cx, y: cy - 80, fly: false });
await new Promise((r) => setTimeout(r, 600));
if (!flyRelays.includes(true)) fail('relay never carried fly:true');
if (!flyRelays.includes(false)) fail('relay never carried fly:false');
console.log('✅ fly flag relays both ways (jet on/off)');
console.log('🎉 fly power-up OK');
process.exit(0);
