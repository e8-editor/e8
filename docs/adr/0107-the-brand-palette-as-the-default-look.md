# 0107. The brand palette as the default look

Status: accepted · 2026-11-15

## Context

E8 took its colours from the ArtCraft Launcher's theme ([ADR 0004](0004-egui-front-end.md)): a warm off-white or near-black page and one blue accent. E8 now has a graphical profile of its own, built on six colours: Midnight `#260B40`, Lavender `#A477F5`, Ivory `#F8F4EB`, Jade `#71C7B1`, Amber `#E7B86B` and Rose `#D994A8`. Mark decided these become E8's default look, dark and light, rather than a theme to opt into.

Every colour E8 draws without a theme comes from one table, `PALETTE` in `crates/e8-core/src/faces.rs`: thirteen names, each with a dark and a light value. The default faces name them, the GUI's `Tokens` read them, and the terminal front end blends them over the page. Changing the look is changing that table.

## Options considered

1. **The page in Midnight.** The brand's darkest colour as the dark page. It is too saturated to sit behind code all day, and the mode line and menus, which are wells drawn a step from the page, would have nothing darker to be.
2. **A greyer, darker violet page, Midnight for wells.** The page keeps the brand's hue without its saturation, and Midnight marks the mode line, the menu bar, menus and tooltips.
3. **An opt-in theme.** The palette as a package, ArtCraft's colours staying the default. E8 would not look like itself until a user chose it.

## Decision

Option 2. `PALETTE` is now:

| Name | Dark | Light | Used for |
|---|---|---|---|
| `bg` | `#17121F` | `#F8F4EB` | the page |
| `sunken` | `#260B40` | `#ECE6D8` | mode line, highlight, tooltips, menus |
| `ink` | `#EAE5DA` | `#2B1A40` | text |
| `ink-strong` | `#F8F4EB` | `#1A0730` | emphasis |
| `muted` | ink at alpha 164 | ink at alpha 180 | secondary text |
| `faint` | ink at alpha 124 | ink at alpha 146 | comments, fringe |
| `line` | ink at alpha 38 | ink at alpha 41 | hairline rules |
| `accent` | `#A477F5` | `#A477F5` | surfaces |
| `accent-ink` | `#B899F8` | `#6A3FD0` | links, keywords, prompts |
| `selection` | `#A477F5` at alpha 84 | `#A477F5` at alpha 64 | the region |
| `good` | `#71C7B1` | `#1C7662` | success, strings |
| `warn` | `#E7B86B` | `#835600` | warnings, types |
| `bad` | `#F2708E` | `#B3264E` | errors |
| `rose` | `#D994A8` | `#A23A61` | constants, numbers |

`rose` is new. `font-lock-constant-face` and `font-lock-number-face` move to it from `bad`, so constants no longer look like errors. No other default face changes.

Contrast against the page, by the WCAG formula, translucent colours blended over it:

| Name | Dark | Light |
|---|---|---|
| `ink` | 14.6 | 14.4 |
| `muted` | 6.6 | 5.8 |
| `faint` | 4.3 | 3.9 |
| `accent-ink` | 7.8 | 5.9 |
| `good` | 9.2 | 5.0 |
| `warn` | 10.0 | 5.8 |
| `bad` | 6.5 | 5.8 |
| `rose` | 7.7 | 5.8 |

Text on a Lavender surface is dark in both appearances, never Ivory, which is 2.9:1 on it: Midnight is 5.4:1, the dark page 5.7:1 and the light `ink-strong` 5.9:1. The `isearch` face, the one default that puts text on `accent`, takes `bg` in the dark and `ink-strong` in the light.

In the dark, `sunken` and `bg` differ by hue more than by lightness (1.05:1). In the re-recorded snapshots the Midnight mode line, menu bar and menus still stand clearly apart from the page, so `bg` stays as above rather than going darker.

The GUI's visible bell, which drew white or black at alpha 40, now draws `ink` at that alpha, a token (`Tokens::flash`) like every other colour it draws.

## Consequences

- Both front ends start in the brand's colours with no theme loaded; a theme still overrides them, as the `default` face's colours replace the tokens ([ADR 0067](0067-themes-are-one-collection.md)).
- The terminal front end leaves the page to the terminal's own background and draws the mode line and region in reverse video, as Emacs's terminal frames do, so there only the syntax colours change.
- Faint text in the light is 3.9:1, under WCAG's 4.5 for body text; it is used for comments and the fringe, which are meant to recede. If it reads too faintly in use, raise its alpha.
- Every GUI snapshot changed.

## Dependencies introduced

None.
