//! C-c [ and C-c ] with org-agenda-files naming a file that holds the
//! list, one file a line, which they write back, entries as they were
//! written, as Org's org-store-new-agenda-file-list does. The results are
//! Emacs 30.2's on the same files.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

#[test]
fn the_list_in_a_file_is_read_and_written_back() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
    for name in ["a.org", "b.org", "c.org"] {
        std::fs::write(path(name), "* X\n").unwrap();
    }
    std::fs::write(path("agenda-list"), "a.org\n  b.org  \n\n").unwrap();
    ed.set_variable("org-directory", Value::Str(path("")));
    ed.set_variable("org-agenda-files", Value::Str(path("agenda-list")));
    let list = || {
        let text = std::fs::read_to_string(path("agenda-list")).unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        text.replace(&format!("{}/", real.display()), "DIR/").replace(&format!("{}/", dir.path().display()), "DIR/")
    };
    ed.call("find-file", vec![Arg::Str(path("b.org"))]).unwrap();
    ed.press("C-c [").unwrap();
    assert_eq!(ed.messages().last().unwrap(), "File moved to front of agenda file list");
    assert_eq!(list(), "b.org\na.org\n");
    ed.call("find-file", vec![Arg::Str(path("c.org"))]).unwrap();
    ed.press("C-u C-c [").unwrap();
    assert_eq!(ed.messages().last().unwrap(), "File added to end of agenda file list");
    assert_eq!(list(), "b.org\na.org\nDIR/c.org\n");
    ed.call("find-file", vec![Arg::Str(path("a.org"))]).unwrap();
    ed.press("C-c ]").unwrap();
    assert_eq!(list(), "b.org\nDIR/c.org\n");
    // The variable still names the file.
    assert_eq!(ed.variable("org-agenda-files"), Some(Value::Str(path("agenda-list"))));
}

/// A list in the variable is set there, for the session, as E8 has no Customize to save it with.
#[test]
fn a_list_in_the_variable_is_set_there() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.org").to_str().unwrap().to_string();
    std::fs::write(&file, "* A\n").unwrap();
    ed.call("find-file", vec![Arg::Str(file.clone())]).unwrap();
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.clone())]));
    ed.press("C-c ]").unwrap();
    assert_eq!(ed.variable("org-agenda-files"), Some(Value::List(vec![])));
    ed.press("C-c [").unwrap();
    assert_eq!(ed.variable("org-agenda-files").map(|v| matches!(v, Value::List(l) if l.len() == 1)), Some(true));
}
