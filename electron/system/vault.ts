// The wallet password's state: the password file and the keys held in memory.
//
// Nothing here prompts or touches a window, so the stores can import it and tests
// can run it. The three key stores call seal/open; system/vaultOps.ts changes the
// format; system/vaultFlows.ts talks to the person.
//
// What is in memory, and when:
//   locked    nothing
//   unlocked  the hot key and the meta key, for as long as the app runs
//   a gated action, or a change of format  the cold key too, for its duration
// The root secret itself is never kept. Node cannot promise memory is wiped, so
// the honest claim is only "savings wallets are not in memory while trading".

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type crypto from 'node:crypto';
import { writeDurable } from './durableFile';
import {
  deriveKey,
  deriveKeys,
  isSealed,
  macEqual,
  newKdf,
  openRecord,
  openRoot,
  passwordKey,
  retryDelayMs,
  scopeOf,
  sealRecord,
  sealRoot,
  vaultMac,
  walletMac,
  type KdfParams,
  type RecordScope,
  type SealedRoot,
} from './vaultCore';

export { isSealed, scopeOf } from './vaultCore';

export type Migrating = 'on' | 'off' | null;

interface VaultFile {
  v: 1;
  kdf: KdfParams;
  /** The sealed root, wrapped again by the OS store. A copied file alone cannot
   *  even be tried: the password only works where the OS key survives, which is
   *  why the recovery key is the one thing that travels. */
  pw: string;
  migrating: Migrating;
  attempts: { fails: number; notBefore: number };
  mac: string;
}

/** Every record in a store, so the vault can tell it is needed without knowing
 *  the stores: its file can be lost while their records are still encrypted. */
export interface SealedRecord {
  family: string;
  id: string;
  address: string;
  enc: string;
}
const stores: Array<() => SealedRecord[]> = [];
export function registerStore(records: () => SealedRecord[]): void {
  stores.push(records);
}
export function sealedRecords(): SealedRecord[] {
  return stores.flatMap((f) => f()).filter((r) => isSealed(r.enc));
}
function hasPlainRecords(): boolean {
  return stores.flatMap((f) => f()).some((r) => !isSealed(r.enc));
}

let cache: VaultFile | null | undefined;
let hot: crypto.KeyObject | null = null;
let meta: crypto.KeyObject | null = null;
let cold: crypto.KeyObject | null = null;
let coldHolds = 0;
let coldTimer: ReturnType<typeof setTimeout> | null = null;

const listeners: Array<() => void> = [];
export function onChange(fn: () => void): void {
  listeners.push(fn);
}
function changed(): void {
  for (const fn of listeners) fn();
}

const file = (): string => path.join(app.getPath('userData'), 'vault.json');

function parse(text: string): VaultFile | null {
  try {
    const o = JSON.parse(text) as Partial<VaultFile>;
    if (o.v !== 1 || !o.kdf || typeof o.pw !== 'string') return null;
    const a = o.attempts;
    return {
      v: 1,
      kdf: o.kdf,
      pw: o.pw,
      migrating: o.migrating === 'on' || o.migrating === 'off' ? o.migrating : null,
      attempts: { fails: typeof a?.fails === 'number' ? a.fails : 0, notBefore: typeof a?.notBefore === 'number' ? a.notBefore : 0 },
      mac: typeof o.mac === 'string' ? o.mac : '',
    };
  } catch {
    return null;
  }
}

function load(): VaultFile | null {
  if (cache !== undefined) return cache;
  for (const p of [file(), `${file()}.bak`]) {
    try {
      const parsed = parse(fs.readFileSync(p, 'utf8'));
      if (parsed) return (cache = parsed);
    } catch {
      /* absent or unreadable: try the next, then fall through */
    }
  }
  return (cache = null);
}

function save(next: VaultFile): void {
  const text = JSON.stringify(next, null, 2);
  writeDurable(file(), text);
  cache = next;
  // The file above is what counts. A stale copy only matters if it is later damaged.
  try {
    writeDurable(`${file()}.bak`, text);
  } catch {
    /* the next save tries again */
  }
}

function outerWrap(s: SealedRoot): string {
  return safeStorage.encryptString(JSON.stringify(s)).toString('base64');
}

function outerOpen(pw: string): SealedRoot | null {
  try {
    const o = JSON.parse(safeStorage.decryptString(Buffer.from(pw, 'base64'))) as SealedRoot;
    return typeof o.nonce === 'string' && typeof o.ct === 'string' && typeof o.tag === 'string' ? o : null;
  } catch {
    return null;
  }
}

// ── What state are we in ─────────────────────────────────────────────────

export function isOn(): boolean {
  return load() !== null || sealedRecords().length > 0;
}

export function isLocked(): boolean {
  return isOn() && hot === null;
}

/** New keys go in sealed. False while turning off, when they go back to the OS store. */
export function sealsNewRecords(): boolean {
  return isOn() && migrating() !== 'off';
}

export function migrating(): Migrating {
  return load()?.migrating ?? null;
}

/** Encrypted, but the password route is gone: no file, or an OS key that no
 *  longer opens it (a reinstall, a new machine). The recovery key still works. */
export function needsRecovery(): boolean {
  if (!isOn()) return false;
  const f = load();
  return !f || outerOpen(f.pw) === null;
}

const LOCKED = 'Your wallet is locked. Type your wallet password to trade or send.';
const SAVINGS = 'This is a savings wallet, so it signs only right after you type your password. Turn on "Can auto-trade" for it in Settings to trade from it.';

/** Why a record cannot be opened right now, in words, or null. */
export function cannotOpen(enc: string): string | null {
  if (isSealed(enc)) {
    if (!hot) return LOCKED;
    if (scopeOf(enc) === 'cold' && !cold) return SAVINGS;
    return null;
  }
  // Locked means no key opens, whatever a format change left behind. Every
  // migration path holds the root first, and the marker is unsigned until then.
  if (isOn() && !hot) return LOCKED;
  // A plain record in a protected store did not come from this app, unless a
  // format change is under way. Refused, so a store cannot be quietly downgraded.
  if (isOn() && migrating() === null) return 'This key is not protected by your wallet password, and this app did not store it that way. It will not be used.';
  return null;
}

// ── Records ──────────────────────────────────────────────────────────────

function keyFor(scope: RecordScope): crypto.KeyObject {
  const k = scope === 'hot' ? hot : cold;
  if (!k) throw new Error(scope === 'hot' ? LOCKED : SAVINGS);
  return k;
}

export function seal(family: string, id: string, address: string, scope: RecordScope, plain: Uint8Array): string {
  return sealRecord(keyFor(scope), family, id, address, scope, plain);
}

export function open(family: string, id: string, address: string, enc: string): Buffer {
  const scope = scopeOf(enc);
  if (!scope) throw new Error('This wallet record is damaged.');
  return openRecord(keyFor(scope), family, id, address, enc);
}

export function macFor(id: string, publicKey: string, home: string | null): string {
  if (!meta) throw new Error(LOCKED);
  return walletMac(meta, id, publicKey, home);
}

export function macOk(id: string, publicKey: string, home: string | null, mac: string | undefined): boolean {
  return Boolean(meta && mac && macEqual(walletMac(meta, id, publicKey, home), mac));
}

/** As above, for signing with nobody there. A savings wallet never qualifies, even
 *  in the moment a typed password has it open for some other action. */
export function cannotSignUnattended(enc: string): string | null {
  if (isSealed(enc) && scopeOf(enc) === 'cold') return SAVINGS;
  return cannotOpen(enc);
}

/** Both keys are on hand, so a record can change between hot and cold. */
export function coldIsOpen(): boolean {
  return cold !== null;
}

// ── Keys in memory ───────────────────────────────────────────────────────

const COLD_MAX_MS = 3 * 60_000;

function dropCold(): void {
  cold = null;
  coldHolds = 0;
  if (coldTimer) clearTimeout(coldTimer);
  coldTimer = null;
}

/** Take the root into use. With `holdCold` the cold key stays until releaseCold,
 *  capped so a dialog left open cannot leave it in memory all day. */
export function useRoot(root: Buffer, holdCold: boolean): void {
  const wasLocked = hot === null;
  hot = deriveKey(root, 'hot');
  meta = deriveKey(root, 'meta');
  if (holdCold) {
    cold = deriveKey(root, 'cold');
    coldHolds += 1;
    if (!coldTimer) {
      coldTimer = setTimeout(dropCold, COLD_MAX_MS);
      coldTimer.unref?.();
    }
  }
  if (wasLocked) changed();
}

export function releaseCold(): void {
  coldHolds -= 1;
  if (coldHolds <= 0) dropCold();
}

export function lock(): void {
  hot = null;
  meta = null;
  dropCold();
  changed();
}

/** Does this root open what is in the stores? The recovery key has nothing else
 *  to be checked against when the password file is gone. One record opening is
 *  proof, and has to be enough: a damaged wallet must not lock the owner out of
 *  all the others. */
export function rootOpensStores(root: Buffer): boolean {
  const keys = deriveKeys(root);
  const records = sealedRecords();
  if (records.length === 0) {
    const f = load();
    return Boolean(f && signedMigrating(keys.meta, f) !== undefined);
  }
  return records.some((r) => {
    try {
      openRecord(scopeOf(r.enc) === 'cold' ? keys.cold : keys.hot, r.family, r.id, r.address, r.enc);
      return true;
    } catch {
      return false;
    }
  });
}

// ── The password file ────────────────────────────────────────────────────

export async function writeNew(password: string, root: Buffer, nextMigrating: Migrating): Promise<void> {
  const kdf = newKdf();
  const key = await passwordKey(password, kdf);
  try {
    save({
      v: 1,
      kdf,
      pw: outerWrap(sealRoot(root, key, kdf)),
      migrating: nextMigrating,
      attempts: { fails: 0, notBefore: 0 },
      mac: vaultMac(deriveKeys(root).meta, kdf, nextMigrating),
    });
  } finally {
    key.fill(0);
  }
}

/** The change this root really marked as under way. The field itself is plain
 *  text that any program can edit, and it decides whether keys get re-encrypted,
 *  so only the value carrying the root's signature counts. Undefined: none does. */
function signedMigrating(metaKey: crypto.KeyObject, f: VaultFile): Migrating | undefined {
  const candidates: Migrating[] = [f.migrating, null, 'on', 'off'];
  return candidates.find((v) => macEqual(vaultMac(metaKey, f.kdf, v), f.mac));
}

/** What to resume, as far as this root can tell. With no signature to go on (the
 *  file is gone or damaged), a store in both forms was on its way to the password:
 *  finish that, because it can only add protection. */
export function authenticMigrating(root: Buffer): Migrating {
  const f = load();
  const signed = f ? signedMigrating(deriveKey(root, 'meta'), f) : undefined;
  if (signed !== undefined) return signed;
  return sealedRecords().length > 0 && hasPlainRecords() ? 'on' : null;
}

/** Undo any edit to the file's `migrating`. True if there was one to undo. */
export function restoreMigrating(root: Buffer): boolean {
  const f = load();
  if (!f) return false;
  const real = authenticMigrating(root);
  const mac = vaultMac(deriveKey(root, 'meta'), f.kdf, real);
  if (f.migrating === real && macEqual(mac, f.mac)) return false;
  save({ ...f, migrating: real, mac });
  return true;
}

export function setMigrating(next: Migrating): void {
  const f = load();
  if (!f) return;
  if (!meta) throw new Error(LOCKED);
  save({ ...f, migrating: next, mac: vaultMac(meta, f.kdf, next) });
  changed();
}

/** Did the password file's own settings survive unedited? Asked after an unlock. */
export function fileIsAuthentic(): boolean {
  const f = load();
  return Boolean(f && meta && macEqual(vaultMac(meta, f.kdf, f.migrating), f.mac));
}

/** Forget the password. Only once every record is back in the OS store. */
export function removeFile(): void {
  for (const p of [file(), `${file()}.bak`]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* the next isOn() reads what is really there */
    }
  }
  cache = null;
  hot = null;
  meta = null;
  dropCold();
  changed();
}

export type TryResult = { ok: true; root: Buffer } | { ok: false; message: string };

/** Check a password. The caller wipes `root` when it is finished with it. */
export async function tryPassword(password: string): Promise<TryResult> {
  const f = load();
  if (!f) return { ok: false, message: 'The password file is missing. Use your recovery key.' };
  const wait = f.attempts.notBefore - Date.now();
  // Past the longest delay this app ever sets: a wrong clock or an edit, not a wait.
  if (wait > 0 && wait <= retryDelayMs(50)) return { ok: false, message: `Too many wrong tries. Wait ${Math.ceil(wait / 1000)} seconds and try again.` };
  const sealed = outerOpen(f.pw);
  if (!sealed) return { ok: false, message: 'This computer can no longer open the password file. Use your recovery key.' };
  const key = await passwordKey(password, f.kdf);
  const root = openRoot(sealed, key, f.kdf);
  key.fill(0);
  if (root) {
    try {
      if (f.attempts.fails > 0) save({ ...f, attempts: { fails: 0, notBefore: 0 } });
    } catch {
      /* the right password still opens, whatever the disk is doing */
    }
    return { ok: true, root };
  }
  const fails = f.attempts.fails + 1;
  const delay = retryDelayMs(fails);
  save({ ...f, attempts: { fails, notBefore: delay ? Date.now() + delay : 0 } });
  return { ok: false, message: delay ? `That is not the password. Wait ${Math.ceil(delay / 1000)} seconds before trying again.` : 'That is not the password.' };
}
