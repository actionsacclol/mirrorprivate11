// Activity (2026-10-22) — everything the copies did, in three tabs.
//
// Copies: each copy, exit and skip, in plain words, filterable — skips
// included, because a record that hides what the filters refused measures
// the wrong thing. Positions and History are the portfolio and trade pages
// Krypto Bot already had, read from the chain's own record of every fill.

import { useMemo, useState } from 'react';
import type { CopyMode } from '@shared/copytrade';
import { TabbedPage } from '../components/common';
import { CopyRow } from '../components/copy/CopyRow';
import { useNav } from '../state/nav';
import { useCopySnapshot } from '../state/useCopy';
import { openTokenExternally } from '../utils/links';
import { PortfolioPage } from './Portfolio';
import { TradesPage } from './Trades';
import { SearchBox, Segmented, btn } from '../ui/kit';

type Kind = 'all' | 'buys' | 'sells' | 'skips';

export function ActivityPage() {
  const nav = useNav();
  const tab = nav.activityTab;
  return (
    <TabbedPage
      title="Activity"
      subtitle="What your copies did, what they hold, and every fill on the chain."
      value={tab}
      onChange={(t) => nav.go('activity', { activityTab: t })}
      tabs={[
        { value: 'copies', label: 'Copies' },
        { value: 'positions', label: 'Positions' },
        { value: 'history', label: 'Trade history' },
      ]}
    >
      {tab === 'copies' && <Copies />}
      {tab === 'positions' && <PortfolioPage onOpenToken={openTokenExternally} />}
      {tab === 'history' && <TradesPage onOpenToken={openTokenExternally} />}
    </TabbedPage>
  );
}

function Copies() {
  const nav = useNav();
  const { snap } = useCopySnapshot();
  const [kind, setKind] = useState<Kind>('all');
  const [mode, setMode] = useState<CopyMode | 'all'>('all');
  const [q, setQ] = useState('');
  const byId = useMemo(() => new Map((snap?.configs ?? []).map((c) => [c.id, c])), [snap]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (snap?.recent ?? []).filter((t) => {
      if (mode !== 'all' && t.mode !== mode) return false;
      if (kind === 'skips' && t.state !== 'skipped') return false;
      if (kind === 'buys' && (t.kind === 'exit' || t.state === 'skipped')) return false;
      if (kind === 'sells' && (t.kind !== 'exit' || t.state === 'skipped')) return false;
      if (!needle) return true;
      const label = byId.get(t.configId)?.label ?? '';
      return [t.symbol, t.mint, t.wallet, label].some((s) => s.toLowerCase().includes(needle));
    });
  }, [snap, kind, mode, q, byId]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-12 pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'All' },
              { value: 'buys', label: 'Buys' },
              { value: 'sells', label: 'Sells' },
              { value: 'skips', label: 'Skipped' },
            ]}
          />
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: 'Paper + live' },
              { value: 'paper', label: 'Paper' },
              { value: 'live', label: 'Live' },
            ]}
          />
          <SearchBox value={q} onChange={setQ} placeholder="Coin, wallet or name" className="ml-auto w-72" />
        </div>
        <div className="mt-4 rounded-xl border border-white/8 bg-card px-3 py-2 shadow-soft">
          {rows.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <p className="text-[15px] font-medium text-white">{(snap?.recent ?? []).length ? 'Nothing matches.' : 'No copies yet.'}</p>
              <p className="mt-1 text-note text-krypt-muted">
                {(snap?.configs ?? []).length ? 'Copies show up here the moment a wallet you follow trades.' : 'Follow a wallet and every copy it makes is recorded here.'}
              </p>
              {!(snap?.configs ?? []).length && (
                <button className={btn.primary + ' mt-4'} onClick={() => nav.follow()}>
                  Follow a wallet
                </button>
              )}
            </div>
          ) : (
            rows.map((t) => <CopyRow key={t.id} t={t} config={byId.get(t.configId)} />)
          )}
        </div>
        <p className="mt-3 text-body text-krypt-muted">The newest 100 rows. Paper rows are simulated and priced with every fee; live rows are priced from your own fills.</p>
      </div>
    </div>
  );
}
