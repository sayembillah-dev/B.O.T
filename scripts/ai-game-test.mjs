/**
 * Live end-to-end test of a vs-AI game (server must be running):
 *   a human client joins, starts a dev game vs a HARD bot, passes every
 *   turn, and we verify the bot autonomously plays its turns:
 *   think → fire event → server-simmed blast(s) → settle → turn rotates -
 *   until somebody wins (the bot usually wins; we never shoot back).
 *
 * Run the server first.  Usage: URL=http://localhost:3000 node scripts/ai-game-test.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = `ailive${Math.random().toString(36).slice(2, 8)}`; // room ids: [a-z0-9] only
const DIFF = process.env.AI || 'hard';
const MAX_BOT_TURNS = 4;
const TIMEOUT_MS = 120000;

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };
const log = (msg) => console.log(`  ${msg}`);

const socket = io(URL, { transports: ['websocket'] });
const state = {
  gs: null, myId: null, botId: null,
  botFires: 0, botBlasts: 0, botTurnsDone: 0, myHp: 100,
  passT: null, firedThisTurn: false,
};
let done = false;

const finish = (ok, msg) => {
  if (done) return;
  done = true;
  clearTimeout(state.passT);
  socket.close();
  console.log(ok ? `\n✅ ${msg}` : '');
  if (!ok) fail(msg);
  process.exit(0);
};

setTimeout(() => finish(false, `timeout after ${TIMEOUT_MS / 1000}s - bot got stuck`), TIMEOUT_MS);

socket.on('connect', () => {
  log(`connected → joining ${ROOM} vs CPU (${DIFF})`);
  socket.emit('join-room', { roomId: ROOM, name: 'ai-tester', cid: 'ai-test-cid' }, (res) => {
    if (!res?.ok) fail(`join failed: ${res?.error}`);
    state.myId = res.you.id;
    socket.emit('start-game', { dev: true, ai: DIFF });
  });
});

socket.on('game-state', (gs) => {
  const prev = state.gs;
  state.gs = gs;
  if (!gs || gs.phase !== 'playing' && gs.turn?.phase !== 'over') return;
  const bot = (gs.tanks ?? []).find((t) => t.ai);
  if (!bot) fail('no AI tank in the game roster');
  state.botId = bot.id;

  if (gs.turn.phase === 'over') {
    const winner = gs.winner ? (gs.players ?? []).find((p) => p.id === gs.winner) : null;
    return finish(true, `vs-AI game completed - winner: ${winner ? `${winner.emoji} ${winner.name}` : 'draw'} · ` +
      `bot fired ${state.botFires}×, ${state.botBlasts} blast(s), tester hp ${state.myHp}`);
  }

  const active = gs.tanks[gs.turn.activeIdx];
  if (!active) return;

  if (active.id === state.botId && gs.turn.phase === 'open') {
    state.firedThisTurn = false;
    if (state.lastLoggedTurn !== gs.turn.num) { // log once per turn, not per echo
      state.lastLoggedTurn = gs.turn.num;
      log(`bot turn #${gs.turn.num} (${bot.name}) - thinking… hp me ${state.myHp}, bot ${bot.hp}`);
    }
  }

  // I pass my turn 0.8s in - the bot never waits on me
  if (active.id === state.myId && gs.turn.phase === 'open' && !state.passT) {
    if (prev?.turn?.num !== gs.turn.num || prev?.turn?.activeIdx !== gs.turn.activeIdx || prev?.turn?.phase !== 'open') {
      if (state.firedThisTurn === false && state.botId && prev?.turn?.phase === 'open') { /* noop */ }
      state.passT = setTimeout(() => {
        state.passT = null;
        socket.emit('pass-turn');
      }, 800);
    }
  }

  // bot's shot fully resolved → rotation advanced away from the bot
  if (state.firedThisTurn && active.id !== state.botId && gs.turn.phase === 'open') {
    state.firedThisTurn = false;
    state.botTurnsDone++;
    log(`turn rotated away - bot turn complete (${state.botTurnsDone}/${MAX_BOT_TURNS})`);
    if (state.botTurnsDone >= MAX_BOT_TURNS) {
      finish(true, `bot played ${MAX_BOT_TURNS} full turns autonomously (fires ${state.botFires}, blasts ${state.botBlasts}, tester hp ${state.myHp})`);
    }
  }

  const meTank = (gs.tanks ?? []).find((t) => t.id === state.myId);
  if (meTank) state.myHp = meTank.hp;
});

socket.on('fire', (m) => {
  if (m?.id !== state.botId) return;
  state.botFires++;
  state.firedThisTurn = true;
  const deg = Math.round((-m.a * 180) / Math.PI);
  log(`🔥 bot fired - ${m.kind} shell, ${deg}° ${m.a < -Math.PI / 2 ? '←' : '→'}, power ${(m.p * 100).toFixed(0)}%${m.dmgScale > 1 ? ` ×${m.dmgScale} buff` : ''}`);
});

socket.on('blast', (m) => {
  // can't tell who fired from the blast alone; count while bot's shot is live
  if (state.firedThisTurn) state.botBlasts++;
  const mine = (m.dmg ?? []).find((d) => d.id === state.myId);
  if (mine) log(`💥 blast hit me for ${mine.d}${mine.direct ? ' (DIRECT)' : ''} → hp ${mine.hp}`);
});

socket.on('game-event', (e) => {
  if (e?.kind === 'teleport' && e.id === state.botId) log(`🌀 bot teleported to x=${Math.round(e.x)}`);
  if (e?.kind === 'crate-taken' && e.by === state.botId) log(`📦 bot grabbed a crate (${e.type})`);
});

process.on('SIGINT', () => process.exit(130));
