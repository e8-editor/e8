# 0106. E8's graphical profile

Status: accepted · 2026-11-15

## Context

E8's first logo, banner and app icon were an ink mark with an orange sun, made when E8 was named, and the GUI took its colours from the ArtCraft Launcher's ([ADR 0004](0004-egui-front-end.md)). Mark then had a full design kit made for E8: a symbol, a wordmark, a palette, icons, banners, social cards and lattice drawings, vector throughout. Its artwork and colours are what E8 should look like; its words were written by someone who did not know E8, and describe it wrongly.

## Decision

The kit's artwork is E8's graphical profile, in `docs/assets/`, with the kit's wording replaced.

- **The symbol** is an eight-fold rosette of facets, drawn in strokes (`symbol.svg`, `symbol-reverse.svg`, `symbol-lavender.svg`).
- **The wordmark** is a serif E with a subscript 8, outlined, so no font is needed to draw it (`wordmark.svg`, `wordmark-reverse.svg`). The logo is the symbol and wordmark together (`logo.svg`, `logo-reverse.svg`, `logo-monochrome.svg`).
- **The colours** are Midnight `#260B40`, Lavender `#A477F5` and Ivory `#F8F4EB`, with Jade `#71C7B1`, Amber `#E7B86B` and Rose `#D994A8` beside them. Text on Lavender is Midnight, never Ivory.
- **The icon** is the symbol in Ivory on a Midnight tile: `icon.svg`, and `icon-small.svg`, without the inner spokes, for 32 pixels and less. `icon-512.png`, `favicon.ico` and `apple-touch-icon.png` are the kit's exports. `crates/e8-gui/macos/E8.icns` is made from the two SVGs by `crates/e8-gui/macos/make-icns.sh`, with the tile at 824 of 1024 pixels on a transparent canvas, as macOS icons sit inside a margin.
- **The lattices** are three drawings of a field of points and lines, the guided one with a path through it (`lattices/`), in Midnight on light pages and Ivory on dark ones (`-on-dark`).
- **The tagline** is "An editor that works the way Emacs works.", and the technology label "Rust / TypeScript". The banners (`banner-dark`, `banner-light`, `banner-compact`) and social cards (`social-dark`, `social-light`) carry them as live text in their SVGs, which are the sources; the README, the website and `og:image` use PNGs rendered from them with resvg (`resvg --zoom 2` for the banners, at size for the social cards), so the text looks the same to every reader whatever fonts they have.
- **Sources.** `docs/assets/source/` holds the kit's helpers that draw the rosette and wordmark, and `docs/assets/lattices/source/` the lattices' coordinates and the reference the guided one was traced from, so the artwork can be made again.
- **The website** takes the logo, favicon, touch icon and social card, its page colours move to the brand's in both colour schemes, and the guided lattice is drawn faintly behind the heading.

The kit's own pages, examples, scripts, backgrounds and ornaments are left out, as nothing uses them.

The artwork was generated for Mark and is shipped under the repository's licence, GPL-3.0-or-later ([ADR 0014](0014-gpl.md)).

This replaces ADR 0004's ArtCraft look for colour; egui stays, and so do the hard edges and hairline rules. The editor's own palette, built on these colours, is decided in an ADR of its own.

## Consequences

- **One source per image.** A change to a banner's wording is an edit to its SVG and a render; nothing is drawn by hand twice.
- **Fonts in the renders.** The banners' text is Helvetica, so the PNGs are rendered on a Mac; elsewhere resvg falls back to Arial or another sans.
- **Kept out of the repository:** the kit's `index.html` guide, `gallery.html`, `examples/`, `style.css`, `demo.js`, `04-backgrounds` and `05-elements`. They can be taken from the kit if something comes to need them.
- **Steps outside the repository:** the organisation's avatar and each repository's social preview are set in GitHub's settings pages, by hand.
