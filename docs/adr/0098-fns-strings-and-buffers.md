# 0098. fns.c's strings and buffers

Status: accepted · 2026-11-15

## Context

Most of fns.c is Lisp's own data — lists, hash tables, sequences — which E8's packages write in JavaScript. A part works on strings and buffers as text, and Lisp ported from Emacs calls it, with no JavaScript equivalent that answers the same:

- **Base64:** `base64-encode-string`, `base64url-encode-string`, `base64-decode-string` and their region forms, for MIME, URLs and tokens.
- **Comparing and searching:** `compare-strings`, with its bounds and its answer of where strings differ; `string-distance`; `string-search`; `string-collate-lessp` and `string-collate-equalp`.
- **A buffer as a whole:** `buffer-hash`, which packages compare to tell whether a buffer changed, and `buffer-line-statistics`, which so-long.el reads.
- **The system:** `load-average` and `locale-info`.
- **Multibyte:** `string-to-multibyte` and `string-as-unibyte`.

## Decision

Each is written as fns.c does it (`natives/cfns.rs`):

- **Base64.**
  - Bytes are characters U+0000 to U+00FF or raw bytes, as E8 holds bytes; any other character signals "Multibyte character in data for base64 encoding".
  - Lines break at 76, as MIME_LINE_LENGTH. The URL form has no breaks and can leave out padding.
  - Decoding skips whitespace, and with `ignore-invalid` anything else not of the alphabet. Otherwise it signals "Invalid base64 data".
- **`compare-strings`** gives t, or the place of the first difference plus one, negative where the first string is less, with negative bounds counting from the end.
- **`string-distance`** is the Levenshtein distance in characters, or in UTF-8 bytes with `bytecompare`.
- **`string-search`** gives a character index.
- **`buffer-hash`** is the SHA-1 of the buffer's text in UTF-8, as Emacs hashes its internal bytes.
- **`buffer-line-statistics`** counts lines and their lengths in bytes, its mean a running one, as fns.c keeps it, so it ends in the same digits.
- **`load-average`** is getloadavg's (`sysdep::load_average`).
- **`locale-info`** gives the codeset from the locale's variables, and English day and month names. Paper size is nil, as on macOS.
- **Collation** is by code point, as in the C locale.

## Consequences

- **What it unblocks.** Lisp that encodes base64, compares strings Emacs's way or hashes buffers ports without rewriting them.
- **Recorded in [differences.md](../differences.md):**
  - E8 cannot tell a unibyte string from a multibyte one, so `é` encodes as the byte E9 where Emacs's multibyte `é` signals;
  - collation ignores the locale;
  - `locale-info`'s names are English.
