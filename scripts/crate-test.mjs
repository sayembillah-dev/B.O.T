/**
 * Supply-drop fairness + TTL check:
 *   1. 2P game starts; first crate drops ~10s in.
 *   2. Drop x should be fair — far from BOTH tanks (max-min placement).
 *   3. After landing, the crate must vanish ~60s later (crate-expire event).
 * Run the server first.  Usage: URL=http://localhost:3210 node scripts/crate-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'crate' + Math.floor(Math.random() * 100000);
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

let tanks = null;
let dropX = null;
let landedAt = null;
b.on('game-state', (g) => { if (g?.tanks?.length === 2) tanks = g.tanks; });
b.on('game-event', (e) => {
  if (e.kind === 'drop') { dropX = e.x; console.log(`📦 drop at x=${Math.round(e.x)}`); }
  if (e.kind === 'crate-land' && !landedAt) { landedAt = Date.now(); console.log('🛬 crate landed'); }
  if (e.kind === 'crate-expire') {
    const stayed = ((Date.now() - landedAt) / 1000).toFixed(1);
    console.log(`⏳ crate expired after staying ${stayed}s on the ground`);
    if (!landedAt) fail('expire before land?!');
    if (!e.type) fail('🎁 expire did not reveal the hidden crate contents (no type)');
    console.log(`🎁 revealed on expiry: it was a ${e.type} crate`);
    const secs = (Date.now() - landedAt) / 1000;
    if (secs < 55 || secs > 66) fail(`crate lifetime ${secs}s — expected ~60s`);
    console.log('🎉 crate TTL OK (~60s)');
    process.exit(0);
  }
});
a.emit('start-game');
await new Promise((r) => setTimeout(r, 3000));
if (!tanks) fail('no game-state');

// wait for the first drop
const t0 = Date.now();
while (dropX == null && Date.now() - t0 < 50000) await new Promise((r) => setTimeout(r, 250));
if (dropX == null) fail('no drop within 50s');
const d0 = Math.abs(tanks[0].x - dropX);
const d1 = Math.abs(tanks[1].x - dropX);
console.log(`✅ drop distances: ${Math.round(d0)}px / ${Math.round(d1)}px from the two tanks`);
if (Math.min(d0, d1) < 150) fail('drop landed on a player — unfair');
console.log('✅ drop is fair (far from everyone); waiting up to 75s for expiry…');
setTimeout(() => fail('crate never expired'), 80000);
