// Copy backtest (2026-11-01) — a wallet's past trades replayed through a
// follow's own settings: its delay on top of the follower's latency, its
// size, paper's fees and impact, every rule the trades alone can judge
// (each refusal counted under the rule that made it), and the rules they
// cannot judge listed rather than assumed.

import assert from 'node:assert';
import {
  BACKTEST_MIN_COPIES,
  backtestConfigOf,
  backtestCopies,
  backtestNotApplied,
  backtestPlanOf,
  backtestRefusal,
  backtestVerdict,
} from './.copybacktest.mjs';
import { MIN_LIVE_COPY_SOL, PAPER_DEFAULT_DEPTH_SOL, paperCopyReturnPct } from './.copybacktestfees.mjs';
import * as job from './.copybacktestjob.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const W = 'Back7est' + '1'.repeat(36);
// 10:00 local on a fixed day, so a morning's trips share one local day.
const T = new Date(2026, 9, 20, 10, 0, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 3_600_000;

/** A config as the Follow page would send it, with `over` laid on. */
const cfgOf = (over = {}) => {
  const r = backtestConfigOf({
    wallet: W,
    label: 'test',
    chain: 'solana',
    mode: 'paper',
    direction: 'copy',
    sizing: 'fixed',
    sizeValue: 0.1,
    maxTradeSol: 0.1,
    dailyTradeLimit: 100,
    dailyLossLimitSol: 100,
    maxCopiesPerMinute: 100,
    delayMs: 0,
    copySells: true,
    minLiquidityUsd: null,
    maxMarketCapUsd: null,
    minKryptScore: null,
    onlyPumpfun: false,
    maxSlippagePct: 8,
    ...over,
  });
  assert.ok(r.ok, r.message);
  return r.config;
};
const lagOf = (ms, delay = 0) => ({ lagMs: ms + delay, baseLagMs: ms, delayMs: delay, source: 'board', note: 'the board’s 2 s follower lag' });
const specOf = (over = {}, extra = {}) => ({
  config: cfgOf(over),
  lag: lagOf(2_000, over.delayMs ?? 0),
  depthSol: PAPER_DEFAULT_DEPTH_SOL,
  depthSource: 'default',
  maxOpenCopies: null,
  span: 'newest',
  ...extra,
});
/** A priced trip of theirs. */
const trip = (mint, openedAt, holdMs, { openSol = 1, entry = 1, exit = 1.1, note = 'filled' } = {}) => ({
  mint,
  openedAt,
  closedAt: openedAt + holdMs,
  cost: openSol,
  openSol,
  pnl: 0,
  holdMs,
  entryPx: note === 'filled' ? entry : null,
  exitPx: note === 'filled' ? exit : null,
  returnPct: note === 'filled' ? 0 : null,
  note,
});
const count = (r, rule) => r.skipped.find((s) => s.rule === rule)?.count ?? 0;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);

// ── The config a page sends ─────────────────────────────────────────────
{
  assert.equal(backtestConfigOf(null).ok, false);
  assert.equal(backtestConfigOf({ wallet: 'nope', sizeValue: 1, maxTradeSol: 1, dailyTradeLimit: 1, dailyLossLimitSol: 1 }).ok, false, 'not a wallet');
  assert.match(backtestConfigOf({ wallet: '0x' + '1'.repeat(40), chain: 'bnb' }).message, /Solana/);
  assert.match(backtestConfigOf({ wallet: W, sizeValue: 0, maxTradeSol: 1, dailyTradeLimit: 1, dailyLossLimitSol: 1 }).message, /size/);
  const c = cfgOf({ minLeaderSol: '0.2', maxBuysPerToken: 0, blockedMints: [' X ', '', 'X'], walletLossStopSol: null, junk: 'ignored' });
  assert.equal(c.minLeaderSol, 0.2, 'a numeric string is read as its number');
  assert.equal(c.maxBuysPerToken, null, 'zero is off for a per-token cap');
  assert.deepEqual(c.blockedMints, ['X'], 'the blocklist is cleaned as the engine cleans it');
  assert.equal(c.walletLossStopSol, null);
  assert.equal('junk' in c, false, 'only the fields the backtest reads');
  assert.match(backtestRefusal(cfgOf({ direction: 'reverse' })), /reverse/);
  assert.match(backtestRefusal(cfgOf({ direction: 'fomo' })), /convergence/);
  assert.match(backtestRefusal(cfgOf({ copySells: false, exitMaxHoldMin: null })), /no exit/);
  assert.equal(backtestRefusal(cfgOf({ copySells: false, exitMaxHoldMin: 30 })), null);
  assert.equal(backtestRefusal(cfgOf()), null);
  ok('a page’s draft is read field by field; reverse, convergence and an exit-less follow are refused with why');
}

// ── Fees and impact: paper's model, at the copy's own size ─────────────
{
  const spec = specOf();
  const r = backtestCopies([trip('A', T, 5 * MIN, { entry: 1, exit: 1.2 })], spec);
  assert.equal(r.copies, 1);
  assert.equal(r.priced, 1);
  const want = paperCopyReturnPct(0.1, 1, 1.2, PAPER_DEFAULT_DEPTH_SOL, 'solana');
  near(r.copiesList[0].pct, want, 'the copy is priced with paperCopyReturnPct');
  near(r.totalSol, 0.1 * (want / 100), 'its SOL is the size times the return');
  assert.ok(want < 20 * 0.97, `fees and impact come off the 20 % move: ${want}`);
  assert.ok(want < paperCopyReturnPct(0.1, 1, 1.2, null, 'solana'), 'impact against the 30 SOL floor costs more than none');
  // Sized by their opening buy: 25 % of 0.2, capped at 0.1.
  const pct = specOf({ sizing: 'proportional', sizeValue: 25, maxTradeSol: 0.1 });
  const r2 = backtestCopies([trip('B', T, 5 * MIN, { openSol: 0.2 }), trip('C', T + MIN, 5 * MIN, { openSol: 4 })], pct);
  assert.deepEqual(r2.copiesList.map((c) => c.sol).sort(), [0.05, 0.1]);
  assert.equal(r.depthSol, PAPER_DEFAULT_DEPTH_SOL);
  assert.equal(r.depthSource, 'default');
  assert.ok(r.assumptions.some((a) => /30 SOL pool/.test(a) && /no liquidity/.test(a)), 'the depth assumption is said');
  ok('each copy is priced with paper’s fees, fixed costs and impact at its own size, and the depth used is said');
}

// ── Every rule the trades can judge, counted by rule ───────────────────
{
  // Their buy size.
  let r = backtestCopies([trip('a', T, 5 * MIN, { openSol: 0.05 }), trip('b', T + MIN, 5 * MIN, { openSol: 10 }), trip('c', T + 2 * MIN, 5 * MIN, { openSol: 1 })], specOf({ minLeaderSol: 0.1, maxLeaderSol: 5 }));
  assert.deepEqual([count(r, 'leaderMin'), count(r, 'leaderMax'), r.copies], [1, 1, 1]);
  // The blocklist.
  r = backtestCopies([trip('BAD', T, 5 * MIN), trip('good', T + MIN, 5 * MIN)], specOf({ blockedMints: ['BAD'] }));
  assert.deepEqual([count(r, 'blocklist'), r.copies], [1, 1]);
  // Trading hours, on the local clock: a window that starts an hour after T.
  const m = new Date(T).getHours() * 60 + new Date(T).getMinutes();
  r = backtestCopies([trip('early', T, 5 * MIN), trip('in', T + 70 * MIN, 5 * MIN)], specOf({ activeFromMin: (m + 60) % 1440, activeToMin: (m + 120) % 1440 }));
  assert.deepEqual([count(r, 'hours'), r.copies], [1, 1]);
  // One position per coin: a second buy of a coin still held.
  r = backtestCopies([trip('X', T, 10 * MIN), trip('X', T + MIN, 10 * MIN), trip('Y', T + 2 * MIN, 10 * MIN)], specOf({ onePositionPerCoin: true }));
  assert.deepEqual([count(r, 'onePosition'), r.copies], [1, 2]);
  // Buy once: the coin again after the first copy closed.
  r = backtestCopies([trip('X', T, MIN * 3), trip('X', T + 10 * MIN, 3 * MIN)], specOf({ maxBuysPerToken: 1 }));
  assert.deepEqual([count(r, 'maxBuys'), r.copies], [1, 1]);
  // The daily copy limit, by local day.
  r = backtestCopies([0, 1, 2, 3].map((i) => trip('d' + i, T + i * 10 * MIN, 3 * MIN)).concat([trip('next', T + DAY, 3 * MIN)]), specOf({ dailyTradeLimit: 2 }));
  assert.deepEqual([count(r, 'dailyTrades'), r.copies], [2, 3], 'two refused today; tomorrow starts again');
  // The per-minute wall.
  r = backtestCopies([0, 1, 2].map((i) => trip('p' + i, T + i * 10_000, 3 * MIN)).concat([trip('later', T + 2 * MIN, 3 * MIN)]), specOf({ maxCopiesPerMinute: 2 }));
  assert.deepEqual([count(r, 'perMinute'), r.copies], [1, 3]);
  // The daily loss limit, from the copies' own realised results.
  const lose = { entry: 1, exit: 0.4 };
  r = backtestCopies(
    [trip('L1', T, 2 * MIN, lose), trip('L2', T + MIN, 30 * MIN), trip('L3', T + 10 * MIN, 2 * MIN), trip('L4', T + DAY, 2 * MIN)],
    specOf({ dailyLossLimitSol: 0.05 }),
  );
  assert.equal(count(r, 'dailyLoss'), 1, 'L3 is refused: L1 lost past the limit and had closed');
  assert.deepEqual(r.copiesList.map((c) => c.mint).sort(), ['L1', 'L2', 'L4'], 'L2 came before L1 had closed; tomorrow starts again');
  // The follow's own stop pauses it for good.
  r = backtestCopies([trip('S1', T, 2 * MIN, lose), trip('S2', T + 10 * MIN, 2 * MIN), trip('S3', T + DAY, 2 * MIN)], specOf({ walletLossStopSol: 0.05 }));
  assert.deepEqual([count(r, 'walletStop'), r.copies], [2, 1], 'paused, then deaf until switched on — even the next day');
  // The app-wide open ceiling, counting this follow's own copies.
  r = backtestCopies([trip('o1', T, 10 * MIN), trip('o2', T + MIN, 10 * MIN), trip('o3', T + 20 * MIN, 2 * MIN)], specOf({}, { maxOpenCopies: 1 }));
  assert.deepEqual([count(r, 'maxOpen'), r.copies], [1, 2]);
  // The live minimum: refused live, taken (and counted) on paper.
  const small = { sizing: 'proportional', sizeValue: 10, maxTradeSol: 0.1 };
  r = backtestCopies([trip('tiny', T, 5 * MIN, { openSol: 0.1 }), trip('big', T + MIN, 5 * MIN, { openSol: 1 })], specOf({ ...small, mode: 'live' }));
  assert.deepEqual([count(r, 'liveMin'), r.copies], [1, 1]);
  assert.ok(0.01 < MIN_LIVE_COPY_SOL);
  r = backtestCopies([trip('tiny', T, 5 * MIN, { openSol: 0.1 })], specOf(small));
  assert.deepEqual([count(r, 'liveMin'), r.copies, r.underLiveMin], [0, 1, 1]);
  assert.ok(r.assumptions.some((a) => /live would refuse/.test(a)));
  // Watch only never trades.
  r = backtestCopies([trip('w1', T, 5 * MIN), trip('w2', T + MIN, 5 * MIN)], specOf({ direction: 'watch' }));
  assert.deepEqual([count(r, 'watch'), r.copies], [2, 0]);
  // Every refusal counted once, under the first rule, biggest first.
  r = backtestCopies([trip('BAD', T, 5 * MIN, { openSol: 0.01 }), trip('BAD', T + MIN, 5 * MIN)], specOf({ minLeaderSol: 0.1, blockedMints: ['BAD'] }));
  assert.deepEqual(r.skipped.map((s) => [s.rule, s.count]), [['leaderMin', 1], ['blocklist', 1]].sort((a, b) => b[1] - a[1] || 0));
  assert.equal(r.skippedTotal, 2);
  assert.ok(r.skipped.every((s) => typeof s.label === 'string' && s.label.length > 5));
  ok('each rule the trades can judge refuses copies, and each refusal is counted under the rule that made it');
}

// ── Delay and exits in the plan ─────────────────────────────────────────
{
  // Their 4 s trip: copyable at the 2 s lag, too fast with a 3 s delay on top.
  const t4 = trip('F', T, 4_000);
  assert.equal(backtestCopies([t4], specOf()).copies, 1);
  const delayed = backtestCopies([t4], specOf({ delayMs: 3_000 }));
  assert.deepEqual([count(delayed, 'tooFast'), delayed.copies, delayed.lagMs, delayed.delayMs], [1, 0, 5_000, 3_000]);
  assert.ok(delayed.assumptions[0].includes('5 s') && delayed.assumptions[0].includes('3000 ms delay'), delayed.assumptions[0]);
  // The max hold: sold 30 min after the copy's buy when they held longer.
  const plan = backtestPlanOf(specOf({ exitMaxHoldMin: 30 }));
  assert.equal(plan.holdOf(trip('h', T, 60 * MIN)), 30 * MIN);
  assert.equal(plan.holdOf(trip('h', T, 10 * MIN)), null, 'their sell came first');
  const held = backtestCopies([trip('h', T, 60 * MIN)], specOf({ exitMaxHoldMin: 30 }));
  assert.equal(held.copiesList[0].exitBy, 'maxHold');
  assert.equal(held.copiesList[0].exitAt, T + 2_000 + 30 * MIN);
  assert.equal(held.byMaxHold, 1);
  // Their sells not copied: always the max hold, and never "too fast".
  const noSells = backtestPlanOf(specOf({ copySells: false, exitMaxHoldMin: 5 }));
  assert.equal(noSells.holdOf(trip('n', T, MIN)), 5 * MIN);
  assert.equal(noSells.tooFast(trip('n', T, 500)), false);
  ok('the follow’s delay is added to the lag (and makes fast trips uncopyable), and the max hold closes copies before their sell');
}

// ── What the trades cannot judge is listed, never applied ───────────────
{
  const all = cfgOf({
    minLiquidityUsd: 5_000,
    minMarketCapUsd: 10_000,
    minKryptScore: 50,
    onlyPumpfun: true,
    maxTokenAgeSec: 3_600,
    blockedCreators: ['Dev1111111111111111111111111111111111111111'],
    ai: { entries: true, exits: false, waitSec: 10, onTimeout: 'skip', protectiveWait: false },
    exitTakeProfitPct: 50,
    exitStopLossPct: 30,
    exitTrailingPct: 25,
    exitOnCreatorSellPct: 50,
    exitOnMigration: true,
    copyOtherExits: true,
    onePositionPerCoin: true,
    minLeaderSellPct: 50,
  });
  const keys = backtestNotApplied(all, 5).map((n) => n.key);
  for (const k of ['minLiquidityUsd', 'marketCap', 'minKryptScore', 'onlyPumpfun', 'tokenAge', 'blockedCreators', 'ai', 'takeProfit', 'stopLoss', 'trailing', 'creatorSell', 'migration', 'otherExits', 'partialSells', 'onePositionOthers', 'maxOpenOthers', 'slippage', 'buyMore'])
    assert.ok(keys.includes(k), `${k} is listed`);
  assert.ok(backtestNotApplied(all, 5).every((n) => n.why.length > 10), 'each with why');
  const bare = backtestNotApplied(cfgOf(), null).map((n) => n.key);
  assert.deepEqual(bare, ['partialSells', 'slippage', 'buyMore'], 'a rule that is off is not listed');
  // None of them refuses a copy: a coin nobody knows the liquidity of is copied, and the result says the filter was not applied.
  const r = backtestCopies([trip('A', T, 5 * MIN), trip('B', T + MIN, 5 * MIN)], { ...specOf(), config: all, maxOpenCopies: null });
  assert.equal(r.copies, 2, 'not applied means neither passed nor failed: the copies stand');
  assert.equal(r.skippedTotal, 0);
  assert.ok(r.notApplied.some((n) => n.key === 'minLiquidityUsd'));
  ok('liquidity, market cap, score, age, creators, the AI desk and the price-path exits are listed as not applied, with why');
}

// ── Best copy, the total without it, and the rest of the summary ────────
{
  // Five small losers and one huge winner.
  const trips = [0, 1, 2, 3, 4].map((i) => trip('l' + i, T + i * 10 * MIN, 3 * MIN, { exit: 0.9 })).concat([trip('moon', T + 60 * MIN, 3 * MIN, { exit: 5 })]);
  const r = backtestCopies(trips, specOf());
  assert.equal(r.priced, 6);
  assert.equal(r.best.mint, 'moon');
  assert.ok(r.totalSol > 0, `the total looks good: ${r.totalSol}`);
  assert.ok(r.withoutBestSol < 0, `without the best copy it is a loss: ${r.withoutBestSol}`);
  near(r.withoutBestSol, r.totalSol - r.best.pnlSol, 'the total minus the best');
  assert.ok(r.medianPct < 0 && r.meanPct > 0, 'the median is the typical copy, the mean carries the winner');
  near(r.winRatePct, (1 / 6) * 100, 'win rate');
  near(r.meanSol, r.totalSol / 6, 'mean SOL a copy');
  assert.equal(backtestVerdict(r).kind, 'oneCopy');
  assert.equal(r.bestFewSol, null, 'no best-five split under ten copies');
  // Under five priced copies: totals, but no median, mean, win rate or verdict.
  const few = backtestCopies(trips.slice(0, 3).concat([trip('u', T + 90 * MIN, 3 * MIN, { note: 'unpriced' })]), specOf());
  assert.deepEqual([few.copies, few.priced, few.unpriced], [4, 3, 1], 'an unpriced copy is taken, in no SOL figure');
  assert.equal(few.medianPct, null);
  assert.equal(few.meanPct, null);
  assert.equal(few.winRatePct, null);
  assert.ok(few.totalSol < 0);
  assert.equal(backtestVerdict(few), null);
  assert.ok(BACKTEST_MIN_COPIES === 5);
  // Per day, by the local day the copy closed.
  const days = backtestCopies([trip('a', T, 3 * MIN), trip('b', T + 10 * MIN, 3 * MIN, { exit: 0.5 }), trip('c', T + DAY, 3 * MIN)], specOf());
  assert.equal(days.days.length, 2);
  assert.deepEqual(days.days.map((d) => d.copies), [2, 1]);
  near(days.days.reduce((a, d) => a + d.totalSol, 0), days.totalSol, 'the days add up to the total');
  // Nothing priced: every SOL figure unknown, never zero.
  const none = backtestCopies([trip('z', T, 3 * MIN, { note: 'unpriced' })], specOf());
  assert.deepEqual([none.totalSol, none.best, none.withoutBestSol, none.spentSol], [null, null, null, null]);
  ok('best copy and the total without it, median, mean, win rate and the days; unknown is null, never zero');
}

// ── The job: delay into the chain read and the swap API, rules before credits ──
{
  const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=x';
  const sws = (mint, isBuy, sol, at, slot) => ({ mint, isBuy, sol, tokens: 1000, at, slot });
  const swaps = [
    sws('A', true, 1, T, 1_000),
    sws('A', false, 1.2, T + 5 * MIN, 2_400),
    sws('BAD', true, 1, T + 10 * MIN, 3_000),
    sws('BAD', false, 1.2, T + 15 * MIN, 4_400),
    sws('H', true, 1, T + 20 * MIN, 5_000),
    sws('H', false, 1.2, T + 80 * MIN, 22_000),
  ];
  const asked = [];
  const deps = {
    sleep: async () => {},
    cooldownMs: () => 0,
    swapsOf: () => swaps,
    read: async () => assert.fail('no read'),
    priceAt: async () => assert.fail('the chain priced everything'),
    chainPrice: async () => assert.fail('a backtest uses the lagged read'),
    chainPriceLags: async (_u, mint, open, close, lags) => {
      asked.push({ mint, open, close, lags: [...lags] });
      return { ok: true, at: Object.fromEntries(lags.map((l) => [l, { entry: 1, exit: 1.1 }])), calls: 1, credits: 10, cached: false, message: '' };
    },
    chainCreditsLeft: () => 100_000,
    billBacktest: () => {},
  };
  job._reset();
  const config = cfgOf({ delayMs: 1_000, blockedMints: ['BAD'], exitMaxHoldMin: 30 });
  assert.equal(job.startBacktest({ config, span: 'newest', measured: null, maxOpenCopies: 5 }, HELIUS, deps, T + DAY).ok, true);
  await job.waitBacktest(W);
  const st = job.backtestStatus(W);
  const lagSlots = Math.round(3_000 / 211.6);
  assert.deepEqual(asked.map((a) => a.mint).sort(), ['A', 'H'], 'the blocklisted coin costs no credits');
  for (const a of asked) assert.deepEqual(a.lags, [lagSlots], 'the follow’s 1 s delay on the 2 s lag, in slots');
  assert.equal(asked.find((a) => a.mint === 'A').close, 2_400, 'their sell is the exit');
  assert.equal(asked.find((a) => a.mint === 'H').close, 5_000 + Math.round((30 * MIN) / 211.6), 'the max hold after the copy’s buy is the exit');
  const bt = st.backtest;
  assert.ok(bt, 'the result is on the status');
  assert.deepEqual([bt.trips, bt.copies, bt.priced, count(bt, 'blocklist'), bt.lagMs, bt.lagSource], [3, 2, 2, 1, 3_000, 'board']);
  assert.ok(bt.notApplied.some((n) => n.key === 'maxOpenOthers'), 'the app-wide ceiling is said to count this follow only');
  // Without a Helius key: the swap API, at the same lag and exits.
  job._reset();
  const at = [];
  const slow = { ...deps, chainPriceLags: undefined, chainPrice: undefined, priceAt: async (mint, t) => (at.push([mint, t]), { price: 1, failed: false, message: '' }) };
  assert.equal(job.startBacktest({ config, measured: null }, 'http://rpc', slow, T + DAY).ok, true);
  await job.waitBacktest(W);
  assert.deepEqual(at.filter(([m]) => m === 'A').map(([, t]) => t), [T + 3_000, T + 5 * MIN + 3_000]);
  assert.deepEqual(at.filter(([m]) => m === 'H').map(([, t]) => t), [T + 20 * MIN + 3_000, T + 20 * MIN + 3_000 + 30 * MIN]);
  assert.equal(at.filter(([m]) => m === 'BAD').length, 0);
  // A backtest and a replay of one wallet are two jobs.
  job._reset();
  assert.equal(job.start(W, HELIUS, { ...deps, chainPrice: async () => ({ ok: true, entry: 1, exit: 1, calls: 1, credits: 10, cached: false, message: '' }) }, T + DAY).ok, true);
  assert.equal(job.startBacktest({ config }, HELIUS, deps, T + DAY).ok, true);
  await job.wait(W);
  await job.waitBacktest(W);
  assert.equal(job.status(W).backtest, undefined, 'the replay is a replay');
  assert.ok(job.backtestStatus(W).backtest);
  assert.equal(job.startBacktest({ config: cfgOf({ direction: 'reverse' }) }, HELIUS, deps, T + DAY).ok, false);
  ok('the job prices at the follow’s lag and exits on the chain and the swap API, skips refused trips before spending, and keeps its own status');
}

// ── The base latency: measured when live copies measured it ─────────────
{
  const board = job.backtestLagOf(500, null);
  assert.deepEqual([board.lagMs, board.baseLagMs, board.source], [2_500, 2_000, 'board']);
  const few = job.backtestLagOf(0, { slotGap: 3, slotSamples: job.BACKTEST_MIN_LATENCY_SAMPLES - 1, delayMs: 0 });
  assert.equal(few.source, 'board', 'too few live copies is not a measurement');
  const m = job.backtestLagOf(1_000, { slotGap: 6, slotSamples: 12, delayMs: 200 });
  assert.equal(m.source, 'measured');
  assert.equal(m.baseLagMs, Math.round(6 * 211.6 - 200), 'the measured gap less the delay those copies waited');
  assert.equal(m.lagMs, m.baseLagMs + 1_000);
  assert.match(m.note, /12 live copies/);
  ok('the base latency is this session’s measured slot gap from five live copies, else the board’s 2 s');
}

console.log(`\ncopybacktest: ${passed}/${passed} passed`);
