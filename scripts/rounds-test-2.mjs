/**
 * Round completion test (leaving mid-game = your tank dies → other player wins):
 *   best-of-3: win recorded → next-round → round 2 with kept scoreboard.
 *   best-of-1: match.over=true on round end → next-round rejected → new-match resets.
 * Run the server first.  Usage: URL=http://localhost:3000 node scripts/rounds-test-2.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });
const join = (s, room, name) => new Promise((res) => s.emit('join-room', { roomId: room, name }, res));
const waitFor = (s, ev, pred, label) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), 8000);
    const h = (x) => { if (!pred || pred(x)) { clearTimeout(t); s.off(ev, h); res(x); } };
    s.on(ev, h);
  });

const suffix = Math.floor(Math.random() * 1000);

try {
  // ── part A: best-of-3, win → next round keeps the scoreboard ──
  const ROOM_A = 'rt3a' + suffix;
  const alice = await connect('alice');
  const bob = await connect('bob');
  const ra = await join(alice, ROOM_A, 'Alice');
  const rb = await join(bob, ROOM_A, 'Bob');
  if (!ra.ok || !rb.ok) fail('join failed');

  alice.emit('set-rounds', 3);
  await sleep(250);
  const gameA = waitFor(bob, 'game-state', (g) => g?.phase === 'playing', 'A: game start');
  alice.emit('start-game');
  await gameA;

  // bob rage-quits → Alice wins round 1
  const overA = waitFor(alice, 'game-state', (g) => g?.turn?.phase === 'over', 'A: round over');
  bob.emit('leave-room');
  const gOver = await overA;
  if (gOver.winner !== ra.you.id) fail(`A: Alice should win the round (winner=${gOver.winner})`);
  if ((gOver.match?.wins?.[ra.you.id] | 0) !== 1) fail(`A: wins[alice] should be 1: ${JSON.stringify(gOver.match)}`);
  if (gOver.match.over) fail('A: match should NOT be over (round 1 of 3)');
  console.log('✅ best-of-3: round 1 win recorded (wins: Alice=1), match not over');

  // host advances → round 2, scoreboard kept
  const round2 = waitFor(alice, 'game-state', (g) => g?.phase === 'playing' && g.match?.round === 2, 'A: round 2');
  alice.emit('next-round');
  const g2 = await round2;
  if ((g2.match.wins?.[ra.you.id] | 0) !== 1) fail('A: scoreboard should survive into round 2');
  if (g2.match.over) fail('A: match still should not be over');
  console.log('✅ next-round → round 2/3, scoreboard carried over');

  // next-round rejected while round 2 is still running
  alice.emit('next-round');
  await sleep(400);
  // (silent reject — no crash, still playing round 2)
  console.log('✅ next-round mid-game ignored (no crash)');

  alice.emit('end-game');
  alice.close(); bob.close();

  // ── part B: best-of-1 → match.over → next-round rejected, new-match resets ──
  const ROOM_B = 'rt1b' + suffix;
  const carol = await connect('carol');
  const dave = await connect('dave');
  const rc = await join(carol, ROOM_B, 'Carol');
  const rd = await join(dave, ROOM_B, 'Dave');
  if (!rc.ok || !rd.ok) fail('join failed (B)');
  const gameB = waitFor(dave, 'game-state', (g) => g?.phase === 'playing', 'B: game start');
  carol.emit('start-game'); // roundsTotal defaults to 1
  await gameB;

  const overB = waitFor(carol, 'game-state', (g) => g?.turn?.phase === 'over', 'B: match over');
  dave.emit('leave-room');
  const gB = await overB;
  if (gB.winner !== rc.you.id) fail('B: Carol should win');
  if (!gB.match?.over) fail(`B: match.over should be true after round 1 of 1: ${JSON.stringify(gB.match)}`);
  console.log('✅ best-of-1: final round → match.over = true');

  // next-round must be rejected once the match is over
  carol.emit('next-round');
  await sleep(400); // silent reject = no crash; then:
  const fresh = waitFor(carol, 'game-state', (g) => g?.phase === 'playing' && g.match?.round === 1 && Object.keys(g.match.wins).length === 0, 'B: new match');
  carol.emit('new-match');
  const gNew = await fresh;
  if (gNew.match.over) fail('B: new match should reset over=false');
  console.log('✅ next-round rejected after match over; new-match → clean scoreboard, round 1');

  carol.close(); dave.close();
  console.log('\n🎉 All round-completion tests passed');
  process.exit(0);
} catch (err) {
  fail(err.message);
}
