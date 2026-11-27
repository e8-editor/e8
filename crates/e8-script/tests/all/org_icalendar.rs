//! Org's iCalendar export (ox-icalendar): what the oracle's cases in
//! tests/emacs/cases/org-icalendar.json cannot show. Each expected calendar
//! is what Emacs 30.2 writes for the same text, run with TZ set to
//! Europe/Stockholm and its DTSTAMP fixed as the oracle fixes it: times in
//! UTC, which depend on the zone, a task starting now, a subtree written
//! to the file its EXPORT_FILE_NAME names, UIDs made and stored as IDs,
//! the current agenda written as a calendar. Diary sexps are E8's own: they
//! are Lisp, which E8 leaves out (ADR 0116).

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;
use std::path::{Path, PathBuf};

/// An editor visiting NAME, holding TEXT, in a directory of its own, with
/// the day fixed, as the oracle fixes it, and the calendar's zone named.
fn visit(name: &str, text: &str) -> (Editor, Scripting, tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(name);
    std::fs::write(&path, text).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-27".into()));
    ed.set_default("user-full-name", Value::Str("E. Xample".into()));
    ed.set_default("org-icalendar-timezone", Value::Str("Europe/Stockholm".into()));
    ed.set_default("org-export-copy-to-kill-ring", Value::Bool(false));
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    (ed, s, dir, path)
}

/// A file's text, which must be there.
fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A calendar's lines as written, each ending in CRLF.
fn crlf(lines: &str) -> String {
    lines.replace('\n', "\r\n")
}

/// The calendar's lines before its first component, as Org writes them.
fn header(name: &str, description: &str) -> String {
    format!(
        "BEGIN:VCALENDAR\nVERSION:2.0\nX-WR-CALNAME:{name}\nPRODID:-//E. Xample//Emacs with Org mode//EN\nX-WR-TIMEZONE:Europe/Stockholm\nX-WR-CALDESC:{description}\nCALSCALE:GREGORIAN\n"
    )
}

/// E8 in Stockholm's zone, as TZ=Europe/Stockholm put Emacs there.
fn stockholm(ed: &mut Editor, s: &Scripting) {
    s.eval_expression(ed, "e8.setTimeZoneRule('Europe/Stockholm')").unwrap();
}

#[test]
fn times_in_utc_follow_the_zone_and_daylight_saving() {
    let (mut ed, s, dir, _) = visit(
        "utc.org",
        "* Meeting\n:PROPERTIES:\n:ID:       u-1\n:END:\n<2026-12-01 Tue 10:00-11:00>\n* Summer\n:PROPERTIES:\n:ID:       u-2\n:END:\n<2026-07-01 Wed 10:00>\n* All day\n:PROPERTIES:\n:ID:       u-3\n:END:\n<2026-12-02 Wed>\n* TODO Timed repeat\nSCHEDULED: <2026-12-01 Tue 08:30 +1d> DEADLINE: <2026-12-20 Sun 18:00>\n:PROPERTIES:\n:ID:       u-4\n:END:\n",
    );
    stockholm(&mut ed, &s);
    ed.set_default("org-icalendar-date-time-format", Value::Str(":%Y%m%dT%H%M%SZ".into()));
    ed.set_default("org-icalendar-include-todo", Value::Bool(true));
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let expected = header("utc", "")
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-u-1\nDTSTART:20261201T090000Z\nDTEND:20261201T100000Z\nSUMMARY:Meeting\nDESCRIPTION:<2026-12-01 Tue 10:00-11:00>\nCATEGORIES:utc\nEND:VEVENT\n"
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-u-2\nDTSTART:20260701T080000Z\nDTEND:20260701T100000Z\nSUMMARY:Summer\nDESCRIPTION:<2026-07-01 Wed 10:00>\nCATEGORIES:utc\nEND:VEVENT\n"
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-u-3\nDTSTART;VALUE=DATE:20261202\nDTEND;VALUE=DATE:20261203\nSUMMARY:All day\nDESCRIPTION:<2026-12-02 Wed>\nCATEGORIES:utc\nEND:VEVENT\n"
        + "BEGIN:VTODO\nUID:TODO-u-4\nDTSTAMP:20261127T120000Z\nDTSTART:20261201T073000Z\nRRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261220T170000Z\nSUMMARY:Timed repeat\nCATEGORIES:utc\nSEQUENCE:1\nPRIORITY:5\nSTATUS:NEEDS-ACTION\nEND:VTODO\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&dir.path().join("utc.ics")), crlf(&expected));
}

#[test]
fn a_timezone_of_utc_converts_and_another_zone_puts_until_in_utc() {
    let (mut ed, s, dir, _) = visit(
        "tzutc.org",
        "* Call\n:PROPERTIES:\n:ID:       t-1\n:TIMEZONE: UTC\n:END:\n<2026-12-01 Tue 10:00>\n* TODO Timed repeat in a zone\nSCHEDULED: <2026-12-01 Tue 08:30 +1d> DEADLINE: <2026-12-20 Sun 18:00>\n:PROPERTIES:\n:ID:       t-2\n:TIMEZONE: Europe/London\n:END:\n",
    );
    stockholm(&mut ed, &s);
    ed.set_default("org-icalendar-include-todo", Value::Bool(true));
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let expected = header("tzutc", "")
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-t-1\nDTSTART:20261201T090000Z\nDTEND:20261201T110000Z\nSUMMARY:Call\nDESCRIPTION:<2026-12-01 Tue 10:00>\nCATEGORIES:tzutc\nEND:VEVENT\n"
        + "BEGIN:VTODO\nUID:TODO-t-2\nDTSTAMP:20261127T120000Z\nDTSTART;TZID=Europe/London:20261201T083000\nRRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261220T170000Z\nSUMMARY:Timed repeat in a zone\nCATEGORIES:tzutc\nSEQUENCE:1\nPRIORITY:5\nSTATUS:NEEDS-ACTION\nEND:VTODO\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&dir.path().join("tzutc.ics")), crlf(&expected));
}

#[test]
fn current_datetime_starts_an_unscheduled_task_now() {
    // Now is noon on the fixed day, as Emacs's decode-time was made to give it.
    let (mut ed, _s, dir, _) = visit("now.org", "* TODO No dates\n:PROPERTIES:\n:ID:       n-1\n:END:\n");
    ed.set_default("org-icalendar-include-todo", Value::Bool(true));
    ed.set_default("org-icalendar-todo-unscheduled-start", Value::Symbol("current-datetime".into()));
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let expected = header("now", "")
        + "BEGIN:VTODO\nUID:TODO-n-1\nDTSTAMP:20261127T120000Z\nDTSTART:20261127T120000\nSUMMARY:No dates\nCATEGORIES:now\nSEQUENCE:1\nPRIORITY:5\nSTATUS:NEEDS-ACTION\nEND:VTODO\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&dir.path().join("now.ics")), crlf(&expected));
}

#[test]
fn the_dispatcher_exports_a_subtree_to_its_export_file_name() {
    let (mut ed, _s, dir, _) = visit(
        "sub.org",
        "* One\n:PROPERTIES:\n:ID:       s-1\n:END:\n<2026-12-01 Tue>\n* Two\n:PROPERTIES:\n:ID:       s-2\n:EXPORT_FILE_NAME: second\n:END:\n<2026-12-02 Wed>\n",
    );
    ed.press("M->").unwrap();
    ed.press("C-c C-e C-s c f").unwrap();
    // As Org exports a subtree: its heading is the calendar's description,
    // and its text without the heading makes no entry.
    assert_eq!(read(&dir.path().join("second.ics")), crlf(&(header("sub", "Two") + "END:VCALENDAR\n")));
    assert!(!dir.path().join("sub.ics").exists());
}

#[test]
fn stored_uids_become_the_entries_ids() {
    let (mut ed, _s, dir, path) = visit(
        "store.org",
        "* Event\n<2026-12-01 Tue>\n* Has one\n:PROPERTIES:\n:ID:       kept\n:END:\n<2026-12-02 Wed>\n* COMMENT Skipped\n<2026-12-03 Thu>\n** Child of a comment\n",
    );
    ed.set_default("org-icalendar-store-UID", Value::Bool(true));
    // In batch, as Emacs was run: sit-for, after saying the IDs were made, sleeps rather than waiting for a key.
    ed.set_noninteractive(true);
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let b = ed.window_buffer();
    let text = b.slice(0..b.len());
    // An ID on the entry that had none, outside the commented tree, as Emacs puts it.
    let re = regex::Regex::new(
        "\\A\\* Event\n:PROPERTIES:\n:ID:       ([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\n:END:\n<2026-12-01 Tue>\n\\* Has one\n:PROPERTIES:\n:ID:       kept\n:END:\n<2026-12-02 Wed>\n\\* COMMENT Skipped\n<2026-12-03 Thu>\n\\*\\* Child of a comment\n\\z",
    )
    .unwrap();
    let id = re.captures(&text).unwrap_or_else(|| panic!("{text}"))[1].to_string();
    assert!(ed.window_buffer().is_modified());
    let expected = header("store", "")
        + &format!("BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-{id}\nDTSTART;VALUE=DATE:20261201\nDTEND;VALUE=DATE:20261202\nSUMMARY:Event\nDESCRIPTION:<2026-12-01 Tue>\nCATEGORIES:store\nEND:VEVENT\n")
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-kept\nDTSTART;VALUE=DATE:20261202\nDTEND;VALUE=DATE:20261203\nSUMMARY:Has one\nDESCRIPTION:<2026-12-02 Wed>\nCATEGORIES:store\nEND:VEVENT\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&dir.path().join("store.ics")), crlf(&expected));
    let said = format!("ID properties created in file \"{}\"", path.display());
    assert!(ed.message_log().iter().any(|m| m.text == said), "{:?}", ed.message_log());
}

#[test]
fn an_entry_without_an_id_gets_a_new_uid() {
    let (mut ed, _s, dir, _) = visit("new.org", "* Event\n<2026-12-01 Tue>\n");
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let ics = read(&dir.path().join("new.ics"));
    let re = regex::Regex::new("\r\nUID:TS1-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\r\n").unwrap();
    assert!(re.is_match(&ics), "{ics}");
    // Nothing is stored unless org-icalendar-store-UID says so.
    assert!(!ed.window_buffer().is_modified());
}

#[test]
fn the_current_agenda_is_written_as_a_calendar() {
    let (mut ed, _s, dir, path) = visit(
        "ag.org",
        "#+CATEGORY: cat\n* Meeting\n:PROPERTIES:\n:ID:       ag-1\n:END:\n<2026-11-27 Fri 10:00>\nNotes.\n* TODO Task\nSCHEDULED: <2026-11-27 Fri>\n:PROPERTIES:\n:ID:       ag-2\n:END:\n** Child\n* Elsewhere\n<2026-12-20 Sun>\n",
    );
    ed.set_default("org-agenda-files", Value::List(vec![Value::Str(path.display().to_string())]));
    ed.set_default("org-agenda-span", Value::Symbol("day".into()));
    ed.call("org-agenda-list", vec![]).unwrap();
    let out = dir.path().join("agenda.ics");
    ed.call("org-agenda-write", vec![Arg::Str(out.display().to_string())]).unwrap();
    // The entries the agenda shows, exported from a string, so with no
    // file to name their category, and every task, as Emacs writes them.
    let expected = header("OrgMode", "")
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-ag-1\nDTSTART:20261127T100000\nDTEND:20261127T120000\nSUMMARY:Meeting\nDESCRIPTION:<2026-11-27 Fri 10:00> Notes.\nCATEGORIES:???\nEND:VEVENT\n"
        + "BEGIN:VTODO\nUID:TODO-ag-2\nDTSTAMP:20261127T120000Z\nDTSTART;VALUE=DATE:20261127\nSUMMARY:Task\nCATEGORIES:???\nSEQUENCE:1\nPRIORITY:5\nSTATUS:NEEDS-ACTION\nEND:VTODO\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&out), crlf(&expected));
}

#[test]
fn diary_sexps_are_left_out() {
    // In Emacs icalendar.el turns them into events; they are Lisp, which E8 does not evaluate.
    let (mut ed, _s, dir, _) = visit(
        "diary.org",
        "* Sexp\n:PROPERTIES:\n:ID:       d-1\n:END:\n<%%(diary-float t 4 2)>\n* Event\n:PROPERTIES:\n:ID:       d-2\n:END:\n<2026-12-01 Tue>\n",
    );
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let ics = read(&dir.path().join("diary.ics"));
    assert!(!ics.contains("d-1"), "{ics}");
    assert!(ics.contains("\r\nUID:TS1-d-2\r\n"), "{ics}");
}

#[test]
fn the_after_save_hook_gets_the_file() {
    let (mut ed, s, dir, _) = visit("hook.org", "* Event\n:PROPERTIES:\n:ID:       h-1\n:END:\n<2026-12-01 Tue>\n");
    s.eval_expression(&mut ed, "e8.addHook('org-icalendar-after-save-hook', (f) => e8.setVariable('ics-saved', f))").unwrap();
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    // As org-export-output-file-name names it, relative to the Org file's directory, as Emacs passes it too.
    assert_eq!(ed.variable("ics-saved"), Some(Value::Str("hook.ics".into())));
    assert!(dir.path().join("hook.ics").exists());
}

#[test]
fn an_unsupported_repeater_warns() {
    let (mut ed, s, _dir, _) = visit("warn.org", "* TODO Restart\nDEADLINE: <2026-12-05 Sat .+1w>\n");
    ed.set_default("org-icalendar-include-todo", Value::Bool(true));
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    let warnings = s.eval_expression(&mut ed, "e8.withCurrentBuffer('*Warnings*', () => e8.bufferText(e8.pointMin(), e8.pointMax()))").unwrap();
    assert!(warnings.contains("Repeater-type restart not currently supported by iCalendar export"), "{warnings}");
}

#[test]
fn a_buffer_without_a_file_names_the_calendar_as_orgs_copy_of_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("e8--today", Value::Str("2026-11-27".into()));
    ed.set_default("user-full-name", Value::Str("E. Xample".into()));
    ed.set_default("org-icalendar-timezone", Value::Str("Europe/Stockholm".into()));
    ed.window_buffer_mut().name = "notes".into();
    ed.window_buffer_mut().set_text("#+EXPORT_FILE_NAME: out\n* E\n:PROPERTIES:\n:ID:       e-1\n:END:\n<2026-12-01 Tue>\n");
    ed.make_local_variable("default-directory");
    ed.set_variable("default-directory", Value::Str(format!("{}/", dir.path().display())));
    ed.call("org-mode", vec![]).unwrap();
    ed.call("org-icalendar-export-to-ics", vec![]).unwrap();
    // As Emacs names it: Org's copy of the buffer is notes<2>.
    let expected = header("notes<2>", "")
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-e-1\nDTSTART;VALUE=DATE:20261201\nDTEND;VALUE=DATE:20261202\nSUMMARY:E\nDESCRIPTION:<2026-12-01 Tue>\nCATEGORIES:???\nEND:VEVENT\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&dir.path().join("out.ics")), crlf(&expected));
}

#[test]
fn the_dispatcher_combines_the_agenda_files() {
    let (mut ed, _s, dir, path) = visit("one.org", "* Event\n:PROPERTIES:\n:ID:       c-1\n:END:\n<2026-12-01 Tue 10:00>\n");
    let other = dir.path().join("two.org");
    std::fs::write(&other, "* Other\n:PROPERTIES:\n:ID:       c-2\n:END:\n<2026-12-02 Wed>\n").unwrap();
    let combined = dir.path().join("all.ics");
    ed.set_default("org-agenda-files", Value::List(vec![Value::Str(path.display().to_string()), Value::Str(other.display().to_string())]));
    ed.set_default("org-icalendar-combined-agenda-file", Value::Str(combined.display().to_string()));
    ed.press("C-c C-e c c").unwrap();
    // Each file's entries in turn, under the combined name, as Emacs writes them.
    let expected = header("OrgMode", "")
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-c-1\nDTSTART:20261201T100000\nDTEND:20261201T120000\nSUMMARY:Event\nDESCRIPTION:<2026-12-01 Tue 10:00>\nCATEGORIES:one\nEND:VEVENT\n"
        + "BEGIN:VEVENT\nDTSTAMP:20261127T120000Z\nUID:TS1-c-2\nDTSTART;VALUE=DATE:20261202\nDTEND;VALUE=DATE:20261203\nSUMMARY:Other\nDESCRIPTION:<2026-12-02 Wed>\nCATEGORIES:two\nEND:VEVENT\n"
        + "END:VCALENDAR\n";
    assert_eq!(read(&combined), crlf(&expected));
    // The file the export visited is not left open.
    assert!(ed.find_buffer("two.org").is_none());
}
