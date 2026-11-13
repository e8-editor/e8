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

// --- A frame's geometry, focus and order (ADR 0077) -------------------------

#[test]
fn a_frames_sizes_are_its_text_its_whole_self_and_its_characters() {
    let (mut ed, s) = setup();
    ed.set_frame_size(80, 24);
    // Headless, a cell is 1 by 1, so the units and the characters agree.
    // The windows divide 24 lines; the text area holds the echo area too,
    // as Emacs's holds the minibuffer window.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.frameTextWidth(), e8.frameTextHeight()])"), "[80,25]");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.frameTotalCols(), e8.frameTotalLines()])"), "[80,25]");
    // Until a front end says otherwise, the whole frame is its text.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.frameNativeWidth(), e8.frameNativeHeight()])"), "[80,25]");
    let frame = ed.selected_frame();
    ed.set_frame_geometry(frame, e8_core::FrameGeometry { native: (100.0, 30.0), position: (12.0, 34.0), scale: 2.0 });
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.frameNativeWidth(), e8.frameNativeHeight()])"), "[100,30]");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.framePosition())"), "[12,34]");
    assert_eq!(eval(&mut ed, &s, "e8.frameScaleFactor()"), "2");
    // The text area is still the editor's own, not the window's.
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([e8.frameTextWidth(), e8.frameTextHeight()])"), "[80,25]");
}

#[test]
fn moving_and_resizing_a_frame_leaves_the_front_end_a_request() {
    let (mut ed, s) = setup();
    ed.set_frame_size(80, 24);
    eval(&mut ed, &s, "(e8.setFramePosition(undefined, 20, 40), e8.setFrameSize(undefined, 100, 30), 1)");
    let frame = ed.selected_frame();
    assert_eq!(
        ed.take_frame_requests(),
        vec![
            e8_core::FrameRequest::Position { frame, x: 20.0, y: 40.0 },
            e8_core::FrameRequest::Size { frame, width: 100.0, height: 30.0 },
        ]
    );
    // Taken, they are gone, as warps are.
    assert!(ed.take_frame_requests().is_empty());
    // Width and height on their own keep the other side.
    eval(&mut ed, &s, "(e8.setFrameWidth(undefined, 90), e8.setFrameHeight(undefined, 25), 1)");
    assert_eq!(
        ed.take_frame_requests(),
        vec![
            e8_core::FrameRequest::Size { frame, width: 90.0, height: 25.0 },
            e8_core::FrameRequest::Size { frame, width: 80.0, height: 25.0 },
        ]
    );
}

#[test]
fn a_frames_parameters_hold_what_was_set_and_what_the_editor_knows() {
    let (mut ed, s) = setup();
    ed.set_frame_size(80, 24);
    let got = eval(&mut ed, &s, "JSON.stringify(e8.frameParameters())");
    let parameters: serde_json::Value = serde_json::from_str(&got).expect("an object");
    assert_eq!(parameters["width"], 80);
    assert_eq!(parameters["height"], 24);
    assert_eq!(parameters["left"], 0);
    assert_eq!(parameters["visibility"], true);
    assert_eq!(parameters["menu-bar-lines"], 0);
    assert_eq!(parameters["parent-frame"], serde_json::Value::Null);
    // Several at once, as modify-frame-parameters sets them, and what was
    // set wins over what the editor works out.
    eval(&mut ed, &s, r#"(e8.modifyFrameParameters(undefined, { "menu-bar-lines": 1, mine: "hello" }), 1)"#);
    assert_eq!(eval(&mut ed, &s, r#"String(e8.frameParameters()["mine"])"#), "hello");
    assert_eq!(eval(&mut ed, &s, r#"String(e8.frameParameters()["menu-bar-lines"])"#), "1");
    assert_eq!(eval(&mut ed, &s, r#"String(e8.frameParameter(undefined, "mine"))"#), "hello");
    // A size set as a parameter does not resize the frame, so what the
    // editor works out wins, as Fframe_parameters stores it over the
    // frame's own list.
    eval(&mut ed, &s, r#"(e8.modifyFrameParameters(undefined, { width: 200 }), 1)"#);
    assert_eq!(eval(&mut ed, &s, r#"String(e8.frameParameters()["width"])"#), "80");
}

#[test]
fn a_frames_keys_follow_the_frame_that_is_selected() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.a = e8.selectedFrame(), globalThis.b = e8.makeFrame(), globalThis.c = e8.makeFrame(),
            e8.selectFrame(a), e8.redirectFrameFocus(b, a),
            JSON.stringify([e8.frameFocus(b) === a, e8.frameFocus(a) === undefined]))"#,
    );
    assert_eq!(got, "[true,true]");
    // Selecting another frame moves to it what pointed at the one that
    // was selected, as do_switch_frame moves a redirection: the frame
    // borrowing a minibuffer borrows the frame in front.
    let got = eval(&mut ed, &s, "(e8.selectFrame(globalThis.c), String(e8.frameFocus(globalThis.b) === globalThis.c))");
    assert_eq!(got, "true");
    // A redirection can be cancelled.
    let got = eval(&mut ed, &s, "(e8.redirectFrameFocus(globalThis.b), String(e8.frameFocus(globalThis.b)))");
    assert_eq!(got, "undefined");
}

#[test]
fn lowering_a_frame_leaves_the_frames_order_alone() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(globalThis.a = e8.selectedFrame(), globalThis.b = e8.makeFrame(),
            JSON.stringify([e8.frameList().length, e8.frameList()[0] === b]))"#,
    );
    assert_eq!(got, "[2,true]");
    // Lowered, the frames are in the order they were made still, as
    // Flower_frame leaves frame-list alone, and the front end is asked.
    let got = eval(&mut ed, &s, "(e8.lowerFrame(globalThis.b), JSON.stringify([e8.frameList()[0] === globalThis.b, e8.frameList()[1] === globalThis.a]))");
    assert_eq!(got, "[true,true]");
    let frame = ed.selected_frame();
    assert_eq!(ed.take_frame_requests(), vec![e8_core::FrameRequest::Lower { frame }]);
}

#[test]
fn the_old_selected_frame_is_the_one_redisplay_last_saw() {
    let (mut ed, s) = setup();
    ed.redisplay();
    let first = ed.selected_frame();
    assert_eq!(ed.old_selected_frame(), Some(first));
    // Selecting another frame and back within one command leaves it as
    // it was, as Emacs keeps it from the last window change.
    eval(&mut ed, &s, "(globalThis.a = e8.selectedFrame(), globalThis.b = e8.makeFrame(), e8.selectFrame(globalThis.a), 1)");
    eval(&mut ed, &s, "(e8.selectFrame(globalThis.b), 1)");
    assert_eq!(ed.old_selected_frame(), Some(first));
    ed.redisplay();
    assert_eq!(ed.old_selected_frame(), Some(ed.selected_frame()));
}

#[test]
fn the_widths_around_a_frames_text_are_what_the_front_end_draws() {
    let (mut ed, s) = setup();
    // Headless, as on a terminal: no fringes, no scroll bars, a column
    // between windows side by side.
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.frameInternalBorderWidth(), e8.frameFringeWidth(), e8.frameScrollBarWidth(),
            e8.frameScrollBarHeight(), e8.frameRightDividerWidth(), e8.frameBottomDividerWidth()])"#,
    );
    assert_eq!(got, "[0,0,0,0,0,0]");
    // A divider is a frame's parameter, as Emacs's is.
    eval(&mut ed, &s, r#"(e8.setFrameParameter(undefined, "right-divider-width", 2), 1)"#);
    assert_eq!(eval(&mut ed, &s, "String(e8.frameRightDividerWidth())"), "2");
    assert_eq!(eval(&mut ed, &s, "String(e8.frameChildFrameBorderWidth())"), "undefined");
    assert_eq!(eval(&mut ed, &s, "String(e8.frameAncestorP())"), "false");
}

#[test]
fn a_geometry_string_says_a_size_and_a_place() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.xParseGeometry("80x24+10+20"))"#), r#"{"width":80,"height":24,"left":10,"top":20}"#);
    // A place from the far edge is a negative number, as XParseGeometry
    // gives one, and the leading = is allowed.
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.xParseGeometry("-5-10"))"#), r#"{"left":-5,"top":-10}"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.xParseGeometry("=80x24"))"#), r#"{"width":80,"height":24}"#);
    // Only -0 cannot be said as a number: it is the far edge itself.
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.xParseGeometry("-0+0"))"#), r#"{"left":["-",0],"top":0}"#);
    // A width without a height is a width, as XParseGeometry reads one.
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.xParseGeometry("80+10+20"))"#), r#"{"width":80,"left":10,"top":20}"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.xParseGeometry("rubbish"))"#), "{}");
    // E8 reads no resource database.
    assert_eq!(eval(&mut ed, &s, r#"String(e8.xGetResource("background", "Background"))"#), "undefined");
}

#[test]
fn a_frames_window_state_change_flag_is_set_and_cleared() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "String(e8.frameWindowStateChange())"), "false");
    assert_eq!(eval(&mut ed, &s, "(e8.setFrameWindowStateChange(undefined, true), String(e8.frameWindowStateChange()))"), "true");
    assert_eq!(eval(&mut ed, &s, "(e8.setFrameWindowStateChange(undefined, false), String(e8.frameWindowStateChange()))"), "false");
}
