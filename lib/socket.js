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
 * Stable per-tab client id (sessionStorage): survives page reloads, dev
 * fast-refresh and socket reconnects - so the room creator's crown 👑 can
 * return to them after any blip. Deliberately NOT localStorage: two tabs on
 * one browser (test setup) must stay distinct players.
 */
export function getClientId() {
  if (typeof window === 'undefined') return null;
  let cid = sessionStorage.getItem('player-cid');
  if (!cid) {
    cid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('player-cid', cid);
  }
  return cid;
}
