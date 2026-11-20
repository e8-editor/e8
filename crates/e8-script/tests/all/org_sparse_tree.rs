//! Org's sparse trees: what the Emacs oracle cannot see, their highlights
//! and how they go, and the matches that depend on today's date.

use e8_core::{Editor, Value};
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

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap().trim_matches('"').to_string()
}

fn find(ed: &Editor, needle: &str) -> usize {
    let b = ed.window_buffer();
    let t = b.slice(0..b.len());
    let i = t.find(needle).unwrap_or_else(|| panic!("no {needle:?} in {t:?}"));
    t[..i].chars().count()
}

/// Whether the text at the start of `needle` shows.
fn shows(ed: &mut Editor, s: &Scripting, needle: &str) -> bool {
    let at = find(ed, needle);
    eval(ed, s, &format!("String(!e8.invisibleAt({at}))")) == "true"
}

/// Where the sparse tree's highlights are, as [start, end] pairs from the buffer's start.
fn highlights(ed: &mut Editor, s: &Scripting) -> String {
    eval(
        ed,
        s,
        r#"JSON.stringify(e8.overlaysIn(0, e8.bufferSize()).filter((o) => e8.overlayGet(o, "face") === "secondary-selection").map((o) => [e8.overlayStart(o), e8.overlayEnd(o)]).sort((a, b) => a[0] - b[0]))"#,
    )
}

/// Types `keys`, answering the prompts they open with `answers` in turn, each typed and confirmed with RET.
fn press_answering(ed: &mut Editor, keys: &str, answers: &[&str]) {
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        if ed.prompt().is_none() {
            return false;
        }
        let Some(answer) = left.pop_front() else { return false };
        ed.type_text(&answer);
        ed.handle_key(e8_core::Key::parse("RET").unwrap());
        true
    });
    ed.press(keys).unwrap();
}

const DOC: &str = "* Fruit\napple here\n* Other\nnothing\n** Deeper\nan apple\n";

/// Each match is highlighted in secondary-selection, and C-c C-c takes
/// the highlights away, saying so, as org-ctrl-c-ctrl-c does first.
#[test]
fn matches_are_highlighted_until_c_c_c_c() {
    let (mut ed, s) = org(DOC);
    press_answering(&mut ed, "C-c / r", &["apple"]);
    assert_eq!(ed.echo(), Some("2 match(es) for regexp apple"));
    let (a, b) = (find(&ed, "apple here"), find(&ed, "apple\n"));
    assert_eq!(highlights(&mut ed, &s), format!("\\[[{a},{}],[{b},{}]]", a + 5, b + 5).replace("\\", ""));
    assert!(shows(&mut ed, &s, "apple here") && shows(&mut ed, &s, "an apple") && !shows(&mut ed, &s, "nothing"));
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.echo(), Some("Temporary highlights/overlays removed from current buffer"));
    assert_eq!(highlights(&mut ed, &s), "[]");
    // The tree stays as it was.
    assert!(!shows(&mut ed, &s, "nothing"));
}

/// The first change to the buffer takes an org-occur tree's highlights
/// away, as org-remove-highlights-with-change asks, but not a tags tree's,
/// which org-scan-tags leaves until C-c C-c.
#[test]
fn a_change_takes_regexp_highlights_away_but_not_tag_ones() {
    let (mut ed, s) = org(DOC);
    press_answering(&mut ed, "C-c / r", &["apple"]);
    assert_ne!(highlights(&mut ed, &s), "[]");
    ed.press("x").unwrap();
    assert_eq!(highlights(&mut ed, &s), "[]");

    let (mut ed, s) = org("* A :work:\n** B\n* C\n");
    press_answering(&mut ed, "C-c \\", &["work"]);
    // The stars of each heading matched, as org-scan-tags highlights them.
    assert_eq!(highlights(&mut ed, &s), "[[0,1],[11,13]]");
    let end = ed.window_buffer().len();
    ed.window_buffer_mut().set_point(end);
    ed.press("x").unwrap();
    assert_eq!(highlights(&mut ed, &s), "[[0,1],[11,13]]");

    let (mut ed, s) = org(DOC);
    ed.set_variable("org-remove-highlights-with-change", Value::Bool(false));
    press_answering(&mut ed, "C-c / r", &["apple"]);
    ed.press("x").unwrap();
    assert_ne!(highlights(&mut ed, &s), "[]");
}

/// With org-highlight-sparse-tree-matches off, nothing is highlighted and
/// C-c C-c does what it would anyway.
#[test]
fn highlighting_can_be_turned_off() {
    let (mut ed, s) = org(DOC);
    ed.set_variable("org-highlight-sparse-tree-matches", Value::Bool(false));
    press_answering(&mut ed, "C-c / r", &["apple"]);
    assert_eq!(highlights(&mut ed, &s), "[]");
    assert!(!shows(&mut ed, &s, "nothing"));
}

/// Times in a match are compared with today: <today>, <tomorrow>, <+3d>.
#[test]
fn matches_compare_times_with_today() {
    let doc = "* Past\nSCHEDULED: <2026-11-18 Wed>\n* Today\nSCHEDULED: <2026-11-20 Fri>\n* Soon\nSCHEDULED: <2026-11-22 Sun>\n* Later\nSCHEDULED: <2026-12-24 Thu>\n";
    // The headings a match picks, by the highlights on their stars.
    let matched = |m: &str| {
        let (mut ed, s) = org(doc);
        press_answering(&mut ed, "C-c \\", &[m]);
        let marks = highlights(&mut ed, &s);
        ["Past", "Today", "Soon", "Later"]
            .into_iter()
            .filter(|h| marks.contains(&format!("[{},", find(&ed, &format!("* {h}")))))
            .collect::<Vec<_>>()
    };
    assert_eq!(matched(r#"SCHEDULED<"<today>""#), ["Past"]);
    assert_eq!(matched(r#"SCHEDULED="<today>""#), ["Today"]);
    assert_eq!(matched(r#"SCHEDULED>"<tomorrow>""#), ["Soon", "Later"]);
    assert_eq!(matched(r#"SCHEDULED<="<+2d>""#), ["Past", "Today", "Soon"]);
    assert_eq!(matched(r#"SCHEDULED>="<-1w>""#), ["Past", "Today", "Soon", "Later"]);
}

/// org-check-deadlines counts days from today: within
/// org-deadline-warning-days by default, a number's days with one, and
/// all of them with C-u; past ones too, but not in entries done.
#[test]
fn deadlines_are_counted_from_today() {
    let doc = "* TODO Overdue\nDEADLINE: <2026-11-10 Tue>\n* TODO Soon\nDEADLINE: <2026-11-25 Wed>\n* TODO Far\nDEADLINE: <2027-03-01 Mon>\n* DONE Finished\nDEADLINE: <2026-11-19 Thu>\n";
    let shown = |keys: &str| {
        let (mut ed, s) = org(doc);
        ed.press(keys).unwrap();
        let echo = ed.echo().unwrap_or_default().to_string();
        let which = ["2026-11-10", "2026-11-25", "2027-03-01", "2026-11-19"].iter().map(|d| shows(&mut ed, &s, &format!("DEADLINE: <{d}"))).collect::<Vec<_>>();
        (echo, which)
    };
    assert_eq!(shown("C-c / d"), ("2 deadlines past-due or due within 14 days".into(), vec![true, true, false, false]));
    assert_eq!(shown("C-u 3 C-c / d"), ("1 deadlines past-due or due within 3 days".into(), vec![true, false, false, false]));
    assert_eq!(shown("C-u C-c / d"), ("3 deadlines past-due or due within 100000 days".into(), vec![true, true, true, false]));
}

/// A regexp matching nothing but where it starts, as ^ does, finds each
/// line once, the empty one at the end too, rather than its first for
/// ever, as Org's search would.
#[test]
fn an_empty_match_moves_on() {
    let (mut ed, _s) = org("* A\nb\n* C\n");
    press_answering(&mut ed, "C-c / r", &["^"]);
    assert_eq!(ed.echo(), Some("4 match(es) for regexp ^"));
}

/// M-g n and M-g p go between the matches, as org-occur-next-match does
/// as Org's next-error-function, saying when there are no more.
#[test]
fn next_error_goes_between_matches() {
    let (mut ed, _s) = org(DOC);
    press_answering(&mut ed, "C-c / r", &["apple"]);
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "apple here"));
    ed.press("M-g n").unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "apple\n"));
    ed.press("M-g n").unwrap();
    assert_eq!(ed.echo(), Some("No more matches"));
    assert_eq!(ed.window_buffer().point(), find(&ed, "apple\n"));
    ed.press("M-g p").unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "apple here"));
}
