# 0072. Files as Emacs has them: the rest of fileio.c, dired.c and filelock.c

Status: accepted · 2026-11-12

## Context

E8 reads, writes, locks and lists files as Emacs's fileio.c, dired.c and filelock.c do. The work is in `fileio.rs`, `fileops.rs`, `filefns.rs` and `filelock.rs`, and scripts reach it through `e8.insertFileContents`, `e8.writeRegion`, `e8.fileAttributes` and the rest. Measured again on 2026-11-12 after scrolling ([docs/parity/demand.md](../parity/demand.md)), the file primitives E8 still lacks are now the most needed group (0.64). They are:

- **The default modes**: `default-file-modes` and `set-default-file-modes`, which subr.el's `with-file-modes` uses. Ten of Emacs's own libraries (Tramp, Eshell, server, auth-source among them) and three daily packages call it to write files only their owner can read.
- **Whether a visited file changed**: `verify-visited-file-modtime`, which ten Emacs libraries and six MELPA packages ask before reverting or saving. E8 has the question as `e8.visitedFileChanged`, but not under Emacs's name. It also answers wrongly for a file deleted since it was visited.
- **Listing and completing names**: `directory-files-and-attributes`, `file-name-completion` (with `file-name-all-completions`), `file-attributes-lessp`, and `access-file`, which signals why a file cannot be read.
- **Emacs's own internals**: `recent-auto-save-p`, `set-buffer-auto-saved` and `clear-buffer-auto-save-failure`; `lock-buffer`, `unlock-buffer`, `lock-file` and `unlock-file`; the `-internal` primitives files.el builds on (`delete-file-internal`, `delete-directory-internal`, `make-directory-internal`, `make-temp-file-internal`, `system-move-file-to-trash`); `unhandled-file-name-directory`; `unix-sync`; `file-system-info`; the ACL and SELinux accessors; and `set-binary-mode`.

These are all that projectile, package-build, and Emacs's comint, diff and xref lack.

## Options considered

1. **Write them in subr.ts over what E8 has.** Most are thin, but several need the system: the umask, `statvfs`, `sync`. The visited-file question also needs the buffer's record of its file. Code that only scripts could reach would duplicate the core's.
2. **Add them to the core, as Emacs has them in C.** Each primitive is a function in the core, or a native over one, and `with-file-modes` goes in subr.ts. Behaviour is checked against Emacs 30 run in batch on a scratch directory.

## Decision

Option 2, in two stages, each a pull request behind `make check`, a review against fileio.c, dired.c and filelock.c, and the ported packages' tests:

1. **What packages call.**
   - `default-file-modes` and `set-default-file-modes`, on the process's umask, with a stand-in on the web; and subr.ts's `withFileModes`.
   - `verify-visited-file-modtime`, `visited-file-modtime`, `set-visited-file-modtime` and `clear-visited-file-modtime`. A file deleted since it was visited counts as changed, as in Emacs.
   - `directory-files-and-attributes` and `file-attributes-lessp`.
   - `access-file`, signalling `file-missing` or `permission-denied` with Emacs's data.
   - `file-name-completion` and `file-name-all-completions`, with Emacs's rules:
     - directories end in `/`;
     - `completion-ignored-extensions` is obeyed unless every match would be ignored;
     - `.` and `..` are left out of a completion;
     - `completion-ignore-case` is obeyed;
     - the predicate is given each match.
2. **What Emacs's own Lisp calls.**
   - The auto-save state: `recent-auto-save-p`, `set-buffer-auto-saved` and `clear-buffer-auto-save-failure`.
   - The locks for scripts: `lock-buffer`, `unlock-buffer`, `lock-file` and `unlock-file`.
   - The `-internal` primitives and `system-move-file-to-trash`, over the core's operations without file name handlers.
   - `unhandled-file-name-directory`, `unix-sync` and `file-system-info`.
   - `set-binary-mode`, which only matters on MS-DOS and gives t elsewhere.
   - `file-acl`, `set-file-acl`, `file-selinux-context` and `set-file-selinux-context`. They answer as Emacs does on a system without ACL or SELinux support: nil, and `(nil nil nil nil)`.

Left out: `kqueue-add-watch`, and file notifications with it, which are a piece of their own (filenotify.el, `auto-revert-use-notify`). They go in [differences.md](../differences.md).

## Consequences

- `with-file-modes`, Tramp-style private files and `verify-visited-file-modtime` port as written.
- Changing the umask changes it for the whole process: programs E8 starts afterwards inherit it, as Emacs's do.
- On the web there is no process umask, so E8 keeps one of its own, which only `default-file-modes` reads.
- Reading the umask means setting it and setting it back, as Emacs does, since POSIX has no other way. No other thread of E8's creates files at that moment.

## Carried out

Both stages landed on 2026-11-12 and 13, each after `make check` on both engines, a review against Emacs's source, and the ported packages' tests, with every answer the tests check recorded from Emacs 30 in batch on the same files:

1. What packages call: e8-editor/e8 pull request 115. The review it had found completion's rules for ignored extensions and case, and visited file times losing their precision, both fixed there.
2. What Emacs's own Lisp calls: the pull request after it. `set-buffer-modified-p` now locks and unlocks the file as Emacs's does.

What differs from Emacs is in [differences.md](../differences.md)'s entry for file primitives. Files took E8 from 557 to 585 of Emacs's 877 editor primitives by name; only `kqueue-add-watch` is left of the group ([docs/parity/demand.md](../parity/demand.md)).

## Dependencies introduced

None: `libc`, already a dependency of e8-core, gives `umask`, `statvfs` and `sync`.
