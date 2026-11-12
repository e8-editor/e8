# 0009. Windows

Status: accepted · 2026-10-27 · its decisions on the tree, its sizes, resizing and display-buffer superseded by [0069](0069-windows-as-emacs-has-them.md)

## Context

The third slice of milestone 3 in [the plan](../plan.md) is windows: `C-x 2`, `C-x 3`, `C-x o`, `C-x 0` and `C-x 1`. Until now the editor had one window, whose point and top line lived in the buffer. In Emacs each window has its own point and start, the selected window's point is the buffer's point, and other windows' points are markers that move with edits. E8 also has two front ends that measure in different units, cells and points.

## Options considered

1. **The core lays windows out in character cells.** Simple for the terminal, but the GUI's mode lines are taller than a text line and its text has padding, so cells do not map onto it.
2. **The core keeps a tree of splits and each front end lays it out.** The core decides which windows exist and how they divide the frame; a front end turns that into rectangles in its own units and tells the core how many lines and columns each window has.

## Decision

The core keeps a tree of splits; front ends lay it out.

- `WindowTree` is a binary tree: each split halves a window, side by side or one above the other, the first part keeping the extra unit of an odd size, as Emacs's `split-window` does. `WindowTree::rects` divides any rectangle among the windows, so both front ends share one rule. Deleting a window gives its space to its sibling.
- The selected window's point and top line stay in its buffer, so commands are unchanged. The other windows keep their top lines, and their points are kept in their buffers, moving with insertions and deletions as Emacs's window-point markers do. Selecting a window swaps these.
- Each window refers to its buffer by an id, so killing or renaming buffers does not confuse windows. Killing a buffer shows another one in every window that showed it.
- Front ends call `set_window_size` for each window; scrolling uses the selected window's height. A window too small to halve, by Emacs's `window-min-height` of 4 and `window-min-width` of 10, does not split, with Emacs's message.
- Deleting the selected window selects the most recently used one left, as Emacs's `delete-window-choose-selected` does by default.
- The primitives (split, delete, select, list) are Rust, as in Emacs's C. The commands are in `packages/window.ts`, after `window.el`, and `other-window` takes a prefix count.
- Only the selected window shows the region and a filled cursor; other windows show a hollow cursor and a plainer mode line, as in Emacs.

### Sizes and displaying buffers

Added later, on 2026-10-28:

- **Splits can have sizes of their own.** A split halves its window until a resize gives it a size of its own, the first part's total size in lines or columns. `WindowTree::rects` takes a cell size to lay that out in, so a terminal's cells and a window's points share the rule.
- **The core knows the frame's size.** Front ends call `set_frame_size` with the frame in columns and lines, mode lines included, and the core lays the windows out in it, so window sizes follow without a front end, as the oracle needs. A front end may then refine each window with `set_window_size`.
- **Resizing is a primitive, as Emacs's `window-resize`.** It moves the line between the window and its neighbour in the nearest split of that kind, as far as `window-min-height` and `window-min-width` allow. `balance-windows` shares each run of splits of one kind equally, and `split-window` takes a size from a prefix argument. Dragging a mode line or divider in the GUI moves that edge.
- **Displaying buffers follows window.el's default actions, in `window.ts`.** `display-buffer` reuses a window showing the buffer, else splits the only window or one tall or wide enough (`split-height-threshold`, `split-width-threshold`), else uses the least recently used window, preferring full-width ones. `pop-to-buffer`, the `C-x 4` commands and `scroll-other-window` build on it. Each window remembers, as Emacs's `quit-restore` parameter does, whether it was made for the buffer or showed another one before, which `quit-window` (`q` in `*Help*`) undoes. Help now shows in another window.
- **The oracle compares windows.** A case with `"windows": true` records each window's buffer, point and total size in Emacs's cyclic order, and the plain-editing fuzzer mixes window keys into a quarter of its cases.

## Consequences

Scripts and, later, the agent can split, select, resize and display buffers in windows through the same commands, and the oracle checks them against Emacs. Batch Emacs never redisplays, so commands that depend on what a window shows, such as `shrink-window-if-larger-than-buffer` and scrolling down another window, are tested headlessly instead.

## Dependencies introduced

None.
