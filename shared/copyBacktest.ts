// Copy backtest (2026-11-01) — "what would MY follow have done?", answered
// by replaying a wallet's past trades through the follow's own settings.
//
// The replay (shared/copyReplay.ts) copies every trip of theirs 2 s behind
// both legs at the recorded 1.5 %/side model. A user asked for more: "a copy
// backtest that replays a wallet's past trades with my settings, delay and
// fees." So, over the same trips, this one:
//
//   • lags by the follow's own delay on top of the follower's latency (the
//     board's 2 s, or this session's measured slot gap when live copies have
//     measured one);
//   • sizes each copy with copySize from their opening buy, capped;
//   • prices it with the PAPER model (paperCopyReturnPct: venue + Krypt fee
//     per side, fixed transaction costs, constant-product impact both ways),
//     so a backtest and a paper book of the same trades say the same thing;
//   • refuses entries by every rule the trades alone can judge — the order is
//     the engine's (copyTrade.prefilter, then limitHit), and the first rule
//     that refuses a copy is the one it is counted under;
//   • exits on their last sell, or on the follow's max hold when that comes
//     first (or always, when their sells are not copied);
//   • and LISTS every rule it could not judge — liquidity, market cap, Krypt
//     score, token age, creators, the AI desk, the price-path exits — rather
//     than assuming them passed or failed.
//
// The pool's depth is not in the replay, so impact is priced at the pump
// curve's floor (PAPER_DEFAULT_DEPTH_SOL) and the result says so.

import {
  DEFAULT_COPIES_PER_MINUTE,
  MIN_LIVE_COPY_SOL,
  activeWindowOf,
  cleanBlocklist,
  copySize,
  directionOf,
  fmtClock,
  inActiveWindow,
  isBlocked,
  ownExitsOf,
  paperCopyReturnPct,
  type CopyConfig,
  type CopyDirection,
  type CopyMode,
  type SizingMode,
} from './copytrade';
import type { AiGateConfig } from './aiDesk';
import { replayDayOf, type ReplayDay, type ReplaySpan, type ReplayTrip } from './copyReplay';
import { SCOUT_TRIMMED_DROP, SCOUT_TRIMMED_MIN_COPIES } from './walletScout';

/** The follow fields a backtest reads — a saved follow or a page's draft. */
export interface BacktestConfig {
  id?: string;
  wallet: string;
  label: string;
  chain?: CopyConfig['chain'];
  mode: CopyMode;
  direction?: CopyDirection;
  sizing: SizingMode;
  sizeValue: number;
  maxTradeSol: number;
  minLeaderSol?: number | null;
  maxLeaderSol?: number | null;
  blockedMints?: string[] | null;
  blockedCreators?: string[] | null;
  activeFromMin?: number | null;
  activeToMin?: number | null;
  onePositionPerCoin?: boolean;
  maxBuysPerToken?: number | null;
  dailyTradeLimit: number;
  maxCopiesPerMinute?: number | null;
  dailyLossLimitSol: number;
  walletLossStopSol?: number | null;
  delayMs: number;
  copySells: boolean;
  minLeaderSellPct?: number | null;
  exitTakeProfitPct?: number | null;
  exitStopLossPct?: number | null;
  exitMaxHoldMin?: number | null;
  exitTrailingPct?: number | null;
  exitOnCreatorSellPct?: number | null;
  exitOnMigration?: boolean;
  copyOtherExits?: boolean;
  minLiquidityUsd: number | null;
  maxMarketCapUsd: number | null;
  minMarketCapUsd?: number | null;
  minKryptScore: number | null;
  onlyPumpfun: boolean;
  minTokenAgeSec?: number | null;
  maxTokenAgeSec?: number | null;
  ai?: AiGateConfig | null;
  maxSlippagePct: number;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A backtest config from whatever a page sent: only the fields the backtest
 * reads, each type-checked. Absent or not a number is OFF for an optional
 * rule — the same reading copy:save gives it — and a required one that is
 * missing refuses the backtest rather than inventing a value.
 */
export function backtestConfigOf(raw: unknown): { ok: true; config: BacktestConfig } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'No follow settings to backtest' };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  const pos = (v: unknown): number | null => {
    const n = num(v);
    return n !== null && n > 0 ? n : null;
  };
  const wallet = typeof r.wallet === 'string' ? r.wallet.trim() : '';
  const chain = r.chain === 'robinhood' || r.chain === 'bnb' ? r.chain : 'solana';
  if (chain !== 'solana') return { ok: false, message: 'The backtest replays Solana wallets only' };
  if (!BASE58.test(wallet)) return { ok: false, message: 'Choose a Solana wallet to backtest' };
  const sizeValue = pos(r.sizeValue);
  const maxTradeSol = pos(r.maxTradeSol);
  // Absent or 0: no limit, the same as a follow with none.
  const dailyTradeLimit = pos(r.dailyTradeLimit) ?? 0;
  // Absent or 0: no daily loss limit, the same as a follow with none.
  const dailyLossLimitSol = pos(r.dailyLossLimitSol) ?? 0;
  if (sizeValue === null) return { ok: false, message: 'Set a size per copy first' };
  if (maxTradeSol === null) return { ok: false, message: 'Set the most one copy may spend first' };
  const direction: CopyDirection = r.direction === 'reverse' ? 'reverse' : r.direction === 'fomo' ? 'fomo' : r.direction === 'watch' ? 'watch' : 'copy';
  const ai = r.ai && typeof r.ai === 'object' ? (r.ai as Record<string, unknown>) : null;
  return {
    ok: true,
    config: {
      id: typeof r.id === 'string' && r.id ? r.id : undefined,
      wallet,
      label: typeof r.label === 'string' ? r.label.slice(0, 40) : '',
      chain,
      mode: r.mode === 'live' ? 'live' : 'paper',
      direction,
      sizing: r.sizing === 'proportional' ? 'proportional' : 'fixed',
      sizeValue,
      maxTradeSol,
      minLeaderSol: num(r.minLeaderSol),
      maxLeaderSol: num(r.maxLeaderSol),
      blockedMints: cleanBlocklist(r.blockedMints),
      blockedCreators: cleanBlocklist(r.blockedCreators),
      activeFromMin: num(r.activeFromMin),
      activeToMin: num(r.activeToMin),
      onePositionPerCoin: r.onePositionPerCoin === true,
      maxBuysPerToken: pos(r.maxBuysPerToken),
      dailyTradeLimit,
      maxCopiesPerMinute: num(r.maxCopiesPerMinute) === 0 ? 0 : pos(r.maxCopiesPerMinute),
      dailyLossLimitSol,
      walletLossStopSol: pos(r.walletLossStopSol),
      delayMs: Math.max(0, num(r.delayMs) ?? 0),
      copySells: r.copySells !== false,
      minLeaderSellPct: pos(r.minLeaderSellPct),
      exitTakeProfitPct: num(r.exitTakeProfitPct),
      exitStopLossPct: num(r.exitStopLossPct),
      exitMaxHoldMin: num(r.exitMaxHoldMin),
      exitTrailingPct: num(r.exitTrailingPct),
      exitOnCreatorSellPct: num(r.exitOnCreatorSellPct),
      exitOnMigration: r.exitOnMigration === true,
      copyOtherExits: r.copyOtherExits === true,
      minLiquidityUsd: num(r.minLiquidityUsd),
      maxMarketCapUsd: num(r.maxMarketCapUsd),
      minMarketCapUsd: num(r.minMarketCapUsd),
      minKryptScore: num(r.minKryptScore),
      onlyPumpfun: r.onlyPumpfun === true,
      minTokenAgeSec: num(r.minTokenAgeSec),
      maxTokenAgeSec: num(r.maxTokenAgeSec),
      ai: ai ? ({ entries: ai.entries === true, exits: ai.exits === true, waitSec: num(ai.waitSec) ?? 0, onTimeout: ai.onTimeout === 'copy' ? 'copy' : 'skip', protectiveWait: ai.protectiveWait === true } as AiGateConfig) : null,
      maxSlippagePct: num(r.maxSlippagePct) ?? 0,
    },
  };
}

/** Why a backtest cannot run on this follow at all, or null. */
export function backtestRefusal(c: BacktestConfig): string | null {
  const d = directionOf(c);
  if (d === 'reverse') return 'A reverse follow buys when they sell and leaves on its own exits — the replay has no price path for those, so it cannot be backtested here.';
  if (d === 'fomo') return 'A convergence follow buys on a crowd, not on one wallet — the replay reads one wallet, so it cannot be backtested here.';
  if (d === 'copy' && !c.copySells && ownExitsOf(c).maxHoldMin === null)
    return 'This follow does not copy their sells and has no "sell after holding": the replay has no exit to price. Switch one of them on to backtest it.';
  return null;
}

// ── The follower's lag ────────────────────────────────────────────────

/** Where the base latency came from: the board's assumption, or this
 *  session's live copies. */
export type LagSource = 'board' | 'measured';

export interface BacktestLag {
  /** The whole lag a copy lands behind their trade, ms: base + the follow's delay. */
  lagMs: number;
  baseLagMs: number;
  delayMs: number;
  source: LagSource;
  /** In words, for the result. */
  note: string;
}

// ── Rules ─────────────────────────────────────────────────────────────

/** A rule that refused a copy, in the engine's order. */
export type BacktestRule =
  | 'watch'
  | 'walletStop'
  | 'leaderMin'
  | 'leaderMax'
  | 'blocklist'
  | 'hours'
  | 'onePosition'
  | 'maxBuys'
  | 'dailyTrades'
  | 'perMinute'
  | 'dailyLoss'
  | 'maxOpen'
  | 'liveMin'
  | 'tooFast';

export const BACKTEST_RULES: readonly BacktestRule[] = [
  'watch',
  'walletStop',
  'leaderMin',
  'leaderMax',
  'blocklist',
  'hours',
  'onePosition',
  'maxBuys',
  'dailyTrades',
  'perMinute',
  'dailyLoss',
  'maxOpen',
  'liveMin',
  'tooFast',
];

export interface BacktestSkip {
  rule: BacktestRule;
  /** What refused them, in words. */
  label: string;
  count: number;
}

/** A rule the follow has on that the trades alone cannot judge. */
export interface BacktestNotApplied {
  key: string;
  label: string;
  why: string;
}

/** Everything a backtest needs besides the trips. */
export interface BacktestSpec {
  config: BacktestConfig;
  lag: BacktestLag;
  /** The pool depth impact is priced against, SOL. */
  depthSol: number;
  depthSource: 'default';
  /** The app-wide open-copies ceiling (execution.maxOpenCopies); null/0 = off. */
  maxOpenCopies: number | null;
  span: ReplaySpan;
}

/** One copy the follow would have made. */
export interface BacktestCopy {
  mint: string;
  /** When the follow decided (their buy) and when its sell landed, ms. */
  at: number;
  exitAt: number;
  /** What they put into the opening buy, and what the copy spent. */
  theirSol: number;
  sol: number;
  /** The copy's round trip under the paper model, %, and in SOL; null = not priced. */
  pct: number | null;
  pnlSol: number | null;
  exitBy: 'leader' | 'maxHold';
}

export interface BacktestResult {
  /** Their finished trades the backtest judged. */
  trips: number;
  /** Copies the follow would have taken, priced or not. */
  copies: number;
  priced: number;
  /** Taken but not priced (no trade then, a source that stopped): in the
   *  counts the limits keep, in no SOL figure. */
  unpriced: number;
  /** Refused copies by the rule that refused them, biggest first. */
  skipped: BacktestSkip[];
  skippedTotal: number;
  /** What the priced copies made together, and spent, SOL; null when none was priced. */
  totalSol: number | null;
  spentSol: number | null;
  /** Per copy, % — from five priced copies, else null (too few to say). */
  medianPct: number | null;
  meanPct: number | null;
  /** Per copy, SOL — from five priced copies. */
  meanSol: number | null;
  winRatePct: number | null;
  /** The best priced copy, and the total without it (from two copies): one
   *  lucky trade must not make the whole thing look good. */
  best: BacktestCopy | null;
  withoutBestSol: number | null;
  /** The best SCOUT_TRIMMED_DROP copies together and every other copy, SOL,
   *  from SCOUT_TRIMMED_MIN_COPIES priced copies. */
  bestFewSol: number | null;
  restSol: number | null;
  /** Priced copies by the local day they closed, oldest first. */
  days: ReplayDay[];
  /** Paper follows only: copies taken under the live minimum (live would refuse them). */
  underLiveMin: number;
  /** Copies exited by the max hold before their sell. */
  byMaxHold: number;
  notApplied: BacktestNotApplied[];
  /** The assumptions behind the figures, in words. */
  assumptions: string[];
  lagMs: number;
  baseLagMs: number;
  lagSource: LagSource;
  delayMs: number;
  depthSol: number;
  depthSource: 'default';
  /** Every copy taken, newest first. */
  copiesList: BacktestCopy[];
}

/** Under this many priced copies there is no median, mean or win rate. */
export const BACKTEST_MIN_COPIES = 5;

const sol3 = (v: number): string => `${Math.round(v * 1_000) / 1_000}`;

export function backtestRuleLabel(rule: BacktestRule, c: BacktestConfig, maxOpenCopies: number | null): string {
  const win = activeWindowOf(c);
  switch (rule) {
    case 'watch':
      return 'Watch only — it never trades';
    case 'walletStop':
      return `Paused after losing ${c.walletLossStopSol ?? '—'} SOL in all`;
    case 'leaderMin':
      return `Their buy under your ${c.minLeaderSol ?? '—'} SOL minimum`;
    case 'leaderMax':
      return `Their buy over your ${c.maxLeaderSol ?? '—'} SOL maximum`;
    case 'blocklist':
      return 'Coin on your blocklist';
    case 'hours':
      return win ? `Outside your trading hours (${fmtClock(win.fromMin)}–${fmtClock(win.toMin)})` : 'Outside your trading hours';
    case 'onePosition':
      return 'Already holding the coin — one position per coin';
    case 'maxBuys':
      return c.maxBuysPerToken === 1 ? 'Already bought this coin once' : `Already bought this coin ${c.maxBuysPerToken ?? '—'} times`;
    case 'dailyTrades':
      return `Daily limit of ${c.dailyTradeLimit} copies reached`;
    case 'perMinute':
      return `More than ${perMinuteOf(c)} copies in a minute`;
    case 'dailyLoss':
      return `Down ${c.dailyLossLimitSol} SOL that day — stopped for the day`;
    case 'maxOpen':
      return `${maxOpenCopies ?? '—'} copies already open (the app-wide ceiling)`;
    case 'liveMin':
      return `Copy under the ${MIN_LIVE_COPY_SOL} SOL live minimum`;
    case 'tooFast':
      return 'They were out before your copy could land';
  }
}

const perMinuteOf = (c: BacktestConfig): number => (c.maxCopiesPerMinute === 0 ? Number.POSITIVE_INFINITY : typeof c.maxCopiesPerMinute === 'number' && c.maxCopiesPerMinute > 0 ? c.maxCopiesPerMinute : DEFAULT_COPIES_PER_MINUTE);

/** Their opening buy, SOL — the trade a copy is a copy OF. */
export const openSolOf = (t: Pick<ReplayTrip, 'openSol' | 'cost'>): number => (typeof t.openSol === 'number' && t.openSol > 0 ? t.openSol : Math.max(0, t.cost));

/** What one copy of this trip spends under the follow's sizing. */
export function backtestCopySol(t: Pick<ReplayTrip, 'openSol' | 'cost'>, c: BacktestConfig): number {
  return copySize(c as unknown as CopyConfig, openSolOf(t));
}

/** Minutes after local midnight. */
function minuteOfDay(at: number): number {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}

/** The max hold, ms, or null when off. */
function maxHoldMsOf(c: BacktestConfig): number | null {
  const m = ownExitsOf(c).maxHoldMin;
  return m === null ? null : m * 60_000;
}

/**
 * How the job prices one trip under this follow: when the copy sells — on
 * their last sell, or `holdMs` after its own buy when the max hold comes
 * first (or always, with their sells not copied) — whether they were out
 * before it could land, and whether a rule that needs no price refuses it
 * anyway (then it is not priced, and costs nothing).
 */
export interface BacktestPlan {
  lagMs: number;
  /** Ms from the copy's buy to its sell when the max hold closes it, or null = their sell. */
  holdOf(t: ReplayTrip): number | null;
  tooFast(t: ReplayTrip): boolean;
  skip(t: ReplayTrip): boolean;
}

export function backtestPlanOf(spec: BacktestSpec): BacktestPlan {
  const c = spec.config;
  const lagMs = spec.lag.lagMs;
  const hold = maxHoldMsOf(c);
  const holdOf = (t: ReplayTrip): number | null => (hold !== null && (!c.copySells || hold < t.holdMs) ? hold : null);
  // With their sells copied, a sell that lands before the copy cancels it
  // (the engine's stale-buy rule). Without, the copy is bought anyway and
  // left to the max hold.
  const tooFast = (t: ReplayTrip): boolean => c.copySells && t.holdMs < lagMs;
  return { lagMs, holdOf, tooFast, skip: (t) => staticRule(t, c, tooFast) !== null };
}

/** The rules that need neither a price nor the copies before it. */
function staticRule(t: ReplayTrip, c: BacktestConfig, tooFast: (t: ReplayTrip) => boolean): BacktestRule | null {
  if (directionOf(c) === 'watch') return 'watch';
  const theirs = openSolOf(t);
  if (c.minLeaderSol != null && theirs < c.minLeaderSol) return 'leaderMin';
  if (c.maxLeaderSol != null && theirs > c.maxLeaderSol) return 'leaderMax';
  if (isBlocked(c.blockedMints, t.mint)) return 'blocklist';
  const win = activeWindowOf(c);
  if (win && !inActiveWindow(win, minuteOfDay(t.openedAt))) return 'hours';
  if (c.mode === 'live' && backtestCopySol(t, c) + 1e-12 < MIN_LIVE_COPY_SOL) return 'liveMin';
  if (tooFast(t)) return 'tooFast';
  return null;
}

/** The follow's rules the trades cannot judge, with why — only those it has on. */
export function backtestNotApplied(c: BacktestConfig, maxOpenCopies: number | null): BacktestNotApplied[] {
  const out: BacktestNotApplied[] = [];
  const add = (key: string, label: string, why: string): void => void out.push({ key, label, why });
  const noFacts = 'the replay has no token facts at the time of their buy';
  if (c.minLiquidityUsd != null) add('minLiquidityUsd', `Minimum liquidity (${c.minLiquidityUsd.toLocaleString()} USD)`, noFacts);
  if (c.minMarketCapUsd != null || c.maxMarketCapUsd != null) add('marketCap', 'Market cap band', noFacts);
  if (c.minKryptScore != null) add('minKryptScore', `Minimum Krypt score (${c.minKryptScore})`, noFacts);
  if (c.onlyPumpfun) add('onlyPumpfun', 'pump.fun coins only', 'the replay does not read which launchpad made each coin');
  if (c.minTokenAgeSec != null || c.maxTokenAgeSec != null) add('tokenAge', 'Coin age when they buy', 'the backtest does not read each coin’s birth');
  if (c.blockedCreators?.length) add('blockedCreators', 'Blocked creators', 'the replay does not know who made each coin');
  if (c.walletLossStopSol != null) add('lossStopComeback', 'Coming back after a loss stop', 'once the stop is hit the replay stays stopped. With that comeback on in Settings, live returns after an hour and can lose the stop again');
  if (c.ai && (c.ai.entries || c.ai.exits)) add('ai', 'The AI desk', 'its decisions cannot be replayed — every copy is taken as the rules allow');
  const x = ownExitsOf(c);
  if (x.takeProfitPct !== null) add('takeProfit', `Take profit (+${x.takeProfitPct}%)`, 'needs the price between their buy and their sell, which the replay does not read');
  if (x.stopLossPct !== null) add('stopLoss', `Stop loss (−${x.stopLossPct}%)`, 'needs the price between their buy and their sell, which the replay does not read');
  if (x.trailingPct !== null) add('trailing', `Trailing stop (${x.trailingPct}%)`, 'needs the price between their buy and their sell, which the replay does not read');
  if (c.exitOnCreatorSellPct != null) add('creatorSell', 'Sell if the creator sells', 'the replay does not read the creator’s trades');
  if (c.exitOnMigration) add('migration', 'Sell when it graduates', 'the replay does not read when each coin graduated');
  if (c.copySells && c.copyOtherExits) add('otherExits', 'Follow them out another way', 'the replay reads their SOL swaps only');
  if (c.copySells) add('partialSells', c.minLeaderSellPct ? `Their partial sells (trims under ${c.minLeaderSellPct}% ignored)` : 'Their partial sells', 'the replay sells the whole copy once, at their last sell');
  if (c.onePositionPerCoin) add('onePositionOthers', 'One position per coin — across your other follows', 'only this follow’s own copies are in the backtest');
  if (maxOpenCopies !== null && maxOpenCopies > 0) add('maxOpenOthers', `Open-copies ceiling (${maxOpenCopies}) — your other follows’ copies`, 'only this follow’s own open copies are counted, so it refuses at least this many');
  add('slippage', `Maximum slippage (${c.maxSlippagePct}%)`, 'a copy fills at the price the market stood at; a fill refused for slippage is not modelled');
  add('buyMore', 'Their extra buys into a coin', 'one copy per trade, at their first buy — the replay prices one entry per trade');
  return out;
}

interface Taken {
  t: ReplayTrip;
  mint: string;
  at: number;
  day: number;
  exitAt: number;
  sol: number;
  pct: number | null;
  pnlSol: number | null;
  exitBy: 'leader' | 'maxHold';
}

/**
 * The backtest: each of their trips, oldest first, through the follow's
 * rules in the engine's order; the first that refuses a copy is the one it
 * is counted under. A taken copy is priced from the trip's fills under the
 * paper model; one that could not be priced still counts toward the limits
 * and adds nothing to any SOL figure, so a loss limit is judged on what is
 * known (it may stop later than live would, never earlier).
 */
export function backtestCopies(trips: readonly ReplayTrip[], spec: BacktestSpec): BacktestResult {
  const c = spec.config;
  const plan = backtestPlanOf(spec);
  const lagMs = plan.lagMs;
  const ordered = [...trips].sort((a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt);
  const taken: Taken[] = [];
  const skips = new Map<BacktestRule, number>();
  const skip = (r: BacktestRule): void => void skips.set(r, (skips.get(r) ?? 0) + 1);
  const maxOpen = spec.maxOpenCopies !== null && spec.maxOpenCopies > 0 ? spec.maxOpenCopies : null;
  let paused = false;
  for (const t of ordered) {
    const now = t.openedAt;
    const day = replayDayOf(now);
    // A follow paused by its own stop hears nothing until switched back on.
    if (paused) {
      skip('walletStop');
      continue;
    }
    // Watch, their size, the blocklist, the clock — the engine's prefilter.
    const pre = staticRule(t, c, () => false);
    if (pre && pre !== 'liveMin') {
      skip(pre);
      continue;
    }
    const closedBy = (x: Taken): boolean => x.exitAt <= now;
    if (c.onePositionPerCoin && taken.some((x) => x.mint === t.mint && !closedBy(x))) {
      skip('onePosition');
      continue;
    }
    if (c.maxBuysPerToken != null && taken.filter((x) => x.mint === t.mint).length >= c.maxBuysPerToken) {
      skip('maxBuys');
      continue;
    }
    // limitHit: the day's copies, the minute's, the day's realised loss, the
    // follow's own stop, the open ceiling.
    const today = taken.filter((x) => x.day === day);
    if (c.dailyTradeLimit > 0 && today.length >= c.dailyTradeLimit) {
      skip('dailyTrades');
      continue;
    }
    if (taken.filter((x) => now - x.at < 60_000).length >= perMinuteOf(c)) {
      skip('perMinute');
      continue;
    }
    const realisedToday = today.filter(closedBy).reduce((a, x) => a + (x.pnlSol ?? 0), 0);
    if (c.dailyLossLimitSol > 0 && realisedToday <= -c.dailyLossLimitSol) {
      skip('dailyLoss');
      continue;
    }
    if (c.walletLossStopSol != null && c.walletLossStopSol > 0) {
      const realised = taken.filter(closedBy).reduce((a, x) => a + (x.pnlSol ?? 0), 0);
      if (realised <= -c.walletLossStopSol) {
        paused = true;
        skip('walletStop');
        continue;
      }
    }
    if (maxOpen !== null && taken.filter((x) => !closedBy(x)).length >= maxOpen) {
      skip('maxOpen');
      continue;
    }
    // The last gate before a live buy, then the sell that beat it there.
    if (pre === 'liveMin') {
      skip('liveMin');
      continue;
    }
    if (plan.tooFast(t)) {
      skip('tooFast');
      continue;
    }
    const sol = backtestCopySol(t, c);
    const hold = plan.holdOf(t);
    const exitAt = hold !== null ? t.openedAt + lagMs + hold : t.closedAt + lagMs;
    const pct = t.note === 'filled' && t.entryPx !== null && t.exitPx !== null ? paperCopyReturnPct(sol, t.entryPx, t.exitPx, spec.depthSol, 'solana') : null;
    taken.push({ t, mint: t.mint, at: now, day, exitAt, sol, pct, pnlSol: pct === null ? null : sol * (pct / 100), exitBy: hold !== null ? 'maxHold' : 'leader' });
  }

  const priced = taken.filter((x) => x.pct !== null);
  const pcts = priced.map((x) => x.pct as number).sort((a, b) => a - b);
  const n = pcts.length;
  const enough = n >= BACKTEST_MIN_COPIES;
  const totalSol = n ? priced.reduce((a, x) => a + (x.pnlSol as number), 0) : null;
  const toCopy = (x: Taken): BacktestCopy => ({ mint: x.mint, at: x.at, exitAt: x.exitAt, theirSol: openSolOf(x.t), sol: x.sol, pct: x.pct, pnlSol: x.pnlSol, exitBy: x.exitBy });
  const byGain = [...priced].sort((a, b) => (b.pnlSol as number) - (a.pnlSol as number));
  const best = byGain[0] ?? null;
  const fewOk = n >= SCOUT_TRIMMED_MIN_COPIES;
  const dayMap = new Map<number, ReplayDay>();
  for (const x of priced) {
    const d0 = replayDayOf(x.exitAt);
    const d = dayMap.get(d0) ?? { day: d0, copies: 0, totalSol: 0, wins: 0 };
    d.copies += 1;
    if ((x.pnlSol as number) > 0) d.wins += 1;
    d.totalSol = (d.totalSol ?? 0) + (x.pnlSol as number);
    dayMap.set(d0, d);
  }
  const skipped = BACKTEST_RULES.filter((r) => skips.has(r))
    .map((rule) => ({ rule, label: backtestRuleLabel(rule, c, spec.maxOpenCopies), count: skips.get(rule) as number }))
    .sort((a, b) => b.count - a.count);
  const underLiveMin = c.mode === 'live' ? 0 : taken.filter((x) => x.sol + 1e-12 < MIN_LIVE_COPY_SOL).length;
  const byMaxHold = taken.filter((x) => x.exitBy === 'maxHold').length;
  return {
    trips: ordered.length,
    copies: taken.length,
    priced: n,
    unpriced: taken.length - n,
    skipped,
    skippedTotal: skipped.reduce((a, s) => a + s.count, 0),
    totalSol,
    spentSol: n ? priced.reduce((a, x) => a + x.sol, 0) : null,
    medianPct: enough ? (n % 2 ? pcts[(n - 1) / 2] : (pcts[n / 2 - 1] + pcts[n / 2]) / 2) : null,
    meanPct: enough ? pcts.reduce((a, r) => a + r, 0) / n : null,
    meanSol: enough && totalSol !== null ? totalSol / n : null,
    winRatePct: enough ? (pcts.filter((r) => r > 0).length / n) * 100 : null,
    best: best ? toCopy(best) : null,
    withoutBestSol: n >= 2 && totalSol !== null && best ? totalSol - (best.pnlSol as number) : null,
    bestFewSol: fewOk ? byGain.slice(0, SCOUT_TRIMMED_DROP).reduce((a, x) => a + (x.pnlSol as number), 0) : null,
    restSol: fewOk ? byGain.slice(SCOUT_TRIMMED_DROP).reduce((a, x) => a + (x.pnlSol as number), 0) : null,
    days: [...dayMap.values()].sort((a, b) => a.day - b.day),
    underLiveMin,
    byMaxHold,
    notApplied: backtestNotApplied(c, spec.maxOpenCopies),
    assumptions: backtestAssumptions(spec, underLiveMin),
    lagMs,
    baseLagMs: spec.lag.baseLagMs,
    lagSource: spec.lag.source,
    delayMs: spec.lag.delayMs,
    depthSol: spec.depthSol,
    depthSource: spec.depthSource,
    copiesList: [...taken].reverse().map(toCopy),
  };
}

/** What the figures assume, in words — shown under them. */
export function backtestAssumptions(spec: BacktestSpec, underLiveMin = 0): string[] {
  const c = spec.config;
  const out: string[] = [];
  const s = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
  out.push(
    `Each copy lands ${s(spec.lag.lagMs)} behind their buy and their sell: ${spec.lag.note}${spec.lag.delayMs > 0 ? `, plus your ${spec.lag.delayMs} ms delay` : ''}.`,
  );
  out.push(
    `Priced with paper’s model: the venue’s and Krypt’s fee on both sides, the network fees of both transactions, and your own price impact both ways against a ${spec.depthSol} SOL pool — the pump curve’s floor, because the replay has no liquidity for each trade.`,
  );
  out.push(
    c.sizing === 'fixed'
      ? `Every copy ${sol3(Math.min(c.sizeValue, c.maxTradeSol))} SOL.`
      : `Each copy ${c.sizeValue}% of their opening buy, never more than ${sol3(c.maxTradeSol)} SOL.`,
  );
  const hold = ownExitsOf(c).maxHoldMin;
  out.push(
    c.copySells
      ? `Sold on their last sell${hold !== null ? `, or after ${hold} min held if that comes first` : ''}.`
      : `Their sells are not copied: sold after ${hold ?? '—'} min held.`,
  );
  out.push('Daily limits count by this machine’s local day, as the engine does; a loss limit counts only copies that could be priced.');
  if (c.mode !== 'live' && underLiveMin > 0)
    out.push(`${underLiveMin} cop${underLiveMin === 1 ? 'y is' : 'ies are'} under the ${MIN_LIVE_COPY_SOL} SOL live minimum: paper takes ${underLiveMin === 1 ? 'it' : 'them'}, live would refuse ${underLiveMin === 1 ? 'it' : 'them'}.`);
  return out;
}

/** The result in one sentence, or null when there is too little to say. */
export function backtestVerdict(r: BacktestResult): { kind: 'loss' | 'oneCopy' | 'tail' | 'positive'; text: string } | null {
  if (r.totalSol === null || r.priced < BACKTEST_MIN_COPIES) return null;
  const sol = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} SOL`;
  if (r.totalSol <= 0) return { kind: 'loss', text: `These settings lost ${sol(r.totalSol)} over ${r.priced} priced copies.` };
  if (r.withoutBestSol !== null && r.withoutBestSol <= 0 && r.best && r.best.pnlSol !== null)
    return { kind: 'oneCopy', text: `Positive (${sol(r.totalSol)}) only because of one copy: it made ${sol(r.best.pnlSol)}, the other ${r.priced - 1} made ${sol(r.withoutBestSol)}. Miss that one and it is a loss.` };
  if (r.restSol !== null && r.restSol <= 0 && r.bestFewSol !== null)
    return { kind: 'tail', text: `Positive (${sol(r.totalSol)}), but only because of the best ${SCOUT_TRIMMED_DROP} copies: they made ${sol(r.bestFewSol)}, the other ${r.priced - SCOUT_TRIMMED_DROP} made ${sol(r.restSol)}.` };
  return { kind: 'positive', text: `Positive (${sol(r.totalSol)} over ${r.priced} copies) and still positive without the best one. Past trades, not a forecast — paper-follow it before risking SOL.` };
}
