//! Keymaps as values, as Emacs has them: a prefix map is shared wherever
//! it is bound, a keymap's name is a variable holding it, text can carry
//! a keymap of its own, and a child's prefix maps merge with its parent's.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        for (const name of ["one", "two", "three"]) {
          e8.defineCommand({ name: `test-${name}`, run: () => { seen.push(name); } });
        }
        "#
        .to_string(),
    )
    .unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let json = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&json).unwrap_or(json)
}

fn seen(ed: &mut Editor, s: &Scripting) -> String {
    eval(ed, s, "seen.splice(0).join(' ')")
}

#[test]
fn a_prefix_map_is_shared_wherever_it_is_bound() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.prefix = e8.defineKeymap("test-prefix-map"),
            e8.bindKey("C-c t", prefix),
            e8.bindKey("<f5>", prefix),
            e8.bindKey("1", "test-one", prefix), 0)"#,
    );
    ed.press("C-c t 1 <f5> 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "one one");
    // Bound later, a key shows under both prefixes, as one keymap.
    eval(&mut ed, &s, r#"(e8.defineKey("test-prefix-map", "2", "test-two"), 0)"#);
    ed.press("C-c t 2 <f5> 2").unwrap();
    assert_eq!(seen(&mut ed, &s), "two two");
    assert_eq!(eval(&mut ed, &s, r#"e8.lookupKey("global-map", "C-c t") === prefix"#), "true");
    assert_eq!(eval(&mut ed, &s, r#"e8.lookupKey("global-map", "<f5> 2")"#), "test-two");
    // The name is a variable holding the keymap, and defining it again keeps it.
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("test-prefix-map") === prefix && e8.defineKeymap("test-prefix-map") === prefix"#), "true");
    assert_eq!(eval(&mut ed, &s, "e8.keymapp(prefix) && !e8.keymapp('test-prefix-map')"), "true");
}

#[test]
fn a_child_merges_its_parent_s_prefix_maps_and_nil_hides_the_parent_s() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.parent = e8.makeSparseKeymap(),
            globalThis.child = e8.makeSparseKeymap(parent),
            e8.defineKey(child, "C-c 1", "test-one"),
            e8.defineKey(parent, "C-c 2", "test-two"),
            e8.defineKey(parent, "C-c 1", "test-three"),
            e8.useLocalMap(child), 0)"#,
    );
    ed.press("C-c 1 C-c 2").unwrap();
    assert_eq!(seen(&mut ed, &s), "one two");
    // Nil hides the parent's binding, as (define-key map key nil); taken
    // out, the parent's shows.
    eval(&mut ed, &s, r#"(e8.defineKey(child, "C-c 1", null), 0)"#);
    ed.press("C-c 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "");
    eval(&mut ed, &s, r#"(e8.keymapUnset(child, "C-c 1", true), 0)"#);
    ed.press("C-c 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "three");
    assert_eq!(eval(&mut ed, &s, "e8.keymapParent(child) === parent"), "true");
    eval(&mut ed, &s, "(e8.setKeymapParent(child, null), 0)");
    ed.press("C-c 2").unwrap();
    assert_eq!(ed.echo(), Some("C-c 2 is undefined"));
}

#[test]
fn text_carries_a_keymap_of_its_own() {
    let (mut ed, s) = setup();
    // A button's map, as Emacs's buttons make one with make-sparse-keymap.
    eval(
        &mut ed,
        &s,
        r#"(globalThis.button = e8.makeSparseKeymap(),
            e8.defineKey(button, "RET", "test-one"),
            e8.insert("see [here] now"),
            e8.putTextProperty(4, 10, "keymap", button), 0)"#,
    );
    ed.window_buffer_mut().set_point(5);
    ed.press("RET").unwrap();
    assert_eq!(seen(&mut ed, &s), "one");
    assert_eq!(eval(&mut ed, &s, "e8.currentActiveMaps()[0] === button"), "true");
    // Elsewhere RET is a newline.
    ed.window_buffer_mut().set_point(0);
    ed.press("RET").unwrap();
    assert_eq!(seen(&mut ed, &s), "");
    assert!(ed.window_buffer().slice(0..1) == "\n");
}

#[test]
fn a_transient_map_can_be_a_keymap_or_bindings() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.once = e8.makeSparseKeymap(), e8.defineKey(once, "x", "test-three"), e8.setTransientMap(once), 0)"#);
    ed.press("x x").unwrap();
    assert_eq!(seen(&mut ed, &s), "three");
    eval(&mut ed, &s, r#"(e8.setTransientMap({ y: "test-two" }), 0)"#);
    ed.press("y").unwrap();
    assert_eq!(seen(&mut ed, &s), "two");
    // An overriding map is a keymap too, by name or as itself.
    eval(&mut ed, &s, r#"(e8.setOverridingMap(once), 0)"#);
    assert_eq!(eval(&mut ed, &s, "e8.overridingMap() === once"), "true");
    ed.press("x").unwrap();
    eval(&mut ed, &s, r#"(e8.setOverridingMap(null), 0)"#);
    assert_eq!(seen(&mut ed, &s), "three");
}

#[test]
fn emacs_s_prefix_maps_have_their_names() {
    let (mut ed, s) = setup();
    for (name, keys) in [("ctl-x-map", "C-x"), ("ctl-x-4-map", "C-x 4"), ("ctl-x-5-map", "C-x 5"), ("narrow-map", "C-x n"), ("project-prefix-map", "C-x p")] {
        assert_eq!(eval(&mut ed, &s, &format!(r#"e8.lookupKey("global-map", "{keys}") === e8.variable("{name}")"#)), "true", "{name}");
    }
    // Binding in one binds under its prefix, as (define-key ctl-x-4-map ...) does.
    eval(&mut ed, &s, r#"(e8.defineKey("ctl-x-4-map", "t", "test-one"), 0)"#);
    ed.press("C-x 4 t").unwrap();
    assert_eq!(seen(&mut ed, &s), "one");
    assert_eq!(eval(&mut ed, &s, r#"e8.lookupKey("project-prefix-map", "f")"#), "project-find-file");
}

#[test]
fn the_current_local_and_global_maps_are_keymaps() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.currentLocalMap() === undefined,
          (e8.call("emacs-lisp-mode"), e8.currentLocalMap() === e8.variable("emacs-lisp-mode-map")),
          e8.currentGlobalMap() === e8.variable("global-map"),
        ])"#,
    );
    // Emacs: nil in fundamental-mode, then emacs-lisp-mode-map, and global-map
    assert_eq!(got, "[true,true,true]");
}

#[test]
fn local_set_key_as_lisp_writes_it_binds_in_the_mode_s_map() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("emacs-lisp-mode"), e8.defineKey(e8.currentLocalMap(), "C-c z", "test-one"), true)"#);
    ed.press("C-c z");
    assert_eq!(seen(&mut ed, &s), "one");
}

#[test]
fn a_global_map_can_be_put_in_place_of_another() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.copy = e8.copyKeymap(e8.currentGlobalMap()), e8.defineKey(copy, "C-c y", "test-two"), e8.useGlobalMap(copy), true)"#,
    );
    ed.press("C-c y");
    assert_eq!(seen(&mut ed, &s), "two");
    let got = eval(&mut ed, &s, r#"JSON.stringify([e8.lookupKey("global-map", "C-c y") ?? null, e8.lookupKey(copy, "C-x C-f")])"#);
    assert_eq!(got, r#"[null,"find-file"]"#);
}

#[test]
fn a_copied_keymap_has_its_own_prefix_maps_but_shares_named_ones() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.m = e8.makeSparseKeymap(), e8.defineKey(m, "C-c a", "foo"), e8.defineKey(m, "C-c b c", "bar"),
          e8.defineKey(m, "C-x 4", e8.variable("ctl-x-4-map")),
          globalThis.c = e8.copyKeymap(m), e8.defineKey(c, "C-c a", "changed"),
          JSON.stringify([e8.lookupKey(m, "C-c a"), e8.lookupKey(c, "C-c a"), e8.lookupKey(c, "C-c b c"),
            e8.lookupKey(c, "C-x 4") === e8.variable("ctl-x-4-map")]))"#,
    );
    // Emacs: (foo changed bar); E8 keeps a keymap a variable names, as Emacs keeps a prefix command's
    assert_eq!(got, r#"["foo","changed","bar",true]"#);
}

#[test]
fn accessible_keymaps_are_found_through_prefix_keys() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.m = e8.makeSparseKeymap(), e8.defineKey(m, "C-c a", "foo"), e8.defineKey(m, "C-c b c", "bar"),
          e8.defineKey(m, "C-x 4 z", "baz"),
          JSON.stringify([e8.accessibleKeymaps(m).map(([k]) => k).sort(), e8.accessibleKeymaps(m, "C-c").map(([k]) => k),
            e8.accessibleKeymaps(m)[0][1] === m, e8.accessibleKeymaps(m, "C-c a")]))"#,
    );
    // Emacs: ("" "C-x" "C-c" "C-x 4" "C-c b"), most recent first where E8 has key order, and ("C-c" "C-c b")
    assert_eq!(got, r#"[["","C-c","C-c b","C-x","C-x 4"],["C-c","C-c b"],true,[]]"#);
}

#[test]
fn minor_modes_keymaps_and_their_bindings() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.defineMinorMode({ name: "test-minor-mode", bindings: { "C-c q": "test-three" } }), e8.call("test-minor-mode"),
          JSON.stringify([e8.minorModeKeyBinding("C-c q"), e8.minorModeKeyBinding("C-c w"),
            e8.currentMinorModeMaps().includes(e8.variable("test-minor-mode-map")),
            (e8.callWithPrefix(-1, "test-minor-mode"), e8.minorModeKeyBinding("C-c q"))]))"#,
    );
    assert_eq!(got, r#"[[["test-minor-mode","test-three"]],[],true,[]]"#);
}

#[test]
fn keys_set_and_unset_globally_and_locally() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("global-set-key", "C-c y", "test-one"), e8.call("local-set-key", "C-c u", "test-two"), true)"#);
    ed.press("C-c y C-c u");
    assert_eq!(seen(&mut ed, &s), "one two");
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.call("global-unset-key", "C-c y"), e8.call("local-unset-key", "C-c u"),
          JSON.stringify([e8.lookupKey(e8.currentGlobalMap(), "C-c y") ?? null, e8.lookupKey(e8.currentLocalMap(), "C-c u") ?? null]))"#,
    );
    // Emacs: a local-set-key in a buffer with no local map gives it one
    assert_eq!(got, "[null,null]");
}

#[test]
fn a_parent_s_prefix_maps_are_accessible_under_a_key_the_child_binds_too() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.p = e8.makeSparseKeymap(), e8.defineKey(p, "C-c a b", "foo"),
          globalThis.c = e8.makeSparseKeymap(p), e8.defineKey(c, "C-c d e", "bar"),
          JSON.stringify([e8.accessibleKeymaps(c).map(([k]) => k).sort(), e8.accessibleKeymaps(c, "C-c").map(([k]) => k).sort()]))"#,
    );
    // Emacs: ("" "C-c" "C-c d" "C-c a") and ("C-c" "C-c d" "C-c a")
    assert_eq!(got, r#"[["","C-c","C-c a","C-c d"],["C-c","C-c a","C-c d"]]"#);
}

#[test]
fn the_first_minor_mode_binding_a_key_to_a_command_wins() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.defineMinorMode({ name: "test-a-mode", bindings: { "C-c q": "test-one" } }),
          e8.defineMinorMode({ name: "test-b-mode", bindings: { "C-c q": "test-two" } }),
          e8.call("test-a-mode"), e8.call("test-b-mode"), JSON.stringify(e8.minorModeKeyBinding("C-c q")))"#,
    );
    // Emacs: only the first mode in lookup order, the one defined last
    assert_eq!(got, r#"[["test-b-mode","test-two"]]"#);
}

#[test]
fn binding_keys_and_describing_them_follow_the_global_map_in_use() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.useGlobalMap(e8.copyKeymap(e8.currentGlobalMap())), e8.bindKey("C-c x", "test-three"), true)"#);
    ed.press("C-c x");
    assert_eq!(seen(&mut ed, &s), "three");
    let got = eval(&mut ed, &s, r#"JSON.stringify(e8.lookupKey("global-map", "C-c x") ?? null)"#);
    assert_eq!(got, "null");
}


#[test]
fn a_keymap_carries_the_prompt_it_was_made_with() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
            const up = e8.makeSparseKeymap(null, "Up");
            const child = e8.makeSparseKeymap(up);
            const own = e8.makeSparseKeymap(up, "Own");
            return JSON.stringify([
              e8.keymapPrompt(e8.makeSparseKeymap(null, "Pick")), e8.keymapPrompt(e8.makeSparseKeymap()) ?? null,
              e8.keymapPrompt(child), e8.keymapPrompt(own), e8.keymapPrompt(42) ?? null, e8.keymapPrompt(null) ?? null,
              e8.keymapPrompt(e8.copyKeymap(own)),
            ]);
          })()"#,
    );
    // Emacs: "Pick" nil "Up" "Own" nil nil, and a copy keeps its prompt.
    assert_eq!(got, r#"["Pick",null,"Up","Own",null,null,"Own"]"#);
}

#[test]
fn map_keymap_internal_walks_a_keymaps_own_keys_and_hands_back_its_parent() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
            const parent = e8.makeSparseKeymap();
            e8.defineKey(parent, "z", "zap-to-char");
            const map = e8.makeSparseKeymap(parent);
            e8.defineKey(map, "a", "forward-char");
            e8.defineKey(map, "C-x f", "find-file");
            const seen = [];
            const back = e8.mapKeymapInternal((key, binding) => seen.push([key, e8.keymapp(binding) ? "MAP" : binding]), map);
            const none = e8.mapKeymapInternal(() => {}, parent);
            return JSON.stringify([seen.sort(), back === parent, none ?? null]);
          })()"#,
    );
    // Emacs: ((24 MAP) (97 forward-char)) — the prefix as its keymap, the
    // parent's z not visited — and the parent handed back, nil for none.
    // Emacs visits the newest binding first; E8 keeps a keymap's keys in
    // order, so only which keys are visited is compared.
    assert_eq!(got, r#"[[["C-x","MAP"],["a","forward-char"]],true,null]"#);
}

#[test]
fn keymap_get_keyelt_looks_through_a_menu_item() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.funcall("keymap--get-keyelt", "forward-char", null), e8.funcall("keymap--get-keyelt", ["menu-item", "Open", "find-file"], null)])"#,
    );
    // Emacs: forward-char, find-file.
    assert_eq!(got, r#"["forward-char","find-file"]"#);
}

#[test]
fn describe_buffer_bindings_writes_what_emacs_writes() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
            const m = e8.makeSparseKeymap();
            e8.defineKey(m, "C-c a", "forward-char");
            e8.defineKey(m, "C-c b", "backward-char");
            e8.defineKey(m, "C-c C-x z", "zap-to-char");
            e8.defineKey(m, "C-c <f5>", "recompile");
            e8.defineKey(m, "C-c <f12>", "recompile");
            for (const c of ["1", "2", "3", "4"]) e8.defineKey(m, `C-c ${c}`, "digit-argument");
            e8.defineKey(m, "C-c M-q", "fill-paragraph");
            e8.defineKey(m, "C-c x", "undefined");
            e8.defineKey(m, "C-c l", ["a", "b", "c"]);
            e8.useLocalMap(m);
            const buffer = e8.currentBuffer();
            const text = e8.withCurrentBuffer(e8.getBufferCreate("*out*"), () => {
              e8.funcall("describe-buffer-bindings", buffer, "C-c");
              return e8.bufferText();
            });
            return JSON.stringify([text, e8.windowTotalWidth() - 1]);
          })()"#,
    );
    let (got, width): (String, usize) = serde_json::from_str(&got).unwrap();
    // GNU Emacs 30.2's text for the same keymap, its rule the window's width: a
    // run of characters as one line, `undefined' left out, function keys in
    // version order, the meta key and the prefix map as blocks of their own.
    let rule = "-".repeat(width);
    let expected = format!(
        "\x0c\n`fundamental-mode' Major Mode Bindings Starting With C-c:\n\nKey             Binding\n{rule}\n\
         C-c 1 .. C-c 4\tdigit-argument\nC-c a\t\tforward-char\nC-c b\t\tbackward-char\nC-c l\t\tKeyboard Macro\n\
         C-c <f5>\trecompile\nC-c <f12>\trecompile\n\nC-c M-q\t\tfill-paragraph\n\nC-c C-x z\tzap-to-char\n"
    );
    assert_eq!(got, expected);
}

#[test]
fn describe_buffer_bindings_shadows_runs_and_meta_keys_as_emacs_does() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
            e8.defineMinorMode({ name: "foo-mode", bindings: { "<f9> a": "kill-word" } });
            e8.call("foo-mode");
            const m = e8.makeSparseKeymap();
            e8.defineKey(m, "<f9> a", "kill-line");
            e8.defineKey(m, "<f9> c", "yank");
            for (const k of ["C-a", "C-b", "C-c"]) e8.defineKey(m, `<f9> ${k}`, "forward-char");
            for (const k of ["M-a", "M-b", "M-c"]) e8.defineKey(m, `<f9> ${k}`, "backward-char");
            e8.defineKey(m, "<f9> x q", "upcase-word");
            e8.defineKey(m, "<f9> y q", "downcase-word");
            e8.defineKey(m, "<f9> M-TAB", "complete-symbol");
            e8.defineKey(m, "C-x C-f", "forward-char");
            e8.defineKey(m, "C-x 4", "backward-char");
            e8.useLocalMap(m);
            const buffer = e8.currentBuffer();
            const describe = (prefix) => e8.withCurrentBuffer(e8.getBufferCreate("*out*"), () => {
              e8.deleteRegion(e8.pointMin(), e8.pointMax());
              e8.funcall("describe-buffer-bindings", buffer, prefix);
              return e8.bufferText();
            });
            return JSON.stringify([describe("<f9>"), describe("C-x"), e8.windowTotalWidth() - 1]);
          })()"#,
    );
    let (f9, cx, width): (String, String, usize) = serde_json::from_str(&got).unwrap();
    let rule = "-".repeat(width);
    // GNU Emacs 30.2's text, but for the order of the blocks under <f9>,
    // which Emacs lists newest first: the minor mode's key shadows the
    // major mode's, the minor mode's title is quoted, runs of control and
    // meta characters are one line each, and ESC TAB reads C-M-i.
    let expected = format!(
        "\x0c\n`foo-mode' Minor Mode Bindings Starting With <f9>:\n\nKey             Binding\n{rule}\n<f9> a\t\tkill-word\n\
         \x0c\n`fundamental-mode' Major Mode Bindings Starting With <f9>:\n\nKey             Binding\n{rule}\n\
         <f9> C-a .. <f9> C-c\tforward-char\n<f9> c\t\t\tyank\n\n<f9> C-M-i\t\tcomplete-symbol\n<f9> M-a .. <f9> M-c\tbackward-char\n\n\
         <f9> x q\tupcase-word\n\n<f9> y q\tdowncase-word\n"
    );
    assert_eq!(f9, expected);
    // Under a prefix, a local key shadows the global one, and a local
    // command on C-x 4 hides every global key under it.
    let global = &cx[cx.find("Global Bindings Starting With C-x:").expect("the global section")..];
    assert!(global.contains("\nC-x C-s\t\tsave-buffer\n"), "{cx}");
    assert!(!global.contains("\nC-x C-f\t"), "{cx}");
    assert!(!global.contains("\nC-x 4 "), "{cx}");
}

#[test]
fn keys_under_esc_are_the_meta_keys() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
            const m = e8.makeSparseKeymap();
            e8.defineKey(m, "M-a", "forward-char");
            e8.defineKey(m, "C-M-q", "yank");
            e8.useLocalMap(m);
            const buffer = e8.currentBuffer();
            return e8.withCurrentBuffer(e8.getBufferCreate("*out*"), () => {
              e8.funcall("describe-buffer-bindings", buffer, "ESC");
              return e8.bufferText();
            });
          })()"#,
    );
    // As Emacs lists its ESC map's keys: the meta characters, and only them.
    assert!(got.contains("Major Mode Bindings Starting With ESC:\n"), "{got}");
    assert!(got.contains("\nC-M-q\t\tyank\nM-a\t\tforward-char\n"), "{got}");
    assert!(got.contains("\nM-q\t\tfill-paragraph\n"), "{got}");
    assert!(!got.contains("\nC-x "), "{got}");
}
