# Multiplayer Room Template

A starter template for real-time multiplayer browser games. It implements the complete session layer that most multiplayer games need: creating and joining rooms through shareable links, a live lobby where players see each other arrive and leave, and a server-authoritative game lifecycle. Clone it, replace the placeholder game screen with your own game, and ship.

<img width="1200" height="777" alt="image" src="https://github.com/user-attachments/assets/19f53d9a-88e5-418c-b4ff-a0bf595e34f1" />

<img width="1303" height="777" alt="image" src="https://github.com/user-attachments/assets/831fd6a4-9404-4b8a-83bb-bce81329a957" />




## Why this template exists

Most multiplayer game tutorials start at rendering sprites and skip the hard part: getting multiple players into the same session reliably. This template is that hard part, extracted from a working game and packaged for reuse.

## Features

- Room creation with unguessable, URL-safe room codes
- Invite flow: copy a link, a friend opens it, picks a name, and is in
- Live lobby with presence updates as players join and leave
- Reconnect handling: dropped clients rejoin their room automatically
- Server-authoritative state: the server owns the room and the game state
- A working start game and end game lifecycle, so the full loop runs out of the box
- Emoji avatar per player, no accounts, no database

## Tech stack

- Next.js (App Router) and React for the UI
- Socket.IO for realtime transport, with automatic reconnect
- One Node.js process serving both HTTP (Next.js) and websockets (Socket.IO) through a custom server
- In-memory state only: rooms live in a Map and disappear when the last player leaves

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000, then:

1. Click "Create a room". You land on a URL like `/room/k7x2qm`.
2. Copy the invite link from the lobby and send it to a friend, or open it in a second browser.
3. Each player picks a name and enters the room. The lobby updates in real time.
4. With two or more players, anyone clicks "Start game". Everyone switches to the game screen.
5. On the placeholder game screen, click "End game" to send everyone back to the lobby.

Friends on the same network can join through your LAN IP, for example `http://192.168.1.20:3000/room/k7x2qm`. LAN origins are whitelisted automatically in development (see `next.config.mjs`), and tunnels such as ngrok can be added through the `ALLOWED_DEV_ORIGINS` environment variable.

## Using it as a GitHub template

1. Push this repository to GitHub.
2. In the repository settings, enable "Template repository".
3. For every new game: click "Use this template", create a repository, clone it, run `npm install`, and start building.

## Project structure

| Path | Role |
| --- | --- |
| `server.js` | Custom Node server: Next.js plus Socket.IO in one process. Owns all room state and the game lifecycle. Contains the marked GAME HOOK section where your game logic goes. |
| `app/page.jsx` | Home page: create a room, or join by pasted link or code. |
| `app/room/[id]/page.jsx` | Room route, a server component wrapper. |
| `components/Room.jsx` | Lobby UI: name prompt, live player list, copy invite link, start game button. Renders the game component once a game is running. |
| `components/Game.jsx` | Placeholder game screen. Replace this with your game. It receives the latest game state and your socket id as props. |
| `lib/socket.js` | Client socket singleton with auto-reconnect. |
| `lib/roomId.js` | URL-safe random room id generator, using an alphabet without ambiguous characters. |
| `app/globals.css` | Lobby and shared styling. |
| `next.config.mjs` | Development origin whitelist for LAN IPs and tunnels. |
| `scripts/smoke-test.mjs` | End-to-end test of the full room lifecycle. |

## How it works

### Server-authoritative rooms

The server keeps a Map of rooms in memory. A room is created when the first player joins its id, and deleted when the last player leaves. Every state change is broadcast to the room as `room-state` (the lobby roster) or `game-state` (game data). Clients never trust their own copy; they render what the server sends.

### Connection lifecycle

1. The client opens a room URL and is asked for a name.
2. The client emits `join-room` with the room id and name. The server validates both, registers the player, assigns an emoji, and replies with an acknowledgement.
3. The server broadcasts the updated `room-state` to everyone in the room.
4. If the connection drops, Socket.IO reconnects and the client re-emits `join-room`. A repeat join from the same socket is treated as idempotent.
5. `leave-room` and `disconnect` both remove the player, update the game roster if a game is running, and delete the room once it is empty.

### The game seam

`Room.jsx` watches `game-state`. While it is null, the lobby is shown. When `start-game` produces a state whose phase is not "lobby", `Room.jsx` renders `components/Game.jsx` instead. Setting the game state back to null on the server returns everyone to the lobby. Your game only needs to fit inside that contract.

## Socket events

| Event | Direction | Payload | Purpose |
| --- | --- | --- | --- |
| `join-room` | client to server (ack) | `{ roomId, name }` returns `{ ok, you, room }` or `{ ok: false, error }` | Join or create a room |
| `leave-room` | client to server | none | Leave the current room (disconnect is handled too) |
| `room-state` | server to room | `{ id, createdAt, maxPlayers, players[] }` | Lobby roster after every change |
| `start-game` | client to server | none | Start a game, requires at least `MIN_PLAYERS` players |
| `end-game` | client to server | none | End the game and return everyone to the lobby |
| `game-state` | server to room | object or null | Authoritative game state; null means the room is in the lobby |

## Configuration

Constants at the top of `server.js`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `MAX_PLAYERS` | 8 | Hard cap per room |
| `MIN_PLAYERS` | 2 | Players required to start a game; set to 1 for solo development |
| `EMOJIS` | 24 entries | Avatar pool, one unique emoji per player |
| `ROOM_ID_RE` | `/^[a-z0-9]{4,24}$/` | Validation rule for room ids |

Environment variables: `PORT` (default 3000), `HOST` (bind address, default 0.0.0.0; `HOSTNAME` is intentionally ignored because Git Bash exports it and can break localhost binding), and `ALLOWED_DEV_ORIGINS` (comma-separated extra development origins, for tunnels).

## Building your game

All game work happens in two places: the GAME HOOK section of `server.js`, and `components/Game.jsx`.

### 1. Define the initial state

Edit `createGame(room)` in `server.js` to return your authoritative state: turn order, positions, scores, a map seed, whatever your game needs.

```js
function createGame(room) {
  return {
    phase: 'playing',
    turn: null,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      score: 0,
    })),
  };
}
```

### 2. Control what clients see

`serializeGame(room)` decides exactly what is broadcast. Hide anything players should not know: other hands, fog of war, server secrets.

### 3. Handle player actions

Register events next to the GAME HOOK comment in `server.js`. Always validate before mutating: is the game in the right phase, is it this player's turn, is the move legal.

```js
socket.on('action', (payload) => {
  const room = rooms.get(socket.data.roomId);
  if (!room?.game) return;
  // validate, mutate room.game, then broadcast
  broadcastGame(room.id);
});
```

### 4. Build the UI

Replace `components/Game.jsx`. It receives `gs` (the latest game-state) and `myId` (your socket id). Send actions with `getSocket().emit('action', payload)`. Subscribe to additional broadcasts with `getSocket().on(...)` and unsubscribe in the effect cleanup.

### 5. End the game

Set `room.game = null` and call `broadcastGame(room.id)`. Every client automatically returns to the lobby and can start again.

For realtime-heavy updates such as movement or cursor positions, prefer `socket.volatile.emit(...)` on the server and accept occasional packet loss instead of added latency.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Development server with hot reload and sockets |
| `npm run build` | Production build |
| `npm start` | Production server (on Windows, set `NODE_ENV=production` before running `node server.js`) |
| `npm run smoke` | End-to-end smoke test; the dev server must be running |

## Testing

`scripts/smoke-test.mjs` connects real Socket.IO clients and verifies the whole loop:

- Two players join a room and see each other in real time
- `start-game` reaches every client with the game state
- `end-game` returns every client to the lobby
- Leaving removes the player for everyone
- A ninth player is rejected when the room is full

Run it with the server up:

```bash
npm run smoke
```

## Deployment

The custom server means this cannot run on purely serverless platforms such as Vercel, because websockets and in-memory state need a persistent process. Deploy to any Node host: Railway, Render, Fly.io, a VPS, or a container.

```bash
npm run build
npm start
```

Set the `PORT` environment variable if your host requires it.

### Scaling beyond one instance

In-memory rooms tie all players of a room to one process. To run multiple instances, move room state to Redis and add the Socket.IO Redis adapter (`@socket.io/redis-adapter`) so broadcasts reach every instance. For prototypes and small games, a single instance is usually enough.

## License

MIT. Use it for anything.
