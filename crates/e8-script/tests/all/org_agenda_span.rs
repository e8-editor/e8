//! The agenda's spans: what the Emacs oracle cannot see, a numeric prefix
//! argument to org-agenda-list, org-agenda-show-all-dates, the mode name,
//! and the span commands in other views.

use e8_core::{Editor, PrefixArg, Value};
use e8_script::Scripting;

/// Visits `tasks.org`, holding `text`, as the one agenda file, with today fixed.
fn agenda_file(text: &str, globals: &[(&str, Value)]) -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, text).unwrap();
    for (name, value) in globals {
        ed.set_default(name, value.clone());
    }
    ed.call("find-file", vec![e8_core::Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 40);
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    (ed, scripting, dir)
}

fn agenda(ed: &Editor) -> String {
    ed.buffers().iter().find(|b| b.name == "*Org Agenda*").map(|b| b.slice(0..b.len())).unwrap()
}

fn mode_name(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(ed, "e8.withCurrentBuffer('*Org Agenda*', () => e8.variable('mode-name'))").unwrap().trim_matches('"').to_string()
}

const TASKS: &str = "* TODO Write report\nSCHEDULED: <2026-10-28 Wed>\n* Trip <2026-11-03 Tue>\n";

/// A numeric prefix argument is the number of days, from today, as
/// org-agenda-list takes it; 7 of them are a week, from Monday.
#[test]
fn a_numeric_prefix_argument_is_the_span() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[]);
    ed.call_with_prefix("org-agenda-list", vec![], Some(PrefixArg::Number(3))).unwrap();
    assert_eq!(
        agenda(&ed),
        "3 days-agenda (W44):\nWednesday  28 October 2026\n  tasks:      Scheduled:  TODO Write report\nThursday   29 October 2026\nFriday     30 October 2026\n"
    );
    ed.call_with_prefix("org-agenda-list", vec![], Some(PrefixArg::Number(7))).unwrap();
    assert!(agenda(&ed).starts_with("Week-agenda (W44):\nMonday     26 October 2026 W44\n"), "{}", agenda(&ed));
    // C-u is no number of days.
    ed.call_with_prefix("org-agenda-list", vec![], Some(PrefixArg::Universal(4))).unwrap();
    assert!(agenda(&ed).starts_with("Week-agenda (W44):\n"), "{}", agenda(&ed));
}

/// With org-agenda-show-all-dates off, only the days with entries are shown.
#[test]
fn only_days_with_entries_without_show_all_dates() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[("org-agenda-show-all-dates", Value::Null), ("org-agenda-span", Value::Str("fortnight".into()))]);
    ed.call("org-agenda-list", vec![]).unwrap();
    assert_eq!(
        agenda(&ed),
        "Fortnight-agenda (W44-W45):\nWednesday  28 October 2026\n  tasks:      Scheduled:  TODO Write report\nTuesday     3 November 2026\n  tasks:      Trip \n"
    );
    // f goes on from point's day, the trip's, and with no day to show, to the start.
    ed.press("C-n C-n C-n f").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(agenda(&ed), "Fortnight-agenda (W47-W48):\n");
    assert_eq!(ed.buffer().point(), 0);
}

/// The mode name gives the span, as org-agenda-set-mode-name has it.
#[test]
fn the_mode_name_gives_the_span() {
    let (mut ed, s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda Week Ddl Grid Habit");
    ed.press("d").unwrap();
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda Day Ddl Grid Habit");
    ed.call_with_prefix("org-agenda-list", vec![], Some(PrefixArg::Number(10))).unwrap();
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda 10 days Ddl Grid Habit");
}

/// The span commands work in a day agenda only, as org-agenda-check-type
/// says, and a view's prefix argument must be a number.
#[test]
fn span_commands_need_a_day_agenda_and_a_number() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-todo-list", vec![]).unwrap();
    for key in ["f", "b", ".", "d", "w"] {
        ed.press(key).unwrap();
        assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Not allowed in \u{2019}todo\u{2019}-type agenda buffer or component"), "{key}");
    }
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("C-u d").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Wrong type argument: number-or-marker-p, (4)"));
    assert!(agenda(&ed).starts_with("Week-agenda (W44):\n"));
}

/// The agenda's w is the week view, as Org binds it, and refiling is C-c C-w.
#[test]
fn w_is_the_week_view_and_c_c_c_w_refiles() {
    let (mut ed, s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    let binding = |ed: &mut Editor, key: &str| {
        s.eval_expression(ed, &format!("e8.lookupKey('org-agenda-mode-map', '{key}')")).unwrap().trim_matches('"').to_string()
    };
    assert_eq!(binding(&mut ed, "w"), "org-agenda-week-view");
    assert_eq!(binding(&mut ed, "C-c C-w"), "org-agenda-refile");
}

/// org-agenda's a takes its prefix argument to org-agenda-list.
#[test]
fn the_dispatchers_a_hands_on_the_prefix_argument() {
    let (mut ed, s, _dir) = agenda_file(TASKS, &[]);
    s.eval_expression(&mut ed, "e8.unreadKeys('a')").unwrap();
    ed.call_with_prefix("org-agenda", vec![], Some(PrefixArg::Number(2))).unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(agenda(&ed).starts_with("2 days-agenda (W44):\nWednesday  28 October 2026\n"), "{}", agenda(&ed));
}

/// org-agenda-start-day is read as org-read-date reads it, relative to
/// today, and kept as the day it read: f goes on from it and . back to today.
#[test]
fn start_day_is_read_relative_to_today() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[("org-agenda-start-day", Value::Str("+2d".into())), ("org-agenda-span", Value::Str("day".into()))]);
    ed.call("org-agenda-list", vec![]).unwrap();
    assert_eq!(agenda(&ed), "Day-agenda (W44):\nFriday     30 October 2026\n");
    ed.press("f").unwrap();
    assert_eq!(agenda(&ed), "Day-agenda (W44):\nSaturday   31 October 2026\n");
    ed.press(".").unwrap();
    assert!(agenda(&ed).starts_with("Day-agenda (W44):\nWednesday  28 October 2026\n"), "{}", agenda(&ed));
}

/// j reads its date as org-read-date does, relative to today and preferring
/// the future, and shows the span from it, with point on the date.
#[test]
fn goto_date_reads_relative_dates() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.call("org-agenda-goto-date", vec![e8_core::Arg::Str("+9d".into())]).unwrap();
    assert!(agenda(&ed).starts_with("Week-agenda (W45):\nMonday      2 November 2026 W45\n"), "{}", agenda(&ed));
    let text = agenda(&ed);
    let at = text.find("Friday      6 November").unwrap();
    assert_eq!(ed.buffer().point(), text[..at].chars().count());
    // A day of the month before today's is next month's.
    ed.call("org-agenda-goto-date", vec![e8_core::Arg::Str("5".into())]).unwrap();
    assert!(agenda(&ed).starts_with("Week-agenda (W45):\n"), "{}", agenda(&ed));
}
