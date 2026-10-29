// Wallet Scout — where a manual scan reads its trades from, per chain.
//
// Every chain already has a historical reader that names the trader, so this
// is wiring, not decoding:
//
//   Solana     "the tokens people are trading right now", taken from the
//              Discover columns where round trips actually close (Graduating,
//              Migrated) and then New; pump.fun only. Each token's trades come
//              FAST FIRST (2026-10-24): from the chain through a Helius key
//              (chainPrice.recentTrades — a page every few hundred ms, ~10
//              credits, inside the backtest allowance), and from
//              swap-api.pump.fun's per-token pages (keyless, one call per 2 s,
//              parks) for any token the chain did not read.
//   Robinhood  CurveBuy/CurveSell logs across every Pons curve, by block range
//              — the same no-address topic scan the Observatory polls with.
//   BNB        four.meme's TokenPurchase/TokenSale logs from the manager, by
//              block range, filtered to BNB-quoted curves exactly as the live
//              path is: a trade in another quote asset is not BNB spent.
//
// Each source yields units (a token, a block chunk) with the calls it spent
// and anything it could not read. It never spends funds, and every call goes
// through the same provider queue as the rest of the app — a scan waits
// behind a chart, never the other way round.

import type { Address } from 'viem';
import * as market from '../data/market';
import * as jupiter from '../data/providers/jupiter';
import * as pumpswap from '../data/providers/pumpswap';
import * as chainPrice from './chainPrice';
import * as heliusBudget from '../system/heliusBudget';
import { addressTxCredits, isHeliusRpc } from '../chain/rpcClient';
import { cooldownRemainingMs } from '../data/http';
import { headBlock } from '../evm/market';
import { fetchAllCurveTrades, shortError } from '../evm/pons';
import * as fourmeme from '../evm/fourmeme';
import { EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';
import { SCAN_PAGE_CREDITS, SOLANA_SCAN_MAX_PAGES, SOLANA_SCAN_MAX_TOKENS, WINNERS_SCAN_MAX_PAGES, pickWinnerCoins, tradeId, winnersCoinCredits, type ScoutChain, type ScoutScanMode, type WinnerCandidate, type WinnerCoin } from '@shared/walletScout';
import type { ScanBatch, ScanSource } from './scoutScan';

/**
 * Tokens per Solana scan, and pages per token. At most 180 calls, paced by
 * the `pumpswap` provider gap in http.ts (2 s — swap-api.pump.fun blocks an
 * IP for ~35 s past roughly 22 requests in a short window, measured
 * 2026-09-21). Most tokens need one page, so a scan is usually two minutes;
 * the page says so. The constants live in shared/walletScout so the page
 * and this file cannot disagree about what a scan is.
 */
const SOLANA_MAX_TOKENS = SOLANA_SCAN_MAX_TOKENS;
const SOLANA_MAX_PAGES = SOLANA_SCAN_MAX_PAGES;

/**
 * Waits on a parked swap API before a token is given up as unread
 * (2026-10-24). Measured 2026-10-22: one 429 and 11 of 27 tokens came back
 * "rate limited" at once and were silently skipped. The same budget as the
 * copy replay (copyReplay.ts): a park is about a minute, so a scan that
 * meets one runs a minute longer and reads the tokens.
 */
const SCAN_MAX_WAITS = 3;
const SCAN_MAX_WAITS_TOTAL = 6;
const RATE_LIMITED = /429|rate limit/i;

export interface SolanaScanDeps {
  /** pump.fun tokens worth scanning, best first. */
  listMints(): Promise<string[]>;
  recentTrades(mint: string, sinceMs: number, maxPages: number): Promise<pumpswap.RecentScan>;
  /** How long the swap API is parked for, ms; 0 when it is not. */
  cooldownMs(): number;
  sleep(ms: number): Promise<void>;
  /**
   * The fast path (2026-10-24): a token's trades from the chain through a
   * Helius key, or null when there is no key. Fast first, then the fallback —
   * the swap API above reads any token the chain did not.
   */
  chainTrades?(mint: string, sinceMs: number, maxPages: number): Promise<chainPrice.ChainScan> | null;
  /** Credits the backtest allowance has left (0 = do not use the chain). */
  chainCreditsLeft?(): number;
  billBacktest?(credits: number): void;
  /** Why the chain cannot be used at all ('' when it can). */
  chainOff?(): string;
}

/** Tokens read from the chain at once, ahead of the one being booked. */
const CHAIN_AHEAD = 4;
/** Chain reads that failed in a row before the rest go to the swap API. */
const CHAIN_MAX_FAILS = 3;

/** Where the chain is read and what it may spend — attached by ipc. */
let chainUrl: () => string = () => '';
let chainAllowance: () => number = () => 0;
export function attachChain(o: { httpUrl: () => string; allowance: () => number }): void {
  chainUrl = o.httpUrl;
  chainAllowance = o.allowance;
}

const realSolanaDeps: SolanaScanDeps = {
  async listMints() {
    // Graduating and Migrated first: a token that has been trading for a
    // while is where positions open AND close. New is seconds-old tokens,
    // mostly one buy per address, so it fills whatever room is left.
    const columns = await Promise.all([market.discover('graduating', 40), market.discover('migrated', 40), market.discover('new', 40)]);
    const seen = new Set<string>();
    const mints: string[] = [];
    for (const rows of columns) {
      for (const r of rows) {
        if (r.launchpad !== 'pumpfun' || !r.mint || seen.has(r.mint)) continue;
        seen.add(r.mint);
        mints.push(r.mint);
      }
    }
    return mints;
  },
  recentTrades: (mint, sinceMs, maxPages) => pumpswap.recentTrades(mint, sinceMs, maxPages),
  cooldownMs: () => cooldownRemainingMs('pumpswap'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  chainTrades: (mint, sinceMs, maxPages) => {
    const url = chainUrl();
    return isHeliusRpc(url) ? chainPrice.recentTrades(url, mint, sinceMs, maxPages) : null;
  },
  chainCreditsLeft: () => heliusBudget.backtestLeft(chainAllowance()),
  billBacktest: (credits) => heliusBudget.billBacktest(credits),
  chainOff: () =>
    !isHeliusRpc(chainUrl())
      ? 'there is no Helius key — add one in Settings to scan in seconds'
      : chainAllowance() <= 0
        ? 'chain reads are turned off (backtest allowance 0 in Settings)'
        : '',
};

/**
 * Every token is accounted for (2026-10-24): read whole, read in part (busier
 * than SOLANA_MAX_PAGES pages over the window, so only its newest trades), or
 * not read. A token lost to a park is waited for first, then counted as
 * unread — the status says "N of M not read" instead of a smaller result
 * that looks complete.
 */
export function solanaSource(deps: SolanaScanDeps = realSolanaDeps): ScanSource {
  return async function* (ctx) {
    let mints: string[];
    try {
      mints = await deps.listMints();
    } catch (e) {
      yield { trades: [], calls: 0, units: 0, note: `Could not list tokens to scan — ${(e as Error).message}` };
      return;
    }
    if (!mints.length) {
      yield { trades: [], calls: 0, units: 0, note: 'No pump.fun tokens to scan — the token lists came back empty (is market data on in Settings?).' };
      return;
    }
    mints = mints.slice(0, SOLANA_MAX_TOKENS);
    let first = true;
    let waits = 0;
    // The chain first, CHAIN_AHEAD tokens read ahead; it stops being asked
    // (and says why, once) when it is off, the allowance cannot cover another
    // token, or it keeps failing. A read already in flight is still used.
    let chainWhyNot = deps.chainTrades ? (deps.chainOff?.() ?? '') : 'there is no Helius key';
    let chainFails = 0;
    let whySaid = false;
    const ahead = new Map<number, Promise<chainPrice.ChainScan | null>>();
    const launch = (i: number): void => {
      if (chainWhyNot || ahead.has(i) || i >= mints.length) return;
      const left = deps.chainCreditsLeft?.() ?? 0;
      // Reserve the most every read in flight can cost.
      if (left < SOLANA_MAX_PAGES * SCAN_PAGE_CREDITS * CHAIN_AHEAD) {
        chainWhyNot = left > 0 ? 'the backtest allowance is nearly spent' : 'the backtest allowance (or the month’s Helius credits) is spent';
        return;
      }
      const p = deps.chainTrades?.(mints[i], ctx.sinceMs, SOLANA_MAX_PAGES) ?? null;
      if (!p) {
        chainWhyNot = 'there is no Helius key — add one in Settings to scan in seconds';
        return;
      }
      ahead.set(
        i,
        p.then(
          (r) => {
            if (r.credits > 0) deps.billBacktest?.(r.credits);
            return r;
          },
          () => null,
        ),
      );
    };
    for (const [i, mint] of mints.entries()) {
      if (ctx.cancelled()) return;
      for (let k = i; k < i + CHAIN_AHEAD; k++) launch(k);
      const c = ahead.has(i) ? await ahead.get(i)! : null;
      ahead.delete(i);
      if (c && !c.ok) {
        chainFails += 1;
        if (!chainWhyNot && (c.refused || chainFails >= CHAIN_MAX_FAILS)) chainWhyNot = `the chain read failed (${c.message})`;
      }
      if (c?.ok) {
        chainFails = 0;
        const batch: ScanBatch = {
          // Signing traders only (2026-10-27): an account the event names
          // that did not sign is a program's, and the wallet reader — the
          // same rule — would find it never traded, so it cannot be copied.
          trades: c.trades.filter((t) => t.signer !== false).map((t) => ({ address: t.user, mint, isBuy: t.isBuy, native: t.sol, tokens: t.tokens, at: t.ts, tx: tradeId(t.tx, mint, t.user, t.isBuy) })),
          calls: c.calls,
          read: c.complete ? 'whole' : 'partial',
          via: 'chain',
          credits: c.credits,
        };
        if (first) {
          batch.units = mints.length;
          first = false;
        }
        yield batch;
        continue;
      }
      // b. The swap API for this token.
      let calls = c?.calls ?? 0;
      let r: pumpswap.RecentScan;
      for (let attempt = 0; ; attempt++) {
        r = await deps.recentTrades(mint, ctx.sinceMs, SOLANA_MAX_PAGES);
        calls += r.calls;
        if (r.ok || !RATE_LIMITED.test(r.message) || attempt >= SCAN_MAX_WAITS || waits >= SCAN_MAX_WAITS_TOTAL) break;
        waits += 1;
        const ms = Math.min(90_000, Math.max(5_000, deps.cooldownMs()));
        ctx.waiting?.(Date.now() + ms);
        for (let left = ms; left > 0 && !ctx.cancelled(); left -= 1_000) await deps.sleep(Math.min(1_000, left));
        ctx.waiting?.(null);
        if (ctx.cancelled()) break;
      }
      // A failed page after some good ones still hands back what it read:
      // partly read, not unread.
      const batch: ScanBatch = {
        trades: r.trades.map((t) => ({
          address: t.user,
          mint,
          isBuy: t.isBuy,
          native: t.sol,
          tokens: t.base,
          at: t.ts,
          tx: tradeId(t.tx, mint, t.user, t.isBuy),
        })),
        calls,
        read: !r.complete ? (r.trades.length ? 'partial' : 'unread') : 'whole',
        via: 'pump',
        ...(c?.credits ? { credits: c.credits } : {}),
      };
      if (first) {
        batch.units = mints.length;
        first = false;
      }
      if (!whySaid && chainWhyNot) {
        batch.fallbackWhy = chainWhyNot;
        whySaid = true;
      }
      if (!r.ok) batch.note = `pump.fun trade history: ${r.message}`;
      yield batch;
    }
  };
}

const solana = solanaSource();

// ── The winners scan (2026-10-27) ─────────────────────────────────────
//
// The search in docs/copy-candidates-2026-10-27.md, as a scan. The recent
// scan reads a few pages of whatever is trading now, which is the launch
// churn where copies lose; this one reads the WHOLE week of the coins that
// went up and kept a market, and feeds every signing trader on them through
// the same `note`, so one coin's week prices a lagged copy of every wallet on
// it. Chain only: a week of a coin is up to WINNERS_SCAN_MAX_PAGES pages, and
// the swap API parks after twenty. Two coins are read at once; the allowance
// is reserved a coin at a time and its end is said in the status.

export interface SolanaWinnersDeps {
  /** The week's coins, best first — pickWinnerCoins over Jupiter's lists. */
  listCoins(now: number): Promise<WinnerCoin[]>;
  /** A coin's trades back to `sinceMs`, at most `maxPages` pages; null without a key. */
  chainTrades(mint: string, sinceMs: number, maxPages: number): Promise<chainPrice.ChainScan> | null;
  chainCreditsLeft(): number;
  billBacktest(credits: number): void;
  /** Why the chain cannot be used at all ('' when it can). */
  chainOff(): string;
}

/** Coins read from the chain at once. */
const WINNERS_AHEAD = 2;

/** Jupiter's lists as the picker reads them; a list that fails is skipped. */
export async function jupiterWinnerCandidates(): Promise<WinnerCandidate[]> {
  const lists = await Promise.allSettled([jupiter.topTraded('1h', 100), jupiter.topTraded('6h', 100), jupiter.topTraded('24h', 100), jupiter.topOrganic('24h', 100), jupiter.recent(100)]);
  const out: WinnerCandidate[] = [];
  for (const l of lists) {
    if (l.status !== 'fulfilled') continue;
    for (const t of l.value) {
      const s = t.stats24h as { buyVolume?: number; sellVolume?: number } | undefined;
      out.push({ id: t.id, symbol: t.symbol, launchpad: t.launchpad, mcap: t.mcap, liquidity: t.liquidity, vol24: (s?.buyVolume ?? 0) + (s?.sellVolume ?? 0), createdAt: t.firstPool?.createdAt ?? t.createdAt ?? null });
    }
  }
  return out;
}

const realWinnersDeps: SolanaWinnersDeps = {
  listCoins: async (now) => pickWinnerCoins(await jupiterWinnerCandidates(), now),
  chainTrades: (mint, sinceMs, maxPages) => {
    const url = chainUrl();
    return isHeliusRpc(url) ? chainPrice.recentTrades(url, mint, sinceMs, maxPages) : null;
  },
  chainCreditsLeft: () => heliusBudget.backtestLeft(chainAllowance()),
  billBacktest: (credits) => heliusBudget.billBacktest(credits),
  chainOff: () =>
    !isHeliusRpc(chainUrl())
      ? 'there is no Helius key — add one in Settings'
      : chainAllowance() <= 0
        ? 'chain reads are turned off (backtest allowance 0 in Settings)'
        : '',
};

export function solanaWinnersSource(deps: SolanaWinnersDeps = realWinnersDeps): ScanSource {
  return async function* (ctx) {
    const off = deps.chainOff();
    if (off) {
      yield { trades: [], calls: 0, units: 0, note: `The winners scan reads the chain only — ${off}` };
      return;
    }
    let coins: WinnerCoin[];
    try {
      coins = await deps.listCoins(ctx.now);
    } catch (e) {
      yield { trades: [], calls: 0, units: 0, note: `Could not list this week’s coins — ${(e as Error).message}` };
      return;
    }
    if (!coins.length) {
      yield { trades: [], calls: 0, units: 0, note: 'No pump.fun coin on Jupiter’s lists is young with a market, or a runner with volume, right now.' };
      return;
    }
    const perCoin = winnersCoinCredits();
    const ahead = new Map<number, Promise<chainPrice.ChainScan | null>>();
    let stopWhy = '';
    const launch = (i: number): void => {
      if (stopWhy || ahead.has(i) || i >= coins.length) return;
      // Reserve the most every read in flight can cost, this one included.
      if (deps.chainCreditsLeft() < perCoin * (ahead.size + 1)) {
        stopWhy = 'the backtest allowance (or the month’s Helius credits) cannot cover another coin';
        return;
      }
      const p = deps.chainTrades(coins[i].mint, ctx.sinceMs, WINNERS_SCAN_MAX_PAGES);
      if (!p) {
        stopWhy = 'there is no Helius key';
        return;
      }
      ahead.set(
        i,
        p.then(
          (r) => {
            if (r.credits > 0) deps.billBacktest(r.credits);
            return r;
          },
          () => null,
        ),
      );
    };
    let first = true;
    for (const [i, coin] of coins.entries()) {
      if (ctx.cancelled()) return;
      for (let k = i; k < i + WINNERS_AHEAD; k++) launch(k);
      const c = ahead.has(i) ? await ahead.get(i)! : null;
      ahead.delete(i);
      const batch: ScanBatch = { trades: [], calls: c?.calls ?? 0 };
      if (c?.credits) batch.credits = c.credits;
      if (first) {
        batch.units = coins.length;
        first = false;
      }
      if (!c || (!c.ok && !c.trades.length)) {
        batch.read = 'unread';
        batch.note = c ? `${coin.symbol}: ${c.message}` : stopWhy ? `${coin.symbol} and the coins after it were not read — ${stopWhy}` : `${coin.symbol}: the chain read failed`;
        yield batch;
        if (!c && stopWhy) return;
        continue;
      }
      // Signing traders only — see solanaSource.
      batch.trades = c.trades.filter((t) => t.signer !== false).map((t) => ({ address: t.user, mint: coin.mint, isBuy: t.isBuy, native: t.sol, tokens: t.tokens, at: t.ts, tx: tradeId(t.tx, coin.mint, t.user, t.isBuy) }));
      batch.via = 'chain';
      batch.read = c.complete ? 'whole' : 'partial';
      if (!c.ok) batch.note = `${coin.symbol}: read in part — ${c.message}`;
      yield batch;
    }
  };
}

const winners = solanaWinnersSource();

/** Test seam: the page price the sources reserve against, and the one the RPC client bills. */
export const _pageCredits = (): { reserved: number; billed: number } => ({ reserved: SCAN_PAGE_CREDITS, billed: addressTxCredits(100) });

/** Block chunk per getLogs. Robinhood's topic-filtered curve scan returns
 *  ~15 logs per 300 blocks, so 5,000 is a few hundred; four.meme's manager
 *  is far busier and its reader caps itself at 3,000. */
const CHUNK: Record<EvmChainKind, bigint> = { robinhood: 5_000n, bnb: 3_000n };
const MIN_CHUNK = 250n;

/** Quote asset per four.meme token, read once per scan — see the BNB note. */
async function bnbNativeOnly(tokens: string[], cache: Map<string, boolean>): Promise<number> {
  const ask = [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !cache.has(t));
  let calls = 0;
  for (let i = 0; i < ask.length; i += 150) {
    const slice = ask.slice(i, i + 150) as Address[];
    calls += 1;
    try {
      const infos = await fourmeme.infos(slice);
      for (const t of slice) {
        const info = infos.get(t);
        // Unknown stays unknown and is skipped below — a guess about the
        // quote asset would price BNB against USDT.
        if (info) cache.set(t, fourmeme.isNativeQuote(info));
      }
    } catch {
      /* the whole slice stays unknown */
    }
  }
  return calls;
}

const evm = (chain: EvmChainKind): ScanSource =>
  async function* (ctx) {
    const meta = EVM_CHAIN_META[chain];
    let head: bigint;
    try {
      head = await headBlock(chain);
    } catch (e) {
      yield { trades: [], calls: 1, units: 0, note: `${meta.name} RPC: ${shortError(e)}` };
      return;
    }
    const span = BigInt(Math.ceil((ctx.hours * 3_600_000) / meta.blockMs));
    const from = head > span ? head - span : 0n;
    let chunk = CHUNK[chain];
    const quoteCache = new Map<string, boolean>();
    let done = 0;
    // Units are re-stated on every batch: a halved chunk changes how many are
    // left, and a denominator fixed at the start would show 40 of 20.
    const unitsLeft = (start: bigint): number => done + Number((head - start) / chunk) + 1;
    const atOf = (block: bigint): number => ctx.now - Number(head - block) * meta.blockMs;
    let start = from;
    while (start <= head) {
      if (ctx.cancelled()) return;
      const end = start + chunk - 1n < head ? start + chunk - 1n : head;
      const batch: ScanBatch = { trades: [], calls: 1, units: unitsLeft(start) };
      try {
        if (chain === 'robinhood') {
          for (const t of await fetchAllCurveTrades(start, end)) {
            const curve = t.curve.toLowerCase();
            batch.trades.push({
              address: t.trader,
              mint: curve,
              isBuy: t.isBuy,
              native: Number(t.quoteWei) / 1e18,
              tokens: Number(t.tokensRaw),
              at: atOf(t.blockNumber),
              tx: tradeId(`${t.txHash}:${t.logIndex}`, curve, t.trader, t.isBuy),
            });
          }
        } else {
          const trades = await fourmeme.fetchTrades(start, end);
          batch.calls += await bnbNativeOnly(trades.map((t) => t.token), quoteCache);
          for (const t of trades) {
            const token = t.token.toLowerCase();
            if (quoteCache.get(token) !== true) continue;
            batch.trades.push({
              address: t.trader,
              mint: token,
              isBuy: t.isBuy,
              native: Number(t.quoteWei) / 1e18,
              tokens: Number(t.tokensRaw),
              at: atOf(t.blockNumber),
              tx: tradeId(`${t.txHash}:${t.logIndex}`, token, t.trader, t.isBuy),
            });
          }
        }
      } catch (e) {
        const why = shortError(e);
        // A range the endpoint will not serve in one go: halve and retry the
        // SAME start, the way Discover's activity scan does. Anything else is
        // one chunk lost, said in the status rather than swallowed.
        if (/exceeds limit|too many|response size|log cap|size limit/i.test(why) && chunk > MIN_CHUNK) {
          chunk /= 2n;
          continue;
        }
        batch.note = `Blocks ${start}–${end} could not be read (${why.slice(0, 80)})`;
        batch.read = 'unread';
      }
      yield batch;
      done += 1;
      start = end + 1n;
    }
  };

export function sourceFor(chain: ScoutChain, mode: ScoutScanMode = 'recent'): ScanSource {
  if (chain !== 'solana') return evm(chain);
  return mode === 'winners' ? winners : solana;
}
