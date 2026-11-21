//! The agenda's search view: what the Emacs oracle cannot see, other
//! files, and where point is when [ and { ask for the string again.

use std::cell::RefCell;
use std::rc::Rc;

use e8_core::{Editor, Key, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.set_variable("e8--today", Value::Str("2026-11-20".into()));
    (ed, scripting)
}

fn agenda(ed: &Editor) -> String {
    ed.buffers().iter().find(|b| b.name == "*Org Agenda*").map(|b| b.slice(0..b.len())).unwrap()
}

/// The agenda's lines after the two of its header, their ends trimmed.
fn entries(ed: &Editor) -> Vec<String> {
    agenda(ed).lines().skip(2).map(|l| l.trim_end().to_string()).collect()
}

/// Answers prompts in turn with `answers`, each typed after what the
/// prompt starts with and confirmed with RET, noting the input and where
/// point was in it as each prompt opened.
fn answering(ed: &mut Editor, answers: &[&str]) -> Rc<RefCell<Vec<(String, usize)>>> {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let noted = seen.clone();
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        if ed.prompt().is_none() {
            return false;
        }
        let Some(answer) = left.pop_front() else { return false };
        noted.borrow_mut().push((ed.minibuffer_input(), ed.minibuffer_input_point()));
        ed.type_text(&answer);
        ed.handle_key(Key::parse("RET").unwrap());
        true
    });
    seen
}

fn files(ed: &mut Editor, s: &Scripting, dir: &std::path::Path, agenda: &[(&str, &str)], extra: &[&str]) {
    let path = |name: &str| dir.join(name).to_str().unwrap().to_string();
    for (name, text) in agenda {
        std::fs::write(dir.join(name), text).unwrap();
    }
    let list = |names: Vec<String>| names.iter().map(|n| format!("{n:?}")).collect::<Vec<_>>().join(", ");
    let code = format!(
        "e8.setVariable(\"org-agenda-files\", [{}]); e8.setVariable(\"org-agenda-text-search-extra-files\", [{}]);",
        list(agenda.iter().map(|(n, _)| path(n)).filter(|p| !extra.iter().any(|e| p.ends_with(e))).collect()),
        list(extra.iter().map(|n| path(n)).collect()),
    );
    s.eval_typescript(ed, "files.ts", code).unwrap();
}

/// The agenda files in their order, then org-agenda-text-search-extra-files,
/// each once, as org-search-view uniquifies them.
#[test]
fn the_search_view_reads_agenda_files_then_the_extra_ones() {
    let (mut ed, s) = org("");
    let dir = tempfile::tempdir().unwrap();
    files(&mut ed, &s, dir.path(), &[("alpha.org", "* One milk\n* Two\n"), ("beta.org", "* Three\nmilk\n"), ("gamma.org", "* Four milk\n")], &["gamma.org"]);
    // beta.org also among the extra files: still read once.
    s.eval_typescript(
        &mut ed,
        "more.ts",
        format!("e8.setVariable(\"org-agenda-text-search-extra-files\", [{:?}, {:?}]);", dir.path().join("gamma.org").to_str().unwrap(), dir.path().join("beta.org").to_str().unwrap()),
    )
    .unwrap();
    answering(&mut ed, &["milk"]);
    ed.call("org-search-view", vec![]).unwrap();
    assert_eq!(entries(&ed), ["  alpha:      One milk", "  beta:       Three", "  gamma:      Four milk"]);
}

/// [ asks again with " +" added and point after it, { with " +{}" and
/// point inside the braces, as org-agenda-manipulate-query's EDIT-AT puts
/// it; what an earlier one added and was not used goes first.
#[test]
fn adding_to_the_query_asks_with_point_where_the_word_goes() {
    let (mut ed, s) = org("");
    let dir = tempfile::tempdir().unwrap();
    files(&mut ed, &s, dir.path(), &[("alpha.org", "* Milk from the shop\n* Milk from the farm\n* Bread from the shop\n")], &[]);
    let seen = answering(&mut ed, &["+milk", "shop", "farm"]);
    ed.call("org-search-view", vec![]).unwrap();
    assert_eq!(entries(&ed).len(), 2);
    ed.press("[").unwrap();
    assert_eq!(entries(&ed), ["  alpha:      Milk from the shop"]);
    assert_eq!(agenda(&ed).lines().next(), Some("Search words: +milk +shop"));
    ed.press("}").unwrap();
    assert_eq!(seen.borrow()[1], ("+milk +".to_string(), 7));
    assert_eq!(seen.borrow()[2], ("+milk +shop -{}".to_string(), 14), "inside the braces");
    assert_eq!(agenda(&ed).lines().next(), Some("Search words: +milk +shop -{farm}"));
    assert_eq!(entries(&ed), ["  alpha:      Milk from the shop"]);
}

#[test]
fn other_views_cannot_add_to_a_query() {
    let (mut ed, s) = org("");
    let dir = tempfile::tempdir().unwrap();
    files(&mut ed, &s, dir.path(), &[("alpha.org", "* TODO One\n")], &[]);
    ed.call("org-todo-list", vec![]).unwrap();
    ed.press("[").unwrap();
    let error = ed.take_error().map(|e| e.to_string());
    assert_eq!(error.as_deref(), Some("Cannot manipulate query for todo-type agenda buffers"));
}

/// The agenda's lines run off the window and n moves by them, not by the
/// screen's lines, as org-agenda-mode sets truncate-lines and
/// line-move-visual there only.
#[test]
fn the_agenda_moves_by_its_lines() {
    let (mut ed, s) = org("");
    let dir = tempfile::tempdir().unwrap();
    files(&mut ed, &s, dir.path(), &[("alpha.org", "* One milk\n")], &[]);
    answering(&mut ed, &["milk"]);
    ed.call("org-search-view", vec![]).unwrap();
    // The second line, of help, is wider than the window.
    ed.press("n n").unwrap();
    assert_eq!(ed.window_buffer().name, "*Org Agenda*");
    let at = ed.window_buffer().point();
    let text = agenda(&ed);
    assert_eq!(text.chars().take(at).filter(|&c| c == '\n').count(), 2, "on the first entry");
    assert_eq!(ed.variable("truncate-lines").map(|v| v.is_true()), Some(true));
    assert_eq!(s.eval_expression(&mut ed, r#"String(e8.withCurrentBuffer("alpha.org", () => e8.variable("line-move-visual")))"#).unwrap(), "\"true\"");
}
