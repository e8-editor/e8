//! Sorting tables and lists by a function of one's own, and timer lists,
//! which the Emacs oracle cannot record: its functions are Lisp's, and
//! batch Emacs sorts no timer list without org-timer loaded.

use e8_core::Editor;
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            format!("e8.insert({text:?});")
                + r#"
            e8.defun("test-length", (s?: string) => (s ?? e8.lineText(e8.lineOf(e8.point()))).trim().length);
            e8.defun("test-greater", (a: number, b: number) => a > b);
            e8.defun("test-nothing", () => null);
            "#,
        )
        .unwrap();
    (ed, scripting)
}

/// Answers the questions C-c ^ asks with ANSWERS, typed and then RET, or a key for the sorting type.
fn sort(ed: &mut Editor, point: usize, answers: &[&str]) {
    ed.window_buffer_mut().set_point(point);
    let mut keys = String::from("C-c ^ ");
    keys.push_str(answers[0]);
    for a in &answers[1..] {
        for c in a.chars() {
            keys.push(' ');
            keys.push(c);
        }
        keys.push_str(" RET");
    }
    ed.press(&keys).unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// f sorts a table's lines by the key a function gives each field, compared by another.
#[test]
fn a_table_by_functions() {
    let (mut ed, _s) = org("| ccc |\n| a |\n| bb |\n");
    sort(&mut ed, 3, &["f", "test-length", "test-greater"]);
    assert_eq!(text(&ed), "| ccc |\n| bb |\n| a |\n");
}

/// With no comparing function, numbers compare by <, and F reverses it.
#[test]
fn a_table_by_a_key_alone_reversed() {
    let (mut ed, _s) = org("| a |\n| ccc |\n| bb |\n");
    sort(&mut ed, 3, &["F", "test-length", ""]);
    assert_eq!(text(&ed), "| ccc |\n| bb |\n| a |\n");
}

/// A list's key function is called at each item's start.
#[test]
fn a_list_by_a_function() {
    let (mut ed, _s) = org("- ccc\n- a\n- bb\n");
    sort(&mut ed, 1, &["f", "test-length", ""]);
    assert_eq!(text(&ed), "- a\n- bb\n- ccc\n");
}

/// t sorts a timer list by its times.
#[test]
fn a_timer_list() {
    let (mut ed, _s) = org("- 0:10:00 :: later\n- 0:01:05 :: soon\n- 1:00:00 :: last\n");
    sort(&mut ed, 1, &["t"]);
    assert_eq!(text(&ed), "- 0:01:05 :: soon\n- 0:10:00 :: later\n- 1:00:00 :: last\n");
}

/// A key function giving nothing sorts the lines by their text, as sort-subr takes the record then.
#[test]
fn a_table_by_a_key_that_is_not_there() {
    let (mut ed, _s) = org("| b |\n| a |\n| c |\n");
    sort(&mut ed, 3, &["f", "test-nothing", ""]);
    assert_eq!(text(&ed), "| a |\n| b |\n| c |\n");
}

/// A timer after a counter, its hours as long as they are.
#[test]
fn a_timer_list_with_a_counter() {
    let (mut ed, _s) = org("1. [@3] 100:00:00 :: last\n2. 0:01:05 :: first\n");
    sort(&mut ed, 1, &["t"]);
    assert_eq!(text(&ed), "1. 0:01:05 :: first\n3. [@3] 100:00:00 :: last\n");
}

/// Sorting entries already in order rewrites them, as sort-subr does, but
/// leaves a buffer with no changes unmodified, as
/// with-buffer-unmodified-if-unchanged; an order that changes modifies it.
#[test]
fn entries_in_order_leave_the_buffer_unmodified() {
    let (mut ed, _s) = org("* P\n** A\n** B\n");
    ed.window_buffer_mut().set_modified(false);
    sort(&mut ed, 0, &["a"]);
    assert_eq!(text(&ed), "* P\n** A\n** B\n");
    assert!(!ed.window_buffer().is_modified());
    sort(&mut ed, 0, &["A"]);
    assert_eq!(text(&ed), "* P\n** B\n** A\n");
    assert!(ed.window_buffer().is_modified());
}

/// The functions are read with completion, as org-read-function: a name
/// that is no function is not taken.
#[test]
fn sort_functions_must_be_functions() {
    let (mut ed, _s) = org("| bb |\n| a |\n| ccc |\n");
    ed.window_buffer_mut().set_point(2);
    // "no-such" is refused and the prompt stays, to be answered again.
    ed.press("C-c ^ f n o - s u c h RET C-a C-k t e s t - l e n g t h RET RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("[No match]".into()));
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "| a |\n| bb |\n| ccc |\n");
}
