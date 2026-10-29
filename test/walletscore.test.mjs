// The Copy score (shared/walletScore.ts) — a Krypt score for wallets.
//
// Built on docs/wallet-convergence-2026-09-14.md: ranking by what a FOLLOWER
// realises (both legs at a lag, net of cost) persists and halves the loss of
// ranking by the wallet's own PnL, but no decile is positive. So the score
// ranks least-bad to follow and the mappings say so: the tape-wide best
// (~−3 % per trip) scores in the middle, never at the top. Pinned here:
// honest-null gates, monotone ramps, the follower return arithmetic, flags.

import assert from 'node:assert';
import {
  DEFAULT_SHRINK_PRIOR,
  FOLLOWER_COST_PER_SIDE,
  FOLLOWER_LAG_MS,
  LCB_Z,
  PRIOR_MIN_WALLETS,
  RELIABLE_COPIES,
  SCORE_MIN_F_TRIPS,
  SCORE_MIN_RESOLVED,
  SCORE_MIN_TRIPS,
  SHRINK_K_MAX,
  SHRINK_K_MIN,
  estimatePrior,
  followerNetReturnPct,
  priorMuFor,
  ramp,
  scoreTone,
  scoreWallet,
  shrinkWith,
  shrunkMedian,
  styleBucket,
} from './.walletscore.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const base = {
  roundTrips: 20,
  fTrips: 16,
  fMedianReturnPct: -3,
  fWinRatePct: 45,
  reachablePct: 80,
  judgedTrips: 20,
  activeDays: 5,
  windowDays: 7,
  distinctMints: 20,
  looksAutomated: false,
};

{
  assert.equal(FOLLOWER_LAG_MS, 2_000, 'the lag is what the app\'s copier actually gets, not an in-house bot\'s 800 ms');
  assert.equal(FOLLOWER_COST_PER_SIDE, 0.015, 'venue 1 % + Krypt 0.5 % per side');
  // Buy 1, sell 1: costs on both legs, ~−3 %.
  const flat = followerNetReturnPct(1, 1);
  assert.ok(flat < -2.9 && flat > -3.0, `a flat round trip loses the costs: ${flat}`);
  // Doubling nets ~+94 %.
  const dbl = followerNetReturnPct(1, 2);
  assert.ok(dbl > 93 && dbl < 95, `a double nets about +94 %: ${dbl}`);
  assert.equal(followerNetReturnPct(0, 1), null, 'no entry price is no return');
  assert.equal(followerNetReturnPct(1, NaN), null);
  ok('the follower return arithmetic: both legs pay, a flat trip loses');
}

{
  assert.equal(ramp(-100, [[-25, 0], [0, 75]]), 0, 'clamped below');
  assert.equal(ramp(100, [[-25, 0], [0, 75]]), 75, 'clamped above');
  assert.equal(ramp(-12.5, [[-25, 0], [0, 75]]), 37.5, 'linear between');
  assert.equal(ramp(-3, [[-25, 0], [-10, 35], [-3, 60], [0, 75], [10, 100]]), 60, 'the tape-wide best sits in the middle, not the top');
  ok('ramps are piecewise-linear and clamped');
}

{
  const s = scoreWallet(base);
  assert.ok(typeof s.score === 'number', 'a full record scores');
  assert.equal(s.total, 5);
  assert.equal(s.resolved, 5);
  const by = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(by.followerReturn.weight, 3, 'follower return carries the most weight');
  assert.equal(by.followerReturn.points, 60, '−3 % median is the middle of the scale');
  assert.equal(by.followerWin.points, 60, '45 % follower win rate is the tape-wide best, mid-scale');
  assert.equal(by.reachable.points, 88, '80 % reachable: 50 + 30/40 of the last 50 points');
  assert.equal(by.consistency.value, '5 of 7');
  assert.equal(by.focus.points, 100, '20 trips over 20 coins is spread out');
  assert.deepEqual(s.flags, []);
  ok('a real record: every check resolved, weights as designed');
}

{
  const thin = scoreWallet({ ...base, roundTrips: 4, fTrips: 4 });
  assert.equal(thin.score, null, `under ${SCORE_MIN_TRIPS} trips there is no score`);
  assert.ok(thin.flags.includes('thin'));
  const unmeasured = scoreWallet({ ...base, fTrips: 2, fMedianReturnPct: null, fWinRatePct: null, windowDays: null });
  // reachable + focus resolve; follower return, win and consistency do not.
  assert.equal(unmeasured.resolved, 2);
  assert.equal(unmeasured.score, null, `under ${SCORE_MIN_RESOLVED} resolved checks there is no score`);
  // Nine copied trips: the follower return is not resolved, so no score at
  // all, however the other checks look (2026-10-22).
  const nine = scoreWallet({ ...base, fTrips: 9 });
  assert.equal(nine.checks.find((c) => c.id === 'followerReturn').resolved, false);
  assert.equal(nine.score, null, 'under SCORE_MIN_F_TRIPS copied trips there is no score');
  const dayWindow = scoreWallet({ ...base, windowDays: null });
  assert.equal(dayWindow.checks.find((c) => c.id === 'consistency').resolved, false, 'consistency means nothing over one day');
  assert.ok(typeof dayWindow.score === 'number', 'but the other four still score');
  ok('honest null: thin records and unmeasured checks never become a number');
}

{
  const better = scoreWallet({ ...base, fMedianReturnPct: 2, fWinRatePct: 55, reachablePct: 95 });
  const worse = scoreWallet({ ...base, fMedianReturnPct: -15, fWinRatePct: 30, reachablePct: 40 });
  assert.ok(better.score > scoreWallet(base).score && scoreWallet(base).score > worse.score, 'monotone in the follower figures');
  const insider = scoreWallet({ ...base, roundTrips: 40, distinctMints: 4 });
  assert.ok(insider.flags.includes('concentrated'), 'ten trips per coin is a relationship, flagged');
  assert.ok(insider.score < scoreWallet({ ...base, roundTrips: 40, distinctMints: 30 }).score);
  const unjudged = scoreWallet({ ...base, judgedTrips: 0, reachablePct: null, fTrips: 0, fMedianReturnPct: null, fWinRatePct: null });
  assert.equal(unjudged.checks.find((c) => c.id === 'reachable').resolved, false, 'a record from before the model is not judged unreachable');
  assert.ok(!unjudged.flags.includes('unreachable'));
  const bot = scoreWallet({ ...base, looksAutomated: true, reachablePct: 5, fTrips: 1, fMedianReturnPct: null, fWinRatePct: null });
  assert.ok(bot.flags.includes('bot') && bot.flags.includes('unreachable'));
  assert.equal(bot.checks.find((c) => c.id === 'reachable').points, 5, 'a sniper\'s trips are not reachable');
  ok('better follower outcomes score higher; insiders and bots are flagged');
}

{
  // Twelve: a score needs SCORE_MIN_F_TRIPS (10) copied trips since 2026-10-22.
  const slice = scoreWallet({ ...base, roundTrips: 1_352, judgedTrips: 12, fTrips: 12, distinctMints: 3 });
  assert.ok(slice.flags.includes('partial'), 'twelve judged of 1,352 is a slice, and says so');
  assert.ok(slice.flags.includes('concentrated'));
  assert.ok(typeof slice.score === 'number', 'the number still stands');
  assert.ok(!scoreWallet(base).flags.includes('partial'), '20 judged of 20 is the whole record');
  assert.equal(scoreTone(null), null, 'no score is no colour');
  assert.equal(scoreTone(70), 'good');
  assert.equal(scoreTone(40), 'mid');
  assert.equal(scoreTone(39), 'bad');
  ok('score tones');
}

{
  // Empirical Bayes (2026-10-25, P1): the prior measured from the week's own
  // universe by the method of moments, and the constants only under
  // PRIOR_MIN_WALLETS wallets to measure from.
  const few = estimatePrior(Array.from({ length: PRIOR_MIN_WALLETS - 1 }, () => ({ returns: Array(12).fill(-5) })), 7);
  assert.deepEqual([few.muPct, few.k, few.wallets, few.at, few.sigmaPct, few.tauPct], [DEFAULT_SHRINK_PRIOR.muPct, DEFAULT_SHRINK_PRIOR.k, PRIOR_MIN_WALLETS - 1, 7, null, null], 'too few: the fixed figures, and how many there were');
  const thin = estimatePrior(Array.from({ length: 40 }, () => ({ returns: Array(SCORE_MIN_F_TRIPS - 1).fill(-5) })), 7);
  assert.equal(thin.wallets, 0, 'a wallet under ten copies does not count toward the prior either');
  // Twenty copies per wallet: the median exactly `med`, the IQR about 1.08·spread.
  const mk = (med, spread, traits = {}) => ({ returns: Array.from({ length: 20 }, (_, i) => med + (spread * ((i % 7) - 3)) / 3), ...traits });
  // Wallets far apart with tight copies: the data are believable one by one, k small.
  const wide = estimatePrior(Array.from({ length: 40 }, (_, i) => mk(-40 + i * 2, 6, { medianHoldMs: [30_000, 100_000, 400_000][i % 3], medianFirstBuy: [0.01, 0.1, 1][i % 3] })), 1);
  assert.equal(wide.wallets, 40);
  assert.ok(Math.abs(wide.muPct - -1) < 1e-9, `μ is the median of the wallets' medians: ${wide.muPct}`);
  assert.ok(wide.sigmaPct > 5 && wide.sigmaPct < 7, `σ from the IQRs: ${wide.sigmaPct}`);
  assert.ok(wide.tauPct > 20, `τ from the spread of the medians: ${wide.tauPct}`);
  assert.equal(wide.k, SHRINK_K_MIN, `little shrinkage, clamped at the floor: ${wide.k}`);
  // Wallets alike with noisy copies: the medians are mostly noise, k at the ceiling.
  const alike = estimatePrior(Array.from({ length: 40 }, (_, i) => mk(-15 + (i % 3) * 0.5, 60)), 1);
  assert.equal(alike.k, SHRINK_K_MAX, `heavy shrinkage: ${alike.k}`);
  assert.ok(alike.sigmaPct > 50);
  // Style buckets: hold tercile × first-buy tercile, only where measured.
  assert.ok(wide.holdCuts && wide.sizeCuts, 'cuts from the measured traits');
  assert.equal(Object.keys(wide.buckets).length, 3, 'three diagonal buckets of thirteen');
  assert.equal(styleBucket(30_000, 0.01, wide), 'h0s0');
  assert.equal(styleBucket(400_000, 1, wide), 'h2s2');
  assert.equal(styleBucket(null, 1, wide), null, 'an unmeasured trait has no bucket');
  assert.equal(styleBucket(30_000, 0.01, alike), null, 'a prior without cuts has none');
  assert.equal(styleBucket(30_000, 0.01, DEFAULT_SHRINK_PRIOR), null);
  // The bucket's location, itself pulled toward the population by ten wallets' worth.
  const b = wide.buckets.h0s0;
  assert.ok(Math.abs(priorMuFor(wide, 'h0s0') - (b.wallets * b.muPct + 10 * wide.muPct) / (b.wallets + 10)) < 1e-9);
  assert.equal(priorMuFor(wide, 'h9s9'), wide.muPct, 'an unknown bucket is the population');
  assert.equal(priorMuFor(wide, null), wide.muPct);
  ok('the prior is measured from the universe: μ, σ, τ, k clamped, style buckets where the traits are');
}

{
  // Shrinkage under a prior, and the lower bound the board ranks on.
  const p = { muPct: -10, k: 20, sigmaPct: 40, tauPct: 9, wallets: 50, at: 1 };
  const s = shrinkWith(5, 10, p);
  assert.ok(Math.abs(s.shrunk - shrunkMedian(5, 10, -10, 20)) < 1e-12, 'the posterior mean is the old formula with the measured k and μ');
  assert.ok(Math.abs(s.se - 40 / Math.sqrt(30)) < 1e-12, 'σ ÷ √(n + k)');
  assert.ok(Math.abs(s.lower - (s.shrunk - LCB_Z * s.se)) < 1e-12);
  assert.ok(s.lower < s.shrunk);
  const many = shrinkWith(5, RELIABLE_COPIES, p);
  assert.ok(many.shrunk > s.shrunk, 'more copies: closer to the wallet’s own median');
  assert.ok(many.shrunk - many.lower < s.shrunk - s.lower, 'and a tighter bound');
  assert.ok(many.shrunk - many.lower < 4, `at ${RELIABLE_COPIES} copies the bound is within a few points: ${many.shrunk - many.lower}`);
  // Two wallets at the same median: the one with more copies ranks higher on the bound.
  assert.ok(shrinkWith(0, 30, p).lower > shrinkWith(0, 10, p).lower);
  // A lucky thin record against a steady longer one.
  assert.ok(shrinkWith(-2, 60, p).lower > shrinkWith(8, 10, p).lower, 'sixty copies at −2 outrank ten at +8');
  // The default prior has no σ: the assumed per-copy spread stands in.
  const d = shrinkWith(0, 10, DEFAULT_SHRINK_PRIOR);
  assert.ok(Math.abs(d.se - 35 / Math.sqrt(20)) < 1e-12);
  // Buckets move the location.
  const bp = { ...p, holdCuts: [1, 2], sizeCuts: [1, 2], buckets: { h0s0: { muPct: 5, wallets: 10 } } };
  assert.ok(shrinkWith(0, 10, bp, 'h0s0').shrunk > shrinkWith(0, 10, bp, null).shrunk, 'a wallet in a better bucket is pulled toward its bucket');
  assert.equal(LCB_Z, 0.84);
  ok('the lower bound: shrunk − 0.84·σ/√(n + k); more copies, a higher and tighter bound');
}

console.log(`\nwalletscore: ${passed}/${passed} passed`);
