//! Characters by their Unicode names, as Emacs 30.2 has them:
//! get-char-code-property and its kin, ucs-names, char-from-name,
//! C-x 8 RET (insert-char) and describe-char.

use crate::driven::Driven;
use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Emacs 30: C-x 8 RET takes a name, in any case, or a hex code, with a
/// count from the prefix argument.
#[test]
fn insert_char_by_name_or_code() {
    let d = Driven::new("");
    d.start(|ed| ed.call("switch-to-buffer", vec![e8_core::Arg::Str("u".into())]).unwrap());
    let started = std::time::Instant::now();
    d.press("C-x 8 RET");
    d.type_text("GREEK SMALL LETTER LAMBDA");
    d.press("RET");
    let elapsed = started.elapsed();
    d.press("C-u 3 C-x 8 RET");
    d.type_text("grinning face");
    d.press("RET");
    d.press("C-x 8 RET");
    d.type_text("2A10");
    d.press("RET");
    d.press("C-x 8 RET");
    d.type_text("#x41");
    d.press("RET");
    assert_eq!(d.text(), "λ😀😀😀⨐A");
    eprintln!("first: {elapsed:?}");
    // Three times as long on CI's runners, as Org's timed tests allow:
    // typing the name a key at a time in a debug build took 11 s on one.
    let limit = std::time::Duration::from_secs(if std::env::var_os("CI").is_some() { 15 } else { 5 });
    assert!(elapsed < limit, "{elapsed:?}");
}

fn describe(ed: &mut Editor, s: &Scripting, setup: &str, pos: usize) -> String {
    eval(ed, s, &format!(r#"(e8.call("switch-to-buffer", "t"), e8.deleteRegion(e8.pointMin(), e8.pointMax()), {setup}, e8.call("describe-char", {pos}), e8.withCurrentBuffer("*Help*", () => e8.bufferText()))"#))
}

/// Emacs 30.2's describe-char in a terminal, in a buffer with point at its
/// end, as its column is point's.
#[test]
fn describe_char_says_what_emacs_says() {
    let (mut ed, s) = setup();
    assert_eq!(
        describe(&mut ed, &s, r#"e8.insert("aé½\n")"#, 0),
        "             position: 1 of 4 (0%), column: 0
            character: a (displayed as a) (codepoint 97, #o141, #x61)
              charset: ascii (ASCII (ISO646 IRV))
code point in charset: 0x61
               script: latin
               syntax: w \twhich means: word
             category: .:Base, L:Strong L2R, a:ASCII, l:Latin, r:Roman
             to input: type \"C-x 8 RET 61\" or \"C-x 8 RET LATIN SMALL LETTER A\"
          buffer code: #x61
            file code: #x61 (encoded by coding system utf-8-unix)
              display: terminal code #x61

Character code properties: customize what to show
  name: LATIN SMALL LETTER A
  general-category: Ll (Letter, Lowercase)
  decomposition: (97) ('a')
"
    );
    assert_eq!(
        describe(&mut ed, &s, r#"e8.insert("aé½\n")"#, 2),
        "             position: 3 of 4 (50%), column: 0
            character: ½ (displayed as ½) (codepoint 189, #o275, #xbd)
              charset: unicode (Unicode (ISO10646))
code point in charset: 0xBD
               script: latin
               syntax: _ \twhich means: symbol
             category: .:Base, h:Korean, j:Japanese, l:Latin
             to input: type \"C-x 8 RET bd\" or \"C-x 8 RET VULGAR FRACTION ONE HALF\"
          buffer code: #xC2 #xBD
            file code: #xC2 #xBD (encoded by coding system utf-8-unix)
              display: terminal code #xC2 #xBD

Character code properties: customize what to show
  name: VULGAR FRACTION ONE HALF
  old-name: FRACTION ONE HALF
  general-category: No (Number, Other)
  decomposition: (fraction 49 8260 50) (fraction '1' '⁄' '2')
"
    );
    let nbsp = describe(&mut ed, &s, r#"e8.insert("x y")"#, 1);
    assert!(nbsp.contains("       hardcoded face: nobreak-space\n"), "{nbsp}");
    assert!(nbsp.contains("  decomposition: (noBreak 32) (noBreak ' ')\n"), "{nbsp}");
    let props = describe(&mut ed, &s, r#"e8.insert("a"), e8.insert(e8.propertize("b", { face: "bold", foo: 42 })), e8.insert("c")"#, 1);
    assert!(props.ends_with("  decomposition: (98) ('b')\n\nThere are text properties here:\n  face                 bold\n  foo                  42\n"), "{props}");
}

/// Every property of some characters, and char-from-name of some names,
/// as Emacs 30.2 gives them, written by tests/emacs/unidata.el.
#[test]
fn char_code_properties_are_emacs_properties() {
    let (mut ed, s) = setup();
    let expected = include_str!("../../../../tests/emacs/unidata-props.txt");
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          // As %S prints them: the properties whose values are symbols bare, strings quoted.
          const symbols = new Set(["general-category", "bidi-class", "mirrored", "bracket-type"]);
          const show = (p: string, v: e8.Value): string =>
            v === null || v === undefined ? "nil"
            : Array.isArray(v) ? `(${v.map((x) => String(x)).join(" ")})`
            : typeof v === "string" && !symbols.has(p) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
            : String(v);
          const out: string[] = [];
          for (const c of [0x61, 0x41, 0xe9, 0xbd, 0x300, 0x5d0, 0x661, 0x2160, 0xac01, 0x4e00, 0x1f600, 0xdf, 0x130, 0x28, 0x10ffff, 7])
            for (const p of [...e8.charCodePropertyNames()].reverse()) out.push(`${c.toString(16).toUpperCase()} ${p} ${show(p, e8.getCharCodeProperty(c, p))}`);
          for (const n of ["LATIN SMALL LETTER A", "latin small letter a", "BELL", "BELL (BEL)", "VARIATION SELECTOR-17",
                           "CJK COMPATIBILITY IDEOGRAPH-F900", "CJK IDEOGRAPH-4E00", "GREEK SMALL LETTER LAMBDA",
                           "GREEK SMALL LETTER LAMDA", "HANGUL SYLLABLE GA", "NOPE"])
            out.push(`from ${n} ${show("", e8.funcall("char-from-name", n) as e8.Value)} ${show("", e8.funcall("char-from-name", n, true) as e8.Value)}`);
          return out.join("\n") + "\n";
        })()"#,
    );
    for (e, g) in expected.lines().zip(got.lines()) {
        assert_eq!(g, e);
    }
    assert_eq!(got.lines().count(), expected.lines().count());
}

/// Emacs 30: C-h b writes a key translation's character with its name
/// after a tab, as help--describe-command does: C-x 8 * ! makes ¡.
#[test]
fn key_translations_name_their_characters() {
    let (mut ed, s) = setup();
    let help = eval(
        &mut ed,
        &s,
        r#"(e8.call("switch-to-buffer", "b"), e8.call("describe-bindings"), e8.withCurrentBuffer("*Help*", () => e8.bufferText()))"#,
    );
    let translations = &help[..help.find('\u{c}').unwrap_or(help.len())];
    assert!(translations.starts_with("Key translations:"), "{translations}");
    assert!(translations.lines().any(|l| l.ends_with("¡\tINVERTED EXCLAMATION MARK")), "{translations}");
    assert!(translations.lines().any(|l| l.ends_with("é\tLATIN SMALL LETTER E WITH ACUTE")), "{translations}");
}

/// Emacs 30: C-x 8 RET works inside a prompt, as read-char-by-name binds
/// enable-recursive-minibuffers; lower-case hex in a made name and
/// codes beyond Unicode or with bad digits are as Emacs takes them.
#[test]
fn insert_char_inside_a_prompt_and_its_edge_cases() {
    let d = Driven::new("");
    d.start(|ed| ed.call("switch-to-buffer", vec![e8_core::Arg::Str("u".into())]).unwrap());
    d.start_eval(r#"globalThis.answer = e8.readString("Text: ");"#);
    d.press("C-x 8 RET");
    d.type_text("cjk ideograph-4e00");
    d.press("RET");
    assert_eq!(d.minibuffer_input(), "一");
    d.press("C-g");
    for bad in ["110000", "#x1z", "#b102", "d800"] {
        d.press("C-x 8 RET");
        d.type_text(bad);
        d.press("RET");
        assert_eq!(d.message().as_deref(), Some("Invalid character"), "{bad}");
    }
    d.press("C-x 8 RET");
    d.type_text("#x3fff80");
    d.press("RET");
    assert_eq!(d.eval_expression("JSON.stringify([...e8.bufferText()].map((c) => c.codePointAt(0)))"), r#""[1113984]""#);
}

/// Emacs 30: describe-char gives no category row for a character in none,
/// shows a control character's decomposition when describe-char-unidata-list
/// is t, and get-char-code-property refuses what is no character.
#[test]
fn describe_char_edges_and_what_is_no_character() {
    let (mut ed, s) = setup();
    let bel = describe(&mut ed, &s, r#"e8.setVariable("describe-char-unidata-list", true), e8.insert("\u0007")"#, 0);
    assert!(!bel.lines().any(|l| l.trim_start().starts_with("category:")), "{bel}");
    assert!(bel.contains("  decomposition: (7) ('\u{7}')\n"), "{bel:?}");
    let got = eval(&mut ed, &s, r#"JSON.stringify([e8.conditionCase(() => e8.getCharCodeProperty(-1, "name"), { "wrong-type-argument": () => "refused" }), e8.funcall("char-to-name", -1) ?? null, e8.getCharCodeProperty(0xd800, "bidi-class")])"#);
    assert_eq!(got, r#"["refused",null,"L"]"#);
}

/// Emacs 30: put-char-code-property puts into the property's table, and
/// the table's values are what get-char-code-property gives.
#[test]
fn put_char_code_property_and_the_tables_agree() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"(() => {
          e8.putCharCodeProperty(0x61, "mirroring", 0x7a);
          const table = e8.unicodePropertyTableInternal("mirroring")!;
          const before = e8.getUnicodePropertyInternal(table, 0x61);
          e8.putUnicodePropertyInternal(table, 0x62, 0x79);
          return JSON.stringify([before, e8.getCharCodeProperty(0x62, "mirroring"), e8.getCharCodeProperty(0x4e00, "name")]);
        })()"#,
    );
    assert_eq!(got, r#"[122,121,"CJK IDEOGRAPH-4E00"]"#);
}
