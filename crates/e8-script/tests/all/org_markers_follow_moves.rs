//! A running clock follows its entry archived to another file, which the
//! Emacs oracle cannot compare, its archive's header naming a temporary
//! directory.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

#[test]
fn the_clock_follows_its_entry_into_the_archive() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, "* A\ntext\n* B\n").unwrap();
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-21".into()));
    ed.press("C-c C-x C-i C-c C-x C-s C-c C-x C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let archive = ed.buffers().iter().find(|b| b.name == "t.org_archive").expect("the archive is visited");
    let text = archive.slice(0..archive.len());
    assert!(text.contains("CLOCK: [2026-11-21 Sat 12:00]--[2026-11-21 Sat 12:00] =>  0:00\n"), "{text}");
}
