// What an MCP tool call does (electron/engine/mcpTools.ts), against a fake host.
//
// The server test proves the door is a door. This proves that what comes
// through it is bounded: arguments are refused rather than coerced, unknown
// fields never reach a trade, the budget is reserved BEFORE the app is asked
// (so two calls in flight cannot both spend the same allowance), and a paper
// connection never reaches the live pipeline.

import assert from 'node:assert';
import * as tools from './.mcptools.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const MINT = 'CopyMint111111111111111111111111111111111';
const WALLET = 'Whae1111111111111111111111111111111111111';

let access = 'live';
let budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 4, followMaxCopySol: 0.1, followDailyLossSol: 0.5 };
// The app's own handlers (2026-11-02): what each channel answers, and every call.
let invoked = [];
let handlerAnswers = {};
let copyRows = [];
let keptOff = [];
let execution = {};
let calls;
let answers;
// Follows (2026-11-01): an in-memory book the follow tools edit.
let follows = [];
let liveOpen = {};
let notices = [];
let saves = [];

let liveStoppedBy = null;
function setup(over = {}) {
  liveStoppedBy = over.liveStoppedBy ?? null;
  keptOff = [];
  tools._reset();
  calls = { buys: [], sells: [], orders: [], cancels: [], reads: [], krypto: [], trader: [] };
  answers = { buy: { ok: true, message: 'bought' }, sell: { ok: true, message: 'sold' }, order: { ok: true, message: 'armed' }, ...over.answers };
  const read = (name) => async (...args) => {
    calls.reads.push({ name, args });
    return over[name] !== undefined ? over[name] : { name };
  };
  tools.attach({
    access: () => access,
    budget: () => budget,
    defaultChain: () => 'solana',
    walletInfo: read('walletInfo'),
    positions: async (paper, chain) => {
      calls.reads.push({ name: 'positions', args: [paper, chain] });
      return { paper, chain };
    },
    token: read('token'),
    discover: read('discover'),
    chart: read('chart'),
    tokenLinks: read('tokenLinks'),
    runnerAlerts: read('runnerAlerts'),
    callouts: read('callouts'),
    scoutBoard: read('scoutBoard'),
    scoutWallet: read('scoutWallet'),
    copyConfigs: read('copyConfigs'),
    orders: read('orders'),
    trades: read('trades'),
    buy: async (mint, amount, paper, chain) => {
      calls.buys.push({ mint, amount, paper, chain });
      return answers.buy;
    },
    sell: async (mint, percent, paper, chain) => {
      calls.sells.push({ mint, percent, paper, chain });
      return answers.sell;
    },
    placeOrder: async (req, paper) => {
      calls.orders.push({ req, paper });
      return answers.order;
    },
    kryptoSessions: read('kryptoSessions'),
    kryptoTrade: async (mint, side, amount, live) => {
      calls.krypto.push({ mint, side, amount, live });
      return { ok: true, message: 'krypto ok' };
    },
    traderSessions: async () => [{ session_id: 'kt_one', seq: 3 }],
    traderSession: async (id) => (id === 'kt_one' ? { session_id: 'kt_one', seq: 3, facts: { coin: 'the coin' } } : null),
    traderGate: (id) => (id === 'kt_one' ? { driver: 'mcp', status: 'running', mode: 'paper', seq: 3, ...(over.gate ?? {}) } : null),
    traderAct: async (id, intent, expectedSeq) => {
      calls.trader.push({ id, intent, expectedSeq });
      return { ok: true, message: `${intent.action} done`, seq: expectedSeq + 1 };
    },
    cancelOrders: async (mint) => {
      calls.cancels.push(mint);
      return { ok: true, message: 'Cancelled 2 order(s).', cancelled: 2 };
    },
    // The AI desk (2026-10-28).
    deskPoll: async (cursor, waitMs, kinds) => {
      calls.desk = calls.desk ?? [];
      calls.desk.push({ name: 'poll', cursor, waitMs, kinds });
      return { cursor: 9, events: [{ seq: 9, kind: 'copy' }], missed: 0, pending: [{ id: 'ai_3' }] };
    },
    deskPending: () => [{ id: 'ai_3' }],
    deskDecide: (id, v) => {
      calls.desk = calls.desk ?? [];
      calls.desk.push({ name: 'decide', id, v });
      return { ok: true, message: `Recorded: ${v.verdict}.` };
    },
    copyMode: (id) => (id === 'cfgLive' ? 'live' : id === 'cfgPaper' ? 'paper' : null),
    sellCopy: (configId, mint, percent, reason) => {
      calls.desk = calls.desk ?? [];
      calls.desk.push({ name: 'sellCopy', configId, mint, percent, reason });
      return { ok: true, message: 'Selling.' };
    },
    // The fake saves what it is given, and does NOT disarm a live follow
    // itself — so a test that sees one saved off proves mcpTools did it,
    // not copyTrade.upsert's second wall.
    follows: () => follows.map((c) => ({ ...c })),
    liveOpenCopies: (id) => liveOpen[id] ?? 0,
    keepFollowOff: (id) => keptOff.push(id),
    saveFollow: (input) => {
      saves.push({ ...input });
      if (input.id) {
        const c = follows.find((x) => x.id === input.id);
        if (!c) return { ok: false, message: 'Config not found' };
        Object.assign(c, input);
        return { ok: true, message: 'Saved' };
      }
      if (follows.some((c) => c.wallet === input.wallet && (c.chain ?? 'solana') === (input.chain ?? 'solana'))) return { ok: false, message: 'You are already following that wallet on that chain' };
      follows.push({ ...input, id: `cp_${follows.length + 1}`, createdAt: 1 });
      return { ok: true, message: 'Following' };
    },
    followNotice: (title, line) => notices.push({ title, line }),
    log: () => {},
    invoke: async (channel, ...args) => {
      invoked.push({ channel, args });
      const a = handlerAnswers[channel];
      if (typeof a === 'function') return a(...args);
      return a ?? { ok: true, message: `${channel} ok`, data: { channel } };
    },
    copyRows: () => copyRows,
    liveStoppedBy: () => liveStoppedBy,
    settingsView: () => ({ routing: { mevMode: 'fast' }, connection: { access, budget } }),
    execution: () => ({ ...execution }),
  });
  invoked = [];
  handlerAnswers = over.handlers ?? {};
  copyRows = over.copyRows ?? [];
  execution = over.execution ?? { feeUrgency: 'normal', mevMode: 'fast', maxLiveSol: 0.5, liveEnabled: true, maxOpenCopies: 10 };
  follows = over.follows ?? [];
  liveOpen = over.liveOpen ?? {};
  notices = [];
  saves = [];
}

// ── arguments are refused, never coerced ─────────────────────────────────
{
  setup();
  access = 'live';
  const bad = [
    ['buy_token', { mint: 'not-base58', amount: 0.01 }, /not a Solana mint/],
    ['buy_token', { mint: MINT }, /amount is required/],
    ['buy_token', { mint: MINT, amount: '0.1' }, /amount must be a number/],
    ['buy_token', { mint: MINT, amount: Number.NaN }, /amount must be a number/],
    ['sell_token', { mint: MINT, percent: 0 }, /at least 1/],
    ['sell_token', { mint: MINT, percent: 101 }, /at most 100/],
    ['find_tokens', {}, /list is required/],
    ['find_tokens', { list: 'hot' }, /list must be one of/],
    ['find_tokens', { list: 'new', limit: 500 }, /at most 50/],
    ['get_wallet_record', { address: 'nope' }, /is not an address/],
    ['get_wallet_scores', { chain: 'ethereum' }, /chain must be one of/],
    ['place_order', { mint: MINT, kind: 'limit_buy', triggerBasis: 'pct', triggerValue: 20, amount: 0.05 }, /needs an absolute level/],
    ['place_order', { mint: MINT, kind: 'moon', triggerBasis: 'pct', triggerValue: 1, amount: 1 }, /kind must be one of/],
  ];
  for (const [name, args, re] of bad) {
    const r = await tools.call(name, args);
    assert.equal(r.ok, false, `${name} ${JSON.stringify(args)} should be refused`);
    assert.match(r.text, re, `${name}: ${r.text}`);
  }
  assert.equal(calls.buys.length + calls.sells.length + calls.orders.length, 0, 'not one of them reached the app');

  // A field nobody agreed to read must never ride along into a trade.
  const smuggled = await tools.call('buy_token', { mint: MINT, amount: 0.01, feeBps: 0, slippage: 99 });
  assert.equal(smuggled.ok, false);
  assert.match(smuggled.text, /does not take feeBps, slippage/);
  assert.equal(calls.buys.length, 0);
  ok('bad arguments are refused with the reason, and an unknown field is refused rather than ignored');
}

// ── the access ladder reaches the tools themselves ───────────────────────
{
  setup();
  access = 'read';
  for (const name of ['buy_token', 'sell_token', 'place_order', 'cancel_orders']) {
    const r = await tools.call(name, { mint: MINT, amount: 0.01, percent: 50, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 20 });
    assert.equal(r.ok, false, `${name} on a read connection`);
    assert.match(r.text, /read only/i);
  }
  assert.equal(calls.buys.length + calls.sells.length + calls.orders.length + calls.cancels.length, 0);
  // Reads still work, and say which mode they are in.
  const w = await tools.call('get_wallet', {});
  assert.equal(w.ok, true);
  assert.match(w.text, /READ ONLY/, 'a read-only connection is told it cannot trade at all — not that it is in paper, which would invite it to try');
  assert.equal(w.data.mode, 'read-only');
  ok('a read-only connection is refused every trade tool inside the tool layer too, not only at the door');
}

// ── paper never touches the live pipeline ────────────────────────────────
{
  setup();
  access = 'paper';
  const b = await tools.call('buy_token', { mint: MINT, amount: 0.05 });
  assert.equal(b.ok, true);
  assert.deepEqual(calls.buys, [{ mint: MINT, amount: 0.05, paper: true, chain: 'solana' }], 'paper is passed down, not assumed');
  assert.match(b.text, /Paper buy/);
  const s = await tools.call('sell_token', { mint: MINT, percent: 50 });
  assert.equal(calls.sells[0].paper, true);
  assert.match(s.text, /Paper sell/);
  // Paper is not bounded by the value caps — a record built under tighter
  // limits measures a strategy nobody intends to run.
  const big = await tools.call('buy_token', { mint: MINT, amount: 999 });
  assert.equal(big.ok, true);
  assert.equal(calls.buys.at(-1).amount, 999);
  const pos = await tools.call('get_positions', {});
  assert.deepEqual(pos.data, { paper: true, chain: 'solana' }, 'and positions read the paper book');
  ok('a paper connection passes paper all the way down, reads the paper book, and is not held to the spending caps');
}

// ── a read-only connection reads the book the APP is using ───────────────
// 09-24: a read-only connection on a live app read the paper book and said
// the wallet held nothing while it held a coin.
{
  setup({ walletInfo: { appMode: 'live' } });
  access = 'read';
  assert.deepEqual((await tools.call('get_positions', {})).data, { paper: false, chain: 'solana' }, 'live app: the real book');
  setup({ walletInfo: { appMode: 'paper' } });
  access = 'read';
  assert.deepEqual((await tools.call('get_positions', {})).data, { paper: true, chain: 'solana' }, 'paper app: the paper book');
  setup({ walletInfo: {} });
  access = 'read';
  assert.equal((await tools.call('get_positions', {})).data.paper, true, 'an unknown app mode never claims the live book');
  ok('a read-only connection reads the book the app is using, not always the paper one');
}

// ── live spending is bounded, and reserved before the app is asked ───────
{
  setup();
  access = 'live';
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.25, maxTradesPerMinute: 10 };

  const over = await tools.call('buy_token', { mint: MINT, amount: 0.5 });
  assert.equal(over.ok, false);
  assert.match(over.text, /0\.1 per-trade limit/);
  assert.equal(calls.buys.length, 0, 'a refusal never reaches the app');

  for (let i = 0; i < 2; i++) assert.equal((await tools.call('buy_token', { mint: MINT, amount: 0.1 })).ok, true);
  assert.equal(calls.buys.length, 2);
  const capped = await tools.call('buy_token', { mint: MINT, amount: 0.1 });
  assert.equal(capped.ok, false, '0.2 spent + 0.1 passes the 0.25 hourly cap');
  assert.match(capped.text, /hourly limit/);
  assert.equal(calls.buys.length, 2);

  // The reservation rule: the attempt is recorded BEFORE the app answers, so
  // two calls in flight cannot both read an allowance neither has spent.
  setup();
  budget = { maxBuySol: 1, hourlyCapSol: 1, maxTradesPerMinute: 10 };
  let release;
  answers.buy = new Promise((r) => (release = r));
  const a = tools.call('buy_token', { mint: MINT, amount: 0.6 });
  const b = tools.call('buy_token', { mint: MINT, amount: 0.6 });
  release({ ok: true, message: 'bought' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, 'exactly one of two concurrent buys passed the cap');
  assert.equal(calls.buys.length, 1, 'and only one reached the app');

  // The rate limit counts every trade, buy or sell.
  setup();
  budget = { maxBuySol: 1, hourlyCapSol: 10, maxTradesPerMinute: 2 };
  assert.equal((await tools.call('sell_token', { mint: MINT, percent: 10 })).ok, true);
  assert.equal((await tools.call('sell_token', { mint: MINT, percent: 10 })).ok, true);
  const third = await tools.call('sell_token', { mint: MINT, percent: 10 });
  assert.equal(third.ok, false);
  assert.match(third.text, /2 trades in a minute/);
  ok('live buys meet the per-trade and hourly caps, the allowance is reserved before the app is asked, and the rate limit counts sells too');
}

// ── a limit buy commits funds, so it meets the same caps ─────────────────
{
  setup();
  access = 'live';
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 10 };
  const over = await tools.call('place_order', { mint: MINT, kind: 'limit_buy', triggerBasis: 'price_sol', triggerValue: 0.001, amount: 5 });
  assert.equal(over.ok, false, 'an order that would spend 5 SOL when it fires is not a way around a 0.1 cap');
  assert.equal(calls.orders.length, 0);
  // An exit is never value-capped: the worst case is a sale into the user's
  // own wallet.
  const stop = await tools.call('place_order', { mint: MINT, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 });
  assert.equal(stop.ok, true);
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].paper, false);
  ok('a limit buy is checked against the buy caps; a stop loss, which only ever sells, is not');
}

{
  // MCP-1 (audit 2026-09-23): arming a sell-type order still counts against
  // the per-minute rate limit, so a live agent cannot arm unlimited
  // stop_loss/take_profit/limit_sell orders in a burst.
  setup();
  access = 'live';
  budget = { maxBuySol: 1, hourlyCapSol: 10, maxTradesPerMinute: 2 };
  const a = await tools.call('place_order', { mint: MINT, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 });
  const b = await tools.call('place_order', { mint: MINT, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 50, amount: 100 });
  const c = await tools.call('place_order', { mint: MINT, kind: 'limit_sell', triggerBasis: 'price_sol', triggerValue: 0.001, amount: 100 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, false, 'the third arming in the minute is over the rate limit');
  assert.match(c.text ?? c.message ?? JSON.stringify(c), /trades in a minute/);
  assert.equal(calls.orders.length, 2, 'only the two that passed the limit were armed');
  ok('arming sell-type orders is rate-limited, not just limit buys');
}

// ── reads pass their arguments through and say what they are ─────────────
{
  setup({ token: null, scoutWallet: null });
  access = 'read';
  const missing = await tools.call('get_token', { mint: MINT });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /could not read that token/);
  const noRec = await tools.call('get_wallet_record', { address: WALLET });
  assert.equal(noRec.ok, false);
  assert.match(noRec.text, /Read from the chain/, 'and says how to fill the record in');

  setup();
  const scores = await tools.call('get_wallet_scores', { chain: 'bnb', window: 'month', limit: 5, onlyWorthALook: true });
  assert.equal(scores.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, ['bnb', 'month', 5, true], 'every argument reaches the host as given');
  assert.match(scores.text, /not an edge/, 'and the answer repeats what the score is not');
  const hist = await tools.call('get_trade_history', {});
  assert.deepEqual(calls.reads.at(-1).args, [25], 'the documented default is the one used');
  assert.match(hist.text, /already include fees/);
  ok('reads pass their arguments through unchanged, default as documented, and each answer carries the caveat the number needs');
}

// ── three chains, where the app has three ────────────────────────────────
{
  setup();
  access = 'live';
  budget = { maxBuySol: 10, hourlyCapSol: 100, maxTradesPerMinute: 60 };
  const EVM_TOKEN = '0x' + 'ab'.repeat(20);

  // An EVM address is refused on Solana and vice versa — a buy that fell
  // through to the wrong chain would spend SOL on another chain's address.
  assert.match((await tools.call('buy_token', { mint: EVM_TOKEN, amount: 0.1 })).text, /not a Solana mint/);
  assert.match((await tools.call('buy_token', { mint: MINT, amount: 0.1, chain: 'bnb' })).text, /not a contract address on BNB/);
  assert.equal(calls.buys.length, 0);

  // The right pairing routes, and the chain travels all the way down.
  assert.equal((await tools.call('buy_token', { mint: EVM_TOKEN, amount: 0.1, chain: 'bnb' })).ok, true);
  assert.deepEqual(calls.buys.at(-1), { mint: EVM_TOKEN, amount: 0.1, paper: false, chain: 'bnb' });
  assert.equal((await tools.call('sell_token', { mint: EVM_TOKEN, percent: 50, chain: 'robinhood' })).ok, true);
  assert.equal(calls.sells.at(-1).chain, 'robinhood');
  // EVM addresses are stored lower-cased, as the rest of the app keys them.
  await tools.call('buy_token', { mint: '0x' + 'AB'.repeat(20), amount: 0.1, chain: 'bnb' });
  assert.equal(calls.buys.at(-1).mint, EVM_TOKEN, 'the address is lower-cased on the way in');

  // Reads follow the chain too.
  await tools.call('get_positions', { chain: 'bnb' });
  assert.deepEqual(calls.reads.at(-1).args, [false, 'bnb']);
  await tools.call('get_token', { mint: EVM_TOKEN, chain: 'robinhood' });
  assert.deepEqual(calls.reads.at(-1).args, [EVM_TOKEN, 'robinhood']);
  await tools.call('find_tokens', { list: 'new', chain: 'bnb' });
  assert.deepEqual(calls.reads.at(-1).args, ['new', 20, 'bnb']);

  // The four Solana-only tools take no chain at all, so passing one is an
  // unknown field rather than a silently ignored hint.
  for (const [name, args] of [
    ['place_order', { mint: MINT, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 20, amount: 100, chain: 'bnb' }],
    ['cancel_orders', { mint: MINT, chain: 'bnb' }],
    ['get_chart', { mint: MINT, chain: 'bnb' }],
    ['get_token_links', { mint: MINT, chain: 'bnb' }],
  ]) {
    const r = await tools.call(name, args);
    assert.equal(r.ok, false, `${name} should refuse a chain it cannot honour`);
    assert.match(r.text, /does not take chain/, `${name}: ${r.text}`);
  }
  ok('trades and reads route to all three chains, an address of the wrong shape is refused, and the Solana-only tools refuse a chain outright');
}

// ── the four readers added 2026-09-21 ────────────────────────────────────
{
  setup();
  access = 'read';
  const chart = await tools.call('get_chart', { mint: MINT, interval: '5m', limit: 50 });
  assert.equal(chart.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, [MINT, '5m', 50]);
  assert.match(chart.text, /5m candles, oldest first/);
  await tools.call('get_chart', { mint: MINT });
  assert.deepEqual(calls.reads.at(-1).args, [MINT, '1m', 120], 'the documented defaults are the ones used');
  assert.match((await tools.call('get_chart', { mint: MINT, interval: '3h' })).text, /interval must be one of/);

  const runners = await tools.call('get_runner_alerts', { chain: 'bnb', limit: 5 });
  assert.equal(runners.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, ['bnb', 5]);
  assert.match(runners.text, /most flagged launches still do not graduate/, 'a flag is never reported as a prediction');

  const calls_ = await tools.call('get_callouts', {});
  assert.equal(calls_.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, [20]);
  assert.match(calls_.text, /what THEY report about themselves/, 'pump’s own numbers are labelled as pump’s');
  assert.match(calls_.text, /coinCallouts is the COIN’s callout count/, 'the coin’s call count is never passed off as the caller’s (2026-09-26)');

  // "Nobody has looked yet" and "there is nothing there" are different, and
  // each says which — an empty chart is not a flat price.
  setup({ chart: [], tokenLinks: null, callouts: null });
  assert.match((await tools.call('get_chart', { mint: MINT })).text, /may have none/);
  assert.match((await tools.call('get_token_links', { mint: MINT })).text, /Look it up with get_token first/);
  assert.match((await tools.call('get_callouts', {})).text, /not answering right now/);
  ok('the four readers pass their arguments, default as documented, and tell an empty answer apart from an unread one');
}

// ── $Krypto Mode ─────────────────────────────────────────────────────────
{
  setup();
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 60 };
  access = 'read';
  assert.equal((await tools.call('get_krypto_sessions', {})).ok, true, 'reading sessions is a read tool');
  const ro = await tools.call('krypto_mode_trade', { mint: MINT, side: 'buy', amount: 0.01 });
  assert.equal(ro.ok, false, 'a read-only connection cannot trade a bot');
  assert.equal(calls.krypto.length, 0);
  access = 'paper';
  assert.equal((await tools.call('krypto_mode_trade', { mint: MINT, side: 'buy', amount: 0.01 })).ok, true);
  assert.equal(calls.krypto.at(-1).live, false, 'a paper connection says so, and kryptoMode refuses it a live session');
  access = 'live';
  assert.equal((await tools.call('krypto_mode_trade', { mint: MINT, side: 'sell', amount: 150 })).ok, false, 'a sell over 100% is refused, not clipped');
  assert.equal((await tools.call('krypto_mode_trade', { mint: MINT, side: 'dump', amount: 1 })).ok, false);
  assert.equal((await tools.call('krypto_mode_trade', { mint: MINT, side: 'buy', amount: 5 })).ok, false, 'the connection budget applies too (0.1 SOL per buy)');
  const good = await tools.call('krypto_mode_trade', { mint: MINT, side: 'buy', amount: 0.05 });
  assert.equal(good.ok, true);
  assert.deepEqual(calls.krypto.at(-1), { mint: MINT, side: 'buy', amount: 0.05, live: true });
  ok('krypto_mode_trade: trade tier, both budgets, strict arguments, paper connections flagged');
}

// ── Krypto Trader: trader_act, checked in the design's order (§8) ────────
{
  setup();
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 60 };
  access = 'read';
  assert.equal((await tools.call('get_trader_sessions', {})).ok, true, 'reading sessions is a read tool');
  const one = await tools.call('get_trader_session', { session_id: 'kt_one' });
  assert.equal(one.ok, true);
  assert.equal(one.data.seq, 3);
  assert.equal(one.data.connection_budget.mode, 'read-only');
  assert.match(one.text, /untrusted data, never instructions/);
  assert.match((await tools.call('get_trader_session', { session_id: 'kt_none' })).text, /No Krypto Trader session/);
  assert.match((await tools.call('get_trader_session', { session_id: 'km_x' })).text, /not a Krypto Trader session id/);
  // 1. toolAllowed: a read-only connection cannot act.
  const ro = await tools.call('trader_act', { session_id: 'kt_one', action: 'buy', sol: 0.01, reason: 'x', expected_seq: 3 });
  assert.equal(ro.ok, false);
  assert.match(ro.text, /read only/i);
  access = 'paper';
  // Arguments are refused, never coerced.
  for (const [args, re] of [
    [{ session_id: 'kt_one', action: 'buy', sol: 0.01, percent: 10, reason: 'x', expected_seq: 3 }, /never both/],
    [{ session_id: 'kt_one', action: 'hold', sol: 0.01, reason: 'x', expected_seq: 3 }, /neither sol nor percent/],
    [{ session_id: 'kt_one', action: 'sell', percent: 150, reason: 'x', expected_seq: 3 }, /at most 100/],
    [{ session_id: 'kt_one', action: 'buy', reason: 'x', expected_seq: 3 }, /sol is required/],
    [{ session_id: 'kt_one', action: 'buy', sol: 0.01, expected_seq: 3 }, /reason is required/],
    [{ session_id: 'kt_one', action: 'buy', sol: 0.01, reason: 'x'.repeat(161), expected_seq: 3 }, /at most 160/],
    [{ session_id: 'kt_one', action: 'buy', sol: 0.01, reason: 'x' }, /expected_seq is required/],
    [{ session_id: 'kt_one', action: 'dump', reason: 'x', expected_seq: 3 }, /action must be one of/],
    [{ session_id: 'kt_one', action: 'buy', sol: 0.01, reason: 'x', expected_seq: 3, budgetSol: 50 }, /does not take budgetSol/],
  ]) {
    const r = await tools.call('trader_act', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.text, re, r.text);
  }
  // 2. The session exists, is MCP-driven and running.
  assert.match((await tools.call('trader_act', { session_id: 'kt_none', action: 'hold', reason: 'x', expected_seq: 0 })).text, /No Krypto Trader session/);
  setup({ gate: { driver: 'ai' } });
  access = 'paper';
  assert.match((await tools.call('trader_act', { session_id: 'kt_one', action: 'hold', reason: 'x', expected_seq: 3 })).text, /driven by an AI key, not MCP/);
  setup({ gate: { status: 'paused' } });
  access = 'live';
  assert.match((await tools.call('trader_act', { session_id: 'kt_one', action: 'buy', sol: 0.01, reason: 'x', expected_seq: 3 })).text, /paused.*Only the user can resume it/);
  // 3. T13: a paper connection cannot move a live session.
  setup({ gate: { mode: 'live' } });
  access = 'paper';
  const t13 = await tools.call('trader_act', { session_id: 'kt_one', action: 'sell', percent: 50, reason: 'x', expected_seq: 3 });
  assert.equal(t13.ok, false);
  assert.match(t13.text, /LIVE and this connection is in PAPER/);
  assert.equal(calls.trader.length, 0, 'T13: nothing reached the session');
  // 4. T27: a stale seq is refused before any budget is spent.
  setup({ gate: { mode: 'live' } });
  access = 'live';
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 60 };
  const t27 = await tools.call('trader_act', { session_id: 'kt_one', action: 'buy', sol: 0.05, reason: 'x', expected_seq: 2 });
  assert.equal(t27.ok, false);
  assert.match(t27.text, /Stale: the session is at seq 3, not 2/);
  assert.equal(calls.trader.length, 0);
  assert.equal(tools.recentAttempts().length, 0, 'a stale call used no budget slot');
  // 5. The connection budget (live session, live connection).
  assert.match((await tools.call('trader_act', { session_id: 'kt_one', action: 'buy', sol: 0.5, reason: 'x', expected_seq: 3 })).text, /0\.1 per-trade limit/);
  assert.equal(calls.trader.length, 0);
  // 6 + 7. Through to the session, as an intent.
  const good = await tools.call('trader_act', { session_id: 'kt_one', action: 'buy', sol: 0.05, reason: 'dip bought', expected_seq: 3 });
  assert.equal(good.ok, true, good.text);
  assert.deepEqual(calls.trader[0], { id: 'kt_one', intent: { action: 'buy', sol: 0.05, reason: 'dip bought', tag: 'add' }, expectedSeq: 3 });
  assert.equal(good.data.seq, 4, 'the answer carries the next seq');
  const sell = await tools.call('trader_act', { session_id: 'kt_one', action: 'sell', percent: 25, reason: 'trim', expected_seq: 3 });
  assert.deepEqual(calls.trader[1].intent, { action: 'sell', pct: 25, reason: 'trim', tag: 'ai' }, 'a sell is a percent of the SESSION’s bag');
  assert.equal(sell.ok, true);
  // A hold is logged and takes no trade slot.
  const before = tools.recentAttempts().length;
  assert.equal((await tools.call('trader_act', { session_id: 'kt_one', action: 'hold', reason: 'nothing to do', expected_seq: 3 })).ok, true);
  assert.equal(tools.recentAttempts().length, before, 'a hold uses no slot');
  assert.deepEqual(calls.trader[2].intent, { action: 'hold', reason: 'nothing to do' });
  ok('trader_act: read tier refused; bad args refused; not-MCP / not-running refused; T13 paper cannot move live; T27 stale seq refused before the budget; budget, then the session');
}

// ── the AI desk (2026-10-28) ─────────────────────────────────────────────
{
  setup();
  access = 'read';
  // Reading the feed is a read; deciding and selling a copy are trades.
  let r = await tools.call('wait_for_events', { cursor: 4, waitSec: 10, kinds: ['copy', 'decision'] });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.desk[0], { name: 'poll', cursor: 4, waitMs: 10_000, kinds: ['copy', 'decision'] });
  assert.match(r.text, /^1 event\. Pass cursor 9 next time\. 1 decision is waiting on you/);
  r = await tools.call('wait_for_events', {});
  assert.equal(calls.desk[1].cursor, null);
  assert.equal(calls.desk[1].waitMs, 25_000, 'the default wait');
  assert.match((await tools.call('wait_for_events', { waitSec: 60 })).text, /at most 50/);
  assert.match((await tools.call('wait_for_events', { kinds: ['gossip'] })).text, /kinds must be a list of/);
  assert.equal((await tools.call('get_pending_decisions', {})).ok, true);
  assert.match((await tools.call('decide_trade', { id: 'ai_3', verdict: 'skip', reason: 'x' })).text, /read only/);
  assert.match((await tools.call('sell_copy', { configId: 'cfgPaper', mint: MINT, percent: 50, reason: 'x' })).text, /read only/);

  access = 'paper';
  assert.match((await tools.call('decide_trade', { id: '12', verdict: 'skip', reason: 'x' })).text, /decision id like ai_12/);
  assert.match((await tools.call('decide_trade', { id: 'ai_3', verdict: 'maybe', reason: 'x' })).text, /verdict must be one of/);
  assert.match((await tools.call('decide_trade', { id: 'ai_3', verdict: 'buy', sizeSol: 1, reason: 'x', feeBps: 0 })).text, /does not take feeBps/);
  r = await tools.call('decide_trade', { id: 'ai_3', verdict: 'buy', sizeSol: 0.02, reason: 'half' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.desk.at(-1), { name: 'decide', id: 'ai_3', v: { verdict: 'buy', reason: 'half', sizeSol: 0.02 } });

  // sell_copy: the follow's own mode decides what the connection needs.
  assert.match((await tools.call('sell_copy', { configId: 'nope', mint: MINT, percent: 50, reason: 'x' })).text, /No follow nope/);
  assert.match((await tools.call('sell_copy', { configId: 'cfgLive', mint: MINT, percent: 50, reason: 'x' })).text, /LIVE and this connection is in PAPER/);
  r = await tools.call('sell_copy', { configId: 'cfgPaper', mint: MINT, percent: 50, reason: 'faded' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.desk.at(-1), { name: 'sellCopy', configId: 'cfgPaper', mint: MINT, percent: 50, reason: 'faded' });
  access = 'live';
  assert.equal((await tools.call('sell_copy', { configId: 'cfgLive', mint: MINT, percent: 50, reason: 'x' })).ok, true);
  // A paper connection may not cancel advanced orders: they are always real.
  access = 'paper';
  const cancelsBefore = calls.cancels.length;
  assert.match((await tools.call('cancel_orders', { mint: MINT })).text, /live-only/);
  assert.equal(calls.cancels.length, cancelsBefore);
  ok('the desk: the feed is a read; decide_trade and sell_copy are trades, checked and refused in words; a live follow needs a live connection');
}

// ── follows (2026-11-01): create and edit, narrow-only on live ──────────
const LEAD_A = 'LeadA111111111111111111111111111111111111';
const LEAD_B = 'LeadB111111111111111111111111111111111111';
const LEAD_C = 'LeadC111111111111111111111111111111111111';
{
  // A read-only connection changes nothing.
  setup();
  access = 'read';
  assert.match((await tools.call('create_follow', { wallet: LEAD_A })).text, /read only/);
  assert.match((await tools.call('pause_follow', { configId: 'cp_1' })).text, /read only/);
  assert.equal(saves.length, 0);

  // Paper: born switched on, from the Follow page's defaults plus what was sent.
  setup();
  access = 'paper';
  let r = await tools.call('create_follow', { wallet: LEAD_A, label: 'Alpha', sizeValue: 0.2, exitStopLossPct: 30 });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Created a paper follow of LeadA1… \(Alpha\), switched on/);
  assert.equal(r.data.configId, 'cp_1');
  const a = follows[0];
  assert.equal(a.mode, 'paper');
  assert.equal(a.enabled, true, 'a paper follow may be created switched on');
  assert.equal(a.sizeValue, 0.2);
  assert.equal(a.maxTradeSol, 0.2, 'the cap is derived from the size, as the Follow page derives it');
  assert.equal(a.exitStopLossPct, 30);
  assert.equal(a.walletId, null, 'the AI never picks the wallet copies sign with');
  assert.deepEqual(notices.at(-1), { title: 'AI created a follow', line: 'AI created a paper follow of LeadA1… (Alpha) on Solana, switched on' });
  // enabled:false is honoured on paper.
  r = await tools.call('create_follow', { wallet: LEAD_B, enabled: false });
  assert.equal(r.ok, true);
  assert.equal(follows[1].enabled, false);
  // The same wallet twice is the save path's refusal, passed through.
  assert.match((await tools.call('create_follow', { wallet: LEAD_A })).text, /already following/);

  // A paper connection does not set up live follows, even disarmed ones.
  const before = saves.length;
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, mode: 'live' })).text, /needs a live connection/);
  // validateConfig's own words come back, and nothing is saved.
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, maxTradeSol: 30 })).text, /Max per trade must be between 0 and 25 SOL/);
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, direction: 'watch', mode: 'live' })).text, /needs a live connection/);
  assert.match((await tools.call('create_follow', { wallet: 'nope' })).text, /not a wallet address on Solana/);
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, sizeValue: '0.1' })).text, /sizeValue must be a number/);
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, sizeValue: null })).text, /cannot be switched off/);
  // Fields the AI never sets are refused with the reason, not as typos.
  r = await tools.call('create_follow', { wallet: LEAD_C, walletId: 'w2' });
  assert.match(r.text, /cannot set walletId — the wallet copies sign with is for the user to change, in the app/);
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, ai: { entries: true } })).text, /whether the AI decides its trades/);
  assert.match((await tools.call('create_follow', { wallet: LEAD_C, fomoSource: 'top' })).text, /the convergence crowd/);
  assert.equal(saves.length, before, 'not one of the refusals reached the save');
  ok('create_follow: a paper follow is born switched on from the Follow page defaults; bad settings, signing wallet, AI gate and live-from-paper are refused before any save');
}

{
  // LIVE: always saved switched off, whatever was asked, and said so.
  setup();
  access = 'live';
  const r = await tools.call('create_follow', { wallet: LEAD_A, label: 'Alpha', mode: 'live', enabled: true, sizeValue: 0.2 });
  assert.equal(r.ok, true, r.text);
  assert.equal(saves[0].enabled, false, 'saved disarmed by mcpTools itself — not left to copyTrade.upsert');
  assert.equal(follows[0].mode, 'live');
  assert.equal(follows[0].enabled, false);
  assert.match(r.text, /LIVE follow .* saved switched OFF \(disarmed\)/);
  assert.match(r.text, /You asked for it switched on; below Full control a live follow the AI creates is always saved off/);
  assert.match(r.text, /until the user switches it on themselves in the app’s Following page/);
  assert.match(notices.at(-1).line, /AI created a live follow of LeadA1… \(Alpha\) on Solana, saved switched OFF — the user must switch it on in Following/);
  // Resuming it is the user's.
  const res = await tools.call('resume_follow', { configId: 'cp_1' });
  assert.equal(res.ok, false);
  assert.match(res.text, /LIVE follow.*only the user can do that, in the app/);
  assert.match((await tools.call('update_follow', { configId: 'cp_1', enabled: true })).text, /switching it back on \(only the user arms a live follow, unless they give the AI Full control\)/);
  assert.equal(follows[0].enabled, false);
  assert.equal(saves.length, 1);
  ok('create_follow live: saved switched off even when asked on, the answer says the user must arm it, and neither resume_follow nor update_follow can arm it');
}

{
  // An armed live follow (the user switched it on) the AI may only narrow.
  setup();
  access = 'live';
  await tools.call('create_follow', {
    wallet: LEAD_A,
    label: 'Alpha',
    mode: 'live',
    sizeValue: 0.2,
    maxTradeSol: 0.3,
    dailyLossLimitSol: 0.9,
    dailyTradeLimit: 20,
    maxCopiesPerMinute: 10,
    walletLossStopSol: 0.8,
    exitStopLossPct: 25,
    blockedMints: [MINT],
    activeFromMin: 480,
    activeToMin: 1320,
  });
  follows[0].enabled = true; // the user armed it in the app
  const id = follows[0].id;
  const base = { ...follows[0] };
  const widen = [
    [{ sizeValue: 0.25 }, /sizeValue 0\.2 → 0\.25 \(higher\)/],
    [{ maxTradeSol: 0.5 }, /maxTradeSol 0\.3 → 0\.5 \(higher\)/],
    [{ dailyLossLimitSol: 5 }, /dailyLossLimitSol .* \(higher\)/],
    [{ dailyLossLimitSol: null }, /dailyLossLimitSol 0\.9 → off \(removed\)/],
    [{ dailyLossLimitSol: 0 }, /dailyLossLimitSol 0\.9 → off \(removed\)/],
    [{ dailyTradeLimit: null }, /dailyTradeLimit 20 → off \(removed\)/],
    [{ maxCopiesPerMinute: null }, /maxCopiesPerMinute 10 → off \(removed\)/],
    [{ dailyTradeLimit: 400 }, /dailyTradeLimit 20 → 400 \(higher\)/],
    [{ maxCopiesPerMinute: 30 }, /maxCopiesPerMinute 10 → 30 \(higher\)/],
    [{ walletLossStopSol: 2 }, /walletLossStopSol 0\.8 → 2 \(higher\)/],
    [{ walletLossStopSol: null }, /walletLossStopSol 0\.8 → off \(removed\)/],
    [{ exitStopLossPct: null }, /exitStopLossPct 25 → off \(removed\)/],
    [{ exitStopLossPct: 40 }, /exitStopLossPct 25 → 40 \(looser\)/],
    [{ maxSlippagePct: 20 }, /maxSlippagePct 8 → 20 \(higher\)/],
    [{ minLiquidityUsd: null }, /minLiquidityUsd 5000 → off \(removed\)/],
    [{ minLiquidityUsd: 1000 }, /minLiquidityUsd 5000 → 1000 \(lower\)/],
    [{ minLeaderSellPct: 80 }, /minLeaderSellPct 50 → 80 \(fewer of their sells followed\)/],
    [{ exitMaxHoldMin: null }, /exitMaxHoldMin 30 → off \(removed\)/],
    [{ copySells: false }, /copySells on → off/],
    [{ blockedMints: null }, /blockedMints: 1 entry removed/],
    [{ activeFromMin: 0, activeToMin: 1439 }, /trading hours 08:00–22:00 → 00:00–23:59 \(longer\)/],
    [{ activeFromMin: null, activeToMin: null }, /trading hours 08:00–22:00 → all day \(longer\)/],
    [{ direction: 'reverse' }, /direction copy → reverse \(fixed on a live follow\)/],
    [{ sizing: 'proportional' }, /sizing fixed → proportional \(fixed on a live follow\)/],
    [{ delayMs: 500 }, /delayMs 0 → 500 \(fixed on a live follow\)/],
    [{ enabled: false, maxTradeSol: 1 }, /maxTradeSol 0\.3 → 1 \(higher\)/], // one widening edit refuses the whole call
  ];
  for (const [patch, re] of widen) {
    const r = await tools.call('update_follow', { configId: id, ...patch });
    assert.equal(r.ok, false, `${JSON.stringify(patch)} should be refused on a live follow`);
    assert.match(r.text, re, r.text);
    assert.match(r.text, /LIVE follow, so the AI may only make it safer\. Refused, and nothing was changed/);
    assert.match(r.text, /the user can make (that change|those changes) in the app, on the Following page/i);
  }
  assert.equal(saves.filter((s) => s.id).length, 0, 'no widening edit reached the save');
  assert.deepEqual(follows[0], base, 'and the follow is exactly as it was');
  // The followed wallet, the chain, paper/live and the signing wallet are the user's.
  for (const [patch, re] of [
    [{ wallet: LEAD_B }, /cannot set wallet — the followed wallet is for the user to change/],
    [{ mode: 'paper' }, /cannot set mode — paper or live is for the user/],
    [{ walletId: 'w2' }, /the wallet copies sign with/],
    [{ chain: 'bnb' }, /cannot set chain/],
  ]) {
    assert.match((await tools.call('update_follow', { configId: id, ...patch })).text, re);
  }
  assert.equal(saves.filter((s) => s.id).length, 0);
  ok('update_follow on a live follow: every widening edit (sizes, limits, stops removed or loosened, filters off, hours longer, direction, sizing, delay, re-arming) is refused whole with the reason; wallet, chain, mode and signing wallet are user-only');

  // Narrowing is allowed, in one call, and the user is told.
  const r = await tools.call('update_follow', {
    configId: id,
    label: 'Alpha tight',
    sizeValue: 0.15,
    maxTradeSol: 0.2,
    dailyLossLimitSol: 0.3,
    dailyTradeLimit: 5,
    maxCopiesPerMinute: 3,
    walletLossStopSol: 0.4,
    maxSlippagePct: 5,
    exitStopLossPct: 15,
    exitTrailingPct: 20,
    exitTakeProfitPct: 60,
    minLeaderSellPct: null,
    minLiquidityUsd: 20000,
    maxMarketCapUsd: 2000000,
    minTokenAgeSec: 60,
    maxBuysPerToken: 1,
    blockedMints: [MINT, LEAD_C],
    onlyPumpfun: true,
    onePositionPerCoin: true,
    exitOnMigration: true,
    copyOtherExits: true,
    exitOnCreatorSellPct: 20,
    activeFromMin: 540,
    activeToMin: 1020,
  });
  assert.equal(r.ok, true, r.text);
  const f = follows[0];
  assert.equal(f.enabled, true, 'narrowing leaves it armed — it did not arm anything');
  assert.equal(f.sizeValue, 0.15);
  assert.equal(f.maxTradeSol, 0.2);
  assert.equal(f.walletLossStopSol, 0.4, 'a smaller per-wallet stop is the safer one');
  assert.equal(f.exitStopLossPct, 15, 'a tighter stop-loss is the safer one');
  assert.equal(f.exitTrailingPct, 20, 'adding a trailing stop is allowed');
  assert.equal(f.minLeaderSellPct, null, 'following every sell out is allowed');
  assert.deepEqual(f.blockedMints, [MINT, LEAD_C]);
  assert.equal(f.label, 'Alpha tight');
  assert.match(r.text, /^Changed the LIVE follow of LeadA1…/);
  assert.equal(notices.at(-1).title, 'AI changed a follow');
  assert.match(notices.at(-1).line, /^AI changed the live follow of LeadA1… \(Alpha\): .*maxTradeSol 0\.3 → 0\.2/);
  // Nothing sent that changes nothing is said, not saved.
  const savesNow = saves.length;
  assert.match((await tools.call('update_follow', { configId: id, maxTradeSol: 0.2 })).text, /Nothing to change/);
  assert.match((await tools.call('update_follow', { configId: id })).text, /send at least one setting/);
  assert.equal(saves.length, savesNow);
  // Narrowing below the live floor is validateConfig's refusal, in its words.
  assert.match((await tools.call('update_follow', { configId: id, sizeValue: 0.001, maxTradeSol: 0.001 })).text, /smallest live copy/);
  ok('update_follow on a live follow: lower sizes and limits, a smaller stop, tighter or added exits, stricter filters and shorter hours are applied together, the follow stays as armed as it was, and the user is told');

  // Pausing is always allowed; resuming it is not.
  const p = await tools.call('pause_follow', { configId: id, reason: 'leader went quiet' });
  assert.equal(p.ok, true, p.text);
  assert.equal(follows[0].enabled, false);
  assert.match(notices.at(-1).line, /^AI paused the live follow of LeadA1… \(Alpha tight\): paused — leader went quiet$/);
  // Off may mean waiting to come back by itself: pausing it has to end that, or
  // the AI says it is off and it spends anyway.
  keptOff = [];
  assert.match((await tools.call('pause_follow', { configId: id })).text, /already switched off, and will stay off/);
  assert.deepEqual(keptOff, [id]);
  assert.equal((await tools.call('resume_follow', { configId: id })).ok, false);
  assert.equal(follows[0].enabled, false, 'a live follow stays off until the user switches it on');
  assert.match((await tools.call('pause_follow', { configId: 'cp_99' })).text, /No follow cp_99/);
  // A paper connection may pause a live follow too: it only makes it safer.
  follows[0].enabled = true;
  access = 'paper';
  assert.equal((await tools.call('pause_follow', { configId: id })).ok, true);
  assert.equal(follows[0].enabled, false);
  ok('pause_follow pauses a live follow from any trading connection and says so; resume_follow refuses a live one');
}

{
  // A paper follow may change freely — unless it still holds live copies.
  setup();
  access = 'paper';
  await tools.call('create_follow', { wallet: LEAD_A, sizeValue: 0.1, walletLossStopSol: 0.4, enabled: false });
  const id = follows[0].id;
  let r = await tools.call('update_follow', { configId: id, sizeValue: 1, maxTradeSol: 2, walletLossStopSol: null, exitStopLossPct: null, direction: 'reverse', delayMs: 2000, enabled: true });
  assert.equal(r.ok, true, r.text);
  assert.equal(follows[0].maxTradeSol, 2);
  assert.equal(follows[0].enabled, true, 'a paper follow may be switched back on');
  assert.equal(follows[0].direction, 'reverse');
  assert.match(notices.at(-1).line, /^AI changed the paper follow of LeadA1…: switched on, direction copy → reverse/);
  // Still checked like the form.
  assert.match((await tools.call('update_follow', { configId: id, sizeValue: 3 })).text, /Fixed size is above your own max per trade/);
  // Pause and resume a paper follow.
  assert.equal((await tools.call('pause_follow', { configId: id })).ok, true);
  r = await tools.call('resume_follow', { configId: id, reason: 'back to testing' });
  assert.equal(r.ok, true, r.text);
  assert.equal(follows[0].enabled, true);
  assert.match(notices.at(-1).line, /^AI resumed the paper follow of LeadA1…: switched on — back to testing$/);

  // A follow switched back to paper with live copies open: those copies'
  // exits run on its settings, so it is judged as live.
  setup({ liveOpen: { cp_1: 2 } });
  access = 'paper';
  await tools.call('create_follow', { wallet: LEAD_A, sizeValue: 0.2, exitStopLossPct: 20 });
  r = await tools.call('update_follow', { configId: 'cp_1', exitStopLossPct: null });
  assert.equal(r.ok, false);
  assert.match(r.text, /a paper follow with 2 live copies still open, so the AI may only make it safer/);
  assert.equal(follows[0].exitStopLossPct, 20);
  // Tightening could sell those live copies, and this connection may not spend.
  assert.match((await tools.call('update_follow', { configId: 'cp_1', exitStopLossPct: 10 })).text, /could sell live copies/);
  assert.equal(follows[0].exitStopLossPct, 20);
  access = 'live';
  assert.equal((await tools.call('update_follow', { configId: 'cp_1', exitStopLossPct: 10 })).ok, true, 'a live connection may tighten it');
  access = 'paper';
  assert.equal((await tools.call('pause_follow', { configId: 'cp_1' })).ok, true);
  assert.equal((await tools.call('resume_follow', { configId: 'cp_1' })).ok, true, 'and its new copies are paper, so it may be switched back on');
  assert.equal(follows[0].enabled, true);

  // A reverse follow's empty exit is its default, not "off": loosening the
  // default 20 % stop is still loosening.
  setup();
  access = 'live';
  await tools.call('create_follow', { wallet: LEAD_B, mode: 'live', direction: 'reverse', sizeValue: 0.2 });
  assert.match((await tools.call('update_follow', { configId: 'cp_1', exitStopLossPct: 30 })).text, /exitStopLossPct 20 → 30 \(looser\)/);
  assert.equal((await tools.call('update_follow', { configId: 'cp_1', exitStopLossPct: 10 })).ok, true);
  ok('update_follow on paper: any valid setting, switching it on, pause and resume; a paper follow holding live copies is judged as live; a reverse follow’s default exits count');
}

// ── research tools (2026-11-02): the app's own handlers, read tier ────────
{
  setup();
  access = 'read';
  const W = 'Lead1111111111111111111111111111111111111111'.slice(0, 44);
  // Each goes to its channel with the arguments the button would send.
  const cases = [
    ['get_wallets', {}, 'wallet:list', []],
    ['get_holdings', {}, 'wallet:holdings', []],
    ['get_portfolio', {}, 'portfolio:summary', [{ stale: true }]],
    ['search_tokens', { query: 'bonk' }, 'market:search', ['bonk']],
    ['get_sol_price', {}, 'market:solUsd', []],
    ['get_holders', { mint: MINT }, 'market:holders', [MINT, 50]],
    ['get_token_trades', { mint: MINT, limit: 10 }, 'market:trades', [MINT, 10]],
    ['analyse_holder_funding', { mint: MINT }, 'market:analyseHolders', [MINT, 40]],
    ['get_launch_intel', { mint: MINT }, 'market:launchIntel', [MINT]],
    ['scan_token_traders', { mint: MINT }, 'market:traderScan', [MINT]],
    ['get_creator_history', { creator: W }, 'market:creatorHistory', [W]],
    ['scout_scan', {}, 'scout:scanStatus', ['solana']],
    ['scout_scan', { action: 'start', hours: 24 }, 'scout:scan', ['solana', 24, 'recent']],
    ['scout_scan', { action: 'start', mode: 'winners' }, 'scout:scan', ['solana', 6, 'winners']],
    ['scout_scan', { action: 'cancel', chain: 'bnb' }, 'scout:scanCancel', ['bnb']],
    ['read_wallet_history', { action: 'start', address: W }, 'scout:readWallet', ['solana', W]],
    ['read_wallet_history', { address: W }, 'scout:readWalletStatus', ['solana', W]],
    ['replay_wallet', { action: 'start', address: W, week: true }, 'scout:replay', [W, { week: true, checks: false }]],
    ['replay_wallet', { address: W }, 'scout:replayStatus', [W]],
    ['get_scout_scorecard', {}, 'scout:scorecard', ['solana', null]],
    ['get_pump_leaderboard', {}, 'scout:pumpLeaderboard', ['weekly', false]],
    ['find_pump_user', { query: 'alice' }, 'scout:pumpUser', ['alice']],
    ['get_address_book', {}, 'book:list', []],
    ['get_watchlist', {}, 'watchlist:get', []],
    ['get_alerts', {}, 'alerts:list', []],
  ];
  for (const [name, args, channel, sent] of cases) {
    invoked = [];
    const r = await tools.call(name, args);
    assert.equal(r.ok, true, `${name}: ${r.text}`);
    assert.equal(invoked.length, 1, `${name} asks once`);
    assert.equal(invoked[0].channel, channel, `${name} → ${channel}`);
    assert.deepEqual(invoked[0].args, sent, `${name} sends what the button sends`);
  }
  // Bad arguments never reach a handler.
  invoked = [];
  for (const [name, args, why] of [
    ['get_holders', { mint: 'nope' }, /not a Solana mint/],
    ['scout_scan', { action: 'start', hours: 5 }, /1, 6 or 24/],
    ['replay_wallet', { address: '0xabc' }, /not a Solana address/],
    ['search_tokens', { query: '  ' }, /query is required/],
    ['get_copies', { state: 'failed' }, /state must be one of/],
  ]) {
    const r = await tools.call(name, args);
    assert.equal(r.ok, false, name);
    assert.match(r.text, why);
  }
  assert.equal(invoked.length, 0, 'a refused call asks nothing');
  // A handler's refusal comes back in its own words.
  setup({ handlers: { 'scout:scan': { ok: false, message: 'A scan is already running on solana' } } });
  access = 'read';
  const busy = await tools.call('scout_scan', { action: 'start' });
  assert.equal(busy.ok, false);
  assert.match(busy.text, /already running/);
  ok('research tools run the app’s own handlers with the button’s arguments, at read tier; bad arguments ask nothing; a refusal keeps its words');
}

// ── get_copies and the backtest ──────────────────────────────────────────
{
  const rows = [
    { id: 'a', configId: 'cp_1', mode: 'live', state: 'open' },
    { id: 'b', configId: 'cp_1', mode: 'paper', state: 'closed' },
    { id: 'c', configId: 'cp_2', mode: 'live', state: 'skipped' },
  ];
  setup({ copyRows: rows, follows: [{ id: 'cp_1', wallet: 'Lead1111111111111111111111111111111111111111'.slice(0, 44), mode: 'paper', enabled: true, maxTradeSol: 0.1, dailyLossLimitSol: 0.3 }] });
  access = 'read';
  assert.deepEqual((await tools.call('get_copies', {})).data.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual((await tools.call('get_copies', { mode: 'live', state: 'open' })).data.map((r) => r.id), ['a']);
  assert.deepEqual((await tools.call('get_copies', { configId: 'cp_1', limit: 1 })).data.map((r) => r.id), ['a']);
  invoked = [];
  assert.equal((await tools.call('backtest_follow', { action: 'start', configId: 'cp_1' })).ok, true);
  assert.deepEqual(invoked[0], { channel: 'copy:backtest', args: [{ id: 'cp_1' }, { week: false }] });
  invoked = [];
  await tools.call('backtest_follow', { action: 'start', configId: 'cp_1', delayMs: 2000 });
  assert.equal(invoked[0].args[0].config.delayMs, 2000, 'a saved follow with changes is backtested as a draft of itself');
  assert.equal(invoked[0].args[0].config.wallet, follows[0].wallet);
  invoked = [];
  await tools.call('backtest_follow', { action: 'start', wallet: 'Draft111111111111111111111111111111111111111'.slice(0, 44), sizeValue: 0.2 });
  assert.equal(invoked[0].args[0].config.sizeValue, 0.2, 'a draft carries its settings');
  assert.equal(invoked[0].args[0].config.mode, 'paper');
  assert.equal((await tools.call('backtest_follow', { action: 'start' })).ok, false, 'neither a follow nor a wallet');
  assert.equal((await tools.call('backtest_follow', { configId: 'cp_9' })).ok, false, 'an unknown follow');
  ok('get_copies filters by follow, state and mode; backtest_follow runs a saved follow, a saved follow with changes, or a draft');
}

// ── organising tools: paper and up ───────────────────────────────────────
{
  setup({ follows: [{ id: 'cp_1', wallet: WALLET, mode: 'paper', enabled: true }, { id: 'cp_2', wallet: 'Live1111111111111111111111111111111111111111'.slice(0, 44), mode: 'live', enabled: false }] });
  access = 'read';
  for (const name of ['save_contact', 'remove_contact', 'watch_wallet', 'save_scout_wallet', 'set_alert', 'remove_alert', 'set_paper_bankroll', 'reset_paper_copies', 'delete_follow']) {
    const r = await tools.call(name, {});
    assert.equal(r.ok, false, `${name} is refused on a read-only connection`);
    assert.match(r.text, /read only/i);
  }
  assert.equal(invoked.length, 0);
  access = 'paper';
  await tools.call('save_contact', { address: WALLET, name: 'Alpha', tags: ['fast'] });
  assert.deepEqual(invoked.at(-1), { channel: 'book:save', args: [{ address: WALLET, name: 'Alpha', note: '', tags: ['fast'] }] });
  await tools.call('watch_wallet', { address: WALLET, label: 'w' });
  assert.deepEqual(invoked.at(-1), { channel: 'watchlist:add', args: [WALLET, 'w'] });
  await tools.call('watch_wallet', { address: WALLET, remove: true });
  assert.deepEqual(invoked.at(-1), { channel: 'watchlist:remove', args: [WALLET] });
  await tools.call('set_alert', { kind: 'price_above', mint: MINT, threshold: 0.001 });
  assert.deepEqual(invoked.at(-1), { channel: 'alerts:create', args: [{ kind: 'price_above', mint: MINT, symbol: '', threshold: 0.001, repeat: false }] });
  await tools.call('set_paper_bankroll', { enabled: true, usd: 250 });
  assert.deepEqual(invoked.at(-1), { channel: 'copy:paperBankroll', args: [{ enabled: true, usd: 250, restart: undefined }] });
  assert.equal((await tools.call('set_paper_bankroll', { usd: 0 })).ok, false, 'out of range never reaches the engine');
  // Deleting: a paper follow from paper up; a live one needs Full control.
  const del = await tools.call('delete_follow', { configId: 'cp_1', reason: 'never copies' });
  assert.equal(del.ok, true, del.text);
  assert.deepEqual(invoked.at(-1), { channel: 'copy:remove', args: ['cp_1'] });
  assert.ok(notices.some((n) => /AI deleted the paper follow/.test(n.line) && /never copies/.test(n.line)));
  const n = invoked.length;
  const liveDel = await tools.call('delete_follow', { configId: 'cp_2' });
  assert.equal(liveDel.ok, false);
  assert.match(liveDel.text, /needs Full control/);
  assert.equal(invoked.length, n, 'nothing was asked');
  ok('organising tools need a trading connection, send the button’s arguments, and a live follow cannot be deleted below Full control');
}

// ── The audit of 2026-11-04 ──
{
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 4, followMaxCopySol: 0.1, followDailyLossSol: 0.5, followDailyCopies: 20 };
  const LIVE = 'Live1111111111111111111111111111111111111111'.slice(0, 44);
  const base = { id: 'cp_9', wallet: LIVE, chain: 'solana', mode: 'live', enabled: false, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.05, dailyLossLimitSol: 0.3, dailyTradeLimit: 10, maxSlippagePct: 25, delayMs: 0, label: '' };

  // The ceiling bounds the money out, not only the realised loss.
  setup({ follows: [{ ...base, dailyTradeLimit: 0 }] });
  access = 'full';
  const noCopies = await tools.call('resume_follow', { configId: 'cp_9' });
  assert.equal(noCopies.ok, false, 'no copy limit: nothing bounds the money out');
  assert.match(noCopies.text, /dailyTradeLimit is not set/);
  setup({ follows: [{ ...base, enabled: true }] });
  access = 'full';
  const removes = await tools.call('update_follow', { configId: 'cp_9', dailyTradeLimit: null });
  assert.equal(removes.ok, false, 'and it cannot take the limit away');
  assert.equal(follows[0].dailyTradeLimit, 10);
  assert.match((await tools.call('update_follow', { configId: 'cp_9', dailyTradeLimit: 500 })).text, /ceiling of 20 copies a day/);
  assert.equal((await tools.call('update_follow', { configId: 'cp_9', dailyTradeLimit: 20 })).ok, true, 'inside it is fine');

  // A follow's own stop is the user's, at any level.
  setup({ follows: [{ ...base, enabled: true, walletLossStopSol: 0.4 }] });
  access = 'full';
  const unstop = await tools.call('update_follow', { configId: 'cp_9', walletLossStopSol: null });
  assert.equal(unstop.ok, false);
  assert.match(unstop.text, /walletLossStopSol/);
  assert.equal(follows[0].walletLossStopSol, 0.4);

  // Paused by that stop: the AI does not switch it back on.
  setup({ follows: [{ ...base, pausedBy: 'stop', pausedReason: 'lost 0.4' }] });
  access = 'full';
  const after = await tools.call('resume_follow', { configId: 'cp_9' });
  assert.equal(after.ok, false);
  assert.match(after.text, /its own loss stop/);
  assert.equal(follows[0].enabled, false);

  // Live past a stop a person must clear.
  for (const why of ['loss_limit', 'kill_switch', 'debugger', 'program_upgrade', 'decoder_drift']) {
    setup({ liveStoppedBy: why });
    access = 'full';
    const r = await tools.call('set_trading_mode', { mode: 'live' });
    assert.equal(r.ok, false, why);
    assert.match(r.text, /Only the user can switch it back on/);
    assert.equal(invoked.length, 0, 'nothing reached the switch');
  }
  setup({ liveStoppedBy: 'user' });
  access = 'full';
  assert.equal((await tools.call('set_trading_mode', { mode: 'live' })).ok, true, 'an ordinary Paper may be switched back');

  // Paper means every chain.
  setup({});
  access = 'full';
  assert.equal((await tools.call('set_trading_mode', { mode: 'paper' })).ok, true);
  assert.deepEqual(invoked.map((x) => x.channel), ['live:setLive', 'evm:disarm', 'evm:disarm']);
  assert.deepEqual(invoked.slice(1).map((x) => x.args[0]).sort(), ['bnb', 'robinhood']);

  // A follow waiting to come back: asking for off means it stays off.
  setup({ follows: [{ ...base, rearmAt: Date.now() + 60_000, pausedBy: 'fails' }] });
  access = 'paper';
  const off = await tools.call('update_follow', { configId: 'cp_9', enabled: false });
  assert.equal(off.ok, true, off.text);
  assert.deepEqual(keptOff, ['cp_9']);
  assert.match(off.text, /will stay off/);

  // A paper connection cannot make live copies sell.
  setup({ follows: [{ ...base, enabled: true }] });
  access = 'paper';
  for (const edit of [{ exitMaxHoldMin: 1 }, { exitStopLossPct: 1 }, { exitOnMigration: true }]) {
    const r = await tools.call('update_follow', { configId: 'cp_9', ...edit });
    assert.equal(r.ok, false, JSON.stringify(edit));
    assert.match(r.text, /could sell live copies/);
  }
  assert.equal((await tools.call('update_follow', { configId: 'cp_9', maxSlippagePct: 10 })).ok, true, 'a stricter filter is still open to it');
  access = 'live';
  assert.equal((await tools.call('update_follow', { configId: 'cp_9', exitMaxHoldMin: 5 })).ok, true, 'a live connection may tighten an exit');

  // The user's saved open-copies limit may only go lower.
  setup({ execution: { maxOpenCopies: 5 } });
  access = 'full';
  for (const v of [0, 6]) assert.match((await tools.call('update_settings', { maxOpenCopies: v })).text, /may lower it, not raise or remove it/);
  assert.equal(invoked.length, 0);
  assert.equal((await tools.call('update_settings', { maxOpenCopies: 3 })).ok, true);
  setup({ execution: { maxOpenCopies: 0 } });
  access = 'full';
  assert.equal((await tools.call('update_settings', { maxOpenCopies: 3 })).ok, true, 'adding one is safer');
  ok('audit 11-04: the AI boundary');
}

// ── Full control (2026-11-02) ────────────────────────────────────────────
{
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 4, followMaxCopySol: 0.1, followDailyLossSol: 0.5, followDailyCopies: 20 };
  const LIVE = 'Live1111111111111111111111111111111111111111'.slice(0, 44);
  const live = (over = {}) => ({ id: 'cp_9', wallet: LIVE, chain: 'solana', mode: 'live', enabled: false, dailyTradeLimit: 10, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.05, dailyLossLimitSol: 0.2, dailyTradeLimit: 20, maxSlippagePct: 10, delayMs: 0, copySells: true, ...over });

  // Below Full control the old walls stand.
  setup({ follows: [live()] });
  access = 'live';
  for (const name of ['set_trading_mode', 'sell_all', 'select_wallet', 'update_settings']) {
    const r = await tools.call(name, name === 'set_trading_mode' ? { mode: 'live' } : {});
    assert.equal(r.ok, false, name);
    assert.match(r.text, /needs Full control/);
  }
  assert.equal((await tools.call('resume_follow', { configId: 'cp_9' })).ok, false, 'live cannot arm');
  assert.match((await tools.call('update_follow', { configId: 'cp_9', maxTradeSol: 0.08 })).text, /only make it safer/);
  assert.equal(invoked.length, 0);

  // Full control arms and widens — inside the ceiling.
  access = 'full';
  const armed = await tools.call('resume_follow', { configId: 'cp_9', reason: 'replay was positive' });
  assert.equal(armed.ok, true, armed.text);
  assert.equal(follows[0].enabled, true, 'switched on');
  assert.ok(notices.some((x) => /AI resumed the live follow/.test(x.line)));
  const wider = await tools.call('update_follow', { configId: 'cp_9', maxTradeSol: 0.1, sizeValue: 0.1 });
  assert.equal(wider.ok, true, wider.text);
  assert.equal(follows[0].maxTradeSol, 0.1);
  // Past the ceiling: refused whole.
  const over = await tools.call('update_follow', { configId: 'cp_9', maxTradeSol: 0.2, sizeValue: 0.2 });
  assert.equal(over.ok, false);
  assert.match(over.text, /follow ceiling/);
  assert.match(over.text, /maxTradeSol 0.2 is above the AI’s per-copy ceiling of 0.1/);
  assert.equal(follows[0].maxTradeSol, 0.1, 'nothing changed');
  const lossy = await tools.call('update_follow', { configId: 'cp_9', dailyLossLimitSol: 2 });
  assert.equal(lossy.ok, false);
  assert.match(lossy.text, /daily-loss ceiling of 0.5/);
  // A follow the USER armed above the ceiling can still be narrowed or relabelled.
  setup({ follows: [live({ enabled: true, maxTradeSol: 1, sizeValue: 1, dailyLossLimitSol: 3 })] });
  access = 'full';
  assert.equal((await tools.call('update_follow', { configId: 'cp_9', label: 'Big one' })).ok, true, 'a relabel is not a widening');
  assert.equal((await tools.call('update_follow', { configId: 'cp_9', maxTradeSol: 0.5, sizeValue: 0.5 })).ok, true, 'narrowing is always fine');
  assert.equal((await tools.call('update_follow', { configId: 'cp_9', maxTradeSol: 0.8, sizeValue: 0.8 })).ok, false, 'but widening it past the ceiling is not');
  // Arming one that is above the ceiling is refused.
  setup({ follows: [live({ maxTradeSol: 1, sizeValue: 1 })] });
  access = 'full';
  assert.match((await tools.call('resume_follow', { configId: 'cp_9' })).text, /follow ceiling/);
  assert.equal(follows[0].enabled, false);

  // create_follow: born armed with Full control, inside the ceiling only.
  setup();
  access = 'full';
  const made = await tools.call('create_follow', { wallet: LIVE, mode: 'live', enabled: true, sizeValue: 0.05, maxTradeSol: 0.05, dailyLossLimitSol: 0.2, dailyTradeLimit: 10 });
  assert.equal(made.ok, true, made.text);
  assert.match(made.text, /switched it on/);
  assert.equal(follows[0].enabled, true);
  assert.equal(saves[0].enabled, false, 'saved disarmed first, as upsert requires');
  setup();
  access = 'full';
  const big = await tools.call('create_follow', { wallet: LIVE, mode: 'live', enabled: true, sizeValue: 1, maxTradeSol: 1, dailyLossLimitSol: 0.2 });
  assert.equal(big.ok, false);
  assert.match(big.text, /Not created/);
  assert.equal(follows.length, 0, 'nothing saved');
  // No loss limit is the widest there is, so it cannot pass the ceiling.
  const noLimit = await tools.call('create_follow', { wallet: LIVE, mode: 'live', enabled: true, sizeValue: 0.05, maxTradeSol: 0.05 });
  assert.equal(noLimit.ok, false);
  assert.match(noLimit.text, /dailyLossLimitSol is not set/);
  assert.equal(follows.length, 0, 'nothing saved');
  // Without enabled:true it is still created off.
  assert.match((await tools.call('create_follow', { wallet: LIVE, mode: 'live', sizeValue: 0.05, maxTradeSol: 0.05, dailyLossLimitSol: 0.2 })).text, /saved switched OFF/);

  // delete_follow: a live follow goes with Full control, never with live copies open.
  setup({ follows: [live()], liveOpen: { cp_9: 2 } });
  access = 'full';
  const open = await tools.call('delete_follow', { configId: 'cp_9' });
  assert.equal(open.ok, false);
  assert.match(open.text, /2 live copies open/);
  assert.equal(invoked.length, 0);
  liveOpen = {};
  assert.equal((await tools.call('delete_follow', { configId: 'cp_9' })).ok, true);

  // The app-wide switches go to their own handlers and tell the user.
  setup();
  access = 'full';
  await tools.call('set_trading_mode', { mode: 'live', reason: 'user asked' });
  assert.deepEqual(invoked.at(-1), { channel: 'live:setLive', args: [true] });
  assert.ok(notices.some((x) => /AI switched the app to LIVE/.test(x.title)));
  await tools.call('sell_all', {});
  assert.equal(invoked.at(-1).channel, 'live:sellAll');
  await tools.call('sell_all', { dust: true });
  assert.equal(invoked.at(-1).channel, 'live:sellDust');
  await tools.call('select_wallet', { walletId: 'w2' });
  assert.deepEqual(invoked.at(-1), { channel: 'wallet:select', args: ['w2'] });
  ok('Full control: the four app-wide tools need it; it arms and widens live follows only inside the ceiling, a user-armed follow above it can still be narrowed, create can be born armed, delete never strands live copies');
}

// ── update_settings: the one settings door ───────────────────────────────
{
  setup();
  access = 'full';
  const r = await tools.call('update_settings', { mevMode: 'private', maxOpenCopies: 5 });
  assert.equal(r.ok, true, r.text);
  const sent = invoked.at(-1);
  assert.equal(sent.channel, 'settings:update');
  // The whole execution section goes back, with only the asked fields changed:
  // the live safety limits and the Paper/Live bit are what they were.
  assert.deepEqual(sent.args[0], { execution: { feeUrgency: 'normal', mevMode: 'private', maxLiveSol: 0.5, liveEnabled: true, maxOpenCopies: 5 } });
  assert.match(r.text, /mevMode fast → private/);
  assert.ok(notices.some((x) => x.title === 'AI changed settings'));
  invoked = [];
  for (const [args, why] of [
    [{ maxLiveSol: 5 }, /does not take maxLiveSol/],
    [{ liveEnabled: true }, /does not take liveEnabled/],
    [{ referrer: 'x' }, /does not take referrer/],
    [{ heliusApiKey: 'x' }, /does not take heliusApiKey/],
    [{ mevMode: 'yolo' }, /mevMode must be one of/],
    [{ liveSlippagePct: 80 }, /at most 50/],
    [{ maxOpenCopies: 2.5 }, /whole number/],
    [{ useJito: 'yes' }, /true or false/],
    [{}, /Nothing to change/],
  ]) {
    const x = await tools.call('update_settings', args);
    assert.equal(x.ok, false, JSON.stringify(args));
    assert.match(x.text, why);
  }
  assert.equal(invoked.length, 0, 'a refused change never reaches the store');
  ok('update_settings sends the stored execution section with only routing fields changed; limits, the mode, keys and the referrer are refused before the store');
}

// ── the never-list holds even if a tool asked for it ─────────────────────
{
  // A host handed a channel off the list must never be asked: the guard in
  // mcpTools refuses before invoke. Proven by a tool whose channel is fine,
  // and by the module's own list — no listed channel is a never channel.
  const mcp = await import('./.mcp.mjs');
  for (const c of mcp.MCP_NEVER_CHANNELS) assert.ok(!mcp.MCP_IPC_CHANNELS.includes(c), c);
  ok('no never-list channel is on the list mcpTools may invoke');
}

console.log(`\nmcptools: ${passed}/26 passed`);
