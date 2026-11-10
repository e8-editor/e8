//! Themes: a package that does not ship with E8, examples/packages/example-theme.ts,
//! loaded along load-path as a user's config loads it, gives faces their colours.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    (ed, s)
}

fn attribute(ed: &Editor, face: &str, key: &str) -> Value {
    ed.face_attribute(face, &format!(":{key}"), false)
}

#[test]
fn load_theme_gives_faces_the_themes_colours_and_disable_takes_them_back() {
    let (mut ed, s) = setup();
    let foreground = attribute(&ed, "default", "foreground");
    let link = attribute(&ed, "link", "foreground");
    s.eval_expression(&mut ed, r#"e8.call("load-theme", "example", true)"#).unwrap();
    assert_eq!(ed.variable("custom-enabled-themes"), Some(Value::List(vec![Value::Str("example".into())])));
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#232B36".into()));
    assert_eq!(attribute(&ed, "default", "foreground"), Value::Str("#D6DCE4".into()));
    assert_eq!(attribute(&ed, "org-level-1", "foreground"), Value::Str("#5FB3B3".into()));
    // A theme's face replaces the face's own attributes, as in Emacs: the example's
    // link is only underlined, so it loses its colour.
    assert_eq!(attribute(&ed, "link", "foreground"), Value::Str("unspecified".into()));
    // The frame's description carries what the GUI draws its own parts in.
    let frame = ed.selected_frame();
    let fd = ed.describe_frame(frame, 1.0);
    assert!(fd.default_style.background.is_some());
    assert!(fd.chrome.mode_line.as_ref().is_some_and(|m| m.background.is_some()));
    ed.call("disable-theme", vec![e8_core::Arg::Str("example".into())]).unwrap();
    assert_eq!(attribute(&ed, "default", "foreground"), foreground);
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("unspecified".into()));
    assert_eq!(attribute(&ed, "link", "foreground"), link);
    assert_eq!(ed.variable("custom-enabled-themes"), Some(Value::List(vec![])));
}

#[test]
fn a_theme_that_is_not_there_is_an_error() {
    let (mut ed, s) = setup();
    let e = s.eval_expression(&mut ed, r#"e8.conditionCase(() => e8.call("load-theme", "no-such", true), { "file-missing": (e) => e.message })"#).unwrap();
    assert_eq!(e, "\"Cannot open load file: No such file or directory, no-such-theme\"");
}

#[test]
fn init_ts_loads_a_theme_from_the_config_directory() {
    // As a user's ~/.config/e8 holds it: the theme in packages/, init.ts loading it.
    let config = tempfile::tempdir().unwrap();
    std::fs::create_dir(config.path().join("packages")).unwrap();
    std::fs::copy(format!("{EXAMPLES}/example-theme.ts"), config.path().join("packages/example-theme.ts")).unwrap();
    std::fs::write(config.path().join("init.ts"), "e8.call(\"load-theme\", \"example\", true);\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(config.path().join("packages").display().to_string())]));
    e8_script::config::load_init(&mut ed, &s, config.path());
    assert_eq!(ed.echo(), None, "init.ts loaded without an error");
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#232B36".into()));
}



#[test]
fn load_theme_completes_over_the_themes_along_load_path() {
    let (mut ed, s) = setup();
    // None is loaded yet, as Emacs's custom-available-themes finds them.
    assert_eq!(s.eval_expression(&mut ed, r#"JSON.stringify(e8.funcall("custom-available-themes"))"#).unwrap(), r#""[\"example\"]""#);
    ed.press("M-x").unwrap();
    ed.type_text("load-theme");
    ed.press("RET").unwrap();
    ed.type_text("exa");
    ed.press("TAB").unwrap();
    assert_eq!(ed.minibuffer_input(), "example");
}

#[test]
fn a_theme_is_read_without_being_enabled() {
    // As a theme chooser reads one, from a package importing custom.
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("reader.ts"),
        r##"import { customThemeSettings, loadTheme } from "custom";
e8.defun("read-theme", (name: string) => {
  loadTheme(name, true, true);
  const t = customThemeSettings(name);
  return JSON.stringify([t?.doc, t?.faces.find(([f]) => f === "default")?.[1].background]);
});
"##,
    )
    .unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(dir.path().display().to_string()), Value::Str(EXAMPLES.into())]));
    let read = s.eval_expression(&mut ed, r#"e8.require("reader"), e8.funcall("read-theme", "example")"#).unwrap();
    assert_eq!(read, r##""[\"A dusk of slate and amber, as an example of a theme\",\"#232B36\"]""##);
    assert_eq!(ed.variable("custom-enabled-themes"), Some(Value::List(vec![])));
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("unspecified".into()));
}

#[test]
fn a_face_set_for_both_backgrounds_wins_over_its_dark_and_light_ones() {
    // As Emacs's set-face-attribute for every frame, and a theme's face spec,
    // replace what the face's defface gives each background: Solarized's
    // diff-header background, not the dark one diff-mode defines.
    let (mut ed, s) = setup();
    let get = |ed: &mut Editor, face: &str| s.eval_expression(ed, &format!("String(e8.faceAttribute({face:?}, \":background\", true))")).unwrap();
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("default", { background: "#002b36" })"##).unwrap();
    assert_eq!(get(&mut ed, "diff-header"), "\"#737373\"");
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("diff-header", { background: "#073642" })"##).unwrap();
    assert_eq!(get(&mut ed, "diff-header"), "\"#073642\"");
    assert_eq!(get(&mut ed, "diff-hunk-header"), "\"#073642\"");
    // One background's own still applies only there.
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("diff-header", { background: "#ff0000" }, { background: "light" })"##).unwrap();
    assert_eq!(get(&mut ed, "diff-header"), "\"#073642\"");
}

#[test]
fn a_height_that_is_a_whole_factor_is_given_as_one() {
    // Lisp keeps 2.0, a factor, apart from 2, a tenth of a point; a script's
    // number cannot, so a whole factor is { factor: 2 }.
    let (mut ed, s) = setup();
    let height = |ed: &mut Editor, face: &str| s.eval_expression(ed, &format!("JSON.stringify(e8.faceAttribute({face:?}, \":height\"))")).unwrap();
    s.eval_expression(&mut ed, r#"e8.setFaceAttribute("big", { height: { factor: 2 } })"#).unwrap();
    s.eval_expression(&mut ed, r#"e8.setFaceAttribute("fifth", { height: 1.2 })"#).unwrap();
    s.eval_expression(&mut ed, r#"e8.setFaceAttribute("twelve", { height: 120 })"#).unwrap();
    assert_eq!(height(&mut ed, "big"), r#""{\"factor\":2}""#);
    assert_eq!(height(&mut ed, "fifth"), "\"1.2\"");
    assert_eq!(height(&mut ed, "twelve"), "\"120\"");
    let dark = ed.dark_background();
    assert_eq!(ed.style_for(&["big".to_string()], dark).scale, 2.0);
}

#[test]
fn a_foreground_too_near_its_background_gives_way_to_the_distant_one() {
    // As Emacs: Doom's lazy-highlight gives a foreground near its background
    // and a distant-foreground to draw instead, by color-distance and
    // face-near-same-color-threshold.
    let (mut ed, s) = setup();
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("default", { foreground: "#000000", background: "#ffffff" })"##).unwrap();
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("near", { foreground: "#f0f0f0", distantForeground: "#202020" })"##).unwrap();
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("far", { foreground: "#cc0000", distantForeground: "#202020" })"##).unwrap();
    let dark = ed.dark_background();
    let fg = |ed: &Editor, face: &str| ed.style_for(&[face.to_string()], dark).foreground.map(|c| (c.r, c.g, c.b));
    assert_eq!(fg(&ed, "near"), Some((0x20, 0x20, 0x20)));
    assert_eq!(fg(&ed, "far"), Some((0xcc, 0, 0)));
}

#[test]
fn load_theme_loads_a_theme_again_so_its_options_take_effect() {
    // As Emacs's load-theme, which loads the file each time: an option the
    // theme reads when it loads, set after the first, shows on the second.
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("optioned-theme.ts"),
        r##"import { customThemeSetFaces, deftheme, provideTheme } from "custom";
e8.defineVariable({ name: "optioned-dark", value: false });
deftheme("optioned", "A theme with an option");
customThemeSetFaces("optioned", [["default", { background: e8.variable("optioned-dark") === true ? "#000000" : "#ffffff" }]]);
provideTheme("optioned");
"##,
    )
    .unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(dir.path().display().to_string())]));
    s.eval_expression(&mut ed, r#"e8.call("load-theme", "optioned", true)"#).unwrap();
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#ffffff".into()));
    s.eval_expression(&mut ed, r#"e8.setVariable("optioned-dark", true), e8.call("load-theme", "optioned", true)"#).unwrap();
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#000000".into()));
    assert_eq!(ed.variable("custom-enabled-themes"), Some(Value::List(vec![Value::Str("optioned".into())])));
}

#[test]
fn a_theme_with_no_file_of_its_own_is_enabled_again_as_it_is() {
    // One a configuration defines in init.ts has no file to load again.
    let (mut ed, s) = setup();
    s.eval_expression(
        &mut ed,
        r##"e8.funcall("deftheme", "inline"), e8.funcall("custom-theme-set-faces", "inline", [["default", { background: "#123456" }]]), e8.funcall("provide-theme", "inline")"##,
    )
    .unwrap();
    s.eval_expression(&mut ed, r#"e8.call("load-theme", "inline", true)"#).unwrap();
    s.eval_expression(&mut ed, r#"e8.call("load-theme", "inline", true)"#).unwrap();
    assert_eq!(attribute(&ed, "default", "background"), Value::Str("#123456".into()));
}
