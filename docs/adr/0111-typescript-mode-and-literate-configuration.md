# 0111. TypeScript mode and a literate configuration

Status: accepted · 2026-11-17

## Context

E8 is configured in TypeScript, yet it had no TypeScript mode: `init.ts` opened without highlighting or indentation, and a `#+begin_src typescript` block in Org had no mode to fontify it with or to edit it in under `C-c '`. Emacs users often keep their configuration as an Org file, `config.org`, whose Emacs Lisp blocks `org-babel-load-file` tangles into `config.el` and loads, and whose blocks they try with `C-c C-c` as they write them. E8 could tangle (`ob-tangle.ts`), but had no `org-babel-load-file` and ran no blocks.

## Options considered

1. **Highlight `.ts` with js-ts-mode.** No new grammar, but JavaScript's grammar does not parse type annotations, so the tree, and with it highlighting, indentation and the sexp commands, breaks on every typed line.
2. **Load TypeScript's grammar from a library, as Go's is ([ADR 0056](0056-grammars-from-shared-libraries.md)).** Works for those who built the library for Emacs, and for no one else: E8's own configuration would be plain text out of the box.
3. **Ship the grammar crate, and port Emacs's typescript-ts-mode.** A larger binary (the TypeScript and TSX parsers), but the language every E8 user writes is highlighted and indented as Emacs does it.

For running a block, Emacs's `org-babel-execute:emacs-lisp` evaluates the block in Emacs. E8's equivalent evaluates TypeScript in the editor, which needs the block's value: `load-file` and `eval-region` give none, so the script API gains `e8.evalTypescript`, which runs text and returns its last statement's value, as Lisp's `eval` does with a form `read` from a string.

## Decision

Option 3: `tree-sitter-typescript` ships, and `typescript-ts-mode` and `tsx-ts-mode` (on `typescript-ts-base-mode`) follow Emacs 30's `typescript-ts-mode.el`: its font-lock rules, indent rules, defun types and predicate, sexps and sentences, Imenu, and the syntax-propertize that makes a regexp's quotes inert. `.ts` and `.tsx` files use them, and `typescript-mode` and `tsx-mode` run them, so Org's blocks find them.

To match Emacs's highlighting where two patterns capture one node, the core now applies a mode's font-lock rules match by match, in the order tree-sitter finishes them, as Emacs's `treesit-query-capture` gathers them with `ts_query_cursor_next_match`, rather than capture by capture.

`ob-core.ts` takes the source-block code that was in `ob-tangle.ts` (header arguments, finding blocks) and adds `org-babel-execute-src-block` on `C-c C-c` (through `org-ctrl-c-ctrl-c-hook`, as Emacs does it) and `C-c C-v e`, with `org-confirm-babel-evaluate`, `:eval`, and results as Emacs writes them: `: value` lines, a table for a list, an example block from `org-babel-min-lines-for-block-output` lines, nothing for nil; `:results silent` and `none`. `org-babel-execute:typescript` (and `:ts`) runs a block with `e8.evalTypescript`, which asks the agent's permission while it acts, as `eval-region` does. `org-babel-load-file` tangles an Org file's TypeScript into FILE.ts when the Org file is newer, and loads it, so an `init.ts` of one line loads a literate `config.org`.

## Consequences

- `init.ts` and packages are edited with highlighting and indentation as in Emacs; `tsc` still checks them.
- The binaries grow by the two parsers. The web build compiles them with the other grammars.
- Fonts in go-ts-mode and bash-ts-mode are applied in the new order too; their tests, recorded from Emacs, still pass.
- `org-babel-tangle-file` as a command takes the file only, as commands take no optional arguments but prefix and count; code that wants Emacs's TARGET-FILE and LANG-RE imports `tangleFile` from `ob-tangle`.
- Not done: `:results output`, `:var`, sessions, noweb references, and languages other than TypeScript, for which C-c C-c says there is no org-babel-execute function, as Emacs does.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| tree-sitter-typescript | 0.23 | TypeScript's and TSX's grammars, for typescript-ts-mode and tsx-ts-mode. |
