# 0081. The display as Emacs asks about it: x-display-*, monitors, and AppleScript

Status: accepted · 2026-11-14

## Context

With charsets, the keyboard and XML done, what is left at the top of the ranking ([docs/parity/demand.md](../parity/demand.md)) is the display's own questions (0.18): twenty-five primitives, wanted by six of Emacs's own libraries, two MELPA packages and two daily ones, and all that pos-tip and ess lack.

Emacs asks the window system directly, through the back end it was built with — `nsfns.m` on macOS, `xfns.c` on X — so the names are `x-display-pixel-width`, `ns-frame-geometry`, `xw-color-values`. Lisp calls them through `frame.el`'s wrappers (`display-pixel-width`, `display-monitor-attributes-list`) or by name where only one back end has it (`ns-do-applescript`).

E8 has none of them, and the editor is the wrong place to ask: the core runs on a thread of its own and must not touch a window system ([ADR 0004](0004-egui-front-end.md)). It already has the shape for this, though: [ADR 0077](0077-frames-and-the-window-tree-as-emacs-has-them.md) has a front end write each frame's geometry in as it draws, and the editor answers from what it was told.

## Options considered

1. **Ask the window system from the core**, as Emacs does. It would put a GUI dependency in `e8-core`, which has none, and there is nothing to ask on a terminal or in a headless editor.
2. **The front end writes the display in**, as it writes a frame's geometry: its size in pixels and millimetres, how many colours it has, and each monitor's place. The editor answers every question from that, and from its own colours.

## Decision

Option 2. The work lands in one pull request, behind `make check` on both engines, a review against nsfns.m and frame.c, and the ported packages' tests.

- **A display** the front end writes in (`Editor::set_display`), as it writes a frame's geometry: its size in the front end's units and in millimetres, its colour depth, whether it has colour at all, and the monitors it is made of. A terminal writes its own size in characters, as Emacs's `display-pixel-width` answers `frame-width` there; a headless editor has one monitor the size of its frame.
- **The sizes**: `x-display-pixel-width`, `x-display-pixel-height`, `x-display-mm-width`, `x-display-mm-height`, `x-display-planes`, `x-display-color-cells`, `x-display-screens` (one), `x-display-visual-class`, `x-display-grayscale-p` and `xw-display-color-p`.
- **frame.el's own wrappers**, in a `frame.ts` that ships with E8 as `frame.el` ships with Emacs, since that is what Lisp calls: `display-pixel-width`, `display-pixel-height`, `display-mm-width`, `display-mm-height`, `display-planes`, `display-color-cells`, `display-color-p`, `display-grayscale-p`, `display-screens` and `display-visual-class`, each asking the window system where there is one and the terminal where there is not, as frame.el splits them. They are exported, and given their Lisp names with `e8.defun` so code that has not imported them can call them.
- **The monitors**: `display-monitor-attributes-list`, each monitor's `name`, `geometry`, `workarea`, `mm-size`, `frames` and `source`, in frame.c's own order, with `frame-monitor-attributes` and its kin. A frame is on the monitor it has the most of itself in, and where it has none of itself in any, the nearest, so every frame is on exactly one, as frame.el promises.
- **A frame's place**: `frame-edges` with Emacs's three kinds — `native-edges`, which is the default, `outer-edges`, the window the system draws around it, and `inner-edges`, which leaves off the bars above the frame's windows — and `frame-outer-width` and `frame-outer-height`. A front end writes the outer size in, as it writes the native one.
- **Colours**: `xw-color-defined-p` and `xw-color-values`, which are `color-defined-p` and `color-values` by their back end's names.
- **AppleScript**: `ns-do-applescript` runs a script through `osascript`, which E8 already has `call-process` for, and signals on any other system, as Emacs has it only on macOS. What the script writes to standard error is thrown away, as Emacs's own call never sees it.
- **The connection**: `x-display-list` names the one display, `x-open-connection` and `x-close-connection` are refused, as E8 draws through one front end and has no second display to open ([ADR 0077](0077-frames-and-the-window-tree-as-emacs-has-them.md)).
- `x-display-backing-store` is `not-useful`, `x-display-save-under` nil and `x-server-version` E8's own version, as each back end answers for itself.

## Consequences

- pos-tip and ess lack nothing more from this group, and `display-pixel-width` and `display-monitor-attributes-list` — which packages use to place a tooltip or a child frame — answer truthfully.
- The answers are as good as what the front end wrote: the terminal's are its character grid, so a package that measures a tooltip in pixels gets characters, as it does in Emacs on a terminal.
- egui knows one monitor and nothing of the system's own bars, so a monitor's `workarea` is the whole of it: a frame placed from it can land under the menu bar. Recorded in [differences.md](../differences.md).
- `x-create-frame` is left out: `make-frame` makes a frame from the same parameters and is what Lisp calls.
- No window system reaches `e8-core`.

## Dependencies introduced

None.
