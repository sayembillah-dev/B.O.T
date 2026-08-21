'use client';

import { io } from 'socket.io-client';

let socket = null;

/** Singleton socket (browser only). Same-origin, auto-reconnect enabled. */
export function getSocket() {
  if (typeof window === 'undefined') return null;
  if (!socket) socket = io();
  return socket;
}

/**
 * Stable client id (localStorage): survives page reloads, NEW TABS, tab/browser
 * restarts and socket reconnects - so the room creator's crown 👑 always finds
 * its way back. One human = one player across tabs of this browser: a second
 * tab joining the same room rebinds (server evicts the stale entry, crown
 * follows) instead of spawning a phantom twin. Tests still pass explicit cids.
 */
export function getClientId() {
  if (typeof window === 'undefined') return null;
  // migrate legacy per-tab id so an in-flight session keeps its identity once
  let cid = localStorage.getItem('player-cid') || sessionStorage.getItem('player-cid');
  if (!cid) {
    cid = globalThis.crypto?.randomUUID?.() ?? `1787346801187-${Math.random().toString(36).slice(2)}`;
  }
  try { localStorage.setItem('player-cid', cid); } catch { /* storage blocked - play on */ }
  return cid;
}
