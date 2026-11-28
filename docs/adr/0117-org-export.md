# 0117. Org export: ox.el and its ASCII, HTML and Markdown backends in TypeScript

Status: accepted · 2026-11-27

## Context

Org's export (`C-c C-e`) was the largest part of Org E8 did not have: `docs/plan.md` left it "for later", and every other missing package (Info, man, LaTeX mode, ps-print, mail) unlocks less. Export is `ox.el`, a generic engine of about 7,500 lines, and a backend per format: `ox-ascii.el` (2,200), `ox-html.el` (4,100) and `ox-md.el` (800), the three that need no other program. Every backend walks Org's full syntax tree, elements and objects, as `org-element-parse-buffer` returns it, which E8 did not have either: its `org-element.ts` parses only the elements its editing commands move.

Export must not bring Lisp in ([ADR 0116](0116-e8-has-no-lisp.md)): Org reads `#+OPTIONS:` values and `#+BIND:` keywords with `read`, macros may be `(eval ...)`, and Babel runs code blocks on export.

## Options considered

1. **Port ox.el and the backends as they are, in TypeScript, with a full parser.** Output that matches Emacs's character for character, checked by the oracle; user filters, derived backends and options work as Org documents them. A large port, and a second parser beside the editing one.
2. **Export through a separate tool, such as pandoc.** Less code, but different output, no Org options, filters or backends of one's own, and a program to install.
3. **A smaller exporter of E8's own design.** Simpler, but every Org user's export options, macros and customisations would differ, as `docs/departures.md` keeps such ideas for later.

## Decision

Option 1. `org-element-ast.ts` holds the tree, its nodes Org's types with Org's property names and plain text as strings; `org-element.ts` gains `parseBuffer`, `parseSecondaryString` and Org's interpreters beside the editing parse; `ox.ts` is the engine, with `org-macro.ts` and `ob-exp.ts` for macros and Babel on export, and `ox-ascii.ts`, `ox-html.ts` and `ox-md.ts` the backends. They load when an export command is first used, from stubs in the preloaded `org-loaddefs.ts`, as Emacs autoloads them, so startup does not pay for them.

Values written as Lisp data, in `#+OPTIONS:` (`d:(not "LOGBOOK")`, `^:{}`) and `#+BIND:`, are read by a reader of data that evaluates nothing. A `#+MACRO:` defined as `(eval ...)` is an error when expanded. Babel on export runs only what E8 runs, TypeScript blocks; inline source blocks and `#+CALL:` lines are exported as their code or left out.

## Consequences

- `C-c C-e` offers plain text (ASCII, Latin-1, UTF-8), HTML and Markdown, to a buffer or a file, for the buffer, the region, a subtree, visible text or the body only; `#+OPTIONS:`, `#+TITLE:` and the other keywords, `EXPORT_` properties, `#+INCLUDE:`, macros, select and exclude tags, footnotes, tables of contents, internal links and the user's filters work as in Org, apart from what `docs/differences.md` lists under Org export.
- The oracle compares whole exported documents with Emacs's (`tests/emacs/cases/org-export.json`). Org names references at random (`org1a2b3c4`); record.el and E8's oracle both number them from 1, through `e8--export-sequential-references`.
- Exports run in the foreground: the async option is accepted and ignored, and the export stack is empty. Publishing (`ox-publish.el`) is not ported yet, nor the other backends (LaTeX, ODT, Texinfo, man, Beamer). The iCalendar backend, `ox-icalendar.ts`, followed as a backend derived from plain text, as Org has it; diary sexps, being Lisp, make no events.
- HTML source blocks were at first not fontified, as Emacs's are not without htmlize; `htmlize.ts` now colours them from E8's faces, as Org does with htmlize. MathJax is written as Org writes it, and LaTeX converted to images is not supported.
- A second parser is code to keep in step with the editing one; their element boundaries are compared with Emacs by their own oracles, the full parser's in `tests/emacs/org-element/`.

## Dependencies introduced

None.
