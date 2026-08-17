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
  const [myId, setMyId] = useState(null);
  const [status, setStatus] = useState('connecting'); // connecting | online | offline
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [gs, setGs] = useState(null); // game-state (null = lobby)
  const nameRef = useRef('');

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
      });
    };

    const onState = (state) => {
      setPlayers(state.players);
      setMaxPlayers(state.maxPlayers);
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
    return <Game gs={gs} myId={myId} />;
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
                {p.id === myId && <span className="you-badge">you</span>}
              </li>
            ))}
          </ul>
        )}

        <button
          className="btn btn-primary btn-lg"
          style={{ marginTop: '1.25rem' }}
          disabled={players.length < 2 || status !== 'online'}
          onClick={() => getSocket()?.emit('start-game')}
        >
          🎮 Start game
        </button>
        <p className="hint">
          {players.length < 2
            ? 'Share the link — you need at least 2 players to start.'
            : 'Everyone is in! Start when ready.'}
        </p>

        <button className="btn btn-ghost" onClick={() => router.push('/')}>← Leave room</button>
      </div>
    </main>
  );
}
