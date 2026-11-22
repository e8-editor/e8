//! org-odd-levels-only where the Emacs oracle cannot look: the level faces
//! headings get, which headings refile targets take and where a refiled
//! tree goes, and capture's outline paths.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

/// Visits `tasks.org` with `text` in a fresh editor, odd levels only.
fn odd(text: &str) -> (Editor, Scripting, tempfile::TempDir) {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, text).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_default("org-odd-levels-only", Value::Bool(true));
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    (ed, s, dir)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The face on the heading at `needle`'s title.
fn face_of(ed: &mut Editor, needle: &str) -> String {
    ed.redisplay();
    let at = text(ed).find(needle).unwrap();
    match ed.window_buffer().text_property(at, "face") {
        Some(Value::Str(s)) => s.clone(),
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>().join(","),
        _ => String::new(),
    }
}

/// With odd levels only, a heading's face is its level's reduced, as
/// org-get-level-face gives it: one and two stars level 1 and 2's faces,
/// three stars level 2's; and without org-cycle-level-faces, the deepest
/// of org-n-level-faces for any deeper.
#[test]
fn level_faces_count_odd_levels() {
    let (mut ed, _s, _dir) = odd("* A\n** B\n*** C\n***** D\n");
    assert_eq!(face_of(&mut ed, "A"), "org-level-1");
    assert_eq!(face_of(&mut ed, "B"), "org-level-2");
    assert_eq!(face_of(&mut ed, "C"), "org-level-2");
    assert_eq!(face_of(&mut ed, "D"), "org-level-3");
    ed.set_default("org-odd-levels-only", Value::Bool(false));
    ed.set_variable("org-odd-levels-only", Value::Bool(false));
    ed.set_variable("org-n-level-faces", Value::Number(2.0));
    ed.set_variable("org-cycle-level-faces", Value::Bool(false));
    ed.call("font-lock-flush", vec![]).unwrap();
    assert_eq!(face_of(&mut ed, "D"), "org-level-2");
    ed.set_variable("org-cycle-level-faces", Value::Bool(true));
    ed.call("font-lock-flush", vec![]).unwrap();
    // The fifth level, cycling through two faces.
    assert_eq!(face_of(&mut ed, "D"), "org-level-1");
}

/// :maxlevel 2 takes headings of up to three stars with odd levels only,
/// and a tree refiled goes two stars below its target.
#[test]
fn refile_targets_and_placement_count_odd_levels() {
    let (mut ed, s, _dir) = odd("* A\n*** A1\n***** A2\n* B\n");
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"e8.setVariable("org-refile-targets", [[null, ":maxlevel", 2]]);
           import("org-refile").then(({ refileTargets }) => e8.message(JSON.stringify(refileTargets().map((t) => t.name))));"#
            .to_string(),
    )
    .unwrap();
    assert_eq!(ed.echo(), Some(r#"["A","A1","B"]"#));
    ed.press("M-> C-p C-c C-w A 1 RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "* A\n*** A1\n***** A2\n***** B\n");
    // :level 2 takes the three-star headings only.
    s.eval_typescript(
        &mut ed,
        "test2.ts",
        r#"e8.setVariable("org-refile-targets", [[null, ":level", 2]]);
           import("org-refile").then(({ refileTargets }) => e8.message(JSON.stringify(refileTargets().map((t) => t.name))));"#
            .to_string(),
    )
    .unwrap();
    assert_eq!(ed.echo(), Some(r#"["A1"]"#));
}

/// A capture template's outline path finds a child two stars down, as
/// org-find-olp takes levels from one to two below with odd levels only.
#[test]
fn capture_outline_paths_find_odd_children() {
    let (mut ed, s, dir) = odd("* Projects\n*** E8\n");
    let file = dir.path().join("tasks.org").display().to_string();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        format!(r#"e8.setVariable("org-capture-templates", [["t", "Task", "entry", ["file+olp", {file:?}, "Projects", "E8"], "* TODO %?", ":immediate-finish", true]]);"#),
    )
    .unwrap();
    ed.press("M-x o r g - c a p t u r e RET t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let buffer = ed.buffers().iter().find(|b| b.name == "tasks.org").unwrap();
    assert_eq!(buffer.slice(0..buffer.len()), "* Projects\n*** E8\n***** TODO \n");
}
