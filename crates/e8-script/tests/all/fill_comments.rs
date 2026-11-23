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

/// fill-region in Org fills each element on its own, a list of one-line
/// items too, as org-setup-filling's fill-forward-paragraph-function has
/// it: what Emacs 30.2 gives, which the oracle cannot call with numbers.
#[test]
fn fill_region_in_org_fills_items_apart() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("aaa bbb ccc ddd eee fff\n- ggg hhh iii jjj kkk lll\n- mmm\n\nnnn ooo ppp qqq rrr sss\n");
    ed.call("org-mode", vec![]).unwrap();
    eval(&s, &mut ed, "e8.setVariable('fill-column', 20)");
    eval(&s, &mut ed, "e8.setMark(0), e8.gotoChar(81)");
    ed.call("fill-region", vec![]).unwrap();
    assert_eq!(
        ed.window_buffer().text(),
        "aaa bbb ccc ddd eee\nfff\n- ggg hhh iii jjj\n  kkk lll\n- mmm\n\nnnn ooo ppp qqq rrr\nsss\n"
    );
}

/// fill-region in Org takes each line's prefix from org-adaptive-fill-function,
/// as adaptive-fill-function, and its comment and keyword lines continue as
/// Emacs 30.2's do, a comment start that would start a paragraph left off.
#[test]
fn fill_region_in_org_takes_its_adaptive_prefix() {
    let cases = [
        ("# aaa bbb ccc ddd eee fff ggg hhh\n", "# aaa bbb ccc ddd\neee fff ggg hhh\n"),
        ("#+TITLE: aaa bbb ccc ddd eee fff ggg hhh\ntext\n", "#+TITLE: aaa bbb ccc\n#ddd eee fff ggg hhh\ntext\n"),
        ("- aaa bbb ccc ddd eee fff ggg hhh\n", "- aaa bbb ccc ddd\n  eee fff ggg hhh\n"),
        ("Some aaa bbb ccc ddd eee fff ggg hhh\n", "Some aaa bbb ccc ddd\neee fff ggg hhh\n"),
    ];
    let mut failures = Vec::new();
    for (start, want) in cases {
        let mut ed = Editor::new();
        let s = Scripting::new(&mut ed).unwrap();
        ed.window_buffer_mut().set_text(start);
        ed.call("org-mode", vec![]).unwrap();
        eval(&s, &mut ed, "e8.setVariable('fill-column', 20)");
        eval(&s, &mut ed, &format!("e8.setMark(0), e8.gotoChar({})", start.chars().count()));
        ed.call("fill-region", vec![]).unwrap();
        let got = ed.window_buffer().text();
        if got != want {
            failures.push(format!("{start:?}: {got:?}, Emacs {want:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
