# 0082. Keymaps' rest as Emacs has them: prompts, map-keymap-internal, and describe-buffer-bindings

Status: accepted · 2026-11-14

## Context

After charsets, the keyboard, XML and the display ([ADR 0078](0078-charsets-and-codings-as-emacs-has-them.md) to [0081](0081-the-display-as-emacs-asks-about-it.md)), what is left of keymap.c leads the parity ranking with the minibuffer's odds ([docs/parity/demand.md](../parity/demand.md)), both at 0.17. Keymaps as values landed earlier (pull requests 87 to 91); four primitives were left out then, on the grounds that E8's keymaps carried no prompt and that `keymapBindings` stood in for walking one. They are now what flycheck, transient, counsel and helm-descbinds lack, each alone:

- **`keymap-prompt`** — flycheck, and Emacs's own subr through `keymap-canonicalize`. A keymap made with `(make-sparse-keymap "Prompt")` carries a prompt string, shown when a key is read in it.
- **`map-keymap-internal`** — transient, and Emacs's compile. It walks a keymap's own bindings, leaving its parent alone and handing it back, which is how transient builds its menus from keymaps.
- **`describe-buffer-bindings`** — counsel and helm-descbinds. It inserts the listing `C-h b` shows, which both packages then parse line by line, so its text has to be Emacs's: the sections in Emacs's order, each after a page break, the key column padded with tabs to 16, 24 or 32.
- **`keymap--get-keyelt`**, which help.el's `describe-map` calls on each binding.

E8's `C-h b` laid its listing out its own way, with `---` under `Binding` and spaces rather than tabs.

## Options considered

1. **`describe-buffer-bindings` in Rust**, as Emacs has it in C. Emacs's own C hands each section to help.el's `help--describe-map-tree` and `describe-map`, which are Lisp; only the order of the sections and their titles are C.
2. **All of it in TypeScript, in `help.ts`**, beside E8's `describe-bindings`: Emacs's section order from keymap.c, and help.el's `describe-map` and its alignment ported line for line, over keymap functions the script API already has.

## Decision

Option 2, as CLAUDE.md puts what Emacs writes in Lisp in TypeScript and nearly all of this is help.el. The work lands in one pull request, behind `make check` on both engines, a review against keymap.c and help.el, and the ported packages' tests.

- **A keymap's prompt**: `makeSparseKeymap(parent, prompt)` gives a keymap one, copying a keymap keeps it, and `keymap-prompt` gives a keymap's own or the first its parents have, and nil for anything that is no keymap, as Emacs's does.
- **`map-keymap-internal`** calls a function with each key a keymap itself binds and its binding — a prefix's being its keymap, and `t` for what the keymap runs for any other key — and hands back the parent, which it does not visit.
- **`keymap--get-keyelt`** gives what a binding stands for. E8's lookups already look through the menu items keymaps hold, so it has only a menu item written out as `["menu-item", label, definition]` to look through.
- **`describe-buffer-bindings`** inserts Emacs's listing for a buffer, optionally only the keys under a prefix: key translations, a keymap at point, each minor mode's map that is on, the major mode's or a `local-map` at point, the global map, and the input decoding map. Each section after the key translations starts with a page break. A key an earlier section binds is left out of the later ones, under a prefix too, and a command an earlier section binds to a prefix hides every later key under it. Menu bar bindings are left out. Under `<remap>`, a line gives the key that runs the command remapped to and the remapping after it. E8 keeps meta characters as `M-` keys, not in an ESC map, so the prefix `ESC` lists them. A run of characters bound alike, control and meta characters too, reads as one line (`C-c 1 .. C-c 4`). `undefined` and prefix keys are left out. Function keys sort by name in version order (`<f5>` before `<f12>`). Each block's key column is padded with tabs to 16, 24 or 32, as `describe-map--align-section` pads it. Meta characters are listed as a block of their own, as Emacs's ESC map lists. On the same keymap, its text is Emacs's byte for byte.
- **`C-h b` and `C-x C-h`** go through it, as Emacs's `describe-bindings` and `describe-prefix-bindings` do, so they look as Emacs's do.

## Consequences

- flycheck, transient, counsel and helm-descbinds lack nothing more from keymap.c.
- `C-h b` reads as Emacs's, and what parses Emacs's listing parses E8's.
- `describe-vector` and `help--describe-vector`, which describe a char-table for `describe-syntax` and `describe-categories`, are left out: one of Emacs's own libraries calls each and no package does.
- E8 keeps a keymap's keys in order where Emacs keeps the newest first, so `map-keymap-internal` visits them, and `C-h b` lists the blocks under one prefix, in E8's order. E8 shows no keyboard menu built from a keymap's prompt; the prompt is kept and given back. E8 has no Unicode character names, so the key translations section gives each character without one. E8 has no `local-function-key-map`, so there is no section for it, and no "Overriding Bindings" section. Recorded in [differences.md](../differences.md).

## Dependencies introduced

None.
