//! Who runs E8 and on what, as Emacs's editfns.c and emacs.c answer it
//! (ADR 0073), checked against what the system's own `id` says, and
//! suspending, as suspend-emacs and suspend-frame do.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

/// What `id` says with an option, as JSON text.
fn id(option: &str) -> String {
    let out = std::process::Command::new("id").arg(option).output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

#[test]
fn users_and_groups_as_the_system_has_them() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "e8.userUid()"), id("-u"));
    assert_eq!(eval(&mut ed, &s, "e8.userRealUid()"), id("-ru"));
    assert_eq!(eval(&mut ed, &s, "e8.groupGid()"), id("-g"));
    assert_eq!(eval(&mut ed, &s, "e8.groupRealGid()"), id("-rg"));
    assert_eq!(eval(&mut ed, &s, "e8.userLoginName(e8.userUid())"), format!("{:?}", id("-un")));
    assert_eq!(eval(&mut ed, &s, "e8.userRealLoginName()"), format!("{:?}", id("-run")));
    assert_eq!(eval(&mut ed, &s, "e8.groupName(e8.groupGid())"), format!("{:?}", id("-gn")));
    // Ids no account or group has, as Emacs: nil.
    assert_eq!(eval(&mut ed, &s, "[e8.userLoginName(999999) ?? null, e8.userFullName(999999) ?? null, e8.groupName(999999) ?? null]"), "[null,null,null]");
    // The full name by id and by login name agree, and the variables are set.
    assert_eq!(eval(&mut ed, &s, "e8.userFullName(e8.userUid()) === e8.userFullName(e8.userLoginName(e8.userUid()))"), "true");
    assert_eq!(eval(&mut ed, &s, r#"[typeof e8.userFullName(), e8.userLoginName() === e8.variable("user-login-name"), e8.variable("user-real-login-name") === e8.userRealLoginName()]"#), r#"["string",true,true]"#);
    assert_eq!(eval(&mut ed, &s, "[e8.systemUsers().includes(e8.userRealLoginName()), e8.systemGroups().includes(e8.groupName(e8.groupGid()))]"), "[true,true]");
}

#[test]
fn the_machine_and_the_process() {
    let (mut ed, s) = setup();
    assert_eq!(eval(&mut ed, &s, "[e8.daemonp() ?? null, e8.systemName().length > 0]"), "[null,true]");
    let current = std::thread::available_parallelism().unwrap().get();
    assert_eq!(eval(&mut ed, &s, r#"e8.numProcessors("current")"#), current.to_string());
    // As Emacs: "all" counts every one, t is the default.
    assert_eq!(eval(&mut ed, &s, r#"[e8.numProcessors("all") >= e8.numProcessors("current"), e8.numProcessors(true) === e8.numProcessors()]"#), "[true,true]");
    // Ids that are not ids, as Emacs: an error.
    assert_eq!(eval(&mut ed, &s, r#"[-1, 1.5, [1]].map((u) => e8.conditionCase(() => e8.userFullName(u) ?? null, { error: (e) => e.message }))"#), r#"["Invalid UID specification","Invalid UID specification","Invalid UID specification"]"#);
}

#[test]
fn suspending_runs_the_hook_and_asks_the_terminal_and_a_window_iconifies() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.ran = 0, e8.addHook("suspend-hook", () => { ran++; }), 0)"#);
    ed.press("C-z").unwrap();
    assert_eq!(ed.suspend_requests(), 1);
    assert_eq!(eval(&mut ed, &s, "ran"), "1");
    ed.press("C-x C-z").unwrap();
    assert_eq!(ed.suspend_requests(), 2);
    // In a window, a front end that shows images, there is no shell:
    // suspend-emacs refuses, C-z iconifies.
    ed.set_text_metrics(std::sync::Arc::new(Window));
    let got = eval(&mut ed, &s, r#"e8.conditionCase(() => e8.call("suspend-emacs"), { "user-error": (e) => e.message })"#);
    assert!(got.contains("Cannot suspend"), "{got}");
    assert_eq!(ed.suspend_requests(), 2);
    ed.press("C-z").unwrap();
    assert_eq!(ed.frame_visibility(ed.selected_frame()), Value::Str("icon".into()));
}

/// A front end's metrics like the GUI's: a window, showing images.
struct Window;

impl e8_core::layout::TextMetrics for Window {
    fn advance(&self, _font: &e8_core::layout::FontSpec, _c: char) -> f32 {
        10.0
    }

    fn line_height(&self, _font: &e8_core::layout::FontSpec) -> f32 {
        20.0
    }

    fn char_width(&self) -> f32 {
        10.0
    }

    fn char_height(&self) -> f32 {
        20.0
    }

    fn images(&self) -> bool {
        true
    }
}
