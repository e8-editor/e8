//! The running clock in the mode line with the entry's effort, as Org's
//! org-clock-get-clock-string shows it, which the Emacs oracle does not
//! compare.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-21".into()));
    (ed, scripting)
}

/// The mode line's clock string, and the face on its time.
fn clock_string(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(
        ed,
        r#"(() => { const m = e8.variable("org-mode-line-string") as e8.PropertizedString; const t = m.string; const at = t.indexOf("[") + 1; const face = m.properties.filter(([a, b]) => a <= at && at < b).map(([, , p]) => p.face).join(","); return `${t}|${face}`; })()"#,
    )
    .unwrap()
}

const EFFORT: &str = "* B\n:PROPERTIES:\n:Effort: 1:00\n:END:\n";

/// The effort follows the time clocked.
#[test]
fn the_effort_is_shown_after_the_time() {
    let (mut ed, s) = org(EFFORT);
    ed.press("C-c C-x C-i").unwrap();
    assert_eq!(clock_string(&mut ed, &s), r#""[0:00/1:00] (B) |org-mode-line-clock""#);
}

/// Past the effort, counting the entry's earlier clocks, the time is in
/// org-mode-line-clock-overrun, and Org says so once.
#[test]
fn past_the_effort_the_time_turns_red_and_says_so() {
    let (mut ed, s) = org("* B\n:PROPERTIES:\n:Effort: 0:30\n:END:\n:LOGBOOK:\nCLOCK: [2026-11-20 Fri 09:00]--[2026-11-20 Fri 10:00] =>  1:00\n:END:\n");
    ed.press("C-c C-x C-i").unwrap();
    assert_eq!(clock_string(&mut ed, &s), r#""[1:00/0:30] (B) |org-mode-line-clock-overrun""#);
    let log = ed.messages();
    assert!(log.iter().any(|m| m == "Task ‘B’ should be finished by now. (0:30)"), "{log:?}");
}

/// With org-clock-task-overrun-text, that text goes before the clock instead.
#[test]
fn an_overrun_text_goes_before_the_clock() {
    let (mut ed, s) = org("* B\n:PROPERTIES:\n:Effort: 0:30\n:END:\nCLOCK: [2026-11-20 Fri 09:00]--[2026-11-20 Fri 10:00] =>  1:00\n");
    ed.set_variable("org-clock-task-overrun-text", Value::Str("LATE ".into()));
    ed.press("C-c C-x C-i").unwrap();
    let text = s.eval_expression(&mut ed, r#"(e8.variable("org-mode-line-string") as e8.PropertizedString).string"#).unwrap();
    assert_eq!(text, r#""LATE [1:00/0:30] (B) ""#);
}

/// org-clock-string-limit cuts the clock string.
#[test]
fn the_clock_string_is_cut_to_its_limit() {
    let (mut ed, s) = org(EFFORT);
    ed.set_variable("org-clock-string-limit", Value::Number(8.0));
    ed.press("C-c C-x C-i").unwrap();
    let text = s.eval_expression(&mut ed, r#"(e8.variable("org-mode-line-string") as e8.PropertizedString).string"#).unwrap();
    assert_eq!(text, r#""[0:00/1:""#);
}

/// Setting the clocked entry's effort shows in the mode line at once.
#[test]
fn setting_the_effort_changes_the_mode_line() {
    let (mut ed, s) = org(EFFORT);
    ed.press("C-c C-x C-i").unwrap();
    ed.press("C-c C-x e 2 : 3 0 RET").unwrap();
    assert_eq!(clock_string(&mut ed, &s), r#""[0:00/2:30] (B) |org-mode-line-clock""#);
}

/// A notification handler gets the notice instead of the echo area.
#[test]
fn a_notification_handler_gets_the_notice() {
    let (mut ed, s) = org("* B\n:PROPERTIES:\n:Effort: 0:30\n:END:\nCLOCK: [2026-11-20 Fri 09:00]--[2026-11-20 Fri 10:00] =>  1:00\n");
    s.eval_typescript(&mut ed, "test.ts", r#"(globalThis as any).told = []; e8.setVariable("org-show-notification-handler", (n: string) => (globalThis as any).told.push(n));"#.to_string()).unwrap();
    ed.press("C-c C-x C-i").unwrap();
    assert_eq!(s.eval_expression(&mut ed, "(globalThis as any).told.join()").unwrap(), r#""Task ‘B’ should be finished by now. (0:30)""#);
}

/// Clocking in while another clock runs counts the new entry's own time,
/// though stopping the other clock wrote before it.
#[test]
fn the_next_entry_counts_its_own_time() {
    let (mut ed, s) = org("* A\n* B\n:PROPERTIES:\n:CLOCK_MODELINE_TOTAL: all\n:END:\n:LOGBOOK:\nCLOCK: [2026-11-20 Fri 09:00]--[2026-11-20 Fri 10:00] =>  1:00\n:END:\n");
    ed.press("C-c C-x C-i C-c C-n C-c C-x C-i").unwrap();
    let text = s.eval_expression(&mut ed, r#"(e8.variable("org-mode-line-string") as e8.PropertizedString).string"#).unwrap();
    assert_eq!(text, r#""[1:00] (B) ""#);
}
