// 🛁 MEMORY SOAK - two plain-socket bots play a chaos match of worst-case
//    server load (tomahawk-class r=200 blasts = max terrain surgery garbage,
//    12Hz tank-move streams, late spectator join), then keep idling past the
//    final whistle so a leak that lives in the post-game phase still shows.
//
//    Run the server with telemetry on:
//      MEMLOG_MS=5000 CHAOS_DURATION_MS=90000 PORT=3210 node start.mjs
//    then:
//      URL=http://localhost:3210 node scripts/mem-soak.mjs
//
//    heapUsed that climbs and never falls back = something is retaining.
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3210';
const ROOM = process.env.ROOM || 'memsoak';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;

function connect(name, cid) {
  const socket = io(URL, { transports: ['websocket'] });
  const b = { socket, name, cid, tank: null, over: false };
  socket.on('game-state', (g) => {
    if (!g) return;
    b.tank = g.tanks?.find((t) => t.name === name) ?? b.tank;
    if (g.turn?.phase === 'over') b.over = true;
  });
  return b;
}

function join(b) {
  return new Promise((res, rej) => {
    b.socket.emit('join-room', { roomId: ROOM, name: b.name, cid: b.cid }, (r) =>
      r?.ok ? res(r) : rej(new Error(`join failed: ${r?.error}`)));
  });
}

async function main() {
  const A = connect('SoakA', 'cid-soak-a');
  const B = connect('SoakB', 'cid-soak-b');
  await Promise.all([join(A), join(B)]);
  console.log(`[${ts()}] both bots in room ${ROOM}`);

  A.socket.emit('set-mode', 'chaos');
  await sleep(150);
  A.socket.emit('start-game', {});
  console.log(`[${ts()}] chaos game requested`);

  // wait for tanks to exist
  for (let i = 0; i < 50 && (!A.tank || !B.tank); i++) await sleep(100);
  if (!A.tank || !B.tank) throw new Error('game never started');
  console.log(`[${ts()}] game live: A@${Math.round(A.tank.x)} B@${Math.round(B.tank.x)}`);

  // 📡 12Hz tank-move streams - kept alive THROUGH the post-game idle too,
  //    mimicking a client whose rAF loop still runs on the scoreboard screen
  const movers = setInterval(() => {
    for (const b of [A, B]) {
      if (!b.tank) continue;
      const x = Math.max(50, b.tank.x + (Math.random() * 24 - 12));
      b.socket.emit('tank-move', { x, y: 99999, aim: -0.8, fuel: 100, s: 0 }); // y clamps → ground-stows the chute
    }
  }, 83);

  // 💥 worst-case fire: a tomahawk-class r=200 blast per bot every ~1.2s
  const shooters = setInterval(() => {
    for (const [b, foe] of [[A, B], [B, A]]) {
      if (!b.tank || b.over) continue;
      b.socket.emit('fire', { a: -0.8, p: 0.7, kind: 'tomahawk' });
      const x = foe.tank ? foe.tank.x + (Math.random() * 120 - 60) : 200 + Math.random() * 800;
      setTimeout(() => b.socket.emit('blast', { x, y: 300 + Math.random() * 200, r: 200, scale: 2, big: true }), 350);
    }
  }, Number(process.env.FIRE_MS || 1200));

  // 👀 late spectator at 30s - exercises serializeGame(full) + blast-log replay
  setTimeout(async () => {
    const S = connect('Spectator', 'cid-soak-spec');
    try { await join(S); console.log(`[${ts()}] spectator joined (full state + blast log)`); } catch { /* room may be over */ }
  }, 30000);

  // heartbeat until 3 minutes past game-over
  let idleSince = null;
  for (;;) {
    await sleep(1000);
    const over = A.over && B.over;
    if (over && !idleSince) { idleSince = Date.now(); console.log(`[${ts()}] 🏁 game over - idling (streams still on)`); }
    if (idleSince && Date.now() - idleSince > 180000) break;
  }
  clearInterval(movers); clearInterval(shooters);
  console.log(`[${ts()}] soak complete - check server MEMLOG for monotonic heap growth`);
  A.socket.disconnect(); B.socket.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
