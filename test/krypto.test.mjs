// $KRYPTO — the pinned mint behind the Hub's buy button.
//
// The one thing that must never ship: a card pointing at a malformed or
// mistyped mint. Null is fine (the card hides); anything else must be a
// well-formed Solana address.

import assert from 'node:assert';
import { KRYPTO_HOLDER_TOKENS, KRYPTO_TOKEN, holderFeeBps, holderRateApplies, isValidMint, kryptoDisclosure, kryptoPumpUrl, kryptoTokenLive } from './.krypto.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  assert.ok(KRYPTO_TOKEN.mint === null || isValidMint(KRYPTO_TOKEN.mint), `the pinned mint is null or a real address (got ${KRYPTO_TOKEN.mint})`);
  assert.equal(kryptoTokenLive(), KRYPTO_TOKEN.mint !== null, 'the card shows exactly when a mint is pinned');
  assert.equal(KRYPTO_TOKEN.chain, 'solana');
  ok('the pinned mint is either absent or well-formed');
}

{
  assert.equal(isValidMint('So11111111111111111111111111111111111111112'), true);
  assert.equal(isValidMint('J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n'), true);
  assert.equal(isValidMint('0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a'), false, 'an EVM address is not a mint');
  assert.equal(isValidMint('So1111111111111111111111111111111111111111O'), false, 'base58 has no O');
  assert.equal(isValidMint(''), false);
  assert.equal(isValidMint(null), false);
  ok('mint validation accepts base58 addresses and refuses everything else');
}

{
  assert.equal(kryptoPumpUrl('So11111111111111111111111111111111111111112'), 'https://pump.fun/coin/So11111111111111111111111111111111111111112');
  const d = kryptoDisclosure();
  assert.match(d, /issued by Krypt/);
  assert.match(d, /not a recommendation/);
  assert.match(d, /creator fees/);
  assert.match(d, /go to zero/);
  // Krypto Mirror: holding it changes nothing about the fee, and the
  // disclosure must not promise otherwise.
  assert.doesNotMatch(d, /halves|waives/i, 'no holder discount is promised');
  assert.match(d, /same flat rate/i, d);
  ok('the disclosure names the issuer, the non-recommendation, the fee and the downside');
}

// ── The holder rate: FLAT in Krypto Mirror ─────────────────────────────
//
// Every fee path still asks holderRateApplies / holderFeeBps, so these two
// functions ARE the rate. No holding of any size, and no unknown, may
// discount a trade.

{
  assert.equal(KRYPTO_HOLDER_TOKENS, 1_000_000, 'the constant survives for the canary, unused for pricing');
  for (const h of [1_000_000, 1_000_001, 1e12, Number.MAX_SAFE_INTEGER, 999_999, 0, -100, null, undefined, NaN, Infinity, '2000000', {}, true]) {
    assert.equal(holderRateApplies(h), false, `${String(h)} must not earn a holder rate`);
  }
  ok('no holding, known or unknown, earns a holder rate');
}

{
  for (const base of [50, 5, 1]) {
    assert.equal(holderFeeBps(base, true), base, `a holder flag does not discount ${base} bps`);
    assert.equal(holderFeeBps(base, false), base);
  }
  ok('the rate charged is the full rate whether or not a holder flag is passed');
}

console.log(`\nkrypto: ${passed}/${passed} passed`);
