//! Custom agenda commands, block agendas, stuck projects and the agenda's
//! restriction, where the Emacs oracle cannot look: functions as types,
//! skip functions and headers, the restriction lock, and the flagging note.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TEXT: &str = "#+TODO: TODO NEXT WAIT | DONE\n* TODO Write report :work:\n* Project A\n** TODO Plan\n** DONE Old\n* Project B\n** NEXT Go on\n* Project C\n** Notes :FLAGGED:\n:PROPERTIES:\n:THEFLAGGINGNOTE: look again\\nand again\n:END:\n* WAIT Answer :home:\n";

/// Visits `tasks.org`, holding TEXT, as the one agenda file, with today fixed.
fn agenda_file() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.org");
    std::fs::write(&file, TEXT).unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(file.to_str().unwrap().into())]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 24);
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    (ed, scripting, dir)
}

/// Runs org-agenda, answering its menu with KEYS.
fn org_agenda(ed: &mut Editor, keys: &str) {
    ed.press("M-x").unwrap();
    ed.type_text(&format!("org-agenda\n{keys}"));
}

fn agenda(ed: &Editor) -> String {
    ed.buffers().iter().find(|b| b.name == "*Org Agenda*").map(|b| b.slice(0..b.len())).unwrap()
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) {
    s.eval_expression(ed, code).unwrap();
}

/// The entries' headings the agenda lists, in order.
fn entries(ed: &Editor) -> Vec<String> {
    agenda(ed).lines().filter(|l| l.starts_with("  tasks:")).map(|l| l["  tasks:".len()..].split("  :").next().unwrap().trim().to_string()).collect()
}

/// A function as a custom command's type is called with its match, and
/// its settings are bound while it runs.
#[test]
fn a_function_as_a_custom_commands_type() {
    let (mut ed, s, _dir) = agenda_file();
    eval(
        &mut ed,
        &s,
        "e8.setVariable('org-agenda-custom-commands', [['f', 'Mine', (m) => e8.message(`called with ${m}, span ${e8.variable('org-agenda-span')}`), 'home', [['org-agenda-span', ['quote', 'day']]]]])",
    );
    org_agenda(&mut ed, "f");
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(ed.echo(), Some("called with home, span day"));
}

/// A skip function, as org-agenda-skip-entry-if with its conditions, leaves
/// entries out of the TODO list and the tags view, and a block's settings
/// bind it for that block alone.
#[test]
fn skip_functions_leave_entries_out() {
    let (mut ed, s, _dir) = agenda_file();
    eval(&mut ed, &s, "e8.setVariable('org-agenda-skip-function', ['org-agenda-skip-entry-if', 'todo', ['quote', ['NEXT', 'WAIT']]])");
    ed.call("org-todo-list", vec![]).unwrap();
    assert_eq!(entries(&ed), ["TODO Write report", "TODO Plan"]);
    eval(&mut ed, &s, "e8.setVariable('org-agenda-skip-function', ['org-agenda-skip-subtree-if', 'regexp', 'Plan'])");
    ed.call("org-todo-list", vec![]).unwrap();
    assert_eq!(entries(&ed), ["TODO Write report", "NEXT Go on", "WAIT Answer"]);
    eval(&mut ed, &s, "e8.setVariable('org-agenda-skip-function', null)");
    eval(
        &mut ed,
        &s,
        "e8.setVariable('org-agenda-custom-commands', [['x', 'Both', [['alltodo', '', [['org-agenda-skip-function', ['org-agenda-skip-entry-if', 'nottodo', 'done']]]], ['tags', 'LEVEL=2']]]])",
    );
    org_agenda(&mut ed, "x");
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(entries(&ed), ["TODO Plan", "DONE Old", "NEXT Go on", "Notes"], "{}", agenda(&ed));
}

/// org-agenda-overriding-header may be a function, whose string is the
/// header, and anything else is an error.
#[test]
fn a_function_as_the_overriding_header() {
    let (mut ed, s, _dir) = agenda_file();
    eval(&mut ed, &s, "e8.setVariable('org-agenda-custom-commands', [['h', '', 'tags', 'home', [['org-agenda-overriding-header', () => 'At home\\n']]]])");
    org_agenda(&mut ed, "h");
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(agenda(&ed).starts_with("At home\n  tasks:"), "{}", agenda(&ed));
    eval(&mut ed, &s, "e8.setVariable('org-agenda-custom-commands', [['h', '', 'tags', 'home', [['org-agenda-overriding-header', 3]]]])");
    org_agenda(&mut ed, "h");
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Invalid value for \u{2018}org-agenda-overriding-header\u{2019}: 3"));
}

/// The restriction lock, C-c C-x < on a heading, keeps the agenda to its
/// subtree until C-c C-x > takes it away; a window showing the agenda is
/// made again each time.
#[test]
fn the_restriction_lock() {
    let (mut ed, s, _dir) = agenda_file();
    eval(&mut ed, &s, "e8.gotoChar(e8.bufferText(0, e8.bufferSize()).indexOf('* Project A'))");
    ed.press("C-c C-x <").unwrap();
    assert_eq!(ed.echo(), Some("Locking agenda restriction to subtree"));
    org_agenda(&mut ed, "t");
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(entries(&ed), ["TODO Plan"]);
    // From the agenda, its entry's subtree; > shows everything again.
    ed.press("C-c C-x >").unwrap();
    assert_eq!(ed.echo(), Some("Agenda restriction lock removed"));
    assert_eq!(entries(&ed), ["TODO Write report", "TODO Plan", "NEXT Go on", "WAIT Answer"]);
    ed.press("C-c C-x >").unwrap();
    assert_eq!(ed.echo(), Some("No agenda restriction to remove."));
}

/// The ? view says what each flagged entry's THEFLAGGINGNOTE is, its \n as //, after each command.
#[test]
fn flagged_entries_show_their_note() {
    let (mut ed, _s, _dir) = agenda_file();
    org_agenda(&mut ed, "?");
    assert_eq!(entries(&ed), ["Notes"]);
    // On the entry's line, after the header's two.
    ed.press("n n").unwrap();
    assert_eq!(ed.echo(), Some("FLAGGING-NOTE ([?] for more info): look again//and again"));
}

/// Keys E8 has no view for say so; C and ! ask for Customize, which E8 does not have.
#[test]
fn customize_keys_say_what_to_do() {
    let (mut ed, _s, _dir) = agenda_file();
    org_agenda(&mut ed, "C");
    assert_eq!(
        ed.take_error().map(|e| e.to_string()).as_deref(),
        Some("E8 has no Customize: set org-agenda-custom-commands in your init.ts")
    );
}

/// In a block agenda, f moves its day agenda on and keeps its other
/// blocks, and r makes every block again from the files: the block at
/// point as it is now, the others as their commands make them, as
/// org-agenda-redo gives only the block at point its last arguments.
#[test]
fn keys_in_a_block_agenda_act_on_their_block() {
    let (mut ed, _s, _dir) = agenda_file();
    org_agenda(&mut ed, "n");
    assert!(agenda(&ed).starts_with("Week-agenda (W44):\n"), "{}", agenda(&ed));
    ed.press("f").unwrap();
    assert!(agenda(&ed).starts_with("Week-agenda (W45):\n"), "{}", agenda(&ed));
    assert!(agenda(&ed).contains("Global list of TODO items of type: ALL\n"), "{}", agenda(&ed));
    // On the TODO block's last line, t makes it done; r drops it from there.
    ed.press("M-> C-p t d").unwrap();
    ed.press("r").unwrap();
    assert!(!agenda(&ed).contains("Answer"), "{}", agenda(&ed));
    assert!(agenda(&ed).starts_with("Week-agenda (W44):\n"), "{}", agenda(&ed));
    // In the day agenda's block, r keeps the week it moved to.
    ed.press("M-< f r").unwrap();
    assert!(agenda(&ed).starts_with("Week-agenda (W45):\n"), "{}", agenda(&ed));
}
