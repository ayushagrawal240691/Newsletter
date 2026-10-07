import json, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import server

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>Mock</title>
<item><title>Big AI news - Example Wire</title><link>https://example.com/1</link>
<description>&lt;b&gt;Hello&lt;/b&gt; world</description><pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate>
<source url="https://example.com">Example Wire</source></item>
<item><title>No link</title></item></channel></rss>"""
ATOM = b"""<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Src</title>
<entry><title>Atom item</title><link href="https://example.com/a"/><updated>2026-10-07T09:00:00Z</updated><summary>s</summary></entry></feed>"""


def test_parse_rss_strips_source_suffix_and_html():
    (a,) = server.parse_feed(RSS)
    assert a["title"] == "Big AI news" and a["source"] == "Example Wire"
    assert a["summary"] == "Hello world" and a["url"] == "https://example.com/1"


def test_parse_atom():
    (a,) = server.parse_feed(ATOM)
    assert a["title"] == "Atom item" and a["source"] == "Atom Src" and a["ts"] > 0


def test_poll_dedupes_and_broadcasts():
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(RSS)
        def log_message(self, *a): pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}/f"
    first = server.poll_interest("P", "I", {"feeds": [url]})
    second = server.poll_interest("P", "I", {"feeds": [url]})
    assert len(first) == 1 and second == []
    assert server.status["P/I"]["ok"]


def test_failing_source_is_reported_not_raised():
    server.poll_interest("P", "Bad", {"feeds": ["http://127.0.0.1:1/x"]})
    assert not server.status["P/Bad"]["ok"]
