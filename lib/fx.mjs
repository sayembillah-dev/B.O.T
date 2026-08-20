// ════════════════════════════════════════════════════════════════════
//  FX - lightweight particle engine. Pooled, capped, plain-arc drawing
//  (no per-particle gradients → fast). Two PHYSICAL layers: `back`
//  (smoke, behind tanks) and `front` (fire, dirt, flashes, rings) -
//  split arrays so a draw pass never walks the wrong layer, and each
//  pass is ordered source-over → lighter so globalCompositeOperation
//  flips twice per frame instead of once per particle (5b).
//  fx.wind ∈ [-1,1] - smoke drifts sideways with the wind.
//  fx.cap / fx.emitScale - quality-tier knobs (lib/quality.mjs).
// ════════════════════════════════════════════════════════════════════

const R = Math.random;
const isBack = (t) => t === 'smoke';
// hot particles blend additively - sparks/fire/flashes/rings pop like light
const isAdd = (t) => t === 'spark' || t === 'flash' || t === 'ring' || t === 'fire';

export class FX {
  constructor() {
    this.back = [];   // smoke
    this.front = [];  // fire, dirt, flash, ring, spark, text
    this.wind = 0;
    this.cap = 1600;       // headroom so a tomahawk mushroom can't evict itself (Low tier: 450)
    this.emitScale = 1;    // emission multiplier (Low tier: 0.35)
  }

  /** total live particles (both layers) */
  get length() { return this.back.length + this.front.length; }

  add(p) {
    p.max = p.life;
    const arr = isBack(p.t) ? this.back : this.front;
    if (arr.length >= this.cap) { // evict the oldest - swap-and-pop, no splice
      arr[0] = arr[arr.length - 1];
      arr.pop();
    }
    arr.push(p);
  }

  /** emission count scaled to the quality tier (always ≥1 when the base is ≥1) */
  n(count) { return Math.max(1, Math.round(count * this.emitScale)); }

  // gray puff - used by muzzle, missile trail, explosion linger.
  // `a` overrides the default smoke opacity (the mushroom cloud wants denser puffs).
  smoke(x, y, vx, vy, size, life = 1.5, color, a) {
    this.add({ t: 'smoke', x, y, vx, vy, size, grow: 14 + R() * 10, life, color, a });
  }

  muzzle(x, y, ang) {
    for (let i = 0; i < this.n(9); i++) { // smoke cone along the barrel
      const a = ang + (R() - 0.5) * 0.7;
      const v = 40 + R() * 90;
      this.smoke(x, y, Math.cos(a) * v, Math.sin(a) * v - 15, 4 + R() * 5, 0.9 + R() * 0.7);
    }
    for (let i = 0; i < this.n(7); i++) { // spark flash
      const a = ang + (R() - 0.5) * 0.5;
      const v = 250 + R() * 300;
      this.add({ t: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: 1.6, life: 0.14 + R() * 0.1 });
    }
  }

  trail(x, y, vx, vy) {
    // lighter + quicker: one small short-lived puff (was bigger/longer)
    this.smoke(x, y, -vx * 0.05 + (Math.random() - 0.5) * 14, -vy * 0.05 - 8, 1.6 + Math.random() * 1.2, 0.45 + R() * 0.3);
  }

  boom(x, y) {
    this.add({ t: 'flash', x, y, size: 8, grow: 420, life: 0.16 });
    this.add({ t: 'ring', x, y, size: 12, grow: 330, life: 0.45 });
    for (let i = 0; i < this.n(22); i++) { // fireball
      const a = R() * Math.PI * 2, v = 60 + R() * 260;
      this.add({ t: 'fire', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, size: 3 + R() * 5, life: 0.35 + R() * 0.35 });
    }
    for (let i = 0; i < this.n(18); i++) { // flying dirt
      const a = -Math.PI * R(), v = 120 + R() * 340;
      const s = 2 + R() * 3.4;
      this.add({ t: 'dirt', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: s, life: 0.7 + R() * 0.7 });
    }
    for (let i = 0; i < this.n(13); i++) { // lingering smoke column
      this.smoke(x + (R() - 0.5) * 30, y + (R() - 0.5) * 20, (R() - 0.5) * 30, -30 - R() * 50, 7 + R() * 8, 1.8 + R() * 1.2);
    }
  }

  // ☢️ tomahawk: MASSIVE slow-burn mushroom cloud - a wide heavy ground skirt,
  // a fat stem that climbs lazily, a huge billowing cap, a long-lived fire
  // core, white-hot sparks. Everything is slower and longer-lived than a
  // normal boom - the thing just keeps going. Insane by design.
  mushroom(x, y) {
    const CAP = 390;            // how high the cap floats above the impact point
    // ground dust skirt punching outward along the surface (slow and heavy)
    for (let i = 0; i < this.n(36); i++) {
      const dir = R() < 0.5 ? -1 : 1;
      const v = 90 + R() * 200;
      this.smoke(x + dir * R() * 50, y - R() * 16, dir * v, -10 - R() * 22,
        20 + R() * 20, 3.6 + R() * 2.0, 'rgb(172,156,136)', 0.55);
    }
    // stem column - fat, climbing slowly, thickening as it rises
    const stem = this.n(64);
    for (let i = 0; i < stem; i++) {
      const t = i / stem;
      this.smoke(x + (R() - 0.5) * 44, y - t * CAP, (R() - 0.5) * 24, -95 - R() * 75,
        20 + t * 38, 3.8 + R() * 1.8, 'rgb(198,180,158)', 0.6);
    }
    // cap - very wide torus billowing outward and slowly curling over
    for (let i = 0; i < this.n(92); i++) {
      const a = R() * Math.PI * 2, rr = 50 + R() * 165;
      this.smoke(x + Math.cos(a) * rr * 2.1, y - CAP + Math.sin(a) * rr * 0.5,
        Math.cos(a) * (55 + R() * 55), -34 - R() * 32,
        30 + R() * 30, 4.6 + R() * 2.4, 'rgb(224,206,182)', 0.62);
    }
    // darker under-shadow of the cap so it reads as a solid mass
    for (let i = 0; i < this.n(36); i++) {
      const a = R() * Math.PI * 2, rr = R() * 170;
      this.smoke(x + Math.cos(a) * rr * 1.9, y - CAP + 62 + Math.sin(a) * rr * 0.32,
        Math.cos(a) * 40, -26 - R() * 22, 28 + R() * 26, 4.0 + R() * 1.8, 'rgb(148,130,110)', 0.55);
    }
    // fire core climbing the stem - big, lazy, long-lived
    for (let i = 0; i < this.n(60); i++) {
      const a = R() * Math.PI * 2, v = 40 + R() * 160;
      this.add({ t: 'fire', x: x + (R() - 0.5) * 40, y: y - R() * 190,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120,
        size: 12 + R() * 16, life: 1.5 + R() * 1.3 });
    }
    // white-hot sparks thrown way out
    for (let i = 0; i < this.n(42); i++) {
      const a = R() * Math.PI * 2, v = 260 + R() * 460;
      this.add({ t: 'spark', x, y: y - R() * 60, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120,
        size: 2 + R() * 1.6, life: 0.5 + R() * 0.6 });
    }
    // heavy dirt thrown clear of the crater
    for (let i = 0; i < this.n(44); i++) {
      const a = -Math.PI * R(), v = 200 + R() * 480;
      this.add({ t: 'dirt', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        size: 3.4 + R() * 5.6, life: 1.6 + R() * 1.3 });
    }
    this.add({ t: 'flash', x, y, size: 60, grow: 1300, life: 0.55 });
  }

  text(x, y, txt, color = '#ffd75e') { // floating popup (damage numbers etc.)
    this.add({ t: 'text', x, y, vx: 0, vy: -46, size: 15, life: 1.15, txt, color });
  }

  #step(ps, dt) {
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { // swap-and-pop - no splice re-allocation
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grow) p.size += p.grow * dt;
      switch (p.t) {
        case 'smoke': p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) - 22 * dt; p.vx += (this.wind || 0) * 26 * dt; break;
        case 'dirt': p.vy += 800 * dt; break;
        case 'fire': p.vx *= 1 - 2.4 * dt; p.vy *= 1 - 2.4 * dt; p.size *= 1 - 1.8 * dt; break;
        case 'spark': p.vx *= 1 - 3 * dt; p.vy *= 1 - 3 * dt; break;
      }
    }
  }

  update(dt) {
    this.#step(this.back, dt);
    this.#step(this.front, dt);
  }

  #drawOne(ctx, p) {
    const f = p.life / p.max; // 1 → 0
    if (p.t === 'text') {
      ctx.globalAlpha = Math.min(1, f * 3);
      ctx.font = `bold ${p.size}px system-ui`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(40,20,10,0.85)';
      ctx.strokeText(p.txt, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.txt, p.x, p.y);
      return;
    }
    let color, alpha;
    switch (p.t) {
      case 'smoke': alpha = (p.a ?? 0.34) * Math.sin(Math.PI * Math.min(1, f * 1.15)); color = p.color || 'rgb(198,198,190)'; break;
      case 'fire': alpha = Math.min(1, f * 2); color = f > 0.55 ? 'rgb(255,214,120)' : f > 0.25 ? 'rgb(255,130,60)' : 'rgb(160,60,40)'; break;
      case 'dirt': alpha = Math.min(1, f * 2.2); color = 'rgb(96,64,38)'; break;
      case 'spark': alpha = f; color = 'rgb(255,236,170)'; break;
      case 'flash': alpha = f; color = 'rgb(255,244,205)'; break;
      case 'ring': alpha = f * 0.8; color = p.color || 'rgb(255,220,150)'; break;
      default: alpha = f; color = '#fff';
    }
    ctx.globalAlpha = alpha;
    if (p.t === 'ring') {
      ctx.strokeStyle = color; ctx.lineWidth = 3 + 4 * f;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, p.size), 0, Math.PI * 2); ctx.fill();
    }
  }

  /** draw one layer; plain passes first, additive passes last - TWO
   *  globalCompositeOperation changes per frame instead of one per particle */
  draw(ctx, layer) {
    const ps = layer === 'back' ? this.back : this.front;
    if (!ps.length) return;
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < ps.length; i++) if (!isAdd(ps[i].t)) this.#drawOne(ctx, ps[i]);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < ps.length; i++) if (isAdd(ps[i].t)) this.#drawOne(ctx, ps[i]);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}
