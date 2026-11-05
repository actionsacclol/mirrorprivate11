// The wallet password: what the renderer may know, and which actions ask for it.
// Pure data, no crypto. The keys and the file live in electron/system/vault.ts.
//
// The password really encrypts the keys. It is not a check in front of them, so
// a program that copies the wallet files gets nothing it can use without the
// password. The list below is the other half: what a person at an unlocked app
// still has to prove. It is enforced in main, by channel, and no setting can
// switch one off, because a setting is something malware could flip.

/** 'hot' signs unattended after the launch unlock. 'cold' signs only while the
 *  password has just been typed. 'os' is a wallet with the password off. */
import { rearmLoosened } from './rearm';

export type VaultScope = 'hot' | 'cold' | 'os';

export interface VaultWalletRow {
  family: 'solana' | 'evm';
  id: string;
  label: string;
  address: string;
  scope: VaultScope;
  /** Why it cannot be made a savings wallet right now, or null. */
  mustStayHot: string | null;
}

export interface VaultStatus {
  on: boolean;
  locked: boolean;
  /** Keys are encrypted but this machine cannot open the password file: only
   *  the recovery key gets in. */
  needsRecovery: boolean;
  /** A change of format was interrupted and finishes at the next unlock. */
  migrating: boolean;
  /** Wallets whose details were edited outside the app. They will not sign. */
  tampered: string[];
  wallets: VaultWalletRow[];
}

/** One screen of the password window. The window draws exactly this. */
export interface PromptSpec {
  title: string;
  lines: string[];
  warn?: string;
  /** Shown large and selectable: the recovery key, once. */
  code?: string;
  fields: { id: string; label: string; secret: boolean }[];
  submit: string;
  /** Null hides Cancel, for a screen after the change has already happened. */
  cancel: string | null;
  danger?: boolean;
  links?: { id: string; label: string }[];
}

/**
 * Ask for the password, every time. The text is what the window says is being
 * approved. Sends also keep their native dialog: the password proves who is
 * asking, the dialog shows exactly where the money goes.
 */
export const VAULT_GATES: Readonly<Record<string, string>> = {
  // Keys leaving, arriving or being destroyed.
  'wallet:export': 'Save private keys to a file',
  'wallet:backup': 'Save a private key to a file',
  'evm:wallet:export': 'Save EVM private keys to a file',
  'aio:reveal': 'Show the recovery phrase',
  'aio:create': 'Create an All-in-One wallet',
  'aio:import': 'Import a recovery phrase',
  'aio:repair': 'Rebuild keys from the recovery phrase',
  'aio:remove': 'Remove the All-in-One wallet',
  'wallet:import': 'Import a wallet',
  'evm:wallet:import': 'Import an EVM wallet',
  'pump:importAccount': 'Import a pump.fun account',
  'wallet:remove': 'Remove a wallet',
  'evm:wallet:remove': 'Remove an EVM wallet',
  'profiles:remove': 'Remove a profile and its wallets',
  'wallet:setHome': 'Change the withdrawal address',
  // Money leaving a wallet.
  'send:execute': 'Send funds',
  'wallet:withdraw': 'Withdraw',
  'calloutRewards:withdrawUsdc': 'Withdraw rewards',
  'bridge:send': 'Send across chains',
  'aio:moveSend': 'Move funds between chains',
  'aio:refuel': 'Top up gas from another chain',
  'aio:compress': 'Move funds into one place',
  'lab:fund': 'Fund wallets',
  'lab:collect': 'Collect from wallets',
  'launch:send': 'Launch a coin',
  'kryptoMode:goLive': 'Switch a Krypto Mode bot to live',
  'kryptoMode:withdraw': 'Withdraw from a Krypto Mode bot',
  'kryptoTrader:goLive': 'Switch a Krypto Trader session to live',
  // Giving something else control.
  'mcp:newToken': 'Make a new AI connection token',
  'bots:pair': 'Connect a chat bot',
};

/**
 * Ask only in some cases, decided in main from the request itself: raising a
 * cap, opening the AI connection, copying wallets into a profile. Lowering a
 * cap or closing the AI connection never asks, because getting safer must not
 * take a password.
 */
export const VAULT_CONDITIONAL_GATES: readonly string[] = [
  'settings:update',
  'wallet:setMaxBalance',
  'copy:save',
  'automation:setEnabled',
  'mcp:setBudget',
  'mcp:setEnabled',
  'mcp:setAccess',
  'profiles:duplicate',
  'kryptoTrader:setEnvelope',
  'kryptoTrader:setLimits',
  'kryptoMode:setLimits',
];

/**
 * Never asks, on purpose. These get money OUT of a bad trade or stop the app
 * spending, and a prompt in front of an exit is how a stop becomes a trap.
 * Named so a test fails when a new money channel is added without a decision.
 */
export const VAULT_NEVER_GATED: readonly string[] = [
  'live:sellToken',
  'live:sellAll',
  'live:sellDust',
  'live:sweepRent',
  'live:disarm',
  'evm:sell',
  'evm:sellAll',
  'evm:disarm',
  'engine:kill',
  'kryptoMode:sellAll',
  'kryptoMode:pause',
  'kryptoMode:remove',
  'kryptoTrader:sellAll',
  'kryptoTrader:pause',
  'kryptoTrader:remove',
  'automation:killSwitch',
  'automation:remove',
  'copy:remove',
  'orders:cancel',
  'launch:claimFees',
  'pump:signOut',
  // Reading and planning move nothing. A saved address is only a suggestion: the
  // send itself asks for the password and shows the address in a system dialog.
  'send:review',
  'send:book',
  'send:saveContact',
  'send:removeContact',
  'aio:compressPlan',
  'book:remove',
  'watchlist:remove',
  'alerts:remove',
  'templates:delete',
  'card:copyFile',
  'portfolio:export',
  'logs:export',
  'creators:importBlocklist',
  'book:import',
];

/** A cap got looser. `zeroIsOff` for limits where 0 means no limit at all. */
export function capRaised(before: unknown, after: unknown, zeroIsOff = false): boolean {
  if (typeof after !== 'number' || !Number.isFinite(after)) return false;
  if (typeof before !== 'number' || !Number.isFinite(before)) return false;
  if (after === before) return false;
  if (zeroIsOff) {
    if (after === 0) return true;
    if (before === 0) return false;
  }
  return after > before;
}

interface CapSettings {
  execution?: { rearm?: unknown; rearmAfterVerifiedUpgrade?: unknown; maxLiveSol?: unknown; maxOpenCopies?: unknown; maxLiveSessionLossSol?: unknown; maxLiveConsecutiveLosses?: unknown };
  evm?: Partial<Record<string, { maxLiveNative?: unknown } | undefined>>;
  mcp?: { budget?: Partial<Record<string, unknown>> };
  bots?: {
    telegram?: BotCaps;
    discord?: BotCaps;
    trading?: { enabled?: unknown; allowBuys?: unknown; requireConfirm?: unknown; maxBuySol?: unknown; hourlyCapSol?: unknown };
  };
}
interface BotCaps {
  enabled?: unknown;
  token?: unknown;
  ownerId?: unknown;
}

/** Handing a chat bot control is the same class of thing as raising a cap: it is
 *  a new way for money to move, and it survives a restart. */
function botControlGiven(before: CapSettings['bots'], patch: CapSettings['bots']): string[] {
  const out: string[] = [];
  for (const kind of ['telegram', 'discord'] as const) {
    const n = patch?.[kind];
    const b = before?.[kind];
    if (!n) continue;
    const newToken = typeof n.token === 'string' && n.token !== '' && n.token !== b?.token;
    const newOwner = typeof n.ownerId === 'string' && n.ownerId !== b?.ownerId;
    if (newToken || newOwner || (n.enabled === true && b?.enabled !== true)) out.push(`who controls your ${kind} bot`);
  }
  const t = patch?.trading;
  const was = before?.trading;
  if (t) {
    const looser =
      (t.enabled === true && was?.enabled !== true) ||
      (t.allowBuys === true && was?.allowBuys !== true) ||
      (t.requireConfirm === false && was?.requireConfirm !== false) ||
      capRaised(was?.maxBuySol, t.maxBuySol) ||
      capRaised(was?.hourlyCapSol, t.hourlyCapSol);
    if (looser) out.push('what your chat bots may trade');
  }
  return out;
}

/** Which safety limits a settings patch would loosen, in words. Fields the patch
 *  does not carry are not being changed. */
export function settingsCapsRaised(before: CapSettings, patch: CapSettings): string[] {
  const out: string[] = [];
  const b = before.execution ?? {};
  const p = patch.execution ?? {};
  if (capRaised(b.maxLiveSol, p.maxLiveSol, true)) out.push(p.maxLiveSol === 0 ? 'the most a live trade can spend, to no cap' : `the most a live trade can spend, from ${b.maxLiveSol} to ${p.maxLiveSol} SOL`);
  if (capRaised(b.maxOpenCopies, p.maxOpenCopies, true)) out.push(p.maxOpenCopies === 0 ? 'the limit on open copies, to no limit' : `the limit on open copies, from ${b.maxOpenCopies} to ${p.maxOpenCopies}`);
  if (capRaised(b.maxLiveSessionLossSol, p.maxLiveSessionLossSol, true)) out.push(p.maxLiveSessionLossSol === 0 ? 'the session loss limit, to off' : `the session loss limit, from ${b.maxLiveSessionLossSol} to ${p.maxLiveSessionLossSol} SOL`);
  if (capRaised(b.maxLiveConsecutiveLosses, p.maxLiveConsecutiveLosses, true)) out.push(p.maxLiveConsecutiveLosses === 0 ? 'the losing-streak limit, to off' : `the losing-streak limit, from ${b.maxLiveConsecutiveLosses} to ${p.maxLiveConsecutiveLosses}`);
  for (const [chain, next] of Object.entries(patch.evm ?? {})) {
    const was = before.evm?.[chain]?.maxLiveNative;
    if (capRaised(was, next?.maxLiveNative, true)) out.push(next?.maxLiveNative === 0 ? `the most a live ${chain} trade can spend, to no cap` : `the most a live ${chain} trade can spend, from ${String(was)} to ${String(next?.maxLiveNative)}`);
  }
  // The same budget `mcp:setBudget` guards, by the other door.
  if (Object.entries(patch.mcp?.budget ?? {}).some(([k, v]) => capRaised(before.mcp?.budget?.[k], v))) out.push('the AI connection\'s budget');
  out.push(...botControlGiven(before.bots, patch.bots));
  out.push(...rearmLoosened(b.rearm, p.rearm));
  if (p.rearmAfterVerifiedUpgrade === true && b.rearmAfterVerifiedUpgrade === false) out.push('live trading coming back on after a pump.fun upgrade');
  return out;
}

interface FollowCaps {
  mode?: unknown;
  sizing?: unknown;
  sizeValue?: unknown;
  maxTradeSol?: unknown;
  dailyLossLimitSol?: unknown;
  dailyTradeLimit?: unknown;
  maxCopiesPerMinute?: unknown;
  walletLossStopSol?: unknown;
}

/** A stored null or absent per-minute limit runs at the old default of 10. */
const LEGACY_COPIES_PER_MINUTE = 10;

/** What an edit loosens on a LIVE follow. A paper follow spends nothing. A new
 *  live follow counts, or removing one and adding it back walks around all of
 *  this; no app-wide limit caps it unless the user set one. */
export function followCapsRaised(before: FollowCaps | null, after: FollowCaps): string[] {
  if (after.mode !== 'live') return [];
  if (!before) return ['this wallet, by adding a live follow'];
  const out: string[] = [];
  if (before.mode !== 'live') return ['this follow, from paper to live'];
  if (capRaised(before.maxTradeSol, after.maxTradeSol)) out.push(`its most per copy, from ${String(before.maxTradeSol)} to ${String(after.maxTradeSol)}`);
  if (capRaised(before.dailyLossLimitSol, after.dailyLossLimitSol, true)) out.push(after.dailyLossLimitSol === 0 ? 'its daily loss limit, to off' : `its daily loss limit, from ${String(before.dailyLossLimitSol)} to ${String(after.dailyLossLimitSol)}`);
  if (capRaised(before.dailyTradeLimit, after.dailyTradeLimit, true)) out.push(after.dailyTradeLimit === 0 ? 'its daily copy limit, to off' : `its daily copy limit, from ${String(before.dailyTradeLimit)} to ${String(after.dailyTradeLimit)}`);
  const rate = (v: unknown): number => (v === 0 ? Number.POSITIVE_INFINITY : typeof v === 'number' ? v : LEGACY_COPIES_PER_MINUTE);
  if (rate(after.maxCopiesPerMinute) > rate(before.maxCopiesPerMinute)) out.push(after.maxCopiesPerMinute === 0 ? 'its copies a minute limit, to off' : `its copies a minute limit, to ${String(after.maxCopiesPerMinute ?? LEGACY_COPIES_PER_MINUTE)}`);
  if (typeof before.walletLossStopSol === 'number') {
    if (after.walletLossStopSol === null || after.walletLossStopSol === undefined) out.push('its loss stop, to off');
    else if (capRaised(before.walletLossStopSol, after.walletLossStopSol)) out.push(`its loss stop, from ${String(before.walletLossStopSol)} to ${String(after.walletLossStopSol)}`);
  }
  if (before.sizing !== after.sizing) out.push(`how it sizes a copy, from ${String(before.sizing)} to ${String(after.sizing)}`);
  if (before.sizing === after.sizing && capRaised(before.sizeValue, after.sizeValue)) out.push(`its copy size, from ${String(before.sizeValue)} to ${String(after.sizeValue)}`);
  return out;
}
