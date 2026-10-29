// Chain pricing (2026-10-24) — the copy replay's fast path. A copy fills at
// the coin's price after the last trade at or before the follower's slot
// (theirs + LAG_SLOTS); one call when the forward page covers the exit, a
// second only when it does not; an answer is paid for once. And the replay
// goes fast first, then falls back per trip: no key, an allowance spent, or
// a chain that will not answer sends trips to pump's swap API, never to "no
// price".

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { LAG_SLOTS, MAX_CREDITS_PER_TRIP, ammView, mintBirth, priceOfTx, priceTrip, priceTripLags, recentTrades as chainRecentTrades, _reset } from './.chainprice.mjs';
import { base58Encode as keyB58 } from './.b58.mjs';

// The app's encoder is sized for keys and signatures (its scratch holds 128
// digits); an event instruction is longer, so the fixture encodes its own.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  if (buf.length <= 64) return keyB58(buf);
  let n = BigInt(`0x${Buffer.from(buf).toString('hex')}`);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}
import { backtestCreditsLeft, emptyUsage, record, recordBacktest } from './.credits.mjs';
import { replayReturn } from './.copyreplay.mjs';
import * as job from './.copyreplayjob.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const disc = (name) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const MINT_BYTES = Buffer.alloc(32, 1);
const MINT = base58Encode(MINT_BYTES);
const USER = Buffer.alloc(32, 2);

/** A pump TradeEvent whose curve stands at `px` SOL a token afterwards. */
function tradeEvent(px, mint = MINT_BYTES) {
  const vTok = 1_000_000_000_000_000n; // 1e9 whole tokens
  const vSol = BigInt(Math.round(px * 1e9 * 1e9));
  return Buffer.concat([disc('TradeEvent'), mint, u64(1_000_000_000n), u64(1_000_000n), Buffer.from([1]), USER, u64(1729700000), u64(vSol), u64(vTok)]);
}

/** A transaction that traded the coin, its event logged (older coins). */
const logTx = (slot, px, idx = 0, mint) => ({
  slot,
  transactionIndex: idx,
  signature: `s${slot}_${idx}`,
  transaction: { message: { accountKeys: [] } },
  meta: { err: null, logMessages: [`Program data: ${tradeEvent(px, mint).toString('base64')}`], innerInstructions: [] },
});

/** The same, emitted by CPI the way current pump does. */
const cpiTx = (slot, px, idx = 0) => ({
  slot,
  transactionIndex: idx,
  signature: `c${slot}_${idx}`,
  transaction: { message: { accountKeys: ['Payer111', PUMP] } },
  meta: {
    err: null,
    logMessages: [],
    innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [], data: base58Encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), tradeEvent(px)])) }] }],
  },
});

/** A stub of getTransactionsForAddress over a list of the coin's trades. */
function chain(txs, opts = {}) {
  const calls = [];
  const read = async (_url, mint, o) => {
    calls.push(o);
    if (opts.refuse) return { ok: false, refused: true, message: 'not on this plan' };
    if (opts.fail) return { ok: false, message: 'RPC HTTP 500' };
    assert.equal(mint, MINT);
    let rows = txs.filter((t) => (o.slot?.gte === undefined || t.slot >= o.slot.gte) && (o.slot?.lte === undefined || t.slot <= o.slot.lte));
    rows.sort((a, b) => a.slot - b.slot || a.transactionIndex - b.transactionIndex);
    if (o.sortOrder !== 'asc') rows.reverse();
    rows = rows.slice(0, o.limit);
    return { ok: true, message: 'ok', data: { txs: rows, paginationToken: null } };
  };
  return { read, calls };
}

{
  assert.equal(LAG_SLOTS, 9, '2 s at 211.6 ms a slot');
  assert.ok(Math.abs(priceOfTx(logTx(1, 2.5e-8), MINT) - 2.5e-8) < 1e-18, 'a logged TradeEvent');
  assert.ok(Math.abs(priceOfTx(cpiTx(1, 3e-8), MINT) - 3e-8) < 1e-18, 'a CPI-emitted TradeEvent');
  assert.equal(priceOfTx(logTx(1, 3e-8, 0, Buffer.alloc(32, 9)), MINT), null, 'another coin’s trade is not this coin’s price');
  ok('a trade’s price is the curve after it: virtual SOL over virtual tokens, from the log or the CPI event');
}

{
  _reset();
  const open = 1000;
  const close = 1100;
  // Their buy at 1000; trades inside the lag move the price; the copy fills
  // at the last one at or before 1009. Same at the exit: last ≤ 1109.
  const { read, calls } = chain([
    logTx(1000, 1e-8),
    logTx(1004, 1.5e-8),
    cpiTx(1009, 2e-8, 3),
    logTx(1010, 9e-8), // after the copy's slot — not its fill
    logTx(1100, 3e-8),
    logTx(1109, 4e-8),
    logTx(1200, 1e-7),
  ]);
  const r = await priceTrip('https://mainnet.helius-rpc.com/?api-key=x', MINT, open, close, { read });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.entry - 2e-8) < 1e-18, `entry ${r.entry}`);
  assert.ok(Math.abs(r.exit - 4e-8) < 1e-18, `exit ${r.exit}`);
  assert.equal(r.calls, 1, 'one forward page answered both legs');
  assert.equal(r.credits, 10);
  assert.deepEqual(calls[0].slot, { gte: open });
  assert.equal(calls[0].sortOrder, 'asc');
  const again = await priceTrip('https://mainnet.helius-rpc.com/?api-key=x', MINT, open, close, { read });
  assert.equal(again.cached, true);
  assert.equal(again.credits, 0);
  assert.equal(calls.length, 1, 'a trip priced once is not paid for again');
  ok('one call per trip: the forward page from their buy prices both legs to the slot, and the answer is cached');
}

{
  _reset();
  // A busy coin: a full page of trades before the exit — the exit needs a
  // second, backward call from the copy's sell slot.
  const busy = Array.from({ length: 100 }, (_, i) => logTx(2000 + Math.floor(i / 4), 1e-8 + i * 1e-10, i % 4));
  const { read, calls } = chain([...busy, logTx(2500, 5e-8), logTx(2509, 6e-8), logTx(2600, 1e-6)]);
  const r = await priceTrip('h', MINT, 2000, 2500, { read });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 2);
  assert.equal(r.credits, 20);
  assert.ok(r.credits <= MAX_CREDITS_PER_TRIP, 'a trip never costs more than the caller reserved');
  assert.deepEqual(calls[1].slot, { lte: 2509 });
  assert.equal(calls[1].sortOrder, 'desc');
  assert.ok(Math.abs(r.exit - 6e-8) < 1e-18, `exit ${r.exit}`);
  // Entry from the forward page: last trade ≤ 2009 is index 39 (slot 2009, idx 3).
  assert.ok(Math.abs(r.entry - (1e-8 + 39 * 1e-10)) < 1e-18, `entry ${r.entry}`);
  ok('a coin too busy for one page gets a second, backward call for the leg the page missed — never more');
}

{
  _reset();
  const refused = await priceTrip('h', MINT, 1, 2, chain([], { refuse: true }));
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true, 'a plan refusal is said, so the caller stops asking');
  const failed = await priceTrip('h', MINT, 1, 2, chain([], { fail: true }));
  assert.equal(failed.ok, false);
  assert.equal(failed.credits, 0, 'a failed read is not counted as spent');
  ok('a refused or failed read is a failure the caller can fall back from, not a price');
}

{
  // The allowance: a share of the month, never more than the month has left.
  let u = { ...emptyUsage(0), limit: 1_000_000 };
  assert.equal(backtestCreditsLeft(u, 100_000), 100_000);
  assert.equal(backtestCreditsLeft(u, 0), 0, '0 turns chain pricing off');
  u = recordBacktest(record(u, 'http', 99_990), 99_990);
  assert.equal(backtestCreditsLeft(u, 100_000), 10);
  u = { ...record(emptyUsage(0), 'http', 999_950), limit: 1_000_000 };
  assert.equal(backtestCreditsLeft(u, 100_000), 50, 'the month’s ceiling binds first');
  assert.equal(backtestCreditsLeft({ ...u, used: 1_000_000 }, 100_000), 0);
  ok('the backtest allowance is a share of the month: off at 0, and never past the month’s ceiling');
}

{
  // PumpSwap, told apart exactly: another coin's pool in a routed
  // transaction is not this coin's trade, and a WSOL/coin pool is read the
  // right way up — at any price, not only cheap ones.
  const POOL = 'Poo1111111111111111111111111111111111111111';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const bal = (idx, owner, mint, amount) => ({ accountIndex: idx, owner, mint, uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: null } });
  const swapEv = (o) => ({ kind: 'amm_swap', isBuy: true, timestamp: 0, quoteLimit: 0n, poolBaseReserves: 0n, poolQuoteReserves: 0n, userBaseReserves: 0n, userQuoteReserves: 0n, lpFeeBps: 0n, lpFee: 0n, protocolFeeBps: 0n, protocolFee: 0n, pool: POOL, user: 'U', coinCreator: 'C', ...o });
  // A coin/WSOL pool: 2 SOL buys 1,000 tokens → 0.002 SOL a token. The pool's
  // coin balance falls by baseAmount.
  const normal = { meta: { preTokenBalances: [bal(3, POOL, MINT, 5_000_000_000), bal(4, POOL, WSOL, 9e9)], postTokenBalances: [bal(3, POOL, MINT, 4_000_000_000), bal(4, POOL, WSOL, 11e9)] } };
  const v = ammView(normal, swapEv({ baseAmount: 1_000_000_000n, quoteAmount: 2_000_000_000n, userQuoteAmount: 2_000_000_000n }), MINT);
  assert.ok(v.isBuy && Math.abs(v.priceSol - 0.002) < 1e-12 && Math.abs(v.sol - 2) < 1e-12 && Math.abs(v.tokens - 1000) < 1e-9, JSON.stringify(v));
  // The same swap upside down (base = WSOL): the user BUYS 2 SOL with 1,000
  // tokens — a sell of the coin at 0.002, which the old >1 SOL test missed.
  const inverted = { meta: { preTokenBalances: [bal(3, POOL, MINT, 4_000_000_000), bal(4, POOL, WSOL, 11e9)], postTokenBalances: [bal(3, POOL, MINT, 5_000_000_000), bal(4, POOL, WSOL, 9e9)] } };
  const iv = ammView(inverted, swapEv({ baseAmount: 2_000_000_000n, quoteAmount: 1_000_000_000n, userQuoteAmount: 1_000_000_000n }), MINT);
  assert.ok(!iv.isBuy && Math.abs(iv.priceSol - 0.002) < 1e-12 && Math.abs(iv.sol - 2) < 1e-12, JSON.stringify(iv));
  // A pool that holds another coin: not this coin's trade.
  assert.equal(ammView(normal, swapEv({ baseAmount: 1n, quoteAmount: 1n, userQuoteAmount: 1n }), keyB58(Buffer.alloc(32, 7))), null);
  ok('a PumpSwap swap counts only on this coin’s own pool, and an inverted pool is read the right way up by its balances');
}

{
  // The scan reader: newest-first pages back to the window, every trade in a
  // transaction, handed back oldest-first.
  const since = 1_790_000_000_000;
  const page = (slot, sec, px, idx = 0) => ({ ...logTx(slot, px, idx), blockTime: sec });
  const txs = Array.from({ length: 150 }, (_, i) => page(5000 + i, since / 1000 + 10 + i, 1e-8 * (1 + i / 100)));
  const calls = [];
  const read = async (_u, _m, o) => {
    calls.push(o);
    const start = o.paginationToken ? Number(o.paginationToken) : 0;
    const desc = [...txs].reverse();
    const rows = desc.slice(start, start + o.limit);
    return { ok: true, message: 'ok', data: { txs: rows, paginationToken: start + o.limit < desc.length ? String(start + o.limit) : null } };
  };
  const r = await chainRecentTrades('h', MINT, since, 3, { read });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true, 'ran out of history inside the page cap');
  assert.equal(r.calls, 2);
  assert.equal(r.credits, 20);
  assert.equal(r.trades.length, 150);
  assert.ok(r.trades.every((t, i) => i === 0 || t.ts >= r.trades[i - 1].ts), 'oldest first');
  assert.equal(calls[0].sinceSec, since / 1000, 'the window is filtered on the server');
  assert.equal(r.trades[0].user, keyB58(USER));
  assert.ok(Math.abs(r.trades[0].sol - 1) < 1e-12 && Math.abs(r.trades[0].tokens - 1) < 1e-12, 'the event’s own amounts, as the feed books them');
  const capped = await chainRecentTrades('h', MINT, since, 1, { read });
  assert.equal(capped.complete, false, 'a busy coin past the cap is read in part');
  assert.equal(capped.trades.length, 100);
  ok('a coin’s recent trades come from the chain newest page first, back to the window, oldest-first out');
}

// ── The replay: chain first, then pump's swap API for what is left ──

const T = 1_790_000_000_000;
const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=x';
const sw = (mint, isBuy, sol, tokens, at, slot) => ({ mint, isBuy, sol, tokens, at, ...(slot !== undefined ? { slot } : {}) });

function replayDeps(swaps, { left = 100_000, chainPrice, pump } = {}) {
  const pumpAsked = [];
  const chainAsked = [];
  let billed = 0;
  let credit = left;
  return {
    pumpAsked,
    chainAsked,
    billed: () => billed,
    deps: {
      sleep: async () => {},
      cooldownMs: () => 0,
      swapsOf: () => swaps,
      read: async () => assert.fail('no read'),
      priceAt: async (mint, at) => {
        pumpAsked.push([mint, at]);
        return pump ? pump(mint, at) : { price: 1, at };
      },
      chainPrice: async (_u, mint, o, c) => {
        chainAsked.push([mint, o, c]);
        return chainPrice(mint, o, c);
      },
      chainCreditsLeft: () => credit,
      billBacktest: (n) => {
        billed += n;
        credit -= n;
      },
    },
  };
}

{
  job._reset();
  const W = 'Chain111111111111111111111111111111111111111';
  const swaps = [
    // A, B: slots known — the chain prices them.
    sw('A', true, 1, 1000, T, 100),
    sw('A', false, 1.2, 1000, T + 60_000, 400),
    sw('B', true, 1, 1000, T + 100_000, 600),
    sw('B', false, 0.8, 1000, T + 160_000, 900),
    // C: the chain read it and found no pump trade — pump's history is asked.
    sw('C', true, 1, 1000, T + 200_000, 1000),
    sw('C', false, 1.1, 1000, T + 260_000, 1300),
    // D: no slots on record — straight to pump's history.
    sw('D', true, 1, 1000, T + 300_000),
    sw('D', false, 1.1, 1000, T + 360_000),
  ];
  const h = replayDeps(swaps, {
    chainPrice: (mint) =>
      mint === 'C'
        ? { ok: true, entry: null, exit: null, calls: 1, credits: 10, cached: false, message: '' }
        : { ok: true, entry: 1, exit: mint === 'A' ? 1.5 : 0.5, calls: 1, credits: 10, cached: false, message: '' },
  });
  job.start(W, HELIUS, h.deps);
  await job.wait(W);
  const st = job.status(W);
  const by = Object.fromEntries(st.trips.map((t) => [t.mint, t]));
  assert.equal(by.A.source, 'chain');
  assert.ok(Math.abs(by.A.returnPct - replayReturn(1, 1.5)) < 1e-9);
  assert.equal(by.B.source, 'chain');
  assert.equal(by.C.source, 'pump', 'what the chain could not price, the swap API is asked for');
  assert.equal(by.D.source, 'pump');
  assert.deepEqual(h.chainAsked.map(([m, o, c]) => [m, o, c]).sort(), [['A', 100, 400], ['B', 600, 900], ['C', 1000, 1300]], 'their slots, as they landed');
  assert.deepEqual([...new Set(h.pumpAsked.map(([m]) => m))].sort(), ['C', 'D'], 'nothing the chain priced is priced twice');
  assert.equal(st.viaChain, 2);
  assert.equal(st.viaPump, 2);
  assert.equal(st.credits, 30);
  assert.equal(h.billed(), 30, 'every credit the chain spent is counted on the allowance');
  assert.equal(st.priced, st.toPrice);
  assert.match(st.fallbackWhy, /without slots/);
  ok('chain first, per trip: priced trips are done; a trip the chain cannot price, or that has no slots, goes to the swap API');
}

{
  job._reset();
  const W = 'Chain222222222222222222222222222222222222222';
  const swaps = [sw('A', true, 1, 1000, T, 100), sw('A', false, 1.2, 1000, T + 60_000, 400)];
  // No Helius key: not one chain call.
  const h = replayDeps(swaps, { chainPrice: () => assert.fail('no chain without a Helius key') });
  job.start(W, 'https://api.mainnet-beta.solana.com', h.deps);
  await job.wait(W);
  let st = job.status(W);
  assert.equal(st.trips[0].source, 'pump');
  assert.match(st.fallbackWhy, /no Helius key/);

  // The allowance spent: not one chain call, and it says why.
  job._reset();
  const h2 = replayDeps(swaps, { left: 0, chainPrice: () => assert.fail('no chain once the allowance is spent') });
  job.start(W, HELIUS, h2.deps);
  await job.wait(W);
  st = job.status(W);
  assert.equal(st.trips[0].note, 'filled');
  assert.equal(st.trips[0].source, 'pump');
  assert.match(st.fallbackWhy, /allowance/);
  ok('no key, or the allowance spent: every trip is priced the slow way, and the reason is said');
}

{
  job._reset();
  const W = 'Chain333333333333333333333333333333333333333';
  const swaps = [];
  for (let i = 0; i < 6; i++) swaps.push(sw(`M${i}`, true, 1, 1000, T + i * 100_000, 100 + i * 1000), sw(`M${i}`, false, 1.2, 1000, T + i * 100_000 + 60_000, 400 + i * 1000));
  // The chain refuses (a plan change): it stops asking at once, and every
  // trip is still priced by the swap API.
  const h = replayDeps(swaps, { chainPrice: () => ({ ok: false, entry: null, exit: null, calls: 1, credits: 0, cached: false, message: 'not on this plan', refused: true }) });
  job.start(W, HELIUS, h.deps);
  await job.wait(W);
  const st = job.status(W);
  assert.ok(h.chainAsked.length <= 4, `stops asking after a refusal (in flight at most the workers): ${h.chainAsked.length}`);
  assert.equal(st.viaPump, 6);
  assert.ok(st.trips.every((t) => t.note === 'filled' && t.source === 'pump'));
  assert.match(st.fallbackWhy, /chain read failed/);
  ok('a chain that refuses is given up on at once, and the swap API prices every trip');
}

{
  // A coin's birth (2026-10-25): its first transaction, read once and kept.
  _reset();
  const CREATOR = 'Creat0r11111111111111111111111111111111111111';
  const mk = (slot, transactionIndex, signature, payer) => ({ slot, transactionIndex, signature, blockTime: 1_700_000_000, meta: { err: null }, transaction: { message: { accountKeys: [payer, MINT], instructions: [] } } });
  const page = [mk(100, 7, 'later', 'Someone'), mk(50, 3, 'createtx', CREATOR), mk(50, 4, 'bundlebuy', CREATOR)];
  const calls = [];
  const read = async (_u, mint, o) => {
    calls.push(o);
    assert.equal(mint, MINT);
    return { ok: true, message: 'ok', data: { txs: page, paginationToken: null } };
  };
  const b = await mintBirth('http://x', MINT, { read });
  assert.equal(b.ok, true);
  assert.deepEqual(b.birth, { slot: 50, index: 3, tx: 'createtx', creator: CREATOR }, 'the earliest slot and position, whatever order the page came in');
  assert.equal(b.credits, 10, 'one page of under a hundred is ten credits');
  assert.deepEqual(calls[0], { limit: 5, sortOrder: 'asc' }, 'one ascending page of five');
  const again = await mintBirth('http://x', MINT, { read });
  assert.equal(again.cached, true);
  assert.equal(again.credits, 0, 'a birth never changes: the second ask is free');
  assert.equal(calls.length, 1);
  const refused = await mintBirth('http://x', 'Other111111111111111111111111111111111111111', { read: async () => ({ ok: false, refused: true, message: 'not on this plan' }) });
  assert.deepEqual([refused.ok, refused.refused, refused.credits, refused.birth], [false, true, 0, null]);
  const empty = await mintBirth('http://x', 'Empty111111111111111111111111111111111111111', { read: async () => ({ ok: true, message: 'ok', data: { txs: [], paginationToken: null } }) });
  assert.deepEqual([empty.ok, empty.birth, empty.credits], [true, null, 10], 'a coin with no transactions is an answer, not a failure');
  ok("a coin's birth: first slot and position, creator as fee payer, ten credits once, then the cache");
}

{
  // Several lags from one read (2026-10-25, the pre-registered test's
  // ablation): each lag's legs are the last trade at or before its slot,
  // the forward page serves them all, and each answer lands in the cache
  // under the key the single-lag read uses.
  _reset();
  const { read, calls } = chain([logTx(1000, 1e-8), logTx(1002, 1.2e-8), logTx(1004, 1.5e-8), cpiTx(1009, 2e-8, 3), logTx(1100, 3e-8), logTx(1102, 3.5e-8), logTx(1109, 4e-8), logTx(1200, 1e-7)]);
  const r = await priceTripLags('h', MINT, 1000, 1100, [0, 2, 9], { read });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1, 'one forward page serves every lag');
  assert.equal(r.credits, 10);
  assert.ok(Math.abs(r.at[0].entry - 1e-8) < 1e-18 && Math.abs(r.at[0].exit - 3e-8) < 1e-18, 'at 0 slots: the prints their own trades left');
  assert.ok(Math.abs(r.at[2].entry - 1.2e-8) < 1e-18 && Math.abs(r.at[2].exit - 3.5e-8) < 1e-18, 'two slots later');
  assert.ok(Math.abs(r.at[9].entry - 2e-8) < 1e-18 && Math.abs(r.at[9].exit - 4e-8) < 1e-18, 'the usual lag, as priceTrip has it');
  const one = await priceTrip('h', MINT, 1000, 1100, { read });
  assert.equal(one.cached, true, 'the usual lag was cached by the lagged read');
  assert.ok(Math.abs(one.entry - 2e-8) < 1e-18);
  assert.equal(calls.length, 1);
  const again = await priceTripLags('h', MINT, 1000, 1100, [0, 9], { read });
  assert.equal(again.cached, true);
  assert.equal(again.calls, 0);
  const more = await priceTripLags('h', MINT, 1000, 1100, [0, 4], { read });
  assert.equal(more.cached, false, 'a lag not yet priced costs a read');
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(more.at[4].entry - 1.5e-8) < 1e-18);
  // A busy coin: the lags the page does not reach share back pages.
  _reset();
  const busy = Array.from({ length: 100 }, (_, i) => logTx(2000 + Math.floor(i / 4), 1e-8 + i * 1e-10, i % 4));
  const h2 = chain([...busy, logTx(2500, 5e-8), logTx(2502, 5.5e-8), logTx(2509, 6e-8), logTx(2600, 1e-6)]);
  const b = await priceTripLags('h', MINT, 2000, 2500, [0, 2, 9], h2);
  assert.equal(b.ok, true);
  assert.ok(Math.abs(b.at[9].exit - 6e-8) < 1e-18 && Math.abs(b.at[2].exit - 5.5e-8) < 1e-18 && Math.abs(b.at[0].exit - 5e-8) < 1e-18, 'every exit from the back read');
  assert.equal(b.calls, 2, 'one back page, read from the largest slot, answers the smaller ones too');
  ok('several lags from one page, cached under the single-lag keys; back pages are shared between lags');
}

console.log(`\nchainprice: ${passed}/${passed} passed`);
