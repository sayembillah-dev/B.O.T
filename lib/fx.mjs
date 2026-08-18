// ════════════════════════════════════════════════════════════════════
//  FX — lightweight particle engine. Pooled, capped, plain-arc drawing
//  (no per-particle gradients → fast). Layers: 'back' (smoke, behind
//  tanks) and 'front' (fire, dirt, flashes, rings).
//  fx.wind ∈ [-1,1] — smoke drifts sideways with the wind.
// ════════════════════════════════════════════════════════════════════

const MAX = 1200; // headroom so a tomahawk mushroom (~230 particles) can't evict itself
const R = Math.random;

export class FX {
  constructor() { this.ps = []; this.wind = 0; }

  add(p) {
    if (this.ps.length >= MAX) this.ps.splice(0, this.ps.length - MAX + 1);
    p.max = p.life;
    this.ps.push(p);
  }

  // gray puff — used by muzzle, missile trail, explosion linger.
  // `a` overrides the default smoke opacity (the mushroom cloud wants denser puffs).
  smoke(x, y, vx, vy, size, life = 1.5, color, a) {
    this.add({ t: 'smoke', x, y, vx, vy, size, grow: 14 + R() * 10, life, color, a });
  }

  muzzle(x, y, ang) {
    for (let i = 0; i < 9; i++) { // smoke cone along the barrel
      const a = ang + (R() - 0.5) * 0.7;
      const v = 40 + R() * 90;
      this.smoke(x, y, Math.cos(a) * v, Math.sin(a) * v - 15, 4 + R() * 5, 0.9 + R() * 0.7);
    }
    for (let i = 0; i < 7; i++) { // spark flash
      const a = ang + (R() - 0.5) * 0.5;
      const v = 250 + R() * 300;
      this.add({ t: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: 1.6, life: 0.14 + R() * 0.1 });
    }
  }

  trail(x, y, vx, vy) {
    // lighter + quicker: one small short-lived puff (was bigger/longer)
    this.smoke(x, y, -vx * 0.05 + (Math.random() - 0.5) * 14, -vy * 0.05 - 8, 1.6 + Math.random() * 1.2, 0.45 + Math.random() * 0.3);
  }

  boom(x, y) {
    this.add({ t: 'flash', x, y, size: 8, grow: 420, life: 0.16 });
    this.add({ t: 'ring', x, y, size: 12, grow: 330, life: 0.45 });
    for (let i = 0; i < 22; i++) { // fireball
      const a = R() * Math.PI * 2, v = 60 + R() * 260;
      this.add({ t: 'fire', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, size: 3 + R() * 5, life: 0.35 + R() * 0.35 });
    }
    for (let i = 0; i < 18; i++) { // flying dirt
      const a = -Math.PI * R(), v = 120 + R() * 340;
      const s = 2 + R() * 3.4;
      this.add({ t: 'dirt', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: s, life: 0.7 + R() * 0.7 });
    }
    for (let i = 0; i < 13; i++) { // lingering smoke column
      this.smoke(x + (R() - 0.5) * 30, y + (R() - 0.5) * 20, (R() - 0.5) * 30, -30 - R() * 50, 7 + R() * 8, 1.8 + R() * 1.2);
    }
  }

  // ☢️ tomahawk: BIG mushroom cloud — ground skirt, tall rising stem, wide
  // billowing cap, fire core. Roughly 3× the old one and it lingers.
  mushroom(x, y) {
    const CAP = 300;            // how high the cap floats above the impact point
    // ground dust skirt punching outward along the surface
    for (let i = 0; i < 26; i++) {
      const dir = R() < 0.5 ? -1 : 1;
      const v = 130 + R() * 240;
      this.smoke(x + dir * R() * 40, y - R() * 14, dir * v, -14 - R() * 26,
        16 + R() * 16, 2.4 + R() * 1.4, 'rgb(178,162,142)', 0.5);
    }
    // stem column — fat, climbing fast, thickening as it rises
    for (let i = 0; i < 46; i++) {
      const t = i / 46;
      this.smoke(x + (R() - 0.5) * 34, y - t * CAP, (R() - 0.5) * 30, -170 - R() * 120,
        16 + t * 30, 2.6 + R() * 1.3, 'rgb(198,180,158)', 0.55);
    }
    // cap — wide torus billowing outward and curling over
    for (let i = 0; i < 64; i++) {
      const a = R() * Math.PI * 2, rr = 40 + R() * 120;
      this.smoke(x + Math.cos(a) * rr * 1.9, y - CAP + Math.sin(a) * rr * 0.45,
        Math.cos(a) * (90 + R() * 70), -55 - R() * 45,
        26 + R() * 26, 3.2 + R() * 1.8, 'rgb(220,202,176)', 0.58);
    }
    // darker under-shadow of the cap so it reads as a solid mass
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2, rr = R() * 130;
      this.smoke(x + Math.cos(a) * rr * 1.7, y - CAP + 52 + Math.sin(a) * rr * 0.3,
        Math.cos(a) * 60, -40 - R() * 30, 24 + R() * 22, 2.8 + R() * 1.4, 'rgb(150,132,112)', 0.5);
    }
    // fire core climbing the stem
    for (let i = 0; i < 40; i++) {
      const a = R() * Math.PI * 2, v = 60 + R() * 220;
      this.add({ t: 'fire', x: x + (R() - 0.5) * 30, y: y - R() * 150,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 190,
        size: 9 + R() * 13, life: 0.9 + R() * 0.8 });
    }
    // heavy dirt thrown clear of the crater
    for (let i = 0; i < 30; i++) {
      const a = -Math.PI * R(), v = 240 + R() * 520;
      this.add({ t: 'dirt', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        size: 3 + R() * 5, life: 1.1 + R() * 0.9 });
    }
    this.add({ t: 'flash', x, y, size: 40, grow: 1500, life: 0.36 });
  }

  splash(x, y) {
    this.add({ t: 'ring', x, y, size: 6, grow: 260, life: 0.5, color: 'rgb(170,220,245)' });
    this.add({ t: 'ring', x, y, size: 2, grow: 150, life: 0.65, color: 'rgb(215,240,250)' });
    for (let i = 0; i < 22; i++) { // droplet fountain
      const a = -Math.PI * (0.15 + R() * 0.7), v = 120 + R() * 260;
      this.add({ t: 'drop', x, y: y - 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: 1.8 + R() * 2.4, life: 0.55 + R() * 0.45 });
    }
    for (let i = 0; i < 10; i++) { // white foam burst
      this.add({ t: 'drop', x: x + (R() - 0.5) * 26, y, vx: (R() - 0.5) * 60, vy: -30 - R() * 90, size: 2 + R() * 3, life: 0.4 + R() * 0.3, color: 'rgb(235,246,252)' });
    }
    for (let i = 0; i < 5; i++) { // mist
      this.smoke(x + (R() - 0.5) * 20, y - 4, (R() - 0.5) * 20, -25 - R() * 30, 5 + R() * 6, 0.9 + R() * 0.5, 'rgb(215,232,240)');
    }
  }

  text(x, y, txt, color = '#ffd75e') { // floating popup (damage numbers etc.)
    this.add({ t: 'text', x, y, vx: 0, vy: -46, size: 15, life: 1.15, txt, color });
  }

  update(dt) {
    const ps = this.ps;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grow) p.size += p.grow * dt;
      switch (p.t) {
        case 'smoke': p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) - 22 * dt; p.vx += (this.wind || 0) * 26 * dt; break;
        case 'dirt': case 'drop': p.vy += 800 * dt; break;
        case 'fire': p.vx *= 1 - 2.4 * dt; p.vy *= 1 - 2.4 * dt; p.size *= 1 - 1.8 * dt; break;
        case 'spark': p.vx *= 1 - 3 * dt; p.vy *= 1 - 3 * dt; break;
      }
    }
  }

  draw(ctx, layer) {
    const ps = this.ps;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const back = p.t === 'smoke';
      if ((layer === 'back') !== back) continue;
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
        continue;
      }
      let color, alpha;
      switch (p.t) {
        case 'smoke': alpha = (p.a ?? 0.34) * Math.sin(Math.PI * Math.min(1, f * 1.15)); color = p.color || 'rgb(198,198,190)'; break;
        case 'fire': alpha = Math.min(1, f * 2); color = f > 0.55 ? 'rgb(255,214,120)' : f > 0.25 ? 'rgb(255,130,60)' : 'rgb(160,60,40)'; break;
        case 'dirt': alpha = Math.min(1, f * 2.2); color = 'rgb(96,64,38)'; break;
        case 'drop': alpha = Math.min(1, f * 2); color = p.color || 'rgb(150,205,235)'; break;
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
    ctx.globalAlpha = 1;
  }
}
