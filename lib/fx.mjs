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

import { shades, TANK_PALETTES } from './tank.mjs';

const R = Math.random;
const isBack = (t) => t === 'smoke';
// hot particles blend additively - sparks/fire/flashes/rings pop like light
const isAdd = (t) => t === 'spark' || t === 'flash' || t === 'ring' || t === 'fire' || t === 'flame';

export class FX {
  constructor() {
    this.back = [];   // smoke
    this.front = [];  // fire, dirt, flash, ring, spark, text
    this.wind = 0;
    this.cap = 1600;       // headroom so a tomahawk mushroom can't evict itself (Low tier: 450)
    this.emitScale = 1;    // emission multiplier (Low tier: 0.35)
    this.solidAt = null;   // optional (x, y) => bool terrain probe - wreck parts bounce on it
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

  // ?? TANK DESTROYED - the big one. A realistic white-core fireball rolling
  //  yellow -> orange -> red as it cools, white-hot shrapnel streaks, an oily
  //  black smoke column... and the tank itself blown apart: hull, turret,
  //  barrel, both track halves and loose wheels tumble outward with real
  //  gravity, bounce off the terrain, then FADE OUT over 2s (PART_LIFE).
  //  y = the tank's ground point; palette tints the wreckage like the tank.
  tankBoom(x, y, palette = 0) {
    const pal = ((palette % TANK_PALETTES.length) + TANK_PALETTES.length) % TANK_PALETTES.length;
    const c = shades(TANK_PALETTES[pal]);
    const cy = y - 14; // mid-hull - the ammo rack going up
    this.add({ t: 'flash', x, y: cy, size: 26, grow: 1250, life: 0.3 }); // white-hot core
    this.add({ t: 'ring', x, y: cy, size: 14, grow: 660, life: 0.55 });  // shockwave
    for (let i = 0; i < this.n(46); i++) { // main fireball - big rolling flames
      const a = R() * Math.PI * 2, v = 34 + R() * 270;
      this.add({ t: 'flame', x: x + (R() - 0.5) * 24, y: cy + (R() - 0.5) * 15,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 135, size: 8.5 + R() * 12, life: 0.6 + R() * 0.55 });
    }
    for (let i = 0; i < this.n(14); i++) { // secondary fuel fire licking the wreck site
      this.add({ t: 'flame', x: x + (R() - 0.5) * 40, y: cy + (R() - 0.5) * 10,
        vx: (R() - 0.5) * 60, vy: -70 - R() * 95, size: 4.6 + R() * 5.4, life: 1.1 + R() * 0.8 });
    }
    for (let i = 0; i < this.n(36); i++) { // white-hot shrapnel streaks
      const a = R() * Math.PI * 2, v = 330 + R() * 560;
      this.add({ t: 'spark', x, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 95, size: 2 + R() * 1.6, life: 0.3 + R() * 0.4 });
    }
    for (let i = 0; i < this.n(22); i++) { // thick oily smoke rising off the wreck
      this.smoke(x + (R() - 0.5) * 36, cy - R() * 14, (R() - 0.5) * 44, -50 - R() * 65, 10 + R() * 11, 2.2 + R() * 1.2, 'rgb(52,46,44)', 0.5);
    }
    for (let i = 0; i < this.n(14); i++) { // crater dirt
      const a = -Math.PI * R(), v = 190 + R() * 360;
      this.add({ t: 'dirt', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: 2.8 + R() * 3.4, life: 0.8 + R() * 0.6 });
    }

    // ?? the tank, dislocated: hull, turret (the classic pop), barrel, both
    //  track halves, three loose wheels - always all 8 parts, never scaled
    //  down by the quality tier. Holds FULL opacity for 2s, then fades out
    //  over 0.8s - gone at 2.8s (fade-out lives in #drawPart)
    const L = 2.8;
    const kick = (vxBias = 0) => ({ vx: vxBias + (R() - 0.5) * 300, vy: -260 - R() * 300, rot: 0, vr: (R() - 0.5) * 26 });
    this.add({ t: 'part', kind: 'hull',   x,          y: y - 16,   c, life: L, ...kick() });
    this.add({ t: 'part', kind: 'turret', x: x - 1,   y: y - 26,   c, life: L, vx: (R() - 0.5) * 220, vy: -430 - R() * 190, rot: 0, vr: (R() - 0.5) * 30 });
    this.add({ t: 'part', kind: 'barrel', x: x + 7,   y: y - 24.5, c, life: L, vx: (R() < 0.5 ? -1 : 1) * (180 + R() * 260), vy: -360 - R() * 260, rot: -0.6, vr: (R() - 0.5) * 38 });
    this.add({ t: 'part', kind: 'track',  x: x - 13,  y: y - 5,    c, life: L, ...kick(-210 - R() * 150) });
    this.add({ t: 'part', kind: 'track',  x: x + 13,  y: y - 5,    c, life: L, ...kick(210 + R() * 150) });
    for (let i = 0; i < 3; i++) {
      this.add({ t: 'part', kind: 'wheel', x: x - 15 + R() * 30, y: y - 5, c, life: L, ...kick() });
    }
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
      if (p.t !== 'part') { p.x += p.vx * dt; p.y += p.vy * dt; } // parts integrate themselves (terrain bounce)
      if (p.grow) p.size += p.grow * dt;
      switch (p.t) {
        case 'smoke': p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) - 22 * dt; p.vx += (this.wind || 0) * 26 * dt; break;
        case 'dirt': p.vy += 800 * dt; break;
        case 'fire': p.vx *= 1 - 2.4 * dt; p.vy *= 1 - 2.4 * dt; p.size *= 1 - 1.8 * dt; break;
        case 'spark': p.vx *= 1 - 3 * dt; p.vy *= 1 - 3 * dt; break;
        case 'flame': // hot gas - drag, buoyancy, gentle shrink (a fireball that rolls upward)
          p.vx *= 1 - 2.0 * dt; p.vy = p.vy * (1 - 2.0 * dt) - 55 * dt; p.size *= 1 - 0.85 * dt; break;
        case 'part': { // tumbling wreckage - gravity, spin, bounce off terrain, then rest
          p.vy += 950 * dt;
          p.rot = (p.rot || 0) + (p.vr || 0) * dt;
          const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, solid = this.solidAt;
          if (!solid) { p.x = nx; p.y = ny; break; }
          if (solid(nx, p.y)) { p.vx *= -0.45; p.vr *= 0.6; } else p.x = nx;      // wall
          if (solid(p.x, ny)) {                                                     // floor / ceiling
            p.vy *= -0.38; p.vx *= 0.62; p.vr *= 0.55;
            if (Math.abs(p.vy) < 30) p.vy = 0; // settled - stop the micro-bounce jitter
          } else p.y = ny;
          break;
        }
      }
    }
  }

  update(dt, solidAt) {
    this.solidAt = solidAt || null; // terrain probe for wreck parts (re-supplied each frame)
    this.#step(this.back, dt);
    this.#step(this.front, dt);
  }

  #drawOne(ctx, p) {
    const f = p.life / p.max; // 1 → 0
    if (p.t === 'part') { this.#drawPart(ctx, p, f); return; }
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
      case 'flame': { // smooth, realistic cooling ramp: white-hot → yellow → orange → ember red
        alpha = Math.min(1, f * 2.4);
        const k = 1 - f; // 0 = fresh (hottest) → 1 = dying (coolest)
        let r, g, b;
        if (k < 0.22)      { const u = k / 0.22;        r = 255;          g = 246 - 42 * u;  b = 200 - 130 * u; } // white → warm yellow
        else if (k < 0.55) { const u = (k - 0.22) / 0.33; r = 255;        g = 204 - 110 * u; b = 70 - 40 * u; }   // yellow → orange
        else               { const u = (k - 0.55) / 0.45; r = 255 - 110 * u; g = 94 - 56 * u; b = 30 - 14 * u; }  // orange → deep ember red
        color = `rgb(${r | 0},${g | 0},${b | 0})`;
        break;
      }
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

  // a torn-off tank fragment: drawn in the tank's own colors, tumbling around
  //  its centre. Holds FULL alpha for the first 2s of its 2.8s life, then
  //  FADES OUT over the last 0.8s until it's gone - the wreck "disappears".
  #drawPart(ctx, p, f) {
    const a0 = Math.min(1, p.life / 0.8); // 2s at full opacity, then linear fade over the final 0.8s
    const c = p.c;
    ctx.save();
    ctx.globalAlpha = a0;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot || 0);
    const stroke = (style, w = 1) => { ctx.strokeStyle = style; ctx.lineWidth = w; ctx.stroke(); };
    switch (p.kind) {
      case 'hull': // hull dome + top highlight + team accent skirt
        ctx.beginPath(); ctx.roundRect(-19, -5.5, 38, 11, 5.5); ctx.fillStyle = c.body; ctx.fill();
        stroke('rgba(0,0,0,0.3)');
        ctx.globalAlpha = a0 * 0.5;
        ctx.beginPath(); ctx.roundRect(-19, -5.5, 38, 4.5, 4); ctx.fillStyle = c.bodyLight; ctx.fill();
        ctx.globalAlpha = a0 * 0.8;
        ctx.beginPath(); ctx.roundRect(-16.5, 1.9, 33, 2.3, 1.1); ctx.fillStyle = c.accent; ctx.fill();
        break;
      case 'turret': // turret box + highlight + hatch
        ctx.beginPath(); ctx.roundRect(-11.5, -5, 23, 10, 3); ctx.fillStyle = c.body; ctx.fill();
        stroke('rgba(0,0,0,0.3)');
        ctx.globalAlpha = a0 * 0.5;
        ctx.beginPath(); ctx.roundRect(-11.5, -5, 23, 4.5, 3); ctx.fillStyle = c.bodyLight; ctx.fill();
        ctx.globalAlpha = a0;
        ctx.beginPath(); ctx.roundRect(-4, -8, 8, 3.5, 1.5); ctx.fillStyle = c.bodyDark; ctx.fill();
        break;
      case 'barrel': // pivot ring + tube + highlight + muzzle brake
        ctx.beginPath(); ctx.roundRect(0, -2.6, 16, 5.2, 2.4); ctx.fillStyle = c.body; ctx.fill();
        stroke('rgba(0,0,0,0.3)', 0.9);
        ctx.globalAlpha = a0 * 0.4;
        ctx.beginPath(); ctx.roundRect(0, -2.6, 16, 2.2, 2); ctx.fillStyle = c.bodyLight; ctx.fill();
        ctx.globalAlpha = a0;
        ctx.beginPath(); ctx.roundRect(14, -3.8, 6.5, 7.6, 2); ctx.fillStyle = c.bodyDark; ctx.fill();
        stroke('rgba(0,0,0,0.35)', 0.9);
        ctx.beginPath(); ctx.arc(0, 0, 3.4, 0, Math.PI * 2); ctx.fillStyle = c.bodyDark; ctx.fill();
        break;
      case 'track': // half of the track pill + inner band
        ctx.beginPath(); ctx.roundRect(-12.5, -6.5, 25, 13, 6.5); ctx.fillStyle = c.track; ctx.fill();
        stroke('rgba(0,0,0,0.35)');
        ctx.beginPath(); ctx.roundRect(-10.5, -4.5, 21, 9, 4.5); ctx.fillStyle = c.trackInner; ctx.fill();
        break;
      case 'wheel': // a loose road wheel - spokes make the tumble spin visible
        ctx.beginPath(); ctx.arc(0, 0, 2.9, 0, Math.PI * 2); ctx.fillStyle = c.wheel; ctx.fill();
        ctx.strokeStyle = c.hub; ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(-2.3, 0); ctx.lineTo(2.3, 0);
        ctx.moveTo(0, -2.3); ctx.lineTo(0, 2.3);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 1.1, 0, Math.PI * 2); ctx.fillStyle = c.hub; ctx.fill();
        break;
    }
    ctx.restore();
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
