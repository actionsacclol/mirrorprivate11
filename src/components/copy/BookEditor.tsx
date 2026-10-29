// "Name this wallet" (2026-10-28): the address book entry for one wallet,
// edited where the wallet is — a profile, Check, the address book's own
// rows. Inline, not a pop-up: the form opens in place under the name.

import { useEffect, useState } from 'react';
import { BookUser, Pencil } from 'lucide-react';
import { BOOK_NAME_MAX, BOOK_NOTE_MAX, cleanTags } from '@shared/addressBook';
import { useAddressBook } from '../../state/useAddressBook';
import { useToast } from '../../state/ToastProvider';
import { btn } from '../../ui/kit';
import { cls } from '../../utils/format';

/** The tags and note of a named wallet, small, for under a name. */
export function BookLine({ address, className }: { address: string; className?: string }) {
  const book = useAddressBook();
  const e = book.entryOf(address);
  if (!e || (!e.tags.length && !e.note)) return null;
  return (
    <div className={cls('flex flex-wrap items-center gap-1.5 text-body text-krypt-muted', className)} data-testid="book-line">
      {e.tags.map((t) => (
        <span key={t} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-accent">
          #{t}
        </span>
      ))}
      {e.note && <span className="truncate" title={e.note}>{e.note}</span>}
    </div>
  );
}

/**
 * A button that opens the editor in place: "Name this wallet" when the book
 * has nothing for it, "Edit name" when it does. `suggest` fills an empty
 * name field (a pump.fun username, a follow's label).
 */
export function BookEditor({ address, suggest = '', startOpen = false, onDone }: { address: string; suggest?: string; startOpen?: boolean; onDone?: () => void }) {
  const book = useAddressBook();
  const toast = useToast();
  const e = book.entryOf(address);
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(e?.name ?? suggest);
    setTags(e?.tags.join(', ') ?? '');
    setNote(e?.note ?? '');
    // Filled from the entry when the form opens, not on every book change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, address]);

  const close = (): void => {
    setOpen(false);
    onDone?.();
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await book.save({ address, name, note, tags: cleanTags(tags) });
      if (!r.ok) return void toast.error(r.message);
      toast.success(r.message);
      close();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await book.remove(address);
      if (!r.ok) return void toast.error(r.message);
      toast.success(r.message);
      close();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={btn.secondary} data-testid="book-edit" title="Your own name, tags and note for this wallet, shown wherever it appears in the app">
        {e ? <Pencil className="h-4 w-4" /> : <BookUser className="h-4 w-4" />}
        {e ? 'Edit name' : 'Name this wallet'}
      </button>
    );
  }
  const field = 'rounded-lg border border-white/10 bg-raised px-3 py-2 text-note text-white outline-none focus:border-accent/60';
  return (
    <div className="w-full rounded-xl border border-accent/30 bg-card p-4" data-testid="book-form">
      <div className="text-note font-medium text-white">{e ? 'Edit this wallet in your address book' : 'Add this wallet to your address book'}</div>
      <p className="mt-0.5 text-body text-krypt-muted">The name shows wherever this wallet does — Discover, Check, Following, a coin’s trades and holders. Tags group wallets; a tag can be followed as a crowd from the address book.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          autoFocus
          value={name}
          maxLength={BOOK_NAME_MAX}
          onChange={(x) => setName(x.target.value)}
          onKeyDown={(x) => x.key === 'Enter' && void save()}
          placeholder="Name"
          className={field}
          data-testid="book-name"
        />
        <input value={tags} onChange={(x) => setTags(x.target.value)} onKeyDown={(x) => x.key === 'Enter' && void save()} placeholder="Tags, separated by commas" className={field} data-testid="book-tags" />
        <textarea
          value={note}
          maxLength={BOOK_NOTE_MAX}
          onChange={(x) => setNote(x.target.value)}
          placeholder="Note — why you are watching them, what to look out for"
          rows={2}
          className={cls(field, 'sm:col-span-2 resize-y')}
          data-testid="book-note"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => void save()} disabled={busy} className={btn.primary} data-testid="book-save">
          Save
        </button>
        <button onClick={close} className={btn.ghost}>
          Cancel
        </button>
        {e && (
          <button onClick={() => void remove()} disabled={busy} className={cls(btn.ghost, 'text-down')} data-testid="book-remove">
            Remove from the book
          </button>
        )}
      </div>
    </div>
  );
}
