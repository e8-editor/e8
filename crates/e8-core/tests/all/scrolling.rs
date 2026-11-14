//! Mouse wheel and line scrolling, following Emacs's mwheel-scroll: the view
//! moves, and point moves only when it would leave the window.

use e8_core::Editor;

/// An editor with 100 numbered lines and a 10 line window, point at the start.
fn editor() -> Editor {
    let mut ed = Editor::new();
    let text: Vec<String> = (0..100).map(|n| format!("line {n}")).collect();
    ed.type_text(&text.join("\n"));
    ed.set_viewport_height(10);
    ed.press("M-< C-g").unwrap();
    ed.ensure_point_visible();
    ed
}

fn top(ed: &Editor) -> usize {
    ed.window_buffer().top_line
}

fn point_line_col(ed: &Editor) -> (usize, usize) {
    let b = ed.window_buffer();
    (b.line_of(b.point()), b.column(b.point()))
}

#[test]
fn point_stays_while_it_is_visible() {
    let mut ed = editor();
    ed.press("C-n C-n C-n C-n C-n").unwrap();
    ed.wheel(3);
    assert_eq!(top(&ed), 3);
    assert_eq!(point_line_col(&ed), (5, 0));
    // The view is not recentred on point afterwards.
    ed.ensure_point_visible();
    assert_eq!(top(&ed), 3);
}

#[test]
fn point_moves_to_stay_in_the_window_keeping_its_column() {
    let mut ed = editor();
    ed.press("C-f C-f C-f").unwrap();
    ed.wheel(20);
    assert_eq!(top(&ed), 20);
    assert_eq!(point_line_col(&ed), (20, 3));
    ed.wheel(-15);
    assert_eq!(top(&ed), 5);
    assert_eq!(point_line_col(&ed), (14, 3));
}

#[test]
fn the_column_survives_short_lines() {
    let mut ed = Editor::new();
    ed.type_text("a long first line\nab\nx\nanother long line\nend");
    ed.set_viewport_height(1);
    ed.press("M-< C-g C-e").unwrap();
    ed.ensure_point_visible();
    ed.wheel(1);
    assert_eq!(point_line_col(&ed), (1, 2));
    ed.wheel(1);
    ed.wheel(1);
    assert_eq!(point_line_col(&ed), (3, 17));
}

#[test]
fn scrolling_stops_at_the_ends_quietly() {
    let mut ed = editor();
    ed.wheel(-5);
    assert_eq!(top(&ed), 0);
    assert_eq!(ed.echo(), None);
    ed.wheel(1000);
    // The last line can scroll up to the top of the window, as in Emacs.
    assert_eq!(top(&ed), 99);
    assert_eq!(point_line_col(&ed).0, 99);
    assert_eq!(ed.echo(), None);
}

#[test]
fn the_wheel_is_a_key() {
    let mut ed = editor();
    ed.press("<wheel-down> <wheel-down>").unwrap();
    assert_eq!(top(&ed), 2);
    ed.press("<wheel-up>").unwrap();
    assert_eq!(top(&ed), 1);

    // Rebinding the wheel changes what it does, as in Emacs.
    let mut ed = editor();
    let map = ed.global_map();
    ed.keymaps_mut().bind_str(map, "<wheel-down>", "next-line");
    ed.wheel(1);
    assert_eq!(top(&ed), 0);
    assert_eq!(point_line_col(&ed), (1, 0));
}

#[test]
fn scrolling_works_while_the_minibuffer_is_open() {
    let mut ed = editor();
    ed.press("M-x").unwrap();
    ed.wheel(4);
    assert_eq!(top(&ed), 4);
    assert_eq!(ed.prompt(), Some("M-x "));
}

#[test]
fn scroll_line_commands() {
    let mut ed = editor();
    ed.call("scroll-up-line", vec![]).unwrap();
    assert_eq!(top(&ed), 1);
    ed.call("scroll-down-line", vec![]).unwrap();
    assert_eq!(top(&ed), 0);
    let err = ed.call("scroll-down-line", vec![]).unwrap_err();
    assert_eq!(err.to_string(), "Beginning of buffer");
}

/// With lines truncated, keeping point in view looks at the overlays on
/// the rows it passes, not every overlay in the buffer for each row: with
/// 50,000 overlays, moving down 2,000 lines is quick.
#[test]
fn truncated_rows_look_only_at_their_own_overlays() {
    let mut ed = Editor::new();
    let text: Vec<String> = (0..50_000).map(|n| format!("line {n}")).collect();
    ed.buffer_mut().set_text(&text.join("\n"));
    for line in 0..50_000 {
        let start = ed.buffer().line_start(line);
        let id = ed.buffer_mut().make_overlay(start..start + 4);
        ed.buffer_mut().overlay_put(id, "face", e8_core::Value::Str("bold".into())).unwrap();
    }
    ed.set_variable("truncate-lines", e8_core::Value::Bool(true));
    ed.set_viewport_height(24);
    let started = std::time::Instant::now();
    for _ in 0..2_000 {
        ed.press("C-n").unwrap();
        ed.ensure_point_visible();
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    assert_eq!(ed.buffer().line_of(ed.buffer().point()), 2_000);
}

/// An editor whose lines each wrap over several screen rows, as a long
/// paragraph in an Org file does, in a window 20 columns by 10 rows, with
/// point halfway down the buffer.
fn wrapping_editor() -> Editor {
    let mut ed = Editor::new();
    // Each line is 70 characters, so it takes four rows of 20 columns.
    let text: Vec<String> = (0..60).map(|n| format!("{n:02} {}", "word ".repeat(13).trim_end())).collect();
    ed.type_text(&text.join("\n"));
    ed.set_frame_size(20, 10);
    ed.press("M-< C-g").unwrap();
    for _ in 0..30 {
        ed.press("C-n").unwrap();
    }
    ed.redisplay();
    ed
}

#[test]
fn scrolling_up_over_continued_lines_is_not_pulled_back_to_point() {
    let mut ed = wrapping_editor();
    let started = top(&ed);
    assert!(started > 0, "point is halfway down, so the window starts below the top");
    // Wheel up a line at a time, redisplaying after each as a front end
    // does: the window must move up every time and never back to point,
    // until it reaches the top of the buffer.
    let mut last = started;
    for _ in 0..80 {
        ed.wheel(-1);
        ed.redisplay();
        let now = top(&ed);
        assert!(now <= last, "the window went back down from line {last} to {now}");
        last = now;
        if now == 0 {
            break;
        }
    }
    assert_eq!(last, 0, "the wheel reached the top of the buffer");
}

/// Metrics like a window's, which lay rows out by their heights rather
/// than counting them, at one unit a character and a row, so the rows
/// fall where the uniform ones above do.
struct ByHeight;

impl e8_core::layout::TextMetrics for ByHeight {
    fn advance(&self, _font: &e8_core::layout::FontSpec, _c: char) -> f32 {
        1.0
    }
    fn line_height(&self, _font: &e8_core::layout::FontSpec) -> f32 {
        1.0
    }
    fn char_width(&self) -> f32 {
        1.0
    }
    fn char_height(&self) -> f32 {
        1.0
    }
    fn uniform(&self) -> bool {
        false
    }
}

#[test]
fn scrolling_up_is_not_pulled_back_where_rows_are_laid_out_by_height() {
    let mut ed = wrapping_editor();
    ed.set_text_metrics(std::sync::Arc::new(ByHeight));
    ed.redisplay();
    let mut last = top(&ed);
    assert!(last > 0);
    for _ in 0..80 {
        ed.wheel(-1);
        ed.redisplay();
        let now = top(&ed);
        assert!(now <= last, "the window went back down from line {last} to {now}");
        last = now;
        if now == 0 {
            break;
        }
    }
    assert_eq!(last, 0, "the wheel reached the top of the buffer");
}

#[test]
fn point_left_by_the_wheel_is_in_view_on_continued_lines() {
    let mut ed = wrapping_editor();
    ed.wheel(-3);
    let before = top(&ed);
    // Redisplay leaves the window where the wheel put it: point is on a
    // line the window shows whole.
    ed.redisplay();
    assert_eq!(top(&ed), before);
}
