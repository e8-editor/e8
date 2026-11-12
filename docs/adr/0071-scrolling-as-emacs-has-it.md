# 0071. Scrolling as Emacs has it: horizontal and pixel scrolling kept by the window, and screen lines

Status: accepted · 2026-11-12

## Context

E8 scrolls a window vertically as Emacs does: the core keeps where each window starts, `ensure_point_visible` scrolls the selected one at redisplay, and `C-v`, `M-v`, `C-l` and the wheel are Emacs's commands. Horizontally it does not. Each front end works out on every frame how far to shift the text: none if point's column fits, otherwise point's column less half the window's width. Nothing in the core knows about it, so:

- scripts cannot ask how far a window is scrolled (`window-hscroll`) or set it (`set-window-hscroll`), and `C-x <` and `C-x >` (`scroll-left`, `scroll-right`) do not exist;
- `hscroll-margin`, `hscroll-step` and `auto-hscroll-mode` mean nothing;
- the two front ends and the mouse each compute the same shift separately, and the core's `posn-at-point` and `posn-at-x-y` ignore it.

The GUI's smooth scrolling is similar. It keeps the part of a line it has scrolled past in the GUI, where Emacs keeps it in the window as `window-vscroll`.

Measured again on 2026-11-12 after windows and processes ([docs/parity/demand.md](../parity/demand.md)), this group is now the most needed. `set-window-hscroll` is the most needed missing primitive: `with-output-to-temp-buffer` calls it, which brings it to 22 of Emacs's own libraries. `window-hscroll` is second, `vertical-motion` eighth, and `line-number-display-width`, `set-window-vscroll`, `scroll-left` and `scroll-right` follow. The group is all that 19 of MELPA's 295 most downloaded packages lack, among them lv, golden-ratio, diff-hl, typescript-mode and vterm. What packages do with these:

- **Save and restore a window's horizontal scroll** around something that moves point, or reset it to 0 when showing a buffer, as `with-output-to-temp-buffer` does.
- **Count or move by screen lines**: `vertical-motion` to find where the Nth screen line starts, often with a column as `(COLS . LINES)`; `line-number-display-width` to leave room for line numbers; and `window-line-height` and `window-lines-pixel-dimensions` for overlays laid over rows.
- **Scroll by pixels**: `set-window-vscroll` and `window-vscroll`, as pixel-scroll and image modes do.

## Options considered

1. **Add the primitives over what the front ends do.** `window-hscroll` would return 0 and `set-window-hscroll` would set a value front ends add to their own. This is the smallest change, but auto-hscroll, `hscroll-margin` and the mouse would still be computed in two places, and a value set by a script would fight the front ends' own.
2. **The window keeps its horizontal and pixel scroll, as Emacs's does.** Redisplay scrolls it to keep point visible, as xdisp.c's `hscroll_window_tree` does. The frame description says how far each row is shifted, and front ends draw from that and compute nothing.

## Decision

Option 2, in three stages. Each stage is its own pull request, behind `make check`, a review against window.c, xdisp.c and indent.c, and the ported packages' tests:

1. **Horizontal scrolling.**
   - Each window keeps its `hscroll`, its `min-hscroll`, and whether automatic scrolling is suspended.
   - At redisplay, after the vertical scroll, each window is scrolled as `hscroll_window_tree` does. The step is `hscroll-step` (0 recentres point), the margin is `hscroll-margin`, and the buffer-local `auto-hscroll-mode` decides: nil does nothing, `current-line` scrolls only point's line.
   - A window scrolled sideways truncates its lines, as Emacs's does.
   - The frame description gives each row's shift. Both front ends draw from it, and the terminal shows `$` at the left of a row cut off there, as Emacs's terminal does.
   - `posn-at-point`, `posn-at-x-y` and the mouse count the shift.
   - New primitives: `window-hscroll` and `set-window-hscroll`. Setting the scroll suspends automatic scrolling until point moves, as in Emacs.
   - New commands: `scroll-left` and `scroll-right` on `C-x <` and `C-x >`, which set the minimum when called interactively.
   - Window configurations and `window-state-get` keep the scroll.
2. **Screen lines.**
   - Native primitives: `vertical-motion` (with a column, as `(COLS . LINES)`, and a window), `compute-motion` and `line-number-display-width`.
   - `window-line-height`, `window-lines-pixel-dimensions`, `force-window-update` and `run-window-scroll-functions`.
   - `other-window-for-scrolling` under its Emacs name.
3. **Pixel scrolling.**
   - The GUI's smooth-scroll offset moves into the window as its `vscroll`, with `window-vscroll` and `set-window-vscroll` reading and setting it in pixels or lines.
   - The vscroll is reset when the window's start moves, as Emacs's is. It is always 0 on a terminal, as in Emacs.

Disabled commands (novice.el) are left out: E8 has none, so `C-x <` scrolls at once, where Emacs asks first. This goes in [differences.md](../differences.md), as does `mouse-wheel-tilt-scroll`, which is off by default in Emacs.

## Consequences

- Front ends stop computing scroll themselves. A window's text shifts where the core says, so the terminal, the GUI, the mouse and `posn-at-point` agree, and a script that sets the scroll sees it drawn.
- Long truncated lines scroll as in Emacs: point is kept 5 columns from either edge, and the window recentres when point would leave it. E8 recentred only at the right edge, and returned to column 0 as soon as point's column fitted. Text that shows today at the right of a truncated window can therefore show further left or right after this change. The GUI snapshots show no truncated lines scrolled, so they should not change.
- `window.ts`'s own `verticalMotion` and the `hscroll` and `vscroll` that window states fix at 0 give way to the primitives.

## Dependencies introduced

None.
