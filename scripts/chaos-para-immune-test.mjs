/**
 * 🪂🛡️ Chaos parachute IMMUNITY - deterministic socket-level test of the
 * server choke points (the browser-level proof lives in chaos-para-test.mjs):
 *
 *   1. a blast dead-on a parachuting tank reports d:0 - HP unmoved, no death,
 *      and the shooter's damage total does NOT tick
 *   2. after the owner reports the stow (para:false), the same blast hurts
 *   3. exploit: a client that LANDS but never reports the stow is stowed by
 *      the server's ground check against the authoritative bitmap
 *   4. exploit: a client that hovers mid-air forever (patched client that
 *      never stows) is force-stowed by the PARA_MAX_MS deadline
 *
 * Run the server first (fast clocks keep it snappy):
 *   CHAOS_DURATION_MS=120000 CHAOS_RESPAWN_MS=2500 CHAOS_FIRE_GRACE_MS=1 PARA_MAX_MS=4000 PORT=3210 node server.js
 * Usage: URL=http://localhost:3210 node scripts/chaos-para-immune-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3210';
const ROOM = 'pim' + Math.random().toString(36).slice(2, 7);
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
const ok = (msg) => console.log('✅ ' + msg);

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name, cid: `cid-${name}` }, res));
const waitEvent = (s, ev, pred, label, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
    const h = (x) => { if (!pred || pred(x)) { clearTimeout(t); s.off(ev, h); res(x); } };
    s.on(ev, h);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await connect('A');
const b = await connect('B');
if (!(await join(a, 'Ana'))?.ok) fail('A join failed');
const bJoin = await join(b, 'Bo');
if (!bJoin?.ok) fail('B join failed');
const bId = bJoin.you.id;
a.emit('set-mode', 'chaos');
await sleep(300);
const startedP = waitEvent(a, 'game-state', (g) => g?.phase === 'playing', 'game start', 15000);
a.emit('start-game');
const g0 = await startedP;
if (!g0.tanks.every((t) => t.para)) fail('chaos tanks should spawn under canopy');
ok('2-player chaos started - both tanks parachuting');

// B hovers mid-air at (700, 300) and NEVER reports a stow - the hostile client
b.emit('tank-move', { x: 700, y: 300 });
await sleep(300);

// ── 1) immunity: a blast dead-on B's position must report d:0 ──
const rep1P = waitEvent(a, 'blast', (m) => m.dmg?.some((d) => d.id === bId), 'blast on para B');
a.emit('blast', { x: 700, y: 300 - 18, r: 58, scale: 6, big: false }); // would be 300 direct dmg
const rep1 = await rep1P;
const e1 = rep1.dmg.find((d) => d.id === bId);
if (e1.d !== 0 || e1.dead || e1.hp !== 100) fail(`parachuting tank must be blocked (d:0, hp:100, alive) - got ${JSON.stringify(e1)}`);
ok('🪂 blast dead-on a parachuting tank: d=0, hp 100, alive - BLOCKED');
const g1P = waitEvent(a, 'game-state', (g) => g.tanks.some((t) => t.id === bId), 'post-block state');
a.emit('tank-move', { x: 151, y: 300 }); // nudge a broadcast
const g1 = await g1P;
const aT1 = g1.tanks.find((t) => t.id !== bId);
if ((aT1.dmg | 0) !== 0) fail(`blocked damage must not score - A's dmg is ${aT1.dmg}, want 0`);
ok("shooter's damage total unmoved by the block (farming a chute scores nothing)");

// ── 2) after the owner reports the stow, the same blast hurts ──
b.emit('tank-move', { x: 700, y: 300, para: false });
await sleep(300);
const rep2P = waitEvent(a, 'blast', (m) => m.dmg?.some((d) => d.id === bId), 'blast after stow');
a.emit('blast', { x: 700, y: 300 - 18, r: 58, scale: 6, big: false });
const rep2 = await rep2P;
const e2 = rep2.dmg.find((d) => d.id === bId);
if (!(e2.d > 0) || !e2.dead) fail(`a stowed tank must take the hit (300 direct) - got ${JSON.stringify(e2)}`);
ok('🪂→🎯 owner-reported stow → the very next blast hurts (300 dmg kill)');

// ── 3) exploit: LAND but never report - the server's ground check stows ──
await waitEvent(a, 'game-event', (e) => e.kind === 'respawn' && e.id === bId, 'B respawns', 8000);
ok('B respawned under a fresh chute');
b.emit('tank-move', { x: 700, y: 2000 }); // clamped to height+80: below ground EVERYWHERE → landed, but no para:false report
const g4 = await waitEvent(a, 'game-state', (g) => {
  const t = g.tanks.find((tk) => tk.id === bId);
  return t && !t.dead && !t.para;
}, 'server ground-check stow', 4000);
ok("🪂 server's own ground check stowed the chute - no client report needed");
const rep3P = waitEvent(a, 'blast', (m) => m.dmg?.some((d) => d.id === bId), 'blast post-ground-check');
const bY3 = g4.tanks.find((t) => t.id === bId).y;
a.emit('blast', { x: 700, y: bY3 - 18, r: 58, scale: 6, big: false });
const e3 = (await rep3P).dmg.find((d) => d.id === bId);
if (!(e3.d > 0)) fail(`ground-check-stowed tank must take damage - got ${JSON.stringify(e3)}`);
ok(`ground-checked tank is mortal (${e3.d} dmg)`);

// ── 4) exploit: hover mid-air FOREVER - the PARA_MAX_MS deadline stows ──
await waitEvent(a, 'game-event', (e) => e.kind === 'respawn' && e.id === bId, 'B respawns again', 8000);
b.emit('tank-move', { x: 700, y: 300 }); // mid-air hover, never lands, never stows
const t0 = Date.now();
const g5 = await waitEvent(a, 'game-state', (g) => {
  const t = g.tanks.find((tk) => tk.id === bId);
  return t && !t.dead && !t.para;
}, 'deadline stow', 15000);
ok(`🪂 PARA_MAX_MS deadline force-stowed the stalled chute (~${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const rep4P = waitEvent(a, 'blast', (m) => m.dmg?.some((d) => d.id === bId), 'blast post-deadline');
a.emit('blast', { x: 700, y: 300 - 18, r: 58, scale: 6, big: false });
const e4 = (await rep4P).dmg.find((d) => d.id === bId);
if (!(e4.d > 0)) fail(`deadline-stowed tank must take damage - got ${JSON.stringify(e4)}`);
ok(`deadline-stowed tank is mortal (${e4.d} dmg) - a stalled/hostile client cannot hide in the sky`);

[a, b].forEach((s) => s.disconnect());
console.log('\n🎉 parachute immunity (server) passed - chute blocks damage, server owns the stow, both exploits closed');
process.exit(0);
