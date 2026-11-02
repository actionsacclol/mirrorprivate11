// Launch-intel cohort tests.
//
// These numbers are an accusation. "38% of supply was bundled and they still
// hold it" is the difference between a user buying and not buying, so every
// definition in `shared/launchintel.ts` is pinned here — including the ones
// that look obvious, because the failure mode is a plausible wrong number
// rather than a crash.
//
// The three that would be silent in production:
//   • a missing balance read as zero → "they dumped everything" from an RPC
//     hiccup, which is the honest-null rule stated in money terms;
//   • the creator counted inside the bundle → every dev buy inflates it;
//   • trades arriving newest-first (which is how the provider serves them)
//     making the LAST trade look like the launch slot.

import assert from 'node:assert';
import {
  analyseLaunch,
  applyBalances,
  creatorVerdict,
  summariseCreator,
  SNIPER_WINDOW_SLOTS,
} from './.launchintel.mjs';
import { normaliseTrade, rowPriceSol, priceAt, launchTrades, recentTrades, _resetAnchors, _setPageSource, parseCandles, rebucket, candlesSupported } from './.pumpswap.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const SUPPLY = 1_000_000_000; // 1B, the pump.fun standard
const DEV = 'DEVwa11et';

/** A trade, terse. slot offsets are relative to the launch slot. */
const t = (slotOffset, user, base, isBuy = true, ts = 0) => ({
  slot: 1000 + slotOffset,
  ts: 1_700_000_000_000 + ts,
  user,
  isBuy,
  base,
  sol: base / 1_000_000,
  program: 'pump',
  tx: `tx${user}${slotOffset}`,
});

const base = { creator: DEV, supply: SUPPLY, complete: true };

// ── Cohort assignment ─────────────────────────────────────────────────

test('same-slot buyers are the bundle; the creator is never one of them', () => {
  const a = analyseLaunch(
    [t(0, DEV, 30_000_000), t(0, 'b1', 20_000_000), t(0, 'b2', 10_000_000), t(5, 's1', 40_000_000)],
    base,
  );
  assert.equal(a.bundle.wallets, 2, 'the two non-creator launch-block buyers');
  assert.equal(a.dev.wallets, 1);
  assert.equal(a.snipers.wallets, 1);
  assert.ok(Math.abs(a.bundle.boughtPct - 3) < 1e-9, `bundle 3% of supply, got ${a.bundle.boughtPct}`);
  assert.ok(Math.abs(a.dev.boughtPct - 3) < 1e-9);
});

test('trades in provider order (newest first) give the same answer', () => {
  const trades = [t(0, DEV, 30_000_000), t(0, 'b1', 20_000_000), t(9, 's1', 40_000_000)];
  const forward = analyseLaunch(trades, base);
  const reversed = analyseLaunch([...trades].reverse(), base);
  assert.equal(reversed.launchSlot, forward.launchSlot);
  assert.equal(reversed.bundle.wallets, forward.bundle.wallets);
  assert.equal(reversed.snipers.wallets, forward.snipers.wallets);
});

test('the sniper window is exactly SNIPER_WINDOW_SLOTS wide, inclusive', () => {
  const a = analyseLaunch(
    [t(0, 'b1', 1_000_000), t(SNIPER_WINDOW_SLOTS, 'edge', 1_000_000), t(SNIPER_WINDOW_SLOTS + 1, 'late', 1_000_000)],
    base,
  );
  assert.equal(a.snipers.wallets, 1, 'the boundary slot counts as a snipe');
  const late = a.wallets.find((w) => w.address === 'late');
  assert.equal(late.cohort, 'early', 'one slot past the window is no longer a snipe');
});

test('a wallet keeps the cohort of its FIRST buy when it buys again later', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(4, 'b1', 30_000_000)], base);
  assert.equal(a.bundle.wallets, 1);
  assert.equal(a.snipers.wallets, 0, 'the follow-up buy must not create a second identity');
  assert.ok(Math.abs(a.bundle.boughtPct - 4) < 1e-9, 'both buys belong to the bundle');
});

test('a wallet that only sells is not credited with a purchase', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(1, 'ghost', 5_000_000, false)], base);
  assert.equal(a.wallets.length, 1);
  assert.equal(a.wallets[0].address, 'b1');
});

test('selling inside the window is recorded on the wallet', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(3, 'b1', 4_000_000, false)], base);
  assert.equal(a.wallets[0].soldInWindow, true);
});

test('unknown supply yields null percentages, never zero', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000)], { ...base, supply: null });
  assert.equal(a.bundle.boughtPct, null);
  assert.equal(a.wallets[0].boughtPct, null);
  assert.ok(a.bundle.bought > 0, 'the raw token amount is still known');
});

test('no trades produces an empty analysis rather than a throw', () => {
  const a = analyseLaunch([], base);
  assert.equal(a.launchSlot, null);
  assert.equal(a.bundle.boughtPct, null);
  assert.equal(a.wallets.length, 0);
});

// ── Top-3 buyers (volatility input) ───────────────────────────────────

test('top3BuyersPct sums the three largest NON-creator buys', () => {
  const a = analyseLaunch(
    [
      t(0, DEV, 500_000_000), // the creator is excluded however large
      t(0, 'b1', 100_000_000), // 10%
      t(1, 'b2', 50_000_000), // 5%
      t(2, 'b3', 30_000_000), // 3%
      t(3, 'b4', 20_000_000), // 2% — fourth, not counted
    ],
    base,
  );
  assert.ok(Math.abs(a.top3BuyersPct - 18) < 1e-9, `got ${a.top3BuyersPct}`);
});

test('top3BuyersPct works with fewer than three buyers and is null with none but the creator', () => {
  const two = analyseLaunch([t(0, 'b1', 100_000_000), t(1, 'b2', 50_000_000)], base);
  assert.ok(Math.abs(two.top3BuyersPct - 15) < 1e-9);
  const devOnly = analyseLaunch([t(0, DEV, 100_000_000)], base);
  assert.equal(devOnly.top3BuyersPct, null);
});

test('top3BuyersPct is null without supply, never zero', () => {
  const a = analyseLaunch([t(0, 'b1', 100_000_000), t(1, 'b2', 50_000_000)], { ...base, supply: null });
  assert.equal(a.top3BuyersPct, null);
  assert.equal(analyseLaunch([], base).top3BuyersPct, null);
});

test('top3BuyersPct survives applyBalances unchanged', () => {
  const a = analyseLaunch([t(0, 'b1', 100_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 0]]), SUPPLY);
  assert.equal(priced.top3BuyersPct, a.top3BuyersPct, 'it is a BOUGHT share, not a held one');
});

// ── Balances ──────────────────────────────────────────────────────────

test('an unpriced cohort reports null held, NOT zero', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(0, 'b2', 10_000_000)], base);
  assert.equal(a.bundle.heldPct, null, 'before pricing');
  const priced = applyBalances(a, new Map(), SUPPLY);
  assert.equal(priced.bundle.heldPct, null, 'an empty balance map is an unknown, not a dump');
  assert.equal(priced.bundle.stillHolding, null);
});

test('a partially priced cohort measures retention only over what it knows', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(0, 'b2', 30_000_000)], base);
  // Only b1 came back: it kept half of its 10M. b2 is unknown and must not be
  // read as a dump, so retention is 50% of b1's buy — not 5% of both.
  const priced = applyBalances(a, new Map([['b1', 5_000_000]]), SUPPLY);
  assert.ok(Math.abs(priced.bundle.retainedPct - 50) < 1e-9, `got ${priced.bundle.retainedPct}`);
  assert.equal(priced.bundle.stillHolding, 1);
  assert.ok(Math.abs(priced.bundle.heldPct - 0.5) < 1e-9);
  assert.equal(priced.wallets.find((w) => w.address === 'b2').heldNow, null);
});

test('an explicit zero balance IS a dump', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 0]]), SUPPLY);
  assert.equal(priced.bundle.retainedPct, 0);
  assert.equal(priced.bundle.stillHolding, 0);
  assert.equal(priced.bundle.heldPct, 0);
});

test('retention cannot exceed 100% when a wallet bought more after the window', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 90_000_000]]), SUPPLY);
  assert.equal(priced.bundle.retainedPct, 100);
  assert.ok(priced.bundle.heldPct > 8, 'the held share is still reported in full');
});

test('pricing one cohort leaves the others untouched', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(2, 's1', 10_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 10_000_000]]), SUPPLY);
  assert.ok(priced.bundle.heldPct !== null);
  assert.equal(priced.snipers.heldPct, null);
});

// ── Provider normalisation (pump's coin tape, 2026-11-01) ─────────────

const WSOL_ID = 'So11111111111111111111111111111111111111112';
/** A tape row in the route's shape — this one is the live row from 2026-11-01. */
const row = (over = {}) => ({
  ordinalKey: '464319340-626-401-1793584802000',
  blockId: '464319340',
  blockTimeMs: 1793584802000,
  txId: 'sig',
  side: 'sell',
  kind: 'swap',
  venue: 'pump_amm',
  trader: { address: 'wallet' },
  baseAmount: { raw: '4695052546321', decimals: 6 },
  quoteAmount: { raw: '240563168', decimals: 9 },
  quote: { id: WSOL_ID },
  priceQuote: '0.000000051480502591',
  valueNative: '0.240563168',
  ...over,
});

test('a malformed tape row is dropped, not coerced', () => {
  assert.equal(normaliseTrade(row({ blockTimeMs: undefined })), null, 'no time');
  assert.equal(normaliseTrade(row({ blockId: 'x' })), null, 'no slot');
  assert.equal(normaliseTrade(row({ side: 'transfer' })), null, 'not a buy or sell');
  assert.equal(normaliseTrade(row({ kind: 'perp_fill' })), null, 'not a swap');
  assert.equal(normaliseTrade(row({ trader: null })), null, 'no trader');
  assert.equal(normaliseTrade(row({ baseAmount: { raw: '-1', decimals: 6 } })), null, 'no token amount');
});

test('a well-formed tape row normalises with the fields the analysis needs', () => {
  const n = normaliseTrade(row());
  assert.equal(n.slot, 464319340, 'blockId is the slot');
  assert.equal(n.isBuy, false);
  assert.equal(n.user, 'wallet');
  assert.ok(Math.abs(n.base - 4695052.546321) < 1e-6, 'raw over decimals');
  assert.equal(n.sol, 0.240563168, 'SOL from the quote leg on a SOL pair');
  assert.equal(n.ts, 1793584802000);
  assert.equal(n.program, 'pump_amm');
  assert.equal(n.tx, 'sig');
  assert.equal(normaliseTrade(row({ venue: 'pump' })).program, 'pump', 'the curve keeps the name the analysis uses');
  // A row quoted in something else: pump's SOL value of it.
  assert.equal(normaliseTrade(row({ quote: { id: 'USDC' }, valueNative: '1.5' })).sol, 1.5);
  assert.equal(rowPriceSol(row()), 0.000000051480502591, "pump's price on a SOL pair");
  assert.ok(Math.abs(rowPriceSol(row({ priceQuote: null })) - 0.240563168 / 4695052.546321) < 1e-18, 'else the average');
});

// ── Seeking the tape by slot ──────────────────────────────────────────
//
// A simulated tape that answers the way the route's table says it does:
// `before` newest first below a slot, `after` oldest first from one, an
// opaque cursor that carries on in the same direction. The chain's slot rate
// CHANGES part-way (400 ms, then 213 ms — Alpenglow), so a seek cannot just
// multiply.
const SWITCH_SLOT = 400_000_000;
const SWITCH_MS = 1_790_000_000_000;
const msAt = (slot) => Math.floor((SWITCH_MS + (slot < SWITCH_SLOT ? (slot - SWITCH_SLOT) * 400 : (slot - SWITCH_SLOT) * 213)) / 1000) * 1000;
// `by`: which half of a seek key the simulated server reads. The schema says
// the slot leads; live (2026-11-01) it sought on the TIME, so every seek test
// runs against both.
function tape(slots, by = 'slot') {
  const sorted = [...slots].sort((a, b) => a - b);
  const rows = sorted.map((s, i) => row({ ordinalKey: `${s}-${i}-0-${msAt(s)}`, blockId: String(s), blockTimeMs: msAt(s), side: 'buy', priceQuote: String(s), txId: `t${i}` }));
  const calls = [];
  const fetch = async (path) => {
    const q = new URL(path, 'https://x').searchParams;
    calls.push(Object.fromEntries(q));
    const limit = Number(q.get('limit') ?? 100);
    // The first row at or past a slot — `after` reads from it, `before` stops short of it.
    const at = (key) => {
      const parts = key.split('-').map(Number);
      const i = by === 'time' ? rows.findIndex((r) => r.blockTimeMs >= parts[3]) : rows.findIndex((r) => Number(r.blockId) >= parts[0]);
      return i < 0 ? rows.length : i;
    };
    let dir;
    let idx;
    if (q.get('cursor')) ({ dir, idx } = JSON.parse(q.get('cursor')));
    else if (q.get('after')) [dir, idx] = ['after', at(q.get('after'))];
    else if (q.get('before')) [dir, idx] = ['before', at(q.get('before'))];
    else [dir, idx] = ['before', rows.length];
    let pick;
    let next = null;
    if (dir === 'after') {
      pick = rows.slice(idx, idx + limit);
      if (idx + limit < rows.length) next = { dir, idx: idx + limit };
    } else {
      const lo = Math.max(0, idx - limit);
      pick = rows.slice(lo, idx).reverse();
      if (lo > 0) next = { dir, idx: lo };
    }
    return { ok: true, message: 'ok', ms: 1, status: 200, data: { trades: pick, cursor: next ? JSON.stringify(next) : null } };
  };
  return { fetch, calls };
}

for (const by of ['slot', 'time']) {
  test(`price at a moment: the newest trade before it, found from far away, in a few calls (seek by ${by})`, async () => {
    // Known pairs a month off, on the other side of the rate change.
    _resetAnchors([[SWITCH_SLOT + 12_000_000, msAt(SWITCH_SLOT + 12_000_000)]]);
    const slots = Array.from({ length: 3000 }, (_, i) => SWITCH_SLOT - 500_000 + i * 37);
    const tp = tape(slots, by);
    _setPageSource(tp.fetch);
    const target = SWITCH_SLOT - 450_000 + 5; // between two trades
    const at = msAt(target);
    const want = [...slots].reverse().find((s) => msAt(s) <= at);
    const r = await priceAt('M', at);
    assert.equal(r.price, want, `the newest trade at or before the moment (got ${r.price}, want ${want})`);
    assert.ok(tp.calls.length <= 4, `${tp.calls.length} calls`);
    // Now the map knows this stretch: the next moment nearby is one call.
    const before = tp.calls.length;
    const r2 = await priceAt('M', msAt(target + 900));
    assert.equal(r2.price, [...slots].reverse().find((s) => msAt(s) <= msAt(target + 900)));
    assert.equal(tp.calls.length - before, 1, 'one call once the stretch is known');
    // Before the coin's first trade: no price, and not a failure.
    const none = await priceAt('M', msAt(slots[0] - 10_000));
    assert.equal(none.price, null);
    assert.equal(none.failed, false);
    _setPageSource(null);
  });

  test(`price at a moment on a busy coin: 30 s past the moment is pages of trades, so the seek narrows (seek by ${by})`, async () => {
    // 40 trades in every slot: half a minute is ~5,600 trades, 56 pages.
    _resetAnchors([[SWITCH_SLOT + 2_000_000, msAt(SWITCH_SLOT + 2_000_000)]]);
    const base = SWITCH_SLOT + 1_000_000;
    const slots = Array.from({ length: 2_000 * 40 }, (_, i) => base + Math.floor(i / 40));
    const tp = tape(slots, by);
    _setPageSource(tp.fetch);
    const at = msAt(base + 1_000) + 500;
    const want = [...slots].reverse().find((s) => msAt(s) <= at);
    const r = await priceAt('M', at);
    assert.equal(r.price, want, `the newest trade at or before the moment (got ${r.price}, want ${want})`);
    assert.ok(tp.calls.length <= 4, `${tp.calls.length} calls`);
    _setPageSource(null);
  });

  test(`launch read: trade #1 from a creation time, a busy launch paged, an unreachable one refused (seek by ${by})`, async () => {
    _resetAnchors();
    const created = SWITCH_SLOT + 3_000_000;
    // 250 trades in the first 12 slots, then a quiet tail.
    const slots = [...Array.from({ length: 250 }, (_, i) => created + Math.floor(i / 21)), ...Array.from({ length: 50 }, (_, i) => created + 1_000 + i * 50)];
    const tp = tape(slots, by);
    _setPageSource(tp.fetch);
    const scan = await launchTrades('M', msAt(created));
    assert.equal(scan.complete, true);
    assert.equal(scan.trades[0].slot, created, 'the first row is trade #1');
    assert.ok(scan.trades.length >= 250, `the busy launch was paged (${scan.trades.length})`);
    assert.equal(new Set(scan.trades.map((t) => t.tx)).size, scan.trades.length, 'no row twice');
    assert.ok(scan.calls <= 5, `${scan.calls} calls`);

    // A coin whose first indexed trade is hours after creation: not a launch.
    _resetAnchors();
    _setPageSource(tape([created + 40_000, created + 40_100], by).fetch);
    const far = await launchTrades('M', msAt(created));
    assert.equal(far.complete, false);
    assert.match(far.message, /does not reach/);

    // Never traded.
    _setPageSource(tape([], by).fetch);
    const never = await launchTrades('M', msAt(created));
    assert.deepEqual([never.complete, never.message], [true, 'no trades']);
    _setPageSource(null);
  });
}

test('recent trades: newest pages back to the cut-off, handed over oldest first', async () => {
  _resetAnchors();
  const slots = Array.from({ length: 250 }, (_, i) => SWITCH_SLOT + i * 10);
  _setPageSource(tape(slots).fetch);
  const since = msAt(SWITCH_SLOT + 1_000);
  const r = await recentTrades('M', since, 3);
  assert.equal(r.complete, true);
  assert.equal(r.calls, 2);
  assert.ok(r.trades.every((t) => t.ts >= since));
  assert.ok(r.trades.every((t, i) => i === 0 || t.slot > r.trades[i - 1].slot), 'oldest first');
  assert.equal(r.trades[r.trades.length - 1].slot, slots[slots.length - 1]);
  _setPageSource(null);
});

// ── Creator track record ──────────────────────────────────────────────

const launch = (daysAgo, graduated = false, athUsd = null) => ({
  mint: `m${daysAgo}${graduated}${athUsd}`,
  symbol: 'X',
  name: 'X',
  createdAt: 1_700_000_000_000 - daysAgo * 86_400_000,
  graduated,
  athUsd,
  marketCapUsd: null,
});

test('the busiest-day count finds a launch factory', () => {
  const h = summariseCreator('c', [launch(0), launch(0.1), launch(0.2), launch(0.3), launch(30)], false);
  assert.equal(h.launches, 5);
  assert.equal(h.launchesInBusiestDay, 4, 'the four clustered launches, not the old one');
});

test('graduation rate and median ATH come from the launches that report one', () => {
  const h = summariseCreator('c', [launch(1, true, 100), launch(2, false, 50), launch(3, false, null)], false);
  assert.equal(h.graduated, 1);
  assert.ok(Math.abs(h.graduationRate - 33.333) < 0.01);
  assert.equal(h.medianAthUsd, 100, 'nulls are excluded rather than counted as zero');
  assert.equal(h.bestAthUsd, 100);
});

test('a single launch is a first-timer, not a suspect', () => {
  const v = creatorVerdict(summariseCreator('c', [launch(0)], false));
  assert.equal(v.verdict, 'pass');
});

test('a launch factory fails regardless of graduations', () => {
  const many = Array.from({ length: 12 }, (_, i) => launch(i * 0.05, i < 2));
  const v = creatorVerdict(summariseCreator('c', many, false));
  assert.equal(v.verdict, 'fail');
  assert.match(v.detail, /factory/i);
});

test('a spread-out history with graduations passes', () => {
  const h = summariseCreator('c', [launch(1, true), launch(40, true), launch(80, false)], false);
  const v = creatorVerdict(h);
  assert.equal(v.verdict, 'pass');
  assert.equal(h.launchesInBusiestDay, 1);
});

test('an unknown creator is null, not a pass', () => {
  assert.equal(creatorVerdict(null).verdict, null);
});

// ── Odds context derivation (electron/data/launchIntel.ts) ────────────
//
// The pure helpers that turn a pump.fun coin record + a launch scan into the
// scoring context for shared/odds.ts. Bundled here so package.json needs no
// new entry; the electron module has no electron import. When shared/odds.ts
// has not landed yet, its import is stubbed — none of these helpers call it.

import { existsSync } from 'node:fs';
import { buildSync } from 'esbuild';
const oddsAlias = existsSync('shared/odds.ts') ? {} : { '@shared/odds': './test/.oddsstub.mjs' };
if (!existsSync('shared/odds.ts')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('test/.oddsstub.mjs', 'export const oddsFeaturesFromTrades = () => null; export const scoreOdds = () => null;');
}
buildSync({
  entryPoints: ['electron/data/launchIntel.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { '@shared': './shared', ...oddsAlias },
  // launchIntel reads the chain through data/pumpChain since 2026-09-20,
  // which pulls the PumpSwap builder and its web3.js dependency into the
  // graph; that CJS package cannot be inlined into an ESM bundle.
  external: ['@solana/web3.js', 'undici', 'ws'],
  banner: { js: "import{createRequire}from 'module';const require=createRequire(import.meta.url);" },
  outfile: 'test/.launchintelmain.mjs',
  logLevel: 'silent',
});
const { oddsCtxFromCoin, oddsWindowForAge, oddsCreateSlot, curveProgressFromCoin } = await import('./.launchintelmain.mjs');

test('odds ctx: supply is total_supply scaled by base_decimals, null when absent', () => {
  assert.equal(oddsCtxFromCoin({ total_supply: 1_000_000_000_000_000, base_decimals: 6 }).supply, 1_000_000_000);
  assert.equal(oddsCtxFromCoin({ total_supply: 1_000_000_000_000_000, base_decimals: 9 }).supply, 1_000_000);
  // No decimals field → pump's default of 6, same as the rug path.
  assert.equal(oddsCtxFromCoin({ total_supply: 1_000_000_000_000_000 }).supply, 1_000_000_000);
  assert.equal(oddsCtxFromCoin({}).supply, null);
  assert.equal(oddsCtxFromCoin({ total_supply: 0 }).supply, null);
});

test('odds ctx: hasTwitter is null when the field is missing, false when empty, true when set', () => {
  assert.equal(oddsCtxFromCoin({}).hasTwitter, null);
  assert.equal(oddsCtxFromCoin({ twitter: undefined }).hasTwitter, null);
  assert.equal(oddsCtxFromCoin({ twitter: '' }).hasTwitter, false);
  assert.equal(oddsCtxFromCoin({ twitter: '   ' }).hasTwitter, false);
  assert.equal(oddsCtxFromCoin({ twitter: null }).hasTwitter, false);
  assert.equal(oddsCtxFromCoin({ twitter: 'https://x.com/a' }).hasTwitter, true);
});

test('odds ctx: reserves stay RAW and curve progress matches the rug reader', () => {
  const coin = { virtual_sol_reserves: 30_000_000_000, virtual_token_reserves: 1_073_000_000_000_000, base_decimals: 6 };
  const c = oddsCtxFromCoin(coin);
  assert.equal(c.virtualSolReserves, 30_000_000_000);
  assert.equal(c.virtualTokenReserves, 1_073_000_000_000_000);
  assert.equal(c.curveProgress, curveProgressFromCoin(coin));
  assert.equal(c.curveProgress, 0);
  const u = oddsCtxFromCoin({});
  assert.equal(u.virtualSolReserves, null);
  assert.equal(u.virtualTokenReserves, null);
  assert.equal(u.curveProgress, null);
});

test('odds window: nothing under 60 s, 60 until 120, then 120', () => {
  assert.equal(oddsWindowForAge(0), null);
  assert.equal(oddsWindowForAge(59.9), null);
  assert.equal(oddsWindowForAge(60), 60);
  assert.equal(oddsWindowForAge(119), 60);
  assert.equal(oddsWindowForAge(120), 120);
  assert.equal(oddsWindowForAge(86_400), 120);
  assert.equal(oddsWindowForAge(NaN), null);
});

test('odds ctx: a graduated coin reads progress 1 (oddsFor itself refuses it)', () => {
  assert.equal(oddsCtxFromCoin({ complete: true }).curveProgress, 1);
});

test('odds create slot: earliest slot only when the scan reached the launch', () => {
  const trades = [t(5, 'a', 1), t(0, DEV, 1), t(2, 'b', 1)];
  assert.equal(oddsCreateSlot(trades, true), 1000);
  assert.equal(oddsCreateSlot(trades, false), null);
  assert.equal(oddsCreateSlot([], true), null);
});

// pump.fun's candle route (2026-10-01): rows as captured from
// swap-api.pump.fun/v1/coins/{mint}/candles — ms timestamps, string numbers.
// The current route (2026-11-01) names them openTimeMs and volumeUsd.
test('pump candles: ms timestamps become seconds, strings become numbers, oldest first', () => {
  const rows = parseCandles([
    { timestamp: 1790896320000, open: '0.0000036617', high: '0.0000040', low: '0.0000030', close: '0.0000035', volume: '12.5' },
    { timestamp: 1790896260000, open: '0.000003303073718443616029822926374650512581547', high: '0.0000036617360528928628322894', low: '0.000003303073718443616029822926374650512581547', close: '0.0000036617360528928628322894', volume: '99.007547360544583156' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].time, 1790896260, 'seconds, oldest first');
  assert.ok(Math.abs(rows[0].open - 3.303073718443616e-6) < 1e-18, 'the long decimal string parses');
  assert.equal(rows[1].volume, 12.5);
});

test('pump candles: the current route\'s openTimeMs and volumeUsd read the same', () => {
  const rows = parseCandles([{ openTimeMs: 1790896260000, open: '0.1', high: '0.2', low: '0.05', close: '0.15', volumeUsd: '42.5', trades: 3, final: true }]);
  assert.deepEqual(rows, [{ time: 1790896260, open: 0.1, high: 0.2, low: 0.05, close: 0.15, volume: 42.5 }]);
});

test('pump candles: a row missing a price is dropped, never drawn as zero', () => {
  const rows = parseCandles([
    { timestamp: 1790896260000, open: '0.1', high: '0.2', low: null, close: '0.1', volume: '1' },
    { timestamp: 1790896320000, open: '0', high: '0.2', low: '0.1', close: '0.1', volume: '1' },
    { timestamp: 'x', open: '0.1', high: '0.2', low: '0.1', close: '0.1' },
    null,
    { timestamp: 1790896380000, open: '0.1', high: '0.2', low: '0.1', close: '0.15' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].volume, 0, 'unknown volume is no bar height, not a price');
});

test('pump candles: 5s is built from 1s — open first, close last, extremes, summed volume', () => {
  const one = (time, o, h, l, c, v) => ({ time, open: o, high: h, low: l, close: c, volume: v });
  const five = rebucket([one(100, 1, 2, 1, 2, 1), one(101, 2, 5, 2, 3, 2), one(104, 3, 3, 0.5, 1, 3), one(105, 1, 1, 1, 1, 4)], 5);
  assert.deepEqual(five, [one(100, 1, 5, 0.5, 1, 6), one(105, 1, 1, 1, 1, 4)]);
  assert.equal(candlesSupported('5s'), true);
  assert.equal(candlesSupported('1s'), true);
  assert.equal(candlesSupported('4h'), true);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`launchintel: ${passed}/${cases.length} tests passed`);
}

await run();
