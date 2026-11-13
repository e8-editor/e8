# 0074. Mouse events as Emacs has them: the pointer's place, track-mouse, and window parts

Status: accepted · 2026-11-13

## Context

E8 turns the front ends' presses, drags and releases into Emacs's mouse keys (`<down-mouse-1>`, `<drag-mouse-1>`, `<double-mouse-1>`), and a command reads where the event happened from `lastMouseEvent`. Code cannot ask where the pointer is, follow it as it moves, or ask which window or which part of one is at a place on the frame. Measured again on 2026-11-13, after the user and the system ([docs/parity/demand.md](../parity/demand.md)), this is the most needed group of missing primitives (0.51):

- `track-mouse` (through `internal--track-mouse`), in six of Emacs's libraries and four daily ones: dragging a mode line or divider, `mouse-drag-track`, Ediff, speedbar.
- `mouse-position` and `mouse-pixel-position`, in four to five Emacs libraries, nine or ten MELPA packages and two daily ones: popups, tooltips and menus put themselves where the pointer is.
- `set-mouse-position` and `set-mouse-pixel-position`, to move the pointer with what it points at, as `mouse-avoidance-mode` and window switchers do.
- `window-at` and `coordinates-in-window-p`, to find the window and the part of it at a place.
- `this-single-command-raw-keys` and `read-key-sequence-vector`, the keys before translation, and a key sequence as a vector.
- `frame-pointer-visible-p`, `display--update-for-mouse-movement`, and macOS's `ns-mouse-absolute-pixel-position` and `ns-set-mouse-absolute-pixel-position`, which frame.el's `mouse-absolute-pixel-position` calls.

They are all that gnuplot and highlight lack among MELPA's packages, and all that Ediff, project and speedbar lack among Emacs's own.

## Options considered

1. **Mouse events as Lisp values**, with positions inside them as Emacs's are (`(mouse-1 (WINDOW POS (X . Y) ...))`), replacing key descriptions. That changes every keymap, every command bound to a mouse key and every package that reads keys, for what `lastMouseEvent` already gives.
2. **The pointer's place as state the front end keeps current, and movement as one more key.**
   - The front end writes where the pointer is into a cell the editor reads when code asks, so moving the mouse costs the editor nothing until then.
   - While `track-mouse` is on, the front end also sends each move as `<mouse-movement>`, a key like any other, whose place `lastMouseEvent` gives.
   - Window parts are answered by the core from the windows' geometry, as window.c answers them.

## Decision

Option 2, as one pull request behind `make check`, a review against frame.c, window.c and keyboard.c, and the ported packages' tests. Events stay key descriptions ([docs/differences.md](../differences.md)).

- **Where the pointer is.**
  - `mouse-position`, `mouse-pixel-position` and `mouse-absolute-pixel-position`, from the front end's last report, with `mouse-position-function` having the last word.
  - Places count from the top left of the frame's windows, as `window-edges` counts, so `window-at` of `mouse-position` is the window under the pointer.
  - Until a front end has seen the pointer, the answer is the selected frame and no place, as Emacs's on a mouseless terminal.
- **Moving it.**
  - `set-mouse-position` puts it in the middle of a character cell, kept on the frame, as frame.c does. `set-mouse-pixel-position` and `set-mouse-absolute-pixel-position` put it where they say.
  - In a window the GUI moves the pointer. A terminal cannot, and selects the frame instead, as Emacs without GPM does.
- **Following it.**
  - `track-mouse` is a variable, which `e8.trackMouse(fn)` binds while `fn` runs, as the macro does.
  - While it is on, moves come as `<mouse-movement>` events. During a drag they replace E8's running `<drag-mouse-1>` events, which then comes once, at the release, as in Emacs.
  - The global map binds `<mouse-movement>` to `ignore-preserving-kill-region`, as Emacs's does; after a prefix key it is undefined.
  - Movement is kept out of keyboard macros and the lossage.
- **Window parts.** `window-at` and `coordinates-in-window-p`, as window.c's `coordinates_in_window`: text with its place relative to the window, mode line, header line, the border between windows, fringes and margins.
- **Keys.**
  - `this-single-command-raw-keys` gives the keys of the last sequence as typed, before `input-decode-map`, `key-translation-map` and Shift translation.
  - `read-key-sequence-vector` gives the keys one by one.
- **The rest.**
  - `frame-pointer-visible-p` is always true, as E8 never hides the pointer.
  - `display--update-for-mouse-movement` does nothing, as E8's front ends follow the pointer themselves.

## Consequences

- Popups, tooltips and menus can be placed at the pointer. Code that drags, as `mouse-drag-track` does, can read the moves.
- A terminal reports the pointer's place from its mouse reports, as Emacs with `xterm-mouse-mode` does, and sends moves to the editor only while `track-mouse` is on.
- E8's own dragging, of text, mode lines and dividers, is unchanged.

## Dependencies introduced

None.
