// Home (2026-10-22) — where Krypto Mirror opens.
//
// One screen that answers "how is following going?": the result on paper and
// live, what the followed wallets just did and what the copies did about it,
// who you follow, and who Discover ranks best to copy next. Until the basics
// are done, a setup checklist sits on top and says what is next.
//
// Paper and live are never added together: they are different experiments.

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Compass, Eraser, Gauge, Play, Plus, X } from 'lucide-react';
import { winRate, type CopyConfig, type CopyMode } from '@shared/copytrade';
import { GUIDE_VIDEOS, QUICKSTART_VIDEO, fmtVideoDuration, isReady } from '@shared/guides/videos';
import { shortlistVerdict, type ScoutRow, type ShortlistVerdict } from '@shared/walletScout';
import { useAppState } from '../state/AppStateProvider';
import { useBoardSize } from '../state/boardSize';
import { useCopySnapshot } from '../state/useCopy';
import { useNav } from '../state/nav';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';
import { CopyRow } from '../components/copy/CopyRow';
import {
  Avatar,
  CheckStep,
  DASH,
  DayStrip,
  LineChart,
  Panel,
  ScoreRing,
  Segmented,
  StatTile,
  Tag,
  btn,
  fmtAmt,
  fmtHold,
  fmtPctS,
  short,
  toneOf,
} from '../ui/kit';
import { cls } from '../utils/format';

const HIDE_SETUP = 'kcopy.hideSetup';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function HomePage() {
  const nav = useNav();
  const { settings } = useAppState();
  const { snap, set } = useCopySnapshot();
  const modal = useModal();
  const toast = useToast();
  const [walletCount, setWalletCount] = useState<number | null>(null);
  const [pumpAccounts, setPumpAccounts] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<ScoutRow[] | null>(null);
  const [verdict, setVerdict] = useState<ShortlistVerdict | null>(null);
  const [boardSize] = useBoardSize();
  const [mode, setMode] = useState<CopyMode>('paper');
  const [hideSetup, setHideSetup] = useState(() => {
    try {
      return localStorage.getItem(HIDE_SETUP) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    void window.krypt.wallet.list().then((r) => setWalletCount(r.ok && r.data ? r.data.length : 0));
    void window.krypt.pump.status().then((r) => setPumpAccounts(r.ok && r.data ? r.data.sessions.length : 0));
    // The same rule as "Best to copy" (shortlist), at the board's size.
    void window.krypt.scout.top('solana', 'week', 'fLowerPct', 200, boardSize).then((r) => {
      const v = r.ok && r.data ? shortlistVerdict(r.data.rows, 4) : null;
      setVerdict(v);
      setSuggest(v ? v.rows : []);
    });
  }, [boardSize]);

  const configs = snap?.configs ?? [];
  const byId = useMemo(() => new Map(configs.map((c) => [c.id, c])), [configs]);
  const followedSet = useMemo(() => new Set(configs.map((c) => c.wallet)), [configs]);

  // Totals per mode, from each config's stats in that mode.
  const totals = useMemo(() => {
    const out = { paper: { pnl: 0, closed: 0, wins: 0, open: 0, unpriced: 0 }, live: { pnl: 0, closed: 0, wins: 0, open: 0, unpriced: 0 } };
    for (const s of Object.values(snap?.stats ?? {})) {
      const t = out[s.mode];
      t.pnl += s.realizedPnlSol;
      t.closed += s.wins + s.losses;
      t.wins += s.wins;
      t.open += s.openCount;
      t.unpriced += s.unpriced ?? 0;
    }
    return out;
  }, [snap]);

  const series = useMemo(() => {
    const days = snap?.pnlByDay?.[mode] ?? [];
    let run = 0;
    const pts = days.map((d) => ({ t: d.day * 86_400_000, v: (run += d.pnl) }));
    // A flat start so one day still draws a line from zero.
    if (pts.length === 1) pts.unshift({ t: pts[0].t - 86_400_000, v: 0 });
    return { pts, days: days.slice(-30) };
  }, [snap, mode]);

  const paperHasData = totals.paper.closed > 0 || totals.paper.open > 0 || totals.paper.unpriced > 0;
  // Reset the paper record behind the dashboard: every follow's paper copies —
  // the result, the chart, the day-by-day. Live is never touched, and each
  // follow keeps its own reset on the Following page. resetPaper() with no id
  // clears them all and hands back the fresh snapshot, which redraws the dash
  // at once (a push would too).
  const resetPaperResults = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Reset paper results',
      message:
        'Clear every follow’s paper copies — the result, the chart and the day-by-day — and start the paper record over?\n\n' +
        'Kept: live results, your follows and their settings. Each follow’s own paper record also has a reset on the Following page.',
      confirmLabel: 'Reset paper results',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.resetPaper();
    if (r.ok) {
      if (r.data) set(r.data);
      toast.success(r.message);
    } else toast.error(r.message);
  };

  const anyCopy = (snap?.recent ?? []).some((t) => t.state !== 'skipped');
  const liveFollows = configs.filter((c) => c.mode === 'live');
  const steps = [
    { done: configs.length > 0, title: 'Follow your first wallet', body: 'It starts on paper: nothing is bought, every cost is charged, so the record is honest.', action: <button className={btn.primary} onClick={() => nav.follow()}>Follow a wallet</button> },
    { done: anyCopy, title: 'See your first copy', body: 'Happens the next time a wallet you follow trades. It will show up right here.', action: null },
    { done: !!settings.rpc.heliusApiKey?.trim(), title: 'Add a free Helius key (recommended)', body: 'The biggest speed upgrade: trades are heard sooner and copies land faster. Free at helius.dev.', action: <button className={btn.secondary} onClick={() => nav.go('settings')}>Settings</button> },
    { done: (walletCount ?? 0) > 0, title: 'Create a wallet for live copies', body: 'Only needed to go live. The key is encrypted on this computer and never leaves it.', action: <button className={btn.secondary} onClick={() => nav.go('wallet')}>Wallet</button> },
    { done: (pumpAccounts ?? 0) > 0, title: 'Make a pump.fun account (optional)', body: 'Live copies then call out what they buy on pump.fun, and pump pays callers USDC rewards. Wallet › pump.fun.', action: <button className={btn.secondary} onClick={() => nav.go('wallet', { walletTab: 'pump' })}>pump.fun</button> },
    { done: liveFollows.length > 0, title: 'Go live — only when the paper record earns it', body: 'Switch a follow to Live on its card. It asks before arming, and it is capped per trade and per day.', action: null },
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  const coreDone = steps[0].done && steps[1].done;
  // The recorded quickstart (Settings › Guides), offered beside the checklist.
  const quickstart = GUIDE_VIDEOS.find((v) => v.id === QUICKSTART_VIDEO && isReady(v)) ?? null;
  // Hideable once the two steps that matter are done; gone by itself when
  // every step is.
  const showSetup = !hideSetup && firstOpen !== -1;

  const paperCount = configs.filter((c) => c.mode === 'paper').length;
  const summary =
    configs.length === 0
      ? 'You are not following anyone yet. Pick a wallet, follow it on paper, and watch what copying it would really do.'
      : `Following ${configs.length} wallet${configs.length === 1 ? '' : 's'} — ${paperCount} on paper${liveFollows.length ? `, ${liveFollows.length} live` : ''}.`;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-12 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-display text-white">{greeting()}</h1>
            <p className="mt-1 text-[14px] text-krypt-muted">{summary}</p>
          </div>
          <div className="flex gap-2">
            <button className={btn.secondary} onClick={() => nav.go('discover')}>
              <Compass className="h-4 w-4" /> Discover wallets
            </button>
            <button className={btn.primary} onClick={() => nav.follow()} data-testid="home-follow">
              <Plus className="h-4 w-4" /> Follow a wallet
            </button>
          </div>
        </div>

        {showSetup && (
          <Panel
            className="mt-6"
            title="Getting started"
            subtitle={`${steps.filter((s) => s.done).length} of ${steps.length} done`}
            action={
              coreDone ? (
                <button
                  className={btn.ghost}
                  onClick={() => {
                    setHideSetup(true);
                    try {
                      localStorage.setItem(HIDE_SETUP, '1');
                    } catch {
                      /* hidden for this session */
                    }
                  }}
                  title="Hide the checklist"
                >
                  <X className="h-4 w-4" /> Hide
                </button>
              ) : undefined
            }
          >
            <div className="grid gap-0.5 md:grid-cols-2" data-testid="home-setup">
              {steps.map((s, i) => (
                <CheckStep key={s.title} done={s.done} current={i === firstOpen} title={s.title} body={s.body} action={i === firstOpen ? s.action : undefined} />
              ))}
            </div>
            {quickstart && (
              <button
                onClick={() => nav.go('settings', { settingsTab: 'guides', guide: quickstart.id })}
                className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-note font-medium text-accent transition hover:bg-white/5 hover:text-white"
                data-testid="home-quickstart"
              >
                <Play className="h-4 w-4" /> Watch the quickstart ({fmtVideoDuration(quickstart.durationSec)})
              </button>
            )}
          </Panel>
        )}

        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            label="Paper result"
            value={totals.paper.closed ? fmtAmt(totals.paper.pnl, { signed: true, unit: 'SOL' }) : DASH}
            tone={toneOf(totals.paper.closed ? totals.paper.pnl : null)}
            sub={totals.paper.closed ? `${totals.paper.closed} closed · ${Math.round((totals.paper.wins / totals.paper.closed) * 100)}% won` : 'Nothing closed yet'}
            onClick={() => nav.go('activity')}
            testId="home-paper"
          />
          <StatTile
            label="Live result"
            value={totals.live.closed ? fmtAmt(totals.live.pnl, { signed: true, unit: 'SOL' }) : DASH}
            tone={toneOf(totals.live.closed ? totals.live.pnl : null)}
            sub={
              totals.live.closed
                ? `${totals.live.closed} closed${totals.live.unpriced ? ` · ${totals.live.unpriced} awaiting fill` : ''}`
                : liveFollows.length
                  ? 'Nothing closed yet'
                  : 'No live follows'
            }
            onClick={() => nav.go('activity')}
          />
          <StatTile label="Open copies" value={String(totals.paper.open + totals.live.open)} sub={`${totals.paper.open} paper · ${totals.live.open} live`} onClick={() => nav.go('activity', { activityTab: 'positions' })} />
          <StatTile
            label="Following"
            value={String(configs.length)}
            sub={`${configs.filter((c) => c.enabled).length} taking new copies`}
            onClick={() => nav.go('following')}
          />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Panel
              title="Results"
              subtitle="Realised, after every fee — closed copies only, by the day they closed."
              action={
                <div className="flex items-center gap-2">
                  {mode === 'paper' && paperHasData && (
                    <button
                      onClick={() => void resetPaperResults()}
                      title="Clear every follow’s paper results"
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-label font-semibold text-krypt-muted transition hover:bg-white/10 hover:text-white"
                    >
                      <Eraser className="h-3.5 w-3.5" /> Reset
                    </button>
                  )}
                  <Segmented
                    size="sm"
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: 'paper', label: 'Paper' },
                      { value: 'live', label: 'Live' },
                    ]}
                  />
                </div>
              }
            >
              <LineChart points={series.pts} height={190} empty={mode === 'paper' ? 'Your paper results draw here once a copy closes.' : 'Live results draw here once a live copy closes.'} />
              {series.days.length > 1 && (
                <div className="mt-4">
                  <div className="mb-1.5 text-body text-krypt-muted">Day by day</div>
                  <DayStrip days={series.days} />
                </div>
              )}
            </Panel>

            <Panel
              title="Recent activity"
              subtitle="What the wallets you follow did, and what the copies did about it."
              action={
                <button className={btn.ghost} onClick={() => nav.go('activity')}>
                  All activity <ArrowRight className="h-4 w-4" />
                </button>
              }
            >
              {(snap?.recent ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-note text-krypt-muted">
                  {configs.length ? 'Waiting for the wallets you follow to trade.' : 'Follow a wallet and its copies appear here.'}
                </p>
              ) : (
                <div className="-mx-2">
                  {(snap?.recent ?? []).slice(0, 10).map((t) => (
                    <CopyRow key={t.id} t={t} config={byId.get(t.configId)} compact />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel
              title="Your follows"
              action={
                <button className={btn.ghost} onClick={() => nav.go('following')}>
                  Manage
                </button>
              }
            >
              {configs.length === 0 ? (
                <div className="py-2 text-center">
                  <p className="text-note text-krypt-muted">Nobody yet.</p>
                  <button className={cls(btn.primary, 'mt-3')} onClick={() => nav.follow()}>
                    <Plus className="h-4 w-4" /> Follow a wallet
                  </button>
                </div>
              ) : (
                <div className="-mx-2 space-y-0.5">
                  {configs.slice(0, 6).map((c) => (
                    <FollowLine key={c.id} c={c} snap={snap} onOpen={() => nav.openWallet(c.wallet)} />
                  ))}
                  {configs.length > 6 && (
                    <button className={cls(btn.ghost, 'w-full')} onClick={() => nav.go('following')}>
                      {configs.length - 6} more
                    </button>
                  )}
                </div>
              )}
            </Panel>

            <Panel
              title={verdict && !verdict.nobody ? 'Clears the fee floor' : 'Least bad to copy'}
              subtitle={
                verdict && suggest && suggest.length > 0
                  ? verdict.nobody
                    ? `Nobody to recommend this week: at ${boardSize} SOL a copy that goes nowhere makes ${fmtPctS(verdict.floorPct, { signed: true })}, and even the least-bad wallet's copies did worse. Shown so you know who not to copy.`
                    : `${verdict.clears} of these beat a copy that goes nowhere (${fmtPctS(verdict.floorPct, { signed: true })} at ${boardSize} SOL). Still a week's luck until the next week agrees.`
                  : `Least bad to copy this week, at ${boardSize} SOL a copy. Every one still lost on average.`
              }
              action={
                <button className={btn.ghost} onClick={() => nav.go('discover')}>
                  More
                </button>
              }
            >
              {suggest === null ? (
                <p className="text-body text-krypt-muted">Reading…</p>
              ) : suggest.length === 0 ? (
                <p className="text-body leading-relaxed text-krypt-muted">
                  Nobody passes yet — a wallet needs at least 10 trades a copy could have joined before it is ranked.{' '}
                  <button className="text-accent hover:underline" onClick={() => nav.go('discover')}>
                    Open Discover
                  </button>{' '}
                  and leave it recording live; a scan of past hours fills it faster.
                </p>
              ) : (
                <div className="-mx-2 space-y-0.5">
                  {suggest.map((s) => (
                    <button key={s.address} onClick={() => nav.openWallet(s.address)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/[0.04]">
                      <Avatar address={s.address} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-note text-white">{short(s.address, 4)}</div>
                        <div className="text-body text-krypt-muted">
                          <span className={toneOf(s.fMedianReturnPct)}>{fmtPctS(s.fMedianReturnPct, { signed: true })}</span> per copy · holds {fmtHold(s.medianHoldMs)}
                        </div>
                      </div>
                      {followedSet.has(s.address) ? <Tag tone="accent">following</Tag> : <ScoreRing score={s.copyScore} size={32} stroke={3} />}
                    </button>
                  ))}
                </div>
              )}
            </Panel>

            {snap?.latency && snap.latency.samples > 0 && (
              <Panel title="Copy speed" subtitle="This session, median.">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Gauge className="h-4 w-4" />
                  </div>
                  <div className="text-note text-white">
                    {snap.latency.totalMs !== null ? `${(snap.latency.totalMs / 1000).toFixed(1)} s from their trade to yours` : 'Timing their trades…'}
                    <div className="text-body text-krypt-muted">
                      {snap.latency.slotGap !== null ? `${snap.latency.slotGap} slots behind on live copies` : `${snap.latency.samples} cop${snap.latency.samples === 1 ? 'y' : 'ies'} timed`}
                    </div>
                  </div>
                </div>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FollowLine({ c, snap, onOpen }: { c: CopyConfig; snap: ReturnType<typeof useCopySnapshot>['snap']; onOpen: () => void }) {
  const st = snap?.stats[c.id];
  const wr = st ? winRate(st) : null;
  const watching = snap?.watch[c.wallet]?.state === 'watching';
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/[0.04]">
      <div className="relative">
        <Avatar address={c.wallet} size={32} label={c.label} />
        <span
          className={cls('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[rgb(var(--krypt-panel))]', c.enabled ? (watching ? 'bg-up' : 'bg-warn') : 'bg-white/30')}
          title={c.enabled ? (watching ? 'Watching' : 'Connecting') : 'Paused'}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-note font-medium text-white">{c.label || short(c.wallet, 4)}</span>
          <Tag tone={c.mode === 'live' ? 'down' : 'neutral'}>{c.mode}</Tag>
        </div>
        <div className="text-body text-krypt-muted">
          {st && st.wins + st.losses > 0 ? `${st.wins + st.losses} closed · ${Math.round(wr ?? 0)}% won` : st && st.trades ? `${st.trades} cop${st.trades === 1 ? 'y' : 'ies'}, none closed` : 'No copies yet'}
        </div>
      </div>
      <div className={cls('text-note font-semibold tabular-nums', toneOf(st && st.wins + st.losses ? st.realizedPnlSol : null))}>
        {st && st.wins + st.losses ? fmtAmt(st.realizedPnlSol, { signed: true }) : DASH}
      </div>
    </button>
  );
}
