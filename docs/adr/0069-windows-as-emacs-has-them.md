# 0069. Windows as Emacs has them: window.c's tree, window.el's policy

Status: proposed · 2026-11-11

## Context

[ADR 0009](0009-windows.md) gave E8 windows as a binary tree of splits that the core keeps and front ends lay out, sizes in lines and columns, a resize that moves one split line, and `display-buffer` as window.el's default actions written into `window.ts`. [ADR 0028](0028-windows-as-objects.md) gave a window what Emacs's window object holds, under an id rather than as a value. [ADR 0017](0017-frames.md) gave frames, one size for all, one minibuffer, and egui viewports. Window and frame accessors followed with the parity work (e8-editor/e8 pull request 96).

That design has served the editor's own commands, but not the Lisp E8 follows. Emacs does windows in two layers: window.c keeps a tree of live and internal windows, each an object, with combinations of any number of children, normal sizes, a combination limit, and a resize protocol (`window-new-total`, `window-new-normal`, `window-new-pixel`, `window-resize-apply`) that does nothing on its own; window.el, 11,000 lines of Lisp, holds all the policy on top of it: resizing and its preserved sizes, `fit-window-to-buffer`, balancing, side windows and atomic windows, `display-buffer` with `display-buffer-alist` and its action functions, `quit-restore`, and window states. E8 has neither layer's shape. Its internal nodes are anonymous splits, its minimum sizes are constants, and its policy is E8's own, written fresh where window.el's existed.

What that costs, as measured for [docs/parity/demand.md](../parity/demand.md) and in the ports:

- **Ports work around it.** e8-popper dropped `popper-window-height` and `popper-display-function`, as there is no `display-buffer-alist` and no side windows. e8-magit writes Magit's display functions out by hand and walks `windowTree()` summing widths to stand in for window edges. e8-vundo and e8-org-roam split the root window to stand in for a side window. transient deletes its window and splits again to resize it. Ediff's panel cannot be smaller than four lines.
- **Packages expect window.el.** Of MELPA's 295 most downloaded packages read, 148 call a function window.el or frame.el defines; `display-buffer-alist` appears in 16, `display-buffer-in-side-window` in 14, `display-buffer-reuse-window` in 14, `fit-window-to-buffer` in 19, `window-resize` in 10. After the accessors, the window tree is still the group of missing primitives most needed (window-parent and siblings, edges, the resize protocol), wanted above all by window.el itself.
- **Behaviour differs where it shows.** Resizing moves one line where Emacs shares the change among a combination by its normal sizes; balancing, `shrink-window-if-larger-than-buffer` and `quit-window`'s restored height are E8's own approximations; none of it can be checked against Emacs by the oracle beyond the simplest cases.

Some of ADR 0009's and 0017's reasons still hold and are not in question: front ends measure in different units, so the core should give them rectangles, not pixels; one minibuffer suits both front ends; window ids never reused do what Emacs's window objects do for live windows.

## Options considered

1. **Keep the design; add what packages ask for on top of it.** `display-buffer-alist` and side windows written for E8's tree in `window.ts`, `fit-window-to-buffer` its own way. The smallest change, about a week and a half. But each later window.el feature is written again rather than ported, resizing keeps behaving unlike Emacs's, and what E8 writes cannot be checked against window.el's code, only against its behaviour where the oracle reaches.
2. **Emacs's two layers: window.c's tree in Rust, window.el's policy in TypeScript.** The core's tree becomes Emacs's: combinations of any number of windows, internal windows with ids of their own, normal sizes, `window-min-height` and `window-min-width` as variables, the combination limit, and window.c's resize protocol. window.el's policy is ported to `window.ts` on top of it, function by function, as [ADR 0005](0005-rust-core-typescript-commands.md) has Emacs's Lisp ported to TypeScript. Sizes stay in lines and columns and front ends still get rectangles. About four to five weeks in three stages, each of which lands on its own.
3. **Windows as values too.** Option 2 with `Value::Window` and `Value::Frame`, so `windowp`, `framep` and dead windows' objects behave as Emacs's. Changes how values cross into scripts and every package that holds a window; buys little, since ids are never reused and `window-live-p` already works on them.
4. **Pixelwise windows.** Option 2 with sizes in the front end's pixels in the core, as Emacs's `window-pixel-*` and `window-resize-pixelwise`. The terminal has no pixels and the GUI's mode lines are not a line tall, ADR 0009's reason for cells; scripts already get pixel sizes from cells and the default font.

## Decision

Option 2, in three stages, each a pull request series of its own, with oracle cases (`"windows": true`) recorded from Emacs for what each stage ports:

1. **`display-buffer` as window.el has it.** `display-buffer-alist`, `display-buffer-base-action`, `display-buffer-overriding-action`, `display-buffer-fallback-action` and the action functions (`display-buffer-same-window`, `-reuse-window`, `-reuse-mode-window`, `-pop-up-window`, `-use-some-window`, `-use-least-recent-window`, `-below-selected`, `-at-bottom`, `-in-direction`, `-in-previous-window`, `-in-side-window`, `-no-window`, `-pop-up-frame`), with their alist entries (`window-height`, `window-width`, `side`, `slot`, `dedicated`, `inhibit-same-window`, `reusable-frames`, `window-parameters`, `preserve-size`), ported from window.el into `window.ts` on today's tree. Side windows are window parameters (`window-side`, `window-slot`) and a root split, as window.el makes them. Written in window.el's shape, so stage 2 changes what they call, not what they are. About a week.
2. **window.c's tree in the core.** `WindowTree` becomes a tree of combinations of any number of children; an internal window has an id, from the same counter as live windows, and the parameters, normal size and combination limit Emacs gives it. `window-parent`, `window-top-child`, `window-left-child`, `window-next-sibling`, `window-prev-sibling`, `window-normal-size`, `window-combination-limit`, `window-new-total`, `window-new-normal`, `window-resize-apply`, `split-window-internal` and `delete-window-internal` become primitives under Emacs's names. `window-min-height` and `window-min-width` become variables the core reads. `rects` keeps its contract with front ends: a rectangle per live window, in their units. E8's own `resize` and `balance` stay working until stage 3 replaces them. One to two weeks.
3. **window.el's policy on the tree.** `window-resize`, `window--resize-child-windows` and the rest of window.el's resizing, `window-preserve-size`, `enlarge-window` and `shrink-window`, `balance-windows`, `fit-window-to-buffer` and `shrink-window-if-larger-than-buffer`, `split-window` with its sizes, `delete-window` with atomic and side windows, `window-state-get` and `window-state-put` in Emacs's shape, and `quit-restore-window`'s restored sizes, ported from window.el into `window.ts`, replacing E8's own. One to two weeks.

What stays: window and frame ids as numbers (option 3 is left for when frames as values come up for some other reason); sizes in lines and columns (option 4 is not taken); one minibuffer for all frames, its window outside the tree; front ends laying the frame out from rectangles the core gives; frames as egui viewports.

## Consequences

- Ports use window.el's API as packages wrote it: popper's display function and height, Magit's display functions, vundo's and org-roam's side windows, transient's resize, a one-line Ediff panel. Their READMEs' differences can go.
- window.el's behaviour becomes checkable: each ported function comes with oracle cases, and a difference from Emacs is a bug rather than a design.
- `window.ts` grows by several thousand lines, following window.el's; the core's window module is rewritten around combinations, which touches splitting, deleting, configurations, `windowTree()`'s shape and the frame description. Stage 2 is the risky one: configurations, tab-bar's saved window configurations, the GUI's drag-to-resize and the oracle's window cases must all keep passing.
- `windowTree()`'s nested `[sideBySide, firstSize, first, second]` shape changes to combinations; packages that read it (e8-magit's fullcolumn) move to `window-left-child` and its kin, as Magit itself does.
- Watch for: window.el's code assuming pixelwise sizes where E8 has cells (`window-resize-pixelwise`, `frame-resize-pixelwise`), and its frame and minibuffer-window handling, where E8 has one minibuffer. If either needs more than a branch on `window-resize-pixelwise` being nil, revisit option 4 for that part.
- ADR 0009's decisions on the tree, resizing and display-buffer, and ADR 0028's note that internal windows have no ids, are superseded by this one once stage 2 lands; their other decisions stand.

## Dependencies introduced

None.
