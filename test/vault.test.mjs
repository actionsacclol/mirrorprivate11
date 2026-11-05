// The wallet password, against the real stores and real files. Keys are the only
// copy of someone's money, so the cases that matter most are the ones where
// something goes wrong: a wrong password, an edited file, a crash part way through
// moving keys, a lost password file. The OS store is stubbed; everything else,
// including scrypt and AES-GCM, is the production code.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PW = 'correct horse battery staple';
const PW2 = 'another long passphrase here';
let gen = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const freshDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-vault-'));
  process.env.KRYPT_TEST_USERDATA = dir;
  return dir;
};
/** Everything re-imported from cold: an app restart, with nothing in memory. */
const restart = () => import(`./.vaultops.mjs?v=${gen++}`);
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const seedOf = (m) => m.wallet.list();
const signWallet = (m, id) => {
  // A transaction-free way to prove a key opens and matches: the login signature.
  const r = m.wallet.signPumpLogin(id, 1_700_000_000_000);
  return r;
};
const pumpOk = (r) => r.ok || /not known in this build/.test(r.message);

async function setUp(m, { evm = true } = {}) {
  const a = m.wallet.generate('Main');
  assert.equal(a.ok, true, a.message);
  const b = m.wallet.generate('Savings');
  assert.equal(b.ok, true, b.message);
  if (evm) assert.equal(m.evmWallet.generate('EVM').ok, true);
}

/** Decrypt under the stub, proving a store's record really is still the old form. */
const isOsForm = (enc) => !enc.startsWith('kmv3:');

test('core: wrong passwords and edited files do not open the root', async () => {
  const m = await restart();
  const c = m.core;
  const root = c.newRoot();
  const k = c.newKdf();
  const key = await c.passwordKey(PW, k);
  const sealed = c.sealRoot(root, key, k);
  assert.deepEqual(c.openRoot(sealed, key, k), root);
  assert.equal(c.openRoot(sealed, await c.passwordKey(PW2, k), k), null, 'wrong password');
  const tag = Buffer.from(sealed.tag, 'base64');
  tag[0] ^= 1;
  assert.equal(c.openRoot({ ...sealed, tag: tag.toString('base64') }, key, k), null, 'edited tag');
  assert.equal(c.openRoot(sealed, key, { ...k, salt: crypto.randomBytes(16).toString('base64') }), null, 'edited settings');
});

test('core: a lowered cost is refused before any work is done', async () => {
  const m = await restart();
  const k = m.core.newKdf();
  await assert.rejects(m.core.passwordKey(PW, { ...k, N: 2 ** 14 }), /out of range/);
  assert.equal(m.core.kdfProblem({ ...k, N: 2 ** 18 + 1 }) !== null, true, 'not a power of two');
  assert.equal(m.core.kdfProblem(k), null);
});

test('core: nonces are never reused, and records cannot be moved or relabelled', async () => {
  const m = await restart();
  const c = m.core;
  const keys = c.deriveKeys(c.newRoot());
  const plain = crypto.randomBytes(32);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(c.sealRecord(keys.hot, 'solana', 'id', 'addr', 'hot', plain).split(':')[2]);
  assert.equal(seen.size, 200);
  const enc = c.sealRecord(keys.cold, 'solana', 'id', 'addr', 'cold', plain);
  assert.deepEqual(c.openRecord(keys.cold, 'solana', 'id', 'addr', enc), plain);
  assert.throws(() => c.openRecord(keys.cold, 'solana', 'other', 'addr', enc), 'another wallet');
  assert.throws(() => c.openRecord(keys.cold, 'evm', 'id', 'addr', enc), 'another chain');
  assert.throws(() => c.openRecord(keys.hot, 'solana', 'id', 'addr', enc), 'the hot key does not open a cold record');
  assert.throws(() => c.openRecord(keys.cold, 'solana', 'id', 'addr', enc.replace(':cold:', ':hot:')), 'flipping the label');
});

test('core: hot, cold and meta are separate keys from one root', async () => {
  const m = await restart();
  const keys = m.core.deriveKeys(m.core.newRoot());
  const ex = (k) => k.export().toString('hex');
  assert.equal(new Set([ex(keys.hot), ex(keys.cold), ex(keys.meta)]).size, 3);
});

test('core: the recovery key round-trips and forgives obvious mix-ups', async () => {
  const m = await restart();
  const c = m.core;
  for (let i = 0; i < 100; i++) {
    const root = c.newRoot();
    const text = c.formatRecoveryKey(root);
    assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.deepEqual(c.parseRecoveryKey(text), root);
    assert.deepEqual(c.parseRecoveryKey(text.toLowerCase().replace(/-/g, ' ')), root);
    assert.deepEqual(c.parseRecoveryKey(text.replace(/0/g, 'O').replace(/1/g, 'l')), root);
  }
  assert.equal(c.parseRecoveryKey('too short'), null);
});

test('core: password rules', async () => {
  const c = (await restart()).core;
  assert.match(c.passwordProblem('short'), /12 characters/);
  for (const weak of ['password1234', 'qwertyqwerty', '111111111111', 'solanasolana', 'abcabcabcabc123']) assert.ok(c.passwordProblem(weak), weak);
  for (const fine of [PW, 'tr7!kLm2#vQ9x']) assert.equal(c.passwordProblem(fine), null, fine);
  assert.equal(c.retryDelayMs(4), 0);
  assert.equal(c.retryDelayMs(5), 30_000);
  assert.equal(c.retryDelayMs(6), 60_000);
  assert.equal(c.retryDelayMs(50), 15 * 60_000);
});

test('with the password off, nothing about the wallet changes', async () => {
  const dir = freshDir();
  const m = await restart();
  await setUp(m);
  assert.equal(m.vault.isOn(), false);
  assert.equal(m.vault.isLocked(), false);
  assert.equal(fs.existsSync(path.join(dir, 'vault.json')), false);
  for (const w of read(dir, 'wallets.json').wallets) assert.ok(isOsForm(w.secretEnc));
  assert.equal(m.wallet.lockReason(), null);
});

test('turning on seals every store, leaves no old form behind, and removes the old key file', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const addresses = seedOf(m).map((w) => w.publicKey);
  fs.writeFileSync(path.join(dir, 'wallet.json'), '{"version":1,"publicKey":"x","secretEnc":"old"}');
  const root = m.core.newRoot();
  const moved = await m.ops.turnOn(PW, root);
  assert.equal(moved, 3);
  for (const name of ['wallets.json', 'wallets.json.bak', 'evm-wallets.json', 'evm-wallets.json.bak']) {
    for (const w of read(dir, name).wallets) assert.ok(w.secretEnc.startsWith('kmv3:hot:'), `${name} ${w.label}`);
  }
  assert.equal(fs.existsSync(path.join(dir, 'wallet.json')), false, 'the legacy copy is gone');
  assert.equal(read(dir, 'vault.json').migrating, null);
  m = await restart();
  assert.deepEqual(seedOf(m).map((w) => w.publicKey), addresses, 'same wallets after a restart');
});

test('after a restart it is locked: nothing signs, nothing is stored, the reason says why', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  m = await restart();
  assert.equal(m.vault.isOn(), true);
  assert.equal(m.vault.isLocked(), true);
  assert.match(m.wallet.lockReason(), /locked/);
  const id = seedOf(m)[0].id;
  assert.match(signWallet(m, id).message, /locked|not known/);
  assert.equal(m.wallet.canSignUnattended(id), false);
  assert.match(m.wallet.generate('New').message, /locked/);
  assert.match(m.wallet.importSecret('x').message, /locked/);
  assert.match(m.evmWallet.generate('New').message, /locked/);
  assert.match(m.evmWallet.lockReason('bnb'), /locked/);
  assert.match(m.wallet.exportAllToFile(path.join(dir, 'out.txt')).message, /failed/i);
  assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'no export while locked');
  assert.equal(m.wallet.backupToFile(path.join(dir, 'b.json')).ok, false);
});

test('the right password unlocks, the wrong one does not, and keys still match', async () => {
  freshDir();
  let m = await restart();
  await setUp(m);
  const before = seedOf(m).map((w) => w.publicKey);
  await m.ops.turnOn(PW, m.core.newRoot());
  m = await restart();
  const bad = await m.vault.tryPassword(PW2);
  assert.equal(bad.ok, false);
  assert.equal(m.vault.isLocked(), true);
  const good = await m.vault.tryPassword(PW);
  assert.equal(good.ok, true);
  m.vault.useRoot(good.root, false);
  assert.equal(m.vault.isLocked(), false);
  assert.equal(m.wallet.lockReason(), null);
  assert.ok(pumpOk(signWallet(m, seedOf(m)[0].id)));
  assert.deepEqual(seedOf(m).map((w) => w.publicKey), before);
});

test('five wrong tries slow down, the count survives a restart, and keys are never wiped', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  const walletsBefore = fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8');
  m = await restart();
  const v = read(dir, 'vault.json');
  v.attempts = { fails: 4, notBefore: 0 };
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(v));
  m = await restart();
  const fifth = await m.vault.tryPassword(PW2);
  assert.match(fifth.message, /Wait 30 seconds/);
  m = await restart();
  const blocked = await m.vault.tryPassword(PW);
  assert.equal(blocked.ok, false, 'even the right password waits');
  assert.match(blocked.message, /Too many/);
  assert.equal(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8'), walletsBefore, 'keys untouched');
});

test('a new wallet made while unlocked is sealed; a plain record added to the file will not sign', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  const r = m.wallet.generate('Later');
  assert.equal(r.ok, true, r.message);
  const added = read(dir, 'wallets.json').wallets.find((w) => w.label === 'Later');
  assert.ok(added.secretEnc.startsWith('kmv3:hot:'));
  assert.ok(added.mac, 'its details are authenticated');
  // Malware adds a wallet whose key it knows, in the old form.
  const f = read(dir, 'wallets.json');
  f.wallets.push({ ...f.wallets[0], id: 'w_evil', label: 'Evil', publicKey: 'So11111111111111111111111111111111111111112', secretEnc: Buffer.from('stub:00', 'utf8').toString('base64'), mac: undefined });
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  m.vault.useRoot(u.root, false);
  assert.match(m.vault.cannotOpen(m.wallet.vaultRows().find((w) => w.id === 'w_evil').enc), /not protected/);
  assert.equal(m.wallet.canSignUnattended('w_evil'), false);
});

test('an edited withdrawal address is caught and will not sign; a real change is fine', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  const home = '11111111111111111111111111111111';
  assert.equal(m.wallet.setHomeAddress(home).ok, true);
  assert.deepEqual(m.wallet.tampered(), [], 'the app\'s own change verifies');
  const f = read(dir, 'wallets.json');
  const active = f.wallets.find((w) => w.id === f.activeId);
  active.homeAddress = 'So11111111111111111111111111111111111111112';
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  m.vault.useRoot(u.root, false);
  assert.deepEqual(m.wallet.tampered(), [active.label]);
  assert.equal(m.wallet.isTrusted(active.publicKey), false);
  const r = m.wallet.signVersionedTransaction(new Uint8Array(1), { intent: 'buy' });
  assert.match(r.message, /changed outside/);
});

test('a savings wallet opens only with the password just typed, and its .bak does not undo that', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const savings = seedOf(m).find((w) => w.label === 'Savings');
  m.ops.setScope('solana', savings.id, 'cold', root);
  const onDisk = read(dir, 'wallets.json').wallets.find((w) => w.id === savings.id);
  assert.ok(onDisk.secretEnc.startsWith('kmv3:cold:'));
  for (const w of read(dir, 'wallets.json.bak').wallets) if (w.id === savings.id) assert.ok(w.secretEnc.startsWith('kmv3:cold:'), 'no hot copy left in the backup');
  assert.equal(m.wallet.canSignUnattended(savings.id), false, 'not while merely unlocked');
  assert.match(signWallet(m, savings.id).message, /savings wallet|not known/);
  assert.match(m.wallet.select(savings.id).message, /savings wallet/);
  m.vault.useRoot(root, true);
  assert.ok(m.vault.cannotOpen(onDisk.secretEnc) === null, 'opens while the password was just typed');
  assert.equal(m.wallet.canSignUnattended(savings.id), false, 'but it is never one that signs unattended');
  m.vault.releaseCold();
  assert.equal(m.wallet.canSignUnattended(savings.id), false, 'closed again afterwards');
  m.ops.setScope('solana', savings.id, 'hot', root);
  assert.equal(m.wallet.canSignUnattended(savings.id), true);
});

test('a crash at each step of turning on resumes at the next unlock and loses nothing', async () => {
  for (const failAt of ['evm', 'aio', 'clear']) {
    const dir = freshDir();
    let m = await restart();
    await setUp(m);
    const addresses = [...seedOf(m).map((w) => w.publicKey), m.evmWallet.address('bnb')];
    const root = m.core.newRoot();
    // The same steps as turnOn, stopping where a power cut would.
    await m.vault.writeNew(PW, root, 'on');
    m.vault.useRoot(root, true);
    m.wallet.rewrapAll('sealed');
    if (failAt !== 'evm') m.evmWallet.rewrapAll('sealed');
    if (failAt === 'clear') m.aioWallet.rewrapAll('sealed');
    m = await restart();
    assert.equal(m.vault.migrating(), 'on', failAt);
    const u = await m.vault.tryPassword(PW);
    assert.equal(u.ok, true);
    m.ops.resumeIfInterrupted(u.root);
    assert.equal(m.vault.migrating(), null);
    for (const w of read(dir, 'evm-wallets.json').wallets) assert.ok(w.secretEnc.startsWith('kmv3:'), failAt);
    assert.deepEqual([...seedOf(m).map((w) => w.publicKey), m.evmWallet.address('bnb')], addresses);
    assert.ok(pumpOk(signWallet(m, seedOf(m)[0].id)));
  }
});

test('a store that fails to read back keeps its old file', async () => {
  const dir = freshDir();
  const m = await restart();
  await setUp(m, { evm: false });
  const before = fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8');
  const root = m.core.newRoot();
  await m.vault.writeNew(PW, root, 'on');
  // Corrupt the key behind one record, so its derived address cannot match.
  const f = read(dir, 'wallets.json');
  f.wallets[1].secretEnc = Buffer.from(`enc:${'ab'.repeat(32)}`, 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  const m2 = await restart();
  m2.vault.useRoot(root, true);
  assert.throws(() => m2.wallet.rewrapAll('sealed'), /does not match/);
  assert.equal(read(dir, 'wallets.json').wallets[0].secretEnc, JSON.parse(before).wallets[0].secretEnc, 'the file was not replaced');
});

test('turning off puts every key back, and the password file is gone', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const savings = seedOf(m).find((w) => w.label === 'Savings');
  m.ops.setScope('solana', savings.id, 'cold', root);
  m.ops.turnOff(root);
  assert.equal(fs.existsSync(path.join(dir, 'vault.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'vault.json.bak')), false);
  for (const name of ['wallets.json', 'wallets.json.bak', 'evm-wallets.json']) for (const w of read(dir, name).wallets) assert.ok(isOsForm(w.secretEnc), name);
  m = await restart();
  assert.equal(m.vault.isOn(), false);
  assert.equal(m.wallet.lockReason(), null);
  assert.ok(pumpOk(signWallet(m, savings.id)));
});

test('a crash while turning off finishes at the next unlock', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  m.vault.useRoot(root, true);
  m.vault.setMigrating('off');
  m.wallet.rewrapAll('os');
  m = await restart();
  assert.equal(m.vault.isOn(), true);
  const u = await m.vault.tryPassword(PW);
  m.ops.resumeIfInterrupted(u.root);
  assert.equal(m.vault.isOn(), false);
  for (const w of read(dir, 'evm-wallets.json').wallets) assert.ok(isOsForm(w.secretEnc));
});

test('changing the password: the old one stops working, the keys are not touched', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const before = fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8');
  await m.ops.changePassword(PW2, root);
  assert.equal(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8'), before);
  m = await restart();
  assert.equal((await m.vault.tryPassword(PW)).ok, false);
  assert.equal((await m.vault.tryPassword(PW2)).ok, true);
});

test('the recovery key gets back in with vault.json deleted, and a wrong one does not', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  const text = m.core.formatRecoveryKey(root);
  await m.ops.turnOn(PW, root);
  const addresses = seedOf(m).map((w) => w.publicKey);
  fs.rmSync(path.join(dir, 'vault.json'));
  fs.rmSync(path.join(dir, 'vault.json.bak'));
  m = await restart();
  assert.equal(m.vault.isOn(), true, 'sealed records alone still mean protected');
  assert.equal(m.vault.isLocked(), true);
  assert.equal(m.vault.needsRecovery(), true);
  assert.equal(await m.ops.recover(PW2, m.core.newRoot()), false, 'a wrong key');
  assert.equal(fs.existsSync(path.join(dir, 'vault.json')), false, 'and it wrote nothing');
  assert.equal(await m.ops.recover(PW2, m.core.parseRecoveryKey(text)), true);
  assert.equal(m.vault.isLocked(), false);
  assert.ok(pumpOk(signWallet(m, seedOf(m)[0].id)));
  m = await restart();
  assert.equal((await m.vault.tryPassword(PW2)).ok, true);
  assert.deepEqual(seedOf(m).map((w) => w.publicKey), addresses);
});

test('a damaged vault.json falls back to its copy', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  fs.writeFileSync(path.join(dir, 'vault.json'), '{ not json');
  m = await restart();
  assert.equal((await m.vault.tryPassword(PW)).ok, true);
});

test('losing both: the files move aside, nothing is deleted, and the app starts empty', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  m = await restart();
  const dest = m.ops.moveAside(new Date('2026-11-04T10:00:00Z'));
  for (const name of ['wallets.json', 'wallets.json.bak', 'evm-wallets.json', 'vault.json', 'vault.json.bak']) {
    assert.ok(fs.existsSync(path.join(dest, name)), name);
    assert.equal(fs.existsSync(path.join(dir, name)), false, name);
  }
  m = await restart();
  assert.equal(m.vault.isOn(), false);
  assert.equal(seedOf(m).length, 0);
  assert.equal(m.wallet.generate('Fresh').ok, true);
});

test('EVM keys seal and sign-check through the same rules', async () => {
  freshDir();
  let m = await restart();
  await setUp(m);
  const address = m.evmWallet.address('robinhood');
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const id = m.evmWallet.vaultRows()[0].id;
  m.ops.setScope('evm', id, 'hot', root);
  m = await restart();
  assert.equal(m.evmWallet.address('robinhood'), address, 'readable while locked');
  const r = await m.evmWallet.signTransaction('robinhood', {}, {});
  assert.equal(r.ok, false);
  const u = await m.vault.tryPassword(PW);
  m.vault.useRoot(u.root, false);
  assert.equal(m.evmWallet.lockReason('robinhood'), null);
  assert.equal(m.evmWallet.exportAllToFile(path.join(process.env.KRYPT_TEST_USERDATA, 'e.txt')).ok, true);
});

test('the recovery phrase is always a savings secret, and comes back whole', async () => {
  const dir = freshDir();
  let m = await restart();
  const made = m.aioWallet.create('Main');
  assert.equal(made.ok, true, made.message);
  const root = m.core.newRoot();
  m.aioWallet.markBackedUp();
  assert.equal(m.aioWallet.needsBackupFirst(), false);
  await m.ops.turnOn(PW, root);
  for (const name of ['aio-wallet.json', 'aio-wallet.json.bak']) assert.ok(JSON.stringify(read(dir, name)).includes('kmv3:cold:'), name);
  assert.ok(!JSON.stringify(read(dir, 'aio-wallet.json')).includes(made.phrase.split(' ')[0] + ' '), 'not in the clear');
  m = await restart();
  assert.equal(m.aioWallet.reveal().ok, false, 'locked');
  const u = await m.vault.tryPassword(PW);
  m.vault.useRoot(u.root, false);
  assert.equal(m.aioWallet.reveal().ok, false, 'unlocked is not enough');
  m.vault.useRoot(u.root, true);
  assert.equal(m.aioWallet.reveal().phrase, made.phrase);
  m.vault.releaseCold();
  m.ops.turnOff(u.root);
  assert.equal((await restart()).aioWallet.reveal().phrase, made.phrase, 'and survives turning it off');
});

test('a phrase never confirmed backed up blocks turning on', async () => {
  freshDir();
  const m = await restart();
  assert.equal(m.aioWallet.create('Main').ok, true);
  assert.equal(m.aioWallet.needsBackupFirst(), true);
});

test('with the password on, an All-in-One wallet needs it just typed to be set up', async () => {
  freshDir();
  const m = await restart();
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  assert.match(m.aioWallet.create('Main').message, /Type your wallet password/);
  m.vault.useRoot(root, true);
  assert.equal(m.aioWallet.create('Main').ok, true);
  m.vault.releaseCold();
});

test('removing a wallet or phrase leaves no copy of it in the backup', async () => {
  const dir = freshDir();
  const m = await restart();
  assert.equal(m.evmWallet.generate('One').ok, true);
  assert.equal(m.evmWallet.generate('Two').ok, true);
  const gone = read(dir, 'evm-wallets.json').wallets.find((w) => w.label === 'Two');
  assert.equal(m.evmWallet.remove(gone.id).ok, true);
  assert.ok(!fs.readFileSync(path.join(dir, 'evm-wallets.json.bak'), 'utf8').includes(gone.secretEnc));
  const made = m.aioWallet.create('Main');
  m.aioWallet.markBackedUp();
  const enc = read(dir, 'aio-wallet.json');
  assert.equal(m.aioWallet.forget().ok, true);
  assert.ok(!fs.readFileSync(path.join(dir, 'aio-wallet.json.bak'), 'utf8').includes(JSON.stringify(enc.wallet?.phraseEnc ?? 'x')), made.phrase ? 'phrase gone' : '');
});

test('a key file is flushed, keeps the previous file as a backup, and survives a failed check', async () => {
  const dir = freshDir();
  const m = await restart();
  const p = path.join(dir, 'k.json');
  m.durable.writeDurable(p, 'one');
  m.durable.writeDurable(p, 'two', { backup: true });
  assert.equal(fs.readFileSync(p, 'utf8'), 'two');
  assert.equal(fs.readFileSync(`${p}.bak`, 'utf8'), 'one');
  assert.throws(() => m.durable.writeDurable(p, 'three', { backup: true, verify: () => { throw new Error('bad'); } }), /bad/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'two', 'the old file stays');
  assert.equal(fs.readFileSync(`${p}.bak`, 'utf8'), 'one', 'and so does its backup');
});

test('while locked no plain record opens, whatever the change marker says', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  for (const name of ['vault.json', 'vault.json.bak']) {
    const v = read(dir, name);
    v.migrating = 'on';
    fs.writeFileSync(path.join(dir, name), JSON.stringify(v));
  }
  m = await restart();
  assert.equal(m.vault.isLocked(), true);
  assert.match(m.vault.cannotOpen('plain-os-record'), /locked/);
});

test('editing the change marker in vault.json cannot turn the password off', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const savings = seedOf(m).find((w) => w.label === 'Savings');
  m.ops.setScope('solana', savings.id, 'cold', root);
  for (const name of ['vault.json', 'vault.json.bak']) {
    const v = read(dir, name);
    v.migrating = 'off';
    fs.writeFileSync(path.join(dir, name), JSON.stringify(v));
  }
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  assert.equal(u.ok, true);
  m.ops.resumeIfInterrupted(u.root);
  assert.equal(m.vault.isOn(), true);
  assert.equal(m.vault.migrating(), null, 'and the edit is undone');
  assert.equal(read(dir, 'vault.json').migrating, null);
  assert.ok(fs.existsSync(path.join(dir, 'vault.json')));
  for (const name of ['wallets.json', 'wallets.json.bak', 'evm-wallets.json']) for (const w of read(dir, name).wallets) assert.ok(w.secretEnc.startsWith('kmv3:'), name);
  assert.ok(read(dir, 'wallets.json').wallets.find((w) => w.id === savings.id).secretEnc.startsWith('kmv3:cold:'));
});

test('editing the marker to "on" cannot launder an edited withdrawal address', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  const f = read(dir, 'wallets.json');
  const active = f.wallets.find((w) => w.id === f.activeId);
  active.homeAddress = 'So11111111111111111111111111111111111111112';
  delete active.mac;
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  const v = read(dir, 'vault.json');
  v.migrating = 'on';
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(v));
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  m.ops.resumeIfInterrupted(u.root);
  m.vault.useRoot(u.root, false);
  assert.deepEqual(m.wallet.tampered(), [active.label], 'still refused');
  assert.equal(read(dir, 'wallets.json').wallets.find((w) => w.id === f.activeId).mac, undefined, 'and not re-signed');
  // Even with a genuine marker, a sealed record is never re-signed.
  assert.equal(m.wallet.rewrapAll('sealed'), 0);
  assert.deepEqual(m.wallet.tampered(), [active.label]);
});

test('turning on refuses before anything changes if a key cannot be read', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const f = read(dir, 'wallets.json');
  f.wallets[1].secretEnc = Buffer.from(`enc:${'ab'.repeat(32)}`, 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  const before = fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8');
  m = await restart();
  assert.deepEqual(m.ops.unreadableKeys(), ['Savings']);
  await assert.rejects(m.ops.turnOn(PW, m.core.newRoot()), /Nothing changed.*Savings/);
  assert.equal(fs.existsSync(path.join(dir, 'vault.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8'), before);
  assert.equal(m.vault.isOn(), false);
});

test('turning off refuses before anything changes if a key cannot be read', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const f = read(dir, 'wallets.json');
  const bad = f.wallets[1];
  bad.secretEnc = bad.secretEnc.replace(/:[^:]+$/, ':AAAAAAAAAAAAAAAAAAAAAA==');
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  m = await restart();
  assert.throws(() => m.ops.turnOff(root), /Nothing changed/);
  assert.equal(m.vault.isOn(), true);
  assert.equal(m.vault.migrating(), null, 'not left half way');
  assert.ok(read(dir, 'evm-wallets.json').wallets[0].secretEnc.startsWith('kmv3:'));
});

test('one damaged record does not lock the owner out with the recovery key', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const f = read(dir, 'wallets.json');
  f.wallets[1].secretEnc = f.wallets[1].secretEnc.replace(/:[^:]+$/, ':AAAAAAAAAAAAAAAAAAAAAA==');
  fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify(f));
  fs.rmSync(path.join(dir, 'vault.json'));
  fs.rmSync(path.join(dir, 'vault.json.bak'));
  m = await restart();
  assert.equal(await m.ops.recover(PW2, m.core.newRoot()), false, 'a wrong key still fails');
  assert.equal(await m.ops.recover(PW2, root), true);
  assert.equal(m.vault.isLocked(), false);
  assert.ok(pumpOk(signWallet(m, f.wallets[0].id)), 'the good wallet signs');
});

test('recovering with the password file lost part way through turning on finishes the job', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.vault.writeNew(PW, root, 'on');
  m.vault.useRoot(root, true);
  m.wallet.rewrapAll('sealed');
  fs.rmSync(path.join(dir, 'vault.json'));
  fs.rmSync(path.join(dir, 'vault.json.bak'));
  m = await restart();
  assert.equal(await m.ops.recover(PW2, root), true);
  assert.equal(m.vault.migrating(), null);
  for (const w of read(dir, 'evm-wallets.json').wallets) assert.ok(w.secretEnc.startsWith('kmv3:'), 'the store it had not reached');
  assert.deepEqual(m.ops.unreadableKeys(), []);
});

test('a wallet cannot change scope under an unfinished change, so it cannot be stranded', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  m.vault.useRoot(root, true);
  m.vault.setMigrating('off');
  const id = seedOf(m)[1].id;
  m.vault.releaseCold();
  assert.throws(() => m.ops.setScope('solana', id, 'cold', root), /not finished/);
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  m.ops.resumeIfInterrupted(u.root);
  assert.equal(m.vault.isOn(), false, 'the resume finished the turn-off');
  assert.throws(() => m.ops.setScope('solana', id, 'cold', u.root), /not finished/);
  assert.ok(!read(dir, 'wallets.json').wallets.some((w) => w.secretEnc.startsWith('kmv3:')), 'nothing was sealed under a root with no file');
});

test('removing the signer does not hand signing to a savings wallet when another can sign', async () => {
  const dir = freshDir();
  const m = await restart();
  assert.equal(m.wallet.generate('Oldest').ok, true);
  assert.equal(m.wallet.generate('Hot').ok, true);
  assert.equal(m.wallet.generate('Signer').ok, true);
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  const rows = seedOf(m);
  const id = (l) => rows.find((w) => w.label === l).id;
  assert.equal(m.wallet.select(id('Signer')).ok, true);
  m.ops.setScope('solana', id('Oldest'), 'cold', root);
  m.vault.useRoot(root, true);
  assert.equal(m.wallet.remove(id('Signer')).ok, true);
  m.vault.releaseCold();
  assert.equal(read(dir, 'wallets.json').activeId, id('Hot'));
  assert.equal(m.wallet.lockReason(), null);
  // Only a savings wallet left: it stays the signer, and says it cannot trade.
  m.vault.useRoot(root, true);
  assert.equal(m.wallet.remove(id('Hot')).ok, true);
  assert.match(m.wallet.lockReason(), /savings wallet/, 'even with the cold key held');
  m.vault.releaseCold();
});

test('an EVM file that lists wallets and yields none is refused, not overwritten', async () => {
  const dir = freshDir();
  let m = await restart();
  assert.equal(m.evmWallet.generate('One').ok, true);
  const f = read(dir, 'evm-wallets.json');
  const text = JSON.stringify({ ...f, wallets: f.wallets.map((w) => ({ ...w, address: 'not an address' })) });
  fs.writeFileSync(path.join(dir, 'evm-wallets.json'), text);
  fs.rmSync(path.join(dir, 'evm-wallets.json.bak'), { force: true });
  m = await restart();
  assert.ok(m.evmWallet.failure(), 'reported');
  assert.throws(() => m.evmWallet.rewrapAll('sealed'));
  assert.equal(fs.readFileSync(path.join(dir, 'evm-wallets.json'), 'utf8'), text);
});

test('removing a Solana wallet leaves no copy of it in the backup', async () => {
  const dir = freshDir();
  const m = await restart();
  assert.equal(m.wallet.generate('One').ok, true);
  assert.equal(m.wallet.generate('Two').ok, true);
  const gone = read(dir, 'wallets.json').wallets.find((w) => w.label === 'Two');
  assert.equal(m.wallet.remove(gone.id).ok, true);
  assert.ok(!fs.readFileSync(path.join(dir, 'wallets.json.bak'), 'utf8').includes(gone.secretEnc));
});

test('a crash before the phrase backup moved is put right on resume', async () => {
  const dir = freshDir();
  let m = await restart();
  assert.ok(m.aioWallet.create('Main').ok);
  m.aioWallet.markBackedUp();
  const oldForm = fs.readFileSync(path.join(dir, 'aio-wallet.json'), 'utf8');
  const root = m.core.newRoot();
  await m.ops.turnOn(PW, root);
  fs.writeFileSync(path.join(dir, 'aio-wallet.json.bak'), oldForm);
  const v = read(dir, 'vault.json');
  const signed = m.core.vaultMac(m.core.deriveKeys(root).meta, v.kdf, 'on');
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ ...v, migrating: 'on', mac: signed }));
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  m.ops.resumeIfInterrupted(u.root);
  assert.ok(fs.readFileSync(path.join(dir, 'aio-wallet.json.bak'), 'utf8').includes('kmv3:cold:'));
  assert.equal(m.vault.migrating(), null);
});

test('a retry delay no app would set is ignored, and the count still holds', async () => {
  const dir = freshDir();
  let m = await restart();
  await setUp(m, { evm: false });
  await m.ops.turnOn(PW, m.core.newRoot());
  const v = read(dir, 'vault.json');
  v.attempts = { fails: 0, notBefore: Date.now() + 30 * 24 * 3600_000 };
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(v));
  m = await restart();
  assert.equal((await m.vault.tryPassword(PW)).ok, true);
});

test('wrong passwords never touch the keys the unlock already gave trading', async () => {
  freshDir();
  let m = await restart();
  await setUp(m);
  await m.ops.turnOn(PW, m.core.newRoot());
  m = await restart();
  const u = await m.vault.tryPassword(PW);
  m.vault.useRoot(u.root, false);
  assert.equal((await m.vault.tryPassword(PW2)).ok, false);
  assert.equal(m.vault.isLocked(), false);
  assert.equal(m.wallet.lockReason(), null);
  m.vault.lock();
  assert.equal(m.vault.isLocked(), true);
  assert.match(m.wallet.lockReason(), /locked/);
});

let passed = 0;
for (const c of cases) {
  await c.fn();
  passed += 1;
  console.log(`  ok   ${c.name}`);
}
console.log(`\nvault: ${passed}/${passed} passed`);
