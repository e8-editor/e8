# 0077. Frames and the window tree as Emacs has them: geometry, terminals, and what window.c has left

Status: accepted · 2026-11-13

## Context

Measured again on 2026-11-13, after menus ([docs/parity/demand.md](../parity/demand.md)), the two groups left at the top of the ranking are frames (0.34) and the rest of window.c's tree (0.30). Together they are all that thirteen of MELPA's packages lack — ace-window, posframe, pdf-tools, persp-mode, doom-themes, visual-fill-column, writeroom-mode, winum, forge, with-editor, window-purpose, cfrs and spacemacs-theme — as well as five of the daily ones and five of Emacs's own libraries: dired, edebug, erc, server and which-key.

What is missing falls into three pieces.

- **A frame's geometry.** E8's frames have a size the front end gives them and nothing else. Emacs's have a native size (the whole window), a text size (what the windows divide), a position on the screen, and the widths of the border, fringes, scroll bars and dividers around them; `frame-text-width`, `frame-native-width`, `frame-position`, `set-frame-position`, `set-frame-width` and their kin read and set those. Nothing can ask how big a frame is in pixels, move one, or resize one from code. There are no plural accessors either: `frame-parameters` and `modify-frame-parameters`, which almost every package uses, are missing although the parameters themselves are there.
- **Focus and order.** `redirect-frame-focus` and `frame-focus` send one frame's keys to another, which is how a frame without a minibuffer borrows one; `lower-frame`, `frame-ancestor-p`, `handle-switch-frame` and `frame-after-make-frame` are the rest of frame.c's ordering. E8 has `raise-frame` and nothing else.
- **Terminals as objects.** `terminal-live-p`, `frame-terminal`, `terminal-name`, `terminal-parameter` and `set-terminal-parameter` are how a package asks what kind of display it is on and hangs state off it; evil, server, with-editor, font-lock, help and `mouse.el` all do. E8 has no terminal at all: `framep` answers from a compile-time `cfg!`.
- **The window tree's rest.** `window-pixel-left` and `window-pixel-top` place a window on the frame, which posframe and `mouse.el` need; `set-window-fringes` is what visual-fill-column, writeroom-mode, persp-mode, doom-themes, erc and flycheck use to give a window margins of air; `window-scroll-bars` and its kin are asked about by code that lays windows out; `window-configuration-frame` is wanted by magit, forge and with-editor.

## Options considered

1. **Make frames real objects first**, moving every frame's parameters, raises, title and bars onto `Frame`, and the selected frame's with them, before adding anything. It is the tidier base, but it touches every frame function for no behaviour, and ADR 0069 chose the swap-the-selected-frame shape deliberately.
2. **Add what is missing in the shape E8 already has**: another map on the editor for what each frame knows, as `frame_raises` and `frame_titles` are kept, and a terminal object beside them. The geometry the front ends know is reported into a cell the editor reads, as the pointer's place is (ADR 0074).
3. **Answer the geometry from the front end on demand**, asking it while code runs. It would break the rule that the editor runs on a thread of its own and front ends only draw.

## Decision

Option 2, in three pull requests, each behind `make check` on both engines, a review against frame.c, window.c and terminal.c, and the ported packages' tests.

1. **A frame's geometry, focus and order.**
   - Sizes in three ways, as frame.c has them: the **text** size the windows divide, the **native** size of the whole frame, and the size in characters (`frame-total-cols`, `frame-total-lines`). A terminal's native size is its characters, as Emacs's is.
   - The widths around them: `frame-internal-border-width`, `frame-fringe-width`, `frame-scroll-bar-width` and `-height`, `frame-right-divider-width` and `-bottom-`, `frame-child-frame-border-width`, from what the front end's metrics say, 0 where E8 draws none.
   - `frame-position` and `set-frame-position`, `set-frame-width`, `set-frame-height` and `set-frame-size`: the front end is asked, as it is asked to raise a frame, and carries it out when it can. A terminal cannot move or resize itself, and says so.
   - `frame-parameters` and `modify-frame-parameters`, over the parameters E8 keeps, with the ones it works out itself among them (`width`, `height`, `left`, `top`, `name`, `visibility`, `menu-bar-lines`, `tab-bar-lines`).
   - `redirect-frame-focus` and `frame-focus`, kept as Emacs keeps them: selecting a frame moves to it every redirection that pointed at the frame that was selected, as `do_switch_frame` moves them, so a frame borrowing a minibuffer borrows the one in front. `lower-frame`, `old-selected-frame`, `frame-window-state-change` and `frame-ancestor-p`, which is nil while E8 has no child frames.
   - Not `handle-switch-frame`, which handles an event E8 does not make, nor `frame-after-make-frame`, which turns on a hook E8 does not have (`window-configuration-change-hook`); both wait for those.
   - `x-parse-geometry`, and `x-get-resource`, which is nil: E8 reads no X resource database.
2. **Terminals as objects.** One terminal, since one front end draws for one editor and a daemon is not E8's ([ADR 0073](0073-the-user-and-the-system-as-emacs-has-them.md)): `terminal-list` gives it, `frame-terminal` names it for any frame, and `terminal-live-p` says what kind it is, as `framep` does. `terminal-name` is the tty's device or the display's name; `terminal-parameters`, `terminal-parameter` and `set-terminal-parameter` keep what packages hang off it. `delete-terminal` of the only one is refused, as Emacs refuses to delete the initial terminal's frames one by one. `tty-type`, `tty-display-color-p`, `tty-display-color-cells`, `controlling-tty-p`, `make-terminal-frame`, `suspend-tty` and `resume-tty` answer for it.
3. **The window tree's rest.** `window-pixel-left` and `window-pixel-top`, `window-left-column` and `window-top-line`, `window-tab-line-height`, and what a window was before the last redisplay (`window-old-buffer`, `window-old-point`, `window-old-pixel-width` and the rest, `old-selected-window`, `frame-old-selected-window`). `set-window-fringes` and `window-fringes` per window, which the layout obeys, so a window can be given air at its sides. `set-window-scroll-bars` and `window-scroll-bars` remember what they are told and report none, as a terminal's do, E8 drawing no scroll bars. `window-configuration-frame` and `window-configuration-equal-p`. `resize-mini-window-internal` and `run-window-configuration-change-hook`.

Display tables are left out deliberately: E8 honours only a table's selective-display slot ([docs/differences.md](../differences.md)), and `window-display-table` would store a table that changes nothing. It is named here so the group's last three primitives are not mistaken for an oversight.

## Consequences

- Thirteen MELPA packages, five daily ones and five of Emacs's own libraries lack nothing from these groups once all three land.
- Code can move and resize a frame, which the GUI carries out and a terminal refuses, as Emacs's does.
- A terminal object makes `framep`'s answer a thing rather than a compile-time constant, and gives packages somewhere to hang state.
- A window can have fringes of its own, which the GUI's layout must obey, so a window's text area no longer follows from the frame alone.
- `Frame` stays thin, and what a frame knows stays in maps beside it. Should a fourth of these arrive, moving them onto `Frame` is the tidy-up to do first.

## Dependencies introduced

None.
