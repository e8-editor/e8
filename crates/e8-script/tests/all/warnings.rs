//! display-warning, warn and lwarn, as warnings.el logs and shows warnings.

use e8_core::Editor;
use e8_script::Scripting;

fn editor() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn warnings(ed: &Editor) -> String {
    ed.buffers().iter().find(|b| b.name == "*Warnings*").map(|b| b.slice(0..b.len())).unwrap_or_default()
}

/// A warning is logged with its level and type, and *Warnings* is shown.
#[test]
fn a_warning_is_logged_and_shown() {
    let (mut ed, s) = editor();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("warn", "Look at `%s'", "this"); e8.funcall("lwarn", [e8.intern("org"), e8.intern("id")], e8.intern(":error"), "Broken %d", 3);"#.to_string())
        .unwrap();
    assert_eq!(warnings(&ed), "\u{26d4} Warning (emacs): Look at \u{2018}this\u{2019}\n\u{26d4} Error (org): Broken 3\n");
    assert!(ed.windows().iter().any(|w| w.buffer.name == "*Warnings*"));
}

/// Levels below warning-minimum-log-level are not logged, below
/// warning-minimum-level not shown; suppressed types likewise.
#[test]
fn levels_and_types_suppress() {
    let (mut ed, s) = editor();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"e8.funcall("display-warning", e8.intern("a"), "debug", e8.intern(":debug"));
        e8.setVariable("warning-suppress-log-types", [[e8.intern("b")]]);
        e8.funcall("display-warning", e8.intern("b"), "suppressed");
        e8.funcall("display-warning", [e8.intern("b"), e8.intern("sub")], "subtype suppressed");
        e8.setVariable("warning-suppress-types", [[e8.intern("c")]]);
        e8.funcall("display-warning", e8.intern("c"), "logged only");"#
            .to_string(),
    )
    .unwrap();
    assert_eq!(warnings(&ed), "\u{26d4} Warning (c): logged only\n");
    assert!(!ed.windows().iter().any(|w| w.buffer.name == "*Warnings*"));
    let (mut ed, s) = editor();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.message(String(e8.funcall("warning-numeric-level", e8.intern(":error"))));"#.to_string()).unwrap();
    assert_eq!(ed.echo(), Some("3"));
}

/// An emergency rings the bell; a fill prefix fills the warning.
#[test]
fn emergencies_and_filling() {
    let (mut ed, s) = editor();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"e8.funcall("display-warning", e8.intern("e"), "emerg", e8.intern(":emergency"));
        e8.setVariable("warning-fill-prefix", "    ");
        e8.setVariable("warning-fill-column", 30);
        e8.funcall("display-warning", e8.intern("z"), "a long message that goes on and on past the column");"#
            .to_string(),
    )
    .unwrap();
    let w = warnings(&ed);
    assert!(w.starts_with("\u{26d4} Emergency (e): emerg\n\u{26d4} Warning (z): a"), "{w}");
    // Filled: continued on lines of its own, after the prefix.
    assert!(w.lines().count() > 3 && w.lines().skip(2).all(|l| l.starts_with("    ")), "{w}");
}

/// An obsolete level name is warned of and taken as its new one.
#[test]
fn obsolete_levels() {
    let (mut ed, s) = editor();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("display-warning", e8.intern("x"), "old", e8.intern("critical"));"#.to_string()).unwrap();
    assert_eq!(
        warnings(&ed),
        "\u{26d4} Warning (emacs): Warning level \u{2018}critical\u{2019} is obsolete; use \u{2018}:emergency\u{2019} instead\n\u{26d4} Emergency (x): old\n"
    );
}
