// What stops live trading, and what comes back by itself (2026-11-04).
//
// Asked for because a few failed trades switched a bot off with nobody there:
// three failures paused a follow until someone switched it back on. A failed
// send says the route, the RPC or the coin is having a bad minute, and waiting
// is the right answer to that. A loss limit says something else, so those stay
// off unless the user asks otherwise.
//
// Pure, so each rule is pinned by test/rearm.test.mjs. Exits are never part of
// this: nothing here stops or delays a sell.
//
// Follows and the Live switch only. Krypto Mirror runs no scripts and has no
// page for Krypto Trader sessions, and its autonomous buy path is permanently
// off, so none of those come back: a session or script restarted here would
// spend with nothing on screen to see or stop it.

export interface RearmSettings {
  /** Copies that failed in a row. */
  failedTrades: boolean;
  /** The live session loss limit and the live losing streak. Each comeback
   *  starts the count again, so this one is off unless asked for. */
  lossLimits: boolean;
  /** A follow's own loss stop. Off unless asked for, for the same reason. */
  followStops: boolean;
  /** Live follows switched off by the app restarting.
   *  Off unless asked for: an app closed for a week wakes up spending. */
  restart: boolean;
  /** Slippage failures count toward that pause. Off unless asked for (owner,
   *  2026-11-05): a fast coin moving past your slippage is not a broken route. */
  slippagePauses: boolean;
  /** Failures in a row before anything pauses. */
  failsInARow: number;
  /** The first wait, in minutes. It doubles each time, up to an hour. */
  firstWaitMin: number;
  /** Comebacks in a row before it stays off. 0 = never stop trying. A trade
   *  that lands starts this count again. */
  maxInARow: number;
}

export const DEFAULT_REARM: RearmSettings = {
  failedTrades: true,
  lossLimits: false,
  followStops: false,
  restart: false,
  slippagePauses: false,
  failsInARow: 3,
  firstWaitMin: 5,
  // Owner, 2026-11-04: a bot left for days must not give up on its own, and every
  // limit starts off. A broken route settles at one short try an hour.
  maxInARow: 0,
};

export const REARM_LIMITS = {
  failsInARow: { min: 1, max: 50 },
  firstWaitMin: { min: 1, max: 60 },
  maxInARow: { min: 0, max: 1000 },
} as const;

export const REARM_MAX_WAIT_MIN = 60;

/** What stopped it. A loss waits at least the full hour, every time. */
export type RearmCause = 'fails' | 'loss' | 'stop';

function intIn(v: unknown, lim: { min: number; max: number }, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= lim.min && v <= lim.max ? v : fallback;
}

/** The settings as stored, whatever an older save holds. Anything unreadable
 *  reads as the default, and a switch counts as on only when it is exactly true
 *  or, for the one that defaults on, when it is absent. */
export function readRearm(raw: unknown): RearmSettings {
  const r = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof RearmSettings, unknown>>) : {};
  return {
    failedTrades: r.failedTrades !== false,
    lossLimits: r.lossLimits === true,
    followStops: r.followStops === true,
    restart: r.restart === true,
    slippagePauses: r.slippagePauses === true,
    failsInARow: intIn(r.failsInARow, REARM_LIMITS.failsInARow, DEFAULT_REARM.failsInARow),
    firstWaitMin: intIn(r.firstWaitMin, REARM_LIMITS.firstWaitMin, DEFAULT_REARM.firstWaitMin),
    maxInARow: intIn(r.maxInARow, REARM_LIMITS.maxInARow, DEFAULT_REARM.maxInARow),
  };
}

export interface RearmPlan {
  /** When it comes back on. */
  at: number;
  /** The count to keep, including this comeback. */
  tries: number;
}

/** When this comes back on, or null if it stays off: its switch is off, or it
 *  has already come back `maxInARow` times with nothing landing. */
export function nextRearm(s: RearmSettings, cause: RearmCause, tries: number, now: number): RearmPlan | null {
  const on = cause === 'fails' ? s.failedTrades : cause === 'loss' ? s.lossLimits : s.followStops;
  if (!on) return null;
  const used = Number.isFinite(tries) && tries > 0 ? Math.floor(tries) : 0;
  if (s.maxInARow > 0 && used >= s.maxInARow) return null;
  const first = cause === 'loss' || cause === 'stop' ? REARM_MAX_WAIT_MIN : s.firstWaitMin;
  const minutes = Math.min(REARM_MAX_WAIT_MIN, first * 2 ** Math.min(used, 10));
  return { at: now + minutes * 60_000, tries: used + 1 };
}

/** A time of day, as the alerts and cards say it. */
export function rearmClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Something waiting to come back on, for the Settings list. */
export interface RearmPending {
  kind: 'live' | 'follow';
  id: string;
  name: string;
  at: number;
  why: string;
}

/** Which changes make the app come back on more readily, in words. These resume
 *  spending with nobody there, so with a wallet password on they ask for it,
 *  like raising a cap does. Turning one off, or waiting longer, never asks. */
export function rearmLoosened(beforeRaw: unknown, nextRaw: unknown): string[] {
  if (nextRaw === undefined || nextRaw === null) return [];
  const b = readRearm(beforeRaw);
  const n = readRearm(nextRaw);
  const out: string[] = [];
  if (n.lossLimits && !b.lossLimits) out.push('live trading coming back on after a loss limit');
  if (n.followStops && !b.followStops) out.push('follows coming back on after their loss stop');
  if (n.restart && !b.restart) out.push('live trading coming back on after a restart');
  if (n.failedTrades && !b.failedTrades) out.push('live trading coming back on after failed trades');
  if (b.slippagePauses && !n.slippagePauses) out.push('slippage failures no longer pausing a follow');
  if (n.failsInARow > b.failsInARow) out.push(`failed trades allowed in a row, from ${b.failsInARow} to ${n.failsInARow}`);
  if (n.firstWaitMin < b.firstWaitMin) out.push(`the wait before coming back on, from ${b.firstWaitMin} to ${n.firstWaitMin} minutes`);
  if (n.maxInARow === 0 ? b.maxInARow !== 0 : b.maxInARow !== 0 && n.maxInARow > b.maxInARow) {
    out.push(n.maxInARow === 0 ? 'comebacks in a row, to no limit' : `comebacks in a row, from ${b.maxInARow} to ${n.maxInARow}`);
  }
  return out;
}
