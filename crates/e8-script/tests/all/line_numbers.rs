//! Line numbers beside the text, which the oracle cannot see: what each
//! row's number says, how wide they are, and how they narrow the text.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.set_window_size(ed.selected_window(), 20, 6);
    (ed, scripting)
}

fn labels(ed: &mut Editor) -> Vec<String> {
    // As a front end does before drawing, which scrolls to point.
    ed.redisplay();
    let rows = ed.rows_of_window(ed.selected_window(), 6, true);
    ed.line_numbers(ed.selected_window(), &rows).map(|n| n.labels.into_iter().map(|(l, _)| l).collect()).unwrap_or_default()
}

#[test]
fn each_line_shows_its_number() {
    let (mut ed, _s) = setup("one\ntwo\nthree");
    assert!(labels(&mut ed).is_empty(), "off by default");
    ed.call("display-line-numbers-mode", vec![]).unwrap();
    // As many digits as the window's last line could need, a space either side.
    assert_eq!(labels(&mut ed)[..3], [" 1 ", " 2 ", " 3 "]);
    let rows = ed.rows_of_window(ed.selected_window(), 6, true);
    let numbers = ed.line_numbers(ed.selected_window(), &rows).unwrap();
    assert_eq!(numbers.width, 3);
    assert_eq!(numbers.labels.iter().map(|(_, current)| *current).collect::<Vec<_>>()[..3], [false, false, true]);
}

#[test]
fn relative_numbers_count_from_points_line() {
    let (mut ed, _s) = setup("a\nb\nc\nd");
    ed.set_variable("display-line-numbers-type", Value::Str("relative".into()));
    ed.call("display-line-numbers-mode", vec![]).unwrap();
    ed.press("M-< C-n").unwrap();
    assert_eq!(labels(&mut ed)[..4], [" 1 ", " 2 ", " 1 ", " 2 "]);
}

#[test]
fn continued_rows_have_no_number_and_the_text_narrows() {
    let (mut ed, _s) = setup("short\nthis line is long enough to continue");
    ed.call("display-line-numbers-mode", vec![]).unwrap();
    let rows = ed.rows_of_window(ed.selected_window(), 6, true);
    // 20 columns, 3 for numbers and 1 for the continuation mark.
    assert_eq!(rows[1].end - rows[1].start, 16);
    assert_eq!(labels(&mut ed)[..3], [" 1 ", " 2 ", "   "]);
}

#[test]
fn numbers_widen_for_longer_files_and_count_from_the_narrowing() {
    let text: String = (1..=120).map(|i| format!("line {i}\n")).collect();
    let (mut ed, _s) = setup(&text);
    ed.call("display-line-numbers-mode", vec![]).unwrap();
    // Enabled, as novice.el disables it for new users.
    ed.put("narrow-to-region", "disabled", e8_core::Value::Null);
    ed.press("M-<").unwrap();
    assert_eq!(labels(&mut ed)[0], " 1 ");
    ed.press("M->").unwrap();
    assert_eq!(labels(&mut ed).last().map(String::as_str), Some(" 121 "));
    ed.press("M-< C-n C-n C-SPC C-n C-n C-x n n").unwrap();
    assert_eq!(labels(&mut ed)[..2], [" 1 ", " 2 "]);
}

#[test]
fn the_global_mode_numbers_every_buffer_but_the_minibuffer() {
    let (mut ed, _s) = setup("x");
    ed.call("global-display-line-numbers-mode", vec![]).unwrap();
    assert_eq!(labels(&mut ed)[0], " 1 ");
    ed.press("C-x b").unwrap();
    ed.type_text("other\n");
    ed.call("text-mode", vec![]).unwrap();
    assert_eq!(ed.variable("display-line-numbers"), Some(Value::Bool(true)));
    ed.call_with_prefix("global-display-line-numbers-mode", vec![], Some(e8_core::PrefixArg::Number(-1))).unwrap();
    assert!(labels(&mut ed).is_empty());
}
