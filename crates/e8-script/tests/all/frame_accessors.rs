//! Emacs's window and frame accessors for scripts: which frame a window is
//! on, frames' order and visibility, sizes in the front end's units, and
//! selecting a window or frame for a while. Headless, a cell is 1 by 1,
//! as on a terminal and in batch Emacs.

use e8_core::Editor;
use e8_core::frame_description::Visibility;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(&mut ed, "load.ts", r#"import("subr").then((m) => { globalThis.subr = m; });"#.into()).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn windows_know_their_frames_and_frames_their_order() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.f1 = e8.selectedFrame(), globalThis.w1 = e8.selectedWindow(), globalThis.w2 = e8.splitWindow(),
          globalThis.f2 = e8.makeFrame(), globalThis.w3 = e8.selectedWindow(),
          JSON.stringify([e8.windowFrame(w1) === f1, e8.windowFrame(w2) === f1, e8.windowFrame(w3) === f2, e8.windowFrame() === f2,
            e8.windowFrame(e8.minibufferWindow()) === f2, e8.windowFrame(9999) ?? null,
            e8.frameFirstWindow(f1) === w1, e8.frameFirstWindow() === w3,
            e8.nextFrame() === f1, e8.nextFrame(f1) === f2, e8.previousFrame() === f1,
            e8.windowValidP(w1), e8.windowValidP(9999), e8.windowValidP("x"),
            e8.windowList1(w2).map((w) => [w1, w2, w3, e8.minibufferWindow()].indexOf(w)),
            e8.windowList1(w2, true, true).map((w) => [w1, w2, w3, e8.minibufferWindow()].indexOf(w)),
            subr.frameParent() ?? null, subr.lastNonminibufferFrame() === f2]))"#,
    );
    // Emacs: window-list-1 starts at the window and goes round its frame, or every frame's with ALL-FRAMES, the
    // minibuffer's window after the windows of the frame it is on, the selected one here
    assert_eq!(got, "[true,true,true,true,true,null,true,true,true,true,true,true,false,false,[1,0],[1,2,3,0],null,true]");
}

#[test]
fn frames_are_hidden_iconified_and_raised_for_the_front_end() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.f1 = e8.selectedFrame(), globalThis.f2 = e8.makeFrame(),
          JSON.stringify([e8.frameVisibleP(), (e8.makeFrameInvisible(f1), e8.frameVisibleP(f1)), e8.visibleFrameList().length,
            (e8.iconifyFrame(f1), e8.frameVisibleP(f1)), (e8.makeFrameVisible(f1), e8.frameVisibleP(f1)),
            (e8.makeFrameInvisible(f2), e8.raiseFrame(f2), e8.frameVisibleP(f2))]))"#,
    );
    assert_eq!(got, r#"[true,false,1,"icon",true,true]"#);
    let f2: u64 = eval(&mut ed, &s, "f2.id").parse().unwrap();
    let d = ed.describe_frame(f2, 1.0);
    assert_eq!((d.visibility, d.raised), (Visibility::Visible, 1));
    eval(&mut ed, &s, "(e8.iconifyFrame(f2), subr.xFocusFrame(f2), e8.iconifyFrame(f2), true)");
    let d = ed.describe_frame(f2, 1.0);
    assert_eq!((d.visibility, d.raised), (Visibility::Iconified, 2));
    // The only frame shown cannot be hidden; a dead frame has no visibility.
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.deleteFrame(f2), JSON.stringify([e8.conditionCase(() => (e8.makeFrameInvisible(), "hidden"), { error: (e) => e.message }),
          e8.conditionCase(() => e8.frameVisibleP(f2), { "wrong-type-argument": () => "dead" })]))"#,
    );
    // Emacs: (error "Attempt to make invisible the sole visible or iconified frame")
    assert_eq!(got, r#"["Attempt to make invisible the sole visible or iconified frame","dead"]"#);
}

#[test]
fn another_frame_s_selected_window_is_put_back_too() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.f1 = e8.selectedFrame(), globalThis.f2 = e8.makeFrame(), globalThis.a = e8.selectedWindow(),
          globalThis.b = e8.splitWindow(), e8.selectFrame(f1),
          JSON.stringify([subr.withSelectedWindow(b, () => e8.selectedWindow() === b && e8.selectedFrame() === f2),
            e8.selectedFrame() === f1, e8.frameSelectedWindow(f2) === a]))"#,
    );
    // Emacs: frame-selected-window of the other frame is the one it had
    assert_eq!(got, "[true,true,true]");
}

#[test]
fn sizes_in_the_front_end_s_units() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.frameCharHeight(), e8.frameCharWidth(), e8.windowSystem() ?? null, e8.windowModeLineHeight(),
          e8.windowHeaderLineHeight(), e8.windowPixelHeight() === e8.frameHeight(), e8.windowPixelWidth() === e8.frameWidth(),
          (e8.splitWindow(), e8.windowPixelHeight() + e8.windowPixelHeight(e8.windowList()[1])) === e8.frameHeight(),
          subr.frameTextCols() === e8.frameWidth(), subr.frameTextLines() === e8.frameHeight()])"#,
    );
    // Emacs in batch: frame-char-height 1, window-system nil, window-mode-line-height 1, and the windows' pixel heights add up to the frame's
    assert_eq!(got, "[1,1,null,1,0,true,true,true,true,true]");
}

#[test]
fn a_window_or_frame_is_selected_for_a_while() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.w1 = e8.selectedWindow(), globalThis.w2 = e8.splitWindow(),
          e8.setWindowBuffer(w2, e8.getBufferCreate("other")), globalThis.here = e8.bufferName(e8.currentBuffer()),
          JSON.stringify([
            subr.withSelectedWindow(w2, () => [e8.selectedWindow() === w2, e8.bufferName(e8.currentBuffer())]),
            e8.selectedWindow() === w1, e8.bufferName(e8.currentBuffer()) === here, e8.bufferList()[0] === here,
            subr.saveSelectedWindow(() => (e8.selectWindow(w2), e8.selectedWindow() === w2)), e8.selectedWindow() === w1,
            (() => { const f1 = e8.selectedFrame(), f2 = e8.makeFrame(); e8.selectFrame(f1);
                     return [subr.withSelectedFrame(f2, () => e8.selectedFrame() === f2), e8.selectedFrame() === f1]; })(),
            e8.conditionCase(() => subr.withSelectedWindow(w2, () => e8.signal("error", "boom")), { error: () => e8.selectedWindow() === w1 }),
          ]))"#,
    );
    assert_eq!(got, r#"[[true,"other"],true,true,true,true,true,[true,true],true]"#);
}
