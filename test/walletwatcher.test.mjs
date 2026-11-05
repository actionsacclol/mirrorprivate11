// The wallet watcher (walletWatcher.ts) against a local websocket server:
// one subscription per followed wallet, the leader's transaction read once
// and decoded into a swap, replays deduped, unsubscribed on unfollow,
// fourteen leaders all watched on ONE public connection (the pubsub limit is
// 10 connections per IP, not 10 subscriptions per socket), and 'over-cap'
// reached only when the host itself refuses.
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import * as watcher from './.walletwatcher.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return false;
}

function server(onConn) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    let n = 0;
    wss.on('connection', (ws) => onConn(ws, ++n));
    wss.on('listening', () => {
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
  });
}

const W1 = 'Wallet1111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MINT = 'MintA111111111111111111111111111111111111111';
const SOL = 1_000_000_000;

/** A Jupiter-style buy by W1: 0.6 SOL out, 1000 tokens in. */
const BUY_TX = {
  // Seconds, as the RPC returns it — the watcher turns it into the `tradeAt`
  // copy trading refuses a stale entry on.
  blockTime: Math.floor(Date.now() / 1000),
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10 * SOL, 0, 0],
    postBalances: [10 * SOL - 0.6 * SOL - 5000, 0, 0],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 5, mint: MINT, owner: W1, uiTokenAmount: { amount: '1000000000', decimals: 6, uiAmount: null } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [W1, JUP, MINT],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
};

let fetches = 0;
// What `getSignaturesForAddress` answers, and how often it was asked. The
// catch-up path reads it; every other method gets the transaction.
let sigList = [];
let sigCalls = 0;
const rpcMethodOf = (init) => {
  try {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return Array.isArray(body) ? body[0]?.method : body?.method;
  } catch {
    return undefined;
  }
};
/** The params of the last getTransaction the watcher sent. */
let lastTxParams = null;
globalThis.fetch = async (_url, init) => {
  const reply = (result) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result }) });
  if (rpcMethodOf(init) === 'getSignaturesForAddress') {
    sigCalls += 1;
    return reply(sigList);
  }
  fetches += 1;
  try {
    const body = JSON.parse(String(init?.body ?? '{}'));
    lastTxParams = (Array.isArray(body) ? body[0] : body)?.params?.[1] ?? null;
  } catch {
    lastTxParams = null;
  }
  return reply(BUY_TX);
};

/** The stub above, so a later case can put it back after one that used the real fetch. */
const stubbedFetch = globalThis.fetch;

const notification = (sub, sig) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: { subscription: sub, result: { context: { slot: 1 }, value: { signature: sig, err: null, logs: [] } } },
  });

// ── subscribe per wallet, decode once, dedupe replays, unfollow ──────────
{
  const received = [];
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'slotSubscribe') received.push(req);
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 5 }));
      if (req.method === 'logsUnsubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: true }));
    });
  });
  const swaps = [];
  const logs = [];
  watcher._reset();
  watcher.attach({
    wssUrl: () => s.url,
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push({ level, line }),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => received.length === 1), 'a subscribe went out');
  assert.equal(received[0].method, 'logsSubscribe');
  assert.deepEqual(received[0].params[0], { mentions: [W1] }, 'subscribed to the WALLET, not a program');
  assert.equal(received[0].params[1].commitment, 'confirmed', 'confirmed, so the transaction is readable when asked for');
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching after the ack');
  console.log('ok  one logsSubscribe per followed wallet, at confirmed');

  sock.send(notification(5, 'sigBuy1'));
  assert.ok(await waitFor(() => swaps.length === 1), 'the swap was decoded and delivered');
  assert.equal(swaps[0].wallet, W1);
  assert.equal(swaps[0].signature, 'sigBuy1');
  assert.equal(swaps[0].swap.isBuy, true);
  assert.equal(swaps[0].swap.mint, MINT);
  assert.ok(Math.abs(swaps[0].swap.sol - 0.6) < 1e-12);
  assert.equal(swaps[0].swap.tokens, 1000);
  assert.equal(fetches, 1, 'the transaction was read once');
  // Transaction v1 (SIMD-0385) is live on mainnet since 2026-09-15. A read
  // that only accepts v0 is refused (-32015) for every v1 transaction a
  // leader makes — which was "That trade was not copied" on every one of
  // them (user report 2026-09-20).
  assert.equal(lastTxParams?.maxSupportedTransactionVersion, 1, `the read accepts transaction v1 — sent ${JSON.stringify(lastTxParams)}`);
  assert.equal(typeof swaps[0].tradeAt, 'number', 'and carries WHEN THEY TRADED, from the block');
  assert.ok(Math.abs(swaps[0].tradeAt - BUY_TX.blockTime * 1000) < 1000);
  assert.equal(sigCalls, 0, 'the first subscribe of a session has no gap behind it to fill');
  console.log('ok  a notification becomes a decoded swap via one getTransaction, dated by the block');

  sock.send(notification(5, 'sigBuy1'));
  await sleep(150);
  assert.equal(swaps.length, 1, 'a replayed signature is not a second swap');
  assert.equal(fetches, 1, 'and is not read again');
  const st = watcher.status()[W1];
  assert.equal(st.seen, 2);
  assert.equal(st.swaps, 1);
  assert.ok(st.lastSeenAt && st.lastSwapAt);
  console.log('ok  replays are deduped by signature');

  watcher.setWallets([]);
  assert.ok(await waitFor(() => received.some((r) => r.method === 'logsUnsubscribe' && r.params[0] === 5)), 'unsubscribed on unfollow');
  assert.deepEqual(watcher.status(), {}, 'nothing watched');
  assert.equal(watcher.isConnected(), false, 'the socket closes when no wallet is followed');
  await s.close();
  console.log('ok  unfollowing unsubscribes and closes the socket');
}

// ── fourteen leaders are fourteen leaders ────────────────────────────────
//
// 2026-09-09: this used to assert the opposite — that the eleventh followed
// wallet went unwatched, because `x-ratelimit-pubsub-limit: 10` was read as
// ten subscriptions per connection. It is ten pubsub CONNECTIONS per IP: the
// header decrements once per socket, 16 `logsSubscribe` on one socket were
// all acked, and connections 11-13 were refused at the handshake. A user
// following 14 leaders was losing four of them, and being told to buy a key
// for a limit that is not there.
{
  let subId = 100;
  let conns = 0;
  const asked = [];
  const s = await server((ws) => {
    conns += 1;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      asked.push(req.params[0].mentions[0]);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const logs = [];
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: (level, line) => logs.push(line) });
  const wallets = Array.from({ length: 14 }, (_, i) => `W${String(i).padStart(43, '0')}`);
  watcher.setWallets(wallets);
  assert.ok(await waitFor(() => Object.values(watcher.status()).filter((w) => w.state === 'watching').length === 14), 'all fourteen are watched');
  assert.equal(Object.values(watcher.status()).filter((w) => w.state === 'over-cap').length, 0, 'none is marked over-cap');
  assert.equal(asked.length, 14, 'fourteen subscribe frames went out — none was withheld');
  assert.equal(conns, 1, 'over ONE connection: the connection is the scarce resource, not the subscription');
  assert.equal(logs.filter((l) => /helius|api key|lifts this|allows \d+ followed wallets/i.test(l)).length, 0, 'and nothing tells the user to buy a key');
  watcher._reset();
  await s.close();
  console.log('ok  fourteen followed wallets are all watched on one public socket');
}

// ── a refusal from the HOST is learned, and only then is a wallet over-cap ──
{
  let subId = 700;
  let acked = 0;
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      // This host really does stop at three; nothing knows until it happens.
      if (acked >= 3) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Too many subscriptions' } }));
        return;
      }
      acked += 1;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const logs = [];
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: (level, line) => logs.push(line) });
  const wallets = Array.from({ length: 5 }, (_, i) => `X${String(i).padStart(43, '0')}`);
  watcher.setWallets(wallets);
  assert.ok(await waitFor(() => Object.values(watcher.status()).filter((w) => w.state === 'over-cap').length >= 1), 'the refused wallet is marked over-cap');
  assert.equal(Object.values(watcher.status()).filter((w) => w.state === 'watching').length, 3, 'the three the host accepted are watching');
  assert.ok(logs.some((l) => /subscribe rejected/.test(l)), 'the refusal is reported, not swallowed');

  // The ceiling is now a measured 3, so a sixth wallet is not even asked for.
  const before = acked + logs.length;
  watcher.setWallets([...wallets, `X${String(9).padStart(43, '0')}`]);
  await sleep(150);
  const held = logs.filter((l) => /refused a subscribe past 3 followed wallets/.test(l));
  assert.equal(held.length, 1, 'the log names the number the HOST refused at');
  assert.ok(/16 were verified to work/.test(held[0]), 'quoting what was actually measured');
  assert.equal(logs.filter((l) => /helius|api key|lifts this/i.test(l)).length, 0, 'still no key upsell');
  assert.ok(before >= 0);
  watcher._reset();
  await s.close();
  console.log('ok  over-cap comes from the host refusing, not from an invented limit');
}

// ── Catching up after a gap ─────────────────────────────────────────────
//
// `logsSubscribe` is live-only. Whatever a followed wallet did while the
// socket was down was never delivered, and nothing asked for it afterwards —
// so a leader's exit inside a reconnect was simply never seen, and the
// position sat open until something else eventually closed it. That is the
// "eventually sold, 1 h 28 m late" shape of the 2026-09-15 report.
{
  let subId = 500;
  let conns = 0;
  const sockets = [];
  const s = await server((ws, n) => {
    conns = n;
    sockets.push(ws);
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const swaps = [];
  const logs = [];
  watcher._reset();
  sigCalls = 0;
  sigList = [];
  watcher.attach({
    wssUrl: () => s.url,
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push(line),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching on the first socket');
  assert.equal(sigCalls, 0, 'no catch-up on a first subscribe — there is no gap behind it');

  // The leader sells while we are away. The socket dies before it arrives.
  sigList = [
    { signature: 'sigMissedExit', err: null, slot: 9, blockTime: Math.floor(Date.now() / 1000) },
    { signature: 'sigTooOld', err: null, slot: 8, blockTime: Math.floor(Date.now() / 1000) - 40 * 60 },
  ];
  sockets[0].terminate();

  assert.ok(await waitFor(() => conns >= 2, 8000), 'the watcher reconnected');
  assert.ok(await waitFor(() => swaps.length === 1, 8000), `the missed transaction was recovered: ${JSON.stringify(logs)}`);
  assert.equal(swaps[0].signature, 'sigMissedExit');
  assert.equal(typeof swaps[0].tradeAt, 'number', 'and it knows when it really happened');
  assert.ok(sigCalls >= 1, 'the gap was filled with one signatures read');
  assert.ok(logs.some((l) => /catching up on 1 transaction/.test(l)), `the catch-up says what it did: ${JSON.stringify(logs)}`);
  console.log('ok  a transaction missed while the socket was down is recovered on reconnect');

  assert.ok(
    !swaps.some((x) => x.signature === 'sigTooOld'),
    'a signature from forty minutes ago is outside the window and is NOT replayed',
  );
  console.log('ok  the catch-up is bounded by age, so a reconnect never replays ancient history');

  // A second gap must not re-deliver what the first one already handled.
  const before = swaps.length;
  sockets[sockets.length - 1].terminate();
  assert.ok(await waitFor(() => conns >= 3, 8000), 'reconnected again');
  await sleep(400);
  assert.equal(swaps.length, before, 'already-seen signatures are dropped before any transaction is fetched');
  watcher._reset();
  await s.close();
  console.log('ok  a second catch-up re-delivers nothing');
}

// ── A transaction that cannot be read is said out loud ───────────────────
//
// It used to be three tries 700 ms apart and then silence. On a rate-limited
// endpoint that is nothing, and every transaction lost that way is a leader
// trade the copier never acts on — with no way for anyone to know.
{
  let subId = 700;
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const swaps = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (rpcMethodOf(init) === 'getSignaturesForAddress') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: [] }) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: null }) };
  };
  watcher._reset();
  watcher._setReadClocks({ summaryMs: 50 });
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: (ev) => swaps.push(ev), log: (level, line) => logs.push(line) });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'));
  sock.send(notification(subId, 'sigUnreadable'));
  assert.ok(
    await waitFor(() => logs.some((l) => /was not copied/.test(l)), 30000),
    `giving up is reported: ${JSON.stringify(logs)}`,
  );
  assert.equal(swaps.length, 0, 'and nothing is invented from a transaction that was never read');
  globalThis.fetch = realFetch;
  watcher._reset();
  await s.close();
  console.log('ok  a leader transaction that cannot be read is chased, then reported — never dropped in silence');
}

// ── a keyed socket rides transactionSubscribe: no read-back ──────────────
//
// 2026-09-21: Helius pushes the parsed transaction with the notification on
// its Developer plan and up. On a keyed socket the watcher tries that first;
// the transaction is decoded from the push, and getTransaction is never
// called. Confirmed, not processed; the frame is pinned in
// leaderfeedframes.test.mjs.
{
  const received = [];
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'slotSubscribe') received.push(req);
      if (req.method === 'transactionSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 9 }));
      if (req.method === 'transactionUnsubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: true }));
    });
  });
  globalThis.fetch = stubbedFetch;
  fetches = 0;
  sigList = [];
  const swaps = [];
  const logs = [];
  watcher._reset();
  watcher.attach({
    wssUrl: () => `${s.url}/?api-key=test`,
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push({ level, line }),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => received.length === 1), 'a subscribe went out');
  assert.equal(received[0].method, 'transactionSubscribe', 'a keyed socket tries the push transport first');
  assert.deepEqual(received[0].params[0].accountInclude, [W1]);
  assert.equal(received[0].params[1].commitment, 'confirmed');
  assert.equal(received[0].params[1].maxSupportedTransactionVersion, 1);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching after the ack');
  assert.equal(watcher.status()[W1].feed, 'tx', 'the status says which transport it rides');
  sock.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'transactionNotification',
      params: { subscription: 9, result: { signature: 'sigPush1', slot: 1, transactionIndex: 0, transaction: { transaction: BUY_TX.transaction, meta: BUY_TX.meta } } },
    }),
  );
  assert.ok(await waitFor(() => swaps.length === 1), 'the pushed transaction was decoded');
  assert.equal(swaps[0].signature, 'sigPush1');
  assert.equal(swaps[0].swap.isBuy, true);
  assert.equal(swaps[0].swap.mint, MINT);
  assert.equal(fetches, 0, 'and NOTHING was read back');
  assert.equal(swaps[0].tradeAt, null, 'a push carries no block time; undated is honest, not invented');
  // A push whose transaction the parser does not know falls back to a read.
  sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'transactionNotification', params: { subscription: 9, result: { signature: 'sigPush2', slot: 2, transaction: {} } } }));
  assert.ok(await waitFor(() => swaps.length === 2), 'the unknown shape was read back and decoded');
  assert.equal(fetches, 1, 'one read, for the one push that needed it');
  assert.equal(watcher.status()[W1].seen, 2);
  watcher.setWallets([]);
  assert.ok(await waitFor(() => received.some((r) => r.method === 'transactionUnsubscribe' && r.params[0] === 9)), 'unsubscribed with the matching method');
  await s.close();
  watcher._reset();
  console.log('ok  a keyed socket rides transactionSubscribe: the pushed transaction is decoded with no read-back');
}

// ── a plan refusal falls back to logsSubscribe, once, for the session ────
{
  const received = [];
  let sock = null;
  const W2 = 'Whae2222222222222222222222222222222222222';
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'slotSubscribe') received.push(req);
      if (req.method === 'transactionSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 11 + received.length }));
    });
  });
  globalThis.fetch = stubbedFetch;
  fetches = 0;
  sigList = [];
  const swaps = [];
  const logs = [];
  watcher._reset();
  watcher.attach({
    wssUrl: () => `${s.url}/?api-key=test`,
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push({ level, line }),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => received.length === 2), 'refused, then retried on the other transport');
  assert.deepEqual(
    received.map((r) => r.method),
    ['transactionSubscribe', 'logsSubscribe'],
  );
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching on the fallback');
  assert.equal(watcher.status()[W1].feed, 'logs');
  assert.ok(logs.some((l) => /does not serve transactionSubscribe/.test(l.line)), `the fallback is said once: ${JSON.stringify(logs)}`);
  const subId = received.length === 2 ? 13 : null;
  sock.send(notification(subId, 'sigFallback1'));
  assert.ok(await waitFor(() => swaps.length === 1), 'the logs path works after the fallback');
  assert.equal(fetches, 1, 'read back once, as before');
  // A wallet followed later in the same session goes straight to logs.
  watcher.setWallets([W1, W2]);
  assert.ok(await waitFor(() => received.length === 3));
  assert.equal(received[2].method, 'logsSubscribe', 'the refusal is remembered for the session');
  watcher.setWallets([]);
  await s.close();
  watcher._reset();
  console.log('ok  a plan refusal falls back to logsSubscribe once, for every wallet, and says so');
}

// ── a refused read-back moves to the second endpoint (getTransaction only) ──
// Keyless, api.mainnet-beta grants ~10 getTransaction per 10 s per IP, shared
// with every app on the machine; retrying the same host kept it saturated
// (probe, 2026-10-23). The fallback is asked for the read and nothing else.
{
  let subId = 900;
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const hosts = [];
  const swaps = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const m = rpcMethodOf(init);
    if (m === 'getSignaturesForAddress') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: [] }) };
    hosts.push({ url: String(url), method: m });
    if (String(url).includes('primary')) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}), text: async () => 'Too many requests' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: BUY_TX }) };
  };
  watcher._reset();
  watcher.attach({
    wssUrl: () => s.url,
    httpUrl: () => 'https://primary.test/',
    readFallbackUrl: () => 'https://fallback.test/',
    onSwap: (ev) => swaps.push(ev),
    log: () => {},
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'));
  sock.send(notification(subId, 'sigFallbackRead'));
  assert.ok(await waitFor(() => swaps.length === 1, 15000), `read through the fallback: ${JSON.stringify(hosts)}`);
  assert.ok(hosts.some((h) => h.url.includes('fallback') && h.method === 'getTransaction'), 'the fallback served the read');
  assert.ok(hosts.filter((h) => h.url.includes('fallback')).every((h) => h.method === 'getTransaction'), 'and only the read');
  globalThis.fetch = realFetch;
  watcher._reset();
  await s.close();
  console.log('ok  a refused read-back is retried on the fallback endpoint, for getTransaction only');
}

// ── Helius Parsed Streams (2026-10-24) ───────────────────────────────────
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** A Parsed Streams push of a pump curve trade signed by W1. */
const parsedPush = (sub, sig, isBuy) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'parsedTransactionNotification',
    params: {
      subscription: sub,
      result: {
        context: { slot: 77 },
        value: {
          transaction: {
            signature: sig,
            slot: 77,
            blockTime: null,
            feePayer: W1,
            status: 'ok',
            accountKeys: [W1, MINT, PUMP],
            tokenTransfers: isBuy ? [{ fromUserAccount: 'Curve', toUserAccount: W1, mint: MINT, rawTokenAmount: 1000000000, decimals: 6 }] : [{ fromUserAccount: W1, toUserAccount: 'Curve', mint: MINT, rawTokenAmount: 1000000000, decimals: 6 }],
          },
          instructions: [
            { innerInstructionIndex: null, programId: PUMP, instructionName: isBuy ? 'buy' : 'sell', decoded: { args: {}, accounts: [{ name: 'user', pubkey: W1, isSigner: true }] } },
            {
              innerInstructionIndex: 0,
              programId: PUMP,
              instructionName: 'TradeEvent',
              decoded: { args: { user: W1, mint: MINT, is_buy: isBuy, quote_mint: '11111111111111111111111111111111', sol_amount: '590000000', fee: '7000000', creator_fee: '3000000', cashback: '0', holder_rewards: '0', token_amount: '1000000000' } },
            },
          ],
        },
      },
    },
  });

/** Two fake hosts: the RPC socket (`logs`/`tx`) and the Parsed Streams one. */
async function twoHosts({ refuseTx = false, refuseParsed = false } = {}) {
  const rpc = { received: [], sock: null };
  const parsed = { received: [], sock: null };
  const rs = await server((ws) => {
    rpc.sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'slotSubscribe') rpc.received.push(req);
      if (req.method === 'transactionSubscribe' && refuseTx) ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 21 }));
    });
  });
  const ps = await server((ws) => {
    parsed.sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      parsed.received.push(req);
      if (req.method === 'parsedTransactionSubscribe') {
        ws.send(JSON.stringify(refuseParsed ? { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unknown field' } } : { jsonrpc: '2.0', id: req.id, result: 3 }));
      }
      if (req.method === 'parsedTransactionUnsubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: true }));
    });
  });
  return { rpc, parsed, rs, ps, close: async () => Promise.all([rs.close(), ps.close()]) };
}

// ── a keyless socket with Parsed Streams on rides it; a buy needs no read ──
{
  const h = await twoHosts();
  globalThis.fetch = stubbedFetch;
  fetches = 0;
  sigList = [];
  const swaps = [];
  const logs = [];
  let billed = 0;
  let parsedOn = true;
  watcher._reset();
  watcher.attach({
    wssUrl: () => h.rs.url,
    parsedWssUrl: () => (parsedOn ? `${h.ps.url}/?api-key=test` : ''),
    billEvents: (n) => (billed += n),
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push(line),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching on Parsed Streams');
  assert.equal(h.parsed.received[0].method, 'parsedTransactionSubscribe');
  assert.deepEqual(h.parsed.received[0].params[0].accounts.include, [W1]);
  assert.equal(h.rpc.received.length, 0, 'the RPC socket was not asked for anything');
  assert.equal(watcher.status()[W1].feed, 'parsed');
  h.parsed.sock.send(parsedPush(3, 'sigParsedBuy', true));
  assert.ok(await waitFor(() => swaps.length === 1), 'the buy was delivered');
  assert.equal(fetches, 0, 'decoded from the push, nothing read back');
  assert.equal(swaps[0].swap.sol, 0.6, 'curve + fee + creator fee');
  assert.equal(swaps[0].swap.heldBefore, null);
  assert.equal(swaps[0].timing.feed, 'parsed');
  assert.equal(swaps[0].timing.readMs, null);
  assert.equal(swaps[0].timing.slot, 77);
  assert.equal(swaps[0].tradeAt, null, 'undated, as on the tx transport');
  // A sell needs the pre-balance: read back, still labelled by its feed.
  h.parsed.sock.send(parsedPush(3, 'sigParsedSell', false));
  assert.ok(await waitFor(() => swaps.length === 2), 'the sell went through the read-back');
  assert.equal(fetches, 1, 'one read, for the sell');
  assert.equal(swaps[1].timing.feed, 'parsed');
  assert.equal(typeof swaps[1].timing.readMs, 'number');
  assert.equal(billed, 2, 'one credit per delivered event');
  assert.equal(watcher.status()[W1].seen, 2);
  // Turned off (the switch, or a spent budget): the next tick leaves it.
  parsedOn = false;
  watcher.refreshTransport();
  assert.ok(await waitFor(() => h.rpc.received.some((r) => r.method === 'logsSubscribe')), 'moved to logsSubscribe');
  assert.ok(await waitFor(() => watcher.status()[W1]?.feed === 'logs' && watcher.status()[W1]?.state === 'watching'));
  assert.ok(logs.some((l) => /leaving Helius Parsed Streams/.test(l)), `said so: ${JSON.stringify(logs)}`);
  watcher.setWallets([]);
  watcher._reset();
  await h.close();
  console.log('ok  Parsed Streams: a clean buy is decoded from the push, a sell is read back, off moves to logs');
}

// ── a refused Parsed Streams subscribe drops to logs, and stays there ─────
{
  const h = await twoHosts({ refuseParsed: true });
  globalThis.fetch = stubbedFetch;
  const logs = [];
  watcher._reset();
  watcher.attach({
    wssUrl: () => h.rs.url,
    parsedWssUrl: () => `${h.ps.url}/?api-key=test`,
    httpUrl: () => 'https://rpc.test/',
    onSwap: () => {},
    log: (level, line) => logs.push(line),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.feed === 'logs' && watcher.status()[W1]?.state === 'watching'), 'watching on logs');
  assert.ok(logs.some((l) => /Parsed Streams is not working \(unknown field\)/.test(l)), `said why: ${JSON.stringify(logs)}`);
  const asked = h.parsed.received.length;
  watcher.refreshTransport();
  await sleep(100);
  assert.equal(h.parsed.received.length, asked, 'not retried inside the half hour');
  assert.equal(watcher.status()[W1].feed, 'logs');
  watcher.setWallets([]);
  watcher._reset();
  await h.close();
  console.log('ok  a refused Parsed Streams subscribe drops to logsSubscribe and says why');
}

// ── a key without transactionSubscribe moves to Parsed Streams ───────────
{
  const h = await twoHosts({ refuseTx: true });
  globalThis.fetch = stubbedFetch;
  const logs = [];
  watcher._reset();
  watcher.attach({
    wssUrl: () => `${h.rs.url}/?api-key=test`,
    parsedWssUrl: () => `${h.ps.url}/?api-key=test`,
    httpUrl: () => 'https://rpc.test/',
    onSwap: () => {},
    log: (level, line) => logs.push(line),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.feed === 'parsed' && watcher.status()[W1]?.state === 'watching'), 'watching on Parsed Streams');
  assert.deepEqual(h.rpc.received.map((r) => r.method), ['transactionSubscribe'], 'tx tried first, nothing after the refusal');
  assert.ok(logs.some((l) => /does not serve transactionSubscribe .* using Helius Parsed Streams/.test(l)), `said so: ${JSON.stringify(logs)}`);
  watcher.setWallets([]);
  watcher._reset();
  await h.close();
  console.log('ok  a key that refuses transactionSubscribe moves followed wallets to Parsed Streams');
}

// ── The read storm (support bundle 2026-11-01) ───────────────────────────
//
// 34,653 "could not read … timeout" lines, 30,066 for ONE leader, 448 trades
// not copied. Every notification ran its own read loop, so an outage turned
// into thousands of concurrent reads; and the "one more round" set evicted
// signatures before their second round, so the same batch was re-chased every
// ~3 minutes forever. These pin the queue that replaced it.

/** A socket that acks logsSubscribe per wallet and remembers the ids. */
async function leaderSocket() {
  let subId = 2000;
  const ids = new Map();
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      const id = ++subId;
      ids.set(req.params[0].mentions[0], id);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: id }));
    });
  });
  return { s, ids, send: (wallet, sig) => sock.send(notification(ids.get(wallet), sig)) };
}

const sigOf = (init) => {
  try {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return (Array.isArray(body) ? body[0] : body)?.params?.[0] ?? null;
  } catch {
    return null;
  }
};

// An outage: bounded concurrency, a pause with a probe, nothing given up
// while it lasts, everything read when it ends, and no loop afterwards.
{
  const { s, send } = await leaderSocket();
  const per = new Map();
  let inFlight = 0;
  let most = 0;
  let down = true;
  let total = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (rpcMethodOf(init) === 'getSignaturesForAddress') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: [] }) };
    const sig = sigOf(init);
    per.set(sig, (per.get(sig) ?? 0) + 1);
    total += 1;
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      await sleep(15);
      if (down) throw new Error('The operation was aborted due to timeout');
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: BUY_TX }) };
    } finally {
      inFlight -= 1;
    }
  };
  const swaps = [];
  const logs = [];
  const unreadable = [];
  watcher._reset();
  watcher._setReadClocks({ rereadMs: 200, probeMs: 100, summaryMs: 50 });
  watcher.attach({
    wssUrl: () => s.url,
    httpUrl: () => 'https://down.test/',
    onSwap: (ev) => swaps.push(ev),
    onUnreadable: (w, sig) => unreadable.push(sig),
    log: (level, line) => logs.push(line),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'));
  for (let i = 0; i < 100; i++) send(W1, `storm${i}`);
  assert.ok(await waitFor(() => logs.some((l) => /pausing reads/.test(l)), 5000), `the outage is noticed: ${JSON.stringify(logs.slice(0, 3))}`);
  assert.ok(most <= 6, `never more than six reads at once (saw ${most})`);
  // While it lasts: one probe per 100 ms, not a hundred loops.
  const before = total;
  await sleep(1000);
  assert.ok(total - before <= 15, `a paused queue probes, it does not hammer (${total - before} reads in 1 s)`);
  assert.equal(unreadable.length, 0, 'and nothing is given up while the endpoint is down');
  down = false;
  assert.ok(await waitFor(() => swaps.length === 100, 15000), `every trade is read once the RPC answers (${swaps.length}/100)`);
  assert.ok(logs.some((l) => /answering again/.test(l)), 'and the recovery is said');
  const hot = [...per.values()].filter((n) => n > 6).length;
  assert.ok(hot <= 1, `only the probe signature was asked repeatedly (${hot} signatures read more than 6 times)`);
  const settled = total;
  await sleep(800);
  assert.equal(total, settled, 'nothing is read again afterwards — no loop');
  globalThis.fetch = realFetch;
  watcher._reset();
  await s.close();
  console.log('ok  an RPC outage pauses reads behind one probe, gives nothing up, reads everything after, and never loops');
}

// A refused read gets exactly one more round — the round is on the job, so
// no cap or eviction can turn it into a third.
{
  const { s, send } = await leaderSocket();
  const per = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (rpcMethodOf(init) === 'getSignaturesForAddress') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: [] }) };
    const sig = sigOf(init);
    per.set(sig, (per.get(sig) ?? 0) + 1);
    // Refuse only this one; everything else is served, so no outage.
    if (sig === 'stubborn') throw new Error('The operation was aborted due to timeout');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: BUY_TX }) };
  };
  const logs = [];
  const unreadable = [];
  watcher._reset();
  watcher._setReadClocks({ rereadMs: 150, probeMs: 100, summaryMs: 50 });
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, onUnreadable: (w, sig) => unreadable.push(sig), log: (level, line) => logs.push(line) });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'));
  send(W1, 'stubborn');
  for (let i = 0; i < 20; i++) send(W1, `fine${i}`);
  assert.ok(await waitFor(() => unreadable.includes('stubborn'), 10000), 'given up after its second round');
  const reads = per.get('stubborn');
  await sleep(600);
  assert.equal(per.get('stubborn'), reads, 'and never asked for again');
  assert.ok(reads <= 6, `two rounds of at most three refusals (${reads} reads)`);
  watcher.flushReadSummary();
  const lines = logs.filter((l) => /could not read/.test(l));
  assert.ok(lines.length <= 2, `summarised, not a line per attempt: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => /not copied/.test(l)), 'and the give-up says the trade was not copied');
  globalThis.fetch = realFetch;
  watcher._reset();
  await s.close();
  console.log('ok  a refused read gets exactly one more round, then one summary line — never a third');
}

// One busy leader cannot starve another.
{
  const { s, send } = await leaderSocket();
  const W2 = 'Whae2222222222222222222222222222222222222';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (rpcMethodOf(init) === 'getSignaturesForAddress') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: [] }) };
    await sleep(60);
    // The quiet leader's own buy: the same shape, signed by W2.
    const tx = sigOf(init) === 'quiet1' ? JSON.parse(JSON.stringify(BUY_TX).split(W1).join(W2)) : BUY_TX;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: tx }) };
  };
  const order = [];
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: (ev) => order.push(ev.signature), log: () => {} });
  watcher.setWallets([W1, W2]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching' && watcher.status()[W2]?.state === 'watching'));
  for (let i = 0; i < 60; i++) send(W1, `busy${i}`);
  await sleep(30);
  send(W2, 'quiet1');
  assert.ok(await waitFor(() => order.includes('quiet1'), 5000), 'the quiet leader is read');
  const at = order.indexOf('quiet1');
  assert.ok(at < 10, `within the first few reads, not after the busy leader's backlog (position ${at})`);
  globalThis.fetch = realFetch;
  watcher._reset();
  await s.close();
  console.log('ok  a busy leader fills only its own queue — a quiet leader is still read at once');
}

// ── days of running: sleep, a refused subscribe, a refused ceiling ───────
{
  const W = 'Sleepy111111111111111111111111111111111111';
  let conns = 0;
  const s = await server((ws) => {
    conns += 1;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 40 + conns }));
    });
  });
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: () => {} });
  watcher.setWallets([W]);
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'watching'), 'watching before the sleep');
  // What the computer going to sleep does, then what waking it does.
  watcher.stop();
  assert.equal(watcher.status()[W]?.state, 'off', 'the socket is down for the sleep');
  watcher.setWallets([W]);
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'watching'), 'the same list brings it back after a sleep');
  assert.equal(conns, 2, 'on a new socket');
  watcher._reset();
  await s.close();
  console.log('ok  waking from sleep brings the watcher back, with no follow touched');
}
{
  const W = 'Refused11111111111111111111111111111111111';
  const answers = ['some passing error'];
  let asked = 0;
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      asked += 1;
      const no = answers.shift();
      ws.send(JSON.stringify(no ? { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: no } } : { jsonrpc: '2.0', id: req.id, result: 77 }));
    });
  });
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: () => {} });
  watcher.setWallets([W]);
  assert.ok(await waitFor(() => asked === 1), 'asked once');
  await sleep(50);
  assert.equal(watcher.status()[W]?.state, 'connecting', 'refused, and the socket stayed up');
  watcher._recoverTick();
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'watching'), 'the minute check asks again');
  assert.equal(asked, 2);
  watcher._recoverTick();
  await sleep(50);
  assert.equal(asked, 2, 'a watched wallet is not asked for twice');
  watcher._reset();
  await s.close();
  console.log('ok  a refused subscribe is asked again, not left unwatched until the socket drops');
}
{
  const W = 'Ceiling11111111111111111111111111111111111';
  const answers = ['rate limit exceeded'];
  let asked = 0;
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      asked += 1;
      const no = answers.shift();
      ws.send(JSON.stringify(no ? { jsonrpc: '2.0', id: req.id, error: { code: -32005, message: no } } : { jsonrpc: '2.0', id: req.id, result: 78 }));
    });
  });
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: () => {} });
  watcher.setWallets([W]);
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'over-cap'), 'read as a ceiling');
  watcher._recoverTick(Date.now() + 60_000);
  await sleep(50);
  assert.equal(asked, 1, 'not hammered every minute');
  watcher._recoverTick(Date.now() + 11 * 60_000);
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'watching'), 'asked again after ten minutes, and the ceiling was not for ever');
  watcher._reset();
  await s.close();
  console.log('ok  a refusal that reads like a ceiling is tried again, not believed for days');
}

// ── A socket that answers pings and delivers nothing (2026-11-04) ─────

const slotFrame = (sub) => JSON.stringify({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: sub, result: { slot: 1, parent: 0, root: 0 } } });

/** A host that takes subscriptions. `onSlot` decides what a slot request gets. */
const pulseServer = async (onSlot) => {
  const state = { conns: 0, slotAsks: 0, frames: [] };
  state.s = await server((ws, n) => {
    state.conns = n;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      state.frames.push(req.method);
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 7 }));
      if (req.method === 'slotSubscribe') {
        state.slotAsks += 1;
        onSlot(ws, req, n);
      }
    });
  });
  return state;
};
const startPulse = (url, logs = []) => {
  watcher._reset();
  watcher.attach({ wssUrl: () => url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: (_l, line) => logs.push(line) });
  watcher._setPulseTimes(60, 20);
  watcher.setWallets(['Pulse111111111111111111111111111111111111111']);
};

{
  const logs = [];
  const st = await pulseServer((ws, req, n) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 9 }));
    ws.send(slotFrame(9));
    // The first socket goes quiet, pongs and all still answering. The second keeps talking.
    if (n > 1) {
      const t = setInterval(() => (ws.readyState === 1 ? ws.send(slotFrame(9)) : clearInterval(t)), 10);
    }
  });
  startPulse(st.s.url, logs);
  assert.ok(await waitFor(() => st.conns >= 2, 4000), 'a silent stream on an open socket is replaced');
  assert.ok(logs.some((l) => /answers but nothing has arrived/.test(l)), 'and the log says why');
  const c = st.conns;
  await sleep(300);
  assert.equal(st.conns, c, 'a socket whose stream is alive is left alone');
  watcher._reset();
  await st.s.close();
  console.log('ok  an open socket that stops streaming is replaced within the pulse window');
}
{
  // Never answers, then refuses: neither proves the stream is dead.
  const quiet = await pulseServer(() => {});
  startPulse(quiet.s.url);
  assert.ok(await waitFor(() => quiet.slotAsks === 1));
  await sleep(250);
  assert.equal(quiet.conns, 1, 'no slot was ever heard, so silence means nothing');
  watcher._reset();
  await quiet.s.close();
  const refused = await pulseServer((ws, req) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } })));
  const logs = [];
  startPulse(refused.s.url, logs);
  assert.ok(await waitFor(() => refused.slotAsks === 1));
  await sleep(250);
  assert.equal(refused.conns, 1, 'a host that does not serve slots keeps its socket');
  assert.ok(!logs.some((l) => /subscribe rejected/.test(l)), 'and it is not reported as a wallet problem');
  watcher._reset();
  await refused.s.close();
  console.log('ok  a host without a slot stream is not reconnected over it');
}
{
  // Every socket says one slot then nothing: reconnecting does not help.
  const logs = [];
  const st = await pulseServer((ws, req) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 9 }));
    ws.send(slotFrame(9));
  });
  startPulse(st.s.url, logs);
  assert.ok(await waitFor(() => logs.some((l) => /keeps stopping/.test(l)), 6000), 'it stops believing the pulse');
  const c = st.conns;
  assert.ok(c <= 3, `at most three sockets: ${c}`);
  await sleep(300);
  assert.equal(st.conns, c, 'and stops reconnecting');
  watcher._reset();
  await st.s.close();
  console.log('ok  a slot stream that keeps stopping cannot cause a reconnect loop');
}
{
  // The routine catch-up finds what the live subscription never delivered.
  const logs = [];
  const st = await pulseServer(() => {});
  startPulse(st.s.url, logs);
  watcher._setMissGraceMs(-5_000);
  const W = 'Pulse111111111111111111111111111111111111111';
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'watching'));
  // From before this subscription: not its to deliver.
  sigList = [{ signature: 'beforeSub', err: null, blockTime: Math.floor(Date.now() / 1000) - 60 }];
  watcher._recoverTick(Date.now());
  await sleep(150);
  assert.equal(st.conns, 1, 'older than the subscription proves nothing');
  // Landed while it was up.
  sigList = [{ signature: 'missedLive', err: null, blockTime: Math.ceil(Date.now() / 1000) + 1 }];
  watcher._recoverTick(Date.now() + 6 * 60_000);
  assert.ok(await waitFor(() => st.conns === 2, 2000), 'every wallet is resubscribed');
  assert.ok(logs.some((l) => /live feed missed a transaction/.test(l)));
  assert.ok(await waitFor(() => watcher.status()[W]?.state === 'watching'));
  sigList = [{ signature: 'missedLive2', err: null, blockTime: Math.ceil(Date.now() / 1000) + 1 }];
  watcher._recoverTick(Date.now() + 12 * 60_000);
  await sleep(150);
  assert.equal(st.conns, 2, 'at most once in five minutes');
  assert.ok(logs.filter((l) => /live feed missed/.test(l)).length === 1);
  sigList = [];
  watcher._reset();
  await st.s.close();
  console.log('ok  a catch-up that proves the feed missed a trade resubscribes everyone');
}

console.log('\nwalletwatcher: all tests passed');
