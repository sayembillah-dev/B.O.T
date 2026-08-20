/**
 * 💀 Kills scoring test (Part 3) - socket-level, deterministic:
 *   match 1: a kill credits the shooter and nobody else; a self-kill credits
 *            no one (never negative); at 0:00 the TOP-KILLS player wins even
 *            when another player dealt more damage
 *   match 2: equal kills → the damage tie-break decides
 *   match 3: dead level on kills AND damage → draw
 *
 * Run the server first (short match clock keeps it quick):
 *   CHAOS_DURATION_MS=12000 CHAOS_RESPAWN_MS=2500 CHAOS_FIRE_GRACE_MS=1 PARA_MAX_MS=4000 PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 node scripts/kills-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3210';
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
const ok = (msg) => console.log('✅ ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });

const waitEvent = (s, ev, pred, label, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
    const h = (x) => { if (!pred || pred(x)) { clearTimeout(t); s.off(ev, h); res(x); } };
    s.on(ev, h);
  });

const ROOM = 'kills' + Math.random().toString(36).slice(2, 6);
const a = await connect('A');
const b = await connect('B');
const c = await connect('C');
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name, cid: `cid-${name}` }, res));
const aId = (await join(a, 'Ana')).you.id;
const bId = (await join(b, 'Bo')).you.id;
const cId = (await join(c, 'Cy')).you.id;
a.emit('set-mode', 'chaos');
await sleep(300);

let latest = null;
a.on('game-state', (g) => { if (g) latest = g; });
if (process.env.DEBUG_BLAST) a.on('blast', (m) => console.log('   [blast]', JSON.stringify({ x: Math.round(m.x), y: Math.round(m.y), dmg: m.dmg })));

const startP = waitEvent(a, 'game-state', (g) => g?.phase === 'playing', 'match 1 start');
a.emit('start-game');
const g0 = await startP;
const W = g0.terrain.width;

// park everyone far apart, chutes stowed (this test is about ground combat)
const park = { [aId]: 0.18 * W, [bId]: 0.5 * W, [cId]: 0.82 * W };
// ⚠️ authoritative client-side position book: tank-move relays produce NO
//    game-state, so `latest` LAGS the server (positions + the para flag are
//    stale spawn data). The test tracks where IT put each tank; a respawn is
//    the only server-side move, re-synced from the respawn broadcast.
const pos = {};
const sockOf = { [aId]: a, [bId]: b, [cId]: c };
const parkAll = () => {
  for (const [id, x] of Object.entries(park)) {
    pos[id] = { x, y: 300, para: false };
    sockOf[id].emit('tank-move', { x, y: 300, para: false });
  }
};
parkAll();
await sleep(400);

const tank = (g, id) => g.tanks.find((t) => t.id === id);

/** victim respawned (server-picked spot, fresh chute): re-sync the book, stow.
 *  ⚠️ reads the respawn game-EVENT, never `latest` - applyBlast emits 'blast'
 *  BEFORE its game-state broadcast, so a !dead check on `latest` can resolve
 *  on a stale pre-kill state and aim the next shot at the old spot */
const restow = async (victimId) => {
  const e = await Promise.any([
    waitEvent(a, 'game-event', (ev) => ev.kind === 'respawn' && ev.id === victimId, 'respawn event'),
    waitEvent(a, 'game-state', (s) => s && !tank(s, victimId).dead && tank(s, victimId).para, 'respawn state')
      .then((g) => ({ x: tank(g, victimId).x, y: tank(g, victimId).y })),
  ]);
  pos[victimId] = { x: e.x, y: e.y, para: true };
  sockOf[victimId].emit('tank-move', { para: false }); // stow ONLY - never move the server position
  pos[victimId].para = false;
  await sleep(300); // let the stow land server-side
};

/** attacker blasts the victim's tracked position; scale sets dd (direct = 50×scale) */
const blastAt = async (sock, victimId, scale, label) => {
  if (pos[victimId]?.para) await restow(victimId);
  const bl = waitEvent(a, 'blast', (m) => m.dmg?.some((d) => d.id === victimId), label);
  sock.emit('blast', { x: pos[victimId].x, y: pos[victimId].y - 18, r: 40, scale, big: false });
  return bl;
};
const stateAfter = async (pred, label, ms) => { // latest state that satisfies pred
  if (pred(latest)) return latest;
  return waitEvent(a, 'game-state', pred, label, ms);
};

// ═══ MATCH 1: attribution + kills beat damage at 0:00 ═══
// A kills B (scale 2 → exactly 100 dmg): A +1 kill, B +1 death, C untouched
await blastAt(a, bId, 2, 'A kills B');
let g = await stateAfter((s) => s && tank(s, bId).dead, 'B dead');
if ((tank(g, aId).kills | 0) !== 1) fail(`A should have 1 kill, got ${tank(g, aId).kills}`);
if ((tank(g, bId).kills | 0) !== 0 || (tank(g, cId).kills | 0) !== 0) fail('a kill must credit the shooter ONLY');
if ((tank(g, bId).deaths | 0) !== 1) fail(`B should have 1 death, got ${tank(g, bId).deaths}`);
if ((tank(g, aId).dmg | 0) !== 100) fail(`A should have 100 dmg, got ${tank(g, aId).dmg}`);
ok('kill credits the shooter (+1 ☠), the victim (+1 💀), and NOBODY else');

// C self-destructs (scale 6 → 300 on itself): no kill credit, one death
await blastAt(c, cId, 6, 'C self-kill');
g = await stateAfter((s) => s && tank(s, cId).dead, 'C dead');
if ((tank(g, cId).kills | 0) !== 0) fail(`self-kill must never credit - C has ${tank(g, cId).kills} kills`);
if ((tank(g, cId).deaths | 0) !== 1) fail(`C should have 1 death, got ${tank(g, cId).deaths}`);
if ((tank(g, cId).dmg | 0) !== 0) fail(`self-splash must not score - C has ${tank(g, cId).dmg} dmg`);
ok('self-kill: no credit, never negative - just a death on the board');

// B respawns (chute); C out-damages A WITHOUT a kill: 60 on A + 60 on B = 120 > 100
await restow(bId);
await blastAt(c, aId, 1.2, 'C hits A (60)');   // A: 100 → 40hp
await blastAt(c, bId, 1.2, 'C hits B (60)');   // B: 100 → 40hp
g = await stateAfter((s) => s && (tank(s, cId).dmg | 0) === 120, 'C dmg 120');
if ((tank(g, cId).kills | 0) !== 0) fail('C should still have 0 kills');
ok('C out-damages A (120 vs 100) but trails on kills (0 vs 1)');

// 0:00 → A wins on KILLS despite less damage
g = await waitEvent(a, 'game-state', (s) => s?.turn?.phase === 'over', 'match 1 over', 25000);
if (g.winner !== aId) fail(`top-kills A should win at 0:00 (got winner=${g.winner}, want ${aId})`);
ok('🏆 0:00: most KILLS wins (A: 1☠ beats C: 120💥)');
if ((g.match?.kills?.[aId] | 0) !== 1 || (g.match?.deaths?.[bId] | 0) !== 1) fail('match career board should fold round kills/deaths');
ok('match career board folds the round (kills/deaths/dmg)');

// ═══ MATCH 2: equal kills → damage tie-break ═══
const m2P = waitEvent(a, 'game-state', (s) => s?.phase === 'playing' && s?.match?.round === 1 && s.tanks.every((t) => (t.kills | 0) === 0), 'match 2 start');
a.emit('new-match');
await m2P;
parkAll();
await sleep(400);
await blastAt(a, bId, 2, 'A kills B (100)');            // A: 1☠ 100💥
await restow(bId);
await blastAt(c, bId, 3, 'C kills B (150)');            // C: 1☠ 150💥
g = await waitEvent(a, 'game-state', (s) => s?.turn?.phase === 'over', 'match 2 over', 25000);
if (g.winner !== cId) fail(`kill-tie should fall to damage - C (150💥) beats A (100💥) (got winner=${g.winner})`);
ok('🏆 equal kills → damage tie-break decides (C: 150💥 > A: 100💥)');

// ═══ MATCH 3: dead level on both → draw ═══
const m3P = waitEvent(a, 'game-state', (s) => s?.phase === 'playing' && s.tanks.every((t) => (t.kills | 0) === 0), 'match 3 start');
a.emit('new-match');
await m3P;
parkAll();
await sleep(400);
await blastAt(a, bId, 2, 'A kills B (100)');
await restow(bId);
await blastAt(c, bId, 2, 'C kills B (100)');
g = await waitEvent(a, 'game-state', (s) => s?.turn?.phase === 'over', 'match 3 over', 25000);
if (g.winner !== null) fail(`dead-level kills AND damage must draw (got winner=${g.winner})`);
ok('🏳️ equal kills, equal damage → DRAW');

[a, b, c].forEach((s) => s.disconnect());
console.log('\n🎉 kills scoring passed - attribution, self-kill rule, kills-first winner, damage tie-break, draw');
process.exit(0);
