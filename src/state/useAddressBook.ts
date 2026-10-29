// The address book in the renderer (2026-10-28): one copy for every page,
// loaded once, replaced whole by every answer main gives (each book call
// returns the whole book), so a name changed on a profile shows on Discover
// and Following without either asking again.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { bookAddress, type AddressBookEntry } from '@shared/addressBook';

let entries: AddressBookEntry[] = [];
let byAddress = new Map<string, AddressBookEntry>();
let failure: string | null = null;
let version = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setBook(list: AddressBookEntry[], message?: string): void {
  entries = list;
  byAddress = new Map(list.map((e) => [e.address, e]));
  failure = message && message !== 'ok' && /could not be read/.test(message) ? message : failure;
  version += 1;
  for (const l of listeners) l();
}

/** Load the book (once; again with `force`). */
export function loadBook(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = window.krypt.book
    .list()
    .then((r) => {
      if (r.ok && r.data) setBook(r.data, r.message);
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = (): number => version;

/** The entry for an address, or null. EVM is matched lower-cased. */
export function bookEntry(address: string | null | undefined): AddressBookEntry | null {
  if (!address) return null;
  return byAddress.get(address) ?? (address.startsWith('0x') ? (byAddress.get(address.toLowerCase()) ?? null) : null);
}

/** The name to show for an address — its name, else its first tag — or null. */
export function bookName(address: string | null | undefined): string | null {
  const e = bookEntry(address);
  if (!e) return null;
  return e.name || (e.tags[0] ? `#${e.tags[0]}` : null);
}

export interface BookApi {
  entries: AddressBookEntry[];
  failure: string | null;
  entryOf: (address: string | null | undefined) => AddressBookEntry | null;
  nameOf: (address: string | null | undefined) => string | null;
  save: (e: { address: string; name: string; note: string; tags: string[] }) => Promise<{ ok: boolean; message: string }>;
  remove: (address: string) => Promise<{ ok: boolean; message: string }>;
  importText: (text: string, overwrite: boolean) => Promise<{ ok: boolean; message: string }>;
}

/** The book, re-rendering the caller whenever it changes. */
export function useAddressBook(): BookApi {
  useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    void loadBook();
  }, []);
  const save = useCallback<BookApi['save']>(async (e) => {
    if (!bookAddress(e.address)) return { ok: false, message: 'That is not a Solana or 0x wallet address' };
    const r = await window.krypt.book.save(e);
    if (r.ok && r.data) setBook(r.data);
    return { ok: r.ok, message: r.message };
  }, []);
  const remove = useCallback<BookApi['remove']>(async (address) => {
    const r = await window.krypt.book.remove(address);
    if (r.ok && r.data) setBook(r.data);
    return { ok: r.ok, message: r.message };
  }, []);
  const importText = useCallback<BookApi['importText']>(async (text, overwrite) => {
    const r = await window.krypt.book.import(text, overwrite);
    if (r.ok && r.data) setBook(r.data);
    return { ok: r.ok, message: r.message };
  }, []);
  return { entries, failure, entryOf: bookEntry, nameOf: bookName, save, remove, importText };
}
