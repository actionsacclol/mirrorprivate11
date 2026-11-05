// The wallet password's cryptography. No Electron and no state, so every rule
// here runs in a plain test.
//
//   password --scrypt--> key that opens the root secret
//   root secret (20 random bytes, also shown once as the recovery key)
//     --HKDF--> hot key   stays in memory after the launch unlock, so copies sign
//     --HKDF--> cold key  exists only while the password has just been typed
//     --HKDF--> meta key  authenticates the withdrawal address and the file
//
// The GCM tag is the password check, so there is no password hash to attack.
// scrypt, not Argon2: Argon2 throws "not supported" in this Electron.

import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

export type RecordScope = 'hot' | 'cold';

export interface KdfParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
}

export interface SealedRoot {
  nonce: string;
  ct: string;
  tag: string;
}

export interface DerivedKeys {
  hot: crypto.KeyObject;
  cold: crypto.KeyObject;
  meta: crypto.KeyObject;
}

const ROOT_BYTES = 20;
const COST_N = 2 ** 18;
/** OWASP's floor. A vault file naming less was edited by something. */
const MIN_N = 2 ** 17;
const MAX_N = 2 ** 22;
const MAXMEM = 1024 * 1024 * 1024;

export function newRoot(): Buffer {
  return crypto.randomBytes(ROOT_BYTES);
}

export function newKdf(): KdfParams {
  return { alg: 'scrypt', N: COST_N, r: 8, p: 1, salt: crypto.randomBytes(16).toString('base64') };
}

/** Why these parameters must not be used, or null. */
export function kdfProblem(k: KdfParams): string | null {
  if (k?.alg !== 'scrypt') return 'unknown key derivation';
  if (!Number.isInteger(k.N) || k.N < MIN_N || k.N > MAX_N || (k.N & (k.N - 1)) !== 0) return 'key derivation cost out of range';
  if (k.r !== 8 || k.p !== 1) return 'key derivation settings out of range';
  if (typeof k.salt !== 'string' || Buffer.from(k.salt, 'base64').length !== 16) return 'bad salt';
  return null;
}

// In a worker, because scrypt stalled the main thread by over half a second when
// measured, and that thread also signs exits.
const WORKER_SOURCE = `
const { parentPort, workerData: d } = require('node:worker_threads');
const crypto = require('node:crypto');
crypto.scrypt(Buffer.from(d.pw), Buffer.from(d.salt), 32, { N: d.N, r: d.r, p: d.p, maxmem: d.maxmem }, (err, key) => {
  if (err) parentPort.postMessage({ error: err.message });
  else parentPort.postMessage({ key });
});
`;

function scryptInWorker(pw: Buffer, salt: Buffer, k: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { pw, salt, N: k.N, r: k.r, p: k.p, maxmem: MAXMEM } });
    w.once('message', (m: { key?: Uint8Array; error?: string }) => {
      void w.terminate();
      if (m.key) resolve(Buffer.from(m.key));
      else reject(new Error(m.error ?? 'scrypt failed'));
    });
    w.once('error', reject);
  });
}

function scryptOnPool(pw: Buffer, salt: Buffer, k: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function passwordKey(password: string, k: KdfParams): Promise<Buffer> {
  const problem = kdfProblem(k);
  if (problem) throw new Error(problem);
  // Normalised so the same password typed on another keyboard layout still works.
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  const salt = Buffer.from(k.salt, 'base64');
  try {
    return await scryptInWorker(pw, salt, k);
  } catch {
    // A worker may be refused in some packaged setups. The pool is slower to
    // start but gives the same key, and a wrong password must not look broken.
    return scryptOnPool(pw, salt, k);
  } finally {
    pw.fill(0);
  }
}

const rootAad = (k: KdfParams): Buffer => Buffer.from(`km/root|${k.alg}|${k.N}|${k.r}|${k.p}|${k.salt}`);

export function sealRoot(root: Buffer, key: Buffer, k: KdfParams): SealedRoot {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(rootAad(k));
  const ct = Buffer.concat([c.update(root), c.final()]);
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** Null is a wrong password, or a file that was edited: the two look the same. */
export function openRoot(s: SealedRoot, key: Buffer, k: KdfParams): Buffer | null {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.nonce, 'base64'));
    d.setAAD(rootAad(k));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]);
  } catch {
    return null;
  }
}

export function deriveKey(root: Buffer, info: 'hot' | 'cold' | 'meta'): crypto.KeyObject {
  return crypto.createSecretKey(Buffer.from(crypto.hkdfSync('sha256', root, 'krypto-mirror/vault/v1', info, 32)));
}

export function deriveKeys(root: Buffer): DerivedKeys {
  return { hot: deriveKey(root, 'hot'), cold: deriveKey(root, 'cold'), meta: deriveKey(root, 'meta') };
}

// ── Wallet records ────────────────────────────────────────────────────────
//
// A sealed record names its own scope, so a half-finished migration can resume
// by looking at each record. The scope, wallet and address are bound in as
// authenticated data: a record cannot be moved onto another wallet, and flipping
// "cold" to "hot" in the file makes it fail to open.

const PREFIX = 'kmv3';

export function isSealed(enc: unknown): enc is string {
  return typeof enc === 'string' && enc.startsWith(`${PREFIX}:`);
}

export function scopeOf(enc: string): RecordScope | null {
  const s = enc.split(':')[1];
  return s === 'hot' || s === 'cold' ? s : null;
}

const recordAad = (family: string, id: string, address: string, scope: RecordScope): Buffer =>
  Buffer.from(`km/v3|${family}|${id}|${address.toLowerCase()}|${scope}`);

export function sealRecord(key: crypto.KeyObject, family: string, id: string, address: string, scope: RecordScope, plain: Uint8Array): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(recordAad(family, id, address, scope));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [PREFIX, scope, nonce.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join(':');
}

export function openRecord(key: crypto.KeyObject, family: string, id: string, address: string, enc: string): Buffer {
  const [prefix, scope, nonce, ct, tag] = enc.split(':');
  if (prefix !== PREFIX || (scope !== 'hot' && scope !== 'cold')) throw new Error('not a sealed wallet record');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  d.setAAD(recordAad(family, id, address, scope));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
}

/** Authenticates what the signer trusts in the clear: the withdrawal address. */
export function walletMac(meta: crypto.KeyObject, id: string, publicKey: string, home: string | null): string {
  return crypto.createHmac('sha256', meta).update(`km/wallet|${id}|${publicKey}|${home ?? ''}`).digest('base64');
}

export function vaultMac(meta: crypto.KeyObject, k: KdfParams, migrating: string | null): string {
  return crypto.createHmac('sha256', meta).update(`km/vault|${k.N}|${k.r}|${k.p}|${k.salt}|${migrating ?? ''}`).digest('base64');
}

export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── The recovery key ──────────────────────────────────────────────────────
//
// It IS the root secret, in letters a person can copy by hand. No I, L, O or U,
// and reading them back forgives the obvious mix-ups.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function formatRecoveryKey(root: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of root) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

export function parseRecoveryKey(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (clean.length !== Math.ceil((ROOT_BYTES * 8) / 5)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return bytes.length === ROOT_BYTES ? Buffer.from(bytes) : null;
}

// ── Rules ─────────────────────────────────────────────────────────────────

const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'iloveyou', 'admin', 'welcome', 'monkey', 'dragon', 'football', 'baseball', 'krypto', 'krypt', 'mirror', 'solana', 'bitcoin', 'ethereum', 'phantom', 'wallet', 'abc', '123', '321', '000', '111'];

/** Why this password should not protect money, or null. Length first: a phrase
 *  of four unrelated words is stronger than a short password with symbols. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters. Four unrelated words work well.';
  if (password.length > 256) return 'That is too long. Use 256 characters or fewer.';
  let rest = password.toLowerCase();
  for (const word of COMMON) rest = rest.split(word).join('');
  if (new Set(rest.replace(/[^\p{L}\p{N}]/gu, '')).size < 5) return 'That is too easy to guess. Avoid common words and number runs.';
  return null;
}

const FREE_TRIES = 5;
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

/** How long to wait after this many wrong tries. Slows a person at the keyboard
 *  only: someone with the files can reset the count, so it is no defence against
 *  them, and keys are never wiped however many tries fail. */
export function retryDelayMs(fails: number): number {
  if (fails < FREE_TRIES) return 0;
  return Math.min(FIRST_DELAY_MS * 2 ** (fails - FREE_TRIES), MAX_DELAY_MS);
}
