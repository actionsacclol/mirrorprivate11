// Discord Rich Presence text. presenceLines is pure — exercised here without a
// Discord connection. The identity (buttons, client id, hover text) is covered
// by canary.test.mjs; this is just the two lines the copy state produces.

import assert from 'node:assert/strict';
import { presenceLines } from './.discordpresence.mjs';

let passed = 0;
const ok = (m) => {
  console.log(`ok  ${m}`);
  passed += 1;
};

// Nothing followed yet → the idle line, never a "0 wallets" line.
{
  const l = presenceLines({ follows: 0, open: 0, liveOpen: 0 });
  assert.equal(l.details, 'Copy trading on Solana');
  assert.equal(l.state, 'Idle');
  ok('no follows → Idle');
}

// Singular vs plural, and open count.
{
  assert.equal(presenceLines({ follows: 1, open: 0, liveOpen: 0 }).state, 'Following 1 wallet · 0 open');
  assert.equal(presenceLines({ follows: 3, open: 1, liveOpen: 0 }).state, 'Following 3 wallets · 1 open');
  assert.equal(presenceLines({ follows: 5, open: 4, liveOpen: 0 }).state, 'Following 5 wallets · 4 open');
  ok('wallet/open counts pluralize correctly');
}

// A live (real-money) open position is flagged; paper is not.
{
  assert.equal(presenceLines({ follows: 2, open: 2, liveOpen: 1 }).state, 'Following 2 wallets · 2 open · LIVE');
  assert.ok(!presenceLines({ follows: 2, open: 2, liveOpen: 0 }).state.includes('LIVE'));
  ok('LIVE tag shows only with a live open position');
}

console.log(`\ndiscordpresence: ${passed}/3 passed`);
