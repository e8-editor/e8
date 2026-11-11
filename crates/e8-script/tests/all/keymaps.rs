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
    // Emacs: (foo changed bar), and a prefix command's keymap is not copied
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
