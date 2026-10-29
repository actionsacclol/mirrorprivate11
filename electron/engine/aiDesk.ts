// The AI desk's broker (2026-10-28): the event feed an AI client long-polls,
// the decisions waiting for its verdict, and the log the AI page shows.
// shared/aiDesk.ts holds the rules; this holds the state.
//
// The copy engine never waits on a client directly. It calls `ask`, which
// answers at once when nobody is there to answer (not connected, not allowed)
// and otherwise resolves on the AI's `decide` or on the deadline — so a follow
// with the gate on costs nothing extra while no AI is running, and at most
// its wait while one is.

import {
  AI_EVENTS_KEPT,
  AI_ONLINE_MS,
  AI_POLL_MAX_SEC,
  accessDecides,
  checkVerdict,
  type AiAnswer,
  type AiDecisionLog,
  type AiDeskStatus,
  type AiEvent,
  type AiEventKind,
  type AiRequest,
  type AiVerdict,
} from '@shared/aiDesk';
import type { McpAccess } from '@shared/mcp';

export interface AiDeskHost {
  access(): McpAccess;
  /** Follows with the gate on, for the status. */
  gated(): AiDeskStatus['gated'];
  /** Something changed the AI page should show. */
  changed?(): void;
  log?(level: 'info' | 'warn', line: string): void;
}

const LOG_KEPT = 200;

let host: AiDeskHost | null = null;
let events: AiEvent[] = [];
let seq = 0;
let lastPollAt: number | null = null;
let listening = 0;
const waiters = new Set<() => void>();
interface Pending {
  req: AiRequest;
  done: (a: AiAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();
let log: AiDecisionLog[] = [];
let nextId = 0;
const totals = { asked: 0, answered: 0, timedOut: 0 };

export function attach(h: AiDeskHost): void {
  host = h;
}

export function online(now = Date.now()): boolean {
  return listening > 0 || (lastPollAt !== null && now - lastPollAt < AI_ONLINE_MS);
}

/** Add an event to the feed and wake every poll. */
export function note(kind: AiEventKind, text: string, data: Record<string, unknown> = {}, at = Date.now()): AiEvent {
  const ev: AiEvent = { seq: ++seq, at, kind, text, data };
  events.push(ev);
  if (events.length > AI_EVENTS_KEPT) events = events.slice(-AI_EVENTS_KEPT);
  for (const w of [...waiters]) w();
  return ev;
}

/**
 * Events after `cursor`, waiting up to `waitMs` for the first one.
 *
 * `missed` counts events that fell off the feed before this reader came back
 * for them — said, not hidden. Pending decisions ride along on every answer,
 * so a reader that lost its cursor still sees what is waiting on it.
 */
export async function poll(
  cursor: number | null,
  waitMs: number,
  kinds: AiEventKind[] | null = null,
): Promise<{ cursor: number; events: AiEvent[]; missed: number; pending: AiRequest[]; restarted: boolean }> {
  const wait = Math.max(0, Math.min(waitMs, AI_POLL_MAX_SEC * 1_000));
  // A cursor past the newest event is from before the app restarted (the
  // count starts again at 0). Read from the start of this run, and say so:
  // kept as-is, every event — decisions included — would sit below it until
  // the count caught up, and every decision would time out meanwhile.
  const restarted = cursor !== null && cursor > seq;
  const from = restarted ? 0 : (cursor ?? seq);
  // A decision is never filtered out by `kinds`: it is waiting on the reader.
  const pick = (): AiEvent[] => events.filter((e) => e.seq > from && (!kinds || kinds.includes(e.kind) || e.kind === 'decision'));
  listening += 1;
  lastPollAt = Date.now();
  host?.changed?.();
  try {
    let got = pick();
    if (!got.length && wait > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, wait);
        function done(): void {
          clearTimeout(t);
          waiters.delete(wake);
          resolve();
        }
        function wake(): void {
          if (pick().length) done();
        }
        waiters.add(wake);
      });
      got = pick();
    }
    const oldest = events.length ? events[0].seq : seq + 1;
    const missed = !restarted && cursor !== null && cursor + 1 < oldest ? oldest - cursor - 1 : 0;
    return { cursor: got.length ? got[got.length - 1].seq : restarted ? seq : Math.max(from, cursor ?? 0), events: got, missed, pending: pendingList(), restarted };
  } finally {
    listening -= 1;
    lastPollAt = Date.now();
    host?.changed?.();
  }
}

export function pendingList(): AiRequest[] {
  return [...pending.values()].map((p) => p.req).sort((a, b) => a.deadline - b.deadline);
}

function asked(req: AiRequest): string {
  if (req.kind === 'entry') {
    return `buy ${req.sizeSol} — they ${req.leaderSide === 'buy' ? 'bought' : 'sold'} ${round(req.leaderSol)}`;
  }
  const move = req.movePct === null ? '' : `, ${req.movePct >= 0 ? '+' : ''}${req.movePct.toFixed(1)}%`;
  return `sell ${req.sellPct === null ? 'their share' : `${Math.round(req.sellPct)}%`} — ${req.why}${move}`;
}

const round = (n: number): string => (n >= 1 ? n.toFixed(2) : n.toPrecision(2));

function remember(entry: AiDecisionLog): void {
  log.unshift(entry);
  if (log.length > LOG_KEPT) log = log.slice(0, LOG_KEPT);
  host?.changed?.();
}

/** A request id the next `ask` will use. */
export function newId(): string {
  nextId += 1;
  return `ai_${nextId}`;
}

/**
 * Ask the AI. Resolves with its verdict, or with why there is none — at once
 * when no AI is connected or allowed to decide in this mode, otherwise on the
 * deadline. Never rejects.
 */
export function ask(req: AiRequest, now = Date.now()): Promise<AiAnswer> {
  const access = host?.access() ?? 'off';
  const base: Omit<AiDecisionLog, 'outcome' | 'verdict' | 'result' | 'ms'> = {
    id: req.id,
    kind: req.kind,
    follow: req.follow,
    mode: req.mode,
    symbol: req.symbol,
    mint: req.mint,
    askedAt: now,
    asked: asked(req),
  };
  if (!accessDecides(access, req.mode)) {
    const why =
      access === 'off' || access === 'read'
        ? `the AI connection is ${access === 'off' ? 'off' : 'read only'}`
        : 'the AI connection is on paper and this follow is live';
    remember({ ...base, outcome: 'not allowed', verdict: null, result: '', ms: 0 });
    return Promise.resolve({ by: 'none', why, ms: 0 });
  }
  if (!online(now)) {
    remember({ ...base, outcome: 'offline', verdict: null, result: '', ms: 0 });
    return Promise.resolve({ by: 'none', why: 'no AI is connected', ms: 0 });
  }
  totals.asked += 1;
  return new Promise<AiAnswer>((resolve) => {
    const waitMs = Math.max(0, req.deadline - now);
    const timer = setTimeout(() => {
      if (!pending.delete(req.id)) return;
      totals.timedOut += 1;
      remember({ ...base, outcome: 'timeout', verdict: null, result: '', ms: waitMs });
      note('decided', `${req.symbol || req.mint.slice(0, 6)}: no answer in ${Math.round(waitMs / 1000)} s — the follow's own rule applies`, { id: req.id, outcome: 'timeout' });
      resolve({ by: 'none', why: `the AI did not answer in ${Math.round(waitMs / 1000)} s`, ms: waitMs });
    }, waitMs);
    pending.set(req.id, {
      req,
      timer,
      done: (a) => {
        clearTimeout(timer);
        pending.delete(req.id);
        resolve(a);
      },
    });
    const who = req.kind === 'entry' ? `${req.follow}: ${asked(req)}` : `${req.follow}: ${asked(req)}`;
    note('decision', `Decide by ${new Date(req.deadline).toISOString().slice(11, 19)} UTC — ${req.symbol || req.mint.slice(0, 6)} ${req.kind}: ${who}`, { request: req });
    host?.changed?.();
  });
}

/** The AI's verdict on a pending request. */
export function decide(id: string, raw: unknown, now = Date.now()): { ok: boolean; message: string } {
  const p = pending.get(id);
  if (!p) {
    const past = log.find((l) => l.id === id);
    return { ok: false, message: past ? `Decision ${id} is closed (${past.outcome}) — too late to change it.` : `No pending decision ${id}. Call wait_for_events or get_pending_decisions for the open ones.` };
  }
  const access = host?.access() ?? 'off';
  if (!accessDecides(access, p.req.mode)) return { ok: false, message: `This connection may not decide ${p.req.mode} trades.` };
  const v = checkVerdict(p.req, raw);
  if (!v.ok) return { ok: false, message: v.message };
  const ms = Math.max(0, now - p.req.askedAt);
  totals.answered += 1;
  p.done({ by: 'ai', verdict: v.verdict, ms });
  note('decided', `${p.req.symbol || p.req.mint.slice(0, 6)}: ${v.verdict.verdict}${v.verdict.sizeSol ? ` ${v.verdict.sizeSol}` : ''}${v.verdict.percent ? ` ${v.verdict.percent}%` : ''} — ${v.verdict.reason}`, { id, verdict: v.verdict });
  return { ok: true, message: `Recorded: ${v.verdict.verdict}. The app acts on it now.` };
}

/** What the app did with an answer, for the log the page shows. Called by
 *  the copy engine once it has acted. */
export function settled(req: AiRequest, answer: AiAnswer, result: string): void {
  const entry: AiDecisionLog = {
    id: req.id,
    kind: req.kind,
    follow: req.follow,
    mode: req.mode,
    symbol: req.symbol,
    mint: req.mint,
    askedAt: req.askedAt,
    asked: asked(req),
    outcome: answer.by === 'ai' ? 'ai' : /did not answer/.test(answer.why) ? 'timeout' : /no AI/.test(answer.why) ? 'offline' : /connection/.test(answer.why) ? 'not allowed' : 'cancelled',
    verdict: answer.by === 'ai' ? answer.verdict : null,
    result,
    ms: answer.ms,
  };
  // The early outcomes (offline, not allowed, timeout) were logged without a
  // result; this fills theirs in rather than adding a second line.
  const i = log.findIndex((l) => l.id === req.id);
  if (i >= 0) log[i] = { ...log[i], ...entry, outcome: log[i].outcome === 'ai' ? entry.outcome : log[i].outcome };
  else remember(entry);
  host?.changed?.();
}

/** Drop a pending request whose trade went away (the follow was removed,
 *  paused or switched mode, a stop-loss fired). Its asker gets `cancelled`. */
export function cancel(id: string, why: string): void {
  const p = pending.get(id);
  if (!p) return;
  p.done({ by: 'none', why: `cancelled — ${why}`, ms: Math.max(0, Date.now() - p.req.askedAt) });
  remember({
    id: p.req.id,
    kind: p.req.kind,
    follow: p.req.follow,
    mode: p.req.mode,
    symbol: p.req.symbol,
    mint: p.req.mint,
    askedAt: p.req.askedAt,
    asked: asked(p.req),
    outcome: 'cancelled',
    verdict: null,
    result: '',
    ms: Math.max(0, Date.now() - p.req.askedAt),
  });
  note('decided', `${p.req.symbol || p.req.mint.slice(0, 6)}: decision ${id} withdrawn — ${why}`, { id, outcome: 'cancelled' });
}

export function status(now = Date.now()): AiDeskStatus {
  return {
    online: online(now),
    listening,
    lastPollAt,
    pending: pendingList(),
    log: log.slice(0, 100),
    asked: totals.asked,
    answered: totals.answered,
    timedOut: totals.timedOut,
    gated: host?.gated() ?? [],
    seq,
  };
}

/** The verdict as the trade row records it. */
export function verdictText(v: AiVerdict): string {
  return `${v.verdict}${v.sizeSol !== undefined ? ` ${v.sizeSol}` : ''}${v.percent !== undefined ? ` ${v.percent}%` : ''} — ${v.reason}`;
}

export function _reset(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  events = [];
  seq = 0;
  lastPollAt = null;
  listening = 0;
  waiters.clear();
  log = [];
  nextId = 0;
  totals.asked = totals.answered = totals.timedOut = 0;
}
