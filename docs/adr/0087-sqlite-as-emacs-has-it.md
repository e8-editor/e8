# 0087. SQLite as Emacs has it

Status: accepted · 2026-11-14

## Context

After [ADR 0086](0086-the-odds-of-processes-buffer-text-and-windows.md), nothing left in the parity ranking scores above 0.06 ([docs/parity/demand.md](../parity/demand.md)). What is left is mostly platform primitives:

- **xwidgets** (0.05);
- **the macOS display's frame queries** (0.04);
- **SQLite** (0.03). emacsql needs nothing else, and Emacs's own Lisp is growing users of it: `sqlite-mode`, `multisession`.

Emacs has 17 SQLite primitives in sqlite.c. E8 had none.

xwidgets would need a WebKit view inside the GUI's window. That is a front-end project of its own, not a primitive. An Emacs built without xwidgets has none of those functions either, and packages check `(featurep 'xwidget-internal)` before using them. They stay out.

## Options considered

1. **rusqlite**, SQLite's usual Rust binding. Its statements borrow their connection, so they cannot live on as Emacs's set objects do, between calls and across a script's turns, without unsafe tricks of their own.
2. **`libsqlite3-sys` with SQLite bundled**, called as sqlite.c calls the C library. A set holds its statement as Emacs's does, and each function is the same calls in the same order, so errors, return values and edge cases come out the same.

## Decision

Option 2.

- **Objects.** Databases and sets are values, `Value::Sqlite`, by id, the prelude's `Sqlite` objects. Each keeps its handles as sqlite.c's `Lisp_Sqlite` does: a set its database's handle and its statement, a closed one neither. They are freed when closed or finalized; E8 has no garbage collector to free them otherwise.
- **The primitives** (`sqlite.rs`) are sqlite.c's, call for call:
  - `sqlite-open`, on a file made if there is none or a database of its own in memory, serialized and with URIs;
  - `sqlite-execute`: the first statement, giving rows changed or the rows a statement gives;
  - `sqlite-select`: rows, `full` with the column names, or a `set`;
  - `sqlite-next`, `sqlite-columns`, `sqlite-more-p` and `sqlite-finalize`;
  - `sqlite-execute-batch`, `sqlite-transaction`, `sqlite-commit`, `sqlite-rollback` and `sqlite-pragma`;
  - `sqlite-load-extension`, for Emacs's allowlist only;
  - `sqlite-close`, `sqlite-version`, `sqlitep` and `sqlite-available-p`.
- **Values.** Values bound to `?` are as `bind_values` binds them:
  - strings as UTF-8 text, or as blobs where their `coding-system` property is `binary`;
  - whole numbers as integers, other numbers as floats;
  - nil as NULL, and t and `false` as 1 and 0.

  Rows come back as `row_to_value` gives them, blobs as strings of characters U+0000 to U+00FF, as E8 holds bytes.
- **Errors.** `sqlite-error` and `sqlite-locked-error` carry Emacs's data. A failed prepare gives `(ERRSTR ERRMSG CODE EXTENDED-CODE)`.
- **The web.** E8 in a browser has no SQLite: `sqlite-available-p` is nil there and the rest signal.

## Consequences

- **What it unblocks.** emacsql and the Lisp written on Emacs's SQLite can be ported.
- **Recorded in [differences.md](../differences.md):**
  - a database not closed stays open until E8 exits;
  - a string's coding other than `binary` is taken as UTF-8.
- **Not done:** xwidgets, as above.

## Dependencies introduced

- **`libsqlite3-sys`**, with its `bundled` feature, in e8-core, not on the web. It builds SQLite's own C source, which is in the public domain, into E8, so E8 does not depend on the system's SQLite.
