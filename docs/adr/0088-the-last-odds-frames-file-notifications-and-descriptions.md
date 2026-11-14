# 0088. The last odds: frames, file notifications and descriptions

Status: accepted · 2026-11-14

## Context

After SQLite ([ADR 0087](0087-sqlite-as-emacs-has-it.md)), all 77 daily packages need nothing E8 lacks. What the corpus still calls, apart from xwidgets, which ADR 0087 leaves out, is a handful of primitives, each needed by one or two of Emacs's own libraries ([docs/parity/demand.md](../parity/demand.md)):

- **Frames** (frame.c, nsfns.m):
  - `frame-after-make-frame`, `handle-switch-frame` and `frame--set-was-invisible`;
  - `x-create-frame`, which `make-frame` calls on a window system;
  - `ns-frame-geometry`, `ns-frame-edges`, `ns-frame-list-z-order`, `ns-frame-restack` and `ns-display-monitor-attributes-list`, which frame.el's geometry functions call on macOS.
- **File notifications** (kqueue.c): `kqueue-add-watch`, through which filenotify.el watches files on macOS. E8 had no file notifications.
- **Descriptions**:
  - keymap.c's `describe-vector`, `help--describe-vector` and `text-char-description`;
  - syntax.c's `internal-describe-syntax-value`, which `describe-syntax` and `describe-categories` are written on.
- **The odds**:
  - keyboard.c's `set--this-command-keys`;
  - dispnew.c's `send-string-to-terminal`, for term and the terminal title;
  - xdisp.c's `display--line-is-continued-p`, for mouse.el.

## Decision

Each as Emacs has it.

- **Descriptions** (help.ts). describe_vector is ported:
  - a newline first;
  - each run of equal entries as its first key, " .. " and its last;
  - the entry described, at column 16 by default.

  `help--describe-vector` takes help--describe-map's prefix, shadow maps, entire map and partial flag, as keymap.c's does. `internal-describe-syntax-value` writes the descriptor's class, match and flags, and what they mean, as syntax.c does. `text-char-description` is a native.
- **The odds.**
  - `set--this-command-keys` takes Lisp's string of characters, a character with its 8th bit set being Meta. E8's `setThisCommandKeys` keeps taking key descriptions.
  - `send-string-to-terminal` writes to standard output in batch. On a terminal it is handed to the terminal front end, which writes it before it next draws, as the bell already is. On a graphical frame it signals, as Emacs's does.
  - `display--line-is-continued-p` is the Lisp name of E8's `displayLineIsContinuedP`.
  - The names with `--` are defined under their Lisp names in help.ts.
- **Frames** (`frame.rs`, `window.rs`):
  - **Made frames.** A frame `x-create-frame` makes is not yet made, as nsfns.m leaves it, so `window-configuration-change-hook` does not run for it until `frame-after-make-frame` says so.
  - **Switch-frame events.** `handle-switch-frame` selects the frame a switch-frame event names, keeping the prefix argument and running `mouse-leave-buffer-hook`, as frame.c does.
  - **The stacking order.** The editor keeps frames in an order of its own, topmost first, which raising, lowering, making and restacking change, for `ns-frame-list-z-order` and `ns-frame-restack`.
  - **Geometry.** `ns-frame-geometry` and `ns-frame-edges` work out the title bar and border from the outer and native sizes the front end writes, as nsfns.m's `frame_geometry` does. `ns-display-monitor-attributes-list` is `display-monitor-attributes-list` with NS as the source.
  - **On a terminal.** `x-create-frame` and restacking signal there, and the z-order and monitors are empty, as in Emacs there.
- **File notifications** (`kqueue.rs`, `filenotify.ts`):
  - **kqueue.** `kqueue-add-watch`, `kqueue-rm-watch` and `kqueue-valid-p` are ported from kqueue.c, on the system's kqueue: files opened for events only, descriptors as Emacs gives them, and directories compared listing by listing as `kqueue_compare_dir_list` does, so creating, deleting and renaming files in a watched directory are reported as Emacs reports them.
  - **When they are read.** The editor's own thread reads the kqueue without waiting, from a timer every 50 ms while anything is watched. This is how Emacs reads it when it waits, so events coalesce as Emacs's do.
  - **filenotify.el.** `filenotify.ts` ports `file-notify-add-watch`, `file-notify-rm-watch`, `file-notify-valid-p` and `file-notify-rm-all-watches`, with filenotify.el's handling of renames, stopped watches and backup files.
  - **Elsewhere.** On Linux and the web watching signals "File watching is not available".

## Consequences

- **Every primitive left is a platform one or Emacs's own.** Every primitive the corpus's packages call is in E8, except xwidgets.
- **File notifications.** auto-revert, and packages that watch files, can be ported.
- **Recorded in [differences.md](../differences.md).**
- **Not done:**
  - an inotify backend for Linux;
  - frame.el's `frame-geometry`, `frame-list-z-order` and `frame-restack` wrappers over the ns primitives;
  - `make-frame` going through `frame-creation-function` and its hooks;
  - a front end that follows a restack.

## Dependencies introduced

None.
