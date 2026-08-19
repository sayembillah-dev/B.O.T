/**
 * 🌀 Teleport power-up flow (online, server-authoritative):
 *   1. Teleport with NO pending charge → rejected (silence).
 *   2. FORCE_DROP=teleport: active tank streams onto the landed crate →
 *      crate-taken(type=teleport) + game-state tele=true.
 *   3. Active emits teleport{x} → 'teleport' game-event, tank moved, tele=false.
 * Run server with: FORCE_DROP=teleport PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 node scripts/teleport-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'tele' + Math.floor(Math.random() * 100000); // alnum only - ROOM_ID_RE
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(name + ' connect timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));

const socks = [];
const a = await connect('Alice'); socks.push(a);
if (!(await join(a, 'Alice'))?.ok) fail('Alice join');
const b = await connect('Bob'); socks.push(b);
if (!(await join(b, 'Bob'))?.ok) fail('Bob join');
console.log('✅ both joined');

let state = null;
let events = [];
for (const s of socks) {
  s.on('game-state', (g) => { if (g?.tanks?.length === 2) state = g; });
  s.on('game-event', (e) => events.push(e));
}
a.emit('start-game');
for (let i = 0; i < 80 && !state; i++) await sleep(100);
if (!state) fail('no game-state');
console.log('✅ game started');

const activeOf = () => state.tanks[state.turn.activeIdx];
const sockOf = (id) => socks.find((s) => s.id === id);

// 1️⃣ teleport with no pending charge → must be rejected (no event, no move)
const me0 = activeOf();
const x0 = me0.x;
sockOf(me0.id).emit('teleport', { x: x0 > 960 ? 300 : 1600 });
await sleep(1500);
if (events.some((e) => e.kind === 'teleport')) fail('teleport accepted without a pending charge!');
if (state.tanks.find((t) => t.id === me0.id).x !== x0) fail('tank moved without a charge!');
console.log('✅ no-charge teleport correctly rejected');

// 2️⃣ wait for the (forced) teleport crate to land, drive the active tank onto it
let crate = null;
for (let i = 0; i < 600 && !crate; i++) { // up to 90s (first drop ~10s + fall)
  await sleep(150);
  crate = state.crates?.find((c) => c.landed && !c.taken) ?? null;
}
if (!crate) fail('no landed crate within 90s');
// 🎁 mystery crates: the type stays secret until pickup - the crate-taken
//    assert below is what verifies the server runs FORCE_DROP=teleport
console.log(`📦 mystery crate landed at x=${Math.round(crate.x)} - driving the active tank onto it`);

let taken = null;
for (let i = 0; i < 100 && !taken; i++) {
  const me = activeOf(); // track turn rotation - whoever is active goes for it
  sockOf(me.id).emit('tank-move', { x: crate.x, y: crate.y - 2, aim: -1, s: 0, fuel: 50, p: 0.5 });
  await sleep(120);
  taken = events.find((e) => e.kind === 'crate-taken') ?? null;
}
if (!taken) fail('crate never picked up');
if (taken.type !== 'teleport') fail(`picked up ${taken.type}, expected teleport`);
await sleep(400); // let the broadcast game-state arrive
const charged = state.tanks.find((t) => t.id === taken.by);
if (!charged?.tele) fail('server did not set tele=true after pickup');
console.log(`✅ ${charged.name} absorbed the teleport - tele=true`);

// 3️⃣ spend it: land back on own spawn (guaranteed dry)
const targetX = Math.max(60, Math.min(state.terrain.width - 60, Math.round(charged.x > 960 ? 300 : state.terrain.width - 300)));
events = [];
sockOf(charged.id).emit('teleport', { x: targetX });
let tele = null;
for (let i = 0; i < 40 && !tele; i++) { await sleep(100); tele = events.find((e) => e.kind === 'teleport') ?? null; }
if (!tele) fail('no teleport event after spending the charge');
if (tele.id !== charged.id) fail('wrong tank teleported');
if (Math.abs(tele.x - targetX) > 2) fail(`landed at ${tele.x}, expected ${targetX}`);
await sleep(400);
const after = state.tanks.find((t) => t.id === charged.id);
if (after.tele) fail('tele not cleared after use');
if (Math.abs(after.x - targetX) > 2) fail(`game-state x=${after.x}, expected ${targetX}`);
console.log(`🎉 TELEPORT OK - ${charged.name} jumped to x=${tele.x}, charge consumed`);
process.exit(0);
