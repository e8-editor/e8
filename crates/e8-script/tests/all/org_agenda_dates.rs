//! Changing dates from the agenda: what the Emacs oracle cannot see, the
//! new date each changed line shows at its end, as org-agenda-show-new-time
//! puts it in a display property.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TASKS: &str = "* TODO Report\nSCHEDULED: <2026-10-28 Wed>\n* Meeting <2026-10-28 Wed 10:00>\n\
* Trip <2026-10-28 Wed>--<2026-10-29 Thu>\n";

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

/// Each agenda line with a display property: its text before it, and what it shows instead.
fn shown_dates(ed: &mut Editor, s: &Scripting) -> Vec<(String, String)> {
    let json = s.eval_expression(
        ed,
        r#"e8.withCurrentBuffer('*Org Agenda*', () => JSON.stringify(Array.from({ length: e8.lineCount() }, (_, l) => l).flatMap((l) => {
            for (let p = e8.lineStart(l); p < e8.lineEnd(l); p++) {
              const d = e8.getTextProperty(p, 'display');
              if (d !== undefined) return [[e8.bufferText(e8.lineStart(l), p), String(d)]];
            }
            return [];
          })))"#,
    )
    .unwrap();
    // The JSON comes back as a string, written as one.
    serde_json::from_str(&serde_json::from_str::<String>(&json).unwrap()).unwrap()
}

/// S-<right> shows the new timestamp over the line's last columns, the
/// line padded with spaces to reach them, as org-agenda-show-new-time does.
#[test]
fn the_new_date_shows_at_the_end_of_the_line() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N S-<right>").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("Time stamp changed to <2026-10-29 Thu 10:00>"));
    // 79 columns, less the 27 the stamp takes, the column before them starting it.
    let line = format!("{:<51}", "  tasks:      10:00...... Meeting ");
    let dates = shown_dates(&mut ed, &s);
    assert_eq!(dates, vec![(line, " => <2026-10-29 Thu 10:00> ".to_string())]);
}

/// Every line pointing where the changed one does shows it, as both days
/// of a range do.
#[test]
fn every_line_of_a_range_shows_its_new_dates() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N N N S-<right>").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("Time stamp changed to <2026-10-29 Thu>--<2026-10-30 Fri>"));
    let dates = shown_dates(&mut ed, &s);
    assert_eq!(dates.len(), 2, "{dates:?}");
    assert!(dates.iter().all(|(line, d)| line.contains("Trip") && d == " => <2026-10-29 Thu>--<2026-10-30 Fri> "), "{dates:?}");
}

/// C-c C-s shows what org-schedule said, after S.
#[test]
fn scheduling_shows_what_it_said() {
    let (mut ed, s, _dir) = agenda_file(TASKS);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N N C-c C-s 2 0 2 6 - 1 1 - 0 3 RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("Scheduled to <2026-11-03 Tue>"));
    let dates = shown_dates(&mut ed, &s);
    assert_eq!(dates.len(), 1, "{dates:?}");
    assert!(dates[0].0.contains("TODO Report"), "{dates:?}");
    assert_eq!(dates[0].1, " S => Scheduled to <2026-11-03 Tue> ");
}
