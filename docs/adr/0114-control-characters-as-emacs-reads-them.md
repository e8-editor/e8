# 0114. Control characters as Emacs reads them: C-m is RET, C-i is TAB, C-[ is ESC

Status: accepted · 2026-11-22

## Context

The markdown-mode port binds `C-c C-x C-m` to `markdown-toggle-markup-hiding` and `C-c C-i` to `markdown-insert-image`, as markdown-mode does. In E8's terminal front end those keys could not be typed: `C-c C-x C-m` arrived as `C-c C-x RET is undefined`. Org's `C-c C-x C-i` (`org-clock-in`), comint's `C-c C-m` and many other packages' bindings had the same trouble, and the port had to bind the `RET` and `TAB` spellings as well.

`Key::parse` read `C-m` as Control and the letter `m`, a key of its own, apart from `RET`. Emacs has no such key:

- **ASCII control characters.** An event in Emacs is an integer, and Control on `@` to `_` or a letter is the ASCII control character, its code and 31 (keyboard.c's `make_ctrl_char`). `(kbd "C-m")` and `(kbd "RET")` are both `"\r"`, 13; `C-i` and `TAB` are 9; `C-[` and `ESC` are 27. Case does not matter (`C-M` is RET too), and other modifiers stay: `C-M-m` is `M-RET`, `C-S-m` is `S-RET` (recorded from Emacs 30.2). A terminal sends the same byte for ctrl+m and Return, and Emacs's GUI makes ctrl+m 13 as well, so a binding written either way is found whichever is typed, from either front end.
- **Function keys.** A GUI's Return and Tab keys send the symbols `return` and `tab`, written `<return>` and `<tab>`, which no terminal can send. `local-function-key-map` (with `function-key-map` as its parent) translates `<return>` to RET, `<tab>` to TAB, `M-<return>` to `M-RET`, `<escape>` to ESC and so on, but only when the function key itself is unbound where it is typed. So in Emacs's GUI, Return runs a `<return>` binding if there is one and RET's otherwise, while ctrl+m is always RET.
- **Descriptions.** `key-description` writes 13 as `RET`, 9 as `TAB` and 27 as `ESC`, and Meta with 9 as `C-M-i` (keymap.c's `push_key_description`), so `C-h c C-m` says `RET runs the command newline` and `C-h k M-TAB` says `C-M-i runs the command completion-at-point`.

E8 has had one key for RET and `<return>`, and one for TAB and `<tab>` ([ADR 0012](0012-org-mode.md)), and no `function-key-map` ([differences.md](../differences.md)).

## Options considered

1. **Make Control on `m`, `i` and `[` the control characters RET, TAB and ESC** wherever a `Key` is made: in `Key::parse`, in `Key::ctrl`, in each front end's conversion and in `Editor::handle_key`. A binding of `C-c C-x C-m` is then the binding of `C-c C-x RET`, as in Emacs, from either front end, and every description writes RET. RET and `<return>` stay one key, as now.
2. **Option 1, and make `<return>` and `<tab>` function keys of their own**, with a `local-function-key-map` translating them to RET and TAB when unbound. This is Emacs's whole model: a GUI could tell Return from ctrl+m, and a package could bind `<tab>` and TAB to different commands, as company and yasnippet do. But every `<return>` and `<tab>` binding in E8's packages and every test that presses them would change meaning, `C-<return>` (which E8 reads as `C-RET`, and org binds) would become a function key with no translation, and the translation would have to reach `read-key-sequence` partway through a command, which `input-decode-map` does not yet. That is a change to the command loop of its own, not needed to type the keys packages bind.
3. **Translate at lookup only**, trying `C-m` when RET is unbound. Descriptions and `this-command-keys` would still tell them apart, where Emacs cannot, and a binding of both spellings would be two bindings.

## Decision

Option 1. `Key::canonical` makes Control on `m`, `i` or `[`, of either case, the key RET, TAB or ESC, keeping Meta and Shift; `Key::parse` and `Key::ctrl` give canonical keys, the terminal, GUI and web front ends make theirs canonical, and `Editor::handle_key` does again for any key built by hand. `Key`'s `Display`, which `key-description`, `describe-key` and the "is undefined" message use, writes Meta and TAB as `C-M-i`, as Emacs does, and reads it back as the same key. `<backtab>` stays `S-TAB`.

## Consequences

- `C-c C-x C-m` runs from `C-c C-x RET` and the other way round, in the terminal and the GUI; `C-c C-i` and `C-c TAB` the same; ctrl+[ is ESC, a prefix for Meta, in the GUI as in a terminal. Ports can bind the keys as their Emacs packages write them, and the markdown-mode port's extra `RET` and `TAB` bindings can go.
- `C-h c` with ctrl+m says `RET`, `C-h k M-TAB` says `C-M-i`, and help.ts no longer has to rewrite `M-TAB` itself.
- A key that is Control and `m` cannot be bound or typed apart from RET, as in Emacs.
- Still unlike Emacs: `<return>` and `<tab>` are RET and TAB, not GUI function keys translated through `local-function-key-map`, so a `<tab>` binding also runs from a terminal's TAB and from ctrl+i, and a package cannot bind `<tab>` and TAB to different commands; `C-<return>` is `C-RET`. That is option 2, recorded in [differences.md](../differences.md) for when the command loop reads translations partway through a command.
- `tests/emacs/cases/control-characters.json` records Emacs typing `C-m`, `C-i`, `C-[`, `C-M-m` and Org's `C-c C-x TAB`; `crates/e8-core/tests/all/keys.rs` binds each spelling and types the other.

## Dependencies introduced

None.
