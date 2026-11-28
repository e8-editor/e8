# The Emacs oracle

These tests check that E8 behaves like GNU Emacs by running the same keys on the same text in both and comparing the results: the text, point, mark, whether the region is active, the kill ring, whether the buffer is modified, and the first error.

- `cases/*.json`: the cases, one file per chapter of the Emacs manual.
- `golden/*.json`: what Emacs did, recorded by `record.el`. Committed, so the tests run without Emacs.
- `known-gaps.txt`: cases where E8 does not match Emacs yet, with the reason. This is the to-do list.
- `crates/e8-script/tests/emacs.rs`: the tests that compare E8, with its bundled packages, against the golden files: eight shards of the cases, each a test nextest runs alone on every core, so each stays well inside its three minutes, and one that checks `known-gaps.txt` names only cases there are.

## Adding a case

1. Add it to the right file in `cases/`. Use the manual's chapter, or start a new file.

   ```json
   { "name": "kill-line-twice-kills-the-newline", "text": "one\ntwo", "keys": "C-k C-k" }
   ```

   `keys` are space separated, in Emacs's `kbd` notation (`C-x C-f`, `M-S-f`, `<f3>`, `SPC`). `point` is optional and counts characters from 0. `modes` is optional: commands that turn modes on before the keys, such as `["delete-selection-mode"]` or `["org-mode"]`, called with a prefix argument of 1 in both editors (major modes take no argument in Emacs). `call` is optional: a command and its arguments, called before the keys, as in `["query-replace", "foo", "bar"]`, for commands that would otherwise prompt. `platform` is optional, for cases that only hold on one platform, as an Emacs `system-type` such as `"darwin"`: keys bound differently by platform need it, as `<home>` and `<end>`, which go to the buffer's ends on macOS and to the line's elsewhere, so a case recorded on a Mac fails on CI's Linux runners without it.

   Cases can also visit real files. `files` is an object of file names and their text, written into a fresh directory for the case (`target/oracle-files`, outside the temporary directory, as Emacs makes no backups there; text starting `latin-1:` is written as Latin-1). `find` names the file to visit instead of the case's buffer; if it is not among `files`, it holds `text`. `disk` is the text the visited file gets on disk, as if from another program, when the keys reach `<f33>`. These cases record every file in the directory afterwards, so backups (`a.txt~`) and auto-save files (`#a.txt#`) are compared too. `message: true` compares the last message, with the directory written as `DIR`; batch Emacs never says "Wrote", so save cases cannot compare it. `vars` sets buffer-local variables after the modes are on, as `{"fill-column": 20}`, and `globals` default values for the case before they start, as a mode reads some only then, as Org mode reads `org-enforce-todo-dependencies`; both take numbers, strings, a string starting with `'` for a symbol (`"'headline-data"`) and with `''` for a quoted one (`"''day"` for `'day`, which E8 reads as its value), true or false for t and nil, a list of such values and lists for a list, as `["':link", false]` for `(:link nil)` and `[["n", "Agenda", [["'agenda", ""]]]]` for `(("n" "Agenda" ((agenda ""))))`, an object of one string inside a list standing for a cons, as `{"p": "Projects"}` for `("p" . "Projects")`, and an object of strings for an alist, as `{"org-global-properties": {"LOGGING": "logdone"}}` is `(("LOGGING" . "logdone"))` in Emacs and `[["LOGGING", "logdone"]]` in E8 (E8 reads the object's keys sorted, so give an alist whose order matters one key). `answers` answer the questions the keys ask, in order: typed questions take the answer and RET, and questions read by a key take its first letter, a control character as its key (`"\r"` for RET, `"\u0003"` for C-c), as Org's fast tag selection reads them. `today`, as `"2026-11-04"`, fixes the day for Org (`org-today`) and its clock at noon that day, or with a time, as `"2026-11-04 09:07"`, at that time, as E8's `e8--today` does, so logged times compare: Org's own `org-current-time` works from it, rounding it as `org-timestamp-rounding-minutes` and `org-clock-rounding-minutes` say, and `org-current-effective-time` from that; the ranges of clock tables and a running clock's time count from that noon too, and with `timestamp_now: true` so does `org-timestamp-to-now`, which the agenda's `org-agenda-todo-ignore-` options compare with, and clock tables' captions and the `ARCHIVE_TIME` and date tree of Org's archiving commands are stamped with it, and an iCalendar export's `DTSTAMP` is that day and time written as UTC, whatever the zone, so a calendar compares on every machine. Org's notifications, as a clock running past its effort, go to the echo area, as batch Emacs has no D-Bus, and a clock a case leaves running, and the clock's history, do not reach the next case. `capf` is a list of strings a function on `completion-at-point-functions` offers for the word at point, and `completions: true` compares the text of `*Completions*` when a window shows it; record.el lets `completion-in-region--postch` run after each key, as it does when a person types them, though the case's keys all wait in `unread-command-events`.

2. Record what Emacs does:

   ```bash
   emacs -Q --batch -l tests/emacs/record.el
   ```

   `E8_ORACLE_ONLY=filling` records only the case files whose names have it.

   record.el clears oc-basic's bibliography caches between cases, as Org fails exporting citations a second time in one session with the text or note style ("No location found to insert node"). The reset does not cover every such failure: a bibliography entry with no author, cited in one case, can still break a later case's export in the same session. No `org-cite.json` case is affected; a new citation case that fails only when recorded with the others is likely this.

   Cases you are only trying, as a review does, go in a file whose name starts `zz-`, as `zz-review-dates.json`: a run without `E8_ORACLE_ONLY` leaves it out, so a `make check` running meanwhile is not failed by it, and git ignores it. Record and compare it with `E8_ORACLE_ONLY=zz-review-dates`, and delete it and its golden when done.

3. Run `cargo test -p e8-script --test emacs`. If E8 differs and the fix is not part of the current work, add the case to `known-gaps.txt` with a reason.

The test fails if a case is missing from the golden files, if a case changed since it was recorded, if E8 differs on a case that is not a known gap, or if a known gap starts matching. Each failure names the case and says what to do.

## How cases run

Each case starts in a fresh Fundamental mode buffer named `*e8-oracle*`, with no mark and an empty kill ring, and with `transient-mark-mode` and `shift-select-mode` on, as in interactive Emacs. Once the modes are on, the buffer is fontified, as redisplay would fontify it.

Batch Emacs runs every case in one session, where E8 starts each afresh, so `record.el` puts back before each case what an earlier one could leave behind: the other buffers, an empty `*scratch*` and `*Messages*`, the coding systems `prefer-coding-system` changes, `dired-x` unloaded, the frame's size (waiting for batch Emacs to apply it), and Org's global leftovers, as a running clock, stored links, an agenda restriction lock, the parser's syntax after `org-element-update-syntax`, the note a repeating entry left to show and whether the last date read had a time. A case file recorded on its own and in a run of them all gives the same golden file; when it does not, an earlier file left something behind, and the reset belongs in `e8-oracle--run-1`.

Besides the text, point, mark, kill ring and first error, each case records the text left visible: the buffer without its invisible characters, fontified again at the end. That is how folding and org's hidden link brackets are checked. The keys are typed into Emacs's real command loop, not run as a keyboard macro. An error shows its message and the next key still runs, just as when a person types, and keyboard macros can be recorded and replayed. E8's test types the keys the same way.

## Limits of batch mode

Batch Emacs has no window system, so some keys act as they would on a terminal rather than in GUI Emacs:

- `<delete>` is translated to `DEL`, so it deletes backwards. GUI Emacs, and E8, delete forwards. Don't write cases with `<delete>`.
- The minibuffer reads from standard input in batch mode, not from the typed keys. record.el answers minibuffer reads and questions from the case's `answers` instead; a case that prompts with no answer left records the error "Minibuffer read in batch". A command whose interactive spec is a string of `s`, `p` and `P` codes, as `org-occur`'s, has its arguments read by record.el through `read-string`, as `call-interactively` reads an `s` in C, out of the answers' reach. Commands can also be given their arguments with `call`. E8's own tests cover typing in the minibuffer, and `icomplete/` compares completion there (see below).
- Batch Emacs does not auto-save after visiting a file, and killing a modified buffer does not ask; record.el turns auto-saving on as interactive Emacs does, but cases cannot check kill-buffer's question. E8's own tests cover it.
- `C-g` typed as a key makes batch Emacs wait forever too, so cases cannot quit isearch or query-replace with it.
- `this-single-command-keys` sees only the last key of a sequence in batch mode, so commands that look at it act differently. In particular `C-x e` installs no repeat key, so `C-x e e` cannot be recorded. E8's own tests cover it.
- The window is 80 columns by 24 lines. Splitting and selecting windows works, so window cases can check each window's point, but leave scrolling to E8's own tests. Each case starts with a window that has shown no other buffer, and with `*Messages*` and `*scratch*` after the case's buffer in the buffer list, in both editors, for `previous-buffer` and `kill-buffer` to fall back on. What `*Messages*` holds differs between them, so a case that ends there compares only which windows show it.
- Text is not laid out, so `C-n` moves by lines of text even where long lines would wrap, and `word-wrap` has no effect. E8's own tests cover line wrapping.
- Nothing is fontified while the keys run, since there is no redisplay; E8's oracle test does not redisplay either. Link brackets typed by a case are hidden only in its final visible text.
- Display, faces and the mouse are invisible to the oracle, apart from the visible text. E8's own tests and the GUI's snapshot tests cover those.

Golden files record the Emacs version and platform. Emacs on macOS binds `<home>` and `<end>` to the ends of the buffer, and so does E8 on macOS; cases like that are marked `"platform": "darwin"`.

## Fuzzing org-mode

`crates/e8-script/tests/org_fuzz.rs` looks for differences instead of checking known ones. It writes random Org documents with headings, TODO states, lists, checkboxes, tables, timestamps, drawers, blocks, comments and links. It then types random keys into them: Org's, motion, typing, and editing keys such as yank, kill, undo and transposing. It records what Emacs does through record.el, with `E8_ORACLE_DIR` pointing it at a scratch directory, and runs the same cases through E8. Each case that differs is shrunk, a key or a line at a time, to a small one that still differs in the same way. It needs Emacs, so it only runs when asked:

```bash
E8_FUZZ_SEED=1 E8_FUZZ_CASES=2000 cargo test --release -p e8-script --test org_fuzz behaves -- --ignored --nocapture
```

A seed repeats a run. The shrunk cases are printed and written to `target/org-fuzz/differences.json`, and `E8_FUZZ_REPLAY` replays such a file without shrinking:

```bash
cargo test --release -p e8-script --test org_fuzz replays -- --ignored --nocapture
```

Turn the ones worth fixing into cases in a `cases/org-fuzz-*.json` file, so they stay fixed. Some cases are left out of the comparison:

- **Prompts.** A command that would prompt is an error in the recorder.
- **Hangs.** Org can loop forever, so recording has a time limit. A run that takes too long is split until the case that hangs is left out.
- **Clock times.** The minute of a logged time can differ because Emacs runs first, so it is ignored.
- **Malformed timestamps.** A case where Org fails with "Not an Org time string" is left out. Org fails like that in nearly any command in the entry, and E8 only where it parses the timestamp.
- **Emacs's own failures.** A case where Emacs fails with "Wrong type argument", a bug in its Lisp such as `org-narrow-to-element` on an empty item, is left out.
- **Long lines.** Batch Emacs does not wrap long lines, so a case that moves with `C-n` or `C-p` over a line 80 columns wide or more is left out.
- **Leaving the directory.** A case whose result names a place outside its own directory, as after Dired's `^`, is left out, as the directories around it differ between the two runs.

`dired_behaves_like_emacs_on_random_cases` types random Dired keys over random directories. `compares_a_recorded_run`, with `E8_FUZZ_RUN=target/dired-fuzz/run`, compares E8 again with a run Emacs recorded, without recording it again.

`plain_editing_behaves_like_emacs_on_random_cases` does the same for editing outside any mode: motion, killing, yanking, the mark, undo, transposing and prefix arguments in random text. Its differences go in `cases/editing-fuzz.json`. `filling_behaves_like_emacs_on_random_cases` fills random paragraphs with prefixes at random fill columns and types with Auto Fill mode on; `electric_pair_behaves_like_emacs_on_random_cases` types parens, quotes and sexp commands with Electric Pair mode on. The fuzzers work in their own directories under `target/`, and each gives record.el its own place for a case's files in `E8_ORACLE_FILES`, so run one at a time with its full name, or several at once.

record.el also makes opening a link in a browser or another program an error, so a case cannot start one.

## Regular expressions

`crates/e8-script/tests/regexp.rs` compares E8's regexp engine with Emacs's `string-match` and `re-search-backward`. `recorded_cases_match_emacs` checks the cases in `regexps.json`, with what Emacs gave, on every run. `regexps_behave_like_emacs_on_random_cases` makes random regexps and strings, records what Emacs makes of them through `regexp.el`, and prints where E8 differs, writing those to `target/regexp-fuzz/differences.json` in the form of `regexps.json`, where the ones worth keeping go:

```bash
E8_FUZZ_SEED=1 E8_FUZZ_CASES=20000 cargo test --release -p e8-script --test regexp -- --ignored --nocapture
```

## Calc

Org's table formulas are worked out by a part of Calc written in TypeScript (`packages/calc.ts`, [ADR 0115](../../docs/adr/0115-table-formulas-on-a-part-of-calc.md)). `calc/cases.json` lists formulas, each with the Calc modes that change Org's `org-calc-default-modes` for it, as a plist, and `"num"` for the separator Org's `N` flag passes; `emacs -Q --batch -l tests/emacs/calc/record.el` records what Emacs's `calc-eval` gives for each in `calc/golden.json`, and `cargo nextest run -p e8-script --test all calc::` compares. Only that a formula is an error is compared, not Calc's message, as Org writes `#ERROR` for any. `calc/known-gaps.txt` names the formulas E8 does not work out as Calc does, with why.

## Images

Batch Emacs and Emacs on a terminal cannot load images, so `images.el` runs a graphical Emacs for a moment and records what it answers about the test images in `crates/e8-core/tests/images/`: `image-size` with each property, masks, metadata, `imagep`, and the line heights and positions of a buffer of images, into `target/image-answers.el`. The tests in `crates/e8-core/tests/images.rs` and `crates/e8-script/tests/images.rs` hold those answers, with metrics matching the frame's font (Menlo at 12 pixels on macOS):

```bash
emacs -Q -l $PWD/tests/emacs/images.el
```

## The agenda's entry text

Entry text mode (`E` in the agenda) puts each entry's text in an overlay's `after-string` under its line, which the cases do not record. `entry-text/dump.el` makes an agenda of `entry-text/tasks.org`, turns entry text mode on and prints each line with the text under it, one JSON list a line; the `.jsonl` files there are its output for a few settings, and `org_agenda_entry_text` in `crates/e8-script/tests/all/` compares E8 with them. After changing `tasks.org`, record them again:

```bash
cd tests/emacs/entry-text && emacs -Q --batch -l dump.el tasks.org 5 > maxlines-5.jsonl && emacs -Q --batch -l dump.el tasks.org 2 > maxlines-2.jsonl && emacs -Q --batch -l dump.el tasks.org 3 "|> " > leader.jsonl && emacs -Q --batch -l dump.el tasks.org 5 "" 'first\|seven\|^.*two$\|^#' > exclude.jsonl
```

## Bidirectional text

`bidi/` holds an oracle for how Emacs shows bidirectional text, which batch Emacs cannot, as it has no window to reorder for. `bidi/record.el` runs an interactive Emacs inside tmux, whose screen it reads with `tmux capture-pane`, and records for each case in `cases.json` the window's lines, `bidi-resolved-levels` of each, where each position shows, `move-point-visually` both ways from each position, `current-bidi-paragraph-direction` and `bidi-find-overridden-directionality` into `golden.json`:

```bash
cd tests/emacs/bidi && tmux new-session -d -x 40 -y 16 "emacs -Q -nw -l $PWD/record.el"
```

It writes `golden.json` and exits after a minute or two. `cargo test -p e8-script --test bidi` compares E8 with it; `KNOWN` there lists the few places E8 differs, and where tmux shows a cell other than Emacs drew. `bidi-data.el`, run in batch, writes the bidi tables E8 reorders with into `crates/e8-core/src/bidi_data.rs`.

## Completion in the minibuffer

`icomplete/` holds an oracle of its own for what the minibuffer shows as you type: icomplete's list in its four modes, over a collection or a directory of files. Batch Emacs cannot type into the minibuffer, so `icomplete/record.el` runs an interactive Emacs on a pseudo-terminal, feeds it each case's keys from timers, and records the input and what icomplete shows after each key into `golden.json`:

```bash
cd tests/emacs/icomplete && script -q /dev/null emacs -Q -nw -l $PWD/record.el
```

`cargo test -p e8-script --test icomplete` compares E8 with it, and `icomplete_behaves_like_emacs_on_random_cases`, ignored by default, makes random cases with `E8_FUZZ_SEED` and `E8_FUZZ_CASES`, records them and prints where E8 differs, writing them to `target/tmp/icomplete-fuzz/differences.json`.

## Ports of packages Emacs does not ship

The oracles for vertico, orderless, marginalia and Magit moved with the ports, into the `test/` of [e8-vertico](https://github.com/e8-editor/e8-vertico), [e8-orderless](https://github.com/e8-editor/e8-orderless), [e8-marginalia](https://github.com/e8-editor/e8-marginalia) and [e8-magit](https://github.com/e8-editor/e8-magit): each has its recorder, `record.el` or `annotations.el`, its recorded JSON, and ERT tests that replay the cases in E8. The `Ports` job in `.github/workflows/test.yml` runs them against `main`.

## Parity and demand

`parity.py` counts the primitives Emacs writes in C that E8 has by name. `demand.py` weighs the missing ones by how much Emacs Lisp calls them: it reads a corpus (Emacs's own Lisp, MELPA's most downloaded packages fetched with `demand.py fetch`, and a configuration's packages) as forms with batch Emacs and `demand.el`, and joins the counts with what E8 has, by name and through `demand-other-names.json`, grouping the missing ones as `demand-groups.json` says. Its docstring says how to run it; [docs/parity/demand.md](../../docs/parity/demand.md) is the result. Keep the corpus outside the repository.
