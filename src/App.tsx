import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { ensureRouteCacheSubscribed } from './state/routeCache';
import { ROUTE_LOADERS, prefetchRoute, prefetchWhenIdle } from './routeLoaders';
import { Onboarding } from './components/Onboarding';
import { IntegrityBanner } from './components/IntegrityBanner';
import { LiteModeHost } from './components/LiteModeHost';
import { TopNav } from './shell/TopNav';
import { HomePage } from './pages/Home';
import { NavContext, type FollowTarget, type Nav, type NavState, type RouteId } from './state/nav';
import { openTokenExternally } from './utils/links';

// Krypto Mirror (2026-10-22): its own app, not Krypto Bot with pages removed.
//
// Six places — Home, Discover, Following, Activity, Wallet, Settings — on a
// top bar, and two things any page can start: open a wallet's profile, and
// follow a wallet (the Follow page, 2026-10-24 — it was a pop-up). Home is in the entry bundle so the app opens on it with
// nothing to fetch; every other page loads on first visit and is warmed on
// hover (routeLoaders.ts).
const DiscoverPage = lazy(() => ROUTE_LOADERS.discover().then((m) => ({ default: m.DiscoverPage })));
const FollowingPage = lazy(() => ROUTE_LOADERS.following().then((m) => ({ default: m.FollowingPage })));
const ActivityPage = lazy(() => ROUTE_LOADERS.activity().then((m) => ({ default: m.ActivityPage })));
const WalletHub = lazy(() => ROUTE_LOADERS.wallet().then((m) => ({ default: m.WalletHub })));
const SettingsHub = lazy(() => ROUTE_LOADERS.settings().then((m) => ({ default: m.SettingsHub })));
const FollowPage = lazy(() => ROUTE_LOADERS.follow().then((m) => ({ default: m.FollowPage })));
const CheckPage = lazy(() => ROUTE_LOADERS.check().then((m) => ({ default: m.CheckPage })));
const AddressBookPage = lazy(() => ROUTE_LOADERS.book().then((m) => ({ default: m.AddressBookPage })));
const AiPage = lazy(() => ROUTE_LOADERS.ai().then((m) => ({ default: m.AiPage })));

const WARM_ROUTES: RouteId[] = ['discover', 'check', 'following', 'activity', 'wallet'];

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-accent" />
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<NavState>({ route: 'home', profile: null, settingsTab: 'general', guide: null, activityTab: 'copies', walletTab: 'solana', followTarget: null, back: null, checkInput: null });
  // Where the user asked to go. The bar follows this at once; the page
  // itself arrives inside a transition, so a page whose chunk is still
  // loading never swaps the screen for a spinner.
  const [target, setTarget] = useState<RouteId>('home');
  const [isPending, startTransition] = useTransition();
  useEffect(() => ensureRouteCacheSubscribed(), []);
  useEffect(() => prefetchWhenIdle(WARM_ROUTES), []);

  // Gated until Onboarding reports otherwise: the shell is inert while the
  // legal/setup overlay is up, so nothing behind it is reachable before the
  // terms are accepted.
  const [gated, setGated] = useState(true);

  const go = useCallback<Nav['go']>((route, opts) => {
    void prefetchRoute(route);
    setTarget(route);
    startTransition(() =>
      setState((s) => ({
        route,
        // Going anywhere by the bar closes a profile: Discover opens on its
        // board, not on the last wallet looked at.
        profile: null,
        followTarget: null,
        back: null,
        checkInput: null,
        settingsTab: opts?.settingsTab ?? (route === 'settings' ? 'general' : s.settingsTab),
        guide: opts?.guide ?? null,
        activityTab: opts?.activityTab ?? s.activityTab,
        walletTab: opts?.walletTab ?? (route === 'wallet' ? 'solana' : s.walletTab),
      })),
    );
  }, []);

  const openFollow = useCallback((follow: FollowTarget) => {
    void prefetchRoute('follow');
    setTarget('follow');
    startTransition(() =>
      setState((s) => ({
        ...s,
        route: 'follow',
        followTarget: follow,
        // Opened again from the page itself (Change wallet), keep the first way back.
        back: s.route === 'follow' ? s.back : { route: s.route, profile: s.profile },
      })),
    );
  }, []);

  const nav = useMemo<Nav>(
    () => ({
      ...state,
      go,
      openWallet: (address: string) => {
        void prefetchRoute('discover');
        setTarget('discover');
        startTransition(() => setState((s) => ({ ...s, route: 'discover', profile: address })));
      },
      closeProfile: () => setState((s) => ({ ...s, profile: null })),
      // The Follow page remembers where it was opened from, profile and all,
      // so Back lands on the same wallet's profile or the same list.
      follow: (address?: string) => openFollow({ address }),
      editFollow: (config) => openFollow({ config }),
      goBack: () => {
        const b = state.back ?? { route: 'following' as RouteId, profile: null };
        setTarget(b.route);
        startTransition(() => setState((s) => ({ ...s, route: b.route, profile: b.profile, followTarget: null, back: null })));
      },
      checkWallet: (input: string) => {
        void prefetchRoute('check');
        setTarget('check');
        startTransition(() => setState((s) => ({ ...s, route: 'check', profile: null, followTarget: null, back: null, checkInput: input.trim() || null })));
      },
    }),
    [state, go, openFollow],
  );

  // A notification click asks the engine to open its token. There is no
  // token page here, so it opens on the web like any other coin link.
  useEffect(() => {
    return window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'openToken') return;
      openTokenExternally(ev.mint, ev.chain);
    });
  }, []);

  const route = state.route;
  return (
    <NavContext.Provider value={nav}>
      <div className="flex h-full flex-col bg-bg">
        <Onboarding onNavigate={(r) => go(r)} onGateChange={setGated} />
        <LiteModeHost />
        {/* `inert` (not typed in React 18) removes the whole shell from the
            tab order and hit-testing while the onboarding gate is up. */}
        <div className="contents" {...(gated ? ({ inert: '' } as Record<string, string>) : {})}>
          <TopNav current={target === 'follow' || target === 'book' ? 'following' : target} />
          <IntegrityBanner />
          {isPending && <div className="pointer-events-none fixed left-0 right-0 top-14 z-30 h-0.5 animate-pulse bg-accent/80" aria-hidden="true" />}
          <main className="relative min-h-0 flex-1">
            <div
              key={
                route +
                (state.profile ?? '') +
                (route === 'follow' ? (state.followTarget?.config?.id ?? state.followTarget?.address ?? 'new') : '') +
                (route === 'check' ? (state.checkInput ?? '') : '')
              }
              className="h-full"
            >
              <Suspense fallback={<RouteFallback />}>
                <div className="h-full animate-ink">
                  {route === 'home' && <HomePage />}
                  {route === 'discover' && <DiscoverPage />}
                  {route === 'check' && <CheckPage />}
                  {route === 'following' && <FollowingPage />}
                  {route === 'activity' && <ActivityPage />}
                  {route === 'wallet' && <WalletHub />}
                  {route === 'settings' && <SettingsHub />}
                  {route === 'follow' && <FollowPage />}
                  {route === 'book' && <AddressBookPage />}
                  {route === 'ai' && <AiPage />}
                </div>
              </Suspense>
            </div>
          </main>
        </div>
      </div>
    </NavContext.Provider>
  );
}
