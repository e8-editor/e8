//! What was left of coding systems: saving text the coding cannot write,
//! with *Warning* listing the characters and the question when the answer
//! is not what the file's cookie names; coding-system-put's mnemonic in
//! the mode line; and the codings files name by an XML, HTML, PO or LaTeX
//! declaration, or by auto-coding-alist. Checked against Emacs 30.2.

use std::fs;

use crate::driven::Driven;
use e8_core::{Arg, Editor};
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

fn unquote(json: String) -> String {
    serde_json::from_str::<String>(&json).unwrap_or(json)
}

/// Emacs 30, saving "price 5€ and ü" after C-x RET f iso-latin-1-unix:
/// *Warning* says what iso-latin-1-unix cannot write and where, the
/// prompt offers utf-8, and RET saves in it.
#[test]
fn saving_what_the_coding_cannot_write_shows_why_and_asks() {
    let d = Driven::new("");
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let file = dir.path().join("a.txt");
    let path = file.display().to_string();
    d.start(move |ed| ed.call("find-file", vec![Arg::Str(path)]).unwrap());
    d.eval(r#"e8.insert("price 5€ and ü\n"); e8.call("set-buffer-file-coding-system", "iso-latin-1-unix");"#);
    d.press("C-x C-s");
    assert_eq!(d.prompt().as_deref(), Some("Select coding system (default utf-8): "));
    let warning = unquote(d.eval_expression(r#"e8.withCurrentBuffer("*Warning*", () => e8.bufferText())"#));
    let expected = "These default coding systems were tried to safely encode the following
problematic characters in the buffer \u{2018}a.txt\u{2019}:
  Coding System           Pos  Codepoint  Char
  iso-latin-1-unix          8  #x20AC     \u{20ac}

However, each of them encountered characters it couldn\u{2019}t encode safely:
  iso-latin-1-unix cannot safely encode these: \u{20ac}

Click on a character (or switch to this window by \u{2018}C-x o\u{2019}
and select the characters by RET) to jump to the place it appears,
where \u{2018}C-u C-x =\u{2019} will give information about it.

Select one of the safe coding systems listed below,
or cancel the writing with C-g and edit the buffer
   to remove or modify the problematic characters,
or specify any other coding system (and risk losing
   the problematic characters).

  utf-8 ";
    assert!(warning.starts_with(expected), "{warning}");
    assert!(warning.lines().skip(expected.lines().count()).all(|l| l.starts_with("  ") && l.len() <= 70), "{warning}");
    d.press("RET");
    assert_eq!(fs::read(&file).unwrap(), "price 5\u{20ac} and \u{fc}\n".as_bytes());
    assert_eq!(d.variable("buffer-file-coding-system").map(unquote).as_deref(), Some("utf-8-unix"));
    assert_eq!(d.eval_expression(r#"String(e8.getBuffer("*Warning*") !== undefined)"#), r#""false""#);
}

/// Emacs 30: a file whose cookie says latin-1, holding €, is saved in what
/// you answer only once you say yes to saving against the cookie.
#[test]
fn an_answer_against_the_cookie_is_asked_about() {
    let d = Driven::new("");
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let file = dir.path().join("b.txt");
    fs::write(&file, "-*- coding: latin-1 -*-\n").unwrap();
    let path = file.display().to_string();
    d.start(move |ed| ed.call("find-file", vec![Arg::Str(path)]).unwrap());
    d.eval(r#"e8.gotoChar(e8.pointMax()); e8.insert("5€\n");"#);
    d.press("C-x C-s");
    assert_eq!(d.prompt().as_deref(), Some("Select coding system (default utf-8): "));
    d.press("RET");
    assert_eq!(
        d.prompt().as_deref(),
        Some("Selected encoding utf-8 disagrees with latin-1 specified by file contents.  Really save (else edit coding cookies and try again)? (yes or no) ")
    );
    d.type_text("yes");
    d.press("RET");
    assert_eq!(fs::read_to_string(&file).unwrap(), "-*- coding: latin-1 -*-\n5\u{20ac}\n");
}

/// Emacs 30: (coding-system-put 'utf-8 :mnemonic ?X) makes a UTF-8
/// buffer's mode line show X; coding-system-get gives back 88.
#[test]
fn a_new_mnemonic_shows_in_the_mode_line() {
    let (mut ed, s) = setup();
    ed.call("switch-to-buffer", vec![Arg::Str("m".into())]).unwrap();
    eval(&mut ed, &s, r#"(e8.setVariable("buffer-file-coding-system", "utf-8-unix"), e8.codingSystemPut("utf-8", ":mnemonic", 88), "")"#);
    assert_eq!(ed.window_buffer().coding_mnemonic(), "X:");
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify([e8.codingSystemGet("utf-8", ":mnemonic"), e8.codingSystemMnemonic("utf-8-dos")])"#), "[88,\"X\"]");
}

/// Emacs 30: coding-system-plist holds :category and :charset-list,
/// iso-2022-7bit's charset list being the symbol iso-2022.
#[test]
fn a_coding_says_its_category_and_charsets() {
    let (mut ed, s) = setup();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify(["japanese-shift-jis", "iso-2022-7bit", "raw-text", "prefer-utf-8"].map((c) =>
             [e8.codingSystemGet(c, ":category"), e8.codingSystemGet(c, ":charset-list") ?? null, e8.codingSystemGet(c, ":prefer-utf-8") ?? null]))"#,
    );
    assert_eq!(
        got,
        r#"[["coding-category-sjis",["ascii","katakana-jisx0201","japanese-jisx0208"],null],["coding-category-iso-7","iso-2022",null],["coding-category-raw-text",null,null],["coding-category-undecided",["emacs"],true]]"#
    );
}

/// Emacs 30 reads a file by what auto-coding-alist says for its name, an
/// XML declaration or an HTML meta charset, and find-auto-coding gives the
/// name it found and where: (iso-8859-1 . auto-coding-functions) for the
/// XML, (no-conversion-multibyte . auto-coding-alist) for a zip.
#[test]
fn files_name_their_coding_by_declarations_and_names() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let xml = dir.path().join("a.xml");
    fs::write(&xml, b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>\n<a>\xe9</a>\n").unwrap();
    let html = dir.path().join("a.html");
    fs::write(&html, b"<html><head><meta charset=\"windows-1252\"></head><body>\x80</body></html>\n").unwrap();
    let zip = dir.path().join("a.zip");
    fs::write(&zip, b"PK\x03\x04\xe9").unwrap();
    let mut got = Vec::new();
    for f in [&xml, &html, &zip] {
        ed.call("find-file", vec![Arg::Str(f.display().to_string())]).unwrap();
        got.push(eval(
            &mut ed,
            &s,
            r#"JSON.stringify([e8.variable("buffer-file-coding-system"), e8.bufferText().includes("é") || e8.bufferText().includes("€"),
                 e8.saveExcursion(() => (e8.gotoChar(0), e8.findAutoCoding(e8.bufferFileName()!, e8.bufferSize()) ?? null))])"#,
        ));
    }
    assert_eq!(
        got,
        [
            r#"["iso-latin-1-unix",true,["iso-8859-1","auto-coding-functions"]]"#,
            r#"["windows-1252-unix",true,["windows-1252","auto-coding-functions"]]"#,
            r#"["no-conversion-multibyte",false,["no-conversion-multibyte","auto-coding-alist"]]"#,
        ]
    );
}

/// Emacs 30: set-language-environment "Japanese" puts its coding
/// systems first, after UTF-8, which its setup prefers, so UTF-8,
/// Shift_JIS, EUC-JP and Latin-1 text are each found; "English" puts
/// the coding systems back, with no default for new files; "Latin-1"
/// makes iso-latin-1 the default and its charset first.
#[test]
fn a_language_environment_prefers_its_coding_systems() {
    let (mut ed, s) = setup();
    let detect = r#"["utf-8", "sjis", "euc-jp"].map((c) => e8.encodeCodingString("日本語のテキスト、こんにちは", c))
                      .concat([e8.encodeCodingString("café olé naïve", "latin-1")]).map((b) => e8.detectCodingString(b, true))"#;
    let got = eval(
        &mut ed,
        &s,
        &format!(
            r#"(e8.call("set-language-environment", "Japanese"),
               JSON.stringify([e8.variable("current-language-environment"), e8.codingSystemPriorityList().slice(0, 4),
                               e8.defaultValue("buffer-file-coding-system"), {detect}]))"#
        ),
    );
    assert_eq!(
        got,
        r#"["Japanese",["utf-8","iso-2022-jp","japanese-iso-8bit","japanese-shift-jis"],"utf-8",["utf-8","japanese-shift-jis","japanese-iso-8bit","iso-latin-1"]]"#
    );
    let got = eval(
        &mut ed,
        &s,
        r#"(e8.call("set-language-environment", "English"),
           JSON.stringify([e8.codingSystemPriorityList().slice(0, 3), e8.defaultValue("buffer-file-coding-system") ?? null,
                           (e8.call("set-language-environment", "Latin-1"), e8.defaultValue("buffer-file-coding-system")),
                           e8.charsetPriorityList()[0]]))"#,
    );
    assert_eq!(got, r#"[["utf-8","iso-2022-7bit","iso-latin-1"],null,"iso-latin-1-unix","iso-8859-1"]"#);
}

/// Emacs 30's C-h L Swedish: what it is for, sample text, its charset and
/// its coding system with the mode line's letter and its aliases.
#[test]
fn describe_language_environment_says_what_it_uses() {
    let (mut ed, s) = setup();
    ed.press("C-h L").unwrap();
    ed.type_text("Swedish");
    ed.press("RET").unwrap();
    let help = eval(&mut ed, &s, r#"e8.withCurrentBuffer("*Help*", () => e8.bufferText())"#);
    assert_eq!(
        help,
        "Swedish language environment

Support for Swedish

Sample text:
  Goddag Hej

Character sets:
  iso-8859-1: Latin-1 (ISO/IEC 8859-1)

Coding systems:
  iso-latin-1 (\u{2018}1\u{2019} in mode line):
\tISO 2022 based 8-bit encoding for Latin-1 (MIME:ISO-8859-1).
\t(alias: iso-latin-1 iso-8859-1 latin-1)
"
    );
    let japanese = eval(&mut ed, &s, r#"(e8.call("describe-language-environment", "Japanese"), e8.withCurrentBuffer("*Help*", () => e8.bufferText()))"#);
    assert!(japanese.contains("Character sets:\n  japanese-jisx0208: JISX0208.1983/1990 Japanese Kanji: ISO-IR-87\n"), "{japanese}");
    assert!(japanese.contains("  japanese-shift-jis (\u{2018}S\u{2019} in mode line):\n\tShift-JIS 8-bit encoding for Japanese (MIME:SHIFT_JIS)\n\t(alias: japanese-shift-jis shift_jis sjis)\n"), "{japanese}");
}

/// Emacs 30's editorconfig-mode: charset = latin1 and end_of_line = crlf
/// read a file as iso-latin-1-dos, through auto-coding-functions, which a
/// coding: cookie in the file wins over.
#[test]
fn editorconfig_says_how_a_file_is_coded() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::write(dir.path().join(".editorconfig"), "root = true\n\n[*.txt]\ncharset = latin1\nend_of_line = crlf\n").unwrap();
    fs::write(dir.path().join("a.txt"), b"caf\xe9\r\n").unwrap();
    fs::write(dir.path().join("b.txt"), b"-*- coding: utf-8 -*-\r\ncaf\xc3\xa9\r\n").unwrap();
    ed.call("editorconfig-mode", vec![]).unwrap();
    let mut got = Vec::new();
    for name in ["a.txt", "b.txt"] {
        ed.call("find-file", vec![Arg::Str(dir.path().join(name).display().to_string())]).unwrap();
        got.push(eval(&mut ed, &s, r#"JSON.stringify([e8.variable("buffer-file-coding-system"), e8.bufferText()])"#));
    }
    assert_eq!(got, [r#"["iso-latin-1-dos","café\n"]"#, r#"["utf-8-dos","-*- coding: utf-8 -*-\ncafé\n"]"#]);
}

/// Emacs 30 reads a PO file in the charset its header names and a LaTeX
/// file in what inputenc names, through file-coding-system-alist's
/// po-find-file-coding-system and latexenc-find-file-coding-system, and
/// an XML file with no encoding by its bytes, UTF-8 or else what
/// detection finds.
#[test]
fn po_latex_and_xml_files_say_their_coding() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let files: [(&str, &[u8]); 4] = [
        ("k.po", b"msgid \"\"\nmsgstr \"\"\n\"Content-Type: text/plain; charset=KOI8-R\\n\"\n\nmsgid \"x\"\nmsgstr \"\xd0\xd2\xc9\"\n"),
        ("l2.tex", b"\\documentclass{article}\n\\usepackage[latin2]{inputenc}\n\\begin{document}\xb3\\end{document}\n"),
        ("u.xml", b"<?xml version=\"1.0\"?>\n<a>caf\xc3\xa9</a>\n"),
        ("l.xml", b"<a>caf\xe9</a>\n"),
    ];
    let mut got = Vec::new();
    for (name, bytes) in files {
        fs::write(dir.path().join(name), bytes).unwrap();
        ed.call("find-file", vec![Arg::Str(dir.path().join(name).display().to_string())]).unwrap();
        got.push(eval(&mut ed, &s, r#"JSON.stringify([e8.variable("buffer-file-coding-system"), ["при", "ł", "café"].some((w) => e8.bufferText().includes(w))])"#));
    }
    assert_eq!(
        got,
        [r#"["cyrillic-koi8-unix",true]"#, r#"["iso-latin-2-unix",true]"#, r#"["utf-8-unix",true]"#, r#"["iso-latin-1-unix",true]"#]
    );
}

/// Emacs 30's find-auto-coding passes over a function in
/// auto-coding-functions that signals an error, as ignore-errors does,
/// and C-x RET l takes a language's name in any case.
#[test]
fn a_failing_coding_function_is_passed_over_and_names_fold_case() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::write(dir.path().join("a.txt"), "plain\n").unwrap();
    eval(&mut ed, &s, r#"(e8.defun("broken-coding", () => e8.signal("error", "broken")), e8.setDefault("auto-coding-functions", ["broken-coding"]), "")"#);
    ed.call("find-file", vec![Arg::Str(dir.path().join("a.txt").display().to_string())]).unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferText()"), "plain\n");
    ed.press("C-x RET l").unwrap();
    ed.type_text("japanese");
    ed.press("RET").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("current-language-environment")"#), "Japanese");
}
