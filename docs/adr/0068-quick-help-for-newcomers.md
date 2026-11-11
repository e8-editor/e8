# 0068. Quick help for newcomers, a layer that can be turned off

Status: accepted · 2026-11-11

## Context

Emacs is learnt through its help ([ADR 0064](0064-the-help-system.md)): `C-h m` describes the mode, `C-h b` lists every key, `C-h k` says what a key does. All of it is complete, and none of it is short. A newcomer in an Org buffer who types `C-h m` gets the mode's whole doc string and a table of every key Org and its parents bind; nothing says which five matter, or what to try first.

Packages had started making up for that by putting keys on the screen: agent-shell's header line listed seven of them after the session's settings, cut off at the window's edge and there for good. Emacs does that only in buffers you are meant to leave, such as Org's capture and source buffers and with-editor's commit messages ("Finish with C-c C-c"); a buffer you stay in, a shell or Dired, keeps its header and mode lines for state. Emacs's own steps towards newcomers are small and on request: the startup screen's links, the "type C-h C-a" line in the echo area, and, since Emacs 29, `C-h C-q`'s grid of common commands.

This goes a step beyond Emacs, so it is a departure ([departures.md](../departures.md)); it is made now, rather than once the base is stable, because the human asked for it, and because it is what keeps hints out of every mode's header line.

## Options considered

1. **Hints where they are needed**, as agent-shell's header line did. Each mode invents its own, they take screen space for good, and an Emacs user cannot turn them all off.
2. **Only Emacs's help.** Pure, and what experienced users want, but leaves a newcomer with `C-h m`'s wall of text.
3. **A small layer of help on request, on top of Emacs's, that one switch turns off.** Two keys open a card of about one screen: `C-h h`, help where you are, and `C-h 8`, getting started with E8. A card says what the place is for, the keys that matter there, what to try now and what to learn next, and links to Emacs's full help for it.

## Decision

Option 3, as `help-guide.ts`:

- `help-guide-mode`, a global minor mode, on by default. Turned on, it binds `h` and `8` in `help-map`, so `C-h ?` lists them; turned off, in init.ts, it takes them out again and nothing else of the layer shows: no cards, no hints at startup or in modes. `C-h h` is `view-hello-file` in Emacs, which E8 does not have; with the mode off it is free for it.
- A card is shown in `*Help*`, a buffer in help-mode like any other help, so it reads the same in the terminal, the window and the browser, can be searched and copied, `q` closes it and `l` comes back to it after following a link. Its links go to the full mode help (as `C-h m`), to the other card, and to the list of help keys.
- A mode's card is data a package gives with `defineGuide` from `help-guide`: a summary, groups of commands with what each does, things to try and things to learn. It names commands, never keys; the card looks each command's key up in the mode's keymap and the global map when it is shown, so a key the user rebinds shows as rebound, and prose names a key as `\\[command]`, as Emacs's doc strings do. The prose is E8's own words, as ADR 0064 asks of doc strings.
- A mode without a card gets one made from the first paragraph of its doc string and the keys its own keymap adds to its parent's, with a link to the card of the nearest mode it is built on that has one.
- Hints a mode shows once, as agent-shell's at the start of a session, and the line E8 shows in the echo area at startup ("C-h 8 to get started"), show only while the mode is on. Header and mode lines show state, never keys.

## Consequences

Newcomers have two keys to remember, and every mode answers `C-h h`, even one nobody has written a card for. The cards are text that must be kept true as modes change; naming commands rather than keys keeps the commonest drift away, and the tests check that every command a card names exists. Writing a good card is part of writing a mode, as its doc string is.

An Emacs user who wants none of it adds `e8.callWithPrefix(-1, "help-guide-mode")` to init.ts, as `(help-guide-mode -1)` in Lisp, and has Emacs's help alone.

## Dependencies introduced

None.
