//! The date prompt on a timestamp, where the Emacs oracle cannot look, as
//! record.el answers prompts without their initial input.

use e8_core::Editor;
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.press("M-<").unwrap();
    (ed, s)
}

fn text(ed: &Editor) -> String {
    ed.window_buffer().slice(0..ed.window_buffer().len())
}

/// C-c . on a timestamp with a time starts the prompt with its time, or a
/// range as 10:00+1:30, as org-get-compact-tod gives it, so RET keeps it.
#[test]
fn the_prompt_starts_with_the_timestamps_time() {
    let (mut ed, _s) = org("x <2026-11-04 Wed 10:00>\n");
    ed.press("C-f C-f C-f C-c . RET").unwrap();
    assert_eq!(text(&ed), "x <2026-11-04 Wed 10:00>\n");
    let (mut ed, _s) = org("x <2026-11-04 Wed 10:00-11:30>\n");
    ed.press("C-f C-f C-f C-c . RET").unwrap();
    assert_eq!(text(&ed), "x <2026-11-04 Wed 10:00-11:30>\n");
    let (mut ed, _s) = org("x <2026-11-04 Wed 10:15-11:00>\n");
    ed.press("C-f C-f C-f C-c . RET").unwrap();
    assert_eq!(text(&ed), "x <2026-11-04 Wed 10:15-11:00>\n");
    // A day without a time starts empty.
    let (mut ed, s) = org("x <2026-11-04 Wed>\n");
    s.eval_expression(&mut ed, "e8.setVariable('e8--today', '2026-11-04')").unwrap();
    ed.press("C-f C-f C-f C-c . RET").unwrap();
    assert_eq!(text(&ed), "x <2026-11-04 Wed>\n");
}

/// C-c C-s and C-c C-d start the prompt with the entry's date's time, as
/// org-add-planning-info gives org-get-compact-tod, so RET keeps it.
#[test]
fn scheduling_starts_with_the_old_dates_time() {
    let (mut ed, _s) = org("* TODO Write\nSCHEDULED: <2026-11-05 Thu 10:00>\n");
    ed.press("C-c C-s RET").unwrap();
    assert_eq!(text(&ed), "* TODO Write\nSCHEDULED: <2026-11-05 Thu 10:00>\n");
    let (mut ed, _s) = org("* TODO Write\nDEADLINE: <2026-11-05 Thu 09:00-10:30>\n");
    ed.press("C-c C-d RET").unwrap();
    assert_eq!(text(&ed), "* TODO Write\nDEADLINE: <2026-11-05 Thu 09:00-10:30>\n");
}
