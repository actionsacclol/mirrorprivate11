// pump.fun's coin trade tape and candles — keyless historical trades.
//
// This is the only free source that will hand you the trades a token had
// MONTHS ago, and it is what makes retroactive launch analysis possible for a
// contract address the user pastes in cold.
//
// History of the route:
//   • `frontend-api-v3 /trades/all/{mint}` — gone (404, 2026-08-24);
//   • `swap-api.pump.fun /v2/coins/{mint}/trades` — 410 "This endpoint has been
//     deprecated and is no longer available" (measured 2026-11-01), and its
//     `/v1/coins/{mint}/candles` a 404 the same day;
//   • now `frontend-api-v3.pump.fun` — the routes pump.fun's own site calls,
//     read from its route table (2026-11-01):
//
//   GET /trades/{chainId}/{address}?limit=&cursor=|before=|after=
//   → { trades: [...], aggregates, cursor, source }
//
//   • newest first; OLDEST first when `after` is set;
//   • `limit` 1..100;
//   • `cursor` is opaque (base64url) and exclusive with before/after;
//   • `before`/`after` take an OrdinalKey `<blockId>-<txIndex>-<eventIndex>-
//     <blockTimeMs>`, and `blockId` is the Solana SLOT. The old route sought by
//     a timestamp; this one seeks by slot, so a moment has to become a slot
//     first — see "Slot from time" below;
//   • a row: `blockId` (string), `blockTimeMs`, `txId`, `side`, `kind`,
//     `venue` ("pump_amm" after migration), `trader.address`, `baseAmount` and
//     `quoteAmount` as {raw, decimals}, `quote.id` (WSOL on a SOL pair),
//     `priceQuote` (SOL per token on a SOL pair), `valueNative` (SOL moved).
//     One live row (2026-11-01): slot 464319340 at 1793584802000, 0.240563168
//     SOL for 4,695,052.546321 tokens, priceQuote 5.148e-8.
//
//   GET /candles/{chainId}/{address}?res=&count=&measure=price_usd
//   → { candles: [{ openTimeMs, open, high, low, close, volumeUsd, ... }] }
//     oldest first, `count` at most 300.

import { getJson, memo } from '../http';
import type { FetchResult } from '../http';
import type { LaunchTrade } from '@shared/launchintel';
import type { Candle, CandleInterval } from '@shared/market';

export const SOLANA_CHAIN_ID = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const WSOL = 'So11111111111111111111111111111111111111112';

interface Amount {
  raw?: string;
  decimals?: number;
}

/** One row of the coin tape, as the route sends it. */
export interface TapeRow {
  ordinalKey?: string;
  blockId?: string;
  blockTimeMs?: number;
  txId?: string;
  side?: string;
  kind?: string;
  venue?: string;
  trader?: { address?: string } | null;
  baseAmount?: Amount | null;
  quoteAmount?: Amount | null;
  quote?: { id?: string } | null;
  priceQuote?: string | null;
  valueNative?: string | null;
}

interface TapeResponse {
  trades?: TapeRow[];
  cursor?: string | null;
}

const PAGE = 100;

/** Hard ceiling on calls per launch scan, so one token page cannot chew the
 *  whole rate budget hunting for a launch it will never reach. The common
 *  case is ONE call; this only bounds the awkward ones. */
const MAX_CALLS = 5;

/** Calls one `priceAt` may spend turning a moment into a slot. One when a
 *  known slot is near that moment, two or three when it is not. */
const PRICE_CALLS = 4;

function amountOf(a: Amount | null | undefined): number {
  if (!a || typeof a.raw !== 'string' || !/^\d+$/.test(a.raw)) return NaN;
  const d = typeof a.decimals === 'number' && a.decimals >= 0 ? a.decimals : 0;
  return Number(a.raw) / 10 ** d;
}

function slotOf(r: TapeRow): number | null {
  if (typeof r.blockId !== 'string' || !/^\d+$/.test(r.blockId)) return null;
  const n = Number(r.blockId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** SOL moved by the trade: the quote leg on a SOL pair, else pump's own SOL
 *  value of it. */
function solOf(r: TapeRow): number {
  const quote = r.quote?.id === WSOL ? amountOf(r.quoteAmount) : NaN;
  if (Number.isFinite(quote)) return Math.abs(quote);
  const native = Number(r.valueNative);
  return Number.isFinite(native) ? Math.abs(native) : 0;
}

export function normaliseTrade(r: TapeRow): LaunchTrade | null {
  const slot = slotOf(r);
  const ts = typeof r.blockTimeMs === 'number' ? r.blockTimeMs : NaN;
  if (slot === null || !Number.isFinite(ts) || ts <= 0) return null;
  if (r.kind !== undefined && r.kind !== 'swap') return null;
  const user = r.trader?.address;
  if (typeof user !== 'string' || !user) return null;
  if (r.side !== 'buy' && r.side !== 'sell') return null;
  const base = amountOf(r.baseAmount);
  if (!Number.isFinite(base) || base < 0) return null;
  const venue = typeof r.venue === 'string' ? r.venue : '';
  return {
    slot,
    ts,
    user,
    isBuy: r.side === 'buy',
    base,
    sol: solOf(r),
    // The analysis's two names: 'pump' on the curve, 'pump_amm' after.
    program: venue === 'pump_amm' ? 'pump_amm' : venue.startsWith('pump') ? 'pump' : venue || 'unknown',
    tx: typeof r.txId === 'string' ? r.txId : '',
  };
}

/** SOL per token for one row: pump's own figure on a SOL pair, else the
 *  trade's average. Null rather than a guess. */
export function rowPriceSol(r: TapeRow): number | null {
  const mark = r.quote?.id === WSOL ? Number(r.priceQuote) : NaN;
  if (Number.isFinite(mark) && mark > 0) return mark;
  const base = amountOf(r.baseAmount);
  const avg = solOf(r) / base;
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

// ── Slot from time ────────────────────────────────────────────────────
//
// The tape seeks by slot, and a caller has a moment. Slots do not tick at a
// fixed rate across history (about 400 ms before Alpenglow, about 213 ms
// after — 4,795 slots in 1,027 s between two live rows, 2026-11-01), so a
// single rate cannot carry a moment to a slot across months. Every row the
// tape returns is an EXACT (slot, time) pair, so every page teaches the map
// more; a moment between two known pairs is interpolated, one past the ends
// extrapolated. A seek that lands wrong lands somewhere known, and the next
// estimate is made from there — the search closes in like a secant.

const RECENT_SLOT_MS = 213;
const PRE_ALPENGLOW_SLOT_MS = 400;
const ANCHOR_CAP = 4_000;
/** The live pair above — so the very first seek starts from somewhere real. */
const SEED: [number, number] = [464_319_340, 1_793_584_802_000];

/** (slot, ms), slot ascending. */
let anchors: Array<[number, number]> = [SEED];

/** A pair that disagrees with what is known (time running backwards against
 *  slot, or a rate no chain has) replaces what it contradicts: the newer
 *  evidence is a real row, the older may have been a seed. */
function plausible(a: [number, number], b: [number, number]): boolean {
  const ds = b[0] - a[0];
  const dt = b[1] - a[1];
  if (ds === 0) return Math.abs(dt) <= 1_000;
  // Block times are whole seconds; allow that much slack either way.
  if (ds > 0 ? dt < -1_000 : dt > 1_000) return false;
  if (Math.abs(ds) < 5_000) return true;
  const rate = dt / ds;
  return rate > 100 && rate < 1_000;
}

export function learnAnchor(slot: number, ms: number): void {
  if (!Number.isFinite(slot) || !Number.isFinite(ms) || slot <= 0 || ms <= 0) return;
  const p: [number, number] = [slot, ms];
  anchors = anchors.filter((a) => a[0] !== slot && plausible(a, p));
  let i = anchors.findIndex((a) => a[0] > slot);
  if (i < 0) i = anchors.length;
  anchors.splice(i, 0, p);
  if (anchors.length > ANCHOR_CAP) {
    // Thin the middle, keep both ends: the ends are what extrapolation needs.
    anchors = anchors.filter((_, k) => k === 0 || k === anchors.length - 1 || k % 2 === 0);
  }
}

function learnRows(rows: TapeRow[]): void {
  if (!rows.length) return;
  // The ends of a page are enough — the rows between add nothing a straight
  // line between them does not already say.
  for (const r of [rows[0], rows[rows.length - 1]]) {
    const s = slotOf(r);
    if (s !== null && typeof r.blockTimeMs === 'number') learnAnchor(s, r.blockTimeMs);
  }
}

/** The rate to carry a moment past the known pairs at: forward, the recent
 *  rate; backward from the earliest pair, the old rate once that pair is
 *  itself from before Alpenglow. One rule for both directions of the
 *  conversion, so a slot and its moment always map back onto each other. */
function backRate(earliest: [number, number]): number {
  return edgeRate('start') ?? (earliest[1] > SEED[1] - 30 * 86_400_000 ? RECENT_SLOT_MS : PRE_ALPENGLOW_SLOT_MS);
}

/** The rate MEASURED at one end of the known pairs: from the end pair to
 *  the first one at least 50 slots in (a page's own ends can sit in the
 *  same few slots, too close to time). Null with nothing to measure — the
 *  stated rates are then all there is. Measured beats stated: the date the
 *  rate changed is not known here, so a stated rate can be wrong for a
 *  whole stretch, and every seek made with it lands short. */
function edgeRate(edge: 'start' | 'end'): number | null {
  if (anchors.length < 2) return null;
  const at = edge === 'start' ? anchors[0] : anchors[anchors.length - 1];
  const inward = edge === 'start' ? anchors : [...anchors].reverse();
  for (const b of inward) {
    const ds = Math.abs(b[0] - at[0]);
    if (ds < 50) continue;
    const rate = Math.abs(b[1] - at[1]) / ds;
    return rate > 100 && rate < 1_000 ? rate : null;
  }
  return null;
}

const forwardRate = () => edgeRate('end') ?? RECENT_SLOT_MS;

/** The slot the chain was at around `ms`, from the known pairs. */
export function estimateSlot(ms: number): number {
  let lo: [number, number] | null = null;
  let hi: [number, number] | null = null;
  for (const a of anchors) {
    if (a[1] <= ms) lo = a;
    else if (!hi) hi = a;
  }
  let s: number;
  if (lo && hi && hi[1] > lo[1]) s = lo[0] + ((ms - lo[1]) * (hi[0] - lo[0])) / (hi[1] - lo[1]);
  else if (lo) s = lo[0] + (ms - lo[1]) / forwardRate();
  else if (hi) s = hi[0] - (hi[1] - ms) / backRate(hi);
  else s = SEED[0] + (ms - SEED[1]) / RECENT_SLOT_MS;
  return Math.max(1, Math.round(s));
}

/** The time a slot fell at, from the known pairs — the inverse of the above. */
export function estimateMs(slot: number): number {
  let lo: [number, number] | null = null;
  let hi: [number, number] | null = null;
  for (const a of anchors) {
    if (a[0] <= slot) lo = a;
    else if (!hi) hi = a;
  }
  if (lo && hi && hi[0] > lo[0]) return lo[1] + ((slot - lo[0]) * (hi[1] - lo[1])) / (hi[0] - lo[0]);
  if (lo) return lo[1] + (slot - lo[0]) * forwardRate();
  if (hi) return hi[1] - (hi[0] - slot) * backRate(hi);
  return SEED[1] + (slot - SEED[0]) * RECENT_SLOT_MS;
}

/** Faster than any slot the chain has had — so a slot reckoned back at this
 *  rate is certainly EARLIER than the real one. */
const FASTEST_SLOT_MS = 100;

/**
 * A slot certainly at or before `ms`: the latest known pair no later than it
 * (a real row's slot and time), else the earliest pair carried back at a rate
 * faster than the chain has ever run. Never an estimate that could land late.
 */
export function slotSurelyBefore(ms: number): number {
  let lo: [number, number] | null = null;
  for (const a of anchors) if (a[1] <= ms) lo = a;
  if (lo) return lo[0];
  const first = anchors[0] ?? SEED;
  return Math.max(1, Math.floor(first[0] - (first[1] - ms) / FASTEST_SLOT_MS));
}

/** Slots in `ms` at the recent rate — for padding a seek. */
const slotsIn = (ms: number) => Math.ceil(ms / RECENT_SLOT_MS);

/** Test seam. */
export function _resetAnchors(seed: Array<[number, number]> = [SEED]): void {
  anchors = [...seed].sort((a, b) => a[0] - b[0]);
}

// ── Pages ─────────────────────────────────────────────────────────────

type PageSource = (path: string) => Promise<FetchResult<TapeResponse>>;
let source: PageSource = (path) => getJson<TapeResponse>('pumpswap', path);

/** Test seam: answer pages without the network. */
export function _setPageSource(fn: PageSource | null): void {
  source = fn ?? ((path) => getJson<TapeResponse>('pumpswap', path));
}

interface Page {
  rows: TapeRow[];
  trades: LaunchTrade[];
  cursor: string | null;
  ok: boolean;
  message: string;
}

/**
 * A seek key. Its slot and its time must AGREE: measured live 2026-11-01, the
 * route seeks on the key's TIME (a `before` key with a moving slot and a fixed
 * time answered the same page four times running), and the schema says the
 * slot leads — so both halves say the same moment, and whichever the server
 * reads, the seek lands there.
 */
const ordinal = (slot: number, ms: number) => `${Math.max(0, Math.floor(slot))}-0-0-${Math.max(0, Math.floor(ms))}`;
const keyAt = (slot: number) => ordinal(slot, estimateMs(slot));

async function page(mint: string, q: { cursor?: string | null; before?: string; after?: string; limit?: number }): Promise<Page> {
  const params = new URLSearchParams({ limit: String(q.limit ?? PAGE) });
  if (q.cursor) params.set('cursor', q.cursor);
  else if (q.before) params.set('before', q.before);
  else if (q.after) params.set('after', q.after);
  const r = await source(`/trades/${encodeURIComponent(SOLANA_CHAIN_ID)}/${encodeURIComponent(mint)}?${params}`);
  if (!r.ok || !r.data || !Array.isArray(r.data.trades)) {
    return { rows: [], trades: [], cursor: null, ok: false, message: r.message };
  }
  const rows = r.data.trades.filter((t) => t && typeof t === 'object' && (t.kind === undefined || t.kind === 'swap'));
  learnRows(rows);
  return {
    rows,
    trades: rows.map(normaliseTrade).filter((t): t is LaunchTrade => t !== null),
    cursor: typeof r.data.cursor === 'string' && r.data.cursor ? r.data.cursor : null,
    ok: true,
    message: 'ok',
  };
}

/**
 * The price a coin's market stood at `atMs` (2026-10-23): the newest trade
 * at or before that moment, at pump's price for it. What a copy landing at
 * `atMs` meets — the Scout's follower-fill rule (walletScout.ts
 * resolvePending), for the copy replay.
 *
 * The tape seeks by slot, so the moment is turned into one (see above) and
 * the answer is only taken once a page shows a trade AFTER `atMs` — proof the
 * seek went past the moment, so nothing between the trade and the moment was
 * skipped — or once the known pairs put the seek past it.
 *
 * Null when pump has no trade before `atMs` or the call failed — `failed`
 * says which, so a parked provider is not reported as a dead coin.
 */
export async function priceAt(mint: string, atMs: number): Promise<{ price: number; at: number } | { price: null; failed: boolean; message: string }> {
  // How far past the moment to seek. Wide while the map is unsure here, and
  // narrowed once a page has landed nearby: the pairs a page teaches put the
  // moment within a second, and on a busy coin 30 s past it is more than a
  // page of trades — every row after the moment, and the old fixed pad then
  // paged back 100 trades a call and gave up (live, 2026-11-01: a wallet's
  // best trade left unpriced).
  const near = anchors.some((a) => Math.abs(a[1] - atMs) <= 120_000);
  let padMs = near ? 3_000 : 30_000;
  let pad = slotsIn(padMs);
  let key = estimateSlot(atMs) + pad;
  let best: { price: number; at: number } | null = null;
  const newestBy = (rows: TapeRow[]) => {
    let found: { price: number; at: number } | null = null;
    for (const r of rows) {
      const at = r.blockTimeMs as number;
      if (at > atMs) continue;
      const price = rowPriceSol(r);
      if (price !== null && (found === null || at > found.at)) found = { price, at };
    }
    return found;
  };
  // What each page showed, for the message when the search gives up: the
  // rows it held and where they sat against the moment, in seconds.
  const trace: string[] = [];
  const span = (rs: TapeRow[]) =>
    rs.length ? `${rs.length} rows ${((Math.max(...rs.map((r) => r.blockTimeMs as number)) - atMs) / 1000).toFixed(0)}..${((Math.min(...rs.map((r) => r.blockTimeMs as number)) - atMs) / 1000).toFixed(0)} s` : '0 rows';
  let calls = 0;
  while (calls < PRICE_CALLS) {
    calls++;
    const p = await page(mint, { before: keyAt(key) });
    if (!p.ok) return best ?? { price: null, failed: true, message: p.message };
    const rows = p.rows.filter((r) => typeof r.blockTimeMs === 'number');
    trace.push(`before: ${span(rows)}`);
    if (!rows.length) {
      // Nothing before the key: the coin had not traded by then, or the key
      // fell short of the moment. Reading forward from it tells which — and
      // what it reads is contiguous from the coin's first trade.
      if (best) return best;
      calls++;
      const f = await page(mint, { after: keyAt(key) });
      if (!f.ok) return { price: null, failed: true, message: f.message };
      const fwd = f.rows.filter((r) => typeof r.blockTimeMs === 'number');
      trace.push(`after: ${span(fwd)}`);
      if (!fwd.length || (fwd[0].blockTimeMs as number) > atMs) return { price: null, failed: false, message: 'no trade before then' };
      const found = newestBy(fwd);
      if (found && fwd.some((r) => (r.blockTimeMs as number) > atMs)) return found;
      if (found) best = found;
      const last = slotOf(fwd[fwd.length - 1]) ?? key;
      key = Math.max(last + 1, estimateSlot(atMs) + pad);
      continue;
    }
    const later = rows.filter((r) => (r.blockTimeMs as number) > atMs);
    const found = newestBy(rows);
    if (found && (best === null || found.at > best.at)) best = found;
    // A trade after the moment on the same page: the seek passed it.
    if (found && later.length) return found;
    // Nothing at or before the moment here: the seek went too far past it.
    // The page's own rows are known pairs now, so the next estimate is close.
    if (!found) {
      padMs = Math.max(400, padMs / 15);
      pad = slotsIn(padMs);
      const oldest = Math.min(...rows.map((r) => slotOf(r) ?? Infinity));
      const next = Math.min(estimateSlot(atMs) + pad, Number.isFinite(oldest) ? oldest : key - 1);
      key = next < key ? next : key - pad;
      continue;
    }
    // Everything here is at or before the moment. Fine if the seek itself was
    // past it; otherwise trades may sit between, so seek again further on.
    if (estimateMs(key) >= atMs) return found;
    key = Math.max(key + pad, estimateSlot(atMs) + pad);
  }
  return best ?? { price: null, failed: true, message: `could not seek to that moment (${trace.join('; ')})` };
}

export interface RecentScan {
  /** OLDEST-FIRST, the order a position book has to be fed in. */
  trades: LaunchTrade[];
  /** True when the pages reached `sinceMs` or the token's first trade. */
  complete: boolean;
  calls: number;
  ok: boolean;
  message: string;
}

/**
 * A token's trades from now back to `sinceMs`, at most `maxPages` pages.
 *
 * This is the Wallet Scout's manual scan: the newest page first, then older
 * ones until a trade predates `sinceMs` or the token runs out of history. The
 * API is newest-first and so is each page, so the result is reversed once at
 * the end — a sell fed before its buy scores nothing.
 */
export async function recentTrades(mint: string, sinceMs: number, maxPages = 3): Promise<RecentScan> {
  const all: LaunchTrade[] = [];
  let cursor: string | null = null;
  let calls = 0;
  let complete = false;
  let ok = true;
  let message = 'ok';
  while (calls < maxPages) {
    calls += 1;
    const p = await page(mint, { cursor });
    if (!p.ok) {
      ok = false;
      message = p.message;
      break;
    }
    let reached = false;
    for (const t of p.trades) {
      if (t.ts < sinceMs) {
        reached = true;
        break;
      }
      all.push(t);
    }
    if (reached || !p.cursor || !p.rows.length) {
      complete = true;
      break;
    }
    cursor = p.cursor;
  }
  all.reverse();
  return { trades: all, complete, calls, ok, message };
}

export interface LaunchScan {
  trades: LaunchTrade[];
  /** True when the scan is certain it reached the token's FIRST ever trade. */
  complete: boolean;
  calls: number;
  message: string;
}

/** How far past creation the launch read keeps paging: the old route's seek
 *  point, and well past the snipe window at any slot rate. */
const LAUNCH_WINDOW_MS = 5_000;
/** A first trade later than this after creation is read as the index not
 *  reaching the launch, not as a launch (the old scan's widest seek). */
const LAUNCH_REACH_MS = 3_600_000;

/**
 * The first trades of a mint, starting at the genuine first trade.
 *
 * `complete` is the load-bearing field. Bundle detection defines the bundle as
 * "everything in the same slot as the first trade" — so if the scan did NOT
 * reach the first trade, the slot it thinks is the launch is just some slot in
 * the middle of the launch, and every cohort built on it would be wrong while
 * looking entirely plausible. The caller must refuse to report bundle numbers
 * when this is false. It is the difference between an em dash and a lie.
 *
 * The tape reads FORWARD from an `after` key, oldest first, so a key at or
 * before creation makes the first row trade #1 — nothing can trade before a
 * coin exists. The key is a slot CERTAINLY before creation (slotSurelyBefore:
 * a real row's slot, or one reckoned back faster than the chain runs); how
 * far before costs nothing, since this coin has no trades there to read.
 */
export async function launchTrades(mint: string, createdAtMs: number): Promise<LaunchScan> {
  let calls = 0;
  let key = slotSurelyBefore(createdAtMs - 60_000);
  let first: Page | null = null;
  while (calls < MAX_CALLS - 1) {
    calls++;
    // Both halves before creation: the slot surely is, and the time is the
    // earlier of its own and a minute before.
    const p = await page(mint, { after: ordinal(key, Math.min(estimateMs(key), createdAtMs - 60_000)) });
    if (!p.ok) return { trades: [], complete: false, calls, message: p.message };
    if (p.trades.length) {
      first = p;
      break;
    }
    // Nothing after the key. One unseeked call decides between a token
    // nobody ever bought and a key that landed past every trade it had (only
    // possible while the known pairs were wrong — that call corrects them).
    calls++;
    const newest = await page(mint, {});
    if (!newest.ok) return { trades: [], complete: false, calls, message: newest.message };
    if (!newest.trades.length) return { trades: [], complete: true, calls, message: 'no trades' };
    const next = slotSurelyBefore(createdAtMs - 60_000);
    if (next >= key) return { trades: [], complete: false, calls, message: 'the trade index does not reach this launch' };
    key = next;
  }
  if (!first) return { trades: [], complete: false, calls, message: 'could not seek to the launch' };

  const all = [...first.trades];
  const firstAt = all[0].ts;
  // Measured 2026-08-24 on the old route: a 919-day-old token's launch was
  // past the index while it still served this month's trades. A first row an
  // hour or more after creation is that, not a launch — never dressed up as a
  // bundle verdict.
  if (firstAt - createdAtMs > LAUNCH_REACH_MS) {
    return { trades: [], complete: false, calls, message: 'the trade index does not reach this launch' };
  }

  // A busy launch: keep reading forward while the page is still inside the
  // launch window.
  const seen = new Set(first.rows.map((r) => r.ordinalKey).filter(Boolean));
  let cursor = first.cursor;
  while (cursor && calls < MAX_CALLS && all[all.length - 1].ts <= firstAt + LAUNCH_WINDOW_MS) {
    calls++;
    const p = await page(mint, { cursor });
    if (!p.ok) break;
    const fresh = p.rows.filter((r) => r.ordinalKey && !seen.has(r.ordinalKey));
    if (!fresh.length) break;
    for (const r of fresh) seen.add(r.ordinalKey);
    all.push(...fresh.map(normaliseTrade).filter((t): t is LaunchTrade => t !== null));
    cursor = p.cursor;
  }
  return { trades: all, complete: true, calls, message: 'ok' };
}

// ── Candles ───────────────────────────────────────────────────────────
//
// MEASURED 2026-10-01: pump.fun serves OHLC for a coin still on its bonding
// curve, from its first trade — a coin two minutes old already had its 1m
// bars. No chart provider indexes a curve, so before this a curve coin's
// chart was only ever our own tape, and the tape records a coin only while its
// page is open: a script's buy, or an AI asking for the chart, got no bars at
// all (user report 2026-10-01, three of five trades). A graduated coin's
// series runs across the migration.
//
// Route (2026-11-01, the old swap-api `/v1/coins/{mint}/candles` is a 404):
// `GET /candles/{chainId}/{address}?res=&count=&measure=price_usd`, oldest
// first, `count` at most 300, `openTimeMs` in ms, every number a string,
// `volumeUsd`. Widths: 1s, 15s, 30s, 1m, 5m, 15m, 1h, 4h, 1d — no 5s, which is
// built here from 1s. A seconds width older than its 7-day retention is
// served at 1m.

const CANDLE_INTERVAL: Partial<Record<CandleInterval, string>> = {
  '1s': '1s',
  '5s': '1s',
  '15s': '15s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
};

const CANDLE_LIMIT_MAX = 300;

export function candlesSupported(interval: CandleInterval): boolean {
  return CANDLE_INTERVAL[interval] !== undefined;
}

/** The route's rows as chart candles: seconds, numbers, oldest first, one
 *  per bucket. A row with any price missing or non-positive is dropped —
 *  never drawn as a zero. Reads the current row names (`openTimeMs`,
 *  `volumeUsd`) and the old ones (`timestamp`, `volume`). */
export function parseCandles(rows: unknown[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const x of rows) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const ts = Number(r.openTimeMs ?? r.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const [open, high, low, close] = [r.open, r.high, r.low, r.close].map(Number);
    if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;
    const volume = Number(r.volumeUsd ?? r.volume);
    const time = Math.floor(ts > 1e12 ? ts / 1000 : ts);
    byTime.set(time, { time, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Wider buckets from narrower ones (5s from the route's 1s). Input oldest
 *  first; open from the first row in a bucket, close from the last. */
export function rebucket(rows: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const time = Math.floor(r.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, r.high);
      last.low = Math.min(last.low, r.low);
      last.close = r.close;
      last.volume += r.volume;
    } else {
      out.push({ ...r, time });
    }
  }
  return out;
}

/**
 * pump.fun's candles for a mint, in USD (the unit every other chart provider
 * answers in, so the merge with the tape converts exactly as it does for
 * them). Null when the route refused; an EMPTY array when it answered with
 * nothing (a coin seconds old is not indexed yet) — kept for the same TTL,
 * so a chart polling every second does not re-ask for nothing every second.
 *
 * Never `priority`: a chart is not the trade path, and this provider's pace
 * is shared with the Scout and the replay. The memo is what keeps a chart's
 * 1-5 s poll from re-asking: one request per few seconds at most, whatever
 * polls.
 */
export async function candles(mint: string, interval: CandleInterval, limit = 500): Promise<Candle[] | null> {
  const iv = CANDLE_INTERVAL[interval];
  if (!iv) return null;
  const five = interval === '5s';
  const want = Math.max(1, Math.min(CANDLE_LIMIT_MAX, five ? limit * 5 : limit));
  const subMinute = interval === '1s' || interval === '5s' || interval === '15s';
  const ttl = subMinute ? 5_000 : interval === '1m' ? 15_000 : 60_000;
  return memo<Candle[]>(`ps:candles:${mint}:${interval}:${want}`, ttl, async () => {
    const q = new URLSearchParams({ res: iv, count: String(want), measure: 'price_usd' });
    const r = await getJson<{ candles?: unknown[] }>('pumpswap', `/candles/${encodeURIComponent(SOLANA_CHAIN_ID)}/${encodeURIComponent(mint)}?${q}`);
    if (!r.ok || !r.data || !Array.isArray(r.data.candles)) return null;
    const rows = parseCandles(r.data.candles);
    const out = five ? rebucket(rows, 5) : rows;
    return out.slice(-limit);
  });
}
