# 0065. Packages Emacs autoloads

Status: accepted · 2026-11-07

## Context

Emacs loads most of its Lisp only when it is first needed: an autoload cookie puts a command's name in `loaddefs.el`, and calling it loads the file that defines it. E8 has no autoloads. A shipped package is either preloaded, in `PACKAGES` in `e8-script/src/lib.rs`, or in `LIBRARY`, loaded by `e8.require` or an `import`. Until now, packages whose commands Emacs autoloads were preloaded, as package-vc.ts and agent-shell.ts are, so that `M-x` finds their commands.

Ediff (`packages/ediff.ts`) is large and is used now and then, from `M-x ediff-files` or from a package such as Magit. Preloading it would mean parsing and running it, and defining its faces, variables, hooks and its mode, at every start, for a session that seldom uses it.

## Options considered

1. **Preload it**, as package-vc.ts is. This is simple, but every start pays for it.
2. **An autoload mechanism in the core**: `e8.autoload(name, feature)` to make a command or function that loads its package when called. This is closest to Emacs, but it touches the script API and the command machinery, `e8.d.ts` and every engine, and a command's parameters, which `M-x` reads before the command runs, would still have to be declared somewhere before the package loads.
3. **A small preloaded package with the entry points**, as Emacs's `ediff-hook.el` holds ediff's menu entries. `ediff-hook.ts` defines each entry command with the parameters it prompts for. When one runs, it requires `ediff`, whose commands of the same names replace these, and calls the real one with the arguments read. The parameters are defined once, in `ediff-hook.ts`, and `ediff.ts` defines its commands from that list.

## Decision

Option 3. A package Emacs autoloads, and that is too large to preload, goes in `LIBRARY`, and a preloaded `NAME-hook.ts` defines its entry commands from a list it exports, as `ediff-hook.ts` does. The package defines the same commands from that list when it loads. Code that calls the package imports it by name, which loads it.

## Consequences

Starting E8 costs only the hook file, a page of command definitions. The first use of an entry command loads the package, which defines its commands again: describing such a command before then shows the hook file's definition, with the same parameters and documentation. A function rather than a command, as `ediff-buffers-internal` is, exists only once the package has loaded, so code calls it by importing the package, or after `e8.require`. If more packages come to need this, a core `e8.autoload` (option 2) can replace the hook files without changing what users see.
