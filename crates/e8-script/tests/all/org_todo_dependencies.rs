//! TODO dependencies where the Emacs oracle cannot show them: a blocked
//! change signals when typed, where batch Emacs, whose
//! called-interactively-p is always nil, only says so; and functions of
//! one's own on org-blocker-hook and org-trigger-hook.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str, enforce: bool) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_default("org-enforce-todo-dependencies", Value::Bool(enforce));
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// Typed, a blocked change signals with the heading that blocks it, as org-todo's user-error.
#[test]
fn a_typed_change_signals() {
    let (mut ed, _s) = org("* TODO Parent\n** TODO child\n", true);
    ed.press("C-c C-t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("TODO state change from TODO to DONE blocked (by \"TODO child\")".into()));
    assert_eq!(text(&ed), "* TODO Parent\n** TODO child\n");
}

/// The option read when Org mode starts decides, as org-mode puts the check on the hook then.
#[test]
fn the_option_counts_when_the_mode_starts() {
    let (mut ed, _s) = org("* TODO Parent\n** TODO child\n", false);
    ed.set_default("org-enforce-todo-dependencies", Value::Bool(true));
    ed.press("C-c C-t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(text(&ed), "* DONE Parent\n** TODO child\n");
}

/// A function of one's own on org-blocker-hook blocks, and org-trigger-hook
/// is given the change after it, with where and from what to what.
#[test]
fn hooks_of_ones_own() {
    let (mut ed, s) = org("* TODO A\n* TODO B\n", false);
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        e8.addHook("org-blocker-hook", (change: e8.Value[]) => !e8.lineText(e8.lineOf(e8.point())).includes("B"));
        e8.addHook("org-trigger-hook", (change: e8.Value[]) => { globalThis.seen.push(JSON.stringify(change)); });
        e8.defineCommand({ name: "test-seen", run: () => e8.message(globalThis.seen.join(" ")) });
        "#
        .to_string(),
    )
    .unwrap();
    ed.press("C-c C-t").unwrap();
    ed.press("C-n C-c C-t").unwrap();
    assert!(ed.take_error().is_some(), "B is blocked");
    assert_eq!(text(&ed), "* DONE A\n* TODO B\n");
    ed.call("test-seen", vec![]).unwrap();
    assert_eq!(ed.echo(), Some(r#"[":type","todo-state-change",":from","TODO",":to","DONE",":position",0]"#));
}
