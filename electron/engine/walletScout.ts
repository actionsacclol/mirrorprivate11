// Wallet Scout — the book behind the leaderboard.
//
// One book per chain, never merged. Every trade the app already decodes names
// its trader (pump's `user`, Pons's `recipient`, four.meme's `account`), so
// this is aggregation of data already flowing past rather than new polling: it
// costs no RPC calls at all.
//
// ─── Bounds, because this is the whole chain ─────────────────────────────
//
// pump alone does tens of thousands of launches a day and far more trades, and
// most of the addresses in that flow buy once and are never seen again. Keeping
// a position book for every one of them would be unbounded memory for no
// benefit, so:
//
//   · a wallet is only PROMOTED to a tracked book once it has been seen
//     `PROMOTE_AFTER` times — one-trade addresses cost a counter, not a book;
//   · tracked wallets live in two tiers, each capped on its own: ranked
//     records and thinner candidates (see SCOUT_MAX_TRACKED). A candidate is
//     evicted least-recently-touched first and can never push out a ranked
//     wallet — with the live feed on, one shared cap filled within the hour;
//   · open positions per wallet are capped, and daily buckets roll off at
//     `SCOUT_RETENTION_DAYS`.
//
// ─── What it records ─────────────────────────────────────────────────────
//
// Cost basis per wallet per mint, and a closed round trip when a position goes
// flat — the same construction copyTrade uses for a followed wallet, which is
// the one already trusted with real money. Realised PnL is proceeds minus the
// cost of what was sold. Unrealised is NOT claimed anywhere: pricing every open
// position of every tracked wallet would be a guess at scale, and an honest
// gap beats a confident number.

import fs from 'node:fs';
import path from 'node:path';
import { COPY_LATENCY_FLOOR_MS } from '@shared/copytrade';
import { FOLLOWER_FILL_STALE_MS, FOLLOWER_LAG_MS, SCORE_MIN_F_TRIPS, estimatePrior, followerNetReturnPct, styleBucket, type ShrinkPrior } from '@shared/walletScore';
import {
  MARK_HORIZONS_S,
  MIN_TRIPS_FOR_RANK,
  SCOUT_CHAINS,
  SCOUT_MAX_CANDIDATES,
  SCOUT_MAX_TRACKED,
  SCOUT_PICKS_N,
  SCOUT_PICK_KEEP_DAYS,
  SCOUT_RANK_SORT,
  SCOUT_RETENTION_DAYS,
  dayOf,
  priorWalletOf,
  rankScout,
  rotate,
  shortlist,
  snapshotRow,
  snapshotVariants,
  summarise,
  walletKey8,
  weekOf,
  type BaselineEntry,
  type ChainLabel,
  type NeverSigns,
  type MarkEntry,
  type ScoreSnapshot,
  type ScoutChain,
  type ScoutDay,
  type ScoutPick,
  type ScoutWallet,
  type ScoutTrip,
} from '@shared/walletScout';

const FILE = 'wallet-scout.json';
/** The trade ids already recorded, saved beside the book — see MAX_SEEN_TX. */
const SEEN_FILE = 'wallet-scout-seen.bin';

/** Seen this many times before we start keeping a position book. */
const PROMOTE_AFTER = 3;
/** Ranked wallets per chain — see `SCOUT_MAX_TRACKED` for the tiers. */
const MAX_TRACKED = SCOUT_MAX_TRACKED;
/** Candidate (thinner) wallets per chain, a tier of their own. */
const MAX_CANDIDATES = SCOUT_MAX_CANDIDATES;
/** Candidates written to disk, most recently touched first, and only those
 *  with a closed trip: the rest is cheap to see again and costly to rewrite
 *  every thirty seconds. */
const MAX_CANDIDATES_SAVED = 5_000;
/**
 * Sightings kept for un-promoted addresses, per chain. Past it the OLDER HALF
 * goes, not all of it: clearing the whole map every 60k (the old rule) reset
 * the count of every address one or two trades from promotion — measured on
 * the 09-16 tape as about 20% of the wallets that would have ranked.
 */
const MAX_SIGHTINGS = 200_000;
/** Open positions kept per wallet. */
const MAX_OPEN = 60;
/** Hold times kept per wallet, for the median. */
const MAX_HOLDS = 200;
/** Hold times written to disk per wallet. */
const SAVED_HOLDS = 50;
/**
 * Trade ids remembered per chain, so the same trade cannot be recorded twice.
 *
 * Two feeds can carry one trade: the live decoder while the collector runs,
 * and a manual scan replaying the same hours from a historical source. Without
 * this a scan over the last hour would double every round trip the feed
 * already scored. Insertion-ordered, oldest dropped first.
 *
 * Kept as 53-bit hashes of the id, not the id strings (2026-10-22): pump's
 * curve alone runs ~100k–240k trades an hour, so the old 40k strings held
 * 10–20 minutes, not the hour this comment used to claim. 500k numbers hold
 * a few hours in a few MB, and are saved on quit (SEEN_FILE) so a scan after
 * a restart does not score the same hour twice. A collision drops one trade
 * in roughly 10^10 — far below any other error on this page.
 */
const MAX_SEEN_TX = 500_000;
/** Recent closed trips kept per wallet, for the detail drawer. */
const MAX_RECENT_TRIPS = 12;
/** The trade-rate window, and the most trade times held per wallet for it —
 *  past BOT_TRADES_PER_MIN, a higher count says nothing more. */
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_TIMES = 120;
/** Distinct mints remembered by name per wallet; past this the count is a
 *  floor. Sixty is far past where "coins per trip" stops moving. */
const MAX_MINTS = 60;
/** Follower returns stored per day bucket; counts keep going past it. */
const MAX_RETURNS_PER_DAY = 40;
/** Follower fills waiting for a print, all mints together. */
const MAX_PENDING = 30_000;
/** Stale pendings are swept this often (in notes). */
const SWEEP_EVERY = 1_000;
/** Mints remembered as "a tracked wallet opened here", so the PumpSwap feed
 *  can tell which graduated coins the book still needs prints on; and the
 *  mayhem-mode mints the feed saw created. The older half goes past these. */
const MAX_OPEN_MINTS = 100_000;
const MAX_MAYHEM_MINTS = 100_000;
/** Creates remembered for addresses not yet promoted (folded into the book
 *  when they are). */
const MAX_PENDING_CREATES = 50_000;
/** Copies of the board's picks kept per pick. */
const MAX_PICK_RETURNS = 500;
/** Every priced copy, sampled per day for the board's comparison: a
 *  reservoir of this many per day of the trip's opening. */
const BASELINE_PER_DAY = 500;
/** Marks after a ranked wallet's copy filled (shared MarkEntry), sampled
 *  per day the same way (2026-10-25, P1). */
const MARKS_PER_DAY = 500;
/** Weekly ranking snapshots kept, for the rank correlation and the
 *  overfitting probability. */
const SNAPSHOT_WEEKS = 10;
/** The week's prior is re-measured from the universe this often. */
const PRIOR_FRESH_MS = 10 * 60_000;

/** What `note` did with a trade — a scan reports these back to the user. */
export type NoteResult = 'noted' | 'duplicate' | 'own' | 'ignored';

interface Pos {
  /** Native still committed to this mint. */
  cost: number;
  tokens: number;
  openedAt: number;
  /** Everything ever put in, and realised so far, for the trip record. */
  spent: number;
  realised: number;
  /**
   * The follower's side (2026-09-20, shared/walletScore.ts). A copy of this
   * wallet fills at the FIRST PRINT on the mint at or after `followerDue` —
   * the leader's buy plus the lag — never at the leader's own price, which
   * a follower cannot have. Null until such a print arrives; if the leader is
   * out before one does, the trip was unreachable.
   */
  followerEntry: number | null;
  followerDue: number;
  closed: boolean;
  /** Opened from a history read — no follower entry was ever looked for. */
  unpriced: boolean;
}

interface Book {
  address: string;
  firstSeen: number;
  lastSeen: number;
  days: Map<number, ScoutDay>;
  positions: Map<string, Pos>;
  holds: number[];
  /** SOL put into each position's FIRST buy, newest last (the "Large size"
   *  warning); capped like holds. */
  firstBuys: number[];
  /** Distinct mints traded, by name up to MAX_MINTS… */
  mints: Set<string>;
  /** …plus how many a saved record knew but could not name. */
  mintsFloor: number;
  /** Newest first. */
  recentTrips: ScoutTrip[];
  /** Trade times, oldest first, for the trade-rate bot rule. Not saved: the
   *  day's peak is. */
  rateAt: number[];
  /** The chain's word on this wallet from its last label (2026-10-25). */
  chainLabel?: ChainLabel | null;
  /** A chain read found it never signs its swaps (2026-10-28). */
  neverSigns?: NeverSigns | null;
}

/** A follower fill waiting for the next print on its mint — or, once a
 *  ranked wallet's entry has filled, a MARK of where the coin stands
 *  `horizonSec` after it (2026-10-25, P1): the betting world's closing-line
 *  value, which shows crowding in hundreds of fills instead of tens of weeks. */
type Pending =
  | { kind: 'entry'; pos: Pos; key: string }
  | { kind: 'exit'; due: number; entry: number; trip: ScoutTrip; bucket: ScoutDay; key: string }
  | { kind: 'mark'; due: number; entry: number; openedAt: number; key: string; horizonSec: number };

interface ChainState {
  tracked: Map<string, Book>;
  /** Address → times seen, for everything not yet promoted. */
  sightings: Map<string, number>;
  /**
   * Wallets the user saved.
   *
   * Saved is not followed: it is a bookmark, kept so a wallet worth a second
   * look survives eviction and a restart. It lives here rather than in
   * localStorage because it is the user's own data and belongs with their
   * profile, next to the records it points at.
   *
   * Lower-cased key → the address as it was saved. Solana addresses are
   * case-sensitive base58, so the key is only for lookup; the value is what
   * is handed back (2026-10-22 — this was a Set of lower-cased strings, and a
   * lower-cased Solana address is a different wallet).
   */
  saved: Map<string, string>;
  /** Hashes of the trade ids already recorded — see MAX_SEEN_TX. */
  seenTx: Set<number>;
  /**
   * The candidate tier: lower-cased keys of tracked wallets below the rank
   * floor, in least-recently-touched order (a touch moves a key to the end).
   * Everything in `tracked` and not in here is ranked.
   */
  thin: Set<string>;
  /** Follower fills waiting for a print, by mint. Every trade on a mint —
   *  anyone's — is a print for it. */
  pending: Map<string, Pending[]>;
  pendingCount: number;
  notes: number;
  /**
   * The days (dayOf) on which this book saw market trades — the live feed or
   * a scan, never a one-wallet history read. How long the market has been
   * WATCHED: a record that started this morning cannot say whether a wallet
   * "trades most days", and must not hide it for failing to (2026-10-22).
   */
  observedDays: Set<number>;
  /** The local day `observedDays` last took, and its bounds — dayOf() builds
   *  a Date, and this runs on every trade of the feed. */
  dayCache: { day: number; from: number; to: number } | null;
  /**
   * Per mint, the price the LAST print left the market at: the curve's
   * post-trade price when the rail knows it (pump), else that trade's
   * average. What a follower's order meets when it lands (see resolvePending).
   * In memory only; bounded by MAX_LAST_PX.
   */
  lastPx: Map<string, number>;
  /** Mint → when a tracked wallet last opened a position on it (see
   *  MAX_OPEN_MINTS). Over-inclusive on purpose: a closed one costs a few
   *  extra notes, a missing one leaves a graduated trip open forever. */
  openMints: Map<string, number>;
  /** Mayhem-mode mints, from the create events the feed saw. */
  mayhemMints: Set<string>;
  /** Creates by addresses not promoted yet: key → when. */
  pendingCreates: Map<string, number[]>;
  /** The board's picks (shared/walletScout.ts, "The board's own record"),
   *  by lower-cased address. */
  picks: Map<string, ScoutPick>;
  /** Every priced copy, sampled: day of opening → [openedAt, return %]. */
  baseline: Map<number, { seen: number; rs: Array<[number, number] | [number, number, string]> }>;
  /** The shadow selections (ScoutPick.arm), by `${arm}:${lower-cased
   *  address}`, tracked like picks and never suggested (2026-10-25, P1). */
  shadow: Map<string, ScoutPick>;
  /** The ranking as it stood at each week's first refresh, by week. */
  snapshots: Map<number, ScoreSnapshot>;
  /** Marks after ranked wallets' fills, sampled per day of the opening. */
  marks: Map<number, { seen: number; rs: MarkEntry[] }>;
  /** The prior last measured from this chain's universe (shrinkPrior). */
  prior: ShrinkPrior | null;
}

const freshState = (): ChainState => ({
  tracked: new Map(),
  sightings: new Map(),
  saved: new Map(),
  seenTx: new Set(),
  thin: new Set(),
  pending: new Map(),
  pendingCount: 0,
  notes: 0,
  observedDays: new Set(),
  dayCache: null,
  lastPx: new Map(),
  openMints: new Map(),
  mayhemMints: new Set(),
  pendingCreates: new Map(),
  picks: new Map(),
  baseline: new Map(),
  shadow: new Map(),
  snapshots: new Map(),
  marks: new Map(),
  prior: null,
});

/** Drop the older half of an insertion-ordered map or set. */
function dropOlderHalf(m: Map<string, unknown> | Set<string>): void {
  let n = Math.floor(m.size / 2);
  for (const k of m.keys()) {
    if (n-- <= 0) break;
    m.delete(k);
  }
}
/** Mints whose last print is remembered; the older half goes past this. */
const MAX_LAST_PX = 100_000;

function observe(s: ChainState, at: number): void {
  const c = s.dayCache;
  if (c && at >= c.from && at < c.to) return;
  const day = dayOf(at);
  const from = new Date(at);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  s.dayCache = { day, from: from.getTime(), to: to.getTime() };
  s.observedDays.add(day);
}

/** Days the market was watched on a chain, for the board's window maths. */
export function observedDays(chain: ScoutChain): number[] {
  return [...chainState(chain).observedDays].sort((a, b) => a - b);
}

/** A 53-bit hash of a trade id: two 32-bit FNV-style passes, joined. */
export function txHash(tx: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x5bd1e995;
  for (let i = 0; i < tx.length; i++) {
    const c = tx.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff);
}

const state = new Map<ScoutChain, ChainState>();
for (const c of SCOUT_CHAINS) state.set(c, freshState());

/**
 * The user's own addresses, per chain.
 *
 * The Scout exists to find someone ELSE worth following. Your own wallets in a
 * "top traders" list are noise at best — and anything this install trades on
 * them (a script, a copy config, your own clicks) produces exactly the round
 * trips this page ranks on. Recording them would mean presenting our own
 * activity back to the user as a measurement.
 *
 * Injected rather than imported so this module keeps no dependency on the
 * wallet stores, and refreshed whenever wallets change.
 */
const ownAddresses = new Map<ScoutChain, Set<string>>();

let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Set when the store existed but could not be read; persisting stays off. */
let loadFailure: string | null = null;

export function failure(): string | null {
  return loadFailure;
}

/**
 * Tell the Scout which addresses belong to the user.
 *
 * Also PURGES anything already recorded for them: a build that started
 * recording before this existed has the user's own wallets in its history, and
 * leaving them in would keep them on the leaderboard forever.
 */
export function setOwnAddresses(chain: ScoutChain, addresses: readonly string[]): void {
  const set = new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean));
  ownAddresses.set(chain, set);
  const st = chainState(chain);
  let purged = 0;
  for (const a of set) {
    if (st.tracked.delete(a)) purged += 1;
    st.thin.delete(a);
    st.sightings.delete(a);
    st.saved.delete(a);
  }
  if (purged > 0) persist();
}

export function isOwn(chain: ScoutChain, address: string): boolean {
  return ownAddresses.get(chain)?.has(address.toLowerCase()) ?? false;
}

function chainState(chain: ScoutChain): ChainState {
  let s = state.get(chain);
  if (!s) {
    s = freshState();
    state.set(chain, s);
  }
  return s;
}

/** Closed round trips across every day a book still holds. */
function totalTrips(b: Book): number {
  let n = 0;
  for (const d of b.days.values()) n += d.roundTrips;
  return n;
}

function emptyDay(day: number): ScoutDay {
  return { day, buys: 0, sells: 0, roundTrips: 0, wins: 0, losses: 0, pnl: 0, volume: 0, fTrips: 0, fWins: 0, fReturns: [], unreachable: 0, fast: 0, measured: 0 };
}

// ── The follower's fills ──────────────────────────────────────────────

function addPending(s: ChainState, mint: string, p: Pending): void {
  let list = s.pending.get(mint);
  if (!list) {
    list = [];
    s.pending.set(mint, list);
  }
  list.push(p);
  s.pendingCount += 1;
  // Bounded: the oldest mints' waiting fills go first. A dropped entry leaves
  // its position with no follower price, which the close then reports as
  // unreachable — the honest reading of "we lost track of it".
  while (s.pendingCount > MAX_PENDING) {
    const oldest = s.pending.keys().next().value;
    if (oldest === undefined) break;
    const gone = s.pending.get(oldest) ?? [];
    s.pending.delete(oldest);
    s.pendingCount -= gone.length;
  }
}

function settleExit(s: ChainState, pd: Extract<Pending, { kind: 'exit' }>, ret: number): void {
  pd.trip.followerReturnPct = ret;
  pd.trip.followerNote = 'filled';
  pd.bucket.fTrips = (pd.bucket.fTrips ?? 0) + 1;
  if (ret > 0) pd.bucket.fWins = (pd.bucket.fWins ?? 0) + 1;
  const rs = (pd.bucket.fReturns ??= []);
  if (rs.length < MAX_RETURNS_PER_DAY) rs.push(ret);
  // The board's own record: a copy of a trip a pick OPENED after it was
  // picked is out of sample, and every priced copy is the comparison. The
  // shadow selections keep the same record, by the same rule.
  creditPick(s.picks.get(pd.key), pd.trip.openedAt, ret);
  creditPick(s.shadow.get(`lead:${pd.key}`), pd.trip.openedAt, ret);
  creditPick(s.shadow.get(`next:${pd.key}`), pd.trip.openedAt, ret);
  noteBaseline(s, pd.trip.openedAt, ret, pd.key);
}

function creditPick(pick: ScoutPick | undefined, openedAt: number, ret: number): void {
  if (!pick || openedAt < pick.pickedAt || pick.returns.length >= MAX_PICK_RETURNS) return;
  pick.returns.push(ret);
  // When it was opened, so the record can be read by week (2026-10-25).
  (pick.at ??= []).push(openedAt);
}

/**
 * A ranked wallet's copy just filled at `entry`: ask where the coin stands
 * MARK_HORIZONS_S after the fill. Only ranked wallets — a candidate's marks
 * would be most of the book's pendings for a figure nobody reads.
 */
function queueMarks(s: ChainState, into: Pending[], pd: Extract<Pending, { kind: 'entry' }>, entry: number): void {
  if (s.thin.has(pd.key) || !(entry > 0)) return;
  for (const h of MARK_HORIZONS_S) into.push({ kind: 'mark', due: pd.pos.followerDue + h * 1000, entry, openedAt: pd.pos.openedAt, key: pd.key, horizonSec: h });
}

/** One mark into the day's reservoir sample, like noteBaseline. */
function noteMark(s: ChainState, pd: Extract<Pending, { kind: 'mark' }>, price: number): void {
  if (!(price > 0) || !(pd.entry > 0)) return;
  const pct = Math.round((price / pd.entry - 1) * 10_000) / 100;
  const day = Math.floor(pd.openedAt / 86_400_000);
  let b = s.marks.get(day);
  if (!b) {
    b = { seen: 0, rs: [] };
    s.marks.set(day, b);
    const oldest = day - SCOUT_PICK_KEEP_DAYS - 1;
    for (const d of s.marks.keys()) if (d < oldest) s.marks.delete(d);
  }
  b.seen += 1;
  const e: MarkEntry = [pd.openedAt, pd.horizonSec, pct, walletKey8(pd.key)];
  if (b.rs.length < MARKS_PER_DAY) b.rs.push(e);
  else {
    const j = Math.floor(Math.random() * b.seen);
    if (j < MARKS_PER_DAY) b.rs[j] = e;
  }
}

/** One priced copy into the day's reservoir sample (Algorithm R): every
 *  copy of the day equally likely to be kept, in a bounded list. The wallet
 *  rides along as a short key (2026-10-25), so a week can be judged against
 *  random draws of N wallets. */
function noteBaseline(s: ChainState, openedAt: number, ret: number, walletKey: string): void {
  const day = Math.floor(openedAt / 86_400_000);
  let b = s.baseline.get(day);
  if (!b) {
    b = { seen: 0, rs: [] };
    s.baseline.set(day, b);
    const oldest = day - SCOUT_PICK_KEEP_DAYS - 1;
    for (const d of s.baseline.keys()) if (d < oldest) s.baseline.delete(d);
  }
  b.seen += 1;
  if (b.rs.length < BASELINE_PER_DAY) b.rs.push([openedAt, ret, walletKey.slice(0, 8)]);
  else {
    const j = Math.floor(Math.random() * b.seen);
    if (j < BASELINE_PER_DAY) b.rs[j] = [openedAt, ret];
  }
}

function markUnreachableExit(pd: Extract<Pending, { kind: 'exit' }>): void {
  pd.trip.followerNote = 'no-exit';
  pd.bucket.unreachable = (pd.bucket.unreachable ?? 0) + 1;
}

/**
 * A print on `mint` at `at`, which left the market at `mark`.
 *
 * A follower's leg fills against the market AS IT STOOD at its due time
 * (2026-10-23): the price the last print before the due time left behind.
 * A bonding curve or a pool always quotes, so a copy needs nobody else to
 * trade after it. The rule before — fill at the first print AT OR AFTER the
 * due time, at that trade's own price — skipped the leader's impact in quiet
 * coins (both legs at one later print), made slower copies look better, and
 * left a coin that stopped printing "unreachable", so riding coins to zero
 * scored well (held-out tape replay, swarm 2026-10-23: ranking on this model
 * beat today's ranking by 1.3–3.2 points on all three day-pairs).
 *
 * So a print at or after a due time fills that leg at the PREVIOUS mark, and
 * only then becomes the mark itself. Still unreachable: a leader fully out
 * before the copy was due (`too-fast`), which is what the copier does too.
 */
function resolvePending(s: ChainState, mint: string, mark: number, at: number): void {
  const before = s.lastPx.get(mint);
  if (before === undefined && s.lastPx.size >= MAX_LAST_PX) {
    let n = Math.floor(s.lastPx.size / 2);
    for (const k of s.lastPx.keys()) {
      if (n-- <= 0) break;
      s.lastPx.delete(k);
    }
  }
  s.lastPx.set(mint, mark);
  const list = s.pending.get(mint);
  if (!list) return;
  // The state at every due time already passed is the mark before this print.
  const price = before ?? mark;
  const keep: Pending[] = [];
  for (const pd of list) {
    if (pd.kind === 'entry') {
      if (pd.pos.closed) continue;
      if (at >= pd.pos.followerDue) {
        pd.pos.followerEntry = price;
        queueMarks(s, keep, pd, price);
        continue;
      }
      keep.push(pd);
      continue;
    }
    if (pd.kind === 'mark') {
      if (at >= pd.due) noteMark(s, pd, price);
      else keep.push(pd);
      continue;
    }
    if (at >= pd.due) {
      const ret = followerNetReturnPct(pd.entry, price);
      if (ret === null) markUnreachableExit(pd);
      else settleExit(s, pd, ret);
      continue;
    }
    keep.push(pd);
  }
  s.pendingCount -= list.length - keep.length;
  if (keep.length) s.pending.set(mint, keep);
  else s.pending.delete(mint);
}

/**
 * Every so often, settle the fills on mints that stopped printing. Nothing
 * traded since their due time, so the market they would have met is the last
 * mark: a dead coin's copy is priced where it died, never dropped as
 * "unreachable" (which scored a wallet that rides coins to zero as if those
 * trips never happened). Only a mint with no mark left is unreachable.
 */
function sweepPending(s: ChainState, now: number): void {
  for (const [mint, list] of [...s.pending]) {
    const keep: Pending[] = [];
    const mark = s.lastPx.get(mint);
    for (const pd of list) {
      const due = pd.kind === 'entry' ? pd.pos.followerDue : pd.due;
      if (pd.kind === 'entry' && pd.pos.closed) continue;
      if (now - due > FOLLOWER_FILL_STALE_MS) {
        if (pd.kind === 'entry') {
          if (mark !== undefined) {
            pd.pos.followerEntry = mark;
            queueMarks(s, keep, pd, mark);
          }
        } else if (pd.kind === 'mark') {
          // Nothing printed since: the coin stands where it died.
          if (mark !== undefined) noteMark(s, pd, mark);
        } else {
          const ret = mark !== undefined ? followerNetReturnPct(pd.entry, mark) : null;
          if (ret === null) markUnreachableExit(pd);
          else settleExit(s, pd, ret);
        }
        continue;
      }
      keep.push(pd);
    }
    s.pendingCount -= list.length - keep.length;
    if (keep.length) s.pending.set(mint, keep);
    else s.pending.delete(mint);
  }
}

function rememberMint(b: Book, mint: string): void {
  if (b.mints.has(mint)) return;
  if (b.mints.size < MAX_MINTS) b.mints.add(mint);
  else b.mintsFloor += 1;
}

function pushTrip(b: Book, t: ScoutTrip): void {
  b.recentTrips.unshift(t);
  if (b.recentTrips.length > MAX_RECENT_TRIPS) b.recentTrips.length = MAX_RECENT_TRIPS;
}

/**
 * Count this trade toward the day's busiest minute (`peakPerMin`, the
 * trade-rate bot rule). Times are kept in order; the live feed trims the
 * minute behind it, and a scan's older trades slot in where they belong.
 * When a live trade trims a scan's earlier ones away, a minute is
 * undercounted — never overcounted, so the error only ever spares a wallet
 * the bot label.
 */
function noteRate(b: Book, bucket: ScoutDay, at: number): void {
  const r = b.rateAt;
  let i = r.length;
  while (i > 0 && r[i - 1] > at) i--;
  r.splice(i, 0, at);
  if (i === r.length - 1) {
    let drop = 0;
    while (r[drop] <= at - RATE_WINDOW_MS) drop++;
    if (drop) r.splice(0, drop);
    i -= drop;
  }
  if (r.length > MAX_RATE_TIMES) {
    const over = r.length - MAX_RATE_TIMES;
    r.splice(0, over);
    i -= over;
  }
  // Trades in the minute ending at this one, this one included.
  let n = 0;
  for (let j = i; j >= 0 && at - r[j] < RATE_WINDOW_MS; j--) n++;
  if (n > (bucket.peakPerMin ?? 0)) bucket.peakPerMin = n;
}

function dayBucket(b: Book, at: number): ScoutDay {
  const d = dayOf(at);
  let bucket = b.days.get(d);
  if (!bucket) {
    bucket = emptyDay(d);
    b.days.set(d, bucket);
  }
  return bucket;
}

/**
 * Record one trade.
 *
 * `native` is what MOVED — SOL/ETH/BNB in on a buy, out on a sell — and
 * `tokens` the token side. A sell with no matching position is counted as a
 * sell and nothing more: we did not see the buy, so we cannot price the round
 * trip, and inventing a basis is how a leaderboard starts lying.
 *
 * `tx` is the trade's id (signature, or hash:logIndex on EVM). When given, a
 * trade seen before is refused as a duplicate — the guard that lets a manual
 * scan replay hours the live feed may already have recorded. Feeding must be
 * OLDEST-FIRST: a sell only scores against a buy already on the book.
 *
 * `history` marks a trade read from ONE wallet's own past ("Read from chain"):
 * the only prints that read sees on a mint are that wallet's own trades, so
 * it must not price a follower (its next trade would fill its copy at its own
 * price), and it says nothing about how long the MARKET has been watched.
 * Its trips are kept with the follower side "not priced" (2026-10-22).
 */
export function note(
  chain: ScoutChain,
  address: string,
  mint: string,
  isBuy: boolean,
  native: number,
  tokens: number,
  at = Date.now(),
  tx?: string,
  history = false,
  /** The price this trade LEFT the market at, when the rail knows it (the
   *  pump curve's post-trade reserves). Absent: the trade's average price. */
  markPrice?: number,
): NoteResult {
  if (!address || !Number.isFinite(native) || native <= 0) return 'ignored';
  const s = chainState(chain);
  if (!history) observe(s, at);
  const key = address.toLowerCase();
  // The address as the chain spells it. Solana base58 is case-sensitive:
  // lower-casing it names a different wallet, which is what this record used
  // to store and hand to Follow (2026-10-22). EVM addresses are not, and the
  // EVM rails deliver them lower-cased already.
  const spelled = chain === 'solana' ? address : key;
  if (tx) {
    const h = txHash(tx);
    if (s.seenTx.has(h)) return 'duplicate';
    s.seenTx.add(h);
    while (s.seenTx.size > MAX_SEEN_TX) {
      const oldest = s.seenTx.values().next().value;
      if (oldest === undefined) break;
      s.seenTx.delete(oldest);
    }
  }
  // Every trade is a PRINT on its mint — the user's own included. It settles
  // any follower leg already due at the mark BEFORE it (the market a copy
  // landing then would have met), and then becomes the mark. Resolved before
  // this trade is scored, so a leader's own later trade never fills their
  // follower's leg at their own price.
  if (!history && Number.isFinite(tokens) && tokens > 0) {
    const mark = markPrice !== undefined && Number.isFinite(markPrice) && markPrice > 0 ? markPrice : native / tokens;
    resolvePending(s, mint, mark, at);
  }
  if (++s.notes % SWEEP_EVERY === 0) sweepPending(s, at);
  // Never record the user's own wallets — see ownAddresses.
  if (ownAddresses.get(chain)?.has(key)) return 'own';

  let b = s.tracked.get(key);
  if (!b) {
    // Not promoted yet: one counter, no book. Most addresses stop here.
    const seen = (s.sightings.get(key) ?? 0) + 1;
    if (seen < PROMOTE_AFTER) {
      if (!s.sightings.has(key) && s.sightings.size >= MAX_SIGHTINGS) dropOlderSightings(s);
      s.sightings.set(key, seen);
      return 'noted';
    }
    s.sightings.delete(key);
    b = { address: spelled, firstSeen: at, lastSeen: at, days: new Map(), positions: new Map(), holds: [], firstBuys: [], mints: new Set(), mintsFloor: 0, recentTrips: [], rateAt: [] };
    s.tracked.set(key, b);
    s.thin.add(key);
    // Coins they created before they had a book are theirs all the same.
    const created = s.pendingCreates.get(key);
    if (created) {
      for (const t of created) {
        const d = dayBucket(b, t);
        d.creates = (d.creates ?? 0) + 1;
      }
      s.pendingCreates.delete(key);
    }
    evictCandidates(s);
  } else if (s.thin.has(key)) {
    // A touch: the candidate moves to the back of the eviction line.
    s.thin.delete(key);
    s.thin.add(key);
  }
  // A record written before 2026-10-22 holds the lower-cased spelling; the
  // first trade seen since puts the real one back.
  if (b.address !== spelled) b.address = spelled;

  // A scan can arrive out of order against the live feed: neither edge moves
  // the wrong way.
  if (at > b.lastSeen) b.lastSeen = at;
  if (at < b.firstSeen) b.firstSeen = at;
  const bucket = dayBucket(b, at);
  noteRate(b, bucket, at);

  if (isBuy) {
    bucket.buys += 1;
    bucket.volume += native;
    rememberMint(b, mint);
    const p = b.positions.get(mint);
    if (p) {
      p.cost += native;
      p.tokens += tokens;
      p.spent += native;
    } else {
      if (b.positions.size >= MAX_OPEN) return 'noted';
      // The follower mirrors the FIRST buy, at the first print after the lag.
      // A history read has no market prints to fill it at: never priced.
      const pos: Pos = { cost: native, tokens, openedAt: at, spent: native, realised: 0, followerEntry: null, followerDue: at + FOLLOWER_LAG_MS, closed: false, unpriced: history };
      b.positions.set(mint, pos);
      b.firstBuys.push(native);
      if (b.firstBuys.length > MAX_HOLDS) b.firstBuys.shift();
      if (!history) {
        addPending(s, mint, { kind: 'entry', pos, key });
        // Moved to the back: the PumpSwap feed keeps this coin's prints
        // coming to the book after it graduates (wantsMint).
        s.openMints.delete(mint);
        s.openMints.set(mint, at);
        if (s.openMints.size > MAX_OPEN_MINTS) dropOlderHalf(s.openMints);
      }
    }
    return 'noted';
  }

  bucket.sells += 1;
  const p = b.positions.get(mint);
  // A sell we have no basis for: counted, never priced.
  if (!p || p.tokens <= 0) return 'noted';

  const share = Math.min(1, tokens / p.tokens);
  const costOut = p.cost * share;
  const pnl = native - costOut;
  p.cost -= costOut;
  p.tokens -= Math.min(tokens, p.tokens);
  p.realised += pnl;

  // Flat, or so close that what is left is dust — the trip is closed and
  // scored on the day it CLOSED, which is what makes a daily window mean
  // "what did this wallet make today".
  if (p.tokens <= 0 || p.cost <= 1e-9) {
    b.positions.delete(mint);
    p.closed = true;
    bucket.roundTrips += 1;
    // Won or lost on the WHOLE trip, not the last sell: a trip that took
    // profit early and dumped the rest at a small loss was a win (2026-10-22).
    if (p.realised > 0) bucket.wins += 1;
    else if (p.realised < 0) bucket.losses += 1;
    const holdMs = Math.max(0, at - p.openedAt);
    b.holds.push(holdMs);
    if (b.holds.length > MAX_HOLDS) b.holds.shift();
    bucket.measured = (bucket.measured ?? 0) + 1;
    if (holdMs < COPY_LATENCY_FLOOR_MS) bucket.fast = (bucket.fast ?? 0) + 1;
    if (s.mayhemMints.has(mint)) bucket.mayhemTrips = (bucket.mayhemTrips ?? 0) + 1;

    // The follower's trip: mirrored on the FINAL close, both legs at the
    // first print after the lag. No entry print before the leader was out
    // means a copy was never in it.
    const trip: ScoutTrip = { mint, openedAt: p.openedAt, closedAt: at, cost: p.spent, pnl: p.realised, holdMs, followerReturnPct: null, followerNote: 'no-exit' };
    if (p.followerEntry === null && at >= p.followerDue && (p.unpriced || history)) {
      // Opened or closed in a history read: whether a copy could have filled
      // is unknown, so it is neither reachable nor unreachable.
      trip.followerNote = 'unpriced';
    } else if (p.followerEntry === null) {
      trip.followerNote = at < p.followerDue ? 'too-fast' : 'no-entry';
      bucket.unreachable = (bucket.unreachable ?? 0) + 1;
    } else if (history) {
      // Entered on the market, closed in a history read: the exit has no
      // market print to fill at.
      trip.followerNote = 'unpriced';
    } else {
      addPending(s, mint, { kind: 'exit', due: at + FOLLOWER_LAG_MS, entry: p.followerEntry, trip, bucket, key });
    }
    pushTrip(b, trip);
    // Reaching the rank floor moves a candidate into the ranked tier.
    if (s.thin.has(key) && totalTrips(b) >= MIN_TRIPS_FOR_RANK) {
      s.thin.delete(key);
      evictRanked(s);
    }
  }
  bucket.pnl += pnl;
  schedulePersist();
  return 'noted';
}

/**
 * A coin created (2026-10-23), from the create event the feed decodes: the
 * "Creates coins" warning, and the mayhem-mode coins whose trips earn the
 * "Mayhem coins" one. Free — the feed already decodes every create.
 */
export function noteCreate(chain: ScoutChain, creator: string, mint: string, at = Date.now(), isMayhem = false): void {
  const s = chainState(chain);
  if (isMayhem && mint && !s.mayhemMints.has(mint)) {
    s.mayhemMints.add(mint);
    if (s.mayhemMints.size > MAX_MAYHEM_MINTS) dropOlderHalf(s.mayhemMints);
  }
  if (!creator) return;
  const key = creator.toLowerCase();
  if (ownAddresses.get(chain)?.has(key)) return;
  const b = s.tracked.get(key);
  if (b) {
    const d = dayBucket(b, at);
    d.creates = (d.creates ?? 0) + 1;
    schedulePersist();
    return;
  }
  const list = s.pendingCreates.get(key);
  if (list) {
    if (list.length < 20) list.push(at);
    return;
  }
  if (s.pendingCreates.size >= MAX_PENDING_CREATES) dropOlderHalf(s.pendingCreates);
  s.pendingCreates.set(key, [at]);
}

/**
 * Whether a trade on `mint` matters to the book: a tracked wallet opened a
 * position on it, or a copy leg is waiting for a print there. The PumpSwap
 * feed asks before feeding a swap, so a trip that graduates — bought on the
 * curve, sold on the pool — closes, and its copy is priced (2026-10-23:
 * only curve trades reached the book, so those trips never closed, and they
 * are the slow wallets' trips: the copyable kind).
 */
export function wantsMint(chain: ScoutChain, mint: string): boolean {
  const s = chainState(chain);
  return s.openMints.has(mint) || s.pending.has(mint);
}

/** Whether the book wants PumpSwap swaps decoded at all. */
export function wantsAmm(chain: ScoutChain): boolean {
  const s = chainState(chain);
  return s.openMints.size > 0 || s.pendingCount > 0;
}

// ── The board's own record (shared/walletScout.ts) ────────────────────

/** The ranked tier as wallets: only it can make the list (it needs copied
 *  trips past the rank floor), and summarising 25k candidates every few
 *  minutes is waste. */
function rankedWallets(chain: ScoutChain, s: ChainState): ScoutWallet[] {
  const observed = observedDays(chain);
  return [...s.tracked].filter(([k]) => !s.thin.has(k)).map(([, b]) => toWallet(chain, b, observed));
}

/**
 * The week's shrinkage prior, measured from this chain's own ranked universe
 * (shared/walletScore.ts estimatePrior; 2026-10-25, P1) and kept for
 * PRIOR_FRESH_MS. Every board read shrinks with the same one, so a row on
 * Discover, a pick and a snapshot agree.
 */
export function shrinkPrior(chain: ScoutChain, now = Date.now()): ShrinkPrior {
  const s = chainState(chain);
  if (s.prior && now >= s.prior.at && now - s.prior.at < PRIOR_FRESH_MS) return s.prior;
  s.prior = estimatePrior(
    rankedWallets(chain, s).map((w) => priorWalletOf(w, 'week', now)),
    now,
  );
  return s.prior;
}

/**
 * Write down who "Best to copy" lists right now: the same rows, the same
 * rule (week window, default size, all five filters, the lower bound of the
 * shrunk median under the week's prior), the top SCOUT_PICKS_N. A wallet
 * already picked keeps its first pick time; a pick older than
 * SCOUT_PICK_KEEP_DAYS is let go. Returns how many are new.
 *
 * Alongside (2026-10-25, P1): the two shadow selections the scorecard grades
 * the picks against — LEAD, the top N by the wallets' own profit, which is
 * what every other copy tool ranks on; NEXT, the N just under the picks in
 * this ranking (the research's "decile 9", which beat decile 10 on three
 * tapes) — and, once a week, a snapshot of every ranked wallet's figure
 * under the live prior and a grid of fixed (k, z), so the week can be graded
 * on the RANKING and not only on the picks.
 */
export function refreshPicks(chain: ScoutChain, now = Date.now()): number {
  const s = chainState(chain);
  const cutoff = now - SCOUT_PICK_KEEP_DAYS * 86_400_000;
  for (const [k, p] of s.picks) if (p.pickedAt < cutoff) s.picks.delete(k);
  for (const [k, p] of s.shadow) if (p.pickedAt < cutoff) s.shadow.delete(k);
  const universe = rankedWallets(chain, s);
  const pw = universe.map((w) => priorWalletOf(w, 'week', now));
  const prior = estimatePrior(pw, now);
  s.prior = prior;
  const rows = universe.map((w) => summarise(w, 'week', now, { prior }));
  const eligible = shortlist(rankScout(rows, SCOUT_RANK_SORT), rows.length);
  let added = 0;
  for (const r of eligible.slice(0, SCOUT_PICKS_N)) {
    const k = r.address.toLowerCase();
    if (s.picks.has(k)) continue;
    s.picks.set(k, { address: r.address, pickedAt: now, shrunkPct: r.basis.shrunkPct, lowerPct: r.basis.lowerPct, fTripsAtPick: r.fTrips, returns: [] });
    added += 1;
  }
  let changed = added > 0;
  const shadowSet = (arm: 'lead' | 'next', r: (typeof rows)[number]): void => {
    const k = `${arm}:${r.address.toLowerCase()}`;
    if (s.shadow.has(k)) return;
    s.shadow.set(k, { address: r.address, pickedAt: now, shrunkPct: r.basis.shrunkPct, lowerPct: r.basis.lowerPct, arm, fTripsAtPick: r.fTrips, returns: [] });
    changed = true;
  };
  // NEXT: from the tenth percentile of the eligible list down, or right
  // under the picks when the list is short.
  const start = Math.max(SCOUT_PICKS_N, Math.floor(eligible.length / 10));
  for (const r of eligible.slice(start, start + SCOUT_PICKS_N)) shadowSet('next', r);
  // LEAD: the wallets' own realised profit, no filters, as a leaderboard
  // would list them.
  for (const r of rankScout(rows, 'pnl').filter((r) => r.pnl > 0).slice(0, SCOUT_PICKS_N)) shadowSet('lead', r);
  // The week's snapshot, at the first refresh of the week.
  const week = weekOf(now);
  if (!s.snapshots.has(week)) {
    const snapRows: ScoreSnapshot['rows'] = [];
    for (const w of pw) {
      if (w.fTrips < SCORE_MIN_F_TRIPS || w.returns.length < SCORE_MIN_F_TRIPS) continue;
      snapRows.push(snapshotRow(walletKey8(w.address), w.returns[Math.floor(w.returns.length / 2)], w.returns.length, prior, styleBucket(w.medianHoldMs, w.medianFirstBuy, prior)));
    }
    if (snapRows.length) {
      s.snapshots.set(week, { week, at: now, variants: snapshotVariants(), rows: snapRows });
      const weeks = [...s.snapshots.keys()].sort((a, b) => b - a);
      for (const old of weeks.slice(SNAPSHOT_WEEKS)) s.snapshots.delete(old);
      changed = true;
    }
  }
  if (changed) schedulePersist();
  return added;
}

const copyPick = (p: ScoutPick): ScoutPick => ({ ...p, returns: [...p.returns], ...(p.at ? { at: [...p.at] } : {}) });

/** The picks still followed, oldest first. */
export function picks(chain: ScoutChain): ScoutPick[] {
  return [...chainState(chain).picks.values()].map(copyPick).sort((a, b) => a.pickedAt - b.pickedAt);
}

/** The shadow selections still tracked (ScoutPick.arm set), oldest first. */
export function shadow(chain: ScoutChain): ScoutPick[] {
  return [...chainState(chain).shadow.values()].map(copyPick).sort((a, b) => a.pickedAt - b.pickedAt);
}

/** The weekly ranking snapshots, oldest first. */
export function snapshots(chain: ScoutChain): ScoreSnapshot[] {
  return [...chainState(chain).snapshots.values()].sort((a, b) => a.week - b.week);
}

/** Every mark after a ranked wallet's fill, sampled. */
export function marks(chain: ScoutChain): MarkEntry[] {
  const out: MarkEntry[] = [];
  for (const b of chainState(chain).marks.values()) out.push(...b.rs);
  return out;
}

/** Every priced copy, sampled: [openedAt, recorded return %]. */
export function baseline(chain: ScoutChain): BaselineEntry[] {
  const out: BaselineEntry[] = [];
  for (const b of chainState(chain).baseline.values()) out.push(...b.rs);
  return out;
}

/** Drop the older half of the sighting counters (Map order = first seen). */
function dropOlderSightings(s: ChainState): void {
  let n = Math.floor(s.sightings.size / 2);
  for (const k of s.sightings.keys()) {
    if (n-- <= 0) break;
    s.sightings.delete(k);
  }
}

/**
 * Keep the candidate tier under its cap: least recently touched first.
 *
 * Only candidates are ever removed here, so the flood of new addresses can
 * no longer push a wallet with a real record off the book — the 6,000 shared
 * cap filled within the hour once the live feed reached the Scout. A SAVED
 * wallet is never evicted: the user asked to keep it, and losing a bookmark
 * to a cache bound would be the app quietly undoing a decision they made.
 */
function evictCandidates(s: ChainState): void {
  if (s.thin.size <= MAX_CANDIDATES) return;
  for (const key of s.thin) {
    if (s.thin.size <= MAX_CANDIDATES) break;
    if (s.saved.has(key)) continue;
    s.thin.delete(key);
    s.tracked.delete(key);
  }
}

/**
 * Keep the ranked tier under its cap: least recently active first, a batch
 * of 5% at a time so a full book is sorted once per 300 promotions, not on
 * every one.
 */
function evictRanked(s: ChainState): void {
  const ranked = s.tracked.size - s.thin.size;
  if (ranked <= MAX_TRACKED) return;
  const target = Math.floor(MAX_TRACKED * 0.95);
  const order = [...s.tracked]
    .filter(([key]) => !s.thin.has(key) && !s.saved.has(key))
    .sort((x, y) => x[1].lastSeen - y[1].lastSeen);
  let over = ranked - target;
  for (const [key] of order) {
    if (over-- <= 0) break;
    s.tracked.delete(key);
  }
}

/** Wallets the user saved on a chain. */
export function savedList(chain: ScoutChain): string[] {
  return [...chainState(chain).saved.values()];
}

export function isSaved(chain: ScoutChain, address: string): boolean {
  return chainState(chain).saved.has(address.toLowerCase());
}

export function setSaved(chain: ScoutChain, address: string, on: boolean): { ok: boolean; message: string } {
  const key = String(address ?? '').toLowerCase();
  if (!key) return { ok: false, message: 'No wallet given' };
  const s = chainState(chain);
  if (on) s.saved.set(key, chain === 'solana' ? String(address).trim() : key);
  else s.saved.delete(key);
  persist();
  return { ok: true, message: on ? 'Saved' : 'Removed' };
}

function median(xs: readonly number[]): number | null {
  if (xs.length < 4) return null; // too few to call a median
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function toWallet(chain: ScoutChain, b: Book, observed: readonly number[] = observedDays(chain)): ScoutWallet {
  let openCost = 0;
  for (const p of b.positions.values()) openCost += p.cost;
  return {
    chain,
    address: b.address,
    firstSeen: b.firstSeen,
    lastSeen: b.lastSeen,
    days: rotate([...b.days.values()]),
    openCount: b.positions.size,
    openCost,
    medianHoldMs: median(b.holds),
    medianFirstBuy: median(b.firstBuys),
    distinctMints: b.mints.size + b.mintsFloor,
    recentTrips: [...b.recentTrips],
    observedDays: observed,
    chainLabel: b.chainLabel ?? null,
    neverSigns: b.neverSigns ?? null,
  };
}

/**
 * The chain's label for a wallet (2026-10-25), written by the board labeler
 * after a chain-read, random-sample replay. Kept with the record and saved;
 * `summarise` carries it onto the row, where the hard exclusions read it.
 * Only a wallet the book tracks can carry one — a label for a stranger is
 * dropped, said so.
 */
export function setChainLabel(chain: ScoutChain, address: string, label: ChainLabel): boolean {
  const b = chainState(chain).tracked.get(address.toLowerCase());
  if (!b) return false;
  b.chainLabel = label;
  persist();
  return true;
}

/**
 * What a chain read said about who signs (2026-10-28): a mark when it found
 * the wallet's tokens moving only under other signatures, null to clear it
 * when it found a swap the wallet signed. A wallet the book does not track
 * has no record to mark.
 */
export function setNeverSigns(chain: ScoutChain, address: string, v: NeverSigns | null): boolean {
  const b = chainState(chain).tracked.get(address.toLowerCase());
  if (!b) return false;
  if (!v && !b.neverSigns) return true;
  b.neverSigns = v;
  persist();
  return true;
}

export function chainLabelOf(chain: ScoutChain, address: string): ChainLabel | null {
  return chainState(chain).tracked.get(address.toLowerCase())?.chainLabel ?? null;
}

/** Every tracked wallet on a chain. The caller windows and ranks. */
export function wallets(chain: ScoutChain): ScoutWallet[] {
  const s = chainState(chain);
  const observed = observedDays(chain);
  return [...s.tracked.values()].map((b) => toWallet(chain, b, observed));
}

/**
 * Forget every tracked wallet on a chain.
 *
 * The population here is built by WATCHING — the live feed and any scan the
 * user runs — so it only grows, and the only way to start a fresh hunt was to
 * delete a file by hand. Nothing ships with wallets in it; this is the user's
 * own accumulation, and it has to be theirs to throw away.
 *
 * SAVED wallets survive. Saving is a deliberate act — the one signal on this
 * page that the user, not the scanner, put there — and a "clear" that threw it
 * away would make the bookmark useless. They are returned to a blank record
 * rather than deleted, so a saved wallet still appears and simply has nothing
 * measured about it yet.
 */
export function clearTracked(chain: ScoutChain): { ok: boolean; message: string; cleared: number } {
  const s = chainState(chain);
  const before = s.tracked.size;
  const keep = new Set(s.saved.keys());
  for (const [addr] of [...s.tracked]) {
    if (!keep.has(addr)) {
      s.tracked.delete(addr);
      s.thin.delete(addr);
    }
  }
  // Sightings and open positions are session state about wallets that no longer
  // have a record; leaving them would let the next trade resurrect a half-row.
  s.sightings.clear();
  // A fresh record starts its watched days again too: kept, they would hide
  // every new wallet for not having traded on days nobody recorded.
  s.observedDays.clear();
  s.dayCache = null;
  persist();
  const cleared = before - s.tracked.size;
  return {
    ok: true,
    message: cleared
      ? `Forgot ${cleared.toLocaleString()} wallet${cleared === 1 ? '' : 's'}${keep.size ? `, kept ${keep.size} saved` : ''}`
      : 'Nothing tracked to clear',
    cleared,
  };
}

export function counts(chain: ScoutChain): { tracked: number; watching: number; cap: number } {
  const s = chainState(chain);
  return { tracked: s.tracked.size, watching: s.sightings.size, cap: MAX_TRACKED };
}

// ── Persistence ───────────────────────────────────────────────────────
//
// Long-term is the point: a leaderboard that forgets on restart cannot answer
// "this week". Only the daily buckets are saved — open positions and sighting
// counters are session state, and a position book restored across a restart
// would price a sell against a buy from days ago.

interface StoredWallet {
  address: string;
  firstSeen: number;
  lastSeen: number;
  days: ScoutDay[];
  medianHoldMs: number | null;
  /**
   * The newest hold times themselves (2026-10-22). A record saved with only
   * its median came back as four copies of it — or, when the median was
   * still null, as nothing, so a 13-second scalper restarted with an unknown
   * hold and passed "Holds over a minute" (unknown never hides a row).
   */
  holds?: number[];
  /** The newest first-buy sizes, for the "Large size" warning (2026-10-23). */
  firstBuys?: number[];
  /** Named mints (ranked wallets only, capped) and the count beyond them. */
  mints?: string[];
  mintsFloor?: number;
  /** Ranked wallets only — thin records have nothing worth a drawer. */
  recentTrips?: ScoutTrip[];
  /** The chain's label (2026-10-25), when one was run. */
  chainLabel?: ChainLabel;
  /** Never signs its swaps (2026-10-28) — kept for every record, ranked or not. */
  neverSigns?: NeverSigns;
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  loadSeen();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
    }
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // An unreadable history is NOT an empty history: fail closed and never
    // write over it, so a corrupt file can be recovered by hand.
    loadFailure = `${filePath} is not valid JSON (${(e as Error).message})`;
    return;
  }
  const obj = raw as {
    chains?: Record<string, StoredWallet[]>;
    saved?: Record<string, string[]>;
    observed?: Record<string, number[]>;
    picks?: Record<string, ScoutPick[]>;
    baseline?: Record<string, Array<[number, number] | [number, number, string]>>;
    shadow?: Record<string, ScoutPick[]>;
    snapshots?: Record<string, ScoreSnapshot[]>;
    marks?: Record<string, MarkEntry[]>;
  };
  if (!obj || typeof obj !== 'object' || !obj.chains || typeof obj.chains !== 'object') {
    loadFailure = `${filePath} is not a wallet-scout file this version understands`;
    return;
  }
  for (const chain of SCOUT_CHAINS) {
    const marks = obj.saved?.[chain];
    if (Array.isArray(marks)) {
      const s2 = chainState(chain);
      for (const a of marks) if (typeof a === 'string' && a) s2.saved.set(a.toLowerCase(), chain === 'solana' ? a : a.toLowerCase());
    }
    const rows = obj.chains[chain];
    if (!Array.isArray(rows)) continue;
    const s = chainState(chain);
    // Oldest first, so the candidate tier's eviction order is least recent
    // activity, the same order it keeps while running.
    const ordered = rows.filter((r) => r && typeof r.address === 'string' && Array.isArray(r.days)).sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
    for (const r of ordered) {
      const days = new Map<number, ScoutDay>();
      for (const d of rotate(r.days.filter((d) => d && typeof d.day === 'number'))) days.set(d.day, d);
      if (days.size === 0) continue;
      const key = r.address.toLowerCase();
      let trips = 0;
      for (const d of days.values()) trips += d.roundTrips;
      if (trips < MIN_TRIPS_FOR_RANK) s.thin.add(key);
      s.tracked.set(key, {
        address: r.address,
        firstSeen: typeof r.firstSeen === 'number' ? r.firstSeen : Date.now(),
        lastSeen: typeof r.lastSeen === 'number' ? r.lastSeen : Date.now(),
        days,
        positions: new Map(),
        holds: Array.isArray(r.holds)
          ? r.holds.filter((h) => typeof h === 'number' && Number.isFinite(h) && h >= 0).slice(-MAX_HOLDS)
          : typeof r.medianHoldMs === 'number'
            ? [r.medianHoldMs, r.medianHoldMs, r.medianHoldMs, r.medianHoldMs]
            : [],
        firstBuys: Array.isArray(r.firstBuys) ? r.firstBuys.filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0).slice(-MAX_HOLDS) : [],
        mints: new Set(Array.isArray(r.mints) ? r.mints.filter((x) => typeof x === 'string').slice(0, MAX_MINTS) : []),
        mintsFloor: typeof r.mintsFloor === 'number' && r.mintsFloor > 0 ? Math.floor(r.mintsFloor) : 0,
        recentTrips: Array.isArray(r.recentTrips) ? r.recentTrips.filter((t) => t && typeof t.mint === 'string' && typeof t.closedAt === 'number').slice(0, MAX_RECENT_TRIPS) : [],
        rateAt: [],
        chainLabel: r.chainLabel && typeof r.chainLabel.at === 'number' && typeof r.chainLabel.chainTrips === 'number' ? r.chainLabel : null,
        neverSigns: r.neverSigns && typeof r.neverSigns.at === 'number' && typeof r.neverSigns.read === 'number' ? r.neverSigns : null,
      });
    }
    // The watched days. A file from before 2026-10-22 has none: the days
    // any recorded wallet traded on are the best stand-in — the book saw the
    // market on each of them, if only a little.
    const watched = obj.observed?.[chain];
    if (Array.isArray(watched)) {
      for (const d of watched) if (typeof d === 'number' && Number.isInteger(d)) s.observedDays.add(d);
    } else {
      for (const b of s.tracked.values()) for (const d of b.days.values()) if (d.buys + d.sells > 0) s.observedDays.add(d.day);
    }
    // The board's picks and its comparison sample (2026-10-23), and the
    // shadow selections beside them (2026-10-25).
    const ps = obj.picks?.[chain];
    if (Array.isArray(ps)) {
      for (const p of ps) {
        const pick = loadPick(p);
        if (pick) s.picks.set(pick.address.toLowerCase(), pick);
      }
    }
    const sh = obj.shadow?.[chain];
    if (Array.isArray(sh)) {
      for (const p of sh) {
        const pick = loadPick(p);
        if (pick && (pick.arm === 'lead' || pick.arm === 'next')) s.shadow.set(`${pick.arm}:${pick.address.toLowerCase()}`, pick);
      }
    }
    const sn = obj.snapshots?.[chain];
    if (Array.isArray(sn)) {
      for (const x of sn) {
        if (!x || typeof x.week !== 'number' || typeof x.at !== 'number' || !Array.isArray(x.variants) || !Array.isArray(x.rows)) continue;
        const rows = x.rows.filter((r): r is ScoreSnapshot['rows'][number] => Array.isArray(r) && typeof r[0] === 'string' && r.length === x.variants.length + 1);
        s.snapshots.set(x.week, { week: x.week, at: x.at, variants: x.variants.filter((v): v is string => typeof v === 'string'), rows });
      }
      for (const old of [...s.snapshots.keys()].sort((a, b) => b - a).slice(SNAPSHOT_WEEKS)) s.snapshots.delete(old);
    }
    const mk = obj.marks?.[chain];
    if (Array.isArray(mk)) {
      for (const e of mk) {
        if (!Array.isArray(e) || e.length !== 4 || typeof e[0] !== 'number' || typeof e[1] !== 'number' || typeof e[2] !== 'number' || !Number.isFinite(e[2]) || typeof e[3] !== 'string') continue;
        const day = Math.floor(e[0] / 86_400_000);
        let b = s.marks.get(day);
        if (!b) s.marks.set(day, (b = { seen: 0, rs: [] }));
        if (b.rs.length < MARKS_PER_DAY) {
          b.rs.push([e[0], e[1], e[2], e[3]]);
          b.seen += 1;
        }
      }
    }
    const bl = obj.baseline?.[chain];
    if (Array.isArray(bl)) {
      for (const e of bl) {
        if (!Array.isArray(e) || typeof e[0] !== 'number' || typeof e[1] !== 'number' || !Number.isFinite(e[1])) continue;
        const day = Math.floor(e[0] / 86_400_000);
        let b = s.baseline.get(day);
        if (!b) s.baseline.set(day, (b = { seen: 0, rs: [] }));
        if (b.rs.length < BASELINE_PER_DAY) {
          b.rs.push(typeof e[2] === 'string' && e[2] ? [e[0], e[1], e[2]] : [e[0], e[1]]);
          b.seen += 1;
        }
      }
    }
  }
}

/** One stored pick, or null when the record is not one. */
function loadPick(p: unknown): ScoutPick | null {
  const x = p as Partial<ScoutPick> | null;
  if (!x || typeof x.address !== 'string' || typeof x.pickedAt !== 'number' || !Array.isArray(x.returns)) return null;
  const returns = x.returns.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice(0, MAX_PICK_RETURNS);
  return {
    address: x.address,
    pickedAt: x.pickedAt,
    shrunkPct: typeof x.shrunkPct === 'number' ? x.shrunkPct : null,
    ...(typeof x.lowerPct === 'number' ? { lowerPct: x.lowerPct } : {}),
    ...(x.arm === 'lead' || x.arm === 'next' ? { arm: x.arm } : {}),
    fTripsAtPick: typeof x.fTripsAtPick === 'number' ? x.fTripsAtPick : 0,
    returns,
    // Opening times only when they line up with the returns; a file from
    // before them has none, and its copies belong to no week.
    ...(Array.isArray(x.at) && x.at.length === x.returns.length && x.at.every((v) => typeof v === 'number') ? { at: x.at.slice(0, MAX_PICK_RETURNS) } : {}),
  };
}

function schedulePersist(): void {
  if (!filePath || loadFailure || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 30_000);
}

export function persist(): void {
  if (!filePath || loadFailure) return;
  const chains: Record<string, StoredWallet[]> = {};
  const saved: Record<string, string[]> = {};
  const observed: Record<string, number[]> = {};
  const pickRec: Record<string, ScoutPick[]> = {};
  const base: Record<string, Array<[number, number] | [number, number, string]>> = {};
  const shadowRec: Record<string, ScoutPick[]> = {};
  const snapRec: Record<string, ScoreSnapshot[]> = {};
  const markRec: Record<string, MarkEntry[]> = {};
  const oldest = dayOf(Date.now()) - (SCOUT_RETENTION_DAYS - 1);
  for (const chain of SCOUT_CHAINS) {
    const s = chainState(chain);
    saved[chain] = [...s.saved.values()];
    observed[chain] = observedDays(chain).filter((d) => d >= oldest);
    pickRec[chain] = [...s.picks.values()];
    shadowRec[chain] = [...s.shadow.values()];
    snapRec[chain] = snapshots(chain);
    markRec[chain] = marks(chain).map((e) => [Math.round(e[0] / 1000) * 1000, e[1], e[2], e[3]]);
    // Rounded: a return to 0.01 % and a time to the second is all the
    // record's medians use, and the sample is rewritten every thirty seconds.
    base[chain] = baseline(chain).map((e) => (e.length === 3 ? [Math.round(e[0] / 1000) * 1000, Math.round(e[1] * 100) / 100, e[2]] : [Math.round(e[0] / 1000) * 1000, Math.round(e[1] * 100) / 100]));
    // Candidates: only the most recently touched with a closed trip — the
    // tier is 25k wallets, nearly all of them one or two trades, and this
    // file is rewritten every thirty seconds. Saved ones always go.
    const keepThin = new Set<string>();
    const thinKeys = [...s.thin];
    for (let i = thinKeys.length - 1; i >= 0 && keepThin.size < MAX_CANDIDATES_SAVED; i--) {
      const b = s.tracked.get(thinKeys[i]);
      if (b && totalTrips(b) > 0) keepThin.add(thinKeys[i]);
    }
    chains[chain] = [...s.tracked]
      .filter(([key]) => !s.thin.has(key) || keepThin.has(key) || s.saved.has(key))
      .map(([, b]) => {
        const ranked = totalTrips(b) >= MIN_TRIPS_FOR_RANK;
        const w: StoredWallet = {
          address: b.address,
          firstSeen: b.firstSeen,
          lastSeen: b.lastSeen,
          days: rotate([...b.days.values()]),
          medianHoldMs: median(b.holds),
        };
        // The newest 50 holds: enough for a median that moves the way a live
        // one does, small next to the day buckets.
        if (b.holds.length) w.holds = b.holds.slice(-SAVED_HOLDS);
        if (b.firstBuys.length) w.firstBuys = b.firstBuys.slice(-SAVED_HOLDS);
        // Names and trips only for the records the board can show: most of
        // six thousand wallets are three trades, and a file that carried a
        // dozen trips for each would be written every thirty seconds.
        if (ranked) {
          w.mints = [...b.mints];
          if (b.mintsFloor > 0) w.mintsFloor = b.mintsFloor;
          if (b.recentTrips.length) w.recentTrips = b.recentTrips;
          if (b.chainLabel) w.chainLabel = b.chainLabel;
        } else if (b.mints.size + b.mintsFloor > 0) {
          w.mintsFloor = b.mints.size + b.mintsFloor;
        }
        if (b.neverSigns) w.neverSigns = b.neverSigns;
        return w;
      })
      .filter((w) => w.days.length > 0);
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chains, saved, observed, picks: pickRec, baseline: base, shadow: shadowRec, snapshots: snapRec, marks: markRec }), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* a failed save costs history, never a trade */
  }
}

export function flushSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persist();
  saveSeen();
}

// ── The trade ids already recorded, across a restart ──────────────────
//
// Saved on quit only: a few MB, and losing it to a crash costs what it cost
// before 2026-10-22 (a scan right after may count some trips twice), never a
// trade. Layout, per chain in SCOUT_CHAINS order: a uint32 count, then that
// many float64 hashes, oldest first. Unreadable or the wrong size = start
// empty; it is a cache of what was seen, not the user's data.

function saveSeen(): void {
  if (!filePath || loadFailure) return;
  try {
    const sizes = SCOUT_CHAINS.map((c) => chainState(c).seenTx.size);
    const buf = Buffer.alloc(sizes.reduce((a, n) => a + 4 + n * 8, 0));
    let o = 0;
    for (const c of SCOUT_CHAINS) {
      const set = chainState(c).seenTx;
      buf.writeUInt32LE(set.size, o);
      o += 4;
      for (const h of set) {
        buf.writeDoubleLE(h, o);
        o += 8;
      }
    }
    const file = path.join(path.dirname(filePath), SEEN_FILE);
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* a failed save costs dedupe across one restart, never a trade */
  }
}

function loadSeen(): void {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(path.dirname(filePath), SEEN_FILE));
  } catch {
    return;
  }
  const out: number[][] = [];
  let o = 0;
  for (let i = 0; i < SCOUT_CHAINS.length; i++) {
    if (o + 4 > buf.length) return;
    const n = buf.readUInt32LE(o);
    o += 4;
    if (n > MAX_SEEN_TX || o + n * 8 > buf.length) return;
    const hs: number[] = [];
    for (let j = 0; j < n; j++, o += 8) hs.push(buf.readDoubleLE(o));
    out.push(hs);
  }
  if (o !== buf.length) return;
  SCOUT_CHAINS.forEach((c, i) => {
    const set = chainState(c).seenTx;
    for (const h of out[i]) set.add(h);
  });
}

/** Test seam. */
export function _reset(): void {
  for (const c of SCOUT_CHAINS) state.set(c, freshState());
  ownAddresses.clear();
  filePath = '';
  loadFailure = null;
}
