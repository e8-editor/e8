//! LaTeX environments in Org, which the Emacs oracle compares key by key;
//! here, what it cannot: how long many environments left open take.

use e8_core::Editor;
use e8_script::Scripting;
use std::time::{Duration, Instant};

/// Each `\begin` without its `\end` searches to the section's end, as
/// Org's parser does; a section of thousands of them is still parsed in
/// one pass, not one per environment.
#[test]
fn many_environments_left_open_are_quick() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    s.eval_expression(
        &mut ed,
        r#"(() => {
          const lines = [];
          for (let i = 0; i < 3000; i++) lines.push(`\\begin{equation} ${i}`, "text");
          e8.insert(`* H\n${lines.join("\n")}\n\\begin{x}\ny\n\\end{x}\nlast\n`);
        })()"#,
    )
    .unwrap();
    let start = Instant::now();
    // M-h on the environment closed at the end, after them all: the parse reads the whole section.
    let found = s
        .eval_expression(
            &mut ed,
            r#"(e8.gotoChar(e8.lineStart(e8.lineCount() - 3)), e8.call("org-mark-element"), [e8.point(), e8.mark()])"#,
        )
        .unwrap();
    let elapsed = start.elapsed();
    let text = s.eval_expression(&mut ed, r#"e8.bufferText(e8.point(), e8.mark())"#).unwrap();
    assert_eq!(text, r#""\\begin{x}\ny\n\\end{x}\n""#, "{found}");
    let limit = if std::env::var_os("CI").is_some() { 9 } else { 3 };
    assert!(elapsed < Duration::from_secs(limit), "took {elapsed:?}");
}

/// The text of an environment is raw: `C-c C-c` on what looks like a
/// checkbox there changes nothing, and after an edit that closes one, it
/// is found again.
#[test]
fn closing_an_environment_is_seen_at_once() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    s.eval_expression(&mut ed, r#"e8.insert("\\begin{x}\n- [ ] a\n")"#).unwrap();
    ed.window_buffer_mut().set_point(14);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "\\begin{x}\n- [X] a\n");
    s.eval_expression(&mut ed, r#"(e8.gotoChar(e8.pointMax()), e8.insert("\\end{x}\n"), e8.gotoChar(14))"#).unwrap();
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("‘C-c C-c’ can do nothing useful here".into()));
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "\\begin{x}\n- [X] a\n\\end{x}\n");
}
