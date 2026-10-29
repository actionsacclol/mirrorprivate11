// Copy-trading tests.
//
// A paper scorecard exists to inform a decision to risk real money, so the
// ways it can flatter itself are the bugs that matter:
//
//   • filling at the follower's price instead of the price after your delay;
//   • hiding the trades your filters rejected;
//   • ignoring the protocol fee a real round trip would have paid;
//   • letting a LIVE config resume armed after a restart.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as copy from './.copytrade.mjs';
import { crowdNoun, describeConfig, COPY_LATENCY_FLOOR_MS, FOMO_WALLET, MIN_TRIPS_FOR_RANK, SIMPLE_MAX_SOL, SIMPLE_SIZES, TOO_FAST_FLAG_PCT, chainForAddress, cleanBlocklist, copySize, defaultConfig, emptyLeaderStats, isBlocked, leaderTooFast, leaderWinRate, ownExitsOf, rankLeaders, simpleConfig, validateConfig, winRate, followConfig, minLeaderFor, FOLLOW_PCTS, FOLLOW_MAX_SOL, MIN_LIVE_COPY_SOL, activeWindowOf, inActiveWindow, fmtClock, isWatch, localMinuteOfDay } from './.copyshared.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// Base58 has no lowercase L, and validateConfig now checks the real
// alphabet rather than a bare length, so "Whale" is not a valid address.
const WALLET = 'Whae1111111111111111111111111111111111111';
const MINT = 'CopyMint111111111111111111111111111111111';

function makeHost(over = {}) {
  // `opts` is recorded SEPARATELY: the pinned sell assertion is a deepEqual
  // on { mint, pct } and must stay exactly that shape.
  const calls = { buys: [], sells: [], toasts: [], buyOpts: [], sellOpts: [] };
  // A simulated token account, when `over.chain` asks for one. `balance` is
  // what the wallet already holds (a hand-bought bag), `bought` is what the
  // copy's buy delivers, and `fillShare` is the share of a sell request that
  // actually moves — which is how the reported bug is reproduced: a sell
  // that CONFIRMS and moves less than it was asked for.
  const chain = over.chain ? { decimals: 6, bought: 1_000_000_000n, balance: 0n, ...over.chain } : null;
  const fills = new Map();
  const host = {
    buy: async (mint, sol, opts) => {
      calls.buys.push({ mint, sol });
      calls.buyOpts.push(opts);
      if (over.buyMs) await new Promise((r) => setTimeout(r, over.buyMs));
      const res = over.buyResult ?? { ok: true, message: 'bought', signature: 'sig' };
      if (chain && res.ok && res.signature) {
        chain.balance += chain.bought;
        fills.set(res.signature, chain.bought);
      }
      return res;
    },
    sell: async (mint, pct, opts) => {
      calls.sells.push({ mint, pct });
      calls.sellOpts.push(opts);
      if (over.sellResult) return over.sellResult;
      if (!chain) return { ok: true, message: 'sold', signature: 'sellsig' };
      const asked = opts?.tokensRaw ? BigInt(opts.tokensRaw) : (chain.balance * BigInt(Math.round(pct * 100))) / 10_000n;
      // The EVM rail REFUSES an exact size it cannot cover rather than
      // clamping it — a balance that moved under the plan lands here.
      if (asked > chain.balance) return { ok: false, message: 'That is more than this wallet holds' };
      let moved = (asked * BigInt(Math.round((over.fillShare ?? 1) * 10_000))) / 10_000n;
      if (moved > chain.balance) moved = chain.balance;
      chain.balance -= moved;
      const sig = `sellsig${calls.sells.length}`;
      fills.set(sig, moved);
      return { ok: true, message: 'sold', signature: sig };
    },
    liveBlockedReason: () => over.liveBlockedReason ?? null,
    priceSol: () => (over.priceSol === undefined ? 0.001 : over.priceSol),
    tokenFacts: async () =>
      over.facts ?? { liquidityUsd: 50_000, marketCapUsd: 100_000, kryptScore: 80, isPumpfun: true },
    log: () => {},
    toast: (level, message) => calls.toasts.push({ level, message }),
    changed: () => {},
  };
  // The optional methods exist only when a test asks for them — the module
  // must work against a host that implements none of them.
  if (over.ourCostBasisSol !== undefined) host.ourCostBasisSol = () => over.ourCostBasisSol;
  if (chain) {
    calls.tokenReads = [];
    host.walletTokens = async (mint) => {
      calls.tokenReads.push(mint);
      // An unreadable balance is null, never zero — the distinction the
      // whole sweep rests on.
      return over.unreadableBalance ? null : { raw: chain.balance.toString(), decimals: chain.decimals };
    };
    host.fillTokens = async (sig) => (fills.has(sig) ? { raw: fills.get(sig).toString(), decimals: chain.decimals } : null);
    calls.chain = chain;
  }
  if (over.leaderFeed !== undefined) {
    host.leaderFeed = (chain) => (chain === 'solana' ? null : over.leaderFeed);
  }
  if (over.buyFill !== undefined) {
    calls.buyFills = [];
    host.buyFill = async (mint, atMs) => {
      calls.buyFills.push({ mint, atMs });
      return over.buyFill;
    };
  }
  if (over.host) Object.assign(host, over.host);
  if (over.buyBlockedReason !== undefined) host.buyBlockedReason = () => over.buyBlockedReason;
  if (over.maxLiveSol !== undefined) host.maxLiveSol = () => over.maxLiveSol;
  if (over.leaderHolding !== undefined) {
    calls.holdingReads = [];
    host.leaderHolding = async (w, m, _chain, opts) => {
      calls.holdingReads.push({ wallet: w, mint: m, minContextSlot: opts?.minContextSlot ?? null });
      if (typeof over.leaderHolding === 'function') return over.leaderHolding();
      return over.leaderHolding;
    };
  }
  return { calls, host };
}

function setup(over = {}) {
  copy._reset();
  const h = makeHost(over);
  copy.attach(h.host);
  return h;
}

const cfg = (over = {}) => ({ ...defaultConfig(WALLET, 'Sharky'), enabled: true, ...over });

// Creating a LIVE follower never arms it — one `copy:save` must not be able to
// start spending real SOL — so a test that wants an armed live config saves
// twice, which is exactly what the user does.
const save = (over = {}) => {
  const c = cfg(over);
  const r = copy.upsert(c);
  if (!r.ok) return r;
  const made = copy.all().find((x) => x.wallet === c.wallet);
  if (made && c.enabled && !made.enabled) return copy.upsert({ ...c, id: made.id });
  return r;
};

const trade = (over = {}) => ({
  wallet: WALLET,
  mint: MINT,
  symbol: 'COPY',
  isBuy: true,
  sol: 1,
  priceSol: 0.001,
  at: Date.now(),
  ...over,
});

// ── Sizing ────────────────────────────────────────────────────────────

test('fixed sizing ignores their size; proportional follows it, both capped', () => {
  const fixed = { sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 };
  assert.equal(copySize(fixed, 10), 0.05);
  assert.equal(copySize(fixed, 0.01), 0.05);
  const prop = { sizing: 'proportional', sizeValue: 10, maxTradeSol: 0.5 };
  assert.equal(copySize(prop, 1), 0.1);
  assert.equal(copySize(prop, 100), 0.5, 'the cap must bind');
});

test('validation rejects configs that cannot work', () => {
  assert.equal(validateConfig(cfg({ wallet: 'short' })).ok, false);
  assert.equal(validateConfig(cfg({ sizeValue: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ maxTradeSol: 100 })).ok, false);
  assert.equal(validateConfig(cfg({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 0.1 })).ok, false);
  assert.equal(validateConfig(cfg({ delayMs: 120_000 })).ok, false);
  assert.equal(validateConfig(cfg({ dailyLossLimitSol: 0 })).ok, false);
  assert.equal(validateConfig(cfg()).ok, true);
});

test('a config defaults to PAPER and disabled', () => {
  const d = defaultConfig(WALLET, 'x');
  assert.equal(d.mode, 'paper');
  assert.equal(d.enabled, false);
});

// ── Paper honesty ─────────────────────────────────────────────────────

test('a paper fill uses the price AFTER the configured delay, not theirs', async () => {
  // Their trade prints at 0.001. By the time our delay elapses the tape is
  // at 0.0015 — that is what we would actually have paid.
  const h = setup({ priceSol: 0.0015 });
  save({ delayMs: 5 });
  copy.onWalletTrade(trade({ priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 60));

  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.ok(open, 'a copy should have opened');
  assert.equal(open.entryPriceSol, 0.0015, 'filling at their price would flatter the record');
});

test('a paper round trip pays BOTH sides of every fee a real one would', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));
  // They sell at exactly the entry price: a fee-free model would show 0.
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.001, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 20));

  const closed = copy.snapshot().recent.find((t) => t.state === 'closed');
  assert.ok(closed, 'the copy should have closed');
  assert.ok(closed.pnlSol < 0, 'a flat round trip must LOSE money, as it does in real life');
  // pump's tiered 1.25 % + 0.5 % Krypt, on the way in AND on the way out
  // (1.75 % a side, 3.5 % on a 1 SOL round trip), plus each transaction's
  // fixed cost — the priority floors, the base fee and the mean tip, 0.003504
  // SOL a round trip. Charging one side only, or the percentages only,
  // flattered every paper record (2026-10-22: 7 % of a 0.05 SOL copy).
  assert.ok(Math.abs(closed.pnlSol - -0.038504) < 1e-9, `expected ~-0.0385, got ${closed.pnlSol}`);
  assert.equal(closed.pnlBasis, 'model');
  assert.equal(closed.paperModel, 2, 'the row says which model priced it');
});

test('paper fixed fees bite hardest on the small copies the simple page defaults to', async () => {
  setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.05, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.001, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 20));
  const closed = copy.snapshot().recent.find((t) => t.kind === 'exit');
  // 0.05 × −3.5 % = −0.00175, plus 0.003504 fixed: −0.005254, −10.5 % flat.
  assert.ok(Math.abs(closed.pnlSol - -0.005254) < 1e-9, `got ${closed.pnlSol}`);
});

test('a paper exit mirroring their SELL fills at the harsher of their price and the spot', async () => {
  // They sold at an average of 0.002; their sell left the tape at 0.0015.
  // We sell after them, so 0.0015 is what we would have got.
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));
  h.host.priceSol = () => 0.0015;
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.002, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 20));
  let slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(slice.exitPriceSol, 0.0015, 'not their 0.002');
  // And a spot that reads ABOVE their fill does not lift us above it.
  setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));
  copy.attach({ ...makeHost({ priceSol: 0.003 }).host });
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.002, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 20));
  slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(slice.exitPriceSol, 0.002);
});

test('every row stores what the LEADER paid, so the entry premium can be read', async () => {
  setup({ priceSol: 0.0013 });
  save({ delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001, signature: 'lp1' }));
  await new Promise((r) => setTimeout(r, 20));
  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.equal(open.leaderPriceSol, 0.001);
  assert.equal(open.entryPriceSol, 0.0013, '30 % above them, and the row can say so');
});

test('filtered-out trades are RECORDED as skips with a reason', async () => {
  const h = setup({ facts: { liquidityUsd: 100, marketCapUsd: 1000, kryptScore: 10, isPumpfun: true } });
  save({ minLiquidityUsd: 5000 });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));

  const rows = copy.snapshot().recent;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'skipped');
  assert.match(rows[0].reason, /liquidity below/);
  const st = Object.values(copy.snapshot().stats)[0];
  assert.equal(st.skipped, 1, 'a scorecard that hides skips measures the wrong thing');
  assert.equal(st.trades, 0);
});

test('each filter rejects for its own stated reason', async () => {
  const checks = [
    [{ maxMarketCapUsd: 50_000 }, { liquidityUsd: 99_000, marketCapUsd: 100_000, kryptScore: 90, isPumpfun: true }, /market cap above/],
    [{ minKryptScore: 70 }, { liquidityUsd: 99_000, marketCapUsd: 10_000, kryptScore: 30, isPumpfun: true }, /score 30 below/],
    [{ onlyPumpfun: true }, { liquidityUsd: 99_000, marketCapUsd: 10_000, kryptScore: 90, isPumpfun: false }, /not a pump\.fun token/],
  ];
  for (const [over, facts, re] of checks) {
    setup({ facts });
    save({ minLiquidityUsd: null, ...over });
    copy.onWalletTrade(trade());
    await new Promise((r) => setTimeout(r, 30));
    const rows = copy.snapshot().recent;
    assert.equal(rows[0].state, 'skipped');
    assert.match(rows[0].reason, re);
  }
});

test('paper mode never calls the live buy path', async () => {
  const h = setup();
  save({ mode: 'paper' });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0, 'paper must not touch the signer');
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

// ── Live gating ───────────────────────────────────────────────────────

test('live mode calls the buy path and records the fill', async () => {
  const h = setup();
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ sol: 5 }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 1);
  assert.equal(h.calls.buys[0].sol, 0.05);
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

test('a live copy that sizes under the 0.03 SOL floor is refused with the reason, never raised', async () => {
  const h = setup();
  // 2% of a 1 SOL leader buy = 0.02 SOL. The config is valid (its max is
  // 0.5); the size it comes to on THIS trade is not.
  save({ mode: 'live', sizing: 'proportional', sizeValue: 2, maxTradeSol: 0.5 });
  copy.onWalletTrade(trade({ sol: 1 }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0, 'no buy');
  assert.match(copy.snapshot().recent[0].reason, /under the smallest live copy \(0\.03 SOL\)/);
  // The same leader buying 5 SOL sizes to 0.1: copied.
  copy.onWalletTrade(trade({ sol: 5, mint: 'Bigger1111111111111111111111111111111111111', signature: 'big' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 1);
  assert.ok(Math.abs(h.calls.buys[0].sol - 0.1) < 1e-9);
});

test('a blocked live copy is skipped with the reason, and does not buy', async () => {
  const h = setup({ liveBlockedReason: 'the engine is not armed' });
  save({ mode: 'live' });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /not armed/);
});

// Krypto Trader stage 3 (critic #6): a live session's (wallet, coin) pair is
// its own; a live copy into it is skipped with the session named.
test('a live Krypto Trader claim on the coin skips the copy, naming the session', async () => {
  const h = setup();
  const asked = [];
  copy.setTraderClaimCheck((ref, mint) => {
    asked.push(ref);
    return mint === MINT ? 'a live Krypto Trader session (KT, kt_abc) trades this coin from wallet Wa11et…' : null;
  });
  try {
    save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
    copy.onWalletTrade(trade({ sol: 5 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.calls.buys.length, 0, 'no buy');
    assert.match(copy.snapshot().recent[0].reason, /Krypto Trader session \(KT, kt_abc\)/);
    assert.deepEqual(asked[0], { walletId: null }, 'a config with no wallet of its own is checked against the active one');
  } finally {
    copy.setTraderClaimCheck(null);
  }
});

test('a failed live buy is recorded, not silently dropped', async () => {
  const h = setup({ buyResult: { ok: false, message: 'relayer rejected' } });
  save({ mode: 'live' });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent[0].state, 'skipped');
  assert.match(copy.snapshot().recent[0].reason, /relayer rejected/);
});

// ── Limits ────────────────────────────────────────────────────────────

test('the daily trade limit stops further copies', async () => {
  setup();
  save({ dailyTradeLimit: 2 });
  for (let i = 0; i < 4; i++) {
    copy.onWalletTrade(trade({ mint: `Mint${i}${'1'.repeat(36)}` }));
    await new Promise((r) => setTimeout(r, 15));
  }
  const st = Object.values(copy.snapshot().stats)[0];
  assert.equal(st.trades, 2, 'only two should have opened');
  assert.equal(st.blocked, 2, 'the rest are recorded as limit-blocked');
});

test('other wallets are ignored', async () => {
  const h = setup();
  save();
  copy.onWalletTrade(trade({ wallet: 'Someone1111111111111111111111111111111111' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent.length, 0);
});

test('a disabled config copies nothing', async () => {
  setup();
  save({ enabled: false });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent.length, 0);
});

// ── Mirrored sells (2026-09-08) ───────────────────────────────────────
//
// A user's report: copied buys landed, then "the first TP sold 40 %" and
// the history said the later sells happened while the wallet still held
// the coins. The 40 % was their own take-profit ladder; the copier had
// never placed a sell at all — a leader's sell only flipped the record to
// "closed". These pin the real thing: a live copy sells the leader's share
// of what WE hold, through the host, and the record moves only on a fill.

const tick = () => new Promise((r) => setTimeout(r, 25));

async function openLiveCopy(over = {}) {
  const h = setup({ priceSol: 0.001, ...over });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buy1' }));
  await tick();
  assert.equal(h.calls.buys.length, 1, 'the copy bought');
  return h;
}

test('LIVE: a leader who sells 40 % makes us sell 40 % of OUR holding, and only that share is closed', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sell1' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }], 'one sell of 40 % of what we hold');
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(parent.state, 'open', 'most of the copy is still held');
  assert.equal(parent.remainingPct, 60);
  assert.equal(exit.state, 'closed');
  assert.equal(exit.soldPct, 40);
  assert.equal(exit.signature, 'sellsig');
  assert.ok(Math.abs(exit.ourSol - 0.4) < 1e-9, 'the slice is 40 % of the 1 SOL cost basis');
  // A live exit is priced from OUR fill (2026-10-22), and this host cannot
  // read one — so the slice has no result, not the leader's. The model's
  // estimate is kept for the daily loss limit only.
  assert.equal(exit.pnlSol, null, `slice PnL ${exit.pnlSol}`);
  assert.equal(exit.pnlBasis, 'pending');
  assert.equal(exit.exitPriceSol, null, 'their 0.002 is not our exit price');
  // 0.4 × (2 × 0.9825 − 1.0175) − 0.4 × 0.001061 − 0.002443 = 0.3761326
  assert.ok(Math.abs(exit.estPnlSol - 0.3761326) < 1e-9, `estimate ${exit.estPnlSol}`);
  assert.equal(parent.realizedSol ?? null, null, 'nothing is realised until a fill says so');
  assert.equal(parent.pnlSol, null, 'and no PnL of its own, so nothing counts twice');
  const stats = snap.stats[snap.configs[0].id];
  assert.equal(stats.trades, 1, 'an exit is not a trade');
  assert.equal(stats.realizedPnlSol, 0);
  assert.equal(stats.unpriced, 1, 'and the card says one exit is still waiting for its fill');
  assert.ok(Math.abs(stats.openCostSol - 0.6) < 1e-9, 'open cost is what is still held');
  assert.ok(h.calls.toasts.some((t) => t.level === 'success' && /Copied sell: 40%/.test(t.message)));
});

test('LIVE: an open copy is never pushed out of the book by newer rows (the cap is shared by every config)', async () => {
  // 2,000 skip rows used to evict the open copy; the leader's exit then found
  // nothing to close and placed NO sell (swarm 10-23, measured).
  const h = await openLiveCopy();
  copy.upsert({ ...copy.all()[0], minLeaderSol: 5 });
  for (let i = 0; i < 2_005; i += 1) copy.onWalletTrade(trade({ isBuy: true, sol: 1, mint: `Skip${i}`.padEnd(43, '1'), signature: `K${i}` }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'exitAll' }));
  await tick();
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 100 }], 'the leader exit still sells the copy');
});

test('LIVE: a sell sized from a balance that had not moved yet is topped up ONCE when the exact size arrives', async () => {
  // The firehose carries tokens but no fraction; the balance read can still
  // see the pre-sell bag (1,000 held + 1,000 sold reads as 50 %). The
  // watcher then delivers the same signature with the transaction's own
  // fraction (swarm 10-23: a 100 % exit was left at 50 %).
  const h = await openLiveCopy({ leaderHolding: 1000 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, tokens: 1000, signature: 'exitAll', slot: 123 }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 50 }], 'the recovered (too small) size is mirrored first');
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, tokens: 1000, soldFraction: 1, signature: 'exitAll' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 50 }, { mint: MINT, pct: 100 }], 'the rest is sold once');
  // A third delivery of the same transaction sells nothing more.
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, tokens: 1000, soldFraction: 1, signature: 'exitAll' }));
  await tick();
  assert.equal(h.calls.sells.length, 2, 'exactly once');
});

test('LIVE: a top-up is only for a recovered size that was too SMALL, and a 40 % trim tops up to 40 %, not more', async () => {
  // 1,000 held + 400 sold reads as 29 %; the transaction says 40 %.
  const h = await openLiveCopy({ leaderHolding: 1000 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.4, priceSol: 0.002, tokens: 400, signature: 'trim' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.4, priceSol: 0.002, tokens: 400, soldFraction: 0.4, signature: 'trim' }));
  await tick();
  assert.equal(h.calls.sells.length, 2);
  assert.equal(h.calls.sells[0].pct, 29);
  // (0.40 − 0.2857) / (1 − 0.2857) = 16 % of what is left → 29 % + 16 % × 71 % ≈ 40 % in all
  assert.equal(h.calls.sells[1].pct, 16);
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.ok(Math.abs(parent.remainingPct - 60) < 1, `remaining ${parent.remainingPct}`);

  // An exact first delivery, then a recovered one, never tops up.
  const h2 = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.4, priceSol: 0.002, tokens: 400, soldFraction: 0.4, signature: 'trim2' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.4, priceSol: 0.002, tokens: 400, soldFraction: 0.4, signature: 'trim2' }));
  await tick();
  assert.deepEqual(h2.calls.sells, [{ mint: MINT, pct: 40 }]);
});

test('LIVE: two different sells within seconds each read the leader balance for THEIR slot', async () => {
  // The holding cache was keyed by wallet + mint for 3 s, so the second rung
  // of a ladder was sized from the first rung's balance.
  let left = 500;
  const h = await openLiveCopy({ leaderHolding: () => left });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.5, priceSol: 0.002, tokens: 500, signature: 'rung1', slot: 10 }));
  await tick();
  left = 0;
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.5, priceSol: 0.002, tokens: 500, signature: 'rung2', slot: 11 }));
  await tick();
  assert.equal(h.calls.holdingReads.length, 2, 'one read per sell');
  assert.deepEqual(h.calls.sells.map((s) => s.pct), [50, 100], 'the second rung is the whole remainder');
});

test('the max-hold backstop fires on the clock for a coin that stopped printing', async () => {
  // checkOwnExits ran only from a price tick, so the dead bag a missed
  // leader sell leaves behind never reached its max hold (10-23).
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 0.1, maxTradeSol: 0.1, delayMs: 0, exitMaxHoldMin: 30 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buyDead' }));
  await tick();
  const open = () => copy.snapshot().recent.find((t) => t.kind !== 'exit' && t.state !== 'skipped');
  assert.equal(open().state, 'open');
  copy.checkMaxHolds(Date.now() + 29 * 60_000);
  await tick();
  assert.equal(open().state, 'open', 'not before its time');
  copy.checkMaxHolds(Date.now() + 31 * 60_000);
  await tick();
  await tick();
  assert.equal(open().state, 'closed', 'closed by the backstop with no price tick at all');
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(/max hold 30 min/.test(exit.note ?? exit.reason ?? ''), JSON.stringify(exit));
  // A config with no max hold is never touched by the clock pass.
  setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 0.1, maxTradeSol: 0.1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buyKeep' }));
  await tick();
  copy.checkMaxHolds(Date.now() + 24 * 60 * 60_000);
  await tick();
  assert.equal(open().state, 'open');
  void h;
});

test('LIVE: a second sell mirrors the share of what is LEFT, and the last one closes the copy', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sell1' }));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1.2, priceSol: 0.002, soldFraction: 1, signature: 'sell2' }));
  await tick();
  await tick();
  assert.deepEqual(h.calls.sells.map((s) => s.pct), [40, 100], 'they sold the rest, so we sell all of what is left');
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exits = snap.recent.filter((t) => t.kind === 'exit');
  assert.equal(parent.state, 'closed');
  assert.equal(parent.remainingPct, 0);
  assert.equal(exits.length, 2);
  assert.ok(exits.every((e) => e.pnlSol === null && e.pnlBasis === 'pending'), 'no fill read, no result');
  const sliced = exits.reduce((a, e) => a + e.shareOfCopy, 0);
  assert.ok(Math.abs(sliced - 1) < 1e-9, `the two slices are the whole copy: ${sliced}`);
});

test('LIVE: the record is priced from OUR fills — the buy’s real cost and the sell’s real proceeds', async () => {
  // The chain says: the buy cost 1.01 SOL all-in (fees, tip, rent) for 1,000
  // tokens; the 40 % sell put 0.75 SOL in the wallet. The leader's prices
  // (0.001 in, 0.002 out) are not our fills and must not be booked as ours.
  const reads = new Map([
    ['sig', { raw: '1000000000', decimals: 6, sol: -1.01, slot: 103 }],
    ['sellsig', { raw: '400000000', decimals: 6, sol: 0.75, slot: 140 }],
  ]);
  const h = setup({ priceSol: 0.001, host: { fillTokens: async (s) => reads.get(s) ?? null } });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buy1', delivery: { feed: 'logs', detectMs: 300, readMs: 100, readTries: 1, decodeMs: 1, detectedAt: Date.now(), slot: 100 } }));
  await tick();
  let parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.entryBasis, 'fill');
  assert.ok(Math.abs(parent.ourSol - 1.01) < 1e-9, 'cost is the lamport delta, not the 1 SOL we asked for');
  assert.ok(Math.abs(parent.entryPriceSol - 0.00101) < 1e-12, 'entry is all-in cost per token');
  assert.equal(parent.timing.slotGap, 3, 'landed three slots after the leader');
  assert.equal(copy.latency().slotGap, 3);

  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sell1' }));
  await tick();
  const snap = copy.snapshot();
  parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(exit.pnlBasis, 'fill');
  assert.ok(Math.abs(exit.ourSol - 0.404) < 1e-9, '40 % of the real cost');
  assert.ok(Math.abs(exit.proceedsSol - 0.75) < 1e-9);
  assert.ok(Math.abs(exit.pnlSol - 0.346) < 1e-9, `0.75 back for 0.404 in: ${exit.pnlSol}`);
  assert.ok(Math.abs(exit.exitPriceSol - 0.001875) < 1e-12, 'our exit price is our proceeds per token');
  assert.ok(Math.abs(parent.realizedSol - 0.346) < 1e-9);
  assert.ok(Math.abs(snap.stats[snap.configs[0].id].realizedPnlSol - 0.346) < 1e-9);
  assert.equal(snap.stats[snap.configs[0].id].unpriced, 0);
});

test('LIVE: a leader who sells before our buy’s fill is read gets an exit sized from our own fill', async () => {
  // The common case with a fast leader: they sell while the ledger is still
  // reading our buy. The exit waits for that read (2026-10-28) — sized
  // without it, it sold a share of the whole token account — then sells
  // half of the copy's own 1,000 tokens and is priced from its own fill.
  let releaseBuy;
  const buyRead = new Promise((r) => (releaseBuy = r));
  setup({
    priceSol: 0.001,
    host: {
      fillTokens: async (s) => (s === 'sig' ? buyRead : s === 'sellsig' ? { raw: '500000000', decimals: 6, sol: 0.6 } : null),
    },
  });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buy1' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.5, signature: 'sell1' }));
  await tick();
  let exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit, undefined, 'the exit waits for the buy’s fill read instead of selling a share of the account');
  releaseBuy({ raw: '1000000000', decimals: 6, sol: -1.02 });
  await tick();
  await tick();
  exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(exit.pnlBasis, 'fill');
  assert.ok(Math.abs(exit.ourSol - 0.51) < 1e-9, 'half of the real 1.02');
  assert.ok(Math.abs(exit.proceedsSol - 0.6) < 1e-9, 'all 500 sold tokens were the copy’s here');
  assert.ok(Math.abs(exit.pnlSol - 0.09) < 1e-9, `priced from the fills: ${exit.pnlSol}`);
  assert.ok(Math.abs(parent.realizedSol - 0.09) < 1e-9);
});

test('LIVE: an exit before the buy’s fill is read sells only the copy’s own tokens, not a hand-bought bag', async () => {
  // The account holds the copy's 1,000 tokens and 1,000 bought by hand. The
  // leader sells half before our buy's fill is read. Sized as a share of the
  // ACCOUNT it would have sold 1,000 — half of it the hand-bought bag. It
  // waits for the read and asks for exactly the copy's 500.
  let releaseBuy;
  const buyRead = new Promise((r) => (releaseBuy = r));
  const h = setup({
    priceSol: 0.001,
    host: { fillTokens: async (s) => (s === 'sig' ? buyRead : s === 'sellsig' ? { raw: '500000000', decimals: 6, sol: 0.4 } : null) },
  });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buy1' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.5, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'nothing sold while the copy’s own quantity is unknown');
  releaseBuy({ raw: '1000000000', decimals: 6, sol: -1 });
  await tick();
  await tick();
  assert.equal(h.calls.sells.length, 1);
  assert.equal(h.calls.sellOpts[0].tokensRaw, '500000000', 'exactly the copy’s half, in base units');
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit.pnlBasis, 'fill');
  assert.ok(Math.abs(exit.proceedsSol - 0.4) < 1e-9, `0.4 for the copy’s 500: ${exit.proceedsSol}`);
});

test('paper and live are scored apart, and a paper loss does not stop a live day', async () => {
  setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, dailyLossLimitSol: 0.5 });
  // A paper round trip that loses 0.77 SOL — past the 0.5 limit.
  copy.onWalletTrade(trade({ isBuy: true, signature: 'pb' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.00025, soldFraction: 1, signature: 'ps' }));
  await tick();
  const id = copy.all()[0].id;
  assert.ok(copy.snapshot().stats[id].realizedPnlSol < -0.5);
  // Flip to live and arm it: the live record starts at nothing.
  copy.upsert({ ...copy.all()[0], mode: 'live' });
  copy.upsert({ ...copy.all()[0], enabled: true });
  const st = copy.snapshot().stats[id];
  assert.equal(st.mode, 'live');
  assert.equal(st.trades, 0, 'the paper copy is not a live trade');
  assert.equal(st.realizedPnlSol, 0, 'and the paper loss is not a live one');
  copy.onWalletTrade(trade({ isBuy: true, signature: 'lb' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.mode === 'live' && t.state === 'open').length, 1, 'the paper loss did not hold the live day');
});

test('LIVE: a sell that fails leaves the copy open and records why — never a phantom fill', async () => {
  const h = await openLiveCopy({ sellResult: { ok: false, message: 'Simulation reverted: Overflow (6024)' } });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 0.5, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(parent.state, 'open');
  assert.equal(parent.remainingPct ?? 100, 100, 'nothing was sold, nothing is closed');
  assert.equal(exit.state, 'skipped');
  assert.match(exit.reason, /Overflow/);
  assert.ok(h.calls.toasts.some((t) => t.level === 'error' && /Copy sell failed/.test(t.message)));
});

test('LIVE: a sell while live is blocked is recorded as not executed, and does not call the host', async () => {
  const h = await openLiveCopy();
  h.host.liveBlockedReason = () => 'the engine is not armed';
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0);
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.match(snap.recent.find((t) => t.kind === 'exit').reason, /not executed — the engine is not armed/);
});

test('LIVE: when our own orders already emptied the bag, the copy closes with that said, not a fill', async () => {
  const h = await openLiveCopy({ sellResult: { ok: false, message: 'nothing to sell (zero token balance)' } });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'sell1' }));
  await tick();
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'closed');
  assert.equal(parent.pnlSol, null, 'we do not know what our own exit made — the ledger does');
  assert.match(parent.reason, /nothing left to sell/);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0);
});

test('LIVE: an unrecoverable fraction is NOT mirrored — a trim must never become a dump', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0);
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.match(snap.recent.find((t) => t.kind === 'exit').reason, /could not be read/);
  // And the user is TOLD they still hold it — this is the case where doing
  // nothing leaves them fully exposed, so it must not be a quiet warning.
  const said = h.calls.toasts.at(-1);
  assert.equal(said.level, 'error');
  assert.match(said.message, /still hold it|sell by hand/i);
});

// ── Recovering a sell size the transaction did not carry ──────────────
//
// The user-facing bug (2026-09-13): "when someone sells and they can't tell
// how much it is, it just doesn't sell". `soldFraction` is decoded from the
// transaction's pre-balances, which carry an `owner` only on newer RPC
// replies; without it the fraction is null and the mirror gave up. Their
// holding AFTER the sell plus the tokens it moved is what they held before,
// so one balance read recovers the exact fraction.

test('an unreadable sell size is RECOVERED from the leader’s balance', async () => {
  // They sold 600 and have 400 left → they sold 60 % of their bag.
  const h = await openLiveCopy({ leaderHolding: 400 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, tokens: 600, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1, 'the sell is mirrored, not skipped');
  assert.equal(h.calls.sells[0].pct, 60);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').remainingPct, 40);
});

test('a leader who fully exits is mirrored as a FULL exit', async () => {
  // Nothing left: the case that matters most, and the one that used to sell
  // nothing at all.
  const h = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, tokens: 1000, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  assert.equal(h.calls.sells[0].pct, 100);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('recovery needs the token count — without it nothing is guessed', async () => {
  const h = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'no count, no read, no mirror');
  assert.equal(h.calls.holdingReads.length, 0, 'and no request spent on it');
});

test('an unreadable balance leaves the sell unmirrored — never a guessed dump', async () => {
  const h = await openLiveCopy({ leaderHolding: null });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, tokens: 600, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.holdingReads.length, 1, 'it tried');
  assert.equal(h.calls.sells.length, 0, 'and refused to invent a size');
});

test('a fraction the transaction DID carry is used as-is, with no balance read', async () => {
  const h = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 0.25, tokens: 250, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells[0].pct, 25);
  assert.equal(h.calls.holdingReads.length, 0, 'the cheap path stays cheap');
});

test('PAPER: a partial sell is bookkeeping only — same slices, no order', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.5, priceSol: 0.002, soldFraction: 0.25, signature: 's' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'paper never sells');
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(parent.state, 'open');
  assert.equal(parent.remainingPct, 75);
  assert.equal(exit.soldPct, 25);
  assert.equal(exit.signature, null);
});

test('exits do not spend the daily copy limit, but their losses count toward the daily loss limit', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, dailyTradeLimit: 2, dailyLossLimitSol: 0.5 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  // They scale out in three sells at a quarter of entry — three exits, one copy.
  for (const [i, f] of [0.3, 0.5, 1].entries()) {
    copy.onWalletTrade(trade({ isBuy: false, sol: 0.1, priceSol: 0.00025, soldFraction: f, signature: `s${i}` }));
    await tick();
  }
  assert.equal(h.calls.sells.length, 3);
  const stats = copy.snapshot().stats[copy.snapshot().configs[0].id];
  assert.equal(stats.trades, 1, 'three exits are still one trade');
  // This host reads no fills, so the live exits have no result yet — but an
  // unread fill must not hold a losing day open: the limit counts them at
  // the model's estimate.
  assert.equal(stats.unpriced, 3);
  const est = copy.snapshot().recent.filter((t) => t.kind === 'exit').reduce((a, t) => a + t.estPnlSol, 0);
  assert.ok(est < -0.5, `the round trip lost about ${est}`);
  // Second copy: the count limit (2) is not hit by the exits, the LOSS limit is.
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b2' }));
  await tick();
  assert.equal(h.calls.buys.length, 1, 'no second buy');
  assert.match(copy.snapshot().recent[0].reason, /limit: down/);
});

test('copySells off leaves the position open when they sell', async () => {
  setup();
  save({ copySells: false, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.002 }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

// ── Stats ─────────────────────────────────────────────────────────────

test('win rate is null until something closes', () => {
  assert.equal(winRate({ wins: 0, losses: 0 }), null);
  assert.equal(winRate({ wins: 3, losses: 1 }), 75);
});

test('activeWallets lists only enabled configs', () => {
  setup();
  save({ enabled: true });
  save({ wallet: 'Other111111111111111111111111111111111111', enabled: false });
  const active = copy.activeWallets();
  assert.equal(active.has(WALLET), true);
  assert.equal(active.size, 1);
});

test('following the same wallet twice is refused', () => {
  setup();
  assert.equal(save().ok, true);
  assert.equal(save().ok, false);
});

test('a copy config carries the wallet it signs with, and refuses a wallet that is not one', () => {
  // A config names the wallet it signs with (2026-09-11), or leaves it on
  // the active one. A blank or a non-string is refused — a wallet id that
  // is not a wallet is not "the active wallet by accident".
  assert.equal(validateConfig(cfg({})).ok, true, 'absent means the active wallet');
  assert.equal(validateConfig(cfg({ walletId: null })).ok, true, 'null means the active wallet');
  assert.equal(validateConfig(cfg({ walletId: 'w_abc' })).ok, true, 'a wallet id is accepted here; main checks it is ours');
  assert.equal(validateConfig(cfg({ walletId: '' })).ok, false, 'a blank is not a wallet');
  assert.equal(validateConfig(cfg({ walletId: 42 })).ok, false, 'nor is a number');
  assert.equal(defaultConfig('', '').walletId, null, 'a new config starts on the active wallet');
});

// ── Every chain (2026-09-11) ────────────────────────────────────────────
//
// A config lives on a chain. Robinhood Chain and BNB leaders arrive from the
// Observatory's trade feed with `chain` set and 0x addresses; the engine's
// math is the same, the units are that chain's coin, and the host is told
// which chain every buy, sell, price and fact is for.

const EVM_LEADER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const EVM_MINT = '0x9C4C60cEEa0000000000000000000000000000AA';

test('a config on an EVM chain wants a 0x address; a Solana one wants base58', () => {
  assert.equal(validateConfig(cfg({ chain: 'robinhood', wallet: EVM_LEADER })).ok, true);
  assert.equal(validateConfig(cfg({ chain: 'bnb', wallet: EVM_LEADER })).ok, true);
  assert.equal(validateConfig(cfg({ chain: 'robinhood', wallet: WALLET })).ok, false, 'a Solana address is not a Robinhood one');
  assert.equal(validateConfig(cfg({ chain: 'solana', wallet: EVM_LEADER })).ok, false, 'nor the other way');
  assert.equal(validateConfig(cfg({ wallet: WALLET })).ok, true, 'no chain means Solana, as every saved config did');
  assert.equal(defaultConfig('', '', 'bnb').chain, 'bnb');
  assert.equal(defaultConfig('', '').chain, 'solana');
});

test('an EVM leader is matched by chain and case-insensitively, and the host is told the chain', async () => {
  const h = setup();
  // The address is stored lower-cased; the helper re-finds it by that.
  save({ chain: 'robinhood', wallet: EVM_LEADER.toLowerCase(), mode: 'live' });
  // The same address string on BNB is a different leader: nothing fires.
  copy.onWalletTrade(trade({ chain: 'bnb', wallet: EVM_LEADER.toLowerCase(), mint: EVM_MINT, sol: 0.5, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.calls.buys.length, 0, 'a BNB trade does not fire a Robinhood config');
  // On the right chain, in any case, it does — and the buy is told the chain.
  copy.onWalletTrade(trade({ chain: 'robinhood', wallet: EVM_LEADER.toUpperCase().replace('0X', '0x'), mint: EVM_MINT, sol: 0.5, priceSol: 0.001, signature: '0xaa' }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.calls.buys.length, 1, 'a Robinhood trade fires it');
  assert.equal(h.calls.buys[0].mint, EVM_MINT.toLowerCase(), 'the mint is lower-cased on entry');
  assert.equal(h.calls.buyOpts[0].chain, 'robinhood', 'the host knows which rail to buy on');
  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.ok(open, 'the copy is recorded');
  assert.equal(open.chain, 'robinhood', 'and remembers its chain');
});

test('a mark-to-market for one chain leaves the same mint on another alone', () => {
  const h = setup();
  copy._load(
    [{ ...cfg({ id: 'r', chain: 'robinhood', wallet: EVM_LEADER.toLowerCase(), mode: 'paper' }), id: 'r', createdAt: 1 }],
    [
      { id: 'a', configId: 'r', mode: 'paper', chain: 'robinhood', wallet: EVM_LEADER.toLowerCase(), mint: EVM_MINT.toLowerCase(), symbol: 'X', at: 1, theirSol: 1, ourSol: 0.1, entryPriceSol: 0.001, exitPriceSol: null, closedAt: null, pnlSol: null, state: 'open', reason: null },
      { id: 'b', configId: 'r', mode: 'paper', chain: 'bnb', wallet: EVM_LEADER.toLowerCase(), mint: EVM_MINT.toLowerCase(), symbol: 'X', at: 1, theirSol: 1, ourSol: 0.1, entryPriceSol: 0.001, exitPriceSol: null, closedAt: null, pnlSol: null, state: 'open', reason: null },
    ],
  );
  copy.markToMarket(EVM_MINT.toLowerCase(), 0.002, 'robinhood');
  const rows = copy.snapshot().recent;
  assert.equal(rows.find((t) => t.id === 'a').exitPriceSol, 0.002, 'the Robinhood copy is marked');
  assert.equal(rows.find((t) => t.id === 'b').exitPriceSol, null, 'the BNB copy of the same address is not');
  assert.deepEqual(copy.openMints('bnb'), [EVM_MINT.toLowerCase()]);
  assert.deepEqual([...copy.activeWallets('bnb')], [], 'no BNB config is enabled');
  void h;
});

// ── A copy is settled in TOKENS, not in what it cost (2026-09-15) ─────
//
// The reported bug, in the reporter's words: "undersized sells followed by
// incorrect 'closed' bookkeeping, not simply failed transactions". A NON
// copy's final exit was recorded as 100 %, the live request sold 52 % of the
// remaining tokens, the transaction succeeded, 83,236 NON were left behind,
// and the app marked the copy fully closed — inventory outside every
// open-position view it has.
//
// Two separate faults, pinned separately below: the sell was SIZED from a
// cost-basis ratio rather than from the tokens the copy holds, and the book
// was moved by the LEADER's fraction rather than by what actually left the
// wallet.

test('a mirrored sell is sized from the copy TOKENS, not from what the bag cost', async () => {
  // We hold 3× the copy: 2e9 base units bought by hand plus the copy's 1e9.
  // Their full exit is 1e9 of a 3e9 balance — 33.34 %. The cost-basis path
  // would have said 20 % (1 SOL of a 5 SOL basis), and 20 % of the balance
  // is 0.6e9: 40 % of the copy left behind, under a "sold 100 %" record.
  const h = await openLiveCopy({ chain: { balance: 2_000_000_000n, bought: 1_000_000_000n }, ourCostBasisSol: 5 });
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 2, priceSol: 0.002, soldFraction: 1, signature: 'x1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  assert.equal(h.calls.sells[0].pct, 33.34, `the token share, not the cost share: ${h.calls.sells[0].pct}`);
  assert.equal(h.calls.sellOpts[0].tokensRaw, '1000000000', 'and the quantity itself reaches the host');
  assert.equal(h.calls.chain.balance, 2_000_000_000n, 'the hand-bought bag is untouched');
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'closed', 'the copy is out, so it closes');
  assert.equal(parent.tokensLeftRaw, '0');
});

test('a full exit that only half-fills leaves the copy OPEN for the remainder — the NON bug', async () => {
  // Every sell moves 52 % of what it was asked for and reports success,
  // which is exactly what the reported transaction did.
  const h = await openLiveCopy({ chain: { bought: 160_000_000_000n }, fillShare: 0.52 });
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 2, priceSol: 0.002, soldFraction: 1, signature: 'x2' }));
  await tick();

  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'open', 'the tokens are still here, so the copy is NOT closed');
  assert.equal(parent.closedAt, null);
  assert.match(parent.reason, /still held/);

  // One top-up attempt for the measured remainder, then it stops and says so
  // rather than looping against a token it cannot fully sell.
  assert.equal(h.calls.sells.length, 2, `one mirror and one top-up: ${h.calls.sells.length}`);
  assert.equal(h.calls.sellOpts[0].tokensRaw, '160000000000');
  assert.equal(h.calls.sellOpts[1].tokensRaw, '76800000000', 'the top-up asks for what was measured, not a percentage');
  assert.equal(parent.tokensLeftRaw, '36864000000');
  assert.equal(h.calls.chain.balance, 36_864_000_000n, 'and the book agrees with the wallet');

  const exits = snap.recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 2, 'one slice per sell that landed');
  const first = exits[exits.length - 1];
  assert.equal(first.soldPct, 52, 'the slice records what WE sold');
  assert.equal(first.leaderPct, 100, 'and what they sold, because the two differ');
  assert.equal(first.soldRaw, '83200000000');
  assert.equal(first.wantedRaw, '160000000000', 'the gap is on the record, not hidden');
  assert.ok(
    h.calls.toasts.some((t) => t.level === 'warn' && /still in your wallet/.test(t.message)),
    `the shortfall is said out loud: ${JSON.stringify(h.calls.toasts.map((t) => t.message))}`,
  );
});

test('a full exit that fills completely closes the copy, once', async () => {
  const h = await openLiveCopy({ chain: { bought: 160_000_000_000n } });
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 2, priceSol: 0.002, soldFraction: 1, signature: 'x3' }));
  await tick();
  assert.equal(h.calls.sells.length, 1, 'nothing to top up');
  assert.deepEqual(h.calls.sells[0], { mint: MINT, pct: 100 });
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'closed');
  assert.equal(parent.remainingPct, 0);
  assert.equal(parent.tokensLeftRaw, '0');
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit.soldPct, 100);
  assert.equal(exit.leaderPct, undefined, 'they match, so there is nothing extra to say');
});

test('a PARTIAL exit that comes back short is never topped up — that would trade past them', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n }, fillShare: 0.5 });
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'x4' }));
  await tick();
  assert.equal(h.calls.sells.length, 1, 'they trimmed 40 %; there is no remainder to chase');
  assert.equal(h.calls.sellOpts[0].tokensRaw, '400000000');
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'open');
  assert.equal(parent.tokensLeftRaw, '800000000', 'only what actually left is booked');
  assert.equal(parent.remainingPct, 80);
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit.soldPct, 20, 'ours');
  assert.equal(exit.leaderPct, 40, 'theirs');
});

test('a dust remainder still closes the copy — the chain rarely leaves a balance exactly empty', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n }, fillShare: 0.999 });
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 2, priceSol: 0.002, soldFraction: 1, signature: 'x5' }));
  await tick();
  assert.equal(h.calls.sells.length, 1, 'a tenth of a percent is not worth a second transaction');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('a copy with NO tracked quantity keeps the old percentage path exactly', async () => {
  // A row opened before quantities existed, or a rail whose host cannot read
  // a balance. Unknown is never read as zero and never as "all of it".
  const h = await openLiveCopy({ ourCostBasisSol: 5 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'x6' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 8 }], '40 % of our fifth of the bag, as before');
  assert.equal(h.calls.sellOpts[0].tokensRaw, undefined, 'and no quantity is invented');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').remainingPct, 60);
});

// ── The balance sweep (Rob's fourth ask) ──────────────────────────────
//
// "Recheck balances periodically and flag/reconcile leftovers even when the
// ledger says closed." `reconcileHoldings` above answers "are these tokens
// gone?"; this answers the question that caught nobody.

const closedRowWithLeftover = (configId, over = {}) => ({
  id: 'ct-non',
  configId,
  mode: 'live',
  wallet: WALLET,
  mint: MINT,
  symbol: 'NON',
  at: Date.now() - 600_000,
  theirSol: 1,
  ourSol: 1,
  entryPriceSol: 0.001,
  exitPriceSol: 0.002,
  closedAt: Date.now() - 300_000,
  pnlSol: 0.1,
  state: 'closed',
  reason: null,
  remainingPct: 0,
  tokensRaw: '160000000000',
  tokensLeftRaw: '83236000000',
  tokenDecimals: 6,
  ...over,
});

test('a copy marked closed while its tokens are still held is FLAGGED, and said once', async () => {
  const h = setup();
  save({ mode: 'live' });
  const c = copy.all()[0];
  copy._load([c], [closedRowWithLeftover(c.id)]);
  const held = () => new Map([[MINT, { raw: '83236000000', decimals: 6 }]]);

  const r = copy.reconcileQuantities(held(), { configIds: new Set([c.id]) });
  assert.equal(r.flagged, 1);
  const row = copy.snapshot().recent[0];
  assert.equal(row.leftoverRaw, '83236000000');
  assert.match(row.reason, /marked closed/);
  assert.match(row.reason, /83,236/, 'in tokens, not base units — a human reads this');
  assert.ok(h.calls.toasts.some((t) => t.level === 'warn' && /still in your wallet/.test(t.message)));
  assert.equal(h.calls.sells.length, 0, 'a sweep never trades');

  const said = h.calls.toasts.length;
  copy.reconcileQuantities(held(), { configIds: new Set([c.id]) });
  assert.equal(h.calls.toasts.length, said, 'the holdings poll runs every couple of seconds — say it once');
});

test('the flag clears when the leftovers finally leave the wallet', async () => {
  setup();
  save({ mode: 'live' });
  const c = copy.all()[0];
  copy._load([c], [closedRowWithLeftover(c.id, { leftoverRaw: '83236000000' })]);
  const r = copy.reconcileQuantities(new Map(), { configIds: new Set([c.id]) });
  assert.equal(r.cleared, 1);
  const row = copy.snapshot().recent[0];
  assert.equal(row.leftoverRaw, null);
  assert.equal(row.tokensLeftRaw, '0');
});

test('the sweep scales a book that claims more tokens than the wallet holds', async () => {
  // Two copies of one mint, and a hand sell took most of it. Each row
  // thinking it still owns its own tokens is how one balance gets counted
  // twice; the chain is the ceiling.
  setup();
  save({ mode: 'live' });
  const c = copy.all()[0];
  copy._load([c], [
    closedRowWithLeftover(c.id, { id: 'a', state: 'open', remainingPct: 100, tokensRaw: '100', tokensLeftRaw: '100' }),
    closedRowWithLeftover(c.id, { id: 'b', state: 'open', remainingPct: 100, tokensRaw: '100', tokensLeftRaw: '100' }),
  ]);
  copy.reconcileQuantities(new Map([[MINT, { raw: '50', decimals: 6 }]]), { configIds: new Set([c.id]) });
  const rows = copy.snapshot().recent;
  assert.equal(rows.find((x) => x.id === 'a').tokensLeftRaw, '25');
  assert.equal(rows.find((x) => x.id === 'b').tokensLeftRaw, '25');
});

test('a sweep scoped to other configs, or run inside the grace window, leaves a row alone', async () => {
  const h = setup();
  save({ mode: 'live' });
  const c = copy.all()[0];
  copy._load([c], [closedRowWithLeftover(c.id)]);
  const held = new Map([[MINT, { raw: '83236000000', decimals: 6 }]]);
  assert.equal(copy.reconcileQuantities(held, { configIds: new Set(['someone-else']) }).flagged, 0);
  // A sell that has just confirmed is not in the next holdings read yet.
  copy._load([c], [closedRowWithLeftover(c.id, { closedAt: Date.now() })]);
  assert.equal(copy.reconcileQuantities(held, { configIds: new Set([c.id]) }).flagged, 0);
  // The only toast here is the one arming the config; nothing was flagged.
  assert.equal(h.calls.toasts.filter((t) => /still in your wallet/.test(t.message)).length, 0);
});

// ── Legacy rows recover their quantity from the ledger ────────────────
//
// A copy opened before 2026-09-15 carries no base units, so it exits through
// the old cost-ratio percentage and can be closed over tokens that never
// left. The quantity is not lost: the copy's buy is a fill in the ledger,
// and the ledger reconciled that transaction's own token delta at the time.

test('an open copy with no tracked quantity recovers it from the ledger', async () => {
  const h = await openLiveCopy({ buyFill: { raw: '160000000000', decimals: 6 } });
  // Simulate the pre-2026-09-15 shape: the row exists, the quantity does not.
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  copy._load(copy.all(), [{ ...row, tokensRaw: undefined, tokensLeftRaw: undefined, tokenDecimals: undefined, signature: null }]);

  assert.equal(await copy.backfillQuantities(), 1);
  const after = copy.snapshot().recent[0];
  assert.equal(after.tokensRaw, '160000000000');
  assert.equal(after.tokensLeftRaw, '160000000000');
  assert.equal(after.tokenDecimals, 6);
  assert.deepEqual(h.calls.buyFills, [{ mint: MINT, atMs: row.at }]);
});

test('a partly sold legacy row recovers the remainder, not the whole buy', async () => {
  const h = await openLiveCopy({ buyFill: { raw: '1000000000', decimals: 6 } });
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  // 40 % already went out on the old percentage path.
  copy._load(copy.all(), [{ ...row, remainingPct: 60, tokensRaw: undefined, tokensLeftRaw: undefined, signature: null }]);
  await copy.backfillQuantities();
  const after = copy.snapshot().recent[0];
  assert.equal(after.tokensRaw, '1000000000', 'what the buy delivered');
  assert.equal(after.tokensLeftRaw, '600000000', 'what is left of it');
  assert.equal(h.calls.buyFills.length, 1);
});

test('a ledger that cannot name the buy leaves the row unknown, and is not asked twice', async () => {
  const h = await openLiveCopy({ buyFill: null });
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  copy._load(copy.all(), [{ ...row, tokensRaw: undefined, tokensLeftRaw: undefined, signature: null }]);
  assert.equal(await copy.backfillQuantities(), 0);
  assert.equal(copy.snapshot().recent[0].tokensRaw, undefined, 'unknown, never guessed');
  assert.equal(await copy.backfillQuantities(), 0);
  assert.equal(h.calls.buyFills.length, 1, 'a row with no answer is not re-scanned every sweep');
});

test('a row that kept its buy signature is settled from the fill, never from a ledger scan', async () => {
  const h = await openLiveCopy({ chain: { bought: 500n }, buyFill: { raw: '999', decimals: 6 } });
  await tick();
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  copy._load(copy.all(), [{ ...row, tokensRaw: undefined, tokensLeftRaw: undefined }]);
  await copy.backfillQuantities();
  assert.equal(copy.snapshot().recent[0].tokensRaw, '500', 'the fill its own signature names');
  assert.equal(h.calls.buyFills.length, 0, 'no time-window match was needed');
});

// ── The periodic balance sweep ────────────────────────────────────────
//
// The Solana path gets a comparison free off `readHoldings`. The EVM rails
// have no such read, and a copy signed by a wallet that is not the active
// one is not described by the active wallet's holdings either.

test('the periodic sweep reads the balances the book has an opinion about, and nothing else', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n } });
  await tick();
  const r = await copy.sweepBalances({ now: Date.now() + 120_000 });
  assert.equal(r.read, 1, 'one read, for the one mint a live copy is open on');
  assert.deepEqual(h.calls.tokenReads, [MINT]);

  // A copy with no tracked quantity has nothing to compare, so nothing is read.
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  copy._load(copy.all(), [{ ...row, tokensRaw: undefined, tokensLeftRaw: undefined }]);
  h.calls.tokenReads.length = 0;
  assert.equal((await copy.sweepBalances({ now: Date.now() + 120_000 })).read, 0);
  assert.deepEqual(h.calls.tokenReads, []);
});

test('the sweep flags a leftover on a chain that has no holdings read', async () => {
  const h = await openLiveCopy({ chain: { bought: 160_000_000_000n }, fillShare: 0.52 });
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 2, priceSol: 0.002, soldFraction: 1, signature: 'lo' }));
  await tick();
  // Force the row closed the way the OLD book would have, leaving the
  // remainder stranded — this is the state a user is in today.
  const rows = copy.snapshot().recent;
  const parent = rows.find((t) => t.kind !== 'exit');
  copy._load(copy.all(), [
    { ...parent, state: 'closed', closedAt: Date.now() - 300_000, remainingPct: 0, at: Date.now() - 600_000 },
    ...rows.filter((t) => t.kind === 'exit'),
  ]);

  const r = await copy.sweepBalances();
  assert.equal(r.flagged, 1, 'the wallet still holds tokens this copy called done');
  const after = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.ok(after.leftoverRaw && BigInt(after.leftoverRaw) > 0n);
  assert.match(after.reason, /marked closed/);
});

test('the sweep closes an open copy the wallet holds none of — the EVM rails have no other path to it', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n } });
  await tick();
  h.calls.chain.balance = 0n; // sold by hand, or by a stop-loss
  await copy.sweepBalances({ now: Date.now() + 120_000 });
  const after = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(after.state, 'closed');
  assert.equal(after.tokensLeftRaw, '0');
  assert.match(after.reason, /no longer in the wallet/);
  assert.equal(h.calls.sells.length, 0, 'a sweep never trades');
});

test('a balance the host cannot read changes nothing — unreadable is not empty', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n }, unreadableBalance: true });
  await tick();
  const before = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  const r = await copy.sweepBalances({ now: Date.now() + 120_000 });
  assert.equal(r.read, 0);
  const after = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(after.state, 'open');
  assert.equal(after.tokensLeftRaw, before.tokensLeftRaw);
});

test('a row that moved a moment ago is left alone — the chain has not caught up', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n } });
  await tick();
  h.calls.chain.balance = 0n;
  assert.equal((await copy.sweepBalances()).read, 0, 'inside the grace window there is nothing to ask about');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
});

test('the sweep is bounded, and takes the least recently swept mints first', async () => {
  const h = setup({ priceSol: 0.001, chain: { bought: 1_000n } });
  // 0.05: a live copy under MIN_LIVE_COPY_SOL (0.03) is refused on save since 2026-10-22.
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 1, delayMs: 0, dailyTradeLimit: 500, maxCopiesPerMinute: 120 });
  const mints = [];
  for (let i = 0; i < 5; i++) {
    const mint = `Sweep${i}${'1'.repeat(35)}`;
    mints.push(mint);
    copy.onWalletTrade(trade({ mint, isBuy: true, signature: `sw${i}` }));
    await tick();
  }
  const now = Date.now() + 120_000;
  h.calls.tokenReads.length = 0;
  assert.equal((await copy.sweepBalances({ max: 2, now })).read, 2);
  assert.equal(h.calls.tokenReads.length, 2);
  const first = [...h.calls.tokenReads];
  assert.equal((await copy.sweepBalances({ max: 2, now })).read, 2);
  const second = h.calls.tokenReads.slice(2);
  assert.ok(
    second.every((m) => !first.includes(m)),
    `the next pass moves on: ${JSON.stringify({ first, second })}`,
  );
});

test('a size the chain has moved under is re-planned once, not recorded as a failed exit', async () => {
  const h = await openLiveCopy({ chain: { bought: 1_000_000_000n } });
  await tick();
  // A hand sell takes half the bag between the plan's read and the send.
  const real = h.host.walletTokens;
  let first = true;
  h.host.walletTokens = async (mint) => {
    const r = await real(mint);
    if (first) {
      first = false;
      h.calls.chain.balance = 500_000_000n;
    }
    return r;
  };
  copy.onWalletTrade(trade({ isBuy: false, sol: 2, priceSol: 0.002, soldFraction: 1, signature: 'stale' }));
  await tick();
  assert.equal(h.calls.sells.length, 2, 'the first size was stale; the second is planned from a fresh read');
  assert.equal(h.calls.sellOpts[1].tokensRaw, '500000000');
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'closed', 'and the copy really is out');
  assert.equal(
    copy.snapshot().recent.filter((t) => t.kind === 'exit' && t.state === 'skipped').length,
    0,
    'a race is not a refusal — nothing is recorded as a failed exit',
  );
});

// ── How late is too late (2026-09-15) ─────────────────────────────────
//
// A leader trade now carries WHEN IT LANDED, not when we read it, so the
// copier can finally tell a fresh instruction from one that reached it after
// a socket gap. Without that, a sell recovered forty minutes later went out
// as if it were new, and a buy from half an hour ago opened a position at a
// price that had nothing to do with the trade being copied.

test('a leader sell that only reaches us after the window is RECORDED, not mirrored', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(
    trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 1, signature: 'old1', tradeAt: Date.now() - 40 * 60_000 }),
  );
  await tick();
  assert.equal(h.calls.sells.length, 0, 'nothing is sold on an instruction that old');
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit.state, 'skipped');
  assert.match(exit.reason, /40 minutes ago/);
  assert.match(exit.reason, /You still hold it/);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open', 'and the position stays open');
  assert.ok(h.calls.toasts.some((x) => x.level === 'error' && /too late to mirror/.test(x.message)));
});

test('a sell inside the window is mirrored, and says how far behind it was', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(
    trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 1, signature: 'late1', tradeAt: Date.now() - 4 * 60_000 }),
  );
  await tick();
  assert.equal(h.calls.sells.length, 1, 'four minutes late is still worth getting out on');
  assert.ok(
    h.calls.toasts.some((x) => x.level === 'success' && /after they did/.test(x.message)),
    `the lateness is said, not hidden: ${JSON.stringify(h.calls.toasts.map((t) => t.message))}`,
  );
});

test('a sell that is barely late says nothing extra', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 1, signature: 'quick', tradeAt: Date.now() - 3_000 }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  assert.ok(h.calls.toasts.some((x) => x.level === 'success' && !/after they did/.test(x.message)));
});

test('a leader BUY that is already minutes old is refused', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'oldbuy', tradeAt: Date.now() - 5 * 60_000 }));
  await tick();
  assert.equal(h.calls.buys.length, 0, 'that is a different trade at a different price');
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped');
  assert.match(row.reason, /too old to copy/);
});

test('a configured delay is the user own choice to be late, not a reason to refuse them', async () => {
  // 45 s of delay plus a 30 s old trade is inside the limit; the same trade
  // under a config with no delay would be too.
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 45_000 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'delayed', tradeAt: Date.now() - 80_000 }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(copy.snapshot().recent.filter((x) => /too old to copy/.test(x.reason ?? '')).length, 0, '80 s is inside 60 s + the 45 s they asked for');
});

test('PAPER refuses a stale entry too, or the scorecard measures a strategy live would not run', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'paperold', tradeAt: Date.now() - 5 * 60_000 }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped');
  assert.match(row.reason, /too old to copy/);
});

test('a rail that cannot date a trade behaves exactly as it did before', async () => {
  // Unknown age is NOT "old" — an EVM leader feed with no block time must
  // keep copying, not stop.
  const h = await openLiveCopy();
  assert.equal(h.calls.buys.length, 1, 'the buy above carried no tradeAt and still went out');
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'undated' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
});

// ── An EVM leader is only seen through its chain's scanner ────────────
//
// Solana watches a wallet directly, one subscription each. Robinhood and BNB
// have no such thing: a followed wallet there is read out of that chain's
// SCANNER poll, which the user starts. An armed config on a stopped scanner
// watched nothing at all, and the panel rendered no line about it.

const EVM_WALLET = '0x1234567890abcdef1234567890abcdef12345678';

test('a config on an EVM chain reports the chain scanner as its watcher', async () => {
  setup({ leaderFeed: { running: true, lastPollAt: 1_700_000_000_000 } });
  copy.upsert({ ...defaultConfig(EVM_WALLET, 'BNB whale', 'bnb'), enabled: true });
  const w = copy.snapshot().watch[EVM_WALLET];
  assert.equal(w.state, 'watching');
  assert.equal(w.lastSeenAt, 1_700_000_000_000, 'the poll IS the watch');
});

test('a config on a chain whose scanner is stopped says so, instead of rendering nothing', async () => {
  setup({ leaderFeed: { running: false, lastPollAt: null } });
  copy.upsert({ ...defaultConfig(EVM_WALLET, 'BNB whale', 'bnb'), enabled: true });
  assert.equal(copy.snapshot().watch[EVM_WALLET].state, 'off');
});

test('a scanner that is running but has not polled yet reads as connecting', async () => {
  setup({ leaderFeed: { running: true, lastPollAt: null } });
  copy.upsert({ ...defaultConfig(EVM_WALLET, 'BNB whale', 'bnb'), enabled: true });
  assert.equal(copy.snapshot().watch[EVM_WALLET].state, 'connecting');
});

test('a host that cannot describe the feed leaves the status absent, never invents one', async () => {
  setup();
  copy.upsert({ ...defaultConfig(EVM_WALLET, 'BNB whale', 'bnb'), enabled: true });
  assert.equal(copy.snapshot().watch[EVM_WALLET], undefined);
});

test('activeChains names the chains whose leader feed has to be running', async () => {
  setup();
  copy.upsert({ ...defaultConfig(WALLET, 'Sharky'), enabled: true });
  copy.upsert({ ...defaultConfig(EVM_WALLET, 'BNB whale', 'bnb'), enabled: true });
  copy.upsert({ ...defaultConfig('0xabcdef1234567890abcdef1234567890abcdef12', 'Paused', 'robinhood'), enabled: false });
  const chains = [...copy.activeChains()].sort();
  assert.deepEqual(chains, ['bnb', 'solana'], 'a disabled config needs no feed');
});

test('a machine whose clock runs fast corrects itself rather than stopping', async () => {
  // Every rail dates a trade from a CHAIN clock now. On a machine five
  // minutes fast every trade looks five minutes old, and a hard staleness
  // gate would refuse all of them forever for a reason that has nothing to
  // do with trading. Ages are measured against the fastest delivery actually
  // seen — but only once that has been seen enough times to be believed, so
  // an uncalibrated session still refuses a genuinely stale trade.
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, dailyTradeLimit: 100, maxCopiesPerMinute: 120 });
  const FAST = 5 * 60_000;
  for (let i = 0; i < 8; i++) {
    copy.onWalletTrade(trade({ mint: `Skew${i}${'1'.repeat(36)}`, isBuy: true, signature: `sk${i}`, tradeAt: Date.now() - FAST }));
    await tick();
  }
  assert.ok(copy._clockSkewMs() >= FAST - 10_000, `the offset was learned: ${copy._clockSkewMs()}`);
  assert.ok(h.calls.buys.length >= 3, `copying resumes once the offset is known: ${h.calls.buys.length} of 8`);

  // And a genuinely old trade ON TOP of that offset is still refused.
  const before = h.calls.buys.length;
  copy.onWalletTrade(trade({ mint: `Skew9${'1'.repeat(36)}`, isBuy: true, signature: 'sk9', tradeAt: Date.now() - FAST - 10 * 60_000 }));
  await tick();
  assert.equal(h.calls.buys.length, before, 'ten minutes late is ten minutes late, whatever the clock says');
  assert.ok(copy.snapshot().recent.some((x) => /too old to copy/.test(x.reason ?? '')));
});

test('an offset is not believed on the strength of one sample', async () => {
  // Otherwise the first trade of a session defines itself as normal, and a
  // sell recovered forty minutes late would sail through the rule written
  // to catch it.
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 1, signature: 'lone', tradeAt: Date.now() - 40 * 60_000 }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'it is still refused');
  assert.equal(copy._clockSkewMs(), 0, 'and nothing was calibrated from it');
});

test('a clock running BEHIND the chain never makes a trade look late', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'behind', tradeAt: Date.now() + 5 * 60_000 }));
  await tick();
  assert.equal(h.calls.buys.length, 1);
  assert.equal(copy._clockSkewMs(), 0, 'a negative sample is not an offset');
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
  console.log(`copytrade: ${passed}/${cases.length} tests passed`);
}

// ── The same transaction from two feeds is one trade ─────────────────
// A leader's pump.fun trade arrives from the curve firehose AND from the
// wallet watcher's own subscription; the signature dedupes the pair.
test('a signature seen twice is evaluated once', async () => {
  const h = setup({ priceSol: 0.001 });
  save();
  copy.onWalletTrade(trade({ signature: 'sigSame' }));
  copy.onWalletTrade(trade({ signature: 'sigSame' }));
  await new Promise((r) => setTimeout(r, 40));
  const mine = copy.snapshot().recent.filter((t) => t.mint === MINT);
  assert.equal(mine.length, 1, 'one record for one transaction');
  // Trades without a signature (the simulator, tests) are not deduped.
  copy.onWalletTrade(trade());
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(copy.snapshot().recent.filter((t) => t.mint === MINT).length, 3);
  assert.deepEqual(copy.openMints(), [MINT], 'open copies name their mints for the price poll');
});

// ── The leader's own record ───────────────────────────────────────────
//
// The copy scorecard answers "what did following them do for ME"; this
// answers "are they any good" — scored from every swap seen, whether or not
// a copy happened, and never from proceeds whose cost was not seen.

const sell = (over = {}) => trade({ isBuy: false, ...over });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('LEADER: a buy and a full sell make one scored round trip with THEIR result, copied or not', async () => {
  setup();
  save({ minKryptScore: 99 }); // the copy itself is filtered out…
  const t0 = Date.now() - 60_000;
  copy.onWalletTrade(trade({ at: t0 })); // 1 SOL → 1000 tokens
  copy.onWalletTrade(sell({ sol: 1.5, priceSol: 0.0015, soldFraction: 1, at: t0 + 30_000 }));
  await new Promise((r) => setTimeout(r, 40));
  const s = copy.snapshot();
  assert.equal(s.stats[s.configs[0].id].skipped, 1, '…and recorded as such');
  const L = s.leaders[WALLET];
  assert.equal(L.buys, 1);
  assert.equal(L.sells, 1);
  assert.equal(L.roundTrips, 1);
  assert.equal(L.wins, 1);
  assert.equal(L.losses, 0);
  assert.ok(near(L.realizedPnlSol, 0.5), 'they made +0.5');
  assert.ok(near(L.returnPct, 50));
  assert.ok(near(L.volumeSol, 1));
  assert.equal(L.openCount, 0);
  assert.equal(L.avgHoldMs, 30_000);
  assert.equal(L.bestSol, L.worstSol);
  assert.equal(L.recentTrips[0].symbol, 'COPY');
  assert.equal(L.watchedSince, t0);
});

test('LEADER: a partial sell scores its share; the rest stays open and marks to the last price', async () => {
  setup();
  save();
  copy.onWalletTrade(trade()); // 1 SOL, 1000 tokens
  copy.onWalletTrade(sell({ sol: 0.6, priceSol: 0.0015, soldFraction: 0.4 })); // 400 tokens for 0.6
  await new Promise((r) => setTimeout(r, 40));
  let L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 0);
  assert.equal(L.openCount, 1);
  assert.ok(near(L.realizedPnlSol, 0.2), '0.6 back against 0.4 of cost');
  assert.ok(near(L.openCostSol, 0.6));
  assert.ok(near(L.unrealizedPnlSol, 600 * 0.0015 - 0.6), 'marked at their fill');
  copy.markToMarket(MINT, 0.002);
  L = copy.snapshot().leaders[WALLET];
  assert.ok(near(L.unrealizedPnlSol, 600 * 0.002 - 0.6), 'marked at the tape');
  copy.onWalletTrade(sell({ sol: 1.2, priceSol: 0.002, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 40));
  L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 1);
  assert.ok(near(L.realizedPnlSol, 0.8), '+0.2 then +0.6');
  assert.equal(L.openCount, 0);
  assert.equal(L.unrealizedPnlSol, null);
});

test('LEADER: a sell of tokens bought before we watched is counted, never scored', async () => {
  setup();
  save();
  copy.onWalletTrade(sell({ sol: 3, priceSol: 0.003, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 40));
  const L = copy.snapshot().leaders[WALLET];
  assert.equal(L.sells, 1);
  assert.equal(L.unscoredSells, 1);
  assert.equal(L.roundTrips, 0);
  assert.equal(L.realizedPnlSol, 0);
  assert.equal(L.returnPct, null);
});

test('LEADER: a sell bigger than the tracked position scores only the tracked share', async () => {
  setup();
  save();
  copy.onWalletTrade(trade()); // 1000 tracked
  copy.onWalletTrade(sell({ sol: 4, priceSol: 0.002, tokens: 2000, soldFraction: 1 })); // they sold 2000
  await new Promise((r) => setTimeout(r, 40));
  const L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 1);
  assert.ok(near(L.realizedPnlSol, 1), 'half the proceeds (2 SOL) against the 1 SOL cost');
  assert.equal(L.unscoredSells, 1, 'the other half had no known cost');
});

test('LEADER: a losing trip is a loss; best/worst, rate and order follow', async () => {
  setup();
  save();
  const M2 = 'CopyMint222222222222222222222222222222222';
  copy.onWalletTrade(trade());
  copy.onWalletTrade(sell({ sol: 0.5, priceSol: 0.0005, soldFraction: 1 })); // −0.5
  copy.onWalletTrade(trade({ mint: M2, symbol: 'TWO' }));
  copy.onWalletTrade(sell({ mint: M2, symbol: 'TWO', sol: 2, priceSol: 0.002, soldFraction: 1 })); // +1
  await new Promise((r) => setTimeout(r, 40));
  const L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 2);
  assert.equal(L.wins, 1);
  assert.equal(L.losses, 1);
  assert.ok(near(L.realizedPnlSol, 0.5));
  assert.ok(near(L.bestSol, 1));
  assert.ok(near(L.worstSol, -0.5));
  assert.ok(near(L.tradesPerDay, 4), 'four swaps inside the first day');
  assert.equal(L.recentTrips[0].symbol, 'TWO', 'newest first');
});

test('LEADER: the record survives a reload, resets on request, and goes with the last config', async () => {
  setup();
  save();
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 40));
  const book = JSON.parse(JSON.stringify(copy._leaders()));
  const configs = copy.all();
  copy._reset();
  copy.attach(makeHost().host);
  copy._load(configs, [], book);
  assert.equal(copy.snapshot().leaders[WALLET].openCount, 1, 'reloaded from the file');
  assert.equal(copy.resetLeader('Nobody11111111111111111111111111111111111').ok, false);
  assert.equal(copy.resetLeader(WALLET).ok, true);
  assert.equal(copy.snapshot().leaders[WALLET].buys, 0, 'cleared; the config stays');
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 40));
  copy.remove(configs[0].id);
  assert.equal(copy.snapshot().leaders[WALLET], undefined, 'gone with the last config');
});

test('rankLeaders: the chosen key, small samples last, unknowns after everything', () => {
  const mk = (wallet, over) => ({ ...emptyLeaderStats(wallet), ...over });
  const list = [
    mk('small-but-huge', { roundTrips: 2, wins: 2, realizedPnlSol: 9 }),
    mk('steady', { roundTrips: 8, wins: 6, losses: 2, realizedPnlSol: 1.2, returnPct: 20 }),
    mk('loser', { roundTrips: 6, wins: 1, losses: 5, realizedPnlSol: -2, returnPct: -40 }),
    mk('unknown', { roundTrips: 5, wins: 3, losses: 2, realizedPnlSol: 0.4, returnPct: null }),
  ];
  assert.deepEqual(rankLeaders(list, 'realizedPnlSol').map((l) => l.wallet), ['steady', 'unknown', 'loser', 'small-but-huge']);
  assert.deepEqual(rankLeaders(list, 'returnPct').map((l) => l.wallet), ['steady', 'loser', 'unknown', 'small-but-huge']);
  assert.deepEqual(rankLeaders(list, 'winRatePct').map((l) => l.wallet), ['steady', 'unknown', 'loser', 'small-but-huge']);
  assert.equal(leaderWinRate(list[0]), 100);
  assert.equal(leaderWinRate(emptyLeaderStats('x')), null);
});

// ── Followability (2026-09-14) ────────────────────────────────────────
//
// Measured over 9.3M curve trades across two day-pairs six weeks apart
// (docs/wallet-convergence-2026-09-14.md), the MEDIAN profitable pump wallet
// holds six seconds. Its edge is latency, and a copy cannot take it: the trade
// is over before the follower's buy lands. Ranking by the wallet's own profit
// therefore surfaces exactly the wallets a user cannot copy, which is why the
// flag exists — and why it must stay a WARNING and never become a score.

test('leaderTooFast: flags wallets whose trips end before a copy could join', () => {
  const mk = (wallet, over) => ({ ...emptyLeaderStats(wallet), ...over });
  const sniper = mk('sniper', { roundTrips: 10, tooFastPct: 90, medianHoldMs: 6_000 });
  const slow = mk('slow', { roundTrips: 10, tooFastPct: 5, medianHoldMs: 20 * 60_000 });
  assert.equal(leaderTooFast(sniper), true);
  assert.equal(leaderTooFast(slow), false);

  // Unmeasured is NOT fast. A wallet with no closed trips must never be
  // labelled — the honest-null rule; an em dash, never an accusation.
  assert.equal(leaderTooFast(mk('fresh', { roundTrips: 10, tooFastPct: null })), false);
  assert.equal(leaderTooFast(emptyLeaderStats('empty')), false);

  // Too small a sample cannot earn the flag either, same floor as the ranking.
  assert.equal(leaderTooFast(mk('tiny', { roundTrips: MIN_TRIPS_FOR_RANK - 1, tooFastPct: 100 })), false);

  // The boundary is inclusive, and it is the documented constant.
  assert.equal(leaderTooFast(mk('edge', { roundTrips: 5, tooFastPct: TOO_FAST_FLAG_PCT })), true);
  assert.equal(leaderTooFast(mk('under', { roundTrips: 5, tooFastPct: TOO_FAST_FLAG_PCT - 0.1 })), false);
});

test('Hold time ranks longest first, and an unmeasured hold sorts last', () => {
  const mk = (wallet, over) => ({ ...emptyLeaderStats(wallet), ...over });
  const list = [
    mk('sniper', { roundTrips: 9, medianHoldMs: 6_000 }),
    mk('swing', { roundTrips: 9, medianHoldMs: 45 * 60_000 }),
    mk('unknown', { roundTrips: 9, medianHoldMs: null }),
    mk('scalp', { roundTrips: 9, medianHoldMs: 90_000 }),
  ];
  assert.deepEqual(
    rankLeaders(list, 'medianHoldMs').map((l) => l.wallet),
    ['swing', 'scalp', 'sniper', 'unknown'],
  );
});

test('the copy-latency floor stays a minute, and above any realistic sniper hold', () => {
  // Pinned because lowering it would quietly un-flag the six-second wallets
  // the measurement was about.
  assert.equal(COPY_LATENCY_FLOOR_MS, 60_000);
  assert.ok(COPY_LATENCY_FLOOR_MS > 6_000, 'must exceed the measured median sniper hold');
});

// ── The pump rail's mirrored sell (copy-13, 2026-09-09) ───────────────
//
// A leader's pump.fun sell arrives twice. The curve firehose reads a LOG,
// which has no pre-balance, so its delivery carries no soldFraction; the
// wallet watcher has the fraction but must fetch the transaction first and
// therefore always arrives second. Deduping on the signature alone threw
// away the only delivery that could be mirrored, so the mirrored sell was
// dead for every pump.fun leader — the exact bug it was written to fix.

test('a sell delivered firehose-then-watcher sells exactly ONCE, on the delivery that knows the share', async () => {
  const h = await openLiveCopy();
  // 1. The firehose: same signature, no fraction.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, signature: 'sellDup' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'nothing can be sized from a log-only delivery');
  assert.equal(copy.snapshot().recent.filter((x) => x.kind === 'exit').length, 1, 'the skip is on the record');

  // 2. The watcher: SAME signature, now with the share they sold.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sellDup' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }], 'exactly one sell, of the share they sold');

  const snap = copy.snapshot();
  const parent = snap.recent.find((x) => x.kind !== 'exit');
  const exits = snap.recent.filter((x) => x.kind === 'exit');
  assert.equal(parent.remainingPct, 60, 'and only that share is closed');
  assert.equal(exits.length, 1, 'the superseded "could not tell" row is withdrawn');
  assert.equal(exits[0].state, 'closed');
  assert.equal(exits[0].soldPct, 40);
});

test('a third delivery of the same sell changes nothing, in either order', async () => {
  const h = await openLiveCopy();
  // Watcher first this time, then the firehose's fraction-less duplicate.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sellOnce' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, signature: 'sellOnce' }));
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sellOnce' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }], 'still one sell');
  assert.equal(copy.snapshot().recent.filter((x) => x.kind === 'exit').length, 1, 'and one exit row');
});

// ── Budgets are checked against copies in flight (copy-1) ─────────────

test('a burst of trades in one slot cannot out-run the daily limit', async () => {
  // Every check used to read a counter that only moved after the buy came
  // back, so eight swaps delivered together passed the same check eight
  // times. A slot is taken before the first await now.
  const h = setup({ buyMs: 40 });
  save({ mode: 'live', dailyTradeLimit: 2, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  for (let i = 0; i < 8; i++) copy.onWalletTrade(trade({ mint: `Burst${i}${'1'.repeat(35)}`, signature: `b${i}` }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.calls.buys.length, 2, `two buys, not eight: ${h.calls.buys.length}`);
  const st = Object.values(copy.snapshot().stats)[0];
  assert.equal(st.trades, 2);
  assert.equal(st.blocked, 6, 'the other six are recorded as limit-blocked');
});

test('the per-minute wall refuses a burst even when the day has room', async () => {
  const h = setup({ buyMs: 20 });
  save({ mode: 'live', dailyTradeLimit: 50, maxCopiesPerMinute: 3, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  for (let i = 0; i < 7; i++) copy.onWalletTrade(trade({ mint: `Fast${i}${'1'.repeat(36)}`, signature: `f${i}` }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.calls.buys.length, 3, `three copies a minute: ${h.calls.buys.length}`);
  const blocked = copy.snapshot().recent.filter((x) => /per minute/.test(x.reason ?? ''));
  assert.equal(blocked.length, 4, 'and the rest say why');
});

test('validation accepts a config with no per-minute field, and rejects a silly one', () => {
  const { maxCopiesPerMinute, ...without } = cfg();
  assert.equal(validateConfig(without).ok, true, 'an older saved config still loads');
  assert.equal(validateConfig(cfg({ maxCopiesPerMinute: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ maxCopiesPerMinute: 500 })).ok, false);
  assert.equal(validateConfig(cfg({ maxCopiesPerMinute: 5 })).ok, true);
});

// ── A sell is a share of the WALLET, not of the copy (copy-2) ─────────

test('the mirrored percentage is scaled by the copy share of what we paid for the bag', async () => {
  // h.sell sells a percentage of the whole token account. We paid 1 SOL
  // through this copy but hold 5 SOL of the same token, so mirroring "they
  // sold 40 %" as 40 % would sell 2 SOL — 1.6 of it hand-bought.
  const h = await openLiveCopy({ ourCostBasisSol: 5 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sc' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 8 }], '40 % of our fifth of the bag');
  const parent = copy.snapshot().recent.find((x) => x.kind !== 'exit');
  assert.equal(parent.remainingPct, 60, 'the RECORD still moves by the share they sold');
});

test('a host that cannot say what we paid mirrors the share unscaled', async () => {
  const h = await openLiveCopy({ ourCostBasisSol: null });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sc2' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }]);
});

test('one save can never create an ARMED live follower', () => {
  setup();
  const r = copy.upsert(cfg({ mode: 'live', enabled: true }));
  assert.equal(r.ok, true);
  assert.equal(copy.all()[0].enabled, false, 'born live means born disarmed');
  assert.match(r.message, /disarmed/i, 'and it says so');
});

// ── A paper row can never cause a real sell (copy-3) ──────────────────

test('flipping a config to live does not sell the paper position it opened', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'pb' }));
  await tick();
  const id = copy.snapshot().configs[0].id;
  // The flip to live disarms it; arming again is a second, deliberate save.
  copy.upsert({ ...cfg({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 }), id });
  assert.equal(copy.all()[0].enabled, false, 'paper to live never stays armed');
  copy.upsert({ ...cfg({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 }), id });

  copy.onWalletTrade(trade({ isBuy: false, sol: 0.5, priceSol: 0.002, soldFraction: 0.5, signature: 'ps' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'a paper row is not a reason to broadcast');
  const exits = copy.snapshot().recent.filter((x) => x.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].mode, 'paper', 'and the exit is labelled for what it was');
  assert.equal(exits[0].signature, null, 'with no transaction against it');
});

test('flipping a LIVE config back to paper leaves the real position open and says so', async () => {
  const h = await openLiveCopy();
  const id = copy.snapshot().configs[0].id;
  copy.upsert({ ...cfg({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 }), id });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'lp' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'paper mode places no order');
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((x) => x.kind !== 'exit').state, 'open', 'the wallet still holds it');
  assert.match(snap.recent.find((x) => x.kind === 'exit').reason, /still held/);
});

// ── Filters refuse what they cannot check (copy-4) ────────────────────

test('a filter set against a fact the app cannot read REFUSES the copy', async () => {
  const h = setup({ facts: { liquidityUsd: null, marketCapUsd: null, kryptScore: null, isPumpfun: true } });
  save({ mode: 'live', minLiquidityUsd: 5_000 });
  copy.onWalletTrade(trade({ signature: 'unk1' }));
  await tick();
  assert.equal(h.calls.buys.length, 0, 'unknown is not "fine"');
  assert.match(copy.snapshot().recent[0].reason, /liquidity unknown/);
});

test('an unset filter still lets an unknown fact through', async () => {
  const h = setup({ facts: { liquidityUsd: null, marketCapUsd: null, kryptScore: null, isPumpfun: true } });
  save({ mode: 'live', minLiquidityUsd: null, maxMarketCapUsd: null, minKryptScore: null });
  copy.onWalletTrade(trade({ signature: 'unk2' }));
  await tick();
  assert.equal(h.calls.buys.length, 1, 'a filter you did not set cannot refuse anything');
});

// ── Size, price and caps come from the host (copy-5, copy-8) ──────────

test('a broadcast that has not confirmed opens the position, with that ON the record', async () => {
  const h = setup({ priceSol: 0.001, buyResult: { ok: false, pending: true, message: 'broadcast', signature: 'psig' } });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ signature: 'pend' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'open', 'the token was bought; the record must be able to close it');
  assert.match(row.reason, /not confirmed/);
});

test('the size and price on the record are what the host actually spent and filled', async () => {
  const h = setup({
    priceSol: 0.001,
    buyResult: { ok: true, message: 'bought', signature: 'sig', spentSol: 0.037, fillPriceSol: 0.0012 },
  });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ signature: 'spent' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.ourSol, 0.037, 'not the 0.05 we asked for');
  assert.equal(row.entryPriceSol, 0.0012, 'and not the spot price we guessed');
});

test('a copy above the live per-trade cap is REFUSED, never quietly shrunk', async () => {
  const h = setup({ priceSol: 0.001, maxLiveSol: 0.02 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ signature: 'cap' }));
  await tick();
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /above your live cap/);
});

// ── The rest of the gates (copy-7, copy-9, copy-11) ───────────────────

test('the configured slippage reaches the host on both sides', async () => {
  const h = await openLiveCopy();
  // The default is 8 % since 2026-10-25: under the 10–20 % band Bitquery
  // measured as sandwiched 87 times per 10,000 swaps.
  assert.equal(h.calls.buyOpts[0].slippagePct, 8, 'the buy carries it');
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sl' }));
  await tick();
  assert.equal(h.calls.sellOpts[0].slippagePct, 8, 'and so does the sell');
});

test('a buy-side block stops a live copy even when selling is still allowed', async () => {
  const h = setup({ buyBlockedReason: 'the launch feed is stale' });
  save({ mode: 'live' });
  copy.onWalletTrade(trade({ signature: 'bb' }));
  await tick();
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /launch feed is stale/);
});

test('unfollowing a wallet mid-copy stops the copy that was in flight', async () => {
  const h = setup({ priceSol: 0.001, buyMs: 60 });
  save({ mode: 'live', delayMs: 30 });
  const id = copy.snapshot().configs[0].id;
  copy.onWalletTrade(trade({ signature: 'gone' }));
  await new Promise((r) => setTimeout(r, 10));
  copy.remove(id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.calls.buys.length, 0, 'the delay had not elapsed, and the config is gone');
  assert.equal(copy.snapshot().recent.length, 0, 'no orphan row against a config that no longer exists');
});

// ── The store on disk (copy-6, copy-10) ───────────────────────────────

function tempStore(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-copytest-'));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'copytrade.json'), contents, 'utf8');
  return dir;
}

test('a LIVE config does not resume armed after a restart; a paper one does', () => {
  copy._reset();
  const dir = tempStore(
    JSON.stringify({
      version: 1,
      configs: [
        { ...defaultConfig(WALLET, 'Live one'), id: 'c1', createdAt: 1, mode: 'live', enabled: true },
        { ...defaultConfig('Paper11111111111111111111111111111111111', 'Paper one'), id: 'c2', createdAt: 1, mode: 'paper', enabled: true },
      ],
      trades: [],
    }),
  );
  copy.init(dir);
  const [live, paper] = copy.all();
  assert.equal(live.enabled, false, 'an app closed for a week must not wake up spending');
  assert.equal(paper.enabled, true, 'paper costs nothing, and an interrupted experiment is useless');
  assert.equal(copy.failure(), null);
});

test('an unreadable store is NOT an empty one — nothing is overwritten', () => {
  copy._reset();
  const dir = tempStore(JSON.stringify({ version: 1, configs: [{ ...defaultConfig(WALLET, 'MY WHALE'), id: 'c1', createdAt: 1 }], trades: [] }));
  const file = path.join(dir, 'copytrade.json');
  fs.writeFileSync(file, '{"version":1,"configs":[{"wal', 'utf8'); // truncated write
  copy.init(dir);
  assert.equal(copy.all().length, 0, 'nothing could be loaded');
  assert.ok(copy.failure(), 'and the module knows it');
  assert.match(copy.snapshot().loadFailure, /corrupt/);

  // The proof: a save now must not blow away what is still on disk.
  save({ label: 'A NEW ONE' });
  return new Promise((r) =>
    setTimeout(() => {
      assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"configs":[{"wal', 'the file is untouched');
      r();
    }, 400),
  );
});

test('a first run writes normally — a missing file is not a failure', () => {
  copy._reset();
  const dir = tempStore();
  copy.init(dir);
  assert.equal(copy.failure(), null);
  save();
  return new Promise((r) =>
    setTimeout(() => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
      assert.equal(raw.configs.length, 1);
      r();
    }, 400),
  );
});

// ── The leader exits while our buy is still in flight ─────────────────
//
// `copyOnce` is slow on purpose: token facts, the configured delay, then a
// broadcast. The copy row does not exist until all of it returns, and a
// leader who sold inside that window used to hit `closeOpen`, find no open
// row, and return — the sell dropped on the floor, the buy landing a moment
// later into a position with no exit queued. A user reported 15 of 16
// matched buys recorded AFTER the leader had already exited (2026-09-13).

test('a leader sell during an in-flight buy is REMEMBERED, not dropped', async () => {
  // The buy takes 120 ms; the sell lands 20 ms in, while it is unrecallable.
  const h = setup({ priceSol: 0.001, buyMs: 120, leaderHolding: 0 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.buys.length, 1, 'the buy was already sent — it cannot be recalled');
  assert.equal(h.calls.sells.length, 1, 'and the parked sell fires the moment the row exists');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('a buy the leader exited BEFORE we sent is abandoned, not bought', async () => {
  // The delay is the window: nothing has been broadcast yet, so there is
  // still a real choice to make, and entering a position they have already
  // left is not copying them.
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 120 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.buys.length, 0, 'no real money went into a position they had left');
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(row.state, 'skipped');
  assert.match(row.reason, /already sold before this copy was sent/);
});

test('PAPER honours the same staleness rule, or the scorecard measures a strategy live would refuse', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 120 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.buys.length, 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'skipped');
});

// ── Rows whose tokens left through some other door ────────────────────

test('a live copy whose tokens are gone from the wallet is closed, not left open forever', async () => {
  const h = await openLiveCopy();
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(row.state, 'open');
  // Sold by hand, or by a stop-loss: the wallet holds none of it now.
  const n = copy.reconcileHoldings(new Set(), { graceMs: 0 });
  assert.equal(n, 1);
  const after = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(after.state, 'closed');
  assert.equal(after.pnlSol, null, 'we never saw the exit price — a made-up one would poison the scorecard');
  assert.match(after.reason, /no longer in the wallet/);
  assert.equal(h.calls.sells.length, 0, 'nothing is sold by a reconcile');
});

test('a copy whose tokens ARE still held is left alone', async () => {
  await openLiveCopy();
  assert.equal(copy.reconcileHoldings(new Set([MINT]), { graceMs: 0 }), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
});

test('a freshly broadcast copy is inside the grace window and is NOT closed', async () => {
  await openLiveCopy();
  // The default grace: a buy that has not landed yet is not a sold position.
  assert.equal(copy.reconcileHoldings(new Set()), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
});

test('a PAPER copy is never reconciled against the chain — it was never on it', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  assert.equal(copy.reconcileHoldings(new Set(), { graceMs: 0 }), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.equal(h.calls.sells.length, 0);
});

test('a reconcile scoped to other configs leaves this one alone', async () => {
  // A config can sign with a wallet that is not the active one; that
  // wallet's holdings say nothing about these tokens. Closing on them would
  // be the same bug pointed the other way.
  await openLiveCopy();
  const mine = copy.all()[0];
  assert.equal(copy.reconcileHoldings(new Set(), { graceMs: 0, configIds: new Set(['someone-else']) }), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  // Named explicitly, it closes.
  assert.equal(copy.reconcileHoldings(new Set(), { graceMs: 0, configIds: new Set([mine.id]) }), 1);
});

// ── Clearing paper results without losing anything else ───────────────
//
// "Remove" was the only way to start a paper record over, and it takes the
// config, the live history and the leader's own record with it — three
// different things (user report, 2026-09-13).

test('resetPaper clears paper rows and keeps configs, live rows and leader records', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'live1' }));
  await tick();
  assert.equal(h.calls.buys.length, 1);
  const liveCfg = copy.all()[0];
  // A paper config on a second wallet, with a copy of its own.
  const W2 = 'Whae2222222222222222222222222222222222222';
  copy.upsert({ ...cfg({ wallet: W2, label: 'Paper', mode: 'paper' }) });
  const made = copy.all().find((c) => c.wallet === W2);
  copy.upsert({ ...cfg({ wallet: W2, label: 'Paper', mode: 'paper' }), id: made.id });
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'paper1' }));
  await tick();

  const leadersBefore = Object.keys(copy._leaders()).length;
  assert.ok(leadersBefore > 0, 'the leaders have a record to preserve');

  const r = copy.resetPaper();
  assert.equal(r.ok, true);
  assert.equal(r.cleared, 1, 'only the paper row went');

  const snap = copy.snapshot();
  assert.equal(copy.all().length, 2, 'both configs stay');
  assert.equal(copy.all().find((c) => c.wallet === W2).mode, 'paper', 'and their paper/live setting stays');
  assert.equal(snap.recent.filter((t) => t.mode === 'paper').length, 0);
  assert.equal(snap.recent.filter((t) => t.mode === 'live').length, 1, 'real money history is never rewritten');
  assert.equal(Object.keys(copy._leaders()).length, leadersBefore, 'their record is theirs, not a function of your paper run');
  assert.equal(snap.stats[liveCfg.id].trades, 1, 'the live scorecard is untouched');
});

test('resetPaper can target ONE config', async () => {
  setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const W2 = 'Whae2222222222222222222222222222222222222';
  copy.upsert({ ...cfg({ wallet: W2, label: 'Other', mode: 'paper' }) });
  const other = copy.all().find((c) => c.wallet === W2);
  copy.upsert({ ...cfg({ wallet: W2, label: 'Other', mode: 'paper' }), id: other.id });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'p1' }));
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'p2' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind !== 'exit').length, 2);
  const mine = copy.all().find((c) => c.wallet === WALLET);
  copy.resetPaper(mine.id);
  const left = copy.snapshot().recent.filter((t) => t.kind !== 'exit');
  assert.equal(left.length, 1);
  assert.equal(left[0].configId, other.id, "the other wallet's run keeps going");
});

test('resetPaper refuses an id that does not exist, and clears nothing', () => {
  setup({ priceSol: 0.001 });
  save({ mode: 'paper' });
  const r = copy.resetPaper('nope');
  assert.equal(r.ok, false);
  assert.equal(r.cleared, 0);
  assert.equal(copy.all().length, 1);
});

// ── Restarts during pending orders ────────────────────────────────────
//
// Explicitly asked for in the 2026-09-13 report, and the gap the in-memory
// fix left behind: a sell the leader made while our buy was in flight is an
// INSTRUCTION, and it has to survive the process, not just the async gap.
// A crash or a quit at the wrong moment used to drop it, leaving the
// position open with nothing left remembering it was meant to close.

/** Round-trip the module through disk, the way a restart does. */
async function restart(dir) {
  await new Promise((r) => setTimeout(r, 400)); // the 300 ms debounced write
  copy._reset();
  copy.init(dir);
  return dir;
}

test('a parked exit SURVIVES a restart and is mirrored on the way back up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-restart-'));
  copy._reset();
  copy.init(dir);
  const h1 = makeHost({ priceSol: 0.001, buyMs: 60, leaderHolding: 0 });
  copy.attach(h1.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 10));
  // The leader exits mid-buy; the buy is already out, so the exit parks.
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h1.calls.sells.length, 1, 'in one process it mirrors immediately');

  // Now the same race, but the process dies before the buy returns.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-restart2-'));
  copy._reset();
  copy.init(dir2);
  const h2 = makeHost({ priceSol: 0.001, buyMs: 5_000, leaderHolding: 0 });
  copy.attach(h2.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b2' }));
  await new Promise((r) => setTimeout(r, 10));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's2' }));
  await new Promise((r) => setTimeout(r, 450)); // persisted, buy still hanging
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir2, 'copytrade.json'), 'utf8'));
  assert.equal(onDisk.pendingExits.length, 1, 'the instruction reached disk');
  assert.equal(onDisk.pendingExits[0].trade.mint, MINT);
});

test('after a restart a FRESH parked exit fires, once a position exists to close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-resume-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  // Hand-write the state a crash would have left: an open row, and an exit
  // parked against it. After the 300 ms debounced write, or there is no file.
  await new Promise((r) => setTimeout(r, 400));
  const cfgId = copy.all()[0].id;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [
    { key: `${cfgId}:${MINT}`, trade: { ...trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }), at: Date.now() } },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h2.host);
  const out = copy.resumePendingExits();
  await tick();
  assert.equal(out.fired, 1);
  assert.equal(h2.calls.sells.length, 1, 'the exit the crash interrupted is honoured');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('an exit resumed on a config the restart PAUSED still fires, and says so', async () => {
  // The restart disarm is about not resuming ENTRIES. An exit must stay
  // possible while entries are paused — but the panel is showing "Paused"
  // while this sells, so the toast has to explain the pair or a user is
  // right to distrust both.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-paused-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  await new Promise((r) => setTimeout(r, 400));
  const cfgId = copy.all()[0].id;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [
    { key: `${cfgId}:${MINT}`, trade: { ...trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }), at: Date.now() } },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h2.host);
  assert.equal(copy.all()[0].enabled, false, 'the restart disarmed the live config');
  const out = copy.resumePendingExits();
  await tick();
  assert.equal(out.fired, 1, 'the exit still runs — entries are what a restart pauses');
  assert.equal(h2.calls.sells.length, 1);
  const said = h2.calls.toasts.find((t) => /paused/i.test(t.message));
  assert.ok(said, 'the user is told why a paused config just sold');
});

test('a STALE parked exit is never traded on late — it is recorded, and says you still hold it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-stale-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  await new Promise((r) => setTimeout(r, 400));
  const cfgId = copy.all()[0].id;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  // The app was shut for an hour.
  raw.pendingExits = [
    {
      key: `${cfgId}:${MINT}`,
      trade: { ...trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }), at: Date.now() - 60 * 60_000 },
    },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h2.host);
  const out = copy.resumePendingExits();
  await tick();
  assert.equal(out.fired, 0, 'an hour-old sell is not a trade anyone made today');
  assert.equal(out.expired, 1);
  assert.equal(h2.calls.sells.length, 0);
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.match(exit.reason, /while the app was closed/);
  assert.match(exit.reason, /still hold it/);
  const said = h2.calls.toasts.at(-1);
  assert.equal(said.level, 'error', 'never silent — the user is still holding the bag');
});

test('a parked exit whose buy never opened a row does nothing on restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-norow-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const cfgId = copy.all()[0].id;
  await new Promise((r) => setTimeout(r, 400));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [
    { key: `${cfgId}:${MINT}`, trade: { ...trade({ isBuy: false, soldFraction: 1, signature: 's1' }), at: Date.now() } },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001 });
  copy.attach(h2.host);
  const out = copy.resumePendingExits();
  await tick();
  // The buy died with the process and never opened anything, so there is
  // nothing held and nothing to sell. Selling here would be a phantom order.
  assert.equal(out.fired, 0);
  assert.equal(out.expired, 0);
  assert.equal(h2.calls.sells.length, 0);
});

test('a corrupt pendingExits list does not stop the configs loading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-badpending-'));
  copy._reset();
  copy.init(dir);
  copy.attach(makeHost({ priceSol: 0.001 }).host);
  save({ mode: 'paper' });
  await new Promise((r) => setTimeout(r, 400));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [null, 42, { key: 'x' }, { trade: {} }];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');
  await restart(dir);
  copy.attach(makeHost({ priceSol: 0.001 }).host);
  assert.equal(copy.all().length, 1, 'the configs still loaded');
  assert.deepEqual(copy.resumePendingExits(), { fired: 0, expired: 0 });
});


// ── Reverse copying (2026-09-20) ──────────────────────────────────────
//
// The contrarian read of the same feed: their SELL is our entry, their BUY
// is our exit, and because a leader rarely buys the same coin back the
// position closes on its own terms — take-profit, stop-loss, max hold —
// judged on the price ticks `markToMarket` already receives. Everything
// else is the copy path: filters, limits, delay, staleness, paper honesty,
// the 100 % mirrored sell. Pinned here.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('reverse: their sell opens our position, at the price after the delay; their buy alone opens nothing', async () => {
  const h = setup({ priceSol: 0.0015 });
  save({ direction: 'reverse', delayMs: 5 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001, signature: 'rb0' }));
  await sleep(40);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 0, 'a reverse config does not buy when they buy');
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.001, soldFraction: 1, signature: 'rs1' }));
  await sleep(60);
  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.ok(open, 'their sell opened our position');
  assert.equal(open.direction, 'reverse');
  assert.equal(open.entryPriceSol, 0.0015, 'filled at the tape after the delay, not at their sell price');
  assert.equal(open.theirSol, 0.8, 'sized off what they sold for');
  assert.equal(h.calls.buys.length, 0, 'paper: nothing was bought');
});

test('reverse: the same sell delivered twice opens once', async () => {
  setup({ priceSol: 0.001 });
  save({ direction: 'reverse', delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs2' }));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs2' }));
  await sleep(40);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1);
});

test('reverse: their buy-back closes it in full, and the slice says why', async () => {
  setup({ priceSol: 0.001 });
  save({ direction: 'reverse', delayMs: 0, sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs3' }));
  await sleep(30);
  copy.onWalletTrade(trade({ isBuy: true, sol: 1, priceSol: 0.002, signature: 'rb3' }));
  await sleep(40);
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit' && t.direction === 'reverse');
  const slice = snap.recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'an exit slice was booked');
  assert.equal(parent.state, 'closed');
  assert.equal(slice.soldPct, 100, 'their buy-back is the thesis being wrong: all of it goes');
  assert.equal(slice.reason, 'they bought back — reverse exit');
  // Entry 0.001, exit 0.002, 1.75 % a side plus 0.003504 fixed:
  // 1 × (2 × 0.9825 − 1.0175) − 0.003504 = +0.943996
  assert.ok(Math.abs(slice.pnlSol - 0.943996) < 1e-9, `net of both sides: ${slice.pnlSol}`);
});

test('reverse: take-profit, stop-loss and max hold each close it without the leader', async () => {
  // Take-profit at the default +25 %.
  setup({ priceSol: 0.001 });
  save({ direction: 'reverse', delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs4' }));
  await sleep(30);
  copy.markToMarket(MINT, 0.00124);
  await sleep(30);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, '+24 % is under the take-profit');
  copy.markToMarket(MINT, 0.00126);
  await sleep(40);
  let slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'the take-profit fired');
  assert.match(slice.reason, /take-profit \+25%/);
  assert.equal(slice.exitPriceSol, 0.00126, 'at the tick that crossed it');
  copy.markToMarket(MINT, 0.0013);
  await sleep(30);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 1, 'a closed position is not exited again');

  // Stop-loss at a configured −10 %.
  setup({ priceSol: 0.001 });
  save({ direction: 'reverse', delayMs: 0, exitStopLossPct: 10 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs5' }));
  await sleep(30);
  copy.markToMarket(MINT, 0.00089);
  await sleep(40);
  slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'the stop-loss fired');
  assert.match(slice.reason, /stop-loss −10%/);

  // Max hold at a configured 30 minutes, judged by the tick's clock.
  setup({ priceSol: 0.001 });
  save({ direction: 'reverse', delayMs: 0, exitMaxHoldMin: 30 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs6' }));
  await sleep(30);
  copy.markToMarket(MINT, 0.001, undefined, Date.now() + 29 * 60_000);
  await sleep(30);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, '29 minutes is not 30');
  copy.markToMarket(MINT, 0.001, undefined, Date.now() + 31 * 60_000);
  await sleep(40);
  slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'the max hold fired');
  assert.match(slice.reason, /max hold 30 min/);
});

test('reverse: a paused config takes no new entries, but still exits what it holds — the same rule as a copy', async () => {
  setup({ priceSol: 0.001 });
  save({ direction: 'reverse', delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs7' }));
  await sleep(30);
  const c = copy.all()[0];
  copy.upsert({ ...c, enabled: false });
  // A second leader sell, on another coin, would be an entry: refused.
  copy.onWalletTrade(trade({ isBuy: false, mint: 'OtherMint1111111111111111111111111111111111', sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs7b' }));
  await sleep(30);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind !== 'exit').length, 1, 'paused: no new position');
  // The open one's take-profit (+25 %) still fires: pausing is about entries.
  copy.markToMarket(MINT, 0.002);
  await sleep(30);
  const slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'paused: the position it holds is still exited');
  assert.match(slice.reason, /take-profit/);
});

test('reverse: live entries buy through the host and live exits sell 100 % through it', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ direction: 'reverse', mode: 'live', delayMs: 0, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.001, soldFraction: 1, signature: 'rs8' }));
  await sleep(40);
  assert.equal(h.calls.buys.length, 1, 'their sell bought for real');
  assert.equal(h.calls.buys[0].sol, 0.05);
  assert.ok(h.calls.toasts.some((t) => /^Reversed /.test(t.message)), 'and said so as a reverse, not a copy');
  copy.markToMarket(MINT, 0.0013);
  await sleep(60);
  assert.equal(h.calls.sells.length, 1, 'the take-profit sold for real');
  assert.equal(h.calls.sells[0].pct, 100);
});

test('reverse: validation, defaults and the description', () => {
  assert.equal(validateConfig(cfg({ direction: 'reverse' })).ok, true);
  assert.equal(validateConfig(cfg({ direction: 'sideways' })).ok, false);
  assert.equal(validateConfig(cfg({ direction: 'reverse', exitStopLossPct: 99 })).ok, false);
  assert.equal(validateConfig(cfg({ direction: 'reverse', exitTakeProfitPct: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ direction: 'reverse', exitMaxHoldMin: 5_000 })).ok, false);
  assert.equal(validateConfig(cfg({ direction: 'copy', exitStopLossPct: 99 })).ok, false, 'a copy may set its own exits too, within the same bounds');
  assert.equal(validateConfig(cfg({ direction: 'copy', exitStopLossPct: 10 })).ok, true);
  const d = defaultConfig(WALLET, 'x', 'solana', 'reverse');
  assert.equal(d.direction, 'reverse');
  assert.equal(d.mode, 'paper', 'reverse starts on paper like everything else');
  assert.equal(d.enabled, false);
  assert.match(describeConfig({ ...cfg({ direction: 'reverse' }), id: 'r', createdAt: 0 }), /buy when they sell.*\+25%.*−20%.*30 min/);
  assert.match(describeConfig({ ...cfg(), id: 'c', createdAt: 0 }), /^Paper-copy /);
});

// ── FOMO copying (2026-09-20) ─────────────────────────────────────────
//
// A crowd, not a wallet: K distinct wallets from a source set buying the
// same coin inside a window is the entry; the crowd leaving is one exit,
// the config's own take-profit / stop-loss / max hold the others. The
// trades arrive either through onWalletTrade (followed wallets) or through
// noteCrowdTrade straight from the firehose, and both must count once.
// Measured, convergence made outcomes WORSE (docs/wallet-convergence-
// 2026-09-14.md) — so paper first, and the form says so. Pinned here.

const CROWD = [
  'Crowd111111111111111111111111111111111111A',
  'Crowd111111111111111111111111111111111111B',
  'Crowd111111111111111111111111111111111111C',
  'Crowd111111111111111111111111111111111111D',
];
const fomoCfg = (over = {}) => ({ ...defaultConfig('', 'Crowd', 'solana', 'fomo'), enabled: true, ...over });
const saveFomo = (over = {}) => {
  const c = fomoCfg(over);
  const r = copy.upsert(c);
  if (!r.ok) return r;
  const made = copy.all().find((x) => x.wallet === FOMO_WALLET && x.label === c.label);
  if (made && c.enabled && !made.enabled) return copy.upsert({ ...c, id: made.id });
  return r;
};
const crowdBuy = (i, over = {}) => copy.noteCrowdTrade(trade({ wallet: CROWD[i], signature: `cb${i}-${Math.random()}`, ...over }));
const setupCrowd = (over = {}, hostOver = {}) =>
  setup({
    priceSol: 0.001,
    host: { scoutSaved: () => CROWD.slice(0, 3), trackedWallets: () => [CROWD[3]], scoutTop: (_c, n) => CROWD.slice(0, n), ...hostOver },
    ...over,
  });

test('fomo: three of the saved wallets buying inside the window opens one position, named after the crowd', async () => {
  const h = setupCrowd();
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 3, fomoWindowSec: 60, delayMs: 0 });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(30);
  assert.equal(copy.snapshot().recent.length, 0, 'two wallets are not a crowd of three');
  crowdBuy(2, { at: t0 + 2_000 });
  await sleep(60);
  const rows = copy.snapshot().recent;
  assert.equal(rows.filter((t) => t.state === 'open').length, 1, 'the third wallet fired exactly one entry');
  const open = rows.find((t) => t.state === 'open');
  assert.equal(open.direction, 'fomo');
  assert.equal(open.wallet, FOMO_WALLET, 'the row belongs to the crowd, not to a wallet');
  assert.deepEqual([...open.triggeredBy].sort(), CROWD.slice(0, 3).sort(), 'the record names who triggered it');
  assert.equal(open.entryPriceSol, 0.001, 'filled at the tape, like any paper copy');
  assert.equal(h.calls.buys.length, 0, 'paper: nothing was bought');
  // A fourth buy of the same coin by another member is not a second entry.
  copy.noteCrowdTrade(trade({ wallet: CROWD[3], at: t0 + 3_000 }));
  crowdBuy(0, { at: t0 + 4_000 });
  await sleep(40);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1, 'once per coin while the position is open');
});

test('fomo: the same wallet buying three times is one wallet, and buys outside the window do not count', async () => {
  setupCrowd();
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 3, fomoWindowSec: 60, delayMs: 0 });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(0, { at: t0 + 500 });
  crowdBuy(0, { at: t0 + 1_000 });
  await sleep(30);
  assert.equal(copy.snapshot().recent.length, 0, 'one wallet, three buys: not a crowd');
  crowdBuy(1, { at: t0 + 2_000 });
  // The first wallet's latest buy is now 60.5 s old — outside the 60 s
  // window — while the second wallet's is 59.5 s old and still inside.
  crowdBuy(2, { at: t0 + 61_500 });
  await sleep(40);
  assert.equal(copy.snapshot().recent.length, 0, 'a stale buy fell out of the window');
  crowdBuy(0, { at: t0 + 61_900 });
  await sleep(60);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1, 'three inside the window is a crowd');
});

test('fomo: a wallet outside the source set is ignored, and the source is the one configured', async () => {
  setupCrowd();
  // Source = the ONE tracked wallet: three saved wallets buying is nothing to it.
  saveFomo({ fomoSource: 'tracked', fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  crowdBuy(2, { at: t0 + 2_000 });
  await sleep(40);
  assert.equal(copy.snapshot().recent.length, 0, 'saved wallets are not the tracked set');
  assert.equal(copy.crowdWants('solana', CROWD[0]), false, 'the engine is told not to bother');
  assert.equal(copy.crowdWants('solana', CROWD[3]), true, 'the tracked wallet is wanted');
  assert.equal(copy.crowdWants('solana', CROWD[3].toLowerCase()), true, 'case does not matter: the Scout keys lower-case');
  // Top N takes the first n of the ranked list.
  copy._reset();
  setupCrowd();
  saveFomo({ fomoSource: 'top', fomoTopN: 2, fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  crowdBuy(2, { at: t0 });
  crowdBuy(3, { at: t0 + 1_000 });
  await sleep(30);
  assert.equal(copy.snapshot().recent.length, 0, 'third and fourth are outside the top 2');
  crowdBuy(0, { at: t0 + 2_000 });
  crowdBuy(1, { at: t0 + 3_000 });
  await sleep(60);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1, 'the top two converging fires');
});

test('fomo: wallets the user picked are a crowd of their own, and the top list is ranked by the sort the config names', async () => {
  const t0 = Date.now();
  const sorts = [];
  copy._reset();
  setupCrowd({}, { scoutTop: (_c, n, sort) => (sorts.push(sort), CROWD.slice(0, n)) });
  saveFomo({ fomoSource: 'list', fomoWallets: [CROWD[2], CROWD[3]], fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(30);
  assert.equal(copy.snapshot().recent.length, 0, 'wallets outside the picked list are not the crowd');
  assert.equal(copy.crowdWants('solana', CROWD[0]), false);
  assert.equal(copy.crowdWants('solana', CROWD[3]), true, 'a picked wallet is wanted');
  crowdBuy(2, { at: t0 + 2_000 });
  crowdBuy(3, { at: t0 + 3_000 });
  await sleep(60);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1, 'the two picked wallets converging fires');
  assert.equal(sorts.length, 0, 'a picked list never asks the Scout');

  copy._reset();
  setupCrowd({}, { scoutTop: (_c, n, sort) => (sorts.push(sort), CROWD.slice(0, n)) });
  saveFomo({ fomoSource: 'top', fomoTopN: 2, fomoTopSort: 'fSumPct', fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(60);
  assert.ok(sorts.includes('fSumPct'), 'the host ranked the top list by the week total');
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1);
  assert.match(describeConfig({ ...fomoCfg({ fomoSource: 'top', fomoTopSort: 'fSumPct' }), id: 'f', createdAt: 0 }), /3 of the top 25 Scout wallets by Week total, copied buy the same coin/);
});

test('fomo: the followed source is the enabled copy configs, and a followed wallet counts once through onWalletTrade', async () => {
  setupCrowd();
  save({ wallet: CROWD[0], delayMs: 0 });
  save({ wallet: CROWD[1], label: 'Two', delayMs: 0 });
  saveFomo({ fomoSource: 'followed', fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  assert.deepEqual([...copy.activeWallets('solana')].sort(), [CROWD[0], CROWD[1]].sort(), 'the FOMO config is not a followed wallet');
  const t0 = Date.now();
  // The engine delivers a followed wallet's trade through onWalletTrade AND
  // may deliver it through noteCrowdTrade off the firehose; the crowd must
  // still see one wallet.
  copy.onWalletTrade(trade({ wallet: CROWD[0], at: t0, signature: 'f0' }));
  copy.noteCrowdTrade(trade({ wallet: CROWD[0], at: t0, signature: 'f0' }));
  await sleep(40);
  const fomoRows = () => copy.snapshot().recent.filter((t) => t.direction === 'fomo');
  assert.equal(fomoRows().length, 0, 'one followed wallet, heard twice, is one wallet');
  copy.onWalletTrade(trade({ wallet: CROWD[1], at: t0 + 1_000, signature: 'f1' }));
  await sleep(60);
  assert.equal(fomoRows().filter((t) => t.state === 'open').length, 1, 'two followed wallets converging fires the crowd');
  assert.equal(copy.snapshot().recent.filter((t) => t.direction === 'copy' && t.state === 'open').length, 2, 'and the two plain copies opened as before');
  assert.ok(!Object.keys(copy.snapshot().leaders).includes(FOMO_WALLET), 'the crowd is not a leader on the board');
});

test('fomo: half the crowd selling closes the position with the reason on the slice', async () => {
  setupCrowd();
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 3, fomoWindowSec: 60, fomoCrowdExitPct: 50, delayMs: 0, sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  crowdBuy(2, { at: t0 + 2_000 });
  await sleep(60);
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1);
  copy.noteCrowdTrade(trade({ wallet: CROWD[0], isBuy: false, sol: 0.5, priceSol: 0.0012, soldFraction: 1, at: t0 + 10_000 }));
  await sleep(40);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, '1 of 3 is 33 %, under 50 %');
  copy.noteCrowdTrade(trade({ wallet: CROWD[3], isBuy: false, sol: 0.5, priceSol: 0.0012, soldFraction: 1, at: t0 + 11_000 }));
  await sleep(40);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'a wallet that did not trigger it does not count toward leaving');
  copy.noteCrowdTrade(trade({ wallet: CROWD[1], isBuy: false, sol: 0.5, priceSol: 0.0012, soldFraction: 1, at: t0 + 12_000 }));
  await sleep(60);
  const slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, '2 of 3 sold: the crowd left');
  assert.match(slice.reason, /the crowd left — 2 of 3 sold/);
  assert.equal(slice.exitPriceSol, 0.0012);
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit' && t.direction === 'fomo');
  assert.equal(parent.state, 'closed');
  // Entry 0.001, exit 0.0012, 1.75 % a side plus 0.003504 fixed:
  // 1 × (1.2 × 0.9825 − 1.0175) − 0.003504 = +0.157996
  assert.ok(Math.abs(slice.pnlSol - 0.157996) < 1e-9, `+20 % gross net of both sides: ${slice.pnlSol}`);
});

test('fomo: its own take-profit and stop-loss close it too, and a copy config may now set its own', async () => {
  setupCrowd();
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(60);
  copy.markToMarket(MINT, 0.00124);
  await sleep(30);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, '+24 % is under the default take-profit');
  copy.markToMarket(MINT, 0.00126);
  await sleep(40);
  let slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'the take-profit fired');
  assert.match(slice.reason, /take-profit \+25% \(fomo\)/);

  // A plain copy with a stop-loss of its own, on top of the leader's sells.
  setup({ priceSol: 0.001 });
  save({ delayMs: 0, exitStopLossPct: 10 });
  copy.onWalletTrade(trade({ signature: 'cx1' }));
  await sleep(30);
  copy.markToMarket(MINT, 0.00095);
  await sleep(30);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, '−5 % is under a 10 % stop');
  copy.markToMarket(MINT, 0.00089);
  await sleep(40);
  slice = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(slice, 'a copy with its own stop-loss exits without the leader');
  assert.match(slice.reason, /stop-loss −10% \(copy\)/);
  // And a copy WITHOUT exits set keeps the old behaviour: nothing but the leader closes it.
  setup({ priceSol: 0.001 });
  save({ delayMs: 0 });
  copy.onWalletTrade(trade({ signature: 'cx2' }));
  await sleep(30);
  copy.markToMarket(MINT, 0.0001);
  copy.markToMarket(MINT, 0.01, undefined, Date.now() + 600 * 60_000);
  await sleep(40);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'a copy has no exits of its own unless asked');
  assert.deepEqual(ownExitsOf(cfg()), { takeProfitPct: null, stopLossPct: null, maxHoldMin: null, trailingPct: null });
});

test('fomo: a paused config hears nothing, and a source the host cannot answer is an empty crowd', async () => {
  setupCrowd();
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0, enabled: false });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(40);
  assert.equal(copy.snapshot().recent.length, 0, 'paused: no entry');
  assert.equal(copy.crowdWants('solana', CROWD[0]), false, 'and the engine is told not to bother');
  // No scoutSaved on the host at all.
  setup({ priceSol: 0.001 });
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 2, fomoWindowSec: 60, delayMs: 0 });
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(40);
  assert.equal(copy.snapshot().recent.length, 0, 'an unanswerable source never fires');
  assert.equal(copy.snapshot().crowd?.[copy.all()[0].id]?.wallets, 0, 'and the snapshot says the crowd is empty');
});

test('fomo: live entries buy through the host once and the crowd exit sells 100 % through it', async () => {
  const h = setupCrowd();
  saveFomo({ fomoSource: 'saved', fomoMinWallets: 2, fomoWindowSec: 60, mode: 'live', delayMs: 0, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  const t0 = Date.now();
  crowdBuy(0, { at: t0 });
  crowdBuy(1, { at: t0 + 1_000 });
  await sleep(80);
  assert.equal(h.calls.buys.length, 1, 'the crowd bought once through the host');
  assert.equal(h.calls.buys[0].sol, 0.05);
  assert.ok(h.calls.toasts.some((t) => /^Converged /.test(t.message)), 'and said so as a convergence buy');
  copy.noteCrowdTrade(trade({ wallet: CROWD[0], isBuy: false, sol: 0.5, priceSol: 0.0012, soldFraction: 1, at: t0 + 10_000 }));
  await sleep(80);
  assert.equal(h.calls.sells.length, 1, '1 of 2 is 50 %: the crowd exit sold for real');
  assert.equal(h.calls.sells[0].pct, 100);
});

test('fomo: validation, defaults, the snapshot and the description', () => {
  assert.equal(validateConfig(fomoCfg()).ok, true);
  assert.equal(validateConfig(fomoCfg({ chain: 'bnb' })).ok, false, 'Solana only');
  assert.equal(validateConfig(fomoCfg({ wallet: WALLET })).ok, false, 'a crowd is not an address');
  assert.equal(validateConfig(fomoCfg({ fomoMinWallets: 1 })).ok, false, 'one wallet is a copy, not a crowd');
  assert.equal(validateConfig(fomoCfg({ fomoMinWallets: 51 })).ok, false);
  assert.equal(validateConfig(fomoCfg({ fomoWindowSec: 5 })).ok, false);
  assert.equal(validateConfig(fomoCfg({ fomoTopN: 1 })).ok, false);
  assert.equal(validateConfig(fomoCfg({ fomoCrowdExitPct: 0 })).ok, false);
  assert.equal(validateConfig(fomoCfg({ fomoSource: 'everyone' })).ok, false);
  // Convergence from a picked list or a board ranking (2026-10-28).
  assert.equal(validateConfig(fomoCfg({ fomoSource: 'list' })).ok, false, 'picked wallets need a list');
  assert.equal(validateConfig(fomoCfg({ fomoSource: 'list', fomoWallets: [CROWD[0]], fomoMinWallets: 2 })).ok, false, 'fewer wallets than the trigger needs');
  assert.equal(validateConfig(fomoCfg({ fomoSource: 'list', fomoWallets: CROWD.slice(0, 2), fomoMinWallets: 2 })).ok, true);
  assert.equal(validateConfig(fomoCfg({ fomoTopSort: 'bestest' })).ok, false, 'the top list is ranked by a board sort');
  assert.equal(validateConfig(fomoCfg({ fomoTopSort: 'fSumPct' })).ok, true);
  assert.equal(defaultConfig('', 'x', 'solana', 'fomo').fomoTopSort, 'copyScore', 'the top crowd keeps its old ranking unless told otherwise');
  assert.equal(crowdNoun(fomoCfg({ fomoSource: 'top', fomoTopSort: 'fSumPct' })), 'the top 25 Scout wallets by Week total, copied');
  assert.equal(crowdNoun(fomoCfg({ fomoSource: 'list', fomoWallets: CROWD.slice(0, 3) })), 'the 3 wallets you picked');
  const d = defaultConfig('', 'x', 'solana', 'fomo');
  assert.equal(d.direction, 'fomo');
  assert.equal(d.wallet, FOMO_WALLET);
  assert.equal(d.mode, 'paper', 'FOMO starts on paper like everything else');
  assert.equal(d.enabled, false);
  assert.deepEqual([d.fomoSource, d.fomoMinWallets, d.fomoWindowSec, d.fomoTopN, d.fomoCrowdExitPct], ['followed', 3, 180, 25, 50]);
  assert.deepEqual(ownExitsOf(d), { takeProfitPct: 25, stopLossPct: 20, maxHoldMin: 30, trailingPct: null });
  assert.match(describeConfig({ ...fomoCfg(), id: 'f', createdAt: 0 }), /^Paper convergence Crowd: buy when 3 of followed wallets buy the same coin within 180 s.*\+25%.*−20%.*30 min or when 50% of them have sold/);
  setupCrowd();
  saveFomo({ fomoSource: 'saved' });
  const snap = copy.snapshot();
  const id = copy.all()[0].id;
  assert.deepEqual(snap.crowd?.[id], { source: 'saved', wallets: 3 }, 'the snapshot tells the page how big the crowd is');
});

// ── Copy Simple (2026-09-20) ──────────────────────────────────────────

test('copy simple: the address shape picks the chain, and nothing else passes', () => {
  assert.equal(chainForAddress(WALLET), 'solana');
  assert.equal(chainForAddress(`  ${WALLET}  `), 'solana', 'whitespace is forgiven');
  assert.equal(chainForAddress('0x' + 'ab'.repeat(20)), 'evm');
  assert.equal(chainForAddress('Whale111111111111111111111111111111111111'), null, 'a lowercase L is not base58');
  assert.equal(chainForAddress('0x1234'), null);
  assert.equal(chainForAddress(''), null);
});

// ── Guardrails across follows (2026-10-23) ───────────────────────────────
//
// A bot left running needs limits the per-follow ones never had: a cap on
// open copies across every follow, a per-wallet stop, a pause after failed
// copies, and a person told when any of it happens. Each blocks ENTRIES
// only; exits go on.

const walletN = (i) => `Whae${i + 2}${'1'.repeat(36)}`;

test('per-wallet stop: a follow that has lost past its stop pauses itself, says why, and a switch back on starts the count again', async () => {
  const notes = [];
  const h = setup({ priceSol: 0.001, host: { notify: (title, body) => notes.push({ title, body }) } });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, dailyLossLimitSol: 10, walletLossStopSol: 0.5 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.00025, soldFraction: 1, signature: 's1' }));
  await tick();
  // Judged on the clock, not only at the next buy.
  copy.checkMaxHolds();
  let c = copy.all()[0];
  assert.equal(c.enabled, false, 'paused');
  assert.match(c.pausedReason, /past its 0\.5 stop/);
  assert.ok(c.pausedAt > 0);
  assert.equal(notes.length, 1, 'the user is told');
  assert.match(notes[0].title, /paused/);
  // Paused: the next buy is not copied.
  copy.onWalletTrade(trade({ isBuy: true, mint: 'Other111111111111111111111111111111111111', signature: 'b2' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 0, 'no new copy while paused');
  // The user switches it back on: the old losses are not counted again.
  copy.upsert({ ...copy.all()[0], enabled: true });
  c = copy.all()[0];
  assert.equal(c.enabled, true);
  assert.equal(c.pausedReason, null, 'the pause is over');
  assert.ok(c.lossStopFrom >= c.pausedAt, 'the stop counts from now');
  copy.onWalletTrade(trade({ isBuy: true, mint: 'Again111111111111111111111111111111111111', signature: 'b3' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 1, 'copying again');
  assert.equal(h.calls.buys.length, 0, 'paper all the way');
});

test('three failed live copies in a row pause the follow; one that lands resets the count', async () => {
  const notes = [];
  const h = setup({ priceSol: 0.001, buyResult: { ok: false, message: 'Simulation failed: insufficient funds' }, host: { notify: (title) => notes.push(title) } });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const mintN = (i) => `Fai${i + 2}${'1'.repeat(37)}`;
  for (let i = 0; i < 2; i++) {
    copy.onWalletTrade(trade({ isBuy: true, mint: mintN(i), signature: `f${i}` }));
    await tick();
  }
  assert.equal(copy.all()[0].enabled, true, 'two failures do not pause');
  assert.equal(notes.length, 0, 'and a single failure is a toast, not a notification');
  copy.onWalletTrade(trade({ isBuy: true, mint: mintN(2), signature: 'f2' }));
  await tick();
  const c = copy.all()[0];
  assert.equal(c.enabled, false, 'the third pauses it');
  assert.match(c.pausedReason, /3 copies in a row failed/);
  assert.match(c.pausedReason, /insufficient funds/, 'with the last reason');
  assert.equal(notes.length, 1);
  copy.onWalletTrade(trade({ isBuy: true, mint: mintN(3), signature: 'f3' }));
  await tick();
  assert.equal(h.calls.buys.length, 3, 'no fourth try');
  assert.equal(h.calls.sells.length, 0, 'a pause never sells anything');
});

// What liveSigner says when a coin sits between pump's curve and its pool
// (synthetic migration, 10-07): the curve is complete, the pool not open.
const MIGRATING =
  'Bad Request | local build: bonding curve is complete (graduated) — not a curve trade | PumpSwap: no PumpSwap pool for this mint — not a graduated pump coin | jupiter: no routes found';

test('a buy refused because the coin is migrating to PumpSwap is a skip, and never counts toward the failure pause', async () => {
  const h = setup({ priceSol: 0.001, buyResult: { ok: false, message: MIGRATING } });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const mintN = (i) => `Mig${i + 2}${'1'.repeat(37)}`;
  for (let i = 0; i < 4; i++) {
    copy.onWalletTrade(trade({ isBuy: true, mint: mintN(i), signature: `m${i}` }));
    await tick();
  }
  assert.equal(h.calls.buys.length, 4);
  assert.equal(copy.all()[0].enabled, true, 'four migrations in a row are not a broken route');
  const rows = copy.snapshot().recent;
  assert.ok(rows.every((r) => /moving from pump’s curve to PumpSwap/.test(r.reason ?? '')), 'each says why');
  assert.ok(!h.calls.toasts.some((t) => t.level === 'error'), 'and none is shown as a failure');
  // The real anchor reason from a simulation counts the same.
  h.host.buy = async () => ({ ok: false, message: 'Simulation reverted: Error Code: BondingCurveComplete. {"InstructionError":[3,{"Custom":6005}]}' });
  for (let i = 4; i < 7; i++) {
    copy.onWalletTrade(trade({ isBuy: true, mint: mintN(i), signature: `m${i}` }));
    await tick();
  }
  assert.equal(copy.all()[0].enabled, true);
});

test('LIVE: a sell refused mid-migration is held for the pool, tried again on the clock, and lands', async () => {
  const h = await openLiveCopy({ sellResult: { ok: false, message: MIGRATING } });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 0.3, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  const waiting = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.match(waiting.reason, /^waiting — .*PumpSwap/);
  assert.ok(!h.calls.toasts.some((t) => t.level === 'error'), 'not a failed sell');
  const t0 = Date.now();
  copy.checkMaxHolds(t0 + 5_000);
  await tick();
  assert.equal(h.calls.sells.length, 1, 'nothing is sent inside the retry interval');
  copy.checkMaxHolds(t0 + 16_000);
  await tick();
  assert.equal(h.calls.sells.length, 2, 'tried again on the clock');
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 1, 'still migrating: held again, no second row');
  // The pool opens.
  h.host.sell = async (mint, pct) => {
    h.calls.sells.push({ mint, pct });
    return { ok: true, message: 'sold', signature: 'poolsell' };
  };
  copy.checkMaxHolds(t0 + 32_000);
  await tick();
  assert.deepEqual(h.calls.sells[2], { mint: MINT, pct: 30 }, 'the share the leader sold');
  const snap = copy.snapshot();
  const exits = snap.recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].state, 'closed');
  assert.equal(exits[0].signature, 'poolsell');
  assert.ok(!exits.some((t) => /^waiting/.test(t.reason ?? '')), 'the waiting row is withdrawn once the sell lands');
  assert.equal(snap.recent.find((t) => t.kind !== 'exit').remainingPct, 70);
  copy.checkMaxHolds(t0 + 60_000);
  await tick();
  assert.equal(h.calls.sells.length, 3, 'and it is never sold twice');
});

test('LIVE: a sell still migrating after ten minutes is given up loudly; the copy stays open', async () => {
  const notes = [];
  const h = await openLiveCopy({ sellResult: { ok: false, message: MIGRATING }, host: { notify: (title, body) => notes.push({ title, body }) } });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'sell1' }));
  await tick();
  copy.checkMaxHolds(Date.now() + 10 * 60_000 + 1_000);
  await tick();
  assert.equal(h.calls.sells.length, 1, 'given up, not tried once more');
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.match(snap.recent.find((t) => t.kind === 'exit').reason, /still moving to PumpSwap after 10 minutes/);
  assert.ok(notes.some((n) => /Copy sell failed/.test(n.title)));
  copy.checkMaxHolds(Date.now() + 20 * 60_000);
  await tick();
  assert.equal(h.calls.sells.length, 1);
});

test('a failed copy followed by one that lands starts the streak again', async () => {
  let fail = true;
  const h = setup({ priceSol: 0.001 });
  h.host.buy = async (mint, sol) => {
    h.calls.buys.push({ mint, sol });
    return fail ? { ok: false, message: 'route failed' } : { ok: true, message: 'bought', signature: `ok${h.calls.buys.length}` };
  };
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const mintN = (i) => `Mix${i + 2}${'1'.repeat(37)}`;
  const outcomes = [true, true, false, true, true];
  for (let i = 0; i < outcomes.length; i++) {
    fail = outcomes[i];
    copy.onWalletTrade(trade({ isBuy: true, mint: mintN(i), signature: `m${i}` }));
    await tick();
  }
  assert.equal(copy.all()[0].enabled, true, 'fail, fail, land, fail, fail: never three in a row');
  assert.equal(h.calls.buys.length, 5);
});

test('max open copies: the app-wide ceiling refuses a copy that would open one more, not one that adds to a held coin', async () => {
  setup({ priceSol: 0.001, host: { maxOpenCopies: () => 2 } });
  save({ sizing: 'fixed', sizeValue: 0.1, maxTradeSol: 1, delayMs: 0 });
  save({ wallet: walletN(0), sizing: 'fixed', sizeValue: 0.1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, mint: 'Open1111111111111111111111111111111111111', signature: 'o1' }));
  await tick();
  copy.onWalletTrade(trade({ wallet: walletN(0), isBuy: true, mint: 'Open2111111111111111111111111111111111111', signature: 'o2' }));
  await tick();
  // A third coin, on either follow: refused and recorded.
  copy.onWalletTrade(trade({ isBuy: true, mint: 'Open3111111111111111111111111111111111111', signature: 'o3' }));
  await tick();
  let recent = copy.snapshot().recent;
  const refused = recent.find((t) => t.mint === 'Open3111111111111111111111111111111111111');
  assert.equal(refused.state, 'skipped');
  assert.equal(refused.reason, 'limit: 2 copies open across all follows');
  // Adding to a coin this follow already holds opens nothing new.
  copy.onWalletTrade(trade({ isBuy: true, mint: 'Open1111111111111111111111111111111111111', signature: 'o4' }));
  await tick();
  recent = copy.snapshot().recent;
  assert.equal(recent.filter((t) => t.mint === 'Open1111111111111111111111111111111111111' && t.state === 'open').length, 2, 'the add went through');
  // An exit is never held back: the leader sells, the copy closes.
  copy.onWalletTrade(trade({ isBuy: false, mint: 'Open1111111111111111111111111111111111111', priceSol: 0.002, soldFraction: 1, signature: 'o5' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.mint === 'Open1111111111111111111111111111111111111' && t.state === 'open').length, 0);
  // With a slot free again, the next new coin copies.
  copy.onWalletTrade(trade({ isBuy: true, mint: 'Open6111111111111111111111111111111111111', signature: 'o6' }));
  await tick();
  assert.equal(copy.snapshot().recent.find((t) => t.mint === 'Open6111111111111111111111111111111111111').state, 'open');
});

test('alerts reach the user at most six an hour; the rest are logged', async () => {
  const notes = [];
  const logs = [];
  setup({ priceSol: 0.001, host: { notify: (title) => notes.push(title), log: (_l, line) => logs.push(line) } });
  for (let i = 0; i < 7; i++) {
    save({ wallet: walletN(i), sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, dailyLossLimitSol: 10, walletLossStopSol: 0.1 });
    copy.onWalletTrade(trade({ wallet: walletN(i), isBuy: true, mint: `Cap${i + 2}${'1'.repeat(37)}`, signature: `cb${i}` }));
    await tick();
    copy.onWalletTrade(trade({ wallet: walletN(i), isBuy: false, mint: `Cap${i + 2}${'1'.repeat(37)}`, priceSol: 0.0005, soldFraction: 1, signature: `cs${i}` }));
    await tick();
  }
  copy.checkMaxHolds();
  assert.equal(copy.all().filter((c) => !c.enabled).length, 7, 'all seven paused');
  assert.equal(notes.length, 6, 'six notifications');
  assert.ok(logs.some((l) => /copy alert not sent/.test(l)), 'the seventh is logged');
});

test('copy simple: three answers make a valid, paper, switched-on config with derived limits', () => {
  for (const size of SIMPLE_SIZES) {
    const c = simpleConfig(WALLET, 'Whale', 'solana', size);
    assert.equal(validateConfig(c).ok, true, `size ${size} validates`);
    assert.equal(c.mode, 'paper');
    assert.equal(c.enabled, true, 'a paper follow has nothing to arm');
    assert.equal(c.direction, 'copy');
    assert.equal(c.sizing, 'fixed');
    assert.equal(c.sizeValue, size);
    assert.equal(c.maxTradeSol, size, 'the cap is the size');
    assert.ok(Math.abs(c.dailyLossLimitSol - Math.round(size * 3 * 1000) / 1000) < 1e-9, 'three trades of loss a day (was ten until 2026-10-23)');
    assert.ok(Math.abs(c.walletLossStopSol - Math.round(size * 4 * 1000) / 1000) < 1e-9, 'and the follow pauses itself after four');
    assert.equal(c.copySells, true);
    assert.equal(c.exitMaxHoldMin, 30, 'the missed-sell backstop');
    assert.equal(ownExitsOf(c).maxHoldMin, 30);
    assert.equal(ownExitsOf(c).takeProfitPct, null, 'and no other exit of its own');
    assert.equal(c.minLeaderSellPct, 50, 'trims under half their bag are skipped at every size (2026-10-25)');
  }
  const evm = simpleConfig('0x' + 'ab'.repeat(20), '', 'bnb', 0.1);
  assert.equal(validateConfig(evm).ok, true);
  assert.equal(evm.chain, 'bnb');
  // Clamps: too much goes to the page's ceiling, nonsense to the second offered size.
  assert.equal(simpleConfig(WALLET, '', 'solana', 40).sizeValue, SIMPLE_MAX_SOL);
  assert.equal(simpleConfig(WALLET, '', 'solana', NaN).sizeValue, SIMPLE_SIZES[1]);
  assert.equal(simpleConfig(WALLET, '', 'solana', -1).sizeValue, SIMPLE_SIZES[1]);
  assert.equal(simpleConfig(WALLET, '', 'solana', 0.0001).sizeValue, 0.001);
  assert.equal(validateConfig(simpleConfig(WALLET, '', 'solana', 40)).ok, true, 'the clamped config still validates');
  // Everything the simple page did not ask is the ordinary default.
  const d = defaultConfig(WALLET, 'Whale');
  const c = simpleConfig(WALLET, 'Whale', 'solana', 0.1);
  for (const k of ['delayMs', 'maxSlippagePct', 'minLiquidityUsd', 'onlyPumpfun', 'dailyTradeLimit']) assert.deepEqual(c[k], d[k], `${k} is the default`);
});

test('the Follow page: a percentage of their trade, capped, with limits from the cap', () => {
  const c = followConfig(WALLET, 'Whale', 'solana', 'proportional', 25, 0.2);
  assert.equal(validateConfig(c).ok, true);
  assert.equal(c.sizing, 'proportional');
  assert.equal(c.sizeValue, 25);
  assert.equal(c.maxTradeSol, 0.2, 'the cap is the most one copy spends');
  assert.ok(Math.abs(c.dailyLossLimitSol - 0.6) < 1e-9, 'three caps a day');
  assert.ok(Math.abs(c.walletLossStopSol - 0.8) < 1e-9);
  assert.equal(c.mode, 'paper');
  assert.equal(c.enabled, true);
  assert.equal(c.minLeaderSellPct, 50, 'trims under half their bag are skipped at every size');
  assert.equal(copySize(c, 0.4), 0.1, '25 % of their 0.4');
  assert.equal(copySize(c, 4), 0.2, 'never over the cap');
  // Their buys too small for a live copy are skipped, on paper as on live.
  assert.equal(c.minLeaderSol, minLeaderFor(25));
  assert.ok(copySize(c, c.minLeaderSol) >= MIN_LIVE_COPY_SOL - 1e-12, 'the smallest buy it follows copies at the live minimum or more');
  assert.ok(copySize(c, c.minLeaderSol - 0.001) < MIN_LIVE_COPY_SOL, 'and one just under it would not');
  assert.equal(followConfig('0x' + 'ab'.repeat(20), '', 'bnb', 'proportional', 25, 0.2).minLeaderSol, null, 'the SOL floor is Solana’s');
  // Fixed through the page: up to the editor's ceiling, not the old wizard's 5.
  const f = followConfig(WALLET, '', 'solana', 'fixed', 8);
  assert.equal(f.sizeValue, 8);
  assert.equal(f.maxTradeSol, 8);
  assert.equal(f.minLeaderSol, null);
  assert.equal(validateConfig(f).ok, true);
  assert.equal(followConfig(WALLET, '', 'solana', 'fixed', 400).sizeValue, FOLLOW_MAX_SOL);
  // Nonsense falls back, never to zero.
  const n = followConfig(WALLET, '', 'solana', 'proportional', NaN, NaN);
  assert.equal(n.sizeValue, FOLLOW_PCTS[1]);
  assert.equal(n.maxTradeSol, SIMPLE_SIZES[1]);
  assert.equal(followConfig(WALLET, '', 'solana', 'proportional', 900, 1).sizeValue, 500, 'validateConfig’s 500 % ceiling');
});

// ── The 2026-09-21 filters ────────────────────────────────────────────
//
// Each is a control every competitor ships and this app lacked
// (docs/copy-trade-competitors-2026-09-21.md). Each is a REFUSAL recorded
// as a skip, failing closed on a fact the host cannot read — the same rule
// the older three filters follow — and absent means off, so a config saved
// before this day behaves exactly as it did.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MINT_B = 'CopyMintB11111111111111111111111111111111';
const MINT_C = 'CopyMintC11111111111111111111111111111111';
const FACTS = { liquidityUsd: 50_000, marketCapUsd: 100_000, kryptScore: 80, isPumpfun: true };

test('filters 2026-09-21: bounds validate, absent is off, helpers behave', () => {
  assert.equal(validateConfig(cfg()).ok, true);
  assert.equal(validateConfig(cfg({ minLeaderSol: 5, maxLeaderSol: 1 })).ok, false, 'an empty size band');
  assert.equal(validateConfig(cfg({ minTokenAgeSec: 600, maxTokenAgeSec: 60 })).ok, false, 'an empty age band');
  assert.equal(validateConfig(cfg({ maxBuysPerToken: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ maxBuysPerToken: 1.5 })).ok, false, 'whole numbers only');
  assert.equal(validateConfig(cfg({ exitTrailingPct: 100 })).ok, false);
  assert.equal(validateConfig(cfg({ minLeaderSellPct: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ minMarketCapUsd: 10_000, maxMarketCapUsd: 5_000 })).ok, false, 'min above max');
  assert.equal(validateConfig(cfg({ blockedMints: [''] })).ok, false);
  assert.equal(
    validateConfig(
      cfg({ minLeaderSol: 0.5, maxLeaderSol: 5, minTokenAgeSec: 60, maxTokenAgeSec: 600, maxBuysPerToken: 1, exitTrailingPct: 20, minLeaderSellPct: 10, minMarketCapUsd: 1_000, blockedMints: [MINT], blockedCreators: ['Dev111'] }),
    ).ok,
    true,
  );
  const d = defaultConfig(WALLET, 'x');
  for (const k of ['minMarketCapUsd', 'minLeaderSol', 'maxLeaderSol', 'minTokenAgeSec', 'maxTokenAgeSec', 'maxBuysPerToken', 'blockedMints', 'blockedCreators', 'minLeaderSellPct', 'exitTrailingPct']) {
    assert.equal(d[k], null, `${k} defaults to off`);
  }
  assert.deepEqual(cleanBlocklist([' a ', 'a', '', 7, 'b']), ['a', 'b'], 'trimmed, deduped, non-strings dropped');
  assert.equal(cleanBlocklist([]), null, 'nothing left is off, not an empty rule');
  assert.equal(isBlocked(['0xABC'], '0xabc'), true, 'EVM spelling is case-insensitive');
  assert.equal(isBlocked(null, MINT), false);
  assert.equal(ownExitsOf({ direction: 'reverse' }).trailingPct, null, 'a trailing stop is never defaulted, on any direction');
  assert.equal(ownExitsOf({ direction: 'copy', exitTrailingPct: 15 }).trailingPct, 15);
});

test('their trade size band refuses buys outside it and names the side', async () => {
  setup();
  save({ minLeaderSol: 0.5, maxLeaderSol: 5 });
  copy.onWalletTrade(trade({ sol: 0.1 }));
  copy.onWalletTrade(trade({ sol: 50, mint: MINT_B }));
  copy.onWalletTrade(trade({ sol: 1, mint: MINT_C }));
  await wait(40);
  const rows = copy.snapshot().recent;
  assert.match(rows.find((r) => r.mint === MINT).reason, /under your 0.5 minimum/);
  assert.match(rows.find((r) => r.mint === MINT_B).reason, /over your 5 maximum/);
  assert.equal(rows.find((r) => r.mint === MINT_C).state, 'open', 'inside the band copies');
});

test('buy once: a second entry on the same token is refused; a skip never counts as an entry', async () => {
  setup();
  save({ maxBuysPerToken: 1 });
  copy.onWalletTrade(trade({ isBuy: true }));
  await wait(30);
  copy.onWalletTrade(trade({ isBuy: false, soldFraction: 1 }));
  await wait(30);
  copy.onWalletTrade(trade({ isBuy: true }));
  await wait(30);
  const rows = copy.snapshot().recent.filter((r) => r.kind !== 'exit');
  const skipped = rows.filter((r) => r.state === 'skipped');
  assert.equal(skipped.length, 1, 'the second buy was refused');
  assert.match(skipped[0].reason, /already bought this token once/);
  // A third try is still refused — the skip did not count as an entry, but
  // the closed one still does: bought once means once.
  copy.onWalletTrade(trade({ isBuy: true }));
  await wait(30);
  assert.equal(copy.snapshot().recent.filter((r) => r.kind !== 'exit' && r.state === 'skipped').length, 2);
});

test('token age band fails closed without a launch time and refuses outside it', async () => {
  setup({ facts: { ...FACTS, createdAt: null } });
  save({ minTokenAgeSec: 60 });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /token age unknown/, 'unknown is a refusal, never a pass');

  setup({ facts: { ...FACTS, createdAt: Date.now() - 10_000 } });
  save({ minTokenAgeSec: 60 });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /under your 60 s minimum/);

  setup({ facts: { ...FACTS, createdAt: Date.now() - 3_600_000 } });
  save({ maxTokenAgeSec: 600 });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /over your 600 s maximum/);

  setup({ facts: { ...FACTS, createdAt: Date.now() - 120_000 } });
  save({ minTokenAgeSec: 60, maxTokenAgeSec: 600 });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.equal(copy.snapshot().recent[0].state, 'open', 'inside the band copies');
});

test('a minimum market cap refuses under it and fails closed when unknown', async () => {
  setup({ facts: { ...FACTS, marketCapUsd: 8_000 } });
  save({ minMarketCapUsd: 10_000 });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /market cap below \$10,000/);
  setup({ facts: { ...FACTS, marketCapUsd: null } });
  save({ minMarketCapUsd: 10_000 });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /market cap unknown/);
});

test('blocked mints and creators are refused; an unknown creator fails closed', async () => {
  setup({ facts: { ...FACTS, creator: 'Dev111' } });
  save({ blockedMints: [MINT] });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /token is on your blocklist/);

  setup({ facts: { ...FACTS, creator: 'Dev111' } });
  save({ blockedCreators: ['Dev111'] });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /creator is on your blocklist/);

  setup({ facts: { ...FACTS } });
  save({ blockedCreators: ['Dev111'] });
  copy.onWalletTrade(trade());
  await wait(30);
  assert.match(copy.snapshot().recent[0].reason, /creator unknown/, 'no creator on file is a refusal while the list is set');
});

test('a leader trim under the mirror threshold is recorded, not mirrored; over it mirrors', async () => {
  setup({ priceSol: 0.001 });
  save({ minLeaderSellPct: 10 });
  copy.onWalletTrade(trade({ isBuy: true }));
  await wait(30);
  copy.onWalletTrade(trade({ isBuy: false, soldFraction: 0.05 }));
  await wait(30);
  let rows = copy.snapshot().recent;
  const skip = rows.find((r) => r.kind === 'exit');
  assert.ok(skip, 'the refused trim is on the record');
  assert.equal(skip.state, 'skipped');
  assert.match(skip.reason, /sold 5% of their bag, under your 10% threshold/);
  assert.equal(rows.find((r) => r.kind !== 'exit').state, 'open', 'the copy stays open');
  copy.onWalletTrade(trade({ isBuy: false, soldFraction: 0.5 }));
  await wait(30);
  rows = copy.snapshot().recent;
  assert.ok(rows.some((r) => r.kind === 'exit' && r.state !== 'skipped'), 'a sell over the threshold is mirrored');
});

test('a trailing stop exits from the peak, and is armed from entry', async () => {
  setup({ priceSol: 0.001 });
  save({ exitTrailingPct: 20 });
  copy.onWalletTrade(trade({ isBuy: true }));
  await wait(30);
  copy.markToMarket(MINT, 0.002);
  copy.markToMarket(MINT, 0.0017);
  await wait(30);
  assert.equal(copy.snapshot().recent.find((r) => r.kind !== 'exit').state, 'open', '15 % off the peak holds');
  copy.markToMarket(MINT, 0.0015);
  await wait(40);
  const exit = copy.snapshot().recent.find((r) => r.kind === 'exit');
  assert.ok(exit, '25 % off the peak books an exit');
  assert.match(exit.reason, /trailing stop −20% from peak/);

  setup({ priceSol: 0.001 });
  save({ exitTrailingPct: 20 });
  copy.onWalletTrade(trade({ isBuy: true }));
  await wait(30);
  copy.markToMarket(MINT, 0.00079);
  await wait(40);
  assert.match(copy.snapshot().recent.find((r) => r.kind === 'exit').reason, /trailing stop/, 'a position that only fell stops at −20 % from its entry');
});

// ── One leader sell is one mirrored sell (2026-10-22) ─────────────────
//
// The pump rail delivers a sell twice: the firehose first, with the token
// count but no fraction, and the wallet watcher second, with the fraction.
// The copier recovered the fraction from the leader's balance and sold it —
// and then let the watcher's delivery through as an "upgrade" and sold it
// AGAIN. A 40 % trim became 40 % then 40 % of the rest: 64 %.

test('a sell recovered from the firehose is not mirrored again when the watcher delivers it', async () => {
  // They held 1,000, sold 400, hold 600: the recovered fraction is 40 %.
  setup({ priceSol: 0.001, leaderHolding: 600 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'dm-b' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, tokens: 400, signature: 'dm-s' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, tokens: 400, soldFraction: 0.4, signature: 'dm-s' }));
  await tick();
  const rows = copy.snapshot().recent;
  assert.equal(rows.filter((t) => t.kind === 'exit').length, 1, 'one transaction, one exit');
  assert.equal(rows.find((t) => t.kind !== 'exit').remainingPct, 60, '40 % sold, not 64 %');
});

test('LIVE: the watcher’s second delivery of a recovered sell places no second order', async () => {
  const h = setup({ priceSol: 0.001, leaderHolding: 600 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'dm-b' }));
  await tick();
  // Both deliveries in the same breath, as they arrive on the pump rail:
  // the second is queued behind the first while it recovers the fraction.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, tokens: 400, signature: 'dm-s' }));
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, tokens: 400, soldFraction: 0.4, signature: 'dm-s' }));
  await tick();
  await tick();
  assert.equal(h.calls.sells.length, 1, `one sell order, got ${h.calls.sells.length}`);
  assert.equal(h.calls.sells[0].pct, 40);
});

test('an unreadable first delivery is still superseded by the watcher’s, exactly once', async () => {
  // No balance reader: the firehose's sell cannot be sized and is recorded
  // as not executed. The watcher's copy WITH the fraction is the one that
  // acts — and only it.
  setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'dm-b2' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, tokens: 400, signature: 'dm-s2' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'dm-s2' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'dm-s2' }));
  await tick();
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1, 'the skip was withdrawn and one exit stands');
  assert.equal(exits[0].state, 'closed');
});

// ── A paused config still follows its open copies out (2026-10-22) ────
//
// A live config comes back from every restart disarmed, and `enabled` used
// to gate the watch list, the router and the own exits — so after any
// restart nothing managed the open live copies, while the card said they
// "close on their own when this wallet sells". Pausing is about ENTRIES.

const loadedConfig = (over = {}) => ({ ...defaultConfig(WALLET, 'Sharky'), id: 'cfgR', createdAt: 1, enabled: false, mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, ...over });
const loadedRow = (over = {}) => ({
  id: 'rowR', configId: 'cfgR', mode: 'live', chain: 'solana', wallet: WALLET, mint: MINT, symbol: 'COPY', at: Date.now() - 2 * 3_600_000,
  theirSol: 1, ourSol: 1, entryPriceSol: 0.001, exitPriceSol: null, closedAt: null, pnlSol: null, state: 'open', reason: null, signature: 'oldbuy', ...over,
});

test('after a restart a disarmed LIVE config still mirrors its leader’s sell — and copies no buy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-exits-'));
  copy._reset();
  copy.init(dir);
  const h1 = makeHost({ priceSol: 0.001 });
  copy.attach(h1.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'rx-b' }));
  await tick();
  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001 });
  copy.attach(h2.host);
  assert.equal(copy.all()[0].enabled, false, 'the restart disarmed it');
  assert.ok(copy.activeWallets('solana').has(WALLET), 'but its leader is still watched: it holds a copy');
  copy.onWalletTrade(trade({ isBuy: true, mint: 'NewMint11111111111111111111111111111111111', signature: 'rx-b2' }));
  await tick();
  assert.equal(h2.calls.buys.length, 0, 'no new entry while paused');
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'rx-s' }));
  await tick();
  assert.equal(h2.calls.sells.length, 1, 'the leader sold, so the copy sold');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit' && t.mint === MINT).state, 'closed');
  assert.ok(!copy.activeWallets('solana').has(WALLET), 'nothing open, nothing to watch for a paused config');
});

test('a paused config with nothing open is not watched, and its stats say what it still manages', () => {
  setup();
  copy._load([loadedConfig()], [loadedRow({ state: 'closed', closedAt: Date.now() })]);
  assert.equal(copy.activeWallets().size, 0);
  copy._load([loadedConfig()], [loadedRow()]);
  assert.ok(copy.activeWallets().has(WALLET));
  assert.equal(copy.snapshot().stats.cfgR.openAllModes, 1);
});

test('a trailing stop carried across a restart starts again from the first price seen, not the old peak', async () => {
  setup({ priceSol: 0.0015 });
  copy._load([loadedConfig({ mode: 'paper', exitTrailingPct: 20 })], [loadedRow({ mode: 'paper', peakPriceSol: undefined })]);
  copy._setBootAt(Date.now());
  // Before the restart it peaked at 0.002 — a high nobody watched now. The
  // first tick (0.0015) is 25 % under it and must NOT fire.
  copy.markToMarket(MINT, 0.0015);
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'a peak from the unwatched window does not fire it');
  copy.markToMarket(MINT, 0.0019);
  copy.markToMarket(MINT, 0.0015);
  await tick();
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(exit, '21 % off the peak seen since the restart does');
  assert.match(exit.reason, /trailing stop/);
});

test('init forgets an open copy’s old trailing peak', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-peak-'));
  fs.writeFileSync(
    path.join(dir, 'copytrade.json'),
    JSON.stringify({ version: 1, configs: [loadedConfig({ mode: 'paper', enabled: true, exitTrailingPct: 20 })], trades: [loadedRow({ mode: 'paper', peakPriceSol: 0.002 })] }),
  );
  copy._reset();
  copy.init(dir);
  copy.attach(makeHost({ priceSol: 0.0015 }).host);
  assert.equal(copy.snapshot().recent[0].peakPriceSol, undefined);
  copy.markToMarket(MINT, 0.0015);
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0);
});

test('a max hold carried across a restart counts from the restart, not from the buy', async () => {
  setup({ priceSol: 0.001 });
  // Bought two hours ago, max hold 60 min: it ran out while the app was shut.
  copy._load([loadedConfig({ mode: 'paper', exitMaxHoldMin: 60 })], [loadedRow({ mode: 'paper' })]);
  const boot = Date.now();
  copy._setBootAt(boot);
  copy.markToMarket(MINT, 0.001, undefined, boot + 1_000);
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'not dumped at boot');
  copy.markToMarket(MINT, 0.001, undefined, boot + 61 * 60_000);
  await tick();
  assert.match(copy.snapshot().recent.find((t) => t.kind === 'exit').reason, /max hold 60 min/, 'an hour after the restart, it goes');
});

test('own exits run on a paused config that still holds a copy', async () => {
  const h = setup({ priceSol: 0.001 });
  copy._load([loadedConfig({ exitTakeProfitPct: 50 })], [loadedRow({ at: Date.now() })]);
  copy.markToMarket(MINT, 0.0016);
  await tick();
  assert.equal(h.calls.sells.length, 1, 'its take-profit sold, paused or not');
});

test('the boot check records a leader who left while the app was closed — and sells nothing', async () => {
  const h = setup({ priceSol: 0.001, leaderHolding: 0 });
  copy._load([loadedConfig()], [loadedRow()]);
  copy._setBootAt(Date.now());
  const r = await copy.checkLeadersAfterBoot();
  assert.deepEqual(r, { checked: 1, gone: 1 });
  assert.equal(h.calls.sells.length, 0, 'when they sold is unknown: nothing is traded on it');
  const skip = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(skip.state, 'skipped');
  assert.match(skip.reason, /no longer holds this/);
  assert.ok(h.calls.toasts.some((t) => t.level === 'error'), 'a live copy says so loudly');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open', 'you still hold it');
});

test('the boot check reads nothing into a balance it could not read, or one still held', async () => {
  for (const held of [null, 250]) {
    setup({ priceSol: 0.001, leaderHolding: held });
    copy._load([loadedConfig()], [loadedRow()]);
    copy._setBootAt(Date.now());
    const r = await copy.checkLeadersAfterBoot();
    assert.equal(r.gone, 0, `holding ${held}`);
    assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0);
  }
  // A copy opened THIS session was watched the whole time: not asked about.
  const h = setup({ priceSol: 0.001, leaderHolding: 0 });
  copy._load([loadedConfig()], [loadedRow({ at: Date.now() })]);
  copy._setBootAt(Date.now() - 60_000);
  assert.equal((await copy.checkLeadersAfterBoot()).checked, 0);
  assert.equal(h.calls.holdingReads.length, 0);
});

// ── 2026-10-28: the competitor features the copier lacked ──────────────
//
// Watch-only, trading hours, one position per coin, the dev-sell and
// migration exits, and following the leader out of a coin they left without
// a SOL sale (docs/copy-trade-competitors-2026-09-21.md §5, items 2, 3, 4, 6).

test('2026-10-28 config: watch direction, dev-sell share, trading hours validate; every new rule defaults off', () => {
  assert.equal(validateConfig(cfg({ direction: 'watch' })).ok, true);
  assert.equal(validateConfig(cfg({ direction: 'watch', mode: 'live' })).ok, false, 'a watch cannot be live');
  assert.equal(validateConfig(cfg({ exitOnCreatorSellPct: 150 })).ok, false);
  assert.equal(validateConfig(cfg({ exitOnCreatorSellPct: 0 })).ok, true, '0 = any creator sell');
  assert.equal(validateConfig(cfg({ activeFromMin: 540, activeToMin: null })).ok, false, 'both ends or neither');
  assert.equal(validateConfig(cfg({ activeFromMin: 540, activeToMin: 540 })).ok, false, 'an empty window');
  assert.equal(validateConfig(cfg({ activeFromMin: 1500, activeToMin: 60 })).ok, false, 'a time of day');
  assert.equal(validateConfig(cfg({ activeFromMin: 22 * 60, activeToMin: 6 * 60 })).ok, true, 'wraps midnight');
  const d = defaultConfig(WALLET, 'x');
  assert.equal(d.exitOnCreatorSellPct, null);
  assert.equal(d.exitOnMigration, false);
  assert.equal(d.copyOtherExits, false);
  assert.equal(d.onePositionPerCoin, false);
  assert.equal(activeWindowOf(d), null);
  // The window: inclusive start, exclusive end, wrapping past midnight.
  assert.equal(inActiveWindow({ fromMin: 540, toMin: 1020 }, 540), true);
  assert.equal(inActiveWindow({ fromMin: 540, toMin: 1020 }, 1020), false);
  assert.equal(inActiveWindow({ fromMin: 1320, toMin: 360 }, 0), true);
  assert.equal(inActiveWindow({ fromMin: 1320, toMin: 360 }, 720), false);
  assert.equal(fmtClock(540), '09:00');
  assert.ok(isWatch({ direction: 'watch' }));
  assert.equal(ownExitsOf({ direction: 'watch' }).takeProfitPct, null, 'a watch has nothing to exit');
  assert.match(describeConfig({ ...cfg({ direction: 'watch' }), id: 'w', createdAt: 0 }), /^WATCH .*never trades/);
});

test('watch-only: their trades are told and recorded, never copied — and a paused watch is silent', async () => {
  const notes = [];
  const h = setup({ priceSol: 0.001, host: { notify: (title, body) => notes.push({ title, body }) } });
  save({ direction: 'watch', delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'wb1' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: true, signature: 'wb2', sol: 0.5 }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, signature: 'ws1', soldFraction: 0.4, sol: 0.3 }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, signature: 'ws2', soldFraction: 1, sol: 0.9 }));
  await tick();
  assert.equal(h.calls.buys.length, 0, 'never buys');
  assert.equal(h.calls.sells.length, 0, 'never sells');
  assert.equal(copy.snapshot().recent.length, 0, 'no copy rows, not even skips');
  assert.equal(notes.length, 4, 'one alert per trade');
  assert.match(notes[0].body, /^First buy: 1\.000 SOL of COPY/);
  assert.match(notes[1].body, /^Bought more: 0\.500 SOL/);
  assert.match(notes[2].body, /^Sold 40% of COPY for 0\.300 SOL/);
  assert.match(notes[3].body, /^Sold ALL of COPY/);
  assert.ok(notes.every((n) => /watch/.test(n.title)));
  assert.ok(h.calls.toasts.filter((t) => t.level === 'info').length >= 4, 'toasted too');
  const them = copy.snapshot().leaders[WALLET];
  assert.equal(them.buys, 2, 'their record is kept like any follow’s');
  assert.equal(them.sells, 2);
  assert.ok(copy.activeWallets('solana').has(WALLET), 'the engine watches the wallet');
  // Leaving the coin without a SOL sale is told too.
  copy.onLeaderOtherExit({ wallet: WALLET, mint: MINT, symbol: 'COPY', kind: 'transferOut', tokens: 10, signature: 'mv1', at: Date.now() });
  assert.equal(notes.length, 5);
  assert.match(notes[4].body, /sent it to another wallet \(COPY\)/);
  // Paused: silent, and not watched.
  copy.upsert({ ...copy.all()[0], enabled: false });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'wb3' }));
  await tick();
  assert.equal(notes.length, 5);
  assert.ok(!copy.activeWallets('solana').has(WALLET));
});

test('trading hours: an entry outside them is refused and recorded; inside, copied; exits ignore the clock', async () => {
  const nowMin = localMinuteOfDay();
  const outside = { activeFromMin: (nowMin + 120) % 1440, activeToMin: (nowMin + 240) % 1440 };
  const inside = { activeFromMin: (nowMin + 1440 - 120) % 1440, activeToMin: (nowMin + 120) % 1440 };
  setup({ priceSol: 0.001 });
  save({ delayMs: 0, ...outside });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'h1' }));
  await tick();
  const rows = copy.snapshot().recent;
  assert.equal(rows.length, 1, 'recorded, like any other filter');
  assert.equal(rows[0].state, 'skipped');
  assert.match(rows[0].reason, /^outside your trading hours \(\d\d:\d\d–\d\d:\d\d\)$/);
  // Inside: copied. Then the hours close and the leader sells: mirrored anyway.
  copy.upsert({ ...copy.all()[0], ...inside });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'h2', mint: MINT_B }));
  await tick();
  assert.ok(copy.snapshot().recent.some((t) => t.state === 'open' && t.mint === MINT_B), 'inside the hours it copies');
  copy.upsert({ ...copy.all()[0], ...outside });
  copy.onWalletTrade(trade({ isBuy: false, signature: 'h3', mint: MINT_B, soldFraction: 1 }));
  await tick();
  assert.ok(copy.snapshot().recent.some((t) => t.kind === 'exit' && t.state === 'closed' && t.mint === MINT_B), 'exits run around the clock');
});

test('one position per coin: a coin another follow holds, or is buying this instant, is not bought again', async () => {
  const W2 = 'Whae2222222222222222222222222222222222222';
  setup({ priceSol: 0.001 });
  save({ delayMs: 40, label: 'Sharky' });
  copy.upsert({ ...defaultConfig(W2, 'Two'), enabled: true, delayMs: 0, onePositionPerCoin: true });
  // Sharky holds MINT; Two's leader buys it: refused, naming who holds it.
  copy.onWalletTrade(trade({ isBuy: true, signature: 'p1' }));
  await tick();
  await tick();
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'p2' }));
  await tick();
  const two = copy.snapshot().recent.find((t) => t.wallet === W2);
  assert.equal(two.state, 'skipped');
  assert.equal(two.reason, 'already held through Sharky — one position per coin is on');
  // A coin nobody holds: bought. Sharky (no rule) then buys it too: the rule is per follow.
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'p3', mint: MINT_B }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: true, signature: 'p4', mint: MINT_B }));
  await tick();
  await tick();
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.mint === MINT_B && t.state === 'open').length, 2, 'the rule binds only the follow it is on');
  // In flight counts as held: Sharky's buy of MINT_C is still inside its 40 ms delay.
  copy.onWalletTrade(trade({ isBuy: true, signature: 'p5', mint: MINT_C }));
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'p6', mint: MINT_C }));
  await tick();
  await tick();
  await tick();
  const c = copy.snapshot().recent.filter((t) => t.mint === MINT_C);
  assert.equal(c.find((t) => t.wallet === W2).state, 'skipped');
  assert.equal(c.find((t) => t.wallet === WALLET).state, 'open');
});

test('dev-sell exit: the creator selling past the rule sells the copy; under it, nothing; the same sell twice, nothing more', async () => {
  const CREATOR = 'Creat0r111111111111111111111111111111111111';
  let holding = 40;
  const h = setup({ priceSol: 0.001, leaderHolding: () => holding });
  save({ delayMs: 0, exitOnCreatorSellPct: 50 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'd1' }));
  await tick();
  assert.ok(copy.holdsMint(MINT), 'the engine asks this before decoding a creator sell');
  assert.ok(!copy.holdsMint(MINT_B));
  // Sold 10 with 90 left = 10 %: under the rule.
  holding = 90;
  await copy.noteCreatorSell({ mint: MINT, creator: CREATOR, tokens: 10, signature: 'cs1' });
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'a 10 % trim is under the 50 % rule');
  assert.deepEqual(h.calls.holdingReads.at(-1), { wallet: CREATOR, mint: MINT, minContextSlot: null }, 'the CREATOR’s balance, not the leader’s');
  // Sold 60 with 40 left = 60 %: the whole copy goes.
  holding = 40;
  await copy.noteCreatorSell({ mint: MINT, creator: CREATOR, tokens: 60, signature: 'cs2', slot: 123 });
  await tick();
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(exit, 'the copy was sold');
  assert.equal(exit.state, 'closed');
  assert.equal(exit.soldPct, 100);
  assert.match(exit.reason, /^the creator sold 60% of their bag — dev-sell exit$/);
  assert.equal(h.calls.holdingReads.at(-1).minContextSlot, 123, 'read at or past the sell’s slot');
  await copy.noteCreatorSell({ mint: MINT, creator: CREATOR, tokens: 60, signature: 'cs2', slot: 123 });
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 1);
});

test('dev-sell exit: a share that cannot be read fires the rule, and a follow without the rule is untouched', async () => {
  const CREATOR = 'Creat0r111111111111111111111111111111111111';
  const W2 = 'Whae2222222222222222222222222222222222222';
  setup({ priceSol: 0.001 }); // no balance reader at all
  save({ delayMs: 0, exitOnCreatorSellPct: 50 });
  copy.upsert({ ...defaultConfig(W2, 'Two'), enabled: true, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'u1' }));
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'u2' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.state === 'open').length, 2);
  await copy.noteCreatorSell({ mint: MINT, creator: CREATOR, tokens: 5, signature: 'cs3' });
  await tick();
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1, 'only the follow with the rule');
  assert.equal(exits[0].wallet, WALLET);
  assert.match(exits[0].reason, /the creator sold an unreadable share of their bag/);
  assert.equal(copy.snapshot().recent.find((t) => t.wallet === W2 && t.kind !== 'exit').state, 'open');
});

test('migration exit: graduation sells the copies that asked for it, only those, once', async () => {
  const W2 = 'Whae2222222222222222222222222222222222222';
  setup({ priceSol: 0.001 });
  save({ delayMs: 0, exitOnMigration: true });
  copy.upsert({ ...defaultConfig(W2, 'Two'), enabled: true, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'm1' }));
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'm2' }));
  await tick();
  copy.noteMigration(MINT_B);
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'another coin graduating is nothing');
  copy.noteMigration(MINT);
  await tick();
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].wallet, WALLET);
  assert.equal(exits[0].state, 'closed');
  assert.equal(exits[0].soldPct, 100);
  assert.match(exits[0].reason, /^graduated to PumpSwap — migration exit$/);
  assert.equal(copy.snapshot().recent.find((t) => t.wallet === W2 && t.kind !== 'exit').state, 'open', 'the follow without the rule keeps holding');
  copy.noteMigration(MINT);
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 1, 'a second notice sells nothing more');
});

test('LIVE migration exit: the sell meets the pool wait like any other, and is tried again on the clock', async () => {
  const h = setup({ priceSol: 0.001, sellResult: { ok: false, message: MIGRATING } });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, exitOnMigration: true });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'lm1' }));
  await tick();
  assert.equal(h.calls.buys.length, 1);
  const t0 = Date.now();
  copy.noteMigration(MINT, 'solana', t0);
  await tick();
  assert.equal(h.calls.sells.length, 1, 'the sell went out at once');
  const waiting = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.match(waiting.reason, /^waiting — .*PumpSwap/);
  assert.ok(!h.calls.toasts.some((t) => t.level === 'error'), 'not a failed sell');
  copy.checkMaxHolds(t0 + 16_000);
  await tick();
  assert.equal(h.calls.sells.length, 2, 'tried again for the pool');
});

test('follow them out another way: a transfer-out sells the same share, sized from their balance after it', async () => {
  const h = setup({ priceSol: 0.001, leaderHolding: 0 });
  save({ delayMs: 0, copyOtherExits: true });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'o1' }));
  await tick();
  copy.onLeaderOtherExit({ wallet: WALLET, mint: MINT, symbol: 'COPY', kind: 'transferOut', tokens: 1000, signature: 'mv1', at: Date.now(), tradeAt: Date.now(), slot: 77 });
  await tick();
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.ok(exit, 'followed them out');
  assert.equal(exit.state, 'closed');
  assert.equal(exit.soldPct, 100, '1000 moved with 0 left is all of it');
  assert.match(exit.reason, /^they sent it to another wallet — followed them out$/);
  assert.deepEqual(h.calls.holdingReads.at(-1), { wallet: WALLET, mint: MINT, minContextSlot: 77 });
});

test('follow them out another way: off by default; a half move is half a sell; unreadable stays open and says so', async () => {
  let h = setup({ priceSol: 0.001, leaderHolding: 0 });
  save({ delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'o2' }));
  await tick();
  copy.onLeaderOtherExit({ wallet: WALLET, mint: MINT, kind: 'stableSell', tokens: 1000, signature: 'mv2', at: Date.now() });
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'off by default: nothing is sold or recorded');
  assert.equal(h.calls.holdingReads.length, 0);
  // On, half: 500 moved with 500 left.
  h = setup({ priceSol: 0.001, leaderHolding: 500 });
  save({ delayMs: 0, copyOtherExits: true });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'o3' }));
  await tick();
  copy.onLeaderOtherExit({ wallet: WALLET, mint: MINT, kind: 'tokenForToken', tokens: 500, signature: 'mv3', at: Date.now() });
  await tick();
  let exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit.soldPct, 50);
  assert.match(exit.reason, /swapped it for another token/);
  // Unreadable: the row says so and the position stays open — never a guess.
  h = setup({ priceSol: 0.001 });
  save({ delayMs: 0, copyOtherExits: true });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'o4' }));
  await tick();
  copy.onLeaderOtherExit({ wallet: WALLET, mint: MINT, kind: 'transferOut', tokens: 1000, signature: 'mv4', at: Date.now() });
  await tick();
  exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.equal(exit.state, 'skipped');
  assert.match(exit.reason, /could not be read/);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.ok(h.calls.toasts.some((t) => t.level === 'error'), 'said loudly');
});

// ── The AI desk (2026-10-28) ──────────────────────────────────────────

const AI_GATE = { entries: true, exits: false, waitSec: 10, onTimeout: 'skip', protectiveWait: false };

/** A host whose AI answers with `answer(req)`; every request is kept. */
function aiHost(answer, over = {}) {
  const asked = [];
  const notes = [];
  const settled = [];
  let n = 0;
  const h = setup({
    priceSol: 0.001,
    ...over,
    host: {
      aiAsk: async (req) => {
        asked.push(req);
        return answer(req);
      },
      aiNewId: () => `ai_${++n}`,
      aiSettled: (req, a, result) => settled.push({ id: req.id, by: a.by, result }),
      aiNote: (kind, text, data) => notes.push({ kind, text, data }),
      ...(over.host ?? {}),
    },
  });
  return { ...h, asked, notes, settled };
}
const said = (verdict, ms = 7) => ({ by: 'ai', verdict, ms });
const none = (why) => ({ by: 'none', why, ms: 0 });

test('AI desk: a skip is recorded with its reason; the request carries the size and the coin', async () => {
  const d = aiHost(() => said({ verdict: 'skip', reason: 'liquidity too thin' }));
  save({ delayMs: 0, ai: AI_GATE });
  copy.onWalletTrade(trade({ signature: 'ai1' }));
  await tick();
  assert.equal(d.asked.length, 1);
  const req = d.asked[0];
  assert.equal(req.kind, 'entry');
  assert.equal(req.sizeSol, 0.05, 'the follow’s own size is the most it may approve');
  assert.equal(req.leaderSide, 'buy');
  assert.equal(req.facts.liquidityUsd, 50_000, 'the coin’s facts are read for the AI even when no filter needs them');
  assert.equal(req.mode, 'paper');
  assert.ok(req.deadline - req.askedAt === 10_000);
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped');
  assert.equal(row.reason, 'AI skipped — liquidity too thin');
  assert.equal(row.ai.by, 'ai');
  assert.equal(d.calls.buys.length, 0);
  assert.deepEqual(d.settled.map((x) => x.result), ['skipped']);
});

test('AI desk: a smaller buy is taken at the smaller size, and its wait is on the timing line', async () => {
  const d = aiHost(() => said({ verdict: 'buy', sizeSol: 0.02, reason: 'half size, young coin' }, 1_200));
  save({ delayMs: 0, ai: AI_GATE });
  copy.onWalletTrade(trade({ signature: 'ai2' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'open');
  assert.equal(row.ourSol, 0.02);
  assert.match(row.ai.text, /^AI: buy 0.02 — half size, young coin$/);
  assert.equal(row.timing.aiMs, 1_200);
  assert.equal(d.settled[0].result, 'approved — copying 0.02');
});

test('AI desk: no answer skips by default, copies when the follow says so, and never when withdrawn', async () => {
  let d = aiHost(() => none('no AI is connected'));
  save({ delayMs: 0, ai: AI_GATE });
  copy.onWalletTrade(trade({ signature: 'ai3' }));
  await tick();
  assert.equal(copy.snapshot().recent[0].state, 'skipped');
  assert.equal(copy.snapshot().recent[0].reason, 'no AI is connected — skipped (the AI decides this follow’s buys)');

  d = aiHost(() => none('the AI did not answer in 10 s'));
  save({ delayMs: 0, ai: { ...AI_GATE, onTimeout: 'copy' } });
  copy.onWalletTrade(trade({ signature: 'ai4' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'open', 'copied by the fallback');
  assert.equal(row.ai.by, 'none');
  assert.match(row.ai.text, /copied by your fallback/);

  d = aiHost(() => none('cancelled — they sold first'));
  save({ delayMs: 0, ai: { ...AI_GATE, onTimeout: 'copy' } });
  copy.onWalletTrade(trade({ signature: 'ai5' }));
  await tick();
  assert.equal(copy.snapshot().recent[0].state, 'skipped', 'a withdrawn request is never copied');
  assert.equal(d.calls.buys.length, 0);
});

test('AI desk: a follow without the gate never asks; the feed hears their trade and the copy', async () => {
  const d = aiHost(() => said({ verdict: 'skip', reason: 'x' }));
  save({ delayMs: 0 });
  copy.onWalletTrade(trade({ signature: 'ai6' }));
  await tick();
  assert.equal(d.asked.length, 0);
  assert.equal(copy.snapshot().recent[0].state, 'open');
  assert.deepEqual(d.notes.map((x) => x.kind), ['leader_trade', 'copy']);
  assert.match(d.notes[0].text, /^Sharky bought COPY for 1 SOL$/);
  assert.equal(d.notes[0].data.follows[0].follow, 'Sharky');
  assert.equal(d.notes[1].data.state, 'open');
});

test('AI desk: a hold on take-profit keeps the coin and quiets the rule; a stop-loss does not wait', async () => {
  const d = aiHost((req) => (req.kind === 'exit' ? said({ verdict: 'hold', reason: 'still running' }) : said({ verdict: 'buy', reason: 'ok' })));
  save({ delayMs: 0, ai: { ...AI_GATE, exits: true }, exitTakeProfitPct: 50, exitStopLossPct: 30 });
  copy.onWalletTrade(trade({ signature: 'ai7' }));
  await tick();
  copy.markToMarket(MINT, 0.002);
  await tick();
  const exitAsk = d.asked.filter((r) => r.kind === 'exit');
  assert.equal(exitAsk.length, 1);
  assert.equal(exitAsk[0].rule, 'takeProfit');
  assert.ok(Math.abs(exitAsk[0].movePct - 100) < 1e-6, 'the AI is told the move');
  assert.equal(exitAsk[0].sellPct, 100);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'held');
  copy.markToMarket(MINT, 0.0021);
  await tick();
  assert.equal(d.asked.filter((r) => r.kind === 'exit').length, 1, 'the held rule is quiet on this coin');
  // The stop-loss is protective: it fires without asking.
  copy.markToMarket(MINT, 0.0005);
  await tick();
  assert.equal(d.asked.filter((r) => r.kind === 'exit').length, 1, 'not asked');
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.match(exits[0].reason, /stop-loss/);
});

test('AI desk: their sell asks the AI, and "sell 40%" sells 40% of the copy', async () => {
  const d = aiHost((req) => (req.kind === 'exit' ? said({ verdict: 'sell', percent: 40, reason: 'trim' }) : said({ verdict: 'buy', reason: 'ok' })));
  save({ delayMs: 0, ai: { ...AI_GATE, exits: true } });
  copy.onWalletTrade(trade({ signature: 'ai8' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, soldFraction: 1, signature: 'ai8s' }));
  await tick();
  const ask = d.asked.find((r) => r.kind === 'exit');
  assert.equal(ask.rule, 'leader');
  assert.equal(ask.why, 'they sold');
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].soldPct, 40);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open', '60% still held');
});

test('AI desk: sell_copy closes part of a follow’s copy through its own exit path, without asking back', async () => {
  const d = aiHost((req) => (req.kind === 'exit' ? said({ verdict: 'hold', reason: 'never' }) : said({ verdict: 'buy', reason: 'ok' })));
  save({ delayMs: 0, ai: { ...AI_GATE, exits: true } });
  copy.onWalletTrade(trade({ signature: 'ai9' }));
  await tick();
  const id = copy.all()[0].id;
  assert.equal(copy.aiSellCopy('nope', MINT, 50, 'x').ok, false);
  assert.match(copy.aiSellCopy(id, 'CopyMintB11111111111111111111111111111111', 50, 'x').message, /holds no open copy/);
  assert.equal(copy.aiSellCopy(id, MINT, 150, 'x').ok, false);
  const r = copy.aiSellCopy(id, MINT, 50, 'momentum faded');
  assert.equal(r.ok, true);
  await tick();
  assert.equal(d.asked.filter((x) => x.kind === 'exit').length, 0, 'its own sell is not put back to it');
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].soldPct, 50);
  assert.match(exits[0].reason, /the AI sold 50% — momentum faded/);
  assert.deepEqual(copy.aiGatedFollows(), [{ configId: id, follow: 'Sharky', mode: 'paper', entries: true, exits: true }]);
  assert.equal(copy.configMode(id), 'paper');
});

/** A host whose AI answers only when the test says, and whose desk can
 *  withdraw a question the way aiDesk.cancel does. */
function slowAiHost(over = {}) {
  const open = new Map();
  const cancelled = [];
  const d = aiHost((req) => new Promise((resolve) => open.set(req.id, resolve)), {
    ...over,
    host: {
      aiCancel: (id, why) => {
        cancelled.push({ id, why });
        open.get(id)?.(none(`cancelled — ${why}`));
        open.delete(id);
      },
      ...(over.host ?? {}),
    },
  });
  const answer = (id, a) => {
    open.get(id)?.(a);
    open.delete(id);
  };
  return { ...d, open, cancelled, answer };
}

test('AI desk: a follow paused while the AI thinks is not copied, and its question is withdrawn', async () => {
  const d = slowAiHost();
  save({ delayMs: 0, ai: { ...AI_GATE, onTimeout: 'copy' } });
  copy.onWalletTrade(trade({ signature: 'aiw1' }));
  await tick();
  assert.equal(d.open.size, 1, 'asked, waiting');
  const c = copy.all()[0];
  copy.upsert({ ...c, enabled: false });
  await tick();
  assert.deepEqual(d.cancelled.map((x) => x.why), ['the follow was paused']);
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped', 'withdrawn is never copied, whatever the fallback');
  assert.equal(d.calls.buys.length, 0);
});

test('AI desk: an approval that lands after the follow was paused or switched to live buys nothing', async () => {
  // The desk did not withdraw it (no aiCancel): the follow itself is re-read.
  let d = aiHost(() => new Promise((r) => setTimeout(() => r(said({ verdict: 'buy', reason: 'ok' })), 40)));
  save({ delayMs: 0, ai: AI_GATE });
  copy.onWalletTrade(trade({ signature: 'aiw2' }));
  await new Promise((r) => setTimeout(r, 10));
  copy.upsert({ ...copy.all()[0], enabled: false });
  await new Promise((r) => setTimeout(r, 60));
  let row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped');
  assert.match(row.reason, /^not executed — the follow was switched off while this copy waited$/);

  d = aiHost(() => new Promise((r) => setTimeout(() => r(said({ verdict: 'buy', reason: 'ok' })), 40)));
  save({ delayMs: 0, ai: AI_GATE });
  copy.onWalletTrade(trade({ signature: 'aiw3' }));
  await new Promise((r) => setTimeout(r, 10));
  copy.upsert({ ...copy.all()[0], mode: 'live' });
  await new Promise((r) => setTimeout(r, 60));
  row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped');
  assert.match(row.reason, /switched to live while this copy waited/);
  assert.equal(d.calls.buys.length, 0, 'a paper copy never becomes a real buy');
});

test('AI desk: a hold on max hold quiets max hold only — the trailing stop still fires', async () => {
  const d = aiHost((req) => (req.kind === 'exit' ? said({ verdict: 'hold', reason: 'let it run' }) : said({ verdict: 'buy', reason: 'ok' })));
  save({ delayMs: 0, ai: { ...AI_GATE, exits: true }, exitMaxHoldMin: 1, exitTrailingPct: 20 });
  copy.onWalletTrade(trade({ signature: 'aiw4' }));
  await tick();
  const later = Date.now() + 61_000;
  copy.markToMarket(MINT, 0.001, undefined, later);
  await tick();
  assert.deepEqual(d.asked.filter((r) => r.kind === 'exit').map((r) => r.rule), ['maxHold']);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0, 'held');
  copy.markToMarket(MINT, 0.0007, undefined, later + 1_000);
  await tick();
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1, 'the trailing stop fired through the held max hold');
  assert.match(exits[0].reason, /trailing/);
  assert.equal(d.asked.filter((r) => r.kind === 'exit').length, 1, 'a protective rule does not ask');
});

test('AI desk: a stop-loss withdraws the AI question on their sell instead of waiting behind it', async () => {
  const d = slowAiHost();
  save({ delayMs: 0, ai: { ...AI_GATE, entries: false, exits: true }, exitStopLossPct: 30 });
  copy.onWalletTrade(trade({ signature: 'aiw5' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, soldFraction: 0.5, signature: 'aiw5s' }));
  await tick();
  assert.equal(d.open.size, 1, 'their sell is waiting on the AI');
  copy.markToMarket(MINT, 0.0005);
  await tick();
  await tick();
  assert.equal(d.cancelled.length, 1);
  assert.match(d.cancelled[0].why, /stop-loss/);
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.ok(exits.some((x) => /stop-loss/.test(x.reason ?? '')), 'the stop-loss sold');
});

test('AI desk: "sell 30%" is not refused by the follow’s 50% minimum — that rule is about the leader', async () => {
  const d = aiHost((req) => (req.kind === 'exit' ? said({ verdict: 'sell', percent: 30, reason: 'trim' }) : said({ verdict: 'buy', reason: 'ok' })));
  save({ delayMs: 0, ai: { ...AI_GATE, exits: true }, minLeaderSellPct: 50 });
  copy.onWalletTrade(trade({ signature: 'aiw6' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, soldFraction: 1, signature: 'aiw6s' }));
  await tick();
  const exits = copy.snapshot().recent.filter((t) => t.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].state === 'skipped', false, exits[0].reason);
  assert.equal(exits[0].soldPct, 30);
  void d;
});

test('a copy that starts while the app is quitting is not sent, and the book is written at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copyquit-'));
  setup();
  copy.init(dir);
  save({ delayMs: 0 });
  await copy.drainForQuit(500);
  copy.onWalletTrade(trade({ signature: 'quit1' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'skipped');
  assert.equal(row.reason, 'not executed — the app was closing');
  copy.flushSync();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8'));
  assert.ok(onDisk.trades.some((t) => t.reason === 'not executed — the app was closing'), 'written without waiting for the debounce');
  copy._reset();
});

test('a follow cannot change wallets while it holds live copies, and the active-wallet count sees them', async () => {
  const h = setup();
  save({ delayMs: 0, mode: 'live' });
  copy.onWalletTrade(trade({ signature: 'wal1' }));
  await tick();
  assert.equal(h.calls.buys.length, 1);
  assert.equal(copy.activeWalletLiveCopies(), 1);
  const c = copy.all()[0];
  const r = copy.upsert({ ...c, walletId: 'w_other' });
  assert.equal(r.ok, false);
  assert.match(r.message, /1 live copy open in its current wallet/);
  assert.equal(copy.configMode(c.id, MINT), 'live');
  copy.upsert({ ...c, mode: 'paper' });
  assert.equal(copy.configMode(copy.all()[0].id), 'paper');
  assert.equal(copy.configMode(copy.all()[0].id, MINT), 'live', 'the copy is still real money');
});

test('AI desk: the setting is validated, and the summary line says what it does', () => {
  assert.equal(validateConfig(cfg({ ai: AI_GATE })).ok, true);
  assert.equal(validateConfig(cfg({ ai: null })).ok, true);
  assert.match(validateConfig(cfg({ ai: { ...AI_GATE, waitSec: 100 } })).message, /between 3 and 45 seconds/);
  assert.equal(validateConfig(cfg({ ai: { ...AI_GATE, onTimeout: 'maybe' } })).ok, false);
  assert.equal(defaultConfig(WALLET, 'x').ai, null);
});

await run();
