/**
 * 👑 Host-crown stability test - the lobby master must NEVER switch away from
 * the room creator:
 *   1. creator A joins → host
 *   2. member B joins → A stays host
 *   3. A drops (reload/network blip) → B becomes CARETAKER host
 *   4. A rejoins with the same stable cid → crown RETURNS to A
 *   5. B drops and rejoins → A stays host (members never steal the crown)
 *   6. a cid-less legacy client joins/leaves → crown untouched
 *   7. game flow still works, and a mid-game drop/rejoin returns the crown too
 * Run the server first.  Usage: URL=http://localhost:3000 node scripts/host-reclaim-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'crown' + Math.random().toString(36).slice(2, 6);
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

/** wait for a room-state matching pred (skips stale broadcasts already in flight) */
const waitState = (s, pred, what = 'room-state') =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), 8000);
    const h = (st) => {
      if (pred(st)) { clearTimeout(t); s.off('room-state', h); res(st); }
    };
    s.on('room-state', h);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) creator A joins → host
const a1 = await connect('A1');
const a1Join = await join(a1, 'Alice', 'cid-alice');
if (!a1Join?.ok) fail('A join failed: ' + a1Join?.error);
if (a1Join.room.hostId !== a1.id) fail('A should be host after creating the room');
console.log('✅ creator A is host');

// 2) member B joins → A stays host
const b1 = await connect('B1');
const b1Join = await join(b1, 'Bob', 'cid-bob');
if (!b1Join?.ok) fail('B join failed: ' + b1Join?.error);
if (b1Join.room.hostId !== a1.id) fail('A should still be host after B joins');
console.log('✅ A stays host when B joins');
await sleep(150); // let join broadcasts drain

// 3) A drops → B becomes caretaker
const bSeesTransfer = waitState(b1, (st) => st.players.length === 1, 'transfer to B');
a1.disconnect();
const stAfterDrop = await bSeesTransfer;
if (stAfterDrop.hostId !== b1.id) fail(`after A drops, caretaker should be B (got ${stAfterDrop.hostId}, want ${b1.id})`);
console.log('✅ B becomes caretaker host when A drops');

// 4) A rejoins with the same cid → crown returns
const a2 = await connect('A2');
const a2Join = await join(a2, 'Alice', 'cid-alice');
if (!a2Join?.ok) fail('A rejoin failed: ' + a2Join?.error);
if (a2Join.room.hostId !== a2.id) fail(`crown should return to creator A (got ${a2Join.room.hostId}, want ${a2.id})`);
console.log('✅ crown returns to creator A on rejoin');
await sleep(150);

// 5) B drops + rejoins → A stays host
const aSeesBLeave = waitState(a2, (st) => st.players.length === 1, 'B leave');
b1.disconnect();
await aSeesBLeave;
const b2 = await connect('B2');
const b2Join = await join(b2, 'Bob', 'cid-bob');
if (!b2Join?.ok) fail('B rejoin failed: ' + b2Join?.error);
if (b2Join.room.hostId !== a2.id) fail('member B must never take the crown from creator A');
console.log('✅ member rejoin does NOT steal the crown');
await sleep(150);

// 6) legacy cid-less client: joins as member; leaves; crown untouched
const c = await connect('C');
const cJoin = await join(c, 'Carol');
if (!cJoin?.ok) fail('C join failed: ' + cJoin?.error);
if (cJoin.room.hostId !== a2.id) fail('cid-less join must not move the crown');
await sleep(150);
const aSeesCLeave = waitState(a2, (st) => st.players.length === 2, 'C leave');
c.disconnect();
const stAfterC = await aSeesCLeave;
if (stAfterC.hostId !== a2.id) fail('cid-less leave must not move the crown');
console.log('✅ legacy cid-less clients never affect the crown');

// 7) full game flow still works with the crowned creator: A starts, both get state
const b2SeesGame = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('B game-state timeout')), 8000);
  b2.once('game-state', (g) => { clearTimeout(t); res(g); });
});
a2.emit('start-game');
const g = await b2SeesGame;
if (!g?.tanks || g.hostId !== a2.id) fail('game-state should carry hostId = creator A');
console.log('✅ game starts with creator A as hostId in game-state');
await sleep(150);

// even mid-game: A drops (tank stays as ghost), B caretakes; A rejoins → crown back
const b2SeesMid = waitState(b2, (st) => st.players.length === 1, 'mid-game transfer');
a2.disconnect();
const stMid = await b2SeesMid;
if (stMid.hostId !== b2.id) fail('mid-game: B should caretake while A is gone');
const a3 = await connect('A3');
const a3Join = await join(a3, 'Alice', 'cid-alice');
if (!a3Join?.ok) fail('A mid-game rejoin failed: ' + a3Join?.error);
if (a3Join.room.hostId !== a3.id) fail('mid-game rejoin: crown should return to creator A');
console.log('✅ mid-game drop/rejoin: crown still returns to the creator');

await sleep(200);
[b2, a3].forEach((s) => s.disconnect());
console.log('\n🎉 HOST CROWN STABLE - creator keeps the master role through drops, rejoins and matches');
process.exit(0);
