// ════════════════════════════════════════════════════════════════════
//  🛡️ B.O.T - battle of tanks · server (Next.js + Socket.IO in one process)
//  Room state lives in memory. The server is AUTHORITATIVE for online
//  games: terrain seed + bitmap, tank spawns, HP/inventory/buffs, turn
//  rotation + 20s timer, wind, supply-drop schedule + crate physics,
//  blast application (destroyCircle) and damage. Clients simulate
//  physics locally for feel; the active player streams their tank and
//  reports shot impacts; the server validates, applies, broadcasts.
//
//  Solo dev (?solo=1) / hot-seat (?local=N) games run client-side only -
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

// 🧯 last-resort containment: every room and every player rides this ONE event
//    loop, so no uncaught throw (a malformed socket message, a bug in a game
//    handler) may ever be allowed to kill the process. Log loudly, keep serving.
process.on('uncaughtException', (err) => console.error('🧯 uncaughtException (server kept alive):', err));
process.on('unhandledRejection', (err) => console.error('🧯 unhandledRejection (server kept alive):', err));

// ── Room config ───────────────────────────────────────────────────────
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2; // online games need 2+ - solo/hot-seat bypass with {dev:true}
const EMOJIS = ['😀','😎','🤖','👾','🐸','🦊','🐼','🐯','🦁','🐙','🦄','🐲','👻','💀','🤠','😺','🙉','🦖','🍕','⚡','🔥','🌵','🥷','🧙'];
const ROOM_ID_RE = /^[a-z0-9]{4,24}$/;

/** rooms: Map<roomId, { id, createdAt, players: Map<socketId, player>, game: object|null, sim: object|null, hostId: string|null, roundsTotal: number, match: object|null, mode: 'classic'|'chaos' }> */
const rooms = new Map();

// 📈 ops telemetry (opt-in): MEMLOG_MS=5000 logs heap/rss every 5s. Cheap leak
//    hunting on hosts that OOM silently - heapUsed climbing without ever
//    falling back means something is retaining, and the phase it climbs in
//    (lobby / playing / post-game idle) narrows the suspect list.
if (process.env.MEMLOG_MS) {
  const mb = (n) => Math.round(n / 1048576);
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(`📈 mem heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB rss=${mb(m.rss)}MB ext=${mb(m.external)}MB rooms=${rooms.size}`);
  }, Math.max(1000, Number(process.env.MEMLOG_MS) || 5000)).unref();
}

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

// ═════════════════ GAME HOOK - 🛡️ B.O.T - battle of tanks ═════════════════
// Server-authoritative online state. Clients render + simulate locally;
// discrete events (fire/blast/pass/collect) flow through here.
// ─────────────────────────────────────────────────────────────────────
const TURN_TIME_MS = 20000;   // per-turn timer, then auto-pass
const SETTLE_MS = 1300;       // beat after a shot resolves before next turn
const SHOT_TIMEOUT_MS = 6000; // safety: never get stuck in 'shot' (a backgrounded shooter's rAF stops, so shot-done never arrives - keep the freeze short)
const LEAVE_GRACE_MS = Number(process.env.LEAVE_GRACE_MS || 10000); // 🔌 disconnect ≠ death: a dropped socket gets this long to rejoin and reclaim its tank before it dies in place
const GRAV = 850;
const BLAST_R = 58;
const CRATE_TTL_MS = 60000;   // ⏳ landed supply crates disappear after 1 minute
const START_GRACE_MS = 4000;  // 🎬 turn-1 runway: clients freeze their clock during "3,2,1,FIGHT!" - the server must too
const FORCE_DROP = process.env.FORCE_DROP || null; // 🧪 tests/dev: pin every crate to one type
// ⚡ CHAOS mode - real-time free-for-all: no turns, everyone drives and shoots
// at once. Infinite normal shells behind a 1s per-tank reload, dead tanks
// respawn in 5s - one 3:00 match clock: MOST DAMAGE DEALT wins.
const CHAOS_DURATION_MS = Number(process.env.CHAOS_DURATION_MS || 180000); // 3:00 match clock
const CHAOS_COOLDOWN_MS = Number(process.env.CHAOS_COOLDOWN_MS || 1000);   // per-tank reload
const CHAOS_RESPAWN_MS = Number(process.env.CHAOS_RESPAWN_MS || 5000);     // dead tank → back in 5s
const CHAOS_WIND_MS = Number(process.env.CHAOS_WIND_MS || 18000);          // wind re-roll (no turns)
const CHAOS_GHOST_MS = 12000; // a dead tank's in-flight shells may still land
const CHAOS_GRACE_MS = 8000;  // terrain-gen + countdown runway before the clock truly bites
const PARA_MAX_MS = Number(process.env.PARA_MAX_MS || 9000); // 🪂 hard deadline on a chute (full drop ≈ 5.7s) - catches a stalled/hostile client streaming para forever
const CHAOS_FIRE_GRACE_MS = Number(process.env.CHAOS_FIRE_GRACE_MS || 3400); // 🎬 no fire during the client's "3,2,1" (3.6s from state receipt, 200ms slack) - crafted-client pre-fires get nacked
// ⚖️ fair spawns - N players get N evenly-spaced slots, symmetric about the map
// centre: nobody starts with more map (or fewer neighbours) than anyone else
const spawnSlots = (n) => Array.from({ length: n }, (_, i) =>
  n === 1 ? 0.5 : 0.12 + (i * 0.76) / (n - 1));

let TERR = null;  // lib/terrain.mjs (ESM, imported dynamically below)
let BONUS = null; // lib/bonus.mjs
let AI = null;    // lib/ai.mjs - 🤖 turn-based CPU opponents (vs-AI games)

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
    Math.abs(surfOf(T, x + 8) - surfOf(T, x - 8)) <= 20 && // ~51° max - tanks handle slopes
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
  // 🤖 vs-AI: synthetic CPU players ride along in the game roster (not in
  // room.players - they have no socket). Stable ids keep match wins sane.
  const bots = (room.aiBots ?? []).map((b, i) => ({
    id: `ai-${b.difficulty}-${i}`,
    name: `CPU · ${AI?.DIFFS?.[b.difficulty]?.label ?? b.difficulty}`,
    emoji: '🤖', ai: b.difficulty,
  }));
  const dims = TERR.terrainDims(room.players.size + bots.length || 2); // ⚖️ more players → bigger battlefield
  const T = await TERR.generateTerrain(seed, dims.width, dims.height);
  room.sim = { T }; // server-side bitmap: crate physics + destroyCircle + damage
  room.aiRt = new Map(); // 🤖 per-turn bot runtime (think/drive/aim/shells)
  const players = [...room.players.values(), ...bots];
  const slots = spawnSlots(players.length); // ⚖️ equal, symmetric positions for all
  // 🎲 shuffled assignment - which player parks in which slot is re-rolled every
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
      id: p.id, name: p.name, emoji: p.emoji, ai: p.ai ?? null, // 🤖 CPU difficulty tag
      cid: p.cid ?? null, // 🔌 stable per-tab identity - lets a reconnecting socket reclaim THIS tank
      x, y: mode === 'chaos' ? -60 : surfOf(T, x), // 🪂 chaos drops in by parachute
      para: mode === 'chaos',
      aim: x < T.width / 2 ? -0.6 : -2.54, palette: i % 6,
      hp: 100, fuel: 100, tele: false, inv: { cluster: 0, guided: 0, tomahawk: 0 }, buff: 0, dead: false,
      cdAt: 0,   // ⚡ chaos reload bookkeeping
      dmg: 0,    // 💥 damage dealt to OTHERS (tie-breaker metric)
      kills: 0, deaths: 0, // 💀 the headline stat - most kills wins
      deadAt: 0, // ⚡ chaos respawn timer (0 = alive / never died)
      shieldUntil: 0, // 🛡️ chaos shield pickup - invulnerable until this stamp
      paraUntil: mode === 'chaos' ? Date.now() + PARA_MAX_MS : 0, // 🪂 server-owned chute deadline
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
  //    pickup/expiry) - ⚡ chaos crates are UNCOVERED: type rides along
  if (out.crates && g.mode !== 'chaos') out.crates = out.crates.map(({ type, ...pub }) => pub);
  out.hostId = room.hostId;               // clients gate host-only UI on this
  out.match = room.match ? { ...room.match } : null; // round/wins scoreboard
  return out;
}

// ── Match bookkeeping: best-of-N rounds, wins per player ─────────────
/** Fresh match when a game starts from the lobby. */
function startMatch(room) {
  room.match = { round: 1, roundsTotal: room.roundsTotal, wins: {}, kills: {}, deaths: {}, dmg: {}, over: false, lastWinner: null };
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
  // 💀 fold the round's kills/deaths/damage into the match career board, so a
  //    best-of-N shows career numbers (the tanks themselves reset next round)
  for (const t of g.tanks) {
    if (t.kills | 0) m.kills[t.id] = (m.kills[t.id] | 0) + (t.kills | 0);
    if (t.deaths | 0) m.deaths[t.id] = (m.deaths[t.id] | 0) + (t.deaths | 0);
    if (t.dmg | 0) m.dmg[t.id] = (m.dmg[t.id] | 0) + (t.dmg | 0);
  }
  if (m.round >= m.roundsTotal) m.over = true; // played all rounds → most wins takes the match
}
function broadcastGame(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit('game-state', serializeGame(room));
}

/** ⚡ chaos time-out: the match clock hit 0:00 - MOST KILLS wins; damage dealt
 *  breaks a kill-tie (exact tie on both = draw). Even a tank that's mid-respawn
 *  can take it: the scoreboard never sleeps, survival just keeps you scoring. */
function endChaosByScore(room) {
  const g = room.game;
  if (!g || g.turn.phase === 'over') return;
  let top = null, tie = false;
  for (const t of g.tanks) {
    const k = t.kills | 0, d = t.dmg | 0;
    if (!top || k > (top.kills | 0) || (k === (top.kills | 0) && d > (top.dmg | 0))) { top = t; tie = false; }
    else if (k === (top.kills | 0) && d === (top.dmg | 0)) tie = true; // dead level on BOTH - no unique winner
  }
  const winnerId = top && !tie && ((top.kills | 0) > 0 || (top.dmg | 0) > 0) ? top.id : null;
  finishRound(room, winnerId);
  broadcastGame(room.id);
  console.log(`[room ${room.id}] ⏱ chaos time! round ${room.match?.round ?? 1} over - winner: ${winnerId ? `${top.name} (${top.kills | 0} kills, ${top.dmg | 0} dmg)` : 'draw'}`);
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
    console.log(`[room ${room.id}] 🏆 round ${room.match?.round ?? 1} over - winner: ${alive[0]?.name ?? 'draw'}`);
    return;
  }
  if (g.mode === 'chaos') return; // ⚡ chaos has no turns to rotate
  const prev = g.tanks[g.turn.activeIdx];
  if (prev?.tele) { // 🌀 teleport not used in time - the turn eats it
    prev.tele = false;
    io.to(room.id).emit('game-event', { kind: 'tele-fizzle', id: prev.id, x: prev.x, y: prev.y });
  }
  let i = g.turn.activeIdx;
  // 🔌 skip the dead AND the disconnected-but-reclaimable - a classic match
  //    is never held hostage by a tank whose owner dropped
  for (let k = 0; k < ts.length; k++) { i = (i + 1) % ts.length; if (!ts[i].dead && !ts[i].gone) break; }
  g.turn.activeIdx = i;
  g.turn.num += 1;
  g.turn.phase = 'open';
  g.turn.endsAt = Date.now() + TURN_TIME_MS;
  g.turn.settleEnd = 0;
  // ⛽ fresh turn, fresh tank of fuel (B4). Player tanks are refilled by their
  //    own clients (fuel is owner-streamed); bots have no client, so the
  //    server refills them here or they'd permanently starve (drive stops < 8)
  for (const t of g.tanks) if (t.ai) t.fuel = 100;
  g.wind = rollWind(); // fresh wind every turn
  broadcastGame(room.id);
}

/** 10Hz authoritative sim: turn timers, supply drops, crate physics+collection. */
function tickRoom(room) {
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  // 🖥️ solo/hot-seat sandbox (dev start, no bots, not chaos): the game runs
  // fully client-side - no phantom turn auto-pass, supply drops, or crate events
  if (room.localOnly) return;
  const now = Date.now();
  // ⏱ real elapsed time, not the nominal 100ms - setInterval jitter (event-loop
  //    stalls, busy ticks) would otherwise compound into sim drift
  const dt = Math.min(0.5, Math.max(0.02, (now - (room.tickAt ?? now - 100)) / 1000));
  room.tickAt = now;
  const tn = g.turn;
  if (tn.phase !== 'over') {
    if (g.mode === 'chaos') {
      if (now > g.endsAt) return endChaosByScore(room); // ⏳ 0:00 - most HP wins
    } else {
      // 🎬 turn 1 gets START_GRACE_MS extra - everyone's client is still in "3,2,1,FIGHT!"
      if (tn.phase === 'open' && now > tn.endsAt + (tn.num === 1 ? START_GRACE_MS : 0)) return advanceTurnServer(room);
      if (tn.phase === 'settle' && now > tn.settleEnd) return advanceTurnServer(room);
      if (tn.phase === 'shot' && now - tn.fireAt > SHOT_TIMEOUT_MS) return advanceTurnServer(room);
    }
  }

  const T = room.sim?.T;
  let dirty = false;

  // ⚡ chaos: no turns, so wind re-rolls on a wall-clock timer instead
  if (g.mode === 'chaos' && tn.phase !== 'over') {
    g.windT = (g.windT ?? CHAOS_WIND_MS) - dt * 1000;
    if (g.windT <= 0) { g.windT = CHAOS_WIND_MS; g.wind = rollWind(); dirty = true; }
  }

  // 🔌 disconnect grace: a gone tank whose owner never rejoined dies in place
  if (tn.phase !== 'over') {
    for (const t of g.tanks) {
      if (!t.gone || t.dead || !t.goneAt) continue;
      if (now - t.goneAt > LEAVE_GRACE_MS) { finalizeGone(room, t); return; } // finalizeGone broadcasts; start fresh next tick
    }
  }

  // ⚡ chaos respawns: a dead tank is back after CHAOS_RESPAWN_MS at a fresh
  // random spot with full HP + fuel - death is a timeout, not an elimination
  if (g.mode === 'chaos' && tn.phase !== 'over' && T) {
    for (const t of g.tanks) {
      if (!t.dead || !t.deadAt || now - t.deadAt < CHAOS_RESPAWN_MS) continue;
      const placed = g.tanks.filter((o) => o !== t && !o.dead).map((o) => o.x);
      const x = findSpawn(T, 60 + Math.floor(Math.random() * (T.width - 120)), placed, T.width / 2);
      t.x = x; t.y = -60; t.para = true; // 🪂 ride the chute down to the fresh spot
      t.paraUntil = now + PARA_MAX_MS;   // 🪂 server-owned deadline on the new chute
      t.aim = x < T.width / 2 ? -0.6 : -2.54;
      t.hp = 100; t.fuel = 100; t.dead = false; t.deadAt = 0; t.cdAt = 0;
      io.to(room.id).emit('game-event', { kind: 'respawn', id: t.id, x: t.x, y: t.y });
      dirty = true;
    }
  }

  // supply drops: every 24–40s, max 3 live, placed FAIRLY (equidistant-ish from all)
  if (tn.phase !== 'over' && T) {
    g.dropT -= dt * 1000;
    if (g.dropT <= 0) {
      // ⚡ chaos: …and often - a 3-minute brawl wants a steady supply rain
      g.dropT = g.mode === 'chaos' ? 7000 + Math.random() * 5000 : 24000 + Math.random() * 16000;
      if (g.crates.filter((c) => !c.taken).length < (g.mode === 'chaos' ? 5 : 3)) {
        // ⚖️ fair drop: sample candidate spots, keep the one that maximizes the
        // distance to the NEAREST live tank - equal opportunity for everyone
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

  // crate physics @10Hz + drive-over collection (server knows all positions).
  // ⏹️ frozen once the round is over - no events/broadcasts over the end screen
  if (T && g.crates.length && tn.phase !== 'over') {
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
        c.sway += dt;
        c.vy = Math.min(150, c.vy + GRAV * 0.35 * dt);
        c.x = Math.max(40, Math.min(T.width - 40, c.x + Math.sin(c.sway * 2 + c.bob) * 14 * dt + g.wind * 30 * dt));
        c.y += c.vy * dt;
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
          if (t.dead || t.para) continue; // 🪂 no crate vacuuming on the way down
          const ty = t.y - 16;
          if (Math.abs(t.x - c.x) > 30 || Math.abs(ty - (c.y - 14)) > 34) continue;
          c.taken = true;
          if (c.type === 'hp10' || c.type === 'hp15') t.hp = Math.min(100, t.hp + (c.type === 'hp10' ? 10 : 15));
          else if (c.type === 'x2') t.buff += 2;
          else if (c.type === 'x3') t.buff += 3;
          else if (c.type === 'teleport') t.tele = true; // 🌀 pending - use it this turn or lose it
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

  // 🤖 bots have no client to stream their footing - re-ground them as blasts
  //    carve the terrain, or they hover over fresh craters and blast damage is
  //    computed at a stale y (they'd dodge hits they visibly shouldn't)
  if (T && tn.phase !== 'over') {
    for (const t of g.tanks) {
      if (!t.ai || t.dead || t.para) continue;
      const gy = surfOf(T, t.x);
      if (Math.abs(gy - t.y) > 1) { t.y = gy; dirty = true; }
    }
  }

  // 🪂 server owns the chute: clear it on touchdown (ground check against the
  //    authoritative bitmap) or when the hard deadline passes - a client that
  //    never reports the stow cannot stay immortal
  if (T && tn.phase !== 'over') {
    for (const t of g.tanks) {
      if (!t.para) continue;
      if ((typeof t.y === 'number' && t.y >= surfOf(T, t.x) - 4) || (t.paraUntil && now > t.paraUntil)) {
        t.para = false; t.paraUntil = 0; dirty = true;
      }
    }
  }

  // 🤖 CPU tanks (vs-AI games): think → (teleport/drive) → aim-sweep → fire →
  //    server-simmed shells → authoritative blasts → settle. Classic only.
  //    ⏹️ gated on a live round - no bot turns over the end screen
  if (AI && g.mode !== 'chaos' && tn.phase !== 'over') {
    try { AI.tickRoomAI(room, io, { applyBlast, broadcast: (r) => broadcastGame(r.id), SETTLE_MS, dt }); }
    catch (err) { console.error(`[room ${room.id}] ai tick error:`, err); }
  }

  if (dirty) broadcastGame(room.id);
}

async function startGame(socket, payload) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room) return;
  // {dev:true} = solo/hot-seat bypass - only valid in a 1-player room, so a
  // non-host can't use it to force-start a real multiplayer game
  const dev = !!payload?.dev && room.players.size === 1;
  // 🤖 vs-AI: the client pins the bot roster on a dev start; it then persists
  // for rematches/lobby restarts (bots count toward MIN_PLAYERS for those)
  const ai = ['easy', 'medium', 'hard'].includes(payload?.ai) ? payload.ai : null;
  if (dev) room.aiBots = ai ? [{ difficulty: ai }] : [];
  // 🖥️ solo/hot-seat dev games (no bots, classic) run fully client-side: the
  // server hosts the roster + terrain seed but skips the whole tick sim.
  // 🤖 vs-AI and ⚡ chaos dev games stay server-driven - those clients ARE online.
  room.localOnly = dev && !ai && room.mode !== 'chaos';
  // 🙅 no more silent rejections - every refusal tells the lobby why
  const deny = (reason) => socket.emit('start-denied', { reason });
  if (socket.id !== room.hostId && !dev) return deny('host-only'); // 👑 only the room master starts games
  if (room.players.size + (room.aiBots?.length ?? 0) < MIN_PLAYERS && !dev) return deny('need-players');
  if (room.game) return deny('already-running'); // already running
  startMatch(room); // fresh match: round 1 of roundsTotal, clean scoreboard
  try {
    room.game = await createGame(room);
  } catch (err) {
    console.error(`[room ${roomId}] failed to create game:`, err);
    room.match = null;
    return deny('create-failed');
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
  room.aiRt = null; // 🤖 bot runtime dies with the game (roster persists for rematches)
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
  console.log(`[room ${room.id}] ⚔️ round ${m.round}/${m.roundsTotal} - new terrain (${room.game.terrain.seed})`);
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
  console.log(`[room ${room.id}] 🏆 new match - best of ${room.match.roundsTotal}`);
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
  console.log(`[room ${room.id}] 🎲 round restarted - new terrain (${room.game.terrain.seed})`);
  io.to(room.id).emit('game-state', serializeGame(room, true));
}

/** Apply a shell impact authoritatively: carve terrain, destroy crates caught
 *  in the radius, compute + apply damage from last-known positions, broadcast.
 *  Shared by the human 'blast' socket handler AND the 🤖 bot engine. */
function applyBlast(room, me, p) {
  const g = room.game;
  const T = room.sim?.T;
  if (!g || !T) return;
  const tn = g.turn;
  const chaos = g.mode === 'chaos';
  const x = Number(p?.x), y = Number(p?.y);
  if (!isFinite(x) || !isFinite(y)) return;
  // 📏 sanity band: honest blasts always land within a blast-radius of the map
  //    (world-wall hits, mid-air para splash at y ≥ -60). A crafted/corrupt
  //    client sending e.g. x=1e15 passed the isFinite guard, then
  //    removeFloaters ran new Uint8Array(negative-length) → RangeError thrown
  //    mid-surgery: the bitmap was left half-carved (server/client desync) and
  //    the throw escaped the socket handler uncaught. Drop those blasts whole.
  if (x < -256 || x > T.width + 256 || y < -256 || y > T.height + 256) return;
  const r = Math.min(200, Math.max(8, Number(p?.r) || BLAST_R));
  const scale = Math.min(6, Math.max(0.1, Number(p?.scale) || 1));
  const big = !!p?.big;
  const cut = []; // 🌱 cleared cells → rim seeds for the floater scan
  TERR.destroyCircle(T, x, y, r, cut);
  TERR.cleanDebris(T, x, y, r + 16, cut);
  TERR.removeFloaters(T, x, y, r + 190, cut);
  TERR.reflowSky(T, x, y, r + 16);
  g.blasts.push({ x, y, r }); // floats - late joiners replay exactly what was carved
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
    if (d >= range) continue; // out of range - not even a block report (no BLOCKED spam)
    // 🪂 a tank under canopy is untouchable - report a 0-damage block (the
    //    client already renders d:0 as "🛡️ BLOCKED"). Above the shield check:
    //    applies in classic too (harmless - para is chaos-only)
    if (t.para) { dmg.push({ id: t.id, hp: t.hp, d: 0, direct: false, dead: false }); continue; }
    // 🛡️ shielded tanks take nothing - report a 0-damage block instead
    if (chaos && t.shieldUntil && Date.now() < t.shieldUntil) {
      dmg.push({ id: t.id, hp: t.hp, d: 0, direct: false, dead: false });
      continue;
    }
    const direct = d < 30;
    const dd = direct ? Math.round(50 * scale) : Math.max(2, Math.round(46 * scale * (1 - d / range)));
    t.hp = Math.max(0, t.hp - dd);
    if (t.hp <= 0) {
      t.dead = true;
      if (chaos) t.deadAt = Date.now(); // ⚡ chaos: respawn timer starts
      // 💀 kill attribution: the shooter scores (never for a self-kill - that
      //    costs you a death and buys nobody a point), the victim logs a death
      t.deaths = (t.deaths | 0) + 1;
      if (me && t.id !== me.id) me.kills = (me.kills | 0) + 1;
    }
    dmg.push({ id: t.id, hp: t.hp, d: dd, direct, dead: t.dead });
  }
  // 💥 damage dealt to OTHERS - the tie-breaker metric (tracked in BOTH modes;
  //    was chaos-gated, which left classic leaderboards falling back to HP - B10)
  if (me) me.dmg = (me.dmg | 0) + dmg.reduce((s, d) => (d.id === me.id ? s : s + d.d), 0);
  const alive = g.tanks.filter((t) => !t.dead);
  // ⚡ chaos never ends on a wipeout - respawns keep the match rolling
  if (!chaos && g.tanks.length > 1 && alive.length <= 1) finishRound(room, alive[0]?.id ?? null);
  // 🏷️ src lets the shooter recognize their own echo (they already carved the
  //    crater locally) - everyone else's clients always carve what they're told
  io.to(room.id).emit('blast', { x, y, r, scale, big, dmg, src: me?.id ?? null });
  broadcastGame(room.id);
}

/** 🔌 A gone tank whose rejoin grace lapsed dies in place - the old
 *  immediate-leave behaviour, deferred so a transient drop can reclaim it. */
function finalizeGone(room, t) {
  const g = room?.game;
  if (!g || !t.gone || t.dead) return;
  t.gone = false; t.goneAt = 0;
  t.dead = true; t.hp = 0; // ⚡ chaos: no deadAt → leavers never respawn
  if (g.mode === 'chaos') {
    // ⚡ no eliminations in chaos - but if nobody's left to fight, score it now
    if ((g.players?.length ?? 0) <= 1) endChaosByScore(room);
  } else {
    const alive = g.tanks.filter((tk) => !tk.dead);
    if (g.tanks.length > 1 && alive.length <= 1) finishRound(room, alive[0]?.id ?? null);
  }
  broadcastGame(room.id);
  console.log(`[room ${room.id}] 🔌 ${t.name} never came back - tank died in place`);
}

/** Leaving mid-game no longer kills outright: the tank is marked GONE for
 *  LEAVE_GRACE_MS so a reconnect (new socket.id, same cid) can reclaim it via
 *  join-room. Only when the grace lapses does finalizeGone() do what leaving
 *  used to do - the war goes on without you. */
function handleGameLeave(socket, room, { deliberate = false } = {}) {
  const g = room?.game;
  if (!g?.players) return;
  g.players = g.players.filter((p) => p.id !== socket.id);
  const t = g.tanks.find((tk) => tk.id === socket.id);
  if (t && !t.dead && g.turn.phase !== 'over' && !t.ai) {
    t.gone = true; t.goneAt = Date.now();
    if (deliberate) { // 🚪 rage-quit = instant death - the reconnect grace is for DROPS, not exits
      finalizeGone(room, t);
      const gg = room.game; // finalizeGone may have ended the round already
      if (gg && gg.mode !== 'chaos' && gg.turn.phase !== 'over' && gg.tanks[gg.turn.activeIdx]?.id === socket.id) {
        advanceTurnServer(room); // was their turn - move on
        broadcastGame(room.id);
      }
    } else if (g.mode !== 'chaos' && g.tanks[g.turn.activeIdx]?.id === socket.id && g.turn.phase !== 'over') {
      advanceTurnServer(room); // was their turn - move on, don't hold the match hostage
    }
  }
  if (g.players.length === 0) {
    // nobody left to play - tear it ALL down and tell the room: spectators
    // (sockets in the room but not in g.players) get null → back to the lobby
    room.game = null; room.sim = null;
    room.match = null; room.aiRt = null; // 🤖 scoreboard + bot runtime die with the game
    broadcastGame(room.id);
  } else broadcastGame(room.id);
}
// ═══════════════════════ END GAME HOOK ═══════════════════════════════

function leaveCurrentRoom(socket, deliberate = false) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) { socket.leave(roomId); socket.data.roomId = null; return; }
  handleGameLeave(socket, room, { deliberate }); // must run before socket.data.roomId is cleared
  socket.leave(roomId);
  socket.data.roomId = null;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(roomId);
    console.log(`[room ${roomId}] empty - deleted`);
  } else {
    // host left → crown the longest-standing survivor (Map keeps join order) as
    // CARETAKER - the crown returns to the creator (hostCid) when they rejoin
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value ?? null;
      console.log(`[room ${roomId}] 👑 host transferred to ${room.players.get(room.hostId)?.name} (caretaker)`);
    }
    io.to(roomId).emit('room-state', serializeRoom(room));
  }
}

let io;
let httpServer; // module-scope so the shutdown handlers can close it

// 🚪 graceful shutdown: PaaS hosts (Render/Railway/systemd) send SIGTERM before
//    reaping the process on deploys. Close politely - clients see a clean
//    disconnect (their reconnect grace kicks in) instead of a hard kill mid-shell.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🚪 ${signal} received - closing connections, shutting down`);
  try { io?.close(); } catch {}
  try { httpServer ? httpServer.close(() => process.exit(0)) : process.exit(0); }
  catch { process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref(); // never hang on a stuck socket
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.prepare().then(async () => {
  // game libs are pure ESM (shared with the client bundle) - dynamic import
  TERR = await import('./lib/terrain.mjs');
  BONUS = await import('./lib/bonus.mjs');
  AI = await import('./lib/ai.mjs'); // 🤖 CPU opponents

  httpServer = createServer((req, res) => handle(req, res));

  // Next dev HMR uses its own websocket on /_next/* - forward those upgrades
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
        leaveCurrentRoom(socket, true); // jumping rooms is a deliberate exit - no grace

        let room = rooms.get(roomId);
        if (!room) {
          room = { id: roomId, createdAt: Date.now(), players: new Map(), game: null, sim: null, hostId: null, hostCid: null, roundsTotal: 1, match: null, mode: 'classic', aiBots: [], aiRt: null };
          rooms.set(roomId, room);
          console.log(`[room ${roomId}] created`);
        }
        const cid = String(payload?.cid || '').slice(0, 64) || null; // stable per-tab identity
        // 🔁 same human, NEW socket (reload/reconnect before the old socket's
        //    ping timeout): evict their stale entry first, or they can bounce
        //    off a phantom of themselves on a full room. cid is per-tab
        //    (sessionStorage), so a same-cid/different-socket entry is always stale.
        let evicted = null;
        if (cid) {
          for (const [pid, pl] of room.players) {
            if (pl.cid === cid && pid !== socket.id) {
              evicted = pl;
              room.players.delete(pid);
              if (room.hostId === pid) room.hostId = socket.id; // crown follows the human, not the socket
              console.log(`[room ${roomId}] 🔁 ${pl.name} reconnected on a new socket - stale entry evicted`);
              break;
            }
          }
        }
        if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: `Room is full (${MAX_PLAYERS} players max).` });

        const player = { id: socket.id, name, emoji: evicted?.emoji ?? pickEmoji(room), joinedAt: evicted?.joinedAt ?? Date.now(), cid }; // rejoiners keep their face + seniority
        room.players.set(socket.id, player);
        if (!room.hostId) room.hostId = socket.id; // first joiner is the room master 👑
        if (!room.hostCid && cid && room.hostId === socket.id) room.hostCid = cid; // remember the creator's identity - set once
        if (cid && room.hostCid === cid && room.hostId !== socket.id) { // 👑 the crown ALWAYS returns to the creator
          room.hostId = socket.id; //        on (re)join - reloads/reconnects never switch the master
          console.log(`[room ${roomId}] 👑 crown returned to creator ${name}`);
        }
        socket.data.roomId = roomId;
        socket.join(roomId);
        // 🔌 mid-game rejoin: hand the player THEIR tank back. The tank survives
        //    a disconnect for LEAVE_GRACE_MS (marked gone, not killed) - re-bind
        //    it to the new socket.id by stable cid, exactly like the crown above.
        //    Without this the reconnecting player silently became a spectator of
        //    their own corpse: controlTank() found no tank with the new id.
        if (room.game && cid) {
          const g = room.game;
          const t = g.tanks.find((tk) => tk.cid === cid);
          if (t && t.id !== socket.id) {
            console.log(`[room ${roomId}] 🔌 ${t.name} reclaimed their tank (${t.gone ? 'was gone' : 'stale socket'} - re-bound to new socket)`);
            t.id = socket.id;
            t.gone = false; t.goneAt = 0;
            if (!g.players.some((p) => p.id === socket.id)) g.players.push({ id: socket.id, name: t.name, emoji: t.emoji });
            // ⚡ chaos: the grace-kill already ran? a chaos tank is never eliminated -
            //    route it through the normal respawn clock instead of a corpse-bind
            if (t.dead && g.mode === 'chaos' && !t.deadAt && g.turn.phase !== 'over') t.deadAt = Date.now();
            broadcastGame(roomId);
          } else if (t) {
            t.gone = false; t.goneAt = 0; // same-socket rejoin (idempotent path above missed it)
          }
        }
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
    // active player passes their turn early (Enter) - classic mode only
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
      // 👀 shared intel: everyone sees everyone's fuel gauge - aim power stays the shooter's SECRET
      if (typeof p?.fuel === 'number' && isFinite(p.fuel)) t.fuel = Math.max(0, Math.min(100, p.fuel));
      // 🪂 one-way stow: accept only the touchdown report (para: false). The
      //    chute is server-owned now that it grants immunity - a crafted client
      //    streaming para:true forever would be immortal; the server arms it at
      //    spawn/respawn and clears it on this report, its own ground check,
      //    or the PARA_MAX_MS deadline, whichever comes first
      if (p?.para === false) { t.para = false; t.paraUntil = 0; }
      if (typeof p?.palette === 'number' && isFinite(p.palette)) t.palette = ((p.palette | 0) % 6 + 6) % 6; // 🎨 recolors are public
      if (process.env.STEER_DEBUG) console.log('tm', JSON.stringify({ n: t.name, x: Math.round(t.x), y: Math.round(t.y), para: t.para === true, t: Date.now() % 100000 }));
      socket.to(room.id).volatile.emit('tank-move', {
        id: t.id, x: t.x, y: t.y, aim: t.aim, s: typeof p?.s === 'number' ? p.s : 0,
        fuel: t.fuel, para: t.para === true, palette: t.palette, // 🕵️ no power - that's the shooter's secret
      });
    });
    // 🌀 teleport: spend a pending teleport to land at x (classic: this turn
    //    only, active tank; chaos: any live owner, any time before it's used)
    socket.on('teleport', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      const T = room?.sim?.T; // full bitmap (surface/waterY) - g.terrain is just a descriptor
      if (!g || !T) return;
      const tn = g.turn;
      const chaos = g.mode === 'chaos';
      const me = chaos ? g.tanks.find((tk) => tk.id === socket.id) : g.tanks[tn.activeIdx];
      // 🙅 every refusal is nacked - the client waits for the relayed jump and
      //    must never keep a move the server rejected (#16: no free teleports)
      const deny = (reason) => socket.emit('teleport-denied', { reason });
      if (!me || me.dead || tn.phase === 'over') return deny('not-live');
      if (!chaos && (me.id !== socket.id || tn.phase !== 'open')) return deny('not-your-turn');
      if (!me.tele) return deny('no-teleport');
      const x = Math.max(30, Math.min(T.width - 30, Math.round(Number(p?.x) || 0)));
      const y = surfOf(T, x);
      if (y > T.waterY - 6) return deny('wet'); // no watery graves - pick dry land
      me.tele = false;
      me.x = x; me.y = y;
      io.to(room.id).emit('game-event', { kind: 'teleport', id: me.id, x, y });
      broadcastGame(room.id);
    });
    // fire - classic: the active player, turn ends; chaos: ANY living tank,
    // infinite shells behind a per-tank 1s reload, match keeps rolling
    socket.on('fire', (p) => {
      const room = rooms.get(socket.data.roomId);
      const g = room?.game;
      if (!g) return;
      const tn = g.turn;
      const chaos = g.mode === 'chaos';
      // 🙅 every refusal is nacked - the shooter fired OPTIMISTICALLY and must
      //    roll back (dud the shell, refund the ammo) or the screens diverge
      const deny = (reason, extra) => socket.emit('fire-denied', { reason, ...extra });
      const me = chaos ? g.tanks.find((tk) => tk.id === socket.id) : g.tanks[tn.activeIdx];
      if (!me || me.dead || me.para || tn.phase === 'over') return deny('not-live'); // 🪂 guns stay packed until touchdown
      if (!chaos && (me.id !== socket.id || tn.phase !== 'open')) return deny('not-your-turn');
      if (chaos) { // ⚡ reload gate - server is the referee
        const nowF = Date.now();
        // 🎬 the countdown is a client-side artifact - without this gate a crafted
        //    client pre-fires while honest players are still watching "3, 2, 1"
        const grace = g.startedAt + CHAOS_FIRE_GRACE_MS - nowF;
        if (grace > 0) return deny('grace', { retryIn: grace });
        const wait = CHAOS_COOLDOWN_MS - (nowF - (me.cdAt || 0));
        if (wait > 0) return deny('reload', { retryIn: wait }); // ⏳ client adopts the server's clock
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
    // shooter reports an impact - server applies it to the bitmap, computes
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
      // ⚡ chaos: a shell you fired while alive may land after you die - allow a
      //    short ghost window so the shared terrain/damage stays consistent
      if (chaos && me.dead && Date.now() - (me.cdAt || 0) > CHAOS_GHOST_MS) return;
      applyBlast(room, me, p);
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

    socket.on('leave-room', () => leaveCurrentRoom(socket, true));   // 🚪 deliberate - instant death
    socket.on('disconnect', () => leaveCurrentRoom(socket, false));  // 🔌 transport drop - reconnect grace
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
}).catch((err) => {
  // 💥 startup failure (app.prepare / ESM import) - the keep-alive policy above
  //    is for RUNTIME faults; a dead bootstrap must exit fast so the host's
  //    supervisor can restart us instead of sitting alive but never listening.
  console.error('💥 startup failed:', err);
  process.exit(1);
});
