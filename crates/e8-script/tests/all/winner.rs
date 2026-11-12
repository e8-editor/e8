//! winner.el (ADR 0069, stage 4): winner-mode's rings of window
//! configurations, taken after each command that changes the windows, and
//! winner-undo and winner-redo going through them. Each expectation is
//! what Emacs 30 gives typed in an interactive terminal on an 80 by 24
//! root window, as Emacs takes the configurations as it redisplays, which
//! batch Emacs does not: the windows listed from the frame's first as
//! `[height, width]`, the selected one by its index, their buffers, and
//! the last message.

use e8_core::Editor;
use e8_script::Scripting;

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// The windows after turning winner-mode on, running `setup`, and typing `keys`, a word starting with `type:` typed as text.
fn after(setup: &str, keys: &[&str]) -> String {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    eval(&mut ed, &s, &format!(r#"(e8.call("winner-mode"), {setup}, "")"#));
    for k in keys {
        if let Some(text) = k.strip_prefix("type:") {
            ed.type_text(text);
        } else {
            ed.press(k).unwrap();
        }
    }
    let messages = ed.messages();
    let last = messages.last().cloned().unwrap_or_default();
    let got = eval(
        &mut ed,
        &s,
        r#"((ws) => JSON.stringify([ws.map((w) => [e8.windowTotalHeight(w), e8.windowTotalWidth(w)]), ws.indexOf(e8.selectedWindow()), ws.map((w) => e8.windowBuffer(w))]))(e8.windowList().filter((w) => w !== e8.minibufferWindow()))"#,
    );
    format!("{got} {last}")
}

const THREE: &str = r#"[[[12,40],[12,40],[12,80]],0,["*scratch*","*scratch*","*scratch*"]]"#;
const TWO: &str = r#"[[[12,80],[12,80]],0,["*scratch*","*scratch*"]]"#;
const ONE: &str = r#"[[[24,80]],0,["*scratch*"]]"#;

#[test]
fn winner_undo_goes_back_through_the_configurations() {
    assert_eq!(after("0", &["C-x 2 C-x 3 C-c <left>"]), format!("{TWO} Winner undo (1 / 2)"));
    assert_eq!(after("0", &["C-x 2 C-x 3 C-c <left> C-c <left>"]), format!("{ONE} Winner undo (2 / 2)"));
    assert_eq!(
        after("0", &["C-x 2 C-x 3 C-c <left> C-c <left> C-c <left>"]),
        format!("{ONE} No further window configuration undo information")
    );
    // Undoing after another command starts again from the newest, keeping the selected window.
    assert_eq!(
        after("0", &["C-x 2 C-x 3 C-c <left> C-x o C-c <left>"]),
        r#"[[[12,40],[12,40],[12,80]],2,["*scratch*","*scratch*","*scratch*"]] Winner undo (1 / 3)"#
    );
}

#[test]
fn winner_undo_brings_back_a_deleted_window() {
    assert_eq!(
        after("0", &["C-x 3 C-x 2 C-x o C-x 0 C-c <left>"]),
        r#"[[[12,40],[12,40],[24,40]],0,["*scratch*","*scratch*","*scratch*"]] Winner undo (1 / 3)"#
    );
}

#[test]
fn winner_redo_undoes_the_undo() {
    assert_eq!(after("0", &["C-x 2 C-x 3 C-c <left> C-c <left> C-c <right>"]), format!("{THREE} Winner undid undo"));
    assert_eq!(after("0", &["C-x 2 C-x 3 C-c <left> C-c <right> C-c <right>"]), format!("{THREE} Previous command was not a ‘winner-undo’"));
    assert_eq!(after("0", &["C-x 2 C-x 3 C-c <right>"]), format!("{THREE} Previous command was not a ‘winner-undo’"));
}

#[test]
fn winner_boring_buffers_are_not_brought_back() {
    let boring = r#"e8.setVariable("winner-boring-buffers", ["boring"])"#;
    // The two windows would be one without the boring buffer's, so the one before them is taken.
    assert_eq!(after(boring, &["C-x 2 C-x o C-x b", "type:boring", "RET C-x 1 C-c <left>"]), format!("{ONE} Winner undo (1 / 3)"));
    assert_eq!(
        after(boring, &["C-x 3 C-x 2 C-x o C-x b", "type:boring", "RET C-x 1 C-c <left>"]),
        r#"[[[24,40],[24,40]],0,["*scratch*","*scratch*"]] Winner undo (1 / 4)"#
    );
    assert_eq!(
        after(boring, &["C-x 3 C-x 2 C-x o C-x b", "type:boring", "RET C-x 1 C-c <left> C-c <left>"]),
        r#"[[[12,40],[12,40],[24,40]],0,["*scratch*","*scratch*","*scratch*"]] Winner undo (2 / 4)"#
    );
}

#[test]
fn winner_mode_off_leaves_the_keys_and_signals() {
    assert_eq!(after(r#"e8.callWithPrefix(-1, "winner-mode")"#, &["C-x 2 C-c <left>"]).split(' ').next(), Some(TWO));
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(
        eval(&mut ed, &s, r#"e8.conditionCase(() => e8.call("winner-undo"), { error: (e) => e.message })"#),
        "Winner mode is turned off"
    );
    // winner-dont-bind-my-keys, read as the mode turns on.
    assert_eq!(after(r#"e8.setVariable("winner-dont-bind-my-keys", true), e8.call("winner-mode")"#, &["C-x 2 C-x 3"]).split(' ').next(), Some(THREE));
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    assert_eq!(
        eval(&mut ed, &s, r#"(e8.setVariable("winner-dont-bind-my-keys", true), e8.call("winner-mode"), e8.lookupKey("winner-mode-map", "C-c <left>") ?? "unbound")"#),
        "unbound"
    );
}

#[test]
fn a_buffer_killed_and_made_again_is_not_the_one_winner_kept() {
    // foo is killed and a new foo made: the window that showed the old one is not brought back.
    let again = r#"e8.bindKey("<f4>", e8.defineCommand({ name: "kill-and-make-foo", run: () => { e8.call("kill-buffer", "foo"); e8.getBufferCreate("foo"); } }))"#;
    assert_eq!(
        after(again, &["C-x 3 C-x o C-x b", "type:foo", "RET C-x o C-x 1 <f4> C-c <left>"]),
        r#"[[[24,40],[24,40]],0,["*scratch*","*scratch*"]] Winner undo (1 / 2)"#
    );
    assert_eq!(
        after(again, &["C-x 2 C-x 3 C-x o C-x o C-x b", "type:foo", "RET C-x o C-x 1 <f4> C-c <left>"]),
        r#"[[[24,40],[24,40]],0,["*scratch*","*scratch*"]] Winner undo (1 / 4)"#
    );
}

#[test]
fn winner_frees_the_configurations_it_no_longer_holds() {
    // A configuration is taken after each command that changes the windows;
    // those neither current nor in the ring are freed, with their markers.
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(80, 24);
    eval(&mut ed, &s, r#"(e8.setVariable("winner-ring-size", 3), e8.call("winner-mode"), "")"#);
    for _ in 0..20 {
        ed.press("C-x 2 C-x 1").unwrap();
    }
    let kept = ed.window_configuration_count();
    assert!(kept <= 4, "{kept} window configurations kept");
}
