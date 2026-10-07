// Routes
//   GET /api/news/<term>          Bing + Google + GDELT for one interest, merged
//   GET /api/news/<CC>/<term>     same, local to country CC (e.g. IN) plus the world's most-covered stories (scope: "intl")
//   GET /api/pools/<CC>           which publisher-feed batches to fetch for a visitor from CC
//   GET /api/pool/<key>           one batch (2) of publisher RSS feeds, e.g. g-0 or IN-1
//   GET /api/countries, /api/geo  country list; the visitor's own country (from Cloudflare)
//   GET /api/og/<base64url(url)>  the article's social-share image (og:image), for stories without a photo
// (Everything is in the URL path rather than the query string.)
// Upstream responses are cached at Cloudflare's edge (cf.cacheTtl; unlike the Cache API this also
// works on *.workers.dev). Work is split across small requests to stay inside the free plan's CPU limit.

const CACHE_SECONDS = 3600;
const MAX_QUERY_LEN = 100;
const MAX_ITEMS = 30;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; NewsDashboard/1.0)", Accept: "application/rss+xml, application/xml, text/xml, text/html, */*" };
const CF = { cacheTtl: CACHE_SECONDS, cacheEverything: true };

import { COUNTRIES, poolKeys, poolFeeds } from "./feeds.js";
const COUNTRY = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));

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
  let n = 0;
  for (const a of JSON.parse(text).articles || []) {
    const s = a.seendate || "";   // 20261007T101500Z
    const ts = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
    if (!a.title || !a.url || !isEnglish(a.title) || (a.language && a.language !== "English")) continue;
    out.push({ title: a.title, url: a.url, source: (a.domain || "").replace(/^www\./, ""), image: upgradeImage(a.socialimage || ""), ts: Math.floor((ts || Date.now()) / 1000), rank: n++ });
  }
  return out;
}

// ---------- fetching ----------
const bingUrl = (q, c) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setmkt=${c?.bing ? "en-" + c.code : "en-US"}&setlang=en&qft=sortbydate%3d%221%22`;
const googleUrl = (q, days, c) => {
  const cc = c?.gnews ? c.code : "US";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-${cc}&gl=${cc}&ceid=${cc}:en`;
};
// c given  -> English-language outlets located in that country; sort=hybridrel (relevance + source popularity) for "world" lookups.
const gdeltUrl = (q, { country, sort = "datedesc" } = {}) =>
  `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${q} sourcelang:english${country ? " sourcecountry:" + country.name.replace(/\s+/g, "").toLowerCase() : ""}`)}&mode=artlist&format=json&maxrecords=30&sort=${sort}&timespan=2d`;

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
export function mergeItems(lists, limit = MAX_ITEMS) {
  const byTitle = new Map();
  for (const it of lists.flat()) {
    const k = titleKey(it.title), prev = byTitle.get(k);
    if (!prev) byTitle.set(k, it);
    else byTitle.set(k, { ...(!prev.image && it.image ? it : prev), ts: Math.max(it.ts, prev.ts) });
  }
  // stories with a photo first, newest first within each group
  return [...byTitle.values()].sort((a, b) => (!!b.image - !!a.image) || b.ts - a.ts).slice(0, limit);
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

// "/api/news/IN/machine%20learning" -> {country: "IN", term: "machine learning"}; "/api/news/ai" -> no country.
function parseNewsPath(url) {
  const rest = url.pathname.replace(/^\/api\/news\/?/, "");
  const parts = rest.split("/");
  let c = null, raw = rest;
  if (parts.length >= 2 && /^[A-Za-z]{2}$/.test(parts[0])) { c = COUNTRY[parts[0].toUpperCase()] || null; raw = parts.slice(1).join("/"); }
  try { raw = decodeURIComponent(raw); } catch {}
  return { country: c, term: (raw || url.searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ") };
}

export async function handleNews(request) {
  const url = new URL(request.url);
  const { country, term: q } = parseNewsPath(url);
  if (!q || q.length > MAX_QUERY_LEN)
    return json({ error: "search term required (max 100 chars)", received: { path: url.pathname, search: url.search } }, 400);

  // Countries without an English Google/Bing edition: add the country name so results are about it.
  const qLocal = country && !country.gnews ? `${q} ${country.name.toLowerCase()}` : q;
  const jobs = {
    bing: pull("bing", [bingUrl(qLocal, country)], (t) => parseRss(t)),
    google: pull("google", [googleUrl(qLocal, 1, country), googleUrl(qLocal, 7, country)], (t) => parseRss(t)),
  };
  if (q.length > 3) {                                              // GDELT rejects very short phrases
    jobs.gdelt = pull("gdelt", [gdeltUrl(q, { country })], parseGdelt);
    if (country) jobs.world = pull("gdelt-world", [gdeltUrl(q, { sort: "hybridrel" })], parseGdelt);
  }
  const done = Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([k, p]) => [k, await p])));
  const local = mergeItems([done.bing.items, done.google.items, done.gdelt?.items || []]);
  let items = local;
  if (country) {                                                   // 70-80% local / 20-30% world is assembled in the browser
    const have = new Set(local.map((i) => titleKey(i.title)));
    const world = mergeItems([done.world?.items || []], 12).filter((i) => !have.has(titleKey(i.title)));
    items = [...local.map((i) => ({ ...i, scope: "local" })), ...world.map((i) => ({ ...i, scope: "intl" }))];
  }
  const errors = Object.values(done).map((r) => r.error).filter(Boolean);
  if (!items.length && errors.length) return json({ error: errors.join(", ") }, 502);
  return json({ query: q, country: country?.code || "", fetchedAt: Date.now(), items, errors }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
}

export async function handlePool(request) {
  const group = poolFeeds(decodeURIComponent(new URL(request.url).pathname.split("/").pop()));
  if (!group) return json({ error: "unknown pool" }, 404);
  const results = await Promise.all(group.map(async (f) => {
    const r = await pull(f.name, [f.url], (t) => parseRss(t, { source: f.name, summary: true, limit: 20 }));
    return { ...r, items: r.items.map((i) => ({ ...i, home: f.home })) };
  }));
  return json({ items: results.flatMap((r) => r.items), failed: results.map((r) => r.error).filter(Boolean) }, 200,
    { "Cache-Control": "public, max-age=600" });
}

export function handlePools(request) {
  const c = new URL(request.url).pathname.split("/").pop().toUpperCase();
  return json({ keys: poolKeys(COUNTRY[c] ? c : "") }, 200, { "Cache-Control": "public, max-age=3600" });
}
export const handleCountries = () =>
  json(COUNTRIES.map(({ code, name, gnews }) => ({ code, name, edition: gnews })), 200, { "Cache-Control": "public, max-age=86400" });
export const handleGeo = (request) => json({ country: request.cf?.country || "" }, 200, { "Cache-Control": "no-store" });

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
  let raw = "";
  try {                                                            // /api/og/<base64url(url)>
    const b64 = new URL(request.url).pathname.split("/").pop().replace(/-/g, "+").replace(/_/g, "/");
    raw = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
  } catch {}
  const target = safeTarget(raw);
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
      if (pathname.startsWith("/api/pools/")) return handlePools(request);
      if (pathname === "/api/countries") return handleCountries();
      if (pathname === "/api/geo") return handleGeo(request);
      if (pathname.startsWith("/api/og/")) return handleOg(request);
    }
    return env.ASSETS.fetch(request);
  },
};
