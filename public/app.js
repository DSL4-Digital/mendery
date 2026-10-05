/* Mendery — UI layer. SPDX-License-Identifier: MIT
 *
 * Safety note: recovered content is inserted with textContent / createElement
 * only, never innerHTML — a maliciously crafted "corrupted" file cannot
 * inject markup or script into this page.
 */
import { rescue, reportToText, zipWrite } from './engine.js';
import { salvageSqlite, tableToCsv, sniffSqlite } from './sqlite.js';

const $ = (sel) => document.querySelector(sel);
const resultEl = $('#result');
const dropzone = $('#dropzone');
const fileInput = $('#file-input');

const MAX_BLOCKS = 1200;   // preview cap; full content always in the download
const MAX_ROWS = 200;      // per table/sheet preview cap

// ---------------------------------------------------------------------------
// tiny DOM helpers (no innerHTML for recovered content)
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function btn(label, className, onClick) {
  const b = el('button', `btn ${className}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function download(bytes, filename, mime) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

const baseName = (name) => (name || 'document').replace(/\.[^.]+$/, '');
const fmtInt = (n) => n.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// input wiring
// ---------------------------------------------------------------------------

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
});

['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
// whole-page drop convenience
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#demo-btn').addEventListener('click', runDemo);

async function handleFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await analyze(bytes, file.name, false);
}

// ---------------------------------------------------------------------------
// demo: build a real docx in memory, destroy its index, recover it live
// ---------------------------------------------------------------------------

const DEMO_PARAS = [
  ['Heading1', 'A letter that refused to die'],
  ['', 'Dear reader — this document was built and then deliberately destroyed a moment ago, in your browser: the ZIP index that programs need to open it was overwritten with zeros. Word would show you an error box. Every “online repair” site would ask you to upload it.'],
  ['', 'Mendery instead scanned the raw bytes, found the surviving content streams, and put the words back in front of you — the same way it will treat your real file. Nothing you drop here ever leaves your machine.'],
  ['', 'That is the whole trick: the index dies far more often than the words do. — S.'],
];

function buildDemoDocx() {
  const enc = new TextEncoder();
  const body = DEMO_PARAS.map(([style, text]) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const zip = zipWrite([
    { name: 'word/document.xml', data: enc.encode(doc) },
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
  ]);
  // destroy the central directory + EOCD — the classic corruption
  let cd = -1;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) { cd = i; break; }
  }
  zip.fill(0, cd);
  return zip;
}

async function runDemo() {
  const broken = buildDemoDocx();
  await analyze(broken, 'sample-destroyed.docx', true);
}

// ---------------------------------------------------------------------------
// analysis + rendering
// ---------------------------------------------------------------------------

async function analyze(bytes, filename, isDemo) {
  $('#fallback').classList.remove('spotlight');
  resultEl.hidden = false;
  resultEl.replaceChildren(el('p', 'diag-file', `Reading ${filename} (${fmtInt(bytes.length)} bytes)…`));
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // let the paint happen before heavy work
  await new Promise((r) => setTimeout(r, 60));

  try {
    const sq = sniffSqlite(bytes);
    if (sq) {
      renderSqlite(salvageSqlite(bytes), filename, isDemo);
    } else {
      renderDocument(await rescue(bytes, filename), filename, isDemo);
    }
  } catch (err) {
    resultEl.replaceChildren(
      el('div', 'diagnosis', ''),
    );
    const d = resultEl.firstChild;
    d.append(
      el('p', 'diag-sum', 'Something went wrong while reading this file.'),
      el('p', 'diag-file', String(err?.message || err)),
      el('p', 'trust-v', 'This shouldn’t happen — if you can share the file publicly, please open an issue on GitHub so the next person’s recovery works.'),
    );
  }
}

const HEALTH_LABEL = {
  intact: 'fully readable',
  partial: 'partially recovered',
  salvaged: 'salvaged from a broken archive',
  dead: 'nothing recoverable in this file',
};

function summaryLine(report) {
  const chars = report.textChars;
  if (report.containerHealth === 'dead') return 'The content is not inside this file anymore.';
  if (chars === 0) return 'The container was readable, but no text content survived.';
  const words = Math.round(chars / 6);
  const pages = Math.max(1, Math.round(chars / 1800));
  const qual = report.containerHealth === 'intact' ? '' : report.containerHealth === 'partial' ? ' — everything up to the damage' : '';
  return `Recovered about ${fmtInt(words)} words (≈ ${fmtInt(pages)} page${pages === 1 ? '' : 's'})${qual}.`;
}

function diagnosisCard(healthKey, filename, sumText, notes, isDemo) {
  const d = el('div', 'diagnosis');
  if (healthKey !== 'dead') d.classList.add('mended');
  const head = el('div', 'diag-head');
  head.append(el('span', `badge ${healthKey}`, HEALTH_LABEL[healthKey] || healthKey));
  head.append(el('span', 'diag-file', isDemo ? `${filename} — a sample built and destroyed in your browser just now` : filename));
  d.append(head);
  d.append(el('p', 'diag-sum', sumText));
  if (notes && notes.length) {
    const ul = el('ul', 'diag-notes');
    for (const n of notes) ul.append(el('li', '', n));
    d.append(ul);
  }
  return d;
}

function partsDetail(entries) {
  if (!entries || !entries.length) return null;
  const det = el('details', 'parts');
  det.append(el('summary', '', `what survived inside the file (${entries.length} parts found)`));
  const t = el('table');
  for (const e of entries) {
    const tr = el('tr');
    const st = el('td', e.complete ? 'st-ok' : (e.bytes > 0 ? 'st-part' : ''), e.complete ? '✓ full' : (e.bytes > 0 ? '◐ partial' : '✕ lost'));
    tr.append(st, el('td', '', e.name), el('td', '', `${fmtInt(e.bytes)} B`));
    t.append(tr);
  }
  det.append(t);
  return det;
}

function tableEl(rows, headerRow) {
  const wrap = el('div', 'tbl-wrap');
  const t = el('table');
  if (headerRow) {
    const tr = el('tr');
    for (const h of headerRow) tr.append(el('th', '', h));
    t.append(tr);
  }
  for (const r of rows) {
    const tr = el('tr');
    for (const c of r) tr.append(el('td', '', c === null || c === undefined ? '' : String(c)));
    t.append(tr);
  }
  wrap.append(t);
  return wrap;
}

function passNote() {
  return el('p', 'pass-note', 'Got your work back? Pass mendery.dsl4.com to one person who’ll need it someday — that’s the whole payment.');
}

function tryAnother() {
  const foot = el('div', 'result-foot');
  const b = btn('Try another file', 'btn-ghost', () => {
    resultEl.hidden = true;
    resultEl.replaceChildren();
    fileInput.value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  foot.append(b);
  return foot;
}

function renderDocument(report, filename, isDemo) {
  const frag = document.createDocumentFragment();
  const health = report.containerHealth;
  frag.append(diagnosisCard(health, filename, summaryLine(report), report.notes, isDemo));

  const diag = frag.firstChild;
  const parts = partsDetail(report.entries);
  if (parts) diag.append(parts);

  // actions
  const actions = el('div', 'actions');
  const fullText = reportToText(report);
  if (fullText.length > 0) {
    actions.append(btn('Copy all text', 'btn-primary', async (e) => {
      try {
        await navigator.clipboard.writeText(fullText);
        e.target.textContent = 'Copied ✓';
      } catch {
        e.target.textContent = 'Couldn’t copy — use “Download .txt”';
      }
      setTimeout(() => { e.target.textContent = 'Copy all text'; }, 2400);
    }));
    actions.append(btn('Download .txt', 'btn-ghost', () =>
      download(new TextEncoder().encode(fullText), `${baseName(filename)}-salvaged.txt`, 'text/plain;charset=utf-8')));
  }
  if (report.rebuiltDocx) {
    actions.append(btn('Download repaired .docx', 'btn-ghost', () =>
      download(report.rebuiltDocx, `${baseName(filename)}-repaired.docx`,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document')));
  }
  for (const s of report.sheets) {
    actions.append(btn(`Download ${s.name}.csv`, 'btn-ghost', () =>
      download(new TextEncoder().encode(s.rows.map((r) => r.map((v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(',')).join('\n')),
        `${baseName(filename)}-${s.name}.csv`, 'text/csv;charset=utf-8')));
  }
  if (actions.children.length) diag.append(actions);

  // content preview
  if (report.blocks.length) {
    const sheet = el('article', 'doc-sheet');
    const blocks = report.blocks.slice(0, MAX_BLOCKS);
    let list = null;
    for (const b of blocks) {
      if (b.type === 'li') {
        if (!list) { list = el('ul'); sheet.append(list); }
        list.append(el('li', '', b.text));
        continue;
      }
      list = null;
      if (b.type === 'h') sheet.append(el(`h${Math.min(4, b.level + 1)}`, '', b.text));
      else if (b.type === 'table') sheet.append(tableEl(b.rows));
      else sheet.append(el('p', '', b.text));
    }
    if (health === 'partial' || (health === 'salvaged' && report.entries.some((e) => e.name === 'word/document.xml' && !e.complete))) {
      sheet.append(el('div', 'truncation-mark', '— the file’s data is destroyed beyond this point —'));
    }
    if (report.blocks.length > MAX_BLOCKS) {
      sheet.append(el('p', 'more-note', `showing the first ${fmtInt(MAX_BLOCKS)} of ${fmtInt(report.blocks.length)} paragraphs — the download contains everything`));
    }
    frag.append(sheet);
  }

  // spreadsheets
  for (const s of report.sheets) {
    const block = el('section', 'data-block');
    const head = el('div', 'data-head');
    head.append(el('h3', '', s.name));
    head.append(el('span', 'data-count', `${fmtInt(s.rows.length)} rows${s.complete ? '' : ' (partial)'}`));
    block.append(head);
    const wrap = el('div', 'data-wrap');
    wrap.append(tableEl(s.rows.slice(0, MAX_ROWS)).firstChild);
    block.append(wrap);
    if (s.rows.length > MAX_ROWS) block.append(el('p', 'more-note', `showing ${MAX_ROWS} of ${fmtInt(s.rows.length)} rows — the CSV contains everything`));
    frag.append(block);
  }

  // slides
  for (const s of report.slides) {
    const card = el('section', 'slide-card');
    card.append(el('div', 'slide-tab', `Slide ${s.n}${s.complete ? '' : ' (partial)'}`));
    const sheet = el('div', 'doc-sheet');
    for (const line of s.lines) sheet.append(el('p', '', line));
    card.append(sheet);
    frag.append(card);
  }

  // images
  if (report.images.length) {
    const block = el('section', 'data-block');
    const head = el('div', 'data-head');
    head.append(el('h3', '', 'Recovered images'));
    head.append(el('span', 'data-count', report.images.length === 1 ? '1 image — click to save' : `${report.images.length} images — click to save`));
    block.append(head);
    const grid = el('div', 'img-grid');
    for (const img of report.images) {
      const blob = new Blob([img.data]);
      const url = URL.createObjectURL(blob);
      const a = el('a');
      a.href = url;
      a.download = img.name.split('/').pop();
      const im = el('img');
      im.src = url;
      im.alt = img.name;
      a.append(im, el('span', 'img-name', img.name.split('/').pop()));
      grid.append(a);
    }
    block.append(grid);
    frag.append(block);
  }

  // raw salvage
  if (report.rawTexts.length) {
    const block = el('section', 'data-block');
    const head = el('div', 'data-head');
    head.append(el('h3', '', 'Readable fragments found in the raw bytes'));
    head.append(el('span', 'data-count', `${report.rawTexts.length} fragment(s)`));
    block.append(head);
    const sheet = el('div', 'doc-sheet');
    for (const t of report.rawTexts.slice(0, 400)) sheet.append(el('p', 'raw-run', t));
    block.append(sheet);
    frag.append(block);
  }

  if (health === 'dead') {
    const spot = $('#fallback');
    spot.classList.add('spotlight');
    const go = el('div', 'actions');
    go.append(btn('See your real recovery options ↓', 'btn-primary', () => spot.scrollIntoView({ behavior: 'smooth' })));
    diag.append(go);
  } else if (report.textChars > 0 && !isDemo) {
    frag.append(passNote());
  }
  if (isDemo && report.textChars > 0) {
    frag.append(el('p', 'pass-note', 'That was the demonstration — the file above genuinely had its index destroyed before recovery. Now try your real one.'));
  }
  frag.append(tryAnother());
  resultEl.replaceChildren(frag);
}

function renderSqlite(sq, filename, isDemo) {
  const frag = document.createDocumentFragment();
  const health = sq.stats.rowsRecovered > 0 ? (sq.headerIntact && sq.stats.cellsDamaged === 0 ? 'intact' : 'salvaged') : 'dead';
  const sum = sq.stats.rowsRecovered > 0
    ? `Recovered ${fmtInt(sq.stats.rowsRecovered)} rows from ${sq.tables.length} table${sq.tables.length === 1 ? '' : 's'}${sq.stats.cellsDamaged ? ` (${fmtInt(sq.stats.cellsDamaged)} damaged cells)` : ''}.`
    : 'No rows could be recovered from this database.';
  frag.append(diagnosisCard(health, filename, sum, sq.notes, isDemo));
  const diag = frag.firstChild;

  const actions = el('div', 'actions');
  for (const t of sq.tables) {
    actions.append(btn(`Download ${t.name.slice(0, 24)}.csv`, sq.tables.indexOf(t) === 0 ? 'btn-primary' : 'btn-ghost', () =>
      download(new TextEncoder().encode(tableToCsv(t)), `${baseName(filename)}-${t.name.replace(/[^\w-]+/g, '_').slice(0, 40)}.csv`, 'text/csv;charset=utf-8')));
  }
  if (actions.children.length) diag.append(actions);

  for (const t of sq.tables) {
    const block = el('section', 'data-block');
    const head = el('div', 'data-head');
    head.append(el('h3', '', t.name));
    head.append(el('span', 'data-count', `${fmtInt(t.rows.length)} rows${t.damaged ? ` · ${t.damaged} damaged` : ''}`));
    block.append(head);
    const wrap = el('div', 'data-wrap');
    const rows = t.rows.slice(0, MAX_ROWS).map((r) => r.values);
    wrap.append(tableEl(rows, t.columns || undefined).firstChild);
    block.append(wrap);
    if (t.rows.length > MAX_ROWS) block.append(el('p', 'more-note', `showing ${MAX_ROWS} of ${fmtInt(t.rows.length)} rows — the CSV contains everything`));
    frag.append(block);
  }

  if (health === 'dead') {
    $('#fallback').classList.add('spotlight');
  } else if (!isDemo) {
    frag.append(passNote());
  }
  frag.append(tryAnother());
  resultEl.replaceChildren(frag);
}
