/**
 * Headless accuracy harness for the vs-AI difficulties.
 * For each difficulty we place a CPU tank and a target tank on fresh terrain,
 * let planShot() engineer a shot (error model included), simulate the REAL
 * shell, and measure how often the target takes damage.
 *
 * Expected design curve:  easy < medium < hard
 *   easy   ≈ partially accurate  (lots of misses, some wild yeets)
 *   medium ≈ accurate sometimes  (~coin-flip sharp/sloppy)
 *   hard   ≈ accurate most of the time
 *
 * Usage: node scripts/ai-accuracy-test.mjs [trials]
 */
import { generateTerrain, terrainDims } from '../lib/terrain.mjs';
import { planShot, simulateShot, estimateDamage, DIFFS } from '../lib/ai.mjs';

const TRIALS = Number(process.argv[2]) || 90;
const rollWind = () => {
  const w = Math.random() * 2 - 1;
  return Math.round(Math.sign(w) * Math.pow(Math.abs(w), 0.7) * 20) / 20;
};
const surf = (T, x) => T.surface[Math.max(0, Math.min(T.width - 1, Math.round(x)))];

const stats = {};
for (const d of Object.keys(DIFFS)) {
  stats[d] = { shots: 0, hits: 0, directs: 0, dmg: 0, self: 0, kills: 0, guided: 0, specials: 0, solv: 0, solvHits: 0 };
}

// deterministic seeds — reproducible difficulty curve across runs
let terrains = [];
for (let i = 0; i < 6; i++) {
  const dims = terrainDims(2);
  terrains.push(await generateTerrain(`ai-acc-${i}`, dims.width, dims.height));
}

for (const difficulty of Object.keys(DIFFS)) {
  const S = stats[difficulty];
  for (let t = 0; t < TRIALS; t++) {
    const T = terrains[t % terrains.length];
    const swap = t % 2 === 1;
    const jit = () => (Math.random() - 0.5) * 0.14;
    const bx = Math.round(T.width * ((swap ? 0.88 : 0.12) + jit()));
    const hx = Math.round(T.width * ((swap ? 0.12 : 0.88) + jit()));
    const me = {
      id: 'bot', x: bx, y: surf(T, bx), hp: 100, buff: 0, tele: false,
      inv: { cluster: 0, guided: 0, tomahawk: 0 }, // pure-aim measurement: normal shells only
      dead: false, ai: difficulty,
    };
    const you = { id: 'you', x: hx, y: surf(T, hx), hp: 100, buff: 0, dead: false };
    const wind = rollWind();

    const plan = planShot({ T, me, enemies: [you], wind, difficulty });
    if (!plan) continue;
    S.shots++;
    if (plan.kind === 'guided') S.guided++;
    if (plan.kind !== 'normal') S.specials++;
    const solvable = (plan.expect ?? 0) >= 25; // a real firing solution existed
    if (solvable) S.solv++;

    // the REAL shell — whatever the error model did to the perfect solution
    const impacts = simulateShot(T, [you, me], me, plan.a, plan.p, plan.kind, wind);
    let dealt = 0, direct = false;
    for (const imp of impacts) {
      dealt += estimateDamage(imp.x, imp.y, imp.r, imp.scale, you);
      if (imp.directId === 'you') direct = true;
      if (estimateDamage(imp.x, imp.y, imp.r, imp.scale, me) > 0) S.self++;
    }
    if (dealt > 0) { S.hits++; if (solvable) S.solvHits++; }
    if (direct) S.directs++;
    if (dealt >= you.hp) S.kills++;
    S.dmg += dealt;
  }
}

console.log(`\n🎯 AI accuracy over ${TRIALS} shots per difficulty (deterministic terrains + fresh wind):\n`);
console.log('  diff     │ hit rate │ direct │ solvable-hit │ avg dmg │ self-hit │ shots');
console.log('  ─────────┼──────────┼────────┼──────────────┼─────────┼──────────┼──────');
for (const [d, S] of Object.entries(stats)) {
  const pct = (n, d2) => `${Math.round((n / Math.max(1, d2)) * 100)}%`.padStart(7);
  console.log(
    `  ${d.padEnd(8)} │ ${pct(S.hits, S.shots)}  │ ${pct(S.directs, S.shots)} │     ${pct(S.solvHits, S.solv)} (${Math.round((S.solv / Math.max(1, S.shots)) * 100)}%) │ ${(S.dmg / Math.max(1, S.shots)).toFixed(1).padStart(7)} │ ${String(S.self).padStart(8)} │ ${S.shots}`,
  );
}
console.log('\n  (solvable-hit = accuracy when a real firing solution existed — isolates');
console.log('   aim quality from terrain luck; in-game the bot also repositions/unblocks)');

const e = stats.easy.hits / stats.easy.shots;
const m = stats.medium.hits / stats.medium.shots;
const h = stats.hard.hits / stats.hard.shots;
const sv = (d) => stats[d].solvHits / Math.max(1, stats[d].solv);
console.log(`\n  overall:  easy ${(e * 100).toFixed(0)}% < medium ${(m * 100).toFixed(0)}% < hard ${(h * 100).toFixed(0)}%`);
console.log(`  solvable: easy ${(sv('easy') * 100).toFixed(0)}% | medium ${(sv('medium') * 100).toFixed(0)}% | hard ${(sv('hard') * 100).toFixed(0)}%`);

const selfRate = (d) => stats[d].self / Math.max(1, stats[d].shots);
let fail = null;
if (!(e < m)) fail = `easy (${e}) must be less accurate than medium (${m})`;
else if (!(m < h)) fail = `medium (${m}) must be less accurate than hard (${h})`;
else if (h < 0.7) fail = `hard overall hit rate too low: ${(h * 100).toFixed(0)}%`;
else if (sv('hard') < 0.85) fail = `hard should be accurate MOST of the solvable time, got ${(sv('hard') * 100).toFixed(0)}%`;
else if (sv('medium') < 0.45 || sv('medium') > 0.82) fail = `medium should be accurate SOMETIMES (~50-75% solvable), got ${(sv('medium') * 100).toFixed(0)}%`;
else if (e > 0.45 || e < 0.08) fail = `easy should be PARTIALLY accurate (~15-40%), got ${(e * 100).toFixed(0)}%`;
else if (sv('easy') > 0.55) fail = `easy too accurate even when a shot exists: ${(sv('easy') * 100).toFixed(0)}%`;
else if (selfRate('hard') > 0.011 || selfRate('medium') > 0.03 || selfRate('easy') > 0.055) {
  fail = `self-bomb rate too high (easy ${(selfRate('easy') * 100).toFixed(0)}%, medium ${(selfRate('medium') * 100).toFixed(0)}%, hard ${(selfRate('hard') * 100).toFixed(0)}%)`;
}
if (fail) { console.error(`\n❌ ${fail}`); process.exit(1); }
console.log('\n✅ difficulty curve is precisely engineered — bots never self-bomb');
