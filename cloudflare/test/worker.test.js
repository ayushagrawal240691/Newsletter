import test from "node:test";
import assert from "node:assert/strict";
import { parseRss, handleNews } from "../src/worker.js";

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

test("handleNews normalises query, requests 1h edge caching, rejects bad input", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => (seen.push({ url, init }), new Response(RSS));
  const a = await handleNews(req("  AI  chips"));
  await handleNews(req("ai chips"));
  assert.equal(a.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(seen[0].url, seen[1].url);
  assert.deepEqual(seen[0].init.cf, { cacheTtl: 3600, cacheEverything: true });
  assert.equal((await a.json()).items.length, 2);
  assert.equal((await handleNews(req(""))).status, 400);
  assert.equal((await handleNews(req("x".repeat(101)))).status, 400);
});

test("falls back to Bing when Google refuses, and unwraps Bing redirect links", async () => {
  globalThis.fetch = async (url) => url.includes("google") ? new Response("blocked", { status: 429 }) : new Response(BING);
  const body = await (await handleNews(req("ai"))).json();
  assert.equal(body.items[0].url, "https://news.example.org/a");
  assert.equal(body.items[0].source, "Example News");
});

test("widens Google to 7 days when 1 day is empty", async () => {
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(url.includes("when%3A7d") ? RSS : "<rss><channel></channel></rss>"));
  assert.equal((await (await handleNews(req("niche"))).json()).items.length, 2);
  assert.equal(urls.length, 2);
});

test("reports which sources failed when all fail", async () => {
  globalThis.fetch = async () => new Response("no", { status: 503 });
  const r = await handleNews(req("ai"));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /google 503, bing 503/);
});
