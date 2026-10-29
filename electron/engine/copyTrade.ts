// Copy trading — paper by default, live only on deliberate opt-in.
//
// The shape mirrors `advOrders`: a host injects execution and gating, the
// module only notices things and decides. What is different is the default —
// a copy config starts in PAPER mode, and the paper record is kept with the
// same rigour as a real one so the switch to live is made against evidence.
//
// Paper fills here are priced from the tape at the moment we would have
// traded, INCLUDING the configured delay. That matters: copying is a latency
// game, and a paper record that fills at the follower's price rather than at
// the price N milliseconds later is the exact self-flattery that makes
// copy-trading look profitable when it is not.

import fs from 'node:fs';
import type { ScoutSort } from '@shared/scoutSort';
import { type ChainKind, nativeSymbolOf } from '@shared/evm';
import { logger } from '../system/logger';
import path from 'node:path';
import {
  directionOf,
  ownExitsOf,
  fomoRuleOf,
  isFomo,
  isWatch,
  activeWindowOf,
  inActiveWindow,
  localMinuteOfDay,
  fmtClock,
  FOMO_SOURCE_LABEL,
  FOMO_WALLET,
  copySize,
  DEFAULT_COPIES_PER_MINUTE,
  COPY_FAIL_PAUSE,
  COPY_LATENCY_FLOOR_MS,
  MIGRATION_RETRY_MS,
  MIGRATION_WAIT_MAX_MS,
  curveMigrating,
  MIN_LIVE_COPY_SOL,
  emptyLeaderStats,
  validateConfig,
  type CopyConfig,
  type CopyMode,
  type CopySnapshot,
  type CopyStats,
  type CopyTrade,
  type CopyWatchStatus,
  type LeaderRoundTrip,
  type LeaderStats,
  type CopyTiming,
  type CopyLatency,
  copyLatency,
  describeCopyTiming,
  PAPER_MODEL,
  paperExitPnl,
  chainOf, isBlocked, isDustRemainder, rawOf, uiTokens } from '@shared/copytrade';
import type { DeliveryTiming } from './walletWatcher';
import * as recorder from './recorder';
import { traderClaimFor } from './traderClaims';
import {
  AI_HOLD_QUIET_MS,
  EXIT_RULE_TEXT,
  QUIETED_BY_HOLD,
  aiGateOn,
  exitAsks,
  type AiAnswer,
  type AiEntryRequest,
  type AiExitRequest,
  type AiRequest,
  type ExitRule,
} from '@shared/aiDesk';
// Re-exported for the test bundle, which has its own copy of the module.
export { setTraderClaimCheck } from './traderClaims';

const FILE = 'copytrade.json';
const MAX_TRADES = 2_000;
const MAX_CONFIGS = 25;

let configs: CopyConfig[] = [];
let trades: CopyTrade[] = [];
/** Per followed wallet: THEIR positions and round trips (see below). */
let leaders: Record<string, LeaderBook> = {};
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Set when the store existed but could not be read; persisting stays off. */
let loadFailure: string | null = null;
/**
 * When this session loaded the book (2026-10-22); 0 before `init`.
 *
 * A copy opened before it spent the downtime unwatched, so its own exits
 * resume the way an advanced order does after a restart (order-safety rule
 * 3): the trailing stop's peak starts again from the first price seen now,
 * and a maximum hold counts from now. Firing either off the unobserved
 * window would sell on a high nobody saw, or dump a bag at boot because the
 * clock ran while the app was shut.
 */
let bootAt = 0;
const resumedRow = (r: CopyTrade): boolean => bootAt > 0 && r.at < bootAt;
/** Bumped on every change to the book, so the watch list can be cached
 *  against it instead of rebuilt for every trade on the pump firehose. */
let bookVersion = 0;

/** What a host may tell us about an execution it just ran. */
export interface CopyExecResult {
  ok: boolean;
  message: string;
  signature?: string;
  /** Broadcast, not yet confirmed. The position is real (copy-5). */
  pending?: boolean;
  /** SOL actually spent, when the host knows it. Trusted over the request. */
  spentSol?: number;
  /** The fill price in SOL per token, when the host knows it. */
  fillPriceSol?: number;
  /** Base units the fill moved, when the host already knows them. Usually it
   *  does not — reconciliation is a round trip behind the broadcast — and
   *  `fillTokens` is then the way to ask for the number once it exists. */
  filledRaw?: string;
  /** Decimals for `filledRaw`. */
  tokenDecimals?: number;
  /**
   * The signer's own breakdown of the order (2026-09-21), so a copy's timing
   * line can say how much of the send was building and how much was waiting
   * for the chain. A host that does not measure itself leaves it out, and
   * those fields read as unknown.
   */
  timing?: { build?: number; confirm?: number };
}

/** What the chain says one of our fills did, once the ledger has read it. */
export interface FillRead {
  /** Base units of the mint the fill moved, unsigned. */
  raw: string;
  decimals: number;
  /**
   * The wallet's net SOL change, SIGNED, fees and tips included (2026-10-22):
   * negative for a buy, normally positive for a sell. The record is priced
   * from this, never from the leader's price. Absent when the host cannot
   * say (the EVM rails), which leaves the row's PnL unknown.
   */
  sol?: number | null;
  /** The slot the fill landed in, for the slot gap. Absent = unknown. */
  slot?: number | null;
  /** The network fee and rent inside `sol`, SOL, when the ledger knows them.
   *  Taken out of the price the exit rules measure from. */
  overheadSol?: number | null;
}

/** Per-execution overrides. A host free to ignore them still type-checks. */
export interface CopyExecOpts {
  /** This config's `maxSlippagePct`, which the host is asked to honour. */
  slippagePct?: number;
  /** The wallet this config signs with; absent = the active wallet. */
  walletId?: string;
  /** The chain the copy goes out on; absent = Solana. */
  chain?: ChainKind;
  /**
   * Sell EXACTLY this many base units (2026-09-15).
   *
   * `sell` takes a percentage of the whole token account, which is the wrong
   * unit for a mirror: the copier knows how many tokens the copy holds, and
   * converting that to a percentage of a balance that includes other bags —
   * and then to an integer — is where the quantity went missing. A host that
   * honours this sizes from the number; one that cannot is free to ignore it
   * and use `pct`, which is always passed alongside as the best percentage
   * equivalent the copier could compute.
   */
  tokensRaw?: string;
}

export interface CopyHost {
  /** Fire a real buy. Only called for a `live` config. */
  buy(mint: string, sol: number, opts?: CopyExecOpts): Promise<CopyExecResult>;
  /** Sell `pct`% of what THIS wallet holds of `mint`. Only called for a
   *  `live` config, and only a confirmed fill may answer `ok`. */
  sell(mint: string, pct: number, opts?: CopyExecOpts): Promise<CopyExecResult>;
  /** Why a LIVE copy cannot execute, or null. Paper ignores this. */
  liveBlockedReason(chain?: ChainKind): string | null;
  /**
   * Why the EXIT of a live copy already bought cannot go out, or null
   * (2026-10-28). Absent = `liveBlockedReason`. A breaker that switched live
   * off (a loss limit, a program upgrade, decoder drift) stops entries and
   * must never trap a position it already holds.
   */
  exitBlockedReason?(chain?: ChainKind): string | null;
  /**
   * Why a LIVE BUY specifically cannot execute, or null (copy-11).
   *
   * `liveBlockedReason` deliberately omits the entry breakers — an exit must
   * stay possible while entries are paused — so without this a copy would
   * open a position during a decoder hard-pause or on a stale feed. Optional:
   * a host that does not implement it is treated as "nothing extra to say".
   */
  buyBlockedReason?(chain?: ChainKind): string | null;
  /**
   * What THIS wallet paid for everything it holds of `mint`, SOL (copy-2).
   *
   * A sell is placed as a percentage of the whole token account, so mirroring
   * "they sold 40 %" as 40 % sells 40 % of a hand-bought bag too. With this,
   * the percentage is scaled by the copy's share of our own basis. Null or
   * absent means "unknown", and the percentage is used unscaled.
   */
  ourCostBasisSol?(mint: string, chain?: ChainKind): number | null;
  /**
   * How much of `mint` the LEADER holds right now, in whole tokens, or null
   * when it cannot be read.
   *
   * The rescue path for an unreadable sell size. `soldFraction` is decoded
   * from the transaction's pre-balances, and those carry an `owner` only on
   * newer RPC replies — when the owner is missing the pre-balance reads 0,
   * the fraction comes out null, and the mirror used to give up and sell
   * NOTHING. That is the failure a user named as the worst of the lot
   * (2026-09-13): "when someone sells and they can't tell how much it is, it
   * just doesn't sell".
   *
   * One read fixes it exactly, with no guessing: their holding AFTER the
   * sell, plus the tokens the sell moved, IS what they held before, so
   * `sold / (after + sold)` is the true fraction — and `after ≈ 0` is a full
   * exit, the case that matters most.
   */
  leaderHolding?(wallet: string, mint: string, chain?: ChainKind, opts?: { minContextSlot?: number }): Promise<number | null>;
  /** The live per-trade ceiling, SOL. A copy over it is REFUSED (copy-8). */
  maxLiveSol?(chain?: ChainKind): number | null;
  /** Open copies allowed across every follow, per mode (2026-10-23); 0 or
   *  null = no ceiling. A copy that would open one more is refused. */
  maxOpenCopies?(): number | null;
  /**
   * Tell the user even when the app is not in front of them (2026-10-23):
   * the engine's notify — the desktop pop-up, the paired chat bots, a
   * webhook — each behind its own switch. Only what needs a person goes
   * here, and at most NOTIFY_PER_HOUR an hour (alertUser).
   */
  notify?(title: string, body: string): void;
  /** Current spot price in SOL for a mint, if known. */
  priceSol(mint: string, chain?: ChainKind): number | null;
  /** Token facts used by the filters. `createdAt` (ms) and `creator` feed
   *  the 2026-09-21 age and creator filters; a host that cannot say leaves
   *  them absent, which those filters read as unknown and refuse on. */
  tokenFacts(mint: string, chain?: ChainKind): Promise<{ liquidityUsd: number | null; marketCapUsd: number | null; kryptScore: number | null; isPumpfun: boolean; createdAt?: number | null; creator?: string | null }>;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void;
  changed(): void;
  /**
   * The AI desk (2026-10-28, electron/engine/aiDesk.ts). `aiAsk` resolves
   * with the AI's verdict or why there is none — at once when no AI is
   * connected — and never rejects. Absent = no desk: nothing is asked and a
   * gated follow behaves as if the AI never answered.
   */
  aiAsk?(req: AiRequest): Promise<AiAnswer>;
  aiNewId?(): string;
  /** What the follow did with the answer, for the AI page's log. */
  aiSettled?(req: AiRequest, answer: AiAnswer, result: string): void;
  /** Withdraw a pending decision — the follow was paused, removed or
   *  switched mode, or a protective exit fired. Its asker gets `cancelled`. */
  aiCancel?(id: string, why: string): void;
  /** A line for the AI's event feed. */
  aiNote?(kind: 'leader_trade' | 'copy', text: string, data: Record<string, unknown>): void;
  /**
   * Base units of `mint` the wallet this config signs with holds RIGHT NOW,
   * with the mint's decimals. Null when it cannot be read.
   *
   * The chain is the only authority on what is actually there. It sizes an
   * exit, it settles one, and it is what the leftover sweep compares our
   * book against. An unreadable balance is never zero and never "all of it".
   */
  walletTokens?(mint: string, opts?: CopyExecOpts): Promise<{ raw: string; decimals: number } | null>;
  /**
   * Base units a CONFIRMED fill moved, once the chain has been read for it.
   *
   * May wait for reconciliation — the caller is always off the hot path —
   * and answers null when the signature never settles. Null is "I do not
   * know how much moved", which leaves the copy's quantity untouched rather
   * than guessed.
   */
  fillTokens?(signature: string, opts?: CopyExecOpts): Promise<FillRead | null>;
  /**
   * The confirmed BUY of `mint` this install made around `atMs`, in base
   * units — the ledger's own record of a copy whose signature we never kept.
   *
   * Only the host can answer it: the ledger knows what this install actually
   * traded, and with which wallet. It must REFUSE an ambiguous match rather
   * than pick one, because the number it returns goes on to size a real
   * sell, and "unknown" already has a safe meaning everywhere below.
   */
  buyFill?(mint: string, atMs: number, opts?: CopyExecOpts): Promise<{ raw: string; decimals: number } | null>;
  /** The wallet watcher's per-wallet status, for the snapshot. Solana only:
   *  that is the rail with a subscription per wallet. */
  watchStatus?(): Record<string, CopyWatchStatus>;
  /**
   * Is the leader feed for this chain actually running?
   *
   * Solana watches a wallet directly, one subscription each. The EVM chains
   * have no such thing — a followed wallet there is seen only through that
   * chain's SCANNER poll, which the user starts. An armed config on a
   * stopped scanner is a follower that watches nothing, and until 2026-09-15
   * the panel had no way to say so. Null = the host cannot tell.
   */
  leaderFeed?(chain: ChainKind): { running: boolean; lastPollAt: number | null } | null;
  /**
   * FOMO crowd sources (2026-09-20): the wallets saved on the Scout, the
   * tracked-wallet list, and the Scout's top N by Copy score. Absent = an
   * empty set — a config on a source the host cannot answer never fires.
   */
  scoutSaved?(chain: ChainKind): string[];
  /** The Scout's top `n` on `chain` by a board sort (2026-10-28). */
  scoutTop?(chain: ChainKind, n: number, sort: ScoutSort): string[];
  trackedWallets?(chain: ChainKind): string[];
}

let host: CopyHost | null = null;

export function attach(h: CopyHost): void {
  host = h;
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  configs = [];
  trades = [];
  leaders = {};

  // Fail CLOSED: "I could not read the file" is not "there is no file"
  // (copy-6). A missing file is a first run; anything else means configs,
  // history and the leaders' record may still be on disk, and overwriting
  // them with an empty document destroys them. When the read fails the file
  // becomes read-only for the session and every persist is a no-op — same
  // shape as `ledger.init`.
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      console.warn(`[sniper] copy: ${loadFailure} — copy trading is read-only this session`);
    }
    return;
  }
  try {
    const raw = JSON.parse(text) as {
      version: 1;
      configs: CopyConfig[];
      trades: CopyTrade[];
      leaders?: Record<string, LeaderBook>;
      pendingExits?: Array<{ key: string; trade: WalletTrade }>;
    };
    configs = Array.isArray(raw?.configs) ? raw.configs : [];
    trades = Array.isArray(raw?.trades) ? raw.trades : [];
    leaders = raw?.leaders && typeof raw.leaders === 'object' && !Array.isArray(raw.leaders) ? raw.leaders : {};
    for (const row of Array.isArray(raw?.pendingExits) ? raw.pendingExits : []) {
      if (row && typeof row.key === 'string' && row.trade && typeof row.trade.mint === 'string') {
        restoredExits.set(row.key, row.trade);
      }
    }
  } catch (e) {
    configs = [];
    trades = [];
    leaders = {};
    loadFailure = `${filePath} is corrupt (${(e as Error).message})`;
    console.warn(`[sniper] copy: ${loadFailure} — copy trading is read-only this session`);
  }

  bookVersion += 1;
  bootAt = Date.now();
  // Every copy still open was unwatched while the app was shut, so the high
  // its trailing stop would measure from is a high nobody saw. It starts
  // again from the first price this session sees (see `bootAt`).
  for (const t of trades) if (t.state === 'open' && t.kind !== 'exit') delete t.peakPriceSol;

  // A LIVE config never survives a restart armed. Same reasoning as orders:
  // an app that was closed for a week must not resume spending on wake.
  // Paper configs do resume, because paper costs nothing and an interrupted
  // experiment is a useless one. Disarming stops ENTRIES only: the copies
  // it already holds are still followed out (`managesExits`).
  let disarmed = 0;
  for (const c of configs) {
    if (c.mode === 'live' && c.enabled) {
      c.enabled = false;
      disarmed += 1;
    }
  }
  if (!loadFailure) {
    logger.info(
      `copy: loaded ${configs.length} config(s), ${trades.length} record(s)` +
        (disarmed > 0 ? ` — ${disarmed} LIVE config(s) disarmed on restart` : ''),
    );
  }
}

/** Why the store could not be read, or null. Persisting is off while set. */
export function failure(): string | null {
  return loadFailure;
}

function persist(): void {
  bookVersion += 1;
  if (!filePath || loadFailure) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 300);
}

/**
 * Write a pending save now (2026-10-28). Called on quit: the save rides a
 * 300 ms debounce, and a copy recorded inside that window — a live buy that
 * just landed — came back after a restart with no row and no exits.
 */
export function flushSync(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}

/** Set on quit: nothing new is bought while the app closes. */
let closing = false;

/**
 * The app is quitting (2026-10-28): stop starting copies, and wait — bounded
 * — for the live buys already sent and the exits already running, so a quit
 * never cuts one between the broadcast and its record. Resolves at once when
 * nothing is under way.
 */
export async function drainForQuit(timeoutMs: number): Promise<void> {
  closing = true;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const sending = [...buysInFlight.values()].some((f) => f.submitted);
    if (!sending && exitChains.size === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  flushSync();
}

function writeNow(): void {
  {
    // _reset() can blank the path while this timer is pending; writing then
    // landed a stray `.tmp` in the working directory.
    if (!filePath) return;
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            version: 1,
            configs,
            // Already trimmed; may run past MAX_TRADES only with rows that
            // still manage a position (trimTrades).
            trades,
            leaders,
            // A sell the leader made while our buy was in flight is an
            // INSTRUCTION, not a cache. Losing it to a crash or a quit is
            // the same bug as dropping it in memory: the position stays
            // open and nothing remembers it was meant to close.
            pendingExits: [...pendingExits.entries()].map(([key, trade]) => ({ key, trade })),
          },
          null,
          2,
        ),
        'utf8',
      );
      fs.renameSync(tmp, filePath);
    } catch {
      /* memory stays authoritative */
    }
  }
}

let seq = 0;
const nextId = (p: string): string => {
  seq += 1;
  return `${p}_${Date.now().toString(36)}_${seq.toString(36)}`;
};

// ── Config CRUD ───────────────────────────────────────────────────────

export function upsert(input: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }): { ok: boolean; message: string } {
  forgetCrowdSources();
  if (chainOf(input) !== 'solana') input = { ...input, wallet: input.wallet.trim().toLowerCase() };
  const v = validateConfig(input);
  if (!v.ok) return { ok: false, message: v.message };

  if (input.id) {
    const existing = configs.find((c) => c.id === input.id);
    if (!existing) return { ok: false, message: 'Config not found' };
    const wasLive = existing.mode === 'live' && existing.enabled;
    const wasEnabled = existing.enabled;
    const wasMode = existing.mode;
    // Moving to live always disarms first — the same rule scripts follow, and
    // the one the Wallets page has always claimed. Enforced HERE, in main, so
    // one `copy:save` call can never create an armed live follower.
    const toLive = existing.mode !== 'live' && input.mode === 'live';
    const turningOn = !existing.enabled && input.enabled === true;
    // The wallet a live copy was bought with is the one its exits sell from
    // (2026-10-28): changing it with copies open stranded them.
    if ((input.walletId ?? null) !== (existing.walletId ?? null)) {
      const open = trades.filter((t) => t.configId === existing.id && t.mode === 'live' && t.state === 'open' && t.kind !== 'exit').length;
      if (open > 0) {
        return { ok: false, message: `This follow has ${open} live cop${open === 1 ? 'y' : 'ies'} open in its current wallet. Its exits sell from that wallet, so it can move to another once ${open === 1 ? 'it closes' : 'they close'}.` };
      }
    }
    Object.assign(existing, input);
    if (toLive) existing.enabled = false;
    // Switched on by the user: an engine pause is over, and the per-wallet
    // stop counts from now — the losses that tripped it are not counted again.
    if (turningOn && existing.enabled) clearPause(existing);
    // A question the AI is still thinking about was asked of the follow as
    // it was. A new mode withdraws them all; a pause withdraws the entries.
    if (existing.mode !== wasMode) withdrawAsks((a) => a.configId === existing.id, `the follow was switched to ${existing.mode}`);
    else if (wasEnabled && !existing.enabled) withdrawAsks((a) => a.configId === existing.id && a.kind === 'entry', 'the follow was paused');
    persist();
    host?.changed();
    if (!wasLive && existing.mode === 'live' && existing.enabled) {
      host?.toast('warn', `LIVE copy trading armed for ${existing.label || existing.wallet.slice(0, 6)} — real SOL will be spent`);
    }
    return { ok: true, message: toLive ? 'Saved as live — re-enable it to arm it' : 'Saved' };
  }

  if (configs.length >= MAX_CONFIGS) return { ok: false, message: `Limit of ${MAX_CONFIGS} configs reached` };
  // The same address on another chain is another leader (2026-09-11).
  if (configs.some((c) => c.wallet === input.wallet && chainOf(c) === chainOf(input))) {
    return { ok: false, message: 'You are already following that wallet on that chain' };
  }
  const c: CopyConfig = { ...input, id: nextId('cp'), createdAt: Date.now(), lossStopFrom: Date.now(), pausedReason: null, pausedAt: null };
  // A brand-new live follower is never born armed.
  const bornLive = c.mode === 'live' && c.enabled;
  if (bornLive) c.enabled = false;
  configs.unshift(c);
  persist();
  host?.changed();
  return {
    ok: true,
    message: bornLive
      ? `Following ${c.label || c.wallet.slice(0, 6)} — live, disarmed. Enable it when ready.`
      : `Following ${c.label || c.wallet.slice(0, 6)}`,
  };
}

export function remove(id: string): { ok: boolean; message: string } {
  const before = configs.length;
  const gone = configs.find((c) => c.id === id);
  configs = configs.filter((c) => c.id !== id);
  if (configs.length === before) return { ok: false, message: 'Config not found' };
  withdrawAsks((a) => a.configId === id, 'the follow was removed');
  trades = trades.filter((t) => t.configId !== id);
  // Runtime state dies with the config (copy-9): an exit chain keyed to it
  // would otherwise pin the map forever, and a reservation it never released
  // would count against a config that no longer exists.
  for (const key of [...exitChains.keys()]) {
    if (key.startsWith(`${id}:`)) exitChains.delete(key);
  }
  pendingCopies.delete(id);
  recentCopies.delete(id);
  for (const key of [...buysInFlight.keys()]) if (key.startsWith(`${id}:`)) buysInFlight.delete(key);
  for (const key of [...pendingExits.keys()]) if (key.startsWith(`${id}:`)) pendingExits.delete(key);
  for (const key of [...staleBuys]) if (key.startsWith(`${id}:`)) staleBuys.delete(key);
  for (const key of [...restoredExits.keys()]) if (key.startsWith(`${id}:`)) restoredExits.delete(key);
  for (const key of [...supersededSkips.keys()]) {
    if (key.startsWith(`${id}:`)) supersededSkips.delete(key);
  }
  for (const key of [...mirroredSells.keys()]) if (key.startsWith(`${id}:`)) mirroredSells.delete(key);
  // Their record goes with the last config that followed them.
  if (gone && !configs.some((c) => c.wallet === gone.wallet)) delete leaders[gone.wallet];
  persist();
  host?.changed();
  return { ok: true, message: 'Stopped following' };
}

/**
 * Clear PAPER results only — one config, or every config.
 *
 * "Remove" was the only way to start a paper record over, and it takes the
 * config, the live history and the leader's own record with it (a user
 * verified the leader stats went too, 2026-09-13). Those are three different
 * things and only one of them was being asked for.
 *
 * Kept, deliberately: every config and its settings, the live/paper switch,
 * live rows (they describe real money that really moved — a scorecard reset
 * must never rewrite them), leader statistics (their record is theirs, not
 * a function of your paper run), and anything the wallet actually holds.
 *
 * Open paper rows go too. A paper position is a simulation with no claim on
 * anything, and leaving half a run behind would make the next scorecard a
 * mix of two experiments.
 */
export function resetPaper(configId?: string): { ok: boolean; message: string; cleared: number } {
  if (configId !== undefined && !configs.some((c) => c.id === configId)) {
    return { ok: false, message: 'Config not found', cleared: 0 };
  }
  const before = trades.length;
  trades = trades.filter((t) => {
    if (t.mode !== 'paper') return true;
    return configId !== undefined && t.configId !== configId;
  });
  const cleared = before - trades.length;
  // Paper rows carry no runtime state a live row needs, but a parked exit or
  // an abandoned buy keyed to a config whose paper rows just vanished has
  // nothing left to apply to.
  for (const c of configs) {
    if (configId !== undefined && c.id !== configId) continue;
    if (c.mode !== 'paper') continue;
    for (const key of [...pendingExits.keys()]) if (key.startsWith(`${c.id}:`)) pendingExits.delete(key);
    for (const key of [...staleBuys]) if (key.startsWith(`${c.id}:`)) staleBuys.delete(key);
  }
  persist();
  host?.changed();
  const who = configId === undefined ? 'every followed wallet' : (configs.find((c) => c.id === configId)?.label || 'that wallet');
  host?.log('info', `copy: cleared ${cleared} paper row${cleared === 1 ? '' : 's'} for ${who}`);
  return {
    ok: true,
    message:
      cleared === 0
        ? 'No paper results to clear.'
        : `Cleared ${cleared} paper row${cleared === 1 ? '' : 's'} for ${who}. Settings, live history and leader records are untouched.`,
    cleared,
  };
}

export function all(): CopyConfig[] {
  return configs.map((c) => ({ ...c }));
}

// ── Who is still being followed out (2026-10-22) ──────────────────────
//
// `enabled` used to gate everything: the watch list, the trade router and
// the own-exit checks. A live config comes back from every restart disarmed,
// so after any restart the open live copies were watched by nothing — no
// mirrored sell, no take-profit, no stop — while the Copy Trading card told
// the user they "close on their own when this wallet sells". Pausing is a
// decision about ENTRIES. A config with an open copy keeps following the
// leader out of it, paused or not, until nothing is left open.

let openCache: { v: number; ids: Set<string> } | null = null;

/** Configs with an open copy row, either mode — cached against the book. */
function openConfigIds(): Set<string> {
  if (openCache && openCache.v === bookVersion) return openCache.ids;
  const ids = new Set<string>();
  for (const t of trades) if (t.state === 'open' && t.kind !== 'exit') ids.add(t.configId);
  openCache = { v: bookVersion, ids };
  return ids;
}

/** Does this config still act on its leader's trades? Entries need it
 *  enabled; exits need only something open — or a buy still in flight,
 *  whose row does not exist yet but whose exit must not be dropped. */
function managesExits(c: CopyConfig): boolean {
  return c.enabled || openConfigIds().has(c.id) || pendingCopies.has(c.id);
}

let watchCache: { v: number; byChain: Map<string, Set<string>> } | null = null;

/**
 * Wallets the engine must watch: every config taking entries, and every
 * paused one still holding a copy. Asked for every trade on the pump
 * firehose, so it is cached against the book and rebuilt only on a change.
 */
export function activeWallets(chain?: ChainKind): Set<string> {
  if (!watchCache || watchCache.v !== bookVersion) watchCache = { v: bookVersion, byChain: new Map() };
  const key = chain ?? '*';
  let set = watchCache.byChain.get(key);
  if (!set) {
    set = new Set(configs.filter((c) => !isFomo(c) && (chain === undefined || chainOf(c) === chain) && managesExits(c)).map((c) => c.wallet));
    watchCache.byChain.set(key, set);
  }
  return set;
}

// ── Stats ─────────────────────────────────────────────────────────────

function statsFor(c: CopyConfig): CopyStats {
  const every = trades.filter((t) => t.configId === c.id);
  // Scored in the config's CURRENT mode only (2026-10-22). Paper and live are
  // different experiments, and a config flipped from paper to live used to
  // show one total over both — a paper run's wins counted toward the live
  // record a user reads to decide whether following is working.
  const mine = every.filter((t) => t.mode === c.mode);
  // A copy is a buy; its exits are slices of it. Realised PnL lives on the
  // slices (and on copies closed whole before slices existed) — a copy
  // closed through its slices carries none itself, so nothing counts twice.
  const copies = mine.filter((t) => t.kind !== 'exit');
  const closed = mine.filter((t) => t.state === 'closed' && t.pnlSol !== null);
  const open = copies.filter((t) => t.state === 'open');
  return {
    configId: c.id,
    mode: c.mode,
    trades: copies.filter((t) => t.state !== 'skipped').length,
    wins: closed.filter((t) => (t.pnlSol as number) > 0).length,
    losses: closed.filter((t) => (t.pnlSol as number) < 0).length,
    realizedPnlSol: closed.reduce((a, t) => a + (t.pnlSol as number), 0),
    openCount: open.length,
    openCostSol: open.reduce((a, t) => a + t.ourSol * ((t.remainingPct ?? 100) / 100), 0),
    skipped: copies.filter((t) => t.state === 'skipped' && t.reason !== null && !t.reason.startsWith('limit')).length,
    blocked: copies.filter((t) => t.state === 'skipped' && t.reason?.startsWith('limit')).length,
    firstAt: mine.length ? Math.min(...mine.map((t) => t.at)) : null,
    lastAt: mine.length ? Math.max(...mine.map((t) => t.at)) : null,
    unpriced: mine.filter((t) => t.kind === 'exit' && t.state === 'closed' && t.pnlBasis === 'pending').length,
    openAllModes: every.filter((t) => t.kind !== 'exit' && t.state === 'open').length,
  };
}

export function snapshot(): CopySnapshot {
  const stats: Record<string, CopyStats> = {};
  for (const c of configs) stats[c.id] = statsFor(c);
  const leaderStats: Record<string, LeaderStats> = {};
  for (const w of new Set(configs.filter((c) => !isFomo(c)).map((c) => c.wallet))) leaderStats[w] = leaderStatsFor(w);
  const blocked = host?.liveBlockedReason() ?? null;
  // Solana wallets come from the watcher, one subscription each. An EVM
  // leader is seen through that chain's scanner poll instead, so its status
  // is the FEED's — and a config whose feed is off needs to say that rather
  // than render nothing, which is what it did until 2026-09-15.
  const watch: Record<string, CopyWatchStatus> = { ...(host?.watchStatus?.() ?? {}) };
  for (const c of configs) {
    const chain = chainOf(c);
    if (chain === 'solana' || watch[c.wallet]) continue;
    const feed = host?.leaderFeed?.(chain) ?? null;
    if (!feed) continue;
    const book = leaderStats[c.wallet];
    watch[c.wallet] = {
      state: feed.running ? (feed.lastPollAt === null ? 'connecting' : 'watching') : 'off',
      lastSeenAt: feed.lastPollAt,
      lastSwapAt: book?.lastTradeAt ?? null,
      seen: 0,
      swaps: (book?.buys ?? 0) + (book?.sells ?? 0),
    };
  }
  const crowd: NonNullable<CopySnapshot['crowd']> = {};
  const now = Date.now();
  for (const c of configs) {
    if (!isFomo(c)) continue;
    crowd[c.id] = { source: fomoRuleOf(c).source, wallets: crowdSourceSet(c, now).size };
  }
  return {
    configs: all(),
    stats,
    recent: trades.slice(0, 100).map((t) => ({ ...t })),
    liveExecutable: blocked === null,
    liveBlockedReason: blocked,
    exitBlockedReason: host ? (host.exitBlockedReason ?? host.liveBlockedReason)() : null,
    liveOpen: liveOpenByConfig(),
    watch,
    leaders: leaderStats,
    loadFailure,
    crowd,
    latency: copyLatency(recentTimings()),
    pnlByDay: pnlByDay(now),
  };
}

const PNL_DAYS = 60;

/** Local day number of a timestamp — the same bucketing the Scout uses. */
function localDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 86_400_000);
}

/** Realised result per day and mode, from every priced closed row. */
function pnlByDay(now: number): NonNullable<CopySnapshot['pnlByDay']> {
  const from = localDay(now) - (PNL_DAYS - 1);
  const out: NonNullable<CopySnapshot['pnlByDay']> = { paper: [], live: [] };
  const acc: Record<CopyMode, Map<number, { pnl: number; closed: number }>> = { paper: new Map(), live: new Map() };
  for (const t of trades) {
    if (t.state !== 'closed' || t.pnlSol === null) continue;
    const day = localDay(t.closedAt ?? t.at);
    if (day < from) continue;
    const m = acc[t.mode];
    const cur = m.get(day) ?? { pnl: 0, closed: 0 };
    cur.pnl += t.pnlSol;
    cur.closed += 1;
    m.set(day, cur);
  }
  for (const mode of ['paper', 'live'] as const) {
    out[mode] = [...acc[mode].entries()].sort((a, b) => a[0] - b[0]).map(([day, v]) => ({ day, ...v }));
  }
  return out;
}

// ── How long a copy takes (2026-09-21) ────────────────────────────────
//
// A tester timing a leader's wallet against their copy wallet saw ~5–6 s and
// could not tell, from outside, how much of that was hearing about the trade
// and how much was placing ours. Each copy now logs its own breakdown; this
// is the same data as a median, so the question has an answer on the page
// rather than in an afternoon of reading log lines.
//
// Held in memory only. It is a measurement of THIS session's conditions —
// this endpoint, this transport, this machine — and carrying it across a
// restart would average away the very thing it is measuring.
const LATENCY_KEEP = 50;
const timings: CopyTiming[] = [];

function noteTiming(t: CopyTiming): void {
  timings.unshift(t);
  if (timings.length > LATENCY_KEEP) timings.length = LATENCY_KEEP;
}

/** Newest first, for the summary. */
function recentTimings(): CopyTiming[] {
  return timings;
}

/** The median breakdown over this session's copies. */
export function latency(): CopyLatency {
  return copyLatency(recentTimings());
}

// ── The leader's own record ───────────────────────────────────────────
//
// What the LEADER did, scored from every swap seen on their wallet since a
// config first followed it — whether or not a copy happened (2026-09-08).
// The copy scorecard answers "what did following them cost or make ME,
// through my filters and delay"; this answers "are they any good", which is
// what a user testing five wallets on paper is asking. Average cost per
// (wallet, mint): a position opens on the first buy seen and closes when a
// sell leaves nothing (their own fraction says so, or the tracked tokens are
// spent). A sell of tokens bought BEFORE we watched has no known cost and is
// counted, never scored.

interface LeaderPos {
  mint: string;
  symbol: string;
  /** Tracked tokens still held. */
  tokens: number;
  /** Cost of the tracked tokens still held. */
  costSol: number;
  /** Everything spent on this position. */
  costTotal: number;
  proceedsSol: number;
  realizedSol: number;
  openedAt: number;
  lastAt: number;
  buys: number;
  sells: number;
  /** Last price seen for the mint (their fill or a tape tick). */
  markPriceSol: number | null;
}

interface LeaderBook {
  positions: Record<string, LeaderPos>;
  /** Newest first. */
  trips: LeaderRoundTrip[];
  buys: number;
  sells: number;
  unscoredSells: number;
  firstAt: number | null;
  lastAt: number | null;
}

const MAX_TRIPS_PER_LEADER = 300;
const MAX_OPEN_PER_LEADER = 200;

function bookFor(wallet: string): LeaderBook {
  let b = leaders[wallet];
  if (!b) {
    b = { positions: {}, trips: [], buys: 0, sells: 0, unscoredSells: 0, firstAt: null, lastAt: null };
    leaders[wallet] = b;
  }
  return b;
}

function trackLeader(t: WalletTrade): void {
  const b = bookFor(t.wallet);
  b.firstAt = b.firstAt === null ? t.at : Math.min(b.firstAt, t.at);
  b.lastAt = b.lastAt === null ? t.at : Math.max(b.lastAt, t.at);
  // Token count from the transaction when the watcher gave it; else from
  // the fill price (the simulator and tests).
  const tokens = t.tokens !== undefined && t.tokens > 0 ? t.tokens : t.priceSol > 0 ? t.sol / t.priceSol : 0;

  if (t.isBuy) {
    b.buys += 1;
    if (!(tokens > 0) || !(t.sol > 0)) return;
    let p = b.positions[t.mint];
    if (!p) {
      p = {
        mint: t.mint,
        symbol: t.symbol,
        tokens: 0,
        costSol: 0,
        costTotal: 0,
        proceedsSol: 0,
        realizedSol: 0,
        openedAt: t.at,
        lastAt: t.at,
        buys: 0,
        sells: 0,
        markPriceSol: null,
      };
      b.positions[t.mint] = p;
      const open = Object.values(b.positions);
      if (open.length > MAX_OPEN_PER_LEADER) {
        const oldest = open.reduce((a, x) => (x.lastAt < a.lastAt ? x : a));
        delete b.positions[oldest.mint];
      }
    }
    p.tokens += tokens;
    p.costSol += t.sol;
    p.costTotal += t.sol;
    p.buys += 1;
    p.lastAt = t.at;
    if (t.priceSol > 0) p.markPriceSol = t.priceSol;
    if (t.symbol && !p.symbol) p.symbol = t.symbol;
    return;
  }

  b.sells += 1;
  const p = b.positions[t.mint];
  if (!p || !(p.tokens > 0) || !(tokens > 0)) {
    b.unscoredSells += 1;
    return;
  }
  const sold = Math.min(tokens, p.tokens);
  // The part of this sell whose cost is known; the rest was bought before
  // we watched and is counted, not scored.
  const share = sold / tokens;
  if (share < 0.999) b.unscoredSells += 1;
  const cost = p.costSol * (sold / p.tokens);
  const proceeds = t.sol * share;
  p.tokens -= sold;
  p.costSol -= cost;
  p.proceedsSol += proceeds;
  p.realizedSol += proceeds - cost;
  p.sells += 1;
  p.lastAt = t.at;
  if (t.priceSol > 0) p.markPriceSol = t.priceSol;
  const f = t.soldFraction;
  const flat = (f !== null && f !== undefined && f >= 0.995) || p.tokens <= 1e-9 || p.costSol <= 1e-9;
  if (!flat) return;
  b.trips.unshift({
    mint: p.mint,
    symbol: p.symbol,
    costSol: p.costTotal,
    proceedsSol: p.proceedsSol,
    pnlSol: p.realizedSol,
    openedAt: p.openedAt,
    closedAt: t.at,
    buys: p.buys,
    sells: p.sells,
  });
  if (b.trips.length > MAX_TRIPS_PER_LEADER) b.trips.length = MAX_TRIPS_PER_LEADER;
  delete b.positions[t.mint];
}

function leaderStatsFor(wallet: string): LeaderStats {
  const b = leaders[wallet];
  if (!b) return emptyLeaderStats(wallet);
  const open = Object.values(b.positions);
  const trips = b.trips;
  const tripCost = trips.reduce((a, x) => a + x.costSol, 0);
  const tripPnl = trips.reduce((a, x) => a + x.pnlSol, 0);
  let unrealized: number | null = null;
  for (const p of open) {
    const px = p.markPriceSol ?? host?.priceSol(p.mint) ?? null;
    if (px === null || !(px > 0)) continue;
    unrealized = (unrealized ?? 0) + (p.tokens * px - p.costSol);
  }
  const holds = trips.map((x) => x.closedAt - x.openedAt).filter((ms) => ms >= 0);
  // Sorted once, for the median and the too-fast share. Both describe whether
  // a copier could have been inside these trips at all — see
  // COPY_LATENCY_FLOOR_MS for why this is not a quality measure.
  const sortedHolds = [...holds].sort((a, b) => a - b);
  const medianHoldMs = sortedHolds.length ? sortedHolds[sortedHolds.length >> 1] : null;
  const tooFastPct = holds.length
    ? (holds.filter((ms) => ms < COPY_LATENCY_FLOOR_MS).length / holds.length) * 100
    : null;
  const days = b.firstAt === null ? null : Math.max(1, (Date.now() - b.firstAt) / 86_400_000);
  return {
    wallet,
    watchedSince: b.firstAt,
    lastTradeAt: b.lastAt,
    buys: b.buys,
    sells: b.sells,
    roundTrips: trips.length,
    wins: trips.filter((x) => x.pnlSol > 0).length,
    losses: trips.filter((x) => x.pnlSol < 0).length,
    realizedPnlSol: tripPnl + open.reduce((a, p) => a + p.realizedSol, 0),
    volumeSol: tripCost + open.reduce((a, p) => a + p.costTotal, 0),
    openCount: open.length,
    openCostSol: open.reduce((a, p) => a + p.costSol, 0),
    unrealizedPnlSol: unrealized,
    avgHoldMs: holds.length ? holds.reduce((a, x) => a + x, 0) / holds.length : null,
    medianHoldMs,
    tooFastPct,
    bestSol: trips.length ? Math.max(...trips.map((x) => x.pnlSol)) : null,
    worstSol: trips.length ? Math.min(...trips.map((x) => x.pnlSol)) : null,
    unscoredSells: b.unscoredSells,
    tradesPerDay: days === null ? null : (b.buys + b.sells) / days,
    returnPct: tripCost > 0 ? (tripPnl / tripCost) * 100 : null,
    recentTrips: trips.slice(0, 8).map((x) => ({ ...x })),
  };
}

/** Start a wallet's record over (the configs and copies stay). */
export function resetLeader(wallet: string): { ok: boolean; message: string } {
  if (!configs.some((c) => c.wallet === wallet)) return { ok: false, message: 'Not following that wallet' };
  delete leaders[wallet];
  persist();
  host?.changed();
  return { ok: true, message: 'Record cleared' };
}

// ── Daily limits ──────────────────────────────────────────────────────

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's rows in the config's CURRENT mode: a paper run's losses must not
 *  stop a live day, and a live day's must not be hidden by a paper one. */
function todayFor(c: CopyConfig): CopyTrade[] {
  const from = startOfDay();
  return trades.filter((t) => t.configId === c.id && t.mode === c.mode && t.at >= from && t.state !== 'skipped');
}

/**
 * Copies reserved but not yet recorded, per config (copy-1).
 *
 * A copy is only written to `trades` once the buy resolves, so a leader who
 * fires eight swaps into one slot used to pass the daily check eight times
 * before the first buy came back. A slot is now taken SYNCHRONOUSLY the
 * moment the limits pass and given back in a `finally`.
 */
const pendingCopies = new Map<string, number>();
/** When each slot was taken, per config — the rolling-minute wall. */
const recentCopies = new Map<string, number[]>();
const MINUTE = 60_000;

function perMinuteCap(c: CopyConfig): number {
  const v = c.maxCopiesPerMinute;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_COPIES_PER_MINUTE;
}

/** Timestamps inside the last minute, pruned in place. */
function recentFor(configId: string, now: number): number[] {
  const kept = (recentCopies.get(configId) ?? []).filter((at) => now - at < MINUTE);
  if (kept.length) recentCopies.set(configId, kept);
  else recentCopies.delete(configId);
  return kept;
}

/** Take a copy slot. Synchronous, and paired with exactly one `release`. */
function reserve(c: CopyConfig, now: number): void {
  pendingCopies.set(c.id, (pendingCopies.get(c.id) ?? 0) + 1);
  recentCopies.set(c.id, [...recentFor(c.id, now), now]);
}

function release(configId: string): void {
  const n = (pendingCopies.get(configId) ?? 0) - 1;
  if (n > 0) pendingCopies.set(configId, n);
  else pendingCopies.delete(configId);
}

function limitHit(c: CopyConfig, mint?: string): string | null {
  const today = todayFor(c);
  const now = Date.now();
  // Exits are not copies: a leader who scales out in four sells has not
  // used four of the day's copies. Their realised losses DO count below.
  // Copies still in flight count: they are already spending.
  const used = today.filter((t) => t.kind !== 'exit').length + (pendingCopies.get(c.id) ?? 0);
  if (used >= c.dailyTradeLimit) return `limit: ${c.dailyTradeLimit} copies today`;
  const cap = perMinuteCap(c);
  if (recentFor(c.id, now).length >= cap) return `limit: ${cap} copies per minute`;
  // A live exit whose fill has not been read yet counts at the model's
  // estimate: "the chain has not said yet" must not hold a losing day open.
  const realized = today
    .filter((t) => t.state === 'closed')
    .reduce((a, t) => a + (t.pnlSol ?? t.estPnlSol ?? 0), 0);
  if (realized <= -c.dailyLossLimitSol) {
    noteDailyStop(c, realized);
    return `limit: down ${Math.abs(realized).toFixed(3)} SOL today`;
  }
  const stopped = walletStopHit(c);
  if (stopped) {
    autoPause(c, stopped);
    return `paused — ${stopped}`;
  }
  const open = openCeilingHit(c, mint);
  if (open) return open;
  return null;
}

// ── Guardrails across follows (2026-10-23) ────────────────────────────
//
// The per-follow limits above never saw the whole book: five leaders each
// opening a position was five sizes at risk, one leader's bad run kept
// spending until the DAY's limit, and a broken route failed every copy for
// as long as the leader traded. Each rule below blocks ENTRIES only — exits
// are managed whatever the state of a follow — and each is a recorded
// refusal or a pause the card shows, never a silent stop.

/** Losses past the follow's own stop since it was switched on, in words, or null. */
function walletStopHit(c: CopyConfig): string | null {
  const stop = c.walletLossStopSol;
  if (typeof stop !== 'number' || !(stop > 0)) return null;
  const from = c.lossStopFrom ?? c.createdAt;
  const realized = trades
    .filter((t) => t.configId === c.id && t.mode === c.mode && t.state === 'closed' && (t.closedAt ?? t.at) >= from)
    .reduce((a, t) => a + (t.pnlSol ?? t.estPnlSol ?? 0), 0);
  return realized <= -stop ? `down ${Math.abs(realized).toFixed(3)} since it was switched on, past its ${stop} stop` : null;
}

/** Open positions in a mode across every follow, plus buys still in flight. */
function openPositions(mode: CopyMode): { keys: Set<string>; inFlight: number } {
  const keys = new Set<string>();
  for (const t of trades) if (t.state === 'open' && t.kind !== 'exit' && t.mode === mode) keys.add(`${t.configId}:${t.mint}`);
  let inFlight = 0;
  for (const [id, n] of pendingCopies) if (configs.find((x) => x.id === id)?.mode === mode) inFlight += n;
  return { keys, inFlight };
}

/** The app-wide open ceiling, in words when this copy would pass it. Adding
 *  to a position this follow already holds opens nothing new. */
function openCeilingHit(c: CopyConfig, mint?: string): string | null {
  const cap = host?.maxOpenCopies?.() ?? null;
  if (cap === null || !(cap > 0)) return null;
  const { keys, inFlight } = openPositions(c.mode);
  if (mint && keys.has(`${c.id}:${mint}`)) return null;
  return keys.size + inFlight >= cap ? `limit: ${cap} copies open across all follows` : null;
}

/** Live copies that failed in a row, per follow; reset by one that lands. */
const failStreak = new Map<string, number>();

/**
 * Pause a follow on the engine's own authority: entries stop, exits go on,
 * the card says why, and the user is told. The user switching it back on
 * (upsert) is the only way out.
 */
function autoPause(c: CopyConfig, why: string): void {
  if (!c.enabled) return;
  c.enabled = false;
  c.pausedReason = why;
  c.pausedAt = Date.now();
  failStreak.delete(c.id);
  withdrawAsks((a) => a.configId === c.id && a.kind === 'entry', `the follow paused itself — ${why}`);
  persist();
  host?.changed();
  const who = c.label || c.wallet.slice(0, 6);
  host?.log('warn', `copy ${who}: paused — ${why}`);
  alertUser(`Copying ${who} paused`, `${why[0].toUpperCase()}${why.slice(1)}. Open copies are still managed. Switch it back on in Following when you are ready.`);
}

function clearPause(c: CopyConfig): void {
  c.pausedReason = null;
  c.pausedAt = null;
  c.lossStopFrom = Date.now();
  failStreak.delete(c.id);
}

/** Configs told about today's stop, so it is said once a day, not per copy. */
const dailyStopNoted = new Map<string, number>();
function noteDailyStop(c: CopyConfig, realized: number): void {
  const day = startOfDay();
  if (dailyStopNoted.get(c.id) === day) return;
  dailyStopNoted.set(c.id, day);
  const who = c.label || c.wallet.slice(0, 6);
  alertUser(`Copying ${who} stopped for today`, `Down ${Math.abs(realized).toFixed(3)} today, past the ${c.dailyLossLimitSol} daily limit. It starts again tomorrow; open copies are still managed.`);
}

/**
 * Something a person needs to know about (2026-10-23): a pause, a day's
 * stop, a copy that failed, a sell that could not go out. It is toasted in
 * the app and sent out through the engine's notify, at most NOTIFY_PER_HOUR
 * an hour — past that it is logged, so a bad hour cannot bury the phone.
 */
const NOTIFY_PER_HOUR = 6;
const notifiedAt: number[] = [];
function alertUser(title: string, body: string, toast = true): void {
  const h = host;
  if (!h) return;
  if (toast) h.toast('error', `${title} — ${body}`);
  const now = Date.now();
  while (notifiedAt.length && now - notifiedAt[0] >= 3_600_000) notifiedAt.shift();
  if (notifiedAt.length >= NOTIFY_PER_HOUR) {
    h.log('warn', `copy alert not sent (${NOTIFY_PER_HOUR} this hour already): ${title} — ${body}`);
    return;
  }
  notifiedAt.push(now);
  try {
    h.notify?.(title, body);
  } catch {
    /* a notification must never break a copy */
  }
}

// ── Watch-only alerts (2026-10-28) ────────────────────────────────────
//
// A watch tells the user about every trade the wallet makes — in the app
// and through the engine's notify (desktop pop-up, chat bots) — and does
// nothing else. It has its own hourly cap, separate from alertUser's, so a
// busy wallet cannot spend the budget the failure alerts need; past the cap
// the toast and the log line still happen.

const WATCH_NOTIFY_PER_HOUR = 30;
const watchNotifiedAt: number[] = [];

/** What to say about one of their trades: first buy / bought more / sold
 *  part / sold all, with the size when it is known. */
function watchLine(c: CopyConfig, t: WalletTrade): string {
  const what = t.symbol || t.mint.slice(0, 8);
  const sym = nativeSymbolOf(chainOf(c));
  if (t.isBuy) {
    // trackLeader ran before this, so a first buy counts 1.
    const pos = leaders[t.wallet]?.positions[t.mint];
    const first = !pos || pos.buys <= 1;
    return `${first ? 'First buy' : 'Bought more'}: ${t.sol.toFixed(3)} ${sym} of ${what}`;
  }
  const f = fractionOf(t);
  const share = f === null ? `Sold some ${what} (share unknown)` : f >= 0.999 ? `Sold ALL of ${what}` : `Sold ${Math.round(f * 100)}% of ${what}`;
  return t.sol > 0 ? `${share} for ${t.sol.toFixed(3)} ${sym}` : share;
}

function watchAlert(c: CopyConfig, line: string): void {
  const h = host;
  if (!h) return;
  const who = c.label || c.wallet.slice(0, 6);
  h.log('info', `watch ${who}: ${line}`);
  h.toast('info', `${who}: ${line}`);
  const now = Date.now();
  while (watchNotifiedAt.length && now - watchNotifiedAt[0] >= 3_600_000) watchNotifiedAt.shift();
  if (watchNotifiedAt.length >= WATCH_NOTIFY_PER_HOUR) return;
  watchNotifiedAt.push(now);
  try {
    h.notify?.(`${who} · watch`, line);
  } catch {
    /* an alert must never break the feed */
  }
}

/** The per-wallet stop judged on the clock too (checkMaxHolds' timer), so a
 *  follow pauses within seconds of the losing exit, not at its next buy. */
function checkWalletStops(): void {
  for (const c of configs) {
    if (!c.enabled) continue;
    const why = walletStopHit(c);
    if (why) autoPause(c, why);
  }
}

// ── The copy path ─────────────────────────────────────────────────────

/**
 * Keep the book at MAX_TRADES without ever dropping a row that still manages
 * money. The book is ONE array for every config, so 2,000 skip rows across
 * 25 configs used to push an open live copy off the end: its leader's exit
 * then found nothing to close and placed no sell (measured, swarm 10-23).
 * Protected: open copies, slices of an open copy, and live rows still
 * waiting for their fill to be read. Oldest skipped rows go first, then the
 * oldest closed ones. When everything left is protected the book grows past
 * the cap rather than forget a position.
 */
function trimTrades(): void {
  let excess = trades.length - MAX_TRADES;
  if (excess <= 0) return;
  const openIds = new Set(trades.filter((t) => t.state === 'open').map((t) => t.id));
  const keep = (t: CopyTrade): boolean =>
    t.state === 'open' || t.pnlBasis === 'pending' || (t.parentId !== undefined && openIds.has(t.parentId));
  const drop = new Set<string>();
  for (const pass of ['skipped', 'any'] as const) {
    for (let i = trades.length - 1; i >= 0 && excess > 0; i -= 1) {
      const t = trades[i];
      if (drop.has(t.id) || keep(t)) continue;
      if (pass === 'skipped' && t.state !== 'skipped') continue;
      drop.add(t.id);
      excess -= 1;
    }
  }
  if (drop.size) trades = trades.filter((t) => !drop.has(t.id));
}

function record(t: CopyTrade): void {
  trades.unshift(t);
  trimTrades();
  persist();
  host?.changed();
  noteCopyForAi(t);
}

/** Every copy row, skips included, on the AI's feed (2026-10-28). */
function noteCopyForAi(t: CopyTrade): void {
  const h = host;
  if (!h?.aiNote) return;
  const c = configs.find((x) => x.id === t.configId);
  const who = c ? followName(c) : t.wallet.slice(0, 6);
  const what = t.kind === 'exit' ? 'sold' : t.state === 'skipped' ? 'skipped' : 'bought';
  h.aiNote('copy', `${who} ${t.mode} ${what} ${t.symbol || t.mint.slice(0, 6)} ${t.ourSol}${t.reason ? ` — ${t.reason}` : ''}`, {
    id: t.id,
    configId: t.configId,
    follow: who,
    mode: t.mode,
    wallet: t.wallet,
    mint: t.mint,
    symbol: t.symbol,
    kind: t.kind ?? 'entry',
    state: t.state,
    ourSol: t.ourSol,
    entryPriceSol: t.entryPriceSol,
    exitPriceSol: t.exitPriceSol,
    pnlSol: t.pnlSol,
    reason: t.reason,
    ai: t.ai ?? null,
  });
}

/** A follow's name as the user sees it. */
function followName(c: CopyConfig): string {
  return c.label || (isFomo(c) ? 'crowd' : `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`);
}

export interface WalletTrade {
  /** Absent = Solana. An EVM trade's wallet and mint are lower-cased on entry. */
  chain?: ChainKind;
  wallet: string;
  mint: string;
  symbol: string;
  isBuy: boolean;
  sol: number;
  priceSol: number;
  at: number;
  /** The transaction, when known. A leader's pump.fun trade arrives twice —
   *  from the curve firehose and from the wallet watcher — and must be
   *  evaluated once. */
  signature?: string;
  /** Sell: the share of their holding they sold, 0–1 (walletSwap). Null or
   *  absent = unknown, and an unknown share is NOT mirrored at all — the
   *  exit is recorded as skipped with that reason. */
  soldFraction?: number | null;
  /** Tokens moved, UI units (walletSwap). Absent = derived from the price. */
  tokens?: number;
  /**
   * When the LEADER's transaction actually landed, ms — not when we read it
   * (2026-09-15).
   *
   * `at` is delivery time, so without this a trade recovered after a socket
   * gap is indistinguishable from one that just happened, and the copier
   * would enter a position the leader opened half an hour ago at today's
   * price. Absent or null means "unknown", which is treated as NOW: every
   * rail that cannot date a trade behaves exactly as it did before.
   */
  tradeAt?: number | null;
  /**
   * Why a SYNTHETIC exit was raised (2026-09-20): a reverse position's own
   * take-profit, stop-loss or max hold, or the leader buying back. Carried
   * onto the exit slice as its reason. A leader's real trade never has one.
   */
  note?: string;
  /**
   * What the DELIVERY half cost (2026-09-21), from the wallet watcher: which
   * subscription carried it, how long after their fill we heard, what the
   * read-back cost. The copier adds its own stages onto this. Absent on a
   * rail that does not time itself, and on a synthetic exit, which has no
   * delivery to measure.
   */
  delivery?: DeliveryTiming;
  /** The slot the trade landed in, when the rail that delivered it knows
   *  (the pump firehose). A balance read sizing this sell must be at or past
   *  it. The watcher's slot travels in `delivery.slot`. */
  slot?: number | null;
}

/**
 * Clock skew between this machine and the chain, ms.
 *
 * Every rail now dates its trades from a CHAIN clock (a Solana block time, a
 * pump event's `unix_timestamp`, an EVM block timestamp) and the staleness
 * rules below compare that to `Date.now()`. On a machine whose clock is five
 * minutes fast, every single trade would look five minutes old and copying
 * would stop dead — a hard failure caused by something that has nothing to
 * do with trading.
 *
 * So the ages are measured RELATIVE to the fastest delivery actually
 * observed. The minimum of the recent samples is whatever is constant
 * between us and the chain: clock offset plus the floor of the delivery
 * path. Subtracting it leaves "how much later than usual did this arrive",
 * which is the question the rules are really asking, and it self-corrects
 * when the clock is fixed.
 */
const SKEW_SAMPLES = 64;
/**
 * An offset is only believed once it has been seen this many times.
 *
 * With one sample the minimum IS that sample, so a single trade recovered
 * forty minutes late would define itself as "normal" and sail through the
 * very rules built to catch it. Below the threshold the raw age is used, so
 * an uncalibrated session errs toward refusing a stale trade rather than
 * acting on one. The cost is the mirror image: a machine with a badly set
 * clock refuses its first few copies and then corrects itself.
 */
const SKEW_MIN_SAMPLES = 5;
const skewRing: number[] = [];

/** Note one delivery's raw lateness. Called ONCE per trade, on arrival. */
function noteSkew(t: WalletTrade, now = Date.now()): void {
  if (typeof t.tradeAt !== 'number' || !(t.tradeAt > 0)) return;
  skewRing.push(now - t.tradeAt);
  if (skewRing.length > SKEW_SAMPLES) skewRing.shift();
}

/** The constant part, never negative — a clock BEHIND the chain gives
 *  negative samples, and treating those as an offset would make everything
 *  look late rather than early. */
function clockSkewMs(): number {
  if (skewRing.length < SKEW_MIN_SAMPLES) return 0;
  let min = Infinity;
  for (const v of skewRing) if (v < min) min = v;
  return min > 0 ? min : 0;
}

/**
 * How late the leader's trade is by the time we are acting on it, ms.
 *
 * Zero when the rail cannot date the trade — an unknown age must not refuse
 * anything, or a chain without block times would stop copying altogether.
 */
function ageOf(t: WalletTrade, now = Date.now()): number {
  if (typeof t.tradeAt !== 'number' || !(t.tradeAt > 0)) return 0;
  return Math.max(0, now - t.tradeAt - clockSkewMs());
}

/** Test seam: what the module currently thinks the offset is. */
export function _clockSkewMs(): number {
  return clockSkewMs();
}

/** A readable "4 minutes"/"35 seconds" for a message a user reads. */
function ageText(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * Past this, a mirrored SELL is on the record rather than in the market.
 *
 * The same number and the same reasoning as a parked exit resumed after a
 * restart: "they sold, so get out" is worth honouring through a gap, and it
 * is NOT worth honouring on an instruction old enough that mirroring it at
 * today's price is a fresh trading decision nobody made. Reached now that a
 * trade carries its real time — a sell recovered after a socket gap gets the
 * same rule an interrupted one always had.
 */
const LATE_EXIT_MAX_AGE_MS = 15 * 60_000;
/** Past this an exit says how late it was, on the record and in the toast. */
const LATE_EXIT_NOTE_MS = 20_000;
/**
 * Past this, an ENTRY is refused.
 *
 * Copying a buy the leader made minutes ago is buying a different trade at a
 * different price — the leg the 2026-09-13 report lost money on, and the
 * reason `staleBuys` exists for the in-flight case. This is the general rule
 * the in-flight one is a special case of. A configured delay is the user's
 * own choice to be late, so it is added on rather than counted against them.
 */
const MAX_ENTRY_AGE_MS = 60_000;
const entryAgeLimit = (c: CopyConfig): number => MAX_ENTRY_AGE_MS + Math.max(0, c.delayMs) + (aiGateOn(c.ai) && c.ai.entries ? c.ai.waitSec * 1_000 : 0);

/** Signatures already evaluated, newest last; bounded. */
const handled = new Set<string>();
const HANDLED_CAP = 1_000;

function alreadyHandled(signature: string | undefined): boolean {
  if (!signature) return false;
  if (handled.has(signature)) return true;
  handled.add(signature);
  if (handled.size > HANDLED_CAP) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
  return false;
}

/**
 * Sell signatures already routed, with the fraction each delivery carried
 * (copy-13).
 *
 * A pump.fun leader's sell arrives TWICE: from the curve firehose, which
 * reads a log and therefore has no pre-balance and no `soldFraction`, and
 * from the wallet watcher, which has both but must fetch the transaction
 * first and so always loses the race. Deduping on the signature alone threw
 * away the only delivery that could be mirrored, which left the whole pump
 * rail with the exact bug the mirrored sell was written to fix.
 *
 * So a sell signature is not simply "seen". It is remembered WITH its
 * fraction, and a later delivery is let through exactly once, and only when
 * it upgrades an unknown fraction to a known one.
 */
const handledSells = new Map<string, number | null>();

type SellRoute = 'new' | 'upgrade' | 'drop';

function routeSell(t: WalletTrade): SellRoute {
  const sig = t.signature;
  if (!sig) return 'new';
  const fraction = fractionOf(t);
  if (!handledSells.has(sig)) {
    handledSells.set(sig, fraction);
    if (handledSells.size > HANDLED_CAP) {
      const oldest = handledSells.keys().next().value;
      if (oldest !== undefined) handledSells.delete(oldest);
    }
    return 'new';
  }
  if ((handledSells.get(sig) ?? null) === null && fraction !== null) {
    handledSells.set(sig, fraction);
    return 'upgrade';
  }
  return 'drop';
}

/**
 * `${configId}:${leaderSignature}` → the id of the "could not tell how much
 * they sold" row that delivery wrote. When a later delivery of the SAME sell
 * carries the fraction, that row is removed: the exit did happen, and a skip
 * the history cannot explain is worse than no row at all.
 */
const supersededSkips = new Map<string, string>();

/**
 * `${configId}:${leaderSignature}` → the fraction that sell was mirrored at,
 * once it was ACTED on (2026-10-22).
 *
 * `handledSells` decides which deliveries reach a config; this decides
 * whether a config acts on one. They differ on the pump rail: the firehose
 * delivers a sell with no fraction, `closeOpen` recovers the fraction from
 * the leader's balance and sells it — and then the wallet watcher delivers
 * the same signature WITH its fraction, which `routeSell` lets through as an
 * "upgrade" because the stored fraction was still unknown. Nothing wrote the
 * recovered one back, so the copy sold twice: a 40 % trim became 40 % and
 * then 40 % of the rest, 64 % in all. One leader transaction is one mirrored
 * sell per config, whichever delivery got there first.
 */
const mirroredSells = new Map<string, { fraction: number; recovered: boolean }>();

/**
 * The one exception to "once per config" (2026-10-23): a fraction RECOVERED
 * from the leader's balance can be too small, because the read may still see
 * part of the bag the sell already moved (measured: a 100 % exit mirrored as
 * 50 %, a 40 % trim as 29 %). When the same signature later arrives with the
 * fraction the transaction itself carries, and that is larger, the copy sells
 * the difference ONCE, as its own slice, keyed `${actKey}:exact`. A recovered
 * value that was too LARGE is never undone: a sell cannot be taken back.
 */
function exactTopUp(actKey: string, exact: number): number | null {
  const done = mirroredSells.get(actKey);
  if (!done || !done.recovered || done.fraction >= 1) return null;
  if (mirroredSells.has(`${actKey}:exact`)) return null;
  if (exact - done.fraction <= 0.01) return null;
  return Math.min(1, (exact - done.fraction) / (1 - done.fraction));
}

function noteMirrored(key: string, fraction: number, recovered = false): void {
  mirroredSells.set(key, { fraction, recovered });
  if (mirroredSells.size > HANDLED_CAP) {
    const oldest = mirroredSells.keys().next().value;
    if (oldest !== undefined) mirroredSells.delete(oldest);
  }
}

/** Chains with a config still acting on its leader — taking entries, or
 *  holding a copy it must follow out. Their leader feed has to be running
 *  for following to mean anything. */
export function activeChains(): Set<ChainKind> {
  const out = new Set<ChainKind>();
  for (const c of configs) if (managesExits(c)) out.add(chainOf(c));
  return out;
}

/** Mints with an open copy, paper or live — the engine keeps them priced. */
export function openMints(chain?: ChainKind): string[] {
  return [...new Set(trades.filter((t) => t.state === 'open' && (chain === undefined || (t.chain ?? 'solana') === chain)).map((t) => t.mint))];
}

/**
 * Live copies still open in the ACTIVE Solana wallet — those of follows set
 * to "Active wallet" (2026-10-28). Their exits sell from whichever wallet is
 * active, and a row does not record which one bought it, so switching while
 * any is open left them in the old wallet with no exits and the record
 * calling them sold. The switch is refused while this is above zero.
 */
/** Open LIVE copies per follow, whatever the follow's mode is now — a follow
 *  switched back to paper still holds real tokens. */
function liveOpenByConfig(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trades) if (t.mode === 'live' && t.state === 'open' && t.kind !== 'exit') out[t.configId] = (out[t.configId] ?? 0) + 1;
  return out;
}

export function activeWalletLiveCopies(): number {
  const ids = new Set(configs.filter((c) => chainOf(c) === 'solana' && !c.walletId).map((c) => c.id));
  return trades.filter((t) => ids.has(t.configId) && t.mode === 'live' && t.state === 'open' && t.kind !== 'exit').length;
}

/**
 * A followed wallet's transaction could not be read even after a second
 * round (2026-10-28). With a live copy of that wallet open it may have been
 * their sell, and the copy is still held — said to the user, not only logged.
 */
export function noteUnreadableLeaderTx(wallet: string, signature: string): void {
  const ids = new Set(configs.filter((c) => c.wallet === wallet).map((c) => c.id));
  if (!ids.size) return;
  const open = trades.filter((t) => ids.has(t.configId) && t.mode === 'live' && t.state === 'open' && t.kind !== 'exit');
  if (!open.length) return;
  const c = configs.find((x) => ids.has(x.id));
  const who = c?.label || wallet.slice(0, 6);
  const coins = [...new Set(open.map((t) => t.symbol || t.mint.slice(0, 6)))].slice(0, 3).join(', ');
  alertUser(
    `${who}: a trade could not be read`,
    `Transaction ${signature.slice(0, 8)}… could not be read after retries, so it was not copied. If it was a sell, your live copy (${coins}) is still open — check it on Following.`,
  );
}

/** Open copies whose follow judges a price rule on them (take-profit,
 *  stop-loss, trailing) — the ones a missing price silently disarms. */
export function priceExitMints(): string[] {
  const out = new Set<string>();
  for (const c of configs) {
    const x = ownExitsOf(c);
    if (x.takeProfitPct === null && x.stopLossPct === null && x.trailingPct === null) continue;
    for (const t of trades) if (t.configId === c.id && t.state === 'open' && t.kind !== 'exit') out.add(t.mint);
  }
  return [...out];
}

/**
 * A followed wallet traded. Evaluate every enabled config for that wallet.
 *
 * Sells are handled first because closing a paper position is bookkeeping,
 * and it must not be blocked by the daily limits that gate opening one — the
 * same rule as orders, for the same reason.
 */
/**
 * Time one stage. Kept as a helper so every stage is measured the same way
 * and a stage that threw is still measured — an error that took two seconds
 * is exactly the kind of thing this is here to find.
 */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - start };
  } catch (e) {
    (e as { _ms?: number })._ms = Date.now() - start;
    throw e;
  }
}

export function onWalletTrade(t: WalletTrade): void {
  const h = host;
  if (!h) return;
  // An EVM address is case-insensitive; a Solana one is not.
  const chain = t.chain ?? 'solana';
  if (chain !== 'solana') t = { ...t, wallet: t.wallet.toLowerCase(), mint: t.mint.toLowerCase() };
  // The crowd hears every followed wallet's trade too (FOMO, 2026-09-20).
  noteCrowdTrade(t);
  // A paused config with a copy still open is in here too: it takes no
  // entries, but it follows the leader out of what it holds.
  const matching = configs.filter((c) => !isFomo(c) && chainOf(c) === chain && c.wallet === t.wallet && managesExits(c));
  if (!matching.length) return;

  const route: SellRoute = t.isBuy ? (alreadyHandled(t.signature) ? 'drop' : 'new') : routeSell(t);
  if (route === 'drop') return;
  // One sample per delivery, before anything below asks how late it is — so
  // the very first trade of a session measures zero against itself and is
  // never refused for an offset nothing has calibrated yet.
  noteSkew(t);

  if (route === 'new') {
    // Their record first: scored whatever the configs below decide. An
    // upgrade is the SAME sell arriving again, so it is not scored twice.
    trackLeader(t);
    persist();
    h.changed();
    // The AI's feed hears every followed wallet's trade (2026-10-28).
    h.aiNote?.('leader_trade', `${followName(matching[0])} ${t.isBuy ? 'bought' : 'sold'} ${t.symbol || t.mint.slice(0, 6)} for ${t.sol} ${nativeSymbolOf(chain)}`, {
      wallet: t.wallet,
      follows: matching.map((c) => ({ configId: c.id, follow: followName(c), direction: directionOf(c), mode: c.mode, enabled: c.enabled })),
      chain,
      side: t.isBuy ? 'buy' : 'sell',
      mint: t.mint,
      symbol: t.symbol,
      sol: t.sol,
      priceSol: t.priceSol > 0 ? t.priceSol : null,
      soldFraction: t.isBuy ? null : (t.soldFraction ?? null),
      at: t.tradeAt ?? t.at,
      signature: t.signature ?? null,
    });
  }

  for (const c of matching) {
    if (isWatch(c)) {
      // Watch-only (2026-10-28): their trade is told, never copied. A
      // paused watch is silent; it has no open copy to follow out.
      if (route === 'new' && c.enabled) watchAlert(c, watchLine(c, t));
      continue;
    }
    if (directionOf(c) === 'reverse') {
      // Reverse: their SELL is our entry, their BUY is our exit (2026-09-20).
      // The entry runs through the same filters, limits, delay and staleness
      // as a copy; the exit through the same mirror as a copied sell, at
      // 100 % — a leader buying back is the whole thesis being wrong.
      if (t.isBuy) {
        if (route === 'new' && c.copySells) queueExit(c, { ...t, isBuy: false, soldFraction: 1, note: 'they bought back — reverse exit' });
        continue;
      }
      if (route !== 'new' || !c.enabled) continue;
      void evaluateBuy(c, { ...t, isBuy: true });
      continue;
    }
    if (!t.isBuy) {
      if (c.copySells) queueExit(c, t);
      continue;
    }
    if (route !== 'new' || !c.enabled) continue;
    void evaluateBuy(c, t);
  }
}

// ── Mirrored sells ────────────────────────────────────────────────────
//
// Until 2026-09-08 a leader's sell only marked the copy closed: no sell was
// placed, and the history said "closed" over a wallet that still held every
// token (a user's report — the one 40 % that DID leave was their own
// take-profit ladder). Now a live copy mirrors the sell as a share of what
// THIS wallet holds — "they sold 40 %" is "sell 40 % of ours" — through the
// same pipeline a manual sell uses, and the record moves only when the sell
// confirmed. Paper copies keep the same bookkeeping without the order.

// A paper round trip pays what a real one would, on BOTH sides: the venue's
// fee, Krypt's fee, and the fixed priority/base/tip cost of each transaction
// (shared/copytrade.ts paperExitPnl). Charging one side only, or the
// percentages only, reports a profit the identical real trades would not
// have made.

/** One exit at a time per copy, in the order the leader sold. Two sells a
 *  second apart (a ladder) must not both size from the same remainder. */
const exitChains = new Map<string, Promise<void>>();

// ── The leader sells while our buy is still in flight ─────────────────
//
// `copyOnce` is slow on purpose: a token-facts fetch, the user's configured
// delay, then a broadcast and a confirmation. The copy row does not exist
// until all of that returns. A leader who exits inside that window used to
// hit `closeOpen`, find no `open` row for the config, and return — the sell
// was dropped on the floor, with nothing recorded. The buy then landed and
// opened a position that no exit was ever queued for.
//
// A user reported 15 of 16 matched buys recorded AFTER the leader had
// already exited (2026-09-13). Two things follow from that, and both are
// implemented here:
//
//   1. A sell that arrives with a buy in flight is REMEMBERED, and applied
//      the moment that buy opens its row (`drainPendingExit`).
//   2. A buy that has not been SUBMITTED yet when the leader exits is
//      abandoned (`staleBuys`) — entering a position the leader has already
//      left is not copying them, and it is the entry that lost the money.
//      A buy already broadcast cannot be recalled, so it opens its row and
//      the remembered sell closes it immediately.

/** `${configId}:${mint}` → the buy is between `evaluateBuy` and its record. */
const buysInFlight = new Map<string, { since: number; submitted: boolean }>();
/** `${configId}:${mint}` → the leader sell that landed mid-buy, newest wins. */
const pendingExits = new Map<string, WalletTrade>();
/** `${configId}:${mint}` marked abandoned: the leader left before we sent. */
const staleBuys = new Set<string>();
/** Parked exits read back off disk at boot, before `attach` has a host to
 *  act with. `resumePendingExits` drains this. */
const restoredExits = new Map<string, WalletTrade>();

/**
 * How old a parked exit may be and still be acted on after a restart.
 *
 * The instruction is "they sold, so get out". That is worth honouring
 * through a crash and a relaunch — it is exactly the case the user lost
 * money to. It is NOT worth honouring after the app has been shut for a
 * week: mirroring a sell from days ago at today's price is a fresh trading
 * decision nobody made, which is the same reasoning that brings persisted
 * orders back PAUSED rather than armed.
 *
 * Past the window the exit is not silently dropped either — it is recorded
 * as skipped, saying what it was and that the position is still held.
 */
const PENDING_EXIT_MAX_AGE_MS = LATE_EXIT_MAX_AGE_MS;

const flightKey = (configId: string, mint: string): string => `${configId}:${mint}`;

/** Note a sell that has no row to close yet because the buy is still going.
 *  Returns true when it was parked (so the caller does not also drop it). */
function parkExit(c: CopyConfig, t: WalletTrade): boolean {
  const key = flightKey(c.id, t.mint);
  const flight = buysInFlight.get(key);
  if (!flight) return false;
  pendingExits.set(key, t);
  // Not yet sent: the entry itself is what we no longer want.
  if (!flight.submitted) staleBuys.add(key);
  host?.log(
    'info',
    `copy: ${c.label || c.wallet.slice(0, 6)} ${t.note ? 'bought back' : 'sold'} ${t.symbol || t.mint.slice(0, 8)} while our buy was in flight — ` +
      (flight.submitted ? 'exit queued for the moment it opens' : 'buy abandoned as stale'),
  );
  return true;
}

/**
 * Act on exits parked before the last shutdown. Called once, after the host
 * is attached and the configs are loaded.
 *
 * Fresh ones fire through the ordinary path. Stale ones are RECORDED as
 * skipped rather than dropped, because the user is still holding the
 * position and the one thing worse than a late exit is a silent one.
 */
export function resumePendingExits(now = Date.now()): { fired: number; expired: number } {
  let fired = 0;
  let expired = 0;
  for (const [key, t] of [...restoredExits.entries()]) {
    restoredExits.delete(key);
    const configId = key.slice(0, key.indexOf(':'));
    const c = configs.find((x) => x.id === configId);
    if (!c || !c.copySells) continue;
    const open = trades.filter((x) => x.configId === c.id && x.mint === t.mint && x.state === 'open' && x.kind !== 'exit');
    if (!open.length) continue; // the buy never opened a row — nothing is held for it
    const age = now - (t.at ?? 0);
    if (age > PENDING_EXIT_MAX_AGE_MS) {
      expired += 1;
      record(
        exitSkipped(
          open[0],
          t,
          100,
          `not executed — ${c.label || c.wallet.slice(0, 6)} sold this ${Math.round(age / 60_000)} minutes ago, while the app was closed. ` +
            'Too old to mirror at today\u2019s price, so nothing was sold. You still hold it.',
        ),
      );
      host?.toast(
        'error',
        `${t.symbol || t.mint.slice(0, 8)}: the wallet you follow sold it while Krypt was closed. You still hold it \u2014 sell by hand if you want out.`,
      );
      continue;
    }
    fired += 1;
    // A LIVE config comes back from a restart DISARMED (see init). That rule
    // is about not resuming ENTRIES — "an exit must stay possible while
    // entries are paused" — so a parked exit still fires. But the panel will
    // be showing "Paused" while this sells, and a user who sees those two
    // things together with no explanation is right to distrust both. Say it.
    const paused = c.mode === 'live' && !c.enabled;
    host?.log(
      'info',
      `copy: resuming an exit parked before shutdown — ${t.symbol || t.mint.slice(0, 8)}` +
        (paused ? ' (this config is paused after the restart; exits still run, entries do not)' : ''),
    );
    if (paused) {
      host?.toast(
        'warn',
        `${t.symbol || t.mint.slice(0, 8)}: selling an exit that was interrupted by a restart. ` +
          `Following is paused — this is the old instruction finishing, not a new copy.`,
      );
    }
    queueExit(c, t, 'resume');
  }
  if (fired || expired) {
    persist();
    host?.changed();
  }
  return { fired, expired };
}

/**
 * Leaders who left a coin while the app was shut (2026-10-22).
 *
 * A leader's subscription starts at boot with nothing behind it, so a sell
 * made while the app was closed is never delivered, and the copy sits open
 * waiting for a mirror that will not come. One balance read per open copy
 * (leader, mint) answers it: a leader holding none of a coin we still hold
 * copied from them has left it.
 *
 * Recorded, never traded. When they sold is unknown — minutes or days ago —
 * and selling on it now is a fresh decision at today's price, the same line
 * the parked-exit and late-exit rules draw. A live copy says so loudly; the
 * position's own exit rules and the user's hand still apply. An unreadable
 * balance is not "zero" and says nothing. Bounded, because the balance read
 * is one of the scarcest public RPC methods.
 */
export async function checkLeadersAfterBoot(max = 12): Promise<{ checked: number; gone: number }> {
  const h = host;
  const out = { checked: 0, gone: 0 };
  if (!h?.leaderHolding) return out;
  const asked = new Set<string>();
  for (const c of [...configs]) {
    // Reverse and FOMO positions are not closed by the leader selling.
    if (isFomo(c) || directionOf(c) !== 'copy' || !c.copySells) continue;
    for (const r of trades.filter((x) => x.configId === c.id && x.state === 'open' && x.kind !== 'exit' && resumedRow(x))) {
      const key = flightKey(c.id, r.mint);
      if (asked.has(key)) continue;
      if (out.checked >= max) return out;
      asked.add(key);
      out.checked += 1;
      let held: number | null = null;
      try {
        held = await h.leaderHolding(c.wallet, r.mint, chainOf(c));
      } catch {
        held = null;
      }
      if (held === null || !Number.isFinite(held) || held > 0) continue;
      if (!stillConfigured(c.id)) continue;
      // A sell heard since boot may have closed it while we read.
      const open = trades.filter((x) => x.configId === c.id && x.mint === r.mint && x.state === 'open' && x.kind !== 'exit');
      if (!open.length) continue;
      out.gone += 1;
      const who = c.label || c.wallet.slice(0, 6);
      const what = r.symbol || r.mint.slice(0, 8);
      const live = open.some((x) => x.mode === 'live');
      const now = Date.now();
      record(
        exitSkipped(
          open[0],
          { chain: chainOf(c), wallet: c.wallet, mint: r.mint, symbol: r.symbol, isBuy: false, sol: 0, priceSol: 0, at: now },
          100,
          `not executed — ${who} no longer holds this. They sold or moved it while the app was closed, and when is unknown, so nothing was sold. ` +
            `You still hold it${live ? '' : ' on paper'}.`,
        ),
      );
      h.log('warn', `copy: ${who} left ${what} while the app was closed — the copy is still open`);
      if (live) alertUser(`${what}: not sold`, 'The wallet you follow sold it while the app was closed. You still hold it — sell by hand if you want out.');
    }
  }
  return out;
}

/** Apply a sell that was parked while this buy was in flight. */
function drainPendingExit(c: CopyConfig, mint: string): void {
  const key = flightKey(c.id, mint);
  const parked = pendingExits.get(key);
  if (!parked) return;
  pendingExits.delete(key);
  if (!c.copySells) return;
  queueExit(c, parked);
}

function queueExit(c: CopyConfig, t: WalletTrade, rule: ExitRule = 'leader'): Promise<void> {
  const key = `${c.id}:${t.mint}`;
  const prev = exitChains.get(key) ?? Promise.resolve();
  // The AI desk asks inside the chain, so one coin's exits stay one at a
  // time while the AI thinks, and a hold answers before the next is asked.
  const next = prev
    .then(async () => {
      const go = await askExit(c, t, rule);
      if (go) await closeOpen(c, go);
    })
    .catch((err) => host?.log('error', `copy exit failed: ${(err as Error).message}`));
  exitChains.set(key, next);
  void next.then(() => {
    if (exitChains.get(key) === next) exitChains.delete(key);
  });
  return next;
}

/** The leader's fraction, clamped to (0, 1]; null when it is not known. An
 *  unknown fraction is NOT "all of it": a leader trimming 10 % must never
 *  turn into us dumping the whole bag because one RPC reply lacked owners. */
function fractionOf(t: WalletTrade): number | null {
  const f = t.soldFraction;
  if (f === null || f === undefined || !Number.isFinite(f) || f <= 0) return null;
  return Math.min(1, f);
}

/**
 * Work out what share the leader sold when the transaction could not say.
 *
 * Their holding AFTER the sell plus the tokens it moved is what they held
 * BEFORE it, so the fraction is exact — this recovers the number, it does
 * not estimate it. Needs the token count (`t.tokens`, from the same decode)
 * and one balance read.
 *
 * Still null on a failed read, and null still means "do not mirror": an
 * unknown share must never become a full dump because an RPC timed out.
 * What changes is that "unknown" is now rare instead of routine.
 */
/** `${wallet}:${mint}:${signature}` → the holding read for ONE sell, shared
 *  by every config following that leader. `getTokenAccountsByOwner` is one of
 *  the scarcest public methods (10 per 10 s). It used to be keyed by wallet
 *  and mint alone, so a leader selling 50 % and then the rest inside 3 s had
 *  the second sell sized from the first one's balance: 50 %, not 100 %. */
const holdingCache = new Map<string, { at: number; value: number | null }>();
const HOLDING_CACHE_MS = 3_000;

async function recoverFraction(t: WalletTrade, h: CopyHost): Promise<number | null> {
  const sold = t.tokens;
  if (sold === undefined || !Number.isFinite(sold) || sold <= 0) return null;
  if (!h.leaderHolding) return null;
  const ck = t.signature ? `${t.wallet}:${t.mint}:${t.signature}` : null;
  const now = Date.now();
  let after: number | null = null;
  const hit = ck ? holdingCache.get(ck) : undefined;
  if (hit && now - hit.at < HOLDING_CACHE_MS) {
    after = hit.value;
  } else {
    const slot = t.slot ?? t.delivery?.slot ?? null;
    try {
      after = await h.leaderHolding(t.wallet, t.mint, t.chain ?? 'solana', slot ? { minContextSlot: slot } : undefined);
    } catch {
      return null; // unreadable is unknown, never a guess
    }
    if (ck) holdingCache.set(ck, { at: now, value: after });
    if (holdingCache.size > 256) {
      const oldest = holdingCache.keys().next().value;
      if (oldest !== undefined) holdingCache.delete(oldest);
    }
  }
  if (after === null || !Number.isFinite(after) || after < 0) return null;
  const before = after + sold;
  if (!(before > 0)) return null;
  const f = Math.min(1, sold / before);
  if (!(f > 0)) return null;
  h.log(
    'info',
    `copy: sell size was unreadable from the transaction — recovered from their balance: ` +
      `sold ${sold}, ${after} left → ${Math.round(f * 100)}% of their bag`,
  );
  return f;
}

// ── Quantities ────────────────────────────────────────────────────────
//
// Everything above this line sizes a copy in SOL. A mirrored sell cannot
// be. `h.sell` takes a percentage of the whole token account, and the
// percentage the copier used to send was the leader's fraction scaled by
// this config's share of what the WALLET PAID for the bag. A cost share and
// a token share are only the same number when every buy filled at the same
// price, which is never — so the sell went out the wrong size, and the book
// wrote the leader's fraction down as done regardless.
//
// A user's NON copy is the whole bug in one line: the exit was recorded as
// 100 %, the request sold 52 % of the remaining tokens, the transaction
// succeeded, 83,236 NON stayed in the wallet, and the copy was marked
// closed — inventory outside every open-position view the app has.
//
// So a live copy is settled in base units, from confirmed fills:
//
//   • what the buy delivered      → `tokensRaw`      (noteBuyQuantity)
//   • what this copy still holds  → `tokensLeftRaw`
//   • what a sell asked for       → `ExitPlan.wantRaw`
//   • what it actually moved      → `settleExit`, from the fill
//   • what may be called closed   → only a remainder that is dust
//
// A row with no tracked quantity keeps the old percentage path exactly.
// Unknown is never read as zero and never as "all of it".

/** Whole tokens, for a line a human reads. Never used for sizing. */
function fmtTokens(raw: bigint, decimals: number | null | undefined): string {
  const n = uiTokens(raw, decimals);
  return n >= 1 ? Math.round(n).toLocaleString() : n.toPrecision(3);
}

/**
 * Attach the base units a live copy's buy actually delivered.
 *
 * Off the hot path deliberately: the copy is already open and recorded, and
 * this number is only needed by an exit. A failure here is silent and
 * harmless — the row simply keeps an unknown quantity, and every path below
 * reads unknown as "use the old percentage".
 */
async function noteBuyQuantity(c: CopyConfig, rowId: string, res: CopyExecResult): Promise<void> {
  const h = host;
  if (!h) return;
  let got: FillRead | null =
    res.filledRaw !== undefined && typeof res.tokenDecimals === 'number'
      ? { raw: res.filledRaw, decimals: res.tokenDecimals }
      : null;
  // The ledger's read of the fill is asked for even when the quantity is
  // already known: it is also where the buy's real cost and its slot are.
  let read: FillRead | null = null;
  if (res.signature && h.fillTokens) {
    try {
      read = await h.fillTokens(res.signature, { walletId: c.walletId ?? undefined, chain: chainOf(c) });
    } catch {
      read = null;
    }
  }
  if (!got) got = read;
  // The row may have been sliced or closed while the chain was read. It is
  // still the same copy, and its quantity is still this.
  const row = trades.find((x) => x.id === rowId);
  if (!row) return;
  let touched = false;

  const raw = got ? rawOf(got.raw) : null;
  if (raw !== null && raw > 0n && !row.tokensRaw) {
    row.tokensRaw = raw.toString();
    row.tokenDecimals = got!.decimals;
    // Anything already sold off this row came out of a quantity nobody knew,
    // so the remainder is what `remainingPct` says of what we now know.
    const pct = Math.max(0, Math.min(100, row.remainingPct ?? 100));
    row.tokensLeftRaw = ((raw * BigInt(Math.round(pct * 100))) / 10_000n).toString();
    touched = true;
  }

  // What the buy COST, from the chain (2026-10-22): the wallet's lamport
  // delta, fees, tips and the token account's rent included — the same
  // number the portfolio's cost basis is built from. The size we sent and
  // the spot price at sending were placeholders; any exit already booked
  // against them is re-derived from this.
  const tokens = raw !== null && raw > 0n ? uiTokens(raw, got!.decimals) : 0;
  if (read && typeof read.sol === 'number' && read.sol < 0 && tokens > 0 && row.entryBasis !== 'fill') {
    const spent = -read.sol;
    row.ourSol = spent;
    row.entryPriceSol = spent / tokens;
    const overhead = typeof read.overheadSol === 'number' && read.overheadSol > 0 ? read.overheadSol : 0;
    row.exitAnchorPriceSol = spent - overhead > 0 ? (spent - overhead) / tokens : row.entryPriceSol;
    row.entryBasis = 'fill';
    for (const s of trades) {
      if (s.parentId !== row.id || s.kind !== 'exit' || typeof s.shareOfCopy !== 'number') continue;
      s.ourSol = spent * s.shareOfCopy;
      s.entryPriceSol = row.entryPriceSol;
      if (s.pnlBasis === 'fill' && typeof s.proceedsSol === 'number') s.pnlSol = s.proceedsSol - s.ourSol;
    }
    rebookCopy(row.id);
    touched = true;
  }

  // How many slots behind the leader it landed — the measurement every
  // copier markets and none lets you check. Written into the row's timing,
  // which is the same object the session's latency median holds.
  if (read && typeof read.slot === 'number' && read.slot > 0 && row.timing) {
    row.timing.ourSlot = read.slot;
    const lead = row.timing.leaderSlot;
    if (typeof lead === 'number' && lead > 0) {
      row.timing.slotGap = Math.max(0, read.slot - lead);
      h.log('info', `copy landed ${c.label || c.wallet.slice(0, 6)} ${row.symbol || row.mint.slice(0, 6)}: ${row.timing.slotGap} slot${row.timing.slotGap === 1 ? '' : 's'} after the leader (slot ${lead} → ${read.slot})`);
    }
    touched = true;
  }

  if (!touched) return;
  persist();
  h.changed();
  // An exit that went out before this fill was read could not be told how
  // many of its tokens were this copy's. Now it can.
  void repricePending(c, row.id);
}

/** What one mirrored sell means to do, in base units. */
interface ExitPlan {
  /** Base units to sell; null when the copy's quantity is not tracked, 0n
   *  when their trim is smaller than one base unit of our position. */
  wantRaw: bigint | null;
  /** The percentage handed to the host. Exact against `balanceRaw` when the
   *  quantity is known; the old cost-scaled estimate when it is not. */
  pct: number;
  /** What the wallet held when the plan was made, or null when unreadable. */
  balanceRaw: bigint | null;
  decimals: number | null;
  /** Row id → base units of `wantRaw` that row is contributing. */
  share: Map<string, bigint>;
  /** Row id → base units that row held before the sell. */
  before: Map<string, bigint>;
}

/** What a settled sell did to one copy row. */
interface RowSettlement {
  /** Share of what the ROW held that actually left, 0–1. */
  fraction: number;
  soldRaw: bigint;
  wantedRaw: bigint;
}

async function readWalletTokens(h: CopyHost, c: CopyConfig, mint: string): Promise<{ raw: bigint; decimals: number } | null> {
  if (!h.walletTokens) return null;
  try {
    const r = await h.walletTokens(mint, { walletId: c.walletId ?? undefined, chain: chainOf(c) });
    const raw = r ? rawOf(r.raw) : null;
    return raw === null ? null : { raw, decimals: r!.decimals };
  } catch {
    return null;
  }
}

/**
 * Size one mirrored sell.
 *
 * Every live row for the mint must carry a tracked quantity or the total is
 * not the position — selling a total that is missing a row leaves that row's
 * tokens behind while the book calls the whole thing done, which is this bug
 * in miniature. One missing quantity therefore drops the WHOLE plan back to
 * the old percentage path: wrong in a way the record has always described,
 * rather than wrong in a way it hides.
 */
/** Fill reads still running, by copy row id (noteBuyQuantity). */
const quantityReads = new Map<string, Promise<void>>();
/** How long an exit waits for its buy's fill read before sizing without it. */
const QUANTITY_WAIT_MS = 8_000;

async function planExit(c: CopyConfig, rows: CopyTrade[], mint: string, fraction: number, h: CopyHost, waited = false): Promise<ExitPlan> {
  if (waited) {
    // Second pass: never wait twice.
    for (const x of rows) quantityReads.delete(x.id);
  }
  const plan: ExitPlan = {
    wantRaw: null,
    pct: Math.max(1, Math.min(100, Math.round(fraction * 100))),
    balanceRaw: null,
    decimals: null,
    share: new Map(),
    before: new Map(),
  };

  let tracked = 0n;
  let complete = rows.length > 0;
  for (const x of rows) {
    const left = rawOf(x.tokensLeftRaw);
    if (left === null) {
      complete = false;
      break;
    }
    plan.before.set(x.id, left);
    tracked += left;
    if (plan.decimals === null && typeof x.tokenDecimals === 'number') plan.decimals = x.tokenDecimals;
  }

  if (!complete && rows.some((x) => rawOf(x.tokensLeftRaw) === null && quantityReads.has(x.id))) {
    // A buy whose fill the ledger is still reading (2026-10-28). Sized
    // without it, the fallback below sells a share of the WHOLE token
    // account — up to all of it, another follow's bag of the same coin or a
    // hand-bought one included. The read takes a few seconds; waiting for
    // it (bounded) sizes this exit from our own tokens instead.
    const waits = rows.map((x) => quantityReads.get(x.id)).filter((p): p is Promise<void> => !!p);
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, QUANTITY_WAIT_MS))]);
    return planExit(c, rows, mint, fraction, h, true);
  }
  if (!complete || tracked <= 0n) {
    plan.before.clear();
    plan.pct = walletPctFor(c, rows, mint, fraction);
    return plan;
  }

  // A full exit is the whole tracked quantity, exactly. A partial one is
  // that quantity times their fraction in integer arithmetic — a millionth
  // is finer than any leader's sell is measured to.
  let want = fraction >= 1 ? tracked : (tracked * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
  if (want <= 0n) {
    plan.before.clear();
    plan.wantRaw = 0n;
    return plan;
  }

  const bal = await readWalletTokens(h, c, mint);
  if (bal) {
    plan.balanceRaw = bal.raw;
    plan.decimals = bal.decimals;
    // The chain is the ceiling. Our book can only ever be stale high — a
    // hand sell, a stop-loss rung, another config's mirror.
    if (want > bal.raw) want = bal.raw;
    if (bal.raw > 0n) {
      // Percent × 100, rounded UP: the last basis point is worth overshooting
      // for, because the failure being fixed here is systematically selling
      // short, and the overshoot is capped at 0.01 % of the wallet.
      const bps = want >= bal.raw ? 10_000n : (want * 10_000n + bal.raw - 1n) / bal.raw;
      plan.pct = Math.max(0.01, Math.min(100, Number(bps) / 100));
    }
  }

  plan.wantRaw = want;
  // Split what we ask for across the rows in proportion to what each still
  // holds, so a copy built from two buys settles both rows, not one.
  let assigned = 0n;
  rows.forEach((x, i) => {
    const before = plan.before.get(x.id) ?? 0n;
    let part = i === rows.length - 1 ? want - assigned : (want * before) / tracked;
    if (part < 0n) part = 0n;
    if (part > before) part = before;
    plan.share.set(x.id, part);
    assigned += part;
  });
  return plan;
}

/**
 * What the sell actually moved, in base units, or null.
 *
 * The transaction's own token delta first — that is the number, not an
 * inference. A balance re-read second: what the wallet held before this sell
 * minus what it holds after. Null last, and null leaves the quantity
 * unsettled rather than assumed away.
 */
async function soldRawOf(
  c: CopyConfig,
  mint: string,
  plan: ExitPlan,
  res: CopyExecResult,
  h: CopyHost,
  /** Filled in with the fill's SOL and base units when the ledger answered
   *  in time, so the slice can be priced now instead of after a second wait. */
  seen: { sol: number | null; raw: bigint | null } = { sol: null, raw: null },
): Promise<bigint | null> {
  const direct = res.filledRaw !== undefined ? rawOf(res.filledRaw) : null;
  if (direct !== null && direct > 0n) return direct;
  if (res.signature && h.fillTokens) {
    try {
      // Bounded. `fillTokens` waits for the ledger to reconcile, which is
      // the exact number — but this runs INSIDE the exit chain for the mint,
      // so every second here is a second the top-up sell and the leader's
      // next sell of this token both wait. A balance read is a hair less
      // precise and available immediately, and the sweep checks either.
      const r = await Promise.race([
        h.fillTokens(res.signature, { walletId: c.walletId ?? undefined, chain: chainOf(c) }),
        new Promise<undefined>((done) => setTimeout(() => done(undefined), SETTLE_FILL_WAIT_MS)),
      ]);
      const raw = r ? rawOf(r.raw) : null;
      if (r && typeof r.sol === 'number' && Number.isFinite(r.sol)) {
        seen.sol = r.sol;
        seen.raw = raw;
      }
      if (raw !== null && raw > 0n) return raw;
      if (r === undefined) {
        h.log('info', `copy: the ${mint.slice(0, 8)} sell had not reconciled in ${SETTLE_FILL_WAIT_MS / 1_000}s — settling from the balance instead`);
      }
    } catch {
      /* fall through to the balance read */
    }
  }
  if (plan.balanceRaw === null) return null;
  const after = await readWalletTokens(h, c, mint);
  if (!after) return null;
  const moved = plan.balanceRaw - after.raw;
  return moved > 0n ? moved : 0n;
}

/**
 * Book what the sell did against the rows it came out of.
 *
 * Returns the ACTUAL share of each row that left, which is what the slice
 * record and the close decision are made from. Null when the quantity was
 * never tracked, and the caller then falls back to the leader's fraction —
 * the old behaviour, reached only when there is no better number.
 */
async function settleExit(
  c: CopyConfig,
  rows: CopyTrade[],
  mint: string,
  plan: ExitPlan,
  res: CopyExecResult,
  h: CopyHost,
  seen?: { sol: number | null; raw: bigint | null },
): Promise<Map<string, RowSettlement> | null> {
  if (plan.wantRaw === null || plan.wantRaw <= 0n) return null;
  const measured = await soldRawOf(c, mint, plan, res, h, seen);
  // A confirmed sell that cannot be measured is credited with what it was
  // asked for: that is the best reading of a transaction that landed, and
  // the balance sweep checks it against the chain afterwards. It is never
  // credited with the leader's fraction, which is the number that had
  // nothing to do with our wallet in the first place.
  const actual = measured ?? plan.wantRaw;
  const want = plan.wantRaw;

  const out = new Map<string, RowSettlement>();
  for (const x of rows) {
    const before = plan.before.get(x.id) ?? 0n;
    const asked = plan.share.get(x.id) ?? 0n;
    if (before <= 0n) {
      out.set(x.id, { fraction: 0, soldRaw: 0n, wantedRaw: asked });
      continue;
    }
    let got = want > 0n ? (actual * asked) / want : 0n;
    if (got > before) got = before;
    if (got < 0n) got = 0n;
    x.tokensLeftRaw = (before - got).toString();
    if (plan.decimals !== null && typeof x.tokenDecimals !== 'number') x.tokenDecimals = plan.decimals;
    out.set(x.id, { fraction: Number(got) / Number(before), soldRaw: got, wantedRaw: asked });
  }

  // The chain is the ceiling, applied now rather than 90 seconds later by
  // the sweep. What the wallet held before this sell, minus what the sell
  // moved, is everything left of the mint — so our rows cannot between them
  // still own more than that. They can claim to when the book went stale
  // high (a hand sell, a stop-loss rung, another config's mirror took some
  // while this exit was being planned), and a row left claiming tokens that
  // are not there is exactly the state this whole rewrite is about.
  if (plan.balanceRaw !== null) {
    const after = plan.balanceRaw - actual > 0n ? plan.balanceRaw - actual : 0n;
    const claimed = rows.reduce((a, x) => a + (rawOf(x.tokensLeftRaw) ?? 0n), 0n);
    if (claimed > after) {
      for (const x of rows) {
        const left = rawOf(x.tokensLeftRaw) ?? 0n;
        x.tokensLeftRaw = (claimed > 0n ? (left * after) / claimed : 0n).toString();
      }
      h.log(
        'info',
        `copy: the ${mint.slice(0, 8)} book claimed ${claimed} base units after this sell and the wallet holds ${after} — ` +
          'the difference left by some other sale, so the copy is credited with what is actually there',
      );
    }
  }

  const short = want - actual;
  if (short > 0n && !isDustRemainder(short, want)) {
    h.log(
      'warn',
      `copy: mirrored sell of ${mint.slice(0, 8)} asked for ${want} base units and moved ${actual} — ` +
        `${short} still in the wallet, so the copy stays open for them`,
    );
  }
  return out;
}

/** One sell of `fraction` of what is left of copy `x`: the slice record,
 *  and the copy itself moved on (remainder, realised, closed when spent).
 *
 *  `fraction` is OUR share — what actually left this row — which is the same
 *  as the leader's only when the mirror was exact. `q` carries the settled
 *  quantities when there are any; without it the row is moved on by
 *  percentage exactly as it was before quantities existed. */
function applyExit(
  x: CopyTrade,
  fraction: number,
  exit: number | null,
  t: WalletTrade,
  signature: string | null,
  q?: { leaderFraction: number; settled: RowSettlement | null },
): CopyTrade {
  const remaining = x.remainingPct ?? 100;
  const totalRaw = rawOf(x.tokensRaw);
  const settled = q?.settled ?? null;
  // The share of the whole copy this slice sold. From base units when they
  // are known: a percentage carried through a fraction of a fraction drifts,
  // and base units do not.
  const slicePct =
    settled && totalRaw !== null && totalRaw > 0n
      ? Math.min(remaining, (Number(settled.soldRaw) / Number(totalRaw)) * 100)
      : fraction >= 1
        ? remaining
        : remaining * fraction;
  const cost = x.ourSol * (slicePct / 100);
  const shareOfCopy = Math.max(0, Math.min(1, slicePct / 100));
  const modelled =
    exit !== null && x.entryPriceSol !== null && x.entryPriceSol > 0 ? paperExitPnl(cost, shareOfCopy, x.entryPriceSol, exit, x.chain ?? 'solana') : null;
  // Paper is priced by the model. Live is priced from what the chain says
  // the sell returned (`priceLiveExit`), which is never known at this point:
  // until it is, the slice has no PnL and carries the model's estimate only
  // for the daily loss limit. Booking a live exit at the leader's price was
  // the record crediting us with their fill.
  const live = x.mode === 'live';
  const pnl = live ? null : modelled;
  const slice: CopyTrade = {
    id: nextId('cx'),
    configId: x.configId,
    mode: x.mode,
    wallet: x.wallet,
    mint: x.mint,
    symbol: x.symbol || t.symbol,
    at: t.at,
    theirSol: t.sol,
    ourSol: cost,
    entryPriceSol: x.entryPriceSol,
    // Live: OUR exit price, once the fill says what it was. Not theirs.
    exitPriceSol: live ? null : exit,
    closedAt: t.at,
    pnlSol: pnl,
    state: 'closed',
    reason: t.note ?? null,
    kind: 'exit',
    parentId: x.id,
    soldPct: Math.max(0, Math.min(100, Math.round(fraction * 100))),
    signature,
    shareOfCopy,
    pnlBasis: live ? 'pending' : 'model',
  };
  if (live) slice.estPnlSol = modelled;
  else slice.paperModel = PAPER_MODEL;
  if (settled) {
    slice.soldRaw = settled.soldRaw.toString();
    slice.tokenDecimals = x.tokenDecimals ?? null;
    // Only when they differ: a record that repeats the same number twice is
    // noise, and the point of these two fields is the gap between them.
    if (settled.wantedRaw !== settled.soldRaw) slice.wantedRaw = settled.wantedRaw.toString();
  }
  if (q && Math.round(q.leaderFraction * 100) !== slice.soldPct) {
    slice.leaderPct = Math.max(0, Math.min(100, Math.round(q.leaderFraction * 100)));
  }

  if (pnl !== null) x.realizedSol = (x.realizedSol ?? 0) + pnl;
  // A live row's mark is moved by the tape (markToMarket); its exit price
  // comes from the fill, set when the fill is read.
  if (exit !== null && !live) x.exitPriceSol = exit;

  const leftRaw = settled ? rawOf(x.tokensLeftRaw) : null;
  if (leftRaw !== null && totalRaw !== null && totalRaw > 0n) {
    // Base units decide. This is the rule the NON copy needed: a leader's
    // full exit does not close our row — our tokens leaving does.
    x.remainingPct = Math.max(0, Math.min(100, (Number(leftRaw) / Number(totalRaw)) * 100));
    if (isDustRemainder(leftRaw, totalRaw)) {
      x.remainingPct = 0;
      x.state = 'closed';
      x.closedAt = t.at;
      x.leftoverRaw = null;
    } else {
      x.state = 'open';
      x.closedAt = null;
      x.reason = `partly sold — ${fmtTokens(leftRaw, x.tokenDecimals)} ${x.symbol || 'tokens'} still held`;
    }
    return slice;
  }

  x.remainingPct = Math.max(0, remaining - slicePct);
  if (x.remainingPct <= 0.5) {
    x.remainingPct = 0;
    x.state = 'closed';
    x.closedAt = t.at;
  }
  return slice;
}

/** The exit that did NOT happen, kept in the history with its reason. */
function exitSkipped(x: CopyTrade, t: WalletTrade, pct: number, reason: string): CopyTrade {
  return {
    id: nextId('cx'),
    configId: x.configId,
    mode: x.mode,
    wallet: x.wallet,
    mint: x.mint,
    symbol: x.symbol || t.symbol,
    at: t.at,
    theirSol: t.sol,
    ourSol: x.ourSol * ((x.remainingPct ?? 100) / 100) * (pct / 100),
    entryPriceSol: x.entryPriceSol,
    exitPriceSol: null,
    closedAt: null,
    pnlSol: null,
    state: 'skipped',
    reason,
    kind: 'exit',
    parentId: x.id,
    soldPct: pct,
    signature: null,
  };
}

/** Still followed? A config removed mid-flight must stop the copy (copy-9). */
function stillConfigured(id: string): boolean {
  return configs.some((c) => c.id === id);
}

/**
 * Why a copy that has been waiting — on token facts, the configured delay,
 * the AI — must not go out now, or null (2026-10-28). The follow is the same
 * object the user edits, so a pause, a mode switch or a stop that tripped
 * meanwhile is visible here; checked after every wait and at the last gate
 * before money leaves, so a follow that was switched off never buys.
 */
function withdrawnReason(c: CopyConfig, base: CopyTrade): string | null {
  if (closing) return 'not executed — the app was closing';
  if (c.mode !== base.mode) return `not executed — the follow was switched to ${c.mode} while this copy waited`;
  if (!c.enabled) return `not executed — the follow was ${c.pausedReason ? `paused (${c.pausedReason})` : 'switched off'} while this copy waited`;
  const realized = todayFor(c)
    .filter((t) => t.state === 'closed')
    .reduce((a, t) => a + (t.pnlSol ?? t.estPnlSol ?? 0), 0);
  if (realized <= -c.dailyLossLimitSol) {
    noteDailyStop(c, realized);
    return `limit: down ${Math.abs(realized).toFixed(3)} SOL today`;
  }
  const stopped = walletStopHit(c);
  if (stopped) {
    autoPause(c, stopped);
    return `paused — ${stopped}`;
  }
  return null;
}

/**
 * The percentage of OUR TOKEN ACCOUNT that mirrors the leader's fraction,
 * WITHOUT a tracked quantity — the fallback, not the main path.
 *
 * `h.sell` sells a percentage of everything this wallet holds of the mint,
 * not a percentage of the copy. When the wallet also holds a hand-bought bag
 * of the same token, mirroring "40 %" as 40 % sells 40 % of that bag too —
 * SOL the copier was never given permission to spend (copy-2). Scaling by
 * this config's share of our own basis fixes that, and introduces its own
 * error: a cost share is not a token share unless every buy filled at the
 * same price. That error is what `planExit` removes when the copy's base
 * units are known. This stays for the rows that have none — a copy opened
 * before 2026-09-15, a rail with no balance reader — where it remains
 * strictly better than mirroring the fraction unscaled.
 */
function walletPctFor(c: CopyConfig, open: CopyTrade[], mint: string, fraction: number): number {
  let ratio = 1;
  const basis = host?.ourCostBasisSol?.(mint) ?? null;
  if (typeof basis === 'number' && Number.isFinite(basis) && basis > 0) {
    const ours = open.reduce((a, x) => a + x.ourSol * ((x.remainingPct ?? 100) / 100), 0);
    if (ours > 0) ratio = Math.min(1, ours / basis);
  }
  return Math.max(1, Math.min(100, Math.round(fraction * ratio * 100)));
}

/**
 * At most this many sell requests per mirrored exit.
 *
 * A sell is a share of a balance that moves under it, so one request can
 * come back short — that is the observed failure, not a hypothetical. When
 * the leader has fully exited, the copier tries once more for the measured
 * remainder and then stops: an unbounded retry against a token that cannot
 * be sold burns fees forever, and a leftover the user can see beats a loop
 * they cannot.
 */
const EXIT_MAX_ATTEMPTS = 2;

/** What the live half of a mirrored exit produced. */
interface LiveExit {
  slices: CopyTrade[];
  signature: string | null;
  /** A sell confirmed, so the exit is not "skipped". */
  traded: boolean;
  /**
   * Each sell that confirmed, with what its fill moved — SOL and base units —
   * when the ledger had already read it. A sell that went out as a share of
   * the whole token account may have sold more than this copy's tokens, so
   * its proceeds are attributed per TOKEN (`priceLiveExit`), never whole.
   */
  fills: Array<{ signature: string; sol: number | null; raw: bigint | null }>;
}

/**
 * Mirror one leader sell onto the live rows, and settle it against the
 * chain.
 *
 * The loop is the fix for the reported bug in one place: size from base
 * units, send, measure what actually moved, book THAT, and — when the leader
 * is fully out and a real remainder is still sitting in the wallet — ask for
 * exactly the remainder once more. Nothing here closes a row; `applyExit`
 * does that, and only on a dust remainder.
 */
async function mirrorSell(
  c: CopyConfig,
  t: WalletTrade,
  liveRows: CopyTrade[],
  fraction: number,
  exit: number | null,
  h: CopyHost,
): Promise<LiveExit> {
  const out: LiveExit = { slices: [], signature: null, traded: false, fills: [] };
  const who = c.label || c.wallet.slice(0, 6);
  const what = t.symbol || t.mint.slice(0, 8);
  const leaderPct = Math.max(1, Math.min(100, Math.round(fraction * 100)));

  for (let attempt = 0; attempt < EXIT_MAX_ATTEMPTS; attempt += 1) {
    const rows = liveRows.filter((x) => x.state === 'open');
    if (!rows.length) break;
    // A pass that has not sold anything yet still owes the leader's own
    // fraction; one that has is only ever chasing the remainder the last one
    // left behind, which is all of what is still tracked.
    const askFor = out.traded ? 1 : fraction;
    const plan = await planExit(c, rows, t.mint, askFor, h);
    if (plan.wantRaw !== null && plan.wantRaw <= 0n) {
      if (attempt === 0) {
        out.slices.push(
          exitSkipped(rows[0], t, leaderPct, `not executed — ${who} sold ${leaderPct}% of their bag, which is less than one token of ours`),
        );
      }
      break;
    }

    const res = await h.sell(t.mint, plan.pct, {
      slippagePct: c.maxSlippagePct,
      walletId: c.walletId ?? undefined,
      chain: chainOf(c),
      tokensRaw: plan.wantRaw !== null ? plan.wantRaw.toString() : undefined,
    });
    if (!stillConfigured(c.id)) return out;

    if (!res.ok) {
      if (/nothing to sell|zero token balance/i.test(res.message)) {
        // Our own orders already emptied the bag. Nothing to mirror — say so
        // on the record rather than invent a fill or leave it "open".
        for (const x of rows) {
          x.state = 'closed';
          x.closedAt = t.at;
          x.remainingPct = 0;
          x.tokensLeftRaw = '0';
          x.leftoverRaw = null;
          x.reason = 'nothing left to sell — your own orders had already sold it';
        }
        persist();
        h.changed();
        h.log('info', `copy: ${who} sold ${what} but this wallet holds none — record closed`);
        break;
      }
      // The chain disagrees with the size we asked for, which means the
      // balance moved between the read that planned this and the send. Worth
      // exactly one re-plan against a fresh read — this is a race, not a
      // refusal, and the EVM rail states it as one.
      if (/more than this wallet holds/i.test(res.message) && attempt + 1 < EXIT_MAX_ATTEMPTS) {
        h.log('info', `copy: the ${what} balance moved under the mirrored sell — re-sizing from a fresh read`);
        continue;
      }
      // The coin is between its curve and its pool: the sell waits for the
      // pool instead of being dropped (waitForMigration).
      if (!out.traded && curveMigrating(res.message)) {
        const waiting = waitForMigration(c, t, rows[0], fraction, leaderPct, h);
        if (waiting) out.slices.push(waiting);
        break;
      }
      // Nothing sold yet means the whole exit failed. Otherwise this was a
      // top-up that did not land, and the slice from the first pass is
      // already real — the row stays open for the remainder and says so.
      if (!out.traded) {
        out.slices.push(exitSkipped(rows[0], t, leaderPct, res.message.slice(0, 160)));
        h.log('warn', `copy sell FAILED (${who} sold ${leaderPct}% of ${what}): ${res.message}`);
        alertUser('Copy sell failed', `${leaderPct}% of ${what}: ${res.message}. You still hold it.`);
      } else {
        h.log('warn', `copy: top-up sell for the ${what} remainder failed: ${res.message}`);
      }
      break;
    }

    out.traded = true;
    migrationLanded(t);
    out.signature = res.signature ?? out.signature;
    const seen = { sol: null as number | null, raw: null as bigint | null };
    const settled = await settleExit(c, rows, t.mint, plan, res, h, seen);
    if (res.signature) out.fills.push({ signature: res.signature, sol: seen.sol, raw: seen.raw });
    for (const x of rows) {
      out.slices.push(
        applyExit(x, settled?.get(x.id)?.fraction ?? fraction, exit, t, res.signature ?? null, {
          leaderFraction: fraction,
          settled: settled?.get(x.id) ?? null,
        }),
      );
    }

    if (attempt === 0) {
      // Say how late, when it was. "Sold late" is the complaint; a number on
      // the record is how someone can tell a slow rail from a slow leader.
      const behind = ageOf(t);
      h.toast(
        'success',
        `Copied sell: ${leaderPct}% of ${what} with ${who}` + (behind > LATE_EXIT_NOTE_MS ? ` — ${ageText(behind)} after they did` : ''),
      );
      if (behind > LATE_EXIT_NOTE_MS) {
        h.log('warn', `copy: mirrored ${who}'s ${what} sell ${ageText(behind)} after it landed on chain`);
      }
    }

    // Is there anything left that we meant to have sold? Only a full leader
    // exit is topped up: a leader who trimmed 40 % has no remainder by
    // definition, and re-selling one would be trading past their instruction.
    if (fraction < 1) break;
    const stillOpen = rows.filter((x) => x.state === 'open' && rawOf(x.tokensLeftRaw) !== null);
    if (!stillOpen.length) break;
    if (attempt + 1 >= EXIT_MAX_ATTEMPTS) {
      const left = stillOpen.reduce((a, x) => a + (rawOf(x.tokensLeftRaw) ?? 0n), 0n);
      h.toast(
        'warn',
        `Copy sell came back short — ${fmtTokens(left, stillOpen[0].tokenDecimals)} ${what} are still in your wallet. ` +
          `The copy stays open for them; sell by hand if you want out now.`,
      );
    }
  }

  return out;
}

/**
 * A live sell refused because the coin is migrating to PumpSwap (2026-10-24,
 * `curveMigrating`). Nothing can trade until the pool opens, so the sell is
 * held and tried again on the 15 s clock (`retryMigrationWaits`) for up to
 * MIGRATION_WAIT_MAX_MS, then given up loudly. Before this it was a failed
 * sell: "You still hold it", and a bag the leader had left.
 */
interface MigrationWait {
  configId: string;
  mint: string;
  symbol: string;
  /** Share of what this copy holds still to sell. */
  fraction: number;
  firstAt: number;
  nextAt: number;
  /** The "waiting" row, withdrawn once the sell lands. */
  rowId: string;
  inFlight: boolean;
}
/** flightKey(config, mint) → the sell waiting on that coin's pool. */
const migrationWaits = new Map<string, MigrationWait>();
/** A retry's synthetic exit → its wait's key. */
const migrationRetries = new WeakMap<WalletTrade, string>();
/** Exits sized by the AI (a smaller sell, sell_copy): the share is the AI's
 *  choice, not the leader's, so the follow's minimum-sell rule does not apply. */
const aiSized = new WeakSet<WalletTrade>();

function waitForMigration(c: CopyConfig, t: WalletTrade, row: CopyTrade, fraction: number, leaderPct: number, h: CopyHost): CopyTrade | null {
  const key = flightKey(c.id, t.mint);
  const what = t.symbol || t.mint.slice(0, 8);
  const now = Date.now();
  const w = migrationWaits.get(key);
  if (migrationRetries.has(t)) {
    if (w) w.nextAt = now + MIGRATION_RETRY_MS;
    return null;
  }
  if (w) {
    // The leader sold again while the first sell waits: both shares are
    // owed, out of what we hold.
    w.fraction = 1 - (1 - w.fraction) * (1 - fraction);
    h.log('info', `copy: another ${what} sell joins the one waiting for its PumpSwap pool (${Math.round(w.fraction * 100)}% of the bag in all)`);
    return null;
  }
  const waiting = exitSkipped(
    row,
    t,
    leaderPct,
    `waiting — ${what} is moving from pump’s curve to PumpSwap, and nothing can trade until it lands. The sell is tried again every ${MIGRATION_RETRY_MS / 1000} s for up to ${MIGRATION_WAIT_MAX_MS / 60_000} minutes.`,
  );
  migrationWaits.set(key, { configId: c.id, mint: t.mint, symbol: what, fraction, firstAt: now, nextAt: now + MIGRATION_RETRY_MS, rowId: waiting.id, inFlight: false });
  h.log('warn', `copy: ${what} is migrating to PumpSwap — ${leaderPct}% sell held for the pool`);
  h.toast('info', `${what} is moving to PumpSwap — your copy sell will go through when it lands`);
  return waiting;
}

/** The waiting sell landed: the "waiting" row is no longer true. */
function migrationLanded(t: WalletTrade): void {
  const key = migrationRetries.get(t);
  if (key === undefined) return;
  const w = migrationWaits.get(key);
  migrationWaits.delete(key);
  if (w) trades = trades.filter((x) => x.id !== w.rowId);
}

function settleMigrationWait(w: MigrationWait, reason: string): void {
  const row = trades.find((x) => x.id === w.rowId);
  if (row) row.reason = reason;
  persist();
  host?.changed();
}

/** On the 15 s clock: try each held sell again, or give it up. */
function retryMigrationWaits(now: number): void {
  for (const [key, w] of migrationWaits) {
    if (w.inFlight || now < w.nextAt) continue;
    const c = configs.find((x) => x.id === w.configId);
    const open = c ? trades.filter((r) => r.configId === c.id && r.mint === w.mint && r.state === 'open' && r.kind !== 'exit' && r.mode === 'live') : [];
    if (!c || !open.length) {
      migrationWaits.delete(key);
      settleMigrationWait(w, 'not executed — the copy was closed before the coin finished moving to PumpSwap');
      continue;
    }
    if (now - w.firstAt >= MIGRATION_WAIT_MAX_MS) {
      migrationWaits.delete(key);
      const mins = Math.round(MIGRATION_WAIT_MAX_MS / 60_000);
      settleMigrationWait(w, `not executed — still moving to PumpSwap after ${mins} minutes. You still hold it; sell by hand if you want out.`);
      alertUser('Copy sell failed', `${w.symbol} was still moving to PumpSwap after ${mins} minutes, so the mirrored sell was not placed. You still hold it.`);
      continue;
    }
    w.inFlight = true;
    w.nextAt = now + MIGRATION_RETRY_MS;
    const synthetic: WalletTrade = {
      chain: chainOf(c),
      wallet: c.wallet,
      mint: w.mint,
      symbol: w.symbol,
      isBuy: false,
      sol: 0,
      priceSol: 0,
      at: now,
      tradeAt: now,
      soldFraction: w.fraction,
      note: 'sell held for the PumpSwap migration',
    };
    migrationRetries.set(synthetic, key);
    void queueExit(c, synthetic, 'resume').finally(() => {
      w.inFlight = false;
    });
  }
}

async function closeOpen(c: CopyConfig, t: WalletTrade): Promise<void> {
  const h = host;
  if (!h) return;
  const rows = trades.filter((x) => x.configId === c.id && x.mint === t.mint && x.state === 'open' && x.kind !== 'exit');
  if (!rows.length) {
    // Nothing to close YET is not nothing to close: a buy may be mid-flight.
    parkExit(c, t);
    return;
  }
  // A row is governed by the mode it was OPENED in, not by what the config is
  // set to today (copy-3). Flipping a config from paper to live used to make
  // the leader's next sell broadcast a real order against a paper row, and
  // then label that broadcast "paper" in the history.
  // A retried migration sell is the live half of an exit whose paper half
  // was booked when the leader sold.
  const paperRows = migrationRetries.has(t) ? [] : rows.filter((x) => x.mode === 'paper');
  const liveRows = rows.filter((x) => x.mode === 'live');

  const who = c.label || c.wallet.slice(0, 6);
  const what = t.symbol || t.mint.slice(0, 8);
  const skipKey = t.signature ? `${c.id}:${t.signature}` : null;
  let fraction = fractionOf(t);
  const exactHere = fraction !== null;
  if (fraction === null) fraction = await recoverFraction(t, h);
  if (fraction === null) {
    const row = exitSkipped(
      rows[0],
      t,
      100,
      'not executed — how much of their bag they sold could not be read, and their balance could not be checked either. Your position is still open; sell it by hand if you want out.',
    );
    // The wallet watcher may deliver this same sell again WITH the fraction
    // (copy-13); if it does, this row is withdrawn rather than left standing.
    if (skipKey) {
      supersededSkips.set(skipKey, row.id);
      // Bounded like `handled`: most of these are never superseded, because
      // most leaders are not on a rail that delivers a sell twice.
      if (supersededSkips.size > HANDLED_CAP) {
        const oldest = supersededSkips.keys().next().value;
        if (oldest !== undefined) supersededSkips.delete(oldest);
      }
    }
    record(row);
    h.toast(
      'error',
      `Copy sell NOT placed — ${who} sold ${what} but the size could not be read. You still hold it — sell by hand if you want out.`,
    );
    return;
  }
  // What the leader's transaction sold, and what THIS pass sells of what we
  // still hold. They differ only on an exact top-up (see `exactTopUp`).
  const leaderSold = fraction;
  let theirs = fraction;
  // Acted on once per config, whichever delivery of the sell got here first
  // (see `mirroredSells`). Everything below — a mirror, a threshold skip, a
  // too-late skip — is this config's one answer to that transaction.
  const actKey = t.signature ? `${c.id}:${t.signature}` : null;
  if (actKey) {
    const done = mirroredSells.get(actKey);
    if (done !== undefined) {
      const topUp = exactHere ? exactTopUp(actKey, leaderSold) : null;
      if (topUp === null) {
        h.log(
          'info',
          `copy: ${who}'s ${what} sell ${t.signature!.slice(0, 8)}… arrived again — already mirrored at ${Math.round(done.fraction * 100)}% of their bag, so it is not sold twice`,
        );
        return;
      }
      noteMirrored(`${actKey}:exact`, leaderSold);
      h.log(
        'warn',
        `copy: ${who}'s ${what} sell ${t.signature!.slice(0, 8)}… was sized at ${Math.round(done.fraction * 100)}% from their balance, ` +
          `but the transaction says ${Math.round(leaderSold * 100)}% — selling the difference once (${Math.round(topUp * 100)}% of what is left)`,
      );
      theirs = topUp;
    } else {
      noteMirrored(actKey, theirs, !exactHere);
    }
  }
  // 2026-09-21: a trim under the config's threshold is not mirrored, and the
  // skip is recorded so the scorecard shows what the rule kept you out of.
  // Synthetic exits (an own take-profit, a reverse buy-back) carry 1 and pass.
  // Judged on what the LEADER sold, so a top-up is never refused for being
  // a small remainder of a large sell.
  const minSell = c.minLeaderSellPct ?? null;
  // A retried migration sell already passed this when the leader sold.
  if (minSell !== null && leaderSold * 100 < minSell && !migrationRetries.has(t) && !aiSized.has(t)) {
    const share = Math.max(1, Math.round(leaderSold * 100));
    record(exitSkipped(rows[0], t, share, `not mirrored — they ${oppositeVerb(c)} ${share}% of their bag, under your ${minSell}% threshold`));
    return;
  }
  const pct = Math.max(1, Math.min(100, Math.round(theirs * 100)));
  const leaderPx = t.priceSol > 0 ? t.priceSol : null;
  const spot = h.priceSol(t.mint, chainOf(c));
  const spotPx = spot !== null && Number.isFinite(spot) && spot > 0 ? spot : null;
  // The mark a live exit is estimated at until its own fill is read.
  const exit = leaderPx ?? spotPx;
  // A paper exit mirroring a leader's SELL sells after them, into the price
  // their sell left behind — so it fills at the harsher of their price and
  // the spot, never at their fill alone (2026-10-22). A sell moves the price
  // down; booking ours at theirs was paper crediting us with the leader's
  // place in line. A synthetic exit (an own take-profit or stop, the crowd
  // leaving, a reverse buy-back) carries the tick that triggered it, which
  // is already the market and not anyone's fill.
  const paperExit = !t.note && leaderPx !== null && spotPx !== null ? Math.min(leaderPx, spotPx) : exit;

  // How late this instruction is. A sell recovered after a socket gap can be
  // many minutes old, and the rule is the one a parked exit has always
  // followed through a restart: mirror it while it is still current, record
  // it loudly when it is not. Before trades carried their real time this
  // could not be asked, so an hours-old sell went out as if it were new.
  const late = ageOf(t);
  if (late > LATE_EXIT_MAX_AGE_MS) {
    record(
      exitSkipped(
        rows[0],
        t,
        pct,
        `not executed — ${who} ${t.note ? 'bought this back' : 'sold this'} ${ageText(late)} ago and it only reached this app now. ` +
          'Too old to mirror at today’s price, so nothing was sold. You still hold it.',
      ),
    );
    alertUser(`${what}: not mirrored`, `${who} ${t.note ? 'bought it back' : 'sold it'} ${ageText(late)} ago — too late to mirror. You still hold it; sell by hand if you want out.`);
    return;
  }

  const slices: CopyTrade[] = [];
  let traded = false;
  let signature: string | null = null;
  let fills: LiveExit['fills'] = [];

  if (liveRows.length) {
    if (c.mode !== 'live') {
      // Flipped to paper with a REAL position still open. The wallet holds
      // those tokens; nothing may close them but a sell that happened.
      record(
        exitSkipped(
          liveRows[0],
          t,
          pct,
          'not executed — this config is in paper mode now, and the live position it opened is still held',
        ),
      );
      h.toast('warn', `${who} sold ${pct}% of ${what} — your live position from this config is still open`);
    } else {
      const blocked = (h.exitBlockedReason ?? h.liveBlockedReason)(chainOf(c));
      if (blocked) {
        record(exitSkipped(liveRows[0], t, pct, `not executed — ${blocked}`));
        h.toast('warn', `Copy sell skipped — ${who} sold ${pct}% of ${what}, but ${blocked}`);
      } else {
        const live = await mirrorSell(c, t, liveRows, theirs, exit, h);
        if (!stillConfigured(c.id)) return;
        slices.push(...live.slices);
        signature = live.signature;
        traded = live.traded;
        fills = live.fills;
      }
    }
  }

  // Paper rows are booked whatever happened above: bookkeeping costs
  // nothing, needs no order, and is exactly what would have happened had the
  // config never been flipped. Booked HERE, after the live half, so a config
  // unfollowed mid-sell does not leave a paper row moved on by a slice that
  // was never recorded.
  for (const x of paperRows) slices.push(applyExit(x, theirs, paperExit, t, null));
  if (paperRows.length) traded = true;

  if (!slices.length) return;
  for (const s of slices) trades.unshift(s);
  // This sell DID happen, so an earlier "could not tell how much" row for the
  // same leader transaction was never true (copy-13).
  if (skipKey) {
    const stale = supersededSkips.get(skipKey);
    if (stale) {
      trades = trades.filter((x) => x.id !== stale);
      supersededSkips.delete(skipKey);
    }
  }
  trimTrades();
  // Live slices are priced from their own sells: now, when the ledger had
  // already read the fill, otherwise once it has.
  for (const f of fills) {
    const ids = slices.filter((s) => s.mode === 'live' && s.signature === f.signature && s.pnlBasis === 'pending').map((s) => s.id);
    if (!ids.length) continue;
    if (f.sol !== null) priceLiveExit(ids, f.sol, f.raw);
    else void awaitLiveExitPrice(c, f.signature, ids);
  }
  persist();
  h.changed();
  if (traded) recorder.record('copy_close', { configId: c.id, mint: t.mint, mode: c.mode, pct, signature });
}

/**
 * Base units of THIS copy one slice sold: measured, when the sell settled in
 * base units; otherwise the slice's share of the copy's own quantity, once
 * the buy's fill has said what that is. Null while neither is known.
 */
function sliceTokens(s: CopyTrade): bigint | null {
  const measured = rawOf(s.soldRaw);
  if (measured !== null && measured > 0n) return measured;
  const parent = s.parentId ? trades.find((x) => x.id === s.parentId) : undefined;
  const total = rawOf(parent?.tokensRaw);
  if (total === null || total <= 0n || typeof s.shareOfCopy !== 'number' || !(s.shareOfCopy > 0)) return null;
  return (total * BigInt(Math.round(Math.min(1, s.shareOfCopy) * 1_000_000))) / 1_000_000n;
}

/**
 * Book what a live sell actually returned onto the slices it produced.
 *
 * `sol` is the wallet's net SOL change for that transaction, fees and tips
 * included — what the sell put in the wallet, which is the only proceeds the
 * record may claim — and `raw` the base units it moved. Each slice is
 * credited at that transaction's own price per token, for the tokens IT
 * sold: a sell placed as a share of the whole account may have taken a
 * hand-bought bag along, and those tokens' proceeds are not this copy's.
 * A slice whose tokens are not known yet stays pending; it is priced again
 * when the buy's fill arrives (`repricePending`).
 */
function priceLiveExit(sliceIds: string[], sol: number, raw: bigint | null): void {
  const slices = trades.filter((s) => sliceIds.includes(s.id) && s.pnlBasis === 'pending');
  if (!slices.length || !Number.isFinite(sol)) return;
  const tokens = slices.map(sliceTokens);
  if (tokens.some((n) => n === null)) return;
  const ours = (tokens as bigint[]).reduce((a, n) => a + n, 0n);
  if (ours <= 0n) return;
  // The transaction moved `raw` in all; a book that says these slices sold
  // more than that is stale high, and they are credited with all of it.
  const moved = raw !== null && raw > ours ? raw : ours;
  slices.forEach((s, i) => {
    const mine = tokens[i] as bigint;
    s.proceedsSol = sol * (Number(mine) / Number(moved));
    s.pnlSol = s.proceedsSol - s.ourSol;
    s.pnlBasis = 'fill';
    s.estPnlSol = null;
    if (s.proceedsSol > 0) s.exitPriceSol = s.proceedsSol / uiTokens(mine, s.tokenDecimals);
  });
  for (const parentId of new Set(slices.map((s) => s.parentId).filter((p): p is string => !!p))) rebookCopy(parentId);
}

/** A copy's buy fill just arrived: price any of its exits that were waiting
 *  on it. The sells' own fills are on the ledger's shelf by now. */
async function repricePending(c: CopyConfig, parentId: string): Promise<void> {
  const h = host;
  if (!h?.fillTokens) return;
  const bySig = new Map<string, string[]>();
  for (const s of trades) {
    if (s.parentId !== parentId || s.pnlBasis !== 'pending' || !s.signature) continue;
    bySig.set(s.signature, [...(bySig.get(s.signature) ?? []), s.id]);
  }
  let priced = false;
  for (const [sig, ids] of bySig) {
    let r: FillRead | null = null;
    try {
      r = await h.fillTokens(sig, { walletId: c.walletId ?? undefined, chain: chainOf(c) });
    } catch {
      r = null;
    }
    if (!r || typeof r.sol !== 'number' || !Number.isFinite(r.sol)) continue;
    priceLiveExit(ids, r.sol, rawOf(r.raw));
    priced = true;
  }
  if (priced) {
    persist();
    h.changed();
  }
}

/** A copy's realised result is the sum of its PRICED exits — recomputed, not
 *  accumulated, because a live slice is priced after the fact. */
function rebookCopy(parentId: string): void {
  const parent = trades.find((x) => x.id === parentId);
  if (!parent) return;
  let sum: number | null = null;
  for (const s of trades) {
    if (s.parentId !== parentId || s.kind !== 'exit' || s.state !== 'closed' || s.pnlSol === null) continue;
    sum = (sum ?? 0) + s.pnlSol;
  }
  if (sum !== null) parent.realizedSol = sum;
}

/** How long a live exit waits for the ledger to read its fill, at most. */
const PRICE_FILL_WAIT_MS = 60_000;

async function awaitLiveExitPrice(c: CopyConfig, signature: string, sliceIds: string[]): Promise<void> {
  const h = host;
  if (!h?.fillTokens) return;
  let r: FillRead | null = null;
  try {
    r = await Promise.race([
      h.fillTokens(signature, { walletId: c.walletId ?? undefined, chain: chainOf(c) }),
      new Promise<null>((done) => setTimeout(() => done(null), PRICE_FILL_WAIT_MS)),
    ]);
  } catch {
    r = null;
  }
  if (!r || typeof r.sol !== 'number' || !Number.isFinite(r.sol)) {
    // Stays `pending`: counted as unpriced on the card, and in the daily
    // limit at the model's estimate. Never booked at a guessed price.
    h.log('info', `copy: the ${signature.slice(0, 8)}… sell's fill could not be read — its result stays unpriced`);
    return;
  }
  priceLiveExit(sliceIds, r.sol, rawOf(r.raw));
  persist();
  h.changed();
}

// ── The AI desk (2026-10-28) ──────────────────────────────────────────
//
// A follow with `ai` on asks an AI connected over MCP before it enters and/or
// exits (shared/aiDesk.ts). The verdict can only narrow what the follow would
// have done; silence is the follow's own fallback.

type Facts = Awaited<ReturnType<CopyHost['tokenFacts']>>;

/** Holds the AI gave on a re-firing rule: `config:mint:rule` → until. */
const aiQuiet = new Map<string, number>();

type AiAsking = { configId: string; mint: string; kind: 'entry' | 'exit'; rule: ExitRule | null };
/** Decisions this engine is waiting on, by request id. */
const aiAsking = new Map<string, AiAsking>();

/** Withdraw the pending decisions that match: each asker gets `cancelled`
 *  at once (an entry is then never copied; an exit goes by its rule). */
function withdrawAsks(match: (a: AiAsking) => boolean, why: string): void {
  for (const [id, a] of [...aiAsking]) if (match(a)) host?.aiCancel?.(id, why);
}

/** Ask, remembering the question while it is open so it can be withdrawn. */
async function askAi(h: CopyHost, req: AiRequest, rule: ExitRule | null): Promise<AiAnswer> {
  aiAsking.set(req.id, { configId: req.configId, mint: req.mint, kind: req.kind, rule });
  try {
    return await (h.aiAsk as NonNullable<CopyHost['aiAsk']>)(req);
  } finally {
    aiAsking.delete(req.id);
  }
}

/** A position closed: holds on it lapse with it, so a re-entry inside the
 *  quiet window starts with every rule live. */
function clearAiQuiet(configId: string, mint: string): void {
  const prefix = `${configId}:${mint}:`;
  for (const k of [...aiQuiet.keys()]) if (k.startsWith(prefix)) aiQuiet.delete(k);
}

function aiQuieted(configId: string, mint: string, rule: ExitRule, now: number): boolean {
  const key = `${configId}:${mint}:${rule}`;
  const until = aiQuiet.get(key);
  if (until === undefined) return false;
  if (now < until) return true;
  aiQuiet.delete(key);
  return false;
}

async function askEntry(
  c: CopyConfig,
  t: WalletTrade,
  base: CopyTrade,
  read: Facts | null,
  h: CopyHost,
): Promise<{ skip: string | null; sizeSol: number; note: NonNullable<CopyTrade['ai']>; ms: number }> {
  const gate = c.ai;
  if (!gate || !h.aiAsk) {
    // No desk in this host: as if the AI never answered.
    const copy = gate?.onTimeout === 'copy';
    return { skip: copy ? null : 'no AI desk — skipped (the AI decides this follow’s buys)', sizeSol: base.ourSol, note: { by: 'none', text: 'no AI desk', ms: 0 }, ms: 0 };
  }
  // The filters may not have read the coin; the AI should see what is known.
  let f: Facts | null = read;
  if (!f) {
    try {
      f = await h.tokenFacts(t.mint, chainOf(c));
    } catch {
      f = null;
    }
  }
  const now = Date.now();
  const created = f?.createdAt ?? null;
  const theirAt = t.tradeAt ?? t.at;
  const req: AiEntryRequest = {
    id: h.aiNewId?.() ?? `ai_${now}`,
    kind: 'entry',
    configId: c.id,
    follow: followName(c),
    mode: c.mode,
    chain: chainOf(c),
    wallet: c.wallet,
    mint: t.mint,
    symbol: t.symbol,
    askedAt: now,
    deadline: now + gate.waitSec * 1_000,
    leaderSide: directionOf(c) === 'reverse' ? 'sell' : 'buy',
    leaderSol: t.sol,
    leaderPriceSol: t.priceSol > 0 ? t.priceSol : null,
    leaderAt: theirAt,
    sizeSol: base.ourSol,
    direction: directionOf(c),
    facts: {
      liquidityUsd: f?.liquidityUsd ?? null,
      marketCapUsd: f?.marketCapUsd ?? null,
      kryptScore: f?.kryptScore ?? null,
      isPumpfun: f ? f.isPumpfun : null,
      ageSec: created === null ? null : Math.max(0, Math.round((theirAt - created) / 1_000)),
    },
    ...(base.triggeredBy?.length ? { triggeredBy: base.triggeredBy } : {}),
  };
  const a = await askAi(h, req, null);
  if (a.by === 'ai') {
    const v = a.verdict;
    const text = `AI: ${v.verdict}${v.sizeSol !== undefined ? ` ${v.sizeSol}` : ''} — ${v.reason}`;
    if (v.verdict === 'skip') {
      h.aiSettled?.(req, a, 'skipped');
      return { skip: `AI skipped — ${v.reason}`, sizeSol: base.ourSol, note: { by: 'ai', text, ms: a.ms }, ms: a.ms };
    }
    const size = v.sizeSol ?? base.ourSol;
    h.aiSettled?.(req, a, `approved — copying ${size}`);
    return { skip: null, sizeSol: size, note: { by: 'ai', text, ms: a.ms }, ms: a.ms };
  }
  // A withdrawn request is never copied, whatever the fallback says.
  const copy = gate.onTimeout === 'copy' && !a.why.startsWith('cancelled');
  h.aiSettled?.(req, a, copy ? 'copied anyway — your fallback' : 'skipped — your fallback');
  return {
    skip: copy ? null : `${a.why} — skipped (the AI decides this follow’s buys)`,
    sizeSol: base.ourSol,
    note: { by: 'none', text: `no AI verdict — ${a.why}${copy ? '; copied by your fallback' : ''}`, ms: a.ms },
    ms: a.ms,
  };
}

/**
 * Ask the AI about an exit. Returns the trade to close with — the same, or
 * resized by the AI's percent — or null for hold. Exits that do not ask
 * (gate off, a protective rule, a resumed exit, nothing open) pass through.
 */
async function askExit(c: CopyConfig, t: WalletTrade, rule: ExitRule): Promise<WalletTrade | null> {
  const h = host;
  if (!h?.aiAsk || !exitAsks(c.ai, rule) || !c.ai) return t;
  const rows = trades.filter((r) => r.configId === c.id && r.mint === t.mint && r.state === 'open' && r.kind !== 'exit');
  // Nothing open yet (their sell landed while our buy was in flight):
  // closeOpen parks it, and the parked exit is asked when it drains.
  if (!rows.length) return t;
  const now = Date.now();
  const positionSol = rows.reduce((s, r) => s + r.ourSol, 0);
  const priced = rows.filter((r) => r.entryPriceSol !== null && r.entryPriceSol > 0);
  const weight = priced.reduce((s, r) => s + r.ourSol, 0);
  const entry = weight > 0 ? priced.reduce((s, r) => s + (r.entryPriceSol as number) * r.ourSol, 0) / weight : null;
  // The price the rule fired at (a mark, their sell), else the latest spot.
  const price = t.priceSol > 0 ? t.priceSol : h.priceSol(t.mint, chainOf(c));
  const frac = rule === 'leader' || rule === 'otherExit' ? fractionOf(t) : (t.soldFraction ?? 1);
  const req: AiExitRequest = {
    id: h.aiNewId?.() ?? `ai_${now}`,
    kind: 'exit',
    configId: c.id,
    follow: followName(c),
    // The position's mode, not the follow's: a live copy is real money even
    // after its follow was switched back to paper.
    mode: rows.some((r) => r.mode === 'live') ? 'live' : 'paper',
    chain: chainOf(c),
    wallet: c.wallet,
    mint: t.mint,
    symbol: t.symbol || rows[0].symbol,
    askedAt: now,
    deadline: now + c.ai.waitSec * 1_000,
    rule,
    why: t.note || EXIT_RULE_TEXT[rule],
    sellPct: frac === null ? null : Math.round(frac * 1_000) / 10,
    positionSol,
    entryPriceSol: entry,
    priceSol: price,
    movePct: entry !== null && price !== null && price > 0 ? (price / entry - 1) * 100 : null,
    heldSec: Math.max(0, Math.round((now - Math.min(...rows.map((r) => r.at))) / 1_000)),
  };
  const a = await askAi(h, req, rule);
  const name = `${followName(c)}: ${req.symbol || t.mint.slice(0, 8)}`;
  if (a.by === 'ai' && a.verdict.verdict === 'hold') {
    if (QUIETED_BY_HOLD.has(rule)) aiQuiet.set(`${c.id}:${t.mint}:${rule}`, now + AI_HOLD_QUIET_MS);
    h.aiSettled?.(req, a, 'held');
    h.log('info', `AI desk ${name} — held instead of selling (${req.why}): ${a.verdict.reason}`);
    return null;
  }
  if (a.by === 'ai' && a.verdict.percent !== undefined) {
    h.aiSettled?.(req, a, `selling ${a.verdict.percent}%`);
    const sized: WalletTrade = { ...t, soldFraction: a.verdict.percent / 100, note: `${req.why} — the AI sold ${a.verdict.percent}%` };
    aiSized.add(sized);
    return sized;
  }
  h.aiSettled?.(req, a, a.by === 'ai' ? 'selling' : 'selling by the rule — no AI verdict');
  return t;
}

/**
 * The AI sells part or all of one follow's copy of a coin (2026-10-28,
 * the sell_copy tool). Booked through the follow's own exit path, so the
 * copy's record closes as any exit's would; never asked back to the AI.
 */
export function aiSellCopy(configId: string, mint: string, percent: number, reason: string): { ok: boolean; message: string } {
  const c = configs.find((x) => x.id === configId);
  if (!c) return { ok: false, message: `No follow ${configId}. get_copy_configs lists them.` };
  if (!(percent >= 1 && percent <= 100)) return { ok: false, message: 'percent must be between 1 and 100' };
  const rows = trades.filter((r) => r.configId === c.id && r.mint === mint && r.state === 'open' && r.kind !== 'exit');
  if (!rows.length) return { ok: false, message: `${followName(c)} holds no open copy of ${mint.slice(0, 8)}…` };
  const now = Date.now();
  const symbol = rows[0].symbol;
  const why = `the AI sold ${percent}% — ${reason.trim().slice(0, 200) || 'no reason given'}`;
  const synthetic: WalletTrade = { chain: chainOf(c), wallet: c.wallet, mint, symbol, isBuy: false, sol: 0, priceSol: rows[0].exitPriceSol ?? 0, at: now, tradeAt: now, soldFraction: percent / 100, note: why };
  aiSized.add(synthetic);
  host?.log('info', `AI desk ${followName(c)}: ${symbol || mint.slice(0, 8)} — ${why}`);
  void queueExit(c, synthetic, 'resume');
  return { ok: true, message: `Selling ${percent}% of ${followName(c)}’s ${symbol || mint.slice(0, 8)} copy (${c.mode}).` };
}

/** Follows with the AI gate on, for the AI page. */
export function aiGatedFollows(): Array<{ configId: string; follow: string; mode: 'paper' | 'live'; entries: boolean; exits: boolean }> {
  return configs.filter((c) => aiGateOn(c.ai)).map((c) => ({ configId: c.id, follow: followName(c), mode: c.mode, entries: !!c.ai?.entries, exits: !!c.ai?.exits }));
}

/** A follow's mode, for the tools that act on one — or, given a coin, the
 *  mode of the copy they would act on: 'live' while a live copy is open,
 *  whatever the follow is set to now. */
export function configMode(configId: string, mint?: string): 'paper' | 'live' | null {
  const c = configs.find((x) => x.id === configId);
  if (!c) return null;
  if (mint && trades.some((r) => r.configId === configId && r.mint === mint && r.state === 'open' && r.kind !== 'exit' && r.mode === 'live')) return 'live';
  return c.mode;
}

async function evaluateBuy(c: CopyConfig, t: WalletTrade, extra: Partial<CopyTrade> = {}): Promise<void> {
  const h = host;
  if (!h) return;

  const base: CopyTrade = {
    id: nextId('ct'),
    configId: c.id,
    mode: c.mode,
    chain: chainOf(c),
    wallet: c.wallet,
    mint: t.mint,
    symbol: t.symbol,
    at: t.at,
    theirSol: t.sol,
    ourSol: copySize(c, t.sol),
    entryPriceSol: null,
    exitPriceSol: null,
    closedAt: null,
    pnlSol: null,
    state: 'skipped',
    reason: null,
    direction: directionOf(c),
    // What THEY paid — so every row, skipped ones included, can say how far
    // above the leader we would have been or were.
    leaderPriceSol: t.priceSol > 0 ? t.priceSol : null,
    ...extra,
  };

  // An entry the leader made minutes ago is a different trade at a different
  // price. `staleBuys` already refuses the case where they EXITED while our
  // buy was queued; this is the general rule that case is an instance of, and
  // it is what makes a recovered trade safe to replay at all.
  const stale = ageOf(t);
  if (stale > entryAgeLimit(c)) {
    record({ ...base, reason: `not executed — they bought this ${ageText(stale)} ago, too old to copy` });
    return;
  }
  // The 2026-09-21 refusals that need no token read — their size, a blocked
  // mint, how many times this config has already entered this token — come
  // before a slot is reserved or a fact is fetched.
  const early = prefilter(c, t);
  if (early) {
    record({ ...base, reason: early });
    return;
  }
  const limit = limitHit(c, t.mint);
  if (limit) {
    record({ ...base, reason: limit });
    return;
  }
  // The slot is taken NOW, before the first await, so the next swap in this
  // same slot sees it (copy-1). Everything below runs inside the try.
  reserve(c, Date.now());
  const key = flightKey(c.id, t.mint);
  buysInFlight.set(key, { since: Date.now(), submitted: false });
  try {
    await copyOnce(c, t, base, h);
  } finally {
    release(c.id);
    buysInFlight.delete(key);
    staleBuys.delete(key);
    // Whatever happened above, a sell that landed mid-flight is applied now:
    // the row it needs either exists or never will, and `closeOpen` handles
    // both. Runs last so it sees the row `copyOnce` just recorded.
    drainPendingExit(c, t.mint);
  }
}

/**
 * Refusals that need nothing but the trade and the book (2026-09-21): the
 * leader's size band, the mint blocklist, and the per-token entry cap. Each
 * is a competitor-standard control this app lacked; each is recorded as a
 * skip, like every other filter, so the scorecard shows what it kept out.
 *
 * The entry cap counts rows that ENTERED (open or closed, never a skip and
 * never an exit slice) plus a buy still in flight for this mint, so a leader
 * firing two buys in one slot cannot slip past "buy once".
 */
function prefilter(c: CopyConfig, t: WalletTrade): string | null {
  const minL = c.minLeaderSol ?? null;
  const maxL = c.maxLeaderSol ?? null;
  if (minL !== null && t.sol < minL) return `their trade of ${t.sol.toFixed(3)} is under your ${minL} minimum`;
  if (maxL !== null && t.sol > maxL) return `their trade of ${t.sol.toFixed(3)} is over your ${maxL} maximum`;
  if (isBlocked(c.blockedMints, t.mint)) return 'token is on your blocklist';
  // Trading hours (2026-10-28): an entry outside them is refused; exits
  // never look at the clock.
  const win = activeWindowOf(c);
  if (win && !inActiveWindow(win, localMinuteOfDay())) return `outside your trading hours (${fmtClock(win.fromMin)}–${fmtClock(win.toMin)})`;
  // One position per coin (2026-10-28): a coin ANY follow holds, or is
  // buying this instant, is not bought again through another leader.
  if (c.onePositionPerCoin) {
    const chain = chainOf(c);
    const holder = trades.find((r) => r.state === 'open' && r.kind !== 'exit' && r.mint === t.mint && (r.chain ?? 'solana') === chain);
    const flight = holder ? null : [...buysInFlight.keys()].find((k) => k.endsWith(`:${t.mint}`));
    if (holder || flight) {
      const id = holder ? holder.configId : (flight as string).slice(0, (flight as string).length - t.mint.length - 1);
      const other = configs.find((x) => x.id === id);
      const via = !other || other.id === c.id ? 'this follow' : other.label || other.wallet.slice(0, 6);
      return `already held through ${via} — one position per coin is on`;
    }
  }
  const cap = c.maxBuysPerToken ?? null;
  if (cap !== null) {
    const entered =
      trades.filter((r) => r.configId === c.id && r.mint === t.mint && r.kind !== 'exit' && r.state !== 'skipped').length +
      (buysInFlight.has(flightKey(c.id, t.mint)) ? 1 : 0);
    if (entered >= cap) return cap === 1 ? 'already bought this token once — buy once is on' : `already bought this token ${cap} times — your cap`;
  }
  return null;
}

/**
 * A filter is a REFUSAL, so it fails closed: "I could not read the
 * liquidity" is not "the liquidity is fine" (copy-4).
 *
 * The engine must supply these facts for launch-feed tokens. While it
 * returns null for the whole pump rail, every copy under the default config
 * is refused rather than silently unfiltered — the safe half of the wrong
 * pair, and one the user can see on the record.
 */
function unknownReason(label: string): string {
  return `${label} unknown — the filter you set could not be checked`;
}

/**
 * Does anything this config is set to check actually READ the token facts?
 *
 * `tokenFacts` is a network round trip whenever the mint is not already
 * cached, and the mint a leader has just bought never is. Until 2026-09-21 it
 * was paid on every copy whether or not a single filter looked at the answer
 * — a config with all its filters cleared spent a provider round trip, in the
 * middle of the copy path, to fill a variable nothing read.
 *
 * Every filter below fails CLOSED on an unknown fact, so this must list all
 * of them: a filter left off this list would be checked against an empty
 * facts object and refuse every copy. The test holds the two in step.
 */
function needsFacts(c: CopyConfig): boolean {
  return (
    c.onlyPumpfun ||
    c.minLiquidityUsd !== null ||
    c.maxMarketCapUsd !== null ||
    c.minKryptScore !== null ||
    (c.minMarketCapUsd ?? null) !== null ||
    (c.minTokenAgeSec ?? null) !== null ||
    (c.maxTokenAgeSec ?? null) !== null ||
    !!(c.blockedCreators && c.blockedCreators.length)
  );
}

/** What an unasked lookup answers with: every fact unknown. Safe only because
 *  `needsFacts` is false, so nothing reads it. */
const NO_FACTS = {
  liquidityUsd: null,
  marketCapUsd: null,
  kryptScore: null,
  isPumpfun: false,
  createdAt: null,
  creator: null,
} as const;

/** The leader's leg that cancels our entry: their sell for a copy, their
 *  buy-back for a reverse. */
const oppositeVerb = (c: CopyConfig): string => (directionOf(c) === 'reverse' ? 'bought back' : 'sold');
/** What the entry is called on its record. */
const entryNoun = (c: CopyConfig): string => (directionOf(c) === 'fomo' ? 'convergence entry' : directionOf(c));

async function copyOnce(c: CopyConfig, t: WalletTrade, base: CopyTrade, h: CopyHost): Promise<void> {
  // Where the time goes (2026-09-21). Measured on every copy, live and paper,
  // because a tester benchmarking the path needs the same numbers whether or
  // not they are spending. The stages start here; the delivery half arrived
  // on the trade.
  const checksStart = Date.now();
  // Filters. A rejected copy is RECORDED as skipped with its reason — the
  // paper scorecard must show what the filters kept you out of, or it is
  // only measuring the trades you happened to like.
  let facts: Awaited<ReturnType<CopyHost['tokenFacts']>>;
  // Null, not 0, when the lookup was never made: "did not happen" and "took
  // no time" are different facts, and the timing line prints the difference.
  let factsMs: number | null = null;
  if (needsFacts(c)) {
    try {
      const r = await timed(() => h.tokenFacts(t.mint, chainOf(c)));
      facts = r.value;
      factsMs = r.ms;
    } catch {
      record({ ...base, reason: 'could not read token' });
      return;
    }
  } else {
    facts = { ...NO_FACTS };
  }
  if (!stillConfigured(c.id)) return;
  {
    const gone = withdrawnReason(c, base);
    if (gone) {
      record({ ...base, reason: gone });
      return;
    }
  }
  if (c.onlyPumpfun && !facts.isPumpfun) {
    record({ ...base, reason: 'not a pump.fun token' });
    return;
  }
  if (c.minLiquidityUsd !== null) {
    if (facts.liquidityUsd === null) {
      record({ ...base, reason: unknownReason('liquidity') });
      return;
    }
    if (facts.liquidityUsd < c.minLiquidityUsd) {
      record({ ...base, reason: `liquidity below $${c.minLiquidityUsd.toLocaleString()}` });
      return;
    }
  }
  if (c.maxMarketCapUsd !== null) {
    if (facts.marketCapUsd === null) {
      record({ ...base, reason: unknownReason('market cap') });
      return;
    }
    if (facts.marketCapUsd > c.maxMarketCapUsd) {
      record({ ...base, reason: `market cap above $${c.maxMarketCapUsd.toLocaleString()}` });
      return;
    }
  }
  if (c.minKryptScore !== null) {
    if (facts.kryptScore === null) {
      record({ ...base, reason: unknownReason('score') });
      return;
    }
    if (facts.kryptScore < c.minKryptScore) {
      record({ ...base, reason: `score ${facts.kryptScore} below ${c.minKryptScore}` });
      return;
    }
  }
  // The 2026-09-21 filters that need the token's facts. Same rule as above:
  // a fact the host cannot read refuses the copy and says so.
  const minMc = c.minMarketCapUsd ?? null;
  if (minMc !== null) {
    if (facts.marketCapUsd === null) {
      record({ ...base, reason: unknownReason('market cap') });
      return;
    }
    if (facts.marketCapUsd < minMc) {
      record({ ...base, reason: `market cap below $${minMc.toLocaleString()}` });
      return;
    }
  }
  const minAge = c.minTokenAgeSec ?? null;
  const maxAge = c.maxTokenAgeSec ?? null;
  if (minAge !== null || maxAge !== null) {
    const created = facts.createdAt ?? null;
    if (created === null) {
      record({ ...base, reason: unknownReason('token age') });
      return;
    }
    // Age at THEIR buy, not at ours: a recovered trade is judged as it was.
    const ageMs = Math.max(0, (t.tradeAt ?? t.at) - created);
    if (minAge !== null && ageMs < minAge * 1000) {
      record({ ...base, reason: `token was ${ageText(ageMs)} old — under your ${minAge} s minimum` });
      return;
    }
    if (maxAge !== null && ageMs > maxAge * 1000) {
      record({ ...base, reason: `token was ${ageText(ageMs)} old — over your ${maxAge} s maximum` });
      return;
    }
  }
  if (c.blockedCreators && c.blockedCreators.length) {
    const creator = facts.creator ?? null;
    if (creator === null) {
      record({ ...base, reason: unknownReason('creator') });
      return;
    }
    if (isBlocked(c.blockedCreators, creator)) {
      record({ ...base, reason: 'creator is on your blocklist' });
      return;
    }
  }

  // Everything from the first filter to the last, INCLUDING the token-facts
  // round trip above — which is the one that costs, whenever the mint is not
  // already cached, and for a fresh launch it never is.
  const checkMs = Date.now() - checksStart;

  // The configured delay is REAL, including in paper. Copy trading is a
  // latency game and a paper fill at their price is a fiction.
  const delayStart = Date.now();
  if (c.delayMs > 0) await new Promise((r) => setTimeout(r, c.delayMs));
  const delayMs = Date.now() - delayStart;
  if (!stillConfigured(c.id)) return;
  if (c.delayMs > 0) {
    const gone = withdrawnReason(c, base);
    if (gone) {
      record({ ...base, reason: gone });
      return;
    }
  }

  // The AI desk (2026-10-28): with the gate on, the AI has the final say on
  // the entry — after every filter and the delay, so it is only asked about
  // a trade the follow would take, and BEFORE the price is read, so a paper
  // fill pays for the time it took to think, as a live one would.
  let aiMs: number | null = null;
  if (aiGateOn(c.ai) && c.ai.entries) {
    const g = await askEntry(c, t, base, needsFacts(c) ? facts : null, h);
    aiMs = g.ms;
    if (!stillConfigured(c.id)) return;
    if (g.skip !== null) {
      record({ ...base, reason: g.skip, ai: g.note });
      return;
    }
    // An approval (or the copy-anyway fallback) is for the follow as it was
    // asked about. Paused, stopped or switched meanwhile: not copied.
    const gone = withdrawnReason(c, base);
    if (gone) {
      record({ ...base, reason: gone, ai: g.note });
      return;
    }
    base = { ...base, ourSol: g.sizeSol, ai: g.note };
  }

  /** The breakdown so far, plus whatever the order adds. */
  const timingFor = (sendMs: number | null, trade?: { build?: number; confirm?: number }): CopyTiming => {
    const d = t.delivery;
    // Measured from THEIR fill, which is the stopwatch a tester holds. Null
    // when the trade carried no block time — the answer is then unknown, not
    // zero, and the line simply does not claim a total.
    const from = t.tradeAt ?? null;
    return {
      feed: d?.feed,
      detectMs: d?.detectMs ?? null,
      readMs: d?.readMs ?? null,
      readTries: d?.readTries,
      decodeMs: d?.decodeMs ?? null,
      checkMs,
      factsMs,
      delayMs,
      aiMs,
      sendMs,
      buildMs: trade?.build ?? null,
      confirmMs: trade?.confirm ?? null,
      totalMs: from === null ? null : Math.max(0, Date.now() - from),
      // Ours arrives when the ledger reads the fill (noteBuyQuantity).
      leaderSlot: d?.slot ?? null,
      ourSlot: null,
      slotGap: null,
    };
  };

  /** One line per copy, so a benchmark is a log read and not a code change. */
  const reportTiming = (timing: CopyTiming, mode: 'paper' | 'live'): void => {
    noteTiming(timing);
    const who = c.label || (isFomo(c) ? 'crowd' : c.wallet.slice(0, 6));
    h.log('info', `copy timing ${mode} ${who} ${t.symbol || t.mint.slice(0, 6)}: ${describeCopyTiming(timing)}`);
    recorder.record('copy_timing', { configId: c.id, mint: t.mint, mode, ...timing });
  };

  const entry = h.priceSol(t.mint, chainOf(c)) ?? t.priceSol;
  if (!(entry > 0)) {
    record({ ...base, reason: 'no price at copy time' });
    return;
  }

  // The row's mode decides, never the follow's current one: they are equal
  // here (withdrawnReason), and the row is what every later step reads.
  if (base.mode === 'paper') {
    // Paper follows the same rule as live, or the scorecard measures a
    // strategy the live config would never have run.
    if (staleBuys.has(flightKey(c.id, t.mint))) {
      record({ ...base, reason: `not executed — they had already ${oppositeVerb(c)} before this ${entryNoun(c)} was sent` });
      return;
    }
    const oldPaper = ageOf(t);
    if (oldPaper > entryAgeLimit(c)) {
      record({ ...base, reason: `not executed — their buy was ${ageText(oldPaper)} old by the time this copy could be sent` });
      return;
    }
    const paperTiming = timingFor(null);
    clearAiQuiet(c.id, t.mint);
    record({ ...base, state: 'open', entryPriceSol: entry, timing: paperTiming, paperModel: PAPER_MODEL });
    h.log('info', `paper-${directionOf(c)} ${c.label || (isFomo(c) ? 'crowd' : c.wallet.slice(0, 6))}: ${base.ourSol} SOL of ${t.symbol}`);
    // Paper has no order, so the line stops at the checks — which is still
    // the whole detection half, and the half a tester can benchmark without
    // spending anything.
    reportTiming(paperTiming, 'paper');
    recorder.record('copy_open', { configId: c.id, mint: t.mint, mode: 'paper', ourSol: base.ourSol, entry });
    return;
  }

  // Live.
  const blocked = h.liveBlockedReason(chainOf(c)) ?? h.buyBlockedReason?.(chainOf(c)) ?? null;
  if (blocked) {
    record({ ...base, reason: `not executed — ${blocked}` });
    h.toast('warn', `Copy skipped — ${blocked}`);
    return;
  }
  // A live Krypto Trader session holds this coin in the wallet this config
  // buys from (its own, or the active one): a copy would mix bags, and the
  // session would pause on the fill. Refused with the session named.
  // Every chain: on BNB / Robinhood the pair is (chain, this config's wallet
  // or the chain's signer, coin) — stage 4.
  {
    const claim = chainOf(c) === 'solana' ? traderClaimFor({ walletId: c.walletId ?? null }, t.mint) : traderClaimFor({ walletId: c.walletId ?? null, chain: chainOf(c) }, t.mint);
    if (claim) {
      record({ ...base, reason: `not executed — ${claim}` });
      h.toast('warn', `Copy skipped — ${claim}`);
      return;
    }
  }
  // House rule 2: a budget is a refusal, not a clamp. Automation refuses over
  // the live cap; a copy that silently shrank to fit would report a size it
  // never traded and score the experiment against the wrong number (copy-8).
  const cap = h.maxLiveSol?.(chainOf(c)) ?? null;
  if (cap !== null && Number.isFinite(cap) && cap > 0 && base.ourSol > cap) {
    record({ ...base, reason: `copy of ${base.ourSol} SOL is above your live cap of ${cap} SOL` });
    h.toast('warn', `Copy skipped — ${base.ourSol} SOL is above your live max per trade (${cap} SOL)`);
    return;
  }
  // The live minimum (2026-10-22), the floor's other side: a copy this small
  // pays over 10% of itself in round-trip priority fees. A refusal, never a
  // raise — rounding a proportional copy UP would spend more than was asked.
  if (chainOf(c) === 'solana' && base.ourSol < MIN_LIVE_COPY_SOL) {
    record({ ...base, reason: `not executed — ${base.ourSol} SOL is under the smallest live copy (${MIN_LIVE_COPY_SOL} SOL); fees would take over 10% of it` });
    h.toast('warn', `Copy skipped — ${base.ourSol} SOL is under the smallest live copy (${MIN_LIVE_COPY_SOL} SOL)`);
    return;
  }
  // Last gate before real money leaves: did the leader exit while we were
  // reading token facts and serving the configured delay? Copying an entry
  // into a position they have already closed is not copying them, and it is
  // the leg that lost the money in the 2026-09-13 report.
  const key = flightKey(c.id, t.mint);
  if (staleBuys.has(key)) {
    record({ ...base, reason: `not executed — they had already ${oppositeVerb(c)} before this ${entryNoun(c)} was sent` });
    h.toast('warn', `Copy skipped — ${c.label || c.wallet.slice(0, 6)} ${oppositeVerb(c)} ${t.symbol} before your buy went out`);
    return;
  }
  // Checked again HERE, at the last gate before real money leaves: the token
  // facts and the configured delay above can take a while, and the age that
  // matters is the one at the moment of sending.
  const aged = ageOf(t);
  if (aged > entryAgeLimit(c)) {
    record({ ...base, reason: `not executed — their buy was ${ageText(aged)} old by the time this copy could be sent` });
    h.toast('warn', `Copy skipped — ${c.label || c.wallet.slice(0, 6)}'s ${t.symbol} buy was ${ageText(aged)} old before yours could go out`);
    return;
  }
  // The last look at the follow itself before money leaves: nothing above
  // re-read it after the price lookup.
  {
    const gone = withdrawnReason(c, base);
    if (gone) {
      record({ ...base, reason: gone });
      return;
    }
  }
  // From here the transaction can reach the chain, so it can no longer be
  // abandoned — only followed by an exit.
  const flight = buysInFlight.get(key);
  if (flight) flight.submitted = true;
  const sendStart = Date.now();
  const res = await h.buy(t.mint, base.ourSol, { slippagePct: c.maxSlippagePct, walletId: c.walletId ?? undefined, chain: chainOf(c) });
  const sendMs = Date.now() - sendStart;
  const timing = timingFor(sendMs, res.timing);
  // Reported whatever the outcome: a copy that FAILED slowly is the most
  // interesting row in a latency benchmark, and one that only logged on
  // success would hide exactly those.
  reportTiming(timing, 'live');
  if (!stillConfigured(c.id)) return;
  if (res.ok || res.pending === true) {
    // What was actually spent and actually filled, when the host knows it —
    // the requested size is a wish, and scoring a copy against a wish makes
    // every derived number wrong by asked over spent (copy-8).
    const spent = typeof res.spentSol === 'number' && res.spentSol > 0 ? res.spentSol : base.ourSol;
    const fill = typeof res.fillPriceSol === 'number' && res.fillPriceSol > 0 ? res.fillPriceSol : entry;
    // A broadcast that has not confirmed still bought the token, so the
    // position is real and must be openable — with the caveat ON the record,
    // not hidden (copy-5).
    const unconfirmed = !res.ok && res.pending === true;
    const row: CopyTrade = {
      ...base,
      ourSol: spent,
      state: 'open',
      entryPriceSol: fill,
      // A placeholder until the ledger reads the fill, and then replaced by
      // it (noteBuyQuantity). The row says which it is.
      entryBasis: typeof res.fillPriceSol === 'number' && res.fillPriceSol > 0 ? 'fill' : 'mark',
      reason: unconfirmed ? 'broadcast — not confirmed yet' : null,
      signature: res.signature ?? null,
      timing,
    };
    clearAiQuiet(c.id, t.mint);
    record(row);
    // How many tokens the buy actually delivered, once the chain says so.
    // Not awaited: the copy is open and recorded either way, and this number
    // is only needed by an exit — which is minutes away at the fastest, and
    // falls back to the percentage path if it is not here yet.
    // Never rejects: an exit waiting on it must fall back, not fail.
    const reading = noteBuyQuantity(c, row.id, res)
      .catch((e) => h.log('warn', `copy: reading the fill of ${row.symbol || row.mint.slice(0, 8)} failed — ${(e as Error).message}`))
      .finally(() => quantityReads.delete(row.id));
    quantityReads.set(row.id, reading);
    void reading;
    h.toast(
      unconfirmed ? 'info' : 'success',
      `${directionOf(c) === 'reverse' ? 'Reversed' : directionOf(c) === 'fomo' ? 'Converged' : 'Copied'} ${c.label || (isFomo(c) ? 'crowd' : c.wallet.slice(0, 6))}: ${spent} SOL of ${t.symbol}${unconfirmed ? ' (unconfirmed)' : ''}`,
    );
    recorder.record('copy_open', {
      configId: c.id,
      chain: chainOf(c),
      mint: t.mint,
      mode: 'live',
      ourSol: spent,
      signature: res.signature ?? null,
      pending: unconfirmed,
    });
    failStreak.delete(c.id);
  } else if (curveMigrating(res.message)) {
    // Most often the leader's own buy emptied the curve: nothing trades
    // until the PumpSwap pool opens. A skip with its reason, not a failure.
    record({ ...base, reason: 'skipped — the coin is moving from pump’s curve to PumpSwap, and nothing can trade until it lands' });
    h.log('info', `copy: ${t.symbol || t.mint.slice(0, 8)} is migrating to PumpSwap — the buy was skipped, not failed`);
  } else {
    record({ ...base, reason: res.message.slice(0, 160) });
    // Three sent-and-failed copies in a row pause the follow: the route, the
    // wallet or the venue is broken, and each further try costs fees.
    const n = (failStreak.get(c.id) ?? 0) + 1;
    failStreak.set(c.id, n);
    if (n >= COPY_FAIL_PAUSE) autoPause(c, `${n} copies in a row failed to send — the last: ${res.message.slice(0, 120)}`);
    else h.toast('error', `Copy failed: ${res.message}`);
  }
}

/**
 * Close LIVE copy rows whose tokens are no longer in the wallet.
 *
 * A copy row is opened by a buy and closed by a mirrored sell. Nothing else
 * used to touch it — so selling the position by hand, or letting a stop-loss
 * or a take-profit ladder take it, left the copy standing as "open" forever:
 * it kept a slot in `openCount`, kept being marked to market, and kept being
 * priced by the engine's poll. A user reported three fully sold positions
 * (FUZZ, anal and a SOL-quoted mint) still showing open (2026-09-13).
 *
 * `heldMints` must be a COMPLETE, successful read of the wallet's holdings.
 * A failed read is not an empty wallet, and the caller must not pass one —
 * closing every live copy on a timed-out RPC is a far worse bug than the one
 * this fixes. `configIds` names the configs that wallet actually signs for;
 * rows belonging to a config pinned to a different signer are left alone.
 *
 * Realised PnL stays NULL on these rows on purpose: the tokens left through
 * a sale this module never saw, so it has no exit price, and inventing one
 * would put a made-up number into the scorecard. The row says what happened
 * instead.
 */
export function reconcileHoldings(
  heldMints: Set<string>,
  opts: { graceMs?: number; configIds?: Set<string> } = {},
): number {
  const grace = opts.graceMs ?? 90_000;
  const only = opts.configIds ?? null;
  const now = Date.now();
  let closed = 0;
  for (const x of trades) {
    if (x.state !== 'open' || x.mode !== 'live' || x.kind === 'exit') continue;
    if ((x.chain ?? 'solana') !== 'solana') continue; // this read is the Solana wallet's
    // A config can sign with a wallet that is not the active one. This read
    // describes ONE wallet, and another wallet's holdings say nothing about
    // whether these tokens are still held — closing on them would be the
    // same bug in the other direction.
    if (only !== null && !only.has(x.configId)) continue;
    if (heldMints.has(x.mint)) continue;
    // A buy that has just been broadcast is not in the wallet yet. Closing it
    // on the next poll would report every fresh copy as already gone.
    if (now - x.at < grace) continue;
    if (buysInFlight.has(flightKey(x.configId, x.mint))) continue;
    x.state = 'closed';
    x.closedAt = now;
    x.remainingPct = 0;
    // The mint is not in the wallet at all, so whatever the book thought this
    // copy still held, it does not. Zeroing it here keeps the leftover sweep
    // from flagging a row it has just closed for the opposite reason.
    if (rawOf(x.tokensLeftRaw) !== null) x.tokensLeftRaw = '0';
    x.leftoverRaw = null;
    x.reason = 'closed — these tokens are no longer in the wallet (sold by hand, or by one of your orders)';
    closed += 1;
  }
  if (closed > 0) {
    persist();
    host?.changed();
    host?.log('info', `copy: closed ${closed} copy row${closed === 1 ? '' : 's'} whose tokens are no longer held`);
  }
  return closed;
}

/** Rows already announced as leftovers. A flag is news once, not every poll. */
const flaggedLeftovers = new Set<string>();

/**
 * How long a copy row is left alone after it last moved.
 *
 * A sell that has just confirmed is not in the next balance read yet, and
 * neither is a buy that has just landed — so a sweep run inside this window
 * would zero a quantity the chain simply has not caught up with, or flag
 * every fresh exit as a leftover. Past it, silence from the chain means the
 * tokens really are (or are not) there.
 */
const LEFTOVER_GRACE_MS = 60_000;

/**
 * Compare a set of copy rows for ONE mint against the balance the chain
 * reports, and move the book — never the wallet — to match.
 *
 * Three things happen, all of them comparisons and none of them a trade:
 *
 *   • a copy the wallet holds none of has its tracked quantity zeroed —
 *     whatever our book said, those tokens are not there;
 *   • tracked quantities are scaled down to fit the balance when they add up
 *     to more than it, because several rows can each think they own tokens a
 *     hand sell already took;
 *   • a CLOSED row still holding a non-dust remainder is flagged, said out
 *     loud once, and shown on the record until it is resolved.
 */
function applyBalance(
  mint: string,
  rows: CopyTrade[],
  balance: bigint,
  decimals: number | null,
  now: number,
): { flagged: number; cleared: number; changed: boolean } {
  let flagged = 0;
  let cleared = 0;
  let changed = false;
  // A row that moved a moment ago is described by a read the chain has not
  // served yet. Applied to every branch below, not only to the flag.
  const settledRows = rows.filter((x) => now - Math.max(x.at, x.closedAt ?? 0) >= LEFTOVER_GRACE_MS);
  if (!settledRows.length) return { flagged, cleared, changed };

  if (balance <= 0n) {
    for (const x of settledRows) {
      const had = (rawOf(x.tokensLeftRaw) ?? 0n) > 0n;
      if (!had && !x.leftoverRaw && x.state !== 'open') continue;
      x.tokensLeftRaw = '0';
      if (x.leftoverRaw) cleared += 1;
      x.leftoverRaw = null;
      flaggedLeftovers.delete(x.id);
      if (x.state === 'open') {
        // The wallet holds none of this mint. `reconcileHoldings` says the
        // same thing for Solana off a full holdings read; the EVM rails have
        // no such read, so without this an EVM copy sold by hand stayed open
        // forever — the 2026-09-13 bug, still live on those chains.
        x.state = 'closed';
        x.closedAt = now;
        x.remainingPct = 0;
        x.reason = 'closed — these tokens are no longer in the wallet (sold by hand, or by one of your orders)';
      }
      changed = true;
    }
    return { flagged, cleared, changed };
  }

  // Our book can only be stale HIGH. Scale it back to the chain rather than
  // let two rows claim the same tokens.
  const tracked = settledRows.reduce((a, x) => a + (rawOf(x.tokensLeftRaw) ?? 0n), 0n);
  if (tracked > balance) {
    for (const x of settledRows) {
      const left = rawOf(x.tokensLeftRaw) ?? 0n;
      const fitted = (left * balance) / tracked;
      if (fitted !== left) {
        x.tokensLeftRaw = fitted.toString();
        changed = true;
      }
    }
  }

  for (const x of settledRows) {
    if (decimals !== null && typeof x.tokenDecimals !== 'number') {
      x.tokenDecimals = decimals;
      changed = true;
    }
    const left = rawOf(x.tokensLeftRaw) ?? 0n;
    const total = rawOf(x.tokensRaw);
    const dust = total === null ? left <= 0n : isDustRemainder(left, total);

    if (x.state !== 'closed' || dust) {
      // An open row holding its own tokens is the ordinary case, and a
      // closed one down to dust is a finished copy.
      if (x.leftoverRaw) {
        x.leftoverRaw = null;
        flaggedLeftovers.delete(x.id);
        cleared += 1;
        changed = true;
      }
      continue;
    }

    const leftover = left < balance ? left : balance;
    if (x.leftoverRaw === leftover.toString()) continue;
    x.leftoverRaw = leftover.toString();
    x.reason =
      `marked closed, but ${fmtTokens(leftover, x.tokenDecimals ?? decimals)} ${x.symbol || 'tokens'} from this copy ` +
      'are still in your wallet — sell them by hand, or leave them for the next sell this wallet mirrors';
    flagged += 1;
    changed = true;
    if (!flaggedLeftovers.has(x.id)) {
      flaggedLeftovers.add(x.id);
      if (flaggedLeftovers.size > 500) {
        const oldest = flaggedLeftovers.values().next().value;
        if (oldest !== undefined) flaggedLeftovers.delete(oldest);
      }
      host?.log(
        'warn',
        `copy: ${x.symbol || mint.slice(0, 8)} is marked closed but ${leftover} base units from that copy are still held`,
      );
      host?.toast(
        'warn',
        `${x.symbol || mint.slice(0, 8)}: a copy is marked closed but ${fmtTokens(leftover, x.tokenDecimals ?? decimals)} tokens are still in your wallet.`,
      );
    }
  }
  return { flagged, cleared, changed };
}

/** Live copy rows carrying a tracked quantity, by mint, for one scope. */
function quantityRows(pick: (x: CopyTrade) => boolean): Map<string, CopyTrade[]> {
  const byMint = new Map<string, CopyTrade[]>();
  for (const x of trades) {
    if (x.mode !== 'live' || x.kind === 'exit') continue;
    if (rawOf(x.tokensLeftRaw) === null) continue;
    if (buysInFlight.has(flightKey(x.configId, x.mint))) continue;
    if (!pick(x)) continue;
    const list = byMint.get(x.mint);
    if (list) list.push(x);
    else byMint.set(x.mint, [x]);
  }
  return byMint;
}

/**
 * Check the copy book against a COMPLETE holdings read (2026-09-15).
 *
 * `reconcileHoldings` above answers "are these tokens gone?". This answers
 * the question that caught nobody: "our record says this copy is finished —
 * is it?". A sell sized as a share of a balance can come back short, and
 * when it does the old book wrote the leader's fraction down as done and
 * moved on, leaving real inventory outside every open-position view. That is
 * the reported bug, and this is the net under it.
 *
 * `held` must be a COMPLETE, successful read of one Solana wallet's holdings
 * — a failed read is not an empty wallet — and `configIds` names the configs
 * that wallet actually signs for. `sweepBalances` below is the per-mint
 * version, for the chains that have no such read.
 */
export function reconcileQuantities(
  held: Map<string, { raw: string; decimals: number }>,
  opts: { configIds?: Set<string>; now?: number } = {},
): { flagged: number; cleared: number } {
  const only = opts.configIds ?? null;
  const now = opts.now ?? Date.now();
  let flagged = 0;
  let cleared = 0;
  let changed = false;
  const byMint = quantityRows((x) => (x.chain ?? 'solana') === 'solana' && (only === null || only.has(x.configId)));
  for (const [mint, rows] of byMint) {
    const r = applyBalance(mint, rows, rawOf(held.get(mint)?.raw) ?? 0n, held.get(mint)?.decimals ?? null, now);
    flagged += r.flagged;
    cleared += r.cleared;
    changed = changed || r.changed;
  }
  if (changed) {
    persist();
    host?.changed();
  }
  return { flagged, cleared };
}

/**
 * At most this many balance reads per sweep.
 *
 * The sweep exists to catch a leftover, which is a thing that does not
 * change between one minute and the next. Reading every open copy's mint on
 * every pass would put a burst of `getTokenAccountsByOwner` against an
 * endpoint the user is already rate-limited by, so the mints are taken
 * least-recently-swept first and the rest wait for the next pass.
 */
const SWEEP_MAX_READS = 8;

/**
 * How long a settling exit waits for the ledger to reconcile its own fill.
 *
 * The fill's token delta is the exact number, but waiting for it holds the
 * mint's exit chain: the top-up sell and the leader's NEXT sell of the same
 * token both queue behind it. Eight seconds, then the balance read — which
 * is immediate, and which the sweep re-checks anyway.
 */
const SETTLE_FILL_WAIT_MS = 8_000;
/** `${walletId}:${chain}:${mint}` → when the sweep last read that balance. */
const lastSwept = new Map<string, number>();

/**
 * Re-read balances for the mints live copies are open on, and reconcile.
 *
 * The Solana path gets this for free off `readHoldings`, which is a complete
 * wallet read the app already makes. The EVM rails have no such read, and a
 * copy signed by a wallet that is not the active one is not described by the
 * active wallet's holdings either — so this asks the host for exactly the
 * balances the book has an opinion about, one at a time, and nothing else.
 *
 * A balance that cannot be read is skipped. Unreadable is not empty.
 */
export async function sweepBalances(opts: { max?: number; now?: number } = {}): Promise<{ read: number; flagged: number; cleared: number }> {
  const h = host;
  const out = { read: 0, flagged: 0, cleared: 0 };
  if (!h?.walletTokens) return out;
  const now = opts.now ?? Date.now();

  // One read per (signing wallet, chain, mint). Rows sharing all three share
  // the answer, which is what `applyBalance` is given.
  const groups = new Map<string, { c: CopyConfig; mint: string; rows: CopyTrade[] }>();
  for (const [mint, rows] of quantityRows(() => true)) {
    for (const x of rows) {
      const c = configs.find((y) => y.id === x.configId);
      if (!c) continue;
      // Nothing can change for a finished row the book agrees is empty.
      if (x.state === 'closed' && (rawOf(x.tokensLeftRaw) ?? 0n) === 0n && !x.leftoverRaw) continue;
      if (now - Math.max(x.at, x.closedAt ?? 0) < LEFTOVER_GRACE_MS) continue;
      const key = `${c.walletId ?? ''}:${chainOf(c)}:${mint}`;
      const g = groups.get(key);
      if (g) g.rows.push(x);
      else groups.set(key, { c, mint, rows: [x] });
    }
  }

  const due = [...groups.entries()]
    .sort((a, b) => (lastSwept.get(a[0]) ?? 0) - (lastSwept.get(b[0]) ?? 0))
    .slice(0, opts.max ?? SWEEP_MAX_READS);

  let changed = false;
  for (const [key, g] of due) {
    if (!stillConfigured(g.c.id)) continue;
    const bal = await readWalletTokens(h, g.c, g.mint);
    lastSwept.set(key, Date.now());
    if (lastSwept.size > 500) {
      const oldest = lastSwept.keys().next().value;
      if (oldest !== undefined) lastSwept.delete(oldest);
    }
    if (!bal) continue;
    out.read += 1;
    const r = applyBalance(g.mint, g.rows, bal.raw, bal.decimals, now);
    out.flagged += r.flagged;
    out.cleared += r.cleared;
    changed = changed || r.changed;
  }
  if (changed) {
    persist();
    h.changed();
  }
  return out;
}

/**
 * Rows the backfill has already tried. A row whose buy is not in the ledger
 * has no answer to find, and re-scanning for it every sweep is a cost with
 * no upside.
 */
const backfillTried = new Set<string>();

/**
 * Recover the token quantity for OPEN live copies that have none.
 *
 * A copy opened before 2026-09-15 carries no base units, so it exits through
 * the old cost-ratio percentage and can be closed over tokens that never
 * left — the reported bug, still reachable for exactly those rows. The
 * quantity is not lost, though: the copy's buy is a fill in the ledger, and
 * the ledger reconciled the transaction's own token delta at the time.
 *
 * Matched by the buy signature when the row carries one, otherwise by
 * (wallet, mint) in the ledger — which the host resolves, because only it
 * knows what this install actually traded. An ambiguous match is REFUSED:
 * adopting the wrong fill's quantity would size a real sell from a number
 * about a different trade, and "unknown" already has a safe meaning here.
 */
export async function backfillQuantities(limit = 12): Promise<number> {
  const h = host;
  if (!h) return 0;
  const rows = trades
    .filter(
      (x) =>
        x.mode === 'live' &&
        x.kind !== 'exit' &&
        x.state === 'open' &&
        !x.tokensRaw &&
        !backfillTried.has(x.id) &&
        !buysInFlight.has(flightKey(x.configId, x.mint)),
    )
    .slice(0, limit);
  if (!rows.length) return 0;

  let filled = 0;
  for (const row of rows) {
    backfillTried.add(row.id);
    const c = configs.find((x) => x.id === row.configId);
    if (!c) continue;
    const opts: CopyExecOpts = { walletId: c.walletId ?? undefined, chain: chainOf(c) };
    let got: { raw: string; decimals: number } | null = null;
    if (row.signature && h.fillTokens) {
      try {
        got = await h.fillTokens(row.signature, opts);
      } catch {
        got = null;
      }
    }
    if (!got && h.buyFill) {
      try {
        got = await h.buyFill(row.mint, row.at, opts);
      } catch {
        got = null;
      }
    }
    const raw = got ? rawOf(got.raw) : null;
    if (raw === null || raw <= 0n) continue;
    // Still the same row? It may have been sliced while the ledger was read.
    const live = trades.find((x) => x.id === row.id);
    if (!live || live.tokensRaw) continue;
    live.tokensRaw = raw.toString();
    live.tokenDecimals = got!.decimals;
    // Whatever was already sold off this row went out on the old percentage
    // path, so the remainder is what `remainingPct` says of what we now know.
    const pct = Math.max(0, Math.min(100, live.remainingPct ?? 100));
    live.tokensLeftRaw = ((raw * BigInt(Math.round(pct * 100))) / 10_000n).toString();
    filled += 1;
  }
  if (filled > 0) {
    persist();
    h.changed();
    h.log('info', `copy: recovered the token quantity of ${filled} open cop${filled === 1 ? 'y' : 'ies'} from the ledger`);
  }
  return filled;
}

/**
 * Is there anything for the balance sweep to look at?
 *
 * A live config, or a live row still carrying tokens. The second half
 * matters: a LIVE config comes back from a restart DISARMED while its
 * positions come back open, and those are exactly the rows a leftover would
 * sit in unnoticed.
 */
export function needsSweep(): boolean {
  if (configs.some((c) => c.mode === 'live')) return true;
  return trades.some((x) => x.mode === 'live' && x.kind !== 'exit' && (x.state === 'open' || !!x.leftoverRaw));
}

/** Mark paper positions to market so open PnL is not stale. */
export function markToMarket(mint: string, priceSol: number, chain?: ChainKind, now = Date.now()): void {
  if (!(priceSol > 0)) return;
  for (const t of trades) {
    if (t.state !== 'open' || t.mint !== mint || t.entryPriceSol === null) continue;
    if (chain !== undefined && (t.chain ?? 'solana') !== chain) continue;
    t.exitPriceSol = priceSol;
    // The high-water mark the trailing stop measures from (2026-09-21). A
    // row opened this session starts at its entry; one carried across a
    // restart starts at the first price seen since (see `bootAt`).
    t.peakPriceSol = Math.max(t.peakPriceSol ?? (resumedRow(t) ? priceSol : (t.exitAnchorPriceSol ?? t.entryPriceSol)), priceSol);
  }
  for (const b of Object.values(leaders)) {
    const p = b.positions[mint];
    if (p) p.markPriceSol = priceSol;
  }
  checkOwnExits(mint, priceSol, chain, now);
}

// ── Own exits ─────────────────────────────────────────────────────────
//
// A reverse position was opened by the leader SELLING, a FOMO position by a
// crowd, and neither has a leader sell to close it, so the position closes
// on its own terms: the config's take-profit, stop-loss or maximum hold,
// judged on every price tick the engine already delivers here (the tape for
// taped mints, the 12 s orders poll for the rest). A copy config may set
// them too, on top of the leader's sells. The exit itself is the ordinary
// mirrored sell of 100 %, queued like any other, so paper and live book it
// the same way and a second tick cannot fire it twice.

/** `${configId}:${mint}` with an exit in flight. */
const ownExiting = new Set<string>();

/**
 * Event exits (a creator sell, graduation, the leader leaving without a SOL
 * sale) that fired while another exit on the same copy was still running —
 * usually one waiting on the AI. They are one-time events, so dropping them
 * lost them; they run when that exit finishes, if anything is still open.
 */
const deferredExits = new Map<string, { c: CopyConfig; t: WalletTrade; rule: ExitRule }>();

/** Run an exit as the one in flight for its key, then any deferred behind it. */
function runOwnExit(key: string, c: CopyConfig, t: WalletTrade, rule: ExitRule): void {
  ownExiting.add(key);
  void queueExit(c, t, rule).finally(() => {
    ownExiting.delete(key);
    const d = deferredExits.get(key);
    if (!d) return;
    deferredExits.delete(key);
    if (!stillConfigured(d.c.id)) return;
    if (!trades.some((r) => r.configId === d.c.id && r.mint === d.t.mint && r.state === 'open' && r.kind !== 'exit')) return;
    runOwnExit(key, d.c, d.t, d.rule);
  });
}

/**
 * A protective rule fired on a copy whose other exit is waiting on the AI:
 * withdraw that question, so its exit goes ahead by its own rule now and the
 * protective one is next in line, instead of both waiting out the deadline.
 */
function withdrawForProtective(c: CopyConfig, mint: string, rule: ExitRule): void {
  if (exitAsks(c.ai, rule)) return; // this rule waits for the AI itself
  withdrawAsks((a) => a.configId === c.id && a.mint === mint && a.kind === 'exit', `${EXIT_RULE_TEXT[rule]} fired`);
}

/**
 * The max-hold rule on a CLOCK, not only on price ticks (2026-10-23).
 * `checkOwnExits` used to run only from `markToMarket`, so a coin that
 * stopped printing — the dead bag a missed leader sell leaves behind, which is
 * what the Simple presets' 30-minute backstop exists for — never fired its
 * max hold. Called on a timer by the engine; judges max hold only (no price,
 * no take-profit or stop), and the exit is the ordinary queued 100 % sell,
 * sized from our balance, so it needs no price either.
 */
export function checkMaxHolds(now = Date.now()): void {
  checkWalletStops();
  retryMigrationWaits(now);
  const seen = new Set<string>();
  for (const r of trades) {
    if (r.state !== 'open' || r.kind === 'exit') continue;
    const k = `${r.chain ?? 'solana'}:${r.mint}`;
    if (seen.has(k)) continue;
    seen.add(k);
    checkOwnExits(r.mint, null, r.chain ?? 'solana', now);
  }
}

function checkOwnExits(mint: string, priceSol: number | null, chain: ChainKind | undefined, now: number): void {
  for (const c of configs) {
    // Not gated on `enabled` (2026-10-22): a paused config — every live one
    // after a restart — still holds what it bought, and an exit rule the
    // user set is protection they believe they have. The rows below are the
    // gate: nothing open, nothing to check.
    if (chain !== undefined && chainOf(c) !== chain) continue;
    const x = ownExitsOf(c);
    if (x.takeProfitPct === null && x.stopLossPct === null && x.maxHoldMin === null && x.trailingPct === null) continue;
    // The clock pass (no price) judges max hold alone.
    if (priceSol === null && x.maxHoldMin === null) continue;
    const key = flightKey(c.id, mint);
    const rows = trades.filter(
      (r) => r.configId === c.id && r.mint === mint && r.state === 'open' && r.kind !== 'exit' && r.entryPriceSol !== null && r.entryPriceSol > 0,
    );
    if (!rows.length) continue;
    const tag = directionOf(c);
    let why: string | null = null;
    let rule: ExitRule = 'maxHold';
    // A rule the AI said hold on is quiet until the hold lapses — that rule
    // alone: the others are still judged, so a held take-profit or max hold
    // never silences the trailing stop or a later row's stop-loss.
    const live = (r: ExitRule): boolean => !aiQuieted(c.id, mint, r, now);
    for (const r of rows) {
      const resumed = resumedRow(r);
      // A row carried across a restart counts its hold from the restart: the
      // clock that ran while the app was shut is not a hold anyone watched.
      const heldFrom = resumed ? Math.max(r.at, bootAt) : r.at;
      if (priceSol === null) {
        if (x.maxHoldMin !== null && now - heldFrom >= x.maxHoldMin * 60_000 && live('maxHold')) [why, rule] = [`max hold ${x.maxHoldMin} min (${tag})`, 'maxHold'];
        if (why) break;
        continue;
      }
      // From the fee-free fill price on a live copy (exitAnchorPriceSol).
      const anchor = r.exitAnchorPriceSol && r.exitAnchorPriceSol > 0 ? r.exitAnchorPriceSol : (r.entryPriceSol as number);
      const movePct = (priceSol / anchor - 1) * 100;
      if (x.takeProfitPct !== null && movePct >= x.takeProfitPct && live('takeProfit')) [why, rule] = [`take-profit +${x.takeProfitPct}% (${tag})`, 'takeProfit'];
      else if (x.stopLossPct !== null && movePct <= -x.stopLossPct && live('stopLoss')) [why, rule] = [`stop-loss −${x.stopLossPct}% (${tag})`, 'stopLoss'];
      else if (x.maxHoldMin !== null && now - heldFrom >= x.maxHoldMin * 60_000 && live('maxHold')) [why, rule] = [`max hold ${x.maxHoldMin} min (${tag})`, 'maxHold'];
      else if (x.trailingPct !== null && live('trailing')) {
        // Armed from entry: the peak is never below the entry, so a position
        // that only ever fell stops at −X % like a stop-loss would. A row
        // carried across a restart is armed from the first price seen since
        // instead — its entry-to-now drop happened while nobody watched, and
        // a trailing stop resumed against it would fire on the first tick.
        const floor = resumed ? priceSol : anchor;
        const peak = Math.max(r.peakPriceSol ?? floor, floor, priceSol);
        const drop = (1 - priceSol / peak) * 100;
        if (drop >= x.trailingPct) [why, rule] = [`trailing stop −${x.trailingPct}% from peak (${tag})`, 'trailing'];
      }
      if (why) break;
    }
    if (!why) continue;
    if (ownExiting.has(key)) {
      // An exit is already running here. A protective rule does not wait
      // behind an AI question about it.
      withdrawForProtective(c, mint, rule);
      continue;
    }
    // Same for an exit the leader's own sell queued, which holds the chain.
    withdrawForProtective(c, mint, rule);
    const symbol = rows[0].symbol;
    // The clock pass has no tick of its own: it carries the last mark, or 0
    // (unknown), and the exit is priced the way any exit is — paper at the
    // spot the host reports, live from our own fill.
    const px = priceSol ?? rows[0].exitPriceSol ?? 0;
    const synthetic: WalletTrade = { chain: chainOf(c), wallet: c.wallet, mint, symbol, isBuy: false, sol: 0, priceSol: px, at: now, tradeAt: now, soldFraction: 1, note: why };
    host?.log('info', `${tag} ${c.label || c.wallet.slice(0, 6)}: ${symbol || mint.slice(0, 8)} — ${why}`);
    runOwnExit(key, c, synthetic, rule);
  }
}

// ── Event exits (2026-10-28) ──────────────────────────────────────────
//
// Three more reasons to leave that competitors ship and the feeds already
// decode: the coin's creator selling (the curve names the creator on every
// trade), the coin graduating to PumpSwap, and the leader leaving a coin
// without a SOL sale (a transfer to another wallet, a stablecoin sale, a
// token-for-token route — walletSwap.classifyUnseenExit). Each is the
// ordinary queued exit with a note, so paper and live book it the same way,
// and the migration wait, the fraction recovery and the one-exit-at-a-time
// chain all apply unchanged.

/** Does any follow hold this coin? Asked on the firehose, so it is one scan
 *  of the open rows and nothing else. */
export function holdsMint(mint: string, chain: ChainKind = 'solana'): boolean {
  return trades.some((r) => r.state === 'open' && r.kind !== 'exit' && r.mint === mint && (r.chain ?? 'solana') === chain);
}

/** Raise one full exit on every config holding `mint` that `wants` it.
 *  Not gated on `enabled`, like the own exits: a paused follow still holds
 *  what it bought, and the rule is protection the user believes they have. */
function eventExit(mint: string, chain: ChainKind, now: number, wants: (c: CopyConfig) => boolean, why: string, rule: ExitRule): number {
  let fired = 0;
  for (const c of configs) {
    if (chainOf(c) !== chain || !wants(c)) continue;
    const key = flightKey(c.id, mint);
    if (aiQuieted(c.id, mint, rule, now)) continue;
    const rows = trades.filter((r) => r.configId === c.id && r.mint === mint && r.state === 'open' && r.kind !== 'exit');
    if (!rows.length) continue;
    const symbol = rows[0].symbol;
    // Priced the way any synthetic exit is: paper at the spot the host
    // reports, live from our own fill. The last mark is only a label.
    const px = rows[0].exitPriceSol ?? 0;
    const synthetic: WalletTrade = { chain, wallet: c.wallet, mint, symbol, isBuy: false, sol: 0, priceSol: px, at: now, tradeAt: now, soldFraction: 1, note: why };
    host?.log('info', `${directionOf(c)} ${c.label || c.wallet.slice(0, 6)}: ${symbol || mint.slice(0, 8)} — ${why}`);
    withdrawForProtective(c, mint, rule);
    if (ownExiting.has(key)) {
      // One-time events: run it when the exit in flight finishes, not never.
      deferredExits.set(key, { c, t: synthetic, rule });
    } else {
      runOwnExit(key, c, synthetic, rule);
    }
    fired += 1;
  }
  return fired;
}

/** Creator sells already acted on, by signature: the curve rail can carry
 *  one trade twice (two providers, a recovered gap). */
const creatorSellsSeen = new Set<string>();

/**
 * The coin's creator sold (2026-10-28). `tokens` is what the sell moved, UI
 * units; their holding after it is read to size the share — holding after
 * plus tokens sold is what they held before, the same recovery a leader's
 * unreadable sell uses. An UNREADABLE share fires every config's rule: a
 * creator dump is the one sell this rule exists for, and "could not read
 * it" must not become "so it was small".
 */
export async function noteCreatorSell(ev: { mint: string; creator: string; tokens: number; at?: number; slot?: number | null; signature?: string; chain?: ChainKind }): Promise<void> {
  const h = host;
  if (!h) return;
  const chain = ev.chain ?? 'solana';
  const now = ev.at ?? Date.now();
  const wanting = configs.filter((c) => chainOf(c) === chain && typeof c.exitOnCreatorSellPct === 'number' && Number.isFinite(c.exitOnCreatorSellPct));
  if (!wanting.length || !holdsMint(ev.mint, chain)) return;
  if (ev.signature) {
    if (creatorSellsSeen.has(ev.signature)) return;
    creatorSellsSeen.add(ev.signature);
    if (creatorSellsSeen.size > HANDLED_CAP) {
      const oldest = creatorSellsSeen.values().next().value;
      if (oldest !== undefined) creatorSellsSeen.delete(oldest);
    }
  }
  let share: number | null = null;
  if (h.leaderHolding && ev.tokens > 0) {
    try {
      const after = await h.leaderHolding(ev.creator, ev.mint, chain, ev.slot ? { minContextSlot: ev.slot } : undefined);
      if (after !== null && Number.isFinite(after) && after >= 0) share = Math.min(100, (ev.tokens / (after + ev.tokens)) * 100);
    } catch {
      share = null;
    }
  }
  const said = share === null ? 'an unreadable share' : `${Math.round(share)}%`;
  const fired = eventExit(ev.mint, chain, now, (c) => typeof c.exitOnCreatorSellPct === 'number' && (share === null || share >= c.exitOnCreatorSellPct), `the creator sold ${said} of their bag — dev-sell exit`, 'creatorSell');
  if (!fired && share !== null) h.log('info', `copy: the creator of ${ev.mint.slice(0, 8)}… sold ${said} of their bag — under every dev-sell rule holding it`);
}

/** The coin graduated from pump's curve to PumpSwap (2026-10-28). A live
 *  sell raised here meets the migration wait and is retried until the pool
 *  is live; paper closes at the spot. */
export function noteMigration(mint: string, chain: ChainKind = 'solana', now = Date.now()): void {
  if (!host) return;
  eventExit(mint, chain, now, (c) => c.exitOnMigration === true, 'graduated to PumpSwap — migration exit', 'migration');
}

const OTHER_EXIT_TEXT: Record<string, string> = {
  stableSell: 'sold it for a stablecoin',
  tokenForToken: 'swapped it for another token',
  transferOut: 'sent it to another wallet',
};

/**
 * The leader LEFT a coin without a SOL sale (2026-10-28), from the wallet
 * watcher. A watch-only follow is told. A copy follow with "follow them out
 * another way" on mirrors it like a sell whose size the transaction could
 * not say: `tokens` is what left, and their balance after it sizes the
 * share (recoverFraction). Unreadable stays unreadable — the row says so
 * and the position is still held, never guessed at.
 */
export function onLeaderOtherExit(ev: { chain?: ChainKind; wallet: string; mint: string; symbol?: string; kind: string; tokens: number; signature?: string; at: number; tradeAt?: number | null; slot?: number | null }): void {
  const h = host;
  if (!h) return;
  const chain = ev.chain ?? 'solana';
  const wallet = chain === 'solana' ? ev.wallet : ev.wallet.toLowerCase();
  const mint = chain === 'solana' ? ev.mint : ev.mint.toLowerCase();
  const how = OTHER_EXIT_TEXT[ev.kind] ?? 'left it another way';
  const what = ev.symbol || mint.slice(0, 8);
  const matching = configs.filter((c) => !isFomo(c) && chainOf(c) === chain && c.wallet === wallet && managesExits(c));
  for (const c of matching) {
    if (isWatch(c)) {
      if (c.enabled) watchAlert(c, `Moved out: they ${how} (${what})`);
      continue;
    }
    if (directionOf(c) !== 'copy' || !c.copySells || !c.copyOtherExits) continue;
    const holds = trades.some((r) => r.configId === c.id && r.mint === mint && r.state === 'open' && r.kind !== 'exit') || buysInFlight.has(flightKey(c.id, mint));
    if (!holds) continue;
    const t: WalletTrade = {
      chain,
      wallet,
      mint,
      symbol: ev.symbol ?? '',
      isBuy: false,
      sol: 0,
      priceSol: 0,
      at: ev.at,
      tradeAt: ev.tradeAt ?? null,
      signature: ev.signature,
      tokens: ev.tokens,
      soldFraction: null,
      slot: ev.slot ?? null,
      note: `they ${how} — followed them out`,
    };
    h.log('info', `copy ${c.label || c.wallet.slice(0, 6)}: ${what} — they ${how}, following them out`);
    void queueExit(c, t, 'otherExit');
  }
}

// ── FOMO: the crowd ───────────────────────────────────────────────────
//
// A FOMO config follows a SET of wallets (shared/copytrade.ts FomoSource)
// and enters when `minWallets` distinct members buy the same coin inside
// `windowSec`. The set is resolved through the host every 30 s — the Scout's
// saved and top lists move — and the buys arrive from two places: the
// followed wallets' own subscriptions (through onWalletTrade) and the pump
// curve firehose for everyone else (the engine asks `crowdWants` first, so a
// trade by a wallet no config watches costs a set lookup and nothing more).
// The entry is a synthetic buy whose `triggeredBy` names the crowd; the
// crowd's own exits then count: once `crowdExitPct` of those wallets have
// sold, the position follows them out. Own exits above cover the rest.
//
// Measured, convergence made a follower's outcome WORSE with every extra
// wallet (docs/wallet-convergence-2026-09-14.md). The form says so.

interface CrowdBuy {
  /** As the chain spells it — the set is lower-cased, the record is not. */
  wallet: string;
  at: number;
  sol: number;
  priceSol: number;
  symbol: string;
}
/** `${configId}:${mint}` → wallet → its latest buy inside the window. */
const crowd = new Map<string, Map<string, CrowdBuy>>();
/** `${configId}:${mint}` → when the crowd last fired an entry. */
const crowdFired = new Map<string, number>();
/** row id → the trigger wallets that have sold since. */
const crowdSold = new Map<string, Set<string>>();
const CROWD_KEYS_CAP = 5_000;
const SOURCE_CACHE_MS = 30_000;
const sourceCache = new Map<string, { at: number; set: Set<string> }>();
let crowdUnion: { at: number; chain: ChainKind; set: Set<string> } | null = null;

function crowdSourceSet(c: CopyConfig, now: number): Set<string> {
  const hit = sourceCache.get(c.id);
  if (hit && now - hit.at < SOURCE_CACHE_MS) return hit.set;
  const f = fomoRuleOf(c);
  const chain = chainOf(c);
  let list: string[] = [];
  if (f.source === 'followed') list = [...activeWallets(chain)];
  else if (f.source === 'saved') list = host?.scoutSaved?.(chain) ?? [];
  else if (f.source === 'tracked') list = host?.trackedWallets?.(chain) ?? [];
  // Picked wallets (2026-10-28) are the crowd themselves; the top list is
  // ranked by the sort the config names — Week total, least bad, score.
  else if (f.source === 'list') list = f.wallets;
  else list = host?.scoutTop?.(chain, f.topN, f.topSort) ?? [];
  // Lower-cased: the Scout keys its saved list that way (2026-09-11).
  const set = new Set(list.filter((w) => typeof w === 'string' && w).map((w) => w.toLowerCase()));
  sourceCache.set(c.id, { at: now, set });
  return set;
}

/** Is any enabled FOMO config on `chain` listening for `wallet`? Cheap: the
 *  engine asks this for every trade on the firehose. */
export function crowdWants(chain: ChainKind, wallet: string, now = Date.now()): boolean {
  if (!crowdUnion || crowdUnion.chain !== chain || now - crowdUnion.at >= SOURCE_CACHE_MS) {
    const set = new Set<string>();
    for (const c of configs) {
      // A paused FOMO config holding a position still hears its crowd sell.
      if (!isFomo(c) || chainOf(c) !== chain || !managesExits(c)) continue;
      for (const w of crowdSourceSet(c, now)) set.add(w);
    }
    crowdUnion = { at: now, chain, set };
  }
  return crowdUnion.set.has(wallet.toLowerCase());
}

/** A source may have changed (a config saved, a wallet saved on the Scout). */
export function forgetCrowdSources(): void {
  sourceCache.clear();
  crowdUnion = null;
}

function boundCrowd(): void {
  while (crowd.size > CROWD_KEYS_CAP) {
    const oldest = crowd.keys().next().value;
    if (oldest === undefined) break;
    crowd.delete(oldest);
  }
  while (crowdFired.size > CROWD_KEYS_CAP) {
    const oldest = crowdFired.keys().next().value;
    if (oldest === undefined) break;
    crowdFired.delete(oldest);
  }
}

/**
 * One trade by a wallet that may be in a crowd. Buys accumulate per config
 * and mint inside the window and fire an entry at `minWallets`; sells by
 * trigger wallets count toward the crowd exit.
 */
export function noteCrowdTrade(t: WalletTrade): void {
  const h = host;
  if (!h) return;
  const chain = t.chain ?? 'solana';
  const now = t.at;
  for (const c of configs) {
    if (!isFomo(c) || chainOf(c) !== chain || !managesExits(c)) continue;
    if (!crowdSourceSet(c, now).has(t.wallet.toLowerCase())) continue;
    const f = fomoRuleOf(c);
    const key = flightKey(c.id, t.mint);
    if (!t.isBuy) {
      noteCrowdSell(c, t, f, key);
      continue;
    }
    if (!c.enabled) continue; // paused: exits only
    let m = crowd.get(key);
    if (!m) {
      m = new Map();
      crowd.set(key, m);
      boundCrowd();
    }
    m.set(t.wallet.toLowerCase(), { wallet: t.wallet, at: now, sol: t.sol, priceSol: t.priceSol, symbol: t.symbol });
    const since = now - f.windowSec * 1_000;
    for (const [w, b] of m) if (b.at < since) m.delete(w);
    if (m.size < f.minWallets) continue;
    // Once per window, and never on top of a position still open.
    if (now - (crowdFired.get(key) ?? 0) < f.windowSec * 1_000) continue;
    if (trades.some((x) => x.configId === c.id && x.mint === t.mint && x.state === 'open' && x.kind !== 'exit')) continue;
    crowdFired.set(key, now);
    const wallets = [...m.values()].map((b) => b.wallet);
    const avgSol = [...m.values()].reduce((a, b) => a + b.sol, 0) / m.size;
    const what = t.symbol || t.mint.slice(0, 8);
    const synthetic: WalletTrade = {
      chain,
      wallet: FOMO_WALLET,
      mint: t.mint,
      symbol: t.symbol,
      isBuy: true,
      sol: avgSol,
      priceSol: t.priceSol,
      at: now,
      tradeAt: t.tradeAt ?? now,
    };
    h.log('info', `fomo ${c.label || 'crowd'}: ${wallets.length} of ${FOMO_SOURCE_LABEL[f.source].toLowerCase()} bought ${what} within ${f.windowSec} s — entering`);
    void evaluateBuy(c, synthetic, { triggeredBy: wallets });
  }
}

function noteCrowdSell(c: CopyConfig, t: WalletTrade, f: ReturnType<typeof fomoRuleOf>, key: string): void {
  const rows = trades.filter((x) => x.configId === c.id && x.mint === t.mint && x.state === 'open' && x.kind !== 'exit' && Array.isArray(x.triggeredBy) && x.triggeredBy.some((w) => w.toLowerCase() === t.wallet.toLowerCase()));
  if (!rows.length) return;
  let fire: string | null = null;
  for (const r of rows) {
    let sold = crowdSold.get(r.id);
    if (!sold) {
      sold = new Set();
      crowdSold.set(r.id, sold);
    }
    sold.add(t.wallet.toLowerCase());
    const n = (r.triggeredBy as string[]).length;
    if (n > 0 && (sold.size / n) * 100 >= f.crowdExitPct) fire = `the crowd left — ${sold.size} of ${n} sold (fomo)`;
  }
  if (!fire || ownExiting.has(key)) return;
  const synthetic: WalletTrade = { chain: chainOf(c), wallet: c.wallet, mint: t.mint, symbol: t.symbol || rows[0].symbol, isBuy: false, sol: 0, priceSol: t.priceSol, at: t.at, tradeAt: t.tradeAt ?? t.at, soldFraction: 1, note: fire };
  host?.log('info', `fomo ${c.label || 'crowd'}: ${t.symbol || t.mint.slice(0, 8)} — ${fire}`);
  runOwnExit(key, c, synthetic, 'crowd');
}

/** Test seam. */
export function _reset(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  closing = false;
  timings.length = 0;
  aiQuiet.clear();
  aiAsking.clear();
  deferredExits.clear();
  quantityReads.clear();
  crowd.clear();
  crowdFired.clear();
  crowdSold.clear();
  sourceCache.clear();
  crowdUnion = null;
  ownExiting.clear();
  failStreak.clear();
  migrationWaits.clear();
  dailyStopNoted.clear();
  notifiedAt.length = 0;
  configs = [];
  trades = [];
  leaders = {};
  filePath = '';
  loadFailure = null;
  handled.clear();
  handledSells.clear();
  mirroredSells.clear();
  supersededSkips.clear();
  bootAt = 0;
  bookVersion += 1;
  pendingCopies.clear();
  buysInFlight.clear();
  pendingExits.clear();
  staleBuys.clear();
  restoredExits.clear();
  holdingCache.clear();
  recentCopies.clear();
  exitChains.clear();
  flaggedLeftovers.clear();
  skewRing.length = 0;
  lastSwept.clear();
  backfillTried.clear();
}

export function _load(c: CopyConfig[], t: CopyTrade[], l: Record<string, LeaderBook> = {}): void {
  configs = c;
  trades = t;
  leaders = l;
  bookVersion += 1;
}

/** Test seam: pretend this session booted at `at`, as `init` does. */
export function _setBootAt(at: number): void {
  bootAt = at;
  bookVersion += 1;
}

/** Test seam: the raw book, as persisted. */
export function _leaders(): Record<string, LeaderBook> {
  return leaders;
}
