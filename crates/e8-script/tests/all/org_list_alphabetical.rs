//! Lettered bullets, org-list-allow-alphabetical, where E8 differs from Org
//! and so the Emacs oracle cannot compare: the setting takes as soon as it
//! is set, where Org's parser takes it only when loaded or brought up to
//! date with org-element-update-syntax.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str, point: usize) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    scripting.eval_expression(&mut ed, &format!("e8.insert({text:?})")).unwrap();
    ed.window_buffer_mut().set_point(point);
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.buffer();
    b.slice(0..b.len())
}

/// Set after Org has loaded, the setting takes at once.
#[test]
fn the_setting_takes_without_updating_the_syntax() {
    let (mut ed, _s) = org("a. one\nb. two\n", 6);
    ed.press("M-RET x").unwrap();
    assert_eq!(text(&ed), "a. one\n* x\nb. two\n");
    let (mut ed, _s) = org("a. one\nb. two\n", 6);
    ed.set_default("org-list-allow-alphabetical", Value::Bool(true));
    ed.press("M-RET x").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "a. one\nb. x\nc. two\n");
    // And is taken back as soon.
    ed.set_default("org-list-allow-alphabetical", Value::Null);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "a. one\nb. x\nc. two\n");
}

/// The face at a position, after redisplay has fontified the buffer.
fn face(ed: &mut Editor, pos: usize) -> String {
    ed.redisplay();
    match ed.window_buffer().text_property(pos, "face") {
        Some(Value::Str(s)) => s.clone(),
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(","),
        _ => String::new(),
    }
}

/// A lettered item's checkbox has its face whatever the setting, as Org's
/// font-lock reads items by org-list-full-item-re, and a description term
/// has one only after an unordered bullet, as in Emacs 30.
#[test]
fn checkbox_and_term_faces_on_lettered_items() {
    let (mut ed, _s) = org("b. [ ] box\n", 0);
    assert_eq!(face(&mut ed, 4), "org-checkbox");
    let (mut ed, _s) = org("a. term :: desc\n- term :: desc\n", 0);
    ed.set_default("org-list-allow-alphabetical", Value::Bool(true));
    assert_eq!(face(&mut ed, 4), "");
    assert!(face(&mut ed, 18).contains("org-list-dt"), "{}", face(&mut ed, 18));
}

/// org-indent-mode wraps an item's lines under its text only where
/// org-at-item-p sees an item: a lettered one with the setting, never in an
/// example block. What Emacs 30 gives, prefix by prefix.
#[test]
fn org_indent_wraps_items_where_org_sees_them() {
    let wrap = |alpha: bool| {
        let (mut ed, s) = org("* H\na. one two\n#+begin_example\nb. x\n#+end_example\n", 0);
        if alpha {
            ed.set_default("org-list-allow-alphabetical", Value::Bool(true));
        }
        ed.press("M-x o r g - i n d e n t - m o d e RET").unwrap();
        let get = |ed: &mut Editor, line: usize| {
            s.eval_expression(ed, &format!("String(e8.getTextProperty(e8.lineStart({line}), 'wrap-prefix') ?? '').length")).unwrap()
        };
        (get(&mut ed, 1), get(&mut ed, 3))
    };
    assert_eq!(wrap(false), ("2".to_string(), "2".to_string()));
    assert_eq!(wrap(true), ("5".to_string(), "2".to_string()));
}

/// Capture prepending an item to a lettered list keeps it lettered, or
/// numbers it from a - template, as Org does by the plain list's type.
#[test]
fn capture_prepends_to_a_lettered_list() {
    for (template, expected) in [("- %?", "* Inbox\n1. new\n2. one\n3. two\n"), ("a. %?", "* Inbox\na. new\nb. one\nc. two\n")] {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let file = dir.path().join("notes.org");
        std::fs::write(&file, "* Inbox\na. one\nb. two\n").unwrap();
        let mut ed = Editor::new();
        let s = Scripting::new(&mut ed).unwrap();
        ed.set_default("org-list-allow-alphabetical", Value::Bool(true));
        let templates = format!(r#"[["t", "T", "item", ["file+headline", {:?}, "Inbox"], {:?}, ":prepend", true]]"#, file.to_str().unwrap(), template);
        s.eval_expression(&mut ed, &format!("(e8.setVariable('org-capture-templates', {templates}), 1)")).unwrap();
        ed.set_frame_size(80, 24);
        ed.press("M-x o r g - c a p t u r e RET t n e w C-c C-c").unwrap();
        assert_eq!(ed.take_error().map(|e| e.to_string()), None);
        let text = ed.buffers().iter().find(|b| b.name == "notes.org").map(|b| b.slice(0..b.len())).unwrap();
        assert_eq!(text, expected, "{template}");
    }
}

/// A buffer that made the variable its own without setting it keeps its
/// value when the global one changes, as no watcher sees make-local-variable.
#[test]
fn a_buffer_made_local_keeps_its_value_when_the_global_changes() {
    let (mut ed, s) = org("a. one\nb. two", 13);
    s.eval_expression(&mut ed, "(() => { e8.makeLocalVariable(\"org-list-allow-alphabetical\"); e8.setDefault(\"org-list-allow-alphabetical\", true); })()").unwrap();
    ed.press("M-RET x").unwrap();
    assert_eq!(text(&ed), "a. one\nb. two\n* x");
}

/// makunbound of a buffer's own value leaves the global value as it is,
/// though it reaches the watchers as a global change.
#[test]
fn makunbound_of_a_buffer_value_leaves_the_global_one() {
    let (mut ed, s) = org("aaa\nb. c\n", 0);
    s.eval_expression(
        &mut ed,
        "(() => { e8.setDefault(\"org-list-allow-alphabetical\", true); \
         const other = e8.getBufferCreate(\"other.org\"); \
         e8.withCurrentBuffer(other, () => { e8.makeLocalVariable(\"org-list-allow-alphabetical\"); e8.setVariable(\"org-list-allow-alphabetical\", true); e8.makunbound(\"org-list-allow-alphabetical\"); }); \
         e8.makeLocalVariable(\"org-list-allow-alphabetical\"); e8.setVariable(\"org-list-allow-alphabetical\", null); })()",
    )
    .unwrap();
    // The paragraph separator keeps to the global value, t, so b. ends the paragraph and M-q leaves it.
    ed.press("M-q").unwrap();
    assert_eq!(text(&ed), "aaa\nb. c\n");
}
