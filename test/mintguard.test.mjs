// Copy buys routed through Jupiter refuse unsafe mints (2026-10-23).
//
// A copy is a buy nobody looked at. The pump curve and PumpSwap builders only
// ever see pump-created mints, but a leader trading on Raydium, Meteora or
// LaunchLab is copied through Jupiter, where a mint can carry a permanent
// delegate (tokens seized after purchase), a freeze authority, a transfer
// hook or a transfer fee. risk.checkMint already names these for the
// scanner; the copy path never asked.

import assert from 'node:assert';
import fs from 'node:fs';
import { checkMint, hasHardReject } from './.risk.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/mint-extensions.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
const serve = (acct) => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: acct } }),
  });
};
const account = (fx) => ({ owner: fx.owner, data: [fx.dataB64, 'base64'], lamports: 1, executable: false });

{
  serve(account(FX.spam));
  const r = await checkMint('https://rpc.test/', FX.spam.mint);
  assert.ok(r.checked);
  assert.ok(hasHardReject(r.flags), JSON.stringify(r.flags));
  assert.ok(r.flags.some((f) => f.id === 'permanent-delegate'));
  ok('a permanent-delegate mint is a hard reject');
}

{
  const real = Object.keys(FX).map((k) => FX[k]).find((v) => v && typeof v === 'object' && v.dataB64 && v !== FX.spam);
  serve(account(real));
  const r = await checkMint('https://rpc.test/', real.mint);
  assert.ok(r.checked);
  assert.ok(!hasHardReject(r.flags), `a pump create_v2 mint passes: ${JSON.stringify(r.flags)}`);
  ok('a real pump create_v2 Token-2022 mint passes');
}

{
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => 'down' });
  const r = await checkMint('https://rpc.test/', FX.spam.mint);
  assert.equal(r.checked, false, 'an unreadable mint is unchecked, which the copy buy treats as a refusal');
  ok('an unreadable mint is reported unchecked');
}
globalThis.fetch = realFetch;

{
  // The wiring: only the Jupiter BUY branch asks, it fails closed, and the
  // relayer is not tried after a refusal; both copy buy paths ask for it.
  const signer = fs.readFileSync(new URL('../electron/engine/liveSigner.ts', import.meta.url), 'utf8');
  const guard = signer.indexOf("if (p.action === 'buy' && p.mintGuard)");
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(signer.lastIndexOf("source === 'jupiter'", guard) > signer.lastIndexOf("source === 'pumpswap'", guard), 'inside the Jupiter branch');
  assert.ok(/!safety\.checked \|\| hasHardReject\(safety\.flags\)/.test(signer), 'fails closed');
  assert.ok(/return \{\s*ok: false,\s*stage: 'validate',\s*message: safety\.checked/.test(signer), 'returns, so no other route is tried');
  const engine = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(/this\.testTrade\(mint, sol, false, \{ slippagePct: opts\?\.slippagePct, mintGuard: true \}\)/.test(engine), 'active-wallet copy buys');
  assert.ok(/this\.labBuy\(opts\.walletId, mint, sol, undefined, \{ mintGuard: true, slippagePct: opts\.slippagePct \}\)/.test(engine), 'own-wallet copy buys');
  ok('copy buys ask for the guard on the Jupiter branch only, and a refusal ends the order');
}

console.log(`\nmintguard: ${passed}/${passed} passed`);
