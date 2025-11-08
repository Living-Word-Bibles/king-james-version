// build.mjs — KJV Verse-per-Page static site builder (v2.0, 2025-11-08)
// Node 18+ (Node 20 recommended). package.json should set "type":"module".
// Output: /dist with /<book-slug>/<chapter>/<verse>/index.html plus sitemaps, robots, CNAME.
//
// What this does:
// - Pulls Books.json + book JSONs from your GitHub repo (with fallbacks).
// - Normalizes structures, then renders fully static HTML pages (one per verse).
// - Adds canonical URLs, prev/next links, JSON-LD breadcrumbs, and share links.
// - Preserves your footer language. Brand logo is a hyperlink to your KJV directory page.
// - Emits sitemap index + chunked sitemaps (kept under 50k URLs each), robots.txt, CNAME.
//
// ENV overrides you can set when running (all optional):
//   SITE_BASE_URL="https://kjv.livingwordbibles.com"
//   OUT_DIR="dist"
//   LOGO_URL="https://.../LivingWordBibles01.png"
//
// Run: `node build.mjs`
// Deploy with the GitHub Pages workflow provided below.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------ Config ------------------------
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(__dirname, "dist");
const SITE_BASE_URL = (process.env.SITE_BASE_URL || "https://kjv.livingwordbibles.com").replace(/\/+$/, "");
const LOGO_URL = process.env.LOGO_URL || "https://static1.squarespace.com/static/68d6b7d6d21f02432fd7397b/t/690209b3567af44aabfbdaca/1761741235124/LivingWordBibles01.png";

// Data sources (prefer your new repo; graceful fallback to known mirrors)
const DATA_BASES = [
  // Your repo (jsDelivr & raw)
  "https://cdn.jsdelivr.net/gh/Living-Word-Bibles/king-james-version@main/",
  "https://raw.githubusercontent.com/Living-Word-Bibles/king-james-version/main/",
  // Common legacy paths you used before (if the new repo mirrors aruljohn structure)
  "https://cdn.jsdelivr.net/gh/aruljohn/Bible-kjv@master/",
  "https://raw.githubusercontent.com/aruljohn/Bible-kjv/master/",
];

// If your repo has a subfolder (e.g., "Bible-kjv-master/"), include both roots and subpaths:
const TRY_PATHS = ["", "Bible-kjv-master/"]; // we’ll try both "Books.json" and "Bible-kjv-master/Books.json"

const BRAND_LINK = "https://www.livingwordbibles.com/read-the-bible-online/kjv"; // requested logo target
const COPYRIGHT_LINE_LEFT = `Copyright © ${new Date().getFullYear()} | <a href="https://www.livingwordbibles.com" target="_blank" rel="noopener">Living Word Bibles</a> | All Rights Reserved`;
const FOOT_BADGE_RIGHT = "KJV Bible (Verse-per-Page) v2.0";

// ------------------------ Utils ------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
}

function fileFromName(name) {
  // Song of Solomon -> SongofSolomon.json (common naming in KJV JSON dumps)
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
          return { base, subdir: sub, booksUrl, books };
        }
        lastErr = `Unexpected Books.json @ ${booksUrl}`;
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  throw new Error("Could not load Books.json. " + (lastErr || ""));
}

// Normalize various book JSON shapes into { name, chapters: { [chNum]: { verseCount, verses: { [vNum]: text }}}}
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

// ------------------------ Templating ------------------------
function canonicalUrl(bookSlug, chapter, verse) {
  return `${SITE_BASE_URL}/${bookSlug}/${chapter}/${verse}/`;
}

function prevRef(idxOrder, currentSlug, chapter, verse, booksMap) {
  // previous verse or last verse of prev chapter/book
  const book = booksMap.get(currentSlug);
  const ch = book.chapters[chapter];
  if (verse > 1) return { slug: currentSlug, chapter, verse: verse - 1 };

  // go to previous chapter
  const chNums = Object.keys(book.chapters).map(Number).sort((a, b) => a - b);
  const i = chNums.indexOf(chapter);
  if (i > 0) {
    const prevCh = chNums[i - 1];
    const vc = book.chapters[prevCh].verseCount || 1;
    return { slug: currentSlug, chapter: prevCh, verse: vc };
  }

  // go to previous book
  const bIndex = idxOrder.indexOf(currentSlug);
  if (bIndex > 0) {
    const prevBookSlug = idxOrder[bIndex - 1];
    const prevBook = booksMap.get(prevBookSlug);
    const prevChNums = Object.keys(prevBook.chapters).map(Number).sort((a, b) => a - b);
    const lastCh = prevChNums[prevChNums.length - 1];
    const lastVc = prevBook.chapters[lastCh].verseCount || 1;
    return { slug: prevBookSlug, chapter: lastCh, verse: lastVc };
  }

  // at very beginning
  return null;
}

function nextRef(idxOrder, currentSlug, chapter, verse, booksMap) {
  const book = booksMap.get(currentSlug);
  const ch = book.chapters[chapter];
  if (ch && verse < ch.verseCount) return { slug: currentSlug, chapter, verse: verse + 1 };

  // next chapter
  const chNums = Object.keys(book.chapters).map(Number).sort((a, b) => a - b);
  const i = chNums.indexOf(chapter);
  if (i >= 0 && i < chNums.length - 1) return { slug: currentSlug, chapter: chNums[i + 1], verse: 1 };

  // next book
  const bIndex = idxOrder.indexOf(currentSlug);
  if (bIndex >= 0 && bIndex < idxOrder.length - 1) {
    const nbSlug = idxOrder[bIndex + 1];
    const nb = booksMap.get(nbSlug);
    const nbChNums = Object.keys(nb.chapters).map(Number).sort((a, b) => a - b);
    return { slug: nbSlug, chapter: nbChNums[0], verse: 1 };
  }
  return null;
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

function htmlPage({ bookName, bookSlug, chapter, verse, verseText, prev, next }) {
  const refLabel = `${bookName} ${chapter}:${verse}`;
  const url = canonicalUrl(bookSlug, chapter, verse);
  const desc = (verseText || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const shares = shareLinks(url, refLabel, verseText || "");
  const ld = breadCrumbJsonLd(bookName, bookSlug, chapter, verse, url);

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
    .ref{font-weight:700;margin:.8rem auto .35rem;max-width:calc(var(--max) - 2.2rem)}
    .body{padding:1rem 1.1rem}
    .text{font-size:1.18rem;line-height:1.75}
    .nav{display:flex;justify-content:space-between;gap:.75rem;align-items:center;padding:.65rem 1rem;border-top:1px solid var(--line);background:var(--panel)}
    .nav a{border:1px solid #bbb;border-radius:10px;padding:.42rem .6rem;text-decoration:none;color:inherit;background:#fff}
    .share{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.75rem 1rem;border-top:1px solid var(--line);background:var(--panel);justify-content:center}
    .share a{display:inline-flex;align-items:center;gap:.4rem;padding:.38rem .7rem;border:1px solid #bbb;border-radius:999px;background:#fff;color:inherit;text-decoration:none}
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
      <a href="${shares.fb}" target="_blank" rel="noopener">Facebook</a>
      <a href="https://www.instagram.com/living.word.bibles/" target="_blank" rel="noopener">Instagram</a>
      <a href="${shares.x}" target="_blank" rel="noopener">X</a>
      <a href="${shares.ln}" target="_blank" rel="noopener">LinkedIn</a>
      <a href="${shares.email}">Email</a>
      <a href="${url}" onclick="navigator.clipboard && navigator.clipboard.writeText('${url}');return false;">Copy link</a>
    </div>

    <footer class="foot">
      <div class="foot-left">${COPYRIGHT_LINE_LEFT}</div>
      <div class="foot-right">${FOOT_BADGE_RIGHT}</div>
    </footer>
  </div>
</body>
</html>`;
}

// Books index (optional helper page per book & chapter for crawlability)
function bookIndexHtml(bookName, bookSlug, firstChapter) {
  const url = `${SITE_BASE_URL}/${bookSlug}/`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": `KJV — ${bookName}`,
    "url": url
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KJV — ${escapeHtml(bookName)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="King James Version — ${escapeHtml(bookName)} chapters">
  <link rel="canonical" href="${url}">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
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

// Chapter index (optional helper: links to all verses, aids crawlability)
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

// Root index (loads Genesis 1:1)
function rootIndexHtml(firstUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta http-equiv="refresh" content="0; url=${firstUrl}">
  <meta name="robots" content="index,follow">
</head>
<body>Redirecting to <a href="${firstUrl}">${firstUrl}</a>…</body>
</html>`;
}

// ------------------------ Build ------------------------
async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await ensureDir(OUT_DIR);

  // Data discovery
  const { base, subdir, books } = await findBaseAndBooksJson();

  // Build maps
  const indexList = books.map(n => ({ name: n, slug: slugify(n), jsonUrl: base + subdir + fileFromName(n) }));
  const booksMap = new Map();

  // Load & normalize books
  for (const row of indexList) {
    const raw = await fetchJSONwithRetry(row.jsonUrl);
    const norm = normalizeBook(row.name, raw);
    booksMap.set(row.slug, norm);
  }

  // Write pages
  const idxOrder = indexList.map(b => b.slug);

  // book + chapter helper pages
  for (const row of indexList) {
    const b = booksMap.get(row.slug);
    const chNums = Object.keys(b.chapters).map(Number).sort((a, b) => a - b);
    const bookDir = path.join(OUT_DIR, row.slug);
    await ensureDir(bookDir);
    // Book index
    await fs.writeFile(path.join(bookDir, "index.html"), bookIndexHtml(b.name, row.slug, chNums[0]), "utf8");

    // Chapter list pages
    for (const ch of chNums) {
      const chDir = path.join(bookDir, String(ch));
      await ensureDir(chDir);
      await fs.writeFile(path.join(chDir, "index.html"), chapterIndexHtml(b.name, row.slug, ch, b.chapters[ch].verseCount), "utf8");
    }
  }

  // verse pages + gather URLs for sitemap
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
          next: n
        });
        const verseDir = path.join(OUT_DIR, row.slug, String(ch), String(v));
        await ensureDir(verseDir);
        await fs.writeFile(path.join(verseDir, "index.html"), html, "utf8");

        urls.push(canonicalUrl(row.slug, ch, v));
      }
    }
  }

  // Root redirect to Genesis 1:1
  const firstUrl = urls[0] || `${SITE_BASE_URL}/genesis/1/1/`;
  await fs.writeFile(path.join(OUT_DIR, "index.html"), rootIndexHtml(firstUrl), "utf8");

  // robots.txt
  const robots = `User-agent: *
Allow: /
Sitemap: ${SITE_BASE_URL}/sitemap.xml
`;
  await fs.writeFile(path.join(OUT_DIR, "robots.txt"), robots, "utf8");

  // Sitemaps (chunk under 50k just in case)
  const CHUNK = 50000;
  const sitemapDir = OUT_DIR; // root; simpler for Pages
  if (urls.length <= CHUNK) {
    const sm = urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sm}
</urlset>`;
    await fs.writeFile(path.join(sitemapDir, "sitemap.xml"), xml, "utf8");
  } else {
    const parts = Math.ceil(urls.length / CHUNK);
    const indexItems = [];
    for (let i = 0; i < parts; i++) {
      const slice = urls.slice(i * CHUNK, (i + 1) * CHUNK);
      const sm = slice.map(u => `  <url><loc>${u}</loc></url>`).join("\n");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sm}
</urlset>`;
      const fname = i === 0 ? "sitemap-1.xml" : `sitemap-${i + 1}.xml`;
      await fs.writeFile(path.join(sitemapDir, fname), xml, "utf8");
      indexItems.push(`  <sitemap><loc>${SITE_BASE_URL}/${fname}</loc></sitemap>`);
    }
    const idxXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexItems.join("\n")}
</sitemapindex>`;
    await fs.writeFile(path.join(sitemapDir, "sitemap.xml"), idxXml, "utf8");
  }

  // CNAME for custom domain
  await fs.writeFile(path.join(OUT_DIR, "CNAME"), "kjv.livingwordbibles.com\n", "utf8");

  console.log(`Build complete. Pages: ${urls.length}. Output: ${OUT_DIR}`);
}

main().catch(err => {
  console.error("Build failed:", err);
  process.exit(1);
});
