//! The C core's primitives by Emacs's own names (ADR 0090): format and
//! format-message, characters and strings, key descriptions, the buffer,
//! window and minibuffer queries. Each expectation is Emacs 30.2's for
//! the same calls, positions from 1 made E8's from 0.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(ed, "test.ts", format!("globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()); }} catch (e: any) {{ return `ERR ${{e.message}}`; }} }})();"))
        .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn format_formats_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut f = |args: &str| {
        let got = run(&mut ed, &s, &format!("return e8.format({args});"));
        serde_json::from_str::<String>(&got).unwrap_or(got)
    };
    assert_eq!(f(r#""%s|%S|%d|%5d|%-5d|%05d|%+d|% d|%x|%X|%#x|%o|%#o|%c", "a\"b", "a\"b", 42, 42, 42, 42, 42, 42, 255, 255, 255, 8, 8, 122"#), "a\"b|\"a\\\"b\"|42|   42|42   |00042|+42| 42|ff|FF|0xff|10|010|z");
    assert_eq!(f(r#""%.2f|%10.3f|%e|%.3e|%g|%g|%g|%.3g|%#g", 3.14159, 2.5, 12345.678, 0.000123, 0.0001, 100000, 1234567, 3.14159, 1.5"#), "3.14|     2.500|1.234568e+04|1.230e-04|0.0001|100000|1.23457e+06|3.14|1.50000");
    assert_eq!(f(r#""%2$s %1$s %s", "a", "b""#), "b a b");
    assert_eq!(f(r#""%-6s|%6s|%.2s", "ab", "ab", "abcdef""#), "ab    |    ab|ab");
    assert_eq!(f(r#""%d", 3.7"#), "3");
    assert_eq!(f(r#""%s %s", 1, [Symbol.for("a"), "b"]"#), "1 (a b)");
    assert_eq!(f(r#""%S", [Symbol.for("a"), "b"]"#), "(a \"b\")");
    assert_eq!(f(r#""%.5d|%08.3d", 42, 42"#), "00042|     042");
    assert_eq!(f(r#""100%%""#), "100%");
    assert_eq!(f(r#""%d""#), "ERR Not enough arguments for format string");
    assert_eq!(f(r#""%d", "x""#), "ERR Format specifier doesn’t match argument type");
    assert_eq!(f(r#""%q", 1"#), "ERR Invalid format operation %q");
    assert_eq!(f(r#""%""#), "ERR Format string ends in middle of format specifier");
    assert_eq!(run(&mut ed, &s, r#"return e8.formatMessage("`foo' %s", "x");"#), r#""‘foo’ x""#);
}

#[test]
fn characters_strings_and_keys_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return [e8.charToString(233), e8.stringToChar(''), e8.stringToChar('xy'), e8.string(97, 98)];"), r#"["é",0,120,"ab"]"#);
    assert_eq!(r("return [...e8.unibyteString(97, 255)].map((c) => c.codePointAt(0));"), "[97,255]");
    assert_eq!(r("return e8.unibyteString(256);"), "ERR Args out of range: 256, 0, 255");
    assert_eq!(r("return [e8.characterp(65), e8.characterp(-1), e8.characterp(4194304), e8.maxChar(), e8.maxChar(true)];"), "[true,false,false,4194303,1114111]");
    assert_eq!(r("return [e8.charWidth(97), e8.charWidth(20013), e8.charWidth(9)];"), "[1,2,8]");
    // As Emacs: ("C-x C-f" "M-x" "C-c a" "C-x" "<f1>" "f1").
    assert_eq!(
        r("return [e8.keyDescription([24, 6]), e8.keyDescription([134217848]), e8.keyDescription([97], [3]), e8.singleKeyDescription(24), e8.singleKeyDescription(Symbol.for('f1')), e8.singleKeyDescription(Symbol.for('f1'), true)];"),
        r#"["C-x C-f","M-x","C-c a","C-x","<f1>","f1"]"#
    );
    assert_eq!(r("return [e8.charEqual(97, 65), e8.letBind({ 'case-fold-search': null }, () => e8.charEqual(97, 65))];"), "[true,false]");
    assert_eq!(r("return [e8.ngettext('file', 'files', 1), e8.ngettext('file', 'files', 2)];"), r#"["file","files"]"#);
    assert_eq!(r(r#"return [e8.assocString("B", [["a", 1], ["b", 2]], true), e8.assocString("B", [["a", 1], ["b", 2]]) ?? null];"#), r#"[["b",2],null]"#);
    assert_eq!(r("return e8.byteToString(200).codePointAt(0);"), "200");
}

#[test]
fn buffers_windows_and_the_minibuffer_by_their_names() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: (0 98 (97 0)), in E8's characters.
    assert_eq!(r(r#"e8.insert("ab"); const a = [e8.followingChar(), e8.precedingChar()]; e8.gotoChar(0); return [...a, e8.followingChar(), e8.precedingChar()];"#), "[0,98,97,0]");
    assert_eq!(r("return [e8.bufferModifiedP(), e8.restoreBufferModifiedP(null), e8.bufferModifiedP()];"), "[true,null,false]");
    assert_eq!(r(r#"e8.getBufferCreate("other"); return e8.setBuffer("other").name === "other" && e8.bufferName() === "other";"#), "true");
    assert_eq!(r("return e8.getFileBuffer('/no/such/file') ?? null;"), "null");
    assert_eq!(r("return [e8.minibufferp(), e8.minibufferPrompt() ?? null];"), "[false,null]");
    assert_eq!(r("return [e8.windowBodyHeight() > 0, e8.windowBodyWidth() > 0, e8.windowTextHeight() === e8.windowBodyHeight()];"), "[true,true,true]");
    assert_eq!(r("return e8.setFrameSelectedWindow(null, e8.selectedWindow()) === e8.selectedWindow();"), "true");
    assert_eq!(r("e8.setBuffer('other'); return [e8.funcall('save-current-buffer', () => { e8.setBuffer('*scratch*'); return e8.bufferName(); }), e8.bufferName()];"), r#"["*scratch*","other"]"#);
    assert!(!r("return e8.funcallInteractively(() => e8.calledInteractivelyP?.() ?? 'ran');").is_empty());
    assert_eq!(r("let n = 0; e8.funcall('map-keymap', () => { n++; }, e8.makeSparseKeymap('help-mode-map')); return n > 0;"), "true");
}

#[test]
fn the_line_and_scroll_commands_by_their_names() {
    let (mut ed, s) = setup();
    ed.type_text("one\ntwo\nthree");
    ed.call("beginning-of-line", vec![e8_core::Arg::Int(1)]).unwrap();
    assert_eq!(ed.buffer().point(), 8);
    ed.call("beginning-of-line", vec![e8_core::Arg::Int(0)]).unwrap();
    assert_eq!(ed.buffer().point(), 4);
    ed.call("end-of-line", vec![e8_core::Arg::Int(1)]).unwrap();
    assert_eq!(ed.buffer().point(), 7);
    assert_eq!(run(&mut ed, &s, "return e8.commandNames().includes('scroll-up') && e8.commandNames().includes('scroll-down');"), "true");
}

/// Code calls scroll-up and scroll-down with a count of lines, or none for
/// nearly a screen, as Lisp calls (scroll-up 3) and (scroll-up).
#[test]
fn scroll_up_and_down_take_a_count_from_code() {
    let (mut ed, s) = setup();
    ed.type_text(&"x\n".repeat(100));
    ed.set_window_size(ed.selected_window(), 80, 10);
    ed.call("beginning-of-buffer", vec![]).unwrap();
    ed.redisplay();
    // Each line is two characters, so a window start of 2n is line n.
    assert_eq!(run(&mut ed, &s, "e8.call('scroll-up', 3); return e8.windowStart();"), "6");
    assert_eq!(run(&mut ed, &s, "e8.call('scroll-down', 1); return e8.windowStart();"), "4");
    assert_eq!(run(&mut ed, &s, "e8.call('scroll-up'); return e8.windowStart() > 4;"), "true");
    assert_eq!(run(&mut ed, &s, "const before = e8.windowStart(); e8.call('scroll-down'); return e8.windowStart() < before;"), "true");
}
