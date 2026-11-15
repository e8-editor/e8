# 0104. Running a buffer's TypeScript

Status: accepted · 2026-11-15

## Context

In Emacs, `eval-buffer` and `eval-region` (lread.c) run the Lisp in a buffer or region: the way to try a change to a config or a package without saving and loading it. E8 had `load-file` for a file on disk and `M-:` for one expression, but nothing for the buffer being edited. That is the TypeScript a user writes in `init.ts` and their packages.

lread.c's `read-char-exclusive` was also missing. It reads a character and passes over other events, where `read-char` signals for them.

## Decision

- **`eval-buffer` and `eval-region`** are commands beside `load-file` and `eval-expression` (`e8-script/src/lib.rs`):
  - They ask the agent's permission first, as `load-file` does, since they run code.
  - Text without `import` or `export` runs as a script in a block scope of its own, as `load-file` runs one, so running it again does not clash with its own top-level `const`s.
  - Text that imports or exports runs as a module, as only a module can. It is written to a file of its own in the temporary directory, loaded with `load_module`, and the file deleted.
  - The region's text runs under the buffer's name, and the buffer's under its file's name, for error locations.
- **`read-char-exclusive`** is the prelude's `readChar` in a loop that reads and passes over the events that are no character.

## Consequences

- **What it unblocks.** A config or package being edited can be tried with `M-x eval-buffer`, as in Emacs.
- **Recorded in [differences.md](../differences.md):** they run TypeScript, not Lisp, and take none of Emacs's optional arguments for printing or reading.
