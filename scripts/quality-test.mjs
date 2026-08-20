/**
 * 🎚️ QualityGovernor unit test - deterministic synthetic frame times, no browser:
 *   1. auto mode starts High on a capable device
 *   2. two consecutive slow windows (median > 22ms) demote to Low
 *   3. ~6s sustained fast (< 12ms) promotes back to High
 *   4. the 4s switch cooldown stops flap
 *   5. manual override pins the tier and ignores samples; persistence is safe
 *      without localStorage
 * Run: node scripts/quality-test.mjs
 */
import { QualityGovernor, TIERS, guessTier } from '../lib/quality.mjs';

let failed = false;
const ok = (m) => console.log('✅ ' + m);
const fail = (m) => { console.error('❌ ' + m); failed = true; };
const eq = (got, want, label) => (got === want ? ok(`${label} (${got})`) : fail(`${label}: got ${got}, want ${want}`));

// ── 1) auto starts High on capable hardware (node: no navigator hints) ──
const g = new QualityGovernor();
eq(g.mode, 'auto', 'default mode');
eq(g.tier, 'high', 'auto starts high');
eq(g.knobs.dprCap, TIERS.high.dprCap, 'high knobs resolve');

// ── 2) two slow windows demote (past the load-immunity cooldown) ──
let t = 0;
const frames = (ms, n, step = 16.6) => { for (let i = 0; i < n; i++) g.sample(ms, (t += step)); };
frames(25, 180); // 2 hot windows but t < 4000 → load immunity, no demotion
eq(g.tier, 'high', 'hot windows during the first 4s are load immunity');
frames(25, 90); // hot window 1 that counts
eq(g.tier, 'high', 'one hot window is not enough');
frames(25, 90); // hot window 2 → demote
eq(g.tier, 'low', 'two consecutive hot windows demote to low');
eq(g.knobs.particleCap, TIERS.low.particleCap, 'low knobs resolve');

// ── 3) fast frames promote back, but only after ~6s sustained + cooldown ──
const tBefore = t;
while (g.tier !== 'high' && t - tBefore < 30000) frames(8, 90, 10);
eq(g.tier, 'high', 'sustained fast frames promote back to high');
const promoteAfter = ((t - tBefore) / 1000).toFixed(1);
if (t - tBefore < 5900) fail(`promoted too eagerly (${promoteAfter}s < 6s sustained)`);
else ok(`promotion took ${promoteAfter}s of sustained fast frames (≥6s + switch cooldown)`);

// ── 4) median, not mean: a few 80ms spikes in a 10ms window must NOT demote ──
frames(10, 44); for (let i = 0; i < 2; i++) g.sample(80, (t += 16.6)); frames(10, 44);
frames(10, 44); for (let i = 0; i < 2; i++) g.sample(80, (t += 16.6)); frames(10, 44);
eq(g.tier, 'high', 'occasional spikes do not demote (median window)');

// ── 5) manual override pins the tier; samples ignored; persistence safe ──
eq(g.cycleMode(), 'high', 'cycle auto → high');
frames(40, 200); // brutal frames
eq(g.tier, 'high', 'manual high ignores slow frames');
eq(g.cycleMode(), 'low', 'cycle high → low');
eq(g.tier, 'low', 'manual low applies immediately');
frames(4, 200); // dreamy frames
eq(g.tier, 'low', 'manual low ignores fast frames');
eq(g.cycleMode(), 'auto', 'cycle low → auto');

console.log(failed ? '\n💥 quality governor test FAILED' : '\n🎉 quality governor passed - demote, promote, cooldown, median, pin');
process.exit(failed ? 1 : 0);
