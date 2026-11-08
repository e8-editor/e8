//! The file system in memory that the web build uses (e8-core's vfs.rs),
//! natively: visiting, saving and Dired on files that are only in memory.
//! Run with `cargo nextest run -p e8-script --features memory-fs memory_fs`;
//! the tree is one for the whole process, so each test keeps to a
//! directory of its own.

#![cfg(feature = "memory-fs")]

use e8_core::vfs;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup(dir: &str, files: &[(&str, &str)]) -> (Editor, Scripting) {
    vfs::restore(files.iter().map(|(name, text)| (format!("{dir}/{name}"), text.as_bytes().to_vec())));
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn a_file_in_memory_is_visited_edited_and_saved() {
    let (mut ed, _scripting) = setup("/home/e8/visit", &[("notes.org", "* One\n")]);
    ed.call("find-file", vec![Arg::Str("/home/e8/visit/notes.org".into())]).unwrap();
    assert_eq!(text(&ed), "* One\n");
    ed.press("M->").unwrap();
    ed.type_text("* Two\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(vfs::read_to_string("/home/e8/visit/notes.org").unwrap(), "* One\n* Two\n");
}

#[test]
fn a_new_file_is_made_when_saved() {
    let (mut ed, _scripting) = setup("/home/e8/new", &[("keep", "")]);
    ed.call("find-file", vec![Arg::Str("/home/e8/new/fresh.txt".into())]).unwrap();
    ed.type_text("hello");
    ed.press("C-x C-s").unwrap();
    // require-final-newline, as in Emacs's text-mode.
    assert_eq!(vfs::read_to_string("/home/e8/new/fresh.txt").unwrap(), "hello\n");
}

#[test]
fn dired_lists_a_directory_in_memory() {
    let (mut ed, _scripting) = setup("/home/e8/listed", &[("a.txt", "one\n"), ("sub/b.org", "* b\n")]);
    ed.call("dired", vec![Arg::Str("/home/e8/listed/".into())]).unwrap();
    let listing = text(&ed);
    assert!(listing.lines().any(|l| l.ends_with(" a.txt")), "{listing}");
    assert!(listing.lines().any(|l| l.ends_with(" sub")), "{listing}");
}

#[test]
fn files_are_renamed_and_deleted_in_memory() {
    let (mut ed, _scripting) = setup("/home/e8/moved", &[("a.txt", "one\n"), ("sub/b.org", "* b\n")]);
    ed.call("rename-file", vec![Arg::Str("/home/e8/moved/sub".into()), Arg::Str("/home/e8/moved/dir".into())]).unwrap();
    assert_eq!(vfs::read_to_string("/home/e8/moved/dir/b.org").unwrap(), "* b\n");
    assert!(!vfs::path_exists("/home/e8/moved/sub"));
    ed.call("delete-file", vec![Arg::Str("/home/e8/moved/a.txt".into())]).unwrap();
    assert!(!vfs::path_exists("/home/e8/moved/a.txt"));
}
