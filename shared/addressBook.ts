// The address book (2026-10-28) — your own names for wallets.
//
// Every competitor that tracks wallets lets you name them (GMGN, Cielo,
// Photon's wallet tracker, the Telegram bots' "label" commands); this app
// had a name only on a follow (`CopyConfig.label`) and on the smart-money
// watchlist. A wallet you are only watching, checked once, or saw in a coin's
// trades had no name anywhere. The book gives any address a name, a note and
// tags, and the name shows wherever that address does — Discover, a
// profile, Check, Following, the Follow page, a coin's trades and holders.
//
// Tags are how a set of wallets becomes something to act on: a tag's
// Solana wallets can be followed as a convergence crowd in one click.
//
// Pure: the rules for one entry, the import parser and the export. Main
// keeps the file (electron/system/addressBook.ts); nothing here touches disk.

export interface AddressBookEntry {
  /** A Solana address as written, or a 0x address lower-cased. */
  address: string;
  name: string;
  note: string;
  tags: string[];
  addedAt: number;
  updatedAt: number;
}

export const BOOK_MAX_ENTRIES = 5_000;
export const BOOK_NAME_MAX = 40;
export const BOOK_NOTE_MAX = 280;
export const BOOK_TAG_MAX = 24;
export const BOOK_TAGS_MAX = 8;

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

/** The address in the book's form, or null when it is not one. EVM is
 *  case-insensitive, so it is kept lower-case; Solana is not. */
export function bookAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const a = raw.trim();
  if (SOLANA.test(a)) return a;
  if (EVM.test(a)) return a.toLowerCase();
  return null;
}

export const isSolanaAddress = (a: string): boolean => SOLANA.test(a);

/** Tags: trimmed, a leading # dropped, inner spaces to dashes, case kept but
 *  duplicates judged without it, at most BOOK_TAGS_MAX. */
export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[;,|]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const v = t.trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, BOOK_TAG_MAX);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= BOOK_TAGS_MAX) break;
  }
  return out;
}

/** One line of text: control characters and runs of whitespace removed. */
const oneLine = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/**
 * An entry as the book keeps it, or why not. A name is required — an entry
 * with only tags is still a name the user chose, so the name falls back to
 * nothing only when tags or a note give the entry a reason to exist.
 */
export function cleanEntry(
  raw: unknown,
  now: number,
  prior?: AddressBookEntry | null,
): { ok: true; entry: AddressBookEntry } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'Nothing to save' };
  const r = raw as Record<string, unknown>;
  const address = bookAddress(r.address);
  if (!address) return { ok: false, message: 'That is not a Solana or 0x wallet address' };
  const name = oneLine(r.name, BOOK_NAME_MAX);
  const note = typeof r.note === 'string' ? r.note.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, BOOK_NOTE_MAX) : '';
  const tags = cleanTags(r.tags);
  if (!name && !note && !tags.length) return { ok: false, message: 'Give it a name, a tag or a note' };
  return { ok: true, entry: { address, name, note, tags, addedAt: prior?.addedAt ?? now, updatedAt: now } };
}

/** The name to show for an entry: its name, else its first tag. */
export const entryTitle = (e: Pick<AddressBookEntry, 'name' | 'tags'>): string => e.name || (e.tags[0] ? `#${e.tags[0]}` : '');

// ── Import and export ────────────────────────────────────────────────────

export interface BookImportRow {
  address: string;
  name: string;
  note: string;
  tags: string[];
}

/** One CSV line into cells: commas (or tabs, or semicolons when that is all
 *  the line has), double quotes with "" escapes. */
function cells(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes(',') ? ',' : line.includes(';') ? ';' : ' ';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const HEADER_NAMES: Record<string, 'address' | 'name' | 'note' | 'tags'> = {
  address: 'address',
  wallet: 'address',
  'wallet address': 'address',
  walletaddress: 'address',
  addr: 'address',
  pubkey: 'address',
  name: 'name',
  label: 'name',
  nickname: 'name',
  alias: 'name',
  note: 'note',
  notes: 'note',
  description: 'note',
  memo: 'note',
  tags: 'tags',
  tag: 'tags',
  group: 'tags',
  groups: 'tags',
  emoji: 'tags',
};

/**
 * What a user pastes or picks as a file: this app's own export (CSV or
 * JSON), a JSON array of entries or of {address, name|label}, a JSON object
 * of address → name, or lines of "address, name, tags, note" with or
 * without a header — most wallet trackers export one of these. A line with
 * no address on it is counted as bad and skipped; nothing is guessed.
 */
export function parseBookImport(text: string): { rows: BookImportRow[]; bad: number } {
  const rows: BookImportRow[] = [];
  let bad = 0;
  const t = text.trim();
  if (!t) return { rows, bad };
  const push = (address: unknown, name: unknown, note: unknown, tags: unknown): void => {
    const a = bookAddress(address);
    if (!a) {
      bad += 1;
      return;
    }
    rows.push({ address: a, name: oneLine(name, BOOK_NAME_MAX), note: typeof note === 'string' ? note.trim().slice(0, BOOK_NOTE_MAX) : '', tags: cleanTags(tags) });
  };
  if (t.startsWith('[') || t.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      return { rows, bad: 1 };
    }
    if (Array.isArray(data)) {
      for (const x of data) {
        if (typeof x === 'string') push(x, '', '', []);
        else if (x && typeof x === 'object') {
          const o = x as Record<string, unknown>;
          push(o.address ?? o.wallet ?? o.addr, o.name ?? o.label ?? o.nickname ?? '', o.note ?? o.notes ?? '', o.tags ?? o.tag ?? o.group ?? []);
        } else bad += 1;
      }
    } else if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>;
      // This app's own export wraps the list.
      if (Array.isArray(o.entries)) return parseBookImport(JSON.stringify(o.entries));
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') push(k, v, '', []);
        else if (v && typeof v === 'object') {
          const e = v as Record<string, unknown>;
          push(k, e.name ?? e.label ?? '', e.note ?? '', e.tags ?? []);
        } else bad += 1;
      }
    }
    return { rows, bad };
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  let cols: Array<'address' | 'name' | 'note' | 'tags' | null> = ['address', 'name', 'tags', 'note'];
  const head = cells(lines[0]).map((c) => HEADER_NAMES[c.toLowerCase()] ?? null);
  const hasHeader = head.includes('address') && !bookAddress(cells(lines[0])[head.indexOf('address')]);
  if (hasHeader) cols = head;
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const c = cells(line);
    const val = (k: 'address' | 'name' | 'note' | 'tags'): string => {
      const i = cols.indexOf(k);
      return i >= 0 ? (c[i] ?? '') : '';
    };
    // Without a header, a line whose first cell is not an address may have
    // it elsewhere ("name, address"): take the first cell that is one.
    if (!hasHeader && !bookAddress(c[0])) {
      const i = c.findIndex((x) => bookAddress(x));
      if (i < 0) {
        bad += 1;
        continue;
      }
      const rest = c.filter((_, j) => j !== i);
      push(c[i], rest[0] ?? '', rest.slice(2).join(' '), rest[1] ?? '');
      continue;
    }
    push(val('address'), val('name'), val('note'), val('tags'));
  }
  return { rows, bad };
}

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The book as CSV: address, name, tags (separated by ;), note. Reads back
 *  through parseBookImport unchanged. */
export function bookToCsv(entries: readonly AddressBookEntry[]): string {
  const lines = ['address,name,tags,note'];
  for (const e of entries) lines.push([e.address, e.name, e.tags.join(';'), e.note].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

/** The book as JSON, wrapped so the format can grow. */
export function bookToJson(entries: readonly AddressBookEntry[], now: number): string {
  return JSON.stringify({ app: 'Krypto Mirror', kind: 'address-book', version: 1, exportedAt: new Date(now).toISOString(), entries }, null, 2);
}

/** Every tag in the book with how many wallets carry it, most used first. */
export function bookTags(entries: readonly AddressBookEntry[]): Array<{ tag: string; count: number }> {
  const m = new Map<string, { tag: string; count: number }>();
  for (const e of entries) {
    for (const t of e.tags) {
      const k = t.toLowerCase();
      const cur = m.get(k) ?? { tag: t, count: 0 };
      cur.count += 1;
      m.set(k, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Does an entry carry this tag (case-insensitive)? */
export const hasTag = (e: Pick<AddressBookEntry, 'tags'>, tag: string): boolean => e.tags.some((t) => t.toLowerCase() === tag.toLowerCase());

/** A search over address, name, note and tags. */
export function matchesBook(e: AddressBookEntry, q: string): boolean {
  const s = q.trim().toLowerCase().replace(/^#/, '');
  if (!s) return true;
  return e.address.toLowerCase().includes(s) || e.name.toLowerCase().includes(s) || e.note.toLowerCase().includes(s) || e.tags.some((t) => t.toLowerCase().includes(s));
}
