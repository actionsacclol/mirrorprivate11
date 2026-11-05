// The wallet card (2026-11-04): click the balance in the top bar and this opens
// in the middle of the screen, with the address, the balance, a refresh button
// and Send / Withdraw. The wallet switcher that used to drop down from the
// balance lives here too.
//
// Sending reuses SendCard, so nothing is signed without main's own re-read and
// the native confirmation (ipc.ts send:execute). The card cannot close while a
// send is in flight: that would hide a failure.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUpRight, Check, Copy, ExternalLink, RefreshCw, X } from 'lucide-react';
import type { WalletSummary } from '@shared/types';
import { EVM_CHAIN_META, explorerAddress, isEvmChain, nativeSymbolOf, type ChainKind } from '@shared/evm';
import { useNav } from '../state/nav';
import { approxUsd, useSolUsd } from '../state/useSolUsd';
import { useToast } from '../state/ToastProvider';
import { cls, fmtClock, fmtUsd, shortAddr } from '../utils/format';
import { PrimaryButton } from './common';
import { SendCard } from './terminal/SendCard';
import { AutoTradeToggle, useVaultStatus, VaultCardLine } from './VaultPanel';

type View = 'main' | 'send' | 'wallets';

interface Shown {
  address: string | null;
  balance: number | null;
  checkedAt: number | null;
  label: string | null;
  /** The saved withdrawal address. Solana only. */
  home: string | null;
}

export function WalletCard({
  chain,
  onClose,
  onSolBalance,
  onEvmChanged,
}: {
  chain: ChainKind;
  onClose: () => void;
  /** So the top bar shows the figure this card just read. */
  onSolBalance: (sol: number | null) => void;
  onEvmChanged: () => void;
}) {
  const evmChain = isEvmChain(chain) ? chain : null;
  const unit = nativeSymbolOf(chain);
  const chainName = evmChain ? EVM_CHAIN_META[evmChain].name : 'Solana';
  const nav = useNav();
  const toast = useToast();
  const solUsd = useSolUsd();
  const [view, setView] = useState<View>('main');
  const [shown, setShown] = useState<Shown | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [pumpNames, setPumpNames] = useState<Record<string, string>>({});
  const box = useRef<HTMLDivElement>(null);
  const vaultStatus = useVaultStatus();
  // Only the newest read may land: a wallet switch can overtake a slow one.
  const latestRead = useRef(0);

  const close = useCallback((): void => {
    if (!sending) onClose();
  }, [sending, onClose]);

  const refresh = useCallback(async (): Promise<void> => {
    const id = ++latestRead.current;
    setRefreshing(true);
    let next: Shown | null = null;
    let problem: string | null = null;
    if (evmChain) {
      const fresh = await window.krypt.evm.wallet.refreshBalance(evmChain);
      const r = fresh.ok && fresh.data ? fresh : await window.krypt.evm.wallet.info(evmChain);
      if (!fresh.ok) problem = fresh.message;
      if (r.ok && r.data) {
        next = { address: r.data.address, balance: r.data.balanceNative, checkedAt: r.data.balanceCheckedAt, label: r.data.label, home: null };
      }
    } else {
      const fresh = await window.krypt.wallet.refreshBalance();
      const r = fresh.ok && fresh.data ? fresh : await window.krypt.wallet.info();
      if (!fresh.ok) problem = fresh.message;
      if (r.ok && r.data) {
        next = { address: r.data.publicKey, balance: r.data.balanceSol, checkedAt: r.data.balanceCheckedAt, label: r.data.label, home: r.data.homeAddress };
      }
    }
    if (id !== latestRead.current) return;
    if (next) setShown(next);
    setFailure(problem);
    setRefreshing(false);
    if (evmChain) onEvmChanged();
    else if (next) onSolBalance(next.balance);
  }, [evmChain, onEvmChanged, onSolBalance]);

  useEffect(() => {
    void refresh();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'walletSwitched') void refresh();
    });
    return off;
  }, [refresh]);

  // Once, on opening: the top bar re-renders every second, and focusing again
  // would pull the cursor out of the Send form mid-typing.
  useEffect(() => {
    box.current?.focus();
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [close]);

  const address = shown?.address ?? null;

  const copy = (): void => {
    if (!address) return;
    void navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy the address'),
    );
  };

  const openWallets = (): void => {
    setView('wallets');
    // The last figures at once, then every wallet's balance from the chain.
    void window.krypt.wallet.list().then((r) => r.ok && r.data && setWallets(r.data));
    void window.krypt.wallet.refreshAll().then((r) => r.ok && r.data && setWallets(r.data));
    void window.krypt.pump.status().then((r) => {
      if (!r.ok || !r.data) return;
      const names: Record<string, string> = {};
      for (const s of r.data.sessions) names[s.walletId] = s.username ? `@${s.username}` : 'pump.fun account';
      setPumpNames(names);
    });
  };

  const pick = async (id: string): Promise<void> => {
    const r = await window.krypt.wallet.select(id);
    if (!r.ok) return void toast.error(r.message);
    toast.success(r.message);
    setView('main');
  };

  const leaveTo = (walletTab: 'solana' | 'pump' | 'robinhood' | 'bnb'): void => {
    onClose();
    nav.go('wallet', { walletTab });
  };

  const explorer = address ? (evmChain ? explorerAddress(evmChain, address) : `https://solscan.io/account/${address}`) : null;
  const balanceText = shown?.balance != null ? shown.balance.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 2 }) : '—';
  const usd = evmChain ? '' : approxUsd(shown?.balance, solUsd, fmtUsd);

  // A portal, so nothing on a page can stack above it.
  return createPortal(
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      data-testid="wallet-card-backdrop"
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Your wallet"
        className="flex h-[460px] max-h-full w-[460px] max-w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-card shadow-pop outline-none"
        data-testid="wallet-card"
      >
        <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-white/8 pl-5 pr-3">
          {view !== 'main' && (
            <button
              onClick={() => setView('main')}
              disabled={sending}
              className="-ml-2 flex h-8 w-8 items-center justify-center rounded-lg text-krypt-muted transition hover:bg-white/5 hover:text-white disabled:opacity-40"
              aria-label="Back"
              data-testid="wallet-card-back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1 truncate text-note font-semibold text-white">
            {view === 'wallets' ? 'Your wallets' : view === 'send' ? 'Send or withdraw' : shown?.label || 'Your wallet'}
          </div>
          <button
            onClick={close}
            disabled={sending}
            title={sending ? 'A send is in progress' : 'Close'}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-krypt-muted transition hover:bg-white/5 hover:text-white disabled:opacity-40"
            data-testid="wallet-card-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {view === 'main' && (
          <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <div className="text-label text-krypt-muted">Balance on {chainName}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[32px] font-semibold leading-tight tabular-nums text-white" data-testid="wallet-card-balance">
                  {balanceText} <span className="text-[20px] text-krypt-muted">{unit}</span>
                </span>
                <button
                  onClick={() => void refresh()}
                  disabled={refreshing}
                  title="Read the balance from the chain now"
                  aria-label="Refresh balance"
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-krypt-muted transition hover:bg-white/5 hover:text-white disabled:opacity-60"
                  data-testid="wallet-card-refresh"
                >
                  <RefreshCw className={cls('h-4 w-4', refreshing && 'animate-spin')} />
                </button>
              </div>
              <div className="mt-1 min-h-[18px] text-note text-krypt-muted">
                {usd}
                {usd && shown?.checkedAt ? ' · ' : ''}
                {shown?.checkedAt ? `checked ${fmtClock(shown.checkedAt)}` : ''}
              </div>
              {failure && !refreshing && (
                <p className="mt-1.5 text-label leading-relaxed text-amber-300/90" data-testid="wallet-card-failure">
                  Could not read the chain ({failure}). {shown?.balance != null ? 'This is the last balance read.' : ''}
                </p>
              )}
            </div>

            <div className="mb-3">
              <div className="mb-1 text-label text-krypt-muted">Address, to deposit {unit} on {chainName}</div>
              <button
                onClick={copy}
                disabled={!address}
                title="Copy the address"
                className="flex w-full items-center gap-2.5 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-left transition hover:border-white/20"
                data-testid="wallet-card-address"
              >
                <span className="min-w-0 flex-1 break-all font-mono text-note leading-snug text-white">{address ?? '—'}</span>
                {copied ? <Check className="h-4 w-4 flex-shrink-0 text-emerald-300" /> : <Copy className="h-4 w-4 flex-shrink-0 text-krypt-muted" />}
              </button>
            </div>

            <PrimaryButton onClick={() => setView('send')} disabled={!address} className="w-full justify-center" >
              <span className="inline-flex items-center gap-1.5" data-testid="wallet-card-send">
                <ArrowUpRight className="h-4 w-4" /> Send / Withdraw
              </span>
            </PrimaryButton>

            <div className="mt-2.5 flex items-center justify-center gap-4 text-label text-krypt-muted">
              <button
                onClick={() => (evmChain ? leaveTo(evmChain) : openWallets())}
                className="transition hover:text-white"
                data-testid="wallet-card-wallets"
              >
                {evmChain ? 'Manage wallet' : 'Switch or manage wallets'}
              </button>
              {explorer && (
                <button onClick={() => void window.krypt.app.openExternal(explorer)} className="inline-flex items-center gap-1 transition hover:text-white">
                  View activity <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
            <VaultCardLine onClose={onClose} />
          </div>
        )}

        {view === 'send' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {shown?.home && (
              <p className="mb-3 text-label leading-relaxed text-krypt-muted">
                Your saved withdrawal address is filled in. Change it to send anywhere else.
              </p>
            )}
            <SendCard chain={chain} bare className="!border-t-0 !pt-0" initialTo={shown?.home} onSent={() => void refresh()} onBusyChange={setSending} />
          </div>
        )}

        {view === 'wallets' && (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="nav-wallets">
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {wallets.map((w) => (
                <div key={w.id} className="flex items-center gap-1">
                <button
                  onClick={() => (w.active ? setView('main') : void pick(w.id))}
                  className={cls('flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition', w.active ? 'bg-accent/10' : 'hover:bg-white/5')}
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
                  <span className="font-mono text-note tabular-nums text-white/85">{w.balanceSol != null ? w.balanceSol.toFixed(3) : '—'}</span>
                </button>
                <AutoTradeToggle row={vaultStatus?.locked ? undefined : vaultStatus?.wallets.find((v) => v.family === 'solana' && v.id === w.id)} />
                </div>
              ))}
            </div>
            <p className="px-5 pb-2 text-label leading-relaxed text-krypt-muted/80">
              Follows set to “Active wallet” copy with the one ticked. Switching waits until live is off and their open live copies have closed.
            </p>
            <div className="flex gap-1 border-t border-white/8 p-2">
              <button onClick={() => leaveTo('solana')} className="flex-1 rounded-lg px-2.5 py-1.5 text-note text-white/90 transition hover:bg-white/5" data-testid="nav-wallets-manage">
                Add or manage
              </button>
              <button onClick={() => leaveTo('pump')} className="flex-1 rounded-lg px-2.5 py-1.5 text-note text-white/90 transition hover:bg-white/5" data-testid="nav-wallets-pump">
                pump.fun accounts
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
