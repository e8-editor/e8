# 0092. Compositions as Emacs has them

Status: accepted · 2026-11-14

## Context

Emacs's composite.c shows a stretch of text as other characters through the `composition` text property. Its users are:

- `prettify-symbols-mode`, which shows `lambda` as `λ`, and the many modes and configs that fill `prettify-symbols-alist`;
- packages that call `compose-region` directly, such as ligature and symbol packages;
- Emacs's own Lisp, which asks `find-composition` where a composition is, as `C-f` and `C-x =` do.

E8 had none of composite.c's six primitives, nor composite.el's functions on them.

Automatic composition, where a font's shaping joins characters such as Indic scripts' clusters, is a separate question. It needs a shaper in each front end, and E8 shapes nothing yet.

## Options considered

1. **A display string.** `prettify-symbols-mode` could put a `display` property instead. But packages put `composition` themselves, and `find-composition` would still answer nil.
2. **composite.c's property and primitives**, with redisplay drawing a composition in place of its text.

## Decision

Option 2.

- **The property** (`e8-core/src/composite.rs`) is Emacs's `((LENGTH . COMPONENTS) . MODFUNC)`, with conses as E8's two-element lists:
  - `[[LENGTH, COMPONENTS], MODFUNC]`;
  - `[[LENGTH, COMPONENTS]]` without a function;
  - `[[LENGTH]]` without components.

  COMPONENTS is a character, a string, or characters and composition rules alternating. A rule `(GREF . NREF)` is encoded as `GREF * 12 + NREF`, as composite.c encodes it.
- **The primitives:**
  - `compose-region-internal` and `compose-string-internal`, which returns the string composed rather than changing it, as a script's strings cannot be changed;
  - `find-composition-internal`, with its detail of components, whether they are relative, the modification function and the width;
  - `composition-get-gstring`, one glyph per character, as E8 shapes nothing;
  - `clear-composition-cache`;
  - `composition-sort-rules`.
- **Telling compositions apart.** Equal compositions next to each other run together in E8's text properties, where Emacs tells them apart by identity. So the run is cut into the property's length from its start.
- **Drawing.** Redisplay (`rows.rs`) draws a valid composition in place of the text it covers, as a string from a `display` property is drawn. Relative components, which Emacs draws on top of each other, are drawn as their first character.
- **composite.ts** has composite.el's functions:
  - `compose-region` and `decompose-region`, which keep the buffer's modified flag;
  - `compose-string`, `decompose-string`, `compose-chars` and `find-composition`.
- **prog-mode.ts** has `prettify-symbols-mode` and `global-prettify-symbols-mode`:
  - jit-lock composes the symbols `prettify-symbols-alist` names, longest first, where `prettify-symbols-compose-predicate` allows;
  - the default predicate, as Emacs's, skips symbols inside a longer word or symbol, and in strings and comments.

## Consequences

- **What it unblocks.** Configs that set `prettify-symbols-alist` and turn the mode on work, and packages that compose text show it composed.
- **Recorded in [differences.md](../differences.md):**
  - automatic composition does nothing;
  - relative components are drawn as their first character;
  - `prettify-symbols-unprettify-at-point` is not looked at;
  - a composition's modification function is kept but not called.
