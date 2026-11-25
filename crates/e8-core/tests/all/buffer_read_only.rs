//! `buffer-read-only` as the variable Emacs has, kept by the buffer itself:
//! setting it makes the buffer read-only, reading it says whether it is,
//! every buffer has its own value, and `let` binds it and puts it back.

use e8_core::{Editor, Value};

#[test]
fn the_variable_is_the_buffer_s_read_only_state() {
    let mut ed = Editor::new();
    ed.type_text("abc");
    assert_eq!(ed.variable("buffer-read-only"), Some(Value::Bool(false)));
    ed.set_variable("buffer-read-only", Value::Bool(true));
    assert!(ed.buffer().read_only);
    assert!(ed.is_local_variable("buffer-read-only"), "every buffer has its own, as in Emacs");
    ed.press("x").unwrap();
    assert_eq!(ed.buffer().text(), "abc", "typing is refused");
    assert_eq!(ed.echo(), Some("Buffer is read-only: #<buffer *scratch*>"));
    // What the buffer's own state says is what the variable reads.
    ed.buffer_mut().read_only = false;
    assert_eq!(ed.variable("buffer-read-only"), Some(Value::Bool(false)));
    ed.type_text("d");
    assert_eq!(ed.buffer().text(), "abcd");
}

#[test]
fn let_binding_it_puts_it_back() {
    let mut ed = Editor::new();
    ed.set_variable("buffer-read-only", Value::Bool(true));
    let binding = ed.specbind("buffer-read-only", Value::Null);
    ed.type_text("x");
    assert_eq!(ed.buffer().text(), "x");
    ed.unbind(binding);
    assert!(ed.buffer().read_only, "read-only again once the binding ends");
}
