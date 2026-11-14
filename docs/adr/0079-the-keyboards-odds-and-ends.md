# 0079. The keyboard's odds and ends: idle time, this-command-keys, and input modes

Status: accepted · 2026-11-14

## Context

With charsets and coding systems done ([ADR 0078](0078-charsets-and-codings-as-emacs-has-them.md)), keyboard.c's remaining primitives lead the ranking (0.22): five of them, wanted by seven of Emacs's own libraries, eight MELPA packages and two daily ones, and all that company, popup and auto-complete still lack.

E8 has most of keyboard.c already (`crates/e8-core/src/keyboard.rs`): reading keys partway through a command, `this-command-keys` and its kin, `recent-keys`, recursive edits. What is missing is small and scattered.

- **`current-idle-time`** (0.12, the second most needed missing primitive of all) is how a package tells whether it is running from an idle timer, and how long the user has been away. company, popup and auto-complete all call it.
- **`clear-this-command-keys`** (0.04) and **`set--this-command-keys`** make the keys of the command running look like something else, which packages that fake input use.
- **`command-error-default-function`** is the default of `command-error-function`; a package that sets that variable calls it for errors it does not handle itself.
- **`internal-handle-focus-in`** turns a focus-in event into the frame selection Emacs has always done with it.
- The **input modes** — `current-input-mode`, `set-input-mode` and the four that set one part each — say how a terminal reads keys: interrupts or CBREAK, flow control, the eighth bit, and the quit character.
- **`open-dribble-file`** writes every key typed to a file, which is how a bug report records what was pressed.
- **`char-resolve-modifiers`** (character.c) folds a modifier into a character, and **`store-kbd-macro-event`** (macros.c) puts an event into the macro being defined.

## Options considered

1. **Make the input modes do something.** E8's terminal front end reads keys itself through crossterm, in raw mode, decoding UTF-8; it has no CBREAK, no `^S`/`^Q` flow control and no eighth-bit meta. Making them real would mean a second way of reading the terminal, for settings nothing in the corpus sets.
2. **Keep the input modes as state, answered truthfully.** `current-input-mode` says what E8 does — interrupt-driven, no flow control, eighth bit as meta — and the setters keep what they are given so a package that saves and restores the mode works, with `set-quit-char` the one that changes behaviour.

## Decision

Option 2. The work lands in one pull request, behind `make check` on both engines, a review against keyboard.c, character.c and macros.c, and the ported packages' tests.

- **`current-idle-time`** is the seconds since the last key, or nil while a key is being handled, as Emacs's is nil while it is not idle. E8 has no Lisp timestamps, so it is a number of seconds, the unit `run-with-idle-timer` already takes.
- **`clear-this-command-keys`**, with KEEP-RECORD, and **`set--this-command-keys`**, which reads a string as the keys it describes.
- **`command-error-default-function`** shows the error in the echo area and rings the bell, as Emacs's does once a frame is up. In `--batch` it writes to standard error, as Emacs's does.
- **`internal-handle-focus-in`** selects the event's frame, as keyboard.c does, and signals for anything that is no focus-in event.
- **`current-input-mode`** answers `(t nil t 7)`: interrupt-driven, no flow control, the eighth bit as meta, `C-g` to quit. `set-input-mode` and the four one-part setters keep what they are given and answer it again, so a package that saves and restores the mode works; none of them changes how E8 reads the terminal, the quit character included, which stays `C-g`.
- **`open-dribble-file`** writes each key typed, as it is typed, to a file, and closes the one open; nil closes it. A plain character goes in as itself and anything else in angle brackets, `<C-c>`, where Emacs writes a character's byte and an event's name; the file is made afresh, readable only by its owner, and never written through a link, as Emacs makes it, since it records everything typed.
- **`char-resolve-modifiers`** and **`store-kbd-macro-event`**.

## Consequences

- company, popup and auto-complete lack nothing more from this group.
- A package can tell whether it is running idle, which is the commonest reason to call into keyboard.c at all.
- The input modes are state, not behaviour: nothing E8 does changes with them. Recorded in [differences.md](../differences.md).
- `send-string-to-terminal` is left out: E8's front ends draw from the frame description and nothing writes to the terminal behind them ([ADR 0004](0004-egui-front-end.md)).

## Dependencies introduced

None.
