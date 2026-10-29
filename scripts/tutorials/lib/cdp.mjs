// Chrome DevTools Protocol client for the tutorial recorder (2026-10-25).
//
// Attaches to a RUNNING Krypto Mirror instance that was started with
// KRYPT_DEBUG_PORT set (dev only — a packaged build never opens the port).
// One websocket, numbered calls, event listeners. Nothing here knows about
// the app; see ./ui.mjs for the driver.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

/**
 * Connect to the app's main page over CDP.
 * @param {number|string} port
 */
export async function connect(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page =
    list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error(`no page target on port ${port} — is the app running with KRYPT_DEBUG_PORT=${port}?`);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) {
      for (const fn of listeners.get(m.method) ?? []) fn(m.params);
    }
  });
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result ?? {})));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };
  /** Evaluate an expression in the page; promises are awaited; the value comes back by value. */
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  return {
    page,
    call,
    on,
    evaluate,
    close: () => ws.close(),
  };
}
