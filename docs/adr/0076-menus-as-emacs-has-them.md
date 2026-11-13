# 0076. Menus as Emacs has them: menu keymaps, x-popup-menu, and a menu bar

Status: accepted · 2026-11-13 (done: pull requests 122, 123 and the next)

## Context

Measured again on 2026-11-13, after compression and TLS ([docs/parity/demand.md](../parity/demand.md)), menus are the most needed group of missing primitives (0.46), wanted by seventeen of Emacs's own libraries, nine MELPA packages and three daily ones. For five of them — yasnippet, treemacs, lsp-treemacs, slime and Emacs's own eglot — it is all they lack.

- `x-popup-menu` (0.33, the most needed missing primitive of all) pops a menu up where the mouse is and returns what was chosen. Dired, Org, `text-mode`, `font-lock`, help, `term`, the calendar, Customize and `mouse.el` call it; so do lsp-mode, treemacs, helm, slime, ESS and yasnippet, mostly as `(x-popup-menu EVENT MENU)` followed by `(lookup-key MENU (apply 'vector choice))`.
- `x-popup-dialog`, `message-box` and `message-or-box` ask a question in a box, and fall back to the echo area where there is none.
- `x-show-tip` and `x-hide-tip` are the tooltips `tooltip.el` and pos-tip show.
- `menu-or-popup-active-p` and `next-read-file-uses-dialog-p` tell code a menu or a file dialog is in the way.
- `x-select-font` opens the font chooser `mouse.el` offers.

E8 has none of this. A keymap binds keys to commands, to a prefix keymap, to a key sequence or to nothing; there is nowhere to put an item's label, and a key is one of a closed set of codes, so Emacs's `[menu-bar file open-file]`, whose events are plain symbols, cannot be written at all. Nothing is drawn over the windows: a front end draws the rows of each window, the mode line, the tab bar and the echo area, and that is the whole frame.

## Options considered

1. **Menus as a structure of their own**, beside keymaps: a list of items a new `e8.popupMenu` shows. Smaller, but it is not where Emacs keeps menus. A major mode could not add to the menu bar through its own keymap, a menu could not be looked up with `lookup-key`, and the packages above — which build a keymap with `easy-menu-create-menu` and look the answer up in it — would each need rewriting rather than porting.
2. **Native menus**: the GUI's own pop-up menus from egui, and nothing in the terminal. The two front ends would then behave differently, nothing could be tested headlessly by key sequences, and the terminal, which is where E8 is mostly used, would have no menus.
3. **Menu keymaps, drawn by the editor.** Keys gain symbol events, so a keymap can hold Emacs's menu bindings; `menu-item` entries are a binding like the others; the editor lays a menu out itself and puts it in the frame description as a panel of styled cells, which both front ends draw over the windows; the keys that walk a menu are read by the editor's own nested read, as a prompt is, and `x-popup-menu` returns the answer.

## Decision

Option 3, in three pull requests, each behind `make check` on both engines, a review against menu.c, keyboard.c, term.c and the menu Lisp, and the ported packages' tests.

1. **Menu keymaps and `x-popup-menu`.**
   - A key may be a symbol, written `<name>`, as Emacs's events are symbols: `<menu-bar> <file> <open-file>` is Emacs's `[menu-bar file open-file]`. Symbols are interned as they are read, so a key sequence of them can be written, looked up and described like any other.
   - A keymap binding may be a menu item, as Emacs's `(menu-item LABEL BINDING . PROPERTIES)`: a label, what it runs (a command, a submenu keymap, or nothing for a line that cannot be chosen), and the properties `:enable`, `:visible`, `:help`, `:keys`, `:key-sequence`, `:filter` and `:button`. Where Emacs holds a Lisp form, E8 holds a function or a plain value, as a variable's value may be a function.
   - Items are shown in the order they were bound, not Emacs's reverse of it ([docs/differences.md](../differences.md)).
   - `x-popup-menu` takes a keymap, a list of keymaps or Emacs's `(TITLE (PANE ITEM...))` list, and gives back the keys chosen or the item's value, as Emacs does; with no position it computes nothing and returns nothing.
   - The menu is laid out by the editor and drawn by both front ends from the frame description, in the `tty-menu-enabled-face`, `tty-menu-disabled-face` and `tty-menu-selected-face` faces, with `>` on a submenu, as term.c draws it.
   - It is walked by the keys Emacs's `tty-menu-navigation-map` binds — the arrows, `RET`, `C-g` and the mouse — and a click outside or a key that is not one of them closes it, which is a quit unless the mouse opened it, as menu.c's is.
   - `menu-or-popup-active-p` is true while one is open.
2. **The menu bar.** `menu-bar-mode`, the `[menu-bar]` bindings of the global map and of mode maps, `menu-bar.ts` with File, Edit, Options, Buffers, Tools and Help as Emacs's `menu-bar.el` has them, `easymenu.ts` so a mode defines its menu as Emacs's do, `menu-bar-open` on `F10`, and the bar drawn along the top of the frame, clickable in both front ends.
3. **Dialogs and tooltips.** `x-popup-dialog` and `message-box` as a menu in the middle of the frame, which is how menu.c emulates a dialog without one; `message-or-box`, `use-dialog-box-p` and `next-read-file-uses-dialog-p`; `x-show-tip` and `x-hide-tip` with `tooltip.ts`; `x-select-font` over the fonts `x-list-fonts` gives.

## Consequences

- yasnippet, treemacs, lsp-treemacs, slime and eglot lack nothing more once stage 1 lands, and the `[menu-bar]` definitions every larger package carries stop being dead weight.
- Keys gain a kind that cannot be typed, so code that walks key sequences must expect one; `<tab-bar>`, which is such an event already, keeps its own code for now.
- The editor draws menus itself, so a terminal has them, snapshots show them, and tests drive them by key sequence; it also means a menu looks like E8 rather than like the platform.
- A menu's `:enable` and `:visible` are functions rather than forms, which `easymenu.ts` writes for a port.
- A dialog and a tooltip are drawn the same way, so a terminal has both, as Emacs's terminals have dialogs but no tooltips. Nothing shows a tooltip by itself until E8 has `help-echo`.

## Dependencies introduced

None.
