'use client';

import { io } from 'socket.io-client';

let socket = null;

/** Singleton socket (browser only). Same-origin, auto-reconnect enabled. */
export function getSocket() {
  if (typeof window === 'undefined') return null;
  if (!socket) socket = io();
  return socket;
}
