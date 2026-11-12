//! display-buffer as window.el has it (ADR 0069, stage 2): the actions of
//! display-buffer-alist and the caller, the action functions, side windows
//! and the alist entries that size and mark the windows they use. Each
//! expectation is what Emacs 30 gives on an 80 by 25 frame, its tops one
//! less as E8 has no menu bar.

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
        r#"(["a", "b", "c", "main"].forEach((b) => e8.getBufferCreate(b)), e8.call("switch-to-buffer", "main"),
          globalThis.show = () => JSON.stringify(e8.windowList().map((w) => [e8.windowBuffer(w), e8.windowEdges(w),
            e8.windowParameter(w, "window-side") ?? null, e8.windowParameter(w, "window-slot") ?? null,
            e8.windowDedicatedP(w) ?? null, w === e8.selectedWindow()])),
          globalThis.layout = () => JSON.stringify(e8.windowList().map((w) => [e8.windowBuffer(w), e8.windowEdges(w),
            e8.windowParameter(w, "window-side") ?? null, e8.windowParameter(w, "window-slot") ?? null])),
          ["x"].forEach((b) => e8.getBufferCreate(b)), "")"#,
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Runs `code`, then gives the windows as show() lists them.
fn after(code: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("({code}, show())"))
}

#[test]
fn with_no_actions_a_window_is_split_off_below() {
    assert_eq!(
        after(r#"e8.call("display-buffer", "a")"#),
        r#"[["main",[0,0,80,12],null,null,null,true],["a",[0,12,80,24],null,null,null,false]]"#
    );
}

#[test]
fn display_buffer_alist_puts_a_buffer_in_a_side_window_with_its_width() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(e8.setVariable("display-buffer-alist", [["^a$", "display-buffer-in-side-window", ["side", "right"], ["window-width", 20]]]),
          e8.call("display-buffer", "a"), "")"#,
    );
    assert_eq!(
        eval(&mut ed, &s, "show()"),
        r#"[["main",[0,0,60,24],null,null,null,true],["a",[60,0,80,24],"right",0,"side",false]]"#
    );
    // A second slot splits the side's window along the side.
    eval(&mut ed, &s, r#"(win.displayBuffer("b", ["display-buffer-in-side-window", ["side", "right"], ["slot", 1]]), "")"#);
    assert_eq!(
        eval(&mut ed, &s, "show()"),
        r#"[["main",[0,0,60,24],null,null,null,true],["a",[60,0,80,12],"right",0,"side",false],["b",[60,12,80,24],"right",1,"side",false]]"#
    );
    // delete-other-windows deletes side windows too, unless they have a no-delete-other-windows parameter.
    eval(&mut ed, &s, r#"(e8.call("delete-other-windows"), "")"#);
    assert_eq!(eval(&mut ed, &s, "show()"), r#"[["main",[0,0,80,24],null,null,null,true]]"#);
}

#[test]
fn a_bottom_side_window_takes_a_quarter_of_the_frame() {
    assert_eq!(
        after(r#"win.displayBuffer("a", ["display-buffer-in-side-window", ["side", "bottom"]])"#),
        r#"[["main",[0,0,80,18],null,null,null,true],["a",[0,18,80,24],"bottom",0,"side",false]]"#
    );
}

#[test]
fn below_selected_at_bottom_and_in_direction() {
    assert_eq!(
        after(r#"win.displayBuffer("a", ["display-buffer-below-selected"])"#),
        r#"[["main",[0,0,80,12],null,null,null,true],["a",[0,12,80,24],null,null,null,false]]"#
    );
    assert_eq!(
        after(r#"(e8.call("split-window-right"), win.displayBuffer("a", ["display-buffer-at-bottom"]))"#),
        r#"[["main",[0,0,40,12],null,null,null,true],["main",[40,0,80,12],null,null,null,false],["a",[0,12,80,24],null,null,null,false]]"#
    );
    assert_eq!(
        after(r#"win.displayBuffer("a", ["display-buffer-in-direction", ["direction", "left"]])"#),
        r#"[["a",[0,0,40,24],null,null,null,false],["main",[40,0,80,24],null,null,null,true]]"#
    );
}

#[test]
fn window_height_sizes_a_new_window() {
    assert_eq!(
        after(r#"win.displayBuffer("a", ["display-buffer-pop-up-window", ["window-height", 5]])"#),
        r#"[["main",[0,0,80,19],null,null,null,true],["a",[0,19,80,24],null,null,null,false]]"#
    );
}

#[test]
fn same_window_no_window_and_use_some_window() {
    assert_eq!(
        after(r#"win.displayBuffer("a", ["display-buffer-same-window"])"#),
        r#"[["a",[0,0,80,24],null,null,null,true]]"#
    );
    // display-buffer-no-window gives up on showing it, without the fallback action's windows.
    assert_eq!(
        after(r#"win.displayBuffer("a", ["display-buffer-no-window", ["allow-no-window", true]])"#),
        r#"[["main",[0,0,80,24],null,null,null,true]]"#
    );
    assert_eq!(
        after(
            r#"(e8.call("split-window-below"), e8.setWindowBuffer(e8.windowList()[1], "b"),
              win.displayBuffer("a", ["display-buffer-use-some-window"]))"#
        ),
        r#"[["main",[0,0,80,12],null,null,null,true],["a",[0,12,80,24],null,null,null,false]]"#
    );
}

#[test]
fn conditions_match_by_major_mode() {
    assert_eq!(
        after(
            r#"(e8.setVariable("display-buffer-alist", [[["major-mode", "fundamental-mode"], "display-buffer-same-window"]]),
              e8.call("display-buffer", "a"))"#
        ),
        r#"[["a",[0,0,80,24],null,null,null,true]]"#
    );
}

/// Runs `code`, then gives each window's buffer, edges, side and slot.
fn layout_after(code: &str) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("({code}, layout())"))
}

#[test]
fn the_bottom_of_the_main_window_stops_at_the_side_windows() {
    // fit-window-to-buffer makes the new window window-min-height, four lines.
    assert_eq!(
        layout_after(
            r#"(win.displayBuffer("a", ["display-buffer-in-side-window", ["side", "right"]]), e8.call("split-window-below"),
              win.displayBuffer("x", ["display-buffer-in-direction", ["direction", "bottom"]]))"#
        ),
        r#"[["main",[0,0,60,10],null,null],["main",[0,10,60,20],null,null],["x",[0,20,60,24],null,null],["a",[60,0,80,24],"right",0]]"#
    );
}

#[test]
fn a_left_side_window_goes_above_a_bottom_one() {
    assert_eq!(
        layout_after(
            r#"(win.displayBuffer("a", ["display-buffer-in-side-window", ["side", "bottom"]]),
              win.displayBuffer("b", ["display-buffer-in-side-window", ["side", "left"]]))"#
        ),
        r#"[["b",[0,0,20,18],"left",0],["main",[20,0,80,18],null,null],["a",[0,18,80,24],"bottom",0]]"#
    );
}

#[test]
fn a_new_slot_goes_between_its_neighbours_and_the_side_is_shared() {
    assert_eq!(
        layout_after(
            r#"(win.displayBuffer("a", ["display-buffer-in-side-window", ["side", "bottom"], ["slot", -1]]),
              win.displayBuffer("b", ["display-buffer-in-side-window", ["side", "bottom"], ["slot", 1]]),
              win.displayBuffer("c", ["display-buffer-in-side-window", ["side", "bottom"], ["slot", 0]]))"#
        ),
        r#"[["main",[0,0,80,18],null,null],["a",[0,18,27,24],"bottom",-1],["c",[27,18,53,24],"bottom",0],["b",[53,18,80,24],"bottom",1]]"#
    );
}

#[test]
fn reuse_mode_window_previous_window_and_least_recent_window_choose_as_emacs_does() {
    // The last of the windows in that mode, as window.el pushes them.
    assert_eq!(
        layout_after(
            r#"(e8.call("split-window-below"), e8.call("split-window-below"),
              win.displayBuffer("x", ["display-buffer-reuse-mode-window", ["inhibit-same-window", true], ["mode", "fundamental-mode"]]))"#
        ),
        r#"[["main",[0,0,80,6],null,null],["main",[0,6,80,12],null,null],["x",[0,12,80,24],null,null]]"#
    );
    // The first window, from the frame's first, that showed the buffer before.
    assert_eq!(
        layout_after(
            r#"(e8.call("split-window-below"), e8.call("split-window-below"),
              ((ws) => { e8.setWindowBuffer(ws[0], "x"); e8.setWindowBuffer(ws[0], "a"); e8.setWindowBuffer(ws[2], "x"); e8.setWindowBuffer(ws[2], "c"); e8.selectWindow(ws[1]); })(e8.windowList()),
              win.displayBuffer("x", ["display-buffer-in-previous-window"]))"#
        ),
        r#"[["x",[0,0,80,6],null,null],["main",[0,6,80,12],null,null],["c",[0,12,80,24],null,null]]"#
    );
    // Each use bumps the window's use time, so the next takes another.
    assert_eq!(
        layout_after(
            r#"(e8.call("split-window-below"), e8.call("split-window-right"),
              win.displayBuffer("a", ["display-buffer-use-least-recent-window"]),
              win.displayBuffer("b", ["display-buffer-use-least-recent-window"]))"#
        ),
        r#"[["main",[0,0,40,12],null,null],["a",[40,0,80,12],null,null],["b",[0,12,80,24],null,null]]"#
    );
}

#[test]
fn split_above_leaves_the_odd_line_to_the_old_window() {
    let (mut ed, s) = setup();
    ed.set_frame_size(80, 25);
    assert_eq!(
        eval(&mut ed, &s, r#"(e8.splitWindow(undefined, "above"), layout())"#),
        r#"[["main",[0,0,80,12],null,null],["main",[0,12,80,25],null,null]]"#
    );
}

#[test]
fn fit_window_to_buffer_fits_lines_between_its_limits() {
    // The text as JavaScript writes it, its newlines escaped.
    for (text, height) in [("", 4), ("one\\n", 4), ("1\\n2\\n3\\n4\\n5\\n6", 7), ("1\\n2\\n3\\n4\\n5\\n6\\n", 7), (&"x\\n".repeat(22), 20)] {
        let got = layout_after(&format!(
            r#"((w) => {{ e8.withCurrentBuffer(e8.getBufferCreate("f"), () => e8.insert("{text}")); e8.setWindowBuffer(w, "f"); win.fitWindowToBuffer(w); }})(e8.splitWindow())"#
        ));
        assert!(got.contains(&format!(r#"["f",[0,{},80,24],null,null]"#, 24 - height)), "{text:?}: {got}");
    }
}

#[test]
fn main_windows_split_beside_a_side_window_stay_together() {
    // A split beside a side window makes an internal window of its own, so
    // a left side window spans both, and deleting the side window shares
    // its lines between them.
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(win.displayBuffer("a", ["display-buffer-in-side-window", ["side", "bottom"]]), e8.call("split-window-below"),
          win.displayBuffer("b", ["display-buffer-in-side-window", ["side", "left"]]), "")"#,
    );
    assert_eq!(
        eval(&mut ed, &s, "layout()"),
        r#"[["b",[0,0,20,18],"left",0],["main",[20,0,80,9],null,null],["main",[20,9,80,18],null,null],["a",[0,18,80,24],"bottom",0]]"#
    );
    eval(&mut ed, &s, r#"(e8.deleteWindow(e8.windowList()[3]), "")"#);
    assert_eq!(
        eval(&mut ed, &s, "layout()"),
        r#"[["b",[0,0,20,24],"left",0],["main",[20,0,80,12],null,null],["main",[20,12,80,24],null,null]]"#
    );
}

#[test]
fn windows_come_back_to_their_sizes_when_the_frame_does() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.call("split-window-below"), e8.call("split-window-below"), "")"#);
    let heights = |ed: &mut Editor| eval(ed, &s, "JSON.stringify(e8.windowList().map((w) => e8.windowTotalHeight(w)))");
    assert_eq!(heights(&mut ed), "[6,6,12]");
    ed.set_frame_size(80, 14);
    ed.set_frame_size(80, 24);
    assert_eq!(heights(&mut ed), "[6,6,12]");
}
