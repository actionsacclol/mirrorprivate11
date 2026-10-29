// The pre-registered test (2026-10-25, P1 of
// docs/wallet-scout-research-2026-10-25.md, "The pre-registered test that
// settles whether it works").
//
// Everything else the scout does can be built without knowing the answer;
// this is the experiment that produces it. Each week the selection rule and
// the wallets it picks are FROZEN — written and hashed before the week they
// are judged on has a single trade in it — alongside the controls that make
// the result mean something: RAND, as many wallets drawn at random from the
// same eligible set; LEAD, the top of pump.fun's own leaderboard, which is
// what every other copy tool ranks on; FLOOR, what a copy returns when the
// price never moves; NONE, copying nobody. When the week has ended, every
// arm's wallets are replayed over exactly that week from the chain — the
// same rule for every arm, nothing re-ranked — and the arms are compared.
//
// This file is the pure part: the rule, the freeze record and its canonical
// text, the draw, the settlement arithmetic and the verdict. The engine
// (electron/engine/prereg.ts) owns the clock, the files and the chain.

import { copyCostModel, type ScoutRow } from './walletScout';
import { feeFloorPct, repriceReturn } from './walletScore';
import { bootstrapMedianCI, bootstrapMedianDiffCI, hashSeed, median, mulberry32, spearman, trimmedMean } from './stats';

/** The size every copy is priced at. */
export const PREREG_SIZE_SOL = 0.1;
/** Weeks the primary endpoint pools over… */
export const PREREG_WEEKS = 8;
/** …and the week at which a TOP upper bound under zero stops it for futility. */
export const PREREG_FUTILITY_WEEKS = 4;
/** Wallets per arm. */
export const PREREG_ARM_N = 10;
/** The ablation's lags, slots after the leader's. */
export const PREREG_LAGS: readonly number[] = [0, 1, 2, 4, 9];
/** The lag assumed when no live telemetry has measured one (2 s ÷ 211.6 ms). */
export const PREREG_LAG_ASSUMED = 9;
/** Trips priced per wallet per week: a random sample of the week's trips.
 *  Forty at ~10–20 credits each keeps a 50-wallet settlement near 30k
 *  credits inside the backtest allowance. */
export const PREREG_MAX_TRIPS = 40;
/** Bootstrap draws for the clustered intervals. */
export const PREREG_BOOT = 200;
/** The leader's partial sell that triggers the mirrored exit (STATE-F). */
export const PREREG_MIN_LEADER_SELL_PCT = 50;
/** Open copies per wallet at once. */
export const PREREG_MAX_OPEN_PER_WALLET = 3;
/**
 * Selection rules tried on the board before this one, the count a sceptic
 * asks for (Bonferroni's denominator): the Copy score (2026-09), and the
 * shrunk median with a fixed prior and k = 10 (2026-10-23). The EB lower
 * bound is the third.
 */
export const PREREG_RULES_TRIED_BEFORE = 2;

export type PreregArmName = 'TOP' | 'RAND' | 'LEAD';
export const PREREG_ARMS: readonly PreregArmName[] = ['TOP', 'RAND', 'LEAD'];

/** The selection rule as frozen, every number that decides a pick. */
export interface PreregRule {
  ranker: 'eb-lcb';
  /** The week's prior: μ (recorded model, %) and k copies, and the wallets
   *  it was measured from (0 = the fixed constants). */
  muPct: number;
  k: number;
  priorWallets: number;
  /** The lower bound's z. */
  z: number;
  /** Copyable trips in the trailing seven days a wallet needs. */
  minTrips: number;
  /** The bot rule: trades a minute. */
  botPerMin: number;
  /** The five board filters, all on, and the chain labels' hard exclusions. */
  filters: string;
  sizeSol: number;
  /** The lag the test judges at, and where that number came from. */
  lagSlots: number;
  lagSource: 'measured' | 'assumed';
  minLeaderSellPct: number;
  maxOpenPerWallet: number;
}

export interface PreregArm {
  name: PreregArmName;
  wallets: string[];
  /** How the arm was drawn, in words. */
  rule: string;
  /** Anything a reader should know (an empty leaderboard, a short list). */
  note?: string;
}

export interface PreregWeek {
  version: 1;
  chain: 'solana';
  /** The week it is FOR: its Monday 00:00 UTC, ms. */
  week: number;
  frozenAt: number;
  /** Frozen after the week had begun — its data existed when the rule did. */
  late: boolean;
  rule: PreregRule;
  arms: PreregArm[];
  /** The fee floor at the size, % — the FLOOR arm. NONE is 0. */
  floorPct: number;
  /** Wallets that passed the rule, and the whole ranked universe. */
  eligible: number;
  universe: number;
  /** Selection rules tried before this one was frozen (Bonferroni's count). */
  rulesTried: number;
  /** sha256 of `canonical(this without hash)`, hex. */
  hash: string;
}

/**
 * The text the hash is over: the freeze with its hash left out, keys in a
 * fixed order, no whitespace. The same record always canonicalises to the
 * same text, so the hash can be checked by anyone with the file.
 */
export function canonical(w: Omit<PreregWeek, 'hash'> | PreregWeek): string {
  const { hash: _h, ...rest } = w as PreregWeek;
  void _h;
  return stable(rest);
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The freeze as a document a person can read beside the JSON. */
export function preregMarkdown(w: PreregWeek): string {
  const d = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const lines = [
    `# PREREG ${weekLabel(w.week)}`,
    '',
    `Frozen ${d(w.frozenAt)} for the week beginning ${d(w.week)}${w.late ? ' — LATE: the week had begun when this was written' : ''}.`,
    `Hash: \`${w.hash}\` (sha256 over the canonical JSON of this record without the hash).`,
    '',
    '## Rule',
    '',
    `- Ranker: Empirical-Bayes shrunk follower median, ranked on its lower bound (z = ${w.rule.z}).`,
    `- Prior this week: μ = ${w.rule.muPct.toFixed(2)} % (recorded model), k = ${w.rule.k.toFixed(1)} copies, measured from ${w.rule.priorWallets || 'no'} wallets${w.rule.priorWallets ? '' : ' (the fixed constants)'}.`,
    `- Eligible: at least ${w.rule.minTrips} copyable trips in the trailing seven days, under ${w.rule.botPerMin} trades a minute, ${w.rule.filters}.`,
    `- Copies: ${w.rule.sizeSol} SOL each, ${w.rule.lagSlots} slots after the leader (${w.rule.lagSource}), mirrored sells at a ${w.rule.minLeaderSellPct} % leader sell, at most ${w.rule.maxOpenPerWallet} open per wallet, every leg chain-priced at the last trade at or before the follower's slot.`,
    `- Universe: ${w.universe} ranked wallets, ${w.eligible} eligible. Rules tried before this one: ${w.rulesTried}.`,
    '',
    '## Arms',
    '',
    `- FLOOR: ${w.floorPct.toFixed(2)} % (fees alone at ${w.rule.sizeSol} SOL). NONE: 0 %.`,
  ];
  for (const a of w.arms) {
    lines.push(`- ${a.name} (${a.wallets.length}): ${a.rule}${a.note ? ` — ${a.note}` : ''}`);
    for (const x of a.wallets) lines.push(`    - ${x}`);
  }
  lines.push('', '## Endpoints', '', `- Primary: pooled median net return per copy of TOP over ${PREREG_WEEKS} weeks, mint-clustered bootstrap 95 % interval; success is a lower bound above zero AND above the floor in at least six of eight weeks.`, `- Secondaries: TOP − RAND and TOP − LEAD with intervals excluding zero upward; 1 %-trimmed mean; win rate against cost above 50 %.`, `- Futility: stop at ${PREREG_FUTILITY_WEEKS} weeks if TOP's pooled upper bound is under zero. Never stop early for success.`, `- Ablation: every TOP trip re-priced at ${PREREG_LAGS.join(', ')} slots. Rank decay: this week's TOP followed through the next two weeks.`, '');
  return lines.join('\n');
}

export function weekLabel(week: number): string {
  return new Date(week).toISOString().slice(0, 10);
}

/**
 * RAND: `n` wallets from the eligible rows, stratified on trip count and on
 * median first-buy size — the two traits that most decide a copy's fees and
 * reach — so a random arm is not, by accident, the thin or the large end of
 * the universe. Terciles of each, drawn round-robin, seeded.
 */
export function stratifiedDraw(rows: readonly ScoutRow[], n: number, seed: number): string[] {
  if (!rows.length || n <= 0) return [];
  const next = mulberry32(seed);
  const tercile = (v: number, sorted: number[]): number => {
    if (sorted.length < 3) return 0;
    const a = sorted[Math.floor(sorted.length / 3)];
    const b = sorted[Math.floor((2 * sorted.length) / 3)];
    return v <= a ? 0 : v <= b ? 1 : 2;
  };
  const trips = rows.map((r) => r.fTrips).sort((a, b) => a - b);
  const sizes = rows.map((r) => r.medianFirstBuy ?? 0).sort((a, b) => a - b);
  const cells = new Map<string, ScoutRow[]>();
  for (const r of rows) {
    const k = `${tercile(r.fTrips, trips)}${tercile(r.medianFirstBuy ?? 0, sizes)}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  // Shuffle inside each cell, then take one from each cell in turn.
  const queues = [...cells.keys()].sort().map((k) => {
    const list = [...(cells.get(k) as ScoutRow[])];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  });
  const out: string[] = [];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (out.length >= n) break;
      const r = q.shift();
      if (r) out.push(r.address);
    }
  }
  return out;
}

// ── Settlement ─────────────────────────────────────────────────────────

/** One copy of one trip, as the settlement records it. */
export interface PreregCopy {
  /** The arm, or the rank-decay track it belongs to. */
  arm: PreregArmName | 'TRACK1' | 'TRACK2';
  wallet: string;
  mint: string;
  openedAt: number;
  closedAt: number;
  /** Recorded-model return by lag (String(slots)); null = no trade to price
   *  at that lag. Empty when the trip could not be priced at all. */
  atLag: Record<string, number | null>;
  /** The leader was out before a copy was due: skipped, and counted. */
  tooFast: boolean;
}

export interface PreregArmResult {
  name: string;
  wallets: number;
  /** Wallets with at least one priced copy. */
  walletsPriced: number;
  /** Priced copies, at the judged lag… */
  copies: number;
  /** …and trips skipped as too fast or left unpriced. */
  skipped: number;
  medianPct: number | null;
  /** Mint-clustered bootstrap 95 % interval of the median. */
  ci: { lo: number; hi: number } | null;
  trimmedMeanPct: number | null;
  winRatePct: number | null;
  /** Net SOL over the week at the size, every priced copy. */
  netSol: number | null;
  /** The median at each ablation lag. */
  byLag: Record<string, { copies: number; medianPct: number | null }>;
}

export interface PreregSettled {
  version: 1;
  week: number;
  settledAt: number;
  sizeSol: number;
  floorPct: number;
  lagSlots: number;
  arms: PreregArmResult[];
  /** TOP − RAND and TOP − LEAD, mint-clustered 90 % intervals. */
  diffs: { vsRand: { diff: number; lo: number; hi: number } | null; vsLead: { diff: number; lo: number; hi: number } | null };
  /** Last week's and the week before's TOP, followed through this week. */
  tracks: { prev1: PreregArmResult | null; prev2: PreregArmResult | null };
  /** Spearman of the tracked TOP wallets' medians this week against their
   *  rank at their own freeze; null under five wallets with copies. */
  decay: { prev1: { rho: number; wallets: number } | null; prev2: { rho: number; wallets: number } | null };
  /** Every arm's every wallet was replayed to the end. */
  complete: boolean;
  credits: number;
  message: string;
}

const key = (lag: number): string => String(lag);

/** One arm's figures from its copies, at `sizeSol`, judged at `lagSlots`. */
export function settleArm(name: string, wallets: readonly string[], copies: readonly PreregCopy[], sizeSol: number, lagSlots: number, seed: number): PreregArmResult {
  const m = copyCostModel('solana', sizeSol);
  const judged = copies.filter((c) => typeof c.atLag[key(lagSlots)] === 'number');
  const rs = judged.map((c) => repriceReturn(c.atLag[key(lagSlots)] as number, m));
  const byMint = new Map<string, number[]>();
  judged.forEach((c, i) => byMint.set(c.mint, [...(byMint.get(c.mint) ?? []), rs[i]]));
  const byLag: PreregArmResult['byLag'] = {};
  for (const lag of new Set([...PREREG_LAGS, lagSlots])) {
    const xs = copies.filter((c) => typeof c.atLag[key(lag)] === 'number').map((c) => repriceReturn(c.atLag[key(lag)] as number, m));
    byLag[key(lag)] = { copies: xs.length, medianPct: median(xs) };
  }
  return {
    name,
    wallets: wallets.length,
    walletsPriced: new Set(judged.map((c) => c.wallet)).size,
    copies: rs.length,
    skipped: copies.length - judged.length,
    medianPct: median(rs),
    ci: bootstrapMedianCI([...byMint.values()], PREREG_BOOT, seed),
    trimmedMeanPct: trimmedMean(rs, 0.01),
    winRatePct: rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : null,
    netSol: rs.length ? rs.reduce((a, r) => a + (r / 100) * sizeSol, 0) : null,
    byLag,
  };
}

/** TOP − another arm, mint-clustered on both sides. */
export function armDiff(top: readonly PreregCopy[], other: readonly PreregCopy[], sizeSol: number, lagSlots: number, seed: number): { diff: number; lo: number; hi: number } | null {
  const m = copyCostModel('solana', sizeSol);
  const groups = (cs: readonly PreregCopy[]): number[][] => {
    const by = new Map<string, number[]>();
    for (const c of cs) {
      const r = c.atLag[key(lagSlots)];
      if (typeof r === 'number') by.set(c.mint, [...(by.get(c.mint) ?? []), repriceReturn(r, m)]);
    }
    return [...by.values()];
  };
  const r = bootstrapMedianDiffCI(groups(top), groups(other), PREREG_BOOT, seed);
  return r ? { diff: r.diff, lo: r.lo, hi: r.hi } : null;
}

/**
 * Rank decay: a past week's TOP, in its frozen order (rank 1 first), against
 * the medians those wallets realised THIS week. ρ ≥ 0.4 that holds two weeks
 * out is a trait; ρ at zero by the second week says the ranking was noise.
 */
export function rankDecay(frozenOrder: readonly string[], copies: readonly PreregCopy[], lagSlots: number): { rho: number; wallets: number } | null {
  const by = new Map<string, number[]>();
  for (const c of copies) {
    const r = c.atLag[key(lagSlots)];
    if (typeof r === 'number') by.set(c.wallet, [...(by.get(c.wallet) ?? []), r]);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  frozenOrder.forEach((w, i) => {
    const rs = by.get(w);
    if (!rs || rs.length < 3) return;
    xs.push(-i); // rank 1 is the highest score
    ys.push(median(rs) as number);
  });
  if (xs.length < 5) return null;
  const rho = spearman(xs, ys);
  return rho === null ? null : { rho, wallets: xs.length };
}

/** The whole week's settlement from its copies. */
export function settleWeek(
  freeze: PreregWeek,
  copies: readonly PreregCopy[],
  tracks: { prev1: PreregWeek | null; prev2: PreregWeek | null },
  lagSlots: number,
  settledAt: number,
  extra: { complete: boolean; credits: number; message: string },
): PreregSettled {
  const seed = hashSeed(`${freeze.hash}:${lagSlots}`);
  const of = (arm: PreregCopy['arm']): PreregCopy[] => copies.filter((c) => c.arm === arm);
  const walletsOf = (name: PreregArmName): string[] => freeze.arms.find((a) => a.name === name)?.wallets ?? [];
  const topWallets = (w: PreregWeek | null): string[] => w?.arms.find((a) => a.name === 'TOP')?.wallets ?? [];
  const arms = PREREG_ARMS.map((name, i) => settleArm(name, walletsOf(name), of(name), freeze.rule.sizeSol, lagSlots, seed + i));
  const t1 = tracks.prev1 ? settleArm('TRACK1', topWallets(tracks.prev1), of('TRACK1'), freeze.rule.sizeSol, lagSlots, seed + 11) : null;
  const t2 = tracks.prev2 ? settleArm('TRACK2', topWallets(tracks.prev2), of('TRACK2'), freeze.rule.sizeSol, lagSlots, seed + 12) : null;
  return {
    version: 1,
    week: freeze.week,
    settledAt,
    sizeSol: freeze.rule.sizeSol,
    floorPct: freeze.floorPct,
    lagSlots,
    arms,
    diffs: {
      vsRand: armDiff(of('TOP'), of('RAND'), freeze.rule.sizeSol, lagSlots, seed + 21),
      vsLead: armDiff(of('TOP'), of('LEAD'), freeze.rule.sizeSol, lagSlots, seed + 22),
    },
    tracks: { prev1: t1, prev2: t2 },
    decay: {
      prev1: tracks.prev1 ? rankDecay(topWallets(tracks.prev1), of('TRACK1'), lagSlots) : null,
      prev2: tracks.prev2 ? rankDecay(topWallets(tracks.prev2), of('TRACK2'), lagSlots) : null,
    },
    complete: extra.complete,
    credits: extra.credits,
    message: extra.message,
  };
}

// ── The verdict ────────────────────────────────────────────────────────

export type PreregOutcome = 'running' | 'futile' | 'pass' | 'fail-latency' | 'fail-selection' | 'inconclusive';

export interface PreregVerdict {
  outcome: PreregOutcome;
  /** Weeks settled, and the weeks the test wants. */
  weeks: number;
  wanted: number;
  /** Pooled TOP median across settled weeks: the median of weekly medians
   *  (pooling copies across weeks would let one hyperactive wallet own the
   *  figure), with a bound from the weeks' own intervals: the median of n
   *  figures each with error s has error about s·√(π/2)/√n, so the pooled
   *  bound is the median ± the mean weekly half-width × 1.2533 ÷ √n. */
  topMedianPct: number | null;
  topLo: number | null;
  topHi: number | null;
  /** Weeks whose TOP lower bound cleared the floor, and cleared zero. */
  weeksAboveFloor: number;
  weeksAboveZero: number;
  /** The 0-slot ablation's pooled TOP median, when every settled week had one. */
  zeroLagMedianPct: number | null;
  /** TOP − RAND: weeks where the interval excluded zero upward. */
  beatRandWeeks: number;
  beatLeadWeeks: number;
  /** Weeks with a futility read, for the stop rule. */
  text: string[];
}

export function preregVerdict(settled: readonly PreregSettled[], wanted = PREREG_WEEKS): PreregVerdict {
  const weeks = [...settled].sort((a, b) => a.week - b.week);
  const top = weeks.map((w) => w.arms.find((a) => a.name === 'TOP')).filter((a): a is PreregArmResult => !!a && a.copies > 0);
  const meds = top.map((a) => a.medianPct as number);
  const topMedianPct = median(meds);
  const halfWidths = top.map((a) => (a.ci ? (a.ci.hi - a.ci.lo) / 2 : null)).filter((x): x is number => typeof x === 'number');
  const pooledSe = halfWidths.length ? ((halfWidths.reduce((s, h) => s + h, 0) / halfWidths.length) * 1.2533) / Math.sqrt(halfWidths.length) : null;
  const topLo = topMedianPct !== null && pooledSe !== null ? topMedianPct - pooledSe : null;
  const topHi = topMedianPct !== null && pooledSe !== null ? topMedianPct + pooledSe : null;
  let weeksAboveFloor = 0;
  let weeksAboveZero = 0;
  weeks.forEach((w) => {
    const a = w.arms.find((x) => x.name === 'TOP');
    if (!a?.ci) return;
    if (a.ci.lo > w.floorPct) weeksAboveFloor += 1;
    if (a.ci.lo > 0) weeksAboveZero += 1;
  });
  const zero = top.map((a) => a.byLag['0']?.medianPct).filter((x): x is number => typeof x === 'number');
  const zeroLagMedianPct = zero.length === top.length && zero.length ? median(zero) : null;
  const beatRandWeeks = weeks.filter((w) => w.diffs.vsRand && w.diffs.vsRand.lo > 0).length;
  const beatLeadWeeks = weeks.filter((w) => w.diffs.vsLead && w.diffs.vsLead.lo > 0).length;
  const n = top.length;
  const text: string[] = [];
  let outcome: PreregOutcome;
  const need6 = Math.ceil((6 / 8) * wanted);
  if (n === 0) {
    outcome = 'running';
    text.push('No week has settled yet. The verdict waits on the first full week of chain-priced copies.');
  } else if (n < PREREG_FUTILITY_WEEKS) {
    outcome = 'running';
    text.push(`${n} of ${wanted} weeks settled. Nothing is decided before week ${PREREG_FUTILITY_WEEKS}; never early for success.`);
  } else if (n < wanted && topHi !== null && topHi < 0 && weeksAboveZero === 0) {
    outcome = 'futile';
    text.push(`Stopped for futility at ${n} weeks: TOP's best upper bound (${topHi.toFixed(1)} %) is under zero and no week's lower bound cleared it. Copying the board's picks at ${weeks[0].sizeSol} SOL loses, at this lag.`);
  } else if (n < wanted) {
    outcome = 'running';
    text.push(`${n} of ${wanted} weeks settled; ${weeksAboveZero} cleared zero on the lower bound so far (${need6} needed). The test runs to ${wanted}.`);
  } else if (weeksAboveZero >= need6 && topLo !== null && topLo > 0) {
    outcome = 'pass';
    text.push(`PASS: TOP's lower bound cleared zero in ${weeksAboveZero} of ${n} weeks and the pooled bound is ${topLo.toFixed(1)} %. Build the basket pipeline — and still show the floor beside every number.`);
  } else if (zeroLagMedianPct !== null && zeroLagMedianPct > 0) {
    outcome = 'fail-latency';
    text.push(`FAIL at the judged lag, but the 0-slot ablation is positive (${zeroLagMedianPct.toFixed(1)} %): the barrier is latency. The honest claim is "not achievable from a desktop"; the roadmap question is co-location, not ranking.`);
  } else if (beatRandWeeks <= n / 2) {
    outcome = 'fail-selection';
    text.push(`FAIL even at 0 slots, and TOP was not distinguishable from RAND (beat it in ${beatRandWeeks} of ${n} weeks): the edge is not there to be found by selection. The defensible product is the board that can recommend nobody and shows the floor.`);
  } else {
    outcome = 'inconclusive';
    text.push(`FAIL on the primary endpoint; TOP beat RAND in ${beatRandWeeks} of ${n} weeks and LEAD in ${beatLeadWeeks}, so the ranking has some skill, but not enough to clear the fees at this size and lag.`);
  }
  if (n) text.push(`TOP beat RAND in ${beatRandWeeks} and LEAD in ${beatLeadWeeks} of ${n} settled weeks (intervals excluding zero upward).`);
  return { outcome, weeks: n, wanted, topMedianPct, topLo, topHi, weeksAboveFloor, weeksAboveZero, zeroLagMedianPct, beatRandWeeks, beatLeadWeeks, text };
}

/** The fee floor the FLOOR arm stands at. */
export function preregFloorPct(sizeSol = PREREG_SIZE_SOL): number {
  return feeFloorPct(copyCostModel('solana', sizeSol));
}

/** Where a freeze is due: Sunday 00:00 UTC, for the week beginning Monday. */
export function freezeDueFor(week: number): number {
  return week - 86_400_000;
}

/** What the engine shows: every freeze and settlement, and the verdict. */
export interface PreregStatus {
  running: boolean;
  /** What is running: a freeze or the settlement of a week. */
  phase: 'idle' | 'freezing' | 'settling';
  settlingWeek: number | null;
  done: number;
  total: number;
  credits: number;
  cancelled: boolean;
  message: string;
  /** The freezes on disk, oldest first; the settlements by week. */
  freezes: PreregWeek[];
  settled: PreregSettled[];
  verdict: PreregVerdict;
  /** The next freeze: the week it is for and when it is due. */
  nextWeek: number;
  nextDue: number;
  /** The session's measured slot gap, or null when none has been. */
  slotGap: number | null;
  /** Freezes whose file no longer hashes to the hash it carries. */
  badHash: number[];
  /** Can the chain price (a Helius key)? Without it nothing settles. */
  chainOk: boolean;
}
