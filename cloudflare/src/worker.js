// Routes
//   GET /api/news/<term>   Bing News + Google News + GDELT for one interest, merged
//   GET /api/pool/<n>      a small batch (2) of publisher RSS feeds (BBC, NYT, Guardian, ...)
//   GET /api/og?url=...    the article's social-share image (og:image), for stories without a photo
// Upstream responses are cached at Cloudflare's edge (cf.cacheTtl; unlike the Cache API this also
// works on *.workers.dev). Work is split across small requests to stay inside the free plan's CPU limit.

const CACHE_SECONDS = 3600;
const MAX_QUERY_LEN = 100;
const MAX_ITEMS = 30;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; NewsDashboard/1.0)", Accept: "application/rss+xml, application/xml, text/xml, text/html, */*" };
const CF = { cacheTtl: CACHE_SECONDS, cacheEverything: true };

import { FEEDS, POOL_SIZE } from "./feeds.js";

// ---------- text helpers ----------
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m]);
const decode = (s) => unesc(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
const stripHtml = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};
const attr = (s, name) => (s.match(new RegExp(`\\b${name}="([^"]+)"`)) || [])[1];

// Belt-and-braces English filter (feeds are also requested in their English edition).
// Rejects non-Latin scripts and titles with more foreign than English function words.
const EN = new Set("the of and to in for on is are as at with by from after over amid new says will how why what who".split(" "));
const NON_EN = new Set(("el la los las del y en un una por para con que se es su al lo como más "
  + "le les des du et est pour dans sur avec une qui pas au aux ce cette "
  + "der die das und ist nicht mit von zu den dem ein eine für auf im auch sich "
  + "il di che per della delle sono più "
  + "os as uma não com do da dos das em "
  + "het een van niet voor op met zijn "
  + "yang dan di untuk dengan ini itu dari pada").split(" "));
export function isEnglish(title) {
  const letters = title.match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  if (letters.filter((c) => /\p{Script=Latin}/u.test(c)).length / letters.length < 0.9) return false;
  let en = 0, foreign = 0;
  for (const w of title.toLowerCase().match(/\p{L}+/gu) || []) {
    if (EN.has(w)) en++;
    else if (NON_EN.has(w)) foreign++;
  }
  return foreign <= en;
}

// ---------- images ----------
const BAD_IMAGE = /logo|sprite|placeholder|default[-_]?(image|thumb)|1x1|pixel|avatar/i;
function upgradeImage(u) {
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  u = unesc(u).replace(/^http:\/\//, "https://");
  if (!/^https:\/\//.test(u) || BAD_IMAGE.test(u)) return "";
  if (u.includes("bing.com/th") && !u.includes("&w=")) u += (u.includes("?") ? "&" : "?") + "w=1000&h=560&c=7&rs=2";   // 16:9 crop
  u = u.replace(/(ichef\.bbci\.co\.uk\/[^?]*?\/)(\d{2,3})\//, "$1976/");                                              // BBC: 240px -> 976px
  return u;
}
// Largest image the item offers: media:content / media:thumbnail / enclosure / <img> in the body.
function bestImage(block) {
  let best = "", bestW = -1;
  const consider = (url, w) => { if (url && w > bestW) { best = url; bestW = w; } };
  for (const m of block.matchAll(/<media:(?:content|thumbnail)\b([^>]*)>/g)) {
    const a = m[1], medium = attr(a, "medium"), type = attr(a, "type");
    if ((medium && medium !== "image") || (type && !type.startsWith("image"))) continue;
    consider(attr(a, "url"), +attr(a, "width") || 1);
  }
  for (const m of block.matchAll(/<enclosure\b([^>]*)>/g)) {
    if ((attr(m[1], "type") || "").startsWith("image")) consider(attr(m[1], "url"), 1);
  }
  if (!best) {
    const body = tag(block, "description") + tag(block, "content:encoded");
    const m = body.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) consider(m[1], 0);
  }
  return upgradeImage(best);
}

// ---------- parsing ----------
export function parseRss(xml, { source: fixedSource = "", summary = false, limit = MAX_ITEMS * 2 } = {}) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    let title = tag(block, "title");
    let url = tag(block, "link");
    if (!/^https?:\/\//.test(url)) { const g = tag(block, "guid"); if (/^https?:\/\//.test(g)) url = g; }
    if (url.includes("bing.com/news/apiclick")) {            // Bing wraps the real URL in a redirect
      try { url = new URL(url).searchParams.get("url") || url; } catch {}
    }
    const source = fixedSource || tag(block, "source") || tag(block, "News:Source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -source.length - 3);   // Google News suffix
    if (!title || !isEnglish(title) || !/^https?:\/\//.test(url)) continue;
    const ts = Date.parse(tag(block, "pubDate")) || Date.now();
    const item = { title, url, source, image: bestImage(block) || upgradeImage(tag(block, "News:Image")), ts: Math.floor(ts / 1000), rank: items.length };
    if (summary) item.summary = stripHtml(tag(block, "description")).slice(0, 240);
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

export function parseGdelt(text) {
  const out = [];
  for (const a of JSON.parse(text).articles || []) {
    const s = a.seendate || "";   // 20261007T101500Z
    const ts = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
    if (!a.title || !a.url || !isEnglish(a.title) || (a.language && a.language !== "English")) continue;
    out.push({ title: a.title, url: a.url, source: (a.domain || "").replace(/^www\./, ""), image: upgradeImage(a.socialimage || ""), ts: Math.floor((ts || Date.now()) / 1000) });
  }
  return out;
}

// ---------- fetching ----------
const bingUrl = (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setmkt=en-US&setlang=en&qft=sortbydate%3d%221%22`;
const googleUrl = (q, days) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;
const gdeltUrl = (q) => `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${q} sourcelang:english`)}&mode=artlist&format=json&maxrecords=30&sort=datedesc&timespan=2d`;

async function pull(name, urls, parse) {
  let error = "";
  for (const url of urls) {                 // later URLs widen the search if the first is empty
    try {
      const res = await fetch(url, { headers: HEADERS, cf: CF });
      if (!res.ok) return { items: [], error: `${name} ${res.status}` };
      const items = parse(await res.text());
      if (items.length) return { items, error: "" };
    } catch {
      error = `${name} unreachable`;
      break;
    }
  }
  return { items: [], error };
}

const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
export function mergeItems(...lists) {
  const byTitle = new Map();
  for (const it of lists.flat()) {
    const k = titleKey(it.title), prev = byTitle.get(k);
    if (!prev) byTitle.set(k, it);
    else byTitle.set(k, { ...(!prev.image && it.image ? it : prev), ts: Math.max(it.ts, prev.ts) });
  }
  // stories with a photo first, newest first within each group
  return [...byTitle.values()].sort((a, b) => (!!b.image - !!a.image) || b.ts - a.ts).slice(0, MAX_ITEMS);
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

export async function handleNews(request) {
  const url = new URL(request.url);
  // Accept /api/news/<term> (preferred) or /api/news?q=<term>.
  const raw = decodeURIComponent(url.pathname.replace(/^\/api\/news\/?/, "")) || url.searchParams.get("q") || "";
  const q = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q || q.length > MAX_QUERY_LEN)
    return json({ error: "search term required (max 100 chars)", received: { path: url.pathname, search: url.search } }, 400);

  const jobs = [
    pull("bing", [bingUrl(q)], (t) => parseRss(t)),
    pull("google", [googleUrl(q, 1), googleUrl(q, 7)], (t) => parseRss(t)),
  ];
  if (q.length > 3) jobs.push(pull("gdelt", [gdeltUrl(q)], parseGdelt));   // GDELT rejects very short phrases
  const results = await Promise.all(jobs);
  const items = mergeItems(...results.map((r) => r.items));
  const errors = results.map((r) => r.error).filter(Boolean);
  if (!items.length && errors.length) return json({ error: errors.join(", ") }, 502);
  return json({ query: q, fetchedAt: Date.now(), items, errors }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
}

export async function handlePool(request) {
  const n = Number(new URL(request.url).pathname.split("/").pop());
  const group = FEEDS.slice(n * POOL_SIZE, n * POOL_SIZE + POOL_SIZE);
  if (!Number.isInteger(n) || n < 0 || !group.length) return json({ error: "unknown pool" }, 404);
  const results = await Promise.all(group.map((f) =>
    pull(f.name, [f.url], (t) => parseRss(t, { source: f.name, summary: true, limit: 20 }))));
  return json({ items: results.flatMap((r) => r.items), failed: results.map((r) => r.error).filter(Boolean) }, 200,
    { "Cache-Control": "public, max-age=600" });
}

// ---------- og:image lookup ----------
function safeTarget(u) {
  let t;
  try { t = new URL(u); } catch { return null; }
  const h = t.hostname;
  if (t.protocol !== "https:" || u.length > 600 || /^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")
      || h.endsWith(".workers.dev") || h === "news.google.com" || h.endsWith("bing.com")) return null;
  return t.href;
}
async function readHead(res, max = 150000) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let out = "";
  while (out.length < max) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
    if (out.includes("</head>")) break;
  }
  reader.cancel().catch(() => {});
  return out;
}
export function extractOgImage(html, base) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = ((m[0].match(/(?:property|name)=["']([^"']+)["']/i) || [])[1] || "").toLowerCase();
    if (!["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) continue;
    const c = (m[0].match(/content=["']([^"']+)["']/i) || [])[1];
    if (!c) continue;
    try { return upgradeImage(new URL(unesc(c), base).href); } catch {}
  }
  return "";
}
export async function handleOg(request) {
  const target = safeTarget(new URL(request.url).searchParams.get("url") || "");
  if (!target) return json({ error: "bad url" }, 400);
  let image = "";
  try {
    const res = await fetch(target, { headers: { ...HEADERS, Accept: "text/html" }, redirect: "follow", cf: { cacheTtl: 86400, cacheEverything: true } });
    if (res.ok) image = extractOgImage(await readHead(res), res.url || target);
  } catch {}
  return json({ image }, 200, { "Cache-Control": "public, max-age=86400" });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET") {
      if (pathname === "/api/news" || pathname.startsWith("/api/news/")) return handleNews(request);
      if (pathname.startsWith("/api/pool/")) return handlePool(request);
      if (pathname === "/api/og") return handleOg(request);
    }
    return env.ASSETS.fetch(request);
  },
};
