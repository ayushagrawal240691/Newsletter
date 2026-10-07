import test from "node:test";
import assert from "node:assert/strict";
import { parseRss, handleNews, isEnglish } from "../src/worker.js";

const RSS = `<rss><channel>
<item><title>Chip &amp; AI boom - Example Wire</title><link>https://example.com/1</link>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><source url="https://x">Example Wire</source></item>
<item><title><![CDATA[Older story]]></title><link>https://example.com/2</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

test("parseRss decodes, strips source suffix, drops non-http links, sorts newest first", () => {
  const items = parseRss(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Chip & AI boom");
  assert.equal(items[0].source, "Example Wire");
  assert.equal(items[1].title, "Older story");
});

const BING = `<rss><channel><item><title>Bing story</title>
<link>https://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3a%2f%2fnews.example.org%2fa&amp;c=1</link>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><News:Source>Example News</News:Source></item></channel></rss>`;
const req = (q) => new Request("https://app.test/api/news?q=" + encodeURIComponent(q));
const EMPTY = "<rss><channel></channel></rss>";

test("parseRss exposes Bing thumbnails as a sized https image", () => {
  const [it] = parseRss(BING.replace("</News:Source>", `</News:Source><News:Image>https://www.bing.com/th?id=ON.X&amp;pid=News</News:Image>`));
  assert.match(it.image, /^https:\/\/www\.bing\.com\/th\?id=ON\.X&pid=News&w=640&h=360/);
  assert.equal(parseRss(RSS)[0].image, "");
});

test("handleNews normalises query, requests 1h edge caching, rejects bad input", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => (seen.push({ url, init }), new Response(RSS));
  const a = await handleNews(req("  AI  chips"));
  await handleNews(req("ai chips"));
  assert.equal(a.headers.get("Cache-Control"), "public, max-age=3600");
  assert.deepEqual(new Set(seen.slice(0, 2).map((x) => x.url)), new Set(seen.slice(2, 4).map((x) => x.url)));
  assert.ok(seen.every((x) => x.init.cf.cacheTtl === 3600 && x.init.cf.cacheEverything));
  assert.equal((await a.json()).items.length, 2);
  assert.equal((await handleNews(req(""))).status, 400);
  assert.equal((await handleNews(req("x".repeat(101)))).status, 400);
});

test("merges Bing + Google, de-dupes by title and keeps the copy that has an image", async () => {
  const bing = `<rss><channel><item><title>Chip &amp; AI boom</title><link>https://b.example/1</link>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><News:Image>https://www.bing.com/th?id=A</News:Image></item></channel></rss>`;
  globalThis.fetch = async (url) => new Response(url.includes("bing.com") ? bing : RSS);
  const { items } = await (await handleNews(req("ai"))).json();
  assert.equal(items.length, 2);                       // "Chip & AI boom" counted once + "Older story"
  assert.ok(items.find((i) => i.title === "Chip & AI boom").image);
});

test("works when Google refuses, and unwraps Bing redirect links", async () => {
  globalThis.fetch = async (url) => url.includes("google") ? new Response("blocked", { status: 429 }) : new Response(BING);
  const body = await (await handleNews(req("ai"))).json();
  assert.equal(body.items[0].url, "https://news.example.org/a");
  assert.equal(body.items[0].source, "Example News");
});

test("widens Google to 7 days when 1 day is empty", async () => {
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(url.includes("when%3A7d") ? RSS : EMPTY));
  assert.equal((await (await handleNews(req("niche"))).json()).items.length, 2);
  assert.ok(urls.some((u) => u.includes("when%3A1d")) && urls.some((u) => u.includes("when%3A7d")));
});

test("reports which sources failed when all fail", async () => {
  globalThis.fetch = async () => new Response("no", { status: 503 });
  const r = await handleNews(req("ai"));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /google 503, bing 503/);
});

test("accepts the term in the URL path", async () => {
  globalThis.fetch = async () => new Response(RSS);
  const r = await handleNews(new Request("https://app.test/api/news/Trends%20in%20Data%20%26%20AI"));
  assert.equal((await r.json()).query, "trends in data & ai");
});

test("isEnglish keeps English and drops other languages", () => {
  for (const ok of ["Nvidia earnings beat estimates", "Markets rally on tech earnings", "Jio's next chapter: Taking technology to the world", "AI", "India Inc. says GST cuts will help"])
    assert.ok(isEnglish(ok), ok);
  for (const bad of ["भारत में एआई स्टार्टअप को रिकॉर्ड फंडिंग", "人工智能市场增长", "Новости искусственного интеллекта",
    "El mercado de la inteligencia artificial crece en España", "Le marché de l'IA en France pour les entreprises", "Der Markt für KI wächst und die Preise sind hoch"])
    assert.ok(!isEnglish(bad), bad);
});

test("non-English stories are dropped from feeds", () => {
  const xml = `<rss><channel>
<item><title>AI funding hits record</title><link>https://a.example/1</link></item>
<item><title>भारत में एआई स्टार्टअप को रिकॉर्ड फंडिंग</title><link>https://a.example/2</link></item>
</channel></rss>`;
  assert.deepEqual(parseRss(xml).map((i) => i.url), ["https://a.example/1"]);
});
