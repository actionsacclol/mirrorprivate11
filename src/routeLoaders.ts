import type { RouteId } from './state/nav';

// One loader per code-split route (2026-09-08).
//
// App.tsx builds its lazy components from these, and the top navigation
// warms the same loaders on hover, so the chunk a click needs is usually in
// the module cache before the click lands. This map is the only place a page
// chunk is named.
//
// Home is the landing page, so it is not here: it ships in the entry bundle
// and the app opens on it with nothing left to fetch.
export const ROUTE_LOADERS = {
  discover: () => import('./pages/Discover'),
  check: () => import('./pages/Check'),
  following: () => import('./pages/Following'),
  activity: () => import('./pages/Activity'),
  wallet: () => import('./pages/WalletHub'),
  settings: () => import('./pages/SettingsHub'),
  follow: () => import('./pages/Follow'),
  book: () => import('./pages/AddressBook'),
  ai: () => import('./pages/Ai'),
} as const;

type LoaderMap = Partial<Record<RouteId, () => Promise<unknown>>>;

const warmed = new Map<RouteId, Promise<unknown>>();

/** Fetch a route's chunk now (idempotent; a failed fetch is retried on the
 *  next ask). Routes in the entry bundle resolve at once. */
export function prefetchRoute(id: RouteId): Promise<void> {
  const load = (ROUTE_LOADERS as LoaderMap)[id];
  if (!load) return Promise.resolve();
  let p = warmed.get(id);
  if (!p) {
    p = load().catch(() => {
      warmed.delete(id);
    });
    warmed.set(id, p);
  }
  return p.then(() => undefined);
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

/** Warm chunks in the background, one at a time, once the first screen has
 *  had `delayMs` to itself. Returns a cancel for unmount. */
export function prefetchWhenIdle(ids: RouteId[], delayMs = 2500): () => void {
  let cancelled = false;
  const queue = ids.filter((id) => !warmed.has(id));
  const idle = (cb: () => void): void => {
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(cb, { timeout: 4000 });
    else window.setTimeout(cb, 250);
  };
  const next = (): void => {
    if (cancelled) return;
    const id = queue.shift();
    if (!id) return;
    void prefetchRoute(id).finally(() => idle(next));
  };
  const t = window.setTimeout(() => idle(next), delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(t);
  };
}
