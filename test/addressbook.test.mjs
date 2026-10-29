// The address book (2026-10-28): your names, tags and notes for wallets.
//
// What must hold: an address is kept in one form (EVM lower-cased, Solana
// as written), an entry is rebuilt by the rules whatever was sent, every
// import format a tracker exports reads back, the book's own export reads
// back unchanged, an import never blanks a name you wrote, and a book file
// that cannot be read is never overwritten by an empty one.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOOK_TAGS_MAX, BOOK_TAG_MAX, bookAddress, bookTags, bookToCsv, bookToJson, cleanEntry, cleanTags, entryTitle, hasTag, matchesBook, parseBookImport } from './.addressbook.mjs';
import * as store from './.addressbookstore.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const SOL = 'CyrZnTp2MAHeqQSBk4jg9RMcpteFGZRYaHSLB1QHbonF';
const SOL2 = 'DxBphjLCycinZ9i2RybyGbguTxmxX8krReQZr8TD59w8';
const EVM = '0xAbCdEf0123456789aBcDeF0123456789abCDef01';

{
  assert.equal(bookAddress(` ${SOL} `), SOL, 'Solana kept as written, trimmed');
  assert.equal(bookAddress(EVM), EVM.toLowerCase(), 'EVM lower-cased');
  assert.equal(bookAddress('not an address'), null);
  assert.equal(bookAddress(SOL.slice(0, 20)), null);
  assert.equal(bookAddress(42), null);
  assert.deepEqual(cleanTags('#Winners, paper; winners | big fish'), ['Winners', 'paper', 'big-fish'], 'split on , ; |, # dropped, spaces to dashes, duplicates by case');
  assert.deepEqual(cleanTags(['a', '', '  ', 'A']), ['a']);
  assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length, BOOK_TAGS_MAX);
  assert.equal(cleanTags(['x'.repeat(100)])[0].length, BOOK_TAG_MAX);
  ok('addresses keep one form; tags are cleaned, de-duplicated and capped');
}

{
  const now = 1_790_000_000_000;
  const r = cleanEntry({ address: SOL, name: '  Week\u0007 winner \n ', note: 'paper first', tags: 'winners' }, now);
  assert.ok(r.ok);
  assert.deepEqual(r.entry, { address: SOL, name: 'Week winner', note: 'paper first', tags: ['winners'], addedAt: now, updatedAt: now });
  assert.equal(cleanEntry({ address: SOL }, now).ok, false, 'an entry needs a name, a tag or a note');
  assert.equal(cleanEntry({ address: 'nope', name: 'x' }, now).ok, false);
  assert.equal(cleanEntry(null, now).ok, false);
  const later = cleanEntry({ address: SOL, name: 'Renamed' }, now + 5, r.entry);
  assert.equal(later.entry.addedAt, now, 'a change keeps when it was added');
  assert.equal(later.entry.updatedAt, now + 5);
  assert.equal(cleanEntry({ address: SOL, name: 'x'.repeat(100) }, now).entry.name.length, 40);
  assert.equal(entryTitle({ name: '', tags: ['whales'] }), '#whales');
  ok('an entry is rebuilt by the rules: one line of name, a capped note, cleaned tags, dates kept');
}

{
  // A tracker's CSV with its own header, columns in its own order.
  const csv = `wallet,label,notes,group\n${SOL},"Week, winner","said ""hi""",winners;paper\n${EVM},Base guy,,evm\nnot-an-address,Junk,,\n`;
  const a = parseBookImport(csv);
  assert.equal(a.bad, 1, 'the line without an address is counted');
  assert.deepEqual(a.rows[0], { address: SOL, name: 'Week, winner', note: 'said "hi"', tags: ['winners', 'paper'] });
  assert.equal(a.rows[1].address, EVM.toLowerCase());
  // No header: address, name, tags, note — or the name first.
  const lines = parseBookImport(`${SOL},Alpha,fast,note one\nBeta,${SOL2}\n\n`);
  assert.equal(lines.bad, 0);
  assert.deepEqual(lines.rows[0], { address: SOL, name: 'Alpha', note: 'note one', tags: ['fast'] });
  assert.equal(lines.rows[1].address, SOL2);
  assert.equal(lines.rows[1].name, 'Beta');
  // Tab-separated, and a bare list of addresses.
  assert.equal(parseBookImport(`${SOL}\tTabbed`).rows[0].name, 'Tabbed');
  assert.deepEqual(parseBookImport(`${SOL}\n${SOL2}`).rows.map((r) => r.address), [SOL, SOL2]);
  // JSON: an array of entries (label/wallet spellings too), a map, strings.
  const arr = parseBookImport(JSON.stringify([{ wallet: SOL, label: 'L', tags: ['x'] }, SOL2, 7]));
  assert.equal(arr.rows.length, 2);
  assert.equal(arr.rows[0].name, 'L');
  assert.equal(arr.bad, 1);
  const map = parseBookImport(JSON.stringify({ [SOL]: 'Mapped', [SOL2]: { name: 'Obj', tags: 'a;b' } }));
  assert.deepEqual(map.rows.map((r) => r.name), ['Mapped', 'Obj']);
  assert.deepEqual(map.rows[1].tags, ['a', 'b']);
  assert.equal(parseBookImport('{not json').bad, 1);
  assert.deepEqual(parseBookImport(''), { rows: [], bad: 0 });
  ok('imports read a tracker’s CSV in any column order, headerless lines, tabs, bare lists and JSON arrays or maps');
}

{
  const now = 1_790_000_000_000;
  const entries = [
    { address: SOL, name: 'Week, "winner"', note: 'line one, with comma', tags: ['winners', 'paper'], addedAt: now, updatedAt: now },
    { address: EVM.toLowerCase(), name: 'Base', note: '', tags: [], addedAt: now, updatedAt: now },
  ];
  const back = parseBookImport(bookToCsv(entries));
  assert.equal(back.bad, 0);
  assert.deepEqual(
    back.rows,
    entries.map(({ address, name, note, tags }) => ({ address, name, note, tags })),
    'the CSV export reads back unchanged',
  );
  const json = parseBookImport(bookToJson(entries, now));
  assert.deepEqual(json.rows.map((r) => r.name), ['Week, "winner"', 'Base'], 'and the JSON export');
  assert.deepEqual(bookTags([...entries, { ...entries[1], address: SOL2, tags: ['Winners'] }]), [
    { tag: 'winners', count: 2 },
    { tag: 'paper', count: 1 },
  ]);
  assert.ok(hasTag(entries[0], 'WINNERS'));
  assert.ok(matchesBook(entries[0], '#paper'));
  assert.ok(matchesBook(entries[0], 'comma'));
  assert.ok(matchesBook(entries[1], EVM.slice(2, 10).toLowerCase()));
  assert.ok(!matchesBook(entries[1], 'winner'));
  ok('the book’s own CSV and JSON exports read back unchanged; tags count across case; search covers every field');
}

{
  store._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-book-'));
  const file = path.join(dir, 'address-book.json');
  store.init(dir);
  assert.equal(store.failure(), null, 'no file is an empty book, not a failure');
  assert.equal(store.all().length, 0);
  assert.ok(store.upsert({ address: SOL, name: 'Alpha', tags: ['winners'], note: '' }).ok);
  assert.ok(store.upsert({ address: EVM, name: 'Base', tags: [], note: '' }).ok);
  assert.equal(store.nameOf(SOL), 'Alpha');
  assert.equal(store.nameOf(EVM), 'Base', 'EVM found whatever its case');
  assert.equal(store.nameOf(EVM.toLowerCase()), 'Base');
  assert.equal(store.nameOf(SOL2), null);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.entries.length, 2, 'written to disk');
  const added = store.get(SOL).addedAt;
  assert.ok(store.upsert({ address: SOL, name: 'Alpha 2', tags: ['winners'], note: 'n' }).ok);
  assert.equal(store.get(SOL).addedAt, added, 'an edit keeps the date it was added');
  assert.equal(store.all().length, 2, 'an edit is not a second entry');
  // Import without overwrite: a known wallet is left alone and counted.
  let r = store.importRows(
    [
      { address: SOL, name: '', note: '', tags: ['imported'] },
      { address: SOL2, name: 'Beta', note: '', tags: [] },
      { address: '0x' + '1'.repeat(40), name: '', note: '', tags: [] },
    ],
    false,
  );
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);
  assert.deepEqual(store.get(SOL).tags, ['winners'], 'left as it was');
  assert.equal(store.nameOf('0x' + '1'.repeat(40)), '0x11…1111', 'a bare address goes in under its short form');
  // With overwrite: tags added, an empty name or note in the file never blanks yours.
  r = store.importRows([{ address: SOL, name: '', note: '', tags: ['imported'] }], true);
  assert.equal(r.updated, 1);
  assert.equal(store.get(SOL).name, 'Alpha 2');
  assert.equal(store.get(SOL).note, 'n');
  assert.deepEqual(store.get(SOL).tags, ['winners', 'imported']);
  assert.ok(store.remove(SOL).ok);
  assert.equal(store.nameOf(SOL), null);
  assert.equal(store.remove(SOL).ok, false);
  // Reloaded from disk: the same book.
  const before = store.all();
  store._reset();
  store.init(dir);
  assert.deepEqual(store.all(), before, 'reads back from its file');
  // A damaged file: nothing is overwritten, every change refused and said.
  fs.writeFileSync(file, '{"entries": [ broken');
  store._reset();
  store.init(dir);
  assert.match(store.failure(), /could not be read/);
  assert.equal(store.all().length, 0);
  assert.equal(store.upsert({ address: SOL, name: 'x', tags: [], note: '' }).ok, false);
  assert.equal(store.importRows([{ address: SOL, name: 'x', note: '', tags: [] }], true).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"entries": [ broken', 'the damaged file is left exactly as it was');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the store keeps one entry per wallet, imports without blanking your names, reloads from disk, and never overwrites a damaged file');
}

console.log(`\naddressbook: ${passed}/5 passed`);
if (passed !== 5) process.exit(1);
