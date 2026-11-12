//! window.el's window states and quitting windows (ADR 0069, stage 4):
//! window-state-get and window-state-put, window-swap-states, and
//! quit-restore-window with the quit-restore parameter
//! display-buffer-record-window writes. Each expectation is what Emacs 30.2
//! gives in batch, on an 80 by 24 root window where a pixel is a line or a
//! column, the windows listed from the frame's first as `[height, width,
//! buffer]`, with positions one less, as E8's count from 0.

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
        r#"(["a", "b", "c"].forEach((b) => e8.withCurrentBuffer(e8.getBufferCreate(b), () => { for (let i = 0; i < 100; i++) e8.insert(`${b} line ${i}\n`); })),
          globalThis.ws = () => e8.windowList(),
          globalThis.sz = () => ws().map((w) => [e8.windowTotalHeight(w), e8.windowTotalWidth(w), e8.windowBuffer(w)]),
          globalThis.at = () => ws().map((w) => [e8.windowStart(w), e8.windowPoint(w)]),
          globalThis.bw = (b) => e8.windowList1(undefined, false, true).find((w) => e8.windowBuffer(w) === b),
          globalThis.quad = (w) => ((q) => [q[0].description, q[1].description, q[2] === ws()[0], q[3].name])(e8.windowParameter(w, "quit-restore")),
          globalThis.sel = () => ws().indexOf(e8.selectedWindow()),
          globalThis.split = (w, size, side) => win.splitWindow(w, size, side),
          globalThis.reset = () => (win.deleteOtherWindows(), e8.call("switch-to-buffer", "*scratch*")),
          globalThis.show = (b, alist) => win.displayBuffer(b, alist),
          globalThis.printed = (v) => e8.prin1ToString(v),
          globalThis.read = (text) => e8.readFromString(text)[0],
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

const SCRATCH: &str = r#"(buffer "*scratch*" (selected . t) (hscroll . 0) (fringes 0 0 nil nil) (margins nil) (scroll-bars nil 0 t nil 0 t nil) (vscroll . 0) (dedicated) (point . 0) (start . 0))"#;

#[test]
fn window_state_get_gives_the_tree_as_lisp() {
    // (window-state-get nil t) on one window and on a row in a column, as
    // Emacs prints it, read back and printed by E8, positions from 0.
    let one = format!(
        "(((min-height . 4) (min-width . 10) (min-height-ignore . 2) (min-width-ignore . 2) (min-height-safe . 1) (min-width-safe . 2) \
         (min-pixel-height . 4) (min-pixel-width . 10) (min-pixel-height-ignore . 2) (min-pixel-width-ignore . 2) (min-pixel-height-safe . 1) \
         (min-pixel-width-safe . 2)) leaf (pixel-width . 80) (pixel-height . 24) (total-width . 80) (total-height . 24) (normal-height . 1.0) \
         (normal-width . 1.0) {SCRATCH})"
    );
    assert_eq!(
        after(&format!("[printed(win.windowStateGet(null, true)), printed(read({one:?}))]")),
        after(&format!("[printed(read({one:?})), printed(read({one:?}))]"))
    );
    let unselected = SCRATCH.replace("(selected . t)", "(selected)");
    let nested = format!(
        "(((min-height . 8) (min-width . 20) (min-height-ignore . 4) (min-width-ignore . 4) (min-height-safe . 2) (min-width-safe . 4) \
         (min-pixel-height . 8) (min-pixel-width . 20) (min-pixel-height-ignore . 4) (min-pixel-width-ignore . 4) (min-pixel-height-safe . 2) \
         (min-pixel-width-safe . 4)) vc (pixel-width . 80) (pixel-height . 24) (total-width . 80) (total-height . 24) (normal-height . 1.0) \
         (normal-width . 1.0) (combination-limit) (hc (pixel-width . 80) (pixel-height . 12) (total-width . 80) (total-height . 12) \
         (normal-height . 0.5) (normal-width . 1.0) (combination-limit) (leaf (pixel-width . 40) (pixel-height . 12) (total-width . 40) \
         (total-height . 12) (normal-height . 1.0) (normal-width . 0.5) {SCRATCH}) (leaf (last . t) (pixel-width . 40) (pixel-height . 12) \
         (total-width . 40) (total-height . 12) (normal-height . 1.0) (normal-width . 0.5) {unselected})) (leaf (last . t) (pixel-width . 80) \
         (pixel-height . 12) (total-width . 80) (total-height . 12) (normal-height . 0.5) (normal-width . 1.0) {unselected}))"
    );
    let (mut ed, s) = setup();
    assert_eq!(
        eval(&mut ed, &s, &format!(r#"(split(), split(null, null, "right"), printed(win.windowStateGet(null, true)) === printed(read({nested:?})))"#)),
        "true"
    );
    // Without WRITABLE, buffers are objects, positions markers, and each
    // window is noted as the clone-of parameter, as window-persistent-parameters says.
    assert_eq!(
        eval(
            &mut ed,
            &s,
            r#"(() => { const st = win.windowStateGet(ws()[2]); const leaf = st.slice(1);
                const buffer = leaf.find((e) => Array.isArray(e) && e[0] === Symbol.for("buffer"));
                const point = buffer.find((e) => Array.isArray(e) && e[0] === Symbol.for("point"))[1];
                const params = leaf.find((e) => Array.isArray(e) && e[0] === Symbol.for("parameters"));
                return JSON.stringify([e8.bufferLiveP(buffer[1]), point instanceof e8.Marker, params[1][1] === ws()[2]]); })()"#
        ),
        "[true,true,true]"
    );
    assert_eq!(after("err(() => win.windowStateGet(42))"), r#""42 is not a live or internal window""#);
}

#[test]
fn window_state_put_restores_sizes_buffers_and_the_selected_window() {
    let make = r#"(split(null, 10), e8.selectWindow(ws()[1]), e8.call("switch-to-buffer", "a"), split(null, 30, "right"),
                  e8.selectWindow(ws()[2]), e8.call("switch-to-buffer", "b"), globalThis.st = win.windowStateGet(null, true))"#;
    let three = r#"[[[10,80,"*scratch*"],[14,30,"a"],[14,50,"b"]],2]"#;
    // Into the frame, at the sizes the state has.
    assert_eq!(after(&format!("({make}, reset(), win.windowStatePut(st), [sz(), sel()])")), three);
    // Into a smaller window, in proportion, then grown to window-min-height.
    assert_eq!(
        after(&format!("({make}, reset(), split(null, 8), win.windowStatePut(st, e8.selectedWindow()), [sz(), sel()])")),
        r#"[[[4,80,"*scratch*"],[4,30,"a"],[4,50,"b"],[16,80,"*scratch*"]],2]"#
    );
    // Into an internal window, here the root, which is made one window first.
    assert_eq!(
        after(&format!("({make}, reset(), split(null, 8), win.windowStatePut(st, e8.frameRootWindow()), [sz(), sel()])")),
        three
    );
    // Printed and read back, as a desktop file keeps it.
    assert_eq!(after(&format!("({make}, reset(), win.windowStatePut(read(printed(st))), [sz(), sel()])")), three);
}

#[test]
fn window_state_put_nests_combinations_and_keeps_least_sizes() {
    // A column of three beside a window: the 3 and 2 line windows come
    // back at window-min-height, as window--state-put-2 grows them.
    let made = r#"(split(null, null, "right"), split(null, 5), split(null, 3), e8.call("switch-to-buffer", "c"), globalThis.st = win.windowStateGet(null, true), sz())"#;
    assert_eq!(after(made), r#"[[3,40,"c"],[2,40,"*scratch*"],[19,40,"*scratch*"],[24,40,"*scratch*"]]"#);
    assert_eq!(
        after(&format!("({made}, reset(), win.windowStatePut(st, null), [sz(), sel()])")),
        r#"[[[4,40,"c"],[4,40,"*scratch*"],[16,40,"*scratch*"],[24,40,"*scratch*"]],0]"#
    );
}

#[test]
fn window_state_put_restores_positions_and_dedication() {
    assert_eq!(
        after(
            r#"(e8.call("switch-to-buffer", "a"), e8.gotoChar(199), e8.setWindowStart(undefined, 100), split(), e8.selectWindow(ws()[1]),
                e8.call("switch-to-buffer", "b"), e8.gotoChar(299), globalThis.st = win.windowStateGet(null, true), reset(), win.windowStatePut(st), at())"#
        ),
        "[[100,199],[0,299]]"
    );
    assert_eq!(
        after(r#"(split(), e8.setWindowDedicatedP(undefined, true), globalThis.st = win.windowStateGet(null, true), reset(), win.windowStatePut(st), ws().map((w) => e8.windowDedicatedP(w) ?? null))"#),
        "[true,null]"
    );
}

#[test]
fn a_window_whose_buffer_was_killed_is_deleted() {
    assert_eq!(
        after(
            r#"(e8.getBufferCreate("gone"), split(), e8.call("switch-to-buffer", "gone"), globalThis.st = win.windowStateGet(null, true),
                e8.call("kill-buffer", "gone"), reset(), win.windowStatePut(st), [sz(), sel()])"#
        ),
        r#"[[[24,80,"*scratch*"]],0]"#
    );
    // With window-restore-killed-buffer-windows a function, it is kept and the function told.
    assert_eq!(
        after(
            r#"(e8.getBufferCreate("gone"), split(), e8.call("switch-to-buffer", "gone"), globalThis.st = win.windowStateGet(null, true),
                e8.call("kill-buffer", "gone"), reset(),
                e8.setVariable("window-restore-killed-buffer-windows", (frame, kept, how) => { globalThis.told = [kept.length, kept[0][1], how.description]; }),
                win.windowStatePut(st), [sz().length, told])"#
        ),
        r#"[2,[1,"gone","state"]]"#
    );
}

#[test]
fn window_persistent_parameters_say_which_parameters_a_state_keeps() {
    let set = r#"(e8.setVariable("window-persistent-parameters", [[Symbol.for("foo"), Symbol.for("writable")], [Symbol.for("bar"), true], ...e8.variable("window-persistent-parameters")]),
                 split(), e8.setWindowParameter(undefined, "foo", Symbol.for("yes")), e8.setWindowParameter(undefined, "bar", Symbol.for("no")),
                 e8.setWindowParameter(undefined, "baz", Symbol.for("gone")))"#;
    let params = r#"ws().map((w) => ["foo", "bar", "baz"].map((p) => e8.windowParameter(w, p)?.description ?? null).concat([e8.windowp(e8.windowParameter(w, "clone-of"))]))"#;
    // Written out, only those whose persistence is writable.
    assert_eq!(
        after(&format!(r#"({set}, printed(win.windowStateGet(null, true)).includes("(parameters (foo yes))"))"#)),
        "true"
    );
    assert_eq!(
        after(&format!("({set}, globalThis.st = win.windowStateGet(null, true), reset(), win.windowStatePut(st), {params})")),
        r#"[["yes",null,null,false],[null,null,null,false]]"#
    );
    // Kept in memory, those whose persistence is t too, and clone-of.
    assert_eq!(
        after(&format!("({set}, globalThis.st = win.windowStateGet(), reset(), win.windowStatePut(st), {params})")),
        r#"[["yes","no",null,true],[null,null,null,true]]"#
    );
}

#[test]
fn window_swap_states_swaps_buffers_and_with_size_sizes() {
    let make = r#"(split(null, 8), e8.call("switch-to-buffer", "a"), e8.gotoChar(200), e8.selectWindow(ws()[1]), e8.call("switch-to-buffer", "b"),
                  e8.gotoChar(100), e8.selectWindow(ws()[0]))"#;
    assert_eq!(
        after(&format!("({make}, win.windowSwapStates(), [sz(), at(), sel()])")),
        r#"[[[8,80,"b"],[16,80,"a"]],[[0,100],[0,200]],1]"#
    );
    assert_eq!(
        after(&format!("({make}, win.windowSwapStates(), win.windowSwapStates(null, null, true), [sz(), at(), sel()])")),
        r#"[[[16,80,"a"],[8,80,"b"]],[[0,200],[0,100]],0]"#
    );
    // The command swaps the selected window with the next.
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(split(null, 8), e8.call("switch-to-buffer", "a"), "")"#);
    ed.press("M-x").unwrap();
    ed.type_text("window-swap-states");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([sz(), sel()])"), r#"[[[8,80,"*scratch*"],[16,80,"a"]],1]"#);
}

#[test]
fn quitting_a_window_made_for_a_buffer_deletes_it() {
    // (window window #<window 1 on *scratch*> #<buffer a>) in Emacs: the
    // kinds symbols, the window selected then, and the buffer an object.
    assert_eq!(
        after(r#"(show("a", [["display-buffer-pop-up-window"]]), quad(bw("a")))"#),
        r#"["window","window",true,"a"]"#
    );
    // Deleted, the window selected then selected, and its buffer buried.
    assert_eq!(
        after(r#"(show("a", [["display-buffer-pop-up-window"]]), e8.selectWindow(bw("a")), win.quitWindow(), [sz(), sel(), e8.bufferList().at(-1)])"#),
        r#"[[[24,80,"*scratch*"]],0,"a"]"#
    );
    // With KILL, its buffer is killed.
    assert_eq!(
        after(r#"(e8.getBufferCreate("k"), show("k", [["display-buffer-pop-up-window"]]), e8.selectWindow(bw("k")), win.quitWindow(true), [sz(), sel(), !!e8.getBuffer("k")])"#),
        r#"[[[24,80,"*scratch*"]],0,false]"#
    );
    // A dedicated window is deleted too.
    assert_eq!(
        after(r#"(show("a", [["display-buffer-pop-up-window"], ["dedicated", true]]), e8.selectWindow(bw("a")), win.quitWindow(), [sz(), sel()])"#),
        r#"[[[24,80,"*scratch*"]],0]"#
    );
    // A window made for one buffer that shows another shows the one before.
    assert_eq!(
        after(r#"(show("a", [["display-buffer-pop-up-window"]]), e8.selectWindow(bw("a")), e8.call("switch-to-buffer", "b"), win.quitWindow(), [sz(), sel()])"#),
        r#"[[[12,80,"*scratch*"],[12,80,"a"]],1]"#
    );
    // Made for its buffer, but now the frame's only window: it stays (Bug#12764).
    assert_eq!(
        after(r#"(show("a", [["display-buffer-pop-up-window"]]), e8.selectWindow(bw("a")), win.deleteOtherWindows(), win.quitWindow(), [sz(), sel()])"#),
        r#"[[[24,80,"*scratch*"]],0]"#
    );
    // Shown again in the same window, it notes so.
    assert_eq!(
        after(r#"(show("a", [["display-buffer-pop-up-window"]]), show("a", [["display-buffer-reuse-window"]]), quad(bw("a")))"#),
        r#"["same","window",true,"a"]"#
    );
}

#[test]
fn quitting_a_reused_window_gives_back_its_buffer_place_and_size() {
    let reuse = r#"(split(), e8.selectWindow(ws()[1]), e8.call("switch-to-buffer", "b"), e8.gotoChar(300), e8.setWindowStart(undefined, 200),
                   e8.selectWindow(ws()[0]), show("c", [["display-buffer-use-some-window"], ["inhibit-same-window", true]]))"#;
    // (other (#<buffer b> 201 #<marker at 301 in b> 12) #<window 1 on *scratch*> #<buffer c>) in Emacs, from 1;
    // E8 keeps the point as a position, the window's previous buffers following edits.
    assert_eq!(
        after(&format!(
            r#"({reuse}, ((q) => [q[0].description, q[1][0].name, q[1][1], q[1][2], q[1][3], q[2] === ws()[0], q[3].name])(e8.windowParameter(ws()[1], "quit-restore")))"#
        )),
        r#"["other","b",200,300,12,true,"c"]"#
    );
    // Grown meanwhile, it gets its height back; the start stays where it
    // was and the point follows the text, as a number and a marker do.
    assert_eq!(
        after(&format!(
            r#"({reuse}, win.windowResize(ws()[1], 4), globalThis.mid = sz(),
                e8.withCurrentBuffer("b", () => e8.saveExcursion(() => (e8.gotoChar(0), e8.insert("xxxxxxxxx\n")))),
                e8.selectWindow(ws()[1]), win.quitWindow(), [mid, sz(), at()[1], sel(), !!e8.getBuffer("c")])"#
        )),
        r#"[[[8,80,"*scratch*"],[16,80,"c"]],[[12,80,"*scratch*"],[12,80,"b"]],[200,310],0,true]"#
    );
    // Side by side, the width is what it gets back.
    assert_eq!(
        after(
            r#"(split(null, null, "right"), e8.selectWindow(ws()[1]), e8.call("switch-to-buffer", "b"), e8.selectWindow(ws()[0]),
                show("c", [["display-buffer-use-some-window"], ["inhibit-same-window", true]]), globalThis.q = e8.windowParameter(ws()[1], "quit-restore")[1][3],
                win.windowResize(ws()[1], 6, true), win.quitWindow(null, ws()[1]), [q, sz(), sel()])"#
        ),
        r#"[40,[[24,40,"*scratch*"],[24,40,"b"]],0]"#
    );
    // `append' puts the buffer last in the window's previous buffers.
    assert_eq!(
        after(&format!(r#"({reuse}, win.quitRestoreWindow(ws()[1], "append"), [e8.windowBuffer(ws()[1]), e8.windowPrevBuffers(ws()[1]).at(-1)[0]])"#)),
        r#"["b","c"]"#
    );
}

#[test]
fn quit_window_runs_its_hook_in_the_windows_buffer() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(e8.addHook("quit-window-hook", () => { globalThis.ran = e8.bufferName(); }), show("b", [["display-buffer-pop-up-window"]]), "")"#,
    );
    eval(&mut ed, &s, r#"(win.quitWindow(null, bw("b")), "")"#);
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([ran, sz(), sel()])"), r#"["b",[[24,80,"*scratch*"]],0]"#);
    // q in help, from the window it was shown from.
    ed.press("C-h f").unwrap();
    ed.type_text("forward-char");
    ed.press("RET").unwrap();
    ed.press("C-x o q").unwrap();
    assert_eq!(eval(&mut ed, &s, "JSON.stringify([sz(), ran])"), r#"[[[24,80,"*scratch*"]],"*Help*"]"#);
}

#[test]
fn quitting_a_frame_made_for_a_buffer_hides_or_deletes_it() {
    // Batch Emacs cannot make frames; window--delete calls
    // frame-auto-hide-function, iconify-frame, for a frame made for the
    // buffer, and deletes the frame when the buffer is killed.
    let pop = r#"(show("a", [["display-buffer-pop-up-frame"]]), globalThis.f = e8.windowFrame(bw("a")),
                 e8.windowParameter(bw("a"), "quit-restore").slice(0, 2).map((k) => k.description))"#;
    assert_eq!(after(pop), r#"["frame","frame"]"#);
    assert_eq!(after(&format!("({pop}, win.quitWindow(null, e8.frameRootWindow(f)), [e8.frameLiveP(f), e8.frameVisibleP(f)])")), r#"[true,"icon"]"#);
    assert_eq!(
        after(&format!(r#"({pop}, e8.setVariable("frame-auto-hide-function", Symbol.for("make-frame-invisible")), win.quitWindow(null, e8.frameRootWindow(f)), e8.frameVisibleP(f))"#)),
        "false"
    );
    assert_eq!(after(&format!("({pop}, win.quitWindow(true, e8.frameRootWindow(f)), [e8.frameLiveP(f), !!e8.getBuffer(\"a\")])")), "[false,false]");
}

#[test]
fn putting_a_state_makes_its_selected_windows_buffer_current() {
    // Emacs (Bug#69093): with "a" current, putting a state whose selected window shows "b" leaves "b" current.
    assert_eq!(
        after(
            r#"(e8.getBufferCreate("a"), e8.call("switch-to-buffer", "b"), globalThis.st = win.windowStateGet(),
                e8.withCurrentBuffer("a", () => (win.windowStatePut(st), e8.bufferName())))"#
        ),
        r#""b""#
    );
}
