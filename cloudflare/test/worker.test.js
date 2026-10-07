import test from "node:test";
import assert from "node:assert/strict";
import worker, { parseRss, parseGdelt, mergeItems, handleNews, handlePool, handlePools, handleOg, extractOgImage, isEnglish } from "../src/worker.js";
import { FEEDS, COUNTRIES, poolKeys, poolFeeds } from "../src/feeds.js";

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
  const out = mergeItems([
    [{ title: "Same story", url: "g", image: "", ts: 5 }, { title: "Only text", url: "t", image: "", ts: 9 }],
    [{ title: "Same  story!", url: "b", image: "https://i/x.jpg", ts: 4 }]]);
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

test("pool keys: international batches for everyone, plus the visitor's own country's feeds", () => {
  const intl = FEEDS.filter((f) => f.intl).length;
  assert.equal(poolKeys("").length, Math.ceil(intl / 2));
  assert.deepEqual(poolKeys("IN").filter((k) => k.startsWith("IN-")), ["IN-0", "IN-1", "IN-2"]);   // 5 Indian feeds, 2 per batch
  assert.equal(poolKeys("BR").length, poolKeys("").length);                                      // no own feeds -> intl only
  assert.ok(poolFeeds("g-0").every((f) => f.intl) && poolFeeds("IN-0").every((f) => f.home === "IN"));
  assert.equal(poolFeeds("IN-9"), null);
});

test("handlePool: fetches 2 feeds, tags stories with the publisher's home country, reports failures", async () => {
  const [a, b] = poolFeeds("g-0");
  globalThis.fetch = async (url) => url === b.url ? new Response("x", { status: 500 }) : new Response(PUBLISHER);
  const body = await (await handlePool(req("/api/pool/g-0"))).json();
  assert.equal(body.items.length, 5);
  assert.ok(body.items.every((i) => i.home === a.home && i.source === a.name));
  assert.deepEqual(body.failed, [`${b.name} 500`]);
  assert.equal((await handlePool(req("/api/pool/zzz-9"))).status, 404);
  assert.deepEqual(await (await handlePools(req("/api/pools/in"))).json(), { keys: poolKeys("IN") });
  assert.deepEqual((await (await handlePools(req("/api/pools/xx"))).json()).keys, poolKeys(""));
});

const GD = (title, img = "") => JSON.stringify({ articles: [{ url: "https://w.example/" + title.length, title, seendate: "20261007T101500Z", socialimage: img, domain: "w.example", language: "English" }] });
function countryFetch(log) {
  return async (url) => {
    log.push(url);
    if (url.includes("gdeltproject")) return new Response(url.includes("sourcecountry") ? GD("Local gdelt story about AI regulation") : GD("World headline everyone covers", "https://w.example/p.jpg"));
    return new Response(url.includes("bing.com") ? BING() : GOOGLE);
  };
}

test("country: India uses the Indian Google/Bing editions + GDELT sourcecountry, and adds world stories", async () => {
  const log = [];
  globalThis.fetch = countryFetch(log);
  const body = await (await handleNews(req("/api/news/IN/machine%20learning"))).json();
  const dec = log.map(decodeURIComponent);
  assert.ok(dec.some((u) => u.includes("news.google.com") && u.includes("gl=IN") && u.includes("ceid=IN:en") && u.includes("hl=en-IN")));
  assert.ok(dec.some((u) => u.includes("bing.com") && u.includes("setmkt=en-IN")));
  assert.ok(dec.some((u) => u.includes("sourcecountry:india") && u.includes("sort=datedesc")));
  assert.ok(dec.some((u) => u.includes("gdeltproject") && !u.includes("sourcecountry") && u.includes("sort=hybridrel")));
  assert.ok(!dec.some((u) => u.includes("q=machine learning india")));                         // IN has an edition: term not polluted
  assert.equal(body.country, "IN");
  const scopes = Object.fromEntries(body.items.map((i) => [i.title, i.scope]));
  assert.equal(scopes["World headline everyone covers"], "intl");
  assert.equal(scopes["Bing story"], "local");
  assert.equal(scopes["Local gdelt story about AI regulation"], "local");
});

test("country: no English edition (Brazil) -> US edition + country name in the query + GDELT sourcecountry", async () => {
  const log = [];
  globalThis.fetch = countryFetch(log);
  await handleNews(req("/api/news/BR/fintech"));
  const dec = log.map(decodeURIComponent);
  assert.ok(dec.some((u) => u.includes("news.google.com") && u.includes("q=fintech brazil") && u.includes("gl=US")));
  assert.ok(dec.some((u) => u.includes("bing.com") && u.includes("q=fintech brazil") && u.includes("setmkt=en-US")));
  assert.ok(dec.some((u) => u.includes("sourcecountry:brazil")));
});

test("country: unknown code is ignored; a 2-letter term alone is a term, not a country", async () => {
  const log = [];
  globalThis.fetch = countryFetch(log);
  const a = await (await handleNews(req("/api/news/ZZ/climate"))).json();
  assert.equal(a.country, ""); assert.ok(a.items.every((i) => !i.scope));
  const b = await (await handleNews(req("/api/news/ai"))).json();
  assert.equal(b.query, "ai"); assert.equal(b.country, "");
  const c = await (await handleNews(req("/api/news/US/ai"))).json();
  assert.equal(c.query, "ai"); assert.equal(c.country, "US");
});

test("countries + geo endpoints", async () => {
  const list = await (await worker.fetch(req("/api/countries"), {})).json();
  assert.ok(list.length > 40 && list.find((c) => c.code === "IN" && c.edition) && list.find((c) => c.code === "BR" && !c.edition));
  assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length);                  // no duplicate codes
  const geo = await worker.fetch(Object.assign(req("/api/geo"), { cf: { country: "IN" } }), {});
  assert.deepEqual(await geo.json(), { country: "IN" });
  assert.equal(geo.headers.get("Cache-Control"), "no-store");
});

test("og:image: extraction handles attribute order and relative URLs", () => {
  assert.equal(extractOgImage(`<meta content="/img/a.jpg" property="og:image">`, "https://s.example/post/1"), "https://s.example/img/a.jpg");
  assert.equal(extractOgImage(`<meta name="twitter:image" content="https://c.example/t.jpg">`, "https://s.example"), "https://c.example/t.jpg");
  assert.equal(extractOgImage(`<meta property="og:title" content="x">`, "https://s.example"), "");
});

test("handleOg: returns the photo, refuses unsafe targets", async () => {
  const b64 = (u) => Buffer.from(u).toString("base64url");
  globalThis.fetch = async () => new Response(`<html><head><meta property="og:image" content="https://cdn.example/hero.jpg"></head><body>`);
  assert.equal((await (await handleOg(req("/api/og/" + b64("https://news.example/story?id=1&x=%2F")))).json()).image, "https://cdn.example/hero.jpg");
  for (const bad of ["http://news.example/x", "https://127.0.0.1/x", "https://localhost/x", "https://news.google.com/rss/articles/abc", "not a url", "https://x.workers.dev/"])
    assert.equal((await handleOg(req("/api/og/" + b64(bad)))).status, 400, bad);
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
