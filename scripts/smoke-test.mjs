/**
 * End-to-end smoke test for the template's full loop:
 *   two clients join a room and see each other in real-time,
 *   a game starts (both get game-state) and ends (back to lobby),
 *   one leaves, and a 9th player is rejected.
 * Run the server first.  Usage: URL=http://localhost:3000 node scripts/smoke-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'smoke42';
const fail = (msg) => {
  console.error('❌ ' + msg);
  process.exit(1);
};

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => {
      clearTimeout(t);
      res(s);
    });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });

const join = (s, name) =>
  new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));

const waitPlayerCount = (s, n) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${n} players`)), 8000);
    s.on('room-state', (st) => {
      if (st.players.length === n) {
        clearTimeout(t);
        res(st);
      }
    });
  });

/** Resolve when a matching game-state arrives: 'playing', or null (back to lobby). */
const waitGameState = (s, want) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for game-state ${want}`)), 8000);
    s.on('game-state', (g) => {
      if ((want === null && g === null) || g?.phase === want) {
        clearTimeout(t);
        res(g);
      }
    });
  });

try {
  const alice = await connect('alice');
  const bob = await connect('bob');

  const ra = await join(alice, 'Alice');
  if (!ra.ok) fail(`Alice could not join: ${ra.error}`);
  console.log(`✅ Alice joined as ${ra.you.emoji} ${ra.you.name}`);

  const sawTwo = waitPlayerCount(alice, 2);
  const rb = await join(bob, 'Bob');
  if (!rb.ok) fail(`Bob could not join: ${rb.error}`);
  console.log(`✅ Bob joined as ${rb.you.emoji} ${rb.you.name}`);

  const st2 = await sawTwo;
  console.log(`✅ Alice sees ${st2.players.length} players: ${st2.players.map((p) => p.name).join(', ')}`);

  // game lifecycle: start → both clients receive game-state, end → back to lobby (null)
  const alicePlaying = waitGameState(alice, 'playing');
  const bobPlaying = waitGameState(bob, 'playing');
  alice.emit('start-game');
  const [ga] = await Promise.all([alicePlaying, bobPlaying]);
  console.log(`✅ Game started — both clients got game-state (phase=${ga.phase}, ${ga.players.length} players)`);

  const aliceLobby = waitGameState(alice, null);
  const bobLobby = waitGameState(bob, null);
  alice.emit('end-game');
  await Promise.all([aliceLobby, bobLobby]);
  console.log('✅ Game ended — clients returned to lobby (game-state null)');

  const sawOne = waitPlayerCount(alice, 1);
  bob.emit('leave-room');
  const st1 = await sawOne;
  console.log(`✅ After Bob left, Alice sees: ${st1.players.map((p) => p.name).join(', ')}`);

  // capacity: fill the room to 8, the 9th must be rejected
  const sockets = [alice];
  for (let i = 0; i < 7; i++) {
    const s = await connect('p' + i);
    sockets.push(s);
    await join(s, 'P' + i);
  }
  const ninth = await connect('ninth');
  const r9 = await join(ninth, 'Ninth');
  if (r9.ok) fail('9th player should have been rejected');
  console.log(`✅ 9th player rejected as expected: "${r9.error}"`);

  [...sockets, ninth, bob].forEach((s) => s.close());
  console.log('\n🎉 All smoke tests passed');
  process.exit(0);
} catch (err) {
  fail(err.message);
}
