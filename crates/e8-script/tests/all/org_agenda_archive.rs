//! Archives in the agenda: what the Emacs oracle cannot see, the face
//! blocked tasks are dimmed in, the mode name archives mode gives, C-u v a,
//! and whether archiving from the agenda saves the archive file.

use e8_core::{Editor, Value};
use e8_script::Scripting;

/// Visits `tasks.org`, holding `text`, as the one agenda file, with today fixed.
fn agenda_file(text: &str, globals: &[(&str, Value)]) -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, text).unwrap();
    for (name, value) in globals {
        ed.set_default(name, value.clone());
    }
    ed.call("find-file", vec![e8_core::Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    ed.set_variable("org-archive-save-context-info", Value::List(vec![]));
    (ed, scripting, dir)
}

fn agenda(ed: &Editor) -> String {
    ed.buffers().iter().find(|b| b.name == "*Org Agenda*").map(|b| b.slice(0..b.len())).unwrap()
}

/// The faces of the overlays on each of the agenda's lines.
fn line_faces(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(
        ed,
        "e8.withCurrentBuffer('*Org Agenda*', () => Array.from({ length: e8.lineCount() }, (_, l) => \
         e8.overlaysIn(e8.lineStart(l), e8.lineEnd(l)).map((o) => e8.overlayGet(o, 'face')).join(',')).join('|'))",
    )
    .unwrap()
    .trim_matches('"')
    .to_string()
}

/// A blocked task's line is dimmed with an overlay in
/// org-agenda-dimmed-todo-face, and stays dimmed when the line is written
/// again for a change to its entry.
#[test]
fn blocked_tasks_are_dimmed_and_stay_dimmed() {
    let (mut ed, s, _dir) = agenda_file("* TODO Parent\n** TODO child\n* TODO Other\n", &[("org-enforce-todo-dependencies", Value::Bool(true))]);
    ed.call("org-todo-list", vec![]).unwrap();
    assert_eq!(line_faces(&mut ed, &s), "||org-agenda-dimmed-todo-face|||");
    // The tags changed on the blocked line, which is written again.
    ed.press("n n C-c C-x a").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(agenda(&ed).contains("TODO Parent") && agenda(&ed).contains(":ARCHIVE:"), "{}", agenda(&ed));
    assert_eq!(line_faces(&mut ed, &s), "||org-agenda-dimmed-todo-face|||");
    // # dims them again, once each.
    ed.press("#").unwrap();
    assert_eq!(line_faces(&mut ed, &s), "||org-agenda-dimmed-todo-face|||");
}

/// Without anything on org-blocker-hook, or with org-agenda-dim-blocked-tasks
/// off, nothing is dimmed.
#[test]
fn nothing_is_dimmed_without_blocking() {
    let (mut ed, s, _dir) = agenda_file("* TODO Parent\n** TODO child\n", &[]);
    ed.call("org-todo-list", vec![]).unwrap();
    assert_eq!(line_faces(&mut ed, &s), "||||");
    let (mut ed, s, _dir) = agenda_file(
        "* TODO Parent\n** TODO child\n",
        &[("org-enforce-todo-dependencies", Value::Bool(true)), ("org-agenda-dim-blocked-tasks", Value::Null)],
    );
    ed.call("org-todo-list", vec![]).unwrap();
    assert_eq!(line_faces(&mut ed, &s), "||||");
}

/// The mode name says which archives are shown, after the span (none for
/// the TODO list) and the modes on, as org-agenda-set-mode-name has it, and
/// C-u v a shows the archive files too, asking for a keyword for the TODO list.
#[test]
fn archives_mode_names_itself_and_c_u_takes_the_files() {
    let (mut ed, s, dir) = agenda_file("* TODO B\n", &[]);
    std::fs::write(dir.path().join("tasks.org_archive"), "#    -*- mode: org -*-\n\n* TODO Old\n").unwrap();
    ed.call("org-todo-list", vec![]).unwrap();
    let mode_name = |ed: &mut Editor| s.eval_expression(ed, "e8.withCurrentBuffer('*Org Agenda*', () => e8.variable('mode-name'))").unwrap().trim_matches('"').to_string();
    assert_eq!(mode_name(&mut ed), "Org-Agenda  Ddl Grid Habit");
    ed.press("v a").unwrap();
    assert_eq!(mode_name(&mut ed), "Org-Agenda  Ddl Grid Habit :ARCHIVE:");
    assert!(!agenda(&ed).contains("TODO Old"));
    // C-u asks for a keyword too, as the TODO list is made again with it.
    ed.press("C-u v a T O D O RET").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(mode_name(&mut ed), "Org-Agenda  Ddl Grid Habit Archives");
    assert!(agenda(&ed).contains("TODO Old"), "{}", agenda(&ed));
    // g keeps it, and a new agenda starts without it.
    ed.press("g").unwrap();
    assert!(agenda(&ed).contains("TODO Old"));
    ed.call("org-todo-list", vec![]).unwrap();
    assert!(!agenda(&ed).contains("TODO Old"));
    assert_eq!(mode_name(&mut ed), "Org-Agenda  Ddl Grid Habit");
}

/// Archiving from the agenda into another file saves it with
/// org-archive-subtree-save-file-p from-agenda, and not with from-org, the
/// default.
#[test]
fn archiving_from_the_agenda_saves_as_from_agenda_says() {
    for (save, saved) in [("from-agenda", true), ("from-org", false)] {
        let (mut ed, _s, dir) = agenda_file("* TODO A\n* TODO B\n", &[]);
        ed.set_variable("org-archive-subtree-save-file-p", Value::Str(save.into()));
        ed.call("org-todo-list", vec![]).unwrap();
        ed.press("n n $").unwrap();
        assert_eq!(ed.take_error().map(|e| e.to_string()), None);
        assert!(!agenda(&ed).contains("TODO A"), "{}", agenda(&ed));
        let archive = dir.path().join("tasks.org_archive");
        assert_eq!(archive.exists(), saved, "{save}");
        if saved {
            assert!(std::fs::read_to_string(&archive).unwrap().contains("* TODO A"));
        }
    }
}

/// org-agenda-dim-blocked-tasks called in another buffer leaves it alone,
/// as only the agenda's lines carry the marks it reads.
#[test]
fn dimming_outside_the_agenda_changes_nothing() {
    let (mut ed, s, _dir) = agenda_file(
        "* TODO Parent\n** TODO child\n* TODO Other\n* TODO Last\n",
        &[("org-enforce-todo-dependencies", Value::Bool(true)), ("org-agenda-dim-blocked-tasks", Value::Str("invisible".into()))],
    );
    ed.call("org-todo-list", vec![]).unwrap();
    ed.press("C-x o").unwrap();
    assert_eq!(ed.window_buffer().name, "tasks.org");
    ed.call("org-agenda-dim-blocked-tasks", vec![]).unwrap();
    assert!(!ed.window_buffer().is_modified());
    let overlays = s.eval_expression(&mut ed, "e8.overlaysIn(e8.pointMin(), e8.pointMax()).length").unwrap();
    assert_eq!(overlays, "0");
}

/// t in the agenda on a blocked entry is an error, as Org's
/// org-agenda-todo calls org-todo interactively, and C-u t too; the
/// entry's line stays as it was.
#[test]
fn t_in_the_agenda_on_a_blocked_entry_signals() {
    for keys in ["n n t", "n n C-u t"] {
        let (mut ed, _s, _dir) = agenda_file("* TODO Parent\n** TODO child\n", &[("org-enforce-todo-dependencies", Value::Bool(true))]);
        ed.call("org-todo-list", vec![]).unwrap();
        let _ = ed.press(keys);
        assert_eq!(
            ed.take_error().map(|e| e.to_string()),
            Some("TODO state change from TODO to DONE blocked (by \"TODO child\")".to_string()),
            "{keys}"
        );
        assert!(agenda(&ed).contains("TODO Parent"), "{}", agenda(&ed));
    }
}

/// org-agenda-todo signals from code too, as Org's calls org-todo with
/// call-interactively however it was called itself; and a function on
/// org-after-todo-state-change-hook that changes another heading from code
/// only says that one is blocked, as only org-todo's own call is interactive.
#[test]
fn only_the_agendas_own_change_is_interactive() {
    let (mut ed, s, _dir) = agenda_file("* TODO Parent\n** TODO child\n", &[("org-enforce-todo-dependencies", Value::Bool(true))]);
    ed.call("org-todo-list", vec![]).unwrap();
    ed.press("n n").unwrap();
    assert!(ed.call("org-agenda-todo", vec![]).is_err());
    let (mut ed, s2, _dir2) = agenda_file(
        "* TODO Project\n- [ ] box\n** TODO Task\n",
        &[("org-enforce-todo-checkbox-dependencies", Value::Bool(true))],
    );
    s2.eval_typescript(
        &mut ed,
        "hook.ts",
        r#"e8.addHook("org-after-todo-state-change-hook", () => {
             if (e8.lineText(e8.lineOf(e8.point())).startsWith("** DONE Task")) {
               e8.saveExcursion(() => { e8.gotoChar(0); e8.call("org-todo-set", "DONE"); });
             }
           });"#
            .to_string(),
    )
    .unwrap();
    ed.call("org-todo-list", vec![]).unwrap();
    ed.press("n n n t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(agenda(&ed).contains("DONE Task"), "{}", agenda(&ed));
    let _ = s;
}
