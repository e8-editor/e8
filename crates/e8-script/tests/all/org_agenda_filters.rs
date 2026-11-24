//! The agenda's filters: what the Emacs oracle cannot see, the mode name
//! they give, presets, org-agenda-auto-exclude-function, the filter hook,
//! completion of the filter string, and filters kept when the agenda is
//! made again.

use e8_core::{Editor, Value};
use e8_script::Scripting;

const TASKS: &str = "#+TAGS: home(h) errand(e)\n* TODO Fix sink :home:\nSCHEDULED: <2026-10-28 Wed>\n:PROPERTIES:\n:Effort: 0:30\n:END:\n\
* TODO Buy milk :errand:\nSCHEDULED: <2026-10-28 Wed>\n* Trip <2026-10-29 Thu>\n";

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
    ed.set_window_size(ed.selected_window(), 80, 40);
    ed.set_variable("e8--today", Value::Str("2026-10-28".into()));
    ed.set_variable("org-agenda-files", Value::List(vec![Value::Str(file.to_str().unwrap().into())]));
    ed.set_default("org-agenda-use-time-grid", Value::Null);
    (ed, scripting, dir)
}

/// The agenda's lines as they show, without those filtered out.
fn shown(ed: &mut Editor) -> Vec<String> {
    let b = ed.buffers().iter().position(|b| b.name == "*Org Agenda*").unwrap();
    let b = &ed.buffers()[b];
    let visible: String = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    visible.lines().filter(|l| l.starts_with("  ")).map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).collect()
}

fn mode_name(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(ed, "e8.withCurrentBuffer('*Org Agenda*', () => e8.variable('mode-name'))").unwrap().trim_matches('"').to_string()
}

/// Types `keys`, answering what they read in turn: a key read as a
/// character, or typed and confirmed with RET in the minibuffer.
fn press_answering(ed: &mut Editor, keys: &str, answers: &[&str]) {
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        let Some(answer) = left.pop_front() else { return false };
        if ed.minibuffer_depth() > 0 {
            ed.type_text(&answer);
            ed.handle_key(e8_core::Key::parse("RET").unwrap());
        } else if answer.chars().count() == 1 {
            // A character read, as the oracle answers one.
            ed.type_text(&answer);
        } else {
            ed.handle_key(e8_core::Key::parse(&answer).unwrap());
        }
        true
    });
    ed.press(keys).unwrap();
}

fn no_error(ed: &mut Editor) {
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
}

/// The mode name lists the filters after the other modes, as
/// org-agenda-set-mode-name does: categories in brackets, then tags,
/// efforts and regexps between slashes.
#[test]
fn the_mode_name_lists_the_filters() {
    let (mut ed, s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    ed.press("N <").unwrap();
    press_answering(&mut ed, "\\", &["h"]);
    press_answering(&mut ed, "_", &["<", "4"]);
    ed.press("= s i n k RET").unwrap();
    ed.press("C-u C-u = m RET").unwrap();
    no_error(&mut ed);
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda Week Ddl Habit [+tasks]+home+<1:00+/m/+/sink/");
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Fix sink :home:"]);
    ed.press("|").unwrap();
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda Week Ddl Habit");
    assert_eq!(ed.echo(), Some("All agenda filters removed"));
    assert_eq!(shown(&mut ed).len(), 3);
}

/// Filters stay when the agenda is made again, but not in a new agenda,
/// unless org-agenda-persistent-filter keeps them.
#[test]
fn filters_stay_for_a_rebuild() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    press_answering(&mut ed, "\\", &["e"]);
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Buy milk :errand:"]);
    ed.press("r").unwrap();
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Buy milk :errand:"]);
    ed.call("org-agenda-list", vec![]).unwrap();
    assert_eq!(shown(&mut ed).len(), 3);
    ed.set_default("org-agenda-persistent-filter", Value::Bool(true));
    press_answering(&mut ed, "\\", &["e"]);
    ed.call("org-agenda-list", vec![]).unwrap();
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Buy milk :errand:"]);
}

/// A preset filters every agenda, shows in the mode name, and stays
/// through \ \, which removes only the filter added to it.
#[test]
fn a_preset_filters_every_agenda() {
    let (mut ed, s, _dir) = agenda_file(TASKS, &[("org-agenda-tag-filter-preset", Value::List(vec![Value::Str("-errand".into())]))]);
    ed.call("org-agenda-list", vec![]).unwrap();
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Fix sink :home:", "tasks: Trip"]);
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda Week Ddl Habit -errand");
    press_answering(&mut ed, "\\", &["h"]);
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Fix sink :home:"]);
    assert_eq!(mode_name(&mut ed, &s), "Org-Agenda Week Ddl Habit -errand+home");
    press_answering(&mut ed, "\\", &["\\"]);
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Fix sink :home:", "tasks: Trip"]);
}

/// RET in the tag filter, and C-u C-u C-u /, hide the tags
/// org-agenda-auto-exclude-function names; / then runs org-agenda-filter-hook.
#[test]
fn the_auto_exclude_function_names_tags_to_hide() {
    let (mut ed, s, _dir) = agenda_file(TASKS, &[]);
    for code in [
        "e8.defun('e8-test-exclude', (tag) => (tag === 'home' ? '-home' : undefined))",
        "e8.setVariable('org-agenda-auto-exclude-function', 'e8-test-exclude')",
        "e8.addHook('org-agenda-filter-hook', () => e8.message('filtered'))",
    ] {
        s.eval_expression(&mut ed, code).unwrap();
    }
    ed.call("org-agenda-list", vec![]).unwrap();
    press_answering(&mut ed, "\\", &["RET"]);
    no_error(&mut ed);
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Buy milk :errand:", "tasks: Trip"]);
    press_answering(&mut ed, "\\", &["\\"]);
    assert_eq!(shown(&mut ed).len(), 3);
    ed.press("C-u C-u C-u /").unwrap();
    no_error(&mut ed);
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Buy milk :errand:", "tasks: Trip"]);
    // | first, as / starts with the filters in force.
    ed.press("| / e r r a n d RET").unwrap();
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Buy milk :errand:"]);
    assert_eq!(ed.echo(), Some("filtered"));
}

/// The filter string completes the categories and tags after its last
/// operator, and efforts after <, > or =; it starts with the filters in force.
#[test]
fn the_filter_string_completes_its_last_part() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    // What the minibuffer holds after each part is typed and completed with TAB.
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let noted = seen.clone();
    let mut parts: std::collections::VecDeque<&str> = ["+ho", "-er", "<1:"].into();
    ed.set_input_source(move |ed| {
        match parts.pop_front() {
            Some(part) => {
                ed.type_text(part);
                ed.handle_key(e8_core::Key::parse("TAB").unwrap());
                noted.borrow_mut().push(ed.minibuffer_input());
            }
            None => ed.handle_key(e8_core::Key::parse("RET").unwrap()),
        }
        true
    });
    ed.press("/").unwrap();
    no_error(&mut ed);
    assert_eq!(*seen.borrow(), vec!["+home", "+home-errand", "+home-errand<1:00"]);
    assert_eq!(shown(&mut ed), vec!["tasks: Scheduled: TODO Fix sink :home:"]);
    // Asked again, it starts with the filters in force.
    let start = std::rc::Rc::new(std::cell::RefCell::new(String::new()));
    let noted = start.clone();
    ed.set_input_source(move |ed| {
        *noted.borrow_mut() = ed.minibuffer_input();
        ed.handle_key(e8_core::Key::parse("C-g").unwrap());
        true
    });
    ed.press("/").unwrap();
    ed.take_error();
    assert_eq!(*start.borrow(), "+home-errand<1:00");
}

/// Entry text mode is refused while lines are filtered out, but not by
/// effort, as org-agenda-entry-text-mode checks.
#[test]
fn entry_text_mode_is_refused_while_filtered() {
    let (mut ed, _s, _dir) = agenda_file(TASKS, &[]);
    ed.call("org-agenda-list", vec![]).unwrap();
    press_answering(&mut ed, "\\", &["h"]);
    ed.press("E").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()).as_deref(), Some("Can\u{2019}t show entry text in filtered views"));
    press_answering(&mut ed, "| _", &["<", "4"]);
    ed.press("E").unwrap();
    no_error(&mut ed);
}

