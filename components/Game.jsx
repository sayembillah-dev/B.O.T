'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { generateTerrain, renderTerrainToCanvas, renderTerrainRegion, destroyCircle, cleanDebris, removeFloaters, reflowSky, isSolid, terrainDims } from '@/lib/terrain.mjs';
import { drawTank, TANK_PALETTES, TANK } from '@/lib/tank.mjs';
import { FX } from '@/lib/fx.mjs';
import { BONUS_DEFS, pickDropType } from '@/lib/bonus.mjs';
import { sfx, setMuted, isMuted } from '@/lib/sfx.mjs';
import { QualityGovernor, TIERS } from '@/lib/quality.mjs';

/**
 * 🛡️ B.O.T - battle of tanks. Worms-style, side-view destructible terrain, zero sprites.
 * mouse aims (free, live), scroll to set power, click to fire.
 *
 * 🔁 TURNS + FUEL - a turn is OPEN (act) → shot → settle → next player.
 * Power carries across the turn (scroll to adjust any time); firing only
 * requires being parked (grounded, near-zero speed) at the moment you click.
 * 💾 Your last missile power is persisted (localStorage) - it carries across
 * turns, rounds, respawns, and every match until you scroll it again.
 * (⚡ chaos: run-and-gun - fire while driving AND mid-jump; spawns/respawns
 * parachute in from the sky, and YOUR tank wears the hero marker: a soft sky beam + ONE ground ring that doubles as the reload meter.)
 * Firing ends the turn; Enter passes. Fuel burns while driving/jumping and
 * regenerates slowly; empty tank = engine dead.
 *
 * 🌬️ WIND (milestone 9) - rolled fresh every turn, shown in the top bar.
 * Pushes shells sideways (guided resists), sways parachuting crates, and
 * drifts smoke. Online the server rolls it; locally it's per-turn random.
 *
 * 🛋️ HOT-SEAT - one screen, 2–4 local players (?solo=1&local=N).
 * 🌐 ONLINE (milestone 9) - real multiplayer rooms: the server is authoritative
 * (turn order + timer, wind, HP/inventory, supply drops, blasts). The active
 * player streams their tank and reports shot impacts; everyone else watches
 * the same sim. Late joiners replay the blast log and spectate until rematch.
 *
 * 🎁 SUPPLY DROPS - crates parachute in every 24–40s (max 3) at the spot most
 * equally distant from every tank, and vanish 60s after landing. ×2/×3 = double
 * damage for the next 2/3 hits; 💥 cluster lands, THEN bursts into 3 bomblets;
 * ❤ repairs; 🎯 guided locks the nearest opponent, hugs the terrain and cannot
 * miss; 🪓 tomahawk = slow heavy shell → MASSIVE blast + mushroom + white flash.
 * Keys 1–4 pick the shell for the next shot (1 = normal).
 *
 * ⚡ CHAOS MODE (online) - real-time free-for-all: no turns, everyone drives
 * and shoots at once. Infinite normal shells behind a 1s reload (specials still
 * come from crates), fuel refills from empty in 3s, wind re-rolls on a
 * wall-clock timer, one 3:00 match clock. Death is a 5s timeout - tanks
 * respawn, and MOST DAMAGE DEALT at 0:00 wins.
 * Shells from every tank fly simultaneously (projsRef array).
 *
 * 🔊 SFX - procedural WebAudio (lib/sfx.mjs), zero assets. 🔊 button mutes.
 */
const GRAV = 850;
const POWER_SCROLL = 0.0009;       // power change per wheel-delta unit
// 💾 last missile power persists per browser - across turns, rounds, and matches
const POWER_KEY = 'bot:last-power';
const loadPower = () => {
  if (typeof window === 'undefined') return 0.5; // SSR - no storage yet
  const raw = window.localStorage.getItem(POWER_KEY);
  if (raw == null) return 0.5;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
};
const savePower = (p) => { try { window.localStorage.setItem(POWER_KEY, String(Math.round(p * 1000) / 1000)); } catch { /* storage blocked - play on */ } };
const SPEED = (p) => 300 + p * 1200; // more push - full power really launches
const BLAST_R = 58;
const FUEL_BURN = (s) => 3.5 + 15 * (Math.abs(s) / 175); // per-second while driving
const FUEL_REGEN = 1.8;  // per-second while not driving
const FUEL_JUMP = 14;    // one-off jump cost (hefty - hopping is expensive)
const TURN_TIME = 20;    // seconds per turn, then it auto-passes
const WIND_MAX = 95;     // px/s² sideways push on shells at full strength
// 🎯 guided missile - a powered cruise missile, not a lobbed shell. It locks the
// nearest opponent, hugs the terrain to clear ridges, then dives straight onto
// them with a proximity fuse and doubled endgame pitch authority: it ALWAYS hits.
const GUIDED_SPEED = 900;  // constant motor speed (px/s) - charge power is irrelevant
const GUIDED_TURN = 10;    // rad/s pitch authority at cruise (×2.2 in the terminal dive)
const GUIDED_CLEAR = 95;   // px it tries to stay above the ridgeline ahead
const GUIDED_LOOK = 420;   // px of terrain look-ahead when picking a cruise altitude
const GUIDED_FUEL = 12;    // s of motor burn - far more than any map crossing needs
const GUIDED_FUSE = 28;    // px proximity fuse - this close already counts as a direct hit
const TOMAHAWK_SLOW = 0.55;// ☢️ heavy shell - flies far slower than a normal shot
const CRATE_TTL = 60;      // s a landed supply crate stays before disappearing
const CHAOS_COOLDOWN = 1;  // ⚡ chaos reload - seconds between shots (server enforces too)
const CHAOS_RESPAWN = 5;   // ⚡ chaos respawn - seconds dead before you're back
const PARA_FALL = 230;     // 🪂 parachute descent speed (px/s) - brisk drop-in
const PARA_DRIFT = 170;    // 🪂 steering speed (px/s) - A/D glides you to a new landing spot
// ⚡ chaos crates are UNCOVERED - badge shows the contents, not a mystery '?'
const CRATE_GLYPHS = { x2: '×2', x3: '×3', cluster: '💥', hp10: '+10', hp15: '+15', guided: '🎯', tomahawk: '🪓', teleport: '🌀', shield: '🛡️' };
const CHAOS_TIME = 180;    // ⚡ chaos match clock (server's gs.dur is the truth)
// ⏳ pre-round countdown - "3", "2", "1" at 1s each, then "FIGHT!" for a short beat
const COUNTDOWN_TOTAL = 3.6;
const NET_HZ = 12;       // own-tank position stream rate (online)

const LOCAL_EMOJI = ['🐯', '🦊', '🐸', '🐵'];
const LOCAL_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];
// ⚖️ fair spawns - N players get N evenly-spaced slots, symmetric about the map
// centre: nobody starts with more map (or fewer neighbours) than anyone else
const spawnSlots = (n) => Array.from({ length: n }, (_, i) =>
  n === 1 ? 0.5 : 0.12 + (i * 0.76) / (n - 1));

/** Find a parking spot near the ideal slot: walk outward BOTH ways for ground
 *  that is reasonably flat, dry, and ≥90px from every already-placed tank.
 *  Moderate slopes are fine (tanks tilt + handbrake); an overlap never is.
 *  Last resort: the ideal slot itself, clamped in-bounds. */
const findSpawn = (surf, terrain, ideal, placed, maxR) => {
  const ok = (x) =>
    x >= 40 && x <= terrain.width - 40 &&
    Math.abs(surf(x + 8) - surf(x - 8)) <= 20 &&   // ~51° max - tanks handle slopes
    surf(x) <= terrain.waterY - 40 &&              // dry
    placed.every((px) => Math.abs(px - x) >= 90);  // never on top of a teammate
  for (let d = 0; d <= maxR; d += 12) {
    if (ok(ideal + d)) return ideal + d;
    if (d && ok(ideal - d)) return ideal - d;
  }
  return Math.max(40, Math.min(terrain.width - 40, ideal));
};
const WEAPON_KEYS = { 1: 'normal', 2: 'cluster', 3: 'guided', 4: 'tomahawk' };
// ⌨️ held keys are tracked by PHYSICAL code (e.code), never e.key - macOS
//    rewrites e.key under ⌥/⇧ (physical D released with ⌥ down reports '∂'),
//    which used to wedge 'd' in the held set forever (B2)
const KEY_CODES = { KeyA: 'a', KeyD: 'd', KeyW: 'w', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', ArrowUp: 'arrowup', Space: ' ' };

/** Worms wind ∈ [-1,1], biased toward useful strengths. */
const rollWind = () => {
  const w = Math.random() * 2 - 1;
  return Math.sign(w) * Math.pow(Math.abs(w), 0.7);
};

/** Small name tag floating above a tank (world-space) - stroked for legibility over any terrain. */
const drawNameTag = (ctx, x, y, t) => {
  const label = `${t.emoji ?? ''} ${t.name ?? ''}`.trim();
  if (!label) return;
  ctx.font = 'bold 13px system-ui';
  ctx.textAlign = 'center';
  const w = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(8,12,8,0.55)'; // glass pill behind the name
  ctx.beginPath(); ctx.roundRect(x - w / 2 - 8, y - 12.5, w + 16, 17.5, 8.5); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.fillStyle = 'rgba(238,242,234,0.95)';
  ctx.fillText(label, x, y + 1);
};

export default function Game({ gs, myId, local = 0 }) {
  const router = useRouter();
  const canvasRef = useRef(null);
  const terrainCanvasRef = useRef(null);
  const terrainRef = useRef(null);
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 });
  // ⏳ pre-round "3, 2, 1, FIGHT!" - remaining seconds; input/turn-timer freeze while > 0
  const countdownRef = useRef(0);
  const cdLabelRef = useRef(null); // last shown label, so the tick/FIGHT sfx fires once per beat
  const tanksRef = useRef([]);
  const aimRef = useRef(-0.6);
  const mouseRef = useRef({ x: 0, y: 0 });
  const chargeRef = useRef({ power: loadPower() }); // 💾 your last missile power rides in with you
  const powerFlashRef = useRef(-9999);   // ⚡ last power-scroll time (rAF clock) - drives the brief turret charge arc
  const teleRef = useRef(null);              // 🌀 null | { targeting: bool } - pending teleport (owner only)
  const [teleUi, setTeleUi] = useState(null); // null | 'pending' | 'targeting' - React mirror for UI chips
  const projsRef = useRef([]);       // shells in flight - classic: at most 1; chaos: everyone's at once
  const subsRef = useRef([]);        // cluster sub-munitions
  const bonusRef = useRef([]);       // supply-drop crates (falling + landed)
  const streaksRef = useRef([]);     // 🌬️ ambient wind streaks in the sky
  const dropTRef = useRef(10);       // countdown to the next supply drop (local modes)
  const crateIdRef = useRef(0);
  const selRef = useRef('normal');   // selected shell for the next shot
  const whiteRef = useRef(0);        // tomahawk white-screen flash (1 → 0)
  const repaintQRef = useRef([]);    // 🧱 chunked terrain-repaint bands (mega-blasts, #14)
  const windRef = useRef(0);         // 🌬️ wind ∈ [-1,1] - server-owned online
  const fxRef = useRef(new FX());
  const shakeRef = useRef(0);
  const keysRef = useRef(new Set());
  const keyStampRef = useRef(new Map()); // 🐕 held key → last keydown stamp (auto-repeat) - the wedged-key watchdog
  const turnRef = useRef({ num: 1, phase: 'open', settle: 0, activeIdx: 0, time: TURN_TIME }); // 'open'|'shot'|'settle'|'over' - mirrored from server online
  const gsRef = useRef(null);        // latest game-state prop (read inside effects)
  const onlineRef = useRef(false);   // online multiplayer mode flag
  const chaosRef = useRef(false);    // ⚡ chaos mode flag (online only)
  const myIdRef = useRef(null);
  const netAccRef = useRef(0);       // own-tank stream accumulator
  const lastShotMineRef = useRef(false); // online: I fired the in-flight shot
  const lastBlastRef = useRef(null);   // 🧪 latest server blast report (?test=1 hook)
  const shotSeqRef = useRef(0);        // 🏷️ per-shot id - lets a server nack find MY shell
  const lastFireRef = useRef(null);    // 🧾 { shot, kind, buff } - what the last optimistic fire consumed
  const numRef = useRef(1);          // last turn number seen (turn-change sfx)
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [colorName, setColorName] = useState(TANK_PALETTES[0].name);
  const [turnInfo, setTurnInfo] = useState({ num: 1, idx: 0, phase: 'open' }); // DOM chips mirror
  const [selUi, setSelUi] = useState('normal'); // weapon slot mirror for the HUD
  const [, setInvUi] = useState(0);  // inventory/buff change → HUD rerender
  const invSigRef = useRef('');      // B9: last rendered HUD signature - gs packets only bump on real change
  const qualityRef = useRef(null);   // 🎚️ QualityGovernor - auto/high/low render tiers (lazy, browser-only)
  const [qualityUi, setQualityUi] = useState('auto'); // graphics chip mirror (mode)
  const [lowUi, setLowUi] = useState(false);          // live tier mirror for DOM knobs (backdrop off in Low)
  const lowUiRef = useRef(false);
  const terrainViewRef = useRef(null); // 🖼️ pre-scaled terrain cache: downscale once per blast, not per frame (5b)
  const ctx2dRef = useRef(null);       // cached 2D context (getContext every frame is needless)
  const [windUi, setWindUi] = useState(0); // 🌬️ wind chip mirror
  const [mutedUi, setMutedUi] = useState(false);
  const [fsUi, setFsUi] = useState(false); // ⛶ fullscreen chip mirror

  const seed = gs?.terrain?.seed;
  // ⚖️ terrain grows with player count; online the server's dims are law,
  // hot-seat sizes itself locally (its dev game only has 1 server tank)
  const tw = local > 0 ? terrainDims(local).width : (gs?.terrain?.width ?? 1920);
  const th = local > 0 ? terrainDims(local).height : (gs?.terrain?.height ?? 1080);
  const ready = progress === 1;

  // hot-seat roster (synthetic local players); online roster = server tanks
  // (they carry id/name/emoji); lobby roster as fallback
  const roster = local > 0
    ? Array.from({ length: Math.min(4, Math.max(2, local)) }, (_, i) => ({
        id: `local-${i}`, name: LOCAL_NAMES[i], emoji: LOCAL_EMOJI[i],
      }))
    : (gs?.tanks?.length ? gs.tanks : (gs?.players ?? []));

  // 🌀 online = server-driven game. A 1-player CHAOS dev room is still online
  // (the server owns the match clock, damage and scoreboard); solo classic
  // stays a fully client-side sandbox.
  const online = local === 0 && ((gs?.tanks?.length ?? 0) > 1 || gs?.mode === 'chaos');
  // ⚡ chaos is server-defined, not player-count-defined: even a 1-player dev
  // chaos room must render chaos UI (the server runs chaos rules regardless)
  const chaos = local === 0 && gs?.mode === 'chaos';
  gsRef.current = gs;
  onlineRef.current = online;
  chaosRef.current = chaos;
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
    projsRef.current = [];
    subsRef.current = [];
    bonusRef.current = [];
    dropTRef.current = 10;
    streaksRef.current = []; // 🌬️ fresh sky for a fresh battle
    // 💾 power is NOT reset - your last missile power carries into the new battle
    selRef.current = 'normal';
    teleRef.current = null; setTeleUi(null); // 🌀 fresh game, no pending teleports
    whiteRef.current = 0;
    repaintQRef.current = [];        // 🧱 no stale bands onto fresh terrain
    lastShotMineRef.current = false;
    lastFireRef.current = null;
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
            const cut = []; // 🌱 rim seeds for the floater scan (#14)
            destroyCircle(terrain, b.x, b.y, b.r, cut);
            cleanDebris(terrain, b.x, b.y, b.r + 16, cut);
            removeFloaters(terrain, b.x, b.y, b.r + 190, cut);
            reflowSky(terrain, b.x, b.y, b.r + 16);
          }
          renderTerrainToCanvas(off, terrain); // one full repaint after replay
        }
        terrainCanvasRef.current = off;
        if (terrainViewRef.current) terrainViewRef.current.dirty = true; // 🖼️ fresh terrain → re-scale the blit cache
        const surf = (x) => terrain.surface[Math.max(0, Math.min(terrain.width - 1, Math.round(x)))];
        const srvTanks = local > 0 ? null : (gsRef.current?.tanks ?? null);
        const placed = []; // ⚖️ fairness: each new spawn keeps its distance from these
        const slotGap = roster.length > 1 ? terrain.width * 0.76 / (roster.length - 1) : terrain.width;
        // 🎲 shuffled assignment - spawn slot per player is re-rolled every
        //    game, so position never follows the join/roster order
        const slotList = spawnSlots(roster.length);
        for (let i = slotList.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [slotList[i], slotList[j]] = [slotList[j], slotList[i]];
        }
        tanksRef.current = roster.map((p, i) => {
          const st = srvTanks ? (srvTanks.find((s) => s.id === p.id) ?? srvTanks[i]) : null;
          let x, y;
          if (st) { // server-assigned spawn (everyone agrees)
            x = st.x;
            y = st.y ?? surf(st.x);
          } else {
            const ideal = Math.round(terrain.width * slotList[i]);
            x = findSpawn(surf, terrain, ideal, placed, Math.max(0, slotGap / 2 - 100));
            y = surf(x);
          }
          placed.push(x);
          return {
            ...p, x, y, s: 0, rot: 0, susOff: 0, susVel: 0,
            wheelRot: 0, grounded: !st?.para, airVy: 0, dustT: 0, // 🪂 chute drops start airborne
            para: !!st?.para,
            hp: st?.hp ?? 100, fuel: st?.fuel ?? 100, // ⛽ server-owned online - a reload no longer refills the tank
            driving: false, dead: !!st?.dead,
            inv: st?.inv ? { ...st.inv } : { cluster: 0, guided: 0, tomahawk: 0 }, // special shells in stock
            tele: !!st?.tele,                                       // 🌀 pending teleport (visible to all)
            buff: st?.buff ?? 0,                                     // ×2-damage hits remaining
            palette: st?.palette ?? (i % TANK_PALETTES.length),
            aim: st?.aim ?? (x < terrain.width / 2 ? -0.6 : -2.54), // face the enemy side
            netX: null, netY: null, netAim: null, netS: 0, // online: streamed targets (🕵️ power is never shared)
            netVx: 0, netVy: 0, netAt: 0,                  // 🛰️ stream velocity + last-packet time (para dead reckoning)
          };
        });
        // ⚡ chaos: start looking down MY barrel, not tank #0's
        const firstTank = (gsRef.current?.mode === 'chaos'
          ? tanksRef.current.find((t) => t.id === myIdRef.current)
          : null) ?? tanksRef.current[0];
        aimRef.current = firstTank?.aim ?? -0.6;
        // online: mirror crates + wind from the very first game-state
        const gsNow = gsRef.current;
        if (local === 0 && ((gsNow?.tanks?.length ?? 0) > 1 || gsNow?.mode === 'chaos')) {
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
      tn.fireAt = gs.turn.fireAt ?? 0; // 🚀 when the in-flight shot left (B5 stall detector)
      if (gs.turn.endsAt) tn.time = Math.max(0, (gs.turn.endsAt - Date.now()) / 1000);
      setTurnInfo({ num: tn.num, idx: tn.activeIdx, phase: tn.phase });
      if (gs.turn.num !== numRef.current) {
        numRef.current = gs.turn.num;
        sfx('turn');
        // 🔄 same rule as local advanceTurn: weapon back to normal (power persists - 💾 your last charge is remembered)
        selRef.current = 'normal'; setSelUi('normal');
        // ⛽ fresh turn, fresh tank of fuel in classic (B4) - the owner streams
        //    the refilled gauge to everyone on the next tank-move tick
        if (!chaosRef.current) tanksRef.current.forEach((t) => { t.fuel = 100; t.fuelCut = false; });
        const nt = tanksRef.current[gs.turn.activeIdx];
        if (nt) setColorName(TANK_PALETTES[(nt.palette ?? 0) % TANK_PALETTES.length].name);
      }
      if (wasPhase !== 'over' && tn.phase === 'over') sfx('win');
      const at = tanksRef.current[tn.activeIdx];
      if (at && !chaosRef.current) aimRef.current = at.aim ?? aimRef.current; // ⚡ chaos: my aim is my own
    }
    if (typeof gs.wind === 'number') { windRef.current = gs.wind; setWindUi(gs.wind); }
    // authoritative tank fields (positions are owner-streamed, not mirrored)
    for (const st of gs.tanks ?? []) {
      const t = tanksRef.current.find((k) => k.id === st.id);
      if (!t) continue;
      t.hp = st.hp;
      t.inv = { ...st.inv };
      t.buff = st.buff;
      t.dmg = st.dmg | 0; // 💥 damage dealt (tie-breaker)
      t.kills = st.kills | 0; t.deaths = st.deaths | 0; // 💀 the headline stat
      t.gone = !!st.gone; // 🔌 owner dropped - reclaim grace window is running
      t.shieldUntil = st.shieldUntil ?? 0; // 🛡️ chaos shield bubble
      // 🪂 one-way: touchdown clears it locally - and B6: only re-arm a chute
      //    whose generation hasn't landed yet, or a stale game-state landing in
      //    the ≤12Hz gap before the server learns of touchdown re-opens a stowed
      //    chute (input hiccup + a flicker of immunity)
      if (st.para && !t.paraDone) t.para = true;
      t.tele = !!st.tele; // 🌀 pending teleport is public knowledge
      if (typeof st.palette === 'number' && st.palette !== t.palette) { // 🎨 recolors are public
        t.palette = st.palette;
        if (st.id === myIdRef.current) setColorName(TANK_PALETTES[st.palette % TANK_PALETTES.length].name);
      }
      // 🤖 off-turn bots don't stream footing - adopt the server's re-grounded y
      if (st.ai && !st.dead && typeof st.y === 'number' && Math.abs((t.y ?? st.y) - st.y) > 2) t.y = st.y;
      if (st.id === myIdRef.current && !st.tele && teleRef.current) { // server ate it (fizzle/used)
        teleRef.current = null; setTeleUi(null);
      }
      if (st.dead && !t.dead) { t.dead = true; t.driving = false; t.deadAtMs = performance.now(); } // 💀 chaos: respawn countdown starts
      else if (!st.dead && t.dead) { // ⚡ chaos respawn - server revived this tank at a fresh spot
        t.dead = false; t.hp = st.hp; t.x = st.x; t.y = st.y; // snap to the server-picked spot
        t.netX = null; t.netY = null; t.netVx = 0; t.netVy = 0; t.netAt = 0; // 🪂 drop the DEATH-SPOT stream anchors - the fresh descent re-anchors from the owner's new stream (else we'd ease back toward the corpse!)
        t.s = 0; t.airVy = 0; t.grounded = false; t.fuel = 100; t.aim = st.aim ?? t.aim;
        t.para = !!st.para; t.paraDone = false; // 🪂 ride the chute down again - new generation, may be re-armed until it lands
        fxRef.current.text(st.x, st.y - 56, 'RESPAWN', '#8fd0ff');
        fxRef.current.add({ t: 'ring', x: st.x, y: st.y - 18, size: 8, grow: 320, life: 0.5, color: 'rgba(143,208,255,0.9)' });
        if (st.id === myIdRef.current) { aimRef.current = t.aim; sfx('turn'); } // 💾 power survives respawn too
      }
    }
    // crates mirror - positions eased toward server targets in update()
    const prev = bonusRef.current;
    bonusRef.current = (gs.crates ?? []).map((c) => {
      const ex = prev.find((b) => b.id === c.id);
      if (ex) { ex.tx = c.x; ex.ty = c.y; ex.tlanded = c.landed; ex.taken = c.taken; return ex; }
      return { ...c, tx: c.x, ty: c.y, tlanded: c.landed };
    });
    // B9: re-render the DOM HUD only when something it SHOWS actually changed -
    //    a gs packet arrives ~10Hz whenever a crate is airborne; an unconditional
    //    bump cost two full renders of the top bar, pills and dock per packet
    const sig = tanksRef.current.map((t) =>
      `${t.dead ? 1 : 0}${t.gone ? 1 : 0}:${t.kills | 0}:${t.deaths | 0}:${t.dmg | 0}:${t.inv?.cluster | 0},${t.inv?.guided | 0},${t.inv?.tomahawk | 0}:${t.buff | 0}:${t.tele ? 1 : 0}:${t.hp | 0}`
    ).join('|');
    if (sig !== invSigRef.current) { invSigRef.current = sig; setInvUi((n) => n + 1); }
  }, [gs, online]);

  const activeTank = () => tanksRef.current[turnRef.current.activeIdx] ?? null;
  // the tank THIS screen steers - ⚡ chaos: always mine; classic: whose turn it is
  const controlTank = () => chaosRef.current
    ? (tanksRef.current.find((t) => t.id === myIdRef.current) ?? null)
    : activeTank();
  const groundY = (x) => {
    const t = terrainRef.current;
    return t.surface[Math.max(0, Math.min(t.width - 1, Math.round(x)))];
  };
  const pivotOf = (t) => ({ x: t.x + TANK.pivotX, y: (t.y ?? groundY(t.x)) + TANK.pivotY });
  const muzzleOf = (t, a) => {
    const p = pivotOf(t);
    return { x: p.x + Math.cos(a) * (TANK.barrelLen + 7), y: p.y + Math.sin(a) * (TANK.barrelLen + 7) };
  };

  // ── turn rotation (local modes only - server advances online) ──
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
    // 💾 power carries across turns - your last missile power is remembered
    selRef.current = 'normal'; // weapon pick doesn't carry across turns
    setSelUi('normal');
    if (checkGameOver()) return;
    if (teleRef.current) { // 🌀 teleport not used in time - the turn eats it
      const prev = ts[tn.activeIdx];
      if (prev) { prev.tele = false; fxRef.current.text(prev.x, (prev.y ?? 0) - 56, '🌀 fizzled…', '#b48cff'); }
      teleRef.current = null; setTeleUi(null);
    }
    let i = tn.activeIdx;
    for (let k = 0; k < ts.length; k++) { i = (i + 1) % ts.length; if (!ts[i].dead) break; }
    // ⛽ fresh turn, fresh tank of fuel (B4) - fuel is a per-turn movement
    //    budget, never a match-long death spiral toward 0
    ts.forEach((t) => { t.driving = false; t.fuel = 100; t.fuelCut = false; });
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
    const cut = []; // 🌱 cleared cells → rim seeds for the floater scan (#14)
    destroyCircle(terrain, x, y, r, cut);
    cleanDebris(terrain, x, y, r + 16, cut); // no invisible slivers to stand on
    const floaters = removeFloaters(terrain, x, y, r + 190, cut); // NOTHING floats - any size island goes
    reflowSky(terrain, x, y, r + 16); // craters are open to the sky - no black
    // 🧱 fbm-heavy region repaints hitch the frame on big blasts: anything past
    //    ~60k px (☢️ tomahawk ≈ 190k) is sliced into ≤48px bands - crater-centre
    //    first - and paid down over the next frames from the main loop (#14)
    const regions = floaters.map((fl) => ({ x: fl.x, y: fl.y, w: fl.w, h: fl.h }));
    regions.push({ x: x - r - 16, y: y - r - 16, w: (r + 16) * 2, h: (r + 16) * 2 });
    let px = 0;
    for (const rg of regions) px += rg.w * rg.h;
    if (px <= 60000) { // small blast - repaint instantly, as always
      const c2d = off.getContext('2d');
      for (const rg of regions) {
        const reg = renderTerrainRegion(terrain, rg.x, rg.y, rg.w, rg.h);
        c2d.putImageData(new ImageData(reg.data, reg.w, reg.h), reg.x, reg.y);
      }
      if (terrainViewRef.current) terrainViewRef.current.dirty = true; // 🖼️ re-scale the blit cache
    } else {
      const bands = [];
      for (const rg of regions) {
        const bx0 = Math.max(0, Math.floor(rg.x)), by0 = Math.max(0, Math.floor(rg.y));
        const bx1 = Math.min(terrain.width, Math.ceil(rg.x + rg.w)), by1 = Math.min(terrain.height, Math.ceil(rg.y + rg.h));
        for (let by = by0; by < by1; by += 48) {
          bands.push({ x: bx0, y: by, w: bx1 - bx0, h: Math.min(48, by1 - by), d: Math.abs(by + 24 - y) });
        }
      }
      bands.sort((a2, b2) => a2.d - b2.d); // the crater bowl appears first
      repaintQRef.current.push(...bands);
    }
    if (opts.big) { // ☢️ tomahawk: SLOW mega-blast - huge mushroom, rolling shock rings, long white flash, lingering ground fire, mega shake
      fxRef.current.mushroom(x, y);
      fxRef.current.add({ t: 'ring', x, y, size: 26, grow: 1400, life: 0.8, color: 'rgba(255,255,255,0.95)' });
      fxRef.current.add({ t: 'ring', x, y, size: 14, grow: 900, life: 1.4, color: 'rgba(255,250,235,0.9)' });
      fxRef.current.add({ t: 'ring', x, y, size: 8, grow: 520, life: 1.9, color: 'rgba(255,190,120,0.8)' });
      // lingering ground fire - the crater keeps burning long after the hit
      for (let i = 0; i < 10; i++) {
        fxRef.current.add({ t: 'fire', x: x + (Math.random() - 0.5) * 260, y: y - Math.random() * 10,
          vx: (Math.random() - 0.5) * 20, vy: -30 - Math.random() * 50,
          size: 7 + Math.random() * 9, life: 2.2 + Math.random() * 1.6 });
      }
      whiteRef.current = 1.35; // >1 = a beat of full-white hold before the fade even starts
      shakeRef.current = Math.max(shakeRef.current, 3.4);
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
      // 🪂/🛡️ offline mirrors the server: under canopy or shield = untouchable
      if (t.para || (t.shieldUntil && Date.now() < t.shieldUntil)) {
        const tx0 = t.x, ty0 = (t.y ?? srf(t.x)) - 18;
        if (Math.hypot(tx0 - x, ty0 - y) < r + 34) fxRef.current.text(tx0, ty0 - 42, t.para ? '🪂 SAFE' : '🛡️ BLOCKED', '#8fd0ff');
        continue;
      }
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
          t.dead = true; t.hp = 0; t.driving = false; // eliminated - out of the rotation
          t.deaths = (t.deaths | 0) + 1;
          // 💀 offline/hot-seat attribution - the shell's owner scores (never a self-kill)
          const by = opts.by;
          if (by && by !== t) {
            by.kills = (by.kills | 0) + 1;
            fxRef.current.text(by.x, (by.y ?? srf(by.x)) - 66, 'KILL +1', '#ffd75e');
          }
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
    lastBlastRef.current = { ...m, at: Date.now() }; // 🧪 test hook visibility
    // clear the visual shell(s) this boom belongs to - the server is the truth.
    // 🏷️ only the SHOOTER'S shells are candidates: a nearby shell of someone
    //    else's must survive this impact (was: nearest-remote-within-120px)
    const owns = (p) => !m.src || p.src?.id === m.src;
    if (chaosRef.current) { // ⚡ many shells in flight: kill the nearest matching one
      const ps = projsRef.current;
      let best = -1, bd = 120;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].mine || !owns(ps[i])) continue;
        const d = Math.hypot(ps[i].x - m.x, ps[i].y - m.y);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) ps.splice(best, 1);
      subsRef.current = subsRef.current.filter((p) => p.mine || !owns(p));
    } else {
      projsRef.current = projsRef.current.filter((p) => p.mine || !owns(p));
      subsRef.current = subsRef.current.filter((p) => p.mine || !owns(p));
    }
    // my own echo: I already carved the terrain locally at impact - skip the
    // re-carve but DO take the server's authoritative damage below. Matched by
    // shooter id, so a real blast from anyone else (e.g. cluster bomblets
    // landing close together, or a ⚡ chaos neighbour) is never swallowed.
    const dup = !!m.src && m.src === myIdRef.current;
    if (!dup) explodeTerrain(m.x, m.y, m.r, { scale: m.scale, big: m.big });
    const knock = Math.min(m.scale || 1, 2);
    const range = (m.r || BLAST_R) + 34;
    let died = false;
    for (const d of m.dmg ?? []) {
      const t = tanksRef.current.find((k) => k.id === d.id);
      if (!t) continue;
      if (d.d === 0) { // 🛡️ shield ate the blast - no damage, no knockback
        fxRef.current.text(t.x, (t.y ?? groundY(t.x)) - 60, '🛡️ BLOCKED', '#8fd0ff');
        continue;
      }
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
        // 💀 my kill - claim it on the spot (a self-kill earns nothing but the crater)
        if (m.src === myIdRef.current && d.id !== myIdRef.current) {
          const me2 = tanksRef.current.find((k) => k.id === myIdRef.current);
          if (me2) { fxRef.current.text(me2.x, (me2.y ?? groundY(me2.x)) - 66, 'KILL +1', '#ffd75e'); sfx('pickup'); }
        }
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
    const me = controlTank();
    if (!me || me.dead || me.para) return; // 🪂 guns stay packed until touchdown
    const chaosNow = chaosRef.current;
    if (chaosNow) { // ⚡ real-time: reload gate, no turns, shells keep flying
      if (turnRef.current.phase === 'over' || countdownRef.current > 0) return;
      if ((me.cd || 0) > 0) return;
    } else {
      if (projsRef.current.length || turnRef.current.phase !== 'open') return; // your turn only
    }
    if (onlineRef.current && me.id !== myIdRef.current) return; // online: your tank only
    const a = chaosNow ? (me.aim ?? aimRef.current) : aimRef.current;
    const p = Math.max(0.06, chargeRef.current.power);
    const tip = muzzleOf(me, a);
    // consume the selected special shell (keys 1–4), fall back to normal if empty
    let kind = 'normal';
    const sel = selRef.current;
    if (sel !== 'normal' && (me.inv?.[sel] | 0) > 0) {
      me.inv[sel]--;
      kind = sel;
      selRef.current = 'normal';
      setSelUi('normal');
    }
    const v = SPEED(p) * (kind === 'tomahawk' ? TOMAHAWK_SLOW : 1); // ☢️ heavy shell - slow, hangs in the air
    // ×2 / ×3 pickup: double damage for the next N hits
    let dmgScale = 1;
    if ((me.buff | 0) > 0) { me.buff--; dmgScale = 2; }
    if (kind !== 'normal' || dmgScale > 1) setInvUi((n) => n + 1);
    // 🏷️ online shots carry an id - a server nack can then find THIS shell
    //    (⚡ chaos can have several of my shells in flight at once)
    const shot = onlineRef.current ? ++shotSeqRef.current : 0;
    lastFireRef.current = { shot, kind, buff: dmgScale > 1 }; // 🧾 in case of a refund
    projsRef.current.push({
      x: tip.x, y: tip.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      src: me, armed: 0, kind, dmgScale, mine: true, shot,
    });
    if (kind === 'tomahawk') fxRef.current.text(tip.x, tip.y - 22, '☢ TOMAHAWK AWAY', '#ff5a4e');
    fxRef.current.muzzle(tip.x, tip.y, a);
    sfx('shoot');
    shakeRef.current = Math.max(shakeRef.current, 0.45);
    if (chaosNow) {
      me.cd = CHAOS_COOLDOWN; // ⏳ reload begins - movement/fuel unaffected
    } else {
      turnRef.current.phase = 'shot'; // firing ends your action
      setTurnInfo((ti) => ({ ...ti, phase: 'shot' }));
    }
    if (onlineRef.current) { // server validates/consumes authoritatively + relays
      if (!chaosNow) lastShotMineRef.current = true;
      getSocket()?.emit('fire', { a, p, kind });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 🌀 teleport: violet swirl poofs at both ends of the jump ──
  const teleFX = (x, y) => {
    fxRef.current.add({ t: 'ring', x, y: y - 18, size: 6, grow: 420, life: 0.5, color: 'rgba(180,140,255,0.9)' });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      fxRef.current.add({
        t: 'spark', x: x + Math.cos(a) * 15, y: y - 18 + Math.sin(a) * 21,
        vx: Math.cos(a) * 70, vy: Math.sin(a) * 70 - 40, size: 1.8, life: 0.5 + Math.random() * 0.25,
        color: 'rgb(200,168,255)',
      });
    }
    for (let i = 0; i < 6; i++) {
      fxRef.current.smoke(x + (Math.random() - 0.5) * 22, y - 10 - Math.random() * 22,
        (Math.random() - 0.5) * 26, -30 - Math.random() * 30, 5 + Math.random() * 5, 0.8, 'rgb(180,140,255)', 0.5);
    }
  };

  // 🌀 spend the pending teleport: click → land there (classic: this turn only!)
  const doTeleport = (wx) => {
    const t = terrainRef.current;
    const me = controlTank();
    if (!t || !me || me.dead || turnRef.current.phase !== 'open' || countdownRef.current > 0) return;
    if (onlineRef.current && me.id !== myIdRef.current) return;
    const surfAt = (x) => t.surface[Math.max(0, Math.min(t.width - 1, Math.round(x)))];
    const x = Math.max(30, Math.min(t.width - 30, Math.round(wx)));
    const gy = surfAt(x);
    if (gy > t.waterY - 6) { // no watery graves - stay in targeting mode
      fxRef.current.text(x, gy - 46, 'TOO DEEP - pick dry land', '#ff9b5e');
      sfx('deny');
      return;
    }
    if (onlineRef.current) { // 🌐 server-confirmed (#16): never move ahead of the
      //    referee - the relayed event poofs + moves EVERYONE (us included), and
      //      a 'teleport-denied' nack re-arms targeting instead of a free jump
      teleRef.current = { awaiting: true };
      setTeleUi(null);
      getSocket()?.emit('teleport', { x }); // server validates + relays
      return;
    }
    teleFX(me.x, me.y ?? surfAt(me.x));            // poof out
    me.x = x; me.y = gy; me.s = 0; me.airVy = 0; me.grounded = true; me.driving = false; me.rot = 0;
    me.netX = x; me.netY = gy;
    me.tele = false;
    teleFX(x, gy);                                  // poof in
    teleRef.current = null; setTeleUi(null);
    sfx('teleport');
  };

  // ── 🌐 online socket listeners (remote tanks, shots, blasts, crate events) ──
  useEffect(() => {
    if (!ready) return;
    const socket = getSocket();
    if (!socket) return;
    const onTankMove = (m) => {
      const t = tanksRef.current.find((k) => k.id === m?.id);
      if (!t) return;
      // 🛰️ track stream velocity (smoothed) so remote chutes can dead-reckon
      //    between the 12Hz snapshots instead of staircase-chasing them
      const nowMs = performance.now();
      const dtm = t.netAt ? (nowMs - t.netAt) / 1000 : 0;
      const fresh = dtm > 0.02 && dtm < 0.4; // ignore bursts + long gaps (respawns)
      if (typeof m.x === 'number') {
        if (t.netX != null && fresh) t.netVx = (t.netVx || 0) * 0.5 + ((m.x - t.netX) / dtm) * 0.5;
        t.netX = m.x;
      }
      if (typeof m.y === 'number') {
        if (t.netY != null && fresh) t.netVy = (t.netVy || 0) * 0.5 + ((m.y - t.netY) / dtm) * 0.5;
        else t.netVy = (m.para ?? t.para) ? PARA_FALL : 0; // 🛰️ no measurement yet (first packet after (re)spawn/stall): a chute falls at PARA_FALL - assume it until the stream proves otherwise
        t.netY = m.y;
      }
      t.netAt = nowMs;
      if (typeof m.aim === 'number') t.netAim = m.aim;
      if (typeof m.s === 'number') t.netS = m.s;
      if (typeof m.fuel === 'number') t.fuel = m.fuel;      // 👀 rival fuel gauges are public
      // 🕵️ no m.p handling - rival aim power is secret and never rides the stream
      // 🪂 touchdown signal from the owner - a stale in-flight para:true relay
      //    must not re-open a chute this client already stowed (B6)
      if (typeof m.para === 'boolean' && !(m.para && t.paraDone)) t.para = m.para;
      if (typeof m.palette === 'number') t.palette = m.palette; // 🎨 live recolor
    };
    const onFire = (m) => { // another player fired - spawn the same shell visually
      if (!m || m.id === myIdRef.current) return;
      const t = tanksRef.current.find((k) => k.id === m.id);
      if (!t || t.dead) return;
      lastShotMineRef.current = false;
      t.aim = m.a;
      const tip = muzzleOf(t, m.a);
      const v = SPEED(m.p) * (m.kind === 'tomahawk' ? TOMAHAWK_SLOW : 1); // ☢️ heavy shell - slow
      // 🎯 remote guided shells re-steer against OUR local tank positions every
      //    frame, so their flight path is only an approximation of the shooter's
      //    (#23) - harmless: the server's 'blast' event is the truth for terrain + damage
      projsRef.current.push({
        x: tip.x, y: tip.y, vx: Math.cos(m.a) * v, vy: Math.sin(m.a) * v,
        src: t, armed: 0, kind: m.kind, dmgScale: m.dmgScale || 1, mine: false,
      });
      fxRef.current.muzzle(tip.x, tip.y, m.a);
      if (m.kind === 'tomahawk') fxRef.current.text(tip.x, tip.y - 22, '☢ TOMAHAWK AWAY', '#ff5a4e');
      sfx('shoot');
      if (!chaosRef.current) { // ⚡ chaos: no turn phase to move
        turnRef.current.phase = 'shot';
        setTurnInfo((ti) => ({ ...ti, phase: 'shot' }));
      }
    };
    // 🖥️ solo/hot-seat: not online - server 'blast'/'game-event' traffic belongs
    // to a room we're not really playing in; never let it touch the canvas
    const onBlast = (m) => { if (m && onlineRef.current) applyServerBlast(m); };
    const onEvent = (e) => {
      if (!e || !onlineRef.current) return;
      const def = e.type ? BONUS_DEFS[e.type] : null;
      if (e.kind === 'crate-taken') {
        fxRef.current.text(e.x, e.y - 18, def ? (def.label.startsWith('+') ? `${def.label} ❤` : def.name) : '', def?.color ?? '#fff');
        sfx(e.type === 'hp10' || e.type === 'hp15' ? 'heal' : 'pickup');
        if (e.type === 'teleport') { // 🌀 arm targeting for the owner (this turn only!)
          const t = tanksRef.current.find((k) => k.id === e.by);
          if (t) t.tele = true;
          if (e.by === myIdRef.current) {
            teleRef.current = { targeting: true }; setTeleUi('targeting');
            fxRef.current.text(e.x, e.y - 46, 'click where to land!', '#b48cff');
          }
        }
      } else if (e.kind === 'teleport') { // 🌀 a tank jumped - poof at both ends
        const t = tanksRef.current.find((k) => k.id === e.id);
        if (t) {
          // server-confirmed jump - the owner's client waits for this echo too
          // (#16: no optimistic move, so a rejected teleport never happened here)
          teleFX(t.x, t.y ?? 0);
          t.x = e.x; t.y = e.y; t.netX = e.x; t.netY = e.y; t.s = 0; t.grounded = true;
          teleFX(e.x, e.y);
          t.tele = false;
          if (e.id === myIdRef.current) { teleRef.current = null; setTeleUi(null); }
          sfx('teleport');
        }
      } else if (e.kind === 'tele-fizzle') { // 🌀 turn ended before they clicked - wasted
        const t = tanksRef.current.find((k) => k.id === e.id);
        if (t) { t.tele = false; fxRef.current.text(t.x, (t.y ?? 0) - 56, '🌀 fizzled…', '#b48cff'); }
        if (e.id === myIdRef.current) { teleRef.current = null; setTeleUi(null); }
      } else if (e.kind === 'crate-boom') {
        fxRef.current.text(e.x, e.y - 16, '📦 destroyed', '#ffb45e');
        sfx('crunch');
      } else if (e.kind === 'crate-expire') { // ⏳ sat on the ground for 60s - reveal what was inside
        fxRef.current.text(e.x, e.y - 16, def ? `📦 was ${def.label} ${def.name}!` : '📦 expired', def?.color ?? '#9fb08f');
        for (let i = 0; i < 7; i++) {
          fxRef.current.smoke(e.x + (Math.random() - 0.5) * 18, e.y - 12,
            (Math.random() - 0.5) * 30, -25 - Math.random() * 30, 4 + Math.random() * 4, 0.7 + Math.random() * 0.4);
        }
        sfx('thud');
      } else if (e.kind === 'crate-land') {
        sfx('thud');
      } else if (e.kind === 'drop') {
        fxRef.current.text(e.x, 26, '📦 supply drop inbound', '#cfd8c3');
        sfx('drop');
      } else if (e.kind === 'respawn') { // ⚡ immediate, unambiguous revive (B11) -
        // no waiting on the next game-state diff to race a stale para flag (B6)
        const t = tanksRef.current.find((k) => k.id === e.id);
        if (t && t.dead) {
          t.dead = false; t.hp = 100; t.x = e.x; t.y = e.y;
          t.netX = null; t.netY = null; t.netVx = 0; t.netVy = 0; t.netAt = 0; // drop the death-spot anchors
          t.s = 0; t.airVy = 0; t.grounded = false; t.fuel = 100;
          t.aim = e.x < (terrainRef.current?.width ?? 1920) / 2 ? -0.6 : -2.54; // mirrors the server's respawn aim
          t.para = true; t.paraDone = false; // 🪂 new chute generation
          fxRef.current.text(e.x, e.y - 56, 'RESPAWN', '#8fd0ff');
          fxRef.current.add({ t: 'ring', x: e.x, y: e.y - 18, size: 8, grow: 320, life: 0.5, color: 'rgba(143,208,255,0.9)' });
          if (e.id === myIdRef.current) { aimRef.current = t.aim; sfx('turn'); } // 💾 power survives respawn
        }
      }
    };
    // 🙅 the server refused our optimistic shot - roll it back: the in-flight
    //    shell becomes a dud (no crater, no blast report), the consumed ammo
    //    and buff are refunded, and ⚡ chaos adopts the server's reload clock
    const onFireDenied = (m) => {
      if (!onlineRef.current) return;
      const lf = lastFireRef.current;
      lastFireRef.current = null;
      lastShotMineRef.current = false;
      if (lf) {
        for (const p of projsRef.current) if (p.mine && p.shot === lf.shot) p.dud = true;
        for (const p of subsRef.current) if (p.mine && p.shot === lf.shot) p.dud = true;
        const me = controlTank();
        if (me) {
          if (lf.kind !== 'normal') me.inv[lf.kind] = (me.inv[lf.kind] | 0) + 1;
          if (lf.buff) me.buff = (me.buff | 0) + 1;
          if (m?.reason === 'reload' && typeof m?.retryIn === 'number') me.cd = Math.max(me.cd || 0, m.retryIn / 1000); // ⏳ server clock wins
          setInvUi((n) => n + 1);
        }
      }
      if (m?.reason === 'not-your-turn') sfx('deny');
    };
    // 🌀 the server refused our teleport (#16) - the turn raced past, the charge
    //    was already eaten, or ITS bitmap says the spot is wet. We never moved
    //    (no optimistic jump) - just re-arm targeting or let it go.
    const onTeleDenied = (m) => {
      if (!onlineRef.current) return;
      const me = controlTank();
      const rearm = m?.reason === 'wet' && !!me && !me.dead && turnRef.current.phase === 'open' && countdownRef.current <= 0;
      teleRef.current = rearm ? { targeting: true } : null;
      setTeleUi(rearm ? 'targeting' : null);
      if (me) {
        fxRef.current.text(me.x, (me.y ?? 0) - 56,
          m?.reason === 'wet' ? 'TOO DEEP - pick dry land'
            : m?.reason === 'not-your-turn' ? 'too late - the turn moved on'
            : '🌀 fizzled…', '#ff9b5e');
      }
      if (m?.reason !== 'wet') sfx('deny');
    };
    socket.on('tank-move', onTankMove);
    socket.on('fire', onFire);
    socket.on('blast', onBlast);
    socket.on('game-event', onEvent);
    socket.on('fire-denied', onFireDenied);
    socket.on('teleport-denied', onTeleDenied);
    return () => {
      socket.off('tank-move', onTankMove);
      socket.off('fire', onFire);
      socket.off('blast', onBlast);
      socket.off('game-event', onEvent);
      socket.off('fire-denied', onFireDenied);
      socket.off('teleport-denied', onTeleDenied);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, myId, applyServerBlast]);

  // ── 🧪 dev test hook (?test=1) - exposes the live sim on window.__bot so
  //    browser/CDP tests can read tank state and fire a SOLVED shot at a point
  //    target (leading a parachuting target by its fall rate). Never active in
  //    normal play. (refs only - safe with stale closures)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!new URLSearchParams(window.location.search).has('test')) return;
    window.__bot = {
      PARA_FALL,
      lastBlast: () => lastBlastRef.current, // 🧪 latest authoritative blast report (dmg array incl. d:0 blocks)
      tanks: () => tanksRef.current.map((t) => ({
        id: t.id, name: t.name, x: Math.round(t.x * 10) / 10, y: Math.round((t.y ?? -999) * 10) / 10,
        sway: +(t.renderSwayX || 0).toFixed(2), s: +(t.s || 0).toFixed(1),
        hp: t.hp, dead: !!t.dead, para: !!t.para, dmg: t.dmg | 0, cd: +(t.cd || 0).toFixed(2),
      })),
      myId: () => myIdRef.current,
      turn: () => ({ phase: turnRef.current.phase, countdown: countdownRef.current, wind: windRef.current }),
      // 🎯 grid-search (angle × power) with the sim's exact ballistics (gravity,
      // wind, 58×46 hitbox) so the shell INTERCEPTS (tx, ty) - ty may be a
      // falling parachute target, so lead it by fall × flight-time. Then fires
      // for real. Returns the solution or why it refused.
      fireAt: (tx, ty, fall = 0, directOnly = false) => {
        const me = controlTank();
        const T = terrainRef.current;
        if (!me || me.dead || !T) return { ok: false, why: 'no-tank' };
        if (turnRef.current.phase === 'over' || countdownRef.current > 0) return { ok: false, why: 'not-live' };
        if ((me.cd || 0) > 0) return { ok: false, why: 'reload' };
        // one shell sim with the game's exact ballistics; reports a direct box
        // hit, the dirt impact (splash candidate), and the closest approach
        const sim = (a, p) => {
          const tip = muzzleOf(me, a);
          const v = SPEED(p);
          let x = tip.x, y = tip.y, vx = Math.cos(a) * v, vy = Math.sin(a) * v, t = 0, dMin = Infinity, impact = null;
          const dt = 1 / 120;
          while ((t += dt) < 8) {
            vy += GRAV * dt;
            vx += windRef.current * WIND_MAX * dt;
            x += vx * dt; y += vy * dt;
            const tyi = ty + fall * t; // 🪂 lead a falling target
            if (Math.abs(x - tx) <= 29 && Math.abs(y - tyi + 19) <= 23) return { a, p, t, direct: true };
            if (x >= 0 && x < T.width && y >= 0 && isSolid(T, x, y)) { impact = Math.hypot(x - tx, y - tyi); break; } // ate dirt
            if (x < -60 || x > T.width + 60 || y > T.height + 80) break;   // left the world
            dMin = Math.min(dMin, Math.hypot(x - tx, y - tyi + 19));
          }
          return { a, p, t, dMin, impact };
        };
        let best = null, splash = null, seed = null; // seed = closest pass → refine around it
        const coarseA = 0.025, coarseP = 0.04;
        for (let p = 1; p >= 0.2 && !best; p -= coarseP) {
          for (let a = -Math.PI + 0.04; a < -0.04 && !best; a += coarseA) {
            const r = sim(a, p);
            if (r.direct) { best = r; break; }
            if (r.impact != null && r.impact <= BLAST_R + 30 && (!splash || r.impact < splash.d)) splash = { ...r, d: Math.round(r.impact) };
            if (r.dMin != null && r.dMin < (seed?.dMin ?? Infinity)) seed = r;
          }
        }
        // refine: coarse steps are ~35px wide at long range - thread the needle
        if (!best && seed) {
          for (let p = Math.min(1, seed.p + 0.06); p >= Math.max(0.06, seed.p - 0.06) && !best; p -= 0.008) {
            for (let a = seed.a - 0.035; a <= seed.a + 0.035 && !best; a += 0.004) {
              const r = sim(a, p);
              if (r.direct) { best = r; break; }
              if (r.impact != null && r.impact <= BLAST_R + 30 && (!splash || r.impact < splash.d)) splash = { ...r, d: Math.round(r.impact) };
            }
          }
        }
        const sol = best ?? (directOnly ? null : splash);
        if (!sol) return { ok: false, why: 'no-solution', closest: seed?.dMin != null ? Math.round(seed.dMin) : null };
        me.aim = sol.a; aimRef.current = sol.a;
        chargeRef.current.power = sol.p;
        fire();
        return { ok: true, a: +sol.a.toFixed(3), p: +sol.p.toFixed(2), tof: +sol.t.toFixed(2), direct: !!sol.direct, splashD: sol.d };
      },
    };
    return () => { delete window.__bot; };
  }, [fire]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ⛶ fullscreen: keep the HUD chip in sync no matter how we got in/out
  //    (button, F11, or the browser's native Esc-from-fullscreen) ──
  useEffect(() => {
    const onFs = () => {
      setFsUi(!!document.fullscreenElement);
      keysRef.current.clear(); keyStampRef.current.clear(); // 🧹 the fullscreen transition eats keyups (B2)
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

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

      // ⏳ pre-round countdown - ticks down once, freezes input + the turn timer
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

      // 🐕 wedged-key watchdog: a physically held key auto-repeats keydown
      //    (~every 30ms, always at least the last-pressed one), so if NOTHING
      //    has repeated for >1.2s every key in the set is a phantom whose
      //    keyup got eaten - flush them all (B2)
      if (K.size) {
        let newest = 0;
        for (const stamp of keyStampRef.current.values()) newest = Math.max(newest, stamp);
        if (!keyStampRef.current.size || performance.now() - newest > 1200) {
          K.clear(); keyStampRef.current.clear();
        }
      }

      // ── ALL tanks simulate (gravity/footing/knockback); input drives only
      //    the active one - and online, only when it's YOUR tank ──
      for (const me of tanksRef.current) {
        if (me.dead) continue;

        // 🪂 parachute descent (⚡ chaos spawns/respawns): gentle fixed-rate
        //    drop, STEERABLE with A/D - glide left/right to pick your landing
        //    spot. You land, THEN you fight (brief spawn cover).
        if (me.para) {
          me.grounded = false; me.driving = false; me.airVy = 0;
          const minePara = onlineNow ? me.id === myIdRef.current : true; // offline: every tank is locally simmed
          // 🛰️ remote-chute dead reckoning: how stale is the owner's 12Hz stream?
          //    Healthy → extrapolate the last packet by its velocity so the chute
          //    GLIDES smoothly between snapshots (was: staircase chase = jitter).
          //    Stalled (>0.15s: backgrounded tab…) → zero the velocity, so we ease
          //    to the exact last server-known spot and HOLD (stays shootable).
          const netAge = !minePara && me.netAt ? (performance.now() - me.netAt) / 1000 : 0;
          if (!minePara && netAge > 0.15) { me.netVx = 0; me.netVy = 0; }
          const netLead = Math.min(netAge, 0.15);
          // exact exponential ease (1 - e^-k·dt) - NOT the Euler min(1,k·dt),
          // which over-bites on long frames and wobbles under irregular rAF
          const easeS = 1 - Math.exp(-9 * dt), easeNet = 1 - Math.exp(-14 * dt);
          if (me.id === myIdRef.current) { // steer your own drop-in (even mid-countdown)
            const pdir = (K.has('a') || K.has('arrowleft') ? -1 : 0) + (K.has('d') || K.has('arrowright') ? 1 : 0);
            me.s += (pdir * PARA_DRIFT - me.s) * easeS; // 🪂 ease into the glide - no 0↔max snap (was a visible jerk)
            me.x = Math.max(24, Math.min(terrain.width - 24, me.x + me.s * dt));
            if (me.x <= 24 || me.x >= terrain.width - 24) me.s = 0; // wall - kill the glide, don't grind
          } else {
            me.s = 0;
            if (onlineNow && me.netX != null) me.x += ((me.netX + (me.netVx || 0) * netLead) - me.x) * easeNet; // mirror the owner's glide, dead-reckoned
          }
          if (minePara) {
            me.y = (me.y ?? -60) + PARA_FALL * dt;
          } else if (me.netY != null) {
            // 🎯 shoot what you see: a rival's chute rides their STREAMED altitude
            //    (12Hz), it never free-falls on our clock. If their client stalls
            //    (backgrounded tab while dead/respawning - the classic), the tank
            //    freezes where the SERVER last saw it too, so shots at the visible
            //    chute always register (was: our ghost kept gliding + landing while
            //    the server held it mid-sky - every "hit" did 0 damage).
            me.y += ((me.netY + (me.netVy || 0) * netLead) - me.y) * easeNet;
          }
          // netY still null → their stream hasn't arrived since the (re)spawn:
          // HOLD at the last server-known altitude - exactly where the server
          // believes the tank is, so it hangs shootable instead of ghost-gliding
          const gyP = surf(me.x);
          if (me.y >= gyP) { // touchdown - stow the chute, kick up dust
            me.y = gyP; me.para = false; me.grounded = true;
            me.s = 0; me.netVx = 0; me.netVy = 0;
            me.paraDone = true; // 🪂 this generation has landed - stale state can't re-arm it (B6)
            me.susVel += 10;
            fxRef.current.add({ t: 'dirt', x: me.x - 10, y: me.y - 2, vx: -40, vy: -30, size: 2.2, life: 0.5 });
            fxRef.current.add({ t: 'dirt', x: me.x + 10, y: me.y - 2, vx: 40, vy: -30, size: 2.2, life: 0.5 });
            // 🌐 report the touchdown NOW, not on the next 12Hz slot - until the
            //    server learns the chute is stowed it keeps broadcasting para:true
            //    and every one of those states would re-arm it here (B6)
            if (onlineNow && me.id === myIdRef.current) {
              netAccRef.current = 0;
              getSocket()?.emit('tank-move', {
                x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10,
                aim: me.aim, s: 0, fuel: Math.round(me.fuel ?? 100), para: false,
              });
            }
          }
          // 🌐 owner streams the glide so rivals see you steer down
          if (onlineNow && me.id === myIdRef.current) {
            netAccRef.current += dt;
            if (netAccRef.current >= 1 / NET_HZ) {
              netAccRef.current = 0;
              getSocket()?.emit('tank-move', {
                x: Math.round(me.x * 10) / 10,
                y: Math.round((me.y ?? 0) * 10) / 10,
                aim: me.aim,
                s: Math.round(me.s || 0),
                fuel: Math.round(me.fuel ?? 100),
                para: true,
              });
            }
          }
          continue;
        }

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

        // act only while the turn is OPEN - ⚡ chaos: YOUR tank is always live
        const mine = chaosRef.current
          ? me.id === myIdRef.current && turn.phase !== 'over' && countdownRef.current <= 0
          : me === active && turn.phase === 'open' && countdownRef.current <= 0
            && (!onlineNow || me.id === myIdRef.current);
        const dir = mine ? (K.has('a') || K.has('arrowleft') ? -1 : 0) + (K.has('d') || K.has('arrowright') ? 1 : 0) : 0;
        me.driving = false; // proves itself below when the engine actually pushes

        // jump - Worms-style escape hatch (active tank, not while charging, costs fuel)
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
          // 🔋 engine needs fuel - and after a dry cut it stays cut until 5+
          //    is back (hysteresis kills the per-frame stall/creep cycle at 0, B4)
          me.driving = dir !== 0 && me.fuel > 0 && !me.fuelCut;
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
            // 🛡️ other tanks are SOLID - bumper-to-bumper, never through.
            //    🧭 DIRECTIONAL (B3): block only when this step CLOSES the gap -
            //    otherwise a tank you're overlapping handbrakes BOTH directions
            //    (nx is ≤2.9px from me.x, so a non-directional test can't tell
            //    "into" from "away" and you'd be wedged at ~2px/s forever)
            const tankBlock = tanksRef.current.some((o) =>
              o !== me && !o.dead && Math.abs((o.y ?? me.y) - me.y) < 32
              && Math.abs(nx - o.x) < 46 && Math.abs(nx - o.x) < Math.abs(me.x - o.x));
            // (the old water term was dead code - waterY sits below the map - deleted, not "fixed")
            const hardBlock = nx < 26 || nx > terrain.width - 26 || tankBlock;
            if (hardBlock) {
              me.s = 0; // blocked: world edge / solid tank - stop dead, don't grind (B3)
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

        // fuel: burn while driving, regenerate otherwise (empty tank = engine dead)
        // ⚡ chaos: pit-stop refill - bone dry → full tank in 3 seconds
        if (me.driving) me.fuel = Math.max(0, me.fuel - FUEL_BURN(me.s) * dt);
        else me.fuel = Math.min(100, me.fuel + (chaosRef.current ? 100 / 3 : FUEL_REGEN) * dt);
        if (me.fuel <= 0) me.fuelCut = true; else if (me.fuel >= 5) me.fuelCut = false; // 🔋 hysteresis (B4)
        me.noFuelT = Math.max(0, (me.noFuelT || 0) - dt);
        me.stopT = Math.max(0, (me.stopT || 0) - dt);
        me.cd = Math.max(0, (me.cd || 0) - dt);         // ⚡ chaos reload
        me.cdDenyT = Math.max(0, (me.cdDenyT || 0) - dt);
        // ⛽ warn whenever a direction is HELD at 0 fuel - the old condition
        //    (me.driving && wasFuel > 0) was unreachable once pinned at 0,
        //    so the player pressing A/D got zero feedback (B4)
        if ((chaosRef.current ? me.id === myIdRef.current : me === active) && dir !== 0 && me.fuel <= 0 && me.noFuelT <= 0) {
          me.noFuelT = 3;
          fxRef.current.text(me.x, (me.y ?? surf(me.x)) - 62, 'OUT OF FUEL', '#ff9b5e');
          sfx('deny');
        }

        if (chaosRef.current ? me.id === myIdRef.current : me === active) me.aim = aimRef.current; // remember where this tank left its barrel

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
              fuel: Math.round(me.fuel ?? 100),                       // 👀 rivals watch your gauge
              // 🕵️ no p - your missile power is YOUR secret (persisted locally only)
              para: me.para === true,                                 // 🪂 chute stowed = touchdown
            });
          }
        }
      }

      // ── 🛡️ tank↔tank collision: bodies are solid, overlaps get pushed apart.
      //    Offline: both move. Online: only MY tank yields (the remote one is
      //    stream-owned) - so an enemy landing on you shoves YOU aside. ──
      {
        const ts = tanksRef.current;
        for (let i = 0; i < ts.length; i++) {
          for (let j = i + 1; j < ts.length; j++) {
            const A = ts[i], B = ts[j];
            if (A.dead || B.dead) continue;
            const dx = B.x - A.x, dy = (B.y ?? surf(B.x)) - (A.y ?? surf(A.x));
            if (Math.abs(dx) >= 46 || Math.abs(dy) >= 32) continue;
            // push to 50, not 46: land CLEAR of the blocking test with margin,
            // so the pair doesn't re-wedge on the <46 knife edge every frame (B3)
            const push = (50 - Math.abs(dx)) * (Math.sign(dx) || (i % 2 ? 1 : -1));
            const aMine = !onlineNow || A.id === myIdRef.current;
            const bMine = !onlineNow || B.id === myIdRef.current;
            if (aMine && bMine) { A.x -= push / 2; B.x += push / 2; A.s *= 0.3; B.s *= 0.3; }
            else if (aMine) { A.x -= push; A.s *= 0.3; }
            else if (bMine) { B.x += push; B.s *= 0.3; }
            else continue;
            for (const t of [A, B]) { // stay inside the world + re-snap to ground
              t.x = Math.max(26, Math.min(terrain.width - 26, t.x));
              if (t.grounded) t.y = surf(t.x);
            }
          }
        }
      }

      // ── supply drops (LOCAL modes only - online the server owns drops and
      //    broadcasts crate state + events) ──
      if (!onlineNow && turn.phase !== 'over') {
        dropTRef.current -= dt;
        if (dropTRef.current <= 0) {
          dropTRef.current = 24 + Math.random() * 16; // not frequent
          if (bonusRef.current.filter((b) => !b.taken).length < 3) {
            // ⚖️ fair drop: sample candidate spots and keep the one that maximizes
            // the distance to the NEAREST living tank - equally far from everyone
            let bx = null, bScore = -1;
            const aliveTanks = tanksRef.current.filter((t) => !t.dead);
            for (let k = 0; k < 28; k++) {
              const x = 80 + Math.random() * (terrain.width - 160);
              const nearest = aliveTanks.length ? Math.min(...aliveTanks.map((t) => Math.abs(t.x - x))) : Infinity;
              const score = Math.min(nearest, 400); // past ~400px, extra distance stops mattering
              if (score > bScore) { bScore = score; bx = x; }
            }
            if (bx != null) {
              bonusRef.current.push({
                id: crateIdRef.current++, type: pickDropType(),
                x: bx, y: -40, vy: 0, sway: 0, landed: false, taken: false, bob: Math.random() * 6.28,
                expire: -1, // s left once landed (-1 = still falling) - crates despawn after CRATE_TTL
              });
              fxRef.current.text(bx, 26, '📦 supply drop inbound', '#cfd8c3');
              sfx('drop');
            }
          }
        }
        // crate physics: gentle parachute descent with wind-blown sway; rest on
        // the surface; if the ground under a landed crate gets blown away, it falls again
        for (const b of bonusRef.current) {
          if (b.taken) continue;
          if (b.landed && surf(b.x) > b.y + 8) { b.landed = false; b.vy = 0; }
          if (b.landed) {
            b.y = surf(b.x);
            // ⏳ landed crates don't wait forever - gone after CRATE_TTL seconds
            if (b.expire < 0) b.expire = CRATE_TTL;
            b.expire -= dt;
            if (b.expire <= 0) {
              b.taken = true;
              const defX = BONUS_DEFS[b.type]; // 🎁 reveal what was lost
              fxRef.current.text(b.x, b.y - 30, defX ? `📦 was ${defX.label} ${defX.name}!` : '📦 expired', defX?.color ?? '#9fb08f');
              for (let i = 0; i < 7; i++) {
                fxRef.current.smoke(b.x + (Math.random() - 0.5) * 18, b.y - 12,
                  (Math.random() - 0.5) * 30, -25 - Math.random() * 30, 4 + Math.random() * 4, 0.7 + Math.random() * 0.4);
              }
              sfx('thud');
            }
            continue;
          }
          b.sway += dt;
          b.vy = Math.min(150, b.vy + GRAV * 0.35 * dt); // parachute drag
          b.x = Math.max(40, Math.min(terrain.width - 40, b.x + Math.sin(b.sway * 2 + b.bob) * 14 * dt + windRef.current * 30 * dt));
          b.y += b.vy * dt;
          const gyB = surf(b.x);
          if (b.y >= gyB) {
            b.y = gyB;
            b.landed = true;
            b.expire = CRATE_TTL; // ⏳ 60s on the ground, then it disappears
            sfx('thud');
            fxRef.current.add({ t: 'dirt', x: b.x - 6, y: b.y - 2, vx: -25, vy: -30, size: 1.6, life: 0.4 });
            fxRef.current.add({ t: 'dirt', x: b.x + 6, y: b.y - 2, vx: 25, vy: -30, size: 1.6, life: 0.4 });
          }
        }
      } else if (onlineNow) {
        // 🌐 crates mirror the server - ease toward the 10Hz targets
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
            } else if (b.type === 'teleport') { // 🌀 use-it-this-turn targeting (only the active tank drives)
              t.tele = true;
              if (t === activeTank()) {
                teleRef.current = { targeting: true }; setTeleUi('targeting');
                fxRef.current.text(b.x, b.y - 44, 'click where to land!', def.color);
              }
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
        if (p.dud) { // 🧨 the server refused this shot (turn raced past) - fizzle, carve nothing
          fxRef.current.smoke(p.x, p.y - 4, 0, -24, 6, 0.7, 'rgb(150,152,160)');
          fxRef.current.text(p.x, p.y - 26, 'dud…', '#9aa08f');
          return;
        }
        const ds = p.dmgScale || 1;
        const spec = p.kind === 'tomahawk' ? { r: 200, scale: Math.min(6, 3.2 * ds), big: true } // ☢️ MASSIVE (server clamps r at 200, scale at 6 - show what it will do)
          : p.kind === 'sub' ? { r: 40, scale: 0.75 * ds }
          : p.kind === 'guided' ? { r: BLAST_R, scale: 1.25 * ds }
          : { r: BLAST_R, scale: ds };
        if (!onlineNow) { explode(p.x, p.y, spec.r, { ...spec, by: p.src }); return; } // 💀 by = the shell's owner scores the kill
        if (p.mine) {
          // instant local terrain+FX; the server's 'blast' echo brings damage.
          // The echo is matched by shooter id - no coordinate-window guessing.
          explodeTerrain(p.x, p.y, spec.r, spec);
          getSocket()?.emit('blast', { x: p.x, y: p.y, r: spec.r, scale: spec.scale, big: !!spec.big, shot: p.shot ?? 0 });
        }
        // remote shell: visual only - the server's 'blast' event makes the boom
      };
      // 💥 cluster: the shell never explodes itself - ON IMPACT it bursts into
      // 3 independent bomblets that pop up and out, then each explodes on landing
      const splitCluster = (p) => {
        const gy = surf(p.x);
        const fan = [ // up-left, straight up (hardest), up-right
          [-2.19, 300], [-Math.PI / 2, 390], [-0.95, 300],
        ];
        for (const [ang, spd] of fan) {
          subsRef.current.push({
            x: p.x, y: Math.min(p.y - 4, gy - 4),
            vx: Math.cos(ang) * spd + p.vx * 0.2, vy: Math.sin(ang) * spd,
            src: p.src, armed: p.armed, kind: 'sub', dmgScale: p.dmgScale, mine: p.mine,
            shot: p.shot, dud: p.dud, // 🧨 a dud cluster births dud bomblets
          });
        }
        fxRef.current.muzzle(p.x, Math.min(p.y, gy - 4), -Math.PI / 2);
        fxRef.current.add({ t: 'ring', x: p.x, y: Math.min(p.y, gy - 4), size: 4, grow: 300, life: 0.35, color: 'rgba(143,208,255,0.9)' });
        fxRef.current.text(p.x, Math.min(p.y, gy - 4) - 18, 'SPLIT!', '#8fd0ff');
        sfx('split');
      };
      const stepProj = (p) => { // advance one shell; returns false when it's gone
        // 🎯 guided: powered cruise missile that CANNOT miss. It locks the nearest
        // living opponent every frame; with a clear line it homes straight in
        // (doubled pitch authority in the endgame + a proximity fuse), otherwise
        // it hugs the terrain - riding GUIDED_CLEAR above the ridgeline between
        // it and the target - until the line opens. Gravity and wind don't apply.
        let powered = false;
        if (p.kind === 'guided' && (p.armed || 0) < GUIDED_FUEL) {
          let best = null, bd = Infinity;
          for (const t of tanksRef.current) {
            if (t.dead || t === p.src || t.para) continue; // 🪂 never lock a chute - the missile can't hurt it
            const d = Math.hypot(t.x - p.x, (t.y - 14) - p.y);
            if (d < bd) { bd = d; best = t; }
          }
          if (best) {
            powered = true;
            const tgx = best.x, tgy = (best.y ?? 0) - 14;
            const dx = tgx - p.x, dy = tgy - p.y;
            const dist = Math.hypot(dx, dy) || 1;
            if (dist < GUIDED_FUSE) { explodeProj(p); return false; } // proximity fuse - dead on
            // clear shot at the target? sample the straight line for solid ground
            let los = true;
            for (let i = 1; i < 32; i++) {
              const f = i / 32;
              const sx = p.x + dx * f, sy = p.y + dy * f;
              if (sx >= 0 && sx < terrain.width && sy >= 0 && isSolid(terrain, sx, sy)) { los = false; break; }
            }
            let want;
            if (los) {
              want = Math.atan2(dy, dx); // clear line - home straight onto them
            } else {
              // blocked - follow the terrain: cruise above the highest ground in
              // the corridor toward the target until the line of sight opens up
              const dir = Math.sign(dx) || 1;
              let crest = Infinity;
              const reach = Math.min(Math.abs(dx), GUIDED_LOOK);
              for (let s = 0; s <= reach; s += 12) {
                const sx = Math.max(0, Math.min(terrain.width - 1, Math.round(p.x + dir * s)));
                crest = Math.min(crest, terrain.surface[sx]);
              }
              const cruiseY = Math.min(crest, tgy) - GUIDED_CLEAR;
              const v = Math.max(-2.4, Math.min(2.4, (cruiseY - p.y) / 90));
              want = Math.atan2(v, dir);
            }
            let cur = Math.atan2(p.vy, p.vx);
            let dAng = want - cur;
            while (dAng > Math.PI) dAng -= Math.PI * 2;
            while (dAng < -Math.PI) dAng += Math.PI * 2;
            // pitch authority doubles in the endgame - the dive cannot overshoot
            const maxTurn = GUIDED_TURN * (dist < 260 ? 2.2 : 1) * dt;
            cur += Math.max(-maxTurn, Math.min(maxTurn, dAng));
            if (!los) { // emergency pull-up while cruising - never plow into a ridge
              const ex = p.x + Math.cos(cur) * 46, ey = p.y + Math.sin(cur) * 46;
              if (ex >= 0 && ex < terrain.width && ey >= 0 && isSolid(terrain, ex, ey)) cur = -Math.PI / 2;
            }
            p.vx = Math.cos(cur) * GUIDED_SPEED; // motor holds speed - no stall, no drop
            p.vy = Math.sin(cur) * GUIDED_SPEED;
          }
        }
        if (!powered) { // ballistic: gravity + full wind (a guided missile ignores both)
          p.vy += GRAV * dt;
          p.vx += windRef.current * WIND_MAX * dt;
        }
        p.armed = (p.armed || 0) + dt;
        const dist = Math.hypot(p.vx, p.vy) * dt;
        const steps = Math.max(1, Math.ceil(dist / 4));
        for (let s = 0; s < steps; s++) {
          p.x += (p.vx * dt) / steps;
          p.y += (p.vy * dt) / steps;
          // tank hit - checked every 4px substep, no bypass/tunneling possible.
          // 🎯 PROPER collision mask: the tank's rotated hull box (tracks, turret
          // and barrel root - 58×46 covers the whole visible body), so even a
          // graze registers instead of the shell ghosting through the edges.
          let hitTank = null;
          for (const t of tanksRef.current) {
            if (t.dead) continue;
            if (t.para) continue; // 🪂 shells pass THROUGH the canopy - it can't be hurt, so it can't be hit
            if (t === p.src && p.armed < 0.12) continue; // just left our own muzzle
            const cx = t.x, cy = (t.y ?? 0) - 19;
            const th = t.rot || 0, co = Math.cos(th), si = Math.sin(th);
            const ddx = p.x - cx, ddy = p.y - cy;
            const lx = ddx * co + ddy * si;  // rotate the shell into the tank's frame
            const ly = -ddx * si + ddy * co;
            if (Math.abs(lx) <= 29 && Math.abs(ly) <= 23) { hitTank = t; break; }
          }
          const inX = p.x >= 0 && p.x < terrain.width;
          if (hitTank || (inX && p.y >= 0 && isSolid(terrain, p.x, p.y))) {
            // 💥 cluster falls from the sky, lands, and only THEN becomes 3 bombs
            //    (a dud cluster never splits - it just fizzles out)
            if (p.kind === 'cluster' && !p.dud) { splitCluster(p); return false; }
            explodeProj(p); return false;
          }
          if (!inX || p.y > terrain.height + 60) return false; // flew off the world
        }
        return true;
      };
      if (projsRef.current.length) projsRef.current = projsRef.current.filter((p) => stepProj(p));
      if (subsRef.current.length) subsRef.current = subsRef.current.filter((p) => stepProj(p));
      for (const q of [...projsRef.current, ...subsRef.current]) { // smoke trails
        if (!q) continue;
        const ang = Math.atan2(q.vy, q.vx);
        fxRef.current.trail(q.x - Math.cos(ang) * 8, q.y - Math.sin(ang) * 8, q.vx, q.vy);
      }

      // turn timer - 20s to act (online the server passes the turn at 0).
      // Frozen during the pre-round countdown so it isn't eaten by "3, 2, 1".
      if (turn.phase === 'open' && countdownRef.current <= 0) {
        turn.time -= dt;
        if (turn.time <= 0) {
          // ⚡ chaos (even solo dev): the SERVER owns the match clock - clamp at
          // 0 and let the next gs mirror correct us; never run hot-seat turns
          if (onlineNow || chaosRef.current) turn.time = 0;
          else advanceTurn();
        }
      }

      // shot resolved? brief settle so everyone sees the result, then next player's turn
      if (turn.phase === 'shot' && projsRef.current.length === 0 && subsRef.current.length === 0) {
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

      // ── 🌬️ wind streaks: ambient speed-lines in the sky - density, speed
      //    and direction all follow this turn's wind (calm air = none) ──
      {
        const w = windRef.current, aw = Math.abs(w);
        const ss = streaksRef.current;
        const target = Math.round(aw * (qualityRef.current?.knobs ?? TIERS.high).windStreaks); // 🎚️ tier-scaled
        while (ss.length < target) ss.push({ x: Math.random() * terrain.width, y: 30, len: 20, sp: 0.6 + Math.random() * 0.9, ph: Math.random() * 6.28, amp: 4 + Math.random() * 9, fresh: true });
        if (ss.length > target) ss.length = target;
        const upwind = w > 0 ? -50 : terrain.width + 50;
        for (const s of ss) {
          s.x += w * 320 * s.sp * dt;
          const cx = Math.max(30, Math.min(terrain.width - 30, s.x));
          if (s.fresh || s.x < -70 || s.x > terrain.width + 70 || s.y > Math.min(surf(cx), terrain.waterY) - 28) {
            // (re)spawn at the upwind edge (fresh spawns scatter map-wide)
            if (!s.fresh) s.x = upwind;
            s.fresh = false;
            const gx = Math.max(30, Math.min(terrain.width - 30, s.x));
            const ceiling = Math.min(surf(gx), terrain.waterY) - 40;
            s.y = 20 + Math.random() * Math.max(40, ceiling - 40);
            s.len = (14 + Math.random() * 24) * (0.5 + aw);
          }
        }
      }

      // 🧱 pay down chunked terrain repaints - a few ms of fbm painting per
      //    frame instead of one multi-frame hitch on a mega-blast (#14)
      {
        const q = repaintQRef.current, offC = terrainCanvasRef.current;
        if (q.length && offC) {
          let budget = 46000; // px per frame
          const c2d = offC.getContext('2d');
          while (q.length && budget > 0) {
            const band = q.shift();
            const rg = renderTerrainRegion(terrain, band.x, band.y, band.w, band.h);
            c2d.putImageData(new ImageData(reg.data, reg.w, rg.h), rg.x, rg.y);
            budget -= rg.w * rg.h;
          }
          if (terrainViewRef.current) terrainViewRef.current.dirty = true; // 🖼️ bands landed - re-scale the blit cache
        }
      }

      fxRef.current.update(dt);
      if (shakeRef.current > 0) shakeRef.current = Math.max(0, shakeRef.current - dt * 1.6);
      if (whiteRef.current > 0) whiteRef.current = Math.max(0, whiteRef.current - dt * 0.7); // ☢️ flash fades slowly
    };

    let lastFrameAt = performance.now();
    let lastRenderAt = 0;
    const frame = (now) => {
      const rawMs = now - lastFrameAt; lastFrameAt = now; // real frame delta (pre-clamp) - the governor's sample
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const gov = qualityRef.current;
      if (gov) {
        gov.sample(rawMs, now);
        const k = gov.knobs;
        fxRef.current.cap = k.particleCap;      // 🎚️ live particle budget
        fxRef.current.emitScale = k.emitScale;  //     and emission throttle
        if ((gov.tier === 'low') !== lowUiRef.current) { lowUiRef.current = gov.tier === 'low'; setLowUi(lowUiRef.current); }
        if (k.frameCapMs && now - lastRenderAt < k.frameCapMs) { // Low tier: 60fps render ceiling on 120Hz+ panels
          update(dt);
          raf = requestAnimationFrame(frame);
          return;
        }
      }
      lastRenderAt = now;
      update(dt);
      render(now, dt);
      raf = requestAnimationFrame(frame);
    };

    const render = (now, dt) => {
      const canvas = canvasRef.current;
      const off = terrainCanvasRef.current;
      const terrain = terrainRef.current;
      if (!canvas || !off || !terrain) return;
      const qk = qualityRef.current?.knobs ?? TIERS.high;
      const dpr = Math.min(window.devicePixelRatio || 1, qk.dprCap); // 🎚️ Low tier renders at 1×
      const cw = canvas.clientWidth, chh = canvas.clientHeight;
      if (!cw || !chh) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(chh * dpr);
        if (terrainViewRef.current) terrainViewRef.current.dirty = true; // DPR/tier switch → re-scale
      }
      if (!ctx2dRef.current || ctx2dRef.current.canvas !== canvas) ctx2dRef.current = canvas.getContext('2d');
      const ctx = ctx2dRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a0d09';
      ctx.fillRect(0, 0, cw, chh);
      // ── fixed whole-map view - no zoom, no follow cam; the entire
      //    battlefield is always fully visible ──
      const scale = Math.min(cw / off.width, chh / off.height) * 0.985;
      const ox = cw / 2 - (off.width / 2) * scale;
      const oy = chh / 2 - (off.height / 2) * scale;
      viewRef.current = { scale, ox, oy };
      // 🖼️ pre-scaled terrain cache (5b): the source bitmap is up to 3360×1260
      //    and high-quality-downscaling it EVERY frame was the biggest single
      //    render cost. Terrain changes only on a blast (dirty flag set by the
      //    repaint sites) - so downscale ONCE into a device-pixel cache and
      //    blit 1:1 per frame.
      const dw = Math.max(2, Math.round(off.width * scale * dpr));
      const dh = Math.max(2, Math.round(off.height * scale * dpr));
      let tv = terrainViewRef.current;
      if (!tv) { tv = terrainViewRef.current = { c: document.createElement('canvas'), w: 0, h: 0, dirty: true }; }
      if (tv.w !== dw || tv.h !== dh) { tv.c.width = dw; tv.c.height = dh; tv.w = dw; tv.h = dh; tv.dirty = true; }
      if (tv.dirty) {
        const tc = tv.c.getContext('2d');
        tc.imageSmoothingEnabled = true;
        tc.imageSmoothingQuality = qk.smoothing;
        tc.clearRect(0, 0, dw, dh);
        tc.drawImage(off, 0, 0, dw, dh);
        tv.dirty = false;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tv.c, 0, 0, dw, dh, ox, oy, off.width * scale, off.height * scale);

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      // ☀️ living sun - a soft halo that breathes over the baked disc
      {
        const sx = terrain.width * 0.78, sy = terrain.height * 0.15;
        const pr = terrain.height * 0.30 * (1 + Math.sin(now * 0.0006) * 0.045);
        const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, pr);
        grd.addColorStop(0, 'rgba(255,244,200,0.17)');
        grd.addColorStop(0.55, 'rgba(255,236,180,0.07)');
        grd.addColorStop(1, 'rgba(255,236,180,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(sx - pr, sy - pr, pr * 2, pr * 2);
      }

      // 🌬️ wind streaks - faint speed-lines drifting across the sky; you read
      //    direction, strength and gusts at a glance while aiming
      {
        const w = windRef.current, aw = Math.abs(w);
        if (aw > 0.04) {
          const dir = w > 0 ? 1 : -1;
          ctx.lineWidth = 1.7;
          ctx.lineCap = 'round';
          for (const s of streaksRef.current) {
            const wob = Math.sin(now * 0.0035 + s.ph) * s.amp * 0.4;
            ctx.strokeStyle = `rgba(200,225,255,${(0.06 + 0.15 * aw) * (0.55 + s.sp * 0.45)})`;
            ctx.beginPath();
            ctx.moveTo(s.x, s.y + wob);
            ctx.quadraticCurveTo(
              s.x - dir * s.len * 0.5, s.y + wob + Math.sin(now * 0.0035 + s.ph + 1.2) * 3.5,
              s.x - dir * s.len, s.y + wob * 0.4);
            ctx.stroke();
          }
        }
      }

      fxRef.current.draw(ctx, 'back'); // smoke behind tanks

      const active = activeTank();
      const turn = turnRef.current;

      // supply crates - parachuting in (canopy + cords) or sitting on the
      // ground (pulsing glow box), always visible
      for (const b of bonusRef.current) {
        if (b.taken) continue;
        // 🎁 mystery crate - contents hidden until pickup or expiry
        const MC = '#ffcf6e';
        const pulse = 0.6 + 0.4 * Math.sin(now * 0.006 + b.bob);
        // ⏳ expiry blink - landed crates flash during their last 5s (local crates
        // count down b.expire; online crates carry the server's expiresAt stamp)
        const expIn = b.expiresAt ? (b.expiresAt - Date.now()) / 1000
          : (b.landed && (b.expire ?? -1) >= 0 ? b.expire : Infinity);
        const blink = b.landed && expIn < 5 ? (Math.sin(now * 0.02 + b.bob) > 0 ? 1 : 0.25) : 1;
        if (!b.landed) {
          // striped parachute canopy (cream panels on red)
          ctx.fillStyle = 'rgba(214,84,64,0.95)';
          ctx.beginPath(); ctx.arc(b.x, b.y - 26, 16, Math.PI, 0); ctx.fill();
          ctx.save();
          ctx.beginPath(); ctx.arc(b.x, b.y - 26, 16, Math.PI, 0); ctx.clip();
          ctx.fillStyle = 'rgba(240,236,224,0.95)';
          ctx.fillRect(b.x - 11, b.y - 42, 4, 16);
          ctx.fillRect(b.x - 2, b.y - 42, 4, 16);
          ctx.fillRect(b.x + 7, b.y - 42, 4, 16);
          ctx.restore();
          ctx.strokeStyle = 'rgba(120,40,30,0.7)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(b.x, b.y - 26, 16, Math.PI, 0); ctx.stroke();
          ctx.strokeStyle = 'rgba(230,235,225,0.85)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(b.x - 16, b.y - 26); ctx.lineTo(b.x - 9, b.y - 6);
          ctx.moveTo(b.x + 16, b.y - 26); ctx.lineTo(b.x + 9, b.y - 6);
          ctx.moveTo(b.x, b.y - 26); ctx.lineTo(b.x, b.y - 6);
          ctx.stroke();
        } else {
          ctx.globalAlpha = 0.3 * pulse * blink; // landed glow halo
          ctx.fillStyle = MC;
          ctx.beginPath(); ctx.arc(b.x, b.y - 14, 18, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
        const cy = b.landed ? b.y - 14 : b.y;
        ctx.globalAlpha = blink;
        // wooden crate: warm planks, dark frame, diagonal strap, gold '?' badge
        const wg = ctx.createLinearGradient(b.x, cy - 12, b.x, cy + 12);
        wg.addColorStop(0, '#a9713a'); wg.addColorStop(0.5, '#8d5a2c'); wg.addColorStop(1, '#6f4520');
        ctx.fillStyle = wg;
        ctx.beginPath(); ctx.roundRect(b.x - 12, cy - 12, 24, 24, 4); ctx.fill();
        ctx.strokeStyle = 'rgba(46,28,12,0.9)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.roundRect(b.x - 12, cy - 12, 24, 24, 4); ctx.stroke();
        ctx.strokeStyle = 'rgba(46,28,12,0.55)'; ctx.lineWidth = 1; // plank seams + strap
        ctx.beginPath();
        ctx.moveTo(b.x - 12, cy - 4); ctx.lineTo(b.x + 12, cy - 4);
        ctx.moveTo(b.x - 12, cy + 4); ctx.lineTo(b.x + 12, cy + 4);
        ctx.moveTo(b.x - 10, cy + 10); ctx.lineTo(b.x + 10, cy - 10);
        ctx.stroke();
        ctx.fillStyle = MC; // gold badge
        ctx.beginPath(); ctx.arc(b.x, cy, 6.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(46,28,12,0.85)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = '#3a2410';
        ctx.font = 'bold 10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(chaosRef.current && b.type ? (CRATE_GLYPHS[b.type] ?? '?') : '?', b.x, cy + 3.5);
        ctx.globalAlpha = 1;
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
          if (chaosRef.current && turn.phase !== 'over' && t.deadAtMs) { // ⚡ respawn countdown - tidy pill under the skull
            const back = Math.max(0, CHAOS_RESPAWN - (performance.now() - t.deadAtMs) / 1000);
            const rLabel = back > 0 ? `⏱ ${back.toFixed(1)}s` : '⏱ …';
            ctx.font = 'bold 11px system-ui';
            ctx.textAlign = 'center';
            const rw = ctx.measureText(rLabel).width;
            ctx.fillStyle = 'rgba(8,12,8,0.6)';
            ctx.beginPath(); ctx.roundRect(t.x - rw / 2 - 7, gyD - 15 + bob, rw + 14, 15, 7); ctx.fill();
            ctx.strokeStyle = 'rgba(143,208,255,0.35)';
            ctx.lineWidth = 0.8;
            ctx.stroke();
            ctx.fillStyle = '#8fd0ff';
            ctx.fillText(rLabel, t.x, gyD - 3.5 + bob);
          }
          drawNameTag(ctx, t.x, gyD - 42 + bob, t);
          continue;
        }
        const isActive = t === active;
        const chaosR = chaosRef.current;
        const spot = chaosR ? t.id === myIdRef.current : isActive; // ⚡ chaos: spotlight follows YOUR tank
        const gy = t.y ?? groundY(t.x);
        const sh = isActive ? shakeRef.current : 0;
        const rf = isActive && t.grounded ? Math.min(1, Math.abs(t.s || 0) / 150) : 0; // rumble ∝ speed
        const dx = (sh ? (Math.random() - 0.5) * 5.5 * sh : 0) + (Math.random() - 0.5) * 1.6 * rf;
        const dy = (sh ? (Math.random() - 0.5) * 4 * sh : 0) + (Math.random() - 0.5) * 1.1 * rf;
        const mineT = !onlineRef.current || t.id === myIdRef.current; // my own tank (or all offline)
        // 🪂 chute sway: STABLE per-tank phase - never derived from t.x (steering
        //    used to shift the sine phase at ±170 rad/s → violent jitter). Steering
        //    still reads visually via a smoothed lean into the glide direction.
        if (t.swayPh == null) t.swayPh = String(t.id ?? '').split('').reduce((a, c) => a + c.charCodeAt(0) * 0.73, 1.7) % (Math.PI * 2);
        const rawVx = (t.x - (t.px ?? t.x)) / Math.max(dt, 1e-3); // actual glide speed this frame
        t.svx = (t.svx || 0) + (Math.max(-260, Math.min(260, rawVx)) - (t.svx || 0)) * (1 - Math.exp(-7 * dt)); // exact exp ease - steady under irregular rAF
        t.px = t.x;
        const lean = t.para ? Math.max(-1, Math.min(1, (t.svx || 0) / PARA_DRIFT)) : 0;
        const swayOsc = t.para ? Math.sin(now * 0.003 + t.swayPh) : 0;
        const swayX = t.para ? swayOsc * 5 + lean * 4 : 0;
        t.renderSwayX = swayX; // 🧪 exposed via ?test=1 hook (visual-position jitter checks)
        const stackX = t.x + dx + swayX, stackY = gy + dy; // ONE centre line - every overlay hangs from it
        if (spot && !t.dead && turn.phase !== 'over') { // ⚡ chaos: the HERO MARKER - one aligned system for YOUR tank
          const pal = TANK_PALETTES[(t.palette ?? 0) % TANK_PALETTES.length];
          if (chaosR) {
            const hot = `hsla(${pal.h} ${Math.min(100, pal.s + 55)}% 68%`; // vivid team hue
            const pulse = 0.5 + 0.5 * Math.sin(now * 0.0045); // ONE shared breath - every layer in phase
            // sky beam - soft horizontal falloff, no hard rectangle edges
            const beamH = 150;
            const bg = ctx.createLinearGradient(stackX - 15, 0, stackX + 15, 0);
            bg.addColorStop(0, `${hot} / 0)`);
            bg.addColorStop(0.5, `${hot} / ${0.12 + 0.07 * pulse})`);
            bg.addColorStop(1, `${hot} / 0)`);
            ctx.fillStyle = bg;
            ctx.fillRect(stackX - 15, stackY - beamH, 30, beamH);
            const core = ctx.createLinearGradient(stackX - 4, 0, stackX + 4, 0);
            core.addColorStop(0, `${hot} / 0)`);
            core.addColorStop(0.5, `${hot} / ${0.22 + 0.10 * pulse})`);
            core.addColorStop(1, `${hot} / 0)`);
            ctx.fillStyle = core;
            ctx.fillRect(stackX - 4, stackY - beamH, 8, beamH);
            // motes rising through the beam - alive, but cheap
            for (let k = 0; k < qk.motes; k++) { // 🎚️ 0 in Low
              const rise = (now * 0.045 + k * 53) % beamH;
              ctx.globalAlpha = (1 - rise / beamH) * 0.45;
              ctx.fillStyle = `${hot} / 1)`;
              ctx.beginPath(); ctx.arc(stackX + Math.sin(k * 9.3) * 6, stackY - rise, 1.5, 0, Math.PI * 2); ctx.fill();
            }
            ctx.globalAlpha = 1;
            // glow pooling on the ground
            const gg = ctx.createRadialGradient(stackX, stackY, 2, stackX, stackY, 44);
            gg.addColorStop(0, `${hot} / ${0.30 + 0.10 * pulse})`);
            gg.addColorStop(0.65, `${hot} / 0.12)`);
            gg.addColorStop(1, `${hot} / 0)`);
            ctx.fillStyle = gg;
            ctx.beginPath(); ctx.arc(stackX, stackY, 44, 0, Math.PI * 2); ctx.fill();
            // THE ring - one ground ellipse = selection marker AND reload meter (no second ring anywhere)
            const rx = 37, ry = 9.5, ey = stackY - 1;
            const fr = Math.max(0, Math.min(1, (t.cd || 0) / CHAOS_COOLDOWN));
            ctx.lineWidth = 3;
            ctx.strokeStyle = `${hot} / 0.28)`; // dim track, always there
            ctx.beginPath(); ctx.ellipse(stackX, ey, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
            if (fr > 0) { // reloading: cyan sweep refills the ring as the gun cools
              ctx.strokeStyle = `rgba(143,208,255,${0.6 + 0.3 * pulse})`;
              ctx.beginPath(); ctx.ellipse(stackX, ey, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + (1 - fr) * Math.PI * 2); ctx.stroke();
            } else { // ready: bright breathing ring + two orbiting pips
              ctx.save();
              ctx.shadowColor = `${hot} / 0.9)`;
              ctx.shadowBlur = qk.shadowBlur ? 7 : 0; // 🎚️
              ctx.strokeStyle = `${hot} / ${0.7 + 0.3 * pulse})`;
              ctx.beginPath(); ctx.ellipse(stackX, ey, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
              ctx.restore();
              const th2 = now * 0.0022;
              ctx.fillStyle = `${hot} / 0.95)`;
              for (const off2 of [0, Math.PI]) {
                ctx.beginPath(); ctx.arc(stackX + Math.cos(th2 + off2) * rx, ey + Math.sin(th2 + off2) * ry, 2.1, 0, Math.PI * 2); ctx.fill();
              }
            }
          } else { // classic: plain whose-turn glow
            const hue = `hsla(${pal.h} ${Math.min(90, pal.s + 45)}% 60%`;
            const gg = ctx.createRadialGradient(t.x, gy, 2, t.x, gy, 36);
            gg.addColorStop(0, `${hue} / 0.30)`);
            gg.addColorStop(1, `${hue} / 0)`);
            ctx.fillStyle = gg;
            ctx.beginPath(); ctx.arc(t.x, gy, 36, 0, Math.PI * 2); ctx.fill();
          }
        }
        drawTank(ctx, t.x + dx + swayX, gy + dy, {
          aim: isActive && mineT ? aimRef.current : (t.aim ?? -0.6), // remote barrel follows THEIR stream
          palette: t.palette ?? 0,
          rot: (t.rot || 0) + (Math.random() - 0.5) * 0.022 * rf,
          sus: t.susOff || 0,
          wheelRot: t.wheelRot || 0,
        });

        if (t.para && !t.dead) { // 🪂 canopy + cords over the descending tank
          const pal = TANK_PALETTES[(t.palette ?? 0) % TANK_PALETTES.length];
          ctx.save();
          ctx.translate(t.x + dx + swayX, gy + dy);
          ctx.rotate(swayOsc * 0.08 + lean * 0.1); // pendulum swing + lean into the glide (stable phase - no jitter)
          ctx.strokeStyle = 'rgba(232,236,228,0.75)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(-17, -40); ctx.lineTo(-7, -6);
          ctx.moveTo(17, -40); ctx.lineTo(7, -6);
          ctx.moveTo(0, -44); ctx.lineTo(0, -6);
          ctx.stroke();
          ctx.fillStyle = `hsl(${pal.h} 72% 55%)`; // team-color dome
          ctx.beginPath(); ctx.ellipse(0, -44, 22, 14, 0, Math.PI, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.75)'; // white gore stripes
          ctx.beginPath(); ctx.ellipse(-9.5, -44, 4.5, 14, 0.12, Math.PI, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.ellipse(9.5, -44, 4.5, 14, -0.12, Math.PI, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(10,14,10,0.35)';
          ctx.beginPath(); ctx.ellipse(0, -44, 22, 14, 0, Math.PI, Math.PI * 2); ctx.stroke();
          // 🛡️ under canopy = untouchable: faint protective sheen (the shield
          //    bubble recipe at low alpha) so the state is legible at a glance
          {
            const pg = ctx.createRadialGradient(0, -26, 20, 0, -26, 34);
            pg.addColorStop(0, 'rgba(143,208,255,0)');
            pg.addColorStop(0.85, 'rgba(143,208,255,0.08)');
            pg.addColorStop(1, 'rgba(143,208,255,0.02)');
            ctx.fillStyle = pg;
            ctx.beginPath(); ctx.arc(0, -26, 34, 0, Math.PI * 2); ctx.fill();
            ctx.lineWidth = 1.6;
            ctx.strokeStyle = 'rgba(143,208,255,0.4)';
            ctx.beginPath(); ctx.arc(0, -26, 33, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.restore();
          { // 🪂 SAFE chip above the canopy - everyone can read the immunity
            const sx = t.x + dx + swayX, sy = gy + dy;
            ctx.font = 'bold 10.5px system-ui';
            ctx.textAlign = 'center';
            ctx.globalAlpha = 0.72 + 0.18 * Math.sin(now * 0.005);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(4,7,4,0.7)';
            ctx.strokeText('🪂 SAFE', sx, sy - 64);
            ctx.fillStyle = '#bfe6ff';
            ctx.fillText('🪂 SAFE', sx, sy - 64);
            ctx.globalAlpha = 1;
          }
          if (t.id === myIdRef.current) { // 🪂 teach the steering on YOUR drop-in -
            // the held side lights up green LIVE: if pressing A/D doesn't light
            // it, the keypress never reached the game (window not focused?)
            const kL = keysRef.current.has('a') || keysRef.current.has('arrowleft');
            const kR = keysRef.current.has('d') || keysRef.current.has('arrowright');
            ctx.font = '600 11.5px system-ui';
            ctx.globalAlpha = 0.9;
            const parts = [
              { txt: '◀ A', on: kL },
              { txt: ' / ', on: false },
              { txt: 'D ▶', on: kR },
              { txt: kL || kR ? '  steering' : '  steer', on: kL || kR },
            ];
            const wTot = parts.reduce((w, p) => w + ctx.measureText(p.txt).width, 0);
            const hx = Math.max(wTot / 2 + 8, Math.min(cw - wTot / 2 - 8, t.x + dx + swayX)); // never clip off-screen at the map edge
            const hy = gy + dy + 30;
            let px = hx - wTot / 2;
            ctx.textAlign = 'left';
            for (const p of parts) {
              ctx.fillStyle = p.on ? '#86ffab' : '#d7ecff';
              ctx.fillText(p.txt, px, hy);
              px += ctx.measureText(p.txt).width;
            }
            ctx.textAlign = 'center';
            ctx.globalAlpha = 1;
          }
        }



        // active-tank marker: bobbing ▼ (whose turn) - ⚡ chaos: steady gold "▼ YOU" tag
        if (spot && tanksRef.current.length > 1 && turn.phase !== 'over') {
          ctx.save();
          if (chaosR) { // ⚡ bright, readable, ZERO flicker - sits above the name tag
            ctx.font = 'bold 11px system-ui';
            const youLabel = '▼ YOU';
            const yw = ctx.measureText(youLabel).width;
            const yx = stackX - yw / 2 - 9, yy = stackY - 112, yh = 17;
            ctx.fillStyle = 'rgba(6,8,6,0.6)'; // dark offset backplate → crisp contrast edge
            ctx.beginPath(); ctx.roundRect(yx + 1.5, yy + 1.5, yw + 18, yh, 8.5); ctx.fill();
            ctx.fillStyle = '#ffd75e'; // solid bright gold - steady on purpose
            ctx.beginPath(); ctx.roundRect(yx, yy, yw + 18, yh, 8.5); ctx.fill();
            ctx.fillStyle = '#241a05';
            ctx.textAlign = 'center';
            ctx.fillText(youLabel, stackX, yy + 12.5);
          } else {
            const bob = Math.sin(now * 0.006) * 3;
            ctx.fillStyle = '#ffd75e';
            ctx.beginPath();
            ctx.moveTo(t.x, gy - 64 + bob);
            ctx.lineTo(t.x - 6.5, gy - 75 + bob);
            ctx.lineTo(t.x + 6.5, gy - 75 + bob);
            ctx.closePath(); ctx.fill();
          }
          ctx.restore();
        }

        drawNameTag(ctx, stackX, stackY - (chaosR ? 66 : 82), t);

        // status line above the name - pending teleport and/or shield timer, one tidy row
        const shieldLeft = Math.max(0, ((t.shieldUntil ?? 0) - Date.now()) / 1000);
        if (t.tele || shieldLeft > 0) {
          const status = `${t.tele ? '🌀 ' : ''}${shieldLeft > 0 ? `🛡 ${Math.ceil(shieldLeft)}s` : ''}`.trim();
          ctx.font = 'bold 12px system-ui';
          ctx.textAlign = 'center';
          ctx.globalAlpha = 0.8 + 0.2 * Math.sin(now * 0.006);
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(4,7,4,0.75)';
          ctx.strokeText(status, stackX, stackY - (chaosR ? 84 : 94));
          ctx.fillStyle = shieldLeft > 0 ? '#8fd0ff' : '#cfb3ff';
          ctx.fillText(status, stackX, stackY - (chaosR ? 84 : 94));
          ctx.globalAlpha = 1;
        }

        if (shieldLeft > 0) { // 🛡️ energy shield - one clean bubble centred on the hull, not another ring
          const shY = stackY - 19;
          ctx.save();
          const sg = ctx.createRadialGradient(stackX, shY, 26, stackX, shY, 37);
          sg.addColorStop(0, 'rgba(143,208,255,0)');
          sg.addColorStop(0.85, 'rgba(143,208,255,0.10)');
          sg.addColorStop(1, 'rgba(143,208,255,0.02)');
          ctx.fillStyle = sg;
          ctx.beginPath(); ctx.arc(stackX, shY, 37, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(143,208,255,0.55)';
          ctx.beginPath(); ctx.arc(stackX, shY, 36, 0, Math.PI * 2); ctx.stroke();
          const sweep = now * 0.0028; // twin rotating specular highlights - energy, not dashes
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(190,228,255,0.9)';
          ctx.beginPath(); ctx.arc(stackX, shY, 36, sweep, sweep + 0.85); ctx.stroke();
          ctx.strokeStyle = 'rgba(190,228,255,0.45)';
          ctx.beginPath(); ctx.arc(stackX, shY, 36, sweep + Math.PI, sweep + Math.PI + 0.55); ctx.stroke();
          ctx.restore();
        }

        // dotted aim guide - classic: YOUR active tank gets the full power ring + %.
        // 🕵️ rival power is never shown - no ring, no %; their dots are direction-only.
        // ⚡ chaos: NO pivot rings - power rides the crosshair, reload lives on the ground ring.
        const aiming = !t.dead && turn.phase !== 'over' && countdownRef.current <= 0
          && (chaosR || (isActive && turn.phase === 'open'));
        if (aiming) {
          const p = mineT ? chargeRef.current.power : 0.5; // 🕵️ rival power secret - hint dots fly a nominal arc
          const a = mineT ? aimRef.current : (t.aim ?? -0.6); // remote: streamed barrel angle
          if (!chaosR && mineT) { // classic pivot ring + % readout - YOUR power only
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
          } else if (mineT && now - powerFlashRef.current < 1200) {
            // ⚡ scroll feedback: a slim charge arc hugs the turret for a beat, then fades away
            const pv = pivotOf(t);
            ctx.globalAlpha = 1 - (now - powerFlashRef.current) / 1200;
            ctx.lineWidth = 4;
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.beginPath(); ctx.arc(pv.x, pv.y, 24, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeStyle = `hsl(${120 - p * 120} 90% 55%)`;
            ctx.beginPath(); ctx.arc(pv.x, pv.y, 24, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = 1;
          }
          // short dotted arc hint - 4 dots (3 for rivals) tracing the parabola, fading downrange
          // ✨ YOUR dots: bright white, bigger, high alpha - easy to read against any sky
          const tip = muzzleOf(t, a);
          const v = SPEED(Math.max(0.06, p));
          const vx = Math.cos(a) * v, vy0 = Math.sin(a) * v;
          const dots = chaosR && !mineT ? 3 : 4;
          for (let i = 1; i <= dots; i++) {
            const dt2 = i * 0.11;
            const dx2 = vx * dt2;
            const dy2 = vy0 * dt2 + 0.5 * GRAV * dt2 * dt2;
            ctx.globalAlpha = (mineT ? 0.95 : 0.55) * (1 - i / (dots + 3)); // slower fade - stays visible downrange
            ctx.fillStyle = mineT ? '#ffffff' : 'rgb(255,120,90)'; // enemy aim = red tint
            ctx.beginPath(); ctx.arc(tip.x + dx2, tip.y + dy2, mineT ? 2.4 : 1.7, 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = 1;
        }



        // HP bar with tick points + number
        const hp = t.hp ?? 100;
        const bx = stackX - 23, by = stackY - 52; // aligned with the tank, sway included
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
        ctx.fillText(`${hp}`, stackX, by - 2.5);

        // fuel bar (amber) - burns while driving, regens slowly; flashes red when low
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
      for (const proj of [...projsRef.current, ...subsRef.current]) {
        if (!proj) continue;
        const ang = Math.atan2(proj.vy, proj.vx);
        const flick = Math.sin(now * 0.06) * 0.3 + Math.random() * 0.2;
        ctx.save();
        ctx.translate(proj.x, proj.y);
        ctx.rotate(ang);
        if (proj.kind === 'sub') ctx.scale(0.78, 0.78);       // cluster children are smaller
        if (proj.kind === 'tomahawk') ctx.scale(1.35, 1.35);  // ☢️ big boy
        const fl = 10 + flick * 6;
        // additive glow halo - shells read as hot tracers at any zoom
        ctx.globalCompositeOperation = 'lighter';
        const glowR = proj.kind === 'tomahawk' ? 24 : 16;
        const gc = proj.kind === 'guided' ? '255,90,208' : '255,170,70';
        const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
        grd.addColorStop(0, `rgba(${gc},0.5)`);
        grd.addColorStop(1, `rgba(${gc},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(0, 0, glowR, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
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

      // crosshair - bright while the turn is open, dim otherwise; ⚡ red-hot while reloading
      const m = mouseRef.current;
      const myTankX = chaosRef.current ? tanksRef.current.find((tk) => tk.id === myIdRef.current) : null;
      const cooling = !!myTankX && (myTankX.cd || 0) > 0;
      ctx.globalAlpha = turn.phase === 'open' ? 1 : 0.35;
      ctx.strokeStyle = cooling ? 'rgba(255,120,90,0.85)' : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(m.x, m.y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(m.x - 11, m.y); ctx.lineTo(m.x - 4, m.y);
      ctx.moveTo(m.x + 4, m.y); ctx.lineTo(m.x + 11, m.y);
      ctx.moveTo(m.x, m.y - 11); ctx.lineTo(m.x, m.y - 4);
      ctx.moveTo(m.x, m.y + 4); ctx.lineTo(m.x, m.y + 11);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ⚡ chaos: power / reload readout rides the crosshair - exactly where you're aiming
      if (chaosRef.current && myTankX && !myTankX.dead && turn.phase === 'open') {
        const xLabel = cooling ? `${myTankX.cd.toFixed(1)}s` : `${Math.round(chargeRef.current.power * 100)}%`;
        ctx.font = 'bold 11.5px system-ui';
        ctx.textAlign = 'left';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(4,7,4,0.8)';
        ctx.strokeText(xLabel, m.x + 13, m.y + 16);
        ctx.fillStyle = cooling ? '#ff9b7a' : '#ffffff';
        ctx.fillText(xLabel, m.x + 13, m.y + 16);
      }

      // 🌀 teleport targeting - ghost landing pad under the cursor
      if (teleRef.current?.targeting && turn.phase === 'open') {
        const lx = Math.max(30, Math.min(terrain.width - 30, m.x));
        const lgy = groundY(lx); // 🐛 was surf() - undefined in render scope, froze the whole rAF loop
        const okSpot = lgy <= terrain.waterY - 6;
        const col = okSpot ? '#b48cff' : '#ff6b4e';
        ctx.save();
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.setLineDash([5, 6]); // drop line from the sky to the pad
        ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, lgy - 46); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(lx, lgy - 20, 20 + Math.sin(now * 0.008) * 3, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.3; // ghost tank footprint - exactly where you'll stand
        ctx.beginPath(); ctx.roundRect(lx - 25, lgy - 36, 50, 36, 6); ctx.fill();
        ctx.globalAlpha = 0.95;
        ctx.font = 'bold 12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(okSpot ? '🌀 land here' : 'too deep!', lx, lgy - 54);
        ctx.restore();
      }

      ctx.restore();

      // ☢️ tomahawk white-screen flash (screen space, fades fast)
      if (whiteRef.current > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${(Math.min(1, whiteRef.current) * 0.92).toFixed(3)})`;
        ctx.fillRect(0, 0, cw, chh);
      }

      // ⏱ timer - classic: per-turn seconds; ⚡ chaos: the sudden-death match
      //    clock (mm:ss). Glass pill with a draining track, green → amber → red.
      if (turn.phase === 'open') {
        const chaosR = chaosRef.current;
        const total = chaosR ? ((gsRef.current?.dur ?? CHAOS_TIME * 1000) / 1000) : TURN_TIME;
        // ⚡ the server's match clock includes the gen/countdown runway - pin the
        //    pill at full while "3,2,1" plays instead of draining from 3:0X (#17)
        const tSec = chaosR ? Math.min(total, Math.max(0, turn.time)) : Math.max(0, turn.time);
        const cs = Math.ceil(tSec);
        const tShow = chaosR ? `${Math.floor(cs / 60)}:${String(cs % 60).padStart(2, '0')}` : String(cs);
        const frac = Math.max(0, Math.min(1, tSec / total));
        const tCol = chaosR
          ? (tSec > 60 ? '#7fe066' : tSec > 30 ? '#ffd75e' : '#ff4d4d')
          : (tSec > 12 ? '#7fe066' : tSec > 7 ? '#ffd75e' : '#ff4d4d');
        const inRed = chaosR ? tSec <= 30 : tSec <= 7;
        const shakeX = inRed ? (Math.random() - 0.5) * 5 : 0;
        const shakeY = inRed ? (Math.random() - 0.5) * 5 : 0;
        const tx = 16 + shakeX, ty = 62 + shakeY; // below the frosted header
        const tw = 98, th = 46;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = qk.shadowBlur ? 14 : 0; ctx.shadowOffsetY = qk.shadowBlur ? 3 : 0; // 🎚️
        ctx.fillStyle = 'rgba(8,12,8,0.55)'; // glass pill
        ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 12); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = inRed ? tCol + 'aa' : 'rgba(255,255,255,0.14)';
        ctx.lineWidth = inRed ? 1.8 : 1;
        ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 12); ctx.stroke();
        ctx.textAlign = 'left'; // seconds
        ctx.font = `bold ${chaosR ? 21 : 23}px system-ui`;
        ctx.fillStyle = tCol;
        ctx.fillText(tShow, tx + 13, ty + 30);
        ctx.font = '600 9.5px system-ui'; // label
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = '#e8ece4';
        ctx.fillText(chaosR ? '⚡ LEFT' : '⏱ SEC', tx + (chaosR ? 60 : 46), ty + 28);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,255,255,0.10)'; // time-track
        ctx.beginPath(); ctx.roundRect(tx + 12, ty + th - 10, tw - 24, 4, 2); ctx.fill();
        const pw = (tw - 24) * frac;
        if (pw > 1) { ctx.fillStyle = tCol; ctx.beginPath(); ctx.roundRect(tx + 12, ty + th - 10, pw, 4, 2); ctx.fill(); }
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
        // ⚡ chaos: the winner may be mid-respawn at 0:00 - trust the server's verdict
        const wt = chaosRef.current && onlineRef.current
          ? tanksRef.current.find((tk) => tk.id === gsRef.current?.winner)
          : alive[0];
        banner = wt
          ? '🏆 ' + (wt.emoji ?? '') + ' ' + (wt.name ?? '')
            + (chaosRef.current ? ` - ${wt.kills | 0} ☠ · ${wt.dmg | 0} 💥` : ((wt.kills | 0) > 0 ? ` - ${wt.kills | 0} ☠` : ''))
            + (inMatch ? (m.over ? ' WINS THE MATCH!' : ' wins round ' + m.round + '!') : ' WINS!')
          : (inMatch ? '🏳️ round ' + (m?.round ?? '') + ' - DRAW' : '🏳️ DRAW');
        bCol = '#ffd75e';
      } else if (turn.phase === 'open') {
        const ct = controlTank();
        const targeting = teleRef.current?.targeting && ct && (!onlineRef.current || ct.id === myIdRef.current);
        if (targeting) { // 🌀 teleport mode owns the banner - in classic the turn clock is ticking!
          banner = chaosRef.current
            ? '🌀 TELEPORT - click where to land!  (T / Esc to cancel)'
            : '🌀 TELEPORT - click where to land!  (T / Esc to cancel · turn ends = wasted)';
          bCol = '#b48cff';
        } else if (chaosRef.current) { // ⚡ chaos: respawns forever - most KILLS at 0:00
          const meT = tanksRef.current.find((tk) => tk.id === myIdRef.current);
          banner = `${spec ? '👁 spectating · ' : ''}⚡ CHAOS - most KILLS wins at 0:00${meT ? ` · your ☠ ${meT.kills | 0} · 💥 ${meT.dmg | 0}` : ''}`;
          bCol = turn.time <= 30 ? '#ff6b4e' : '#ffb45e';
        } else {
          banner = `${spec ? '👁 spectating · ' : ''}${multi ? who + ' · ' : ''}TURN ${turn.num}`;
          bCol = turn.time <= 7 ? '#ff6b4e' : '#9be15d';
        }
      } else if (turn.phase === 'shot') {
        // B5: a backgrounded shooter's rAF stops, so their shot-done never
        //     arrives and everyone waits on the server timeout - explain it
        const stalled = onlineRef.current && turn.fireAt && Date.now() - turn.fireAt > 2500;
        banner = stalled ? `⏳ waiting for ${who || 'the shooter'}… (their tab may be asleep)` : `🚀 ${multi ? who + ' fired…' : 'shot away…'}`;
        bCol = stalled ? '#ffb45e' : '#8fd0ff';
      } else {
        banner = '💥 settling…';
        bCol = '#8fd0ff';
      }
      ctx.font = 'bold 13px system-ui';
      const bw = ctx.measureText(banner).width + 42;
      ctx.save(); // glass pill with a soft drop shadow
      ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = qk.shadowBlur ? 14 : 0; ctx.shadowOffsetY = qk.shadowBlur ? 3 : 0; // 🎚️
      ctx.fillStyle = 'rgba(8,12,8,0.58)';
      ctx.beginPath(); ctx.roundRect(cw / 2 - bw / 2, 60, bw, 26, 13); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(cw / 2 - bw / 2, 60, bw, 26, 13); ctx.stroke();
      ctx.fillStyle = bCol; // accent dot anchors the state color
      ctx.beginPath(); ctx.arc(cw / 2 - bw / 2 + 16, 73, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillText(banner, cw / 2 + 4, 77.5);

      // 🔌 a dropped owner gets LEAVE_GRACE_MS to reconnect before their tank
      //    dies in place - say so, so the freeze is never silent (B1)
      const goneNames = onlineRef.current ? tanksRef.current.filter((t) => t.gone && !t.dead) : [];
      if (goneNames.length) {
        ctx.font = 'bold 11.5px system-ui';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffb45e';
        ctx.fillText(`🔌 ${goneNames.map((t) => `${t.emoji ?? ''} ${t.name ?? ''}`.trim()).join(', ')} reconnecting…`, cw / 2, 97);
      }

      // 🏆 realtime leaderboard - top-right glass panel, redrawn live every frame.
      // ⚡ chaos ranks by KILLS, damage as tie-breaker (self-splash excluded, dead
      // tanks keep their score - they can still win at 0:00); classic ranks the
      // living by HP. Same key as the server's endChaosByScore - live and final
      // boards can never disagree.
      {
        const board = tanksRef.current;
        if (board.length > 1) {
          const chaosB = chaosRef.current;
          const mt = gsRef.current?.match;
          const ranked = [...board].sort((a, b) => chaosB
            ? ((b.kills | 0) - (a.kills | 0)) || ((b.dmg | 0) - (a.dmg | 0)) || ((b.hp | 0) - (a.hp | 0))
            : ((a.dead ? 1 : 0) - (b.dead ? 1 : 0)) || ((b.hp | 0) - (a.hp | 0)));
          const panelW = 150, rowH = 17;
          const panelH = 24 + ranked.length * rowH + 6;
          const bx = cw - 16 - panelW, by = 76; // just under the frosted header, top-right
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = qk.shadowBlur ? 14 : 0; ctx.shadowOffsetY = qk.shadowBlur ? 3 : 0; // 🎚️
          ctx.fillStyle = 'rgba(8,12,8,0.55)'; // same glass as the timer pill
          ctx.beginPath(); ctx.roundRect(bx, by, panelW, panelH, 12); ctx.fill();
          ctx.restore();
          ctx.strokeStyle = 'rgba(255,255,255,0.14)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.roundRect(bx, by, panelW, panelH, 12); ctx.stroke();
          ctx.textAlign = 'left'; // header - metric + round chip
          ctx.font = '600 9.5px system-ui';
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = '#e8ece4';
          ctx.fillText(chaosB ? '🏆 ☠ KILLS' : '🏆 ❤ STANDINGS', bx + 10, by + 15);
          if (mt && mt.roundsTotal > 1) {
            ctx.textAlign = 'right';
            ctx.fillText(`R${mt.round}/${mt.roundsTotal}`, bx + panelW - 10, by + 15);
          }
          ctx.globalAlpha = 1;
          const medal = ['#ffd75e', '#cfd8dc', '#d8a05d']; // gold / silver / bronze ranks
          ctx.font = '11px system-ui';
          ranked.forEach((tk, i) => {
            const ry = by + 24 + i * rowH;
            const mineRow = tk.id === myIdRef.current;
            if (mineRow) { // YOU - gold wash + gold name
              ctx.fillStyle = 'rgba(255,215,94,0.16)';
              ctx.beginPath(); ctx.roundRect(bx + 4, ry + 1.5, panelW - 8, rowH - 1, 6); ctx.fill();
            }
            ctx.globalAlpha = tk.dead ? (chaosB ? 0.62 : 0.45) : 1; // dead rows dim (still ranked in chaos)
            ctx.textAlign = 'left';
            ctx.fillStyle = medal[i] ?? '#e8ece4';
            ctx.fillText(`${i + 1}`, bx + 10, ry + 12);
            const rawNm = tk.name ?? '?';
            const nm = rawNm.length > 8 ? rawNm.slice(0, 7) + '…' : rawNm;
            ctx.fillStyle = mineRow ? '#ffd75e' : '#e8ece4';
            ctx.fillText(`${tk.emoji ?? ''} ${nm}`.trim(), bx + 22, ry + 12);
            ctx.textAlign = 'right';
            const leads = i === 0 && (chaosB ? ((tk.kills | 0) > 0 || (tk.dmg | 0) > 0) : !tk.dead);
            ctx.fillStyle = leads ? '#ffd75e' : '#e8ece4';
            if (chaosB) { // 💀 kills headline, damage dimmer + secondary
              ctx.fillText(`${tk.kills | 0}☠`, bx + panelW - 9, ry + 12);
              const kw = ctx.measureText(`${tk.kills | 0}☠`).width;
              ctx.globalAlpha = 0.62;
              ctx.fillText(`${tk.dmg | 0}💥 `, bx + panelW - 9 - kw, ry + 12);
            } else {
              ctx.fillText(tk.dead ? '💀' : `${tk.hp | 0}❤`, bx + panelW - 9, ry + 12);
            }
            ctx.globalAlpha = 1;
          });
          ctx.textAlign = 'left';
        }
      }

      // ⏳ pre-round countdown - "3, 2, 1, FIGHT!" dead centre, on top of everything
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

      // ⚡ chaos: YOU died - centre-screen respawn countdown (damage still counts!)
      if (chaosRef.current && turn.phase !== 'over' && countdownRef.current <= 0) {
        const meDead = tanksRef.current.find((tk) => tk.id === myIdRef.current && tk.dead);
        if (meDead?.deadAtMs) {
          const back = Math.max(0, CHAOS_RESPAWN - (performance.now() - meDead.deadAtMs) / 1000);
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 34px system-ui';
          ctx.lineWidth = 7;
          ctx.strokeStyle = 'rgba(4,7,4,0.85)';
          ctx.strokeText('💀 DESTROYED', cw / 2, chh / 2 - 34);
          ctx.fillStyle = '#ff6b4e';
          ctx.fillText('💀 DESTROYED', cw / 2, chh / 2 - 34);
          ctx.font = 'bold 22px system-ui';
          ctx.strokeText(`respawn in ${back.toFixed(1)}s`, cw / 2, chh / 2 + 6);
          ctx.fillStyle = '#8fd0ff';
          ctx.fillText(`respawn in ${back.toFixed(1)}s`, cw / 2, chh / 2 + 6);
          ctx.font = '600 13px system-ui';
          ctx.fillStyle = 'rgba(232,236,228,0.75)';
          ctx.fillText('your damage total still counts - get back in there!', cw / 2, chh / 2 + 34);
          ctx.restore();
        }
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
      const me = controlTank();
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
      const me = controlTank();
      if (!me || !terrainRef.current) return;
      if (onlineRef.current && me.id !== myIdRef.current) return; // online: aim your own barrel only
      const w = toWorld(e);
      mouseRef.current = w;
      const pv = pivotOf(me);
      // full 360° aim - down-left/down-right allowed; assigned raw = instant follow on fast flicks
      aimRef.current = Math.atan2(w.y - pv.y, w.x - pv.x);
    };
    const onDown = (e) => {
      if (e.button !== 0 || !ready || countdownRef.current > 0) return;
      const chaosNow = chaosRef.current;
      if (turnRef.current.phase === 'over') return;
      if (!chaosNow && (projsRef.current.length > 0 || turnRef.current.phase !== 'open')) return;
      const me = controlTank();
      if (!me || me.dead) return;
      if (onlineRef.current && me.id !== myIdRef.current) return; // your turn, your tank
      if (teleRef.current?.targeting) { // 🌀 targeting mode: click = land there, NOT fire
        doTeleport(toWorld(e).x);
        return;
      }
      if (me.para) { // 🪂 still descending - stow the chute first
        if ((me.stopT || 0) <= 0) {
          me.stopT = 1.5;
          fxRef.current.text(me.x, (me.y ?? 0) - 62, '🪂 LAND FIRST', '#8fd0ff');
          sfx('deny');
        }
        return;
      }
      // classic: parked on the ground to fire. ⚡ chaos: run-and-gun -
      // shoot while driving, while jumping, whenever the reload allows
      if (!chaosNow && (!me.grounded || Math.abs(me.s) > 12)) {
        if ((me.stopT || 0) <= 0) {
          me.stopT = 1.5;
          fxRef.current.text(me.x, (me.y ?? 0) - 62, 'STOP TO SHOOT', '#ffd75e');
          sfx('deny');
        }
        return;
      }
      // ⚡ chaos reload - infinite shells, but the gun needs its 1 second
      if (chaosNow && (me.cd || 0) > 0) {
        if ((me.cdDenyT || 0) <= 0) {
          me.cdDenyT = 1;
          fxRef.current.text(me.x, (me.y ?? 0) - 62, `RELOADING ${me.cd.toFixed(1)}s`, '#8fd0ff');
          sfx('deny');
        }
        return;
      }
      fire();
    };
    const onCtx = (e) => e.preventDefault();
    const onWheel = (e) => { // scroll sets power - any time it's your turn, no need to hold
      const me = controlTank();
      if (!me || me.dead || turnRef.current.phase !== 'open' || countdownRef.current > 0) return;
      if (onlineRef.current && me.id !== myIdRef.current) return;
      e.preventDefault();
      chargeRef.current.power = Math.max(0, Math.min(1, chargeRef.current.power - e.deltaY * POWER_SCROLL));
      savePower(chargeRef.current.power); // 💾 persist every tweak - next turn/round/match starts here
      powerFlashRef.current = performance.now(); // ⚡ flash the turret charge arc
    };
    // 🧹 any focus hiccup means keyups may have been eaten (Cmd-Tab, tab
    //    switch, DevTools, fullscreen, OS overlays) - a latched key cancels
    //    its opposite (dir = -1 + 1 = 0) and handbrakes the tank forever
    const clearKeys = () => { keysRef.current.clear(); keyStampRef.current.clear(); };
    const onKey = (e, down) => {
      const held = KEY_CODES[e.code]; // physical key → logical token (modifier-proof)
      if (held) {
        e.preventDefault();
        if (down) {
          // ⌘/⌃/⌥ held? the browser is about to eat the keyup (macOS suppresses
          // keyup for other keys while ⌘ is down) - drop everything, register nothing
          if (e.metaKey || e.ctrlKey || e.altKey) clearKeys();
          else { keysRef.current.add(held); keyStampRef.current.set(held, performance.now()); }
        } else { keysRef.current.delete(held); keyStampRef.current.delete(held); }
      }
      // ⌘/⌃/⌥ itself going down: any keyup from now on may be eaten - flush the set
      if (down && (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt')) clearKeys();
      if (!down) return;
      const k = e.key.toLowerCase();
      if (k === 'escape' && document.fullscreenElement) document.exitFullscreen?.(); // ⛶ Esc leaves fullscreen (browsers do this natively too - belt and braces)
      if (countdownRef.current > 0) return; // no acting until "FIGHT!"
      if (k === 'enter' && turnRef.current.phase === 'open' && !chaosRef.current) { // ⚡ chaos: no turns to pass
        e.preventDefault(); // pass the turn to the next player
        if (onlineRef.current) getSocket()?.emit('pass-turn');
        else advanceTurn();
      }
      if (WEAPON_KEYS[k] && turnRef.current.phase === 'open') selectWeapon(WEAPON_KEYS[k]);
      if ((k === 't' || k === 'escape') && teleRef.current && turnRef.current.phase === 'open') {
        const meT = controlTank(); // 🌀 T re-enters targeting, Esc backs out (charge kept for this turn)
        if (teleRef.current.awaiting) return; // 🌐 the server is deciding our jump
        if (meT && (!onlineRef.current || meT.id === myIdRef.current)) {
          const on = k === 't' ? !teleRef.current.targeting : false;
          teleRef.current.targeting = on;
          setTeleUi(on ? 'targeting' : 'pending');
        }
      }
    };
    const onKeyDown = (e) => onKey(e, true);
    const onKeyUp = (e) => onKey(e, false);
    const onVis = () => { if (document.hidden) clearKeys(); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearKeys);   // 🧹 alt-tab / DevTools / click-out
    window.addEventListener('focus', clearKeys);  //      belt and braces on return
    document.addEventListener('visibilitychange', onVis);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearKeys);
      window.removeEventListener('focus', clearKeys);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ready, myId, fire, advanceTurn]);

  const cycleColor = () => {
    const t = controlTank();
    if (!t) return;
    if (onlineRef.current && t.id !== myIdRef.current) return; // recolor your own tank only
    t.palette = ((t.palette ?? 0) + 1) % TANK_PALETTES.length;
    setColorName(TANK_PALETTES[t.palette].name);
    if (onlineRef.current) getSocket()?.emit('tank-move', { palette: t.palette }); // 🎨 recolors are public
  };

  const toggleMute = () => {
    const m = !mutedUi;
    setMuted(m);
    setMutedUi(m);
    if (!m) sfx('turn'); // little "sound is back" blip
  };

  // 🎚️ graphics: auto (adapts to measured frame time) → high → low → auto
  useEffect(() => {
    if (!qualityRef.current) qualityRef.current = new QualityGovernor();
    setQualityUi(qualityRef.current.mode);
    setLowUi(lowUiRef.current = qualityRef.current.tier === 'low');
  }, []);
  const cycleQuality = () => {
    if (!qualityRef.current) qualityRef.current = new QualityGovernor();
    const mode = qualityRef.current.cycleMode();
    setQualityUi(mode);
    setLowUi(lowUiRef.current = qualityRef.current.tier === 'low');
  };

  // ⛶ fullscreen toggle (Esc backs out - handled in onKey + natively by the browser)
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {}); // needs the click gesture - we have it
  };

  // 🌬️ wind chip label: chevrons ∝ strength, direction = push direction
  const windLabel = (() => {
    const n = Math.round(Math.abs(windUi) * 5);
    if (n === 0) return '-';
    return (windUi > 0 ? '▶' : '◀').repeat(n);
  })();

  // ⌨️ little keyboard-key cap for the controls hint
  const kbd = (label, key) => (
    <kbd key={key ?? label} style={{
      background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.25)',
      borderBottomWidth: 2, borderRadius: 4, padding: '0 4px', marginRight: 2,
      fontSize: '0.66rem', fontFamily: 'inherit', fontWeight: 700, lineHeight: 1.6,
    }}>{label}</kbd>
  );
  const ctl = (keys, verb) => ( // key cap(s) + tiny verb, e.g. [A][D] drive
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {keys.map((k, i) => kbd(k, `${verb}-${i}`))}<span style={{ marginLeft: 2 }}>{verb}</span>
    </span>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0d09', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'none' }} />

      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)',
      }} />

      {/* top bar */}
      <div
        // 🧹 a clicked HUD button must NOT keep DOM focus: Enter isn't
        //    preventDefaulted (it passes the turn), so a focused button would
        //    re-fire on every Enter - e.g. "End game" twice (B2)
        onClick={(e) => e.target.closest?.('button')?.blur()}
        style={{
        position: 'absolute', top: 0, left: 0, right: 0, display: 'flex',
        alignItems: 'center', gap: '0.75rem', padding: '0.6rem 1rem',
        // 🫥 no background strip - text floats over the battlefield, shadow keeps it readable
        textShadow: '0 1px 3px rgba(0,0,0,0.85)',
        color: '#e8ece4', fontFamily: 'system-ui, sans-serif',
      }}>
        <strong style={{ fontSize: '1.05rem' }}>🛡️ B.O.T - battle of tanks</strong>
        {chaos && (
          <span style={{
            background: 'transparent', border: '1px solid rgba(255,180,94,0.5)', color: '#ffb45e', borderRadius: 6,
            padding: '0.1rem 0.5rem', fontSize: '0.8rem', fontWeight: 800, letterSpacing: 0.5,
          }} title="real-time free-for-all - infinite shells, 1s reload, 5s respawn, most damage wins at 0:00">⚡ CHAOS</span>
        )}
        {ready && (
          <span
            title={`wind ${windUi > 0 ? '→' : windUi < 0 ? '←' : 'calm'} (${Math.round(Math.abs(windUi) * 100)}%)`}
            style={{
              background: 'transparent', border: '1px solid rgba(143,208,255,0.45)', color: '#8fd0ff', borderRadius: 6,
              padding: '0.1rem 0.5rem', fontSize: '0.8rem', fontWeight: 700,
              letterSpacing: 1, minWidth: '4.6rem', textAlign: 'center',
            }}
          >🌬️ {windLabel}</span>
        )}
        {showMatch && (
          <span style={{
            background: 'transparent', border: '1px solid rgba(255,215,94,0.45)', color: '#ffd75e', borderRadius: 6,
            padding: '0.1rem 0.5rem', fontSize: '0.78rem', fontWeight: 700,
          }}>ROUND {match.round}/{match.roundsTotal}</span>
        )}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
          fontSize: '0.68rem', opacity: 0.85, whiteSpace: 'nowrap',
        }}>
          {ctl(['A', 'D'], 'drive')}
          {ctl(['W'], 'jump')}
          {ctl(['⇅'], 'power')}
          {ctl(['🖱️'], 'fire')}
          {ctl(['1–4'], 'weapon')}
          {chaos ? ctl(['⏳'], '1s reload') : ctl(['⏎'], 'pass')}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn-hud" onClick={toggleMute} title={mutedUi ? 'unmute' : 'mute'}>{mutedUi ? 'muted' : 'sound'}</button>
        <button className="btn-hud" onClick={cycleQuality} title={`graphics: ${qualityUi}${qualityUi === 'auto' ? ' (follows measured frame rate)' : ''} - click to cycle auto → high → low`}>
          ✨ {qualityUi}{qualityUi === 'auto' ? (lowUi ? '·low' : '·high') : ''}
        </button>
        <button className="btn-hud" onClick={toggleFullscreen} title={fsUi ? 'leave fullscreen (Esc)' : 'play fullscreen (Esc to leave)'}>{fsUi ? '⛶ exit' : '⛶ fullscreen'}</button>
        <button className="btn-hud" onClick={cycleColor}>{colorName}</button>
        <button className="btn-hud" onClick={() => router.push('/')} title="back to the main menu">⌂ menu</button>
        {isHost && turnInfo.phase !== 'over' && (
          <>
        <button className="btn-hud" onClick={() => getSocket()?.emit('regen-terrain')}>New terrain</button>
        <button className="btn-hud" onClick={() => getSocket()?.emit('end-game')}>End game</button>
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

      {/* players - active turn highlighted, eliminated dimmed */}
      <div style={{
        position: 'absolute', left: '1rem', bottom: '1rem', display: 'flex',
        gap: '0.4rem', flexWrap: 'wrap', fontFamily: 'system-ui, sans-serif',
      }}>
        {roster.map((p, i) => {
          const t = tanksRef.current[i];
          const isActive = !chaos && roster.length > 1 && turnInfo.idx === i && turnInfo.phase !== 'over'; // ⚡ chaos: nobody's turn
          // ⚡ chaos: winner = most damage (server's call) - they might be mid-respawn
          const winner = turnInfo.phase === 'over' && roster.length > 1 && (chaos ? gs?.winner === p.id : t && !t.dead);
          const dead = !!t?.dead;
          return (
            <span key={p.id} style={{
              background: winner ? 'rgba(255,215,94,0.28)'
                : isActive ? 'rgba(255,215,94,0.18)'
                : p.id === myId ? 'rgba(127,176,105,0.25)' : 'rgba(0,0,0,0.5)',
              border: winner || isActive ? '1px solid rgba(255,215,94,0.75)'
                : p.id === myId ? '1px solid rgba(127,176,105,0.6)' : '1px solid rgba(255,255,255,0.12)',
              color: '#e8ece4', borderRadius: 999, padding: '0.25rem 0.7rem', fontSize: '0.8rem',
              opacity: dead ? (chaos ? 0.55 : 0.35) : 1, textDecoration: dead && !chaos ? 'line-through' : 'none', // ⚡ chaos: dead = 5s timeout, not elimination
              transition: 'all 0.25s',
              ...(lowUi ? {} : { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }), // 🎚️ frosted pill - off in Low
            }}>
              {winner ? '🏆 ' : isActive ? '▶ ' : ''}{p.emoji} {p.name}{t?.gone ? ' · 🔌 reconnecting…' : ''}{t ? ` · ☠${t.kills | 0}` : ''}{showMatch ? ` · R×${match.wins?.[p.id] | 0}` : ''}{p.id === myId ? ' (you)' : ''}
            </span>
          );
        })}
      </div>

      {/* shell inventory - your tank's stock (⚡ chaos) / active tank's (classic), keys 1-4 to pick */}
      {ready && turnInfo.phase !== 'over' && (() => {
        const t = chaos ? tanksRef.current.find((k) => k.id === myId) : tanksRef.current[turnInfo.idx];
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
            background: 'rgba(8,12,8,0.42)', border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 14, padding: '0.3rem 0.4rem',
            ...(lowUi ? {} : { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }), // 🎚️ frosted dock - off in Low
          }}>
            {teleUi && ( // 🌀 pending teleport - only on the owner's screen; click or press T to aim
              <span
                onClick={() => {
                  if (!teleRef.current) return;
                  teleRef.current.targeting = !teleRef.current.targeting;
                  setTeleUi(teleRef.current.targeting ? 'targeting' : 'pending');
                }}
                title="teleport - click where to land (this turn only, or it's wasted!)"
                style={{
                  background: teleUi === 'targeting' ? 'rgba(180,140,255,0.3)' : 'rgba(0,0,0,0.5)',
                  border: teleUi === 'targeting' ? '1px solid #b48cff' : '1px solid rgba(180,140,255,0.45)',
                  borderRadius: 8, padding: '0.25rem 0.5rem', fontSize: '0.85rem',
                  color: '#e8ece4', cursor: 'pointer',
                }}>
                🌀<span style={{ fontSize: '0.62rem', marginLeft: 4, opacity: 0.55 }}>T</span>
              </span>
            )}
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
                <span key={s.k} title={`${s.key} - ${s.k}`} style={{
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

      {/* 🏆 game over - round result, match scoreboard, host controls */}
      {ready && turnInfo.phase === 'over' && (() => {
        const roundWinner = online
          ? (gs?.winner ? roster.find((p) => p.id === gs.winner) ?? null : null)
          : (tanksRef.current.filter((t) => !t.dead)[0] ?? null);
        // 💀 scoreboard: kills headline, deaths + damage secondary. In a match,
        // career numbers (folded in by the server at each round close); single
        // rounds read the tanks directly. ALWAYS rendered (B8) - a 1-round game
        // still deserves per-player numbers. Sorted like the server: kills → dmg → wins.
        const statOf = (id) => {
          const t = tanksRef.current.find((tk) => tk.id === id);
          return showMatch
            ? { kills: match.kills?.[id] | 0, deaths: match.deaths?.[id] | 0, dmg: match.dmg?.[id] | 0 }
            : { kills: t?.kills | 0, deaths: t?.deaths | 0, dmg: t?.dmg | 0 };
        };
        const board = roster
          .map((p) => ({ p, ...statOf(p.id), w: match?.wins?.[p.id] | 0 }))
          .sort((a, b) => b.kills - a.kills || b.dmg - a.dmg || b.w - a.w);
        const champ = match?.over && board.length > 0 && board[0].w > 0 && (board.length === 1 || board[0].w > board[1].w)
          ? board[0].p : null;
        const wT = roundWinner ? tanksRef.current.find((tk) => tk.id === roundWinner.id) : null;
        const wKills = wT?.kills | 0;
        const wTitle = roundWinner
          ? `🏆 ${roundWinner.emoji ?? ''} ${roundWinner.name ?? ''} ${showMatch ? `wins round ${match.round}!` : 'WINS!'}${wKills > 0 ? ` — ${wKills} kill${wKills === 1 ? '' : 's'}` : ''}`
          : '🏳️ DRAW';
        const title = match?.over && showMatch
          ? (champ ? `🏆 ${champ.emoji} ${champ.name} WINS THE MATCH! — ${statOf(champ.id).kills} ☠` : '🏳️ MATCH DRAW')
          : wTitle;
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
            background: 'rgba(4,7,4,0.55)', ...(lowUi ? {} : { backdropFilter: 'blur(3px)' }), // 🎚️ off in Low
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
                  {board.map(({ p, kills, deaths, dmg, w }, i) => (
                    <div key={p.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1.6rem',
                      padding: '0.34rem 0.8rem', borderRadius: 8,
                      background: i === 0 && (kills > 0 || dmg > 0 || w > 0) ? 'rgba(255,215,94,0.16)' : 'rgba(255,255,255,0.05)',
                      color: i === 0 ? '#ffd75e' : '#cfd8c3', fontSize: '0.9rem',
                      fontWeight: i === 0 ? 700 : 500,
                    }}>
                      <span>{i === 0 ? '👑 ' : ''}{p.emoji} {p.name}{p.id === myId ? ' (you)' : ''}</span>
                      <span style={{ whiteSpace: 'nowrap' }}>
                        <strong style={{ fontSize: '1.02rem' }}>☠ {kills}</strong>
                        <span style={{ opacity: 0.72, fontSize: '0.8rem' }}> · {deaths}💀 · {dmg}💥</span>
                        {showMatch && <span style={{ opacity: 0.72, fontSize: '0.74rem' }}> · R×{w}</span>}
                      </span>
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
                <button className="btn btn-ghost" onClick={() => router.push('/')}>⌂ menu</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
