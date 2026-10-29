// Copy replay (2026-10-23) — "what would copying this wallet have done?" for a
// wallet the live feed never saw. Its numbers sit next to the board's on the
// profile, so it must use the board's rules: a copy 2 s behind both legs,
// filled at the market as it stood, too-fast trips never copied, and an
// unpriced trade never read as a loss or a win.

import assert from 'node:assert';
import { BUNDLE_AFTER_CREATE, REPLAY_MAX_TRIPS, REPLAY_MIN_COPY_SOL, REPLAY_TRIP_CREDITS_MAX, REPLAY_WEEK_CREDITS_MAX, REPLAY_WEEK_MAX_TRIPS, REPLAY_WEEK_MS, REPLAY_WEEK_READ_LIMIT, REPLAY_WEEK_SLOW_MAX, buildTrips, markBirth, recordedMedian, replayCopySol, replayDayOf, replayReturn, replaySummary, replayVerdict, sampleSeed, sampleTrips, swapChecks } from './.copyreplay.mjs';
import * as job from './.copyreplayjob.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const T = 1_790_000_000_000;
const sw = (mint, isBuy, sol, tokens, at) => ({ mint, isBuy, sol, tokens, at });

{
  const { trips, open, orphanSells } = buildTrips([
    // A: two buys, a trim, then the rest — one trip, closed on the last sell.
    sw('A', true, 1, 1000, T),
    sw('A', true, 1, 1000, T + 5_000),
    sw('A', false, 1.5, 1000, T + 60_000),
    sw('A', false, 1.5, 1000, T + 120_000),
    // B: in and out inside the lag — too fast to copy.
    sw('B', true, 1, 1000, T + 200_000),
    sw('B', false, 1.2, 1000, T + 201_000),
    // C: still open at the end.
    sw('C', true, 1, 1000, T + 300_000),
    // D: a sell with no buy on record.
    sw('D', false, 1, 1000, T + 400_000),
  ]);
  assert.equal(trips.length, 2);
  assert.equal(open, 1);
  assert.equal(orphanSells, 1);
  const [a, b] = trips;
  assert.equal(a.mint, 'A');
  assert.equal(a.openedAt, T, 'the trip opens on the first buy');
  assert.equal(a.closedAt, T + 120_000, 'and closes on the sell that empties it');
  assert.ok(Math.abs(a.cost - 2) < 1e-9 && Math.abs(a.pnl - 1) < 1e-9, `cost ${a.cost} pnl ${a.pnl}`);
  assert.equal(a.note, 'unpriced', 'not priced until the job prices it');
  assert.equal(b.note, 'too-fast');
  ok('their trips are built by the Scout’s rules: first buy opens, the emptying sell closes, too-fast is marked');
}

{
  // The board's follower return, 1.5 % a side.
  assert.ok(Math.abs(replayReturn(1, 1.1) - ((1.1 * 0.985) / 1.015 - 1) * 100) < 1e-9);
  assert.equal(replayReturn(null, 1), null);
  assert.equal(replayReturn(0, 1), null);
  const mk = (r, note = 'filled') => ({ mint: 'm', openedAt: 0, closedAt: 1, cost: 1, pnl: 0, holdMs: 60_000, entryPx: 1, exitPx: 1, returnPct: r, note });
  const four = replaySummary([mk(10), mk(-10), mk(5), mk(-5)], 0.1);
  assert.equal(four.copied, 4);
  assert.equal(four.medianPct, null, 'no median under five copies');
  assert.equal(four.winRatePct, null);
  const s = replaySummary([mk(10), mk(-10), mk(5), mk(-5), mk(0), mk(null, 'too-fast'), mk(null, 'unpriced')], 0.1);
  assert.equal(s.trips, 7);
  assert.equal(s.copied, 5);
  assert.equal(s.tooFast, 1);
  assert.equal(s.unpriced, 1);
  assert.ok(s.medianPct < 0, `the middle copy (0 % recorded) is a loss at paper's costs: ${s.medianPct}`);
  assert.ok(Math.abs(s.reachablePct - (5 / 6) * 100) < 1e-9, 'judged = copied + too fast; unpriced is neither');
  assert.equal(s.shrunkPct, null, 'no ranking figure under ten copies');
  assert.ok(s.totalSol < 0 && s.totalSol > -0.1, `five 0.1 SOL copies: ${s.totalSol}`);
  assert.ok(s.feeFloorPct < -3, 'a copy that goes nowhere loses its fees');
  assert.equal(REPLAY_MAX_TRIPS, 30);
  ok('the summary prices copies at the size, and keeps unpriced out of every figure');
}

{
  // Sized by their trade (2026-10-25): a share of what they put in, capped,
  // each copy at its own fees, and a share under the live minimum skipped.
  const mk = (cost, r) => ({ mint: 'm', openedAt: 0, closedAt: 1, cost, pnl: 0, holdMs: 60_000, entryPx: 1, exitPx: 1, returnPct: r, note: 'filled' });
  const sizing = { share: 25, cap: 0.1 };
  assert.equal(replayCopySol(mk(0.2, 0), sizing), 0.05, '25 % of 0.2');
  assert.equal(replayCopySol(mk(4, 0), sizing), 0.1, 'never over the cap');
  assert.equal(replayCopySol(mk(0.1, 0), sizing), null, `0.025 is under the ${REPLAY_MIN_COPY_SOL} SOL live minimum`);
  const trips = [mk(0.2, 10), mk(4, 10), mk(0.4, -10), mk(0.1, 50), mk(1, 0), mk(2, 5)];
  const s = replaySummary(trips, 0.1, sizing);
  assert.equal(s.skippedSmall, 1, 'the 0.1 SOL buy is not copied');
  assert.equal(s.copied, 5);
  assert.ok(Math.abs(s.spentSol - (0.05 + 0.1 + 0.1 + 0.1 + 0.1)) < 1e-9, `spent ${s.spentSol}`);
  const fixed = replaySummary(trips, 0.1);
  assert.equal(fixed.skippedSmall, 0);
  assert.equal(fixed.copied, 6, 'a fixed size copies every priced trade');
  // The 0.05 copy of the +10 % trade pays a bigger share in fees than a 0.1 one.
  const small = replaySummary([mk(0.2, 10), mk(0.2, 10), mk(0.2, 10), mk(0.2, 10), mk(0.2, 10)], 0.1, sizing);
  const big = replaySummary([mk(4, 10), mk(4, 10), mk(4, 10), mk(4, 10), mk(4, 10)], 0.1, sizing);
  assert.ok(small.medianPct < big.medianPct, `fees weigh more on a smaller copy: ${small.medianPct} vs ${big.medianPct}`);
  ok('sized by their trade, each copy is its share at its own fees, and too-small shares are skipped');
}

{
  // Sampling and the swap checks (2026-10-25): a board label prices a random
  // sample, repeatable from its seed; wash trades and shared payers come from
  // the swaps alone; a trip is marked against its coin's birth.
  const trips = Array.from({ length: 50 }, (_, i) => ({ mint: 'm' + i, openedAt: i, closedAt: i + 1, cost: 1, pnl: 0, holdMs: 60_000, entryPx: null, exitPx: null, returnPct: null, note: 'unpriced', openSlot: 1000 + i }));
  assert.deepEqual(sampleTrips(trips, 3, 'newest').map((t) => t.openedAt), [49, 48, 47], 'newest: the last three, newest first');
  const a = sampleTrips(trips, 10, 'random', sampleSeed('W:1'));
  const b = sampleTrips(trips, 10, 'random', sampleSeed('W:1'));
  const c = sampleTrips(trips, 10, 'random', sampleSeed('W:2'));
  assert.deepEqual(a.map((t) => t.openedAt), b.map((t) => t.openedAt), 'the same seed gives the same sample');
  assert.notDeepEqual(a.map((t) => t.openedAt), c.map((t) => t.openedAt), 'a different day, a different sample');
  assert.equal(new Set(a.map((t) => t.openedAt)).size, 10, 'without replacement');
  assert.ok(a.every((t, i) => i === 0 || a[i - 1].openedAt > t.openedAt), 'newest first');
  assert.equal(sampleTrips(trips.slice(0, 4), 10, 'random', 7).length, 4, 'fewer than asked come back whole');
  // Over many seeds every trip is drawn about equally often: uniform, not "newest".
  const hits = new Array(50).fill(0);
  for (let s = 0; s < 2_000; s++) for (const t of sampleTrips(trips, 10, 'random', s)) hits[t.openedAt] += 1;
  assert.ok(Math.min(...hits) > 300 && Math.max(...hits) < 500, `each trip drawn about 400 of 2,000 times: ${Math.min(...hits)}–${Math.max(...hits)}`);

  const W = 'Wa11et11111111111111111111111111111111111111';
  const swaps = [
    { mint: 'A', isBuy: true, sol: 1, tokens: 10, at: 1, tx: 't1' },
    { mint: 'A', isBuy: false, sol: 1, tokens: 10, at: 1, tx: 't1' },
    { mint: 'B', isBuy: true, sol: 1, tokens: 10, at: 2, tx: 't2', payer: 'Other1' },
    { mint: 'B', isBuy: false, sol: 1, tokens: 10, at: 3, tx: 't3', payer: 'Other2' },
    { mint: 'C', isBuy: true, sol: 1, tokens: 10, at: 4, tx: 't4', payer: 'Other1' },
    { mint: 'C', isBuy: false, sol: 1, tokens: 10, at: 4, tx: 't5' },
    { mint: 'D', isBuy: true, sol: 1, tokens: 10, at: 5 },
  ];
  assert.deepEqual(swapChecks(swaps, W), { washTrips: 1, sharedPayers: 2 }, 'A is bought and sold in t1; two other wallets paid fees; a buy and a sell in different transactions in the same second is not a wash');
  const birth = { slot: 500, index: 3, tx: 'createtx', creator: 'Creator1' };
  const mk = (over) => ({ mint: 'M', openedAt: 0, closedAt: 1, cost: 1, pnl: 0, holdMs: 60_000, entryPx: null, exitPx: null, returnPct: null, note: 'unpriced', ...over });
  const inCreate = mk({ openSlot: 500, openTx: 'createtx', openIndex: 3 });
  markBirth(inCreate, birth, W);
  assert.deepEqual([inCreate.sinceBirth, inCreate.bundle], [0, true], 'bought inside the launch transaction');
  const after = mk({ openSlot: 500, openTx: 'x', openIndex: 3 + BUNDLE_AFTER_CREATE });
  markBirth(after, birth, W);
  assert.equal(after.bundle, true, 'the fourth transaction after the launch, same slot');
  const fifth = mk({ openSlot: 500, openTx: 'y', openIndex: 3 + BUNDLE_AFTER_CREATE + 1 });
  markBirth(fifth, birth, W);
  assert.equal(fifth.bundle, false, 'the fifth is not (0 of 139 further down were)');
  const nextSlot = mk({ openSlot: 501, openTx: 'z', openIndex: 0 });
  markBirth(nextSlot, birth, W);
  assert.deepEqual([nextSlot.sinceBirth, nextSlot.bundle], [1, false], 'one slot later: a snipe, not a bundle');
  const paid = mk({ openSlot: 700, openTx: 'p', openIndex: 9, openPayer: 'Creator1' });
  markBirth(paid, birth, W);
  assert.equal(paid.bundle, true, 'the creator paid for the buy, whenever it landed');
  const late = mk({ openSlot: 900, openTx: 'q', openIndex: 1 });
  markBirth(late, birth, W);
  assert.deepEqual([late.sinceBirth, late.bundle], [400, false]);
  const noSlot = mk({ openTx: 'createtx' });
  markBirth(noSlot, birth, W);
  assert.equal(noSlot.bundle, undefined, 'without a slot nothing is claimed');
  assert.equal(recordedMedian([mk({ returnPct: 1 }), mk({ returnPct: 2 }), mk({ returnPct: 3 }), mk({ returnPct: 4 })]), null, 'no median under five');
  assert.equal(recordedMedian([mk({ returnPct: 5 }), mk({ returnPct: 1 }), mk({ returnPct: 3 }), mk({ returnPct: 2 }), mk({ returnPct: 4 }), mk({ returnPct: null })]), 3);
  ok('a random sample is uniform and repeatable; wash, shared payer, snipe and bundle are read from the swaps and the birth');
}

{
  // The job with the checks on (2026-10-25): a random sample, the births
  // read once per coin inside the allowance and billed, and the status
  // carrying the checks.
  job._reset();
  const W = 'Chk111111111111111111111111111111111111111111'.slice(0, 44);
  const T = 1_700_000_000_000;
  const mkSwap = (mint, isBuy, at, slot, tx, extra = {}) => ({ mint, isBuy, sol: 1, tokens: 1000, at, slot, tx, ...extra });
  const swaps = [];
  // Twelve coins; the wallet opens coin i at slot 1000·i + i (0..11 slots after the birth at 1000·i).
  for (let i = 0; i < 12; i++) {
    swaps.push(mkSwap('c' + i, true, T + i * 60_000, 1000 * i + i, 'b' + i, { txIndex: i === 0 ? 2 : 50 }));
    swaps.push(mkSwap('c' + i, false, T + i * 60_000 + 30_000, 1000 * i + i + 140, 's' + i));
  }
  let left = 100_000;
  const births = [];
  const deps = {
    sleep: async () => {},
    swapsOf: () => swaps,
    read: async () => assert.fail('no second read'),
    priceAt: async () => ({ price: null, failed: false, message: 'no trade' }),
    chainPrice: async () => ({ ok: true, entry: 1, exit: 1.1, calls: 1, credits: 10, cached: false, message: 'ok' }),
    chainCreditsLeft: () => left,
    billBacktest: (c) => {
      left -= c;
    },
    mintBirth: async (_u, mint) => {
      births.push(mint);
      const i = Number(mint.slice(1));
      return { ok: true, birth: { slot: 1000 * i, index: 1, tx: i === 0 ? 'b0' : 'create' + i, creator: 'Dev' + i }, calls: 1, credits: 10, cached: false, message: 'ok' };
    },
  };
  assert.equal(job.start(W, 'https://mainnet.helius-rpc.com/?api-key=x', deps, T + 10_000_000, { sample: 'random', max: 8, checks: true }).ok, true);
  await job.wait(W);
  const st = job.status(W);
  assert.equal(st.sample, 'random');
  assert.equal(st.tripsFound, 12);
  assert.equal(st.toPrice, 8, 'eight of twelve sampled');
  assert.equal(births.length, 8, 'one birth read per sampled coin');
  assert.equal(new Set(births).size, 8);
  const c = st.checks;
  assert.ok(c, 'the checks ran');
  assert.equal(c.mintsChecked, 8);
  assert.equal(c.credits, 80, 'ten credits a birth');
  assert.equal(left, 100_000 - 8 * 10 - 8 * 10, 'pricing and births both billed');
  // Coin i opened i slots after its birth: snipes are i <= SNIPER_SLOTS (5); coin 0 opened INSIDE the create transaction.
  const sampled = st.trips.map((t) => Number(t.mint.slice(1)));
  assert.equal(c.sniperTrips, sampled.filter((i) => i <= 5).length, 'opened within five slots of the birth');
  assert.equal(c.bundleTrips, sampled.includes(0) ? 1 : 0, 'coin 0 was bought in the launch transaction itself');
  for (const t of st.trips) assert.equal(t.sinceBirth, Number(t.mint.slice(1)), 'each trip knows its distance from the birth');
  // A spent allowance stops the births but keeps what was checked.
  job._reset();
  left = 25;
  births.length = 0;
  assert.equal(job.start(W, 'https://mainnet.helius-rpc.com/?api-key=x', { ...deps, chainPrice: async () => ({ ok: true, entry: 1, exit: 1, calls: 1, credits: 0, cached: true, message: 'cached' }) }, T + 10_000_000, { sample: 'random', max: 8, checks: true }).ok, true);
  await job.wait(W);
  const st2 = job.status(W);
  assert.equal(births.length, 0, 'under forty credits left, no birth is asked for');
  assert.deepEqual([st2.checks.mintsChecked, st2.checks.credits], [0, 0]);
  // Without a Helius endpoint the checks stop at the swaps.
  job._reset();
  left = 100_000;
  const washy = [...swaps, mkSwap('w', true, T, 5, 'same'), mkSwap('w', false, T, 5, 'same')];
  assert.equal(job.start(W, 'http://rpc.example', { ...deps, swapsOf: () => washy, chainPrice: undefined }, T + 10_000_000, { checks: true }).ok, true);
  await job.wait(W);
  const st3 = job.status(W);
  assert.deepEqual([st3.checks.washTrips, st3.checks.mintsChecked], [1, 0], 'the wash trade is counted; no birth without a Helius key');
  assert.equal(st3.sample, 'newest');
  ok('a label replay samples at random, reads each coin’s birth once inside the allowance, and reports the checks');
}

{
  job._reset();
  const W = 'Rep1ay11111111111111111111111111111111111111';
  const swaps = [
    // P: a copy in at 1.0, out at 1.2.
    sw('P', true, 1, 1000, T),
    sw('P', false, 1.3, 1000, T + 120_000),
    // F: too fast — no calls spent on it.
    sw('F', true, 1, 1000, T + 200_000),
    sw('F', false, 1.1, 1000, T + 200_500),
    // N: pump has no trade then (not a pump coin) — unpriced, not a failure.
    sw('N', true, 1, 1000, T + 300_000),
    sw('N', false, 2, 1000, T + 400_000),
    // X: the provider is parked — unpriced, and said once.
    sw('X', true, 1, 1000, T + 500_000),
    sw('X', false, 2, 1000, T + 600_000),
  ];
  const asked = [];
  let slept = 0;
  const deps = {
    sleep: async (ms) => {
      slept += ms;
    },
    cooldownMs: () => 30_000,
    swapsOf: () => swaps,
    read: async () => assert.fail('a fresh read was there; no second read'),
    priceAt: async (mint, at) => {
      asked.push([mint, at]);
      if (mint === 'P') return at === T + 2_000 ? { price: 1.0, at: T + 1_000 } : { price: 1.2, at: T + 121_000 };
      if (mint === 'N') return { price: null, failed: false, message: 'no trade before then' };
      return { price: null, failed: true, message: 'pumpswap: rate limited' };
    },
  };
  const r = job.start(W, 'http://rpc', deps);
  assert.equal(r.ok, true);
  assert.equal(job.start(W, 'http://rpc', deps).ok, false, 'one replay per wallet at a time');
  await job.wait(W);
  const st = job.status(W);
  assert.equal(st.running, false);
  assert.equal(st.phase, 'done');
  assert.equal(st.tripsFound, 4);
  assert.equal(st.toPrice, 4);
  assert.equal(st.priced, 4);
  assert.deepEqual(
    st.trips.map((t) => [t.mint, t.note]),
    [
      ['X', 'unpriced'],
      ['N', 'unpriced'],
      ['F', 'too-fast'],
      ['P', 'filled'],
    ],
    'newest first; only the priced one is filled',
  );
  const p = st.trips.find((t) => t.mint === 'P');
  assert.ok(Math.abs(p.returnPct - replayReturn(1.0, 1.2)) < 1e-9);
  assert.deepEqual(
    asked.filter(([m]) => m === 'P').map(([, at]) => at),
    [T + 2_000, T + 122_000],
    'each leg priced 2 s after theirs',
  );
  assert.ok(!asked.some(([m]) => m === 'F'), 'no call spent on a too-fast trip');
  assert.equal(asked.filter(([m]) => m === 'N').length, 1, 'no exit call when the entry could not be priced');
  assert.equal(asked.filter(([m]) => m === 'X').length, 4, 'a rate-limited leg is waited out and asked again, three times, then left');
  assert.equal(slept, 3 * 30_000, 'each wait is the park the provider set');
  assert.equal(st.waitingUntil, null);
  assert.match(st.message, /did not answer for some coins/, 'a provider that stays shut is said, once');
  assert.equal(st.calls, asked.length);
  ok('the job prices each leg 2 s behind, spends nothing on too-fast trips, and says when the provider failed');
}

{
  job._reset();
  const W = 'Rep1ay22222222222222222222222222222222222222';
  let reads = 0;
  let have = null;
  const deps = {
    swapsOf: () => have,
    read: async () => {
      reads += 1;
      have = [sw('Q', true, 1, 1000, T + 10_000)];
      return { ok: true, message: '' };
    },
    priceAt: async () => assert.fail('nothing to price'),
  };
  job.start(W, 'http://rpc', deps);
  await job.wait(W);
  const st = job.status(W);
  assert.equal(reads, 1, 'no fresh read: it reads first');
  assert.equal(st.tripsFound, 0);
  assert.equal(st.open, 1);
  assert.match(st.message, /still open/);
  assert.equal(job.start('not-an-address', 'http://rpc', deps).ok, false);
  ok('with no fresh read it reads first, and an open position is said, not priced');
}

{
  // A 429 mid-replay (measured 10-23: ~25 calls, then a 60 s park) is waited
  // out, and the leg is priced on the next ask.
  job._reset();
  const W = 'Rep1ay33333333333333333333333333333333333333';
  let n = 0;
  const deps = {
    sleep: async () => {},
    cooldownMs: () => 60_000,
    swapsOf: () => [sw('R', true, 1, 1000, T), sw('R', false, 1.3, 1000, T + 120_000)],
    read: async () => assert.fail('no read'),
    priceAt: async () => (++n === 1 ? { price: null, failed: true, message: 'pumpswap: rate limited (429) — pausing 60s' } : { price: 1, at: T }),
  };
  job.start(W, 'http://rpc', deps);
  await job.wait(W);
  const st = job.status(W);
  assert.equal(st.trips[0].note, 'filled', 'priced after the wait');
  assert.equal(st.calls, 3, 'the refused ask, the retried entry, the exit');
  assert.equal(st.message, '');
  ok('a rate-limited price is waited out and asked again, not left unpriced');
}

{
  // A replay over a window at several lags (2026-10-25, the pre-registered
  // test): only trips opened inside [since, until), each priced at every lag
  // from one chain read, the usual lag as the trip's own figure, and never
  // the swap API — it knows no slots.
  job._reset();
  const W = 'Lags1111111111111111111111111111111111111111';
  const sws = (mint, isBuy, sol, at, slot) => ({ mint, isBuy, sol, tokens: 1000, at, slot });
  const mk = (mint, i) => [sws(mint, true, 1, T + i * 100_000, 100 * i + 10), sws(mint, false, 1.1, T + i * 100_000 + 60_000, 100 * i + 50)];
  const swaps = [...mk('A', 1), ...mk('B', 2), ...mk('C', 3), ...mk('D', 4)];
  const asked = [];
  const deps = {
    sleep: async () => {},
    cooldownMs: () => 0,
    swapsOf: () => swaps,
    read: async () => assert.fail('no read'),
    priceAt: async () => assert.fail('a lagged replay never asks the swap API'),
    chainPrice: async () => assert.fail('the lagged read is used'),
    chainPriceLags: async (_u, mint, o, c, lags) => {
      asked.push([mint, o, c, [...lags]]);
      return { ok: true, at: Object.fromEntries(lags.map((l) => [l, { entry: 1, exit: 1 + l * 0.01 }])), calls: 1, credits: 10, cached: false, message: '' };
    },
    chainCreditsLeft: () => 100_000,
    billBacktest: () => {},
  };
  const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=x';
  assert.equal(job.start(W, HELIUS, deps, T + 10_000_000, { since: T + 200_000, until: T + 400_000, lags: [0, 4, 9] }).ok, true);
  await job.wait(W);
  const st = job.status(W);
  assert.equal(st.tripsFound, 2, 'only trips opened inside the window');
  assert.deepEqual(st.trips.map((t) => t.mint).sort(), ['B', 'C']);
  assert.equal(asked.length, 2);
  assert.deepEqual([...asked[0][3]].sort((a, b) => a - b), [0, 4, 9], 'the asked lags, the usual one among them');
  for (const t of st.trips) {
    assert.equal(t.source, 'chain');
    assert.deepEqual(Object.keys(t.atLag).sort(), ['0', '4', '9']);
    assert.ok(Math.abs(t.atLag['9'] - replayReturn(1, 1.09)) < 1e-9);
    assert.ok(Math.abs(t.returnPct - t.atLag['9']) < 1e-9, 'the trip’s own figure is the usual lag’s');
    assert.ok(t.atLag['0'] < t.atLag['9'], 'each lag its own figure');
  }
  assert.equal(st.priced, 2);
  // A window with nothing in it says so.
  job._reset();
  assert.equal(job.start(W, HELIUS, deps, T + 10_000_000, { since: T + 900_000, until: T + 950_000, lags: [9] }).ok, true);
  await job.wait(W);
  assert.equal(job.status(W).tripsFound, 0);
  assert.match(job.status(W).message, /window/);
  // Without the lagged read, a lagged request prices the usual lag only — from the chain, still never the swap API.
  job._reset();
  const plain = { ...deps, chainPriceLags: undefined, chainPrice: async () => ({ ok: true, entry: 1, exit: 1.2, calls: 1, credits: 10, cached: false, message: '' }) };
  assert.equal(job.start(W, HELIUS, plain, T + 10_000_000, { lags: [0, 9] }).ok, true);
  await job.wait(W);
  const st3 = job.status(W);
  assert.equal(st3.trips.filter((t) => t.source === 'chain').length, 4);
  assert.ok(st3.trips.every((t) => t.atLag === undefined), 'no lag figures without the lagged read');
  ok('a replay over a window at several lags: the chain only, the usual lag as the figure, the rest beside it');
}

// ── The whole-week check (2026-10-28) ─────────────────────────────────

{
  // The week figures: mean, mean without the best five, what the best five
  // and the rest made, and the days — all from the same sized copies as the
  // total, so they add up to it.
  const DAY = 86_400_000;
  const day0 = replayDayOf(T);
  const mk = (r, d, i) => ({ mint: 'W' + i, openedAt: day0 + d * DAY + 3_600_000, closedAt: day0 + d * DAY + 7_200_000, cost: 1, pnl: 0, holdMs: 3_600_000, entryPx: 1, exitPx: 1, returnPct: r, note: 'filled' });
  const rets = [200, 150, 100, 80, 60, -10, -10, -10, -10, -10, -10, -10];
  const trips = rets.map((r, i) => mk(r, i % 3, i));
  const s = replaySummary(trips, 0.5);
  assert.equal(s.copied, 12);
  assert.ok(s.meanPct !== null && s.trimmedMeanPct !== null);
  assert.ok(s.trimmedMeanPct < 0 && s.meanPct > 0, 'the tail carries the mean; without it the copies lose');
  assert.ok(s.bestSol > 0 && s.restSol < 0);
  assert.ok(Math.abs(s.bestSol + s.restSol - s.totalSol) < 1e-9, 'best five plus the rest is the total');
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days.map((d) => d.day), [day0, day0 + DAY, day0 + 2 * DAY], 'oldest first, local midnights');
  assert.equal(s.days.reduce((n, d) => n + d.copies, 0), 12);
  assert.ok(Math.abs(s.days.reduce((a, d) => a + d.totalSol, 0) - s.totalSol) < 1e-9, 'the days add up to the total');
  const v = replayVerdict(s, true);
  assert.equal(v.kind, 'tail');
  assert.match(v.text, /only because of the best 5 copies/);
  // Under ten copies: no trimmed mean, no split, no verdict.
  const few = replaySummary(trips.slice(0, 9), 0.5);
  assert.equal(few.trimmedMeanPct, null);
  assert.equal(few.bestSol, null);
  assert.equal(replayVerdict(few, true), null);
  // A losing week says so, with its days.
  const lost = replaySummary(rets.map((_, i) => mk(-20, i % 4, i)), 0.5);
  const lv = replayVerdict(lost, true);
  assert.equal(lv.kind, 'loss');
  assert.match(lv.text, /^Copying lost −\d+\.\d{3} SOL over the week at this size, over 12 copies — 0 of 4 days positive\.$/);
  // Positive without the tail, spread over days: positive. On one day only: oneDay.
  const good = replaySummary(rets.map((_, i) => mk(40, i % 4, i)), 0.5);
  assert.equal(replayVerdict(good, true).kind, 'positive');
  const lumpy = replaySummary(rets.map((_, i) => mk(i < 8 ? 100 : -1, i < 8 ? 0 : 1 + (i % 2), i)), 0.5);
  const lumpyV = replayVerdict(lumpy, true);
  assert.ok(lumpy.restSol > 0);
  assert.equal(lumpyV.kind, 'oneDay');
  // The credit ceiling is the read plus every trip at its ceiling.
  assert.equal(REPLAY_WEEK_CREDITS_MAX, (REPLAY_WEEK_READ_LIMIT / 100) * 10 + REPLAY_WEEK_MAX_TRIPS * REPLAY_TRIP_CREDITS_MAX);
  ok('a replay sums the week: mean, mean without the best five, best five and the rest, by day, and says which kind of week it was');
}

{
  // The week job: a read deep enough for the week, only trips opened inside
  // it, newest first, and the slow fallback capped with the rest counted.
  job._reset();
  const W = 'Week1111111111111111111111111111111111111111';
  const now = T + 30 * 86_400_000;
  const o = job.weekOpts(now, true);
  assert.equal(o.span, 'week');
  assert.equal(o.since, now - REPLAY_WEEK_MS);
  assert.equal(o.max, REPLAY_WEEK_MAX_TRIPS);
  assert.equal(o.slowMax, REPLAY_WEEK_SLOW_MAX);
  assert.deepEqual(o.read, { limit: REPLAY_WEEK_READ_LIMIT, days: 7 });
  assert.equal(o.checks, true);
  const swaps = [];
  // Three trips opened 8–10 days ago, five inside the week; each held 2 min.
  for (let i = 0; i < 8; i++) {
    const at = i < 3 ? now - (10 - i) * 86_400_000 : now - (8 - i) * 86_400_000 + 3_600_000;
    swaps.push(sw('M' + i, true, 1, 1000, at), sw('M' + i, false, 1.2, 1000, at + 120_000));
  }
  let have = null;
  const sinceAsked = [];
  const readAsked = [];
  const deps = {
    sleep: async () => {},
    swapsOf: (_a, since) => {
      sinceAsked.push(since);
      return have;
    },
    read: async (_a, _u, opts) => {
      readAsked.push(opts);
      have = swaps;
      return { ok: true, message: '' };
    },
    priceAt: async () => ({ price: 1, at: now }),
  };
  assert.equal(job.start(W, 'http://rpc', deps, now, { ...o, checks: false, slowMax: 2 }).ok, true);
  await job.wait(W);
  const st = job.status(W);
  assert.equal(sinceAsked[0], now - REPLAY_WEEK_MS, 'a week check asks for a read that reaches the week');
  assert.deepEqual(readAsked[0], { limit: REPLAY_WEEK_READ_LIMIT, days: 7 }, 'and reads that deep when there is none');
  assert.equal(st.span, 'week');
  assert.equal(st.tripsFound, 5, 'only the trips opened inside the week');
  assert.equal(st.toPrice, 5);
  assert.equal(st.trips.filter((t) => t.note === 'filled').length, 2, 'the slow path priced its cap');
  assert.equal(st.slowSkipped, 3, 'the rest counted, not guessed');
  assert.equal(st.priced, 5, 'progress reaches the end');
  assert.match(st.message, /3 trades the chain could not price were left unpriced — the slow fallback stops at 2 in a week check/);
  assert.equal(st.weekShort ?? null, null, 'a read that covers the week says nothing more');
  // 2026-10-28: a read that still does not cover the week (rate limits) is
  // used, and the check says it is not the whole week, with the read's why.
  job._reset();
  have = null;
  const short = {
    ...deps,
    swapsOf: (_a, since) => (since === undefined ? have : null),
    readNote: () => 'Some transactions could not be read — RPC HTTP 429.',
  };
  assert.equal(job.start(W, 'http://rpc', short, now, { ...o, checks: false, slowMax: 2 }).ok, true);
  await job.wait(W);
  assert.equal(job.status(W).weekShort, 'Not the whole week: the chain read reached back 10 days only (Some transactions could not be read — RPC HTTP 429). These figures are for that part of the week.');
  // The newest-thirty check never asks for a week's reach.
  job._reset();
  sinceAsked.length = 0;
  assert.equal(job.start(W, 'http://rpc', deps, now).ok, true);
  await job.wait(W);
  assert.equal(sinceAsked[0], undefined);
  assert.equal(job.status(W).span, 'newest');
  assert.equal(job.status(W).slowSkipped, 0);
  ok('a week check reads deep enough, prices only the week, caps the slow fallback and counts what it left');
}

console.log(`\ncopyreplay: ${passed}/${passed} passed`);
