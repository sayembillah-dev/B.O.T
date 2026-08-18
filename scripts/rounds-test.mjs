/**
 * Host + rounds flow test:
 *   first joiner is 👑 host; non-host can't set rounds / start / end / regen;
 *   host sets best-of-3, starts → game-state carries hostId + match{round:1,roundsTotal:3};
 *   host leaves mid-game → crown transfers; promoted host can end the game.
 * Run the server first.  Usage: URL=http://localhost:3000 node scripts/rounds-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'roundtest' + Math.floor(Math.random() * 1000);
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));

/** Persistent per-socket trackers (no races with leftover broadcasts). */
function track(s) {
  const t = { room: null, game: undefined, gameEvents: 0 };
  s.on('room-state', (st) => { t.room = st; });
  s.on('game-state', (g) => { t.game = g; t.gameEvents += 1; });
  return t;
}
const waitFor = (s, ev, pred, label) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), 8000);
    const h = (x) => { if (!pred || pred(x)) { clearTimeout(t); s.off(ev, h); res(x); } };
    s.on(ev, h);
  });

try {
  const alice = await connect('alice');
  const bob = await connect('bob');
  const ta = track(alice);
  const tb = track(bob);

  const aliceSaw2 = waitFor(alice, 'room-state', (st) => st.players.length === 2, 'alice sees 2 players');
  const ra = await join(alice, 'Alice');
  if (!ra.ok) fail(`Alice could not join: ${ra.error}`);
  if (ra.room.hostId !== ra.you.id) fail('Alice (first joiner) should be host');
  if (ra.room.roundsTotal !== 1) fail(`default roundsTotal should be 1, got ${ra.room.roundsTotal}`);
  console.log('✅ Alice joined first → she is 👑 host, default rounds = 1');

  const rb = await join(bob, 'Bob');
  if (!rb.ok) fail(`Bob could not join: ${rb.error}`);
  if (rb.room.hostId !== ra.you.id) fail('Bob should see Alice as host');
  await aliceSaw2; // drain the join broadcast before asserting silence
  console.log('✅ Bob sees Alice as host');

  // 1) non-host cannot set rounds
  bob.emit('set-rounds', 5);
  await sleep(400);
  if (ta.room?.roundsTotal !== 1 || tb.room?.roundsTotal !== 1) fail("Bob's set-rounds should be ignored");
  console.log('✅ non-host set-rounds ignored');

  // 2) host sets best-of-3 → broadcast to everyone
  const bobSaw3 = waitFor(bob, 'room-state', (st) => st.roundsTotal === 3, 'rounds=3 broadcast');
  const aliceSaw3 = waitFor(alice, 'room-state', (st) => st.roundsTotal === 3, 'rounds=3 broadcast (alice)');
  alice.emit('set-rounds', 3);
  await Promise.all([bobSaw3, aliceSaw3]);
  console.log('✅ host set-rounds 3 → broadcast to room');

  // 3) invalid value rejected
  alice.emit('set-rounds', 4);
  await sleep(400);
  if (ta.room?.roundsTotal !== 3) fail('set-rounds 4 should be rejected (only 1/3/5/7/9)');
  console.log('✅ invalid rounds value rejected');

  // 4) non-host cannot start
  bob.emit('start-game');
  await sleep(500);
  if (tb.game) fail("Bob's start-game should be ignored");
  console.log('✅ non-host start-game ignored');

  // 5) host starts → game-state has hostId + match{round:1, roundsTotal:3}
  const bobGame = waitFor(bob, 'game-state', (g) => g?.phase === 'playing', 'game start');
  alice.emit('start-game');
  const g = await bobGame;
  if (g.hostId !== ra.you.id) fail('game-state should carry hostId = Alice');
  if (!g.match || g.match.round !== 1 || g.match.roundsTotal !== 3 || g.match.over !== false)
    fail(`bad match state: ${JSON.stringify(g.match)}`);
  console.log('✅ host started → match { round: 1, roundsTotal: 3 } broadcast');

  // 6) non-host cannot regen/end mid-game (no game-state traffic at all)
  const markA = ta.gameEvents, markB = tb.gameEvents;
  bob.emit('regen-terrain');
  bob.emit('end-game');
  await sleep(500);
  if (ta.gameEvents !== markA || tb.gameEvents !== markB) fail("Bob's regen/end should be silently ignored");
  console.log('✅ non-host regen-terrain / end-game ignored');

  // 7) host leaves mid-game → crown transfers to Bob
  const bobHost = waitFor(bob, 'room-state', (st) => st.hostId === rb.you.id, 'host transfer');
  alice.emit('leave-room');
  await bobHost;
  console.log('✅ host left → 👑 transferred to Bob');

  // 8) new host (Bob) can end the game now
  const bobLobby = waitFor(bob, 'game-state', (x) => x === null, 'back to lobby');
  bob.emit('end-game');
  await bobLobby;
  console.log('✅ promoted host ended the game → lobby');

  alice.close(); bob.close();
  console.log('\n🎉 All host/rounds tests passed');
  process.exit(0);
} catch (err) {
  fail(err.message);
}
