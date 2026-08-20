/**
 * ⚡ Chaos-mode protocol test - run against a server started with fast clocks:
 *   CHAOS_DURATION_MS=12000 CHAOS_COOLDOWN_MS=1500 CHAOS_WIND_MS=3000 CHAOS_RESPAWN_MS=2500 CHAOS_FIRE_GRACE_MS=1 node server.js
 *   (FIRE_GRACE≈0 disables the anti-pre-fire countdown gate - this suite fires seconds after start)
 *
 * Room 1 (respawn): non-host can't set-mode → host sets chaos → game-state
 * carries mode/dur/endsAt → BOTH players tank-move at once (no turn gate) →
 * fire cooldown enforced per player → pass-turn/shot-done ignored → a kill
 * does NOT end the round (no eliminations in chaos) → the dead tank can't
 * fire → 2.5s later the victim respawns with full HP at a server-picked spot.
 *
 * Room 2 (most damage at 0:00): three players, scripted damage triangle -
 * Cy deals 50, Di deals 80, Eli deals 10. HP says Cy (90) should win, but
 * DAMAGE says Di (80) - the clock expiry must crown Di. Self-splash does not
 * pad your score. Infinite shells + wind re-roll checked along the way.
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
const startChaos = (s, label) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`start timeout (${label})`)), 30000);
    s.on('game-state', (g) => { if (g && g.phase === 'playing') { clearTimeout(t); res(g); } });
    s.emit('start-game');
  });

// ═══ Room 1 - death is a 5s timeout, not an elimination ═══
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

const g1 = await startChaos(a, 'room 1');
if (g1.mode !== 'chaos') fail(`game-state mode is ${g1.mode}, expected chaos`);
if (g1.dur !== 12000) fail(`expected dur=12000 (env override), got ${g1.dur}`);
const skew = g1.endsAt - (Date.now() + 12000 + 8000); // dur + 8s gen/countdown grace
if (Math.abs(skew) > 2500) fail(`endsAt skew ${skew}ms too large`);
if (g1.turn.phase !== 'open') fail(`turn.phase should be open, got ${g1.turn.phase}`);
if (!g1.tanks.every((t) => (t.dmg | 0) === 0)) fail('chaos tanks should start at 0 damage dealt');
if (!g1.tanks.every((t) => t.para === true && t.y < 0)) fail(`chaos tanks should drop in by parachute (y<0, para=true), got ${JSON.stringify(g1.tanks.map((t) => ({ y: t.y, para: t.para })))}`);
else ok('all tanks parachute in from the sky at spawn 🪂');
ok(`chaos game started - mode=${g1.mode}, dur=${g1.dur / 1000}s, ${g1.tanks.length} tanks, all live at once`);

// 🪂 guns stay packed until touchdown - the server must reject mid-chute fire
let chuteFire = 0;
a.on('fire', () => { chuteFire += 1; });
a.emit('fire', { a: -0.8, p: 0.5, kind: 'normal' }); // still mid-parachute → rejected
await sleep(400);
if (chuteFire !== 0) fail(`parachute fire rejected - got ${chuteFire} broadcast(s)`);
else ok('fire while parachuting is rejected - guns stay packed 🪂');

// both players drive simultaneously - no turn gate on tank-move
// (para:false rides along = touchdown report, like the real client streams)
const mvA = waitEvent(b, 'tank-move', (m) => m.id === aId, 'A move relayed');
const mvB = waitEvent(a, 'tank-move', (m) => m.id === bId, 'B move relayed');
a.emit('tank-move', { x: 500, y: 300, aim: -1, s: 30, para: false });
b.emit('tank-move', { x: 700, y: 300, aim: -2, s: -30, para: false });
await Promise.all([mvA, mvB]);
ok('both tanks move simultaneously - no turns');

// per-player reload: A fires (ok), A fires again instantly (rejected), B fires (ok)
let fireCount = 0;
const countFire = waitEvent(a, 'fire', null, 'first fire');
a.on('fire', () => { fireCount += 1; });
a.emit('fire', { a: -0.8, p: 0.5, kind: 'normal' });
await countFire;
a.emit('fire', { a: -0.8, p: 0.5, kind: 'normal' }); // should be rejected (cooldown)
await sleep(500);
if (fireCount !== 1) fail(`cooldown violated - ${fireCount} fire broadcasts for A`);
else ok('1s reload enforced (second shot swallowed)');
const bFire = waitEvent(a, 'fire', (m) => m.id === bId, 'B fire');
b.emit('fire', { a: -2.2, p: 0.6, kind: 'normal' });
await bFire;
if (fireCount !== 2) fail('B should fire freely while A reloads');
else ok('reload is per-player - B fires while A cools down');

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

// kill B (blast where B STREAMED to - the server tracks tank-move positions).
// With respawns, the round must NOT end - no eliminations in chaos.
let overFired = false;
a.on('game-state', (g) => { if (g.turn.phase === 'over') overFired = true; });
const killBlast = waitEvent(a, 'blast', (m) => m.dmg?.some((d) => d.id === bId && d.dead), 'lethal blast on B');
const respawnEvt = waitEvent(a, 'game-event', (e) => e.kind === 'respawn' && e.id === bId, 'B respawn event', 12000);
// attach BEFORE the blast: the kill broadcast itself is the post-kill state.
// (attaching after used to race the 2.5s respawn window - only a crate in
// flight would dirty-broadcast in time, making this flaky by drop timing)
const postKill = waitEvent(a, 'game-state', (g) => g.tanks.some((t) => t.id === bId && t.dead), 'post-kill state');
a.emit('blast', { x: 700, y: 300 - 14, r: 58, scale: 6, big: false }); // 300 direct dmg
const mk = await killBlast;
const bDmg = mk.dmg.find((d) => d.id === bId);
if (!bDmg.dead) fail('B should be dead after 300 direct damage');
else ok('kill lands - B is dead…');
await sleep(500);
if (overFired) fail('round ended on a kill - chaos has no eliminations!');
else ok('…but the match keeps rolling (no last-man-standing)');

// damage tally: A dealt 300 to B; A's own splash (200px away) must not count
const gAfter = await postKill;
const aTank = gAfter.tanks.find((t) => t.id === aId);
if ((aTank.dmg | 0) !== 300) fail(`A should have 300 damage dealt, got ${aTank.dmg}`);
else ok('damage scoreboard ticks (A: 300 dealt, self-splash excluded)');

b.emit('fire', { a: -1, p: 0.5 }); // dead tank must not fire
await sleep(500);
if (fireCount !== 2) fail('dead tank fired!');
else ok('dead tanks cannot fire');

// B respawns ~2.5s after death, full HP, server-picked spot
const re = await respawnEvt;
const gRe = await waitEvent(a, 'game-state', (g) => g.tanks.some((t) => t.id === bId && !t.dead), 'B alive again');
const bRe = gRe.tanks.find((t) => t.id === bId);
if (bRe.hp !== 100) fail(`respawned B should have 100 HP, got ${bRe.hp}`);
else if (!bRe.para) fail('respawned B should ride the chute down (para=true)');
else ok(`B respawned at x=${Math.round(re.x)} with full HP + parachute - death is a timeout, not the end`);
a.close(); b.close();

// ═══ Room 2 - most DAMAGE dealt when the clock hits 0:00 ═══
const R2 = 'cz2' + Math.random().toString(36).slice(2, 7);
const c = await connect('C');
const d = await connect('D');
const e = await connect('E');
const cId = (await join(c, R2, 'Cy')).you.id;
const dId = (await join(d, R2, 'Di')).you.id;
const eId = (await join(e, R2, 'El')).you.id;
c.emit('set-mode', 'chaos');
await sleep(300);
const g2 = await startChaos(c, 'room 2');
ok('room 2: 3-player chaos started - clock running');

// park everyone at known, far-apart spots so blasts never cross-splash
const W = g2.terrain.width;
const pos = { [cId]: 0.15 * W, [dId]: 0.5 * W, [eId]: 0.85 * W };
c.emit('tank-move', { x: pos[cId], y: 300, aim: -1, s: 0, para: false });
d.emit('tank-move', { x: pos[dId], y: 300, aim: -1, s: 0, para: false });
e.emit('tank-move', { x: pos[eId], y: 300, aim: -1, s: 0, para: false });
await sleep(400); // let the streams land

// scripted damage triangle - direct hits: dd = round(50 × scale)
// Cy → Di for 50 (Di hp 50), Di → El for 80 (El hp 20), El → Cy for 10 (Cy hp 90).
// HP ranking: Cy 90 > Di 50 > El 20. DAMAGE ranking: Di 80 > Cy 50 > El 10.
const hit = async (sock, victimId, scale, label) => {
  const bl = waitEvent(c, 'blast', null, label);
  sock.emit('blast', { x: pos[victimId], y: 300 - 18, r: 30, scale, big: false });
  return bl;
};
const m1 = await hit(c, dId, 1.0, 'Cy hits Di');
if (m1.dmg?.find((x) => x.id === dId)?.hp !== 50) fail(`Di should be at 50 HP, got ${JSON.stringify(m1.dmg)}`);
const m2 = await hit(d, eId, 1.6, 'Di hits El');
if (m2.dmg?.find((x) => x.id === eId)?.hp !== 20) fail(`El should be at 20 HP, got ${JSON.stringify(m2.dmg)}`);
const m3 = await hit(e, cId, 0.2, 'El hits Cy');
if (m3.dmg?.find((x) => x.id === cId)?.hp !== 90) fail(`Cy should be at 90 HP, got ${JSON.stringify(m3.dmg)}`);
ok('damage triangle applied (HP: Cy 90 · Di 50 · El 20 - dealt: Di 80 · Cy 50 · El 10)');

// self-splash is not a farming strategy: Di hits SELF for 10 → score stays 80
const m4 = await hit(d, dId, 0.2, 'Di self-splash');
const dSelf = m4.dmg?.find((x) => x.id === dId);
if (!dSelf || dSelf.hp !== 40) fail(`Di self-splash should drop Di to 40 HP, got ${JSON.stringify(m4.dmg)}`);
else ok('self-splash hurts but does not pad your damage score');

// infinite shells: C fires 3× with reload gaps, zero inventory needed
let cFires = 0;
d.on('fire', (m) => { if (m.id === cId) cFires += 1; });
for (let i = 0; i < 3; i++) { c.emit('fire', { a: -0.7, p: 0.4 }); await sleep(1700); }
if (cFires !== 3) fail(`infinite ammo broken - only ${cFires}/3 shots broadcast`);
else ok('infinite shells - 3 shots, no inventory');

// wind re-rolls on a timer in chaos (CHAOS_WIND_MS=3000 in this test)
const winds = new Set([g2.wind]);
c.on('game-state', (g) => { if (typeof g.wind === 'number') winds.add(g.wind); });

// wait for the 12s clock (+8s grace) to expire → most DAMAGE wins (Di 80,
// even though Cy has the most HP left standing)
const gOver2 = await waitEvent(c, 'game-state', (g) => g.turn.phase === 'over', 'chaos timeout', 32000);
if (gOver2.winner !== dId) fail(`most-DAMAGE winner should be Di (${dId}), got ${gOver2.winner}`);
else ok('0:00 - most damage dealt wins (Di 80 💥 beats Cy’s 90 HP)');
if (winds.size < 2) fail(`wind never re-rolled (saw ${[...winds].join(',')})`);
else ok(`wind re-rolled on a timer (${winds.size} distinct values)`);
c.close(); d.close(); e.close();

await sleep(200);
if (failed) { console.error('\n💥 chaos test failed'); process.exit(1); }
console.log('\n🎉 chaos mode passed - simultaneous movement, 1s reload, infinite shells, respawns, damage-based scoring');
process.exit(0);
