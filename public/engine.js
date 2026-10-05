/*
 * Mendery engine — recover content from corrupted office documents.
 * SPDX-License-Identifier: MIT
 *
 * Runs unchanged in any modern browser and Node 18+. The only dependency is
 * a vendored copy of fflate (MIT) for streaming DEFLATE decompression —
 * chosen over the native DecompressionStream because the native transform
 * discards its queued output when a stream errors mid-way, which is exactly
 * the moment this tool needs the partial output most.
 *
 * Strategy:
 *   .docx/.xlsx/.pptx/.odt are ZIP containers. Real-world corruption usually
 *   destroys the ZIP's central directory (the index at the END of the file)
 *   or truncates the file — but each member file inside the archive is
 *   preceded by its own local header (PK\x03\x04). We scan the raw bytes for
 *   those headers and decompress whatever streams survive, keeping partial
 *   output when a stream dies mid-way. Then we map the recovered XML back to
 *   readable text with a truncation-tolerant scanner (a normal XML parser
 *   would reject a half-recovered document).
 *
 * Prior art (technique): zip -FF, BruteZip (zx2c4), socrtwo's
 * Universal-File-Repair-Tool. This is an independent zero-dependency
 * implementation; see README for the full lineage.
 */

import { Inflate } from './vendor/fflate.js';

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50; // PK\x03\x04
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
const SIG_EOCD = 0x06054b50; // PK\x05\x06
const SIG_DESC = 0x08074b50; // PK\x07\x08 (data descriptor, optional sig)

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function concatChunks(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------
// Raw-deflate decompression that survives corrupt/truncated streams
// ---------------------------------------------------------------------------

/**
 * Inflate a raw-deflate byte range, keeping whatever was produced before a
 * corrupt or truncated tail kills the stream. Deflate is self-terminating
 * (RFC 1951 BFINAL), so trailing garbage after the true end of the stream is
 * harmless. Fed in small steps so that a corrupt region only costs the last
 * step's output, not everything. Returns { data, complete }.
 */
function inflatePass(input, step) {
  const chunks = [];
  let complete = false;
  const inf = new Inflate();
  inf.ondata = (chunk, final) => {
    if (chunk && chunk.length) chunks.push(chunk);
    if (final) complete = true;
  };
  try {
    for (let i = 0; i < input.length && !complete; i += step) {
      inf.push(input.subarray(i, Math.min(i + step, input.length)));
    }
    if (!complete) inf.push(new Uint8Array(0), true);
  } catch {
    // Corrupt mid-stream or truncated: keep the chunks already produced.
  }
  return { data: concatChunks(chunks), complete };
}

export function inflateRaw(input) {
  // Fast pass with big steps. fflate emits output per push, so a corrupt
  // byte costs the whole current step's output — if the stream didn't
  // finish cleanly, retry with tiny steps to claw back everything up to
  // the corruption point. Only damaged entries pay the fine-grained cost.
  const fast = inflatePass(input, 1 << 16);
  if (fast.complete) return fast;
  const fine = inflatePass(input, 512);
  return fine.data.length > fast.data.length ? fine : fast;
}

// ---------------------------------------------------------------------------
// ZIP reading — strict path and salvage path
// ---------------------------------------------------------------------------

function findEocd(bytes) {
  // EOCD is within the last 22 + 65535 bytes (trailing comment can pad it).
  const start = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (u32(bytes, i) === SIG_EOCD) return i;
  }
  return -1;
}

function saneName(name) {
  if (!name || name.length > 300) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Parse a local file header at `off`. Returns null if implausible. */
function parseLocalHeader(bytes, off) {
  if (off + 30 > bytes.length) return null;
  if (u32(bytes, off) !== SIG_LOCAL) return null;
  const flags = u16(bytes, off + 6);
  const method = u16(bytes, off + 8);
  const crc = u32(bytes, off + 14);
  const compSize = u32(bytes, off + 18);
  const uncompSize = u32(bytes, off + 22);
  const nameLen = u16(bytes, off + 26);
  const extraLen = u16(bytes, off + 28);
  if (nameLen === 0 || nameLen > 300 || extraLen > 8192) return null;
  if (off + 30 + nameLen > bytes.length) return null;
  if (method !== 0 && method !== 8) return null; // stored | deflate only
  const name = utf8.decode(bytes.subarray(off + 30, off + 30 + nameLen));
  if (!saneName(name)) return null;
  return {
    name, method, flags, crc, compSize, uncompSize,
    dataStart: Math.min(off + 30 + nameLen + extraLen, bytes.length),
    headerStart: off,
  };
}

/** Find the next PK boundary signature at or after `from` (for stored entries). */
function nextBoundary(bytes, from) {
  for (let i = from; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b) {
      const s = u32(bytes, i);
      if (s === SIG_LOCAL || s === SIG_CENTRAL || s === SIG_EOCD || s === SIG_DESC) return i;
    }
  }
  return -1;
}

/**
 * Extract one entry given its parsed local header.
 * Returns { name, data, complete } — data may be a partial prefix.
 */
function extractEntry(bytes, hdr) {
  const { method, flags, compSize, dataStart } = hdr;
  const hasDescriptor = (flags & 0x8) !== 0;
  const sizeLooksUsable = !hasDescriptor && compSize > 0 && compSize < bytes.length && dataStart + compSize <= bytes.length;

  if (method === 0) {
    // Stored: the slice is the content itself. Stored data has no built-in
    // integrity check (unlike deflate), so verify the header's CRC rather
    // than marking silently-corrupted bytes as "✓ full".
    if (sizeLooksUsable) {
      const data = bytes.subarray(dataStart, dataStart + compSize);
      const crcOk = hdr.crc === 0 || crc32(data) === hdr.crc;
      return { name: hdr.name, data, complete: crcOk };
    }
    const next = nextBoundary(bytes, dataStart);
    const end = next === -1 ? bytes.length : next;
    return { name: hdr.name, data: bytes.subarray(dataStart, end), complete: false };
  }

  // Deflate: self-terminating, so when sizes are unknown or corrupt we can
  // feed everything to EOF — the inflater stops at the real end of stream.
  const end = sizeLooksUsable ? dataStart + compSize : bytes.length;
  const { data, complete } = inflateRaw(bytes.subarray(dataStart, end));
  return { name: hdr.name, data, complete };
}

/** Strict parse via EOCD + central directory. Throws if the index is broken. */
function readCentralDirectory(bytes) {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error('no EOCD');
  const count = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0 || cdOffset >= bytes.length) throw new Error('central directory out of range');
  const headers = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== SIG_CENTRAL) throw new Error('central directory damaged');
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const hdr = parseLocalHeader(bytes, localOffset);
    if (!hdr) throw new Error('local header damaged');
    headers.push(hdr);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return headers;
}

/** Salvage parse: scan every offset for local file headers. */
function scanLocalHeaders(bytes) {
  const headers = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      const hdr = parseLocalHeader(bytes, i);
      if (hdr) {
        headers.push(hdr);
        // Skip past the name/extra so we don't re-match inside this header.
        // We do NOT skip the data: false positives there are filtered by the
        // plausibility checks in parseLocalHeader.
        i = hdr.dataStart - 1;
      }
    }
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Container detection
// ---------------------------------------------------------------------------

function zeroFraction(bytes) {
  if (bytes.length === 0) return 1;
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  let zeros = 0, total = 0;
  for (let i = 0; i < bytes.length; i += step) { total++; if (bytes[i] === 0) zeros++; }
  return zeros / total;
}

function hasLocalSig(bytes) {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) return true;
  }
  return false;
}

export function detectContainer(bytes) {
  if (bytes.length < 8) return 'too-small';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'ole2';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes.length >= 16 && utf8.decode(bytes.subarray(0, 15)) === 'SQLite format 3') return 'sqlite';
  if (zeroFraction(bytes) > 0.98) return 'zeroed';
  // A zip whose first bytes were overwritten can still hold headers deeper in.
  if (hasLocalSig(bytes)) return 'zip-headless';
  return 'unknown';
}

function detectKind(entryNames, filename) {
  const names = new Set(entryNames);
  const has = (p) => entryNames.some((n) => n.startsWith(p));
  if (names.has('word/document.xml') || has('word/')) return 'docx';
  if (names.has('xl/workbook.xml') || has('xl/')) return 'xlsx';
  if (has('ppt/')) return 'pptx';
  if (names.has('content.xml')) return 'odf';
  const ext = (filename || '').toLowerCase().match(/\.(\w+)$/)?.[1];
  if (ext === 'docx' || ext === 'docm') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'pptx' || ext === 'pptm') return 'pptx';
  if (ext === 'odt' || ext === 'ods' || ext === 'odp') return 'odf';
  return 'zip';
}

// ---------------------------------------------------------------------------
// XML entity decoding + truncation-tolerant tag scanner
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/**
 * Tokenize XML forgivingly: never throws, tolerates a truncated final tag.
 * Yields { type:'text', text } and { type:'tag', name, close, self, raw }.
 */
export function* xmlTokens(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { if (i < n) yield { type: 'text', text: s.slice(i) }; return; }
    if (lt > i) yield { type: 'text', text: s.slice(i, lt) };
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) return; // truncated mid-tag: drop the fragment
    let raw = s.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('?') || raw.startsWith('!')) continue; // PI / comment / doctype
    let close = false, self = false;
    if (raw.startsWith('/')) { close = true; raw = raw.slice(1); }
    if (raw.endsWith('/')) { self = true; raw = raw.slice(0, -1); }
    const sp = raw.search(/[\s/]/);
    const name = (sp === -1 ? raw : raw.slice(0, sp)).trim();
    if (!name) continue;
    yield { type: 'tag', name, close, self, raw };
  }
}

function attr(raw, name) {
  const m = raw.match(new RegExp(`(?:^|\\s)${name.replace(/:/g, '\\:')}="([^"]*)"`));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// DOCX: word/document.xml -> blocks
// ---------------------------------------------------------------------------

/**
 * Convert WordprocessingML to structured blocks.
 * Blocks: {type:'h',level,text} {type:'p',text} {type:'li',text,level} {type:'table',rows}
 */
export function docxXmlToBlocks(xml) {
  const blocks = [];
  let para = null;         // current paragraph accumulator
  let inText = false;      // inside w:t
  let inInstr = false;     // inside w:instrText (field codes — skip)
  let inDel = false;       // inside w:delText (tracked deletions — skip)
  let table = null;        // current table: rows of cells
  let cell = null;         // current cell text accumulator
  let tableDepth = 0;

  const flushPara = () => {
    if (para === null) return;
    const text = para.text.trimEnd();
    if (text.trim().length > 0) {
      if (cell !== null) {
        cell.push(text);
      } else if (para.heading) {
        blocks.push({ type: 'h', level: para.heading, text });
      } else if (para.list) {
        blocks.push({ type: 'li', level: para.listLevel || 0, text });
      } else {
        blocks.push({ type: 'p', text });
      }
    }
    para = null;
  };

  for (const t of xmlTokens(xml)) {
    if (t.type === 'text') {
      if (inText && !inInstr && !inDel && para !== null) para.text += decodeEntities(t.text);
      continue;
    }
    const { name, close, self, raw } = t;
    switch (name) {
      case 'w:p':
        if (close) flushPara();
        else if (!self) { flushPara(); para = { text: '', heading: 0, list: false, listLevel: 0 }; }
        break;
      case 'w:t':
        if (!self) inText = !close;
        break;
      case 'w:instrText':
        if (!self) inInstr = !close;
        break;
      case 'w:delText':
        if (!self) inDel = !close;
        break;
      case 'w:tab':
        if (para !== null && !close) para.text += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (para !== null && !close) para.text += '\n';
        break;
      case 'w:pStyle': {
        if (para !== null) {
          const v = (attr(raw, 'w:val') || '').toLowerCase();
          const hm = v.match(/^(?:heading|h)\s*(\d)$/);
          if (hm) para.heading = Math.min(6, parseInt(hm[1], 10) || 1);
          else if (v === 'title') para.heading = 1;
          else if (v === 'subtitle') para.heading = 2;
          else if (v === 'listparagraph') para.list = true;
        }
        break;
      }
      case 'w:numPr':
        if (para !== null && !close) para.list = true;
        break;
      case 'w:ilvl':
        if (para !== null) para.listLevel = parseInt(attr(raw, 'w:val') || '0', 10) || 0;
        break;
      case 'w:tbl':
        if (close) {
          tableDepth--;
          if (tableDepth <= 0 && table !== null) {
            if (table.length) blocks.push({ type: 'table', rows: table });
            table = null; tableDepth = 0;
          }
        } else if (!self) {
          tableDepth++;
          if (tableDepth === 1) table = [];
        }
        break;
      case 'w:tr':
        if (tableDepth === 1 && table !== null && !close && !self) table.push([]);
        break;
      case 'w:tc':
        if (tableDepth === 1 && table !== null && table.length) {
          if (close) {
            if (cell !== null) { table[table.length - 1].push(cell.join('\n')); cell = null; }
          } else if (!self) cell = [];
        }
        break;
      default:
        break;
    }
  }
  flushPara(); // tolerate a document truncated mid-paragraph
  if (table !== null && table.length) blocks.push({ type: 'table', rows: table });
  return blocks;
}

// ---------------------------------------------------------------------------
// XLSX: sharedStrings + worksheets -> rows
// ---------------------------------------------------------------------------

export function xlsxSharedStrings(xml) {
  // Each <si> may contain one <t> or many rich-text runs <r><t>.
  const strings = [];
  let cur = null, inT = false;
  for (const t of xmlTokens(xml)) {
    if (t.type === 'text') { if (inT && cur !== null) cur += decodeEntities(t.text); continue; }
    if (t.name === 'si') {
      if (t.close) { strings.push(cur ?? ''); cur = null; }
      else if (t.self) strings.push('');
      else cur = '';
    } else if (t.name === 't') { if (!t.self) inT = !t.close; }
  }
  if (cur !== null) strings.push(cur); // truncated final entry
  return strings;
}

function cellRef(ref) {
  let col = 0, i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) col = col * 26 + (c - 64);
    else break;
  }
  return { col: col - 1, row: parseInt(ref.slice(i), 10) - 1 };
}

export function xlsxSheetToRows(xml, shared) {
  const cells = []; // {row, col, value}
  let curCell = null, capture = false, buf = '';
  const push = (val) => {
    if (curCell && curCell.ref) {
      const { col, row } = cellRef(curCell.ref);
      if (row >= 0 && col >= 0 && row < 200000 && col < 16384) cells.push({ row, col, value: val });
    }
  };
  for (const t of xmlTokens(xml)) {
    if (t.type === 'text') { if (capture && curCell) buf += decodeEntities(t.text); continue; }
    switch (t.name) {
      case 'c':
        if (t.close || t.self) curCell = null;
        else curCell = { ref: attr(t.raw, 'r'), type: attr(t.raw, 't') || 'n' };
        break;
      case 'v':
        if (curCell) {
          if (t.close) {
            let val = buf;
            if (curCell.type === 's') { const idx = parseInt(buf, 10); val = shared[idx] ?? `[lost string #${idx}]`; }
            else if (curCell.type === 'b') val = buf === '1' ? 'TRUE' : 'FALSE';
            push(val); buf = ''; capture = false;
          } else if (!t.self) { capture = true; buf = ''; }
        }
        break;
      case 't':
        if (curCell && (curCell.type === 'inlineStr' || curCell.type === 'str')) {
          if (t.close) { push(buf); buf = ''; capture = false; }
          else if (!t.self) { capture = true; buf = ''; }
        }
        break;
      default: break;
    }
  }
  if (!cells.length) return [];
  const maxRow = Math.min(200000, Math.max(...cells.map((c) => c.row)));
  const maxCol = Math.min(16384, Math.max(...cells.map((c) => c.col)));
  const rows = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(''));
  for (const c of cells) { if (c.row <= maxRow && c.col <= maxCol) rows[c.row][c.col] = c.value; }
  return rows.filter((r) => r.some((v) => v !== ''));
}

// ---------------------------------------------------------------------------
// PPTX: slides -> lines
// ---------------------------------------------------------------------------

export function pptxSlideToLines(xml) {
  const lines = [];
  let line = null, inT = false;
  for (const t of xmlTokens(xml)) {
    if (t.type === 'text') { if (inT && line !== null) line += decodeEntities(t.text); continue; }
    if (t.name === 'a:p') {
      if (t.close) { if (line && line.trim()) lines.push(line.trim()); line = null; }
      else if (!t.self) line = '';
    } else if (t.name === 'a:t') { if (!t.self) inT = !t.close; }
    else if (t.name === 'a:br') { if (line !== null && !t.close) line += '\n'; }
  }
  if (line && line.trim()) lines.push(line.trim());
  return lines;
}

// ---------------------------------------------------------------------------
// ODF (odt/ods/odp): content.xml -> blocks
// ---------------------------------------------------------------------------

export function odfContentToBlocks(xml) {
  const blocks = [];
  let para = null, heading = 0;
  let table = null, cell = null;
  let depth = 0; // nesting depth of text:p/text:h (spans keep text flowing)
  const flush = () => {
    if (para === null) return;
    const text = para.trim();
    if (text) {
      if (cell !== null) cell.push(text);
      else if (heading) blocks.push({ type: 'h', level: heading, text });
      else blocks.push({ type: 'p', text });
    }
    para = null; heading = 0;
  };
  for (const t of xmlTokens(xml)) {
    if (t.type === 'text') { if (depth > 0 && para !== null) para += decodeEntities(t.text); continue; }
    const { name, close, self, raw } = t;
    if (name === 'text:p' || name === 'text:h') {
      if (close) { depth = Math.max(0, depth - 1); if (depth === 0) flush(); }
      else if (!self) {
        depth++;
        if (depth === 1) { para = ''; heading = name === 'text:h' ? Math.min(6, parseInt(attr(raw, 'text:outline-level') || '1', 10) || 1) : 0; }
      }
    } else if (name === 'text:tab') { if (para !== null && !close) para += '\t'; }
    else if (name === 'text:line-break') { if (para !== null && !close) para += '\n'; }
    else if (name === 'text:s') { if (para !== null && !close) para += ' '.repeat(Math.min(80, parseInt(attr(raw, 'text:c') || '1', 10) || 1)); }
    else if (name === 'table:table') {
      if (close) { if (table && table.length) blocks.push({ type: 'table', rows: table }); table = null; }
      else if (!self) table = [];
    } else if (name === 'table:table-row') { if (table !== null && !close && !self) table.push([]); }
    else if (name === 'table:table-cell') {
      if (table !== null && table.length) {
        if (close) { if (cell !== null) { table[table.length - 1].push(cell.join('\n')); cell = null; } }
        else if (!self) cell = [];
      }
    }
  }
  flush();
  if (table && table.length) blocks.push({ type: 'table', rows: table });
  return blocks;
}

// ---------------------------------------------------------------------------
// Raw text salvage (legacy .doc, unknown formats) — last resort
// ---------------------------------------------------------------------------

/**
 * Extract human-readable runs from arbitrary bytes: tries UTF-16LE and
 * single-byte (CP1252) runs, keeps runs that look like language.
 */
export function rawTextSalvage(bytes, minRun = 16) {
  const runs = [];
  // Pass 1: UTF-16LE (Word 97+ stores text this way when non-ASCII present)
  let start = -1, count = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const lo = bytes[i], hi = bytes[i + 1];
    const ok = hi === 0 && ((lo >= 0x20 && lo < 0x7f) || lo === 0x0d || lo === 0x0a || lo === 0x09 || lo >= 0xa0);
    if (ok) { if (start === -1) start = i; count++; }
    else {
      if (count >= minRun) runs.push({ start, len: count * 2, enc: 'utf16' });
      start = -1; count = 0;
    }
  }
  if (count >= minRun) runs.push({ start, len: count * 2, enc: 'utf16' });
  // Pass 2: single-byte runs
  start = -1; count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const ok = (c >= 0x20 && c < 0x7f) || c === 0x0d || c === 0x0a || c === 0x09 || c >= 0xa0;
    if (ok) { if (start === -1) start = i; count++; }
    else {
      if (count >= minRun * 2) runs.push({ start, len: count, enc: '1byte' });
      start = -1; count = 0;
    }
  }
  if (count >= minRun * 2) runs.push({ start, len: count, enc: '1byte' });

  runs.sort((a, b) => a.start - b.start);
  const texts = [];
  const seen = new Set();
  const dec1 = new TextDecoder('windows-1252', { fatal: false });
  const dec16 = new TextDecoder('utf-16le', { fatal: false });
  for (const r of runs) {
    const slice = bytes.subarray(r.start, r.start + r.len);
    const text = (r.enc === 'utf16' ? dec16.decode(slice) : dec1.decode(slice)).replace(/\r/g, '\n').trim();
    // Heuristic: real prose is mostly letters/spaces/punctuation, not symbol soup.
    const wordish = (text.match(/[\p{L} .,;:'"!?()\-\n\t]/gu) || []).length;
    if (text.length < minRun || wordish / text.length < 0.72) continue;
    const key = text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// CRC32 + minimal ZIP writer (stored entries) for rebuilding files
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Write a valid ZIP with stored (uncompressed) entries: [{name, data}]. */
export function zipWrite(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const dosDate = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026-01-01, arbitrary valid date
  for (const { name, data } of entries) {
    const nameB = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameB.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, SIG_LOCAL, true);
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0, true);           // flags
    dv.setUint16(8, 0, true);           // method: stored
    dv.setUint16(10, 0, true);          // time
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameB, 30);
    parts.push(local, data);

    const cent = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cent.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cent.set(nameB, 46);
    central.push(cent);
    offset += local.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  parts.push(eocd);
  return concatChunks(parts);
}

// ---------------------------------------------------------------------------
// DOCX rebuild: repair recovered document.xml and wrap it in a valid package
// ---------------------------------------------------------------------------

/** Close any unclosed elements in (possibly truncated) XML. */
export function repairXml(xml) {
  // Drop a trailing partial tag (an unmatched '<' near the end).
  const lastLt = xml.lastIndexOf('<');
  if (lastLt > xml.lastIndexOf('>')) xml = xml.slice(0, lastLt);
  const stack = [];
  for (const t of xmlTokens(xml)) {
    if (t.type !== 'tag') continue;
    if (t.self) continue;
    if (t.close) {
      // Pop to the matching open tag if present (tolerates mis-nesting).
      const idx = stack.lastIndexOf(t.name);
      if (idx !== -1) stack.length = idx;
    } else {
      stack.push(t.name);
    }
  }
  let out = xml;
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`;
  return out;
}

/**
 * Remove elements (with their entire subtree) whose relationships or parts
 * were not recovered, and unwrap elements that only decorate text. Word
 * refuses files with dangling relationship references, so this is what makes
 * the rebuilt file actually open.
 */
export function sanitizeDocumentXml(xml, { keepRels = false } = {}) {
  const removeSubtrees = new Set(['w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference',
    'w:footnoteReference', 'w:endnoteReference', 'w:headerReference', 'w:footerReference',
    'w:altChunk', 'w:proofErr', 'w:permStart', 'w:permEnd', 'w:sectPr']);
  if (!keepRels) { removeSubtrees.add('w:drawing'); removeSubtrees.add('w:pict'); removeSubtrees.add('w:object'); }
  const unwrap = new Set(keepRels ? ['w:smartTag', 'w:fldSimple'] : ['w:hyperlink', 'w:smartTag', 'w:fldSimple']);

  let out = '';
  let skipDepth = 0, skipName = null;
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) { if (skipDepth === 0) out += xml.slice(i); break; }
    if (lt > i && skipDepth === 0) out += xml.slice(i, lt);
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) break; // truncated tag — drop
    const rawFull = xml.slice(lt, gt + 1);
    let raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('?') || raw.startsWith('!')) { if (skipDepth === 0) out += rawFull; continue; }
    let close = false, self = false;
    let r = raw;
    if (r.startsWith('/')) { close = true; r = r.slice(1); }
    if (r.endsWith('/')) { self = true; r = r.slice(0, -1); }
    const sp = r.search(/[\s/]/);
    const name = (sp === -1 ? r : r.slice(0, sp)).trim();

    if (skipDepth > 0) {
      if (name === skipName) {
        if (close) { skipDepth--; if (skipDepth === 0) skipName = null; }
        else if (!self) skipDepth++;
      }
      continue;
    }
    if (removeSubtrees.has(name)) {
      if (!close && !self) { skipDepth = 1; skipName = name; }
      continue; // self-closing or stray close: drop the tag itself
    }
    if (unwrap.has(name)) continue; // drop the tag, keep the children
    out += rawFull;
  }
  return out;
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="wmf" ContentType="image/x-wmf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>__STYLES__</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const docxMinDocument = (bodyXml) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyXml}</w:body></w:document>`;

/**
 * Build an openable .docx from recovered (possibly partial) entries.
 * If styles/rels/media were fully recovered they are carried over.
 */
export function rebuildDocx(recovered) {
  const files = new Map(recovered.map((e) => [e.name, e]));
  const doc = files.get('word/document.xml');
  if (!doc || !doc.data || doc.data.length === 0) return null;

  let xml = utf8.decode(doc.data);
  const relsEntry = files.get('word/_rels/document.xml.rels');
  const keepRels = !!(relsEntry && relsEntry.complete && doc.complete);
  xml = sanitizeDocumentXml(xml, { keepRels });
  xml = repairXml(xml);
  if (!xml.includes('<w:document')) {
    // Salvaged fragment without a root: wrap body-level content.
    xml = docxMinDocument(xml.replace(/^[\s\S]*?<w:body[^>]*>/, '').replace(/<\/w:body>[\s\S]*$/, ''));
  }
  const enc = new TextEncoder();
  const out = [];
  const styles = files.get('word/styles.xml');
  const hasStyles = !!(styles && styles.complete && styles.data.length);
  out.push({
    name: '[Content_Types].xml',
    data: enc.encode(DOCX_CONTENT_TYPES.replace('__STYLES__', hasStyles
      ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : '')),
  });
  out.push({ name: '_rels/.rels', data: enc.encode(DOCX_RELS) });
  out.push({ name: 'word/document.xml', data: enc.encode(xml) });
  if (hasStyles) out.push({ name: 'word/styles.xml', data: styles.data });
  if (keepRels) {
    out.push({ name: 'word/_rels/document.xml.rels', data: relsEntry.data });
    for (const [name, e] of files) {
      if (name.startsWith('word/media/') && e.complete && e.data.length) out.push({ name, data: e.data });
    }
  }
  return zipWrite(out);
}

// ---------------------------------------------------------------------------
// Top-level rescue
// ---------------------------------------------------------------------------

const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Main entry point. bytes: Uint8Array, filename: original name (kind hints).
 * Returns a full report — never throws on bad input.
 */
export async function rescue(bytes, filename = '') {
  const report = {
    filename,
    size: bytes.length,
    container: detectContainer(bytes),
    containerHealth: 'unknown', // intact | partial | salvaged | dead
    kind: 'unknown',
    entries: [],       // {name, complete, bytes}
    blocks: [],        // docx/odf structured content
    sheets: [],        // xlsx: [{name, rows, complete}]
    slides: [],        // pptx: [{n, lines, complete}]
    images: [],        // {name, data, complete}
    rawTexts: [],      // last-resort text runs
    rebuiltDocx: null, // Uint8Array | null
    textChars: 0,
    notes: [],
  };
  const finishRaw = (health) => {
    report.textChars = report.rawTexts.join('\n').length;
    report.containerHealth = report.rawTexts.length ? health : 'dead';
    return report;
  };

  switch (report.container) {
    case 'too-small':
      report.containerHealth = 'dead';
      report.notes.push('The file is only a few bytes long — there is no document content inside it to recover.');
      return report;
    case 'zeroed':
      report.containerHealth = 'dead';
      report.notes.push('This file is almost entirely zero bytes. The original content is no longer in this file — this typically happens when a sync client or disk error replaces the file with blank space. Recovery has to come from a backup, cloud version history, or the application’s auto-recovery folder (see the fallback guide below).');
      return report;
    case 'ole2':
      report.kind = 'doc-legacy';
      report.rawTexts = rawTextSalvage(bytes);
      report.notes.push('This is a legacy binary Office file (.doc/.xls/.ppt, pre-2007). Best-effort text extraction only — structure and formatting cannot be rebuilt here.');
      return finishRaw('partial');
    case 'pdf':
      report.kind = 'pdf';
      report.rawTexts = rawTextSalvage(bytes, 24);
      report.notes.push('PDF is not a ZIP-based document; its text is usually compressed, so raw salvage finds little. If this PDF matters, a dedicated PDF-repair tool is the right path.');
      return finishRaw('partial');
    case 'sqlite':
      report.kind = 'sqlite';
      return report; // handled by the sqlite module (kept separate for clarity)
    case 'unknown':
      report.rawTexts = rawTextSalvage(bytes);
      report.notes.push('Unrecognized file format — showing any readable text found in the raw bytes.');
      return finishRaw('partial');
    default:
      break; // zip | zip-headless
  }

  // --- ZIP path ---
  let headers;
  let strict = false;
  try {
    headers = readCentralDirectory(bytes);
    strict = true;
  } catch {
    headers = scanLocalHeaders(bytes);
  }
  if (!headers.length) {
    report.rawTexts = rawTextSalvage(bytes);
    report.notes.push('No readable ZIP entries could be located — falling back to raw text salvage.');
    return finishRaw('partial');
  }

  const recovered = [];
  for (const hdr of headers) {
    try {
      recovered.push(extractEntry(bytes, hdr));
    } catch {
      recovered.push({ name: hdr.name, data: new Uint8Array(0), complete: false });
    }
  }
  // De-duplicate by name — prefer complete, then longest.
  const byName = new Map();
  for (const e of recovered) {
    const prev = byName.get(e.name);
    if (!prev || (e.complete && !prev.complete) || (e.complete === prev.complete && e.data.length > prev.data.length)) {
      byName.set(e.name, e);
    }
  }
  const entries = [...byName.values()];
  report.entries = entries.map((e) => ({ name: e.name, complete: e.complete, bytes: e.data.length }));
  report.kind = detectKind(entries.map((e) => e.name), filename);
  report.containerHealth = strict
    ? (entries.every((e) => e.complete) ? 'intact' : 'partial')
    : 'salvaged';
  if (!strict) report.notes.push(`The file’s index is destroyed, so normal programs see nothing at all. Scanning the raw bytes found ${entries.length === 1 ? 'one piece' : entries.length + ' pieces'} of the document still inside.`);

  const get = (name) => entries.find((e) => e.name === name);
  const text = (e) => (e && e.data.length ? utf8.decode(e.data) : null);

  if (report.kind === 'docx') {
    const doc = get('word/document.xml');
    const xml = text(doc);
    if (xml) {
      report.blocks = docxXmlToBlocks(xml);
      if (!doc.complete) report.notes.push('The main text stream was only partially recovered — what you see below is the document from the beginning up to the point where the data is destroyed.');
      try {
        report.rebuiltDocx = rebuildDocx(entries);
        if (report.rebuiltDocx) {
          const relsEntry = entries.find((e) => e.name === 'word/_rels/document.xml.rels');
          const keepRels = !!(relsEntry && relsEntry.complete && doc.complete);
          const hadMedia = /<w:drawing|<w:pict|<w:object/.test(xml);
          const hadLinks = /<w:hyperlink/.test(xml);
          if (!keepRels && (hadMedia || hadLinks)) {
            const lost = [hadMedia ? 'images' : null, hadLinks ? 'hyperlink addresses' : null].filter(Boolean).join(' and ');
            report.notes.push(`The repaired .docx preserves your text, but ${lost} could not be carried over — that part of the archive did not survive.`);
          }
        }
      } catch { /* rebuild is best-effort */ }
    } else {
      report.notes.push('The main text stream (word/document.xml) could not be recovered — falling back to raw text salvage.');
      report.rawTexts = rawTextSalvage(bytes);
    }
  } else if (report.kind === 'xlsx') {
    const ssEntry = get('xl/sharedStrings.xml');
    const shared = ssEntry ? xlsxSharedStrings(text(ssEntry) || '') : [];
    const sheetEntries = entries.filter((e) => /^xl\/worksheets\/sheet[^/]*\.xml$/.test(e.name)).sort((a, b) => naturalSort(a.name, b.name));
    for (const s of sheetEntries) {
      const xml = text(s);
      if (!xml) continue;
      const rows = xlsxSheetToRows(xml, shared);
      if (rows.length) report.sheets.push({ name: s.name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), rows, complete: s.complete });
    }
    if (!report.sheets.length) { report.notes.push('No worksheet data could be recovered — falling back to raw text salvage.'); report.rawTexts = rawTextSalvage(bytes); }
    else report.notes.push('Dates in spreadsheets are stored as serial numbers — a value like 45000 may be a date. Formulas are not stored in a recoverable form; these are the last calculated values.');
    if (ssEntry && !ssEntry.complete) report.notes.push('The shared text table was only partially recovered — some cells may show “[lost string #N]”.');
  } else if (report.kind === 'pptx') {
    const slideEntries = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => naturalSort(a.name, b.name));
    for (const s of slideEntries) {
      const xml = text(s);
      if (!xml) continue;
      const lines = pptxSlideToLines(xml);
      if (lines.length) report.slides.push({ n: parseInt(s.name.match(/slide(\d+)/)[1], 10), lines, complete: s.complete });
    }
    if (!report.slides.length) { report.notes.push('No slide text could be recovered — falling back to raw text salvage.'); report.rawTexts = rawTextSalvage(bytes); }
  } else if (report.kind === 'odf') {
    const c = get('content.xml');
    const xml = text(c);
    if (xml) {
      report.blocks = odfContentToBlocks(xml);
      if (!c.complete) report.notes.push('content.xml was only partially recovered — what you see below is the document from the beginning up to the damage point.');
    } else {
      report.notes.push('content.xml could not be recovered — falling back to raw text salvage.');
      report.rawTexts = rawTextSalvage(bytes);
    }
  } else {
    report.notes.push('This is a ZIP archive but not a recognized document type — recovered member files are listed for download.');
  }

  // Recovered embedded images (docx/pptx/xlsx media, ODF Pictures)
  for (const e of entries) {
    if ((/^(word|ppt|xl)\/media\//.test(e.name) || /^Pictures\//.test(e.name)) && e.data.length > 0) {
      report.images.push({ name: e.name, data: e.data, complete: e.complete });
    }
  }

  report.textChars =
    report.blocks.reduce((a, b) => a + (b.type === 'table' ? b.rows.flat().join(' ').length : (b.text || '').length), 0)
    + report.sheets.reduce((a, s) => a + s.rows.flat().join(' ').length, 0)
    + report.slides.reduce((a, s) => a + s.lines.join(' ').length, 0)
    + report.rawTexts.join(' ').length;

  return report;
}

// ---------------------------------------------------------------------------
// Plain-text rendering of a report (shared by UI + tests)
// ---------------------------------------------------------------------------

export function reportToText(report) {
  const parts = [];
  for (const b of report.blocks) {
    if (b.type === 'h') parts.push('#'.repeat(b.level) + ' ' + b.text);
    else if (b.type === 'li') parts.push('  '.repeat(b.level) + '- ' + b.text);
    else if (b.type === 'table') parts.push(b.rows.map((r) => r.join('\t')).join('\n'));
    else parts.push(b.text);
  }
  for (const s of report.sheets) {
    parts.push(`=== ${s.name} ===`);
    parts.push(s.rows.map((r) => r.join('\t')).join('\n'));
  }
  for (const s of report.slides) {
    parts.push(`=== slide ${s.n} ===`);
    parts.push(s.lines.join('\n'));
  }
  if (report.rawTexts.length) parts.push(report.rawTexts.join('\n\n'));
  return parts.join('\n\n');
}
