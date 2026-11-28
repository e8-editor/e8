//! org-num-mode where the Emacs oracle does not look: the faces of the
//! numbers, a format function of one's own, turning the mode off, and
//! leaving Org mode. Each expected result is what Emacs 30.2's org-num.el
//! gives on the same text.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

/// Each numbering overlay, by where it starts: its ends, its after-string and that string's face.
fn numbers(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(
        ed,
        r#"e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "org-num") !== undefined)
             .sort((a, b) => (e8.overlayStart(a) ?? 0) - (e8.overlayStart(b) ?? 0))
             .map((o) => { const v = e8.overlayGet(o, "after-string"); const str = v instanceof e8.PropertizedString ? v.string : v;
                           const face = v instanceof e8.PropertizedString ? v.properties.filter(([a, b]) => a <= 0 && 0 < b).map(([, , p]) => (typeof p.face === "symbol" ? e8.symbolName(p.face) : String(p.face))).join("") : "";
                           return `${e8.overlayStart(o)}-${e8.overlayEnd(o)} ${str === null || str === undefined ? "nil" : JSON.stringify(str)} ${face}`; })
             .join("; ")"#,
    )
    .unwrap()
}

#[test]
fn numbers_take_their_headings_faces_cycling_after_eight() {
    let (mut ed, s) = org("* A\n** B\n*** C\n**** D\n***** E\n****** F\n******* G\n******** H\n********* I\n");
    ed.call("org-num-mode", vec![]).unwrap();
    assert_eq!(
        numbers(&mut ed, &s),
        r#""0-2 \"1 \" org-level-1; 4-7 \"1.1 \" org-level-2; 9-13 \"1.1.1 \" org-level-3; 15-20 \"1.1.1.1 \" org-level-4; 22-28 \"1.1.1.1.1 \" org-level-5; 30-37 \"1.1.1.1.1.1 \" org-level-6; 39-47 \"1.1.1.1.1.1.1 \" org-level-7; 49-58 \"1.1.1.1.1.1.1.1 \" org-level-8; 60-70 \"1.1.1.1.1.1.1.1.1 \" org-level-1""#
    );
    ed.press("M-x o r g - n u m - m o d e RET").unwrap();
    assert_eq!(numbers(&mut ed, &s), r#""""#);
}

#[test]
fn org_num_face_overrides_the_headings_faces() {
    let (mut ed, s) = org("* A\n** B\n");
    ed.set_variable("org-num-face", Value::Symbol("bold".into()));
    ed.call("org-num-mode", vec![]).unwrap();
    assert_eq!(numbers(&mut ed, &s), r#""0-2 \"1 \" bold; 4-7 \"1.1 \" bold""#);
}

/// A format function's own face wins, and nil from it shows nothing.
#[test]
fn a_format_function_of_ones_own() {
    let (mut ed, s) = org("* A\n** B\n");
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"e8.setVariable("org-num-format-function", (n: number[]) => n.length === 1 ? e8.propertize(`<${n[0]}> `, { face: "italic" }) : null);"#.to_string(),
    )
    .unwrap();
    ed.call("org-num-mode", vec![]).unwrap();
    assert_eq!(numbers(&mut ed, &s), r#""0-2 \"<1> \" italic; 4-7 nil ""#);
}

/// Another major mode takes the numbers away.
#[test]
fn changing_the_major_mode_clears_the_numbers() {
    let (mut ed, s) = org("* A\n");
    ed.call("org-num-mode", vec![]).unwrap();
    ed.call("fundamental-mode", vec![]).unwrap();
    assert_eq!(numbers(&mut ed, &s), r#""""#);
}

#[test]
fn outside_org_mode_it_refuses() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* A\n");
    let err = ed.call("org-num-mode", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Cannot activate headline numbering outside Org mode");
}
