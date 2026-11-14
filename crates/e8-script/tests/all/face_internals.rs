//! Face and font internals, as xfaces.c, font.c and fontset.c give them to
//! faces.el (ADR 0085). Each expectation is what Emacs 30.2 gives for the
//! same calls, printed as Lisp prints it; where E8's faces differ, being
//! the same on every frame, the test says so.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Prints a script's value as Lisp prints it: symbols bare, strings
/// quoted, arrays as vectors, null as nil and true as t; an error as
/// `(ERR condition message)`.
const LISP: &str = r#"
globalThis.lisp = (v: any): string => {
  if (v === null || v === undefined || v === false) return "nil";
  if (v === true) return "t";
  if (typeof v === "symbol") return v.description!;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map(lisp).join(" ") + "]";
  if (v instanceof Map) return `#<map ${v.size}>`;
  return String(v);
};
globalThis.p = (f: () => any): string => {
  try { return lisp(f()); } catch (e: any) { return `(ERR ${e.symbol ?? ""} ${e.message})`; }
};
"#;

fn p(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_typescript(ed, "test.ts", format!("{LISP}\nglobalThis.result = p(() => {code});")).map(|_| ());
    got.unwrap();
    let out = s.eval_expression(ed, "globalThis.result").unwrap();
    serde_json::from_str::<String>(&out).unwrap()
}

const EMPTY: &str = "[face unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified]";

#[test]
fn lisp_faces_are_made_set_and_read_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut p = |code: &str| p(&mut ed, &s, code);
    assert_eq!(p(r#"e8.internalMakeLispFace(Symbol.for("probe-a"))"#), EMPTY);
    assert_eq!(p(r#"e8.internalLispFaceP("no-such-face")"#), "nil");
    // Each as (internal-set-lisp-face-attribute 'probe-a ATTR VALUE) gives it.
    for (attr, value, want) in [
        (":foreground", r#""red""#, "probe-a"),
        (":weight", r#"Symbol.for("bold")"#, "probe-a"),
        (":height", "1.5", "probe-a"),
        (":height", "120", "probe-a"),
        (":height", "0", "(ERR error Face height does not produce a positive integer: 0)"),
        (":height", r#""x""#, r#"(ERR error Face height does not produce a positive integer: "x")"#),
        (":weight", r#"Symbol.for("heavyish")"#, "(ERR error Invalid face weight: heavyish)"),
        (":foreground", r#""""#, r#"(ERR error Empty foreground color value: "")"#),
        (":foreground", r#"Symbol.for("red")"#, "(ERR wrong-type-argument Wrong type argument: stringp, red)"),
        (":bogus", "1", "(ERR error Invalid face attribute name: :bogus)"),
        (":underline", "true", "probe-a"),
        (":underline", r#"[Symbol.for(":color"), "blue", Symbol.for(":style"), Symbol.for("wave")]"#, "probe-a"),
        (":underline", "3", "(ERR error Invalid face underline: 3)"),
        (":box", r#"[Symbol.for(":line-width"), 2, Symbol.for(":color"), "red"]"#, "probe-a"),
        (":box", r#"Symbol.for("x")"#, "(ERR error Invalid face box: x)"),
        (":inverse-video", r#"Symbol.for("x")"#, "(ERR error Invalid inverse-video face attribute value: x)"),
        (":inverse-video", "null", "probe-a"),
        (":extend", "true", "probe-a"),
        (":inherit", r#"[Symbol.for("bold"), Symbol.for("italic")]"#, "probe-a"),
        (":inherit", r#""bold""#, r#"(ERR error Invalid face inheritance: "bold")"#),
        (":family", r#"Symbol.for("x")"#, "(ERR wrong-type-argument Wrong type argument: stringp, x)"),
        (":family", r#""Monaco""#, "probe-a"),
        (":slant", r#"Symbol.for("italic")"#, "probe-a"),
        (":width", r#"Symbol.for("condensed")"#, "probe-a"),
        (":stipple", r#"Symbol.for("x")"#, "(ERR error Invalid stipple attribute: x)"),
        (":bold", "true", "probe-a"),
        (":italic", "null", "probe-a"),
        (":reverse-video", "true", "probe-a"),
        (":distant-foreground", r#""white""#, "probe-a"),
    ] {
        let got = p(&format!(r#"e8.internalSetLispFaceAttribute(Symbol.for("probe-a"), Symbol.for("{attr}"), {value})"#));
        assert_eq!(got, want, "{attr} {value}");
    }
    // A face that is not one yet is made.
    assert_eq!(p(r#"e8.internalSetLispFaceAttribute(Symbol.for("no-face-x"), Symbol.for(":foreground"), "red")"#), "no-face-x");
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-a", ":foreground")"#), r#""red""#);
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-a", ":weight")"#), "bold");
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-a", ":slant")"#), "normal");
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-a", ":bogus")"#), "(ERR error Invalid face attribute name: :bogus)");
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-a", ":bold")"#), "(ERR error Invalid face attribute name: :bold)");
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute(Symbol.for("no-face-y"), ":weight")"#), "(ERR error Invalid face: no-face-y)");
    // unspecified, and in E8 reset, unset an attribute.
    assert_eq!(p(r#"e8.internalSetLispFaceAttribute("probe-a", ":foreground", Symbol.for("unspecified"))"#), r#""probe-a""#);
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-a", ":foreground")"#), "unspecified");
    assert_eq!(p(r#"e8.internalLispFaceEmptyP("probe-a")"#), "nil");
    // The vector holds what was set, in Emacs's order. Emacs's global
    // definition stays empty while these went to the selected frame's;
    // E8 has one definition for both.
    assert_eq!(
        p(r#"e8.internalLispFaceP("probe-a")"#),
        r#"[face "Monaco" unspecified condensed 120 bold normal [:color "blue" :style wave] t unspecified unspecified unspecified unspecified unspecified [:line-width 2 :color "red"] unspecified [bold italic] unspecified "white" t]"#
    );
}

#[test]
fn faces_compare_copy_and_empty_as_emacs_does() {
    let (mut ed, s) = setup();
    let mut p = |code: &str| p(&mut ed, &s, code);
    p(r#"e8.internalMakeLispFace("probe-b")"#);
    assert_eq!(p(r#"e8.internalLispFaceEmptyP("probe-b")"#), "t");
    assert_eq!(p(r#"e8.internalLispFaceEmptyP(Symbol.for("nonexist"))"#), "(ERR error Invalid face: nonexist)");
    assert_eq!(p(r#"e8.internalLispFaceEqualP("probe-b", "probe-b")"#), "t");
    assert_eq!(p(r#"e8.internalLispFaceEqualP("probe-b", "bold")"#), "nil");
    assert_eq!(p(r#"e8.internalLispFaceEqualP("probe-b", Symbol.for("nonexist"))"#), "(ERR error Invalid face: nonexist)");
    // FRAME must be t or a frame, as Emacs's checks have it.
    assert_eq!(p(r#"e8.internalCopyLispFace("bold", "probe-c", null)"#), "(ERR wrong-type-argument Wrong type argument: frame-live-p, nil)");
    assert_eq!(p(r#"e8.internalCopyLispFace(Symbol.for("bold"), Symbol.for("probe-e"), true)"#), "probe-e");
    assert_eq!(p(r#"e8.internalLispFaceEqualP("bold", "probe-e")"#), "t");
    assert_eq!(p(r#"e8.internalCopyLispFace(Symbol.for("nonexist"), Symbol.for("probe-d"), true)"#), "(ERR error Invalid face: nonexist)");
    assert_eq!(p(r#"e8.internalLispFaceP("probe-e", true)"#), "(ERR wrong-type-argument Wrong type argument: frame-live-p, t)");
    // Making a face that exists empties it.
    p(r#"e8.internalSetLispFaceAttribute("probe-b", ":weight", Symbol.for("bold"))"#);
    assert_eq!(p(r#"e8.internalMakeLispFace("probe-b")"#), EMPTY);
    assert_eq!(p(r#"e8.internalLispFaceEmptyP("probe-b")"#), "t");
    assert_eq!(p(r#"e8.internalMergeInGlobalFace("probe-b", e8.selectedFrame())"#), "nil");
    assert_eq!(p(r#"e8.internalMergeInGlobalFace(Symbol.for("nonexist"), e8.selectedFrame())"#), "(ERR error Invalid face: nonexist)");
}

#[test]
fn attribute_vectors_and_the_face_table_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    let mut p = |code: &str| p(&mut ed, &s, code);
    let vector = |slots: &[(usize, &str)]| {
        let mut items = vec!["unspecified".to_string(); 20];
        for (i, v) in slots {
            items[*i] = v.to_string();
        }
        format!("[{}]", items.join(" "))
    };
    assert_eq!(p(r#"e8.faceAttributesAsVector([Symbol.for(":foreground"), "red", Symbol.for(":weight"), Symbol.for("bold")])"#), vector(&[(5, "bold"), (9, "\"red\"")]));
    assert_eq!(p(r#"e8.faceAttributesAsVector([Symbol.for(":inherit"), Symbol.for("bold")])"#), vector(&[(5, "bold"), (16, "nil")]));
    assert_eq!(p("e8.faceAttributesAsVector(null)"), vector(&[]));
    assert_eq!(p(r#"e8.faceAttributesAsVector([Symbol.for(":foo"), 1])"#), vector(&[]));
    assert_eq!(p(r#"e8.faceAttributesAsVector(Symbol.for("bold"))"#), vector(&[(5, "bold"), (16, "nil")]));
    assert_eq!(p(r#"e8.faceAttributesAsVector([Symbol.for("bold"), [Symbol.for(":foreground"), "red"]])"#), vector(&[(5, "bold"), (9, "\"red\""), (16, "nil")]));
    // Each face by name, its vector as internal-lisp-face-p gives it.
    assert_eq!(p("e8.frameFaceHashTable().get('bold')"), "[face unspecified unspecified unspecified unspecified bold unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified unspecified]");
    assert_eq!(p("e8.funcall('frame--face-hash-table') instanceof Map"), "t");
}

#[test]
fn resources_font_order_and_odds_as_emacs_has_them() {
    let (mut ed, s) = setup();
    let mut p = |code: &str| p(&mut ed, &s, code);
    p(r#"e8.internalMakeLispFace("probe-b")"#);
    for (attr, value, want) in [
        (":weight", "bold", "probe-b"),
        (":height", "120", "probe-b"),
        (":underline", "on", "probe-b"),
        (":underline", "off", "probe-b"),
        (":underline", "blue", "probe-b"),
        (":inverse-video", "yes", r#"(ERR error Invalid face attribute value from X resource: "yes")"#),
        (":foreground", "unspecified", "probe-b"),
        (":box", "true", "(ERR error Invalid face box: true)"),
        (":family", "Monaco", "probe-b"),
        (":inherit", "bold", "probe-b"),
    ] {
        let got = p(&format!(r#"e8.internalSetLispFaceAttributeFromResource(Symbol.for("probe-b"), Symbol.for("{attr}"), "{value}")"#));
        assert_eq!(got, want, "{attr} {value}");
    }
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-b", ":height")"#), "120");
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-b", ":underline")"#), r#""blue""#);
    assert_eq!(p(r#"e8.internalGetLispFaceAttribute("probe-b", ":inherit")"#), "bold");
    assert_eq!(p(r#"e8.internalFaceXGetResource("foo", "Foo")"#), "nil");
    assert_eq!(p(r#"e8.internalSetAlternativeFontFamilyAlist([["Monospace", "courier", "fixed"]])"#), "[[Monospace courier fixed]]");
    assert_eq!(p(r#"e8.internalSetAlternativeFontFamilyAlist([Symbol.for("x")])"#), "(ERR wrong-type-argument Wrong type argument: listp, x)");
    assert_eq!(p("e8.internalSetAlternativeFontFamilyAlist(3)"), "(ERR wrong-type-argument Wrong type argument: listp, 3)");
    assert_eq!(p(r#"e8.internalSetAlternativeFontRegistryAlist([["ISO8859-1", "ms-cp1252"]])"#), r#"[["iso8859-1" "ms-cp1252"]]"#);
    let order = |names: &[&str]| format!("[{}]", names.iter().map(|n| format!("Symbol.for(\"{n}\")")).collect::<Vec<_>>().join(", "));
    assert_eq!(p(&format!("e8.internalSetFontSelectionOrder({})", order(&[":width", ":height", ":weight", ":slant"]))), "nil");
    assert_eq!(p(&format!("e8.internalSetFontSelectionOrder({})", order(&[":width", ":height", ":weight"]))), "(ERR error Invalid font sort order: (:width :height :weight))");
    // Emacs takes a name twice, as its check looks at each place only once.
    assert_eq!(p(&format!("e8.internalSetFontSelectionOrder({})", order(&[":width", ":height", ":weight", ":weight"]))), "nil");
    assert_eq!(p(&format!("e8.internalSetFontSelectionOrder({})", order(&[":width", ":height", ":weight", ":foo"]))), "(ERR error Invalid font sort order: (:width :height :weight :foo))");
    assert_eq!(p("e8.internalSetFontSelectionOrder(3)"), "(ERR wrong-type-argument Wrong type argument: listp, 3)");
    for (spec, want) in [(r#""foo""#, "t"), (r#"[2, 2, "ab"]"#, "t"), (r#"[8, 1, "a"]"#, "t"), (r#"[8, 2, "a"]"#, "nil"), ("[2, 2, [1, 2]]", "nil"), ("3", "nil"), ("null", "nil")] {
        assert_eq!(p(&format!("e8.bitmapSpecP({spec})")), want, "{spec}");
    }
    assert_eq!(p("e8.clearFaceCache()"), "nil");
    assert_eq!(p("e8.clearFaceCache(true)"), "nil");
    assert_eq!(p("e8.ttySuppressBoldInverseDefaultColors(true)"), "t");
    assert_eq!(p("e8.xFamilyFonts()"), "[]");
    assert_eq!(p(r#"e8.xLoadColorFile("/no/such/file")"#), "nil");
}

#[test]
fn colour_files_are_read_as_emacs_reads_them() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("rgb.txt");
    std::fs::write(&file, "! comment\n255 0 0\t\tred one\n  0 255 0 green\nbad line\n").unwrap();
    // As Emacs: (("green" . 65280) ("red one" . 16711680)).
    assert_eq!(p(&mut ed, &s, &format!("e8.xLoadColorFile({:?})", file.to_str().unwrap())), r#"[["green" 65280] ["red one" 16711680]]"#);
}

#[test]
fn fonts_without_a_window_system_and_fontsets() {
    let (mut ed, s) = setup();
    let mut p = |code: &str| p(&mut ed, &s, code);
    // As Emacs's font-match-p on these specs.
    for (spec, font, want) in [
        (r#"":family", "Menlo""#, r#"":family", "Menlo", ":weight", Symbol.for("bold")"#, "t"),
        (r#"":family", "Menlo", ":weight", Symbol.for("bold")"#, r#"":family", "Menlo""#, "t"),
        (r#"":family", "menlo""#, r#"":family", "Menlo""#, "nil"),
        (r#"":weight", Symbol.for("bold")"#, r#"":weight", Symbol.for("bold"), ":family", "X""#, "t"),
        (r#"":size", 12"#, r#"":size", 12"#, "t"),
        (r#"":size", 12"#, r#"":size", 13"#, "nil"),
        (r#"":size", 12"#, "", "t"),
        (r#"":spacing", Symbol.for("m")"#, r#"":spacing", Symbol.for("p")"#, "t"),
        (r#"":registry", Symbol.for("iso10646-1")"#, r#"":registry", Symbol.for("iso8859-1")"#, "nil"),
    ] {
        assert_eq!(p(&format!("e8.fontMatchP(e8.fontSpec({spec}), e8.fontSpec({font}))")), want, "{spec} / {font}");
    }
    assert_eq!(p(r#"e8.fontMatchP("x", e8.fontSpec())"#), r#"(ERR wrong-type-argument Wrong type argument: font-spec, "x")"#);
    // A terminal has no fonts, as Emacs's text terminals report no glyph codes.
    assert_eq!(p("e8.internalCharFont(null, 97)"), "nil");
    // Font attributes follow font.c's font-face-attributes.
    assert_eq!(
        p(r#"e8.fontFaceAttributes(e8.fontSpec(":family", "Menlo", ":size", 12.5, ":weight", Symbol.for("semibold"), ":slant", Symbol.for("i"), ":width", Symbol.for("narrow")))"#),
        r#"[:family "Menlo" :height 120 :weight semi-bold :slant italic :width condensed]"#
    );
    assert_eq!(p(r#"e8.fontFaceAttributes(e8.fontSpec(":size", 14, ":weight", Symbol.for("book")))"#), "[:height 140 :weight regular]");
    assert_eq!(p(r#"e8.fontFaceAttributes("-*-Courier-normal-normal-normal-*-14-*-*-*-m-0-iso10646-1")"#), r#"[:family "Courier" :height 140 :weight regular :slant normal :width normal]"#);
    // A font's own dpi, as PIXEL_TO_POINT counts 72.27 points an inch.
    assert_eq!(p(r#"e8.fontFaceAttributes(e8.fontSpec(":size", 14, ":dpi", 72))"#), "[:height 141]");
    assert_eq!(p("e8.fontFaceAttributes(3)"), "(ERR error Invalid font object: 3)");
    // Fontsets, as fontset.c keeps them.
    assert_eq!(p("e8.fontsetList()"), r#"["-*-*-*-*-*-*-*-*-*-*-*-*-fontset-default"]"#);
    assert_eq!(p(r#"e8.queryFontset("fontset-default")"#), r#""-*-*-*-*-*-*-*-*-*-*-*-*-fontset-default""#);
    assert_eq!(p(r#"e8.queryFontset("-*-*-*-*-*-*-*-*-*-*-*-*-fontset-*")"#), r#""-*-*-*-*-*-*-*-*-*-*-*-*-fontset-default""#);
    assert_eq!(p(r#"e8.queryFontset("nonexistent")"#), "nil");
    assert_eq!(p(r#"e8.setFontsetFont(true, [0xe000, 0xf8ff], "Symbols Nerd Font Mono")"#), "nil");
    assert_eq!(p("e8.fontsetFont(true, 0xe001)"), r#"["Symbols Nerd Font Mono" nil]"#);
    assert_eq!(p(r#"e8.setFontsetFont(true, Symbol.for("greek"), e8.fontSpec(":family", "Menlo"))"#), "nil");
    assert_eq!(p("e8.fontsetFont(true, 0x3b1)"), r#"["Menlo" nil]"#);
    assert_eq!(p(r#"e8.setFontsetFont(true, 0x3b1, ["Monaco", "ISO10646-1"], null, Symbol.for("prepend"))"#), "nil");
    assert_eq!(p(r#"e8.setFontsetFont(true, 0x3b1, "Courier", null, Symbol.for("append"))"#), "nil");
    assert_eq!(p("e8.fontsetFont(true, 0x3b1, true)"), r#"[["Monaco" "iso10646-1"] ["Courier" nil]]"#);
    // Errors, as Emacs signals them.
    assert_eq!(p(r#"e8.setFontsetFont(true, 120, "Courier")"#), "(ERR error Can’t set a font for partial ASCII range)");
    assert_eq!(p(r#"e8.setFontsetFont("nonexist", 0x3b1, "Courier")"#), "(ERR error Fontset ‘nonexist’ does not exist)");
    assert_eq!(p(r#"e8.setFontsetFont(true, "bad", "Courier")"#), "(ERR error Invalid second argument for setting a font in a fontset)");
    assert_eq!(p("e8.setFontsetFont(true, 0x3b1, 3)"), "(ERR font Invalid font-spec)");
    assert_eq!(p(r#"e8.newFontset("-*-fixed-medium-r-normal-*-16-*-*-*-*-*-fontset-mine", [[Symbol.for("ascii"), "Monaco"]])"#), r#""-*-fixed-medium-r-normal-*-16-*-*-*-*-*-fontset-mine""#);
    assert_eq!(p("e8.fontsetList()"), r#"["-*-fixed-medium-r-normal-*-16-*-*-*-*-*-fontset-mine" "-*-*-*-*-*-*-*-*-*-*-*-*-fontset-default"]"#);
    assert_eq!(p(r#"e8.fontsetFont("fontset-mine", 97)"#), r#"["Monaco" nil]"#);
    assert_eq!(p(r#"e8.newFontset("plain", null)"#), "(ERR error Fontset name must be in XLFD format)");
}
