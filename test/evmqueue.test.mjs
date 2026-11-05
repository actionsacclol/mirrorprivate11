// The per-chain queue: one job at a time, and an exit never waits behind buys.
import assert from 'node:assert/strict';
import { makeChainQueue } from './.chainqueue.mjs';

let passed = 0;
const ok = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

await ok('one job at a time per chain, and chains do not wait on each other', async () => {
  const q = makeChainQueue();
  const g = gate();
  const seen = [];
  const a = q.run('bnb', async () => { seen.push('a'); await g.p; });
  const b = q.run('bnb', async () => { seen.push('b'); });
  const c = q.run('robinhood', async () => { seen.push('c'); });
  await tick();
  assert.deepEqual(seen.sort(), ['a', 'c'], 'b waits for a; the other chain does not');
  g.open();
  await Promise.all([a, b, c]);
  assert.ok(seen.includes('b'));
});

await ok('a sell goes ahead of every queued buy, never ahead of the one running', async () => {
  const q = makeChainQueue();
  const g = gate();
  const order = [];
  const job = (name, wait) => async () => { order.push(name); if (wait) await wait; };
  const all = [
    q.run('bnb', job('buy1', g.p), true),
    q.run('bnb', job('buy2'), true),
    q.run('bnb', job('buy3'), true),
  ];
  await tick();
  all.push(q.run('bnb', job('sell1')));
  all.push(q.run('bnb', job('sell2')));
  await tick();
  assert.deepEqual(order, ['buy1'], 'the running one is not interrupted');
  g.open();
  await Promise.all(all);
  assert.deepEqual(order, ['buy1', 'sell1', 'sell2', 'buy2', 'buy3']);
});

await ok('a job that throws rejects its own caller and the queue carries on', async () => {
  const q = makeChainQueue();
  const bad = q.run('bnb', async () => { throw new Error('nope'); });
  const syncBad = q.run('bnb', () => { throw new Error('sync'); });
  const good = q.run('bnb', async () => 7);
  await assert.rejects(bad, /nope/);
  await assert.rejects(syncBad, /sync/);
  assert.equal(await good, 7);
});

await ok('idle waits for everything queued, so a quit never cuts a send', async () => {
  const q = makeChainQueue();
  const g = gate();
  let done = 0;
  void q.run('bnb', async () => { await g.p; done += 1; });
  void q.run('bnb', async () => { done += 1; }, true);
  let idle = false;
  const wait = q.idle().then(() => { idle = true; });
  await tick();
  assert.equal(idle, false);
  g.open();
  await wait;
  assert.equal(done, 2);
  await q.idle();
});

console.log(`\nevmqueue: ${passed}/${passed} passed`);
