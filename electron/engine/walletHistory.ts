// Wallet history — a Solana wallet's recent swaps, read straight from the
// chain into the Scout's record, for an address the feed has never seen.
//
// The Scout learns wallets from the pump curve firehose and from the manual
// scan, and the scan reads swap-api.pump.fun's per-TOKEN pages. Neither can
// answer "what did THIS wallet do?" for an address a user pastes in cold:
// pump's API has no per-wallet route (both candidates 404, 2026-09-11), and
// its per-token route is paced at one request every 2 s by a Cloudflare rule
// (measured 2026-09-21). The chain can. `getSignaturesForAddress` lists what
// a wallet signed, `getTransaction` reads each one, and walletSwap.ts decodes
// the swap from the wallet's own balance deltas — the same decoder the copier
// trusts for a followed wallet, so a trade read here and a trade watched live
// are the same trade by the same rules.
//
// What it fills in, and what it cannot. The wallet's OWN record — trips,
// profit, win rate, median hold, the too-fast flag: "what they did". The Copy
// score needs OTHER wallets' prints on those coins to place a follower's
// fills, which only the live feed and the scan supply; this read leaves it
// unmeasured rather than invented, and the drawer says so.
//
// Bounded: at most WALLET_READ_LIMIT signatures, nothing older than
// READ_MAX_AGE_MS, read in batches of BATCH through rpcClient's per-method
// budget. On the free public RPC that budget is 10 transactions per ~10 s,
// so 200 took 225 s (measured 2026-10-23). With a Helius endpoint the deep
// read (readDeep) gets the transactions themselves, a hundred a call, up to
// DEEP_READ_LIMIT over DEEP_DAYS — seconds, not minutes.
// Oldest first, always: a sell only scores against a buy already on the
// book. Every trade carries its signature as its id, so a second read, or the
// live feed having already seen the trade, is a duplicate and never a double
// count. One job per wallet; spends nothing.

import { getSignaturesForAddress, getTransactions, getTransactionsForAddress, isHeliusRpc, rpcParkRemainingMs, type RawTransaction } from '../chain/rpcClient';
import { decodeWalletSwap } from './walletSwap';
import * as walletScout from './walletScout';
import { WALLET_READ_LIMIT, neverSignsFrom, tradeId, type WalletReadStatus } from '@shared/walletScout';
import { REPLAY_WEEK_READ_LIMIT, type ReplaySwap } from '@shared/copyReplay';

export const READ_MAX_AGE_MS = 7 * 24 * 3_600_000;
/**
 * The deep read with a Helius endpoint (2026-10-23, readDeep): up to this
 * many transactions, as far back as this — the board's month window. About
 * 100 Helius credits at the cap. A key whose plan refuses the method is
 * read the standard way, and not asked again for DEEP_REFUSED_MS.
 */
export const DEEP_READ_LIMIT = 1_000;
export const DEEP_DAYS = 30;
const DEEP_MAX_AGE_MS = DEEP_DAYS * 24 * 3_600_000;
const DEEP_PAGE = 100;
const DEEP_REFUSED_MS = 3_600_000;
let deepRefusedUntil = 0;
/** Transactions per `getTransactions` batch. Helius counts each element
 *  against its cap and rpcClient budgets the batch at its real cost. */
const BATCH = 10;
/** A wallet needs this many trades before the store keeps a record of it
 *  (walletScout PROMOTE_AFTER). Stated here so the status can say why a
 *  quiet wallet still shows nothing after a read. */
const PROMOTE_AFTER = 3;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const jobs = new Map<string, WalletReadStatus>();
/**
 * The swaps the last read of a wallet decoded, oldest first (2026-10-23):
 * the copy replay (copyReplay.ts) prices a copy of each of their trips from
 * these, so a replay right after a read costs no second read. The newest
 * MAX_KEPT wallets only.
 */
const swapsKept = new Map<string, ReplaySwap[]>();
const MAX_KEPT = 20;

/** The swaps the last finished read of `address` decoded, or null. */
export function swapsOf(address: string): ReplaySwap[] | null {
  const s = swapsKept.get(address);
  return s && !running.has(address) ? [...s] : null;
}
const running = new Map<string, Promise<void>>();
const cancels = new Set<string>();

/** Where this module's lines go — see the note in scoutScan.ts. */
type Log = (level: 'info' | 'warn' | 'error', line: string) => void;
let log: Log = () => {};
export function attachLog(fn: Log): void {
  log = fn;
}

function fresh(address: string): WalletReadStatus {
  return {
    chain: 'solana',
    address,
    running: false,
    startedAt: null,
    finishedAt: null,
    signatures: 0,
    read: 0,
    swaps: 0,
    fed: 0,
    duplicates: 0,
    unreadable: 0,
    notSwap: 0,
    unsigned: 0,
    calls: 0,
    cancelled: false,
    message: '',
    oldestAt: null,
    newestAt: null,
  };
}

export function status(address: string): WalletReadStatus {
  return { ...(jobs.get(address) ?? fresh(address)) };
}

export function isRunning(address: string): boolean {
  return running.has(address);
}

/** Ask a running read to stop after its current batch. Idempotent. */
export function cancel(address: string): boolean {
  if (!running.has(address)) return false;
  cancels.add(address);
  return true;
}

/**
 * Start a read. Returns at once; `wait` resolves when it is done. One per
 * wallet — a second request while one runs is refused, not queued.
 */
/** How deep a read goes (2026-10-28). Absent = the usual 1,000 over 30
 *  days; a week check asks for more transactions over fewer days. */
export interface ReadOpts {
  limit?: number;
  days?: number;
}

export function start(address: string, httpUrl: string, now = Date.now(), opts: ReadOpts = {}): { ok: boolean; message: string } {
  if (!BASE58.test(address)) return { ok: false, message: 'Not a Solana wallet address' };
  if (!httpUrl) return { ok: false, message: 'No Solana RPC endpoint is configured' };
  if (running.has(address)) return { ok: false, message: 'Already reading this wallet' };
  const st = fresh(address);
  st.running = true;
  st.startedAt = now;
  st.depth = Math.max(1, Math.min(REPLAY_WEEK_READ_LIMIT, Math.floor(opts.limit ?? DEEP_READ_LIMIT)));
  st.days = Math.max(1, Math.min(DEEP_DAYS, opts.days ?? DEEP_DAYS));
  jobs.set(address, st);
  cancels.delete(address);
  swapsKept.delete(address);
  swapsKept.set(address, []);
  while (swapsKept.size > MAX_KEPT) {
    const oldest = swapsKept.keys().next().value;
    if (oldest === undefined) break;
    swapsKept.delete(oldest);
  }
  log('info', `wallet read ${address.slice(0, 6)}…: asking the chain for its last ${WALLET_READ_LIMIT} transactions`);
  const p = run(address, httpUrl, st, now).finally(() => running.delete(address));
  running.set(address, p);
  return { ok: true, message: 'started' };
}

/**
 * Does the last finished read of `address` hold every swap since `sinceMs`
 * (2026-10-28)? True when it was not cut short at its cap, or when its
 * oldest swap is already older than `sinceMs`. The standard read (a week,
 * 200 transactions) counts as covering when it was not cut short either —
 * it is all a keyless install can read.
 */
export function covers(address: string, sinceMs: number): boolean {
  const st = jobs.get(address);
  if (!st || st.running || st.finishedAt === null) return false;
  // Transactions that could not be read may hold trades of the window: a
  // read with holes covers nothing (2026-10-28 — a rate-limited read lost
  // 109 of 169 and was still called a whole week).
  if (st.unreadable > 0) return false;
  const reachedBack = st.oldestAt !== null && st.oldestAt <= sinceMs;
  const days = st.via === 'helius' ? (st.days ?? DEEP_DAYS) * 24 * 3_600_000 : READ_MAX_AGE_MS;
  const reach = st.startedAt !== null ? st.startedAt - days : Infinity;
  if (reach > sinceMs && !reachedBack) return false;
  // Not cut short (the listing or the pages ran out before the limit), or
  // its oldest swap is already past the window's start.
  return !st.truncated || reachedBack;
}

/** Resolves when the wallet's read finishes; immediately when none is running. */
export function wait(address: string): Promise<void> {
  return running.get(address) ?? Promise.resolve();
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Clear what a refused deep read counted, before the standard path runs. */
function resetCounts(st: WalletReadStatus, address: string): void {
  Object.assign(st, { signatures: 0, read: 0, swaps: 0, fed: 0, duplicates: 0, unreadable: 0, notSwap: 0, unsigned: 0, message: '', oldestAt: null, newestAt: null });
  swapsKept.set(address, []);
}

/** One transaction into the record, counted on `st`. */
function feedOne(address: string, st: WalletReadStatus, tx: RawTransaction, signature: string, listedBlockTime: number | null | undefined, now: number, txIndex?: number): void {
  const swap = decodeWalletSwap(tx, address);
  if (!swap) {
    st.notSwap += 1;
    if (movedUnsigned(tx, address)) st.unsigned = (st.unsigned ?? 0) + 1;
    return;
  }
  st.swaps += 1;
  // When they traded, from the block — the listing's time when the
  // transaction lost its own, the read's clock only as a last resort.
  const blockTime = typeof tx.blockTime === 'number' && tx.blockTime > 0 ? tx.blockTime : listedBlockTime;
  const at = typeof blockTime === 'number' && blockTime > 0 ? blockTime * 1_000 : now;
  // The slot rides along: the copy replay prices a follower's lag from it.
  const slot = typeof tx.slot === 'number' && tx.slot > 0 ? tx.slot : undefined;
  // The transaction, its block position and who paid its fee (the first
  // account): the replay's wash-trade, shared-payer and launch-bundle checks
  // (2026-10-25) read them, at no cost beyond this read.
  const payer = tx.transaction.message.accountKeys[0];
  swapsKept.get(address)?.push({
    mint: swap.mint,
    isBuy: swap.isBuy,
    sol: swap.sol,
    tokens: swap.tokens,
    at,
    tx: signature,
    ...(slot !== undefined ? { slot } : {}),
    ...(typeof txIndex === 'number' ? { txIndex } : {}),
    ...(payer && payer !== address ? { payer } : {}),
  });
  st.oldestAt = st.oldestAt === null ? at : Math.min(st.oldestAt, at);
  st.newestAt = st.newestAt === null ? at : Math.max(st.newestAt, at);
  // `history`: this wallet's own trades are the only prints this read
  // sees, so they must not price its follower (2026-10-22 — they did,
  // which filled a copy at the leader's own next price).
  const r = walletScout.note('solana', address, swap.mint, swap.isBuy, swap.sol, swap.tokens, at, tradeId(signature, swap.mint, address, swap.isBuy), true);
  if (r === 'noted') st.fed += 1;
  else if (r === 'duplicate') st.duplicates += 1;
}

/**
 * Its tokens moved in this transaction, and it did not sign it (2026-10-28):
 * the shape of an account inside someone else's trade — a pool's vault, a
 * router's or market maker's account — rather than a trader's own swap.
 * Signers are always among the static keys, first in the list.
 */
function movedUnsigned(tx: RawTransaction, address: string): boolean {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!msg || !meta || meta.err) return false;
  const signers = msg.accountKeys.slice(0, Math.max(0, msg.header?.numRequiredSignatures ?? 0));
  if (signers.includes(address)) return false;
  const amounts = new Map<string, bigint>();
  for (const b of meta.preTokenBalances ?? []) if (b.owner === address) amounts.set(`${b.accountIndex}`, -BigInt(b.uiTokenAmount?.amount ?? '0'));
  for (const b of meta.postTokenBalances ?? []) {
    if (b.owner !== address) continue;
    const k = `${b.accountIndex}`;
    amounts.set(k, (amounts.get(k) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? '0'));
  }
  for (const v of amounts.values()) if (v !== 0n) return true;
  return false;
}

/** Why a read that finished shows little, in words. */
function explainQuiet(st: WalletReadStatus, span: string): void {
  if (!st.message && st.swaps > 0 && st.swaps < PROMOTE_AFTER) {
    st.message = `Only ${st.swaps} swap${st.swaps === 1 ? '' : 's'} in the last ${span} — a wallet needs ${PROMOTE_AFTER} before it gets a record.`;
  } else if (!st.message && st.swaps === 0) {
    st.message = `No swaps in the last ${span} — transfers, claims and mints are not trades.`;
  }
}

/**
 * The deep read (2026-10-23): with a Helius endpoint, the wallet's history
 * comes back WITH the transactions, a hundred a call, up to DEEP_READ_LIMIT
 * or DEEP_MAX_AGE_MS — the same 30 days the board's month window shows, in
 * a handful of calls and about 100 credits, where the standard path needs a
 * call per transaction and stops at a week. 'refused' when the first page
 * could not be had (the method not on this key's plan, or a failure): the
 * standard path then reads it, on the same endpoint.
 */
/** Retries of a rate-limited deep-read page, and the longest wait between. */
const DEEP_429_TRIES = 5;
const DEEP_429_WAIT_MAX_MS = 15_000;

async function readDeep(address: string, httpUrl: string, st: WalletReadStatus, now: number): Promise<'done' | 'refused'> {
  st.via = 'helius';
  const limit = st.depth ?? DEEP_READ_LIMIT;
  const days = st.days ?? DEEP_DAYS;
  const sinceSec = Math.floor((now - days * 24 * 3_600_000) / 1_000);
  const got: Array<RawTransaction & { signature: string; transactionIndex?: number }> = [];
  let token: string | null = null;
  let stoppedEarly = false;
  do {
    if (cancels.has(address)) {
      st.cancelled = true;
      break;
    }
    let r = await getTransactionsForAddress(httpUrl, address, { limit: Math.min(DEEP_PAGE, limit - got.length), paginationToken: token, sinceSec });
    st.calls += 1;
    // Rate limited mid-read (2026-10-28: a busy wallet's week stopped at 800
    // of its transactions on the first 429): wait it out and ask again, a few
    // times, before keeping what was read.
    for (let tries = 1; !r.ok && /HTTP 429/.test(r.message ?? '') && tries <= DEEP_429_TRIES && !cancels.has(address); tries++) {
      await new Promise((res) => setTimeout(res, Math.min(DEEP_429_WAIT_MAX_MS, Math.max(rpcParkRemainingMs(httpUrl, 'getTransactionsForAddress'), tries * 1_500))));
      r = await getTransactionsForAddress(httpUrl, address, { limit: Math.min(DEEP_PAGE, limit - got.length), paginationToken: token, sinceSec });
      st.calls += 1;
    }
    if (!r.ok || !r.data) {
      stoppedEarly = true;
      if (got.length === 0) {
        if (r.refused) {
          deepRefusedUntil = Date.now() + DEEP_REFUSED_MS;
          log('info', `wallet read: this Helius key does not serve getTransactionsForAddress (${r.message}) — reading the standard way for the next hour`);
        }
        return 'refused';
      }
      // Pages already read are kept: an older stretch is missing, said once.
      st.message = `Stopped after ${got.length} transactions — ${r.message}`;
      break;
    }
    got.push(...r.data.txs);
    st.signatures = got.length;
    st.read = got.length;
    token = r.data.paginationToken;
    await yieldToLoop();
  } while (token && got.length < limit);
  // Newest first off the wire; the book must be fed oldest first.
  got.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0));
  for (const tx of got) feedOne(address, st, tx, tx.signature, tx.blockTime, now, tx.transactionIndex);
  // Cut short: the limit reached with more to come, or a page that failed
  // after others were read (the older stretch is missing).
  st.truncated = (got.length >= limit && !!token) || stoppedEarly || st.cancelled;
  if (!st.message && st.truncated) st.message = `Read the newest ${limit.toLocaleString()} transactions; older ones in the ${days} days were left out.`;
  explainQuiet(st, `${days} days`);
  return 'done';
}

async function run(address: string, httpUrl: string, st: WalletReadStatus, now: number): Promise<void> {
  try {
    if (isHeliusRpc(httpUrl) && Date.now() >= deepRefusedUntil) {
      if ((await readDeep(address, httpUrl, st, now)) === 'done') return;
      resetCounts(st, address);
    }
    st.via = 'rpc';
    const listed = await getSignaturesForAddress(httpUrl, address, WALLET_READ_LIMIT);
    st.calls += 1;
    if (!listed.ok || !listed.data) {
      st.message = `Could not list the wallet's transactions — ${listed.message}`;
      return;
    }
    const floor = now - READ_MAX_AGE_MS;
    // The listing stops at WALLET_READ_LIMIT: when it is full and its oldest
    // entry is still inside the window, older trades of the window were not
    // listed (2026-10-28).
    const oldestListed = listed.data.length ? listed.data[listed.data.length - 1].blockTime : null;
    st.truncated = listed.data.length >= WALLET_READ_LIMIT && (typeof oldestListed !== 'number' || oldestListed * 1_000 >= floor);
    // Failed transactions are nothing; anything older than the window is
    // outside every Scout window and not worth a read. The RPC lists newest
    // first; the book must be fed oldest first.
    const wanted = listed.data.filter((x) => !x.err && (typeof x.blockTime !== 'number' || x.blockTime * 1_000 >= floor)).reverse();
    st.signatures = wanted.length;
    if (!wanted.length) {
      st.message = listed.data.length ? 'Nothing in the last week — every transaction listed is older, or failed.' : 'No transactions on record for this wallet.';
      return;
    }
    for (let i = 0; i < wanted.length; i += BATCH) {
      if (cancels.has(address)) {
        st.cancelled = true;
        break;
      }
      const slice = wanted.slice(i, i + BATCH);
      const res = await getTransactions(
        httpUrl,
        slice.map((x) => x.signature),
      );
      st.calls += 1;
      st.read += slice.length;
      if (!res.ok || !res.data) {
        // The whole batch is lost, said once, and the read goes on: a parked
        // endpoint should cost a batch, not the wallet.
        st.unreadable += slice.length;
        if (!st.message) st.message = `Some transactions could not be read — ${res.message}`;
        await yieldToLoop();
        continue;
      }
      for (let j = 0; j < slice.length; j++) {
        const tx = res.data[j];
        if (!tx) {
          st.unreadable += 1;
          continue;
        }
        feedOne(address, st, tx, slice[j].signature, slice[j].blockTime, now);
      }
      await yieldToLoop();
    }
    explainQuiet(st, 'week');
  } catch (e) {
    st.message = st.message || `Read stopped — ${(e as Error).message ?? String(e)}`.slice(0, 200);
  } finally {
    st.running = false;
    st.finishedAt = Date.now();
    cancels.delete(address);
    // Who signs (2026-10-28): a read that covered enough of its transactions
    // and found it signed no swap, only moved tokens under other signatures,
    // marks the record "never signs"; a signed swap clears the mark.
    if (!st.cancelled) {
      const said = neverSignsFrom(st.read - st.unreadable, st.swaps, st.unsigned ?? 0, st.finishedAt);
      if (said === 'clear') walletScout.setNeverSigns('solana', address, null);
      else if (said) {
        walletScout.setNeverSigns('solana', address, said);
        const prior = st.message && !/^No swaps/.test(st.message) ? ` ${st.message}` : '';
        st.message = `It never signed a swap: in ${said.unsigned.toLocaleString()} of the ${said.read.toLocaleString()} transactions read, its tokens moved under someone else’s signature. The trades the record credits to it were not its own — most likely it is an account a pool, router or market maker uses — so there is nothing of its own to copy.${prior}`;
      }
    }
    log(
      st.message ? 'warn' : 'info',
      `wallet read ${address.slice(0, 6)}…: ${st.cancelled ? 'cancelled' : 'done'} — ${st.read}/${st.signatures} read, ${st.swaps} swap(s), ${st.fed} new, ${st.duplicates} known, ${st.notSwap} not trades, ${st.unreadable} unreadable, ${st.calls} call(s)${st.message ? ` · ${st.message}` : ''}`,
    );
    // A read is one deliberate act; its result should survive a crash a
    // second later (the store otherwise persists on a debounce).
    walletScout.persist();
  }
}

/** Test seams. */
export const _store = walletScout;
export function _reset(): void {
  jobs.clear();
  swapsKept.clear();
  deepRefusedUntil = 0;
  running.clear();
  cancels.clear();
}
