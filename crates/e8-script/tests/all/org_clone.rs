//! Cloning a subtree with an ID, which the Emacs oracle cannot compare, as
//! each clone gets a new random ID.

use e8_core::Editor;
use e8_script::Scripting;

#[test]
fn each_clone_gets_an_id_of_its_own() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    s.eval_expression(&mut ed, r#"e8.insert("* A\n:PROPERTIES:\n:ID: abc-123\n:END:\ntext\n")"#).unwrap();
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-x c 2 RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let b = ed.buffer();
    let text = b.slice(0..b.len());
    let ids: Vec<&str> = text.lines().filter_map(|l| l.strip_prefix(":ID: ")).collect();
    assert_eq!(ids.len(), 3, "{text}");
    assert_eq!(ids[0], "abc-123");
    assert!(ids[1] != ids[0] && ids[2] != ids[0] && ids[1] != ids[2], "{ids:?}");
    assert_eq!(text.matches("* A\n:PROPERTIES:\n:ID: ").count(), 3, "{text}");
    assert_eq!(text.matches("\n:END:\ntext\n").count(), 3, "{text}");
}
