//! Setting tags over an active region: Org asks for each heading in it.

use std::cell::RefCell;
use std::rc::Rc;

use e8_core::{Editor, Key};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

/// Answers each prompt with the next of `answers` and RET, noting what it asked.
fn answering(ed: &mut Editor, answers: &[&str]) -> Rc<RefCell<Vec<String>>> {
    let asked = Rc::new(RefCell::new(Vec::new()));
    let noted = asked.clone();
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        let Some(prompt) = ed.prompt().map(str::to_string) else { return false };
        let Some(answer) = left.pop_front() else { return false };
        noted.borrow_mut().push(prompt);
        ed.type_text(&answer);
        ed.handle_key(Key::parse("RET").unwrap());
        true
    });
    asked
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// C-c C-q asks for each heading starting in the region, in turn.
#[test]
fn each_heading_in_the_region_is_asked_for() {
    let (mut ed, _s) = org("* one\n** two\ntext\n* three\n* four\n");
    let asked = answering(&mut ed, &["a", "b", "c"]);
    ed.press("C-SPC C-n C-n C-n C-n C-c C-q").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(asked.borrow().len(), 3, "{}", text(&ed));
    assert!(text(&ed).contains(":c:\n* four\n"), "{}", text(&ed));
}
