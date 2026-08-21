/**
 * 🔌 Mid-game refresh / browser-cut rejoin test - what happens when a player
 * disappears mid-match and comes back:
 *   1. A (creator) + B join, A starts a classic game
 *   2. B drops (refresh) -> A sees B's tank marked gone, match goes on
 *   3. B rejoins with the same cid inside the grace window -> tank RE-BOUND to
 *      the new socket (alive, not gone), B back in g.players
 *   4. EVERYONE drops at once (browser cut / last player refreshed) -> the room
 *      AND the frozen match survive in limbo: B rejoins -> game intact, tank
 *      rebound; A rejoins -> crown returns to the creator, tank rebound
 *   5. everyone drops again and nobody returns -> after LEAVE_GRACE_MS the room
 *      is swept: a new join finds a fresh lobby (game-state null)
 * Run the server first with a short grace, production mode:
 *   set LEAVE_GRACE_MS=1500 && set PORT=3100 && set NODE_ENV=production && node server.js
 *   URL=http://localhost:3100 node scripts/rejoin-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'rejoin' + Math.random().toString(36).slice(2, 6);
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });

const join = (s, name, cid) =>
  new Promise((res) => s.emit('join-room', { roomId: ROOM, name, ...(cid ? { cid } : {}) }, res));

/** wait for a non-null game-state matching pred (skips stale broadcasts in flight) */
const waitGame = (s, pred, what = 'game-state') =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), 8000);
    const h = (st) => {
      if (st && pred(st)) { clearTimeout(t); s.off('game-state', h); res(st); }
    };
    s.on('game-state', h);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tankByName = (st, name) => (st.tanks ?? []).find((t) => t.name === name);

// 1) A (creator) + B join, game starts
const a1 = await connect('A1');
const a1Join = await join(a1, 'Alice', 'cid-alice');
if (!a1Join?.ok) fail('A join failed: ' + a1Join?.error);
const b1 = await connect('B1');
const b1Join = await join(b1, 'Bob', 'cid-bob');
if (!b1Join?.ok) fail('B join failed: ' + b1Join?.error);

const aGame = waitGame(a1, (st) => st.phase === 'playing', 'game start (A)');
a1.emit('start-game');
const g0 = await aGame;
if ((g0.tanks ?? []).length !== 2) fail('game should start with 2 tanks');
console.log('✓ 1. game started with 2 tanks');
await sleep(150); // let start broadcasts drain

// 2) B drops mid-game (refresh) -> A sees Bob's tank marked GONE, not dead
const aSeesGone = waitGame(a1, (st) => tankByName(st, 'Bob')?.gone === true, 'Bob gone flag');
b1.disconnect();
const gGone = await aSeesGone;
if (tankByName(gGone, 'Bob')?.dead) fail('a dropped tank must be marked gone, NOT killed');
console.log('✓ 2. B dropped mid-game -> tank marked gone (grace window open)');

// 3) B rejoins with the same cid inside the grace window -> tank re-bound
const b2 = await connect('B2');
const b2Rebound = waitGame(b2, (st) => tankByName(st, 'Bob')?.id === b2.id && !tankByName(st, 'Bob')?.gone, 'Bob tank re-bind');
const b2Join = await join(b2, 'Bob', 'cid-bob');
if (!b2Join?.ok) fail('B rejoin failed: ' + b2Join?.error);
const gRe = await b2Rebound;
const bobT = tankByName(gRe, 'Bob');
if (bobT.dead) fail('reclaimed tank must still be alive');
if (!gRe.players?.some((p) => p.id === b2.id)) fail('B must be back in the game player list');
if (gRe.phase !== 'playing') fail('match must still be playing after rejoin');
console.log('✓ 3. B rejoined in grace -> tank re-bound to the new socket (alive, not gone)');

// 4) EVERYONE drops at once -> room + frozen match survive in limbo
a1.disconnect();
b2.disconnect();
await sleep(400); // inside the grace window (LEAVE_GRACE_MS=1500)

const b3 = await connect('B3');
const b3Game = waitGame(b3, (st) => st.phase === 'playing' && tankByName(st, 'Bob')?.id === b3.id, 'limbo rejoin (B)');
const b3Join = await join(b3, 'Bob', 'cid-bob');
if (!b3Join?.ok) fail('B limbo rejoin failed: ' + b3Join?.error);
const gLimbo = await b3Game;
if (tankByName(gLimbo, 'Bob')?.dead) fail('limbo rejoin must find the tank alive');
console.log('✓ 4a. room emptied mid-game -> match survived in limbo, B reclaimed');

const a3 = await connect('A3');
const a3Game = waitGame(a3, (st) => tankByName(st, 'Alice')?.id === a3.id && !tankByName(st, 'Alice')?.gone, 'limbo rejoin (A)');
const a3Join = await join(a3, 'Alice', 'cid-alice');
if (!a3Join?.ok) fail('A limbo rejoin failed: ' + a3Join?.error);
await a3Game;
if (a3Join.room.hostId !== a3.id) fail('the crown must return to creator A on limbo rejoin');
console.log('✓ 4b. A reclaimed too - crown returned to the creator');

// 5) everyone drops for GOOD -> room + match swept after LEAVE_GRACE_MS
a3.disconnect();
b3.disconnect();
await sleep(2200); // > 1500ms grace + a few 100ms ticks

const c1 = await connect('C1');
const gsOnce = new Promise((res) => c1.once('game-state', res));
const c1Join = await join(c1, 'Cara', 'cid-cara');
if (!c1Join?.ok) fail('C join failed: ' + c1Join?.error);
const gs0 = await gsOnce;
if (gs0 !== null) fail('after the grace lapse the room must be a fresh lobby (game-state null)');
if (c1Join.room.players.length !== 1) fail('the swept room must be recreated fresh (1 player)');
console.log('✓ 5. nobody returned -> room swept after grace, rejoin lands in a fresh lobby');

a1.close(); b1.close(); b2.close(); b3.close(); a3.close(); c1.close();
console.log('\n🎉 MID-GAME REJOIN STABLE - refresh / browser-cut always lands you back in the fight');
process.exit(0);
