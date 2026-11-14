//! The last odds of keymap.c, syntax.c, keyboard.c, dispnew.c and xdisp.c
//! (ADR 0088): describe-vector, help--describe-vector,
//! text-char-description, internal-describe-syntax-value,
//! set--this-command-keys, send-string-to-terminal and
//! display--line-is-continued-p. Each expectation is Emacs 30.2's for the
//! same calls.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript in a fresh buffer and gives what it returns as JSON, or `ERR message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!("globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()); }} catch (e: any) {{ return `ERR ${{e.message}}`; }} }})();"),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

/// What code leaves in a temporary buffer.
fn inserted(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = run(ed, s, &format!(r#"return e8.withCurrentBuffer(e8.getBufferCreate(" *describe*"), () => {{ e8.deleteRegion(e8.pointMin(), e8.pointMax()); {code}; return e8.bufferText(); }});"#));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn vectors_and_char_tables_are_described_as_emacs_describes_them() {
    let (mut ed, s) = setup();
    let sym = |names: &[&str]| names.iter().map(|n| if *n == "nil" { "null".to_string() } else { format!("Symbol.for({n:?})") }).collect::<Vec<_>>().join(", ");
    // As Emacs: "\nC-@ .. C-a\ta\nC-b\t\tb\nC-d\t\tc\n".
    assert_eq!(
        inserted(&mut ed, &s, &format!("e8.funcall('describe-vector', [{}])", sym(&["a", "a", "b", "nil", "c"]))),
        "\nC-@ .. C-a\ta\nC-b\t\tb\nC-d\t\tc\n"
    );
    // A describer of its own, followed by describe-vector's newline.
    assert_eq!(
        inserted(&mut ed, &s, &format!("e8.funcall('describe-vector', [{}], (x: any) => e8.insert(`<${{x.description}}>\\n`))", sym(&["a", "a", "b", "nil", "c"]))),
        "\nC-@ .. C-a\t<a>\n\nC-b\t\t<b>\n\nC-d\t\t<c>\n\n"
    );
    // A char-table's ranges: "\na .. e\t\tletter\nx\t\tex\n".
    assert_eq!(
        inserted(&mut ed, &s, r#"const ct = e8.makeCharTable("test"); e8.setCharTableRange(ct, [97, 101], Symbol.for("letter")); e8.aset(ct, 120, Symbol.for("ex")); e8.funcall("describe-vector", ct)"#),
        "\na .. e\t\tletter\nx\t\tex\n"
    );
    assert_eq!(
        inserted(&mut ed, &s, r#"const ct = e8.makeCharTable("test"); e8.setCharTableRange(ct, [97, 101], Symbol.for("letter")); e8.setCharTableRange(ct, [0x400, 0x4ff], Symbol.for("cyr")); e8.funcall("describe-vector", ct, (x: any) => e8.insert(x.description + "\n"))"#),
        "\na .. e\t\tletter\n\nЀ .. ӿ\t\tcyr\n\n"
    );
    assert_eq!(inserted(&mut ed, &s, "e8.funcall('describe-vector', [Symbol.for('self-insert-command')])"), "\nC-@\t\tself-insert-command\n");
}

#[test]
fn syntax_descriptors_are_described_as_emacs_describes_them() {
    let (mut ed, s) = setup();
    for (descriptor, want) in [
        (" ", "  \twhich means: whitespace"),
        ("w", "w \twhich means: word"),
        (".", ". \twhich means: punctuation"),
        ("\"", "\" \twhich means: string"),
        ("\\", "\\ \twhich means: escape"),
        ("!", "! \twhich means: comment fence"),
        ("w p", "w p\twhich means: word,\n\t  is a prefix character for ‘backward-prefix-chars’"),
        (". 1", ". 1\twhich means: punctuation,\n\t  is the first character of a comment-start sequence"),
        (
            ". 23b",
            ". 23b\twhich means: punctuation,\n\t  is the second character of a comment-start sequence,\n\t  is the first character of a comment-end sequence (comment style b)",
        ),
        ("(]", "(]\twhich means: open, matches ]"),
        ("< 4n", "< 4n\twhich means: comment,\n\t  is the second character of a comment-end sequence (nestable)"),
        ("> b", "> b\twhich means: endcomment (comment style b)"),
    ] {
        let got = inserted(&mut ed, &s, &format!("e8.funcall('internal-describe-syntax-value', e8.stringToSyntax({descriptor:?}))"));
        assert_eq!(got, want, "{descriptor:?}");
    }
    assert_eq!(inserted(&mut ed, &s, "e8.funcall('internal-describe-syntax-value', null)"), "default");
    assert_eq!(inserted(&mut ed, &s, "e8.funcall('internal-describe-syntax-value', 3)"), "invalid");
    assert_eq!(inserted(&mut ed, &s, "e8.funcall('internal-describe-syntax-value', [0, 120])"), " x\twhich means: whitespace, matches x");
}

#[test]
fn characters_keys_and_the_terminal() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // As Emacs: ("a" "^A" "^?" " " "é" " ").
    assert_eq!(r("return [97, 1, 127, 32, 233, 160].map(e8.textCharDescription);"), "[\"a\",\"^A\",\"^?\",\" \",\"é\",\"\u{a0}\"]");
    assert_eq!(r("return e8.textCharDescription(134217825);"), "ERR Wrong type argument: characterp, 134217825");
    assert_eq!(r("return e8.textCharDescription(-1);"), "ERR Wrong type argument: characterp, -1");
    // As Emacs: [97 98 99], and \370 as M-x. (E8's thisCommandKeys gives
    // the keys' description, "a b c", where Emacs gives "abc".)
    assert_eq!(r(r#"e8.funcall("set--this-command-keys", "abc"); return e8.thisCommandKeysVector();"#), r#"["a","b","c"]"#);
    assert_eq!(r(r#"e8.funcall("set--this-command-keys", "ø"); return e8.thisCommandKeysVector();"#), r#"["M-x"]"#);
    assert_eq!(r("return e8.funcall('set--this-command-keys', [1, 2]);"), "ERR Wrong type argument: stringp, (1 2)");
    // A terminal takes what is sent, for its front end to write.
    assert_eq!(r(r#"return e8.sendStringToTerminal("") ?? null;"#), "null");
    assert_eq!(r("return e8.sendStringToTerminal(3 as any);"), "ERR Wrong type argument: stringp, 3");
    assert_eq!(r("return e8.funcall('display--line-is-continued-p');"), "false");
}

#[test]
fn a_terminal_front_end_is_handed_what_is_sent() {
    let mut ed = Editor::new();
    ed.send_string_to_terminal("\x1b]0;title\x07").unwrap();
    ed.send_string_to_terminal("more").unwrap();
    assert_eq!(ed.take_terminal_output(), "\x1b]0;title\x07more");
    assert_eq!(ed.take_terminal_output(), "");
}

#[test]
fn a_wrapped_line_is_continued() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text(&"x".repeat(200));
    ed.press("C-a").unwrap();
    assert_eq!(run(&mut ed, &s, "return e8.funcall('display--line-is-continued-p');"), "true");
    ed.press("C-e").unwrap();
    assert_eq!(run(&mut ed, &s, "return e8.funcall('display--line-is-continued-p');"), "false");
}
