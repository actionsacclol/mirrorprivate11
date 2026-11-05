// The wallet password, as a person meets it: what each screen says, in what order,
// and what has to be true first. The keys move in vaultOps.ts; the window is in
// passwordPrompt.ts. No channel here takes a password from the app window.

import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import type { PromptSpec, VaultStatus, VaultWalletRow } from '@shared/vault';
import * as wallet from './wallet';
import * as evmWallet from '../evm/evmWallet';
import * as aioWallet from './aioWallet';
import * as vault from './vault';
import * as ops from './vaultOps';
import { formatRecoveryKey, newRoot, parseRecoveryKey, passwordProblem } from './vaultCore';
import { promptIsOpen, registerPromptIpc, runPrompt, type Step, type StepReply } from './passwordPrompt';
import { logger } from './logger';

export interface VaultDeps {
  /** Live on any chain, in words, or null. */
  liveArmed: () => string | null;
  /** Take every chain to Paper and pause what trades on its own. */
  stopTrading: () => void;
  /** How many live positions would have no working exit once locked. */
  openLivePositions: () => number;
  /** Why this wallet must keep signing unattended, or null. */
  inUse: (family: 'solana' | 'evm', id: string) => string | null;
  /** The first moment keys are usable: arm what was saved as Live, recover a crash. */
  onUnlocked: () => void;
  onChanged: () => void;
}

let deps: VaultDeps;

const windowOf = (sender: Electron.WebContents | null): BrowserWindow | null => (sender ? BrowserWindow.fromWebContents(sender) : null);

function askNative(sender: Electron.WebContents | null, opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = windowOf(sender);
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

export function status(): VaultStatus {
  const rows = (family: 'solana' | 'evm', list: ReturnType<typeof wallet.vaultRows>): VaultWalletRow[] =>
    list.map((w) => ({
      family,
      id: w.id,
      label: w.label,
      address: w.address,
      scope: vault.isSealed(w.enc) ? (vault.scopeOf(w.enc) ?? 'hot') : 'os',
      mustStayHot: w.active ? 'It signs for this chain now. To make it a savings wallet, switch to another wallet first.' : deps.inUse(family, w.id),
    }));
  return {
    on: vault.isOn(),
    locked: vault.isLocked(),
    needsRecovery: vault.needsRecovery(),
    migrating: vault.migrating() !== null,
    tampered: wallet.tampered(),
    wallets: [...rows('solana', wallet.vaultRows()), ...rows('evm', evmWallet.vaultRows())],
  };
}

function afterUnlock(): void {
  logger.info('wallet password: unlocked');
  const authentic = vault.fileIsAuthentic();
  if (!authentic) logger.warn('wallet password: vault.json settings did not verify');
  const bad = wallet.tampered();
  if (bad.length) logger.warn(`wallet password: details changed outside the app on: ${bad.join(', ')}`);
  wallet.scrubLegacy();
  deps.onUnlocked();
}

// ── Screens ──────────────────────────────────────────────────────────────

const passwordField = { id: 'password', label: 'Wallet password', secret: true };
const newFields = [
  { id: 'password', label: 'New password (12 characters or more; four unrelated words work well)', secret: true },
  { id: 'repeat', label: 'Type it again', secret: true },
];

function newPasswordProblem(v: Record<string, string>): string | null {
  const password = v.password ?? '';
  const problem = passwordProblem(password);
  if (problem) return problem;
  return password === v.repeat ? null : 'The two passwords do not match.';
}

const doneStep = (spec: Omit<PromptSpec, 'fields' | 'submit' | 'cancel'>): Step<boolean> => ({
  spec: { ...spec, fields: [], submit: 'Close', cancel: null },
  submit: () => ({ done: true }),
});

/** The unlock finished a turn-off that a crash had interrupted. The password is
 *  gone now, so whatever it was typed for has nothing left to run under. */
const finishedTurningOff: Step<boolean> = {
  spec: {
    title: 'Your wallet password is now off',
    lines: ['Turning it off was interrupted earlier, and that has just finished. Nothing else was done: try again if you were in the middle of something.'],
    fields: [],
    submit: 'Close',
    cancel: null,
  },
  submit: () => ({ done: false }),
};

/** Lost both: the last resort. Native dialogs, because they cannot be mis-clicked
 *  from inside the password window and a page cannot press them. */
async function resetFlow(sender: Electron.WebContents | null): Promise<boolean> {
  const first = await askNative(sender, {
    type: 'warning',
    buttons: ['Cancel', 'I have lost both'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Reset wallets',
    message: 'Have you lost both your password and your recovery key?',
    detail: 'No one can open these wallets without one of them. Krypt cannot recover them, and funds in them stay out of reach unless you have your own copy of the keys.\n\nThis moves the locked files into a folder inside the app\'s data, so a remembered password can still open them later. Nothing is deleted. The app then starts with no wallets.',
  });
  if (first.response !== 1) return false;
  const second = await askNative(sender, {
    type: 'warning',
    buttons: ['Cancel', 'Move them and restart'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Reset wallets',
    message: 'Move the locked wallets aside and restart?',
  });
  if (second.response !== 1) return false;
  ops.moveAside();
  app.relaunch();
  app.quit();
  return true;
}

function recoverStep(sender: Electron.WebContents | null): Step<boolean> {
  return {
    spec: {
      title: 'Use your recovery key',
      lines: ['Type the recovery key you saved when you turned the password on, then choose a new password.'],
      fields: [{ id: 'key', label: 'Recovery key', secret: false }, ...newFields],
      submit: 'Unlock',
      cancel: 'Cancel',
      links: [{ id: 'lost', label: 'I have lost my password and my recovery key' }],
    },
    submit: async (v) => {
      const root = parseRecoveryKey(v.key ?? '');
      if (!root) return { error: 'That is not a recovery key. It has 32 letters and numbers, in groups of four.' };
      const problem = newPasswordProblem(v);
      if (problem) {
        root.fill(0);
        return { error: problem };
      }
      try {
        const ok = await ops.recover(v.password, root);
        return ok ? { done: true } : { error: 'That recovery key does not open these wallets.' };
      } finally {
        root.fill(0);
      }
    },
    link: async () => {
      const reset = await resetFlow(sender);
      return reset ? { done: false } : { error: '' };
    },
  };
}

interface AuthOptions {
  title: string;
  lines: string[];
  warn?: string;
  submit?: string;
  danger?: boolean;
  /** Runs with the checked root, before the window closes. */
  use: (root: Buffer) => Promise<StepReply<boolean>> | StepReply<boolean>;
}

function passwordStep(sender: Electron.WebContents | null, o: AuthOptions): Step<boolean> {
  return {
    spec: {
      title: o.title,
      lines: o.lines,
      warn: o.warn,
      fields: [passwordField],
      submit: o.submit ?? 'Continue',
      cancel: 'Cancel',
      danger: o.danger,
      links: [{ id: 'recover', label: 'Forgot it? Use my recovery key' }],
    },
    submit: async (v) => {
      const r = await vault.tryPassword(v.password ?? '');
      if (!r.ok) return { error: r.message };
      try {
        // The right password has to keep working even if an old change cannot
        // finish, or the action that would fix it (removing a damaged wallet)
        // could never run. Settings says it is still pending.
        try {
          ops.resumeIfInterrupted(r.root);
        } catch (err) {
          logger.warn(`wallet password: could not finish an interrupted change: ${(err as Error).message}`);
        }
        if (!vault.isOn()) return { next: finishedTurningOff };
        return await o.use(r.root);
      } finally {
        r.root.fill(0);
      }
    },
    link: () => ({ next: recoverStep(sender) }),
  };
}

/** 'recovered': in through the recovery key, so what was asked for did NOT run. */
type Outcome = 'done' | 'recovered' | 'cancelled';
const AFTER_RECOVERY = { ok: false, message: 'Your wallets are unlocked with your new password. Try that again.' };

/** Run a change that needs the password, and tell the app if it unlocked it. */
async function withPassword(sender: Electron.WebContents | null, o: AuthOptions): Promise<Outcome> {
  const wasLocked = vault.isLocked();
  const parent = windowOf(sender);
  let ran = false;
  const tracked: AuthOptions = {
    ...o,
    use: (root) => {
      ran = true;
      return o.use(root);
    },
  };
  const first = vault.needsRecovery() ? recoverStep(sender) : passwordStep(sender, tracked);
  const done = await runPrompt(parent, first);
  if (wasLocked && !vault.isLocked()) afterUnlock();
  deps.onChanged();
  if (done !== true) return 'cancelled';
  return ran ? 'done' : 'recovered';
}

// ── What the gates and the UI call ───────────────────────────────────────

/** The app's own launch prompt, and the Unlock button. */
export function promptUnlock(parent: BrowserWindow | null): Promise<boolean> {
  if (!vault.isLocked()) return Promise.resolve(true);
  const sender = parent?.webContents ?? null;
  return withPassword(sender, {
    title: 'Unlock your wallets',
    lines: ['Until you unlock, the app can look around and paper trade, but no wallet can sign. Live positions have no exits while it is locked.'],
    submit: 'Unlock',
    use: (root) => {
      vault.useRoot(root, false);
      return { done: true };
    },
  }).then((outcome) => outcome !== 'cancelled');
}

export type Authorized = { ok: true } | { ok: false; message: string };

/**
 * The gate in front of a sensitive channel. On success the cold key is held until
 * `release`, so the action can reach a savings wallet. Every caller releases.
 */
export async function authorize(sender: Electron.WebContents | null, title: string, detail?: string): Promise<Authorized> {
  if (!sender) return { ok: false, message: 'This needs your wallet password, typed by you in the app.' };
  if (promptIsOpen()) return { ok: false, message: 'A password window is already open.' };
  let held = false;
  const outcome = await withPassword(sender, {
    title,
    lines: [detail ?? 'Type your wallet password to continue.'],
    use: (root) => {
      vault.useRoot(root, true);
      held = true;
      return { done: true };
    },
  });
  if (outcome === 'done' && held) return { ok: true };
  if (held) vault.releaseCold();
  // Through the recovery key: unlocked, with a new password, but nothing approved.
  if (outcome === 'recovered') return AFTER_RECOVERY;
  return { ok: false, message: 'Cancelled: your wallet password was not entered.' };
}

export const release = (): void => vault.releaseCold();

async function turnOn(sender: Electron.WebContents | null): Promise<{ ok: boolean; message: string }> {
  if (vault.isOn()) return { ok: false, message: 'The wallet password is already on.' };
  const armed = deps.liveArmed();
  if (armed) return { ok: false, message: `${armed} is live. Switch to Paper first, so no trade is signing while your keys change format.` };
  if (aioWallet.needsBackupFirst()) return { ok: false, message: 'Back up your All-in-One recovery phrase first, on its wallet page.' };
  for (const failure of [wallet.failure(), evmWallet.failure(), aioWallet.failure()]) if (failure) return { ok: false, message: failure };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'This system has no secure key store, so the password cannot be set up.' };
  const unreadable = ops.unreadableKeys();
  if (unreadable.length) return { ok: false, message: `The key of ${unreadable.join(', ')} cannot be read on this computer. Remove it, or restore it from your backup, before setting a password.` };

  const root = newRoot();
  const recoveryKey = formatRecoveryKey(root);
  const lastGroup = recoveryKey.split('-').pop()!;
  await runPrompt<boolean>(windowOf(sender), {
    spec: {
      title: 'Set a wallet password',
      lines: [
        'This encrypts your keys with a password, so a program that copies the wallet files gets nothing it can use without it.',
        'You unlock once each time the app starts. After that, wallets marked "Can auto-trade" keep trading on their own. Sends, withdrawals, exports and raising your caps ask for it every time.',
      ],
      warn: 'After a crash or restart, no wallet can sign until someone unlocks it, including exits on open positions. Do not use this on a machine that must recover by itself.',
      fields: newFields,
      submit: 'Next',
      cancel: 'Cancel',
    },
    submit: (first) => {
      const problem = newPasswordProblem(first);
      if (problem) return { error: problem };
      const password = first.password;
      return {
        next: {
          spec: {
            title: 'Save your recovery key',
            lines: ['Write this down and keep it away from this computer. It is the only way in if you forget your password, and the only thing that works on a new computer.'],
            warn: 'If you lose both the password and this key, those funds are gone for good. Krypt cannot recover them.',
            code: recoveryKey,
            fields: [{ id: 'check', label: `To check you saved it, type the last group of the key (${lastGroup.length} characters)`, secret: false }],
            submit: 'Turn on the password',
            cancel: 'Cancel',
          },
          submit: async (second) => {
            if ((second.check ?? '').trim().toUpperCase() !== lastGroup) return { error: 'That does not match the last group of the key.' };
            // Checked again here: live may have been switched on behind this window.
            const nowArmed = deps.liveArmed();
            if (nowArmed) return { error: `${nowArmed} is live. Switch to Paper, then try again.` };
            const moved = await ops.turnOn(password, root);
            // Kept until here so a failed attempt can be retried with the key they saved.
            root.fill(0);
            return {
              next: doneStep({
                title: 'Your wallet password is on',
                lines: [
                  `${moved} key${moved === 1 ? ' is' : 's are'} now encrypted under your password.`,
                  'This protects these keys from now on. It cannot help a key that already leaked: if one may have, make a new wallet and move your funds.',
                  'Copies made earlier are not changed: exported files, other profiles, File History, Time Machine and the Recycle Bin. Delete any you can find.',
                  'Older versions of the app cannot open these wallets.',
                ],
              }),
            };
          },
        },
      };
    },
  });
  root.fill(0);
  deps.onChanged();
  if (!vault.isOn()) return { ok: false, message: 'Cancelled. Nothing changed.' };
  if (vault.migrating()) return { ok: false, message: 'Your password is set, but not every key has moved to it yet. It tries again each time you unlock, and your wallets keep working until then.' };
  // Closing the last screen with its X still leaves the password on.
  deps.onUnlocked();
  return { ok: true, message: 'Your wallet password is on.' };
}

async function turnOff(sender: Electron.WebContents | null): Promise<{ ok: boolean; message: string }> {
  const armed = deps.liveArmed();
  if (armed) return { ok: false, message: `${armed} is live. Switch to Paper first.` };
  // A store that cannot be read would stop this halfway: some keys back to OS
  // protection only, with Settings still saying the password is on.
  for (const failure of [wallet.failure(), evmWallet.failure(), aioWallet.failure()]) if (failure) return { ok: false, message: failure };
  const outcome = await withPassword(sender, {
    title: 'Turn off the wallet password',
    lines: ['Your keys go back to being protected only by this computer\'s login. Any program running under your login can then read them.'],
    submit: 'Turn it off',
    danger: true,
    use: (root) => {
      ops.turnOff(root);
      return { done: true };
    },
  });
  if (outcome === 'recovered') return AFTER_RECOVERY;
  return outcome === 'done' ? { ok: true, message: 'The wallet password is off.' } : { ok: false, message: 'Cancelled.' };
}

async function change(sender: Electron.WebContents | null): Promise<{ ok: boolean; message: string }> {
  let kept: Buffer | null = null;
  const outcome = await withPassword(sender, {
    title: 'Change your wallet password',
    lines: ['Your current password first.'],
    use: (root) => {
      const copy = Buffer.from(root);
      kept = copy;
      return {
        next: {
          spec: {
            title: 'Choose a new password',
            lines: ['Your recovery key stays the same. If you think your files were copied, a new password does not help them: make new wallets and move your funds.'],
            fields: newFields,
            submit: 'Change password',
            cancel: 'Cancel',
          },
          submit: async (v) => {
            const problem = newPasswordProblem(v);
            if (problem) return { error: problem };
            await ops.changePassword(v.password, copy);
            return { done: true };
          },
        },
      };
    },
  });
  (kept as Buffer | null)?.fill(0);
  if (outcome === 'recovered') return AFTER_RECOVERY;
  return outcome === 'done' ? { ok: true, message: 'Your wallet password was changed.' } : { ok: false, message: 'Cancelled. Your password did not change.' };
}

async function stopAndLock(sender: Electron.WebContents | null): Promise<{ ok: boolean; message: string }> {
  if (!vault.isOn()) return { ok: false, message: 'The wallet password is off.' };
  if (vault.isLocked()) return { ok: true, message: 'Already locked.' };
  const open = deps.openLivePositions();
  const { response } = await askNative(sender, {
    type: 'warning',
    buttons: ['Cancel', 'Stop trading and lock'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Stop trading and lock',
    message: 'Stop all trading and lock your wallets?',
    detail: `Every chain goes to Paper, and no wallet can sign until you unlock.${open > 0 ? ` You have ${open} live position${open === 1 ? '' : 's'} open. Stop-losses and exits will not run while locked.` : ''}`,
  });
  if (response !== 1) return { ok: false, message: 'Cancelled.' };
  deps.stopTrading();
  vault.lock();
  logger.warn('wallet password: trading stopped and wallets locked by the user');
  deps.onChanged();
  return { ok: true, message: 'Trading stopped and your wallets are locked.' };
}

async function setAutoTrade(sender: Electron.WebContents | null, family: 'solana' | 'evm', id: string, on: boolean): Promise<{ ok: boolean; message: string }> {
  if (!vault.isOn()) return { ok: false, message: 'Turn on the wallet password first.' };
  const row = status().wallets.find((w) => w.family === family && w.id === id);
  if (!row) return { ok: false, message: 'No such wallet.' };
  if (!on && row.mustStayHot) return { ok: false, message: row.mustStayHot };
  const outcome = await withPassword(sender, {
    title: on ? `Let ${row.label} auto-trade` : `Make ${row.label} a savings wallet`,
    lines: [on ? 'It will be able to sign on its own whenever the app is unlocked.' : 'It will sign only right after you type your password, so it cannot trade on its own, and it stays closed while the app runs.'],
    use: (root) => {
      ops.setScope(family, id, on ? 'hot' : 'cold', root);
      return { done: true };
    },
  });
  if (outcome === 'recovered') return AFTER_RECOVERY;
  return outcome === 'done' ? { ok: true, message: on ? `${row.label} can auto-trade.` : `${row.label} is now a savings wallet.` } : { ok: false, message: 'Cancelled.' };
}

export function register(d: VaultDeps): void {
  deps = d;
  registerPromptIpc();
  vault.onChange(() => deps.onChanged());
  ipcMain.handle('vault:status', () => status());
  ipcMain.handle('vault:unlock', async (e) => {
    const ok = await promptUnlock(windowOf(e.sender));
    return { ok, message: ok ? 'Unlocked.' : 'Still locked.' };
  });
  ipcMain.handle('vault:turnOn', (e) => turnOn(e.sender));
  ipcMain.handle('vault:turnOff', (e) => turnOff(e.sender));
  ipcMain.handle('vault:change', (e) => change(e.sender));
  ipcMain.handle('vault:stopAndLock', (e) => stopAndLock(e.sender));
  ipcMain.handle('vault:setAutoTrade', (e, family: unknown, id: unknown, on: unknown) => {
    if ((family !== 'solana' && family !== 'evm') || typeof id !== 'string' || typeof on !== 'boolean') return { ok: false, message: 'Invalid request.' };
    return setAutoTrade(e.sender, family, id, on);
  });
}
