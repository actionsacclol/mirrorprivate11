// Changes to the wallet password that move keys: turning it on or off, changing
// it, recovering it, and making a wallet hot or cold. No prompts and no windows,
// so tests run every one of these against real files.
//
// Every key is the only copy of someone's money, so the order is:
//   1. Write vault.json first, marked as a change in progress.
//   2. Re-encrypt each store. Each one checks every key back from the disk
//      before its old file goes.
//   3. Clear the mark.
// Records say what form they are in, so a crash at any point resumes at the next
// unlock. Nothing is lost, because nothing is removed until its replacement reads
// back correctly.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import * as wallet from './wallet';
import * as evmWallet from '../evm/evmWallet';
import * as aioWallet from './aioWallet';
import * as vault from './vault';
import { logger } from './logger';

function rewrapEverything(to: 'sealed' | 'os'): number {
  return wallet.rewrapAll(to) + evmWallet.rewrapAll(to) + aioWallet.rewrapAll(to);
}

/** Every key that cannot be opened and matched to its address right now. A change
 *  of format starts only with none, because one bad record would otherwise leave
 *  it half done. */
export function unreadableKeys(): string[] {
  return [...wallet.unreadable(), ...evmWallet.unreadable(), ...aioWallet.unreadable()];
}

function refuseUnreadable(): void {
  const bad = unreadableKeys();
  if (bad.length) throw new Error(`Nothing changed: the key of ${bad.join(', ')} cannot be read on this computer. Remove it, or restore it from your backup, then try again.`);
}

/** Finish a change that was interrupted. Needs the root, so it runs at an unlock. */
export function resumeIfInterrupted(root: Buffer): void {
  if (vault.restoreMigrating(root)) logger.warn('wallet password: the change marker in vault.json was edited outside the app, and the edit was ignored');
  const was = vault.migrating();
  if (!was) return;
  logger.warn(`wallet password: finishing an interrupted change (${was})`);
  vault.useRoot(root, true);
  try {
    if (was === 'on') {
      rewrapEverything('sealed');
      vault.setMigrating(null);
    } else {
      rewrapEverything('os');
      vault.removeFile();
    }
  } finally {
    vault.releaseCold();
  }
}

export async function turnOn(password: string, root: Buffer): Promise<number> {
  // Already on means a retry of a run that stopped part way, with its checks done.
  if (!vault.isOn()) refuseUnreadable();
  await vault.writeNew(password, root, 'on');
  vault.useRoot(root, true);
  try {
    const moved = rewrapEverything('sealed');
    vault.setMigrating(null);
    logger.warn(`wallet password: turned on, ${moved} key(s) now encrypted under it`);
    return moved;
  } finally {
    vault.releaseCold();
  }
}

export function turnOff(root: Buffer): void {
  vault.useRoot(root, true);
  try {
    refuseUnreadable();
    vault.setMigrating('off');
    rewrapEverything('os');
    vault.removeFile();
    logger.warn('wallet password: turned off, keys are back under OS storage only');
  } finally {
    vault.releaseCold();
  }
}

/** A new password over the same root. Records do not change, so this cannot lose
 *  a key. It also does not rotate anything: an old copy of vault.json still opens
 *  with the old password, which is why suspected theft means new wallets. */
export async function changePassword(password: string, root: Buffer): Promise<void> {
  await vault.writeNew(password, root, vault.authenticMigrating(root));
  vault.useRoot(root, false);
  logger.warn('wallet password: changed');
}

/** The way back in with the recovery key. Writes a fresh password file, so it also
 *  works on a new machine or when vault.json is gone. */
export async function recover(password: string, root: Buffer): Promise<boolean> {
  if (!vault.rootOpensStores(root)) return false;
  await vault.writeNew(password, root, vault.authenticMigrating(root));
  vault.useRoot(root, false);
  logger.warn('wallet password: recovered with the recovery key, and a new password set');
  // They are in. A wallet that cannot be moved is no reason to turn them away.
  try {
    resumeIfInterrupted(root);
  } catch (err) {
    logger.warn(`wallet password: could not finish an interrupted change: ${(err as Error).message}`);
  }
  return true;
}

export function setScope(family: 'solana' | 'evm', id: string, scope: 'hot' | 'cold', root: Buffer): void {
  // Sealing a record after the password file is gone would strand that wallet.
  if (!vault.isOn() || vault.migrating()) throw new Error('A change to your keys has not finished yet. Unlock again, then try this.');
  vault.useRoot(root, true);
  try {
    if (family === 'solana') wallet.setScope(id, scope);
    else evmWallet.setScope(id, scope);
    logger.warn(`wallet password: a ${family} wallet is now ${scope === 'hot' ? 'able to auto-trade' : 'a savings wallet'}`);
  } finally {
    vault.releaseCold();
  }
}

/**
 * Both password and recovery key are gone. Nothing can open these keys, so the
 * files are moved aside for the user to keep, never deleted: a remembered password
 * can still open them later by moving them back.
 */
export function moveAside(now = new Date()): string {
  const dir = app.getPath('userData');
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest = path.join(dir, `locked-wallets-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });
  const names = ['wallets.json', 'evm-wallets.json', 'aio-wallet.json', 'vault.json'];
  for (const name of names.flatMap((n) => [n, `${n}.bak`])) {
    const from = path.join(dir, name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dest, name));
  }
  logger.warn(`wallet password: reset, the locked files were moved to ${dest}`);
  return dest;
}
