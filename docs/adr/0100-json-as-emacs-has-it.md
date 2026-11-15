# 0100. JSON as Emacs has it

Status: accepted · 2026-11-15

## Context

json.c gives Lisp `json-parse-string`, `json-parse-buffer`, `json-serialize` and `json-insert`. Language servers, ACP and web APIs all speak JSON, and Lisp ported from Emacs calls these by name with json.c's options:

- objects as hash tables, alists or plists;
- what stands for null and for false;
- errors with where in the text they are.

E8's packages use JavaScript's `JSON`, which parses only whole strings, reports errors in its own words, and cannot be told what stands for null.

## Options considered

1. **The prelude over `JSON.parse` and `JSON.stringify`.** It has no position in the buffer to parse from and to move point past, nor json.c's error data.
2. **serde_json.** It is already a dependency, but without its `preserve_order` feature its objects sort their keys, where Emacs keeps their order. Turning the feature on changes every other user of the crate in the workspace.
3. **A small reader and writer of E8's own** (`natives/cjson.rs`), as json.c is now, since Emacs 30 dropped Jansson for its own.

## Decision

Option 3.

- **Reading.**
  - Objects keep their keys' order, a key given twice keeping its first value.
  - Strings take `\u` escapes and surrogate pairs.
  - Errors are json.c's conditions, defined as Emacs defines them under `json-error`: `json-end-of-file`, `json-trailing-content`, `json-parse-error` and `json-escape-sequence-error`. Their data is the line, column and position, counted past the character read as json.c counts them.
  - `json-parse-buffer` reads from point and moves point past the value.
- **Writing.**
  - Objects and `Map`s become objects, a key given twice written once; arrays become arrays.
  - True, numbers and strings are themselves. The null and false objects become null and false, and Lisp's nil becomes `{}`, as an empty alist does.
  - Raw bytes signal `wrong-type-argument json-value-p`, as Emacs's do.
- **Crossing to scripts.** Objects cross between the natives and the prelude as lists marked with a symbol, which no JSON string can be. The prelude turns them into JavaScript objects, as E8's stand-in for hash tables, the default `:object-type`. `alist` gives `[key, value]` lists and `plist` `[":key", value, ...]`.
- **Null and false** are `Symbol.for(":null")` and `Symbol.for(":false")` by default, as Emacs's are the keywords `:null` and `:false`, and options change them.

## Consequences

- **What it unblocks.** Ported Lisp that reads and writes JSON with json.c's options works as written in TypeScript terms.
- **Recorded in [differences.md](../differences.md):**
  - options are an object, not keyword arguments;
  - `json-serialize` gives text rather than a unibyte string of UTF-8, as E8's strings hold characters;
  - integers past 2^53 lose precision, as E8's numbers are doubles.
