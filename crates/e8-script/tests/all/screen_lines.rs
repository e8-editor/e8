//! Moving by screen lines and asking how a window lays out its rows, as
//! Emacs's indent.c and window.c (ADR 0071): vertical-motion,
//! compute-motion, line-number-display-width, window-line-height and the
//! rest. The numbers are what Emacs 30 gives in a 20 column, 8 line
//! terminal window, its positions less one, as E8 counts from 0.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TEXT: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\nshort\n\tTAB line that is long enough to wrap around\nlast";

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(TEXT);
    let w = ed.selected_window();
    ed.set_window_size(w, 20, 8);
    ed.window_buffer_mut().set_point(0);
    ed.redisplay();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Moves from `from` by `lines`, giving what vertical-motion returns and where point is.
fn motion(from: usize, lines: &str, truncate: bool) -> String {
    let (mut ed, s) = setup();
    if truncate {
        ed.set_variable("truncate-lines", Value::Bool(true));
    }
    ed.window_buffer_mut().set_point(from);
    ed.redisplay();
    eval(&mut ed, &s, &format!("JSON.stringify([e8.windowHscroll(), e8.verticalMotion({lines}), e8.point()])"))
}

#[test]
fn vertical_motion_moves_by_screen_lines() {
    assert_eq!(motion(0, "1", false), "[0,1,19]");
    assert_eq!(motion(0, "2", false), "[0,2,38]");
    assert_eq!(motion(0, "3", false), "[0,3,47]");
    assert_eq!(motion(24, "1", false), "[0,1,38]");
    // 0 goes to the start of the screen line.
    assert_eq!(motion(24, "0", false), "[0,0,19]");
    assert_eq!(motion(24, "-1", false), "[0,-1,0]");
    // Stops at the start of the buffer, and past its end goes to the end.
    assert_eq!(motion(24, "-5", false), "[0,-1,0]");
    assert_eq!(motion(53, "9", false), "[0,3,102]");
    assert_eq!(motion(102, "1", false), "[0,0,102]");
    assert_eq!(motion(0, "2", true), "[0,2,53]");
}

#[test]
fn vertical_motion_to_a_column() {
    assert_eq!(motion(0, "[5, 1]", false), "[0,1,24]");
    // A short line's end, a column in a tab its start, a fraction rounded.
    assert_eq!(motion(0, "[30, 3]", false), "[0,3,52]");
    assert_eq!(motion(24, "[3, 0]", false), "[0,0,22]");
    assert_eq!(motion(0, "[2.6, 1]", false), "[0,1,22]");
    assert_eq!(motion(0, "[4, 4]", false), "[0,4,53]");
}

#[test]
fn vertical_motion_in_a_scrolled_window() {
    // Lines' starts, though scrolled off; columns from the left edge.
    assert_eq!(motion(39, "0", true), "[29,0,0]");
    assert_eq!(motion(39, "1", true), "[29,1,47]");
    assert_eq!(motion(39, "[2, 0]", true), "[29,0,31]");
}

#[test]
fn line_number_display_width_in_digits_columns_and_units() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.lineNumberDisplayWidth(), e8.lineNumberDisplayWidth("columns")])"#), "[0,0]");
    ed.set_variable("display-line-numbers", Value::Bool(true));
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.lineNumberDisplayWidth(), e8.lineNumberDisplayWidth("columns"), e8.lineNumberDisplayWidth(true)])"#), "[1,3,3]");
}

#[test]
fn window_line_height_of_rows_and_the_mode_line() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.windowLineHeight(), e8.windowLineHeight(0), e8.windowLineHeight(2), e8.windowLineHeight(-1), e8.windowLineHeight("mode-line"), e8.windowLineHeight("header-line") ?? null, e8.windowLineHeight(50)])"#,
    );
    assert_eq!(got, "[[1,0,0,0],[1,0,0,0],[1,2,2,0],[1,7,7,0],[1,0,8,0],null,[1,7,7,0]]");
}

#[test]
fn window_lines_pixel_dimensions_give_each_rows_end() {
    let (mut ed, s) = setup();
    // The rows whole in the window: as wide as their text, as Emacs's
    // graphical frames give it, and their bottoms.
    let got = eval(&mut ed, &s, "JSON.stringify(e8.windowLinesPixelDimensions(null, null, null, true))");
    assert_eq!(got, "[[19,1],[19,2],[8,3],[5,4],[19,5],[19,6],[13,7]]");
    let got = eval(&mut ed, &s, "JSON.stringify(e8.windowLinesPixelDimensions(null, 1, 2, true, true))");
    assert_eq!(got, "[[1,2],[12,3]]");
}

/// compute-motion over `text` with Emacs's arguments, as batch Emacs 30
/// gives them in its 80 column frame, positions less one.
fn compute_motion(text: &str, args: &str, partial: bool) -> String {
    let (mut ed, s) = setup();
    ed.set_frame_size(80, 10);
    ed.window_buffer_mut().set_text(text);
    if !partial {
        ed.set_variable("truncate-partial-width-windows", Value::Null);
    }
    eval(&mut ed, &s, &format!("JSON.stringify(e8.computeMotion({args}))"))
}

#[test]
fn compute_motion_stops_at_a_position_or_a_place() {
    let line = |n: usize, rest: &str| format!("{}{rest}\n", "a".repeat(n));
    // A width of 20 in an 80 column frame truncates, as
    // truncate-partial-width-windows says of 21 columns.
    let cases = [
        (TEXT.to_string(), "0, [0, 0], 29, [0, 10], 20", true, "[29,20,0,20,false]"),
        (TEXT.to_string(), "0, [0, 0], 102, [5, 2], 20", true, "[54,8,2,0,false]"),
        (TEXT.to_string(), "0, [0, 0], 102, [0, 1], 20", true, "[47,0,1,20,false]"),
        (TEXT.to_string(), "0, [0, 0], 59, [0, 100], 79", true, "[59,13,2,13,false]"),
        // Scrolled 3, lines start a column right of -3 for the `$`.
        (TEXT.to_string(), "0, [0, 0], 59, [0, 100], 79, [3, 0]", true, "[59,11,2,11,false]"),
        (line(18, "\tb"), "0, [0, 0], 18, [0, 100], 20", true, "[18,18,0,18,false]"),
        (line(18, "\tb"), "0, [0, 0], 19, [0, 100], 20", true, "[19,20,0,20,false]"),
        // Continued: at the start of a continuation row, tabs at their
        // stops past the margin, and a wide character whole on the next row.
        (TEXT.to_string(), "0, [0, 0], 29, [0, 10], 20", false, "[29,9,1,9,false]"),
        (TEXT.to_string(), "0, [0, 0], 52, [0, 1], 20", false, "[20,0,1,20,true]"),
        (TEXT.to_string(), "0, [0, 0], 47, [0, 100], 20", false, "[47,0,3,0,false]"),
        (line(21, "\tb"), "0, [0, 0], 23, [0, 100], 20", false, "[23,5,1,5,false]"),
        (line(19, "中b"), "0, [0, 0], 21, [0, 100], 20", false, "[21,3,1,3,false]"),
        (line(18, "\tb"), "0, [0, 0], 19, [0, 100], 20", false, "[19,4,1,4,false]"),
    ];
    for (text, args, partial, want) in cases {
        assert_eq!(compute_motion(&text, args, partial), want, "{args} partial={partial} over {text:?}");
    }
    let (mut ed, s) = setup();
    let got = eval(&mut ed, &s, r#"e8.conditionCase(() => "no error", { "args-out-of-range": () => "args-out-of-range" }) && e8.conditionCase(() => String(e8.computeMotion(0, [0, 0], 500, [0, 0])), { "args-out-of-range": () => "args-out-of-range" })"#);
    assert_eq!(got, "args-out-of-range");
}

#[test]
fn rows_past_the_text_count_as_empty_rows() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("one\ntwo");
    ed.redisplay();
    // As Emacs 30 gives them in its terminal.
    let got = eval(&mut ed, &s, "JSON.stringify([e8.windowLineHeight(-1), e8.windowLineHeight(5), e8.windowLineHeight(1)])");
    assert_eq!(got, "[[1,7,7,0],[1,5,5,0],[1,1,1,0]]");
    // Without `body`, the window's last row too.
    let got = eval(&mut ed, &s, "JSON.stringify([e8.windowLinesPixelDimensions().length, e8.windowLinesPixelDimensions(null, null, null, true).length, e8.windowLinesPixelDimensions().map((r) => r[1])])");
    assert_eq!(got, "[8,7,[1,2,3,4,5,6,7,8]]");
}

#[test]
fn window_scroll_functions_run_when_a_window_starts_elsewhere() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.seen = [], e8.addHook("window-scroll-functions", (w, start) => { seen.push(start); }), 0)"#);
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen)"), "[]");
    let w = ed.selected_window();
    // Point below the window's height, which scrolls it.
    let more: String = (0..30).map(|n| format!("\n{n}")).collect();
    ed.window_buffer_mut().set_text(&format!("{TEXT}{more}"));
    let end = ed.window_buffer().len();
    ed.window_buffer_mut().set_point(end);
    ed.redisplay();
    ed.redisplay();
    let start = ed.window_start(w).unwrap();
    assert!(start > 0);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen)"), format!("[{start}]"));
    assert_eq!(eval(&mut ed, &s, "(e8.runWindowScrollFunctions(), JSON.stringify(seen))"), format!("[{start},{start}]"));
}

#[test]
fn other_window_for_scrolling_finds_the_next_window_or_says_there_is_none() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"e8.conditionCase(() => "no error", { error: (e) => e.message }, () => 0) && e8.conditionCase(() => String(e8.funcall("other-window-for-scrolling")), { error: (e) => e.message })"#,
    );
    assert_eq!(got, "There is no other window");
    let got = eval(&mut ed, &s, r#"(globalThis.w2 = e8.splitWindow(), e8.funcall("other-window-for-scrolling") === w2)"#);
    assert_eq!(got, "true");
}

#[test]
fn window_scroll_functions_are_the_windows_buffers_and_errors_do_not_stop_them() {
    let (mut ed, s) = setup();
    // A function of the buffer's own, one that fails, and a global one.
    eval(
        &mut ed,
        &s,
        r#"(globalThis.seen = [],
           e8.addHook("window-scroll-functions", () => { throw new Error("boom"); }, { local: true }),
           e8.addHook("window-scroll-functions", (w, start) => { seen.push(["local", e8.bufferName(e8.currentBuffer())]); }, { local: true }),
           e8.addHook("window-scroll-functions", (w, start) => { seen.push(["global", start]); }),
           0)"#,
    );
    let w = ed.selected_window();
    ed.run_window_scroll_functions(w);
    let name = ed.window_buffer().name.clone();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(seen)"), format!(r#"[["local","{name}"],["global",0]]"#));
}

#[test]
fn editing_above_another_windows_start_does_not_run_window_scroll_functions() {
    let (mut ed, s) = setup();
    let more: String = (0..30).map(|n| format!("\n{n}")).collect();
    ed.window_buffer_mut().set_text(&format!("{TEXT}{more}"));
    eval(&mut ed, &s, r#"(globalThis.w2 = e8.splitWindow(), e8.setWindowStart(w2, 60), 0)"#);
    ed.redisplay();
    eval(&mut ed, &s, r#"(globalThis.seen = 0, e8.addHook("window-scroll-functions", () => { seen++; }), 0)"#);
    ed.window_buffer_mut().set_point(0);
    ed.type_text("typed ");
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "seen"), "0");
}
