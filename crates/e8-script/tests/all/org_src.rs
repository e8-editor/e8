//! Editing an Org block in a buffer of its own, C-c ', with what Emacs 30's
//! org-edit-special gives for each case.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn org(text: &str, at: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("rename-buffer", vec![Arg::Str("t.org".into())]).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    let i = text.find(at).unwrap();
    ed.window_buffer_mut().set_point(text[..i].chars().count());
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn name(ed: &Editor) -> String {
    ed.window_buffer().name.clone()
}

#[test]
fn a_source_block_is_edited_in_its_language_s_mode_and_goes_back_indented() {
    let (mut ed, _s) = org("* H\n#+begin_src python\n  x = 1\n  y = 2\n#+end_src\n", "y =");
    ed.press("C-c '").unwrap();
    assert_eq!(name(&ed), "*Org Src t.org[ python ]*");
    assert_eq!(text(&ed), "x = 1\ny = 2\n");
    assert_eq!(ed.window_buffer().point(), 6);
    // python-mode, which E8 remaps to python-ts-mode.
    assert!(ed.variable("major-mode").and_then(|v| v.as_str().map(String::from)).is_some_and(|m| m.starts_with("python")));
    assert_eq!(
        ed.variable("header-line-format").and_then(|v| v.as_str().map(String::from)).as_deref(),
        Some("Edit, then exit with \u{2018}C-c '\u{2019} or abort with \u{2018}C-c C-k\u{2019}")
    );
    ed.press("C-f C-f z z C-c '").unwrap();
    assert_eq!(name(&ed), "t.org");
    assert_eq!(text(&ed), "* H\n#+begin_src python\n  x = 1\n  y zz= 2\n#+end_src\n");
    assert_eq!(ed.window_buffer().point(), 37);
    assert!(ed.find_buffer("*Org Src t.org[ python ]*").is_none());
}

#[test]
fn aborting_leaves_the_block_as_it_was() {
    let (mut ed, _s) = org("* H\n#+begin_src python\n  x = 1\n  y = 2\n#+end_src\n", "y =");
    ed.press("C-c ' z z C-c C-k").unwrap();
    assert_eq!(name(&ed), "t.org");
    assert_eq!(text(&ed), "* H\n#+begin_src python\n  x = 1\n  y = 2\n#+end_src\n");
    assert_eq!(ed.window_buffer().point(), 23);
}

#[test]
fn an_indented_block_loses_and_gets_back_its_indentation() {
    let (mut ed, s) = org("- item\n  #+begin_src python\n    if a:\n        b\n  #+end_src\n", "#+begin");
    ed.press("C-c '").unwrap();
    assert_eq!(text(&ed), "if a:\n    b\n");
    assert_eq!(ed.window_buffer().point(), 0);
    ed.press("C-e").unwrap();
    s.eval_expression(&mut ed, r#"e8.insert("\nc")"#).unwrap();
    ed.press("C-c '").unwrap();
    assert_eq!(text(&ed), "- item\n  #+begin_src python\n    if a:\n    c\n        b\n  #+end_src\n");
    assert_eq!(ed.window_buffer().point(), 43);
}

#[test]
fn content_indentation_comes_from_the_org_buffer() {
    let (mut ed, s) = org("* H\n#+begin_src python\nx = 1\n#+end_src\n", "x");
    s.eval_expression(&mut ed, r#"e8.makeLocalVariable("org-edit-src-content-indentation"), e8.setVariable("org-edit-src-content-indentation", 0)"#).unwrap();
    ed.press("C-c ' w C-c '").unwrap();
    assert_eq!(text(&ed), "* H\n#+begin_src python\nwx = 1\n#+end_src\n");
    assert_eq!(ed.window_buffer().point(), 24);
}

#[test]
fn an_example_block_is_edited_as_text_and_left_alone_unchanged() {
    let (mut ed, _s) = org("* H\n#+begin_example\n  hello\n#+end_example\n", "hello");
    ed.press("C-c '").unwrap();
    assert_eq!(name(&ed), "*Org Src t.org[ example ]*");
    assert_eq!(text(&ed), "hello\n");
    ed.press("C-c '").unwrap();
    assert_eq!(text(&ed), "* H\n#+begin_example\n  hello\n#+end_example\n");
    assert_eq!(ed.window_buffer().point(), 22);
}

#[test]
fn point_on_the_end_line_starts_at_the_end_of_the_text() {
    let (mut ed, _s) = org("* H\n#+begin_src python\n  x = 1\n#+end_src\n", "#+end");
    ed.press("C-c '").unwrap();
    assert_eq!(ed.window_buffer().point(), 5);
    ed.press("C-c '").unwrap();
    assert_eq!(ed.window_buffer().point(), 30);
}

#[test]
fn outside_a_block_there_is_nothing_to_edit() {
    let (mut ed, _s) = org("* H\ntext\n", "text");
    ed.press("C-c '").unwrap();
    assert_eq!(name(&ed), "t.org");
    assert_eq!(ed.echo(), Some("No special environment to edit here"));
}

#[test]
fn saving_puts_the_text_back_and_stays() {
    let (mut ed, _s) = org("* H\n#+begin_src python\n  x = 1\n#+end_src\n", "x");
    ed.press("C-c ' y").unwrap();
    ed.call("org-edit-src-save", vec![]).ok();
    assert_eq!(name(&ed), "*Org Src t.org[ python ]*");
    let org = &ed.buffers()[ed.find_buffer("t.org").unwrap()];
    assert_eq!(org.slice(0..org.len()), "* H\n#+begin_src python\n  yx = 1\n#+end_src\n");
}

#[test]
fn tab_in_a_source_block_indents_as_the_language_s_mode_does() {
    // What Emacs 30 gives, with org-src-tab-acts-natively on as by default.
    for (before, at, after, point) in [
        (
            "* H\n#+begin_src emacs-lisp\n  (let ((a 1))\n(foo a))\n#+end_src\n",
            "(foo",
            "* H\n#+begin_src emacs-lisp\n    (let ((a 1))\n      (foo a))\n#+end_src\n",
            50,
        ),
        (
            "- item\n  #+begin_src emacs-lisp\n    (when x\n  y)\n  #+end_src\n",
            "y)",
            "- item\n  #+begin_src emacs-lisp\n      (when x\n        y)\n  #+end_src\n",
            54,
        ),
        ("* H\n#+begin_src emacs-lisp\n  (let ((a 1))\n    (foo a))\n#+end_src\n", "foo", "* H\n#+begin_src emacs-lisp\n  (let ((a 1))\n    (foo a))\n#+end_src\n", 47),
    ] {
        let (mut ed, _s) = org(before, at);
        ed.press("TAB").unwrap();
        assert_eq!(text(&ed), after);
        assert_eq!(ed.window_buffer().point(), point, "{before:?}");
        assert_eq!(name(&ed), "t.org");
        assert!(ed.find_buffer("*Org Src t.org[ emacs-lisp ]*").is_none());
    }
}

#[test]
fn tab_natively_uses_the_org_buffer_s_content_indentation() {
    let (mut ed, s) = org("* H\n#+begin_src emacs-lisp\n(let ((a 1))\n(foo a))\n#+end_src\n", "(foo");
    s.eval_expression(&mut ed, r#"(e8.makeLocalVariable("org-edit-src-content-indentation"), e8.setVariable("org-edit-src-content-indentation", 0))"#).unwrap();
    ed.press("TAB").unwrap();
    assert_eq!(text(&ed), "* H\n#+begin_src emacs-lisp\n(let ((a 1))\n  (foo a))\n#+end_src\n");
    assert_eq!(ed.window_buffer().point(), 42);
}

#[test]
fn a_typescript_block_gets_typescript_s_faces_and_mode() {
    // As in Emacs with typescript-ts-mode, which typescript-mode runs here,
    // as org-src-get-lang-mode looks for LANGUAGE-mode.
    let (mut ed, _s) = org("* H\n#+begin_src typescript\nconst x: number = 1;\n#+end_src\n", "x:");
    ed.set_frame_size(100, 20);
    ed.redisplay();
    let faces = |ed: &Editor, at: usize| match ed.window_buffer().text_property(at, "face") {
        Some(e8_core::Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>(),
        Some(e8_core::Value::Str(s)) => vec![s.clone()],
        _ => Vec::new(),
    };
    let at = |needle: &str| text(&ed)[..text(&ed).find(needle).unwrap()].chars().count();
    assert_eq!(faces(&ed, at("const")), ["font-lock-keyword-face", "org-block"]);
    assert_eq!(faces(&ed, at("number")), ["font-lock-type-face", "org-block"]);
    ed.press("C-c '").unwrap();
    assert_eq!(ed.variable("major-mode").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("typescript-ts-mode"));
    assert_eq!(name(&ed), "*Org Src t.org[ typescript ]*");
}
