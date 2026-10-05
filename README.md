# Mendery

**Recover the words inside a corrupted document — entirely in your browser.**
Live at **[mendery.dsl4.com](https://mendery.dsl4.com)** · free · open source · no upload, ever.

When Word says *"unreadable content"*, when a download dies half-way, when a sync
client mangles your thesis — it is usually the file's **index** that broke, not
your writing. Office documents (.docx/.xlsx/.pptx/.odt) are ZIP archives whose
table of contents sits at the very end of the file, exactly where truncation
hits. Mendery ignores the index: it scans the raw bytes for the local signatures
that precede each inner file, decompresses whatever survives (keeping partial
output when a stream dies mid-way), and turns the recovered XML back into
readable text. If enough survived, it rebuilds a fresh .docx that opens in Word.

SQLite databases get the same treatment at the page level: every page is read
independently, so a destroyed header or index region only costs the rows that
physically lived there.

## What it handles

| Input | Result |
|---|---|
| .docx / .odt with broken ZIP index or truncation | text, headings, lists, tables + rebuilt .docx |
| .xlsx | cell values per sheet + CSV export |
| .pptx | slide text in order |
| SQLite .db / .sqlite (even with destroyed header) | rows per table + CSV export |
| legacy .doc / anything else | best-effort readable-text extraction |
| fully zeroed files | an honest "not recoverable" + a guide to the real fallbacks (AutoRecover, cloud version history) |

## Privacy, provably

The page ships a strict Content-Security-Policy with `connect-src 'none'`:
the **browser itself** forbids the page from sending data anywhere. Open
DevTools → Network while using it — nothing leaves. It keeps working offline.
No cookies, no analytics, no accounts.

## Run / develop

No build step. Any static file server:

```sh
python3 -m http.server 8971 -d public
```

Tests (Node ≥ 22.5, uses `node:sqlite` and macOS `textutil` as a behavior-level
oracle where available):

```sh
npm test
```

The engine (`public/engine.js`, `public/sqlite.js`) is dependency-free apart
from a vendored copy of [fflate](https://github.com/101arrowz/fflate) (MIT)
for streaming DEFLATE — chosen over native `DecompressionStream` because the
native transform discards queued output when a stream errors mid-way, which is
exactly the moment a recovery tool needs the partial output most.

## Deploy

Cloudflare Workers static assets:

```sh
npx wrangler deploy
```

`wrangler.jsonc` binds the custom domain. `public/_headers` carries the CSP.

## Prior art & lineage

The salvage technique descends from `zip -FF`, [BruteZip](https://git.zx2c4.com/BruteZip/about/)
and Paul D. Pruitt's [Universal-File-Repair-Tool](https://github.com/socrtwo/Universal-File-Repair-Tool)
/ [Corrupt DOCX Salvager](https://sourceforge.net/projects/damageddocx2txt/).
Closed-source in-browser ZIP/docx repair also exists — [ezyZip](https://www.ezyzip.com/repair-zip-en.html)
and [MyFileFixer](https://myfilefixer.com/) both run client-side repair with
freemium upsells. Mendery is an independent, from-scratch implementation; what
it adds is the **open** combination: MIT source anyone can audit or fork, a
privacy promise *enforced* by the browser (CSP `connect-src 'none'`, not just
claimed), truncation-tolerant structured preview, honest damage reporting with
real fallback routes — plus (as far as we could find) the first fully
in-browser corrupted-SQLite row scavenger.

## License

MIT. Fork it, mirror it, translate it. If it saved your work, pass the link on.
