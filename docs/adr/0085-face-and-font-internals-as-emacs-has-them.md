# 0085. Face and font internals as Emacs has them: Lisp faces, font objects and fontsets

Status: accepted · 2026-11-14

## Context

With tree-sitter done ([ADR 0084](0084-tree-sitters-rest-as-emacs-has-it.md)), face and font internals lead the parity ranking at 0.11 ([docs/parity/demand.md](../parity/demand.md)). [ADR 0044](0044-faces-as-emacs-s.md) gave faces Emacs's attributes, and [ADR 0048](0048-overlay-arrows-fringe-indicators-and-fonts.md) gave fonts as values. faces.el, though, is written on xfaces.c's lower layer, which E8 did not have under Emacs's names. Thirty-one primitives of xfaces.c, font.c and fontset.c were missing:

- **Lisp faces**: a face's attributes as Emacs's face vector.
  - `internal-make-lisp-face`, `internal-lisp-face-p` and `internal-copy-lisp-face`;
  - `internal-set-lisp-face-attribute` and `internal-get-lisp-face-attribute`;
  - `internal-lisp-face-equal-p`, `internal-lisp-face-empty-p` and `internal-merge-in-global-face`;
  - `face-attributes-as-vector` and `frame--face-hash-table`.
- **X resources**: `internal-face-x-get-resource` and `internal-set-lisp-face-attribute-from-resource`.
- **Font selection**: `internal-set-font-selection-order`, `internal-set-alternative-font-family-alist` and `internal-set-alternative-font-registry-alist`.
- **Font objects**: `internal-char-font`, which nerd-icons alone waits on, and `font-face-attributes`, `open-font`, `close-font`, `font-get-glyphs`, `font-match-p`, `font-variation-glyphs`, `font-shape-gstring`, `frame-font-cache` and `clear-font-cache`.
- **Fontsets**: `fontset-list`, `query-fontset`, `new-fontset`, `set-fontset-font` and `fontset-font`. nerd-icons and many configs set a fontset's font for icon or emoji ranges.
- **The odds**: `bitmap-spec-p`, `clear-face-cache`, `x-family-fonts`, `x-load-color-file` and `tty-suppress-bold-inverse-default-colors`.

## Options considered

1. **Keep a face as Emacs's vector of Lisp values** beside E8's typed attributes. It would be closest to xfaces.c, but there would be two copies of every face to keep in step, and redisplay reads the typed one.
2. **Give the vector from E8's typed attributes** (`FaceAttrs`), checking each value as xfaces.c does before it is set. There is one copy of each face, and the vector is worked out when asked for.

## Decision

Option 2, in Rust, as these are C in Emacs ([ADR 0005](0005-rust-core-typescript-commands.md)).

- **Lisp faces** (`xfaces.rs`):
  - **The vector.** A face's vector is `[face FAMILY FOUNDRY WIDTH HEIGHT WEIGHT SLANT UNDERLINE INVERSE FOREGROUND BACKGROUND STIPPLE OVERLINE STRIKE-THROUGH BOX FONT INHERIT FONTSET DISTANT-FOREGROUND EXTEND]`, in xfaces.c's order. Names are symbols, plists have keyword keys, flags are t or nil, and an attribute that is not set is `unspecified`. `FaceAttrs` gains `:fontset`, and `FACE_ATTRIBUTES` is now in this order.
  - **Checking.** `internal-set-lisp-face-attribute` checks each value as xfaces.c does, with its messages:
    - `Face height does not produce a positive integer` for a height;
    - `Invalid face weight` for a weight;
    - `Invalid face box` for a box;
    - `wrong-type-argument stringp` for a symbol given as a colour;
    - and so on for the rest.

    A box of t becomes 1, and a colour of nil becomes `unspecified`.
  - **Making a face.** `internal-make-lisp-face` empties a face that exists, as Emacs's does.
  - **Merging into a vector.** `face-attributes-as-vector` merges a face reference as `merge_face_ref` does. Its `:inherit` is nil once a named face has been merged.
- **Frames.** E8's faces are the same on every frame, so a face's global definition and its definition on a frame are one.
  - A FRAME argument is checked as Emacs checks it: nil, t, 0 or a live frame, and t only where Emacs takes it.
  - Every frame then gives the same answer.
  - `internal-merge-in-global-face` only checks that the face exists.
  - `frame--face-hash-table` is a `Map` from each face to its vector. It is a copy, made when asked for. faces.ts defines it under its Lisp name, as `frameFaceHashTable` is its script name.
- **X resources.** E8 reads none, so `internal-face-x-get-resource` gives undefined. A resource's string is still parsed as xfaces.c parses it: heights as numbers, "on" and "off" as flags, and boxes and inheritance read as Lisp.
- **Font selection.** The order and the alternatives are checked as Emacs checks them, and kept (`FaceSettings`). `x-family-fonts` sorts by the order.
- **Font objects** (`font.rs`):
  - `font-face-attributes` and `font-match-p` follow font.c. `font-match-p` compares foundry, family, adstyle and registry case-sensitively, compares the styles and size where both fonts have them, and does not compare spacing.
  - `internal-char-font`, `open-font` and `font-get-glyphs` open fonts through the front end's `TextMetrics`, as `font-at` does. They give nil on a terminal, as terminal Emacs does when the terminal reports no glyph codes.
- **Fontsets** (`fontset.rs`). Each fontset is a named list of entries, by range, script, charset or nil for the rest. Each entry holds Emacs's font patterns, `(FAMILY . REGISTRY)`, newest first.
  - `set-fontset-font` takes Emacs's targets, fonts and ADD, with its errors.
  - `fontset-font` gives the patterns for a character.
  - `new-fontset` requires an XLFD name.
  - `query-fontset` matches names, the short `fontset-NAME` form, wildcards and regexps.
- **Conses as arrays.** JavaScript has no cons, so a pair is a two-element array:
  - `(FONT . CODE)` from `internal-char-font`;
  - `(NAME . RGB)` from `x-load-color-file`;
  - `(FAMILY . REGISTRY)`;
  - `(FROM . TO)`.

## Consequences

- **Emacs's names.** faces.el's lower layer is in `e8` under Emacs's names, and every primitive of xfaces.c and font.c in the corpus is there. Ports can follow faces.el's code.
- **Fontsets are kept, not drawn.** A config's `set-fontset-font` for icon or emoji ranges is stored and answered by `fontset-font`. The GUI still falls back on its own fonts.
- **Recorded in [differences.md](../differences.md):**
  - one face definition for every frame;
  - `reset` and `:ignore-defface` taken as `unspecified`;
  - glyph codes that are the character's own;
  - fontsets that do not change what is drawn;
  - `query-fontset` answering on a terminal, where Emacs says no window system is in use.
- **Not done:**
  - `fontset-info`;
  - stipples given as bitmap lists, which are checked but not kept;
  - shaping (`font-shape-gstring` gives nil, as for a font that cannot shape) and variation glyphs.

## Dependencies introduced

None.
