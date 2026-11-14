# 0090. The C core's primitives by their names

Status: accepted · 2026-11-14

## Context

After [ADR 0089](0089-xwidgets-as-emacs-has-them.md), every editor primitive the corpus calls is in E8. Of the 877 editor primitives, 87 still lacked Emacs's names. Many of them are things E8 does under names of its own, or that Lisp writes in one line over what E8 has:

- `char-to-string`, `buffer-modified-p`, `set-buffer`, `scroll-up` and their like;
- `format` and `format-message` themselves, which scripts had in JavaScript's own ways.

Ports read best when the Lisp they follow can be followed name for name ([docs/parity/demand.md](../parity/demand.md) calls these the one-liners). `format`'s exact behaviour matters to anything that formats messages as Emacs does.

## Decision

Each under Emacs's own name, with Emacs's arguments and errors. Where Emacs does it in C, so does E8.

- **`format` and `format-message`** (`format.rs`) are editfns.c's `styled_format`:
  - field numbers `N$`;
  - the flags `-`, `+`, space, `0` and `#`;
  - width and precision;
  - `%s` as `princ` and `%S` as `prin1`, `%d %o %x %X %c %e %f %g` and `%%`;
  - Emacs's errors.

  `format-message` curves the format string's quotes as `text-quoting-style` says.
- **Characters and strings** (natives in `cnames.rs`): `char-to-string`, `string-to-char`, `byte-to-string`, `char-equal` (folding case as `case-fold-search` says), `following-char`, `preceding-char`, `string`, `unibyte-string`, `characterp`, `max-char`, `char-width` and `ngettext`.
- **Buffers.** `buffer-modified-p`, `restore-buffer-modified-p`, `set-buffer`, `get-file-buffer`, `force-mode-line-update`, `set-buffer-multibyte` and `undo-boundary`. `set-buffer-multibyte` only sets `enable-multibyte-characters`, since E8's buffers always hold characters.
- **Windows and frames.** `window-body-height`, `window-body-width`, `window-text-height` and `window-text-width` in lines and columns or with PIXELWISE, and `set-frame-selected-window`, which a frame not selected keeps for when it is.
- **The minibuffer.**
  - natives: `minibufferp`, `minibuffer-prompt`, `minibuffer-contents-no-properties` and `assoc-string`;
  - minibuffer.ts: `read-buffer` and `read-command`.
- **Keys.**
  - `key-description` and `single-key-description` of events as Lisp writes them: characters with modifier bits, symbols, or a string.
  - subr.ts: `make-keymap` and `map-keymap`.
- **Processes.** `set-process-buffer`: output goes at the new buffer's end from then on.
- **Calling.** `funcall-interactively`, with `called-interactively-p` true inside.
- **Lisp-level odds.**
  - subr.ts: `save-current-buffer`, `insert-before-markers-and-inherit`, `make-temp-name` and `optimize-char-table`;
  - simple.ts: the commands `beginning-of-line`, `end-of-line`, `scroll-up` and `scroll-down`.
- **Names with `--`,** which camelCase cannot write, defined under their Lisp names: `internal--labeled-narrow-to-region`, `internal--labeled-widen`, `internal--set-buffer-modified-tick` and `frame--set-was-invisible`.

## Consequences

- **Ports follow the Lisp name for name.**
- **Recorded in [differences.md](../differences.md):**
  - `%s` of a float with nothing after its point prints no point, as E8's numbers cannot tell `1.0` from `1`;
  - buffers that are always multibyte.
- **Not done** (`interactive` and `mark-marker`):
  - `interactive` is a special form, which commands declare their own way;
  - E8's mark is a position, not a marker.

## Dependencies introduced

None.
