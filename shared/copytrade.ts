import { type ChainKind } from './evm';
import { minUnattendedBuySol, paperFixedFeeSol } from './exitBudget';
import { validateAiGate, type AiGateConfig } from './aiDesk';
import { FEE_BPS } from './fees';
import { SCOUT_SORTS, SCOUT_SORT_LABEL, type ScoutSort } from './scoutSort';
// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — copy trading (term.txt section 11).
//
// PAPER IS THE DEFAULT AND THE POINT.
//
// Six months of adversarial research in `docs/` failed to find a profitable
// automated memecoin strategy on this data, and copying a wallet is exactly
// such a strategy — one whose edge you have not measured, delegated to a
// stranger who does not know you exist. term.txt asks for paper-copy mode
// ("simulate following this wallet for 7 days without risking money") and
// that is the honest primary: you follow a wallet on paper, the app keeps an
// unforgiving scorecard, and only then do you get to decide.
//
// Live copying exists, is off, and requires the same arming as every other
// real trade plus its own daily loss limit. The UI shows the paper record
// next to the switch, so the decision is made against evidence rather than
// against a follower count.
// ──────────────────────────────────────────────────────────────────────

export type CopyMode = 'paper' | 'live';

/**
 * Which way a config trades against its leader (2026-09-20).
 *
 *   copy     buy when they buy, mirror their sells.
 *   reverse  buy when they SELL, sell when they buy back — and, because a
 *            leader almost never buys the same coin back, the position has
 *            its own exits: take-profit, stop-loss and a maximum hold.
 *
 * Reverse is the contrarian read of the same feed: the followability study
 * (docs/wallet-convergence-2026-09-14.md) found leaders' edge is latency
 * and their exits come early; fading an exit is a bet that the coin keeps
 * going after they leave. It is a bet, measured nowhere yet, so it starts
 * on paper like everything else and its scorecard is kept separately.
 */
/**
 * `watch` (2026-10-28, Maestro's "Track Only", Trojan's typed alerts): a
 * follow that NEVER trades. It records the leader's trades like any other
 * and tells the user about each one — first buy, buy more, sell part, sell
 * all, moved it away — in the app and through the chat bots. It is the way
 * to watch a wallet for a week before risking paper, let alone SOL.
 */
export type CopyDirection = 'copy' | 'reverse' | 'fomo' | 'watch';
export const DEFAULT_EXIT_TAKE_PROFIT_PCT = 25;
export const DEFAULT_EXIT_STOP_LOSS_PCT = 20;
export const DEFAULT_EXIT_MAX_HOLD_MIN = 30;

/**
 * FOMO copy (2026-09-20): buy when SEVERAL wallets from a set pile into the
 * same coin inside a window — the crowd, not one leader. The set is one of:
 *
 *   followed   every wallet with an enabled copy or reverse config
 *   saved      the wallets saved on the Scout
 *   tracked    the tracked-wallet list (labels, alerts)
 *   top        the Scout's top N over the last 7 days, by the board sort
 *              the config names (`fomoTopSort`, 2026-10-28: Week total,
 *              least bad to copy, copy score…) — the scanner's rankings as
 *              the crowd
 *   list       wallets the user picked (`fomoWallets`, 2026-10-28) — the
 *              ones ticked on Discover, or pasted
 *
 * Measured, this is the pattern the followability study called
 * "convergence" (docs/wallet-convergence-2026-09-14.md): with 2, 3 and 4
 * top wallets converging on a coin within minutes, the FOLLOWER's outcome
 * got worse with every extra wallet — −15 % → −32 % at 60 min, monotone,
 * both periods. The crowd is late by construction. It ships because it is
 * asked for by name; it ships on paper, with that number on the form.
 */
export type FomoSource = 'followed' | 'saved' | 'tracked' | 'top' | 'list';
export const FOMO_SOURCES: FomoSource[] = ['followed', 'saved', 'tracked', 'top', 'list'];
export const FOMO_SOURCE_LABEL: Record<FomoSource, string> = {
  followed: 'Followed wallets',
  saved: 'Saved Scout wallets',
  tracked: 'Tracked wallets',
  top: 'Top Scout wallets',
  list: 'Wallets I pick',
};
/** The board sort a `top` crowd is ranked by when the config names none —
 *  the copy score, as before 2026-10-28. */
export const DEFAULT_FOMO_TOP_SORT: ScoutSort = 'copyScore';
export const MAX_FOMO_WALLETS = 200;
export const DEFAULT_FOMO_MIN_WALLETS = 3;
export const DEFAULT_FOMO_WINDOW_SEC = 180;
export const DEFAULT_FOMO_TOP_N = 25;
/** Share of the wallets that triggered an entry that must have SOLD before
 *  the position follows them out. */
export const DEFAULT_FOMO_CROWD_EXIT_PCT = 50;
/** The `wallet` a FOMO config carries: it follows a set, not an address. */
export const FOMO_WALLET = 'fomo';
export const isFomo = (c: { direction?: CopyDirection | null }): boolean => c.direction === 'fomo';
/** Watch-only: alerts on every trade, never a copy. */
export const isWatch = (c: { direction?: CopyDirection | null }): boolean => c.direction === 'watch';

export type SizingMode =
  /** Always the same SOL amount, whatever they spent. */
  | 'fixed'
  /** A percentage of what they spent, capped. */
  | 'proportional';

/** Which chain a config lives on; absent (every config saved before 2026-09-11) is Solana. */
export const chainOf = (c: { chain?: ChainKind | null }): ChainKind => c.chain ?? 'solana';

export interface CopyConfig {
  id: string;
  /**
   * The chain the followed wallet trades on and the copies go out on.
   * Solana leaders are watched through the wallet decoder on any DEX;
   * Robinhood Chain and BNB leaders through the Observatory's trade feed —
   * their launchpad-curve trades (Pons, four.meme) while a token is on its
   * curve, which is where a memecoin's first hours happen. Amounts in the
   * `…Sol` fields are in that chain's own coin.
   */
  chain?: ChainKind;
  /** Wallet being followed. */
  wallet: string;
  label: string;
  enabled: boolean;
  mode: CopyMode;
  /** Absent (every config saved before 2026-09-20) is `copy`. */
  direction?: CopyDirection;
  /**
   * The position's OWN exits — take-profit and stop-loss in percent gross of
   * entry, hold in minutes — judged on every price tick.
   *
   * On a reverse or FOMO config absent means the shipped default, never
   * "off": those positions have no leader sell to close them, and a bag with
   * no exit is held until the user notices. On a copy config absent means
   * off — the leader's sells govern — and a value set is an extra exit on
   * top of them.
   */
  exitTakeProfitPct?: number | null;
  exitStopLossPct?: number | null;
  exitMaxHoldMin?: number | null;
  /** FOMO only: the set watched, how many of them inside how many seconds
   *  trigger an entry, the N for `top`, and the crowd-exit share. Absent
   *  means the defaults. */
  fomoSource?: FomoSource | null;
  fomoMinWallets?: number | null;
  fomoWindowSec?: number | null;
  fomoTopN?: number | null;
  fomoCrowdExitPct?: number | null;
  /** `top` only: the board sort the top N is taken from (2026-10-28). */
  fomoTopSort?: ScoutSort | null;
  /** `list` only: the wallets that are the crowd (2026-10-28). */
  fomoWallets?: string[] | null;

  sizing: SizingMode;
  /** `fixed`: SOL per trade. `proportional`: percent of their size. */
  sizeValue: number;
  /** Hard ceiling per copied trade, SOL. */
  maxTradeSol: number;

  /** Skip a copy when the token fails these. Null = no constraint. */
  minLiquidityUsd: number | null;
  maxMarketCapUsd: number | null;
  minKryptScore: number | null;
  /** Only copy tokens on these launchpads. Empty = any. */
  onlyPumpfun: boolean;

  // ── Filters every competitor ships and this app lacked (2026-09-21) ──
  // docs/copy-trade-competitors-2026-09-21.md. All optional; absent or null
  // is OFF, so every config saved before this day behaves exactly as it did.
  // Each one is a REFUSAL recorded on the scorecard, and a fact the engine
  // cannot read fails CLOSED — the same rule as the three filters above.
  /** Skip tokens under this market cap, USD. */
  minMarketCapUsd?: number | null;
  /** Their trade size band, in the chain's coin: a leader buy outside it is
   *  not copied (a 0.01 SOL probe is not a conviction buy; a 50 SOL one is
   *  a whale you cannot follow at your size). */
  minLeaderSol?: number | null;
  maxLeaderSol?: number | null;
  /** Token age band at the time of their buy, seconds. */
  minTokenAgeSec?: number | null;
  maxTokenAgeSec?: number | null;
  /** At most this many entries per token for this config; 1 = buy once.
   *  Skipped rows do not count, exits never do. */
  maxBuysPerToken?: number | null;
  /** Never copy these mints / tokens by these creators. */
  blockedMints?: string[] | null;
  blockedCreators?: string[] | null;
  /** A leader sell under this share of their bag is not mirrored, percent —
   *  a 3 % trim is noise; a copier chasing every trim pays the fee each time. */
  minLeaderSellPct?: number | null;
  /** Trailing stop, percent below the highest mark since entry. Armed from
   *  entry (a position that never rises stops at −X % like a stop-loss).
   *  Off unless set, on every direction. */
  exitTrailingPct?: number | null;

  // ── 2026-10-28: the exits and entry rules competitors ship that this app
  // lacked (docs/copy-trade-competitors-2026-09-21.md §5, items 2, 4, 6).
  // Absent on every config saved before = off.

  /**
   * Sell the whole copy when the coin's CREATOR sells this share of their
   * own bag or more, percent; 0 = any creator sell. Solana pump coins: the
   * curve feed names the creator on every trade, and their balance after
   * the sell sizes the share. An unreadable share fires the exit — a
   * creator dump is the one sell this rule exists for. Null = off.
   */
  exitOnCreatorSellPct?: number | null;
  /** Sell the whole copy the moment the coin graduates from pump's curve to
   *  PumpSwap. A live sell waits for the pool if it is not live yet. */
  exitOnMigration?: boolean;
  /**
   * Follow them out when they leave a coin WITHOUT a SOL sale — sent it to
   * another wallet, sold it for a stablecoin, swapped it for another token
   * (walletSwap.classifyUnseenExit). Sized from their balance after it,
   * like a sell whose size the transaction could not say. Copy direction,
   * with "copy their sells" on.
   */
  copyOtherExits?: boolean;
  /**
   * Trading hours, minutes after LOCAL midnight (0–1439), both set = on; a
   * start past the end wraps midnight (22:00–06:00). An entry outside them
   * is refused and recorded like any other filter; exits run around the
   * clock. The machine's own clock, because that is the clock the user
   * sets them by.
   */
  activeFromMin?: number | null;
  activeToMin?: number | null;
  /** Refuse a buy of a coin ANY follow already holds, or is buying this
   *  instant — two leaders in the same coin is one bet taken twice. */
  onePositionPerCoin?: boolean;
  /**
   * The AI desk (2026-10-28): an AI connected over MCP decides this follow's
   * entries and/or exits — shared/aiDesk.ts. Null or absent = off.
   */
  ai?: AiGateConfig | null;

  /** Wait this long after their trade before copying, ms. */
  delayMs: number;
  maxSlippagePct: number;
  /** Mirror their sells too, proportionally to what we hold. */
  copySells: boolean;
  /**
   * Which of this install's Solana wallets signs the copies. Null (or
   * absent, for a config saved before 2026-09-11) is the active wallet. With
   * it, an active trading wallet and a copy wallet can be different, and two
   * leaders can be followed on two wallets at once — every config is its own
   * runner, and this is the wallet it runs on.
   */
  walletId?: string | null;

  /** Stop copying for the day after losing this much (paper or live). */
  dailyLossLimitSol: number;
  /** Stop after this many copies in a day. */
  dailyTradeLimit: number;
  /**
   * Burst wall: at most this many copies in any rolling 60 s (2026-09-09).
   *
   * The daily limit is checked against copies that have already RESOLVED, so
   * a leader who fires eight swaps in one slot could out-run it. The engine
   * now reserves a slot before it buys, and this is the second wall: it is a
   * REFUSAL, never a clamp or a queue — the copy is skipped and recorded.
   *
   * Optional so a config persisted before this field, or one arriving from an
   * IPC payload that does not carry it yet, still validates; the engine reads
   * it as DEFAULT_COPIES_PER_MINUTE when absent.
   */
  maxCopiesPerMinute?: number | null;

  /**
   * Pause THIS follow once its copies have lost this much since it was last
   * switched on (2026-10-23), in the chain's coin. Null or absent = off. A
   * per-wallet stop: one leader having a bad run stops itself without
   * stopping the rest of the day. Exits keep being managed while paused.
   */
  walletLossStopSol?: number | null;
  /** When the stop above starts counting: set each time the follow is
   *  switched on, so a resumed follow is not re-paused by the old losses. */
  lossStopFrom?: number | null;
  /** Why the ENGINE paused this follow, and when — shown on its card until
   *  the user switches it back on. Null when it is on, or the user paused it. */
  pausedReason?: string | null;
  pausedAt?: number | null;

  createdAt: number;
}

/**
 * Failed LIVE copies in a row that pause a follow (2026-10-23). A buy that
 * was sent and failed — not a filter's skip. Three in a row is a broken
 * route, an empty wallet or a leader on a venue we cannot fill, and every
 * further try costs fees for nothing. Always on: it is a guardrail, not a
 * strategy (GMGN ships the same rule).
 */
export const COPY_FAIL_PAUSE = 3;

/**
 * A trade refused because the coin is between pump's curve and its PumpSwap
 * pool (2026-10-24). Since pump's synthetic migration (10-07), the buy that
 * empties the curve leaves the coin untradeable until `migrate_v2` runs:
 * every curve trade fails with `BondingCurveComplete`, and the pool the
 * PumpSwap builder looks for does not exist yet. How long that lasts is not
 * known (docs/swarm-2026-10-23/external.md). It is the venue moving, not a
 * broken route, so it never counts toward COPY_FAIL_PAUSE, and a sell waits
 * for the pool rather than being dropped.
 */
export function curveMigrating(message: string): boolean {
  if (/BondingCurveComplete/.test(message)) return true;
  return /graduated/.test(message) && /no PumpSwap pool for this mint/.test(message);
}
/** How often a sell refused by a migration is tried again, and for how long. */
export const MIGRATION_RETRY_MS = 15_000;
export const MIGRATION_WAIT_MAX_MS = 10 * 60_000;

/**
 * Open copies across EVERY follow, the app-wide ceiling's default
 * (`execution.maxOpenCopies`, 2026-10-23). Five leaders each opening a
 * position at once is five sizes at risk on coins that can go to zero in a
 * minute; the per-follow limits never saw the total. A refusal, recorded.
 */
export const DEFAULT_MAX_OPEN_COPIES = 5;

/** Applied when a config does not carry `maxCopiesPerMinute`. */
export const DEFAULT_COPIES_PER_MINUTE = 10;
/** Blocked mints / creators per config. */
export const MAX_BLOCKLIST = 100;

/** A blocklist as the engine compares it: trimmed, empties dropped, deduped
 *  (Solana addresses are case-sensitive, EVM ones are not — both spellings
 *  are kept, and the engine tests both). Null when nothing is left. */
export function cleanBlocklist(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const a = v.trim();
    if (!a || a.length > 64 || out.includes(a)) continue;
    out.push(a);
    if (out.length >= MAX_BLOCKLIST) break;
  }
  return out.length ? out : null;
}

/** Is `address` on a blocklist — exact for Solana, case-insensitive for EVM. */
export function isBlocked(list: string[] | null | undefined, address: string | null | undefined): boolean {
  if (!list || !list.length || !address) return false;
  const lower = address.toLowerCase();
  return list.some((a) => a === address || a.toLowerCase() === lower);
}

export const directionOf = (c: { direction?: CopyDirection | null }): CopyDirection =>
  c.direction === 'reverse' ? 'reverse' : c.direction === 'fomo' ? 'fomo' : c.direction === 'watch' ? 'watch' : 'copy';

/**
 * A config's own exits. Reverse and FOMO fill the defaults in; a copy
 * config's are off unless set (its leader's sells are its exits). Null =
 * off for that one exit.
 */
export function ownExitsOf(c: Pick<CopyConfig, 'direction' | 'exitTakeProfitPct' | 'exitStopLossPct' | 'exitMaxHoldMin' | 'exitTrailingPct'>): {
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldMin: number | null;
  /** Never defaulted: a trailing stop is opt-in on every direction. */
  trailingPct: number | null;
} {
  const d = directionOf(c);
  const n = (v: number | null | undefined, dflt: number): number | null => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    // A watch never holds anything, so it has nothing to exit.
    return d === 'copy' || d === 'watch' ? null : dflt;
  };
  return {
    takeProfitPct: n(c.exitTakeProfitPct, DEFAULT_EXIT_TAKE_PROFIT_PCT),
    stopLossPct: n(c.exitStopLossPct, DEFAULT_EXIT_STOP_LOSS_PCT),
    maxHoldMin: n(c.exitMaxHoldMin, DEFAULT_EXIT_MAX_HOLD_MIN),
    trailingPct: typeof c.exitTrailingPct === 'number' && Number.isFinite(c.exitTrailingPct) && c.exitTrailingPct > 0 ? c.exitTrailingPct : null,
  };
}

// ── Trading hours (2026-10-28) ─────────────────────────────────────────

/** The window, when both ends are set and differ; else null = all day. */
export function activeWindowOf(c: Pick<CopyConfig, 'activeFromMin' | 'activeToMin'>): { fromMin: number; toMin: number } | null {
  const f = c.activeFromMin;
  const t = c.activeToMin;
  if (typeof f !== 'number' || typeof t !== 'number' || !Number.isFinite(f) || !Number.isFinite(t) || f === t) return null;
  return { fromMin: f, toMin: t };
}

/** Is this minute of the day inside the window? A window past midnight
 *  (22:00–06:00) wraps. The start is inclusive, the end exclusive. */
export function inActiveWindow(w: { fromMin: number; toMin: number }, minuteOfDay: number): boolean {
  return w.fromMin < w.toMin ? minuteOfDay >= w.fromMin && minuteOfDay < w.toMin : minuteOfDay >= w.fromMin || minuteOfDay < w.toMin;
}

/** Minutes after LOCAL midnight — trading hours are set by the user's own clock. */
export function localMinuteOfDay(now = Date.now()): number {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/** 540 → "09:00". */
export const fmtClock = (min: number): string => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;

/** Preset trading hours, local time. Cosmetic: each is two numbers. */
export const ACTIVE_WINDOW_PRESETS: ReadonlyArray<{ label: string; fromMin: number; toMin: number }> = [
  { label: 'Day 08–22', fromMin: 8 * 60, toMin: 22 * 60 },
  { label: 'Work hours 09–17', fromMin: 9 * 60, toMin: 17 * 60 },
  { label: 'Evening 17–01', fromMin: 17 * 60, toMin: 60 },
  { label: 'Overnight 22–08', fromMin: 22 * 60, toMin: 8 * 60 },
];

/** A FOMO config's crowd rule, defaults filled in. */
export function fomoRuleOf(c: Pick<CopyConfig, 'fomoSource' | 'fomoMinWallets' | 'fomoWindowSec' | 'fomoTopN' | 'fomoCrowdExitPct' | 'fomoTopSort' | 'fomoWallets'>): {
  source: FomoSource;
  minWallets: number;
  windowSec: number;
  topN: number;
  crowdExitPct: number;
  topSort: ScoutSort;
  wallets: string[];
} {
  const n = (v: number | null | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return {
    source: c.fomoSource && FOMO_SOURCES.includes(c.fomoSource) ? c.fomoSource : 'followed',
    minWallets: n(c.fomoMinWallets, DEFAULT_FOMO_MIN_WALLETS),
    windowSec: n(c.fomoWindowSec, DEFAULT_FOMO_WINDOW_SEC),
    topN: n(c.fomoTopN, DEFAULT_FOMO_TOP_N),
    crowdExitPct: n(c.fomoCrowdExitPct, DEFAULT_FOMO_CROWD_EXIT_PCT),
    topSort: c.fomoTopSort && SCOUT_SORTS.includes(c.fomoTopSort) ? c.fomoTopSort : DEFAULT_FOMO_TOP_SORT,
    wallets: cleanBlocklist(c.fomoWallets) ?? [],
  };
}

/** The crowd in words, for a sentence like "buy when 3 of … buy the same coin". */
export function crowdNoun(c: Pick<CopyConfig, 'fomoSource' | 'fomoMinWallets' | 'fomoWindowSec' | 'fomoTopN' | 'fomoCrowdExitPct' | 'fomoTopSort' | 'fomoWallets'>): string {
  const f = fomoRuleOf(c);
  if (f.source === 'saved') return 'saved Scout wallets';
  if (f.source === 'tracked') return 'tracked wallets';
  if (f.source === 'top') return `the top ${f.topN} Scout wallets by ${SCOUT_SORT_LABEL[f.topSort]}`;
  if (f.source === 'list') return `the ${f.wallets.length} wallets you picked`;
  return 'followed wallets';
}

export interface CopyStats {
  configId: string;
  /** Paper and live are scored separately — they are different experiments. */
  mode: CopyMode;
  trades: number;
  wins: number;
  losses: number;
  /** Sum of realized PnL across closed copies, SOL. */
  realizedPnlSol: number;
  /** Currently open copies. */
  openCount: number;
  openCostSol: number;
  /** Skipped because a filter rejected the token. */
  skipped: number;
  /** Skipped because a limit was hit. */
  blocked: number;
  firstAt: number | null;
  lastAt: number | null;
  /**
   * Live exits whose result is not in `realizedPnlSol` yet (2026-10-22): the
   * sell landed, but the chain has not said what it paid. A live record is
   * priced from our own fills, never from the leader's price, so until the
   * fill is read the slice has no PnL — and the total says how many are
   * missing rather than reading as complete. Absent on older snapshots.
   */
  unpriced?: number;
  /**
   * Open copies of EITHER mode (2026-10-22). Stats are scored per mode, so a
   * config flipped from paper to live shows only its live rows above — but a
   * paused config still manages the exits of every open row, and the card
   * needs to be able to say so. Absent on older snapshots.
   */
  openAllModes?: number;
}

export type CopyTradeState = 'open' | 'closed' | 'skipped';

export interface CopyTrade {
  id: string;
  configId: string;
  mode: CopyMode;
  /** The config's chain at the time; absent = Solana. */
  chain?: ChainKind;
  wallet: string;
  mint: string;
  symbol: string;
  at: number;
  /** What they did. */
  theirSol: number;
  /** What we did (or would have done). */
  ourSol: number;
  entryPriceSol: number | null;
  exitPriceSol: number | null;
  closedAt: number | null;
  pnlSol: number | null;
  state: CopyTradeState;
  /** Why it was skipped, when it was. */
  reason: string | null;
  /** Absent = a copy. A reverse row was opened by the leader SELLING; a
   *  FOMO row by a crowd, named in `triggeredBy`. */
  direction?: CopyDirection;
  /** FOMO: the wallets whose buys triggered this entry. */
  triggeredBy?: string[];
  /**
   * `exit` = one sell mirrored from the leader (2026-09-08): a slice of a
   * copy, where `ourSol` is the cost basis of the share sold and `pnlSol`
   * its realised result. Absent = a copy (a buy). Until this existed a
   * leader's sell only marked the copy closed — no sell was placed, and the
   * history said "closed" over a wallet that still held every token.
   */
  kind?: 'exit';
  /** Highest mark seen since entry, for the trailing stop (2026-09-21).
   *  Absent on older rows and read as the entry. */
  peakPriceSol?: number;
  /** Exit: the copy it came out of. */
  parentId?: string;
  /** Exit: share of what we HELD that this slice actually sold, 1–100.
   *  When the quantity is tracked this is measured from the fill; without a
   *  tracked quantity it falls back to the leader's own fraction. */
  soldPct?: number;
  /** Exit: what the LEADER sold, 1–100, when it differs from `soldPct`.
   *  They are the same on an exact mirror; they diverge when our sell came
   *  back short, and the difference is the thing worth seeing. */
  leaderPct?: number;
  /** Copy: how much of it is still held, 0–100. Absent = all of it. */
  remainingPct?: number;
  /** Copy: realised across its exits so far, SOL. */
  realizedSol?: number;
  /** Transaction of a live fill, when there was one. */
  signature?: string | null;
  /**
   * The LEADER's own fill price for the trade this row copied, SOL per token
   * (2026-10-22). What we paid against what they paid is the entry premium:
   * the number that says whether a leader can be followed at all, and the one
   * no copier in the survey publishes. Absent on older rows and on rails
   * whose trade carries no price.
   */
  leaderPriceSol?: number | null;
  /**
   * Where `entryPriceSol` and `ourSol` came from on a LIVE copy: `fill` once
   * the chain's own lamport and token deltas for our buy were read, `mark`
   * while they were not (the spot price and the size we sent). Absent on
   * paper rows, which have no fill to read.
   */
  entryBasis?: 'fill' | 'mark';
  /**
   * The live fill's price WITHOUT the network fee and the token account's
   * rent (2026-10-28), which take-profit, stop-loss and the trailing stop
   * measure from. `entryPriceSol` stays the all-in figure the record is
   * priced with; anchoring the exits on it put a −20 % stop at about −9 % on
   * a 0.03 SOL copy. Absent = use `entryPriceSol`.
   */
  exitAnchorPriceSol?: number | null;
  /**
   * How an exit slice's `pnlSol` was priced (2026-10-22):
   *   • `model` — paper: the paper cost model (PAPER_MODEL) at the harsher of
   *     their price and the spot;
   *   • `fill` — live: SOL the sell actually returned, minus the slice's share
   *     of what the buy actually cost;
   *   • `pending` — live, but the sell's fill has not been read yet, so
   *     `pnlSol` is null and `estPnlSol` holds the model's estimate.
   * Absent on rows written before this, which were priced at the leader's
   * exit price with a 1.5 %/side cost.
   */
  pnlBasis?: 'model' | 'fill' | 'pending';
  /**
   * The model's estimate of a slice's result while its real one is unknown.
   * Never shown as a result and never in a total; the daily loss limit reads
   * it so an unread fill cannot hold a losing day open.
   */
  estPnlSol?: number | null;
  /** Exit: SOL this slice's sell returned, from the chain. Live only. */
  proceedsSol?: number | null;
  /** Exit: the share of the WHOLE copy this slice sold, 0–1 — what lets the
   *  slice's cost be re-derived when the buy's real cost arrives later. */
  shareOfCopy?: number;
  /** Paper: the version of the paper cost model this row was priced with.
   *  Absent = the pre-2026-10-22 model (1 %/side venue fee, no fixed fees),
   *  whose rows read better than the same trades would have done live. */
  paperModel?: number;
  /** Where the time went, their fill → ours (2026-09-21). Absent on rows
   *  written before it existed, and on an exit, which is timed by the
   *  leader's sell rather than by an entry race. */
  timing?: CopyTiming;
  /**
   * The AI desk's part in this row (2026-10-28): its verdict, or why there
   * was none and the follow's own rule decided. Absent = the follow does not
   * ask the AI.
   */
  ai?: { by: 'ai' | 'none'; text: string; ms: number };

  // ── Quantities (2026-09-15) ────────────────────────────────────────
  //
  // Everything above sizes a copy in SOL, and until now a mirrored sell was
  // sized in SOL too: the leader's fraction scaled by this config's share of
  // what the wallet PAID for the bag. Two positions bought at different
  // prices do not hold tokens in proportion to what they cost, so that ratio
  // is not the token share — and when it came out low the sell went out
  // small while the book still wrote the leader's fraction down as done.
  // A user's NON copy exited at "100 %", sold 52 % of the remaining tokens,
  // and was marked closed over 83,236 tokens that never left the wallet.
  //
  // So a live copy now carries the only number that settles it: base units,
  // from the confirmed fill. Decimal strings, because a u64 of a 6-decimal
  // memecoin runs past what a double holds exactly.
  //
  // All optional: a row opened before this, a paper row, and a rail whose
  // host cannot read balances all leave them absent, and absent means
  // "unknown" — the old percentage path, honestly labelled.

  /** Copy: base units the confirmed buy actually delivered. */
  tokensRaw?: string | null;
  /** Copy: base units of `tokensRaw` this copy still holds. */
  tokensLeftRaw?: string | null;
  /** Decimals for every raw amount on this row. */
  tokenDecimals?: number | null;
  /** Exit: base units this slice actually removed from the wallet. */
  soldRaw?: string | null;
  /** Exit: base units the sell was ASKED for, when it came back short. */
  wantedRaw?: string | null;
  /**
   * Copy: base units still in the wallet after this copy was marked closed.
   *
   * The balance sweep sets it. Non-null is a flag, not bookkeeping: the app
   * is saying "our record says done, the chain says these are still here".
   */
  leftoverRaw?: string | null;
}

/** A raw base-unit string as a bigint, or null when it is absent or junk. */
export function rawOf(s: string | null | undefined): bigint | null {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/** Whole tokens for a raw amount, for display only — never for sizing. */
export function uiTokens(raw: bigint, decimals: number | null | undefined): number {
  const d = typeof decimals === 'number' && decimals >= 0 && decimals <= 18 ? decimals : 0;
  return Number(raw) / 10 ** d;
}

/**
 * Below this share of the copy's original quantity, a remainder is dust.
 *
 * A sell is a share of a balance that moves under it, so the last few base
 * units routinely do not leave — and a copy held open over 40 base units of
 * a 1e15 position is noise dressed as a finding. 0.5 % matches the
 * `remainingPct` threshold the percentage path has always closed on.
 */
export const EXIT_DUST_PCT = 0.5;

/** Is `left` dust against an original quantity of `total`? */
export function isDustRemainder(left: bigint, total: bigint): boolean {
  if (left <= 0n) return true;
  if (total <= 0n) return false;
  return left * 1_000n <= total * BigInt(Math.round(EXIT_DUST_PCT * 10));
}

/**
 * How a followed wallet is being watched. Since 2026-09-06 every followed
 * wallet has its own subscription on the live socket, and its swaps are
 * read from the transaction's balance deltas — so a leader trading through
 * Jupiter into Raydium or Meteora is seen, not only one on the pump.fun
 * curve. `over-cap` means THE HOST refused a subscription and the watcher
 * learned a ceiling from that refusal — it is never an invented number.
 * Measured 2026-09-09: the public endpoint acked 16 subscriptions on ONE
 * socket, and `x-ratelimit-pubsub-limit: 10` counts CONNECTIONS per IP, not
 * subscriptions per socket. The old reading silently unwatched leaders past
 * ten and told the user to buy a key for a limit that does not exist.
 */
export interface CopyWatchStatus {
  state: 'watching' | 'connecting' | 'over-cap' | 'off';
  /** Last transaction seen from the wallet (any kind), ms. */
  lastSeenAt: number | null;
  /** Last SWAP decoded from it, ms. */
  lastSwapAt: number | null;
  seen: number;
  swaps: number;
  /** Seen but never readable from the RPC after every retry — those trades
   *  were NOT copied (2026-09-20). Absent on status built before it. */
  unreadable?: number;
  /** Read, but not a copyable swap (transfers, LP moves, claims). */
  notSwap?: number;
  /** Of those, how many were the leader LEAVING a token in a way the copier
   *  cannot mirror (a stablecoin sale, a token-for-token route, a transfer
   *  out) — 2026-10-23, counted before anything mirrors them. */
  unseenExits?: number;
  /** Which subscription the socket rides (2026-09-21): `logs` reads each
   *  trade back, `tx` (Helius transactionSubscribe, paid plans) receives it
   *  with the notification, `parsed` (Helius Parsed Streams, 2026-10-24)
   *  hears it ~120 ms before `logs` and decodes a clean curve buy from the
   *  push. Absent on status built before it. */
  feed?: 'logs' | 'tx' | 'parsed';
}

export interface CopySnapshot {
  configs: CopyConfig[];
  stats: Record<string, CopyStats>;
  recent: CopyTrade[];
  /** Live copying is possible right now. */
  liveExecutable: boolean;
  liveBlockedReason: string | null;
  /**
   * Why the EXITS of live copies already bought cannot go out, or null
   * (2026-10-28). Narrower than `liveBlockedReason`: a breaker that switched
   * live off stops entries, not these exits. Set when live was switched off
   * by hand (or the kill switch, or a restart) — the follow cards say it
   * wherever a live copy is open, because its stops are then not working.
   */
  exitBlockedReason?: string | null;
  /** Open LIVE copies per follow id, whatever the follow's mode is now. */
  liveOpen?: Record<string, number>;
  /** Per followed wallet: is it being watched, and when was it last seen. */
  watch: Record<string, CopyWatchStatus>;
  /** Per followed wallet: THEIR record, from every swap seen (below). */
  leaders: Record<string, LeaderStats>;
  /**
   * The store existed but could not be read, so nothing is being saved this
   * session (2026-09-09). Null on a healthy load. Optional so a snapshot
   * built before this field still satisfies the type.
   */
  loadFailure?: string | null;
  /** Per FOMO config (2026-09-20): which set it listens to and how many
   *  wallets that set holds right now. Zero is an honest zero — a source the
   *  host cannot answer, or a Scout with nothing saved. */
  crowd?: Record<string, { source: FomoSource; wallets: number }>;
  /** Where the time goes on a copy, this session (2026-09-21). Absent on a
   *  snapshot built before it existed. */
  latency?: CopyLatency;
  /**
   * Realised result per local day, paper and live apart (2026-10-22) — what
   * the Home page's chart draws. Only PRICED results: a live exit still
   * waiting for its fill is not in it. Days with nothing closed are absent;
   * oldest first, the last 60 days.
   */
  pnlByDay?: Record<CopyMode, Array<{ day: number; pnl: number; closed: number }>>;
}

// ── The leader's own record ───────────────────────────────────────────
//
// The copy scorecard answers "what did following them cost or make ME,
// through my filters and delay". A user running five wallets on paper is
// asking a different question — "are they any good" — and the copies alone
// cannot answer it: the filters skip most of what a leader does. So every
// swap seen on a followed wallet is scored as THEIR trade (2026-09-08),
// average-cost per token, from the first buy seen to the sell that leaves
// nothing. A sell of tokens bought BEFORE we watched has no known cost and
// is counted, never scored — the record must not flatter itself with
// proceeds whose cost it did not see.

/** One of the leader's round trips: first buy seen → last sell. */
export interface LeaderRoundTrip {
  mint: string;
  symbol: string;
  /** SOL they spent on it while watched. */
  costSol: number;
  /** SOL they got back. */
  proceedsSol: number;
  pnlSol: number;
  openedAt: number;
  closedAt: number;
  buys: number;
  sells: number;
}

export interface LeaderStats {
  wallet: string;
  /** First swap seen, ms — the record starts here, not at their history. */
  watchedSince: number | null;
  lastTradeAt: number | null;
  buys: number;
  sells: number;
  /** Positions opened AND closed while watched. */
  roundTrips: number;
  wins: number;
  losses: number;
  /** Closed round trips plus the sold share of open ones, SOL. */
  realizedPnlSol: number;
  /** SOL they put into positions while watched. */
  volumeSol: number;
  openCount: number;
  openCostSol: number;
  /** Open positions at the last price known; null when none is priced. */
  unrealizedPnlSol: number | null;
  avgHoldMs: number | null;
  /** MEDIAN hold across closed round trips, ms. `avgHoldMs` is dragged by one
   *  long position; the median is what the wallet usually does, and on the
   *  measured tape the two differ by orders of magnitude. */
  medianHoldMs: number | null;
  /** Share of closed round trips that opened AND closed faster than
   *  `COPY_LATENCY_FLOOR_MS` — trips a copier could not have been inside.
   *  Null before any trip closes. */
  tooFastPct: number | null;
  bestSol: number | null;
  worstSol: number | null;
  /** Sells (or parts of sells) of tokens bought before we watched. */
  unscoredSells: number;
  /** Buys + sells per day since the first swap seen. */
  tradesPerDay: number | null;
  /** Realised over cost across closed round trips, %. */
  returnPct: number | null;
  /** Newest first. */
  recentTrips: LeaderRoundTrip[];
}

export function emptyLeaderStats(wallet: string): LeaderStats {
  return {
    wallet,
    watchedSince: null,
    lastTradeAt: null,
    buys: 0,
    sells: 0,
    roundTrips: 0,
    wins: 0,
    losses: 0,
    realizedPnlSol: 0,
    volumeSol: 0,
    openCount: 0,
    openCostSol: 0,
    unrealizedPnlSol: null,
    avgHoldMs: null,
    medianHoldMs: null,
    tooFastPct: null,
    bestSol: null,
    worstSol: null,
    unscoredSells: 0,
    tradesPerDay: null,
    returnPct: null,
    recentTrips: [],
  };
}

/** Win rate over closed round trips, or null before any closed. */
export function leaderWinRate(s: LeaderStats): number | null {
  const n = s.wins + s.losses;
  return n > 0 ? (s.wins / n) * 100 : null;
}

/** Fewer closed round trips than this and a rank says nothing — such a
 *  wallet sorts after every wallet with a real sample, whatever its number. */
export const MIN_TRIPS_FOR_RANK = 5;

/**
 * Below this hold, a round trip is not copyable — not "worse", NOT copyable.
 *
 * A copier has to see the leader's buy on the feed, decide, build, sign and
 * land; then do the whole thing again to exit. A position that opens and
 * closes inside this window was over before a follower could be in it, so the
 * leader's profit on it is unreachable by construction.
 *
 * The number matters because of what the tape says. Measured over 9.3M curve
 * trades across two day-pairs six weeks apart
 * (docs/wallet-convergence-2026-09-14.md), the MEDIAN profitable pump wallet
 * holds SIX SECONDS. Their edge is latency. Ranking them by their own PnL —
 * which is what this file did until 2026-09-14 — therefore surfaces precisely
 * the wallets a user cannot copy.
 *
 * One minute is deliberately generous: it is not a claim that a 61-second trip
 * is comfortably copyable, only that a sub-minute one certainly is not.
 */
export const COPY_LATENCY_FLOOR_MS = 60_000;

/**
 * A wallet is flagged when most of its record is unreachable.
 *
 * Deliberately NOT a quality score. The same measurements found that longer
 * holds are not more profitable to follow — the 1-10 minute bucket was WORSE
 * than the sub-minute one, and no hold bucket was profitable in either period.
 * So this says "you could not have been in these trades", never "these trades
 * are good".
 */
export const TOO_FAST_FLAG_PCT = 50;

export type LeaderRankKey =
  | 'realizedPnlSol' | 'returnPct' | 'winRatePct' | 'tradesPerDay' | 'unrealizedPnlSol' | 'medianHoldMs';

export const LEADER_RANK_KEYS: Array<{ key: LeaderRankKey; label: string }> = [
  { key: 'realizedPnlSol', label: 'Realized' },
  { key: 'returnPct', label: 'Return %' },
  { key: 'winRatePct', label: 'Win rate' },
  { key: 'tradesPerDay', label: 'Trades / day' },
  { key: 'unrealizedPnlSol', label: 'Unrealized' },
  // Longest first, so the wallets a copy could actually be inside are findable
  // at all. A sort order, not a recommendation.
  { key: 'medianHoldMs', label: 'Hold time' },
];

/** True when most of this wallet's closed trips were over before a copy could
 *  have joined them. Null-safe: an unmeasured wallet is never flagged. */
export function leaderTooFast(s: LeaderStats): boolean {
  return s.tooFastPct !== null && s.roundTrips >= MIN_TRIPS_FOR_RANK && s.tooFastPct >= TOO_FAST_FLAG_PCT;
}

/** Best first by the chosen key. Small samples rank after real ones;
 *  unknowns (null) after everything; ties broken by more round trips. */
export function rankLeaders(list: LeaderStats[], by: LeaderRankKey): LeaderStats[] {
  const val = (s: LeaderStats): number | null => (by === 'winRatePct' ? leaderWinRate(s) : s[by]);
  const enough = (s: LeaderStats): boolean => s.roundTrips >= MIN_TRIPS_FOR_RANK;
  return [...list].sort((a, b) => {
    const ea = enough(a);
    const eb = enough(b);
    if (ea !== eb) return ea ? -1 : 1;
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return b.roundTrips - a.roundTrips;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (vb !== va) return vb - va;
    return b.roundTrips - a.roundTrips;
  });
}

// ── Copy Simple (2026-09-20) ──────────────────────────────────────────
//
// The simple page asks three things — whose wallet, how much per trade, and
// which chain when a 0x address does not say — and derives the rest. Same
// config, same store, same engine as the full page; only the questions are
// fewer. The derivation is here, not in the page, so a test can pin it and
// the full page can show exactly what the simple one saved.

/**
 * The smallest live Solana copy: the fast lane's round-trip priority fees are
 * at most 10% of it (0.03 SOL). Copies always send on the fast lane. Checked
 * when a config is saved as live AND again at the last gate before a live
 * buy, so a proportional copy that sizes below it is refused, not sent.
 */
export const MIN_LIVE_COPY_SOL = minUnattendedBuySol('fast');

/** The per-trade sizes the simple page offers, in the chain's native coin. */
export const SIMPLE_SIZES = [0.05, 0.1, 0.25, 0.5] as const;
/** The most the simple page will size a trade at; more needs the full page. */
export const SIMPLE_MAX_SOL = 5;
/**
 * Daily loss limit as a multiple of the per-trade size: 3 (2026-10-23, was
 * 10). A median mirrored copy loses 4–7 %, so twenty copies cost about 1–1.4
 * sizes on an ordinary day; three trips on a bad day, not a normal one. Ten
 * let a bad day run to ten whole sizes (wallet-finder research §6).
 */
export const SIMPLE_LOSS_MULTIPLE = 3;
/** The per-wallet stop as a multiple of the size: four sizes lost since the
 *  follow was switched on pauses that follow alone. */
export const SIMPLE_WALLET_STOP_MULTIPLE = 4;
/**
 * The missed-sell backstop on every simple follow (2026-10-23): a copy still
 * open 30 minutes after it was bought is sold, whether or not the leader's
 * sell was seen. Mirror-only follows had no exit of their own, so one missed
 * leader sell (a socket gap, an unreadable transaction) held the bag for
 * ever. Held-out replay on three tape day-pairs: missing 15 % of leader sells
 * cost 0.6–2.1 points per copy at last-print marks and the 30-minute
 * backstop got back about a fifth of that, while costing nothing measurable
 * on copies whose sells were seen (24 h recovered nothing in-window). It is
 * a backstop, not an edge: the user can clear it on the full page.
 */
export const SIMPLE_BACKSTOP_MIN = 30;
/**
 * Below this size a mirrored TRIM costs more in its own sell fee than it is
 * worth (a sell transaction is ~0.0024 SOL in fixed fees, over 2 % of a
 * copy under ~0.12 SOL), so simple follows of that size mirror only leader
 * sells of at least `SIMPLE_SMALL_MIN_SELL_PCT` of their bag. A leader's
 * last sell is always 100 % of what they have left, so the exit itself is
 * never skipped. Held out on all three day-pairs: +0.5 to +1.7 points per
 * copy, all of it fees (swarm 2026-10-23, exits angle).
 */
export const SIMPLE_FEE_AWARE_BELOW_SOL = 0.12;
export const SIMPLE_SMALL_MIN_SELL_PCT = 50;

/** What kind of address this is, from its shape alone. Null = neither. */
export function chainForAddress(address: string): 'solana' | 'evm' | null {
  const a = address.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'solana';
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'evm';
  return null;
}

/**
 * The whole config from three answers. Fixed sizing at `perTrade` (clamped
 * to 0.001–SIMPLE_MAX_SOL; a bad number becomes the second offered size),
 * the per-trade cap equal to it, a daily loss limit of three trades' worth,
 * a per-wallet stop of four,
 * paper, and switched ON — a paper follow has nothing to arm. Everything
 * else is `defaultConfig`, so a simple follow reads sensibly on the full page.
 */
export function simpleConfig(wallet: string, label: string, chain: ChainKind, perTrade: number): Omit<CopyConfig, 'id' | 'createdAt'> {
  const wanted = Number.isFinite(perTrade) && perTrade > 0 ? perTrade : SIMPLE_SIZES[1];
  return followConfig(wallet, label, chain, 'fixed', Math.min(SIMPLE_MAX_SOL, wanted));
}

/** The "% of their trade" choices the Follow page offers. */
export const FOLLOW_PCTS = [10, 25, 50, 100] as const;
/** The most one copy may be on the Follow page — validateConfig's ceiling. */
export const FOLLOW_MAX_SOL = 25;

/**
 * The Follow page's config (2026-10-24): sizing either way, and every limit
 * derived from the most one copy can spend — the fixed size, or the cap on a
 * percentage copy. A percentage copy is never bigger than its cap, so a loss
 * limit of three caps is the same three trips' worth a fixed follow gets. The
 * fee-aware trim rule keys off that cap too: when even the biggest copy is
 * under SIMPLE_FEE_AWARE_BELOW_SOL, every copy is, and small trims are noise.
 * Paper and switched on, like the simple follow; the page can change the rest.
 */
export function followConfig(
  wallet: string,
  label: string,
  chain: ChainKind,
  sizing: SizingMode,
  value: number,
  cap?: number,
): Omit<CopyConfig, 'id' | 'createdAt'> {
  const sol = (v: number | undefined, dflt: number): number =>
    Math.round(Math.min(FOLLOW_MAX_SOL, Math.max(0.001, typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt)) * 1_000) / 1_000;
  const pct = sizing === 'proportional';
  const most = pct ? sol(cap, SIMPLE_SIZES[1]) : sol(value, SIMPLE_SIZES[1]);
  const share = Math.round(Math.min(500, Math.max(1, Number.isFinite(value) && value > 0 ? value : FOLLOW_PCTS[1])) * 100) / 100;
  const base = defaultConfig(wallet.trim(), label.trim(), chain, 'copy');
  return {
    ...base,
    enabled: true,
    mode: 'paper',
    sizing: pct ? 'proportional' : 'fixed',
    sizeValue: pct ? share : most,
    maxTradeSol: most,
    dailyLossLimitSol: Math.round(most * SIMPLE_LOSS_MULTIPLE * 1_000) / 1_000,
    walletLossStopSol: Math.round(most * SIMPLE_WALLET_STOP_MULTIPLE * 1_000) / 1_000,
    copySells: true,
    exitMaxHoldMin: SIMPLE_BACKSTOP_MIN,
    // Every size, not only small copies (2026-10-25): mirroring a trim under
    // half their bag pays a round of fees on a slice; on the tape, skipping
    // them was worth +0.5 to +1.7 points a copy. Their last sell is always
    // 100 %, so the exit itself is never skipped.
    minLeaderSellPct: SIMPLE_SMALL_MIN_SELL_PCT,
    // A percentage of a small buy is a copy live refuses (under
    // MIN_LIVE_COPY_SOL). Skip those buys by their size, so paper skips the
    // same ones live would and its record is one live could have made.
    minLeaderSol: pct && chain === 'solana' ? minLeaderFor(share) : null,
  };
}

/** The smallest buy of theirs a `share`% copy can follow on live Solana:
 *  under it the copy would be below MIN_LIVE_COPY_SOL. Rounded up. */
export function minLeaderFor(share: number): number {
  // The epsilon keeps a float like 120.00000000000001 from rounding to 121.
  return Math.ceil((MIN_LIVE_COPY_SOL / (share / 100)) * 1_000 - 1e-9) / 1_000;
}

export function defaultConfig(wallet: string, label: string, chain: ChainKind = 'solana', direction: CopyDirection = 'copy'): Omit<CopyConfig, 'id' | 'createdAt'> {
  return {
    chain,
    wallet: direction === 'fomo' ? FOMO_WALLET : wallet,
    label,
    enabled: false,
    direction,
    // A copy's own exits are off; a reverse's or FOMO's are the defaults.
    exitTakeProfitPct: direction === 'copy' ? null : DEFAULT_EXIT_TAKE_PROFIT_PCT,
    exitStopLossPct: direction === 'copy' ? null : DEFAULT_EXIT_STOP_LOSS_PCT,
    exitMaxHoldMin: direction === 'copy' ? null : DEFAULT_EXIT_MAX_HOLD_MIN,
    fomoSource: direction === 'fomo' ? 'followed' : null,
    fomoMinWallets: direction === 'fomo' ? DEFAULT_FOMO_MIN_WALLETS : null,
    fomoWindowSec: direction === 'fomo' ? DEFAULT_FOMO_WINDOW_SEC : null,
    fomoTopN: direction === 'fomo' ? DEFAULT_FOMO_TOP_N : null,
    fomoCrowdExitPct: direction === 'fomo' ? DEFAULT_FOMO_CROWD_EXIT_PCT : null,
    fomoTopSort: direction === 'fomo' ? DEFAULT_FOMO_TOP_SORT : null,
    fomoWallets: null,
    // Paper. Always paper, until the user has a reason not to.
    mode: 'paper',
    sizing: 'fixed',
    sizeValue: 0.05,
    maxTradeSol: 0.1,
    minLiquidityUsd: 5_000,
    maxMarketCapUsd: null,
    minKryptScore: null,
    onlyPumpfun: false,
    minMarketCapUsd: null,
    minLeaderSol: null,
    maxLeaderSol: null,
    minTokenAgeSec: null,
    maxTokenAgeSec: null,
    maxBuysPerToken: null,
    blockedMints: null,
    blockedCreators: null,
    minLeaderSellPct: null,
    exitTrailingPct: null,
    exitOnCreatorSellPct: null,
    exitOnMigration: false,
    copyOtherExits: false,
    activeFromMin: null,
    activeToMin: null,
    onePositionPerCoin: false,
    ai: null,
    delayMs: 0,
    // 8 %, not 15 (2026-10-25): swaps into pump coins at 10–20 % slippage
    // were sandwiched 87 times per 10,000 against 8 at 1–3 % (Bitquery,
    // 6.85 M sandwiches). A copy is the ideal victim — a known size into a
    // thin curve at a predictable moment — so the default stays under the
    // band. A fill that needs more is a trade that moved past the leader.
    maxSlippagePct: 8,
    copySells: true,
    walletId: null,
    dailyLossLimitSol: 0.25,
    dailyTradeLimit: 20,
    maxCopiesPerMinute: DEFAULT_COPIES_PER_MINUTE,
  };
}

export function validateConfig(c: Omit<CopyConfig, 'id' | 'createdAt'>): { ok: boolean; message: string } {
  // The full base58 shape, not just a length: this string is handed to the
  // wallet watcher to subscribe on, and `copy:resetStats` has always checked
  // it properly while the save path did not.
  const chain = chainOf(c);
  if (c.direction !== undefined && c.direction !== null && c.direction !== 'copy' && c.direction !== 'reverse' && c.direction !== 'fomo' && c.direction !== 'watch') {
    return { ok: false, message: 'Direction must be copy, reverse, fomo or watch' };
  }
  // A watch never trades, so there is nothing for "live" to mean — and a
  // config that cannot be live cannot be armed by mistake.
  if (isWatch(c) && c.mode === 'live') return { ok: false, message: 'A watch-only follow never trades, so it cannot be live' };
  if (isFomo(c)) {
    // A crowd, not an address. Solana only: the crowd is heard on the pump
    // curve feed, and the followed wallets on their own subscriptions.
    if (chain !== 'solana') return { ok: false, message: 'Convergence watches the Solana feeds only' };
    if (c.wallet !== FOMO_WALLET) return { ok: false, message: 'A convergence follow listens to a set of wallets, not one address' };
  } else if (chain === 'solana') {
    if (!c.wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.wallet)) return { ok: false, message: 'Enter a valid wallet address' };
  } else if (!c.wallet || !/^0x[0-9a-fA-F]{40}$/.test(c.wallet)) {
    return { ok: false, message: `Enter a valid 0x address on ${chain === 'robinhood' ? 'Robinhood Chain' : 'BNB Smart Chain'}` };
  }
  if (c.walletId !== undefined && c.walletId !== null && (typeof c.walletId !== 'string' || !c.walletId)) return { ok: false, message: 'Pick a wallet to copy with, or leave it on the active one' };
  if (!(c.sizeValue > 0)) return { ok: false, message: 'Size must be greater than zero' };
  // The live minimum (2026-10-22): a live Solana copy smaller than this pays
  // over 10% of itself in priority fees on the round trip — the same floor
  // scripts have had since 09-28. Paper is not held to it, so a paper trial
  // can still show what a tiny size costs; switching it to live cannot.
  if (c.mode === 'live' && chain === 'solana') {
    const most = c.sizing === 'fixed' ? c.sizeValue : c.maxTradeSol;
    if (most < MIN_LIVE_COPY_SOL) {
      return {
        ok: false,
        message: `The smallest live copy is ${MIN_LIVE_COPY_SOL} SOL — below that, network fees take over 10% of each copy. Raise the ${c.sizing === 'fixed' ? 'size' : 'max per trade'}, or keep it on paper.`,
      };
    }
  }
  if (c.sizing === 'proportional' && c.sizeValue > 500) {
    return { ok: false, message: 'Proportional size cannot exceed 500% of their trade' };
  }
  if (!(c.maxTradeSol > 0) || c.maxTradeSol > 25) {
    return { ok: false, message: 'Max per trade must be between 0 and 25 SOL' };
  }
  if (c.sizing === 'fixed' && c.sizeValue > c.maxTradeSol) {
    return { ok: false, message: 'Fixed size is above your own max per trade' };
  }
  if (c.delayMs < 0 || c.delayMs > 60_000) return { ok: false, message: 'Delay must be between 0 and 60 seconds' };
  if (c.maxSlippagePct <= 0 || c.maxSlippagePct > 50) {
    return { ok: false, message: 'Slippage must be between 0% and 50%' };
  }
  if (!(c.dailyLossLimitSol > 0)) return { ok: false, message: 'Set a daily loss limit' };
  if (!(c.dailyTradeLimit > 0) || c.dailyTradeLimit > 500) {
    return { ok: false, message: 'Daily trade limit must be between 1 and 500' };
  }
  // Absent is allowed and means the default; present must be sane.
  if (c.maxCopiesPerMinute !== undefined && c.maxCopiesPerMinute !== null) {
    if (!(c.maxCopiesPerMinute > 0) || c.maxCopiesPerMinute > 120) {
      return { ok: false, message: 'Copies per minute must be between 1 and 120' };
    }
  }
  const stop = c.walletLossStopSol;
  if (stop !== undefined && stop !== null && (!(stop > 0) || stop > 1_000)) return { ok: false, message: 'The per-wallet stop must be between 0 and 1000' };
  // Own exits: a value that is present must be sane, whatever the direction.
  const tp = c.exitTakeProfitPct;
  if (tp !== undefined && tp !== null && (!(tp > 0) || tp > 1_000)) return { ok: false, message: 'Take-profit must be between 1% and 1000%' };
  const sl = c.exitStopLossPct;
  if (sl !== undefined && sl !== null && (!(sl > 0) || sl > 95)) return { ok: false, message: 'Stop-loss must be between 1% and 95%' };
  const hold = c.exitMaxHoldMin;
  if (hold !== undefined && hold !== null && (!(hold > 0) || hold > 1_440)) return { ok: false, message: 'Max hold must be between 1 and 1440 minutes' };
  const trail = c.exitTrailingPct;
  if (trail !== undefined && trail !== null && (!(trail > 0) || trail > 95)) return { ok: false, message: 'Trailing stop must be between 1% and 95%' };
  // The 2026-09-21 filters. Absent or null is off; a value that is present
  // must be sane, and a band must not be empty.
  const opt = (v: number | null | undefined): number | null => (v === undefined || v === null ? null : v);
  const minMc = opt(c.minMarketCapUsd);
  if (minMc !== null && !(minMc >= 0)) return { ok: false, message: 'Min market cap must be zero or more' };
  if (minMc !== null && c.maxMarketCapUsd !== null && c.maxMarketCapUsd !== undefined && minMc > c.maxMarketCapUsd) {
    return { ok: false, message: 'Min market cap is above your max market cap' };
  }
  const minL = opt(c.minLeaderSol);
  const maxL = opt(c.maxLeaderSol);
  if (minL !== null && !(minL >= 0)) return { ok: false, message: 'Their minimum trade size must be zero or more' };
  if (maxL !== null && !(maxL > 0)) return { ok: false, message: 'Their maximum trade size must be greater than zero' };
  if (minL !== null && maxL !== null && minL > maxL) return { ok: false, message: 'Their minimum trade size is above the maximum' };
  const minAge = opt(c.minTokenAgeSec);
  const maxAge = opt(c.maxTokenAgeSec);
  if (minAge !== null && !(minAge >= 0)) return { ok: false, message: 'Token age must be zero or more' };
  if (maxAge !== null && !(maxAge > 0)) return { ok: false, message: 'Max token age must be greater than zero' };
  if (minAge !== null && maxAge !== null && minAge > maxAge) return { ok: false, message: 'Min token age is above the max' };
  const perToken = opt(c.maxBuysPerToken);
  if (perToken !== null && (!Number.isInteger(perToken) || perToken < 1 || perToken > 100)) return { ok: false, message: 'Max buys per token must be a whole number from 1 to 100' };
  for (const [list, what] of [[c.blockedMints, 'token'], [c.blockedCreators, 'creator']] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length > MAX_BLOCKLIST) return { ok: false, message: `At most ${MAX_BLOCKLIST} blocked ${what}s` };
    if (list.some((a) => typeof a !== 'string' || !a.trim() || a.length > 64)) return { ok: false, message: `A blocked ${what} must be an address` };
  }
  const minSell = opt(c.minLeaderSellPct);
  if (minSell !== null && (!(minSell > 0) || minSell > 100)) return { ok: false, message: 'Mirror sells of at least must be between 1% and 100%' };
  // The 2026-10-28 rules.
  const devSell = opt(c.exitOnCreatorSellPct);
  if (devSell !== null && (!(devSell >= 0) || devSell > 100)) return { ok: false, message: 'The creator-sell exit must be between 0% and 100% of their bag' };
  const from = opt(c.activeFromMin);
  const to = opt(c.activeToMin);
  if ((from === null) !== (to === null)) return { ok: false, message: 'Trading hours need both a start and an end' };
  if (from !== null && to !== null) {
    const timeOfDay = (v: number): boolean => Number.isInteger(v) && v >= 0 && v < 1_440;
    if (!timeOfDay(from) || !timeOfDay(to)) return { ok: false, message: 'Trading hours must be times of day' };
    if (from === to) return { ok: false, message: 'Trading hours start and end at the same time — switch them off to copy all day' };
  }
  const ai = validateAiGate(c.ai);
  if (!ai.ok) return ai;
  if (isFomo(c)) {
    if (c.fomoSource !== undefined && c.fomoSource !== null && !FOMO_SOURCES.includes(c.fomoSource)) return { ok: false, message: 'Pick which wallets the crowd is' };
    const k = c.fomoMinWallets;
    if (k !== undefined && k !== null && (!(k >= 2) || k > 50)) return { ok: false, message: 'Convergence needs between 2 and 50 wallets to trigger' };
    const w = c.fomoWindowSec;
    if (w !== undefined && w !== null && (!(w >= 10) || w > 3_600)) return { ok: false, message: 'The convergence window must be between 10 seconds and an hour' };
    const n = c.fomoTopN;
    if (n !== undefined && n !== null && (!(n >= 2) || n > 200)) return { ok: false, message: 'Top N must be between 2 and 200' };
    const x = c.fomoCrowdExitPct;
    if (x !== undefined && x !== null && (!(x >= 1) || x > 100)) return { ok: false, message: 'Crowd exit must be between 1% and 100%' };
    if (c.fomoTopSort !== undefined && c.fomoTopSort !== null && !SCOUT_SORTS.includes(c.fomoTopSort)) return { ok: false, message: 'Pick a board ranking for the top wallets' };
    if (c.fomoSource === 'list') {
      const picked = cleanBlocklist(c.fomoWallets) ?? [];
      const need = typeof k === 'number' && k >= 2 ? Math.floor(k) : DEFAULT_FOMO_MIN_WALLETS;
      if (picked.length < need) return { ok: false, message: `Pick at least ${need} wallets for a crowd of ${need}` };
      if (picked.length > MAX_FOMO_WALLETS) return { ok: false, message: `At most ${MAX_FOMO_WALLETS} picked wallets` };
    }
  }
  return { ok: true, message: 'ok' };
}

/** How much we would copy for a trade of `theirSol`. */
export function copySize(c: CopyConfig, theirSol: number): number {
  const raw = c.sizing === 'fixed' ? c.sizeValue : theirSol * (c.sizeValue / 100);
  return Math.min(raw, c.maxTradeSol);
}

export function describeConfig(c: CopyConfig): string {
  const size = c.sizing === 'fixed' ? `${c.sizeValue} SOL` : `${c.sizeValue}% of their size`;
  const who = c.label || `${c.wallet.slice(0, 6)}…`;
  const x = ownExitsOf(c);
  const exits = `+${x.takeProfitPct ?? '—'}% / −${x.stopLossPct ?? '—'}% / ${x.maxHoldMin ?? '—'} min`;
  if (directionOf(c) === 'reverse') {
    return `${c.mode === 'paper' ? 'Paper-reverse' : 'REVERSE'} ${who}: buy when they sell, ${size} (max ${c.maxTradeSol}), out at ${exits} or when they buy back`;
  }
  if (directionOf(c) === 'fomo') {
    const f = fomoRuleOf(c);
    return `${c.mode === 'paper' ? 'Paper convergence' : 'Convergence'} ${c.label || FOMO_SOURCE_LABEL[f.source]}: buy when ${f.minWallets} of ${crowdNoun(c)} buy the same coin within ${f.windowSec} s, ${size} (max ${c.maxTradeSol}), out at ${exits} or when ${f.crowdExitPct}% of them have sold`;
  }
  if (directionOf(c) === 'watch') return `WATCH ${who}: alerts on every buy and sell, never trades`;
  return `${c.mode === 'paper' ? 'Paper-copy' : 'COPY'} ${who} at ${size} (max ${c.maxTradeSol})`;
}

// ── The paper cost model (2026-10-22) ─────────────────────────────────
//
// Paper charged 1 % venue fee + Krypt's fee per side and nothing else. A real
// Solana copy also pays the priority-fee floors, the base fee and the mean
// tip on EVERY transaction — about 0.0035 SOL a round trip, 7 % of a 0.05 SOL
// copy (docs/breakeven-swarm-2026-09-28.md) — and pump's curve fee is tiered
// at ~1.25 %, not 1 % (txBuilder's own note). A paper record that leaves
// those out shows a profit the identical live trades would not have made,
// and it is the record a user decides to go live on. Scripts were fixed the
// same way on 09-28; copies are now too.
//
// Copies go out on the FAST lane: the copy host calls the trade pipeline
// without a lane, which is fast (engine.testTrade). So that is the lane paper
// charges. Rows carry `paperModel` so an older record is never silently
// compared with a newer one.

export const PAPER_MODEL = 2;
/** pump.fun's curve fee per side, tiered at ~1.25 % — the venue most copies
 *  land on. PumpSwap and the routed DEXes charge less; paper does not get
 *  the benefit of the doubt. */
export const SOLANA_VENUE_SIDE_FEE = 0.0125;
/** four.meme and the Robinhood curve, per side. */
export const EVM_VENUE_SIDE_FEE = 0.01;

/** The percentage a paper fill pays per side on a chain: venue + Krypt. */
export function paperSideCost(chain: ChainKind = 'solana'): number {
  return (chain === 'solana' ? SOLANA_VENUE_SIDE_FEE : EVM_VENUE_SIDE_FEE) + FEE_BPS / 10_000;
}

/** The fixed SOL a paper fill pays per transaction. Solana only: EVM gas is
 *  not modelled, so it is not charged — an unknown is not invented. */
export function paperFixedCost(chain: ChainKind = 'solana', side: 'buy' | 'sell'): number {
  return chain === 'solana' ? paperFixedFeeSol('fast', side) : 0;
}

/**
 * What one paper exit slice made, by the model.
 *
 * `cost` is the slice's share of what the copy put in, `shareOfCopy` that
 * share as a fraction (the buy's fixed fee is spread across the slices, so a
 * copy sold in three goes pays it once), and the sell's fixed fee is charged
 * in full on every slice: each slice IS a sell transaction.
 */
export function paperExitPnl(cost: number, shareOfCopy: number, entry: number, exit: number, chain: ChainKind = 'solana'): number {
  const s = paperSideCost(chain);
  const share = Math.max(0, Math.min(1, shareOfCopy));
  return cost * ((exit / entry) * (1 - s) - (1 + s)) - paperFixedCost(chain, 'buy') * share - paperFixedCost(chain, 'sell');
}

/** Win rate, or null when nothing has closed yet. */
export function winRate(s: CopyStats): number | null {
  const closed = s.wins + s.losses;
  return closed > 0 ? (s.wins / closed) * 100 : null;
}

// ── Copy latency (2026-09-21) ─────────────────────────────────────────
//
// A tester watching a leader wallet and their copy wallet side by side timed
// ~5–6 s from the leader's transaction to theirs landing, which on a low-cap
// launch is enough for the entry to move a long way. The question they could
// not answer from outside — how much of that is hearing about the trade and
// how much is placing ours — is the one this record answers.
//
// Every field is a DURATION in milliseconds, and every one is nullable
// because a stage that did not happen or could not be timed must read as
// unknown rather than as zero (the house rule: an em dash, never a 0). A
// paper copy has no `sendMs`; a trade delivered whole by `transactionSubscribe`
// has no `readMs`; a leader transaction with no block time has no `detectMs`.

export interface CopyTiming {
  /** Which subscription delivered it. `tx` carries the transaction with the
   *  notification; `logs` carries a signature and costs a read-back;
   *  `parsed` carries a decoded transaction, read back unless it was a clean
   *  curve buy (then `readMs` is null). */
  feed?: 'logs' | 'tx' | 'parsed';
  /**
   * Their transaction's block time → the notification reaching us.
   *
   * This is the chain and the RPC, not us: it includes the wait for
   * `confirmed`, which is the commitment both subscriptions ask for. Null
   * when the transaction carried no block time.
   */
  detectMs: number | null;
  /** Reading the transaction back by signature. Null on the `tx` transport,
   *  which needs no read-back at all. */
  readMs: number | null;
  /** How many reads that took. More than 1 means the first answer was "the
   *  node does not have it yet", and each retry backs off. */
  readTries?: number;
  /** Decoding the swap out of the wallet's own balance deltas. */
  decodeMs: number | null;
  /** The filters, including the token-facts lookup — a round trip whenever
   *  the mint is not already cached, which for a fresh launch it is not. */
  checkMs: number | null;
  /**
   * The token-facts lookup ALONE, inside `checkMs`.
   *
   * Broken out because it is the one stage in the copier that can make a
   * network call on a mint nobody has seen before — which a leader's fresh
   * launch always is — and because a filter block that is otherwise pure
   * arithmetic should not be able to hide a round trip inside its total.
   */
  factsMs: number | null;
  /** The config's own `delayMs`, honoured as set. Not a cost to fix; here so
   *  it is not mistaken for one. */
  delayMs: number | null;
  /** Our order: handed over until the broadcast came back. Null in paper. */
  sendMs: number | null;
  /** Inside `sendMs`, from the signer: building the unsigned transaction. */
  buildMs?: number | null;
  /** Inside `sendMs`: first send → landed, failed or expired. */
  confirmMs?: number | null;
  /** Their block time → our order done. The number the tester was holding a
   *  stopwatch to. Null when either end is unknown. */
  totalMs: number | null;
  /**
   * Slots (2026-10-22). Block times are whole seconds, so every millisecond
   * above that starts at the leader's fill is ±1 s — and a slot is ~0.2 s.
   * The slot of their transaction and of ours is the only measurement of
   * "how far behind them did we land" that is not rounded to a second, and
   * the number every copier markets and none lets you check.
   *
   * `leaderSlot` comes with the delivery; `ourSlot` once the ledger has read
   * our buy back, so it arrives after the timing line was first logged.
   * Null = unknown; a paper copy never has an `ourSlot`.
   */
  leaderSlot?: number | null;
  ourSlot?: number | null;
  /** `ourSlot - leaderSlot`: 0 is the same block as the leader. */
  slotGap?: number | null;
  /** Waiting for the AI desk's verdict (2026-10-28). Absent = not asked. */
  aiMs?: number | null;
}

/** Everything this record can account for, which is every stage but the
 *  chain's own. Used to show what the breakdown does NOT explain. */
export function accountedMs(t: CopyTiming): number {
  return (t.readMs ?? 0) + (t.decodeMs ?? 0) + (t.checkMs ?? 0) + (t.delayMs ?? 0) + (t.sendMs ?? 0);
}

/**
 * The breakdown as one line, for the Console and the exported logs.
 *
 * Ordered as it happens, so reading left to right is walking the path, and
 * an unknown stage is left OUT rather than printed as zero — a stage that
 * did not run and a stage that took no time are not the same fact.
 */
export function describeCopyTiming(t: CopyTiming): string {
  const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);
  const parts: string[] = [];
  if (t.detectMs !== null) parts.push(`heard ${ms(t.detectMs)}`);
  if (t.readMs !== null) parts.push(`read ${ms(t.readMs)}${t.readTries && t.readTries > 1 ? ` (${t.readTries} tries)` : ''}`);
  if (t.decodeMs !== null) parts.push(`decode ${ms(t.decodeMs)}`);
  if (t.checkMs !== null) {
    // The lookup is named inside the checks, not beside them, so the parts
    // still add up to the whole when read left to right.
    const facts = t.factsMs !== null ? ` [token facts ${ms(t.factsMs)}]` : '';
    parts.push(`checks ${ms(t.checkMs)}${facts}`);
  }
  if (t.delayMs) parts.push(`your delay ${ms(t.delayMs)}`);
  if (t.aiMs != null) parts.push(`AI ${ms(t.aiMs)}`);
  if (t.sendMs !== null) {
    const inner: string[] = [];
    if (t.buildMs != null) inner.push(`build ${ms(t.buildMs)}`);
    if (t.confirmMs != null) inner.push(`land ${ms(t.confirmMs)}`);
    parts.push(`order ${ms(t.sendMs)}${inner.length ? ` [${inner.join(', ')}]` : ''}`);
  }
  if (t.slotGap != null) parts.push(`landed ${t.slotGap} slot${t.slotGap === 1 ? '' : 's'} after theirs`);
  const head = t.totalMs !== null ? `${ms(t.totalMs)} their fill → ours` : 'timing';
  return `${head}${t.feed ? ` via ${t.feed}` : ''}: ${parts.join(' · ')}`;
}

/**
 * The median of each stage over recent copies.
 *
 * A median, not a mean: one copy that waited out a parked RPC would drag an
 * average somewhere no individual copy ever was, and the question being asked
 * is "what does this usually cost", not "what is the worst case". `samples`
 * says how many rows it is built from, so a median of two is not mistaken for
 * a measurement.
 *
 * Every field is null when no sample had that stage — a run entirely on the
 * `tx` transport has no read-back to report, and reporting 0 would read as
 * "instant" rather than "did not happen".
 */
export interface CopyLatency {
  samples: number;
  detectMs: number | null;
  readMs: number | null;
  decodeMs: number | null;
  checkMs: number | null;
  factsMs: number | null;
  delayMs: number | null;
  sendMs: number | null;
  totalMs: number | null;
  /** Median slots between their transaction and our landed buy — live
   *  copies whose fill has been read only. Null until there is one. */
  slotGap: number | null;
  /** How many copies `slotGap` is the median of. */
  slotSamples: number;
  /** How the samples were delivered, so a median is read against the right
   *  transport. Both are counted; a mixed run says so. */
  feeds: { logs: number; tx: number; parsed: number };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Build the summary from whatever timed rows are to hand, newest first. */
export function copyLatency(rows: CopyTiming[]): CopyLatency {
  const of = (pick: (t: CopyTiming) => number | null | undefined): number | null =>
    median(rows.map(pick).filter((n): n is number => typeof n === 'number'));
  return {
    samples: rows.length,
    detectMs: of((t) => t.detectMs),
    readMs: of((t) => t.readMs),
    decodeMs: of((t) => t.decodeMs),
    checkMs: of((t) => t.checkMs),
    factsMs: of((t) => t.factsMs),
    delayMs: of((t) => t.delayMs),
    sendMs: of((t) => t.sendMs),
    totalMs: of((t) => t.totalMs),
    slotGap: of((t) => t.slotGap),
    slotSamples: rows.filter((t) => typeof t.slotGap === 'number').length,
    feeds: {
      logs: rows.filter((t) => t.feed === 'logs').length,
      tx: rows.filter((t) => t.feed === 'tx').length,
      parsed: rows.filter((t) => t.feed === 'parsed').length,
    },
  };
}
