// The board labeler (2026-10-25) — the chain's word on the wallets the board
// ranks.
//
// The Scout's record only sees the trades its feed carried, so it over-ranks
// wallets whose coins survived: for one wallet-day it held 10 trips where
// the chain held 23, the extra 13 mostly coins that went to zero
// (docs/copy-candidates-2026-10-24.md). The record stays the candidate
// generator; the LABEL is the chain read back for each candidate — every
// finished trip in the window, a uniform random sample of them priced as
// copies (unbiased, where "the newest 30" is not), how much of the week the
// record had seen, and the four checks that say a record is not a trading
// record at all (shared/walletScout.ts, hard exclusions).
//
// Who gets labelled, and in what order: the top LABEL_RANKED_N of "Best to
// copy" (the board's picks and the wallets right under them), then a random
// LABEL_SAMPLE_SHARE of every other eligible wallet, so the baseline the
// picks are judged against is labelled without the shortlist's bias. A label
// younger than LABEL_FRESH_MS is not redone. Everything runs inside the
// backtest allowance — about 350 credits a wallet when the chain prices it —
// two wallets at a time, and stops when the allowance cannot cover another.
//
// The label never changes the ranking figure. It sits beside it, and the
// hard exclusions it carries hide a wallet from the suggestions.

import * as walletScout from './walletScout';
import * as copyReplay from './copyReplay';
import * as heliusBudget from '../system/heliusBudget';
import { recordedMedian, type CopyReplayStatus, type ReplayTrip } from '@shared/copyReplay';
import { DEFAULT_BACKTEST_CREDITS } from '@shared/credits';
import {
  SCOUT_PICKS_N,
  SCOUT_RANK_SORT,
  SCOUT_WINDOW_DAYS,
  applyScoutFilters,
  dayOf,
  rankScout,
  scoutFiltersAllOn,
  summarise,
  hardExclusions,
  type ChainLabel,
  type LabelStatus,
  type ScoutRow,
  type ScoutWallet,
} from '@shared/walletScout';

/** Ranked wallets labelled every run: the picks and the two decile-rows under them. */
export const LABEL_RANKED_N = 3 * SCOUT_PICKS_N;
/** Share of the other eligible wallets labelled each run, for an unbiased baseline. */
export const LABEL_SAMPLE_SHARE = 0.2;
/** Trips priced per wallet: thirty, as the replay prices (about 320 credits). */
export const LABEL_SAMPLE = 30;
/** Credits reserved per wallet before it is started: pricing plus births. */
export const LABEL_CREDITS_PER_WALLET = 700;
/** Wallets labelled at once. */
export const LABEL_PARALLEL = 2;
/** A label younger than this is kept, not redone. */
export const LABEL_FRESH_MS = 24 * 3_600_000;
/** The window a label covers — the board's week. */
const WEEK_MS = (SCOUT_WINDOW_DAYS.week as number) * 86_400_000;
/** A trip that lost this much of its cost or more ended on a dead coin. */
const DEAD_LOSS = 0.85;
/** The record's recent-trip list is capped; past this many it cannot say
 *  which of the week's trips it saw (electron/engine/walletScout.ts). */
const RECENT_CAP = 12;

export type { LabelStatus };

export interface LabelDeps {
  /** The week's rows, ranked on the ranking figure. */
  rows(): ScoutRow[];
  wallet(address: string): ScoutWallet | null;
  /** Run a replay to the end and return its status. */
  replay(address: string, opts: copyReplay.ReplayOpts): Promise<CopyReplayStatus>;
  /** Every trip that replay built, oldest first. */
  builtTrips(address: string): ReplayTrip[] | null;
  creditsLeft(): number;
  setLabel(address: string, label: ChainLabel): boolean;
  /** Can the chain price at all (a Helius endpoint)? */
  chainOk(): boolean;
  random(): number;
  now(): number;
}

let allowanceOf: () => number = () => DEFAULT_BACKTEST_CREDITS;
let httpUrlOf: () => string = () => '';
/** Attach what the labeler reads from settings (ipc). */
export function attach(fns: { allowance: () => number; httpUrl: () => string }): void {
  allowanceOf = fns.allowance;
  httpUrlOf = fns.httpUrl;
}

type Log = (level: 'info' | 'warn' | 'error', line: string) => void;
let log: Log = () => {};
export function attachLog(fn: Log): void {
  log = fn;
}

const realDeps: LabelDeps = {
  rows() {
    const now = Date.now();
    const prior = walletScout.shrinkPrior('solana', now);
    const rows = walletScout.wallets('solana').map((w) => summarise(w, 'week', now, { sizeSol: 0.1, prior }));
    return rankScout(
      rows.filter((r) => r.buys + r.sells > 0),
      SCOUT_RANK_SORT,
    );
  },
  wallet(address) {
    const key = address.toLowerCase();
    return walletScout.wallets('solana').find((w) => w.address.toLowerCase() === key) ?? null;
  },
  async replay(address, opts) {
    // A replay already running for this wallet (Check, a profile) is joined,
    // not restarted; its sample is whatever it was asked for.
    const r = copyReplay.start(address, httpUrlOf(), undefined, Date.now(), opts);
    if (!r.ok && !/already replaying/i.test(r.message)) return { ...copyReplay.status(address), message: r.message };
    await copyReplay.wait(address);
    return copyReplay.status(address);
  },
  builtTrips: (address) => copyReplay.builtTrips(address),
  creditsLeft: () => heliusBudget.backtestLeft(allowanceOf()),
  setLabel: (address, label) => walletScout.setChainLabel('solana', address, label),
  chainOk: () => /(^|\.)helius-rpc\.com$/i.test(hostOf(httpUrlOf())),
  random: Math.random,
  now: Date.now,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

let st: LabelStatus = fresh();
let runningJob: Promise<void> | null = null;
let cancelAsked = false;

function fresh(): LabelStatus {
  return { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, labelled: 0, excluded: 0, credits: 0, current: [], cancelled: false, message: '' };
}

export function status(): LabelStatus {
  return { ...st, current: [...st.current] };
}

export function cancel(): boolean {
  if (!runningJob) return false;
  cancelAsked = true;
  return true;
}

export function wait(): Promise<void> {
  return runningJob ?? Promise.resolve();
}

/**
 * Which wallets this run labels, in order: the ranked top, then a random
 * share of the rest; fresh labels skipped; as many as the allowance covers.
 */
export function choose(rows: readonly ScoutRow[], creditsLeft: number, now: number, random: () => number): { picked: string[]; eligible: number; skippedFresh: number; budgetCut: number } {
  // The board's own filters, except the one the label itself decides.
  const eligible = applyScoutFilters(rows, { ...scoutFiltersAllOn(), clean: false }).filter((r) => r.fShrunkPct !== null);
  const ranked = eligible.slice(0, LABEL_RANKED_N);
  const rest = eligible.slice(LABEL_RANKED_N).filter(() => random() < LABEL_SAMPLE_SHARE);
  let skippedFresh = 0;
  const wanted: string[] = [];
  for (const r of [...ranked, ...rest]) {
    if (r.chainLabel && now - r.chainLabel.at < LABEL_FRESH_MS) {
      skippedFresh += 1;
      continue;
    }
    wanted.push(r.address);
  }
  const affordable = Math.max(0, Math.floor(creditsLeft / LABEL_CREDITS_PER_WALLET));
  const picked = wanted.slice(0, affordable);
  return { picked, eligible: eligible.length, skippedFresh, budgetCut: wanted.length - picked.length };
}

/** The record's finished trips in the week, from its day buckets. */
function recordedWeekTrips(w: ScoutWallet, now: number): number {
  const since = dayOf(now - WEEK_MS);
  let n = 0;
  for (const d of w.days) if (d.day >= since) n += d.roundTrips;
  return n;
}

/**
 * One wallet's label from its finished replay: the week's chain trips, the
 * sample's median, how much the record had seen, the dead share of what it
 * had not, and the checks.
 */
export function labelFrom(replay: CopyReplayStatus, built: readonly ReplayTrip[] | null, w: ScoutWallet | null, now: number): ChainLabel {
  const week = (built ?? []).filter((t) => t.closedAt >= now - WEEK_MS);
  const chainTrips = week.length;
  let coveragePct: number | null = null;
  let unseenDeadPct: number | null = null;
  if (w && chainTrips > 0) {
    coveragePct = Math.min(100, (recordedWeekTrips(w, now) / chainTrips) * 100);
    // Which of the week's trips the record saw can only be told while its
    // recent-trip list holds the whole week.
    const recent = w.recentTrips ?? [];
    const oldest = recent.length ? Math.min(...recent.map((t) => t.closedAt)) : Infinity;
    if (recent.length < RECENT_CAP || oldest <= now - WEEK_MS) {
      const unseen = week.filter((t) => !recent.some((r) => r.mint === t.mint && Math.abs(r.closedAt - t.closedAt) <= 5_000));
      if (unseen.length) unseenDeadPct = (unseen.filter((t) => t.cost > 0 && t.pnl / t.cost <= -DEAD_LOSS).length / unseen.length) * 100;
    }
  }
  const c = replay.checks;
  return {
    at: now,
    chainTrips,
    sampled: replay.toPrice,
    priced: replay.trips.filter((t) => t.note === 'filled').length,
    medianPct: recordedMedian(replay.trips),
    coveragePct,
    unseenDeadPct,
    washTrips: c?.washTrips ?? 0,
    sharedPayers: c?.sharedPayers ?? 0,
    sniperTrips: c?.sniperTrips ?? 0,
    bundleTrips: c?.bundleTrips ?? 0,
    mintsChecked: c?.mintsChecked ?? 0,
    credits: replay.credits ?? 0,
  };
}

/** Start a run. Returns at once; one at a time. */
export function start(deps: LabelDeps = realDeps): { ok: boolean; message: string } {
  if (runningJob) return { ok: false, message: 'Already checking the board' };
  if (!deps.chainOk()) return { ok: false, message: 'Checking the board needs a Helius key in Settings' };
  const now = deps.now();
  const chosen = choose(deps.rows(), deps.creditsLeft(), now, deps.random);
  st = fresh();
  st.running = true;
  st.startedAt = now;
  st.total = chosen.picked.length;
  if (chosen.budgetCut > 0) st.message = `${chosen.budgetCut} wallet(s) left for later: the backtest allowance covers ${chosen.picked.length}.`;
  if (chosen.picked.length === 0) {
    st.running = false;
    st.finishedAt = now;
    if (!st.message) st.message = chosen.eligible === 0 ? 'Nothing to check: no wallet on the board has the copied trades a ranking needs.' : chosen.skippedFresh > 0 ? `Every eligible wallet was checked in the last day (${chosen.skippedFresh}).` : 'Nothing to check.';
    return { ok: true, message: st.message };
  }
  cancelAsked = false;
  runningJob = run(deps, chosen.picked).finally(() => {
    runningJob = null;
  });
  return { ok: true, message: `Checking ${chosen.picked.length} wallet(s) on the chain` };
}

async function run(deps: LabelDeps, picked: string[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < picked.length && !cancelAsked) {
      if (deps.creditsLeft() < LABEL_CREDITS_PER_WALLET) {
        if (!st.message.includes('allowance')) st.message = `Stopped at ${st.done} of ${picked.length}: the backtest allowance is spent for now.`;
        break;
      }
      const address = picked[next++];
      st.current.push(address);
      try {
        const replay = await deps.replay(address, { sample: 'random', max: LABEL_SAMPLE, checks: true });
        const label = labelFrom(replay, deps.builtTrips(address), deps.wallet(address), deps.now());
        st.credits += label.credits;
        if (replay.tripsFound > 0 || replay.checks) {
          if (deps.setLabel(address, label)) {
            st.labelled += 1;
            if (hardExclusions({ chainLabel: label }).length > 0) st.excluded += 1;
          }
        }
      } catch (e) {
        st.message = `A check failed on ${address.slice(0, 6)}…: ${(e as Error).message ?? String(e)}`.slice(0, 200);
      } finally {
        st.current = st.current.filter((a) => a !== address);
        st.done += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LABEL_PARALLEL, picked.length) }, worker));
  st.cancelled = cancelAsked;
  st.running = false;
  st.finishedAt = deps.now();
  log(st.message ? 'warn' : 'info', `board labeler: ${st.cancelled ? 'cancelled' : 'done'} — ${st.labelled} of ${st.total} labelled, ${st.excluded} excluded, ${st.credits} credits${st.message ? ` · ${st.message}` : ''}`);
}

/** Test seam. */
export function _reset(): void {
  st = fresh();
  runningJob = null;
  cancelAsked = false;
}
