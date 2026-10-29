// Chain pricing (2026-10-24): what a copy would have paid and got, read from
// the chain itself rather than from pump's swap API.
//
// The copy replay used to price every leg with swap-api: Chromium only
// (Cloudflare challenges Node's fetch), one call per 2 s, and a 60–90 s park
// on a 429. A busy wallet's week ran past two hours without finishing
// (docs/copy-candidates-2026-10-24.md). Here one Helius
// `getTransactionsForAddress` on the COIN, filtered to a slot window, returns
// its trades in order; the price after the last trade at or before the
// follower's slot is the fill — pump's TradeEvent carries the curve's virtual
// reserves, PumpSwap's swap event its executed price.
//
// The follower's moment is a SLOT, not a second: their slot + LAG_SLOTS (the
// board's 2 s lag at Alpenglow's ~211.6 ms slots). Block times are whole
// seconds, and a pump coin can move hard inside one — pricing by the second
// put single trips ±70 points off; by the slot, the median trip agrees with
// swap-api to the point (26 trips, 10-24).
//
// Credits: 10 per call whatever it returns up to a hundred, so one call reads
// FORWARD from their buy and usually answers both legs; a second is asked
// only when the exit lies past that page. Answers are cached on disk, so a
// replay run again — or a wallet checked twice — costs nothing for trips
// already priced. The caller keeps the spend inside the backtest allowance
// and falls back to swap-api when it is spent (shared/credits.ts).

import fs from 'node:fs';
import path from 'node:path';
import { addressTxCredits, getTransactionsForAddress, resolveAccountKeys, type RawTransaction, type TokenBalanceEntry } from '../chain/rpcClient';
import { base58Decode } from '../chain/base58';
import { decodeCpiEventData, decodeLogsEx, foldPostComplete, PUMP_PROGRAM_ID, type PumpEvent } from './pumpDecoder';
import { coinSwapView, decodeCpiAmmEventData, invertedSwapView, type AmmSwapEvent, type CoinSwapView } from './ammDecoder';
import { FOLLOWER_LAG_MS } from '@shared/walletScore';
import { REPLAY_TRIP_CREDITS_MAX, type MintBirth } from '@shared/copyReplay';

const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
/** Alpenglow's measured slot time (txBuilder.ts). */
export const SLOT_MS = 211.6;
/** The board's follower lag, in slots: 2 s ≈ 9 slots. */
export const LAG_SLOTS = Math.round(FOLLOWER_LAG_MS / SLOT_MS);
/** Forward page from their buy: one call, the same 10 credits as one trade. */
const FORWARD_PAGE = 100;
/** Backward look for a leg the forward page did not reach. */
const BACK_PAGE = 25;
/** The most one trip can cost: two calls. The caller reserves this much of
 *  the allowance before asking. */
export const MAX_CREDITS_PER_TRIP = REPLAY_TRIP_CREDITS_MAX;
const CACHE_CAP = 20_000;

/** One trade on the coin inside a transaction, as the coin sees it. */
export interface TxTrade {
  user: string;
  isBuy: boolean;
  /** SOL and whole tokens moved — the same basis the live feed gives the
   *  Scout (pump: the event's sol_amount; PumpSwap: coinSwapView). */
  sol: number;
  tokens: number;
  /** The coin's price after it, SOL per whole token. */
  price: number;
}

/**
 * Every trade on `mint` in this transaction, in order. Pump curve trades from
 * the CPI events (a curve-completing buy folded whole, as the feed books it),
 * or from the logs for older coins; PumpSwap swaps only on THIS coin's pool —
 * a routed transaction swaps other coins' pools too.
 */
export function tradesOfTx(tx: RawTransaction, mint: string): TxTrade[] {
  const keys = resolveAccountKeys(tx);
  const curve: PumpEvent[] = [];
  const out: TxTrade[] = [];
  for (const ix of (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)) {
    const prog = keys[ix.programIdIndex];
    if (prog !== PUMP_PROGRAM_ID && prog !== PUMP_AMM) continue;
    let raw: Buffer;
    try {
      raw = Buffer.from(base58Decode(ix.data));
    } catch {
      continue;
    }
    if (prog === PUMP_PROGRAM_ID) {
      const ev = decodeCpiEventData(raw);
      if (ev) curve.push(ev);
      continue;
    }
    const ev = decodeCpiAmmEventData(raw);
    if (ev?.kind !== 'amm_swap') continue;
    const v = ammView(tx, ev, mint);
    if (v && v.priceSol > 0 && Number.isFinite(v.priceSol)) out.push({ user: ev.user, isBuy: v.isBuy, sol: v.sol, tokens: v.tokens, price: v.priceSol });
  }
  // Older coins still log the event instead of emitting it by CPI.
  const events = curve.length ? foldPostComplete(curve) : decodeLogsEx(tx.meta?.logMessages ?? []).events;
  const fromCurve: TxTrade[] = [];
  for (const ev of events) {
    if (ev.kind !== 'trade' || ev.mint !== mint || !(ev.virtualTokenReserves > 0n)) continue;
    fromCurve.push({
      user: ev.user,
      isBuy: ev.isBuy,
      sol: Number(ev.solAmount) / 1e9,
      tokens: Number(ev.tokenAmount) / 1e6,
      price: curvePrice(ev.virtualSolReserves, ev.virtualTokenReserves),
    });
  }
  // A coin trades on the curve or on its pool, never both in one
  // transaction (the completing buy's pool part is folded above).
  return fromCurve.length ? fromCurve : out;
}

/** The coin's price after the LAST trade on it in this transaction, SOL per
 *  whole token, or null when the transaction traded nothing of it. */
export function priceOfTx(tx: RawTransaction, mint: string): number | null {
  const t = tradesOfTx(tx, mint);
  return t.length ? t[t.length - 1].price : null;
}

/** How far `owner`'s balance of `mint` moved in this transaction (raw units),
 *  or null when the transaction did not list it. */
function balanceMove(tx: RawTransaction, owner: string, mint: string): bigint | null {
  const at = (rows: TokenBalanceEntry[] | undefined): Map<number, bigint> => {
    const m = new Map<number, bigint>();
    for (const b of rows ?? []) if (b.owner === owner && b.mint === mint) m.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    return m;
  };
  const pre = at(tx.meta?.preTokenBalances);
  const post = at(tx.meta?.postTokenBalances);
  if (!pre.size && !post.size) return null;
  let d = 0n;
  for (const i of new Set([...pre.keys(), ...post.keys()])) d += (post.get(i) ?? 0n) - (pre.get(i) ?? 0n);
  return d < 0n ? -d : d;
}

/**
 * A PumpSwap swap as `mint` sees it, or null when the swap was on another
 * coin's pool. Graduation pools hold the coin as base; a WSOL/coin pool
 * (anyone can make one) reports it upside down. Told apart exactly: in a
 * coin/WSOL pool the pool's coin balance moves by `baseAmount`, in an
 * inverted one its WSOL balance does.
 */
export function ammView(tx: RawTransaction, ev: AmmSwapEvent, mint: string): CoinSwapView | null {
  const coinMove = balanceMove(tx, ev.pool, mint);
  if (coinMove === null) return null;
  if (coinMove !== ev.baseAmount && balanceMove(tx, ev.pool, WSOL) === ev.baseAmount) return invertedSwapView(ev);
  return coinSwapView(ev);
}

/** SOL per whole token from pump's virtual reserves (lamports, 6-decimal base). */
function curvePrice(vSol: bigint, vTokens: bigint): number {
  return Number(vSol) / 1e9 / (Number(vTokens) / 1e6);
}

export interface TripPrice {
  ok: boolean;
  entry: number | null;
  exit: number | null;
  calls: number;
  /** Helius credits these calls cost (already metered as HTTP by the read). */
  credits: number;
  cached: boolean;
  /** Why a read failed; '' when it did not. */
  message: string;
  /** The read was refused (not on this plan): stop asking the chain. */
  refused?: boolean;
}

export interface ChainPriceDeps {
  read: typeof getTransactionsForAddress;
}
const realDeps: ChainPriceDeps = { read: getTransactionsForAddress };

// ── cache ────────────────────────────────────────────────────────────────

const cache = new Map<string, { entry: number | null; exit: number | null }>();
let cacheFile = '';
let saveTimer: NodeJS.Timeout | null = null;

/** Load the on-disk cache. Without it the cache lives for the session only. */
export function init(userDataDir: string): void {
  cacheFile = path.join(userDataDir, 'chain-prices.json');
  try {
    const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Array<[string, number | null, number | null]>;
    for (const [k, entry, exit] of rows) if (typeof k === 'string') cache.set(k, { entry, exit });
  } catch {
    /* none yet */
  }
  birthFile = path.join(userDataDir, 'chain-births.json');
  try {
    const rows = JSON.parse(fs.readFileSync(birthFile, 'utf8')) as Array<[string, MintBirth]>;
    for (const [k, b] of rows) if (typeof k === 'string' && b && typeof b.slot === 'number') births.set(k, b);
  } catch {
    /* none yet */
  }
}

function remember(key: string, v: { entry: number | null; exit: number | null }): void {
  cache.delete(key);
  cache.set(key, v);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(cacheFile, JSON.stringify([...cache].map(([k, v]) => [k, v.entry, v.exit])), 'utf8');
    } catch {
      /* a read-only profile must not break a replay */
    }
  }, 2_000);
  saveTimer.unref?.();
}

// ── pricing ──────────────────────────────────────────────────────────────

type Tx = RawTransaction & { signature: string; transactionIndex?: number };

const order = (a: Tx, b: Tx): number => (a.slot ?? 0) - (b.slot ?? 0) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0);

/** The price after the last trade at or before `slot` in an ascending page. */
function lastAtOrBefore(txs: Tx[], mint: string, slot: number): number | null {
  let p: number | null = null;
  for (const tx of txs) {
    if ((tx.slot ?? Infinity) > slot) break;
    const q = priceOfTx(tx, mint);
    if (q !== null) p = q;
  }
  return p;
}

/**
 * A copy of one trip: bought LAG_SLOTS after their opening buy's slot, sold
 * LAG_SLOTS after their closing sell's. One call when the forward page from
 * their buy reaches past the exit; two otherwise.
 */
export async function priceTrip(httpUrl: string, mint: string, openSlot: number, closeSlot: number, deps: ChainPriceDeps = realDeps): Promise<TripPrice> {
  const r = await priceTripLags(httpUrl, mint, openSlot, closeSlot, [LAG_SLOTS], deps);
  const leg = r.at[LAG_SLOTS] ?? { entry: null, exit: null };
  return { ok: r.ok, entry: leg.entry, exit: leg.exit, calls: r.calls, credits: r.credits, cached: r.cached, message: r.message, ...(r.refused ? { refused: true } : {}) };
}

export interface TripPriceLags {
  ok: boolean;
  /** Per lag (slots after theirs): the copy's two fills. A lag the read
   *  could not finish is absent. */
  at: Record<number, { entry: number | null; exit: number | null }>;
  calls: number;
  credits: number;
  /** Every lag came from the cache. */
  cached: boolean;
  message: string;
  refused?: boolean;
}

/**
 * The same trip copied at several lags at once (2026-10-25, P1: the
 * pre-registered test's 0–9 slot ablation). One forward page serves every
 * lag's entry and exit that it reaches; a back page is read per leg it does
 * not. Each lag's answer is cached under the key `priceTrip` uses, so the
 * two share one cache and a lag already priced costs nothing.
 */
export async function priceTripLags(httpUrl: string, mint: string, openSlot: number, closeSlot: number, lags: readonly number[], deps: ChainPriceDeps = realDeps): Promise<TripPriceLags> {
  const at: TripPriceLags['at'] = {};
  const want: number[] = [];
  for (const lag of [...new Set(lags)]) {
    const hit = cache.get(`${mint}:${openSlot + lag}:${closeSlot + lag}`);
    if (hit) at[lag] = { ...hit };
    else want.push(lag);
  }
  if (!want.length) return { ok: true, at, calls: 0, credits: 0, cached: true, message: '' };
  let calls = 0;
  let credits = 0;
  const fail = (message: string, refused?: boolean): TripPriceLags => ({ ok: false, at, calls, credits, cached: false, message, ...(refused ? { refused } : {}) });

  const fwd = await deps.read(httpUrl, mint, { limit: FORWARD_PAGE, slot: { gte: openSlot }, sortOrder: 'asc' });
  calls += 1;
  if (!fwd.ok || !fwd.data) return fail(fwd.message, fwd.refused);
  credits += addressTxCredits(fwd.data.txs.length);
  const page = [...fwd.data.txs].sort(order);
  // A short page is everything up to now; a full one may stop anywhere.
  const complete = page.length < FORWARD_PAGE;
  const lastSlot = page.length ? (page[page.length - 1].slot ?? 0) : 0;
  const reaches = (slot: number): boolean => complete || lastSlot > slot;

  // Back pages, one per leg slot the forward page does not reach — and a
  // page read for one slot answers every smaller slot it reaches down to.
  const backPages: Array<{ lte: number; txs: Tx[]; floor: number }> = [];
  const back = async (slot: number): Promise<number | null | false> => {
    const have = backPages.find((p) => p.lte >= slot && p.floor <= slot);
    const txs = have ? have.txs : null;
    let rows: Tx[];
    if (txs) rows = txs;
    else {
      const r = await deps.read(httpUrl, mint, { limit: BACK_PAGE, slot: { lte: slot }, sortOrder: 'desc' });
      calls += 1;
      if (!r.ok || !r.data) return false;
      credits += addressTxCredits(r.data.txs.length);
      rows = [...r.data.txs].sort(order);
      // A short page reaches back to the coin's first trade.
      const floor = rows.length < BACK_PAGE ? 0 : (rows[0]?.slot ?? slot);
      backPages.push({ lte: slot, txs: rows, floor });
    }
    return lastAtOrBefore(rows, mint, slot);
  };

  for (const lag of want.sort((a, b) => b - a)) {
    const entrySlot = openSlot + lag;
    const exitSlot = closeSlot + lag;
    let entry: number | null;
    if (reaches(entrySlot)) entry = lastAtOrBefore(page, mint, entrySlot);
    else {
      // More than a page of trades inside 2 s of their buy: read back from it.
      const b = await back(entrySlot);
      if (b === false) return fail('the chain read stopped');
      entry = b;
    }
    let exit: number | null;
    if (reaches(exitSlot)) exit = lastAtOrBefore(page, mint, exitSlot);
    else {
      const b = await back(exitSlot);
      if (b === false) return fail('the chain read stopped');
      exit = b;
    }
    at[lag] = { entry, exit };
    remember(`${mint}:${entrySlot}:${exitSlot}`, { entry, exit });
  }
  return { ok: true, at, calls, credits, cached: false, message: '' };
}

// ── a coin's recent trades (the Scout scan) ─────────────────────────────

/** Transactions per page; Helius caps full transactions at 100 a call. */
const SCAN_PAGE = 100;

// ── A coin's birth (2026-10-25) ───────────────────────────────────────────
//
// The coin's FIRST transaction is its launch: pump's `create` makes the mint
// in it, and any buy in the same transaction is the launcher's own. One
// ascending page of five on the mint gives its slot, its position in the
// block and who paid for it — what the replay's sniper and launch-bundle
// checks compare a wallet's opening buy against. Ten credits a coin, once:
// a birth never changes, so it is kept on disk for good.

const births = new Map<string, MintBirth>();
let birthFile = '';
let birthTimer: NodeJS.Timeout | null = null;
const BIRTH_CAP = 50_000;

function rememberBirth(mint: string, b: MintBirth): void {
  births.delete(mint);
  births.set(mint, b);
  while (births.size > BIRTH_CAP) {
    const oldest = births.keys().next().value;
    if (oldest === undefined) break;
    births.delete(oldest);
  }
  if (!birthFile || birthTimer) return;
  birthTimer = setTimeout(() => {
    birthTimer = null;
    try {
      fs.writeFileSync(birthFile, JSON.stringify([...births]), 'utf8');
    } catch {
      /* a read-only profile must not break a check */
    }
  }, 2_000);
  birthTimer.unref?.();
}

export interface BirthRead {
  ok: boolean;
  birth: MintBirth | null;
  calls: number;
  credits: number;
  cached: boolean;
  message: string;
  refused?: boolean;
}

/** The coin's first transaction, from the chain or the cache. */
export async function mintBirth(httpUrl: string, mint: string, deps: ChainPriceDeps = realDeps): Promise<BirthRead> {
  const hit = births.get(mint);
  if (hit) return { ok: true, birth: hit, calls: 0, credits: 0, cached: true, message: 'cached' };
  const r = await deps.read(httpUrl, mint, { limit: 5, sortOrder: 'asc' });
  if (!r.ok || !r.data) return { ok: false, birth: null, calls: 1, credits: r.refused ? 0 : 10, cached: false, message: r.message, refused: r.refused };
  const txs = [...(r.data.txs as Tx[])].sort(order);
  const first = txs.find((t) => typeof t.slot === 'number' && t.slot > 0);
  const credits = addressTxCredits(txs.length);
  if (!first) return { ok: true, birth: null, calls: 1, credits, cached: false, message: 'no transactions on this coin' };
  const birth: MintBirth = {
    slot: first.slot as number,
    index: typeof first.transactionIndex === 'number' ? first.transactionIndex : 0,
    tx: first.signature,
    creator: first.transaction?.message?.accountKeys?.[0] ?? null,
  };
  rememberBirth(mint, birth);
  return { ok: true, birth, calls: 1, credits, cached: false, message: 'ok' };
}

export interface ChainTrade {
  user: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  /** Epoch ms of the block. */
  ts: number;
  /** The transaction's signature. */
  tx: string;
  /** The trader signed the transaction (2026-10-27). False when the event
   *  names an account that did not — a program's vault trading by CPI —
   *  which the wallet reader refuses too, so a copy could never follow it.
   *  Absent when the read could not tell. */
  signer?: boolean;
}

export interface ChainScan {
  /** OLDEST-FIRST, the order a position book has to be fed in. */
  trades: ChainTrade[];
  /** True when the pages reached `sinceMs` or the coin's first trade. */
  complete: boolean;
  calls: number;
  credits: number;
  ok: boolean;
  message: string;
  refused?: boolean;
}

/**
 * A coin's trades from now back to `sinceMs`, at most `maxPages` pages of a
 * hundred transactions — the swap API's `recentTrades`, read from the chain
 * (2026-10-24): a page every few hundred ms instead of every 2 s, no parks,
 * and every trade in a transaction, not one row per signature.
 */
export async function recentTrades(httpUrl: string, mint: string, sinceMs: number, maxPages: number, deps: ChainPriceDeps = realDeps): Promise<ChainScan> {
  const newestFirst: ChainTrade[] = [];
  let token: string | null = null;
  let calls = 0;
  let credits = 0;
  while (calls < maxPages) {
    const r = await deps.read(httpUrl, mint, { limit: SCAN_PAGE, sinceSec: sinceMs / 1000, paginationToken: token });
    calls += 1;
    if (!r.ok || !r.data) {
      return { trades: newestFirst.reverse(), complete: false, calls, credits, ok: false, message: r.message, refused: r.refused };
    }
    credits += addressTxCredits(r.data.txs.length);
    // Newest first; inside a transaction, its own order — reversed at the end.
    for (const tx of [...r.data.txs].sort((a, b) => order(b, a))) {
      const at = typeof tx.blockTime === 'number' && tx.blockTime > 0 ? tx.blockTime * 1000 : null;
      if (at === null || at < sinceMs) continue;
      const ts = tradesOfTx(tx, mint);
      if (!ts.length) continue;
      // Who signed: the first `numRequiredSignatures` account keys.
      const keys = resolveAccountKeys(tx);
      const signers = tx.transaction?.message?.header?.numRequiredSignatures ?? 0;
      for (let i = ts.length - 1; i >= 0; i--) {
        const idx = keys.indexOf(ts[i].user);
        newestFirst.push({ user: ts[i].user, isBuy: ts[i].isBuy, sol: ts[i].sol, tokens: ts[i].tokens, ts: at, tx: tx.signature, signer: idx >= 0 && idx < signers });
      }
    }
    token = r.data.paginationToken;
    if (!token || r.data.txs.length < SCAN_PAGE) return { trades: newestFirst.reverse(), complete: true, calls, credits, ok: true, message: 'ok' };
  }
  return { trades: newestFirst.reverse(), complete: false, calls, credits, ok: true, message: 'ok' };
}

/** Test seam. */
export function _reset(): void {
  cache.clear();
  cacheFile = '';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  births.clear();
  birthFile = '';
  if (birthTimer) clearTimeout(birthTimer);
  birthTimer = null;
}
