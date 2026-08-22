/**
 * 🎁 Uncovered-crate check (run the server with FORCE_DROP=fly):
 *   Classic mode: the crate type must be visible in game-state from the
 *   moment the crate spawns - mystery crates are gone, both modes uncovered.
 *
 * Run the server first:  set PORT=3210&& set FORCE_DROP=fly&& node server.js
 * Usage: URL=http://localhost:3210 node scripts/reveal-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'reveal' + Math.floor(Math.random() * 100000);
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(name + ' connect timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));

const a = await connect();
const ra = await join(a, 'Alice');
if (!ra?.ok) fail('Alice join: ' + ra?.error);
const b = await connect();
const rb = await join(b, 'Bob');
if (!rb?.ok) fail('Bob join: ' + rb?.error);
console.log('✅ both joined (classic room)');

let seen = null;
b.on('game-state', (g) => { if (!seen && g?.crates?.length) seen = g.crates[0]; });

a.emit('start-game');

// first drop lands ~10s in - the type must ride along from the very first sighting
const t0 = Date.now();
while (!seen && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
if (!seen) fail('no crate appeared within 30s');
if (!seen.type) fail('classic crate arrived with NO type - mystery stripping still active');
if (seen.type !== 'fly') fail(`expected type=fly (FORCE_DROP=fly), got ${seen.type}`);
console.log(`✅ classic crate type visible from spawn: ${seen.type}`);
console.log('🎉 reveal test OK');
process.exit(0);
