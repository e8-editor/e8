//! Horizontal scrolling as Emacs has it (ADR 0071): each window keeps its
//! scroll, which redisplay changes to keep point in sight as xdisp.c's
//! hscroll_window_tree does, and `C-x <`, `C-x >` and `set-window-hscroll`
//! set. The numbers are what Emacs 30 gives in a 20 column terminal window.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TEXT: &str = "0123456789abcdefghij\n0123456789abcdefghijk\nshort\n0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n";

/// An editor showing TEXT in a 20 by 10 window with lines truncated, point
/// at the start of its long fourth line.
fn editor() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text(TEXT);
    let w = ed.selected_window();
    ed.set_window_size(w, 20, 10);
    ed.set_variable("truncate-lines", Value::Bool(true));
    ed.press("M-< C-n C-n C-n").unwrap();
    ed.redisplay();
    (ed, s)
}

/// Presses keys, then redisplays, as the command loop does before drawing.
fn press(ed: &mut Editor, keys: &str) -> usize {
    ed.press(keys).unwrap();
    ed.redisplay();
    ed.window_hscroll(ed.selected_window())
}

#[test]
fn point_near_either_edge_recentres_the_window() {
    let (mut ed, _s) = editor();
    assert_eq!(ed.window_hscroll(ed.selected_window()), 0);
    // At the end of a line, so that it ends 4 columns from the right edge.
    assert_eq!(press(&mut ed, "C-e"), 30);
    // Within hscroll-margin of the left edge, less the `$` there: point to the middle.
    assert_eq!(press(&mut ed, "C-u 1 2 C-b"), 24);
    assert_eq!(press(&mut ed, "C-b"), 24);
    assert_eq!(press(&mut ed, "C-a"), 0);
}

#[test]
fn hscroll_step_scrolls_by_columns() {
    let (mut ed, _s) = editor();
    ed.set_variable("hscroll-step", Value::Number(3.0));
    assert_eq!(press(&mut ed, "C-u 1 4 C-f"), 0);
    assert_eq!(press(&mut ed, "C-f"), 3);
    assert_eq!(press(&mut ed, "C-f"), 3);
    assert_eq!(press(&mut ed, "C-u 1 0 C-f"), 14);
    assert_eq!(press(&mut ed, "C-e"), 34);
    assert_eq!(press(&mut ed, "C-u 2 0 C-b"), 19);
    assert_eq!(press(&mut ed, "C-b"), 19);
}

#[test]
fn without_auto_hscroll_mode_point_may_leave_the_window() {
    let (mut ed, _s) = editor();
    ed.set_variable("auto-hscroll-mode", Value::Null);
    assert_eq!(press(&mut ed, "C-e"), 0);
}

#[test]
fn wrapped_lines_are_never_scrolled() {
    let (mut ed, _s) = editor();
    ed.set_variable("truncate-lines", Value::Null);
    assert_eq!(press(&mut ed, "C-e"), 0);
}

#[test]
fn scroll_left_sets_the_least_scroll_when_run_by_keys() {
    let (mut ed, _s) = editor();
    // By the window's width less two without a number.
    assert_eq!(press(&mut ed, "C-x <"), 18);
    // The scroll stays until point moves, though point is out of sight.
    assert_eq!(press(&mut ed, "C-g"), 18);
    assert_eq!(press(&mut ed, "C-x >"), 0);
    assert_eq!(press(&mut ed, "C-u 5 C-x <"), 5);
    // Keeping point in sight scrolls back no further than the keys left it.
    assert_eq!(press(&mut ed, "C-f"), 5);
    assert_eq!(press(&mut ed, "C-x > C-u 2 0 C-f C-a"), 0);
}

#[test]
fn scroll_left_from_code_does_not_set_the_least_scroll() {
    let (mut ed, _s) = editor();
    ed.call("scroll-left", vec![e8_core::Arg::Int(5)]).unwrap();
    ed.redisplay();
    assert_eq!(ed.window_hscroll(ed.selected_window()), 5);
    // Once point moves, it is back in sight from column 0.
    assert_eq!(press(&mut ed, "C-f"), 0);
}

#[test]
fn a_scrolled_window_truncates_its_lines() {
    let (mut ed, _s) = editor();
    ed.set_variable("truncate-lines", Value::Null);
    let w = ed.selected_window();
    // The long line takes three rows wrapped, one truncated.
    assert!(ed.screen_line(ed.window_buffer().point()).2);
    ed.set_window_hscroll(w, 4);
    assert!(!ed.screen_line(ed.window_buffer().point()).2);
    ed.set_window_hscroll(w, -3);
    assert_eq!(ed.window_hscroll(w), 0);
}

#[test]
fn rows_and_positions_count_the_scroll() {
    let (mut ed, _s) = editor();
    press(&mut ed, "C-e");
    let w = ed.selected_window();
    let fd = ed.describe_frame(ed.selected_frame(), 1.0);
    let window = fd.windows.iter().find(|d| d.id == w).unwrap();
    assert_eq!(window.hscroll, 30);
    assert!(window.rows.iter().all(|r| r.hscroll == 30.0));
    // Point, at column 46, shows at 16; what shows at column 2 is column 32.
    let point = ed.window_buffer().point();
    assert_eq!(ed.posn_at_point(point, w).unwrap().col, 16.0);
    let line = ed.window_buffer().line_start(3);
    assert_eq!(ed.posn_at_x_y(2.0, 3.0, w).unwrap().point, line + 32);
}

#[test]
fn current_line_mode_scrolls_only_points_line() {
    let (mut ed, _s) = editor();
    ed.set_variable("auto-hscroll-mode", Value::Str("current-line".into()));
    press(&mut ed, "C-e");
    let w = ed.selected_window();
    let fd = ed.describe_frame(ed.selected_frame(), 1.0);
    let rows: Vec<f32> = fd.windows.iter().find(|d| d.id == w).unwrap().rows.iter().take(4).map(|r| r.hscroll).collect();
    assert_eq!(rows, [0.0, 0.0, 0.0, 30.0]);
    // Moving to a short line scrolls back.
    assert_eq!(press(&mut ed, "C-p"), 0);
}

#[test]
fn window_configurations_keep_the_scroll() {
    let (mut ed, _s) = editor();
    press(&mut ed, "C-e");
    let w = ed.selected_window();
    let config = ed.current_window_configuration();
    ed.set_window_hscroll(w, 2);
    ed.set_window_configuration(config).unwrap();
    assert_eq!(ed.window_hscroll(w), 30);
}

#[test]
fn showing_another_buffer_starts_unscrolled() {
    let (mut ed, _s) = editor();
    press(&mut ed, "C-e");
    let w = ed.selected_window();
    ed.press("C-x b").unwrap();
    ed.type_text("other");
    ed.press("RET").unwrap();
    assert_eq!(ed.window_hscroll(w), 0);
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn scripts_read_and_set_the_scroll_and_window_states_keep_it() {
    let (mut ed, s) = editor();
    press(&mut ed, "C-e");
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.state = e8.funcall("window-state-get"), JSON.stringify([e8.windowHscroll(), e8.setWindowHscroll(null, -4), e8.windowHscroll(e8.selectedWindow()), e8.setWindowHscroll(undefined, 7)]))"#,
    );
    assert_eq!(got, "[30,0,0,7]");
    let got = eval(&mut ed, &s, r#"(e8.funcall("window-state-put", state), e8.windowHscroll())"#);
    assert_eq!(got, "30");
    // A deleted window is wrong-type-argument, as in Emacs.
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.w = e8.splitWindow(), e8.deleteWindow(w), e8.conditionCase(() => String(e8.windowHscroll(w)), { "wrong-type-argument": () => "wrong-type-argument" }))"#,
    );
    assert_eq!(got, "wrong-type-argument");
}

#[test]
fn scrolling_vertically_keeps_a_scroll_a_command_set() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let lines: Vec<String> = (0..60).map(|n| format!("{n:02} {}", "x".repeat(60))).collect();
    ed.type_text(&lines.join("\n"));
    let w = ed.selected_window();
    ed.set_window_size(w, 20, 10);
    ed.set_variable("truncate-lines", Value::Bool(true));
    press(&mut ed, "M-<");
    ed.set_window_hscroll(w, 20);
    ed.redisplay();
    // As in Emacs, C-v moves point with the text but leaves the scroll.
    assert_eq!(press(&mut ed, "C-v"), 20);
    // Moving point otherwise brings it back in sight.
    assert_eq!(press(&mut ed, "C-f"), 0);
}

#[test]
fn showing_a_buffer_again_resets_the_scroll() {
    let (mut ed, _s) = editor();
    let w = ed.selected_window();
    ed.set_window_hscroll(w, 9);
    let name = ed.window_buffer().name.clone();
    ed.set_window_buffer(w, &name).unwrap();
    assert_eq!(ed.window_hscroll(w), 0);
}

#[test]
fn positions_on_lines_current_line_mode_leaves_unscrolled() {
    let (mut ed, _s) = editor();
    ed.set_variable("auto-hscroll-mode", Value::Symbol("current-line".into()));
    press(&mut ed, "C-e");
    let w = ed.selected_window();
    let line = ed.window_buffer().line_start(2);
    assert_eq!(ed.posn_at_point(line, w).unwrap().col, 0.0);
    assert_eq!(ed.posn_at_point(ed.window_buffer().point(), w).unwrap().col, 16.0);
}
