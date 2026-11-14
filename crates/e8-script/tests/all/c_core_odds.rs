//! The C core's odds that were left (ADR 0093). Each expectation is what
//! Emacs 30.2 gives in batch for the same calls, events written as E8's
//! keys where Emacs gives a number.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn how_e8_was_started_and_how_long_it_has_run() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return [typeof e8.invocationName(), e8.invocationName().length > 0, e8.invocationDirectory().endsWith("/")];"#), "[\"string\",true,true]");
    assert_eq!(r("return e8.daemonInitialized();"), "ERR error This function can only be called if emacs is run as a daemon");
    assert_eq!(r("const t = e8.getInternalRunTime(); return [typeof t, t > 0];"), "[\"number\",true]");
}

#[test]
fn a_terminal_that_is_no_tty_answers_as_emacs_s_batch_one() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return [e8.ttyTopFrame() ?? null, e8.ttyNoUnderline() ?? null];"), "[null,null]");
    assert_eq!(r("return e8.ttyOutputBufferSize();"), "ERR error Not a tty terminal");
    assert_eq!(r(r#"return e8.funcall("tty--set-output-buffer-size", 4096);"#), "ERR error Not a tty terminal");
    assert_eq!(r("return e8.openTermscript(null);"), "ERR error Current frame is not on a tty device");
    assert_eq!(r("return [e8.newlineCacheCheck() ?? null, e8.setBufferRedisplay(\"x\", 1, \"set\", null) ?? null, e8.cancelKbdMacroEvents() ?? null];"), "[null,null,null]");
    assert_eq!(r(r#"return e8.funcall("re--describe-compiled", "a");"#), "ERR error Not available: rebuild with --enable-checking");
    assert_eq!(r(r#"return [e8.funcall("interactive") ?? null, e8.funcall("internal--track-mouse", () => e8.variable("track-mouse"))];"#), "[null,true]");
    assert_eq!(r("return e8.setMinibufferWindow(e8.minibufferWindow()) === e8.minibufferWindow();"), "true");
    assert_eq!(r("return e8.setMinibufferWindow(e8.selectedWindow());"), "ERR error Window is not a minibuffer window");
}

#[test]
fn a_tty_takes_its_terminal_settings() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_terminal_device(Some("/dev/ttys001".into()), Some("xterm-256color".into()));
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return e8.ttyTopFrame() === e8.selectedFrame();"), "true");
    assert_eq!(r(r#"e8.funcall("tty--set-output-buffer-size", 4096); return e8.ttyOutputBufferSize();"#), "4096");
    r("e8.ttyNoUnderline();");
    assert!(ed.describe_frame(ed.selected_frame(), 1.0).no_underline);
}

#[test]
fn events_are_parsed_and_made_as_emacs_makes_them() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    let parse = |r: &mut dyn FnMut(&str) -> String, symbol: &str| r(&format!("return e8.internalEventSymbolParseModifiers({symbol:?});"));
    for (symbol, expected) in [
        ("mouse-1", r#"["mouse-1","click"]"#),
        ("down-mouse-1", r#"["mouse-1","down"]"#),
        ("C-mouse-12", r#"["mouse-12","control"]"#),
        ("wheel-up", r#"["wheel-up","click"]"#),
        ("x", r#"["x"]"#),
        ("C-M-x", r#"["x","meta","control"]"#),
        ("C-M-S-s-H-A-x", r#"["x","meta","control","shift","hyper","super","alt"]"#),
        ("up-mouse-2", r#"["mouse-2","click","up"]"#),
        ("C-down-mouse-3", r#"["mouse-3","control","down"]"#),
        ("double-down-mouse-1", r#"["mouse-1","double","down"]"#),
        ("A-H-S-triple-wheel-up", r#"["wheel-up","shift","hyper","alt","triple"]"#),
        ("s-down-mouse-1", r#"["mouse-1","super","down"]"#),
    ] {
        assert_eq!(parse(&mut r, symbol), expected, "{symbol}");
    }
    let convert = |r: &mut dyn FnMut(&str) -> String, list: &str| r(&format!("return e8.eventConvertList({list});"));
    for (list, expected) in [
        (r#"["control", 97]"#, "C-a"),
        (r#"["control", "a"]"#, "C-a"),
        (r#"["control", 65]"#, "C-S-a"),
        (r#"["meta", "control", 97]"#, "C-M-a"),
        (r#"["shift", 97]"#, "A"),
        (r#"["shift", 65]"#, "S-A"),
        (r#"["control", "shift", 97]"#, "C-S-a"),
        (r#"["control", 233]"#, "C-é"),
        (r#"["hyper", "super", "alt", 120]"#, "A-H-s-x"),
        (r#"["control", 1]"#, "C-a"),
        (r#"["control", 127]"#, "C-DEL"),
        (r#"["control", 63]"#, "C-?"),
        (r#"["control", 32]"#, "C-SPC"),
        (r#"["control", 64]"#, "C-@"),
        (r#"["meta", 1]"#, "C-M-a"),
        (r#"["down", "mouse-1"]"#, "<down-mouse-1>"),
        (r#"["control", "meta", "shift", "f1"]"#, "C-M-S-<f1>"),
        (r#"["triple", "mouse-3"]"#, "<triple-mouse-3>"),
        (r#"["click", "f5"]"#, "<f5>"),
        (r#"["control", "return"]"#, "C-<return>"),
    ] {
        assert_eq!(convert(&mut r, list), format!("{expected:?}"), "{list}");
    }
    assert_eq!(convert(&mut r, r#"["a", "b"]"#), "ERR error Two bases given in one event");
}

#[test]
fn image_maps_and_gnutls_errors_answer_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return e8.lookupImageMap([[["rect", [[0, 0], [10, 10]]], "area1", ["help-echo", "x"]]], 5, 5);"#), r#"[["rect",[[0,0],[10,10]]],"area1",["help-echo","x"]]"#);
    let map = r#"[[["circle", [[5, 5], 3]], "c1", null], [["poly", [0, 0, 10, 0, 10, 10]], "p1", null]]"#;
    assert_eq!(r(&format!("return e8.lookupImageMap({map}, 9, 1)[1];")), r#""p1""#);
    assert_eq!(r(&format!("return e8.lookupImageMap({map}, 5, 6)[1];")), r#""c1""#);
    assert_eq!(r(&format!("return e8.lookupImageMap({map}, 1, 9) ?? null;")), "null");
    assert_eq!(r("return e8.lookupImageMap(null, 1, 1) ?? null;"), "null");
    assert_eq!(
        r(r#"return [e8.gnutlsErrorFatalp(true), e8.gnutlsErrorFatalp("gnutls-e-again"), e8.gnutlsErrorFatalp(-28), e8.gnutlsErrorFatalp(-50), e8.gnutlsErrorFatalp(-10), e8.gnutlsErrorFatalp(0)];"#),
        "[false,false,false,true,true,false]"
    );
}

#[test]
fn the_menu_bar_menu_at_a_place_is_found() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, r#"e8.call("menu-bar-mode");"#);
    ed.redisplay();
    // The first menu, and the blank after its label, are File's, bound to <file>.
    assert_eq!(run(&mut ed, &s, "return e8.menuBarMenuAtXY(0, 0);"), r#""file""#);
    let width = ed.menu_bar(ed.selected_frame()).unwrap()[0].width;
    assert_eq!(run(&mut ed, &s, &format!("return e8.funcall(\"menu-bar-menu-at-x-y\", {}, 0);", width - 1)), r#""file""#);
    assert_ne!(run(&mut ed, &s, &format!("return e8.menuBarMenuAtXY({width}, 0);")), r#""file""#);
    // Below the menu bar there is none.
    assert_eq!(run(&mut ed, &s, "return e8.menuBarMenuAtXY(0, 5) ?? null;"), "null");
}
