// Leader feed frames — the two subscriptions a followed wallet can ride on,
// and the parser for the one that pushes the transaction itself.
//
// `logsSubscribe` (every Solana RPC): a signature per transaction that
// mentions the wallet; the watcher then reads the transaction back. That
// read-back is the slow, fragile half of copy trading on a public endpoint —
// up to six retries against a host that parks itself, ~150–600 ms on a good
// day and "That trade was not copied" on a bad one (docs/tx-v1-2026-09-20.md,
// docs/copy-trade-competitors-2026-09-21.md §5).
//
// `transactionSubscribe` (Helius Enhanced WebSockets; Developer plan and up,
// docs fetched 2026-09-21): the whole transaction — message and meta — comes
// WITH the notification, filtered by `accountInclude`. No read-back, no
// retries, no per-method budget spent. The watcher tries it on a keyed
// socket and falls back to `logs` on a refusal that names the plan or the
// method, so a free key is left exactly where it was.
//
// `parsedTransactionSubscribe` (Helius Parsed Streams, every plan including
// free, `wss://beta.helius-rpc.com`; probed 2026-10-24 with the user's key):
// the transaction comes with the notification ALREADY DECODED — pump's
// TradeEvent with its amounts — but without pre/post balances. Over 3 min on
// the 20 busiest Scout wallets it delivered 5,630 transactions to logs'
// 5,626 (none missing), a median 119 ms (p10 197, p90 56) BEFORE the same
// transaction's `logsSubscribe` notification, which still needs its read-back
// after that. Billed 1 credit per delivered event. Because it has no
// balances, a sell's share of the holding cannot be known from it; only a
// clean curve BUY is decoded from the push (`decodeParsedBuy`), and
// everything else is read back by signature exactly as on `logs` — just
// ~120 ms sooner.
//
// All frames are built here, as pure functions with fixtures in
// test/leaderfeedframes.test.mjs, so the watcher's socket code never has to
// know what a Helius notification looks like — and a shape change on their
// side degrades to the read-back path rather than to silence.

import { PUMP_PROGRAM } from '../chain/addresses';
import { MAX_SUPPORTED_TX_VERSION, type RawTransaction } from '../chain/rpcClient';
import type { WalletSwap } from './walletSwap';

export type LeaderFeedMethod = 'logs' | 'tx' | 'parsed';

/** Parsed Streams' host. The key goes in the query, as on every Helius URL. */
export const PARSED_STREAM_HOST = 'wss://beta.helius-rpc.com';
/** Subscriptions one Parsed Streams connection accepts (vendor docs, every
 *  plan). Past it the watcher rides `logs` instead of dropping a leader. */
export const PARSED_SUBS_PER_SOCKET = 25;

/**
 * Confirmed on both transports. On `logs` the transaction is read back at
 * confirmed, and a processed notification would only be asked for before it
 * can be answered. On `tx` a processed push can describe a transaction that
 * never lands — and a copy must not fire on one. Helius allows `processed`
 * here; it is a deliberate non-choice, and belongs behind a measurement, not
 * a default. Measured 2026-10-23 under Alpenglow: processed is worth ~150 ms
 * (median 148, p90 349) with 0 phantoms in ~39.5k signatures, and every
 * processed transaction arrives twice — a small prize, not the ~400 ms of
 * 400 ms slots.
 */
export const FEED_COMMITMENT = 'confirmed';

export function subscribeFrame(method: LeaderFeedMethod, id: number, wallet: string): string {
  if (method === 'parsed') {
    // Matches any instruction (top level or CPI) that names the wallet among
    // its accounts — the same transactions `mentions` finds, as measured.
    // Failed transactions are left out; `full` keeps every instruction, so a
    // route through another program is visible and sent to the read-back.
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'parsedTransactionSubscribe',
      params: [{ accounts: { include: [wallet] }, includeFailed: false }, { commitment: FEED_COMMITMENT, details: 'full' }],
    });
  }
  if (method === 'tx') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'transactionSubscribe',
      params: [
        { vote: false, failed: false, accountInclude: [wallet] },
        {
          commitment: FEED_COMMITMENT,
          encoding: 'json',
          transactionDetails: 'full',
          showRewards: false,
          // Required for the account list and full details to come back at
          // all, and the same constant every read in the app uses.
          maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        },
      ],
    });
  }
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [wallet] }, { commitment: FEED_COMMITMENT }] });
}

export function unsubscribeFrame(method: LeaderFeedMethod, id: number, subscription: number): string {
  const name = method === 'tx' ? 'transactionUnsubscribe' : method === 'parsed' ? 'parsedTransactionUnsubscribe' : 'logsUnsubscribe';
  return JSON.stringify({ jsonrpc: '2.0', id, method: name, params: [subscription] });
}

/**
 * A refusal that means "not this method on this plan", as opposed to a
 * transient one (too many subscriptions, a hiccup). -32601 is JSON-RPC's
 * "method not found", which is what a host without the method answers.
 */
export function isPlanRefusal(message: string, code?: number): boolean {
  if (code === -32601) return true;
  return /method not found|not supported|unsupported|plan|upgrade|unauthori[sz]ed|forbidden|not available|not enabled|invalid method/i.test(message);
}

export interface TxNotification {
  subscription: number;
  signature: string;
  slot: number | null;
  /** The transaction as `getTransaction` would return it, or null when the
   *  push did not carry a shape the decoder knows — the caller then reads
   *  it back by signature, exactly as on the `logs` transport. */
  tx: RawTransaction | null;
}

export function parseTransactionNotification(msg: unknown): TxNotification | null {
  const m = msg as { method?: unknown; params?: { subscription?: unknown; result?: { signature?: unknown; slot?: unknown; transaction?: unknown; meta?: unknown } } } | null;
  if (!m || m.method !== 'transactionNotification') return null;
  const sub = m.params?.subscription;
  const r = m.params?.result;
  if (typeof sub !== 'number' || !r || typeof r.signature !== 'string' || !r.signature) return null;
  return { subscription: sub, signature: r.signature, slot: typeof r.slot === 'number' ? r.slot : null, tx: unwrap(r.transaction, r.meta) };
}

function unwrap(t: unknown, metaBeside: unknown): RawTransaction | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as { transaction?: { message?: unknown }; meta?: unknown; message?: unknown; blockTime?: unknown };
  // Helius: result.transaction = { transaction: { message, signatures }, meta }
  // — the getTransaction shape, which the decoder already reads.
  if (o.transaction && typeof o.transaction === 'object' && o.transaction.message && o.meta !== undefined) {
    return o as unknown as RawTransaction;
  }
  // Or the message on its own with the meta beside it.
  const meta = o.meta !== undefined ? o.meta : metaBeside;
  if (o.message && meta !== undefined) {
    return { transaction: o, meta, blockTime: typeof o.blockTime === 'number' ? o.blockTime : null } as unknown as RawTransaction;
  }
  return null;
}

// ── Parsed Streams ────────────────────────────────────────────────────

/** One decoded instruction or event as Parsed Streams sends it. Every u64
 *  arrives as a decimal string. */
export interface ParsedInstruction {
  programId?: string;
  instructionName?: string;
  innerInstructionIndex?: number | null;
  stackHeight?: number;
  decoded?: { args?: Record<string, unknown>; accounts?: Array<{ name?: string; pubkey?: string; isSigner?: boolean }> } | null;
}

export interface ParsedTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  rawTokenAmount?: number | string;
  decimals?: number | string;
}

export interface ParsedValue {
  transaction?: {
    signature?: string;
    slot?: number;
    blockTime?: number | null;
    status?: string;
    feePayer?: string;
    accountKeys?: string[];
    tokenTransfers?: ParsedTransfer[];
  };
  instructions?: ParsedInstruction[];
}

export interface ParsedNotification {
  subscription: number;
  signature: string;
  slot: number | null;
  failed: boolean;
  value: ParsedValue;
}

export function parseParsedNotification(msg: unknown): ParsedNotification | null {
  const m = msg as { method?: unknown; params?: { subscription?: unknown; result?: { value?: unknown; context?: { slot?: unknown } } } } | null;
  if (!m || m.method !== 'parsedTransactionNotification') return null;
  const sub = m.params?.subscription;
  const value = m.params?.result?.value as ParsedValue | undefined;
  const tx = value?.transaction;
  if (typeof sub !== 'number' || !value || !tx || typeof tx.signature !== 'string' || !tx.signature) return null;
  const ctxSlot = m.params?.result?.context?.slot;
  const slot = typeof tx.slot === 'number' ? tx.slot : typeof ctxSlot === 'number' ? ctxSlot : null;
  return { subscription: sub, signature: tx.signature, slot, failed: tx.status !== 'ok', value };
}

/** pump's TradeEvent and PostCompleteBuyEvent, and PumpSwap's BuyEvent and
 *  SellEvent: any of these naming the wallet as `user` is a trade by it. */
const TRADE_EVENT = /^(TradeEvent|BuyEvent|SellEvent|PostCompleteBuyEvent)$/;
/** pump's two spellings of "the quote is SOL". */
const SOL_QUOTE = new Set(['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);
const WSOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1_000_000_000;
/** walletSwap's buy floor: under it the read-back decides, not the push. */
const MIN_BUY_SOL = 0.005;

const u64 = (v: unknown): bigint | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  try {
    const n = BigInt(v);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
};

/**
 * Did `wallet` sign this transaction? The push has no message header, so the
 * proof is the fee payer, or a TOP-LEVEL instruction that lists the wallet as
 * a signer (an inner one can be signed for by a program). A pump TradeEvent's
 * `user` is not proof: measured 2026-10-24, a Mayhem-mode wallet (BwWK17…)
 * trades through a program that moves its funds without its signature, and
 * walletSwap's rule 1 rejects all of those.
 */
export function parsedSignedBy(value: ParsedValue, wallet: string): boolean {
  if (value.transaction?.feePayer === wallet) return true;
  return (value.instructions ?? []).some(
    (i) => i.innerInstructionIndex == null && (i.decoded?.accounts ?? []).some((acc) => acc.pubkey === wallet && acc.isSigner === true),
  );
}

/**
 * The one shape decoded straight from a Parsed Streams push: `wallet` bought
 * a coin on pump's curve, for SOL, in a single trade, and nothing else of
 * value moved for it, and it signed. Null means "read it back" — never
 * "not a trade": a sell (its share of the holding needs the pre-balance the push lacks), a
 * PumpSwap or Jupiter route, a curve-completing buy, a second trade in the
 * same transaction, any other token moving, an event field this was not
 * measured against — all go to the read-back, where `decodeWalletSwap`
 * applies its rules exactly as on `logs`.
 *
 * SOL paid = the curve amount + pump's fee + the creator fee (the buyback
 * fee is a part of `fee`). Checked 2026-10-24 against the wallet's balance
 * delta from getTransaction: equal to the lamport. It leaves out a new token
 * account's rent and any router's own cut, which the balance delta counts,
 * so the price here is the trade's own — a hair under the read-back's.
 */
export function decodeParsedBuy(value: ParsedValue, wallet: string): WalletSwap | null {
  const tx = value.transaction;
  if (!tx || tx.status !== 'ok') return null;
  if (!(tx.accountKeys ?? []).includes(wallet)) return null;
  if (!parsedSignedBy(value, wallet)) return null;
  const ixs = value.instructions ?? [];
  const mine = ixs.filter((i) => TRADE_EVENT.test(i.instructionName ?? '') && i.decoded?.args?.user === wallet);
  if (mine.length !== 1) return null;
  const ev = mine[0];
  if (ev.programId !== PUMP_PROGRAM || ev.instructionName !== 'TradeEvent') return null;
  // The curve completing in this transaction moves its tail to PumpSwap in
  // the same buy; the read-back sees all of it.
  if (ixs.some((i) => i.programId === PUMP_PROGRAM && /^(CompleteEvent|PostCompleteBuyEvent)$/.test(i.instructionName ?? ''))) return null;
  const a = ev.decoded?.args ?? {};
  if (a.is_buy !== true) return null;
  if (typeof a.mint !== 'string' || !a.mint) return null;
  if (typeof a.quote_mint === 'string' && !SOL_QUOTE.has(a.quote_mint)) return null;
  // Fields the SOL-paid sum was not measured with: zero, or the read-back.
  for (const k of ['cashback', 'holder_rewards']) {
    if (a[k] !== undefined && u64(a[k]) !== 0n) return null;
  }
  const quote = u64(a.sol_amount ?? a.quote_amount);
  const fee = u64(a.fee ?? '0');
  const creatorFee = u64(a.creator_fee ?? '0');
  const raw = u64(a.token_amount);
  if (quote === null || fee === null || creatorFee === null || raw === null || quote === 0n || raw === 0n) return null;
  // Every token the wallet moved must be this coin coming IN, by exactly the
  // event's amount, or wrapped SOL. Anything else — tokens sent on, a stable
  // leg, a second coin — is a route the balance-delta decoder must judge.
  let got = 0n;
  let decimals: number | null = null;
  for (const t of tx.tokenTransfers ?? []) {
    const from = t.fromUserAccount === wallet;
    const to = t.toUserAccount === wallet;
    if (!from && !to) continue;
    if (t.mint === WSOL) continue;
    if (t.mint !== a.mint || from) return null;
    const amt = u64(t.rawTokenAmount);
    if (amt === null) return null;
    got += amt;
    const d = Number(t.decimals);
    if (Number.isInteger(d) && d >= 0) decimals = d;
  }
  if (got !== raw || decimals === null) return null;
  const sol = Number(quote + fee + creatorFee) / LAMPORTS;
  if (sol < MIN_BUY_SOL) return null;
  const tokens = Number(raw) / 10 ** decimals;
  const priceSol = sol / tokens;
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;
  const programs = [...new Set(ixs.filter((i) => i.innerInstructionIndex == null && typeof i.programId === 'string').map((i) => i.programId as string))];
  // The pre-balance is not in the push. A buy does not need it; null says
  // "not known", and the copier only reads it through `soldFraction`.
  return { mint: a.mint, isBuy: true, sol, tokens, decimals, priceSol, heldBefore: null, soldFraction: null, programs };
}
