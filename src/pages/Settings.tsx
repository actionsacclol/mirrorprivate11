import { useEffect, useState } from 'react';
import type { ProbeResult as RpcProbeResult } from '../../electron/engine/rpcProbe';
import { Card, Copyable, GhostButton, Page, PrimaryButton, Section, Switch, TextInput } from '../components/common';
import { MarketDataSettings } from '../components/terminal/MarketDataSettings';
import { ApiKeysSection } from '../components/terminal/ApiKeysSection';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { EvmSettingsCard } from '../components/terminal/EvmSettingsCard';
import { feePctLabel, feesEnabled, referralPctLabel, referralProblem, TREASURY_ADDRESS } from '@shared/fees';
import { LanguagePicker } from '../components/LanguagePicker';
import { APPEARANCES, setAppearance, useAppearance } from '../state/appearance';
import { Segmented } from '../ui/kit';
import { useLocale } from '../state/useLocale';
import { HeliusOnlyFeedSwitch } from '../components/HeliusOnlyFeedSwitch';

export function SettingsPage() {
  const { t } = useLocale();
  const { settings, updateSettings, status } = useAppState();
  const toast = useToast();
  const [wss, setWss] = useState(settings.rpc.wssUrl);
  const [extraWss, setExtraWss] = useState((settings.rpc.extraWssUrls ?? []).join('\n'));
  const [http, setHttp] = useState(settings.rpc.httpUrl);
  const [fastHttp, setFastHttp] = useState(settings.rpc.fastHttpUrl ?? '');
  const [commitment, setCommitment] = useState(settings.rpc.commitment);
  // Your own addresses, so naming yourself as your referrer is caught HERE,
  // where you can still fix it — the signer refuses a self-referral and says
  // nothing. The active signer is also what you hand out to be someone
  // else's referrer: there is no account, so an address is the whole identity.
  const [myAddresses, setMyAddresses] = useState<string[]>([]);
  const [myActive, setMyActive] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.krypt.wallet.list().then((r) => {
      if (!alive || !r.ok || !r.data) return;
      setMyAddresses(r.data.map((w) => w.publicKey));
      setMyActive(r.data.find((w) => w.active)?.publicKey ?? null);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    setWss(settings.rpc.wssUrl);
    setExtraWss((settings.rpc.extraWssUrls ?? []).join('\n'));
    setHttp(settings.rpc.httpUrl);
    setFastHttp(settings.rpc.fastHttpUrl ?? '');
    setCommitment(settings.rpc.commitment);
  }, [settings.rpc]);

  const saveRpc = (): void => {
    if (!wss.startsWith('wss://') && !wss.startsWith('ws://')) {
      toast.error('WebSocket URL must start with wss://');
      return;
    }
    const extras = extraWss
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const badExtra = extras.find((l) => !l.startsWith('wss://') && !l.startsWith('ws://'));
    if (badExtra) {
      toast.error(`Extra endpoint must start with wss:// — "${badExtra.slice(0, 40)}"`);
      return;
    }
    if (!http.startsWith('https://') && !http.startsWith('http://')) {
      toast.error('HTTP URL must start with https://');
      return;
    }
    // https only, and main checks the same thing: this one carries every live
    // buy and sell, so an http:// paste that fell back to the public endpoint
    // would be a speed setting doing the opposite of what it says.
    const fast = fastHttp.trim();
    if (fast && !fast.startsWith('https://')) {
      toast.error('The execution endpoint must start with https://');
      return;
    }
    void updateSettings({
      rpc: {
        // Preserve fields this form does not edit (the Helius key, which
        // lives under API keys; block-feed standby etc.); a full literal
        // here silently reset them on every save.
        ...settings.rpc,
        wssUrl: wss.trim(),
        extraWssUrls: extras,
        heliusFeedSocket: settings.rpc.heliusFeedSocket ?? false,
        heliusMonthlyCredits: settings.rpc.heliusMonthlyCredits ?? 1_000_000,
        httpUrl: http.trim(),
        fastHttpUrl: fast,
        commitment,
      },
    });
  };

  return (
    <Page title={t('settings.title')} subtitle={t('settings.subtitle')}>
      {/* First, and above the data providers: someone who cannot read the
          page cannot use anything below it. */}
      <Section
        title={t('lang.title')}
        description="Menus, buttons, settings and the first-run walkthrough. Legal documents and anything describing your money stay in English, which is the version that governs."
      >
        <Card>
          <LanguagePicker />
        </Card>
      </Section>

      {/* Beside Language, because both answer "how does this app read to
          me" - and because buried under Display nobody found it. */}
      <Section title="Appearance" description="Dark, light, or whatever your computer is set to. Kept on this computer only.">
        <Card>
          <AppearancePicker />
        </Card>
      </Section>

      {/* Every key in one place (2026-10-25), ahead of the sections that
          spend them. */}
      <ApiKeysSection settings={settings} updateSettings={updateSettings} />

      {/* The walkthrough, on demand. It resets NOTHING - it only clears the
          'you have seen this' bit, so the screens come back. */}
      <Section title={t('settings.replay')} description={t('settings.replayHint')}>
        <Card>
          <GhostButton onClick={() => void updateSettings({ onboarded: false })}>
            {t('settings.replay')}
          </GhostButton>
        </Card>
      </Section>
      <MarketDataSettings settings={settings} updateSettings={updateSettings} />
      <Section
        title={t('settings.solanaRpc')}
        description="Works out of the box on free public endpoints. A free Helius key (under API keys above) upgrades the calls that decide real trades; the feed itself races multiple free sockets."
      >
        <Card className="space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">Helius feed</div>
            <div className="text-body text-krypt-muted/70 mb-2">
              The key itself, its credit meter and the backtest allowance are under <span className="text-white/80">API keys</span> above
              {(settings.rpc.heliusApiKey ?? '').trim() ? ' — a key is set.' : ' — no key is set, so these switches have nothing to run on.'} These decide what
              the feed spends it on.
            </div>
            <div>
              <Switch
                checked={settings.rpc.heliusFeedSocket ?? false}
                onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusFeedSocket: v } })}
                label="Helius feed socket"
                description="Adds the Helius websocket to the racing pool. MEASURED over 45s on the pump firehose: Helius delivered 92% of events FIRST, with the free sockets a median 150ms (mainnet-beta) and 578ms (publicnode) behind — decisive for sniping. It also costs ~800k credits/day at firehose rates, so it is a paid-plan switch, not a free-tier one."
              />
              <div className="mt-2">
                <Switch
                  checked={settings.rpc.heliusParsedFeed !== false}
                  onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusParsedFeed: v } })}
                  label="Watch followed wallets on Parsed Streams"
                  description="Copy trading hears a followed wallet's trades through Helius Parsed Streams. Measured on the 20 busiest Scout wallets, it delivered every trade about 120 ms before the standard feed, and a plain pump buy arrives already decoded, so no read-back is needed. Sells are still read back. Free on every Helius plan; 1 credit per transaction a followed wallet makes, counted in the meter above. Falls back to the standard feed by itself if Helius refuses it."
                />
              </div>
              <div className="mt-2">
                <HeliusOnlyFeedSwitch />
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">WebSocket (launch feed)</div>
            <TextInput value={wss} onChange={setWss} placeholder="wss://api.mainnet-beta.solana.com" />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">
              Extra WebSocket endpoints (raced in parallel, one per line)
            </div>
            <textarea
              value={extraWss}
              onChange={(e) => setExtraWss(e.target.value)}
              placeholder={'wss://solana-rpc.publicnode.com'}
              spellCheck={false}
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60 resize-y"
            />
            <div className="text-body text-krypt-muted/70 mt-1">
              All sockets subscribe at once; duplicates are dropped, first arrival wins. A single public socket
              silently loses ~20% of events under load — every extra free endpoint cuts that loss.
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">HTTP (account lookups)</div>
            <TextInput value={http} onChange={setHttp} placeholder="https://api.mainnet-beta.solana.com" />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">
              Execution endpoint <span className="text-krypt-muted/50 normal-case tracking-normal">— optional, any provider</span>
            </div>
            <TextInput value={fastHttp} onChange={setFastHttp} placeholder="https://your-endpoint.example.com/?api-key=…" />
            <div className="text-body text-krypt-muted/70 mt-1">
              The same fast lane a Helius key buys, for a provider of your own — QuickNode, Triton, Shyft, your
              own validator. Live buys, sells, confirmations, send-time fee estimates and template sampling go
              here; mint checks, balances and holder reads stay on the HTTP endpoint above, so you are not
              paying for the bulk traffic. Set, it wins over the Helius key. Empty, nothing changes.
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">Commitment</span>
              {(['processed', 'confirmed'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setCommitment(c)}
                  className={
                    commitment === c
                      ? 'rounded-lg border border-krypt-purple/50 bg-krypt-purple/15 px-3 py-1.5 text-xs font-semibold text-white'
                      : 'rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-krypt-muted hover:text-white'
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            <PrimaryButton onClick={saveRpc}>Save RPC settings</PrimaryButton>
          </div>

          <EndpointProbe />

          {/* ── the standby block feed ────────────────────────────────────
              It has been on by default since it was built and had no control
              anywhere in the app — `grep blockFeed src/` found nothing. It is
              the single largest thing this app downloads, and a user on a
              metered connection could not find it, let alone turn it off.
              The DEFAULT is unchanged; what changes is that it is now
              visible and switchable. */}
          <div className="space-y-1.5 border-t border-white/5 pt-3">
            <Switch
              checked={settings.rpc.blockFeed ?? true}
              onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, blockFeed: v } })}
              label="Standby block feed"
              description={`Whole blocks over blockSubscribe, decoded from inner instructions. It loses every race while pump still emits log events and exists to take over the day those go quiet — measured 2026-09-09 at ~5.5 GB/h while scanning (~${(5.5 * 24).toFixed(0)} GB/day). Turn it off on a metered connection; nothing you do today depends on it.`}
            />
            {(settings.rpc.blockFeed ?? true) && (
              <div className="flex items-center gap-2 text-xs text-amber-300">
                <span>⚠</span> ~5.5 GB/h while the scanner runs. This is the largest thing the app downloads.
              </div>
            )}
            <Switch
              checked={settings.rpc.blockFeedAmm ?? false}
              onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, blockFeedAmm: v } })}
              label="Standby block feed — post-graduation (pAMM)"
              description="The same standby for graduated tokens. Off by default because the host ignores a program filter there, so it pulls ~11 GB/h. Unmetered connections only."
            />
          </div>
          {status.running && (
            <div className="space-y-1.5 border-t border-white/5 pt-3">
              <p className="text-xs text-amber-300">Engine is running — RPC changes apply on next start.</p>
              <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">Feed pool health</div>
              {status.feedSockets.map((s) => (
                <div key={s.url} className="flex items-center justify-between text-xs font-mono">
                  <span className="text-white/80">{s.host}</span>
                  <span
                    className={
                      s.state === 'live' ? 'text-emerald-300' : s.state === 'stopped' ? 'text-krypt-muted' : 'text-amber-300'
                    }
                  >
                    {s.state} · {s.events} events · {s.wins} first
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-white/80">estimated event loss (15m)</span>
                <span
                  className={
                    status.feedLossPct === null
                      ? 'text-krypt-muted'
                      : status.feedLossPct > 5
                        ? 'text-red-400'
                        : status.feedLossPct > 2
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                  }
                >
                  {status.feedLossPct === null ? 'measuring…' : `~${status.feedLossPct}%`}
                </span>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section title={t('settings.feesAndReferral')} description="What Krypt charges for a copy, and who gets credit for bringing you here.">
        <Card>
          <p className="text-body leading-relaxed text-krypt-muted">
            {feesEnabled() ? (
              <>
                Krypt takes <span className="text-white">{feePctLabel()} of each buy and each sell</span> — every copy,
                every exit, every chain, the same for everyone. It is charged in the same transaction as the trade itself.
                The launchpad&apos;s own fee (about 1% per side on pump.fun), network fees and tips are separate and do not
                come to Krypt.
              </>
            ) : (
              <>This build has no fee address configured, so Krypt charges nothing on your trades.</>
            )}
          </p>
          {feesEnabled() && (
            <div className="mt-4 rounded-lg border border-arc-gold/25 bg-arc-gold/5 p-3">
              <div className="text-value font-semibold text-white">Refer someone else</div>
              <p className="mt-1 text-body leading-relaxed text-krypt-muted">
                Give them the address below. When they paste it into this same box, you earn{' '}
                <span className="font-semibold text-arc-gold">{referralPctLabel()} of every trade they make</span>, paid
                straight to your wallet in the same transaction as their trade. It comes out of Krypt&apos;s fee, so it
                never costs them anything extra. There is no sign-up and no account — the address is the whole thing.
              </p>
              {myActive ? (
                <div className="mt-2">
                  <Copyable value={myActive} label="your referral address" />
                </div>
              ) : (
                <p className="mt-2 text-body text-krypt-muted">Make a wallet first — it becomes your referral address.</p>
              )}
              <p className="mt-2 text-label text-krypt-muted/70">
                On Robinhood Chain and BNB it is your EVM address instead, under EVM chains below.
              </p>
            </div>
          )}
          <label className="mt-4 block text-body text-krypt-muted">
            Referrer&apos;s SOL address — whoever sent you here is rewarded automatically as you trade, out of
            Krypt&apos;s share, never as an extra cost to you.
          </label>
          <input
            value={settings.referrer ?? ''}
            onChange={(e) => void updateSettings({ referrer: e.target.value })}
            spellCheck={false}
            placeholder="Nobody referred you"
            className="mt-1.5 w-full rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-body text-white outline-none focus:border-krypt-purple/60"
          />
          {(() => {
            const why = referralProblem(settings.referrer ?? '', { ownAddresses: myAddresses, treasury: TREASURY_ADDRESS });
            // An address the signer will not use is stored happily and pays
            // nobody, which looks identical to a working referral from here.
            return why ? (
              <p className="mt-1.5 text-body text-rose-300">
                {why} <span className="text-krypt-muted">Until it is fixed, nobody is credited on your trades.</span>
              </p>
            ) : null;
          })()}
        </Card>
      </Section>

      <EvmSettingsCard settings={settings} updateSettings={updateSettings} />
      <Section title={t('settings.general')}>
        <div className="grid lg:grid-cols-2 gap-3">
          <Switch
            checked={settings.alerts.desktopNotifications}
            onChange={(v) => void updateSettings({ alerts: { ...settings.alerts, desktopNotifications: v } })}
            label="Desktop notifications"
            description="Windows pop-ups for runner flags, price alerts, scripts and fills. Off stops only the pop-ups: runner flags, scripts and the in-app list keep working."
          />
        </div>
      </Section>

      <Section title={t('settings.display')} description="For a slow machine, or one whose graphics driver does not like the app: stutter, a blue screen mid-session, or a driver that keeps crashing.">
        <div className="grid lg:grid-cols-2 gap-3">
          <Switch
            checked={settings.reduceEffects}
            onChange={(v) => void updateSettings({ reduceEffects: v })}
            label="Lite mode (reduce effects)"
            description="Turns off every animation and transition — the app at its lightest, for a slow machine. Applies at once."
          />
          <Switch
            checked={settings.hardwareAcceleration}
            onChange={(v) => void updateSettings({ hardwareAcceleration: v })}
            label="Hardware acceleration"
            description="Render through the GPU. Turn it off if the graphics driver has crashed under the app or a blue screen followed a session: software rendering is slower but never touches the driver. Turns itself off after the GPU process dies twice in one run. Applies on restart."
          />
        </div>
      </Section>

      <Section
        title="Logs"
        description="If something goes wrong, this puts the app’s log and what it was doing into one file you can attach when you ask for help. Nothing is sent anywhere — the app has no telemetry, and this only writes a file where you choose."
      >
        <LogsPanel />
      </Section>

    </Page>
  );
}

/**
 * Logs, and the one button that makes them sendable.
 *
 * The app already wrote a good log; what it had no answer for was "how do I
 * give it to you". The old answer was a path and an instruction to find
 * app.log yourself, which asks a user to know which of two files matters and
 * what is inside them. This builds one file and says what is in it BEFORE it
 * is written — the size is shown up front, because a 6 MB attachment is a
 * different decision from a 40 KB one.
 */
function LogsPanel() {
  const toast = useToast();
  const [paths, setPaths] = useState<{ logs: string | null; crashes: string | null } | null>(null);
  const [size, setSize] = useState<{ bytes: number; truncatedBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // The user's own description, printed first in the file (2026-09-23). Kept
  // only in this panel until a button is pressed.
  const [note, setNote] = useState('');

  useEffect(() => {
    void window.krypt.app.logPaths().then((r) => {
      if (r.ok && r.data) setPaths(r.data);
    });
    // Built once so the button can say how big it will be. It is a read of
    // files the app already owns, so it costs nothing the user pays for.
    void window.krypt.app.logsPreview().then((r) => {
      if (r.ok && r.data) setSize({ bytes: r.data.bytes, truncatedBytes: r.data.truncatedBytes });
    });
  }, []);

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else if (r.message !== 'Save cancelled') toast.error(r.message);
    } finally {
      setBusy(false);
    }
  };

  const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

  return (
    <Card className="space-y-3">
      <label className="block space-y-1">
        <span className="text-label text-krypt-muted">
          What went wrong? <span className="text-krypt-muted/60">· optional, goes at the top of the file</span>
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 4000))}
          rows={3}
          placeholder="What you did, what you expected, what happened instead — and roughly what time."
          className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-body text-white placeholder:text-krypt-muted/50 outline-none focus:border-krypt-purple/60"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <PrimaryButton onClick={() => void run(() => window.krypt.app.logsExport(note))} disabled={busy} className="!py-2.5 !px-4 text-xs">
          Save logs to a file{size ? ` (${kb(size.bytes)})` : ''}
        </PrimaryButton>
        <GhostButton onClick={() => void run(() => window.krypt.app.logsCopy(note))} disabled={busy}>
          Copy to clipboard
        </GhostButton>
        <GhostButton onClick={() => void window.krypt.app.openLogs()} disabled={busy}>
          Open the logs folder
        </GhostButton>
      </div>

      <div className="space-y-1 text-label leading-relaxed text-krypt-muted">
        <p>
          <span className="text-white/80">Where to send it:</span> attach the file in our{' '}
          <button
            onClick={() => void window.krypt.app.openExternal('https://discord.gg/muzFKR657F')}
            className="text-krypt-purple underline underline-offset-2 hover:text-white"
          >
            Discord
          </button>
          . The newest warnings and errors are summed up near the top, so it can be read quickly.
        </p>
        <p>
          <span className="text-white/80">What goes in:</span> the app’s log, your settings with every key and token removed, which
          features were switched on, how your data providers are doing, and a list of your files by name and size.
        </p>
        <p>
          <span className="text-white/80">What does not:</span> your private key, your seed, any API key, your balances, your holdings
          and your trade history.
        </p>
        <p>
          The log does name coins you looked at and trades you made — the same things the app shows on screen. Open the file and read it
          before you send it if that matters to you.
        </p>
        {size && size.truncatedBytes > 0 && (
          <p className="text-amber-300">
            The log is longer than one file can hold, so the oldest {kb(size.truncatedBytes)} is cut and the newest part kept — which is
            the part that explains what just happened.
          </p>
        )}
      </div>

      {paths?.logs && (
        <p className="break-all font-mono text-nano text-krypt-muted/70">
          {paths.logs}
          {paths.crashes ? ` · crashes: ${paths.crashes}` : ''}
        </p>
      )}
    </Card>
  );
}

function EndpointProbe() {
  const toast = useToast();
  const [rows, setRows] = useState<RpcProbeResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.rpc.probe();
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    setRows(r.data ?? []);
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">Endpoint speed</div>
          <div className="text-body text-krypt-muted/70 mt-0.5">
            Five round trips to each endpoint you have configured, saved settings only. The median is what an
            order meets; the slot says whether a fast answer is a fresh one.
          </div>
        </div>
        <GhostButton onClick={() => void run()} disabled={busy} className="!py-1.5 !px-3 text-xs flex-shrink-0">
          {busy ? 'Measuring…' : 'Measure'}
        </GhostButton>
      </div>
      {rows && rows.length > 0 && (
        <div className="mt-3 space-y-2">
          {rows.map((r) => (
            <div key={`${r.label}:${r.host}`} className="font-mono text-body">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-white/85 truncate">{r.label}</span>
                <span className={r.ok ? 'text-white' : 'text-rose-300'}>
                  {/* Honest null: an endpoint that did not answer has no time,
                      and a 0 there would read as instant. */}
                  {r.medianMs === null ? '—' : `${r.medianMs} ms`}
                  {r.bestMs !== null && r.bestMs !== r.medianMs ? <span className="text-krypt-muted/60"> (best {r.bestMs})</span> : null}
                </span>
              </div>
              <div className="text-label text-krypt-muted/60 truncate">
                {r.host}
                {r.behindSlots !== null && r.behindSlots > 1 ? ` · ${r.behindSlots} slots behind the freshest` : ''}
                {r.servesTokenAccounts === false ? ' · refuses holder and balance reads' : ''}
                {r.message && r.message !== 'ok' ? ` · ${r.message}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AppearancePicker() {
  const a = useAppearance();
  const label = { system: 'Match my computer', dark: 'Dark', light: 'Light' } as const;
  return <Segmented value={a} onChange={setAppearance} options={APPEARANCES.map((x) => ({ value: x, label: label[x] }))} testId="appearance" />;
}
