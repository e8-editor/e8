//! Org's date prompt on answers that count from today, which the Emacs
//! oracle cannot compare, as batch Emacs reads them against its own clock:
//! here today is fixed, Tuesday 24 November 2026 at noon.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org_buffer() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-24".into()));
    (ed, s)
}

/// The timestamp `C-c .` inserts for an answer, given as the prompt gives it, with a space after.
fn stamp(ed: &mut Editor, s: &Scripting, answer: &str) -> String {
    let code = format!(r#"(e8.deleteRegion(e8.pointMin(), e8.pointMax()), e8.call("org-timestamp", {:?}), e8.bufferText(e8.pointMin(), e8.pointMax()))"#, format!("{answer} "));
    s.eval_expression(ed, &code).unwrap().trim_matches('"').to_string()
}

#[test]
fn answers_count_from_today() {
    let (mut ed, s) = org_buffer();
    for (answer, want) in [
        ("", "<2026-11-24 Tue>"),
        (".", "<2026-11-24 Tue>"),
        ("+3", "<2026-11-27 Fri>"),
        ("-2w", "<2026-11-10 Tue>"),
        ("+1m", "<2026-12-24 Thu>"),
        ("+1y", "<2027-11-24 Wed>"),
        ("+3h", "<2026-11-24 Tue 15:00>"),
        ("fri", "<2026-11-27 Fri>"),
        ("-fri", "<2026-11-20 Fri>"),
        ("tue", "<2026-12-01 Tue>"),
        ("+2fri", "<2026-12-04 Fri>"),
        ("10:00", "<2026-11-24 Tue 10:00>"),
    ] {
        assert_eq!(stamp(&mut ed, &s, answer), want, "{answer}");
    }
}

/// With org-read-date-prefer-future, as it is by default, a date without
/// its month or year is the next one to come.
#[test]
fn dates_without_a_year_are_the_next_to_come() {
    let (mut ed, s) = org_buffer();
    for (answer, want) in [
        ("15", "<2026-12-15 Tue>"),
        ("30", "<2026-11-30 Mon>"),
        ("24", "<2026-11-24 Tue>"),
        ("3-1", "<2027-03-01 Mon>"),
        ("12-25", "<2026-12-25 Fri>"),
        ("nov 20", "<2027-11-20 Sat>"),
        ("dec 1", "<2026-12-01 Tue>"),
        ("20.11.", "<2027-11-20 Sat>"),
        ("11/30", "<2026-11-30 Mon>"),
        ("w2", "<2026-01-05 Mon>"),
        ("1/5/99", "<1999-01-05 Tue>"),
    ] {
        assert_eq!(stamp(&mut ed, &s, answer), want, "{answer}");
    }
    // Without it, the month and year are the default's, today's.
    ed.set_variable("org-read-date-prefer-future", Value::Null);
    assert_eq!(stamp(&mut ed, &s, "15"), "<2026-11-15 Sun>");
    assert_eq!(stamp(&mut ed, &s, "3-1"), "<2026-03-01 Sun>");
    // With time, a time earlier today is tomorrow's.
    ed.set_variable("org-read-date-prefer-future", Value::Symbol("time".into()));
    assert_eq!(stamp(&mut ed, &s, "10:00"), "<2026-11-25 Wed 10:00>");
    assert_eq!(stamp(&mut ed, &s, "13:00"), "<2026-11-24 Tue 13:00>");
}

/// A year outside 1970 to 2037 is brought into it, and said so.
#[test]
fn years_are_forced_into_range() {
    let (mut ed, s) = org_buffer();
    assert_eq!(stamp(&mut ed, &s, "1/5/50"), "<2037-01-05 Mon>");
    assert_eq!(ed.echo(), Some("Year was forced into compatible range (1970-2037)"));
}

/// `C-u C-u C-c .` inserts the time now, without asking.
#[test]
fn two_prefix_arguments_insert_now() {
    let (mut ed, _s) = org_buffer();
    ed.press("C-u C-u C-c .").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "<2026-11-24 Tue 12:00>");
}
