// Wallet Scout — the manual scan runner.
//
// A scan replays hours of trades into the same book the live feed writes.
// Two things make that safe and they are what is pinned here: the feed order
// (a sell before its buy scores nothing), and the duplicate guard (a trade the
// feed already recorded must not be counted again). Driven by fake sources —
// the chain adapters are wiring over readers that have their own tests.

import assert from 'node:assert';
import { _reset, _store as scout, cancel, start, status, wait } from './.scoutscan.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const NOW = Date.now();
const W = 'ScannedWallet111111111111111111111111111111';
const trade = (mint, isBuy, native, tokens, at, tx, address = W) => ({ address, mint, isBuy, native, tokens, at, tx });
// Case-insensitive, the way the app looks a record up: a Solana record keeps
// the address as the chain spells it, an EVM one is lower-cased (2026-10-22).
const book = (chain, address) => scout.wallets(chain).find((w) => w.address.toLowerCase() === address.toLowerCase());
const sum = (w, field) => w.days.reduce((n, d) => n + d[field], 0);
const fresh = () => {
  _reset();
  scout._reset();
};

{
  // A batch arrives in any order; the sell is listed FIRST here. Fed as-is it
  // would find no basis and score nothing. The wallet's first two buys are
  // sightings (the store promotes on the third), so the trip that can close
  // is on the mint bought at promotion.
  fresh();
  const batch = {
    calls: 2,
    units: 1,
    trades: [
      trade('m2', false, 0.3, 1000, NOW - 10_000, 't5'),
      trade('m0', true, 0.1, 1000, NOW - 50_000, 't1'),
      trade('m1', true, 0.1, 1000, NOW - 40_000, 't2'),
      trade('m2', true, 0.1, 1000, NOW - 30_000, 't3'),
      trade('m3', true, 0.1, 1000, NOW - 20_000, 't4'),
    ],
  };
  const source = async function* () {
    yield batch;
  };
  assert.equal(start('solana', 6, source).ok, true);
  await wait('solana');
  const st = status('solana');
  assert.equal(st.running, false);
  assert.equal(st.read, 5);
  assert.equal(st.fed, 5);
  assert.equal(st.duplicates, 0);
  assert.equal(st.calls, 2);
  assert.equal(st.units, 1);
  assert.equal(st.unitsDone, 1);
  assert.equal(st.cancelled, false);
  assert.equal(st.trackedBefore, 0);
  assert.equal(st.trackedAfter, 1);
  const w = book('solana', W);
  assert.ok(w, 'the wallet is on record');
  assert.equal(sum(w, 'roundTrips'), 1, 'the sell closed the trip although it was listed first');
  assert.ok(Math.abs(sum(w, 'pnl') - 0.2) < 1e-9, 'and it is priced against the buy it closed');
  assert.equal(w.firstSeen, NOW - 30_000, 'firstSeen is the oldest trade on the book, not the arrival time');
  ok('a batch is fed oldest-first, so a sell listed before its buy still closes a round trip');
}

{
  // The live feed recorded a buy an hour ago; a scan over the same hour reads
  // the same buy again. It must be refused, or every round trip the feed
  // scored while the scan runs is doubled.
  fresh();
  for (let i = 0; i < 3; i++) scout.note('solana', W, 'p' + i, true, 0.1, 1000, NOW - 100_000, 'live' + i);
  assert.equal(scout.note('solana', W, 'x', true, 0.5, 1000, NOW - 5_000, 'sigX'), 'noted');
  const source = async function* () {
    yield {
      calls: 1,
      units: 1,
      trades: [trade('x', true, 0.5, 1000, NOW - 5_000, 'sigX'), trade('x', false, 1.0, 1000, NOW - 1_000, 'sigY')],
    };
  };
  start('solana', 1, source);
  await wait('solana');
  const st = status('solana');
  assert.equal(st.read, 2);
  assert.equal(st.duplicates, 1, 'the buy the feed already had is a duplicate');
  assert.equal(st.fed, 1, 'the sell is new');
  const w = book('solana', W);
  assert.ok(Math.abs(sum(w, 'volume') - 0.6) < 1e-9, 'volume counts the buy once (0.1 at promotion + 0.5)');
  assert.equal(sum(w, 'roundTrips'), 1);
  assert.ok(Math.abs(sum(w, 'pnl') - 0.5) < 1e-9);
  ok('a trade the live feed already recorded is refused by the scan, not counted twice');
}

{
  // Cancel stops after the current unit; a second start while one runs is
  // refused; and the chain can be scanned again afterwards.
  fresh();
  let yielded = 0;
  const source = async function* () {
    for (let i = 0; i < 50; i++) {
      yielded += 1;
      yield { calls: 1, units: 50, trades: [] };
    }
  };
  assert.equal(start('robinhood', 6, source).ok, true);
  assert.equal(start('robinhood', 6, source).ok, false, 'one scan per chain at a time');
  assert.equal(cancel('robinhood'), true);
  await wait('robinhood');
  const st = status('robinhood');
  assert.equal(st.running, false);
  assert.equal(st.cancelled, true);
  assert.ok(st.unitsDone < 50 && yielded < 50, `stopped early (${st.unitsDone} of 50)`);
  assert.equal(cancel('robinhood'), false, 'nothing to cancel once it has stopped');
  assert.equal(start('robinhood', 6, source).ok, true, 'and it can run again');
  await wait('robinhood');
  assert.equal(status('robinhood').cancelled, false);
  ok('a scan can be cancelled, refuses a second start while running, and runs again after');
}

{
  // A source that fails mid-way leaves what it fed, says why, and is not
  // "running" forever.
  fresh();
  const source = async function* () {
    yield { calls: 1, units: 3, trades: [], note: 'first note' };
    yield { calls: 1, trades: [], note: 'second note' };
    throw new Error('RPC fell over');
  };
  start('bnb', 24, source);
  await wait('bnb');
  const st = status('bnb');
  assert.equal(st.running, false);
  assert.equal(st.unitsDone, 2);
  assert.equal(st.calls, 2);
  assert.equal(st.message, 'first note', 'the first thing that went wrong is the one reported');
  assert.ok(st.finishedAt !== null);
  const failing = async function* () {
    throw new Error('RPC fell over');
    // eslint-disable-next-line no-unreachable
    yield { calls: 0, trades: [] };
  };
  start('bnb', 24, failing);
  await wait('bnb');
  assert.match(status('bnb').message, /RPC fell over/, 'a throw with no earlier note is the message');
  ok('a failing source stops the scan cleanly and says what happened');
}

{
  // A source restating its total (an EVM chunk that had to be halved) is
  // believed; the last word is the honest one.
  fresh();
  const source = async function* () {
    yield { calls: 1, units: 4, trades: [] };
    yield { calls: 1, units: 7, trades: [] };
  };
  start('robinhood', 1, source);
  await wait('robinhood');
  assert.equal(status('robinhood').units, 7);
  assert.equal(status('robinhood').unitsDone, 2);
  ok('a restated unit total replaces the earlier estimate');
}

{
  // The user's own wallet in a scanned page is not fed — the store refuses
  // it, and the scan counts it as neither fed nor duplicate.
  fresh();
  const MINE = 'MyOwnWallet1111111111111111111111111111111';
  scout.setOwnAddresses('solana', [MINE]);
  const source = async function* () {
    yield { calls: 1, units: 1, trades: [trade('m', true, 1, 1, NOW, 'a', MINE), trade('m', false, 2, 1, NOW, 'b', MINE)] };
  };
  start('solana', 1, source);
  await wait('solana');
  const st = status('solana');
  assert.equal(st.read, 2);
  assert.equal(st.fed, 0);
  assert.equal(st.duplicates, 0);
  assert.equal(scout.wallets('solana').length, 0);
  ok('a scan cannot put the user\'s own wallet on the board either');
}

{
  // Scan honesty (2026-10-24). On 10-22 one 429 cost 11 of 27 tokens, and the
  // result line read as if the scan were whole. The real Solana source, fed a
  // fake swap API: a park is waited out and the token read; a busy token is
  // read in part; a token that stays refused is counted as not read.
  fresh();
  const { solanaSource } = await import('./.scoutscansources.mjs');
  const asked = new Map();
  let parkedFor = 1;
  const slept = [];
  const waitingSeen = [];
  const deps = {
    listMints: async () => ['ok1', 'parked', 'busy', 'shut'],
    async recentTrades(mint) {
      asked.set(mint, (asked.get(mint) ?? 0) + 1);
      const t = { slot: 1, ts: NOW - 1_000, user: W, isBuy: true, base: 1000, sol: 0.1, program: 'pump', tx: 'tx-' + mint + asked.get(mint) };
      if (mint === 'parked' && parkedFor-- > 0) return { trades: [], complete: false, calls: 1, ok: false, message: 'pumpswap: rate limited, retrying in 40s' };
      if (mint === 'shut') return { trades: [], complete: false, calls: 1, ok: false, message: 'pumpswap: HTTP 429' };
      if (mint === 'busy') return { trades: [t], complete: false, calls: 3, ok: true, message: 'ok' };
      return { trades: [t], complete: true, calls: 1, ok: true, message: 'ok' };
    },
    cooldownMs: () => 40_000,
    sleep: async (ms) => {
      slept.push(ms);
      waitingSeen.push(status('solana').waitingUntil !== null);
    },
  };
  assert.equal(start('solana', 6, solanaSource(deps)).ok, true);
  await wait('solana');
  const st = status('solana');
  assert.equal(asked.get('parked'), 2, 'a parked token is asked again after the wait');
  assert.equal(asked.get('shut'), 4, 'a token that stays refused gets three waits, then is given up');
  assert.equal(slept.reduce((a, b) => a + b, 0), 4 * 40_000, 'each wait is the park, a second at a time');
  assert.ok(waitingSeen.every(Boolean), 'the status says it is waiting while it waits');
  assert.equal(st.waitingUntil, null);
  assert.equal(st.units, 4);
  assert.equal(st.unitsDone, 4);
  assert.equal(st.unitsUnread, 1, 'only the shut token is unread');
  assert.equal(st.unitsPartial, 1, 'the busy token is read in part');
  assert.equal(st.read, 3);
  assert.equal(st.calls, 1 + 2 + 3 + 4);
  assert.match(st.message, /rate limited|429/);

  // A provider that stays shut ends the waiting for the whole scan, not per
  // token: six waits in all, then every later token is counted unread at once.
  fresh();
  slept.length = 0;
  const shut = { ...deps, listMints: async () => ['a', 'b', 'c', 'd'], recentTrades: async () => ({ trades: [], complete: false, calls: 1, ok: false, message: 'pumpswap: HTTP 429' }) };
  start('solana', 6, solanaSource(shut));
  await wait('solana');
  assert.equal(slept.length, 6 * 40);
  assert.equal(status('solana').unitsUnread, 4);
  ok('a scan waits out a pump.fun park, counts busy coins as read in part, and says how many it could not read');
}

{
  // Fast first (2026-10-24): the chain reads each token through Helius; the
  // swap API reads only what the chain did not, per token; the allowance is
  // reserved before a read, billed after, and its end is said once.
  fresh();
  const { solanaSource } = await import('./.scoutscansources.mjs');
  const pumpAsked = [];
  const chainAsked = [];
  let left = 10_000;
  let billed = 0;
  const t = (mint, n) => ({ user: W, isBuy: true, sol: 0.1, tokens: 1000, ts: NOW - 1_000 - n, tx: `c-${mint}-${n}` });
  const deps = {
    listMints: async () => ['c1', 'c2', 'none', 'c4', 'c5'],
    async recentTrades(mint) {
      pumpAsked.push(mint);
      return { trades: [{ slot: 1, ts: NOW - 1_000, user: W, isBuy: true, base: 1000, sol: 0.1, program: 'pump', tx: `p-${mint}` }], complete: true, calls: 1, ok: true, message: 'ok' };
    },
    cooldownMs: () => 0,
    sleep: async () => {},
    chainOff: () => '',
    chainCreditsLeft: () => left,
    billBacktest: (n) => {
      billed += n;
      left -= n;
    },
    chainTrades(mint) {
      chainAsked.push(mint);
      // 'none': a read that failed once — this token goes to the swap API.
      if (mint === 'none') return Promise.resolve({ trades: [], complete: false, calls: 1, credits: 0, ok: false, message: 'RPC HTTP 500' });
      // c4 is a busy coin: a full three pages, read in part.
      return Promise.resolve({ trades: [t(mint, 1), t(mint, 2)], complete: mint !== 'c4', calls: mint === 'c4' ? 3 : 1, credits: mint === 'c4' ? 30 : 10, ok: true, message: 'ok' });
    },
  };
  start('solana', 6, solanaSource(deps));
  await wait('solana');
  let st = status('solana');
  assert.deepEqual(chainAsked, ['c1', 'c2', 'none', 'c4', 'c5'], 'every token goes to the chain first');
  assert.deepEqual(pumpAsked, ['none'], 'only the token the chain failed is read the slow way');
  assert.equal(st.viaChain, 4);
  assert.equal(st.viaPump, 1);
  assert.equal(st.credits, 60);
  assert.equal(billed, 60, 'every credit is counted on the allowance');
  assert.equal(st.unitsPartial, 1, 'a busy coin on the chain is read in part too');
  assert.equal(st.read, 4 * 2 + 1);
  assert.equal(st.calls, 1 + 1 + 1 + 1 + 3 + 1);
  assert.ok(!st.fallbackWhy, 'one failed read is not a reason to stop asking the chain');

  // The allowance runs low mid-scan: the chain stops being asked, the rest go
  // to the swap API, and why is said once.
  fresh();
  chainAsked.length = 0;
  pumpAsked.length = 0;
  left = 150; // covers the four reads in flight (4 × 30), then falls under that reserve
  start('solana', 6, solanaSource({ ...deps, listMints: async () => ['a', 'b', 'c', 'd', 'e'] }));
  await wait('solana');
  st = status('solana');
  assert.ok(chainAsked.length < 5 && chainAsked.length >= 1, `the chain was asked for only what the allowance could cover: ${chainAsked}`);
  assert.equal(st.viaChain + st.viaPump, 5, 'every token was still read');
  assert.deepEqual(pumpAsked, ['a', 'b', 'c', 'd', 'e'].filter((m) => !chainAsked.includes(m)));
  assert.match(st.fallbackWhy, /allowance/);

  // No Helius key: not one chain read, and the scan says so.
  fresh();
  chainAsked.length = 0;
  start('solana', 6, solanaSource({ ...deps, chainOff: () => 'there is no Helius key', chainTrades: () => null }));
  await wait('solana');
  st = status('solana');
  assert.equal(chainAsked.length, 0);
  assert.equal(st.viaPump, 5);
  assert.match(st.fallbackWhy, /no Helius key/);
  ok('a Solana scan reads the chain first and pump.fun only for what the chain did not, inside the allowance, and says why it slowed');
}

{
  // The winners scan (2026-10-27): the week's winner coins read from the
  // chain, every SIGNING trader on them fed to the book. A trade the event
  // credits to an account that did not sign (a program's vault) is dropped —
  // the wallet reader refuses it too, so it could never be copied. The
  // allowance is reserved a coin at a time and its end is said; without a
  // key, or without coins, the scan says so and reads nothing.
  fresh();
  const { solanaWinnersSource, _pageCredits } = await import('./.scoutscansources.mjs');
  const pc = _pageCredits();
  assert.equal(pc.reserved, pc.billed, 'the page price the scans reserve (and the Discover page states) is what the RPC client bills for a hundred transactions');
  const P = 'ProgramVault1111111111111111111111111111111';
  let left = 5_000;
  const asked = [];
  const coin = (mint) => ({ mint, symbol: mint.slice(0, 3), kind: 'young', ageDays: 2, mcap: 500_000, liquidity: 50_000, vol24: 100_000 });
  const trades = (mint) => [
    { user: W, isBuy: true, sol: 0.1, tokens: 1000, ts: NOW - 60_000, tx: `${mint}-b`, signer: true },
    { user: P, isBuy: true, sol: 5, tokens: 50_000, ts: NOW - 59_000, tx: `${mint}-pb`, signer: false },
    { user: W, isBuy: false, sol: 0.2, tokens: 1000, ts: NOW - 30_000, tx: `${mint}-s`, signer: true },
    { user: P, isBuy: false, sol: 6, tokens: 50_000, ts: NOW - 29_000, tx: `${mint}-ps`, signer: false },
  ];
  const deps = {
    listCoins: async () => ['c1', 'c2', 'c3', 'c4'].map(coin),
    chainTrades(mint) {
      asked.push(mint);
      return Promise.resolve({ trades: trades(mint), complete: mint !== 'c2', calls: 15, credits: 1_500, ok: true, message: 'ok' });
    },
    chainCreditsLeft: () => left,
    billBacktest: (c) => {
      left -= c;
    },
    chainOff: () => '',
  };
  assert.equal(start('solana', 168, solanaWinnersSource(deps), 'winners').ok, true);
  await wait('solana');
  let st = status('solana');
  assert.equal(st.mode, 'winners');
  assert.equal(st.hours, 168);
  assert.equal(st.units, 4);
  assert.deepEqual(asked, ['c1', 'c2'], 'two coins fit the allowance: 5,000 credits, 2,000 reserved a coin');
  assert.equal(st.unitsDone, 3, 'two read, the third said to be unread');
  assert.equal(st.unitsUnread, 1);
  assert.equal(st.unitsPartial, 1, 'c2 was busier than the page cap');
  assert.equal(st.credits, 3_000);
  assert.equal(st.viaChain, 2);
  assert.equal(st.read, 4, "the signing wallet's four trades; the vault's four were dropped");
  assert.ok(book('solana', W), 'the signer is on record');
  assert.equal(book('solana', P), undefined, 'the vault is not');
  assert.match(st.message, /allowance/);

  fresh();
  start('solana', 168, solanaWinnersSource({ ...deps, chainOff: () => 'there is no Helius key' }), 'winners');
  await wait('solana');
  st = status('solana');
  assert.equal(st.units, 0);
  assert.match(st.message, /Helius key/);

  fresh();
  start('solana', 168, solanaWinnersSource({ ...deps, listCoins: async () => [] }), 'winners');
  await wait('solana');
  assert.match(status('solana').message, /No pump\.fun coin/);
  ok('the winners scan feeds only signing traders, reserves the allowance a coin at a time, and says when it cannot run');
}

console.log(`\nscoutscan: ${passed}/${passed} passed`);
