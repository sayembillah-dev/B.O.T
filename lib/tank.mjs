// ════════════════════════════════════════════════════════════════════
//  TANK - procedural flat-design tank, zero sprites.
//  drawTank(ctx, x, y, opts): (x,y) = ground contact (bottom of tracks).
//  opts: aim (rad), palette, flip, rot (slope tilt), sus (hydraulic
//  suspension offset: hull shifts down px vs tracks), wheelRot (radians).
//
//  Perf (plan 5b.4): the static parts are baked into offscreen sprites.
//  · hull (exhaust/dome/turret/antenna) → one sprite per palette.
//  · track assembly (pill + band + tread links + 8 spoked wheels) →
//    one sprite per (palette × quantized wheelRot). wheelRot is snapped
//    to WHEEL_STEPS steps/revolution; tread linkOff derives from the
//    same quantized value so spokes and treads march in sync.
//  · barrel stays live (aim changes every frame).
// ════════════════════════════════════════════════════════════════════

export const TANK_PALETTES = [
  { name: 'Forest', h: 150, s: 26 },  // reference green
  { name: 'Desert', h: 38, s: 44 },
  { name: 'Cobalt', h: 212, s: 42 },
  { name: 'Crimson', h: 356, s: 48 },
  { name: 'Violet', h: 276, s: 34 },
  { name: 'Amber', h: 22, s: 54 },
];

const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;

export function shades(p) {
  const { h, s } = p;
  return {
    body: hsl(h, s, 30),
    bodyLight: hsl(h, s, 42),
    bodyDark: hsl(h, s, 18),
    track: hsl(h, Math.max(4, s * 0.5), 14),
    trackInner: hsl(h, Math.max(4, s * 0.5), 24),
    wheel: hsl(h, Math.max(4, s * 0.45), 38),
    hub: hsl(h, Math.max(4, s * 0.45), 20),
    accent: hsl(h, Math.min(90, s + 45), 62), // vivid team color for details
  };
}

function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

export const TANK = { W: 50, H: 36, pivotX: 7, pivotY: -24.5, barrelLen: 16 };

// ── sprite cache ────────────────────────────────────────────────────
const SPRITE_SCALE = 2;                 // bake at 2x (matches high-tier dprCap)
const WHEEL_STEPS = 16;                 // quantized wheel rotations per revolution
const _sprites = new Map();             // key → { cv, ox, oy, w, h }

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

function bake(key, w, h, ox, oy, paint) {
  let s = _sprites.get(key);
  if (s) return s;
  const cv = makeCanvas(Math.ceil(w * SPRITE_SCALE), Math.ceil(h * SPRITE_SCALE));
  const ctx = cv.getContext('2d');
  ctx.scale(SPRITE_SCALE, SPRITE_SCALE);
  ctx.translate(ox, oy);
  paint(ctx);
  s = { cv, ox, oy, w, h };
  _sprites.set(key, s);
  return s;
}

// hull: everything above the tracks except barrel + pivot ring (drawn live).
// content spans x[-26.5..10], y[-44.5..-10]; padded to x[-28..12], y[-46..-9].
function hullSprite(pal) {
  return bake(`h${pal}`, 40, 37, 28, 46, (ctx) => {
    const c = shades(TANK_PALETTES[pal]);

    // rear exhaust box with slits
    rr(ctx, -26.5, -18, 6, 8, 1.5); ctx.fillStyle = c.bodyDark; ctx.fill();
    ctx.fillStyle = c.bodyLight;
    ctx.fillRect(-25.5, -16.2, 4, 1.1);
    ctx.fillRect(-25.5, -13.8, 4, 1.1);

    // hull dome + top highlight + outline + team accent skirt
    rr(ctx, -19, -21, 38, 11, 6); ctx.fillStyle = c.body; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
    rr(ctx, -19, -21, 38, 5, 5); ctx.fillStyle = c.bodyLight;
    ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;
    rr(ctx, -16.5, -13.6, 33, 2.3, 1.1); ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.8; ctx.fill(); ctx.globalAlpha = 1;

    // turret: hatch + box + outline + antenna
    rr(ctx, -8, -34, 13, 5, 2); ctx.fillStyle = c.bodyDark; ctx.fill();
    rr(ctx, -13, -30, 23, 10, 3); ctx.fillStyle = c.body; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
    rr(ctx, -13, -30, 23, 4.5, 3); ctx.fillStyle = c.bodyLight;
    ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.1; // antenna
    ctx.beginPath(); ctx.moveTo(-10, -34); ctx.lineTo(-12.5, -42); ctx.stroke();
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(-12.5, -42.8, 1.5, 0, Math.PI * 2); ctx.fill();
  });
}

// track assembly: outer pill + inner band + tread links + 8 spoked wheels.
// content spans x[-25..25], y[-11..2]; padded to x[-27..27], y[-13..3].
function trackSprite(pal, wq) {
  return bake(`t${pal}:${wq}`, 54, 16, 27, 13, (ctx) => {
    const c = shades(TANK_PALETTES[pal]);
    const wheelRot = wq * (Math.PI * 2 / WHEEL_STEPS);

    rr(ctx, -25, -11, 50, 13, 6.5); ctx.fillStyle = c.track; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    rr(ctx, -22.5, -9, 45, 9, 4.5); ctx.fillStyle = c.trackInner; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1; // tread links march with the wheels
    const linkOff = ((wheelRot * 3) % 4 + 4) % 4;
    ctx.beginPath();
    for (let tx = -22 + linkOff; tx < 23; tx += 4) {
      ctx.moveTo(tx, -10.4); ctx.lineTo(tx, -7.4);
      ctx.moveTo(tx, -3.2); ctx.lineTo(tx, -0.8);
    }
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const wx = -17.5 + i * 5;
      ctx.save();
      ctx.translate(wx, -4.5);
      ctx.rotate(wheelRot);
      ctx.beginPath(); ctx.arc(0, 0, 2.7, 0, Math.PI * 2);
      ctx.fillStyle = c.wheel; ctx.fill();
      ctx.strokeStyle = c.hub; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-2.2, 0); ctx.lineTo(2.2, 0);
      ctx.moveTo(0, -2.2); ctx.lineTo(0, 2.2);
      ctx.stroke(); // spokes make the spin visible
      ctx.beginPath(); ctx.arc(0, 0, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = c.hub; ctx.fill();
      ctx.restore();
    }
  });
}

export function drawTank(ctx, x, y, { aim = -0.6, palette = 0, flip = false, rot = 0, sus = 0, wheelRot = 0 } = {}) {
  const pal = ((palette % TANK_PALETTES.length) + TANK_PALETTES.length) % TANK_PALETTES.length;
  const c = shades(TANK_PALETTES[pal]); // barrel + pivot colors (few strings, barrel is live)
  const wq = ((Math.round(wheelRot / (Math.PI * 2 / WHEEL_STEPS)) % WHEEL_STEPS) + WHEEL_STEPS) % WHEEL_STEPS;
  ctx.save();
  ctx.translate(x, y);

  // soft contact shadow - grounds the tank (drawn before the slope tilt)
  ctx.fillStyle = 'rgba(6,10,6,0.30)';
  ctx.beginPath(); ctx.ellipse(0, 1.5, 27, 4.6, 0, 0, Math.PI * 2); ctx.fill();

  if (flip) ctx.scale(-1, 1);
  ctx.rotate(rot); // align to slope

  // ── tracks (baked: pill + band + treads + wheels at this spin step) ──
  const ts = trackSprite(pal, wq);
  ctx.drawImage(ts.cv, -ts.ox, -ts.oy, ts.w, ts.h);

  // ── everything above the tracks rides the suspension ──
  ctx.save();
  ctx.translate(0, sus);

  const hs = hullSprite(pal);
  ctx.drawImage(hs.cv, -hs.ox, -hs.oy, hs.w, hs.h);

  // pivot barrel: tube + highlight + muzzle brake + base ring (live - aim changes)
  ctx.save();
  ctx.translate(TANK.pivotX, TANK.pivotY);
  ctx.rotate(aim - rot); // keep aim absolute despite body tilt
  rr(ctx, 0, -2.6, TANK.barrelLen, 5.2, 2.4); ctx.fillStyle = c.body; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 0.9; ctx.stroke();
  rr(ctx, 0, -2.6, TANK.barrelLen, 2.2, 2); ctx.fillStyle = c.bodyLight;
  ctx.globalAlpha = 0.4; ctx.fill(); ctx.globalAlpha = 1;
  rr(ctx, TANK.barrelLen - 2, -3.8, 6.5, 7.6, 2); ctx.fillStyle = c.bodyDark; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.9; ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; // brake vents
  ctx.fillRect(TANK.barrelLen + 0.6, -3.4, 1.1, 6.8);
  ctx.fillRect(TANK.barrelLen + 2.8, -3.4, 1.1, 6.8);
  ctx.restore();

  ctx.beginPath(); ctx.arc(TANK.pivotX, TANK.pivotY, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = c.bodyDark; ctx.fill();

  ctx.restore(); // suspension
  ctx.restore();
}
