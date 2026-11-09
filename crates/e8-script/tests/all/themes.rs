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
