//! Org's cycle hooks: org-pre-cycle-hook as the old name of
//! org-cycle-pre-hook, and org-cycle-hook's functions, which it holds by
//! name, taken off and put back by name, as Lisp's remove-hook and
//! add-hook do with a symbol.

use e8_core::Editor;
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap().trim_matches('"').to_string()
}

/// A function on org-pre-cycle-hook runs before TAB changes what shows, as
/// that is org-cycle-pre-hook by its old name.
#[test]
fn the_old_name_of_the_pre_cycle_hook_is_the_hook() {
    let (mut ed, s) = org("* A\n** B\ntext\n");
    eval(&mut ed, &s, "e8.defineVariable({ name: 'e8-test-states', value: '' })");
    eval(&mut ed, &s, "e8.addHook('org-pre-cycle-hook', (state) => e8.setVariable('e8-test-states', e8.variable('e8-test-states') + ' ' + state))");
    ed.press("TAB TAB").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(eval(&mut ed, &s, "e8.variable('e8-test-states')"), " folded children");
    // And what is on it shows under either name.
    assert_eq!(eval(&mut ed, &s, "e8.variable('org-pre-cycle-hook').length"), "1");
    assert_eq!(eval(&mut ed, &s, "e8.variable('org-cycle-pre-hook').length"), "1");
    eval(&mut ed, &s, "e8.setVariable('e8-test-states', '')");
    // A buffer's own, through the old name too.
    eval(&mut ed, &s, "e8.removeHook('org-cycle-pre-hook', e8.variable('org-cycle-pre-hook')[0])");
    ed.press("TAB").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.variable('e8-test-states')"), "");
}

/// org-cycle-hook's functions come off by name and go back by name once.
#[test]
fn org_cycle_hook_functions_come_off_by_name() {
    let (mut ed, s) = org("* A\n\n** B\n\ntext\n");
    assert_eq!(eval(&mut ed, &s, "e8.variable('org-cycle-hook').length"), "4");
    eval(&mut ed, &s, "e8.removeHook('org-cycle-hook', 'org-cycle-show-empty-lines')");
    assert_eq!(eval(&mut ed, &s, "e8.variable('org-cycle-hook').length"), "3");
    // Put back once, however often it is added.
    eval(&mut ed, &s, "e8.addHook('org-cycle-hook', 'org-cycle-show-empty-lines')");
    eval(&mut ed, &s, "e8.addHook('org-cycle-hook', 'org-cycle-show-empty-lines')");
    assert_eq!(eval(&mut ed, &s, "e8.variable('org-cycle-hook').length"), "4");
    // A function a script names runs by its name, so defining it later is what runs.
    eval(&mut ed, &s, "e8.defineVariable({ name: 'e8-test-ran', value: false })");
    eval(&mut ed, &s, "e8.addHook('org-cycle-hook', 'e8-test-later')");
    eval(&mut ed, &s, "e8.defun('e8-test-later', () => e8.setVariable('e8-test-ran', true))");
    ed.press("TAB").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('e8-test-ran'))"), "true");
}

/// TAB at the buffer's start with org-cycle-global-at-bob cycles the whole
/// buffer without the window's optimizing, as Org binds the hook without
/// it, and the hook is as it was afterwards.
#[test]
fn global_cycling_at_the_start_leaves_out_the_window_optimizing() {
    let (mut ed, s) = org("text\n* A\n** B\n");
    eval(&mut ed, &s, "e8.defineVariable({ name: 'e8-test-optimized', value: 0 })");
    eval(&mut ed, &s, "e8.defun('org-cycle-optimize-window-after-visibility-change', () => e8.setVariable('e8-test-optimized', e8.variable('e8-test-optimized') + 1))");
    eval(&mut ed, &s, "e8.setVariable('org-cycle-global-at-bob', true)");
    ed.window_buffer_mut().set_point(0);
    ed.press("TAB").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('e8-test-optimized'))"), "0");
    assert_eq!(eval(&mut ed, &s, "e8.variable('org-cycle-hook').length"), "4");
    // On a heading it runs.
    ed.press("C-n TAB").unwrap();
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('e8-test-optimized'))"), "1");
}
