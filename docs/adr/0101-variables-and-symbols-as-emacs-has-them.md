# 0101. Variables and symbols as Emacs has them

Status: accepted · 2026-11-15

## Context

E8's variables are values in a symbol table, with buffer-local values and hooks. data.c, eval.c and lread.c give Lisp more than E8 had, and packages ported from Emacs use it:

- **`defvaralias`**, for a variable renamed with its old name kept working, and `indirect-variable`.
- **Variable watchers** (`add-variable-watcher`), which packages use to react when an option changes.
- **Being bound and local:** `boundp`, `default-boundp`, `makunbound`, `local-variable-p`, `local-variable-if-set-p`, `make-variable-buffer-local`, `special-variable-p` and `symbol-value`.
- **The symbol table:** `intern-soft`, `mapatoms` and `unintern`.
- **The rest:**
  - `string-to-number` and `number-to-string`, with Lisp's syntax;
  - `error-message-string`;
  - `commandp` and `run-hook-wrapped`;
  - `locate-file-internal` and `get-load-suffixes`.

## Decision

- **Aliases** (`Editor::defvaralias`, `base_variable`) are a table of names and the variables they stand for.
  - Every way of reading or setting a variable follows it. While there are no aliases this costs nothing and allocates nothing.
  - A loop signals `cyclic-variable-indirection`, as Emacs's does.
  - A new alias with a value hands it to a variable without one.
- **Watchers** are called before a variable changes, as Emacs's notify_variable_watchers, with:
  - the base variable;
  - the new value;
  - the operation: `set`, `makunbound` for `makunbound` and `kill-local-variable`, or `defvaralias`;
  - the buffer whose own value changes.

  They cost nothing while there are none. A watcher's own changes call no watchers, so one cannot recurse forever, and a watcher's error is logged rather than stopping the change.
- **`makunbound`** takes away the current buffer's own value if it has one, else the global one.
- **`string-to-number`** reads the longest prefix in Lisp's syntax: an integer or float in base 10, an integer in another base, and 0 for none, junk after a number ignored.
- **`error-message-string`** writes `[symbol, ...data]` as print_error_message does:
  - `error` and `user-error` give their message;
  - file errors give their first datum, then the rest as text;
  - others give the symbol's message, then their data as Lisp writes it.

  An error a script caught keeps its own message.
- **`run-hook-wrapped`** calls the wrapper with each function the hook runs here, globals in place of `t`, until it gives something true.
- **`locate-file-internal`** looks along a path, each directory with each suffix. `get-load-suffixes` gives `.ts` and `.js`, what E8 loads.

## Consequences

- **What it unblocks.** Packages that alias renamed variables, watch options, or ask whether variables are bound or local port as written.
- **Recorded in [differences.md](../differences.md):**
  - `commandp` takes a string as a command's name, not as a keyboard macro;
  - `makunbound` of a global variable forgets its documentation;
  - a watcher's errors are logged, not signalled.
