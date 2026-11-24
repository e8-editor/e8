//! Leaving the agenda: what the Emacs oracle cannot see, x killing the Org
//! buffers the agenda visited, as org-agenda-exit releases
//! org-agenda-new-buffers, and q and Q leaving them.

use e8_core::{Editor, Key, Value};
use e8_script::Scripting;

/// An agenda file not yet visited, with today fixed.
fn unvisited_agenda_file() -> (Editor, Scripting, tempfile::TempDir, std::path::PathBuf) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, "* TODO Report\nSCHEDULED: <2026-10-28 Wed>\n").unwrap();
    ed.set_window_size(ed.selected_window(), 80, 40);
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    (ed, scripting, dir, file)
}

fn has_buffer(ed: &Editor, name: &str) -> bool {
    ed.buffers().iter().any(|b| b.name == name)
}

/// q and Q leave the Org buffers the agenda visited, and kill the agenda's.
#[test]
fn q_leaves_the_visited_buffers() {
    for key in ["q", "Q"] {
        let (mut ed, _s, _dir, _file) = unvisited_agenda_file();
        ed.call("org-agenda-list", vec![]).unwrap();
        assert!(has_buffer(&ed, "tasks.org"));
        ed.press(key).unwrap();
        assert_eq!(ed.take_error().map(|e| e.to_string()), None);
        assert!(!has_buffer(&ed, "*Org Agenda*"), "{key}");
        assert!(has_buffer(&ed, "tasks.org"), "{key}");
    }
}

/// x kills the Org buffers the agenda visited, but not one that was open.
#[test]
fn x_kills_the_buffers_the_agenda_visited() {
    let (mut ed, _s, _dir, _file) = unvisited_agenda_file();
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("x").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(!has_buffer(&ed, "*Org Agenda*"));
    assert!(!has_buffer(&ed, "tasks.org"));

    let (mut ed, _s, _dir, file) = unvisited_agenda_file();
    ed.call("find-file", vec![e8_core::Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("x").unwrap();
    assert!(has_buffer(&ed, "tasks.org"));
}

/// x asks to save a visited buffer the agenda changed, and saves it on y.
#[test]
fn x_asks_to_save_what_changed() {
    let (mut ed, _s, _dir, file) = unvisited_agenda_file();
    ed.call("org-agenda-list", vec![]).unwrap();
    // DONE from the agenda, in the buffer it visited.
    ed.press("N t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let noted = asked.clone();
    ed.set_input_source(move |ed| {
        let Some(prompt) = ed.prompt().map(str::to_string) else { return false };
        noted.borrow_mut().push(prompt);
        ed.handle_key(Key::parse("y").unwrap());
        true
    });
    ed.press("x").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(asked.borrow().len(), 1);
    assert!(asked.borrow()[0].starts_with("Save file ") && asked.borrow()[0].contains("tasks.org"), "{:?}", asked.borrow());
    assert!(!has_buffer(&ed, "tasks.org"));
    assert!(std::fs::read_to_string(&file).unwrap().starts_with("* DONE Report"));
}

/// Not saved, a changed buffer is killed only if the user says so, as
/// kill-buffer asks in an interactive Emacs; either way x leaves the agenda.
#[test]
fn x_asks_before_killing_what_is_not_saved() {
    for (kill, kept) in [("yes", false), ("no", true)] {
        let (mut ed, _s, _dir, file) = unvisited_agenda_file();
        ed.call("org-agenda-list", vec![]).unwrap();
        ed.press("N t").unwrap();
        let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let noted = asked.clone();
        let mut answers: std::collections::VecDeque<&str> = ["n", kill].into();
        ed.set_input_source(move |ed| {
            let Some(prompt) = ed.prompt().map(str::to_string) else { return false };
            let Some(answer) = answers.pop_front() else { return false };
            noted.borrow_mut().push(prompt);
            if answer.len() == 1 {
                ed.handle_key(Key::parse(answer).unwrap());
            } else {
                ed.type_text(answer);
                ed.handle_key(Key::parse("RET").unwrap());
            }
            true
        });
        ed.press("x").unwrap();
        assert_eq!(ed.take_error().map(|e| e.to_string()), None, "{kill}");
        assert_eq!(asked.borrow().len(), 2, "{:?}", asked.borrow());
        assert!(asked.borrow()[1].starts_with("Buffer tasks.org modified; kill anyway? "), "{:?}", asked.borrow());
        assert_eq!(has_buffer(&ed, "tasks.org"), kept, "{kill}");
        assert!(!has_buffer(&ed, "*Org Agenda*"), "{kill}");
        assert!(std::fs::read_to_string(&file).unwrap().starts_with("* TODO Report"), "{kill}");
    }
}
