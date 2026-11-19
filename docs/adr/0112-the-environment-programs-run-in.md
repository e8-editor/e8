# 0112. The environment programs run in: process-environment, exec-path, and the rest of what processes did not do

Status: accepted · 2026-11-19

## Context

E8 started every program with its own environment, as the operating system gave it to E8, plus `TERM=dumb`, and found the program along that environment's PATH. Emacs keeps the environment in Lisp instead: `process-environment`, a list of `NAME=VALUE` strings that starts as a copy of Emacs's own, is what every program gets, so `setenv` changes it for every program after and binding it changes it for one; and a program is looked for along `exec-path`, not PATH. Configurations rely on both, as exec-path-from-shell does, and E8 had neither `process-environment` nor `setenv`.

[docs/differences.md](../differences.md) also listed what processes did not do yet: `process-coding-system-alist` and `network-coding-system-alist` were read by `find-operation-coding-system` but not by `make-process` or `make-network-process`; `call-process-region` ignored DISPLAY and `call-process` had only E8's own shape; process output went into buffers without running the change hooks; `stop-process` stopped only serial ports, and pipe processes had no `:stop`; connections could not be made without waiting, and there were no datagram (UDP) processes; batch mode went on after `kill-emacs`.

## Options considered

1. **Keep the operating system's environment as the source**, setting it with `std::env::set_var` from `setenv`. Rust makes changing the environment unsafe once threads run, as E8's always do, and binding it around one call would not be possible.
2. **Emacs's design, from callproc.c and env.el.** `process-environment` and `initial-environment` start as copies of the environment, newest first as callproc.c conses them; each program gets `make_environment_block`'s environment (PWD set to its directory if PWD is set at all, DISPLAY from the initial environment if not given, then the list's entries, the first for each name winning, a name alone leaving it out); `exec-path` starts as PATH's directories and programs are found along it with `exec-suffixes`.

## Decision

Option 2, in `crates/e8-core/src/callproc.rs` and `packages/env.ts` (`setenv`, `getenv`, `setenv-internal`, `substitute-env-vars`, `with-environment-variables`), with `getenv`, `getenv-internal`, `substitute-in-file-name` and `executable-find` reading them.

Two of E8's own defaults stay, as they keep programs' output plain in a buffer: TERM is "dumb" unless `process-environment` sets a TERM other than the one E8 started with, and INSIDE_EMACS is "e8" if it is not set. `exec-path` has no `exec-directory` at its end, as E8 has no programs of its own.

The rest, each as process.c, callproc.c or keyboard.c does it:

- A program's codings, given none, are `coding-system-for-read` and `-write`, else what `find-operation-coding-system` says for `start-process`, `call-process`, `call-process-region` or `open-network-stream`, else `default-process-coding-system`.
- `call-process` takes Emacs's arguments as well as E8's command array: an input file, the destination, DISPLAY and the arguments. With DISPLAY, output going into a buffer is inserted, and shown, a whole line at a time as it comes.
- Process output goes into its buffer through `insdel.rs`, so the change hooks run, the buffer read-only or not, widened if the process mark is outside its narrowing, as `read_process_output_before_insert` does.
- `stop-process` and `continue-process`, and `:stop`, keep a connection, server or pipe process from being read, its output, and its end, kept for its filter and sentinel until it is continued.
- `:nowait` looks the name up, then connects on a thread of its own: the status is "connect", then "open" with the sentinel told "open\n", or "failed" with "failed with code N\n". Sending to it, or sending its end, waits for the connection, as `wait_for_socket_fds` does.
- `:type datagram` makes a UDP client or server: each string sent is one datagram, each datagram that comes one piece of output, and `process-datagram-address` and `set-process-datagram-address` read and set where they go.
- `network-lookup-address-info` says getaddrinfo's message for a name that does not resolve, and refuses a name that is not ASCII.
- In batch mode `kill-emacs` and `command-error-default-function` exit there and then, unwinding what runs with a `kill-emacs` condition no handler for `error` catches; run from a sentinel, filter or timer while code waits, the wait unwinds. Cleanup code does run on the way out, where Emacs's `exit` runs none.

`process-inherit-coding-system-flag` stays as it was: Emacs 30 keeps the flag but nothing reads it, so it changes nothing there either.

## Consequences

Packages that pass `env` to `makeProcess` still do, their settings going on top of `process-environment`. Tests that set an environment variable for a program set it in `process-environment`, not in the test's own environment, which E8 copied when it started. A program's PWD is its directory as E8 names it, so `pwd` prints the path through any symbolic link, as in Emacs.

Process output now runs the change hooks, as Emacs's does, so a buffer with costly hooks pays for them on each piece of output.

## Dependencies introduced

None.
