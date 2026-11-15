# 0102. The printer and the runtime's odds

Status: accepted · 2026-11-15

## Context

After [ADR 0101](0101-variables-and-symbols-as-emacs-has-them.md), the primitives E8 lacked were the Lisp language's own (data.c, fns.c, eval.c and the rest), for which TypeScript stands in, and CCL. A few of the language's are about the editor rather than the language, and ported Lisp calls them:

- **print.c's output**, to a buffer, a marker or a function: `prin1`, `print`, `terpri` with `ensure`, `write-char`, `external-debugging-output` and `flush-standard-output`. Packages print data into buffers this way, as `pp` and `savehist` do.
- **The top level of a let-bound variable:** `default-toplevel-value` and `set-default-toplevel-value`, which packages that set options from inside a `let` use. `variable-binding-locus`.
- **Strings, as Emacs keeps them:** `string-bytes`, `multibyte-string-p`, `string-to-unibyte` and `string-make-unibyte`.
- **The rest:**
  - `string-version-lessp`, for sorting file names;
  - `random`, with a string seed;
  - Emacs 30's `value<`, which `sort` uses by default;
  - `text-quoting-style` and `documentation-stringp`.

## Decision

Each is written as its C does it (`natives/cprint.rs`).

- **Where output goes**, as print.c's PRINTCHARFUN:
  - a buffer, at its point;
  - a marker, inserting there and moving the marker past it;
  - a function, called with each character;
  - `external-debugging-output`, for standard error;
  - nil or t, for `standard-output`'s value: the echo area, or standard output in batch, as Emacs's are.
- **`terpri` with `ensure`** writes a newline only where a buffer's point is not at the start of a line, and says whether it did.
- **Top-level values.** `default-toplevel-value` reads the value the outermost `let` binding of the variable saved on the binding stack, else its default. `set-default-toplevel-value` sets that saved value, so the variable has it once the `let` ends.
- **Strings.**
  - `string-bytes` counts UTF-8, a raw byte as one.
  - `multibyte-string-p` is true for a string with a character past ASCII that is not a raw byte.
- **`random`** is a xorshift generator: seeded from the time, again with t, and the same numbers each time from the same string seed.
- **`value<`** orders numbers, strings and symbols, lists element by element, buffers by name and markers by place, signalling `type-mismatch` for others, as Emacs 30's does. Its camelCase name is `valueLess`, with a defun of `value<` in subr.ts.

## Consequences

- **What it unblocks.** Ported Lisp that prints into buffers and markers, reads top-level values from inside a `let`, or sorts versions or values works.
- **Recorded in [differences.md](../differences.md):**
  - a character from U+0080 to U+00FF counts as multibyte, as E8's strings do not say they are unibyte;
  - `random`'s numbers are not Emacs's for the same seed.
- **Not done:**
  - CCL, which would need ccl.el's compiler and a bytecode interpreter, and is called by nothing in the corpus;
  - `fontset-info`;
  - the Lisp language's own primitives, which TypeScript stands in for.
