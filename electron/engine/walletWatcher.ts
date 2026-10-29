// Wallet watcher — one `logsSubscribe` per FOLLOWED WALLET on the live
// socket, so copy trading sees a leader wherever it trades.
//
// Until 2026-09-06 a followed wallet was only ever noticed on the pump.fun
// curve firehose: a leader that trades through Jupiter into Raydium,
// Meteora or Orca was "followed" and nothing ever happened. This module
// subscribes to the wallet itself (`mentions: [wallet]`), so every
// transaction it signs arrives as a signature; the transaction is read once
// and its swap decoded from the wallet's own balance deltas (walletSwap.ts)
// — no per-DEX decoders, and the same for every router and pool.
//
// Same socket rules as the priority feed, learned the hard way: the pong
// deadline is enforced only after a first pong and inbound frames count as
// life; a handshake 429 parks the host for every socket class; reconnect
// backoff resets on an ack or a notification, never on a bare open.
//
// 2026-09-09: the "public socket allows ten subscriptions" rule that used to
// live here was wrong and cost users leaders. `x-ratelimit-pubsub-limit: 10`
// is 10 pubsub CONNECTIONS per IP — 16 subscriptions on one socket were all
// acked. What is scarce is the socket, and this module opens exactly one. A
// wallet is only marked `over-cap` if the host itself refuses the subscribe.
//
// Independent of the scanner: paper copying costs nothing and should work
// with the launch feed stopped, so this runs whenever a config is enabled.

import WebSocket from 'ws';
import type { CopyWatchStatus } from '@shared/copytrade';
import { budgetWaitMs, getSignaturesForAddress, getTransaction, noteSocketRejection, noteSocketRateLimit, socketParkRemainingMs, type RawTransaction } from '../chain/rpcClient';
import { classifyUnseenExit, decodeWalletSwap, type UnseenExitKind, type WalletSwap } from './walletSwap';
import {
  decodeParsedBuy,
  isPlanRefusal,
  parseParsedNotification,
  parseTransactionNotification,
  PARSED_SUBS_PER_SOCKET,
  subscribeFrame,
  unsubscribeFrame,
  type LeaderFeedMethod,
} from './leaderFeedFrames';

export interface WalletWatcherHost {
  /** Socket to subscribe on; empty means the watcher cannot run. */
  wssUrl(): string;
  /** HTTP endpoint the leader's transactions are read from. */
  httpUrl(): string;
  /**
   * A second endpoint for the read-back ONLY (getTransaction), used when the
   * first one refuses a read. api.mainnet-beta grants getTransaction about
   * 10 per 10 s per IP, shared with every app on the machine (Krypto Bot
   * included), and its 429s count against the window, so retrying the same
   * host keeps it saturated (probe, 2026-10-23: publicnode served 94/94 at a
   * 122 ms median). Method-scoped on purpose: publicnode refuses indexed
   * reads and caps getMultipleAccounts, so it must never become a host-wide
   * fallback. Empty or absent = no second endpoint.
   */
  readFallbackUrl?(): string;
  /**
   * Helius Parsed Streams' socket (2026-10-24), keyed; empty when there is
   * no key, the user turned it off, or the credit budget is spent. Tried
   * after `transactionSubscribe` and before plain `logs` — see
   * leaderFeedFrames.ts for what it delivers and what it measured.
   */
  parsedWssUrl?(): string;
  /** Parsed Streams bills 1 credit per delivered event, not by bytes. */
  billEvents?(n: number): void;
  /**
   * A followed wallet's transaction stayed unreadable after every retry,
   * including the second round (2026-10-28). The copier tells the user when
   * a live copy of that wallet is open — it may have been their sell.
   */
  onUnreadable?(wallet: string, signature: string): void;
  onSwap(ev: {
    wallet: string;
    swap: WalletSwap;
    signature: string;
    at: number;
    tradeAt: number | null;
    /** What the delivery half cost (2026-09-21). The copier adds its own
     *  stages and the signer's, so one line can account for the whole path
     *  from the leader's fill to ours. */
    timing: DeliveryTiming;
  }): void;
  /**
   * The leader LEFT a token in a transaction that was not a SOL sale
   * (2026-10-28): a transfer out, a stablecoin sale, a token-for-token
   * route. `tokens` is what left, UI units. The copier decides per follow
   * — told to a watch, mirrored by a copy that asked for it.
   */
  onUnseenExit?(ev: { wallet: string; kind: UnseenExitKind; mint: string; tokens: number; signature: string; at: number; tradeAt: number | null; slot: number | null }): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

/** The stages this module owns: hearing about the trade and getting the
 *  transaction in hand. Durations in ms; null is unknown, never zero. */
export interface DeliveryTiming {
  feed: LeaderFeedMethod;
  /** Their block time → the notification arriving here. Null when the
   *  transaction carried no block time, which every `tx` push does. */
  detectMs: number | null;
  /** The read-back. Null on the `tx` transport, which has none, and on a
   *  `parsed` buy decoded from the push. */
  readMs: number | null;
  readTries: number;
  decodeMs: number;
  /** When the notification arrived, so later stages can measure from it. */
  detectedAt: number;
  /** The slot THEIR transaction landed in (2026-10-22), from the push or the
   *  read-back. Null when neither carried it. A copy measures how many
   *  slots behind it landed from this. */
  slot?: number | null;
}

interface WalletStats {
  lastSeenAt: number | null;
  lastSwapAt: number | null;
  seen: number;
  swaps: number;
  /** Seen on the socket but the transaction could not be READ after every
   *  retry — the stage where the v1 outage of 2026-09-15..20 disappeared
   *  everything. Counted separately so the status line can say so. */
  unreadable: number;
  /** Read fine, but not a copyable swap (a transfer, an LP move, a claim). */
  notSwap: number;
  /** Of `notSwap`, the ones where the wallet LEFT a token in a way the
   *  copier cannot mirror (walletSwap.classifyUnseenExit). */
  unseenExits: number;
  overCap: boolean;
  /** A subscription for this wallet has been acked at least once THIS
   *  process. Only then is a reconnect a gap worth filling — on the first
   *  subscribe of a session there is nothing to have missed, and replaying
   *  a leader's last half hour into their record would double-count it. */
  subscribed: boolean;
  /** When a catch-up last ran, so the heartbeat can round-robin. */
  recoveredAt: number;
}

/**
 * There is no ten-wallet ceiling — see the header note. This is a runaway
 * guard, not a limit we claim the host has.
 *
 * MEASURED 2026-09-09: `x-ratelimit-pubsub-limit: 10` on
 * api.mainnet-beta.solana.com counts pubsub CONNECTIONS per IP, not
 * subscriptions per connection. The header decrements once per socket opened,
 * 16 `logsSubscribe` frames on ONE socket were all acked, and connections 11,
 * 12 and 13 were refused with HTTP 429 at the handshake. Following 14 leaders
 * left four of them silently unwatched for a limit that does not exist.
 *
 * 16 is the verified number, so the guard sits at 64 — well past any real
 * follow list. If the host ever refuses a subscribe for volume, the count it
 * refused at is recorded in `observedSubCap` and becomes the ceiling.
 */
const VERIFIED_SUBS_PER_SOCKET = 16;
const SUB_GUARD = 64;
/** Live subscriptions this socket refused to go past, once observed. */
let observedSubCap: number | null = null;
const PING_MS = 15_000;
const SILENCE_MS = 25_000;
/**
 * How hard a followed wallet's transaction is chased before it is given up
 * on.
 *
 * It used to be three tries 700 ms apart — about two seconds — and a give-up
 * was SILENT. On a rate-limited public endpoint (the default; `rpcClient`
 * parks a host that 429s) two seconds is nothing, and every transaction lost
 * that way is a leader trade the copier never acts on: an exit that never
 * fires reads to the user as a position that "sold late" whenever something
 * else eventually closes it (report, 2026-09-15). This is an exit decision,
 * so it is worth tens of seconds and a line in the log when it fails.
 */
const FETCH_ATTEMPTS = 6;
/**
 * The wait BETWEEN attempts, one entry per gap.
 *
 * It used to be 700 ms doubling (700, 1400, 2800, 5600, 8000). The patience
 * at the tail is the point and is kept; the 700 ms at the FRONT was not. A
 * transaction the socket just told us about is confirmed — the node simply
 * has not indexed it yet, which is a matter of tens of milliseconds, and
 * sleeping 700 ms before asking again put most of a second into the middle
 * of the copy path for nothing (2026-09-21, after a tester timed ~5–6 s from
 * a leader's fill to their copy's).
 *
 * The early gaps are now short and the late ones are longer than before, so
 * a transaction that really is missing is still chased for tens of seconds —
 * each attempt also carries the call's own timeout, and `rpcClient` waits
 * out a parked host INSIDE the call rather than here.
 */
const FETCH_BACKOFF_MS = [120, 300, 800, 2_000, 5_000];
/** How long a read-back may queue for the primary's budget before it goes to
 *  the fallback endpoint instead (a read is ~60–120 ms when it is served). */
const READ_QUEUE_TOLERANCE_MS = 300;
const SEEN_CAP = 2_000;

// ── Catch-up ──────────────────────────────────────────────────────────
//
// `logsSubscribe` is live-only: whatever a wallet does while the socket is
// down is never delivered, and nothing here used to ask for it afterwards.
// A reconnect costs a backoff of up to 30 s, far longer when the host is
// parked — and a leader's exit inside that window was simply never seen. The
// position then stayed open until the leader happened to sell again, which
// is exactly the "eventually sold, 1 h 28 m late" shape of the report.
//
// So after a gap, and on a slow round-robin heartbeat (a subscription can
// also go quietly dead while the socket stays open), the wallet's recent
// signatures are read and anything unseen is put through the same decode
// path. `seen` dedupes it against the live feed, and copyTrade applies its
// own staleness rules to whatever comes out — a recovered BUY is refused for
// age, a recovered SELL fires only while the instruction is still current.

/** Signatures a catch-up asks for. Two minutes of a busy wallet. */
const RECOVER_LIMIT = 25;
/** Nothing older than this is replayed, whatever the gap was. */
const RECOVER_WINDOW_MS = 30 * 60_000;
/** One wallet per tick, so following ten leaders costs one read a minute. */
const RECOVER_TICK_MS = 60_000;
/** A live subscription is still re-checked this often, in case it is dead. */
const RECOVER_EVERY_MS = 5 * 60_000;

let host: WalletWatcherHost | null = null;
let ws: WebSocket | null = null;
let running = false;
let nextId = 1;
let attempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let recoverTimer: NodeJS.Timeout | null = null;
let currentUrl = '';
let capNotedAt = 0;
/**
 * Which subscription the current socket carries (2026-09-21).
 *
 * `logs` is `logsSubscribe` — every host serves it, and each notification
 * costs a `getTransaction` read-back with up to six retries on a
 * rate-limited endpoint. `tx` is Helius's `transactionSubscribe`, which
 * pushes the PARSED transaction with the notification, so the read-back and
 * its retries disappear. It is a paid-plan method (Developer and up): a
 * keyed socket TRIES it and, on a refusal that names the method or the plan,
 * falls back to `logs` for the rest of the session — a free key changes
 * nothing. Frames and the parser live in leaderFeedFrames.ts.
 */
let method: LeaderFeedMethod = 'logs';
/** The keyed host refused `transactionSubscribe` this session. */
let txDenied = false;
/**
 * `parsed` is not tried again before this (2026-10-24). It is a beta host:
 * a refused subscribe, or two connections in a row that never got one acked,
 * put the watcher on `logs` for half an hour rather than leaving a leader
 * unwatched while it retries. `refreshTransport` moves back afterwards.
 */
let parsedDeniedUntil = 0;
const PARSED_RETRY_MS = 30 * 60_000;
/** Parsed Streams connections in a row that closed before any ack. */
let parsedFails = 0;

/** Followed wallet → live subscription id (null until acked). */
const wanted = new Map<string, number | null>();
/** Pending request id → wallet, and which transport the request used. */
const pending = new Map<number, { wallet: string; method: LeaderFeedMethod }>();
/** Subscription id → wallet, for routing notifications. */
const bySub = new Map<number, string>();
const stats = new Map<string, WalletStats>();
/** Signatures already handled; a socket reconnect can replay one. */
const seen = new Set<string>();

const keyed = (u: string): boolean => /api-key=|[?&]token=/i.test(u);

export function attach(h: WalletWatcherHost): void {
  host = h;
}

function statsFor(wallet: string): WalletStats {
  let s = stats.get(wallet);
  if (!s) {
    s = { lastSeenAt: null, lastSwapAt: null, seen: 0, swaps: 0, unreadable: 0, notSwap: 0, unseenExits: 0, overCap: false, subscribed: false, recoveredAt: 0 };
    stats.set(wallet, s);
  }
  return s;
}

/** Follow exactly these wallets: new ones are subscribed, dropped ones
 *  unsubscribed, and the socket closes when none remain. Idempotent. */
export function setWallets(wallets: string[]): void {
  const want = new Set(wallets.filter(Boolean));
  for (const w of [...wanted.keys()]) if (!want.has(w)) unwatch(w);
  for (const w of want) if (!wanted.has(w)) watch(w);
}

export function watchedWallets(): string[] {
  return [...wanted.keys()];
}

const UNSEEN_TEXT: Record<string, string> = {
  stableSell: 'sold it for a stablecoin',
  tokenForToken: 'swapped it for another token',
  transferOut: 'sent it to another wallet',
};

/** A leader leaving a token in a way the copier cannot mirror: counted, and
 *  said once in the log, so a copy still open on it is not a mystery. */
function noteUnseenExit(h: WalletWatcherHost, s: WalletStats, tx: RawTransaction, wallet: string, signature: string): void {
  const x = classifyUnseenExit(tx, wallet);
  if (!x) return;
  s.unseenExits += 1;
  const blockTime = tx.blockTime;
  h.onUnseenExit?.({
    wallet,
    kind: x.kind,
    mint: x.mint,
    tokens: x.tokens,
    signature,
    at: Date.now(),
    tradeAt: typeof blockTime === 'number' && blockTime > 0 ? blockTime * 1_000 : null,
    slot: typeof tx.slot === 'number' ? tx.slot : null,
  });
  h.log(
    'warn',
    `wallet watcher: ${wallet.slice(0, 6)}… ${UNSEEN_TEXT[x.kind]} (${x.mint.slice(0, 8)}…, ${signature.slice(0, 8)}…) — not a SOL sale. A follow with "follow them out another way" on sells the same share; any other copy stays open until its own exit rules close it.`,
  );
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

export function status(): Record<string, CopyWatchStatus> {
  const out: Record<string, CopyWatchStatus> = {};
  for (const [wallet, id] of wanted) {
    const s = statsFor(wallet);
    out[wallet] = {
      state: !running ? 'off' : s.overCap ? 'over-cap' : id !== null ? 'watching' : 'connecting',
      lastSeenAt: s.lastSeenAt,
      lastSwapAt: s.lastSwapAt,
      seen: s.seen,
      swaps: s.swaps,
      unreadable: s.unreadable,
      notSwap: s.notSwap,
      unseenExits: s.unseenExits,
      feed: method,
    };
  }
  return out;
}

function watch(wallet: string): void {
  if (!host || !wallet || wanted.has(wallet)) return;
  wanted.set(wallet, null);
  statsFor(wallet);
  if (!running) start();
  // One wallet past what a Parsed Streams socket takes moves everyone to
  // `logs` rather than leaving that one unwatched.
  else if (method === 'parsed' && wanted.size > PARSED_SUBS_PER_SOCKET) refreshTransport();
  else subscribe(wallet);
}

function unwatch(wallet: string): void {
  const id = wanted.get(wallet);
  wanted.delete(wallet);
  stats.delete(wallet);
  if (id != null) {
    bySub.delete(id);
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(unsubscribeFrame(method, nextId++, id));
      } catch {
        /* the socket is going away anyway */
      }
    }
  }
  if (!wanted.size) stop();
}

export function stop(): void {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (recoverTimer) clearInterval(recoverTimer);
  recoverTimer = null;
  // Re-learned on the next socket: the ceiling belonged to that connection.
  observedSubCap = null;
  pending.clear();
  bySub.clear();
  for (const w of wanted.keys()) wanted.set(w, null);
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  ws = null;
}

function start(): void {
  if (running || !host) return;
  const url = host.wssUrl();
  if (!url) {
    host.log('warn', 'wallet watcher: no websocket endpoint is configured, so followed wallets cannot be watched');
    return;
  }
  running = true;
  attempts = 0;
  if (!recoverTimer) recoverTimer = setInterval(recoverTick, RECOVER_TICK_MS);
  connect();
}

/** The Parsed Streams socket, when it may be used right now; else ''. */
function parsedUsable(): string {
  const url = host?.parsedWssUrl?.() ?? '';
  if (!url || Date.now() < parsedDeniedUntil || wanted.size > PARSED_SUBS_PER_SOCKET) return '';
  return url;
}

/**
 * Which transport, on which socket. `tx` on a keyed socket until this
 * session's key refuses it (it carries balances, so even a sell needs no
 * read-back); then `parsed` (free, decoded, no balances); then `logs`.
 */
function pickTransport(): { method: LeaderFeedMethod; url: string } | null {
  const url = host?.wssUrl() ?? '';
  if (!url) return null;
  if (keyed(url) && !txDenied) return { method: 'tx', url };
  const parsed = parsedUsable();
  if (parsed) return { method: 'parsed', url: parsed };
  return { method: 'logs', url };
}

/** Drop the current socket and open the one `pickTransport` names now. A
 *  resubscribe catches up on the gap, as after any reconnect. */
function switchSocket(why: string): void {
  host?.log('info', `wallet watcher: ${why}`);
  const old = ws;
  ws = null;
  pending.clear();
  bySub.clear();
  for (const w of wanted.keys()) wanted.set(w, null);
  try {
    old?.close();
  } catch {
    /* already gone */
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connect();
}

/**
 * Move to Parsed Streams when it became usable (the switch turned on, the
 * half-hour after a refusal ran out), or off it when it stopped being
 * (turned off, the credit budget spent, too many wallets). Cheap; the engine
 * calls it on its 1 s tick. Nothing else moves a live socket.
 */
export function refreshTransport(): void {
  if (!running || !host || !ws) return;
  const want = pickTransport();
  if (!want || (want.method === method && want.url === currentUrl)) return;
  if (method !== 'parsed' && want.method !== 'parsed') return;
  switchSocket(want.method === 'parsed' ? 'moving followed wallets to Helius Parsed Streams' : 'leaving Helius Parsed Streams for logsSubscribe');
}

function denyParsed(why: string): void {
  parsedDeniedUntil = Date.now() + PARSED_RETRY_MS;
  parsedFails = 0;
  if (ws) switchSocket(`Helius Parsed Streams is not working (${why}) — using logsSubscribe with a read-back per trade, and trying it again in 30 min`);
  else host?.log('info', `wallet watcher: Helius Parsed Streams is not working (${why}) — using logsSubscribe for 30 min`);
}

function connect(): void {
  if (!running || !host) return;
  const pick = pickTransport();
  if (!pick) {
    running = false;
    return;
  }
  const url = pick.url;
  const parked = socketParkRemainingMs(url);
  if (parked > 0) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, parked + Math.random() * 1_000);
    return;
  }
  currentUrl = url;
  // The push transport is tried on a keyed socket only, and not again once
  // this session's key has refused it.
  method = pick.method;
  const sockMethod = method;
  /** A subscription was acked on THIS socket. */
  let acked = false;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false });
  } catch (err) {
    scheduleReconnect((err as Error)?.message ?? 'socket failed');
    return;
  }
  ws = sock;

  let lastAlive = Date.now();
  let everPonged = false;
  let pingTimer: NodeJS.Timeout | null = null;
  const stopPing = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };
  sock.on('pong', () => {
    everPonged = true;
    lastAlive = Date.now();
  });

  sock.on('open', () => {
    lastAlive = Date.now();
    pingTimer = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (everPonged && Date.now() - lastAlive > SILENCE_MS) {
        try {
          sock.terminate();
        } catch {
          /* close handler reconnects */
        }
        return;
      }
      try {
        sock.ping();
      } catch {
        /* surfaces as close/error */
      }
    }, PING_MS);
    for (const s of stats.values()) s.overCap = false;
    for (const wallet of wanted.keys()) subscribe(wallet);
  });

  sock.on('message', (raw) => {
    lastAlive = Date.now();
    // A socket being replaced (switchSocket) can still deliver; its
    // subscription ids may name a different wallet on the new one.
    if (ws !== sock) return;
    let msg: {
      id?: number;
      result?: number | boolean;
      error?: { code?: number; message?: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { signature?: string; err?: unknown; logs?: string[] }; context?: { slot?: number } } };
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && msg.error) {
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      const text = msg.error.message ?? 'no reason given';
      if (req?.method === 'parsed' && ws === sock) {
        // Any refusal: a beta host is not argued with while a leader waits.
        denyParsed(text);
        return;
      }
      if (req?.method === 'tx' && !txDenied && isPlanRefusal(text, msg.error.code)) {
        // This key's plan does not serve transactionSubscribe. Every wallet
        // goes to Parsed Streams when it can be used — a socket of its own —
        // or back to logsSubscribe on this one, once, and the refusal is
        // remembered for the session.
        txDenied = true;
        if (parsedUsable()) {
          switchSocket(`this endpoint does not serve transactionSubscribe (${text}) — using Helius Parsed Streams`);
          return;
        }
        method = 'logs';
        host?.log('info', `wallet watcher: this endpoint does not serve transactionSubscribe (${text}) — using logsSubscribe with a read-back per trade`);
        pending.clear();
        for (const w of wanted.keys()) wanted.set(w, null);
        for (const w of wanted.keys()) subscribe(w);
        return;
      }
      const wallet = req?.wallet;
      if (wallet) {
        if (/too many|limit/i.test(text)) {
          statsFor(wallet).overCap = true;
          // Learn the real per-socket ceiling from the host rather than
          // assuming one: this many were accepted, the next was not.
          observedSubCap = Math.max(1, subCount());
        }
        host?.log('warn', `wallet watcher: subscribe rejected for ${wallet.slice(0, 6)}… — ${text}`);
      }
      return;
    }
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      attempts = 0;
      acked = true;
      if (sockMethod === 'parsed') parsedFails = 0;
      const wallet = pending.get(msg.id)?.wallet;
      pending.delete(msg.id);
      if (wallet && wanted.has(wallet)) {
        wanted.set(wallet, msg.result);
        bySub.set(msg.result, wallet);
        const st = statsFor(wallet);
        // A resubscribe means the last one stopped, and whatever the wallet
        // did in between was never delivered. The FIRST subscribe of a
        // session has no gap behind it.
        if (st.subscribed) void recoverGap(wallet, 'the subscription was re-established');
        st.subscribed = true;
      }
      return;
    }
    if (msg.method === 'transactionNotification') {
      attempts = 0;
      const n = parseTransactionNotification(msg);
      if (!n) return;
      const wallet = bySub.get(n.subscription);
      if (!wallet || !wanted.has(wallet)) return;
      // The transaction came with the push: decoded here, no read-back. A
      // push whose transaction does not parse falls back to the read-by-
      // signature path, so a shape change on the host's side costs a round
      // trip, never a trade.
      if (n.tx) onTransaction(wallet, n.signature, n.tx, n.slot);
      else void onNotification(wallet, n.signature, null);
      return;
    }
    if (msg.method === 'parsedTransactionNotification') {
      attempts = 0;
      host?.billEvents?.(1);
      const n = parseParsedNotification(msg);
      if (!n) return;
      const wallet = bySub.get(n.subscription);
      if (!wallet || !wanted.has(wallet)) return;
      // A clean curve buy is decoded from the push; anything else — a sell,
      // a route, a transfer — is read back by signature as on `logs`, only
      // ~120 ms sooner. A failed one is counted and dropped, as there.
      const swap = n.failed ? null : decodeParsedBuy(n.value, wallet);
      if (swap) onParsedBuy(wallet, n.signature, swap, n.slot);
      else void onNotification(wallet, n.signature, n.failed ? 'failed' : null, false, 'parsed');
      return;
    }
    if (msg.method !== 'logsNotification') return;
    attempts = 0;
    const sub = msg.params?.subscription;
    const value = msg.params?.result?.value;
    if (typeof sub !== 'number' || !value?.signature) return;
    const wallet = bySub.get(sub);
    if (!wallet || !wanted.has(wallet)) return;
    void onNotification(wallet, value.signature, value.err);
  });

  sock.on('close', () => {
    stopPing();
    if (ws !== sock) return;
    // A Parsed Streams socket that never got an ack, twice running, is a
    // beta host that is not there for us right now: ride `logs` instead.
    if (sockMethod === 'parsed' && !acked && ++parsedFails >= 2) {
      ws = null;
      denyParsed('it closed twice before accepting a subscription');
      scheduleReconnect('switching to logsSubscribe');
      return;
    }
    scheduleReconnect('socket closed');
  });
  sock.on('error', (err) => {
    stopPing();
    const why = (err as Error)?.message ?? 'socket error';
    noteSocketRejection(url, why);
    noteSocketRateLimit(url, why);
    if (ws === sock) scheduleReconnect(why);
  });
}

/** Live + in-flight subscriptions on the current socket. */
function subCount(): number {
  return [...wanted.values()].filter((v) => v !== null).length + pending.size;
}

function subscribe(wallet: string): void {
  if (ws?.readyState !== WebSocket.OPEN || !host) return;
  if (!keyed(currentUrl)) {
    const live = subCount();
    const ceiling = observedSubCap ?? SUB_GUARD;
    if (live >= ceiling) {
      statsFor(wallet).overCap = true;
      if (Date.now() - capNotedAt > 60_000) {
        capNotedAt = Date.now();
        host.log(
          'warn',
          observedSubCap === null
            ? `wallet watcher: holding at ${SUB_GUARD} wallet subscriptions on one socket — ${wallet.slice(0, 6)}… is not watched; unfollow someone to make room`
            : `wallet watcher: this socket refused a subscribe past ${observedSubCap} followed wallets (${VERIFIED_SUBS_PER_SOCKET} were verified to work) — ${wallet.slice(0, 6)}… is not watched`,
        );
      }
      return;
    }
  }
  const id = nextId++;
  pending.set(id, { wallet, method });
  try {
    // Confirmed on both transports (leaderFeedFrames.ts): on `logs` the
    // transaction is read back at confirmed, and a processed notification
    // would only be asked for before it can be answered; on `tx` a processed
    // push could describe a transaction that never lands.
    ws.send(subscribeFrame(method, id, wallet));
  } catch {
    pending.delete(id);
  }
}

/** Signatures given a second round of reads after every endpoint refused
 *  the first (2026-10-28). One more round each, never a loop. */
const reread = new Set<string>();
/** How long the second round waits, so a short outage can pass. */
const REREAD_DELAY_MS = 30_000;

function remember(signature: string): boolean {
  if (seen.has(signature)) return false;
  seen.add(signature);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/**
 * A transaction that arrived WITH its notification (the `tx` transport):
 * the same decode as a read-back, minus the read-back and its retries.
 */
function onTransaction(wallet: string, signature: string, tx: RawTransaction, pushSlot: number | null = null): void {
  const h = host;
  if (!h) return;
  const detectedAt = Date.now();
  const s = statsFor(wallet);
  s.seen += 1;
  s.lastSeenAt = detectedAt;
  if (tx.meta?.err) return;
  if (!remember(signature)) return;
  const decodeStart = Date.now();
  const swap = decodeWalletSwap(tx, wallet);
  const decodeMs = Date.now() - decodeStart;
  if (!swap) {
    s.notSwap += 1;
    noteUnseenExit(h, s, tx, wallet, signature);
    return;
  }
  s.swaps += 1;
  s.lastSwapAt = Date.now();
  const blockTime = tx.blockTime;
  const tradeAt = typeof blockTime === 'number' && blockTime > 0 ? blockTime * 1_000 : null;
  h.onSwap({
    wallet,
    swap,
    signature,
    at: Date.now(),
    // A push carries no block time. Null is "undated", which the copier
    // treats as now — and with the transaction delivered as it lands, that
    // is close to true. The `logs` path still dates by the block it reads.
    tradeAt,
    timing: {
      feed: 'tx',
      // Usually null here, and honestly so: without a block time there is
      // nothing to measure the delivery against. It is not zero.
      detectMs: tradeAt === null ? null : Math.max(0, detectedAt - tradeAt),
      readMs: null, // the whole point of this transport
      readTries: 0,
      decodeMs,
      detectedAt,
      slot: typeof pushSlot === 'number' && pushSlot > 0 ? pushSlot : typeof tx.slot === 'number' && tx.slot > 0 ? tx.slot : null,
    },
  });
}

/**
 * A buy decoded from a Parsed Streams push (leaderFeedFrames.decodeParsedBuy):
 * delivered as the `tx` transport delivers, with no read-back.
 */
function onParsedBuy(wallet: string, signature: string, swap: WalletSwap, slot: number | null): void {
  const h = host;
  if (!h) return;
  const detectedAt = Date.now();
  const s = statsFor(wallet);
  s.seen += 1;
  s.lastSeenAt = detectedAt;
  if (!remember(signature)) return;
  s.swaps += 1;
  s.lastSwapAt = detectedAt;
  h.onSwap({
    wallet,
    swap,
    signature,
    at: detectedAt,
    // The push carries no block time either; undated, as on `tx`.
    tradeAt: null,
    timing: {
      feed: 'parsed',
      detectMs: null,
      readMs: null,
      readTries: 0,
      decodeMs: 0,
      detectedAt,
      slot: typeof slot === 'number' && slot > 0 ? slot : null,
    },
  });
}

async function onNotification(wallet: string, signature: string, err: unknown, recovered = false, feed: LeaderFeedMethod = 'logs'): Promise<void> {
  const h = host;
  if (!h) return;
  const s = statsFor(wallet);
  const detectedAt = Date.now();
  if (!recovered) {
    s.seen += 1;
    s.lastSeenAt = detectedAt;
  }
  if (err) return;
  if (!remember(signature)) return;
  // A just-confirmed transaction can take a beat to be readable, and a
  // rate-limited host can take a great deal longer than a beat.
  let why = 'not readable';
  const readStart = Date.now();
  // A REFUSED read (429, 5xx, timeout) moves to the other endpoint, and they
  // alternate from then on; "the node does not have it yet" stays put,
  // because that is indexing lag, not the budget.
  // A primary whose window is already spent would queue this read for
  // seconds; start on the second endpoint instead.
  const fb0 = h.readFallbackUrl?.() ?? '';
  let onFallback = !!fb0 && fb0 !== h.httpUrl() && budgetWaitMs(h.httpUrl(), 'getTransaction') > READ_QUEUE_TOLERANCE_MS;
  let refused = false;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (!wanted.has(wallet)) return;
    const fallback = h.readFallbackUrl?.() ?? '';
    const url = onFallback && fallback ? fallback : h.httpUrl();
    const res = await getTransaction(url, signature);
    if (res.ok && res.data) {
      // The read-back INCLUDING every retry and the sleeps between them —
      // which is the number worth seeing, because a second attempt costs
      // 700 ms of deliberate backoff before the request is even sent.
      const readMs = Date.now() - readStart;
      const decodeStart = Date.now();
      const swap = decodeWalletSwap(res.data, wallet);
      const decodeMs = Date.now() - decodeStart;
      if (!swap) {
        s.notSwap += 1;
        noteUnseenExit(h, s, res.data, wallet, signature);
        return;
      }
      s.swaps += 1;
      s.lastSwapAt = Date.now();
      // WHEN THEY TRADED, not when we read it. A recovered transaction can
      // be many minutes old, and the copier decides what to do about that.
      const blockTime = res.data.blockTime;
      const tradeAt = typeof blockTime === 'number' && blockTime > 0 ? blockTime * 1_000 : null;
      h.onSwap({
        wallet,
        swap,
        signature,
        at: Date.now(),
        tradeAt,
        timing: {
          feed,
          // A RECOVERED transaction can be minutes old through no fault of
          // the delivery path, so it is not timed at all — averaging those
          // in would make the feed look far worse than it is.
          detectMs: recovered || tradeAt === null ? null : Math.max(0, detectedAt - tradeAt),
          readMs,
          readTries: attempt + 1,
          decodeMs,
          detectedAt,
          slot: typeof res.data.slot === 'number' && res.data.slot > 0 ? res.data.slot : null,
        },
      });
      return;
    }
    why = res.ok ? 'the node does not have it yet' : res.message;
    refused = !res.ok;
    if (!res.ok && fallback && fallback !== h.httpUrl()) onFallback = !onFallback;
    // Short at the front, patient at the tail — see FETCH_BACKOFF_MS. A
    // parked host is not helped by fast retries either way, because
    // `rpcClient` waits out its own park inside the call above.
    const gap = FETCH_BACKOFF_MS[attempt] ?? FETCH_BACKOFF_MS[FETCH_BACKOFF_MS.length - 1];
    await new Promise((r) => setTimeout(r, gap));
  }
  // Silence here was the bug: a leader trade that is KNOWN to have happened
  // and could not be read is a copy that will not fire, and the user had no
  // way to know it. It stays in `seen`, so a later catch-up will not re-chase
  // a transaction this endpoint cannot serve. Counted too, so the wallet's
  // status line shows "N unreadable" instead of a swap count that quietly
  // stopped moving (the v1 outage was found from this line in the Console).
  // The endpoints REFUSED it (429s, 5xx, timeouts) rather than not having
  // it: an outage, which passes. One more round after a pause, so a leader's
  // sell during a short outage is not lost for good (2026-10-28).
  if (refused && !reread.has(signature)) {
    reread.add(signature);
    if (reread.size > SEEN_CAP) {
      const oldest = reread.values().next().value;
      if (oldest !== undefined) reread.delete(oldest);
    }
    seen.delete(signature);
    h.log('warn', `wallet watcher: could not read ${wallet.slice(0, 6)}…'s transaction ${signature.slice(0, 8)}… — ${why}. Trying again in ${REREAD_DELAY_MS / 1_000} s.`);
    const t = setTimeout(() => {
      if (wanted.has(wallet)) void onNotification(wallet, signature, null, true, feed);
    }, REREAD_DELAY_MS);
    t.unref?.();
    return;
  }
  s.unreadable += 1;
  h.log('warn', `wallet watcher: could not read ${wallet.slice(0, 6)}…'s transaction ${signature.slice(0, 8)}… — ${why}. That trade was not copied.`);
  h.onUnreadable?.(wallet, signature);
}

/**
 * Read what a followed wallet did recently and put anything unseen through
 * the live path.
 *
 * Bounded three ways: at most `RECOVER_LIMIT` signatures, nothing older than
 * `RECOVER_WINDOW_MS`, and everything already in `seen` dropped before a
 * single transaction is fetched. Oldest first, so a buy and the sell that
 * followed it arrive in the order they happened.
 */
async function recoverGap(wallet: string, why: string): Promise<void> {
  const h = host;
  if (!h || !wanted.has(wallet)) return;
  const s = statsFor(wallet);
  s.recoveredAt = Date.now();
  const res = await getSignaturesForAddress(h.httpUrl(), wallet, RECOVER_LIMIT);
  if (!res.ok || !res.data) {
    h.log('warn', `wallet watcher: could not catch up on ${wallet.slice(0, 6)}… (${why}) — ${res.message}`);
    return;
  }
  const floor = Date.now() - RECOVER_WINDOW_MS;
  const missed = res.data
    .filter((x) => !x.err && !seen.has(x.signature))
    .filter((x) => typeof x.blockTime !== 'number' || x.blockTime * 1_000 >= floor)
    .reverse();
  if (!missed.length) return;
  h.log('info', `wallet watcher: catching up on ${missed.length} transaction(s) from ${wallet.slice(0, 6)}… (${why})`);
  for (const x of missed) {
    if (!wanted.has(wallet)) return;
    await onNotification(wallet, x.signature, x.err, true);
  }
}

/**
 * One wallet per tick, least recently checked first.
 *
 * A live subscription can stop delivering while the socket stays open and
 * every health check passes — there is no ack for "you are still getting my
 * notifications". This is the cheap standing answer to that: following ten
 * leaders costs one `getSignaturesForAddress` a minute, and each wallet is
 * re-checked every `RECOVER_EVERY_MS`.
 */
function recoverTick(): void {
  if (!running || ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [wallet, id] of wanted) {
    if (id === null) continue;
    const at = statsFor(wallet).recoveredAt;
    if (now - at < RECOVER_EVERY_MS) continue;
    if (at < oldestAt) {
      oldestAt = at;
      oldest = wallet;
    }
  }
  if (oldest) void recoverGap(oldest, 'routine check that nothing was missed');
}

function scheduleReconnect(why: string): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!running) return;
  pending.clear();
  bySub.clear();
  for (const w of wanted.keys()) wanted.set(w, null);
  attempts += 1;
  if (attempts === 1) host?.log('warn', `wallet watcher: ${why}; reconnecting`);
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
  reconnectTimer = setTimeout(connect, Math.round(base * (0.75 + Math.random() * 0.5)));
}

/** Test seam. */
export function _reset(): void {
  txDenied = false;
  parsedDeniedUntil = 0;
  parsedFails = 0;
  method = 'logs';
  stop();
  wanted.clear();
  stats.clear();
  seen.clear();
  attempts = 0;
  currentUrl = '';
  capNotedAt = 0;
  observedSubCap = null;
}
