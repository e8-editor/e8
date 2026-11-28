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

/// A format function's string without a face at its start gets the
/// heading's face over all of it, its other properties kept, as Org's
/// org-add-props puts it: Emacs gives `#("<1> " 0 1 (face org-level-1
/// help-echo "h") 1 4 (help-echo "h" face org-level-1))`.
#[test]
fn a_formats_other_properties_are_kept() {
    let (mut ed, s) = org("* A\n");
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"e8.setVariable("org-num-format-function", (n: number[]) => e8.concat(e8.propertize("<", { "help-echo": "h" }), e8.propertize(`${n[0]}> `, { face: "bold", "help-echo": "h" })));"#.to_string(),
    )
    .unwrap();
    ed.call("org-num-mode", vec![]).unwrap();
    let props = s
        .eval_expression(
            &mut ed,
            r#"(() => { const v = e8.overlayGet(e8.overlaysIn(e8.pointMin(), e8.pointMax()).find((o) => e8.overlayGet(o, "org-num") !== undefined)!, "after-string") as e8.PropertizedString;
                 return [0, 1, 2, 3].map((i) => { const p = Object.assign({}, ...v.properties.filter(([a, b]) => a <= i && i < b).map(([, , q]) => q)); return `${String(p.face)}/${String(p["help-echo"])}`; }).join(" "); })()"#,
        )
        .unwrap();
    assert_eq!(props, r#""org-level-1/h org-level-1/h org-level-1/h org-level-1/h""#);
}

/// Numbering thousands of headings and changing one stays quick, as Org's
/// work is a walk of the overlays per change, and an overlay's number is
/// put again only where it changes. Emacs took 17 ms to number 4000
/// headings and 2 ms per demotion on the reviewer's machine. Demoting the
/// first heading renumbers every other, as in Org, which puts each number
/// again; so what the numbering adds is measured against putting every
/// after-string once, and the demotions without it, which calibrates for a
/// loaded machine and QuickJS.
#[test]
fn many_headings_are_numbered_quickly() {
    let text: String = (0..4000).map(|i| format!("* H{i}\n** Sub{i}\n")).collect();
    let (mut ed, s) = org(&text);
    let demote = |ed: &mut Editor| {
        let started = std::time::Instant::now();
        for _ in 0..5 {
            ed.press("M-< M-<right> M-<left>").unwrap();
        }
        started.elapsed() / 10
    };
    let plain = demote(&mut ed);
    let started = std::time::Instant::now();
    ed.call("org-num-mode", vec![]).unwrap();
    let enable = started.elapsed();
    let numbered = demote(&mut ed);
    let started = std::time::Instant::now();
    s.eval_expression(&mut ed, r#"(() => { for (const o of e8.overlaysIn(e8.pointMin(), e8.pointMax())) e8.overlayPut(o, "after-string", e8.overlayGet(o, "after-string")!); })()"#).unwrap();
    let put_all = started.elapsed();
    eprintln!("enabling: {enable:?}; each demotion or promotion: {numbered:?}, {plain:?} without numbers; putting every number: {put_all:?}");
    let budget = if std::env::var("CI").is_ok() { 3 } else { 1 };
    assert!(enable < put_all * 8 + std::time::Duration::from_millis(500 * budget), "enabling took {enable:?}");
    // QuickJS runs the walk itself slower, where putting the numbers is the editor's work.
    let engine = if cfg!(feature = "quickjs") { 2 } else { 1 };
    assert!(numbered < plain * 2 + put_all * 3 * engine + std::time::Duration::from_millis(50 * budget), "each demotion took {numbered:?}");
    // Typing in a body renumbers nothing, so it costs about what it does without numbers.
    let started = std::time::Instant::now();
    ed.press("M-< C-n C-e x").unwrap();
    let typing = started.elapsed();
    assert!(typing < put_all + std::time::Duration::from_millis(50 * budget), "typing took {typing:?}");
    let last = s.eval_expression(&mut ed, r#"String(e8.overlayGet(e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "org-num") !== undefined).sort((a, b) => e8.overlayStart(b)! - e8.overlayStart(a)!)[0], "after-string"))"#).unwrap();
    assert_eq!(last, r#""4000.1 ""#);
}
