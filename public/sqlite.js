/*
 * Mendery engine — SQLite module.
 * SPDX-License-Identifier: MIT
 *
 * Recovers rows from corrupted SQLite databases entirely in the browser.
 * Unlike the normal SQLite library, this never trusts the file: it scans
 * every page independently, so a corrupted header, broken b-tree interior,
 * or zeroed region only costs the rows that physically lived there.
 *
 * File-format reference: https://www.sqlite.org/fileformat2.html
 *  - 100-byte header: magic "SQLite format 3\0", page size (BE u16 @16,
 *    value 1 means 65536), reserved bytes/page (@20), text encoding (@56).
 *  - B-tree pages: type byte 2/5 (interior index/table), 10/13 (leaf
 *    index/table). Leaf-table cells: varint payload length, varint rowid,
 *    record. Large payloads spill to a linked list of overflow pages.
 *  - Record: varint header length, serial-type varints, then values.
 */

const PAGE_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

/** SQLite varint: 1-9 bytes, big-endian 7-bit groups. Returns [value, width]. */
function readVarint(b, o) {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    if (o + i >= b.length) throw new Error('varint out of range');
    const byte = b[o + i];
    v = (v << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return [v, i + 1];
  }
  if (o + 8 >= b.length) throw new Error('varint out of range');
  v = (v << 8n) | BigInt(b[o + 8]);
  return [v, 9];
}

const toNum = (v) => (v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString());

// ---------------------------------------------------------------------------
// Header + page-size inference
// ---------------------------------------------------------------------------

export function parseHeader(bytes) {
  const dec = new TextDecoder('latin1');
  const magicOk = bytes.length >= 100 && dec.decode(bytes.subarray(0, 15)) === 'SQLite format 3';
  if (!magicOk) return null;
  let pageSize = u16be(bytes, 16);
  if (pageSize === 1) pageSize = 65536;
  if (!PAGE_SIZES.includes(pageSize)) return null;
  const reserved = bytes[20];
  const encVal = u32be(bytes, 56);
  const encoding = encVal === 2 ? 'utf-16le' : encVal === 3 ? 'utf-16be' : 'utf-8';
  return { pageSize, reserved, encoding };
}

function pageTypeAt(bytes, off) {
  const t = bytes[off];
  return t === 2 || t === 5 || t === 10 || t === 13 ? t : 0;
}

/** Score how b-tree-like the file looks at a candidate page size. */
function scorePageSize(bytes, pageSize) {
  let score = 0, pages = 0;
  const n = Math.floor(bytes.length / pageSize);
  for (let p = 2; p <= Math.min(n, 200); p++) {
    const off = (p - 1) * pageSize;
    pages++;
    const t = pageTypeAt(bytes, off);
    if (!t) continue;
    const cells = u16be(bytes, off + 3);
    const contentStart = u16be(bytes, off + 5);
    if (cells >= 1 && cells <= pageSize / 4 && contentStart >= 8 && contentStart <= pageSize) score++;
  }
  return pages ? score / pages : 0;
}

/**
 * Detect a SQLite file even when the 100-byte header was destroyed.
 * Candidates are tried smallest-first: any multiple of the true page size
 * only samples true page starts (so it scores well too), but smaller-than-
 * true candidates sample mid-page bytes and score badly — therefore the
 * first candidate that scores well is the true size.
 */
export function sniffSqlite(bytes) {
  const hdr = parseHeader(bytes);
  if (hdr) return { ...hdr, headerIntact: true };
  if (bytes.length < 1024) return null;
  for (const ps of PAGE_SIZES) {
    if (bytes.length < ps * 2) continue;
    if (scorePageSize(bytes, ps) >= 0.4) {
      return { pageSize: ps, reserved: 0, encoding: 'utf-8', headerIntact: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Record (row) decoding
// ---------------------------------------------------------------------------

function decodeRecord(payload, encoding) {
  const [hdrLen, w0] = readVarint(payload, 0);
  const hl = Number(hdrLen);
  if (hl < w0 || hl > payload.length + 9) throw new Error('bad record header');
  const types = [];
  let o = w0;
  while (o < hl && o < payload.length) {
    const [t, w] = readVarint(payload, o);
    types.push(Number(t));
    o += w;
  }
  const values = [];
  let d = hl;
  const dec = new TextDecoder(encoding, { fatal: false });
  for (const t of types) {
    if (t === 0) { values.push(null); continue; }
    if (t === 8) { values.push(0); continue; }
    if (t === 9) { values.push(1); continue; }
    let size;
    if (t === 1) size = 1; else if (t === 2) size = 2; else if (t === 3) size = 3;
    else if (t === 4) size = 4; else if (t === 5) size = 6; else if (t === 6) size = 8;
    else if (t === 7) size = 8;
    else if (t >= 12) size = (t - (t % 2 === 0 ? 12 : 13)) / 2;
    else throw new Error('bad serial type');
    if (d + size > payload.length) {
      // Payload cut short (lost overflow page / truncation): keep what we have.
      if (t >= 13 && d < payload.length) {
        values.push(dec.decode(payload.subarray(d)) + ' […cut off here]');
      } else {
        values.push('[damaged]');
      }
      d = payload.length;
      continue;
    }
    if (t >= 1 && t <= 6) {
      let v = 0n;
      for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(payload[d + i]);
      // sign-extend
      const bits = BigInt(size * 8);
      if (v >= 1n << (bits - 1n)) v -= 1n << bits;
      values.push(toNum(v));
    } else if (t === 7) {
      const dv = new DataView(payload.buffer, payload.byteOffset + d, 8);
      values.push(dv.getFloat64(0, false));
    } else if (t % 2 === 0) {
      values.push(`[blob ${size} bytes]`);
    } else {
      values.push(dec.decode(payload.subarray(d, d + size)));
    }
    d += size;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Page-level cell extraction
// ---------------------------------------------------------------------------

function readLeafTablePage(bytes, pageNo, ctx) {
  const { pageSize, reserved, encoding } = ctx;
  const base = (pageNo - 1) * pageSize;
  const hdrOff = pageNo === 1 ? base + 100 : base;
  if (bytes[hdrOff] !== 13) return null;
  const U = pageSize - reserved;
  const X = U - 35;
  const M = Math.floor(((U - 12) * 32) / 255) - 23;
  const cellCount = u16be(bytes, hdrOff + 3);
  if (cellCount > pageSize / 2) return null;
  const ptrArray = hdrOff + 8;
  const rows = [];
  let damaged = 0;
  for (let i = 0; i < cellCount; i++) {
    try {
      const cellOff = base + u16be(bytes, ptrArray + i * 2);
      if (cellOff <= base || cellOff >= base + pageSize) { damaged++; continue; }
      const [payloadLen, w1] = readVarint(bytes, cellOff);
      const P = Number(payloadLen);
      const [rowid, w2] = readVarint(bytes, cellOff + w1);
      let payload;
      let cut = false;
      if (P <= X) {
        const start = cellOff + w1 + w2;
        if (start + P > bytes.length) { payload = bytes.subarray(start); cut = true; }
        else payload = bytes.subarray(start, start + P);
      } else {
        const K = M + ((P - M) % (U - 4));
        const local = K <= X ? K : M;
        const start = cellOff + w1 + w2;
        const parts = [bytes.subarray(start, Math.min(start + local, bytes.length))];
        let got = parts[0].length;
        let next = u32be(bytes, start + local);
        const seen = new Set();
        while (next > 0 && got < P) {
          if (seen.has(next) || next * pageSize > bytes.length + pageSize) { cut = true; break; }
          seen.add(next);
          const po = (next - 1) * pageSize;
          if (po + 4 > bytes.length) { cut = true; break; }
          const take = Math.min(U - 4, P - got, bytes.length - (po + 4));
          parts.push(bytes.subarray(po + 4, po + 4 + take));
          got += take;
          next = u32be(bytes, po);
        }
        if (got < P) cut = true;
        const joined = new Uint8Array(got);
        let o = 0;
        for (const part of parts) { joined.set(part, o); o += part.length; }
        payload = joined;
      }
      const values = decodeRecord(payload, encoding);
      rows.push({ rowid: toNum(rowid), values, cut });
      if (cut) damaged++;
    } catch {
      damaged++;
    }
  }
  return { rows, damaged };
}

/** Walk a table b-tree from a root page, collecting leaf page numbers. */
function collectLeafPages(bytes, root, ctx, visited = new Set()) {
  const { pageSize } = ctx;
  const leaves = [];
  const stack = [root];
  const maxPage = Math.ceil(bytes.length / pageSize);
  while (stack.length) {
    const p = stack.pop();
    if (!p || p < 1 || p > maxPage || visited.has(p)) continue;
    visited.add(p);
    const base = (p - 1) * pageSize;
    const hdrOff = p === 1 ? base + 100 : base;
    const t = bytes[hdrOff];
    if (t === 13) { leaves.push(p); continue; }
    if (t !== 5) continue; // not a table page
    const cellCount = u16be(bytes, hdrOff + 3);
    if (cellCount > pageSize / 2) continue;
    stack.push(u32be(bytes, hdrOff + 8)); // right-most pointer
    for (let i = 0; i < cellCount; i++) {
      const cellOff = base + u16be(bytes, hdrOff + 12 + i * 2);
      if (cellOff > base && cellOff + 4 <= bytes.length) stack.push(u32be(bytes, cellOff));
    }
  }
  return leaves;
}

// ---------------------------------------------------------------------------
// Schema recovery (sqlite_master) + naive CREATE TABLE column parsing
// ---------------------------------------------------------------------------

const CONSTRAINT_WORDS = new Set(['primary', 'unique', 'check', 'foreign', 'constraint']);

export function parseCreateColumns(sql) {
  if (!sql) return null;
  const m = sql.match(/\(([\s\S]*)\)/);
  if (!m) return null;
  const inner = m[1];
  const cols = [];
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const tok = p.trim().split(/\s+/)[0]?.replace(/^["'`\[]|["'`\]]$/g, '');
    if (!tok) continue;
    if (CONSTRAINT_WORDS.has(tok.toLowerCase())) continue;
    cols.push(tok);
  }
  return cols.length ? cols : null;
}

/**
 * Index of the INTEGER PRIMARY KEY column, if any. SQLite stores that column
 * as NULL in the record payload (the real value is the rowid), so the reader
 * must substitute the rowid to reproduce what the user actually had.
 */
export function parseIpkIndex(sql, columns) {
  if (!sql || !columns) return -1;
  const m = sql.match(/\(([\s\S]*)\)/);
  if (!m) return -1;
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of m[1]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    if (/^\s*["'`\[]?\w+["'`\]]?\s+INTEGER\s+PRIMARY\s+KEY/i.test(p)) {
      const name = p.trim().split(/\s+/)[0].replace(/^["'`\[]|["'`\]]$/g, '');
      return columns.indexOf(name);
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Top-level salvage
// ---------------------------------------------------------------------------

/**
 * Pages currently on the freelist (freed by DROP TABLE / vacuumable space).
 * Excluded from the orphan scan so the tool recovers what the user HAS, not
 * what they deliberately deleted. Only knowable while the header page is
 * intact — callers must disclose the ambiguity otherwise.
 */
function freelistPages(bytes, ctx) {
  const pages = new Set();
  if (!ctx.headerIntact || bytes.length < 40) return pages;
  const declared = u32be(bytes, 36);
  const maxPage = Math.ceil(bytes.length / ctx.pageSize);
  let trunk = u32be(bytes, 32);
  const seen = new Set();
  while (trunk > 0 && trunk <= maxPage && !seen.has(trunk) && pages.size <= declared + 512) {
    seen.add(trunk);
    pages.add(trunk);
    const base = (trunk - 1) * ctx.pageSize;
    if (base + 8 > bytes.length) break;
    const next = u32be(bytes, base);
    const n = Math.min(u32be(bytes, base + 4), Math.floor((ctx.pageSize - 8) / 4));
    for (let i = 0; i < n; i++) {
      const p = u32be(bytes, base + 8 + i * 4);
      if (p > 0 && p <= maxPage) pages.add(p);
    }
    trunk = next;
  }
  return pages;
}

export function salvageSqlite(bytes) {
  const report = {
    ok: false,
    headerIntact: false,
    pageSize: 0,
    encoding: 'utf-8',
    tables: [],   // {name, columns|null, rows:[{rowid, values, cut}], damaged, attributed}
    stats: { pages: 0, leafPages: 0, rowsRecovered: 0, cellsDamaged: 0 },
    notes: [],
  };
  const ctx = sniffSqlite(bytes);
  if (!ctx) return report;
  report.ok = true;
  report.headerIntact = ctx.headerIntact;
  report.pageSize = ctx.pageSize;
  report.encoding = ctx.encoding;
  if (!ctx.headerIntact) report.notes.push(`The database header is destroyed. Page size was inferred as ${ctx.pageSize} bytes from the surviving page structure.`);
  const maxPage = Math.ceil(bytes.length / ctx.pageSize);
  report.stats.pages = maxPage;

  // 1) Try to read the schema table (sqlite_master) from page 1.
  const visited = new Set();
  const schema = []; // {type, name, tblName, rootpage, sql}
  const masterLeaves = collectLeafPages(bytes, 1, ctx, visited);
  for (const p of masterLeaves) {
    const res = readLeafTablePage(bytes, p, ctx);
    if (!res) continue;
    for (const row of res.rows) {
      const [type, name, tblName, rootpage, sql] = row.values;
      if ((type === 'table' || type === 'index') && typeof name === 'string' && typeof rootpage === 'number') {
        schema.push({ type, name, tblName, rootpage, sql: typeof sql === 'string' ? sql : null });
      }
    }
  }
  const tables = schema.filter((s) => s.type === 'table' && !s.name.startsWith('sqlite_'));
  const indexRoots = new Set(schema.filter((s) => s.type === 'index').map((s) => s.rootpage));
  if (!tables.length && schema.length === 0) {
    report.notes.push('The schema catalogue (sqlite_master) could not be read — recovered rows are grouped by shape instead of table name.');
  }

  // 2) Walk each known table's tree.
  const attributedPages = new Set(visited);
  for (const t of tables) {
    const leaves = collectLeafPages(bytes, t.rootpage, ctx, attributedPages);
    const rows = [];
    let damaged = 0;
    for (const p of leaves) {
      const res = readLeafTablePage(bytes, p, ctx);
      if (!res) continue;
      rows.push(...res.rows);
      damaged += res.damaged;
    }
    const columns = parseCreateColumns(t.sql);
    const ipk = parseIpkIndex(t.sql, columns);
    if (ipk >= 0) {
      for (const row of rows) if (row.values[ipk] === null) row.values[ipk] = row.rowid;
    }
    report.tables.push({ name: t.name, columns, rows, damaged, attributed: true });
    report.stats.leafPages += leaves.length;
  }

  // 3) Scan every remaining page for orphaned leaf-table pages (their
  //    interior pages — or the whole schema — were destroyed). Freed pages
  //    (DROP TABLE leftovers) are excluded when the freelist is readable:
  //    this tool recovers what the user has, not what they deleted.
  const freed = freelistPages(bytes, ctx);
  if (!ctx.headerIntact) {
    report.notes.push('Because the database header is destroyed, freed (deleted) pages cannot be told apart from live ones — recovered rows may include content that had been deleted from the database.');
  }
  const orphanGroups = new Map(); // colCount -> rows
  // Overflow pages can look like anything; only accept pages whose cells fully parse.
  for (let p = 2; p <= maxPage; p++) {
    if (attributedPages.has(p) || indexRoots.has(p) || freed.has(p)) continue;
    const base = (p - 1) * ctx.pageSize;
    if (bytes[base] !== 13) continue;
    const res = readLeafTablePage(bytes, p, ctx);
    if (!res || !res.rows.length) continue;
    // Heuristic: require most cells to parse to avoid junk from random data.
    if (res.damaged > res.rows.length) continue;
    for (const row of res.rows) {
      const k = row.values.length;
      if (!orphanGroups.has(k)) orphanGroups.set(k, []);
      orphanGroups.get(k).push(row);
    }
    report.stats.leafPages++;
  }
  for (const [colCount, rows] of [...orphanGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    // If exactly one known table has this column count, these rows very
    // likely belong to it (its interior pages were destroyed).
    const match = report.tables.filter((t) => t.columns && t.columns.length === colCount);
    if (match.length === 1) {
      match[0].rows.push(...rows);
      match[0].scanRecovered = (match[0].scanRecovered || 0) + rows.length;
    } else {
      report.tables.push({ name: `recovered rows (${colCount} columns, table name lost)`, columns: null, rows, damaged: 0, attributed: false });
    }
  }

  report.stats.rowsRecovered = report.tables.reduce((a, t) => a + t.rows.length, 0);
  report.stats.cellsDamaged = report.tables.reduce((a, t) => a + t.damaged, 0);
  report.tables = report.tables.filter((t) => t.rows.length > 0);
  for (const t of report.tables) {
    if (t.scanRecovered) report.notes.push(`Table “${t.name}”: ${t.scanRecovered} row(s) were re-attached by page scan after its index structure was lost.`);
  }
  return report;
}

/** Render one recovered table as CSV (RFC 4180 quoting). */
export function tableToCsv(table) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  if (table.columns) lines.push(table.columns.map(esc).join(','));
  for (const r of table.rows) lines.push(r.values.map(esc).join(','));
  return lines.join('\n');
}
