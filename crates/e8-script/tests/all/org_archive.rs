//! Archiving with C-u and C-u C-u: the questions Org asks for each tree,
//! with its reason, which the Emacs oracle answers but does not compare.

use std::cell::RefCell;
use std::rc::Rc;

use e8_core::{Editor, Key, Value};
use e8_script::Scripting;

/// An Org file archiving into its own Archive heading, visited, with today fixed.
fn org(text: &str) -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, format!("#+ARCHIVE: ::* Archive\n{text}")).unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-04".into()));
    ed.set_variable("org-archive-save-context-info", Value::List(vec![]));
    (ed, scripting, dir)
}

/// Answers each question with the next of `answers`, noting what it asked.
fn answering(ed: &mut Editor, answers: &[&str]) -> Rc<RefCell<Vec<String>>> {
    let asked = Rc::new(RefCell::new(Vec::new()));
    let noted = asked.clone();
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        let Some(prompt) = ed.prompt().map(str::to_string) else { return false };
        let Some(answer) = left.pop_front() else { return false };
        noted.borrow_mut().push(prompt);
        ed.handle_key(Key::parse(&answer).unwrap());
        true
    });
    asked
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// C-u C-u asks for each tree whose first active timestamp is before
/// today, naming it, and a range by both its ends.
#[test]
fn archiving_old_trees_asks_with_the_timestamp() {
    let (mut ed, _s, _dir) = org("* A\n<2020-01-01 Wed>\n* B\n<2020-01-01 Wed>--<2020-01-05 Sun>\n* C\n<2090-01-01 Sun>\n");
    let asked = answering(&mut ed, &["y", "n", "n"]);
    ed.press("C-u C-u C-c C-x C-s").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(
        *asked.borrow(),
        [
            "Move subtree to archive? (old timestamp <2020-01-01 Wed>) (y or n) ",
            "Move subtree to archive? (old timestamp <2020-01-01 Wed>--<2020-01-05 Sun>) (y or n) ",
        ]
    );
    assert!(text(&ed).starts_with("#+ARCHIVE: ::* Archive\n* B\n"));
}

/// The children of the heading point is on, a tree's first timestamp
/// being the first anywhere in it.
#[test]
fn archiving_old_children() {
    let (mut ed, _s, _dir) = org("* P\n** A\n<2020-01-01 Wed>\n** B\n*** C\n<2020-03-03 Tue>\n** D\n");
    let asked = answering(&mut ed, &["y", "y", "n"]);
    ed.window_buffer_mut().set_point(23);
    ed.press("C-u C-u C-c C-x C-s").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None, "{:?} {}", asked.borrow(), text(&ed));
    assert_eq!(asked.borrow().len(), 2);
    assert_eq!(ed.echo(), Some("2 trees archived"));
}

/// C-u asks for each child with no open TODO, and says how many went.
#[test]
fn archiving_done_children_asks_why() {
    let (mut ed, _s, _dir) = org("* Project\n** DONE A\n** TODO B\n* Other\n");
    let asked = answering(&mut ed, &["y"]);
    ed.window_buffer_mut().set_point(23);
    ed.press("C-u C-c C-x C-s").unwrap();
    assert_eq!(*asked.borrow(), ["Move subtree to archive? (no open TODO items) (y or n) "]);
    assert_eq!(ed.echo(), Some("1 trees archived"));
}

/// C-u C-c C-x a tags them instead, passing over those already tagged.
#[test]
fn tagging_done_trees_asks_to_set_the_tag() {
    let (mut ed, _s, _dir) = org("* DONE A\n* B :ARCHIVE:\n* TODO C\n");
    let asked = answering(&mut ed, &["y"]);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-u C-c C-x a").unwrap();
    assert_eq!(*asked.borrow(), ["Set ARCHIVE tag? (no open TODO items) (y or n) "]);
    assert!(text(&ed).contains("* DONE A") && text(&ed).contains(":ARCHIVE:\n* B"), "{}", text(&ed));
}
