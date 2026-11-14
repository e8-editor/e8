//! Coding systems and charsets as scripts use them, checked against what
//! Emacs 30.2 gives (its buffer positions count from 1, scripts' from 0).

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// The bytes a script's byte string holds.
const BYTES: &str = "(globalThis.bytes = (s) => [...s].map((c) => c.codePointAt(0)), true)";

#[test]
fn coding_systems_by_name_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.codingSystemP("sjis"), e8.codingSystemP("klingon"), e8.checkCodingSystem("latin-1"), e8.checkCodingSystem(null) ?? null,
          e8.codingSystemBase("gb18030"), e8.codingSystemAliases("utf-8"), e8.codingSystemAliases("utf-8-unix"),
          e8.codingSystemType("japanese-shift-jis"), e8.codingSystemType("euc-jp"), e8.codingSystemMnemonic("koi8-u"),
          e8.codingSystemGet("iso-latin-1", ":mime-charset"), e8.codingSystemEolType("utf-8"), e8.codingSystemEolType("utf-8-mac"),
          e8.codingSystemEolType("binary"), e8.codingSystemChangeEolConversion("utf-8", "dos"),
          e8.codingSystemChangeEolConversion("utf-8-dos", null), e8.codingSystemChangeTextConversion("utf-8-dos", "iso-latin-1"),
        ])"#,
    );
    assert_eq!(
        got,
        r#"[true,false,"iso-latin-1","utf-8",null,"chinese-gb18030",["utf-8","mule-utf-8","cp65001"],["utf-8-unix","mule-utf-8-unix","cp65001-unix"],"shift-jis","iso-2022","У","iso-8859-1",["utf-8-unix","utf-8-dos","utf-8-mac"],2,0,"utf-8-dos","utf-8","iso-latin-1-dos"]"#
            .replace(r#""iso-latin-1","utf-8",null"#, r#""iso-latin-1",null"#)
    );
    let err = s.eval_expression(&mut ed, r#"e8.conditionCase(() => e8.checkCodingSystem("klingon"), { "coding-system-error": (e) => e.data })"#).unwrap();
    assert!(err.contains("klingon"), "{err}");
}

#[test]
fn encoding_and_decoding_strings() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, BYTES);
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          bytes(e8.encodeCodingString("a€é", "iso-latin-1")), bytes(e8.encodeCodingString("aあ", "us-ascii")),
          bytes(e8.encodeCodingString("aあ", "japanese-shift-jis")), bytes(e8.encodeCodingString("x", "utf-16")),
          bytes(e8.encodeCodingString("中文", "chinese-gbk")), bytes(e8.encodeCodingString("a\n", "utf-8-mac")),
          bytes(e8.encodeCodingString("é\n", "undecided-dos")), e8.variable("last-coding-system-used"),
          e8.decodeCodingString("\x82\xa0", "japanese-shift-jis"), e8.decodeCodingString("a\r\nb\r\n", "utf-8"),
          e8.decodeCodingString("\xfe\xff\0x", "utf-16"), e8.decodeCodingString("\x80", "windows-1252"),
          bytes(e8.decodeCodingString("caf\xe9", "utf-8")).slice(3), bytes(e8.encodeCodingString(e8.decodeCodingString("caf\xe9", "utf-8"), "utf-8")),
          e8.decodeCodingString("caf\xc3\xa9", "undecided"), e8.decodeCodingString("caf\xe9", "undecided"),
        ])"#,
    );
    // Emacs: (97 32 233) (97 63) (97 130 160) (254 255 0 120) (214 208 206 196) (97 13) (195 169 13 10) "あ" "a\nb\n" "x" "€"
    assert_eq!(
        got,
        r#"[[97,32,233],[97,63],[97,130,160],[254,255,0,120],[214,208,206,196],[97,13],[195,169,13,10],"utf-8-dos","あ","a\nb\n","x","€",[1114089],[99,97,102,233],"café","café"]"#
    );
}

#[test]
fn detecting_and_finding_codings() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.detectCodingString("plain"), e8.detectCodingString("caf\xc3\xa9", true), e8.detectCodingString("caf\xe9", true),
          e8.detectCodingString("\x1b$B$\"\x1b(B", true), e8.detectCodingString("\0\x01\x02", true), e8.detectCodingString("a\r\nb\r\n", true),
          e8.findCodingSystemsString("abc"), e8.findCodingSystemsString("é€").slice(0, 1),
          e8.findCodingSystemsString("é€").includes("iso-latin-1"), e8.findCodingSystemsString("é€").includes("windows-1252"),
          e8.unencodableCharPosition(0, 3, "iso-latin-1", null, "a€b"), e8.unencodableCharPosition(0, 3, "iso-latin-1", 2, "a€€"),
        ])"#,
    );
    // Emacs: (undecided) utf-8 iso-latin-1 iso-2022-7bit no-conversion undecided-dos (undecided) 1 (1 2)
    assert_eq!(got, r#"[["undecided"],"utf-8","iso-latin-1","iso-2022-7bit","no-conversion","undecided-dos",["undecided"],["utf-8"],false,true,1,[1,2]]"#);
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("a€é"), JSON.stringify([e8.unencodableCharPosition(0, 3, "iso-latin-1"), e8.checkCodingSystemsRegion(0, 3, ["iso-latin-1", "utf-8"])]))"#,
    );
    // Emacs: 2 ((iso-latin-1 2)), counting from 1.
    assert_eq!(got, r#"[1,[["iso-latin-1",1]]]"#);
}

#[test]
fn encoding_a_region_leaves_raw_bytes_to_decode() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, BYTES);
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.insert("é"), e8.encodeCodingRegion(0, 1, "utf-8"),
          JSON.stringify([bytes(e8.bufferText()), e8.bufferSize(), e8.charCharset(e8.bufferText(0, 1))]))"#,
    );
    // Emacs: "\303\251", point-max 3, a raw byte.
    assert_eq!(got, r#"[[1114051,1114025],2,"eight-bit"]"#);
    assert_eq!(eval(&mut ed, &s, r#"(e8.decodeCodingRegion(0, 2, "utf-8"), e8.bufferText())"#), "é");
    // A raw byte shows as Emacs shows it.
    eval(&mut ed, &s, r#"e8.insert(e8.decodeCodingString("\xe9", "utf-8"))"#);
    let row = &ed.window_rows(1, true)[0];
    let shown: String = e8_core::display::row_glyphs(row, 8).iter().map(|g| g.text.as_str()).collect();
    assert_eq!(shown, "é\\351");
}

#[test]
fn charsets_and_code_points() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.charCharset("a"), e8.charCharset("é"), e8.charCharset("あ"), e8.charsetPriorityList(true),
          e8.encodeChar("あ", "japanese-jisx0208"), e8.decodeChar("japanese-jisx0208", 0x2422), e8.encodeChar("中", "chinese-gb2312"),
          e8.encodeChar("é", "iso-8859-1"), e8.encodeChar("é", "unicode"), e8.charsetp("japanese-jisx0208"), e8.charsetp("nope"),
          e8.encodeChar("ｱ", "katakana-jisx0201"), e8.encodeChar("中", "big5"), e8.encodeChar("한", "korean-ksc5601"),
          e8.decodeChar("ucs", 233), e8.charCharset("é", ["japanese-jisx0208", "iso-8859-1"]),
        ])"#,
    );
    // Emacs: ascii unicode unicode (ascii) 9250 "あ" 22096 233 233 t nil 49 42148 18257 "é" iso-8859-1
    assert_eq!(got, r#"["ascii","unicode","unicode",["ascii"],9250,"あ",22096,233,233,true,false,49,42148,18257,"é","iso-8859-1"]"#);
}

#[test]
fn preferring_a_coding_system_puts_it_first_where_the_bytes_fit() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, BYTES);
    // Shift_JIS bytes for 日本, which are Latin-1 text too, and bytes that are not Shift_JIS.
    let detect = r#"JSON.stringify([e8.detectCodingString("\x93\xfa\x96\x7b", true), e8.detectCodingString("\xff\xfe\xff", true)])"#;
    assert_eq!(eval(&mut ed, &s, detect), r#"["iso-latin-1","iso-latin-1"]"#);
    eval(&mut ed, &s, r#"e8.setCodingSystemPriority("japanese-shift-jis")"#);
    assert_eq!(eval(&mut ed, &s, detect), r#"["japanese-shift-jis","iso-latin-1"]"#);
    assert_eq!(
        eval(&mut ed, &s, "JSON.stringify(e8.codingSystemPriorityList())"),
        r#"["japanese-shift-jis","utf-8","iso-2022-7bit","iso-latin-1","iso-2022-jp","undecided"]"#
    );
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.codingSystemPriorityList(true))"), r#"["japanese-shift-jis"]"#);
}

#[test]
fn a_character_splits_into_its_charset_and_position_codes_as_emacs_does() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.splitChar("中"), e8.splitChar("a"), e8.splitChar("ÿ"),
          e8.makeChar("ascii"), e8.makeChar("iso-8859-1"), e8.makeChar("japanese-jisx0208"),
          e8.makeChar("japanese-jisx0208", 36), e8.makeChar("japanese-jisx0208", 36, 42),
          e8.makeChar("ascii", 97), e8.makeChar("latin-iso8859-1", 65), e8.makeChar("unicode", 0, 48, 66),
          e8.makeChar("big5"), e8.makeChar("big5", 164), e8.makeChar("chinese-gbk"),
          e8.makeChar("japanese-jisx0208", 164, 162), e8.makeChar("ascii", 97, 1, 2), e8.makeChar("katakana-jisx0201"),
        ])"#,
    );
    // Emacs: (unicode 0 78 45) (ascii 97) (unicode 0 0 255) 0 0 12288 12353
    // 12362 97 193 12354, then 12288 19968 19970 12354 97 65377 — a charset's
    // own least code fills the dimensions left out, an ISO charset takes the
    // low seven bits of each code, and codes past the dimension are ignored.
    assert_eq!(
        got,
        r#"[["unicode",0,78,45],["ascii",97],["unicode",0,0,255],"\u0000","\u0000","　","ぁ","お","a","Á","あ","　","一","丂","あ","a","｡"]"#
    );
}

#[test]
fn a_charset_is_named_described_and_ordered_as_emacs_names_it() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.findCharsetString(""), e8.findCharsetString("aé中"),
          e8.sortCharsets(["unicode", "ascii", "big5"]),
          e8.charsetIdInternal("ascii"), e8.charsetIdInternal("unicode"), e8.charsetIdInternal("nope") ?? null,
          e8.charsetPlist("ascii"), e8.charsetPlist("japanese-jisx0208")[":dimension"],
        ])"#,
    );
    // Emacs: nil (ascii unicode) (ascii unicode big5) 0 2 nil; its ascii plist says :dimension 1,
    // :ascii-compatible-p t, :code-space [0 127 0 0 0 0 0 0], and holds more E8 does not.
    assert_eq!(
        got,
        r#"[[],["ascii","unicode"],["ascii","unicode","big5"],0,2,null,{":name":"ascii",":dimension":1,":ascii-compatible-p":true,":code-space":[0,127]},2]"#
    );
}

#[test]
fn a_charset_keeps_what_a_script_puts_on_it() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"e8.setCharsetPlist("ascii", { ":short-name": "ASCII", ":dimension": 9 })"#);
    let got = eval(&mut ed, &s, r#"JSON.stringify([e8.charsetPlist("ascii")[":short-name"], e8.charsetPlist("ascii")[":dimension"]])"#);
    // What E8 works out for itself wins, as the computed frame parameters do.
    assert_eq!(got, r#"["ASCII",1]"#);
}

#[test]
fn preferring_a_charset_makes_char_charset_name_it() {
    let (mut ed, s) = setup();
    let before = eval(&mut ed, &s, r#"JSON.stringify([e8.charCharset("é"), e8.splitChar("é"), e8.charsetPriorityList(true)])"#);
    assert_eq!(before, r#"["unicode",["unicode",0,0,233],["ascii"]]"#);
    eval(&mut ed, &s, r#"e8.setCharsetPriority("iso-8859-1")"#);
    let after = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.charCharset("é"), e8.splitChar("é"), e8.charCharset("中"), e8.charsetPriorityList(true),
          e8.charCharset("a"), e8.splitChar("a"), e8.findCharsetString("abc"),
        ])"#,
    );
    // Emacs answers iso-8859-1 for é once it is preferred, unicode for a
    // character no preferred charset holds, and ascii for ASCII whatever is
    // preferred, as CHAR_CHARSET answers before walking the list at all.
    assert_eq!(
        after,
        r#"["iso-8859-1",["iso-8859-1",233],"unicode",["iso-8859-1"],"ascii",["ascii",97],["ascii"]]"#
    );
}

#[test]
fn a_restriction_is_walked_in_the_order_it_is_given() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([e8.charCharset("é", ["unicode", "iso-8859-1"]), e8.charCharset("é", ["iso-8859-1", "unicode"])])"#,
    );
    // Emacs: unicode, then iso-8859-1 — charset.c walks the list it is handed.
    assert_eq!(got, r#"["unicode","iso-8859-1"]"#);
}

#[test]
fn what_is_no_charset_and_no_region_is_refused_as_emacs_refuses_it() {
    let (mut ed, s) = setup();
    let mut fails = |ed: &mut Editor, code: &str| s.eval_expression(ed, code).is_err();
    assert!(fails(&mut ed, r#"e8.setCharsetPriority("nope")"#));
    assert!(fails(&mut ed, r#"e8.sortCharsets(["ascii", "nope"])"#));
    assert!(fails(&mut ed, r#"e8.setCharsetPlist("nope", {})"#));
    assert!(fails(&mut ed, r#"e8.charsetPlist("nope")"#));
    assert!(fails(&mut ed, r#"e8.makeChar("nope", 1)"#));
    // A region past the end signals rather than stopping the editor.
    assert!(fails(&mut ed, "e8.findCharsetRegion(10, 20)"));
    assert!(fails(&mut ed, "e8.findCodingSystemsRegion(10, 20)"));
    assert!(fails(&mut ed, r#"e8.detectCodingRegion(10, 20)"#));
    // Nothing of that went through.
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.charsetPriorityList(true))"#), r#"["ascii"]"#);
}

#[test]
fn a_region_and_a_position_name_their_charsets_as_emacs_does() {
    let (mut ed, s) = setup();
    ed.type_text("aé中");
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.findCharsetRegion(0, 3), e8.findCharsetRegion(0, 1),
          e8.charsetAfter(0), e8.charsetAfter(1), e8.charsetAfter(99) ?? null, e8.charsetAfter() ?? null,
        ])"#,
    );
    // Emacs: (ascii unicode) (ascii) ascii unicode nil nil, point being at the end.
    assert_eq!(got, r#"[["ascii","unicode"],["ascii"],"ascii","unicode",null,null]"#);
}

#[test]
fn shift_jis_and_big5_codes_are_characters_as_emacs_reads_them() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.decodeSjisChar(0x8140), e8.encodeSjisChar("あ"), e8.decodeBig5Char(0xa140), e8.encodeBig5Char("中"),
          e8.decodeSjisChar(65), e8.decodeSjisChar(0xb1), e8.decodeBig5Char(65), e8.encodeSjisChar("a"), e8.encodeBig5Char("a"),
          e8.multibyteCharToUnibyte("a"), e8.multibyteCharToUnibyte("é"), e8.multibyteCharToUnibyte("中"),
          e8.unibyteCharToMultibyte(65), e8.encodeChar(e8.unibyteCharToMultibyte(233), "eight-bit"),
        ])"#,
    );
    // Emacs: 12288 33440 12288 42148, then 65 65393 65 97 97 — ASCII and Shift
    // JIS's half-width katakana are one byte — then 97 233 -1 65 233.
    assert_eq!(got, r#"["　",33440,"　",42148,"A","ｱ","A",97,97,97,233,-1,"A",233]"#);
}

#[test]
fn a_unicode_property_has_the_char_table_emacs_hands_out() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.unicodePropertyTableInternal("bogus") === undefined,
          e8.unicodePropertyTableInternal("bidi-class") === e8.unicodePropertyTableInternal("bidi-class"),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("bidi-class"), "a"),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("bidi-class"), "א"),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("mirroring"), "("),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("bracket-type"), "("),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("mirrored"), "a"),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("mirrored"), "("),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("bracket-type"), "a"),
          e8.getUnicodePropertyInternal(e8.unicodePropertyTableInternal("mirroring"), "a") ?? null,
        ])"#,
    );
    // Emacs: nil for a property with no table; "L", "R", 41, "o", then "N",
    // "Y" and "n" — mirrored and bracket-type cover every character — and nil
    // for a character with no mirror.
    assert_eq!(got, r#"[true,true,"L","R",41,"o","N","Y","n",null]"#);
}

#[test]
fn a_category_set_is_its_mnemonics() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.categorySetMnemonics(e8.charCategorySet("a")), e8.makeCategorySet("la"), e8.makeCategorySet("alla"),
        ])"#,
    );
    assert_eq!(got, r#"[".Lalr","al","al"]"#);
}
