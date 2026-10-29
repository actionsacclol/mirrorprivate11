// Settings → API keys (2026-10-25): every key the app can use, in one place.
//
// The keys were scattered — Helius under Solana RPC, Birdeye and Jupiter at
// the bottom of Market data, the GIF keys under them, the Alchemy key under
// EVM chains — and the user asked to "manage helius api key n all". This is
// the one home: each key with whether it is set, what it unlocks, what it
// costs, where to get one, and a check that the saved key works. Setup is a
// page with every control on it, not a pop-up (user rule, 2026-10-24).
//
// A key is shown by its last four characters only, is pasted into a password
// field, and never reaches a toast, a log line or a URL. settingsValidation
// refuses any key with whitespace in it at the boundary; the save here says
// so before that happens.

import { useState, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, MinusCircle } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { DEFAULT_BACKTEST_CREDITS } from '@shared/credits';
import { Card, GhostButton, PrimaryButton, Section } from '../common';
import { CreditMeter } from './CreditMeter';
import { RpcKeyWarning } from './RpcKeyWarning';
import { useTerminal } from '../../state/TerminalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';

/** A bare key or a whole pasted Helius URL — the key either way. */
export function extractHeliusKey(raw: string): string {
  const v = raw.trim();
  const m = v.match(/api-key=([A-Za-z0-9-]+)/);
  return m ? m[1] : v;
}

/** Why a pasted key cannot be saved, or null. The same rules the settings
 *  boundary enforces (settingsValidation: no whitespace, at most 400 chars),
 *  said here where they can still be fixed. */
export function keyProblem(key: string, name: string): string | null {
  if (!key) return `Paste the ${name} key first`;
  if (/\s/.test(key)) return `The ${name} key has a space or a line break in it — paste the key alone`;
  if (key.length < 8) return `That is too short to be a ${name} key`;
  if (key.length > 400) return `That is too long to be a ${name} key`;
  return null;
}

const HELIUS_KEY_RE = /^[A-Za-z0-9-]{8,}$/;

function KeyRow({
  title,
  tag,
  tagTone = 'muted',
  name,
  value,
  unlocks,
  cost,
  link,
  placeholder,
  normalise = (v: string) => v.trim(),
  problem = (k: string) => keyProblem(k, name),
  onSave,
  onCheck,
  status,
  children,
  testId,
}: {
  title: string;
  tag?: string;
  tagTone?: 'accent' | 'muted';
  /** In sentences: "the Helius key". */
  name: string;
  value: string;
  unlocks: ReactNode;
  cost?: string;
  link: { label: string; url: string };
  placeholder: string;
  normalise?: (raw: string) => string;
  problem?: (key: string) => string | null;
  onSave: (key: string) => Promise<void>;
  /** Checks the SAVED key, so Save comes first. */
  onCheck?: () => Promise<{ ok: boolean; message: string }>;
  /** A live line under the text: the host in use, the provider's errors. */
  status?: ReactNode;
  children?: ReactNode;
  testId: string;
}) {
  const toast = useToast();
  const set = value.length > 0;
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; message: string } | null>(null);

  const save = async (): Promise<void> => {
    const key = normalise(draft);
    const why = problem(key);
    if (why) return void toast.error(why);
    await onSave(key);
    setDraft('');
    setEditing(false);
    setChecked(null);
    toast.success(`${title} key saved`);
  };
  const remove = async (): Promise<void> => {
    await onSave('');
    setChecked(null);
    toast.info(`${title} key removed`);
  };
  const check = async (): Promise<void> => {
    if (!onCheck) return;
    setChecking(true);
    try {
      setChecked(await onCheck());
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-4" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        {set ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <MinusCircle className="h-4 w-4 text-krypt-muted/50" />}
        <span className="text-value font-semibold text-white">{title}</span>
        {tag && (
          <span
            className={cls(
              'rounded border px-1.5 text-micro font-bold',
              tagTone === 'accent' ? 'border-krypt-purple/40 bg-krypt-purple/15 text-krypt-purple' : 'border-white/15 bg-white/5 text-krypt-muted',
            )}
          >
            {tag}
          </span>
        )}
        <span className="ml-auto font-mono text-label text-krypt-muted" data-testid={`${testId}-state`}>
          {set ? `set · ends …${value.slice(-4)}` : 'not set'}
        </span>
      </div>
      <p className="mt-1.5 text-body leading-relaxed text-krypt-muted">{unlocks}</p>
      {cost && <p className="mt-1 text-label leading-relaxed text-krypt-muted/70">{cost}</p>}
      {status}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!set || editing ? (
          <>
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="min-w-[260px] flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
              data-testid={`${testId}-input`}
            />
            <PrimaryButton onClick={() => void save()} disabled={!draft.trim()} className="!py-2 !px-3 text-xs">
              Save
            </PrimaryButton>
            {set && (
              <GhostButton
                onClick={() => {
                  setEditing(false);
                  setDraft('');
                }}
              >
                Cancel
              </GhostButton>
            )}
          </>
        ) : (
          <>
            <GhostButton onClick={() => setEditing(true)}>Replace</GhostButton>
            <GhostButton onClick={() => void remove()} destructive>
              Remove
            </GhostButton>
            {onCheck && (
              <GhostButton onClick={() => void check()} disabled={checking}>
                {checking ? 'Checking…' : 'Check the key'}
              </GhostButton>
            )}
          </>
        )}
        <button
          onClick={() => void window.krypt.app.openExternal(link.url)}
          className="ml-auto inline-flex items-center gap-1 text-body font-semibold text-krypt-purple transition-colors hover:text-white"
        >
          {link.label} <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      {checked && (
        <p className={cls('mt-2 text-body', checked.ok ? 'text-emerald-300' : 'text-rose-300')} data-testid={`${testId}-check`}>
          {checked.message}
        </p>
      )}
      {children}
    </div>
  );
}

export function ApiKeysSection({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const term = useTerminal();
  const jup = term.providers.find((p) => p.id === 'jupiter');
  const be = term.providers.find((p) => p.id === 'birdeye');
  const helius = (settings.rpc.heliusApiKey ?? '').trim();
  const alchemy = (settings.evm.robinhood.apiKey ?? '').trim();

  const saveData = async (patch: Partial<AppSettings['data']>): Promise<void> => {
    await updateSettings({ data: { ...settings.data, ...patch } });
    await term.refreshProviders();
  };

  // The saved Helius key, through the same probe the RPC card runs: the
  // endpoints the key resolves to, five round trips each.
  const checkHelius = async (): Promise<{ ok: boolean; message: string }> => {
    const r = await window.krypt.rpc.probe();
    if (!r.ok) return { ok: false, message: r.message };
    const rows = (r.data ?? []).filter((x) => /helius/i.test(x.host));
    if (!rows.length) return { ok: false, message: 'No Helius endpoint is in use — an execution endpoint of your own wins over the key, or the key is empty' };
    const bad = rows.find((x) => !x.ok);
    if (bad) return { ok: false, message: `${bad.host} did not answer${bad.message && bad.message !== 'ok' ? `: ${bad.message}` : ''}` };
    const best = rows.reduce((a, b) => ((a.medianMs ?? Infinity) <= (b.medianMs ?? Infinity) ? a : b));
    return { ok: true, message: `Helius answered in ${best.medianMs ?? '—'} ms (median of five)${best.servesTokenAccounts === false ? ' — but refuses holder and balance reads' : ''}` };
  };
  const checkProvider = async (id: 'jupiter' | 'birdeye'): Promise<{ ok: boolean; message: string }> => {
    const r = await window.krypt.market.testKey(id);
    if (!r.ok || !r.data) return { ok: false, message: r.message };
    void term.refreshProviders();
    return { ok: r.data.ok, message: r.data.message };
  };

  return (
    <Section
      title="API keys"
      description="Every key the app can use, what each one unlocks, and whether it is set. None is needed to start. Helius and Jupiter are free and worth having; the rest are optional."
    >
      <Card className="space-y-3">
        <KeyRow
          testId="apikey-helius"
          title="Helius"
          tag="recommended · free plan"
          tagTone="accent"
          name="Helius"
          value={helius}
          placeholder="Paste the key, or the whole https://…?api-key=… URL"
          normalise={extractHeliusKey}
          problem={(k) => keyProblem(k, 'Helius') ?? (HELIUS_KEY_RE.test(k) ? null : 'That does not look like a Helius API key — paste the key from your dashboard')}
          link={{ label: 'Get a free key at helius.dev', url: 'https://dashboard.helius.dev' }}
          unlocks={
            <>
              Used where it matters: live trade simulation, sending, confirmation and send-time fee estimates; the holder and token-account reads the
              public RPC refuses with HTTP 429; Parsed Streams for followed wallets (about 120 ms ahead of the standard feed); reading a wallet&rsquo;s last
              30 days from the chain in seconds; and the chain-priced copy replays and board checks, inside the backtest allowance below. Launch
              scanning and plain account reads stay on the free public endpoints, which measured as fast for that work.
            </>
          }
          cost="Free plan: 1,000,000 credits a month and about ten requests a second. The app paces itself under that and counts every credit below; the feed socket switches itself off at the ceiling you set."
          onSave={async (key) => {
            await updateSettings({ rpc: { ...settings.rpc, heliusApiKey: key } });
          }}
          onCheck={checkHelius}
        >
          <RpcKeyWarning />
          <div className="mt-3">
            <CreditMeter
              limit={settings.rpc.heliusMonthlyCredits ?? 0}
              onLimit={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusMonthlyCredits: v } })}
              backtest={settings.rpc.heliusBacktestCredits ?? DEFAULT_BACKTEST_CREDITS}
              onBacktest={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusBacktestCredits: v } })}
            />
          </div>
          <p className="text-label leading-relaxed text-krypt-muted/70">
            The feed switches that spend credits — the Helius feed socket, Parsed Streams, Helius only — are under Solana RPC below.
          </p>
        </KeyRow>

        <KeyRow
          testId="apikey-jupiter"
          title="Jupiter"
          tag="recommended · free"
          tagTone="accent"
          name="Jupiter"
          value={settings.data.jupiterApiKey ?? ''}
          placeholder="Jupiter API key from portal.jup.ag"
          link={{ label: 'Get a free key at portal.jup.ag', url: 'https://portal.jup.ag' }}
          unlocks={
            <>
              No new data — every price and swap quote is keyless today. What the key buys is the <span className="text-white/80">host</span>: without one
              the app uses <span className="font-mono">lite-api.jup.ag</span>, Jupiter&rsquo;s most-called host here and the one it is throttling &ldquo;until it is
              fully retired&rdquo; (this app has measured its 429s). A key moves every Jupiter call, buy and sell quotes included, to{' '}
              <span className="font-mono">api.jup.ag</span>.
            </>
          }
          cost="Free. api.jup.ag publishes 1 request a second for a free key; the app slows Jupiter to match, so bursts take longer and the endpoint does not disappear underneath you."
          onSave={(key) => saveData({ jupiterApiKey: key })}
          onCheck={() => checkProvider('jupiter')}
          status={
            jup ? (
              <p className="mt-1 font-mono text-label text-krypt-muted" data-testid="apikey-jupiter-host">
                host in use: <span className={jup.host === 'api.jup.ag' ? 'text-emerald-300' : 'text-arc-gold'}>{jup.host}</span>
                {jup.host !== 'api.jup.ag' ? ' (retiring)' : ''}
                {jup.calls > 0 ? ` · ${jup.calls} calls, ${jup.errors} errors this session` : ''}
              </p>
            ) : null
          }
        />

        <KeyRow
          testId="apikey-birdeye"
          title="Birdeye"
          tag="optional"
          name="Birdeye"
          value={settings.data.birdeyeApiKey ?? ''}
          placeholder="Birdeye API key from bds.birdeye.so"
          link={{ label: 'Get a key at bds.birdeye.so', url: 'https://bds.birdeye.so' }}
          unlocks={
            <>
              Only what the keyless providers cannot give: 1 s, 15 s and 30 s candles for coins the engine is not taping (the keyless chart floor is one
              minute); a full holder list with owners and shares for any coin; and historical trades and top-trader results for coins that launched before
              this install was running. Everything else in the app works without it.
            </>
          }
          cost="The Standard plan is free: 1 request a second per account and a monthly compute allowance. When the allowance is spent the provider says so and the app pauses it rather than retrying."
          onSave={(key) => saveData({ birdeyeApiKey: key, providers: { ...settings.data.providers, birdeye: key.length > 0 } })}
          onCheck={() => checkProvider('birdeye')}
          status={
            be && be.enabled && be.calls > 0 ? (
              <p className="mt-1 font-mono text-label text-krypt-muted">
                {be.calls} calls, <span className={be.errors > 0 ? 'text-rose-400/80' : undefined}>{be.errors} errors</span> this session
                {be.cooldownIsQuota ? <span className="text-arc-gold"> · no allowance left</span> : ''}
                {be.lastError ? <span className="text-rose-400/70"> · {be.lastError}</span> : ''}
              </p>
            ) : null
          }
        />

        <div className="grid gap-3 lg:grid-cols-2">
          <KeyRow
            testId="apikey-giphy"
            title="GIPHY"
            tag="optional"
            name="GIPHY"
            value={settings.data.giphyApiKey ?? ''}
            placeholder="GIPHY API key"
            link={{ label: 'developers.giphy.com', url: 'https://developers.giphy.com' }}
            unlocks="Only for searching a GIF for the background of a share card or a trade replay. Without a key that search is not offered; a chosen GIF is baked into the image once, so the finished card is not linked to anyone's server."
            onSave={(key) => saveData({ giphyApiKey: key })}
          />
          <KeyRow
            testId="apikey-tenor"
            title="Tenor"
            tag="optional"
            name="Tenor"
            value={settings.data.tenorApiKey ?? ''}
            placeholder="Tenor API key"
            link={{ label: 'tenor.com/developer', url: 'https://tenor.com/developer/dashboard' }}
            unlocks="The other GIF search, same use. Either key is enough; both are given away free."
            onSave={(key) => saveData({ tenorApiKey: key })}
          />
        </div>

        <div className="rounded-lg border border-white/10 bg-black/20 p-4" data-testid="apikey-evm">
          <div className="flex flex-wrap items-center gap-2">
            {alchemy ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <MinusCircle className="h-4 w-4 text-krypt-muted/50" />}
            <span className="text-value font-semibold text-white">Robinhood Chain (Alchemy)</span>
            <span className="rounded border border-white/15 bg-white/5 px-1.5 text-micro font-bold text-krypt-muted">optional</span>
            <span className="ml-auto font-mono text-label text-krypt-muted">{alchemy ? `set · ends …${alchemy.slice(-4)}` : 'not set'}</span>
          </div>
          <p className="mt-1.5 text-body leading-relaxed text-krypt-muted">
            A free Alchemy key gives Robinhood Chain its own endpoint instead of the public one. It is set under <span className="text-white/80">EVM chains</span>{' '}
            below, beside that chain&rsquo;s RPC URL, because the two decide the endpoint together. BNB needs no key: its public endpoints are generous, and a
            URL of your own goes in the same place.
          </p>
        </div>

        <p className="text-label leading-relaxed text-krypt-muted/70">
          Keys stay in this computer&rsquo;s settings file. Each one travels only to its own provider, in a request header, never in a URL. They are removed
          from the log, from recordings and from exported diagnostics, and there is no Krypt server to send them to. A key with a space or a line break in it
          is refused when saved.
        </p>
      </Card>
    </Section>
  );
}
