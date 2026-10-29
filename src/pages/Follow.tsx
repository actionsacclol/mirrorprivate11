// The Follow page (2026-10-24) — following someone, and changing a follow.
//
// It was a three-step pop-up (2026-10-22): whose wallet, a fixed amount, a
// summary. The user, trying it: "it should be a page not a pop up card, with
// advanced toggles, cause rn i cant even set the copy sizing to be % based off
// the wallets trades. it just trades the same amount." The engine had sized by
// their trade since September; only the pop-up could not ask for it, and every
// other control sat in a second editor reached after the follow existed.
//
// So one page, for a new follow and for editing one:
//   · whose trades — paste, a pump.fun username, or Discover's suggestions,
//     with what the Scout knows about their buy size;
//   · how much — a fixed amount, or a share of each of their buys with a cap,
//     previewed against buys of several sizes;
//   · limits — derived from the most one copy can spend, overridable;
//   · advanced — every other control as an on/off row: exits, sells, which
//     trades and coins, execution, the signing wallet, the strategy.
// A new follow still starts on PAPER; Live stays a separate, confirmed switch
// on its card. The config is the shared derivation (followConfig) with the
// user's own choices laid over it, and it saves through the same copy:save.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, AtSign, Check, ChevronDown, FlaskConical, History, Loader2, Save, TriangleAlert, Zap } from 'lucide-react';
import { EVM_CHAIN_META, nativeSymbolOf, type ChainKind, type EvmWalletSummary } from '@shared/evm';
import { AI_WAIT_MAX_SEC, AI_WAIT_MIN_SEC, DEFAULT_AI_GATE, aiGateLine, type AiGateConfig } from '@shared/aiDesk';
import {
  DEFAULT_COPIES_PER_MINUTE,
  DEFAULT_FOMO_CROWD_EXIT_PCT,
  DEFAULT_FOMO_MIN_WALLETS,
  DEFAULT_FOMO_TOP_N,
  DEFAULT_FOMO_TOP_SORT,
  DEFAULT_FOMO_WINDOW_SEC,
  FOLLOW_PCTS,
  FOMO_SOURCES,
  FOMO_SOURCE_LABEL,
  FOMO_WALLET,
  MIN_LIVE_COPY_SOL,
  SIMPLE_SIZES,
  ACTIVE_WINDOW_PRESETS,
  activeWindowOf,
  chainForAddress,
  copySize,
  crowdNoun,
  directionOf,
  followConfig,
  fomoRuleOf,
  fmtClock,
  minLeaderFor,
  ownExitsOf,
  validateConfig,
  type CopyConfig,
  type CopyDirection,
  type FomoSource,
  type SizingMode,
} from '@shared/copytrade';
import { SCOUT_SORTS, SCOUT_SORT_LABEL, shortlistVerdict, type ScoutChain, type ScoutRow, type ScoutSort, type ScoutWallet, type ShortlistVerdict } from '@shared/walletScout';
import { parsePumpHandle, type PumpUser } from '@shared/pumpLookup';
import { paperFixedFeeSol } from '@shared/exitBudget';
import type { WalletSummary } from '@shared/types';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { useNav, type FollowDraft } from '../state/nav';
import { useAddressBook } from '../state/useAddressBook';
import { Avatar, DASH, Panel, ScoreRing, Segmented, btn, fmtHold, fmtPctS, short, toneOf } from '../ui/kit';
import { RowTags } from '../components/copy/WalletTags';
import { cls, fmtAgo } from '../utils/format';

/** The fields the page derives from its own controls, never from `over`. */
const OWN_KEYS = ['wallet', 'label', 'chain', 'direction', 'sizing', 'sizeValue', 'maxTradeSol'] as const;
/** What a template draft carries onto the page; the rest is derived. */
const STRATEGY_KEYS = [
  'exitTakeProfitPct',
  'exitStopLossPct',
  'exitMaxHoldMin',
  'fomoSource',
  'fomoMinWallets',
  'fomoWindowSec',
  'fomoTopN',
  'fomoCrowdExitPct',
  'fomoTopSort',
  'fomoWallets',
  'exitOnCreatorSellPct',
  'exitOnMigration',
  'copyOtherExits',
  'activeFromMin',
  'activeToMin',
  'onePositionPerCoin',
  'ai',
] as const;
/** Caps offered for a percentage copy. */
const CAPS = [0.1, 0.25, 0.5, 1] as const;
/** Their buy sizes the preview runs, in the chain's coin. */
const EXAMPLE_BUYS = [0.05, 0.2, 0.5, 1, 3] as const;
const ADVANCED_KEY = 'krypt.follow.advanced';

/** The share of a round trip the fixed network fees take at this size. */
function fixedFeeShare(sol: number): number {
  return ((paperFixedFeeSol('fast', 'buy') + paperFixedFeeSol('fast', 'sell')) / sol) * 100;
}

const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

export function FollowPage() {
  const nav = useNav();
  const toast = useToast();
  const { settings } = useAppState();
  const target = nav.followTarget ?? {};
  const start = target.config ?? null;
  const editing = !!start?.id;

  // ── what the page holds ───────────────────────────────────────────────
  const [addr, setAddr] = useState(start && start.wallet !== FOMO_WALLET ? start.wallet : (target.address ?? ''));
  const [picking, setPicking] = useState(!(start || target.address));
  const [label, setLabel] = useState(start?.label ?? '');
  // The picked crowd as typed (2026-10-28); parsed into fomoWallets on each change.
  const [crowdText, setCrowdText] = useState((start?.fomoWallets ?? []).join('\n'));
  const [direction, setDirection] = useState<CopyDirection>(start ? directionOf(start) : 'copy');
  const [evmChain, setEvmChain] = useState<'robinhood' | 'bnb'>(start?.chain === 'bnb' ? 'bnb' : 'robinhood');
  const [sizing, setSizing] = useState<SizingMode>(start?.sizing ?? 'fixed');
  const [fixedSol, setFixedSol] = useState<number>(start?.sizing === 'fixed' ? start.sizeValue : SIMPLE_SIZES[0]);
  const [pct, setPct] = useState<number>(start?.sizing === 'proportional' ? start.sizeValue : FOLLOW_PCTS[1]);
  const [cap, setCap] = useState<number>(start?.sizing === 'proportional' ? start.maxTradeSol : CAPS[0]);
  // Every choice the user made beyond the derivation, laid over it. A saved
  // follow opens with all of its own values here, so nothing it had is lost
  // or re-derived behind the user's back.
  const [over, setOver] = useState<Partial<FollowDraft>>(() => {
    if (!start) return {};
    // A template (Reverse, FOMO from Following's menu) brings its strategy —
    // own exits and the crowd rule — and leaves size and limits to derive.
    if (!start.id) {
      const o: Partial<FollowDraft> = {};
      for (const k of STRATEGY_KEYS) if (start[k] !== null && start[k] !== undefined) (o as Record<string, unknown>)[k] = start[k];
      return o;
    }
    const o: Partial<FollowDraft> = { ...start };
    for (const k of OWN_KEYS) delete o[k];
    // A floor that is still the one its percentage implies follows the
    // percentage when it changes; one the user set stays.
    if (start.sizing === 'proportional' && start.minLeaderSol === minLeaderFor(start.sizeValue)) delete o.minLeaderSol;
    return o;
  });
  const setO = (patch: Partial<FollowDraft>): void => setOver((o) => ({ ...o, ...patch }));
  const [advanced, setAdvanced] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ADVANCED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleAdvanced = (): void =>
    setAdvanced((a) => {
      try {
        localStorage.setItem(ADVANCED_KEY, a ? '0' : '1');
      } catch {
        /* a remembered panel is a nicety */
      }
      return !a;
    });

  // ── what the page reads ───────────────────────────────────────────────
  const [suggest, setSuggest] = useState<ScoutRow[] | null>(null);
  const [verdict, setVerdict] = useState<ShortlistVerdict | null>(null);
  const [followed, setFollowed] = useState<string[]>([]);
  const [pumpUser, setPumpUser] = useState<PumpUser | null>(null);
  const [finding, setFinding] = useState(false);
  const [record, setRecord] = useState<ScoutWallet | null>(null);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [evmWallets, setEvmWallets] = useState<Record<'robinhood' | 'bnb', EvmWalletSummary[]>>({ robinhood: [], bnb: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.krypt.copy.list().then((r) => r.ok && r.data && setFollowed(r.data.configs.filter((c) => c.id !== start?.id).map((c) => c.wallet.toLowerCase())));
    // The same rule as "Best to copy" (shortlist), priced at the smallest size.
    void window.krypt.scout.top('solana', 'week', 'fLowerPct', 200, SIMPLE_SIZES[0]).then((r) => {
      const v = r.ok && r.data ? shortlistVerdict(r.data.rows, 5) : null;
      setVerdict(v);
      setSuggest(v ? v.rows : []);
    });
    void Promise.all([
      window.krypt.wallet.list(),
      window.krypt.evm.wallet.list('robinhood').catch(() => null),
      window.krypt.evm.wallet.list('bnb').catch(() => null),
    ]).then(([ws, rh, bnb]) => {
      if (ws.ok && ws.data) setWallets(ws.data);
      setEvmWallets({ robinhood: rh && rh.ok && rh.data ? rh.data : [], bnb: bnb && bnb.ok && bnb.data ? bnb.data : [] });
    });
    // Once, on open: the page's own subject is fixed for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fomo = direction === 'fomo';
  const watch = direction === 'watch';
  const kind = fomo ? 'solana' : chainForAddress(addr);
  const handle = !fomo && kind === null ? parsePumpHandle(addr) : null;
  const chain: ChainKind = fomo ? 'solana' : kind === 'evm' ? evmChain : 'solana';
  const sym = nativeSymbolOf(chain);
  const evmOn = settings.evm.robinhood.enabled || settings.evm.bnb.enabled;
  useEffect(() => {
    if (!start && !settings.evm.robinhood.enabled && settings.evm.bnb.enabled) setEvmChain('bnb');
  }, [start, settings.evm.robinhood.enabled, settings.evm.bnb.enabled]);

  // What the Scout has on them: how big their buys are is what a percentage
  // copy is a percentage OF.
  const validAddr = !fomo && kind !== null;
  // Your address-book name for them is the follow's name unless you typed
  // one (2026-10-28).
  const book = useAddressBook();
  const bookNamed = validAddr ? book.nameOf(addr.trim()) : null;
  useEffect(() => {
    if (!bookNamed || editing) return;
    setLabel((l: string) => l || bookNamed.slice(0, 40));
  }, [bookNamed, editing]);
  useEffect(() => {
    setRecord(null);
    if (!validAddr) return;
    void window.krypt.scout.detail(chain as ScoutChain, addr.trim()).then((r) => r.ok && r.data && setRecord(r.data.wallet));
  }, [validAddr, chain, addr]);
  const theirs = useMemo(() => {
    if (!record) return null;
    const week = record.days.slice(0, 7);
    const buys = week.reduce((n, d) => n + d.buys, 0);
    const volume = week.reduce((n, d) => n + d.volume, 0);
    const trips = week.reduce((n, d) => n + d.roundTrips, 0);
    return { buys, trips, avgBuy: buys > 0 ? volume / buys : null, hold: record.medianHoldMs, lastSeen: record.lastSeen };
  }, [record]);

  const findPumpUser = async (): Promise<void> => {
    if (handle?.kind !== 'username') return;
    setFinding(true);
    try {
      const r = await window.krypt.scout.pumpUser(handle.value);
      if (!r.ok || !r.data) return void toast.error(r.message);
      setPumpUser(r.data);
      setAddr(r.data.wallet);
      setPicking(false);
      setLabel((l: string) => l || `@${r.data!.username}`.slice(0, 40));
    } finally {
      setFinding(false);
    }
  };

  // ── the config ────────────────────────────────────────────────────────
  const cfg: FollowDraft = useMemo(() => {
    const derived = followConfig(addr, label, chain, sizing, sizing === 'fixed' ? fixedSol : pct, cap);
    return {
      ...derived,
      ...over,
      wallet: fomo ? FOMO_WALLET : addr.trim(),
      label: label.trim(),
      chain,
      direction,
      // A watch never trades, so it is never live — whatever mode the
      // follow had before its direction was changed.
      ...(direction === 'watch' ? { mode: 'paper' as const } : {}),
      sizing: derived.sizing,
      sizeValue: derived.sizeValue,
      maxTradeSol: derived.maxTradeSol,
    };
  }, [addr, label, chain, sizing, fixedSol, pct, cap, over, fomo, direction]);
  const already = !fomo && followed.includes(addr.trim().toLowerCase());
  const whoProblem = fomo
    ? null
    : kind === null
      ? addr.trim() && handle?.kind !== 'username'
        ? 'That is not a wallet address or a pump.fun username.'
        : null
      : kind === 'evm' && !evmOn
        ? 'That is an EVM wallet. Switch on Robinhood Chain or BNB under Settings › Other chains to follow one.'
        : already
          ? 'You already follow this wallet — it is on Following.'
          : null;
  const validity = !fomo && kind === null ? { ok: false, message: 'Choose whose trades to copy.' } : whoProblem ? { ok: false, message: whoProblem } : validateConfig(cfg);
  const liveCap = settings.execution.maxLiveSol;
  const most = cfg.sizing === 'fixed' ? cfg.sizeValue : cfg.maxTradeSol;
  const exits = ownExitsOf(cfg);
  const fr = fomoRuleOf(cfg);
  const ownWallets: Array<{ id: string; label: string }> = chain === 'solana' ? wallets : evmWallets[chain];

  const save = async (): Promise<void> => {
    if (!validity.ok) return void toast.error(validity.message);
    setBusy(true);
    try {
      // A new follow starts on paper and running — a paper follow has nothing
      // to arm. A saved one keeps its own mode and switch AS THEY ARE NOW, read
      // at the moment of saving: the copy this page opened with may be stale
      // — the follow may have paused itself on a loss stop, or been paused or
      // switched from its card — and saving that copy re-armed it with no
      // confirmation and reset its stop (2026-10-28).
      let out: FollowDraft = editing ? cfg : { ...cfg, mode: 'paper', enabled: true };
      if (editing && start) {
        const now = await window.krypt.copy.list();
        const cur = now.ok ? now.data?.configs.find((c) => c.id === start.id) : undefined;
        if (!cur) return void toast.error(now.ok ? 'This follow no longer exists.' : now.message);
        out = { ...out, mode: cur.mode, enabled: cur.enabled };
      }
      const r = await window.krypt.copy.save(out as Partial<CopyConfig>);
      if (!r.ok) return void toast.error(r.message);
      toast.success(editing ? 'Saved' : `Following ${cfg.label || (fomo ? 'the crowd' : short(cfg.wallet, 5))} on paper`);
      if (editing) nav.goBack();
      else nav.go('following');
    } finally {
      setBusy(false);
    }
  };

  const title = editing
    ? `Edit ${start?.label || (fomo ? 'Convergence follow' : short(start?.wallet ?? '', 5))}`
    : direction === 'reverse'
      ? 'Reverse a wallet'
      : fomo
        ? 'Follow a crowd'
        : watch
          ? 'Watch a wallet'
          : 'Follow a wallet';

  return (
    <div className="h-full overflow-auto" data-testid="follow-page">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-16 pt-6">
        <button onClick={() => nav.goBack()} className={cls(btn.ghost, '-ml-3')} data-testid="follow-back">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="mt-2 text-[26px] font-semibold tracking-display text-white">{title}</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-krypt-muted">
          {editing
            ? 'Changes apply to the next trade they make. Copies already open keep following them out.'
            : watch
              ? 'Alerts only: every buy and sell they make is toasted here and sent to your chat bots. Nothing is bought.'
              : 'It starts on paper: nothing is bought, every cost is charged, so the record shows what live would have done.'}
        </p>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            {/* ── Whose trades ─────────────────────────────────────────── */}
            {fomo ? (
              <Panel title="The crowd" subtitle="Convergence buys when several wallets from a set buy the same coin within a window — the crowd is the signal, not any one wallet.">
                <Opt title="Which wallets count" body={`Buys when ${fr.minWallets} of ${crowdNoun(cfg)} converge.`}>
                  <Segmented<FomoSource> size="sm" value={fr.source} onChange={(v) => setO({ fomoSource: v })} options={FOMO_SOURCES.map((s) => ({ value: s, label: FOMO_SOURCE_LABEL[s] }))} />
                  {fr.source === 'top' && (
                    <>
                      <Num value={cfg.fomoTopN ?? null} onChange={(n) => setO({ fomoTopN: n })} suffix="wallets" placeholder={String(DEFAULT_FOMO_TOP_N)} />
                      <select
                        value={cfg.fomoTopSort ?? DEFAULT_FOMO_TOP_SORT}
                        onChange={(e) => setO({ fomoTopSort: e.target.value as ScoutSort })}
                        className="rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-body text-white outline-none"
                        title="The Discover ranking the top wallets are taken from, re-read every 30 s as the record moves. Week total is the ranking that found this week’s copyable wallets; run “Scan the week’s winners” on Discover first."
                        data-testid="crowd-sort"
                      >
                        {SCOUT_SORTS.map((s) => (
                          <option key={s} value={s}>
                            by {SCOUT_SORT_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </Opt>
                {fr.source === 'list' && (
                  <Opt title="The wallets" body={`One address a line, or comma-separated. ${fr.wallets.length} picked.`}>
                    <textarea
                      value={crowdText}
                      onChange={(e) => (setCrowdText(e.target.value), setO({ fomoWallets: [...new Set(e.target.value.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean))] }))}
                      placeholder="Wallet addresses"
                      spellCheck={false}
                      rows={4}
                      className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-body text-white outline-none"
                      data-testid="crowd-wallets"
                    />
                  </Opt>
                )}
                <Opt title="Buy when" body="this many of them buy the same coin, within this many seconds">
                  <Num value={cfg.fomoMinWallets ?? null} onChange={(n) => setO({ fomoMinWallets: n })} suffix="wallets" placeholder={String(DEFAULT_FOMO_MIN_WALLETS)} />
                  <Num value={cfg.fomoWindowSec ?? null} onChange={(n) => setO({ fomoWindowSec: n })} suffix="s" placeholder={String(DEFAULT_FOMO_WINDOW_SEC)} />
                </Opt>
                <Opt title="Get out when" body="this share of the wallets that triggered it have sold (or on your own exits below)">
                  <Num value={cfg.fomoCrowdExitPct ?? null} onChange={(n) => setO({ fomoCrowdExitPct: n })} suffix="%" placeholder={String(DEFAULT_FOMO_CROWD_EXIT_PCT)} />
                </Opt>
                <NameField label={label} setLabel={setLabel} />
              </Panel>
            ) : (
              <Panel title={direction === 'reverse' ? 'Whose trades to fade' : watch ? 'Whose trades to watch' : 'Whose trades'}>
                {!picking && validAddr ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-lg border border-white/8 bg-raised px-3 py-2.5" data-testid="follow-wallet">
                      <Avatar address={addr} size={40} label={label} />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-note text-white">{short(addr, 8)}</div>
                        <div className="text-body text-krypt-muted">
                          {kind === 'evm' ? EVM_CHAIN_META[evmChain].name : 'Solana'}
                          {pumpUser && pumpUser.wallet === addr ? ` · pump.fun @${pumpUser.username}` : ''}
                          {theirs ? ` · last traded ${fmtAgo(theirs.lastSeen)}` : ''}
                        </div>
                      </div>
                      {!editing && (
                        <button onClick={() => setPicking(true)} className={btn.ghost}>
                          Change
                        </button>
                      )}
                    </div>
                    {theirs && (theirs.buys > 0 || theirs.trips > 0) ? (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Mini label="Their average buy" value={theirs.avgBuy !== null ? `${round(theirs.avgBuy)} ${sym}` : DASH} />
                        <Mini label="Buys this week" value={theirs.buys.toLocaleString()} />
                        <Mini label="Finished trades" value={theirs.trips.toLocaleString()} />
                        <Mini label="Median hold" value={fmtHold(theirs.hold)} tone={theirs.hold !== null && theirs.hold < 60_000 ? 'text-warn' : undefined} />
                      </div>
                    ) : (
                      <p className="text-body text-krypt-muted">Nothing on record for them yet — the Scout has not seen them trade.</p>
                    )}
                    {kind === 'solana' && (
                      <button onClick={() => nav.checkWallet(addr)} className="inline-flex items-center gap-1.5 text-body text-accent hover:underline" data-testid="follow-check-first">
                        <History className="h-3.5 w-3.5" /> See how copying them would have gone first
                      </button>
                    )}
                    {kind === 'evm' && evmOn && !editing && <EvmPick evmChain={evmChain} setEvmChain={setEvmChain} enabled={settings.evm} />}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <input
                        autoFocus
                        value={addr}
                        onChange={(e) => {
                          // A pump.fun profile link to a wallet is that wallet.
                          const v = e.target.value.trim();
                          const h = chainForAddress(v) === null ? parsePumpHandle(v) : null;
                          setAddr(h?.kind === 'address' ? h.value : v);
                          setPumpUser(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          if (handle?.kind === 'username') void findPumpUser();
                          else if (validAddr && !whoProblem) setPicking(false);
                        }}
                        placeholder="Paste a wallet address, or type a pump.fun username"
                        spellCheck={false}
                        data-testid="follow-address"
                        className="w-full rounded-lg border border-white/10 bg-raised px-3 py-2.5 font-mono text-note text-white outline-none focus:border-accent/60"
                      />
                      {whoProblem && <p className="mt-1.5 text-body text-warn">{whoProblem}</p>}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {handle?.kind === 'username' && (
                          <button onClick={() => void findPumpUser()} disabled={finding} className={btn.secondary} data-testid="follow-pump-find">
                            {finding ? <Loader2 className="h-4 w-4 animate-spin" /> : <AtSign className="h-4 w-4" />}
                            Find {handle.value} on pump.fun
                          </button>
                        )}
                        {validAddr && !whoProblem && (
                          <button onClick={() => setPicking(false)} className={btn.primary} data-testid="follow-use">
                            Use this wallet
                          </button>
                        )}
                      </div>
                      {kind === 'evm' && evmOn && <EvmPick evmChain={evmChain} setEvmChain={setEvmChain} enabled={settings.evm} />}
                    </div>
                    <div>
                      <div className="mb-2 flex items-baseline justify-between">
                        <div className="text-note font-medium text-white">{verdict && !verdict.nobody ? 'Or pick one that clears the fee floor' : 'Or pick one Discover ranks least bad'}</div>
                        <button onClick={() => nav.go('discover')} className="text-body text-accent hover:underline">
                          Browse all
                        </button>
                      </div>
                      {suggest === null ? (
                        <div className="flex items-center gap-2 py-4 text-body text-krypt-muted">
                          <Loader2 className="h-4 w-4 animate-spin" /> Reading the leaderboard…
                        </div>
                      ) : suggest.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-body text-krypt-muted">
                          Nobody passes yet — a wallet needs at least 10 trades a copy could have joined. Leave Discover recording, or press{' '}
                          <span className="text-white">Scan</span> there to read the last hours now.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {suggest.map((s) => (
                            <button
                              key={s.address}
                              onClick={() => (setAddr(s.address), setPicking(false))}
                              data-testid="follow-suggestion"
                              className="flex w-full items-center gap-3 rounded-lg border border-white/8 px-3 py-2 text-left transition hover:border-white/20"
                            >
                              <Avatar address={s.address} size={30} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono text-note text-white">{short(s.address, 5)}</span>
                                  {s.warnings.length > 0 && <RowTags r={{ ...s, flags: [] }} max={2} />}
                                </div>
                                <div className="text-body text-krypt-muted">
                                  {s.roundTrips} trades · holds {fmtHold(s.medianHoldMs)} · a {SIMPLE_SIZES[0]} SOL copy kept{' '}
                                  <span className={toneOf(s.fMedianReturnPct)}>{fmtPctS(s.fMedianReturnPct, { signed: true })}</span> per trade
                                </div>
                              </div>
                              <ScoreRing score={s.copyScore} size={32} stroke={3} />
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="mt-2 text-body leading-relaxed text-krypt-muted">
                        {verdict && verdict.nobody && verdict.rows.length > 0
                          ? `Nobody to recommend this week: a copy that goes nowhere makes ${fmtPctS(verdict.floorPct, { signed: true })} at ${SIMPLE_SIZES[0]} SOL, and even the least-bad wallet's copies did worse. `
                          : ''}
                        Ranked by what a copier would have kept, not by what they made. Copying memecoin wallets loses money on average — this list is the least
                        bad, not a promise.
                      </p>
                    </div>
                  </div>
                )}
                <NameField label={label} setLabel={setLabel} />
              </Panel>
            )}

            {/* ── How much ─────────────────────────────────────────────── */}
            {!watch && (
            <Panel
              title="How much per copy"
              action={
                <Segmented<SizingMode>
                  value={sizing}
                  onChange={setSizing}
                  testId="follow-sizing"
                  options={[
                    { value: 'fixed', label: 'Fixed amount' },
                    { value: 'proportional', label: fomo ? '% of the trigger buy' : '% of their trade' },
                  ]}
                />
              }
            >
              {sizing === 'fixed' ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {SIMPLE_SIZES.map((v) => (
                      <Chip key={v} on={fixedSol === v} onClick={() => setFixedSol(v)} testId="follow-size">
                        {v} {sym}
                      </Chip>
                    ))}
                    <Num value={(SIMPLE_SIZES as readonly number[]).includes(fixedSol) ? null : fixedSol} onChange={(n) => n !== null && n > 0 && setFixedSol(n)} suffix={sym} placeholder="Other" />
                  </div>
                  <p className="mt-3 text-body leading-relaxed text-krypt-muted">
                    Every copy spends {cfg.sizeValue} {sym}, whatever they spent{direction === 'copy' ? ' — a 0.1 buy and a 10 buy of theirs copy the same' : ''}.
                  </p>
                </>
              ) : (
                <>
                  <div className="text-note font-medium text-white">Share of {direction === 'reverse' ? 'each sell' : 'each buy'} of theirs</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {FOLLOW_PCTS.map((v) => (
                      <Chip key={v} on={pct === v} onClick={() => setPct(v)} testId="follow-pct">
                        {v}%
                      </Chip>
                    ))}
                    <Num value={(FOLLOW_PCTS as readonly number[]).includes(pct) ? null : pct} onChange={(n) => n !== null && n > 0 && setPct(n)} suffix="%" placeholder="Other" />
                  </div>
                  <div className="mt-4 text-note font-medium text-white">Never more than</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {CAPS.map((v) => (
                      <Chip key={v} on={cap === v} onClick={() => setCap(v)} testId="follow-cap">
                        {v} {sym}
                      </Chip>
                    ))}
                    <Num value={(CAPS as readonly number[]).includes(cap) ? null : cap} onChange={(n) => n !== null && n > 0 && setCap(n)} suffix={sym} placeholder="Other" />
                  </div>
                  <p className="mt-3 text-body leading-relaxed text-krypt-muted">
                    A copy is {cfg.sizeValue}% of what they spent, up to {cfg.maxTradeSol} {sym}. Big conviction buys get bigger copies; small probes get small ones.
                    {chain === 'solana' && cfg.minLeaderSol
                      ? ` Their buys under ${cfg.minLeaderSol} SOL are skipped: a ${cfg.sizeValue}% copy of them would be under the ${MIN_LIVE_COPY_SOL} SOL a live copy needs to keep fees under 10%.`
                      : ''}
                  </p>
                </>
              )}
              {!fomo && <SizePreview cfg={cfg as CopyConfig} sym={sym} avgBuy={theirs?.avgBuy ?? null} />}
              {chain === 'solana' && (
                <p className={cls('mt-3 text-body leading-relaxed', fixedFeeShare(most) >= 5 ? 'text-warn' : 'text-krypt-muted')}>
                  At {most} SOL the network fees alone take about {fixedFeeShare(most).toFixed(1)}% of a round trip, before the venue&rsquo;s and Krypt&rsquo;s fees
                  {sizing === 'proportional' ? ' — and more on the smaller copies' : ''}.
                </p>
              )}
              {chain === 'solana' && Number.isFinite(liveCap) && liveCap > 0 && most > liveCap && (
                <p className="mt-1.5 text-body text-warn">
                  Above your live max of {liveCap} SOL per trade — fine on paper, but raise the max on the Wallet page before going live.
                </p>
              )}
            </Panel>
            )}

            {/* ── Limits ───────────────────────────────────────────────── */}
            {!watch && (
            <Panel
              title="Limits"
              subtitle={`Suggested from the most one copy spends (${most} ${sym}). Change any of them.`}
              action={
                Object.keys(over).some((k) => k === 'dailyLossLimitSol' || k === 'walletLossStopSol' || k === 'dailyTradeLimit') && !editing ? (
                  <button
                    className={btn.ghost}
                    onClick={() =>
                      setOver((o) => {
                        const n = { ...o };
                        delete n.dailyLossLimitSol;
                        delete n.walletLossStopSol;
                        delete n.dailyTradeLimit;
                        return n;
                      })
                    }
                  >
                    Use suggested
                  </button>
                ) : undefined
              }
            >
              <Opt title="Stop for the day after losing" body="Every follow together counts toward the app-wide limits too; this one is this follow's own.">
                <Num value={cfg.dailyLossLimitSol} onChange={(n) => n !== null && setO({ dailyLossLimitSol: n })} suffix={sym} testId="follow-daily-loss" />
              </Opt>
              <Opt
                title="Pause this wallet after losing"
                body="Counted from when the follow was last switched on. Open copies are still followed out."
                on={cfg.walletLossStopSol !== null && cfg.walletLossStopSol !== undefined}
                onToggle={(on) => setO({ walletLossStopSol: on ? round(most * 4) : null })}
              >
                <Num value={cfg.walletLossStopSol ?? null} onChange={(n) => setO({ walletLossStopSol: n })} suffix={sym} />
              </Opt>
              <Opt title="At most this many copies a day">
                <Num value={cfg.dailyTradeLimit} onChange={(n) => n !== null && setO({ dailyTradeLimit: n })} suffix="copies" />
              </Opt>
            </Panel>
            )}

            {/* ── Advanced ─────────────────────────────────────────────── */}
            <section className="rounded-xl border border-white/8 bg-card shadow-soft">
              <button onClick={toggleAdvanced} className="flex w-full items-center justify-between px-5 py-4 text-left" data-testid="follow-advanced">
                <div>
                  <div className="text-[15px] font-semibold text-white">Advanced</div>
                  <div className="mt-0.5 text-note text-krypt-muted">
                    {watch ? 'The direction and the mode — a watch has nothing else to set.' : 'Your own exits, which sells to mirror, which trades and coins to copy, speed, the wallet that signs.'}
                  </div>
                </div>
                <ChevronDown className={cls('h-5 w-5 text-krypt-muted transition', advanced && 'rotate-180')} />
              </button>
              {advanced && (
                <div className="space-y-6 px-5 pb-5">
                  <Group title="Strategy">
                    <Opt
                      title="Direction"
                      body={
                        direction === 'reverse'
                          ? 'Buys when they SELL and sells when they buy back — a bet the coin keeps going after they leave. Nothing has measured it.'
                          : direction === 'fomo'
                            ? 'Buys when several wallets from a set converge on the same coin inside a window, and leaves when they do. Measured over 9.3 million trades the crowd arrived late (−15 % alone to −32 % with four, an hour on), so it starts on paper.'
                            : watch
                              ? 'Never trades. Every buy and sell they make — first buy, bought more, sold part, sold all, moved it away — is toasted here and sent to your chat bots. Watch a wallet for a week before risking paper, let alone SOL.'
                              : 'Buys when they buy, and mirrors their sells.'
                      }
                    >
                      <Segmented<CopyDirection>
                        size="sm"
                        value={direction}
                        onChange={setDirection}
                        options={[
                          { value: 'copy', label: 'Copy' },
                          { value: 'reverse', label: 'Reverse' },
                          ...(chain === 'solana' ? [{ value: 'fomo' as const, label: 'Convergence' }] : []),
                          { value: 'watch' as const, label: 'Watch only' },
                        ]}
                      />
                    </Opt>
                    {editing && (
                      <Opt title="Mode" body="Switching to Live pauses the follow; arming it is a separate, confirmed switch on its card.">
                        <Segmented<'paper' | 'live'>
                          size="sm"
                          value={cfg.mode}
                          onChange={(m) => setO({ mode: m, enabled: m === 'live' ? false : cfg.enabled })}
                          options={[
                            { value: 'paper', label: <span className="inline-flex items-center gap-1"><FlaskConical className="h-3 w-3" /> Paper</span> },
                            { value: 'live', label: <span className="inline-flex items-center gap-1"><Zap className="h-3 w-3" /> Live</span> },
                          ]}
                        />
                      </Opt>
                    )}
                  </Group>

                  {!watch && (
                  <>
                  <Group title="Your own exits" note={direction === 'copy' ? 'On top of their sells, judged on every price tick.' : 'A reverse or convergence position has no leader sell to close it, so these cannot be switched off.'}>
                    <ExitOpt title="Take profit" suffix="% up" value={exits.takeProfitPct} canOff={direction === 'copy'} dflt={50} onChange={(n) => setO({ exitTakeProfitPct: n })} />
                    <ExitOpt title="Stop loss" suffix="% down" value={exits.stopLossPct} canOff={direction === 'copy'} dflt={30} onChange={(n) => setO({ exitStopLossPct: n })} />
                    <ExitOpt title="Trailing stop" body="Sells once the price falls this far below its highest since you bought." suffix="% below peak" value={exits.trailingPct} canOff dflt={25} onChange={(n) => setO({ exitTrailingPct: n })} />
                    <ExitOpt
                      title="Sell after holding"
                      body={direction === 'copy' ? 'A backstop for a sell of theirs the feed missed.' : undefined}
                      suffix="minutes"
                      value={exits.maxHoldMin}
                      canOff={direction === 'copy'}
                      dflt={30}
                      onChange={(n) => setO({ exitMaxHoldMin: n })}
                    />
                    {chain === 'solana' && (
                      <>
                        <Opt
                          title="Sell if the creator sells"
                          body="The coin’s creator selling this share of their own bag or more, on pump’s curve. Their balance after the sell sizes the share; if it cannot be read, the exit fires anyway — a creator dump is the one sell this rule exists for."
                          on={cfg.exitOnCreatorSellPct != null}
                          onToggle={(on) => setO({ exitOnCreatorSellPct: on ? 50 : null })}
                        >
                          <Num value={cfg.exitOnCreatorSellPct ?? null} onChange={(n) => setO({ exitOnCreatorSellPct: n })} suffix="% of their bag (0 = any sell)" width="w-60" testId="follow-dev-sell" />
                        </Opt>
                        <Opt
                          title="Sell when it graduates"
                          body="The moment the coin leaves pump’s curve for PumpSwap. A live sell waits for the pool if it is not live yet, trying every 15 s."
                          on={cfg.exitOnMigration === true}
                          onToggle={(on) => setO({ exitOnMigration: on })}
                        />
                      </>
                    )}
                  </Group>

                  {!watch && <AiGroup ai={cfg.ai ?? null} onChange={(ai) => setO({ ai })} onOpenAi={() => nav.go('ai')} />}

                  <Group title="Their sells">
                    <Opt
                      title={direction === 'reverse' ? 'Exit when they buy back' : fomo ? 'Mirror the crowd’s sells' : 'Copy their sells'}
                      body={direction === 'copy' ? 'Sells the same share of your copy as they sold of theirs.' : undefined}
                      on={cfg.copySells}
                      onToggle={(on) => setO({ copySells: on })}
                    />
                    {cfg.copySells && direction === 'copy' && (
                      <Opt
                        title="Ignore small trims"
                        body="A sell under this share of their bag is not mirrored — each trim pays its own fee. Their last sell is always 100%, so the exit itself is never skipped."
                        on={cfg.minLeaderSellPct !== null && cfg.minLeaderSellPct !== undefined}
                        onToggle={(on) => setO({ minLeaderSellPct: on ? 50 : null })}
                      >
                        <Num value={cfg.minLeaderSellPct ?? null} onChange={(n) => setO({ minLeaderSellPct: n })} suffix="% of their bag" width="w-44" />
                      </Opt>
                    )}
                    {cfg.copySells && direction === 'copy' && chain === 'solana' && (
                      <Opt
                        title="Follow them out another way"
                        body="They sent the coin to another wallet, sold it for a stablecoin, or swapped it for another token — not a SOL sale, so not a sell the copier can mirror as one. With this on, the same share of your copy is sold, sized from their balance after it."
                        on={cfg.copyOtherExits === true}
                        onToggle={(on) => setO({ copyOtherExits: on })}
                      />
                    )}
                  </Group>

                  <Group title="Which trades">
                    <Opt
                      title={`Only copy ${fomo ? 'trigger buys' : `their ${direction === 'reverse' ? 'sells' : 'buys'}`} of`}
                      body="A tiny probe is not conviction; a whale's buy is one you cannot follow at your size. Blank = no bound on that side."
                      on={cfg.minLeaderSol != null || cfg.maxLeaderSol != null}
                      onToggle={(on) => setO(on ? { minLeaderSol: cfg.sizing === 'proportional' && chain === 'solana' ? cfg.minLeaderSol ?? 0.1 : 0.1, maxLeaderSol: null } : { minLeaderSol: null, maxLeaderSol: null })}
                    >
                      <span className="text-body text-krypt-muted">at least</span>
                      <Num value={cfg.minLeaderSol ?? null} onChange={(n) => setO({ minLeaderSol: n })} suffix={sym} />
                      <span className="text-body text-krypt-muted">at most</span>
                      <Num value={cfg.maxLeaderSol ?? null} onChange={(n) => setO({ maxLeaderSol: n })} suffix={sym} />
                    </Opt>
                    <Opt title="Buy each coin only so many times" body="1 = one entry per coin; their extra buys into it are not copied." on={cfg.maxBuysPerToken != null} onToggle={(on) => setO({ maxBuysPerToken: on ? 1 : null })}>
                      <Num value={cfg.maxBuysPerToken ?? null} onChange={(n) => setO({ maxBuysPerToken: n })} suffix="buys" />
                    </Opt>
                    <Opt
                      title="One position per coin"
                      body="Skips a buy of a coin any of your follows already holds or is buying — two leaders in the same coin is one bet taken twice."
                      on={cfg.onePositionPerCoin === true}
                      onToggle={(on) => setO({ onePositionPerCoin: on })}
                    />
                    <Opt
                      title="Trading hours"
                      body="Copies only between these times on this machine’s clock; exits run around the clock. An end past midnight wraps."
                      on={activeWindowOf(cfg) !== null}
                      onToggle={(on) => setO(on ? { activeFromMin: 8 * 60, activeToMin: 22 * 60 } : { activeFromMin: null, activeToMin: null })}
                    >
                      <span className="text-body text-krypt-muted">from</span>
                      <TimeInput value={cfg.activeFromMin ?? null} onChange={(m) => setO({ activeFromMin: m })} testId="follow-hours-from" />
                      <span className="text-body text-krypt-muted">to</span>
                      <TimeInput value={cfg.activeToMin ?? null} onChange={(m) => setO({ activeToMin: m })} testId="follow-hours-to" />
                      {ACTIVE_WINDOW_PRESETS.map((p) => (
                        <Chip key={p.label} on={cfg.activeFromMin === p.fromMin && cfg.activeToMin === p.toMin} onClick={() => setO({ activeFromMin: p.fromMin, activeToMin: p.toMin })}>
                          {p.label}
                        </Chip>
                      ))}
                    </Opt>
                  </Group>

                  <Group title="Which coins" note="A fact the app cannot read refuses the copy rather than guessing; every refusal is on the record with its reason.">
                    <Opt title="Minimum liquidity" on={cfg.minLiquidityUsd != null} onToggle={(on) => setO({ minLiquidityUsd: on ? 5_000 : null })}>
                      <Num value={cfg.minLiquidityUsd ?? null} onChange={(n) => setO({ minLiquidityUsd: n })} suffix="USD" width="w-36" />
                    </Opt>
                    <Opt title="Market cap" body="Blank = no bound on that side." on={cfg.minMarketCapUsd != null || cfg.maxMarketCapUsd != null} onToggle={(on) => setO(on ? { minMarketCapUsd: 10_000, maxMarketCapUsd: null } : { minMarketCapUsd: null, maxMarketCapUsd: null })}>
                      <span className="text-body text-krypt-muted">from</span>
                      <Num value={cfg.minMarketCapUsd ?? null} onChange={(n) => setO({ minMarketCapUsd: n })} suffix="USD" width="w-36" />
                      <span className="text-body text-krypt-muted">to</span>
                      <Num value={cfg.maxMarketCapUsd ?? null} onChange={(n) => setO({ maxMarketCapUsd: n })} suffix="USD" width="w-36" />
                    </Opt>
                    <Opt title="Coin age when they buy" body="Blank = no bound on that side." on={cfg.minTokenAgeSec != null || cfg.maxTokenAgeSec != null} onToggle={(on) => setO(on ? { minTokenAgeSec: null, maxTokenAgeSec: 60 * 60 } : { minTokenAgeSec: null, maxTokenAgeSec: null })}>
                      <span className="text-body text-krypt-muted">at least</span>
                      <Num value={cfg.minTokenAgeSec != null ? cfg.minTokenAgeSec / 60 : null} onChange={(n) => setO({ minTokenAgeSec: n === null ? null : n * 60 })} suffix="min" />
                      <span className="text-body text-krypt-muted">at most</span>
                      <Num value={cfg.maxTokenAgeSec != null ? cfg.maxTokenAgeSec / 60 : null} onChange={(n) => setO({ maxTokenAgeSec: n === null ? null : n * 60 })} suffix="min" />
                    </Opt>
                    <Opt title="Minimum Krypt score" on={cfg.minKryptScore != null} onToggle={(on) => setO({ minKryptScore: on ? 50 : null })}>
                      <Num value={cfg.minKryptScore ?? null} onChange={(n) => setO({ minKryptScore: n })} suffix="/ 100" />
                    </Opt>
                    {chain === 'solana' && <Opt title="pump.fun coins only" on={cfg.onlyPumpfun} onToggle={(on) => setO({ onlyPumpfun: on })} />}
                    <Blocklists cfg={cfg} setO={setO} />
                  </Group>

                  <Group title="Execution">
                    <Opt title="Wait before copying" body="After their trade lands. Zero is as fast as the feed allows." on={cfg.delayMs > 0} onToggle={(on) => setO({ delayMs: on ? 500 : 0 })}>
                      <Num value={cfg.delayMs} onChange={(n) => setO({ delayMs: n ?? 0 })} suffix="ms" />
                    </Opt>
                    <Opt title="Maximum slippage">
                      <Num value={cfg.maxSlippagePct} onChange={(n) => n !== null && setO({ maxSlippagePct: n })} suffix="%" />
                    </Opt>
                    <Opt title="At most this many copies a minute" body="A burst wall: a leader firing eight swaps in one slot cannot out-run the daily limit.">
                      <Num value={cfg.maxCopiesPerMinute ?? null} onChange={(n) => setO({ maxCopiesPerMinute: n })} suffix="a minute" placeholder={String(DEFAULT_COPIES_PER_MINUTE)} width="w-36" />
                    </Opt>
                    <Opt title="Copy with" body="Which of your wallets signs the copies. Give each leader its own to keep them apart.">
                      <select
                        value={cfg.walletId ?? ''}
                        onChange={(e) => setO({ walletId: e.target.value || null })}
                        className="rounded-lg border border-white/10 bg-raised px-3 py-1.5 text-note text-white outline-none focus:border-accent/60"
                      >
                        <option value="">Active wallet{chain !== 'solana' ? ` on ${EVM_CHAIN_META[chain].name}` : ''}</option>
                        {ownWallets.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.label}
                          </option>
                        ))}
                      </select>
                    </Opt>
                  </Group>
                  </>
                  )}
                </div>
              )}
            </section>
          </div>

          {/* ── Summary ──────────────────────────────────────────────── */}
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <Panel title="What will happen">
              <ul className="space-y-2 text-note text-white" data-testid="follow-summary">
                {summaryLines(cfg as CopyConfig, sym, editing).map((t) => (
                  <li key={t} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-up" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
              {!validity.ok && (
                <p className="mt-3 flex gap-2 text-body text-warn">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {validity.message}
                </p>
              )}
              <div className="mt-4 flex flex-col gap-2">
                <button onClick={() => void save()} disabled={busy || !validity.ok} className={btn.primary} data-testid="follow-start">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Save className="h-4 w-4" /> : <FlaskConical className="h-4 w-4" />}
                  {editing ? 'Save changes' : watch ? 'Start watching' : 'Start on paper'}
                </button>
                <button onClick={() => nav.goBack()} className={btn.ghost}>
                  Cancel
                </button>
              </div>
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}

/** What the follow will do, in words, from the config it will save. */
function summaryLines(c: CopyConfig, sym: string, editing: boolean): string[] {
  const d = directionOf(c);
  const f = fomoRuleOf(c);
  const x = ownExitsOf(c);
  const out: string[] = [];
  if (d === 'watch') {
    out.push('Never trades. Every buy and sell they make is toasted here and sent to your chat bots.');
    out.push('Their record builds on Following and on their profile, so you can see how they do before copying.');
    out.push(editing ? 'Change the direction to turn it into a copy.' : 'Edit it later and change the direction to turn it into a copy.');
    return out;
  }
  if (!editing) out.push('Starts on paper — nothing is bought. Every simulated trade pays what a real one would, both ways.');
  else out.push(c.mode === 'live' ? (c.enabled ? 'Live and armed: copies spend real money.' : 'Live, paused until you arm it on its card.') : 'On paper.');
  const size = c.sizing === 'fixed' ? `${c.sizeValue} ${sym}` : `${c.sizeValue}% of their size, never more than ${c.maxTradeSol} ${sym}`;
  out.push(
    d === 'reverse'
      ? `Buys ${size} each time they SELL.`
      : d === 'fomo'
        ? `Buys ${size} when ${f.minWallets} of ${crowdNoun(c)} buy the same coin within ${f.windowSec} s.`
        : `Buys ${size} each time they buy, at the price after them, not theirs.`,
  );
  const band = [c.minLeaderSol != null ? `under ${c.minLeaderSol}` : '', c.maxLeaderSol != null ? `over ${c.maxLeaderSol}` : ''].filter(Boolean).join(' or ');
  if (band) out.push(`Skips their trades ${band} ${sym}.`);
  if (c.copySells) out.push(d === 'copy' ? `When they sell, sells the same share${c.minLeaderSellPct ? ` (trims under ${c.minLeaderSellPct}% of their bag ignored)` : ''}.` : d === 'reverse' ? 'Gets out when they buy back.' : `Gets out when ${f.crowdExitPct}% of the crowd has sold.`);
  else if (d === 'copy') out.push('Ignores their sells — only your own exits close a copy.');
  const own = [
    x.takeProfitPct !== null ? `+${x.takeProfitPct}%` : '',
    x.stopLossPct !== null ? `−${x.stopLossPct}%` : '',
    x.trailingPct !== null ? `${x.trailingPct}% trailing` : '',
    x.maxHoldMin !== null ? `${x.maxHoldMin} min` : '',
  ].filter(Boolean);
  if (own.length) out.push(`Also sells on its own at ${own.join(', ')}.`);
  if (c.exitOnCreatorSellPct != null) out.push(c.exitOnCreatorSellPct > 0 ? `Sells if the creator sells ${c.exitOnCreatorSellPct}% or more of their bag.` : 'Sells the moment the creator sells any of their bag.');
  if (c.exitOnMigration) out.push('Sells when the coin graduates to PumpSwap.');
  if (c.copySells && d === 'copy' && c.copyOtherExits) out.push('Follows them out when they move, swap or stable-sell the coin instead of selling it for SOL.');
  if (c.onePositionPerCoin) out.push('Skips a coin any of your follows already holds.');
  const ai = aiGateLine(c.ai);
  if (ai) out.push(ai);
  const win = activeWindowOf(c);
  if (win) out.push(`Copies only between ${fmtClock(win.fromMin)} and ${fmtClock(win.toMin)}; exits run around the clock.`);
  const filters = [c.minLiquidityUsd, c.minMarketCapUsd, c.maxMarketCapUsd, c.minTokenAgeSec, c.maxTokenAgeSec, c.minKryptScore, c.maxBuysPerToken].filter((v) => v !== null && v !== undefined).length + (c.onlyPumpfun ? 1 : 0) + (c.blockedMints?.length || c.blockedCreators?.length ? 1 : 0);
  if (filters) out.push(`${filters} coin filter${filters === 1 ? '' : 's'} on.`);
  if (c.delayMs > 0) out.push(`Waits ${c.delayMs} ms after their trade.`);
  out.push(`Stops for the day after losing ${c.dailyLossLimitSol} ${sym}${c.walletLossStopSol ? `, and pauses after losing ${c.walletLossStopSol} ${sym} in all` : ''}.`);
  if (!editing) out.push('Live is a separate switch on its card on Following, and it asks before it arms.');
  return out;
}

/** "They buy X → you buy Y", over a spread of their sizes and their average. */
function SizePreview({ cfg, sym, avgBuy }: { cfg: CopyConfig; sym: string; avgBuy: number | null }) {
  const rows: Array<{ theirs: number; avg?: boolean }> = EXAMPLE_BUYS.map((v) => ({ theirs: v }));
  if (avgBuy !== null && avgBuy > 0) rows.push({ theirs: round(avgBuy), avg: true });
  rows.sort((a, b) => a.theirs - b.theirs);
  const what = directionOf(cfg) === 'reverse' ? 'They sell' : 'They buy';
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-white/8" data-testid="follow-preview">
      <div className="grid grid-cols-2 gap-3 border-b border-white/8 px-4 py-2 text-body text-krypt-muted">
        <span>{what}</span>
        <span className="text-right">Your copy</span>
      </div>
      {rows.map((r) => {
        const skipped =
          cfg.minLeaderSol != null && r.theirs < cfg.minLeaderSol ? `skipped — under ${cfg.minLeaderSol}` : cfg.maxLeaderSol != null && r.theirs > cfg.maxLeaderSol ? `skipped — over ${cfg.maxLeaderSol}` : null;
        const ours = copySize(cfg, r.theirs);
        return (
          <div key={`${r.theirs}${r.avg ? 'a' : ''}`} className={cls('grid grid-cols-2 gap-3 border-b border-white/[0.05] px-4 py-1.5 text-note last:border-b-0', r.avg && 'bg-accent/[0.07]')}>
            <span className="tabular-nums text-white">
              {r.theirs} {sym}
              {r.avg && <span className="ml-2 text-body text-accent">their average</span>}
            </span>
            <span className={cls('text-right tabular-nums', skipped ? 'text-krypt-muted' : 'text-white')}>
              {skipped ?? `${round(ours, 4)} ${sym}${cfg.sizing === 'proportional' && ours >= cfg.maxTradeSol ? ' (cap)' : ''}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Blocklists({ cfg, setO }: { cfg: FollowDraft; setO: (p: Partial<FollowDraft>) => void }) {
  const [open, setOpen] = useState(!!(cfg.blockedMints?.length || cfg.blockedCreators?.length));
  const [mints, setMints] = useState((cfg.blockedMints ?? []).join('\n'));
  const [creators, setCreators] = useState((cfg.blockedCreators ?? []).join('\n'));
  const parse = (raw: string): string[] | null => {
    const out = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s, i, a) => s && a.indexOf(s) === i);
    return out.length ? out : null;
  };
  const box = 'min-h-[60px] w-full resize-y rounded-lg border border-white/10 bg-raised px-3 py-2 font-mono text-body text-white outline-none focus:border-accent/60';
  return (
    <Opt
      title="Never copy these"
      body="Coins, or coins made by these creators. One address per line."
      on={open}
      onToggle={(on) => {
        setOpen(on);
        if (!on) setO({ blockedMints: null, blockedCreators: null });
        else setO({ blockedMints: parse(mints), blockedCreators: parse(creators) });
      }}
    >
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        <textarea value={mints} onChange={(e) => (setMints(e.target.value), setO({ blockedMints: parse(e.target.value) }))} placeholder="Coin addresses" spellCheck={false} className={box} />
        <textarea value={creators} onChange={(e) => (setCreators(e.target.value), setO({ blockedCreators: parse(e.target.value) }))} placeholder="Creator addresses" spellCheck={false} className={box} />
      </div>
    </Opt>
  );
}

function ExitOpt({
  title,
  body,
  suffix,
  value,
  canOff,
  dflt,
  onChange,
}: {
  title: string;
  body?: string;
  suffix: string;
  value: number | null;
  canOff: boolean;
  dflt: number;
  onChange: (n: number | null) => void;
}) {
  return (
    <Opt title={title} body={body} on={canOff ? value !== null : undefined} onToggle={canOff ? (on) => onChange(on ? dflt : null) : undefined}>
      <Num value={value} onChange={(n) => onChange(n)} suffix={suffix} width="w-40" />
    </Opt>
  );
}

function EvmPick({ evmChain, setEvmChain, enabled }: { evmChain: 'robinhood' | 'bnb'; setEvmChain: (c: 'robinhood' | 'bnb') => void; enabled: Record<'robinhood' | 'bnb', { enabled: boolean }> }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-body text-krypt-muted">
      They trade on
      {(['robinhood', 'bnb'] as const)
        .filter((c) => enabled[c].enabled)
        .map((c) => (
          <button
            key={c}
            onClick={() => setEvmChain(c)}
            className={cls('rounded-md border px-2.5 py-1 text-body font-medium', evmChain === c ? 'border-accent/50 bg-accent/10 text-white' : 'border-white/10 text-krypt-muted')}
          >
            {EVM_CHAIN_META[c].name}
          </button>
        ))}
    </div>
  );
}

function NameField({ label, setLabel }: { label: string; setLabel: (v: string) => void }) {
  return (
    <div className="mt-4">
      <div className="text-note font-medium text-white">
        Name <span className="font-normal text-krypt-muted">(optional)</span>
      </div>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. Whale 1"
        maxLength={40}
        data-testid="follow-name"
        className="mt-2 w-full rounded-lg border border-white/10 bg-raised px-3 py-2.5 text-note text-white outline-none focus:border-accent/60"
      />
    </div>
  );
}

/**
 * The AI desk (2026-10-28): the AI connected on the AI page decides this
 * follow's buys and/or sells. Off = null; the object is kept only while one
 * of the two is on.
 */
function AiGroup({ ai, onChange, onOpenAi }: { ai: AiGateConfig | null; onChange: (ai: AiGateConfig | null) => void; onOpenAi: () => void }) {
  const g = ai ?? { ...DEFAULT_AI_GATE, entries: false, exits: false };
  const set = (patch: Partial<AiGateConfig>): void => {
    const next = { ...g, ...patch };
    onChange(next.entries || next.exits ? next : null);
  };
  const on = g.entries || g.exits;
  return (
    <Group title="Your AI decides" note="An AI app connected on the AI page gets the final say. It can only narrow what this follow does — skip, buy smaller, hold, sell less — never buy more.">
      <Opt
        title="Your AI decides each buy"
        body="Asked after every filter and your delay. Its answer time is part of the copy's lag, on paper too, so the record shows what waiting costs."
        on={g.entries}
        onToggle={(v) => set({ entries: v })}
      />
      <Opt
        title="Your AI decides each sell"
        body="Their sell, your take-profit, max hold, graduation: the AI says sell, sell less or hold. A hold quiets that one rule on that coin for ten minutes; the other rules still fire."
        on={g.exits}
        onToggle={(v) => set({ exits: v })}
      />
      {on && (
        <Opt title="Answer within" body="Past this the follow's own rule decides.">
          <Num value={g.waitSec} onChange={(n) => n !== null && set({ waitSec: Math.max(AI_WAIT_MIN_SEC, Math.min(AI_WAIT_MAX_SEC, n)) })} suffix="seconds" />
        </Opt>
      )}
      {g.entries && (
        <Opt title="If the AI does not answer a buy" body="Including when no AI is connected, or the connection may not decide this follow's mode.">
          <Chip on={g.onTimeout === 'skip'} onClick={() => set({ onTimeout: 'skip' })}>
            Skip it
          </Chip>
          <Chip on={g.onTimeout === 'copy'} onClick={() => set({ onTimeout: 'copy' })}>
            Copy anyway
          </Chip>
        </Opt>
      )}
      {g.exits && (
        <Opt
          title="Stop-losses wait for the AI too"
          body="Off: stop-loss, trailing stop and creator-sell exits fire at once — an AI that is thinking, or offline, never holds you in a falling coin. Sells without an answer always go ahead."
          on={g.protectiveWait}
          onToggle={(v) => set({ protectiveWait: v })}
        />
      )}
      {on && (
        <div className="pt-2">
          <button type="button" className={btn.ghost} onClick={onOpenAi} data-testid="follow-ai-open">
            Connect your AI on the AI page
          </button>
        </div>
      )}
    </Group>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-label uppercase tracking-label text-krypt-muted">{title}</div>
      {note && <p className="mt-1 text-body text-krypt-muted">{note}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** One setting: a title, what it does, an on/off switch when it can be off,
 *  and its inputs while it is on. */
function Opt({ title, body, on, onToggle, children }: { title: string; body?: string; on?: boolean; onToggle?: (on: boolean) => void; children?: ReactNode }) {
  const shown = on === undefined || on;
  return (
    <div className="border-b border-white/[0.05] py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-note font-medium text-white">{title}</div>
          {body && <div className="mt-0.5 text-body leading-relaxed text-krypt-muted">{body}</div>}
        </div>
        {onToggle && on !== undefined && <Toggle on={on} onChange={onToggle} label={title} />}
      </div>
      {shown && children && <div className="mt-2.5 flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cls('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition', on ? 'bg-accent' : 'bg-white/15')}
    >
      <span className={cls('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-soft transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

/** A time of day as minutes after midnight, through the browser's own picker. */
function TimeInput({ value, onChange, testId }: { value: number | null; onChange: (m: number | null) => void; testId?: string }) {
  return (
    <input
      type="time"
      value={value === null ? '' : fmtClock(value)}
      onChange={(e) => {
        const m = /^(\d{2}):(\d{2})$/.exec(e.target.value);
        onChange(m ? Number(m[1]) * 60 + Number(m[2]) : null);
      }}
      data-testid={testId}
      className="rounded-lg border border-white/10 bg-raised px-3 py-1.5 font-mono text-note text-white outline-none focus:border-accent/60"
    />
  );
}

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={cls(
        'rounded-lg border px-4 py-2 text-note font-semibold tabular-nums transition',
        on ? 'border-accent bg-accent/10 text-white' : 'border-white/10 text-krypt-muted hover:border-white/20 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/8 px-3 py-2">
      <div className="text-body text-krypt-muted">{label}</div>
      <div className={cls('mt-0.5 text-note font-semibold tabular-nums', tone ?? 'text-white')}>{value}</div>
    </div>
  );
}

/** A number box that commits as you type (the preview follows it), keeps
 *  what you typed while it is focused — "0.1" on the way to "0.15" is a
 *  preset, and must not wipe the box — and is blank for "not set". */
function Num({
  value,
  onChange,
  suffix,
  placeholder,
  width = 'w-32',
  testId,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  suffix?: string;
  placeholder?: string;
  width?: string;
  testId?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value === null ? '' : String(value));
  }, [value]);
  return (
    <label className={cls('inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-raised px-2.5 py-1.5 focus-within:border-accent/60', width)}>
      <input
        value={text}
        inputMode="decimal"
        placeholder={placeholder}
        data-testid={testId}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setText(value === null ? '' : String(value));
        }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const n = Number(t);
          const next = t.trim() === '' ? null : Number.isFinite(n) ? n : undefined;
          if (next === undefined) return;
          onChange(next);
        }}
        className="min-w-0 flex-1 bg-transparent text-note tabular-nums text-white outline-none placeholder:text-krypt-muted"
      />
      {suffix && <span className="shrink-0 text-body text-krypt-muted">{suffix}</span>}
    </label>
  );
}
