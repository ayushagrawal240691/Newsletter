import test from "node:test";
import assert from "node:assert/strict";
import { parseRss, parseGdelt, mergeItems, handleNews, handlePool, handleOg, extractOgImage, isEnglish } from "../src/worker.js";
import { FEEDS, POOL_COUNT } from "../src/feeds.js";

const GOOGLE = `<rss><channel>
<item><title>Chip &amp; AI boom - Example Wire</title><link>https://example.com/1</link>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><source url="https://x">Example Wire</source></item>
<item><title><![CDATA[Older story]]></title><link>https://example.com/2</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
const BING = (img = "") => `<rss><channel><item><title>Bing story</title>
<link>https://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3a%2f%2fnews.example.org%2fa&amp;c=1</link>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><News:Source>Example News</News:Source>${img}</item></channel></rss>`;
const PUBLISHER = `<rss xmlns:media="m"><channel><title>BBC</title>
<item><title>World leaders meet on AI safety</title><link>https://bbc.example/1</link><description>&lt;p&gt;Summit &lt;b&gt;opens&lt;/b&gt;&lt;/p&gt;</description>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate>
<media:thumbnail width="240" height="135" url="https://ichef.bbci.co.uk/news/240/cpsprodpb/abc/img.jpg"/></item>
<item><title>Guardian style</title><link>https://g.example/2</link>
<media:content width="140" url="https://i.guim.co.uk/a.jpg?width=140&amp;s=sig"/><media:content width="460" url="https://i.guim.co.uk/a.jpg?width=460&amp;s=sig2"/></item>
<item><title>Times style</title><link>https://t.example/3</link><enclosure url="http://t.example/pic.jpg" type="image/jpeg"/></item>
<item><title>Body image</title><link>https://b.example/4</link><description>&lt;img src="https://b.example/hero.png"&gt; text</description></item>
<item><title>Site logo only</title><link>https://l.example/5</link><media:thumbnail url="https://l.example/logo.png"/></item>
</channel></rss>`;
const req = (path) => new Request("https://app.test" + path);
const EMPTY = "<rss><channel></channel></rss>";

test("parseRss: decodes, strips source suffix, drops non-http links and non-English", () => {
  const items = parseRss(GOOGLE);
  assert.deepEqual(items.map((i) => i.title), ["Chip & AI boom", "Older story"]);
  assert.equal(items[0].source, "Example Wire");
  assert.equal(parseRss(`<rss><channel><item><title>भारत में एआई स्टार्टअप को फंडिंग</title><link>https://a.example/2</link></item></channel></rss>`).length, 0);
});

test("parseRss: picks the best photo from media/enclosure/body and upgrades it", () => {
  const byUrl = Object.fromEntries(parseRss(PUBLISHER, { source: "BBC", summary: true }).map((i) => [i.url, i]));
  assert.equal(byUrl["https://bbc.example/1"].image, "https://ichef.bbci.co.uk/news/976/cpsprodpb/abc/img.jpg");   // 240px -> 976px
  assert.equal(byUrl["https://bbc.example/1"].summary, "Summit opens");
  assert.equal(byUrl["https://bbc.example/1"].source, "BBC");
  assert.equal(byUrl["https://g.example/2"].image, "https://i.guim.co.uk/a.jpg?width=460&s=sig2");                 // largest, signature intact
  assert.equal(byUrl["https://t.example/3"].image, "https://t.example/pic.jpg".replace("http:", "https:"));
  assert.equal(byUrl["https://b.example/4"].image, "https://b.example/hero.png");
  assert.equal(byUrl["https://l.example/5"].image, "");                                                            // logos rejected
});

test("parseRss: Bing thumbnail is sized to 16:9 and redirect link is unwrapped", () => {
  const [it] = parseRss(BING("<News:Image>https://www.bing.com/th?id=ON.X&amp;pid=News</News:Image>"));
  assert.match(it.image, /^https:\/\/www\.bing\.com\/th\?id=ON\.X&pid=News&w=1000&h=560/);
  assert.equal(it.url, "https://news.example.org/a");
  assert.equal(it.source, "Example News");
});

test("parseGdelt: reads articles, keeps photo, drops non-English", () => {
  const items = parseGdelt(JSON.stringify({ articles: [
    { url: "https://a.example/1", title: "Markets rally on tech earnings", seendate: "20261007T101500Z", socialimage: "https://a.example/p.jpg", domain: "www.a.example", language: "English" },
    { url: "https://a.example/2", title: "El mercado de la inteligencia artificial", seendate: "20261007T101500Z", language: "Spanish" },
  ] }));
  assert.equal(items.length, 1);
  assert.equal(items[0].image, "https://a.example/p.jpg");
  assert.equal(items[0].source, "a.example");
  assert.equal(items[0].ts, Date.parse("2026-10-07T10:15:00Z") / 1000);
});

test("mergeItems: de-dupes by title, keeps the copy with a photo, photos first", () => {
  const out = mergeItems(
    [{ title: "Same story", url: "g", image: "", ts: 5 }, { title: "Only text", url: "t", image: "", ts: 9 }],
    [{ title: "Same  story!", url: "b", image: "https://i/x.jpg", ts: 4 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, "b");           // photo copy wins and sorts first
  assert.equal(out[0].ts, 5);              // newest timestamp kept
});

test("handleNews: queries all three sources, caches 1h at the edge, normalises the term", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.includes("gdelt")) return new Response(JSON.stringify({ articles: [] }));
    return new Response(url.includes("bing.com") ? BING("<News:Image>https://www.bing.com/th?id=A</News:Image>") : GOOGLE);
  };
  const a = await handleNews(req("/api/news/%20AI%20%20chips"));
  const first = seen.map((x) => x.url);
  seen.length = 0;
  await handleNews(req("/api/news?q=ai chips"));
  assert.deepEqual(seen.map((x) => x.url).sort(), first.sort());          // same term => same cache keys
  assert.ok(first.some((u) => u.includes("bing.com")) && first.some((u) => u.includes("news.google.com")) && first.some((u) => u.includes("gdelt")));
  assert.ok(seen.every((x) => x.init.cf.cacheTtl === 3600 && x.init.cf.cacheEverything));
  assert.equal(a.headers.get("Cache-Control"), "public, max-age=3600");
  const body = await a.json();
  assert.equal(body.items.length, 3);
  assert.ok(body.items[0].image);                                         // photo story first
});

test("handleNews: short terms skip GDELT; bad input rejected; one failing source is tolerated", async () => {
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), url.includes("google") ? new Response("x", { status: 429 }) : new Response(BING()));
  const body = await (await handleNews(req("/api/news/ai"))).json();
  assert.ok(!urls.some((u) => u.includes("gdelt")));
  assert.equal(body.items[0].url, "https://news.example.org/a");
  assert.deepEqual(body.errors, ["google 429"]);
  assert.equal((await handleNews(req("/api/news"))).status, 400);
  assert.equal((await handleNews(req("/api/news/" + "x".repeat(101)))).status, 400);
});

test("handleNews: widens Google to 7 days when 1 day is empty; 502 when everything fails", async () => {
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(url.includes("when%3A7d") ? GOOGLE : EMPTY));
  assert.equal((await (await handleNews(req("/api/news/niche"))).json()).items.length, 2);
  assert.ok(urls.some((u) => u.includes("when%3A1d")) && urls.some((u) => u.includes("when%3A7d")));
  globalThis.fetch = async () => new Response("no", { status: 503 });
  const r = await handleNews(req("/api/news/machine learning"));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /bing 503, google 503, gdelt 503/);
});

test("handlePool: fetches 2 feeds per batch, reports failures, 404 for unknown batch", async () => {
  assert.equal(POOL_COUNT, Math.ceil(FEEDS.length / 2));
  globalThis.fetch = async (url) => url === FEEDS[1].url ? new Response("x", { status: 500 }) : new Response(PUBLISHER);
  const body = await (await handlePool(req("/api/pool/0"))).json();
  assert.equal(body.items.length, 5);                                     // all 5 stories from the one healthy feed
  assert.equal(body.items[0].source, FEEDS[0].name);
  assert.deepEqual(body.failed, [`${FEEDS[1].name} 500`]);
  assert.equal((await handlePool(req("/api/pool/99"))).status, 404);
  assert.equal((await handlePool(req("/api/pool/abc"))).status, 404);
});

test("og:image: extraction handles attribute order and relative URLs", () => {
  assert.equal(extractOgImage(`<meta content="/img/a.jpg" property="og:image">`, "https://s.example/post/1"), "https://s.example/img/a.jpg");
  assert.equal(extractOgImage(`<meta name="twitter:image" content="https://c.example/t.jpg">`, "https://s.example"), "https://c.example/t.jpg");
  assert.equal(extractOgImage(`<meta property="og:title" content="x">`, "https://s.example"), "");
});

test("handleOg: returns the photo, refuses unsafe targets", async () => {
  globalThis.fetch = async () => new Response(`<html><head><meta property="og:image" content="https://cdn.example/hero.jpg"></head><body>`);
  assert.equal((await (await handleOg(req("/api/og?url=" + encodeURIComponent("https://news.example/story")))).json()).image, "https://cdn.example/hero.jpg");
  for (const bad of ["http://news.example/x", "https://127.0.0.1/x", "https://localhost/x", "https://news.google.com/rss/articles/abc", "not a url", "https://x.workers.dev/"])
    assert.equal((await handleOg(req("/api/og?url=" + encodeURIComponent(bad)))).status, 400, bad);
});

test("isEnglish keeps English and drops other languages", () => {
  for (const ok of ["Nvidia earnings beat estimates", "Markets rally on tech earnings", "AI", "India Inc. says GST cuts will help"]) assert.ok(isEnglish(ok), ok);
  for (const bad of ["भारत में एआई स्टार्टअप को रिकॉर्ड फंडिंग", "人工智能市场增长", "El mercado de la inteligencia artificial crece en España", "Der Markt für KI wächst und die Preise sind hoch"])
    assert.ok(!isEnglish(bad), bad);
});

test("worker entry module exports only functions (Cloudflare rejects other export types)", async () => {
  const mod = await import("../src/worker.js");
  for (const [k, v] of Object.entries(mod)) assert.ok(typeof v === "function" || (k === "default" && typeof v.fetch === "function"), k);
});
