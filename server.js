// ════════════════════════════════════════════════════════════════════
//  🛡️ TANK BATTLE — server (Next.js + Socket.IO in one process)
//  Room state lives in memory. The server is AUTHORITATIVE for online
//  games: terrain seed + bitmap, tank spawns, HP/inventory/buffs, turn
//  rotation + 20s timer, wind, supply-drop schedule + crate physics,
//  blast application (destroyCircle) and damage. Clients simulate
//  physics locally for feel; the active player streams their tank and
//  reports shot impacts; the server validates, applies, broadcasts.
//
//  Solo dev (?solo=1) / hot-seat (?local=N) games run client-side only —
//  they start via start-game {dev:true} which bypasses MIN_PLAYERS.
// ════════════════════════════════════════════════════════════════════
const { createServer } = require('http');
const { randomBytes } = require('node:crypto');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
// Bind address. We deliberately read HOST, not HOSTNAME: shells like Git Bash
// export HOSTNAME=<computer-name>, which can resolve to a VM/VPN adapter and
// make the server unreachable on localhost. Set HOST to override.
const hostname = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ── Room config ───────────────────────────────────────────────────────
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2; // online games need 2+ — solo/hot-seat bypass with {dev:true}
const EMOJIS = ['😀','😎','🤖','👾','🐸','🦊','🐼','🐯','🦁','🐙','🦄','🐲','👻','💀','🤠','😺','🙉','🦖','🍕','⚡','🔥','🌵','🥷','🧙'];
const ROOM_ID_RE = /^[a-z0-9]{4,24}$/;

/** rooms: Map<roomId, { id, createdAt, players: Map<socketId, player>, game: object|null, sim: object|null, hostId: string|null, roundsTotal: number, match: object|null }> */
const rooms = new Map();

function serializeRoom(room) {
  return {
    id: room.id, createdAt: room.createdAt, maxPlayers: MAX_PLAYERS,
    hostId: room.hostId, roundsTotal: room.roundsTotal,
    players: [...room.players.values()],
  };
}
function pickEmoji(room) {
  const used = new Set([...room.players.values()].map((p) => p.emoji));
  const pool = EMOJIS.filter((e) => !used.has(e));
  return (pool.length ? pool : EMOJIS)[Math.floor(Math.random() * (pool.length ? pool.length : EMOJIS.length))];
}

// ════════════════════════ GAME HOOK — 🛡️ tank battle ═════════════════
// Server-authoritative online state. Clients render + simulate locally;
// discrete events (fire/blast/pass/collect) flow through here.
// ─────────────────────────────────────────────────────────────────────
const TURN_TIME_MS = 20000;   // per-turn timer, then auto-pass
const SETTLE_MS = 1300;       // beat after a shot resolves before next turn
const SHOT_TIMEOUT_MS = 20000;// safety: never get stuck in 'shot'
const GRAV = 850;
const BLAST_R = 58;
const SPAWN_AT = [0.15, 0.85, 0.35, 0.65, 0.25, 0.75, 0.5, 0.1];

let TERR = null;  // lib/terrain.mjs (ESM, imported dynamically below)
let BONUS = null; // lib/bonus.mjs

/** Worms wind ∈ [-1,1], biased toward useful strengths. */
function rollWind() {
  const w = Math.random() * 2 - 1;
  return Math.round(Math.sign(w) * Math.pow(Math.abs(w), 0.7) * 20) / 20;
}
function surfOf(T, x) {
  return T.surface[Math.max(0, Math.min(T.width - 1, Math.round(x)))];
}

async function createGame(room) {
  const seed = randomBytes(4).toString('hex');
  const T = await TERR.generateTerrain(seed, 1920, 1080);
  room.sim = { T }; // server-side bitmap: crate physics + destroyCircle + damage
  const players = [...room.players.values()];
  const tanks = players.map((p, i) => {
    let x = Math.round(T.width * SPAWN_AT[i % SPAWN_AT.length]);
    let guard = 0;
    while (x < T.width - 60 && guard++ < 400 && Math.abs(surfOf(T, x + 8) - surfOf(T, x - 8)) > 7) x += 12;
    return {
      id: p.id, name: p.name, emoji: p.emoji,
      x, y: surfOf(T, x), aim: x < T.width / 2 ? -0.6 : -2.54, palette: i % 6,
      hp: 100, fuel: 100, inv: { cluster: 0, guided: 0, tomahawk: 0 }, buff: 0, dead: false,
    };
  });
  return {
    phase: 'playing',
    startedAt: Date.now(),
    terrain: { seed, width: T.width, height: T.height },
    players: players.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji })),
    tanks,
    turn: { num: 1, phase: 'open', activeIdx: 0, endsAt: Date.now() + TURN_TIME_MS, settleEnd: 0, fireAt: 0 },
    wind: rollWind(),
    crates: [], dropT: 10000, crateId: 0,
    blasts: [], // replay log for late joiners/spectators (terrain craters)
    winner: null,
  };
}

/** full=true includes the blast replay log (only for a joining socket). */
function serializeGame(room, full = false) {
  const g = room.game;
  if (!g) return null;
  const out = full ? { ...g } : (({ blasts, ...rest }) => rest)(g);
  out.hostId = room.hostId;               // clients gate host-only UI on this
  out.match = room.match ? { ...room.match } : null; // round/wins scoreboard
  return out;
}

// ── Match bookkeeping: best-of-N rounds, wins per player ─────────────
/** Fresh match when a game starts from the lobby. */
function startMatch(room) {
  room.match = { round: 1, roundsTotal: room.roundsTotal, wins: {}, over: false, lastWinner: null };
}
/** Record a round result exactly once (called from every game-over path). */
function finishRound(room, winnerId) {
  const g = room.game;
  if (!g || g.turn.phase === 'over') return;
  g.turn.phase = 'over';
  g.winner = winnerId ?? null;
  const m = room.match;
  if (!m) return;
  m.lastWinner = g.winner;
  if (g.winner) m.wins[g.winner] = (m.wins[g.winner] | 0) + 1;
  if (m.round >= m.roundsTotal) m.over = true; // played all rounds → most wins takes the match
}
function broadcastGame(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit('game-state', serializeGame(room));
}

/** Rotate to the next living tank; ends the game when ≤1 remains. */
function advanceTurnServer(room) {
  const g = room.game;
  if (!g || g.turn.phase === 'over') return;
  const ts = g.tanks;
  const alive = ts.filter((t) => !t.dead);
  if (ts.length > 1 && alive.length <= 1) {
    finishRound(room, alive[0]?.id ?? null);
    broadcastGame(room.id);
    console.log(`[room ${room.id}] 🏆 round ${room.match?.round ?? 1} over — winner: ${alive[0]?.name ?? 'draw'}`);
    return;
  }
  let i = g.turn.activeIdx;
  for (let k = 0; k < ts.length; k++) { i = (i + 1) % ts.length; if (!ts[i].dead) break; }
  g.turn.activeIdx = i;
  g.turn.num += 1;
  g.turn.phase = 'open';
  g.turn.endsAt = Date.now() + TURN_TIME_MS;
  g.turn.settleEnd = 0;
  g.wind = rollWind(); // fresh wind every turn
  broadcastGame(room.id);
}

/** 10Hz authoritative sim: turn timers, supply drops, crate physics+collection. */
function tickRoom(room) {
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const now = Date.now();
  const tn = g.turn;
  if (tn.phase === 'open' && now > tn.endsAt) return advanceTurnServer(room);
  if (tn.phase === 'settle' && now > tn.settleEnd) return advanceTurnServer(room);
  if (tn.phase === 'shot' && now - tn.fireAt > SHOT_TIMEOUT_MS) return advanceTurnServer(room);

  const T = room.sim?.T;
  let dirty = false;

  // supply drops: every 24–40s, max 3 live, never within 220px of a live tank
  if (tn.phase !== 'over' && T) {
    g.dropT -= 100;
    if (g.dropT <= 0) {
      g.dropT = 24000 + Math.random() * 16000;
      if (g.crates.filter((c) => !c.taken).length < 3) {
        for (let k = 0; k < 40; k++) {
          const x = 80 + Math.random() * (T.width - 160);
          if (g.tanks.some((t) => !t.dead && Math.abs(t.x - x) < 220)) continue;
          g.crates.push({ id: g.crateId++, type: BONUS.pickDropType(), x, y: -40, vy: 0, sway: 0, landed: false, taken: false, bob: Math.random() * 6.28 });
          io.to(room.id).emit('game-event', { kind: 'drop', x });
          dirty = true;
          break;
        }
      }
    }
  }

  // crate physics @10Hz + drive-over collection (server knows all positions)
  if (T && g.crates.length) {
    for (const c of g.crates) {
      if (c.taken) continue;
      if (c.landed && surfOf(T, c.x) > c.y + 8) { c.landed = false; c.vy = 0; } // ground blown away
      if (c.landed) {
        c.y = surfOf(T, c.x);
      } else {
        c.sway += 0.1;
        c.vy = Math.min(150, c.vy + GRAV * 0.35 * 0.1);
        c.x = Math.max(40, Math.min(T.width - 40, c.x + Math.sin(c.sway * 2 + c.bob) * 14 * 0.1 + g.wind * 30 * 0.1));
        c.y += c.vy * 0.1;
        if (c.y >= surfOf(T, c.x)) {
          c.y = surfOf(T, c.x);
          c.landed = true;
          io.to(room.id).emit('game-event', { kind: 'crate-land', x: c.x, y: c.y });
        }
      }
      dirty = true;
      if (c.landed) {
        for (const t of g.tanks) {
          if (t.dead) continue;
          const ty = t.y - 16;
          if (Math.abs(t.x - c.x) > 30 || Math.abs(ty - (c.y - 14)) > 34) continue;
          c.taken = true;
          if (c.type === 'hp10' || c.type === 'hp15') t.hp = Math.min(100, t.hp + (c.type === 'hp10' ? 10 : 15));
          else if (c.type === 'x2') t.buff += 2;
          else if (c.type === 'x3') t.buff += 3;
          else t.inv[c.type] = (t.inv[c.type] | 0) + 1;
          io.to(room.id).emit('game-event', { kind: 'crate-taken', crateId: c.id, type: c.type, x: c.x, y: c.y, by: t.id });
          dirty = true;
          break;
        }
      }
    }
    const before = g.crates.length;
    g.crates = g.crates.filter((c) => !c.taken);
    if (g.crates.length !== before) dirty = true;
  }

  if (dirty) broadcastGame(room.id);
}

async function startGame(socket, payload) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room) return;
  // {dev:true} = solo/hot-seat bypass — only valid in a 1-player room, so a
  // non-host can't use it to force-start a real multiplayer game
  const dev = !!payload?.dev && room.players.size === 1;
  if (socket.id !== room.hostId && !dev) return; // 👑 only the room master starts games
  if (room.players.size < MIN_PLAYERS && !dev) return;
  if (room.game) return; // already running
  startMatch(room); // fresh match: round 1 of roundsTotal, clean scoreboard
  try {
    room.game = await createGame(room);
  } catch (err) {
    console.error(`[room ${roomId}] failed to create game:`, err);
    room.match = null;
    return;
  }
  console.log(`[room ${roomId}] 🎮 game started (${room.players.size} players, best of ${room.match.roundsTotal}${dev ? ', dev mode' : ''})`);
  io.to(roomId).emit('game-state', serializeGame(room, true));
}
function endGame(socket) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room?.game) return;
  if (socket.id !== room.hostId) return; // 👑 host only
  room.game = null;
  room.sim = null;
  room.match = null;
  console.log(`[room ${roomId}] 🏁 game ended`);
  broadcastGame(roomId); // null → clients fall back to the lobby
}
/** Advance to the next round after a finished one (host only). */
async function nextRound(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room || socket.id !== room.hostId) return; // 👑 host only
  const g = room.game, m = room.match;
  if (!g || g.turn.phase !== 'over' || !m || m.over) return;
  m.round += 1;
  m.lastWinner = null;
  try {
    room.game = await createGame(room);
  } catch (err) {
    console.error(`[room ${room.id}] next round failed:`, err);
    return;
  }
  console.log(`[room ${room.id}] ⚔️ round ${m.round}/${m.roundsTotal} — new terrain (${room.game.terrain.seed})`);
  io.to(room.id).emit('game-state', serializeGame(room, true));
}
/** Rematch after a completed match: clean scoreboard, back to round 1 (host only). */
async function newMatch(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room || socket.id !== room.hostId) return; // 👑 host only
  if (!room.game || room.game.turn.phase !== 'over' || !room.match?.over) return;
  startMatch(room);
  try {
    room.game = await createGame(room);
  } catch (err) {
    console.error(`[room ${room.id}] new match failed:`, err);
    room.match = null;
    return;
  }
  console.log(`[room ${room.id}] 🏆 new match — best of ${room.match.roundsTotal}`);
  io.to(room.id).emit('game-state', serializeGame(room, true));
}
/** Restart the current round on fresh terrain (host only); scoreboard untouched. */
async function regenTerrain(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room?.game) return;
  if (socket.id !== room.hostId) return; // 👑 host only
  try {
    room.game = await createGame(room);
  } catch (err) {
    console.error(`[room ${room.id}] regen failed:`, err);
    return;
  }
  if (room.match) room.match.lastWinner = null;
  console.log(`[room ${room.id}] 🎲 round restarted — new terrain (${room.game.terrain.seed})`);
  io.to(room.id).emit('game-state', serializeGame(room, true));
}

/** Leaving mid-game = your tank dies in place; the war goes on without you. */
function handleGameLeave(socket, room) {
  const g = room?.game;
  if (!g?.players) return;
  g.players = g.players.filter((p) => p.id !== socket.id);
  const t = g.tanks.find((tk) => tk.id === socket.id);
  if (t && !t.dead) {
    t.dead = true; t.hp = 0;
    const alive = g.tanks.filter((tk) => !tk.dead);
    if (g.tanks.length > 1 && alive.length <= 1) {
      finishRound(room, alive[0]?.id ?? null);
    } else if (g.tanks[g.turn.activeIdx]?.id === socket.id && g.turn.phase !== 'over') {
      advanceTurnServer(room); // was their turn — move on
    }
  }
  if (g.players.length === 0) { room.game = null; room.sim = null; }
  else broadcastGame(room.id);
}
// ═══════════════════════ END GAME HOOK ═══════════════════════════════

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) { socket.leave(roomId); socket.data.roomId = null; return; }
  handleGameLeave(socket, room); // must run before socket.data.roomId is cleared
  socket.leave(roomId);
  socket.data.roomId = null;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(roomId);
    console.log(`[room ${roomId}] empty — deleted`);
  } else {
    // host left → crown the longest-standing survivor (Map keeps join order)
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value ?? null;
      console.log(`[room ${roomId}] 👑 host transferred to ${room.players.get(room.hostId)?.name}`);
    }
    io.to(roomId).emit('room-state', serializeRoom(room));
  }
}

let io;

app.prepare().then(async () => {
  // game libs are pure ESM (shared with the client bundle) — dynamic import
  TERR = await import('./lib/terrain.mjs');
  BONUS = await import('./lib/bonus.mjs');

  const httpServer = createServer((req, res) => handle(req, res));

  // Next dev HMR uses its own websocket on /_next/* — forward those upgrades
  const upgradeHandler = typeof app.getUpgradeHandler === 'function' ? app.getUpgradeHandler() : null;
  if (upgradeHandler) {
    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url && req.url.startsWith('/_next/')) upgradeHandler(req, socket, head);
    });
  }

  io = new Server(httpServer, { destroyUpgrade: false });

  io.on('connection', (socket) => {
    socket.on('join-room', (payload, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        const roomId = String(payload?.roomId || '').toLowerCase();
        const name = String(payload?.name || '').trim().slice(0, 20);
        if (!ROOM_ID_RE.test(roomId)) return reply({ ok: false, error: 'Invalid room link.' });
        if (!name) return reply({ ok: false, error: 'Name is required.' });

        // idempotent re-join (same socket re-joining the same room)
        if (socket.data.roomId === roomId && rooms.get(roomId)?.players.has(socket.id)) {
          const room = rooms.get(roomId);
          reply({ ok: true, you: room.players.get(socket.id), room: serializeRoom(room) });
          socket.emit('game-state', serializeGame(room, true));
          return;
        }
        leaveCurrentRoom(socket);

        let room = rooms.get(roomId);
        if (!room) {
          room = { id: roomId, createdAt: Date.now(), players: new Map(), game: null, sim: null, hostId: null, roundsTotal: 1, match: null };
          rooms.set(roomId, room);
          console.log(`[room ${roomId}] created`);
        }
        if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: `Room is full (${MAX_PLAYERS} players max).` });

        const player = { id: socket.id, name, emoji: pickEmoji(room), joinedAt: Date.now() };
        room.players.set(socket.id, player);
        if (!room.hostId) room.hostId = socket.id; // first joiner is the room master 👑
        socket.data.roomId = roomId;
        socket.join(roomId);
        console.log(`[room ${roomId}] ${name} joined (${room.players.size} players)`);

        reply({ ok: true, you: player, room: serializeRoom(room) });
        io.to(roomId).emit('room-state', serializeRoom(room));
        socket.emit('game-state', serializeGame(room, true)); // null in lobby; full state (incl. blast log) for late joiners / spectators
      } catch (err) {
        console.error(err);
        reply({ ok: false, error: 'Server error.' });
      }
    });

    socket.on('start-game', (payload) => startGame(socket, payload));
    socket.on('end-game', () => endGame(socket));
    socket.on('regen-terrain', () => regenTerrain(socket));
    socket.on('next-round', () => nextRound(socket));
    socket.on('new-match', () => newMatch(socket));
    // 👑 host picks the match length in the lobby (1/3/5/7/9 rounds)
    socket.on('set-rounds', (n) => {
      const room = rooms.get(socket.data.roomId);
      if (!room || socket.id !== room.hostId || room.game) return;
      const v = Math.round(Number(n));
      if (![1, 3, 5, 7, 9].includes(v)) return;
      if (room.roundsTotal === v) return;
      room.roundsTotal = v;
      console.log(`[room ${room.id}] 🎯 match length set: best of ${v}`);
      io.to(room.id).emit('room-state', serializeRoom(room));
    });

    // ── 🛡️ tank battle events ──
    // active player passes their turn early (Enter)
    socket.on('pass-turn', () => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g) return;
      const me = g.tanks[g.turn.activeIdx];
      if (me?.id === socket.id && g.turn.phase === 'open') advanceTurnServer(room);
    });
    // active player streams their tank (position/aim) ~12Hz; relayed volatile
    socket.on('tank-move', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g) return;
      const t = g.tanks.find((tk) => tk.id === socket.id);
      if (!t || t.dead) return;
      if (typeof p?.x === 'number' && isFinite(p.x)) t.x = Math.max(0, Math.min(g.terrain.width, p.x));
      if (typeof p?.y === 'number' && isFinite(p.y)) t.y = Math.max(-60, Math.min(g.terrain.height + 80, p.y));
      if (typeof p?.aim === 'number' && isFinite(p.aim)) t.aim = p.aim;
      socket.to(room.id).volatile.emit('tank-move', { id: t.id, x: t.x, y: t.y, aim: t.aim, s: typeof p?.s === 'number' ? p.s : 0 });
    });
    // active player fires — validate turn/phase/stock, consume, relay the shot
    socket.on('fire', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g) return;
      const tn = g.turn;
      const me = g.tanks[tn.activeIdx];
      if (!me || me.id !== socket.id || me.dead || tn.phase !== 'open') return;
      let kind = ['cluster', 'guided', 'tomahawk'].includes(p?.kind) ? p.kind : 'normal';
      if (kind !== 'normal') {
        if ((me.inv[kind] | 0) <= 0) kind = 'normal';
        else me.inv[kind]--;
      }
      let dmgScale = 1;
      if ((me.buff | 0) > 0) { me.buff--; dmgScale = 2; }
      tn.phase = 'shot';
      tn.fireAt = Date.now();
      const a = Number(p?.a) || 0;
      const pw = Math.max(0.06, Math.min(1, Number(p?.p) || 0.06));
      io.to(room.id).emit('fire', { id: me.id, a, p: pw, kind, dmgScale });
      broadcastGame(room.id);
    });
    // shooter reports an impact — server applies it to the bitmap, computes
    // authoritative damage from last-known positions, relays to everyone
    socket.on('blast', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g || !room.sim?.T) return;
      const tn = g.turn;
      const me = g.tanks[tn.activeIdx];
      if (!me || me.id !== socket.id || (tn.phase !== 'shot' && tn.phase !== 'settle')) return;
      const x = Number(p?.x), y = Number(p?.y);
      if (!isFinite(x) || !isFinite(y)) return;
      const r = Math.min(200, Math.max(8, Number(p?.r) || BLAST_R));
      const scale = Math.min(6, Math.max(0.1, Number(p?.scale) || 1));
      const big = !!p?.big;
      const T = room.sim.T;
      TERR.destroyCircle(T, x, y, r);
      TERR.cleanDebris(T, x, y, r + 16);
      TERR.removeFloaters(T, x, y, r + 190);
      TERR.reflowSky(T, x, y, r + 16);
      g.blasts.push({ x: Math.round(x), y: Math.round(y), r });
      if (g.blasts.length > 400) g.blasts.splice(0, g.blasts.length - 400);
      // crates caught in the blast are destroyed (denial play)
      for (const c of g.crates) {
        if (c.taken) continue;
        if (Math.hypot(c.x - x, (c.landed ? c.y - 14 : c.y) - y) < r + 18) {
          c.taken = true;
          io.to(room.id).emit('game-event', { kind: 'crate-boom', x: c.x, y: c.landed ? c.y - 14 : c.y });
        }
      }
      g.crates = g.crates.filter((c) => !c.taken);
      // authoritative damage (mirrors the client formula)
      const range = r + 34;
      const dmg = [];
      for (const t of g.tanks) {
        if (t.dead) continue;
        const d = Math.hypot(t.x - x, (t.y - 18) - y);
        if (d >= range) continue;
        const direct = d < 30;
        const dd = direct ? Math.round(50 * scale) : Math.max(2, Math.round(46 * scale * (1 - d / range)));
        t.hp = Math.max(0, t.hp - dd);
        if (t.hp <= 0) t.dead = true;
        dmg.push({ id: t.id, hp: t.hp, d: dd, direct, dead: t.dead });
      }
      const alive = g.tanks.filter((t) => !t.dead);
      if (g.tanks.length > 1 && alive.length <= 1) finishRound(room, alive[0]?.id ?? null);
      io.to(room.id).emit('blast', { x, y, r, scale, big, dmg });
      broadcastGame(room.id);
    });
    // shooter: all shells resolved → brief settle → next turn
    socket.on('shot-done', () => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g) return;
      const tn = g.turn;
      const me = g.tanks[tn.activeIdx];
      if (!me || me.id !== socket.id || tn.phase !== 'shot') return;
      tn.phase = 'settle';
      tn.settleEnd = Date.now() + SETTLE_MS;
      broadcastGame(room.id);
    });

    socket.on('leave-room', () => leaveCurrentRoom(socket));
    socket.on('disconnect', () => leaveCurrentRoom(socket));
  });

  // authoritative tick: turn timers, supply drops, crate physics/collection
  setInterval(() => {
    for (const room of rooms.values()) {
      try { tickRoom(room); } catch (err) { console.error(`[room ${room.id}] tick error:`, err); }
    }
  }, 100);

  httpServer.listen(port, hostname, () => {
    console.log(`▲ ready on http://localhost:${port} (bound to ${hostname})`);
  });
});
