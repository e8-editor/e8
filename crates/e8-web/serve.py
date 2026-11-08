#!/usr/bin/env python3
"""Serves crates/e8-web/web on http://localhost:8008 with the headers that
make the page cross-origin isolated, which shared WebAssembly memory needs.

Usage: serve.py [PORT] [--dir DIR] [--no-isolation]

--dir serves another directory, such as the website website/assemble.sh
puts together. --no-isolation leaves the headers out, as GitHub Pages
does, so the website's service worker has to add them."""

import argparse
import functools
import http.server
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument("port", nargs="?", type=int, default=8008)
parser.add_argument("--dir", default=str(pathlib.Path(__file__).resolve().parent / "web"))
parser.add_argument("--no-isolation", action="store_true")
args = parser.parse_args()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}

    def end_headers(self):
        if not args.no_isolation:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


print(f"E8 on http://localhost:{args.port}, from {args.dir}")
http.server.ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(Handler, directory=args.dir)).serve_forever()
