# 0086. The odds of processes, buffer text and windows

Status: accepted · 2026-11-14

## Context

With face and font internals done ([ADR 0085](0085-face-and-font-internals-as-emacs-has-them.md)), three small groups lead the parity ranking at 0.08 to 0.09 ([docs/parity/demand.md](../parity/demand.md)). Emacs's own libraries need them most:

- **Processes' odds** (process.c), for term, gnus and serial-term:
  - `set-network-process-option`;
  - `make-serial-process` and `serial-process-configure`;
  - `process-thread` and `set-process-thread`;
  - `internal-default-interrupt-process` and `internal-default-signal-process`;
  - `process-datagram-address` and `set-process-datagram-address`.
- **Buffer text's odds** (buffer.c, marker.c, editfns.c), for vc:
  - `buffer-last-name`, `buffer-swap-text` and `marker-last-position`;
  - `gap-position` and `gap-size`;
  - `internal--labeled-narrow-to-region` and `internal--labeled-widen`, on which `with-restriction` and `without-restriction` are built;
  - `internal--set-buffer-modified-tick` and `translate-region-internal`.
- **The window tree's odds** (window.c), for dired and erc: `window-display-table`, `set-window-display-table` and `resize-mini-window-internal`.

## Options considered

1. **Write each in TypeScript over what the core gives.** But `buffer-swap-text` has to move a buffer's markers, overlays and undo with its text, and labeled restrictions have to change what `widen` and `narrow-to-region` do. These are C in Emacs for that reason.
2. **All of them in Rust, as process.c, buffer.c and window.c have them.**

## Decision

Option 2 ([ADR 0005](0005-rust-core-typescript-commands.md)).

- **Buffer text** (`buffer.rs`, `editor.rs`, `insdel.rs`):
  - **Last names.** A buffer keeps the name it had before it was last renamed or killed. A killed buffer's name is kept by its id, as its object still answers. A buffer never renamed gives its own name, as Emacs's does.
  - **Swapping text.** `Buffer::swap_text` swaps the text with its properties, overlays, markers, point, mark, narrowing, labeled restrictions, undo history and modified state, as Emacs's `buffer-swap-text` swaps `own_text` and the fields beside it. Names, files, modes and variables stay. Both buffers' ticks move past either's, so no cache takes one for the other, and both are then modified, as Emacs's modiff moves past their saves. Windows showing either start again at its start. Tree-sitter parsers parse again.
  - **Markers.** `marker-last-position` gives a marker's position, or where it last was once its buffer is killed or it is set nowhere.
  - **The gap.** E8's text is a rope, so `gap-position` gives the end and `gap-size` 0.
  - **Labeled restrictions.** Each buffer keeps a stack of them as editfns.c's `labeled_restrictions` does: label, and markers on the edges, with the narrowing that was there first at the bottom with no label.
    - Lisp's `widen` widens only to the innermost labeled restriction, and takes off the outermost once it is all that is left.
    - `narrow-to-region` stays inside the innermost.
    - `save-restriction` keeps and restores the stack.
    - The editor's own narrowing (saving files, restoring a restriction) is unchanged.
  - **The tick.** `internal--set-buffer-modified-tick` offsets the tick Lisp sees, so the editor's caches still follow a tick that only grows.
  - **Translation.** `translate-region-internal` translates by a string or a char-table, in place, keeping properties, markers and point, as `subst-char-in-region` does now through the same code (`translate_chars`). The change hooks see one change, from the first character changed to the last.
- **Windows** (`window.rs`, `rows.rs`):
  - **Display tables.** A window keeps the display table `set-window-display-table` gives it, any value, as Emacs keeps it.
    - Where E8 reads display tables, the selective-display slot hidden text shows, the window's comes first, then the buffer's, then the standard one.
    - Rows know the window they are made for through `Editor::rows_window`, which `layout.rs` and jit-lock set while they make a window's rows.
  - **The minibuffer window.** `resize-mini-window-internal` checks the window is the minibuffer's and that a new total size was set on it, with Emacs's errors, then gives the echo area that many lines.
- **Processes** (`process.rs`, `process/serial.rs`, `process/odds.rs`):
  - **Socket options.** A process keeps a copy of its socket's descriptor, for connections, the connections a server takes and servers. `set-network-process-option` sets options on it with setsockopt, from Emacs's table: `:keepalive`, `:reuseaddr`, `:linger`, `:broadcast`, `:dontroute` and `:oobinline`, and on Linux `:bindtodevice` and `:priority`. `process-contact` then finds the options set.
  - **Serial ports.** `make-serial-process` opens the port as process.c does (`O_NOCTTY`, then `TIOCEXCL`) and reads it on a thread of its own. `serial-process-configure` sets its termios as sysdep.c's `serial_configure` does: speed, byte size, parity, stop bits and flow control, with the `:summary` "8N1". A serial process is of type `serial` and is `open`, `stop` or `closed`. `stop-process` leaves it unread, `continue-process` reads it again, and its contact is the plist Emacs gives. Opening one asks the agent's permission, as starting a program does.
  - **The defaults.** `internal-default-interrupt-process` and `internal-default-signal-process` do what `interrupt-process` and `signal-process` do by default, with Emacs's errors.
  - **Threads and datagrams.** E8 has no Lisp threads and no datagram processes, so `process-thread` and both datagram-address functions give nil. `set-process-thread` takes only nil.

## Consequences

- **Emacs's names.** vc's `buffer-swap-text`, dired's and erc's window display tables, `with-restriction` with a label, term's socket options and serial-term's serial ports are in `e8` under Emacs's names.
- **Recorded in [differences.md](../differences.md):**
  - the gap;
  - the tick Lisp sees;
  - display tables used only for the ellipsis;
  - labeled restrictions not set aside while drawing;
  - threads, datagrams and the process odds listed there.
- **Not done:**
  - a window's display table is not copied when it splits or kept in window configurations;
  - `translate-region-internal` takes no several-character translations.

## Dependencies introduced

None for E8. e8-script's tests use `libc`, as e8-core already does, to make a pseudo-terminal for a serial port and to read socket options back.
