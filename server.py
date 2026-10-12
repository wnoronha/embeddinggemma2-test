#!/usr/bin/env python3
"""Static server + same-origin proxy for the System-One Racer.

Why the proxy exists
--------------------
`https://api.typesafe.ai` does not allow browser (CORS) calls: its preflight
answers HTTP 400 and responses carry no `Access-Control-Allow-Origin` header,
so `fetch()` from the page fails with `TypeError: Failed to fetch`. OpenAI's
API does send `Access-Control-Allow-Origin: *`, so it is called directly.

This server forwards `POST /api/jev` -> `POST https://api.typesafe.ai/v1/systemone`
(passthrough `Authorization` + JSON body) and serves everything else as static
files. Keys stay in the browser's localStorage; the proxy never stores them.

Usage:
    python3 server.py [port]   # default 8080
"""

import json
import sys
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

JEV_UPSTREAM = "https://api.typesafe.ai/v1/systemone"
MAX_BODY = 256 * 1024


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/jev":
            self.send_error(404, "Only /api/jev is proxied")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send_json(400, {"error": "missing or oversized body"})
            return
        raw = self.rfile.read(length)
        try:
            json.loads(raw)  # validate JSON before forwarding
        except ValueError:
            self._send_json(400, {"error": "body must be JSON"})
            return
        auth = self.headers.get("Authorization")
        if not auth:
            self._send_json(401, {"error": "missing Authorization header (paste your TypeSafe key in the Jev card)"})
            return
        req = urllib.request.Request(
            JEV_UPSTREAM,
            data=raw,
            method="POST",
            headers={"Authorization": auth, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get_content_type() or "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read() or b"{}"
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # upstream unreachable / timeout
            self._send_json(502, {"error": "jev upstream unreachable: %s" % e})

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("racer server on http://localhost:%d  (static + POST /api/jev proxy)" % port, flush=True)
    srv.serve_forever()
