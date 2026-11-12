//! window.el's splitting and deleting (ADR 0069, stage 4): split-window
//! and the commands on it, delete-window, delete-other-windows,
//! other-window, delete-windows-on, atomic windows and hiding side
//! windows. Each expectation is what Emacs 30 gives in batch, on an 80 by
//! 24 root window where a pixel is a line or a column, the windows listed
//! from the frame's first as `[height, width]`.

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
          globalThis.sz = () => ws().map((w) => [e8.windowTotalHeight(w), e8.windowTotalWidth(w)]),
          globalThis.idx = (w) => ws().indexOf(w),
          globalThis.bufs = () => ws().map((w) => e8.windowBuffer(w)),
          globalThis.split = (w, size, side) => win.splitWindow(w, size, side),
          globalThis.last = () => ws()[ws().length - 1],
          globalThis.param = (name) => ws().map((w) => e8.windowParameter(w, name) ?? null),
          globalThis.sel = (...ns) => ns.forEach((n) => e8.selectWindow(ws()[n])),
          globalThis.side = (buffer, alist) => e8.funcall("display-buffer-in-side-window", e8.getBufferCreate(buffer), alist),
          globalThis.err = (f) => e8.conditionCase(() => (f(), "no error"), { error: (e) => e.message }), "")"#,
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Runs `code` on a new frame of one window and gives what it gives, as JSON.
fn after(code: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("JSON.stringify({code})"))
}

#[test]
fn split_window_takes_a_size_and_a_side() {
    assert_eq!(after("(split(null, 10), sz())"), "[[10,80],[14,80]]");
    assert_eq!(after("(split(null, -5), sz())"), "[[19,80],[5,80]]");
    // A new window above or on the left comes first; the selected window stays selected.
    assert_eq!(after(r#"((n) => [sz(), idx(n), idx(e8.selectedWindow())])(split(null, 10, "above"))"#), "[[[14,80],[10,80]],0,1]");
    assert_eq!(after(r#"((n) => [sz(), idx(n), idx(e8.selectedWindow())])(split(null, 30, "left"))"#), "[[[24,50],[24,30]],0,1]");
    assert_eq!(after(r#"((n) => [sz(), idx(n)])(split(null, -20, "right"))"#), "[[[24,60],[24,20]],1]");
    // Any other non-nil side is right, as t is.
    assert_eq!(after("((n) => [sz(), idx(n)])(split(null, null, true))"), "[[[24,40],[24,40]],1]");
    assert_eq!(after("(split(), err(() => split(ws()[0], 24)))"), r#""Window #<window 1 on *scratch*> too small for splitting""#);
}

#[test]
fn splitting_an_internal_window_splits_all_it_holds() {
    // Beside a column of two, the new window showing the selected window's buffer.
    assert_eq!(
        after(r#"(split(), split(null, null, "right"), ((n) => [sz(), idx(n), e8.windowBuffer(n)])(split(e8.windowParent(e8.selectedWindow()), null, "right")))"#),
        r#"[[[12,20],[12,20],[12,40],[12,80]],2,"*scratch*"]"#
    );
    assert_eq!(
        after(r#"(split(null, null, "right"), split(), ((n) => [sz(), idx(n)])(split(e8.windowParent(e8.selectedWindow()), -8)))"#),
        "[[[8,40],[8,40],[8,40],[24,40]],2]"
    );
}

#[test]
fn window_combination_resize_shares_the_space() {
    // Each split takes from all the windows in the combination.
    assert_eq!(after(r#"e8.letBind({ "window-combination-resize": true }, () => (split(), split(), split(), sz()))"#), "[[6,80],[6,80],[6,80],[6,80]]");
    assert_eq!(after("(split(), split(last()), sz())"), "[[12,80],[6,80],[6,80]]");
    // A size makes a window of its own, nested.
    assert_eq!(
        after(r#"e8.letBind({ "window-combination-resize": true }, () => (split(), ((n) => [sz(), e8.windowParent(n) === e8.windowParent(last())])(split(null, 4))))"#),
        "[[[4,80],[8,80],[12,80]],false]"
    );
    // Deleting gives the space to the window before, or to all with window-combination-resize t.
    let three = r#"e8.letBind({ "window-combination-resize": true }, () => (split(), split()))"#;
    assert_eq!(after(&format!("({three}, sz())")), "[[8,80],[8,80],[8,80]]");
    assert_eq!(after(&format!("({three}, win.deleteWindow(ws()[1]), sz())")), "[[16,80],[8,80]]");
    assert_eq!(
        after(&format!(r#"({three}, e8.letBind({{ "window-combination-resize": true }}, () => win.deleteWindow(ws()[1])), sz())"#)),
        "[[12,80],[12,80]]"
    );
    assert_eq!(after("(split(), split(), win.deleteWindow(ws()[0]), sz())"), "[[12,80],[12,80]]");
}

#[test]
fn window_combination_resize_side_makes_side_windows() {
    assert_eq!(
        after(
            r#"((w) => (e8.setWindowParameter(w, "window-side", "bottom"),
                 e8.letBind({ "window-combination-resize": "side" }, () => ((n) => [sz(), e8.windowParameter(n, "window-side"), e8.windowParameter(e8.windowParent(n), "window-side")])(split(w, null, "right")))))(split(null, -6))"#
        ),
        r#"[[[18,80],[6,40],[6,40]],"bottom","bottom"]"#
    );
    assert_eq!(
        after(r#"((w) => (e8.setWindowParameter(w, "window-side", "bottom"), err(() => split(w, null, "right"))))(split(null, -6))"#),
        r#""Cannot split side window or parent of side window""#
    );
}

#[test]
fn window_combination_limit_nests_a_new_internal_window() {
    assert_eq!(
        after(
            r#"(split(), ((n) => [sz(), e8.windowCombinationLimit(e8.windowParent(n)), e8.windowParent(n) === e8.windowParent(last()), (win.deleteWindow(n), sz())])(e8.letBind({ "window-combination-limit": true }, () => split(ws()[0]))))"#
        ),
        "[[[6,80],[6,80],[12,80]],true,false,[[12,80],[12,80]]]"
    );
}

#[test]
fn split_window_below_and_right_by_keys() {
    let (mut ed, s) = setup();
    ed.press("C-u - 3 C-x 2").unwrap();
    assert_eq!(ed.echo(), Some("Size of new window too small"));
    ed.press("C-u - 9 C-x 3").unwrap();
    assert_eq!(ed.echo(), Some("Size of new window too small"));
    ed.press("C-u - 5 C-x w 2").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(sz())"), "[[19,80],[5,80]]");
}

#[test]
fn split_window_keep_point_nil_scrolls_neither_window() {
    // A buffer of a hundred short lines, point at `point`; the new window's
    // start and point, the old window's point and which is selected. E8's
    // positions start at 0, Emacs's at 1.
    let run = |point: usize, keep: bool| {
        let (mut ed, s) = setup();
        eval(
            &mut ed,
            &s,
            &format!(
                r#"(e8.withCurrentBuffer(e8.getBufferCreate("lines"), () => e8.insert(Array.from({{ length: 100 }}, (_, i) => `${{i + 1}}\n`).join(""))),
                  e8.setWindowBuffer(e8.selectedWindow(), "lines"), e8.gotoChar({point}), "")"#
            ),
        );
        eval(
            &mut ed,
            &s,
            &format!(
                r#"JSON.stringify(e8.letBind({{ "split-window-keep-point": {keep} }}, () => ((n) => [e8.windowStart(n), e8.windowPoint(n), e8.windowPoint(ws()[0]), idx(e8.selectedWindow())])(win.splitWindowBelow())))"#
            ),
        )
    };
    // Point above the new window's start, on the third line, stays; below
    // it, on the sixteenth, it goes to the new window, selected.
    assert_eq!(run(4, false), "[27,27,4,0]");
    assert_eq!(run(36, false), "[27,36,23,1]");
    assert_eq!(run(36, true), "[0,36,36,0]");
}

#[test]
fn deleting_the_selected_window_chooses_another() {
    // The top left, top right and bottom windows, used in that order.
    let three = r#"(split(), split(ws()[0], null, "right"), sel(0, 1, 2))"#;
    let choose = |value: &str, extra: &str| {
        after(&format!(r#"({three}, {extra} e8.letBind({{ "delete-window-choose-selected": {value} }}, () => win.deleteWindow()), idx(e8.selectedWindow()))"#))
    };
    assert_eq!(choose(r#""mru""#, ""), "1");
    assert_eq!(choose("null", ""), "0");
    // Not one with a no-other-window parameter, while there are others.
    let no_other = r#"e8.setWindowParameter(ws()[0], "no-other-window", true),"#;
    assert_eq!(choose("null", no_other), "1");
    assert_eq!(choose(r#""mru""#, no_other), "1");
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "err(() => win.deleteWindow())"), "Attempt to delete minibuffer or sole ordinary window");
}

#[test]
fn side_windows_and_the_main_window() {
    let shown = r#"globalThis.s = side("side", [["side", "bottom"]])"#;
    assert_eq!(after(&format!("({shown}, [sz(), idx(s)])")), "[[[18,80],[6,80]],1]");
    // The main window cannot be deleted, nor a side window fill the frame.
    let deleted = after(&format!("({shown}, err(() => win.deleteWindow(ws()[0])))"));
    assert!(deleted.starts_with(r#""Attempt to delete main window of frame"#), "{deleted}");
    assert_eq!(after(&format!("({shown}, e8.selectWindow(s), err(() => win.deleteOtherWindows()))")), r#""Cannot make side window the only window""#);
    // delete-other-windows in the main window deletes the side windows too.
    assert_eq!(after(&format!("({shown}, split(ws()[0]), [sz(), (win.deleteOtherWindows(), sz())])")), "[[[9,80],[9,80],[6,80]],[[24,80]]]");
    assert_eq!(after(&format!("({shown}, win.deleteWindow(s), sz())")), "[[24,80]]");
    // Unless it has a no-delete-other-windows parameter: the main window fills the rest.
    assert_eq!(
        after(
            r#"(side("side", [["side", "bottom"], ["window-parameters", ["no-delete-other-windows", true]]]), split(ws()[0], null, "right"),
                [sz(), (win.deleteOtherWindows(), sz()), bufs()])"#
        ),
        r#"[[[18,40],[18,40],[6,80]],[[18,80],[6,80]],["*scratch*","side"]]"#
    );
}

#[test]
fn delete_other_windows_keeps_windows_that_ask_to_stay() {
    assert_eq!(
        after(r#"(split(), split(last()), e8.setWindowParameter(ws()[1], "no-delete-other-windows", true), e8.selectWindow(last()), e8.call("delete-other-windows"), [sz(), idx(e8.selectedWindow())])"#),
        "[[[18,80],[6,80]],1]"
    );
    // A delete-other-windows parameter is a function to call instead.
    assert_eq!(
        after(r#"(split(), e8.setWindowParameter(e8.selectedWindow(), "delete-other-windows", (w) => { globalThis.called = idx(w); }), e8.call("delete-other-windows"), [sz(), called])"#),
        "[[[12,80],[12,80]],0]"
    );
}

#[test]
fn delete_other_windows_vertically_keeps_the_column() {
    assert_eq!(
        after(r#"(split(null, null, "right"), split(), split(last()), e8.selectWindow(ws()[0]), e8.call("delete-other-windows-vertically"), sz())"#),
        "[[24,40],[12,40],[12,40]]"
    );
}

#[test]
fn atomic_windows_split_and_delete_as_one() {
    let atom = r#"split(null, null, "right"), globalThis.n = e8.funcall("display-buffer-in-atom-window", e8.getBufferCreate("x"), [["window", ws()[0]], ["side", "below"]])"#;
    assert_eq!(
        after(&format!("({atom}, [sz(), idx(n), param(\"window-atom\"), e8.windowParameter(e8.windowParent(n), \"window-atom\"), win.windowAtomRoot(n) === e8.windowParent(n)])")),
        r#"[[[12,40],[12,40],[24,40]],1,["main","below",null],true,true]"#
    );
    // Splitting a part splits the atomic window; the new window is not part of it.
    assert_eq!(after(&format!("({atom}, ((m) => [sz(), idx(m), e8.windowParameter(m, \"window-atom\") ?? null])(split(n)))")), "[[[6,40],[6,40],[12,40],[24,40]],2,null]");
    assert_eq!(after(&format!("({atom}, win.deleteWindow(n), [sz(), bufs()])")), r#"[[[24,80]],["*scratch*"]]"#);
    assert_eq!(after(&format!("({atom}, win.deleteOtherWindows(n), [sz(), bufs()])")), r#"[[[12,80],[12,80]],["*scratch*","x"]]"#);
    // An atomic window filling the frame cannot be deleted.
    assert_eq!(
        after(r#"((n) => [sz(), err(() => win.deleteWindow(n))])(e8.funcall("display-buffer-in-atom-window", e8.getBufferCreate("x"), [["side", "right"]]))"#),
        r#"[[[24,40],[24,40]],"Root of atomic window is root window of its frame"]"#
    );
    assert_eq!(after("err(() => win.windowMakeAtom(e8.selectedWindow()))"), r#""Window #<window 1 on *scratch*> is not an internal window""#);
    assert_eq!(after("(split(), split(), win.windowMakeAtom(e8.frameRootWindow()), err(() => win.deleteWindow(ws()[0])))"), r#""Root of atomic window is root window of its frame""#);
    // An atomic window left with one window is one no more.
    assert_eq!(
        after(
            r#"(split(), split(ws()[0], null, "right"), win.windowMakeAtom(e8.windowParent(ws()[0])),
                e8.letBind({ "ignore-window-parameters": true }, () => win.deleteWindow(ws()[1])), win.deleteWindow(ws()[1]), [sz(), param("window-atom")])"#
        ),
        "[[[24,80]],[null]]"
    );
}

#[test]
fn toggling_side_windows_hides_and_shows_them() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(side("side", [["side", "bottom"]]), side("x", [["side", "left"]]), "")"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([sz(), bufs()])"), r#"[[[18,20],[18,60],[6,80]],["x","*scratch*","side"]]"#);
    ed.press("M-x").unwrap();
    ed.type_text("window-toggle-side-windows");
    ed.press("RET").unwrap();
    assert_eq!(
        eval(&mut ed, &s, r#"JSON.stringify([sz(), bufs(), !!e8.frameParameter(undefined, "window-state")])"#),
        r#"[[[24,80]],["*scratch*"],true]"#
    );
    // Shown again around the main window as it is now.
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"(split(null, null, "right"), win.windowToggleSideWindows(),
               JSON.stringify([sz(), bufs(), param("window-side"), ws().map((w) => e8.windowDedicatedP(w) ?? null)]))"#
        ),
        r#"[[[18,20],[18,30],[18,30],[6,80]],["x","*scratch*","*scratch*","side"],["left",null,null,"bottom"],["side",null,null,"side"]]"#
    );
    assert_eq!(after("err(() => win.windowToggleSideWindows())"), r#""No side windows state found""#);
}

#[test]
fn other_window_passes_over_windows_that_ask_it_to() {
    let four = r#"e8.letBind({ "window-combination-resize": true }, () => (split(), split(), split())), e8.setWindowParameter(ws()[1], "no-other-window", true), e8.selectWindow(ws()[0])"#;
    assert_eq!(
        after(&format!(
            "({four}, [1, -1, -1, -2, 5].map((n) => (win.otherWindow(n), idx(e8.selectedWindow()))))"
        )),
        "[2,0,3,0,3]"
    );
    // With no other window to go to, the selected one stays.
    assert_eq!(
        after(r#"(split(), e8.setWindowParameter(ws()[1], "no-other-window", true), [1, -3].map((n) => (win.otherWindow(n), idx(e8.selectedWindow()))))"#),
        "[0,0]"
    );
    // An other-window parameter is a function to call instead.
    assert_eq!(
        after(r#"(split(), e8.setWindowParameter(e8.selectedWindow(), "other-window", (c, a) => { globalThis.called = [c, a]; }), win.otherWindow(2), [called, idx(e8.selectedWindow())])"#),
        "[[2,null],0]"
    );
    // By keys, a prefix argument counting.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("({four}, \"\")"));
    ed.press("C-u - 2 C-x o").unwrap();
    assert_eq!(eval(&mut ed, &s, "String(idx(e8.selectedWindow()))"), "2");
    assert_eq!(after("[win.oneWindowP(), (split(), win.oneWindowP())]"), "[true,false]");
}

#[test]
fn delete_windows_on_deletes_those_it_can() {
    assert_eq!(
        after(r#"(split(), split(last()), e8.setWindowBuffer(ws()[1], e8.getBufferCreate("x").name), e8.setWindowBuffer(ws()[2], "x"), win.deleteWindowsOn("x"), [sz(), bufs()])"#),
        r#"[[[24,80]],["*scratch*"]]"#
    );
    // The only window shows another buffer instead.
    assert_eq!(
        after(r#"(e8.setWindowBuffer(e8.selectedWindow(), e8.getBufferCreate("x").name), e8.call("delete-windows-on", "x"), [sz(), bufs()])"#),
        r#"[[[24,80]],["*scratch*"]]"#
    );
}

