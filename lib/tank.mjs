// ════════════════════════════════════════════════════════════════════
//  TANK — procedural flat-design tank, zero sprites.
//  drawTank(ctx, x, y, opts): (x,y) = ground contact (bottom of tracks).
//  opts: aim (rad), palette, flip, rot (slope tilt), sus (hydraulic
//  suspension offset: hull shifts down px vs tracks), wheelRot (radians).
// ════════════════════════════════════════════════════════════════════

export const TANK_PALETTES = [
  { name: 'Forest', h: 150, s: 16 },  // reference green
  { name: 'Desert', h: 38, s: 32 },
  { name: 'Cobalt', h: 212, s: 28 },
  { name: 'Crimson', h: 356, s: 34 },
  { name: 'Violet', h: 276, s: 22 },
  { name: 'Amber', h: 22, s: 40 },
];

const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;

function shades(p) {
  const { h, s } = p;
  return {
    body: hsl(h, s, 30),
    bodyLight: hsl(h, s, 42),
    bodyDark: hsl(h, s, 18),
    track: hsl(h, Math.max(4, s * 0.5), 14),
    trackInner: hsl(h, Math.max(4, s * 0.5), 24),
    wheel: hsl(h, Math.max(4, s * 0.45), 38),
    hub: hsl(h, Math.max(4, s * 0.45), 20),
  };
}

function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

export const TANK = { W: 50, H: 36, pivotX: 7, pivotY: -24.5, barrelLen: 16 };

export function drawTank(ctx, x, y, { aim = -0.6, palette = 0, flip = false, rot = 0, sus = 0, wheelRot = 0 } = {}) {
  const c = shades(TANK_PALETTES[palette % TANK_PALETTES.length]);
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.rotate(rot); // align to slope

  // ── tracks: outer pill → inner band → 8 spinning spoked wheels ──
  rr(ctx, -25, -11, 50, 13, 6.5); ctx.fillStyle = c.track; ctx.fill();
  rr(ctx, -22.5, -9, 45, 9, 4.5); ctx.fillStyle = c.trackInner; ctx.fill();
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

  // ── everything above the tracks rides the suspension ──
  ctx.save();
  ctx.translate(0, sus);

  // rear exhaust box with slits
  rr(ctx, -26.5, -18, 6, 8, 1.5); ctx.fillStyle = c.bodyDark; ctx.fill();
  ctx.fillStyle = c.bodyLight;
  ctx.fillRect(-25.5, -16.2, 4, 1.1);
  ctx.fillRect(-25.5, -13.8, 4, 1.1);

  // hull dome + top highlight
  rr(ctx, -19, -21, 38, 11, 6); ctx.fillStyle = c.body; ctx.fill();
  rr(ctx, -19, -21, 38, 5, 5); ctx.fillStyle = c.bodyLight;
  ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;

  // turret: hatch + box
  rr(ctx, -8, -34, 13, 5, 2); ctx.fillStyle = c.bodyDark; ctx.fill();
  rr(ctx, -13, -30, 23, 10, 3); ctx.fillStyle = c.body; ctx.fill();
  rr(ctx, -13, -30, 23, 4.5, 3); ctx.fillStyle = c.bodyLight;
  ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1;

  // pivot barrel: tube + muzzle + base ring
  ctx.save();
  ctx.translate(TANK.pivotX, TANK.pivotY);
  ctx.rotate(aim - rot); // keep aim absolute despite body tilt
  rr(ctx, 0, -2.6, TANK.barrelLen, 5.2, 2.4); ctx.fillStyle = c.body; ctx.fill();
  rr(ctx, 0, -2.6, TANK.barrelLen, 2.2, 2); ctx.fillStyle = c.bodyLight;
  ctx.globalAlpha = 0.4; ctx.fill(); ctx.globalAlpha = 1;
  rr(ctx, TANK.barrelLen - 2, -3.8, 6.5, 7.6, 2); ctx.fillStyle = c.bodyDark; ctx.fill();
  ctx.restore();

  ctx.beginPath(); ctx.arc(TANK.pivotX, TANK.pivotY, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = c.bodyDark; ctx.fill();

  ctx.restore(); // suspension
  ctx.restore();
}
