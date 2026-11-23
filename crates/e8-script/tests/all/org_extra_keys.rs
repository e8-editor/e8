//! Org's keys for terminals, which the Emacs oracle records as batch Emacs
//! has no graphical display: in a window they are bound only with
//! org-use-extra-keys, and E8 binds them when it is set after Org loads.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn binding(ed: &mut Editor, s: &Scripting, key: &str) -> String {
    s.eval_expression(ed, &format!("String(e8.lookupKey('org-mode-map', '{key}'))")).unwrap().trim_matches('"').to_string()
}

#[test]
fn in_a_window_the_keys_wait_for_org_use_extra_keys() {
    let mut ed = Editor::new();
    ed.set_in_a_window();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(binding(&mut ed, &s, "C-c C-x l"), "undefined");
    assert_eq!(binding(&mut ed, &s, "C-c <up>"), "undefined");
    // S-RET copies down whatever the display.
    assert_eq!(binding(&mut ed, &s, "S-RET"), "org-table-copy-down");
    ed.set_default("org-use-extra-keys", Value::Bool(true));
    assert_eq!(binding(&mut ed, &s, "C-c C-x l"), "org-metaleft");
    assert_eq!(binding(&mut ed, &s, "C-c <up>"), "org-shiftup");
    // C-c C-x d stays the drawer, as Org binds it again after these.
    assert_eq!(binding(&mut ed, &s, "C-c C-x d"), "org-insert-drawer");
}

#[test]
fn on_a_terminal_the_keys_are_bound() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(binding(&mut ed, &s, "C-c C-x l"), "org-metaleft");
    assert_eq!(binding(&mut ed, &s, "C-c C-x <right>"), "org-shiftcontrolright");
}
