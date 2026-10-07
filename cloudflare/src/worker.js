// GET /api/news?q=<search terms>  ->  {query, fetchedAt, items:[{title,url,source,ts}]}
// Fetches Google News RSS for the terms. The upstream response is cached at Cloudflare's edge
// for one hour (cf.cacheTtl; unlike the Cache API this also works on *.workers.dev), so all
// visitors with the same interest share a single upstream fetch.

const CACHE_SECONDS = 3600;
const MAX_QUERY_LEN = 100;
const MAX_ITEMS = 40;

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
    if (title && /^https?:\/\//.test(url)) items.push({ title, url, source, ts: Math.floor(ts / 1000) });
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, MAX_ITEMS);
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

// Sources are tried in order; the first one that returns items wins. Google News sometimes
// refuses requests from datacenter IPs, so Bing News RSS is the fallback.
const SOURCES = [
  (q, days) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`,
  (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&qft=interval%3d%224%22`,
];
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; NewsDashboard/1.0)", Accept: "application/rss+xml, text/xml, */*" };

async function fetchItems(q) {
  const errors = [];
  for (const [i, build] of SOURCES.entries()) {
    const name = i === 0 ? "google" : "bing";
    for (const days of i === 0 ? [1, 7] : [1]) {       // widen to a week if the last day is empty
      try {
        const res = await fetch(build(q, days), { headers: HEADERS, cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
        if (!res.ok) { errors.push(`${name} ${res.status}`); break; }
        const items = parseRss(await res.text());
        if (items.length) return { items, errors };
      } catch (e) {
        errors.push(`${name} unreachable`); break;
      }
    }
  }
  return { items: [], errors };
}

export async function handleNews(request) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!q || q.length > MAX_QUERY_LEN) return json({ error: "q required (max 100 chars)" }, 400);

  const { items, errors } = await fetchItems(q);   // normalised q => shared edge-cache entries
  if (!items.length && errors.length) return json({ error: errors.join(", ") }, 502);
  return json({ query: q, fetchedAt: Date.now(), items }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/news" && request.method === "GET") return handleNews(request);
    return env.ASSETS.fetch(request);
  },
};
