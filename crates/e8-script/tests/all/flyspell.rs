//! Flyspell and M-$ where the oracle cannot look: the underlines, checking
//! only comments in code, and choosing a correction in *Choices*. Checks
//! need a spell checker; without one they pass without checking.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup(text: &str) -> Option<(Editor, Scripting)> {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let program = scripting.eval_expression(&mut ed, r#"String(e8.variable("ispell-program-name"))"#).unwrap().trim_matches('"').to_string();
    if std::process::Command::new(&program).arg("-v").output().is_err() {
        return None;
    }
    ed.window_buffer_mut().set_text(text);
    Some((ed, scripting))
}

/// The words flyspell underlines, and with which face.
fn marked(ed: &mut Editor, scripting: &Scripting) -> String {
    scripting
        .eval_expression(
            ed,
            r#"e8.overlaysIn(0, e8.bufferSize()).filter((o) => e8.overlayGet(o, "flyspell-overlay") === true)
                .sort((a, b) => e8.overlayStart(a) - e8.overlayStart(b))
                .map((o) => e8.bufferSubstringNoProperties(e8.overlayStart(o), e8.overlayEnd(o)) + ":" + e8.overlayGet(o, "face")).join(" ")"#,
        )
        .unwrap()
        .trim_matches('"')
        .to_string()
}

#[test]
fn flyspell_buffer_underlines_misspellings_and_doubled_words() {
    let Some((mut ed, s)) = setup("A speling mistake and and a wrod.\n") else { return };
    ed.call("flyspell-buffer", vec![]).unwrap();
    assert_eq!(marked(&mut ed, &s), "speling:flyspell-incorrect and:flyspell-duplicate wrod:flyspell-incorrect");
    assert_eq!(ed.echo(), Some("Spell Checking completed."));
}

#[test]
fn typing_a_misspelling_underlines_it_and_correcting_it_takes_the_line_off() {
    let Some((mut ed, s)) = setup("") else { return };
    ed.press("M-x f l y s p e l l - m o d e RET").unwrap();
    ed.press("t e h SPC").unwrap();
    assert_eq!(marked(&mut ed, &s), "teh:flyspell-incorrect");
    ed.press("C-b C-.").unwrap();
    assert_eq!(marked(&mut ed, &s), "");
}

#[test]
fn flyspell_prog_mode_checks_only_comments() {
    let Some((mut ed, s)) = setup("spelin = 1  # a speling\n") else { return };
    ed.call("python-ts-mode", vec![]).ok();
    if ed.variable("major-mode").and_then(|v| v.as_str().map(str::to_string)).as_deref() != Some("python-ts-mode") {
        return;
    }
    ed.call("flyspell-prog-mode", vec![]).unwrap();
    ed.call("flyspell-buffer", vec![]).unwrap();
    let marks = marked(&mut ed, &s);
    assert_eq!(marks, "speling:flyspell-incorrect", "only the comment's");
    let at: usize = s.eval_expression(&mut ed, r#"String(e8.overlayStart(e8.overlaysIn(0, e8.bufferSize())[0]))"#).unwrap().trim_matches('"').parse().unwrap();
    assert_eq!(at, 16);
}

#[test]
fn ispell_word_offers_corrections_in_choices() {
    let Some((mut ed, _s)) = setup("A speling mistake.\n") else { return };
    ed.call("forward-word", vec![Arg::Int(2)]).unwrap();
    ed.press("M-$ 0").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "A spelling mistake.\n");
    assert!(!ed.buffers().iter().any(|b| b.name == "*Choices*"), "killed afterwards, as ispell-word does");
    assert_eq!(ed.window_list().len(), 1, "the choices window goes");
}
