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
            e8.windowDedicatedP(w) ?? null, w === e8.selectedWindow()])), "")"#,
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
