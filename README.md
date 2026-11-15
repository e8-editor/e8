<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
  <img alt="E8" src="docs/assets/banner-light.png">
</picture>

# E8

An editor that works the way Emacs works: the same buffers, windows, keys and commands, with Org mode, Dired, a shell, search and replace, completion and an agent that calls commands as tools. The core is Rust, and what Emacs writes in Lisp is written in TypeScript, which is also how you configure and extend it.

E8 is built by one person for daily use, and is open so that it is not hidden. [docs/features.md](docs/features.md) lists what works.

## Installing

With Homebrew, on Apple silicon Macs and on Linux:

```bash
brew install e8-editor/tap/e8
```

That gives `e8`, the editor in a terminal, and on a Mac `E8.app`, the editor in a window. To open the app from Launchpad and Spotlight:

```bash
ln -sf "$(brew --prefix)/opt/e8/E8.app" /Applications/E8.app
```

`brew upgrade e8` brings it up to date.

## Running

```bash
e8 some-file.txt
```

An Emacs user's fingers already know the rest: `C-x C-f`, `C-x C-s`, `M-x`, `C-x C-c`. Your configuration goes in `~/.config/e8/init.ts`; [examples/init.ts](examples/init.ts) is a start.

## Packages

Besides the packages E8 ships, as Emacs ships its Lisp, the [`e8-editor`](https://github.com/e8-editor) organisation holds ports of Emacs packages from outside Emacs (Magit, Vertico, Consult, Orderless, Marginalia, Org-roam, a collection of themes and more), each in a repository of its own and maintained with E8. The design and the original code of each are its upstream authors'; a port keeps its upstream's licence and credits them in its README. A config installs one with `e8.usePackage("e8-editor/e8-NAME")`. [docs/features.md](docs/features.md#packages-in-their-own-repositories) lists them.

## Licence

GPL-3.0-or-later.
