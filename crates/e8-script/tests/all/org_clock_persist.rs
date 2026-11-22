//! Keeping the clock from one session to the next, as org-clock-save and
//! org-clock-load do, which the Emacs oracle cannot record, as it never
//! quits between keys.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn session(dir: &std::path::Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("org-clock-persist", Value::Bool(true));
    ed.set_variable("org-clock-persist-file", Value::Str(dir.join("org-clock-save.el").to_str().unwrap().into()));
    ed.set_variable("org-clock-persist-query-resume", Value::Bool(false));
    ed.set_variable("e8--today", Value::Str("2026-11-21".into()));
    (ed, s)
}

fn visit(ed: &mut Editor, file: &std::path::Path) {
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The running clock and the history are written as Emacs writes them, and
/// read back in the next session, the clock going on from its CLOCK line.
#[test]
fn the_clock_goes_on_in_the_next_session() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* Other\n* Task\n").unwrap();
    let (mut ed, s) = session(dir.path());
    visit(&mut ed, &file);
    ed.press("C-c C-x C-i C-c C-x C-o M-> C-p C-c C-x C-i").unwrap();
    ed.call("save-buffer", vec![]).unwrap();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-save");"#.to_string()).unwrap();
    let saved = std::fs::read_to_string(dir.path().join("org-clock-save.el")).unwrap();
    let path = file.to_str().unwrap();
    assert!(saved.starts_with(";; org-clock-save.el - "), "{saved}");
    assert!(saved.contains(&format!("(setq org-clock-stored-resume-clock '(\"{path}\" . ")), "{saved}");
    assert!(saved.contains(&format!("(setq org-clock-stored-history '((\"{path}\" . 1) (\"{path}\" . ")), "{saved}");
    drop(ed);

    let (mut ed, s) = session(dir.path());
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-persistence-insinuate");"#.to_string()).unwrap();
    visit(&mut ed, &file);
    ed.press("C-c C-x C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let t = text(&ed);
    // One CLOCK line for Task, closed now: resumed, not a second one.
    assert_eq!(t.matches("CLOCK: ").count(), 2, "{t}");
    assert!(!t.contains("CLOCK: [2026-11-21 Sat 12:00]\n"), "{t}");
}

/// A file Emacs wrote is read: positions there count from 1.
#[test]
fn a_file_emacs_wrote_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* Task\n:LOGBOOK:\nCLOCK: [2026-11-21 Sat 09:00]\n:END:\n").unwrap();
    let path = file.to_str().unwrap();
    std::fs::write(
        dir.path().join("org-clock-save.el"),
        format!(";; org-clock-save.el - host at <2026-11-21 Sat 11:00>\n(setq org-clock-stored-resume-clock '(\"{path}\" . 45))\n(setq org-clock-stored-history '((\"{path}\" . 1)))\n"),
    )
    .unwrap();
    let (mut ed, s) = session(dir.path());
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-persistence-insinuate");"#.to_string()).unwrap();
    visit(&mut ed, &file);
    ed.press("C-c C-x C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "* Task\n:LOGBOOK:\nCLOCK: [2026-11-21 Sat 09:00]--[2026-11-21 Sat 12:00] =>  3:00\n:END:\n");
}

/// With "history", only the history is saved.
#[test]
fn only_the_history() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* Task\n").unwrap();
    let (mut ed, s) = session(dir.path());
    ed.set_variable("org-clock-persist", Value::Str("history".into()));
    visit(&mut ed, &file);
    ed.press("C-c C-x C-i").unwrap();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-save");"#.to_string()).unwrap();
    let saved = std::fs::read_to_string(dir.path().join("org-clock-save.el")).unwrap();
    assert!(!saved.contains("org-clock-stored-resume-clock"), "{saved}");
    assert!(saved.contains("org-clock-stored-history"), "{saved}");
}
