//! org-occur-in-agenda-files, whose *Occur* the Emacs oracle does not
//! compare: the agenda files, the extra files and the archives searched.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn occur_text(ed: &Editor) -> String {
    let b = ed.buffers().iter().find(|b| b.name == "*Occur*").expect("*Occur* is made");
    b.slice(0..b.len())
}

#[test]
fn every_agenda_file_and_the_extra_ones_are_searched() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.org");
    let b = dir.path().join("b.org");
    let extra = dir.path().join("extra.org");
    std::fs::write(&a, "* TODO one\nneedle in a\n").unwrap();
    std::fs::write(&b, "* two\nno match\n").unwrap();
    std::fs::write(dir.path().join("a.org_archive"), "* old\nneedle archived\n").unwrap();
    std::fs::write(&extra, "* three\nneedle extra\n").unwrap();
    let path = |p: &std::path::Path| Value::Str(p.to_str().unwrap().into());
    ed.set_variable("org-agenda-files", Value::List(vec![path(&a), path(&b)]));
    ed.set_variable("org-agenda-text-search-extra-files", Value::List(vec![Value::Str("agenda-archives".into()), path(&extra)]));
    ed.call("org-occur-in-agenda-files", vec![Arg::Str("needle".into())]).unwrap();
    let text = occur_text(&ed);
    assert!(text.contains("needle in a"), "{text}");
    assert!(text.contains("needle archived"), "{text}");
    assert!(text.contains("needle extra"), "{text}");
    assert!(!text.contains("no match"), "{text}");
}

/// / in the agenda's menu asks for the regexp and searches, as org-agenda does.
#[test]
fn slash_in_the_agenda_menu() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.org");
    std::fs::write(&a, "* one\nneedle here\n").unwrap();
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(a.to_str().unwrap().into())]));
    ed.press("M-x o r g - a g e n d a RET / n e e d l e RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(occur_text(&ed).contains("needle here"));
}
