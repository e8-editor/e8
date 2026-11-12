//! windmove.el's commands (ADR 0069, stage 4): moving to the window in a
//! direction, from point or an edge, wrapping and making windows, showing
//! the next command's buffer that way, and deleting and swapping with the
//! window that way. Each expectation is what Emacs 30 gives on an 80 by 24
//! root window: those that depend on where point shows from an interactive
//! terminal Emacs, as batch Emacs has no posn-at-point, the rest from
//! batch. The windows are listed from the frame's first as `[height,
//! width]`, and the selected one by its index among them.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    eval(
        &mut ed,
        &s,
        r#"(globalThis.ws = () => e8.windowList().filter((w) => w !== e8.minibufferWindow()),
          globalThis.sz = () => ws().map((w) => [e8.windowTotalHeight(w), e8.windowTotalWidth(w)]),
          globalThis.idx = () => ws().indexOf(e8.selectedWindow()),
          globalThis.bufs = () => ws().map((w) => e8.windowBuffer(w)),
          globalThis.at = (n, line, column) => (e8.selectWindow(ws()[n]), e8.gotoChar(e8.lineStart(line) + column)),
          globalThis.go = (command, ...args) => e8.conditionCase(() => (e8.call(command, ...args), idx()), { error: (e) => e.message }),
          globalThis.text = () => {
            e8.setVariable("truncate-lines", true);
            for (let i = 0; i < 40; i++) e8.insert(`line ${i} ${"x".repeat(70)}\n`);
            e8.gotoChar(0);
          }, "")"#,
    );
    eval(&mut ed, &s, "(text(), \"\")");
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

fn js(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    ed.redisplay();
    eval(ed, s, &format!("JSON.stringify({code})"))
}

/// Top left, top right and bottom: C-x 2, then C-x 3 in the top window.
fn three(ed: &mut Editor, s: &Scripting) {
    ed.press("C-x 2 C-x 3").unwrap();
    assert_eq!(js(ed, s, "[sz(), idx()]"), "[[[12,40],[12,40],[12,80]],0]");
}

#[test]
fn moving_selects_the_window_that_way() {
    let (mut ed, s) = setup();
    three(&mut ed, &s);
    assert_eq!(js(&mut ed, &s, r#"go("windmove-right")"#), "1");
    assert_eq!(js(&mut ed, &s, r#"go("windmove-down")"#), "2");
    // Down from the bottom is the minibuffer's window, which is not active.
    assert_eq!(js(&mut ed, &s, r#"go("windmove-down")"#), r#""Minibuffer is inactive""#);
    assert_eq!(js(&mut ed, &s, r#"go("windmove-up")"#), "0");
    assert_eq!(js(&mut ed, &s, r#"go("windmove-left")"#), r#""No window left from selected window""#);
    assert_eq!(js(&mut ed, &s, r#"go("windmove-up")"#), r#""No window up from selected window""#);
}

#[test]
fn moving_goes_from_where_point_is() {
    let (mut ed, s) = setup();
    three(&mut ed, &s);
    // Up from the bottom window, by point's column.
    assert_eq!(js(&mut ed, &s, r#"(at(2, 0, 50), go("windmove-up"))"#), "1");
    assert_eq!(js(&mut ed, &s, r#"(at(2, 0, 39), go("windmove-up"))"#), "0");
    assert_eq!(js(&mut ed, &s, r#"(at(2, 0, 40), go("windmove-up"))"#), "1");
    assert_eq!(js(&mut ed, &s, r#"(at(1, 0, 30), go("windmove-left"))"#), "0");
    // A full-height window on the left, two on the right: by point's line.
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x o C-x 2 C-x o C-x o").unwrap();
    assert_eq!(js(&mut ed, &s, "[sz(), idx()]"), "[[[24,40],[12,40],[12,40]],0]");
    for (line, want) in [(3, "1"), (11, "1"), (12, "2"), (15, "2")] {
        assert_eq!(js(&mut ed, &s, &format!(r#"(at(0, {line}, 0), go("windmove-right"))"#)), want, "line {line}");
    }
    assert_eq!(js(&mut ed, &s, r#"(at(2, 5, 0), go("windmove-left"))"#), "0");
}

#[test]
fn a_prefix_argument_goes_from_an_edge() {
    let (mut ed, s) = setup();
    three(&mut ed, &s);
    // Positive from the left or top edge, negative from the right or bottom.
    assert_eq!(js(&mut ed, &s, r#"(at(2, 0, 50), e8.selectWindow(ws()[2]), e8.callWithPrefix([4], "windmove-up"), idx())"#), "0");
    assert_eq!(js(&mut ed, &s, r#"(at(2, 0, 0), e8.callWithPrefix("-", "windmove-up"), idx())"#), "1");
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x o C-x 2 C-x o C-x o").unwrap();
    assert_eq!(js(&mut ed, &s, r#"(at(0, 3, 0), e8.callWithPrefix(-1, "windmove-right"), idx())"#), "2");
    assert_eq!(js(&mut ed, &s, r#"(at(0, 20, 0), e8.callWithPrefix(1, "windmove-right"), idx())"#), "1");
}

#[test]
fn windmove_wrap_around_goes_round_the_frame() {
    let (mut ed, s) = setup();
    three(&mut ed, &s);
    eval(&mut ed, &s, r#"(e8.setVariable("windmove-wrap-around", true), "")"#);
    assert_eq!(js(&mut ed, &s, r#"(at(0, 0, 0), go("windmove-left"))"#), "1");
    assert_eq!(js(&mut ed, &s, r#"go("windmove-right")"#), "0");
    assert_eq!(js(&mut ed, &s, r#"go("windmove-up")"#), "2");
    // Down from the bottom wraps to the top, before the minibuffer's window.
    assert_eq!(js(&mut ed, &s, r#"go("windmove-down")"#), "0");
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x o C-x 2 C-x o C-x o").unwrap();
    eval(&mut ed, &s, r#"(e8.setVariable("windmove-wrap-around", true), "")"#);
    assert_eq!(js(&mut ed, &s, r#"(at(2, 5, 0), go("windmove-right"))"#), "0");
    assert_eq!(js(&mut ed, &s, r#"(at(1, 2, 0), go("windmove-right"))"#), "0");
}

#[test]
fn windmove_create_window_and_no_other_window() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(e8.setVariable("windmove-create-window", true), "")"#);
    assert_eq!(js(&mut ed, &s, r#"[go("windmove-left"), sz()]"#), "[0,[[24,40],[24,40]]]");
    let (mut ed, s) = setup();
    ed.press("C-x 3").unwrap();
    eval(&mut ed, &s, r#"(e8.setWindowParameter(ws()[1], "no-other-window", true), "")"#);
    assert_eq!(js(&mut ed, &s, r#"go("windmove-right")"#), r#""No window right from selected window""#);
    eval(&mut ed, &s, r#"(e8.setVariable("windmove-allow-all-windows", true), "")"#);
    assert_eq!(js(&mut ed, &s, r#"go("windmove-right")"#), "1");
}

#[test]
fn the_default_keybindings_go_in_windmove_mode_map() {
    let (mut ed, s) = setup();
    ed.press("C-x 3").unwrap();
    ed.call("windmove-default-keybindings", vec![]).unwrap();
    ed.press("S-<right>").unwrap();
    assert_eq!(js(&mut ed, &s, "idx()"), "1");
    ed.press("S-<left>").unwrap();
    assert_eq!(js(&mut ed, &s, "idx()"), "0");
    ed.call("windmove-delete-default-keybindings", vec![]).unwrap();
    ed.call("windmove-display-default-keybindings", vec![]).unwrap();
    ed.call("windmove-swap-states-default-keybindings", vec![]).unwrap();
    assert_eq!(
        js(&mut ed, &s, r#"["C-x S-<down>", "M-S-<left>", "M-S-0", "M-S-t"].map((k) => e8.lookupKey("windmove-mode-map", k))"#),
        r#"["windmove-delete-down","windmove-display-left","windmove-display-same-window","windmove-display-new-tab"]"#
    );
    // E8's keys have no super modifier: S-s-<up> and the rest are not bound.
    assert_eq!(js(&mut ed, &s, r#"e8.keymapBindings("windmove-mode-map").filter(([, c]) => c.startsWith("windmove-swap")).length"#), "0");
    eval(&mut ed, &s, r#"(import("windmove").then((m) => m.windmoveSwapStatesDefaultKeybindings(["control", "shift"])), "")"#);
    assert_eq!(js(&mut ed, &s, r#"e8.lookupKey("windmove-mode-map", "C-S-<up>")"#), r#""windmove-swap-states-up""#);
    // Binding again takes the command's old keys away.
    eval(&mut ed, &s, r#"(import("windmove").then((m) => m.windmoveDefaultKeybindings(["control", "meta"])), "")"#);
    assert_eq!(
        js(&mut ed, &s, r#"[e8.lookupKey("windmove-mode-map", "S-<left>") ?? null, e8.lookupKey("windmove-mode-map", "C-M-<left>")]"#),
        r#"[null,"windmove-left"]"#
    );
}

/// The windows' sizes, the selected one and their buffers after `keys`, typed with `name` given where a buffer is asked for.
fn after_keys(setup_code: &str, keys: &[&str]) -> String {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("({setup_code}, \"\")"));
    for k in keys {
        if let Some(text) = k.strip_prefix("type:") {
            ed.type_text(text);
        } else {
            ed.press(k).unwrap();
        }
    }
    js(&mut ed, &s, "[sz(), idx(), bufs()]")
}

#[test]
fn windmove_display_shows_the_next_commands_buffer_that_way() {
    let bind = r#"e8.bindKey("<f7>", "windmove-display-right"), e8.bindKey("<f8>", "windmove-display-down"), e8.bindKey("<f11>", "windmove-display-same-window"), e8.bindKey("<f12>", "windmove-display-left")"#;
    // A new window on the right, selected.
    assert_eq!(after_keys(bind, &["<f7> C-x b", "type:foo", "RET"]), r#"[[[24,40],[24,40]],1,["*scratch*","foo"]]"#);
    // C-u leaves the window selected before selected.
    assert_eq!(after_keys(bind, &["C-u <f7> C-x b", "type:foo", "RET"]), r#"[[[24,40],[24,40]],0,["*scratch*","foo"]]"#);
    // The window that is there already.
    assert_eq!(after_keys(bind, &["C-x 3 <f7> C-x b", "type:foo", "RET"]), r#"[[[24,40],[24,40]],1,["*scratch*","foo"]]"#);
    assert_eq!(after_keys(bind, &["<f8> C-x 4 b", "type:foo", "RET"]), r#"[[[12,80],[12,80]],1,["*scratch*","foo"]]"#);
    assert_eq!(after_keys(bind, &["C-x 3 <f11> C-x 4 b", "type:foo", "RET"]), r#"[[[24,40],[24,40]],0,["foo","*scratch*"]]"#);
    assert_eq!(after_keys(bind, &["C-x 3 C-x o <f12> C-h f", "type:find-file", "RET"]), r#"[[[24,40],[24,40]],0,["*Help*","*scratch*"]]"#);
    // windmove-display-no-select: t selects the old window, ignore leaves it to the command.
    let no_select = format!(r#"{bind}, e8.setVariable("windmove-display-no-select", true)"#);
    assert_eq!(after_keys(&no_select, &["<f7> C-x b", "type:foo", "RET"]), r#"[[[24,40],[24,40]],0,["*scratch*","foo"]]"#);
    let ignore = format!(r#"{bind}, e8.setVariable("windmove-display-no-select", Symbol.for("ignore"))"#);
    assert_eq!(after_keys(&ignore, &["<f7> C-x b", "type:foo", "RET"]), r#"[[[24,40],[24,40]],1,["*scratch*","foo"]]"#);
}

#[test]
fn windmove_display_overrides_only_the_next_command() {
    let (mut ed, s) = setup();
    ed.call("windmove-display-right", vec![]).unwrap();
    ed.press("C-x b").unwrap();
    ed.type_text("foo");
    ed.press("RET C-x b").unwrap();
    ed.type_text("bar");
    ed.press("RET").unwrap();
    assert_eq!(js(&mut ed, &s, "[sz(), idx(), bufs()]"), r#"[[[24,40],[24,40]],1,["*scratch*","bar"]]"#);
    assert_eq!(
        js(&mut ed, &s, r#"[e8.variable("display-buffer-overriding-action"), e8.variable("switch-to-buffer-obey-display-actions")]"#),
        "[[[]],null]"
    );
}

#[test]
fn windmove_delete_deletes_the_window_that_way() {
    let bind = r#"e8.bindKey("<f9>", "windmove-delete-right")"#;
    assert_eq!(after_keys(bind, &["C-x 3 <f9>"]), r#"[[[24,80]],0,["*scratch*"]]"#);
    // C-u kills its buffer too; M-0 deletes the selected window instead and selects that one.
    let other = ["C-x 3 C-x o C-x b", "type:other", "RET C-x o"];
    assert_eq!(after_keys(bind, &[&other[..], &["C-u <f9>"]].concat()), r#"[[[24,80]],0,["*scratch*"]]"#);
    let (mut ed, s) = setup();
    eval(&mut ed, &s, &format!("({bind}, \"\")"));
    ed.press("C-x 3 C-x o C-x b").unwrap();
    ed.type_text("other");
    ed.press("RET C-x o C-u <f9>").unwrap();
    assert_eq!(js(&mut ed, &s, r#"e8.getBuffer("other") ?? null"#), "null");
    assert_eq!(after_keys(bind, &[&other[..], &["M-0 <f9>"]].concat()), r#"[[[24,80]],0,["other"]]"#);
    let (mut ed, s) = setup();
    ed.press("C-x 3 C-x o").unwrap();
    assert_eq!(js(&mut ed, &s, r#"go("windmove-delete-right")"#), r#""No window right from selected window""#);
}

#[test]
fn windmove_swap_states_swaps_with_the_window_that_way() {
    let bind = r#"e8.bindKey("<f10>", "windmove-swap-states-right")"#;
    // The selected window's buffer goes right, and the selection with it.
    assert_eq!(
        after_keys(bind, &["C-x 3 C-x o C-x b", "type:other", "RET C-x o <f10>"]),
        r#"[[[24,40],[24,40]],1,["other","*scratch*"]]"#
    );
    let (mut ed, s) = setup();
    assert_eq!(js(&mut ed, &s, r#"go("windmove-swap-states-right")"#), r#""No window right from selected window""#);
}

#[test]
fn window_in_direction_takes_window_els_arguments() {
    let (mut ed, s) = setup();
    three(&mut ed, &s);
    // MINIBUF t gives the minibuffer's window below the bottom one; nil and nomini do not.
    assert_eq!(
        js(
            &mut ed,
            &s,
            r#"[true, null, Symbol.for("nomini")].map((m) => e8.funcall("window-in-direction", Symbol.for("below"), ws()[2], null, null, null, m)).map((w) => w === null ? null : w === e8.minibufferWindow() ? "mini" : ws().indexOf(w))"#
        ),
        r#"["mini",null,null]"#
    );
    assert_eq!(js(&mut ed, &s, r#"[e8.funcall("window-at-side-p", ws()[0], Symbol.for("top")), e8.funcall("window-at-side-p", ws()[0], Symbol.for("bottom"))]"#), "[true,false]");
}
