//! Tabs, as tab-bar.el keeps them: each a frame's window configuration,
//! switched with C-x t, and the tab bar that shows them.

use e8_core::{Arg, Editor, Key, KeyCode, MouseKind, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 23);
    (ed, scripting)
}

/// Each window's buffer, in cyclic order.
fn buffers(ed: &Editor) -> Vec<String> {
    ed.windows().iter().map(|w| w.buffer.name.clone()).collect()
}

/// What the selected frame's tab bar shows, as the last redisplay formatted it.
fn tab_bar(ed: &mut Editor) -> String {
    ed.redisplay();
    let frame = ed.selected_frame();
    ed.tab_bar(frame).unwrap_or(&[]).iter().map(|s| s.text.as_str()).collect()
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap()
}

fn buffer(ed: &mut Editor, name: &str) {
    ed.call("switch-to-buffer", vec![Arg::Str(name.into())]).unwrap();
}

#[test]
fn a_new_tab_keeps_the_old_tabs_windows() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x 2").unwrap();
    assert_eq!(buffers(&ed), ["one", "one"]);
    // The new tab shows the current buffer in one window, as tab-bar-new-tab-choice t says.
    ed.press("C-x t 2").unwrap();
    assert_eq!(buffers(&ed), ["one"]);
    buffer(&mut ed, "two");
    ed.press("C-x t o").unwrap();
    assert_eq!(buffers(&ed), ["one", "one"], "the first tab's windows came back");
    ed.press("C-x t o").unwrap();
    assert_eq!(buffers(&ed), ["two"]);
    // Making a tab turned the tab bar on, as tab-bar-show t does.
    assert_eq!(ed.variable("tab-bar-mode"), Some(Value::Bool(true)));
    let frame = ed.selected_frame();
    assert_eq!(ed.tab_bar_lines(frame), 1);
}

#[test]
fn the_tab_bar_shows_each_tab_one_width() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "two");
    // On a terminal, as Emacs 30 shows it: tabs 20 columns wide but one,
    // each with its close button, between bars, and the new tab button.
    assert_eq!(tab_bar(&mut ed), format!("|one{} x|two{} x| + ", " ".repeat(14), " ".repeat(14)));
    let frame = ed.selected_frame();
    let segments = ed.tab_bar(frame).unwrap().to_vec();
    let current = segments.iter().find(|s| s.text.starts_with("two")).unwrap();
    assert_eq!(current.faces, ["tab-bar-tab"]);
    let other = segments.iter().find(|s| s.text.starts_with("one")).unwrap();
    assert_eq!(other.faces, ["tab-bar-tab-inactive"]);
}

#[test]
fn a_tab_is_named_after_the_window_the_minibuffer_was_entered_from() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x t 2").unwrap();
    // A prompt open in the second tab names it still after its buffer, as
    // tab-bar-tab-name-current names it after minibuffer-selected-window's.
    ed.press("M-x").unwrap();
    assert!(tab_bar(&mut ed).starts_with(&format!("|one{} x|one{} x|", " ".repeat(14), " ".repeat(14))), "{:?}", tab_bar(&mut ed));
    ed.press("C-g").unwrap();
}

#[test]
fn long_names_are_cut_to_the_width() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "a-buffer-with-a-very-long-name");
    ed.press("C-x t 2").unwrap();
    let bar = tab_bar(&mut ed);
    // Cut to the width, as Emacs's are, the last two characters left shadowed.
    assert!(bar.starts_with("|a-buffer-with-a-ve x|"), "{bar:?}");
    let frame = ed.selected_frame();
    let shadowed: Vec<String> = ed.tab_bar(frame).unwrap().iter().filter(|s| s.faces.contains(&"shadow".to_string())).map(|s| s.text.clone()).collect();
    assert_eq!(shadowed, ["ve", "ve"]);
}

#[test]
fn closing_a_tab_selects_the_recent_one_and_undo_brings_it_back() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "two");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "three");
    ed.press("C-x t 1 C-x t o").unwrap();
    assert_eq!(buffers(&ed), ["three"], "C-x t 1 left only the current tab");
    // As Emacs's, C-x t 1 closed them left to right, so the last is "two".
    ed.press("C-x t u").unwrap();
    assert_eq!(buffers(&ed), ["two"], "the tab closed last came back, selected");
    ed.press("C-x t u").unwrap();
    assert_eq!(buffers(&ed), ["one"]);
    ed.press("C-x t 0").unwrap();
    assert_eq!(buffers(&ed), ["two"], "the most recent tab is selected");
    ed.press("C-x t 0").unwrap();
    ed.press("C-x t 0").unwrap();
    assert_eq!(ed.echo_lines(), ["Attempt to delete the sole tab in a frame"]);
}

#[test]
fn tabs_are_named_moved_and_switched_by_name() {
    let (mut ed, s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "two");
    ed.press("C-x t r").unwrap();
    ed.type_text("work");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("tab-bar--current-tab-name")"#), "\"work\"");
    buffer(&mut ed, "three");
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("tab-bar--current-tab-name")"#), "\"work\"", "a given name stays");
    ed.press("C-x t m").unwrap();
    assert!(tab_bar(&mut ed).starts_with("|work"), "the tab moved right, round to the start");
    ed.press("C-x t RET").unwrap();
    ed.type_text("one");
    ed.press("RET").unwrap();
    assert_eq!(buffers(&ed), ["one"]);
    // A name no tab has makes a tab of that name.
    ed.press("C-x t RET").unwrap();
    ed.type_text("fresh");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.funcall("tab-bar--current-tab-name")"#), "\"fresh\"");
}

#[test]
fn a_click_selects_or_closes_a_tab_or_opens_one() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "two");
    tab_bar(&mut ed);
    let frame = ed.selected_frame();
    let click = Key::new(KeyCode::Mouse(MouseKind::Click, 1));
    // "|one ... x|two ... x| + ": the first tab's name, then its close button.
    ed.tab_bar_mouse(frame, 2, click);
    assert_eq!(buffers(&ed), ["one"]);
    tab_bar(&mut ed);
    ed.tab_bar_mouse(frame, 39, click);
    assert_eq!(tab_bar(&mut ed), format!("|one{} x| + ", " ".repeat(14)), "the second tab's x closed it");
    ed.tab_bar_mouse(frame, 22, click);
    assert_eq!(tab_bar(&mut ed).matches(" x|").count(), 2, "+ opened a tab");
}

#[test]
fn tab_history_goes_back_and_forward() {
    let (mut ed, _s) = setup();
    ed.call("tab-bar-history-mode", vec![]).unwrap();
    buffer(&mut ed, "one");
    ed.press("C-x 2").unwrap();
    assert_eq!(buffers(&ed).len(), 2);
    ed.press("C-c <left>").unwrap();
    assert_eq!(buffers(&ed), ["one"]);
    ed.press("C-c <right>").unwrap();
    assert_eq!(buffers(&ed), ["one", "one"]);
}

#[test]
fn the_tab_switcher_selects_a_tab() {
    let (mut ed, _s) = setup();
    buffer(&mut ed, "one");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "two");
    ed.press("C-x t 2").unwrap();
    buffer(&mut ed, "three");
    ed.call("tab-list", vec![]).unwrap();
    // The other tabs, the switcher's own left out, most recent first:
    // three, two, one, with point on the second, as in Emacs.
    ed.press("RET").unwrap();
    assert_eq!(buffers(&ed), ["two"]);
    assert_eq!(tab_bar(&mut ed).matches(" x|").count(), 3, "the switcher's own tab went");
}

#[test]
fn the_tab_bar_takes_a_line_from_the_windows() {
    let (mut ed, _s) = setup();
    let height = ed.windows()[0].buffer.name.clone();
    let _ = height;
    let before = ed.window_total_sizes()[0].2;
    ed.press("C-x t 2").unwrap();
    // Front ends give the frame a line less once it shows a tab bar.
    let frame = ed.selected_frame();
    assert_eq!(ed.tab_bar_lines(frame), 1);
    ed.set_frame_size(80, 23 - ed.tab_bar_lines(frame));
    assert_eq!(ed.window_total_sizes()[0].2, before - 1);
}



/// C-x t f on a directory lists it in the new tab, as find-file-noselect
/// gives Dired for one, and C-x t 0 with a number past the last tab closes
/// nothing, as tab-bar-close-tab finds no tab there.
#[test]
fn find_file_other_tab_lists_directories_and_closing_no_tab_is_quiet() {
    let (mut ed, _s) = setup();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    ed.call("find-file-other-tab", vec![Arg::Str(dir.path().display().to_string())]).unwrap();
    assert_eq!(ed.variable("major-mode"), Some(Value::Str("dired-mode".into())));
    ed.press("C-u 5 C-x t 0").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
}
