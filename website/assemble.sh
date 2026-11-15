#!/bin/sh
# Puts the website together in DIR (default target/site): the page and its
# service worker from website/, E8 as crates/e8-web/build.sh built it, the
# brand files from docs/assets, and in config/ the configuration E8 starts with,
# its packages fetched by config.sh. Serve it with
#   python3 crates/e8-web/serve.py --dir target/site --no-isolation
# to see it as GitHub Pages serves it.
set -eu
cd "$(dirname "$0")/.."
out=${1:-target/site}
if [ ! -f crates/e8-web/web/pkg/e8_web_bg.wasm ]; then
  echo "Build E8 for the web first: crates/e8-web/build.sh" >&2
  exit 1
fi
rm -rf "$out"
mkdir -p "$out/pkg" "$out/assets/lattices"
cp website/index.html website/sw.js "$out/"
cp crates/e8-web/web/worker.js crates/e8-web/web/storage.js crates/e8-web/web/touchkeys.js "$out/"
cp crates/e8-web/web/pkg/e8_web.js crates/e8-web/web/pkg/e8_web_bg.wasm "$out/pkg/"
cp docs/assets/logo.svg docs/assets/logo-reverse.svg docs/assets/symbol-lavender.svg \
  docs/assets/icon.svg docs/assets/icon-512.png docs/assets/favicon.ico docs/assets/apple-touch-icon.png \
  docs/assets/social-dark.png docs/assets/social-light.png \
  docs/assets/banner-light.png docs/assets/banner-dark.png "$out/assets/"
cp docs/assets/lattices/guided-field.svg docs/assets/lattices/guided-field-on-dark.svg "$out/assets/lattices/"
website/config.sh "$out/config"
# Pages serves the files as they are, without Jekyll.
touch "$out/.nojekyll"
du -sh "$out"
