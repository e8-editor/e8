//! TAB in Org where the Emacs oracle cannot reach: org-cycle-emulate-tab
//! set to null, as configs write nil.

use e8_core::Editor;
use e8_script::Scripting;

/// nil as null cycles the heading above from a body line, as nil does in
/// Org, rather than indenting as t would.
#[test]
fn emulate_tab_null_is_nil() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* A\n** B\nbody\n* C\n");
    ed.call("org-mode", vec![]).unwrap();
    s.eval_expression(&mut ed, "e8.setVariable('org-cycle-emulate-tab', null)").unwrap();
    ed.window_buffer_mut().set_point(11);
    ed.call("org-cycle", vec![]).unwrap();
    // B folded: its body hidden, A's heading shown.
    assert_eq!(s.eval_expression(&mut ed, "e8.invisibleAt(11)").unwrap(), "true");
    assert_eq!(s.eval_expression(&mut ed, "e8.invisibleAt(0)").unwrap(), "false");
}
