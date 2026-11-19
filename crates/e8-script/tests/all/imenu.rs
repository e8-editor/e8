//! Imenu, after Emacs's imenu.el: the index kept with markers until
//! *Rescan*, names cut to imenu-max-item-length, submenus before items,
//! comments passed over, flattening, special items with a function, the
//! prev-index and extract-name functions, and the index on the menu bar.
//! What Emacs gives was recorded with Emacs 30.2 in batch, as each test says;
//! E8's positions are Emacs's less one.

use e8_core::Editor;
use e8_script::Scripting;

const TEXT: &str = "def alpha\nclass Beta\n# def comment_one\ndef gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty_chars\nclass Delta\n\"def in_string\"\n";

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let module = dir.path().join("globals.ts");
    std::fs::write(&module, r#"import * as imenu from "imenu"; Object.assign(globalThis, { imenu });"#).unwrap();
    s.load_module(&mut ed, &module).unwrap();
    eval(
        &mut ed,
        &s,
        &format!(
            r##"e8.insert({});
            e8.setVariable("imenu-generic-expression", [[null, "^def \\([a-z_]+\\)", 1], ["Classes", "^class \\([A-Za-z]+\\)", 1]]);
            e8.modifySyntaxEntry("#", "<"); e8.modifySyntaxEntry("\n", ">");
            globalThis.shape = (items) => items.map((i) => Array.isArray(i[1]) ? [i[0], shape(i[1])] : [i[0], imenu.position(i[1])]);"##,
            serde_json::to_string(TEXT).unwrap()
        ),
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Emacs 30: (imenu--make-index-alist) is (("*Rescan*" . -99) ("Classes"
/// ("Beta" . 11) ("Delta" . 111)) ("alpha" . 1) ("gamma_…_sixty" . 40)):
/// the comment's def passed over, the long name cut to 60, submenus first.
/// After inserting "def zeta" at the start the kept index is the same, its
/// markers moved; once flushed, zeta is in it; flattened, a submenu's items
/// are named "Classes:Beta".
#[test]
fn the_index_is_kept_until_rescanned() {
    let (mut ed, s) = setup();
    assert_eq!(
        value(&mut ed, &s, "JSON.stringify(shape(imenu.makeIndexAlist()))"),
        r#"[["*Rescan*",-99],["Classes",[["Beta",10],["Delta",110]]],["alpha",0],["gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty",39]]"#
    );
    eval(&mut ed, &s, r#"e8.gotoChar(0); e8.insert("def zeta\n");"#);
    assert_eq!(
        value(&mut ed, &s, "JSON.stringify(shape(imenu.makeIndexAlist()))"),
        r#"[["*Rescan*",-99],["Classes",[["Beta",19],["Delta",119]]],["alpha",0],["gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty",48]]"#,
        "the kept index's markers follow the text; one where the text went in stays before it, as copy-marker's does"
    );
    eval(&mut ed, &s, r#"e8.setVariable("imenu--index-alist", null);"#);
    assert_eq!(
        value(&mut ed, &s, "JSON.stringify(imenu.makeIndexAlist().map((i) => i[0]))"),
        r#"["*Rescan*","Classes","zeta","alpha","gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty"]"#
    );
    assert_eq!(
        value(&mut ed, &s, "JSON.stringify(imenu.flattenIndex(imenu.makeIndexAlist().slice(1), true).map((i) => i[0]))"),
        r#"["Classes:Beta","Classes:Delta","zeta","alpha","gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty"]"#
    );
    // With imenu-auto-rescan the index is made afresh and has no *Rescan*.
    eval(&mut ed, &s, r#"e8.setVariable("imenu-auto-rescan", true); e8.gotoChar(e8.pointMax()); e8.insert("def omega\n");"#);
    assert_eq!(value(&mut ed, &s, "JSON.stringify(imenu.makeIndexAlist().map((i) => i[0]))"), r#"["Classes","zeta","alpha","gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty","omega"]"#);
    // makeIndex, for packages, gives numbers and no *Rescan*.
    assert_eq!(value(&mut ed, &s, "JSON.stringify(imenu.makeIndex()[1])"), r#"["zeta",0]"#);
}

/// M-x imenu on *Rescan* makes the index afresh and asks again; an item
/// with a function is gone to by it, with its arguments.
#[test]
fn rescan_and_special_items() {
    let d = crate::driven::Driven::new(&format!(
        r##"e8.insert({});
        e8.setVariable("imenu-generic-expression", [[null, "^def \\([a-z_]+\\)", 1], ["Classes", "^class \\([A-Za-z]+\\)", 1]]);
        e8.funcall("imenu--make-index-alist");
        e8.gotoChar(e8.pointMax()); e8.insert("def late\n");"##,
        serde_json::to_string(TEXT).unwrap()
    ));
    d.mx("imenu");
    d.type_text("*Rescan*");
    d.press("RET");
    d.type_text("late");
    d.press("RET");
    let late = TEXT.chars().count();
    assert_eq!(d.point(), late);

    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.went = null;
        e8.defun("my-goto", (name: string, pos: unknown, extra: unknown) => { went = [name, imenu.position(pos as any), extra]; });
        e8.setVariable("imenu-generic-expression", [[null, "^def \\([a-z_]+\\)", 1, "my-goto", "arg"]]);
        imenu.flushCache();
        imenu.imenu("alpha");"#,
    );
    assert_eq!(value(&mut ed, &s, "JSON.stringify(went)"), r#"["alpha",0,"arg"]"#);
}

/// imenu-default-create-index-function walks back with
/// imenu-prev-index-position-function and names each place with
/// imenu-extract-index-name-function.
#[test]
fn the_prev_index_and_extract_name_functions_make_an_index() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"e8.setVariable("imenu-generic-expression", null);
        e8.setVariable("imenu-prev-index-position-function", e8.defun("my-prev", () => e8.reSearchBackward("^class ", { noerror: true }) !== undefined));
        e8.setVariable("imenu-extract-index-name-function", e8.defun("my-name", () => { e8.call("forward-word", 2); const end = e8.point(); e8.call("backward-word", 1); return e8.bufferSubstringNoProperties(e8.point(), end); }));"#,
    );
    assert_eq!(value(&mut ed, &s, "JSON.stringify(shape(imenu.makeIndexAlist().slice(1)))"), r#"[["Beta",10],["Delta",110]]"#);
}

/// imenu-add-menubar-index puts an Index menu on the buffer's menu bar,
/// *Rescan* first, then the submenus and items, each going there.
#[test]
fn the_index_goes_on_the_menu_bar() {
    let (mut ed, s) = setup();
    ed.call("imenu-add-menubar-index", vec![]).unwrap();
    eval(&mut ed, &s, r#"e8.runHooks("menu-bar-update-hook");"#);
    let labels = value(
        &mut ed,
        &s,
        r#"JSON.stringify((() => { const index = e8.lookupKey(e8.currentLocalMap()!, "<menu-bar> <index>") as e8.Keymap; return e8.keymapMenuKeys(index).map((k) => e8.menuItem(index, k)?.label); })())"#,
    );
    assert_eq!(labels, r#"["*Rescan*","Classes","alpha","gamma_with_a_very_long_name_that_goes_on_and_on_beyond_sixty"]"#);
    let alpha = value(
        &mut ed,
        &s,
        r#"(() => { const index = e8.lookupKey(e8.currentLocalMap()!, "<menu-bar> <index>") as e8.Keymap; const key = e8.keymapMenuKeys(index).find((k) => e8.menuItem(index, k)?.label === "alpha")!; return String(e8.menuItem(index, key)?.binding); })()"#,
    );
    eval(&mut ed, &s, &format!(r#"e8.gotoChar(e8.pointMax()); e8.call({});"#, serde_json::to_string(&alpha).unwrap()));
    assert_eq!(value(&mut ed, &s, "String(e8.point())"), "0");
}

/// An empty index is made again next time, as Emacs's nil is; an index
/// function that gives numbers has them kept as markers; makeIndex, for
/// packages, always makes the index afresh.
#[test]
fn empty_indexes_are_remade_and_numbers_kept_as_markers() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.items = [];
        e8.setVariable("imenu-create-index-function", e8.defun("my-index", () => items.map((x) => [...x])));"#,
    );
    assert!(value(&mut ed, &s, r#"e8.conditionCase(() => { imenu.makeIndexAlist(); return "made"; }, { error: (e) => e.message })"#).starts_with("No items"));
    eval(&mut ed, &s, r#"items.push(["one", 20]);"#);
    assert_eq!(value(&mut ed, &s, "JSON.stringify(shape(imenu.makeIndexAlist()))"), r#"[["*Rescan*",-99],["one",20]]"#);
    eval(&mut ed, &s, r#"e8.gotoChar(0); e8.insert("xxxx");"#);
    assert_eq!(value(&mut ed, &s, "JSON.stringify(shape(imenu.makeIndexAlist()))"), r#"[["*Rescan*",-99],["one",24]]"#);
    eval(&mut ed, &s, r#"items.push(["two", 30]);"#);
    assert_eq!(value(&mut ed, &s, "JSON.stringify(imenu.makeIndex())"), r#"[["one",20],["two",30]]"#);
}

/// A new major mode gives the buffer a local map without the Index menu;
/// imenu-add-menubar-index, run again from its hook, puts it back.
#[test]
fn the_menu_bar_index_comes_back_after_a_new_major_mode() {
    let (mut ed, s) = setup();
    ed.call("imenu-add-menubar-index", vec![]).unwrap();
    let has = |ed: &mut Editor| value(ed, &s, r#"String(e8.keymapp(e8.lookupKey(e8.currentLocalMap() ?? "global-map", "<menu-bar> <index>")))"#);
    assert_eq!(has(&mut ed), "true");
    eval(&mut ed, &s, r#"e8.call("text-mode"); e8.setVariable("imenu-generic-expression", [[null, "^def \\([a-z_]+\\)", 1]]);"#);
    assert_eq!(has(&mut ed), "false");
    ed.call("imenu-add-menubar-index", vec![]).unwrap();
    assert_eq!(has(&mut ed), "true");
}
