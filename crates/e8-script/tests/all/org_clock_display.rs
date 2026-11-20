//! org-clock-display: the times it shows after the headings, which the
//! Emacs oracle cannot see, and the ranges it sums, which depend on today.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    // A Friday, at noon.
    ed.set_variable("e8--today", Value::Str("2026-11-20".into()));
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap().trim_matches('"').to_string()
}

/// The display strings of the clock overlays, top to bottom.
fn shown(ed: &mut Editor, s: &Scripting) -> Vec<String> {
    let json = eval(
        ed,
        s,
        r#"JSON.stringify((e8.variable("org-clock-overlays") ?? []).map((o) => [e8.overlayStart(o), String(e8.overlayGet(o, "display"))]).sort((a, b) => a[0] - b[0]).map((x) => x[1]))"#,
    );
    serde_json::from_str::<Vec<String>>(&json.replace("\\\"", "\"").replace("\\\\", "\\")).unwrap_or_else(|_| panic!("{json}"))
}

const DOC: &str = "* Work\n** Today\nCLOCK: [2026-11-20 Fri 08:00]--[2026-11-20 Fri 09:00] =>  1:00\n** Across midnight\nCLOCK: [2026-11-19 Thu 23:00]--[2026-11-20 Fri 01:00] =>  2:00\n** This week\nCLOCK: [2026-11-17 Tue 10:00]--[2026-11-17 Tue 10:30] =>  0:30\n** This month\nCLOCK: [2026-11-05 Thu 10:00]--[2026-11-05 Thu 10:15] =>  0:15\n** This year\nCLOCK: [2026-03-02 Mon 10:00]--[2026-03-02 Mon 10:05] =>  0:05\n** Last year\nCLOCK: [2025-12-01 Mon 10:00]--[2025-12-01 Mon 12:00] =>  2:00\n";

/// Each heading with time gets it after its title, the dots in the shadow
/// face reaching column 60, as org-clock-put-overlay lays them out.
#[test]
fn times_show_after_the_titles_out_to_column_sixty() {
    let (mut ed, s) = org("* Project\n** Task A\nCLOCK: [2026-11-02 Mon 09:00]--[2026-11-02 Mon 10:30] =>  1:30\n* None\n");
    ed.press("C-u 5 C-c C-x C-d").unwrap();
    let times = shown(&mut ed, &s);
    assert_eq!(times, vec![format!("Project{}      1:30 ", "\u{b7}".repeat(60 - 2 - 7)), format!("Task A{}      1:30 ", "\u{b7}".repeat(60 - 3 - 6))]);
    // The window shows them in place of the titles and tags.
    ed.redisplay();
    let rows = ed.window_rows(20, true);
    let row: String = rows[1].segments.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(row.trim_end(), format!("** Task A{}      1:30", "\u{b7}".repeat(60 - 3 - 6)));
    // The time on org-clock-overlay's background, the dots dimmer than the title, in shadow.
    let seg = |needle: &str| rows[1].segments.iter().find(|s| s.text.contains(needle)).unwrap();
    assert!(seg("1:30").style.background.is_some() && seg("Task A").style.background.is_none(), "{:?}", rows[1]);
    assert_ne!(seg("\u{b7}").style.foreground, seg("Task A").style.foreground);
    assert_eq!(ed.echo(), Some("Total file time: 1:30 (1 hours and 30 minutes)"));
}

/// By default the sum is this year's, org-clock-display-default-range; C-u
/// gives today's, from midnight, cutting a clock that crossed it; C-u C-u
/// asks for a range.
#[test]
fn ranges_are_counted_from_today() {
    let total = |keys: &str, answer: Option<&str>, range: Option<&str>| {
        let (mut ed, _s) = org(DOC);
        if let Some(r) = range {
            ed.set_variable("org-clock-display-default-range", Value::Str(r.into()));
        }
        if let Some(a) = answer {
            let mut left = Some(a.to_string());
            ed.set_input_source(move |ed| {
                if ed.prompt().is_none() {
                    return false;
                }
                let Some(a) = left.take() else { return false };
                ed.type_text(&a);
                ed.handle_key(e8_core::Key::parse("RET").unwrap());
                true
            });
        }
        ed.press(keys).unwrap();
        ed.echo().unwrap_or_default().to_string()
    };
    assert_eq!(total("C-c C-x C-d", None, None), "Total file time: 3:50 (3 hours and 50 minutes)");
    assert_eq!(total("C-u C-c C-x C-d", None, None), "Total file time for today: 2:00 (2 hours and 0 minutes)");
    assert_eq!(total("C-u C-u C-c C-x C-d", Some("thisweek"), None), "Total file time (custom): 3:30 (3 hours and 30 minutes)");
    assert_eq!(total("C-u C-u C-c C-x C-d", Some("yesterday"), None), "Total file time (custom): 1:00 (1 hours and 0 minutes)");
    assert_eq!(total("C-u C-u C-c C-x C-d", Some("lastyear"), None), "Total file time (custom): 2:00 (2 hours and 0 minutes)");
    assert_eq!(total("C-c C-x C-d", None, Some("thismonth")), "Total file time: 3:45 (3 hours and 45 minutes)");
    assert_eq!(total("C-c C-x C-d", None, Some("untilnow")), "Total file time: 5:50 (5 hours and 50 minutes)");
}

/// The times go at the next change, as org-remove-highlights-with-change
/// asks, or with C-c C-c, which says so.
#[test]
fn the_times_go_at_a_change_or_c_c_c_c() {
    let (mut ed, s) = org(DOC);
    ed.press("C-c C-x C-d").unwrap();
    assert!(!shown(&mut ed, &s).is_empty());
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.echo(), Some("Temporary highlights/overlays removed from current buffer"));
    assert!(shown(&mut ed, &s).is_empty());
    ed.press("C-c C-x C-d").unwrap();
    let end = ed.window_buffer().len();
    ed.window_buffer_mut().set_point(end);
    ed.press("x").unwrap();
    assert!(shown(&mut ed, &s).is_empty());
}
