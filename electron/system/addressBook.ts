// The address book's file (2026-10-28) — see shared/addressBook.ts.
//
// One JSON file in the profile's data folder, written whole and atomically
// (temp file, then rename), like the watchlist. A file that cannot be read
// is NOT overwritten: the book starts empty for the session, saving is off,
// and the failure is said, so a damaged book is never replaced by an empty
// one on the next save.

import fs from 'node:fs';
import path from 'node:path';
import { BOOK_MAX_ENTRIES, bookAddress, cleanEntry, type AddressBookEntry, type BookImportRow } from '@shared/addressBook';

const FILE = 'address-book.json';

let filePath = '';
let entries: AddressBookEntry[] = [];
let byAddress = new Map<string, AddressBookEntry>();
let loadFailure: string | null = null;

function reindex(): void {
  byAddress = new Map(entries.map((e) => [e.address, e]));
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  entries = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries) ? (data as { entries: unknown[] }).entries : null;
    if (!list) throw new Error('not a list of entries');
    const now = Date.now();
    for (const x of list) {
      const r = cleanEntry(x, now);
      if (!r.ok) continue;
      const o = x as Partial<AddressBookEntry>;
      // Keep the dates the file had.
      entries.push({ ...r.entry, addedAt: typeof o.addedAt === 'number' ? o.addedAt : now, updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now });
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') loadFailure = `${FILE} could not be read (${err.message ?? String(e)}) — it was left as it is, and changes are not saved this session.`;
  }
  reindex();
}

function save(): void {
  if (!filePath || loadFailure) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* best-effort, like the watchlist; the next change tries again */
  }
}

export function failure(): string | null {
  return loadFailure;
}

export function all(): AddressBookEntry[] {
  return entries.map((e) => ({ ...e, tags: [...e.tags] }));
}

export function get(address: string): AddressBookEntry | null {
  const a = bookAddress(address);
  const e = a ? byAddress.get(a) : undefined;
  return e ? { ...e, tags: [...e.tags] } : null;
}

/** The name to show for an address, or null. Hot: called per row of a
 *  coin's trades and holders, so it is one map lookup (EVM lower-cased). */
export function nameOf(address: string): string | null {
  if (!address) return null;
  const e = byAddress.get(address) ?? (address.startsWith('0x') ? byAddress.get(address.toLowerCase()) : undefined);
  if (!e) return null;
  return e.name || (e.tags[0] ? `#${e.tags[0]}` : null);
}

/** Add or change one entry. */
export function upsert(raw: unknown, now = Date.now()): { ok: boolean; message: string } {
  if (loadFailure) return { ok: false, message: loadFailure };
  const prior = raw && typeof raw === 'object' ? get(String((raw as { address?: unknown }).address ?? '')) : null;
  const r = cleanEntry(raw, now, prior);
  if (!r.ok) return r;
  if (!prior && entries.length >= BOOK_MAX_ENTRIES) return { ok: false, message: `The address book holds ${BOOK_MAX_ENTRIES.toLocaleString()} wallets — remove some first` };
  if (prior) entries = entries.map((e) => (e.address === r.entry.address ? r.entry : e));
  else entries.push(r.entry);
  reindex();
  save();
  return { ok: true, message: prior ? 'Saved' : `Added ${r.entry.name || r.entry.address.slice(0, 6) + '…'} to the address book` };
}

export function remove(address: string): { ok: boolean; message: string } {
  if (loadFailure) return { ok: false, message: loadFailure };
  const a = bookAddress(address);
  if (!a || !byAddress.has(a)) return { ok: false, message: 'Not in the address book' };
  entries = entries.filter((e) => e.address !== a);
  reindex();
  save();
  return { ok: true, message: 'Removed from the address book' };
}

/**
 * Many at once (an import). A wallet already in the book is UPDATED only
 * when `overwrite` is on, and then only in what the import says: an empty
 * name or note in the file never blanks the one you wrote, and its tags are
 * added to yours. Without `overwrite` it is left alone and counted.
 */
export function importRows(rows: readonly BookImportRow[], overwrite: boolean, now = Date.now()): { ok: boolean; message: string; added: number; updated: number; skipped: number } {
  const none = { added: 0, updated: 0, skipped: 0 };
  if (loadFailure) return { ok: false, message: loadFailure, ...none };
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const prior = byAddress.get(row.address) ?? null;
    if (prior && !overwrite) {
      skipped += 1;
      continue;
    }
    if (!prior && entries.length >= BOOK_MAX_ENTRIES) {
      skipped += 1;
      continue;
    }
    const merged = prior
      ? { address: row.address, name: row.name || prior.name, note: row.note || prior.note, tags: [...prior.tags, ...row.tags] }
      : { address: row.address, name: row.name, note: row.note, tags: row.tags };
    let r = cleanEntry(merged, now, prior);
    // An address with nothing else on the line still goes in, named by its
    // own short form: the import said it wanted it in the book.
    if (!r.ok) r = cleanEntry({ ...merged, name: `${row.address.slice(0, 4)}…${row.address.slice(-4)}` }, now, prior);
    if (!r.ok) {
      skipped += 1;
      continue;
    }
    const entry = r.entry;
    if (prior) {
      entries = entries.map((e) => (e.address === entry.address ? entry : e));
      updated += 1;
    } else {
      entries.push(entry);
      added += 1;
    }
    byAddress.set(entry.address, entry);
  }
  reindex();
  if (added || updated) save();
  const parts = [`${added} added`, `${updated} updated`, skipped ? `${skipped} skipped (${overwrite ? 'the book is full' : 'already in the book, left as they were'})` : ''].filter(Boolean);
  return { ok: true, message: `Imported: ${parts.join(', ')}`, added, updated, skipped };
}

/** Test seam. */
export function _reset(): void {
  filePath = '';
  entries = [];
  loadFailure = null;
  reindex();
}
