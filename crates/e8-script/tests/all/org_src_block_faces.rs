//! Source blocks' faces by language, as org-src-block-faces and the
//! org-block-LANG faces give them; the Emacs oracle does not compare faces.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str, setup: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(&mut ed, "setup.ts", setup.to_string()).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.redisplay();
    (ed, s)
}

/// The face property at the first character of `needle`, as JSON.
fn face_at(ed: &Editor, needle: &str) -> String {
    let b = ed.window_buffer();
    let text = b.slice(0..b.len());
    let at = text[..text.find(needle).unwrap()].chars().count();
    fn json(v: &Value) -> String {
        match v {
            Value::Str(s) | Value::Symbol(s) => format!("{s:?}"),
            Value::List(items) => format!("[{}]", items.iter().map(json).collect::<Vec<_>>().join(",")),
            other => format!("{other:?}"),
        }
    }
    b.text_property(at, "face").map(|v| json(&v)).unwrap_or_default()
}

/// A language's face goes after the mode's faces and before org-block,
/// its name matched ignoring case, an anonymous face or a face's name.
#[test]
fn a_languages_block_takes_its_face_before_org_block() {
    let (ed, _s) = org(
        "#+begin_src TypeScript\nconst x = 1;\n#+end_src\n#+begin_src\nplain\n#+end_src\n",
        r##"e8.setVariable("org-src-block-faces", [["typescript", [":background", "#e5ffb8"]], ["", "italic"]]);"##,
    );
    let face = face_at(&ed, "const");
    // An anonymous face, which E8 keeps under a name of its own starting with \u{1}, then org-block.
    assert!(face.ends_with(r#""\u{1}0","org-block"]"#) || face.ends_with(r#""\u{1}1","org-block"]"#), "{face}");
    // A block with no language takes the "" entry's face.
    assert_eq!(face_at(&ed, "plain"), r#"["italic","org-block"]"#);
}

/// A language with no mode in E8 has its face and org-block all the same,
/// as org-src-font-lock-fontify-block adds them whatever the mode; an
/// example block naming a language is fontified the same way.
#[test]
fn a_language_without_a_mode_and_an_example_block_take_their_faces() {
    let (ed, _s) = org(
        "#+begin_src nosuchlang\nsome text\n#+end_src\n#+begin_example nosuchlang\nmore\n#+end_example\n",
        r#"e8.setVariable("org-src-block-faces", [["nosuchlang", "bold"]]);"#,
    );
    assert_eq!(face_at(&ed, "some"), r#"["bold","org-block"]"#);
    assert_eq!(face_at(&ed, "more"), r#"["bold","org-block"]"#);
}

/// A face not defined is left out, as Org checks facep.
#[test]
fn an_undefined_face_is_left_out() {
    let (ed, _s) = org("#+begin_src nosuchlang\nsome text\n#+end_src\n", r#"e8.setVariable("org-src-block-faces", [["nosuchlang", "no-such-face"]]);"#);
    assert_eq!(face_at(&ed, "some"), r#""org-block""#);
}

/// Not fontified natively, a protecting block's text takes org-block-LANG
/// before org-block when that face exists, an export block's too.
#[test]
fn org_block_lang_faces_without_native_fontification() {
    let setup = r#"e8.defineFace({ name: "org-block-html", doc: "HTML blocks.", attributes: { italic: true } });
                   e8.setDefault("org-src-fontify-natively", false);"#;
    let (ed, _s) = org("#+begin_export html\n<p>x</p>\n#+end_export\n#+begin_src html\n<b>y</b>\n#+end_src\n#+begin_quote html\nz\n#+end_quote\n", setup);
    assert_eq!(face_at(&ed, "<p>"), r#"["org-block-html","org-block"]"#);
    assert_eq!(face_at(&ed, "<b>"), r#"["org-block-html","org-block"]"#);
    // A quote block is no protecting block.
    assert_eq!(face_at(&ed, "z\n"), r#""org-quote""#);
}
