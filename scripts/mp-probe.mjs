/**
 * 🌐 Multiplayer game-protocol probe — exercises the authoritative flow:
 * join ×2 → start → (tanks, turn, wind present) → tank-move relay →
 * fire → blast with server-computed damage → shot-done → settle → turn
 * rotates → pass-turn → turn rotates back → regen-terrain → end-game.
 * Run the server first.  Usage: node scripts/mp-probe.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'probe' + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (msg) => console.log('✅ ' + msg);
const fail = (msg) => { console.error('❌ ' + msg); failed = true; };

const connect = (name) => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'] });
  const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
  s.on('connect', () => { clearTimeout(t); res(s); });
  s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
});
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));
const nextGameState = (s, pred) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('game-state timeout')), 20000);
  const h = (gs) => { if (gs && pred(gs)) { clearTimeout(t); s.off('game-state', h); res(gs); } };
  s.on('game-state', h);
});

const a = await connect('A');
const b = await connect('B');
await join(a, 'Ana');
await join(b, 'Bo');
ok('both joined room ' + ROOM);

// start (2 players — no dev flag needed)
let aGs = null, bGs = null;
const aP = nextGameState(a, (g) => g.phase === 'playing').then((g) => (aGs = g));
const bP = nextGameState(b, (g) => g.phase === 'playing').then((g) => (bGs = g));
a.emit('start-game');
await Promise.all([aP, bP]);
ok(`game started — ${aGs.tanks.length} tanks, turn ${aGs.turn.num} phase=${aGs.turn.phase}, wind=${aGs.wind}`);
if (aGs.tanks.length !== 2) fail('expected 2 tanks');
if (typeof aGs.wind !== 'number') fail('wind missing');
if (JSON.stringify(aGs.tanks.map(t => t.x)) !== JSON.stringify(bGs.tanks.map(t => t.x))) fail('spawn positions differ between clients');
else ok('both clients see identical server spawns');

const activeSock = aGs.tanks[aGs.turn.activeIdx].id === aGs.tanks[0].id && aGs.players[0].id === aGs.tanks[0].id ? null : null;
// figure out which socket owns the active tank
const activeId = aGs.tanks[aGs.turn.activeIdx].id;
// whoAmI: check join replies? simpler: each socket emits tank-move and sees if accepted via relay
// deterministic: ask both — the one whose id matches is active. We know ids from gs.players order == join order.
const aId = (await new Promise((res) => a.emit('join-room', { roomId: ROOM, name: 'Ana' }, res))).you.id;
const bId = (await new Promise((res) => b.emit('join-room', { roomId: ROOM, name: 'Bo' }, res))).you.id;
const shooter = activeId === aId ? a : b;
const watcher = activeId === aId ? b : a;
const shooterId = activeId;
ok(`active player is ${activeId === aId ? 'Ana' : 'Bo'}`);

// tank-move relay
const moveP = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('tank-move not relayed')), 5000);
  watcher.on('tank-move', (m) => { clearTimeout(t); res(m); });
});
shooter.emit('tank-move', { x: 500, y: 300, aim: -1.1, s: 42 });
const mv = await moveP;
if (mv.id !== shooterId || Math.abs(mv.x - 500) > 0.01) fail('tank-move payload wrong: ' + JSON.stringify(mv));
else ok('tank-move relayed to the other player');

// fire → both get the shot
const fireP = Promise.all([
  new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('fire A timeout')), 5000); a.on('fire', (m) => { clearTimeout(t); res(m); }); }),
  new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('fire B timeout')), 5000); b.on('fire', (m) => { clearTimeout(t); res(m); }); }),
]);
shooter.emit('fire', { a: -0.8, p: 0.5, kind: 'normal' });
const [fa] = await fireP;
if (fa.id !== shooterId) fail('fire event has wrong shooter');
else ok(`fire broadcast (kind=${fa.kind}, dmgScale=${fa.dmgScale})`);

// blast → server applies damage + relays with authoritative numbers
const foeId = activeId === aId ? bId : aId;
const foeTank = aGs.tanks.find((t) => t.id === foeId);
const blastP = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('blast timeout')), 5000); watcher.on('blast', (m) => { clearTimeout(t); res(m); }); });
shooter.emit('blast', { x: foeTank.x, y: foeTank.y - 14, r: 58, scale: 1, big: false });
const bl = await blastP;
const hit = bl.dmg?.find((d) => d.id === foeId);
if (!hit) fail('blast did not damage the foe: ' + JSON.stringify(bl.dmg));
else ok(`blast applied — foe took ${hit.d} dmg (hp ${hit.hp}, direct=${hit.direct})`);

// shot-done → settle → turn rotates to the other player
const rotP = nextGameState(a, (g) => g.turn.phase === 'open' && g.turn.num === 2);
shooter.emit('shot-done');
const g2 = await rotP;
const newActive = g2.tanks[g2.turn.activeIdx].id;
if (newActive === shooterId) fail('turn did not rotate');
else ok(`turn rotated to ${newActive === aId ? 'Ana' : 'Bo'} (turn ${g2.turn.num}, wind ${g2.wind})`);

// pass-turn → back to the first player
const rot2P = nextGameState(a, (g) => g.turn.phase === 'open' && g.turn.num === 3);
(newActive === aId ? a : b).emit('pass-turn');
const g3 = await rot2P;
if (g3.tanks[g3.turn.activeIdx].id !== shooterId) fail('pass-turn did not rotate back');
else ok('pass-turn rotated back (turn 3)');

// regen-terrain → fresh seed, tanks reset
const regenP = nextGameState(a, (g) => g.terrain.seed !== aGs.terrain.seed && g.turn.num === 1);
a.emit('regen-terrain');
const g4 = await regenP;
ok('rematch: new seed ' + g4.terrain.seed + ', tanks reset (hp ' + g4.tanks[0].hp + ')');

a.emit('end-game');
await sleep(300);
a.close(); b.close();
await sleep(200);
if (failed) { console.error('\n💥 probe failed'); process.exit(1); }
console.log('\n🎉 multiplayer probe passed — full protocol works');
process.exit(0);
