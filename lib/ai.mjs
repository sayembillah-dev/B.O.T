// ════════════════════════════════════════════════════════════════════
//  🤖 AI OPPONENTS - turn-based CPU tanks (server-side, classic mode).
//  Three precisely engineered difficulties:
//    easy   - partially accurate: coarse search, big aim error, wild shots
//    medium - accurate sometimes: coin-flip between sharp and sloppy aim
//    hard   - accurate most of the time: fine search, tiny error, smart
//             target/weapon choice, repositions, grabs crates, teleports
//
//  The physics here MIRROR the client (components/Game.jsx) exactly:
//    v = (300 + p·1200) px/s · (tomahawk ×0.55),  vy += 850·dt,
//    vx += wind·95·dt,  muzzle = pivot(x+7, y−24.5) + dir·23,
//    tank hitbox 58×46 @ (x, y−19), self-safe for the first 0.12s,
//    blast r 58 (sub 40, guided 58, tomahawk 200), range = r+34,
//    dmg = direct(<30px) ? 50·scale : max(2, 46·scale·(1−d/range)).
//  Because the server owns the same terrain bitmap + wind, a simulated
//  shot lands where the real one will - difficulty is pure aim error.
// ════════════════════════════════════════════════════════════════════
import { isSolid } from './terrain.mjs';

const GRAV = 850;
const WIND_MAX = 95;
const SPEED = (p) => 300 + p * 1200;
const TOMAHAWK_SLOW = 0.55;
const MUZZLE_LEN = 16 + 7;          // barrelLen + brake
const PIVOT_X = 7, PIVOT_Y = -24.5; // tank.mjs
const BOX_X = 29, BOX_Y = 23, BOX_CY = -19; // shell-vs-tank hitbox

// guided missile (mirrors the client's homing cruise missile)
const GUIDED_SPEED = 900, GUIDED_TURN = 10, GUIDED_CLEAR = 95;
const GUIDED_LOOK = 420, GUIDED_FUEL = 12, GUIDED_FUSE = 28;

// blast specs per shell kind (mirrors explodeProj)
const SPEC = {
  normal:   { r: 58,  scale: 1 },
  sub:      { r: 40,  scale: 0.75 },
  guided:   { r: 58,  scale: 1.25 },
  tomahawk: { r: 200, scale: 3.2, big: true },
};
const CLUSTER_FAN = [[-2.19, 300], [-Math.PI / 2, 390], [-0.95, 300]]; // bomblet pop

// ── Difficulty engineering ──────────────────────────────────────────
export const DIFFS = {
  easy: {
    label: 'Easy', emoji: '😊',
    thinkMs: [1500, 2800],
    angles: 26, powers: 8,           // coarse firing-solution search
    errA: 0.055, errP: 0.075,        // big gaussian aim error - partially accurate
    sharpChance: 0.0, sharpScale: 1, // never locks on
    wildChance: 0.15,                // sometimes just yeets a random shell
    target: 'random',
    robust: 0,                       // fragile ridge-skimming shots stay on the table
    careful: 0.8,                    // mostly avoids blowing itself up (rare derps stay 😊)
    drive: 0, tele: 0, guided: false, specials: 0,
  },
  medium: {
    label: 'Medium', emoji: '😐',
    thinkMs: [1100, 2100],
    angles: 40, powers: 12,
    errA: 0.028, errP: 0.045,
    sharpChance: 0.45, sharpScale: 0.3, // ~half of turns: near-perfect - accurate SOMETIMES
    wildChance: 0.05,
    target: 'nearest',
    robust: 4,                       // re-ranks top shots by worst-case under error
    careful: 0.75,
    drive: 250, tele: 0.45, guided: true, specials: 0.5,
  },
  hard: {
    label: 'Hard', emoji: '😈',
    thinkMs: [800, 1600],
    angles: 60, powers: 16,
    errA: 0.007, errP: 0.010,
    sharpChance: 0.88, sharpScale: 0.35, // 88% of turns: surgical - accurate MOST of the time
    wildChance: 0,
    target: 'smart',
    robust: 6,                       // always picks the shot that survives its own error
    careful: 1,                      // never blows itself up
    drive: 330, tele: 0.9, guided: true, specials: 1,
  },
};

const surfOf = (T, x) => T.surface[Math.max(0, Math.min(T.width - 1, Math.round(x)))];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Box-Muller gaussian, clamped to ±2.5σ so tails never get silly. */
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return clamp(g, -2.5, 2.5);
}

const muzzleOf = (t, a) => ({
  x: t.x + PIVOT_X + Math.cos(a) * MUZZLE_LEN,
  y: t.y + PIVOT_Y + Math.sin(a) * MUZZLE_LEN,
});

/** Server/client-shared damage formula. */
export function estimateDamage(x, y, r, scale, t) {
  const range = r + 34;
  const d = Math.hypot(t.x - x, (t.y - 18) - y);
  if (d >= range) return 0;
  return d < 30 ? Math.round(50 * scale) : Math.max(2, Math.round(46 * scale * (1 - d / range)));
}

/**
 * Step one shell until impact / lost. Returns
 *   { x, y, directId }  - impact point (directId = tank it physically struck)
 *   { split: true, x, y, vx } - cluster parent burst (caller spawns subs)
 *   null - flew off the world (clean miss)
 * `tanks` may be live game tanks; srcId's own tank is safe for 0.12s.
 */
function stepShell(T, tanks, srcId, sh, dt) {
  if (sh.kind === 'guided' && sh.armed < GUIDED_FUEL) {
    // homing cruise missile: locks nearest living enemy, hugs ridges, prox fuse
    let best = null, bd = Infinity;
    for (const t of tanks) {
      if (t.dead || t.id === srcId || t.para) continue; // 🪂 never lock a chute - the missile can't hurt it
      const d = Math.hypot(t.x - sh.x, (t.y - 14) - sh.y);
      if (d < bd) { bd = d; best = t; }
    }
    if (best) {
      const tgx = best.x, tgy = best.y - 14;
      const dx = tgx - sh.x, dy = tgy - sh.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < GUIDED_FUSE) return { x: sh.x, y: sh.y, directId: best.id };
      let los = true;
      for (let i = 1; i < 32; i++) {
        const f = i / 32, sx = sh.x + dx * f, sy = sh.y + dy * f;
        if (sx >= 0 && sx < T.width && sy >= 0 && isSolid(T, sx, sy)) { los = false; break; }
      }
      let want;
      if (los) {
        want = Math.atan2(dy, dx);
      } else {
        const dir = Math.sign(dx) || 1;
        let crest = Infinity;
        const reach = Math.min(Math.abs(dx), GUIDED_LOOK);
        for (let s = 0; s <= reach; s += 12) {
          crest = Math.min(crest, surfOf(T, sh.x + dir * s));
        }
        const cruiseY = Math.min(crest, tgy) - GUIDED_CLEAR;
        want = Math.atan2(clamp((cruiseY - sh.y) / 90, -2.4, 2.4), dir);
      }
      let cur = Math.atan2(sh.vy, sh.vx);
      let dAng = want - cur;
      while (dAng > Math.PI) dAng -= Math.PI * 2;
      while (dAng < -Math.PI) dAng += Math.PI * 2;
      const maxTurn = GUIDED_TURN * (dist < 260 ? 2.2 : 1) * dt;
      cur += clamp(dAng, -maxTurn, maxTurn);
      if (!los) {
        const ex = sh.x + Math.cos(cur) * 46, ey = sh.y + Math.sin(cur) * 46;
        if (ex >= 0 && ex < T.width && ey >= 0 && isSolid(T, ex, ey)) cur = -Math.PI / 2;
      }
      sh.vx = Math.cos(cur) * GUIDED_SPEED;
      sh.vy = Math.sin(cur) * GUIDED_SPEED;
    }
    // no target: falls ballistic below
    else { sh.vy += GRAV * dt; sh.vx += sh.wind * WIND_MAX * dt; }
  } else {
    sh.vy += GRAV * dt;
    sh.vx += sh.wind * WIND_MAX * dt;
  }
  sh.armed += dt;
  const dist = Math.hypot(sh.vx, sh.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / 4));
  for (let s = 0; s < steps; s++) {
    sh.x += (sh.vx * dt) / steps;
    sh.y += (sh.vy * dt) / steps;
    let hitTank = null;
    for (const t of tanks) {
      if (t.dead) continue;
      if (t.id === srcId && sh.armed < 0.12) continue; // just left our muzzle
      if (Math.abs(sh.x - t.x) <= BOX_X && Math.abs(sh.y - (t.y + BOX_CY)) <= BOX_Y) { hitTank = t; break; }
    }
    const inX = sh.x >= 0 && sh.x < T.width;
    if (hitTank || (inX && sh.y >= 0 && isSolid(T, sh.x, sh.y))) {
      if (sh.kind === 'cluster') return { split: true, x: sh.x, y: sh.y, vx: sh.vx };
      return { x: sh.x, y: sh.y, directId: hitTank?.id ?? null };
    }
    if (!inX || sh.y > T.height + 60) return null; // off the world
  }
  return 'fly';
}

const mkShell = (src, a, p, kind, dmgScale, wind) => {
  const v = SPEED(p) * (kind === 'tomahawk' ? TOMAHAWK_SLOW : 1);
  const tip = muzzleOf(src, a);
  return { x: tip.x, y: tip.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, kind, dmgScale, armed: 0, wind, srcId: src.id };
};

/**
 * Simulate a full shot to its impact list: [{ x, y, r, scale, directId }].
 * Cluster returns up to 3 bomblet impacts; guided homes; null-impact = [].
 */
export function simulateShot(T, tanks, src, a, p, kind, wind) {
  const impacts = [];
  const queue = [mkShell(src, a, p, kind, 1, wind)];
  let guard = 0;
  while (queue.length && guard++ < 8) {
    const sh = queue.shift();
    let res = 'fly';
    let t = 0;
    const dt = 1 / 60;
    while (res === 'fly' && (t += dt) < 14) res = stepShell(T, tanks, sh.srcId ?? src.id, sh, dt);
    if (res === 'fly' || res === null) continue; // timed out or left the world
    if (res.split) { // cluster bursts into 3 bomblets
      const gy = surfOf(T, res.x);
      for (const [ang, spd] of CLUSTER_FAN) {
        queue.push({
          x: res.x, y: Math.min(res.y - 4, gy - 4),
          vx: Math.cos(ang) * spd + res.vx * 0.2, vy: Math.sin(ang) * spd,
          kind: 'sub', dmgScale: sh.dmgScale, armed: sh.armed, wind, srcId: sh.srcId ?? src.id,
        });
      }
      continue;
    }
    const spec = SPEC[sh.kind] ?? SPEC.normal;
    impacts.push({ x: res.x, y: res.y, r: spec.r, scale: spec.scale * (sh.dmgScale || 1), directId: res.directId });
  }
  return impacts;
}

/** Expected-damage score of an impact list vs the target (+ splash on others). */
function scoreImpacts(impacts, me, enemies, targetId, targetHp) {
  let score = 0, onTarget = 0;
  for (const imp of impacts) {
    for (const e of enemies) {
      const d = estimateDamage(imp.x, imp.y, imp.r, imp.scale, e);
      if (d <= 0) continue;
      const w = e.id === targetId ? 1 : 0.45;
      score += d * w + (imp.directId === e.id ? 12 : 0);
      if (e.id === targetId) onTarget += d;
    }
    score -= estimateDamage(imp.x, imp.y, imp.r, imp.scale, me) * 6; // NEVER self-bomb
  }
  if (targetHp > 0 && onTarget >= targetHp) score += 90; // 🔪 securing the kill matters
  return score;
}

/** Pick who to shoot at, by difficulty. */
function pickTarget(me, enemies, mode, rng) {
  if (mode === 'random') return enemies[Math.floor(rng() * enemies.length)];
  if (mode === 'nearest') {
    let best = null, bd = Infinity;
    for (const e of enemies) { const d = Math.abs(e.x - me.x); if (d < bd) { bd = d; best = e; } }
    return best;
  }
  // smart: finish a killable tank first, else weakest, ties → nearest
  let best = null, bs = Infinity;
  for (const e of enemies) {
    const killable = e.hp <= 40 ? -1000 : 0;
    const s = killable + e.hp * 10 + Math.abs(e.x - me.x) / 50;
    if (s < bs) { bs = s; best = e; }
  }
  return best;
}

/**
 * The brain. Searches (angle, power) × available shell kinds against the
 * authoritative terrain + wind, picks the best expected-damage shot for the
 * chosen target, THEN applies the difficulty's aim error - that error curve
 * is exactly what makes easy "partially", medium "sometimes" and hard
 * "mostly" accurate.
 */
export function planShot({ T, me, enemies, wind, difficulty, rng = Math.random }) {
  const cfg = DIFFS[difficulty] ?? DIFFS.easy;
  const target = pickTarget(me, enemies, cfg.target, rng);
  if (!target) return null;
  const ds = (me.buff | 0) > 0 ? 2 : 1;

  // easy's wild yeet: no search, random lob in the target's rough direction
  if (cfg.wildChance > 0 && rng() < cfg.wildChance) {
    const left = target.x < me.x;
    const a = left ? -Math.PI + 0.2 + rng() * (Math.PI / 2 - 0.5)
                   : -Math.PI / 2 - 0.3 + rng() * (Math.PI / 2 - 0.5) + 0.1;
    return { a, p: 0.35 + rng() * 0.65, kind: 'normal', targetId: target.id, expect: 0 };
  }

  const A0 = -Math.PI + 0.20, A1 = -0.20; // upper half - every sane lob lives here (the down-fallback below covers ledge dunks)
  const tanks = enemies.concat([me]);
  const scoreAt = (a, p, kind) => {
    const impacts = simulateShot(T, tanks, { ...me, buff: 0 }, a, p, kind, wind);
    if (!impacts.length) return { s: -Infinity, impacts };
    for (const imp of impacts) imp.scale = Math.min(6, imp.scale * ds); // active ×2 buff rides along (the server clamps scale at 6)
    return { s: scoreImpacts(impacts, me, enemies, target.id, target.hp), impacts };
  };
  // 🔬 hill-climb refinement: the coarse grid brackets the solution, this
  //    polishes it to within a few pixels (3 rounds, shrinking radius)
  const refine = (c, a0 = A0, a1 = A1) => {
    let { s, a, p, kind } = c;
    let rA = 0.06, rP = 0.05;
    for (let round = 0; round < 3; round++) {
      let improved = false;
      for (const [da, dp] of [[rA, 0], [-rA, 0], [0, rP], [0, -rP], [rA, rP], [rA, -rP], [-rA, rP], [-rA, -rP]]) {
        const aa = a + da, pp = clamp(p + dp, 0.06, 1);
        if (aa < a0 || aa > a1) continue;
        const r = scoreAt(aa, pp, kind);
        if (r.s > s) { s = r.s; a = aa; p = pp; improved = true; }
      }
      if (!improved) { rA *= 0.5; rP *= 0.5; }
    }
    return { s, a, p, kind };
  };
  const search = (kind, nA, nP, a0 = A0, a1 = A1) => {
    const tops = []; // best few raw candidates, re-ranked for robustness below
    for (let i = 0; i < nA; i++) {
      const a = a0 + ((a1 - a0) * i) / (nA - 1);
      for (let j = 0; j < nP; j++) {
        const p = 0.28 + (0.72 * j) / (nP - 1);
        const { s } = scoreAt(a, p, kind);
        if (s === -Infinity) continue;
        tops.push({ s, a, p, kind });
      }
    }
    if (!tops.length) return null;
    tops.sort((x, y) => y.s - x.s);
    tops.length = Math.min(tops.length, 6);
    // 🧠 medium/hard: prefer ROBUST solutions - a perfect shot that clips the
    //    ridge if it's 1° off is worse than a slightly weaker shot that lands
    //    even with the error this difficulty actually has. Re-rank the top
    //    candidates by a blend of raw score and worst-perturbed score.
    if (cfg.robust > 0 && tops.length > 1) {
      for (const c of tops) {
        let worst = c.s;
        for (let k = 0; k < cfg.robust; k++) {
          const aa = c.a + gauss(rng) * cfg.errA;
          const pp = clamp(c.p + gauss(rng) * cfg.errP, 0.06, 1);
          worst = Math.min(worst, scoreAt(aa, pp, kind).s);
        }
        c.rob = c.s * 0.55 + worst * 0.45;
      }
      tops.sort((x, y) => y.rob - x.rob);
      return refine(tops[0], a0, a1);
    }
    return refine(tops[0], a0, a1);
  };

  let bestNormal = search('normal', cfg.angles, cfg.powers);
  // ⛏️ below-the-horizon fallback: the grid above only searches the upper half
  //    (every sane lob lives there), but a bot parked on a ledge OVER the target
  //    must dip the muzzle below level - humans aim 360°. Only when the upper
  //    half found nothing decent; easy bots stay happily dumb (and derpy-safe).
  if (difficulty !== 'easy' && (!bestNormal || bestNormal.s < 26)) {
    const down = search('normal', Math.max(12, Math.round(cfg.angles * 0.5)), Math.max(6, Math.round(cfg.powers * 0.5)), 0.20, Math.PI - 0.20);
    if (down && down.s > (bestNormal?.s ?? -Infinity)) {
      bestNormal = down; // a dunk from the ledge beats every lob
    }
  }
  let pick = bestNormal;

  // 🎯 guided: homing, cannot miss - the smart fallback when terrain blocks us
  const guidedScore = 63 * ds; // Math.round(50·1.25) - the server's actual direct-hit number
  const poorBallistic = !bestNormal || bestNormal.s < 26;
  if (cfg.guided && (me.inv?.guided | 0) > 0 &&
      (poorBallistic || (difficulty === 'hard' && target.hp <= guidedScore && (bestNormal?.s ?? 0) < target.hp))) {
    const tip = muzzleOf(me, -Math.PI / 2);
    const a = Math.atan2((target.y - 14) - tip.y, target.x - tip.x);
    return { a, p: 0.5, kind: 'guided', targetId: target.id, expect: guidedScore };
  }

  // special shells: medium uses them when clearly better (coin flip), hard
  // min-maxes - tomahawk only to secure a kill or when nothing else works
  if (cfg.specials > 0) {
    if ((me.inv?.cluster | 0) > 0) {
      const bc = search('cluster', Math.round(cfg.angles * 0.7), Math.round(cfg.powers * 0.7));
      if (bc && (!pick || bc.s > pick.s + (difficulty === 'hard' ? 4 : 10)) &&
          (difficulty === 'hard' || rng() < cfg.specials)) pick = bc;
    }
    if ((me.inv?.tomahawk | 0) > 0) {
      const bt = search('tomahawk', Math.round(cfg.angles * 0.7), Math.round(cfg.powers * 0.7));
      if (bt) {
        const secures = bt.s >= target.hp + 10;
        const desperate = !bestNormal || bestNormal.s < 18;
        if (difficulty === 'hard' ? (secures || desperate) : (bt.s > (pick?.s ?? 0) + 12 && rng() < cfg.specials)) pick = bt;
      }
    }
  }

  if (!pick) { // nothing scores at all - harass toward the target anyway
    const left = target.x < me.x;
    return { a: left ? -2.2 : -0.94, p: 0.7, kind: 'normal', targetId: target.id, expect: 0 };
  }

  // ── the difficulty knob: aim error on the engineered solution ──
  const sharp = rng() < cfg.sharpChance;
  const k = sharp ? cfg.sharpScale : 1;
  const a = pick.a + gauss(rng) * cfg.errA * k;
  const p = clamp(pick.p + gauss(rng) * cfg.errP * k, 0.06, 1);
  // 🧠 sanity pass: simulate the ERRORED shot - if it would splash back onto
  //    us (clipped ridge, dropped short), a careful bot discards the error and
  //    fires the clean solution instead. Easy only notices sometimes. 😊
  const check = simulateShot(T, tanks, { ...me, buff: 0 }, a, p, pick.kind, wind);
  let selfDmg = 0, nearSelf = false;
  for (const imp of check) {
    imp.scale = Math.min(6, imp.scale * ds); // server clamps scale at 6
    selfDmg += estimateDamage(imp.x, imp.y, imp.r, imp.scale, me);
    if (Math.hypot(imp.x - me.x, imp.y - me.y) < 110) nearSelf = true;
  }
  if ((selfDmg > 0 || nearSelf) && rng() < cfg.careful) {
    return { a: pick.a, p: pick.p, kind: pick.kind, targetId: target.id, expect: pick.s };
  }
  return { a, p, kind: pick.kind, targetId: target.id, expect: pick.s };
}

// ════════════════════════════════════════════════════════════════════
//  RUNTIME - per-room bot state machine, driven by the server's 10Hz tick.
//  think → (teleport) → (drive) → aim-sweep → fire → server-sim shells
//  → authoritative blasts → settle → server's normal turn rotation.
// ════════════════════════════════════════════════════════════════════

const rand = (a, b) => a + Math.random() * (b - a);

/** Where a hard bot jumps to when it teleports: dry, flat, far from enemies. */
function pickTeleportSpot(T, me, enemies, rng) {
  let best = null, bs = -1;
  for (let i = 0; i < 14; i++) {
    const x = 50 + rng() * (T.width - 100);
    const y = surfOf(T, x);
    if (y > T.waterY - 40) continue;                          // dry land only
    if (Math.abs(surfOf(T, x + 8) - surfOf(T, x - 8)) > 20) continue; // parkable
    const nearest = enemies.length ? Math.min(...enemies.map((e) => Math.abs(e.x - x))) : 999;
    if (nearest < 260) continue;                              // never jump INTO trouble
    const s = Math.min(nearest, 640) + rng() * 40;
    if (s > bs) { bs = s; best = x; }
  }
  return best;
}

/** Should the bot spend its pending teleport this turn? */
function shouldTeleport(cfg, difficulty, T, me, enemies, rng) {
  if (!me.tele || cfg.tele <= 0) return false;
  const nearest = enemies.length ? Math.min(...enemies.map((e) => Math.hypot(e.x - me.x, e.y - me.y))) : 999;
  const inTrouble = nearest < (difficulty === 'hard' ? 300 : 240) || me.y > T.waterY - 110;
  return inTrouble ? rng() < cfg.tele : difficulty === 'hard' && rng() < 0.15;
}

/** Pick a drive destination: crates first, then hard-mode spacing. */
function decideDrive(g, cfg, T, me, enemies) {
  if (!cfg.drive || (me.fuel ?? 100) < 25) return null;
  let dest = null;
  const crates = (g.crates ?? []).filter((c) => c.landed && !c.taken);
  let bd = cfg.drive;
  for (const c of crates) {
    const d = Math.abs(c.x - me.x);
    if (d < bd && surfOf(T, c.x) < T.waterY - 10) { bd = d; dest = c.x; }
  }
  if (dest == null && me.ai === 'hard' && enemies.length) {
    const e = enemies.reduce((m, t) => (Math.abs(t.x - me.x) < Math.abs(m.x - me.x) ? t : m), enemies[0]);
    if (Math.abs(e.x - me.x) < 190) dest = me.x - Math.sign(e.x - me.x) * 240; // too close - back off
  }
  if (dest == null) return null;
  dest = clamp(dest, 40, T.width - 40);
  if (Math.abs(dest - me.x) < 24) return null;
  if (surfOf(T, dest) > T.waterY - 10) return null; // don't drive into the lake
  return dest;
}

/**
 * One tick of every bot in this room. ctx = { applyBlast(room, me, spec),
 * broadcast(room), SETTLE_MS }. `io` relays the synthetic tank-move stream
 * so bots drive and aim-sweep smoothly on every screen.
 */
export function tickRoomAI(room, io, ctx) {
  const g = room.game;
  if (!g || g.phase !== 'playing' || g.mode === 'chaos') return;
  const T = room.sim?.T;
  if (!T) return;
  const tn = g.turn;
  const now = Date.now();
  // real elapsed dt from the server's tick (jitter-clamped); shell substeps stay
  // pinned to 1/60 below so live shells still fly the exact line planShot aimed
  const dt = Math.min(0.5, Math.max(0.02, ctx?.dt ?? 0.1));
  if (!room.aiRt) room.aiRt = new Map();

  // ── in-flight bot shells: real-time server sim alongside the clients ──
  for (const [id, rt] of room.aiRt) {
    if (rt.phase !== 'shells') continue;
    const me = g.tanks.find((t) => t.id === id);
    if (!me || (tn.phase !== 'shot' && tn.phase !== 'settle')) { room.aiRt.delete(id); continue; }
    for (const sh of rt.shells) {
      const subSteps = Math.max(1, Math.round(dt * 60)); // ≈6 per 100ms tick, covering the REAL elapsed time
      for (let k = 0; k < subSteps && !sh.done; k++) { // 1/60s substeps - the SAME dt planShot/simulateShot aim with, so the live shell flies the planned line
        const res = stepShell(T, g.tanks, sh.srcId, sh, 1 / 60);
        if (res === 'fly') continue;
        sh.done = true;
        if (res === null) break; // off the world - splash-down, no boom
        if (res.split) { // cluster bursts, bomblets fly on
          const gy = surfOf(T, res.x);
          for (const [ang, spd] of CLUSTER_FAN) {
            rt.shells.push({
              x: res.x, y: Math.min(res.y - 4, gy - 4),
              vx: Math.cos(ang) * spd + res.vx * 0.2, vy: Math.sin(ang) * spd,
              kind: 'sub', dmgScale: sh.dmgScale, armed: sh.armed, wind: sh.wind, srcId: sh.srcId,
            });
          }
          break;
        }
        const spec = SPEC[sh.kind] ?? SPEC.normal;
        ctx.applyBlast(room, me, {
          x: res.x, y: res.y, r: spec.r,
          scale: spec.scale * (sh.dmgScale || 1), big: !!spec.big,
        });
      }
    }
    rt.shells = rt.shells.filter((s) => !s.done);
    if (!rt.shells.length) {
      if (tn.phase === 'shot' && g.tanks[tn.activeIdx]?.id === id) {
        tn.phase = 'settle'; // mirrors the client's shot-done → settle beat
        tn.settleEnd = now + ctx.SETTLE_MS;
        ctx.broadcast(room);
      }
      room.aiRt.delete(id);
    }
    return; // one shooter's shells at a time is plenty
  }

  if (tn.phase !== 'open') return;
  const me = g.tanks[tn.activeIdx];
  if (!me || me.dead || !me.ai) return;
  if (tn.num === 1 && now - g.startedAt < 4300) return; // let "3, 2, 1, FIGHT!" play out

  const cfg = DIFFS[me.ai] ?? DIFFS.easy;
  const enemies = g.tanks.filter((t) => !t.dead && t.id !== me.id);
  if (!enemies.length) return;

  let rt = room.aiRt.get(me.id);
  if (!rt || rt.ownerTurn !== tn.num) {
    rt = { phase: 'think', t: rand(cfg.thinkMs[0], cfg.thinkMs[1]) / 1000, ownerTurn: tn.num, shells: [] };
    room.aiRt.set(me.id, rt);
  }
  const stream = (s = 0) => io.to(room.id).volatile.emit('tank-move', {
    id: me.id, x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10,
    aim: me.aim, s, fuel: Math.round(me.fuel ?? 100), p: rt.plan?.p ?? 0.5, para: false,
  });

  switch (rt.phase) {
    case 'think': {
      rt.t -= dt;
      if (rt.t > 0) return;
      me.y = surfOf(T, me.x); // ground may have moved since our last turn
      // 🌀 spend a pending teleport FIRST, then re-think from the new spot
      if (shouldTeleport(cfg, me.ai, T, me, enemies, Math.random)) {
        const x = pickTeleportSpot(T, me, enemies, Math.random);
        if (x != null) {
          me.tele = false; me.x = x; me.y = surfOf(T, x);
          io.to(room.id).emit('game-event', { kind: 'teleport', id: me.id, x, y: me.y });
          ctx.broadcast(room);
          rt.t = 0.7;
          return;
        }
        me.tele = false; // nowhere good - let it fizzle rather than waste a turn
      }
      rt.plan = planShot({ T, me, enemies, wind: g.wind, difficulty: me.ai });
      if (!rt.plan) { room.aiRt.delete(me.id); return; }
      rt.driveTo = decideDrive(g, cfg, T, me, enemies);
      if (rt.driveTo != null) { rt.phase = 'drive'; rt.t = 3.6; }
      else { rt.phase = 'aim'; rt.t = 0; rt.aimHold = rand(0.25, 0.5); }
      return;
    }
    case 'drive': {
      rt.t -= dt;
      const dir = Math.sign(rt.driveTo - me.x);
      const nx = me.x + dir * 118 * dt;
      const blocked =
        nx < 34 || nx > T.width - 34 ||
        Math.abs(surfOf(T, nx + 8) - surfOf(T, nx - 8)) > 30 || // too steep
        // 🧭 tanks block only when the step CLOSES the gap (B3) - a bot must
        //    always be free to reverse out of a bumper-to-bumper parking job
        g.tanks.some((o) => o !== me && !o.dead && Math.abs(o.y - me.y) < 32
          && Math.abs(nx - o.x) < 46 && Math.abs(nx - o.x) < Math.abs(me.x - o.x));
      const arrived = Math.abs(rt.driveTo - me.x) < 9;
      if (blocked || arrived || rt.t <= 0 || (me.fuel ?? 100) < 8) {
        rt.phase = 'aim'; rt.t = 0; rt.aimHold = rand(0.25, 0.5);
        stream(0);
        return;
      }
      me.x = nx;
      me.y = surfOf(T, nx);
      me.fuel = Math.max(0, (me.fuel ?? 100) - 9 * dt);
      stream(dir * 118);
      return;
    }
    case 'aim': { // sweep the barrel to the solution - everyone watches it lock on
      const RATE = 2.6; // rad/s turret speed
      let d = rt.plan.a - me.aim;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const step = RATE * dt;
      if (Math.abs(d) > 0.02) {
        me.aim += clamp(d, -step, step);
        stream(0);
        return;
      }
      me.aim = rt.plan.a;
      rt.t += dt;
      if (rt.t < rt.aimHold) { stream(0); return; }
      // ── FIRE - consume exactly like the human fire handler ──
      let kind = ['cluster', 'guided', 'tomahawk'].includes(rt.plan.kind) ? rt.plan.kind : 'normal';
      if (kind !== 'normal') {
        if ((me.inv[kind] | 0) <= 0) kind = 'normal';
        else me.inv[kind]--;
      }
      let dmgScale = 1;
      if ((me.buff | 0) > 0) { me.buff--; dmgScale = 2; }
      const a = rt.plan.a, p = clamp(rt.plan.p, 0.06, 1);
      tn.phase = 'shot';
      tn.fireAt = now;
      io.to(room.id).emit('fire', { id: me.id, a, p, kind, dmgScale });
      rt.phase = 'shells';
      rt.shells = [mkShell({ id: me.id, x: me.x, y: me.y }, a, p, kind, dmgScale, g.wind)];
      rt.shells[0].srcId = me.id;
      ctx.broadcast(room);
      return;
    }
    default:
      room.aiRt.delete(me.id);
  }
}
