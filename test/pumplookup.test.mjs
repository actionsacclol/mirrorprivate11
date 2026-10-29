// Finding a wallet by pump.fun username (2026-10-23). pump's `GET /users/{id}`
// is a catch-all — `/users/search` is the profile of a user called "search" —
// so the one rule that matters: an answer is believed only when it is the
// profile that was asked for. Copying the wrong wallet is the failure here.

import assert from 'node:assert';
import { PUMP_LEADER_PERIODS, parsePumpHandle, pumpLeaderCautions, pumpUnsoldCount, pumpLeaderboardFrom, pumpLeaderboardPath, pumpUserFrom, pumpUserPath } from './.pumplookup.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const ADDR = '8MpJbCLZDXTvbDQUPdBGkZD2kqN2qj1mVkFgyaYMrbN5';

{
  assert.deepEqual(parsePumpHandle('sambati'), { kind: 'username', value: 'sambati' });
  assert.deepEqual(parsePumpHandle('  @The__Solstice '), { kind: 'username', value: 'The__Solstice' });
  assert.deepEqual(parsePumpHandle(ADDR), { kind: 'address', value: ADDR });
  assert.deepEqual(parsePumpHandle(`https://pump.fun/profile/sambati`), { kind: 'username', value: 'sambati' });
  assert.deepEqual(parsePumpHandle(`pump.fun/profile/${ADDR}?tab=coins`), { kind: 'address', value: ADDR });
  assert.deepEqual(parsePumpHandle(`https://www.pump.fun/profile/%40sambati`), { kind: 'username', value: 'sambati' });
  assert.equal(parsePumpHandle(''), null);
  assert.equal(parsePumpHandle('two words'), null);
  assert.equal(parsePumpHandle('https://evil.example/profile/sambati'), null, 'only pump.fun profile links');
  assert.equal(parsePumpHandle('../users'), null);
  assert.equal(parsePumpHandle('..'), null, 'never a path of dots');
  assert.equal(parsePumpHandle('_.'), null);
  assert.equal(parsePumpHandle('a_'.repeat(17)), null, 'too long for a name, and not an address');
  assert.equal(pumpUserPath({ kind: 'username', value: 'a.b' }), '/users/a.b');
  ok('a username, @name, a wallet or a pump.fun profile link is understood; anything else is refused');
}

{
  const sambati = { address: ADDR, canonical_svm_wallet: ADDR, username: 'sambati', followers: 46334, is_banned: false, is_pump_user: true, x_username: null };
  const u = pumpUserFrom(sambati, { kind: 'username', value: 'SAMBATI' });
  assert.ok(u, 'pump usernames are case-insensitive');
  assert.equal(u.wallet, ADDR);
  assert.equal(u.followers, 46334);
  assert.equal(u.isPumpUser, true);
  // The catch-all: asked for "sambati", answered with a user called "search".
  const search = { address: 'DrfWmxAHRdPK2ijw7wkLj5Qr4xbkGBcSz9hakHgvxEVX', username: 'search', followers: 1 };
  assert.equal(pumpUserFrom(search, { kind: 'username', value: 'sambati' }), null, 'someone else is not an answer');
  assert.equal(pumpUserFrom(sambati, { kind: 'address', value: 'DrfWmxAHRdPK2ijw7wkLj5Qr4xbkGBcSz9hakHgvxEVX' }), null);
  assert.ok(pumpUserFrom(sambati, { kind: 'address', value: ADDR }));
  // The canonical wallet wins over the account address when both are there.
  const moved = { ...sambati, canonical_svm_wallet: 'DrfWmxAHRdPK2ijw7wkLj5Qr4xbkGBcSz9hakHgvxEVX' };
  assert.equal(pumpUserFrom(moved, { kind: 'username', value: 'sambati' }).wallet, 'DrfWmxAHRdPK2ijw7wkLj5Qr4xbkGBcSz9hakHgvxEVX');
  assert.equal(pumpUserFrom({ ...sambati, address: 'nope', canonical_svm_wallet: null }, { kind: 'username', value: 'sambati' }), null, 'no usable wallet');
  assert.equal(pumpUserFrom({ ...sambati, username: '' }, { kind: 'address', value: ADDR }), null);
  assert.equal(pumpUserFrom(null, { kind: 'username', value: 'x' }), null);
  assert.equal(pumpUserFrom({ ...sambati, is_pump_user: false }, { kind: 'address', value: ADDR }).isPumpUser, false);
  ok('a profile is believed only when it is the one asked for, and names a real wallet');
}

{
  // pump.fun's PnL leaderboard (2026-10-25): two real rows from the weekly
  // board that day, trimmed, plus the malformed rows a parser must drop.
  const raw = {
    periodType: 1,
    periodLabel: '7d',
    windowStartSec: 1792310400,
    entries: [
      {
        rank: 2,
        walletAddress: 'DQMqCjCiRS8BAkZ2xrJ7QJPqUjoHnRDoPtcXMiEPtSus',
        pnlSol: 1794.8218536309496,
        pnlPercent: 2220.3672510137935,
        buySpendSol: 683.3549804062279,
        realizedPnlSol: 326.1194075741687,
        unrealizedPnlSol: 1468.7024460567807,
        positionsCount: 18,
        topPositions: [{ mint: 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump', symbol: 'BTC' }],
        username: 'someone',
        isVerified: false,
        xUsername: null,
      },
      {
        rank: 1,
        walletAddress: 'Crg4yePLW6aRb7vpbo6tTQx8q8T5Myfjf9xokzXU8i1s',
        pnlSol: 1970.6449303614509,
        pnlPercent: 362824.0183969846,
        buySpendSol: 9.847420593764063,
        realizedPnlSol: 1970.6352658580433,
        unrealizedPnlSol: 0.009664503407474758,
        positionsCount: 1,
        topPositions: [{ mint: '7PHPSS4btbBoRkheZ2guBKw9y3GPLJTNopTV48wupump', symbol: 'FATS' }, { mint: 'not a mint' }],
        username: 'MoonBoulderTarp',
        isVerified: false,
      },
      { rank: 3, walletAddress: 'not-a-wallet', pnlSol: 5 },
      { rank: 4, walletAddress: ADDR, pnlSol: 'lots' },
      { rank: 5, walletAddress: 'Crg4yePLW6aRb7vpbo6tTQx8q8T5Myfjf9xokzXU8i1s', pnlSol: 1 },
      null,
    ],
  };
  const b = pumpLeaderboardFrom(raw, 'weekly', 1_000);
  assert.equal(b.entries.length, 2, 'a bad wallet, a non-numeric PnL, a repeat and a null are dropped');
  assert.deepEqual(b.entries.map((e) => e.rank), [1, 2], 'in rank order');
  assert.equal(b.label, '7d');
  assert.equal(b.windowStart, 1792310400 * 1000);
  assert.equal(b.fetchedAt, 1_000);
  const [first, second] = b.entries;
  assert.equal(first.username, 'MoonBoulderTarp');
  assert.deepEqual(first.topCoins, [{ mint: '7PHPSS4btbBoRkheZ2guBKw9y3GPLJTNopTV48wupump', symbol: 'FATS' }], 'a malformed coin is dropped');
  assert.deepEqual(pumpLeaderCautions(first), ['one coin', 'one huge win'], '+362,824 % on one coin is luck until shown otherwise');
  assert.deepEqual(pumpLeaderCautions(second), [], 'some of it was sold at a profit');
  assert.deepEqual(pumpLeaderCautions({ ...second, realizedSol: -2 }), ['nothing sold'], 'all of the profit is a price, not a sale');
  assert.equal(pumpUnsoldCount(b.entries), 1, '1,469 of 1,795 SOL unsold counts toward the board-wide share');
  assert.equal(pumpLeaderboardPath('monthly'), '/pnl-leaderboard?period=monthly');
  assert.deepEqual(PUMP_LEADER_PERIODS, ['daily', 'weekly', 'monthly'], 'the three pump answers; anything else is a 400');
  assert.equal(pumpLeaderboardFrom({ message: 'nope' }, 'daily'), null);
  assert.equal(pumpLeaderboardFrom('<html>', 'daily'), null);
  ok('the PnL leaderboard is read row by row, malformed rows dropped, and its own figures flag luck');
}

console.log(`\npumplookup: ${passed}/${passed} passed`);
