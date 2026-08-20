'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { newRoomId } from '@/lib/roomId';

// ── main-menu navigation: every mode is a direct button, no accordions ──────
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

  // 🌐 online rooms
  const createRoom = (mode) => () =>
    router.push(`/room/${newRoomId()}${mode ? `?mode=${mode}` : ''}`);
  const joinByCode = (e) => {
    e.preventDefault();
    const raw = code.trim().toLowerCase();
    const match = raw.match(/\/room\/([a-z0-9]+)/); // accepts a full pasted URL too
    const id = (match ? match[1] : raw).replace(/[^a-z0-9]/g, '');
    if (id.length >= 4) router.push(`/room/${id}`);
  };

  // 🛋️ hot-seat: 2-4 local players share this one screen
  const hotSeat = (n) => () => router.push(`/room/${newRoomId()}?solo=1&local=${n}`);

  // 🤖 vs AI: solo room + a server-driven CPU tank of the chosen difficulty
  const vsAi = (diff) => () => router.push(`/room/${newRoomId()}?solo=1&ai=${diff}`);

  // 🛠️ dev shortcut - skip everything, straight into a practice game
  const soloDev = () => router.push(`/room/${newRoomId()}?solo=1`);

  const Section = ({ emoji, title, sub, children }) => (
    <section className="menu-section">
      <div className="menu-head">
        <span className="menu-ico">{emoji}</span>
        <span className="menu-text">
          <span className="menu-title">{title}</span>
          <span className="menu-sub">{sub}</span>
        </span>
      </div>
      {children}
    </section>
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

        <nav className="menu" aria-label="game modes">
          {/* 🌐 MULTIPLAYER */}
          <Section emoji="🌐" title="Multiplayer" sub="online room - share a link, up to 8 players">
            <div className="menu-actions">
              <button className="btn btn-primary btn-lg" onClick={createRoom()}>
                🎯 Classic room
              </button>
              <button className="btn btn-lg btn-chaos" onClick={createRoom('chaos')}>
                ⚡ Chaos room
              </button>
            </div>
            <p className="hint" style={{ margin: '0.1rem 0 0' }}>
              🎯 turn-based artillery &nbsp;·&nbsp; ⚡ 3-minute real-time free-for-all, most damage wins
            </p>
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
          </Section>

          {/* 🛋️ HOT SEAT */}
          <Section emoji="🛋️" title="Hot Seat" sub="one screen, players take turns">
            <div className="menu-actions">
              {[2, 3, 4].map((n) => (
                <button key={n} className="btn" style={{ flex: 1 }} onClick={hotSeat(n)}>
                  🛋️ {n}P
                </button>
              ))}
            </div>
          </Section>

          {/* 🤖 VS AI */}
          <Section emoji="🤖" title="vs AI" sub="turn-based duel against the computer">
            <div className="diff-grid">
              {DIFFS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`btn diff-btn ${d.cls}`}
                  onClick={vsAi(d.id)}
                  title={d.hint}
                >
                  {d.emoji} {d.label}
                </button>
              ))}
            </div>
          </Section>
        </nav>

        <button className="btn btn-ghost" style={{ marginTop: '1.1rem' }} onClick={soloDev}>
          🛠️ solo practice
        </button>
      </div>
    </main>
  );
}
