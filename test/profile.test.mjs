// Profile continuity — the rename must never hide a wallet.
import assert from 'node:assert';
import { pickUserDataDir, LEGACY_PROFILE_NAMES, SETTINGS_FILE, WALLET_FILE } from './.profile.mjs';

const join = (...p) => p.join('/');
const fsOf = (present) => (p) => present.has(p);
const NEW = 'AppData/Krypto Terminal';
const OLD = 'AppData/Krypt Terminal';
const DEV = 'AppData/krypt-terminal';

{
  // The 2026-09-02 incident: new folder already has settings.json (the app
  // created it) but NO wallet; the old folder has the wallet.
  const exists = fsOf(new Set([`${NEW}/settings.json`, `${NEW}/legal-acceptance.jsonl`, `${OLD}/${WALLET_FILE}`, `${OLD}/settings.json`]));
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists, join });
  assert.equal(r.dir, OLD, 'the folder with the wallet wins even after the new one was created');
  assert.equal(r.redirectedFrom, NEW);
  console.log('ok  a wallet in the legacy folder beats a fresh new-name profile that has none');
}
{
  // Fresh install: nothing anywhere → the new folder.
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists: fsOf(new Set()), join });
  assert.equal(r.dir, NEW);
  assert.equal(r.redirectedFrom, null);
  console.log('ok  a fresh install uses the new folder');
}
{
  // Migrated by hand (or a later build that copies): the new folder has the
  // wallet → never bounce back to the old one.
  const exists = fsOf(new Set([`${NEW}/${WALLET_FILE}`, `${OLD}/${WALLET_FILE}`]));
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists, join });
  assert.equal(r.dir, NEW);
  console.log('ok  a wallet in the new folder keeps the new folder');
}
{
  // Legacy names are tried in order; the dev-style name is a fallback only.
  const exists = fsOf(new Set([`${DEV}/${WALLET_FILE}`]));
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists, join });
  assert.equal(r.dir, DEV);
  // Krypto Mirror adopts ITS OWN former folder (it was Krypto Copy from the
  // fork until 2026-10-25) and nobody else's: Krypto Bot's former names are
  // its live folders, and adopting one would put two apps on one wallets.json.
  assert.deepEqual(LEGACY_PROFILE_NAMES, ['Krypto Copy'], 'Krypto Mirror adopts only the Krypto Copy folder');
  for (const name of ['Krypto Bot', 'Krypto Terminal', 'Krypt Terminal', 'krypt-terminal', 'Krypt Sniper']) {
    assert.ok(!LEGACY_PROFILE_NAMES.includes(name), `${name} belongs to Krypto Bot`);
  }
  console.log('ok  legacy names are tried in preference order, and Krypto Mirror has only its own');
}
{
  // Paper-first (2026-10-25): a profile with settings and no wallet is still
  // a profile — the Helius key, the Scout's record, a pre-registered test.
  // First start after the rename: the new folder does not exist, the old one
  // holds settings → the old one. Once the new folder has its own settings,
  // it is kept, whatever the old one holds short of a wallet.
  const MIRROR = 'AppData/Krypto Mirror';
  const COPY = 'AppData/Krypto Copy';
  assert.equal(SETTINGS_FILE, 'settings.json');
  let r = pickUserDataDir({ current: MIRROR, legacy: [COPY], exists: fsOf(new Set([`${COPY}/${SETTINGS_FILE}`])), join });
  assert.deepEqual(r, { dir: COPY, redirectedFrom: MIRROR }, 'settings with no wallet anywhere: the used folder');
  r = pickUserDataDir({ current: MIRROR, legacy: [COPY], exists: fsOf(new Set([`${COPY}/${SETTINGS_FILE}`, `${MIRROR}/${SETTINGS_FILE}`])), join });
  assert.deepEqual(r, { dir: MIRROR, redirectedFrom: null }, 'both used: the new one, never a bounce back');
  r = pickUserDataDir({ current: MIRROR, legacy: [COPY], exists: fsOf(new Set([`${MIRROR}/${SETTINGS_FILE}`, `${COPY}/${WALLET_FILE}`])), join });
  assert.deepEqual(r, { dir: COPY, redirectedFrom: MIRROR }, 'a wallet still beats settings (the 2026-09-02 rule stands)');
  console.log('ok  without a wallet, a folder with settings is the profile; a pristine new folder does not hide it');
}
console.log('profile continuity: all tests passed');
