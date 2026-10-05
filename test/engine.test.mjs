import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rescue, reportToText, rawTextSalvage } from '../public/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => new Uint8Array(readFileSync(join(here, 'fixtures', name)));

// Behavior-level oracle: can Apple's own docx parser read a file?
function textutilReads(bytes, tmpName) {
  const p = join(here, 'fixtures', tmpName);
  writeFileSync(p, bytes);
  try {
    // textutil exits 0 with EMPTY stdout when it cannot open the file
    // (the error goes to stderr) — treat empty output as unreadable.
    const out = execFileSync('textutil', ['-convert', 'txt', '-stdout', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0 ? out : null;
  } catch {
    return null;
  }
}

test('intact docx: full structured recovery', async () => {
  const r = await rescue(fx('good.docx'), 'good.docx');
  assert.equal(r.kind, 'docx');
  assert.equal(r.containerHealth, 'intact');
  const text = reportToText(r);
  assert.match(text, /SENTINEL_START/);
  assert.match(text, /SENTINEL_MIDDLE/);
  assert.match(text, /SENTINEL_END/);
  assert.match(text, /café, año 1850/); // entity + utf-8 round trip
  assert.ok(r.blocks.some((b) => b.type === 'h' && /Voyage/.test(b.text)), 'heading detected');
  assert.ok(r.blocks.some((b) => b.type === 'li'), 'list detected');
  assert.ok(r.blocks.some((b) => b.type === 'table' && b.rows[0][0] === 'cell A1'), 'table detected');
});

test('truncated docx (file cut mid-stream): recovers the beginning, says so honestly', async () => {
  const r = await rescue(fx('truncated.docx'), 'truncated.docx');
  assert.equal(r.containerHealth, 'salvaged');
  const text = reportToText(r);
  assert.match(text, /SENTINEL_START/);
  assert.doesNotMatch(text, /SENTINEL_END/);
  assert.ok(r.textChars > 2000, `expected substantial partial text, got ${r.textChars}`);
  assert.ok(r.notes.some((n) => /partially recovered/.test(n)), 'honest partial-recovery note present');
});

test('destroyed central directory: full recovery via raw scan + rebuilt docx opens in a real parser', async () => {
  const bytes = fx('nocd.docx');
  // Confirm the file is genuinely broken for a real-world parser first.
  assert.equal(textutilReads(bytes, 'tmp-nocd-in.docx'), null, 'fixture should be unreadable by textutil');
  const r = await rescue(bytes, 'nocd.docx');
  assert.equal(r.containerHealth, 'salvaged');
  const text = reportToText(r);
  assert.match(text, /SENTINEL_START/);
  assert.match(text, /SENTINEL_MIDDLE/);
  assert.match(text, /SENTINEL_END/);
  // The rebuilt file must open in Apple's docx parser and contain the text.
  assert.ok(r.rebuiltDocx, 'rebuilt docx produced');
  const roundTrip = textutilReads(r.rebuiltDocx, 'tmp-rebuilt.docx');
  assert.ok(roundTrip, 'rebuilt docx is readable by textutil');
  assert.match(roundTrip, /SENTINEL_START/);
  assert.match(roundTrip, /SENTINEL_END/);
});

test('bit-flipped region: partial recovery, keeps what survives', async () => {
  const r = await rescue(fx('bitflip.docx'), 'bitflip.docx');
  const text = reportToText(r);
  assert.match(text, /SENTINEL_START/);
  assert.ok(r.textChars > 500, `expected some recovered text, got ${r.textChars}`);
});

test('zeroed file: honest dead verdict, no fake recovery', async () => {
  const r = await rescue(fx('zeroed.docx'), 'zeroed.docx');
  assert.equal(r.containerHealth, 'dead');
  assert.equal(r.textChars, 0);
  assert.ok(r.notes.some((n) => /zero bytes/.test(n)));
});

test('data-descriptor entries (streamed writers) recover without central directory', async () => {
  const r = await rescue(fx('descriptor-nocd.docx'), 'descriptor-nocd.docx');
  const text = reportToText(r);
  assert.match(text, /SENTINEL_START/);
  assert.match(text, /SENTINEL_END/);
});

test('xlsx with destroyed central directory: cells recovered', async () => {
  const r = await rescue(fx('nocd.xlsx'), 'nocd.xlsx');
  assert.equal(r.kind, 'xlsx');
  assert.ok(r.sheets.length >= 1, 'sheet recovered');
  const flat = r.sheets[0].rows.flat().join('|');
  assert.match(flat, /Invoice/);
  assert.match(flat, /Client café/);
  assert.match(flat, /SENTINEL_SHEET paid in full/);
  assert.match(flat, /1250\.5/);
  assert.match(flat, /inline note/);
  assert.match(flat, /TRUE/);
});

test('pptx with destroyed central directory: slide text recovered in order', async () => {
  const r = await rescue(fx('nocd.pptx'), 'nocd.pptx');
  assert.equal(r.kind, 'pptx');
  assert.equal(r.slides.length, 2);
  assert.match(r.slides[0].lines.join(' '), /SENTINEL_SLIDE_ONE/);
  assert.match(r.slides[1].lines.join(' '), /second slide/);
});

test('odt with destroyed central directory: paragraphs recovered', async () => {
  const r = await rescue(fx('nocd.odt'), 'nocd.odt');
  assert.equal(r.kind, 'odf');
  const text = reportToText(r);
  assert.match(text, /SENTINEL_ODT heading/);
  assert.match(text, /café and año/);
});

test('REAL docx (made by textutil), central directory destroyed: recovered + rebuilt opens', async () => {
  if (!existsSync(join(here, 'fixtures', 'real-nocd.docx'))) return; // non-mac CI
  const bytes = fx('real-nocd.docx');
  assert.equal(textutilReads(bytes, 'tmp-real-nocd-in.docx'), null, 'fixture should be unreadable');
  const r = await rescue(bytes, 'real-nocd.docx');
  const text = reportToText(r);
  assert.match(text, /REAL_SENTINEL_ONE/);
  assert.match(text, /REAL_SENTINEL_TWO/);
  assert.ok(r.rebuiltDocx);
  const roundTrip = textutilReads(r.rebuiltDocx, 'tmp-real-rebuilt.docx');
  assert.ok(roundTrip, 'rebuilt real docx readable');
  assert.match(roundTrip, /REAL_SENTINEL_ONE/);
});

test('REAL truncated docx: partial recovery from the front', async () => {
  if (!existsSync(join(here, 'fixtures', 'real-truncated.docx'))) return;
  const r = await rescue(fx('real-truncated.docx'), 'real-truncated.docx');
  const text = reportToText(r);
  assert.ok(text.length > 0, 'some text recovered from truncated real docx');
});

test('legacy .doc: raw text salvage finds the prose', async () => {
  if (!existsSync(join(here, 'fixtures', 'real.doc'))) return;
  const r = await rescue(fx('real.doc'), 'real.doc');
  assert.equal(r.kind, 'doc-legacy');
  const text = reportToText(r);
  assert.match(text, /REAL_SENTINEL_ONE/);
});

test('garbage input: never throws, honest result', async () => {
  const noise = new Uint8Array(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + 7) & 0xff;
  const r = await rescue(noise, 'noise.bin');
  assert.ok(['dead', 'partial'].includes(r.containerHealth));
});
