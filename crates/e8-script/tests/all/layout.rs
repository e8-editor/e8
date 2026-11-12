//! Where text goes in a window: rows measured with a front end's metrics,
//! as the GUI's fonts measure them, and the position functions on them.

use std::sync::Arc;

use e8_core::Editor;
use e8_core::layout::{FontSpec, TextMetrics};
use e8_script::Scripting;

/// Metrics like a GUI's: a 10-point-wide monospace default font with
/// 20-point lines, and a proportional font where `i` is 4 wide and other
/// letters 8, each scaled with the face's height.
struct Points;

impl TextMetrics for Points {
    fn advance(&self, font: &FontSpec, c: char) -> f32 {
        let base = if !font.proportional() { 10.0 } else if c == 'i' { 4.0 } else { 8.0 };
        base * font.scale
    }

    fn line_height(&self, font: &FontSpec) -> f32 {
        20.0 * font.scale
    }

    fn char_width(&self) -> f32 {
        10.0
    }

    fn char_height(&self) -> f32 {
        20.0
    }
}

fn setup(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.set_text_metrics(Arc::new(Points));
    ed.set_frame_size(20, 11);
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

fn lines(n: usize) -> String {
    (0..n).map(|i| format!("line {i}\n")).collect()
}

#[test]
fn text_on_the_grid_is_placed_in_whole_columns_and_lines() {
    let (mut ed, s) = setup("ab\tc\nsecond\n");
    // The tab goes to column 8, so c is at 80 points; the second line 20 down.
    assert_eq!(eval(&mut ed, &s, "(e8.gotoChar(3), [e8.posnAtPoint().x, e8.posnAtPoint().y])"), "[80,0]");
    assert_eq!(eval(&mut ed, &s, "[e8.posnAtPoint(7).x, e8.posnAtPoint(7).y, e8.posnAtPoint(7).row]"), "[20,20,1]");
    assert_eq!(eval(&mut ed, &s, "e8.posnAtXY(85, 5).point"), "3");
    assert_eq!(eval(&mut ed, &s, "e8.posnAtXY(15, 25).point"), "6");
    assert_eq!(eval(&mut ed, &s, "e8.linePixelHeight()"), "20");
    assert_eq!(eval(&mut ed, &s, "[e8.defaultFontWidth(), e8.defaultFontHeight()]"), "[10,20]");
}

#[test]
fn scaled_text_takes_taller_rows_and_fewer_fit() {
    let (mut ed, s) = setup(&lines(40));
    // Ten lines of text a window, at 20 points each.
    assert_eq!(eval(&mut ed, &s, "e8.windowEnd()"), "70");
    ed.press("C-x C-+ C-x C-+").unwrap();
    // A row is now 1.44 lines: seven fit, the seventh only partly.
    assert_eq!(eval(&mut ed, &s, "Math.round(e8.linePixelHeight() * 100) / 100"), "28.8");
    assert_eq!(eval(&mut ed, &s, "Math.round(e8.posnAtPoint(7).y * 100) / 100"), "28.8");
    assert_eq!(eval(&mut ed, &s, "e8.windowEnd()"), "49");
    assert_eq!(eval(&mut ed, &s, "String(e8.posVisibleInWindowP(42))"), "\"undefined\"");
    assert_eq!(eval(&mut ed, &s, "String(e8.posVisibleInWindowP(42, undefined, true))"), "\"true\"");
    assert_eq!(eval(&mut ed, &s, "e8.posnAtXY(0, 30).point"), "7");
    // Point stays in sight, its row whole, as the rows are taller.
    ed.press("C-u 8 C-n").unwrap();
    ed.redisplay();
    let posn = eval(&mut ed, &s, "JSON.stringify(e8.posnAtPoint())");
    assert!(posn.contains("\\\"point\\\":56"), "{posn}");
    assert_ne!(ed.window_buffer().top_line, 0, "scrolled to keep line 8 whole");
}

#[test]
fn proportional_text_wraps_where_it_reaches_the_edge() {
    // The window is 19 columns of text, 190 points, beside the continuation column.
    let text = format!("{}\n", "i".repeat(40));
    let (mut ed, s) = setup(&text);
    let rows = |ed: &Editor| ed.window_rows(5, true).iter().map(|r| (r.start, r.end)).collect::<Vec<_>>();
    assert_eq!(rows(&ed), [(0, 19), (19, 38), (38, 40), (41, 41)]);
    ed.call("variable-pitch-mode", vec![]).unwrap();
    // At 4 points an i, 47 fit in 190 points: the line no longer wraps.
    assert_eq!(rows(&ed), [(0, 40), (41, 41)]);
    assert_eq!(eval(&mut ed, &s, "Math.round(e8.posnAtPoint(10).x)"), "40");
    assert_eq!(eval(&mut ed, &s, "Math.round(e8.windowTextPixelSize(undefined, 0, 40)[0])"), "160");
}

#[test]
fn line_moves_keep_an_x_position_in_proportional_text() {
    // Eight i's are 32 points; in m's, 8 points each, that is the fifth.
    let (mut ed, _s) = setup("iiiiiiiiii\nmmmmmmmmmm\niiiiiiiiii\n");
    ed.call("variable-pitch-mode", vec![]).unwrap();
    ed.press("C-f C-f C-f C-f C-f C-f C-f C-f C-n").unwrap();
    assert_eq!(ed.window_buffer().point(), 11 + 4);
    // The goal stays, so going on lands under the first place again.
    ed.press("C-n").unwrap();
    assert_eq!(ed.window_buffer().point(), 22 + 8);
    ed.press("C-p C-p").unwrap();
    assert_eq!(ed.window_buffer().point(), 8);
}

#[test]
fn scrolling_moves_by_the_height_rows_take() {
    let (mut ed, _s) = setup(&lines(40));
    ed.press("C-x C-+ C-x C-+").unwrap();
    // A screen less two lines of context is 8 lines; rows of 1.44 lines
    // fill that with 5 of them.
    ed.press("C-v").unwrap();
    assert_eq!(ed.window_buffer().top_line, 5);
    assert_eq!(ed.window_buffer().point(), ed.window_buffer().line_start(5), "point came along to the top");
    ed.press("C-v").unwrap();
    assert_eq!(ed.window_buffer().top_line, 10);
    ed.press("M-v").unwrap();
    assert_eq!(ed.window_buffer().top_line, 5);
    // Point, on line 10, still shows whole six rows down, so it stays.
    assert_eq!(ed.window_buffer().line_of(ed.window_buffer().point()), 10);
    // Back once more, line 10 is out of sight: point goes to the last line showing whole.
    ed.press("M-v").unwrap();
    assert_eq!(ed.window_buffer().top_line, 0);
    assert_eq!(ed.window_buffer().line_of(ed.window_buffer().point()), 5);
}

/// The vertical scroll a window keeps, as Emacs's vscroll (ADR 0071): in
/// lines or points, counted by the positions, gone once the window starts
/// elsewhere, and kept by window states.
#[test]
fn a_window_scrolled_part_of_a_line_up_draws_and_finds_its_rows_higher() {
    let (mut ed, s) = setup(&lines(40));
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "[e8.windowVscroll(), e8.setWindowVscroll(null, 0.5), e8.windowVscroll(null, true)]"), "[0,0.5,10]");
    ed.redisplay();
    let fd = ed.describe_frame(ed.selected_frame(), 1.0);
    assert_eq!(fd.windows[0].vscroll, 10.0);
    // The second line's top is 10 points down; a point 5 down is still the first line, 15 down the second.
    assert_eq!(eval(&mut ed, &s, "[e8.posnAtPoint(7).y, e8.posnAtXY(0, 5).point, e8.posnAtXY(0, 15).point]"), "[10,0,7]");
    assert_eq!(eval(&mut ed, &s, "e8.windowLineHeight(0)"), "[10,0,-10,0]");
    // A window state keeps it; negative is 0.
    assert_eq!(eval(&mut ed, &s, r#"(globalThis.state = e8.funcall("window-state-get"), e8.setWindowVscroll(null, -3))"#), "0");
    assert_eq!(eval(&mut ed, &s, r#"(e8.funcall("window-state-put", state), e8.windowVscroll(null, true))"#), "10");
    // The first line is only partly in sight.
    assert_eq!(eval(&mut ed, &s, "[e8.posVisibleInWindowP(0) ?? null, e8.posVisibleInWindowP(0, null, true)]"), "[null,true]");
    // Text typed at the start moves the start with it, and the scroll stays.
    ed.window_buffer_mut().set_point(0);
    ed.type_text("new ");
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "e8.windowVscroll(null, true)"), "10");
    // Starting elsewhere, as C-v makes it, it is gone, and coming back does not bring it back.
    ed.press("C-v").unwrap();
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "e8.windowVscroll()"), "0");
    ed.press("M-v").unwrap();
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "e8.windowVscroll()"), "0");
    // C-l recentres to whole lines.
    assert_eq!(eval(&mut ed, &s, "(e8.setWindowVscroll(null, 0.25), e8.call(\"recenter\"), e8.windowVscroll())"), "0");
}

#[test]
fn a_windows_vertical_scroll_is_in_the_frames_lines_whatever_the_buffers_scale() {
    let (mut ed, s) = setup(&lines(40));
    ed.press("C-x C-=").unwrap();
    ed.redisplay();
    assert_eq!(eval(&mut ed, &s, "e8.defaultFontHeight() > 20"), "true");
    assert_eq!(eval(&mut ed, &s, "[e8.setWindowVscroll(null, 0.5), e8.windowVscroll(null, true)]"), "[0.5,10]");
}

#[test]
fn a_terminal_never_scrolls_by_part_of_a_line() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(eval(&mut ed, &s, "[e8.setWindowVscroll(null, 2), e8.windowVscroll(), e8.windowVscroll(null, true)]"), "[0,0,0]");
}
