// ════════════════════════════════════════════════════════════════════
//  🎚️ Quality tiers - one knob set, three sources of truth:
//    · initial GUESS from device hints (weak hardware starts Low)
//    · runtime ADAPTATION from measured frame times (auto mode only)
//    · manual OVERRIDE from the HUD graphics button (persisted)
// ════════════════════════════════════════════════════════════════════

export const TIERS = {
  high: {
    dprCap: 2,               // render() DPR clamp
    smoothing: 'high',       // imageSmoothingQuality for the terrain blit
    shadowBlur: true,        // canvas drop shadows (pills/panels)
    particleCap: 1600,       // fx.cap
    emitScale: 1,            // fx emission multiplier
    windStreaks: 26,         // ambient sky speed-lines at full wind
    motes: 3,                // hero-beam motes
    frameCapMs: 0,           // 0 = uncapped rAF; 16 ≈ 60fps ceiling
    backdrop: true,          // DOM backdrop-filter frosted panels
  },
  low: {
    dprCap: 1,
    smoothing: 'low',
    shadowBlur: false,
    particleCap: 450,
    emitScale: 0.35,
    windStreaks: 8,
    motes: 0,
    frameCapMs: 16,
    backdrop: false,
  },
};

const PREF_KEY = 'bot-quality';

/** persisted mode: 'auto' | 'high' | 'low' (default 'auto') */
export function loadQualityMode() {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'high' || v === 'low' ? v : 'auto';
  } catch { return 'auto'; }
}
export function saveQualityMode(mode) {
  try { localStorage.setItem(PREF_KEY, mode); } catch { /* private mode etc. */ }
}

/** weak-device heuristics for the AUTO starting tier */
export function guessTier() {
  if (typeof navigator === 'undefined') return 'high';
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8; // Chrome-only; undefined elsewhere
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return (cores <= 4 || mem <= 4 || coarse) ? 'low' : 'high';
}

/** rolling frame-time window → adaptive tier decision (auto mode) */
export class QualityGovernor {
  constructor() {
    this.mode = loadQualityMode();
    this.tier = this.mode === 'auto' ? guessTier() : this.mode;
    this.samples = [];       // frame times (ms), ring of 90
    this.lastSwitch = 0;     // ms timestamp - cooldown so it cannot flap
    this.hotWindows = 0;     // consecutive slow windows
    this.coolSince = 0;      // sustained-fast timer for promotion
  }

  /** resolved knob set for the current tier */
  get knobs() { return TIERS[this.tier]; }

  /** manual override from the HUD button; returns the new mode */
  cycleMode() {
    this.mode = this.mode === 'auto' ? 'high' : this.mode === 'high' ? 'low' : 'auto';
    saveQualityMode(this.mode);
    if (this.mode !== 'auto') this.tier = this.mode;
    this.samples.length = 0; this.hotWindows = 0; this.coolSince = 0;
    return this.mode;
  }

  /**
   * Feed a measured frame time (ms). Two consecutive 90-frame windows above
   * ~22ms (<45fps) demote to Low; ~6s sustained below ~12ms promotes back to
   * High. 4s cooldown between switches. No-op outside auto mode.
   */
  sample(frameMs, now) {
    if (this.mode !== 'auto') return this.tier;
    const ss = this.samples;
    ss.push(frameMs);
    if (ss.length < 90) return this.tier;
    const sorted = [...ss].sort((x, y) => x - y);
    const median = sorted[45];
    ss.length = 0;
    if (now - this.lastSwitch < 4000) return this.tier; // cooldown
    if (median > 22 && this.tier === 'high') {
      if (++this.hotWindows >= 2) {
        this.tier = 'low'; this.lastSwitch = now; this.hotWindows = 0; this.coolSince = 0;
      }
    } else if (median > 22) {
      this.coolSince = 0; // still slow in Low - nothing lower to go
    } else if (median < 12 && this.tier === 'low') {
      if (!this.coolSince) this.coolSince = now;
      if (now - this.coolSince > 6000) { this.tier = 'high'; this.lastSwitch = now; this.coolSince = 0; }
    } else {
      this.hotWindows = 0; this.coolSince = 0;
    }
    return this.tier;
  }
}
