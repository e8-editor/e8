# 0038. Comint and M-x shell

Status: accepted · 2026-10-30

## Context

With programs on a pseudo-terminal ([ADR 0037](0037-terminals-sockets-and-process-codings.md)), the next thing Emacs builds is comint.el: a program's conversation in a buffer. It also underlies `M-x shell`, `M-x run-python`, inferior Lisps, SQL and most REPLs. Fields ([ADR 0034](0034-buffer-and-text-property-primitives.md)) were the missing piece for it: comint marks output as the `output` field so C-a and the word commands stop at the prompt.

## Decision

`packages/comint.ts` and `packages/shell.ts`, ported from comint.el and shell.el.

**Comint:**
- **Output** goes through `comint-preoutput-filter-functions`, then in at the process mark as the `output` field. Carriage returns and backspaces work as a terminal shows them, as `comint-carriage-motion` does. Then `comint-output-filter-functions` run. The last line becomes the prompt, read-only with `comint-prompt-read-only`, highlighted as `comint-highlight-prompt`.
- **RET** (`comint-send-input`) sends what is after the prompt, or, before it, the old input at point again. It marks what was sent, runs `comint-input-filter-functions` and keeps the input in a history.
- **The history.** `M-p` and `M-n` go through it, as `comint-input-ring` with its size and `comint-input-ignoredups`, searching it as Emacs does, round the ring. `C-c M-r` and `C-c M-s` go to the inputs that start with what is typed before point, and `comint-previous-matching-input` asks for a regexp. `comint-read-input-ring` and `comint-write-input-ring` read and write a history file as Emacs's do, and `shell-mode` reads the shell's own (`shell-history-file-name`, else `$HISTFILE`, else `~/.bash_history`, `~/.zsh_history`, `~/.sh_history` or `~/.history`, with `$HISTSIZE`). The shell writes it, as on Emacs.
- **Signals.** `C-c C-c`, `C-c C-z` and `C-c C-\` signal the job in the foreground, as the terminal's own characters (C-c, C-z, C-\) do. That is what Emacs does where signals go via characters, as on macOS and BSD, so the shell sees the interrupt as it would at a terminal.
- **The other keys:** `C-c C-d` and `C-d` at the end send end of file, `C-c C-u` kills the input, `C-c C-o` deletes the last output, `C-c M-o` clears the buffer, `C-c C-a` goes to the start of the input, `C-c C-n` and `C-c C-p` go from prompt to prompt, `C-c C-m` copies old input, and `C-c C-r` and `C-c C-e` show output.
- **`make-comint-in-buffer` and `comint-exec`** start a program on a terminal, with `TERM` from `comint-terminfo-terminal` and the window's size.

**Shell.**
- **Which shell.** `M-x shell` runs `explicit-shell-file-name`, else `$ESHELL`, else `shell-file-name` (from `$SHELL`) in `*shell*`. Bash gets `explicit-bash-args` (`--noediting -i`), and another shell `explicit-NAME-args` or `-i`, with `~/.emacs_NAME` as its first input if it exists. With a prefix argument it asks for the buffer.
- **`shell-mode`**, built on `comint-mode`, follows `cd`, `pushd` and `popd` into `default-directory`, as `shell-dirtrack-mode` does.

**Shell commands**, from simple.el:
- `shell-command` on `M-!` runs a command with `shell-file-name` and `shell-command-switch`. Output that fits the echo area (`max-mini-window-height`) shows there; more goes into `*Shell Command Output*`. No output gives Emacs's messages, `(Shell command succeeded with no output)` and `(Shell command failed with code N and no output)`. With a prefix argument the output goes in at point, with the mark after it. A command ending in `&` runs in the background.
- `shell-command-on-region` on `M-|` gives the region as input; with a prefix argument the output replaces it.
- `async-shell-command` on `M-&` runs on a terminal through comint's filter into `*Async Shell Command*`. It asks for a new buffer if one is running there, and says how it ended.

**ANSI colours** (`packages/ansi-color.ts`, added after the rest), from ansi-color.el:
- **What it does.** Comint's output goes through `ansi-color-apply-on-region`, as `ansi-color-process-output` does first among Emacs's `comint-output-filter-functions`. SGR sequences (`ESC [ ... m`) set bold, italic, underline, the eight colours and their bright forms, the 256-colour palette and RGB as faces, and other control sequences are removed.
- **Carrying on.** The rendition carries on into the next output, and a sequence cut off between two reads is finished with the second.
- **Faces.** The faces are Emacs's `ansi-color-*`, with its X colours in hex. Backgrounds and other colours are faces made for them, as E8 has no face attribute lists.
- **Turning it off.** `ansi-color-for-comint-mode` set to `filter` only removes the sequences.

**ANSI colours as Emacs's** (added after the rest, replacing the faces above): `ansi-color.ts` is now ansi-color.el of Emacs 30.2 ported function by function.
- **Faces.** The SGR codes go into Emacs's FACE-VEC, and the face is Emacs's: the basic faces in order (`ansi-color-bold` to `ansi-color-inverse`, faint and blinking included), then the background and foreground as attribute lists, `(:foreground "red3")` for the eight colours from the colours of Emacs's `ansi-color-*` faces, `#RRGGBB` for the rest; `ansi-color-bold-is-bright` as in Emacs. E8's faces read attribute lists in text, which they could not when the first version was written.
- **Strings and regions.** `ansi-color-apply` and `ansi-color-filter-apply` work on strings, keeping their state in `ansi-color-context`; `ansi-color-apply-on-region` and `ansi-color-filter-region` on the buffer, keeping it in `ansi-color-context-region`, a sequence cut off at the end left in the buffer for the next call, as Emacs leaves it.
- **Where faces go.** Through `ansi-color-apply-face-function`: overlays that do not grow by default, as Emacs's comint buffers have, and `font-lock-face` and `ansi-color-face` text properties in `shell-mode` and `*Async Shell Command*`, as shell.el's `shell-apply-ansi-color` puts them. `ansi-color-process-output` is first on `comint-output-filter-functions`, as in Emacs, rather than called by comint's filter, and `ansi-color-compilation-filter` is there for `compilation-filter-hook`.
- **The prompt.** `comint-highlight-prompt` is appended to the prompt's `font-lock-face`, so a coloured prompt keeps its colours, and taken off a line that output goes on after, as `comint-last-prompt` does.
- **Checking.** `tests/emacs/ansi-color.el` runs 23 cases of chunked output through the four functions in Emacs 30.2 and writes what each gives, text and faces, to `tests/emacs/ansi-color.txt`; `tests/all/ansi_color.rs` gives E8 the same chunks and compares.

**Prompt regexps** (added after the rest): with `comint-use-prompt-regexp`, output is not made the `output` field, and `comint-bol` (`C-c C-a`, and `comint-line-beginning-position` beneath the history commands), the old input RET sends, `C-c C-n` and `C-c C-p`, `comint-show-output` and the new `comint-backward-matching-input` and `comint-forward-matching-input` find prompts by `comint-prompt-regexp`, as comint.el's branches do.

**Completion at the prompt** (added after the rest): `comint-completion-at-point` is on `completion-at-point-functions` in comint buffers and asks `comint-dynamic-complete-functions`. `comint-filename-completion` completes the file name before point, of `comint-file-name-chars`, quoted with `comint-file-name-quote-list`, adding `comint-completion-addsuffix` after a file; `comint-dynamic-complete-filename` and `comint-dynamic-list-filename-completions` (`M-?` in shell-mode) are there. `shell-mode` binds TAB to `completion-at-point` and sets up `shell-completion-vars`, with shell.el's functions: `shell-environment-variable-completion`, `shell-command-completion` (the programs on `exec-path`, only the command of its part of the line, found with `shell-backward-command`), `shell-c-a-p-replace-by-expanded-directory` (`=N` and `=-` from the directory stack, a capf returning a function to call, which `completion-at-point` now does as Emacs's does) and `shell-filename-completion`. pcomplete and history expansion are not there.

**Passwords** (added after the rest):
- **Reading them.** `read-passwd`, from auth-source.el, is `readPasswd` in `subr.ts`. It reads with `read-string` and no history, shows the input as `read-hide-char` (`*`) through a `display` property after each command, and keeps its keys out of `recent-keys`, as `inhibit--record-char` does. In `read-passwd-mode`, `C-u` clears the input and `TAB` shows or hides it. With CONFIRM it reads twice and starts over until both agree.
- **Spotting prompts.** `comint-watch-for-password-prompt` is on `comint-output-filter-functions`, as in Emacs. Output matching `comint-password-prompt-regexp`, Emacs 30's own, reads a password with `comint-send-invisible` and sends it.
- **Checking.** 24 prompts are matched as Emacs 30.2 matches them, and `stty -echo; read` in a shell gets the password without it reaching the buffer.

**Supporting changes:**
- `getenv`, and a directory argument to `expandFileName`, as Emacs's have.
- A process on a terminal is interrupted, quit or stopped with CURRENT-GROUP by writing the terminal's character, as Emacs's SIGNALS_VIA_CHARACTERS.

The tests are in `tests/comint.rs` and drive `/bin/sh -i` on a terminal:
- commands and their output, marked as the `output` field, with C-a stopping at the prompt;
- the history and sending old input again;
- interrupting a job and ending the shell;
- the directory following `cd`;
- carriage returns and backspaces.

A real terminal was checked for what the shell does on C-c. The interactive Emacs this would be compared against cannot run in batch. The shell commands have 8 Emacs comparison cases (`shell-commands.json`).

## Consequences

`M-x shell` works, and REPL modes can be written on comint as Emacs's are.

Not done yet:
- `M-r`, searching the history incrementally, which needed isearch's `isearch-search-fun-function` and the hooks around it ([ADR 0042](0042-isearch-state-and-comint-history-search.md) added them and it);
- pcomplete, and history expansion (`comint-input-autoexpand`), which shell-mode's completion also uses;
- ANSI colours in compilation buffers, whose escape sequences compile.ts takes out;
- `comint-accumulate`;
- an error buffer for shell commands' standard error (`shell-command-default-error-buffer`).

## Dependencies introduced

None.
