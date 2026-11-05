// One trade at a time per chain, with buys behind everything else (2026-11-04).
//
// Nonces are sequential on a chain, and two sells racing on one holding is how
// a "100 %" reverts, so each chain runs one job at a time. With no copy limits
// set a leader's burst can queue many buys, and an exit must not sit behind
// them. Each job builds its nonce when it runs, so the order can change freely.
//
// Pure: no chain, no wallet. test/evmqueue.test.mjs pins it.

interface Queue {
  first: Array<() => Promise<void>>;
  buys: Array<() => Promise<void>>;
  running: Promise<void> | null;
}

export interface ChainQueue<K> {
  run<T>(key: K, fn: () => Promise<T>, isBuy?: boolean): Promise<T>;
  /** Settles when nothing is running or queued, on any key. */
  idle(): Promise<void>;
}

export function makeChainQueue<K>(): ChainQueue<K> {
  const queues = new Map<K, Queue>();
  const pump = (q: Queue): void => {
    if (q.running) return;
    const job = q.first.shift() ?? q.buys.shift();
    if (!job) return;
    q.running = job().finally(() => {
      q.running = null;
      pump(q);
    });
  };
  return {
    run<T>(key: K, fn: () => Promise<T>, isBuy = false): Promise<T> {
      let q = queues.get(key);
      if (!q) {
        q = { first: [], buys: [], running: null };
        queues.set(key, q);
      }
      const queue = q;
      return new Promise<T>((resolve, reject) => {
        (isBuy ? queue.buys : queue.first).push(() => Promise.resolve().then(fn).then(resolve, reject));
        // Not synchronously: a caller's next line runs before its job does.
        void Promise.resolve().then(() => pump(queue));
      });
    },
    async idle(): Promise<void> {
      for (;;) {
        // A tick first: a job just queued starts on the next one.
        await Promise.resolve();
        const running = [...queues.values()].map((q) => q.running).filter((r): r is Promise<void> => r !== null);
        if (!running.length) return;
        await Promise.allSettled(running);
      }
    },
  };
}
