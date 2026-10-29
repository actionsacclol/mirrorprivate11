// Small statistics the scout's self-scoring needs (2026-10-25, P1 of
// docs/wallet-scout-research-2026-10-25.md). Pure functions, no imports, so
// the renderer and the main process compute the same figure from the same
// numbers. Each one returns null where there is nothing to measure — a
// median of nothing is not 0, and a rank correlation over two wallets is not
// a correlation.

/** The sample median; null for an empty list. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** A quantile of an ASCENDING list by linear interpolation; null when empty. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = Math.min(sorted.length - 1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The interquartile range; null under four values (a quartile of three is a guess). */
export function iqr(xs: readonly number[]): number | null {
  if (xs.length < 4) return null;
  const v = [...xs].sort((a, b) => a - b);
  return (quantile(v, 0.75) as number) - (quantile(v, 0.25) as number);
}

export function mean(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** The sample standard deviation (n − 1); null under two values. */
export function stdDev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** The mean with the lowest and highest `share` of values DROPPED (the
 *  1 %-trimmed mean of the pre-registered test). Null when nothing is left. */
export function trimmedMean(xs: readonly number[], share: number): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const k = Math.floor(v.length * share);
  const kept = v.slice(k, v.length - k);
  return kept.length ? mean(kept) : mean(v);
}

/** mulberry32: a small seeded generator, so a draw is repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, a seed for mulberry32. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Average ranks, 1-based, ties sharing their mean rank. */
function ranks(xs: readonly number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman's rank correlation; null under three pairs or with no spread. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  const mx = (n + 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - mx);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - mx) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * A cluster bootstrap interval for the pooled median: the CLUSTERS (one per
 * wallet, or per coin) are resampled with replacement, their values pooled,
 * the median taken; `level` of the draws lie inside. Copies of one wallet
 * move together, so resampling copies would claim a precision nobody has.
 * Null under two clusters.
 */
export function bootstrapMedianCI(clusters: ReadonlyArray<readonly number[]>, draws: number, seed: number, level = 0.95): Interval | null {
  const groups = clusters.filter((g) => g.length > 0);
  if (groups.length < 2) return null;
  const next = mulberry32(seed);
  const meds: number[] = [];
  for (let d = 0; d < draws; d++) {
    const pool: number[] = [];
    for (let k = 0; k < groups.length; k++) pool.push(...groups[Math.floor(next() * groups.length)]);
    const m = median(pool);
    if (m !== null) meds.push(m);
  }
  if (meds.length < 10) return null;
  meds.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { lo: quantile(meds, tail) as number, hi: quantile(meds, 1 - tail) as number };
}

/** The difference of two pooled medians (a − b) with a cluster bootstrap
 *  interval; each side resampled over its own clusters. */
export function bootstrapMedianDiffCI(a: ReadonlyArray<readonly number[]>, b: ReadonlyArray<readonly number[]>, draws: number, seed: number, level = 0.9): (Interval & { diff: number }) | null {
  const ga = a.filter((g) => g.length > 0);
  const gb = b.filter((g) => g.length > 0);
  if (ga.length < 2 || gb.length < 2) return null;
  const ma = median(ga.flat());
  const mb = median(gb.flat());
  if (ma === null || mb === null) return null;
  const next = mulberry32(seed);
  const diffs: number[] = [];
  for (let d = 0; d < draws; d++) {
    const pa: number[] = [];
    for (let k = 0; k < ga.length; k++) pa.push(...ga[Math.floor(next() * ga.length)]);
    const pb: number[] = [];
    for (let k = 0; k < gb.length; k++) pb.push(...gb[Math.floor(next() * gb.length)]);
    const x = median(pa);
    const y = median(pb);
    if (x !== null && y !== null) diffs.push(x - y);
  }
  if (diffs.length < 10) return null;
  diffs.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return { diff: ma - mb, lo: quantile(diffs, tail) as number, hi: quantile(diffs, 1 - tail) as number };
}

/** Least squares y = intercept + slope·x; null under three points or no spread in x. */
export function linearFit(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number; n: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n)) as number;
  const my = mean(ys.slice(0, n)) as number;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

/**
 * The probability of backtest overfitting (Bailey, Borwein, López de Prado &
 * Zhu), by combinatorially symmetric cross-validation over the rows: every
 * split of the rows into two equal halves is a train/test pair; the variant
 * that did best in-sample is looked up out of sample, and PBO is the share
 * of splits where it landed in the bottom half there. Rows are periods
 * (weeks), columns are the variants tried, cells their performance (higher
 * is better; NaN = not measured, skipped in the mean). Null under four rows
 * or two variants; an odd row count drops its first (oldest) row.
 */
export function pbo(matrix: ReadonlyArray<readonly number[]>): { pbo: number; splits: number; rows: number; variants: number } | null {
  let rows = matrix.filter((r) => r.length > 0);
  if (rows.length % 2) rows = rows.slice(1);
  const T = rows.length;
  const N = rows[0]?.length ?? 0;
  if (T < 4 || N < 2 || rows.some((r) => r.length !== N)) return null;
  const perf = (idx: readonly number[], v: number): number => {
    let s = 0;
    let n = 0;
    for (const i of idx) {
      const x = rows[i][v];
      if (Number.isFinite(x)) {
        s += x;
        n += 1;
      }
    }
    return n ? s / n : -Infinity;
  };
  const half = T / 2;
  let splits = 0;
  let overfit = 0;
  // Every subset of size T/2 as the in-sample half (T ≤ 12 keeps this small).
  const pick: number[] = [];
  const walk = (start: number): void => {
    if (pick.length === half) {
      const inS = pick;
      const out: number[] = [];
      for (let i = 0; i < T; i++) if (!inS.includes(i)) out.push(i);
      let best = 0;
      for (let v = 1; v < N; v++) if (perf(inS, v) > perf(inS, best)) best = v;
      const oos = Array.from({ length: N }, (_, v) => perf(out, v));
      const below = oos.filter((x) => x < oos[best]).length;
      // Relative rank in (0, 1); the logit is negative below the median.
      const omega = (below + 1) / (N + 1);
      splits += 1;
      if (omega <= 0.5) overfit += 1;
      return;
    }
    for (let i = start; i < T; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return { pbo: overfit / splits, splits, rows: T, variants: N };
}
