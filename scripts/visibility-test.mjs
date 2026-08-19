/**
 * Shared-intel check: players can see EACH OTHER's fuel - but NEVER aim power.
 *   1. 2P game starts; find the active player from game-state.
 *   2. Active client streams tank-move with fuel=42, p=0.77.
 *   3. The OTHER client must receive fuel + aim - and NO power (🕵️ secret).
 *   4. A late-joining spectator's game-state must carry fuel, never power.
 * Run the server first.  Usage: URL=http://localhost:3210 node scripts/visibility-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'vis' + Math.floor(Math.random() * 100000); // alnum only - ROOM_ID_RE
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(name + ' connect timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));

const a = await connect('Alice');
const ra = await join(a, 'Alice');
if (!ra?.ok) fail('Alice join: ' + ra?.error);
const b = await connect('Bob');
const rb = await join(b, 'Bob');
if (!rb?.ok) fail('Bob join: ' + rb?.error);
console.log('✅ both joined');

let state = null;
a.on('game-state', (g) => { if (g?.tanks?.length === 2) state = g; });
b.on('game-state', (g) => { if (g?.tanks?.length === 2) state = g; });

// Bob listens for Alice's (or his own) relayed stream
let got = null;
b.on('tank-move', (m) => { got = m; });

a.emit('start-game');
const t0 = Date.now();
while (!state && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
if (!state) fail('no game-state after start');
console.log('✅ game started');

const activeIdx = state.turn?.activeIdx ?? 0;
const activeId = state.tanks[activeIdx].id;
const activeSock = [a, b].find((s) => s.id === activeId);
const otherSock = activeSock === a ? b : a;
if (!activeSock) fail('active player socket not found');
console.log(`🎯 active player: ${state.tanks[activeIdx].name} - streaming fuel=42, p=0.77`);

activeSock.emit('tank-move', { x: state.tanks[activeIdx].x, y: 100, aim: -1.1, s: 0, fuel: 42, p: 0.77 });

const t1 = Date.now();
while (!got && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
if (!got) fail('no tank-move relay received');
if (got.id !== activeId) fail(`relay from wrong tank: ${got.id}`);
if (got.fuel !== 42) fail(`fuel not shared - got ${got.fuel}, expected 42`);
if (got.p !== undefined) fail(`power LEAKED in relay - got ${got.p}, expected it to stay secret`);
if (got.aim !== -1.1) fail(`aim not shared - got ${got.aim}, expected -1.1`);
console.log('✅ rival received live stream: fuel=42, aim=-1.1, power withheld');

// late joiner: fresh game-state snapshot must carry fuel + power as well
const c = await connect('Spectator');
const rc = await join(c, 'Spectator');
if (!rc?.ok) fail('Spectator join: ' + rc?.error);
const snap = await new Promise((res) => {
  const t = setTimeout(() => res(null), 5000);
  c.on('game-state', (g) => { if (g?.tanks?.length >= 2) { clearTimeout(t); res(g); } });
});
if (!snap) fail('spectator got no game-state');
const snapTank = snap.tanks.find((tk) => tk.id === activeId);
if (!snapTank) fail('active tank missing from snapshot');
if (snapTank.fuel !== 42) fail(`snapshot fuel ${snapTank.fuel} - expected 42`);
if (snapTank.power !== undefined) fail(`snapshot power LEAKED: ${snapTank.power} - power must never be serialized`);
console.log('✅ late joiner snapshot carries fuel=42, no power');

console.log('🎉 VISIBILITY OK - fuel is public, trajectory power stays secret');
process.exit(0);
