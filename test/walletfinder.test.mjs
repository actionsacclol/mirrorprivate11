// The wallet finder and the money-safety fixes of 2026-10-22
// (docs/wallet-finder-research-2026-10-22.md, roadmap items 1–3).
//
//   • a live copy is never smaller than the fee floor, and a new wallet does
//     not put the app in Live;
//   • the live feed reaches the Wallet Scout with the disk recorder off — it
//     did not, and "Record live" recorded nothing;
//   • the book has two tiers, so the flood of new addresses cannot push a
//     wallet with a record off it; trade ids are remembered for hours and
//     across a restart;
//   • the numbers only claim what was measured: no Copy score without a
//     follower return, no "100% copyable" on one trip, no "trades most days"
//     verdict before the market was watched that many days, and a wallet's
//     own history never prices its copy.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_LIVE_COPY_SOL, defaultConfig, paperExitPnl, paperSideCost, validateConfig } from './.copyshared.mjs';
import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_MAX_CANDIDATES,
  SCOUT_REGULAR_DAYS,
  copyCostModel,
  dayOf,
  passesScoutFilter,
  rankScout,
  shortlist,
  summarise,
  tradeId,
} from './.walletscout.mjs';
import { FOLLOWER_COST_PER_SIDE, RECORDED_POPULATION_MEDIAN_PCT, SHRINK_TRIPS, followerNetReturnPct, repriceReturn, scoreWallet } from './.walletscore.mjs';

/** The return the Scout records (1.5 %/side) for a trip at price ratio g. */
const grossToRecorded = (g) => ((g * (1 - FOLLOWER_COST_PER_SIDE)) / (1 + FOLLOWER_COST_PER_SIDE) - 1) * 100;
import * as scout from './.walletscoutstore.mjs';

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok   ${name}`);
};
const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const LEADER = '7Ngr8xZ2bRwMwnX6zYJpKZrY4o8fQ4Rk3wq2cTRuQ9Ue';
const NOW = Date.now();

// ── 1. The live minimum ───────────────────────────────────────────────
{
  assert.equal(MIN_LIVE_COPY_SOL, 0.03, 'the fast lane floor: 0.003 SOL of round-trip priority fees is 10% of 0.03');
  const base = defaultConfig(LEADER, 'x', 'solana', 'copy');
  const live = (over) => validateConfig({ ...base, mode: 'live', ...over });
  assert.equal(live({ sizing: 'fixed', sizeValue: 0.01, maxTradeSol: 0.1 }).ok, false, 'a live 0.01 SOL copy is refused');
  assert.match(live({ sizing: 'fixed', sizeValue: 0.01, maxTradeSol: 0.1 }).message, /smallest live copy is 0\.03 SOL/);
  assert.equal(live({ sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 }).ok, true, '0.05 is fine');
  assert.equal(live({ sizing: 'proportional', sizeValue: 10, maxTradeSol: 0.02 }).ok, false, 'a proportional copy capped under the floor can never be sent');
  assert.equal(validateConfig({ ...base, mode: 'paper', sizing: 'fixed', sizeValue: 0.01, maxTradeSol: 0.1 }).ok, true, 'paper is not held to it');
  const evm = defaultConfig('0x' + 'ab'.repeat(20), 'x', 'robinhood', 'copy');
  assert.equal(validateConfig({ ...evm, mode: 'live', sizing: 'fixed', sizeValue: 0.01, maxTradeSol: 0.1 }).ok, true, 'EVM chains have their own gas, not this floor');

  // And at the last gate, for a proportional copy that sizes below it.
  const ct = src('electron/engine/copyTrade.ts');
  const cap = ct.indexOf('is above your live cap of');
  const floor = ct.indexOf('base.ourSol < MIN_LIVE_COPY_SOL');
  const buy = ct.indexOf('await h.buy(t.mint, base.ourSol');
  assert.ok(cap > 0 && floor > cap && buy > floor, 'the floor is checked after the cap and before the live buy');
  assert.match(ct.slice(floor, floor + 400), /record\(\{ \.\.\.base, reason:/, 'a refusal is recorded, never a raise');
  ok('a live Solana copy under 0.03 SOL is refused on save and at the last gate; paper and EVM are not');
}

{
  const types = src('shared/types.ts');
  assert.match(types, /liveEnabled: false,/, 'Paper is the default');
  const onboarding = src('src/components/Onboarding.tsx');
  assert.doesNotMatch(onboarding, /Once this wallet exists the app is in Live mode/, 'onboarding no longer says a wallet turns Live on');
  ok('creating a wallet leaves the app in Paper');
}

// ── 2. The live feed reaches the Scout ─────────────────────────────────
{
  const eng = src('electron/engine/engine.ts');
  // Two feed calls since 2026-10-23: every curve trade, and PumpSwap swaps on
  // coins the book is in (so a trip that graduates closes).
  assert.equal((eng.match(/scout\.note\(/g) ?? []).length, 2, 'two feed calls: the curve and PumpSwap');
  const rt = eng.indexOf('private recordTape(');
  const rtEnd = eng.indexOf('\n  }\n', rt);
  assert.ok(rt > 0 && !eng.slice(rt, rtEnd).includes('scout.note('), 'not inside recordTape(), which runs only with the disk recorder on');
  const gate = eng.indexOf('if (recorder.wantsTape()) this.recordTape(events, n);');
  const call = eng.indexOf('scout.note(', gate);
  assert.ok(gate > 0 && call > gate && call - gate < 1500, 'right after the recorder gate, in the decode path, for every trade');
  const amm = eng.indexOf('private onAmmLogs(');
  const ammCall = eng.indexOf('scout.note(', amm);
  assert.ok(amm > 0 && ammCall > amm && ammCall < gate, 'the second is in the PumpSwap handler');
  assert.match(eng.slice(ammCall - 200, ammCall), /scout\.wantsMint\('solana', mint\)/, 'only for coins the book is in');
  ok('every decoded pump trade reaches the Wallet Scout, recorder on or off; PumpSwap swaps on its coins do too');
}

// ── 3. Two tiers ────────────────────────────────────────────────────────
{
  scout._reset();
  // A wallet with a record: promoted, then six closed trips.
  const R = 'RankedWallet1111111111111111111111111111111';
  scout.note('solana', R, 'a', true, 0.1, 1000, NOW - 9_000);
  scout.note('solana', R, 'b', true, 0.1, 1000, NOW - 9_000);
  for (let i = 0; i < 6; i++) {
    scout.note('solana', R, 'r' + i, true, 0.1, 1000, NOW - 8_000);
    scout.note('solana', R, 'r' + i, false, 0.12, 1000, NOW - 7_000);
  }
  // A saved candidate.
  const S = 'SavedThinWallet111111111111111111111111111';
  for (let i = 0; i < 3; i++) scout.note('solana', S, 's' + i, true, 0.1, 1000, NOW - 6_000);
  scout.setSaved('solana', S, true);
  // The flood: more three-trade addresses than the candidate tier holds.
  const N = SCOUT_MAX_CANDIDATES + 50;
  for (let k = 0; k < N; k++) {
    const a = `Flood${k}`;
    for (let i = 0; i < 3; i++) scout.note('solana', a, 'f', true, 0.01, 10, NOW - 5_000 + k);
  }
  const have = new Set(scout.wallets('solana').map((w) => w.address));
  assert.ok(have.has(R), 'the ranked wallet survives the flood');
  assert.ok(have.has(S), 'a saved candidate is never evicted');
  assert.ok(!have.has('Flood0'), 'the least recently touched candidate went');
  assert.ok(have.has(`Flood${N - 1}`), 'the newest is kept');
  assert.ok(scout.counts('solana').tracked <= SCOUT_MAX_CANDIDATES + 2, 'the candidate tier holds its cap');
  ok('the candidate tier is capped on its own: the flood cannot evict a ranked or saved wallet');
}

{
  // Sightings: past the bound the OLDER half goes, not all of it.
  scout._reset();
  const A = 'AlmostPromoted111111111111111111111111111';
  for (let k = 0; k < 199_998; k++) scout.note('solana', `S${k}`, 'm', true, 0.01, 10, NOW);
  scout.note('solana', A, 'm', true, 0.01, 10, NOW);
  scout.note('solana', A, 'm', true, 0.01, 10, NOW);
  scout.note('solana', 'OneMore', 'm', true, 0.01, 10, NOW); // the map is now full
  scout.note('solana', 'TwoMore', 'm', true, 0.01, 10, NOW); // the bound trips
  assert.ok(scout.counts('solana').watching < 110_000, 'the older half went');
  scout.note('solana', A, 'm2', true, 0.01, 10, NOW);
  assert.ok(scout.wallets('solana').some((w) => w.address === A), 'a recent address keeps its count and is promoted on its third trade');
  ok('a full sightings map drops its older half, not every count');
}

{
  // Trade ids: remembered, and across a restart.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-scout-'));
  scout._reset();
  scout.init(dir);
  const id = tradeId('sig1', 'm', LEADER, true);
  assert.equal(scout.note('solana', LEADER, 'm', true, 0.1, 1000, NOW, id), 'noted');
  assert.equal(scout.note('solana', LEADER, 'm', true, 0.1, 1000, NOW, id), 'duplicate');
  scout.flushSync();
  assert.ok(fs.existsSync(path.join(dir, 'wallet-scout-seen.bin')), 'saved on quit');
  scout._reset();
  scout.init(dir);
  assert.equal(scout.note('solana', LEADER, 'm', true, 0.1, 1000, NOW, id), 'duplicate', 'still known after a restart');
  assert.equal(scout.note('solana', LEADER, 'm', true, 0.1, 1000, NOW, tradeId('sig2', 'm', LEADER, true)), 'noted');
  // A broken file is a cache miss, never a crash.
  fs.writeFileSync(path.join(dir, 'wallet-scout-seen.bin'), Buffer.from([1, 2, 3]));
  scout._reset();
  scout.init(dir);
  assert.equal(scout.failure(), null);
  assert.equal(scout.note('solana', LEADER, 'm', true, 0.1, 1000, NOW, id), 'noted', 'an unreadable cache starts empty');
  scout._reset();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(scout.txHash('a'), scout.txHash('b'));
  assert.ok(Number.isSafeInteger(scout.txHash(id)), 'a 53-bit hash');
  ok('trade ids are kept as hashes, for hours, and across a restart');
}

{
  // Hold times survive a restart as themselves, not as a median that may
  // have been null: a scalper with two holds saved and two more after a
  // restart has a known median, so "Holds over a minute" can hide it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-scout-'));
  scout._reset();
  scout.init(dir);
  const Q = 'QuickScalper111111111111111111111111111111';
  scout.note('solana', Q, 'w0', true, 0.1, 1000, NOW - 50_000);
  scout.note('solana', Q, 'w1', true, 0.1, 1000, NOW - 50_000);
  for (let i = 0; i < 2; i++) {
    scout.note('solana', Q, 'q' + i, true, 0.1, 1000, NOW - 40_000);
    scout.note('solana', Q, 'q' + i, false, 0.1, 1000, NOW - 27_000);
  }
  assert.equal(scout.wallets('solana').find((w) => w.address === Q).medianHoldMs, null, 'two holds: no median yet');
  scout.persist();
  scout._reset();
  scout.init(dir);
  for (let i = 2; i < 4; i++) {
    scout.note('solana', Q, 'q' + i, true, 0.1, 1000, NOW - 20_000);
    scout.note('solana', Q, 'q' + i, false, 0.1, 1000, NOW - 7_000);
  }
  assert.equal(scout.wallets('solana').find((w) => w.address === Q).medianHoldMs, 13_000, 'two saved + two new = a median');
  scout._reset();
  fs.rmSync(dir, { recursive: true, force: true });
  ok('hold times are saved themselves, so a restart does not blank the median');
}

// ── 4. A wallet's own history never prices its copy ───────────────────
{
  scout._reset();
  const H = 'HistoryWallet111111111111111111111111111111';
  const t0 = NOW - 3_600_000;
  // Two sightings promote it; the third trade onward is on the book.
  scout.note('solana', H, 'p0', true, 0.1, 1000, t0 - 2, undefined, true);
  scout.note('solana', H, 'p1', true, 0.1, 1000, t0 - 1, undefined, true);
  for (let i = 0; i < 3; i++) scout.note('solana', H, 'h' + i, true, 0.1, 1000, t0 + i, undefined, true);
  // Sells a minute later — and a buy+sell inside one second.
  for (let i = 0; i < 3; i++) scout.note('solana', H, 'h' + i, false, 0.15, 1000, t0 + 60_000 + i, undefined, true);
  scout.note('solana', H, 'q', true, 0.1, 1000, t0 + 100_000, undefined, true);
  scout.note('solana', H, 'q', false, 0.1, 1000, t0 + 100_500, undefined, true);
  const w = scout.wallets('solana').find((x) => x.address === H);
  const notes = w.recentTrips.map((t) => t.followerNote).sort();
  assert.deepEqual(notes, ['too-fast', 'unpriced', 'unpriced', 'unpriced'], 'priced nowhere; a trip over inside the lag is still too fast — that is timing, not price');
  const unreachable = w.days.reduce((a, d) => a + (d.unreachable ?? 0), 0);
  assert.equal(unreachable, 1, 'only the too-fast trip counts against reach');
  assert.equal(w.days.reduce((a, d) => a + (d.fTrips ?? 0), 0), 0, 'no follower fills');
  assert.deepEqual(scout.observedDays('solana'), [], 'a one-wallet read is not watching the market');
  ok('"Read from chain" trips are not priced for a copier, and do not count as watched days');
}

// ── 5. Numbers that only claim what was measured ───────────────────────
{
  const base = { roundTrips: 10, reachablePct: 90, judgedTrips: 10, activeDays: 5, windowDays: 7, distinctMints: 10, looksAutomated: false };
  assert.equal(scoreWallet({ ...base, fTrips: 2, fMedianReturnPct: null, fWinRatePct: null }).score, null, 'reach, days and focus alone are no score');
  assert.equal(scoreWallet({ ...base, fTrips: 6, fMedianReturnPct: -2, fWinRatePct: 40 }).score, null, 'six copies: the return is not resolved yet');
  assert.notEqual(scoreWallet({ ...base, fTrips: 12, fMedianReturnPct: -2, fWinRatePct: 40 }).score, null);
  ok('no Copy score until the follower return is measured on ten copies');
}

// ── 6. One cost model with paper, and the "least bad" ranking ──────────
{
  // A flat trip recorded at 1.5 %/side (−2.96 %) repriced the paper way.
  const flat = followerNetReturnPct(1, 1);
  const noFixed = repriceReturn(flat, copyCostModel('solana', null));
  assert.ok(Math.abs(noFixed - -3.5) < 0.01, `swap fees only: 1.75 % a side, ${noFixed}`);
  const at005 = repriceReturn(flat, copyCostModel('solana', 0.05));
  assert.ok(Math.abs(at005 - noFixed - -7.0) < 0.05, `plus ~7 % of a 0.05 SOL copy in network fees: ${at005}`);
  const at025 = repriceReturn(flat, copyCostModel('solana', 0.25));
  assert.ok(at025 > at005, 'a bigger copy loses a smaller share to fixed fees');
  assert.equal(copyCostModel('bnb', 0.05).fixedPct, 0, 'EVM gas is not modelled, so not charged');
  // The same numbers paper uses (shared/copytrade.ts).
  assert.equal(copyCostModel('solana', 0.05).side, paperSideCost('solana'));
  const paper = paperExitPnl(0.05, 1, 1, 1, 'solana') / 0.05 * 100;
  assert.ok(Math.abs(paper - repriceReturn(grossToRecorded(1), copyCostModel('solana', 0.05))) < 1e-9, `the board and paper agree on a trip: ${paper}`);
  ok('the board prices a copy the way paper does, at the picked size');
}

{
  const today = dayOf(NOW);
  const day = (over) => ({ day: today, buys: 20, sells: 20, roundTrips: 20, wins: 10, losses: 10, pnl: 1, volume: 2, fWins: 0, unreachable: 0, fast: 0, measured: 20, ...over });
  const wallet = (address, fReturns) => ({
    chain: 'solana', address, firstSeen: NOW - 86_400_000, lastSeen: NOW, openCount: 0, openCost: 0, medianHoldMs: 300_000, distinctMints: 20, recentTrips: [], observedDays: [today],
    days: [day({ fTrips: fReturns.length, fReturns })],
  });
  // Five lucky copies at +50 % against twelve steady ones at −1 %.
  const lucky = summarise(wallet('Lucky', [48, 49, 50, 51, 52]), 'week', NOW);
  const steady = summarise(wallet('Steady', Array(12).fill(-1)), 'week', NOW);
  assert.equal(lucky.fShrunkPct, null, 'five copies are shown, never ranked');
  assert.equal(lucky.copyScore, null);
  assert.ok(lucky.fMedianReturnPct > 30, 'but the measured median is still shown');
  const prior = repriceReturn(RECORDED_POPULATION_MEDIAN_PCT, copyCostModel('solana', 0.05));
  const med = repriceReturn(-1, copyCostModel('solana', 0.05));
  assert.ok(Math.abs(steady.fShrunkPct - (12 * med + SHRINK_TRIPS * prior) / (12 + SHRINK_TRIPS)) < 1e-9, '(n·median + 10·market) ÷ (n + 10)');
  const ranked = rankScout([lucky, steady], 'fShrunkPct');
  assert.equal(ranked[0].address, 'Steady', 'twelve steady copies outrank five lucky ones');
  assert.deepEqual(shortlist([lucky, steady], 5).map((r) => r.address), ['Steady'], 'only a ranked wallet is suggested');
  // The board ranks on the LOWER bound of that figure (2026-10-25): under
  // the shrunk median by 0.84 standard errors, so a thin record sits lower.
  assert.ok(steady.fLowerPct < steady.fShrunkPct, 'the bound is under the shrunk median');
  assert.equal(lucky.fLowerPct, null, 'and null wherever the shrunk median is');
  assert.equal(rankScout([lucky, steady], 'fLowerPct')[0].address, 'Steady');
  ok('"least bad" ranks on the lower bound of the median pulled toward the market; under ten copies is never ranked');
}

{
  const d = src('src/pages/Discover.tsx');
  assert.match(d, /value: 'best',[\s\S]{0,60}sort: 'fLowerPct'/, 'Best to copy ranks on the lower bound');
  for (const f of ['src/pages/Follow.tsx', 'src/pages/Home.tsx']) {
    const s = src(f);
    assert.match(s, /scout\.top\('solana', 'week', 'fLowerPct'/, `${f} asks for the same ranking`);
    assert.match(s, /shortlistVerdict\(r\.data\.rows/, `${f} suggests with the board's rule, and carries its verdict`);
  }
  ok('the board, the Follow page and Home suggest by one rule');
}

{
  const today = dayOf(NOW);
  const day = (d, over = {}) => ({ day: d, buys: 0, sells: 0, roundTrips: 0, wins: 0, losses: 0, pnl: 0, volume: 0, fTrips: 0, fWins: 0, fReturns: [], unreachable: 0, fast: 0, measured: 0, ...over });
  const wallet = (days, observedDays) => ({ chain: 'solana', address: LEADER, firstSeen: NOW - 6 * 86_400_000, lastSeen: NOW, days, openCount: 0, openCost: 0, medianHoldMs: 120_000, distinctMints: 5, recentTrips: [], observedDays });

  // One judged trip is not "100% copyable".
  let r = summarise(wallet([day(today, { roundTrips: 1, fTrips: 1, buys: 1, sells: 1 })], [today]), 'week', NOW);
  assert.equal(r.reachablePct, null);
  r = summarise(wallet([day(today, { roundTrips: 6, fTrips: 5, unreachable: 1, buys: 6, sells: 6 })], [today]), 'week', NOW);
  assert.ok(Math.abs(r.reachablePct - (5 / 6) * 100) < 1e-9, 'from five judged trips it is a share');
  ok('"Copyable" is a dash under five judged trips');

  // "Trades most days" waits for the market to be watched that many days.
  const busy = day(today, { roundTrips: 6, buys: 6, sells: 6 });
  r = summarise(wallet([busy], [today]), 'week', NOW);
  assert.equal(r.spanDays, 1);
  assert.equal(passesScoutFilter(r, 'regular'), true, 'one watched day: unknown, and unknown never hides a row');
  r = summarise(wallet([busy], [today - 3, today - 2, today - 1, today]), 'week', NOW);
  assert.equal(r.spanDays, 4);
  assert.equal(passesScoutFilter(r, 'regular'), false, `watched ${SCOUT_REGULAR_DAYS}+ days and active on one: hidden`);
  // A day of buys alone is not an active day.
  r = summarise(wallet([busy, day(today - 1, { buys: 3 })], [today - 1, today]), 'week', NOW);
  assert.equal(r.activeDays, 1);
  // No median hold (a record restored before holds were saved): the share of
  // trips over inside a minute decides "Holds over a minute" instead.
  const quick = { ...wallet([day(today, { roundTrips: 6, buys: 6, sells: 6, fast: 5, measured: 6 })], [today]), medianHoldMs: null };
  assert.equal(passesScoutFilter(summarise(quick, 'week', NOW), 'slowEnough'), false, '5 of 6 under a minute is fast, median or not');
  const slow = { ...wallet([day(today, { roundTrips: 6, buys: 6, sells: 6, fast: 1, measured: 6 })], [today]), medianHoldMs: null };
  assert.equal(passesScoutFilter(summarise(slow, 'week', NOW), 'slowEnough'), true);
  // A record from before the watched-days list keeps the calendar span.
  r = summarise(wallet([busy], undefined), 'week', NOW);
  assert.equal(r.spanDays, 7);
  ok('"Trades most days" and active days count only what was watched and finished');
}

{
  // A trip is won or lost on its whole result, not its last sell.
  scout._reset();
  const W = 'PartialSeller11111111111111111111111111111';
  scout.note('solana', W, 'x', true, 0.1, 1000, NOW);
  scout.note('solana', W, 'y', true, 0.1, 1000, NOW);
  scout.note('solana', W, 'm', true, 1, 1000, NOW);
  scout.note('solana', W, 'm', false, 2, 500, NOW + 60_000); // +1.5
  scout.note('solana', W, 'm', false, 0.4, 500, NOW + 120_000); // −0.1 on the last leg
  const w = scout.wallets('solana').find((x) => x.address === W);
  const d = w.days.reduce((a, b) => ({ wins: a.wins + b.wins, losses: a.losses + b.losses }), { wins: 0, losses: 0 });
  assert.deepEqual(d, { wins: 1, losses: 0 });
  scout._reset();
  ok('a trip that took profit and dumped the rest at a small loss is a win');
}

assert.ok(MIN_TRIPS_FOR_RANK === 5);
console.log(`\nwalletfinder: ${passed}/${passed} passed`);
