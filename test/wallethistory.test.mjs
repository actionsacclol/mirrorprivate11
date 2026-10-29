// Wallet history (walletHistory.ts): a wallet's recent swaps read from the
// chain into the Scout's record. Pinned here: the RPC is asked once for the
// listing and then in batches for the transactions; failed and out-of-window
// signatures are never read; trades are fed OLDEST-FIRST so a round trip
// closes; every trade carries its signature so a second read is all
// duplicates; non-swaps and unreadable transactions are counted, never fed;
// and the refusals (bad address, already running, no endpoint).

import assert from 'node:assert';
import * as history from './.wallethistory.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// A real base58 shape: the module refuses anything else (no lowercase L).
const W = 'Whae1111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MINT_A = 'MintA111111111111111111111111111111111111111';
const MINT_B = 'MintB111111111111111111111111111111111111111';
const MINT_C = 'MintC111111111111111111111111111111111111111';
const SOL = 1_000_000_000;
const NOW_S = Math.floor(Date.now() / 1000);

/** A router buy by W: `sol` out, 1000 tokens of `mint` in. */
const buyTx = (mint, sol, blockTime) => ({
  blockTime,
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10 * SOL, 0, 0],
    postBalances: [10 * SOL - sol * SOL - 5000, 0, 0],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 5, mint, owner: W, uiTokenAmount: { amount: '1000000000', decimals: 6, uiAmount: null } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [W, JUP, mint],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
});
/** The reverse: all 1000 tokens of `mint` out, `sol` in. */
const sellTx = (mint, sol, blockTime) => ({
  blockTime,
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10 * SOL, 0, 0],
    postBalances: [10 * SOL + sol * SOL - 5000, 0, 0],
    preTokenBalances: [{ accountIndex: 5, mint, owner: W, uiTokenAmount: { amount: '1000000000', decimals: 6, uiAmount: null } }],
    postTokenBalances: [{ accountIndex: 5, mint, owner: W, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: null } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [W, JUP, mint],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
});
/** A plain SOL transfer: no token leg, so not a swap. */
const transferTx = (blockTime) => ({
  blockTime,
  meta: { err: null, fee: 5000, preBalances: [10 * SOL, 0], postBalances: [9 * SOL - 5000, SOL], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
  transaction: {
    message: {
      accountKeys: [W, 'Someone111111111111111111111111111111111111'],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
});

// The chain, newest first as the RPC lists it. `old` is outside the week and
// must never be read; `bad` failed and must never be read either.
const TXS = {
  sigSellC: sellTx(MINT_C, 0.9, NOW_S - 100),
  sigBuyC: buyTx(MINT_C, 0.6, NOW_S - 200),
  sigXfer: transferTx(NOW_S - 250),
  sigBuyB: buyTx(MINT_B, 0.6, NOW_S - 300),
  sigBuyA: buyTx(MINT_A, 0.6, NOW_S - 400),
};
let listing = [
  { signature: 'sigSellC', err: null, blockTime: NOW_S - 100 },
  { signature: 'sigBuyC', err: null, blockTime: NOW_S - 200 },
  { signature: 'sigXfer', err: null, blockTime: NOW_S - 250 },
  { signature: 'sigBad', err: { InstructionError: [0, 'Custom'] }, blockTime: NOW_S - 280 },
  { signature: 'sigBuyB', err: null, blockTime: NOW_S - 300 },
  { signature: 'sigBuyA', err: null, blockTime: NOW_S - 400 },
  { signature: 'sigOld', err: null, blockTime: NOW_S - 30 * 24 * 3600 },
];
const calls = { list: 0, batches: [], sigs: [] };
let listFails = false;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const reply = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload });
  if (!Array.isArray(body)) {
    assert.equal(body.method, 'getSignaturesForAddress', `only the listing is a single call, got ${body.method}`);
    calls.list += 1;
    if (listFails) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'boom' };
    return reply({ jsonrpc: '2.0', id: body.id, result: listing });
  }
  calls.batches.push(body.length);
  return reply(
    body.map((req) => {
      assert.equal(req.method, 'getTransaction');
      const sig = req.params[0];
      calls.sigs.push(sig);
      assert.notEqual(sig, 'sigOld', 'a transaction older than the window is never read');
      assert.notEqual(sig, 'sigBad', 'a failed transaction is never read');
      return { jsonrpc: '2.0', id: req.id, result: TXS[sig] ?? null };
    }),
  );
};

// The record keeps a Solana address as the chain spells it (2026-10-22).
const book = () => history._store.wallets('solana').find((w) => w.address === W);
const fresh = () => {
  history._reset();
  history._store._reset();
  calls.list = 0;
  calls.batches = [];
  calls.sigs = [];
};

// ── the read: listing once, batches, oldest first, a trip closes ──────────
{
  fresh();
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  assert.equal(history.start(W, 'http://rpc.test').ok, false, 'a second read of the same wallet is refused while one runs');
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.running, false);
  assert.equal(calls.list, 1, 'one listing');
  assert.equal(st.signatures, 5, 'the failed one and the month-old one are dropped before any read');
  assert.deepEqual(calls.sigs, ['sigBuyA', 'sigBuyB', 'sigXfer', 'sigBuyC', 'sigSellC'], 'read oldest first, so a sell finds its buy on the book');
  assert.equal(st.read, 5);
  assert.equal(st.swaps, 4);
  assert.equal(st.notSwap, 1, 'a transfer is not a trade');
  assert.equal(st.unreadable, 0);
  assert.equal(st.fed, 4);
  assert.equal(st.duplicates, 0);
  assert.equal(st.calls, 2, 'one listing + one batch of five');
  assert.equal(st.oldestAt, (NOW_S - 400) * 1000, 'dated from the block, not the read');
  assert.equal(st.newestAt, (NOW_S - 100) * 1000);
  assert.equal(st.message, '');
  const w = book();
  assert.ok(w, 'the wallet has a record — three buys promoted it');
  const trips = w.days.reduce((n, d) => n + d.roundTrips, 0);
  assert.equal(trips, 1, 'the C buy (the promoting trade) and its sell make one round trip');
  ok('a read lists once, drops failed and old signatures, feeds oldest-first, and closes a trip');
}

// ── a second read is all duplicates ──────────────────────────────────────
{
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.swaps, 4);
  assert.equal(st.fed, 0, 'nothing new');
  assert.equal(st.duplicates, 4, 'every trade carries its signature, so the book refuses it the second time');
  const w = book();
  assert.equal(
    w.days.reduce((n, d) => n + d.roundTrips, 0),
    1,
    'a re-read does not double the record',
  );
  ok('a second read of the same wallet is refused trade by trade as duplicates');
}

// ── refusals and the quiet-wallet message ────────────────────────────────
{
  fresh();
  assert.equal(history.start('not-an-address', 'http://rpc.test').ok, false);
  assert.equal(history.start(W, '').ok, false, 'no endpoint, no read');
  listFails = true;
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  await history.wait(W);
  assert.match(history.status(W).message, /Could not list/);
  assert.equal(history.status(W).read, 0);
  listFails = false;
  // Two swaps only: read, counted, and the status says why nothing shows.
  fresh();
  listing = listing.filter((x) => x.signature === 'sigBuyA' || x.signature === 'sigBuyB');
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.swaps, 2);
  assert.match(st.message, /needs 3 before it gets a record/);
  ok('bad addresses, a missing endpoint and a failed listing are refused in words; a quiet wallet is explained');
}

// ── the deep read with a Helius endpoint (2026-10-23) ───────────────────
//
// getTransactionsForAddress hands back the transactions themselves, a page at
// a time, newest first. Pinned: no per-signature reads, pages followed by
// token, failed ones filtered server-side, fed oldest first, v1 asked for —
// and a key whose plan refuses it is read the standard way, and not asked
// again for an hour.
const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=test';
const signed = (tx, sig, slot) => ({ ...tx, slot, transaction: { ...tx.transaction, signatures: [sig] } });
{
  fresh();
  const standard = globalThis.fetch;
  const deepCalls = [];
  const PAGE1 = [signed(TXS.sigSellC, 'sigSellC', 50), signed(TXS.sigBuyC, 'sigBuyC', 40), signed(TXS.sigXfer, 'sigXfer', 35)];
  const PAGE2 = [signed(TXS.sigBuyB, 'sigBuyB', 30), signed(TXS.sigBuyA, 'sigBuyA', 20)];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    assert.equal(url, HELIUS);
    assert.equal(body.method, 'getTransactionsForAddress', `the deep read only, got ${body.method}`);
    deepCalls.push(body.params[1]);
    const token = body.params[1].paginationToken;
    const result = token ? { data: PAGE2, paginationToken: null } : { data: PAGE1, paginationToken: '30:0' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  assert.equal(history.start(W, HELIUS).ok, true);
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.via, 'helius');
  assert.equal(deepCalls.length, 2, 'two pages, followed by token');
  const o = deepCalls[0];
  assert.equal(o.transactionDetails, 'full');
  assert.equal(o.filters.status, 'succeeded', 'failed transactions filtered by the server');
  assert.ok(o.filters.blockTime.gte <= NOW_S - 29 * 86_400 && o.filters.blockTime.gte >= NOW_S - 31 * 86_400, 'thirty days back');
  assert.equal(o.maxSupportedTransactionVersion, 1, 'v1 transactions asked for');
  assert.equal(deepCalls[1].paginationToken, '30:0');
  assert.equal(st.read, 5);
  assert.equal(st.swaps, 4);
  assert.equal(st.notSwap, 1);
  assert.equal(st.calls, 2);
  assert.equal(st.oldestAt, (NOW_S - 400) * 1000);
  const w = book();
  assert.equal(w.days.reduce((n, d) => n + d.roundTrips, 0), 1, 'fed oldest first across pages: the C trip closes');
  assert.equal(history.swapsOf(W).length, 4, 'the swaps are kept for the copy replay');
  assert.equal(st.depth, 1_000);
  assert.equal(st.days, 30);
  assert.equal(st.truncated, false, 'the last page had no token');
  assert.equal(history.covers(W, Date.now() - 7 * 86_400_000), true, 'a read that was not cut short covers the week');

  // A week check's read (2026-10-28): its own cap and days; cut short at the cap.
  fresh();
  deepCalls.length = 0;
  assert.equal(history.start(W, HELIUS, Date.now(), { limit: 3, days: 7 }).ok, true);
  await history.wait(W);
  const wk = history.status(W);
  assert.equal(deepCalls.length, 1, 'stops at its cap');
  assert.equal(deepCalls[0].limit, 3);
  assert.ok(deepCalls[0].filters.blockTime.gte >= NOW_S - 8 * 86_400 && deepCalls[0].filters.blockTime.gte <= NOW_S - 6 * 86_400, 'seven days back');
  assert.equal(wk.truncated, true);
  assert.match(wk.message, /Read the newest 3 transactions; older ones in the 7 days were left out/);
  assert.equal(history.covers(W, Date.now() - 7 * 86_400_000), false, 'cut short before the week began: not covered');
  assert.equal(history.covers(W, Date.now() - 200_000), true, 'but it does reach back past its oldest swap');

  // Refused (not on this plan): the standard path reads it, on the same key.
  fresh();
  listing = [
    { signature: 'sigSellC', err: null, blockTime: NOW_S - 100 },
    { signature: 'sigBuyC', err: null, blockTime: NOW_S - 200 },
    { signature: 'sigXfer', err: null, blockTime: NOW_S - 250 },
    { signature: 'sigBuyB', err: null, blockTime: NOW_S - 300 },
    { signature: 'sigBuyA', err: null, blockTime: NOW_S - 400 },
  ];
  let deepAsked = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!Array.isArray(body) && body.method === 'getTransactionsForAddress') {
      deepAsked += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }) };
    }
    return standard(url, init);
  };
  assert.equal(history.start(W, HELIUS).ok, true);
  await history.wait(W);
  let s2 = history.status(W);
  assert.equal(deepAsked, 1);
  assert.equal(s2.via, 'rpc', 'read the standard way');
  assert.equal(s2.swaps, 4, 'the same four swaps, counted once');
  assert.equal(s2.read, 5);
  assert.equal(calls.list, 1);
  // Not asked again within the hour.
  assert.equal(history.start(W, HELIUS).ok, true);
  await history.wait(W);
  s2 = history.status(W);
  assert.equal(deepAsked, 1, 'a refusing key is not asked again for an hour');
  assert.equal(s2.via, 'rpc');
  assert.equal(s2.truncated, false, 'a listing under its limit is not cut short');
  assert.equal(history.covers(W, Date.now() - 7 * 86_400_000), true, 'and covers the week');

  // 2026-10-28: a transaction that could not be read leaves a hole — no week.
  listing = [{ signature: 'sigGone', err: null, blockTime: NOW_S - 150 }, ...listing];
  history.start(W, HELIUS);
  await history.wait(W);
  s2 = history.status(W);
  assert.equal(s2.unreadable, 1);
  assert.equal(history.covers(W, Date.now() - 7 * 86_400_000), false, 'a read with an unreadable transaction does not cover the week');
  listing = listing.slice(1);

  // 2026-10-28: a complaint about the request (a mistyped address, -32602)
  // is not the plan refusing the method — the deep read stays on.
  fresh();
  deepAsked = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!Array.isArray(body) && body.method === 'getTransactionsForAddress') {
      deepAsked += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid param: String is the wrong size' } }) };
    }
    return standard(url, init);
  };
  history.start(W, HELIUS);
  await history.wait(W);
  history.start(W, HELIUS);
  await history.wait(W);
  assert.equal(deepAsked, 2, 'an invalid-params answer does not park the deep read');

  // 2026-10-28: a 429 mid-read is waited out and asked again, not the end.
  fresh();
  let pages = 0;
  let limited = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!Array.isArray(body) && body.method === 'getTransactionsForAddress') {
      if (limited < 1) {
        limited += 1;
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      }
      pages += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { data: [signed(TXS.sigBuyA, 'sigBuyA', 2000)], paginationToken: null } }) };
    }
    return standard(url, init);
  };
  history.start(W, HELIUS);
  await history.wait(W);
  s2 = history.status(W);
  assert.equal(limited, 1);
  assert.equal(pages, 1, 'asked again after the 429');
  assert.equal(s2.via, 'helius');
  assert.equal(s2.swaps, 1);
  assert.doesNotMatch(s2.message, /Stopped after/);
  globalThis.fetch = standard;
  ok('with a Helius endpoint the deep read pages the full transactions; a refusing plan falls back and is not asked again');
}

// Never signs (2026-10-28): the board's top wallet on the release check was
// an account inside another program's pool transactions — its tokens moved,
// someone else signed. A read that finds only that marks the record, the
// row carries the "Never signs" hard exclusion, and the read says why; a
// later read with a swap it signed clears the mark.
{
  fresh();
  const standard = globalThis.fetch;
  // Give W a record first (three buys), as the live feed would have.
  for (const [i, m] of [MINT_A, MINT_B, MINT_C].entries()) history._store.note('solana', W, m, true, 0.1, 1000, Date.now() - (i + 1) * 60_000, `seed${i}`);
  const TRADER = 'Trader11111111111111111111111111111111111111';
  const POOL = 'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u';
  /** A swap TRADER signed, through a pool account W owns tokens in. */
  const poolTx = (i) => ({
    slot: 1000 + i,
    blockTime: NOW_S - 100 - i,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10 * SOL, 0, 0, 0],
      postBalances: [10 * SOL - 5000, 0, 0, 0],
      preTokenBalances: [{ accountIndex: 3, mint: MINT_A, owner: W, uiTokenAmount: { amount: '5000000', decimals: 6, uiAmount: null } }],
      postTokenBalances: [{ accountIndex: 3, mint: MINT_A, owner: W, uiTokenAmount: { amount: String(5000000 - 1000 * (i + 1)), decimals: 6, uiAmount: null } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [`pool${i}`],
      message: {
        accountKeys: [TRADER, POOL, MINT_A, W],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
      },
    },
  });
  let page = Array.from({ length: 25 }, (_, i) => poolTx(i));
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { data: page, paginationToken: null } }) };
  };
  assert.equal(history.start(W, HELIUS).ok, true);
  await history.wait(W);
  let st = history.status(W);
  assert.equal(st.swaps, 0);
  assert.equal(st.unsigned, 25, 'every transaction moved its tokens under another signature');
  assert.match(st.message, /never signed a swap: in 25 of the 25 transactions/);
  assert.match(st.message, /nothing of its own to copy/);
  const w = book();
  assert.equal(w.neverSigns?.read, 25, 'the record is marked');
  assert.equal(w.neverSigns.unsigned, 25);

  // Too little read is not judged.
  history._store.setNeverSigns('solana', W, null);
  page = page.slice(0, 5);
  history.start(W, HELIUS);
  await history.wait(W);
  assert.equal(book().neverSigns ?? null, null, 'five transactions are too few to say');

  // A swap it signed clears the mark.
  history._store.setNeverSigns('solana', W, { at: 1, read: 30, unsigned: 30 });
  page = [signed(TXS.sigBuyA, 'sigBuyA', 2000), ...Array.from({ length: 25 }, (_, i) => poolTx(i))];
  history.start(W, HELIUS);
  await history.wait(W);
  st = history.status(W);
  assert.equal(st.swaps, 1);
  assert.equal(book().neverSigns ?? null, null, 'a signed swap clears it');
  assert.doesNotMatch(st.message, /never signed/);
  globalThis.fetch = standard;
  ok('a read that finds only other signers moving its tokens marks the wallet "never signs"; too few is not judged; a signed swap clears it');
}

console.log(`\nwallethistory: ${passed}/5 passed`);
