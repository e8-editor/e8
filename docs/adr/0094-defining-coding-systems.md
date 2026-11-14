# 0094. Defining coding systems

Status: accepted · 2026-11-15

## Context

E8's coding systems are a table compiled in (`coding.rs`), Emacs's 55 commonest ([ADR 0078](0078-charsets-and-codings-as-emacs-has-them.md)). Lisp defines more:

- **`define-coding-system`**, in configs and packages that read a file format or talk to a program in a coding of their own;
- **`define-coding-system-alias`**, more common still, for the names other programs use, such as `UTF8` or `cp65001`.

Both stand on coding.c's `define-coding-system-internal` and `define-coding-system-alias`. E8 had neither, nor `find-coding-systems-region-internal`, `read-non-nil-coding-system` or `set-safe-terminal-coding-system-internal`.

## Decision

- **Defined codings** live in a table beside the compiled-in one, as the coding priority list already does, per thread (`DEFINED`). They are kept for the life of the thread, as Emacs keeps a coding system for its life.
  - A defined coding answers everything a built-in one does: its type, mnemonic, line ends and their `-unix`, `-dos` and `-mac` forms, its aliases, and encoding and decoding.
  - Defining one again replaces it. A name E8 has built in is left as it is.
- **The coding types:**
  - `utf-8` and `utf-16` take `:bom` (t, nil, or a cons to take a signature away if there) and `:endian`.
  - `raw-text` and `undecided` are as E8's own.
  - **`charset`** codings write each character as its code point in the first charset of `:charset-list` that has it: one byte for a one-dimensional charset, more for others, as coding.c's charset codings do. This is a new kind, `Kind::Charsets`, on charset.c's `encode-char` and `decode-char`.
  - `iso-2022`, `shift-jis`, `big5`, `emacs-mule` and `ccl` are written through their charsets the same way, without their designations and escapes.
- **Line ends.** `:eol-type` fixes a coding's line ends, as Emacs's does for a symbol: it has no `-unix`, `-dos` and `-mac` forms, and decodes and encodes with those line ends.
- **Aliases.** `define-coding-system-alias` adds a name to a table of aliases (`MORE_ALIASES`) that every lookup of a name reads. `coding-system-aliases` lists it after the coding's own.
- **mule.el's functions** are ported in mule.ts:
  - `define-coding-system` passes its properties to `define-coding-system-internal` in coding.c's order (`coding_arg_index`), and puts the rest on the coding's plist;
  - `read-non-nil-coding-system`.

  Fixed with it: `coding-system-get` now gives what `coding-system-put` put. It used to answer only the properties E8 works out.
- **The rest of coding.c:**
  - `find-coding-systems-region-internal` gives the codings that can write a region or string, t for ASCII;
  - `set-safe-terminal-coding-system-internal` checks its coding and keeps it in `safe-terminal-coding-system`, as E8's terminal writes UTF-8.

## Consequences

- **What it unblocks.** Configs and packages that define codings or aliases load, and their codings read and write files.
- **Recorded in [differences.md](../differences.md):**
  - ISO 2022, Shift_JIS, Big5, emacs-mule and CCL codings a script defines are written through their charsets alone;
  - translation tables, post-read and pre-write conversions are kept on the plist but not applied;
  - definitions are per thread.
- **Next:** charset.c's definitions (`define-charset-internal` and its kin), so a defined coding can use a defined charset.
