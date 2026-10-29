// Check (2026-10-25) — what would copying this wallet have done?
//
// The user: "wheres the wallet scan to input a wallet address to check how
// copying would look like for it, individual wallet checker. also should
// work with pumpfun usernames". It existed, but in two corners: a search box
// at the top right of Discover opened a profile, and the replay sat low on
// that profile behind its own button. Now it is a place on the bar.
//
// Paste an address, a pump.fun username or a profile link; the replay starts
// at once (from the chain through the Helius key in seconds, pump.fun's
// history as the fallback) and is sized the way a follow would be — a fixed
// amount, or a share of their trade with a cap. Follow from here opens the
// Follow page with that sizing already chosen.

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Plus, ScanSearch, UserRound, X } from 'lucide-react';
import { FOLLOW_PCTS, followConfig, type SizingMode } from '@shared/copytrade';
import { REPLAY_MAX_TRIPS, REPLAY_WEEK_CREDITS_MAX, REPLAY_WEEK_MAX_TRIPS, type ReplaySpan } from '@shared/copyReplay';
import type { ScoutWallet } from '@shared/walletScout';
import type { PumpUser } from '@shared/pumpLookup';
import { BOARD_SIZES, useBoardSize } from '../state/boardSize';
import { useNav } from '../state/nav';
import { useAddressBook } from '../state/useAddressBook';
import { BookEditor, BookLine } from '../components/copy/BookEditor';
import { ReplayPanel } from '../components/copy/ReplayPanel';
import { resolveWalletInput, type ResolvedWallet } from '../utils/walletInput';
import { AddressChip, Avatar, DASH, Fact, Panel, Segmented, Tag, btn, fmtAmt, fmtHold, short, toneOf } from '../ui/kit';
import { cls, fmtAgo } from '../utils/format';

const RECENT_KEY = 'kc.check.recent';
const CAPS = [0.1, 0.25, 0.5, 1] as const;

interface Recent {
  address: string;
  name: string | null;
}

function readRecent(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.address === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: Recent[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* a remembered list is a nicety */
  }
}

export function CheckPage() {
  const nav = useNav();
  const [input, setInput] = useState(nav.checkInput ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wallet, setWallet] = useState<ResolvedWallet | null>(null);
  const [pump, setPump] = useState<PumpUser | null>(null);
  const [record, setRecord] = useState<ScoutWallet | null>(null);
  const [followed, setFollowed] = useState<string[]>([]);
  const [recent, setRecent] = useState<Recent[]>(readRecent);
  const [size, setSize] = useBoardSize();
  const [sizing, setSizing] = useState<SizingMode>('fixed');
  const [pct, setPct] = useState<number>(FOLLOW_PCTS[1]);
  const [cap, setCap] = useState<number>(CAPS[0]);
  // The newest thirty trades, or the whole week (2026-10-28).
  const [span, setSpan] = useState<ReplaySpan>('newest');

  const check = async (raw: string): Promise<void> => {
    if (!raw.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await resolveWalletInput(raw);
      if (!r.ok) {
        setWallet(null);
        return void setError(r.message);
      }
      setWallet(r.wallet);
      setPump(r.wallet.pump);
      setInput(r.wallet.pump ? `@${r.wallet.pump.username}` : r.wallet.address);
      const next = [{ address: r.wallet.address, name: r.wallet.pump ? `@${r.wallet.pump.username}` : null }, ...readRecent().filter((x) => x.address !== r.wallet.address)];
      writeRecent(next);
      setRecent(next.slice(0, 8));
    } finally {
      setBusy(false);
    }
  };

  // Opened with a wallet (Check from the Follow page, a link): check it.
  useEffect(() => {
    if (nav.checkInput) void check(nav.checkInput);
    void window.krypt.copy.list().then((r) => r.ok && r.data && setFollowed(r.data.configs.map((c) => c.wallet.toLowerCase())));
    // Once, on open: the page is keyed on its input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pasted address may still be someone's pump.fun account, and the Scout
  // may have watched them trade.
  const address = wallet?.address ?? null;
  const chain = wallet?.chain === 'evm' ? null : 'solana';
  useEffect(() => {
    setRecord(null);
    if (!address || !chain) return;
    let alive = true;
    void window.krypt.scout.detail('solana', address).then((r) => alive && r.ok && r.data && setRecord(r.data.wallet));
    if (!wallet?.pump) void window.krypt.scout.pumpUser(address).then((r) => alive && r.ok && r.data && r.data.isPumpUser && setPump(r.data));
    return () => {
      alive = false;
    };
  }, [address, chain, wallet?.pump]);

  const week = useMemo(() => {
    if (!record) return null;
    const days = record.days.slice(0, 7);
    const buys = days.reduce((n, d) => n + d.buys, 0);
    const volume = days.reduce((n, d) => n + d.volume, 0);
    return {
      buys,
      trips: days.reduce((n, d) => n + d.roundTrips, 0),
      pnl: days.reduce((n, d) => n + d.pnl, 0),
      avgBuy: buys > 0 ? volume / buys : null,
      hold: record.medianHoldMs,
      lastSeen: record.lastSeen,
    };
  }, [record]);

  const replaySizing = useMemo(() => (sizing === 'proportional' ? { share: pct, cap } : null), [sizing, pct, cap]);
  // Your name for them first (2026-10-28), then their pump.fun username.
  const book = useAddressBook();
  const named = book.nameOf(address);
  const name = named || (pump ? `@${pump.username}` : '');
  const isFollowed = !!address && followed.includes(address.toLowerCase());
  const follow = (): void => {
    if (!address) return;
    // The Follow page opens on the sizing chosen here.
    nav.editFollow(followConfig(address, name, 'solana', sizing, sizing === 'fixed' ? size : pct, cap));
  };

  return (
    <div className="h-full overflow-auto" data-testid="check-page">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-16 pt-8">
        <h1 className="text-[26px] font-semibold tracking-display text-white">Check a wallet</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-krypt-muted">
          What copying a wallet would have done — any Solana wallet, even one this app never watched. Paste an address, or type a pump.fun username.
        </p>

        <form
          className="mt-5 flex max-w-3xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void check(input);
          }}
        >
          <div className="relative flex-1">
            <ScanSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-krypt-muted" />
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Wallet address, pump.fun username, or pump.fun profile link"
              spellCheck={false}
              data-testid="check-input"
              className="w-full rounded-xl border border-white/10 bg-raised py-3 pl-10 pr-10 font-mono text-note text-white outline-none focus:border-accent/60"
            />
            {input && (
              <button type="button" onClick={() => (setInput(''), setError(''))} className="absolute right-3 top-1/2 -translate-y-1/2 text-krypt-muted hover:text-white" aria-label="Clear">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <button type="submit" disabled={busy || !input.trim()} className={cls(btn.primary, 'px-5')} data-testid="check-go">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />} Check
          </button>
        </form>
        {error && <p className="mt-2 text-body text-warn">{error}</p>}
        {recent.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-body text-krypt-muted">Recent</span>
            {recent.map((r) => (
              <button
                key={r.address}
                onClick={() => void check(r.address)}
                className={cls(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body transition',
                  r.address === address ? 'border-accent/50 bg-accent/10 text-white' : 'border-white/10 text-krypt-muted hover:border-white/20 hover:text-white',
                )}
              >
                <Avatar address={r.address} size={16} />
                {r.name ?? short(r.address, 4)}
              </button>
            ))}
          </div>
        )}

        {!wallet ? (
          <Panel className="mt-6" title="How the check works">
            <ul className="space-y-2 text-note leading-relaxed text-krypt-muted">
              <li>
                It reads their recent swaps from the chain, pairs them into finished trades, and prices a copy of each one landing 2 s after their buy and 2 s after
                their sell — the price a follower would really have met, with every fee.
              </li>
              <li>
                With a Helius key in Settings that takes seconds and about 300 credits from the backtest allowance; without one it uses pump.fun&rsquo;s trade
                history, which is free but takes minutes.
              </li>
              <li>
                <span className="text-white">Whole week</span> replays every trade they opened in the last 7 days (up to {REPLAY_WEEK_MAX_TRIPS}) and shows the week total, the mean
                without the best five copies, and each day — the way the two week-positive wallets of 10-27 were found. With a key it costs at most{' '}
                {REPLAY_WEEK_CREDITS_MAX.toLocaleString()} credits, usually half that.
              </li>
              <li>Size it like a follow — a fixed amount, or a share of each of their trades — and follow from here on paper if it holds up. It trades nothing.</li>
            </ul>
          </Panel>
        ) : (
          <>
            <section className="mt-6 rounded-xl border border-white/8 bg-card p-5 shadow-soft" data-testid="check-wallet">
              <div className="flex flex-wrap items-center gap-4">
                <Avatar address={wallet.address} size={48} label={named || pump?.username} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[18px] font-semibold text-white">{name || short(wallet.address, 6)}</span>
                    {pump?.verified && <Tag tone="accent">verified</Tag>}
                    {pump?.banned && <Tag tone="down">banned on pump.fun</Tag>}
                    {isFollowed && <Tag tone="up">you follow them</Tag>}
                    {named && pump && <span className="text-body text-krypt-muted">@{pump.username} on pump.fun</span>}
                  </div>
                  <BookLine address={wallet.address} className="mt-1" />
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-krypt-muted">
                    <AddressChip address={wallet.address} n={6} />
                    {pump && pump.followers !== null && <span>{pump.followers.toLocaleString()} followers on pump.fun</span>}
                    {pump?.xUsername && <span>X @{pump.xUsername}</span>}
                    {week && <span>last traded {fmtAgo(week.lastSeen)}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <BookEditor address={wallet.address} suggest={pump ? `@${pump.username}` : ''} />
                  <button className={btn.secondary} onClick={() => nav.openWallet(wallet.address)} data-testid="check-profile">
                    <UserRound className="h-4 w-4" /> Full profile
                  </button>
                  {pump && (
                    <a className={btn.ghost} href={`https://pump.fun/profile/${encodeURIComponent(pump.username)}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" /> pump.fun
                    </a>
                  )}
                  {chain && !isFollowed && (
                    <button className={btn.primary} onClick={follow} data-testid="check-follow">
                      <Plus className="h-4 w-4" /> Follow on paper
                    </button>
                  )}
                </div>
              </div>
              {week && (week.buys > 0 || week.trips > 0) && (
                <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/[0.06] pt-4 sm:grid-cols-5">
                  <Fact label="Their average buy" value={week.avgBuy !== null ? `${fmtAmt(week.avgBuy)} SOL` : DASH} />
                  <Fact label="Buys this week" value={week.buys.toLocaleString()} />
                  <Fact label="Finished trades" value={week.trips.toLocaleString()} />
                  <Fact label="They made this week" value={`${fmtAmt(week.pnl, { signed: true })} SOL`} tone={toneOf(week.pnl)} hint="Their own result, from what the Scout watched — not a copier's." />
                  <Fact label="Median hold" value={fmtHold(week.hold)} tone={week.hold !== null && week.hold < 60_000 ? 'text-warn' : undefined} />
                </div>
              )}
            </section>

            {chain ? (
              <>
                <div className="mt-6 flex flex-wrap items-center gap-3" data-testid="check-span">
                  <span className="text-note font-medium text-white">Replay</span>
                  <Segmented<ReplaySpan>
                    size="sm"
                    value={span}
                    onChange={setSpan}
                    options={[
                      { value: 'newest', label: `Newest ${REPLAY_MAX_TRIPS} trades` },
                      { value: 'week', label: 'Whole week' },
                    ]}
                  />
                  <span className="text-body text-krypt-muted">
                    {span === 'week'
                      ? `Every trade of the last 7 days, up to ${REPLAY_WEEK_MAX_TRIPS} · at most ${REPLAY_WEEK_CREDITS_MAX.toLocaleString()} Helius credits`
                      : 'How they trade now · about 300 credits'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="check-sizing">
                  <span className="text-note font-medium text-white">Copy size</span>
                  <Segmented<SizingMode>
                    size="sm"
                    value={sizing}
                    onChange={setSizing}
                    options={[
                      { value: 'fixed', label: 'Fixed amount' },
                      { value: 'proportional', label: '% of their trade' },
                    ]}
                  />
                  {sizing === 'fixed' ? (
                    <Segmented<number> size="sm" value={size} onChange={setSize} options={BOARD_SIZES.map((s) => ({ value: s, label: `${s} SOL` }))} />
                  ) : (
                    <>
                      <Segmented<number> size="sm" value={pct} onChange={setPct} options={FOLLOW_PCTS.map((p) => ({ value: p, label: `${p}%` }))} />
                      <span className="text-body text-krypt-muted">up to</span>
                      <Segmented<number> size="sm" value={cap} onChange={setCap} options={CAPS.map((c) => ({ value: c, label: `${c} SOL` }))} />
                    </>
                  )}
                </div>
                <ReplayPanel key={`${wallet.address}:${span}`} address={wallet.address} size={size} sizing={replaySizing} span={span} autoStart className="mt-4" />
              </>
            ) : (
              <Panel className="mt-6" title="Replays read Solana only">
                <p className="text-note text-krypt-muted">
                  This is an EVM wallet. The replay prices Solana trades only; open the full profile for what the Scout recorded of them on Robinhood Chain or BNB.
                </p>
              </Panel>
            )}
          </>
        )}
      </div>
    </div>
  );
}
