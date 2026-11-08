#!/usr/bin/env python3
"""Serves crates/e8-web/web on http://localhost:8008 with the headers that
make the page cross-origin isolated, which shared WebAssembly memory needs."""

import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8008
print(f"E8 on http://localhost:{port}")
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(ROOT))).serve_forever()
