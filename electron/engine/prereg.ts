// The pre-registered test's clock, files and chain work (2026-10-25, P1 of
// docs/wallet-scout-research-2026-10-25.md). The arithmetic and the rule
// live in shared/prereg.ts; this module decides WHEN to freeze and settle,
// writes the records where a person can find them, and runs the replays.
//
// Files, under <userData>/prereg/:
//   PREREG-<monday>.json   the frozen rule and arms, hashed
//   PREREG-<monday>.md     the same, readable
//   settled-<monday>.json  that week's settlement
//
// The clock: a freeze for the coming week is due Sunday 00:00 UTC (the day
// before it begins); `tick` runs hourly and freezes then. If the app was off,
// the running week is frozen late and says so. A week whose freeze exists
// and whose last day has passed is settled: every arm's wallets replayed
// over exactly that week from the chain, inside the backtest allowance, two
// at a time — the same read the board labeler makes, with the ablation's
// lags added.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as walletScout from './walletScout';
import * as copyReplay from './copyReplay';
import * as heliusBudget from '../system/heliusBudget';
import { DEFAULT_BACKTEST_CREDITS } from '@shared/credits';
import type { ReplayTrip } from '@shared/copyReplay';
import { BOT_TRADES_PER_MIN, SCOUT_RANK_SORT, SCOUT_WINDOW_DAYS, rankScout, shortlist, summarise, weekOf, type ScoutRow } from '@shared/walletScout';
import { LCB_Z, SCORE_MIN_F_TRIPS, type ShrinkPrior } from '@shared/walletScore';
import { hashSeed } from '@shared/stats';
import {
  PREREG_ARM_N,
  PREREG_LAGS,
  PREREG_LAG_ASSUMED,
  PREREG_MAX_OPEN_PER_WALLET,
  PREREG_MAX_TRIPS,
  PREREG_MIN_LEADER_SELL_PCT,
  PREREG_RULES_TRIED_BEFORE,
  PREREG_SIZE_SOL,
  canonical,
  freezeDueFor,
  preregFloorPct,
  preregMarkdown,
  preregVerdict,
  settleWeek,
  stratifiedDraw,
  weekLabel,
  type PreregArm,
  type PreregCopy,
  type PreregRule,
  type PreregSettled,
  type PreregStatus,
  type PreregWeek,
} from '@shared/prereg';

const WEEK_MS = (SCOUT_WINDOW_DAYS.week as number) * 86_400_000;
/** Credits reserved per wallet before its replay starts: a deep read, forty
 *  trips at several lags, births. */
export const PREREG_CREDITS_PER_WALLET = 700;
/** Wallets replayed at once. */
export const PREREG_PARALLEL = 2;
/** A settlement that could not start (no credits, no chain) is tried again
 *  after this long, not every hour. */
const RETRY_MS = 6 * 3_600_000;
/** A week that was not frozen on its Sunday is frozen late only this far
 *  into it: a Wednesday freeze is a flagged compromise, a Saturday one would
 *  be a rule written with the week's answer in hand. */
const LATE_FREEZE_WINDOW_MS = 3 * 86_400_000;

export interface PreregDeps {
  /** The ranked universe as the board ranks it: week window, the test's
   *  size, the week's prior, wallets that traded. */
  rows(now: number): ScoutRow[];
  prior(now: number): ShrinkPrior;
  /** pump.fun's weekly leaderboard, wallets top first; [] when it cannot be read. */
  leaderboard(): Promise<string[]>;
  /** The session's measured slot gap (copyTrade.latency), or null. */
  slotGap(): number | null;
  /** Replay one wallet to the end; null when the replay could not start. */
  replay(address: string, opts: copyReplay.ReplayOpts): Promise<{ trips: ReplayTrip[]; credits: number } | null>;
  creditsLeft(): number;
  chainOk(): boolean;
  now(): number;
  random(): number;
}

let allowanceOf: () => number = () => DEFAULT_BACKTEST_CREDITS;
let httpUrlOf: () => string = () => '';
let leaderboardOf: () => Promise<string[]> = async () => [];
let slotGapOf: () => number | null = () => null;
/** Attach what the test reads from the rest of the app (ipc). */
export function attach(fns: { allowance: () => number; httpUrl: () => string; leaderboard: () => Promise<string[]>; slotGap: () => number | null }): void {
  allowanceOf = fns.allowance;
  httpUrlOf = fns.httpUrl;
  leaderboardOf = fns.leaderboard;
  slotGapOf = fns.slotGap;
}

type Log = (level: 'info' | 'warn' | 'error', line: string) => void;
let log: Log = () => {};
export function attachLog(fn: Log): void {
  log = fn;
}

const realDeps: PreregDeps = {
  rows(now) {
    const prior = walletScout.shrinkPrior('solana', now);
    return walletScout
      .wallets('solana')
      .map((w) => summarise(w, 'week', now, { sizeSol: PREREG_SIZE_SOL, prior }))
      .filter((r) => r.buys + r.sells > 0);
  },
  prior: (now) => walletScout.shrinkPrior('solana', now),
  leaderboard: () => leaderboardOf(),
  slotGap: () => slotGapOf(),
  async replay(address, opts) {
    const r = copyReplay.start(address, httpUrlOf(), undefined, Date.now(), opts);
    if (!r.ok && !/already replaying/i.test(r.message)) return null;
    await copyReplay.wait(address);
    const st = copyReplay.status(address);
    return { trips: st.trips, credits: st.credits ?? 0 };
  },
  creditsLeft: () => heliusBudget.backtestLeft(allowanceOf()),
  chainOk: () => /(^|\.)helius-rpc\.com$/i.test(hostOf(httpUrlOf())),
  now: Date.now,
  random: Math.random,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ── state ─────────────────────────────────────────────────────────────

let dir = '';
const freezes = new Map<number, PreregWeek>();
const settledMap = new Map<number, PreregSettled>();
const badHash = new Set<number>();
/** Week → when its settlement last failed to start. */
const retryAt = new Map<number, number>();

interface Run {
  running: boolean;
  phase: PreregStatus['phase'];
  settlingWeek: number | null;
  done: number;
  total: number;
  credits: number;
  cancelled: boolean;
  message: string;
}
const freshRun = (): Run => ({ running: false, phase: 'idle', settlingWeek: null, done: 0, total: 0, credits: 0, cancelled: false, message: '' });
let st: Run = freshRun();
let job: Promise<void> | null = null;
let cancelAsked = false;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const freezeFile = (week: number): string => path.join(dir, `PREREG-${weekLabel(week)}.json`);
const settledFile = (week: number): string => path.join(dir, `settled-${weekLabel(week)}.json`);

/** Load the records on disk. A freeze whose text no longer hashes to its
 *  hash is kept and listed under `badHash` — never silently trusted. */
export function init(userDataDir: string): void {
  dir = path.join(userDataDir, 'prereg');
  freezes.clear();
  settledMap.clear();
  badHash.clear();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (/^PREREG-\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
      const w = raw as PreregWeek;
      if (!w || w.version !== 1 || typeof w.week !== 'number' || typeof w.hash !== 'string' || !Array.isArray(w.arms)) continue;
      freezes.set(w.week, w);
      if (sha256(canonical(w)) !== w.hash) badHash.add(w.week);
    } else if (/^settled-\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
      const s = raw as PreregSettled;
      if (!s || s.version !== 1 || typeof s.week !== 'number' || !Array.isArray(s.arms)) continue;
      settledMap.set(s.week, s);
    }
  }
}

function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── the freeze ────────────────────────────────────────────────────────

/**
 * Freeze the rule and the arms for `forWeek`. On time when `forWeek` has
 * not begun; late — and marked so — when it has. One freeze per week, ever:
 * a second would be a second try at the answer.
 */
export function freeze(forWeek: number, deps: PreregDeps = realDeps): Promise<{ ok: boolean; message: string }> {
  if (!dir) return Promise.resolve({ ok: false, message: 'The test has no folder yet (not initialised)' });
  if (freezes.has(forWeek)) return Promise.resolve({ ok: false, message: `Week ${weekLabel(forWeek)} is already frozen` });
  if (st.running) return Promise.resolve({ ok: false, message: 'The test is busy' });
  st = { ...freshRun(), running: true, phase: 'freezing' };
  // Tracked as the job, so wait() covers a freeze as it covers a settlement.
  const run = doFreeze(forWeek, deps);
  const p: Promise<void> = run.then(() => {
    if (job === p) job = null;
  });
  job = p;
  return run;
}

async function doFreeze(forWeek: number, deps: PreregDeps): Promise<{ ok: boolean; message: string }> {
  try {
    const now = deps.now();
    const prior = deps.prior(now);
    const rows = deps.rows(now);
    const eligible = shortlist(rankScout(rows, SCOUT_RANK_SORT), rows.length);
    const top = eligible.slice(0, PREREG_ARM_N);
    // RAND from the eligible set the picks did not take, so the arms do not
    // share wallets; from all of it when there is nothing left over.
    const rest = eligible.slice(PREREG_ARM_N);
    const seed = Math.floor(deps.random() * 2 ** 31) ^ hashSeed(`${forWeek}`);
    const rand = stratifiedDraw(rest.length >= PREREG_ARM_N ? rest : eligible, PREREG_ARM_N, seed);
    let lead: string[] = [];
    let leadNote = '';
    try {
      lead = (await deps.leaderboard()).slice(0, PREREG_ARM_N);
      if (!lead.length) leadNote = 'pump.fun’s leaderboard could not be read at the freeze';
    } catch (e) {
      leadNote = `pump.fun’s leaderboard could not be read (${(e as Error).message ?? e})`;
    }
    const gap = deps.slotGap();
    const lagSlots = gap === null ? PREREG_LAG_ASSUMED : Math.max(0, Math.round(gap));
    const rule: PreregRule = {
      ranker: 'eb-lcb',
      muPct: prior.muPct,
      k: prior.k,
      priorWallets: prior.wallets,
      z: LCB_Z,
      minTrips: SCORE_MIN_F_TRIPS,
      botPerMin: BOT_TRADES_PER_MIN,
      filters: 'the five board filters on and the chain labels’ hard exclusions',
      sizeSol: PREREG_SIZE_SOL,
      lagSlots,
      lagSource: gap === null ? 'assumed' : 'measured',
      minLeaderSellPct: PREREG_MIN_LEADER_SELL_PCT,
      maxOpenPerWallet: PREREG_MAX_OPEN_PER_WALLET,
    };
    const arms: PreregArm[] = [
      { name: 'TOP', wallets: top.map((r) => r.address), rule: `the top ${PREREG_ARM_N} of the eligible set on the lower bound`, ...(top.length < PREREG_ARM_N ? { note: `only ${top.length} eligible` } : {}) },
      { name: 'RAND', wallets: rand, rule: `${PREREG_ARM_N} drawn at random from the eligible set, stratified on trip count and first-buy size (seed ${seed})` },
      { name: 'LEAD', wallets: lead, rule: `the top ${PREREG_ARM_N} of pump.fun’s weekly PnL leaderboard at the freeze`, ...(leadNote ? { note: leadNote } : {}) },
    ];
    const body: Omit<PreregWeek, 'hash'> = {
      version: 1,
      chain: 'solana',
      week: forWeek,
      frozenAt: now,
      late: now >= forWeek,
      rule,
      arms,
      floorPct: preregFloorPct(PREREG_SIZE_SOL),
      eligible: eligible.length,
      universe: rows.length,
      rulesTried: PREREG_RULES_TRIED_BEFORE,
    };
    const w: PreregWeek = { ...body, hash: sha256(canonical(body)) };
    writeJson(freezeFile(forWeek), w);
    try {
      fs.writeFileSync(path.join(dir, `PREREG-${weekLabel(forWeek)}.md`), preregMarkdown(w), 'utf8');
    } catch {
      /* the JSON is the record; the markdown is a courtesy */
    }
    freezes.set(forWeek, w);
    st.message = `Frozen ${weekLabel(forWeek)}${w.late ? ' (late)' : ''}: ${top.length} TOP, ${rand.length} RAND, ${lead.length} LEAD of ${eligible.length} eligible`;
    log('info', `prereg: ${st.message} · ${w.hash.slice(0, 12)}`);
    return { ok: true, message: st.message };
  } catch (e) {
    const message = `The freeze failed — ${(e as Error).message ?? e}`;
    st.message = message;
    log('error', `prereg: ${message}`);
    return { ok: false, message };
  } finally {
    st.running = false;
    st.phase = 'idle';
  }
}

// ── the settlement ────────────────────────────────────────────────────

/**
 * Settle a frozen week that has ended: replay every arm's wallets — and the
 * TOP of the two freezes before it, for the rank-decay track — over exactly
 * that week, at the ablation's lags, and write the result. Inside the
 * backtest allowance; a wallet the allowance cannot cover is left out and
 * the settlement says it is incomplete.
 */
export function settle(week: number, deps: PreregDeps = realDeps, opts: { force?: boolean } = {}): { ok: boolean; message: string } {
  if (!dir) return { ok: false, message: 'The test has no folder yet (not initialised)' };
  const fz = freezes.get(week);
  if (!fz) return { ok: false, message: `Week ${weekLabel(week)} was never frozen` };
  if (settledMap.has(week) && !opts.force) return { ok: false, message: `Week ${weekLabel(week)} is already settled` };
  if (st.running) return { ok: false, message: 'The test is busy' };
  const now = deps.now();
  if (now < week + WEEK_MS) return { ok: false, message: `Week ${weekLabel(week)} has not ended` };
  if (!deps.chainOk()) {
    retryAt.set(week, now);
    return { ok: false, message: 'Settling needs a Helius key: every copy is priced from the chain' };
  }
  if (deps.creditsLeft() < PREREG_CREDITS_PER_WALLET) {
    retryAt.set(week, now);
    return { ok: false, message: 'The backtest allowance cannot cover a wallet' };
  }
  const prev1 = freezes.get(week - WEEK_MS) ?? null;
  const prev2 = freezes.get(week - 2 * WEEK_MS) ?? null;
  // Every wallet once, whichever arms and tracks it is in.
  const armsOf = new Map<string, PreregCopy['arm'][]>();
  const add = (arm: PreregCopy['arm'], wallets: readonly string[]): void => {
    for (const w of wallets) armsOf.set(w, [...(armsOf.get(w) ?? []), arm]);
  };
  for (const a of fz.arms) add(a.name, a.wallets);
  if (prev1) add('TRACK1', prev1.arms.find((a) => a.name === 'TOP')?.wallets ?? []);
  if (prev2) add('TRACK2', prev2.arms.find((a) => a.name === 'TOP')?.wallets ?? []);
  const wallets = [...armsOf.keys()];
  cancelAsked = false;
  st = { ...freshRun(), running: true, phase: 'settling', settlingWeek: week, total: wallets.length };
  const lagSlots = fz.rule.lagSlots;
  const lags = [...new Set([...PREREG_LAGS, lagSlots])];
  job = (async () => {
    const copies: PreregCopy[] = [];
    let stopped = '';
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < wallets.length && !stopped && !cancelAsked) {
        if (deps.creditsLeft() < PREREG_CREDITS_PER_WALLET) {
          stopped = 'the backtest allowance could not cover every wallet';
          break;
        }
        const w = wallets[next++];
        let r: { trips: ReplayTrip[]; credits: number } | null = null;
        try {
          r = await deps.replay(w, { since: week, until: week + WEEK_MS, max: PREREG_MAX_TRIPS, sample: 'random', lags });
        } catch (e) {
          log('warn', `prereg: replay of ${w.slice(0, 6)}… failed — ${(e as Error).message ?? e}`);
        }
        st.done += 1;
        if (!r) continue;
        st.credits += r.credits;
        for (const t of r.trips) {
          const atLag = t.atLag ?? (t.returnPct !== null && t.source === 'chain' ? { [String(lagSlots)]: t.returnPct } : {});
          for (const arm of armsOf.get(w) ?? []) copies.push({ arm, wallet: w, mint: t.mint, openedAt: t.openedAt, closedAt: t.closedAt, atLag, tooFast: t.note === 'too-fast' });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PREREG_PARALLEL, wallets.length) }, worker));
    } catch (e) {
      stopped = `the settlement stopped — ${(e as Error).message ?? e}`;
    }
    const complete = !stopped && !cancelAsked && st.done === wallets.length;
    const message = stopped || (cancelAsked ? 'stopped early' : '');
    if (st.done === 0 && !complete) {
      // Nothing replayed: not a settlement. Try again later.
      retryAt.set(week, deps.now());
      st.message = `Week ${weekLabel(week)} could not be settled: ${message || 'no wallet was replayed'}`;
      log('warn', `prereg: ${st.message}`);
    } else {
      const settled = settleWeek(fz, copies, { prev1, prev2 }, lagSlots, deps.now(), { complete, credits: st.credits, message });
      try {
        writeJson(settledFile(week), settled);
      } catch (e) {
        log('error', `prereg: could not write the settlement of ${weekLabel(week)} — ${(e as Error).message ?? e}`);
      }
      settledMap.set(week, settled);
      const top = settled.arms.find((a) => a.name === 'TOP');
      st.message = `Settled ${weekLabel(week)}${complete ? '' : ' (incomplete)'}: TOP median ${top?.medianPct === null || top?.medianPct === undefined ? '—' : `${top.medianPct.toFixed(1)} %`} over ${top?.copies ?? 0} copies, ${st.credits} credits`;
      log('info', `prereg: ${st.message}`);
    }
    st.cancelled = cancelAsked;
    st.running = false;
    st.phase = 'idle';
    job = null;
  })();
  return { ok: true, message: `Settling ${weekLabel(week)}: ${wallets.length} wallets` };
}

export function cancel(): boolean {
  if (!st.running || st.phase !== 'settling') return false;
  cancelAsked = true;
  return true;
}

export function wait(): Promise<void> {
  return job ?? Promise.resolve();
}

// ── the clock ─────────────────────────────────────────────────────────

/** What is due now, if anything: a freeze (on time, or late), then the
 *  oldest ended week with a freeze and no settlement. Called hourly. */
export function tick(deps: PreregDeps = realDeps): void {
  if (!dir || st.running) return;
  const now = deps.now();
  const thisWeek = weekOf(now);
  const nextWeek = thisWeek + WEEK_MS;
  if (now >= freezeDueFor(nextWeek) && !freezes.has(nextWeek)) {
    void freeze(nextWeek, deps);
    return;
  }
  if (!freezes.has(thisWeek) && now < thisWeek + LATE_FREEZE_WINDOW_MS) {
    void freeze(thisWeek, deps);
    return;
  }
  for (const w of [...freezes.keys()].sort((a, b) => a - b)) {
    if (w + WEEK_MS > now || settledMap.has(w)) continue;
    const last = retryAt.get(w);
    if (last !== undefined && now - last < RETRY_MS) continue;
    settle(w, deps);
    return;
  }
}

export function status(deps: PreregDeps = realDeps): PreregStatus {
  const now = deps.now();
  const thisWeek = weekOf(now);
  const nextWeek = thisWeek + WEEK_MS;
  const settled = [...settledMap.values()].sort((a, b) => a.week - b.week);
  return {
    ...st,
    freezes: [...freezes.values()].sort((a, b) => a.week - b.week),
    settled,
    verdict: preregVerdict(settled),
    nextWeek: freezes.has(nextWeek) ? nextWeek + WEEK_MS : nextWeek,
    nextDue: freezeDueFor(freezes.has(nextWeek) ? nextWeek + WEEK_MS : nextWeek),
    slotGap: deps.slotGap(),
    badHash: [...badHash].sort((a, b) => a - b),
    chainOk: deps.chainOk(),
  };
}

/** Test seam. */
export function _reset(): void {
  dir = '';
  freezes.clear();
  settledMap.clear();
  badHash.clear();
  retryAt.clear();
  st = freshRun();
  job = null;
  cancelAsked = false;
}
