// The AI desk (2026-10-28): an AI client connected over MCP sees what the
// follows see — their leaders' trades, the copies, the Scout's scans — and,
// on a follow that asks for it, has the final say on each entry and exit.
//
// The shape of the arrangement, which the rest of this file enforces:
//
//   * The AI DECIDES, the app EXECUTES. A verdict can only narrow what the
//     follow would have done: skip a buy, buy smaller, hold instead of sell,
//     sell less. It cannot buy a coin the follow did not offer it, buy more
//     than the follow's size, or touch a setting. Its own trades go through
//     buy_token / sell_token, under the connection's budget, as before.
//   * Silence is an answer. An AI that is not connected, not allowed, or too
//     slow gets the follow's own fallback: an entry is skipped (or copied, if
//     the user chose that), an exit happens as the rule said.
//   * Protective exits do not wait. A stop-loss, trailing stop or creator
//     dump fires at once unless the user turned that off, because a model
//     that is thinking, or offline, is not a reason to ride a coin to zero.
//
// See docs/ai-desk-2026-10-28.md.

import type { McpAccess } from './mcp';

// ── The follow's setting ──────────────────────────────────────────────

/** What an entry does when the AI does not answer in time. */
export type AiTimeoutEntry = 'skip' | 'copy';

export interface AiGateConfig {
  /** Each copy entry waits for the AI's buy / skip. */
  entries: boolean;
  /** Each exit (their sell, your take-profit, max hold, graduation…) waits
   *  for the AI's sell / hold. */
  exits: boolean;
  /** How long to wait for an answer, seconds. */
  waitSec: number;
  /** An entry nobody answered: skip it (the AI has the final say) or copy it
   *  as if the AI were not there. Exits always go ahead as the rule said. */
  onTimeout: AiTimeoutEntry;
  /** Stop-loss, trailing stop and creator-sell exits wait for the AI too.
   *  Off by default: those exits fire at once. */
  protectiveWait: boolean;
}

export const AI_WAIT_MIN_SEC = 3;
export const AI_WAIT_MAX_SEC = 45;
export const DEFAULT_AI_WAIT_SEC = 15;

export const DEFAULT_AI_GATE: AiGateConfig = {
  entries: true,
  exits: false,
  waitSec: DEFAULT_AI_WAIT_SEC,
  onTimeout: 'skip',
  protectiveWait: false,
};

/** Is the gate on for anything? */
export const aiGateOn = (g: AiGateConfig | null | undefined): g is AiGateConfig => !!g && (g.entries || g.exits);

export function validateAiGate(g: unknown): { ok: true } | { ok: false; message: string } {
  if (g === null || g === undefined) return { ok: true };
  if (typeof g !== 'object') return { ok: false, message: 'Invalid AI setting' };
  const a = g as Partial<AiGateConfig>;
  if (typeof a.entries !== 'boolean' || typeof a.exits !== 'boolean') return { ok: false, message: 'Invalid AI setting' };
  if (typeof a.waitSec !== 'number' || !Number.isFinite(a.waitSec) || a.waitSec < AI_WAIT_MIN_SEC || a.waitSec > AI_WAIT_MAX_SEC) {
    return { ok: false, message: `The AI's answer time must be between ${AI_WAIT_MIN_SEC} and ${AI_WAIT_MAX_SEC} seconds` };
  }
  if (a.onTimeout !== 'skip' && a.onTimeout !== 'copy') return { ok: false, message: 'Pick what happens when the AI does not answer' };
  if (typeof a.protectiveWait !== 'boolean') return { ok: false, message: 'Invalid AI setting' };
  return { ok: true };
}

// ── Exits ─────────────────────────────────────────────────────────────

/** Why an exit is happening. `resume` is an exit already decided, being
 *  retried (a migration wait, a parked sell): never asked twice. */
export type ExitRule =
  | 'leader'
  | 'takeProfit'
  | 'stopLoss'
  | 'trailing'
  | 'maxHold'
  | 'creatorSell'
  | 'migration'
  | 'otherExit'
  | 'crowd'
  | 'resume';

/** Exits that protect the position: they fire without waiting unless the
 *  follow says otherwise. */
export const PROTECTIVE_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['stopLoss', 'trailing', 'creatorSell']);

export const EXIT_RULE_TEXT: Record<ExitRule, string> = {
  leader: 'they sold',
  takeProfit: 'your take-profit',
  stopLoss: 'your stop-loss',
  trailing: 'your trailing stop',
  maxHold: 'your max hold',
  creatorSell: 'the creator sold',
  migration: 'the coin graduated',
  otherExit: 'they moved the coin out',
  crowd: 'the crowd sold',
  resume: 'a queued exit',
};

/** Does this exit wait for the AI? */
export function exitAsks(g: AiGateConfig | null | undefined, rule: ExitRule): boolean {
  if (!aiGateOn(g) || !g.exits || rule === 'resume') return false;
  return !PROTECTIVE_RULES.has(rule) || g.protectiveWait;
}

/** After the AI says hold on a rule that re-fires on every tick (take-profit,
 *  max hold, trailing, graduation), that rule is not asked about again on the
 *  same coin for this long. Their sells are always asked: each is a new event. */
export const AI_HOLD_QUIET_MS = 10 * 60_000;

/** Rules a hold quiets. */
export const QUIETED_BY_HOLD: ReadonlySet<ExitRule> = new Set<ExitRule>(['takeProfit', 'maxHold', 'trailing', 'migration', 'stopLoss', 'creatorSell']);

// ── Requests and verdicts ─────────────────────────────────────────────

interface AiRequestBase {
  /** Unique, e.g. `ai_17`. */
  id: string;
  /** The follow's id and its name as the user sees it. */
  configId: string;
  follow: string;
  /** paper or live — the AI is told which world the decision is in. */
  mode: 'paper' | 'live';
  chain: string;
  /** The leader. */
  wallet: string;
  mint: string;
  symbol: string;
  /** When the app asked, and when it stops waiting. */
  askedAt: number;
  deadline: number;
}

export interface AiEntryRequest extends AiRequestBase {
  kind: 'entry';
  /** What the leader did: bought (copy, crowd) or sold (reverse). */
  leaderSide: 'buy' | 'sell';
  leaderSol: number;
  leaderPriceSol: number | null;
  /** When they traded, ms. */
  leaderAt: number;
  /** The follow's size for this copy — the most the AI may approve. */
  sizeSol: number;
  direction: string;
  /** What the filters read, null where unknown. */
  facts: { liquidityUsd: number | null; marketCapUsd: number | null; kryptScore: number | null; isPumpfun: boolean | null; ageSec: number | null };
  /** The crowd that triggered a convergence entry. */
  triggeredBy?: string[];
}

export interface AiExitRequest extends AiRequestBase {
  kind: 'exit';
  rule: ExitRule;
  /** The rule's own words, e.g. "take-profit +40% (copy)". */
  why: string;
  /** Share of the position the rule would sell, percent. Null = unknown
   *  (their sell's size could not be read; the app sizes it after). */
  sellPct: number | null;
  /** The open copy. */
  positionSol: number;
  entryPriceSol: number | null;
  priceSol: number | null;
  /** Unrealised, percent; null when either price is unknown. */
  movePct: number | null;
  heldSec: number;
}

export type AiRequest = AiEntryRequest | AiExitRequest;

export type AiVerdictWord = 'buy' | 'skip' | 'sell' | 'hold';

export interface AiVerdict {
  verdict: AiVerdictWord;
  /** Entry: a smaller size, at most the request's. */
  sizeSol?: number;
  /** Exit: sell this share instead, 1–100. */
  percent?: number;
  reason: string;
}

/** What the app does with a request: the AI's verdict, or why there is none. */
export type AiAnswer = { by: 'ai'; verdict: AiVerdict; ms: number } | { by: 'none'; why: string; ms: number };

export const AI_REASON_MAX = 300;

/** Check a verdict against its request. A verdict that does not fit is
 *  refused with the reason, and the request stays open for a better one. */
export function checkVerdict(req: AiRequest, raw: unknown): { ok: true; verdict: AiVerdict } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'A verdict is required' };
  const v = raw as Record<string, unknown>;
  const word = v.verdict;
  const reason = typeof v.reason === 'string' ? v.reason.trim().slice(0, AI_REASON_MAX) : '';
  if (!reason) return { ok: false, message: 'Give a short reason — it is shown to the user beside the decision' };
  if (req.kind === 'entry') {
    if (word !== 'buy' && word !== 'skip') return { ok: false, message: 'An entry takes "buy" or "skip"' };
    if (v.percent !== undefined) return { ok: false, message: 'percent is for exits; an entry takes sizeSol' };
    if (v.sizeSol !== undefined) {
      if (word !== 'buy') return { ok: false, message: 'sizeSol goes with "buy"' };
      const s = Number(v.sizeSol);
      if (!(s > 0)) return { ok: false, message: 'sizeSol must be more than zero' };
      if (s > req.sizeSol + 1e-12) return { ok: false, message: `sizeSol can only shrink the copy: at most ${req.sizeSol}` };
      return { ok: true, verdict: { verdict: 'buy', sizeSol: s, reason } };
    }
    return { ok: true, verdict: { verdict: word, reason } };
  }
  if (word !== 'sell' && word !== 'hold') return { ok: false, message: 'An exit takes "sell" or "hold"' };
  if (v.sizeSol !== undefined) return { ok: false, message: 'sizeSol is for entries; an exit takes percent' };
  if (v.percent !== undefined) {
    if (word !== 'sell') return { ok: false, message: 'percent goes with "sell"' };
    const p = Number(v.percent);
    if (!(p >= 1 && p <= 100)) return { ok: false, message: 'percent must be between 1 and 100' };
    return { ok: true, verdict: { verdict: 'sell', percent: p, reason } };
  }
  return { ok: true, verdict: { verdict: word, reason } };
}

/** May a connection at this level decide for a follow in this mode? Live
 *  follows need a live connection: approving a live buy is spending. */
export function accessDecides(access: McpAccess, mode: 'paper' | 'live'): boolean {
  if (mode === 'live') return access === 'live';
  return access === 'paper' || access === 'live';
}

// ── The event feed ────────────────────────────────────────────────────

export type AiEventKind = 'leader_trade' | 'copy' | 'decision' | 'decided' | 'scan';
export const AI_EVENT_KINDS: AiEventKind[] = ['leader_trade', 'copy', 'decision', 'decided', 'scan'];

export interface AiEvent {
  /** Increasing; pass the last one seen back as `cursor`. */
  seq: number;
  at: number;
  kind: AiEventKind;
  /** One line a person could read. */
  text: string;
  data: Record<string, unknown>;
}

/** The feed keeps this many; a slower reader is told it missed some. */
export const AI_EVENTS_KEPT = 2_000;
/** A poll waits at most this long for something to happen. */
export const AI_POLL_MAX_SEC = 50;
export const AI_POLL_DEFAULT_SEC = 25;
/** An AI that polled this recently is listening. Long enough to cover a
 *  model thinking between polls; short enough that a closed client stops
 *  holding up entries within two minutes. */
export const AI_ONLINE_MS = 120_000;

// ── The log the AI page shows ─────────────────────────────────────────

export interface AiDecisionLog {
  id: string;
  kind: 'entry' | 'exit';
  follow: string;
  mode: 'paper' | 'live';
  symbol: string;
  mint: string;
  askedAt: number;
  /** The question in a line, e.g. "buy 0.05 SOL — they bought 1.2 SOL". */
  asked: string;
  /** What happened. */
  outcome: 'ai' | 'timeout' | 'offline' | 'not allowed' | 'cancelled';
  verdict: AiVerdict | null;
  /** What the app did, in words. */
  result: string;
  ms: number;
}

export interface AiDeskStatus {
  /** An AI polled within AI_ONLINE_MS, or is polling now. */
  online: boolean;
  /** Polls in progress. */
  listening: number;
  lastPollAt: number | null;
  pending: AiRequest[];
  log: AiDecisionLog[];
  /** Totals since the app started. */
  asked: number;
  answered: number;
  timedOut: number;
  /** Follows with the gate on. */
  gated: Array<{ configId: string; follow: string; mode: 'paper' | 'live'; entries: boolean; exits: boolean }>;
  seq: number;
}

// ── Words ─────────────────────────────────────────────────────────────

/** One line for the follow's summary. */
export function aiGateLine(g: AiGateConfig | null | undefined): string | null {
  if (!aiGateOn(g)) return null;
  const what = g.entries && g.exits ? 'each buy and sell' : g.entries ? 'each buy' : 'each sell';
  const silent = g.entries ? (g.onTimeout === 'skip' ? 'no answer skips the buy' : 'no answer copies anyway') : 'no answer sells as the rule says';
  const prot = g.exits && !g.protectiveWait ? '; stop-loss, trailing and creator-sell exits do not wait' : '';
  return `Your AI decides ${what} within ${g.waitSec} s — ${silent}${prot}.`;
}

/** The prompt a user pastes into their AI client to start the desk. */
export function aiStarterPrompt(serverName: string): string {
  return [
    `You are my trade desk for Krypto Mirror, connected through the "${serverName}" MCP server.`,
    '',
    'Run this loop and keep it running until I tell you to stop:',
    '1. Call wait_for_events with the cursor from your last call (omit it the first time) and waitSec 25.',
    '2. For every event of kind "decision", decide before its deadline with decide_trade: "buy" or "skip" for an entry (you may buy smaller with sizeSol), "sell" or "hold" for an exit (you may sell less with percent). Give a one-line reason. Use get_token, get_wallet_record or get_chart first only if there is time — an unanswered decision falls back to the follow’s own rule.',
    '3. Note leader trades, copies and scans as they come; tell me briefly about anything unusual.',
    '4. Go back to step 1.',
    '',
    'Rules: check get_wallet once at the start and tell me whether decisions are paper or live. Never invent a number the tools did not give you. The app’s own research found copying wallets loses money on average — skipping is a fine answer.',
  ].join('\n');
}
