'use client';

import { getSocket } from '@/lib/socket';

/**
 * 🚧 PLACEHOLDER GAME SCREEN — replace this file with your game.
 *
 * You get:
 *   gs   = latest authoritative game-state broadcast from server.js
 *   myId = your socket id  →  gs.players.find(p => p.id === myId) is you
 *
 * Talk to the server:
 *   getSocket().emit('your-event', payload)    → handle it in server.js (GAME HOOK)
 *   getSocket().on('your-broadcast', handler)  → remember .off() in the cleanup
 *
 * The server broadcasts game-state; whenever its phase is not 'lobby',
 * Room.jsx renders this component instead of the lobby.
 */
export default function Game({ gs, myId }) {
  return (
    <main className="container">
      <div className="card card-wide">
        <h1 className="logo">🎮 game on!</h1>
        <p className="tagline">
          This is the placeholder screen. Swap <code>components/Game.jsx</code> for your game
          and extend the GAME HOOK section in <code>server.js</code>.
        </p>

        <ul className="players-grid">
          {gs?.players?.map((p) => (
            <li key={p.id} className={`player ${p.id === myId ? 'me' : ''}`}>
              <span className="player-emoji">{p.emoji}</span>
              <span className="player-name">{p.name}</span>
              {p.id === myId && <span className="you-badge">you</span>}
            </li>
          ))}
        </ul>

        <details className="debug-state">
          <summary>raw game-state (debug)</summary>
          <pre>{JSON.stringify(gs, null, 2)}</pre>
        </details>

        <button className="btn btn-primary btn-lg" onClick={() => getSocket()?.emit('end-game')}>
          🏁 End game → back to lobby
        </button>
      </div>
    </main>
  );
}
