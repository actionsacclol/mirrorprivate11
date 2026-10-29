// Wallet › pump.fun (2026-10-22) — accounts, automatic callouts on copies,
// and the rewards they earn.
//
// Ported from Krypto Bot's pump.fun accounts page, Auto-callout page and
// callout-rewards panel, put on one tab. A pump.fun account IS a wallet:
// signing in with a new address makes the account, and every account made or
// signed in here is referred by Krypt (code "kryptcc") — mandatory, and said
// on this screen, in the terms and in the privacy policy.
//
// What changes in Krypto Mirror is WHEN a callout goes out: on a live copy's
// confirmed buy (engine.calloutAfterCopy), from the account of the wallet that
// bought, at most once every 15 minutes per account, and only while the copy
// still holds. Paper copies post nothing.

import { useEffect, useMemo, useState } from 'react';
import { Coins, Megaphone, Plus, RotateCcw, Users } from 'lucide-react';
import {
  CALLOUT_VARS,
  CALLOUT_WATERMARKS,
  COPY_CALLOUT_DELAY_MS,
  COPY_CALLOUT_GAP_MS,
  DEFAULT_COPY_CALLOUT_LINES,
  linesCarryingMark,
  MIN_CALLOUT_POSITION_USD,
  autoCalloutProblem,
  thesesOf,
  type AutoCalloutSettings,
} from '@shared/calloutAuto';
import { REFERRAL_NOTICE } from '@shared/pumpReferral';
import { sessionForWallet, type PumpAuthStatus } from '@shared/pumpAuth';
import type { WalletSummary } from '@shared/types';
import { NumberInput, Switch } from '../components/common';
import { PumpAccountsSection } from '../components/terminal/PumpAccountsSection';
import { CalloutRewards } from '../components/terminal/CalloutRewards';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { loadPumpStatus } from '../state/pumpStatus';
import { Panel, btn } from '../ui/kit';
import { cls } from '../utils/format';

export function PumpTab() {
  const toast = useToast();
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [status, setStatus] = useState<PumpAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The account list remounts after a bulk sign-in, so it re-reads too.
  const [epoch, setEpoch] = useState(0);

  const loadWallets = (): Promise<WalletSummary[]> =>
    window.krypt.wallet.list().then((r) => {
      const list = r.ok && r.data ? r.data : [];
      setWallets(list);
      return list;
    });
  useEffect(() => {
    void loadWallets();
  }, []);

  /**
   * A new wallet and its pump.fun account in one go (2026-10-28). The wallet
   * is added beside the others — the active one stays active — and its
   * account is made by signing in with it, as for any wallet pump has never
   * seen. If the sign-in fails the wallet is kept and its row offers
   * "Create account" again.
   */
  const makeFresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const g = await window.krypt.wallet.generate();
      if (!g.ok) return void toast.error(g.message);
      const list = await loadWallets();
      // generate() answers with the ACTIVE wallet's info, so the new one is
      // found as the wallet that was not here before.
      const known = new Set(wallets.map((w) => w.id));
      const fresh = list.find((w) => !known.has(w.id));
      if (!fresh) return void toast.error('The wallet was made, but could not be found to sign in with — use Create account on its row.');
      const r = await window.krypt.pump.signIn(fresh.id);
      if (r.ok) toast.success(`${fresh.label} and its pump.fun account are ready. Back the wallet up under Wallet › Solana.`);
      else toast.error(`${fresh.label} was made, but pump.fun did not make its account: ${r.message}`);
      setEpoch((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => loadPumpStatus(setStatus), [epoch]);

  const without = useMemo(() => (status ? wallets.filter((w) => !sessionForWallet(status, w.id)) : []), [wallets, status]);
  const made = wallets.length - without.length;

  const makeAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.pump.signInMany(without.map((w) => w.id));
      if (!r.ok || !r.data) return void toast.error(r.message);
      const ok = r.data.results.filter((x) => x.ok).length;
      const failed = r.data.results.filter((x) => !x.ok);
      if (ok) toast.success(`${ok} pump.fun account${ok === 1 ? '' : 's'} ready`);
      if (failed.length) toast.error(`${failed.length} could not sign in: ${failed[0].message}`);
      setStatus(r.data.status);
      setEpoch((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1240px] space-y-6 px-8 pb-12 pt-5">
        <div className="grid gap-4 md:grid-cols-3">
          <Explainer icon={Users} title="1 · An account per wallet">
            Signing in with a wallet makes its pump.fun account — a signed message, no transaction, nothing spent. The key never leaves this
            computer.
          </Explainer>
          <Explainer icon={Megaphone} title="2 · Copies call themselves out">
            When a live copy buys, its account posts a pump.fun callout on the coin, at most once every {COPY_CALLOUT_GAP_MS / 60_000} minutes per
            account. Paper copies post nothing.
          </Explainer>
          <Explainer icon={Coins} title="3 · pump.fun pays callers">
            pump pays callout rewards in USDC, from the trading volume a call brings. They land in that wallet and are swapped to SOL for you.
          </Explainer>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-card px-5 py-4 shadow-soft">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-white">
              {status === null ? 'Reading your accounts…' : wallets.length === 0 ? 'No wallet yet' : `${made} of ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} have a pump.fun account`}
            </div>
            <p className="mt-0.5 text-body leading-relaxed text-krypt-muted">{REFERRAL_NOTICE}</p>
          </div>
          {without.length > 0 && status?.ready && (
            <button className={btn.primary} disabled={busy} onClick={() => void makeAll()} data-testid="pump-make-all">
              <Users className="h-4 w-4" /> {busy ? 'Signing in…' : `Make ${without.length === 1 ? 'its account' : `all ${without.length} accounts`}`}
            </button>
          )}
          {status?.ready && (
            <button className={without.length > 0 ? btn.secondary : btn.primary} disabled={busy} onClick={() => void makeFresh()} data-testid="pump-new-wallet">
              <Plus className="h-4 w-4" /> New wallet + account
            </button>
          )}
        </div>

        <PumpAccountsSection key={epoch} wallets={wallets} notice={false} />

        <CopyCallouts accounts={made} />

        <CalloutRewards />
      </div>
    </div>
  );
}

function Explainer({ icon: Icon, title, children }: { icon: typeof Users; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/8 bg-card p-4 shadow-soft">
      <div className="flex items-center gap-2 text-note font-semibold text-white">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon className="h-4 w-4" />
        </span>
        {title}
      </div>
      <p className="mt-2 text-body leading-relaxed text-krypt-muted">{children}</p>
    </div>
  );
}

/** The automatic-callout settings, as they apply to copies. */
function CopyCallouts({ accounts }: { accounts: number }) {
  const { settings, updateSettings } = useAppState();
  const toast = useToast();
  const [draft, setDraft] = useState<AutoCalloutSettings>(settings.autoCallout);
  useEffect(() => setDraft(settings.autoCallout), [settings.autoCallout]);
  const lines = thesesOf(draft.text);
  const marked = linesCarryingMark(draft.text);
  const dirty = draft.text !== settings.autoCallout.text || draft.minBuySol !== settings.autoCallout.minBuySol;

  const save = async (next: AutoCalloutSettings): Promise<void> => {
    const why = autoCalloutProblem(next);
    if (why) return void toast.error(why);
    setDraft(next);
    // The whole object, from the draft: a partial write would drop the
    // fields this page does not show (the rebuild-drops-fields trap).
    await updateSettings({ autoCallout: next });
  };

  return (
    <Panel
      title="Automatic callouts on copies"
      subtitle="What a live copy's account says on pump.fun when it buys. Public, under that account's name."
    >
      <div className="space-y-4" data-testid="copy-callouts">
        <Switch
          checked={draft.enabled}
          onChange={(v) => void save({ ...draft, enabled: v })}
          label="Call out the coins my live copies buy"
          description={
            accounts === 0
              ? 'Nothing posts yet — no wallet has a pump.fun account. Make one above.'
              : lines.length === 0
                ? 'Write at least one line below first.'
                : `${lines.length} line${lines.length === 1 ? '' : 's'}, one picked at random per coin and never the same one twice running. Paper copies never post.`
          }
        />
        <Switch
          checked={draft.likeOwn}
          onChange={(v) => void save({ ...draft, likeOwn: v })}
          label="Like your own callouts"
          description="The account that posted a callout likes it straight after."
        />

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-note font-medium text-white">What to say — one line per variant</span>
            <button className={btn.ghost} onClick={() => setDraft({ ...draft, text: DEFAULT_COPY_CALLOUT_LINES })} title="Put Krypto Mirror's lines back">
              <RotateCcw className="h-3.5 w-3.5" /> Default lines
            </button>
          </div>
          <textarea
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            rows={7}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-white/10 bg-raised px-3 py-2 font-mono text-body text-white outline-none focus:border-accent/60"
          />
          {marked.length > 0 && (
            <div className="mt-1.5 text-label text-amber-300/90" data-testid="callout-mark-hint">
              Line{marked.length === 1 ? '' : 's'} {marked.join(', ')} end{marked.length === 1 ? 's' : ''} with the app’s own closing line. Leave it out: the app adds
              one itself at the end of every call, in a different wording each time.
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CALLOUT_VARS.map((v) => (
              <button
                key={v.name}
                title={v.means}
                onClick={() => setDraft({ ...draft, text: `${draft.text}${draft.text.endsWith(' ') || !draft.text ? '' : ' '}{${v.name}}` })}
                className="rounded-md border border-white/10 bg-raised px-2 py-0.5 font-mono text-label text-krypt-muted transition hover:text-white"
              >
                {`{${v.name}}`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body text-krypt-muted">Skip copies under</span>
          <NumberInput value={draft.minBuySol} onChange={(v) => setDraft({ ...draft, minBuySol: v })} min={0} max={100} className="w-24" />
          <span className="text-body text-krypt-muted">SOL</span>
          <div className="flex-1" />
          <button className={cls(btn.primary)} disabled={!dirty} onClick={() => void save(draft)}>
            Save lines
          </button>
        </div>

        <ul className="space-y-1 border-t border-white/8 pt-3 text-body leading-relaxed text-krypt-muted">
          <li>• At most one copy callout per account every {COPY_CALLOUT_GAP_MS / 60_000} minutes — pump has restricted accounts that post like a template.</li>
          <li>
            • Posted {COPY_CALLOUT_DELAY_MS / 1000} s after the buy, and only if the copy still holds: pump shows only callers who hold, and needs the
            position worth at least ${MIN_CALLOUT_POSITION_USD}.
          </li>
          <li>• Only a line whose numbers are known for the coin is used — a call reading “at —” is the kind pump removes.</li>
          <li>
            • Your lines carry no closing line of their own. The app adds one after whichever line it posts — for example “{CALLOUT_WATERMARKS[2]}” —
            in a different wording each time, so readers know a tool posted it and no two calls end alike.
          </li>
        </ul>
      </div>
    </Panel>
  );
}
