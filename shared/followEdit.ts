// What an AI connection may do to a follow (2026-11-01).
//
// The user asked for the AI to create and edit copy-trading follows, not only
// read them. The rules are the AI desk's: the AI may make things SAFER, never
// riskier, and arming a live follow — which starts unattended spending — stays
// a person's act in front of the app.
//
//   create   a paper follow may be born switched on; a live one is always
//            saved switched off (copyTrade.upsert enforces that too, so this
//            is belt and braces, not the only wall).
//   update   a paper follow takes any valid setting. A LIVE follow — or a
//            paper one still holding live copies, whose exits run on these
//            settings — takes only the edits in LIVE_RULES' safe direction,
//            and one widening edit refuses the whole call.
//
// Which way is "safer" is decided per field below. Where it is not obvious
// the field is `fixed` on a live follow: when unsure, it widens.
//
// Pure: no state, no host. electron/engine/mcpTools.ts applies it and
// test/mcptools.test.mjs pins it.

import {
  DEFAULT_COPIES_PER_MINUTE,
  FOLLOW_PCTS,
  SIMPLE_SIZES,
  activeWindowOf,
  cleanBlocklist,
  directionOf,
  fmtClock,
  followConfig,
  inActiveWindow,
  ownExitsOf,
  type CopyConfig,
  type CopyMode,
} from './copytrade';
import type { ChainKind } from './evm';
import { FOLLOW_FIELDS, type FollowField, type FollowFieldKey } from './mcp';

/** The settings an AI call carries. Only keys it sent are present. */
export type FollowPatch = Partial<Pick<CopyConfig, FollowFieldKey | 'enabled'>>;

/**
 * Which way each field may move on a live follow.
 *
 *   free          cosmetic (the label)
 *   fixed         may not change at all — strategy, not a limit, or a
 *                 direction nobody can call safer with confidence
 *   lower         a required number that may only go down
 *   perMinute     lower, where null means DEFAULT_COPIES_PER_MINUTE
 *   capOrAdd      a ceiling: null is "no ceiling" (infinite) — may go down
 *                 or be added, never raised or removed
 *   floorOrAdd    a floor: null is "no floor" — may go up or be added
 *   sellMoreOnly  minLeaderSellPct: null mirrors every sell (0) — may only
 *                 go down, so more of their sells are followed out
 *   exit          the position's own exits, compared as `ownExitsOf` reads
 *                 them (a reverse follow's null is its default, not off) —
 *                 a lower trigger exits sooner; removing one is refused
 *   onOnly        a boolean whose true is stricter or exits more
 *   addOnly       a blocklist: entries may be added, never removed
 *   hours         trading hours: the new window must sit inside the old
 */
type LiveRule = 'free' | 'fixed' | 'lower' | 'perMinute' | 'capOrAdd' | 'floorOrAdd' | 'sellMoreOnly' | 'exit' | 'onOnly' | 'addOnly' | 'hours';

export const LIVE_RULES: Record<FollowFieldKey, LiveRule> = {
  label: 'free',
  direction: 'fixed',
  sizing: 'fixed',
  sizeValue: 'lower',
  maxTradeSol: 'lower',
  dailyLossLimitSol: 'lower',
  dailyTradeLimit: 'lower',
  maxCopiesPerMinute: 'perMinute',
  // A smaller stop pauses the follow sooner: safer. Removing it is not.
  walletLossStopSol: 'capOrAdd',
  // A tighter slippage cap refuses fills a wider one would take.
  maxSlippagePct: 'lower',
  // Longer or shorter, a delay changes WHICH fills happen, not how much is
  // at risk — not provably safer either way.
  delayMs: 'fixed',
  minLiquidityUsd: 'floorOrAdd',
  minMarketCapUsd: 'floorOrAdd',
  maxMarketCapUsd: 'capOrAdd',
  minKryptScore: 'floorOrAdd',
  onlyPumpfun: 'onOnly',
  minLeaderSol: 'floorOrAdd',
  maxLeaderSol: 'capOrAdd',
  minTokenAgeSec: 'floorOrAdd',
  maxTokenAgeSec: 'capOrAdd',
  maxBuysPerToken: 'capOrAdd',
  blockedMints: 'addOnly',
  blockedCreators: 'addOnly',
  onePositionPerCoin: 'onOnly',
  activeFromMin: 'hours',
  activeToMin: 'hours',
  copySells: 'onOnly',
  minLeaderSellPct: 'sellMoreOnly',
  copyOtherExits: 'onOnly',
  exitTakeProfitPct: 'exit',
  exitStopLossPct: 'exit',
  exitMaxHoldMin: 'exit',
  exitTrailingPct: 'exit',
  // A lower share fires on a smaller creator sell: out sooner.
  exitOnCreatorSellPct: 'capOrAdd',
  exitOnMigration: 'onOnly',
};

const EXIT_KEY = {
  exitTakeProfitPct: 'takeProfitPct',
  exitStopLossPct: 'stopLossPct',
  exitMaxHoldMin: 'maxHoldMin',
  exitTrailingPct: 'trailingPct',
} as const;

/** Read the follow settings an AI call sent. Refuses rather than coerces. */
export function readFollowPatch(args: Record<string, unknown>): { ok: true; patch: FollowPatch } | { ok: false; why: string } {
  const patch: Record<string, unknown> = {};
  for (const f of FOLLOW_FIELDS as readonly FollowField[]) {
    if (!(f.key in args) || args[f.key] === undefined) continue;
    const v = args[f.key];
    switch (f.kind) {
      case 'number':
        if (v === null) return { ok: false, why: `${f.key} cannot be switched off — send a number` };
        if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, why: `${f.key} must be a number` };
        patch[f.key] = v;
        break;
      case 'numberOrOff':
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) return { ok: false, why: `${f.key} must be a number, or null to switch it off` };
        patch[f.key] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, why: `${f.key} must be true or false` };
        patch[f.key] = v;
        break;
      case 'list':
        if (v !== null && (!Array.isArray(v) || v.length > 100 || v.some((a) => typeof a !== 'string' || !a.trim() || a.length > 64))) {
          return { ok: false, why: `${f.key} must be a list of up to 100 addresses, or null` };
        }
        patch[f.key] = cleanBlocklist(v);
        break;
      case 'text':
        if (typeof v !== 'string') return { ok: false, why: `${f.key} must be text` };
        if (v.trim().length > 40) return { ok: false, why: `${f.key} must be at most 40 characters` };
        patch[f.key] = v.trim();
        break;
      case 'choice':
        if (typeof v !== 'string' || !(f.choices ?? []).includes(v)) return { ok: false, why: `${f.key} must be one of ${(f.choices ?? []).join(', ')}` };
        patch[f.key] = v;
        break;
    }
  }
  return { ok: true, patch: patch as FollowPatch };
}

/**
 * A new follow from an address and what the AI sent. The Follow page's
 * defaults underneath (followConfig: limits derived from the size), the AI's
 * settings on top. A live follow is switched off, whatever was asked.
 */
export function buildFollow(wallet: string, chain: ChainKind, mode: CopyMode, enabled: boolean, patch: FollowPatch): Omit<CopyConfig, 'id' | 'createdAt'> {
  const sizing = patch.sizing ?? 'fixed';
  const value = patch.sizeValue ?? (sizing === 'proportional' ? FOLLOW_PCTS[1] : SIMPLE_SIZES[1]);
  const base = followConfig(wallet, patch.label ?? '', chain, sizing, value, patch.maxTradeSol);
  return { ...base, ...patch, chain, wallet, mode, enabled: mode === 'live' ? false : enabled };
}

const shown = (v: unknown): string =>
  v === null || v === undefined || v === Number.POSITIVE_INFINITY || v === Number.NEGATIVE_INFINITY ? 'off' : typeof v === 'boolean' ? (v ? 'on' : 'off') : Array.isArray(v) ? `${v.length} listed` : String(v);

const hoursText = (c: Pick<CopyConfig, 'activeFromMin' | 'activeToMin'>): string => {
  const w = activeWindowOf(c);
  return w ? `${fmtClock(w.fromMin)}–${fmtClock(w.toMin)}` : 'all day';
};

/** Does window `inner` (null = all day) sit inside `outer`? */
function hoursInside(inner: ReturnType<typeof activeWindowOf>, outer: ReturnType<typeof activeWindowOf>): boolean {
  if (!outer) return true;
  if (!inner) return false;
  for (let m = 0; m < 1_440; m++) if (inActiveWindow(inner, m) && !inActiveWindow(outer, m)) return false;
  return true;
}

/**
 * Every edit from `before` to `after` that widens a live follow's risk, in
 * words. Empty = every change is in the safe direction. `enabled` is judged
 * by the caller (a paper follow holding live copies may be switched on: its
 * new copies are paper).
 */
export function liveEditRefusals(before: CopyConfig, after: CopyConfig): string[] {
  const out: string[] = [];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const num = (v: unknown, nullIs: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : nullIs);
  const xb = ownExitsOf(before);
  const xa = ownExitsOf(after);
  let hoursDone = false;
  for (const key of Object.keys(LIVE_RULES) as FollowFieldKey[]) {
    const rule = LIVE_RULES[key];
    const was = b[key];
    const now = a[key];
    switch (rule) {
      case 'free':
        break;
      case 'fixed': {
        // An old config without a direction is a copy follow.
        const w = key === 'direction' ? directionOf(before) : was;
        const n = key === 'direction' ? directionOf(after) : now;
        if (w !== n) out.push(`${key} ${shown(w)} → ${shown(n)} (fixed on a live follow)`);
        break;
      }
      case 'lower':
        if (num(now, 0) > num(was, 0)) out.push(`${key} ${shown(was)} → ${shown(now)} (higher)`);
        break;
      case 'perMinute':
        if (num(now, DEFAULT_COPIES_PER_MINUTE) > num(was, DEFAULT_COPIES_PER_MINUTE)) {
          out.push(`${key} ${num(was, DEFAULT_COPIES_PER_MINUTE)} → ${num(now, DEFAULT_COPIES_PER_MINUTE)} (higher)`);
        }
        break;
      case 'capOrAdd':
        if (num(now, Number.POSITIVE_INFINITY) > num(was, Number.POSITIVE_INFINITY)) {
          out.push(`${key} ${shown(was)} → ${shown(now)} (${now === null || now === undefined ? 'removed' : 'higher'})`);
        }
        break;
      case 'floorOrAdd':
        if (num(now, Number.NEGATIVE_INFINITY) < num(was, Number.NEGATIVE_INFINITY)) {
          out.push(`${key} ${shown(was)} → ${shown(now)} (${now === null || now === undefined ? 'removed' : 'lower'})`);
        }
        break;
      case 'sellMoreOnly':
        if (num(now, 0) > num(was, 0)) out.push(`${key} ${shown(was)} → ${shown(now)} (fewer of their sells followed)`);
        break;
      case 'exit': {
        const k = EXIT_KEY[key as keyof typeof EXIT_KEY];
        const pb = num(xb[k], Number.POSITIVE_INFINITY);
        const pa = num(xa[k], Number.POSITIVE_INFINITY);
        if (pa > pb) out.push(`${key} ${shown(xb[k])} → ${shown(xa[k])} (${xa[k] === null ? 'removed' : 'looser'})`);
        break;
      }
      case 'onOnly':
        if (was === true && now !== true) out.push(`${key} on → off`);
        break;
      case 'addOnly': {
        const kept = new Set((now as string[] | null | undefined) ?? []);
        const gone = ((was as string[] | null | undefined) ?? []).filter((x) => !kept.has(x));
        if (gone.length) out.push(`${key}: ${gone.length} entr${gone.length === 1 ? 'y' : 'ies'} removed`);
        break;
      }
      case 'hours':
        if (hoursDone) break;
        hoursDone = true;
        if (!hoursInside(activeWindowOf(after), activeWindowOf(before))) out.push(`trading hours ${hoursText(before)} → ${hoursText(after)} (longer)`);
        break;
    }
  }
  return out;
}

/** What changed, in words, for the notice and the answer. */
export function describeFollowChanges(before: CopyConfig, after: CopyConfig): string[] {
  const out: string[] = [];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  if (!!before.enabled !== !!after.enabled) out.push(after.enabled ? 'switched on' : 'paused');
  let hoursDone = false;
  for (const f of FOLLOW_FIELDS as readonly FollowField[]) {
    if (f.key === 'activeFromMin' || f.key === 'activeToMin') {
      if (hoursDone) continue;
      hoursDone = true;
      if (hoursText(before) !== hoursText(after)) out.push(`trading hours ${hoursText(before)} → ${hoursText(after)}`);
      continue;
    }
    const was = b[f.key] ?? null;
    const now = a[f.key] ?? null;
    const same = Array.isArray(was) || Array.isArray(now) ? JSON.stringify(was) === JSON.stringify(now) : was === now;
    if (!same) out.push(`${f.key} ${shown(was)} → ${shown(now)}`);
  }
  return out;
}

/**
 * The follow ceiling (2026-11-02, Full control): what a live follow must stay
 * inside for an AI to switch it on or widen it. Empty = inside. Units are the
 * follow's own chain coin (SOL, ETH or BNB), like every size in its config.
 *
 * Per copy is bounded by maxTradeSol alone: it caps a proportional copy, and
 * a fixed copy spends min(sizeValue, maxTradeSol).
 */
export function followCeilingRefusals(cfg: Pick<CopyConfig, 'maxTradeSol' | 'dailyLossLimitSol'>, ceiling: { followMaxCopySol: number; followDailyLossSol: number }): string[] {
  const out: string[] = [];
  if (!(cfg.maxTradeSol <= ceiling.followMaxCopySol)) out.push(`maxTradeSol ${shown(cfg.maxTradeSol)} is above the AI’s per-copy ceiling of ${ceiling.followMaxCopySol}`);
  if (!(cfg.dailyLossLimitSol <= ceiling.followDailyLossSol)) out.push(`dailyLossLimitSol ${shown(cfg.dailyLossLimitSol)} is above the AI’s daily-loss ceiling of ${ceiling.followDailyLossSol}`);
  return out;
}
