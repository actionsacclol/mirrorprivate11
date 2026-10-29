// The top navigation (2026-10-22) — Krypto Mirror's whole frame.
//
// Left: the mark and the six places (Check joined 2026-10-25). Right: the chain (only when another
// chain is switched on — Solana first), Paper/Live for that chain, the
// balance, light/dark and Settings. The Paper/Live and balance logic is the
// one the old top bar had, unchanged: each chain arms on its own, and going
// Live always asks first.

import { useEffect, useRef, useState } from 'react';
import { Activity, BookOpen, Bot, Check, Compass, Home, Moon, ScanSearch, Settings as SettingsIcon, Sun, Users, Wallet as WalletIcon } from 'lucide-react';
import type { WalletSummary } from '@shared/types';
import { EVM_CHAIN_META, isEvmChain, nativeSymbolOf, type ChainKind, type EvmChainKind } from '@shared/evm';
import { useAppState } from '../state/AppStateProvider';
import { useTerminal } from '../state/TerminalProvider';
import { useEvmState } from '../state/useEvmState';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';
import { resolved, setAppearance, useAppearance } from '../state/appearance';
import { prefetchRoute } from '../routeLoaders';
import { ProfileBadge } from '../components/terminal/ProfilesPanel';
import { fmtNative } from '../utils/evm';
import { cls, shortAddr } from '../utils/format';
import { useNav, type RouteId } from '../state/nav';

const ITEMS: Array<{ id: RouteId; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'discover', label: 'Discover', icon: Compass },
  { id: 'check', label: 'Check', icon: ScanSearch },
  { id: 'following', label: 'Following', icon: Users },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'wallet', label: 'Wallet', icon: WalletIcon },
  { id: 'ai', label: 'AI', icon: Bot },
];

const CHAIN_LABEL: Record<ChainKind, string> = { solana: 'Solana', robinhood: 'Robinhood', bnb: 'BNB' };

/** Shown only when Robinhood or BNB is switched on in Settings. */
function ChainPicker() {
  const { chain, setChain, setAllChains } = useTerminal();
  const { settings } = useAppState();
  const enabled = (c: ChainKind): boolean => (c === 'solana' ? true : settings.evm[c].enabled);
  const chains = (['solana', 'robinhood', 'bnb'] as ChainKind[]).filter(enabled);
  useEffect(() => {
    setAllChains(false);
    if (!enabled(chain)) setChain('solana');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, settings.evm.robinhood.enabled, settings.evm.bnb.enabled]);
  if (chains.length < 2) return null;
  return (
    <select
      value={chain}
      onChange={(e) => setChain(e.target.value as ChainKind)}
      title="Which chain the wallet, Paper/Live and the balance are for"
      className="rounded-lg border border-white/10 bg-raised px-2.5 py-1.5 text-body font-medium text-white outline-none"
    >
      {chains.map((c) => (
        <option key={c} value={c}>
          {CHAIN_LABEL[c]}
        </option>
      ))}
    </select>
  );
}

function ModeSwitch() {
  const { chain } = useTerminal();
  const { status } = useAppState();
  const modal = useModal();
  const toast = useToast();
  const evmChain: EvmChainKind | null = isEvmChain(chain) ? chain : null;
  const { evm, refresh } = useEvmState(evmChain);
  const live = evmChain ? evm?.live.armed === true : status.liveActive;
  const loading = evmChain !== null && evm === null;
  const unit = nativeSymbolOf(chain);

  const setMode = async (wantLive: boolean): Promise<void> => {
    if (wantLive === live) return;
    if (evmChain) {
      const meta = EVM_CHAIN_META[evmChain];
      if (evm === null) return void toast.warn('Still reading the wallet — try again in a moment.');
      if (wantLive) {
        if (evm.wallet.exists !== true) return void toast.warn(`Create a wallet for ${meta.name} on the Wallet page first.`);
        const yes = await modal.confirm({
          title: `Go Live on ${meta.name}`,
          message: `Live signs and sends REAL transactions from your wallet on ${meta.name}. Every trade is still simulated and checked before it sends — but real ${unit} moves.`,
          confirmLabel: 'Go Live',
          destructive: true,
        });
        if (!yes) return;
        const r = await window.krypt.evm.arm(evmChain);
        r.ok ? toast.warn(r.message) : toast.error(r.message);
      } else {
        const r = await window.krypt.evm.disarm(evmChain);
        r.ok ? toast.success(r.message) : toast.error(r.message);
      }
      void refresh();
      return;
    }
    if (wantLive) {
      const yes = await modal.confirm({
        title: 'Switch to Live',
        message:
          'Live signs and sends REAL transactions from your wallet. A follow only spends once it is switched to Live AND armed on its own card — but this is the master switch. Every trade is still simulated and loss-bounded before it sends.',
        confirmLabel: 'Go Live',
        destructive: true,
      });
      if (!yes) return;
    }
    const r = await window.krypt.live.setLive(wantLive);
    if (r.ok) toast[wantLive ? 'warn' : 'success'](r.message);
    else toast.error(r.message);
    if (r.ok && !wantLive) {
      // Paper sends nothing real — including the exits of live copies already
      // bought. Said here, at the switch, and on each follow's card.
      const s = await window.krypt.copy.list();
      const held = s.ok && s.data ? Object.values(s.data.liveOpen ?? {}).reduce((n, k) => n + k, 0) : 0;
      if (held > 0) {
        toast.warn(`${held} live cop${held === 1 ? 'y is' : 'ies are'} still open. On Paper, ${held === 1 ? 'its' : 'their'} stop-loss and exits do not sell — switch back to Live, or sell from the Wallet page.`);
      }
    }
  };

  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-raised p-0.5 text-body font-medium" data-testid="mode-switch" title={`Paper or Live for ${CHAIN_LABEL[chain]}`}>
      <button
        onClick={() => void setMode(false)}
        className={cls('rounded-md px-3 py-1 transition', !live && !loading ? 'bg-card text-white shadow-soft' : 'text-krypt-muted hover:text-white')}
      >
        {loading ? '…' : 'Paper'}
      </button>
      <button
        onClick={() => void setMode(true)}
        className={cls('rounded-md px-3 py-1 transition', live ? 'bg-down text-[#fff]' : 'text-krypt-muted hover:text-white')}
      >
        Live
      </button>
    </div>
  );
}

function Balance({ onOpen }: { onOpen: () => void }) {
  const { chain } = useTerminal();
  const { status } = useAppState();
  const evmChain: EvmChainKind | null = isEvmChain(chain) ? chain : null;
  const { evm, refresh } = useEvmState(evmChain);
  const [addr, setAddr] = useState<string | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  // The wallet switcher (2026-10-28): every Solana wallet, its balance and its
  // pump.fun account, one click to make it the active one. The rule that
  // refuses a switch while live is armed stays in the main process.
  const nav = useNav();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [pumpNames, setPumpNames] = useState<Record<string, string>>({});
  const box = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  // Solana: the engine's figure while it runs (pushed every second), a
  // direct read otherwise — every 60 s is enough to notice a deposit.
  useEffect(() => {
    let alive = true;
    const read = (force = false): void => {
      const st = statusRef.current;
      const engineHas = st.running && st.walletBalanceSol !== null && st.walletBalanceSol !== undefined;
      void window.krypt.wallet.info().then((r) => {
        if (!alive || !r.ok || !r.data) return;
        setAddr(r.data.publicKey);
        if (force || !engineHas) setSol(r.data.balanceSol);
      });
    };
    read(true);
    const t = setInterval(() => read(), 60_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'walletSwitched') read(true);
    });
    return () => {
      alive = false;
      clearInterval(t);
      off();
    };
  }, []);

  useEffect(() => {
    if (!evmChain) return;
    let alive = true;
    const tick = (): void => {
      void window.krypt.evm.wallet.refreshBalance(evmChain).then(() => alive && void refresh());
    };
    tick();
    const t = setInterval(() => !document.hidden && tick(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [evmChain, refresh]);

  const value = evmChain
    ? evm === null
      ? '…'
      : fmtNative(evm.wallet.balanceNative ?? null, nativeSymbolOf(evmChain))
    : (() => {
        const b = status.running ? (status.walletBalanceSol ?? sol) : (sol ?? status.walletBalanceSol);
        // A wallet whose balance is not read yet is still a wallet.
        return b != null ? `${b.toFixed(3)} SOL` : addr ? '— SOL' : 'No wallet';
      })();
  const who = evmChain ? evm?.wallet.address ?? null : addr;

  const loadWallets = (): void => {
    void window.krypt.wallet.list().then((r) => r.ok && r.data && setWallets(r.data));
  };
  useEffect(() => loadWallets(), [addr]);
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);
  const openMenu = (): void => {
    loadWallets();
    void window.krypt.pump.status().then((r) => {
      if (!r.ok || !r.data) return;
      const names: Record<string, string> = {};
      for (const s of r.data.sessions) names[s.walletId] = s.username ? `@${s.username}` : 'pump.fun account';
      setPumpNames(names);
    });
    setMenu(true);
  };
  const pick = async (id: string): Promise<void> => {
    const r = await window.krypt.wallet.select(id);
    if (!r.ok) return void toast.error(r.message);
    toast.success(r.message);
    setMenu(false);
    loadWallets();
  };
  const go = (walletTab: 'solana' | 'pump'): void => {
    setMenu(false);
    nav.go('wallet', { walletTab });
  };
  // A menu once there is a Solana wallet to show; otherwise straight to setup.
  const switcher = !evmChain && wallets.length > 0;

  return (
    <div ref={box} className="relative">
      {/* The balance alone, on one line (2026-10-28): the address under it was
          squeezed by the bar's height and the two lines cut each other off.
          The address is in the tooltip and the switcher. */}
      <button
        onClick={() => (switcher ? (menu ? setMenu(false) : openMenu()) : onOpen())}
        className="flex h-9 items-center whitespace-nowrap rounded-lg px-2.5 text-body font-semibold tabular-nums text-white transition hover:bg-white/5"
        title={who ? (switcher ? `Your wallet ${shortAddr(who, 4)} — switch wallets` : `Your wallet ${shortAddr(who, 4)} — open it`) : 'Set up a wallet'}
        aria-expanded={switcher ? menu : undefined}
        data-testid="nav-balance"
      >
        {value}
      </button>
      {menu && (
        <div className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-white/10 bg-card p-1.5 shadow-soft" data-testid="nav-wallets">
          <div className="px-2.5 pb-1 pt-1.5 text-label text-krypt-muted">Trading wallet</div>
          {wallets.map((w) => (
            <button
              key={w.id}
              onClick={() => void (w.active ? go('solana') : pick(w.id))}
              className={cls('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition', w.active ? 'bg-accent/10' : 'hover:bg-white/5')}
              data-testid="nav-wallet-row"
            >
              <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-accent">{w.active && <Check className="h-4 w-4" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-note font-semibold text-white">{w.label || 'Wallet'}</span>
                <span className="block truncate text-label text-krypt-muted">
                  <span className="font-mono">{shortAddr(w.publicKey)}</span>
                  {' · '}
                  {pumpNames[w.id] ?? 'no pump.fun account'}
                </span>
              </span>
              <span className="font-mono text-note tabular-nums text-white/85">{w.balanceSol != null ? `${w.balanceSol.toFixed(3)}` : '—'}</span>
            </button>
          ))}
          <p className="px-2.5 pb-1 pt-1.5 text-label leading-relaxed text-krypt-muted/80">
            Follows set to “Active wallet” copy with the one ticked. Switching waits until live is off and their open live copies have closed.
          </p>
          <div className="mt-1 flex gap-1 border-t border-white/8 pt-1.5">
            <button onClick={() => go('solana')} className="flex-1 rounded-lg px-2.5 py-1.5 text-note text-white/90 transition hover:bg-white/5" data-testid="nav-wallets-manage">
              Add or manage
            </button>
            <button onClick={() => go('pump')} className="flex-1 rounded-lg px-2.5 py-1.5 text-note text-white/90 transition hover:bg-white/5" data-testid="nav-wallets-pump">
              pump.fun accounts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AppearanceToggle() {
  const a = useAppearance();
  const isLight = resolved(a) === 'light';
  return (
    <button
      onClick={() => setAppearance(isLight ? 'dark' : 'light')}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-krypt-muted transition hover:bg-white/5 hover:text-white"
      title={isLight ? 'Switch to dark' : 'Switch to light'}
      aria-label={isLight ? 'Switch to dark' : 'Switch to light'}
    >
      {isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}

export function TopNav({ current }: { current: RouteId }) {
  const nav = useNav();
  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-6 border-b border-white/8 bg-card px-5">
      <button onClick={() => nav.go('home')} className="flex items-center gap-2.5" title="Home">
        <img src="./krypt.png" alt="" className="h-7 w-7 rounded-lg" />
        <span className="text-[15px] font-semibold tracking-display text-white">Krypto Mirror</span>
      </button>

      <nav className="flex items-center gap-1" aria-label="Main">
        {ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => nav.go(id)}
            onMouseEnter={() => void prefetchRoute(id)}
            data-testid={`nav-${id}`}
            aria-current={current === id ? 'page' : undefined}
            className={cls(
              'flex items-center gap-2 rounded-lg px-3 py-1.5 text-note font-medium transition',
              current === id ? 'bg-raised text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <ProfileBadge />
        <ChainPicker />
        <ModeSwitch />
        <Balance onOpen={() => nav.go('wallet')} />
        <AppearanceToggle />
        {/* The Guides (tutorial videos) live under Settings; this is their own door. */}
        <button
          onClick={() => nav.go('settings', { settingsTab: 'guides' })}
          onMouseEnter={() => void prefetchRoute('settings')}
          data-testid="nav-guides"
          className={cls(
            'flex h-9 w-9 items-center justify-center rounded-lg transition',
            current === 'settings' && nav.settingsTab === 'guides' ? 'bg-raised text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white',
          )}
          title="Guides"
          aria-label="Guides"
        >
          <BookOpen className="h-4 w-4" />
        </button>
        <button
          onClick={() => nav.go('settings')}
          onMouseEnter={() => void prefetchRoute('settings')}
          data-testid="nav-settings"
          className={cls(
            'flex h-9 w-9 items-center justify-center rounded-lg transition',
            current === 'settings' && nav.settingsTab !== 'guides' ? 'bg-raised text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white',
          )}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
