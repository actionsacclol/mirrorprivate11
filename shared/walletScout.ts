// Wallet Scout — what wallets on a chain actually did, over a window.
//
// Copy trading could already score a wallet, but only one you were ALREADY
// following: `LeaderStats` starts its record at the first swap it sees. There
// was no way to find a wallet worth following in the first place. This is that
// missing half, and it is a data tool — it reports what happened, day by day,
// and lets someone decide.
//
// ─── Why this is a RECORD and not a rating ───────────────────────────────
//
// Ranking wallets by PnL over a window selects for luck as much as skill: with
// thousands of wallets making a handful of trades each, the top of any such
// list is dominated by variance. This project has measured that shape twice —
// ranking liquidity providers turned out to rank token-picking (corr 0.936
// with price direction against 0.414 with fees), and a strategy that scored
// +24.37% in-sample came back −1.39% out of sample.
//
// So nothing here predicts. Every number is something we watched happen, over
// a window the user chose, and the UI says so. Whether a wallet's rank in one
// window says anything about the next is a question that can only be answered
// by measuring it once these records span time — which is why they persist.
//
// ─── Two things that would mislead if left unsaid ────────────────────────
//
//  * A small sample is not a record. `MIN_TRIPS_FOR_RANK` keeps a wallet with
//    two lucky trades off the top of the list.
//  * The top of a PnL board tends to be BOTS. The LP swarm's number-one
//    liquidity provider was a JIT bot holding positions for one block. A
//    sniper that wins on latency is not copyable by someone clicking a button,
//    so `looksAutomated` marks them rather than quietly ranking them.

import type { EvmChainKind } from './evm';
import { paperFixedCost, paperSideCost } from './copytrade';
import type { ScoutSort } from './scoutSort';
import {
  DEFAULT_SHRINK_PRIOR,
  RELIABLE_COPIES,
  SCORE_MIN_F_TRIPS,
  feeFloorPct,
  repriceReturn,
  scoreWallet,
  shrinkWith,
  styleBucket,
  type CopyCostModel,
  type PriorWallet,
  type ShrinkPrior,
  type WalletFlag,
  type WalletScore,
} from './walletScore';
import { bootstrapMedianDiffCI, linearFit, pbo as pboOf, spearman, stdDev } from './stats';

/** Solana plus the EVM chains — the Scout runs one book per chain. */
export type ScoutChain = 'solana' | EvmChainKind;

export const SCOUT_CHAINS: ScoutChain[] = ['solana', 'robinhood', 'bnb'];

/** Windows a user can ask for. `all` is everything still on disk. */
export type ScoutWindow = 'day' | 'week' | 'month' | 'all';

export const SCOUT_WINDOW_DAYS: Record<ScoutWindow, number | null> = {
  day: 1,
  week: 7,
  month: 30,
  all: null,
};

export const SCOUT_WINDOW_LABEL: Record<ScoutWindow, string> = {
  day: 'Today',
  week: '7 days',
  month: '30 days',
  all: 'All time',
};

/** Below this many closed round trips a wallet is not ranked. */
export const MIN_TRIPS_FOR_RANK = 5;

/** Days of history kept per wallet. Older buckets roll off. */
export const SCOUT_RETENTION_DAYS = 45;

/**
 * The book has two tiers per chain (2026-10-22), each with its own cap, so
 * the flood of new addresses can never push out a wallet with a record:
 *
 *   · RANKED wallets (`MIN_TRIPS_FOR_RANK` or more closed trips): up to
 *     `SCOUT_MAX_TRACKED`, least recently active evicted past it;
 *   · CANDIDATES (thinner): up to `SCOUT_MAX_CANDIDATES`, least recently
 *     TOUCHED evicted first — evicting a candidate never touches a ranked row.
 *
 * Measured on the 09-16 tape with the live feed on: one shared 6,000 cap
 * filled in 52–95 minutes and turned into a first-in-first-out of
 * high-frequency wallets — a slow human never reached five trips before
 * being pushed out. Saved wallets are never evicted from either tier.
 * Named here so the page can say "capped" instead of leaving a round number
 * to look like a scan that stopped.
 */
export const SCOUT_MAX_TRACKED = 6_000;
export const SCOUT_MAX_CANDIDATES = 25_000;

/** How far back a manual scan reaches; 168 is the winners scan's week. */
export type ScoutScanHours = 1 | 6 | 24 | 168;
export const SCOUT_SCAN_HOURS: ScoutScanHours[] = [1, 6, 24];
/**
 * What a manual scan reads (2026-10-27).
 *   recent   the tokens trading right now, the last N hours — Discover's
 *            Graduating, Migrated and New columns, a few pages each.
 *   winners  the coins that went UP this week and kept a market, the whole
 *            week of each, every signing trader on them. The search that
 *            found the week's two copyable wallets (docs/copy-candidates-
 *            2026-10-27.md) worked this way round: one coin's week prices a
 *            lagged copy of every wallet on it, so a few thousand credits
 *            judge thousands of wallets, and the wallets that made money on
 *            the coins that went up are where a copy could have made any.
 *            Solana only, the chain only (no swap-API fallback: a week of a
 *            coin is 200 pages, not three).
 */
export type ScoutScanMode = 'recent' | 'winners';
export const SCOUT_WINNERS_HOURS: ScoutScanHours = 168;

/**
 * The Solana scan's shape, shared so the page can say what a scan costs.
 *
 * swap-api.pump.fun blocks an IP for ~35 s after roughly 22 requests in a
 * short window (measured 2026-09-21, see the `pumpswap` entry in
 * electron/data/http.ts — the provider gap there IS this pace, pinned equal
 * by test). At one request every 2 s, 60 tokens are two minutes when most
 * need one page and up to six when every one needs three.
 */
export const SOLANA_SCAN_MAX_TOKENS = 60;
export const SOLANA_SCAN_MAX_PAGES = 3;
export const SOLANA_SCAN_GAP_MS = 2_000;
/**
 * What one chain page costs, credits: `addressTxCredits(100)` in
 * electron/chain/rpcClient.ts (10 a hundred transactions, vendor table read
 * 10-23), pinned equal by test so the page's price is the meter's.
 */
export const SCAN_PAGE_CREDITS = 10;
/** The most a recent scan can spend from the chain, credits; what the chain
 *  does not read, pump.fun's history reads for free. */
export function recentScanCredits(): number {
  return SOLANA_SCAN_MAX_TOKENS * SOLANA_SCAN_MAX_PAGES * SCAN_PAGE_CREDITS;
}

/**
 * The winners scan's shape (2026-10-27). Each coin is read to
 * WINNERS_SCAN_MAX_PAGES pages of a hundred transactions, about 10 credits a
 * page: a coin younger than the week from its first trade, an older one for
 * its newest pages. The coins come from Jupiter's token lists, pump-launched
 * only (the app can price and copy those): young ones that already hold a
 * market, by market cap, then runners with real volume. The thresholds are
 * the ones the week's search used; 24 coins are 48,000 credits at most.
 */
export const WINNERS_SCAN_MAX_PAGES = 200;
export const WINNERS_SCAN_YOUNG = 16;
export const WINNERS_SCAN_RUNNERS = 8;
export const WINNERS_SCAN_MAX_COINS = WINNERS_SCAN_YOUNG + WINNERS_SCAN_RUNNERS;
export const WINNERS_YOUNG_MAX_DAYS = 14;
export const WINNERS_YOUNG_MIN_MCAP = 150_000;
export const WINNERS_YOUNG_MIN_LIQUIDITY = 20_000;
export const WINNERS_RUNNER_MAX_DAYS = 90;
export const WINNERS_RUNNER_MIN_MCAP = 1_000_000;
export const WINNERS_RUNNER_MIN_VOL24 = 500_000;
/** The most one coin of a winners scan can cost, credits — reserved before its read. */
export function winnersCoinCredits(): number {
  return WINNERS_SCAN_MAX_PAGES * SCAN_PAGE_CREDITS;
}
/** The most a winners scan of `coins` coins can spend, credits. */
export function winnersScanCredits(coins: number): number {
  return coins * winnersCoinCredits();
}
/** How many coins `left` credits of allowance can read in full, at most WINNERS_SCAN_MAX_COINS. */
export function winnersCoinsAffordable(left: number): number {
  return Math.max(0, Math.min(WINNERS_SCAN_MAX_COINS, Math.floor(Math.max(0, left) / winnersCoinCredits())));
}
/**
 * The week as a whole, on the board (2026-10-27): the mean without the best
 * SCOUT_TRIMMED_DROP copies needs SCOUT_TRIMMED_MIN_COPIES to say anything.
 */
export const SCOUT_TRIMMED_DROP = 5;
export const SCOUT_TRIMMED_MIN_COPIES = 10;

/** A token as Jupiter's lists describe it — the fields the picker reads. */
export interface WinnerCandidate {
  id: string;
  symbol?: string;
  launchpad?: string;
  mcap?: number;
  liquidity?: number;
  /** 24 h buy plus sell volume, USD. */
  vol24?: number;
  /** When its first pool opened: ISO time or epoch ms. */
  createdAt?: string | number | null;
}
export interface WinnerCoin {
  mint: string;
  symbol: string;
  kind: 'young' | 'runner';
  ageDays: number;
  mcap: number;
  liquidity: number;
  vol24: number;
}
const isPumpCandidate = (t: WinnerCandidate): boolean => t.id.endsWith('pump') || /pump/i.test(t.launchpad ?? '');
const candidateNumber = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
function candidateAgeDays(t: WinnerCandidate, now: number): number | null {
  const c = t.createdAt;
  const ms = typeof c === 'number' ? c : typeof c === 'string' && c ? Date.parse(c) : NaN;
  return Number.isFinite(ms) ? (now - ms) / 86_400_000 : null;
}
/**
 * The coins a winners scan reads, best first: young coins by market cap,
 * then runners by volume, pump-launched only, each once. A coin whose age is
 * unknown is left out rather than guessed young.
 */
export function pickWinnerCoins(tokens: readonly WinnerCandidate[], now = Date.now()): WinnerCoin[] {
  const seen = new Set<string>();
  const young: WinnerCoin[] = [];
  const runners: WinnerCoin[] = [];
  for (const t of tokens) {
    if (!t.id || seen.has(t.id) || !isPumpCandidate(t)) continue;
    seen.add(t.id);
    const ageDays = candidateAgeDays(t, now);
    if (ageDays === null || ageDays < 0) continue;
    const coin: WinnerCoin = {
      mint: t.id,
      symbol: t.symbol || t.id.slice(0, 6),
      kind: 'young',
      ageDays: Math.round(ageDays * 10) / 10,
      mcap: candidateNumber(t.mcap),
      liquidity: candidateNumber(t.liquidity),
      vol24: candidateNumber(t.vol24),
    };
    if (ageDays <= WINNERS_YOUNG_MAX_DAYS) {
      if (coin.mcap >= WINNERS_YOUNG_MIN_MCAP && coin.liquidity >= WINNERS_YOUNG_MIN_LIQUIDITY) young.push(coin);
    } else if (ageDays <= WINNERS_RUNNER_MAX_DAYS && coin.mcap >= WINNERS_RUNNER_MIN_MCAP && coin.vol24 >= WINNERS_RUNNER_MIN_VOL24) {
      runners.push({ ...coin, kind: 'runner' });
    }
  }
  young.sort((a, b) => b.mcap - a.mcap);
  runners.sort((a, b) => b.vol24 - a.vol24);
  return [...young.slice(0, WINNERS_SCAN_YOUNG), ...runners.slice(0, WINNERS_SCAN_RUNNERS)];
}

/** Signatures a chain read of one wallet asks for (electron/engine/walletHistory.ts). */
export const WALLET_READ_LIMIT = 200;

// ── Board filters (2026-09-21) ────────────────────────────────────────
//
// The board ranked but never filtered, so the first screen was mostly
// wallets nobody should copy: three-trade records, bots out in six seconds,
// and wallets whose trips a follower could never have been inside. Sorting
// cannot remove those — only a filter can, and the user has to be able to
// see what was removed and put it back.
//
// Every filter is OFF by default. The board shows what was recorded; hiding
// rows is the user's choice, and the count line always says how many are
// hidden. Pure functions here so the page and the test agree on what each
// switch means (test/walletscout.test.mjs).

/**
 * Hold time under which a wallet is "too fast to copy".
 *
 * The same number as `COPY_LATENCY_FLOOR_MS` in shared/copytrade.ts and the
 * same reasoning: the median leader holds six seconds, their edge is latency,
 * and latency is the one thing a follower cannot copy
 * (docs/wallet-convergence-2026-09-14.md). The two constants are pinned equal
 * by test — they are one fact with two readers, not two settings.
 */
export const SCOUT_SLOW_ENOUGH_MS = 60_000;
/**
 * A wallet whose measured trips are over inside a minute at or above this
 * share is a FAST wallet (2026-10-25): the live feed's marks give it no
 * follower figure at all. The marks fill a copy at the last print the feed
 * carried before its due time, and on a trade that lasts seconds that print
 * is the leader's own, or stale — one wallet read +17 % over 12 feed-seen
 * trips while the chain's replay of its newest 30 read −21 %. Only the chain
 * prices such a wallet (the copy replay, the board's chain check). The same
 * share hides it under the `slowEnough` filter.
 */
export const SCOUT_FAST_WALLET_PCT = 50;
/** Reachable share under which a follower was locked out of most trips — the
 *  same 25 % the `unreachable` flag uses (shared/walletScore.ts). */
export const SCOUT_REACHABLE_MIN_PCT = 25;
/** Days of the window a wallet must have traded on to count as regular. */
export const SCOUT_REGULAR_DAYS = 3;
/**
 * Trades inside one minute that no person clicks (2026-10-24). One every
 * 1.5 s for a full minute. The hold rule missed partial-selling scalpers:
 * BwWK1 made 156 trades in 87 s over 6 closed trips and was shown as a human
 * (docs/wallet-finder-research-2026-10-22.md P2). A single minute is enough —
 * a person does not do it even once.
 */
export const BOT_TRADES_PER_MIN = 40;

export type ScoutFilter = 'hideBots' | 'ranked' | 'reachable' | 'slowEnough' | 'regular' | 'clean';
export const SCOUT_FILTERS: ScoutFilter[] = ['hideBots', 'ranked', 'reachable', 'slowEnough', 'regular', 'clean'];

/** What each switch is called and what it actually does, in plain words. */
export const SCOUT_FILTER_TEXT: Record<ScoutFilter, { label: string; why: string }> = {
  hideBots: {
    label: 'No bots',
    why: `Hides wallets that hold for seconds and trade constantly, or that made ${BOT_TRADES_PER_MIN} or more trades inside one minute. A bot wins on speed you do not have, so copying one is not the same trade.`,
  },
  ranked: {
    label: 'Enough trades',
    why: `Hides wallets with fewer than ${MIN_TRIPS_FOR_RANK} finished round trips in this window. Under that it is luck, not a record.`,
  },
  reachable: {
    label: 'You could have copied',
    why: `Hides wallets where a copier could have been inside fewer than ${SCOUT_REACHABLE_MIN_PCT}% of the trips. The rest were over before a follower could land.`,
  },
  slowEnough: {
    label: 'Holds over a minute',
    why: 'Hides wallets whose typical trade is over inside a minute. Longer holds are not more profitable — they are just possible to follow.',
  },
  regular: {
    label: 'Trades most days',
    why: `Hides wallets active on fewer than ${SCOUT_REGULAR_DAYS} days of the window. A wallet that traded once is not a wallet you can follow.`,
  },
  clean: {
    label: 'No hard exclusions',
    why: 'Hides wallets whose record is not a trading record: coin creators, wallets that bought inside a launch bundle or within five slots of a coin’s first trade, wallets that bought and sold a coin inside one transaction, and wallets whose transactions another wallet pays for. Each of these sells into buyers it brought — copies included. A wallet the chain has not been checked on is not hidden.',
  },
};

/** Every switch on: the one-click "show me the ones worth a look" preset. */
export const scoutFiltersAllOn = (): Record<ScoutFilter, boolean> => ({ hideBots: true, ranked: true, reachable: true, slowEnough: true, regular: true, clean: true });
export const scoutFiltersAllOff = (): Record<ScoutFilter, boolean> => ({ hideBots: false, ranked: false, reachable: false, slowEnough: false, regular: false, clean: false });
export const anyScoutFilter = (f: Record<ScoutFilter, boolean>): boolean => SCOUT_FILTERS.some((k) => f[k]);

/**
 * Does this row survive one filter?
 *
 * UNKNOWN NEVER HIDES A ROW. A wallet whose reachable share or median hold
 * has not been measured is not a wallet that failed the test — it is one the
 * test could not be run on, and hiding it would quietly claim a fact nobody
 * has. The same rule the whole app follows for a missing number.
 */
export function passesScoutFilter(r: ScoutRow, k: ScoutFilter): boolean {
  if (k === 'hideBots') return !r.looksAutomated;
  if (k === 'ranked') return r.ranked;
  if (k === 'clean') return hardExclusions(r).length === 0;
  if (k === 'reachable') return r.reachablePct === null || r.reachablePct >= SCOUT_REACHABLE_MIN_PCT;
  if (k === 'slowEnough') {
    if (r.medianHoldMs !== null) return r.medianHoldMs >= SCOUT_SLOW_ENOUGH_MS;
    // No median yet (under four holds this session — a record saved before
    // the holds were): the share of trips over inside a minute answers the
    // same question from the day buckets, once there are enough of them.
    // 83 % under a minute read as "unknown" and passed, 2026-10-22.
    if (r.fastPct !== null && r.roundTrips >= MIN_TRIPS_FOR_RANK) return r.fastPct < SCOUT_FAST_WALLET_PCT;
    return true;
  }
  // Unknown until the market has been watched that many days (2026-10-22):
  // a record two days old cannot show three active days, and hiding every
  // wallet for it left "Best to copy" empty by construction.
  return r.spanDays < SCOUT_REGULAR_DAYS || r.activeDays >= SCOUT_REGULAR_DAYS;
}

/** The rows a set of switches leaves standing, in the order they came. */
export function applyScoutFilters(rows: readonly ScoutRow[], f: Record<ScoutFilter, boolean>): ScoutRow[] {
  const on = SCOUT_FILTERS.filter((k) => f[k]);
  if (!on.length) return [...rows];
  return rows.filter((r) => on.every((k) => passesScoutFilter(r, k)));
}

/**
 * The wallets the app SUGGESTS (follow wizard, Home), from rows already
 * ranked on "least bad": exactly what "Best to copy" shows — all five
 * filters — and only those with the copied trips a ranking needs
 * (2026-10-22). They used to take any ranked non-bot with a score, so the
 * wizard recommended wallets the board hid, one of them a wallet whose every
 * priced copy lost a third or more.
 */
export function shortlist(rows: readonly ScoutRow[], n: number): ScoutRow[] {
  return applyScoutFilters(rows, scoutFiltersAllOn())
    .filter((r) => r.fShrunkPct !== null && r.copyScore !== null)
    .slice(0, n);
}

/**
 * Does this row's ranking figure beat a copy that goes nowhere? The fee
 * floor is what a copy returns when the price never moves (fees alone, at
 * the row's size). A wallet under it loses MORE than doing nothing with the
 * same fees: its copies met prices that moved against them. The figure is
 * the lower bound when the row has one (2026-10-25, P1) — a wallet clears
 * the floor when it is likely to, not when its point estimate happens to.
 */
export function clearsFloor(r: Pick<ScoutRow, 'chain' | 'fShrunkPct' | 'sizeSol'> & { fLowerPct?: number | null }): boolean {
  const v = r.fLowerPct ?? r.fShrunkPct;
  return v !== null && v > feeFloorPct(copyCostModel(r.chain, r.sizeSol));
}

/**
 * The shortlist with its verdict (2026-10-25). On every tape measured, the
 * least-bad wallets lose about their fees and the rest lose more; a board
 * that always names a "best" wallet names a loser as a winner once a week.
 * So the suggestion carries whether anyone on it CLEARS THE FEE FLOOR, and
 * the pages say "nobody" when nobody does — the rows stay, labelled least
 * bad, because who NOT to copy is the part the ranking measurably gets right.
 */
export interface ShortlistVerdict {
  rows: ScoutRow[];
  /** Rows whose lower bound beats the fee floor at their size. */
  clears: number;
  /** Nobody on the list beats a copy that goes nowhere. */
  nobody: boolean;
  /** The best ranking figure on the list (the lower bound), %, or null. */
  bestPct: number | null;
  /** The fee floor at the list's size, % (the first row's; null with none). */
  floorPct: number | null;
  /** Rows with RELIABLE_COPIES copies behind them: whose median is its own
   *  evidence rather than mostly the prior. */
  reliable: number;
}

export function shortlistVerdict(rows: readonly ScoutRow[], n: number): ShortlistVerdict {
  const list = shortlist(rows, n);
  const clears = list.filter(clearsFloor).length;
  const first = list[0];
  return {
    rows: list,
    clears,
    nobody: clears === 0,
    bestPct: first ? (first.fLowerPct ?? first.fShrunkPct) : null,
    floorPct: first ? feeFloorPct(copyCostModel(first.chain, first.sizeSol)) : null,
    reliable: list.filter((r) => r.fTrips >= RELIABLE_COPIES).length,
  };
}

/**
 * A chain read of one wallet's recent swaps into the record (2026-09-21).
 * Solana only; polled, cancellable. Fills in "what they did"; the copy
 * figures still need the feed or a scan to see other wallets' prints.
 */
export interface WalletReadStatus {
  chain: 'solana';
  address: string;
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** Signatures inside the week, after failed ones are dropped. */
  signatures: number;
  /** Transactions asked for so far. */
  read: number;
  /** Decoded as a swap by the wallet. */
  swaps: number;
  /** Swaps that became a record. */
  fed: number;
  /** Swaps the store already had. */
  duplicates: number;
  /** Transactions the RPC could not serve. */
  unreadable: number;
  /** Read fine, not a trade (transfers, claims, mints, LP moves). */
  notSwap: number;
  calls: number;
  cancelled: boolean;
  /** Why it stopped, or what it could not do. Empty while all is well. */
  message: string;
  /** Block time of the oldest and newest swap fed, ms. */
  oldestAt: number | null;
  newestAt: number | null;
  /** How it was read (2026-10-23): Helius's deep read (30 days, 1,000
   *  transactions, seconds) or the standard listing (a week, 200). */
  via?: 'helius' | 'rpc';
  /** The deep read's transaction cap and days back (2026-10-28: a week
   *  check reads deeper), and whether it stopped at the cap with older
   *  transactions still inside the days. */
  depth?: number;
  days?: number;
  truncated?: boolean;
  /** Transactions that moved its tokens under someone else's signature (2026-10-28). */
  unsigned?: number;
}
export const SCOUT_SCAN_HOURS_LABEL: Record<ScoutScanHours, string> = { 1: '1 hour', 6: '6 hours', 24: '24 hours', 168: '7 days' };

/**
 * One manual scan, per chain. The record is fed from live decoders while the
 * collector runs; a scan reads the SAME trades from a historical source and
 * feeds them the same way, so a fresh install has a board before the feed has
 * been on for a day. Everything here is a count of something that happened.
 */
export interface ScoutScanStatus {
  chain: ScoutChain;
  running: boolean;
  /** Epoch ms of the last start, or null when never run this session. */
  startedAt: number | null;
  finishedAt: number | null;
  hours: ScoutScanHours;
  /** Units of work — tokens on Solana, block chunks on the EVM chains. */
  units: number;
  unitsDone: number;
  /** Trades read from the source. */
  read: number;
  /** Trades that became a record. */
  fed: number;
  /** Trades the store already had (the live feed saw them). */
  duplicates: number;
  /** Provider / RPC calls spent. */
  calls: number;
  /** Wallets on record before and after, so the result line can say what changed. */
  trackedBefore: number;
  trackedAfter: number;
  cancelled: boolean;
  /** Why it stopped, or what it could not read. Empty while all is well. */
  message: string;
  /** Units only partly read — a token busier than the scan's page cap over
   *  the window gives its newest trades only (2026-10-24). */
  unitsPartial: number;
  /** Units not read at all (a parked provider that outlasted the waits, a
   *  block range the RPC refused). */
  unitsUnread: number;
  /** Waiting out a parked provider until then, or null. */
  waitingUntil: number | null;
  /** Solana (2026-10-24): tokens read from the chain through Helius and from
   *  pump's swap API, the chain's credits, and why the slower source took
   *  over ('' when it did not). Optional: absent reads as none. */
  viaChain?: number;
  viaPump?: number;
  credits?: number;
  fallbackWhy?: string;
  /** What the scan read (2026-10-27); absent reads as `recent`. */
  mode?: ScoutScanMode;
}

/**
 * One day of one wallet's activity, on one chain.
 *
 * Daily buckets are what make every window cheap and rotation trivial: a week
 * is seven of these added up, and a day older than the retention window is
 * simply dropped.
 */
export interface ScoutDay {
  /** Days since the Unix epoch, local time. */
  day: number;
  buys: number;
  sells: number;
  /** Positions opened AND closed inside this day. */
  roundTrips: number;
  wins: number;
  losses: number;
  /** Realised SOL/ETH/BNB from trips closed this day. */
  pnl: number;
  /** Native put into positions this day. */
  volume: number;
  /**
   * What a FOLLOWER would have got (2026-09-20, shared/walletScore.ts): trips
   * closed this day where a copy could fill both legs at the lag, how many
   * closed up, and each one's net return %. Optional because records written
   * before this existed have none — absent is "not measured", never zero.
   */
  fTrips?: number;
  fWins?: number;
  fReturns?: number[];
  /** Trips closed this day a follower could NOT have been inside: the leader
   *  was out before a fill, or no print ever came to fill at. */
  unreachable?: number;
  /** Trips that opened and closed inside COPY_LATENCY_FLOOR (60 s). */
  fast?: number;
  /** Trips closed since the follower model existed — the denominator for
   *  `fast`. Records from before it have none, and read as unmeasured. */
  measured?: number;
  /** Coins this wallet CREATED this day, from the create events the feed
   *  decodes (2026-10-23). Absent: none seen, never "checked and none". */
  creates?: number;
  /** Trips closed this day on a mayhem-mode coin — known only for coins whose
   *  create the feed saw, so a floor. */
  mayhemTrips?: number;
  /** The most trades this wallet made inside any 60 s of this day
   *  (2026-10-24). Absent on a day recorded before it: unmeasured, not 0. */
  peakPerMin?: number;
}

/** One of a wallet's recent closed trips, for the detail drawer. */
export interface ScoutTrip {
  mint: string;
  openedAt: number;
  closedAt: number;
  /** Native the wallet put in and took out. */
  cost: number;
  pnl: number;
  holdMs: number;
  /** The follower's net return on this trip, %, or null with why. */
  followerReturnPct: number | null;
  /** `unpriced`: read from the wallet's own history, where no market print
   *  exists to price a copy at — unknown, never counted either way. */
  followerNote: 'filled' | 'too-fast' | 'no-entry' | 'no-exit' | 'unpriced';
}

export interface ScoutWallet {
  chain: ScoutChain;
  address: string;
  firstSeen: number;
  lastSeen: number;
  /** Newest first, capped at SCOUT_RETENTION_DAYS. */
  days: ScoutDay[];
  /** Positions open right now — cost only; unrealised is not claimed. */
  openCount: number;
  openCost: number;
  /**
   * Median hold in ms across closed trips, or null below a usable sample.
   * The single most useful signal for "can I actually copy this?" — a wallet
   * whose median hold is two seconds is a bot.
   */
  medianHoldMs: number | null;
  /** Distinct mints traded (a floor once the record's cap is reached). */
  distinctMints?: number;
  /** Newest first, capped. */
  recentTrips?: ScoutTrip[];
  /** Median native spent on the FIRST buy of a position, or null below a
   *  usable sample (2026-10-23) — the "Large size" warning. */
  medianFirstBuy?: number | null;
  /**
   * The days (dayOf) on which the book watched this chain's market — the
   * same list for every wallet on the chain. Absent on a record that predates
   * it; the window then counts in calendar days, as it always did.
   */
  observedDays?: readonly number[];
  /** The chain's word on this wallet (2026-10-25), from the last check. */
  chainLabel?: ChainLabel | null;
  /** A chain read found it never signs its swaps (2026-10-28). */
  neverSigns?: NeverSigns | null;
}

/** A wallet's record over ONE window. Every field is measured. */
export interface ScoutRow {
  chain: ScoutChain;
  address: string;
  window: ScoutWindow;
  buys: number;
  sells: number;
  roundTrips: number;
  wins: number;
  losses: number;
  pnl: number;
  volume: number;
  /** pnl ÷ volume as a percentage, or null when nothing was spent. */
  returnPct: number | null;
  /** wins ÷ roundTrips as a percentage, or null below the sample floor. */
  winRatePct: number | null;
  medianHoldMs: number | null;
  lastSeen: number;
  /** Enough closed trips in this window to be ranked. */
  ranked: boolean;
  /**
   * Holds for seconds and trades constantly — a bot, and not copyable by a
   * person clicking a button. Marked, never silently ranked above a human.
   */
  looksAutomated: boolean;
  /** The most trades inside any one minute of the window, or null when no
   *  day in it was measured. */
  peakPerMin: number | null;

  // ── What a follower would have got (2026-09-20) ────────────────────
  /** Trips a copy could have mirrored at the lag, both legs filled. */
  fTrips: number;
  /** Median follower net return over those, %, at `sizeSol` under the
   *  paper cost model (2026-10-22). Null under five; under SCORE_MIN_F_TRIPS
   *  it is shown as low confidence. */
  fMedianReturnPct: number | null;
  /** Share of those trips that closed up after the same costs, %. */
  fWinRatePct: number | null;
  /**
   * The ranking figure: the median pulled toward the whole market's by how
   * few trips stand behind it, (n·median + 10·market) ÷ (n + 10), at the
   * size. Null under SCORE_MIN_F_TRIPS copied trips. On held-out tape its top
   * tenth was the least-bad selection tried — still a loss (−4.7 %).
   */
  fShrunkPct: number | null;
  /**
   * What the board RANKS on (2026-10-25, P1): the lower 80 % bound of the
   * shrunk median, shrunk − 0.84·σ/√(n + k), at the size. The top of a raw
   * ranking is where the luckiest thin records land; the bound asks each
   * wallet how sure its figure is before placing it. Null with fShrunkPct.
   */
  fLowerPct: number | null;
  /**
   * The week as a whole, at the size (2026-10-27): the copied trips'
   * returns added up, %, and what that is in SOL for copies of `sizeSol`
   * (null with no size). Null under MIN_TRIPS_FOR_RANK copied trips and on
   * a fast wallet, like the median. The week's search ranked on this and
   * found what the median never will: a positive total over a negative
   * median is a wallet carried by a few trades, and the figure after this
   * one says what is left without them.
   */
  fSumPct: number | null;
  fTotalSol: number | null;
  /** The mean of the copied trips' returns without the best
   *  SCOUT_TRIMMED_DROP, %; null under SCOUT_TRIMMED_MIN_COPIES copies. Near
   *  zero or better, with a positive total, is the bar for a paper week. */
  fTrimmedMeanPct: number | null;
  /** The prior that shrinkage used: k copies toward μ, measured from the
   *  week's universe when `wallets` > 0, the fixed constants otherwise. */
  shrink: { k: number; muPct: number; wallets: number };
  /** What the Copy score is built on: the same figures without the fixed
   *  fees, so the score does not move with the size picked. */
  basis: { shrunkPct: number | null; lowerPct: number | null; winRatePct: number | null };
  /** The copy size the figures are priced at, or null (no fixed fees). */
  sizeSol: number | null;
  /** The fixed fees' share of that copy on a round trip, %. */
  fixedCostPct: number;
  /** fTrips ÷ judged trips, %, where judged = filled + unreachable (a trip
   *  still waiting for its exit print is neither). Null when nothing has
   *  been judged — a record from before the follower model is not 0 %. */
  reachablePct: number | null;
  /** Trips judged so far: the denominator behind `reachablePct`. */
  judgedTrips: number;
  /** Share of measured trips that opened and closed inside a minute, %. */
  fastPct: number | null;
  /**
   * `fastPct` at or over SCOUT_FAST_WALLET_PCT on a measured sample
   * (2026-10-25): every follower figure above is null, whatever the marks
   * read, because the marks cannot price a copy of trades that short. The
   * chain can — see `chainLabel` and the profile's replay.
   */
  fastWallet: boolean;
  /** Days of the window with a finished trade. */
  activeDays: number;
  /** Days of the window the market was watched — what `activeDays` is out
   *  of. Under SCOUT_REGULAR_DAYS, "trades most days" cannot be judged. */
  spanDays: number;
  distinctMints: number;
  /** The Copy score, 0..100 — least-bad to follow, never an edge. */
  copyScore: number | null;
  flags: WalletFlag[];
  /** Warnings (2026-10-23): shown on the row, never a filter — see
   *  SCOUT_WARNING_TEXT for each rule and the evidence behind it. */
  warnings: ScoutWarning[];
  /** Coins they created in the window (a floor: creates the feed saw). */
  createdCoins: number;
  /** Their finished trips in the window on mayhem-mode coins (a floor). */
  mayhemTrips: number;
  medianFirstBuy: number | null;
  /** What the chain said when this wallet was checked (2026-10-25), or
   *  null: not checked yet. Optional so a row built before it still reads. */
  chainLabel?: ChainLabel | null;
  /** A chain read found it never signs its swaps (2026-10-28): not a trader. */
  neverSigns?: NeverSigns | null;
}

// ── Chain labels and hard exclusions (2026-10-25) ─────────────────────
//
// The record only sees the trades the feed carried, so it over-ranks wallets
// whose coins survived (10 recorded trips against 23 on the chain for one
// wallet-day, the extras mostly −85 to −100 %). A CHAIN LABEL is the same
// wallet read from the chain: every finished trip in the window, a uniform
// random sample of them priced as copies (unbiased, where "the newest 30"
// is not), how much of it the record had seen, and the four checks that say
// a record is not a trading record at all. The board ranks on the record and
// shows the label beside it; the hard exclusions below hide a wallet from
// "Best to copy" and the suggestions.
//
// The exclusions are the proof-grade ones from the 10-25 research
// (reports/Finding copyable Solana wallets weekly.md §Adversarial filter
// layer). Bundle: Bitquery's rule — bought inside the launch transaction or
// in the four transactions after it in the same slot — was checked against
// the public Jito record: 185 of 186 such buys were in the launch bundle,
// none of 139 further down. Wash: a buy and a sell of one coin inside ONE
// transaction, which has no honest use on a bonding curve. Shared payer:
// another wallet pays this one's fees, so they are one operation. Sniper:
// opened within SNIPER_SLOTS of the coin's first trade — informed early
// buyers whose edge is the first seconds; devs sell within a minute on 65 %
// of launches, and a copy two seconds behind buys from the seller.

export type HardExclusion = 'creator' | 'bundle' | 'sniper' | 'wash' | 'sharedPayer' | 'notSigner';

// ── Never signs (2026-10-28) ─────────────────────────────────────────
//
// The release check found the board's top "Best to copy" wallet had made 443
// buys in the record and signed none of them on the chain: an account inside
// another program's pool transactions (its tokens move, someone else signs).
// The chain scans drop such trades since 10-27 (`ChainTrade.signer`), but the
// live feed's log notifications carry no account keys, so it cannot tell, and
// records made before 10-27 keep theirs. Any chain read of the wallet — a
// profile, Check, the board labeler — counts the transactions where its
// tokens moved under someone else's signature; enough of those and no signed
// swap at all marks it. A later read that finds a signed swap clears it.

/** Transactions a read must cover before "never signs" can be said. */
export const NEVER_SIGNS_MIN_READ = 20;
/** …of which at least this many moved its tokens under another signer. */
export const NEVER_SIGNS_MIN_UNSIGNED = 10;

export interface NeverSigns {
  /** When the chain was read. */
  at: number;
  /** Transactions the read covered. */
  read: number;
  /** Of them, the ones that moved its tokens under someone else's signature. */
  unsigned: number;
}

/** What a finished read says: marked, cleared (it signed a swap), or nothing to say. */
export function neverSignsFrom(read: number, swaps: number, unsigned: number, at: number): NeverSigns | 'clear' | null {
  if (swaps > 0) return 'clear';
  if (read >= NEVER_SIGNS_MIN_READ && unsigned >= NEVER_SIGNS_MIN_UNSIGNED) return { at, read, unsigned };
  return null;
}

const SCOUT_WARNING_TEXT_CREATOR_WHY =
  'Created a coin in this window. On the 09-16 tape, copies of wallets that launch coins did worse than any other label: −16.2 % a copy against −9.5 % for everyone else. A creator can sell into the buyers their own launch attracts — copies included.';

/** A trip opened this many slots or fewer after the coin's first trade is a snipe. */
export const SNIPER_SLOTS = 5;
/** Snipes at or over this share of the checked trips exclude the wallet… */
export const SNIPER_SHARE_PCT = 20;
/** …on at least this many. */
export const SNIPER_MIN_TRIPS = 2;
/** Same-transaction round trips at or over this many exclude the wallet. */
export const WASH_MIN_TRIPS = 2;
/** Distinct other fee payers at or over this many exclude the wallet. */
export const SHARED_PAYERS_MIN = 2;

export interface ChainLabel {
  /** When the chain was read. */
  at: number;
  /** Finished trips the chain read found in the window. */
  chainTrips: number;
  /** Trips priced as copies: a uniform random sample of `chainTrips`. */
  sampled: number;
  /** Of the sample, trips both legs of which were priced. */
  priced: number;
  /** Median follower return over the priced sample, recorded model
   *  (1.5 %/side, no fixed fees), %; null under five. */
  medianPct: number | null;
  /** Share of the chain's trips the record had seen, %; null when the
   *  record's window could not be matched. */
  coveragePct: number | null;
  /** Of the trips the record had NOT seen, the share that ended near a
   *  total loss, %; null when it could not be told apart. */
  unseenDeadPct: number | null;
  /** Buys and sells of one coin inside one transaction, over the window. */
  washTrips: number;
  /** Distinct fee payers other than the wallet, over the window. */
  sharedPayers: number;
  /** Of the trips whose coin was checked, those opened within SNIPER_SLOTS
   *  of the coin's first trade. */
  sniperTrips: number;
  /** Of those, bought inside the launch transaction or the four after it. */
  bundleTrips: number;
  /** Trips whose coin's birth was read. */
  mintsChecked: number;
  /** Helius credits the check spent. */
  credits: number;
}

/** The board labeler's progress (electron/engine/boardLabeler.ts), polled. */
export interface LabelStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** Wallets chosen this run, how many are done, how many got a label. */
  total: number;
  done: number;
  labelled: number;
  /** Of the labelled, how many carry a hard exclusion. */
  excluded: number;
  /** Credits this run spent. */
  credits: number;
  /** Wallets being replayed right now. */
  current: string[];
  cancelled: boolean;
  /** Why it stopped early or did less than asked. Empty while all is well. */
  message: string;
}

export const HARD_EXCLUSION_TEXT: Record<HardExclusion, { label: string; why: string }> = {
  creator: { label: 'Creates coins', why: SCOUT_WARNING_TEXT_CREATOR_WHY },
  bundle: {
    label: 'Launch bundle',
    why: 'Bought a coin inside its launch transaction, or in the four transactions right after it in the same slot. Checked against the public Jito record, 185 of 186 such buys were part of the launch bundle. This wallet is on the launching side; its "trades" are the launch.',
  },
  sniper: {
    label: 'Sniper',
    why: `Opened ${SNIPER_SHARE_PCT}% or more of its checked trades within ${SNIPER_SLOTS} slots (about a second) of the coin's first trade. That edge is the first seconds; a copy two seconds behind buys from a seller who is already leaving — 55 % of such wallets are fully out inside a minute.`,
  },
  wash: {
    label: 'Wash trades',
    why: 'Bought and sold the same coin inside one transaction, more than once. There is no honest reason to do that on a bonding curve; it is how a wallet buys itself a record.',
  },
  sharedPayer: {
    label: 'Shared payer',
    why: 'Other wallets pay this one’s transaction fees. A wallet whose fees someone else pays is one hand of a larger operation, and its record is that operation’s, not a trader’s.',
  },
  notSigner: {
    label: 'Never signs',
    why: 'A chain read found this wallet signed none of the swaps it was in: its tokens moved inside other wallets’ transactions. The trades the record credits to it were not its own — most likely it is an account a pool, router or market maker uses — so there is nothing of its own to copy.',
  },
};

/** The hard exclusions a row carries. A wallet the chain has not checked
 *  carries only what the record itself can see (creator). */
export function hardExclusions(r: { createdCoins?: number; chainLabel?: ChainLabel | null; neverSigns?: NeverSigns | null }): HardExclusion[] {
  const out: HardExclusion[] = [];
  if ((r.createdCoins ?? 0) > 0) out.push('creator');
  if (r.neverSigns) out.push('notSigner');
  const l = r.chainLabel;
  if (!l) return out;
  if (l.bundleTrips >= 1) out.push('bundle');
  if (l.mintsChecked >= SNIPER_MIN_TRIPS && l.sniperTrips >= SNIPER_MIN_TRIPS && (l.sniperTrips / l.mintsChecked) * 100 >= SNIPER_SHARE_PCT) out.push('sniper');
  if (l.washTrips >= WASH_MIN_TRIPS) out.push('wash');
  if (l.sharedPayers >= SHARED_PAYERS_MIN) out.push('sharedPayer');
  return out;
}

// ── Warnings (2026-10-23) ─────────────────────────────────────────────
//
// The ranking cannot find a wallet that is profitable to copy; what it does
// measurably well is say who NOT to copy. These are the labels that held up
// on the tape (docs/wallet-finder-research-2026-10-22.md §4, the 10-23 swarm
// §4). They are CHIPS: a row that carries one is still listed, because each
// rests on one tape and none has been confirmed on a second, pre-registered
// pair yet. Bot and long-holder are left out on purpose — on 10-23 neither
// replicated as a loss predictor.

export type ScoutWarning = 'creator' | 'mayhem' | 'largeSize';

/** Median first buy at or over this (SOL) is "Large size". */
export const SCOUT_LARGE_SIZE_SOL = 2;
/** Mayhem share of finished trips at or over this, %… */
export const SCOUT_MAYHEM_SHARE_PCT = 25;
/** …on at least this many trips. */
export const SCOUT_MAYHEM_MIN_TRIPS = 2;

export const SCOUT_WARNING_TEXT: Record<ScoutWarning, { label: string; why: string }> = {
  creator: {
    label: 'Creates coins',
    why: SCOUT_WARNING_TEXT_CREATOR_WHY,
  },
  mayhem: {
    label: 'Mayhem coins',
    why: `A quarter or more of their finished trades (${SCOUT_MAYHEM_MIN_TRIPS}+) were on mayhem-mode coins. On held-out tape, copies of trades on mayhem coins did 9 to 90 points worse than on standard ones.`,
  },
  largeSize: {
    label: 'Large size',
    why: `Their typical first buy is ${SCOUT_LARGE_SIZE_SOL} SOL or more. Their own buy moves the price before a copy lands, so a copy pays more than they did. Wallets this size copied worse on the tape (−13.6 % against −9.8 %, from only 120 wallets).`,
  },
};

/** The warnings a row earns. Solana only for size: an ETH or BNB first buy
 *  is a different scale, and the tape that measured it was pump's. */
export function scoutWarnings(chain: ScoutChain, x: { createdCoins: number; mayhemTrips: number; roundTrips: number; medianFirstBuy: number | null }): ScoutWarning[] {
  const out: ScoutWarning[] = [];
  if (x.createdCoins > 0) out.push('creator');
  if (x.mayhemTrips >= SCOUT_MAYHEM_MIN_TRIPS && x.roundTrips > 0 && (x.mayhemTrips / x.roundTrips) * 100 >= SCOUT_MAYHEM_SHARE_PCT) out.push('mayhem');
  if (chain === 'solana' && x.medianFirstBuy !== null && x.medianFirstBuy >= SCOUT_LARGE_SIZE_SOL) out.push('largeSize');
  return out;
}

// ── The board's own record (2026-10-23) ───────────────────────────────
//
// Every threshold on this page was fitted on tapes recorded before Alpenglow
// (212 ms slots). Rather than wait for a new tape, the board grades itself:
// when a wallet enters "Best to copy", the moment is written down, and from
// then on every copy of a trip it OPENS after that moment is priced the same
// way the record prices everything. A pick stays in the record for
// SCOUT_PICK_KEEP_DAYS whether or not it stays on the list — dropping the
// ones that fell off would grade the board on its survivors.
//
// The comparison is every copy the record priced over the same time: the
// board earns its place only by beating that, and the page says when it
// does not.

/** How many of the top "Best to copy" rows count as the board's picks. */
export const SCOUT_PICKS_N = 10;
/** Days a pick is followed after it was made. */
export const SCOUT_PICK_KEEP_DAYS = 14;
/** Copies under which the record is shown as too early to read. */
export const SCOUT_RECORD_MIN_COPIES = 20;

export interface ScoutPick {
  address: string;
  pickedAt: number;
  /** The shrunk median at the moment of the pick (score basis, %). */
  shrunkPct: number | null;
  /** The lower bound it was ranked on at the pick (2026-10-25, P1). */
  lowerPct?: number | null;
  /**
   * A SHADOW selection (2026-10-25, P1), tracked exactly like a pick and
   * never suggested: `lead` is the top N by the wallets' OWN profit — what
   * every other copy tool ranks on; `next` the N just under the board's
   * picks in its own ranking (the research's "decile 9"). Absent = a pick.
   */
  arm?: 'lead' | 'next';
  fTripsAtPick: number;
  /** Follower returns (recorded 1.5 %/side model, %) of trips the wallet
   *  OPENED after `pickedAt` — what a copy started after the pick got. */
  returns: number[];
  /** When each of `returns` was opened (ms), same order — so a copy belongs
   *  to a WEEK (2026-10-25). Absent on a record from before it. */
  at?: number[];
}

/** One priced copy in the comparison sample: [openedAt, recorded return %,
 *  a short key of the wallet]. The key (2026-10-25) lets a week be judged
 *  against random draws of N wallets, not just against the pooled universe.
 *  Older entries have no key. */
export type BaselineEntry = readonly [number, number] | readonly [number, number, string];

/** The UTC Monday 00:00 that starts the week holding `ms`, in ms. */
export function weekOf(ms: number): number {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

/** A small seeded generator (mulberry32), so a random-N band is repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The mean with the bottom and top `share` of values clipped to the values
 *  at those ranks: a P&L figure one +1,461 % copy cannot decide. */
export function winsorisedMean(xs: readonly number[], share = 0.05): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const k = Math.floor(v.length * share);
  const lo = v[k];
  const hi = v[v.length - 1 - k];
  let sum = 0;
  for (const x of v) sum += Math.min(hi, Math.max(lo, x));
  return sum / v.length;
}

/**
 * The universe's ranking figures at a week's start (2026-10-25, P1), so the
 * week can grade the RANKING and not only the picks: a Spearman between the
 * score at the boundary and the realised median over every wallet with
 * both, and the probability of backtest overfitting across the variants of
 * k and z the ranker could have used. Rows: [wallet key, one figure per
 * variant], recorded model, the live ranker's column first.
 */
export interface ScoreSnapshot {
  week: number;
  at: number;
  variants: string[];
  rows: Array<[string, ...Array<number | null>]>;
}
export const SNAPSHOT_KS = [5, 10, 25, 64] as const;
export const SNAPSHOT_ZS = [0, 0.84, 1.28] as const;
export const SNAPSHOT_LIVE = 'live';
export function snapshotVariants(): string[] {
  const out = [SNAPSHOT_LIVE];
  for (const k of SNAPSHOT_KS) for (const z of SNAPSHOT_ZS) out.push(`k${k}z${z}`);
  return out;
}
/** One wallet's snapshot row: its lower bound under the live prior, then
 *  under each fixed (k, z) with the live μ and σ. */
export function snapshotRow(key: string, median: number, n: number, prior: ShrinkPrior, bucket: string | null): [string, ...Array<number | null>] {
  const cells: Array<number | null> = [shrinkWith(median, n, prior, bucket).lower];
  for (const k of SNAPSHOT_KS) for (const z of SNAPSHOT_ZS) cells.push(shrinkWith(median, n, { ...prior, k }, bucket, z).lower);
  return [key, ...cells];
}

/**
 * The mark after a copy's fill (2026-10-25, P1): [opened at, seconds after
 * the fill, the move since the fill in %, wallet key]. The betting world's
 * closing-line value: a selection whose fills are under water half a minute
 * later is paying for crowding whatever its trips end at, and that shows in
 * hundreds of fills rather than tens of weeks.
 */
export type MarkEntry = readonly [number, number, number, string];
export const MARK_HORIZONS_S: readonly number[] = [30, 300];

/** A short key for a wallet, the one the baseline sample and the marks carry. */
export const walletKey8 = (address: string): string => address.toLowerCase().slice(0, 8);

/**
 * One calendar week of the board's record (2026-10-25). The pooled record
 * (boardRecord) mixes picks and spans, so a week that went well and one that
 * went badly cancel out and a hyperactive pick with two thousand trips
 * decides the whole figure; the paired tests the scout's own scorecard needs
 * want one row per week, each against the same week's controls.
 */
export interface BoardWeek {
  /** The week's Monday 00:00 UTC, ms. */
  week: number;
  /** Picks that were on the list at some point in the week. */
  picks: number;
  /** Copies of those picks' trips opened in the week, and their figures at the size. */
  copies: number;
  medianPct: number | null;
  /** 5 %-winsorised mean, %, so one tail copy cannot decide it. */
  meanPct: number | null;
  winRatePct: number | null;
  /** Every priced copy in the week, and its median. */
  baselineCopies: number;
  baselineMedianPct: number | null;
  /** The 5th–95th percentile of the pooled median of SCOUT_PICKS_N wallets
   *  drawn at random from the week's universe, 200 draws; null when fewer
   *  than twice that many wallets traded. The picks have to beat this band
   *  to have beaten luck. */
  randomBand: { lo: number; hi: number; wallets: number } | null;
  /** Enough copies on both sides to read at all. */
  enough: boolean;
  // ── The scorecard's controls (2026-10-25, P1) ──────────────────────
  /** Picks made BEFORE the week began (held another week) and picks made in
   *  it: the difference is what rotation itself is worth. */
  held: { copies: number; medianPct: number | null };
  fresh: { copies: number; medianPct: number | null };
  /** The shadow selections, tracked like picks (ScoutPick.arm). */
  lead: { picks: number; copies: number; medianPct: number | null };
  next: { picks: number; copies: number; medianPct: number | null };
  /** Picks minus everyone, median per copy, with a wallet-clustered
   *  bootstrap 90 % interval; null until both sides have enough. */
  vsEveryone: { diff: number; lo: number; hi: number } | null;
  /** Spearman between the week-start ranking figure and the realised median
   *  over every wallet with both (ten or more); the ranking's own skill. */
  rankRho: { rho: number; wallets: number } | null;
  /** Median move 30 s and 5 min after a copy's fill, picks and everyone. */
  marks: { pick30: number | null; pick300: number | null; all30: number | null; all300: number | null; fills: number };
}

/** How many random draws make the band. */
export const BOARD_RANDOM_DRAWS = 200;

/** What the week needs beyond picks and baseline to grade the ranking. */
export interface BoardExtra {
  shadow?: readonly ScoutPick[];
  snapshots?: readonly ScoreSnapshot[];
  marks?: readonly MarkEntry[];
}

/** A pick's copies opened in [week, end) while it was on the list, repriced. */
function weekCopies(p: ScoutPick, week: number, end: number, m: CopyCostModel): number[] {
  const letGo = p.pickedAt + SCOUT_PICK_KEEP_DAYS * 86_400_000;
  const at = p.at ?? [];
  const out: number[] = [];
  for (let j = 0; j < p.returns.length; j++) {
    const t = at[j];
    // A copy counts while the pick was on the list: after it was made,
    // before it was let go, and in this week.
    if (typeof t === 'number' && t >= week && t < end && t >= p.pickedAt && t < letGo) out.push(repriceReturn(p.returns[j], m));
  }
  return out;
}
/** On the list some time in the week: picked before it ended, not let go before it began. */
const activeIn = (p: ScoutPick, week: number, end: number): boolean => p.pickedAt < end && p.pickedAt + SCOUT_PICK_KEEP_DAYS * 86_400_000 >= week;

/**
 * The board's record by week, newest first, over the last `weeks` weeks
 * including the current one. Copies are repriced at `sizeSol`.
 */
export function boardWeeks(chain: ScoutChain, picks: readonly ScoutPick[], baseline: readonly BaselineEntry[], sizeSol: number | null, now = Date.now(), weeks = 4, extra: BoardExtra = {}): BoardWeek[] {
  const m = copyCostModel(chain, sizeSol);
  const out: BoardWeek[] = [];
  const thisWeek = weekOf(now);
  const armOf = (arm: 'lead' | 'next', week: number, end: number): BoardWeek['lead'] => {
    const rs: number[] = [];
    let n = 0;
    for (const p of extra.shadow ?? []) {
      if (p.arm !== arm) continue;
      if (activeIn(p, week, end)) n += 1;
      rs.push(...weekCopies(p, week, end, m));
    }
    return { picks: n, copies: rs.length, medianPct: pooledMedian(rs) };
  };
  for (let i = 0; i < weeks; i++) {
    const week = thisWeek - i * 7 * 86_400_000;
    const end = week + 7 * 86_400_000;
    const mine: number[] = [];
    const perPick: number[][] = [];
    const heldR: number[] = [];
    const freshR: number[] = [];
    const pickKeys = new Set<string>();
    let active = 0;
    for (const p of picks) {
      if (activeIn(p, week, end)) {
        active += 1;
        pickKeys.add(walletKey8(p.address));
      }
      const rs = weekCopies(p, week, end, m);
      if (!rs.length) continue;
      mine.push(...rs);
      perPick.push(rs);
      (p.pickedAt < week ? heldR : freshR).push(...rs);
    }
    const inWeek = baseline.filter((e) => e[0] >= week && e[0] < end);
    const all = inWeek.map((e) => repriceReturn(e[1], m));
    // The week's wallets with a key: the random-N band, the clusters of the
    // paired interval and the realised side of the rank correlation.
    const byWallet = new Map<string, number[]>();
    const keyless: number[][] = [];
    for (const e of inWeek) {
      const r = repriceReturn(e[1], m);
      if (e.length === 3) byWallet.set(e[2], [...(byWallet.get(e[2]) ?? []), r]);
      else keyless.push([r]);
    }
    let randomBand: BoardWeek['randomBand'] = null;
    const wallets = [...byWallet.values()];
    if (wallets.length >= 2 * SCOUT_PICKS_N) {
      const next = seededRandom(week / 1000);
      const draws: number[] = [];
      for (let d = 0; d < BOARD_RANDOM_DRAWS; d++) {
        const idx = wallets.map((_, k) => k);
        const pool: number[] = [];
        for (let k = 0; k < SCOUT_PICKS_N; k++) {
          const j = k + Math.floor(next() * (idx.length - k));
          [idx[k], idx[j]] = [idx[j], idx[k]];
          pool.push(...wallets[idx[k]]);
        }
        const med = pooledMedian(pool);
        if (med !== null) draws.push(med);
      }
      if (draws.length >= 20) {
        draws.sort((a, b) => a - b);
        randomBand = { lo: draws[Math.floor(draws.length * 0.05)], hi: draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.95))], wallets: wallets.length };
      }
    }
    const enough = mine.length >= SCOUT_RECORD_MIN_COPIES && all.length >= SCOUT_RECORD_MIN_COPIES;
    // Picks against everyone, clustered by wallet on both sides: copies of
    // one wallet rise and fall together, so resampling copies would claim a
    // precision nobody has.
    const vs = enough ? bootstrapMedianDiffCI(perPick, [...wallets, ...keyless], BOARD_RANDOM_DRAWS, week / 1000 + 1) : null;
    // The ranking's skill over the whole universe: the figure each wallet
    // was given at the boundary against the median it went on to realise.
    let rankRho: BoardWeek['rankRho'] = null;
    const snap = extra.snapshots?.find((s) => s.week === week);
    const live = snap ? snap.variants.indexOf(SNAPSHOT_LIVE) : -1;
    if (snap && live >= 0) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const row of snap.rows) {
        const score = row[1 + live];
        const realised = byWallet.get(row[0]);
        if (typeof score !== 'number' || !realised || realised.length < 3) continue;
        xs.push(score);
        ys.push(pooledMedian(realised) as number);
      }
      const rho = xs.length >= 10 ? spearman(xs, ys) : null;
      if (rho !== null) rankRho = { rho, wallets: xs.length };
    }
    const marksIn = (extra.marks ?? []).filter((e) => e[0] >= week && e[0] < end);
    const markMed = (h: number, mine: boolean): number | null => pooledMedian(marksIn.filter((e) => e[1] === h && (!mine || pickKeys.has(e[3]))).map((e) => e[2]));
    out.push({
      week,
      picks: active,
      copies: mine.length,
      medianPct: pooledMedian(mine),
      meanPct: winsorisedMean(mine),
      winRatePct: mine.length ? (mine.filter((r) => r > 0).length / mine.length) * 100 : null,
      baselineCopies: all.length,
      baselineMedianPct: pooledMedian(all),
      randomBand,
      enough,
      held: { copies: heldR.length, medianPct: pooledMedian(heldR) },
      fresh: { copies: freshR.length, medianPct: pooledMedian(freshR) },
      lead: armOf('lead', week, end),
      next: armOf('next', week, end),
      vsEveryone: vs ? { diff: vs.diff, lo: vs.lo, hi: vs.hi } : null,
      rankRho,
      marks: { pick30: markMed(30, true), pick300: markMed(300, true), all30: markMed(30, false), all300: markMed(300, false), fills: marksIn.filter((e) => e[1] === 30).length },
    });
  }
  return out;
}

// ── The scorecard (2026-10-25, P1) ────────────────────────────────────
//
// What makes the scout's skill measurable rather than felt: whether its
// figures are calibrated (does a pick realise what it was ranked at?), how
// its picks decay after it names them (publicising a wallet is itself a
// crowding mechanism), how many paired weeks the spread it has seen needs
// before a gap means anything, and how likely its choice of k and z is to
// be a fit to its own past. Pooled across weeks only as medians of weekly
// figures — never one grand pooled median a hyperactive pick could own.

export interface Scorecard {
  /** realised median = intercept + slope · pick-time shrunk median, over
   *  picks with five or more copies (score basis). Slope under one says the
   *  ranker is under-shrunk (raise k); near one with a negative intercept, a
   *  stale prior (lower μ). */
  calibration: { slope: number; intercept: number; picks: number } | null;
  /** Picks' copies by days since the pick, at the size. */
  decayByAge: Array<{ label: string; copies: number; medianPct: number | null }>;
  /** Paired weeks in hand against the weeks a SCORECARD_GAP_PTS gap needs at
   *  the week-to-week spread seen so far (α 0.05, power 0.8). */
  weeksNeeded: { have: number; need: number; sigmaD: number } | null;
  /** Probability of backtest overfitting over the (k, z) grid, from the
   *  weekly snapshots; null until four graded weeks. */
  pbo: { value: number; weeks: number; variants: number } | null;
  /** The honesty switches, in words, for the page. */
  notes: string[];
}

/** The gap between two selections the paired test is sized for, points. */
export const SCORECARD_GAP_PTS = 4;
export const DECAY_AGES: ReadonlyArray<readonly [string, number, number]> = [
  ['0–2 days', 0, 3],
  ['3–7 days', 3, 8],
  ['8–14 days', 8, 15],
];

export function scorecard(chain: ScoutChain, picks: readonly ScoutPick[], baseline: readonly BaselineEntry[], weeks: readonly BoardWeek[], snapshots: readonly ScoreSnapshot[], sizeSol: number | null): Scorecard {
  const m = copyCostModel(chain, sizeSol);
  const basis = copyCostModel(chain, null);
  // Calibration, on the score basis both sides were measured in.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of picks) {
    if (p.shrunkPct === null || p.returns.length < 5) continue;
    const realised = pooledMedian(p.returns.map((r) => repriceReturn(r, basis)));
    if (realised === null) continue;
    xs.push(p.shrunkPct);
    ys.push(realised);
  }
  const fit = xs.length >= 5 ? linearFit(xs, ys) : null;
  // Decay by age since the pick.
  const decayByAge = DECAY_AGES.map(([label, lo, hi]) => {
    const rs: number[] = [];
    for (const p of picks) {
      const at = p.at ?? [];
      for (let j = 0; j < p.returns.length; j++) {
        const t = at[j];
        if (typeof t !== 'number' || t < p.pickedAt) continue;
        const days = (t - p.pickedAt) / 86_400_000;
        if (days >= lo && days < hi) rs.push(repriceReturn(p.returns[j], m));
      }
    }
    return { label, copies: rs.length, medianPct: pooledMedian(rs) };
  });
  // Weeks needed: the paired difference's week-to-week spread.
  const diffs = weeks.filter((w) => w.enough && w.vsEveryone).map((w) => (w.vsEveryone as { diff: number }).diff);
  const sd = diffs.length >= 2 ? stdDev(diffs) : null;
  const weeksNeeded = sd === null ? null : { have: diffs.length, need: Math.max(3, Math.ceil(((1.96 + 0.84) ** 2 * sd * sd) / SCORECARD_GAP_PTS ** 2)), sigmaD: sd };
  // PBO over the variant grid: each graded week's realised median for the
  // top N under every variant, then combinatorially symmetric CV.
  const matrix: number[][] = [];
  for (const w of [...weeks].sort((a, b) => a.week - b.week)) {
    const snap = snapshots.find((s) => s.week === w.week);
    if (!snap || w.baselineCopies < SCOUT_RECORD_MIN_COPIES) continue;
    const end = w.week + 7 * 86_400_000;
    const byWallet = new Map<string, number[]>();
    for (const e of baseline) if (e.length === 3 && e[0] >= w.week && e[0] < end) byWallet.set(e[2], [...(byWallet.get(e[2]) ?? []), repriceReturn(e[1], m)]);
    const row: number[] = [];
    for (let v = 0; v < snap.variants.length; v++) {
      const top = snap.rows
        .filter((r) => typeof r[1 + v] === 'number')
        .sort((a, b) => (b[1 + v] as number) - (a[1 + v] as number))
        .slice(0, SCOUT_PICKS_N);
      const pool: number[] = [];
      for (const r of top) pool.push(...(byWallet.get(r[0]) ?? []));
      row.push(pool.length >= 5 ? (pooledMedian(pool) as number) : NaN);
    }
    if (row.some((x) => Number.isFinite(x))) matrix.push(row);
  }
  const p = pboOf(matrix);
  const notes: string[] = [];
  if (fit) {
    notes.push(
      fit.slope < 0.8
        ? `Calibration slope ${fit.slope.toFixed(2)} over ${fit.n} picks: picks realise less than they were ranked at — the ranker is under-shrunk (k should rise).`
        : fit.intercept < -2 && Math.abs(fit.slope - 1) < 0.2
          ? `Calibration slope ${fit.slope.toFixed(2)}, intercept ${fit.intercept.toFixed(1)}: the ranking order holds but every pick lands lower — a stale prior (μ should fall).`
          : `Calibration slope ${fit.slope.toFixed(2)} over ${fit.n} picks.`,
    );
  } else notes.push('Calibration: needs five picks with five copies each.');
  if (weeksNeeded) notes.push(weeksNeeded.have < weeksNeeded.need ? `Not enough weeks: ${weeksNeeded.have} of about ${weeksNeeded.need} paired weeks at the spread seen (σ ${weeksNeeded.sigmaD.toFixed(1)} points) to resolve a ${SCORECARD_GAP_PTS}-point gap.` : `${weeksNeeded.have} paired weeks: enough to resolve a ${SCORECARD_GAP_PTS}-point gap at the spread seen (σ ${weeksNeeded.sigmaD.toFixed(1)}).`);
  else notes.push('Not enough weeks: the paired test needs two graded weeks before it can say how many it needs.');
  if (p) notes.push(`Probability the ranker's k and z are fitted to their own past: ${Math.round(p.pbo * 100)}% over ${p.variants} variants and ${p.rows} weeks${p.pbo > 0.5 ? ' — above a half, so the settings are noise until more weeks say otherwise' : ''}.`);
  else notes.push('Overfitting probability: needs four graded weeks with a ranking snapshot.');
  return {
    calibration: fit ? { slope: fit.slope, intercept: fit.intercept, picks: fit.n } : null,
    decayByAge,
    weeksNeeded,
    pbo: p ? { value: p.pbo, weeks: p.rows, variants: p.variants } : null,
    notes,
  };
}

export interface BoardRecord {
  chain: ScoutChain;
  /** Wallets picked, still followed. */
  picks: number;
  /** Of those, how many traded something a copy could price since. */
  withCopies: number;
  copies: number;
  /** Pooled median per copy at the size, %. */
  medianPct: number | null;
  winRatePct: number | null;
  /** Every copy the record priced over the same span. */
  baselineCopies: number;
  baselineMedianPct: number | null;
  /** The oldest pick still followed, or null with none. */
  since: number | null;
  sizeSol: number | null;
  feeFloorPct: number;
  /** Enough copies on both sides to read at all. */
  enough: boolean;
}

function pooledMedian(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * The board's picks against everyone, priced at `sizeSol`. `baseline` is
 * [openedAt, recorded return %] for every copy the record priced; only those
 * opened since the oldest pick count, the same span the picks had.
 */
export function boardRecord(chain: ScoutChain, picks: readonly ScoutPick[], baseline: readonly BaselineEntry[], sizeSol: number | null): BoardRecord {
  const m = copyCostModel(chain, sizeSol);
  const since = picks.length ? Math.min(...picks.map((p) => p.pickedAt)) : null;
  const mine = picks.flatMap((p) => p.returns).map((r) => repriceReturn(r, m));
  const all = since === null ? [] : baseline.filter(([at]) => at >= since).map(([, r]) => repriceReturn(r, m));
  return {
    chain,
    picks: picks.length,
    withCopies: picks.filter((p) => p.returns.length > 0).length,
    copies: mine.length,
    medianPct: pooledMedian(mine),
    winRatePct: mine.length ? (mine.filter((r) => r > 0).length / mine.length) * 100 : null,
    baselineCopies: all.length,
    baselineMedianPct: pooledMedian(all),
    since,
    sizeSol: m.sizeSol,
    feeFloorPct: feeFloorPct(m),
    enough: mine.length >= SCOUT_RECORD_MIN_COPIES && all.length >= SCOUT_RECORD_MIN_COPIES,
  };
}

// The sort keys live in shared/scoutSort.ts (2026-10-28), so a convergence
// follow can name one without a cycle; re-exported here unchanged.
export { SCOUT_RANK_SORT, SCOUT_SORTS, SCOUT_SORT_LABEL, type ScoutSort } from './scoutSort';

/** The copy size the board prices at until the user picks one: the follow
 *  wizard's default (shared/copytrade.ts SIMPLE_SIZES[0]). */
export const SCOUT_DEFAULT_SIZE_SOL = 0.05;

/** The paper model's costs for a copy on `chain` at `sizeSol` (null: the
 *  score basis, no fixed fees). EVM gas is not modelled, so not charged. */
export function copyCostModel(chain: ScoutChain, sizeSol: number | null): CopyCostModel {
  const size = sizeSol !== null && Number.isFinite(sizeSol) && sizeSol > 0 ? sizeSol : null;
  const fixed = paperFixedCost(chain, 'buy') + paperFixedCost(chain, 'sell');
  return { side: paperSideCost(chain), fixedPct: size === null ? 0 : (fixed / size) * 100, sizeSol: size };
}

/**
 * The id a trade is remembered by, so the live feed and a manual scan agree
 * on what "the same trade" is. `tx` is the signature on Solana and
 * `hash:logIndex` on the EVM chains; the rest pins one fill inside a
 * transaction that carries several (a bundle buying two mints, a router
 * filling twice).
 */
export function tradeId(tx: string, mint: string, address: string, isBuy: boolean): string {
  return `${tx}|${mint.toLowerCase()}|${address.toLowerCase()}|${isBuy ? 'b' : 's'}`;
}

/** Local day number for a timestamp. */
export function dayOf(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 86_400_000);
}

/**
 * A wallet trading this fast, holding this briefly, is automated.
 *
 * Deliberately conservative — being wrong here labels a real trader a bot, so
 * it takes BOTH a sub-10-second median hold and real volume of trips. A person
 * cannot hold for eight seconds thirty times. Or a trade rate no hand reaches
 * (BOT_TRADES_PER_MIN), which catches the scalper whose partial sells keep
 * its closed trips — and so its median hold — out of reach of the first rule.
 */
export function looksAutomated(medianHoldMs: number | null, roundTrips: number, peakPerMin: number | null = null): boolean {
  if (peakPerMin !== null && peakPerMin >= BOT_TRADES_PER_MIN) return true;
  return medianHoldMs !== null && medianHoldMs < 10_000 && roundTrips >= 10;
}

/**
 * A wallet as the week's prior sees it (2026-10-25, P1): its recorded copy
 * returns over the window, the same days `summarise` sums, with the style
 * traits the buckets cut on. `estimatePrior` takes a list of these.
 */
export function priorWalletOf(w: ScoutWallet, window: ScoutWindow, now = Date.now()): PriorWallet & { address: string; fTrips: number } {
  const span = SCOUT_WINDOW_DAYS[window];
  const today = dayOf(now);
  const from = span === null ? -Infinity : today - (span - 1);
  const days = w.days.filter((d) => d.day >= from && d.day <= today);
  let fTrips = 0;
  for (const d of days) fTrips += d.fTrips ?? 0;
  return { address: w.address, fTrips, returns: days.flatMap((d) => d.fReturns ?? []).sort((a, b) => a - b), medianHoldMs: w.medianHoldMs, medianFirstBuy: w.medianFirstBuy ?? null };
}

/**
 * Sum a wallet's daily buckets over a window, ending today. The follower
 * figures are priced at `opts.sizeSol` (default SCOUT_DEFAULT_SIZE_SOL; null
 * leaves the fixed fees out).
 */
export function summarise(w: ScoutWallet, window: ScoutWindow, now = Date.now(), opts: { sizeSol?: number | null; prior?: ShrinkPrior } = {}): ScoutRow {
  const span = SCOUT_WINDOW_DAYS[window];
  const today = dayOf(now);
  const from = span === null ? -Infinity : today - (span - 1);
  const days = w.days.filter((d) => d.day >= from && d.day <= today);

  const sum = (pick: (d: ScoutDay) => number): number => days.reduce((a, d) => a + pick(d), 0);
  const roundTrips = sum((d) => d.roundTrips);
  const wins = sum((d) => d.wins);
  const volume = sum((d) => d.volume);
  const pnl = sum((d) => d.pnl);
  const ranked = roundTrips >= MIN_TRIPS_FOR_RANK;

  // The follower's side of the same days, repriced with the paper model at
  // the copy size (shared/walletScore.ts, "One cost model with paper").
  const fTrips = sum((d) => d.fTrips ?? 0);
  const fast = sum((d) => d.fast ?? 0);
  const unreachable = sum((d) => d.unreachable ?? 0);
  const measured = sum((d) => d.measured ?? 0);
  const recorded = days.flatMap((d) => d.fReturns ?? []).sort((a, b) => a - b);
  const sized = copyCostModel(w.chain, opts.sizeSol === undefined ? SCOUT_DEFAULT_SIZE_SOL : opts.sizeSol);
  const basisModel = copyCostModel(w.chain, null);
  // The week's measured prior when the caller has one (2026-10-25, P1), the
  // constants otherwise; the wallet's style bucket picks its location. Shrunk
  // in the recorded model and repriced after — repricing is affine, so this
  // is the shrinkage of the repriced figures exactly.
  const prior = opts.prior ?? DEFAULT_SHRINK_PRIOR;
  const bucket = styleBucket(w.medianHoldMs, w.medianFirstBuy ?? null, prior);
  const fastPct = measured > 0 ? Math.min(100, (fast / measured) * 100) : null;
  // A fast wallet (SCOUT_FAST_WALLET_PCT) gets no follower figure from the
  // marks, however many trips they filled: on trades over inside a minute
  // the fill is the leader's own print or a stale one. Judged on a sample
  // the rank itself would accept, so two quick trips do not silence a record.
  const fastWallet = fastPct !== null && measured >= MIN_TRIPS_FOR_RANK && fastPct >= SCOUT_FAST_WALLET_PCT;
  const shrunkRec = !fastWallet && fTrips >= SCORE_MIN_F_TRIPS && recorded.length >= SCORE_MIN_F_TRIPS ? shrinkWith(recorded[Math.floor(recorded.length / 2)], recorded.length, prior, bucket) : null;
  const follower = (m: CopyCostModel) => {
    const rs = recorded.map((r) => repriceReturn(r, m));
    const enough = !fastWallet && fTrips >= MIN_TRIPS_FOR_RANK && rs.length > 0;
    const median = enough ? rs[Math.floor(rs.length / 2)] : null;
    // The win rate from the same repriced trips: a copy that cleared 1.5 %
    // a side may not clear the paper model's fees.
    const winRate = enough ? (rs.filter((r) => r > 0).length / rs.length) * 100 : null;
    const shrunk = median !== null && shrunkRec ? repriceReturn(shrunkRec.shrunk, m) : null;
    const lower = median !== null && shrunkRec ? repriceReturn(shrunkRec.lower, m) : null;
    // The week as a whole (2026-10-27): the same repriced trips added up,
    // and their mean without the best few. `recorded` is ascending and the
    // repricing is affine, so `rs` is ascending too: the best are the tail.
    const sum = enough ? rs.reduce((a, r) => a + r, 0) : null;
    const kept = rs.length - SCOUT_TRIMMED_DROP;
    const trimmed = enough && rs.length >= SCOUT_TRIMMED_MIN_COPIES ? rs.slice(0, kept).reduce((a, r) => a + r, 0) / kept : null;
    return { median, winRate, shrunk, lower, sum, trimmed };
  };
  const atSize = follower(sized);
  const basis = follower(basisModel);
  const fMedianReturnPct = atSize.median;
  const fWinRatePct = atSize.winRate;
  // Judged = filled or unreachable. A trip waiting for its exit print is
  // neither, and a record from before the model has none — both are "not
  // measured", never "0 % reachable".
  const judgedTrips = fTrips + unreachable;
  // Not a share at all under the sample floor (2026-10-22): one judged trip
  // read "Copyable 100%" on 37 of 137 board rows.
  const reachablePct = judgedTrips >= MIN_TRIPS_FOR_RANK ? (fTrips / judgedTrips) * 100 : null;
  // A day with a FINISHED trade (2026-10-22): a day of buys alone is a day
  // the record cannot score, and counting it made "2 of 7" out of one.
  const activeDays = days.filter((d) => d.roundTrips > 0).length;
  // The days of this window the market was actually WATCHED. A week window
  // over a record that began this morning is one day long, not seven: the
  // wallet may have traded every day before we looked, so "active 1 of 7"
  // would be a claim nobody measured. Records with no watched-days list keep
  // the calendar span. 'all' spans the record itself.
  const calendar = span === null ? Math.max(1, today - dayOf(w.firstSeen) + 1) : span;
  const windowDays = w.observedDays ? Math.max(1, w.observedDays.filter((d) => d >= from && d <= today).length) : calendar;
  const distinctMints = w.distinctMints ?? 0;
  const peaks = days.map((d) => d.peakPerMin).filter((p): p is number => typeof p === 'number');
  const peakPerMin = peaks.length ? Math.max(...peaks) : null;
  const automated = looksAutomated(w.medianHoldMs, roundTrips, peakPerMin);
  const createdCoins = sum((d) => d.creates ?? 0);
  const mayhemTrips = sum((d) => d.mayhemTrips ?? 0);
  const medianFirstBuy = w.medianFirstBuy ?? null;
  const scored = scoreWallet({
    roundTrips,
    fTrips,
    fMedianReturnPct: basis.shrunk,
    fWinRatePct: basis.winRate,
    reachablePct,
    judgedTrips,
    activeDays,
    windowDays: windowDays >= 3 ? windowDays : null,
    distinctMints,
    looksAutomated: automated,
  });

  return {
    chain: w.chain,
    address: w.address,
    window,
    buys: sum((d) => d.buys),
    sells: sum((d) => d.sells),
    roundTrips,
    wins,
    losses: sum((d) => d.losses),
    pnl,
    volume,
    // Unknown, not 0: a wallet that spent nothing has no return to report.
    returnPct: volume > 0 ? (pnl / volume) * 100 : null,
    // A win rate off two trades is noise wearing a percentage sign.
    winRatePct: ranked ? (wins / roundTrips) * 100 : null,
    medianHoldMs: w.medianHoldMs,
    lastSeen: w.lastSeen,
    ranked,
    looksAutomated: automated,
    peakPerMin,
    fTrips,
    fMedianReturnPct,
    fWinRatePct,
    fShrunkPct: atSize.shrunk,
    fLowerPct: atSize.lower,
    fSumPct: atSize.sum,
    fTotalSol: atSize.sum !== null && sized.sizeSol !== null ? sized.sizeSol * (atSize.sum / 100) : null,
    fTrimmedMeanPct: atSize.trimmed,
    shrink: { k: prior.k, muPct: prior.muPct, wallets: prior.wallets },
    basis: { shrunkPct: basis.shrunk, lowerPct: basis.lower, winRatePct: basis.winRate },
    sizeSol: sized.sizeSol,
    fixedCostPct: sized.fixedPct,
    reachablePct,
    judgedTrips,
    fastPct,
    fastWallet,
    activeDays,
    spanDays: windowDays,
    distinctMints,
    copyScore: scored.score,
    flags: scored.flags,
    warnings: scoutWarnings(w.chain, { createdCoins, mayhemTrips, roundTrips, medianFirstBuy }),
    createdCoins,
    mayhemTrips,
    medianFirstBuy,
    chainLabel: w.chainLabel ?? null,
    neverSigns: w.neverSigns ?? null,
  };
}

/** The score with its checks, for a row already summarised — the drawer. */
export function scoreOfRow(r: ScoutRow, windowDays: number | null): WalletScore {
  return scoreWallet({
    roundTrips: r.roundTrips,
    fTrips: r.fTrips,
    fMedianReturnPct: r.basis.shrunkPct,
    fWinRatePct: r.basis.winRatePct,
    reachablePct: r.reachablePct,
    judgedTrips: r.judgedTrips,
    activeDays: r.activeDays,
    windowDays,
    distinctMints: r.distinctMints,
    looksAutomated: r.looksAutomated,
  });
}

/** An empty row for a saved wallet with no record yet. */
export function emptyRow(chain: ScoutChain, address: string, window: ScoutWindow): ScoutRow {
  return {
    chain,
    address,
    window,
    buys: 0,
    sells: 0,
    roundTrips: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    volume: 0,
    returnPct: null,
    winRatePct: null,
    medianHoldMs: null,
    lastSeen: 0,
    ranked: false,
    looksAutomated: false,
    peakPerMin: null,
    fTrips: 0,
    fMedianReturnPct: null,
    fWinRatePct: null,
    fShrunkPct: null,
    fLowerPct: null,
    fSumPct: null,
    fTotalSol: null,
    fTrimmedMeanPct: null,
    shrink: { k: DEFAULT_SHRINK_PRIOR.k, muPct: DEFAULT_SHRINK_PRIOR.muPct, wallets: 0 },
    basis: { shrunkPct: null, lowerPct: null, winRatePct: null },
    sizeSol: null,
    fixedCostPct: 0,
    reachablePct: null,
    judgedTrips: 0,
    fastPct: null,
    fastWallet: false,
    activeDays: 0,
    spanDays: 1,
    distinctMints: 0,
    copyScore: null,
    flags: ['thin'],
    warnings: [],
    createdCoins: 0,
    mayhemTrips: 0,
    medianFirstBuy: null,
    chainLabel: null,
  };
}

/**
 * Rank rows for display.
 *
 * Order of precedence, and each step is a decision rather than a tie-break:
 *   1. wallets with enough trips to be ranked come first;
 *   2. among those, humans before bots — a bot may be the most profitable
 *      thing on the chain and still be uncopyable;
 *   3. then the chosen measure, descending, with unknown last;
 *   4. then more round trips, because a bigger sample is a better record.
 */
export function rankScout(rows: readonly ScoutRow[], by: ScoutSort): ScoutRow[] {
  const val = (r: ScoutRow): number | null => r[by];
  return [...rows].sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    if (a.looksAutomated !== b.looksAutomated) return a.looksAutomated ? 1 : -1;
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) {
      // Not rankable yet on "least bad": the measured median orders them,
      // unknown last — shown, under a divider, never as a ranking.
      if ((by === 'fLowerPct' || by === 'fShrunkPct') && a.fMedianReturnPct !== b.fMedianReturnPct) {
        if (a.fMedianReturnPct === null) return 1;
        if (b.fMedianReturnPct === null) return -1;
        return b.fMedianReturnPct - a.fMedianReturnPct;
      }
      return b.roundTrips - a.roundTrips;
    }
    if (va === null) return 1;
    if (vb === null) return -1;
    if (vb !== va) return vb - va;
    return b.roundTrips - a.roundTrips;
  });
}

/** Drop buckets past retention. Returns a new array, newest first. */
export function rotate(days: readonly ScoutDay[], now = Date.now()): ScoutDay[] {
  const cutoff = dayOf(now) - (SCOUT_RETENTION_DAYS - 1);
  return [...days].filter((d) => d.day >= cutoff).sort((a, b) => b.day - a.day);
}
