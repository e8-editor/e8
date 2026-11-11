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

## Groups of work, in order

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

### Missing primitives by demand

Score: the share of each corpus's packages that need the primitive, directly or through a wrapper E8 also lacks, summed with weights emacs 1, melpa 1, daily 2. Each corpus's cell is packages / calls / uses through wrappers; the last column names the wrappers most of those come through.

| # | primitive | C file | score | emacs | melpa | daily | through |
|---|---|---|---|---|---|---|---|
| 1 | `current-local-map` | keymap.c | 1.95 | 40 / 194 / 28 | 75 / 217 / 25 | 34 / 97 / 14 | `local-set-key`, `define-compilation-mode` |
| 2 | `standard-syntax-table` | syntax.c | 1.44 | 30 / 132 / 1 | 60 / 179 / 4 | 24 / 75 / 1 | `define-compilation-mode` |
| 3 | `window-frame` | window.c | 1.11 | 34 / 173 / 104 | 30 / 57 / 18 | 12 / 27 / 24 | `with-output-to-temp-buffer`, `posn-col-row` |
| 4 | `set-process-sentinel` | process.c | 0.90 | 21 / 68 / 0 | 38 / 96 / 0 | 13 / 45 / 0 |  |
| 5 | `overlay-buffer` | buffer.c | 0.87 | 20 / 38 / 50 | 36 / 39 / 70 | 13 / 7 / 32 | `remove-overlays`, `copy-overlay` |
| 6 | `set-window-hscroll` | window.c | 0.80 | 27 / 29 / 62 | 20 / 13 / 11 | 7 / 12 / 11 | `with-output-to-temp-buffer`, `internal-temp-output-buffer-show` |
| 7 | `overlay-properties` | buffer.c | 0.72 | 18 / 6 / 50 | 27 / 2 / 70 | 10 / 2 / 32 | `remove-overlays`, `copy-overlay` |
| 8 | `set-process-filter` | process.c | 0.69 | 15 / 48 / 0 | 28 / 63 / 0 | 11 / 27 / 0 |  |
| 9 | `make-frame-visible` | frame.c | 0.66 | 25 / 9 / 62 | 13 / 3 / 11 | 4 / 0 / 11 | `with-output-to-temp-buffer`, `internal-temp-output-buffer-show` |
| 10 | `overlay-recenter` | buffer.c | 0.65 | 15 / 4 / 46 | 26 / 5 / 65 | 10 / 1 / 32 | `remove-overlays`, `custom-dirlocals-with-buffer` |
| 11 | `call-process-region` | callproc.c | 0.55 | 15 / 50 / 5 | 12 / 16 / 0 | 8 / 20 / 0 | `call-shell-region` |
| 12 | `current-global-map` | keymap.c | 0.51 | 12 / 15 / 83 | 24 / 13 / 63 | 7 / 3 / 41 | `global-set-key`, `global-key-binding` |
| 13 | `copy-keymap` | keymap.c | 0.44 | 12 / 28 / 0 | 13 / 19 / 0 | 6 / 14 / 0 |  |
| 14 | `window-hscroll` | window.c | 0.44 | 13 / 39 / 0 | 13 / 40 / 0 | 5 / 17 / 0 |  |
| 15 | `current-message` | editfns.c | 0.44 | 11 / 19 / 55 | 17 / 7 / 17 | 6 / 7 / 5 | `define-erc-module`, `with-temp-message` |
| 16 | `overlayp` | buffer.c | 0.43 | 11 / 50 / 0 | 22 / 55 / 0 | 5 / 14 / 0 |  |
| 17 | `zlib-available-p` | decompress.c (platform) | 0.40 | 10 / 4 / 11 | 11 / 0 / 14 | 6 / 3 / 7 | `symbol-file` |
| 18 | `string-to-syntax` | syntax.c | 0.39 | 8 / 72 / 0 | 13 / 70 / 0 | 7 / 32 / 0 |  |
| 19 | `frame-char-height` | frame.c | 0.39 | 9 / 44 / 23 | 14 / 33 / 6 | 6 / 6 / 9 | `posn-col-row` |
| 20 | `raise-frame` | frame.c | 0.37 | 12 / 33 / 0 | 7 / 9 / 0 | 4 / 6 / 0 |  |
| 21 | `set-marker-insertion-type` | marker.c | 0.36 | 8 / 23 / 0 | 11 / 19 / 0 | 6 / 11 / 0 |  |
| 22 | `x-popup-menu` | menu.c (platform) | 0.33 | 11 / 15 / 3 | 7 / 12 / 0 | 3 / 4 / 0 | `cal-menu-x-popup-menu` |
| 23 | `copy-syntax-table` | syntax.c | 0.32 | 9 / 18 / 0 | 11 / 25 / 0 | 4 / 15 / 0 |  |
| 24 | `default-file-modes` | fileio.c | 0.29 | 10 / 12 / 32 | 1 / 0 / 1 | 3 / 3 / 2 | `with-file-modes`, `eshell-with-private-file-modes` |
| 25 | `set-default-file-modes` | fileio.c | 0.29 | 10 / 2 / 32 | 1 / 0 / 1 | 3 / 6 / 2 | `with-file-modes`, `eshell-with-private-file-modes` |
| 26 | `process-filter` | process.c | 0.28 | 8 / 22 / 0 | 4 / 10 / 0 | 4 / 7 / 0 |  |
| 27 | `buffer-local-variables` | buffer.c | 0.26 | 11 / 17 / 0 | 3 / 5 / 0 | 1 / 4 / 0 |  |
| 28 | `frame-visible-p` | frame.c | 0.25 | 10 / 18 / 0 | 6 / 12 / 0 | 1 / 1 / 0 |  |
| 29 | `verify-visited-file-modtime` | fileio.c | 0.25 | 10 / 18 / 0 | 6 / 7 / 0 | 1 / 2 / 0 |  |
| 30 | `vertical-motion` | indent.c | 0.24 | 8 / 53 / 0 | 8 / 18 / 0 | 2 / 3 / 0 |  |
| 31 | `buffer-chars-modified-tick` | buffer.c | 0.24 | 7 / 31 / 19 | 13 / 40 / 0 | 2 / 18 / 19 | `org-fold-core-ignore-modifications`, `org-no-read-only` |
| 32 | `user-full-name` | editfns.c | 0.21 | 6 / 13 / 0 | 4 / 6 / 0 | 3 / 3 / 0 |  |
| 33 | `window-system` | frame.c | 0.21 | 6 / 20 / 0 | 10 / 14 / 0 | 2 / 8 / 0 |  |
| 34 | `position-bytes` | editfns.c | 0.20 | 4 / 10 / 0 | 5 / 11 / 0 | 4 / 14 / 0 |  |
| 35 | `replace-buffer-contents` | editfns.c | 0.18 | 5 / 6 / 0 | 1 / 1 / 0 | 3 / 4 / 0 |  |
| 36 | `this-single-command-raw-keys` | keyboard.c | 0.18 | 6 / 11 / 0 | 2 / 1 / 1 | 2 / 5 / 0 | `momentary-string-display` |
| 37 | `line-number-display-width` | indent.c | 0.17 | 6 / 9 / 0 | 7 / 13 / 0 | 1 / 1 / 0 |  |
| 38 | `set-window-vscroll` | window.c | 0.16 | 5 / 23 / 0 | 3 / 6 / 0 | 2 / 7 / 0 |  |
| 39 | `process-attributes` | process.c | 0.16 | 6 / 7 / 0 | 4 / 5 / 0 | 1 / 1 / 0 |  |
| 40 | `libxml-parse-html-region` | xml.c (platform) | 0.16 | 3 / 8 / 0 | 6 / 7 / 0 | 3 / 3 / 0 |  |
| 41 | `window-list-1` | window.c | 0.15 | 4 / 19 / 0 | 4 / 4 / 0 | 2 / 3 / 0 |  |
| 42 | `directory-files-and-attributes` | dired.c | 0.14 | 5 / 8 / 0 | 5 / 6 / 0 | 1 / 2 / 0 |  |
| 43 | `daemonp` | emacs.c (platform) | 0.14 | 5 / 15 / 0 | 4 / 10 / 0 | 1 / 1 / 0 |  |
| 44 | `overlay-lists` | buffer.c | 0.14 | 4 / 6 / 0 | 1 / 1 / 0 | 2 / 2 / 0 |  |
| 45 | `internal--track-mouse` | keyboard.c | 0.14 | 6 / 0 / 11 | 4 / 0 / 5 |  | `track-mouse` |
| 46 | `read-key-sequence-vector` | keyboard.c | 0.14 | 2 / 2 / 0 | 5 / 5 / 0 | 3 / 3 / 0 |  |
| 47 | `mouse-position` | frame.c | 0.13 | 5 / 9 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 48 | `scroll-right` | window.c | 0.13 | 6 / 9 / 0 | 3 / 4 / 0 |  |  |
| 49 | `process-sentinel` | process.c | 0.13 | 5 / 10 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 50 | `window-configuration-frame` | window.c | 0.13 | 2 / 2 / 0 | 3 / 3 / 0 | 3 / 3 / 0 |  |
| 51 | `window-parent` | window.c | 0.13 | 2 / 32 / 0 | 3 / 8 / 0 | 3 / 4 / 0 |  |
| 52 | `scroll-left` | window.c | 0.13 | 6 / 8 / 0 | 1 / 2 / 0 |  |  |
| 53 | `mouse-pixel-position` | frame.c | 0.12 | 4 / 10 / 0 | 5 / 7 / 0 | 1 / 1 / 0 |  |
| 54 | `current-idle-time` | keyboard.c | 0.12 | 3 / 5 / 0 | 2 / 5 / 0 | 2 / 4 / 0 |  |
| 55 | `force-window-update` | window.c | 0.12 | 3 / 4 / 0 | 2 / 2 / 0 | 2 / 5 / 0 |  |
| 56 | `window-pixel-width` | window.c | 0.12 | 4 / 20 / 0 | 3 / 8 / 0 | 1 / 1 / 0 |  |
| 57 | `set-mouse-position` | frame.c | 0.11 | 4 / 5 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 58 | `window-vscroll` | window.c | 0.11 | 4 / 19 / 0 | 2 / 19 / 0 | 1 / 2 / 0 |  |
| 59 | `transpose-regions` | editfns.c | 0.11 | 2 / 4 / 0 | 6 / 9 / 0 | 2 / 5 / 0 |  |
| 60 | `frame-parent` | frame.c | 0.11 | 3 / 12 / 0 | 7 / 8 / 0 | 1 / 2 / 0 |  |
| 61 | `gnutls-available-p` | gnutls.c (platform) | 0.11 | 4 / 14 / 0 |  | 1 / 2 / 0 |  |
| 62 | `frame-first-window` | window.c | 0.11 | 2 / 6 / 0 | 4 / 6 / 0 | 2 / 2 / 0 |  |
| 63 | `byte-to-position` | editfns.c | 0.10 | 2 / 3 / 0 | 3 / 4 / 0 | 2 / 4 / 0 |  |
| 64 | `libxml-parse-xml-region` | xml.c (platform) | 0.10 | 2 / 2 / 0 | 3 / 4 / 0 | 2 / 3 / 0 |  |
| 65 | `list-system-processes` | process.c | 0.10 | 3 / 4 / 0 | 3 / 4 / 0 | 1 / 2 / 0 |  |
| 66 | `next-frame` | frame.c | 0.09 | 2 / 13 / 0 |  | 2 / 2 / 0 |  |
| 67 | `treesit-induce-sparse-tree` | treesit.c | 0.09 | 2 / 4 / 0 |  | 2 / 2 / 0 |  |
| 68 | `keymap-prompt` | keymap.c | 0.09 | 4 / 2 / 2 | 3 / 5 / 1 |  | `keymap-canonicalize` |
| 69 | `group-gid` | editfns.c | 0.09 | 3 / 4 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 70 | `redirect-frame-focus` | frame.c | 0.09 | 3 / 3 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 71 | `window-pixel-height` | window.c | 0.09 | 2 / 22 / 0 | 7 / 16 / 0 | 1 / 8 / 0 |  |
| 72 | `libxml-available-p` | xml.c (platform) | 0.09 | 1 / 1 / 0 | 5 / 6 / 0 | 2 / 2 / 0 |  |
| 73 | `visible-frame-list` | frame.c | 0.09 | 1 / 1 / 0 | 5 / 6 / 0 | 2 / 2 / 0 |  |
| 74 | `terminal-live-p` | terminal.c (platform) | 0.09 | 4 / 11 / 0 | 2 / 3 / 0 |  |  |
| 75 | `frame-text-cols` | frame.c | 0.09 | 3 / 3 / 0 |  | 1 / 1 / 0 |  |
| 76 | `marker-insertion-type` | marker.c | 0.09 | 3 / 5 / 0 |  | 1 / 2 / 0 |  |
| 77 | `access-file` | fileio.c | 0.09 | 4 / 9 / 0 | 1 / 1 / 0 |  |  |
| 78 | `terminal-parameter` | terminal.c (platform) | 0.09 | 4 / 30 / 0 | 1 / 2 / 0 |  |  |
| 79 | `read-variable` | minibuf.c | 0.08 | 4 / 6 / 0 |  |  |  |
| 80 | `frame-terminal` | terminal.c (platform) | 0.08 | 2 / 6 / 0 | 3 / 8 / 0 | 1 / 1 / 0 |  |
| 81 | `window-header-line-height` | window.c | 0.08 | 2 / 9 / 0 | 3 / 3 / 0 | 1 / 1 / 0 |  |
| 82 | `x-focus-frame` | frame.c | 0.08 | 2 / 6 / 0 | 3 / 5 / 0 | 1 / 1 / 0 |  |
| 83 | `ns-do-applescript` | nsfns.m (platform) | 0.08 | 1 / 1 / 0 | 1 / 1 / 0 | 2 / 2 / 0 |  |
| 84 | `terminal-name` | terminal.c (platform) | 0.07 | 2 / 2 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 85 | `window-tab-line-height` | window.c | 0.07 | 2 / 7 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 86 | `treesit-search-forward` | treesit.c | 0.07 | 1 / 5 / 0 |  | 2 / 5 / 0 |  |
| 87 | `window-line-height` | window.c | 0.07 | 3 / 5 / 0 | 3 / 5 / 0 |  |  |
| 88 | `make-char` | charset.c | 0.07 | 2 / 2 / 0 | 1 / 1 / 0 | 1 / 14 / 0 |  |
| 89 | `map-keymap-internal` | keymap.c | 0.07 | 2 / 2 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 90 | `find-operation-coding-system` | coding.c | 0.07 | 3 / 3 / 0 | 2 / 2 / 0 |  |  |
| 91 | `process-plist` | process.c | 0.07 | 3 / 4 / 0 | 2 / 4 / 0 |  |  |
| 92 | `set-buffer-major-mode` | buffer.c | 0.07 | 3 / 4 / 0 | 2 / 2 / 0 |  |  |
| 93 | `frame-fringe-width` | frame.c | 0.07 | 2 / 3 / 0 |  | 1 / 2 / 0 |  |
| 94 | `frame-scroll-bar-width` | frame.c | 0.07 | 2 / 3 / 0 |  | 1 / 2 / 0 |  |
| 95 | `frame-text-lines` | frame.c | 0.07 | 2 / 2 / 0 |  | 1 / 1 / 0 |  |
| 96 | `treesit-node-match-p` | treesit.c | 0.07 | 2 / 10 / 0 |  | 1 / 8 / 0 |  |
| 97 | `treesit-search-subtree` | treesit.c | 0.07 | 2 / 11 / 0 |  | 1 / 4 / 0 |  |
| 98 | `window-at` | window.c | 0.07 | 2 / 2 / 0 |  | 1 / 1 / 0 |  |
| 99 | `delete-all-overlays` | buffer.c | 0.06 | 3 / 3 / 0 | 1 / 1 / 0 |  |  |
| 100 | `file-name-completion` | dired.c | 0.06 | 3 / 4 / 0 | 1 / 1 / 0 |  |  |
| 101 | `frame-text-height` | frame.c | 0.06 | 3 / 9 / 0 | 1 / 1 / 0 |  |  |
| 102 | `frame-text-width` | frame.c | 0.06 | 3 / 9 / 0 | 1 / 1 / 0 |  |  |
| 103 | `set-terminal-parameter` | terminal.c (platform) | 0.06 | 3 / 18 / 0 | 1 / 2 / 0 |  |  |
| 104 | `window-pixel-left` | window.c | 0.06 | 3 / 20 / 0 | 1 / 1 / 0 |  |  |
| 105 | `window-pixel-top` | window.c | 0.06 | 3 / 21 / 0 | 1 / 1 / 0 |  |  |
| 106 | `iconify-frame` | frame.c | 0.06 | 3 / 8 / 0 |  |  |  |
| 107 | `internal-char-font` | font.c | 0.06 | 3 / 4 / 0 |  |  |  |
| 108 | `recent-auto-save-p` | fileio.c | 0.06 | 3 / 6 / 0 |  |  |  |
| 109 | `tty-display-color-p` | term.c (platform) | 0.06 | 3 / 5 / 0 |  |  |  |
| 110 | `tty-type` | term.c (platform) | 0.06 | 3 / 3 / 0 |  |  |  |
| 111 | `unhandled-file-name-directory` | fileio.c | 0.06 | 3 / 3 / 0 |  |  |  |
| 112 | `unicode-property-table-internal` | chartab.c | 0.06 | 3 / 3 / 0 |  |  |  |
| 113 | `user-real-login-name` | editfns.c | 0.06 | 3 / 7 / 0 |  |  |  |
| 114 | `x-get-resource` | frame.c | 0.06 | 3 / 4 / 0 |  |  |  |
| 115 | `x-popup-dialog` | menu.c (platform) | 0.06 | 3 / 3 / 0 |  |  |  |
| 116 | `internal-default-process-filter` | process.c | 0.06 |  | 2 / 2 / 0 | 2 / 2 / 0 |  |
| 117 | `set-window-fringes` | window.c | 0.06 | 2 / 2 / 0 | 5 / 8 / 0 |  |  |
| 118 | `abort-minibuffers` | minibuf.c | 0.05 | 1 / 1 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 119 | `get-char-property-and-overlay` | textprop.c | 0.05 | 1 / 5 / 0 | 2 / 2 / 0 | 1 / 5 / 0 |  |
| 120 | `last-nonminibuffer-frame` | frame.c | 0.05 | 1 / 6 / 0 | 2 / 2 / 0 | 1 / 1 / 0 |  |
| 121 | `set-mouse-pixel-position` | frame.c | 0.05 | 1 / 1 / 0 | 2 / 4 / 0 | 1 / 1 / 0 |  |
| 122 | `combine-after-change-execute` | insdel.c | 0.05 | 2 / 0 / 4 | 3 / 0 / 4 |  | `combine-after-change-calls` |
| 123 | `get-byte` | character.c | 0.05 | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 124 | `group-name` | editfns.c | 0.05 | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 125 | `window-valid-p` | window.c | 0.05 | 1 / 7 / 0 | 1 / 2 / 0 | 1 / 1 / 0 |  |
| 126 | `frame-position` | frame.c | 0.05 | 2 / 3 / 0 | 2 / 5 / 0 |  |  |
| 127 | `set-process-plist` | process.c | 0.05 | 2 / 2 / 0 | 2 / 3 / 0 |  |  |
| 128 | `use-global-map` | keymap.c | 0.05 | 2 / 5 / 0 | 2 / 4 / 0 |  |  |
| 129 | `window-scroll-bar-width` | window.c | 0.05 | 2 / 4 / 0 | 2 / 2 / 0 |  |  |
| 130 | `buffer-last-name` | buffer.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 131 | `category-set-mnemonics` | category.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 132 | `set-network-process-option` | process.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 133 | `treesit-compiled-query-p` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 134 | `treesit-parser-add-notifier` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 135 | `treesit-parser-included-ranges` | treesit.c | 0.05 | 1 / 3 / 0 |  | 1 / 2 / 0 |  |
| 136 | `treesit-parser-set-included-ranges` | treesit.c | 0.05 | 1 / 4 / 0 |  | 1 / 3 / 0 |  |
| 137 | `treesit-query-expand` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 138 | `treesit-query-language` | treesit.c | 0.05 | 1 / 5 / 0 |  | 1 / 5 / 0 |  |
| 139 | `treesit-query-p` | treesit.c | 0.05 | 1 / 2 / 0 |  | 1 / 2 / 0 |  |
| 140 | `treesit-subtree-stat` | treesit.c | 0.05 | 1 / 1 / 0 |  | 1 / 1 / 0 |  |
| 141 | `unix-sync` | fileio.c | 0.05 | 1 / 2 / 0 |  | 1 / 1 / 0 |  |
| 142 | `zlib-decompress-region` | decompress.c (platform) | 0.05 | 1 / 1 / 0 |  | 1 / 3 / 0 |  |
| 143 | `make-pipe-process` | process.c | 0.04 | 2 / 2 / 0 | 1 / 1 / 0 |  |  |
| 144 | `next-read-file-uses-dialog-p` | fileio.c | 0.04 | 2 / 2 / 0 | 1 / 1 / 0 |  |  |
| 145 | `suspend-emacs` | keyboard.c | 0.04 | 2 / 4 / 0 | 1 / 1 / 0 |  |  |
| 146 | `x-display-pixel-height` | nsfns.m (platform) | 0.04 | 2 / 3 / 0 | 1 / 3 / 0 |  |  |
| 147 | `x-display-pixel-width` | nsfns.m (platform) | 0.04 | 2 / 3 / 0 | 1 / 3 / 0 |  |  |
| 148 | `buffer-swap-text` | buffer.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 149 | `file-system-info` | fileio.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 150 | `format-network-address` | process.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 151 | `frame--face-hash-table` | xfaces.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 152 | `frame-native-height` | frame.c | 0.04 | 2 / 5 / 0 |  |  |  |
| 153 | `frame-native-width` | frame.c | 0.04 | 2 / 5 / 0 |  |  |  |
| 154 | `frame-right-divider-width` | frame.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 155 | `getenv-internal` | callproc.c | 0.04 | 2 / 3 / 1 |  |  | `server-with-environment` |
| 156 | `gnutls-peer-status` | gnutls.c (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 157 | `message-box` | editfns.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 158 | `send-string-to-terminal` | dispnew.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 159 | `suspend-tty` | term.c (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 160 | `system-users` | dired.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 161 | `unlock-buffer` | filelock.c | 0.04 | 2 / 3 / 0 |  |  |  |
| 162 | `user-real-uid` | editfns.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 163 | `window-display-table` | window.c | 0.04 | 2 / 2 / 0 |  |  |  |
| 164 | `x-display-grayscale-p` | nsfns.m (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 165 | `x-display-list` | nsfns.m (platform) | 0.04 | 2 / 4 / 0 |  |  |  |
| 166 | `x-open-connection` | nsfns.m (platform) | 0.04 | 2 / 2 / 0 |  |  |  |
| 167 | `clear-this-command-keys` | keyboard.c | 0.04 | 1 / 4 / 0 | 5 / 9 / 0 |  |  |
| 168 | `internal-complete-buffer` | minibuf.c | 0.03 | 1 / 1 / 0 | 4 / 9 / 0 |  |  |
| 169 | `window-mode-line-height` | window.c | 0.03 | 1 / 2 / 0 | 4 / 4 / 0 |  |  |
| 170 | `set-frame-height` | frame.c | 0.03 | 1 / 1 / 0 | 3 / 3 / 0 |  |  |
| 171 | `sqlite-available-p` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 172 | `sqlite-close` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 173 | `sqlite-open` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 174 | `sqlite-select` | sqlite.c (platform) | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 175 | `syntax-table-p` | syntax.c | 0.03 |  | 1 / 1 / 0 | 1 / 1 / 0 |  |
| 176 | `describe-buffer-bindings` | keymap.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 177 | `other-window-for-scrolling` | window.c | 0.03 | 1 / 5 / 0 | 2 / 3 / 0 |  |  |
| 178 | `set-frame-position` | frame.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 179 | `set-frame-width` | frame.c | 0.03 | 1 / 1 / 0 | 2 / 2 / 0 |  |  |
| 180 | `gnutls-hash-mac` | gnutls.c (platform) | 0.03 |  |  | 1 / 6 / 0 |  |
| 181 | `insert-byte` | editfns.c | 0.03 |  |  | 1 / 1 / 0 |  |
| 182 | `treesit-pattern-expand` | treesit.c | 0.03 |  |  | 1 / 1 / 0 |  |
| 183 | `delete-terminal` | terminal.c (platform) | 0.02 | 1 / 3 / 0 | 1 / 1 / 0 |  |  |
| 184 | `find-charset-string` | charset.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 185 | `keyboard-coding-system` | coding.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 186 | `make-xwidget` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 187 | `network-interface-list` | process.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 188 | `set--this-command-keys` | keyboard.c | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 189 | `terminal-coding-system` | coding.c | 0.02 | 1 / 2 / 0 | 1 / 1 / 0 |  |  |
| 190 | `tty-display-color-cells` | term.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 191 | `window-next-sibling` | window.c | 0.02 | 1 / 22 / 0 | 1 / 1 / 0 |  |  |
| 192 | `window-right-divider-width` | window.c | 0.02 | 1 / 2 / 0 | 1 / 1 / 0 |  |  |
| 193 | `window-scroll-bar-height` | window.c | 0.02 | 1 / 3 / 0 | 1 / 1 / 0 |  |  |
| 194 | `x-show-tip` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 195 | `xwidget-webkit-execute-script` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 | 1 / 1 / 0 |  |  |
| 196 | `accessible-keymaps` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 197 | `char-resolve-modifiers` | character.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 198 | `charset-after` | charset.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 199 | `command-error-default-function` | keyboard.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 200 | `controlling-tty-p` | term.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 201 | `coordinates-in-window-p` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 202 | `delete-directory-internal` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 203 | `delete-file-internal` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 204 | `delete-other-windows-internal` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 205 | `delete-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 206 | `describe-vector` | keymap.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 207 | `display--line-is-continued-p` | xdisp.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 208 | `display--update-for-mouse-movement` | dispnew.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 209 | `face-attributes-as-vector` | xfaces.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 210 | `file-acl` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 211 | `file-selinux-context` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 212 | `find-charset-region` | charset.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 213 | `font-face-attributes` | font.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 214 | `fontset-list` | fontset.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 215 | `frame--set-was-invisible` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 216 | `frame-after-make-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 217 | `frame-ancestor-p` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 218 | `frame-bottom-divider-width` | frame.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 219 | `frame-internal-border-width` | frame.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 220 | `frame-scroll-bar-height` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 221 | `frame-total-cols` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 222 | `frame-total-lines` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 223 | `get-truename-buffer` | buffer.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 224 | `gnutls-boot` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 225 | `gnutls-ciphers` | gnutls.c (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 226 | `gnutls-error-string` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 227 | `gnutls-errorp` | gnutls.c (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 228 | `gnutls-format-certificate` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 229 | `gnutls-peer-status-warning-describe` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 230 | `gnutls-symmetric-decrypt` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 231 | `gnutls-symmetric-encrypt` | gnutls.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 232 | `handle-switch-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 233 | `help--describe-vector` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 234 | `innermost-minibuffer-p` | minibuf.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 235 | `internal-copy-lisp-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 236 | `internal-describe-syntax-value` | syntax.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 237 | `internal-face-x-get-resource` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 238 | `internal-get-lisp-face-attribute` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 239 | `internal-handle-focus-in` | keyboard.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 240 | `internal-lisp-face-empty-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 241 | `internal-lisp-face-equal-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 242 | `internal-lisp-face-p` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 243 | `internal-make-lisp-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 244 | `internal-merge-in-global-face` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 245 | `internal-set-alternative-font-family-alist` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 246 | `internal-set-alternative-font-registry-alist` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 247 | `internal-set-font-selection-order` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 248 | `internal-set-lisp-face-attribute` | xfaces.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 249 | `internal-set-lisp-face-attribute-from-resource` | xfaces.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 250 | `keymap--get-keyelt` | keymap.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 251 | `kqueue-add-watch` | kqueue.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 252 | `lock-buffer` | filelock.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 253 | `lock-file` | filelock.c | 0.02 | 1 / 1 / 5 |  |  | `tramp-skeleton-write-region` |
| 254 | `make-directory-internal` | fileio.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 255 | `make-serial-process` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 256 | `make-temp-file-internal` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 257 | `make-terminal-frame` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 258 | `marker-last-position` | marker.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 259 | `menu-or-popup-active-p` | nsmenu.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 260 | `minibuffer-innermost-command-loop-p` | minibuf.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 261 | `minor-mode-key-binding` | keymap.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 262 | `network-lookup-address-info` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 263 | `ns-display-monitor-attributes-list` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 264 | `ns-frame-edges` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 265 | `ns-frame-geometry` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 266 | `ns-frame-list-z-order` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 267 | `ns-frame-restack` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 268 | `ns-mouse-absolute-pixel-position` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 269 | `ns-set-mouse-absolute-pixel-position` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 270 | `num-processors` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 271 | `old-selected-window` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 272 | `previous-frame` | frame.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 273 | `process-inherit-coding-system-flag` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 274 | `process-thread` | process.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 275 | `resize-mini-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 276 | `resume-tty` | term.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 277 | `run-window-scroll-functions` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 278 | `set-buffer-auto-saved` | fileio.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 279 | `set-file-acl` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 280 | `set-file-selinux-context` | fileio.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 281 | `set-process-inherit-coding-system-flag` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 282 | `set-window-combination-limit` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 283 | `set-window-display-table` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 284 | `set-window-new-normal` | window.c | 0.02 | 1 / 23 / 0 |  |  |  |
| 285 | `set-window-new-pixel` | window.c | 0.02 | 1 / 12 / 0 |  |  |  |
| 286 | `set-window-new-total` | window.c | 0.02 | 1 / 10 / 0 |  |  |  |
| 287 | `set-window-scroll-bars` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 288 | `signal-names` | process.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 289 | `split-window-internal` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 290 | `store-kbd-macro-event` | macros.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 291 | `system-groups` | dired.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 292 | `system-move-file-to-trash` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 293 | `unlock-file` | filelock.c | 0.02 | 1 / 1 / 5 |  |  | `tramp-skeleton-write-region` |
| 294 | `waiting-for-user-input-p` | process.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 295 | `window-bottom-divider-width` | window.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 296 | `window-bump-use-time` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 297 | `window-combination-limit` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 298 | `window-configuration-equal-p` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 299 | `window-left-child` | window.c | 0.02 | 1 / 10 / 0 |  |  |  |
| 300 | `window-left-column` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 301 | `window-lines-pixel-dimensions` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 302 | `window-new-normal` | window.c | 0.02 | 1 / 21 / 0 |  |  |  |
| 303 | `window-new-pixel` | window.c | 0.02 | 1 / 9 / 0 |  |  |  |
| 304 | `window-new-total` | window.c | 0.02 | 1 / 8 / 0 |  |  |  |
| 305 | `window-normal-size` | window.c | 0.02 | 1 / 21 / 0 |  |  |  |
| 306 | `window-old-buffer` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 307 | `window-old-pixel-height` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 308 | `window-old-pixel-width` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 309 | `window-prev-sibling` | window.c | 0.02 | 1 / 9 / 0 |  |  |  |
| 310 | `window-resize-apply` | window.c | 0.02 | 1 / 4 / 0 |  |  |  |
| 311 | `window-resize-apply-total` | window.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 312 | `window-scroll-bars` | window.c | 0.02 | 1 / 3 / 0 |  |  |  |
| 313 | `window-top-child` | window.c | 0.02 | 1 / 9 / 0 |  |  |  |
| 314 | `window-top-line` | window.c | 0.02 | 1 / 2 / 0 |  |  |  |
| 315 | `x-close-connection` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 316 | `x-create-frame` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 317 | `x-display-backing-store` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 318 | `x-display-color-cells` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 319 | `x-display-mm-height` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 320 | `x-display-mm-width` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 321 | `x-display-planes` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 322 | `x-display-save-under` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 323 | `x-display-screens` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 324 | `x-display-visual-class` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 325 | `x-hide-tip` | nsfns.m (platform) | 0.02 | 1 / 2 / 0 |  |  |  |
| 326 | `x-parse-geometry` | frame.c | 0.02 | 1 / 1 / 0 |  |  |  |
| 327 | `x-select-font` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 328 | `x-server-version` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 329 | `xw-color-defined-p` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 330 | `xw-color-values` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 331 | `xw-display-color-p` | nsfns.m (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 332 | `xwidget-info` | xwidget.c (platform) | 0.02 | 1 / 1 / 0 |  |  |  |
| 333 | `make-frame-invisible` | frame.c | 0.02 |  | 5 / 7 / 0 |  |  |
| 334 | `coding-system-plist` | coding.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 335 | `frame-scale-factor` | frame.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 336 | `network-interface-info` | process.c | 0.00 |  | 1 / 2 / 0 |  |  |
| 337 | `set-binary-mode` | fileio.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 338 | `set-fontset-font` | fontset.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 339 | `set-xwidget-query-on-exit-flag` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 340 | `syntax-class-to-char` | syntax.c | 0.00 |  | 1 / 1 / 0 |  |  |
| 341 | `xwidget-resize` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 342 | `xwidget-webkit-goto-uri` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |
| 343 | `xwidget-webkit-uri` | xwidget.c (platform) | 0.00 |  | 1 / 1 / 0 |  |  |

### By piece of work

Packages needing at least one primitive of the group, per corpus, and those for which the group is all they lack (MELPA's by downloads, then Emacs's own).

| group | needed | score | emacs | melpa | daily | all they lack |
|---|---|---|---|---|---|---|
| keymaps | 12 | 2.18 | 43 | 92 | 38 | 8: hydra, helm-projectile, evil-surround, helm-descbinds, magit-popup, lorem-ipsum, move-text, dotenv-mode |
| syntax-tables | 6 | 1.61 | 32 | 69 | 28 | 2: hl-todo, llama |
| window-tree | 49 | 1.29 | 36 | 42 | 16 | 4: popwin, ace-link, doom-themes, page-break-lines |
| frames | 52 | 1.25 | 34 | 40 | 16 | 5: powerline, cfrs, org-download, treemacs-evil, spacemacs-theme |
| process-objects | 23 | 1.22 | 30 | 50 | 17 | 14: request, pfuture, simple-httpd, deferred, uuidgen, pythonic, markdown-toc, websocket |
| buffer-text | 16 | 1.19 | 28 | 44 | 18 | 6: aggressive-indent, paredit, column-enforce-mode, linum-relative, evil-cleverparens, helm-org |
| scrolling | 13 | 1.08 | 33 | 37 | 11 | 3: golden-ratio, flycheck-pos-tip, live-py-mode |
| overlay-objects | 7 | 1.06 | 26 | 49 | 14 | 11: macrostep, multiple-cursors, package-lint, auto-highlight-symbol, indent-guide, evil-goggles, emmet-mode, org-mime |
| files | 26 | 0.64 | 23 | 13 | 5 | 0:  |
| user-system | 10 | 0.55 | 19 | 9 | 5 | 1: restart-emacs |
| mouse | 12 | 0.51 | 15 | 14 | 6 | 0:  |
| tls-zlib | 13 | 0.48 | 13 | 11 | 7 | 1: pkg-info |
| menus | 8 | 0.46 | 17 | 9 | 3 | 1: lsp-treemacs |
| charsets-codings | 10 | 0.23 | 9 | 6 | 1 | 0:  |
| keyboard | 5 | 0.22 | 7 | 8 | 2 | 0:  |
| xml | 3 | 0.19 | 3 | 8 | 4 | 1: gh-md |
| macos-x | 25 | 0.18 | 6 | 2 | 2 | 0:  |
| minibuffer | 5 | 0.17 | 6 | 5 | 1 | 0:  |
| other | 5 | 0.13 | 5 | 1 | 1 | 0:  |
| treesit | 13 | 0.12 | 2 | 0 | 3 | 0:  |
| faces-fonts | 19 | 0.11 | 5 | 1 | 0 | 1: nerd-icons |
| xwidgets | 7 | 0.05 | 2 | 2 | 0 | 0:  |
| sqlite | 4 | 0.03 | 0 | 1 | 1 | 0:  |

### One-liners over what E8 has

Primitives E8 has no function for but a line of its API does (`demand-other-names.json`, `derived`), scored as above as if they were missing. Ports write them inline; giving them Emacs's names in `subr` would keep ports closer to the Lisp they follow.

| primitive | score | emacs packages | melpa packages | daily packages | in E8 |
|---|---|---|---|---|---|
| `erase-buffer` | 2.15 | 44 | 87 | 37 | e8.deleteRegion over the whole buffer, widened |
| `eobp` | 2.02 | 43 | 91 | 32 | e8.point() === e8.pointMax() |
| `buffer-string` | 1.92 | 36 | 88 | 34 | e8.bufferSubstring(e8.pointMin(), e8.pointMax()) |
| `regexp-quote` | 1.88 | 40 | 107 | 27 | a line of JavaScript over Emacs's special characters |
| `get-buffer-window` | 1.53 | 37 | 51 | 23 | e8.windowList().find(w => e8.windowBuffer(w) === b) |
| `bobp` | 1.45 | 36 | 51 | 21 | e8.point() === e8.pointMin() |
| `window-live-p` | 1.40 | 39 | 55 | 16 | e8.windowList().includes(w) |
| `bolp` | 1.39 | 33 | 43 | 22 | e8.point() === e8.lineBeginningPosition() |
| `region-beginning` | 1.31 | 24 | 66 | 23 | Math.min(e8.point(), e8.mark()), or a region-beginning parameter |
| `region-end` | 1.31 | 24 | 65 | 23 | Math.max(e8.point(), e8.mark()), or a region-end parameter |
| `frame-live-p` | 1.21 | 36 | 49 | 12 | e8.frameList().includes(f) |
| `point-marker` | 1.21 | 31 | 39 | 17 | e8.makeMarker(e8.point()) |
| `copy-marker` | 1.08 | 31 | 31 | 13 | e8.makeMarker(pos) |
| `eolp` | 1.05 | 27 | 41 | 14 | e8.point() === e8.lineEndPosition() |
| `add-text-properties` | 1.04 | 29 | 32 | 13 | e8.putTextProperty per property |
| `set-text-properties` | 0.70 | 22 | 21 | 7 | e8.removeTextProperty then e8.putTextProperty |
| `remove-text-properties` | 0.70 | 19 | 23 | 9 | e8.removeTextProperty per property |
| `get-char-property` | 0.70 | 20 | 32 | 7 | e8.overlaysAt with e8.overlayGet, then e8.getTextProperty |
| `framep` | 0.59 | 18 | 12 | 7 | e8.frameList().includes(f) |
| `windowp` | 0.53 | 17 | 16 | 5 | typeof w === 'number' |
| `active-minibuffer-window` | 0.43 | 10 | 22 | 6 | e8.minibufferDepth() > 0 ? e8.minibufferWindow() : undefined |
| `window-minibuffer-p` | 0.43 | 13 | 17 | 4 | w === e8.minibufferWindow() |
| `remove-list-of-text-properties` | 0.40 | 14 | 11 | 3 | e8.removeTextProperty per property |
| `processp` | 0.40 | 14 | 11 | 3 | e8.processList().includes(p) |
| `point-min-marker` | 0.38 | 10 | 5 | 6 | e8.makeMarker(e8.pointMin()) |
| `insert-char` | 0.37 | 12 | 15 | 3 | e8.insert(c.repeat(n)) |
| `process-name` | 0.33 | 7 | 9 | 6 | processes are named by strings |
| `point-max-marker` | 0.32 | 9 | 2 | 5 | e8.makeMarker(e8.pointMax()) |
| `directory-name-p` | 0.24 | 7 | 7 | 3 | name.endsWith('/') |
| `get-process` | 0.21 | 7 | 5 | 2 | processes are named by strings: e8.processList |
| `barf-if-buffer-read-only` | 0.21 | 7 | 5 | 2 | e8.bufferReadOnly() then e8.signal |
| `car-less-than-car` | 0.18 | 3 | 4 | 4 | a sort comparator |

### Wrappers from subr.el and Emacs's macros that E8 lacks by name

Those whose expansion or body calls a primitive E8 lacks: packages using each, per corpus, and the primitives it brings.

| wrapper | emacs | melpa | daily | brings |
|---|---|---|---|---|
| `remove-overlays` | 14 | 24 | 10 | `overlay-buffer`, `overlay-properties`, `overlay-recenter` |
| `internal-temp-output-buffer-show` | 22 | 10 | 4 | `make-frame-visible`, `set-window-hscroll`, `window-frame` |
| `with-output-to-temp-buffer` | 22 | 10 | 4 | `make-frame-visible`, `set-window-hscroll`, `window-frame` |
| `symbol-file` | 8 | 11 | 5 | `zlib-available-p` |
| `local-set-key` | 7 | 7 | 4 | `current-local-map` |
| `with-file-modes` | 10 | 1 | 1 | `default-file-modes`, `set-default-file-modes` |
| `global-set-key` | 6 | 11 | 2 | `current-global-map` |
| `with-temp-message` | 5 | 6 | 3 | `current-message` |
| `global-key-binding` | 3 | 2 | 4 | `current-global-map` |
| `track-mouse` | 6 | 4 |  | `internal--track-mouse` |
| `posn-col-row` | 3 | 3 | 2 | `frame-char-height`, `window-frame` |
| `with-minibuffer-selected-window` | 3 | 1 | 2 | `window-frame` |
| `copy-overlay` | 4 | 4 |  | `overlay-buffer`, `overlay-properties` |
| `define-global-minor-mode` | 1 | 6 | 1 | `current-message` |
| `call-shell-region` | 3 |  |  | `call-process-region` |
| `define-compilation-mode` | 1 | 4 | 1 | `current-local-map`, `standard-syntax-table` |
| `combine-after-change-calls` | 2 | 3 |  | `combine-after-change-execute` |
| `global-unset-key` | 2 | 2 |  | `current-global-map` |
| `org-fold-core-ignore-modifications` | 1 |  | 1 | `buffer-chars-modified-tick` |
| `org-no-read-only` | 1 |  | 1 | `buffer-chars-modified-tick` |
| `keymap-canonicalize` | 2 | 1 |  | `keymap-prompt` |
| `local-key-binding` | 2 |  |  | `current-local-map` |
| `local-unset-key` |  | 1 | 1 | `current-local-map` |
| `with-existing-directory` | 1 |  |  | `default-file-modes`, `set-default-file-modes` |
| `cal-menu-x-popup-menu` | 1 |  |  | `x-popup-menu` |
| `custom-dirlocals-with-buffer` | 1 |  |  | `overlay-buffer`, `overlay-properties`, `overlay-recenter` |
| `define-erc-module` | 1 |  |  | `current-message` |
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
| highlight-indentation | 1,336,453 |  |  |  |
| htmlize | 1,274,270 |  |  |  |
| auto-compile | 1,269,191 |  |  |  |
| dumb-jump | 1,243,915 |  |  |  |
| hungry-delete | 1,066,132 |  |  |  |
| helm-make | 1,046,315 |  |  |  |
| ws-butler | 1,005,643 |  |  |  |
| eval-sexp-fu | 990,156 |  |  |  |
| eyebrowse | 913,884 |  |  |  |
| anzu | 1,509,594 |  | `thingatpt` |  |
| hl-todo | 1,463,567 | `copy-syntax-table` |  |  |
| aggressive-indent | 1,308,083 | `set-marker-insertion-type` |  |  |
| evil-matchit | 1,176,108 |  | `semantic/lex` |  |
| popwin | 1,172,453 | `frame-first-window` |  |  |
| paredit | 1,098,226 | `set-marker-insertion-type` |  |  |
| auto-highlight-symbol | 1,067,739 | `overlayp` |  |  |
| toc-org | 1,061,694 |  | `thingatpt` |  |
| golden-ratio | 1,001,650 | `scroll-right` |  |  |
| lorem-ipsum | 930,747 | `current-global-map` |  |  |
| move-text | 907,212 | `current-global-map` |  |  |
| pyvenv | 871,591 |  | `eshell` |  |
| column-enforce-mode | 837,233 | `current-message` |  |  |
| elisp-slime-nav | 1,291,656 |  | `etags`, `help-mode` |  |
| visual-fill-column | 845,569 | `current-global-map`, `set-window-fringes` |  |  |
| neotree | 814,366 | `current-local-map`, `standard-syntax-table` |  |  |
| log4e | 783,678 | `current-local-map`, `standard-syntax-table` |  |  |
| avy | 2,555,368 | `copy-syntax-table`, `raise-frame`, `window-frame` |  |  |
| pkg-info | 2,544,135 | `zlib-available-p` | `package`, `url-http` |  |

### Missing and needed by nothing in the corpus (110)

`bitmap-spec-p`, `cancel-kbd-macro-events`, `charset-id-internal`, `charset-plist`, `clear-buffer-auto-save-failure`, `clear-charset-maps`, `clear-composition-cache`, `clear-face-cache`, `clear-font-cache`, `close-font`, `coding-system-put`, `compose-region-internal`, `compose-string-internal`, `composition-get-gstring`, `composition-sort-rules`, `compute-motion`, `current-input-mode`, `current-minor-mode-maps`, `declare-equiv-charset`, `decode-big5-char`, `decode-sjis-char`, `define-charset-alias`, `define-charset-internal`, `define-coding-system-alias`, `define-coding-system-internal`, `encode-big5-char`, `encode-sjis-char`, `file-attributes-lessp`, `find-coding-systems-region-internal`, `find-composition-internal`, `font-get-glyphs`, `font-match-p`, `font-shape-gstring`, `font-variation-glyphs`, `frame-child-frame-border-width`, `frame-focus`, `frame-font-cache`, `frame-old-selected-window`, `frame-pointer-visible-p`, `frame-window-state-change`, `gap-position`, `gap-size`, `get-unicode-property-internal`, `get-unused-iso-final-char`, `group-real-gid`, `internal--labeled-narrow-to-region`, `internal--labeled-widen`, `internal--set-buffer-modified-tick`, `internal-default-interrupt-process`, `internal-default-process-sentinel`, `internal-default-signal-process`, `iso-charset`, `lookup-image-map`, `lower-frame`, `make-category-set`, `map-charset-chars`, `message-or-box`, `multibyte-char-to-unibyte`, `newline-cache-check`, `old-selected-frame`, `open-dribble-file`, `open-font`, `open-termscript`, `optimize-char-table`, `posix-looking-at`, `posix-search-backward`, `posix-search-forward`, `posix-string-match`, `process-datagram-address`, `process-running-child-p`, `put-unicode-property-internal`, `re--describe-compiled`, `read-non-nil-coding-system`, `reconsider-frame-fonts`, `run-window-configuration-change-hook`, `serial-process-configure`, `set-buffer-redisplay`, `set-charset-plist`, `set-charset-priority`, `set-frame-window-state-change`, `set-input-interrupt-mode`, `set-input-meta-mode`, `set-input-mode`, `set-keyboard-coding-system-internal`, `set-minibuffer-window`, `set-output-flow-control`, `set-process-datagram-address`, `set-process-thread`, `set-quit-char`, `set-safe-terminal-coding-system-internal`, `set-terminal-coding-system-internal`, `set-window-cursor-type`, `sort-charsets`, `split-char`, `text-char-description`, `tool-bar-pixel-width`, `translate-region-internal`, `treesit-language-abi-version`, `treesit-library-abi-version`, `treesit-parser-notifiers`, `treesit-parser-remove-notifier`, `tty-suppress-bold-inverse-default-colors`, `unibyte-char-to-multibyte`, `unify-charset`, `window-cursor-type`, `window-old-body-pixel-height`, `window-old-body-pixel-width`, `window-old-point`, `x-family-fonts`, `x-load-color-file`
