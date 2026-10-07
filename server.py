#!/usr/bin/env python3
"""Persona-based live news dashboard. Standard library only.

A background poller pulls RSS/Atom feeds for every interest of every persona
(Google News search RSS for `query`, plus any explicit `feeds`), de-duplicates
the items and pushes new ones to browsers over Server-Sent Events.
"""
import argparse, hashlib, json, queue, re, threading, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PERSONAS_FILE = ROOT / "personas.json"
GNEWS = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
MAX_ITEMS_PER_INTEREST = 60
UA = "Mozilla/5.0 (compatible; NewsDashboard/1.0)"

lock = threading.RLock()
articles = {}          # id -> article dict
subscribers = set()    # queues of SSE clients
status = {}            # "persona/interest" -> {"ok": bool, "last": ts, "error": str}
config = {"personas": {}, "poll_seconds": 120}


def load_personas():
    data = json.loads(PERSONAS_FILE.read_text())
    with lock:
        config["personas"] = data["personas"]


def save_personas():
    with lock:
        PERSONAS_FILE.write_text(json.dumps({"personas": config["personas"]}, indent=2))


# ---------- feed parsing ----------
ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}


def _text(el, tag):
    found = el.find(tag, ATOM_NS)
    return (found.text or "").strip() if found is not None else ""


def _strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def _parse_date(s):
    if not s:
        return time.time()
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return time.time()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def parse_feed(xml_bytes, default_source=""):
    root = ET.fromstring(xml_bytes)
    out = []
    if root.tag.endswith("feed"):  # Atom
        ns = ATOM_NS
        feed_title = _text(root, "a:title") if root.find("a:title", ns) is not None else default_source
        for e in root.findall("a:entry", ns):
            link = e.find("a:link", ns)
            out.append({
                "title": _text(e, "a:title"),
                "url": link.get("href") if link is not None else "",
                "summary": _strip_html(_text(e, "a:summary") or _text(e, "a:content")),
                "source": feed_title or default_source,
                "ts": _parse_date(_text(e, "a:updated") or _text(e, "a:published")),
            })
    else:  # RSS 2.0
        channel = root.find("channel")
        feed_title = _text(channel, "title") if channel is not None else default_source
        for it in root.iter("item"):
            src = it.find("source")
            title = _text(it, "title")
            source = (src.text or "").strip() if src is not None and src.text else feed_title
            if source and title.endswith(" - " + source):   # Google News suffix
                title = title[: -len(source) - 3]
            out.append({
                "title": title,
                "url": _text(it, "link"),
                "summary": _strip_html(_text(it, "description")),
                "source": source or default_source,
                "ts": _parse_date(_text(it, "pubDate")),
            })
    return [a for a in out if a["title"] and a["url"]]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


# ---------- polling ----------
def interest_urls(spec):
    urls = []
    if spec.get("query"):
        q = spec["query"] + " when:1d"
        urls.append(GNEWS.format(q=urllib.parse.quote(q)))
    urls += spec.get("feeds", [])
    return urls


def poll_interest(persona, interest, spec):
    key = f"{persona}/{interest}"
    new, errors = [], []
    for url in interest_urls(spec):
        try:
            items = parse_feed(fetch(url), urllib.parse.urlparse(url).netloc)
        except Exception as e:  # network / parse errors must not kill the poller
            errors.append(f"{urllib.parse.urlparse(url).netloc}: {e}")
            continue
        with lock:
            for a in items:
                aid = hashlib.sha1(f"{persona}|{interest}|{a['url']}".encode()).hexdigest()[:16]
                if aid in articles:
                    continue
                a.update(id=aid, persona=persona, interest=interest, fetched=time.time())
                articles[aid] = a
                new.append(a)
    with lock:
        status[key] = {"ok": not errors, "last": time.time(), "error": "; ".join(errors)}
        prune(persona, interest)
    return new


def prune(persona, interest):
    mine = sorted((a for a in articles.values()
                   if a["persona"] == persona and a["interest"] == interest),
                  key=lambda a: a["ts"], reverse=True)
    for a in mine[MAX_ITEMS_PER_INTEREST:]:
        del articles[a["id"]]


def broadcast(items):
    if not items:
        return
    msg = json.dumps(sorted(items, key=lambda a: a["ts"], reverse=True))
    with lock:
        for q in list(subscribers):
            q.put(msg)


def poll_all(only_persona=None):
    with lock:
        jobs = [(p, i, s) for p, d in config["personas"].items() if only_persona in (None, p)
                for i, s in d["interests"].items()]
    for job in jobs:
        broadcast(poll_interest(*job))


def poller():
    while True:
        poll_all()
        time.sleep(config["poll_seconds"])


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path == "/api/personas":
            with lock:
                return self._json(config["personas"])
        if u.path == "/api/news":
            persona = qs.get("persona", [""])[0]
            interest = qs.get("interest", [""])[0]
            with lock:
                items = [a for a in articles.values() if a["persona"] == persona
                         and (not interest or a["interest"] == interest)]
                st = {k: v for k, v in status.items() if k.startswith(persona + "/")}
            items.sort(key=lambda a: a["ts"], reverse=True)
            return self._json({"items": items[:200], "status": st, "poll_seconds": config["poll_seconds"]})
        if u.path == "/api/stream":
            return self._stream()
        f = ROOT / "static" / ("index.html" if u.path == "/" else u.path.lstrip("/"))
        if f.is_file() and ROOT / "static" in f.resolve().parents:
            ctype = {"html": "text/html", "css": "text/css", "js": "text/javascript"}.get(f.suffix[1:], "application/octet-stream")
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        self._json({"error": "not found"}, 404)

    def _stream(self):
        q = queue.Queue()
        with lock:
            subscribers.add(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                try:
                    self.wfile.write(f"data: {q.get(timeout=20)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with lock:
                subscribers.discard(q)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        if u.path == "/api/personas":     # create / replace a persona
            name, interests = str(body.get("name", "")).strip(), body.get("interests", {})
            if not name or not isinstance(interests, dict) or not interests:
                return self._json({"error": "name and interests required"}, 400)
            with lock:
                config["personas"][name] = {"interests": interests}
                save_personas()
            threading.Thread(target=poll_all, args=(name,), daemon=True).start()
            return self._json({"ok": True})
        if u.path == "/api/refresh":
            threading.Thread(target=poll_all, daemon=True).start()
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        name = urllib.parse.unquote(urllib.parse.urlparse(self.path).path.removeprefix("/api/personas/"))
        with lock:
            if name not in config["personas"]:
                return self._json({"error": "not found"}, 404)
            del config["personas"][name]
            for k in [k for k, a in articles.items() if a["persona"] == name]:
                del articles[k]
            save_personas()
        self._json({"ok": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--poll", type=int, default=120, help="seconds between feed refreshes")
    args = ap.parse_args()
    config["poll_seconds"] = args.poll
    load_personas()
    threading.Thread(target=poller, daemon=True).start()
    print(f"News dashboard on http://{args.host}:{args.port}")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
