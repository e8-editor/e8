//! Long lines: continued on the next screen line by default, cut off with
//! truncate-lines, and broken between words in visual-line-mode.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    let window = ed.selected_window();
    ed.set_window_size(window, 20, 6);
    (ed, scripting)
}

/// The rows the window shows, as text.
fn rows(ed: &Editor) -> Vec<String> {
    ed.window_rows(20, true)
        .iter()
        .map(|r| r.segments.iter().map(|s| s.text.as_str()).collect())
        .collect()
}

fn point(ed: &Editor) -> usize {
    ed.window_buffer().point()
}

const LONG: &str = "0123456789abcdefghijklmnopqrstuvwxyz0123456789";

#[test]
fn long_lines_continue_one_column_short_of_the_edge() {
    let (ed, _scripting) = setup(&format!("{LONG}\nshort"));
    // 20 columns, one kept for the continuation mark.
    assert_eq!(rows(&ed), ["0123456789abcdefghi", "jklmnopqrstuvwxyz01", "23456789", "short"]);
    let continued: Vec<bool> = ed.window_rows(4, true).iter().map(|r| r.continued).collect();
    assert_eq!(continued, [true, true, false, false]);
}

#[test]
fn line_moves_go_by_screen_lines() {
    let (mut ed, _scripting) = setup(&format!("{LONG}\nshort"));
    ed.press("C-f C-f C-n").unwrap();
    assert_eq!(point(&ed), 21);
    ed.press("C-n").unwrap();
    assert_eq!(point(&ed), 40);
    ed.press("C-n").unwrap();
    assert_eq!(point(&ed), 49, "into the next line, keeping the column");
    ed.press("C-p C-p C-p").unwrap();
    assert_eq!(point(&ed), 2);
    // C-e goes to the end of the line of text, on its last screen line.
    ed.press("C-e C-p").unwrap();
    assert_eq!(point(&ed), 27);
}

#[test]
fn line_moves_stop_before_where_a_screen_line_breaks() {
    let (mut ed, _scripting) = setup(&format!("0123456789abcdefghi\n{LONG}"));
    // From column 19, past the end of the continued screen line below.
    ed.press("C-e C-n").unwrap();
    assert_eq!(point(&ed), 20 + 18, "on the screen line's last character");
}

#[test]
fn line_move_visual_off_moves_by_lines() {
    let (mut ed, _scripting) = setup(&format!("{LONG}\nshort"));
    ed.set_variable("line-move-visual", Value::Bool(false));
    ed.press("C-f C-f C-n").unwrap();
    assert_eq!(point(&ed), 49);
}

#[test]
fn truncate_lines_cuts_lines_off() {
    let (mut ed, _scripting) = setup(&format!("{LONG}\nshort"));
    ed.call("toggle-truncate-lines", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("Truncate long lines enabled"));
    assert_eq!(rows(&ed), [LONG, "short"]);
    ed.press("C-n").unwrap();
    assert_eq!(point(&ed), 47);
    ed.call("toggle-truncate-lines", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("Truncate long lines disabled"));
    assert_eq!(rows(&ed).len(), 4);
}

#[test]
fn narrow_side_by_side_windows_truncate() {
    let (mut ed, _scripting) = setup(&format!("{LONG}\nshort"));
    ed.press("C-x 3").unwrap();
    for window in ed.window_list() {
        ed.set_window_size(window, 30, 6);
    }
    assert_eq!(rows(&ed), [LONG, "short"], "narrower than truncate-partial-width-windows");
    ed.set_variable("truncate-partial-width-windows", Value::Number(0.0));
    assert_eq!(rows(&ed).len(), 3);
    // As Emacs reads it: nil leaves it to truncate-lines, and any other
    // non-nil value truncates every window that shares the frame's width.
    ed.set_variable("truncate-partial-width-windows", Value::Null);
    assert_eq!(rows(&ed).len(), 3, "nil wraps");
    ed.set_variable("truncate-partial-width-windows", Value::Bool(true));
    for window in ed.window_list() {
        ed.set_window_size(window, 60, 6);
    }
    assert_eq!(rows(&ed), [LONG, "short"], "t truncates however wide");
}

#[test]
fn visual_line_mode_wraps_narrow_side_by_side_windows() {
    // As Emacs 30.2's visual-line-mode: truncate-partial-width-windows
    // becomes nil in the buffer, so narrow windows wrap too.
    let (mut ed, _scripting) = setup(&format!("{LONG}\nshort"));
    ed.press("C-x 3").unwrap();
    for window in ed.window_list() {
        ed.set_window_size(window, 30, 6);
    }
    ed.call("visual-line-mode", vec![]).unwrap();
    assert_eq!(ed.variable("truncate-partial-width-windows"), Some(Value::Null));
    assert!(ed.is_local_variable("truncate-partial-width-windows"));
    assert_eq!(rows(&ed).len(), 3, "{:?}", rows(&ed));
    // Turned off, the buffer goes back to the default, and truncates again.
    ed.run_interactive("visual-line-mode");
    assert!(!ed.is_local_variable("truncate-partial-width-windows"));
    assert_eq!(ed.variable("truncate-partial-width-windows"), Some(Value::Number(50.0)));
    assert_eq!(rows(&ed), [LONG, "short"]);
}

#[test]
fn visual_line_mode_breaks_between_words() {
    let (mut ed, _scripting) = setup("the quick brown fox jumps over the lazy dog");
    ed.call("visual-line-mode", vec![]).unwrap();
    assert_eq!(ed.mode_lighters(), [" Wrap"]);
    assert_eq!(rows(&ed), ["the quick brown ", "fox jumps over the ", "lazy dog"]);
    // C-e and C-a work on screen lines.
    ed.press("C-e").unwrap();
    assert_eq!(point(&ed), 15);
    ed.press("C-n C-a").unwrap();
    assert_eq!(point(&ed), 16);
    // C-k kills to the end of the screen line.
    ed.press("C-k").unwrap();
    assert_eq!(ed.window_buffer().slice(0..ed.window_buffer().len()), "the quick brown lazy dog");
    // Run as a command, it turns the mode off again.
    ed.run_interactive("visual-line-mode");
    assert_eq!(ed.variable("word-wrap"), Some(Value::Bool(false)));
}

#[test]
fn point_stays_visible_among_continued_lines() {
    let text: Vec<String> = (0..10).map(|n| format!("{n}{}", &LONG[1..])).collect();
    let (mut ed, _scripting) = setup(&text.join("\n"));
    // Each line takes three screen lines and the window shows six.
    ed.press("C-n C-n C-n").unwrap();
    ed.ensure_point_visible();
    assert_eq!(ed.window_buffer().line_of(point(&ed)), 1);
    let shown = ed.window_rows(6, true);
    assert!(shown.iter().any(|r| r.shows_point(point(&ed))), "{:?}", rows(&ed));
    ed.press("M->").unwrap();
    ed.ensure_point_visible();
    let shown = ed.window_rows(6, true);
    assert!(shown.iter().any(|r| r.shows_point(point(&ed))), "{:?}", rows(&ed));
}

#[test]
fn hidden_text_is_not_split_by_wrapping() {
    let (mut ed, scripting) = setup("* Heading that is fairly long\nbody\n* Next");
    ed.call("outline-mode", vec![]).unwrap();
    scripting
        .eval_typescript(&mut ed, "test.ts", r#"e8.gotoChar(0); e8.call("outline-hide-subtree");"#.into())
        .unwrap();
    let rows = rows(&ed);
    assert_eq!(rows[..2], ["* Heading that is f", "airly long..."]);
}

#[test]
fn scripts_see_screen_lines() {
    let (mut ed, scripting) = setup(LONG);
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"const l = e8.screenLine(25); e8.message(`${l.start} ${l.end} ${l.continued}`);"#.into(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("19 38 true"));
}

#[test]
fn global_visual_line_mode_wraps_every_buffer_and_new_ones() {
    let (mut ed, _scripting) = setup("x");
    ed.call("global-visual-line-mode", vec![]).unwrap();
    assert_eq!(ed.variable("visual-line-mode"), Some(Value::Bool(true)));
    ed.press("C-x b n e w RET").unwrap();
    ed.call("text-mode", vec![]).unwrap();
    assert_eq!(ed.variable("visual-line-mode"), Some(Value::Bool(true)));
    assert_eq!(ed.variable("word-wrap"), Some(Value::Bool(true)));
    ed.press("M-x g l o b a l - v i s u a l - l i n e - m o d e RET").unwrap();
    assert_eq!(ed.variable("visual-line-mode"), Some(Value::Bool(false)));
}
