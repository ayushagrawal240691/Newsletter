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
    const url = tag(block, "link");
    const source = tag(block, "source");
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

export async function handleNews(request) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!q || q.length > MAX_QUERY_LEN) return json({ error: "q required (max 100 chars)" }, 400);

  // Normalised URL => "AI " and "ai" share one edge-cache entry.
  const upstream = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&hl=en-US&gl=US&ceid=US:en`;
  let res;
  try {
    res = await fetch(upstream, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDashboard/1.0)" },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
  } catch {
    return json({ error: "upstream unreachable" }, 502);
  }
  if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);

  return json({ query: q, fetchedAt: Date.now(), items: parseRss(await res.text()) }, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/news" && request.method === "GET") return handleNews(request);
    return env.ASSETS.fetch(request);
  },
};
