//! Disabled commands, as Emacs's novice.el has them: a key or M-x that
//! runs one asks first, with *Disabled Command* saying why, and n, SPC, y
//! and ! answer as in Emacs; code calling the command is not asked.

use crate::driven::Driven;

fn driven() -> Driven {
    let d = Driven::new("");
    d.press("C-x b");
    d.type_text("n\n");
    d.type_text("one\ntwo\nthree\n");
    d
}

/** The text of a buffer, if there is one by that name. */
fn buffer_text(ed: &mut e8_core::Editor, name: &str) -> Option<String> {
    ed.buffer_named_mut(name).map(|b| b.slice(0..b.len()))
}

fn disabled_help(d: &Driven) -> String {
    d.with(|ed| buffer_text(ed, "*Disabled Command*").unwrap_or_default())
}

fn narrowed(d: &Driven) -> bool {
    d.with(|ed| {
        let b = ed.window_buffer();
        b.point_min() > 0 || b.point_max() < b.len()
    })
}

fn disabled(d: &Driven, command: &'static str) -> bool {
    d.with(move |ed| ed.get(command, "disabled").is_some_and(|v| v.is_true()))
}

#[test]
fn a_disabled_command_asks_and_n_leaves_it() {
    let d = driven();
    d.press("M-< C-SPC C-n C-x n n");
    assert_eq!(
        d.with(|ed| ed.echo().map(str::to_string)).as_deref(),
        Some("Use this command? (no, yes, SPC (space bar) only once, ! use and enable all): ")
    );
    let help = disabled_help(&d);
    assert!(
        help.starts_with(
            "You have typed C-x n n, invoking disabled command narrow-to-region.\nIt is disabled because new users often find it confusing.\nHere's the first part of its description:\n\n   "
        ),
        "{help:?}"
    );
    assert!(
        help.ends_with(
            "\n\nDo you want to use this command anyway?\n\nYou can now type:\n n    (also C-g) to cancel--don't try the command; it remains disabled.\n y    to enable the command (no questions if you use it again).\n SPC  to try the command just this once, but leave it disabled.\n !    to enable it and all the disabled commands for this session."
        ),
        "{help:?}"
    );
    d.press("n");
    assert!(!narrowed(&d));
    assert!(disabled(&d, "narrow-to-region"));
    // The help goes once answered.
    assert!(d.with(|ed| buffer_text(ed, "*Disabled Command*").is_none()));
}

#[test]
fn space_runs_it_once_and_y_enables_it() {
    let d = driven();
    d.press("M-< C-SPC C-n C-x n n SPC");
    assert!(narrowed(&d));
    assert!(disabled(&d, "narrow-to-region"));
    d.press("C-x n w C-x n n");
    // Asked again, as it is still disabled.
    assert!(d.with(|ed| ed.echo().is_some_and(|e| e.starts_with("Use this command?"))));
    d.press("y");
    assert!(narrowed(&d));
    // With no init file, enabled for the session without asking about it.
    assert!(!disabled(&d, "narrow-to-region"));
    d.press("C-x n w C-x n n");
    assert!(narrowed(&d));
    assert!(d.with(|ed| buffer_text(ed, "*Disabled Command*").is_none()));
}

#[test]
fn bang_enables_every_disabled_command_for_the_session() {
    let d = driven();
    d.press("C-x h C-x C-u !");
    assert_eq!(d.text(), "ONE\nTWO\nTHREE\n");
    // No more questions, for this command or the others.
    d.press("C-x h C-x C-l");
    assert_eq!(d.text(), "one\ntwo\nthree\n");
    assert!(d.with(|ed| !ed.variable("disabled-command-function").is_some_and(|v| v.is_true())));
}

#[test]
fn m_x_says_the_command_was_invoked_and_a_prefix_argument_goes_on() {
    let d = driven();
    d.press("M-x");
    d.type_text("scroll-left");
    d.press("RET");
    assert!(disabled_help(&d).starts_with("You have invoked the disabled command scroll-left.\n"), "{:?}", disabled_help(&d));
    d.press("n");
    // C-u 5 goes to the command run with SPC.
    d.press("C-u 5 C-x < SPC");
    assert_eq!(d.with(|ed| ed.window_hscroll(ed.selected_window())), 5);
}

#[test]
fn code_calling_a_disabled_command_is_not_asked() {
    let d = driven();
    d.with(|ed| ed.call("upcase-region", vec![e8_core::Arg::Int(0), e8_core::Arg::Int(3)]).unwrap());
    assert_eq!(d.text(), "ONE\ntwo\nthree\n");
    assert!(d.with(|ed| buffer_text(ed, "*Disabled Command*").is_none()));
}

/// enable-command and disable-command write the init file, replacing
/// the command's line there.
#[test]
fn enable_and_disable_command_write_the_init_file() {
    let dir = std::env::temp_dir().join(format!("e8-novice-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let init = dir.join("init.ts");
    std::fs::write(&init, "// My config.\ne8.put(\"erase-buffer\", \"disabled\", true);\ne8.setDefault(\"fill-column\", 72);").unwrap();
    let d = Driven::new(&format!("e8.setDefault(\"user-init-file\", {:?});", init.display().to_string()));
    d.press("M-x");
    d.type_text("enable-command");
    d.press("RET");
    d.type_text("erase-buffer");
    d.press("RET");
    assert!(!disabled(&d, "erase-buffer"));
    assert_eq!(
        std::fs::read_to_string(&init).unwrap(),
        "// My config.\ne8.setDefault(\"fill-column\", 72);\ne8.put(\"erase-buffer\", \"disabled\", false);\n"
    );
    d.press("M-x");
    d.type_text("disable-command");
    d.press("RET");
    d.type_text("erase-buffer");
    d.press("RET");
    assert!(disabled(&d, "erase-buffer"));
    assert_eq!(
        std::fs::read_to_string(&init).unwrap(),
        "// My config.\ne8.setDefault(\"fill-column\", 72);\ne8.put(\"erase-buffer\", \"disabled\", true);\n"
    );
    // y asks whether to enable it in the init file too.
    d.press("C-x b");
    d.type_text("t\n");
    d.press("M-x");
    d.type_text("erase-buffer");
    d.press("RET y");
    assert_eq!(d.prompt().as_deref(), Some("Enable command for future editing sessions also? (y or n) "));
    d.press("y");
    assert!(std::fs::read_to_string(&init).unwrap().ends_with("e8.put(\"erase-buffer\", \"disabled\", false);\n"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A command declined is still the last command, as Emacs's command loop
/// makes it: typing after it starts an undo step of its own, and a kill
/// after it does not join the kill before.
#[test]
fn a_declined_command_is_the_last_command() {
    let d = driven();
    d.press("M->");
    d.type_text("ab");
    d.press("C-x n n n");
    d.type_text("c");
    d.press("C-/");
    assert_eq!(d.text(), "one\ntwo\nthree\nab");
    d.press("M-< C-k C-x n n n C-k");
    assert_eq!(d.with(|ed| ed.current_kill(0).ok()).as_deref(), Some("\n"));
}

/// M-x of a declined command puts nothing on command-history, not even
/// the next command.
#[test]
fn m_x_declined_records_nothing() {
    let d = driven();
    d.press("M-x");
    d.type_text("narrow-to-region");
    d.press("RET n C-f");
    let history = d.with(|ed| format!("{:?}", ed.variable("command-history")));
    assert!(!history.contains("forward-char") && !history.contains("narrow-to-region"), "{history}");
}
