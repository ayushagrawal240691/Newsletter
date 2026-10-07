# Live News Dashboard

> **Want it online for free, always on, shareable?** Use the Cloudflare version in [`cloudflare/`](cloudflare/README.md). The Python server below is for local use.

A persona-driven news dashboard. Each persona has interest areas; a background poller
continuously pulls fresh headlines from the web (Google News RSS search per interest, plus any
RSS/Atom feeds you list) and pushes new items to the browser live over Server-Sent Events.

No dependencies beyond Python 3.9+.

    python3 server.py --port 8000 --poll 120     # then open http://127.0.0.1:8000

## Personas

Edit `personas.json` or use **+ Persona** in the UI (changes are saved to the file):

    "Startup Founder": {"interests": {
        "AI": {"query": "artificial intelligence OR LLM"},
        "Hacker News": {"feeds": ["https://hnrss.org/frontpage"]}}}

- `query` – search terms, sent to Google News RSS (last 24h)
- `feeds` – any RSS/Atom URLs (blogs, subreddits, publisher feeds)

## API
`GET /api/personas` · `GET /api/news?persona=&interest=` · `GET /api/stream` (SSE) ·
`POST /api/personas` · `DELETE /api/personas/<name>` · `POST /api/refresh`

## Tests
    pip install pytest && python3 -m pytest tests
