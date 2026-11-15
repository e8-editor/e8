# 0107. Spell checking off the editor thread

Status: accepted · 2026-11-15

## Context

Spell checking follows ispell.el and flyspell.el: one checker, Hunspell here, is kept running as a process, and the editor thread sends it a word and waits for the answer. Hunspell is quick with a word it knows and slow with one it does not, as it looks for corrections before it answers. Measured on the human's Mac with his dictionaries:

| Word | en_US | en_US,sv_SE |
| --- | --- | --- |
| right (`hello`, `kanske`) | 0.01 ms | 0.02 ms |
| `teh` | 2.9 ms | 6.6 ms |
| `flyspell` | 12 ms | 30 ms |
| `multithreading` | 10 ms | 43 ms |
| `ispellning` | 17 ms | 47 ms |

The pipe's round trip is about 10 µs; the cost is all Hunspell's search. A frame is 16 ms. So with `flyspell-mode` on, each unknown word left while typing held the editor for up to 50 ms, often in `flyspell-prog-mode`, where identifiers are unknown words, and `flyspell-buffer` held it about 30 ms for each different unknown word, some 15 s for 500. Emacs pays the same. Wheel scrolling paid it on every step until PR 136 made scrolling a movement flyspell passes over.

[multithreading.md](../multithreading.md) keeps every script and all editor state on one thread, for good: flyspell.ts cannot run on another thread, and only the editor thread can mark a word. What can run beside it is the checker, which is a process already.

## Options considered

1. **Run flyspell on a worker thread.** Ruled out by the threading model: overlays, markers and the buffer belong to the editor thread.
2. **Remember answers.** What Hunspell said of a word holds until what it accepts changes. Invisible, and makes every word after its first free, but the first time each unknown word is met still waits.
3. **Ask without waiting.** Flyspell's checks after a command send the word and return; the answer marks the word when the command loop takes in the checker's output, if the word is still there. The editor never waits on Hunspell while typing. The mark comes a few milliseconds later than Emacs's.
4. **Several checkers for a region.** `flyspell-region` and `flyspell-buffer` share the words out between the session's checker and helpers, more Hunspell processes started the same way, so the search runs on several processors. Each helper costs about 60 ms to start and 18 MB with two dictionaries.
5. **A checker in E8**, such as the `spellbook` crate, which can say whether a word is right without looking for corrections, and would work in the web build, which has no processes. A new dependency whose parity with Hunspell (Swedish compounds, several dictionaries, the personal dictionary) is not known yet.

## Decision

Options 2, 3 and 4, in ispell.ts and flyspell.ts, with no change to the core or the script API:

- The session remembers what the checker said of each word. A line that changes what it accepts or how it reads (`@`, `*`, `+`, `-`, `~`, `$`) forgets it all, unless it says what the checker was told already, as flyspell tells it a buffer's words again each time it changes buffer. An answer asked for before such a change is asked for again.
- Each checker keeps a queue of what waits for its answers, in the order the checks were sent, so checks that do not wait and checks that do (`ispell-word`, `C-.`, `C-c $`, `ispell-region`, which need the answer or its corrections at once) share one process.
- Flyspell's checks after a command, and after `flyspell-delay`, do not wait. The answer is taken to the word through markers and marks it only if the word found there is still the word asked about.
- More than 32 words not yet answered are checked by the session's checker and up to three helpers, one fewer than `num-processors`, 32 words at a time to whichever is free. Helpers are told the lines that changed what the session's checker accepts, a personal dictionary's words (`*`) as words for the session (`@`), so they never save it. They live as long as the session; `ispell-kill-ispell` ends them with it. `flyspell-buffer` still waits for every answer before it returns, as Emacs's does, so `C-,` after it finds what it marked.

Option 5 waits until this is measured with the human's config, or the web build wants spell checking.

## Consequences

- Typing never waits on the checker; a misspelling is underlined a few milliseconds after the command that left it, which [differences.md](../differences.md) records.
- `flyspell-buffer` takes about a quarter of the time on a machine with four or more processors, and a word met again costs nothing.
- Code that reads the overlays straight after a command that left a word must let the command loop take in output first, as the tests do with `acceptProcessOutput`.
- The helpers' state is replayed from the lines sent to the session's checker. A new kind of line that changes what the checker accepts must be noted in `noteState`.
- Helpers are separate processes: three more Hunspells, about 18 MB each with two dictionaries, while a session lasts.

## Dependencies introduced

None.
