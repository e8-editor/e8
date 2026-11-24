//! Marking agenda lines for a bulk action: what the Emacs oracle cannot
//! see, the marks themselves, overlays showing org-agenda-bulk-mark-char
//! in place of each marked line's first two characters, and the custom
//! actions org-agenda-bulk-custom-functions adds.

use std::cell::RefCell;
use std::rc::Rc;

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TASKS: &str = "* TODO Report :work:\nSCHEDULED: <2026-10-28 Wed>\n* TODO Pay\nDEADLINE: <2026-10-30 Fri>\n\
* TODO Call Bob :home:\nSCHEDULED: <2026-10-29 Thu>\n* Meeting <2026-10-28 Wed 10:00>\n";

/// Visits `tasks.org`, holding `text`, as the one agenda file, with today fixed.
fn agenda_file(text: &str) -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, text).unwrap();
    ed.set_default("org-agenda-use-time-grid", Value::Null);
    ed.call("find-file", vec![e8_core::Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 40);
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    (ed, scripting, dir)
}

/// Answers each character read with the next of `answers`, noting what the echo area asked.
fn answering(ed: &mut Editor, answers: &[&str]) -> Rc<RefCell<Vec<String>>> {
    let asked = Rc::new(RefCell::new(Vec::new()));
    let noted = asked.clone();
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        let Some(answer) = left.pop_front() else { return false };
        noted.borrow_mut().push(ed.prompt().or(ed.echo()).unwrap_or_default().to_string());
        ed.type_text(&answer);
        true
    });
    asked
}

/// The agenda's marked lines: each one's text, and what its mark shows before it and in place of its first two characters.
fn marks(ed: &mut Editor, s: &Scripting) -> Vec<(String, String, String)> {
    let json = s
        .eval_expression(
            ed,
            r#"e8.withCurrentBuffer('*Org Agenda*', () => JSON.stringify(e8.overlaysIn(e8.pointMin(), e8.pointMax())
                .filter((o) => e8.overlayGet(o, 'type') === 'org-marked-entry-overlay')
                .map((o) => [e8.lineText(e8.lineOf(e8.overlayStart(o))).trim(), String(e8.overlayGet(o, 'before-string')), String(e8.overlayGet(o, 'display')), e8.overlayEnd(o) - e8.overlayStart(o)])
                .sort()))"#,
        )
        .unwrap();
    let all: Vec<(String, String, String, usize)> = serde_json::from_str(&serde_json::from_str::<String>(&json).unwrap()).unwrap();
    assert!(all.iter().all(|m| m.3 == 2), "{all:?}");
    all.into_iter().map(|(l, b, d, _)| (l, b, d)).collect()
}

/// Whether the marked line's text starts with WORDS, its mark showing > and a space.
fn marked(words: &str) -> (String, String, String) {
    (words.to_string(), ">".to_string(), " ".to_string())
}

/// m marks the line with an overlay showing > and a space in place of its
/// first two characters, and moves to the next entry's line.
#[test]
fn a_mark_shows_in_place_of_the_lines_first_two_characters() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N m").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("1 entries marked for bulk action"));
    assert_eq!(marks(&mut ed, &s), vec![marked("tasks:      10:00...... Meeting")]);
    // On the next entry's line.
    let line = ed.buffer().line_of(ed.buffer().point());
    assert!(ed.buffer().line_text(line).contains("TODO Report"), "{}", ed.buffer().line_text(line));
}

/// The mark is drawn: the line shows > where its two leading spaces were.
#[test]
fn a_marked_line_is_drawn_with_its_mark() {
    let (mut ed, _s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N m").unwrap();
    ed.redisplay();
    let rows: Vec<String> = ed.window_rows(20, true).iter().map(|r| r.segments.iter().map(|s| s.text.as_str()).collect()).collect();
    assert!(rows.iter().any(|r| r.starts_with("> tasks:      10:00...... Meeting")), "{rows:#?}");
}

/// u takes the mark away, U every mark, and M-m and M-* toggle them.
#[test]
fn marks_are_taken_away_and_toggled() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N m m p u").unwrap();
    assert_eq!(marks(&mut ed, &s), vec![marked("tasks:      10:00...... Meeting")]);
    ed.press("U").unwrap();
    assert_eq!(marks(&mut ed, &s), vec![]);
    // u left point on Pay's line, so N goes to Call Bob's, which M-m marks and M-* unmarks, marking the rest.
    ed.press("N M-m M-*").unwrap();
    let lines: Vec<String> = marks(&mut ed, &s).into_iter().map(|m| m.0).collect();
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert!(lines.iter().all(|l| !l.contains("Call Bob")), "{lines:?}");
}

/// A line written again, as t writes its entry's lines, keeps its mark,
/// as org-agenda-change-all-lines moves the overlay; a new agenda has none.
#[test]
fn a_mark_stays_on_a_line_written_again_and_goes_with_a_new_agenda() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N N m p t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(marks(&mut ed, &s), vec![marked("tasks:      Scheduled:  DONE Report                                     :work:")]);
    ed.press("g").unwrap();
    assert_eq!(marks(&mut ed, &s), vec![]);
    ed.press("N m").unwrap();
    assert_eq!(ed.echo(), Some("1 entries marked for bulk action"), "the marks start again from none");
}

/// A custom action calls its function at each marked line, with the
/// arguments its argument function gives once, then makes the agenda again.
#[test]
fn a_custom_bulk_function_is_called_at_each_marked_line() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"let asked = 0;
        e8.defun("test-bulk-tag", (tag: string) => e8.call("org-agenda-set-tags-bulk-test", tag));
        e8.defun("test-bulk-args", () => { asked++; e8.setVariable("test-asked", asked); return ["urgent"]; });
        e8.defineCommand({ name: "org-agenda-set-tags-bulk-test", params: [{ name: "tag" }], run: (tag: string) => {
          const heading = e8.lineText(e8.lineOf(e8.point()));
          e8.setVariable("test-seen", [...((e8.variable("test-seen") as string[]) ?? []), `${heading.trim().slice(0, 30)}|${tag}`]);
        } });
        e8.setVariable("org-agenda-bulk-custom-functions", [["R", "test-bulk-tag", "test-bulk-args"]]);"#
            .to_string(),
    )
    .unwrap();
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N N m m").unwrap();
    answering(&mut ed, &["R"]);
    ed.press("B").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("Acted on 2 entries"));
    assert_eq!(ed.variable("test-asked"), Some(Value::Number(1.0)));
    assert_eq!(
        ed.variable("test-seen"),
        Some(Value::List(vec![
            Value::Str("tasks:      Scheduled:  TODO R|urgent".into()),
            Value::Str("tasks:      In   2 d.:  TODO P|urgent".into()),
        ]))
    );
}

/// A character no action has is an error, after the prompt lists the custom ones.
#[test]
fn bs_prompt_lists_the_custom_actions() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    s.eval_typescript(&mut ed, "test.ts", r#"e8.setVariable("org-agenda-bulk-custom-functions", [["R", "ignore"], [67, "ignore"]]);"#.to_string()).unwrap();
    ed.call("org-agenda-list", vec![]).unwrap();
    let asked = answering(&mut ed, &["z"]);
    ed.press("N B").unwrap();
    assert_eq!(asked.borrow().len(), 1);
    assert!(asked.borrow()[0].ends_with("[f]unction     Custom: [RC]"), "{:?}", asked.borrow());
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Invalid bulk action: z".into()));
}

/// N from a line before lines a filter hides goes on to the next line shown.
#[test]
fn n_passes_over_hidden_lines() {
    let (mut ed, _s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("= P a y RET").unwrap();
    let at = |ed: &Editor| ed.buffer().point();
    ed.press("N").unwrap();
    let first = at(&ed);
    ed.press("N").unwrap();
    assert_eq!((first, at(&ed)), (219, 280));
}


