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

test("handleNews normalises the query, asks for 1h edge caching, and rejects bad input", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => (seen.push({ url, init }), new Response(RSS));
  const req = (q) => new Request("https://app.test/api/news?q=" + encodeURIComponent(q));

  const a = await handleNews(req("  AI  chips"));
  const b = await handleNews(req("ai chips"));
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(seen[0].url, seen[1].url);                       // same edge-cache key
  assert.deepEqual(seen[0].init.cf, { cacheTtl: 3600, cacheEverything: true });
  assert.equal((await b.json()).items.length, 2);

  assert.equal((await handleNews(req(""))).status, 400);
  assert.equal((await handleNews(req("x".repeat(101)))).status, 400);

  globalThis.fetch = async () => new Response("no", { status: 503 });
  assert.equal((await handleNews(req("ai"))).status, 502);
});
