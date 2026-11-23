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

/// C-c C-w in the capture finishes it and refiles its entry.
#[test]
fn refiling_from_the_capture() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* Inbox\n* Other\n").unwrap();
    s.eval_typescript(&mut ed, "t.ts", format!(r#"e8.setVariable("org-capture-templates", [["t", "T", "entry", ["file+headline", "{}", "Inbox"], "* %?\n"]]);"#, notes.display()))
        .unwrap();
    ed.press("M-x o r g - c a p t u r e RET t n e w C-c C-w O t h e r RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let b = ed.buffers().iter().find(|b| b.name == "notes.org").unwrap();
    assert_eq!(b.slice(0..b.len()), "* Inbox\n* Other\n** new\n");
}


/// %[file] puts a file's text in; one that cannot be read says so.
#[test]
fn a_file_s_text_in_the_template() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n").unwrap();
    std::fs::write(dir.path().join("part.txt"), "from a file").unwrap();
    let d = dir.path().display();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        format!(r#"e8.setVariable("org-capture-templates", [["t", "T", "entry", ["file", "{d}/notes.org"], "* %[{d}/part.txt]\n%[{d}/none.txt]%?\n"]]);"#),
    )
    .unwrap();
    ed.press("M-x o r g - c a p t u r e RET t C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let text = std::fs::read_to_string(&notes).unwrap();
    // Each on a line of its own: the regexp is greedy, as Org's is.
    assert!(text.starts_with("* One\n* from a file\n%![could not insert "), "{text}");
}

/// Each %^{prompt} keeps its own history: M-p gives the last answer to it.
#[test]
fn each_prompt_has_its_history() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "").unwrap();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        format!(r#"e8.setVariable("org-capture-templates", [["t", "T", "entry", ["file", "{}"], "* %^{{Who}} %^{{What}}\n"]]);"#, notes.display()),
    )
    .unwrap();
    ed.press("M-x o r g - c a p t u r e RET t a n n RET t e a RET C-c C-c").unwrap();
    ed.press("M-x o r g - c a p t u r e RET t M-p RET M-p RET C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "* ann tea\n* ann tea\n");
}

/// :kill-buffer kills a buffer visited for the capture, once saved, and the
/// template's :prepare-finalize, :before-finalize and :after-finalize run.
#[test]
fn kill_buffer_and_finalize_functions() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n").unwrap();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        format!(
            r#"globalThis.ran = [];
            e8.defun("note-prepare", () => {{ globalThis.ran.push("prepare"); }});
            e8.defun("note-before", () => {{ globalThis.ran.push("before"); }});
            e8.defun("note-after", () => {{ globalThis.ran.push("after"); }});
            e8.setVariable("org-capture-templates", [["t", "T", "entry", ["file", "{}"], "* new%?\n", ":kill-buffer", true,
              ":prepare-finalize", e8.intern("note-prepare"), ":before-finalize", [e8.intern("note-before")], ":after-finalize", e8.intern("note-after")]]);"#,
            notes.display()
        ),
    )
    .unwrap();
    ed.press("M-x o r g - c a p t u r e RET t C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "* One\n* new\n");
    assert!(!ed.buffers().iter().any(|b| b.name == "notes.org"));
    s.eval_typescript(&mut ed, "t.ts", r#"e8.message(globalThis.ran.join(","));"#.to_string()).unwrap();
    assert_eq!(ed.echo(), Some("prepare,before,after"));
}

/// A capture's kept clock is named again from the heading written, as
/// org-clock-update-mode-line refreshes it, so C-2 C-c C-w names it; %k is
/// org-clock-heading.
#[test]
fn a_kept_clock_is_named_by_its_heading() {
    let (mut ed, s, dir) = editor("[]");
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* Inbox\n* COMMENT Old [[x][link]]\n").unwrap();
    s.eval_typescript(
        &mut ed,
        "t.ts",
        format!(
            r#"e8.setVariable("org-capture-templates", [["t", "T", "entry", ["file+headline", "{}", "Inbox"], "* %?\n", ":clock-in", true, ":clock-keep", true], ["k", "K", "plain", ["file+headline", "{}", "Inbox"], "was %k%?"]]);"#,
            notes.display(),
            notes.display()
        ),
    )
    .unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(notes.to_str().unwrap().into())]).unwrap();
    // %k on a COMMENT heading with a link: without COMMENT, the link as its description.
    ed.press("C-n C-c C-x C-i M-x o r g - c a p t u r e RET k C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(std::fs::read_to_string(&notes).unwrap().contains("was Old link\n"), "{}", std::fs::read_to_string(&notes).unwrap());
    ed.press("M-x o r g - c a p t u r e RET t T y p e d SPC n a m e C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(s.eval_expression(&mut ed, r#"e8.variable("org-clock-heading")"#).unwrap(), "\"Typed name\"");
}

/// An entry captured at another level is demoted or promoted a heading at
/// a time, as org-paste-subtree does it, so the hooks run for each, as in
/// Emacs 30.2's Org 9.7.
#[test]
fn captured_entries_run_the_level_hooks() {
    let (mut ed, s, dir) = editor(
        r#"[["t", "T", "entry", ["file+headline", "DIR/notes.org", "Tasks"], "* TODO task\n** sub"], ["u", "U", "entry", ["file+headline", "DIR/notes.org", "Tasks"], "*** deep\n**** deeper"]]"#,
    );
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* One\n* Tasks\n* Later\n").unwrap();
    s.eval_expression(
        &mut ed,
        "(globalThis.seen = [], ['demote', 'promote'].forEach((tag) => e8.addHook(`org-after-${tag}-entry-hook`, () => { globalThis.seen.push(`${tag}:${e8.lineText(e8.lineOf(e8.point()))}`); })))",
    )
    .unwrap();
    ed.press("M-x o r g - c a p t u r e RET t C-c C-c").unwrap();
    ed.press("M-x o r g - c a p t u r e RET u C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let seen = s.eval_expression(&mut ed, "globalThis.seen.join('|')").unwrap();
    assert_eq!(seen.trim_matches('"'), "demote:** TODO task|demote:*** sub|promote:** deep|promote:*** deeper");
    let text = std::fs::read_to_string(&notes).unwrap();
    assert_eq!(text, "* One\n* Tasks\n** TODO task\n*** sub\n** deep\n*** deeper\n* Later\n");
}
