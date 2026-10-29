// Following (2026-10-22) — every wallet you follow, one card each.
//
// The card shows the three things that matter, side by side: what your
// copies did, what THEY did over the same time (the gap between the two is
// what following costs), and the rules the copy runs by. The two switches
// you use are on the card — Paper/Live and Following/Paused — and every
// other setting is one click away on the Follow page (Edit; 2026-10-24 — it
// was a drawer here).
//
// Unchanged rules: switching to Live disarms the follow, arming it asks
// first, and pausing stops ENTRIES only — open copies are still followed out.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookUser, MoreHorizontal, Pause, Play, Plus, Trash2, UserRound, Users } from 'lucide-react';
import { EVM_CHAIN_META, nativeSymbolOf, type ChainKind, type EvmWalletSummary } from '@shared/evm';
import {
  FOMO_SOURCE_LABEL,
  activeWindowOf,
  chainOf,
  defaultConfig,
  directionOf,
  crowdNoun,
  fmtClock,
  fomoRuleOf,
  isFomo,
  isWatch,
  ownExitsOf,
  winRate,
  type CopyConfig,
} from '@shared/copytrade';
import type { WalletSummary, WatchedWallet } from '@shared/types';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';
import { useNav, type FollowDraft } from '../state/nav';
import { useCopySnapshot } from '../state/useCopy';
import { useAddressBook } from '../state/useAddressBook';
import { CopyLatencyPanel } from '../components/copy/CopyLatencyPanel';
import { AddressChip, Avatar, DASH, Fact, Panel, Segmented, Tag, btn, fmtAmt, fmtHold, fmtPctS, short, toneOf } from '../ui/kit';
import { cls, fmtAgo } from '../utils/format';

type Draft = FollowDraft;
type Filter = 'all' | 'paper' | 'live' | 'paused';

const chainName = (c: ChainKind): string => (c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].name);

export function FollowingPage() {
  const nav = useNav();
  const toast = useToast();
  const modal = useModal();
  const { settings } = useAppState();
  const { snap, set } = useCopySnapshot();
  const [filter, setFilter] = useState<Filter>('all');
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [evmWallets, setEvmWallets] = useState<Record<'robinhood' | 'bnb', EvmWalletSummary[]>>({ robinhood: [], bnb: [] });

  useEffect(() => {
    void Promise.all([
      window.krypt.wallet.list(),
      window.krypt.evm.wallet.list('robinhood').catch(() => null),
      window.krypt.evm.wallet.list('bnb').catch(() => null),
    ]).then(([ws, rh, bnb]) => {
      if (ws.ok && ws.data) setWallets(ws.data);
      setEvmWallets({ robinhood: rh && rh.ok && rh.data ? rh.data : [], bnb: bnb && bnb.ok && bnb.data ? bnb.data : [] });
    });
  }, []);

  const save = useCallback(
    async (c: Draft, quiet = false): Promise<boolean> => {
      const r = await window.krypt.copy.save(c as Partial<CopyConfig>);
      if (r.ok) {
        if (!quiet) toast.success(r.message);
        if (r.data) set(r.data);
        return true;
      }
      toast.error(r.message);
      return false;
    },
    [toast, set],
  );

  const toggle = async (c: CopyConfig): Promise<void> => {
    if (!c.enabled && c.mode === 'live') {
      const sym = nativeSymbolOf(chainOf(c));
      const yes = await modal.confirm({
        title: 'Arm live copying',
        message:
          (isFomo(c)
            ? `Every time ${fomoRuleOf(c).minWallets} of ${crowdNoun(c)} buy the same coin within ${fomoRuleOf(c).windowSec} s, real ${sym} will be spent, `
            : `Every ${directionOf(c) === 'reverse' ? 'sell' : 'buy'} by ${c.label || short(c.wallet)} will spend real ${sym} on ${chainName(chainOf(c))}, `) +
          `up to ${c.maxTradeSol} per trade, until you lose ${c.dailyLossLimitSol} ${sym} in a day. ` +
          (directionOf(c) === 'reverse' ? 'Reverse copying bets the coin keeps going after they leave; nothing has measured that bet. ' : '') +
          'Measured over two periods, copying memecoin wallets loses money on average — run it on paper first if you have not.',
        confirmLabel: 'Arm live copying',
        destructive: true,
      });
      if (!yes) return;
    }
    await save({ ...c, enabled: !c.enabled }, true);
  };

  const setMode = async (c: CopyConfig, mode: 'paper' | 'live'): Promise<void> => {
    if (mode === c.mode) return;
    // A live copy over the per-trade cap is refused every time — say so at
    // the switch, where it can still be fixed.
    const cap = settings.execution.maxLiveSol;
    const most = c.sizing === 'fixed' ? c.sizeValue : c.maxTradeSol;
    let next: CopyConfig = c;
    if (mode === 'live' && chainOf(c) === 'solana' && Number.isFinite(cap) && cap > 0 && most > cap) {
      const fit = await modal.confirm({
        title: 'This follow is above your live cap',
        message:
          c.sizing === 'proportional'
            ? `It copies up to ${most} SOL per trade, and your live max per trade is ${cap} SOL — so its biggest copies would be refused. Cap it at ${cap} SOL instead? It still copies ${c.sizeValue}% of their size below that. (The max itself is on the Wallet page.)`
            : `It copies up to ${most} SOL per trade, and your live max per trade is ${cap} SOL — so every live copy would be refused. Copy at ${cap} SOL instead? (The max itself is on the Wallet page.)`,
        confirmLabel: c.sizing === 'proportional' ? `Cap at ${cap} SOL` : `Use ${cap} SOL per trade`,
      });
      if (!fit) return;
      // A percentage follow stays a percentage — only its cap comes down.
      next = c.sizing === 'proportional' ? { ...c, maxTradeSol: cap } : { ...c, sizing: 'fixed', sizeValue: cap, maxTradeSol: cap };
    }
    // Switching to live always disarms first; arming is its own, confirmed step.
    const ok = await save({ ...next, mode, enabled: mode === 'live' ? false : c.enabled }, true);
    if (ok && mode === 'live') toast.info('Switched to Live, and paused. Press Resume on the card to arm it.');
  };

  const remove = async (c: CopyConfig): Promise<void> => {
    const open = snap?.stats[c.id]?.openAllModes ?? 0;
    const yes = await modal.confirm({
      title: 'Stop following',
      message:
        `Remove ${c.label || short(c.wallet, 5)} and its record?` +
        (open > 0
          ? ` ${open} cop${open === 1 ? 'y is' : 'ies are'} still open: nothing will follow ${open === 1 ? 'it' : 'them'} out any more. A live copy stays in your wallet until you sell it.`
          : ''),
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.remove(c.id);
    if (r.ok && r.data) set(r.data);
  };

  const resetPaper = async (c: CopyConfig): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Clear paper results',
      message: `Start ${c.label || short(c.wallet, 5)}'s paper record over? Settings, live history and their own record stay.`,
      confirmLabel: 'Clear paper results',
    });
    if (!yes) return;
    const r = await window.krypt.copy.resetPaper(c.id);
    r.ok ? toast.success(r.message) : toast.error(r.message);
  };

  const configs = snap?.configs ?? [];
  const shown = useMemo(
    () =>
      configs.filter((c) =>
        filter === 'all' ? true : filter === 'paused' ? !c.enabled : c.mode === filter,
      ),
    [configs, filter],
  );
  const counts = {
    all: configs.length,
    paper: configs.filter((c) => c.mode === 'paper').length,
    live: configs.filter((c) => c.mode === 'live').length,
    paused: configs.filter((c) => !c.enabled).length,
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-12 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-semibold tracking-display text-white">Following</h1>
            <p className="mt-1 max-w-2xl text-[14px] text-krypt-muted">
              Every wallet you copy. Paper first: switch a card to Live only after its paper record earned it.
            </p>
          </div>
          <div className="flex gap-2">
            <button className={btn.secondary} onClick={() => nav.go('book')} data-testid="following-book" title="Your names, tags and notes for wallets — followed or not">
              <BookUser className="h-4 w-4" /> Address book
            </button>
            <AdvancedMenu onNew={(d) => nav.editFollow(d)} defaultChain={'solana'} />
            <button className={btn.primary} onClick={() => nav.follow()} data-testid="following-follow">
              <Plus className="h-4 w-4" /> Follow a wallet
            </button>
          </div>
        </div>

        {snap?.loadFailure && (
          <div className="mt-6 rounded-xl border border-down/30 bg-down/10 px-4 py-3 text-note text-white">
            Your copy-trading file could not be read — nothing was overwritten, and nothing is being saved this session. {snap.loadFailure} Close the app,
            copy that file somewhere safe, and check it before continuing.
          </div>
        )}

        {configs.length > 0 && (
          <div className="mt-6">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={(['all', 'paper', 'live', 'paused'] as Filter[]).map((f) => ({
                value: f,
                label: `${f[0].toUpperCase()}${f.slice(1)}${counts[f] ? ` · ${counts[f]}` : ''}`,
              }))}
            />
          </div>
        )}

        <div className="mt-4 space-y-4">
          {configs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/12 bg-card px-6 py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
                <Users className="h-5 w-5" />
              </div>
              <p className="mt-3 text-[16px] font-semibold text-white">You are not following anyone yet</p>
              <p className="mx-auto mt-1 max-w-md text-note text-krypt-muted">
                Pick a wallet — paste one, or let Discover suggest who is least bad to copy — and follow it on paper. Nothing is spent until you say so.
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <button className={btn.secondary} onClick={() => nav.go('discover')}>
                  Discover wallets
                </button>
                <button className={btn.primary} onClick={() => nav.follow()}>
                  <Plus className="h-4 w-4" /> Follow a wallet
                </button>
              </div>
            </div>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-note text-krypt-muted">No follows match this filter.</p>
          ) : (
            shown.map((c) => (
              <FollowCard
                key={c.id}
                c={c}
                snap={snap!}
                signer={c.walletId ? ((chainOf(c) === 'solana' ? wallets : evmWallets[chainOf(c) as 'robinhood' | 'bnb'])?.find((w) => w.id === c.walletId)?.label ?? 'a wallet that no longer exists') : null}
                onToggle={() => void toggle(c)}
                onMode={(m) => void setMode(c, m)}
                onEdit={() => nav.editFollow(c)}
                onProfile={() => nav.openWallet(c.wallet)}
                onRemove={() => void remove(c)}
                onResetPaper={() => void resetPaper(c)}
              />
            ))
          )}
        </div>

        {snap?.latency && snap.latency.samples > 0 && (
          <div className="mt-8">
            <CopyLatencyPanel l={snap.latency} />
          </div>
        )}

        <Watchlist />
      </div>

    </div>
  );
}

function AdvancedMenu({ onNew, defaultChain }: { onNew: (d: Draft) => void; defaultChain: ChainKind }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className={btn.secondary} onClick={() => setOpen((o) => !o)}>
        More ways to follow
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-white/10 bg-card p-1.5 shadow-pop">
            {[
              { title: 'Watch only', body: 'Never trades. Every buy and sell they make is toasted and sent to your chat bots — watch a wallet for a week before risking paper.', d: () => defaultConfig('', '', defaultChain, 'watch') },
              { title: 'Reverse', body: 'Buy when they SELL, exit on your own take-profit or stop. Unmeasured — paper only to start.', d: () => defaultConfig('', '', defaultChain, 'reverse') },
              { title: 'Convergence', body: 'Buy when several wallets converge on the same coin: your followed or saved wallets, a Discover ranking such as Week total, or wallets you pick. Measured, the crowd arrives late — paper first.', d: () => defaultConfig('', '', 'solana', 'fomo') },
            ].map((x) => (
              <button
                key={x.title}
                onClick={() => (setOpen(false), onNew(x.d()))}
                className="block w-full rounded-lg px-3 py-2.5 text-left transition hover:bg-white/5"
              >
                <div className="text-note font-medium text-white">{x.title}</div>
                <div className="text-body text-krypt-muted">{x.body}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FollowCard({
  c,
  snap,
  signer,
  onToggle,
  onMode,
  onEdit,
  onProfile,
  onRemove,
  onResetPaper,
}: {
  c: CopyConfig;
  snap: NonNullable<ReturnType<typeof useCopySnapshot>['snap']>;
  signer: string | null;
  onToggle: () => void;
  onMode: (m: 'paper' | 'live') => void;
  onEdit: () => void;
  onProfile: () => void;
  onRemove: () => void;
  onResetPaper: () => void;
}) {
  const [menu, setMenu] = useState(false);
  // A follow without its own label shows your address-book name (2026-10-28).
  const named = useAddressBook().nameOf(isFomo(c) ? null : c.wallet);
  const st = snap.stats[c.id];
  const chain = chainOf(c);
  const sym = nativeSymbolOf(chain);
  const dir = directionOf(c);
  const fomo = isFomo(c);
  const watchOnly = isWatch(c);
  const watch = snap.watch[c.wallet];
  const them = fomo ? null : snap.leaders[c.wallet];
  const wr = st ? winRate(st) : null;
  const closed = st ? st.wins + st.losses : 0;
  const exits = ownExitsOf(c);
  const open = st?.openAllModes ?? st?.openCount ?? 0;
  // Real tokens this follow still holds, whatever it is set to now.
  const liveHeld = snap.liveOpen?.[c.id] ?? 0;

  // Paused by the app (2026-10-23): a per-wallet stop or failed copies.
  // Said in full until the user switches it back on.
  const auto = !c.enabled && c.pausedReason ? `Paused by the app ${c.pausedAt ? fmtAgo(c.pausedAt) : ''} — ${c.pausedReason}` : null;
  const status = !c.enabled
    ? auto
      ? `${auto}${open > 0 ? ` · still following ${open} open cop${open === 1 ? 'y' : 'ies'} out` : ''}`
      : open > 0
        ? `Paused — no new copies; still following ${open} open cop${open === 1 ? 'y' : 'ies'} out`
        : 'Paused'
    : fomo
      ? `Listening to ${snap.crowd?.[c.id]?.wallets ?? 0} wallets`
      : watch?.state === 'watching'
        ? `${watchOnly ? 'Alerts only · watching' : 'Watching'}${watch.lastSwapAt ? ` · last trade ${fmtAgo(watch.lastSwapAt)}` : ''}${
            watch.unreadable ? ` · ${watch.unreadable} trade${watch.unreadable === 1 ? '' : 's'} could not be read` : ''
          }${watch.unseenExits ? ` · ${watch.unseenExits} exit${watch.unseenExits === 1 ? '' : 's'} not mirrorable (not a SOL sale)` : ''}`
        : watch?.state === 'over-cap'
          ? 'Not watched — the endpoint refused another subscription'
          : watch?.state === 'off'
            ? `Not watched — the ${chainName(chain)} feed is off`
            : 'Connecting…';

  const win = activeWindowOf(c);
  const rules = watchOnly
    ? ['tells you every buy and sell they make', 'never trades']
    : [
    c.sizing === 'fixed' ? `${c.sizeValue} ${sym} per buy` : `${c.sizeValue}% of their size, up to ${c.maxTradeSol} ${sym}`,
    c.copySells ? (c.minLeaderSellPct ? `mirrors their sells of ${c.minLeaderSellPct}%+ of their bag` : 'mirrors their sells') : 'does not mirror sells',
    exits.takeProfitPct !== null ? `take-profit +${exits.takeProfitPct}%` : null,
    exits.stopLossPct !== null ? `stop −${exits.stopLossPct}%` : null,
    exits.trailingPct !== null ? `trailing −${exits.trailingPct}%` : null,
    exits.maxHoldMin !== null ? `max hold ${exits.maxHoldMin} min` : null,
    c.exitOnCreatorSellPct != null ? `sells if the creator sells ${c.exitOnCreatorSellPct > 0 ? `${c.exitOnCreatorSellPct}%+` : 'any'} of their bag` : null,
    c.exitOnMigration ? 'sells on graduation to PumpSwap' : null,
    c.copySells && c.copyOtherExits ? 'follows them out on a move, swap or stable sale' : null,
    c.onePositionPerCoin ? 'one position per coin across follows' : null,
    c.ai && (c.ai.entries || c.ai.exits) ? `your AI decides ${c.ai.entries && c.ai.exits ? 'buys and sells' : c.ai.entries ? 'buys' : 'sells'}` : null,
    win ? `copies ${fmtClock(win.fromMin)}–${fmtClock(win.toMin)} only` : null,
    `stops after −${c.dailyLossLimitSol} ${sym} a day`,
    c.walletLossStopSol ? `pauses after −${c.walletLossStopSol} ${sym} in all` : null,
    c.delayMs > 0 ? `${(c.delayMs / 1000).toFixed(1)} s delay` : null,
    c.minLiquidityUsd !== null ? `liquidity ≥ $${c.minLiquidityUsd.toLocaleString()}` : null,
  ].filter(Boolean);

  return (
    <div className="rounded-xl border border-white/8 bg-card shadow-soft" data-testid="follow-card">
      <div className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] px-5 py-4">
        <button onClick={fomo ? onEdit : onProfile} className="shrink-0" title={fomo ? 'Edit' : 'Open their profile'}>
          {fomo ? (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
              <Users className="h-5 w-5" />
            </div>
          ) : (
            <Avatar address={c.wallet} size={48} label={c.label || named || undefined} />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[16px] font-semibold text-white">{c.label || named || (fomo ? FOMO_SOURCE_LABEL[fomoRuleOf(c).source] : short(c.wallet, 5))}</span>
            <Tag tone={c.mode === 'live' ? 'down' : 'neutral'}>{c.mode}</Tag>
            {dir !== 'copy' && <Tag tone={watchOnly ? 'neutral' : 'warn'}>{watchOnly ? 'watch only' : dir === 'fomo' ? 'convergence' : dir}</Tag>}
            {chain !== 'solana' && <Tag>{chainName(chain)}</Tag>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-krypt-muted">
            {!fomo && <AddressChip address={c.wallet} />}
            <span className="flex items-center gap-1.5">
              <span className={cls('h-2 w-2 rounded-full', c.enabled ? (watch?.state === 'watching' || fomo ? 'bg-up' : 'bg-warn') : auto ? 'bg-warn' : 'bg-white/30')} />
              <span className={auto ? 'text-warn' : undefined} data-testid={auto ? 'follow-autopaused' : undefined}>
                {status}
              </span>
            </span>
            {signer && <span>signs with {signer}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!watchOnly && <Segmented size="sm" value={c.mode} onChange={onMode} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} />}
          <button
            onClick={onToggle}
            data-testid="follow-toggle"
            className={cls(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-body font-semibold transition',
              c.enabled ? 'border-up/40 bg-up/10 text-up' : 'border-white/10 bg-raised text-white hover:border-white/20',
            )}
          >
            {c.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {c.enabled ? 'Pause' : c.mode === 'live' ? 'Arm' : 'Resume'}
          </button>
          <button onClick={onEdit} className={btn.secondary + ' !py-1.5'}>
            Edit
          </button>
          <div className="relative">
            <button onClick={() => setMenu((m) => !m)} className={cls(btn.ghost, '!px-2')} aria-label="More">
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                <div className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-white/10 bg-card p-1.5 shadow-pop">
                  {!fomo && (
                    <button onClick={() => (setMenu(false), onProfile())} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-note text-white hover:bg-white/5">
                      <UserRound className="h-4 w-4" /> Their profile
                    </button>
                  )}
                  <button onClick={() => (setMenu(false), onResetPaper())} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-note text-white hover:bg-white/5">
                    Clear paper results
                  </button>
                  <button onClick={() => (setMenu(false), onRemove())} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-note text-down hover:bg-down/10">
                    <Trash2 className="h-4 w-4" /> Stop following
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 px-5 py-4 md:grid-cols-[1.2fr_1.2fr_1fr]">
        <div>
          <div className="mb-2 text-body font-medium text-krypt-muted">{watchOnly ? 'Alerts' : `Your copies · ${c.mode}`}</div>
          {watchOnly ? (
            <p className="text-body text-krypt-muted">Nothing is bought. Each buy and sell is toasted and sent to your chat bots; their record builds on the right.</p>
          ) : (
          <div className="grid grid-cols-3 gap-4">
            <Fact
              label="Result"
              value={closed ? fmtAmt(st.realizedPnlSol, { signed: true }) : DASH}
              tone={toneOf(closed ? st.realizedPnlSol : null)}
              hint={(st?.unpriced ?? 0) > 0 ? `${st.unpriced} live exit(s) still waiting for their fill` : undefined}
            />
            <Fact label={`Won${closed ? ` (of ${closed})` : ''}`} value={wr === null ? DASH : `${Math.round(wr)}%`} />
            <Fact label="Open" value={String(st?.openCount ?? 0)} />
            <Fact label="Copies" value={String(st?.trades ?? 0)} />
            <Fact label="Skipped" value={String((st?.skipped ?? 0) + (st?.blocked ?? 0))} hint="Refused by your filters or limits — see Activity for why" />
            {(st?.unpriced ?? 0) > 0 && <Fact label="Awaiting fill" value={String(st.unpriced)} tone="text-warn" />}
          </div>
          )}
        </div>
        <div>
          <div className="mb-2 text-body font-medium text-krypt-muted">{fomo ? 'The crowd' : 'Their record since you followed'}</div>
          {them && them.buys + them.sells > 0 ? (
            <div className="grid grid-cols-3 gap-4">
              <Fact label="Their profit" value={fmtAmt(them.realizedPnlSol, { signed: true })} tone={toneOf(them.realizedPnlSol)} />
              <Fact label="Trades" value={String(them.roundTrips)} />
              <Fact label="Won" value={them.roundTrips ? `${Math.round((them.wins / them.roundTrips) * 100)}%` : DASH} />
              <Fact label="Typical hold" value={fmtHold(them.medianHoldMs)} tone={them.medianHoldMs !== null && them.medianHoldMs < 60_000 ? 'text-warn' : undefined} />
              <Fact label="Too fast to copy" value={fmtPctS(them.tooFastPct, { digits: 0 })} tone={them.tooFastPct !== null && them.tooFastPct >= 50 ? 'text-warn' : undefined} />
              <Fact label="Holding now" value={String(them.openCount)} />
            </div>
          ) : (
            <p className="text-body text-krypt-muted">{fomo ? `Enters when ${fomoRuleOf(c).minWallets} of them buy the same coin within ${fomoRuleOf(c).windowSec} s.` : 'No trades seen since you followed them.'}</p>
          )}
        </div>
        <div>
          <div className="mb-2 text-body font-medium text-krypt-muted">Rules</div>
          <ul className="space-y-1 text-body text-white">
            {rules.map((r) => (
              <li key={r as string}>{r}</li>
            ))}
          </ul>
        </div>
      </div>

      {chain === 'solana' && liveHeld > 0 && snap.exitBlockedReason && (
        <p className="border-t border-white/[0.06] px-5 py-3 text-body text-warn" data-testid="follow-exits-blocked">
          {`Exits are not selling: ${snap.exitBlockedReason}. ${liveHeld} live cop${liveHeld === 1 ? 'y is' : 'ies are'} open, and ${liveHeld === 1 ? 'its' : 'their'} stop-loss and exits wait until Live is back on. Sell from the Wallet page if you want out now.`}
        </p>
      )}
      {open > 0 && (
        <p className="border-t border-white/[0.06] px-5 py-3 text-body text-krypt-muted">
          {c.mode === 'live'
            ? `${st.openCount} open cop${st.openCount === 1 ? 'y is' : 'ies are'} ordinary holdings in your wallet — sell from the Wallet page any time. They also close when this wallet sells, or when an exit rule fires.`
            : `${st?.openCount ?? open} open cop${(st?.openCount ?? open) === 1 ? 'y is' : 'ies are'} simulated — nothing was bought. They close when this wallet sells, or when an exit rule fires.`}
        </p>
      )}
    </div>
  );
}

/** Labelled wallets: a FOMO crowd can listen to them, and tracking alone never trades. */
function Watchlist() {
  const toast = useToast();
  const [list, setList] = useState<WatchedWallet[]>([]);
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    const r = await window.krypt.watchlist.get();
    if (r.ok && r.data) setList(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const add = async (): Promise<void> => {
    const r = await window.krypt.watchlist.add(addr.trim(), label.trim());
    if (r.ok) {
      setAddr('');
      setLabel('');
      void load();
    } else toast.error(r.message);
  };
  return (
    <Panel
      className="mt-8"
      title={`Watchlist${list.length ? ` · ${list.length}` : ''}`}
      subtitle="Labelled wallets a convergence follow can listen to. Watching alone never trades."
      action={
        <button className={btn.ghost} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      }
      bodyClass={open ? undefined : '!pb-4 !pt-0'}
    >
      {open && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Wallet address" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-raised px-3 py-2 font-mono text-note text-white outline-none focus:border-accent/60" />
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" maxLength={32} className="w-44 rounded-lg border border-white/10 bg-raised px-3 py-2 text-note text-white outline-none focus:border-accent/60" />
            <button className={btn.secondary} disabled={addr.trim().length < 32} onClick={() => void add()}>
              Add
            </button>
          </div>
          {list.map((w) => (
            <div key={w.address} className="flex items-center gap-3">
              <Avatar address={w.address} size={28} label={w.label} />
              <span className="text-note text-white">{w.label}</span>
              <AddressChip address={w.address} />
              <button
                className={cls(btn.ghost, 'ml-auto !px-2')}
                onClick={() => void window.krypt.watchlist.remove(w.address).then(() => load())}
                aria-label="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
