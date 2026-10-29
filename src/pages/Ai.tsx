// The AI page (2026-10-28): connect an AI app over MCP, watch what it is
// deciding, and see which follows it decides for. The connection itself is
// the one Krypto Bot shipped (electron/system/mcpServer.ts, shared/mcp.ts —
// its old panel was dropped in the fork); the desk is new: shared/aiDesk.ts,
// electron/engine/aiDesk.ts, docs/ai-desk-2026-10-28.md.

import { useCallback, useEffect, useState } from 'react';
import { Bot, Copy, KeyRound, Pencil, RefreshCw } from 'lucide-react';
import { MCP_ACCESS_LEVELS, MCP_ACCESS_TEXT, MCP_CANNOT_CONNECT, MCP_SERVER_NAME, mcpClientConfigs, type McpAccess, type McpPlatform } from '@shared/mcp';
import { accessDecides, aiStarterPrompt, type AiDecisionLog, type AiDeskStatus, type AiRequest } from '@shared/aiDesk';
import { useNav } from '../state/nav';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { useCopySnapshot } from '../state/useCopy';
import { Panel, Tag, btn } from '../ui/kit';
import { cls, fmtAgo } from '../utils/format';

type McpPanelData = NonNullable<Awaited<ReturnType<typeof window.krypt.mcp.status>>['data']>;

/** The per-profile server name main used, read off its JSON entry. */
function serverNameOf(json: string): string {
  try {
    const key = Object.keys((JSON.parse(json) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})[0];
    return key || MCP_SERVER_NAME;
  } catch {
    return MCP_SERVER_NAME;
  }
}

function platformOf(): McpPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Windows/i.test(ua) ? 'win' : /Mac OS X|Macintosh/i.test(ua) ? 'mac' : 'linux';
}

export function AiPage() {
  const nav = useNav();
  const toast = useToast();
  const modal = useModal();
  const { snap } = useCopySnapshot();
  const [panel, setPanel] = useState<McpPanelData | null>(null);
  const [desk, setDesk] = useState<AiDeskStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [clientId, setClientId] = useState('claude-code');
  const [, tick] = useState(0);

  const read = useCallback(async () => {
    const [m, a] = await Promise.all([window.krypt.mcp.status(), window.krypt.aiDesk.status()]);
    if (m.ok && m.data) setPanel(m.data);
    if (a.ok && a.data) setDesk(a.data);
  }, []);
  useEffect(() => {
    void read();
    // Decisions live for seconds: the page keeps up with them.
    const id = setInterval(() => {
      void read();
      tick((n) => n + 1);
    }, 1_000);
    return () => clearInterval(id);
  }, [read]);

  const apply = async (fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      await read();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Could not reach the clipboard');
    }
  };

  /** Live is the one level that spends money: it asks, in the app's words. */
  const setAccess = async (level: McpAccess): Promise<void> => {
    if (level === 'live') {
      const yes = await modal.confirm({
        title: 'Let an AI spend real funds?',
        message:
          'An AI app connected to Krypto Mirror will be able to buy and sell with your live wallet within the limits on this page, and to approve the buys of live follows that ask it. It cannot withdraw, change a setting, arm a follow or sign anything itself — but a trade is real money, and nothing has measured an AI trading this app profitably.',
        confirmLabel: 'Allow live trading',
      });
      if (!yes) return;
    }
    await apply(() => window.krypt.mcp.setAccess(level));
  };

  const s = panel?.settings;
  const on = !!s?.enabled && !!panel?.server.running;
  const port = panel?.server.running && panel.server.port ? panel.server.port : (s?.port ?? 8787);
  const name = panel ? serverNameOf(panel.json) : MCP_SERVER_NAME;
  const clients = s?.token ? mcpClientConfigs(port, s.token, name, platformOf()) : [];
  const picked = clients.find((c) => c.id === clientId) ?? clients[0];
  const access: McpAccess = s && s.enabled ? s.access : 'off';
  const gated = (snap?.configs ?? []).filter((c) => c.ai && (c.ai.entries || c.ai.exits));

  return (
    <div className="h-full overflow-auto" data-testid="ai-page">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-16 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[26px] font-semibold tracking-display text-white">
              <Bot className="h-6 w-6 text-accent" /> AI
            </h1>
            <p className="mt-1 max-w-2xl text-[14px] text-krypt-muted">
              Connect Claude Code, Codex, Cursor or another AI app that speaks MCP. It sees what your follows see — their trades, your copies, the Scout’s scans — and,
              on the follows where you let it, has the final say on each buy and sell.
            </p>
          </div>
          <StatusPills on={on} access={access} desk={desk} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-6">
            <Pending desk={desk} />
            <Follows gated={gated} access={access} onEdit={(c) => nav.editFollow(c)} />
            <Decisions log={desk?.log ?? []} desk={desk} />
          </div>

          <div className="space-y-6">
            <Panel
              title="Connect"
              subtitle={s?.enabled ? (on ? `Listening on 127.0.0.1:${panel?.server.port} — this computer only.` : panel?.server.message || 'On, but the port could not be opened.') : 'Off — no port is open.'}
              action={<Toggle on={!!s?.enabled} disabled={busy || !panel} label="AI connection" onChange={(v) => void apply(() => window.krypt.mcp.setEnabled(v))} testId="ai-enabled" />}
            >
              {s?.enabled ? (
                <div className="space-y-5">
                  <div>
                    <div className="mb-1.5 text-label uppercase tracking-label text-krypt-muted">How far it reaches</div>
                    <div className="grid grid-cols-2 gap-2">
                      {MCP_ACCESS_LEVELS.filter((l) => l !== 'off').map((level) => (
                        <button
                          key={level}
                          onClick={() => void setAccess(level)}
                          disabled={busy}
                          title={MCP_ACCESS_TEXT[level].why}
                          data-testid={`ai-access-${level}`}
                          className={cls(
                            'rounded-lg border px-3 py-2 text-note font-semibold transition disabled:opacity-50',
                            s.access === level
                              ? level === 'live'
                                ? 'border-down/50 bg-down/15 text-white'
                                : 'border-accent/50 bg-accent/15 text-white'
                              : 'border-white/10 bg-raised text-krypt-muted hover:border-white/20 hover:text-white',
                            level === 'read' && 'col-span-2',
                          )}
                        >
                          {MCP_ACCESS_TEXT[level].label}
                        </button>
                      ))}
                    </div>
                    <p className={cls('mt-1.5 text-body leading-relaxed', s.access === 'live' ? 'text-down' : 'text-krypt-muted')}>{MCP_ACCESS_TEXT[s.access].why}</p>
                    <p className="mt-1 text-body leading-relaxed text-krypt-muted">
                      Deciding a follow’s trades needs Paper trading for paper follows and Live trading for live ones.
                    </p>
                  </div>

                  <div>
                    <div className="mb-1.5 text-label uppercase tracking-label text-krypt-muted">Your AI app</div>
                    {picked && (
                      <>
                        <select
                          value={picked.id}
                          onChange={(e) => setClientId(e.target.value)}
                          aria-label="AI app"
                          data-testid="ai-client"
                          className="mb-2 w-full rounded-lg border border-white/10 bg-raised px-3 py-2 text-note text-white outline-none focus:border-accent/50"
                        >
                          {clients.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.client}
                            </option>
                          ))}
                        </select>
                        <div className="mb-1 text-body text-krypt-muted">
                          {picked.how === 'command' ? 'Run in: ' : picked.how === 'fields' ? 'Type into: ' : 'Add to: '}
                          <span className="break-all font-mono text-white/80">{picked.where}</span>
                        </div>
                        <pre className="mb-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-body text-white/80" data-testid="ai-client-snippet">
                          {picked.shown}
                        </pre>
                        <p className="mb-2 text-body leading-relaxed text-krypt-muted">{picked.notes}</p>
                      </>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button className={btn.primary} disabled={!picked} onClick={() => picked && void copy(picked.snippet, picked.how === 'command' ? 'Command' : 'Config')} data-testid="ai-copy-connect">
                        <Copy className="h-4 w-4" /> {picked?.how === 'command' ? 'Copy the command' : 'Copy the config'}
                      </button>
                      <button className={btn.ghost} onClick={() => setShowToken((v) => !v)} data-testid="ai-token-show">
                        <KeyRound className="h-4 w-4" /> {showToken ? 'Hide token' : 'Show token'}
                      </button>
                      <button
                        className={btn.ghost}
                        onClick={() =>
                          void (async () => {
                            const yes = await modal.confirm({ title: 'Make a new token?', message: 'Every AI app connected with the old one stops working until you give it the new command.', confirmLabel: 'Make a new token' });
                            if (yes) await apply(() => window.krypt.mcp.newToken());
                          })()
                        }
                      >
                        <RefreshCw className="h-4 w-4" /> New token
                      </button>
                    </div>
                    {showToken && <p className="mt-2 break-all rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-body text-white/80">{s.token}</p>}
                    <p className="mt-2 text-body leading-relaxed text-krypt-muted">
                      The copied text holds a token — a password for this app. Never paste it into a chat or a screenshot. {MCP_CANNOT_CONNECT}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-body leading-relaxed text-krypt-muted">
                  Switch it on to open a port on this computer only (127.0.0.1) that your AI app connects to with a token. It starts read only.
                </p>
              )}
              {s && (
                <div className="mt-4 grid grid-cols-[120px_minmax(0,1fr)] items-end gap-3">
                  <NumberField label="Port" hint="" value={s.port} onSave={(v) => void apply(() => window.krypt.mcp.setPort(Math.round(v)))} testId="ai-port" />
                  <p className="pb-2 text-body leading-relaxed text-krypt-muted">Change it if another app already uses this one. Your AI app then needs the new command.</p>
                </div>
              )}
            </Panel>

            {s?.enabled && (
              <Panel title="Start the desk" subtitle="Paste this into your AI app once it is connected. It runs the loop that hears your follows and answers their decisions.">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body leading-relaxed text-white/80" data-testid="ai-prompt">
                  {aiStarterPrompt(name)}
                </pre>
                <button className={cls(btn.secondary, 'mt-2')} onClick={() => void copy(aiStarterPrompt(name), 'Prompt')} data-testid="ai-prompt-copy">
                  <Copy className="h-4 w-4" /> Copy the prompt
                </button>
                <p className="mt-2 text-body leading-relaxed text-krypt-muted">
                  The AI app has to keep running for the desk to work. Each event it reads uses its own tokens, at its own price.
                </p>
              </Panel>
            )}

            {s?.enabled && (
              <Panel title="Limits" subtitle={s.access === 'live' ? 'What the AI may spend with its own buy_token calls.' : 'They bind once you allow live trading.'}>
                <div className="grid grid-cols-3 gap-3">
                  <NumberField label="Max per buy" hint="SOL" value={s.budget.maxBuySol} onSave={(v) => void apply(() => window.krypt.mcp.setBudget({ ...s.budget, maxBuySol: v }))} />
                  <NumberField label="Max an hour" hint="SOL" value={s.budget.hourlyCapSol} onSave={(v) => void apply(() => window.krypt.mcp.setBudget({ ...s.budget, hourlyCapSol: v }))} />
                  <NumberField label="Trades a minute" hint="1–60" value={s.budget.maxTradesPerMinute} onSave={(v) => void apply(() => window.krypt.mcp.setBudget({ ...s.budget, maxTradesPerMinute: Math.round(v) }))} />
                </div>
                <p className="mt-2 text-body leading-relaxed text-krypt-muted">
                  A follow’s copies keep the follow’s own size and limits: the AI can only shrink or skip them. Sells are never capped — getting out is the point.
                </p>
              </Panel>
            )}

            <p className="text-body leading-relaxed text-krypt-muted">
              Whatever you allow, the AI can never withdraw or transfer, change a setting, arm or edit a follow, see your key, or hand the app a transaction to sign. It
              asks; the app checks and builds.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPills({ on, access, desk }: { on: boolean; access: McpAccess; desk: AiDeskStatus | null }) {
  const polled = desk?.lastPollAt ? fmtAgo(desk.lastPollAt) : null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="ai-status">
      <Tag tone={on ? (access === 'live' ? 'down' : 'accent') : 'neutral'}>{on ? `Connection: ${MCP_ACCESS_TEXT[access].label}` : 'Connection off'}</Tag>
      <Tag tone={desk?.online ? 'up' : 'neutral'} title={polled ? `Last heard ${polled}` : 'No AI has polled since the app started'}>
        {desk?.online ? (desk.listening ? 'AI listening now' : `AI online · ${polled}`) : 'No AI connected'}
      </Tag>
      {desk && desk.asked > 0 && (
        <Tag>
          {desk.answered} of {desk.asked} answered{desk.timedOut ? ` · ${desk.timedOut} timed out` : ''}
        </Tag>
      )}
    </div>
  );
}

function Pending({ desk }: { desk: AiDeskStatus | null }) {
  const list = desk?.pending ?? [];
  if (!list.length) return null;
  return (
    <Panel title="Waiting on the AI" subtitle="Each one falls back to the follow’s own rule at its deadline.">
      <div className="divide-y divide-white/[0.05]" data-testid="ai-pending">
        {list.map((r) => (
          <PendingRow key={r.id} r={r} />
        ))}
      </div>
    </Panel>
  );
}

function PendingRow({ r }: { r: AiRequest }) {
  const left = Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000));
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-note font-medium text-white">
          {r.follow} · {r.symbol || `${r.mint.slice(0, 6)}…`} <Tag tone={r.mode === 'live' ? 'down' : 'neutral'}>{r.mode}</Tag>
        </div>
        <div className="text-body text-krypt-muted">
          {r.kind === 'entry'
            ? `Buy ${r.sizeSol} — they ${r.leaderSide === 'buy' ? 'bought' : 'sold'} ${r.leaderSol}`
            : `Sell ${r.sellPct === null ? 'their share' : `${r.sellPct}%`} — ${r.why}${r.movePct === null ? '' : ` (${r.movePct >= 0 ? '+' : ''}${r.movePct.toFixed(1)}%)`}`}
        </div>
      </div>
      <span className="shrink-0 font-mono text-note tabular-nums text-warn">{left}s</span>
    </div>
  );
}

function Follows({ gated, access, onEdit }: { gated: NonNullable<ReturnType<typeof useCopySnapshot>['snap']>['configs']; access: McpAccess; onEdit: (c: NonNullable<ReturnType<typeof useCopySnapshot>['snap']>['configs'][number]) => void }) {
  return (
    <Panel title="Follows your AI decides" subtitle="Turn it on per follow: Follow › Advanced › Your AI decides.">
      {gated.length ? (
        <div className="divide-y divide-white/[0.05]" data-testid="ai-follows">
          {gated.map((c) => {
            const allowed = accessDecides(access, c.mode);
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-note font-medium text-white">
                    {c.label || `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`} <Tag tone={c.mode === 'live' ? 'down' : 'neutral'}>{c.mode}</Tag>
                  </div>
                  <div className={cls('text-body', allowed ? 'text-krypt-muted' : 'text-warn')}>
                    {[c.ai?.entries ? 'buys' : '', c.ai?.exits ? 'sells' : ''].filter(Boolean).join(' and ')} · {c.ai?.waitSec} s ·{' '}
                    {allowed
                      ? c.ai?.entries
                        ? c.ai.onTimeout === 'skip'
                          ? 'no answer skips'
                          : 'no answer copies'
                        : 'no answer sells by the rule'
                      : `the connection is ${MCP_ACCESS_TEXT[access].label.toLowerCase()} — ${c.ai?.entries && c.ai.onTimeout === 'skip' ? 'every buy is skipped' : 'the follow’s own rules decide'}`}
                  </div>
                </div>
                <button className={btn.ghost} onClick={() => onEdit(c)}>
                  <Pencil className="h-4 w-4" /> Edit
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-body leading-relaxed text-krypt-muted">
          None yet. Without it, your AI still hears every trade and can trade on its own within the limits — the follows just don’t wait for it.
        </p>
      )}
    </Panel>
  );
}

const OUTCOME: Record<AiDecisionLog['outcome'], string> = {
  ai: '',
  timeout: 'no answer in time',
  offline: 'no AI connected',
  'not allowed': 'connection not allowed',
  cancelled: 'withdrawn',
};

function Decisions({ log, desk }: { log: AiDecisionLog[]; desk: AiDeskStatus | null }) {
  return (
    <Panel title="Decisions" subtitle={desk ? `${desk.seq.toLocaleString()} events on the feed since the app started.` : undefined}>
      {log.length ? (
        <div className="overflow-x-auto" data-testid="ai-log">
          <table className="w-full text-left text-body">
            <thead className="text-label uppercase tracking-label text-krypt-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Follow · coin</th>
                <th className="py-1.5 pr-3 font-medium">Asked</th>
                <th className="py-1.5 pr-3 font-medium">AI</th>
                <th className="py-1.5 font-medium">Then</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {log.map((l) => (
                <tr key={l.id} className="align-top" data-testid="ai-log-row">
                  <td className="whitespace-nowrap py-2 pr-3 text-krypt-muted">{fmtAgo(l.askedAt)}</td>
                  <td className="py-2 pr-3 text-white">
                    {l.follow} · {l.symbol || `${l.mint.slice(0, 6)}…`} {l.mode === 'live' && <Tag tone="down">live</Tag>}
                  </td>
                  <td className="py-2 pr-3 text-krypt-muted">{l.asked}</td>
                  <td className="py-2 pr-3">
                    {l.verdict ? (
                      <span className="text-white">
                        <span className={cls('font-semibold', l.verdict.verdict === 'buy' || l.verdict.verdict === 'hold' ? 'text-up' : 'text-warn')}>{l.verdict.verdict}</span>
                        {l.verdict.sizeSol !== undefined ? ` ${l.verdict.sizeSol}` : ''}
                        {l.verdict.percent !== undefined ? ` ${l.verdict.percent}%` : ''} — {l.verdict.reason}
                        <span className="text-krypt-muted"> · {(l.ms / 1000).toFixed(1)} s</span>
                      </span>
                    ) : (
                      <span className="text-krypt-muted">{OUTCOME[l.outcome]}</span>
                    )}
                  </td>
                  <td className="py-2 text-krypt-muted">{l.result || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-body leading-relaxed text-krypt-muted">Nothing asked yet. Each buy or sell a gated follow puts to the AI shows here, with its verdict and what the follow did.</p>
      )}
    </Panel>
  );
}

function Toggle({ on, onChange, label, disabled, testId }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      data-testid={testId}
      className={cls('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50', on ? 'bg-accent' : 'bg-white/15')}
    >
      <span className={cls('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-soft transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

/** A number saved only when committed: typing 0.0 into a live cap should not
 *  save 0 on the way to 0.05. */
function NumberField({ label, hint, value, onSave, testId }: { label: string; hint: string; value: number; onSave: (v: number) => void; testId?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <label className="block">
      <span className="mb-1 block text-body text-krypt-muted">
        {label} <span className="text-krypt-muted/60">{hint}</span>
      </span>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        data-testid={testId}
        className="w-full rounded-lg border border-white/10 bg-raised px-3 py-2 font-mono text-note text-white outline-none focus:border-accent/50"
      />
    </label>
  );
}
