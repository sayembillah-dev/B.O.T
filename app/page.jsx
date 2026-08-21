'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { newRoomId } from '@/lib/roomId';
import { GiBattleTank } from 'react-icons/gi';
import {
  LuGlobe, LuCrosshair, LuZap, LuArmchair, LuUsers,
  LuBot, LuSmile, LuMeh, LuSkull, LuLogIn, LuWrench,
} from 'react-icons/lu';

// ── main-menu navigation: every mode is a direct button, no accordions ──────
const DIFFS = [
  { id: 'easy',   Icon: LuSmile, label: 'Easy',   cls: 'diff-easy',
    hint: 'partially accurate - learns to aim, often misses' },
  { id: 'medium', Icon: LuMeh,   label: 'Medium', cls: 'diff-medium',
    hint: 'accurate sometimes - a fair fight' },
  { id: 'hard',   Icon: LuSkull, label: 'Hard',   cls: 'diff-hard',
    hint: 'accurate most of the time - repositions, grabs crates, finishes kills' },
];

// module-level (NOT inside Home) - a component re-created on each render makes
// React remount its subtree, which was stealing input focus on every keystroke
const Section = ({ icon: Ico, title, sub, children }) => (
  <section className="menu-section">
    <div className="menu-head">
      <span className="menu-ico"><Ico /></span>
      <span className="menu-text">
        <span className="menu-title">{title}</span>
        <span className="menu-sub">{sub}</span>
      </span>
    </div>
    {children}
  </section>
);

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

  return (
    <main className="landing">
      {/* 🖼️ key art: full height, slightly zoomed, right edge fades into the black bg */}
      <div className="landing-art" aria-hidden="true">
        <img className="landing-img" src="/landing.png" alt="" />
        <div className="landing-fade" />
      </div>

      {/* 🎮 menu column on the right */}
      <div className="landing-menu">
        <header className="landing-head">
          <h1 className="logo"><GiBattleTank className="logo-ico" /> B.O.T - battle of tanks</h1>
          <p className="tagline">
            Worms-style artillery on destructible terrain - wind, supply drops, special shells.
            Online rooms, one-screen hot-seat, or a duel vs the CPU. No accounts.
          </p>
        </header>

        <nav className="menu" aria-label="game modes">
          {/* MULTIPLAYER */}
          <Section icon={LuGlobe} title="Multiplayer" sub="online room - share a link, up to 8 players">
            <div className="menu-actions stack">
              <button className="btn btn-primary btn-lg" onClick={createRoom()}>
                <LuCrosshair /> Classic room
              </button>
              <button className="btn btn-lg btn-chaos" onClick={createRoom('chaos')}>
                <LuZap /> Chaos room
              </button>
            </div>
            <p className="hint" style={{ margin: '0.1rem 0 0' }}>
              <LuCrosshair className="hint-ico" /> turn-based artillery &nbsp;·&nbsp;
              <LuZap className="hint-ico" /> 3-minute real-time free-for-all, most damage wins
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
                Join <LuLogIn />
              </button>
            </form>
          </Section>

          {/* HOT SEAT */}
          <Section icon={LuArmchair} title="Hot Seat" sub="one screen, players take turns">
            <div className="menu-actions">
              {[2, 3, 4].map((n) => (
                <button key={n} className="btn" style={{ flex: 1 }} onClick={hotSeat(n)}>
                  <LuUsers /> {n}P
                </button>
              ))}
            </div>
          </Section>

          {/* VS AI */}
          <Section icon={LuBot} title="vs AI" sub="turn-based duel against the computer">
            <div className="diff-grid">
              {DIFFS.map(({ id, Icon, label, cls, hint }) => (
                <button
                  key={id}
                  type="button"
                  className={`btn diff-btn ${cls}`}
                  onClick={vsAi(id)}
                  title={hint}
                >
                  <Icon /> {label}
                </button>
              ))}
            </div>
          </Section>
        </nav>

        <button className="btn btn-ghost" onClick={soloDev}>
          <LuWrench /> solo practice
        </button>
      </div>
    </main>
  );
}
