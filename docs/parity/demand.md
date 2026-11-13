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

## After windows and processes

Windows as Emacs has them ([ADR 0069](../adr/0069-windows-as-emacs-has-them.md), pull requests 98 to 109) and processes as Emacs has them ([ADR 0070](../adr/0070-processes-as-emacs-has-them.md), pull request 110 and the next) landed on 2026-11-11 and 12. Measured again on the same corpus:

- **By name**, 543 of the 877 editor primitives (62%), from 467; window.c has 69 of its 117 and process.c 52 of its 63.
- **Packages needing nothing missing**: 219 of 295 MELPA packages, from 176; 45 of 77 daily ones, from 36; 2 of Emacs's 49, unchanged.
- **Still needed** by at least one package: 170 editor and 77 platform primitives, from 234 and 77; 107 editor primitives are needed by nothing.
- **The window tree and frames** fell from 1.29 and 1.25 to 0.30 and 0.34; what is left of them is mostly frames' own parameters and visibility, and frames' own minibuffer windows. **Processes** are off the list: the serial and datagram primitives ADR 0070 leaves out are needed by no package of the corpus.

The ranking is now led by **scrolling and screen lines** (1.08: `set-window-hscroll`, which `with-output-to-temp-buffer` brings to 22 of Emacs's own packages, `window-hscroll`, `vertical-motion`, `scroll-left` and the vscroll pair; all that 19 MELPA packages lack, among them lv, golden-ratio, diff-hl, typescript-mode and vterm), then files (0.64: `default-file-modes`, `verify-visited-file-modtime`), the user and the system (0.55), mouse events (0.51), zlib and TLS (0.48, through `symbol-file`) and menus (0.46, `x-popup-menu`).

## After scrolling

Scrolling as Emacs has it ([ADR 0071](../adr/0071-scrolling-as-emacs-has-it.md), pull requests 112 to 114) landed on 2026-11-12. Measured again on the same corpus:

- **By name**, 557 of the 877 editor primitives (64%), from 543; window.c has 80 of its 117, and indent.c all 7 of its.
- **Packages needing nothing missing**: 235 of 295 MELPA packages, from 219; 50 of 77 daily ones, from 45; 5 of Emacs's 49, from 2.
- **Still needed** by at least one package: 157 editor and 77 platform primitives, from 170 and 77; 106 editor primitives are needed by nothing.
- **Scrolling and screen lines** are off the list: every primitive of the group is there.

The ranking is now led by **files** (0.64: `default-file-modes` and `set-default-file-modes` through `with-file-modes`, `verify-visited-file-modtime`), then the user and the system (0.55, `user-full-name`), mouse events (0.51, `track-mouse`, `mouse-position`), zlib and TLS (0.48, through `symbol-file`) and menus (0.46, `x-popup-menu`).

## After files

Files as Emacs has them ([ADR 0072](../adr/0072-files-as-emacs-has-them.md), pull request 115 and the next) landed on 2026-11-12 and 13. Measured again on the same corpus:

- **By name**, 585 of the 877 editor primitives (67%), from 557; fileio.c has 52 of its 54, dired.c 6 of its 8 and filelock.c all 5.
- **Packages needing nothing missing**: 237 of 295 MELPA packages, from 235; 51 of 77 daily ones, from 50; 8 of Emacs's 49, from 5.
- **Still needed** by at least one package: 133 editor and 76 platform primitives, from 157 and 77; 104 editor primitives are needed by nothing.
- **Files** are off the list but for `kqueue-add-watch`, file notifications being a piece of their own.

The ranking is now led by **the user and the system** (0.55: `user-full-name`, `daemonp`, `group-gid`), then mouse events (0.51), zlib and TLS (0.48) and menus (0.46).

## After the user and the system

The user and the system as Emacs has them ([ADR 0073](../adr/0073-the-user-and-the-system-as-emacs-has-them.md)) landed on 2026-11-13. Measured again on the same corpus:

- **By name**, 595 of the 877 editor primitives (68%), from 585.
- **Packages needing nothing missing**: 238 of 295 MELPA packages, from 237; 52 of 77 daily ones, from 51; 10 of Emacs's 49, from 8.
- **Still needed** by at least one package: 125 editor and 75 platform primitives, from 133 and 76; 103 editor primitives are needed by nothing.
- **The user and the system** are off the list: every primitive of the group is there.

The ranking is now led by **mouse events** (0.51: `track-mouse`, `mouse-position`, `set-mouse-position`), then zlib and TLS (0.48, through `symbol-file`), menus (0.46, `x-popup-menu`) and frames (0.34).

Mouse events ([ADR 0074](../adr/0074-mouse-events-as-emacs-has-them.md)) landed on 2026-11-13. Measured again on the same corpus:

- **By name**, 604 of the 877 editor primitives (69%), from 595.
- **Packages needing nothing missing**: 240 of 295 MELPA packages, from 238; 53 of 77 daily ones, from 52; 13 of Emacs's 49, from 10.
- **Still needed** by at least one package: 115 editor and 73 platform primitives, from 125 and 75; 102 editor primitives are needed by nothing.
- **Mouse events** are off the list: every primitive of the group is there, macOS's two under E8's own names.

The ranking is now led by **zlib and TLS** (0.48: `zlib-available-p`, through `symbol-file`, and `gnutls-available-p`), then menus (0.46, `x-popup-menu`) and frames (0.34).

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

As measured again after the user and the system (ADR 0073), with what E8 has on main at that point.

### Missing primitives by demand

Score: the share of each corpus's packages that need the primitive, directly or through a wrapper E8 also lacks, summed with weights emacs 1, melpa 1, daily 2. Each corpus's cell is packages / calls / uses through wrappers; the last column names the wrappers most of those come through.

| # | primitive | C file | score | emacs | melpa | daily | through |
|---|---|---|---|---|---|---|---|
| 1 | `zlib-available-p` | decompress.c (platform) | 0.40 | 10 / 4 / 11 | 11 / 0 / 14 | 6 / 3 / 7 | `symbol-file` |
| 2 | `x-popup-menu` | menu.c (platform) | 0.33 | 11 / 15 / 3 | 7 / 12 / 0 | 3 / 4 / 0 | `cal-menu-x-popup-menu` |
| 3 | `this-single-command-raw-keys` | keyboard.c | 0.18 | 6 / 11 / 0 | 2 / 1 / 1 | 2 / 5 / 0 | `momentary-string-display` |
| 4 | `libxml-parse-html-region` | xml.c (platform) | 0.16 | 3 / 8 / 0 | 6 / 7 / 0 | 3 / 3 / 0 |  |
| 5 | `internal--track-mouse` | keyboard.c | 0.14 | 6 / 0 / 11 | 4 / 0 / 5 |  | `track-mouse` |
| 6 | `read-key-sequence-vector` | keyboard.c | 0.14 | 2 / 2 / 0 | 5 / 5 / 0 | 3 / 3 / 0 |  |
| 7 | `mouse-position` | frame.c | 0.13 | 5 / 9 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 8 | `window-configuration-frame` | window.c | 0.13 | 2 / 2 / 0 | 3 / 3 / 0 | 3 / 3 / 0 |  |
| 9 | `mouse-pixel-position` | frame.c | 0.12 | 4 / 10 / 0 | 5 / 7 / 0 | 1 / 1 / 0 |  |
| 10 | `current-idle-time` | keyboard.c | 0.12 | 3 / 5 / 0 | 2 / 5 / 0 | 2 / 4 / 0 |  |
| 11 | `set-mouse-position` | frame.c | 0.11 | 4 / 5 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 12 | `gnutls-available-p` | gnutls.c (platform) | 0.11 | 4 / 14 / 0 |  | 1 / 2 / 0 |  |
| 13 | `libxml-parse-xml-region` | xml.c (platform) | 0.10 | 2 / 2 / 0 | 3 / 4 / 0 | 2 / 3 / 0 |  |
| 14 | `treesit-induce-sparse-tree` | treesit.c | 0.09 | 2 / 4 / 0 |  | 2 / 2 / 0 |  |
| 15 | `keymap-prompt` | keymap.c | 0.09 | 4 / 2 / 2 | 3 / 5 / 1 |  | `keymap-canonicalize` |
| 16 | `redirect-frame-focus` | frame.c | 0.09 | 3 / 3 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 17 | `libxml-available-p` | xml.c (platform) | 0.09 | 1 / 1 / 0 | 5 / 6 / 0 | 2 / 2 / 0 |  |
| 18 | `terminal-live-p` | terminal.c (platform) | 0.09 | 4 / 11 / 0 | 2 / 3 / 0 |  |  |
| 19 | `terminal-parameter` | terminal.c (platform) | 0.09 | 4 / 30 / 0 | 1 / 2 / 0 |  |  |
| 20 | `read-variable` | minibuf.c | 0.08 | 4 / 6 / 0 |  |  |  |
| 21 | `frame-terminal` | terminal.c (platform) | 0.08 | 2 / 6 / 0 | 3 / 8 / 0 | 1 / 1 / 0 |  |
| 22 | `ns-do-applescript` | nsfns.m (platform) | 0.08 | 1 / 1 / 0 | 1 / 1 / 0 | 2 / 2 / 0 |  |
| 23 | `terminal-name` | terminal.c (platform) | 0.07 | 2 / 2 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 24 | `window-tab-line-height` | window.c | 0.07 | 2 / 7 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 25 | `treesit-search-forward` | treesit.c | 0.07 | 1 / 5 / 0 |  | 2 / 5 / 0 |  |
| 26 | `make-char` | charset.c | 0.07 | 2 / 2 / 0 | 1 / 1 / 0 | 1 / 14 / 0 |  |
| 27 | `map-keymap-internal` | keymap.c | 0.07 | 2 / 2 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 28 | `find-operation-coding-system` | coding.c | 0.07 | 3 / 3 / 0 | 2 / 2 / 0 |  |  |
| 29 | `frame-fringe-width` | frame.c | 0.07 | 2 / 3 / 0 |  | 1 / 2 / 0 |  |
| 30 | `frame-scroll-bar-width` | frame.c | 0.07 | 2 / 3 / 0 |  | 1 / 2 / 0 |  |
| 31 | `treesit-node-match-p` | treesit.c | 0.07 | 2 / 10 / 0 |  | 1 / 8 / 0 |  |
| 32 | `treesit-search-subtree` | treesit.c | 0.07 | 2 / 11 / 0 |  | 1 / 4 / 0 |  |
| 33 | `window-at` | window.c | 0.07 | 2 / 2 / 0 |  | 1 / 1 / 0 |  |
| 34 | `frame-text-height` | frame.c | 0.06 | 3 / 9 / 0 | 1 / 1 / 0 |  |  |
| 35 | `frame-text-width` | frame.c | 0.06 | 3 / 9 / 0 | 1 / 1 / 0 |  |  |
| 36 | `set-terminal-parameter` | terminal.c (platform) | 0.06 | 3 / 18 / 0 | 1 / 2 / 0 |  |  |
| 37 | `window-pixel-left` | window.c | 0.06 | 3 / 20 / 0 | 1 / 1 / 0 |  |  |
| 38 | `window-pixel-top` | window.c | 0.06 | 3 / 21 / 0 | 1 / 1 / 0 |  |  |
| 39 | `internal-char-font` | font.c | 0.06 | 3 / 4 / 0 |  |  |  |
| 40 | `tty-display-color-p` | term.c (platform) | 0.06 | 3 / 5 / 0 |  |  |  |
| 41 | `tty-type` | term.c (platform) | 0.06 | 3 / 3 / 0 |  |  |  |
| 42 | `unicode-property-table-internal` | chartab.c | 0.06 | 3 / 3 / 0 |  |  |  |
| 43 | `x-get-resource` | frame.c | 0.06 | 3 / 4 / 0 |  |  |  |
| 44 | `x-popup-dialog` | menu.c (platform) | 0.06 | 3 / 3 / 0 |  |  |  |
| 45 | `set-window-fringes` | window.c | 0.06 | 2 / 2 / 0 | 5 / 8 / 0 |  |  |
| 46 | `abort-minibuffers` | minibuf.c | 0.05 | 1 / 1 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 47 | `set-mouse-pixel-position` | frame.c | 0.05 | 1 / 1 / 0 | 2 / 4 / 0 | 1 / 1 / 0 |  |
| 48 | `frame-position` | frame.c | 0.05 | 2 / 3 / 0 | 2 / 5 / 0 |  |  |
| 49 | `window-scroll-bar-width` | window.c | 0.05 | 2 / 4 / 0 | 2 / 2 / 0 |  |  |
| 50 | `buffer-last-name` | buffer.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 51 | `category-set-mnemonics` | category.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 52 | `set-network-process-option` | process.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 53 | `treesit-compiled-query-p` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 54 | `treesit-parser-add-notifier` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 55 | `treesit-parser-included-ranges` | treesit.c | 0.05 | 1 / 3 / 0 |  | 1 / 2 / 0 |  |
| 56 | `treesit-parser-set-included-ranges` | treesit.c | 0.05 | 1 / 4 / 0 |  | 1 / 3 / 0 |  |
| 57 | `treesit-query-expand` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 58 | `treesit-query-language` | treesit.c | 0.05 | 1 / 5 / 0 |  | 1 / 5 / 0 |  |
| 59 | `treesit-query-p` | treesit.c | 0.05 | 1 / 2 / 0 |  | 1 / 2 / 0 |  |
| 60 | `treesit-subtree-stat` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 61 | `zlib-decompress-region` | decompress.c (platform) | 0.05 | 1 / 1 / 0 |  | 1 / 3 / 0 |  |
| 62 | `next-read-file-uses-dialog-p` | fileio.c | 0.04 | 2 / 2 / 0 | 1 / 1 / 0 |  |  |
| 63 | `x-display-pixel-height` | nsfns.m (platform) | 0.04 | 2 / 3 / 0 | 1 / 3 / 0 |  |  |
| 64 | `x-display-pixel-width` | nsfns.m (platform) | 0.04 | 2 / 3 / 0 | 1 / 3 / 0 |  |  |
| 65 | `buffer-swap-text` | buffer.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 66 | `frame--face-hash-table` | xfaces.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 67 | `frame-native-height` | frame.c | 0.04 | 2 / 5 / 0 |  |  |  |
| 68 | `frame-native-width` | frame.c | 0.04 | 2 / 5 / 0 |  |  |  |
| 69 | `frame-right-divider-width` | frame.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 70 | `gnutls-peer-status` | gnutls.c (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 71 | `message-box` | editfns.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 72 | `send-string-to-terminal` | dispnew.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 73 | `suspend-tty` | term.c (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 74 | `window-display-table` | window.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 75 | `x-display-grayscale-p` | nsfns.m (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 76 | `x-display-list` | nsfns.m (platform) | 0.04 | 2 / 4 / 0 |  |  |  |
| 77 | `x-open-connection` | nsfns.m (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 78 | `clear-this-command-keys` | keyboard.c | 0.04 | 1 / 4 / 0 | 5 / 9 / 0 |  |  |
| 79 | `internal-complete-buffer` | minibuf.c | 0.03 | 1 / 1 / 0 | 4 / 9 / 0 |  |  |
| 80 | `set-frame-height` | frame.c | 0.03 | 1 / 1 / 0 | 3 / 3 / 0 |  |  |
| 81 | `sqlite-available-p` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 82 | `sqlite-close` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 83 | `sqlite-open` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 84 | `sqlite-select` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 85 | `describe-buffer-bindings` | keymap.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 86 | `set-frame-position` | frame.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 87 | `set-frame-width` | frame.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 88 | `gnutls-hash-mac` | gnutls.c (platform) | 0.03 |  |  | 1 / 6 / 0 |  |
| 89 | `treesit-pattern-expand` | treesit.c | 0.03 |  |  | 1 / 1 / 0 |  |
| 90 | `delete-terminal` | terminal.c (platform) | 0.02 | 1 / 3 / 0 | 1 / 1 / 0 |  |  |
| 91 | `find-charset-string` | charset.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 92 | `keyboard-coding-system` | coding.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 93 | `make-xwidget` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 94 | `set--this-command-keys` | keyboard.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 95 | `terminal-coding-system` | coding.c | 0.02 | 1 / 2 / 0 | 1 / 1 / 0 |  |  |
| 96 | `tty-display-color-cells` | term.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 97 | `window-right-divider-width` | window.c | 0.02 | 1 / 2 / 0 | 1 / 1 / 0 |  |  |
| 98 | `window-scroll-bar-height` | window.c | 0.02 | 1 / 3 / 0 | 1 / 1 / 0 |  |  |
| 99 | `x-show-tip` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 100 | `xwidget-webkit-execute-script` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 101 | `char-resolve-modifiers` | character.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 102 | `charset-after` | charset.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 103 | `command-error-default-function` | keyboard.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 104 | `controlling-tty-p` | term.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 105 | `coordinates-in-window-p` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 106 | `describe-vector` | keymap.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 107 | `display--line-is-continued-p` | xdisp.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 108 | `display--update-for-mouse-movement` | dispnew.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 109 | `face-attributes-as-vector` | xfaces.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 110 | `find-charset-region` | charset.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 111 | `font-face-attributes` | font.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 112 | `fontset-list` | fontset.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 113 | `frame--set-was-invisible` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 114 | `frame-after-make-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 115 | `frame-ancestor-p` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 116 | `frame-bottom-divider-width` | frame.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 117 | `frame-internal-border-width` | frame.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 118 | `frame-scroll-bar-height` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 119 | `frame-total-cols` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 120 | `frame-total-lines` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 121 | `gnutls-boot` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 122 | `gnutls-ciphers` | gnutls.c (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 123 | `gnutls-error-string` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 124 | `gnutls-errorp` | gnutls.c (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 125 | `gnutls-format-certificate` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 126 | `gnutls-peer-status-warning-describe` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 127 | `gnutls-symmetric-decrypt` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 128 | `gnutls-symmetric-encrypt` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 129 | `handle-switch-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 130 | `help--describe-vector` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 131 | `innermost-minibuffer-p` | minibuf.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 132 | `internal-copy-lisp-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 133 | `internal-describe-syntax-value` | syntax.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 134 | `internal-face-x-get-resource` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 135 | `internal-get-lisp-face-attribute` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 136 | `internal-handle-focus-in` | keyboard.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 137 | `internal-lisp-face-empty-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 138 | `internal-lisp-face-equal-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 139 | `internal-lisp-face-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 140 | `internal-make-lisp-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 141 | `internal-merge-in-global-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 142 | `internal-set-alternative-font-family-alist` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 143 | `internal-set-alternative-font-registry-alist` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 144 | `internal-set-font-selection-order` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 145 | `internal-set-lisp-face-attribute` | xfaces.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 146 | `internal-set-lisp-face-attribute-from-resource` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 147 | `keymap--get-keyelt` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 148 | `kqueue-add-watch` | kqueue.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 149 | `make-serial-process` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 150 | `make-terminal-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 151 | `marker-last-position` | marker.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 152 | `menu-or-popup-active-p` | nsmenu.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 153 | `minibuffer-innermost-command-loop-p` | minibuf.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 154 | `ns-display-monitor-attributes-list` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 155 | `ns-frame-edges` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 156 | `ns-frame-geometry` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 157 | `ns-frame-list-z-order` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 158 | `ns-frame-restack` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 159 | `ns-mouse-absolute-pixel-position` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 160 | `ns-set-mouse-absolute-pixel-position` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 161 | `old-selected-window` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 162 | `process-thread` | process.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 163 | `resize-mini-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 164 | `resume-tty` | term.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 165 | `set-window-display-table` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 166 | `set-window-scroll-bars` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 167 | `store-kbd-macro-event` | macros.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 168 | `window-bottom-divider-width` | window.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 169 | `window-configuration-equal-p` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 170 | `window-left-column` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 171 | `window-old-buffer` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 172 | `window-old-pixel-height` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 173 | `window-old-pixel-width` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 174 | `window-scroll-bars` | window.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 175 | `window-top-line` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 176 | `x-close-connection` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 177 | `x-create-frame` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 178 | `x-display-backing-store` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 179 | `x-display-color-cells` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 180 | `x-display-mm-height` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 181 | `x-display-mm-width` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 182 | `x-display-planes` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 183 | `x-display-save-under` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 184 | `x-display-screens` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 185 | `x-display-visual-class` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 186 | `x-hide-tip` | nsfns.m (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 187 | `x-parse-geometry` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 188 | `x-select-font` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 189 | `x-server-version` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 190 | `xw-color-defined-p` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 191 | `xw-color-values` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 192 | `xw-display-color-p` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 193 | `xwidget-info` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 194 | `coding-system-plist` | coding.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 195 | `frame-scale-factor` | frame.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 196 | `set-fontset-font` | fontset.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 197 | `set-xwidget-query-on-exit-flag` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 198 | `xwidget-resize` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 199 | `xwidget-webkit-goto-uri` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 200 | `xwidget-webkit-uri` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |

### By piece of work

Packages needing at least one primitive of the group, per corpus, and those for which the group is all they lack (MELPA's by downloads, then Emacs's own).

| group | needed | score | emacs | melpa | daily | all they lack |
|---|---|---|---|---|---|---|
| mouse | 12 | 0.51 | 15 | 14 | 6 | 5: gnuplot, highlight, ediff (Emacs), project (Emacs), speedbar (Emacs) |
| tls-zlib | 13 | 0.48 | 13 | 11 | 7 | 14: pkg-info, haskell-mode, evil-tutor, consult, smex, marginalia, ert-runner, helpful |
| menus | 8 | 0.46 | 17 | 9 | 3 | 5: yasnippet, treemacs, lsp-treemacs, slime, eglot (Emacs) |
| frames | 37 | 0.34 | 11 | 11 | 3 | 6: ace-window, cfrs, winum, window-purpose, spacemacs-theme, server (Emacs) |
| window-tree | 21 | 0.30 | 8 | 11 | 4 | 5: persp-mode, doom-themes, visual-fill-column, forge, writeroom-mode |
| charsets-codings | 10 | 0.23 | 9 | 6 | 1 | 2: wgrep, geiser |
| keyboard | 5 | 0.22 | 7 | 8 | 2 | 1: company |
| xml | 3 | 0.19 | 3 | 8 | 4 | 4: cider, pip-requirements, devdocs, gh-md |
| macos-x | 25 | 0.18 | 6 | 2 | 2 | 0:  |
| keymaps | 6 | 0.17 | 6 | 6 | 1 | 2: transient, helm-descbinds |
| minibuffer | 5 | 0.17 | 6 | 5 | 1 | 2: ivy, swiper |
| treesit | 13 | 0.12 | 2 | 0 | 3 | 1: treesit (Emacs) |
| faces-fonts | 19 | 0.11 | 5 | 1 | 0 | 1: nerd-icons |
| process-objects | 3 | 0.09 | 3 | 0 | 1 | 0:  |
| buffer-text | 3 | 0.09 | 3 | 0 | 1 | 0:  |
| other | 4 | 0.08 | 4 | 0 | 0 | 0:  |
| xwidgets | 7 | 0.05 | 2 | 2 | 0 | 0:  |
| sqlite | 4 | 0.03 | 0 | 1 | 1 | 1: emacsql |
| files | 1 | 0.02 | 1 | 0 | 0 | 0:  |
| syntax-tables | 1 | 0.02 | 1 | 0 | 0 | 0:  |

### One-liners over what E8 has

Primitives E8 has no function for but a line of its API does (`demand-other-names.json`, `derived`), scored as above as if they were missing. Ports write them inline; giving them Emacs's names in `subr` would keep ports closer to the Lisp they follow.

| primitive | score | emacs packages | melpa packages | daily packages | in E8 |
|---|---|---|---|---|---|

### Wrappers from subr.el and Emacs's macros that E8 lacks by name

Those whose expansion or body calls a primitive E8 lacks: packages using each, per corpus, and the primitives it brings.

| wrapper | emacs | melpa | daily | brings |
|---|---|---|---|---|
| `symbol-file` | 8 | 11 | 5 | `zlib-available-p` |
| `track-mouse` | 6 | 4 |  | `internal--track-mouse` |
| `keymap-canonicalize` | 2 | 1 |  | `keymap-prompt` |
| `cal-menu-x-popup-menu` | 1 |  |  | `x-popup-menu` |
| `momentary-string-display` |  | 1 |  | `this-single-command-raw-keys` |

### MELPA packages nearest to needing nothing E8 lacks

Among MELPA's 150 most downloaded, those defining commands (three or more `interactive` forms), with the primitives and the libraries shipped with Emacs each still needs, its MELPA dependencies' included, fewest first. Those E8 has ported already are marked.

| package | downloads | primitives missing | libraries missing | ported |
|---|---|---|---|---|
| dash | 6,571,380 |  |  |  |
| avy | 2,555,368 |  |  |  |
| hydra | 2,181,296 |  |  |  |
| diminish | 1,739,448 |  |  |  |
| web-mode | 1,625,641 |  |  |  |
| hl-todo | 1,463,567 |  |  |  |
| iedit | 1,407,261 |  |  |  |
| yaml-mode | 1,340,155 |  |  |  |
| highlight-indentation | 1,336,453 |  |  |  |
| aggressive-indent | 1,308,083 |  |  |  |
| htmlize | 1,274,270 |  |  |  |
| auto-compile | 1,269,191 |  |  |  |
| dumb-jump | 1,243,915 |  |  |  |
| popwin | 1,172,453 |  |  |  |
| ace-link | 1,170,739 |  |  |  |
| paredit | 1,098,226 |  |  |  |
| auto-highlight-symbol | 1,067,739 |  |  |  |
| hungry-delete | 1,066,132 |  |  |  |
| helm-make | 1,046,315 |  |  |  |
| indent-guide | 1,017,888 |  |  |  |
| ws-butler | 1,005,643 |  |  |  |
| golden-ratio | 1,001,650 |  |  |  |
| eval-sexp-fu | 990,156 |  |  |  |
| lorem-ipsum | 930,747 |  |  |  |
| eyebrowse | 913,884 |  |  |  |
| move-text | 907,212 |  |  |  |
| column-enforce-mode | 837,233 |  |  |  |
| neotree | 814,366 |  |  |  |
| log4e | 783,678 |  |  |  |
| fill-column-indicator | 771,956 |  |  |  |

### Missing and needed by nothing in the corpus (103)

`bitmap-spec-p`, `cancel-kbd-macro-events`, `charset-id-internal`, `charset-plist`, `clear-charset-maps`, `clear-composition-cache`, `clear-face-cache`, `clear-font-cache`, `close-font`, `coding-system-put`, `compose-region-internal`, `compose-string-internal`, `composition-get-gstring`, `composition-sort-rules`, `current-input-mode`, `declare-equiv-charset`, `decode-big5-char`, `decode-sjis-char`, `define-charset-alias`, `define-charset-internal`, `define-coding-system-alias`, `define-coding-system-internal`, `encode-big5-char`, `encode-sjis-char`, `find-coding-systems-region-internal`, `find-composition-internal`, `font-get-glyphs`, `font-match-p`, `font-shape-gstring`, `font-variation-glyphs`, `frame-child-frame-border-width`, `frame-focus`, `frame-font-cache`, `frame-old-selected-window`, `frame-pointer-visible-p`, `frame-window-state-change`, `gap-position`, `gap-size`, `get-unicode-property-internal`, `get-unused-iso-final-char`, `internal--labeled-narrow-to-region`, `internal--labeled-widen`, `internal--set-buffer-modified-tick`, `internal-default-interrupt-process`, `internal-default-signal-process`, `iso-charset`, `lookup-image-map`, `lower-frame`, `make-category-set`, `map-charset-chars`, `message-or-box`, `multibyte-char-to-unibyte`, `newline-cache-check`, `old-selected-frame`, `open-dribble-file`, `open-font`, `open-termscript`, `optimize-char-table`, `posix-looking-at`, `posix-search-backward`, `posix-search-forward`, `posix-string-match`, `process-datagram-address`, `put-unicode-property-internal`, `re--describe-compiled`, `read-non-nil-coding-system`, `reconsider-frame-fonts`, `run-window-configuration-change-hook`, `serial-process-configure`, `set-buffer-redisplay`, `set-charset-plist`, `set-charset-priority`, `set-frame-window-state-change`, `set-input-interrupt-mode`, `set-input-meta-mode`, `set-input-mode`, `set-keyboard-coding-system-internal`, `set-minibuffer-window`, `set-output-flow-control`, `set-process-datagram-address`, `set-process-thread`, `set-quit-char`, `set-safe-terminal-coding-system-internal`, `set-terminal-coding-system-internal`, `set-window-cursor-type`, `sort-charsets`, `split-char`, `text-char-description`, `tool-bar-pixel-width`, `translate-region-internal`, `treesit-language-abi-version`, `treesit-library-abi-version`, `treesit-parser-notifiers`, `treesit-parser-remove-notifier`, `tty-suppress-bold-inverse-default-colors`, `unibyte-char-to-multibyte`, `unify-charset`, `window-cursor-type`, `window-old-body-pixel-height`, `window-old-body-pixel-width`, `window-old-point`, `x-family-fonts`, `x-load-color-file`
