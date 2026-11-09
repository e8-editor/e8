# 0067. Themes are one collection, with a chooser

Status: accepted · 2026-11-09

## Context

E8 has had themes since `load-theme` came to `custom.ts`: a theme is a package, `NAME-theme.ts` along `load-path`, and Nord was ported as one, [`e8-nord-theme`](https://github.com/e8-editor/e8-nord-theme), under [ADR 0059](0059-packages-are-git-repositories.md)'s rule of a repository per port. Emacs users choose from dozens of themes, and a repository per theme would mean dozens of repositories, each with its manifest, CI, tags and lock entry, for what is mostly a palette and a list of faces. Each user would also have to find and install the ones they want before they could see any of them.

The popular themes differ in how they are written. Modus and Ef build their faces from a palette of named colours; Gruvbox goes through autothemer; Doom's themes through `def-doom-theme`; Solarized, Zenburn and Tomorrow through palettes of their own; Leuven and Wombat give literal colours. Most choose colours by display, for terminals with 8, 256 or millions of colours and for light or dark backgrounds, which E8's faces do not do yet (see [differences](../differences.md)). A port by hand of each would be long, easy to get wrong in ways nobody notices, and need doing again when its upstream changes.

Choosing a theme is also where E8 is seen first. Emacs's ways of choosing are `M-x load-theme`, which loads without showing, `customize-themes`, a list of checkboxes, and `consult-theme`, which loads each theme as the minibuffer's selection moves.

## Options considered

1. **A repository per theme**, as ADR 0059 has it. Each keeps its upstream's licence alone. It means many repositories with little in each, and nothing to choose among until each is installed.
2. **Themes in E8 itself**, as Emacs ships Modus, Leuven and Wombat in `etc/themes`. These three are GPL and part of Emacs, so they could go in `LIBRARY`. Third-party themes do not belong in E8's repository, though, and splitting the set between E8 and a package means two places to look.
3. **One repository of themes, [`e8-themes`](https://github.com/e8-editor/e8-themes)**, as doom-themes collects Doom's, with a chooser in the same package.

For the chooser:

1. **Rely on `consult-theme`.** It is a faithful port and stays one. It needs vertico and consult, and shows only a name at a time.
2. **A chooser of E8's own** that lists every theme with its colours and shows a sample beside the list.

## Decision

Themes are one package, `e8-themes`, holding every theme E8 offers: Nord, moved from `e8-nord-theme`, and Modus, Leuven and Wombat from Emacs, Gruvbox, Solarized, Tomorrow, Catppuccin, Zenburn, Dracula and three of Doom's, twenty in all. Each theme keeps its name, so `load-theme` loads it as before, and its upstream's licence and copyright in its own file. The repository as a whole is GPL-3.0-or-later, which every licence in it (MIT and GPL-3.0-or-later) combines with. This is an exception to ADR 0059's one upstream per repository: a collection of ports is one package, and its README credits each upstream.

The ports are written by `tools/port-themes.el`, from the upstreams themselves. It loads each theme in Emacs without enabling it, takes the attributes Emacs would give each face on a graphical frame in millions of colours, against the theme's own background, keeps the faces E8 and its ports draw and those they inherit from, and writes each colour by its name in the upstream's palette. Themes that share their faces, as the four Modus themes do, are written as one module of faces (`modus-themes.ts`) and a file per theme holding its palette, as upstream has them. Catppuccin keeps its one theme with `catppuccin-flavor`. Nord stays the hand port it was, with its options. Updating a theme to a newer upstream is running the script again.

The package's `e8-themes-select` is the chooser: a list of the themes, dark ones and then light, each with a strip in its own colours, beside a sample of code, Org, a diff and the editor's highlights. Moving through the list enables each theme at once, so the whole frame shows it; `RET` keeps it and `q` goes back to the themes enabled before, as `consult-theme` does. `TAB` shows only the dark themes, only the light, or all. Emacs has no such command, so it goes in the package, not in E8, and [departures](../departures.md) does not need it.

E8 itself gains what any chooser needs from `custom.ts`: `custom-available-themes`, which `load-theme` now completes over as Emacs's does, so that a theme not yet loaded can be named, and `customThemeSettings`, a loaded theme's documentation and faces without enabling it, as Emacs keeps them in a theme's `theme-settings` and `theme-documentation` properties. The chooser works without them on older E8s, without its strips.

## Consequences

- One `e8.usePackage("e8-editor/e8-themes")` makes twenty themes loadable and the chooser available. A user who wants one theme still installs all of them, a few hundred kilobytes of TypeScript that load only when chosen.
- `e8-nord-theme` is archived, with its README pointing here; configurations that install it keep working, at its last tag. The `Ports` job in CI tests `e8-themes` in its place.
- A theme whose upstream E8 cannot load in Emacs in batch, or that computes its faces only when enabled on a real frame, cannot be ported by the script and is ported by hand, as Nord is.
- The ported themes carry only the colours a graphical frame gets. When E8's faces choose by display, the script can write the other clauses too.
- More themes are a line in the script's list each, when someone asks for them; the set is meant to be the popular ones, not every theme there is.
