/**
 * ⚡ Chaos-mode protocol test — run against a server started with fast clocks:
 *   CHAOS_DURATION_MS=12000 CHAOS_COOLDOWN_MS=1500 CHAOS_WIND_MS=3000 node server.js
 *
 * Room 1 (last man standing): non-host can't set-mode → host sets chaos →
 * game-state carries mode/dur/endsAt → BOTH players tank-move at once (no
 * turn gate) → fire cooldown enforced per player → pass-turn/shot-done are
 * ignored → a kill ends the round with the survivor as winner, and the dead
 * tank can't fire.
 *
 * Room 2 (most HP at 0:00): damage both tanks unevenly, fire repeatedly with
 * no inventory (infinite shells), wind re-rolls on a timer, and when the
 * match clock expires the higher-HP tank wins.
 *
 * Usage: URL=http://localhost:3210 node scripts/chaos-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (msg) => console.log('✅ ' + msg);
const fail = (msg) => { console.error('❌ ' + msg); failed = true; };

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });
const join = (s, room, name) => new Promise((res) => s.emit('join-room', { roomId: room, name }, res));
const waitEvent = (s, ev, pred, label, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
    const h = (x) => { if (!pred || pred(x)) { clearTimeout(t); s.off(ev, h); res(x); } };
    s.on(ev, h);
  });

// ═══ Room 1 — last man standing ═══
const R1 = 'cz1' + Math.random().toString(36).slice(2, 7);
const a = await connect('A');
const b = await connect('B');
const aId = (await join(a, R1, 'Ana')).you.id;
const bId = (await join(b, R1, 'Bo')).you.id;
ok('room 1: both joined');

let lastRoom = null;
a.on('room-state', (st) => { lastRoom = st; });
b.emit('set-mode', 'chaos');
await sleep(400);
if (lastRoom?.mode === 'chaos') fail('non-host set-mode should be ignored');
else ok('non-host set-mode ignored');
a.emit('set-mode', 'chaos');
await sleep(400);
if (lastRoom?.mode !== 'chaos') fail(`host set-mode chaos not applied (mode=${lastRoom?.mode})`);
else ok('host set-mode chaos → broadcast');

const g1 = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('start timeout')), 30000);
  a.on('game-state', (g) => { if (g && g.phase === 'playing') { clearTimeout(t); res(g); } });
  a.emit('start-game');
});
if (g1.mode !== 'chaos') fail(`game-state mode is ${g1.mode}, expected chaos`);
if (g1.dur !== 12000) fail(`expected dur=12000 (env override), got ${g1.dur}`);
const skew = g1.endsAt - (Date.now() + 12000 + 8000); // dur + 8s gen/countdown grace
if (Math.abs(skew) > 2500) fail(`endsAt skew ${skew}ms too large`);
if (g1.turn.phase !== 'open') fail(`turn.phase should be open, got ${g1.turn.phase}`);
ok(`chaos game started — mode=${g1.mode}, dur=${g1.dur / 1000}s, ${g1.tanks.length} tanks, all live at once`);

// both players drive simultaneously — no turn gate on tank-move
const mvA = waitEvent(b, 'tank-move', (m) => m.id === aId, 'A move relayed');
const mvB = waitEvent(a, 'tank-move', (m) => m.id === bId, 'B move relayed');
a.emit('tank-move', { x: 500, y: 300, aim: -1, s: 30 });
b.emit('tank-move', { x: 700, y: 300, aim: -2, s: -30 });
await Promise.all([mvA, mvB]);
ok('both tanks move simultaneously — no turns');

// per-player reload: A fires (ok), A fires again instantly (rejected), B fires (ok)
let fireCount = 0;
const countFire = waitEvent(a, 'fire', null, 'first fire');
a.on('fire', () => { fireCount += 1; });
a.emit('fire', { a: -0.8, p: 0.5, kind: 'normal' });
await countFire;
a.emit('fire', { a: -0.8, p: 0.5, kind: 'normal' }); // should be rejected (cooldown)
await sleep(500);
if (fireCount !== 1) fail(`cooldown violated — ${fireCount} fire broadcasts for A`);
else ok('3s reload enforced (second shot swallowed)');
const bFire = waitEvent(a, 'fire', (m) => m.id === bId, 'B fire');
b.emit('fire', { a: -2.2, p: 0.6, kind: 'normal' });
await bFire;
if (fireCount !== 2) fail('B should fire freely while A reloads');
else ok('reload is per-player — B fires while A cools down');

// pass-turn / shot-done are meaningless in chaos
const numBefore = g1.turn.num;
a.emit('pass-turn');
a.emit('shot-done');
await sleep(500);
let latest = null;
b.on('game-state', (g) => { latest = g; });
a.emit('tank-move', { x: 501, y: 300 }); // nudge a broadcast
await sleep(400);
if (latest && (latest.turn.num !== numBefore || latest.turn.phase !== 'open')) {
  fail(`turn machinery moved in chaos (num=${latest.turn.num} phase=${latest.turn.phase})`);
} else ok('pass-turn and shot-done ignored in chaos');

// kill B → last man standing wins immediately (blast where B STREAMED to —
// the server tracks tank-move positions, not the original spawn)
const over1 = waitEvent(a, 'game-state', (g) => g.turn.phase === 'over', 'round over on kill');
a.emit('blast', { x: 700, y: 300 - 14, r: 58, scale: 6, big: false }); // 300 direct dmg
const gOver1 = await over1;
if (gOver1.winner !== aId) fail(`winner should be Ana (${aId}), got ${gOver1.winner}`);
else ok('last man standing wins instantly');
b.emit('fire', { a: -1, p: 0.5 }); // dead tank must not fire
await sleep(500);
if (fireCount !== 2) fail('dead tank fired!');
else ok('dead tanks cannot fire');
a.close(); b.close();

// ═══ Room 2 — most HP when the clock hits 0:00 ═══
const R2 = 'cz2' + Math.random().toString(36).slice(2, 7);
const c = await connect('C');
const d = await connect('D');
const cId = (await join(c, R2, 'Cy')).you.id;
const dId = (await join(d, R2, 'Di')).you.id;
c.emit('set-mode', 'chaos');
await sleep(300);
const g2 = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('start timeout (room 2)')), 30000);
  c.on('game-state', (g) => { if (g && g.phase === 'playing') { clearTimeout(t); res(g); } });
  c.emit('start-game');
});
ok('room 2: chaos started — clock running');

// uneven damage: C hits D hard (50), D clips C back (25) — anyone may blast
const dTank = g2.tanks.find((t) => t.id === dId);
const bl1 = waitEvent(c, 'blast', null, 'C blast');
c.emit('blast', { x: dTank.x, y: dTank.y - 14, r: 58, scale: 1, big: false });
const m1 = await bl1;
const dDmg = m1.dmg?.find((x) => x.id === dId);
if (!dDmg || dDmg.hp !== 50) fail(`D should be at 50 HP, got ${JSON.stringify(m1.dmg)}`);
else ok('blast accepted from any live player (D at 50 HP)');
const cTank = g2.tanks.find((t) => t.id === cId);
const bl2 = waitEvent(c, 'blast', null, 'D blast');
d.emit('blast', { x: cTank.x, y: cTank.y - 14, r: 58, scale: 0.5, big: false });
const m2 = await bl2;
const cDmg = m2.dmg?.find((x) => x.id === cId);
if (!cDmg || cDmg.hp !== 75) fail(`C should be at 75 HP, got ${JSON.stringify(m2.dmg)}`);
else ok('return blast accepted (C at 75 HP)');

// infinite shells: C fires 3× with reload gaps, zero inventory needed
let cFires = 0;
d.on('fire', (m) => { if (m.id === cId) cFires += 1; });
for (let i = 0; i < 3; i++) { c.emit('fire', { a: -0.7, p: 0.4 }); await sleep(1700); }
if (cFires !== 3) fail(`infinite ammo broken — only ${cFires}/3 shots broadcast`);
else ok('infinite shells — 3 shots, no inventory');

// wind re-rolls on a timer in chaos (CHAOS_WIND_MS=3000 in this test)
const winds = new Set([g2.wind]);
c.on('game-state', (g) => { if (typeof g.wind === 'number') winds.add(g.wind); });

// wait for the 12s clock (+8s grace) to expire → most HP wins (C 75 vs D 50)
const over2 = waitEvent(c, 'game-state', (g) => g.turn.phase === 'over', 'chaos timeout', 32000);
const gOver2 = await over2;
if (gOver2.winner !== cId) fail(`most-HP winner should be Cy (${cId}), got ${gOver2.winner}`);
else ok('0:00 — most HP wins (75 vs 50)');
if (winds.size < 2) fail(`wind never re-rolled (saw ${[...winds].join(',')})`);
else ok(`wind re-rolled on a timer (${winds.size} distinct values)`);
c.close(); d.close();

await sleep(200);
if (failed) { console.error('\n💥 chaos test failed'); process.exit(1); }
console.log('\n🎉 chaos mode passed — simultaneous movement, reload, infinite shells, both win conditions');
process.exit(0);
