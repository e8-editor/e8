//! Quick help for newcomers (ADR 0068): C-h h, a short guide to where you
//! are, C-h 8, one to getting started with E8, their links into the full
//! help, and help-guide-mode taking them all away.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_frame_size(100, 50);
    (ed, scripting)
}

fn help(ed: &Editor) -> String {
    let i = ed.find_buffer("*Help*").expect("no *Help*");
    let b = &ed.buffers()[i];
    b.slice(0..b.len())
}

fn ts(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

/// Selects *Help*'s window and puts point on the first character of `text` there.
fn point_at(ed: &mut Editor, s: &Scripting, text: &str) {
    for _ in 0..4 {
        if ed.window_buffer().name == "*Help*" {
            break;
        }
        ed.press("C-x o").unwrap();
    }
    assert!(help(ed).contains(text), "{text:?} in:\n{}", help(ed));
    ts(ed, s, &format!("e8.gotoChar(e8.pointMin() + e8.bufferText(e8.pointMin(), e8.pointMax()).indexOf({text:?}));"));
}

#[test]
fn c_h_8_shows_how_to_get_started_with_the_keys_looked_up() {
    let (mut ed, _s) = setup();
    ed.press("C-h 8").unwrap();
    let card = help(&ed);
    assert!(card.starts_with("Getting started with E8\nE8 is an editor that works the way Emacs works."), "{card}");
    for line in ["  When you are stuck\n    C-g ", "    C-x C-f ", "Open a file, or start a new one", "    C-x C-s ", "  Windows\n", "Try now\n", "Learn next\n", "More help\n"] {
        assert!(card.contains(line), "{line:?} in:\n{card}");
    }
    // A key is never broken across lines.
    assert!(card.contains("• Open a file with C-x C-f, change something, and save it with\n    C-x C-s."), "{card}");
    // Every line fits in 70 columns, as prose is filled.
    for line in card.lines() {
        assert!(line.chars().count() <= 70, "too long: {line:?}");
    }
}

#[test]
fn a_rebound_key_shows_as_rebound() {
    let (mut ed, s) = setup();
    ts(&mut ed, &s, r#"e8.bindKey("C-c f", "find-file"); e8.keymapUnset("global-map", "C-x C-f");"#);
    ed.press("C-h 8").unwrap();
    let card = help(&ed);
    assert!(card.contains("    C-c f ") && !card.contains("C-x C-f"), "{card}");
    // A command nothing binds is named with M-x.
    ts(&mut ed, &s, r#"e8.keymapUnset("global-map", "C-c f");"#);
    ed.press("C-h 8").unwrap();
    assert!(help(&ed).contains("    M-x find-file  Open a file"), "{}", help(&ed));
}

#[test]
fn c_h_h_in_org_shows_its_guide_and_links_to_the_full_help() {
    let (mut ed, s) = setup();
    ed.switch_to_buffer("notes.org");
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-h h").unwrap();
    let card = help(&ed);
    assert!(card.starts_with("Org mode\nOrg keeps notes, tasks and plans in plain text."), "{card}");
    assert!(card.contains("  Folding\n    TAB "), "{card}");
    assert!(card.contains("    C-c C-t "), "{card}");
    assert!(card.contains("Everything about Org mode (C-h m)"), "{card}");
    // RET on the link shows what C-h m shows in the Org buffer, and l comes back to the card.
    point_at(&mut ed, &s, "Everything about");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("The major mode is Org mode (org-mode)"), "{}", help(&ed));
    ed.press("l").unwrap();
    assert_eq!(help(&ed), card);
    // From there, the card about getting started.
    point_at(&mut ed, &s, "Getting started with E8");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("Getting started with E8\n"), "{}", help(&ed));
    // Whose link goes back to Org's guide, its keys still Org's though *Help* is current.
    point_at(&mut ed, &s, "Guide to Org mode");
    ed.press("RET").unwrap();
    assert!(help(&ed).starts_with("Org mode\n") && help(&ed).contains("    C-c C-t "), "{}", help(&ed));
}

#[test]
fn a_mode_without_a_guide_gets_one_made_from_its_doc_and_keys() {
    let (mut ed, s) = setup();
    ts(
        &mut ed,
        &s,
        r#"
        e8.defineCommand({ name: "my-notes-tidy", doc: "Tidy the notes. Then more.", run: () => {} });
        e8.defineMajorMode({
          name: "my-notes-mode",
          modeName: "My Notes",
          parent: "org-mode",
          doc: "Notes of mine, kept as Org.\n\nA second paragraph the card leaves out.",
          bindings: { "C-c C-x t": "my-notes-tidy" },
        });
        "#,
    );
    ed.switch_to_buffer("mine");
    ed.call("my-notes-mode", vec![]).unwrap();
    ed.press("C-h h").unwrap();
    let card = help(&ed);
    assert!(!card.contains("second paragraph"), "{card}");
    // Its own keys first, then those of the guide of the mode it is built on.
    assert!(card.starts_with("My Notes mode\nNotes of mine, kept as Org. It is built on Org mode.\n"), "{card}");
    assert!(card.contains("  Keys this mode adds\n    C-c C-x t  Tidy the notes\n  Folding\n"), "{card}");
    assert!(card.contains("    C-c C-t "), "{card}");
    assert!(card.contains("Press C-c C-t on a heading"), "{card}");
}

#[test]
fn every_command_a_guide_names_exists() {
    let (mut ed, s) = setup();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("guide-check.ts"),
        r#"import { guideCommands, guideModes } from "help-guide";
const missing = ["e8", ...guideModes()].flatMap((m) => guideCommands(m).filter((c) => !e8.commandExists(c)).map((c) => `${m}: ${c}`));
e8.setVariable("guide-check", missing.join(", "));
e8.setVariable("guide-modes", guideModes().length);
"#,
    )
    .unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(dir.path().display().to_string())]));
    s.eval_expression(&mut ed, r#"e8.require("guide-check")"#).unwrap();
    assert_eq!(s.eval_expression(&mut ed, r#"e8.variable("guide-check")"#).unwrap(), "\"\"");
    assert_eq!(s.eval_expression(&mut ed, r#"e8.variable("guide-modes")"#).unwrap(), "4");
}

#[test]
fn a_mode_with_no_keys_and_no_guide_points_to_e8s() {
    let (mut ed, _s) = setup();
    ed.press("C-h h").unwrap();
    let card = help(&ed);
    assert!(card.starts_with("Fundamental mode\n"), "{card}");
    assert!(card.contains("This mode adds no keys of its own; C-h 8 has the keys that work"), "{card}");
}

#[test]
fn turning_the_mode_off_takes_the_keys_and_the_hints_away() {
    let (mut ed, s) = setup();
    ed.press("C-h ?").unwrap();
    assert!(help(&ed).contains("C-h h") && help(&ed).contains("C-h 8"), "{}", help(&ed));
    ts(&mut ed, &s, r#"e8.callWithPrefix(-1, "help-guide-mode");"#);
    ed.press("C-h ?").unwrap();
    assert!(!help(&ed).contains("C-h h ") && !help(&ed).contains("C-h 8"), "{}", help(&ed));
    // C-h 8 is now unbound, as in Emacs.
    ed.press("C-h 8").unwrap();
    assert_eq!(ed.echo(), Some("C-h 8 is undefined"));
    // On again, as M-x help-guide-mode does.
    ed.call("help-guide-mode", vec![]).unwrap();
    ed.press("C-h 8").unwrap();
    assert!(help(&ed).starts_with("Getting started with E8"), "{}", help(&ed));
}

#[test]
fn the_startup_line_names_the_keys_unless_something_else_was_said() {
    let (mut ed, s) = setup();
    ed.run_hooks("emacs-startup-hook").unwrap();
    assert_eq!(ed.echo(), Some("Welcome to E8. C-h 8 to get started, C-h h for help where you are."));
    // An init.ts that says something keeps the echo area.
    let (mut ed, _s2) = setup();
    ed.message("Loaded my config");
    ed.run_hooks("emacs-startup-hook").unwrap();
    assert_eq!(ed.echo(), Some("Loaded my config"));
    // And with the mode off, there is nothing.
    let (mut ed2, s3) = setup();
    ts(&mut ed2, &s3, r#"e8.callWithPrefix(-1, "help-guide-mode");"#);
    ed2.run_hooks("emacs-startup-hook").unwrap();
    assert_eq!(ed2.echo(), None);
    drop(s);
}

#[test]
fn a_users_own_binding_of_c_h_h_is_theirs() {
    let (mut ed, s) = setup();
    ts(&mut ed, &s, r#"e8.defineCommand({ name: "my-hello", run: () => e8.message("hello") }); e8.bindKey("C-h h", "my-hello");"#);
    // Turned off, the mode leaves the user's key alone, and turned on again it does not take it.
    ts(&mut ed, &s, r#"e8.callWithPrefix(-1, "help-guide-mode");"#);
    ed.press("C-h h").unwrap();
    assert_eq!(ed.echo(), Some("hello"));
    ed.call("help-guide-mode", vec![]).unwrap();
    ed.press("C-h h").unwrap();
    assert_eq!(ed.echo(), Some("hello"));
    // C-h 8, which the user left alone, is the mode's again.
    ed.press("C-h 8").unwrap();
    assert!(help(&ed).starts_with("Getting started with E8"), "{}", help(&ed));
}

#[test]
fn a_guide_for_another_mode_has_the_keys_minor_modes_leave_it() {
    let (mut ed, s) = setup();
    ed.call("tab-bar-mode", vec![]).unwrap();
    ts(&mut ed, &s, r#"e8.call("help-guide-for-mode", "agent-shell-mode");"#);
    let card = help(&ed);
    // tab-bar-mode takes C-<tab>, so the next mode is C-c TAB here.
    assert!(card.contains("    C-c TAB  Next mode"), "{card}");
    // Only a major mode has a guide.
    let error = s.eval_expression(&mut ed, r#"e8.conditionCase(() => e8.call("help-guide-for-mode", "find-file"), { error: (e) => e.message })"#).unwrap();
    assert_eq!(error, "\"find-file is not a major mode\"");
}

#[test]
fn where_you_are_is_where_c_h_h_was_pressed_and_init_ts_where_e8_reads_it() {
    let (mut ed, s) = setup();
    ed.set_variable("user-emacs-directory", Value::Str("/tmp/my-e8-config/".into()));
    ed.switch_to_buffer("notes.org");
    ed.call("org-mode", vec![]).unwrap();
    ed.press("C-h h").unwrap();
    // A guide to another mode asked for by name is not where you are.
    ts(&mut ed, &s, r#"e8.call("help-guide-for-mode", "dired-mode");"#);
    point_at(&mut ed, &s, "Dired");
    ed.press("C-h 8").unwrap();
    let card = help(&ed);
    assert!(card.contains("Guide to Org mode, where you are"), "{card}");
    assert!(card.contains("Settings go in /tmp/my-e8-config/init.ts, written in TypeScript."), "{card}");
}

#[test]
fn the_title_headings_groups_and_keys_have_their_faces() {
    let (mut ed, s) = setup();
    ed.press("C-h 8").unwrap();
    // The face of the first character of the first `text` in *Help*.
    let face = |ed: &mut Editor, text: &str| {
        s.eval_expression(
            ed,
            &format!(
                r#"e8.withCurrentBuffer("*Help*", () => e8.getTextProperty(e8.pointMin() + e8.bufferText(e8.pointMin(), e8.pointMax()).indexOf({text:?}), "face"))"#
            ),
        )
        .unwrap()
    };
    assert_eq!(face(&mut ed, "Getting started with E8"), "\"help-guide-title\"");
    assert_eq!(face(&mut ed, "Keys that matter here"), "\"help-guide-heading\"");
    assert_eq!(face(&mut ed, "When you are stuck"), "\"help-guide-group\"");
    assert_eq!(face(&mut ed, "C-g "), "\"help-key-binding\"");
    assert_eq!(face(&mut ed, "RET follows a link"), "\"shadow\"");
}
