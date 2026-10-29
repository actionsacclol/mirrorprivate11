// Krypto Mirror's UI kit (2026-10-22).
//
// The pieces the Krypto Mirror pages are built from: one look, used the same
// way everywhere, so a number, a wallet or a score reads the same on every
// screen. Colours are the semantic tokens (text-up, text-down, text-warn,
// text-accent) and charts draw in `currentColor`, so light and dark need
// nothing extra.
//
// The house rule holds here as everywhere: unknown is an em dash, never 0.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import { cls } from '../utils/format';

// ── Formatting ──────────────────────────────────────────────────────────

export const DASH = '—';

/** A native amount with its sign. `signed` puts a + on gains. */
export function fmtAmt(v: number | null | undefined, opts: { digits?: number; signed?: boolean; unit?: string } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  const digits = opts.digits ?? (abs >= 100 ? 1 : abs >= 1 ? 3 : 4);
  const sign = v < 0 ? '−' : opts.signed && v > 0 ? '+' : '';
  return `${sign}${abs.toFixed(digits)}${opts.unit ? ` ${opts.unit}` : ''}`;
}

export function fmtPctS(v: number | null | undefined, opts: { digits?: number; signed?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const sign = v < 0 ? '−' : opts.signed && v > 0 ? '+' : '';
  return `${sign}${Math.abs(v).toFixed(opts.digits ?? 1)}%`;
}

export function fmtHold(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

export function short(addr: string, n = 4): string {
  return addr.length > n * 2 + 1 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

/** The text colour for a signed figure; muted for unknown or flat. */
export function toneOf(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'text-krypt-muted';
  return v > 0 ? 'text-up' : 'text-down';
}

// ── Identity ────────────────────────────────────────────────────────────

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A wallet's face: two hues from its address, the same on every screen, so
 * "the green-orange one" is a wallet you recognise without reading base58.
 */
export function Avatar({ address, size = 36, label }: { address: string; size?: number; label?: string }) {
  const h = hash(address.toLowerCase());
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 120)) % 360;
  const text = (label?.trim() || address.replace(/^0x/i, '')).slice(0, 2).toUpperCase();
  return (
    <div
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-[#fff]"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.36)),
        background: `linear-gradient(135deg, hsl(${a} 62% 52%), hsl(${b} 66% 42%))`,
      }}
      aria-hidden="true"
    >
      {text}
    </div>
  );
}

/** An address you will want on your clipboard: short on screen, whole in the tooltip. */
export function AddressChip({ address, n = 4, className }: { address: string; n?: number; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(address);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      title={`${address} — click to copy`}
      className={cls('inline-flex items-center gap-1 rounded-md font-mono text-body text-krypt-muted transition hover:text-white', className)}
    >
      {short(address, n)}
      {done ? <Check className="h-3 w-3 text-up" /> : <Copy className="h-3 w-3 opacity-50" />}
    </button>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────

export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={cls('rounded-xl border border-white/8 bg-card shadow-soft', className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            {title && <h3 className="text-[15px] font-semibold text-white">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-note text-krypt-muted">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cls('px-5 pb-5', title || action ? 'pt-3' : 'pt-5', bodyClass)}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  children,
  onClick,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  children?: ReactNode;
  onClick?: () => void;
  testId?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      data-testid={testId}
      className={cls(
        'flex min-w-0 flex-col rounded-xl border border-white/8 bg-card p-4 text-left shadow-soft',
        onClick && 'transition hover:border-white/20',
      )}
    >
      <div className="text-note text-krypt-muted">{label}</div>
      <div className={cls('mt-1 text-[22px] font-semibold tabular-nums leading-tight', tone ?? 'text-white')}>{value}</div>
      {sub && <div className="mt-0.5 text-body text-krypt-muted">{sub}</div>}
      {children && <div className="mt-3">{children}</div>}
    </Tag>
  );
}

export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'up' | 'down' | 'warn' | 'accent'; title?: string }) {
  const styles = {
    neutral: 'border-white/10 bg-raised text-krypt-muted',
    up: 'border-up/25 bg-up/10 text-up',
    down: 'border-down/25 bg-down/10 text-down',
    warn: 'border-warn/25 bg-warn/10 text-warn',
    accent: 'border-accent/25 bg-accent/10 text-accent',
  } as const;
  return (
    <span title={title} className={cls('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-label font-medium', styles[tone])}>
      {children}
    </span>
  );
}

// ── Controls ────────────────────────────────────────────────────────────

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  testId,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  testId?: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-raised p-0.5" role="tablist" data-testid={testId}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="tab"
          aria-selected={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cls(
            'rounded-md font-medium transition',
            size === 'sm' ? 'px-2.5 py-1 text-body' : 'px-3 py-1.5 text-note',
            o.value === value ? 'bg-card text-white shadow-soft' : 'text-krypt-muted hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs for switching the body of a page. */
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: Array<{ value: T; label: ReactNode; count?: number }>; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-6 border-b border-white/10" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cls(
            '-mb-px flex items-center gap-2 border-b-2 pb-2.5 pt-1 text-[14px] font-medium transition',
            t.value === value ? 'border-accent text-white' : 'border-transparent text-krypt-muted hover:text-white',
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="rounded-full bg-raised px-1.5 text-label text-krypt-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  testId,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
      className={cls('flex items-center gap-2 rounded-lg border border-white/10 bg-raised px-3 focus-within:border-accent/60', className)}
    >
      <Search className="h-4 w-4 shrink-0 text-krypt-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        data-testid={testId}
        className="min-w-0 flex-1 bg-transparent py-2.5 text-note text-white placeholder-krypt-muted/70 outline-none"
      />
    </form>
  );
}

/** A checkbox styled as a chip — for filters. */
export function CheckChip({ on, onToggle, children, title, testId }: { on: boolean; onToggle: () => void; children: ReactNode; title?: string; testId?: string }) {
  return (
    <button
      onClick={onToggle}
      title={title}
      aria-pressed={on}
      data-testid={testId}
      className={cls(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-body font-medium transition',
        on ? 'border-accent/50 bg-accent/10 text-white' : 'border-white/10 bg-card text-krypt-muted hover:border-white/20 hover:text-white',
      )}
    >
      <span className={cls('flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border', on ? 'border-accent bg-accent text-[#fff]' : 'border-white/25')}>
        {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}

// ── Scores ──────────────────────────────────────────────────────────────

export function scoreToneClass(score: number | null): string {
  if (score === null) return 'text-krypt-muted';
  return score >= 70 ? 'text-up' : score >= 40 ? 'text-warn' : 'text-down';
}

/** The Copy score as a ring. Null is an empty ring and a dash. */
export function ScoreRing({ score, size = 44, stroke = 4 }: { score: number | null; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className={cls('relative shrink-0', scoreToneClass(score))} style={{ width: size, height: size }} title={score === null ? 'No Copy score yet — too few trips measured' : `Copy score ${score} of 100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={stroke} />
        {score !== null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums" style={{ fontSize: Math.round(size * 0.32) }}>
        {score === null ? DASH : score}
      </div>
    </div>
  );
}

/** A thin horizontal meter, 0–100. */
export function Meter({ value, tone = 'accent' }: { value: number | null; tone?: 'accent' | 'up' | 'down' | 'warn' }) {
  const bg = { accent: 'bg-accent', up: 'bg-up', down: 'bg-down', warn: 'bg-warn' }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      {value !== null && <div className={cls('h-full rounded-full', bg)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />}
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────

/**
 * A cumulative line with a soft fill under it, drawn in currentColor —
 * green when the last point is up, red when down, unless a class is given.
 * Hover shows the point under the pointer.
 */
export function LineChart({
  points,
  height = 160,
  format = (v: number) => fmtAmt(v, { signed: true }),
  label = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  className,
  empty = 'Nothing to draw yet',
}: {
  points: Array<{ t: number; v: number }>;
  height?: number;
  format?: (v: number) => string;
  label?: (t: number) => string;
  className?: string;
  empty?: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientWidth > 0 && setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const pad = 6;
    const vs = points.map((p) => p.v);
    const min = Math.min(0, ...vs);
    const max = Math.max(0, ...vs);
    const span = max - min || 1;
    const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
    const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${y(min).toFixed(1)} L${x(0).toFixed(1)},${y(min).toFixed(1)} Z`;
    return { x, y, line, area, zero: y(0) };
  }, [points, width, height]);
  const last = points.length ? points[points.length - 1].v : 0;
  const tone = className ?? (last >= 0 ? 'text-up' : 'text-down');
  if (!geom) {
    return (
      <div ref={wrap} className="flex items-center justify-center rounded-lg border border-dashed border-white/10 text-note text-krypt-muted" style={{ height }}>
        {empty}
      </div>
    );
  }
  const hp = hover !== null ? points[hover] : null;
  return (
    <div
      ref={wrap}
      className={cls('relative', tone)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - 6) / Math.max(1, r.width - 12)) * (points.length - 1));
        setHover(Math.max(0, Math.min(points.length - 1, i)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={width} height={height} className="block">
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <line x1={0} x2={width} y1={geom.zero} y2={geom.zero} className="text-krypt-muted" stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 4" />
        <path d={geom.area} fill={`url(#g${gid})`} />
        <path d={geom.line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <>
            <line x1={geom.x(hover)} x2={geom.x(hover)} y1={0} y2={height} stroke="currentColor" strokeOpacity={0.3} />
            <circle cx={geom.x(hover)} cy={geom.y(points[hover].v)} r={4} fill="currentColor" />
          </>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-white/10 bg-card px-2 py-1 text-body shadow-pop"
          style={{ left: Math.min(width - 130, Math.max(0, geom.x(hover!) - 60)) }}
        >
          <div className="text-krypt-muted">{label(hp.t)}</div>
          <div className={cls('font-semibold tabular-nums', toneOf(hp.v))}>{format(hp.v)}</div>
        </div>
      )}
    </div>
  );
}

/** Labelled vertical bars — a histogram or a per-day count. */
export function Bars({
  data,
  height = 120,
  tone = 'text-accent',
  format = (v: number) => String(v),
}: {
  data: Array<{ label: string; value: number; tone?: string; hint?: string }>;
  height?: number;
  tone?: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="flex items-end gap-2" style={{ height: height + 34 }}>
      {data.map((d) => (
        <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={d.hint ?? `${d.label}: ${format(d.value)}`}>
          <div className="text-label tabular-nums text-krypt-muted">{format(d.value)}</div>
          <div className="flex w-full items-end" style={{ height }}>
            <div className={cls('w-full rounded-t-md bg-current', d.tone ?? tone)} style={{ height: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%`, opacity: d.value === 0 ? 0.25 : 0.85 }} />
          </div>
          <div className="w-full truncate text-center text-label text-krypt-muted">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

/** A small up/down bar per period — a calendar of results. */
export function DayStrip({ days, height = 36 }: { days: Array<{ day: number; pnl: number }>; height?: number }) {
  const max = Math.max(1e-9, ...days.map((d) => Math.abs(d.pnl)));
  return (
    <div className="flex items-center gap-[3px]" style={{ height }}>
      {days.map((d) => (
        <div
          key={d.day}
          className={cls('w-full rounded-sm', d.pnl > 0 ? 'bg-up' : d.pnl < 0 ? 'bg-down' : 'bg-white/15')}
          style={{ height: `${Math.max(12, (Math.abs(d.pnl) / max) * 100)}%`, opacity: d.pnl === 0 ? 0.6 : 0.85 }}
          title={`${new Date(d.day * 86_400_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${fmtAmt(d.pnl, { signed: true })}`}
        />
      ))}
    </div>
  );
}

// ── Misc ────────────────────────────────────────────────────────────────

/** One labelled figure in a grid of them. */
export function Fact({ label, value, tone, hint }: { label: ReactNode; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-body text-krypt-muted">{label}</div>
      <div className={cls('mt-0.5 text-[15px] font-semibold tabular-nums', tone ?? 'text-white')}>{value}</div>
    </div>
  );
}

/** A step in a checklist: done, current or waiting. */
export function CheckStep({ done, current, title, body, action }: { done: boolean; current?: boolean; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cls('flex items-start gap-3 rounded-lg px-3 py-2.5', current && 'bg-accent/[0.07]')}>
      <span
        className={cls(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          done ? 'border-up bg-up text-[#fff]' : current ? 'border-accent text-accent' : 'border-white/20',
        )}
      >
        {done && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cls('text-note font-medium', done ? 'text-krypt-muted line-through decoration-white/20' : 'text-white')}>{title}</div>
        {body && !done && <div className="mt-0.5 text-body text-krypt-muted">{body}</div>}
      </div>
      {action && !done && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The small button style used inside rows and cards. */
export const btn = {
  primary: 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-note font-semibold text-[#fff] transition hover:brightness-110 disabled:opacity-45 disabled:cursor-not-allowed',
  secondary: 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-raised px-3.5 py-2 text-note font-medium text-white transition hover:border-white/20 disabled:opacity-45 disabled:cursor-not-allowed',
  ghost: 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-note font-medium text-krypt-muted transition hover:bg-white/5 hover:text-white disabled:opacity-45',
  danger: 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-down/30 bg-down/10 px-3.5 py-2 text-note font-medium text-down transition hover:bg-down/15 disabled:opacity-45',
} as const;
