// Kept out of worker.js: a Worker entry module may only export handlers/functions, not constants.
// Popular English-language publishers (free public RSS). A feed that is down is skipped, not fatal.
export const FEEDS = [
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { name: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { name: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Times of India", url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms" },
  { name: "The Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms" },
  { name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
  { name: "NDTV", url: "https://feeds.feedburner.com/ndtvnews-top-stories" },
  { name: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml" },
  { name: "WIRED", url: "https://www.wired.com/feed/rss" },
];
export const POOL_SIZE = 2;
export const POOL_COUNT = Math.ceil(FEEDS.length / POOL_SIZE);

