# 0116. E8 has no Lisp

Status: accepted · 2026-11-27

## Context

E8 works the way Emacs works, with TypeScript as its extension language ([ADR 0003](0003-typescript-on-quickjs.md)) and the Lisp Emacs ships ported to TypeScript packages ([ADR 0005](0005-rust-core-typescript-commands.md)). A few of Emacs's and Org's features take Lisp as data and evaluate it: Org capture's `%(sexp)` template escape, Lisp table formulas (`'(concat $1 $2)`), `elisp:` links, `#+BEGIN_SRC emacs-lisp` blocks, and file-local `eval:` entries. With the rest of Org ported, these are what is left of Org's gaps besides missing packages, and the question is whether to close them with a Lisp interpreter.

## Options considered

1. **A Lisp interpreter**, for the Lisp these features hold. It would close the gaps, but it is a language of its own beside TypeScript: a reader, an evaluator, and the functions the Lisp calls, each of which E8 has only in TypeScript. Users would meet Lisp again in their configurations and Org files, which E8 is for people who would rather not.
2. **No Lisp**: the features that evaluate Lisp are left out, as differences from Emacs that E8 keeps.

## Decision

Option 2. E8 has no Lisp, and will not: no interpreter, no evaluator for a subset. It is Emacs for people who love Emacs but would rather not write Lisp.

## Consequences

- `%(sexp)` in a capture template, Lisp table formulas, `elisp:` links and Emacs Lisp source blocks stay unsupported, listed in [differences.md](../differences.md) as deliberate. A Lisp table formula gives `#ERROR`, as [ADR 0115](0115-table-formulas-on-a-part-of-calc.md) has it, which no longer foresees an evaluator for formulas.
- File-local `eval:` entries keep the few forms E8 reads without evaluating Lisp (`setq`, `add-hook`, a call with constant arguments), as they are; nothing more is added.
- Where TypeScript could take Lisp's place, as a capture escape or a table formula in TypeScript, that is a departure from Emacs, and goes in [departures.md](../departures.md) for when the base is stable.

## Dependencies introduced

None.
