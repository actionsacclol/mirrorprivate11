// Dedicated hot-wallet manager. The trading wallet is generated IN-APP so
// the user's real wallet keys never touch Krypto Mirror (guidelines §13:
// separate trading hot wallet, max balance, encrypted OS credential
// storage, no seed in config, no key in logs).
//
// Storage model:
//  - The 32-byte ed25519 secret is encrypted with Electron safeStorage,
//    which uses the OS keystore (Windows DPAPI, macOS Keychain), tied to
//    the user account. The ciphertext lives in userData/wallets.json.
//  - SEVERAL wallets may be held; exactly ONE is active and it is the only
//    one that can sign. Everything downstream (engine, liveSigner, sweep)
//    calls the same `publicKey()` / `signVersionedTransaction()` it always
//    did and is unaware there is a list — which is the point: switching
//    wallets must not become a new way for the signer to misbehave.
//  - The bookkeeping rules live in walletStore.ts, with no key material, so
//    they can be tested offline.
//  - A v1 `wallet.json` is migrated on first read. The old file is LEFT IN
//    PLACE: it holds a copy of a key, and deleting it as a side effect of an
//    upgrade is not a risk worth taking.
//  - The PUBLIC key is stored/returned in the clear (it's public).
//  - The secret is decrypted ONLY transiently, inside this module, and is
//    never sent to the renderer, written to a log, or put in a config value.
//
// Signing IS implemented here (LIVE_EXECUTION_AVAILABLE is true). Every
// signature goes through signVersionedTransaction(), which decodes the
// transaction and re-validates where the SOL goes before the key is decrypted
// — see checkOutflow() for the policy and why it exists.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { base58Encode, base58Decode } from '../chain/base58';
import { logger } from './logger';
import { writeDurable } from './durableFile';
import * as vault from './vault';
import { getBalance } from '../chain/rpcClient';
import { checkOutflow, type ApprovedSend, type SignPolicy } from './signPolicy';
import {
  activeWallet,
  addWallet,
  cleanLabel,
  emptyFile,
  nextLabel,
  parseFile,
  patchActive,
  removeWallet as removeFromStore,
  renameWallet as renameInStore,
  selectWallet,
  DEFAULT_MAX_BALANCE_SOL,
  MAX_WALLETS,
  type StoredWallet,
  type WalletsFile,
} from './walletStore';
import type { WalletInfo, WalletSummary } from '@shared/types';
import { pumpLoginMessage } from '@shared/pumpAuth';

export type { SignIntent, SignPolicy } from './signPolicy';

const LAMPORTS_PER_SOL = 1_000_000_000;

let cache: WalletsFile | null = null;

vault.registerStore(() => loadFile().wallets.map((w) => ({ family: 'solana', id: w.id, address: w.publicKey, enc: w.secretEnc })));
/** Balances are per WALLET — a cached figure from the previous wallet shown
 *  against the new one is the kind of small lie that gets someone to send
 *  funds to the wrong place. Keyed by public key, cleared on switch. */
let balances = new Map<string, { lamports: number; at: number }>();

function file(): string {
  return path.join(app.getPath('userData'), 'wallets.json');
}

function legacyFile(): string {
  return path.join(app.getPath('userData'), 'wallet.json');
}

function newId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Set when wallets.json exists but could not be read or parsed. The file
 * holds the only copy of every encrypted key, so this state must never be
 * confused with "this install has no wallets": treating it as empty would
 * let the next persist() overwrite the keys with an empty file. While it is
 * set, the store reports no wallets AND refuses to write.
 */
let loadFailure: string | null = null;

/** Why the store is read-only right now, or null when it is healthy.
 *  Loads the file if that has not happened yet, so an early caller cannot
 *  read a stale "healthy". */
export function failure(): string | null {
  loadFile();
  return loadFailure;
}

function readWalletsFile(p: string): { ok: true; file: WalletsFile | null } | { ok: false; why: string } {
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    // Absent is a normal first run. Anything else — a locked file, a bad
    // disk, no permission — is a failure to READ, not an empty wallet set.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file: null };
    return { ok: false, why: `${p} could not be read (${(e as Error).message})` };
  }
  try {
    const parsed = parseFile(JSON.parse(text), Date.now(), newId);
    if (!parsed) return { ok: false, why: `${p} is not a wallet file this version understands` };
    return { ok: true, file: parsed };
  } catch (e) {
    return { ok: false, why: `${p} is corrupt (${(e as Error).message})` };
  }
}

function loadFile(): WalletsFile {
  if (cache) return cache;
  const current = readWalletsFile(file());
  if (!current.ok) {
    // Keep the bytes. A later version, or the user with a text editor, can
    // still recover keys from them; an overwrite could not be undone.
    loadFailure = `${current.why}. Your keys are still in that file — the app will not write to it until this is resolved.`;
    logger.error(`wallet store: ${loadFailure}`);
    cache = emptyFile();
    return cache;
  }
  if (current.file) {
    loadFailure = null;
    cache = current.file;
    return cache;
  }
  // No wallets.json. A pre-multi-wallet install may still have the old
  // single-wallet file to migrate across.
  const legacy = readWalletsFile(legacyFile());
  if (!legacy.ok) {
    loadFailure = `${legacy.why}. The app will not write over it.`;
    logger.error(`wallet store: ${loadFailure}`);
    cache = emptyFile();
    return cache;
  }
  if (legacy.file) {
    loadFailure = null;
    cache = legacy.file;
    persist(cache);
    return cache;
  }
  loadFailure = null;
  cache = emptyFile();
  return cache;
}

/** The wallet that signs. Everything in this module works on this one. */
function load(): StoredWallet | null {
  return activeWallet(loadFile());
}

function persist(f: WalletsFile): void {
  // Never write over a file we failed to read: that is how keys are lost.
  if (loadFailure) throw new Error(`refusing to write wallets.json — ${loadFailure}`);
  writeDurable(file(), JSON.stringify(f, null, 2), { backup: true });
  cache = f;
}

/** A refusal every mutating entry point returns while the file is unreadable. */
function blockedByFailure(): { ok: false; message: string } | null {
  loadFile();
  return loadFailure ? { ok: false, message: `Wallet file unavailable — ${loadFailure}` } : null;
}

/** Apply a store transition and write it out. */
function commit(result: { file: WalletsFile; ok: boolean; message: string }): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  if (result.ok) persist(result.file);
  return { ok: result.ok, message: result.message };
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

/** Decrypt the secret transiently. Callers must not persist or log it. */
function decryptSecret(w: StoredWallet): Uint8Array {
  if (vault.isSealed(w.secretEnc)) return new Uint8Array(vault.open('solana', w.id, w.publicKey, w.secretEnc));
  const refused = vault.cannotOpen(w.secretEnc);
  if (refused) throw new Error(refused);
  return fromHex(safeStorage.decryptString(Buffer.from(w.secretEnc, 'base64')));
}

function encryptForOs(secret: Uint8Array): string {
  return safeStorage.encryptString(toHex(secret)).toString('base64');
}

/** The stored form of a new wallet's key, under the password when it is on. */
function protect(secret: Uint8Array, id: string, publicKey: string): { secretEnc: string; mac?: string } {
  if (!vault.sealsNewRecords()) return { secretEnc: encryptForOs(secret) };
  return { secretEnc: vault.seal('solana', id, publicKey, 'hot', secret), mac: vault.macFor(id, publicKey, null) };
}

/** Why a new key cannot be stored right now, or null. */
function cannotStore(): string | null {
  if (!encAvailable()) return 'OS secure storage is unavailable — refusing to store a key unencrypted.';
  if (vault.isLocked()) return 'Your wallet is locked. Unlock it first.';
  return null;
}

/** Why the signing wallet cannot sign, in the user's words, or null. The engine
 *  asks this before anything is built, so a locked app is a stated reason and
 *  not a run of failed trades. */
export function lockReason(): string | null {
  const w = load();
  if (!w) return vault.isLocked() ? 'Your wallet is locked. Type your wallet password to trade or send.' : null;
  const refused = vault.cannotSignUnattended(w.secretEnc);
  if (refused) return refused;
  // Said up front, or Live reads as on while every trade and exit fails at signing.
  return detailsOk(w) ? null : detailsRefusal(w.label);
}

function detailsRefusal(label: string): string {
  return `The details of ${label} were changed outside Krypto Mirror, so it will not sign. Check its withdrawal address. If you changed nothing, an older version of the app may have saved it: turn the wallet password off and on to sign it again.`;
}

/** Can this wallet sign now, without anyone typing anything? */
export function canSignUnattended(walletId: string): boolean {
  const w = loadFile().wallets.find((x) => x.id === walletId);
  return Boolean(w) && vault.cannotSignUnattended(w!.secretEnc) === null;
}

/** Labels of the wallets whose key cannot be opened and matched to its address. */
export function unreadable(): string[] {
  return loadFile()
    .wallets.filter((w) => {
      try {
        const secret = decryptSecret(w);
        const pub = base58Encode(ed25519.getPublicKey(secret));
        secret.fill(0);
        return pub !== w.publicKey;
      } catch {
        return true;
      }
    })
    .map((w) => w.label);
}

/** Is the record's withdrawal address the one this app stored? True with the
 *  password off, when there is nothing to check it against. */
function detailsOk(w: StoredWallet): boolean {
  if (vault.isLocked()) return true;
  // A plain record in a protected store is not one this app wrote.
  if (!vault.isSealed(w.secretEnc)) return !(vault.isOn() && vault.migrating() === null);
  return vault.macOk(w.id, w.publicKey, w.homeAddress, w.mac);
}

/** Wallets whose details were edited outside the app. They will not sign. */
export function tampered(): string[] {
  return loadFile().wallets.filter((w) => !detailsOk(w)).map((w) => w.label);
}

/** May money be moved to this address as "your own wallet"? */
export function isTrusted(publicKey: string): boolean {
  const w = loadFile().wallets.find((x) => x.publicKey === publicKey);
  return Boolean(w) && detailsOk(w!);
}

/** One row per wallet, for the password settings. */
export function vaultRows(): { id: string; label: string; address: string; enc: string; active: boolean }[] {
  const f = loadFile();
  return f.wallets.map((w) => ({ id: w.id, label: w.label, address: w.publicKey, enc: w.secretEnc, active: w.id === f.activeId }));
}

/** Write a re-encrypted store and check every key back from the disk before the
 *  old file goes, and leave no copy of the old form in the .bak. */
function writeRewrapped(next: WalletsFile): void {
  const text = JSON.stringify(next, null, 2);
  writeDurable(file(), text, {
    verify: (written) => {
      const parsed = parseFile(JSON.parse(written), Date.now(), newId);
      if (!parsed || parsed.wallets.length !== next.wallets.length) throw new Error('the rewritten wallet file did not read back');
      for (const w of parsed.wallets) {
        const secret = decryptSecret(w);
        const pub = base58Encode(ed25519.getPublicKey(secret));
        secret.fill(0);
        if (pub !== w.publicKey) throw new Error(`${w.label}: the rewritten key does not match its address`);
      }
    },
  });
  writeDurable(`${file()}.bak`, text);
  cache = next;
}

/** Move every key to the password (or back to the OS store). A record already in
 *  the right form is left alone, so an interrupted run resumes where it stopped.
 *  The caller holds the cold key. */
export function rewrapAll(to: 'sealed' | 'os'): number {
  const blocked = blockedByFailure();
  if (blocked) throw new Error(blocked.message);
  const f = loadFile();
  let changedCount = 0;
  const wallets = f.wallets.map((w) => {
    const sealed = vault.isSealed(w.secretEnc);
    // A sealed record is left as it is. One with no signature on its details was
    // edited, and signing it here would launder the edit.
    if ((to === 'sealed') === sealed) return w;
    const secret = decryptSecret(w);
    try {
      if (base58Encode(ed25519.getPublicKey(secret)) !== w.publicKey) throw new Error(`${w.label}: the stored key does not match its address`);
      changedCount += 1;
      if (to === 'os') {
        const { mac: _drop, ...rest } = w;
        return { ...rest, secretEnc: encryptForOs(secret) };
      }
      return {
        ...w,
        secretEnc: vault.seal('solana', w.id, w.publicKey, 'hot', secret),
        mac: vault.macFor(w.id, w.publicKey, w.homeAddress),
      };
    } finally {
      secret.fill(0);
    }
  });
  writeRewrapped({ ...f, wallets });
  // Older installs carry a second copy of the first key in the old form. It
  // stays useful only until the protected file above is proven good.
  if (to === 'sealed') scrub(legacyFile());
  return changedCount;
}

function scrub(p: string): void {
  try {
    const size = fs.statSync(p).size;
    fs.writeFileSync(p, Buffer.alloc(size));
    fs.rmSync(p);
  } catch (err) {
    // Absent is the normal case. Anything else leaves the old key on disk.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn(`wallet: could not remove the old wallet file, retrying at the next unlock: ${(err as Error).message}`);
  }
}

/** Retried at each unlock: antivirus or a sync client can hold the file once. */
export function scrubLegacy(): void {
  if (vault.isOn() && vault.migrating() === null) scrub(legacyFile());
}

/** Make a wallet hot or cold. The caller holds the cold key. */
export function setScope(id: string, scope: 'hot' | 'cold'): void {
  const f = loadFile();
  const wallets = f.wallets.map((w) => {
    if (w.id !== id) return w;
    const secret = decryptSecret(w);
    try {
      return { ...w, secretEnc: vault.seal('solana', w.id, w.publicKey, scope, secret) };
    } finally {
      secret.fill(0);
    }
  });
  const next = { ...f, wallets };
  // The copy first: a crash in between must not leave a hot copy of a savings key.
  writeDurable(`${file()}.bak`, JSON.stringify(next, null, 2));
  writeRewrapped(next);
}

export function exists(): boolean {
  return load() !== null;
}

export function info(): WalletInfo {
  const w = load();
  const bal = w ? balances.get(w.publicKey) : undefined;
  return {
    exists: w !== null,
    publicKey: w?.publicKey ?? null,
    homeAddress: w?.homeAddress ?? null,
    balanceSol: bal ? bal.lamports / LAMPORTS_PER_SOL : null,
    balanceCheckedAt: bal?.at ?? null,
    maxBalanceSol: w?.maxBalanceSol ?? DEFAULT_MAX_BALANCE_SOL,
    encryptionAvailable: encAvailable(),
    createdAt: w?.createdAt ?? null,
    id: w?.id ?? null,
    label: w?.label ?? null,
    walletCount: loadFile().wallets.length,
  };
}

/** Every wallet held, for the switcher. Public data only — no ciphertext. */
export function list(): WalletSummary[] {
  const f = loadFile();
  return f.wallets.map((w) => {
    const bal = balances.get(w.publicKey);
    return {
      id: w.id,
      label: w.label,
      publicKey: w.publicKey,
      active: w.id === f.activeId,
      balanceSol: bal ? bal.lamports / LAMPORTS_PER_SOL : null,
      balanceCheckedAt: bal?.at ?? null,
      maxBalanceSol: w.maxBalanceSol,
      homeAddress: w.homeAddress,
      createdAt: w.createdAt,
    };
  });
}

/**
 * Generate a fresh trading wallet and ADD it to the list.
 *
 * It does not become active unless it is the first — switching the signer is
 * always an explicit act, never a side effect of creating a key.
 */
export function generate(label = ''): { ok: boolean; message: string; publicKey?: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const cannot = cannotStore();
  if (cannot) return { ok: false, message: cannot };
  const f = loadFile();
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  const publicKey = base58Encode(pub);
  const id = newId();
  const res = addWallet(f, {
    id,
    label: label ? cleanLabel(label, f.wallets.length + 1) : nextLabel(f),
    publicKey,
    ...protect(secret, id, publicKey),
    homeAddress: null,
    maxBalanceSol: DEFAULT_MAX_BALANCE_SOL,
    createdAt: Date.now(),
  });
  // Best-effort scrub of the plaintext secret from this frame.
  secret.fill(0);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return { ok: true, message: 'Trading wallet generated', publicKey };
}

/** Import an existing 32-byte seed or 64-byte keypair (advanced). */
export function importSecret(input: string, label = ''): { ok: boolean; message: string; publicKey?: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const cannot = cannotStore();
  if (cannot) return { ok: false, message: cannot };
  let secret: Uint8Array;
  try {
    const trimmed = input.trim();
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed) as number[];
      secret = new Uint8Array(arr).slice(0, 32); // seed portion of a 64-byte keypair
    } else {
      const bytes = base58Decode(trimmed);
      secret = bytes.length >= 64 ? bytes.slice(0, 32) : bytes;
    }
    if (secret.length !== 32) return { ok: false, message: 'Key must be a 32-byte seed or 64-byte keypair.' };
  } catch {
    return { ok: false, message: 'Could not parse key (expect base58 or a JSON byte array).' };
  }
  const publicKey = base58Encode(ed25519.getPublicKey(secret));
  const f = loadFile();
  const id = newId();
  const res = addWallet(f, {
    id,
    label: label ? cleanLabel(label, f.wallets.length + 1) : nextLabel(f),
    publicKey,
    ...protect(secret, id, publicKey),
    homeAddress: null,
    maxBalanceSol: DEFAULT_MAX_BALANCE_SOL,
    createdAt: Date.now(),
  });
  secret.fill(0);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return { ok: true, message: 'Wallet imported', publicKey };
}

/**
 * The All-in-One wallet's Solana key: add it, or find it when it is already
 * held (someone importing the phrase of a wallet they imported before by
 * its key). Never changes who signs — `addWallet`'s first-wallet rule aside.
 * The seed is the caller's to scrub.
 */
export function ensureFromSeed(seed: Uint8Array, label: string): { ok: boolean; message: string; id?: string; publicKey?: string; existed?: boolean } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const cannot = cannotStore();
  if (cannot) return { ok: false, message: cannot };
  if (seed.length !== 32) return { ok: false, message: 'internal: a Solana seed is 32 bytes' };
  const publicKey = base58Encode(ed25519.getPublicKey(seed));
  const f = loadFile();
  const held = f.wallets.find((w) => w.publicKey === publicKey);
  if (held) return { ok: true, message: `${held.label} is already in your wallet list`, id: held.id, publicKey, existed: true };
  const id = newId();
  const res = addWallet(f, {
    id,
    label: cleanLabel(label, f.wallets.length + 1),
    publicKey,
    ...protect(seed, id, publicKey),
    homeAddress: null,
    maxBalanceSol: DEFAULT_MAX_BALANCE_SOL,
    createdAt: Date.now(),
  });
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return { ok: true, message: 'Wallet added', id, publicKey, existed: false };
}

/** Make a held wallet the signer. */
export function select(id: string): { ok: boolean; message: string } {
  // The active wallet signs unattended, so it cannot be one that needs typing for.
  const target = loadFile().wallets.find((w) => w.id === id);
  if (target && vault.isSealed(target.secretEnc) && vault.scopeOf(target.secretEnc) === 'cold') {
    return { ok: false, message: `${target.label} is a savings wallet. Turn on "Can auto-trade" for it in Settings first.` };
  }
  return commit(selectWallet(loadFile(), id));
}

/** Several wallets in one go (Wallet Lab). Stops at the first refusal. */
export function generateMany(count: number, labelPrefix: string): { ok: boolean; message: string; created: number; ids: string[] } {
  const blocked = blockedByFailure();
  if (blocked) return { ...blocked, created: 0, ids: [] };
  const n = Math.max(1, Math.min(MAX_WALLETS, Math.floor(count)));
  const ids: string[] = [];
  const before = new Set(loadFile().wallets.map((w) => w.id));
  for (let i = 0; i < n; i++) {
    const label = labelPrefix.trim() ? `${labelPrefix.trim()} ${i + 1}` : '';
    const r = generate(label);
    if (!r.ok) break;
  }
  for (const w of loadFile().wallets) if (!before.has(w.id)) ids.push(w.id);
  const created = ids.length;
  if (created < n) return { ok: created > 0, message: `${created} of ${n} created`, created, ids };
  return { ok: true, message: `${created} wallet(s) created`, created, ids };
}

export function rename(id: string, label: string): { ok: boolean; message: string } {
  return commit(renameInStore(loadFile(), id, label));
}

export function setHomeAddress(addr: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  const trimmed = addr.trim();
  try {
    if (base58Decode(trimmed).length !== 32) throw new Error('bad length');
  } catch {
    return { ok: false, message: 'Not a valid Solana address' };
  }
  let mac: string | undefined;
  if (vault.isSealed(w.secretEnc)) {
    // Signed under the password, so an edit to the file alone will not sign.
    if (vault.isLocked()) return { ok: false, message: 'Your wallet is locked. Unlock it first.' };
    mac = vault.macFor(w.id, w.publicKey, trimmed);
  }
  const res = patchActive(loadFile(), { homeAddress: trimmed, ...(mac ? { mac } : {}) });
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: 'Withdrawal address saved' };
}

export function setMaxBalance(sol: number): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  if (!(sol >= 0) || sol > 100) return { ok: false, message: 'Cap must be between 0 (no warning) and 100 SOL' };
  const res = patchActive(loadFile(), { maxBalanceSol: sol });
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: 'Balance cap updated' };
}

/**
 * Record a balance the ENGINE already read from chain. `info()` answers from
 * this cache, and until 2026-09-02 only the Wallet page's own poll filled it
 * — so a token page opened first saw `balanceSol: null` and the trade panel
 * called a funded wallet "no SOL". The engine reads the balance at arm and
 * on its timers; those reads now land here too.
 */
export function noteBalance(publicKey: string, lamports: number): void {
  if (!publicKey || !Number.isFinite(lamports) || lamports < 0) return;
  balances.set(publicKey, { lamports, at: Date.now() });
}

/** The last balance read for this address, while it is younger than maxAgeMs. */
export function cachedBalance(publicKey: string, maxAgeMs: number): number | null {
  const b = balances.get(publicKey);
  return b && Date.now() - b.at < maxAgeMs ? b.lamports : null;
}

/** A settled fill moved this address's balance by this much. */
export function adjustBalance(publicKey: string, deltaLamports: number): void {
  const b = balances.get(publicKey);
  if (b) b.lamports = Math.max(0, b.lamports + deltaLamports);
}

export async function refreshBalance(httpUrl: string): Promise<{ ok: boolean; message: string; balanceSol?: number }> {
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  const r = await getBalance(httpUrl, w.publicKey);
  if (!r.ok || r.data === undefined) return { ok: false, message: r.message };
  balances.set(w.publicKey, { lamports: r.data, at: Date.now() });
  return { ok: true, message: 'ok', balanceSol: r.data / LAMPORTS_PER_SOL };
}

/** Write a Solana-compatible keypair JSON (64-byte array) to a path the user
 *  chose, so they can recover the wallet in any Solana wallet. This is the
 *  ONLY path the secret leaves the app, straight to a file the user picked —
 *  never through the renderer or a log. */
/**
 * Export every wallet to a plain text file, as base58 private keys.
 *
 * base58 of the 64-byte secret key is the format Phantom, Solflare and Backpack
 * accept under "Import Private Key" — so this is the "get my keys out and into
 * a normal wallet" path, as opposed to backupToFile's Solana-CLI JSON array.
 *
 * This writes SECRET KEYS IN PLAINTEXT by design — that is the whole point of an
 * export — so the file leads with a warning and the caller confirms first.
 */
export function exportAllToFile(destPath: string): { ok: boolean; message: string; count: number } {
  const file = loadFile();
  if (!file.wallets.length) return { ok: false, message: 'No wallets to export', count: 0 };
  const lines: string[] = [
    'Krypto Mirror — wallet export',
    '',
    '!!! PRIVATE KEYS IN PLAINTEXT !!!',
    'Anyone with this file can spend these wallets. Keep it offline, never share',
    'it, and delete it once you have imported the keys. Krypt cannot recover a',
    'key that leaks.',
    '',
    'To import into Phantom / Solflare / Backpack: Add wallet -> Import Private',
    'Key -> paste the "Private key" line below.',
    '',
    '='.repeat(64),
    '',
  ];
  let count = 0;
  const secrets: Uint8Array[] = [];
  try {
    for (const w of file.wallets) {
      const secret = decryptSecret(w);
      secrets.push(secret);
      const pub = base58Decode(w.publicKey);
      const keypair = new Uint8Array(64);
      keypair.set(secret, 0);
      keypair.set(pub, 32);
      lines.push(`[${w.label}]`);
      lines.push(`Public key:  ${w.publicKey}`);
      lines.push(`Private key: ${base58Encode(keypair)}`);
      lines.push('');
      keypair.fill(0);
      count += 1;
    }
    // Plain-text keys: owner-only, as the EVM export writes them.
    fs.writeFileSync(destPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, message: `Exported ${count} wallet(s) to ${destPath}`, count };
  } catch (err) {
    return { ok: false, message: `Export failed: ${(err as Error).message}`, count: 0 };
  } finally {
    for (const s of secrets) s.fill(0);
  }
}

export function backupToFile(destPath: string): { ok: boolean; message: string } {
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  try {
    const secret = decryptSecret(w);
    const pub = base58Decode(w.publicKey);
    const keypair = new Uint8Array(64);
    keypair.set(secret, 0);
    keypair.set(pub, 32);
    fs.writeFileSync(destPath, JSON.stringify(Array.from(keypair)), { encoding: 'utf8', mode: 0o600 });
    secret.fill(0);
    keypair.fill(0);
    return { ok: true, message: `Backed up to ${destPath}` };
  } catch (err) {
    return { ok: false, message: `Backup failed: ${(err as Error).message}` };
  }
}

/**
 * Sign a serialized (unsigned) VersionedTransaction and return the signed
 * bytes. This is the ONLY place the secret is used to sign. It decrypts
 * transiently, signs, scrubs, and returns only the signed transaction —
 * the key never leaves this function or reaches the renderer.
 *
 * The policy is enforced here, independently of whatever the caller already
 * checked: this function is the last gate before a signature exists.
 */
/** Sign with the ACTIVE wallet — the single-trade path, unchanged. */
// ── Sends the user confirmed (2026-10-03) ──────────────────────────────
//
// A send pays an address the user TYPED, so the signer cannot check it
// against anything it stores. Instead the IPC handler, after the native
// dialog showed the exact address and amount, files an approval here; the
// signer looks it up by id, checks the bytes against it, and spends it. One
// approval signs one transaction, for one wallet, within SEND_APPROVAL_TTL_MS.
// Nothing outside the main process can reach this map.

const SEND_APPROVAL_TTL_MS = 120_000;
const sendApprovals = new Map<string, ApprovedSend & { wallet: string; expiresAt: number }>();

/** File an approval for one send from `walletPublicKey`. Main process only,
 *  and only after the native confirmation. Returns the id a policy names. */
export function approveSend(walletPublicKey: string, approved: ApprovedSend): string {
  const now = Date.now();
  for (const [k, v] of sendApprovals) if (v.expiresAt <= now) sendApprovals.delete(k);
  const id = `send_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  sendApprovals.set(id, { ...approved, wallet: walletPublicKey, expiresAt: now + SEND_APPROVAL_TTL_MS });
  return id;
}

/** Spend an approval: gone after this call whatever the outcome. */
function takeSendApproval(id: string | undefined, walletPublicKey: string): ApprovedSend | null {
  if (!id) return null;
  const a = sendApprovals.get(id);
  sendApprovals.delete(id);
  if (!a || a.expiresAt <= Date.now() || a.wallet !== walletPublicKey) return null;
  return { to: a.to, mint: a.mint, tokenProgram: a.tokenProgram, maxAmount: a.maxAmount };
}

export function signVersionedTransaction(
  unsignedTx: Uint8Array,
  policy: SignPolicy,
): { ok: boolean; message: string; signed?: Uint8Array } {
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  return signWith(w, unsignedTx, policy);
}

/**
 * Sign with a SPECIFIC wallet by id — the fan-out path, where several wallets
 * each buy the same token. Every wallet still goes through the exact same
 * outflow validation and fee-payer check as the active-wallet path; a fan-out
 * gets no shortcut around the signer's safety.
 */
export function signVersionedTransactionForWallet(
  walletId: string,
  unsignedTx: Uint8Array,
  policy: SignPolicy,
): { ok: boolean; message: string; signed?: Uint8Array } {
  const w = loadFile().wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, message: 'No such wallet' };
  return signWith(w, unsignedTx, policy);
}

/**
 * Sign a LAUNCH: this wallet plus the new mint, and nothing else.
 *
 * Separate from the trade paths so the two-signer exception has exactly one
 * door, and that door needs the mint secret to open. A caller that does not
 * hold a freshly generated mint keypair cannot produce a two-signer signature
 * through this module at all.
 */
export function signLaunchForWallet(
  walletId: string,
  unsignedTx: Uint8Array,
  policy: SignPolicy,
  launchMintSecret: Uint8Array,
): { ok: boolean; message: string; signed?: Uint8Array } {
  if (policy.intent !== 'launch') return { ok: false, message: 'signLaunchForWallet requires the launch intent' };
  const w = loadFile().wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, message: 'No such wallet' };
  return signWith(w, unsignedTx, policy, launchMintSecret);
}

/**
 * Sign pump.fun's login message with a wallet this app holds.
 *
 * ─── Why this takes a NUMBER and not bytes ──────────────────────────────
 *
 * Every other door in this module signs a TRANSACTION, which `checkOutflow`
 * decodes and validates before the key is decrypted. A login message is not a
 * transaction, so none of that machinery applies — which makes it exactly the
 * shape that must never become a general "sign these bytes" call. That is the
 * primitive wallet phishing runs on, and it would sit here beside keys holding
 * real positions.
 *
 * So the caller cannot supply the message. It passes a wallet id and a
 * timestamp, and the string is built HERE from the shared template. There is
 * no parameter through which arbitrary bytes can reach a signature — a
 * property of the shape, not of a check someone has to remember.
 *
 * The message is returned alongside the signature so the caller can log what
 * was actually signed without ever being able to choose it.
 */
export function signPumpLogin(
  walletId: string,
  timestamp: number,
): { ok: boolean; message: string; signature?: string; address?: string; signed?: string } {
  const built = pumpLoginMessage(timestamp);
  if (!built) {
    // The template is not known yet (see shared/pumpAuth.ts). Refusing beats
    // signing a guess that pump would reject as OUR signature being bad.
    return { ok: false, message: 'The pump.fun sign-in message is not known in this build yet' };
  }
  const w = loadFile().wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, message: 'No such wallet' };
  const refused = vault.cannotOpen(w.secretEnc);
  if (refused) return { ok: false, message: refused };
  let secret: Uint8Array | null = null;
  try {
    secret = decryptSecret(w);
    const kp = Keypair.fromSeed(secret);
    if (kp.publicKey.toBase58() !== w.publicKey) return { ok: false, message: 'Key mismatch — refusing to sign' };
    const sig = ed25519.sign(new TextEncoder().encode(built), secret);
    return { ok: true, message: 'signed', signature: base58Encode(sig), address: w.publicKey, signed: built };
  } catch (err) {
    return { ok: false, message: `Signing failed: ${(err as Error).message}` };
  } finally {
    if (secret) secret.fill(0);
  }
}

/** Public key of a specific wallet by id, for building that wallet's tx. */
export function publicKeyOf(walletId: string): string | null {
  return loadFile().wallets.find((x) => x.id === walletId)?.publicKey ?? null;
}

function signWith(
  w: StoredWallet,
  unsignedTx: Uint8Array,
  policy: SignPolicy,
  /**
   * The launch mint's secret, supplied ONLY by signLaunchForWallet.
   *
   * It is a parameter rather than a field on SignPolicy on purpose: a policy
   * is a description that gets logged, compared and passed around, and a
   * secret has no business in one. It lives for the microseconds between
   * generation and signature and is zeroed in the finally below.
   */
  launchMintSecret?: Uint8Array,
): { ok: boolean; message: string; signed?: Uint8Array } {
  let secret: Uint8Array | null = null;
  let kp: Keypair | null = null;
  // Before anything else, and before a send approval is spent: nothing about
  // this transaction matters if the key cannot be opened.
  const refused = vault.cannotOpen(w.secretEnc);
  if (refused) return { ok: false, message: refused };
  if (!detailsOk(w)) {
    return { ok: false, message: `The details of ${w.label} were changed outside Krypto Mirror, so it will not sign. Check its withdrawal address.` };
  }
  try {
    const tx = VersionedTransaction.deserialize(unsignedTx);
    // The tx must require exactly our signature as fee payer.
    const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
    if (feePayer !== w.publicKey) {
      return { ok: false, message: 'Transaction fee payer is not this wallet — refusing to sign' };
    }
    // A launch is the one shape with a second signer, and it can only arrive
    // through signLaunchForWallet — which is the only caller that can supply
    // the mint secret. Without it, intent 'launch' is unreachable here and the
    // original rule applies untouched.
    const launching = policy.intent === 'launch' && launchMintSecret !== undefined;
    if (policy.intent === 'launch' && !launching) {
      return { ok: false, message: 'A launch must be signed through the launch path — refusing to sign' };
    }
    if (!launching && tx.message.header.numRequiredSignatures !== 1) {
      return { ok: false, message: `Transaction needs ${tx.message.header.numRequiredSignatures} signers — refusing (expect 1)` };
    }
    // Decode-and-revalidate BEFORE the key is ever decrypted.
    // A send's destination comes from the approval store, never the caller.
    const approved = policy.intent === 'send' || policy.intent === 'send-token' ? takeSendApproval(policy.sendApprovalId, w.publicKey) : null;
    const outflow = checkOutflow(tx, w.publicKey, w.homeAddress, policy, approved);
    if (!outflow.ok) return { ok: false, message: outflow.message };

    secret = decryptSecret(w);
    kp = Keypair.fromSeed(secret);
    // Sanity: the derived signer must match the stored public key.
    if (kp.publicKey.toBase58() !== w.publicKey) {
      return { ok: false, message: 'Key mismatch — refusing to sign' };
    }
    if (launching) {
      // Both signatures, in one call: ours as fee payer, the mint's for
      // itself. checkOutflow has already proved slot 1 IS this mint.
      const mintKp = Keypair.fromSecretKey(launchMintSecret);
      if (mintKp.publicKey.toBase58() !== policy.launchMint) {
        return { ok: false, message: 'Launch mint key does not match the mint the policy named — refusing to sign' };
      }
      tx.sign([kp, mintKp]);
    } else {
      tx.sign([kp]);
    }
    return { ok: true, message: 'signed', signed: tx.serialize() };
  } catch (err) {
    return { ok: false, message: `Signing failed: ${(err as Error).message}` };
  } finally {
    if (secret) secret.fill(0);
    // Keypair holds the secret internally; drop the reference for GC.
    kp = null;
  }
}


/** The trading wallet's public key, or null. */
export function publicKey(): string | null {
  return load()?.publicKey ?? null;
}

/**
 * Delete one wallet (after the user has backed it up).
 *
 * With no id, the ACTIVE wallet goes — which is what the single-wallet
 * button always did. Removing the active one promotes another rather than
 * leaving the app with a dangling signer (see walletStore.healActive).
 */
export function remove(id?: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const f = loadFile();
  const targetId = id ?? f.activeId;
  if (!targetId) return { ok: false, message: 'No wallet' };
  const target = f.wallets.find((w) => w.id === targetId);
  const res = removeFromStore(f, targetId);
  if (!res.ok) return { ok: false, message: res.message };
  // The signer signs unattended, so it should not fall to a savings wallet while
  // another wallet could do it.
  const active = res.file.wallets.find((w) => w.id === res.file.activeId);
  if (active && vault.scopeOf(active.secretEnc) === 'cold') {
    const hot = res.file.wallets.filter((w) => vault.scopeOf(w.secretEnc) !== 'cold').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (hot) res.file.activeId = hot.id;
  }
  persist(res.file);
  // Removed means removed: the backup copy just taken still holds this key.
  writeDurable(`${file()}.bak`, fs.readFileSync(file(), 'utf8'));
  if (target) balances.delete(target.publicKey);
  if (!res.file.wallets.length) {
    // An EMPTY v2 file is written, never deleted.
    //
    // The legacy `wallet.json` is kept on purpose (it holds a copy of a key),
    // and `loadFile` falls back to it whenever the current file is missing or
    // unreadable. Deleting the current file on the last removal would
    // therefore RESURRECT the migrated wallet on the next start — the user
    // removes their wallet, restarts, and it is back. An empty file parses
    // fine, so the fallback never fires and the removal sticks.
    balances = new Map();
    persist(res.file);
  }
  return { ok: true, message: res.message };
}
