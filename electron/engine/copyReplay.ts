// Copy replay (2026-10-23) — price a copy of one wallet's recent trades.
// The model and the reasons are in shared/copyReplay.ts; this is the job.
//
// Two steps, polled by the profile, cancellable:
//
//   1. their swaps — the chain read the profile's "Read from chain" already
//      runs (walletHistory.ts), reused when it just ran;
//   2. for each of their newest finished trips (REPLAY_MAX_TRIPS), the
//      market a copy would have met at each leg. FAST FIRST, then the
//      fallback (the user's rule, 2026-10-24):
//        a. the chain, through a Helius key (chainPrice.ts): a call or two
//           per trip, ~10 credits each, several trips at once — seconds for
//           the whole replay — inside the backtest allowance;
//        b. pump's swap API for every trip the chain did not price (no key,
//           no slots, the allowance or the month spent, a refused read): one
//           call per leg at one every 2 s, the Cloudflare rule on that host.
//           Free, and about two minutes for thirty trips.
//
// A trip neither source can price (not a pump coin, a hole in its history)
// stays unpriced, and a provider that stops answering is said once rather
// than read as thirty dead coins.

import * as walletHistory from './walletHistory';
import * as chainPrice from './chainPrice';
import * as heliusBudget from '../system/heliusBudget';
import { priceAt as pumpPriceAt } from '../data/providers/pumpswap';
import { cooldownRemainingMs } from '../data/http';
import { isHeliusRpc } from '../chain/rpcClient';
import { FOLLOWER_LAG_MS } from '@shared/walletScore';
import { DEFAULT_BACKTEST_CREDITS } from '@shared/credits';
import {
  REPLAY_MAX_TRIPS,
  REPLAY_WEEK_MAX_TRIPS,
  REPLAY_WEEK_MS,
  REPLAY_WEEK_READ_LIMIT,
  REPLAY_WEEK_SLOW_MAX,
  buildTrips,
  markBirth,
  replayReturn,
  sampleSeed,
  sampleTrips,
  swapChecks,
  type CopyReplayStatus,
  type ReplayChecks,
  type ReplaySample,
  type ReplaySwap,
  type ReplayTrip,
  type SwapChecks,
} from '@shared/copyReplay';
import { SNIPER_SLOTS, dayOf } from '@shared/walletScout';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ReplayDeps {
  priceAt: typeof pumpPriceAt;
  /** The wallet's swaps from a finished chain read, or null. With
   *  `sinceMs` (a week check), only a read that covers it counts. */
  swapsOf(address: string, sinceMs?: number): ReplaySwap[] | null;
  /** Start that read (or join one running) and resolve when it is done. */
  read(address: string, httpUrl: string, opts?: walletHistory.ReadOpts): Promise<{ ok: boolean; message: string }>;
  /** What the last chain read of the wallet said, when a replay reuses it
   *  and it found no swaps (2026-10-28: "never signs" was lost behind "no
   *  finished trades"). Absent = nothing to add. */
  readNote?(address: string): string;
  /** How long the swap API is parked for (a 429), ms; 0 when it is not. */
  cooldownMs?(): number;
  sleep?(ms: number): Promise<void>;
  /** The fast path: price one trip from the chain. Absent = no chain. */
  chainPrice?(httpUrl: string, mint: string, openSlot: number, closeSlot: number): Promise<chainPrice.TripPrice>;
  /** The same at several lags at once (ReplayOpts.lags). Absent = lags are
   *  not available and a replay asking for them prices the usual lag only. */
  chainPriceLags?(httpUrl: string, mint: string, openSlot: number, closeSlot: number, lags: readonly number[]): Promise<chainPrice.TripPriceLags>;
  /** Credits the backtest allowance has left (0 = the chain may not be used). */
  chainCreditsLeft?(): number;
  /** Count credits the chain spent against the allowance. */
  billBacktest?(credits: number): void;
  /** A coin's first transaction, for the sniper and launch-bundle checks
   *  (2026-10-25). Absent = the checks stop at what the swaps alone say. */
  mintBirth?(httpUrl: string, mint: string): Promise<chainPrice.BirthRead>;
}

/** How a replay is run (2026-10-25). The defaults are what Check shows: the
 *  newest trips, no chain checks. A board LABEL asks for a random sample and
 *  the checks. */
export interface ReplayOpts {
  sample?: ReplaySample;
  /** Trips to price; REPLAY_MAX_TRIPS by default. */
  max?: number;
  /** Run the wash, shared-payer, sniper and launch-bundle checks. */
  checks?: boolean;
  /** Only trips OPENED in [since, until), ms (the pre-registered test's
   *  week; 2026-10-25). Absent = every trip the read found. */
  since?: number;
  until?: number;
  /** Price each trip at these lags (slots after theirs) as well, from the
   *  chain only — a trip the chain cannot price stays unpriced rather than
   *  going to the swap API, which knows no slots. */
  lags?: readonly number[];
  /** Which trades (2026-10-28): the newest, or the whole week — see weekOpts. */
  span?: 'newest' | 'week';
  /** At most this many trips go to the slow swap API; the rest the chain
   *  could not price stay unpriced and are counted. Absent = no cap. */
  slowMax?: number;
  /** The chain read's depth for this replay. */
  read?: walletHistory.ReadOpts;
}

/**
 * The whole-week check (2026-10-28): every finished trade OPENED in the last
 * seven days, up to REPLAY_WEEK_MAX_TRIPS, newest first, read deep enough to
 * hold them. The opts are fixed here, not taken from a page, so a page can
 * ask for a week but cannot ask for more.
 */
export function weekOpts(now: number, checks = false): ReplayOpts {
  return {
    span: 'week',
    since: now - REPLAY_WEEK_MS,
    max: REPLAY_WEEK_MAX_TRIPS,
    slowMax: REPLAY_WEEK_SLOW_MAX,
    checks,
    read: { limit: REPLAY_WEEK_READ_LIMIT, days: 7 },
  };
}

/** Credits a birth read costs: one page of under a hundred. */
const BIRTH_CREDITS = 10;

/** Trips priced from the chain at once. The http layer paces the host on
 *  top; four keeps a free key's ~10 requests a second clear. */
const CHAIN_CONCURRENCY = 4;
/** Chain reads that failed in a row before the rest go to the swap API. */
const CHAIN_MAX_FAILS = 3;

/** The backtest allowance, from settings (attached by ipc). */
let allowanceOf: () => number = () => DEFAULT_BACKTEST_CREDITS;
export function attachAllowance(fn: () => number): void {
  allowanceOf = fn;
}

/**
 * Waits on a parked swap API, per leg, before that leg is left unpriced.
 * Measured 2026-10-23 with a deep (Helius) read: ~25 calls at the 2 s pace,
 * then a 429 and a 60 s park — and every leg after it came back "rate
 * limited" at once, so 17 of 30 trades went unpriced. Waiting it out costs a
 * minute and prices them.
 */
const MAX_WAITS = 3;
/** Waits across the whole replay, so a provider that stays shut ends it. */
const MAX_WAITS_TOTAL = 6;
const RATE_LIMITED = /429|rate limit/i;

/** A read older than this is read again: their newest trades are the point. */
const READ_FRESH_MS = 10 * 60_000;

const realDeps: ReplayDeps = {
  priceAt: pumpPriceAt,
  readNote: (address) => walletHistory.status(address).message,
  cooldownMs: () => cooldownRemainingMs('pumpswap'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  chainPrice: (httpUrl, mint, openSlot, closeSlot) => chainPrice.priceTrip(httpUrl, mint, openSlot, closeSlot),
  chainPriceLags: (httpUrl, mint, openSlot, closeSlot, lags) => chainPrice.priceTripLags(httpUrl, mint, openSlot, closeSlot, lags),
  chainCreditsLeft: () => heliusBudget.backtestLeft(allowanceOf()),
  billBacktest: (credits) => heliusBudget.billBacktest(credits),
  mintBirth: (httpUrl, mint) => chainPrice.mintBirth(httpUrl, mint),
  swapsOf(address, sinceMs) {
    const done = walletHistory.status(address).finishedAt;
    if (done === null || Date.now() - done >= READ_FRESH_MS) return null;
    // A week check needs a read that reaches back a week (2026-10-28).
    if (sinceMs !== undefined && !walletHistory.covers(address, sinceMs)) return null;
    return walletHistory.swapsOf(address);
  },
  async read(address, httpUrl, opts) {
    if (!walletHistory.isRunning(address)) {
      const r = walletHistory.start(address, httpUrl, Date.now(), opts);
      if (!r.ok) return r;
    }
    await walletHistory.wait(address);
    const st = walletHistory.status(address);
    return { ok: true, message: st.message };
  },
};

const jobs = new Map<string, CopyReplayStatus>();
const running = new Map<string, Promise<void>>();
const cancels = new Set<string>();

type Log = (level: 'info' | 'warn' | 'error', line: string) => void;
let log: Log = () => {};
export function attachLog(fn: Log): void {
  log = fn;
}

function fresh(address: string): CopyReplayStatus {
  return {
    address,
    running: false,
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    swaps: 0,
    tripsFound: 0,
    toPrice: 0,
    priced: 0,
    open: 0,
    calls: 0,
    viaChain: 0,
    viaPump: 0,
    credits: 0,
    fallbackWhy: '',
    cancelled: false,
    message: '',
    waitingUntil: null,
    trips: [],
  };
}

export function status(address: string): CopyReplayStatus {
  const st = jobs.get(address) ?? fresh(address);
  return { ...st, trips: st.trips.map((t) => ({ ...t })) };
}

/** Every finished trip the last replay of this wallet built (oldest first),
 *  not just the sampled ones — the board labeler's coverage figure needs the
 *  whole week. Kept in memory for the last fifty replays; null otherwise. */
const builtKept = new Map<string, ReplayTrip[]>();
export function builtTrips(address: string): ReplayTrip[] | null {
  const t = builtKept.get(address);
  return t ? t.map((x) => ({ ...x })) : null;
}

export function cancel(address: string): boolean {
  if (!running.has(address)) return false;
  cancels.add(address);
  return true;
}

export function wait(address: string): Promise<void> {
  return running.get(address) ?? Promise.resolve();
}

/** Start a replay. Returns at once; one per wallet. */
export function start(address: string, httpUrl: string, deps: ReplayDeps = realDeps, now = Date.now(), opts: ReplayOpts = {}): { ok: boolean; message: string } {
  if (!BASE58.test(address)) return { ok: false, message: 'Not a Solana wallet address' };
  if (running.has(address)) return { ok: false, message: 'Already replaying this wallet' };
  const st = fresh(address);
  st.running = true;
  st.startedAt = now;
  st.sample = opts.sample ?? 'newest';
  st.span = opts.span ?? 'newest';
  st.weekShort = null;
  st.slowSkipped = 0;
  jobs.set(address, st);
  cancels.delete(address);
  while (jobs.size > 50) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined || oldest === address) break;
    if (!running.has(oldest)) jobs.delete(oldest);
    else break;
  }
  const p = run(address, httpUrl, st, deps, opts, now).finally(() => running.delete(address));
  running.set(address, p);
  return { ok: true, message: 'started' };
}

async function run(address: string, httpUrl: string, st: CopyReplayStatus, deps: ReplayDeps, opts: ReplayOpts, now: number): Promise<void> {
  let sw: SwapChecks | null = null;
  try {
    st.phase = 'reading';
    const week = opts.span === 'week';
    let swaps = week ? deps.swapsOf(address, opts.since) : deps.swapsOf(address);
    if (!swaps) {
      if (!httpUrl) {
        st.message = 'No Solana RPC endpoint is configured';
        return;
      }
      const r = await deps.read(address, httpUrl, opts.read);
      if (!r.ok) {
        st.message = r.message;
        return;
      }
      swaps = deps.swapsOf(address);
      // A week check on a read that still does not cover the week (rate
      // limits, the standard read's 200-transaction listing): it goes on
      // with what was read, and says so instead of calling it the week.
      if (week && swaps?.length && opts.since !== undefined && deps.swapsOf(address, opts.since) === null) {
        const oldest = Math.min(...swaps.map((s) => s.at));
        const hours = Math.max(0, (now - oldest) / 3_600_000);
        const back = hours < 48 ? `${Math.max(1, Math.round(hours))} hour${Math.round(hours) === 1 ? '' : 's'}` : `${Math.round(hours / 24)} days`;
        const why = deps.readNote?.(address);
        st.weekShort = `Not the whole week: the chain read reached back ${back} only${why ? ` (${why.replace(/[.]$/, '')})` : ''}. These figures are for that part of the week.`;
      }
      if (!swaps?.length) {
        st.message = r.message || 'No swaps found in their recent transactions.';
        return;
      }
    }
    st.swaps = swaps.length;
    // What the swaps alone say — wash trades, shared payers — costs nothing.
    if (opts.checks) sw = swapChecks(swaps, address);
    const built = buildTrips(swaps);
    builtKept.set(address, built.trips);
    while (builtKept.size > 50) {
      const oldest = builtKept.keys().next().value;
      if (oldest === undefined || oldest === address) break;
      builtKept.delete(oldest);
    }
    st.open = built.open;
    // A window, when asked for: the trips opened inside it and no other.
    const windowed = opts.since !== undefined || opts.until !== undefined ? built.trips.filter((t) => t.openedAt >= (opts.since ?? -Infinity) && t.openedAt < (opts.until ?? Infinity)) : built.trips;
    st.tripsFound = windowed.length;
    if (!windowed.length) {
      st.message =
        built.trips.length && windowed.length === 0 && (opts.since !== undefined || opts.until !== undefined)
          ? 'No finished trades opened in the window.'
          : built.open
            ? `No finished trades yet — ${built.open} position${built.open === 1 ? ' is' : 's are'} still open.`
            : swaps.length === 0
              ? deps.readNote?.(address) || 'No swaps found in their recent transactions.'
              : 'No finished trades in their recent swaps.';
      if (sw) st.checks = { ...sw, sniperTrips: 0, bundleTrips: 0, mintsChecked: 0, credits: 0 };
      return;
    }
    // Newest first, the ones a follower starting now cares about — or, for a
    // board label, a random sample of them (unbiased; the same for the same
    // wallet on the same day).
    const trips = sampleTrips(windowed, opts.max ?? REPLAY_MAX_TRIPS, opts.sample ?? 'newest', sampleSeed(`${address}:${dayOf(now)}`));
    st.toPrice = trips.length;
    st.trips = trips;
    st.phase = 'pricing';
    let providerTrouble = '';
    let waits = 0;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // One leg's price; a rate-limited answer is waited out (the park, or 5 s
    // when the provider gave none) and asked again, within MAX_WAITS.
    const price = async (mint: string, at: number): ReturnType<ReplayDeps['priceAt']> => {
      for (let attempt = 0; ; attempt++) {
        const r = await deps.priceAt(mint, at);
        st.calls += 1;
        if (r.price !== null || !r.failed || !RATE_LIMITED.test(r.message) || attempt >= MAX_WAITS || waits >= MAX_WAITS_TOTAL) return r;
        waits += 1;
        const ms = Math.min(90_000, Math.max(5_000, deps.cooldownMs?.() ?? 0));
        st.waitingUntil = Date.now() + ms;
        for (let left = ms; left > 0 && !cancels.has(address); left -= 1_000) await sleep(Math.min(1_000, left));
        st.waitingUntil = null;
        if (cancels.has(address)) return r;
      }
    };
    // a. The chain first, several trips at once, inside the allowance.
    const chainDone = await priceFromChain(address, httpUrl, st, trips, deps, opts.lags);
    let slowTried = 0;
    for (const t of trips) {
      if (cancels.has(address)) {
        st.cancelled = true;
        break;
      }
      // b. The swap API for what the chain did not price. A trip the chain
      // already counted is not priced twice — and a replay priced at several
      // lags takes no swap-API fill, which knows no slots and would put one
      // leg on a different footing from the rest.
      if (chainDone.has(t) || opts.lags?.length) continue;
      // A week check caps the slow path (2026-10-28): past the cap a trip
      // stays unpriced and is counted, rather than holding the check for
      // half an hour at the swap API's 2 s pace.
      if (t.note !== 'too-fast' && opts.slowMax !== undefined && slowTried >= opts.slowMax) {
        st.slowSkipped = (st.slowSkipped ?? 0) + 1;
        st.priced += 1;
        continue;
      }
      if (t.note !== 'too-fast') slowTried += 1;
      if (t.note !== 'too-fast') {
        const entry = await price(t.mint, t.openedAt + FOLLOWER_LAG_MS);
        if (entry.price === null) {
          if (entry.failed && !providerTrouble) providerTrouble = entry.message;
        } else {
          const exit = await price(t.mint, t.closedAt + FOLLOWER_LAG_MS);
          if (exit.price === null) {
            if (exit.failed && !providerTrouble) providerTrouble = exit.message;
          } else {
            t.entryPx = entry.price;
            t.exitPx = exit.price;
            t.returnPct = replayReturn(entry.price, exit.price);
            if (t.returnPct !== null) {
              t.note = 'filled';
              t.source = 'pump';
              st.viaPump = (st.viaPump ?? 0) + 1;
            }
          }
        }
      }
      st.priced += 1;
    }
    if (providerTrouble) st.message = `pump.fun's trade history did not answer for some coins (${providerTrouble}) — those trades are left unpriced.`;
    if (st.slowSkipped) {
      const more = `${st.slowSkipped} trade${st.slowSkipped === 1 ? '' : 's'} the chain could not price ${st.slowSkipped === 1 ? 'was' : 'were'} left unpriced — the slow fallback stops at ${opts.slowMax} in a week check (${st.fallbackWhy || 'chain pricing stopped'}).`;
      st.message = st.message ? `${st.message} ${more}` : more;
    }
    if (week && windowed.length > trips.length) {
      const cut = `${windowed.length - trips.length} older trade${windowed.length - trips.length === 1 ? '' : 's'} of the week left out — a week check prices the newest ${trips.length}.`;
      st.message = st.message ? `${st.message} ${cut}` : cut;
    }
    // c. The checks, after the pricing, so a spent allowance costs prices
    // nothing: each coin's birth once, for every sampled trip on it.
    if (sw) await runChecks(address, httpUrl, st, trips, deps, sw);
  } catch (e) {
    st.message = st.message || `Replay stopped — ${(e as Error).message ?? String(e)}`.slice(0, 200);
  } finally {
    st.running = false;
    st.phase = 'done';
    st.finishedAt = Date.now();
    cancels.delete(address);
    const filled = st.trips.filter((t) => t.note === 'filled').length;
    const c = st.checks;
    log(
      st.message ? 'warn' : 'info',
      `copy replay ${address.slice(0, 6)}…: ${st.cancelled ? 'cancelled' : 'done'} — ${st.span === 'week' ? 'whole week, ' : ''}${st.swaps} swap(s), ${st.tripsFound} trip(s), ${filled}/${st.toPrice} priced (${st.sample ?? 'newest'}; ${st.viaChain ?? 0} from the chain, ${st.credits ?? 0} credits; ${st.viaPump ?? 0} from pump's history), ${st.calls} call(s)${st.fallbackWhy ? ` · slower path because ${st.fallbackWhy}` : ''}${
        c ? ` · checks: ${c.washTrips} wash, ${c.sharedPayers} other payer(s), ${c.sniperTrips} snipe(s) and ${c.bundleTrips} bundle buy(s) over ${c.mintsChecked} checked` : ''
      }${st.message ? ` · ${st.message}` : ''}`,
    );
  }
}

/**
 * The sniper and launch-bundle checks (2026-10-25): every sampled trip's
 * coin is read for its birth — once per coin, cached for good — and the trip
 * marked against it. Inside the allowance like the pricing; a read that is
 * refused or keeps failing ends the checks, and what was checked stands.
 */
async function runChecks(address: string, httpUrl: string, st: CopyReplayStatus, trips: ReplayTrip[], deps: ReplayDeps, sw: SwapChecks): Promise<void> {
  const checks: ReplayChecks = { ...sw, sniperTrips: 0, bundleTrips: 0, mintsChecked: 0, credits: 0 };
  st.checks = checks;
  if (!deps.mintBirth || !isHeliusRpc(httpUrl)) return;
  const byMint = new Map<string, ReplayTrip[]>();
  for (const t of trips) if (typeof t.openSlot === 'number') byMint.set(t.mint, [...(byMint.get(t.mint) ?? []), t]);
  const mints = [...byMint.keys()];
  let next = 0;
  let fails = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (next < mints.length && !stopped && !cancels.has(address)) {
      const mint = mints[next++];
      if ((deps.chainCreditsLeft?.() ?? 0) < BIRTH_CREDITS * CHAIN_CONCURRENCY) {
        stopped = true;
        break;
      }
      const r = await deps.mintBirth!(httpUrl, mint);
      st.calls += r.calls;
      if (r.credits > 0) {
        checks.credits += r.credits;
        st.credits = (st.credits ?? 0) + r.credits;
        deps.billBacktest?.(r.credits);
      }
      if (!r.ok) {
        fails += 1;
        if (r.refused || fails >= CHAIN_MAX_FAILS) stopped = true;
        continue;
      }
      fails = 0;
      if (!r.birth) continue;
      for (const t of byMint.get(mint) ?? []) {
        markBirth(t, r.birth, address);
        checks.mintsChecked += 1;
        if (typeof t.sinceBirth === 'number' && t.sinceBirth <= SNIPER_SLOTS) checks.sniperTrips += 1;
        if (t.bundle) checks.bundleTrips += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHAIN_CONCURRENCY, mints.length) }, worker));
}

/**
 * The fast path: every trip with both slots, priced from the chain a few at
 * a time. Returns the trips it settled — priced, or read and found to have no
 * trade to price — so the swap API is not asked about them again. Stops
 * asking (and says why) when the allowance cannot cover another trip, or the
 * reads keep failing; whatever is left goes to the swap API.
 */
async function priceFromChain(address: string, httpUrl: string, st: CopyReplayStatus, trips: ReplayTrip[], deps: ReplayDeps, lags?: readonly number[]): Promise<Set<ReplayTrip>> {
  const settled = new Set<ReplayTrip>();
  const todo = trips.filter((t) => t.note !== 'too-fast');
  if (!todo.length) return settled;
  if (!deps.chainPrice || !isHeliusRpc(httpUrl)) {
    st.fallbackWhy = 'there is no Helius key — add one in Settings to price a replay in seconds';
    return settled;
  }
  const ready = todo.filter((t) => typeof t.openSlot === 'number' && typeof t.closeSlot === 'number');
  if (ready.length < todo.length) st.fallbackWhy = `${todo.length - ready.length} trip(s) came without slots`;
  // Several lags: every lag's legs from one read, the usual lag's as the
  // trip's own figure. Reserve for the back pages the extra legs may need.
  const multi = lags?.length && deps.chainPriceLags ? [...new Set([...lags, chainPrice.LAG_SLOTS])] : null;
  const perTrip = chainPrice.MAX_CREDITS_PER_TRIP * (multi ? Math.ceil((multi.length + 1) / 2) : 1);
  let fails = 0;
  let stopped = '';
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ready.length && !stopped && !cancels.has(address)) {
      const t = ready[next++];
      // Reserve the most a trip can cost before asking, so the allowance is
      // never overrun by the trips in flight.
      const left = deps.chainCreditsLeft?.() ?? 0;
      if (left < perTrip * CHAIN_CONCURRENCY) {
        stopped =
          allowanceOf() <= 0
            ? 'chain pricing is turned off (backtest allowance 0 in Settings)'
            : left > 0
              ? 'the backtest allowance is nearly spent'
              : 'the backtest allowance (or the month’s Helius credits) is spent';
        break;
      }
      let r: chainPrice.TripPrice;
      if (multi) {
        const m = await deps.chainPriceLags!(httpUrl, t.mint, t.openSlot as number, t.closeSlot as number, multi);
        const usual = m.at[chainPrice.LAG_SLOTS] ?? { entry: null, exit: null };
        r = { ok: m.ok, entry: usual.entry, exit: usual.exit, calls: m.calls, credits: m.credits, cached: m.cached, message: m.message, ...(m.refused ? { refused: true } : {}) };
        if (m.ok) {
          const atLag: Record<string, number | null> = {};
          for (const lag of multi) {
            const leg = m.at[lag];
            atLag[String(lag)] = leg && leg.entry !== null && leg.exit !== null ? replayReturn(leg.entry, leg.exit) : null;
          }
          t.atLag = atLag;
        }
      } else r = await deps.chainPrice!(httpUrl, t.mint, t.openSlot as number, t.closeSlot as number);
      st.calls += r.calls;
      if (r.credits > 0) {
        st.credits = (st.credits ?? 0) + r.credits;
        deps.billBacktest?.(r.credits);
      }
      if (!r.ok) {
        fails += 1;
        if (r.refused || fails >= CHAIN_MAX_FAILS) stopped = `the chain read failed (${r.message})`;
        continue;
      }
      fails = 0;
      if (r.entry !== null && r.exit !== null) {
        t.entryPx = r.entry;
        t.exitPx = r.exit;
        t.returnPct = replayReturn(r.entry, r.exit);
        if (t.returnPct !== null) {
          t.note = 'filled';
          t.source = 'chain';
          st.viaChain = (st.viaChain ?? 0) + 1;
          settled.add(t);
          st.priced += 1;
        }
      }
      // A read that found no trade to price (not a pump coin) is left to the
      // swap API, which may know it.
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHAIN_CONCURRENCY, ready.length) }, worker));
  if (stopped) st.fallbackWhy = stopped;
  return settled;
}

/** Test seam. */
export function _reset(): void {
  jobs.clear();
  running.clear();
  builtKept.clear();
  cancels.clear();
}
