// build.mjs — KJV Verse-per-Page static site builder (v2.1, 2025-11-08)
// Node 18+ (Node 20 recommended). package.json should set "type":"module".
// Output: /dist with /<book-slug>/<chapter>/<verse>/index.html plus sitemaps, robots, CNAME.
//
// Changes in v2.1:
// - Share buttons now include inline SVG social icons.
// - Added Book/Chapter/Verse dropdown navigator (populated inline; no fetch).
//
// Run: `node build.mjs`

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------ Config ------------------------
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(__dirname, "dist");
const SITE_BASE_URL = (process.env.SITE_BASE_URL || "https://kjv.livingwordbibles.com").replace(/\/+$/, "");
const LOGO_URL = process.env.LOGO_URL || "https://static1.squarespace.com/static/68d6b7d6d21f02432fd7397b/t/690209b3567af44aabfbdaca/1761741235124/LivingWordBibles01.png";

// Primary data source: your repo (plus graceful fallbacks)
const DATA_BASES = [
  "https://cdn.jsdelivr.net/gh/Living-Word-Bibles/king-james-version@main/",
  "https://raw.githubusercontent.com/Living-Word-Bibles/king-james-version/main/",
  // fallback mirrors compatible with the same JSON schema
  "https://cdn.jsdelivr.net/gh/aruljohn/Bible-kjv@master/",
  "https://raw.githubusercontent.com/aruljohn/Bible-kjv/master/",
];

// Try Books.json both at root and in legacy subdir
const TRY_PATHS = ["", "Bible-kjv-master/"];

const BRAND_LINK = "https://www.livingwordbibles.com/read-the-bible-online/kjv";
const COPYRIGHT_LINE_LEFT = `Copyright © ${new Date().getFullYear()} | <a href="https://www.livingwordbibles.com" target="_blank" rel="noopener">Living Word Bibles</a> | All Rights Reserved`;
const FOOT_BADGE_RIGHT = "KJV Bible (Verse-per-Page) v2.1";

// ------------------------ Utils ------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
}
function fileFromName(name) {
  // Song of Solomon -> SongofSolomon.json
  return String(name).replace(/[^0-9A-Za-z]/g, "") + ".json";
}
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function fetchJSONwithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) return r.json();
      return JSON.parse(await r.text());
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

async function findBaseAndBooksJson() {
  let lastErr = "";
  for (const base of DATA_BASES) {
    for (const sub of TRY_PATHS) {
      const booksUrl = base + sub + "Books.json";
      try {
        const books = await fetchJSONwithRetry(booksUrl);
        if (Array.isArray(books) && books.length) {
          return { base, subdir: sub, books };
        }
        lastErr = `Unexpected Books.json @ ${booksUrl}`;
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  throw new Error("Could not load Books.json. " + (lastErr || ""));
}

// Normalize {chapters: ...} into {name, chapters: { [chNum]: {verseCount, verses:{[v]:text}}}}
function normalizeBook(name, data) {
  const out = { name, chapters: {} };
  const addChapter = (chNum, versesObj) => {
    const vmap = {};
    if (Array.isArray(versesObj)) {
      versesObj.forEach((v, i) => {
        if (v && typeof v === "object") {
          const num = String(v.verse ?? v.num ?? v.v ?? (i + 1));
          vmap[num] = String(v.text ?? v.t ?? "");
        } else {
          vmap[String(i + 1)] = String(v ?? "");
        }
      });
    } else if (versesObj && typeof versesObj === "object") {
      for (const [k, v] of Object.entries(versesObj)) vmap[String(k)] = String(v ?? "");
    }
    out.chapters[Number(chNum)] = { verseCount: Object.keys(vmap).length, verses: vmap };
  };

  if (data && Array.isArray(data.chapters)) {
    for (const ch of data.chapters) {
      const chNum = Number(ch.chapter);
      const vv = Array.isArray(ch.verses) ? ch.verses : (ch.verses || {});
      addChapter(chNum, vv);
    }
    return out;
  }
  if (data && typeof data === "object" && data.chapters && typeof data.chapters === "object") {
    for (const [chNum, verses] of Object.entries(data.chapters)) addChapter(chNum, verses);
    return out;
  }
  if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
    data.forEach((chap, i) => addChapter(i + 1, chap));
    return out;
  }
  throw new Error("Unrecognized book JSON structure for " + name);
}

// ------------------------ Page building helpers ------------------------
function canonicalUrl(bookSlug, chapter, verse) {
  return `${SITE_BASE_URL}/${bookSlug}/${chapter}/${verse}/`;
}
function shareLinks(url, refLabel, verseText) {
  const text = encodeURIComponent(`The Holy Bible — ${refLabel}: ${verseText}`.replace(/\s+/g, " ").slice(0, 250));
  const title = encodeURIComponent(`The Holy Bible — ${refLabel}`);
  const encUrl = encodeURIComponent(url);
  return {
    fb: `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`,
    x: `https://twitter.com/intent/tweet?url=${encUrl}&text=${text}`,
    ln: `https://www.linkedin.com/sharing/share-offsite/?url=${encUrl}`,
    email: `mailto:?subject=${title}&body=${text}%0A%0A${encUrl}`,
  };
}
function prevRef(idxOrder, currentSlug, chapter, verse, booksMap) {
  const book = booksMap.get(currentSlug);
  if (verse > 1) return { slug: currentSlug, chapter, verse: verse - 1 };
  const chNums = Object.keys(book.chapters).map(Number).sort((a, b) => a - b);
  const i = chNums.indexOf(chapter);
  if (i > 0) {
    const prevCh = chNums[i - 1];
    const vc = book.chapters[prevCh].verseCount || 1;
    return { slug: currentSlug, chapter: prevCh, verse: vc };
  }
  const bIndex = idxOrder.indexOf(currentSlug);
  if (bIndex > 0) {
    const prevBookSlug = idxOrder[bIndex - 1];
    const prevBook = booksMap.get(prevBookSlug);
    const prevChNums = Object.keys(prevBook.chapters).map(Number).sort((a, b) => a - b);
    const lastCh = prevChNums[prevChNums.length - 1];
    const lastVc = prevBook.chapters[lastCh].verseCount || 1;
    return { slug: prevBookSlug, chapter: lastCh, verse: lastVc };
  }
  return null;
}
function nextRef(idxOrder, currentSlug, chapter, verse, booksMap) {
  const book = booksMap.get(currentSlug);
  const ch = book.chapters[chapter];
  if (ch && verse < ch.verseCount) return { slug: currentSlug, chapter, verse: verse + 1 };
  const chNums = Object.keys(book.chapters).map(Number).sort((a, b) => a - b);
  const i = chNums.indexOf(chapter);
  if (i >= 0 && i < chNums.length - 1) return { slug: currentSlug, chapter: chNums[i + 1], verse: 1 };
  const bIndex = idxOrder.indexOf(currentSlug);
  if (bIndex >= 0 && bIndex < idxOrder.length - 1) {
    const nbSlug = idxOrder[bIndex + 1];
    const nb = booksMap.get(nbSlug);
    const nbChNums = Object.keys(nb.chapters).map(Number).sort((a, b) => a - b);
    return { slug: nbSlug, chapter: nbChNums[0], verse: 1 };
  }
  return null;
}
function breadCrumbJsonLd(bookName, bookSlug, chapter, verse, url) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": SITE_BASE_URL + "/" },
      { "@type": "ListItem", "position": 2, "name": "KJV", "item": SITE_BASE_URL + "/" },
      { "@type": "ListItem", "position": 3, "name": bookName, "item": `${SITE_BASE_URL}/${bookSlug}/` },
      { "@type": "ListItem", "position": 4, "name": `${bookName} ${chapter}`, "item": `${SITE_BASE_URL}/${bookSlug}/${chapter}/` },
      { "@type": "ListItem", "position": 5, "name": `${bookName} ${chapter}:${verse}`, "item": url }
    ]
  };
}

// SVG icon snippets
const ICONS = {
  fb: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M13 22v-9h3l1-4h-4V7a2 2 0 0 1 2-2h2V1h-3a5 5 0 0 0-5 5v3H7v4h3v9h3z"/></svg>',
  ig: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm5 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm6.5-1.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/></svg>',
  x:  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M18.3 2H22l-9.7 11.1L21.4 22h-7l-5.5-6.7L2.6 22H2l8.6-9.8L2 2h7l5 6.1L18.3 2z"/></svg>',
  ln: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4.98 3.5C4.98 4.9 3.9 5.9 2.5 5.9S0 4.9 0 3.5 1.1 1.5 2.5 1.5 5 2.9 5 3.5zM0 8.98h5V24H0zM8.48 8.98H13v2.05h.07c.63-1.2 2.16-2.47 4.45-2.47 4.76 0 5.64 3.14 5.64 7.23V24h-5v-6.56c0-1.56-.03-3.56-2.17-3.56-2.17 0-2.5 1.7-2.5 3.45V24h-5V8.98z"/></svg>',
  email: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2 4h20v16H2V4zm10 7L3.5 6.5h17L12 11zm0 2l8.5-6.5V20h-17V6.5L12 13z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>'
};

// Main verse page
function htmlPage({ bookName, bookSlug, chapter, verse, verseText, prev, next, booksIndex, countsMap }) {
  const refLabel = `${bookName} ${chapter}:${verse}`;
  const url = canonicalUrl(bookSlug, chapter, verse);
  const desc = (verseText || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const shares = shareLinks(url, refLabel, verseText || "");
  const ld = breadCrumbJsonLd(bookName, bookSlug, chapter, verse, url);

  // Lightweight manifest for the dropdowns
  const BOOKS_JS = JSON.stringify(booksIndex); // [{slug,name}]
  const COUNTS_JS = JSON.stringify(countsMap); // {slug: { "1":31, "2":25, ... }, ... }
  const CUR = { slug: bookSlug, chapter, verse };
  const CUR_JS = JSON.stringify(CUR);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>The Holy Bible — KJV — ${escapeHtml(refLabel)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(desc)}">
  <link rel="canonical" href="${url}">
  ${prev ? `<link rel="prev" href="${canonicalUrl(prev.slug, prev.chapter, prev.verse)}">` : ""}
  ${next ? `<link rel="next" href="${canonicalUrl(next.slug, next.chapter, next.verse)}">` : ""}
  <meta property="og:site_name" content="Living Word Bibles">
  <meta property="og:type" content="article">
  <meta property="og:title" content="The Holy Bible — KJV — ${escapeHtml(refLabel)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:url" content="${url}">
  <meta name="twitter:card" content="summary">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600;700&display=swap" rel="stylesheet">

  <style>
    :root{ --max:880px; --ink:#111; --muted:#6b7280; --line:#e5e7eb; --bg:#fff; --panel:#fafafa; }
    html,body{margin:0;padding:0;background:#f7f7f7;color:var(--ink)}
    body{font-family:"EB Garamond", Garamond, "Times New Roman", serif}
    .wrap{max-width:var(--max);margin:1rem auto;background:var(--bg);border:1px solid #ddd;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden}
    .head{display:flex;flex-direction:column;gap:.6rem;padding:1rem;border-bottom:1px solid var(--line);background:var(--panel);text-align:center}
    .brand{display:flex;flex-direction:column;align-items:center;gap:.4rem}
    .logo{height:200px;object-fit:contain}
    .title{font-weight:700;font-size:1.35rem}
    .subtitle{font-size:1rem;color:var(--muted)}
    .controls{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;justify-content:center;margin-top:.3rem}
    .sel{font:inherit;border:1px solid #ccc;border-radius:10px;padding:.45rem .6rem;background:#fff;min-width:120px}
    .btn{font:inherit;border:1px solid #bbb;background:#fff;border-radius:10px;padding:.42rem .6rem;cursor:pointer;line-height:1}
    .ref{font-weight:700;margin:.8rem auto .35rem;max-width:calc(var(--max) - 2.2rem)}
    .body{padding:1rem 1.1rem}
    .text{font-size:1.18rem;line-height:1.75}
    .nav{display:flex;justify-content:space-between;gap:.75rem;align-items:center;padding:.65rem 1rem;border-top:1px solid var(--line);background:var(--panel)}
    .nav a{border:1px solid #bbb;border-radius:10px;padding:.42rem .6rem;text-decoration:none;color:inherit;background:#fff}
    .share{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.75rem 1rem;border-top:1px solid var(--line);background:var(--panel);justify-content:center}
    .share a{display:inline-flex;align-items:center;gap:.4rem;padding:.38rem .7rem;border:1px solid #bbb;border-radius:999px;background:#fff;color:inherit;text-decoration:none}
    .icon{display:inline-flex;vertical-align:middle}
    .foot{display:flex;justify-content:space-between;gap:.75rem;align-items:center;padding:.65rem 1rem;font-size:.94rem;color:#666;border-top:1px solid var(--line);background:var(--panel)}
    .foot a{font-weight:600}
    .visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="head">
      <div class="brand">
        <a href="${BRAND_LINK}" aria-label="Living Word Bibles — KJV directory">
          <img class="logo" src="${LOGO_URL}" alt="Living Word Bibles logo" loading="lazy" decoding="async">
        </a>
        <div class="title">The Holy Bible</div>
        <div class="subtitle">King James Version</div>
      </div>

      <!-- Book / Chapter / Verse dropdown navigator -->
      <div class="controls" role="search">
        <label class="visually-hidden" for="sel-book">Book</label>
        <select id="sel-book" class="sel" aria-label="Select book"></select>

        <label class="visually-hidden" for="sel-chapter">Chapter</label>
        <select id="sel-chapter" class="sel" aria-label="Select chapter"></select>

        <label class="visually-hidden" for="sel-verse">Verse</label>
        <select id="sel-verse" class="sel" aria-label="Select verse"></select>

        <button id="go-btn" class="btn" type="button" title="Go to passage">Go</button>
      </div>
    </header>

    <main class="body" role="main">
      <div class="ref" aria-live="polite">${escapeHtml(refLabel)}</div>
      <div class="text"><span class="verse">${escapeHtml(verseText || "(Verse not found.)")}</span></div>
    </main>

    <nav class="nav" aria-label="Verse navigation">
      <div>${prev ? `<a rel="prev" href="${canonicalUrl(prev.slug, prev.chapter, prev.verse)}">◀ Previous</a>` : `<span></span>`}</div>
      <div>${next ? `<a rel="next" href="${canonicalUrl(next.slug, next.chapter, next.verse)}">Next ▶</a>` : `<span></span>`}</div>
    </nav>

    <div class="share" role="region" aria-label="Share">
      <a href="${shares.fb}" target="_blank" rel="noopener"><span class="icon">${ICONS.fb}</span> <span>Facebook</span></a>
      <a href="https://www.instagram.com/living.word.bibles/" target="_blank" rel="noopener"><span class="icon">${ICONS.ig}</span> <span>Instagram</span></a>
      <a href="${shares.x}" target="_blank" rel="noopener"><span class="icon">${ICONS.x}</span> <span>X</span></a>
      <a href="${shares.ln}" target="_blank" rel="noopener"><span class="icon">${ICONS.ln}</span> <span>LinkedIn</span></a>
      <a href="${shares.email}"><span class="icon">${ICONS.email}</span> <span>Email</span></a>
      <a href="${url}" id="copy-link"><span class="icon">${ICONS.copy}</span> <span>Copy link</span></a>
    </div>

    <footer class="foot">
      <div class="foot-left">${COPYRIGHT_LINE_LEFT}</div>
      <div class="foot-right">${FOOT_BADGE_RIGHT}</div>
    </footer>
  </div>

  <script>
  (function(){
    const SITE = ${JSON.stringify(SITE_BASE_URL)};
    const BOOKS = ${BOOKS_JS};     // [{slug,name}]
    const COUNTS = ${COUNTS_JS};   // {slug: {"1":31,...}}
    const CUR = ${CUR_JS};         // {slug, chapter, verse}

    const $ = (id) => document.getElementById(id);
    const bookSel = $("sel-book");
    const chSel = $("sel-chapter");
    const vSel = $("sel-verse");
    const goBtn = $("go-btn");
    const copyLink = document.getElementById("copy-link");

    function canonical(slug, ch, v){
      return SITE + "/" + slug + "/" + ch + "/" + v + "/";
    }

    function populateBooks(){
      bookSel.innerHTML = BOOKS.map(b =>
        "<option value=\\"" + b.slug + "\\" " + (b.slug===CUR.slug?"selected":"") + ">" + b.name + "</option>"
      ).join("");
    }

    function populateChapters(slug, chSelected){
      const chapterCounts = COUNTS[slug] || {};
      const chNums = Object.keys(chapterCounts).map(Number).sort((a,b)=>a-b);
      if (chNums.length === 0) { chSel.innerHTML = "<option>1</option>"; return; }
      chSel.innerHTML = chNums.map(n =>
        "<option value=\\"" + n + "\\" " + (n===chSelected?"selected":"") + ">" + n + "</option>"
      ).join("");
    }

    function populateVerses(slug, ch, vSelected){
      const vc = (COUNTS[slug] && COUNTS[slug][String(ch)]) ? Number(COUNTS[slug][String(ch)]) : 1;
      const opts = [];
      for (let i=1;i<=vc;i++){
        opts.push("<option value=\\"" + i + "\\" " + (i===vSelected?"selected":"") + ">" + i + "</option>");
      }
      vSel.innerHTML = opts.join("");
    }

    function refreshVerseSelect(){
      const slug = bookSel.value;
      const ch = Number(chSel.value || 1);
      populateVerses(slug, ch, 1);
    }

    // Init
    populateBooks();
    populateChapters(CUR.slug, CUR.chapter);
    populateVerses(CUR.slug, CUR.chapter, CUR.verse);

    // Events
    bookSel.addEventListener("change", () => {
      const slug = bookSel.value;
      populateChapters(slug, 1);
      refreshVerseSelect();
    });
    chSel.addEventListener("change", () => {
      refreshVerseSelect();
    });
    vSel.addEventListener("change", () => {
      const slug = bookSel.value;
      const ch = Number(chSel.value || 1);
      const v = Number(vSel.value || 1);
      window.location.href = canonical(slug, ch, v);
    });
    goBtn.addEventListener("click", () => {
      const slug = bookSel.value;
      const ch = Number(chSel.value || 1);
      const v = Number(vSel.value || 1);
      window.location.href = canonical(slug, ch, v);
    });

    if (navigator.clipboard && copyLink){
      copyLink.addEventListener("click", function(ev){
        ev.preventDefault();
        navigator.clipboard.writeText(this.href).catch(()=>{});
      });
    }
  })();
  </script>
</body>
</html>`;
}

// Optional helper pages (kept simple)
function bookIndexHtml(bookName, bookSlug, firstChapter) {
  const url = `${SITE_BASE_URL}/${bookSlug}/`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KJV — ${escapeHtml(bookName)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="King James Version — ${escapeHtml(bookName)} chapters">
  <link rel="canonical" href="${url}">
  <style>body{font-family:"EB Garamond", Garamond, "Times New Roman", serif;max-width:880px;margin:2rem auto;padding:0 1rem;line-height:1.7}</style>
</head>
<body>
  <h1>KJV — ${escapeHtml(bookName)}</h1>
  <p><a href="${BRAND_LINK}">Back to KJV Directory</a></p>
  <ul>
    <li><a href="${SITE_BASE_URL}/${bookSlug}/${firstChapter}/1/">Start reading (${escapeHtml(bookName)} ${firstChapter}:1)</a></li>
  </ul>
</body>
</html>`;
}
function chapterIndexHtml(bookName, bookSlug, chapter, verseCount) {
  const url = `${SITE_BASE_URL}/${bookSlug}/${chapter}/`;
  const items = Array.from({ length: verseCount }, (_, i) => i + 1)
    .map(v => `<li><a href="${SITE_BASE_URL}/${bookSlug}/${chapter}/${v}/">${escapeHtml(bookName)} ${chapter}:${v}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KJV — ${escapeHtml(bookName)} ${chapter}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(bookName)} ${chapter} (KJV) — verse list">
  <link rel="canonical" href="${url}">
  <style>body{font-family:"EB Garamond", Garamond, "Times New Roman", serif;max-width:880px;margin:2rem auto;padding:0 1rem;line-height:1.7} ul{columns:3;gap:1rem}</style>
</head>
<body>
  <h1>${escapeHtml(bookName)} ${chapter} — KJV</h1>
  <p><a href="${SITE_BASE_URL}/${bookSlug}/">Back to ${escapeHtml(bookName)}</a></p>
  <ul>${items}</ul>
</body>
</html>`;
}

// ------------------------ Build ------------------------
async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await ensureDir(OUT_DIR);

  const { base, subdir, books } = await findBaseAndBooksJson();

  const indexList = books.map(n => ({ name: n, slug: slugify(n), jsonUrl: base + subdir + fileFromName(n) }));
  const booksMap = new Map();

  // Preload all books + build counts map for dropdowns
  const countsMap = {}; // {slug: { "1": 31, "2": 25, ... }}
  for (const row of indexList) {
    const raw = await fetchJSONwithRetry(row.jsonUrl);
    const norm = normalizeBook(row.name, raw);
    booksMap.set(row.slug, norm);

    const chNums = Object.keys(norm.chapters).map(Number).sort((a, b) => a - b);
    const cmap = {};
    for (const ch of chNums) cmap[String(ch)] = Number(norm.chapters[ch].verseCount || 1);
    countsMap[row.slug] = cmap;
  }

  const idxOrder = indexList.map(b => b.slug);
  const booksIndex = indexList.map(b => ({ slug: b.slug, name: b.name }));

  // Helper pages
  for (const row of indexList) {
    const b = booksMap.get(row.slug);
    const chNums = Object.keys(b.chapters).map(Number).sort((a, b) => a - b);
    const bookDir = path.join(OUT_DIR, row.slug);
    await ensureDir(bookDir);
    await fs.writeFile(path.join(bookDir, "index.html"), bookIndexHtml(b.name, row.slug, chNums[0]), "utf8");
    for (const ch of chNums) {
      const chDir = path.join(bookDir, String(ch));
      await ensureDir(chDir);
      await fs.writeFile(
        path.join(chDir, "index.html"),
        chapterIndexHtml(b.name, row.slug, ch, b.chapters[ch].verseCount),
        "utf8"
      );
    }
  }

  // Verse pages
  const urls = [];
  for (const row of indexList) {
    const b = booksMap.get(row.slug);
    const chNums = Object.keys(b.chapters).map(Number).sort((a, b) => a - b);
    for (const ch of chNums) {
      const vc = b.chapters[ch].verseCount || 1;
      for (let v = 1; v <= vc; v++) {
        const p = prevRef(idxOrder, row.slug, ch, v, booksMap);
        const n = nextRef(idxOrder, row.slug, ch, v, booksMap);
        const html = htmlPage({
          bookName: b.name,
          bookSlug: row.slug,
          chapter: ch,
          verse: v,
          verseText: b.chapters[ch].verses[String(v)],
          prev: p,
          next: n,
          booksIndex,
          countsMap
        });
        const verseDir = path.join(OUT_DIR, row.slug, String(ch), String(v));
        await ensureDir(verseDir);
        await fs.writeFile(path.join(verseDir, "index.html"), html, "utf8");

        urls.push(canonicalUrl(row.slug, ch, v));
      }
    }
  }

  // Root redirect → Genesis 1:1
  const firstUrl = urls[0] || `${SITE_BASE_URL}/genesis/1/1/`;
  await fs.writeFile(path.join(OUT_DIR, "index.html"), `<!doctype html><meta http-equiv="refresh" content="0; url=${firstUrl}">`, "utf8");

  // robots.txt
  await fs.writeFile(path.join(OUT_DIR, "robots.txt"),
`User-agent: *
Allow: /
Sitemap: ${SITE_BASE_URL}/sitemap.xml
`, "utf8");

  // Sitemaps (chunk under 50k)
  const CHUNK = 50000;
  if (urls.length <= CHUNK) {
    const sm = urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n");
    await fs.writeFile(path.join(OUT_DIR, "sitemap.xml"),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sm}
</urlset>`, "utf8");
  } else {
    const parts = Math.ceil(urls.length / CHUNK);
    const indexItems = [];
    for (let i = 0; i < parts; i++) {
      const slice = urls.slice(i * CHUNK, (i + 1) * CHUNK);
      const sm = slice.map(u => `  <url><loc>${u}</loc></url>`).join("\n");
      const fname = `sitemap-${i + 1}.xml`;
      await fs.writeFile(path.join(OUT_DIR, fname),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sm}
</urlset>`, "utf8");
      indexItems.push(`  <sitemap><loc>${SITE_BASE_URL}/${fname}</loc></sitemap>`);
    }
    await fs.writeFile(path.join(OUT_DIR, "sitemap.xml"),
`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexItems.join("\n")}
</sitemapindex>`, "utf8");
  }

  // CNAME for custom domain
  await fs.writeFile(path.join(OUT_DIR, "CNAME"), "kjv.livingwordbibles.com\n", "utf8");

  console.log(`Build complete. Pages: ${urls.length}. Output: ${OUT_DIR}`);
}

main().catch(err => {
  console.error("Build failed:", err);
  process.exit(1);
});
