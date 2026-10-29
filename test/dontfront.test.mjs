// Jito's don't-front-run marker (2026-10-25): a valid address, an instruction
// that moves nothing, and both copy builders putting it on every buy — and
// nowhere does the app call it protection.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JITO_DONT_FRONT, dontFrontIx } from './.dontfront.mjs';
import { PublicKey, SystemProgram } from '@solana/web3.js';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

{
  assert.ok(JITO_DONT_FRONT.startsWith('jitodontfront'), 'the marker is the address prefix the block engine looks for');
  const pk = new PublicKey(JITO_DONT_FRONT);
  assert.equal(pk.toBytes().length, 32, 'a real 32-byte address');
  const owner = new PublicKey('11111111111111111111111111111112').toBase58();
  const ix = dontFrontIx(owner);
  assert.equal(ix.programId.toBase58(), SystemProgram.programId.toBase58(), 'a system transfer');
  assert.equal(ix.keys[0].pubkey.toBase58(), owner);
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].pubkey.toBase58(), JITO_DONT_FRONT, 'to the marker');
  // SystemProgram.transfer data: u32 instruction index 2, then u64 lamports.
  assert.equal(ix.data.readUInt32LE(0), 2);
  assert.equal(ix.data.readBigUInt64LE(4), 0n, 'moves nothing');
  ok('the marker is a valid address and a transfer of nothing');
}

{
  for (const f of ['../electron/engine/txBuilder.ts', '../electron/engine/pumpSwapBuilder.ts']) {
    const s = read(f);
    assert.match(s, /if \(p\.dontFront\) instructions\.push\(dontFrontIx\(p\.owner\)\);/, `${f} adds the marker when asked`);
    assert.ok(s.indexOf('if (p.dontFront)') > s.indexOf("if (p.action === 'buy')"), `${f} adds it to buys`);
  }
  const signer = read('../electron/engine/liveSigner.ts');
  assert.equal((signer.match(/dontFront: p\.action === 'buy'/g) ?? []).length, 2, 'the signer asks for it on every buy, both builders');
  // Not marketed: no page says it protects anything.
  for (const f of fs.readdirSync(new URL('../src/pages/', import.meta.url))) {
    const s = read('../src/pages/' + f);
    assert.ok(!/jitodontfront|don.t-front|front-?run protection/i.test(s), `${f} does not sell the marker as protection`);
  }
  ok('both builders put it on every buy, and no page calls it protection');
}

console.log(`\ndontfront: ${passed}/${passed} passed`);
