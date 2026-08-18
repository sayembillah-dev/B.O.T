// ════════════════════════════════════════════════════════════════════
//  🛡️ B.O.T — battle of tanks · server (Next.js + Socket.IO in one process)
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

/** rooms: Map<roomId, { id, createdAt, players: Map<socketId, player>, game: object|null, sim: object|null, hostId: string|null, roundsTotal: number, match: object|null, mode: 'classic'|'chaos' }> */
const rooms = new Map();

function serializeRoom(room) {
  return {
    id: room.id, createdAt: room.createdAt, maxPlayers: MAX_PLAYERS,
    hostId: room.hostId, roundsTotal: room.roundsTotal, mode: room.mode,
    players: [...room.players.values()],
  };
}
function pickEmoji(room) {
  const used = new Set([...room.players.values()].map((p) => p.emoji));
  const pool = EMOJIS.filter((e) => !used.has(e));
  return (pool.length ? pool : EMOJIS)[Math.floor(Math.random() * (pool.length ? pool.length : EMOJIS.length))];
}

// ═════════════════ GAME HOOK — 🛡️ B.O.T - battle of tanks ═════════════════
// Server-authoritative online state. Clients render + simulate locally;
// discrete events (fire/blast/pass/collect) flow through here.
// ─────────────────────────────────────────────────────────────────────
const TURN_TIME_MS = 20000;   // per-turn timer, then auto-pass
const SETTLE_MS = 1300;       // beat after a shot resolves before next turn
const SHOT_TIMEOUT_MS = 20000;// safety: never get stuck in 'shot'
const GRAV = 850;
const BLAST_R = 58;
const CRATE_TTL_MS = 60000;   // ⏳ landed supply crates disappear after 1 minute
const FORCE_DROP = process.env.FORCE_DROP || null; // 🧪 tests/dev: pin every crate to one type
// ⚡ CHAOS mode — real-time free-for-all: no turns, everyone drives and shoots
// at once. Infinite normal shells behind a 1s per-tank reload, dead tanks
// respawn in 5s — one 3:00 match clock: MOST DAMAGE DEALT wins.
const CHAOS_DURATION_MS = Number(process.env.CHAOS_DURATION_MS || 180000); // 3:00 match clock
const CHAOS_COOLDOWN_MS = Number(process.env.CHAOS_COOLDOWN_MS || 1000);   // per-tank reload
const CHAOS_RESPAWN_MS = Number(process.env.CHAOS_RESPAWN_MS || 5000);     // dead tank → back in 5s
const CHAOS_WIND_MS = Number(process.env.CHAOS_WIND_MS || 18000);          // wind re-roll (no turns)
const CHAOS_GHOST_MS = 12000; // a dead tank's in-flight shells may still land
const CHAOS_GRACE_MS = 8000;  // terrain-gen + countdown runway before the clock truly bites
// ⚖️ fair spawns — N players get N evenly-spaced slots, symmetric about the map
// centre: nobody starts with more map (or fewer neighbours) than anyone else
const spawnSlots = (n) => Array.from({ length: n }, (_, i) =>
  n === 1 ? 0.5 : 0.12 + (i * 0.76) / (n - 1));

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
/** Find a parking spot near the ideal slot: walk outward BOTH ways for ground
 *  that is reasonably flat, dry, and ≥90px from every already-placed tank.
 *  Moderate slopes are fine (tanks tilt + handbrake); an overlap never is.
 *  Last resort: the ideal slot itself, clamped in-bounds. */
function findSpawn(T, ideal, placed, maxR) {
  const ok = (x) =>
    x >= 40 && x <= T.width - 40 &&
    Math.abs(surfOf(T, x + 8) - surfOf(T, x - 8)) <= 20 && // ~51° max — tanks handle slopes
    surfOf(T, x) <= T.waterY - 40 &&                       // dry
    placed.every((px) => Math.abs(px - x) >= 90);          // never on top of a teammate
  for (let d = 0; d <= maxR; d += 12) {
    if (ok(ideal + d)) return ideal + d;
    if (d && ok(ideal - d)) return ideal - d;
  }
  return Math.max(40, Math.min(T.width - 40, ideal));
}

async function createGame(room) {
  const seed = randomBytes(4).toString('hex');
  const mode = room.mode === 'chaos' ? 'chaos' : 'classic';
  const dims = TERR.terrainDims(room.players.size || 2); // ⚖️ more players → bigger battlefield
  const T = await TERR.generateTerrain(seed, dims.width, dims.height);
  room.sim = { T }; // server-side bitmap: crate physics + destroyCircle + damage
  const players = [...room.players.values()];
  const slots = spawnSlots(players.length); // ⚖️ equal, symmetric positions for all
  // 🎲 shuffled assignment — which player parks in which slot is re-rolled every
  //    round, so spawn position NEVER follows the join order
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const placed = [];
  const slotGap = players.length > 1 ? T.width * 0.76 / (players.length - 1) : T.width;
  const tanks = players.map((p, i) => {
    const x = findSpawn(T, Math.round(T.width * slots[i]), placed, Math.max(0, slotGap / 2 - 100));
    placed.push(x);
    return {
      id: p.id, name: p.name, emoji: p.emoji,
      x, y: mode === 'chaos' ? -60 : surfOf(T, x), // 🪂 chaos drops in by parachute
      para: mode === 'chaos',
      aim: x < T.width / 2 ? -0.6 : -2.54, palette: i % 6,
      hp: 100, fuel: 100, power: 0.5, tele: false, inv: { cluster: 0, guided: 0, tomahawk: 0 }, buff: 0, dead: false,
      cdAt: 0,   // ⚡ chaos reload bookkeeping
      dmg: 0,    // ⚡ chaos scoreboard — total damage dealt to OTHERS (the win metric)
      deadAt: 0, // ⚡ chaos respawn timer (0 = alive / never died)
      shieldUntil: 0, // 🛡️ chaos shield pickup — invulnerable until this stamp
    };
  });
  const now = Date.now();
  const g = {
    phase: 'playing',
    startedAt: now,
    mode,
    terrain: { seed, width: T.width, height: T.height },
    players: players.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji })),
    tanks,
    turn: { num: 1, phase: 'open', activeIdx: 0, endsAt: now + TURN_TIME_MS, settleEnd: 0, fireAt: 0 },
    wind: rollWind(),
    crates: [], dropT: mode === 'chaos' ? 5000 : 10000, crateId: 0, // ⚡ chaos: drops come early…
    blasts: [], // replay log for late joiners/spectators (terrain craters)
    winner: null,
  };
  if (mode === 'chaos') {
    g.dur = CHAOS_DURATION_MS;
    g.endsAt = now + CHAOS_DURATION_MS + CHAOS_GRACE_MS; // ⏳ sudden-death match clock (+ gen runway)
    g.turn.endsAt = g.endsAt;           // clients mirror this as the clock
    g.windT = CHAOS_WIND_MS;
  }
  return g;
}

/** full=true includes the blast replay log (only for a joining socket). */
function serializeGame(room, full = false) {
  const g = room.game;
  if (!g) return null;
  const out = full ? { ...g } : (({ blasts, ...rest }) => rest)(g);
  // 🎁 mystery crates: classic never broadcasts the contents (revealed on
  //    pickup/expiry) — ⚡ chaos crates are UNCOVERED: type rides along
  if (out.crates && g.mode !== 'chaos') out.crates = out.crates.map(({ type, ...pub }) => pub);
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

/** ⚡ chaos time-out: the match clock hit 0:00 — MOST DAMAGE DEALT wins
 *  (exact top-tie = draw). Even a tank that's mid-respawn can take it:
 *  damage is the score, survival just keeps you dealing it. */
function endChaosByScore(room) {
  const g = room.game;
  if (!g || g.turn.phase === 'over') return;
  let top = null, tie = false;
  for (const t of g.tanks) {
    if (!top || (t.dmg | 0) > (top.dmg | 0)) { top = t; tie = false; }
    else if ((t.dmg | 0) === (top.dmg | 0)) tie = true;
  }
  const winnerId = top && !tie && (top.dmg | 0) > 0 ? top.id : null;
  finishRound(room, winnerId);
  broadcastGame(room.id);
  console.log(`[room ${room.id}] ⏱ chaos time! round ${room.match?.round ?? 1} over — winner: ${winnerId ? `${top.name} (${top.dmg | 0} dmg)` : 'draw'}`);
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
  if (g.mode === 'chaos') return; // ⚡ chaos has no turns to rotate
  const prev = g.tanks[g.turn.activeIdx];
  if (prev?.tele) { // 🌀 teleport not used in time — the turn eats it
    prev.tele = false;
    io.to(room.id).emit('game-event', { kind: 'tele-fizzle', id: prev.id, x: prev.x, y: prev.y });
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
  if (tn.phase !== 'over') {
    if (g.mode === 'chaos') {
      if (now > g.endsAt) return endChaosByScore(room); // ⏳ 0:00 — most HP wins
    } else {
      if (tn.phase === 'open' && now > tn.endsAt) return advanceTurnServer(room);
      if (tn.phase === 'settle' && now > tn.settleEnd) return advanceTurnServer(room);
      if (tn.phase === 'shot' && now - tn.fireAt > SHOT_TIMEOUT_MS) return advanceTurnServer(room);
    }
  }

  const T = room.sim?.T;
  let dirty = false;

  // ⚡ chaos: no turns, so wind re-rolls on a wall-clock timer instead
  if (g.mode === 'chaos' && tn.phase !== 'over') {
    g.windT = (g.windT ?? CHAOS_WIND_MS) - 100;
    if (g.windT <= 0) { g.windT = CHAOS_WIND_MS; g.wind = rollWind(); dirty = true; }
  }

  // ⚡ chaos respawns: a dead tank is back after CHAOS_RESPAWN_MS at a fresh
  // random spot with full HP + fuel — death is a timeout, not an elimination
  if (g.mode === 'chaos' && tn.phase !== 'over' && T) {
    for (const t of g.tanks) {
      if (!t.dead || !t.deadAt || now - t.deadAt < CHAOS_RESPAWN_MS) continue;
      const placed = g.tanks.filter((o) => o !== t && !o.dead).map((o) => o.x);
      const x = findSpawn(T, 60 + Math.floor(Math.random() * (T.width - 120)), placed, T.width / 2);
      t.x = x; t.y = -60; t.para = true; // 🪂 ride the chute down to the fresh spot
      t.aim = x < T.width / 2 ? -0.6 : -2.54;
      t.hp = 100; t.fuel = 100; t.dead = false; t.deadAt = 0; t.cdAt = 0;
      io.to(room.id).emit('game-event', { kind: 'respawn', id: t.id, x: t.x, y: t.y });
      dirty = true;
    }
  }

  // supply drops: every 24–40s, max 3 live, placed FAIRLY (equidistant-ish from all)
  if (tn.phase !== 'over' && T) {
    g.dropT -= 100;
    if (g.dropT <= 0) {
      // ⚡ chaos: …and often — a 3-minute brawl wants a steady supply rain
      g.dropT = g.mode === 'chaos' ? 7000 + Math.random() * 5000 : 24000 + Math.random() * 16000;
      if (g.crates.filter((c) => !c.taken).length < (g.mode === 'chaos' ? 5 : 3)) {
        // ⚖️ fair drop: sample candidate spots, keep the one that maximizes the
        // distance to the NEAREST live tank — equal opportunity for everyone
        const aliveTanks = g.tanks.filter((t) => !t.dead);
        let bx = null, bScore = -1;
        for (let k = 0; k < 28; k++) {
          const x = 80 + Math.random() * (T.width - 160);
          const nearest = aliveTanks.length ? Math.min(...aliveTanks.map((t) => Math.abs(t.x - x))) : Infinity;
          const score = Math.min(nearest, 400); // past ~400px, extra distance stops mattering
          if (score > bScore) { bScore = score; bx = x; }
        }
        if (bx != null) {
          g.crates.push({ id: g.crateId++, type: FORCE_DROP || BONUS.pickDropType(Math.random, g.mode === 'chaos'), x: bx, y: -40, vy: 0, sway: 0, landed: false, taken: false, bob: Math.random() * 6.28, expiresAt: 0 });
          io.to(room.id).emit('game-event', { kind: 'drop', x: bx });
          dirty = true;
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
        if (!c.expiresAt) c.expiresAt = now + CRATE_TTL_MS; // ⏳ 1 minute on the ground, then gone
        if (now > c.expiresAt) {
          c.taken = true;
          io.to(room.id).emit('game-event', { kind: 'crate-expire', type: c.type, x: c.x, y: c.y - 14 }); // 🎁 reveal what was lost
          continue;
        }
      } else {
        c.sway += 0.1;
        c.vy = Math.min(150, c.vy + GRAV * 0.35 * 0.1);
        c.x = Math.max(40, Math.min(T.width - 40, c.x + Math.sin(c.sway * 2 + c.bob) * 14 * 0.1 + g.wind * 30 * 0.1));
        c.y += c.vy * 0.1;
        if (c.y >= surfOf(T, c.x)) {
          c.y = surfOf(T, c.x);
          c.landed = true;
          c.expiresAt = now + CRATE_TTL_MS;
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
          else if (c.type === 'teleport') t.tele = true; // 🌀 pending — use it this turn or lose it
          else if (c.type === 'shield') t.shieldUntil = now + 10000; // 🛡️ 10s of invulnerability
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
  console.log(`[room ${roomId}] 🎮 game started (${room.players.size} players, ${room.game.mode}${room.game.mode === 'chaos' ? ` ${Math.round(room.game.dur / 1000)}s clock` : `best of ${room.match.roundsTotal}`}${dev ? ', dev mode' : ''})`);
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
    t.dead = true; t.hp = 0; // ⚡ chaos: no deadAt → leavers never respawn
    if (g.mode === 'chaos') {
      // ⚡ no eliminations in chaos — but if nobody's left to fight, score it now
      if (g.players.length <= 1) endChaosByScore(room);
    } else {
      const alive = g.tanks.filter((tk) => !tk.dead);
      if (g.tanks.length > 1 && alive.length <= 1) {
        finishRound(room, alive[0]?.id ?? null);
      } else if (g.tanks[g.turn.activeIdx]?.id === socket.id && g.turn.phase !== 'over') {
        advanceTurnServer(room); // was their turn — move on
      }
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
    // host left → crown the longest-standing survivor (Map keeps join order) as
    // CARETAKER — the crown returns to the creator (hostCid) when they rejoin
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value ?? null;
      console.log(`[room ${roomId}] 👑 host transferred to ${room.players.get(room.hostId)?.name} (caretaker)`);
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
          room = { id: roomId, createdAt: Date.now(), players: new Map(), game: null, sim: null, hostId: null, hostCid: null, roundsTotal: 1, match: null, mode: 'classic' };
          rooms.set(roomId, room);
          console.log(`[room ${roomId}] created`);
        }
        if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: `Room is full (${MAX_PLAYERS} players max).` });

        const cid = String(payload?.cid || '').slice(0, 64) || null; // stable per-tab identity
        const player = { id: socket.id, name, emoji: pickEmoji(room), joinedAt: Date.now(), cid };
        room.players.set(socket.id, player);
        if (!room.hostId) room.hostId = socket.id; // first joiner is the room master 👑
        if (!room.hostCid && cid && room.hostId === socket.id) room.hostCid = cid; // remember the creator's identity — set once
        if (cid && room.hostCid === cid && room.hostId !== socket.id) { // 👑 the crown ALWAYS returns to the creator
          room.hostId = socket.id; //        on (re)join — reloads/reconnects never switch the master
          console.log(`[room ${roomId}] 👑 crown returned to creator ${name}`);
        }
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

    // 👑 host picks the game mode in the lobby: ⚔️ classic turns or ⚡ chaos FFA
    socket.on('set-mode', (m) => {
      const room = rooms.get(socket.data.roomId);
      if (!room || socket.id !== room.hostId || room.game) return;
      const v = m === 'chaos' ? 'chaos' : 'classic';
      if (room.mode === v) return;
      room.mode = v;
      console.log(`[room ${room.id}] 🎮 mode set: ${v}`);
      io.to(room.id).emit('room-state', serializeRoom(room));
    });

    // ── 🛡️ tank battle events ──
    // active player passes their turn early (Enter) — classic mode only
    socket.on('pass-turn', () => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g || g.mode === 'chaos') return;
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
      // 👀 shared intel: everyone sees everyone's fuel gauge + the active player's aim power
      if (typeof p?.fuel === 'number' && isFinite(p.fuel)) t.fuel = Math.max(0, Math.min(100, p.fuel));
      if (typeof p?.p === 'number' && isFinite(p.p)) t.power = Math.max(0, Math.min(1, p.p));
      if (typeof p?.para === 'boolean') t.para = p.para; // 🪂 owner reports touchdown (chute stowed)
      if (process.env.STEER_DEBUG) console.log('tm', JSON.stringify({ n: t.name, x: Math.round(t.x), y: Math.round(t.y), para: t.para === true, t: Date.now() % 100000 }));
      socket.to(room.id).volatile.emit('tank-move', {
        id: t.id, x: t.x, y: t.y, aim: t.aim, s: typeof p?.s === 'number' ? p.s : 0,
        fuel: t.fuel, p: t.power ?? 0.5, para: t.para === true,
      });
    });
    // 🌀 teleport: spend a pending teleport to land at x (classic: this turn
    //    only, active tank; chaos: any live owner, any time before it's used)
    socket.on('teleport', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      const T = room?.sim?.T; // full bitmap (surface/waterY) — g.terrain is just a descriptor
      if (!g || !T) return;
      const tn = g.turn;
      const chaos = g.mode === 'chaos';
      const me = chaos ? g.tanks.find((tk) => tk.id === socket.id) : g.tanks[tn.activeIdx];
      if (!me || me.dead || tn.phase === 'over' || !me.tele) return;
      if (!chaos && (me.id !== socket.id || tn.phase !== 'open')) return;
      const x = Math.max(30, Math.min(T.width - 30, Math.round(Number(p?.x) || 0)));
      const y = surfOf(T, x);
      if (y > T.waterY - 6) return; // no watery graves — pick dry land
      me.tele = false;
      me.x = x; me.y = y;
      io.to(room.id).emit('game-event', { kind: 'teleport', id: me.id, x, y });
      broadcastGame(room.id);
    });
    // fire — classic: the active player, turn ends; chaos: ANY living tank,
    // infinite shells behind a per-tank 1s reload, match keeps rolling
    socket.on('fire', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g) return;
      const tn = g.turn;
      const chaos = g.mode === 'chaos';
      const me = chaos ? g.tanks.find((tk) => tk.id === socket.id) : g.tanks[tn.activeIdx];
      if (!me || me.dead || tn.phase === 'over') return;
      if (!chaos && (me.id !== socket.id || tn.phase !== 'open')) return;
      if (chaos) { // ⚡ reload gate — server is the referee
        const nowF = Date.now();
        if (nowF - (me.cdAt || 0) < CHAOS_COOLDOWN_MS) return;
        me.cdAt = nowF;
      }
      let kind = ['cluster', 'guided', 'tomahawk'].includes(p?.kind) ? p.kind : 'normal';
      if (kind !== 'normal') {
        if ((me.inv[kind] | 0) <= 0) kind = 'normal';
        else me.inv[kind]--;
      }
      let dmgScale = 1;
      if ((me.buff | 0) > 0) { me.buff--; dmgScale = 2; }
      if (!chaos) { tn.phase = 'shot'; tn.fireAt = Date.now(); }
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
      const chaos = g.mode === 'chaos';
      const me = chaos ? g.tanks.find((tk) => tk.id === socket.id) : g.tanks[tn.activeIdx];
      if (!me || tn.phase === 'over') return;
      if (!chaos && (me.id !== socket.id || (tn.phase !== 'shot' && tn.phase !== 'settle'))) return;
      // ⚡ chaos: a shell you fired while alive may land after you die — allow a
      //    short ghost window so the shared terrain/damage stays consistent
      if (chaos && me.dead && Date.now() - (me.cdAt || 0) > CHAOS_GHOST_MS) return;
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
        // 🛡️ shielded tanks take nothing — report a 0-damage block instead
        if (chaos && t.shieldUntil && Date.now() < t.shieldUntil) {
          dmg.push({ id: t.id, hp: t.hp, d: 0, direct: false, dead: false });
          continue;
        }
        const d = Math.hypot(t.x - x, (t.y - 18) - y);
        if (d >= range) continue;
        const direct = d < 30;
        const dd = direct ? Math.round(50 * scale) : Math.max(2, Math.round(46 * scale * (1 - d / range)));
        t.hp = Math.max(0, t.hp - dd);
        if (t.hp <= 0) { t.dead = true; if (chaos) t.deadAt = Date.now(); } // ⚡ chaos: respawn timer starts
        dmg.push({ id: t.id, hp: t.hp, d: dd, direct, dead: t.dead });
      }
      // ⚡ chaos scoreboard: damage dealt to OTHERS is the win metric
      if (chaos) me.dmg = (me.dmg | 0) + dmg.reduce((s, d) => (d.id === me.id ? s : s + d.d), 0);
      const alive = g.tanks.filter((t) => !t.dead);
      // ⚡ chaos never ends on a wipeout — respawns keep the match rolling
      if (!chaos && g.tanks.length > 1 && alive.length <= 1) finishRound(room, alive[0]?.id ?? null);
      io.to(room.id).emit('blast', { x, y, r, scale, big, dmg });
      broadcastGame(room.id);
    });
    // shooter: all shells resolved → brief settle → next turn (classic only)
    socket.on('shot-done', () => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g || g.mode === 'chaos') return;
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
