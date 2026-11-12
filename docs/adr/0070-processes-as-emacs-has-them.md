# 0070. Processes as Emacs has them: objects, filters and sentinels set at any time, and the rest of process.c

Status: accepted · 2026-11-12

## Context

E8 runs programs as Emacs's process.c does: on a pseudo-terminal or pipes, over the network, with codings, signals and a process mark ([ADR 0024](0024-processes-compiling-comments-and-indentation.md), [ADR 0037](0037-terminals-sockets-and-process-codings.md)). In scripts a process is its name, a string, and its filter and sentinel are given once, to `makeProcess`.

Measured again on 2026-11-12 after the windows work ([docs/parity/demand.md](../parity/demand.md)), processes are now the group of missing primitives most needed: `set-process-sentinel` is the single most needed primitive, `set-process-filter` the third, `process-filter` the tenth, and the group is all that 30 of MELPA's 295 most downloaded packages lack, markdown-mode, async, request, web-mode and rust-mode among them. What packages do with them:

- **Set a filter or sentinel after starting**, as `(set-process-sentinel (start-process ...) #'my-sentinel)`: `start-process` takes neither, so most code sets them this way.
- **Read one back and wrap it**, as `(let ((old (process-filter proc))) (set-process-filter proc (lambda (p s) ... (funcall old p s))))`, and fall back to the default, `internal-default-process-filter`, which inserts at the process mark.
- **Keep data on the process**, with `process-put` and `process-get` on its plist, read back in its sentinel.
- **Tell a process from a name**, with `processp`, and hold the process after it has gone, asking its exit status and buffer.

A process as a name answers none of these well. `processp` cannot tell a process from a string, a name is reused once its process has gone, so a sentinel holding it may ask about another, and nothing is left to ask once the process has left `process-list`. E8 gives scripts buffers, markers, windows and frames as small objects holding an id ([ADR 0069](0069-windows-as-emacs-has-them.md)); processes are the last of Emacs's editor objects that are not.

The rest of the group is smaller and separate: `call-process-region`, `make-pipe-process`, `process-attributes` and `list-system-processes`, `getenv-internal`, `signal-names`, `process-running-child-p`, `format-network-address` and the network lookups.

## Options considered

1. **Add the setters on names.** `setProcessFilter(name, f)` and its kin, keeping processes strings. Smallest, but `processp`, names reused, and asking about a process once it has gone stay wrong, and ports keep writing around them.
2. **Processes as objects, as windows became.** A `Process` in the prelude, one object per process, holding its id, which filters and sentinels receive and every function taking a process takes, a name too while packages and ports move. The core keeps what can be asked of a process once it has gone.

## Decision

Option 2, in two stages, each a pull request behind `make check`, a review against process.c and subr.el, and the ported packages' tests:

1. **Processes as objects, filters and sentinels set at any time.** `Value::Process(id)` in the core and `Process` in the prelude, printing as `#<process NAME>`, its `toString` the name so code that passes it where a name went keeps working, as a `Buffer`'s does. `makeProcess`, `makeNetworkProcess`, `getProcess`, `getBufferProcess` and `processList` give objects; filters and sentinels receive them; every function taking a process takes an object or a name. `processp` answers as Emacs's does. `set-process-filter`, `set-process-sentinel`, `process-filter`, `process-sentinel`, `internal-default-process-filter` and `internal-default-process-sentinel` come under Emacs's names, with a filter or sentinel of nil meaning the default, as in Emacs, and a filter of `t` stopping output from being read until another is set. `process-plist`, `set-process-plist`, and subr.el's `process-get` and `process-put` follow. A process that has gone keeps its name, command, status, exit status, buffer and plist on its object, as Emacs's does, so `process-status` and `process-exit-status` answer after it has left `process-list`; its streams, filter and sentinel are dropped.
2. **The rest of process.c and callproc.c that packages call.** `call-process-region` (and subr.el's `call-shell-region`), `make-pipe-process`, `process-attributes`, `list-system-processes`, `getenv-internal`, `signal-names`, `process-running-child-p`, `format-network-address`, `network-lookup-address-info`, `network-interface-list` and `network-interface-info`, `process-inherit-coding-system-flag` and its setter, and `waiting-for-user-input-p`.

Left out, as no package in the corpus needs them yet: serial processes, datagrams and their addresses, `set-network-process-option`, and `process-thread`, as E8's scripts have no threads of their own. They go in [differences.md](../differences.md).

## Consequences

- Code that sets a filter or sentinel after starting, wraps one, or keeps data on a process ports as written, and `start-process` and `make-process` can follow Emacs's shapes.
- Every package that holds a process moves to the objects in stage 1: acp, comint, compile, eglot, ispell, package-vc, shell, files, simple and subr, and the ports that start processes (e8-magit, e8-with-editor, e8-consult, e8-marginalia), each in its own repository. Names are accepted meanwhile, so nothing has to move at once.
- A process's record outlives it, for as long as the session. It is small, the plist aside, and Emacs keeps a process object as long as anything refers to it; E8 cannot see what scripts refer to, so it keeps them all. A session that starts a very large number of processes could notice; then records of processes long gone could be dropped, keeping only their status.
- The agent and e8-mcp go on naming processes by name.

## Carried out

Both stages landed on 2026-11-12, each after `make check`, a review against Emacs's source, and the ported packages' tests:

1. Processes as objects, filters and sentinels set at any time: e8-editor/e8 pull request 110, after e8-editor/e8-with-editor#2, e8-editor/e8-consult#2 and e8-editor/e8-magit#23 moved those ports to the objects.
2. The rest of process.c and callproc.c: the pull request after it. `process-attributes`, the network interfaces and the real-time signals' names have code for Linux that was type-checked there, not run, until CI on `main` runs it.

What differs from Emacs is in [differences.md](../differences.md)'s process entries: a filter of `t` holds output rather than stopping the read, a pipe process serves one program's standard error, `process-attributes` gives sizes and times as numbers, and the primitives left out above. Process objects and these primitives took process.c from 32 to 52 of its 63 primitives by name ([docs/parity/demand.md](../parity/demand.md)).

## Dependencies introduced

None.
