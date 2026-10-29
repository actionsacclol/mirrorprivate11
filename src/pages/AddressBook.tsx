// Address book (2026-10-28) — your names, tags and notes for wallets.
//
// The user, after the competitor features: "build both of em brother we
// need the BEST". Every wallet tracker names wallets; this app named only
// the ones it followed. Here any wallet gets a name, tags and a note, the
// name shows wherever the wallet does, the book imports what other trackers
// export (CSV, JSON, address-and-name lines) and exports both, and a tag is
// one click from a convergence follow of its wallets.
//
// A page, not a pop-up (the user's rule): every control is on it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, FileUp, Plus, ScanSearch, Upload, UserRound, Users } from 'lucide-react';
import { BOOK_NAME_MAX, bookAddress, bookTags, bookToCsv, bookToJson, cleanTags, hasTag, isSolanaAddress, matchesBook, type AddressBookEntry } from '@shared/addressBook';
import { DEFAULT_FOMO_MIN_WALLETS, MAX_FOMO_WALLETS, defaultConfig } from '@shared/copytrade';
import { useAddressBook } from '../state/useAddressBook';
import { useNav } from '../state/nav';
import { useToast } from '../state/ToastProvider';
import { BookEditor } from '../components/copy/BookEditor';
import { AddressChip, Avatar, Panel, SearchBox, Segmented, Tag, btn } from '../ui/kit';
import { cls, fmtAgo } from '../utils/format';

type Sort = 'recent' | 'name';

/** Save text as a file the user downloads — nothing leaves the machine. */
function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function AddressBookPage() {
  const nav = useNav();
  const toast = useToast();
  const book = useAddressBook();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('recent');
  const [editing, setEditing] = useState<string | null>(null);
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  useEffect(() => {
    void window.krypt.copy.list().then((r) => r.ok && r.data && setFollowed(new Set(r.data.configs.map((c) => c.wallet.toLowerCase()))));
  }, []);

  const tags = useMemo(() => bookTags(book.entries), [book.entries]);
  const shown = useMemo(() => {
    const list = book.entries.filter((e) => (!tag || hasTag(e, tag)) && matchesBook(e, q));
    return sort === 'name' ? [...list].sort((a, b) => (a.name || '~').localeCompare(b.name || '~')) : [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [book.entries, tag, q, sort]);
  const tagSolana = useMemo(() => (tag ? book.entries.filter((e) => hasTag(e, tag) && isSolanaAddress(e.address)).map((e) => e.address) : []), [book.entries, tag]);

  // A tag's Solana wallets as a convergence crowd (shared/copytrade "list").
  const converge = (): void => {
    if (!tag || tagSolana.length < 2) return;
    const picked = tagSolana.slice(0, MAX_FOMO_WALLETS);
    const base = defaultConfig('', '', 'solana', 'fomo');
    nav.editFollow({
      ...base,
      label: `Crowd · #${tag}`.slice(0, 40),
      fomoSource: 'list',
      fomoWallets: picked,
      fomoMinWallets: Math.min(DEFAULT_FOMO_MIN_WALLETS, picked.length),
    });
  };

  return (
    <div className="h-full overflow-auto" data-testid="book-page">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-16 pt-6">
        <button onClick={() => nav.go('following')} className={cls(btn.ghost, '-ml-3')}>
          <ArrowLeft className="h-4 w-4" /> Following
        </button>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-semibold tracking-display text-white">Address book</h1>
            <p className="mt-1 max-w-2xl text-[14px] text-krypt-muted">
              Your names for wallets — followed or not. A name shows wherever the wallet does: Discover, Check, Following, a coin’s trades and holders. Tags group them, and a
              tag can be followed as a crowd.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={btn.secondary} disabled={!book.entries.length} onClick={() => download('krypto-mirror-address-book.csv', bookToCsv(book.entries), 'text/csv')} data-testid="book-export-csv">
              <Download className="h-4 w-4" /> Export CSV
            </button>
            <button className={btn.secondary} disabled={!book.entries.length} onClick={() => download('krypto-mirror-address-book.json', bookToJson(book.entries, Date.now()), 'application/json')} data-testid="book-export-json">
              <Download className="h-4 w-4" /> Export JSON
            </button>
          </div>
        </div>
        {book.failure && <div className="mt-4 rounded-xl border border-down/30 bg-down/10 px-4 py-3 text-note text-white">{book.failure}</div>}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <SearchBox value={q} onChange={setQ} placeholder="Search names, addresses, tags, notes" className="min-w-[260px] flex-1" testId="book-search" />
              <Segmented<Sort>
                size="sm"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'recent', label: 'Recently changed' },
                  { value: 'name', label: 'Name' },
                ]}
              />
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="book-tags-filter">
                <button onClick={() => setTag(null)} className={cls('rounded-full border px-2.5 py-1 text-body', !tag ? 'border-accent/50 bg-accent/10 text-white' : 'border-white/10 text-krypt-muted hover:text-white')}>
                  All · {book.entries.length}
                </button>
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    onClick={() => setTag(tag && tag.toLowerCase() === t.tag.toLowerCase() ? null : t.tag)}
                    className={cls(
                      'rounded-full border px-2.5 py-1 text-body',
                      tag && tag.toLowerCase() === t.tag.toLowerCase() ? 'border-accent/50 bg-accent/10 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                    )}
                  >
                    #{t.tag} · {t.count}
                  </button>
                ))}
              </div>
            )}
            {tag && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-card px-4 py-3" data-testid="book-tag-bar">
                <p className="text-note text-krypt-muted">
                  #{tag}: {tagSolana.length} Solana wallet{tagSolana.length === 1 ? '' : 's'}. Following them as a crowd buys when {Math.min(DEFAULT_FOMO_MIN_WALLETS, Math.max(2, tagSolana.length))} of them
                  buy the same coin inside a window — measured, crowds arrive late, so it starts on paper.
                </p>
                <button className={btn.primary} disabled={tagSolana.length < 2} onClick={converge} data-testid="book-converge">
                  <Users className="h-4 w-4" /> Converge on #{tag}
                </button>
              </div>
            )}

            {shown.length === 0 ? (
              <Panel>
                <p className="text-note text-krypt-muted">
                  {book.entries.length
                    ? 'Nothing matches.'
                    : 'No wallets yet. Name one from its profile or from Check (“Name this wallet”), add one on the right, or import a list another tracker exported.'}
                </p>
              </Panel>
            ) : (
              <div className="overflow-hidden rounded-xl border border-white/8 bg-card" data-testid="book-list">
                {shown.map((e) => (
                  <BookRow
                    key={e.address}
                    e={e}
                    followed={followed.has(e.address.toLowerCase())}
                    editing={editing === e.address}
                    onEdit={() => setEditing(editing === e.address ? null : e.address)}
                    onDone={() => setEditing(null)}
                    onTag={(t) => setTag(t)}
                  />
                ))}
              </div>
            )}
            {shown.length > 0 && (
              <p className="text-body text-krypt-muted">
                {shown.length} of {book.entries.length} wallet{book.entries.length === 1 ? '' : 's'}
              </p>
            )}
          </div>

          <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
            <AddPanel onAdded={(a) => (setTag(null), setQ(''), setEditing(null), toast.success(`Added ${a.slice(0, 6)}…`))} />
            <ImportPanel />
          </aside>
        </div>
      </div>
    </div>
  );
}

function BookRow({ e, followed, editing, onEdit, onDone, onTag }: { e: AddressBookEntry; followed: boolean; editing: boolean; onEdit: () => void; onDone: () => void; onTag: (t: string) => void }) {
  const nav = useNav();
  const sol = isSolanaAddress(e.address);
  return (
    <div className="border-b border-white/[0.06] px-4 py-3 last:border-b-0" data-testid="book-row">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar address={e.address} size={36} label={e.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-note font-semibold text-white">{e.name || <span className="text-krypt-muted">no name</span>}</span>
            <AddressChip address={e.address} n={5} />
            {!sol && <Tag>EVM</Tag>}
            {followed && <Tag tone="up">following</Tag>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-body text-krypt-muted">
            {e.tags.map((t) => (
              <button key={t} onClick={() => onTag(t)} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-accent hover:bg-accent/20">
                #{t}
              </button>
            ))}
            {e.note && (
              <span className="min-w-0 truncate" title={e.note}>
                {e.note}
              </span>
            )}
            <span className="text-krypt-muted/70">· changed {fmtAgo(e.updatedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {sol && (
            <button className={btn.ghost} onClick={() => nav.checkWallet(e.address)} title="What copying them would have done">
              <ScanSearch className="h-4 w-4" /> Check
            </button>
          )}
          <button className={btn.ghost} onClick={() => nav.openWallet(e.address)}>
            <UserRound className="h-4 w-4" /> Profile
          </button>
          {!followed && (
            <button className={btn.ghost} onClick={() => nav.follow(e.address)}>
              <Plus className="h-4 w-4" /> Follow
            </button>
          )}
          <button className={btn.secondary} onClick={onEdit} data-testid="book-row-edit">
            {editing ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>
      {editing && (
        <div className="mt-3">
          <BookEditor address={e.address} startOpen onDone={onDone} />
        </div>
      )}
    </div>
  );
}

function AddPanel({ onAdded }: { onAdded: (address: string) => void }) {
  const book = useAddressBook();
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const a = bookAddress(address);
  const known = a ? book.entryOf(a) : null;
  const add = async (): Promise<void> => {
    if (!a) return void toast.error('That is not a Solana or 0x wallet address');
    setBusy(true);
    try {
      const r = await book.save({ address: a, name, note: known?.note ?? '', tags: cleanTags(tags) });
      if (!r.ok) return void toast.error(r.message);
      setAddress('');
      setName('');
      setTags('');
      onAdded(a);
    } finally {
      setBusy(false);
    }
  };
  const field = 'w-full rounded-lg border border-white/10 bg-raised px-3 py-2 text-note text-white outline-none focus:border-accent/60';
  return (
    <Panel title="Add a wallet">
      <div className="space-y-2">
        <input value={address} onChange={(x) => setAddress(x.target.value)} placeholder="Wallet address (Solana or 0x)" spellCheck={false} className={cls(field, 'font-mono')} data-testid="book-add-address" />
        {address.trim() && !a && <p className="text-body text-warn">That is not a Solana or 0x wallet address.</p>}
        {known && <p className="text-body text-krypt-muted">Already in the book as “{known.name || known.address.slice(0, 6)}” — saving replaces its name and tags.</p>}
        <input value={name} maxLength={BOOK_NAME_MAX} onChange={(x) => setName(x.target.value)} placeholder="Name" className={field} data-testid="book-add-name" />
        <input value={tags} onChange={(x) => setTags(x.target.value)} onKeyDown={(x) => x.key === 'Enter' && void add()} placeholder="Tags, separated by commas" className={field} />
        <button onClick={() => void add()} disabled={busy || !a} className={cls(btn.primary, 'w-full')} data-testid="book-add">
          <Plus className="h-4 w-4" /> Add to the book
        </button>
      </div>
    </Panel>
  );
}

function ImportPanel() {
  const book = useAddressBook();
  const toast = useToast();
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    if (f.size > 2_000_000) return void toast.error('That file is over 2 MB');
    setText(await f.text());
  };
  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await book.importText(text, overwrite);
      if (!r.ok) return void toast.error(r.message);
      toast.success(r.message);
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Import" subtitle="A list another tracker exported, or this app’s own: CSV with an address column, JSON, or one wallet a line (address, name, tags, note).">
      <textarea
        value={text}
        onChange={(x) => setText(x.target.value)}
        rows={6}
        spellCheck={false}
        placeholder={'address,name,tags,note\nCyrZnTp2…,Week winner,winners;paper,+0.57 SOL 10-27'}
        className="w-full resize-y rounded-lg border border-white/10 bg-raised px-3 py-2 font-mono text-body text-white outline-none focus:border-accent/60"
        data-testid="book-import-text"
      />
      <input ref={fileRef} type="file" accept=".csv,.json,.txt,.tsv,text/csv,application/json,text/plain" className="hidden" onChange={(x) => void pick(x.target.files?.[0])} />
      <label className="mt-2 flex items-center gap-2 text-body text-krypt-muted">
        <input type="checkbox" checked={overwrite} onChange={(x) => setOverwrite(x.target.checked)} />
        Update wallets already in the book (adds their tags; never blanks a name or note)
      </label>
      <div className="mt-3 flex gap-2">
        <button className={btn.secondary} onClick={() => fileRef.current?.click()}>
          <FileUp className="h-4 w-4" /> Choose file
        </button>
        <button className={cls(btn.primary, 'flex-1')} disabled={busy || !text.trim()} onClick={() => void run()} data-testid="book-import">
          <Upload className="h-4 w-4" /> Import
        </button>
      </div>
    </Panel>
  );
}
