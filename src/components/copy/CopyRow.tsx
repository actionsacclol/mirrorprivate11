// One row of the copy book, said in plain words (2026-10-22): what the
// follow did, against whom, and what it came to. Used by Home's feed and
// Activity, so the same row reads the same everywhere.
//
// A skipped copy is shown, with its reason: a record that hides what the
// filters refused is measuring the wrong thing.

import { ArrowDownRight, ArrowUpRight, Ban, Clock } from 'lucide-react';
import { nativeSymbolOf } from '@shared/evm';
import type { CopyConfig, CopyTrade } from '@shared/copytrade';
import { fmtAgo, cls } from '../../utils/format';
import { openTokenExternally } from '../../utils/links';
import { Avatar, Tag, fmtAmt, short, toneOf } from '../../ui/kit';

function what(t: CopyTrade): string {
  return t.symbol || short(t.mint, 4);
}

export function describe(t: CopyTrade): { title: string; detail: string | null; icon: 'buy' | 'sell' | 'skip' | 'wait' } {
  const sym = nativeSymbolOf(t.chain ?? 'solana');
  if (t.kind === 'exit') {
    if (t.state === 'skipped') return { title: `Did not sell ${what(t)}`, detail: t.reason, icon: 'skip' };
    const pct = t.soldPct ?? 100;
    const theirs = t.leaderPct !== undefined ? ` (they sold ${t.leaderPct}%)` : '';
    return { title: `Sold ${pct >= 100 ? 'all' : `${pct}%`} of ${what(t)}${theirs}`, detail: t.reason, icon: 'sell' };
  }
  if (t.state === 'skipped') return { title: `Skipped ${what(t)}`, detail: t.reason, icon: 'skip' };
  const premium =
    t.entryPriceSol && t.leaderPriceSol
      ? `paid ${t.entryPriceSol >= t.leaderPriceSol ? '+' : '−'}${Math.abs((t.entryPriceSol / t.leaderPriceSol - 1) * 100).toFixed(1)}% vs their price${t.mode === 'live' && t.entryBasis !== 'fill' ? ' (est.)' : ''}`
      : null;
  const held = t.state === 'open' && t.remainingPct !== undefined && t.remainingPct < 100 ? `${Math.round(t.remainingPct)}% still held` : null;
  return {
    title: `Bought ${fmtAmt(t.ourSol, { digits: t.ourSol < 1 ? 3 : 2 })} ${sym} of ${what(t)}`,
    detail: [t.state === 'closed' ? 'closed' : held ?? 'open', premium].filter(Boolean).join(' · ') || null,
    icon: t.state === 'open' ? 'wait' : 'buy',
  };
}

const ICON = {
  buy: { el: ArrowUpRight, cls: 'bg-up/10 text-up' },
  sell: { el: ArrowDownRight, cls: 'bg-accent/10 text-accent' },
  skip: { el: Ban, cls: 'bg-white/5 text-krypt-muted' },
  wait: { el: Clock, cls: 'bg-warn/10 text-warn' },
} as const;

export function CopyRow({ t, config, compact }: { t: CopyTrade; config?: CopyConfig; compact?: boolean }) {
  const d = describe(t);
  const I = ICON[d.icon];
  // A buy's result is booked on its sells, so a closed buy shows none — the
  // same number twice in a feed reads as two results. An open one that has
  // already sold part shows what that part realised.
  const v = t.pnlSol ?? (t.kind !== 'exit' && t.state === 'open' ? (t.realizedSol ?? null) : null);
  const who = config?.label || (t.direction === 'fomo' ? 'Crowd' : short(t.wallet, 4));
  return (
    <div className={cls('flex items-center gap-3 rounded-lg px-2 transition hover:bg-white/[0.03]', compact ? 'py-2' : 'py-2.5')} data-testid="copy-row">
      <div className="relative">
        <Avatar address={t.wallet} size={compact ? 30 : 34} label={config?.label} />
        <span className={cls('absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-[rgb(var(--krypt-panel))]', I.cls)}>
          <I.el className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button onClick={() => openTokenExternally(t.mint, t.chain)} className="truncate text-left text-note font-medium text-white hover:underline" title="Open the coin's page">
            {d.title}
          </button>
          {t.mode === 'live' && <Tag tone="down">live</Tag>}
        </div>
        <div className="truncate text-body text-krypt-muted" title={d.detail ?? undefined}>
          {who} · {fmtAgo(t.at)}
          {d.detail ? ` · ${d.detail}` : ''}
        </div>
      </div>
      <div className={cls('shrink-0 text-right text-note font-semibold tabular-nums', toneOf(v))}>
        {v !== null ? fmtAmt(v, { signed: true }) : t.pnlBasis === 'pending' ? <span className="text-body font-normal text-krypt-muted">pending</span> : ''}
      </div>
    </div>
  );
}
