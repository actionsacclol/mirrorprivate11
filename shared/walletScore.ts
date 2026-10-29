// The Copy score — a Krypt score for WALLETS (2026-09-20).
//
// The coin score asks "would I be safe buying this?" and averages the checks
// that resolved. This asks the one question the Scout exists for: "if I had
// mirrored this wallet, what would I have got?" — and it is built on the
// finding that decides everything about it (docs/wallet-convergence-2026-09-14.md):
//
//   * Top wallets are real and their edge persists day to day. But ranking
//     them by THEIR OWN PnL selects for snipers whose median hold is six
//     seconds — the wallets a follower cannot be inside. Their edge is
//     latency, which is the one thing a copy cannot copy.
//   * Ranking by what a FOLLOWER realises — entering at the first print after
//     a lag, exiting the same way, net of cost — persists monotonically
//     across all ten deciles in two periods six weeks apart, and halves the
//     loss of the naive ranking. It does not reach profit: no decile was
//     positive; the best lost ~1–3 % per copied trade after costs.
//
// So every input here is what a follower would have realised, measured from
// the prints the feed actually saw, not what the wallet made. The score
// ranks LEAST-BAD TO FOLLOW. It is never an edge and the UI must not call
// it one. Honest-null throughout: a check that could not be measured is not
// counted, and under three resolved checks — or five closed trips — there
// is no score at all.

/**
 * The lag a follower fills at, on both legs. The app's own copier measured
 * ~1.4 s from a leader's print to a landed order on top of feed latency;
 * two seconds is what it actually gets, not the 800 ms an in-house bot might.
 */
export const FOLLOWER_LAG_MS = 2_000;
/** No print on the mint for this long after a leg was due: the leg is
 *  settled at the last mark (the coin stopped trading, and a copy would have
 *  met the price it stopped at). Before 2026-10-23 such a trip was dropped as
 *  unreachable, which flattered wallets that ride coins to zero. */
export const FOLLOWER_FILL_STALE_MS = 10 * 60_000;
/** Cost per side a follower pays on pump: the venue's 1 % plus Krypt's 0.5 %.
 *  Slippage is NOT modelled — the score is optimistic by that much, and the
 *  drawer says so. */
export const FOLLOWER_COST_PER_SIDE = 0.015;

// ── One cost model with paper (2026-10-22) ─────────────────────────────
//
// The Scout RECORDS a follower's return with FOLLOWER_COST_PER_SIDE (1.5 %
// a side, no fixed fees) — that is what every saved record holds, and it is
// never rewritten. It is REPRICED when read, with the paper model's own
// numbers (shared/copytrade.ts): pump's ~1.25 % curve fee plus Krypt's fee a
// side, and the fast lane's fixed fees at the copy size the user picked —
// about 7 % of a 0.05 SOL copy. Before this the board said "+0.9 % per trade"
// for a wallet the paper record of the same trades put near −6.6 %.
//
// The Copy score is built WITHOUT the fixed fees, so a wallet scores the same
// at every size: the fees are the same subtraction from every wallet's
// trades, and a score that moved with the size picker would read as the
// wallet changing. The figures shown beside it are at the size.

/** The price ratio (exit ÷ entry) behind a return recorded at 1.5 %/side. */
export function grossOfRecorded(recordedPct: number): number {
  return (1 + recordedPct / 100) * ((1 + FOLLOWER_COST_PER_SIDE) / (1 - FOLLOWER_COST_PER_SIDE));
}

export interface CopyCostModel {
  /** Fee per side as a fraction (venue + Krypt), the paper model's. */
  side: number;
  /** Fixed fees on a round trip as % of the copy; 0 when not modelled. */
  fixedPct: number;
  /** The copy size the fixed share is for, or null (score basis). */
  sizeSol: number | null;
}

/** A recorded follower return repriced under `m`, in %. Same formula as
 *  paperExitPnl ÷ cost for a whole trip. */
export function repriceReturn(recordedPct: number, m: CopyCostModel): number {
  const g = grossOfRecorded(recordedPct);
  return (g * (1 - m.side) - (1 + m.side)) * 100 - m.fixedPct;
}

/**
 * The fee floor (2026-10-23): what a copy that goes NOWHERE returns at this
 * cost model — the price unchanged from entry to exit, so only the swap fees
 * each way and the fixed network fees. −10.5 % at 0.05 SOL and −7.0 % at
 * 0.1 SOL on pump (own price impact adds ~0.3–0.7 points). The best decile of
 * wallets on the tape tested at about this level: the ranking finds wallets
 * whose copies lose little beyond their fees, not wallets that make money.
 */
export function feeFloorPct(m: Pick<CopyCostModel, 'side' | 'fixedPct'>): number {
  return ((1 - m.side) - (1 + m.side)) * 100 - m.fixedPct;
}

/**
 * The prior a thin record is pulled toward: the median of per-wallet follower
 * medians, every wallet with five or more copied trips, 2 s lag, recorded
 * (1.5 %/side) model, under the fill rule above. −15.5 % on the 09-16 tape
 * (measured 2026-10-23, 10,901 wallets); −18.2 / −19.5 / −19.0 / −18.0 % on
 * 09-10, 09-11, 07-26, 07-27. The −9.9 % this replaced could not be
 * reproduced from the app's own rule (the old rule gives −16.0 % on the same
 * tape) and sat well above the population, which pulled thin, lucky records
 * UP the ranking. Replay: docs/copy-trader-swarm-2026-10-23.md.
 */
export const RECORDED_POPULATION_MEDIAN_PCT = -15.5;
/** How many trips the prior counts as. 10: on the tape, the shrunk median's
 *  top decile was the least-bad selection of a dozen tried (−4.7 % against
 *  the Copy score's −6.5 % and a −9.9 % baseline). */
export const SHRINK_TRIPS = 10;
/** Copied trips before a wallet is ranked on its follower result at all:
 *  split-half reliability flattened at 8–10 trips on the tape. */
export const SCORE_MIN_F_TRIPS = 10;

/** The median pulled toward the population by its sample size:
 *  (n·median + k·prior) ÷ (n + k). */
export function shrunkMedian(median: number, n: number, prior: number, k = SHRINK_TRIPS): number {
  return (n * median + k * prior) / (n + k);
}

// ── Empirical Bayes, measured weekly (2026-10-25, P1) ───────────────────
//
// The formula above is a normal–normal posterior mean in disguise: with σ²
// the per-copy variance that matters for a median and τ² the spread of the
// wallets' TRUE medians, the weight on the prior is k = σ²/τ². Ten was a
// fit to one tape, and the prior moved −15.5 → −19.5 across five. Both are
// now estimated from the week's own universe (estimatePrior) and fall back
// to the constants only when the universe is too small to measure them
// (docs/wallet-scout-research-2026-10-25.md, "Ranking and shrinkage").
//
// And the board RANKS on a lower bound, not the posterior mean: the top of
// a raw ranking is where the luckiest small samples land (decile 9 beat
// decile 10 on three tapes), and a lower confidence bound is what penalises
// exactly that — pessimistic selection, because the user bears every loss.

export interface ShrinkPrior {
  /** The population location a thin record is pulled toward (recorded
   *  1.5 %/side model, %): the median of per-wallet medians. */
  muPct: number;
  /** Copies the prior counts as, σ²/τ², inside [SHRINK_K_MIN, SHRINK_K_MAX]. */
  k: number;
  /** Pooled per-copy spread that drives a median's error, points; null
   *  when not measured (the default prior). */
  sigmaPct: number | null;
  /** Spread of the wallets' true medians, points; null when not measured. */
  tauPct: number | null;
  /** Wallets it was measured from; 0 = the fixed default. */
  wallets: number;
  /** When it was measured, ms; 0 for the default. */
  at: number;
  /** Style buckets (hold tercile × first-buy tercile): each bucket's own
   *  median of medians, for the two-level prior. Absent when unmeasured. */
  holdCuts?: [number, number];
  sizeCuts?: [number, number];
  buckets?: Record<string, { muPct: number; wallets: number }>;
}

export const SHRINK_K_MIN = 5;
/** σ 40 with τ 5 gives 64: "shrink nearly everything" is as far as it goes. */
export const SHRINK_K_MAX = 64;
/** Wallets with SCORE_MIN_F_TRIPS copies under which the universe cannot
 *  measure its own prior and the constants stand. */
export const PRIOR_MIN_WALLETS = 30;
/** The lower bound's z: 0.84 is the one-sided 80 % bound (0.84–1.28 is the
 *  range the research names; the smaller end, because the universe is a few
 *  hundred wallets and 1.28 would empty the board most weeks). */
export const LCB_Z = 0.84;
/** SE of a sample median ≈ MEDIAN_SE_IQR · IQR ÷ √n under a logistic shape
 *  (f(m) = 1/(4s), IQR = 2s·ln 3 → SE = 2s/√n = 0.91·IQR/√n). */
export const MEDIAN_SE_IQR = 0.91;
/** Per-copy spread assumed for the bound when none is measured: the middle
 *  of the 30–40 points the research calls plausible. */
export const DEFAULT_SIGMA_PCT = 35;
/** τ is floored here so a universe that happens to agree does not make k
 *  infinite and every wallet the prior. */
export const TAU_FLOOR_PCT = 2;
/** A style bucket needs this many wallets to have its own location… */
export const BUCKET_MIN_WALLETS = 5;
/** …and is itself shrunk toward the population as if it were this many. */
export const BUCKET_PRIOR_WALLETS = 10;
/** Copies before a wallet's own median is its own evidence: at an IQR of
 *  60–70 points the median's SE is ~10 at n = 10 and ~3.5 at n = 80. */
export const RELIABLE_COPIES = 80;

export const DEFAULT_SHRINK_PRIOR: ShrinkPrior = { muPct: RECORDED_POPULATION_MEDIAN_PCT, k: SHRINK_TRIPS, sigmaPct: null, tauPct: null, wallets: 0, at: 0 };

/** One wallet's week, as the prior sees it. */
export interface PriorWallet {
  /** Recorded follower returns (1.5 %/side), one per copied trip. */
  returns: readonly number[];
  medianHoldMs?: number | null;
  medianFirstBuy?: number | null;
}

function sortedCopy(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}
function medianOfSorted(v: readonly number[]): number {
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function quantileOfSorted(v: readonly number[], q: number): number {
  const pos = q * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
/** Tercile cuts of a list, or null under six values. */
function terciles(xs: readonly number[]): [number, number] | null {
  if (xs.length < 6) return null;
  const v = sortedCopy(xs);
  return [quantileOfSorted(v, 1 / 3), quantileOfSorted(v, 2 / 3)];
}

/** Which style bucket a wallet is in, given the prior's cuts; null when the
 *  prior has none or the wallet's traits are unmeasured. */
export function styleBucket(medianHoldMs: number | null | undefined, medianFirstBuy: number | null | undefined, prior: ShrinkPrior): string | null {
  if (!prior.holdCuts || !prior.sizeCuts || medianHoldMs == null || medianFirstBuy == null) return null;
  const t = (x: number, cuts: [number, number]): number => (x <= cuts[0] ? 0 : x <= cuts[1] ? 1 : 2);
  return `h${t(medianHoldMs, prior.holdCuts)}s${t(medianFirstBuy, prior.sizeCuts)}`;
}

/**
 * The week's prior from its universe, by the method of moments: μ̂ is the
 * median of the wallets' medians; σ̂² the pooled per-copy variance that
 * matters for a median (MEDIAN_SE_IQR · IQR, squared, averaged); τ̂² the
 * variance of the medians less the sampling share σ̂²·mean(1/nᵢ), floored;
 * k = σ̂²/τ̂² clamped. Under PRIOR_MIN_WALLETS eligible wallets the default
 * prior is returned with the count, so the caller can say why.
 */
export function estimatePrior(wallets: readonly PriorWallet[], at = 0): ShrinkPrior {
  const eligible = wallets.filter((w) => w.returns.length >= SCORE_MIN_F_TRIPS);
  if (eligible.length < PRIOR_MIN_WALLETS) return { ...DEFAULT_SHRINK_PRIOR, at, wallets: eligible.length };
  const meds: number[] = [];
  let sig2 = 0;
  let invN = 0;
  for (const w of eligible) {
    const v = sortedCopy(w.returns);
    meds.push(medianOfSorted(v));
    const spread = MEDIAN_SE_IQR * (quantileOfSorted(v, 0.75) - quantileOfSorted(v, 0.25));
    sig2 += spread * spread;
    invN += 1 / v.length;
  }
  const n = eligible.length;
  // A floor on σ: a wallet whose copies all sit at the fee floor has an IQR
  // of 0, and a universe of them would claim every median exact.
  const sigma = Math.max(5, Math.sqrt(sig2 / n));
  const mu = medianOfSorted(sortedCopy(meds));
  const mean = meds.reduce((a, b) => a + b, 0) / n;
  const varMed = meds.reduce((a, m) => a + (m - mean) * (m - mean), 0) / (n - 1);
  const tau = Math.max(TAU_FLOOR_PCT, Math.sqrt(Math.max(0, varMed - (sigma * sigma * invN) / n)));
  const k = Math.min(SHRINK_K_MAX, Math.max(SHRINK_K_MIN, (sigma * sigma) / (tau * tau)));
  const out: ShrinkPrior = { muPct: mu, k, sigmaPct: sigma, tauPct: tau, wallets: n, at };
  // Style buckets, where the traits are measured for enough of the universe.
  const holdCuts = terciles(eligible.map((w) => w.medianHoldMs).filter((x): x is number => typeof x === 'number'));
  const sizeCuts = terciles(eligible.map((w) => w.medianFirstBuy).filter((x): x is number => typeof x === 'number'));
  if (holdCuts && sizeCuts) {
    out.holdCuts = holdCuts;
    out.sizeCuts = sizeCuts;
    const by = new Map<string, number[]>();
    eligible.forEach((w, i) => {
      const b = styleBucket(w.medianHoldMs, w.medianFirstBuy, out);
      if (b) by.set(b, [...(by.get(b) ?? []), meds[i]]);
    });
    const buckets: ShrinkPrior['buckets'] = {};
    for (const [b, ms] of by) if (ms.length >= BUCKET_MIN_WALLETS) buckets[b] = { muPct: medianOfSorted(sortedCopy(ms)), wallets: ms.length };
    if (Object.keys(buckets).length) out.buckets = buckets;
  }
  return out;
}

/** The location a wallet in `bucket` is pulled toward: its bucket's median
 *  of medians, itself pulled toward the population's by BUCKET_PRIOR_WALLETS. */
export function priorMuFor(prior: ShrinkPrior, bucket: string | null): number {
  const b = bucket ? prior.buckets?.[bucket] : undefined;
  if (!b) return prior.muPct;
  return (b.wallets * b.muPct + BUCKET_PRIOR_WALLETS * prior.muPct) / (b.wallets + BUCKET_PRIOR_WALLETS);
}

export interface Shrunk {
  /** The posterior mean: (n·median + k·μ) ÷ (n + k). */
  shrunk: number;
  /** Its standard error, σ ÷ √(n + k). */
  se: number;
  /** The lower bound the board ranks on: shrunk − LCB_Z · se. */
  lower: number;
}

/** Shrink a wallet's median (recorded model) under `prior`, in its units. */
export function shrinkWith(median: number, n: number, prior: ShrinkPrior, bucket: string | null = null, z = LCB_Z): Shrunk {
  const mu = priorMuFor(prior, bucket);
  const shrunk = shrunkMedian(median, n, mu, prior.k);
  const se = (prior.sigmaPct ?? DEFAULT_SIGMA_PCT) / Math.sqrt(n + prior.k);
  return { shrunk, se, lower: shrunk - z * se };
}

/** The follower's net round-trip return, in %, buying at `entry` and selling
 *  at `exit` with the per-side cost on both legs. */
export function followerNetReturnPct(entryPrice: number, exitPrice: number, costPerSide = FOLLOWER_COST_PER_SIDE): number | null {
  if (!(entryPrice > 0) || !(exitPrice > 0) || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return null;
  const net = (exitPrice * (1 - costPerSide)) / (entryPrice * (1 + costPerSide)) - 1;
  return Number.isFinite(net) ? net * 100 : null;
}

/** Piecewise-linear map, clamped at the ends. Points must be x-ascending. */
export function ramp(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}

export type WalletFlag = 'bot' | 'thin' | 'unreachable' | 'concentrated' | 'partial';

/** Below this share of the window's trips judged, the copy figures describe
 *  a slice of the record, and the row says so. Records from before the
 *  model, and the first days after it, are mostly this. */
export const PARTIAL_COVERAGE = 0.5;

export interface WalletScoreInput {
  /** Closed round trips in the window (the wallet's own). */
  roundTrips: number;
  /** Trips a follower could have mirrored: both legs filled at the lag. */
  fTrips: number;
  /** The follower return the score is built on, %: the shrunk median under
   *  the paper model's swap fees, no fixed fees (2026-10-22). Null under the
   *  sample floor. */
  fMedianReturnPct: number | null;
  /** Share of follower trips that closed positive, %. */
  fWinRatePct: number | null;
  /** fTrips ÷ judged trips, %. Null when nothing has been judged. */
  reachablePct: number | null;
  /** Trips judged (filled or unreachable) — the reachable check resolves on
   *  these, so a record from before the model is not scored as unreachable. */
  judgedTrips: number;
  /** Days with at least one trade, and the window's span in days (null for
   *  a one-day window, where consistency means nothing). */
  activeDays: number;
  windowDays: number | null;
  /** Distinct mints traded (a floor once the record's cap is hit). */
  distinctMints: number;
  looksAutomated: boolean;
}

export interface WalletCheck {
  id: 'followerReturn' | 'followerWin' | 'reachable' | 'consistency' | 'focus';
  label: string;
  /** The measured figure as text, or an em dash. */
  value: string;
  /** 0..100 when resolved. */
  points: number | null;
  weight: number;
  resolved: boolean;
  /** One line a person can act on. */
  note: string;
}

export interface WalletScore {
  /** 0..100, or null: too few trips or too few checks resolved. */
  score: number | null;
  checks: WalletCheck[];
  resolved: number;
  total: number;
  flags: WalletFlag[];
}

/** Closed trips below which nothing here is a measurement. Matches the
 *  Scout's rank floor. */
export const SCORE_MIN_TRIPS = 5;
export const SCORE_MIN_RESOLVED = 3;

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}%`);

/**
 * Score a wallet over one window. Weighted average of the checks that
 * resolved; a check's weight is its bearing on "what would a copier get".
 *
 *   follower return  ×3   what the copy would have made, net, per trip
 *   follower win      ×2   how often it closed up
 *   reachable         ×2   how much of the record a copy could be inside
 *   consistency       ×1   trading across the window, not one lucky day
 *   focus             ×1   many mints once beats one mint many times
 */
export function scoreWallet(i: WalletScoreInput): WalletScore {
  const checks: WalletCheck[] = [];
  const enough = i.roundTrips >= SCORE_MIN_TRIPS;
  const fEnough = i.fTrips >= SCORE_MIN_TRIPS;

  // 1. Follower return — the median pulled toward the whole tape's by its
  //    sample size (2026-10-22), so five lucky trips cannot score 100. Needs
  //    SCORE_MIN_F_TRIPS copied trips. The least-bad tenth sat near −5 %;
  //    that is the middle of the scale, not the top.
  {
    const v = i.fTrips >= SCORE_MIN_F_TRIPS ? i.fMedianReturnPct : null;
    checks.push({
      id: 'followerReturn',
      label: 'Follower return',
      value: pct(v),
      points: v === null ? null : Math.round(ramp(v, [[-25, 0], [-10, 35], [-3, 60], [0, 75], [10, 100]])),
      weight: 3,
      resolved: v !== null,
      note:
        v === null
          ? `What a copier would have kept per trip. Needs ${SCORE_MIN_F_TRIPS} copied trips (has ${i.fTrips}).`
          : `Median net return per copied trip at a ${FOLLOWER_LAG_MS / 1000} s lag, swap fees on both legs, adjusted toward the whole market's by how few trips there are. Network fees are left out so the score is the same at any size; slippage is not modelled.`,
    });
  }
  // 2. Follower win rate.
  {
    const v = fEnough ? i.fWinRatePct : null;
    checks.push({
      id: 'followerWin',
      label: 'Follower win rate',
      value: pct(v),
      points: v === null ? null : Math.round(ramp(v, [[20, 0], [45, 60], [60, 100]])),
      weight: 2,
      resolved: v !== null,
      note: v === null ? 'Share of copied trips that closed up. Needs five follower-priced trips.' : 'Share of copied trips that closed up, net of costs. The tape-wide best is ~45 %.',
    });
  }
  // 3. Reachability — over the trips the model actually judged.
  {
    const v = enough && i.judgedTrips >= SCORE_MIN_TRIPS ? i.reachablePct : null;
    checks.push({
      id: 'reachable',
      label: 'Reachable trips',
      value: pct(v),
      points: v === null ? null : Math.round(ramp(v, [[0, 0], [50, 50], [90, 100]])),
      weight: 2,
      resolved: v !== null,
      note:
        v === null
          ? `Share of the wallet's trips a copy could have been inside. Needs ${SCORE_MIN_TRIPS} judged trips (has ${i.judgedTrips}).`
          : 'Share of the wallet\'s closed trips where a copy could fill both legs. The rest were over before a follower could land, or had no print to fill at.',
    });
  }
  // 4. Consistency — only when the window is wide enough to have days in it.
  {
    const span = i.windowDays !== null && i.windowDays >= 3 ? i.windowDays : null;
    const v = span !== null && enough ? Math.min(1, i.activeDays / span) : null;
    checks.push({
      id: 'consistency',
      label: 'Active days',
      value: span === null ? '—' : `${i.activeDays} of ${span}`,
      points: v === null ? null : Math.round(ramp(v, [[0.1, 10], [0.5, 60], [0.9, 100]])),
      weight: 1,
      resolved: v !== null,
      note: span === null ? 'Days traded across the window. Meaningless over a single day.' : 'Days with a trade across the window. One good day is luck; a record is many.',
    });
  }
  // 5. Focus — trips per mint. Forty trips on two mints is an insider or a
  //    wash pattern, not a trader to mirror on the next coin.
  {
    const perMint = enough && i.distinctMints > 0 ? i.roundTrips / i.distinctMints : null;
    checks.push({
      id: 'focus',
      label: 'Coins per trip',
      value: perMint === null ? '—' : `${i.distinctMints} coins, ${i.roundTrips} trips`,
      points: perMint === null ? null : Math.round(ramp(perMint, [[1, 100], [2, 80], [3, 50], [6, 0]])),
      weight: 1,
      resolved: perMint !== null,
      note: perMint === null ? 'How spread the record is across coins.' : perMint >= 4 ? 'Most trips are on the same few coins — that is a relationship with those coins, not a knack for picking them.' : 'Trips are spread across coins, which is what a copy on the next coin needs.',
    });
  }

  let earned = 0;
  let possible = 0;
  let resolved = 0;
  for (const c of checks) {
    if (!c.resolved || c.points === null) continue;
    resolved += 1;
    earned += c.points * c.weight;
    possible += c.weight;
  }
  // No score without the follower return (2026-10-22). It is the question the
  // score exists to answer; the other checks describe a wallet, they do not
  // say what a copy kept. A wallet scored 63 on reach, days and focus while
  // every copy of it that could be priced lost 33–56 %.
  const fReturnKnown = checks[0].resolved;
  const score = enough && fReturnKnown && resolved >= SCORE_MIN_RESOLVED && possible > 0 ? Math.round(earned / possible) : null;

  const flags: WalletFlag[] = [];
  if (i.looksAutomated) flags.push('bot');
  if (!enough) flags.push('thin');
  if (enough && i.judgedTrips >= SCORE_MIN_TRIPS && i.reachablePct !== null && i.reachablePct < 25) flags.push('unreachable');
  // A score built on a small slice of a big record — the model has judged
  // fewer than half the window's trips. The number stands; the label says
  // what it stands on.
  if (enough && score !== null && i.judgedTrips < i.roundTrips * PARTIAL_COVERAGE) flags.push('partial');
  if (enough && i.distinctMints > 0 && i.roundTrips / i.distinctMints >= 4) flags.push('concentrated');

  return { score, checks, resolved, total: checks.length, flags };
}

/** The tone a score renders in. Null is a dash, never a colour. */
export function scoreTone(score: number | null): 'good' | 'mid' | 'bad' | null {
  if (score === null) return null;
  return score >= 70 ? 'good' : score >= 40 ? 'mid' : 'bad';
}
