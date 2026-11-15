# 0109. The lattice at startup

Status: accepted · 2026-11-15

## Context

Emacs opens on its splash screen, `*GNU Emacs*`, a buffer of logo and links that most users turn off with `inhibit-startup-screen`. E8 has no startup screen: it opens on `*scratch*` or the files it was given. With its graphical profile ([ADR 0106](0106-the-graphical-profile.md)) and palette ([ADR 0107](0107-the-brand-palette-as-the-default-look.md)), Mark wanted the window to greet the user without a splash screen in the way: the guided lattice "as a gentle background on the app window upon loading, gentle and behind everything", fading out "with a non-linear crossfade after 5 or 10 seconds". It is a deliberate departure from Emacs, a sign that E8 is a newer editor.

## Options considered

1. **A splash buffer, as Emacs's.** Familiar, but it takes the window and has to be dismissed, and Emacs users mostly turn it off.
2. **An image behind the text.** The lattice's SVG, rendered to a texture. It would need a renderer for SVG in the GUI at startup, or a PNG at each scale, and could not take the theme's colours.
3. **The lattice drawn from coordinates.** egui's painter draws its lines, dots and path from a Rust constant, in the page's tokens, over the page's background and under the text, and animates it.

## Decision

Option 3, in the GUI only.

- **Geometry.** `crates/e8-gui/src/lattice/geometry.rs` holds the guided field's 166 lines, 65 dots and its path, in its 3008 by 676 box, written by `make-geometry.py` beside it from `docs/assets/lattices/guided-field.svg`, the drawing as the brand ships it.
- **Placement.** Across the window, centred, keeping its proportions, with 6 per cent of the width left either side, and never more than 80 per cent of its height. It is painted over the page's background and before anything else, so text, the mode line and the echo area are drawn over it.
- **Colour.** The lines and dots in the `ink` token at 18 per cent, lines the drawing has fainter fainter still; the path and the dots on it in `accent` at 45 per cent. A theme's colours carry through, as the tokens take them.
- **Motion.** The field rises over half a second while the path draws in from left to right over 1.2 seconds, easing in and out, its dots coming up as it reaches them. It holds until 2.5 seconds, then fades over 3.5 seconds on a cubic ease-out, so it falls away quickly and lingers faintly before it is gone, six seconds after it began. The first key press, click or scroll fades it within 0.4 seconds. The clock starts at the first frame the editor has described, once init.ts has run.
- **Repainting.** While it shows, the window asks for a frame each time it draws; once it has gone it asks for none, and the window is as idle as without it.
- **Turning it off.** `e8-startup-lattice`, on by default, set to nil in init.ts, or Emacs's `inhibit-startup-screen` (or its older names `inhibit-splash-screen` and `inhibit-startup-message`) set to t. It shows only in the application's window, which asks for it with `E8App::with_startup_lattice`; test windows do not, so it never shows in their snapshots, and the terminal and `--batch` have no window to show it in.

## Consequences

- Each new window of the application starts with six seconds of drawing at the display's frame rate; afterwards nothing is drawn that was not before.
- A theme with a busy page could make the lattice harder to see, or text over it harder to read; its strength is two constants in `lattice/mod.rs`.
- The website, E8 in a browser ([ADR 0066](0066-e8-in-a-browser.md)), does not ask for it, as its page already draws the lattice behind its heading.
- A change to the drawing in `docs/assets/lattices/guided-field.svg` reaches the GUI only when `make-geometry.py` is run again.

## Dependencies introduced

None.
