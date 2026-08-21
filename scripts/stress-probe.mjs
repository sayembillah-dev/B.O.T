/**
 * 🔥 Stress probe: 4 clients, chaos room, max-size blasts every cooldown.
 * Watches server health from the client's side:
 *   - game-state inter-arrival gaps (event-loop stalls show up as spikes)
 *   - payload size growth (something in the state growing unbounded?)
 *   - blast relay throughput
 * Server RSS is sampled externally (ps) by the runner shell.
 *
 *   PORT=3210 CHAOS_DURATION_MS=90000 CHAOS_FIRE_GRACE_MS=1 node server.js
 *   URL=http://localhost:3210 node scripts/stress-probe.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3210';
const DURATION_S = Number(process.env.STRESS_S || 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (name) =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => rej(new Error(`${name}: ${e.message}`)));
  });
const join = (s, room, name, cid) => new Promise((res) => s.emit('join-room', { roomId: room, name, cid }, res));

const ROOM = 'stress' + Math.random().toString(36).slice(2, 6);
const clients = await Promise.all(['A', 'B', 'C', 'D'].map(connect));
for (let i = 0; i < clients.length; i++) {
  const r = await join(clients[i], ROOM, `Bot${i}`, `stress-${i}`);
  if (!r.ok) throw new Error(`join failed: ${r.error}`);
}
clients[0].emit('set-mode', 'chaos');
await sleep(300);

// health metrics observed by client A
let lastGs = 0, maxGap = 0, gsCount = 0, blastCount = 0, maxPayload = 0, lastPayload = 0;
const gapHist = [];
clients[0].on('game-state', (g) => {
  if (!g) return;
  const now = performance.now();
  if (lastGs) { const gap = now - lastGs; gapHist.push(gap); if (gap > maxGap) maxGap = gap; }
  lastGs = now; gsCount++;
  lastPayload = JSON.stringify(g).length;
  if (lastPayload > maxPayload) maxPayload = lastPayload;
});
clients[0].on('blast', () => { blastCount++; });

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('start timeout')), 30000);
  clients[0].on('game-state', (g) => { if (g && g.phase === 'playing') { clearTimeout(t); res(g); } });
  clients[0].emit('start-game');
});
console.log('game started - hammering with r=200 scale=6 blasts…');

// every client: stow the chute, stream tank-move at 12Hz, fire at cooldown
for (const [i, s] of clients.entries()) {
  s.emit('tank-move', { x: 150 + i * 200, y: 60, para: false });
  const mv = setInterval(() => s.emit('tank-move', { x: 150 + i * 200 + Math.sin(Date.now() / 900) * 40, y: 300, fuel: 80 }), 83);
  const fire = setInterval(() => {
    s.emit('fire', { a: -1.1, p: 0.8, kind: 'normal' });
    // shooter reports the impact - max legal blast, random spot on the map
    s.emit('blast', { x: 200 + Math.random() * 2000, y: 250 + Math.random() * 400, r: 200, scale: 6, big: true });
  }, 1050);
  s.data = { mv, fire };
}

const t0 = Date.now();
while (Date.now() - t0 < DURATION_S * 1000) {
  await sleep(5000);
  const alive = clients.every((s) => s.connected);
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s gs=${gsCount} blasts=${blastCount} maxGap=${Math.round(maxGap)}ms payload=${lastPayload}B max=${maxPayload}B sockets=${alive ? 'all live' : 'DROPPED!'}`);
  if (!alive) { console.log('💥 a socket dropped - server wedged or dead'); break; }
  maxGap = 0; // report per-window max
}
for (const s of clients) { clearInterval(s.data.mv); clearInterval(s.data.fire); s.disconnect(); }
gapHist.sort((x, y) => x - y);
const p99 = gapHist[Math.floor(gapHist.length * 0.99)] ?? 0;
console.log(`\nDone. game-state msgs=${gsCount} p50=${Math.round(gapHist[Math.floor(gapHist.length / 2)] ?? 0)}ms p99=${Math.round(p99)}ms blasts=${blastCount} maxPayload=${maxPayload}B`);
process.exit(0);
