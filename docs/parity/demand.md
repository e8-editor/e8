# Which missing primitives matter

[plan.md](../plan.md) counts the primitives Emacs writes in C that E8 has by name: 404 of 877 editor primitives on 2026-11-11. That count says nothing of which missing ones matter. This page weighs them by demand: how much Emacs Lisp in real use calls each, so the next stretch of Rust core work can be chosen from it. It was measured on 2026-11-11 against Emacs 30.2 and E8 at 0.5.7.

`tests/emacs/demand.py` makes every number here again; its docstring says how. `count` reads a corpus with batch Emacs and writes `counts.json`; `report` joins it with what E8 has now and prints the tables below, so after E8 gains a primitive only `report` needs running again.

## Method

**Reading.** Each file is read as forms by Emacs's own reader (`tests/emacs/demand.el`), never grepped, so a name in a string or a comment is not a call. The libraries that ship with Emacs which a file requires are loaded, and each form is macroexpanded with the macros Emacs defines, so `with-current-buffer` counts as the `save-current-buffer` and `set-buffer` it expands to. A call is a symbol at the head of a form in the expanded code, a `#'name`, or a quoted name in the function position of `funcall`, `apply`, `mapcar`, `add-hook`, `advice-add` and the like. The package's own code is never run: `load-path` holds only Emacs's directories, the package's own macros are not defined (a use of one reads as a call and its arguments as code), and the macros that evaluate their arguments while expanding (`eval-when-compile`, `eval-and-compile`, `cl-macrolet`, `static-if`, `rx` and their kin) are replaced by `progn`. 306 of the corpus's forms could not be expanded (mostly accessors of a package's own `cl-defstruct`, which is not evaluated); those are read without expansion, every head a call.

**Wrappers.** A primitive is also needed by a package that uses a macro Emacs defines, or a function of `subr.el` or `subr-x.el`, that calls it, when E8 lacks that wrapper by name too: `remove-overlays` needs `overlay-buffer` and `overlay-properties`. What a macro brings is found by expanding a few of its uses on their own and keeping the calls every one of them adds; calls a macro E8 has brings (`with-current-buffer`'s `set-buffer`) are not counted against the primitive. The wrappers are resolved three levels deep. Functions in the rest of Emacs's Lisp are not followed: a package calling `url-retrieve` is not counted as needing TLS.

**Joining with E8.** `parity.py`'s matching by name is the start: E8's commands, its script functions in `packages/e8.d.ts` (camelCase read as kebab-case), e8-core's public functions, and the functions packages define with `e8.defun` or export (newly counted). The 200 or so most needed "missing" names were then checked by hand against `crates/e8-core`, `crates/e8-script/src/natives/` and `packages/`, and the 104 E8 has otherwise are recorded in `tests/emacs/demand-other-names.json`, each as one of:

- `other` (44): E8 has it under another name, as `e8.bufferModified` for `buffer-modified-p`, `e8.reSearchForward` for `search-forward-regexp`, `e8.withCurrentBuffer` for `set-buffer`;
- `derived` (35): no function, but a line of E8's API does it, as `e8.point() === e8.pointMax()` for `eobp`; these are listed in their own table below;
- `replaced` (21): E8 does it another way by design, as commands' typed parameters for `interactive`, template strings for `format`, keys as strings for `key-description`;
- `internal` (4): reached only inside one wrapper, as `match-data--translate` inside `replace-regexp-in-string`; the demand is the wrapper's.

The Lisp language's own primitives (data.c, fns.c, eval.c and the rest, as `parity.py` sorts them) are left out, as TypeScript stands in for them. Platform primitives (TLS, SQLite, libxml, menus, the terminal, the macOS front end) are counted, and marked.

**Score.** For each primitive, the share of each corpus's packages that need it, directly or through a wrapper, summed with weights 1 for Emacs's Lisp, 1 for MELPA and 2 for the third corpus, as that is what is used every day. A score of 1 means, for instance, every package of one corpus, or a quarter of each and of the third. Packages count, not call sites: a primitive one package calls 500 times blocks one package. Call sites are in the tables too.

**Groups.** Each missing primitive is put in a piece of work that would land together (`tests/emacs/demand-groups.json`, by C file, then by hand), scored in the same way by the packages that need any of its primitives.

## Corpus

Three parts, kept apart in every table.

- **emacs**: the Lisp that ships with Emacs 30.2 for what E8 has or plainly wants, in 49 packages as a user would name them (`EMACS_UNITS` in the script): `subr`, `simple`, `files`, `window` (with `frame.el`, `windmove`, `winner`, `tab-bar`, `tab-line`), `minibuffer` (with icomplete), `isearch` and `replace`, help and Info, the buffer menus, Dired, font-lock and its kin, the editing helpers (`electric`, `abbrev`, `dabbrev`, `thingatpt`, `imenu`, `outline`, `kmacro`, `bookmark`), the text modes and Ispell, `comint` and `shell`, `term`, Eshell, `compile`, `grep` and `gud`, `project`, `xref`, `eglot`, `flymake`, `eldoc`, `diff-mode`, Ediff, VC, Tramp, Org, the calendar, tree-sitter and its modes, the programming modes, CC mode, EWW and shr, `url`, `network-stream` and `gnutls.el`, auth-source and EPA, `server`, `package` and `use-package`, ERT, Edebug, `which-key`, `transient`, images, the mouse, Customize, Gnus, ERC, `proced`, `desktop`, `speedbar` and Calc. 672 files.
- **melpa**: MELPA's 300 most downloaded packages by its `download_counts.json` on 2026-11-11, fetched with `demand.py fetch` into a directory outside the repository. Five whose files state no licence, or one this work may not read without asking (evil-mc, haml-mode, password-generator, py-isort, sass-mode), were not read; 295 were. 1,603 files.
- **daily**: the 77 packages one person's Emacs configuration loads, its own and their dependencies, with the libraries shipped with Emacs it turns on, weighted double. Only counts are reported for it; the packages are not named here. 797 files.

Tests, `-pkg.el`, autoloads and loaddefs files are left out everywhere.

## What the numbers say

Of the 877 editor primitives, 404 have Emacs's name in E8 and 104 more are had otherwise, which leaves about 370 truly missing. Of those, 266 editor and 77 platform primitives are needed by at least one package of the corpus; 110 editor primitives are needed by none and can be left (listed at the end).

The missing primitives matter less than the 46% suggests. 122 of the 295 MELPA packages need no missing primitive at all, nor do 18 of the 77 daily ones, and half of MELPA's need one or none. Emacs's own Lisp is the hungriest: all but one of its 49 packages need something, because it holds the code that implements windows, frames and the rest on top of C.

The demand is concentrated. The top of the ranking is accessors over things E8 already has but does not hand to scripts: the current local and global keymaps, the standard syntax table, an overlay's buffer and properties, a process's filter and sentinel set after it starts, a marker's insertion type. Each is small, and together they are most of what stands between the commonest packages and E8. Larger pieces, windows as Emacs's window.el sees them and frames as GUI windows, come next, needed by about a tenth of packages each, most of all by Emacs's own Lisp. TLS, SQLite, XML and xwidgets come low, but TLS's demand is understated (see the limits).

## After the small groups

The one-liners, keymaps, syntax tables, overlays and the buffer and text primitives landed on 2026-11-11 (e8-editor/e8 pull requests 87 to 91), and `parity.py` now also counts the functions packages export as constants. Measured again on the same corpus:

- **By name**, 467 of the 877 editor primitives (53%), from 404; with the 73 had otherwise in `demand-other-names.json`, about 540.
- **Packages needing nothing missing**: 176 of 295 MELPA packages, from 122; 36 of 77 daily ones, from 18; 2 of Emacs's 49, from 1. Over half of MELPA's top packages now need no missing primitive at all.
- **Still needed** by at least one package: 234 editor and 77 platform primitives, from 266 and 77; 109 editor primitives are needed by nothing.
- **What was left out** of each group: `keymap-prompt` (keymaps carry no prompt), the help internals `describe-buffer-bindings`, `describe-vector`, `help--describe-vector`, `keymap--get-keyelt` and `internal-describe-syntax-value`, `map-keymap-internal` (`keymapBindings` stands in), `buffer-last-name`, `buffer-swap-text` and `marker-last-position`, and `windowp` and `framep`, which cannot be told apart from numbers; none scores above 0.1.

The ranking is now led by the larger pieces. `window-frame` is the most needed missing primitive (34 Emacs, 30 MELPA and 12 daily packages), then `set-process-sentinel` and `set-process-filter` after a process starts, `set-window-hscroll`, `make-frame-visible` and `call-process-region`. By group: the window tree (1.29), frames (1.25), processes as values (1.22, and all that 30 MELPA packages lack, among them markdown-mode, async, request, web-mode and rust-mode), scrolling and screen lines (1.08), then files (0.64), the user and the system, mouse events, TLS and menus.

## Groups of work, in order (first measurement)

Ordered by score, with a size: small is days, medium a week or two, large more. The table further down has the counts.

1. **Keymaps as values** (small; score 2.18). `current-local-map` is the most needed missing primitive (40 Emacs, 75 MELPA, 34 daily packages), then `current-global-map` and `copy-keymap`, `use-global-map`, `keymap-prompt`, `accessible-keymaps`, `describe-buffer-bindings`. E8 has keymaps; scripts cannot get the current ones as objects. Unblocks on its own hydra, evil-surround, helm-descbinds, move-text and lorem-ipsum, and `local-set-key`, `global-set-key` and `global-key-binding` everywhere.
2. **Syntax tables as values** (small; 1.61). `standard-syntax-table` (60 MELPA packages, mostly to build a mode's table from it), `string-to-syntax`, `copy-syntax-table`, `syntax-table-p`. E8 has syntax tables by name; this is a getter, a copy and the descriptor parser. Unblocks hl-todo. Plan item 5 already lists "syntax tables as char-tables".
3. **Window objects and the window tree** (large; 1.29). Led by `window-frame` (34 Emacs, 30 MELPA packages), then `window-list-1`, `window-parent`, `window-*-sibling`, `frame-first-window`, pixel edges and sizes, line heights, `window-configuration-frame`, and the resize protocol window.el is written on (`window-new-total`, `window-resize-apply` and the rest). Needed most by Emacs's own window.el and its users; on its own it unblocks popwin, ace-link, page-break-lines.
4. **Frames as the GUI's windows** (large; 1.25). `make-frame-visible`, `raise-frame`, `frame-visible-p`, `frame-char-height`, `window-system`, `frame-parent`, `next-frame`, `visible-frame-list`, focus, sizes in characters and pixels, and terminals. Much of the demand is `with-output-to-temp-buffer` and `posn-col-row`. Unblocks powerline, org-download.
5. **Processes as values** (medium; 1.22). `set-process-sentinel` and `set-process-filter` (38 and 28 MELPA packages) once a process has started, `process-filter`, `process-sentinel`, `process-plist`, `call-process-region`, `make-pipe-process`, `process-attributes`, `list-system-processes`. E8 names processes by strings and fixes the filter at `e8.makeProcess`. The group that unblocks most packages on its own: 14, among them request, pfuture, simple-httpd, deferred and websocket.
6. **Buffer and text primitives left** (small; 1.19). `set-marker-insertion-type`, `buffer-local-variables`, `buffer-chars-modified-tick`, `current-message`, `position-bytes`, `replace-buffer-contents`, `transpose-regions`. Unblocks aggressive-indent, paredit.
7. **Scrolling and screen lines** (medium; 1.08). `set-window-hscroll` and `window-hscroll`, `scroll-left` and `scroll-right`, `set-window-vscroll`, `vertical-motion`, `line-number-display-width`, `window-line-height`, `force-window-update`. Unblocks golden-ratio.
8. **Overlays as values** (small; 1.06). `overlay-buffer`, `overlay-properties`, `overlayp`, `overlay-lists`, `delete-all-overlays`, and `overlay-recenter` as a no-op, which makes `remove-overlays` and `copy-overlay` work. Unblocks 11 MELPA packages on its own, more than any group but processes: macrostep, multiple-cursors, package-lint, auto-highlight-symbol, indent-guide, evil-goggles, emmet-mode.
9. **Files left** (medium; 0.64). `default-file-modes` and `set-default-file-modes` (through `with-file-modes`), `verify-visited-file-modtime`, `directory-files-and-attributes`, `access-file`, `file-name-completion`, file locks for Lisp. Mostly Emacs's own Lisp (Tramp, Eshell, Dired).
10. **The user and the system** (small; 0.55). `user-full-name`, `user-real-login-name`, uids and gids, `daemonp`, `system-users`. Small and mostly for Emacs's own Lisp (VC, Gnus, Org export).

After those: mouse positions and events as values (0.51; `track-mouse`, `mouse-position`, raw key vectors), TLS and compression (0.48), menus and dialogs (0.46; `x-popup-menu`), charsets and codings left, keyboard odds, libxml, the macOS display queries, minibuffer odds, tree-sitter's rest, face and font internals, xwidgets and SQLite.

The 35 one-liners are a piece of their own, smaller than any: giving `eobp`, `bobp`, `bolp`, `eolp`, `erase-buffer`, `buffer-string`, `regexp-quote`, `get-buffer-window`, `window-live-p`, `point-marker`, `copy-marker`, `add-text-properties`, `get-char-property` and the rest Emacs's names in `subr` costs an afternoon and lets ports read like the Lisp they follow. By demand they would rank among the top ten primitives.

## Where the ranking is weak

- **Only one level of Lisp is followed.** Wrappers in `subr.el` and Emacs's macros are; the rest of Emacs's Lisp is not. A package that calls `url-retrieve`, `open-network-stream` or `make-frame` needs what those need, and is not counted. TLS above all is understated: almost nothing calls `gnutls-boot` directly, but every package that fetches over HTTPS needs it.
- **Keyword arguments are not primitives.** Non-blocking connects (`:nowait`), TLS on `make-network-process`, `make-process`'s `:stderr` and `:connection-type`, and `make-frame`'s parameters are arguments to primitives E8 has, so they never show as missing.
- **Having a name is not having the behaviour.** A primitive E8 has by name counts as had, however partial; the hand check looked at whether a counterpart exists, not whether it does everything Emacs's does.
- **Package-defined macros are not expanded.** Their uses read as calls with their arguments as code, so a binding list read as a call adds a little noise, and a primitive used only inside another package's macro (dash's `-let`, for one) is counted where the macro is used only if that package is in the corpus too.
- **Packages, not users.** MELPA's downloads say what is installed, often as a dependency, not what is used; the Emacs part is chosen by hand; the daily part is one person's.
- **The hand check stops at about 200.** Below that, names are matched only as `parity.py` matches them, and a primitive E8 has under another name may still be listed as missing.
- **Scores add shares, not effort.** A group's score says how many packages need it, not how much each needs: `window-frame` alone carries most of the window group's score.
- **"Nearest to hosting" counts primitives and libraries only.** A package needing nothing listed may still need much Lisp E8 has not written, and E8 hosts packages as TypeScript ports, so every one is still a port.

## Results

As measured again after the small groups, with what E8 has on main at that point.

### Missing primitives by demand

Score: the share of each corpus's packages that need the primitive, directly or through a wrapper E8 also lacks, summed with weights emacs 1, melpa 1, daily 2. Each corpus's cell is packages / calls / uses through wrappers; the last column names the wrappers most of those come through.

| # | primitive | C file | score | emacs | melpa | daily | through |
|---|---|---|---|---|---|---|---|
| 1 | `window-frame` | window.c | 1.11 | 34 / 173 / 104 | 30 / 57 / 18 | 12 / 27 / 24 | `with-output-to-temp-buffer`, `posn-col-row` |
| 2 | `set-process-sentinel` | process.c | 0.90 | 21 / 68 / 0 | 38 / 96 / 0 | 13 / 45 / 0 |  |
| 3 | `set-window-hscroll` | window.c | 0.80 | 27 / 29 / 62 | 20 / 13 / 11 | 7 / 12 / 11 | `with-output-to-temp-buffer`, `internal-temp-output-buffer-show` |
| 4 | `set-process-filter` | process.c | 0.69 | 15 / 48 / 0 | 28 / 63 / 0 | 11 / 27 / 0 |  |
| 5 | `make-frame-visible` | frame.c | 0.66 | 25 / 9 / 62 | 13 / 3 / 11 | 4 / 0 / 11 | `with-output-to-temp-buffer`, `internal-temp-output-buffer-show` |
| 6 | `call-process-region` | callproc.c | 0.55 | 15 / 50 / 5 | 12 / 16 / 0 | 8 / 20 / 0 | `call-shell-region` |
| 7 | `window-hscroll` | window.c | 0.44 | 13 / 39 / 0 | 13 / 40 / 0 | 5 / 17 / 0 |  |
| 8 | `zlib-available-p` | decompress.c (platform) | 0.40 | 10 / 4 / 11 | 11 / 0 / 14 | 6 / 3 / 7 | `symbol-file` |
| 9 | `frame-char-height` | frame.c | 0.39 | 9 / 44 / 23 | 14 / 33 / 6 | 6 / 6 / 9 | `posn-col-row` |
| 10 | `raise-frame` | frame.c | 0.37 | 12 / 33 / 0 | 7 / 9 / 0 | 4 / 6 / 0 |  |
| 11 | `x-popup-menu` | menu.c (platform) | 0.33 | 11 / 15 / 3 | 7 / 12 / 0 | 3 / 4 / 0 | `cal-menu-x-popup-menu` |
| 12 | `default-file-modes` | fileio.c | 0.29 | 10 / 12 / 32 | 1 / 0 / 1 | 3 / 3 / 2 | `with-file-modes`, `eshell-with-private-file-modes` |
| 13 | `set-default-file-modes` | fileio.c | 0.29 | 10 / 2 / 32 | 1 / 0 / 1 | 3 / 6 / 2 | `with-file-modes`, `eshell-with-private-file-modes` |
| 14 | `process-filter` | process.c | 0.28 | 8 / 22 / 0 | 4 / 10 / 0 | 4 / 7 / 0 |  |
| 15 | `frame-visible-p` | frame.c | 0.25 | 10 / 18 / 0 | 6 / 12 / 0 | 1 / 1 / 0 |  |
| 16 | `verify-visited-file-modtime` | fileio.c | 0.25 | 10 / 18 / 0 | 6 / 7 / 0 | 1 / 2 / 0 |  |
| 17 | `vertical-motion` | indent.c | 0.24 | 8 / 53 / 0 | 8 / 18 / 0 | 2 / 3 / 0 |  |
| 18 | `user-full-name` | editfns.c | 0.21 | 6 / 13 / 0 | 4 / 6 / 0 | 3 / 3 / 0 |  |
| 19 | `window-system` | frame.c | 0.21 | 6 / 20 / 0 | 10 / 14 / 0 | 2 / 8 / 0 |  |
| 20 | `this-single-command-raw-keys` | keyboard.c | 0.18 | 6 / 11 / 0 | 2 / 1 / 1 | 2 / 5 / 0 | `momentary-string-display` |
| 21 | `line-number-display-width` | indent.c | 0.17 | 6 / 9 / 0 | 7 / 13 / 0 | 1 / 1 / 0 |  |
| 22 | `set-window-vscroll` | window.c | 0.16 | 5 / 23 / 0 | 3 / 6 / 0 | 2 / 7 / 0 |  |
| 23 | `process-attributes` | process.c | 0.16 | 6 / 7 / 0 | 4 / 5 / 0 | 1 / 1 / 0 |  |
| 24 | `libxml-parse-html-region` | xml.c (platform) | 0.16 | 3 / 8 / 0 | 6 / 7 / 0 | 3 / 3 / 0 |  |
| 25 | `window-list-1` | window.c | 0.15 | 4 / 19 / 0 | 4 / 4 / 0 | 2 / 3 / 0 |  |
| 26 | `directory-files-and-attributes` | dired.c | 0.14 | 5 / 8 / 0 | 5 / 6 / 0 | 1 / 2 / 0 |  |
| 27 | `daemonp` | emacs.c (platform) | 0.14 | 5 / 15 / 0 | 4 / 10 / 0 | 1 / 1 / 0 |  |
| 28 | `internal--track-mouse` | keyboard.c | 0.14 | 6 / 0 / 11 | 4 / 0 / 5 |  | `track-mouse` |
| 29 | `read-key-sequence-vector` | keyboard.c | 0.14 | 2 / 2 / 0 | 5 / 5 / 0 | 3 / 3 / 0 |  |
| 30 | `mouse-position` | frame.c | 0.13 | 5 / 9 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 31 | `scroll-right` | window.c | 0.13 | 6 / 9 / 0 | 3 / 4 / 0 |  |  |
| 32 | `process-sentinel` | process.c | 0.13 | 5 / 10 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 33 | `window-configuration-frame` | window.c | 0.13 | 2 / 2 / 0 | 3 / 3 / 0 | 3 / 3 / 0 |  |
| 34 | `window-parent` | window.c | 0.13 | 2 / 32 / 0 | 3 / 8 / 0 | 3 / 4 / 0 |  |
| 35 | `scroll-left` | window.c | 0.13 | 6 / 8 / 0 | 1 / 2 / 0 |  |  |
| 36 | `mouse-pixel-position` | frame.c | 0.12 | 4 / 10 / 0 | 5 / 7 / 0 | 1 / 1 / 0 |  |
| 37 | `current-idle-time` | keyboard.c | 0.12 | 3 / 5 / 0 | 2 / 5 / 0 | 2 / 4 / 0 |  |
| 38 | `force-window-update` | window.c | 0.12 | 3 / 4 / 0 | 2 / 2 / 0 | 2 / 5 / 0 |  |
| 39 | `window-pixel-width` | window.c | 0.12 | 4 / 20 / 0 | 3 / 8 / 0 | 1 / 1 / 0 |  |
| 40 | `set-mouse-position` | frame.c | 0.11 | 4 / 5 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 41 | `window-vscroll` | window.c | 0.11 | 4 / 19 / 0 | 2 / 19 / 0 | 1 / 2 / 0 |  |
| 42 | `frame-parent` | frame.c | 0.11 | 3 / 12 / 0 | 7 / 8 / 0 | 1 / 2 / 0 |  |
| 43 | `gnutls-available-p` | gnutls.c (platform) | 0.11 | 4 / 14 / 0 |  | 1 / 2 / 0 |  |
| 44 | `frame-first-window` | window.c | 0.11 | 2 / 6 / 0 | 4 / 6 / 0 | 2 / 2 / 0 |  |
| 45 | `libxml-parse-xml-region` | xml.c (platform) | 0.10 | 2 / 2 / 0 | 3 / 4 / 0 | 2 / 3 / 0 |  |
| 46 | `list-system-processes` | process.c | 0.10 | 3 / 4 / 0 | 3 / 4 / 0 | 1 / 2 / 0 |  |
| 47 | `next-frame` | frame.c | 0.09 | 2 / 13 / 0 |  | 2 / 2 / 0 |  |
| 48 | `treesit-induce-sparse-tree` | treesit.c | 0.09 | 2 / 4 / 0 |  | 2 / 2 / 0 |  |
| 49 | `keymap-prompt` | keymap.c | 0.09 | 4 / 2 / 2 | 3 / 5 / 1 |  | `keymap-canonicalize` |
| 50 | `group-gid` | editfns.c | 0.09 | 3 / 4 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 51 | `redirect-frame-focus` | frame.c | 0.09 | 3 / 3 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 52 | `window-pixel-height` | window.c | 0.09 | 2 / 22 / 0 | 7 / 16 / 0 | 1 / 8 / 0 |  |
| 53 | `libxml-available-p` | xml.c (platform) | 0.09 | 1 / 1 / 0 | 5 / 6 / 0 | 2 / 2 / 0 |  |
| 54 | `visible-frame-list` | frame.c | 0.09 | 1 / 1 / 0 | 5 / 6 / 0 | 2 / 2 / 0 |  |
| 55 | `terminal-live-p` | terminal.c (platform) | 0.09 | 4 / 11 / 0 | 2 / 3 / 0 |  |  |
| 56 | `frame-text-cols` | frame.c | 0.09 | 3 / 3 / 0 |  | 1 / 1 / 0 |  |
| 57 | `access-file` | fileio.c | 0.09 | 4 / 9 / 0 | 1 / 1 / 0 |  |  |
| 58 | `terminal-parameter` | terminal.c (platform) | 0.09 | 4 / 30 / 0 | 1 / 2 / 0 |  |  |
| 59 | `read-variable` | minibuf.c | 0.08 | 4 / 6 / 0 |  |  |  |
| 60 | `frame-terminal` | terminal.c (platform) | 0.08 | 2 / 6 / 0 | 3 / 8 / 0 | 1 / 1 / 0 |  |
| 61 | `window-header-line-height` | window.c | 0.08 | 2 / 9 / 0 | 3 / 3 / 0 | 1 / 1 / 0 |  |
| 62 | `x-focus-frame` | frame.c | 0.08 | 2 / 6 / 0 | 3 / 5 / 0 | 1 / 1 / 0 |  |
| 63 | `ns-do-applescript` | nsfns.m (platform) | 0.08 | 1 / 1 / 0 | 1 / 1 / 0 | 2 / 2 / 0 |  |
| 64 | `terminal-name` | terminal.c (platform) | 0.07 | 2 / 2 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 65 | `window-tab-line-height` | window.c | 0.07 | 2 / 7 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 66 | `treesit-search-forward` | treesit.c | 0.07 | 1 / 5 / 0 |  | 2 / 5 / 0 |  |
| 67 | `window-line-height` | window.c | 0.07 | 3 / 5 / 0 | 3 / 5 / 0 |  |  |
| 68 | `make-char` | charset.c | 0.07 | 2 / 2 / 0 | 1 / 1 / 0 | 1 / 14 / 0 |  |
| 69 | `map-keymap-internal` | keymap.c | 0.07 | 2 / 2 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 70 | `find-operation-coding-system` | coding.c | 0.07 | 3 / 3 / 0 | 2 / 2 / 0 |  |  |
| 71 | `process-plist` | process.c | 0.07 | 3 / 4 / 0 | 2 / 4 / 0 |  |  |
| 72 | `frame-fringe-width` | frame.c | 0.07 | 2 / 3 / 0 |  | 1 / 2 / 0 |  |
| 73 | `frame-scroll-bar-width` | frame.c | 0.07 | 2 / 3 / 0 |  | 1 / 2 / 0 |  |
| 74 | `frame-text-lines` | frame.c | 0.07 | 2 / 2 / 0 |  | 1 / 1 / 0 |  |
| 75 | `treesit-node-match-p` | treesit.c | 0.07 | 2 / 10 / 0 |  | 1 / 8 / 0 |  |
| 76 | `treesit-search-subtree` | treesit.c | 0.07 | 2 / 11 / 0 |  | 1 / 4 / 0 |  |
| 77 | `window-at` | window.c | 0.07 | 2 / 2 / 0 |  | 1 / 1 / 0 |  |
| 78 | `file-name-completion` | dired.c | 0.06 | 3 / 4 / 0 | 1 / 1 / 0 |  |  |
| 79 | `frame-text-height` | frame.c | 0.06 | 3 / 9 / 0 | 1 / 1 / 0 |  |  |
| 80 | `frame-text-width` | frame.c | 0.06 | 3 / 9 / 0 | 1 / 1 / 0 |  |  |
| 81 | `set-terminal-parameter` | terminal.c (platform) | 0.06 | 3 / 18 / 0 | 1 / 2 / 0 |  |  |
| 82 | `window-pixel-left` | window.c | 0.06 | 3 / 20 / 0 | 1 / 1 / 0 |  |  |
| 83 | `window-pixel-top` | window.c | 0.06 | 3 / 21 / 0 | 1 / 1 / 0 |  |  |
| 84 | `iconify-frame` | frame.c | 0.06 | 3 / 8 / 0 |  |  |  |
| 85 | `internal-char-font` | font.c | 0.06 | 3 / 4 / 0 |  |  |  |
| 86 | `recent-auto-save-p` | fileio.c | 0.06 | 3 / 6 / 0 |  |  |  |
| 87 | `tty-display-color-p` | term.c (platform) | 0.06 | 3 / 5 / 0 |  |  |  |
| 88 | `tty-type` | term.c (platform) | 0.06 | 3 / 3 / 0 |  |  |  |
| 89 | `unhandled-file-name-directory` | fileio.c | 0.06 | 3 / 3 / 0 |  |  |  |
| 90 | `unicode-property-table-internal` | chartab.c | 0.06 | 3 / 3 / 0 |  |  |  |
| 91 | `user-real-login-name` | editfns.c | 0.06 | 3 / 7 / 0 |  |  |  |
| 92 | `x-get-resource` | frame.c | 0.06 | 3 / 4 / 0 |  |  |  |
| 93 | `x-popup-dialog` | menu.c (platform) | 0.06 | 3 / 3 / 0 |  |  |  |
| 94 | `internal-default-process-filter` | process.c | 0.06 |  | 2 / 2 / 0 | 2 / 2 / 0 |  |
| 95 | `set-window-fringes` | window.c | 0.06 | 2 / 2 / 0 | 5 / 8 / 0 |  |  |
| 96 | `abort-minibuffers` | minibuf.c | 0.05 | 1 / 1 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 97 | `last-nonminibuffer-frame` | frame.c | 0.05 | 1 / 6 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 98 | `set-mouse-pixel-position` | frame.c | 0.05 | 1 / 1 / 0 | 2 / 4 / 0 | 1 / 1 / 0 |  |
| 99 | `group-name` | editfns.c | 0.05 | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 100 | `window-valid-p` | window.c | 0.05 | 1 / 7 / 0 | 1 / 2 / 0 | 1 / 1 / 0 |  |
| 101 | `frame-position` | frame.c | 0.05 | 2 / 3 / 0 | 2 / 5 / 0 |  |  |
| 102 | `set-process-plist` | process.c | 0.05 | 2 / 2 / 0 | 2 / 3 / 0 |  |  |
| 103 | `window-scroll-bar-width` | window.c | 0.05 | 2 / 4 / 0 | 2 / 2 / 0 |  |  |
| 104 | `buffer-last-name` | buffer.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 105 | `category-set-mnemonics` | category.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 106 | `set-network-process-option` | process.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 107 | `treesit-compiled-query-p` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 108 | `treesit-parser-add-notifier` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 109 | `treesit-parser-included-ranges` | treesit.c | 0.05 | 1 / 3 / 0 |  | 1 / 2 / 0 |  |
| 110 | `treesit-parser-set-included-ranges` | treesit.c | 0.05 | 1 / 4 / 0 |  | 1 / 3 / 0 |  |
| 111 | `treesit-query-expand` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 112 | `treesit-query-language` | treesit.c | 0.05 | 1 / 5 / 0 |  | 1 / 5 / 0 |  |
| 113 | `treesit-query-p` | treesit.c | 0.05 | 1 / 2 / 0 |  | 1 / 2 / 0 |  |
| 114 | `treesit-subtree-stat` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 115 | `unix-sync` | fileio.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 116 | `zlib-decompress-region` | decompress.c (platform) | 0.05 | 1 / 1 / 0 |  | 1 / 3 / 0 |  |
| 117 | `make-pipe-process` | process.c | 0.04 | 2 / 2 / 0 | 1 / 1 / 0 |  |  |
| 118 | `next-read-file-uses-dialog-p` | fileio.c | 0.04 | 2 / 2 / 0 | 1 / 1 / 0 |  |  |
| 119 | `suspend-emacs` | keyboard.c | 0.04 | 2 / 4 / 0 | 1 / 1 / 0 |  |  |
| 120 | `x-display-pixel-height` | nsfns.m (platform) | 0.04 | 2 / 3 / 0 | 1 / 3 / 0 |  |  |
| 121 | `x-display-pixel-width` | nsfns.m (platform) | 0.04 | 2 / 3 / 0 | 1 / 3 / 0 |  |  |
| 122 | `buffer-swap-text` | buffer.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 123 | `file-system-info` | fileio.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 124 | `format-network-address` | process.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 125 | `frame--face-hash-table` | xfaces.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 126 | `frame-native-height` | frame.c | 0.04 | 2 / 5 / 0 |  |  |  |
| 127 | `frame-native-width` | frame.c | 0.04 | 2 / 5 / 0 |  |  |  |
| 128 | `frame-right-divider-width` | frame.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 129 | `getenv-internal` | callproc.c | 0.04 | 2 / 3 / 1 |  |  | `server-with-environment` |
| 130 | `gnutls-peer-status` | gnutls.c (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 131 | `message-box` | editfns.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 132 | `send-string-to-terminal` | dispnew.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 133 | `suspend-tty` | term.c (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 134 | `system-users` | dired.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 135 | `unlock-buffer` | filelock.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 136 | `user-real-uid` | editfns.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 137 | `window-display-table` | window.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 138 | `x-display-grayscale-p` | nsfns.m (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 139 | `x-display-list` | nsfns.m (platform) | 0.04 | 2 / 4 / 0 |  |  |  |
| 140 | `x-open-connection` | nsfns.m (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 141 | `clear-this-command-keys` | keyboard.c | 0.04 | 1 / 4 / 0 | 5 / 9 / 0 |  |  |
| 142 | `internal-complete-buffer` | minibuf.c | 0.03 | 1 / 1 / 0 | 4 / 9 / 0 |  |  |
| 143 | `window-mode-line-height` | window.c | 0.03 | 1 / 2 / 0 | 4 / 4 / 0 |  |  |
| 144 | `set-frame-height` | frame.c | 0.03 | 1 / 1 / 0 | 3 / 3 / 0 |  |  |
| 145 | `sqlite-available-p` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 146 | `sqlite-close` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 147 | `sqlite-open` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 148 | `sqlite-select` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 149 | `describe-buffer-bindings` | keymap.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 150 | `other-window-for-scrolling` | window.c | 0.03 | 1 / 5 / 0 | 2 / 3 / 0 |  |  |
| 151 | `set-frame-position` | frame.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 152 | `set-frame-width` | frame.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 153 | `gnutls-hash-mac` | gnutls.c (platform) | 0.03 |  |  | 1 / 6 / 0 |  |
| 154 | `treesit-pattern-expand` | treesit.c | 0.03 |  |  | 1 / 1 / 0 |  |
| 155 | `delete-terminal` | terminal.c (platform) | 0.02 | 1 / 3 / 0 | 1 / 1 / 0 |  |  |
| 156 | `find-charset-string` | charset.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 157 | `keyboard-coding-system` | coding.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 158 | `make-xwidget` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 159 | `network-interface-list` | process.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 160 | `set--this-command-keys` | keyboard.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 161 | `terminal-coding-system` | coding.c | 0.02 | 1 / 2 / 0 | 1 / 1 / 0 |  |  |
| 162 | `tty-display-color-cells` | term.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 163 | `window-next-sibling` | window.c | 0.02 | 1 / 22 / 0 | 1 / 1 / 0 |  |  |
| 164 | `window-right-divider-width` | window.c | 0.02 | 1 / 2 / 0 | 1 / 1 / 0 |  |  |
| 165 | `window-scroll-bar-height` | window.c | 0.02 | 1 / 3 / 0 | 1 / 1 / 0 |  |  |
| 166 | `x-show-tip` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 167 | `xwidget-webkit-execute-script` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 168 | `char-resolve-modifiers` | character.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 169 | `charset-after` | charset.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 170 | `command-error-default-function` | keyboard.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 171 | `controlling-tty-p` | term.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 172 | `coordinates-in-window-p` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 173 | `delete-directory-internal` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 174 | `delete-file-internal` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 175 | `delete-other-windows-internal` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 176 | `delete-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 177 | `describe-vector` | keymap.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 178 | `display--line-is-continued-p` | xdisp.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 179 | `display--update-for-mouse-movement` | dispnew.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 180 | `face-attributes-as-vector` | xfaces.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 181 | `file-acl` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 182 | `file-selinux-context` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 183 | `find-charset-region` | charset.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 184 | `font-face-attributes` | font.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 185 | `fontset-list` | fontset.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 186 | `frame--set-was-invisible` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 187 | `frame-after-make-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 188 | `frame-ancestor-p` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 189 | `frame-bottom-divider-width` | frame.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 190 | `frame-internal-border-width` | frame.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 191 | `frame-scroll-bar-height` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 192 | `frame-total-cols` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 193 | `frame-total-lines` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 194 | `gnutls-boot` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 195 | `gnutls-ciphers` | gnutls.c (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 196 | `gnutls-error-string` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 197 | `gnutls-errorp` | gnutls.c (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 198 | `gnutls-format-certificate` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 199 | `gnutls-peer-status-warning-describe` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 200 | `gnutls-symmetric-decrypt` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 201 | `gnutls-symmetric-encrypt` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 202 | `handle-switch-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 203 | `help--describe-vector` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 204 | `innermost-minibuffer-p` | minibuf.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 205 | `internal-copy-lisp-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 206 | `internal-describe-syntax-value` | syntax.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 207 | `internal-face-x-get-resource` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 208 | `internal-get-lisp-face-attribute` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 209 | `internal-handle-focus-in` | keyboard.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 210 | `internal-lisp-face-empty-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 211 | `internal-lisp-face-equal-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 212 | `internal-lisp-face-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 213 | `internal-make-lisp-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 214 | `internal-merge-in-global-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 215 | `internal-set-alternative-font-family-alist` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 216 | `internal-set-alternative-font-registry-alist` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 217 | `internal-set-font-selection-order` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 218 | `internal-set-lisp-face-attribute` | xfaces.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 219 | `internal-set-lisp-face-attribute-from-resource` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 220 | `keymap--get-keyelt` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 221 | `kqueue-add-watch` | kqueue.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 222 | `lock-buffer` | filelock.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 223 | `lock-file` | filelock.c | 0.02 | 1 / 1 / 5 |  |  | `tramp-skeleton-write-region` |
| 224 | `make-directory-internal` | fileio.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 225 | `make-serial-process` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 226 | `make-temp-file-internal` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 227 | `make-terminal-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 228 | `marker-last-position` | marker.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 229 | `menu-or-popup-active-p` | nsmenu.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 230 | `minibuffer-innermost-command-loop-p` | minibuf.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 231 | `network-lookup-address-info` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 232 | `ns-display-monitor-attributes-list` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 233 | `ns-frame-edges` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 234 | `ns-frame-geometry` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 235 | `ns-frame-list-z-order` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 236 | `ns-frame-restack` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 237 | `ns-mouse-absolute-pixel-position` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 238 | `ns-set-mouse-absolute-pixel-position` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 239 | `num-processors` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 240 | `old-selected-window` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 241 | `previous-frame` | frame.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 242 | `process-inherit-coding-system-flag` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 243 | `process-thread` | process.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 244 | `resize-mini-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 245 | `resume-tty` | term.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 246 | `run-window-scroll-functions` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 247 | `set-buffer-auto-saved` | fileio.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 248 | `set-file-acl` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 249 | `set-file-selinux-context` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 250 | `set-process-inherit-coding-system-flag` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 251 | `set-window-combination-limit` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 252 | `set-window-display-table` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 253 | `set-window-new-normal` | window.c | 0.02 | 1 / 23 / 0 |  |  |  |
| 254 | `set-window-new-pixel` | window.c | 0.02 | 1 / 12 / 0 |  |  |  |
| 255 | `set-window-new-total` | window.c | 0.02 | 1 / 10 / 0 |  |  |  |
| 256 | `set-window-scroll-bars` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 257 | `signal-names` | process.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 258 | `split-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 259 | `store-kbd-macro-event` | macros.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 260 | `system-groups` | dired.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 261 | `system-move-file-to-trash` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 262 | `unlock-file` | filelock.c | 0.02 | 1 / 1 / 5 |  |  | `tramp-skeleton-write-region` |
| 263 | `waiting-for-user-input-p` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 264 | `window-bottom-divider-width` | window.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 265 | `window-bump-use-time` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 266 | `window-combination-limit` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 267 | `window-configuration-equal-p` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 268 | `window-left-child` | window.c | 0.02 | 1 / 10 / 0 |  |  |  |
| 269 | `window-left-column` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 270 | `window-lines-pixel-dimensions` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 271 | `window-new-normal` | window.c | 0.02 | 1 / 21 / 0 |  |  |  |
| 272 | `window-new-pixel` | window.c | 0.02 | 1 / 9 / 0 |  |  |  |
| 273 | `window-new-total` | window.c | 0.02 | 1 / 8 / 0 |  |  |  |
| 274 | `window-normal-size` | window.c | 0.02 | 1 / 21 / 0 |  |  |  |
| 275 | `window-old-buffer` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 276 | `window-old-pixel-height` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 277 | `window-old-pixel-width` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 278 | `window-prev-sibling` | window.c | 0.02 | 1 / 9 / 0 |  |  |  |
| 279 | `window-resize-apply` | window.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 280 | `window-resize-apply-total` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 281 | `window-scroll-bars` | window.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 282 | `window-top-child` | window.c | 0.02 | 1 / 9 / 0 |  |  |  |
| 283 | `window-top-line` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 284 | `x-close-connection` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 285 | `x-create-frame` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 286 | `x-display-backing-store` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 287 | `x-display-color-cells` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 288 | `x-display-mm-height` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 289 | `x-display-mm-width` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 290 | `x-display-planes` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 291 | `x-display-save-under` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 292 | `x-display-screens` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 293 | `x-display-visual-class` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 294 | `x-hide-tip` | nsfns.m (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 295 | `x-parse-geometry` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 296 | `x-select-font` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 297 | `x-server-version` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 298 | `xw-color-defined-p` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 299 | `xw-color-values` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 300 | `xw-display-color-p` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 301 | `xwidget-info` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 302 | `make-frame-invisible` | frame.c | 0.02 |  | 5 / 7 / 0 |  |  |
| 303 | `coding-system-plist` | coding.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 304 | `frame-scale-factor` | frame.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 305 | `network-interface-info` | process.c | 0.00 |  | 1 / 2 / 0 |  |  |
| 306 | `set-binary-mode` | fileio.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 307 | `set-fontset-font` | fontset.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 308 | `set-xwidget-query-on-exit-flag` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 309 | `xwidget-resize` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 310 | `xwidget-webkit-goto-uri` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 311 | `xwidget-webkit-uri` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |

### By piece of work

Packages needing at least one primitive of the group, per corpus, and those for which the group is all they lack (MELPA's by downloads, then Emacs's own).

| group | needed | score | emacs | melpa | daily | all they lack |
|---|---|---|---|---|---|---|
| window-tree | 49 | 1.29 | 36 | 42 | 16 | 8: popwin, ace-link, link-hint, doom-themes, visual-fill-column, page-break-lines, centered-cursor-mode, dashboard |
| frames | 52 | 1.25 | 34 | 40 | 16 | 7: magit-section, powerline, cfrs, org-download, org-roam, treemacs-evil, spacemacs-theme |
| process-objects | 23 | 1.22 | 30 | 50 | 17 | 30: markdown-mode, async, request, web-mode, ac-php-core, pfuture, rust-mode, simple-httpd |
| scrolling | 13 | 1.08 | 33 | 37 | 11 | 6: evil-nerd-commenter, golden-ratio, vterm, flycheck-pos-tip, ctable, live-py-mode |
| files | 26 | 0.64 | 23 | 13 | 5 | 0:  |
| user-system | 10 | 0.55 | 19 | 9 | 5 | 1: restart-emacs |
| mouse | 12 | 0.51 | 15 | 14 | 6 | 1: highlight |
| tls-zlib | 13 | 0.48 | 13 | 11 | 7 | 6: pkg-info, evil-tutor, consult, smex, helpful, ert (Emacs) |
| menus | 8 | 0.46 | 17 | 9 | 3 | 2: yasnippet, lsp-treemacs |
| charsets-codings | 10 | 0.23 | 9 | 6 | 1 | 1: wgrep |
| keyboard | 5 | 0.22 | 7 | 8 | 2 | 0:  |
| xml | 3 | 0.19 | 3 | 8 | 4 | 3: pip-requirements, devdocs, gh-md |
| macos-x | 25 | 0.18 | 6 | 2 | 2 | 0:  |
| keymaps | 6 | 0.17 | 6 | 6 | 1 | 1: helm-descbinds |
| minibuffer | 5 | 0.17 | 6 | 5 | 1 | 1: swiper |
| treesit | 13 | 0.12 | 2 | 0 | 3 | 0:  |
| faces-fonts | 19 | 0.11 | 5 | 1 | 0 | 1: nerd-icons |
| buffer-text | 3 | 0.09 | 3 | 0 | 1 | 0:  |
| other | 4 | 0.08 | 4 | 0 | 0 | 0:  |
| xwidgets | 7 | 0.05 | 2 | 2 | 0 | 0:  |
| sqlite | 4 | 0.03 | 0 | 1 | 1 | 0:  |
| syntax-tables | 1 | 0.02 | 1 | 0 | 0 | 0:  |

### One-liners over what E8 has

Primitives E8 has no function for but a line of its API does (`demand-other-names.json`, `derived`), scored as above as if they were missing. Ports write them inline; giving them Emacs's names in `subr` would keep ports closer to the Lisp they follow.

| primitive | score | emacs packages | melpa packages | daily packages | in E8 |
|---|---|---|---|---|---|
| `framep` | 0.59 | 18 | 12 | 7 | e8.frameList().includes(f) |
| `windowp` | 0.53 | 17 | 16 | 5 | typeof w === 'number' |

### Wrappers from subr.el and Emacs's macros that E8 lacks by name

Those whose expansion or body calls a primitive E8 lacks: packages using each, per corpus, and the primitives it brings.

| wrapper | emacs | melpa | daily | brings |
|---|---|---|---|---|
| `with-output-to-temp-buffer` | 22 | 10 | 4 | `make-frame-visible`, `set-window-hscroll`, `window-frame` |
| `internal-temp-output-buffer-show` | 22 | 10 | 4 | `make-frame-visible`, `set-window-hscroll`, `window-frame` |
| `symbol-file` | 8 | 11 | 5 | `zlib-available-p` |
| `with-file-modes` | 10 | 1 | 1 | `default-file-modes`, `set-default-file-modes` |
| `track-mouse` | 6 | 4 |  | `internal--track-mouse` |
| `posn-col-row` | 3 | 3 | 2 | `frame-char-height`, `window-frame` |
| `with-minibuffer-selected-window` | 3 | 1 | 2 | `window-frame` |
| `call-shell-region` | 3 |  |  | `call-process-region` |
| `keymap-canonicalize` | 2 | 1 |  | `keymap-prompt` |
| `with-existing-directory` | 1 |  |  | `default-file-modes`, `set-default-file-modes` |
| `cal-menu-x-popup-menu` | 1 |  |  | `x-popup-menu` |
| `eshell-with-private-file-modes` | 1 |  |  | `default-file-modes`, `set-default-file-modes` |
| `image-dired--do-mark-command` | 1 |  |  | `window-frame` |
| `image-dired--with-thumbnail-buffer` | 1 |  |  | `window-frame` |
| `with-minibuffer-completions-window` | 1 |  |  | `window-frame` |
| `server-with-environment` | 1 |  |  | `getenv-internal` |
| `tramp-skeleton-write-region` | 1 |  |  | `lock-file`, `unlock-file` |
| `momentary-string-display` |  | 1 |  | `this-single-command-raw-keys` |

### MELPA packages nearest to needing nothing E8 lacks

Among MELPA's 150 most downloaded, those defining commands (three or more `interactive` forms), with the primitives and the libraries shipped with Emacs each still needs, its MELPA dependencies' included, fewest first. Those E8 has ported already are marked.

| package | downloads | primitives missing | libraries missing | ported |
|---|---|---|---|---|
| dash | 6,571,380 |  |  |  |
| diminish | 1,739,448 |  |  |  |
| hl-todo | 1,463,567 |  |  |  |
| iedit | 1,407,261 |  |  |  |
| yaml-mode | 1,340,155 |  |  |  |
| highlight-indentation | 1,336,453 |  |  |  |
| aggressive-indent | 1,308,083 |  |  |  |
| htmlize | 1,274,270 |  |  |  |
| auto-compile | 1,269,191 |  |  |  |
| dumb-jump | 1,243,915 |  |  |  |
| paredit | 1,098,226 |  |  |  |
| auto-highlight-symbol | 1,067,739 |  |  |  |
| hungry-delete | 1,066,132 |  |  |  |
| helm-make | 1,046,315 |  |  |  |
| indent-guide | 1,017,888 |  |  |  |
| ws-butler | 1,005,643 |  |  |  |
| eval-sexp-fu | 990,156 |  |  |  |
| lorem-ipsum | 930,747 |  |  |  |
| eyebrowse | 913,884 |  |  |  |
| move-text | 907,212 |  |  |  |
| column-enforce-mode | 837,233 |  |  |  |
| neotree | 814,366 |  |  |  |
| log4e | 783,678 |  |  |  |
| web-mode | 1,625,641 | `set-process-filter` |  |  |
| anzu | 1,509,594 |  | `thingatpt` |  |
| pcre2el | 1,199,938 |  | `re-builder` |  |
| evil-matchit | 1,176,108 |  | `semantic/lex` |  |
| popwin | 1,172,453 | `frame-first-window` |  |  |
| toc-org | 1,061,694 |  | `thingatpt` |  |
| magit-popup | 1,013,776 |  | `button` |  |

### Missing and needed by nothing in the corpus (109)

`bitmap-spec-p`, `cancel-kbd-macro-events`, `charset-id-internal`, `charset-plist`, `clear-buffer-auto-save-failure`, `clear-charset-maps`, `clear-composition-cache`, `clear-face-cache`, `clear-font-cache`, `close-font`, `coding-system-put`, `compose-region-internal`, `compose-string-internal`, `composition-get-gstring`, `composition-sort-rules`, `compute-motion`, `current-input-mode`, `declare-equiv-charset`, `decode-big5-char`, `decode-sjis-char`, `define-charset-alias`, `define-charset-internal`, `define-coding-system-alias`, `define-coding-system-internal`, `encode-big5-char`, `encode-sjis-char`, `file-attributes-lessp`, `find-coding-systems-region-internal`, `find-composition-internal`, `font-get-glyphs`, `font-match-p`, `font-shape-gstring`, `font-variation-glyphs`, `frame-child-frame-border-width`, `frame-focus`, `frame-font-cache`, `frame-old-selected-window`, `frame-pointer-visible-p`, `frame-window-state-change`, `gap-position`, `gap-size`, `get-unicode-property-internal`, `get-unused-iso-final-char`, `group-real-gid`, `internal--labeled-narrow-to-region`, `internal--labeled-widen`, `internal--set-buffer-modified-tick`, `internal-default-interrupt-process`, `internal-default-process-sentinel`, `internal-default-signal-process`, `iso-charset`, `lookup-image-map`, `lower-frame`, `make-category-set`, `map-charset-chars`, `message-or-box`, `multibyte-char-to-unibyte`, `newline-cache-check`, `old-selected-frame`, `open-dribble-file`, `open-font`, `open-termscript`, `optimize-char-table`, `posix-looking-at`, `posix-search-backward`, `posix-search-forward`, `posix-string-match`, `process-datagram-address`, `process-running-child-p`, `put-unicode-property-internal`, `re--describe-compiled`, `read-non-nil-coding-system`, `reconsider-frame-fonts`, `run-window-configuration-change-hook`, `serial-process-configure`, `set-buffer-redisplay`, `set-charset-plist`, `set-charset-priority`, `set-frame-window-state-change`, `set-input-interrupt-mode`, `set-input-meta-mode`, `set-input-mode`, `set-keyboard-coding-system-internal`, `set-minibuffer-window`, `set-output-flow-control`, `set-process-datagram-address`, `set-process-thread`, `set-quit-char`, `set-safe-terminal-coding-system-internal`, `set-terminal-coding-system-internal`, `set-window-cursor-type`, `sort-charsets`, `split-char`, `text-char-description`, `tool-bar-pixel-width`, `translate-region-internal`, `treesit-language-abi-version`, `treesit-library-abi-version`, `treesit-parser-notifiers`, `treesit-parser-remove-notifier`, `tty-suppress-bold-inverse-default-colors`, `unibyte-char-to-multibyte`, `unify-charset`, `window-cursor-type`, `window-old-body-pixel-height`, `window-old-body-pixel-width`, `window-old-point`, `x-family-fonts`, `x-load-color-file`
