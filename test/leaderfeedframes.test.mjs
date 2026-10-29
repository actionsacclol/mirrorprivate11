// Leader feed frames (leaderFeedFrames.ts): the two subscriptions a followed
// wallet can ride on. Pinned: the exact `logsSubscribe` frame the watcher has
// always sent; the Helius `transactionSubscribe` frame as its docs show it
// (fetched 2026-09-21) with the app's transaction-version constant; the
// unsubscribe names; which refusals mean "not on this plan"; and that a
// pushed transaction parses into the getTransaction shape the decoder reads —
// or into null, never into a guess.

import assert from 'node:assert';
import {
  decodeParsedBuy,
  FEED_COMMITMENT,
  isPlanRefusal,
  parsedSignedBy,
  parseParsedNotification,
  parseTransactionNotification,
  subscribeFrame,
  unsubscribeFrame,
} from './.leaderfeedframes.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const W = 'Whae1111111111111111111111111111111111111';

{
  const logs = JSON.parse(subscribeFrame('logs', 7, W));
  assert.deepEqual(logs, { jsonrpc: '2.0', id: 7, method: 'logsSubscribe', params: [{ mentions: [W] }, { commitment: 'confirmed' }] });
  const tx = JSON.parse(subscribeFrame('tx', 8, W));
  assert.equal(tx.method, 'transactionSubscribe');
  assert.deepEqual(tx.params[0], { vote: false, failed: false, accountInclude: [W] }, 'filtered to the wallet, no votes, no failures');
  assert.equal(tx.params[1].commitment, 'confirmed', 'a processed push could describe a transaction that never lands');
  assert.equal(tx.params[1].encoding, 'json', 'the shape the decoder reads');
  assert.equal(tx.params[1].transactionDetails, 'full');
  assert.equal(tx.params[1].maxSupportedTransactionVersion, 1, 'transaction v1 is live; without this the push carries no accounts');
  assert.equal(FEED_COMMITMENT, 'confirmed');
  assert.deepEqual(JSON.parse(unsubscribeFrame('logs', 9, 5)), { jsonrpc: '2.0', id: 9, method: 'logsUnsubscribe', params: [5] });
  assert.deepEqual(JSON.parse(unsubscribeFrame('tx', 10, 6)), { jsonrpc: '2.0', id: 10, method: 'transactionUnsubscribe', params: [6] });
  ok('both subscribe frames and both unsubscribe frames are exactly as the hosts expect');
}

{
  assert.equal(isPlanRefusal('Method not found', -32601), true);
  assert.equal(isPlanRefusal('Method not found'), true);
  assert.equal(isPlanRefusal('transactionSubscribe requires a Developer plan or higher'), true);
  assert.equal(isPlanRefusal('Unauthorized'), true);
  assert.equal(isPlanRefusal('Too many subscriptions'), false, 'a volume refusal is not a plan refusal');
  assert.equal(isPlanRefusal('Internal error'), false);
  ok('a plan or method refusal is told apart from a transient one');
}

{
  const meta = { err: null, fee: 5000, preBalances: [1], postBalances: [1], preTokenBalances: [], postTokenBalances: [] };
  const message = { accountKeys: [W], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] };
  // Helius: result.transaction is the getTransaction shape.
  const wrapped = parseTransactionNotification({
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: { subscription: 4743, result: { signature: 'sig1', slot: 224341380, transaction: { transaction: { message, signatures: ['sig1'] }, meta } } },
  });
  assert.ok(wrapped);
  assert.equal(wrapped.subscription, 4743);
  assert.equal(wrapped.signature, 'sig1');
  assert.equal(wrapped.slot, 224341380);
  assert.ok(wrapped.tx, 'the transaction came with the push');
  assert.deepEqual(wrapped.tx.transaction.message, message);
  assert.deepEqual(wrapped.tx.meta, meta);
  // The message on its own with the meta beside it.
  const flat = parseTransactionNotification({ method: 'transactionNotification', params: { subscription: 1, result: { signature: 'sig2', transaction: { message }, meta } } });
  assert.ok(flat?.tx);
  assert.deepEqual(flat.tx.transaction.message, message);
  assert.deepEqual(flat.tx.meta, meta);
  assert.equal(flat.tx.blockTime, null, 'a push carries no block time — undated, never invented');
  // A shape the decoder does not know is a signature to read back, not a guess.
  const unknown = parseTransactionNotification({ method: 'transactionNotification', params: { subscription: 1, result: { signature: 'sig3', transaction: {} } } });
  assert.ok(unknown);
  assert.equal(unknown.tx, null);
  assert.equal(unknown.signature, 'sig3');
  // Not a transaction notification at all.
  assert.equal(parseTransactionNotification({ method: 'logsNotification', params: { subscription: 1, result: { value: { signature: 'x' } } } }), null);
  assert.equal(parseTransactionNotification({ method: 'transactionNotification', params: { subscription: 'no', result: { signature: 'x' } } }), null);
  assert.equal(parseTransactionNotification(null), null);
  ok('a pushed transaction parses into the decoder’s shape, an unknown shape into a read-back, junk into null');
}

// ── Helius Parsed Streams (2026-10-24) ─────────────────────────────────
// Shapes from live payloads (probe, 2026-10-24), trimmed to what is read.
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const MINT = 'CoinA111111111111111111111111111111111pump';
const CURVE = 'Curve11111111111111111111111111111111111111';
const OP = 'Operator11111111111111111111111111111111111';

/** A pump curve buy by `user`: the buy instruction at top level (signed by
 *  `signer`), its TradeEvent as an inner one, and the coin arriving. */
function pumpBuy({ user = W, signer = W, feePayer = W, isBuy = true, extraIxs = [], extraTransfers = [], args = {} } = {}) {
  return {
    transaction: {
      signature: 'sigParsed1',
      slot: 461057743,
      blockTime: null,
      feePayer,
      status: 'ok',
      accountKeys: [feePayer, user, CURVE, MINT, PUMP],
      tokenTransfers: [
        { fromUserAccount: CURVE, toUserAccount: user, mint: MINT, rawTokenAmount: 3753176438869, decimals: 6 },
        ...extraTransfers,
      ],
    },
    instructions: [
      {
        innerInstructionIndex: null,
        stackHeight: 1,
        programId: PUMP,
        instructionName: isBuy ? 'buy' : 'sell',
        decoded: { args: {}, accounts: [{ name: 'user', pubkey: signer, isSigner: true, isWritable: true }] },
      },
      {
        innerInstructionIndex: 0,
        stackHeight: 2,
        programId: PUMP,
        instructionName: 'TradeEvent',
        decoded: {
          args: {
            user,
            mint: MINT,
            is_buy: isBuy,
            ix_name: isBuy ? 'buy' : 'sell',
            quote_mint: '11111111111111111111111111111111',
            sol_amount: '489330267',
            quote_amount: '489330267',
            fee: '4648638',
            creator_fee: '1467991',
            buyback_fee: '2324319',
            cashback: '0',
            holder_rewards: '0',
            token_amount: '3753176438869',
            ...args,
          },
        },
      },
      ...extraIxs,
    ],
  };
}

{
  assert.deepEqual(JSON.parse(subscribeFrame('parsed', 11, W)), {
    jsonrpc: '2.0',
    id: 11,
    method: 'parsedTransactionSubscribe',
    params: [{ accounts: { include: [W] }, includeFailed: false }, { commitment: 'confirmed', details: 'full' }],
  });
  assert.deepEqual(JSON.parse(unsubscribeFrame('parsed', 12, 3)), { jsonrpc: '2.0', id: 12, method: 'parsedTransactionUnsubscribe', params: [3] });
  const value = pumpBuy();
  const n = parseParsedNotification({ jsonrpc: '2.0', method: 'parsedTransactionNotification', params: { subscription: 1, result: { context: { slot: 9 }, value } } });
  assert.equal(n.subscription, 1);
  assert.equal(n.signature, 'sigParsed1');
  assert.equal(n.slot, 461057743, 'the transaction’s own slot');
  assert.equal(n.failed, false);
  assert.equal(parseParsedNotification({ method: 'parsedTransactionNotification', params: { subscription: 1, result: { value: { ...value, transaction: { ...value.transaction, status: 'failed' } } } } }).failed, true);
  assert.equal(parseParsedNotification({ method: 'logsNotification', params: { subscription: 1, result: { value } } }), null);
  assert.equal(parseParsedNotification({ method: 'parsedTransactionNotification', params: { subscription: 1, result: { value: {} } } }), null);
  ok('the Parsed Streams frames are as the docs show them, and a push parses or is null');
}

{
  const swap = decodeParsedBuy(pumpBuy(), W);
  assert.ok(swap, 'a plain curve buy decodes from the push');
  assert.equal(swap.isBuy, true);
  assert.equal(swap.mint, MINT);
  // curve + fee + creator fee; the buyback fee is inside `fee`. Equal to the
  // wallet's balance delta from getTransaction on the live sample.
  assert.equal(swap.sol, 0.495446896);
  assert.equal(swap.tokens, 3753176.438869);
  assert.equal(swap.decimals, 6);
  assert.equal(swap.heldBefore, null, 'the push has no balances: unknown, never 0');
  assert.equal(swap.soldFraction, null);
  assert.deepEqual(swap.programs, [PUMP], 'top-level programs only');
  // Fee payer elsewhere (a relayer) is fine when the wallet signed the buy.
  assert.ok(decodeParsedBuy(pumpBuy({ feePayer: OP }), W));
  ok('a plain pump curve buy is decoded from the push at the price the wallet paid');
}

{
  const none = (v, why) => assert.equal(decodeParsedBuy(v, W), null, why);
  // Measured: a Mayhem-mode wallet trades through a program that moves its
  // funds without its signature — walletSwap's rule 1 rejects all of those.
  const unsigned = pumpBuy({ signer: OP, feePayer: OP });
  assert.equal(parsedSignedBy(unsigned, W), false);
  none(unsigned, 'TradeEvent.user is not a signature');
  none(pumpBuy({ isBuy: false }), 'a sell needs the pre-balance the push lacks');
  none({ ...pumpBuy(), transaction: { ...pumpBuy().transaction, status: 'failed' } }, 'a failed transaction');
  none(pumpBuy({ extraTransfers: [{ fromUserAccount: W, toUserAccount: OP, mint: MINT, rawTokenAmount: 1, decimals: 6 }] }), 'tokens sent on');
  none(pumpBuy({ extraTransfers: [{ fromUserAccount: W, toUserAccount: OP, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', rawTokenAmount: 5, decimals: 6 }] }), 'a stable leg');
  none(pumpBuy({ extraIxs: [{ innerInstructionIndex: 3, programId: PUMP, instructionName: 'CompleteEvent', decoded: { args: {} } }] }), 'the curve completing in this buy');
  none(pumpBuy({ extraIxs: [{ innerInstructionIndex: 4, programId: AMM, instructionName: 'BuyEvent', decoded: { args: { user: W } } }] }), 'a second trade in the transaction');
  none(pumpBuy({ args: { cashback: '100' } }), 'a field the SOL sum was not measured with');
  none(pumpBuy({ args: { quote_mint: MINT } }), 'not SOL-quoted');
  none(pumpBuy({ args: { sol_amount: '1000', quote_amount: '1000', fee: '0', creator_fee: '0' } }), 'under the buy floor: the read-back decides');
  none(pumpBuy({ args: { token_amount: '1' } }), 'the event and the transfers disagree');
  const amm = pumpBuy();
  amm.instructions[1] = { ...amm.instructions[1], programId: AMM, instructionName: 'BuyEvent' };
  none(amm, 'a PumpSwap buy is read back');
  ok('everything but a clean, signed, single curve buy is left to the read-back');
}

console.log(`\nleaderfeedframes: ${passed}/6 passed`);
