'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import Game from '@/components/Game';

export default function Room({ roomId }) {
  const router = useRouter();
  const inputRef = useRef(null);
  const [joined, setJoined] = useState(false);
  const [players, setPlayers] = useState([]);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [hostId, setHostId] = useState(null);
  const [roundsTotal, setRoundsTotal] = useState(1);
  const [mode, setMode] = useState('classic'); // 'classic' turns | ⚡ 'chaos' real-time FFA
  const [myId, setMyId] = useState(null);
  const [status, setStatus] = useState('connecting'); // connecting | online | offline
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [gs, setGs] = useState(null); // game-state (null = lobby)
  const nameRef = useRef('');

  // ── SOLO DEV BYPASS: ?solo=1 skips the name prompt and auto-starts the
  //    game (server allows it via {dev:true} despite MIN_PLAYERS=2).
  //    Remove this block to restore pure multiplayer.
  const soloRef = useRef(false);
  const autoStartedRef = useRef(false);
  const modeParamRef = useRef(null);   // 🧪 dev: ?mode=chaos pre-picks the game mode
  const manualRef = useRef(false);     // 🧪 dev: ?manual=1 disables the solo auto-start
  const [localCount, setLocalCount] = useState(0); // hot-seat: ?local=N (2-4) on one screen

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const m = q.get('mode');
    if (m === 'chaos' || m === 'classic') modeParamRef.current = m;
    if (q.get('manual') === '1') manualRef.current = true;
    if (q.get('solo') === '1') {
      soloRef.current = true;
      const name = sessionStorage.getItem('player-name') || 'dev';
      nameRef.current = name;
      sessionStorage.setItem('player-name', name);
      const n = parseInt(q.get('local') || '0', 10);
      setLocalCount(Number.isFinite(n) ? Math.min(4, Math.max(0, n)) : 0);
      setJoined(true);
    } else if (q.get('name')) { // 🧪 dev/test: ?name=X joins straight away, no prompt
      const name = q.get('name').trim().slice(0, 20);
      if (name) {
        nameRef.current = name;
        sessionStorage.setItem('player-name', name);
        setJoined(true);
      }
    }
  }, []);

  // 🧪 dev: ?mode=chaos — the host pre-picks the mode before anyone starts
  useEffect(() => {
    if (joined && myId && modeParamRef.current) {
      getSocket()?.emit('set-mode', modeParamRef.current);
      modeParamRef.current = null; // once
    }
  }, [joined, myId]);

  useEffect(() => {
    if (soloRef.current && joined && myId && gs === null && !autoStartedRef.current && !manualRef.current) {
      autoStartedRef.current = true; // once per mount — don't restart after end-game
      getSocket()?.emit('start-game', { dev: true });
    }
  }, [joined, myId, gs]);
  // ── END SOLO DEV BYPASS ──

  useEffect(() => {
    const saved = sessionStorage.getItem('player-name');
    if (saved && inputRef.current) inputRef.current.value = saved;
  }, []);

  useEffect(() => {
    if (!joined) return;
    const socket = getSocket();
    if (!socket) return;

    const join = () => {
      socket.emit('join-room', { roomId, name: nameRef.current }, (res) => {
        if (!res?.ok) {
          setError(res?.error || 'Could not join the room.');
          setJoined(false);
          return;
        }
        setError('');
        setMyId(res.you.id);
        setPlayers(res.room.players);
        setMaxPlayers(res.room.maxPlayers);
        setHostId(res.room.hostId ?? null);
        setRoundsTotal(res.room.roundsTotal ?? 1);
        setMode(res.room.mode ?? 'classic');
      });
    };

    const onState = (state) => {
      setPlayers(state.players);
      setMaxPlayers(state.maxPlayers);
      setHostId(state.hostId ?? null);
      setRoundsTotal(state.roundsTotal ?? 1);
      setMode(state.mode ?? 'classic');
    };
    const onGame = (state) => setGs(state);
    const onConnect = () => {
      setStatus('online');
      join();
    };
    const onDisconnect = () => setStatus('offline');

    socket.on('room-state', onState);
    socket.on('game-state', onGame);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    if (socket.connected) {
      setStatus('online');
      join();
    } else {
      setStatus('connecting');
      socket.connect();
    }

    return () => {
      socket.emit('leave-room');
      socket.off('room-state', onState);
      socket.off('game-state', onGame);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [joined, roomId]);

  const submitName = (e) => {
    e.preventDefault();
    const trimmed = (inputRef.current?.value || '').trim().slice(0, 20);
    if (!trimmed) return;
    nameRef.current = trimmed;
    sessionStorage.setItem('player-name', trimmed);
    setError('');
    setJoined(true);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  // ---------- name prompt ----------
  if (!joined) {
    return (
      <main className="container">
        <div className="card">
          <p className="eyebrow">you&apos;re joining room</p>
          <h1 className="room-code">{roomId}</h1>
          <form onSubmit={submitName} className="stack">
            <label className="label" htmlFor="name">What should we call you?</label>
            <input
              id="name" ref={inputRef} className="input input-lg" placeholder="Your name…"
              defaultValue="" maxLength={20} required autoFocus autoComplete="off"
            />
            {error && <p className="error">{error}</p>}
            <button className="btn btn-primary btn-lg" type="submit">Enter room →</button>
          </form>
        </div>
      </main>
    );
  }

  // ---------- game (your component takes over) ----------
  if (gs && gs.phase && gs.phase !== 'lobby') {
    return <Game gs={gs} myId={myId} local={localCount} />;
  }

  // ---------- lobby ----------
  return (
    <main className="container">
      <div className="card card-wide">
        <div className="room-header">
          <div>
            <p className="eyebrow">room</p>
            <h1 className="room-code">{roomId}</h1>
          </div>
          <span className={`status status-${status}`}>
            <span className="dot" />
            {status === 'online' ? 'live' : status}
          </span>
        </div>

        <button className="share-box" onClick={copyLink} title="Copy invite link">
          <span className="share-url">{typeof window !== 'undefined' ? window.location.href : ''}</span>
          <span className="share-cta">{copied ? '✓ copied!' : '📋 copy link'}</span>
        </button>

        <div className="players-head">
          <h2>Players <span className="count">{players.length}/{maxPlayers}</span></h2>
        </div>

        {players.length === 0 ? (
          <p className="muted">Connecting…</p>
        ) : (
          <ul className="players-grid">
            {players.map((p) => (
              <li key={p.id} className={`player ${p.id === myId ? 'me' : ''}`}>
                <span className="player-emoji">{p.emoji}</span>
                <span className="player-name">{p.name}</span>
                {p.id === hostId && <span className="host-badge" title="Room master">👑</span>}
                {p.id === myId && <span className="you-badge">you</span>}
              </li>
            ))}
          </ul>
        )}

        {myId && myId === hostId ? (
          <>
            <div className="rounds-picker" style={{ marginTop: '1.5rem' }}>
              <span className="rounds-label">🎮 Mode</span>
              <button
                type="button"
                className={`round-chip ${mode === 'classic' ? 'active' : ''}`}
                title="Turn-based artillery — aim, charge, fire, next player"
                onClick={() => getSocket()?.emit('set-mode', 'classic')}
              >
                ⚔️ Classic
              </button>
              <button
                type="button"
                className={`round-chip ${mode === 'chaos' ? 'active' : ''}`}
                title="Real-time free-for-all — everyone moves at once, infinite shells, 3s reload, 3-minute clock"
                onClick={() => getSocket()?.emit('set-mode', 'chaos')}
              >
                ⚡ Chaos
              </button>
            </div>
            <div className="rounds-picker" style={{ marginTop: '0.6rem' }}>
              <span className="rounds-label">🎯 Rounds</span>
              {[1, 3, 5, 7].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`round-chip ${roundsTotal === n ? 'active' : ''}`}
                  onClick={() => getSocket()?.emit('set-rounds', n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              className="btn btn-primary btn-lg"
              style={{ marginTop: '1.25rem' }}
              disabled={players.length < 2 || status !== 'online'}
              onClick={() => getSocket()?.emit('start-game')}
            >
              {mode === 'chaos' ? '⚡ Start chaos' : '🎮 Start game'}
            </button>
            <p className="hint">
              {players.length < 2
                ? 'Share the link — you need at least 2 players to start.'
                : mode === 'chaos'
                  ? `⚡ Chaos: everyone moves at once — infinite shells, 3s reload, 3-minute clock. Last tank standing, else most HP wins.${roundsTotal > 1 ? ` Best of ${roundsTotal}.` : ''}`
                  : roundsTotal > 1
                    ? `Best of ${roundsTotal} — most round wins takes the match.`
                    : 'Everyone is in! Start when ready.'}
            </p>
          </>
        ) : (
          <p className="hint" style={{ marginTop: '1.25rem' }}>
            👑 <strong>{players.find((p) => p.id === hostId)?.name ?? 'The host'}</strong> is the room master
            {mode === 'chaos' ? ' — ⚡ CHAOS mode' : ''}{roundsTotal > 1 ? ` — best of ${roundsTotal} rounds` : ''}. Waiting for them to start the game…
          </p>
        )}

        <button className="btn btn-ghost" onClick={() => router.push('/')}>← Leave room</button>
      </div>
    </main>
  );
}
