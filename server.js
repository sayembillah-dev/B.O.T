// ════════════════════════════════════════════════════════════════════
//  MULTIPLAYER ROOM TEMPLATE
//  Custom Node server: Next.js + Socket.IO in one process.
//  Room state lives in memory (server-authoritative).
//
//  Works out of the box:
//    • create / join rooms via shareable link  →  /room/<id>
//    • live lobby — players see each other join & leave in real-time
//    • name prompt, emoji avatars, reconnect → automatic re-join
//    • start-game → game-state broadcast → end-game → back to lobby
//
//  To build your game: search for "GAME HOOK" below.
// ════════════════════════════════════════════════════════════════════
const { createServer } = require('http');
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
const MIN_PLAYERS = 2; // set to 1 while developing solo
const EMOJIS = ['😀','😎','🤖','👾','🐸','🦊','🐼','🐯','🦁','🐙','🦄','🐲','👻','💀','🤠','😺','🙉','🦖','🍕','⚡','🔥','🌵','🥷','🧙'];
const ROOM_ID_RE = /^[a-z0-9]{4,24}$/;

/** rooms: Map<roomId, { id, createdAt, players: Map<socketId, player>, game: object|null }> */
const rooms = new Map();

function serializeRoom(room) {
  return { id: room.id, createdAt: room.createdAt, maxPlayers: MAX_PLAYERS, players: [...room.players.values()] };
}
function pickEmoji(room) {
  const used = new Set([...room.players.values()].map((p) => p.emoji));
  const pool = EMOJIS.filter((e) => !used.has(e));
  return (pool.length ? pool : EMOJIS)[Math.floor(Math.random() * (pool.length ? pool.length : EMOJIS.length))];
}

// ════════════════════════ GAME HOOK (edit me) ═══════════════════════
// The template ships a minimal session so the full loop works end-to-end:
// lobby → playing → back to lobby. Replace createGame / serializeGame
// with your own state, and add your own socket handlers + authoritative
// game logic (validation, timers, physics…) in this section.
// ─────────────────────────────────────────────────────────────────────
function createGame(room) {
  return {
    phase: 'playing',
    startedAt: Date.now(),
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, emoji: p.emoji })),
    // your game state: turn order, positions, scores, seed, …
  };
}
function serializeGame(room) {
  return room.game; // shape this to only what clients are allowed to see
}
function broadcastGame(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit('game-state', serializeGame(room));
}
function startGame(socket) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room || room.players.size < MIN_PLAYERS) return;
  if (room.game) return; // already running
  room.game = createGame(room);
  console.log(`[room ${roomId}] 🎮 game started (${room.players.size} players)`);
  broadcastGame(roomId);
}
function endGame(socket) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room?.game) return;
  room.game = null;
  console.log(`[room ${roomId}] 🏁 game ended`);
  broadcastGame(roomId); // null → clients fall back to the lobby
}
/** Keep the game roster in sync when someone leaves mid-game. Extend with your own rules (pause, forfeit, bots…). */
function handleGameLeave(socket, room) {
  const g = room?.game;
  if (!g?.players) return;
  g.players = g.players.filter((p) => p.id !== socket.id);
  if (g.players.length === 0) room.game = null;
  broadcastGame(room.id);
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
    io.to(roomId).emit('room-state', serializeRoom(room));
  }
}

let io;

app.prepare().then(async () => {
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
          socket.emit('game-state', serializeGame(room));
          return;
        }
        leaveCurrentRoom(socket);

        let room = rooms.get(roomId);
        if (!room) {
          room = { id: roomId, createdAt: Date.now(), players: new Map(), game: null };
          rooms.set(roomId, room);
          console.log(`[room ${roomId}] created`);
        }
        if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: `Room is full (${MAX_PLAYERS} players max).` });

        const player = { id: socket.id, name, emoji: pickEmoji(room), joinedAt: Date.now() };
        room.players.set(socket.id, player);
        socket.data.roomId = roomId;
        socket.join(roomId);
        console.log(`[room ${roomId}] ${name} joined (${room.players.size} players)`);

        reply({ ok: true, you: player, room: serializeRoom(room) });
        io.to(roomId).emit('room-state', serializeRoom(room));
        socket.emit('game-state', serializeGame(room)); // null in lobby, or live game for late joiners / spectators
      } catch (err) {
        console.error(err);
        reply({ ok: false, error: 'Server error.' });
      }
    });

    socket.on('start-game', () => startGame(socket));
    socket.on('end-game', () => endGame(socket));
    // GAME HOOK: register your own events here, e.g.
    // socket.on('action', (payload) => { /* validate → mutate → broadcastGame(roomId) */ });

    socket.on('leave-room', () => leaveCurrentRoom(socket));
    socket.on('disconnect', () => leaveCurrentRoom(socket));
  });

  httpServer.listen(port, hostname, () => {
    console.log(`▲ ready on http://localhost:${port} (bound to ${hostname})`);
  });
});
