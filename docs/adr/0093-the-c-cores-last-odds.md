# 0093. The C core's last odds

Status: accepted · 2026-11-15

## Context

After ADRs [0089](0089-xwidgets-as-emacs-has-them.md) to [0092](0092-compositions-as-emacs-has-them.md), the editor and platform primitives E8 still lacked were a scatter, a few from each of Emacs's C files:

- **emacs.c:** `invocation-name`, `invocation-directory` and `daemon-initialized`;
- **sysdep.c:** `get-internal-run-time`, which benchmarking code calls;
- **term.c:** `tty-top-frame`, `tty-no-underline`, `tty--output-buffer-size` and `tty--set-output-buffer-size`;
- **keyboard.c:** `internal-event-symbol-parse-modifiers`, which `event-modifiers` and `event-basic-type` are written on, `event-convert-list`, which `kbd` and key-binding code call, and `internal--track-mouse`;
- **xdisp.c:** `lookup-image-map`, for images with `:map`, and `set-buffer-redisplay`;
- **gnutls.c:** `gnutls-error-fatalp`;
- **The rest:**
  - `cancel-kbd-macro-events`, `set-minibuffer-window` and `menu-bar-menu-at-x-y`;
  - `open-termscript` and `display--update-for-mouse-movement`;
  - `newline-cache-check` and `re--describe-compiled`;
  - `interactive`, called as a function.

Left after them are:

- the charset and coding-system definitions and CCL, which want a pass of their own;
- the macOS display's `ns-*` functions;
- `mark-marker` and `fontset-info`.

## Decision

Each is written as its C does it, in `e8-script/src/natives/codds.rs`, with a defun of its Lisp name in subr.ts where the camelCase name does not read back as Emacs's.

- **How E8 was started.**
  - `invocation-name` and `invocation-directory` are the running program's file name and directory, the directory ending in a slash.
  - `daemon-initialized` signals as Emacs's does when not run as a daemon, which E8 never is.
- **Run time.** `get-internal-run-time` is the processor time getrusage gives, in seconds, as E8's times are numbers (`clock::run_time`).
- **The terminal.** A text terminal is one with a device, as the terminal binary sets; headless editors and windows are not, as Emacs's batch terminal is no termcap one.
  - `tty-top-frame` gives the selected frame there, and nil elsewhere.
  - `tty-no-underline` makes the frame description say so (`FrameDescription::no_underline`), and the terminal front end then draws no underlines.
  - The output buffer size is kept for asking. E8's terminal writes each frame whole, so it changes nothing.
- **Events.** E8's events are keys written as strings, so `event-convert-list` gives a key's description where Emacs gives a character's number: `(control ?a)` is `"C-a"` and `(down mouse-1)` is `"<down-mouse-1>"`. The modifier bits are worked out as keyboard.c works them out (`make_ctrl_char`, shift on a lower-case letter) and written as `key-description` writes them.
  - `internal-event-symbol-parse-modifiers` parses a symbol's name as `parse_modifiers_uncached` does, `click` included, and lists the modifiers highest bit first.
- **Image maps.** `lookup-image-map` finds the first area with the point on it, rectangles, circles and polygons tested as `on_hot_spot_p` tests them.
- **GnuTLS.** `gnutls-error-fatalp` is GnuTLS's table of the errors a connection goes on after, as rustls stands in for GnuTLS ([ADR 0075](0075-compression-and-tls-as-emacs-has-them.md)).
- **The menu bar.** `menu-bar-menu-at-x-y` finds the menu under a place on the menu bar, the blank after a label counting as its menu's, from the symbol each laid-out menu now keeps (`MenuBarItem::symbol`).
- **Keyboard macros.** `cancel-kbd-macro-events` takes the running command's keys back out of the macro being defined.
- **What E8 has no use for** answers as Emacs does where that is nil:
  - `set-buffer-redisplay`, as E8 redisplays after every command;
  - `display--update-for-mouse-movement`, as mouse highlight is worked out at redisplay;
  - `newline-cache-check`, as E8 keeps no newline cache.

  `re--describe-compiled` signals as it does in a release build of Emacs.

## Consequences

- **Recorded in [differences.md](../differences.md):**
  - `event-convert-list` gives key descriptions;
  - `open-termscript` writes nothing;
  - the output buffer size changes nothing.
- **Not done:**
  - `mark-marker`, which needs the mark to be a marker rather than a position;
  - `fontset-info`, which needs the front ends to draw with fontsets;
  - charsets, codings and CCL;
  - the `ns-*` functions.
