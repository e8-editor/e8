# 0083. The minibuffer's odds as Emacs has them: abort-minibuffers, internal-complete-buffer, read-variable

Status: accepted · 2026-11-14

## Context

With keymaps' rest done ([ADR 0082](0082-keymaps-rest-as-emacs-has-them.md)), what is left of minibuf.c leads the parity ranking at 0.17 ([docs/parity/demand.md](../parity/demand.md)). E8's minibuffer already reads, completes and nests (ADR 0053), but five primitives Emacs writes in C were missing. ivy and swiper each lacked only these, and magit, counsel and helm lacked some of them:

- **`read-variable`**: reads a user option's name, completing, and returns it as a symbol.
- **`abort-minibuffers`**: what `C-g` runs in the minibuffer since Emacs 28. It quits the innermost minibuffer, or, run from an outer one, asks "Abort N minibuffer levels?" and quits that many.
- **`internal-complete-buffer`**: the completion table `read-buffer` completes against, answering the try, all, test and metadata questions of Emacs's table protocol.
- **`innermost-minibuffer-p`** and **`minibuffer-innermost-command-loop-p`**: which of the open minibuffers a buffer is.

## Options considered

1. **All in Rust**, as Emacs has it in C.
2. **The minibuffer's state in Rust and the rest in TypeScript.** The two predicates and `abort-minibuffers` read the stack of open minibuffers and recursive edits, which only the core has. `read-variable` is `completing-read` over the variables, and `internal-complete-buffer` filters the buffer list, both of which scripts can already do.

## Decision

Option 2. The work lands in one pull request, behind `make check` on both engines and a review against minibuf.c.

- **The predicates**: the core lists the open minibuffers' buffers, outermost first, as the live part of Emacs's `minibuffer-list`. `innermostMinibufferP(buffer?)` says whether a buffer is the last of them. `minibufferInnermostCommandLoopP(buffer?)` says whether it is one of them with no recursive edit entered inside it. Both say no for a buffer that does not exist.
- **`abort-minibuffers`** signals "Not in a minibuffer" and "Not in most nested command loop" as Emacs does. From an outer minibuffer it asks with `yes-or-no-p` and quits each level in turn, so each one's command is told it was quit. That is told with `minibuffer-quit`, a kind of `quit`, as Emacs's reads signal it, so a keyboard macro goes on past it and typeahead is kept. Run from `M-x` in a minibuffer, it quits that minibuffer, as it is put back before each level is quit. `C-g` in the minibuffer runs it, as in Emacs, where E8 bound `keyboard-quit`.
- **`internal-complete-buffer`** in `minibuffer.ts` answers as try-completion, all-completions and test-completion would over the buffer list. For empty input it leaves out the buffers whose names start with a space, unless every buffer does. Its metadata gives the category `buffer` and `cycle-sort-function` `identity`. It folds case when `completion-ignore-case` is on, taking the case try-completion takes: a match exact but for case first, then one that keeps the case typed, and what was typed when nothing is added.
- **`read-variable`** completes over the variables, requiring a match, with its default, or the first of a list, for empty input, and `custom-variable-history`.

## Consequences

- ivy and swiper lack nothing more from minibuf.c, and `C-h k C-g` in the minibuffer names Emacs's command.
- E8 does not tell user options from other variables, so `read-variable` offers them all. `internal-complete-buffer`'s predicate is given `[name, buffer]` where Emacs gives a cons, and it ignores `completion-regexp-list`. `read-variable` offers only the first of a list of defaults. A command waiting on a minibuffer `abort-minibuffers` quits can catch `minibuffer-quit` and carry on, where Emacs's throw cannot be caught. Recorded in [differences.md](../differences.md).

## Dependencies introduced

None.
