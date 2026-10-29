// shared/stats.ts (2026-10-25, P1) — the small statistics the scorecard and
// the pre-registered test stand on. Pinned on hand-checkable numbers: a
// median of nothing is null, a rank correlation over two points is not one,
// a cluster bootstrap resamples wallets and not copies, and the probability
// of backtest overfitting is one for a variant that wins in sample by luck.

import assert from 'node:assert';
import { bootstrapMedianCI, bootstrapMedianDiffCI, hashSeed, iqr, linearFit, mean, median, mulberry32, pbo, quantile, spearman, stdDev, trimmedMean } from './.stats.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2, 'linear interpolation on the ascending list');
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(iqr([1, 2, 3]), null, 'a quartile of three is a guess');
  assert.equal(iqr([1, 2, 3, 4, 5, 6, 7, 8, 9]), 4);
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(stdDev([1]), null);
  assert.ok(Math.abs(stdDev([2, 4, 4, 4, 5, 5, 7, 9]) - Math.sqrt(32 / 7)) < 1e-12, 'n − 1');
  assert.equal(trimmedMean([1, 2, 3, 4, 100], 0.2), 3, 'the lowest and highest fifth dropped');
  assert.equal(trimmedMean([5], 0.5), 5, 'never an empty mean');
  ok('median, quantile, IQR, mean, standard deviation, trimmed mean');
}

{
  const a = mulberry32(7);
  const b = mulberry32(7);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()), 'the same seed, the same draws');
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
  ok('a seeded generator and a string seed');
}

{
  assert.equal(spearman([1, 2], [2, 1]), null, 'two pairs are not a correlation');
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([1, 2, 3], [5, 5, 5]), null, 'no spread, no correlation');
  // Ties share their mean rank: (1,1,2) against (1,2,3) → ranks (1.5,1.5,3) vs (1,2,3).
  const r = spearman([1, 1, 2], [1, 2, 3]);
  assert.ok(Math.abs(r - 0.866) < 0.001, `ties averaged: ${r}`);
  ok('Spearman with averaged ties, null where it cannot be measured');
}

{
  assert.equal(bootstrapMedianCI([[1, 2, 3]], 200, 1), null, 'one cluster is no interval');
  // Twenty wallets around −10 with one wild wallet: the interval covers the
  // pooled median and does not reach the wild wallet's figures.
  const clusters = Array.from({ length: 20 }, (_, k) => [-12 + (k % 5), -10 + (k % 3), -11]);
  clusters.push([300, 310, 320]);
  const ci = bootstrapMedianCI(clusters, 300, 42);
  assert.ok(ci && ci.lo <= -10 && ci.hi >= -11, `covers the pooled median: ${JSON.stringify(ci)}`);
  assert.ok(ci.hi < 0, 'resampling WALLETS: the wild one is one draw in twenty-one, not three copies in sixty-three');
  const again = bootstrapMedianCI(clusters, 300, 42);
  assert.deepEqual(again, ci, 'the same seed, the same interval');
  // Two selections five points apart with little spread: the difference's
  // interval excludes zero.
  const a = Array.from({ length: 15 }, (_, k) => [-5 + (k % 3), -5, -6 + (k % 2)]);
  const b = Array.from({ length: 15 }, (_, k) => [-10 + (k % 3), -10, -11 + (k % 2)]);
  const d = bootstrapMedianDiffCI(a, b, 300, 7);
  assert.ok(d && Math.abs(d.diff - 5) <= 1, `diff ${d && d.diff}`);
  assert.ok(d.lo > 0, `the interval excludes zero: ${d.lo}..${d.hi}`);
  ok('cluster bootstrap intervals for a median and for a difference of medians');
}

{
  assert.equal(linearFit([1, 2], [1, 2]), null);
  assert.equal(linearFit([2, 2, 2], [1, 2, 3]), null, 'no spread in x');
  const f = linearFit([1, 2, 3, 4], [3, 5, 7, 9]);
  assert.ok(Math.abs(f.slope - 2) < 1e-12 && Math.abs(f.intercept - 1) < 1e-12 && f.n === 4);
  ok('least squares');
}

{
  assert.equal(pbo([[1, 2], [2, 1]]), null, 'under four periods');
  assert.equal(pbo([[1], [2], [3], [4]]), null, 'one variant cannot overfit against itself');
  // A variant that is best in every period: never overfit.
  const steady = Array.from({ length: 6 }, (_, t) => [1 + t * 0.01, 0, -1]);
  assert.equal(pbo(steady).pbo, 0, 'a variant that wins every period is not a fit to its past');
  // Six periods, three variants, each variant the best in two periods and the
  // worst in the others: whichever wins in sample loses out of sample.
  const rot = [
    [10, 0, -10],
    [10, 0, -10],
    [-10, 10, 0],
    [-10, 10, 0],
    [0, -10, 10],
    [0, -10, 10],
  ];
  const p = pbo(rot);
  assert.equal(p.rows, 6);
  assert.equal(p.variants, 3);
  assert.equal(p.splits, 20, 'every split of six into two threes');
  assert.ok(p.pbo >= 0.5, `rotating winners overfit: ${p.pbo}`);
  const odd = pbo([[9, 9, 9], ...rot]);
  assert.equal(odd.rows, 6, 'an odd row count drops the oldest row');
  const nan = pbo(rot.map((r, i) => (i === 0 ? [NaN, 0, -10] : r)));
  assert.ok(nan && Number.isFinite(nan.pbo), 'an unmeasured cell is skipped, not poison');
  ok('the probability of backtest overfitting by symmetric cross-validation');
}

console.log(`\nstats: ${passed}/${passed} passed`);
