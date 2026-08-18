/**
 * 🎲 Spawn-randomization check: the slot assignment must NOT follow join
 * order. 3 players start a game, then the host re-rolls the terrain 14×;
 * every round we record which x-rank each join-order tank got. Assert at
 * least 2 distinct permutations appear and that spawns stay ≥90px apart.
 * Run the server first.  Usage: URL=http://localhost:3210 node scripts/spawn-random-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'rand' + Math.random().toString(36).slice(2, 8); // alnum only — ROOM_ID_RE
const N = 3;
const TRIALS = 14;
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });
const join = (s, name) => new Promise((res) => s.emit('join-room', { roomId: ROOM, name }, res));
const nextGameState = (s, pred, label) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), 20000);
    const h = (g) => { if (g && pred(g)) { clearTimeout(t); s.off('game-state', h); res(g); } };
    s.on('game-state', h);
  });

const socks = [];
for (let i = 0; i < N; i++) {
  const s = await connect('P' + i);
  const ack = await join(s, 'P' + i);
  if (!ack?.ok) fail(`join rejected: ${ack?.error}`);
  socks.push(s);
}
const host = socks[0];
console.log(`✅ ${N} players joined ${ROOM}`);

/** permutation signature: for each tank in join order, its rank in x order */
const permOf = (g) => {
  const xs = g.tanks.map((t) => t.x);
  const sorted = [...xs].sort((a, b) => a - b);
  return xs.map((x) => sorted.indexOf(x)).join(',');
};
const checkGaps = (g, label) => {
  const xs = g.tanks.map((t) => t.x).sort((a, b) => a - b);
  const minGap = Math.min(...xs.slice(1).map((x, i) => x - xs[i]));
  if (minGap < 90) fail(`${label}: tanks too close (minGap ${minGap})`);
};

const perms = new Set();
let g = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('start timeout')), 30000);
  host.on('game-state', (st) => {
    if (st && st.tanks?.length === N) { clearTimeout(t); res(st); }
  });
  host.emit('start-game');
});
perms.add(permOf(g));
checkGaps(g, 'start');
console.log(`▶ round 1 permutation (join-order → x-rank): ${permOf(g)}`);

for (let i = 1; i < TRIALS; i++) {
  const prevSeed = g.terrain.seed;
  const p = nextGameState(host, (st) => st.terrain.seed !== prevSeed && st.tanks?.length === N, `regen ${i}`);
  host.emit('regen-terrain');
  g = await p;
  perms.add(permOf(g));
  checkGaps(g, `regen ${i}`);
}
console.log(`▶ ${TRIALS} rounds produced ${perms.size} distinct permutations: ${[...perms].join(' | ')}`);
if (perms.size < 2) fail(`spawn assignment never changed across ${TRIALS} rounds — still following join order!`);

socks.forEach((s) => s.close());
console.log('🎉 SPAWNS RANDOMIZED — join order does not decide position');
process.exit(0);
