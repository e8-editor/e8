//! fns.c's string and buffer primitives (ADR 0098). Each expectation is
//! what Emacs 30.2 gives for the same calls; bytes are strings of
//! characters U+0000 to U+00FF.

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
fn base64_encodes_and_decodes_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return [e8.base64EncodeString("hello world"), e8.base64EncodeString("hi", true)];"#), r#"["aGVsbG8gd29ybGQ=","aGk="]"#);
    // Broken after 76 characters.
    assert_eq!(
        r(r#"return e8.base64EncodeString("hello world, a long line that goes past seventy six characters of base64 output to wrap");"#),
        r#""aGVsbG8gd29ybGQsIGEgbG9uZyBsaW5lIHRoYXQgZ29lcyBwYXN0IHNldmVudHkgc2l4IGNoYXJh\nY3RlcnMgb2YgYmFzZTY0IG91dHB1dCB0byB3cmFw""#
    );
    assert_eq!(r(r#"return [e8.base64urlEncodeString("\xff\xfe\xfd"), e8.base64urlEncodeString("\xff\xfe", true)];"#), r#"["__79","__4"]"#);
    assert_eq!(r(r#"return [e8.base64DecodeString("aGVsbG8="), e8.base64DecodeString("_-8", true), e8.base64DecodeString("aGVs!bG8=", null, true)];"#), r#"["hello","ÿï","hello"]"#);
    assert_eq!(r(r#"return e8.base64DecodeString("a!");"#), "ERR error Invalid base64 data");
    assert_eq!(r(r#"return e8.base64EncodeString("é　");"#), "ERR error Multibyte character in data for base64 encoding");
    assert_eq!(r(r#"e8.insert("hello"); const n = e8.base64EncodeRegion(0, 5); return [n, e8.bufferSubstringNoProperties(0, e8.pointMax())];"#), r#"[8,"aGVsbG8="]"#);
    assert_eq!(r(r#"const n = e8.base64DecodeRegion(0, 8); return [n, e8.bufferSubstringNoProperties(0, e8.pointMax())];"#), r#"[5,"hello"]"#);
}

#[test]
fn strings_are_compared_measured_and_searched() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    // -3 t -3 t, then 3 1.
    assert_eq!(
        r(r#"return [e8.compareStrings("abc", null, null, "abd", null, null), e8.compareStrings("abc", null, null, "ABC", null, null, true), e8.compareStrings("ab", null, null, "abc", null, null), e8.compareStrings("hello", 1, 3, "xell", 1, 3), e8.compareStrings("abc", 0, null, "ab", 0, null), e8.compareStrings("b", null, null, "a", null, null)];"#),
        "[-3,true,-3,true,3,1]"
    );
    assert_eq!(r(r#"return [e8.stringDistance("kitten", "sitting"), e8.stringDistance("ab", "ba", true), e8.stringDistance("é", "e", true), e8.stringDistance("日本", "日")];"#), "[3,2,2,1]");
    assert_eq!(r(r#"return [e8.stringSearch("lo", "hello hello"), e8.stringSearch("lo", "hello hello", 4), e8.stringSearch("z", "abc") ?? null, e8.stringSearch("é", "aébé", 2)];"#), "[3,9,null,3]");
    assert_eq!(r(r#"return [e8.stringCollateLessp("a", "B"), e8.stringCollateEqualp("a", "A", null, true), e8.stringCollateEqualp("a", "A")];"#), "[false,true,false]");
}

#[test]
fn buffers_are_hashed_and_measured() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r("return e8.bufferLineStatistics();"), "[0,0,0]");
    r(r#"e8.insert("abc\nlonger line\n\nx");"#);
    assert_eq!(r("return [e8.bufferHash(), e8.bufferLineStatistics()];"), r#"["ce4d9ed9795df19359e68f813d61490edb7ca856",[4,11,3.7499999999999996]]"#);
    r(r#"e8.deleteRegion(0, e8.pointMax()); e8.insert("ab\ncde\n");"#);
    assert_eq!(r("return e8.bufferLineStatistics();"), "[2,3,2.5]");
    assert_eq!(r("const l = e8.loadAverage(); const f = e8.loadAverage(true); return [l.length, Number.isInteger(l[0]), f.length];"), "[3,true,3]");
    assert_eq!(r(r#"return [e8.localeInfo("days")[0], e8.localeInfo("months")[11], e8.localeInfo("paper") ?? null];"#), r#"["Sunday","December",null]"#);
    assert_eq!(r(r#"return [e8.stringAsUnibyte("é"), e8.stringToMultibyte("abc")];"#), r#"["Ã©","abc"]"#);
}
