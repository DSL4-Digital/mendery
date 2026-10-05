import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { salvageSqlite, tableToCsv } from '../public/sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, 'fixtures');
mkdirSync(fxDir, { recursive: true });

const LONG_BODY = 'The forgotten chapter. '.repeat(400); // ~9KB -> forces overflow pages

function makeDb(path) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT, body TEXT, stars REAL)');
  db.exec('CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT)');
  const ins = db.prepare('INSERT INTO notes(title, body, stars) VALUES (?, ?, ?)');
  for (let i = 1; i <= 60; i++) ins.run(`Note ${i}`, `Body of note ${i} — café, año, SENTINEL_ROW_${i}.`, i / 2);
  ins.run('The big one', LONG_BODY + 'SENTINEL_OVERFLOW_END', 5.0);
  const tag = db.prepare('INSERT INTO tags(name) VALUES (?)');
  for (const t of ['work', 'ideas', 'SENTINEL_TAG']) tag.run(t);
  db.close();
  return new Uint8Array(readFileSync(path));
}

let intact;
before(() => { intact = makeDb(join(fxDir, 'good.db')); });

test('intact db: all tables, names, rows, and overflow payloads recovered', () => {
  const r = salvageSqlite(intact);
  assert.ok(r.ok);
  assert.ok(r.headerIntact);
  const notes = r.tables.find((t) => t.name === 'notes');
  const tags = r.tables.find((t) => t.name === 'tags');
  assert.ok(notes && tags, 'both tables found by name');
  assert.deepEqual(notes.columns, ['id', 'title', 'body', 'stars']);
  assert.equal(notes.rows.length, 61);
  assert.equal(tags.rows.length, 3);
  const big = notes.rows.find((row) => row.values[1] === 'The big one');
  assert.ok(big, 'overflow row present');
  assert.match(big.values[2], /SENTINEL_OVERFLOW_END$/, 'overflow chain fully reassembled');
  assert.equal(big.values[2].length, LONG_BODY.length + 'SENTINEL_OVERFLOW_END'.length);
  const csv = tableToCsv(tags);
  assert.match(csv, /^id,name/);
  assert.match(csv, /SENTINEL_TAG/);
  assert.match(csv, /\n1,work/, 'INTEGER PRIMARY KEY values come from the rowid, not empty cells');
});

test('destroyed 100-byte header: page size inferred, rows still recovered', () => {
  const b = new Uint8Array(intact);
  b.fill(0, 0, 100);
  const r = salvageSqlite(b);
  assert.ok(r.ok, 'still recognized as sqlite via page-structure sniff');
  assert.equal(r.headerIntact, false);
  assert.equal(r.pageSize, 4096);
  const all = r.tables.flatMap((t) => t.rows.map((row) => row.values.join('|'))).join('\n');
  assert.match(all, /SENTINEL_ROW_5/);
  assert.match(all, /SENTINEL_TAG/);
  assert.ok(r.notes.some((n) => /header is destroyed/.test(n)), 'honest note about inferred header');
});

test('zeroed page in the middle: other rows survive, damage is honest', () => {
  const b = new Uint8Array(intact);
  const r0 = salvageSqlite(intact);
  const total0 = r0.stats.rowsRecovered;
  // zero the small trailing notes leaf (page 5 holds 2 rows per dbstat);
  // rows on other pages must survive, and the loss must not be papered over
  b.fill(0, 4096 * 4, 4096 * 5);
  const r = salvageSqlite(b);
  assert.ok(r.stats.rowsRecovered < total0, 'the zeroed page rows are genuinely gone');
  assert.ok(r.stats.rowsRecovered >= total0 - 5, `only the zeroed leaf is lost (${r.stats.rowsRecovered}/${total0})`);
  const all = r.tables.flatMap((t) => t.rows.map((row) => row.values.join('|'))).join('\n');
  assert.match(all, /SENTINEL_ROW_5/, 'rows on surviving pages intact');
});

test('truncated db: leading pages still yield rows', () => {
  const b = intact.subarray(0, Math.floor(intact.length * 0.5));
  const r = salvageSqlite(b);
  assert.ok(r.ok);
  assert.ok(r.stats.rowsRecovered > 0, `rows from surviving pages, got ${r.stats.rowsRecovered}`);
});

test('dropped tables stay dropped: freelist pages are not resurfaced when the header is intact', () => {
  const path = join(fxDir, 'dropped.db');
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec('CREATE TABLE keepme(id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO keepme(v) VALUES (?)').run('KEEP_SENTINEL');
  db.exec('CREATE TABLE dropme(id INTEGER PRIMARY KEY, secret TEXT)');
  const ins = db.prepare('INSERT INTO dropme(secret) VALUES (?)');
  for (let i = 0; i < 200; i++) ins.run(`DROPPED_SENTINEL_${i} — deliberately deleted content`);
  db.exec('DROP TABLE dropme'); // pages go to the freelist, bytes remain on disk
  db.close();
  const bytes = new Uint8Array(readFileSync(path));
  const raw = Buffer.from(bytes).toString('latin1');
  assert.ok(raw.includes('DROPPED_SENTINEL_'), 'precondition: dropped bytes physically remain in the file');
  const r = salvageSqlite(bytes);
  const all = r.tables.flatMap((t) => t.rows.map((row) => row.values.join('|'))).join('\n');
  assert.match(all, /KEEP_SENTINEL/, 'live data recovered');
  assert.doesNotMatch(all, /DROPPED_SENTINEL_/, 'deliberately deleted data is NOT resurfaced');
});

test('destroyed header: deleted-content ambiguity is disclosed', () => {
  const b = new Uint8Array(intact);
  b.fill(0, 0, 100);
  const r = salvageSqlite(b);
  assert.ok(r.notes.some((n) => /may include content that had been deleted/.test(n)), 'honest disclosure note present');
});

test('non-sqlite garbage: not misdetected', () => {
  const noise = new Uint8Array(8192);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) & 0xff;
  assert.equal(salvageSqlite(noise).ok, false);
});
