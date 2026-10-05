#!/usr/bin/env node
/*
 * Build test fixtures: real and synthetic office files, then corrupt them the
 * ways files actually break in the wild (truncation, destroyed central
 * directory, flipped bytes, zeroed content).
 */
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'test', 'fixtures');
mkdirSync(out, { recursive: true });

// --- tiny zip writer with DEFLATE support (fixtures only; engine has its own store-only writer)
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  // entries: [{name, data:Buffer|string, descriptor?:boolean}]
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const flags = e.descriptor ? 0x8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5821, 12);
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.descriptor ? 0 : comp.length, 18);
    local.writeUInt32LE(e.descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    local.writeUInt16LE(0, 28);
    const chunk = [local, nameB, comp];
    if (e.descriptor) {
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(comp.length, 8);
      desc.writeUInt32LE(data.length, 12);
      chunk.push(desc);
    }
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4); cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(flags, 8);
    cent.writeUInt16LE(8, 10);
    cent.writeUInt16LE(0, 12); cent.writeUInt16LE(0x5821, 14);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(comp.length, 20);
    cent.writeUInt32LE(data.length, 24);
    cent.writeUInt16LE(nameB.length, 28);
    cent.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cent, nameB]));
    const joined = Buffer.concat(chunk);
    parts.push(joined);
    offset += joined.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return { zip: Buffer.concat([...parts, cd, eocd]), cdStart };
}

// --- corruption operators
const truncate = (buf, frac) => buf.subarray(0, Math.floor(buf.length * frac));
const zeroTail = (buf, from) => { const b = Buffer.from(buf); b.fill(0, from); return b; };
const bitflip = (buf, at, n) => { const b = Buffer.from(buf); for (let i = at; i < Math.min(at + n, b.length); i++) b[i] ^= 0xa5; return b; };

// --- synthetic DOCX with known sentinels
const paras = [];
paras.push('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>SENTINEL_START The Voyage of the Paper Boat</w:t></w:r></w:p>');
for (let i = 0; i < 220; i++) {
  paras.push(`<w:p><w:r><w:t>Paragraph ${i}: the little boat carried our words across the flood, and clause ${i} survived the water &amp; the salt — “quoted”, café, año ${1800 + i}.</w:t></w:r></w:p>`);
  if (i === 110) paras.push('<w:p><w:r><w:t>SENTINEL_MIDDLE the middle held.</w:t></w:r></w:p>');
}
paras.push('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>first list item</w:t></w:r></w:p>');
paras.push('<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>nested list item</w:t></w:r></w:p>');
paras.push('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cell B1</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>cell A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cell B2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
paras.push('<w:p><w:r><w:t>SENTINEL_END and the boat came home.</w:t></w:r></w:p>');
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paras.join('')}</w:body></w:document>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const { zip: docx, cdStart: docxCd } = buildZip([
  { name: 'word/document.xml', data: documentXml },
  { name: '[Content_Types].xml', data: contentTypes },
  { name: '_rels/.rels', data: rels },
]);
writeFileSync(join(out, 'good.docx'), docx);
writeFileSync(join(out, 'truncated.docx'), truncate(docx, 0.55));
writeFileSync(join(out, 'nocd.docx'), zeroTail(docx, docxCd));
writeFileSync(join(out, 'bitflip.docx'), bitflip(docx, Math.floor(docx.length * 0.3), 64));
writeFileSync(join(out, 'zeroed.docx'), Buffer.alloc(docx.length));

// descriptor variant (streamed-writer style, sizes unknown in local header)
const { zip: docxDesc } = buildZip([
  { name: 'word/document.xml', data: documentXml, descriptor: true },
  { name: '[Content_Types].xml', data: contentTypes },
  { name: '_rels/.rels', data: rels },
]);
writeFileSync(join(out, 'descriptor-nocd.docx'), zeroTail(docxDesc, docxDesc.length - 100));

// --- synthetic XLSX
const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Invoice</t></si><si><t>Client café</t></si><si><t>SENTINEL_SHEET paid in full</t></si></sst>`;
const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1250.5</v></c><c r="B2" t="s"><v>2</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>inline note</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>`;
const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Ledger" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;
const { zip: xlsx, cdStart: xlsxCd } = buildZip([
  { name: 'xl/workbook.xml', data: workbook },
  { name: 'xl/sharedStrings.xml', data: sharedStrings },
  { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
]);
writeFileSync(join(out, 'good.xlsx'), xlsx);
writeFileSync(join(out, 'nocd.xlsx'), zeroTail(xlsx, xlsxCd));

// --- synthetic PPTX
const slide = (n, text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>slide ${n} detail line</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const { zip: pptx, cdStart: pptxCd } = buildZip([
  { name: 'ppt/slides/slide1.xml', data: slide(1, 'SENTINEL_SLIDE_ONE quarterly plan') },
  { name: 'ppt/slides/slide2.xml', data: slide(2, 'the second slide') },
]);
writeFileSync(join(out, 'nocd.pptx'), zeroTail(pptx, pptxCd));

// --- synthetic ODT
const odtContent = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">SENTINEL_ODT heading</text:h><text:p>An OpenDocument paragraph with café and año.</text:p></office:text></office:body></office:document-content>`;
const { zip: odt, cdStart: odtCd } = buildZip([
  { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
  { name: 'content.xml', data: odtContent },
]);
writeFileSync(join(out, 'nocd.odt'), zeroTail(odt, odtCd));

// --- REAL files via macOS textutil (Apple's own Word writer/parser)
const rtf = `{\\rtf1\\ansi
{\\b REAL_SENTINEL_TITLE The Recovered Thesis}\\par
This is the first real paragraph, written through textutil, with enough prose to matter. REAL_SENTINEL_ONE.\\par
Second paragraph: results, discussion, and the part the author cried about losing. REAL_SENTINEL_TWO.\\par
}`;
writeFileSync(join(out, 'real.rtf'), rtf);
try {
  execFileSync('textutil', ['-convert', 'docx', join(out, 'real.rtf'), '-output', join(out, 'real.docx')]);
  const real = readFileSync(join(out, 'real.docx'));
  // find central directory start = first PK\x01\x02
  let cd = -1;
  for (let i = 0; i + 4 <= real.length; i++) {
    if (real[i] === 0x50 && real[i + 1] === 0x4b && real[i + 2] === 0x01 && real[i + 3] === 0x02) { cd = i; break; }
  }
  writeFileSync(join(out, 'real-nocd.docx'), zeroTail(real, cd));
  writeFileSync(join(out, 'real-truncated.docx'), truncate(real, 0.6));
  execFileSync('textutil', ['-convert', 'doc', join(out, 'real.rtf'), '-output', join(out, 'real.doc')]);
} catch (e) {
  console.error('textutil steps failed:', e.message);
}

console.log('fixtures written to', out);
