//! The window tree as window.c keeps it (ADR 0069, stage 3): combinations
//! of any number of windows, internal windows as objects with parents,
//! children and siblings, and how splitting and deleting change it. Each
//! expectation is what Emacs 30 gives on an 80 by 24 root window.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    eval(
        &mut ed,
        &s,
        r#"(globalThis.desc = (w) => {
            if (e8.windowLiveP(w)) return ["live", e8.windowTotalHeight(w), e8.windowTotalWidth(w)];
            const kids = []; for (let c = e8.windowTopChild(w) ?? e8.windowLeftChild(w); c; c = e8.windowNextSibling(c)) kids.push(desc(c));
            return [e8.windowLeftChild(w) ? "h" : "v", e8.windowTotalHeight(w), e8.windowTotalWidth(w), kids];
          }, globalThis.show = () => JSON.stringify(desc(e8.frameRootWindow())), "")"#,
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn splits_of_one_kind_share_one_internal_window() {
    let (mut ed, s) = setup();
    ed.press("C-x 2 C-x 2").unwrap();
    assert_eq!(eval(&mut ed, &s, "show()"), r#"["v",24,80,[["live",6,80],["live",6,80],["live",12,80]]]"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.windowNormalSize(), e8.windowNormalSize(undefined, true)])"), "[0.25,1]");
    ed.press("C-x 3").unwrap();
    assert_eq!(
        eval(&mut ed, &s, "show()"),
        r#"["v",24,80,[["h",6,80,[["live",6,40],["live",6,40]]],["live",6,80],["live",12,80]]]"#
    );
    assert_eq!(eval(&mut ed, &s, "String(e8.windowParent(e8.windowParent()) === e8.frameRootWindow())"), "true");
    // Deleting the window on the right leaves its sibling in the combination of its kind.
    eval(&mut ed, &s, r#"(e8.deleteWindow(e8.windowList()[1]), "")"#);
    assert_eq!(eval(&mut ed, &s, "show()"), r#"["v",24,80,[["live",6,80],["live",6,80],["live",12,80]]]"#);
}

#[test]
fn deleting_a_window_joins_its_siblings_children_to_their_grandparent() {
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x 2 C-x 3").unwrap();
    assert_eq!(
        eval(&mut ed, &s, "show()"),
        r#"["h",24,80,[["v",24,40,[["h",12,40,[["live",12,20],["live",12,20]]],["live",12,40]]],["live",24,40]]]"#
    );
    ed.press("C-x 0").unwrap();
    assert_eq!(eval(&mut ed, &s, "show()"), r#"["h",24,80,[["v",24,40,[["live",12,40],["live",12,40]]],["live",24,40]]]"#);
}

#[test]
fn internal_windows_are_valid_windows_but_not_live() {
    let (mut ed, s) = setup();
    ed.press("C-x 2").unwrap();
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"((r) => JSON.stringify([e8.windowValidP(r), e8.windowLiveP(r), e8.windowp(r), e8.windowParent(r) ?? null,
              e8.windowEdges(r), (e8.setWindowParameter(r, "p", 1), e8.windowParameter(r, "p")), e8.windowCombinationLimit(r)]))(e8.frameRootWindow())"#
        ),
        "[true,false,true,null,[0,0,80,24],1,false]"
    );
}

#[test]
fn enlarging_a_window_takes_from_the_one_after_it_or_the_last_from_the_one_before() {
    let (mut ed, s) = setup();
    let heights = |ed: &mut Editor| eval(ed, &s, "JSON.stringify(e8.windowList().map((w) => e8.windowTotalHeight(w)))");
    ed.press("C-x 2 C-x 2 C-x o C-u 2 C-x ^").unwrap();
    assert_eq!(heights(&mut ed), "[6,8,10]");
    ed.press("C-u 5 C-x ^").unwrap();
    assert_eq!(heights(&mut ed), "[6,13,5]");
    ed.press("C-x o C-x ^").unwrap();
    assert_eq!(heights(&mut ed), "[6,12,6]");
}

/// A front end that measures in points, as the GUI does: characters 8
/// wide and lines 20 tall, a mode line 32 tall, 12 above the text and 16
/// of fringe each side.
struct Points;

impl e8_core::layout::TextMetrics for Points {
    fn advance(&self, _: &e8_core::layout::FontSpec, _: char) -> f32 {
        8.0
    }
    fn line_height(&self, _: &e8_core::layout::FontSpec) -> f32 {
        20.0
    }
    fn char_width(&self) -> f32 {
        8.0
    }
    fn char_height(&self) -> f32 {
        20.0
    }
    fn window_chrome(&self) -> e8_core::layout::WindowChrome {
        e8_core::layout::WindowChrome { mode_line: 32.0, header_line: 32.0, text_top: 12.0, fringes: 32.0, divider: 0.0 }
    }
}

#[test]
fn sizes_are_the_front_ends_units() {
    let (mut ed, s) = setup();
    ed.set_text_metrics(std::sync::Arc::new(Points));
    // 641 by 401 points: 80 columns and 20 lines, and a point to spare each way.
    ed.set_frame_pixel_size(641, 401);
    ed.press("C-x 2").unwrap();
    // Halved in lines, 10 each; the old window keeps the spare point.
    assert_eq!(
        eval(&mut ed, &s, "JSON.stringify(e8.windowList().map((w) => [e8.windowPixelHeight(w), e8.windowBodyPixelHeight(w), e8.windowTotalHeight(w)]))"),
        "[[201,157,10],[200,156,10]]"
    );
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.windowPixelEdges(e8.windowList()[1], true))"), "[16,213,625,369]");
    // Text rows beside the mode line and the room above: (200 - 32 - 12) / 20.
    assert_eq!(eval(&mut ed, &s, "String(e8.windowSize(e8.windowList()[1]).height)"), "7");
    // Resized by points or by lines.
    assert_eq!(eval(&mut ed, &s, "String(e8.resizeWindow(e8.windowList()[1], 15, false, true, true))"), "15");
    assert_eq!(eval(&mut ed, &s, "String(e8.windowPixelHeight(e8.windowList()[1]))"), "215");
    assert_eq!(eval(&mut ed, &s, "String(e8.resizeWindow(e8.windowList()[1], -1))"), "-1");
    assert_eq!(eval(&mut ed, &s, "String(e8.windowPixelHeight(e8.windowList()[1]))"), "195");
    // fit-window-to-buffer fits the text and what of the window is not
    // text, 164 points, in whole lines as Emacs does: nine, so a line less.
    eval(
        &mut ed,
        &s,
        r#"(import("window").then((m) => { globalThis.win = m; }), "")"#,
    );
    eval(
        &mut ed,
        &s,
        r#"((w) => { e8.withCurrentBuffer(e8.getBufferCreate("f"), () => e8.insert("1\n2\n3\n4\n5\n6")); e8.setWindowBuffer(w, "f"); win.fitWindowToBuffer(w); return ""; })(e8.windowList()[1])"#,
    );
    assert_eq!(eval(&mut ed, &s, "String(e8.windowPixelHeight(e8.windowList()[1]))"), String::from("175"));
    // In points with window-resize-pixelwise.
    eval(&mut ed, &s, r#"(e8.setVariable("window-resize-pixelwise", true), win.fitWindowToBuffer(e8.windowList()[1]), "")"#);
    assert_eq!(eval(&mut ed, &s, "String(e8.windowPixelHeight(e8.windowList()[1]))"), String::from("164"));
}

#[test]
fn a_window_without_a_mode_line_has_that_line_for_text() {
    // As Emacs: fit-window-to-buffer gives six lines of text six lines, the window having no mode line.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(import("window").then((m) => { globalThis.win = m; }), "")"#);
    let got = eval(
        &mut ed,
        &s,
        r#"((w) => { e8.withCurrentBuffer(e8.getBufferCreate("f"), () => { e8.insert("1\n2\n3\n4\n5\n6"); e8.makeLocalVariable("mode-line-format"); e8.setVariable("mode-line-format", null); });
            e8.setWindowBuffer(w, "f"); win.fitWindowToBuffer(w); return JSON.stringify([e8.windowTotalHeight(w), e8.windowSize(w).height]); })(e8.splitWindow())"#,
    );
    assert_eq!(got, "[6,6]");
}

/// Columns 7.83 points wide, as a GUI font's may be.
struct Fractional;

impl e8_core::layout::TextMetrics for Fractional {
    fn advance(&self, _: &e8_core::layout::FontSpec, _: char) -> f32 {
        7.83
    }
    fn line_height(&self, _: &e8_core::layout::FontSpec) -> f32 {
        20.0
    }
    fn char_width(&self) -> f32 {
        7.83
    }
    fn char_height(&self) -> f32 {
        20.0
    }
}

#[test]
fn windows_total_sizes_add_up_to_the_frames() {
    let (mut ed, s) = setup();
    ed.set_text_metrics(std::sync::Arc::new(Fractional));
    ed.set_frame_pixel_size(1000, 480);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.frameWidth(), e8.windowTotalWidth()])"), "[127,127]");
    ed.press("C-x 3").unwrap();
    assert_eq!(eval(&mut ed, &s, "String(e8.windowList().reduce((n, w) => n + e8.windowTotalWidth(w), 0))"), "127");
}

#[test]
fn new_sizes_are_applied_together_when_they_add_up() {
    // As Emacs 30 in batch, where a pixel is a line.
    let (mut ed, s) = setup();
    ed.press("C-x 2 C-x 2").unwrap();
    eval(&mut ed, &s, r#"(import("window").then((m) => { globalThis.win = m; }), globalThis.ws = e8.windowList(), "")"#);
    let heights = |ed: &mut Editor| eval(ed, &s, "JSON.stringify(ws.map((w) => e8.windowPixelHeight(w)))");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.windowNewPixel(ws[0]), e8.windowNewTotal(ws[0]), e8.windowNewNormal(ws[0])])"), "[6,6,0.25]");
    eval(&mut ed, &s, r#"(win.windowResizeReset(), "")"#);
    assert_eq!(
        eval(&mut ed, &s, "JSON.stringify([ws.map((w) => e8.windowNewPixel(w)), ws.map((w) => e8.windowNewTotal(w)), ws.map((w) => e8.windowNewNormal(w) ?? null)])"),
        "[[6,6,12],[6,6,12],[null,null,null]]"
    );
    assert_eq!(eval(&mut ed, &s, "(e8.setWindowNewPixel(ws[0], 8), e8.setWindowNewPixel(ws[1], 4), String(e8.windowResizeApply()))"), "true");
    assert_eq!(heights(&mut ed), "[8,4,12]");
    // Sizes that do not add up are not applied.
    assert_eq!(eval(&mut ed, &s, "(win.windowResizeReset(), e8.setWindowNewPixel(ws[0], 2, true), String(e8.windowResizeApply()))"), "false");
    assert_eq!(heights(&mut ed), "[8,4,12]");
    assert_eq!(eval(&mut ed, &s, "String(e8.windowNewPixel(ws[0]))"), "10");
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"(win.windowResizeReset(), e8.setWindowNewPixel(ws[0], 6), e8.setWindowNewPixel(ws[2], 14),
              e8.setWindowNewNormal(ws[0], 0.25), e8.setWindowNewNormal(ws[1], 0.25), e8.setWindowNewNormal(ws[2], 0.5),
              String(e8.windowResizeApply()))"#
        ),
        "true"
    );
    assert_eq!(heights(&mut ed), "[6,4,14]");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ws.map((w) => e8.windowNormalSize(w)))"), "[0.25,0.25,0.5]");
    assert_eq!(eval(&mut ed, &s, "String(e8.windowResizeApplyTotal())"), "true");
}

#[test]
fn window_min_height_is_read_as_a_script_sets_it() {
    let (mut ed, s) = setup();
    ed.press("C-x 2").unwrap();
    // Twelve lines each; with window-min-height 10 the window below cannot give six.
    assert_eq!(eval(&mut ed, &s, r#"(e8.setVariable("window-min-height", 10), String(e8.resizeWindow(undefined, 6)))"#), "2");
}

#[test]
fn new_sizes_are_refused_below_a_line_and_normals_kept_where_none_is_given() {
    // As Emacs 30 in batch: 12 and 12 lines.
    let (mut ed, s) = setup();
    ed.press("C-x 2").unwrap();
    eval(&mut ed, &s, r#"(import("window").then((m) => { globalThis.win = m; }), globalThis.ws = e8.windowList(), "")"#);
    assert_eq!(eval(&mut ed, &s, "(win.windowResizeReset(), e8.setWindowNewPixel(ws[0], 0), e8.setWindowNewPixel(ws[1], 24), String(e8.windowResizeApply()))"), "false");
    assert_eq!(
        eval(&mut ed, &s, r#"e8.conditionCase(() => String(e8.setWindowNewPixel(ws[0], -1)), { "args-out-of-range": () => "out of range" })"#),
        "out of range"
    );
    // A new normal size for one window only: the other keeps its own.
    assert_eq!(
        eval(&mut ed, &s, "(win.windowResizeReset(), e8.setWindowNewPixel(ws[0], 8), e8.setWindowNewPixel(ws[1], 16), e8.setWindowNewNormal(ws[0], 0.1), String(e8.windowResizeApply()))"),
        "true"
    );
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ws.map((w) => e8.windowNormalSize(w)))"), "[0.1,0.5]");
}
