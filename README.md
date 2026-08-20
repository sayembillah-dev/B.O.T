# 🛡️ B.O.T - battle of tanks

Worms-style artillery on fully destructible terrain - wind, supply drops, special shells, hot-seat or online rooms. Everything is procedural: terrain, tanks, particles, even the sound effects. Zero art assets, zero accounts, zero database.

Play at: <a>https://battleoftanks.up.railway.app/<a/>

<img width="1852" height="984" alt="SCR-20260819-ktyg" src="https://github.com/user-attachments/assets/63965314-b8da-4bae-a33b-eb770bf61d53" />



Next.js + Socket.IO run in **one Node process**: the same server serves the pages and referees the realtime game.

| 🏠 Home | 👥 Lobby | ⚔️ Classic battle |
| :-: | :-: | :-: |
<img width="1847" height="974" alt="SCR-20260819-ktrt" src="https://github.com/user-attachments/assets/acee32e0-fdcb-4dfd-8609-0b4890e85a00" />


| ⚡ Chaos mode | 💥 Destruction | 🏆 Victory |
| :-: | :-: | :-: |

## Game modes

| Mode | How |
| --- | --- |
| **Online rooms - ⚔️ Classic** | Create a room, send the invite link, 2+ players, server-authoritative turn-based match |
| **Online rooms - ⚡ Chaos** | Same room, host picks ⚡ in the lobby: real-time free-for-all - no turns, everyone moves at once, infinite shells behind a 1s reload, fuel refills in 3s, dead tanks respawn in 5s (parachuting back in - steerable with A/D, invulnerable under the canopy, mortal the frame it touches down), 3-minute match clock. Most damage dealt wins. Works with best-of-N rounds too |
| **Solo practice** | One click from the home page (`?solo=1`) |
| **🤖 vs AI** | Duel a server-driven CPU tank (`?solo=1&ai=easy\|medium\|hard`) - the bot searches real ballistic firing solutions against the authoritative terrain + wind, then applies a per-difficulty aim error: 😊 easy is partially accurate, 😐 medium accurate sometimes, 😈 hard accurate most of the time (plus smart target/weapon picks, repositioning, crate runs and teleports) |
| **Hot-seat 2–4P** | One screen, shared keyboard/mouse (`?solo=1&local=N`) |
| **Spectating** | Join a room mid-game - you watch until the next rematch |

## Features

- **Two rulesets** - Classic (turn-based, 20s turns) and ⚡ Chaos (real-time FFA, 1s reload, 5s respawns, 3:00 clock, most damage dealt wins)
- **Destructible seeded terrain** - per-pixel bitmap, caves, floating-island cleanup, deterministic from a seed
- **Wind** - re-rolled every turn (on a timer in Chaos), pushes shells, drifting smoke shows it, guided missiles resist it
- **Supply drops** - mystery crates parachute in (contents revealed only on pickup or expiry): ×2/×3 damage buffs, cluster shells, +10/+15 HP, rare guided missiles, tomahawks, teleports
- **Four shell types** - normal, cluster (splits into 3), guided (homing, super rare), tomahawk (insane blast, mushroom cloud, white flash, screen shake)
- **Tank physics** - tangent-space driving, hydraulic suspension, spinning wheels, fuel management, jumps
- **Turn rules** - park to fire, Enter to pass; Chaos replaces turns with a per-tank reload ring
- **Secret aim power** - your charge meter is yours alone: power never leaves your client until the shot is fired (opponents see your position, aim and fuel - never your power or power ring). Your last-used power is remembered between matches
- **Fair spawns** - symmetric slots scaled to player count, but the assignment is shuffled every round - join order never decides position
- **360° instant aim** - full barrel pivot, no tunneling, no floating terrain, no water
- **Procedural SFX** - pure WebAudio oscillators/noise, mutable, persisted (`M` or the 🔊 button)
- **Server-authoritative online** - the server owns the terrain bitmap, damage, drops, reload timers, and the match clock; clients render what they're told
- **Rematch, elimination, 💀 ghost tanks, winner crown** - full match loop

## Controls

| Input | Action |
| --- | --- |
| `A` / `D` or `←` / `→` | Drive (burns fuel) |
| `W` / `↑` / `Space` | Jump (costs fuel) |
| Mouse | Aim (full 360°) |
| Hold `LMB` | Charge shot, release to fire |
| Wheel while charging | Fine-tune power |
| `1` – `4` | Shell: normal / cluster / guided / tomahawk |
| `Enter` | Pass turn |
| `M` | Mute / unmute |
| `⛶ fullscreen` button | Toggle fullscreen - `Esc` backs out |

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000:

- **Create a room** → share the link → friend picks a name → **Start game** (needs 2+ players)
- **Solo practice** or **🛋️ 2P/3P/4P** hot-seat starts instantly

Friends on the same network can join via your LAN IP (`http://192.168.x.x:3000/room/<code>`); LAN origins are whitelisted in dev. Tunnels (ngrok etc.) go in `ALLOWED_DEV_ORIGINS`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Dev server (Next.js + Socket.IO in one process) |
| `npm run build` | Production build |
| `npm start` | Production server (on Windows: set `NODE_ENV=production` first) |
| `npm run smoke` | Room-lifecycle smoke test (dev server must be running) |
| `npm run smoke:rounds` | Best-of-N rounds protocol tests |
| `npm run test:ai` / `test:ai-game` | 🤖 bot accuracy + full bot-match tests |
| `node scripts/mp-probe.mjs` | Full multiplayer protocol test: 2 headless clients play a turn, fire, take damage, rotate, rematch |
| `node scripts/chaos-test.mjs` | ⚡ Chaos protocol test (start the dev server with `CHAOS_DURATION_MS=12000 CHAOS_COOLDOWN_MS=1500 CHAOS_WIND_MS=3000 CHAOS_RESPAWN_MS=2500` for speed) |
| `node scripts/spawn-random-test.mjs` | 🎲 Verifies spawn assignment is shuffled every round, never join order |
| `node scripts/<name>` | More focused probes live in `scripts/`: fairness, crates, teleports, host-reclaim, power-visibility… |

## Architecture

| Path | Role |
| --- | --- |
| `server.js` | Custom Node server: rooms/lobby **and** the authoritative game - terrain bitmap, 10 Hz tick (turn timers, drops, crate physics), validated `fire`/`blast`/`pass-turn` events |
| `components/Game.jsx` | The game: renderer, physics, input, effects, sound hooks. Mirrors server state online; runs everything locally in solo/hot-seat |
| `lib/terrain.mjs` | Seeded terrain engine: generation, destruction, floating-island cleanup, sky reflow, painter |
| `lib/tank.mjs` | Procedural tank drawing (palettes, barrel pivot, suspension, wheels) |
| `lib/fx.mjs` | Particle engine (smoke drifts with wind) |
| `lib/bonus.mjs` | Supply-drop definitions + weighted loot table |
| `lib/ai.mjs` | 🤖 CPU opponent: ballistic solver + per-difficulty aim error |
| `lib/sfx.mjs` | Procedural WebAudio sound effects, zero assets |
| `lib/socket.js` | Client socket singleton (auto-reconnect) + stable per-tab client id |
| `components/Room.jsx` | Lobby + mode dispatch |
| `app/page.jsx` | Home: create room, solo, hot-seat, join by code |
| `scripts/smoke-test.mjs` | Session-layer end-to-end test |
| `scripts/mp-probe.mjs` | Game-protocol end-to-end test |

### Online model

The server is **authoritative**; clients send *intents* and render what they're told. The shooter simulates their own shell locally and reports impacts (`blast`); the server validates the shooter/phase, mutates its authoritative terrain bitmap, applies damage, and broadcasts the blast - which is the truth for everyone. Remote tanks lerp to streamed positions but still obey local footing so craters stay consistent. Late joiners replay a blast log (capped at 400) to reconstruct the terrain. `MIN_PLAYERS = 2` for real rooms; solo/hot-seat bypass with `{ dev: true }`.

### Realtime layer (Socket.IO)

Everything realtime rides one Socket.IO connection per tab - rooms, lobby, and the game itself. Each game lobby **is** a Socket.IO room, so messages never leak across games.

**Client → server events**

| Event | Payload | Notes |
| --- | --- | --- |
| `join-room` | `{ roomId, name, cid }` | Join/create a room - **ack callback** replies `{ ok, you, room }` or `{ ok: false, error }` |
| `leave-room` | - | Also runs automatically on `disconnect` |
| `start-game` | `{ dev?, ai? }` | Host only; `{ dev: true }` is the solo/hot-seat bypass (1-player rooms only) |
| `end-game` / `next-round` / `new-match` / `regen-terrain` | - | Host-only match controls |
| `set-rounds` / `set-mode` | `1\|3\|5\|7\|9`, `'classic'\|'chaos'` | Host-only lobby settings |
| `pass-turn` | - | Active player ends their turn early (Classic) |
| `tank-move` | `{ x, y, aim, s, fuel, para, palette }` | ~12 Hz position/aim stream - **power is deliberately excluded** (it's the shooter's secret) |
| `teleport` | `{ x }` | Spend a pending teleport; validated, nacked on refusal |
| `fire` | `{ a, p, kind }` | Validated: your turn? phase open? reload done? - nacked on refusal |
| `blast` | `{ x, y, r, scale, big }` | Shooter reports an impact; server carves terrain, applies damage, relays |
| `shot-done` | - | All shells resolved → settle → next turn (Classic) |

**Server → client events**

| Event | Carries |
| --- | --- |
| `room-state` | Lobby roster, host 👑, rounds, mode - on join/leave/settings changes |
| `game-state` | Full snapshot (tanks, HP, wind, crates, turn, match); `null` = back to lobby. Joiners get it **with the blast replay log** |
| `tank-move` | Relayed opponent positions - sent **volatile** (drop late packets; the next update supersedes them) |
| `fire` | A validated shot - every client simulates the shell locally |
| `blast` | Authoritative impact: `{ x, y, r, dmg[] }` + `src` so the shooter doesn't re-carve their own crater |
| `game-event` | One-off happenings: `drop`, `crate-land`, `crate-taken`, `crate-expire`, `crate-boom`, `teleport`, `tele-fizzle`, `respawn` |
| `fire-denied` / `teleport-denied` / `start-denied` | Targeted nacks - the client rolls back its optimistic move or learns why Start was refused |

**Socket.IO features in play**

- **Rooms & broadcast scoping** - `socket.join(roomId)`, `io.to(room)` (everyone), `socket.to(room)` (everyone *but* the sender), `socket.emit` (one player)
- **Acknowledgement callbacks** - `join-room` is request/response, so lobby errors ("Room is full", "Name is required") reach the UI
- **Volatile emits** - the 12 Hz `tank-move` relay may drop packets under load; stale positions are worthless anyway
- **Optimistic client + nacks** - shots/teleports happen instantly on your screen; a denial (`fire-denied`, `teleport-denied`) rolls them back
- **Auto-reconnect + stable identity** - a per-tab `cid` in `sessionStorage` survives reloads/blips, so the creator's 👑 always returns to them
- **Lifecycle hooks** - `disconnect` kills your tank in place mid-game (the war goes on); client `connect` re-joins the room
- **`socket.data`** - server-side per-connection state (which room this socket is in)
- **One port, one process** - Socket.IO shares the Next.js HTTP server; `/_next/*` HMR upgrades are forwarded so dev hot-reload coexists (`destroyUpgrade: false`)
- **WebSocket with fallback** - starts on HTTP long-polling, upgrades to WS; blocked-WS networks still work

## Deployment

The custom server needs a persistent Node process (websockets + in-memory rooms) - no serverless. Railway, Render, Fly.io, a VPS, or a container all work:

```bash
npm run build
npm start
```

## License

MIT.
