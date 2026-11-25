//! Point moved out of invisible text after a command, as Emacs's command
//! loop does: a command M-x runs is compared with where M-x started, and
//! that start belongs to its own level of the command loop, so neither a
//! loop nested inside the command nor a later command takes it.

use e8_core::{Command, Editor, Value};

/// "abcdefghij" with 3..6 hidden and point at `point`.
fn editor(point: usize) -> Editor {
    let mut ed = Editor::new();
    ed.type_text("abcdefghij");
    ed.window_buffer_mut().put_text_property(3..6, "invisible", Value::Bool(true));
    ed.window_buffer_mut().set_point(point);
    ed
}

#[test]
fn a_key_moving_into_hidden_text_goes_past_it() {
    let mut ed = editor(3);
    ed.press("C-f").unwrap();
    // From the hidden stretch's edge, past its far edge and one more, as Emacs.
    assert_eq!(ed.window_buffer().point(), 7);
}

#[test]
fn a_command_in_a_recursive_edit_is_compared_with_its_own_start() {
    let mut ed = editor(0);
    ed.define_command(Command::new("test-move-then-recurse", "Go to 3 and edit recursively.", |ed, _| {
        ed.window_buffer_mut().set_point(3);
        ed.recursive_edit()
    }));
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let log = seen.clone();
    let mut step = 0;
    ed.set_input_source(move |ed| {
        step += 1;
        match step {
            1 => {
                ed.press("C-f").unwrap();
                log.borrow_mut().push(ed.window_buffer().point());
                true
            }
            2 => {
                ed.press("C-M-c").unwrap();
                true
            }
            _ => false,
        }
    });
    ed.press("M-x").unwrap();
    ed.type_text("test-move-then-recurse");
    ed.press("RET").unwrap();
    // The C-f inside is compared with 3, where it started, not with 0, where M-x did.
    assert_eq!(*seen.borrow(), vec![7]);
}

#[test]
fn a_pending_call_run_outside_the_command_loop_leaves_no_start_behind() {
    let mut ed = editor(0);
    ed.press("M-x").unwrap();
    ed.type_text("forward-char");
    // As an agent's tool call might finish the prompt.
    ed.call("exit-minibuffer", Vec::new()).unwrap();
    ed.window_buffer_mut().set_point(3);
    ed.press("C-f").unwrap();
    assert_eq!(ed.window_buffer().point(), 7, "the next key is compared with its own start");
}
