#!/bin/sh
# Makes E8.icns from the brand's icons in docs/assets (ADR 0106):
# icon-small.svg for the 16 and 32 pixel images, icon.svg for the rest.
# A macOS icon sits inside a margin, so the tile is drawn at 824 of 1024
# pixels, centred on a transparent canvas, its corners scaling with it.
# Needs resvg (`nix run nixpkgs#resvg` gives it) and macOS's iconutil.
set -eu
cd "$(dirname "$0")/../../.."
resvg=${RESVG:-resvg}
command -v "$resvg" >/dev/null || { echo "resvg not found; set RESVG" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
set=$work/E8.iconset
mkdir "$set"
# The icon's own drawing, inside a 1024 canvas with the tile at 824.
for name in icon icon-small; do
  inner=$(sed -e 's|^<svg[^>]*>||' -e 's|</svg>$||' "docs/assets/$name.svg")
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(3.21875)">%s</g></svg>\n' \
    "$inner" > "$work/$name.svg"
done
for points in 16 32 128 256 512; do
  for scale in 1 2; do
    px=$((points * scale))
    if [ $px -le 32 ]; then src=icon-small; else src=icon; fi
    if [ $scale = 1 ]; then out=icon_${points}x${points}.png; else out=icon_${points}x${points}@2x.png; fi
    "$resvg" -w $px -h $px "$work/$src.svg" "$set/$out" 2>/dev/null
  done
done
iconutil -c icns -o crates/e8-gui/macos/E8.icns "$set"
echo "wrote crates/e8-gui/macos/E8.icns"
