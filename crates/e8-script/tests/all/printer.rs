//! The printer and the rest of the Lisp runtime by Emacs's names (ADR
//! 0102). Each expectation is what Emacs 30.2 gives for the same calls.

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
fn values_are_printed_where_printcharfun_says() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // "(1 \"a\")\n\"x\"\n\nZ", and the answers "q" t 97.
    assert_eq!(
        r(r#"const b = e8.getBufferCreate("out"); e8.prin1([1, "a"], b); e8.print("x", b); e8.terpri(b); e8.writeChar(90, b);
            return e8.withCurrentBuffer(b, () => e8.bufferSubstringNoProperties(0, e8.pointMax()));"#),
        r#""(1 \"a\")\n\"x\"\n\nZ""#
    );
    assert_eq!(r(r#"const b = e8.getBufferCreate("out"); return [e8.prin1("q", b), e8.terpri(b, true), e8.writeChar(97, b)];"#), r#"["q",true,97]"#);
    // Into a marker, which moves past what it wrote: "axb" 3.
    assert_eq!(
        r(r#"const b = e8.getBufferCreate("m"); return e8.withCurrentBuffer(b, () => { e8.insert("ab"); const m = e8.makeMarker(1); e8.prin1(Symbol.for("x"), m); return [e8.bufferSubstringNoProperties(0, e8.pointMax()), m.position]; });"#),
        r#"["axb",2]"#
    );
    // A function gets each character: (34 104 105 34).
    assert_eq!(r(r#"const chars: number[] = []; e8.prin1("hi", (c: number) => chars.push(c)); return chars;"#), "[34,104,105,34]");
    // With ensure, a newline only where a line has text: t nil.
    assert_eq!(r(r#"const b = e8.getBufferCreate("t"); return e8.withCurrentBuffer(b, () => { e8.insert("abc"); const first = e8.terpri(b, true); return [first, e8.terpri(b, true)]; });"#), "[true,false]");
}

#[test]
fn the_runtime_s_odds_answer_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return e8.textQuotingStyle();"), r#""curve""#);
    assert_eq!(r(r#"return [e8.stringVersionLessp("foo2.png", "foo12.png"), e8.stringVersionLessp("a", "b"), e8.stringVersionLessp("abc10", "abc9"), e8.stringVersionLessp("1.10", "1.9")];"#), "[true,true,false,false]");
    assert_eq!(r(r#"return [e8.stringBytes("abc"), e8.stringBytes("é"), e8.stringBytes(String.fromCodePoint(0x10ffff))];"#), "[3,2,1]");
    assert_eq!(r(r#"return [e8.multibyteStringP("abc"), e8.multibyteStringP("é"), e8.multibyteStringP(1)];"#), "[false,true,false]");
    // (1 2), then 5 once the let ends.
    assert_eq!(
        r(r#"e8.defineVariable({ name: "my-v", value: 1 }); const inside = e8.letBind({ "my-v": 2 }, () => { const top = e8.defaultToplevelValue("my-v"); e8.setDefaultToplevelValue("my-v", 5); return [top, e8.variable("my-v")]; }); return [inside, e8.variable("my-v")];"#),
        "[[1,2],5]"
    );
    assert_eq!(r(r#"const b = e8.getBufferCreate("v"); const local = e8.withCurrentBuffer(b, () => { e8.makeLocalVariable("my-v"); return e8.variableBindingLocus("my-v") !== undefined; }); return [local, e8.variableBindingLocus("my-v") ?? null];"#), "[true,null]");
    assert_eq!(r(r#"return [e8.stringToUnibyte("abc"), e8.stringMakeUnibyte("é")];"#), r#"["abc","é"]"#);
    assert_eq!(r(r#"return e8.stringToUnibyte("あ");"#), "ERR error Cannot convert character at index 0 to unibyte");
    assert_eq!(r(r#"const n = e8.random(10); e8.random("seed"); const a = e8.random(1000); e8.random("seed"); return [Number.isInteger(n) && n >= 0 && n < 10, a === e8.random(1000)];"#), "[true,true]");
    assert_eq!(r(r#"return [e8.valueLess(1, 2), e8.valueLess("b", "a"), e8.valueLess([1, 2], [1, 3]), e8.funcall("value<", Symbol.for("a"), Symbol.for("b"))];"#), "[true,false,true,true]");
    assert_eq!(r(r#"return [e8.documentationStringp("x"), e8.documentationStringp(3), e8.documentationStringp(null)];"#), "[true,true,false]");
}
