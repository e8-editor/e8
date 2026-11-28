//! Org's timer where the Emacs oracle cannot follow it: shifting the times
//! in a region, whose prompt batch Emacs reads from the terminal, the mode
//! line and frame title as the timer runs, a countdown running out, and
//! setting one from the agenda. Each expected result is what Emacs 30.2's
//! org-timer.el gives on the same text.

use std::time::Duration;

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

fn eval(ed: &mut Editor, s: &Scripting, expression: &str) -> String {
    s.eval_expression(ed, expression).unwrap()
}

fn run(ed: &mut Editor, s: &Scripting, code: &str) {
    s.eval_typescript(ed, "test.ts", code.to_string()).unwrap();
}

/// Shifts every timer stamp in the buffer by DELTA, as C-u C-u C-c C-x . does with the region.
fn change(text: &str, delta: &str) -> Result<String, String> {
    let (mut ed, _s) = org(text);
    let end = ed.window_buffer().len() as i64;
    ed.call("org-timer-change-times-in-region", vec![Arg::Int(0), Arg::Int(end), Arg::Str(delta.into())]).map_err(|e| e.to_string())?;
    let b = ed.window_buffer();
    Ok(b.slice(0..b.len()))
}

#[test]
fn shifting_makes_the_first_time_zero_by_default() {
    assert_eq!(change("- 0:01:05 :: a\n- 0:02:10 :: b\n", "").unwrap(), "- 0:00:00 :: a\n- 0:01:05 :: b\n");
}

#[test]
fn shifting_by_a_difference_fills_it_in() {
    assert_eq!(change("- 0:01:05 :: a\n- 0:59:58 :: b\n", "10").unwrap(), "- 0:01:15 :: a\n- 1:00:08 :: b\n");
    assert_eq!(change("- 0:01:05 :: a\n- 1:00:00 :: b\n", "-1:30").unwrap(), "- -0:00:25 :: a\n- 0:58:30 :: b\n");
}

#[test]
fn shifting_by_nothing_is_an_error() {
    assert_eq!(change("- 0:00:00 :: a\n- 0:00:10 :: b\n", "").unwrap_err(), "No change");
}

/// Searching back, a stamp is found from its last digits first, as
/// re-search-backward finds the match that starts latest: Emacs's own
/// results, odd as they are.
#[test]
fn shifting_finds_stamps_backwards_as_emacs_does() {
    assert_eq!(change("- -0:00:05 :: a\n- 0:00:10 :: b\n", "").unwrap(), "- -0:00:10 :: a\n- 0:00:15 :: b\n");
    assert_eq!(change("at 10:00:00 and 0:00:30\n", "-0:00:01").unwrap(), "at 1-0:00:01 and 0:00:29\n");
}

#[test]
fn times_are_read_and_written_as_org_does() {
    let (mut ed, s) = org("");
    let fixed = eval(&mut ed, &s, r#"["5", "1:30", "-5", "2:3:4", "x12y"].map((t) => e8.funcall("org-timer-fix-incomplete", t)).join(",")"#);
    assert_eq!(fixed, r#""0:00:05,0:01:30,-0:00:05,2:03:04,x0:00:12y""#);
    let secs = eval(&mut ed, &s, r#"["0:01:05", "-1:00:00", "+0:00:07", "junk"].map((t) => e8.funcall("org-timer-hms-to-secs", t)).join(",")"#);
    assert_eq!(secs, r#""65,-3600,7,0""#);
    let hms = eval(&mut ed, &s, r#"[0, 65, 3725, -90, 360000].map((n) => e8.funcall("org-timer-secs-to-hms", n)).join(",")"#);
    assert_eq!(hms, r#""0:00:00,0:01:05,1:02:05,-0:01:30,100:00:00""#);
}

/// The mode line shows the timer from the start, and again each second.
#[test]
fn the_mode_line_shows_the_timer_as_it_runs() {
    let (mut ed, s) = org("");
    ed.press("C-u 6 5 C-c C-x 0").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("org-timer-mode-line-string")"#), r#"" <0:01:05>""#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("global-mode-string") as e8.Value[]).map((v) => (typeof v === "symbol" ? e8.symbolName(v) : v)))"#), r#""[\"\",\"org-timer-mode-line-string\"]""#);
    run(&mut ed, &s, r#"e8.setVariable("org-timer-start-time", e8.currentTime() - 3725);"#);
    ed.advance_clock(Duration::from_millis(1100));
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("org-timer-mode-line-string")"#), r#"" <1:02:05>""#);
    // Paused, it is left as it was.
    ed.press("C-c C-x ,").unwrap();
    run(&mut ed, &s, r#"e8.setVariable("org-timer-start-time", e8.currentTime() - 7);"#);
    ed.advance_clock(Duration::from_millis(1100));
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("org-timer-mode-line-string")"#), r#"" <1:02:05>""#);
    ed.press("C-c C-x _").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("global-mode-string") as e8.Value[]).map((v) => (typeof v === "symbol" ? e8.symbolName(v) : v)))"#), r#""[\"\"]""#);
}

/// With org-timer-display both, the frame title shows it too, and loses it when the timer stops.
#[test]
fn the_frame_title_can_show_the_timer() {
    let (mut ed, s) = org("");
    ed.set_variable("org-timer-display", Value::Symbol("both".into()));
    ed.set_variable("frame-title-format", Value::List(vec![Value::Str("%b".into())]));
    ed.press("C-u 6 5 C-c C-x 0").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("frame-title-format") as e8.Value[]).map((v) => (typeof v === "symbol" ? e8.symbolName(v) : v)))"#), r#""[\"%b\",\"org-timer-mode-line-string\"]""#);
    ed.press("C-c C-x _").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("frame-title-format") as e8.Value[]).map((v) => (typeof v === "symbol" ? e8.symbolName(v) : v)))"#), r#""[\"%b\"]""#);
}

/// A countdown that runs out says so with its entry's heading, runs the
/// done hook and leaves the mode line.
#[test]
fn a_countdown_runs_out() {
    let (mut ed, s) = org("intro\n* TODO [#A] Task :tag:\nbody");
    run(
        &mut ed,
        &s,
        r#"(globalThis as any).told = []; e8.setVariable("org-show-notification-handler", (n: string) => (globalThis as any).told.push(n));
           e8.addHook("org-timer-done-hook", () => (globalThis as any).told.push("done"));"#,
    );
    ed.press("C-n C-u 1 C-c C-x ;").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("org-timer-countdown-timer-title")"#), r#""TODO [#A] Task :tag:""#);
    ed.advance_clock(Duration::from_secs(30));
    assert_eq!(eval(&mut ed, &s, r#"(globalThis as any).told.length"#), "0");
    ed.advance_clock(Duration::from_secs(31));
    assert_eq!(eval(&mut ed, &s, r#"(globalThis as any).told.join("|")"#), r#""TODO [#A] Task :tag:: time out|done""#);
    assert_eq!(eval(&mut ed, &s, r#"String(e8.variable("org-timer-start-time"))"#), r#""null""#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("global-mode-string") as e8.Value[]).map((v) => (typeof v === "symbol" ? e8.symbolName(v) : v)))"#), r#""[\"\"]""#);
}

/// Before the first heading a countdown has no title, as org-get-heading fails there.
#[test]
fn a_countdown_before_any_heading_has_no_title() {
    let (mut ed, s) = org("intro\n* Task\n");
    ed.press("C-u 5 C-c C-x ;").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"String(e8.variable("org-timer-countdown-timer-title"))"#), r#""null""#);
}

#[test]
fn the_time_left_is_said() {
    let (mut ed, s) = org("* Task\n");
    ed.press("C-u 5 C-c C-x ;").unwrap();
    run(&mut ed, &s, r#"e8.setVariable("org-timer-start-time", e8.currentTime() + 125.5);"#);
    ed.call("org-timer-show-remaining-time", vec![]).unwrap();
    assert_eq!(ed.messages().last().unwrap(), "2 minute(s) 5 seconds left before next time out");
    run(&mut ed, &s, r#"e8.setVariable("org-timer-start-time", e8.currentTime() + 3725.5);"#);
    ed.call("org-timer-show-remaining-time", vec![]).unwrap();
    assert_eq!(ed.messages().last().unwrap(), "62 minute(s) 5 seconds left before next time out");
}

/// Each hook runs once, in the order of the commands.
#[test]
fn the_hooks_run() {
    let (mut ed, s) = org("");
    run(
        &mut ed,
        &s,
        r#"(globalThis as any).ran = [];
           for (const h of ["start", "stop", "pause", "continue", "set"]) e8.addHook(`org-timer-${h}-hook`, () => (globalThis as any).ran.push(h));"#,
    );
    ed.press("C-c C-x . C-c C-x , C-c C-x , C-c C-x _ C-u 5 C-c C-x ; C-c C-x _").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"(globalThis as any).ran.join(",")"#), r#""start,pause,continue,stop,set,stop""#);
}

/// From the agenda, ; takes the line's effort and its entry's heading.
#[test]
fn the_agenda_sets_a_countdown_from_its_line() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, "* TODO Fix sink :home:\nSCHEDULED: <2026-10-28 Wed>\n:PROPERTIES:\n:Effort: 0:30\n:END:\n").unwrap();
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    ed.set_default("org-agenda-use-time-grid", Value::Null);
    ed.call("org-agenda-list", vec![]).unwrap();
    run(&mut ed, &s, r#"e8.gotoChar(e8.pointMin()); e8.reSearchForward("Fix sink");"#);
    ed.press(";").unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("org-timer-countdown-timer-title")"#), r#""TODO Fix sink :home:""#);
    assert_eq!(eval(&mut ed, &s, r#"Math.round((e8.variable("org-timer-start-time") as number) - e8.currentTime())"#), "1800");
    ed.press("C-c C-x _").unwrap();
    assert_eq!(ed.messages().last().unwrap(), "Timer stopped");
}
