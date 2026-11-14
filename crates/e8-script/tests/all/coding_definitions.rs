//! Defining coding systems, as coding.c and mule.el do (ADR 0094). Each
//! expectation is what Emacs 30.2 gives for the same calls; bytes are
//! strings of characters U+0000 to U+00FF.

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
fn a_charset_coding_is_defined_and_used() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.funcall("define-coding-system", "my-latin2", "Test.", ":coding-type", "charset", ":mnemonic", 90, ":charset-list", ["iso-8859-2"], ":mime-charset", "my-l2");"#);
    assert_eq!(
        r(r#"return [e8.codingSystemType("my-latin2"), e8.codingSystemMnemonic("my-latin2"), e8.codingSystemGet("my-latin2", ":mime-charset"), e8.codingSystemGet("my-latin2", ":docstring")];"#),
        r#"["charset","Z","my-l2","Test."]"#
    );
    // "a\261b" both ways.
    assert_eq!(r(r#"return e8.encodeCodingString("aąb", "my-latin2");"#), r#""a±b""#);
    assert_eq!(r(r#"return e8.decodeCodingString("a\xb1b", "my-latin2");"#), r#""aąb""#);
    assert_eq!(r(r#"return e8.codingSystemEolType("my-latin2");"#), r#"["my-latin2-unix","my-latin2-dos","my-latin2-mac"]"#);
    assert_eq!(r(r#"return [e8.codingSystemBase("my-latin2-dos"), e8.codingSystemAliases("my-latin2")];"#), r#"["my-latin2",["my-latin2"]]"#);
    assert_eq!(r(r#"return e8.codingSystemList(true).includes("my-latin2");"#), "true");
    // Characters it cannot write are found, as for E8's own codings.
    assert_eq!(r(r#"return e8.findCodingSystemsString("ą").includes("my-latin2");"#), "true");
    assert_eq!(r(r#"return e8.findCodingSystemsString("é").includes("my-latin2");"#), "true");
    assert_eq!(r(r#"return e8.findCodingSystemsString("ж").includes("my-latin2");"#), "false");
}

#[test]
fn aliases_name_coding_systems() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.funcall("define-coding-system", "my-latin2", "Test.", ":coding-type", "charset", ":mnemonic", 90, ":charset-list", ["iso-8859-2"]);"#);
    r(r#"e8.defineCodingSystemAlias("my-l2", "my-latin2");"#);
    assert_eq!(r(r#"return [e8.codingSystemAliases("my-latin2"), e8.codingSystemBase("my-l2-unix")];"#), r#"[["my-latin2","my-l2"],"my-latin2"]"#);
    r(r#"e8.defineCodingSystemAlias("UTF8X", "utf-8");"#);
    assert_eq!(r(r#"return [e8.codingSystemP("UTF8X"), e8.codingSystemBase("UTF8X"), e8.codingSystemEolType("UTF8X")];"#), r#"[true,"utf-8",["utf-8-unix","utf-8-dos","utf-8-mac"]]"#);
    assert_eq!(r(r#"return e8.defineCodingSystemAlias("x1", "nonexistent-cs");"#), "ERR coding-system-error Invalid coding system: nonexistent-cs");
}

#[test]
fn unicode_and_raw_codings_take_their_options() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    r(r#"e8.funcall("define-coding-system", "my-u8", "U8.", ":coding-type", "utf-8", ":mnemonic", 117, ":bom", true);"#);
    assert_eq!(r(r#"return [e8.codingSystemType("my-u8"), e8.encodeCodingString("é", "my-u8"), e8.codingSystemGet("my-u8", ":bom")];"#), r#"["utf-8","ï»¿Ã©",true]"#);
    r(r#"e8.funcall("define-coding-system", "my-u16", "U16.", ":coding-type", "utf-16", ":mnemonic", 118, ":endian", "little", ":bom", null);"#);
    assert_eq!(r(r#"return e8.encodeCodingString("é", "my-u16");"#), r#""é\u0000""#);
    r(r#"e8.funcall("define-coding-system", "my-raw", "R.", ":coding-type", "raw-text", ":mnemonic", 114, ":eol-type", "dos");"#);
    assert_eq!(r(r#"return [e8.codingSystemEolType("my-raw"), e8.encodeCodingString("a\nb", "my-raw")];"#), r#"[1,"a\r\nb"]"#);
}

#[test]
fn which_codings_can_write_text_and_the_terminal_s() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"e8.insert("abc"); return e8.findCodingSystemsRegionInternal(0, 3);"#), "true");
    assert_eq!(r(r#"return e8.findCodingSystemsRegionInternal("abc", null);"#), "true");
    assert_eq!(r(r#"e8.deleteRegion(0, e8.pointMax()); e8.insert("aé"); return [e8.bufferSubstringNoProperties(0, e8.pointMax()), e8.findCodingSystemsRegionInternal(0, 2) === true];"#), r#"["aé",false]"#);
    assert_eq!(
        r(r#"const l = e8.findCodingSystemsRegionInternal(0, 2) as string[]; return [l.includes("iso-latin-1"), l.includes("us-ascii"), l.includes("utf-8"), l.includes("raw-text")];"#),
        "[true,false,true,true]"
    );
    assert_eq!(r(r#"return (e8.findCodingSystemsRegionInternal(0, 2, ["utf-8"]) as string[]).includes("utf-8");"#), "false");
    assert_eq!(r(r#"return [e8.setSafeTerminalCodingSystemInternal("utf-8") ?? null, e8.variable("safe-terminal-coding-system")];"#), r#"[null,"utf-8"]"#);
    assert_eq!(r(r#"return e8.setSafeTerminalCodingSystemInternal("no-such");"#), "ERR coding-system-error Invalid coding system: no-such");
}
