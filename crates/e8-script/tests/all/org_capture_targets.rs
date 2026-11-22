//! Capture targets the Emacs oracle does not record: the running clock's
//! entry, a file a function names, and the errors for targets not there.

use e8_core::Editor;
use e8_script::Scripting;

fn editor(templates: &str) -> (Editor, Scripting, tempfile::TempDir) {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let d = dir.path().display().to_string();
    s.eval_expression(&mut ed, &format!("(e8.setVariable(\"e8--today\", \"2026-11-21\"), e8.setVariable(\"org-capture-templates\", {}), 1)", templates.replace("DIR", &d)))
        .unwrap();
    ed.set_frame_size(80, 24);
    (ed, s, dir)
}

/// A clock target files under the running clock's entry.
#[test]
fn under_the_running_clock() {
    let (mut ed, _s, dir) = editor(r#"[["c", "Clock", "entry", ["clock"], "* %?\n"]]"#);
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n* Task\n* Three\n").unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(notes.to_str().unwrap().into())]).unwrap();
    ed.press("C-n C-c C-x C-i").unwrap();
    ed.press("M-x o r g - c a p t u r e RET c n o t e C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let text = std::fs::read_to_string(&notes).unwrap();
    assert!(text.contains("* Task\n:LOGBOOK:\nCLOCK: [2026-11-21 Sat 12:00]\n:END:\n** note\n* Three\n"), "{text}");
}

/// Without a running clock, a clock target says there is none.
#[test]
fn no_running_clock() {
    let (mut ed, _s, _dir) = editor(r#"[["c", "Clock", "entry", ["clock"], "* %?\n"]]"#);
    ed.press("M-x o r g - c a p t u r e RET c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("No running clock that could be used as capture target".into()));
}

/// An ID no entry has is said.
#[test]
fn a_missing_id() {
    let (mut ed, _s, dir) = editor(r#"[["i", "Id", "entry", ["id", "nowhere"], "* %?\n"]]"#);
    ed.set_variable("org-id-locations-file", e8_core::Value::Str(dir.path().join("ids").to_str().unwrap().into()));
    ed.press("M-x o r g - c a p t u r e RET i").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Cannot find target ID \"nowhere\"".into()));
}

/// A regexp the file does not match is said.
#[test]
fn no_match_for_the_regexp() {
    let (mut ed, _s, dir) = editor(r#"[["r", "Re", "plain", ["file+regexp", "DIR/notes.org", "absent"], "%?"]]"#);
    std::fs::write(dir.path().join("notes.org"), "* One\n").unwrap();
    ed.press("M-x o r g - c a p t u r e RET r").unwrap();
    let err = ed.take_error().map(|e| e.to_string()).unwrap_or_default();
    assert!(err.starts_with("No match for target regexp in file "), "{err}");
}

/// The file can be a function giving its name, as org-capture-expand-file calls it.
#[test]
fn a_file_a_function_names() {
    let (mut ed, s, dir) = editor(r#"[["f", "Fn", "entry", ["file", "where"], "* %?\n"]]"#);
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n").unwrap();
    s.eval_typescript(&mut ed, "t.ts", format!(r#"e8.defun("where", () => "{}"); e8.setVariable("org-capture-templates", [["f", "Fn", "entry", ["file", e8.intern("where")], "* %?\n"]]);"#, notes.display()))
        .unwrap();
    ed.press("M-x o r g - c a p t u r e RET f n e w C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "* One\n* new\n");
}

/// A template can be a file's contents or what a function gives, as
/// org-capture-get-template reads them; a missing one says so.
#[test]
fn templates_from_a_file_and_a_function() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n").unwrap();
    std::fs::write(dir.path().join("tpl.txt"), "* From file %?\n").unwrap();
    let d = dir.path().display();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        format!(
            r#"e8.defun("my-template", () => "* From function %?\n");
            e8.setVariable("org-capture-templates", [
              ["f", "File", "entry", ["file", "{d}/notes.org"], ["file", "{d}/tpl.txt"]],
              ["g", "Fn", "entry", ["file", "{d}/notes.org"], ["function", e8.intern("my-template")]],
              ["m", "Missing", "entry", ["file", "{d}/notes.org"], ["file", "{d}/none.txt"]]]);"#
        ),
    )
    .unwrap();
    ed.press("M-x o r g - c a p t u r e RET f C-c C-c").unwrap();
    ed.press("M-x o r g - c a p t u r e RET g C-c C-c").unwrap();
    ed.press("M-x o r g - c a p t u r e RET m C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let text = std::fs::read_to_string(&notes).unwrap();
    assert!(text.contains("* From file \n* From function \n* Template file "), "{text}");
}

/// An error placing the template is said with the template's key, and the
/// target's point is left where it was.
#[test]
fn an_error_placing_names_the_template() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n| a |\n|---|\n| 1 |\n").unwrap();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        format!(r#"e8.setVariable("org-capture-templates", [["t", "T", "table-line", ["file", "{}"], "| %? |", ":table-line-pos", "III+1"]]);"#, notes.display()),
    )
    .unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(notes.to_str().unwrap().into())]).unwrap();
    ed.press("M-x o r g - c a p t u r e RET t").unwrap();
    let err = ed.take_error().map(|e| e.to_string()).unwrap_or_default();
    assert!(err.starts_with("Capture template \u{2018}t\u{2019}: Invalid table line specification"), "{err}");
    assert_eq!(ed.window_buffer().point(), 0);
}
