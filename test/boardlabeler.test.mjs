// The board labeler (2026-10-25): the chain's word on the ranked wallets.
// Who it picks (the ranked top, a random fifth of the rest, fresh labels
// kept, as many as the allowance covers), what a label says (the week's
// chain trips, an unbiased median, how much the record saw, the dead share
// of what it missed, the checks), and a run with fake deps.

import assert from 'node:assert/strict';
import * as lab from './.boardlabeler.mjs';
import { hardExclusions } from './.walletscout.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const addr = (i) => `W${String(i).padStart(3, '0')}${'1'.repeat(40)}`;
const row = (i, over = {}) => ({
  chain: 'solana',
  address: addr(i),
  fShrunkPct: -5 - i * 0.1,
  copyScore: 50,
  ranked: true,
  looksAutomated: false,
  reachablePct: 80,
  medianHoldMs: 90_000,
  fastPct: 0,
  spanDays: 7,
  activeDays: 5,
  createdCoins: 0,
  sizeSol: 0.1,
  buys: 10,
  sells: 10,
  chainLabel: null,
  ...over,
});

{
  const rows = Array.from({ length: 40 }, (_, i) => row(i));
  // random(): the first five of the rest are drawn, the other five are not.
  let n = 0;
  const random = () => (n++ < 5 ? 0.1 : 0.9);
  const c = lab.choose(rows, 1_000_000, NOW, random);
  assert.equal(c.eligible, 40);
  assert.equal(c.picked.length, lab.LABEL_RANKED_N + 5, 'the ranked thirty and the five the draw kept');
  assert.deepEqual(c.picked.slice(0, 3), [addr(0), addr(1), addr(2)], 'ranked first, in rank order');
  assert.equal(c.budgetCut, 0);
  // A creator is still labelled (the board's other filters apply; the label's own does not).
  const withCreator = lab.choose([row(0, { createdCoins: 2 }), row(1)], 1_000_000, NOW, () => 0.9);
  assert.deepEqual(withCreator.picked, [addr(0), addr(1)], 'a creator is checked too — "clean" is what the label decides');
  const withBot = lab.choose([row(0, { looksAutomated: true }), row(1)], 1_000_000, NOW, () => 0.9);
  assert.deepEqual(withBot.picked, [addr(1)], 'a bot is not worth the credits');
  // A fresh label is kept; a day-old one is redone.
  const fresh = lab.choose([row(0, { chainLabel: { at: NOW - 3_600_000, chainTrips: 5 } }), row(1, { chainLabel: { at: NOW - lab.LABEL_FRESH_MS - 1, chainTrips: 5 } })], 1_000_000, NOW, () => 0.9);
  assert.deepEqual(fresh.picked, [addr(1)]);
  assert.equal(fresh.skippedFresh, 1);
  // The allowance caps the run.
  const tight = lab.choose(rows, lab.LABEL_CREDITS_PER_WALLET * 3 + 5, NOW, () => 0.9);
  assert.equal(tight.picked.length, 3);
  assert.equal(tight.budgetCut, lab.LABEL_RANKED_N - 3);
  assert.deepEqual(lab.choose([], 1_000_000, NOW, () => 0).picked, []);
  ok('choose: the ranked top, a random fifth of the rest, fresh labels kept, bots skipped, as many as the allowance covers');
}

{
  const trip = (mint, closedAt, cost, pnl, over = {}) => ({ mint, openedAt: closedAt - 60_000, closedAt, cost, pnl, holdMs: 60_000, entryPx: null, exitPx: null, returnPct: null, note: 'unpriced', ...over });
  // The week on the chain: 10 trips, 4 of them dead; the record saw 5 (2 of the dead ones are among the unseen).
  const built = [
    trip('old', NOW - 9 * DAY, 1, 0.5), // outside the week
    trip('a', NOW - 6 * DAY, 1, 0.1),
    trip('b', NOW - 5 * DAY, 1, -0.9), // dead, unseen
    trip('c', NOW - 5 * DAY + 1000, 1, 0.2),
    trip('d', NOW - 4 * DAY, 1, -0.95), // dead, seen
    trip('e', NOW - 3 * DAY, 1, 0.3),
    trip('f', NOW - 3 * DAY + 1000, 1, -0.86), // dead, unseen
    trip('g', NOW - 2 * DAY, 1, 0.0),
    trip('h', NOW - 2 * DAY + 1000, 1, -0.2),
    trip('i', NOW - 1 * DAY, 1, 0.4),
    trip('j', NOW - 1 * DAY + 1000, 1, -0.99), // dead, seen
  ];
  const seen = ['a', 'c', 'd', 'i', 'j'];
  const wallet = {
    chain: 'solana',
    address: addr(1),
    firstSeen: NOW - 10 * DAY,
    lastSeen: NOW,
    days: [
      { day: Math.floor((NOW - 1 * DAY) / DAY), roundTrips: 2 },
      { day: Math.floor((NOW - 4 * DAY) / DAY), roundTrips: 1 },
      { day: Math.floor((NOW - 6 * DAY) / DAY), roundTrips: 2 },
      { day: Math.floor((NOW - 20 * DAY) / DAY), roundTrips: 7 }, // outside the week
    ],
    openCount: 0,
    openCost: 0,
    medianHoldMs: 60_000,
    recentTrips: built.filter((t) => seen.includes(t.mint)).map((t) => ({ mint: t.mint, closedAt: t.closedAt, openedAt: t.openedAt, cost: t.cost, pnl: t.pnl, holdMs: t.holdMs, followerReturnPct: null, followerNote: 'unpriced' })),
  };
  const replay = {
    toPrice: 6,
    trips: [trip('a', 0, 1, 0, { note: 'filled', returnPct: -10 }), trip('c', 0, 1, 0, { note: 'filled', returnPct: -4 }), trip('e', 0, 1, 0, { note: 'filled', returnPct: 3 }), trip('g', 0, 1, 0, { note: 'filled', returnPct: -20 }), trip('i', 0, 1, 0, { note: 'filled', returnPct: -7 }), trip('b', 0, 1, 0)],
    credits: 330,
    checks: { washTrips: 1, sharedPayers: 0, sniperTrips: 2, bundleTrips: 1, mintsChecked: 6, credits: 60 },
  };
  const l = lab.labelFrom(replay, built, wallet, NOW);
  assert.equal(l.at, NOW);
  assert.equal(l.chainTrips, 10, 'the week, not the whole read');
  assert.equal(l.sampled, 6);
  assert.equal(l.priced, 5);
  assert.equal(l.medianPct, -7, 'the median of the five priced');
  assert.equal(l.coveragePct, 50, 'the record had 5 of the chain’s 10');
  assert.equal(l.unseenDeadPct, 40, '2 of the 5 unseen trips were dead coins');
  assert.deepEqual([l.washTrips, l.sharedPayers, l.sniperTrips, l.bundleTrips, l.mintsChecked, l.credits], [1, 0, 2, 1, 6, 330]);
  assert.deepEqual(hardExclusions({ chainLabel: l }), ['bundle', 'sniper'], 'one bundle buy; 2 snipes of 6 checked is 33 %');
  // A record whose recent-trip list is full and all inside the week cannot say what it missed.
  const full = { ...wallet, recentTrips: Array.from({ length: 12 }, (_, i) => ({ mint: 'x' + i, closedAt: NOW - i * 3_600_000, openedAt: 0, cost: 1, pnl: 0, holdMs: 0, followerReturnPct: null, followerNote: 'unpriced' })) };
  assert.equal(lab.labelFrom(replay, built, full, NOW).unseenDeadPct, null, 'capped list, whole week unseen-able: unknown, not 0');
  assert.deepEqual([lab.labelFrom(replay, null, null, NOW).chainTrips, lab.labelFrom(replay, null, null, NOW).coveragePct], [0, null], 'no built trips: nothing claimed');
  ok('labelFrom: the week’s chain trips, the sample’s median, coverage against the record, the dead share of what it missed, and the checks');
}

{
  lab._reset();
  const rows = Array.from({ length: 4 }, (_, i) => row(i));
  const labels = new Map();
  let credits = 5_000;
  const replayed = [];
  const deps = {
    rows: () => rows,
    wallet: () => null,
    builtTrips: () => null,
    creditsLeft: () => credits,
    setLabel: (a, l) => {
      labels.set(a, l);
      return true;
    },
    chainOk: () => true,
    random: () => 0.9,
    now: () => NOW,
    async replay(address, opts) {
      replayed.push([address, opts]);
      credits -= 400;
      const bundle = address === addr(2);
      return {
        address,
        running: false,
        phase: 'done',
        toPrice: 30,
        tripsFound: 50,
        trips: Array.from({ length: 30 }, (_, i) => ({ mint: 'm' + i, note: 'filled', returnPct: -i, closedAt: NOW, openedAt: NOW, cost: 1, pnl: 0, holdMs: 1 })),
        credits: 400,
        checks: { washTrips: 0, sharedPayers: 0, sniperTrips: 0, bundleTrips: bundle ? 1 : 0, mintsChecked: 25, credits: 100 },
      };
    },
  };
  assert.equal(lab.start({ ...deps, chainOk: () => false }).ok, false, 'no Helius key, no run');
  const r = lab.start(deps);
  assert.equal(r.ok, true);
  assert.equal(lab.start(deps).ok, false, 'one run at a time');
  await lab.wait();
  const st = lab.status();
  assert.equal(st.running, false);
  assert.equal(st.total, 4);
  assert.equal(st.done, 4);
  assert.equal(st.labelled, 4);
  assert.equal(st.excluded, 1, 'the bundler');
  assert.equal(st.credits, 1_600);
  assert.deepEqual(replayed[0][1], { sample: 'random', max: lab.LABEL_SAMPLE, checks: true }, 'a random sample with the checks');
  assert.equal(labels.get(addr(2)).bundleTrips, 1);
  assert.equal(labels.get(addr(0)).medianPct, -14.5);
  // The allowance runs out mid-run: what was checked stands, the rest is said.
  lab._reset();
  credits = lab.LABEL_CREDITS_PER_WALLET * 2 + 10;
  labels.clear();
  const r2 = lab.start(deps);
  assert.equal(r2.ok, true);
  await lab.wait();
  const st2 = lab.status();
  assert.equal(st2.total, 2, 'the allowance covered two');
  assert.match(st2.message, /covers 2/);
  // Nothing eligible says so and finishes at once.
  lab._reset();
  const r3 = lab.start({ ...deps, rows: () => [] });
  assert.equal(r3.ok, true);
  assert.equal(lab.status().running, false);
  assert.match(lab.status().message, /Nothing to check/);
  ok('a run labels the chosen wallets two at a time, counts the excluded, stops inside the allowance, and says why it did less');
}

console.log(`\nboardlabeler: ${passed}/${passed} passed`);
