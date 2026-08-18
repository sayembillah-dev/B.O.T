'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { newRoomId } from '@/lib/roomId';

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState('');

  const createRoom = () => {
    router.push(`/room/${newRoomId()}`);
  };

  // ── SOLO DEV BYPASS — skip lobby, straight into a practice game ──
  const soloDev = () => {
    router.push(`/room/${newRoomId()}?solo=1`);
  };

  // ── HOT-SEAT (one-screen turn-based): 2-4 local players share this screen ──
  const hotSeat = (n) => {
    router.push(`/room/${newRoomId()}?solo=1&local=${n}`);
  };

  const joinByCode = (e) => {
    e.preventDefault();
    const raw = code.trim().toLowerCase();
    const match = raw.match(/\/room\/([a-z0-9]+)/); // accepts a full pasted URL too
    const id = (match ? match[1] : raw).replace(/[^a-z0-9]/g, '');
    if (id.length >= 4) router.push(`/room/${id}`);
  };

  return (
    <main className="container">
      <div className="card hero">
        <h1 className="logo">🛡️ B.O.T - battle of tanks</h1>
        <p className="tagline">
          Worms-style artillery on destructible terrain — wind, supply drops, special shells.
          <br />
          Online rooms or one-screen hot-seat. No accounts.
        </p>

        <button className="btn btn-primary btn-lg" onClick={createRoom}>
          🎲 Create a room
        </button>

        <button className="btn btn-lg" onClick={soloDev} style={{ marginTop: '0.75rem' }}>
          🛠️ Solo practice
        </button>
        <p className="hint" style={{ marginTop: '0.25rem' }}>dev shortcut — skips the lobby</p>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '0.5rem' }}>
          {[2, 3, 4].map((n) => (
            <button key={n} className="btn" onClick={() => hotSeat(n)}>
              🛋️ {n}P
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: '0.25rem' }}>hot-seat — one screen, take turns</p>

        <div className="divider">
          <span>or join with a link / code</span>
        </div>

        <form onSubmit={joinByCode} className="join-form">
          <input
            className="input"
            placeholder="Paste room link or code…"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
          />
          <button className="btn" type="submit" disabled={code.trim().length < 4}>
            Join →
          </button>
        </form>
      </div>
    </main>
  );
}
