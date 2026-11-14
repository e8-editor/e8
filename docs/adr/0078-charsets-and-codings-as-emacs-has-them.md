# 0078. Charsets and coding systems as Emacs has them

Status: accepted · 2026-11-14

## Context

Measured again on 2026-11-14, after frames and the window tree ([docs/parity/demand.md](../parity/demand.md)), charsets and coding systems are the most needed group of missing primitives (0.23): ten of them, wanted by nine of Emacs's own libraries, six MELPA packages and one daily one, and all that helm-core, doom-modeline, wgrep, geiser and Emacs's `package` still lack.

E8 already has most of what coding.c and charset.c do. `crates/e8-core/src/coding.rs` holds the coding systems, their line ends, detection and the encoders; `charset.rs` holds the charsets as a static table with the code points each gives a character; `codingfns.rs` dispatches the primitives by their Lisp name, and `prelude.js` gives each one its camelCase name on `e8`. What is missing is of two kinds.

**Characters asked about by charset.** `make-char` and `split-char` turn a character into a charset and its position codes and back — the pair Emacs's own Lisp uses to talk about a character in a charset rather than in Unicode. `find-charset-string`, `find-charset-region` and `charset-after` say which charsets some text uses. `charset-plist` and `charset-id-internal` describe a charset. `category-set-mnemonics` reads a category set, and `unicode-property-table-internal` hands out the char-table of a Unicode property.

**Coding systems chosen by name, and asked about.** `find-operation-coding-system` is how Emacs picks a coding from the file's name, the program's or the host's, through `file-coding-system-alist`, `process-coding-system-alist` and `network-coding-system-alist`. E8 has none of those three: a file's coding is found from its bytes alone, so a configuration that says "read `*.bat` as `cp437`" has nowhere to say it. `keyboard-coding-system` and `terminal-coding-system` say what the terminal reads and writes, and `coding-system-plist` describes a coding as a plist.

## Options considered

1. **Charsets defined at run time**, as Emacs's `define-charset-internal` builds them from map files. It would bring `define-charset`, `iso-charset`, `declare-equiv-charset` and the ISO 2022 registry with it, and a charset table that grows. E8's charsets exist to name the code points its coding systems already convert; nothing in the corpus defines one.
2. **Charsets stay the static table they are**, gaining the accessors over it, and the primitives that would define a new one are left out and recorded.

## Decision

Option 2. The charsets stay static; the coding systems stay static too, but gain a plist each that a script can add to, and three alists that choose one by name. The work lands in two pull requests, each behind `make check` on both engines, a review against charset.c, coding.c, chartab.c and category.c, and the ported packages' tests.

1. **Characters by charset.**
   - `make-char` and `split-char`, over a dimension E8 reads from the charset's own map: one byte for a single-byte set, two for a 94×94 or double-byte one, three for Unicode.
   - `find-charset-string`, `find-charset-region` and `charset-after`, in the charsets' own order, as Emacs lists them.
   - `charset-plist` and `set-charset-plist`, over what E8 knows of a charset — its name, dimension, whether it is ASCII-compatible, and its code space, each as Emacs's plist gives it — with what a script puts kept beside them; `charset-id-internal` is its place in the table. The order and the properties belong to the editor, not the process, so two editors in one program do not share them.
   - `set-charset-priority` and `sort-charsets`, which order the list `charset-priority-list` and `char-charset` read.
   - `decode-sjis-char`, `encode-sjis-char`, `decode-big5-char` and `encode-big5-char`, which are `decode-char` and `encode-char` on one charset each.
   - `category-set-mnemonics` and `make-category-set`, over the string of designators E8 already keeps a category set in.
   - `multibyte-char-to-unibyte` and `unibyte-char-to-multibyte` from character.c, which are the `eight-bit` charset by another name.
   - `unicode-property-table-internal`, `get-unicode-property-internal` and `put-unicode-property-internal`, for the properties E8 holds data for — the bidi ones, from the tables ADR 0047 brought — and nil for the rest, as Emacs answers nil for a property whose table it cannot load.
   - `clear-charset-maps` and `unify-charset` do nothing: E8's charsets are built, and already unified.
2. **Coding systems chosen by name.**
   - `file-coding-system-alist`, `process-coding-system-alist` and `network-coding-system-alist`, read by `find-operation-coding-system` as coding.c reads them, and honoured where Emacs honours them: reading and writing a file, and a process's own coding.
   - `keyboard-coding-system`, `terminal-coding-system` and the two `set-...-internal` that set them.
   - `coding-system-plist`, `coding-system-put` and `define-coding-system-alias`.

## Consequences

- helm-core, doom-modeline, wgrep, geiser and Emacs's `package` lack nothing more from this group.
- A configuration can say which coding a file or a program gets, which E8 could not express before.
- `define-charset`, `define-charset-internal`, `define-coding-system-internal`, `iso-charset`, `declare-equiv-charset`, `get-unused-iso-final-char` and `map-charset-chars` are left out: they define or enumerate charsets, which E8's static table does not do. Nothing in the corpus calls them.
- A charset's plist holds what E8 knows, not Emacs's full one: no `:docstring`, `:iso-final-char`, `:emacs-mule-id` or `:unify-map`. Its dimensions and code spaces are Emacs's. Recorded in [differences.md](../differences.md).

## Dependencies introduced

None.
