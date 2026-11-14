# 0095. Defining charsets

Status: accepted · 2026-11-15

## Context

E8's charsets are a table compiled in (`charset.rs`), those its coding systems use ([ADR 0078](0078-charsets-and-codings-as-emacs-has-them.md)). [ADR 0094](0094-defining-coding-systems.md) let scripts define coding systems, which name the charsets they write. charset.c's definitions were still missing:

- `define-charset-internal`, which mule.el's `define-charset` calls;
- `define-charset-alias` and `declare-equiv-charset`;
- `iso-charset` and `get-unused-iso-final-char`;
- `map-charset-chars`.

## Decision

- **Defined charsets** live in a per-thread table beside the compiled-in one (`DEFINED`), as defined codings do, newest first in `charset-list`. Each is a new kind of map, `Map::Defined`, with its code space, least and greatest code, and one way of mapping codes to characters:
  - **`:code-offset`**: the character is the offset plus the code's distance from the least code;
  - **`:subset`**: a parent's codes from a least to a greatest, moved by an offset;
  - **`:superset`**: other charsets' codes, each moved by its offset, the first that has a character winning.

  `encode-char`, `decode-char`, `charset-plist`, `split-char` and the rest answer for them as for E8's own. So do the charset codings of ADR 0094, which a defined charset can now be part of.
- **A `:map` file** is not read. A charset defined only by one holds no characters. Emacs ships its maps as data files, which E8 does not; its own charsets cover the codings it has.
- **ISO 2022's names** are a table by dimension, 94 or 96 characters, and final byte, as charset.c's `iso_charset_table`. It starts with Emacs's finals for E8's charsets. `:iso-final-char` and `declare-equiv-charset` add to it, and `iso-charset` and `get-unused-iso-final-char` read it.
- **`define-charset-alias`** adds a name to a table of aliases every lookup reads.
- **`map-charset-chars`** (mule.ts) calls its function with each range of characters a charset's codes hold, from a native that works the ranges out (`charsetCharRanges`).
- **mule.ts** has `define-charset`, as mule.el's: the dimension from the code space where not given, the code space all of four bytes where not given, and the properties on the charset's plist.

## Consequences

- **What it unblocks.** Packages that define charsets for their codings load and use them.
- **Recorded in [differences.md](../differences.md):**
  - map files are not read;
  - the finals free are those E8's charsets leave, so `get-unused-iso-final-char` can give one Emacs's own charsets take;
  - definitions are per thread.
