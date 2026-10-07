# Live News Dashboard — free, always-on, shareable (Cloudflare)

Anyone with the link enters their interests once, creates a persona, and the browser remembers it.
The page refreshes itself every hour. No server to keep awake, no database, no cost.

```
Browser (persona saved in localStorage)
   └─ GET /api/news?q=<interest>   (one call per interest, every hour)
        └─ Cloudflare Worker ──► Google News RSS   (upstream response cached 1h at the edge)
```

## Deploy (≈10 minutes, $0, no credit card)

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up (email + password).
2. **Install and log in** (needs Node 18+):
   ```bash
   cd cloudflare
   npm install
   npx wrangler login        # opens a browser to authorise
   ```
3. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   It prints your public link, e.g. `https://live-news-dashboard.<your-subdomain>.workers.dev`.
   That's the URL you share. Done — it's live and always on.
4. **Update later:** edit files, run `npx wrangler deploy` again.

Optional: auto-deploy on every push to GitHub — in the Cloudflare dashboard go to
*Workers & Pages → your Worker → Settings → Builds → Connect to Git*.

Local preview: `npm run dev` (http://localhost:8787). Tests: `npm test`.

## How the requirements are met

| Need | How |
|---|---|
| Always on, free | Workers are serverless and never sleep. Free plan: 100,000 requests/day. |
| Shareable link | The `workers.dev` URL above (or attach your own domain later). |
| Remember each person's interests | Saved in the visitor's browser (`localStorage`); no re-entry on later visits. |
| Persona on another device | **Share** button copies a link containing the persona; opening it offers *Save*. |
| English only | Both feeds are requested in their English edition, and the Worker also drops any story whose title is in another language. |
| Refresh every hour | The page reloads feeds every 60 min (and when a sleeping tab wakes); the Worker's upstream fetch is edge-cached for 60 min, so everyone sees the same hourly snapshot. |

## News sources & pictures
- **Per interest:** Bing News, Google News and GDELT (a free global news index with article photos), merged and de-duplicated.
- **Popular publishers:** BBC, The Guardian, NYT, CNBC, Al Jazeera, TechCrunch, Times of India, Economic Times,
  The Hindu, NDTV, Hindustan Times, WIRED. Their stories are matched to each person's interests in the browser;
  each publisher's lead stories also appear under **🔥 Top headlines**. Edit the list in `src/feeds.js`.
- **Pictures:** taken from the feeds themselves; for stories without one the Worker reads the article's own social-share
  image (`og:image`). Stories that still have no real photo are listed under *More headlines* instead of getting a placeholder tile.
- A feed that is down is skipped; the Worker never fails because one source did.
- Cloudflare's free plan limits CPU time per request, so publisher feeds are fetched 2 at a time (`/api/pool/0…6`).

## Capacity & limits (free tier)
- Each page load = 1 Worker request per interest (max 10), plus 7 publisher batches and a few photo lookups, so ≈ 15–25 requests. 100k/day ≈ 4–6k page loads/day.
  Hourly refreshes from open tabs count too. Identical interests across users share the edge cache,
  so Google News is hit roughly once per interest per hour, not per user.
- Personas live in one browser. Clearing site data or switching browsers loses them — use **Share**
  to carry one over. (Cross-device sync with accounts would need Cloudflare KV + login; ask if you want it.)
- The data source is Google News RSS (unofficial but widely used). If it ever rate-limits you, add
  other RSS feeds in `src/worker.js` or swap in a free news API (GNews, NewsData.io).
