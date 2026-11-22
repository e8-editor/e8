//! Filling comments where the Emacs oracle does not look: the variables
//! fill-paragraph binds while it fills are what they were afterwards, and
//! comment-start-skip is made from comment-start when a mode gives none.

use e8_core::Editor;
use e8_script::Scripting;

fn eval(s: &Scripting, ed: &mut Editor, js: &str) -> String {
    s.eval_expression(ed, js).unwrap()
}

/// paragraph-start, paragraph-separate and fill-prefix are bound only while
/// a comment fills: a buffer-local value comes back, and one that was not
/// local stays global.
#[test]
fn filling_a_comment_puts_its_bindings_back() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("# aaa bbb\n# ccc\n");
    ed.call("sh-mode", vec![]).unwrap();
    eval(&s, &mut ed, "e8.makeLocalVariable('paragraph-start'), e8.setVariable('paragraph-start', 'x\\\\|[ \\t]*$')");
    ed.window_buffer_mut().set_point(3);
    ed.press("M-q").unwrap();
    assert_eq!(ed.window_buffer().text(), "# aaa bbb ccc\n");
    let start: String = serde_json::from_str(&eval(&s, &mut ed, "e8.variable('paragraph-start')")).unwrap();
    assert_eq!(start, "x\\|[ \t]*$");
    assert_eq!(eval(&s, &mut ed, "e8.isLocalVariable('paragraph-start')"), "true");
    assert_eq!(eval(&s, &mut ed, "e8.isLocalVariable('paragraph-separate')"), "false");
    assert_eq!(eval(&s, &mut ed, "e8.isLocalVariable('fill-prefix') && e8.variable('fill-prefix') !== null"), "false");
}

/// A mode with comment-start and no comment-start-skip gets one, as
/// comment-normalize-vars makes it, so its comments fill as comments.
#[test]
fn comment_start_skip_is_made_from_comment_start() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("-- aaa bbb\n-- ccc\n");
    ed.call("prog-mode", vec![]).unwrap();
    eval(&s, &mut ed, "e8.setVariable('comment-start', '-- '), e8.setVariable('comment-start-skip', null)");
    ed.window_buffer_mut().set_point(4);
    ed.call("fill-paragraph", vec![]).unwrap();
    assert_eq!(ed.window_buffer().text(), "-- aaa bbb ccc\n");
    // As Emacs makes it for "-- ", which has no comment syntax in prog-mode's table.
    let skip: String = serde_json::from_str(&eval(&s, &mut ed, "e8.variable('comment-start-skip')")).unwrap();
    assert_eq!(skip, "\\(\\(^\\|[^\\\n]\\)\\(\\\\\\\\\\)*\\)\\(?:\\s<+\\|--+\\)[ \t]*");
}
