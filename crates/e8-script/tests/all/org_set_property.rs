//! C-c C-x p, org-set-property: what the Emacs oracle cannot see, as batch
//! Emacs answers its questions without completing-read: the prompts, the
//! names and values offered, a value not allowed refused, and the
//! functions org-property-set-functions-alist and
//! org-properties-postprocess-alist name.

use e8_core::{Editor, Key};
use e8_script::Scripting;

const DOC: &str = "#+PROPERTY: Owner_ALL alice bob\n#+COLUMNS: %25ITEM %Cost\n\
* TODO Report\n:PROPERTIES:\n:Effort: 1:00\n:Color: red\n:END:\n\
* Task\n:PROPERTIES:\n:Color: blue\n:END:\n* Other\n";

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    (ed, scripting)
}

fn goto(ed: &mut Editor, text: &str) {
    let b = ed.window_buffer();
    let at = b.slice(0..b.len()).find(text).unwrap();
    let pos = b.slice(0..at).chars().count();
    ed.window_buffer_mut().set_point(pos);
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// What each question asked, and what the minibuffer offered after TAB on
/// the typed start of the answer, answering each with ANSWERS' text.
fn set_property(ed: &mut Editor, answers: &[(&str, &str)]) -> Vec<(String, Vec<String>)> {
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let noted = seen.clone();
    let mut left: std::collections::VecDeque<(String, String)> = answers.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    ed.set_input_source(move |ed| {
        let Some(prompt) = ed.prompt().map(str::to_string) else { return false };
        let Some((start, rest)) = left.pop_front() else { return false };
        ed.type_text(&start);
        let offered = ed.minibuffer_completions();
        noted.borrow_mut().push((prompt, offered));
        ed.type_text(&rest);
        ed.handle_key(Key::parse("RET").unwrap());
        true
    });
    ed.press("C-c C-x p").unwrap();
    let out = seen.borrow().clone();
    out
}

/// The name's prompt offers the default and completes the buffer's names
/// and Org's; the value's says the current value and completes those used.
#[test]
fn the_prompts_offer_names_and_values() {
    let (mut ed, _s) = org(DOC);
    goto(&mut ed, "* Task");
    let asked = set_property(&mut ed, &[("Co", "lor"), ("", "green")]);
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(asked[0].0, "Property: ");
    // Color from the drawers, COLUMNS and COOKIE_DATA, Org's own, Cost from #+COLUMNS.
    for name in ["Color", "COLUMNS", "COOKIE_DATA", "Cost"] {
        assert!(asked[0].1.iter().any(|c| c == name), "{name} in {:?}", asked[0].1);
    }
    assert_eq!(asked[1].0, "Color value [blue]: ");
    assert!(asked[1].1.contains(&"red".to_string()) && asked[1].1.contains(&"blue".to_string()), "{:?}", asked[1].1);
    assert!(text(&ed).contains(":Color:    green"), "{}", text(&ed));
    // The next one asked offers the last set as its default.
    goto(&mut ed, "* Other");
    let asked = set_property(&mut ed, &[("", ""), ("", "x")]);
    assert_eq!(asked[0].0, "Property [Color]: ");
    assert_eq!(asked[1].0, "Color value: ");
}

/// A property with allowed values offers only them, and refuses another.
#[test]
fn allowed_values_are_required() {
    let (mut ed, _s) = org(DOC);
    goto(&mut ed, "* Other");
    let asked = set_property(&mut ed, &[("Owner", ""), ("", "carol")]);
    assert_eq!(asked[1].0, "Owner value: ");
    assert_eq!(asked[1].1, vec!["alice", "bob"]);
    assert!(!text(&ed).contains("carol"), "{}", text(&ed));
}

/// org-property-set-functions-alist reads the value instead, and
/// org-properties-postprocess-alist turns it into the one stored.
#[test]
fn the_alists_read_and_store_the_value() {
    let (mut ed, s) = org(DOC);
    for code in [
        "e8.defun('e8-test-read', (prompt) => prompt.toUpperCase())",
        "e8.defun('e8-test-post', (value) => value + '!')",
        "e8.setVariable('org-property-set-functions-alist', [['Shout', 'e8-test-read']])",
        "e8.setVariable('org-properties-postprocess-alist', [['shout', 'e8-test-post']])",
    ] {
        s.eval_expression(&mut ed, code).unwrap();
    }
    goto(&mut ed, "* Other");
    ed.set_input_source(|ed| {
        if ed.prompt().is_none() {
            return false;
        }
        ed.type_text("Shout");
        ed.handle_key(Key::parse("RET").unwrap());
        true
    });
    ed.press("C-c C-x p").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    // Trimmed, as org-read-property-value trims what it read, then postprocessed.
    assert!(text(&ed).contains(":Shout:    SHOUT VALUE:!"), "{}", text(&ed));
    let last = s.eval_expression(&mut ed, "e8.variable('org-last-set-property-value')").unwrap();
    assert_eq!(last.trim_matches('"'), "Shout: SHOUT VALUE:");
}
