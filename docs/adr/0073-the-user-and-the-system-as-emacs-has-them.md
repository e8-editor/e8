# 0073. The user and the system as Emacs has them: names, ids, processors, and suspending

Status: accepted · 2026-11-13

## Context

Emacs's editfns.c and emacs.c answer questions about who runs Emacs and on what. E8 answers a few of them inside its core: lock files use the login name and the system's name. Scripts can ask none of them. Measured again on 2026-11-13 after files ([docs/parity/demand.md](../parity/demand.md)), these are now the most needed group of missing primitives (0.55):

- `user-full-name`, in six of Emacs's libraries (VC, Gnus, Org export, ChangeLog among them), four MELPA packages and three daily ones, to sign what they write.
- `daemonp` (five Emacs, four MELPA libraries), to tell a server with no frames from an editor someone sees.
- `group-gid`, `group-real-gid`, `user-real-uid`, `user-real-login-name`, `system-users` and `system-groups`, for Tramp, Eshell, Dired and proced.
- `num-processors`, for running work in parallel.
- `suspend-emacs`, behind `C-z` and `C-x C-z` in Emacs (`suspend-frame`), which E8 leaves unbound.

Restart-emacs, and Emacs's desktop and proced, lack nothing else.

## Options considered

1. **Read them in TypeScript from the environment** (`$USER`, `$HOME`). This is wrong for anyone whose environment differs from their account, and it cannot give ids, full names or the system's users.
2. **Ask the system from the core, as Emacs does in C.** Use `getpwuid`, `getgrgid`, `getuid` and the rest through libc natively; on the web, return the stand-ins Emacs gives when it can ask nothing. Suspending is the front end's: the terminal stops itself as Emacs does, and a window iconifies.

## Decision

Option 2, as one pull request behind `make check`, a review against editfns.c, emacs.c and sysdep.c, and the ported packages' tests:

- **Users and groups.** `user-login-name`, `user-real-login-name`, `user-full-name`, `user-uid` and `user-real-uid`, `group-name`, `group-gid` and `group-real-gid`, `system-users` and `system-groups`, and `system-name`.
  - The functions that take a uid or gid look up any account, and answer nil for one that does not exist, as Emacs does.
  - The variables `user-full-name`, `user-login-name` and `user-real-login-name` are set at startup, as Emacs sets them.
  - On the web there is one user, as there is in a browser.
- **The process.**
  - `daemonp`: nil, as E8 has no daemon. `e8-mcp`'s headless editor is not one.
  - `num-processors`: the processors this process may use, all of them, or those online, as its QUERY asks.
- **Suspending.**
  - `suspend-emacs` runs `suspend-hook`, and then the terminal stops itself as a shell's job does. When the shell resumes it, it redraws and runs `suspend-resume-hook`.
  - In a window, where there is no shell to resume E8, it signals an error.
  - `suspend-frame` iconifies a window's frame and suspends a terminal's, on `C-z` and `C-x C-z` as in Emacs.

## Consequences

- Signing commits, ChangeLog entries and exported files takes the name from the system's account, as Emacs does, unless a config sets `user-full-name`.
- `C-z` in the GUI now minimises the window, and in the terminal returns to the shell, as in Emacs. Someone used to E8 leaving it unbound may notice.
- The core asks libc for passwd and group entries. On macOS that may go through Open Directory, so `system-users` is not instant, and it is read only when asked.

## Carried out

Landed on 2026-11-13 in e8-editor/e8's pull request after #116, behind `make check` on both engines, a review against Emacs's source and the ported packages' tests. The tests check users and groups against what the system's own `id` says. The terminal's stopping itself is not run by a test, as it would stop the test; it was tried in a shell under tmux, `C-z` stopping E8 and `fg` bringing it back with its screen drawn again and typing going on. What differs from Emacs is in [differences.md](../differences.md)'s entry for the user and the system. The group took E8 from 585 to 595 of Emacs's 877 editor primitives by name, and every primitive of it is there ([docs/parity/demand.md](../parity/demand.md)).

## Dependencies introduced

None: `libc`, already a dependency of e8-core and the terminal, gives the calls.
