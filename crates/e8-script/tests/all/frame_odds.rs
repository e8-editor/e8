//! The last of frame.c's primitives and those nsfns.m gives frame.el on
//! macOS: marking a frame made, switch-frame events, the was-invisible
//! flag, x-create-frame, and a frame's geometry, edges, stacking order and
//! monitors as ns-frame-geometry and its kin give them. Emacs's answers
//! for frame.c's are from Emacs 30.2 in batch; batch Emacs has no
//! Nextstep frame, so the ns-* answers follow nsfns.m's code.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    // An error as Emacs prints it: its condition and data, symbols by name
    // and a frame as dead-frame, the only kind given here; and a frame
    // made and deleted, for a frame that is not live.
    let errors = r#"(globalThis.errOf = (e) => [e.symbol, ...(e.data ?? []).map((d) =>
        typeof d === "symbol" ? d.description : e8.framep(d) !== false ? "dead-frame" : d)],
      globalThis.dead = e8.makeFrame(), e8.deleteFrame(dead), true)"#;
    s.eval_expression(&mut ed, errors).unwrap();
    (ed, s)
}

/// As a window does, so that the ns-* primitives answer.
fn in_a_window(ed: &mut Editor) {
    ed.set_display(e8_core::Display { is_a_window: true, ..Default::default() });
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn a_frame_not_made_runs_no_window_configuration_change_hook() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.n = 0, e8.addHook("window-configuration-change-hook", () => { n++; }),
          JSON.stringify([e8.frameAfterMakeFrame(null, true), e8.frameAfterMakeFrame(null, "made"), e8.frameAfterMakeFrame(null, null),
            (e8.runWindowConfigurationChangeHook(), n), e8.frameAfterMakeFrame(null, true), (e8.runWindowConfigurationChangeHook(), n),
            e8.conditionCase(() => e8.frameAfterMakeFrame(dead, null), { error: errOf })]))"#,
    );
    // Emacs: (frame-after-make-frame nil t) => t, ... 'made => made, ... nil => nil; the hook runs once, after the
    // frame is made again; a dead frame, as (frame-after-make-frame 3 nil) => (wrong-type-argument frame-live-p 3)
    assert_eq!(got, r#"[true,"made",null,0,true,1,["wrong-type-argument","frame-live-p","dead-frame"]]"#);
}

#[test]
fn a_switch_frame_event_selects_its_frame() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.f1 = e8.selectedFrame(), globalThis.f2 = e8.makeFrame(), globalThis.left = 0,
          e8.addHook("mouse-leave-buffer-hook", () => { left++; }),
          JSON.stringify([e8.handleSwitchFrame(f1) === f1, e8.selectedFrame() === f1,
            e8.handleSwitchFrame(["switch-frame", f2]) === f2, e8.selectedFrame() === f2,
            e8.handleSwitchFrame(f2) === f2, left,
            e8.conditionCase(() => e8.handleSwitchFrame(3), { error: errOf }),
            e8.conditionCase(() => e8.handleSwitchFrame(["switch-frame", 3]), { error: errOf }),
            e8.conditionCase(() => e8.handleSwitchFrame(["switch-frame"]), { error: errOf }),
            (e8.deleteFrame(f1), e8.handleSwitchFrame(f1) ?? null), e8.selectedFrame() === f2]))"#,
    );
    // Emacs: handle-switch-frame gives the frame its event names, the frame itself or (switch-frame FRAME), and runs
    // mouse-leave-buffer-hook each time; (handle-switch-frame 3) and (handle-switch-frame '(switch-frame 3)) =>
    // (wrong-type-argument framep 3); '(switch-frame) => (wrong-type-argument framep (switch-frame)). A dead frame is
    // passed over with nil, as do_switch_frame's "Silently ignore dead and tooltip frames".
    assert_eq!(
        got,
        r#"[true,true,true,true,true,3,["wrong-type-argument","framep",3],["wrong-type-argument","framep",3],["wrong-type-argument","framep",["switch-frame"]],null,true]"#
    );
}

#[test]
fn the_was_invisible_flag_is_given_back() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.frameSetWasInvisible(null, true), e8.frameSetWasInvisible(null, false),
          e8.conditionCase(() => e8.frameSetWasInvisible(dead, false), { error: errOf })])"#,
    );
    // Emacs: (frame--set-was-invisible nil t) => t, ... nil => nil, a dead frame, as (frame--set-was-invisible 3 nil) =>
    // (wrong-type-argument frame-live-p 3)
    assert_eq!(got, r#"[true,false,["wrong-type-argument","frame-live-p","dead-frame"]]"#);
}

#[test]
fn x_create_frame_makes_a_frame_only_in_a_window() {
    let (mut ed, s) = setup();
    let got = eval(&mut ed, &s, r#"e8.conditionCase(() => e8.xCreateFrame(null), { error: (e) => e.message })"#);
    // Emacs on macOS, in batch: (x-create-frame nil) => (error "Nextstep windows are not in use or not initialized")
    assert_eq!(got, "Nextstep windows are not in use or not initialized");
    in_a_window(&mut ed);
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.f1 = e8.selectedFrame(), globalThis.n = 0, e8.addHook("window-configuration-change-hook", () => { n++; }),
          globalThis.f2 = e8.xCreateFrame({ "my-parameter": 7 }),
          JSON.stringify([e8.frameList().length, e8.selectedFrame() === f1, e8.frameParameter(f2, "my-parameter"),
            e8.frameParameter(f2, "minibuffer"), (e8.runWindowConfigurationChangeHook(f2), n),
            (e8.frameAfterMakeFrame(f2, true), e8.runWindowConfigurationChangeHook(f2), n)]))"#,
    );
    // nsfns.m: x-create-frame makes the frame with the parameters it is given, its minibuffer t, leaves the selected
    // frame selected and the frame not yet made (make_frame clears after_make_frame, and only make-frame's
    // frame-after-make-frame sets it), so window-configuration-change-hook runs only after that.
    assert_eq!(got, "[2,true,7,true,0,1]");
}

#[test]
fn ns_frame_geometry_and_edges_come_from_the_front_end() {
    let (mut ed, s) = setup();
    in_a_window(&mut ed);
    let frame = ed.selected_frame();
    // A window 800 by 600 at (10, 20) on the screen, with a 28-unit title bar above it.
    ed.set_frame_geometry(frame, e8_core::FrameGeometry { native: (800.0, 600.0), position: (10.0, 20.0), scale: 2.0, outer: (800.0, 628.0) });
    let got = eval(&mut ed, &s, r#"JSON.stringify(e8.nsFrameGeometry())"#);
    // nsfns.m's frame_geometry: outer-position is (left_pos . top_pos), outer-size the native size with the borders and
    // the title bar, title-bar-size (0 . title-height); the menu bar is external on macOS, but E8 draws its own in the
    // frame, as X does without a toolkit, and none is shown here; tool-bar-position is the frame's, top by default.
    assert_eq!(
        got,
        r#"[["outer-position",[10,20]],["outer-size",[800,628]],["external-border-size",[0,0]],["title-bar-size",[0,28]],["menu-bar-external",null],["menu-bar-size",[0,0]],["tool-bar-external",null],["tool-bar-position","top"],["tool-bar-size",[0,0]],["tab-bar-size",[0,0]],["internal-border-width",0]]"#
    );
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.nsFrameEdges(null, "outer-edges"), e8.nsFrameEdges(), e8.nsFrameEdges(null, "native-edges"),
          e8.nsFrameEdges(null, "inner-edges"), e8.nsFrameEdges(null, "other"), e8.frameEdges(null, "native-edges"),
          e8.conditionCase(() => e8.nsFrameEdges(dead), { error: errOf })])"#,
    );
    // nsfns.m: outer edges from (left_pos, top_pos) the outer size across; native edges start below the title bar;
    // inner edges inside the internal border and the tool bar, none here; any TYPE but outer-edges and inner-edges is
    // native-edges.
    assert_eq!(
        got,
        r#"[[10,20,810,648],[10,48,810,648],[10,48,810,648],[10,48,810,648],[10,48,810,648],[10,48,810,648],["wrong-type-argument","frame-live-p","dead-frame"]]"#
    );
    // The bars E8 draws in the frame are across it, as X's frame_geometry gives them, and inside the inner edges.
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.setFrameParameter(null, "menu-bar-lines", 1), e8.setFrameParameter(null, "tab-bar-lines", 1),
          JSON.stringify([e8.nsFrameGeometry().filter(([name]) => name.endsWith("bar-size")), e8.nsFrameEdges(null, "inner-edges")]))"#,
    );
    let cell = ed.cells_to_units(1, false) as i64;
    assert_eq!(
        got,
        format!(r#"[[["title-bar-size",[0,28]],["menu-bar-size",[800,{cell}]],["tool-bar-size",[0,0]],["tab-bar-size",[800,{cell}]]],[10,{},810,648]]"#, 48 + 2 * cell)
    );
    // nsfns.m: a fullscreen frame has no borders and no title bar.
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.setFrameParameter(null, "fullscreen", "fullboth"),
          JSON.stringify([e8.nsFrameGeometry().filter(([name]) => name.startsWith("outer") || name.startsWith("title")),
            e8.nsFrameEdges(null, "outer-edges"), e8.nsFrameEdges()]))"#,
    );
    assert_eq!(got, r#"[[["outer-position",[10,20]],["outer-size",[800,600]],["title-bar-size",[0,0]]],[10,20,810,620],[10,20,810,620]]"#);
}

#[test]
fn frames_stack_as_they_are_raised_lowered_and_restacked() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.f1 = e8.selectedFrame(), globalThis.f2 = e8.makeFrame(),
          JSON.stringify([e8.nsFrameListZOrder().length,
            e8.conditionCase(() => e8.nsFrameRestack(f1, f2), { error: (e) => e.message })]))"#,
    );
    // Emacs in batch, with no Nextstep windows: (ns-frame-list-z-order) => nil; nsfns.m: a frame without a Nextstep
    // view cannot be restacked, (error "Cannot restack frames").
    assert_eq!(got, r#"[0,"Cannot restack frames"]"#);
    in_a_window(&mut ed);
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.names = () => e8.nsFrameListZOrder().map((f) => [f1, f2, globalThis.f3].indexOf(f)),
          JSON.stringify([names(), (e8.raiseFrame(f1), names()), (globalThis.f3 = e8.makeFrame(), names()),
            (e8.lowerFrame(f3), names()), [e8.nsFrameRestack(f3, f1, true), names()], [e8.nsFrameRestack(f3, f2), names()],
            (e8.nsFrameRestack(f1, f1), names()), e8.nsFrameListZOrder(f1),
            e8.conditionCase(() => e8.nsFrameRestack(dead, f1), { error: errOf }),
            (e8.deleteFrame(f2), names())]))"#,
    );
    // ns-frame-list-z-order lists the frames topmost first: a new frame on top, a raised one on top, a lowered one at
    // the bottom; (ns-frame-restack F1 F2 ABOVE) puts F1 just above or below F2, leaving F2 where it was among the rest,
    // and gives t; given a live frame it lists that frame's child frames, none; a dead frame, as (ns-frame-restack 3 4) =>
    // (wrong-type-argument frame-live-p 3).
    assert_eq!(
        got,
        r#"[[1,0],[0,1],[2,0,1],[0,1,2],[true,[2,0,1]],[true,[0,1,2]],[0,1,2],[],["wrong-type-argument","frame-live-p","dead-frame"],[0,2]]"#
    );
}

#[test]
fn ns_monitors_are_the_display_s_in_a_window() {
    let (mut ed, s) = setup();
    let got = eval(&mut ed, &s, r#"JSON.stringify(e8.nsDisplayMonitorAttributesList())"#);
    // Emacs in batch: (ns-display-monitor-attributes-list) => nil, the terminal not being a Nextstep one.
    assert_eq!(got, "[]");
    in_a_window(&mut ed);
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.ns = e8.nsDisplayMonitorAttributesList(), globalThis.all = e8.displayMonitorAttributesList(),
          JSON.stringify([ns.length, ns[0].map(([name]) => name), ns[0].find(([n]) => n === "source")[1],
            ns[0].find(([n]) => n === "frames")[1].length,
            JSON.stringify(ns[0].filter(([n]) => n !== "source")) === JSON.stringify(all[0].filter(([n]) => n !== "source"))]))"#,
    );
    // nsfns.m: each monitor's name, geometry, workarea, mm-size and frames, as make_monitor_attribute_list conses
    // them, with source "NS".
    assert_eq!(got, r#"[1,["name","geometry","workarea","mm-size","frames","source"],"NS",1,true]"#);
}
