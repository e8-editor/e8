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

/// Unset, the file is org-clock-save.el in user-emacs-directory as it is
/// when the clock is saved, after init.ts has set it, not as packages loaded.
#[test]
fn the_default_file_is_in_the_config_directory() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* Task\n").unwrap();
    let (mut ed, s) = session(dir.path());
    ed.set_variable("org-clock-persist-file", Value::Bool(false));
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", dir.path().to_str().unwrap())));
    visit(&mut ed, &file);
    ed.press("C-c C-x C-i").unwrap();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-save");"#.to_string()).unwrap();
    assert!(dir.path().join("org-clock-save.el").exists());
}

/// Emacs leaves a space for each entry whose buffer had gone, before or
/// between the others; the rest of the history is still read.
#[test]
fn a_history_with_gaps_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* One\n* Two\n").unwrap();
    let path = file.to_str().unwrap();
    std::fs::write(
        dir.path().join("org-clock-save.el"),
        format!(";; org-clock-save.el - host at <2026-11-21 Sat 11:00>\n(setq org-clock-stored-history '( (\"{path}\" . 1)  (\"{path}\" . 7)))\n"),
    )
    .unwrap();
    let (mut ed, s) = session(dir.path());
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-persistence-insinuate");"#.to_string()).unwrap();
    visit(&mut ed, &file);
    // C-u C-c C-x C-i offers the history: the most recent, Two, is 1.
    ed.press("M-< C-u C-c C-x C-i 1").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).contains("* Two\n:LOGBOOK:\nCLOCK: [2026-11-21 Sat 12:00]\n:END:\n"), "{}", text(&ed));
}

/// A saved clock in a file named through a link resumes in the buffer
/// already visiting it, not a second one, so clocking out shows there.
#[test]
fn a_clock_saved_under_another_name_resumes_in_the_visited_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    let link = dir.path().join("link.org");
    std::fs::write(&file, "* Task\n:LOGBOOK:\nCLOCK: [2026-11-21 Sat 09:00]\n:END:\n").unwrap();
    std::os::unix::fs::symlink(&file, &link).unwrap();
    std::fs::write(
        dir.path().join("org-clock-save.el"),
        format!(";; org-clock-save.el - host at <2026-11-21 Sat 11:00>\n(setq org-clock-stored-resume-clock '(\"{}\" . 45))\n", link.to_str().unwrap()),
    )
    .unwrap();
    let (mut ed, s) = session(dir.path());
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-clock-persistence-insinuate");"#.to_string()).unwrap();
    visit(&mut ed, &file);
    ed.press("C-c C-x C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "* Task\n:LOGBOOK:\nCLOCK: [2026-11-21 Sat 09:00]--[2026-11-21 Sat 12:00] =>  3:00\n:END:\n");
}

/// org-clock-persist as a symbol, as set-variable or a local variable gives
/// it, counts as its name.
#[test]
fn a_symbol_value_counts() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* Task\n").unwrap();
    let (mut ed, s) = session(dir.path());
    visit(&mut ed, &file);
    ed.press("C-c C-x C-i").unwrap();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.setVariable("org-clock-persist", e8.intern("clock")); e8.funcall("org-clock-save");"#.to_string()).unwrap();
    let saved = std::fs::read_to_string(dir.path().join("org-clock-save.el")).unwrap();
    assert!(saved.contains("org-clock-stored-resume-clock"), "{saved}");
    assert!(!saved.contains("org-clock-stored-history"), "{saved}");
}

/// With org-clock-ask-before-exiting nil, exiting with a clock running does
/// not ask to stop it.
#[test]
fn exiting_need_not_ask() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* Task\n").unwrap();
    let (mut ed, s) = session(dir.path());
    visit(&mut ed, &file);
    ed.press("C-c C-x C-i").unwrap();
    ed.set_variable("org-clock-ask-before-exiting", Value::Bool(false));
    s.eval_typescript(&mut ed, "t.ts", r#"e8.message(String(e8.funcall("org-clock-kill-emacs-query")));"#.to_string()).unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("true"));
    assert!(text(&ed).contains("CLOCK: [2026-11-21 Sat 12:00]\n"), "{}", text(&ed));
}
