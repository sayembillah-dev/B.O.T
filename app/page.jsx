'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { newRoomId } from '@/lib/roomId';

// ── main-menu entries: Multiplayer / Hot Seat / vs AI ─────────────────
const DIFFS = [
  { id: 'easy',   emoji: '😊', label: 'Easy',   cls: 'diff-easy',
    hint: 'partially accurate - learns to aim, often misses' },
  { id: 'medium', emoji: '😐', label: 'Medium', cls: 'diff-medium',
    hint: 'accurate sometimes - a fair fight' },
  { id: 'hard',   emoji: '😈', label: 'Hard',   cls: 'diff-hard',
    hint: 'accurate most of the time - repositions, grabs crates, finishes kills' },
];

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(null); // 'mp' | 'hot' | 'ai' | null
  const toggle = (k) => setOpen((cur) => (cur === k ? null : k));

  // 🌐 online room
  const createRoom = () => router.push(`/room/${newRoomId()}`);
  const joinByCode = (e) => {
    e.preventDefault();
    const raw = code.trim().toLowerCase();
    const match = raw.match(/\/room\/([a-z0-9]+)/); // accepts a full pasted URL too
    const id = (match ? match[1] : raw).replace(/[^a-z0-9]/g, '');
    if (id.length >= 4) router.push(`/room/${id}`);
  };

  // 🛋️ hot-seat: 2-4 local players share this one screen
  const hotSeat = (n) => router.push(`/room/${newRoomId()}?solo=1&local=${n}`);

  // 🤖 vs AI: solo room + a server-driven CPU tank of the chosen difficulty
  const vsAi = (diff) => router.push(`/room/${newRoomId()}?solo=1&ai=${diff}`);

  // 🛠️ dev shortcut - skip everything, straight into a practice game
  const soloDev = () => router.push(`/room/${newRoomId()}?solo=1`);

  const Row = ({ k, emoji, title, sub }) => (
    <button
      type="button"
      className={`menu-btn ${open === k ? 'open' : ''}`}
      onClick={() => toggle(k)}
      aria-expanded={open === k}
    >
      <span className="menu-ico">{emoji}</span>
      <span className="menu-text">
        <span className="menu-title">{title}</span>
        <span className="menu-sub">{sub}</span>
      </span>
      <span className="menu-chev">▾</span>
    </button>
  );

  return (
    <main className="container">
      <div className="card hero">
        <h1 className="logo">🛡️ B.O.T - battle of tanks</h1>
        <p className="tagline">
          Worms-style artillery on destructible terrain - wind, supply drops, special shells.
          <br />
          Online rooms, one-screen hot-seat, or a duel vs the CPU. No accounts.
        </p>

        <div className="menu">
          {/* 1️⃣ MULTIPLAYER */}
          <Row k="mp" emoji="🌐" title="Multiplayer" sub="online room - share a link, up to 8 players" />
          {open === 'mp' && (
            <div className="menu-panel">
              <button className="btn btn-primary btn-lg" onClick={createRoom}>
                🎲 Create a room
              </button>
              <div className="divider"><span>or join with a link / code</span></div>
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
          )}

          {/* 2️⃣ HOT SEAT */}
          <Row k="hot" emoji="🛋️" title="Hot Seat" sub="one screen, 2–4 players take turns" />
          {open === 'hot' && (
            <div className="menu-panel">
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                {[2, 3, 4].map((n) => (
                  <button key={n} className="btn" style={{ flex: 1 }} onClick={() => hotSeat(n)}>
                    🛋️ {n}P
                  </button>
                ))}
              </div>
              <p className="hint" style={{ marginTop: '0.5rem' }}>pass the keyboard - every turn is live</p>
            </div>
          )}

          {/* 3️⃣ VS AI */}
          <Row k="ai" emoji="🤖" title="vs AI" sub="turn-based duel against the computer" />
          {open === 'ai' && (
            <div className="menu-panel">
              <div className="diff-grid">
                {DIFFS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`btn diff-btn ${d.cls}`}
                    onClick={() => vsAi(d.id)}
                    title={d.hint}
                  >
                    {d.emoji} {d.label}
                  </button>
                ))}
              </div>
              <p className="hint" style={{ marginTop: '0.5rem' }}>
                🤖 the CPU aims with real ballistics, repositions, uses pickups - pick your poison
              </p>
            </div>
          )}
        </div>

        <button className="btn btn-ghost" style={{ marginTop: '1.1rem' }} onClick={soloDev}>
          🛠️ solo practice
        </button>
      </div>
    </main>
  );
}
