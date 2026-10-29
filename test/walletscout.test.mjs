// Wallet Scout — the windowing and the ranking.
//
// This is a leaderboard, and a leaderboard is exactly where a small sample or
// a bot at the top does real damage: someone reads it and copies a wallet with
// their own money. The rules pinned here are the ones that stop it lying.

import assert from 'node:assert';
import {
  neverSignsFrom,
  NEVER_SIGNS_MIN_READ,
  NEVER_SIGNS_MIN_UNSIGNED,
  BOT_TRADES_PER_MIN,
  MIN_TRIPS_FOR_RANK,
  SCOUT_FILTERS,
  SCOUT_FILTER_TEXT,
  SCOUT_MAX_TRACKED,
  SCOUT_REACHABLE_MIN_PCT,
  SCOUT_REGULAR_DAYS,
  SCOUT_RETENTION_DAYS,
  SCOUT_FAST_WALLET_PCT,
  SCOUT_SLOW_ENOUGH_MS,
  SOLANA_SCAN_GAP_MS,
  SOLANA_SCAN_MAX_PAGES,
  SOLANA_SCAN_MAX_TOKENS,
  anyScoutFilter,
  applyScoutFilters,
  dayOf,
  looksAutomated,
  passesScoutFilter,
  rankScout,
  rotate,
  scoutFiltersAllOff,
  scoutFiltersAllOn,
  summarise,
  tradeId,
  pickWinnerCoins,
  SCOUT_TRIMMED_MIN_COPIES,
  WINNERS_SCAN_RUNNERS,
  WINNERS_SCAN_YOUNG,
  WINNERS_SCAN_MAX_COINS,
  SCAN_PAGE_CREDITS,
  recentScanCredits,
  winnersCoinCredits,
  winnersCoinsAffordable,
  winnersScanCredits,
  SCOUT_LARGE_SIZE_SOL,
  SCOUT_MAYHEM_MIN_TRIPS,
  SCOUT_MAYHEM_SHARE_PCT,
  SCOUT_PICKS_N,
  SCOUT_PICK_KEEP_DAYS,
  SCOUT_RECORD_MIN_COPIES,
  SCOUT_WARNING_TEXT,
  boardRecord,
  scoutWarnings,
  HARD_EXCLUSION_TEXT,
  SNIPER_SHARE_PCT,
  SNIPER_SLOTS,
  clearsFloor,
  hardExclusions,
  shortlistVerdict,
  boardWeeks,
  weekOf,
  winsorisedMean,
  MARK_HORIZONS_S,
  SCOUT_RANK_SORT,
  priorWalletOf,
  scorecard,
  shortlist,
  snapshotRow,
  snapshotVariants,
  walletKey8,
} from './.walletscout.mjs';
import { COPY_LATENCY_FLOOR_MS } from './.copyshared.mjs';
import * as scout from './.walletscoutstore.mjs';

let passed = 0;
// The Solana scan's pace, as the Scout page states it, must equal the
// `pumpswap` provider gap in electron/data/http.ts (pinned there at 2 s,
// http.test.mjs) — swap-api.pump.fun blocks an IP for ~35 s past roughly
// 22 requests in a short window (measured 2026-09-21), and a page promising
// a faster scan than the provider allows would be a promise the app breaks.
assert.equal(SOLANA_SCAN_GAP_MS, 2_000, 'the page states the pace http.ts enforces');
assert.equal(SOLANA_SCAN_MAX_TOKENS, 60);
assert.equal(SOLANA_SCAN_MAX_PAGES, 3);
// What the page prices each scan at (2026-10-27): the figures on the
// Discover buttons and the allowance bar, from the same constants the
// sources reserve against. The page price itself is pinned to the RPC
// client's bill in scoutscan.test.mjs.
assert.equal(SCAN_PAGE_CREDITS, 10);
assert.equal(recentScanCredits(), 1_800, 'a recent scan: 60 tokens, 3 pages, 10 credits a page');
assert.equal(winnersCoinCredits(), 2_000, 'a winners coin: 200 pages');
assert.equal(winnersScanCredits(WINNERS_SCAN_MAX_COINS), 48_000);
assert.equal(winnersCoinsAffordable(5_000), 2);
assert.equal(winnersCoinsAffordable(1_999), 0);
assert.equal(winnersCoinsAffordable(-5), 0);
assert.equal(winnersCoinsAffordable(1e9), WINNERS_SCAN_MAX_COINS, 'never more coins than the scan reads');
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// Noon TODAY, not a fixed date: the store rotates days out against the real
// clock (SCOUT_RETENTION_DAYS), so a fixture pinned to 2026-09-10 aged out of
// its own retention window six weeks later and the cap test failed with
// "setup: it is ranked" (2026-10-22).
const NOW = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})();
const TODAY = dayOf(NOW);

const day = (offset, over = {}) => ({
  day: TODAY - offset,
  buys: 2,
  sells: 2,
  roundTrips: 2,
  wins: 1,
  losses: 1,
  pnl: 1,
  volume: 10,
  ...over,
});

const wallet = (days, over = {}) => ({
  chain: 'solana',
  address: '0xw',
  firstSeen: NOW - 86_400_000 * 30,
  lastSeen: NOW,
  days,
  openCount: 0,
  openCost: 0,
  medianHoldMs: null,
  ...over,
});

{
  // A window is a sum of the days inside it, and nothing outside.
  const w = wallet([day(0), day(1), day(3), day(9), day(40)]);
  assert.equal(summarise(w, 'day', NOW).roundTrips, 2, 'today is one bucket');
  assert.equal(summarise(w, 'week', NOW).roundTrips, 6, 'seven days covers offsets 0,1,3');
  assert.equal(summarise(w, 'month', NOW).roundTrips, 8, 'thirty days adds offset 9');
  assert.equal(summarise(w, 'all', NOW).roundTrips, 10, 'all time adds offset 40');
  ok('a window sums exactly the days inside it');
}

{
  // The sample floor. Two lucky trades must not sit above a real record.
  const thin = summarise(wallet([day(0, { roundTrips: 2, wins: 2, losses: 0, pnl: 500 })]), 'day', NOW);
  assert.equal(thin.ranked, false, `${MIN_TRIPS_FOR_RANK} trips are needed to rank`);
  assert.equal(thin.winRatePct, null, 'and a win rate off two trades is not reported at all');

  const solid = summarise(wallet([day(0, { roundTrips: 10, wins: 6, losses: 4, pnl: 1 })]), 'day', NOW);
  assert.equal(solid.ranked, true);
  assert.equal(solid.winRatePct, 60);

  const ordered = rankScout([thin, solid], 'pnl');
  assert.equal(ordered[0].roundTrips, 10, 'the ranked wallet outranks the huge thin one');
  ok('a thin sample cannot top the board, however profitable it looks');
}

{
  // Return is unknown when nothing was spent — not 0%.
  const nothing = summarise(wallet([day(0, { volume: 0, pnl: 0, buys: 0, sells: 1 })]), 'day', NOW);
  assert.equal(nothing.returnPct, null, 'no volume means no return to report');
  const real = summarise(wallet([day(0, { volume: 10, pnl: 2, roundTrips: 5, wins: 3, losses: 2 })]), 'day', NOW);
  assert.equal(real.returnPct, 20);
  ok('return is null without volume, and a real ratio with it');
}

{
  // Bots. The LP swarm's number-one liquidity provider was a JIT bot holding
  // positions for one block; a PnL board here will surface snipers the same
  // way, and they are not copyable by a person clicking a button.
  assert.equal(looksAutomated(4_000, 40), true, 'fast and frequent is automated');
  assert.equal(looksAutomated(4_000, 3), false, 'fast but rare is too small a sample to call');
  assert.equal(looksAutomated(600_000, 500), false, 'frequent but patient is a person');
  assert.equal(looksAutomated(null, 500), false, 'unknown hold time is never called a bot');

  const bot = { ...summarise(wallet([day(0, { roundTrips: 40, wins: 30, losses: 10, pnl: 900 })], { medianHoldMs: 3_000 }), 'day', NOW) };
  const human = { ...summarise(wallet([day(0, { roundTrips: 10, wins: 6, losses: 4, pnl: 5 })], { medianHoldMs: 900_000 }), 'day', NOW) };
  assert.equal(bot.looksAutomated, true);
  const ordered = rankScout([bot, human], 'pnl');
  assert.equal(ordered[0].address, human.address, 'a human ranks above a more profitable bot');
  assert.equal(ordered[0].pnl, 5, 'and it really is the less profitable one');
  ok('a bot is marked and ranked below a human, however much it made');
}

{
  // The trade-rate rule (2026-10-24). BwWK1 made 156 trades in 87 s over 6
  // closed trips: partial sells kept its median hold out of the hold rule.
  assert.equal(looksAutomated(600_000, 2, BOT_TRADES_PER_MIN), true, 'a minute no hand reaches is automated, whatever the hold');
  assert.equal(looksAutomated(600_000, 2, BOT_TRADES_PER_MIN - 1), false, 'one under the line is a person');
  assert.equal(looksAutomated(600_000, 2, null), false, 'an unmeasured rate is never called a bot');

  scout._reset();
  const SCALP = 'ScaLp1111111111111111111111111111111111111';
  const HAND = 'HaNd11111111111111111111111111111111111111';
  const T0 = NOW - 3_600_000;
  // One coin, then a sell every second: the scalper's ladder.
  for (let i = 0; i < 3; i++) scout.note('solana', SCALP, 'lad', true, 1, 1_000_000, T0 + i * 1_000);
  for (let i = 0; i < 50; i++) scout.note('solana', SCALP, 'lad', false, 0.01, 1_000, T0 + 3_000 + i * 1_000);
  // The rest, much later: one closed trip, an hour-long hold.
  scout.note('solana', SCALP, 'lad', false, 1, 950_000, T0 + 3_600_000);
  // A busy person: a trade every two seconds, thirty to the minute.
  for (let i = 0; i < 60; i++) scout.note('solana', HAND, 'h' + (i % 20), i < 20, 0.1, 1_000, T0 + i * 2_000);
  const rowOf = (a) => summarise(scout.wallets('solana').find((w) => w.address === a), 'day', NOW);
  const s = rowOf(SCALP);
  const h = rowOf(HAND);
  assert.ok(s.peakPerMin >= BOT_TRADES_PER_MIN, `scalper peak ${s.peakPerMin}`);
  assert.equal(s.looksAutomated, true, 'the ladder is flagged although no trip closed fast');
  assert.ok(s.roundTrips < 10, 'and the hold rule could not have caught it');
  assert.equal(h.peakPerMin, 30);
  assert.equal(h.looksAutomated, false, 'thirty a minute is a busy person');

  // A scan's older hour arrives after the live feed, out of order: it is
  // counted where it belongs, not trimmed away by the newer live trades.
  const LATE = 'LaTe111111111111111111111111111111111111111';
  for (let i = 0; i < 3; i++) scout.note('solana', LATE, 'l' + i, true, 0.1, 1_000, NOW - 60_000 + i);
  for (let i = 0; i < 45; i++) scout.note('solana', LATE, 'old' + i, true, 0.1, 1_000, T0 + i * 1_000);
  assert.equal(rowOf(LATE).peakPerMin, 45);
  assert.equal(rowOf(LATE).looksAutomated, true);

  // Saved with the day, so it survives a restart.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutrate-'));
  scout.init(dir);
  scout.persist();
  scout._reset();
  scout.init(dir);
  assert.equal(rowOf(SCALP).looksAutomated, true);
  fs.rmSync(dir, { recursive: true, force: true });
  scout._reset();
  assert.match(SCOUT_FILTER_TEXT.hideBots.why, new RegExp(`${BOT_TRADES_PER_MIN} or more trades inside one minute`), 'the switch states the rule');
  ok('the trade-rate rule flags a laddering scalper, spares a busy person, counts a late scan, and is saved');
}

{
  // Daily rotation: anything past retention is dropped, newest first.
  const days = [day(0), day(5), day(SCOUT_RETENTION_DAYS - 1), day(SCOUT_RETENTION_DAYS), day(400)];
  const kept = rotate(days, NOW);
  assert.equal(kept.length, 3, 'buckets past retention roll off');
  assert.deepEqual(
    kept.map((d) => TODAY - d.day),
    [0, 5, SCOUT_RETENTION_DAYS - 1],
    'and what is left is newest first',
  );
  ok('history rotates daily and keeps the retention window, newest first');
}

{
  // Ranking by a measure nobody has is not a ranking: unknown goes last.
  const withRate = summarise(wallet([day(0, { roundTrips: 8, wins: 4, losses: 4, volume: 10, pnl: 1 })]), 'day', NOW);
  const noVolume = summarise(wallet([day(0, { roundTrips: 8, wins: 8, losses: 0, volume: 0, pnl: 0 })]), 'day', NOW);
  const ordered = rankScout([noVolume, withRate], 'returnPct');
  assert.equal(ordered[0].returnPct, 10, 'a known return sorts above an unknown one');
  assert.equal(ordered[1].returnPct, null);
  ok('an unknown measure sorts last rather than counting as zero');
}

{
  // Your own wallets are never on the leaderboard.
  //
  // This matters more than it looks: the Warmer buys and sells on a schedule
  // across the user's OWN wallets, which produces exactly the round trips this
  // page ranks on. Without this the app would manufacture activity and then
  // present it back as somebody's measured record.
  scout._reset();
  const MINE = 'MyOwnWallet1111111111111111111111111111111';
  const OTHER = 'SomeoneElse1111111111111111111111111111111';
  scout.setOwnAddresses('solana', [MINE]);

  // Enough sightings to be promoted, then a closing sell each.
  for (const who of [MINE, OTHER]) {
    for (let i = 0; i < 4; i++) scout.note('solana', who, 'mint' + i, true, 0.1, 1000, NOW);
    scout.note('solana', who, 'mint0', false, 0.2, 1000, NOW);
  }
  const addrs = scout.wallets('solana').map((w) => w.address.toLowerCase());
  assert.ok(addrs.includes(OTHER.toLowerCase()), 'a stranger is recorded');
  assert.ok(!addrs.includes(MINE.toLowerCase()), 'our own wallet is not');
  assert.equal(scout.isOwn('solana', MINE), true);
  assert.equal(scout.isOwn('solana', OTHER), false);
  ok("the user's own wallets are never recorded, so warming cannot reach the board");
}

{
  // A wallet recorded BEFORE it was known to be ours is purged, not left.
  scout._reset();
  const LATE = 'LaterMineWallet11111111111111111111111111';
  for (let i = 0; i < 4; i++) scout.note('solana', LATE, 'm' + i, true, 0.1, 1000, NOW);
  assert.equal(scout.wallets('solana').length, 1, 'recorded while unknown');
  scout.setOwnAddresses('solana', [LATE]);
  assert.equal(scout.wallets('solana').length, 0, 'and purged once we learn it is ours');
  ok('history recorded before a wallet was known to be ours is purged');
}

{
  // Ownership is per chain, like everything else here.
  scout._reset();
  const A = '0xabc0000000000000000000000000000000000001';
  scout.setOwnAddresses('robinhood', [A]);
  assert.equal(scout.isOwn('robinhood', A), true);
  assert.equal(scout.isOwn('bnb', A), false, 'the same address on another chain is a different question');
  ok('ownership is per chain, like everything else here');
}

{
  // The same trade twice is one trade. The live feed and a manual scan can
  // both carry it; whichever is second is refused.
  scout._reset();
  const A = 'DupWallet111111111111111111111111111111111';
  for (let i = 0; i < 3; i++) scout.note('solana', A, 'p' + i, true, 0.1, 1000, NOW, tradeId('sig' + i, 'p' + i, A, true));
  const id = tradeId('sigBuy', 'x', A, true);
  assert.equal(scout.note('solana', A, 'x', true, 0.5, 1000, NOW, id), 'noted');
  assert.equal(scout.note('solana', A, 'x', true, 0.5, 1000, NOW, id), 'duplicate');
  const w = scout.wallets('solana')[0];
  assert.ok(Math.abs(w.days.reduce((n, d) => n + d.volume, 0) - 0.6) < 1e-9, 'the second copy added nothing');
  assert.equal(w.openCount, 2, 'and opened nothing');
  // The id pins one fill inside a transaction: a bundle buying two mints in
  // one signature is two trades, and a sell is not its buy.
  assert.notEqual(tradeId('s', 'm1', A, true), tradeId('s', 'm2', A, true));
  assert.notEqual(tradeId('s', 'm1', A, true), tradeId('s', 'm1', A, false));
  assert.equal(tradeId('s', 'M1', A.toUpperCase(), true), tradeId('s', 'm1', A, true), 'case does not make a new trade');
  assert.equal(scout.note('solana', A, 'y', true, 0.5, 1000, NOW), 'noted', 'a call without an id is never refused');
  ok('a trade carrying an id is recorded once, whichever feed brings it second');
}

{
  // The cap. It used to evict by last-seen alone, so pump's flood of
  // three-trade addresses pushed a wallet with a real record off the book the
  // moment it went quiet — the rows the page exists to find were the ones
  // the bound ate. Thin records go first now.
  scout._reset();
  const RANKED = 'RankedWallet1111111111111111111111111111111';
  const OLD = NOW - 5 * 86_400_000;
  for (let i = 0; i < 3; i++) scout.note('solana', RANKED, 'r' + i, true, 0.1, 1000, OLD);
  for (let i = 3; i < 8; i++) scout.note('solana', RANKED, 'r' + i, true, 0.1, 1000, OLD);
  for (let i = 3; i < 8; i++) scout.note('solana', RANKED, 'r' + i, false, 0.2, 1000, OLD + 1000);
  const before = scout.wallets('solana').find((w) => w.address === RANKED);
  assert.ok(before.days.reduce((n, d) => n + d.roundTrips, 0) >= MIN_TRIPS_FOR_RANK, 'setup: it is ranked');
  for (let n = 0; n < SCOUT_MAX_TRACKED + 25; n++) {
    const thin = `Thin${String(n).padStart(6, '0')}1111111111111111111111111111111`;
    for (let i = 0; i < 3; i++) scout.note('solana', thin, 't' + i, true, 0.1, 1000, NOW);
  }
  // Since 2026-10-22 thin records are a tier of their own with a larger cap
  // (SCOUT_MAX_CANDIDATES, flooded in walletfinder.test.mjs): this flood fits
  // in it whole, and none of it can touch the ranked record.
  assert.equal(scout.counts('solana').tracked, SCOUT_MAX_TRACKED + 25 + 1, 'every thin record is kept in its own tier');
  assert.equal(scout.counts('solana').cap, SCOUT_MAX_TRACKED, 'and the ranked cap is what the page states');
  assert.ok(scout.wallets('solana').some((w) => w.address === RANKED), 'the five-day-old ranked record survived the flood');
  ok('a flood of thin records cannot evict a ranked one, however long the ranked one has been quiet');
}

{
  // A saved wallet is never evicted either, ranked or not.
  scout._reset();
  const KEEP = 'SavedThinWallet111111111111111111111111111';
  for (let i = 0; i < 3; i++) scout.note('solana', KEEP, 'k' + i, true, 0.1, 1000, NOW - 86_400_000);
  scout.setSaved('solana', KEEP, true);
  for (let n = 0; n < SCOUT_MAX_TRACKED + 5; n++) {
    const thin = `Flood${String(n).padStart(6, '0')}111111111111111111111111111111`;
    for (let i = 0; i < 3; i++) scout.note('solana', thin, 't' + i, true, 0.1, 1000, NOW);
  }
  assert.ok(scout.wallets('solana').some((w) => w.address === KEEP));
  ok('a saved wallet survives the cap');
}


// ── The follower's side (2026-09-20, shared/walletScore.ts) ─────────────
//
// A copy fills against the market AS IT STOOD when it was due — the price the
// last print before the leader's trade plus the lag left behind (2026-10-23;
// before, the first print AT OR AFTER it, which skipped the leader's impact
// in quiet coins and dropped dead coins as unreachable). Every trade on a
// mint, by anyone, is a print. Pinned: a print inside the lag IS the market
// the copy meets; a leader out before the copy was due is unreachable; the
// exit fills the same way; a coin that stops printing settles at its last
// mark; the day bucket carries the follower figures; the row's copy figures
// and score come out of them; and it all survives a save.

{
  scout._reset();
  const L = 'Leader11111111111111111111111111111111111111';
  const O = 'Other111111111111111111111111111111111111111';
  const T0 = NOW - 600_000;
  // Promote the leader (three sightings) on unrelated mints first.
  for (let i = 0; i < 3; i++) scout.note('solana', L, 'warm' + i, true, 0.1, 1000, T0 - 100_000 + i);
  // Leader buys M at price 0.001 (1 SOL for 1000 tokens).
  scout.note('solana', L, 'M', true, 1, 1000, T0);
  // A print 1 s later, inside the 2 s lag: the market the copy lands in.
  scout.note('solana', O, 'M', true, 1.1, 1000, T0 + 1_000);
  // The first print past the due time settles the entry at the mark BEFORE
  // it (1.1 per 1000), not at its own 1.2.
  scout.note('solana', O, 'M', true, 1.2, 1000, T0 + 2_500);
  // Leader sells everything 5 minutes later for 2 SOL (their pnl +1).
  scout.note('solana', L, 'M', false, 2, 1000, T0 + 300_000);
  // The exit was due 2 s after that sell; the next print settles it at the
  // market the sell left (2 per 1000), not at its own 1.8.
  scout.note('solana', O, 'M', false, 1.8, 1000, T0 + 302_500);

  const w = scout.wallets('solana').find((x) => x.address === L);
  const d = w.days.find((x) => x.roundTrips === 1);
  assert.ok(d, 'the leader closed one trip');
  assert.equal(d.fTrips, 1, 'the follower could mirror it');
  assert.equal(d.fReturns.length, 1);
  // entry 0.0011, exit 0.0020, 1.5 % each side: (2 x 0.985) / (1.1 x 1.015) - 1 = +76.44 %
  assert.ok(Math.abs(d.fReturns[0] - 76.44) < 0.2, `follower return from the marks it met, net: ${d.fReturns[0]}`);
  assert.equal(d.fWins, 1);
  assert.equal(d.unreachable ?? 0, 0);
  assert.equal(w.recentTrips.length, 1);
  assert.equal(w.recentTrips[0].followerNote, 'filled');
  assert.ok(Math.abs(w.recentTrips[0].pnl - 1) < 1e-9, "the leader's own pnl on the trip");
  assert.equal(w.recentTrips[0].holdMs, 300_000);
  // PROMOTE_AFTER = 3: the first two sightings never reach a book, so of the
  // three warm-up mints only the third is on record — plus M.
  assert.equal(w.distinctMints, 2, 'the promoting warm-up mint and M');
  ok('a follower fills at the market as it stood when each leg was due');
}

{
  scout._reset();
  const L = 'Sniper1111111111111111111111111111111111111';
  const T0 = NOW - 600_000;
  for (let i = 0; i < 3; i++) scout.note('solana', L, 'warm' + i, true, 0.1, 1000, T0 - 100_000 + i);
  // In and out inside the lag: no print could have filled a copy.
  scout.note('solana', L, 'F', true, 1, 1000, T0);
  scout.note('solana', L, 'F', false, 1.5, 1000, T0 + 900);
  // A buy whose only later print is the leader's own sell, 30 s on: the copy
  // was due at +2 s, when the market stood at the leader's buy, so that is
  // its entry; its exit waits for a print, or for the coin to go quiet.
  scout.note('solana', L, 'G', true, 1, 1000, T0 + 10_000);
  scout.note('solana', L, 'G', false, 1.5, 1000, T0 + 40_000);
  const w = scout.wallets('solana').find((x) => x.address === L);
  const trips = w.recentTrips;
  assert.equal(trips.length, 2);
  const f = trips.find((t) => t.mint === 'F');
  const g = trips.find((t) => t.mint === 'G');
  assert.equal(f.followerNote, 'too-fast', 'over before a copy was even due');
  assert.equal(g.followerNote, 'no-exit', 'entered at the mark the leader left, the exit still waiting');
  const d = w.days.find((x) => x.roundTrips === 2);
  assert.equal(d.unreachable, 1, 'the sub-lag trip is unreachable');
  assert.equal(d.fast, 2, 'both trips closed inside a minute');
  assert.equal(d.measured, 2);
  assert.equal(d.fTrips ?? 0, 0, 'nothing is a follower trip until its exit prints');
  const row = summarise(w, 'day', NOW);
  assert.equal(row.judgedTrips, 1, 'the pending exit is not judged yet');
  // One judged trip is not a share (2026-10-22): a dash, not "0 %" — the
  // same rule that stopped one lucky trip reading "100 % copyable".
  assert.equal(row.reachablePct, null, 'one judged trip is under the sample floor');
  // A record written before the model: buckets without the follower fields.
  const legacy = summarise(wallet([day(0, { roundTrips: 12, wins: 6, losses: 6 })]), 'day', NOW);
  assert.equal(legacy.reachablePct, null, 'not measured — never 0 %');
  assert.equal(legacy.fastPct, null);
  assert.equal(legacy.judgedTrips, 0);
  ok('a leader out before the lag is unreachable; an exit waits for a print');
}

{
  scout._reset();
  const L = 'Consistent11111111111111111111111111111111111';
  const O = 'Printer11111111111111111111111111111111111111';
  const T0 = NOW - 3 * 86_400_000;
  for (let i = 0; i < 3; i++) scout.note('solana', L, 'warm' + i, true, 0.1, 1000, T0 - 100_000 + i);
  // Twelve mirrored trips over three days, each one a modest follower loss
  // (twelve: a score needs SCORE_MIN_F_TRIPS = 10 copied trips since 10-22).
  for (let i = 0; i < 12; i++) {
    const t = T0 + i * 6 * 3_600_000;
    const m = 'c' + i;
    // The printer trades inside each lag, so it sets the market the copy
    // meets: in at 1.02, out at 1.0 (the leader made 5 %).
    scout.note('solana', L, m, true, 1, 1000, t);
    scout.note('solana', O, m, true, 1.02, 1000, t + 1_500);
    scout.note('solana', L, m, false, 1.05, 1000, t + 120_000);
    scout.note('solana', O, m, false, 1.0, 1000, t + 121_000);
  }
  // Each mint is its own market: one later print per mint settles that
  // trip's exit at the 1.0 mark the printer left.
  for (let i = 0; i < 12; i++) scout.note('solana', O, 'c' + i, true, 0.5, 500, T0 + i * 6 * 3_600_000 + 130_000);
  const w = scout.wallets('solana').find((x) => x.address === L);
  const row = summarise(w, 'week', NOW);
  assert.equal(row.roundTrips, 12);
  assert.equal(row.fTrips, 12, 'every trip mirrored');
  assert.equal(row.reachablePct, 100);
  // Priced as paper prices it (2026-10-22): 1.75 % a side plus the fast
  // lane's fixed fees, ~7 % of the default 0.05 SOL copy.
  assert.equal(row.sizeSol, 0.05);
  assert.ok(Math.abs(row.fixedCostPct - 7.0) < 0.1, `fixed fees at 0.05 SOL: ${row.fixedCostPct}`);
  assert.ok(row.fMedianReturnPct < -10 && row.fMedianReturnPct > -15, `the copy lost the costs and the fees: ${row.fMedianReturnPct}`);
  const noFixed = summarise(w, 'week', NOW, { sizeSol: null });
  assert.ok(noFixed.fMedianReturnPct < -3 && noFixed.fMedianReturnPct > -7, `swap fees alone: ${noFixed.fMedianReturnPct}`);
  assert.equal(noFixed.copyScore, row.copyScore, 'the score does not move with the size');
  assert.ok(row.fShrunkPct > row.fMedianReturnPct - 10 && row.fShrunkPct < row.fMedianReturnPct, 'pulled toward the market median, which is worse');
  assert.equal(row.fWinRatePct, 0);
  assert.ok(row.pnl > 0, 'while the leader made money — the whole point of scoring the follower');
  assert.equal(typeof row.copyScore, 'number', 'enough trips and checks to score');
  // Under the "good" tone (70). Since 2026-10-22 "active days" is out of the
  // days the market was WATCHED — four here, all of them active — so
  // consistency is full and the score sits in the middle band, not under 60.
  // The follower-return check still holds it out of "good".
  assert.ok(row.copyScore < 70, `a wallet whose copies all lose is not a good copy: ${row.copyScore}`);
  assert.equal(row.spanDays, 4, 'the week window spans the four watched days');
  assert.equal(row.distinctMints, 13, 'the promoting warm-up mint and the twelve trip mints');
  // Twelve trips six hours apart from a noon start touch four calendar days.
  assert.equal(row.activeDays, 4);

  // Persist and reload: the follower figures, mints and trips survive.
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-'));
  scout.init(dir);
  scout.persist();
  scout._reset();
  scout.init(dir);
  const back = scout.wallets('solana').find((x) => x.address === L);
  assert.ok(back, 'the wallet came back');
  const again = summarise(back, 'week', NOW);
  assert.equal(again.fTrips, 12);
  assert.equal(again.fMedianReturnPct, row.fMedianReturnPct);
  assert.equal(again.distinctMints, 13, 'named mints saved for a ranked wallet');
  assert.equal(back.recentTrips.length, 12);
  assert.equal(again.copyScore, row.copyScore);
  fs.rmSync(dir, { recursive: true, force: true });
  ok("the row's copy figures and score come from the buckets, and survive a save");
}

// ── the board's filters (2026-09-21) ─────────────────────────────────────
//
// The board ranked but never filtered, so the first screen was mostly records
// nobody should copy. These pin what each switch means, that every one is off
// until the user says otherwise, and the rule that matters most: an UNKNOWN
// number never hides a wallet.
{
  // One fact, two readers: the Scout's "holds over a minute" switch and copy
  // trading's too-fast flag are the same threshold, and a copier told a wallet
  // is fast enough to follow while the copy page calls it too fast to follow
  // would be the app disagreeing with itself.
  assert.equal(SCOUT_SLOW_ENOUGH_MS, COPY_LATENCY_FLOOR_MS, 'the Scout filter and the copy latency floor are the same number');
  assert.equal(SCOUT_REACHABLE_MIN_PCT, 25, 'the same 25% the unreachable flag uses');
  assert.deepEqual(SCOUT_FILTERS, ['hideBots', 'ranked', 'reachable', 'slowEnough', 'regular', 'clean']);
  for (const k of SCOUT_FILTERS) {
    assert.ok(SCOUT_FILTER_TEXT[k].label.length > 0 && SCOUT_FILTER_TEXT[k].why.length > 20, `${k} says what it hides and why`);
  }
  const off = scoutFiltersAllOff();
  assert.equal(anyScoutFilter(off), false, 'nothing is filtered until the user asks');
  assert.equal(anyScoutFilter(scoutFiltersAllOn()), true);
  assert.equal(
    SCOUT_FILTERS.every((k) => scoutFiltersAllOn()[k]),
    true,
    'the one-click preset turns on every switch, so the button and the chips cannot disagree',
  );
  ok('every switch is off by default, explains itself, and shares its threshold with the rest of the app');
}

{
  const row = (over = {}) => ({
    chain: 'solana',
    address: 'w',
    window: 'week',
    buys: 10,
    sells: 10,
    roundTrips: 10,
    wins: 5,
    losses: 5,
    pnl: 1,
    volume: 10,
    returnPct: 10,
    winRatePct: 50,
    medianHoldMs: 10 * 60_000,
    lastSeen: NOW,
    ranked: true,
    looksAutomated: false,
    fTrips: 8,
    fMedianReturnPct: -2,
    fWinRatePct: 40,
    reachablePct: 80,
    judgedTrips: 10,
    fastPct: 0,
    activeDays: 5,
    distinctMints: 8,
    copyScore: 60,
    flags: [],
    ...over,
  });
  const good = row();
  const bot = row({ address: 'bot', looksAutomated: true });
  const thin = row({ address: 'thin', ranked: false, roundTrips: 2 });
  const locked = row({ address: 'locked', reachablePct: 10 });
  const fast = row({ address: 'fast', medianHoldMs: 6_000 });
  const rare = row({ address: 'rare', activeDays: 1 });
  const unmeasured = row({ address: 'unmeasured', reachablePct: null, medianHoldMs: null });

  assert.equal(passesScoutFilter(good, 'hideBots'), true);
  assert.equal(passesScoutFilter(bot, 'hideBots'), false);
  assert.equal(passesScoutFilter(thin, 'ranked'), false);
  assert.equal(passesScoutFilter(locked, 'reachable'), false);
  assert.equal(passesScoutFilter(fast, 'slowEnough'), false);
  assert.equal(passesScoutFilter(rare, 'regular'), false);
  assert.equal(passesScoutFilter(row({ activeDays: SCOUT_REGULAR_DAYS }), 'regular'), true, 'the threshold is inclusive');
  assert.equal(passesScoutFilter(row({ medianHoldMs: SCOUT_SLOW_ENOUGH_MS }), 'slowEnough'), true);
  assert.equal(passesScoutFilter(row({ reachablePct: SCOUT_REACHABLE_MIN_PCT }), 'reachable'), true);

  // The rule the whole app follows for a missing number: unknown is not a
  // failure. Hiding a wallet whose hold was never measured would claim a fact
  // nobody has.
  assert.equal(passesScoutFilter(unmeasured, 'reachable'), true, 'an unmeasured reachable share never hides a wallet');
  assert.equal(passesScoutFilter(unmeasured, 'slowEnough'), true, 'an unmeasured hold never hides a wallet');

  const all = [good, bot, thin, locked, fast, rare, unmeasured];
  assert.deepEqual(applyScoutFilters(all, scoutFiltersAllOff()).length, all.length, 'no switch on, no row hidden');
  assert.deepEqual(
    applyScoutFilters(all, scoutFiltersAllOn()).map((r) => r.address),
    ['w', 'unmeasured'],
    'every switch on leaves the good record and the unmeasured one, in the order they came',
  );
  assert.deepEqual(
    applyScoutFilters(all, { ...scoutFiltersAllOff(), hideBots: true }).map((r) => r.address),
    ['w', 'thin', 'locked', 'fast', 'rare', 'unmeasured'],
    'one switch hides only what that switch is about',
  );
  // Ranking happens in main; the filter must not reorder what it is handed.
  const ordered = applyScoutFilters([rare, good, bot], { ...scoutFiltersAllOff(), hideBots: true });
  assert.deepEqual(
    ordered.map((r) => r.address),
    ['rare', 'w'],
    'the filter preserves the ranking it was given',
  );
  ok('each switch hides exactly what it names, unknowns survive every switch, and the ranking order is kept');
}

{
  // A Solana address is case-sensitive base58 (2026-10-22). The record used
  // to store it lower-cased, which is a different wallet: Follow, Save and
  // the explorer link on the board all received an address nobody owns.
  scout._reset();
  const SOL = 'CaSeMaTtErSWa11etAddre55xyzABCDEFGHJKLMNPQR';
  for (let i = 0; i < 4; i++) scout.note('solana', SOL, 'c' + i, true, 0.1, 1000, NOW + i);
  const w = scout.wallets('solana')[0];
  assert.equal(w.address, SOL, 'stored as the chain spells it');
  scout.setSaved('solana', SOL, true);
  assert.deepEqual(scout.savedList('solana'), [SOL], 'and saved that way');
  assert.equal(scout.isSaved('solana', SOL.toLowerCase()), true, 'looked up either way');
  // An EVM address is case-insensitive and stays lower-cased.
  const EVM = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  for (let i = 0; i < 4; i++) scout.note('robinhood', EVM, 'e' + i, true, 0.1, 1000, NOW + i);
  assert.equal(scout.wallets('robinhood')[0].address, EVM.toLowerCase());
  // A record from before the fix holds the lower-cased spelling; the next
  // trade seen puts the real one back.
  scout._reset();
  for (let i = 0; i < 4; i++) scout.note('solana', SOL.toLowerCase(), 'l' + i, true, 0.1, 1000, NOW + i);
  assert.equal(scout.wallets('solana')[0].address, SOL.toLowerCase());
  scout.note('solana', SOL, 'l9', true, 0.1, 1000, NOW + 9);
  assert.equal(scout.wallets('solana').length, 1, 'the same wallet, not a second one');
  assert.equal(scout.wallets('solana')[0].address, SOL, 'repaired to the real spelling');
  ok('a Solana wallet keeps its real address; lookups ignore case; an EVM one stays lower-cased');
}

{
  // A coin that dies after the leader leaves: no print ever settles the
  // copy's exit. It used to be dropped as "unreachable", so a wallet that
  // rides coins to zero scored as if those trips never happened. Now the
  // copy is settled at the last mark once the coin has been quiet past
  // FOLLOWER_FILL_STALE_MS (2026-10-23).
  scout._reset();
  const L = 'Rider11111111111111111111111111111111111111';
  const O = 'Other111111111111111111111111111111111111111';
  const T0 = NOW - 3_600_000;
  for (let i = 0; i < 3; i++) scout.note('solana', L, 'warm' + i, true, 0.1, 1000, T0 - 100_000 + i);
  scout.note('solana', L, 'D', true, 1, 1000, T0);
  // Out a minute later at half the price; nothing trades D again.
  scout.note('solana', L, 'D', false, 0.5, 1000, T0 + 60_000);
  let w = scout.wallets('solana').find((x) => x.address === L);
  assert.equal(w.recentTrips.find((t) => t.mint === 'D').followerNote, 'no-exit', 'waiting while the coin may still print');
  // The market moves on elsewhere, well past the stale window.
  for (let i = 0; i < 1_000; i++) scout.note('solana', O, 'elsewhere' + (i % 50), i % 2 === 0, 0.1, 1000, T0 + 700_000 + i);
  w = scout.wallets('solana').find((x) => x.address === L);
  const trip = w.recentTrips.find((t) => t.mint === 'D');
  assert.equal(trip.followerNote, 'filled', 'settled at the price the coin died at');
  // entry 0.001 (the mark the leader's buy left), exit 0.0005: (0.5 x 0.985) / (1 x 1.015) - 1 = -51.48 %
  assert.ok(Math.abs(trip.followerReturnPct - -51.48) < 0.2, `${trip.followerReturnPct}`);
  const d = w.days.find((x) => x.roundTrips >= 1);
  assert.equal(d.unreachable ?? 0, 0, 'not unreachable');
  assert.equal(d.fTrips, 1);
  ok('a coin that stops printing settles the copy at its last mark, never drops it');
}

// ── warnings (2026-10-23) ────────────────────────────────────────────────
//
// Chips, never filters: each rests on one tape. Their thresholds are stated in
// their own text, so a threshold that moves without its words fails here.
{
  assert.ok(SCOUT_WARNING_TEXT.largeSize.why.includes(`${SCOUT_LARGE_SIZE_SOL} SOL`), 'large size states its threshold');
  assert.ok(SCOUT_WARNING_TEXT.mayhem.why.includes(`${SCOUT_MAYHEM_MIN_TRIPS}+`) && SCOUT_WARNING_TEXT.mayhem.why.includes('quarter'), 'mayhem states its rule');
  assert.equal(SCOUT_MAYHEM_SHARE_PCT, 25);
  const base = { createdCoins: 0, mayhemTrips: 0, roundTrips: 10, medianFirstBuy: 0.5 };
  assert.deepEqual(scoutWarnings('solana', base), []);
  assert.deepEqual(scoutWarnings('solana', { ...base, createdCoins: 1 }), ['creator']);
  assert.deepEqual(scoutWarnings('solana', { ...base, mayhemTrips: 3 }), ['mayhem'], '3 of 10 is past a quarter');
  assert.deepEqual(scoutWarnings('solana', { ...base, mayhemTrips: 2, roundTrips: 20 }), [], '2 of 20 is not');
  assert.deepEqual(scoutWarnings('solana', { ...base, mayhemTrips: 1, roundTrips: 2 }), [], 'one trip is not a habit');
  assert.deepEqual(scoutWarnings('solana', { ...base, medianFirstBuy: 2 }), ['largeSize']);
  assert.deepEqual(scoutWarnings('bnb', { ...base, medianFirstBuy: 5 }), [], 'size is a SOL rule');
  // summarise carries them from the buckets and the book.
  const w = { chain: 'solana', address: 'W', firstSeen: NOW, lastSeen: NOW, days: [day(0, { roundTrips: 4, creates: 2, mayhemTrips: 2 })], openCount: 0, openCost: 0, medianHoldMs: 90_000, medianFirstBuy: 3 };
  const r = summarise(w, 'week', NOW);
  assert.deepEqual(r.warnings, ['creator', 'mayhem', 'largeSize']);
  assert.equal(r.createdCoins, 2);
  assert.equal(r.mayhemTrips, 2);
  ok('warnings: creator, mayhem coins and large size, each on its stated rule');
}

{
  // Hard exclusions (2026-10-25): what hides a wallet from "Best to copy"
  // and the suggestions. The record alone can only see a creator; the rest
  // need the chain label, and a wallet not yet checked is NOT hidden.
  const label = (over = {}) => ({ at: NOW, chainTrips: 40, sampled: 30, priced: 28, medianPct: -9, coveragePct: 50, unseenDeadPct: 30, washTrips: 0, sharedPayers: 0, sniperTrips: 0, bundleTrips: 0, mintsChecked: 25, credits: 300, ...over });
  assert.deepEqual(hardExclusions({ createdCoins: 0 }), [], 'unchecked and no creates: nothing to hold against it');
  assert.deepEqual(hardExclusions({ createdCoins: 1 }), ['creator']);
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label() }), [], 'a clean label');
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ bundleTrips: 1 }) }), ['bundle'], 'one launch-bundle buy is enough — 185 of 186 were the launcher');
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ sniperTrips: 5 }) }), ['sniper'], '5 of 25 checked is 20 %');
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ sniperTrips: 4 }) }), [], '4 of 25 is under the share');
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ sniperTrips: 1, mintsChecked: 1 }) }), [], 'one snipe of one checked is not a habit');
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ washTrips: 2 }) }), ['wash']);
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ washTrips: 1 }) }), [], 'one same-transaction round trip is a warning at most');
  assert.deepEqual(hardExclusions({ createdCoins: 0, chainLabel: label({ sharedPayers: 2 }) }), ['sharedPayer']);
  assert.deepEqual(hardExclusions({ createdCoins: 2, chainLabel: label({ bundleTrips: 2, washTrips: 3 }) }), ['creator', 'bundle', 'wash'], 'in a fixed order');
  for (const k of ['creator', 'bundle', 'sniper', 'wash', 'sharedPayer']) assert.ok(HARD_EXCLUSION_TEXT[k].why.length > 40, `${k} says why`);
  assert.ok(HARD_EXCLUSION_TEXT.sniper.why.includes(`${SNIPER_SLOTS} slots`) && HARD_EXCLUSION_TEXT.sniper.why.includes(`${SNIPER_SHARE_PCT}%`), 'the sniper text states its thresholds');
  // The filter: creators out, a checked bundler out, an unchecked wallet in.
  const mk = (address, over = {}) => ({ chain: 'solana', address, fShrunkPct: -8, copyScore: 50, ranked: true, looksAutomated: false, reachablePct: 80, medianHoldMs: 90_000, fastPct: 0, spanDays: 7, activeDays: 5, createdCoins: 0, sizeSol: 0.1, ...over });
  assert.equal(passesScoutFilter(mk('a'), 'clean'), true);
  assert.equal(passesScoutFilter(mk('b', { createdCoins: 1 }), 'clean'), false);
  assert.equal(passesScoutFilter(mk('c', { chainLabel: label({ bundleTrips: 1 }) }), 'clean'), false);
  assert.equal(passesScoutFilter(mk('d', { chainLabel: label() }), 'clean'), true);
  assert.equal(passesScoutFilter(mk('e', { chainLabel: null }), 'clean'), true, 'not checked is not hidden');
  ok('hard exclusions: creator from the record, bundle/sniper/wash/shared payer from the chain, unknown never hides');
}

{
  // The verdict (2026-10-25): the suggestion says whether anyone beats a copy
  // that goes nowhere, so the pages can say "nobody" instead of naming the
  // least-bad loser as a winner. The floor at 0.1 SOL is about −7 %.
  const mk = (address, fShrunkPct, over = {}) => ({
    chain: 'solana', address, fShrunkPct, copyScore: 50, ranked: true, looksAutomated: false, reachablePct: 80, medianHoldMs: 90_000, fastPct: 0, spanDays: 7, activeDays: 5, createdCoins: 0, sizeSol: 0.1, fMedianReturnPct: fShrunkPct, ...over,
  });
  const floor = shortlistVerdict([mk('f', -1)], 1).floorPct;
  assert.ok(floor < -6 && floor > -8, `the floor at 0.1 SOL is about −7 %: ${floor}`);
  assert.equal(clearsFloor(mk('x', floor + 0.5)), true);
  assert.equal(clearsFloor(mk('x', floor - 0.5)), false);
  assert.equal(clearsFloor(mk('x', null)), false, 'unranked clears nothing');
  const v = shortlistVerdict([mk('a', -9), mk('b', -12), mk('c', -4, { createdCoins: 1 }), mk('d', -20, { looksAutomated: true })], 5);
  assert.deepEqual(v.rows.map((r) => r.address), ['a', 'b'], 'the creator and the bot are not suggested however they rank');
  assert.equal(v.nobody, true, 'nobody beats the floor');
  assert.equal(v.clears, 0);
  assert.equal(v.bestPct, -9);
  assert.ok(Math.abs(v.floorPct - floor) < 1e-9);
  const w = shortlistVerdict([mk('a', -3), mk('b', -12)], 5);
  assert.equal(w.nobody, false);
  assert.equal(w.clears, 1, 'one clears the floor, one does not');
  const none = shortlistVerdict([], 5);
  assert.deepEqual([none.rows.length, none.nobody, none.bestPct, none.floorPct], [0, true, null, null]);
  ok('the verdict: the shortlist says who clears the fee floor, and "nobody" when nobody does');
}

{
  scout._reset();
  const C = 'Creator111111111111111111111111111111111111111';
  const T0 = NOW - 3_600_000;
  // A create before the creator has a book is kept, and folded in on promotion.
  scout.noteCreate('solana', C, 'Mayhem1', T0, true);
  // Six buys: the first two are sightings (promotion takes three), four reach the book.
  for (let i = 0; i < 6; i++) scout.note('solana', C, 'b' + i, true, 3, 1000, T0 + 1_000 + i);
  let w = scout.wallets('solana').find((x) => x.address === C);
  assert.ok(w, 'promoted');
  assert.equal(w.days[0].creates, 1, 'the create made before promotion counts');
  scout.noteCreate('solana', C, 'Std1', T0 + 10_000, false);
  w = scout.wallets('solana').find((x) => x.address === C);
  assert.equal(w.days[0].creates, 2);
  assert.equal(w.medianFirstBuy, 3, 'first buys of 3 SOL');
  // A trip on a mayhem coin is counted as one.
  scout.note('solana', C, 'Mayhem1', true, 1, 1000, T0 + 20_000);
  scout.note('solana', C, 'Mayhem1', false, 1.1, 1000, T0 + 200_000);
  w = scout.wallets('solana').find((x) => x.address === C);
  assert.equal(w.days[0].mayhemTrips, 1);
  // The PumpSwap feed's question: does the book need this coin's swaps?
  assert.equal(scout.wantsMint('solana', 'b5'), true, 'a coin a tracked wallet opened on');
  assert.equal(scout.wantsMint('solana', 'b0'), false, 'a sighting opens no position');
  assert.equal(scout.wantsMint('solana', 'NeverSeen'), false);
  assert.equal(scout.wantsAmm('solana'), true);
  assert.equal(scout.wantsAmm('bnb'), false, 'nothing open on that chain');
  // A trip bought on the curve and sold on the pool closes with the pool's sell.
  scout.note('solana', C, 'Grad', true, 1, 1000, T0 + 300_000);
  assert.equal(scout.wantsMint('solana', 'Grad'), true);
  scout.note('solana', C, 'Grad', false, 2, 1000, T0 + 900_000, 'amm-sell-1');
  w = scout.wallets('solana').find((x) => x.address === C);
  assert.ok(w.recentTrips.some((t) => t.mint === 'Grad' && Math.abs(t.pnl - 1) < 1e-9), 'the graduated trip closed');
  // Own wallets are never anyone's creator record.
  scout.setOwnAddresses('solana', [C]);
  scout.noteCreate('solana', C, 'x', T0, false);
  assert.equal(scout.wallets('solana').find((x) => x.address === C), undefined);
  ok('creates fold in on promotion, mayhem trips count, and the PumpSwap feed knows which coins the book needs');
}

// ── the board's own record (2026-10-23) ──────────────────────────────────
//
// The board writes down who "Best to copy" lists, then prices only copies of
// trades those wallets OPEN afterwards — out of sample — against every copy
// the record priced over the same span. A pick stays followed whether or not
// it stays on the list.
{
  scout._reset();
  const L = 'Pickme1111111111111111111111111111111111111111';
  const O = 'Printer22222222222222222222222222222222222222';
  const T0 = NOW - 3 * 86_400_000;
  const trip = (m, t, inPx, outPx) => {
    scout.note('solana', L, m, true, 1, 1000, t);
    scout.note('solana', O, m, true, inPx, 1000, t + 1_500);
    scout.note('solana', L, m, false, 1.05, 1000, t + 120_000);
    scout.note('solana', O, m, false, outPx, 1000, t + 121_000);
    scout.note('solana', O, m, true, 0.5, 500, t + 130_000);
  };
  for (let i = 0; i < 3; i++) scout.note('solana', L, 'warm' + i, true, 0.1, 1000, T0 - 100_000 + i);
  for (let i = 0; i < 12; i++) trip('p' + i, T0 + i * 6 * 3_600_000, 1.0, 1.0);
  // Every priced copy is in the comparison sample: the leader's twelve, and
  // the printer's own trips, which are copies too.
  assert.ok(scout.baseline('solana').length >= 12, 'every priced copy is in the comparison sample');
  const PICK_AT = NOW - 3_600_000;
  // The printer trades the same coins two seconds later and makes the list too.
  const picked = scout.refreshPicks('solana', PICK_AT);
  assert.ok(picked >= 1, 'it makes Best to copy, so it is picked');
  assert.equal(scout.refreshPicks('solana', PICK_AT + 60_000), 0, 'a pick is written down once');
  const p = scout.picks('solana').find((x) => x.address === L);
  assert.ok(p, 'the leader is a pick');
  assert.equal(p.pickedAt, PICK_AT);
  assert.equal(p.returns.length, 0, 'nothing before the pick counts');
  // After the pick: copies that make +10 % before costs.
  for (let i = 0; i < 3; i++) trip('q' + i, PICK_AT + 60_000 + i * 600_000, 1.0, 1.1);
  const after = scout.picks('solana').find((x) => x.address === L);
  assert.equal(after.returns.length, 3, 'three copies of trades opened after the pick');
  assert.ok(after.returns.every((r) => r > 6 && r < 7), `+10 % less 1.5 % a side: ${after.returns}`);
  const rec = boardRecord('solana', scout.picks('solana'), scout.baseline('solana'), null);
  assert.equal(rec.picks, picked);
  assert.equal(rec.copies, scout.picks('solana').reduce((a, x) => a + x.returns.length, 0));
  assert.ok(rec.copies >= 3);
  const sinceN = scout.baseline('solana').filter(([at]) => at >= PICK_AT).length;
  assert.equal(rec.baselineCopies, sinceN, 'the comparison spans the same time: only copies opened since the pick');
  assert.ok(sinceN >= 3 && sinceN < scout.baseline('solana').length, 'and none from before it');
  const savedN = scout.baseline('solana').length;
  assert.equal(rec.enough, false, `under ${SCOUT_RECORD_MIN_COPIES} copies it is too early to read`);
  assert.ok(rec.feeFloorPct < 0, 'the right zero is a loss');
  // Saved and read back.
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutpicks-'));
  scout.init(dir);
  scout.persist();
  scout._reset();
  scout.init(dir);
  const back = scout.picks('solana');
  assert.equal(back.length, picked);
  assert.equal(back.find((x) => x.address === L).returns.length, 3);
  assert.equal(scout.baseline('solana').length, savedN);
  assert.ok(
    scout.baseline('solana').every((e) => e.length === 3 && typeof e[2] === 'string' && e[2].length === 8),
    'every comparison copy names its wallet by a short key, after the reload too (2026-10-25)',
  );
  const withCopies = back.find((x) => x.address === L);
  assert.ok(Array.isArray(withCopies.at) && withCopies.at.length === withCopies.returns.length, 'each copy of a pick knows when it was opened');
  assert.ok(withCopies.at.every((t) => t >= withCopies.pickedAt), 'and every one was opened after the pick');
  fs.rmSync(dir, { recursive: true, force: true });
  // Let go after SCOUT_PICK_KEEP_DAYS, whether or not it is still listed.
  scout.refreshPicks('solana', PICK_AT + (SCOUT_PICK_KEEP_DAYS + 1) * 86_400_000);
  assert.equal(scout.picks('solana').filter((x) => x.pickedAt === PICK_AT).length, 0);
  assert.equal(SCOUT_PICKS_N, 10);
  scout._reset();
  ok("the board's picks are written down once, graded only on later trades, saved, and let go after two weeks");
}

{
  // The record by week (2026-10-25): one row a week against the same week's
  // universe and a band of random-N draws, so a lucky week cannot hide in a
  // pooled figure and the picks have to beat luck, not just the average.
  assert.equal(weekOf(Date.UTC(2026, 9, 21, 15)), Date.UTC(2026, 9, 19), 'a Wednesday belongs to its Monday');
  assert.equal(weekOf(Date.UTC(2026, 9, 19)), Date.UTC(2026, 9, 19), 'a Monday is its own week');
  assert.equal(weekOf(Date.UTC(2026, 9, 25, 23, 59)), Date.UTC(2026, 9, 19), 'a Sunday night still is');
  assert.equal(winsorisedMean([1, 2, 3, 4, 1000], 0.2), (2 + 2 + 3 + 4 + 4) / 5, 'the tails are clipped to the ranks, not dropped');
  assert.equal(winsorisedMean([], 0.05), null);
  const now = Date.UTC(2026, 9, 22, 12);
  const w0 = weekOf(now);
  const w1 = w0 - 7 * 86_400_000;
  const H = 3_600_000;
  // Two picks: one with copies this week (all +5 recorded) and last week (all −30); one picked last week with none.
  const picks = [
    { address: 'A', pickedAt: w1 + H, shrunkPct: -5, fTripsAtPick: 10, returns: [...Array(25).fill(5), ...Array(25).fill(-30)], at: [...Array(25).fill(w0 + 2 * H), ...Array(25).fill(w1 + 5 * H)] },
    { address: 'B', pickedAt: w1 + H, shrunkPct: -6, fTripsAtPick: 10, returns: [], at: [] },
    { address: 'C', pickedAt: w0 - 20 * 86_400_000, shrunkPct: -6, fTripsAtPick: 10, returns: [1], at: [w0 + H] }, // let go before this week began
  ];
  // The universe this week: 30 wallets, 10 copies each at −20 recorded; last week: 5 wallets only.
  const baseline = [];
  for (let k = 0; k < 30; k++) for (let i = 0; i < 10; i++) baseline.push([w0 + 3 * H + i, -20 + (k % 3), `wallet${String(k).padStart(2, '0')}`.slice(0, 8)]);
  for (let k = 0; k < 5; k++) for (let i = 0; i < 10; i++) baseline.push([w1 + 3 * H + i, -10, `old${k}`]);
  baseline.push([w1 + H, -50]); // an entry from before keys existed
  const rows = boardWeeks('solana', picks, baseline, null, now, 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.week), [w0, w1, w1 - 7 * 86_400_000], 'newest first, the current week included');
  const [cur, last, older] = rows;
  assert.equal(cur.picks, 2, 'A and B were on the list this week; C was let go before it began');
  assert.equal(cur.copies, 25, 'only this week’s copies of the picks (C’s copy is this week but C was gone)');
  // Repriced from the recorded 1.5 %/side to paper's per-side cost (no fixed
  // fees without a size), so the figures are compared, not read as recorded.
  assert.ok(Math.abs(cur.medianPct - cur.meanPct) < 1e-9, 'every copy the same: median and winsorised mean agree');
  assert.equal(cur.winRatePct, 100);
  assert.equal(cur.baselineCopies, 300);
  assert.ok(cur.medianPct > cur.baselineMedianPct, '+5 recorded against −19 recorded, whatever the per-side cost');
  assert.ok(cur.randomBand && cur.randomBand.wallets === 30, 'thirty keyed wallets make a band');
  assert.ok(cur.randomBand.lo <= cur.randomBand.hi && cur.randomBand.lo <= cur.baselineMedianPct + 1.5 && cur.randomBand.hi >= cur.baselineMedianPct - 1.5, `the band sits where the universe is: ${cur.randomBand.lo}..${cur.randomBand.hi} around ${cur.baselineMedianPct}`);
  assert.ok(cur.medianPct > cur.randomBand.hi, 'the picks sit above the band this week');
  assert.equal(cur.enough, true);
  assert.equal(last.copies, 25);
  assert.ok(last.medianPct < last.baselineMedianPct, '−30 recorded against −10 recorded');
  assert.equal(last.baselineCopies, 51, 'the unkeyed entry counts in the universe');
  assert.equal(last.randomBand, null, 'five wallets cannot make a band of ten');
  assert.deepEqual([older.copies, older.baselineCopies, older.medianPct, older.enough], [0, 0, null, false]);
  // Repriced at a size, every figure moves by the same fees.
  const sized = boardWeeks('solana', picks, baseline, 0.1, now, 1)[0];
  assert.ok(sized.medianPct < cur.medianPct && sized.baselineMedianPct < cur.baselineMedianPct, 'the fixed fees are taken at the size');
  ok('the record by week: picks’ copies against the week’s universe and a random-N band, newest first');
}

{
  // The lower bound (2026-10-25, P1): summarise under a prior. The row ranks
  // on fLowerPct, under the shrunk median; the prior's figures ride along;
  // without a prior the fixed constants give the old figure exactly.
  const now = Date.UTC(2026, 9, 22, 12);
  const today = dayOf(now);
  const wallet = (address, fReturns, over = {}) => ({
    chain: 'solana',
    address,
    firstSeen: now - 6 * 86_400_000,
    lastSeen: now,
    openCount: 0,
    openCost: 0,
    medianHoldMs: 120_000,
    medianFirstBuy: 0.1,
    distinctMints: 20,
    recentTrips: [],
    observedDays: [today],
    days: [{ day: today, buys: 20, sells: 20, roundTrips: 20, wins: 10, losses: 10, pnl: 1, volume: 2, fTrips: fReturns.length, fWins: fReturns.filter((r) => r > 0).length, fReturns, unreachable: 0, fast: 0, measured: 20 }],
    ...over,
  });
  const prior = { muPct: -12, k: 20, sigmaPct: 30, tauPct: 8, wallets: 50, at: now };
  const steady = summarise(wallet('Steady', Array(12).fill(-1)), 'week', now, { prior });
  assert.ok(steady.fLowerPct < steady.fShrunkPct, 'the bound is under the shrunk median');
  assert.deepEqual(steady.shrink, { k: 20, muPct: -12, wallets: 50 }, 'the prior used rides on the row');
  assert.ok(steady.basis.lowerPct < steady.basis.shrunkPct, 'and on the score basis');
  const plain = summarise(wallet('Steady', Array(12).fill(-1)), 'week', now);
  assert.deepEqual(plain.shrink, { k: 10, muPct: -15.5, wallets: 0 }, 'no prior: the fixed constants');
  assert.ok(plain.fLowerPct !== null && plain.fLowerPct < plain.fShrunkPct);
  const thin = summarise(wallet('Thin', [50, 50, 50, 50, 50]), 'week', now, { prior });
  assert.equal(thin.fLowerPct, null, 'null with the shrunk median under ten copies');
  const long = summarise(wallet('Long', Array(80).fill(-1)), 'week', now, { prior });
  assert.ok(long.fShrunkPct - long.fLowerPct < steady.fShrunkPct - steady.fLowerPct, 'eighty copies: a tighter bound');
  assert.ok(long.fLowerPct > steady.fLowerPct, 'the same median on more copies ranks higher');
  const lucky = summarise(wallet('Lucky', [...Array(10).fill(12)]), 'week', now, { prior });
  assert.ok(lucky.fMedianReturnPct > long.fMedianReturnPct, 'the lucky one has the better median…');
  assert.ok(rankScout([lucky, long], SCOUT_RANK_SORT)[0].address === 'Lucky' || lucky.fLowerPct > long.fLowerPct ? true : rankScout([lucky, long], SCOUT_RANK_SORT)[0].address === 'Long', 'ranked on the bound, whichever way the bound falls');
  assert.equal(rankScout([thin, steady], SCOUT_RANK_SORT)[0].address, 'Steady', 'unranked rows go under the bound-ranked ones');
  // The verdict reads the bound, and counts reliable records.
  const v = shortlistVerdict([steady, long, lucky], 10);
  assert.equal(v.bestPct, v.rows[0].fLowerPct, 'the verdict’s best figure is the top bound');
  assert.equal(v.reliable, 1, 'one record with eighty copies');
  assert.equal(clearsFloor({ chain: 'solana', fShrunkPct: 5, fLowerPct: -20, sizeSol: 0.1 }), false, 'the floor is judged on the bound when there is one');
  assert.equal(clearsFloor({ chain: 'solana', fShrunkPct: 5, sizeSol: 0.1 }), true, 'and on the shrunk median without one');
  assert.equal(SCOUT_RANK_SORT, 'fLowerPct');
  // The prior's view of a wallet: the week's recorded returns and the traits.
  const pw = priorWalletOf(wallet('Steady', [3, -1, 2]), 'week', now);
  assert.deepEqual([pw.address, pw.fTrips, pw.returns, pw.medianHoldMs, pw.medianFirstBuy], ['Steady', 3, [-1, 2, 3], 120_000, 0.1]);
  // The snapshot row: the live bound first, then the (k, z) grid.
  const vars = snapshotVariants();
  assert.equal(vars[0], 'live');
  assert.equal(vars.length, 1 + 4 * 3);
  const row = snapshotRow(walletKey8('Steady'), -1, 12, prior, null);
  assert.equal(row.length, vars.length + 1);
  assert.equal(row[0], 'steady'.padEnd(6, '').slice(0, 8));
  assert.ok(row[1 + vars.indexOf('k5z0')] > row[1 + vars.indexOf('k64z1.28')], 'light shrinkage with no bound sits above heavy shrinkage with a wide one, for a median above μ');
  ok('rows carry the lower bound and the prior; the verdict, the floor and the ranking read the bound');
}

{
  // The week's controls and the scorecard (2026-10-25, P1).
  const now = Date.UTC(2026, 9, 22, 12);
  const w0 = weekOf(now);
  const w1 = w0 - 7 * 86_400_000;
  const H = 3_600_000;
  const pick = (address, pickedAt, returns, at, over = {}) => ({ address, pickedAt, shrunkPct: -6, lowerPct: -9, fTripsAtPick: 12, returns, at, ...over });
  const picks = [
    // Fresh: picked this week, 30 copies at +4 recorded.
    pick('FreshOne', w0 + H, Array(30).fill(4), Array(30).fill(w0 + 3 * H)),
    // Held: picked last week, copies both weeks.
    pick('HeldOne1', w1 + H, [...Array(30).fill(-8), ...Array(30).fill(2)], [...Array(30).fill(w1 + 5 * H), ...Array(30).fill(w0 + 4 * H)], { shrunkPct: -4 }),
  ];
  const shadow = [
    pick('LeadOne1', w0 + H, Array(25).fill(-30), Array(25).fill(w0 + 2 * H), { arm: 'lead' }),
    pick('NextOne1', w0 + H, Array(25).fill(-2), Array(25).fill(w0 + 2 * H), { arm: 'next' }),
  ];
  // The universe: 30 keyed wallets this week with 10 copies each; their
  // medians fall with their index, and the snapshot scored them in that order.
  const baseline = [];
  const keys = [];
  for (let k = 0; k < 30; k++) {
    const key = walletKey8(`wallet${String(k).padStart(2, '0')}`);
    keys.push(key);
    for (let i = 0; i < 10; i++) baseline.push([w0 + 3 * H + i, -k + (i % 3), key]);
  }
  for (const p of [...picks, ...shadow]) for (let i = 0; i < 10; i++) baseline.push([w0 + 3 * H + i, -5, walletKey8(p.address)]);
  const vars = snapshotVariants();
  const snap = { week: w0, at: w0, variants: vars, rows: keys.map((key, k) => [key, ...vars.map(() => 10 - k)]) };
  const marks = [];
  for (let i = 0; i < 20; i++) {
    marks.push([w0 + 3 * H + i, 30, -1.5, walletKey8('FreshOne')], [w0 + 3 * H + i, 300, -4, walletKey8('FreshOne')]);
    marks.push([w0 + 3 * H + i, 30, 0.5, keys[i]], [w0 + 3 * H + i, 300, 1, keys[i]]);
  }
  const weeks = boardWeeks('solana', picks, baseline, null, now, 2, { shadow, snapshots: [snap], marks });
  const [cur, last] = weeks;
  assert.equal(cur.copies, 60, 'fresh and held copies this week');
  assert.deepEqual([cur.fresh.copies, cur.held.copies], [30, 30]);
  assert.ok(cur.fresh.medianPct > cur.held.medianPct, '+4 against +2 recorded');
  assert.deepEqual([cur.lead.picks, cur.lead.copies, cur.next.picks, cur.next.copies], [1, 25, 1, 25]);
  assert.ok(cur.lead.medianPct < cur.next.medianPct && cur.next.medianPct < cur.medianPct, 'leader-PnL worst, decile 9 between, the picks best, as the fixture says');
  assert.ok(cur.vsEveryone && cur.vsEveryone.diff > 0 && cur.vsEveryone.lo <= cur.vsEveryone.diff && cur.vsEveryone.hi >= cur.vsEveryone.diff, `picks minus everyone with an interval: ${JSON.stringify(cur.vsEveryone)}`);
  assert.ok(cur.rankRho && cur.rankRho.wallets === 30 && cur.rankRho.rho > 0.95, `the snapshot ordered the universe as it turned out: ${JSON.stringify(cur.rankRho)}`);
  assert.deepEqual([cur.marks.pick30, cur.marks.pick300, cur.marks.all30, cur.marks.all300, cur.marks.fills], [-1.5, -4, -0.5, -1.5, 40], 'the marks after the fill: picks and everyone, by horizon');
  assert.deepEqual([last.held.copies, last.fresh.copies], [0, 30], 'last week HeldOne1 was fresh');
  assert.equal(last.rankRho, null, 'no snapshot for last week');
  assert.equal(last.vsEveryone, null, 'and not enough on both sides');
  // The scorecard over those weeks.
  const card = scorecard('solana', picks, baseline, weeks, [snap], null);
  assert.equal(card.calibration, null, 'under five picks with copies');
  assert.equal(card.decayByAge.length, 3);
  assert.deepEqual(card.decayByAge.map((d) => d.copies), [60, 30, 0], 'the fresh pick’s thirty and the held pick’s first thirty inside two days of the pick; its next thirty seven days on');
  assert.ok(card.decayByAge[0].medianPct < card.decayByAge[1].medianPct, 'as the fixture says: −8 then +2 recorded for the held pick, +4 for the fresh');
  assert.equal(card.weeksNeeded, null, 'one graded week cannot say how many it needs');
  assert.equal(card.pbo, null, 'under four weeks with a snapshot');
  assert.ok(card.notes.some((n) => /Calibration: needs/.test(n)) && card.notes.some((n) => /Not enough weeks/.test(n)) && card.notes.some((n) => /Overfitting probability: needs/.test(n)), card.notes.join(' | '));
  // Five picks with copies: a calibration line; two graded weeks: weeks needed.
  const many = Array.from({ length: 6 }, (_, i) => pick(`Pick${i}`, w1 + H, Array(10).fill(-6 + i), Array(10).fill(w0 + 2 * H), { shrunkPct: -8 + i }));
  const card2 = scorecard('solana', many, baseline, [{ ...cur, enough: true, vsEveryone: { diff: 3, lo: 1, hi: 5 } }, { ...last, enough: true, vsEveryone: { diff: 1, lo: -1, hi: 3 } }], [snap], null);
  assert.ok(card2.calibration && Math.abs(card2.calibration.slope - 1) < 0.05 && card2.calibration.picks === 6, `realised rises one for one with the pick-time figure: ${JSON.stringify(card2.calibration)}`);
  assert.ok(card2.weeksNeeded && card2.weeksNeeded.have === 2 && card2.weeksNeeded.need >= 3, JSON.stringify(card2.weeksNeeded));
  assert.equal(MARK_HORIZONS_S.join(','), '30,300');
  ok('the week’s six controls, the paired interval, the rank correlation and the marks; the scorecard’s honesty switches');
}

{
  // The store (2026-10-25, P1): marks after a ranked wallet's fills, the
  // shadow selections and the week's snapshot at refresh, all saved.
  scout._reset();
  const L = 'MarkLeader111111111111111111111111111111111';
  const O = 'OtherPrint111111111111111111111111111111111';
  const T0 = NOW - 3 * 3_600_000;
  let n = 0;
  // A trip the leader opens at px1 and closes at px2 two minutes on. Another
  // wallet only ever buys (no trips of its own, so no record and no marks):
  // a print at or after a due time fills at the mark BEFORE it, so it prints
  // right after each leg (the copy fills at the leader's own marks), sets the
  // bump at 20 s and prints again at 40 s, which is what the 30 s mark sees.
  const trip = (mint, at, px1, px2, bump = px1) => {
    const tok = 1 / px1;
    scout.note('solana', L, mint, true, 1, tok, at, `b${n++}`);
    scout.note('solana', O, mint, true, 0.1, 0.1 / px1, at + 3_000, `p${n++}`);
    scout.note('solana', O, mint, true, 0.1, 0.1 / bump, at + 20_000, `m${n++}`);
    scout.note('solana', O, mint, true, 0.1, 0.1 / bump, at + 40_000, `n${n++}`);
    scout.note('solana', L, mint, false, tok * px2, tok, at + 120_000, `s${n++}`);
    scout.note('solana', O, mint, true, 0.1, 0.1 / px2, at + 130_000, `q${n++}`);
  };
  for (let i = 0; i < MIN_TRIPS_FOR_RANK - 1; i++) trip(`c${i}`, T0 + i * 600_000, 1.0, 1.1);
  assert.equal(scout.marks('solana').length, 0, 'a candidate’s fills leave no marks (under five trips at the fill)');
  // Ten counted trips in all (the very first trade is a sighting, not a
  // position): the prior counts a wallet from ten priced copies.
  for (let i = MIN_TRIPS_FOR_RANK - 1; i < 9; i++) trip(`c${i}`, T0 + i * 600_000, 1.0, 1.1);
  trip('c10', T0 + 10 * 600_000, 1.0, 1.1, 1.1);
  trip('c11', T0 + 11 * 600_000, 1.0, 1.1, 0.9);
  const marks = scout.marks('solana');
  const thirty = marks.filter((e) => e[1] === 30);
  assert.ok(thirty.length >= 2 && thirty.length <= 6, `once ranked, every fill is marked 30 s on: ${thirty.length}`);
  assert.deepEqual(thirty.map((e) => e[2]).filter((p) => p !== 0).sort((a, b) => a - b), [-10, 10], 'the move from the fill to the first print after 30 s');
  assert.ok(thirty.every((e) => e[3] === walletKey8(L) && e[0] >= T0), 'keyed to the wallet, timed at the opening');
  assert.equal(marks.filter((e) => e[1] === 300).length, 0, 'no print five minutes on: no 5 min mark yet');
  // The refresh: picks on the bound, LEAD beside them, the week's snapshot.
  const prior = scout.shrinkPrior('solana', NOW);
  assert.deepEqual([prior.k, prior.muPct, prior.wallets], [10, -15.5, 1], 'one wallet cannot make a prior: the constants, with the count');
  assert.equal(scout.refreshPicks('solana', NOW), 1);
  const p = scout.picks('solana')[0];
  assert.equal(p.address, L);
  assert.equal(typeof p.lowerPct, 'number', 'a pick records the bound it was ranked on');
  const sh = scout.shadow('solana');
  assert.equal(sh.length, 1, 'LEAD only: a universe of one has no tenth percentile');
  assert.deepEqual([sh[0].arm, sh[0].address], ['lead', L]);
  const snaps = scout.snapshots('solana');
  assert.equal(snaps.length, 1);
  assert.deepEqual([snaps[0].week, snaps[0].variants], [weekOf(NOW), snapshotVariants()]);
  assert.equal(snaps[0].rows.length, 1);
  assert.equal(snaps[0].rows[0][0], walletKey8(L));
  assert.equal(scout.refreshPicks('solana', NOW + 60_000), 0);
  assert.equal(scout.snapshots('solana').length, 1, 'one snapshot a week');
  // A copy after the pick lands on the pick and on the shadow record alike.
  trip('c12', NOW + 120_000, 1.0, 1.2);
  assert.equal(scout.picks('solana')[0].returns.length, 1);
  assert.equal(scout.shadow('solana')[0].returns.length, 1, 'the shadow selection keeps the same record');
  // Saved and read back.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutp1-'));
  scout.init(dir);
  scout.persist();
  scout._reset();
  scout.init(dir);
  assert.equal(scout.marks('solana').filter((e) => e[1] === 30).length, thirty.length + 1);
  assert.equal(scout.shadow('solana').length, 1);
  assert.equal(scout.shadow('solana')[0].returns.length, 1);
  assert.equal(scout.snapshots('solana').length, 1);
  assert.equal(scout.picks('solana')[0].lowerPct, p.lowerPct);
  fs.rmSync(dir, { recursive: true, force: true });
  scout._reset();
  ok('marks after ranked fills, the shadow selections and the weekly snapshot are kept and saved');
}

{
  // A fast wallet (2026-10-25): most measured trips over inside a minute. The
  // marks' follower figure is withheld whatever it reads — one wallet read
  // +17 % over 12 feed-seen trips where the chain's replay read −21 % — and
  // only the chain prices it. Below the rank's sample floor the record is
  // not silenced: two quick trips say nothing about the wallet.
  const now = Date.now();
  // The Scout's day is the local one (dayOf), not the UTC one: a UTC day
  // index put the fixture's day in tomorrow after 17:00 Pacific.
  const today = dayOf(now);
  const good = Array(12).fill(17);
  const wallet = (fast, measured, fReturns = good) => ({
    chain: 'solana',
    address: 'Fast',
    firstSeen: now - 6 * 86_400_000,
    lastSeen: now,
    openCount: 0,
    openCost: 0,
    medianHoldMs: null,
    distinctMints: 12,
    recentTrips: [],
    observedDays: [today],
    days: [{ day: today, buys: 12, sells: 12, roundTrips: 12, wins: 8, losses: 4, pnl: 1, volume: 2, fTrips: fReturns.length, fWins: fReturns.filter((r) => r > 0).length, fReturns, unreachable: 0, fast, measured }],
  });
  assert.equal(SCOUT_FAST_WALLET_PCT, 50);
  const fast = summarise(wallet(8, 12), 'week', now);
  assert.equal(fast.fastWallet, true, '8 of 12 measured trips inside a minute is a fast wallet');
  assert.equal(fast.fMedianReturnPct, null, 'no follower figure from the marks, however good they read');
  assert.equal(fast.fWinRatePct, null);
  assert.equal(fast.fShrunkPct, null);
  assert.equal(fast.fLowerPct, null, 'so it cannot be ranked on the marks');
  assert.equal(fast.basis.shrunkPct, null, 'nor scored on them');
  assert.equal(fast.fTrips, 12, 'the trips themselves are still counted');
  assert.equal(Math.round(fast.fastPct), 67);
  assert.equal(passesScoutFilter(fast, 'slowEnough'), false, 'and the slowEnough filter hides it');
  const slow = summarise(wallet(5, 12), 'week', now);
  assert.equal(slow.fastWallet, false, '5 of 12 is under the share');
  assert.ok(slow.fMedianReturnPct !== null && slow.fMedianReturnPct > 0, 'and the marks’ figure stands (repriced to the paper model)');
  assert.equal(passesScoutFilter(slow, 'slowEnough'), true);
  const edge = summarise(wallet(6, 12), 'week', now);
  assert.equal(edge.fastWallet, true, 'exactly half is fast');
  const thin = summarise(wallet(3, 4, [17, 17, 17, 17]), 'week', now);
  assert.equal(thin.fastWallet, false, 'under five measured trips, nothing is called');
  assert.equal(thin.fMedianReturnPct, null, '(four copies: under the rank floor anyway)');
  const legacy = summarise(wallet(0, 0), 'week', now);
  assert.equal(legacy.fastWallet, false, 'a record with no measured trips is not fast');
  assert.equal(legacy.fMedianReturnPct, slow.fMedianReturnPct, 'same returns, same figure');
  ok('a fast wallet gets no follower figure from the marks; only the chain prices it');
}

{
  // The week as a whole (2026-10-27): the copied trips' returns added up at
  // the size, what that is in SOL, and the mean without the best five. The
  // week's search found its wallets on this figure, and every one of them
  // was a positive total over a negative median — a few trades' work, which
  // the trimmed mean says out loud.
  const ten = [-10, -10, -10, -10, -10, -10, 80, 80, 80, 80];
  const w = wallet([day(0, { roundTrips: 10, wins: 4, losses: 6, fTrips: 10, fWins: 4, fReturns: ten })]);
  const row = summarise(w, 'week', NOW, { sizeSol: 0.1 });
  assert.ok(row.fMedianReturnPct < 0, 'the median copy lost');
  assert.ok(row.fSumPct > 0, 'the week as a whole made money');
  assert.ok(Math.abs(row.fTotalSol - 0.1 * (row.fSumPct / 100)) < 1e-9, 'the SOL figure is the total at the size');
  assert.ok(Math.abs(row.fTrimmedMeanPct - row.fMedianReturnPct) < 1e-9, 'without the best five, five losing copies are left');
  const flat = summarise(wallet([day(0, { roundTrips: 12, wins: 12, losses: 0, fTrips: 12, fWins: 12, fReturns: Array(12).fill(10) })]), 'week', NOW, { sizeSol: 0.1 });
  assert.ok(Math.abs(flat.fSumPct - 12 * flat.fMedianReturnPct) < 1e-9, 'twelve equal copies add up to twelve medians');
  assert.ok(Math.abs(flat.fTrimmedMeanPct - flat.fMedianReturnPct) < 1e-9);
  const six = summarise(wallet([day(0, { roundTrips: 6, wins: 6, losses: 0, fTrips: 6, fWins: 6, fReturns: Array(6).fill(10) })]), 'week', NOW, { sizeSol: 0.1 });
  assert.ok(six.fSumPct !== null, 'six copies have a total');
  assert.equal(six.fTrimmedMeanPct, null, `under ${SCOUT_TRIMMED_MIN_COPIES} copies nothing is left to average`);
  const four = summarise(wallet([day(0, { roundTrips: 4, wins: 4, losses: 0, fTrips: 4, fWins: 4, fReturns: Array(4).fill(10) })]), 'week', NOW, { sizeSol: 0.1 });
  assert.equal(four.fSumPct, null, 'under the rank floor there is no total either');
  assert.equal(four.fTotalSol, null);
  const basis = summarise(w, 'week', NOW, { sizeSol: null });
  assert.equal(basis.fTotalSol, null, 'no size, no SOL figure');
  assert.ok(basis.fSumPct !== null, 'but the percentage total stands');
  const ranked = rankScout([flat, row], 'fSumPct');
  assert.equal(ranked[0], row.fSumPct > flat.fSumPct ? row : flat, 'sorted by the total');
  ok('the week total and the mean without the best five are measured at the size, null under the floors, and sortable');
}

{
  // The winners scan's coin picker (2026-10-27): pump-launched only; young
  // coins that already hold a market, by market cap, then runners by volume;
  // the week's search thresholds; a coin whose age is unknown is left out.
  const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();
  const t = (id, over = {}) => ({ id, symbol: id.slice(0, 3), launchpad: 'pump.fun', mcap: 1_000_000, liquidity: 100_000, vol24: 1_000_000, createdAt: iso(3), ...over });
  const picked = pickWinnerCoins(
    [
      t('Apump', { mcap: 200_000 }),
      t('Bpump', { mcap: 9_000_000 }),
      t('Cpump', { mcap: 100_000 }), // too small a market
      t('Dpump', { liquidity: 5_000 }), // no liquidity
      t('Eray', { launchpad: 'raydium' }), // not pump-launched
      t('Fpump', { createdAt: iso(30), mcap: 2_000_000, vol24: 600_000 }), // a runner
      t('Gpump', { createdAt: iso(30), mcap: 2_000_000, vol24: 100_000 }), // a runner without volume
      t('Hpump', { createdAt: iso(120), mcap: 50_000_000, vol24: 9_000_000 }), // too old
      t('Ipump', { createdAt: null }), // no age
      t('Apump', { mcap: 5 }), // seen already
    ],
    NOW,
  );
  assert.deepEqual(
    picked.map((c) => c.mint),
    ['Bpump', 'Apump', 'Fpump'],
  );
  assert.equal(picked[0].kind, 'young');
  assert.equal(picked[2].kind, 'runner');
  const many = pickWinnerCoins(
    [...Array.from({ length: 60 }, (_, i) => t(`Y${i}pump`, { mcap: 150_000 + i })), ...Array.from({ length: 20 }, (_, i) => t(`R${i}pump`, { createdAt: iso(40), mcap: 2_000_000, vol24: 600_000 + i }))],
    NOW,
  );
  assert.equal(many.length, WINNERS_SCAN_YOUNG + WINNERS_SCAN_RUNNERS, 'capped');
  assert.equal(many.filter((c) => c.kind === 'young').length, WINNERS_SCAN_YOUNG);
  ok('the winners scan picks pump coins that went up and kept a market, young by cap then runners by volume, capped');
}

{
  // Never signs (2026-10-28): the read's counts decide; too little read or a
  // swap of its own says nothing against it, and the mark is a hard exclusion.
  assert.equal(NEVER_SIGNS_MIN_READ, 20);
  assert.equal(NEVER_SIGNS_MIN_UNSIGNED, 10);
  assert.deepEqual(neverSignsFrom(25, 0, 25, 7), { at: 7, read: 25, unsigned: 25 });
  assert.deepEqual(neverSignsFrom(1000, 0, 24, 7), { at: 7, read: 1000, unsigned: 24 });
  assert.equal(neverSignsFrom(1000, 1, 999, 7), 'clear', 'a swap it signed clears it');
  assert.equal(neverSignsFrom(19, 0, 19, 7), null, 'too few read: not judged');
  assert.equal(neverSignsFrom(100, 0, 9, 7), null, 'too few moved by others: not judged');
  assert.deepEqual(hardExclusions({ createdCoins: 0, neverSigns: { at: 7, read: 25, unsigned: 25 } }), ['notSigner']);
  assert.match(HARD_EXCLUSION_TEXT.notSigner.label, /Never signs/);
  ok('a wallet whose tokens only move under other signatures is marked never signs and held off the board; too little read is not judged');
}

console.log(`\nwalletscout: ${passed}/${passed} passed`);
