// Profile continuity across the product rename (Krypt Terminal → Krypto
// Terminal, 2026-09-01).
//
// Electron derives userData from the product name — in BOTH packaged and
// dev runs (app.getName() reads `productName` from package.json). So the
// rename pointed every existing profile at a brand-new, empty folder: no
// wallet, no settings, terms un-accepted. The first shim looked for a
// `krypt-terminal` dev folder that never held anything and let exactly that
// happen on 2026-09-02 ("the fuck happened to my wallet").
//
// The rule now is about the WALLET, not the settings file: if the new folder
// has no wallets.json and a legacy folder does, use the legacy folder in
// place. Nothing is copied, moved or deleted — the DPAPI-bound wallet file
// stays where it has always been.
//
// Pure so it is unit-tested; main.ts feeds it fs.existsSync.

export const WALLET_FILE = 'wallets.json';
/** The settings file. A paper-first profile may never hold a wallet, yet hold
 *  a Helius key, the Scout's record and a pre-registered test (2026-10-25). */
export const SETTINGS_FILE = 'settings.json';

/**
 * Legacy profile folder names, most likely first.
 *
 * ONLY this app's own former name. 'Krypto Copy' was Krypto Mirror's name
 * from the fork (2026-10-22) until 2026-10-25, so that folder is this app's
 * own data and nobody else's. The names Krypto Bot inherited ('Krypto
 * Terminal', 'Krypt Terminal', …) are Krypto Bot's LIVE folders and must
 * never be listed: adopting one would make two apps sign from, and write to,
 * one wallets.json.
 */
export const LEGACY_PROFILE_NAMES: string[] = ['Krypto Copy'];

export interface ProfilePick {
  /** The folder the app should use. */
  dir: string;
  /** Non-null when the pick is a legacy folder — logged so a support thread
   *  can see which profile the app is on. */
  redirectedFrom: string | null;
}

export function pickUserDataDir(opts: {
  /** Electron's default (new-name) userData folder. */
  current: string;
  /** Candidate legacy folders, absolute, in preference order. */
  legacy: string[];
  /** fs.existsSync, injected. */
  exists: (p: string) => boolean;
  join: (...parts: string[]) => string;
}): ProfilePick {
  const { current, legacy, exists, join } = opts;
  const has = (dir: string, file: string) => exists(join(dir, file));
  // The wallet decides first, wherever it is.
  if (has(current, WALLET_FILE)) return { dir: current, redirectedFrom: null };
  for (const dir of legacy) {
    if (has(dir, WALLET_FILE)) return { dir, redirectedFrom: current };
  }
  // No wallet anywhere (paper-first, 2026-10-25): a folder that has been
  // used — it holds settings — is kept over a pristine new one. The new
  // folder has settings only once the app has run under the new name, so
  // this redirects on the first start after the rename and never after a
  // user has actually begun under the new folder.
  if (has(current, SETTINGS_FILE)) return { dir: current, redirectedFrom: null };
  for (const dir of legacy) {
    if (has(dir, SETTINGS_FILE)) return { dir, redirectedFrom: current };
  }
  return { dir: current, redirectedFrom: null };
}
