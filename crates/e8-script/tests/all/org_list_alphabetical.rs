//! Lettered bullets, org-list-allow-alphabetical, where E8 differs from Org
//! and so the Emacs oracle cannot compare: the setting takes as soon as it
//! is set, where Org's parser takes it only when loaded or brought up to
//! date with org-element-update-syntax.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str, point: usize) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    scripting.eval_expression(&mut ed, &format!("e8.insert({text:?})")).unwrap();
    ed.window_buffer_mut().set_point(point);
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.buffer();
    b.slice(0..b.len())
}

/// Set after Org has loaded, the setting takes at once.
#[test]
fn the_setting_takes_without_updating_the_syntax() {
    let (mut ed, _s) = org("a. one\nb. two\n", 6);
    ed.press("M-RET x").unwrap();
    assert_eq!(text(&ed), "a. one\n* x\nb. two\n");
    let (mut ed, _s) = org("a. one\nb. two\n", 6);
    ed.set_default("org-list-allow-alphabetical", Value::Bool(true));
    ed.press("M-RET x").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "a. one\nb. x\nc. two\n");
    // And is taken back as soon.
    ed.set_default("org-list-allow-alphabetical", Value::Null);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "a. one\nb. x\nc. two\n");
}
