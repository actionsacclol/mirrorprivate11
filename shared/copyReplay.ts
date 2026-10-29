// Copy replay (2026-10-23) — "what would copying this wallet have done?",
// answered for ANY Solana wallet, including one the live feed never saw.
//
// The Scout prices a copy from the prints the feed recorded on the same coin.
// A wallet looked up cold (a pasted address, a pump.fun username) has no such
// prints: "Read from chain" fills in what THEY did and leaves the copy side
// unpriced. The replay prices it: each of their recent finished trades is
// mirrored the way the Scout mirrors one — the copy buys FOLLOWER_LAG_MS after
// their first buy and sells FOLLOWER_LAG_MS after their final sell — and each
// leg fills at the market as it stood then: the price the last trade before
// that moment left the coin at (pump's swap API reports it per trade).
//
// Same model as the board, so a replayed wallet and a recorded one read the
// same: the copy is cut off when they were out before it could land
// (too-fast), it is priced where a coin died rather than dropped, and the
// returns are stored under the recorded 1.5 %/side model and repriced at the
// user's size with the paper cost model. Slippage beyond the last print's
// price is not modelled, and the page says so.

import {
  FOLLOWER_LAG_MS,
  RECORDED_POPULATION_MEDIAN_PCT,
  SCORE_MIN_F_TRIPS,
  feeFloorPct,
  followerNetReturnPct,
  repriceReturn,
  shrunkMedian,
} from './walletScore';
import { SCOUT_TRIMMED_DROP, SCOUT_TRIMMED_MIN_COPIES, copyCostModel } from './walletScout';
import { minUnattendedBuySol } from './exitBudget';

/** One of the wallet's swaps, oldest first. Amounts in SOL and UI tokens. */
export interface ReplaySwap {
  mint: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  at: number;
  /** The slot it landed in, when the read had it. The chain-priced replay
   *  measures the follower's lag from it, to the slot. */
  slot?: number;
  /** The transaction it came in (2026-10-25): a buy and a sell of one coin
   *  in the SAME transaction is a wash trade, and the opening buy's
   *  transaction is what the launch-bundle check compares. */
  tx?: string;
  /** Who paid the transaction's fee, when it was not the wallet itself. */
  payer?: string;
  /** Its position in the block, when the read had it. */
  txIndex?: number;
}

export type ReplayNote = 'filled' | 'too-fast' | 'unpriced';

/** Which source priced a trip: the chain through Helius (fast, metered), or
 *  pump's swap API (free, one call per 2 s, Chromium only). */
export type ReplaySource = 'chain' | 'pump';

export interface ReplayTrip {
  mint: string;
  openedAt: number;
  closedAt: number;
  /** SOL they put in, and what they made on it. */
  cost: number;
  pnl: number;
  holdMs: number;
  /** The copy's fills, SOL per token; null when not priced. */
  entryPx: number | null;
  exitPx: number | null;
  /** The copy's net return under the recorded model, %, or null with why. */
  returnPct: number | null;
  /** The same return had the copy landed N slots after theirs, by N (the
   *  pre-registered test's lag ablation; 2026-10-25). Only when asked for;
   *  `returnPct` is the usual lag's. Null = no trade to price at that lag. */
  atLag?: Record<string, number | null>;
  note: ReplayNote;
  /** Their opening buy's slot and closing sell's slot; null when the read
   *  did not carry slots (then only the swap API can price it). */
  openSlot?: number | null;
  closeSlot?: number | null;
  /** What priced it. Absent while unpriced. */
  source?: ReplaySource;
  /** The opening buy's transaction, block position and fee payer, for the
   *  launch-bundle check (2026-10-25). */
  openTx?: string | null;
  openIndex?: number | null;
  openPayer?: string | null;
  /** Slots between the coin's first trade and the opening buy, once the
   *  coin's birth was read; null when it was not. */
  sinceBirth?: number | null;
  /** The opening buy was part of the coin's launch: inside the launch
   *  transaction, in the four transactions after it in the same slot, or
   *  paid for by the creator. */
  bundle?: boolean;
}

/** Trips priced per replay. On the chain that is ~30 calls (about 300
 *  credits); on the swap API, two calls each at its 2 s pace. */
export const REPLAY_MAX_TRIPS = 30;

// ── The whole-week check (2026-10-28) ─────────────────────────────────
//
// The newest thirty trades say how a wallet trades. Whether copying it
// PAYS is a week question: the 10-27 research found the only two
// week-positive copies by replaying every trade of the week, and found that
// wallets which look great on thirty trades lose across seven days, with
// the total carried by a handful of tail trades (docs/copy-candidates-
// 2026-10-27.md). So Check can replay the whole week too, and says how much
// of the total its best five copies carried.

/** Which trades a replay prices: the newest thirty, or the whole week. */
export type ReplaySpan = 'newest' | 'week';
export const REPLAY_WEEK_MS = 7 * 24 * 3_600_000;
/** Trips priced in a week check, newest first. A wallet busier than this is
 *  too fast to copy anyway; the status says how many were left out. */
export const REPLAY_WEEK_MAX_TRIPS = 400;
/** The chain read for a week check: up to this many transactions, inside
 *  the seven days (Helius's deep read, a hundred a call). */
export const REPLAY_WEEK_READ_LIMIT = 5_000;
/** The most one trip's chain pricing may cost (chainPrice reserves it
 *  before asking). */
export const REPLAY_TRIP_CREDITS_MAX = 20;
/** Trips the slow swap-API fallback prices in a week check. Past these, a
 *  trip the chain could not price stays unpriced and is counted — the
 *  fallback's 2 s pace would hold a 400-trip check for half an hour. */
export const REPLAY_WEEK_SLOW_MAX = REPLAY_MAX_TRIPS;
/** The most Helius credits a whole-week check can spend: the read (10 per
 *  hundred transactions, on the month's meter) plus every trip at its
 *  ceiling (from the backtest allowance). Usually about half of it. */
export const REPLAY_WEEK_CREDITS_MAX = Math.ceil(REPLAY_WEEK_READ_LIMIT / 100) * 10 + REPLAY_WEEK_MAX_TRIPS * REPLAY_TRIP_CREDITS_MAX;
/** The newest-thirty check at its ceiling, for the same comparison. */
export const REPLAY_NEWEST_CREDITS_MAX = 100 + REPLAY_MAX_TRIPS * REPLAY_TRIP_CREDITS_MAX;

/**
 * Their finished trips from their swaps, by the Scout's rules: the first buy
 * opens a position, more buys add to it, sells take out a share of the cost,
 * and the trip closes when nothing (or only dust) is left. A sell with no
 * buy on record is not a trip. Oldest first.
 */
export function buildTrips(swaps: readonly ReplaySwap[]): { trips: ReplayTrip[]; open: number; orphanSells: number } {
  const pos = new Map<string, { cost: number; tokens: number; spent: number; realised: number; openedAt: number; openSlot: number | null; openTx: string | null; openIndex: number | null; openPayer: string | null }>();
  const trips: ReplayTrip[] = [];
  let orphanSells = 0;
  // Block times are whole seconds; the slot orders trades inside one.
  for (const s of [...swaps].sort((a, b) => a.at - b.at || (a.slot ?? 0) - (b.slot ?? 0) || (a.txIndex ?? 0) - (b.txIndex ?? 0))) {
    if (!(s.sol > 0) || !(s.tokens > 0)) continue;
    const p = pos.get(s.mint);
    if (s.isBuy) {
      if (p) {
        p.cost += s.sol;
        p.tokens += s.tokens;
        p.spent += s.sol;
      } else
        pos.set(s.mint, {
          cost: s.sol,
          tokens: s.tokens,
          spent: s.sol,
          realised: 0,
          openedAt: s.at,
          openSlot: typeof s.slot === 'number' ? s.slot : null,
          openTx: s.tx ?? null,
          openIndex: typeof s.txIndex === 'number' ? s.txIndex : null,
          openPayer: s.payer ?? null,
        });
      continue;
    }
    if (!p || p.tokens <= 0) {
      orphanSells += 1;
      continue;
    }
    const share = Math.min(1, s.tokens / p.tokens);
    const costOut = p.cost * share;
    p.realised += s.sol - costOut;
    p.cost -= costOut;
    p.tokens -= Math.min(s.tokens, p.tokens);
    if (p.tokens <= 0 || p.cost <= 1e-9) {
      pos.delete(s.mint);
      const holdMs = Math.max(0, s.at - p.openedAt);
      trips.push({
        mint: s.mint,
        openedAt: p.openedAt,
        closedAt: s.at,
        cost: p.spent,
        pnl: p.realised,
        holdMs,
        entryPx: null,
        exitPx: null,
        returnPct: null,
        // Out before a copy could land: nothing to price, and the copier is
        // never in it — the same verdict the Scout gives.
        note: holdMs < FOLLOWER_LAG_MS ? 'too-fast' : 'unpriced',
        openSlot: p.openSlot,
        closeSlot: typeof s.slot === 'number' ? s.slot : null,
        openTx: p.openTx,
        openIndex: p.openIndex,
        openPayer: p.openPayer,
      });
    }
  }
  return { trips, open: pos.size, orphanSells };
}

// ── Which trips to price, and the checks the swaps alone answer (2026-10-25) ──
//
// "The newest 30" is what someone checking a wallet wants to see; it is a
// BIASED estimate of the wallet's week, because a run of recent luck (or a
// recent blow-up) is all it sees. A chain LABEL — the figure the board puts
// beside the record — prices a uniform random sample of the week's trips
// instead, so its median is unbiased for the same credits. The seed makes a
// label reproducible: the same wallet and day give the same sample.

export type ReplaySample = 'newest' | 'random';

/** mulberry32: a small seeded generator, enough to pick a sample. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from a string: the wallet and the day, so a label is repeatable. */
export function sampleSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Up to `max` of `trips` (oldest first in, newest first out): the newest, or
 * a uniform random sample without replacement under `seed`. Fewer than `max`
 * trips come back whole either way.
 */
export function sampleTrips(trips: readonly ReplayTrip[], max: number, sample: ReplaySample, seed = 1): ReplayTrip[] {
  const n = Math.max(0, Math.floor(max));
  if (sample === 'newest' || trips.length <= n) return [...trips].reverse().slice(0, n);
  const idx = trips.map((_, i) => i);
  const next = rng(seed);
  // Partial Fisher–Yates: the first n positions are a uniform sample.
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(next() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, n)
    .sort((a, b) => b - a)
    .map((i) => trips[i]);
}

export interface SwapChecks {
  /** Transactions in which the wallet both bought and sold one coin. */
  washTrips: number;
  /** Distinct fee payers other than the wallet. */
  sharedPayers: number;
}

/** What the swaps alone say, at no cost beyond the history read. A buy and
 *  a sell of the same coin inside one transaction has no honest use on a
 *  bonding curve; a fee paid by another wallet makes the two one operation. */
export function swapChecks(swaps: readonly ReplaySwap[], wallet: string): SwapChecks {
  const sides = new Map<string, Set<string>>();
  const payers = new Set<string>();
  for (const s of swaps) {
    if (s.payer && s.payer !== wallet) payers.add(s.payer);
    if (!s.tx) continue;
    let set = sides.get(s.tx);
    if (!set) sides.set(s.tx, (set = new Set()));
    set.add(`${s.mint}:${s.isBuy ? 'b' : 's'}`);
  }
  let washTrips = 0;
  for (const set of sides.values()) {
    for (const k of set) if (k.endsWith(':b') && set.has(k.slice(0, -2) + ':s')) washTrips += 1;
  }
  return { washTrips, sharedPayers: payers.size };
}

/** The coin's birth, as the chain read it: its first transaction. */
export interface MintBirth {
  slot: number;
  index: number;
  tx: string;
  /** Who paid for the launch (its fee payer), or null when unreadable. */
  creator: string | null;
}

/** Transactions after the launch, in its slot, that Bitquery's rule counts
 *  as the bundle (185 of 186 checked against the public Jito record). */
export const BUNDLE_AFTER_CREATE = 4;

/** Mark one trip against its coin's birth: how many slots after it the buy
 *  landed, and whether the buy was part of the launch. */
export function markBirth(t: ReplayTrip, birth: MintBirth, wallet: string): void {
  if (typeof t.openSlot !== 'number') return;
  t.sinceBirth = Math.max(0, t.openSlot - birth.slot);
  const inCreate = !!t.openTx && t.openTx === birth.tx;
  const rightAfter = t.openSlot === birth.slot && typeof t.openIndex === 'number' && t.openIndex > birth.index && t.openIndex <= birth.index + BUNDLE_AFTER_CREATE;
  const creatorPaid = !!t.openPayer && t.openPayer !== wallet && t.openPayer === birth.creator;
  t.bundle = inCreate || rightAfter || creatorPaid;
}

export interface ReplayChecks extends SwapChecks {
  /** Of the trips whose coin's birth was read, those opened within
   *  `sniperSlots` of it. */
  sniperTrips: number;
  /** Of those, part of the launch (see markBirth). */
  bundleTrips: number;
  /** Trips whose coin's birth was read. */
  mintsChecked: number;
  /** Helius credits the birth reads spent. */
  credits: number;
}

/** The recorded-model (1.5 %/side) median over the priced trips; null under five. */
export function recordedMedian(trips: readonly ReplayTrip[]): number | null {
  const rs = trips.filter((t) => t.returnPct !== null).map((t) => t.returnPct as number).sort((a, b) => a - b);
  if (rs.length < 5) return null;
  const mid = Math.floor(rs.length / 2);
  return rs.length % 2 ? rs[mid] : (rs[mid - 1] + rs[mid]) / 2;
}

/** The copy's return under the recorded model from two fills, or null. */
export function replayReturn(entryPx: number | null, exitPx: number | null): number | null {
  if (entryPx === null || exitPx === null) return null;
  return followerNetReturnPct(entryPx, exitPx);
}

export interface ReplaySummary {
  trips: number;
  copied: number;
  tooFast: number;
  unpriced: number;
  /** Median per copy at the size, %; null under five copies. */
  medianPct: number | null;
  /** The board's ranking figure, null under SCORE_MIN_F_TRIPS copies. */
  shrunkPct: number | null;
  winRatePct: number | null;
  /** Share of judged trips a copy could be in, %. */
  reachablePct: number | null;
  /** What `copied` copies of `sizeSol` each would have made in total, SOL. */
  totalSol: number | null;
  sizeSol: number | null;
  feeFloorPct: number;
  /** Copies left out because a share of their trade came to less than a
   *  live copy can be (sized by their trade only; 0 for a fixed size). */
  skippedSmall: number;
  /** What the copies that were made would have spent, SOL. */
  spentSol: number | null;
  /** Mean per copy, %, from five copies (2026-10-28). The median says what
   *  a TYPICAL copy did; the mean is what the total is made of. */
  meanPct: number | null;
  /** The mean without the best SCOUT_TRIMMED_DROP copies, %, from
   *  SCOUT_TRIMMED_MIN_COPIES — the board's "Mean without best 5". */
  trimmedMeanPct: number | null;
  /** What the best five copies made together, and every other copy, SOL.
   *  Null when the total is (or under SCOUT_TRIMMED_MIN_COPIES copies). */
  bestSol: number | null;
  restSol: number | null;
  /** The copies by the day they closed, local days, oldest first. */
  days: ReplayDay[];
}

/** One day of a replay's copies. `day` is that local day's midnight, ms. */
export interface ReplayDay {
  day: number;
  copies: number;
  /** What that day's copies made, SOL; null when a copy had no size. */
  totalSol: number | null;
  wins: number;
}

/** Local midnight of the day `at` falls on, ms. */
export function replayDayOf(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A copy sized by their trade (2026-10-25, the Follow page's "% of their
 *  trade"): `share`% of what they put into the trade, never over `cap`. */
export interface ReplaySizing {
  share: number;
  cap: number;
}

/** The smallest copy live will place; a share under it is skipped there,
 *  so the replay skips it too (MIN_LIVE_COPY_SOL in copytrade). */
export const REPLAY_MIN_COPY_SOL = minUnattendedBuySol('fast');

/** What one copy of this trip spends under `sizing`, or null when the share
 *  is under the live minimum. */
export function replayCopySol(t: Pick<ReplayTrip, 'cost'>, sizing: ReplaySizing): number | null {
  const sol = Math.min(sizing.cap, (Math.max(0, t.cost) * sizing.share) / 100);
  return sol + 1e-12 < REPLAY_MIN_COPY_SOL ? null : sol;
}

export function replaySummary(trips: readonly ReplayTrip[], sizeSol: number | null, sizing?: ReplaySizing | null): ReplaySummary {
  // Sized by their trade, every copy has its own size, so its own fees: a
  // 0.03 copy pays a bigger share of a round trip than a capped one.
  const m = copyCostModel('solana', sizing ? sizing.cap : sizeSol);
  const priced = trips.filter((t) => t.returnPct !== null);
  const made = priced
    .map((t) => {
      const sol = sizing ? replayCopySol(t, sizing) : m.sizeSol;
      const r = repriceReturn(t.returnPct as number, sizing && sol !== null ? copyCostModel('solana', sol) : m);
      return { sol, r, closedAt: t.closedAt };
    })
    .filter((c) => !sizing || c.sol !== null);
  const skippedSmall = priced.length - made.length;
  const rs = made.map((c) => c.r).sort((a, b) => a - b);
  const tooFast = trips.filter((t) => t.note === 'too-fast').length;
  const median = rs.length >= 5 ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : null;
  const judged = rs.length + tooFast;
  // The week figures (2026-10-28). Sized copies only: a total needs a size.
  const sized = made.length > 0 && made.every((c) => c.sol !== null);
  const solOf = (c: { sol: number | null; r: number }): number => (c.sol as number) * (c.r / 100);
  const byGain = sized ? [...made].sort((a, b) => solOf(b) - solOf(a)) : [];
  const trimmedOk = rs.length >= SCOUT_TRIMMED_MIN_COPIES;
  const best = trimmedOk ? byGain.slice(0, SCOUT_TRIMMED_DROP) : [];
  const rest = trimmedOk ? byGain.slice(SCOUT_TRIMMED_DROP) : [];
  const keptRs = trimmedOk ? rs.slice(0, rs.length - SCOUT_TRIMMED_DROP) : [];
  const dayMap = new Map<number, ReplayDay>();
  for (const c of made) {
    const day = replayDayOf(c.closedAt);
    const d = dayMap.get(day) ?? { day, copies: 0, totalSol: 0, wins: 0 };
    d.copies += 1;
    if (c.r > 0) d.wins += 1;
    d.totalSol = d.totalSol === null || c.sol === null ? null : d.totalSol + solOf(c);
    dayMap.set(day, d);
  }
  return {
    trips: trips.length,
    copied: rs.length,
    tooFast,
    unpriced: trips.length - priced.length - tooFast,
    medianPct: median,
    shrunkPct: median !== null && rs.length >= SCORE_MIN_F_TRIPS ? shrunkMedian(median, rs.length, repriceReturn(RECORDED_POPULATION_MEDIAN_PCT, m)) : null,
    winRatePct: rs.length >= 5 ? (rs.filter((r) => r > 0).length / rs.length) * 100 : null,
    reachablePct: judged >= 5 ? (rs.length / judged) * 100 : null,
    totalSol: made.length && made.every((c) => c.sol !== null) ? made.reduce((a, c) => a + (c.sol as number) * (c.r / 100), 0) : null,
    sizeSol: m.sizeSol,
    feeFloorPct: feeFloorPct(m),
    skippedSmall,
    spentSol: made.length && made.every((c) => c.sol !== null) ? made.reduce((a, c) => a + (c.sol as number), 0) : null,
    meanPct: rs.length >= 5 ? rs.reduce((a, r) => a + r, 0) / rs.length : null,
    trimmedMeanPct: keptRs.length ? keptRs.reduce((a, r) => a + r, 0) / keptRs.length : null,
    bestSol: sized && trimmedOk ? best.reduce((a, c) => a + solOf(c), 0) : null,
    restSol: sized && trimmedOk ? rest.reduce((a, c) => a + solOf(c), 0) : null,
    days: [...dayMap.values()].sort((a, b) => a.day - b.day),
  };
}

/** The week in one sentence (2026-10-28): what kind of result it is. */
export interface ReplayVerdict {
  kind: 'loss' | 'tail' | 'oneDay' | 'positive';
  text: string;
}

/**
 * Read a replay the way the 10-27 research read a wallet: is the total
 * positive, does it survive without the best five copies, and is it one
 * day. Null under SCOUT_TRIMMED_MIN_COPIES copies or without a total —
 * too little to say it.
 */
export function replayVerdict(sum: ReplaySummary, week: boolean): ReplayVerdict | null {
  if (sum.totalSol === null || sum.copied < SCOUT_TRIMMED_MIN_COPIES || sum.restSol === null || sum.bestSol === null) return null;
  const span = week ? 'over the week' : 'over these trades';
  const sol = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} SOL`;
  const upDays = sum.days.filter((d) => d.totalSol !== null && d.totalSol > 0);
  if (sum.totalSol <= 0) {
    return {
      kind: 'loss',
      text: `Copying lost ${sol(sum.totalSol)} ${span} at this size, over ${sum.copied} copies${week && sum.days.length ? ` — ${upDays.length} of ${sum.days.length} days positive` : ''}.`,
    };
  }
  if (sum.restSol <= 0) {
    return {
      kind: 'tail',
      text: `Positive ${span} (${sol(sum.totalSol)}), but only because of the best ${SCOUT_TRIMMED_DROP} copies: they made ${sol(sum.bestSol)}, the other ${sum.copied - SCOUT_TRIMMED_DROP} made ${sol(sum.restSol)}. A follower who misses one of those five loses.`,
    };
  }
  // One day carried it: the best day alone made at least the whole total.
  const best = [...sum.days].sort((a, b) => (b.totalSol ?? -Infinity) - (a.totalSol ?? -Infinity))[0];
  const oneDay = week && sum.days.length >= 3 && !!best && best.totalSol !== null && best.totalSol >= sum.totalSol;
  return {
    kind: oneDay ? 'oneDay' : 'positive',
    text: `Positive ${span} (${sol(sum.totalSol)} over ${sum.copied} copies) and still positive without the best ${SCOUT_TRIMMED_DROP} (${sol(sum.restSol)}).${
      oneDay ? ` One day made all of it — ${new Date(best.day).toLocaleDateString(undefined, { weekday: 'long' })}.` : ''
    } Rare: paper-follow it for a week before risking SOL.`,
  };
}

/** A replay job, polled by the profile. */
export interface CopyReplayStatus {
  address: string;
  /** Which trades it priced (2026-10-28); absent = the newest thirty. */
  span?: ReplaySpan;
  /** Trips the chain could not price and the capped slow fallback did not
   *  try (a week check). Counted, never guessed. */
  slowSkipped?: number;
  /** A week check whose chain read did not reach the start of the week, or
   *  has holes (2026-10-28): why, in words. The figures are then for the part
   *  that was read, and no week verdict is drawn. Absent or null = covered. */
  weekShort?: string | null;
  running: boolean;
  phase: 'idle' | 'reading' | 'pricing' | 'done';
  startedAt: number | null;
  finishedAt: number | null;
  /** Their swaps the chain read decoded. */
  swaps: number;
  /** Finished trips found, and how many of the newest are being priced. */
  tripsFound: number;
  toPrice: number;
  priced: number;
  /** Positions still open at the end of the read: not trips yet. */
  open: number;
  calls: number;
  /** Trips priced from the chain and from pump's swap API (2026-10-24: the
   *  chain first, the swap API as the fallback), and the Helius credits the
   *  chain pricing spent from the backtest allowance. Optional so a status
   *  built before them reads as none. */
  viaChain?: number;
  viaPump?: number;
  credits?: number;
  /** Why trips went to the slower swap API, in words ('' when none did, or
   *  none could have gone to the chain). */
  fallbackWhy?: string;
  cancelled: boolean;
  /** Why it stopped, or what it could not do. Empty while all is well. */
  message: string;
  /** While pump.fun's history API has asked us to slow down: when the wait
   *  ends, ms. Null otherwise. */
  waitingUntil: number | null;
  /** Newest first. */
  trips: ReplayTrip[];
  /** How the priced trips were chosen (2026-10-25); absent = newest. */
  sample?: ReplaySample;
  /** The checks, once run: wash trades and shared payers from the swaps,
   *  snipes and launch bundles from the coins' births. Absent = not asked. */
  checks?: ReplayChecks;
}
