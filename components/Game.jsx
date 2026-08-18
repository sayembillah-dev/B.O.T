'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';
import { generateTerrain, renderTerrainToCanvas, renderTerrainRegion, destroyCircle, cleanDebris, removeFloaters, reflowSky, isSolid } from '@/lib/terrain.mjs';
import { drawTank, TANK_PALETTES, TANK } from '@/lib/tank.mjs';
import { FX } from '@/lib/fx.mjs';
import { BONUS_DEFS, pickDropType } from '@/lib/bonus.mjs';
import { sfx, setMuted, isMuted } from '@/lib/sfx.mjs';

/**
 * 🛡️ TANK BATTLE — Worms-style, side-view destructible terrain, zero sprites.
 * mouse aims (free, live), scroll to set power, click to fire.
 *
 * 🔁 TURNS + FUEL — a turn is OPEN (act) → shot → settle → next player.
 * Power carries across the turn (scroll to adjust any time); firing only
 * requires being parked (grounded, near-zero speed) at the moment you click.
 * Firing ends the turn; Enter passes. Fuel burns while driving/jumping and
 * regenerates slowly; empty tank = engine dead.
 *
 * 🌬️ WIND (milestone 9) — rolled fresh every turn, shown in the top bar.
 * Pushes shells sideways (guided resists), sways parachuting crates, and
 * drifts smoke. Online the server rolls it; locally it's per-turn random.
 *
 * 🛋️ HOT-SEAT — one screen, 2–4 local players (?solo=1&local=N).
 * 🌐 ONLINE (milestone 9) — real multiplayer rooms: the server is authoritative
 * (turn order + timer, wind, HP/inventory, supply drops, blasts). The active
 * player streams their tank and reports shot impacts; everyone else watches
 * the same sim. Late joiners replay the blast log and spectate until rematch.
 *
 * 🎁 SUPPLY DROPS — crates parachute in every 24–40s (max 3, never within
 * 220px of a tank). ×2/×3 = double damage for the next 2/3 hits; 💥 cluster
 * splits into 3; ❤ repairs; 🎯 guided homes onto the closest opponent;
 * 🪓 tomahawk = huge blast + mushroom cloud + white flash + mega shake.
 * Keys 1–4 pick the shell for the next shot (1 = normal).
 *
 * 🔊 SFX — procedural WebAudio (lib/sfx.mjs), zero assets. 🔊 button mutes.
 */
const GRAV = 850;
const POWER_SCROLL = 0.0009;       // power change per wheel-delta unit
const SPEED = (p) => 300 + p * 1200; // more push — full power really launches
const BLAST_R = 58;
const FUEL_BURN = (s) => 3.5 + 15 * (Math.abs(s) / 175); // per-second while driving
const FUEL_REGEN = 1.8;  // per-second while not driving
const FUEL_JUMP = 14;    // one-off jump cost (hefty — hopping is expensive)
const TURN_TIME = 20;    // seconds per turn, then it auto-passes
const WIND_MAX = 95;     // px/s² sideways push on shells at full strength
// 🎯 guided missile — a powered cruise missile, not a lobbed shell. It climbs
// over intervening terrain and only dives once it has a clear look at the target.
const GUIDED_SPEED = 900;  // constant motor speed (px/s) — charge power is irrelevant
const GUIDED_TURN = 9;     // rad/s pitch authority (≈100px turn radius at cruise)
const GUIDED_CLEAR = 95;   // px it tries to stay above the ridgeline ahead
const GUIDED_LOOK = 320;   // px of terrain look-ahead when picking a cruise altitude
const GUIDED_FUEL = 6;     // s of motor burn — then it goes ballistic and drops
// 🎥 shell cam — world-space widths the camera tries to frame (px). Smaller =
// tighter zoom. It never zooms out past the whole-map fit, so small maps are safe.
const CAM_SHELL_W = 1200;  // riding a shell in flight
const CAM_BOOM_W = 950;    // holding on an ordinary crater
const CAM_BIG_W = 1500;    // holding on a tomahawk — wide enough for the mushroom
const CAM_BOOM_HOLD = 0.8; // s to linger on an ordinary blast
const CAM_BIG_HOLD = 1.6;  // s to linger on a tomahawk
// ⏳ pre-round countdown — "3", "2", "1" at 1s each, then "FIGHT!" for a short beat
const COUNTDOWN_TOTAL = 3.6;
const NET_HZ = 12;       // own-tank position stream rate (online)

const LOCAL_EMOJI = ['🐯', '🦊', '🐸', '🐵'];
const LOCAL_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];
const SPAWN_AT = [0.15, 0.85, 0.35, 0.65]; // spread across the map
const WEAPON_KEYS = { 1: 'normal', 2: 'cluster', 3: 'guided', 4: 'tomahawk' };

/** Worms wind ∈ [-1,1], biased toward useful strengths. */
const rollWind = () => {
  const w = Math.random() * 2 - 1;
  return Math.sign(w) * Math.pow(Math.abs(w), 0.7);
};

/** Small name tag floating above a tank (world-space) — stroked for legibility over any terrain. */
const drawNameTag = (ctx, x, y, t) => {
  const label = `${t.emoji ?? ''} ${t.name ?? ''}`.trim();
  if (!label) return;
  ctx.font = 'bold 10px system-ui';
  ctx.textAlign = 'center';
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = 'rgba(8,11,7,0.85)';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = 'rgba(232,236,228,0.92)';
  ctx.fillText(label, x, y);
};

export default function Game({ gs, myId, local = 0 }) {
  const canvasRef = useRef(null);
  const terrainCanvasRef = useRef(null);
  const terrainRef = useRef(null);
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 });
  // 🎥 shell cam — smoothed camera that rides the shell and holds on the impact
  const camRef = useRef({ x: 0, y: 0, scale: 0, init: false, hold: 0, hx: 0, hy: 0, hw: 0, hbig: false });
  // ⏳ pre-round "3, 2, 1, FIGHT!" — remaining seconds; input/turn-timer freeze while > 0
  const countdownRef = useRef(0);
  const cdLabelRef = useRef(null); // last shown label, so the tick/FIGHT sfx fires once per beat
  const tanksRef = useRef([]);
  const aimRef = useRef(-0.6);
  const mouseRef = useRef({ x: 0, y: 0 });
  const chargeRef = useRef({ power: 0.5 });
  const projRef = useRef(null);
  const subsRef = useRef([]);        // cluster sub-munitions
  const bonusRef = useRef([]);       // supply-drop crates (falling + landed)
  const dropTRef = useRef(10);       // countdown to the next supply drop (local modes)
  const crateIdRef = useRef(0);
  const selRef = useRef('normal');   // selected shell for the next shot
  const whiteRef = useRef(0);        // tomahawk white-screen flash (1 → 0)
  const windRef = useRef(0);         // 🌬️ wind ∈ [-1,1] — server-owned online
  const fxRef = useRef(new FX());
  const shakeRef = useRef(0);
  const keysRef = useRef(new Set());
  const turnRef = useRef({ num: 1, phase: 'open', settle: 0, activeIdx: 0, time: TURN_TIME }); // 'open'|'shot'|'settle'|'over' — mirrored from server online
  const gsRef = useRef(null);        // latest game-state prop (read inside effects)
  const onlineRef = useRef(false);   // online multiplayer mode flag
  const myIdRef = useRef(null);
  const netAccRef = useRef(0);       // own-tank stream accumulator
  const blastsDoneRef = useRef([]);  // recent self-reported blasts (dedupe server echo)
  const lastShotMineRef = useRef(false); // online: I fired the in-flight shot
  const numRef = useRef(1);          // last turn number seen (turn-change sfx)
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [colorName, setColorName] = useState(TANK_PALETTES[0].name);
  const [turnInfo, setTurnInfo] = useState({ num: 1, idx: 0, phase: 'open' }); // DOM chips mirror
  const [selUi, setSelUi] = useState('normal'); // weapon slot mirror for the HUD
  const [, setInvUi] = useState(0);  // inventory/buff change → HUD rerender
  const [windUi, setWindUi] = useState(0); // 🌬️ wind chip mirror
  const [mutedUi, setMutedUi] = useState(false);

  const seed = gs?.terrain?.seed;
  const tw = gs?.terrain?.width ?? 1920;
  const th = gs?.terrain?.height ?? 1080;
  const ready = progress === 1;

  // hot-seat roster (synthetic local players); online roster = server tanks
  // (they carry id/name/emoji); lobby roster as fallback
  const roster = local > 0
    ? Array.from({ length: Math.min(4, Math.max(2, local)) }, (_, i) => ({
        id: `local-${i}`, name: LOCAL_NAMES[i], emoji: LOCAL_EMOJI[i],
      }))
    : (gs?.tanks?.length ? gs.tanks : (gs?.players ?? []));

  // 🌐 online = real multiplayer (server game with 2+ tanks); solo dev and
  // hot-seat stay fully client-side
  const online = local === 0 && (gs?.tanks?.length ?? 0) > 1;
  gsRef.current = gs;
  onlineRef.current = online;
  myIdRef.current = myId;
  const spectating = online && !!myId && !(gs?.tanks ?? []).some((t) => t.id === myId);
  // 👑 room master gates game control (server enforces it too); local modes = the only screen is host
  const isHost = !online || !gs?.hostId || gs.hostId === myId;
  const match = gs?.match ?? null; // { round, roundsTotal, wins, over, lastWinner } | null
  const showMatch = online && !!match && match.roundsTotal > 1;

  // ── terrain generation (seed from server) ──
  useEffect(() => {
    if (!seed) return;
    let cancelled = false;
    setProgress(0.0001);
    setError('');
    projRef.current = null;
    subsRef.current = [];
    bonusRef.current = [];
    dropTRef.current = 10;
    chargeRef.current = { power: 0.5 };
    selRef.current = 'normal';
    whiteRef.current = 0;
    blastsDoneRef.current = [];
    lastShotMineRef.current = false;
    countdownRef.current = COUNTDOWN_TOTAL;
    cdLabelRef.current = null;
    turnRef.current = { num: 1, phase: 'open', settle: 0, activeIdx: 0, time: TURN_TIME };
    numRef.current = 1;
    fxRef.current = new FX();
    (async () => {
      try {
        const terrain = await generateTerrain(seed, tw, th, (f) => {
          if (!cancelled) setProgress(Math.min(f, 0.995));
        });
        if (cancelled) return;
        terrainRef.current = terrain;
        const off = renderTerrainToCanvas(document.createElement('canvas'), terrain);
        if (cancelled) return;
        // late-join / spectator: replay the server's blast log so craters match
        const blasts = local > 0 ? [] : (gsRef.current?.blasts ?? []);
        if (blasts.length) {
          for (const b of blasts) {
            destroyCircle(terrain, b.x, b.y, b.r);
            cleanDebris(terrain, b.x, b.y, b.r + 16);
            removeFloaters(terrain, b.x, b.y, b.r + 190);
            reflowSky(terrain, b.x, b.y, b.r + 16);
          }
          renderTerrainToCanvas(off, terrain); // one full repaint after replay
        }
        terrainCanvasRef.current = off;
        const surf = (x) => terrain.surface[Math.max(0, Math.min(terrain.width - 1, Math.round(x)))];
        const srvTanks = local > 0 ? null : (gsRef.current?.tanks ?? null);
        tanksRef.current = roster.map((p, i) => {
          const st = srvTanks ? (srvTanks.find((s) => s.id === p.id) ?? srvTanks[i]) : null;
          let x, y;
          if (st) { // server-assigned spawn (everyone agrees)
            x = st.x;
            y = st.y ?? surf(st.x);
          } else {
            x = Math.round(terrain.width * SPAWN_AT[i % SPAWN_AT.length]);
            let guard = 0;
            while (x < terrain.width - 60 && guard++ < 400 && // find flat, dry parking spot
              (surf(x) > terrain.waterY - 40 || Math.abs(surf(x + 8) - surf(x - 8)) > 7)) x += 12;
            y = surf(x);
          }
          return {
            ...p, x, y, s: 0, rot: 0, susOff: 0, susVel: 0,
            wheelRot: 0, grounded: true, airVy: 0, dustT: 0,
            hp: st?.hp ?? 100, fuel: 100,
            driving: false, dead: !!st?.dead,
            inv: st?.inv ? { ...st.inv } : { cluster: 0, guided: 0, tomahawk: 0 }, // special shells in stock
            buff: st?.buff ?? 0,                                     // ×2-damage hits remaining
            palette: st?.palette ?? (i % TANK_PALETTES.length),
            aim: st?.aim ?? (x < terrain.width / 2 ? -0.6 : -2.54), // face the enemy side
            netX: null, netY: null, netAim: null, netS: 0,          // online: streamed targets
          };
        });
        aimRef.current = tanksRef.current[0]?.aim ?? -0.6;
        // online: mirror crates + wind from the very first game-state
        const gsNow = gsRef.current;
        if (local === 0 && (gsNow?.tanks?.length ?? 0) > 1) {
          bonusRef.current = (gsNow?.crates ?? []).map((c) => ({ ...c, tx: c.x, ty: c.y, tlanded: c.landed }));
          windRef.current = gsNow?.wind ?? 0;
          if (gsNow?.turn) {
            turnRef.current.num = gsNow.turn.num;
            turnRef.current.phase = gsNow.turn.phase;
            turnRef.current.activeIdx = gsNow.turn.activeIdx;
            if (gsNow.turn.endsAt) turnRef.current.time = Math.max(0, (gsNow.turn.endsAt - Date.now()) / 1000);
          }
        } else {
          windRef.current = rollWind();
        }
        setWindUi(windRef.current);
        setTurnInfo({ num: turnRef.current.num, idx: turnRef.current.activeIdx, phase: turnRef.current.phase });
        setSelUi('normal');
        setColorName(TANK_PALETTES[tanksRef.current[0]?.palette ?? 0].name);
        setProgress(1);
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, tw, th]);

  // ── 🌐 online: mirror authoritative server state into local refs ──
  useEffect(() => {
    if (!online || !gs) return;
    if (gs.turn) {
      const tn = turnRef.current;
      const wasPhase = tn.phase;
      tn.num = gs.turn.num;
      tn.phase = gs.turn.phase;
      tn.activeIdx = gs.turn.activeIdx;
      if (gs.turn.endsAt) tn.time = Math.max(0, (gs.turn.endsAt - Date.now()) / 1000);
      setTurnInfo({ num: tn.num, idx: tn.activeIdx, phase: tn.phase });
      if (gs.turn.num !== numRef.current) { numRef.current = gs.turn.num; sfx('turn'); }
      if (wasPhase !== 'over' && tn.phase === 'over') sfx('win');
      const at = tanksRef.current[tn.activeIdx];
      if (at) aimRef.current = at.aim ?? aimRef.current;
    }
    if (typeof gs.wind === 'number') { windRef.current = gs.wind; setWindUi(gs.wind); }
    // authoritative tank fields (positions are owner-streamed, not mirrored)
    for (const st of gs.tanks ?? []) {
      const t = tanksRef.current.find((k) => k.id === st.id);
      if (!t) continue;
      t.hp = st.hp;
      t.inv = { ...st.inv };
      t.buff = st.buff;
      if (st.dead && !t.dead) { t.dead = true; t.driving = false; }
    }
    // crates mirror — positions eased toward server targets in update()
    const prev = bonusRef.current;
    bonusRef.current = (gs.crates ?? []).map((c) => {
      const ex = prev.find((b) => b.id === c.id);
      if (ex) { ex.tx = c.x; ex.ty = c.y; ex.tlanded = c.landed; ex.taken = c.taken; return ex; }
      return { ...c, tx: c.x, ty: c.y, tlanded: c.landed };
    });
    setInvUi((n) => n + 1);
  }, [gs, online]);

  const activeTank = () => tanksRef.current[turnRef.current.activeIdx] ?? null;
  const groundY = (x) => {
    const t = terrainRef.current;
    return t.surface[Math.max(0, Math.min(t.width - 1, Math.round(x)))];
  };
  const pivotOf = (t) => ({ x: t.x + TANK.pivotX, y: (t.y ?? groundY(t.x)) + TANK.pivotY });
  const muzzleOf = (t, a) => {
    const p = pivotOf(t);
    return { x: p.x + Math.cos(a) * (TANK.barrelLen + 7), y: p.y + Math.sin(a) * (TANK.barrelLen + 7) };
  };

  // ── turn rotation (local modes only — server advances online) ──
  const checkGameOver = useCallback(() => {
    const ts = tanksRef.current;
    if (ts.length <= 1) return false; // solo: respawn instead, never "over"
    const alive = ts.filter((t) => !t.dead);
    if (alive.length <= 1) {
      if (turnRef.current.phase !== 'over') sfx('win');
      turnRef.current.phase = 'over';
      setTurnInfo((ti) => ({ ...ti, phase: 'over' }));
      return true;
    }
    return false;
  }, []);

  const advanceTurn = useCallback(() => {
    if (onlineRef.current) return; // server owns rotation online
    const tn = turnRef.current;
    const ts = tanksRef.current;
    if (!ts.length || tn.phase === 'over') return;
    chargeRef.current = { power: 0.5 };
    selRef.current = 'normal'; // weapon pick doesn't carry across turns
    setSelUi('normal');
    if (checkGameOver()) return;
    let i = tn.activeIdx;
    for (let k = 0; k < ts.length; k++) { i = (i + 1) % ts.length; if (!ts[i].dead) break; }
    ts.forEach((t) => { t.driving = false; });
    tn.activeIdx = i;
    tn.num += 1;
    tn.phase = 'open';
    tn.settle = 0;
    tn.time = TURN_TIME;
    aimRef.current = ts[i].aim ?? -0.6; // hand the barrel over as it was left
    windRef.current = rollWind(); // 🌬️ fresh wind every turn (local modes)
    setWindUi(windRef.current);
    sfx('turn');
    setTurnInfo({ num: tn.num, idx: i, phase: 'open' });
    setColorName(TANK_PALETTES[ts[i].palette ?? 0].name);
  }, [checkGameOver]);

  // ── terrain + FX half of an explosion (damage is separate so online
  //    games can apply the server's authoritative numbers) ──
  const explodeTerrain = useCallback((x, y, r = BLAST_R, opts = {}) => {
    const terrain = terrainRef.current;
    const off = terrainCanvasRef.current;
    if (!terrain || !off) return;
    destroyCircle(terrain, x, y, r);
    cleanDebris(terrain, x, y, r + 16); // no invisible slivers to stand on
    const floaters = removeFloaters(terrain, x, y, r + 190); // NOTHING floats — any size island goes
    for (const f of floaters) { // repaint each vanished island's sky region too
      const fr = renderTerrainRegion(terrain, f.x, f.y, f.w, f.h);
      off.getContext('2d').putImageData(new ImageData(fr.data, fr.w, fr.h), fr.x, fr.y);
    }
    reflowSky(terrain, x, y, r + 16); // craters are open to the sky — no black
    const reg = renderTerrainRegion(terrain, x - r - 16, y - r - 16, (r + 16) * 2, (r + 16) * 2);
    off.getContext('2d').putImageData(new ImageData(reg.data, reg.w, reg.h), reg.x, reg.y);
    // 🎥 hold the shell cam on the impact so the blast is actually watched.
    // A big blast outranks an ordinary one (cluster bomblets can't steal focus).
    const cam = camRef.current;
    if (opts.big || !(cam.hbig && cam.hold > 0)) {
      cam.hold = opts.big ? CAM_BIG_HOLD : CAM_BOOM_HOLD;
      cam.hw = opts.big ? CAM_BIG_W : CAM_BOOM_W;
      cam.hx = x;
      cam.hy = opts.big ? y - 120 : y; // bias up so the mushroom is framed
      cam.hbig = !!opts.big;
    }
    if (opts.big) { // ☢️ tomahawk: mushroom cloud + white screen + mega shake + huge ring
      fxRef.current.mushroom(x, y);
      fxRef.current.add({ t: 'ring', x, y, size: 14, grow: 1500, life: 0.9, color: 'rgba(255,250,235,0.9)' });
      whiteRef.current = 1;
      shakeRef.current = Math.max(shakeRef.current, 2.2);
      sfx('bigboom');
    } else {
      fxRef.current.boom(x, y);
      // shockwave: fast thin pressure ring punching past the fireball
      fxRef.current.add({ t: 'ring', x, y, size: 8, grow: 640, life: 0.42, color: 'rgba(255,244,214,0.85)' });
      shakeRef.current = Math.max(shakeRef.current, 0.5);
      sfx('boom');
    }
    // blasts destroy supply crates caught in the radius (local modes; online
    // the server owns crates and broadcasts 'crate-boom' instead)
    if (!onlineRef.current) {
      for (const b of bonusRef.current) {
        if (b.taken) continue;
        if (Math.hypot(b.x - x, (b.landed ? b.y - 14 : b.y) - y) < r + 18) {
          b.taken = true;
          fxRef.current.text(b.x, (b.landed ? b.y - 14 : b.y) - 16, '📦 destroyed', '#ffb45e');
          sfx('crunch');
        }
      }
    }
  }, []);

  // ── full local explosion: terrain + FX + damage (solo / hot-seat) ──
  const explode = useCallback((x, y, r = BLAST_R, opts = {}) => {
    const terrain = terrainRef.current;
    if (!terrain) return;
    const scale = opts.scale ?? 1; // damage/knock multiplier (buffs + special shells)
    explodeTerrain(x, y, r, opts);
    // damage + knockback
    const srf = (xx) => terrain.surface[Math.max(0, Math.min(terrain.width - 1, Math.round(xx)))];
    const knock = Math.min(scale, 2); // cap launch scaling so tomahawk doesn't orbit people
    let died = false;
    for (const t of tanksRef.current) {
      if (t.dead) continue;
      const tx = t.x, ty = (t.y ?? srf(t.x)) - 18;
      const d = Math.hypot(tx - x, ty - y);
      const range = r + 34;
      if (d >= range) continue;
      const direct = d < 30;
      const dmg = direct ? Math.round(50 * scale) : Math.max(2, Math.round(46 * scale * (1 - d / range)));
      t.hp = Math.max(0, t.hp - dmg);
      fxRef.current.text(tx, ty - 24, `-${dmg}`, direct ? '#ff5a4e' : '#ffb45e');
      const ang = Math.atan2(ty - y, tx - x);
      if (direct) { // direct hit: full knockback launch
        const imp = 420 * knock;
        t.grounded = false;
        t.airVy = Math.min(0, Math.sin(ang) * imp) - imp * 0.25;
        t.s = Math.cos(ang) * imp;
      } else { // near miss: slight damage already applied + tiny step back, stays planted
        t.s += Math.cos(ang) * (70 * (1 - d / range) + 25) * knock;
        t.susVel += 3; // suspension flinch
      }
      if (t.hp <= 0) {
        fxRef.current.boom(tx, ty);
        died = true;
        if (tanksRef.current.length > 1) {
          t.dead = true; t.hp = 0; t.driving = false; // eliminated — out of the rotation
          fxRef.current.text(tx, ty - 40, 'ELIMINATED', '#ff5a4e');
        } else { // solo: wreck pop + instant respawn
          let rx = 60 + Math.round(Math.random() * (terrain.width - 180));
          let guard = 0;
          while (Math.abs(srf(rx + 8) - srf(rx - 8)) > 7 && guard++ < 200) rx += 12;
          t.x = Math.min(rx, terrain.width - 60);
          t.y = srf(t.x);
          t.hp = 100; t.s = 0; t.airVy = 0; t.grounded = true; t.fuel = 100;
          fxRef.current.text(t.x, t.y - 56, 'RESPAWN', '#8fd0ff');
        }
      }
    }
    if (died) {
      const tn = turnRef.current;
      setTurnInfo({ num: tn.num, idx: tn.activeIdx, phase: tn.phase }); // refresh chips (dead dimmed)
      checkGameOver();
    }
  }, [explodeTerrain, checkGameOver]);

  // ── 🌐 online: apply the server's authoritative blast report ──
  const applyServerBlast = useCallback((m) => {
    // clear any visual remote shells — the server boom is the truth
    if (projRef.current && !projRef.current.mine) projRef.current = null;
    subsRef.current = subsRef.current.filter((p) => p.mine);
    // dedupe my own echo: I already redrew the terrain locally at impact
    const recent = blastsDoneRef.current;
    const di = recent.findIndex((b) => Math.hypot(b.x - m.x, b.y - m.y) < 6 && performance.now() - b.t < 500);
    const dup = di >= 0;
    if (dup) recent.splice(di, 1);
    if (!dup) explodeTerrain(m.x, m.y, m.r, { scale: m.scale, big: m.big });
    const knock = Math.min(m.scale || 1, 2);
    const range = (m.r || BLAST_R) + 34;
    let died = false;
    for (const d of m.dmg ?? []) {
      const t = tanksRef.current.find((k) => k.id === d.id);
      if (!t) continue;
      const ty = (t.y ?? groundY(t.x)) - 18;
      fxRef.current.text(t.x, ty - 24, `-${d.d}`, d.direct ? '#ff5a4e' : '#ffb45e');
      const ang = Math.atan2(ty - m.y, t.x - m.x);
      if (d.direct) { // direct hit: full knockback launch
        const imp = 420 * knock;
        t.grounded = false;
        t.airVy = Math.min(0, Math.sin(ang) * imp) - imp * 0.25;
        t.s = Math.cos(ang) * imp;
      } else { // near miss: tiny step back + suspension flinch
        const dd = Math.hypot(t.x - m.x, ty - m.y);
        t.s += Math.cos(ang) * (70 * (1 - dd / range) + 25) * knock;
        t.susVel += 3;
      }
      t.hp = d.hp;
      if (d.dead && !t.dead) {
        t.dead = true; t.driving = false;
        fxRef.current.boom(t.x, ty);
        fxRef.current.text(t.x, ty - 40, 'ELIMINATED', '#ff5a4e');
        died = true;
      }
    }
    if (died) sfx('boom');
    setInvUi((n) => n + 1);
    const tn = turnRef.current;
    setTurnInfo({ num: tn.num, idx: tn.activeIdx, phase: tn.phase });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explodeTerrain]);

  // ── fire the (possibly special) shell ──
  const fire = useCallback(() => {
    const me = activeTank();
    if (!me || me.dead || projRef.current || turnRef.current.phase !== 'open') return; // your turn only
    if (onlineRef.current && me.id !== myIdRef.current) return; // online: your tank only
    const a = aimRef.current;
    const p = Math.max(0.06, chargeRef.current.power);
    const tip = muzzleOf(me, a);
    const v = SPEED(p);
    // consume the selected special shell (keys 1–4), fall back to normal if empty
    let kind = 'normal';
    const sel = selRef.current;
    if (sel !== 'normal' && (me.inv?.[sel] | 0) > 0) {
      me.inv[sel]--;
      kind = sel;
      selRef.current = 'normal';
      setSelUi('normal');
    }
    // ×2 / ×3 pickup: double damage for the next N hits
    let dmgScale = 1;
    if ((me.buff | 0) > 0) { me.buff--; dmgScale = 2; }
    if (kind !== 'normal' || dmgScale > 1) setInvUi((n) => n + 1);
    projRef.current = {
      x: tip.x, y: tip.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      src: me, armed: 0, kind, dmgScale, splitT: kind === 'cluster' ? 0.72 : -1, mine: true,
    };
    if (kind === 'tomahawk') fxRef.current.text(tip.x, tip.y - 22, '☢ TOMAHAWK AWAY', '#ff5a4e');
    fxRef.current.muzzle(tip.x, tip.y, a);
    sfx('shoot');
    shakeRef.current = 0.45;
    turnRef.current.phase = 'shot'; // firing ends your action
    setTurnInfo((ti) => ({ ...ti, phase: 'shot' }));
    if (onlineRef.current) { // server validates/consumes authoritatively + relays
      lastShotMineRef.current = true;
      getSocket()?.emit('fire', { a, p, kind });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 🌐 online socket listeners (remote tanks, shots, blasts, crate events) ──
  useEffect(() => {
    if (!ready) return;
    const socket = getSocket();
    if (!socket) return;
    const onTankMove = (m) => {
      const t = tanksRef.current.find((k) => k.id === m?.id);
      if (!t) return;
      if (typeof m.x === 'number') t.netX = m.x;
      if (typeof m.y === 'number') t.netY = m.y;
      if (typeof m.aim === 'number') t.netAim = m.aim;
      if (typeof m.s === 'number') t.netS = m.s;
    };
    const onFire = (m) => { // another player fired — spawn the same shell visually
      if (!m || m.id === myIdRef.current) return;
      const t = tanksRef.current.find((k) => k.id === m.id);
      if (!t || t.dead) return;
      lastShotMineRef.current = false;
      t.aim = m.a;
      const tip = muzzleOf(t, m.a);
      const v = SPEED(m.p);
      projRef.current = {
        x: tip.x, y: tip.y, vx: Math.cos(m.a) * v, vy: Math.sin(m.a) * v,
        src: t, armed: 0, kind: m.kind, dmgScale: m.dmgScale || 1,
        splitT: m.kind === 'cluster' ? 0.72 : -1, mine: false,
      };
      fxRef.current.muzzle(tip.x, tip.y, m.a);
      if (m.kind === 'tomahawk') fxRef.current.text(tip.x, tip.y - 22, '☢ TOMAHAWK AWAY', '#ff5a4e');
      sfx('shoot');
      turnRef.current.phase = 'shot';
      setTurnInfo((ti) => ({ ...ti, phase: 'shot' }));
    };
    const onBlast = (m) => { if (m) applyServerBlast(m); };
    const onEvent = (e) => {
      if (!e) return;
      const def = e.type ? BONUS_DEFS[e.type] : null;
      if (e.kind === 'crate-taken') {
        fxRef.current.text(e.x, e.y - 18, def ? (def.label.startsWith('+') ? `${def.label} ❤` : def.name) : '', def?.color ?? '#fff');
        sfx(e.type === 'hp10' || e.type === 'hp15' ? 'heal' : 'pickup');
      } else if (e.kind === 'crate-boom') {
        fxRef.current.text(e.x, e.y - 16, '📦 destroyed', '#ffb45e');
        sfx('crunch');
      } else if (e.kind === 'crate-land') {
        sfx('thud');
      } else if (e.kind === 'drop') {
        fxRef.current.text(e.x, 26, '📦 supply drop inbound', '#cfd8c3');
        sfx('drop');
      }
    };
    socket.on('tank-move', onTankMove);
    socket.on('fire', onFire);
    socket.on('blast', onBlast);
    socket.on('game-event', onEvent);
    return () => {
      socket.off('tank-move', onTankMove);
      socket.off('fire', onFire);
      socket.off('blast', onBlast);
      socket.off('game-event', onEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, myId, applyServerBlast]);

  // ── game loop ──
  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = performance.now();

    const update = (dt) => {
      const terrain = terrainRef.current;
      const turn = turnRef.current;
      const onlineNow = onlineRef.current;
      fxRef.current.wind = windRef.current; // 🌬️ smoke drifts with the wind

      // ⏳ pre-round countdown — ticks down once, freezes input + the turn timer
      if (countdownRef.current > 0) {
        countdownRef.current = Math.max(0, countdownRef.current - dt);
        const cd = countdownRef.current;
        const label = cd > 2.6 ? '3' : cd > 1.6 ? '2' : cd > 0.6 ? '1' : cd > 0 ? 'FIGHT!' : null;
        if (label !== cdLabelRef.current) { cdLabelRef.current = label; if (label) sfx(label === 'FIGHT!' ? 'go' : 'tick'); }
      }
      const active = activeTank();
      const surf = (x) => terrain.surface[Math.max(0, Math.min(terrain.width - 1, Math.round(x)))];
      const slope = (x) => Math.atan2(surf(x + 8) - surf(x - 8), 16);
      const K = keysRef.current;

      // ── ALL tanks simulate (gravity/footing/knockback); input drives only
      //    the active one — and online, only when it's YOUR tank ──
      for (const me of tanksRef.current) {
        if (me.dead) continue;

        // 🌐 remote tank: follow the owner's stream; still falls if the
        // ground vanishes under it (everyone sees consistent craters)
        if (onlineNow && me.id !== myIdRef.current) {
          if (me.netAim != null) me.aim = me.netAim;
          me.s = me.netS || 0;
          if (me.grounded) {
            const gyNow = surf(me.x);
            const needle = surf(me.x - 14) > me.y + 40 && surf(me.x + 14) > me.y + 40;
            if (gyNow > me.y + 7 || needle) { me.grounded = false; me.airVy = 0; }
            else {
              if (me.netX != null) me.x += (me.netX - me.x) * Math.min(1, 14 * dt);
              me.y = gyNow;
              me.rot += (slope(me.x) - me.rot) * Math.min(1, 12 * dt);
            }
          } else {
            me.airVy += GRAV * dt;
            me.y += me.airVy * dt;
            if (me.netX != null) me.x += (me.netX - me.x) * Math.min(1, 8 * dt);
            me.rot += (0 - me.rot) * Math.min(1, 4 * dt);
            const gy = surf(me.x);
            if (me.y >= gy) {
              me.y = gy;
              me.grounded = true;
              me.susVel += Math.min(300, me.airVy) * 0.16;
              me.airVy = 0;
            }
          }
          me.susVel += (-120 * me.susOff - 13 * me.susVel) * dt;
          me.susOff = Math.max(-3.2, Math.min(4.2, me.susOff + me.susVel * dt));
          me.wheelRot += (me.s * dt) / 2.7;
          continue;
        }

        // act only while the turn is OPEN
        const mine = me === active && turn.phase === 'open' && countdownRef.current <= 0
          && (!onlineNow || me.id === myIdRef.current);
        const dir = mine ? (K.has('a') || K.has('arrowleft') ? -1 : 0) + (K.has('d') || K.has('arrowright') ? 1 : 0) : 0;
        me.driving = false; // proves itself below when the engine actually pushes

        // jump — Worms-style escape hatch (active tank, not while charging, costs fuel)
        if (mine && me.grounded && me.fuel >= FUEL_JUMP && (K.has('w') || K.has('arrowup') || K.has(' '))) {
          me.grounded = false;
          me.airVy = -400;
          me.susVel += 16;
          me.fuel -= FUEL_JUMP;
          sfx('jump');
          fxRef.current.add({ t: 'dirt', x: me.x - 8, y: me.y - 2, vx: -30 - Math.random() * 30, vy: -20, size: 2, life: 0.4 });
          fxRef.current.add({ t: 'dirt', x: me.x + 8, y: me.y - 2, vx: 30 + Math.random() * 30, vy: -20, size: 2, life: 0.4 });
        }
        if (me.grounded) {
          const gyNow = surf(me.x);
          // fall if ground vanished OR we're balancing on a needle (neighbors far below)
          const needle = surf(me.x - 14) > me.y + 40 && surf(me.x + 14) > me.y + 40;
          if (gyNow > me.y + 7 || needle) {
            me.grounded = false;
            me.airVy = 0;
          } else {
          me.y = gyNow; // always rest ON the ground
          const th = slope(me.x);
          me.driving = dir !== 0 && me.fuel > 0; // engine needs fuel
          if (me.driving) {
            // driving: engine + gravity-downhill (+sinθ, y-down) − rolling friction
            me.s += (dir * 520 + GRAV * Math.sin(th) * 0.55 - me.s * 2.2) * dt;
            me.s = Math.max(-175, Math.min(175, me.s));
          } else {
            // no input → handbrake + static friction: parked, even on slopes
            me.s -= me.s * Math.min(1, 14 * dt);
            if (Math.abs(me.s) < 8) me.s = 0;
          }
          if (Math.abs(me.s) > 1 || dir !== 0) {
            const nx = me.x + me.s * Math.cos(th) * dt;
            const ns = surf(nx);
            const nth = slope(nx);
            const uphill = me.s * Math.sin(nth) < 0;
            const hardBlock = nx < 26 || nx > terrain.width - 26 || (ns > terrain.waterY - 4 && ns < me.y + 4);
            if (hardBlock) {
              me.s *= 0.2; // blocked: world edge / water
            } else {
              // very steep uphill → slow crawl, never a hard stop (no more stuck)
              if (Math.abs(nth) > 1.0 && uphill) me.s = Math.sign(me.s) * Math.min(Math.abs(me.s), 42);
              const dyStep = ns - me.y;
              me.x = nx;
              if (ns > me.y + 7 && Math.abs(me.s) > 40) {
                me.grounded = false; // drove off a cliff
                me.airVy = me.s * Math.sin(th);
              } else {
                me.y = ns;
                me.susVel -= Math.max(-14, Math.min(14, dyStep)) * 2.2; // bump jolt
              }
            }
          }
          me.rot += (slope(me.x) - me.rot) * Math.min(1, 12 * dt);
          }
        } else {
          // airborne: gravity + limited air control (active tank only)
          me.s = Math.max(-175, Math.min(175, me.s + dir * 130 * dt));
          me.airVy += GRAV * dt;
          me.y += me.airVy * dt;
          const nxA = me.x + me.s * dt;
          if (nxA >= 26 && nxA <= terrain.width - 26 && surf(nxA) > me.y - 8) me.x = nxA;
          else me.s *= 0.5;
          me.rot += (0 - me.rot) * Math.min(1, 4 * dt);
          const gy = surf(me.x);
          if (me.y >= gy) {
            me.y = gy;
            me.grounded = true;
            me.susVel += Math.min(300, me.airVy) * 0.16; // landing thump
            if (me.airVy > 220) shakeRef.current = Math.max(shakeRef.current, 0.3);
            me.airVy = 0;
          }
        }

        // hydraulic suspension spring (bouncy, damped)
        me.susVel += (-120 * me.susOff - 13 * me.susVel) * dt;
        me.susOff = Math.max(-3.2, Math.min(4.2, me.susOff + me.susVel * dt));
        // wheels spin with actual speed
        me.wheelRot += (me.s * dt) / 2.7;
        // dust kicked from the rear track
        if (me.grounded && Math.abs(me.s) > 28) {
          me.dustT -= dt;
          if (me.dustT <= 0) {
            me.dustT = 0.05;
            fxRef.current.add({
              t: 'dirt', x: me.x - Math.sign(me.s) * 20, y: me.y - 2,
              vx: -me.s * 0.3 + (Math.random() - 0.5) * 40, vy: -25 - Math.random() * 55,
              size: 1.4 + Math.random() * 2.2, life: 0.4 + Math.random() * 0.35,
            });
          }
        }

        // fuel: burn while driving, regenerate slowly otherwise (empty tank = engine dead)
        const wasFuel = me.fuel;
        if (me.driving) me.fuel = Math.max(0, me.fuel - FUEL_BURN(me.s) * dt);
        else me.fuel = Math.min(100, me.fuel + FUEL_REGEN * dt);
        me.noFuelT = Math.max(0, (me.noFuelT || 0) - dt);
        me.stopT = Math.max(0, (me.stopT || 0) - dt);
        if (me === active && me.driving && me.fuel <= 0 && wasFuel > 0 && me.noFuelT <= 0) {
          me.noFuelT = 3;
          fxRef.current.text(me.x, (me.y ?? surf(me.x)) - 62, 'OUT OF FUEL', '#ff9b5e');
          sfx('deny');
        }

        if (me === active) me.aim = aimRef.current; // remember where this tank left its barrel

        // 🌐 stream my tank to the server (it relays to the other players)
        if (onlineNow && me.id === myIdRef.current) {
          netAccRef.current += dt;
          if (netAccRef.current >= 1 / NET_HZ) {
            netAccRef.current = 0;
            getSocket()?.emit('tank-move', {
              x: Math.round(me.x * 10) / 10,
              y: Math.round((me.y ?? 0) * 10) / 10,
              aim: me === active ? aimRef.current : me.aim,
              s: Math.round(me.s || 0),
            });
          }
        }
      }

      // ── supply drops (LOCAL modes only — online the server owns drops and
      //    broadcasts crate state + events) ──
      if (!onlineNow && turn.phase !== 'over') {
        dropTRef.current -= dt;
        if (dropTRef.current <= 0) {
          dropTRef.current = 24 + Math.random() * 16; // not frequent
          if (bonusRef.current.filter((b) => !b.taken).length < 3) {
            for (let k = 0; k < 40; k++) { // find a drop spot away from everyone
              const x = 80 + Math.random() * (terrain.width - 160);
              if (tanksRef.current.some((t) => !t.dead && Math.abs(t.x - x) < 220)) continue;
              bonusRef.current.push({
                id: crateIdRef.current++, type: pickDropType(),
                x, y: -40, vy: 0, sway: 0, landed: false, taken: false, bob: Math.random() * 6.28,
              });
              fxRef.current.text(x, 26, '📦 supply drop inbound', '#cfd8c3');
              sfx('drop');
              break;
            }
          }
        }
        // crate physics: gentle parachute descent with wind-blown sway; rest on
        // the surface; if the ground under a landed crate gets blown away, it falls again
        for (const b of bonusRef.current) {
          if (b.taken) continue;
          if (b.landed && surf(b.x) > b.y + 8) { b.landed = false; b.vy = 0; }
          if (b.landed) { b.y = surf(b.x); continue; }
          b.sway += dt;
          b.vy = Math.min(150, b.vy + GRAV * 0.35 * dt); // parachute drag
          b.x = Math.max(40, Math.min(terrain.width - 40, b.x + Math.sin(b.sway * 2 + b.bob) * 14 * dt + windRef.current * 30 * dt));
          b.y += b.vy * dt;
          const gyB = surf(b.x);
          if (b.y >= gyB) {
            b.y = gyB;
            b.landed = true;
            sfx('thud');
            fxRef.current.add({ t: 'dirt', x: b.x - 6, y: b.y - 2, vx: -25, vy: -30, size: 1.6, life: 0.4 });
            fxRef.current.add({ t: 'dirt', x: b.x + 6, y: b.y - 2, vx: 25, vy: -30, size: 1.6, life: 0.4 });
          }
        }
      } else if (onlineNow) {
        // 🌐 crates mirror the server — ease toward the 10Hz targets
        for (const b of bonusRef.current) {
          if (b.tx == null) continue;
          b.x += (b.tx - b.x) * Math.min(1, 10 * dt);
          b.y += (b.ty - b.y) * Math.min(1, 10 * dt);
          b.landed = !!b.tlanded;
        }
      }

      // ── bonus pickups: drive over a landed crate to absorb it (LOCAL modes;
      //    online the server detects collection from streamed positions) ──
      if (!onlineNow) {
        for (const b of bonusRef.current) {
          if (b.taken || !b.landed) continue;
          for (const t of tanksRef.current) {
            if (t.dead) continue;
            const ty = (t.y ?? surf(t.x)) - 16;
            if (Math.abs(t.x - b.x) > 30 || Math.abs(ty - (b.y - 14)) > 34) continue;
            b.taken = true;
            const def = BONUS_DEFS[b.type];
            if (b.type === 'hp10' || b.type === 'hp15') {
              t.hp = Math.min(100, t.hp + (b.type === 'hp10' ? 10 : 15));
              fxRef.current.text(b.x, b.y - 18, `${def.label} ❤`, def.color);
              sfx('heal');
            } else if (b.type === 'x2' || b.type === 'x3') {
              t.buff = (t.buff | 0) + (b.type === 'x2' ? 2 : 3);
              fxRef.current.text(b.x, b.y - 18, def.name, def.color);
              sfx('pickup');
            } else {
              t.inv[b.type] = (t.inv[b.type] | 0) + 1;
              fxRef.current.text(b.x, b.y - 18, def.name, def.color);
              sfx('pickup');
            }
            setInvUi((n) => n + 1);
            break;
          }
        }
      }

      // ── projectiles (main shell + cluster sub-munitions) ──
      const explodeProj = (p) => {
        const ds = p.dmgScale || 1;
        const spec = p.kind === 'tomahawk' ? { r: 170, scale: 2.6 * ds, big: true } // ☢️
          : p.kind === 'sub' ? { r: 40, scale: 0.75 * ds }
          : p.kind === 'guided' ? { r: BLAST_R, scale: 1.25 * ds }
          : { r: BLAST_R, scale: ds };
        if (!onlineNow) { explode(p.x, p.y, spec.r, spec); return; }
        if (p.mine) {
          // instant local terrain+FX; the server's 'blast' echo brings damage
          explodeTerrain(p.x, p.y, spec.r, spec);
          blastsDoneRef.current.push({ x: p.x, y: p.y, t: performance.now() });
          if (blastsDoneRef.current.length > 12) blastsDoneRef.current.shift();
          getSocket()?.emit('blast', { x: p.x, y: p.y, r: spec.r, scale: spec.scale, big: !!spec.big });
        }
        // remote shell: visual only — the server's 'blast' event makes the boom
      };
      const stepProj = (p) => { // advance one shell; returns false when it's gone
        // 🎯 guided: powered cruise missile. Aiming straight at a ground-level
        // tank just flies it into the dirt, so it climbs to clear the ridgeline
        // ahead and holds that altitude until it has line of sight — then dives.
        let powered = false;
        if (p.kind === 'guided' && (p.armed || 0) < GUIDED_FUEL) {
          let best = null, bd = Infinity;
          for (const t of tanksRef.current) {
            if (t.dead || t === p.src) continue;
            const d = Math.hypot(t.x - p.x, (t.y - 14) - p.y);
            if (d < bd) { bd = d; best = t; }
          }
          if (best) {
            powered = true;
            const tgx = best.x, tgy = (best.y ?? 0) - 14;
            const dx = tgx - p.x;
            const dir = Math.sign(dx) || 1;
            // clear shot at the target? sample the straight line for solid ground
            let los = true;
            for (let i = 1; i < 24; i++) {
              const f = i / 24;
              const sx = p.x + dx * f, sy = p.y + (tgy - p.y) * f;
              if (sx >= 0 && sx < terrain.width && sy >= 0 && isSolid(terrain, sx, sy)) { los = false; break; }
            }
            let want;
            if (los || Math.abs(dx) < 60) {
              want = Math.atan2(tgy - p.y, dx); // terminal dive — straight at them
            } else {
              // cruise: ride GUIDED_CLEAR above the highest ground in the corridor ahead
              let crest = Infinity;
              for (let s = 0; s <= GUIDED_LOOK; s += 16) {
                const sx = Math.max(0, Math.min(terrain.width - 1, Math.round(p.x + dir * s)));
                crest = Math.min(crest, terrain.surface[sx]);
              }
              const cruiseY = Math.min(crest, tgy) - GUIDED_CLEAR;
              // steep climb when low, gentle settle when high — never a shallow
              // beeline at a distant target (that's what used to bury it in a hill)
              const v = Math.max(-2.4, Math.min(2.4, (cruiseY - p.y) / 90));
              want = Math.atan2(v, dir);
            }
            let cur = Math.atan2(p.vy, p.vx);
            let dAng = want - cur;
            while (dAng > Math.PI) dAng -= Math.PI * 2;
            while (dAng < -Math.PI) dAng += Math.PI * 2;
            const maxTurn = GUIDED_TURN * dt;
            cur += Math.max(-maxTurn, Math.min(maxTurn, dAng));
            p.vx = Math.cos(cur) * GUIDED_SPEED; // motor holds speed — no stall, no drop
            p.vy = Math.sin(cur) * GUIDED_SPEED;
          }
        }
        if (!powered) { // ballistic: gravity + full wind (a guided missile ignores both)
          p.vy += GRAV * dt;
          p.vx += windRef.current * WIND_MAX * dt;
        }
        p.armed = (p.armed || 0) + dt;
        // 💥 cluster: always cracks open IN THE AIR into 3 independently-falling
        // bomblets. Fuse burns down, but apex or an imminent impact splits it
        // early — it must never reach the ground as a single shell.
        if (p.kind === 'cluster') {
          p.splitT -= dt;
          const apex = p.vy >= 0 && p.armed > 0.15;         // tipped over the top
          let imminent = false;                             // about to hit something
          if (p.splitT > 0 && !apex) {
            const sp = Math.hypot(p.vx, p.vy) || 1;
            const nx = p.x + (p.vx / sp) * 110, ny = p.y + (p.vy / sp) * 110; // ~110px ahead
            if (nx >= 0 && nx < terrain.width && ny >= 0 && isSolid(terrain, nx, ny)) imminent = true;
            if (!imminent) {
              for (const t of tanksRef.current) {
                if (t.dead || (t === p.src && p.armed < 0.15)) continue;
                if (Math.hypot(t.x - p.x, (t.y - 14) - p.y) < 120) { imminent = true; break; }
              }
            }
          }
          if (p.splitT <= 0 || apex || imminent) {
            const ang = Math.atan2(p.vy, p.vx);
            const base = Math.hypot(p.vx, p.vy);
            // fan of 3: outer two slower so all three land well apart
            for (const [off, mul] of [[-0.40, 0.78], [0, 1.0], [0.40, 0.78]]) {
              subsRef.current.push({
                x: p.x, y: p.y,
                vx: Math.cos(ang + off) * base * mul, vy: Math.sin(ang + off) * base * mul,
                src: p.src, armed: p.armed, kind: 'sub', dmgScale: p.dmgScale, mine: p.mine,
              });
            }
            fxRef.current.muzzle(p.x, p.y, ang);
            fxRef.current.add({ t: 'ring', x: p.x, y: p.y, size: 4, grow: 300, life: 0.35, color: 'rgba(143,208,255,0.9)' });
            fxRef.current.text(p.x, p.y - 16, 'SPLIT!', '#8fd0ff');
            sfx('split');
            return false;
          }
        }
        const dist = Math.hypot(p.vx, p.vy) * dt;
        const steps = Math.max(1, Math.ceil(dist / 4));
        for (let s = 0; s < steps; s++) {
          p.x += (p.vx * dt) / steps;
          p.y += (p.vy * dt) / steps;
          // tank hit — checked every 4px substep, no bypass/tunneling possible
          let hitTank = null;
          for (const t of tanksRef.current) {
            if (t.dead) continue;
            if (t === p.src && p.armed < 0.12) continue; // just left our own muzzle
            const ty = (t.y ?? 0) - 14;
            if (Math.abs(p.x - t.x) < 24 && Math.abs(p.y - ty) < 24 &&
                Math.hypot(p.x - t.x, p.y - ty) < 17) { hitTank = t; break; }
          }
          const inX = p.x >= 0 && p.x < terrain.width;
          if (hitTank) { explodeProj(p); return false; }
          if (inX && p.y >= 0 && isSolid(terrain, p.x, p.y)) { explodeProj(p); return false; }
          if (!inX || p.y > terrain.height + 60) return false; // flew off the world
        }
        return true;
      };
      if (projRef.current && !stepProj(projRef.current)) projRef.current = null;
      if (subsRef.current.length) subsRef.current = subsRef.current.filter((p) => stepProj(p));
      for (const q of [projRef.current, ...subsRef.current]) { // smoke trails
        if (!q) continue;
        const ang = Math.atan2(q.vy, q.vx);
        fxRef.current.trail(q.x - Math.cos(ang) * 8, q.y - Math.sin(ang) * 8, q.vx, q.vy);
      }

      // turn timer — 20s to act (online the server passes the turn at 0).
      // Frozen during the pre-round countdown so it isn't eaten by "3, 2, 1".
      if (turn.phase === 'open' && countdownRef.current <= 0) {
        turn.time -= dt;
        if (turn.time <= 0) {
          if (onlineNow) turn.time = 0;
          else advanceTurn();
        }
      }

      // shot resolved? brief settle so everyone sees the result, then next player's turn
      if (turn.phase === 'shot' && !projRef.current && subsRef.current.length === 0) {
        turn.phase = 'settle';
        turn.settle = 1.3;
        if (onlineNow && lastShotMineRef.current) { // tell the server my shot is done
          lastShotMineRef.current = false;
          getSocket()?.emit('shot-done');
        }
      }
      if (turn.phase === 'settle' && !onlineNow) { // online: server drives settle
        turn.settle -= dt;
        if (turn.settle <= 0) advanceTurn();
      }

      fxRef.current.update(dt);
      if (shakeRef.current > 0) shakeRef.current = Math.max(0, shakeRef.current - dt * 1.6);
      if (whiteRef.current > 0) whiteRef.current = Math.max(0, whiteRef.current - dt * 1.5); // ☢️ flash fades
    };

    const frame = (now) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      update(dt);
      render(now, dt);
      raf = requestAnimationFrame(frame);
    };

    const render = (now, dt) => {
      const canvas = canvasRef.current;
      const off = terrainCanvasRef.current;
      const terrain = terrainRef.current;
      if (!canvas || !off || !terrain) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = canvas.clientWidth, chh = canvas.clientHeight;
      if (!cw || !chh) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(chh * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a0d09';
      ctx.fillRect(0, 0, cw, chh);
      // ── 🎥 shell cam ─────────────────────────────────────────────────
      // Idle it frames the whole map (identical to the old fixed view, so
      // aiming is untouched). While a shell is up it rides along zoomed in,
      // then lingers on the crater before easing back out.
      const cam = camRef.current;
      const fitScale = Math.min(cw / off.width, chh / off.height) * 0.985;
      if (turnRef.current.phase === 'open') cam.hold = 0; // never pan while aiming
      else if (cam.hold > 0) cam.hold = Math.max(0, cam.hold - dt);

      let lead = projRef.current;
      if (!lead && subsRef.current.length) { // cluster: frame the bomblets together
        let sx = 0, sy = 0;
        for (const s of subsRef.current) { sx += s.x; sy += s.y; }
        lead = { x: sx / subsRef.current.length, y: sy / subsRef.current.length };
      }
      // target: whole map by default, else frame a world-width around the action.
      // Math.max keeps it from ever zooming out past the map fit.
      let tx, ty, tScale;
      if (lead) {
        tx = lead.x; ty = lead.y; tScale = Math.max(fitScale, cw / CAM_SHELL_W);
      } else if (cam.hold > 0) {
        tx = cam.hx; ty = cam.hy; tScale = Math.max(fitScale, cw / cam.hw);
      } else { // idle — exactly the old fixed fit view, so aiming is unchanged
        tx = off.width / 2; ty = off.height / 2; tScale = fitScale;
      }
      if (!cam.init) { cam.x = tx; cam.y = ty; cam.scale = tScale; cam.init = true; }
      // exponential smoothing — framerate-independent, snappier while chasing
      const kPos = 1 - Math.exp(-(lead ? 10 : 5) * dt);
      const kZoom = 1 - Math.exp(-(lead ? 4.5 : 4) * dt);
      cam.x += (tx - cam.x) * kPos;
      cam.y += (ty - cam.y) * kPos;
      cam.scale += (tScale - cam.scale) * kZoom;

      const scale = cam.scale;
      // keep the viewport inside the map; centre any axis the map can't fill
      const halfW = cw / (2 * scale), halfH = chh / (2 * scale);
      const cx = off.width <= halfW * 2 ? off.width / 2
        : Math.max(halfW, Math.min(off.width - halfW, cam.x));
      const cy = off.height <= halfH * 2 ? off.height / 2
        : Math.max(halfH, Math.min(off.height - halfH, cam.y));
      const ox = cw / 2 - cx * scale;
      const oy = chh / 2 - cy * scale;
      viewRef.current = { scale, ox, oy };
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, ox, oy, off.width * scale, off.height * scale);

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      fxRef.current.draw(ctx, 'back'); // smoke behind tanks

      const active = activeTank();
      const turn = turnRef.current;

      // supply crates — parachuting in (canopy + cords) or sitting on the
      // ground (pulsing glow box), always visible
      for (const b of bonusRef.current) {
        if (b.taken) continue;
        const def = BONUS_DEFS[b.type];
        const pulse = 0.6 + 0.4 * Math.sin(now * 0.006 + b.bob);
        if (!b.landed) {
          ctx.fillStyle = 'rgba(200,90,70,0.9)'; // parachute canopy
          ctx.beginPath(); ctx.arc(b.x, b.y - 26, 16, Math.PI, 0); ctx.fill();
          ctx.strokeStyle = 'rgba(230,235,225,0.85)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(b.x - 16, b.y - 26); ctx.lineTo(b.x - 9, b.y - 6);
          ctx.moveTo(b.x + 16, b.y - 26); ctx.lineTo(b.x + 9, b.y - 6);
          ctx.moveTo(b.x, b.y - 26); ctx.lineTo(b.x, b.y - 6);
          ctx.stroke();
        } else {
          ctx.globalAlpha = 0.3 * pulse; // landed glow halo
          ctx.fillStyle = def.color;
          ctx.beginPath(); ctx.arc(b.x, b.y - 14, 18, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
        const cy = b.landed ? b.y - 14 : b.y;
        ctx.fillStyle = 'rgba(10,13,9,0.9)';
        ctx.beginPath(); ctx.roundRect(b.x - 12, cy - 12, 24, 24, 6); ctx.fill();
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.roundRect(b.x - 12, cy - 12, 24, 24, 6); ctx.stroke();
        ctx.fillStyle = def.color;
        ctx.font = 'bold 12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(def.label, b.x, cy + 4);
      }

      // tanks (active one shakes while firing/explosions)
      for (let i = 0; i < tanksRef.current.length; i++) {
        const t = tanksRef.current[i];
        if (t.dead) { // eliminated → ghosted skull where the tank fell (gentle bob + fade)
          const gyD = t.y ?? groundY(t.x);
          const bob = Math.sin(now * 0.002 + i * 1.7) * 3;
          ctx.globalAlpha = 0.4 + 0.12 * Math.sin(now * 0.003 + i);
          ctx.font = '24px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText('💀', t.x, gyD - 26 + bob);
          ctx.globalAlpha = 1;
          drawNameTag(ctx, t.x, gyD - 42 + bob, t);
          continue;
        }
        const isActive = t === active;
        const gy = t.y ?? groundY(t.x);
        const sh = isActive ? shakeRef.current : 0;
        const rf = isActive && t.grounded ? Math.min(1, Math.abs(t.s || 0) / 150) : 0; // rumble ∝ speed
        const dx = (sh ? (Math.random() - 0.5) * 5.5 * sh : 0) + (Math.random() - 0.5) * 1.6 * rf;
        const dy = (sh ? (Math.random() - 0.5) * 4 * sh : 0) + (Math.random() - 0.5) * 1.1 * rf;
        drawTank(ctx, t.x + dx, gy + dy, {
          aim: isActive ? aimRef.current : (t.aim ?? -0.6),
          palette: t.palette ?? 0,
          rot: (t.rot || 0) + (Math.random() - 0.5) * 0.022 * rf,
          sus: t.susOff || 0,
          wheelRot: t.wheelRot || 0,
        });

        // active-tank marker: bobbing ▼ (whose turn is it)
        if (isActive && tanksRef.current.length > 1 && turn.phase !== 'over') {
          const bob = Math.sin(now * 0.006) * 3;
          ctx.fillStyle = '#ffd75e';
          ctx.beginPath();
          ctx.moveTo(t.x, gy - 64 + bob);
          ctx.lineTo(t.x - 6.5, gy - 75 + bob);
          ctx.lineTo(t.x + 6.5, gy - 75 + bob);
          ctx.closePath(); ctx.fill();
        }

        drawNameTag(ctx, t.x + dx, gy - 82 + dy, t);

        // power ring + dotted aim guide — always visible on your turn (power is set by scroll)
        if (isActive && turn.phase === 'open' && countdownRef.current <= 0
          && (!onlineRef.current || t.id === myIdRef.current)) {
          const p = chargeRef.current.power;
          const pv = pivotOf(t);
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(255,255,255,0.15)';
          ctx.beginPath(); ctx.arc(pv.x + dx, pv.y + dy, 30, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = `hsl(${120 - p * 120} 90% 55%)`;
          ctx.beginPath(); ctx.arc(pv.x + dx, pv.y + dy, 30, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 13px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText(`${Math.round(p * 100)}%`, pv.x + dx, pv.y + dy - 40);
          // dotted arc actually traces the shot's parabola, so it bends flatter/steeper as power changes
          const a = aimRef.current;
          const tip = muzzleOf(t, a);
          const v = SPEED(Math.max(0.06, p));
          const vx = Math.cos(a) * v, vy0 = Math.sin(a) * v;
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          for (let i = 1; i <= 9; i++) {
            const dt2 = i * 0.09;
            const dx2 = vx * dt2;
            const dy2 = vy0 * dt2 + 0.5 * GRAV * dt2 * dt2;
            ctx.beginPath(); ctx.arc(tip.x + dx2, tip.y + dy2, 1.6, 0, Math.PI * 2); ctx.fill();
          }
        }

        // HP bar with tick points + number
        const hp = t.hp ?? 100;
        const bx = t.x - 23 + (isActive ? dx : 0), by = gy - 52 + (isActive ? dy : 0);
        ctx.fillStyle = 'rgba(10,14,10,0.72)';
        ctx.beginPath(); ctx.roundRect(bx, by, 46, 7, 3); ctx.fill();
        const hw = (hp / 100) * 44;
        if (hw > 0.5) {
          ctx.fillStyle = `hsl(${hp * 1.2} 75% 48%)`;
          ctx.beginPath(); ctx.roundRect(bx + 1, by + 1, hw, 5, 2); ctx.fill();
        }
        ctx.fillStyle = 'rgba(10,14,10,0.85)';
        for (let k = 1; k < 10; k++) ctx.fillRect(bx + 1 + k * 4.4 - 0.5, by + 1, 1, 5);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 8.5px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`${hp}`, t.x + (isActive ? dx : 0), by - 2.5);

        // fuel bar (amber) — burns while driving, regens slowly; flashes red when low
        const fuel = t.fuel ?? 100;
        const fy = by + 10;
        const lowFuel = fuel < 18;
        ctx.globalAlpha = lowFuel ? 0.55 + 0.45 * Math.abs(Math.sin(now * 0.012)) : 1;
        ctx.fillStyle = 'rgba(10,14,10,0.72)';
        ctx.beginPath(); ctx.roundRect(bx, fy, 46, 4.5, 2); ctx.fill();
        const fw = (fuel / 100) * 44;
        if (fw > 0.5) {
          ctx.fillStyle = lowFuel ? '#ff6b4e' : '#f5a623';
          ctx.beginPath(); ctx.roundRect(bx + 1, fy + 1, fw, 2.5, 1); ctx.fill();
        }
        ctx.fillStyle = 'rgba(10,14,10,0.85)';
        for (let k = 1; k < 5; k++) ctx.fillRect(bx + 1 + k * 8.8 - 0.5, fy + 1, 1, 2.5);
        ctx.globalAlpha = 1;
      }

      // shells in flight (main + cluster subs): thruster flame + body
      for (const proj of [projRef.current, ...subsRef.current]) {
        if (!proj) continue;
        const ang = Math.atan2(proj.vy, proj.vx);
        const flick = Math.sin(now * 0.06) * 0.3 + Math.random() * 0.2;
        ctx.save();
        ctx.translate(proj.x, proj.y);
        ctx.rotate(ang);
        if (proj.kind === 'sub') ctx.scale(0.78, 0.78);       // cluster children are smaller
        if (proj.kind === 'tomahawk') ctx.scale(1.35, 1.35);  // ☢️ big boy
        const fl = 10 + flick * 6;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = proj.kind === 'guided' ? 'rgb(255,90,208)' : 'rgb(255,140,50)'; // 🎯 pink thrust
        ctx.beginPath(); ctx.ellipse(-7 - fl / 2, 0, fl / 2, 3.2 + flick, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgb(255,230,140)';
        ctx.beginPath(); ctx.ellipse(-7 - fl / 4, 0, fl / 4, 1.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#2c2f33';
        ctx.beginPath(); ctx.ellipse(0, 0, 7, 3.2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d8452e';
        ctx.beginPath(); ctx.ellipse(4.5, 0, 2.6, 2.4, 0, 0, Math.PI * 2); ctx.fill(); // red nose
        ctx.fillStyle = '#3c4046';
        ctx.fillRect(-8, -4.4, 4, 1.8); // fins
        ctx.fillRect(-8, 2.6, 4, 1.8);
        ctx.restore();
      }

      fxRef.current.draw(ctx, 'front');

      // crosshair — bright while the turn is open, dim otherwise
      const m = mouseRef.current;
      ctx.globalAlpha = turn.phase === 'open' ? 1 : 0.35;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(m.x, m.y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(m.x - 11, m.y); ctx.lineTo(m.x - 4, m.y);
      ctx.moveTo(m.x + 4, m.y); ctx.lineTo(m.x + 11, m.y);
      ctx.moveTo(m.x, m.y - 11); ctx.lineTo(m.x, m.y - 4);
      ctx.moveTo(m.x, m.y + 4); ctx.lineTo(m.x, m.y + 11);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.restore();

      // ☢️ tomahawk white-screen flash (screen space, fades fast)
      if (whiteRef.current > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${(Math.min(1, whiteRef.current) * 0.92).toFixed(3)})`;
        ctx.fillRect(0, 0, cw, chh);
      }

      // ⏱ big turn timer — top-left, green→yellow→red, shakes in the red zone
      if (turn.phase === 'open') {
        const tSec = Math.max(0, turn.time);
        const tShow = Math.ceil(tSec);
        const tCol = tSec > 12 ? '#7fe066' : tSec > 7 ? '#ffd75e' : '#ff4d4d';
        const inRed = tSec <= 7;
        const shakeX = inRed ? (Math.random() - 0.5) * 6 : 0;
        const shakeY = inRed ? (Math.random() - 0.5) * 6 : 0;
        const tx = 16 + shakeX, ty = 54 + shakeY;
        const tw = 84, th = 68;
        ctx.save();
        ctx.fillStyle = 'rgba(6,10,6,0.72)';
        ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 14); ctx.fill();
        ctx.strokeStyle = tCol + (inRed ? 'cc' : '66');
        ctx.lineWidth = inRed ? 2.5 : 1.5;
        ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 14); ctx.stroke();
        ctx.fillStyle = tCol;
        ctx.textAlign = 'center';
        ctx.font = 'bold 40px system-ui';
        ctx.fillText(String(tShow), tx + tw / 2, ty + 48);
        ctx.font = 'bold 10px system-ui';
        ctx.globalAlpha = 0.8;
        ctx.fillText('SEC LEFT', tx + tw / 2, ty + 61);
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // turn banner (screen space, just below the top bar)
      const at = activeTank();
      const multi = tanksRef.current.length > 1;
      const spec = onlineRef.current && myIdRef.current && !tanksRef.current.some((t) => t.id === myIdRef.current);
      let who = at ? `${at.emoji ?? ''} ${at.name ?? ''}`.trim() : '';
      if (at && at.id === myIdRef.current && onlineRef.current) who = `⭐ YOU (${who})`;
      let banner, bCol;
      if (turn.phase === 'over') {
        const alive = tanksRef.current.filter((t) => !t.dead);
        const m = gsRef.current?.match;
        const inMatch = onlineRef.current && m && m.roundsTotal > 1;
        banner = alive[0]
          ? '🏆 ' + (alive[0].emoji ?? '') + ' ' + (alive[0].name ?? '') + (inMatch ? (m.over ? ' WINS THE MATCH!' : ' wins round ' + m.round + '!') : ' WINS!')
          : (inMatch ? '🏳️ round ' + (m?.round ?? '') + ' — DRAW' : '🏳️ DRAW');
        bCol = '#ffd75e';
      } else if (turn.phase === 'open') {
        banner = `${spec ? '👁 spectating · ' : ''}${multi ? who + ' · ' : ''}TURN ${turn.num} — A/D drive · W jump · scroll power · click fire · 1-4 shell · Enter pass`;
        bCol = turn.time <= 7 ? '#ff6b4e' : '#9be15d';
      } else if (turn.phase === 'shot') {
        banner = `🚀 ${multi ? who + ' fired…' : 'shot away…'}`;
        bCol = '#8fd0ff';
      } else {
        banner = '💥 settling…';
        bCol = '#8fd0ff';
      }
      ctx.font = 'bold 13px system-ui';
      const bw = ctx.measureText(banner).width + 26;
      ctx.fillStyle = 'rgba(6,10,6,0.72)';
      ctx.beginPath(); ctx.roundRect(cw / 2 - bw / 2, 46, bw, 24, 12); ctx.fill();
      ctx.strokeStyle = bCol + '66';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(cw / 2 - bw / 2, 46, bw, 24, 12); ctx.stroke();
      ctx.fillStyle = bCol;
      ctx.textAlign = 'center';
      ctx.fillText(banner, cw / 2, 62);

      // ⏳ pre-round countdown — "3, 2, 1, FIGHT!" dead centre, on top of everything
      const cd = countdownRef.current;
      if (cd > 0) {
        const segT = cd > 2.6 ? cd - 2.6 : cd > 1.6 ? cd - 1.6 : cd > 0.6 ? cd - 0.6 : cd; // s left in this beat
        const segDur = cd > 0.6 ? 1 : 0.6;
        const label = cd > 2.6 ? '3' : cd > 1.6 ? '2' : cd > 0.6 ? '1' : 'FIGHT!';
        const col = cd > 2.6 ? '#e8ece4' : cd > 1.6 ? '#ffd75e' : cd > 0.6 ? '#ff6b4e' : '#7fe066';
        const justIn = Math.min(1, 1 - segT / segDur); // 0 → 1 over the first slice of the beat
        const pop = 1 + 0.55 * Math.max(0, 1 - justIn * 4.5); // quick punch-in, settles fast
        ctx.save();
        ctx.fillStyle = 'rgba(4,7,4,0.32)';
        ctx.fillRect(0, 0, cw, chh);
        ctx.globalAlpha = Math.min(1, justIn * 6); // quick fade-in per beat, no fade-out (hard swap reads snappier)
        ctx.translate(cw / 2, chh / 2);
        ctx.scale(pop, pop);
        ctx.font = label === 'FIGHT!' ? 'bold 90px system-ui' : 'bold 140px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 8;
        ctx.strokeStyle = 'rgba(4,7,4,0.85)';
        ctx.strokeText(label, 0, 0);
        ctx.fillStyle = col;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [ready, myId, explode, explodeTerrain, fire, advanceTurn]);

  // ── input: aim always, scroll to set power, click to fire ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toWorld = (e) => {
      const r = canvas.getBoundingClientRect();
      const { scale, ox, oy } = viewRef.current;
      return { x: (e.clientX - r.left - ox) / scale, y: (e.clientY - r.top - oy) / scale };
    };
    const selectWeapon = (kind) => { // keys 1–4: pick the shell for the next shot
      const me = activeTank();
      if (!me || me.dead) return;
      if (onlineRef.current && me.id !== myIdRef.current) return; // your tank only
      if (kind !== 'normal' && !(me.inv?.[kind] > 0)) {
        fxRef.current.text(me.x, (me.y ?? 0) - 62, 'NONE IN STOCK', '#ff9b5e');
        sfx('deny');
        return;
      }
      selRef.current = kind;
      setSelUi(kind);
    };
    const onMove = (e) => {
      const me = activeTank();
      if (!me || !terrainRef.current) return;
      if (onlineRef.current && me.id !== myIdRef.current) return; // online: aim your own barrel only
      const w = toWorld(e);
      mouseRef.current = w;
      const pv = pivotOf(me);
      // full 360° aim — down-left/down-right allowed; assigned raw = instant follow on fast flicks
      aimRef.current = Math.atan2(w.y - pv.y, w.x - pv.x);
    };
    const onDown = (e) => {
      if (e.button !== 0 || !ready || projRef.current || turnRef.current.phase !== 'open' || countdownRef.current > 0) return;
      const me = activeTank();
      if (!me || me.dead) return;
      if (onlineRef.current && me.id !== myIdRef.current) return; // your turn, your tank
      // no shooting on the move: must be parked on the ground to fire
      if (!me.grounded || Math.abs(me.s) > 12) {
        if ((me.stopT || 0) <= 0) {
          me.stopT = 1.5;
          fxRef.current.text(me.x, (me.y ?? 0) - 62, 'STOP TO SHOOT', '#ffd75e');
          sfx('deny');
        }
        return;
      }
      fire();
    };
    const onCtx = (e) => e.preventDefault();
    const onWheel = (e) => { // scroll sets power — any time it's your turn, no need to hold
      const me = activeTank();
      if (!me || me.dead || turnRef.current.phase !== 'open' || countdownRef.current > 0) return;
      if (onlineRef.current && me.id !== myIdRef.current) return;
      e.preventDefault();
      chargeRef.current.power = Math.max(0, Math.min(1, chargeRef.current.power - e.deltaY * POWER_SCROLL));
    };
    const onKey = (e, down) => {
      const k = e.key.toLowerCase();
      if (['a', 'd', 'arrowleft', 'arrowright', 'w', 'arrowup', ' '].includes(k)) {
        e.preventDefault();
        if (down) keysRef.current.add(k); else keysRef.current.delete(k);
      }
      if (!down) return;
      if (countdownRef.current > 0) return; // no acting until "FIGHT!"
      if (k === 'enter' && turnRef.current.phase === 'open') {
        e.preventDefault(); // pass the turn to the next player
        if (onlineRef.current) getSocket()?.emit('pass-turn');
        else advanceTurn();
      }
      if (WEAPON_KEYS[k] && turnRef.current.phase === 'open') selectWeapon(WEAPON_KEYS[k]);
    };
    const onKeyDown = (e) => onKey(e, true);
    const onKeyUp = (e) => onKey(e, false);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [ready, myId, fire, advanceTurn]);

  const cycleColor = () => {
    const t = activeTank();
    if (!t) return;
    if (onlineRef.current && t.id !== myIdRef.current) return; // recolor your own tank only
    t.palette = ((t.palette ?? 0) + 1) % TANK_PALETTES.length;
    setColorName(TANK_PALETTES[t.palette].name);
  };

  const toggleMute = () => {
    const m = !mutedUi;
    setMuted(m);
    setMutedUi(m);
    if (!m) sfx('turn'); // little "sound is back" blip
  };

  // 🌬️ wind chip label: chevrons ∝ strength, direction = push direction
  const windLabel = (() => {
    const n = Math.round(Math.abs(windUi) * 5);
    if (n === 0) return '—';
    return (windUi > 0 ? '▶' : '◀').repeat(n);
  })();

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0d09', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'none' }} />

      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)',
      }} />

      {/* top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, display: 'flex',
        alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem',
        background: 'linear-gradient(rgba(5,8,5,0.75), transparent)',
        color: '#e8ece4', fontFamily: 'system-ui, sans-serif',
      }}>
        <strong style={{ fontSize: '1.05rem' }}>🛡️ tank battle</strong>
        <code style={{
          background: 'rgba(255,255,255,0.1)', borderRadius: 6,
          padding: '0.15rem 0.5rem', fontSize: '0.8rem',
        }}>seed {seed}</code>
        <span style={{
          background: local > 0 ? 'rgba(127,200,255,0.15)' : online ? 'rgba(155,225,93,0.15)' : 'rgba(255,210,80,0.15)',
          color: local > 0 ? '#7fc8ff' : online ? '#9be15d' : '#ffd250', borderRadius: 6,
          padding: '0.15rem 0.5rem', fontSize: '0.75rem', fontWeight: 600,
        }}>{local > 0 ? `HOT-SEAT ${roster.length}P` : online ? `ONLINE ${roster.length}P` : 'SOLO DEV'}</span>
        {ready && (
          <span
            title={`wind ${windUi > 0 ? '→' : windUi < 0 ? '←' : 'calm'} (${Math.round(Math.abs(windUi) * 100)}%)`}
            style={{
              background: 'rgba(143,208,255,0.12)', color: '#8fd0ff', borderRadius: 6,
              padding: '0.15rem 0.5rem', fontSize: '0.8rem', fontWeight: 700,
              letterSpacing: 1, minWidth: '4.6rem', textAlign: 'center',
            }}
          >🌬️ {windLabel}</span>
        )}
        {showMatch && (
          <span style={{
            background: 'rgba(255,215,94,0.14)', color: '#ffd75e', borderRadius: 6,
            padding: '0.15rem 0.5rem', fontSize: '0.78rem', fontWeight: 700,
          }}>ROUND {match.round}/{match.roundsTotal}</span>
        )}
        <span style={{ fontSize: '0.8rem', opacity: 0.75 }}>A/D drive · W jump · scroll power · click fire · 1-4 shell · Enter pass</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={toggleMute} title={mutedUi ? 'unmute' : 'mute'}>{mutedUi ? '🔇' : '🔊'}</button>
        <button className="btn" onClick={cycleColor}>🎨 {colorName}</button>
        {isHost && turnInfo.phase !== 'over' && (
          <>
        <button className="btn" onClick={() => getSocket()?.emit('regen-terrain')}>🎲 New terrain</button>
        <button className="btn" onClick={() => getSocket()?.emit('end-game')}>🏁 End game</button>
          </>
        )}
      </div>

      {/* loading */}
      {!ready && !error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          background: '#0a0d09', color: '#cfd8c3', fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ width: 280, textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⛰️</div>
            <div style={{ marginBottom: '0.75rem' }}>forging terrain… {Math.round(progress * 100)}%</div>
            <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)' }}>
              <div style={{
                height: '100%', borderRadius: 3, background: '#7fb069',
                width: `${progress * 100}%`, transition: 'width 0.15s',
              }} />
            </div>
          </div>
        </div>
      )}

      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          color: '#ff9b9b', fontFamily: 'monospace',
        }}>terrain error: {error}</div>
      )}

      {/* players — active turn highlighted, eliminated dimmed */}
      <div style={{
        position: 'absolute', left: '1rem', bottom: '1rem', display: 'flex',
        gap: '0.4rem', flexWrap: 'wrap', fontFamily: 'system-ui, sans-serif',
      }}>
        {roster.map((p, i) => {
          const t = tanksRef.current[i];
          const isActive = roster.length > 1 && turnInfo.idx === i && turnInfo.phase !== 'over';
          const winner = turnInfo.phase === 'over' && t && !t.dead && roster.length > 1;
          const dead = !!t?.dead;
          return (
            <span key={p.id} style={{
              background: winner ? 'rgba(255,215,94,0.28)'
                : isActive ? 'rgba(255,215,94,0.18)'
                : p.id === myId ? 'rgba(127,176,105,0.25)' : 'rgba(0,0,0,0.5)',
              border: winner || isActive ? '1px solid rgba(255,215,94,0.75)'
                : p.id === myId ? '1px solid rgba(127,176,105,0.6)' : '1px solid rgba(255,255,255,0.12)',
              color: '#e8ece4', borderRadius: 999, padding: '0.25rem 0.7rem', fontSize: '0.8rem',
              opacity: dead ? 0.35 : 1, textDecoration: dead ? 'line-through' : 'none',
              transition: 'all 0.25s',
            }}>
              {winner ? '🏆 ' : isActive ? '▶ ' : ''}{p.emoji} {p.name}{showMatch ? ` · ${match.wins?.[p.id] | 0}W` : ''}{p.id === myId ? ' (you)' : ''}
            </span>
          );
        })}
      </div>

      {/* shell inventory — active tank's stock, keys 1-4 to pick */}
      {ready && turnInfo.phase !== 'over' && (() => {
        const t = tanksRef.current[turnInfo.idx];
        if (!t) return null;
        const slots = [
          { k: 'normal', icon: '🚀', key: '1', n: null },
          { k: 'cluster', icon: '💥', key: '2', n: t.inv?.cluster | 0 },
          { k: 'guided', icon: '🎯', key: '3', n: t.inv?.guided | 0 },
          { k: 'tomahawk', icon: '🪓', key: '4', n: t.inv?.tomahawk | 0 },
        ];
        return (
          <div style={{
            position: 'absolute', right: '1rem', bottom: '1rem', display: 'flex',
            gap: '0.35rem', alignItems: 'center', fontFamily: 'system-ui, sans-serif',
          }}>
            {(t.buff | 0) > 0 && (
              <span style={{
                background: 'rgba(255,215,94,0.2)', border: '1px solid rgba(255,215,94,0.7)',
                color: '#ffd75e', borderRadius: 8, padding: '0.25rem 0.55rem',
                fontSize: '0.78rem', fontWeight: 700,
              }}>⚡2× DMG · {t.buff} shot{t.buff > 1 ? 's' : ''}</span>
            )}
            {slots.map((s) => {
              const empty = s.n !== null && s.n <= 0;
              const selNow = selUi === s.k;
              return (
                <span key={s.k} title={`${s.key} — ${s.k}`} style={{
                  background: selNow ? 'rgba(143,208,255,0.25)' : 'rgba(0,0,0,0.5)',
                  border: selNow ? '1px solid #8fd0ff' : '1px solid rgba(255,255,255,0.14)',
                  borderRadius: 8, padding: '0.25rem 0.5rem', fontSize: '0.85rem',
                  color: '#e8ece4', opacity: empty ? 0.3 : 1, transition: 'all 0.2s',
                }}>
                  {s.icon}{s.n !== null && <span style={{ fontSize: '0.72rem', marginLeft: 3, opacity: 0.85 }}>×{s.n}</span>}
                  <span style={{ fontSize: '0.62rem', marginLeft: 4, opacity: 0.55 }}>{s.key}</span>
                </span>
              );
            })}
          </div>
        );
      })()}

      {/* 🏆 game over — round result, match scoreboard, host controls */}
      {ready && turnInfo.phase === 'over' && (() => {
        const roundWinner = online
          ? (gs?.winner ? roster.find((p) => p.id === gs.winner) ?? null : null)
          : (tanksRef.current.filter((t) => !t.dead)[0] ?? null);
        const board = showMatch
          ? roster.map((p) => ({ p, w: match.wins?.[p.id] | 0 })).sort((a, b) => b.w - a.w)
          : [];
        const champ = match?.over && board.length > 0 && board[0].w > 0 && (board.length === 1 || board[0].w > board[1].w)
          ? board[0].p : null;
        const title = match?.over && showMatch
          ? (champ ? `🏆 ${champ.emoji} ${champ.name} WINS THE MATCH!` : '🏳️ MATCH DRAW')
          : (roundWinner
              ? `🏆 ${roundWinner.emoji ?? ''} ${roundWinner.name ?? ''} ${showMatch ? `wins round ${match.round}!` : 'WINS!'}`
              : '🏳️ DRAW');
        const btn = (label, event, primary) => (
          <button
            key={event}
            className="btn"
            onClick={() => getSocket()?.emit(event)}
            style={{
              padding: '0.7rem 1.3rem', fontSize: '0.95rem', fontWeight: 700, borderRadius: 10,
              background: primary ? 'linear-gradient(90deg,#7fb069,#9be15d)' : 'rgba(255,255,255,0.1)',
              color: primary ? '#0a0d09' : '#e8ece4', border: 'none', cursor: 'pointer',
            }}
          >{label}</button>
        );
        return (
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            background: 'rgba(4,7,4,0.55)', backdropFilter: 'blur(3px)',
            fontFamily: 'system-ui, sans-serif', zIndex: 10,
          }}>
            <div style={{
              background: 'rgba(10,14,9,0.92)', border: '1px solid rgba(255,215,94,0.35)',
              borderRadius: 16, padding: '1.6rem 2.2rem', textAlign: 'center',
              boxShadow: '0 12px 60px rgba(0,0,0,0.6)', minWidth: 300,
            }}>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#ffd75e', marginBottom: '0.4rem' }}>{title}</div>
              {showMatch && !match.over && (
                <div style={{ color: '#9fb08f', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                  round {match.round} of {match.roundsTotal}
                </div>
              )}
              {board.length > 0 && (
                <div style={{ margin: '0.9rem 0 0.4rem', display: 'grid', gap: '0.3rem' }}>
                  {board.map(({ p, w }, i) => (
                    <div key={p.id} style={{
                      display: 'flex', justifyContent: 'space-between', gap: '2rem',
                      padding: '0.3rem 0.8rem', borderRadius: 8,
                      background: i === 0 && w > 0 ? 'rgba(255,215,94,0.16)' : 'rgba(255,255,255,0.05)',
                      color: i === 0 && w > 0 ? '#ffd75e' : '#cfd8c3', fontSize: '0.9rem',
                      fontWeight: i === 0 ? 700 : 500,
                    }}>
                      <span>{i === 0 && w > 0 ? '👑 ' : ''}{p.emoji} {p.name}{p.id === myId ? ' (you)' : ''}</span>
                      <span>{w}W</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center', marginTop: '1.2rem', flexWrap: 'wrap' }}>
                {isHost ? (
                  <>
                    {showMatch && !match.over && btn(`⚔️ Next round (${match.round + 1}/${match.roundsTotal})`, 'next-round', true)}
                    {showMatch && match.over && btn('🏆 New match', 'new-match', true)}
                    {!showMatch && btn('🎲 Rematch', 'regen-terrain', true)}
                    {showMatch && !match.over && btn('🔁 Replay round', 'regen-terrain', false)}
                    {btn(match?.over ? '🏁 Back to lobby' : '🏁 End game', 'end-game', false)}
                  </>
                ) : (
                  <div style={{ color: '#9fb08f', fontSize: '0.9rem', padding: '0.5rem 0' }}>
                    waiting for the 👑 room master…
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
