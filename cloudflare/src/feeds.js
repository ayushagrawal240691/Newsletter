// Kept out of worker.js: a Worker entry module may only export handlers/functions, not constants.

// ---- Countries ----------------------------------------------------------------------------
// gnews: Google News has an English-language edition for this country (hl=en-XX, gl=XX, ceid=XX:en).
// bing:  Bing News market for this country's English edition (setmkt). Others fall back to en-US and
//        the country name is added to the search so results are about / from that country.
const C = (code, name, gnews = false, bing = false) => ({ code, name, gnews, bing });
export const COUNTRIES = [
  C("IN", "India", true, true), C("US", "United States", true, true), C("GB", "United Kingdom", true, true),
  C("AU", "Australia", true, true), C("CA", "Canada", true, true), C("IE", "Ireland", true),
  C("NZ", "New Zealand", true, true), C("ZA", "South Africa", true, true), C("SG", "Singapore", true),
  C("NG", "Nigeria", true), C("KE", "Kenya", true), C("PH", "Philippines", true, true),
  C("MY", "Malaysia", true, true), C("PK", "Pakistan", true), C("HK", "Hong Kong", true),
  C("IL", "Israel", true), C("ID", "Indonesia", true, true), C("GH", "Ghana", true), C("TZ", "Tanzania", true),
  C("UG", "Uganda", true), C("ZW", "Zimbabwe", true), C("BW", "Botswana", true), C("NA", "Namibia", true),
  C("ET", "Ethiopia", true),
  C("AE", "United Arab Emirates"), C("SA", "Saudi Arabia"), C("QA", "Qatar"), C("EG", "Egypt"),
  C("BD", "Bangladesh"), C("LK", "Sri Lanka"), C("NP", "Nepal"), C("DE", "Germany"), C("FR", "France"),
  C("ES", "Spain"), C("IT", "Italy"), C("NL", "Netherlands"), C("SE", "Sweden"), C("NO", "Norway"),
  C("DK", "Denmark"), C("FI", "Finland"), C("CH", "Switzerland"), C("PL", "Poland"), C("PT", "Portugal"),
  C("GR", "Greece"), C("TR", "Turkey"), C("UA", "Ukraine"), C("RU", "Russia"), C("JP", "Japan"),
  C("KR", "South Korea"), C("CN", "China"), C("TW", "Taiwan"), C("TH", "Thailand"), C("VN", "Vietnam"),
  C("BR", "Brazil"), C("MX", "Mexico"), C("AR", "Argentina"), C("CL", "Chile"), C("CO", "Colombia"),
];

// ---- Publisher feeds (free public RSS) -----------------------------------------------------
// intl: fetched for everyone as "international" candidates. home: the publisher's country; a story is
// "local" for a user whose country equals `home`, otherwise "international".
// Country-specific feeds (intl:false) are only fetched for users from that country.
// A feed that is down is skipped, never fatal.
const F = (name, url, home, intl = false) => ({ name, url, home, intl });
export const FEEDS = [
  F("BBC News", "https://feeds.bbci.co.uk/news/world/rss.xml", "GB", true),
  F("The New York Times", "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "US", true),
  F("The Guardian", "https://www.theguardian.com/world/rss", "GB", true),
  F("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", "QA", true),
  F("CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "US", true),
  F("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml", "GB", true),
  F("BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml", "GB", true),
  F("TechCrunch", "https://techcrunch.com/feed/", "US", true),
  F("WIRED", "https://www.wired.com/feed/rss", "US", true),
  // India
  F("Times of India", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "IN"),
  F("The Economic Times", "https://economictimes.indiatimes.com/rssfeedstopstories.cms", "IN"),
  F("The Hindu", "https://www.thehindu.com/news/national/feeder/default.rss", "IN"),
  F("NDTV", "https://feeds.feedburner.com/ndtvnews-top-stories", "IN"),
  F("Hindustan Times", "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml", "IN"),
  // other English-language countries
  F("ABC News Australia", "https://www.abc.net.au/news/feed/51120/rss.xml", "AU"),
  F("CBC News", "https://www.cbc.ca/webfeed/rss/rss-topstories", "CA"),
  F("RTÉ News", "https://www.rte.ie/news/rss/news-headlines.xml", "IE"),
  F("RNZ", "https://www.rnz.co.nz/rss/national.xml", "NZ"),
  F("Channel NewsAsia", "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml", "SG"),
  F("Dawn", "https://www.dawn.com/feeds/home", "PK"),
  F("Punch", "https://punchng.com/feed/", "NG"),
  F("The Star", "https://www.thestar.com.my/rss/News/Nation", "MY"),
  F("Philippine Daily Inquirer", "https://newsinfo.inquirer.net/feed", "PH"),
  F("BBC UK", "https://feeds.bbci.co.uk/news/uk/rss.xml", "GB"),
  F("NYT U.S.", "https://rss.nytimes.com/services/xml/rss/nyt/US.xml", "US"),
];
export const POOL_SIZE = 2;                       // feeds per request (keeps each request within the free CPU limit)

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Batch keys a visitor from `country` needs: "g-0.." = international feeds, "IN-0.." = that country's own feeds.
export function poolKeys(country) {
  const keys = chunk(FEEDS.filter((f) => f.intl), POOL_SIZE).map((_, i) => `g-${i}`);
  if (country) keys.push(...chunk(FEEDS.filter((f) => !f.intl && f.home === country), POOL_SIZE).map((_, i) => `${country}-${i}`));
  return keys;
}
export function poolFeeds(key) {
  const [group, idx] = String(key).split("-");
  const list = group === "g" ? FEEDS.filter((f) => f.intl) : FEEDS.filter((f) => !f.intl && f.home === group);
  return chunk(list, POOL_SIZE)[Number(idx)] || null;
}
