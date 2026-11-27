//! Column view where the Emacs oracle cannot look: the header line, which
//! batch Emacs sets only from a post-command hook, the columns' keymap and
//! read-only text, and leaving column view.

use e8_core::Editor;
use e8_script::Scripting;

const TEXT: &str = "#+COLUMNS: %10ITEM %TODO %Effort{:}\n* TODO Project\n** TODO Write\n:PROPERTIES:\n:Effort: 1:00\n:END:\n** Call\n:PROPERTIES:\n:Effort: 0:30\n:END:\n";

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text(TEXT);
    ed.call("org-mode", vec![]).unwrap();
    ed.press("M-<").unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap().trim_matches('"').to_string()
}

/// The header line holds the columns' titles, each as wide as its column,
/// after a space aligned to the text's left edge; q takes it away again.
#[test]
fn the_header_line_holds_the_titles() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('header-line-format') ?? 'none')"), "none");
    // Truncated already, as org-startup-truncated has it.
    eval(&mut ed, &s, "e8.setVariable('truncate-lines', false)");
    ed.press("C-c C-x C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('header-line-format'))"), " ITEM       | TODO | Effort |");
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('truncate-lines'))"), "true");
    ed.press("C-n q").unwrap();
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('header-line-format') ?? 'none')"), "none");
    assert_eq!(eval(&mut ed, &s, "String(e8.variable('truncate-lines'))"), "false");
}

/// The rows are read-only, telling how to edit, and their keys are column
/// view's: v shows the whole value, e edits it.
#[test]
fn the_rows_are_read_only_with_their_own_keys() {
    let (mut ed, _s) = setup();
    ed.press("C-c C-x C-c C-n C-n C-f C-f").unwrap();
    ed.press("v").unwrap();
    assert_eq!(ed.echo(), Some("Value is: 1:00"));
    // The answer in the same call, as a prompt is answered by the keys that open it.
    ed.press("e C-a C-k 2 : 0 0 RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    let text = ed.window_buffer().slice(0..ed.window_buffer().len());
    // Under the column's name, upcased, as org-entry-put rewrites the line.
    assert!(text.contains(":EFFORT:   2:00\n"), "{text}");
    ed.press("q C-a").unwrap();
    ed.type_text("x");
    assert_eq!(ed.take_error().map(|e| e.to_string()), None, "writable again after q");
}
