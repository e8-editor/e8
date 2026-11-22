# Departures from Emacs and Org

E8 behaves like Emacs and Org, and the oracle checks it. This document collects places where it could, later, do better than they do: ideas held back until the base editor is stable, so that each departure is a choice made against a known baseline rather than a drift. Each entry says what Emacs or Org does, what E8 might do instead, and whether it would be the default or something a user turns on.

Two rules for when one is taken up. A departure leaves files as Emacs and Org would write them, unless that is the point of it, so a file edited in E8 still reads the same in Emacs. And it is off by default unless the Emacs behaviour is plainly a limitation nobody relies on; otherwise it is a mode or an option, as a package would add it in Emacs.

## Org's tags against the window's right edge

**Org.** Tags are lined up by spaces written into the heading, so they end at `org-tags-column` (-77: right-aligned to column 77). The column is fixed while windows are not: in a wide window tags sit in the middle, in a narrow one they push the line past the edge, and they move only when a command re-aligns them (`C-c C-q`, `org-align-tags`), not when the window is resized. With a proportional font they do not line up at all.

**Idea.** Align tags on screen only: a display property on the spaces before a heading's tags, `(space :align-to (- right WIDTH))`, stretches them so the tags end at the window's right edge, whatever its width and whatever the font, as long as the heading leaves room; the file keeps Org's spacing. Emacs's display engine supports such specs, and packages do this for Emacs, so it is a mode in Org's spirit rather than a change to it, off by default.

**Needs.** `:align-to` with `right`, `center` and arithmetic on them, as Emacs's pixel specifications have them ([ADR 0029](adr/0029-redisplay-beyond-rows.md) supports a plain column so far), and a jit-lock function in a small mode, about fifteen lines of TypeScript.

## marginalia's documentation to the window's right edge

**marginalia.** An annotation's fields are cut to `marginalia-field-width`, 80 columns, or half the window's width if that is less, so in a wide frame a command's documentation stops well short of the edge with room to spare. Its column is the widest candidate seen so far in this minibuffer, rounded up to ten, so it moves right as longer names scroll into view and stays there. The maintainer keeps both, because the completion APIs give the annotator no better way to know how much room there is ([minad/marginalia#150](https://github.com/minad/marginalia/issues/150), [#169](https://github.com/minad/marginalia/issues/169), [#145](https://github.com/minad/marginalia/issues/145)).

**Idea.** E8's vertico knows the rows it shows, so it could cut each annotation's last field where the minibuffer's window ends instead, and line the annotations up by the candidates on screen, not every one seen. An option of E8's vertico and marginalia, off by default, since it changes what every completion looks like.

**Needs.** A way for vertico to tell the annotator the width left on each row, or to cut the annotation itself, as it already cuts candidates that run past the edge.

## Org's markers after a copy, and the agenda's after a move

**Org.** `org-markers-to-move`, the markers a cut subtree carries to where it is pasted, is reset only when a subtree is cut or pasted. A `C-y` of the cut subtree leaves it, and a copy without `force-store-markers` does not reset it, so the next `C-c C-x C-y`, of a different subtree, moves the running clock's or the clock history's markers into that text. And `org-agenda-save-markers-for-cut-and-paste` saves nothing, as it looks for the agenda's markers in the agenda buffer rather than the Org file they point into, so an agenda line goes to the wrong entry after `M-<down>` moves its own. E8 does both as Org does.

**Idea.** Reset the list whenever a subtree is copied or yanked, and save the agenda's markers from the files they point into, so they follow their entries as the clock's do.

**Needs.** Only the change in `org.ts` and a keeper in `org-agenda.ts` registered with `keepMarkersThroughMoves`.

## Org's clock after sorting entries

**Org.** `C-c ^` rewrites the whole sorted text, as `sort-subr` does, so every marker in it goes to its start: the parent heading's when sorting an entry's children. `org-sort-entries` puts back only `org-clock-marker`, the running clock's line. The last clocked task, the clock history, the default and interrupted tasks and the clock's heading marker all go to the parent, so `C-c C-x C-x` after a sort clocks in the parent, and `C-u C-c C-x C-i` offers it. E8 does the same.

**Idea.** Carry every kept marker through a sort, as `org-save-markers-in-region` carries them through a move: each record's markers moved with the record. Nobody relies on clocking into the parent, so the default.
