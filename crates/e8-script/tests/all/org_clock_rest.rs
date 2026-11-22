//! The clock's odds the Emacs oracle does not record: clocking in from the
//! last clock-out on another day, a state switched to, notifications run
//! as a program, and *Clock Task Select*'s links.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.org");
    std::fs::write(&file, text).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-04".into()));
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    (ed, s, dir)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// C-u C-u C-u C-c C-x C-i starts from when the clock was last stopped,
/// and C-u C-u C-c C-x C-x clocks in on the last task from then too.
#[test]
fn from_the_last_clock_out() {
    let (mut ed, _s, _dir) = org("* One\n* Two\n");
    ed.press("C-c C-x C-i C-c C-x C-o").unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-05".into()));
    ed.press("M-> C-p C-u C-u C-u C-c C-x C-i").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).contains("* Two\n:LOGBOOK:\nCLOCK: [2026-11-04 Wed 12:00]\n"), "{}", text(&ed));
    ed.press("C-c C-x C-o").unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-06".into()));
    ed.press("C-u C-u C-c C-x C-x").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).contains("CLOCK: [2026-11-05 Thu 12:00]\nCLOCK: [2026-11-04"), "{}", text(&ed));
}

/// With nothing clocked yet, there is no last clock to go back to.
#[test]
fn no_last_clock() {
    let (mut ed, _s, _dir) = org("* One\n");
    ed.press("C-c C-x C-x").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("No last clock"));
}

/// C-u C-u C-u C-c C-x C-x asks a state to switch the task to; and
/// org-clock-in-switch-to-state switches a task clocked in.
#[test]
fn a_state_to_switch_to() {
    let (mut ed, _s, _dir) = org("* TODO One\n");
    ed.press("C-c C-x C-i C-c C-x C-o C-u C-u C-u C-c C-x C-x D O N E RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).starts_with("* DONE One\n"), "{}", text(&ed));
    let (mut ed, _s, _dir) = org("* TODO Two\n");
    ed.set_variable("org-clock-in-switch-to-state", Value::Str("NEXT".into()));
    ed.set_variable("org-todo-keywords", Value::List(vec![Value::List(vec![Value::Str("sequence".into()), Value::Str("TODO".into()), Value::Str("NEXT".into()), Value::Str("|".into()), Value::Str("DONE".into())])]));
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-c C-x C-i").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).starts_with("* NEXT Two\n"), "{}", text(&ed));
}

/// A handler that is a program is run with the notification.
#[test]
fn a_notification_program() {
    let (mut ed, s, dir) = org("* One\n");
    let script = dir.path().join("notify.sh");
    let out = dir.path().join("out.txt");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s' \"$1\" > {}\n", out.display())).unwrap();
    std::process::Command::new("chmod").arg("+x").arg(&script).status().unwrap();
    ed.set_variable("org-show-notification-handler", Value::Str(script.to_str().unwrap().into()));
    s.eval_typescript(&mut ed, "t.ts", r#"e8.funcall("org-notify", "Time is up");"#.to_string()).unwrap();
    for _ in 0..100 {
        if std::fs::read_to_string(&out).map(|t| t == "Time is up").unwrap_or(false) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        ed.accept_process_output(std::time::Duration::from_millis(50));
    }
    panic!("the program was not run: {:?}", std::fs::read_to_string(&out));
}

/// *Clock Task Select* shows a task's links as Org fontifies them: the
/// markup there but invisible.
#[test]
fn task_links_as_shown() {
    let (mut ed, s, _dir) = org("* See [[https://x.org][the site]] now\n");
    s.eval_typescript(
        &mut ed,
        "t.ts",
        r#"e8.addHook("org-clock-before-select-task-hook", () => {
          const at = e8.search("[[https", { from: e8.pointMin() });
          globalThis.seen = [e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()), at && e8.getTextProperty(at.start, "invisible")];
        });"#
            .to_string(),
    )
    .unwrap();
    ed.press("C-c C-x C-i C-c C-x C-o C-u C-c C-x C-i q").unwrap();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.message(JSON.stringify(globalThis.seen));"#.to_string()).unwrap();
    let echo = ed.echo().unwrap_or_default().to_string();
    assert!(echo.contains("See [[https://x.org][the site]] now") && echo.ends_with("true]"), "{echo}");
}
