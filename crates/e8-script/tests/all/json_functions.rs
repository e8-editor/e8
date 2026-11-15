//! JSON as Emacs's json.c reads and writes it (ADR 0100). Each expectation
//! is what Emacs 30.2 gives for the same JSON, with objects as JavaScript
//! objects where Emacs gives hash tables, and the keywords :null and
//! :false as the symbols of those names.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition message data`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})() ?? null, (k, v) => typeof v === 'symbol' ? `~${{Symbol.keyFor(v)}}` : v); }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{JSON.stringify(e.data)}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

#[test]
fn json_is_written_as_emacs_writes_it() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return e8.jsonSerialize({ a: 1, b: [true, Symbol.for(":false"), Symbol.for(":null"), "x"], c: 1.5 });"#), r#""{\"a\":1,\"b\":[true,false,null,\"x\"],\"c\":1.5}""#);
    assert_eq!(r(r#"return e8.jsonSerialize({ a: 1, b: "é\n\"" });"#), r#""{\"a\":1,\"b\":\"é\\n\\\"\"}""#);
    assert_eq!(r(r#"return [e8.jsonSerialize([]), e8.jsonSerialize(null), e8.jsonSerialize(new Map([["k", 2]]))];"#), r#"["[]","{}","{\"k\":2}"]"#);
    assert_eq!(r(r#"return e8.jsonSerialize({ a: null }, { nullObject: null });"#), r#""{\"a\":null}""#);
    assert_eq!(r(r#"return e8.jsonSerialize("\u{10FFFF}".length ? new e8.PropertizedString("x") : 1);"#), r#""\"x\"""#);
    r(r#"e8.jsonInsert({ x: 1 });"#);
    assert_eq!(r("return [e8.bufferSubstringNoProperties(0, e8.pointMax()), e8.point()];"), r#"["{\"x\":1}",7]"#);
}

#[test]
fn json_is_read_as_emacs_reads_it() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // Keys in their order, :false and :null for false and null.
    assert_eq!(r(r#"const v = e8.jsonParseString('{"a":1,"b":[true,false,null,"x"],"c":1.5}'); return [Object.keys(v), v];"#), r#"[["a","b","c"],{"a":1,"b":[true,"~:false","~:null","x"],"c":1.5}]"#);
    // ((a . 1) (b t :false nil)), with an alist's pairs as lists.
    assert_eq!(r(r#"return e8.jsonParseString('{"a":1,"b":[true,false,null]}', { objectType: "alist", arrayType: "list", nullObject: null, falseObject: Symbol.for(":false") });"#), r#"[["a",1],["b",[true,"~:false",null]]]"#);
    assert_eq!(r(r#"return e8.jsonParseString('{"a":{"b":2}}', { objectType: "plist" });"#), r#"[":a",[":b",2]]"#);
    assert_eq!(r(r#"return [e8.jsonParseString('"\\u00e9\\ud83d\\ude00"'), e8.jsonParseString(" 1e3 "), e8.jsonParseString('{"a":1,"a":2}').a];"#), r#"["é😀",1000,1]"#);
    // (json-end-of-file 1 5 5), (json-trailing-content 1 5 5) and (json-parse-error 2 3 7).
    assert_eq!(r(r#"return e8.jsonParseString('{"a":');"#), "ERR json-end-of-file [1,5,5]");
    assert_eq!(r(r#"return e8.jsonParseString("[1] x");"#), "ERR json-trailing-content [1,5,5]");
    assert_eq!(r(r#"return e8.jsonParseString("[1,\n  ?]");"#), "ERR json-parse-error [2,3,7]");
    // Each a json-parse-error and a json-error, as Emacs defines them.
    assert_eq!(r(r#"return e8.conditionCase(() => e8.jsonParseString("[1"), { "json-error": () => "caught" });"#), r#""caught""#);
    r(r#"e8.insert("[1,2] rest"); e8.gotoChar(0);"#);
    assert_eq!(r("return [e8.jsonParseBuffer(), e8.point()];"), "[[1,2],5]");
}
