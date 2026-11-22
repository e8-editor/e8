//! completing-read-multiple, as Emacs's crm.el: completion on the answer
//! at point among several, each checked when one must match, and Org's
//! C-c C-q completing each tag after a colon.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn editor() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        e8.defineCommand({ name: "test-crm", run: () => e8.message(JSON.stringify(e8.funcall("completing-read-multiple", "Pick: ", ["alpha", "beta", "gamma"]))) });
        e8.defineCommand({ name: "test-crm-must", run: () => e8.message(JSON.stringify(e8.funcall("completing-read-multiple", "Pick: ", ["alpha", "beta", "gamma"], null, true))) });
        "#
        .to_string(),
    )
    .unwrap();
    (ed, s)
}

/// TAB completes the answer at point, the others left as they are, and the answers come back as a list.
#[test]
fn tab_completes_the_answer_at_point() {
    let (mut ed, _s) = editor();
    ed.press("M-x t e s t - c r m RET a l TAB , SPC b TAB RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some(r#"["alpha","beta"]"#));
}

/// Point in an earlier answer completes that one.
#[test]
fn an_earlier_answer_completes() {
    let (mut ed, _s) = editor();
    ed.press("M-x t e s t - c r m RET g , b e t a C-a TAB RET").unwrap();
    assert_eq!(ed.echo(), Some(r#"["gamma","beta"]"#));
}

/// Empty answers are left out, as split-string with OMIT-NULLS.
#[test]
fn empty_answers_are_left_out() {
    let (mut ed, _s) = editor();
    ed.press("M-x t e s t - c r m RET , , a l p h a , RET").unwrap();
    assert_eq!(ed.echo(), Some(r#"["alpha"]"#));
}

/// With a match required, each answer must be one, as crm-complete-and-exit checks them.
#[test]
fn each_answer_must_match() {
    let (mut ed, _s) = editor();
    // RET after zz stays in the prompt, so the answer is the corrected one.
    ed.press("M-x t e s t - c r m - m u s t RET a l p h a , z z RET DEL DEL b e t a RET").unwrap();
    assert_eq!(ed.echo(), Some(r#"["alpha","beta"]"#));
}

/// C-c C-q with no keys in the table completes each tag after a colon.
#[test]
fn org_tags_complete_after_a_colon() {
    let (mut ed, _s) = editor();
    ed.window_buffer_mut().set_text("* H :old:\n* I :work:\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-c C-q w TAB RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let b = ed.window_buffer();
    assert!(b.slice(0..b.len()).lines().next().unwrap().ends_with(":old:work:"), "{}", b.slice(0..b.len()));
}

/// With org-complete-tags-always-offer-all-agenda-tags, another agenda file's tags complete too.
#[test]
fn agenda_files_tags_are_offered() {
    let (mut ed, _s) = editor();
    let dir = tempfile::tempdir().unwrap();
    let other = dir.path().join("other.org");
    std::fs::write(&other, "* Elsewhere :faraway:\n").unwrap();
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(other.to_str().unwrap().into())]));
    ed.set_variable("org-complete-tags-always-offer-all-agenda-tags", Value::Bool(true));
    ed.window_buffer_mut().set_text("* H\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-c C-q f a TAB RET").unwrap();
    let b = ed.window_buffer();
    assert!(b.slice(0..b.len()).contains(":faraway:"), "{}", b.slice(0..b.len()));
    let _ = Arg::Str(String::new());
}
