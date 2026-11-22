//! The inherited tags C-c C-q shows, which the Emacs oracle does not
//! compare: org-tags-exclude-from-inheritance leaves its tags out, as
//! org-get-tags's org-remove-uninherited-tags does.

use std::cell::RefCell;
use std::rc::Rc;

use e8_core::{Editor, Key, Value};
use e8_script::Scripting;

#[test]
fn excluded_tags_are_not_shown_as_inherited() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("org-tags-exclude-from-inheritance", Value::List(vec![Value::Str("secret".into())]));
    ed.window_buffer_mut().set_text("#+TAGS: work(w)\n* P :secret:shared:\n** C\n");
    ed.call("org-mode", vec![]).unwrap();
    let seen = Rc::new(RefCell::new(String::new()));
    let noted = seen.clone();
    let mut done = false;
    ed.set_input_source(move |ed| {
        if done {
            return false;
        }
        done = true;
        if let Some(b) = ed.buffers().iter().find(|b| b.name == " *Org tags*") {
            *noted.borrow_mut() = b.slice(0..b.len());
        }
        ed.handle_key(Key::parse("RET").unwrap());
        true
    });
    ed.press("M-> C-p C-c C-q").unwrap();
    let text = seen.borrow().clone();
    let inherited = text.lines().find(|l| l.starts_with("Inherited:")).unwrap_or_default().to_string();
    assert!(inherited.contains("shared"), "{text}");
    assert!(!inherited.contains("secret"), "{text}");
}
