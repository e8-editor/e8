//! Marking an entry done as it is archived to another file, which the
//! Emacs oracle cannot compare, the archived entry naming a temporary
//! directory, and which reads org-archive-mark-done in the archive's
//! buffer, where a case's variables are not.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

/// Archives the entry at the start of SOURCE into an archive holding
/// ARCHIVE, with org-archive-mark-done set to MARK, and gives the archive's
/// first heading after its own text.
fn archived(source: &str, archive: &str, mark: Value) -> String {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, source).unwrap();
    std::fs::write(dir.path().join("t.org_archive"), archive).unwrap();
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-21".into()));
    ed.set_default("org-archive-mark-done", mark);
    ed.press("M-> C-p C-c C-x C-s").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let b = ed.buffers().iter().find(|b| b.name == "t.org_archive").expect("the archive is visited");
    let text = b.slice(0..b.len());
    text[archive.len()..].lines().find(|l| l.starts_with('*')).unwrap_or_default().to_string()
}

/// The entry is marked done with this file's states, which the archive need
/// not know, as Org binds them while it marks the entry there.
#[test]
fn done_with_the_source_files_states() {
    assert_eq!(archived("#+TODO: OPEN | CLOSED\n* OPEN Task\n", "* Earlier\n", Value::Bool(true)), "* CLOSED Task");
}

/// A TODO the archive's own states do not have is still read as one.
#[test]
fn not_with_the_archives_states() {
    assert_eq!(archived("* TODO Task\n", "#+TODO: A | B\n", Value::Bool(true)), "* DONE Task");
}

/// A state named in org-archive-mark-done is used when it is one of this file's done states.
#[test]
fn a_named_done_state() {
    assert_eq!(archived("#+TODO: OPEN | CLOSED GONE\n* OPEN Task\n", "* Earlier\n", Value::Str("GONE".into())), "* GONE Task");
}

/// Off, the entry keeps its state.
#[test]
fn not_marked_when_off() {
    assert_eq!(archived("* TODO Task\n", "* Earlier\n", Value::Bool(false)), "* TODO Task");
}

/// The headings of the archive after archiving the last heading of SOURCE
/// into another file holding ARCHIVE, as Emacs 30.2 left them.
fn archive_headings(source: &str, archive: &str) -> Vec<String> {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.org");
    std::fs::write(&file, source).unwrap();
    std::fs::write(dir.path().join("a.org_archive"), archive).unwrap();
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-04".into()));
    ed.press("M-> C-p C-c C-x C-s").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let b = ed.buffers().iter().find(|b| b.name == "a.org_archive").expect("the archive is visited");
    b.slice(0..b.len()).lines().filter(|l| l.starts_with('*')).map(str::to_string).collect()
}

/// The level a tree goes at follows the archive's org-odd-levels-only, as
/// Org's binding of the source's own value does not reach the archive.
#[test]
fn the_archives_odd_levels_place_the_tree() {
    assert_eq!(archive_headings("#+ARCHIVE: %s_archive::* Archive\n#+STARTUP: odd\n* A\n*** B\n", "* Archive\n"), ["* Archive", "** B"]);
    assert_eq!(archive_headings("#+ARCHIVE: %s_archive::* Archive\n* A\n** B\n", "#+STARTUP: odd\n* Archive\n"), ["* Archive", "*** B"]);
}

/// A date tree's levels are the archive's, and the heading it is found by
/// is counted with the source's, as Org reads each in its own buffer.
#[test]
fn a_date_tree_in_another_file_with_odd_levels() {
    assert_eq!(
        archive_headings("#+ARCHIVE: %s_archive::datetree/\n#+STARTUP: odd\n* A\n", ""),
        ["* 2026", "** 2026-11 November", "*** 2026-11-04 Wednesday", "****** A"]
    );
    assert_eq!(
        archive_headings("#+ARCHIVE: %s_archive::datetree/\n* A\n", "#+STARTUP: odd\n"),
        ["* 2026", "*** 2026-11 November", "***** 2026-11-04 Wednesday", "***** A"]
    );
}
