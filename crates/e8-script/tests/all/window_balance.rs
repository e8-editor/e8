//! window.el's balancing and fitting (ADR 0069, stage 4): balance-windows,
//! balance-windows-area, fit-window-to-buffer, count-screen-lines and
//! shrink-window-if-larger-than-buffer. Each expectation is what Emacs 30
//! gives in batch, on an 80 by 24 root window where a pixel is a line or a
//! column, the windows listed from the frame's first as `[height, width]`.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    s.eval_typescript(&mut ed, "load.ts", r#"import("window").then((m) => { globalThis.win = m; });"#.into()).unwrap();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.ws = () => e8.windowList(),
          globalThis.sz = () => JSON.stringify(ws().map((w) => [e8.windowTotalHeight(w), e8.windowTotalWidth(w)])),
          globalThis.below = () => e8.call("split-window-below"),
          globalThis.right = () => e8.call("split-window-right"),
          globalThis.fill = (w, text) => {
            e8.withCurrentBuffer(e8.getBufferCreate("f"), () => { e8.deleteRegion(e8.pointMin(), e8.pointMax()); e8.insert(text); e8.gotoChar(e8.pointMin()); });
            e8.setWindowBuffer(w, "f");
          },
          globalThis.fixed = (w, value) => {
            e8.withCurrentBuffer(e8.getBufferCreate("f"), () => { e8.makeLocalVariable("window-size-fixed"); e8.setVariable("window-size-fixed", value); });
            e8.setWindowBuffer(w, "f");
          },
          globalThis.lines = (n) => Array.from({ length: n }, (_, i) => String(i + 1)).join("\n"), "")"#,
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Runs `code` on a new frame of one window, then gives each window's size.
fn after(code: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("({code}, sz())"))
}

#[test]
fn balancing_makes_nested_combinations_even() {
    // A column of three beside a window, the column 5 wider.
    let column = "(right(), below(), below(), win.windowResize(ws()[0], 5, true))";
    assert_eq!(after(column), "[[6,45],[6,45],[12,45],[24,35]]");
    assert_eq!(after(&format!("({column}, e8.call(\"balance-windows\"))")), "[[8,40],[8,40],[8,40],[24,40]]");
    // Only the column's windows, given its window.
    assert_eq!(after(&format!("({column}, win.balanceWindows(e8.windowParent(ws()[0])))")), "[[8,45],[8,45],[8,45],[24,35]]");
    // A row of windows above one, its middle window split again; 80 columns among three.
    let row = "(below(), right(), right(), e8.selectWindow(ws()[3]), right(), win.enlargeWindow(3))";
    assert_eq!(after(row), "[[9,20],[9,20],[9,40],[15,40],[15,40]]");
    assert_eq!(after(&format!("({row}, win.balanceWindows())")), "[[12,27],[12,27],[12,26],[12,40],[12,40]]");
}

#[test]
fn balancing_a_frame_and_by_keys() {
    assert_eq!(after("(below(), below(), win.balanceWindows(e8.selectedFrame()))"), "[[8,80],[8,80],[8,80]]");
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x 3 C-x 3 C-x +").unwrap();
    assert_eq!(eval(&mut ed, &s, "sz()"), "[[24,20],[24,20],[24,20],[24,20]]");
    assert_eq!(eval(&mut ed, &s, r#"(e8.conditionCase(() => win.balanceWindows("x"), { error: (e) => e.message }))"#), "Not a window or frame x");
}

#[test]
fn balancing_keeps_fixed_and_preserved_sizes() {
    assert_eq!(after("(below(), below(), win.windowPreserveSize(ws()[0], false, true), win.balanceWindows())"), "[[6,80],[9,80],[9,80]]");
    assert_eq!(after(r#"(below(), below(), win.windowResize(ws()[0], 4), fixed(ws()[0], true), win.balanceWindows())"#), "[[10,80],[7,80],[7,80]]");
    assert_eq!(
        after(r#"(right(), right(), win.windowResize(ws()[0], 4, true), fixed(ws()[0], Symbol.for("width")), win.balanceWindows())"#),
        "[[24,24],[24,28],[24,28]]"
    );
}

#[test]
fn balancing_areas() {
    assert_eq!(after("(right(), below(), below(), e8.call(\"balance-windows-area\"))"), "[[8,60],[8,60],[8,60],[24,20]]");
    assert_eq!(after("(below(), right(), right(), win.balanceWindowsArea())"), "[[18,26],[18,27],[18,27],[6,80]]");
    // window-area-factor counts a buffer's windows twice as big.
    assert_eq!(
        after(
            r#"(below(), e8.withCurrentBuffer(e8.getBufferCreate("f"), () => e8.setVariable("window-area-factor", 2)), e8.setWindowBuffer(ws()[0], "f"), win.balanceWindowsArea())"#
        ),
        "[[8,80],[16,80]]"
    );
    // A window whose buffer fixes its size is left out.
    assert_eq!(after("(right(), below(), fixed(ws()[0], true), win.balanceWindowsArea())"), "[[12,40],[12,40],[24,40]]");
}

#[test]
fn fitting_heights_between_limits() {
    // The new window below, given the text, then fitted.
    let fit = |text: &str, args: &str| after(&format!("((w) => (fill(w, {text}), win.fitWindowToBuffer(w{args})))(e8.splitWindow())"));
    assert_eq!(fit("lines(10)", ", 5"), "[[19,80],[5,80]]");
    assert_eq!(fit(r#""1\n2""#, ", null, 8"), "[[16,80],[8,80]]");
    // MIN-HEIGHT no less than a line, with the mode line besides.
    assert_eq!(fit(r#""1""#, ", null, 1"), "[[22,80],[2,80]]");
    // Trailing blank lines are not counted, leading ones are.
    assert_eq!(fit(r#""a\nb\nc\nd\ne\n\n  \n\n""#, ""), "[[18,80],[6,80]]");
    assert_eq!(fit(r#""\n\n\na\nb\nc\nd\ne""#, ""), "[[15,80],[9,80]]");
    // A long line counts the screen lines it wraps to.
    assert_eq!(fit(r#""x".repeat(200) + "\nab""#, ""), "[[19,80],[5,80]]");
    // The windows around give what they can.
    assert_eq!(after("(below(), below(), fill(ws()[0], lines(15)), win.fitWindowToBuffer(ws()[0]))"), "[[16,80],[4,80],[4,80]]");
    // Called as Lisp calls it.
    assert_eq!(after(r#"((w) => (fill(w, lines(10)), e8.funcall("fit-window-to-buffer", w, 5)))(e8.splitWindow())"#), "[[19,80],[5,80]]");
}

#[test]
fn a_window_alone_in_its_column_is_not_fitted() {
    assert_eq!(after(r#"(fill(ws()[0], "1\n2"), win.fitWindowToBuffer())"#), "[[24,80]]");
    assert_eq!(after(r#"(right(), fill(ws()[0], "1\n2"), win.fitWindowToBuffer())"#), "[[24,40],[24,40]]");
}

#[test]
fn fitting_can_preserve_the_size() {
    assert_eq!(
        after("(below(), below(), fill(ws()[0], lines(8)), win.fitWindowToBuffer(ws()[0], null, null, null, null, true), win.balanceWindows())"),
        "[[10,80],[7,80],[7,80]]"
    );
    assert_eq!(eval_after("(below(), fill(ws()[0], lines(8)), win.fitWindowToBuffer(ws()[0], null, null, null, null, true), String(win.windowPreservedSize(ws()[0])))"), "8");
}

fn eval_after(code: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, code)
}

#[test]
fn fitting_widths_with_fit_window_to_buffer_horizontally() {
    let fit = |horizontally: &str, setup: &str, text: &str, args: &str| {
        after(&format!(
            r#"(e8.setVariable("fit-window-to-buffer-horizontally", {horizontally}), {setup}, fill(e8.selectedWindow(), {text}), win.fitWindowToBuffer(undefined{args}))"#
        ))
    };
    let two = r#""abc\ndefghijklmnopqrstuvw""#;
    assert_eq!(fit("null", "right()", two, ""), "[[24,40],[24,40]]");
    // The widest line, 20 columns, and the divider.
    assert_eq!(fit("true", "right()", two, ""), "[[24,21],[24,59]]");
    assert_eq!(fit("true", "right()", r#""abc""#, ", null, null, null, 15"), "[[24,15],[24,65]]");
    assert_eq!(fit("true", "right()", r#""y".repeat(70)"#, ", null, null, 50"), "[[24,50],[24,30]]");
    assert_eq!(fit("true", "right()", r#""y".repeat(70)"#, ""), "[[24,70],[24,10]]");
    // A window one above another is fitted in height.
    assert_eq!(fit("true", "(right(), below())", two, ""), "[[4,40],[20,40],[24,40]]");
    // With `only', never in height.
    assert_eq!(fit(r#"Symbol.for("only")"#, "(right(), below())", two, ""), "[[12,40],[12,40],[24,40]]");
    assert_eq!(fit(r#"Symbol.for("only")"#, "below()", two, ""), "[[12,80],[12,80]]");
    // The lines from the window's start, down to the one below its last.
    assert_eq!(
        after(
            r#"(e8.setVariable("fit-window-to-buffer-horizontally", true), right(), fill(e8.selectedWindow(), "y".repeat(50) + "\nab"), e8.setWindowStart(undefined, 52), win.fitWindowToBuffer())"#
        ),
        "[[24,10],[24,70]]"
    );
    assert_eq!(
        fit("true", "right()", r#"Array(23).fill("ab").join("\n") + "\n" + "z".repeat(30) + "\n" + "q".repeat(50)"#, ""),
        "[[24,31],[24,49]]"
    );
}

#[test]
fn shrinking_a_window_larger_than_its_buffer() {
    // As fit-window-to-buffer no taller than the window is.
    assert_eq!(after(r#"(below(), fill(ws()[0], lines(6)), e8.call("shrink-window-if-larger-than-buffer"))"#), "[[7,80],[17,80]]");
    assert_eq!(after(r#"(below(), fill(ws()[0], lines(15)), e8.call("shrink-window-if-larger-than-buffer"))"#), "[[12,80],[12,80]]");
    assert_eq!(after(r#"((w) => (fill(w, "1\n2"), win.shrinkWindowIfLargerThanBuffer(w)))(e8.splitWindow())"#), "[[20,80],[4,80]]");
    assert_eq!(after(r#"(fill(ws()[0], "1"), e8.call("shrink-window-if-larger-than-buffer"))"#), "[[24,80]]");
    // Nor when the start of the buffer is scrolled out of sight.
    assert_eq!(after(r#"(below(), fill(ws()[0], lines(6)), e8.setWindowStart(ws()[0], 3), e8.call("shrink-window-if-larger-than-buffer"))"#), "[[12,80],[12,80]]");
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(below(), fill(ws()[0], lines(6)), "")"#);
    ed.press("C-x -").unwrap();
    assert_eq!(eval(&mut ed, &s, "sz()"), "[[7,80],[17,80]]");
}

#[test]
fn screen_lines_count_wrapped_rows() {
    assert_eq!(
        eval_after(
            r#"(fill(ws()[0], "x".repeat(200) + "\nab\n"), e8.withCurrentBuffer("f", () => JSON.stringify([win.countScreenLines(), win.countScreenLines(null, null, true), win.windowBufferHeight(ws()[0])])))"#
        ),
        "[4,5,4]"
    );
}
