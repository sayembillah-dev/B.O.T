# 🛡️ tank battle

Worms-style artillery on fully destructible terrain — wind, supply drops, special shells, hot-seat or online rooms. Everything is procedural: terrain, tanks, particles, even the sound effects. Zero art assets, zero accounts, zero database.

Built on the multiplayer-room-starter session layer (rooms, lobby, reconnects, server authority) — the game itself is all custom.

## Game modes

| Mode | How |
| --- | --- |
| **Online rooms** | Create a room, send the invite link, 2+ players, server-authoritative match |
| **Solo practice** | One click from the home page (`?solo=1`) |
| **Hot-seat 2–4P** | One screen, shared keyboard/mouse (`?solo=1&local=N`) |
| **Spectating** | Join a room mid-game — you watch until the next rematch |

## Features

- **Destructible seeded terrain** — per-pixel bitmap, caves, floating-island cleanup, deterministic from a seed
- **Wind** — re-rolled every turn, pushes shells, drifting smoke shows it, guided missiles resist it
- **Supply drops** — parachute crates fall from the sky (never near players): ×2/×3 damage buffs, cluster shells, +10/+15 HP, rare guided missiles and tomahawks
- **Four shell types** — normal, cluster (splits into 3), guided (homing, super rare), tomahawk (insane blast, mushroom cloud, white flash, screen shake)
- **Tank physics** — tangent-space driving, hydraulic suspension, spinning wheels, fuel management, jumps
- **Turn rules** — 15-second turns, park to charge your shot, Enter to pass
- **360° instant aim** — full barrel pivot, no tunneling, no floating terrain, no water
- **Procedural SFX** — pure WebAudio oscillators/noise, mutable, persisted (`M` or the 🔊 button)
- **Server-authoritative online** — the server owns the terrain bitmap, damage, drops, and turn timers; clients render what they're told
- **Rematch, elimination, 💀 ghost tanks, winner crown** — full match loop

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
| `node scripts/mp-probe.mjs` | Full multiplayer protocol test: 2 headless clients play a turn, fire, take damage, rotate, rematch |

## Architecture

| Path | Role |
| --- | --- |
| `server.js` | Custom Node server: rooms/lobby **and** the authoritative game — terrain bitmap, 10 Hz tick (turn timers, drops, crate physics), validated `fire`/`blast`/`pass-turn` events |
| `components/Game.jsx` | The game: renderer, physics, input, effects, sound hooks. Mirrors server state online; runs everything locally in solo/hot-seat |
| `lib/terrain.mjs` | Seeded terrain engine: generation, destruction, floating-island cleanup, sky reflow, painter |
| `lib/tank.mjs` | Procedural tank drawing (palettes, barrel pivot, suspension, wheels) |
| `lib/fx.mjs` | Particle engine (smoke drifts with wind) |
| `lib/bonus.mjs` | Supply-drop definitions + weighted loot table |
| `lib/sfx.mjs` | Procedural WebAudio sound effects, zero assets |
| `lib/socket.js` | Client socket singleton with auto-reconnect |
| `components/Room.jsx` | Lobby + mode dispatch |
| `app/page.jsx` | Home: create room, solo, hot-seat, join by code |
| `scripts/smoke-test.mjs` | Session-layer end-to-end test |
| `scripts/mp-probe.mjs` | Game-protocol end-to-end test |

### Online model

The shooter simulates their own shell locally and reports impacts (`blast`); the server validates the shooter/phase, mutates its authoritative terrain bitmap, applies damage, and broadcasts the blast — which is the truth for everyone. Remote tanks lerp to streamed positions but still obey local footing so craters stay consistent. Late joiners replay a blast log (capped at 400) to reconstruct the terrain. `MIN_PLAYERS = 2` for real rooms; solo/hot-seat bypass with `{ dev: true }`.

## Deployment

The custom server needs a persistent Node process (websockets + in-memory rooms) — no serverless. Railway, Render, Fly.io, a VPS, or a container all work:

```bash
npm run build
npm start
```

## License

MIT.
