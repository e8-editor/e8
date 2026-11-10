//! M-x diff and diff-mode: diff's output in *Diff* between the command and
//! the line saying it finished, hunks to move between, and RET to the source.

use crate::driven::Driven;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn buffer_text(ed: &mut Editor, s: &Scripting, name: &str) -> String {
    let got = s.eval_expression(ed, &format!("e8.withCurrentBuffer({name:?}, () => e8.bufferText(0, e8.bufferSize()))")).unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn diff_shows_the_changes_and_ret_goes_to_the_source_line() {
    // M-x diff asks for both files partway through, so on the editor's own thread.
    let d = Driven::new("");
    let dir = tempfile::tempdir().unwrap();
    let (old, new) = (dir.path().join("old.txt"), dir.path().join("new.txt"));
    std::fs::write(&old, "a\nb\nc\nd\n").unwrap();
    std::fs::write(&new, "a\nB\nc\nd\ne\n").unwrap();
    d.start(|ed| ed.call("diff", vec![]).unwrap());
    d.type_text(&new.display().to_string());
    d.press("RET");
    d.type_text(&old.display().to_string());
    d.press("RET");
    let got = d.eval_expression("e8.withCurrentBuffer('*Diff*', () => e8.bufferText(0, e8.bufferSize()))");
    let out: String = serde_json::from_str(&got).unwrap();
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], format!("diff -u {} {}", old.display(), new.display()));
    assert!(lines.contains(&"-b") && lines.contains(&"+B") && lines.contains(&"+e"), "{out}");
    assert!(lines.last().unwrap().starts_with("Diff finished.  "), "{out}");
    assert_eq!(d.eval_expression("e8.withCurrentBuffer('*Diff*', () => e8.variable('major-mode'))"), r#""diff-mode""#);
    // In *Diff*: n to the hunk, then to +B, and RET shows line 2 of new.txt.
    d.with(|ed| ed.call("switch-to-buffer", vec![Arg::Str("*Diff*".into())]).unwrap());
    d.press("M-< n");
    assert_eq!(d.with(|ed| { let b = ed.window_buffer(); b.slice(b.point()..b.point() + 2) }), "@@");
    d.press("C-n C-n C-n RET");
    assert_eq!(d.buffer_name(), "new.txt");
    assert_eq!(d.with(|ed| { let b = ed.window_buffer(); b.line_of(b.point()) }), 1, "the line of +B");
}

#[test]
fn diff_buffer_with_file_shows_what_saving_would_change() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "one\n").unwrap();
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.press("M->").unwrap();
    ed.type_text("two\n");
    ed.call("diff-buffer-with-file", vec![Arg::Str("notes.txt".into())]).unwrap();
    let out = buffer_text(&mut ed, &s, "*Diff*");
    assert!(out.contains(&format!("--- {}", file.display())), "{out}");
    assert!(out.contains("+++ notes.txt"), "{out}");
    assert!(out.contains("\n+two\n"), "{out}");
}

#[test]
fn diff_faces_have_a_background_for_dark_frames_too() {
    // As diff-mode.el's: on a dark theme's background, the light ones would
    // leave the lines' text unreadable.
    let (mut ed, s) = setup();
    let bg = |ed: &mut Editor, face: &str| s.eval_expression(ed, &format!("String(e8.faceAttribute({face:?}, \":background\", true))")).unwrap();
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("default", { background: "#ffffff" })"##).unwrap();
    assert_eq!(bg(&mut ed, "diff-added"), "\"#ddffdd\"");
    assert_eq!(bg(&mut ed, "diff-hunk-header"), "\"#d9d9d9\"");
    s.eval_expression(&mut ed, r##"e8.setFaceAttribute("default", { background: "#202020" })"##).unwrap();
    assert_eq!(bg(&mut ed, "diff-added"), "\"#335533\"");
    assert_eq!(bg(&mut ed, "diff-removed"), "\"#553333\"");
    assert_eq!(bg(&mut ed, "diff-hunk-header"), "\"#737373\"");
    assert_eq!(bg(&mut ed, "diff-file-header"), "\"#999999\"");
}
