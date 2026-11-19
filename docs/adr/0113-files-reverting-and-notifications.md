# 0113. Files, reverting and notifications as Emacs has them: autorevert.el, revert-buffer's arguments, inotify, and the file primitives' remains

Status: accepted · 2026-11-19

## Context

[docs/differences.md](../differences.md) listed what the files area still lacked. Auto-revert checked buffers on a timer and had no Tail mode, no non-file buffers and no notifications, although E8 had kqueue ([ADR 0072](0072-files-as-emacs-has-them.md)). Linux had no file notifications at all. `revert-buffer` took no arguments: its `revert-buffer-function` was a command, and there was no `buffer-stale-function` for Auto-Revert to ask.

The file primitives had their own gaps:
- `directory-files` sorted even with NOSORT, and its COUNT kept the first names after sorting.
- `verify-visited-file-modtime` compared the time only.
- `lock-file` signalled where Emacs asks, and buffers were locked by their expanded name.
- An auto-save that timed out was tried again at once.
- File name handlers were not asked by `expand-file-name`, `file-attributes`, `copy-file` or `rename-file`.
- `system-type` was not defined.

## Options considered

1. **Leave Auto-Revert's timer and add notifications to it.** Smaller, but every option users set (`auto-revert-avoid-polling`, Tail mode, `global-auto-revert-non-file-buffers`) would still be missing, and Dired could not take part.
2. **Port autorevert.el and the part of files.el it relies on**, with Emacs's inotify back end beside kqueue.

## Decision

Option 2.

**`packages/autorevert.ts`** follows autorevert.el:
- `auto-revert-mode`, `auto-revert-tail-mode` and `global-auto-revert-mode`;
- the timer, which stops when no buffer needs it;
- notifications through `filenotify.ts`, with the 2.5-second lockout after each;
- input stopping the round, with the remaining buffers checked first next time;
- point at the end staying at the end.

**files.ts** has Emacs's `revert-buffer` (IGNORE-AUTO, NOCONFIRM, PRESERVE-MODES):
- `revert-buffer--default`, `revert-buffer-in-progress-p` and `revert-buffer-preserve-modes`;
- `revert-buffer-restore-functions`, keeping the read-only state `read-only-mode` set;
- `buffer-stale-function` and `buffer-auto-revert-by-notification`.

A `revert-buffer-function` that names a command, as Dired's and tabulated lists' do, is run as a command. Dired keeps its directory's time and says when it is stale; the buffer list is always worth reverting.

**`crates/e8-core/src/inotify.rs`** is Emacs's inotify.c, read by a timer as kqueue is. A watch's descriptor is one number, the system's descriptor × 65536 + the watch's id, where Emacs gives a cons. Its system calls live in a module that was type-checked for Linux from macOS; the rest runs only on Linux, on CI.

The primitives, as Emacs's C does:
- `directory-files` reads in the directory's order, keeps the first COUNT, then sorts, or with NOSORT reverses.
- The size is compared with the time.
- `lock-file` asks, as `ask-user-about-lock` does, and before that about a buffer whose file changed on disk; in batch mode both are errors.
- Buffers lock their file's true name.
- An auto-save that took more than a minute keeps its buffer from being auto-saved for 20 minutes, until `clear-buffer-auto-save-failure`.
- `make-temp-file-internal` takes a relative PREFIX from the working directory and gives the name back relative.
- File name handlers answer for the operations above that scripts call.
- `system-type` names the system.

## Consequences

`(revert-buffer t t t)` from code and Auto-Revert keep the modes, as in Emacs. Packages with their own reverting set a function, not only a command. `after-set-visited-file-name-hook` now runs. On Linux, notifications are only as tested as CI's runs.

## Dependencies introduced

None.
