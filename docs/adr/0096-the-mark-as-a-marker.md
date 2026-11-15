# 0096. The mark as a marker

Status: accepted · 2026-11-15

## Context

editfns.c's `mark-marker` gives the current buffer's mark as a marker: the same marker each time, pointing where the mark is and nowhere while there is none. Lisp reads it (`(marker-position (mark-marker))`) and moves the mark through it (`(set-marker (mark-marker) pos)`), as simple.el's `set-mark` and `push-mark` do, and packages do too.

E8 keeps the mark as a position the buffer moves with its edits, as it moves its markers, not as a marker. So `mark-marker` was the one editfns.c primitive E8 lacked after [ADR 0093](0093-the-c-cores-last-odds.md).

## Decision

Each buffer has a marker id that stands for its mark (`Buffer::mark_marker`), taken from the counter every marker's id comes from, so no other marker has it.

- **Reading it** gives the mark: `marker-position` and `marker-buffer` answer where the mark is, or nothing while there is none. Its insertion type is nil, as the mark stays before text inserted at it.
- **Setting it** sets the mark, without activating it, as `set-marker` on Emacs's mark marker does. Setting it nowhere takes the mark away.
- **It is never deleted.** The collector's freeing of marker objects passes it by, and the prelude keeps its object, the same one each time, as it keeps markers the editor holds.

The mark stays a position, so nothing that reads or moves it changes.

## Consequences

- **What it unblocks.** Lisp that reads or moves the mark through `mark-marker` works.
- **Recorded in [differences.md](../differences.md):** it cannot be pointed into another buffer, where Emacs's would then leave the buffer without a mark.
