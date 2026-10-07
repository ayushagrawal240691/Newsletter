// GET /api/news?q=<search terms>  ->  {query, fetchedAt, items:[{title,url,source,ts}]}
// Fetches Google News RSS for the terms. The upstream response is cached at Cloudflare's edge
// for one hour (cf.cacheTtl; unlike the Cache API this also works on *.workers.dev), so all
// visitors with the same interest share a single upstream fetch.

const CACHE_SECONDS = 3600;
const MAX_QUERY_LEN = 100;
const MAX_ITEMS = 30;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m])
    .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    let title = tag(block, "title");
    let url = tag(block, "link");
    if (url.includes("bing.com/news/apiclick")) {
      try { url = new URL(url).searchParams.get("url") || url; } catch {}
    }
    const source = tag(block, "source") || tag(block, "News:Source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -source.length - 3);
    const ts = Date.parse(tag(block, "pubDate")) || Date.now();
    let image = tag(block, "News:Image");
    if (image.startsWith("//")) image = "https:" + image;
    if (image.includes("bing.com/th")) image += "&w=640&h=360&c=7&rs=2";   // ask Bing for a 16:9 crop
    if (!/^https:\/\//.test(image)) image = "";
    if (title && /^https?:\/\//.test(url)) items.push({ title, url, source, image, ts: Math.floor(ts / 1000) });
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, MAX_ITEMS);
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

// Bing News RSS carries a thumbnail per story; Google News RSS does not but has broader coverage.
// Both are queried in parallel and merged, so most tiles get an image and one source being
// blocked (datacenter IPs are sometimes refused) doesn't empty the dashboard.
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; NewsDashboard/1.0)", Accept: "application/rss+xml, text/xml, */*" };
const CF = { cacheTtl: CACHE_SECONDS, cacheEverything: true };
const bingUrl = (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&qft=sortbydate%3d%221%22`;
const googleUrl = (q, days) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;

async function pull(name, urls) {
  let error = "";
  for (const url of urls) {               // later URLs widen the search if the first is empty
    try {
      const res = await fetch(url, { headers: HEADERS, cf: CF });
      if (!res.ok) return { items: [], error: `${name} ${res.status}` };
      const items = parseRss(await res.text());
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
    if (!prev || (!prev.image && it.image)) byTitle.set(k, prev ? { ...it, ts: Math.max(it.ts, prev.ts) } : it);
  }
  return [...byTitle.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_ITEMS);
}

async function fetchItems(q) {
  const [bing, google] = await Promise.all([pull("bing", [bingUrl(q)]), pull("google", [googleUrl(q, 1), googleUrl(q, 7)])]);
  return { items: mergeItems(bing.items, google.items), errors: [google.error, bing.error].filter(Boolean) };
}

export async function handleNews(request) {
  // Accept /api/news/<term> (preferred) or /api/news?q=<term>.
  const url = new URL(request.url);
  const raw = decodeURIComponent(url.pathname.replace(/^\/api\/news\/?/, "")) || url.searchParams.get("q") || "";
  const q = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q || q.length > MAX_QUERY_LEN)
    return json({ error: "search term required (max 100 chars)", received: { path: url.pathname, search: url.search } }, 400);

  const { items, errors } = await fetchItems(q);   // normalised q => shared edge-cache entries
  if (!items.length && errors.length) return json({ error: errors.join(", ") }, 502);
  return json({ query: q, fetchedAt: Date.now(), items }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if ((pathname === "/api/news" || pathname.startsWith("/api/news/")) && request.method === "GET") return handleNews(request);
    return env.ASSETS.fetch(request);
  },
};
