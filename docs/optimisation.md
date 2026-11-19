# Optimisation

The aim is for E8 to be faster than Emacs in every situation, not only in most. [performance.md](performance.md) records what has been measured and changed; this document lists where E8 is known to be slower than it could be, or than Emacs, and what would make it faster. Each entry says how it was measured, so it can be measured again before and after.

Two rules carry over from the work so far. Measure first: a change goes in with the numbers it moved. And a faster path must give the same results as the path it stands in for, checked the way the slower one is checked (by the Emacs oracle, a fuzzer or the recorded cases), so speed never costs behaving like Emacs.

## Regular expressions: an automaton beside the backtracking matcher

**Now.** Emacs regexps are matched by E8's own engine, a backtracking machine as Emacs's regex-emacs.c is ([ADR 0027](adr/0027-emacs-regexps.md)), which tries each start position in turn, skipping those whose first character cannot start a match. Failing searches over 10 MB of text, measured with `regexp_searches_over_a_large_buffer_are_fast` in `crates/e8-script/tests/regexp.rs` against Emacs 30.2 on the same text:

| Regexp | E8 | Emacs |
| --- | ---: | ---: |
| `\<zzz\>` | 70 ms | 39 ms |
| `^\* q` | 78 ms | 30 ms |
| `[0-9]+x` | 161 ms | 90 ms |
| `\w+qq` | 879 ms | 611 ms |

Like Emacs's, the matcher takes exponential time on some expressions: `\(x+x+\)+y` on a line of x's takes seconds in both, so a mistyped `C-M-s` can stop the editor until it gives up.

**Idea.** A lazy DFA or a one-pass automaton, from the `regex-automata` crate that `regex` already brings in, checks each character once: failing searches would take a few milliseconds, and no expression would take exponential time. An automaton that keeps the priority of alternatives, as the crate's leftmost-first mode does, finds the same match and the same groups as a backtracking matcher for any regexp it can express, so it can stand in for the engine where:

- the regexp has no back-references and no `\=`;
- the buffer has no `syntax-table` text properties in effect (`parse-sexp-lookup-properties` off), so each syntax class (`\w`, `\sC`, `[:space:]`, `[:word:]`, `[:punct:]`) is a fixed set of characters, worked out from the buffer's syntax table when the regexp is compiled, and the compiled automaton is kept per regexp and syntax table;
- word and symbol boundaries (`\b`, `\<`, `\>`, `\_<`, `\_>`) are look-arounds the automaton supports over those sets, which includes Emacs's boundaries between scripts only if they are expressed as character sets too, or else such regexps stay with the engine;
- Emacs's own departures are kept: a loop that matches nothing ends, `\{N,M\}` is a loop that a matching-nothing iteration ends, and a `*` or `+` loop of non-words or non-symbols before `\_<` never gives characters back. Where these change what matches, the automaton finds where a match can start and the engine finds the match there.

Everything else stays with the engine. The regexp fuzzer compares the two on every case, and the speed test above gains E8-only rows for the automaton.

**A literal prefix.** Before that, a smaller step: a regexp that starts with literal text, as isearch's lax whitespace makes of any string with a space (`lazy\(?:[ \t]+\)cat`), could find that text with the literal search, which reads the buffer far faster than the fastmap's character at a time, and run the machine only there. A failing `lazy cat` over 21 MB took 200 ms as a regexp in a release build, 22 ms as literal text, and 85 ms in Emacs with `search-spaces-regexp`. isearch.ts does this itself for now (`laxLiteral`), handing over to the engine after 2,000 places that fail, where the text is everywhere.

## Electric Pair mode in a large buffer

Typing `(` then `)` with Electric Pair and Show Paren mode on took about 1.9 s a key in a 100 MB text file, as elec-pair.el scans the buffer to its end to check the balance; since 2026-11-01 the scan passes plain text a run at a time and it takes 270 ms ([performance.md](performance.md)). Being faster still means not scanning: keeping the balance from `syntax-ppss`'s cached states, or summarising each chunk of the text's parens as the rope keeps its line counts.

## Org's headings after each change

Org keeps an index of its headings from its after-change hook since 2026-11-01, and since 2026-11-02 moves the headings after an edit only when they are read, as Org's element cache does ([performance.md](performance.md)): RET at a heading takes 2.3 ms in the 50,000-line file, against Emacs's 1.9, and `C-c C-t` 3.1, against 5.5. What is left: a command that asks for every heading, through `headings()` or `backToHeading`, moves every heading after the last edit, a pass over thousands; most commands want only those around point, and could read them as the element parser does (`headingsAsRead`) once each is checked not to hold the list across its own edits. S-TAB, 25 ms, is interpreting Org's folding, half of it QuickJS's regexp matcher.

## Indenting a region in Org

`org-indent-region`, which `TAB` with the region active runs, and `C-M-\` since `indent-region` calls `indent-region-function` (2026-11-07), keeps its parse through the indentation it changes, rather than parsing again after each line. Until 2026-11-07 it moved every element after each change and found each child by a scan, so indenting a section cost the square of its length: 4,000 paragraphs took 20.8 s on QuickJS and 2.5 s on V8. Since then a change defers the shift it owes the elements after it to their parent, which an element takes when it is next looked at, and children are found by binary search: 2.35 s on QuickJS, 2.1 s on V8, each growing with the section, against Emacs 30.2's 341 ms. Measured with a section of N paragraphs, `   paragraph I` and a blank line each, under one heading, `M-< C-SPC M-> TAB` in `e8 --batch` (`indenting_a_long_section_keeps_its_parse` uses 2,000), and `indent-region` in `emacs -Q --batch`.

What is left, about 0.5 ms a paragraph: each element's indentation asks for the element at the line and the one before it through `elementAt`, which works out the heading's branch, its key string and the buffer's modification count again each time, and `expectedIndent` reads line texts through the API a call at a time. Asking once per element, and reading the lines it needs together, should come near Emacs.

## Opening a large file

`find-file` of the 100 MB text file takes 65 ms (`large_text_file` in the bench, [performance.md](performance.md)). A profile of it repeated (`E8_PROFILE_KEY=find-file E8_PROFILE_FILE=text` with `profile_key`) puts most of it in ropey building the rope, copying the text into its leaves. Of the rest, the bytes are checked as UTF-8 twice, once by `coding::detect` and again by `decode_as`, and then copied into a `String` the rope copies again: about 15% of the time. Decoding from the `Vec` the file was read into, `String::from_utf8` taking it without a copy, and detection handing on what it found, would save both; it means passing owned bytes through `decode`'s callers.

## Character tables

Classes, categories, scripts and case past ASCII are binary searches in sorted runs (`chartab_data.rs`). Two-level tables indexed by code point, as Emacs's char-tables are, would make each lookup a pair of array reads. Worth doing when a profile shows the searches; none has yet.

## Moving through rows in the GUI

With the GUI's metrics, rows built for moving point (`C-n` over continued lines, keeping point in sight) work out their faces, as their wrapping depends on the fonts, where with cells they need none. That is most of what `C-n` costs over the terminal: 0.75 ms a key against 0.42 in a 50,000-line Org file, and 0.98 ms in `variable-pitch-mode` (`gui_layout` in the bench, [performance.md](performance.md)). A buffer whose rows have all been on the grid could skip the faces until a face with another height or a proportional family is in effect, or rows' measured widths could be kept per line between keys until the text or faces there change, as Emacs's glyph matrices are.

Later on 2026-10-31, rows off the grid cost 0.1 to 0.2 ms a key more than in the table above: `C-n` 0.93 ms with `text-scale-adjust` twice against 0.79, and in `variable-pitch-mode` `C-v` 3.38 ms against 3.17 and `C-n` 1.12 against 0.99. Running `gui_layout` on each commit of that day put the rise before images, bidirectional text and the fringe indicators: at `6f8f6e7`, faces with Emacs's attributes and the GUI's fringes, `variable-pitch-mode` already took 3.44 and 1.16 ms, and the merges after it moved nothing beyond noise. So the cost is in resolving faces' extra attributes or in the fringes' extra column for rows off the grid, and a profile of `C-n` in `variable-pitch-mode` should say which.

## Installing packages at startup

**Now.** `e8.usePackage` installs a missing package with `git clone` while init.ts waits, one package after another. Each clone of an `e8-editor` port took about 2 s on 2026-11-07, nearly all of it reaching GitHub: a shallow clone of `e8-magit` took 1.80 s against 1.96 s for a full one. Mark's configuration, fourteen packages, held a first start for about 30 s. Since then the window shows the editor before init.ts runs, and each message as it comes, so progress shows; and on a machine that has `e8-lock.json` but not the packages, the first `usePackage` clones every package the lock file names at once: the fourteen took 2.05 s, the whole of `e8 --batch -l init.ts` with a configuration directory holding only `init.ts` and the lock file. A package named for the first time, which the lock file does not know yet, is still cloned on its own while init.ts waits, and the editor cannot be used until init.ts finishes.

**Idea.** Install in the background, as elpaca does for Emacs: `usePackage` starts a missing package's clone and returns at once, and what the configuration does with the package goes in a callback that runs once it is installed and required, as use-package's `:config` does:

```ts
e8.usePackage("e8-editor/e8-magit", {
  config() {
    e8.defineKey("magit-section-mode-map", "C-a", "magit-section-up");
  },
});
```

init.ts would finish in well under a second, every missing package cloning at once; E8's own commands would work meanwhile, each package turning on as it arrived, with a buffer listing the queue, as elpaca's does. A package waits for those it `requires`, and one that fails says so without stopping the rest. A configuration written as today's, settings after the call, keeps working for packages already installed; for a missing one it needs the callback, so this wants an ADR deciding whether `usePackage` without `config` waits, as now, or defers. Measured with the same command as above, with an empty lock file so nothing is known in advance.
