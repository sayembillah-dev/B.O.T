// ════════════════════════════════════════════════════════════════════
//  SFX - procedural sound effects via WebAudio. Zero audio assets:
//  every sound is synthesized (oscillators + filtered noise bursts).
//  Mute persists in localStorage. AudioContext is created lazily on
//  the first call (which always follows a user gesture in practice).
// ════════════════════════════════════════════════════════════════════

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
if (typeof window !== 'undefined') {
  try { muted = localStorage.getItem('tb-muted') === '1'; } catch { /* private mode */ }
}

function ac() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32; // comfortable default loudness
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem('tb-muted', muted ? '1' : '0'); } catch { /* ignore */ }
}
export function isMuted() { return muted; }

function env(g, t0, attack, peak, dur) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
}

function tone({ f0 = 440, f1 = null, t = 0.2, type = 'sine', peak = 0.5, when = 0 }) {
  const c = ac();
  if (!c || muted) return;
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, f0), t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + t);
  env(g, t0, 0.01, peak, t);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + t + 0.1);
}

function burst({ dur = 0.4, peak = 0.6, from = 1200, to = 200, when = 0 }) {
  const c = ac();
  if (!c || muted) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + when;
  const s = c.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(Math.max(40, from), t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
  const g = c.createGain();
  env(g, t0, 0.008, peak, dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t0); s.stop(t0 + dur + 0.1);
}

/** Play a named sound. All are tiny synth recipes - no files. */
export function sfx(name) {
  if (muted || typeof window === 'undefined') return;
  switch (name) {
    case 'shoot':   burst({ dur: 0.22, peak: 0.5, from: 2400, to: 300 }); tone({ f0: 170, f1: 55, t: 0.18, type: 'sine', peak: 0.5 }); break;
    case 'boom':    burst({ dur: 0.55, peak: 0.8, from: 1000, to: 90 });  tone({ f0: 90, f1: 28, t: 0.5, type: 'sine', peak: 0.7 }); break;
    case 'bigboom': burst({ dur: 1.4, peak: 1.0, from: 1400, to: 60 });   tone({ f0: 70, f1: 20, t: 1.2, type: 'sine', peak: 0.9 }); burst({ dur: 0.8, peak: 0.5, from: 5000, to: 800, when: 0.05 }); break;
    case 'split':   tone({ f0: 500, f1: 900, t: 0.12, type: 'square', peak: 0.22 }); break;
    case 'pickup':  tone({ f0: 660, t: 0.09, type: 'square', peak: 0.28 }); tone({ f0: 990, t: 0.14, type: 'square', peak: 0.28, when: 0.09 }); break;
    case 'heal':    tone({ f0: 520, t: 0.1, type: 'sine', peak: 0.32 }); tone({ f0: 780, t: 0.16, type: 'sine', peak: 0.32, when: 0.1 }); break;
    case 'jump':    tone({ f0: 280, f1: 520, t: 0.14, type: 'triangle', peak: 0.32 }); break;
    case 'turn':    tone({ f0: 440, t: 0.07, type: 'sine', peak: 0.22 }); tone({ f0: 587, t: 0.09, type: 'sine', peak: 0.2, when: 0.07 }); break;
    case 'thud':    burst({ dur: 0.12, peak: 0.38, from: 400, to: 120 }); break;
    case 'crunch':  burst({ dur: 0.18, peak: 0.42, from: 2000, to: 400 }); break;
    case 'deny':    tone({ f0: 220, t: 0.09, type: 'square', peak: 0.2 }); tone({ f0: 180, t: 0.12, type: 'square', peak: 0.2, when: 0.09 }); break;
    case 'drop':    tone({ f0: 880, f1: 620, t: 0.22, type: 'sine', peak: 0.18 }); break;
    case 'teleport': tone({ f0: 320, f1: 1500, t: 0.22, type: 'sine', peak: 0.3 }); tone({ f0: 1500, f1: 260, t: 0.24, type: 'sine', peak: 0.26, when: 0.16 }); break;
    case 'win':     [523, 659, 784, 1047].forEach((f, i) => tone({ f0: f, t: 0.18, type: 'triangle', peak: 0.3, when: i * 0.13 })); break;
    case 'tick':    tone({ f0: 700, t: 0.09, type: 'square', peak: 0.26 }); break; // pre-round "3, 2, 1" beat
    case 'go':      tone({ f0: 500, f1: 1000, t: 0.28, type: 'sawtooth', peak: 0.34 }); tone({ f0: 750, f1: 1500, t: 0.22, type: 'triangle', peak: 0.22, when: 0.03 }); break; // "FIGHT!"
    default: break;
  }
}
