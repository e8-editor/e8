# 0110. News in help: etc/NEWS on C-h n, a package's NEWS in describe-package, and E8's own name for what is E8's

Status: accepted · 2026-11-17

## Context

E8 had no release notes inside it. Each GitHub Release listed the titles of its pull requests, which the release workflow's `--generate-notes` gathers, and the packages that are repositories of their own ([ADR 0059](0059-packages-are-git-repositories.md)) kept no record of their changes at all. Someone upgrading E8 or a package had no way to see in the editor what had changed.

Emacs answers both. `C-h n` (`view-emacs-news`) shows `etc/NEWS`, an outline with a heading for each release and one under it for each change, and `C-u C-h n` narrows it to one release. `C-h P` (`describe-package`) shows a package's status, version, requirements and description, and since Emacs 29 the package's `news` file under a `* News` heading after its description.

The command's Emacs name raised a second question: `view-emacs-news` shows E8's news, not Emacs's.

## Options considered

1. **News at the bottom of `describe-mode`.** Changes are about a package, not a mode: consult has no mode and magit has dozens, so a mode is the wrong place to look.
2. **A changelog page on the website or GitHub only.** Nothing to build, but nothing in the editor either, and it would not reach a package's changes.
3. **Emacs's own design.** `etc/NEWS` in Emacs's NEWS format, carried in the binary, on `C-h n`; `describe-package` on `C-h P` with an installed package's `NEWS` under its description; each package repository keeping a `NEWS` in the same format.

For the name:

1. **Keep Emacs's names everywhere.** Configurations and habits carry over, but the editor names Emacs where it means itself.
2. **Only E8's names.** Reads right, but every configuration written for Emacs that calls the command breaks, and agents porting one have another thing to know.
3. **E8's name for what is E8's, Emacs's as another name for it.** `e8-version` already stands for `emacs-version` in this way ([ADR 0059](0059-packages-are-git-repositories.md)).

## Decision

Emacs's design, option 3. `etc/NEWS` is carried in the binary (`e8.dataFile("NEWS")`, as Emacs reads it from `data-directory`) and shown by `view-e8-news` on `C-h n` and `C-h C-n` in `e8-news-view-mode`: read-only, its headings folding with TAB, quoted names that are commands, variables or faces buttons to their help. `describe-package` on `C-h P` describes a package installed from its repository (status, version, commit, summary, requirements, what requires it, its README as Emacs chooses one, and its `NEWS` or `news`) or one that ships with E8 (the comment its file starts with).

A name that means E8 itself, its version or its news, is E8's, and where Emacs code would call the Emacs name, that name is an alias (`view-emacs-news`). Names for what E8 shares with Emacs keep Emacs's: `emacs-lisp-mode` is for Emacs Lisp, and `user-emacs-directory`, `emacs-startup-hook` and `kill-emacs` are what configurations call. Renaming more of these is left until it is asked for.

The news of a release is written by the pull request that bumps the version, from the pull requests merged since the last tag, so feature branches do not all change the top of the one file. The release workflow puts that section at the head of the GitHub Release's notes. A package repository adds its section when it is tagged.

## Consequences

`C-h n` shows what changed, offline and at the version installed. The release routine has one more step: writing the section, in words for users rather than pull request titles. The past releases' sections were written from their pull requests when this landed.

A release's heading is found by the version that ends the line, as E8's name has a digit in it before the version, where Emacs's finds the first number.

## Dependencies introduced

None.
