//! Bookmarks: set in a file, found again after the text before them changed,
//! and saved in Emacs's own format, which a new editor reads back.

use crate::driven::Driven;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup(dir: &std::path::Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let file = dir.join("bookmarks");
    s.eval_typescript(&mut ed, "t.ts", format!("e8.setDefault('bookmark-default-file', {:?});", file.display().to_string())).unwrap();
    (ed, s)
}

#[test]
fn a_bookmark_finds_its_place_after_edits_and_is_saved_as_emacs_saves_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "first line here\nthe bookmarked place is here\nlast line\n").unwrap();
    // C-x r m asks for the name partway through, so on the editor's own thread.
    let file = dir.path().join("bookmarks");
    let d = Driven::new(&format!("e8.setDefault('bookmark-default-file', {:?});", file.display().to_string()));
    let visit = path.display().to_string();
    d.with(move |ed| ed.call("find-file", vec![Arg::Str(visit)]).unwrap());
    d.press("C-n C-f C-f C-f C-f");
    d.press("C-x r m");
    d.press("RET");
    let saved = std::fs::read_to_string(&file).unwrap();
    assert!(saved.starts_with(";;;; Emacs Bookmark Format Version 1"), "{saved}");
    assert!(saved.contains("(\"notes.txt\"\n (filename . "), "{saved}");
    assert!(saved.contains("(front-context-string . \"bookmarked place\")"), "{saved}");
    assert!(saved.contains("(position . 21)"), "{saved}");
    // Text inserted before it, and it is still found.
    d.press("M-<");
    d.type_text("new text\n");
    d.press("M->");
    d.press("C-x r b RET");
    assert_eq!(d.with(|ed| { let b = ed.window_buffer(); b.slice(b.point()..b.point() + 10) }), "bookmarked");
    // A new editor reads them back.
    let (mut ed2, s2) = setup(dir.path());
    let names = s2.eval_expression(&mut ed2, "JSON.stringify(e8.call('bookmark-bmenu-list') ?? e8.bufferText(0, e8.bufferSize()))").unwrap();
    assert!(names.contains("notes.txt"), "{names}");
}

/// Deleting a bookmark twice, the second time taking the buffer's former
/// bookmark as the default, deletes no other: Emacs's delq of nil deletes
/// nothing, and bookmark-delete forgets the buffer's current bookmark.
#[test]
fn deleting_a_bookmark_that_is_gone_deletes_no_other() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "some text\n").unwrap();
    let file = dir.path().join("bookmarks");
    let d = Driven::new(&format!("e8.setDefault('bookmark-default-file', {:?});", file.display().to_string()));
    let visit = path.display().to_string();
    d.with(move |ed| ed.call("find-file", vec![Arg::Str(visit)]).unwrap());
    d.press("C-x r m");
    d.type_text("old");
    d.press("RET C-e C-x r m");
    d.type_text("foo");
    d.press("RET");
    d.press("M-x");
    d.type_text("bookmark-delete");
    d.press("RET RET");
    d.press("M-x");
    d.type_text("bookmark-delete");
    d.press("RET RET");
    let saved = std::fs::read_to_string(&file).unwrap();
    assert!(saved.contains("(\"old\"") && !saved.contains("(\"foo\""), "{saved}");
}
