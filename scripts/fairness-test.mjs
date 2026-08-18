/**
 * Spawn-fairness check: for N = 2, 3, 4 players (3 random terrains each),
 * start a game and assert every tank is in-bounds and ≥90px from its
 * neighbours, and that gaps stay reasonably even.
 * Run the server first.  Usage: URL=http://localhost:3210 node scripts/fairness-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';

const connect = () =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error('connect timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(String(e.message || e))));
  });
const join = (s, roomId, name) => new Promise((res) => s.emit('join-room', { roomId, name }, res));

let allOk = true;
for (const n of [2, 3, 4]) {
  for (let trial = 0; trial < 3; trial++) {
    const room = `fz${n}x${trial}x${Math.floor(Math.random() * 100000)}`; // alnum only — ROOM_ID_RE
    const socks = [];
    for (let i = 0; i < n; i++) {
      const s = await connect();
      const ack = await join(s, room, 'P' + i);
      if (!ack?.ok) { console.error(`join rejected: ${ack?.error}`); process.exit(1); }
      socks.push(s);
    }
    const g = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`game-state timeout (${n}P trial ${trial})`)), 30000);
      socks[n - 1].on('game-state', (st) => {
        if (st && st.tanks?.length === n) { clearTimeout(t); res(st); }
      });
      socks[0].emit('start-game');
    });
    const xs = g.tanks.map((t) => t.x).sort((a, b) => a - b); // 🎲 assignment is shuffled — sort before measuring gaps
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    const minGap = Math.min(...gaps);
    const ok = minGap >= 90 && xs.every((x) => x >= 26 && x <= g.terrain.width - 26);
    if (!ok) allOk = false;
    console.log(`${n}P trial${trial}: xs=[${xs.join(', ')}] gaps=[${gaps.join(', ')}] minGap=${minGap} ${ok ? '✅' : '❌ UNFAIR'}`);
    socks.forEach((s) => s.close());
  }
}
console.log(allOk ? '🎉 ALL SPAWNS FAIR' : '💥 SOME SPAWNS UNFAIR');
process.exit(allOk ? 0 : 1);
