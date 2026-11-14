//! Defining charsets, as charset.c and mule.el do (ADR 0095). Each
//! expectation is what Emacs 30.2 gives for the same calls, but where
//! Emacs's own charsets differ from E8's, as noted.

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

const MY_CS: &str = r#"e8.funcall("define-charset", "my-cs", "Test.", ":code-space", [32, 127], ":code-offset", 0x3000, ":iso-final-char", 48, ":dimension", 1);"#;

#[test]
fn a_charset_with_a_code_offset_is_defined() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(MY_CS);
    // (t 12289 33 1 48): U+3001 at code 33.
    assert_eq!(
        r(r#"return [e8.charsetp("my-cs"), e8.decodeChar("my-cs", 33), e8.encodeChar("、", "my-cs"), e8.charsetPlist("my-cs")[":dimension"], e8.charsetPlist("my-cs")[":iso-final-char"], e8.charsetPlist("my-cs")[":docstring"]];"#),
        r#"[true,"、",33,1,48,"Test."]"#
    );
    assert_eq!(r(r#"return [e8.decodeChar("my-cs", 31) ?? null, e8.encodeChar("a", "my-cs") ?? null];"#), "[null,null]");
    assert_eq!(r(r#"return e8.charsetList()[0];"#), r#""my-cs""#);
    // Its characters as one range, (12288 . 12383), with the argument.
    assert_eq!(r(r#"const got: e8.Value[] = []; e8.funcall("map-charset-chars", (range: e8.Value, arg: e8.Value) => got.push([range, arg]), "my-cs", "x"); return got;"#), r#"[[[12288,12383],"x"]]"#);
    r(r#"e8.defineCharsetAlias("my-alias", "my-cs");"#);
    assert_eq!(r(r#"return [e8.charsetp("my-alias"), e8.decodeChar("my-alias", 34)];"#), r#"[true,"。"]"#);
    assert_eq!(r(r#"return e8.defineCharsetAlias("x2", "no-charset");"#), "ERR wrong-type-argument Wrong type argument: charsetp, \"no-charset\"");
}

#[test]
fn subsets_and_supersets_take_their_codes_from_others() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(MY_CS);
    r(r#"e8.funcall("define-charset", "my-sub", "Sub.", ":code-space", [0, 255], ":subset", ["latin-iso8859-1", 32, 127, 128]);"#);
    assert_eq!(r(r#"return [e8.decodeChar("my-sub", 160), e8.encodeChar("é", "my-sub")];"#), r#"[" ",233]"#);
    r(r#"e8.funcall("define-charset", "my-sup", "Sup.", ":code-space", [0, 255], ":superset", ["ascii", ["my-cs", 128]]);"#);
    assert_eq!(r(r#"return [e8.decodeChar("my-sup", 65), e8.decodeChar("my-sup", 161), e8.charsetPlist("my-sup")[":dimension"]];"#), r#"["A","、",1]"#);
}

#[test]
fn iso_finals_name_charsets() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return [e8.isoCharset(1, 94, "B"), e8.isoCharset(2, 94, "B"), e8.isoCharset(1, 96, "A"), e8.isoCharset(1, 96, "T"), e8.isoCharset(1, 94, "I")];"#), r#"["ascii","japanese-jisx0208","latin-iso8859-1","thai-tis620","katakana-jisx0201"]"#);
    // Emacs's own chinese-sisheng has 0, which E8 has not.
    assert_eq!(r("return [e8.getUnusedIsoFinalChar(1, 94), e8.getUnusedIsoFinalChar(2, 96)];"), "[48,48]");
    r(MY_CS);
    // [32 127] is 96 characters, so it is ISO's 96-character 0.
    assert_eq!(r(r#"return [e8.isoCharset(1, 96, "0"), e8.getUnusedIsoFinalChar(1, 96)];"#), r#"["my-cs",49]"#);
    r(r#"e8.declareEquivCharset(1, 94, "0", "ascii");"#);
    assert_eq!(r(r#"return e8.isoCharset(1, 94, 48);"#), r#""ascii""#);
    assert_eq!(r("return e8.getUnusedIsoFinalChar(4, 94);"), "ERR error Invalid DIMENSION 4, it should be 1, 2, or 3");
}

#[test]
fn a_coding_can_use_a_defined_charset() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(MY_CS);
    r(r#"e8.funcall("define-coding-system", "my-cs-coding", "C.", ":coding-type", "charset", ":mnemonic", 67, ":charset-list", ["ascii", "my-cs"]);"#);
    assert_eq!(r(r#"return e8.decodeCodingString("a!", "my-cs-coding");"#), r#""a!""#);
    r(r#"e8.funcall("define-coding-system", "my-cs-only", "C.", ":coding-type", "charset", ":mnemonic", 67, ":charset-list", ["my-cs"]);"#);
    assert_eq!(r(r#"return [e8.decodeCodingString("!\"", "my-cs-only"), e8.encodeCodingString("、。", "my-cs-only")];"#), r#"["、。","!\""]"#);
    assert_eq!(r(r#"let n = 0; e8.funcall("map-charset-chars", () => n++, "ascii", null, 65, 70); const got: e8.Value[] = []; e8.funcall("map-charset-chars", (range: e8.Value) => got.push(range), "latin-iso8859-1"); return [n, got];"#), "[1,[[160,255]]]");
}
