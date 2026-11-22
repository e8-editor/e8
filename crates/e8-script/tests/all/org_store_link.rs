//! org-store-link and org-insert-link between files, from Dired, the
//! agenda and other buffers, which the Emacs oracle, comparing one buffer
//! that seems to visit a file, does not record.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn editor() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn visit(ed: &mut Editor, file: &std::path::Path) {
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn store(ed: &mut Editor) {
    ed.press("M-x o r g - s t o r e - l i n k RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
}

/// A link to a heading in another Org file in the same directory is written
/// relative to it, with the heading as its search and description.
#[test]
fn a_heading_in_another_file() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.org"), "* One\n* Two [1/2]\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    visit(&mut ed, &dir.path().join("a.org"));
    ed.press("C-n").unwrap();
    store(&mut ed);
    assert_eq!(ed.echo(), Some("Stored: Two"));
    visit(&mut ed, &dir.path().join("b.org"));
    ed.press("C-c C-l RET RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "[[file:a.org::*Two][Two]]");
    // Inserted, it is no longer stored.
    ed.press("C-c M-l").unwrap();
    assert_eq!(ed.echo(), Some("No link to insert"));
}

/// A link to a file outside the current directory is absolute, and with
/// org-link-file-path-type relative, relative; below it, relative.
#[test]
fn file_path_types() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("sub/a.org"), "* One\n").unwrap();
    std::fs::write(dir.path().join("top.txt"), "").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    std::fs::write(dir.path().join("sub/c.org"), "").unwrap();
    visit(&mut ed, &dir.path().join("sub/a.org"));
    store(&mut ed);
    store_and_insert_in(&mut ed, &dir.path().join("b.org"));
    assert_eq!(text(&ed), "[[file:sub/a.org::*One][One]]");

    visit(&mut ed, &dir.path().join("top.txt"));
    store(&mut ed);
    store_and_insert_in(&mut ed, &dir.path().join("sub/c.org"));
    let t = text(&ed);
    assert_eq!(t, format!("[[file:{}]]", dir.path().join("top.txt").to_str().unwrap()));

    ed.set_variable("org-link-file-path-type", Value::Str("relative".into()));
    ed.press("C-a C-k").unwrap();
    visit(&mut ed, &dir.path().join("top.txt"));
    store(&mut ed);
    store_and_insert_in(&mut ed, &dir.path().join("sub/c.org"));
    assert_eq!(text(&ed), "[[file:../top.txt]]");
}

fn store_and_insert_in(ed: &mut Editor, file: &std::path::Path) {
    visit(ed, file);
    ed.press("C-c C-l RET RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
}

/// Another file's link searches for its line, with no description.
#[test]
fn a_line_in_a_text_file() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("t.txt"), "first\n  the   second line\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    visit(&mut ed, &dir.path().join("t.txt"));
    ed.press("C-n").unwrap();
    store(&mut ed);
    let echo = ed.echo().unwrap_or_default().to_string();
    assert!(echo.starts_with("Stored: file:") && echo.ends_with("t.txt::the second line"), "{echo}");
    store_and_insert_in(&mut ed, &dir.path().join("b.org"));
    assert_eq!(text(&ed), "[[file:t.txt::the second line]]");
}

/// In Dired, the link is to the file on the line.
#[test]
fn a_file_in_dired() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "x\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    ed.call("dired", vec![Arg::Str(dir.path().to_str().unwrap().into())]).unwrap();
    ed.call("dired-goto-file", vec![Arg::Str(dir.path().join("notes.txt").to_str().unwrap().into())]).unwrap();
    store(&mut ed);
    store_and_insert_in(&mut ed, &dir.path().join("b.org"));
    assert_eq!(text(&ed), "[[file:notes.txt]]");
}

/// In the agenda, the link is to the line's entry.
#[test]
fn an_entry_in_the_agenda() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.org");
    std::fs::write(&a, "* TODO Write it\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(a.to_str().unwrap().into())]));
    ed.press("M-x o r g - a g e n d a RET t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    ed.press("M-< C-s W r i t e RET").unwrap();
    store(&mut ed);
    assert_eq!(ed.echo(), Some("Stored: Write it"));
    store_and_insert_in(&mut ed, &dir.path().join("b.org"));
    assert_eq!(text(&ed), "[[file:a.org::*Write it][Write it]]");
}

/// A buffer with no file has nothing to link to.
#[test]
fn no_method_without_a_file() {
    let (mut ed, _s) = editor();
    store_err(&mut ed);
}

fn store_err(ed: &mut Editor) {
    ed.press("M-x o r g - s t o r e - l i n k RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("No method for storing a link from this buffer".into()));
}

/// With org-id-link-to-org-use-id t, the entry is given an ID and linked
/// by it; following the link with a search goes there in the entry.
#[test]
fn an_entry_by_its_id() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    ed.set_variable("org-id-locations-file", Value::Str(dir.path().join("ids").to_str().unwrap().into()));
    std::fs::write(dir.path().join("a.org"), "* One\n* Two\n** Child\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    ed.set_variable("org-id-link-to-org-use-id", Value::Bool(true));
    visit(&mut ed, &dir.path().join("a.org"));
    ed.press("C-n").unwrap();
    store(&mut ed);
    let a = text(&ed);
    assert!(a.contains("* Two\n:PROPERTIES:\n:ID:       "), "{a}");
    store_and_insert_in(&mut ed, &dir.path().join("b.org"));
    let b = text(&ed);
    assert!(b.starts_with("[[id:") && b.ends_with("][Two]]"), "{b}");
    // An id: link with a search after :: goes to it in the entry.
    let id = b.trim_start_matches("[[id:").split(']').next().unwrap().to_string();
    ed.press("C-a C-k").unwrap();
    ed.call("org-insert-link", vec![Arg::Str(format!("id:{id}::*Child")), Arg::Str("x".into())]).unwrap();
    ed.press("C-a C-c C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.window_buffer().name, "a.org");
    let b = ed.window_buffer();
    assert_eq!(b.slice(b.point()..b.len()), "** Child\n");
}

/// C-u C-c C-l completes a file's name, written relative to the directory.
#[test]
fn a_file_completed() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    std::fs::write(dir.path().join("other.txt"), "").unwrap();
    visit(&mut ed, &dir.path().join("b.org"));
    ed.press("C-u C-c C-l o t h e r . t x t RET RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "[[file:other.txt]]");
}

/// C-u C-u C-u with a region stores a link to each of its lines.
#[test]
fn each_line_of_a_region() {
    let (mut ed, s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("t.txt"), "one\ntwo\nthree\n").unwrap();
    visit(&mut ed, &dir.path().join("t.txt"));
    ed.press("C-SPC C-n C-n C-e C-u C-u C-u M-x o r g - s t o r e - l i n k RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    s.eval_typescript(&mut ed, "t.ts", r#"e8.message(JSON.stringify(e8.variable("org-stored-links")));"#.to_string()).unwrap();
    // Each line whose end is before the region's, as Org's loop goes: not
    // the last line, the region ending at its end.
    let stored = ed.echo().unwrap_or_default().to_string();
    let path = dir.path().join("t.txt");
    let p = path.to_str().unwrap();
    assert_eq!(stored, format!(r#"[["file:{p}::two",null],["file:{p}::one",null]]"#));
}

/// C-u turns org-link-context-for-files round: a link to the file alone.
#[test]
fn prefix_turns_the_context_round() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.org"), "* One\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    visit(&mut ed, &dir.path().join("a.org"));
    ed.press("C-u M-x o r g - s t o r e - l i n k RET").unwrap();
    store_and_insert_in(&mut ed, &dir.path().join("b.org"));
    assert_eq!(text(&ed), "[[file:a.org]]");
}

/// Editing a link at point keeps backslashes that escape nothing, and an
/// empty region does not stand in for the stored link's description.
#[test]
fn editing_and_empty_regions() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.org"), "* One\n[[a\\\\b][old]]\n").unwrap();
    visit(&mut ed, &dir.path().join("a.org"));
    ed.press("C-n C-f C-f C-f C-c C-l RET RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "* One\n[[a\\\\b][old]]\n");

    ed.press("M-< M-x o r g - s t o r e - l i n k RET M-> C-SPC C-c C-l RET RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).ends_with("[[*One][One]]"), "{}", text(&ed));
}

/// An id: link's search is looked for in the entry's subtree, as
/// org-id-open narrows to it, not elsewhere in the file.
#[test]
fn an_id_search_stays_in_the_subtree() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    ed.set_variable("org-id-locations-file", Value::Str(dir.path().join("ids").to_str().unwrap().into()));
    let a = dir.path().join("a.org");
    std::fs::write(&a, "* A\n** Sub\n* B\n:PROPERTIES:\n:ID: b1\n:END:\n** Sub\n").unwrap();
    std::fs::write(dir.path().join("b.org"), "").unwrap();
    visit(&mut ed, &a);
    ed.call("org-id-update-id-locations", vec![]).unwrap();
    visit(&mut ed, &dir.path().join("b.org"));
    ed.call("org-insert-link", vec![Arg::Str("id:b1::*Sub".into()), Arg::Str("x".into())]).unwrap();
    ed.press("C-a C-c C-o").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.window_buffer().name, "a.org");
    let b = ed.window_buffer();
    assert_eq!(b.slice(b.point()..b.len()), "** Sub\n");
}

/// create-if-interactive gives the entry an ID for org-store-link typed,
/// but not called from code, as capture's %a calls it.
#[test]
fn ids_made_only_when_asked() {
    let (mut ed, s) = editor();
    let dir = tempfile::tempdir().unwrap();
    ed.set_variable("org-id-locations-file", Value::Str(dir.path().join("ids").to_str().unwrap().into()));
    std::fs::write(dir.path().join("a.org"), "* One\n").unwrap();
    visit(&mut ed, &dir.path().join("a.org"));
    s.eval_typescript(&mut ed, "t.ts", r#"e8.setVariable("org-id-link-to-org-use-id", e8.intern("create-if-interactive"));"#.to_string()).unwrap();
    // From code, as capture asks for %a: not interactively.
    s.eval_typescript(&mut ed, "t.ts", r#"e8.call("org-store-link", null);"#.to_string()).unwrap();
    assert!(!text(&ed).contains(":ID:"), "{}", text(&ed));
    store(&mut ed);
    assert!(text(&ed).contains(":ID:"), "{}", text(&ed));
}
