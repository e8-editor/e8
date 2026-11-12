//! window.el's sizing and resizing (ADR 0069, stage 4): window-resize and
//! the functions it is built on, preserved and fixed sizes, the enlarging
//! and shrinking commands, maximize-window and minimize-window, and
//! adjust-window-trailing-edge. Each expectation is what Emacs 30 gives in
//! batch, on an 80 by 24 root window where a pixel is a line or a column.

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
          globalThis.hs = () => JSON.stringify(ws().map((w) => e8.windowTotalHeight(w))),
          globalThis.wd = () => JSON.stringify(ws().map((w) => e8.windowTotalWidth(w))),
          globalThis.three = () => { e8.call("split-window-below"); e8.call("split-window-below"); },
          globalThis.select = (n) => e8.selectWindow(ws()[n]), "")"#,
    );
    (ed, s)
}

/// Presses `keys`, typing a command's name after M-x, and gives the error a command signalled, if one did.
fn press(ed: &mut Editor, keys: &str) -> Option<String> {
    let (keys, command) = match keys.split_once("M-x ") {
        Some((before, command)) => (format!("{before}M-x"), Some(command.trim_end_matches(" RET"))),
        None => (keys.to_string(), None),
    };
    if let Err(e) = ed.press(keys.trim()) {
        return Some(e.message().to_string());
    }
    if let Some(command) = command {
        ed.type_text(command);
        ed.press("RET").unwrap();
    }
    ed.echo().map(str::to_string).filter(|m| !m.is_empty())
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Three windows one above another, 6, 6 and 12 lines, the `n`th selected, then `keys`; the heights after, or the error.
fn three_then(n: usize, keys: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("(three(), select({n}), \"\")"));
    if keys.is_empty() {
        return eval(&mut ed, &s, "hs()");
    }
    press(&mut ed, keys).unwrap_or_else(|| eval(&mut ed, &s, "hs()"))
}

/// Three windows side by side, 20, 20 and 40 columns, the `n`th selected, then `keys`; the widths after, or the error.
fn side_by_side_then(n: usize, keys: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!(r#"(e8.call("split-window-right"), e8.call("split-window-right"), select({n}), "")"#));
    if keys.is_empty() {
        return eval(&mut ed, &s, "wd()");
    }
    press(&mut ed, keys).unwrap_or_else(|| eval(&mut ed, &s, "wd()"))
}

#[test]
fn enlarging_takes_from_the_next_window_or_else_from_all_the_others() {
    assert_eq!(three_then(1, ""), "[6,6,12]");
    assert_eq!(three_then(1, "C-u 2 C-x ^"), "[6,8,10]");
    assert_eq!(three_then(1, "C-u 7 C-x ^"), "[6,13,5]");
    // The window below cannot give nine, so both others do, the larger more.
    assert_eq!(three_then(1, "C-u 9 C-x ^"), "[4,15,5]");
    assert_eq!(three_then(1, "C-u 1 0 C-x ^"), "[4,16,4]");
    assert_eq!(three_then(1, "C-u 1 1 C-x ^"), "Cannot enlarge selected window vertically");
    // The last window takes from the one above it.
    assert_eq!(three_then(2, "C-u 4 C-x ^"), "[4,4,16]");
    assert_eq!(three_then(2, "C-u 5 C-x ^"), "Cannot enlarge selected window vertically");
    assert_eq!(three_then(0, "C-u 5 C-x ^"), "[11,4,9]");
}

#[test]
fn shrinking_gives_to_the_next_window() {
    assert_eq!(three_then(2, "C-u 3 M-x shrink-window RET"), "[6,9,9]");
    assert_eq!(three_then(2, "C-u 8 M-x shrink-window RET"), "[6,14,4]");
    assert_eq!(three_then(2, "C-u 9 M-x shrink-window RET"), "Cannot shrink selected window vertically");
    assert_eq!(three_then(1, "C-u 2 M-x shrink-window RET"), "[6,4,14]");
    assert_eq!(three_then(1, "C-u 3 M-x shrink-window RET"), "Cannot shrink selected window vertically");
}

#[test]
fn a_sole_window_cannot_be_enlarged() {
    let (mut ed, _s) = setup();
    assert_eq!(press(&mut ed, "C-x ^").as_deref(), Some("Cannot enlarge selected window vertically"));
}

#[test]
fn called_from_code_enlarging_goes_as_far_as_it_can() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), select(1), win.enlargeWindow(11), "")"#);
    assert_eq!(eval(&mut ed, &s, "hs()"), "[4,16,4]");
}

#[test]
fn windows_side_by_side_are_resized_by_columns() {
    assert_eq!(side_by_side_then(1, ""), "[20,20,40]");
    assert_eq!(side_by_side_then(1, "C-u 5 C-x }"), "[20,25,35]");
    assert_eq!(side_by_side_then(1, "C-u 1 5 C-x }"), "[20,35,25]");
    assert_eq!(side_by_side_then(2, "C-u 3 C-x {"), "[20,23,37]");
    assert_eq!(side_by_side_then(1, "C-u 1 1 C-x {"), "Cannot shrink selected window horizontally");
}

#[test]
fn how_far_windows_can_be_resized() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), "")"#);
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"((w) => JSON.stringify([win.windowResizable(w, 20), win.windowResizable(w, -20), win.windowResizable(w, 5, true),
              win.windowMinDelta(w), win.windowMaxDelta(w), win.windowMinDelta(ws()[2]), win.windowMaxDelta(ws()[0]),
              win.windowResizableP(w, 10), win.windowResizableP(w, 11), win.windowMinSize(w), win.windowMinSize(w, true),
              win.windowMinSize(e8.frameRootWindow()), win.windowMinSize(w, false, "safe"), win.windowMinSize(w, false, true),
              win.windowSizable(w, -5), win.windowSizable(w, 5), win.windowResizable(w, -20, false, "safe")]))(ws()[1])"#
        ),
        "[10,-2,0,2,10,8,10,true,false,4,10,12,1,2,-2,5,-5]"
    );
    // Across a combination, the most any of its windows needs.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("split-window-right"), e8.call("split-window-below"), "")"#);
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"JSON.stringify([win.windowMinSize(e8.frameRootWindow(), true), win.windowMinSize(e8.frameRootWindow()), win.windowMaxDelta(ws()[0], true)])"#
        ),
        "[20,8,30]"
    );
}

#[test]
fn a_preserved_size_is_kept_while_another_window_can_give() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), win.windowPreserveSize(ws()[2], false, true), select(1), "")"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([win.windowPreservedSize(ws()[2]), win.windowSizeFixedP(ws()[2])])"), "[11,true]");
    ed.press("C-u 2 C-x ^").unwrap();
    assert_eq!(eval(&mut ed, &s, "hs()"), "[4,8,12]");
    // When it is the only one that can, it gives, and still says what it kept.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), win.windowPreserveSize(ws()[2], false, true), select(1), "")"#);
    ed.press("C-u 5 C-x ^").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([hs(), win.windowPreservedSize(ws()[2])])"), r#"["[6,11,7]",11]"#);
}

#[test]
fn enlarging_a_window_stops_preserving_its_size() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), select(1), win.windowPreserveSize(undefined, false, true), "")"#);
    assert_eq!(eval(&mut ed, &s, "String(win.windowPreservedSize())"), "5");
    ed.press("C-u 2 C-x ^").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([hs(), win.windowPreservedSize() ?? null])"), r#"["[6,8,10]",null]"#);
}

#[test]
fn display_buffer_preserves_the_sizes_preserve_size_says() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"((w) => JSON.stringify([win.windowPreservedSize(w, true) ?? null, win.windowPreservedSize(w) ?? null]))(
            win.displayBuffer(e8.getBufferCreate("other"), ["display-buffer-pop-up-window", ["preserve-size", [null, true]]]))"#,
    );
    assert_eq!(got, "[null,11]");
}

#[test]
fn window_size_fixed_keeps_a_buffers_windows_as_they_are() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(three(), e8.getBufferCreate("fix"), e8.setWindowBuffer(ws()[2], "fix"),
          e8.withCurrentBuffer("fix", () => e8.setVariable("window-size-fixed", true)), select(1), "")"#,
    );
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([win.windowSizeFixedP(ws()[2]), win.windowMaxDelta()])"), "[true,2]");
    ed.press("C-u 2 C-x ^").unwrap();
    assert_eq!(eval(&mut ed, &s, "hs()"), "[4,8,12]");
    // Only its height, with height; and the selected window's is an error.
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(three(), select(1), e8.getBufferCreate("fix"), e8.setWindowBuffer(undefined, "fix"),
          e8.withCurrentBuffer("fix", () => e8.setVariable("window-size-fixed", "height")), "")"#,
    );
    assert_eq!(eval(&mut ed, &s, "String(win.windowSizeFixedP(undefined, true))"), "false");
    assert_eq!(press(&mut ed, "C-u 2 C-x ^").as_deref(), Some("Selected window has fixed size"));
}

#[test]
fn maximizing_and_minimizing() {
    assert_eq!(three_then(1, "M-x maximize-window RET"), "[4,16,4]");
    assert_eq!(three_then(1, "M-x minimize-window RET"), "[6,4,14]");
    assert_eq!(three_then(2, "M-x minimize-window RET"), "[6,14,4]");
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("split-window-right"), e8.call("split-window-below"), win.maximizeWindow(), "")"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([hs(), wd()])"), r#"["[20,4,24]","[70,70,10]"]"#);
}

#[test]
fn moving_a_windows_trailing_edge() {
    let after = |n: usize, delta: i64| {
        let (mut ed, s) = setup();
        eval(&mut ed, &s, "(three(), \"\")");
        let got = s.eval_expression(&mut ed, &format!("(win.adjustWindowTrailingEdge(ws()[{n}], {delta}), hs())"));
        match got {
            Ok(v) => serde_json::from_str::<String>(&v).unwrap(),
            Err(e) => e.to_string(),
        }
    };
    // The edge is moved: the window just past it gives what it can, the ones beyond it the rest.
    assert_eq!(after(0, 3), "[9,5,10]");
    assert_eq!(after(0, 6), "[12,4,8]");
    assert_eq!(after(0, 12), "[16,4,4]");
    assert_eq!(after(1, -3), "[5,4,15]");
    assert_eq!(after(1, -5), "[4,4,16]");
    assert!(after(2, 1).contains("No window below this one"), "{}", after(2, 1));
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("split-window-right"), e8.call("split-window-below"), win.adjustWindowTrailingEdge(ws()[0], 5, true), "")"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([hs(), wd()])"), r#"["[12,12,24]","[45,45,35]"]"#);
}

#[test]
fn an_internal_window_is_resized_with_its_children() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("split-window-below"), e8.call("split-window-right"), win.windowResize(e8.windowParent(e8.selectedWindow()), 3), "")"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([hs(), wd()])"), r#"["[15,15,9]","[40,40,80]"]"#);
    // Across the root window there is nothing to take from.
    let err = s
        .eval_expression(&mut ed, r#"win.windowResize(e8.windowParent(e8.selectedWindow()), 3, true)"#)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Cannot resize window"), "{err}");
}

#[test]
fn what_cannot_be_resized_is_an_error() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), "")"#);
    let err = |ed: &mut Editor, code: &str| s.eval_expression(ed, code).unwrap_err().to_string();
    assert!(err(&mut ed, "win.windowResize(e8.frameRootWindow(), 3)").contains("Cannot resize the root window of a frame"));
    assert!(err(&mut ed, "win.windowResize(ws()[1], 30)").contains("Cannot resize window"));
    // window-resize-no-error leaves what it cannot do.
    eval(&mut ed, &s, r#"(win.windowResizeNoError(ws()[1], 30), win.windowResizeNoError(ws()[1], 3), "")"#);
    assert_eq!(eval(&mut ed, &s, "hs()"), "[6,9,9]");
}

#[test]
fn window_combination_resize_shares_among_all_the_others() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), select(1), e8.setVariable("window-combination-resize", true), "")"#);
    ed.press("C-u 4 C-x ^").unwrap();
    assert_eq!(eval(&mut ed, &s, "hs()"), "[5,10,9]");
}

#[test]
fn normal_sizes_follow_the_new_sizes() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(three(), select(1), "")"#);
    ed.press("C-u 9 C-x ^").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ws().map((w) => e8.windowNormalSize(w)))"), "[0.125,0.625,0.25]");
}

#[test]
fn resizing_inside_a_combination_resizes_the_windows_across_it() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(e8.call("split-window-right"), e8.call("split-window-below"), select(2), e8.call("split-window-below"), select(1), "")"#,
    );
    ed.press("C-u 6 C-x }").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([hs(), wd()])"), r#"["[12,12,12,12]","[46,46,34,34]"]"#);
}

#[test]
fn full_height_windows() {
    let (mut ed, s) = setup();
    assert_eq!(
        eval(&mut ed, &s, r#"(e8.call("split-window-right"), JSON.stringify([win.windowFullHeightP(), (e8.call("split-window-below"), win.windowFullHeightP())]))"#),
        "[true,false]"
    );
}
