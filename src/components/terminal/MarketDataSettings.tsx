import { AlertCircle, CheckCircle2, MinusCircle } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { humanWait } from '@shared/market';
import type { ProviderId, ProviderStatus } from '@shared/market';
import { Card, GhostButton, Section, Switch } from '../common';
import { useTerminal } from '../../state/TerminalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls, fmtAgo } from '../../utils/format';
import { useLocale } from '../../state/useLocale';

// Market-data settings + the privacy panel.
//
// This is the screen that makes the local-first claim checkable rather than
// a slogan. It names EVERY host the terminal will contact, says exactly what
// each one is used for, shows a live call/error/latency count per provider,
// and has one switch that turns all of it off.
//
// With the master switch off the app still works: on-chain reads, the live
// WSS tape and everything the engine produces are unaffected, because none
// of that goes through a provider. What you lose is charts and any token the
// engine has not personally seen — which is the honest trade-off, stated.
//
// The provider keys (Birdeye, Jupiter, the GIF search) moved to Settings →
// API keys on 2026-10-25 (ApiKeysSection), one home for every key; the rows
// here still say which provider needs one.

function StatusDot({ p }: { p: ProviderStatus }) {
  if (!p.enabled) return <MinusCircle className="h-3.5 w-3.5 text-krypt-muted/40" />;
  if (!p.usable) return <AlertCircle className="h-3.5 w-3.5 text-arc-gold" />;
  if (p.errors > 0 && p.lastError) return <AlertCircle className="h-3.5 w-3.5 text-rose-400" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
}

export function MarketDataSettings({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useLocale();
  const term = useTerminal();
  const toast = useToast();

  const setProvider = (id: ProviderId, on: boolean): void => {
    void updateSettings({
      data: { ...settings.data, providers: { ...settings.data.providers, [id]: on } },
    }).then(() => term.refreshProviders());
  };

  const anyOn = settings.data.networkDataEnabled;

  return (
    <Section
      title={t('settings.marketData')}
      description="Which third-party APIs the terminal is allowed to contact, and exactly what each one sees."
    >
      <Card className="space-y-4">
        <Switch
          label="Allow market data providers"
          description={
            anyOn
              ? 'On. The terminal can fetch prices, feeds and charts from the hosts listed below.'
              : 'Off. Nothing here is contacted. Copy filters that need token facts (liquidity, market cap) then refuse every copy; on-chain reads and the copy watcher keep working.'
          }
          checked={settings.data.networkDataEnabled}
          onChange={(v) => {
            void updateSettings({ data: { ...settings.data, networkDataEnabled: v } }).then(() =>
              term.refreshProviders(),
            );
          }}
        />

        <Switch
          label="Load token images"
          description={
            settings.data.loadTokenImages
              ? 'On. Icons are fetched through Krypt’s own hardened handler — https only, no redirects, size-capped, no SVG — but the request still comes from your machine, so the token’s creator sees your IP.'
              : 'Off. Tokens show a letter avatar and no image host is ever contacted.'
          }
          disabled={!settings.data.networkDataEnabled}
          checked={settings.data.loadTokenImages}
          onChange={(v) => {
            void updateSettings({ data: { ...settings.data, loadTokenImages: v } });
          }}
        />

        <div className="rounded-lg border border-white/10 bg-black/25 p-3">
          <p className="text-body text-krypt-muted leading-relaxed">
            <span className="text-white font-semibold">What these providers learn.</span> Each one sees the mint
            addresses you look at and your IP, because your machine asks them directly — there is no Krypt server in
            between, so Krypt never sees any of it. A provider you switch off is never contacted at all. The
            keyless providers need no account and no sign-up.
          </p>
        </div>

        <div className="space-y-2">
          {term.providers.map((p) => {
            const on = settings.data.providers[p.id];
            return (
              <div
                key={p.id}
                className={cls(
                  'rounded-lg border px-3 py-2.5 transition',
                  on && p.usable ? 'border-white/12 bg-white/[0.03]' : 'border-white/8 bg-black/20',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <StatusDot p={p} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-value font-semibold text-white">{p.label}</span>
                      <span className="font-mono text-label text-krypt-muted/70">{p.host}</span>
                      {!p.keyless && (
                        <span className="rounded border border-arc-gold/30 bg-arc-gold/10 px-1.5 text-micro font-bold text-arc-gold">
                          KEY
                        </span>
                      )}
                    </div>
                    <p className="text-body text-krypt-muted mt-0.5">{p.provides}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={on}
                    disabled={!settings.data.networkDataEnabled}
                    onClick={() => setProvider(p.id, !on)}
                    className={cls(
                      'relative h-5 w-9 rounded-full transition flex-shrink-0',
                      !settings.data.networkDataEnabled && 'opacity-40 cursor-not-allowed',
                      on ? 'bg-krypt-gradient shadow-[0_0_8px_rgb(var(--krypt-accent)/0.45)]' : 'bg-white/10',
                    )}
                  >
                    <span
                      className={cls(
                        'absolute top-0.5 h-4 w-4 rounded-full bg-white transition',
                        on ? 'left-[18px]' : 'left-0.5',
                      )}
                    />
                  </button>
                </div>

                {on && (
                  <div className="flex items-center gap-4 mt-2 pt-2 border-t border-white/5 text-label font-mono text-krypt-muted">
                    <span>{p.calls} calls</span>
                    <span className={p.errors > 0 ? 'text-rose-400/80' : undefined}>{p.errors} errors</span>
                    <span>{p.latencyMs === null ? '—' : `${p.latencyMs}ms`}</span>
                    {p.lastCallAt && <span>{fmtAgo(p.lastCallAt)} ago</span>}
                    {p.cooldownMs > 0 && (
                      <span
                        className="text-arc-gold"
                        title={
                          p.cooldownIsQuota
                            ? 'The provider says its allowance is spent. Waiting will not clear it — top up the plan or switch it off.'
                            : 'The provider answered 429; nothing is sent to it until this runs out.'
                        }
                      >
                        {/* Seconds are unreadable once a park can be hours:
                            a spent allowance showed as "retrying in 21596s"
                            (reported 2026-09-16). */}
                        {p.cooldownIsQuota ? `no allowance left · paused ${humanWait(p.cooldownMs)}` : `rate limited · retrying in ${humanWait(p.cooldownMs)}`}
                      </span>
                    )}
                    {p.queued > 5 && <span title="Calls waiting in this provider&apos;s queue.">{p.queued} queued</span>}
                    {!p.usable && !p.keyless && <span className="text-arc-gold">needs an API key</span>}
                    {p.lastError && (
                      <span className="text-rose-400/70 truncate" title={p.lastError}>
                        {p.lastError}
                      </span>
                    )}
                  </div>
                )}
                {on && (p.routes?.length ?? 0) > 0 && (
                  // What is spending this provider's budget (2026-09-20): the
                  // routes asked this session, most-called first. The tooltip
                  // carries the full list.
                  <div
                    className="mt-1 truncate text-nano font-mono text-krypt-muted/70"
                    title={(p.routes ?? []).map((r) => `${r.route} ×${r.calls}`).join('  ·  ')}
                  >
                    {(p.routes ?? []).slice(0, 3).map((r) => `${r.route.replace(/^\/api\/v2\/networks\//, '…/')} ×${r.calls}`).join(' · ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-label leading-relaxed text-krypt-muted/60">
          The keys these providers take — Birdeye, Jupiter, the GIF search — are managed under <span className="text-white/80">API keys</span> above,
          with what each one unlocks and a check that it works.
        </p>

        <div className="flex items-center gap-2 pt-1">
          <GhostButton
            onClick={() => {
              void window.krypt.market.clearCache().then((r) => {
                if (r.ok) toast.success(r.message);
                term.refreshNow();
              });
            }}
          >
            Clear market cache
          </GhostButton>
          <span className="text-label text-krypt-muted/55">
            Drops every cached response so the next refresh is a fresh fetch.
          </span>
        </div>
      </Card>
    </Section>
  );
}
