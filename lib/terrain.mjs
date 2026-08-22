// ════════════════════════════════════════════════════════════════════
//  TERRAIN ENGINE - Worms-style SIDE VIEW. Seeded, deterministic, no deps.
//
//  Server broadcasts only a seed; every client regenerates the identical
//  terrain bitmap. The world is a solid/air bitmap (Uint8Array) so it is
//  DESTRUCTIBLE-READY: explosions later just clear bits via destroyCircle().
//
//  World: hills from domain-warped 1D fBm → caves carved underground.
//  Render: sky gradient + sun + clouds → parallax mountain layers →
//  dirt/grass body. (Water is disabled - waterY sits below the floor.)
// ════════════════════════════════════════════════════════════════════

/** Terrain size scales with player count: 2P is the classic 1920×1080;
 *  every extra player widens the battlefield (+240px) and deepens it a
 *  touch (+30px) - the fixed fit-scale view zooms out to match. */
export function terrainDims(n) {
  const k = Math.max(2, Math.min(8, n | 0)) - 2; // 0..6 steps past 2 players
  return { width: 1920 + k * 240, height: 1080 + k * 30 };
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];

export function makeNoise2D(seed) {
  const rand = mulberry32(hashSeed(seed));
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rand() * (i + 1) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  return function noise2(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = X & 255, yi = Y & 255;
    const u = fade(xf), v = fade(yf);
    const aa = perm[perm[xi] + yi] & 7, ab = perm[perm[xi] + yi + 1] & 7;
    const ba = perm[perm[xi + 1] + yi] & 7, bb = perm[perm[xi + 1] + yi + 1] & 7;
    const x1 = lerp(GRAD[aa][0] * xf + GRAD[aa][1] * yf, GRAD[ba][0] * (xf - 1) + GRAD[ba][1] * yf, u);
    const x2 = lerp(GRAD[ab][0] * xf + GRAD[ab][1] * (yf - 1), GRAD[bb][0] * (xf - 1) + GRAD[bb][1] * (yf - 1), u);
    return lerp(x1, x2, v);
  };
}

function fbm(noise, x, y, octaves, lac = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerpN = (a, b, t) => a + (b - a) * t;

export async function generateTerrain(seed, width = 1920, height = 1080, onProgress) {
  const hills = makeNoise2D(`${seed}:hills`);
  const bumps = makeNoise2D(`${seed}:bumps`);
  const warp = makeNoise2D(`${seed}:warp`);
  const caves = makeNoise2D(`${seed}:caves`);
  const waterY = height + 50; // water disabled - nothing renders/blocks

  const surface = new Float32Array(width);
  const solid = new Uint8Array(width * height);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // 1) silhouette (Terrain 2.0 A1): a seeded control-point ENVELOPE defines
  //    the intentional macro shape; warped fBm is just surface detail on top.
  const rng = mulberry32(hashSeed(`${seed}:env`));
  const KP = 6;
  const ctrl = new Float32Array(KP);
  for (let i = 0; i < KP; i++) ctrl[i] = rng(); // 0..1 relief per control point
  const envAt = (t) => { // Catmull-Rom through ctrl (endpoints duplicated)
    const g = t * (KP - 1), i = Math.min(KP - 2, Math.floor(g)), f = g - i;
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(KP - 1, i + 2)];
    return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  };
  const raw = new Float32Array(width);
  let rMin = Infinity, rMax = -Infinity;
  for (let x = 0; x < width; x++) {
    const nx = x / width;
    const w = fbm(warp, nx * 2.2, 7.3, 3) * 0.25;
    let e = envAt(nx) * 0.72 + fbm(hills, (nx + w) * 2.8, 0.13, 4) * 0.28;
    e += fbm(bumps, nx * 11.5, 3.71, 3) * 0.07;
    raw[x] = e;
    if (e < rMin) rMin = e;
    if (e > rMax) rMax = e;
  }
  const span = rMax - rMin || 1;
  const TOP = height * 0.14, BOT = height * 0.93; // valleys keep a thick solid floor (water is disabled)
  for (let x = 0; x < width; x++) {
    const t = (raw[x] - rMin) / span; // 0 = lowest valley … 1 = tallest peak
    surface[x] = BOT - t * (BOT - TOP);
  }

  // smoothing: 2 box passes kill needle peaks / tank-trapping spikes
  for (let p = 0; p < 2; p++) {
    let a = surface[0];
    for (let x = 1; x < width - 1; x++) {
      const b = surface[x];
      surface[x] = (a + b * 2 + surface[x + 1]) * 0.25;
      a = b;
    }
  }

  // spawn pads: flat ground where tanks park. Slot count comes from the map
  // width itself (terrainDims inverse) so server + clients derive identical
  // pads from the seed. Fairness: pad heights pulled 75% toward the median.
  const nPl = Math.round((width - 1920) / 240) + 2;
  const PAD = 35; // pad half-width: 70px flat core, 140px eased footprint
  const padYs = [];
  for (let i = 0; i < nPl; i++) {
    const px = Math.round(width * (nPl > 1 ? 0.12 + 0.76 * i / (nPl - 1) : 0.5));
    padYs.push({ px, y: surface[px] });
  }
  const med = [...padYs].sort((a, b) => a.y - b.y)[Math.floor(nPl / 2)].y;
  for (const { px, y } of padYs) {
    const ty = y + (med - y) * 0.75;
    for (let x = Math.max(0, px - PAD * 2); x <= Math.min(width - 1, px + PAD * 2); x++) {
      const d = Math.abs(x - px) / (PAD * 2); // 0 center → 1 edge
      const k = d < 0.5 ? 0 : smoothstep(0.5, 1, d); // flat core, eased shoulder
      surface[x] = surface[x] * k + ty * (1 - k);
    }
  }

  // ── A2: feature stamps (Worms-style landmarks) ──────────────────────
  // Seeded stamp library: mesa + bowl reshape the heightfield BEFORE the
  // solid fill; arch + ledge edit the bitmap AFTER it. Placement is fully
  // deterministic: 1-3 stamps per map; any candidate overlapping a spawn
  // pad, the map-edge margin, or an already-placed stamp is rejected and
  // retried in a fixed draw order; geometric validity re-runs at apply time.
  const sRng = mulberry32(hashSeed(`${seed}:stamps`));
  const sScale = Math.min(1.3, width / 1920);
  const STAMP_TYPES = ['arch', 'bowl', 'ledge', 'mesa'];
  const stampPlan = [];
  const busySpans = padYs.map((p) => [p.px - PAD * 2 - 30, p.px + PAD * 2 + 30]);
  const EDGE = 110;
  const SIDE = 50; // stamp side-clearance inside a free gap (gap ends bound pad spans)
  const spanBusy = (a, b, gap) => busySpans.some(([p0, p1]) => a - gap <= p1 && b + gap >= p0);
  // free x-ranges between pad spans (sorted) - stamps live inside these
  const gaps = [];
  let gx = EDGE;
  for (const [p0, p1] of [...busySpans].sort((p, q) => p[0] - q[0])) {
    if (p0 - gx >= 60) gaps.push([gx, p0]);
    gx = Math.max(gx, p1);
  }
  if (width - EDGE - gx >= 60) gaps.push([gx, width - EDGE]);
  const nStamps = 1 + ((sRng() * 3) | 0); // 1..3 stamps
  for (let s = 0; s < nStamps && gaps.length; s++) {
    const t0 = (sRng() * STAMP_TYPES.length) | 0;
    let type = null;
    if (s === 0) {
      type = (t0 & 1) ? 'mesa' : 'bowl'; // first stamp is a heightfield type:
      // it cannot fail apply-time checks, so every map gets >= 1 landmark
    } else {
      for (let k = 0; k < STAMP_TYPES.length; k++) { // first unused type from t0
        const cand = STAMP_TYPES[(t0 + k) % STAMP_TYPES.length];
        if (!stampPlan.some((p) => p.type === cand)) { type = cand; break; }
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = sRng(), b = sRng(), c = sRng(), d = sRng(), e = sRng(); // fixed draw order
      let halfW, st;
      if (type === 'bowl') {
        const rr = Math.round((90 + a * 140) * sScale);
        halfW = rr; st = { type, rr, depth: 26 + b * 44 };
      } else if (type === 'mesa') {
        const hw = Math.round((55 + a * 110) * sScale), sw = Math.round(hw * 0.6);
        halfW = hw + sw; st = { type, hw, sw, lift: 50 + b * 110 };
      } else if (type === 'arch') {
        const rx = Math.round((60 + a * 100) * sScale);
        halfW = rx; st = { type, rx, ah: 34 + b * 44 };
      } else { // ledge: cx anchors the shelf, it reaches len px in one direction
        const len = Math.round((70 + a * 110) * sScale);
        halfW = len; st = { type, len, th: 10 + b * 8, dir: e < 0.5 ? -1 : 1 };
      }
      let g = gaps[(c * gaps.length) | 0];
      if (attempt === 7) { // last-ditch: widest gap, shrink ANY stamp to fit
        g = gaps.reduce((w, gg) => (gg[1] - gg[0] > w[1] - w[0] ? gg : w), gaps[0]);
        const fit = Math.floor((g[1] - g[0] - 2 * SIDE - 2) / 2);
        // shrink to 60-100% of fit (via d) so dense maps don't get uniform
        // max-size stamps; when fit is tiny take all we can get
        halfW = Math.min(halfW, fit >= 60 ? Math.max(24, Math.floor(fit * (0.6 + 0.4 * d))) : fit);
        if (halfW < 24) break; // gap absurdly narrow - give up on this stamp
        if (type === 'bowl') st.rr = halfW;
        else if (type === 'mesa') { st.hw = Math.floor(halfW / 1.6); st.sw = halfW - st.hw; }
        else if (type === 'arch') st.rx = halfW;
        else st.len = halfW;
      }
      const room = (g[1] - g[0]) - 2 * halfW - 2 * SIDE - 2;
      if (room < 0) continue; // stamp too fat for this gap - deterministic retry
      // SIDE+1 keeps 51px off both gap ends, so the spanBusy margin below
      // can never reject a stamp for merely touching the bounding pad span
      const cx = Math.round(g[0] + SIDE + 1 + halfW + d * room);
      const x0 = cx - halfW, x1 = cx + halfW;
      if (spanBusy(x0, x1, 50)) continue; // overlaps a placed stamp - retry
      st.cx = cx; st.x0 = x0; st.x1 = x1;
      stampPlan.push(st);
      busySpans.push([x0, x1]);
      break;
    }
  }
  const stampsApplied = [];
  const rescanSurface = (x0, x1) => { // surface[] = first solid px from top
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      let y = 0;
      while (y < height && !solid[y * width + x]) y++;
      surface[x] = y;
    }
  };

  // heightfield stamps (pre-fill): bowl digs a crater valley, mesa raises a
  // flat-top hill - both edit surface[] only and the solid fill follows
  for (const st of stampPlan) {
    if (st.type === 'bowl') {
      for (let x = Math.max(1, st.cx - st.rr); x <= Math.min(width - 2, st.cx + st.rr); x++) {
        const t = (x - st.cx) / st.rr, sh = 1 - t * t; // parabola = smooth crater
        if (sh > 0) surface[x] = Math.min(height * 0.95, surface[x] + st.depth * sh);
      }
      stampsApplied.push(st);
    } else if (st.type === 'mesa') {
      let minY = Infinity;
      for (let x = Math.max(0, st.cx - st.hw); x <= Math.min(width - 1, st.cx + st.hw); x++) {
        if (surface[x] < minY) minY = surface[x];
      }
      const ty = Math.max(height * 0.16, minY - st.lift); // flat-top height
      for (let x = Math.max(1, st.cx - st.hw - st.sw); x <= Math.min(width - 2, st.cx + st.hw + st.sw); x++) {
        const dd = Math.abs(x - st.cx);
        const k = dd <= st.hw ? 0 : smoothstep(0, 1, (dd - st.hw) / st.sw);
        const target = ty * (1 - k) + surface[x] * k; // flat core, eased shoulder
        if (target < surface[x]) surface[x] = target; // a mesa only RAISES ground
      }
      stampsApplied.push(st);
    }
  }

  // 2) fill solid below surface, carve caves (never near surface/borders/floor)
  const MARGIN = 26;
  for (let x = 0; x < width; x++) {
    const sy = surface[x];
    for (let y = Math.ceil(sy); y < height; y++) {
      let s = 1;
      const depth = y - sy;
      if (depth > 60 && y < height - 34 && x > MARGIN && x < width - MARGIN) {
        const c = fbm(caves, x / width * 7.3, y / height * 7.3, 3);
        if (c > 0.34) s = 0; // cave pocket
      }
      solid[y * width + x] = s;
    }
    if ((x & 63) === 63) { onProgress?.(x / width * 0.7); await tick(); }
  }

  // bitmap stamps (post-fill, post-caves): arch = drivable tunnel through a
  // hill with a rock bridge overhead; ledge = solid shelf bolted onto a
  // slope with open air beneath. Apply-time checks keep both crisp.
  for (const st of stampPlan) {
    if (st.type === 'arch') {
      const ROOF = 24;
      let minY = Infinity, base = -Infinity;
      for (let x = st.x0; x <= st.x1; x++) {
        if (surface[x] < minY) minY = surface[x];
        if (surface[x] > base) base = surface[x];
      }
      const voidBot = Math.round(minY + ROOF + st.ah); // flat tunnel floor
      if (voidBot > base - 4 || voidBot > height - 40) continue; // too flat / too deep
      const topAt = (x) => voidBot - st.ah * Math.sqrt(Math.max(0, 1 - ((x - st.cx) / st.rx) ** 2));
      let roofOk = true;
      for (let x = Math.max(0, st.cx - st.rx); x <= Math.min(width - 1, st.cx + st.rx) && roofOk; x++) {
        const vt = topAt(x);
        if (vt <= surface[x]) continue; // void mouth in open air - nothing overhead
        let air = 0; // cave pockets inside the would-be bridge?
        for (let y = Math.ceil(surface[x]); y < vt; y++) {
          if (!solid[y * width + x] && ++air > 8) { roofOk = false; break; }
        }
      }
      if (!roofOk) continue; // cave-riddled roof - skip, keep the bridge solid
      for (let x = Math.max(0, st.cx - st.rx); x <= Math.min(width - 1, st.cx + st.rx); x++) {
        const vt = Math.max(0, Math.round(topAt(x)));
        for (let y = vt; y <= Math.min(height - 1, voidBot); y++) solid[y * width + x] = 0;
      }
      rescanSurface(st.cx - st.rx, st.cx + st.rx);
      stampsApplied.push(st);
    } else if (st.type === 'ledge') {
      // anchor at the steepest downhill edge inside the planned span - a
      // random anchor almost never has the under-shelf clearance needed
      let best = null;
      for (let x = st.x0 + 12; x <= st.x1 - 12; x++) {
        for (const dir of [st.dir, -st.dir]) {
          const ahead = x + dir * Math.min(48, st.len);
          if (ahead < 1 || ahead >= width - 1) continue;
          const drop = surface[ahead] - surface[x]; // + = downhill that way
          if (!best || drop > best.drop) best = { x, dir, drop };
        }
      }
      if (!best || best.drop < 24) continue; // no cliff-ish edge in the span
      const ax = best.x, dir = best.dir;
      const len2 = Math.min(st.len, dir > 0 ? st.x1 - ax : ax - st.x0); // stay inside the pad-safe span
      if (len2 < 40) continue;
      const xa = dir > 0 ? ax : ax - len2, xb = dir > 0 ? ax + len2 : ax;
      const sy = Math.round(surface[ax]);
      if (sy < height * 0.2 || sy + st.th + 30 > height - 24) continue;
      let clear = true;
      for (let x = xa; x <= xb && clear; x++) {
        if (Math.abs(x - ax) * 2 <= len2) continue; // inner half may merge into the hillside
        const yt = sy + Math.round(Math.abs(x - ax) * 0.05); // gentle outward sag
        if (surface[x] < yt + st.th + 20) clear = false; // outer half needs open air below
      }
      if (!clear) continue;
      for (let x = xa; x <= xb; x++) {
        const t = Math.abs(x - ax) / len2;
        const yt = sy + Math.round(Math.abs(x - ax) * 0.05);
        const th = Math.max(3, Math.round(st.th * (t > 0.85 ? (1 - t) / 0.15 : 1))); // tapered tip
        for (let y = yt; y < yt + th && y < height - 1; y++) solid[y * width + x] = 1;
      }
      rescanSurface(xa, xb);
      stampsApplied.push(st);
    }
  }
  onProgress?.(0.78);

  // 3) open-sky mask: BFS from borders through air - air NOT reached is cave
  //    interior (rendered dark, no sky/mountains/water behind it)
  const openSky = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let sp = 0;
  const push = (i) => { if (!solid[i] && !openSky[i]) { openSky[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < width * (height - 1)) push(i + width);
  }
  onProgress?.(0.85);

  const terrain = { width, height, seed: String(seed), surface, solid, openSky, waterY, stamps: stampsApplied, theme: themeFor(seed).id, scorch: new Uint8Array(width * height) }; // A6 crater-scorch layer (render-only, rebuilt from the replayed blast log)
  onProgress?.(1);
  return terrain;
}

export function isSolid(terrain, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= terrain.width || yi >= terrain.height) return true; // world walls
  return terrain.solid[yi * terrain.width + xi] === 1;
}

export function getSurfaceY(terrain, x) {
  const xi = Math.max(0, Math.min(terrain.width - 1, Math.round(x)));
  return terrain.surface[xi];
}

export function destroyCircle(terrain, cx, cy, r, collect) {
  const { width, height, solid, surface, scorch } = terrain;
  let cleared = 0;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = y * width + x;
        if (solid[i]) {
          solid[i] = 0; cleared++;
          if (scorch) scorch[i] = 0; // A6: burnt dirt leaves with the blast
          // 🌱 collect CIRCLE-RIM cells only (a 4-neighbour sits outside the
          //    circle) - interior seeds scan nothing but cost the same loop;
          //    removeFloaters re-filters against the final bitmap anyway
          if (collect) {
            const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
            if ((ax + 1) * (ax + 1) + dy * dy > r * r || dx * dx + (ay + 1) * (ay + 1) > r * r) collect.push(i);
          }
        }
      }
    }
  }
  // A6 crater scorching: stamp a burnt ring on the SURVIVING solid between
  //    the blast edge (r) and r*1.35, fading to zero at the outer edge.
  //    Render-only metadata - every client replays the same blast log, so the
  //    scorch layer is rebuilt identically everywhere (zero protocol change).
  if (scorch) {
    const rs = r * 1.35, rs2 = rs * rs, r2 = r * r, fade = 1 / (rs - r);
    const sx0 = Math.max(0, Math.floor(cx - rs)), sx1 = Math.min(width - 1, Math.ceil(cx + rs));
    const sy0 = Math.max(0, Math.floor(cy - rs)), sy1 = Math.min(height - 1, Math.ceil(cy + rs));
    for (let y = sy0; y <= sy1; y++) {
      for (let x = sx0; x <= sx1; x++) {
        const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
        if (d2 <= r2 || d2 > rs2) continue; // destroyed bowl / outside the ring
        const i = y * width + x;
        if (!solid[i]) continue; // scorch lives on surviving dirt only
        const v = ((1 - (Math.sqrt(d2) - r) * fade) * 255) | 0;
        if (v > scorch[i]) scorch[i] = v; // overlapping blasts keep the darkest burn
      }
    }
  }
  for (let x = x0; x <= x1; x++) {
    let y = 0;
    while (y < height && !solid[y * width + x]) y++;
    surface[x] = y;
  }
  return cleared;
}

// ── rendering (pure: RGBA buffer out, no DOM) ─────────────────────────
function grainAt(x, y) {
  let h = x * 374761393 + y * 668265263 | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296 * 2 - 1;
}

/** After destroyCircle: remove thin solid runs (<8px) with air below - blast
 *  rims leave invisible slivers tanks could otherwise "stand" on. */
export function cleanDebris(terrain, cx, cy, r, collect) {
  const { width, height, solid, surface, scorch } = terrain;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
  for (let x = x0; x <= x1; x++) {
    for (let pass = 0; pass < 4; pass++) {
      let a = -1;
      for (let y = 0; y < height; y++) if (solid[y * width + x]) { a = y; break; }
      if (a < 0) break;
      let b = a;
      while (b + 1 < height && solid[(b + 1) * width + x]) b++;
      const airBelow = b + 1 < height && !solid[(b + 1) * width + x];
      if (b - a + 1 < 8 && airBelow) {
        for (let y = a; y <= b; y++) { const i = y * width + x; solid[i] = 0; if (scorch) scorch[i] = 0; if (collect) collect.push(i); }
      } else break;
    }
    surface[x] = height;
    for (let y = 0; y < height; y++) if (solid[y * width + x]) { surface[x] = y; break; }
  }
}

/** Nothing floats: any solid island fully inside the blast box (not touching
 *  its boundary) is deleted, whatever its size; attached nubs <28px² go too.
 *  `seeds` = the cells THIS blast just cleared (destroyCircle/cleanDebris
 *  collect them): only a component touching the cut could have been
 *  disconnected by it - the terrain starts as one connected mass and every
 *  blast re-proves the invariant - so we flood from the crater rim instead of
 *  scanning the whole box (a ~35ms full-box scan becomes ~1ms on a tomahawk).
 *  Returns the bounding boxes of removed islands (for sky repaints). */
export function removeFloaters(terrain, cx, cy, r, seeds) {
  const { width, height, solid, surface, scorch } = terrain;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return []; // 🧯 box fully off the map (crafted coords) - never size a Uint8Array negative
  const bw = x1 - x0 + 1;
  const seen = new Uint8Array(bw * (y1 - y0 + 1));
  const stack = [];
  const removed = [];
  const scan = (sx, sy) => {
      // 🧯 NEVER start a flood outside the box. cleanDebris collects seeds from
      //    FULL columns, so a seed can sit far below y1; the seed-loop guards
      //    only check one side of each axis, so the stepped scan start can land
      //    out-of-box. `seen` is box-sized: an out-of-box start indexes it out
      //    of range, the Uint8Array guard-write is silently DROPPED, the flood
      //    re-visits every cell forever, and the stack grows until the process
      //    dies (RangeError / heap OOM). One guard here covers every caller.
      if (sx < x0 || sx > x1 || sy < y0 || sy > y1) return;
      stack.length = 0; // 🧯 a previous scan may have bailed early (survivor proven) with cells still queued - absorbing those stale cells into THIS component would punch holes in grounded terrain
      const si = (sy - y0) * bw + (sx - x0);
      if (seen[si] || !solid[sy * width + sx]) return;
      let area = 0, boundary = false;
      let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
      const cells = [];
      seen[si] = 1;
      stack.push(sx, sy);
      while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        cells.push(y * width + x);
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x === x0 || x === x1 || y === y0 || y === y1) boundary = true;
        // ✅ survivor proven early: grounded through the box edge AND too big to
        //    be a nub - the rest of this landmass needs no visiting (the common
        //    case: the whole hillside, one dive to the floor instead of a full fill)
        if (boundary && area >= 28) return;
        if (x > x0) { const j = (y - y0) * bw + (x - 1 - x0); if (!seen[j] && solid[y * width + x - 1]) { seen[j] = 1; stack.push(x - 1, y); } }
        if (x < x1) { const j = (y - y0) * bw + (x + 1 - x0); if (!seen[j] && solid[y * width + x + 1]) { seen[j] = 1; stack.push(x + 1, y); } }
        if (y > y0) { const j = (y - 1 - y0) * bw + (x - x0); if (!seen[j] && solid[(y - 1) * width + x]) { seen[j] = 1; stack.push(x, y - 1); } }
        if (y < y1) { const j = (y + 1 - y0) * bw + (x - x0); if (!seen[j] && solid[(y + 1) * width + x]) { seen[j] = 1; stack.push(x, y + 1); } }
      }
      if (!boundary || area < 28) {
        for (const i of cells) { solid[i] = 0; if (scorch) scorch[i] = 0; }
        removed.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
  };
  if (seeds) { // 🌱 rim-seeded: only components touching this blast's cut
    for (const i of seeds) {
      // interior-of-the-cut seeds have no solid neighbour (bitmap is final by
      // now) - skip them, they would scan nothing (that's 99% of a big circle)
      if (!(solid[i - 1] || solid[i + 1] || solid[i - width] || solid[i + width])) continue;
      const x = i % width, y = (i / width) | 0;
      if (x > x0) scan(x - 1, y);
      if (x < x1) scan(x + 1, y);
      if (y > y0) scan(x, y - 1);
      if (y < y1) scan(x, y + 1);
    }
  } else { // no seed list - legacy full-box scan
    for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) scan(sx, sy);
  }
  if (removed.length) {
    for (let x = x0; x <= x1; x++) {
      let y = 0;
      while (y < height && !solid[y * width + x]) y++;
      surface[x] = y;
    }
  }
  return removed;
}

/** Flood-fill openSky into newly opened air (craters) so they render as sky,
 *  not cave-dark. Sealed caves stay dark. */
export function reflowSky(terrain, cx, cy, r) {
  const { width, height, solid, openSky } = terrain;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
  const stack = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * width + x;
    if (!solid[i] && openSky[i]) stack.push(i);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width, y = i / width | 0;
    if (x > x0) { const j = i - 1; if (!solid[j] && !openSky[j]) { openSky[j] = 1; stack.push(j); } }
    if (x < x1) { const j = i + 1; if (!solid[j] && !openSky[j]) { openSky[j] = 1; stack.push(j); } }
    if (y > y0) { const j = i - width; if (!solid[j] && !openSky[j]) { openSky[j] = 1; stack.push(j); } }
    if (y < y1) { const j = i + width; if (!solid[j] && !openSky[j]) { openSky[j] = 1; stack.push(j); } }
  }
}

// ============================================================================
//  THEMES (A3) - one full palette per biome. themeFor(seed) picks from the
//  shared seed, so server + every client derive the identical theme with
//  ZERO protocol change. 'highland' preserves the classic pre-theme colors
//  exactly. Palette is consumed by the painter upgrade in A4.
// ============================================================================
export const THEMES = [
  {
    id: 'highland', // classic greens (current look)
    sky:    { zenith: [30, 58, 122], mid: [96, 168, 232], haze: [219, 233, 248] },
    sun:    { glow: [180, 150, 90], disc: [255, 250, 225] },
    cloud:  { belly: [188, 205, 228], lit: [255, 253, 248] },
    hills:  { far: [147, 169, 196], farCap: [235, 240, 248], near: [93, 116, 142] },
    grass:  { tip: [132, 222, 84], top: [96, 178, 64], root: [46, 104, 34] },
    dirt:   { top: [132, 88, 52], deep: [54, 36, 24], patch: [96, 62, 38], pebble: [108, 100, 88] },
    strata: [[118, 76, 44], [96, 62, 38], [78, 50, 32]],
    rim:    [0.5, 0.5, 0.55],
    cave:   { base: 34, tint: [1, 0.76, 0.58] },
    scorch: [26, 20, 16],
  },
  {
    id: 'desert', // hot bleach sky, sand body, dry scrub fringe
    sky:    { zenith: [38, 108, 186], mid: [126, 186, 232], haze: [250, 234, 196] },
    sun:    { glow: [210, 170, 100], disc: [255, 252, 235] },
    cloud:  { belly: [206, 198, 186], lit: [255, 253, 246] },
    hills:  { far: [196, 168, 128], farCap: [232, 206, 160], near: [152, 118, 82] },
    grass:  { tip: [214, 186, 104], top: [176, 148, 76], root: [104, 84, 42] },
    dirt:   { top: [206, 168, 108], deep: [128, 92, 54], patch: [172, 132, 80], pebble: [150, 130, 104] },
    strata: [[188, 148, 92], [160, 120, 70], [140, 102, 58]],
    rim:    [0.55, 0.5, 0.45],
    cave:   { base: 38, tint: [1, 0.78, 0.55] },
    scorch: [34, 24, 16],
  },
  {
    id: 'tundra', // cold pale sky, snow-crust fringe, frozen dark earth
    sky:    { zenith: [64, 100, 148], mid: [148, 184, 214], haze: [238, 244, 250] },
    sun:    { glow: [150, 150, 130], disc: [255, 255, 246] },
    cloud:  { belly: [198, 208, 220], lit: [255, 255, 255] },
    hills:  { far: [168, 188, 208], farCap: [250, 252, 255], near: [112, 136, 162] },
    grass:  { tip: [236, 240, 244], top: [198, 212, 222], root: [118, 138, 154] },
    dirt:   { top: [96, 86, 74], deep: [46, 40, 36], patch: [72, 66, 60], pebble: [122, 122, 126] },
    strata: [[84, 74, 66], [66, 58, 52], [52, 46, 42]],
    rim:    [0.55, 0.55, 0.6],
    cave:   { base: 30, tint: [0.85, 0.95, 1.1] },
    scorch: [20, 20, 22],
  },
  {
    id: 'volcanic', // ash-choked sky, ember sun, basalt body, scorched scrub
    sky:    { zenith: [42, 32, 44], mid: [118, 66, 54], haze: [228, 138, 78] },
    sun:    { glow: [200, 90, 40], disc: [255, 182, 120] },
    cloud:  { belly: [62, 52, 56], lit: [188, 130, 98] },
    hills:  { far: [82, 62, 70], farCap: [255, 158, 88], near: [56, 44, 52] },
    grass:  { tip: [156, 110, 66], top: [112, 80, 54], root: [58, 44, 34] },
    dirt:   { top: [76, 64, 64], deep: [36, 28, 30], patch: [98, 60, 44], pebble: [92, 86, 90] },
    strata: [[88, 56, 44], [64, 44, 40], [48, 36, 36]],
    rim:    [0.5, 0.45, 0.45],
    cave:   { base: 30, tint: [1, 0.7, 0.6] },
    scorch: [16, 10, 10],
  },
];

/** Deterministic biome pick from the shared seed (zero protocol change). */
export function themeFor(seed) {
  return THEMES[hashSeed(seed) % THEMES.length];
}

export function makeTerrainPainter(terrain) {
  const { width, height, surface, solid, openSky, scorch } = terrain;
  const seed = terrain.seed;
  const th = themeFor(seed); // A3 palette, identical everywhere
  const cloudN = makeNoise2D(`${seed}:clouds`);
  const farN = makeNoise2D(`${seed}:far`);
  const nearN = makeNoise2D(`${seed}:near`);
  const dirtN = makeNoise2D(`${seed}:dirt`);
  const grassN = makeNoise2D(`${seed}:grass`);
  const horizon = height * 0.62;
  const sunX = width * 0.78, sunY = height * 0.15, sunR = height * 0.30;

  const grassT = new Float32Array(width);
  const farY = new Float32Array(width);
  const nearY = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    grassT[x] = 7 + fbm(grassN, x / width * 14, 1.7, 2) * 3;
    farY[x] = height * 0.55 - (fbm(farN, x / width * 2.4, 3.3, 3) + 1) * 0.5 * height * 0.22;
    nearY[x] = height * 0.66 - (fbm(nearN, x / width * 3.6, 9.1, 3) + 1) * 0.5 * height * 0.20;
  }

  const airAbove = (x, y) =>
    y === 0 || !solid[(y - 1) * width + x] ||
    x === 0 || !solid[y * width + x - 1] ||
    x === width - 1 || !solid[y * width + x + 1] ||
    y === height - 1 || !solid[(y + 1) * width + x];

  return function paint(px, py, out, o) { // A5: physics-space coords - fractional under supersampling
    let xi = px | 0; if (xi < 0) xi = 0; else if (xi >= width) xi = width - 1;
    let yi = py | 0; if (yi < 0) yi = 0; else if (yi >= height) yi = height - 1;
    const i = yi * width + xi;
    let r, g, b;

    if (solid[i]) {
      const depth = Math.max(0, py - surface[xi]);
      const gt = grassT[xi];
      // A4 slope lighting: pseudo-normal from surface gradient, sun top-left
      const xa = Math.max(0, xi - 2), xb = Math.min(width - 1, xi + 2);
      const sl = (surface[xa] - surface[xb]) / (xb - xa); // >0 faces the sun
      const light = 1 + Math.max(-0.22, Math.min(0.18, sl * 0.55 + 0.045));
      // A4 crevice AO: pixels deep under the local surface darken a touch
      const ao = depth > 80 ? 1 - Math.min(0.14, (depth - 80) / height * 0.35) : 1;
      if (depth < gt) { // grass fringe: lit tips, 1px highlight, root shadow
        const t = depth / gt;
        const clump = fbm(grassN, px / width * 46, 2.2, 2);
        const dap = (grainAt(xi, yi) - 0.5) * 22;
        if (depth < 1.8) {
          const k = (0.75 + clump * 0.5) * (depth < 1 ? 1.22 : 1) * light;
          r = th.grass.tip[0] * k + dap * 0.4; g = th.grass.tip[1] * k + dap; b = th.grass.tip[2] * k;
        } else {
          r = lerpN(th.grass.top[0], th.grass.root[0], t) + dap * 0.3;
          g = lerpN(th.grass.top[1], th.grass.root[1], t * 0.9) + dap * 0.55;
          b = lerpN(th.grass.top[2], th.grass.root[2], t);
          r *= light; g *= light; b *= light;
          if (depth > gt - 1.5) { r *= 0.72; g *= 0.72; b *= 0.72; }
        }
      } else { // dirt body: theme ramp + mottle + A4 strata + grain + pebbles
        const t = clamp01(depth / (height * 0.55));
        r = lerpN(th.dirt.top[0], th.dirt.deep[0], t);
        g = lerpN(th.dirt.top[1], th.dirt.deep[1], t);
        b = lerpN(th.dirt.top[2], th.dirt.deep[2], t);
        const m = fbm(dirtN, px / width * 9, py / height * 9, 3);
        const mott = m * 16 + Math.sin(py * 0.045 + m * 4) * 4;
        r += mott; g += mott * 0.8; b += mott * 0.6;
        const band = Math.floor((depth + (grainAt(xi, yi >> 3) - 0.5) * 14) / 34); // wobbled boundary
        if (band > 0) {
          const s = th.strata[band % th.strata.length];
          const k = 0.32 + 0.1 * Math.sin(band * 2.7);
          r = r * (1 - k) + s[0] * k; g = g * (1 - k) + s[1] * k; b = b * (1 - k) + s[2] * k;
        }
        const gr = (grainAt(xi, yi) - 0.5) * 13;
        r += gr; g += gr * 0.85; b += gr * 0.7;
        if (m > 0.22) { r = r * 0.82 + th.dirt.patch[0] * 0.18; g = g * 0.82 + th.dirt.patch[1] * 0.18; b = b * 0.82 + th.dirt.patch[2] * 0.18; }
        if (fbm(dirtN, px / width * 72, py / height * 72, 2) > 0.34) {
          r = r * 0.72 + th.dirt.pebble[0] * 0.28; g = g * 0.72 + th.dirt.pebble[1] * 0.28; b = b * 0.72 + th.dirt.pebble[2] * 0.28;
        }
        r *= light * ao; g *= light * ao; b *= light * ao;
      }
      if (depth >= gt && airAbove(xi, yi)) { r *= th.rim[0]; g *= th.rim[1]; b *= th.rim[2]; }
      const sc = scorch ? scorch[i] : 0; // A6 crater scorching - burnt rim darkens toward theme scorch
      if (sc) { const k = sc * 0.00345; r = r * (1 - k) + th.scorch[0] * k; g = g * (1 - k) + th.scorch[1] * k; b = b * (1 - k) + th.scorch[2] * k; }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      return;
    }

    if (!openSky[i]) { // cave interior, theme-tinted
      const v = th.cave.base + grainAt(xi, yi) * 9 + fbm(dirtN, px / width * 12, py / height * 12, 2) * 10;
      out[o] = v * th.cave.tint[0]; out[o + 1] = v * th.cave.tint[1]; out[o + 2] = v * th.cave.tint[2]; out[o + 3] = 255;
      return;
    }

    // themed sky
    const t = clamp01(py / horizon);
    const hz = smoothstep(0.72, 1, t);
    r = lerpN(lerpN(th.sky.zenith[0], th.sky.mid[0], t), th.sky.haze[0], hz);
    g = lerpN(lerpN(th.sky.zenith[1], th.sky.mid[1], t), th.sky.haze[1], hz);
    b = lerpN(lerpN(th.sky.zenith[2], th.sky.mid[2], t), th.sky.haze[2], hz);

    const sd = Math.hypot(px - sunX, py - sunY) / sunR;
    const glow = Math.max(0, 1 - sd);
    r += th.sun.glow[0] * glow * glow; g += th.sun.glow[1] * glow * glow; b += th.sun.glow[2] * glow * glow;
    if (sd < 0.14) { r = th.sun.disc[0]; g = th.sun.disc[1]; b = th.sun.disc[2]; }

    if (py < height * 0.5) { // clouds
      const c = fbm(cloudN, px / width * 3.2, py / height * 7.5, 3);
      const ca = smoothstep(0.06, 0.4, c) * (1 - smoothstep(0.32, 0.5, py / height)) * 0.85;
      if (ca > 0.01) {
        const l2 = smoothstep(0.04, 0.3, fbm(cloudN, px / width * 3.2, (py - 11) / height * 7.5, 3));
        r = lerpN(r, lerpN(th.cloud.belly[0], th.cloud.lit[0], l2), ca);
        g = lerpN(g, lerpN(th.cloud.belly[1], th.cloud.lit[1], l2), ca);
        b = lerpN(b, lerpN(th.cloud.belly[2], th.cloud.lit[2], l2), ca);
      }
    }

    if (py > farY[xi]) { // parallax silhouettes
      const a = 0.62;
      r = lerpN(r, th.hills.far[0], a); g = lerpN(g, th.hills.far[1], a); b = lerpN(b, th.hills.far[2], a);
      if (py - farY[xi] < 7 && farY[xi] < height * 0.42) { const s = 0.5; r = lerpN(r, th.hills.farCap[0], s); g = lerpN(g, th.hills.farCap[1], s); b = lerpN(b, th.hills.farCap[2], s); }
    }
    if (py > nearY[xi]) { const a = 0.95; r = lerpN(r, th.hills.near[0], a); g = lerpN(g, th.hills.near[1], a); b = lerpN(b, th.hills.near[2], a); }

    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  };
}

const PAINTERS = new WeakMap();
function painterFor(terrain) {
  let p = PAINTERS.get(terrain);
  if (!p) { p = makeTerrainPainter(terrain); PAINTERS.set(terrain, p); }
  return p;
}

export function renderTerrainRGBA(terrain) {
  const { width, height } = terrain;
  const paint = painterFor(terrain);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, out, (y * width + x) * 4);
  return out;
}

// == A5 supersampled bake =====================================================
// SS factor by quality tier: High=2, Low=1 (1x path byte-identical to pre-A5).
// Memory guard: maps wider than 6P (2880px) cap at 1.5 so the baked canvas
// stays under ~38MB RGBA (2P-6P at SS2 = 17-53MB... 1920x1080@2 = 33MB).
export function ssForTier(tier, width) {
  if (tier === 'low') return 1;
  return width > 2880 ? 1.5 : 2;
}

const SS_EDGE_T = 24; // RGB delta that marks a high-contrast pixel pair

/**
 * Edge mask of a 1x render: both pixels of every pair whose RGB delta exceeds
 * the threshold. Drives selective supersampling - only these physics pixels
 * get true sub-pixel painter evals (silhouette, rims, strata, grass fringe);
 * smooth interiors copy the 1x paint (visually identical, near-free).
 */
function edgeMask(base, BW, BH) {
  const mask = new Uint8Array(BW * BH);
  for (let y = 0; y < BH; y++) {
    const row = y * BW;
    for (let x = 0; x < BW; x++) {
      const o = (row + x) * 4;
      if (x + 1 < BW) {
        const d = Math.max(
          Math.abs(base[o] - base[o + 4]),
          Math.abs(base[o + 1] - base[o + 5]),
          Math.abs(base[o + 2] - base[o + 6]));
        if (d > SS_EDGE_T) { mask[row + x] = 1; mask[row + x + 1] = 1; }
      }
      if (y + 1 < BH) {
        const o2 = o + BW * 4;
        const d = Math.max(
          Math.abs(base[o] - base[o2]),
          Math.abs(base[o + 1] - base[o2 + 1]),
          Math.abs(base[o + 2] - base[o2 + 2]));
        if (d > SS_EDGE_T) { mask[row + x] = 1; mask[row + BW + x] = 1; }
      }
    }
  }
  return mask;
}

/**
 * Full-map supersampled render on the global SS lattice: sample (X,Y) covers
 * physics point ((X+.5)/ss,(Y+.5)/ss). ~1x paint cost + edge-frac x ss^2 evals
 * (measured ~6-12% at threshold 16 -> SS2 1080p bake ~550-650ms, budget 900).
 */
export function renderTerrainSSRGBA(terrain, ss) {
  const W = terrain.width, H = terrain.height;
  const base = renderTerrainRGBA(terrain); // cached painter, exact 1x look
  const SW = Math.round(W * ss), SH = Math.round(H * ss);
  const out = new Uint8ClampedArray(SW * SH * 4);
  const mask = edgeMask(base, W, H);
  const paint = painterFor(terrain);
  const inv = 1 / ss;
  const colXi = new Int32Array(SW);
  for (let X = 0; X < SW; X++) { const xi = ((X + 0.5) * inv) | 0; colXi[X] = xi >= W ? W - 1 : xi; }
  for (let Y = 0; Y < SH; Y++) {
    const py = (Y + 0.5) * inv;
    let yi = py | 0; if (yi >= H) yi = H - 1;
    const mRow = yi * W, oRow = Y * SW;
    for (let X = 0; X < SW; X++) {
      const xi = colXi[X], o = (oRow + X) * 4;
      if (mask[mRow + xi]) paint((X + 0.5) * inv, py, out, o);
      else { const b = (mRow + xi) * 4; out[o] = base[b]; out[o + 1] = base[b + 1]; out[o + 2] = base[b + 2]; out[o + 3] = 255; }
    }
  }
  return { data: out, w: SW, h: SH };
}

/**
 * Repaint just a rectangle (blast box) - returns {data,x,y,w,h} for
 * putImageData. ss>1: coords returned in SS-canvas space on the SAME global
 * lattice as the full bake, so dirty-rect bytes match a full re-bake exactly
 * (region inflates its 1x paint by 1px so the edge mask sees both sides).
 */
export function renderTerrainRegion(terrain, rx, ry, w, h, ss = 1) {
  const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(terrain.width, Math.ceil(rx + w)), y1 = Math.min(terrain.height, Math.ceil(ry + h));
  const paint = painterFor(terrain);
  if (ss <= 1) {
    const rw = Math.max(1, x1 - x0), rh = Math.max(1, y1 - y0);
    const out = new Uint8ClampedArray(rw * rh * 4);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) paint(x0 + x, y0 + y, out, (y * rw + x) * 4);
    return { data: out, x: x0, y: y0, w: rw, h: rh };
  }
  const SW = Math.round(terrain.width * ss), SH = Math.round(terrain.height * ss);
  const ix0 = Math.max(0, x0 - 1), iy0 = Math.max(0, y0 - 1);
  const ix1 = Math.min(terrain.width, x1 + 1), iy1 = Math.min(terrain.height, y1 + 1);
  const iw = ix1 - ix0, ih = iy1 - iy0;
  const base = new Uint8ClampedArray(iw * ih * 4);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) paint(ix0 + x, iy0 + y, base, (y * iw + x) * 4);
  const mask = edgeMask(base, iw, ih);
  const X0 = Math.max(0, Math.floor(x0 * ss)), Y0 = Math.max(0, Math.floor(y0 * ss));
  const X1 = Math.min(SW, Math.ceil(x1 * ss)), Y1 = Math.min(SH, Math.ceil(y1 * ss));
  const rw = Math.max(1, X1 - X0), rh = Math.max(1, Y1 - Y0);
  const out = new Uint8ClampedArray(rw * rh * 4);
  const inv = 1 / ss;
  for (let Y = Y0; Y < Y1; Y++) {
    const py = (Y + 0.5) * inv;
    let gyi = py | 0; if (gyi >= terrain.height) gyi = terrain.height - 1;
    const bRow = (gyi - iy0) * iw, oRow = (Y - Y0) * rw;
    for (let X = X0; X < X1; X++) {
      let gxi = ((X + 0.5) * inv) | 0; if (gxi >= terrain.width) gxi = terrain.width - 1;
      const o = (oRow + (X - X0)) * 4, bi = bRow + (gxi - ix0);
      if (mask[bi]) paint((X + 0.5) * inv, py, out, o);
      else { const b = bi * 4; out[o] = base[b]; out[o + 1] = base[b + 1]; out[o + 2] = base[b + 2]; out[o + 3] = 255; }
    }
  }
  return { data: out, x: X0, y: Y0, w: rw, h: rh };
}

export function renderTerrainToCanvas(canvas, terrain, ss = 1) {
  const ctx = canvas.getContext('2d');
  if (ss > 1) {
    const r = renderTerrainSSRGBA(terrain, ss);
    canvas.width = r.w; canvas.height = r.h;
    ctx.putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
    return canvas;
  }
  canvas.width = terrain.width;
  canvas.height = terrain.height;
  ctx.putImageData(new ImageData(renderTerrainRGBA(terrain), terrain.width, terrain.height), 0, 0);
  return canvas;
}
