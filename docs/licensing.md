# Licensing notes

Status: GPL, as [ADR 0014](adr/0014-gpl.md) records, and public since 2026-11-06

Nothing here is legal advice. These notes record what we know and what we have done, and what a permissive core or an App Store build would mean later.

## Where we stand

- E8 is GPL-3.0-or-later as a whole for now ([ADR 0014](adr/0014-gpl.md)): `LICENSE` holds the licence and `Cargo.toml` says so. Porting from Emacs and Org can go on.
- E8 is distributed: `e8-editor/e8` has been public since 2026-11-06, and its releases are binaries built from the tagged source in the same repository, which is how the GPL's offer of source is met ([ADR 0060](adr/0060-releases.md)). What has been published under the GPL stays available under it; a permissive core later would be built from code we wrote ourselves, as it always would have been.
- Ports of packages Emacs does not ship are to move to repositories of their own in `e8-editor`, one per package, each under its upstream's licence, with its authors' copyright, a notice that it is a port, the full licence text and a README saying it is unofficial ([ADR 0059](adr/0059-packages-are-git-repositories.md)). Making those repositories public distributes their source, which the GPL and the permissive licences allow with those notices. All the ports have moved: vertico, orderless, marginalia, consult, magit-section, magit, with-editor, org-roam, consult-org-roam, casual and popper under GPL-3.0-or-later, as their upstreams are; persistent-scratch under its upstream's BSD-2-Clause. The themes are one repository, `e8-themes` ([ADR 0067](adr/0067-themes-are-one-collection.md)), GPL-3.0-or-later as a whole, each theme's file under its upstream's licence, MIT (Nord, Gruvbox, Catppuccin, Dracula, Doom's) or GPL-3.0-or-later (Modus, Leuven and Wombat from Emacs, Solarized, Tomorrow, Zenburn), with its copyright lines. Each file keeps its upstream's copyright lines and adds the E8 contributors', and each README credits the upstream and says the port is not its authors' work. `examples/packages/` keeps only `example-theme.ts`, E8's own. Only licences that combine with GPL-3.0-or-later are taken, so not GPL-2.0-only.
- The rest of these notes stay for if a permissive core or an App Store build becomes important later.

## The long-term aim

E8 is meant to become a modern platform in the spirit of Emacs, not an Org editor. Org is one package among many. The editor should run in a terminal, in a window, in a web browser and as an iPhone and iPad app. A small paid App Store build could cover the Apple Developer fee.

## Code derived from GPL source

On 2026-10-28, against [ADR 0013](adr/0013-following-org-closely.md), code was ported closely from GNU Emacs and Org (GPLv3 or later, copyright the Free Software Foundation). A close translation from Lisp or C to TypeScript or Rust is very likely a derivative work, and the GPL explicitly covers translations.

Known to be derived, from the sessions that ported them:

- `packages/org.ts`: most of it, ported function by function from org.el, org-list.el, org-fold.el, org-fold-core.el, org-element.el and ol.el.
- `packages/org-table.ts`: from org-table.el.
- `packages/simple.ts`: parts follow simple.el, such as `transpose-chars`, `transpose-words`, `transpose-lines`, `newline`, `open-line` and `electric-newline-and-maybe-indent`.
- `packages/outline.ts`: `outline-up-heading` follows outline.el.
- `packages/acp.ts`: from acp.el 0.18.2 (GPL-3.0-or-later, copyright Alvaro Ramirez), closely, function by function; its header carries that copyright and says it is a port, as [ADR 0059](adr/0059-packages-are-git-repositories.md)'s rules for ports ask.
- Not derived: `packages/agent-shell.ts` follows agent-shell's design, its commands' names and its permission keys, written for E8's Org agent buffer without its code.
- `crates/e8-core/src/buffer.rs`: undo in a region (from simple.el's `undo-make-selective-list`, `undo-adjust-elt`, `undo-elt-in-region`, `undo-delta` and `primitive-undo`), point records after undo (from undo.c's `record_point`) and marks put back by undo (`record_marker_adjustments`).
- `crates/e8-core/src/editor.rs` and `commands.rs`: undo amalgamation (`undo-auto-amalgamate`), `current-column` and the landing rule of `move-to-column`, and `insert-and-inherit`'s sticky properties. These follow Emacs's code to varying degrees.

Not audited: the other packages (`isearch.ts`, `replace.ts`, `kmacro.ts`, `repeat.ts`, `help.ts`, `files.ts`, `delsel.ts`, `mouse.ts`, `window.ts`) and the rest of the core, from earlier sessions. The first step of any clean-up is an audit of how closely each was written from Emacs's source.

Probably fine, but check:

- `tests/emacs/golden/`: Emacs's output for our own inputs. A program's output is not generally covered by the program's licence.
- `crates/e8-core/src/chartab_data.rs`: tables written by `tests/emacs/unicode.el` from a running Emacs: each character's general category, script, standard syntax entry, case and categories. They are data from Emacs's tables, most of which come from the Unicode Character Database; like the golden files, Emacs's output rather than its code, though the syntax and category assignments are the FSF's choices.
- `crates/e8-core/src/regexp.rs`: written from Emacs's documented regexp syntax and from Emacs's behaviour, recorded by the regexp fuzzer, including the quirks of its matcher's loop optimisation, without reading regex-emacs.c.
- `tests/emacs/record.el`: our own Emacs Lisp, which runs inside Emacs. The FSF regards Emacs Lisp packages as derived from Emacs, so this file may have to be GPL. It is a test tool, not part of E8, so it can simply stay GPL.

From now on: ask before reading or porting the source of any GPL or similar project. Running Emacs to compare behaviour is fine.

Help text ([ADR 0064](adr/0064-the-help-system.md)): a doc string is written from the command's behaviour, parameters and tests, never copied or paraphrased from Emacs's, and what help shows is generated from the definitions and keymaps. The Emacs manuals are under the GFDL with invariant sections, which does not combine with GPL code, so they are never copied or shipped; `C-h i` and `C-h r` will read installed Info files or open the online manual. Not done: comparing the doc strings written before the ADR with Emacs's for the same names, and rewriting any that match.

## The structure we have in mind

1. **A permissive core.** The Rust crates and the basic packages a usable editor needs would be MIT and/or Apache-2.0. Anyone could reuse them on any platform, App Store included.
2. **GPL packages kept apart.** Packages derived from Emacs or Org would be GPL-3.0-or-later, in their own repositories. Each file gets an SPDX header and credits the FSF.
3. **Packages loaded from URLs.** A user's `init.ts` would load packages from URLs they choose, such as GitHub repositories, instead of the binary bundling them. Today all packages are compiled in with `include_str!` in `crates/e8-script/src/lib.rs`, so every build contains them.

Why this works for the licence:

- **The direction is fine.** A permissive core combined with GPL code is fine, because permissive licences are compatible with the GPL. The reverse, a GPL core with closed plugins, is what the FSF objects to.
- **We don't distribute the GPL code.** Its repository does, as source, which meets the GPL. The user combines it with E8 on their own device, which the GPL does not restrict.
- **Bundling or serving it would be distribution.** If E8 bundled GPL packages, or served them from a catalogue we run, we would arguably be distributing them. A URL the user enters keeps us out of that.
- **The web counts too.** Serving GPL JavaScript in a web build is distribution, so the same separation applies there.

## The App Store

What we found in October 2026, at second hand and not from Apple's own text. Read the current [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) and developer agreement before building an iOS app: these rules change every year or two.

- **GPL code on the App Store.** The FSF holds that Apple's terms add restrictions the GPL forbids. VLC was withdrawn in 2011 after a GPL complaint. A binary that contains GPL code is therefore a risk. A GPL exception for the App Store would only be possible for code we own, not for code derived from the FSF's.
- **Guideline 2.5.2** bars apps from downloading or running code that adds or changes features.
- **The developer agreement (3.3.2)** reportedly allows downloaded interpreted code if it does not change the app's primary purpose, does not create a storefront for other code, and does not bypass OS security. QuickJS is an interpreter with no JIT, which fits; E8 runs on V8 by default, but builds with the `quickjs` feature for this ([ADR 0054](adr/0054-v8-as-the-script-engine.md)).
- **Guideline 4.7** was revised to cover mini apps and plug-ins not embedded in the binary.
- **Enforcement is inconsistent.** In March 2026 Apple removed one app that ran generated code and approved a similar one the same week.

So:

- **No in-app extension store.** It is close to "a storefront for other code".
- **Present packages as the user's own configuration.** `init.ts` loads what the user asks for, as coding apps like Pythonista and Scriptable do.
- **Bundle enough that the app is complete without downloads,** so packages don't change its primary purpose.
- **The EU is a fallback.** Alternative marketplaces and web distribution allow a GPL build there.

## Cleaning up derived code

### The process

If we want the permissive structure, the derived code has to be rewritten without the GPL source. This would be done with clean sub-agents:

1. **Remove.** Take the derived code out (see the list above), keeping its oracle cases and fuzzer.
2. **Specify.** A spec-writer describes behaviour from Org's manual, docstrings and observed behaviour, never the source. The 1,134 oracle cases in `tests/emacs/cases/` already pin down much of it.
3. **Implement.** A fresh implementer works from the spec and the tests only. Its brief says not to read Emacs or Org source, and it has no access to the removed files or to history that contains them.
4. **Check.** The oracle suite and the fuzzer decide when it is done.
5. **Keep records.** Keep the briefs, specs and agent logs, to show the process if it is ever questioned.
6. **Publish fresh.** Put the finished code in a new repository with no history containing the derived versions. This is not what makes it lawful, since what matters is whether the published code is derived. It does avoid publishing that history by accident.

### If the clean version looks like the original

Copyright protects expression, not behaviour, ideas or interfaces. Independent creation is a full defence, even if the result is identical. Proving it is the difficulty. Copying is inferred from access plus substantial similarity, and here there is access twice: this repository held the ports, and the model writing the code has very likely been trained on Emacs's source. Whether code an LLM writes counts as independent when the model has seen the original is not settled law.

What helps:

- **Function-dictated code is not protectable.** Code there is only one sensible way to write does not count.
- **The language change helps.** Moving from Lisp to TypeScript or Rust makes literal overlap unlikely. Copying a program's structure still counts as copying, though.
- **Avoid copying Org's bugs.** Reproducing a bug is strong evidence of copying. Examples are `org-delete-char`'s stale match data, and the comparison of a position with a character count in `org-fold--reveal-headline-at-point`. Reproduce a quirk only where an oracle case requires it, and work from the case, not from memory of the source.
- **Compare with the original before publishing.** A similarity check against the Emacs and Org sources, and rewriting anything too close.

## Open questions

- MIT, Apache-2.0 or both for the core.
- Whether to clean up the derived code at all, or release everything as GPL and give up a closed App Store build.
- Whether contributors should sign a CLA, which would allow licensing exceptions later.
