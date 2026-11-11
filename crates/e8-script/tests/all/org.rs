//! Org mode: how it looks once fontified, and the commands the Emacs oracle
//! cannot check because they read the minibuffer, depend on today's date,
//! or are about display.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.redisplay();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The rows the window shows, as text.
fn rows(ed: &Editor) -> Vec<String> {
    ed.window_rows(20, true)
        .iter()
        .map(|r| r.segments.iter().map(|s| s.text.as_str()).collect())
        .collect()
}

/// The face names at a position, first first.
fn faces_at(ed: &Editor, pos: usize) -> Vec<String> {
    match ed.window_buffer().text_property(pos, "face") {
        Some(Value::Str(s)) => vec![s.clone()],
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

fn find(ed: &Editor, needle: &str) -> usize {
    let t = text(ed);
    let i = t.find(needle).unwrap_or_else(|| panic!("no {needle:?} in {t:?}"));
    t[..i].chars().count()
}

fn call(ed: &mut Editor, name: &str, args: &[&str]) {
    ed.call(name, args.iter().map(|a| Arg::Str(a.to_string())).collect())
        .unwrap_or_else(|e| panic!("{name}: {e}"));
}

#[test]
fn org_files_get_org_mode() {
    let dir = std::env::temp_dir().join(format!("e8-org-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("notes.org");
    std::fs::write(&file, "* Notes\n").unwrap();
    let mut ed = Editor::new();
    let _scripting = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![Arg::Str(file.to_string_lossy().into_owned())]).unwrap();
    assert_eq!(ed.mode_name(), "Org");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn headings_states_tags_and_priorities_get_their_faces() {
    let (ed, _s) = org("* TODO [#A] Write the report :work:\n** DONE Old *bold* part\nbody\n");
    assert_eq!(faces_at(&ed, find(&ed, "Write")), ["org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, "TODO")), ["org-todo", "org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, "[#A]")), ["org-priority", "org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, ":work:")), ["org-tag", "org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, "DONE")), ["org-done", "org-headline-done", "org-level-2"]);
    assert_eq!(faces_at(&ed, find(&ed, "bold")), ["bold", "org-headline-done", "org-level-2"]);
    assert!(faces_at(&ed, find(&ed, "body")).is_empty());
    // The faces draw: a TODO is bold.
    let row = &ed.window_rows(1, true)[0];
    assert!(row.segments.iter().any(|s| s.text == "TODO" && s.style.bold));
}

#[test]
fn links_show_their_description() {
    let (ed, _s) = org("See [[https://gnu.org][GNU]] and [[*Plans]].\n");
    assert_eq!(rows(&ed)[0], "See GNU and *Plans.");
    assert_eq!(faces_at(&ed, find(&ed, "GNU")), ["org-link"]);
}

#[test]
fn org_hide_emphasis_markers_hides_the_stars_and_tildes() {
    let text = "Some *bold*, ~code~ and a * b * c.\n";
    let (ed, _s) = org(text);
    assert_eq!(rows(&ed)[0], "Some *bold*, ~code~ and a * b * c.", "shown by default, as in Emacs");
    let (mut ed, s) = org(text);
    s.eval_typescript(&mut ed, "test.ts", "e8.setVariable(\"org-hide-emphasis-markers\", true); e8.call(\"font-lock-flush\");".into()).unwrap();
    ed.redisplay();
    assert_eq!(rows(&ed)[0], "Some bold, code and a * b * c.");
    assert_eq!(faces_at(&ed, find(&ed, "bold")), ["bold"]);
}

#[test]
fn text_objects_get_their_faces() {
    let (ed, _s) = org(
        "#+TITLE: My notes\n\
         Some /italic/, _underlined_, =verbatim=, ~code~ and +struck+ text.\n\
         Meet <2026-10-28 Wed 10:00> at https://example.com\n\
         - [X] done item [1/2]\n\
         - term :: definition\n\
         # a comment\n\
         | a | b |\n\
         #+begin_src rust\n\
         fn main() {}\n\
         #+end_src\n\
         :PROPERTIES:\n\
         :ID: 1\n\
         :END:\n",
    );
    assert_eq!(faces_at(&ed, find(&ed, "#+TITLE:")), ["org-document-info-keyword"]);
    assert_eq!(faces_at(&ed, find(&ed, "My notes")), ["org-document-title"]);
    assert_eq!(faces_at(&ed, find(&ed, "/italic/")), ["italic"]);
    assert_eq!(faces_at(&ed, find(&ed, "_underlined_")), ["underline"]);
    assert_eq!(faces_at(&ed, find(&ed, "=verbatim=")), ["org-verbatim"]);
    assert_eq!(faces_at(&ed, find(&ed, "~code~")), ["org-code"]);
    assert_eq!(faces_at(&ed, find(&ed, "+struck+")), ["org-strike-through"]);
    assert_eq!(faces_at(&ed, find(&ed, "<2026")), ["org-date"]);
    assert_eq!(faces_at(&ed, find(&ed, "https://example")), ["org-link"]);
    assert_eq!(faces_at(&ed, find(&ed, "[X]")), ["org-checkbox"]);
    assert_eq!(faces_at(&ed, find(&ed, "[1/2]")), ["org-checkbox-statistics-todo"]);
    assert_eq!(faces_at(&ed, find(&ed, "term")), ["org-list-dt"]);
    assert_eq!(faces_at(&ed, find(&ed, "# a comment")), ["font-lock-comment-face"]);
    assert_eq!(faces_at(&ed, find(&ed, "| a")), ["org-table"]);
    assert_eq!(faces_at(&ed, find(&ed, "#+begin_src")), ["org-block-begin-line"]);
    assert_eq!(faces_at(&ed, find(&ed, "fn main")), ["org-block"]);
    assert_eq!(faces_at(&ed, find(&ed, "#+end_src")), ["org-block-end-line"]);
    assert_eq!(faces_at(&ed, find(&ed, ":PROPERTIES:")), ["org-drawer"]);
    assert_eq!(faces_at(&ed, find(&ed, ":ID:")), ["org-special-keyword"]);
}

#[test]
fn editing_refontifies_what_follows() {
    let (mut ed, _s) = org("one\ntwo\nthree\n");
    ed.window_buffer_mut().set_point(0);
    ed.press("* SPC").unwrap();
    ed.redisplay();
    assert_eq!(faces_at(&ed, 2), ["org-level-1"]);
    // Opening a block restyles the lines after it.
    ed.press("C-n C-a").unwrap();
    ed.type_text("#+begin_quote\n");
    ed.redisplay();
    assert_eq!(faces_at(&ed, find(&ed, "two")), ["org-quote"]);
    assert_eq!(faces_at(&ed, find(&ed, "three")), ["org-quote"]);
}

/// An entry of only blank lines folds again once shown, where Org's TAB
/// keeps showing it (docs/departures.md), and shows again after.
#[test]
fn tab_folds_an_entry_of_blank_lines_again() {
    let (mut ed, _s) = org("#+STARTUP: content\n* Scratch\n** Privesc\n\n\n\n** ffuf\nf\n");
    let at = find(&ed, "** Privesc");
    ed.window_buffer_mut().set_point(at);
    let folded = ["#+STARTUP: content", "* Scratch", "** Privesc...", "", "** ffuf..."];
    assert_eq!(rows(&ed), folded);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("SUBTREE (NO CHILDREN)"));
    assert_eq!(rows(&ed), ["#+STARTUP: content", "* Scratch", "** Privesc", "", "", "", "** ffuf..."]);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("FOLDED"));
    assert_eq!(rows(&ed), folded);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("SUBTREE (NO CHILDREN)"));
}

#[test]
fn folded_headings_show_an_ellipsis() {
    let (mut ed, _s) = org("* One\nbody\n** Sub\ntext\n* Two\n");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("FOLDED"));
    ed.redisplay();
    assert_eq!(rows(&ed), ["* One...", "* Two", ""]);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("CHILDREN"));
    assert_eq!(rows(&ed), ["* One", "body", "** Sub...", "* Two", ""]);
}

#[test]
fn tags_are_set_and_aligned() {
    let (mut ed, _s) = org("* TODO Write\n");
    call(&mut ed, "org-set-tags", &["work home"]);
    let line = text(&ed).lines().next().unwrap().to_string();
    assert!(line.starts_with("* TODO Write "), "{line:?}");
    assert!(line.ends_with(" :work:home:"), "{line:?}");
    assert_eq!(line.chars().count(), 77, "tags end at column 77: {line:?}");
    call(&mut ed, "org-set-tags", &[""]);
    assert_eq!(text(&ed), "* TODO Write\n");
}

#[test]
fn scheduling_and_deadlines_go_on_the_planning_line() {
    let (mut ed, _s) = org("* Task\nbody\n");
    call(&mut ed, "org-schedule", &["2026-11-03"]);
    assert_eq!(text(&ed), "* Task\nSCHEDULED: <2026-11-03 Tue>\nbody\n");
    call(&mut ed, "org-deadline", &["2026-11-05 15:00"]);
    assert_eq!(text(&ed), "* Task\nSCHEDULED: <2026-11-03 Tue> DEADLINE: <2026-11-05 Thu 15:00>\nbody\n");
    ed.call_with_prefix("org-schedule", vec![Arg::Str(String::new())], Some(e8_core::PrefixArg::Universal(4))).unwrap();
    assert_eq!(text(&ed), "* Task\nDEADLINE: <2026-11-05 Thu 15:00>\nbody\n");
}

#[test]
fn timestamps_are_inserted_from_a_date() {
    let (mut ed, _s) = org("Meet ");
    ed.window_buffer_mut().set_point(5);
    call(&mut ed, "org-timestamp", &["2026-12-24 18:30"]);
    assert_eq!(text(&ed), "Meet <2026-12-24 Thu 18:30>");
    // On a timestamp, it is changed rather than added to.
    ed.window_buffer_mut().set_point(8);
    call(&mut ed, "org-timestamp-inactive", &["2026-12-25"]);
    assert_eq!(text(&ed), "Meet [2026-12-25 Fri]");
}

#[test]
fn a_repeating_task_moves_on_when_done() {
    let (mut ed, _s) = org("* TODO Water plants\nSCHEDULED: <2026-10-28 Wed +1w>\n");
    ed.set_variable("org-log-repeat", Value::Bool(false));
    ed.press("C-c C-t").unwrap();
    assert_eq!(text(&ed), "* TODO Water plants\nSCHEDULED: <2026-11-04 Wed +1w>\n");
}

#[test]
fn a_repeat_is_logged_with_the_time() {
    // org-log-repeat is "time" by default, as in Org. The oracle cannot
    // check this, as the note records the time now.
    let (mut ed, _s) = org("* TODO Water plants\nSCHEDULED: <2026-10-28 Wed +1w>\n");
    ed.press("C-c C-t").unwrap();
    let t = text(&ed);
    let lines: Vec<&str> = t.lines().collect();
    assert_eq!(lines[..3], ["* TODO Water plants", "SCHEDULED: <2026-11-04 Wed +1w>", ":PROPERTIES:"], "{t:?}");
    // An inactive timestamp with the time, such as [2026-10-28 Wed 11:13].
    let stamp = |s: &str| {
        let c: Vec<char> = s.chars().collect();
        c.len() == 22
            && c[0] == '['
            && c[21] == ']'
            && c[1..5].iter().chain(&c[6..8]).chain(&c[9..11]).chain(&c[16..18]).chain(&c[19..21]).all(|d| d.is_ascii_digit())
            && c[18] == ':'
    };
    assert!(lines[3].strip_prefix(":LAST_REPEAT: ").is_some_and(stamp), "{t:?}");
    assert_eq!(lines[4], ":END:");
    assert!(lines[5].strip_prefix("- State \"DONE\"       from \"TODO\"       ").is_some_and(stamp), "{t:?}");
    // The drawer is folded, as org-entry-put leaves a new one.
    assert!(ed.invisible_in(ed.window_buffer(), find(&ed, ":LAST_REPEAT:")).is_some());
}

#[test]
fn org_log_done_records_when() {
    let (mut ed, _s) = org("* TODO Ship it\n");
    ed.set_variable("org-log-done", Value::Str("time".into()));
    ed.press("C-c C-t").unwrap();
    let t = text(&ed);
    assert!(t.starts_with("* DONE Ship it\nCLOSED: ["), "{t:?}");
    ed.press("C-c C-t").unwrap();
    assert_eq!(text(&ed), "* Ship it\n");
}

#[test]
fn links_are_inserted_and_followed() {
    let (mut ed, _s) = org("* One\n\n* Two\n");
    ed.window_buffer_mut().set_point(6);
    call(&mut ed, "org-insert-link", &["*Two", "the second"]);
    assert_eq!(text(&ed), "* One\n[[*Two][the second]]\n* Two\n");
    ed.window_buffer_mut().set_point(9);
    ed.press("C-c C-o").unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "* Two"));
    // On the heading, as anywhere in the entry, the entry's only link is followed.
    ed.window_buffer_mut().set_point(0);
    ed.call("org-open-at-point", vec![]).unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "* Two"));
    let (mut ed, _s) = org("text
* One
");
    assert_eq!(ed.call("org-open-at-point", vec![]).unwrap_err().to_string(), "No link found");
}

#[test]
fn a_table_is_made_from_a_size() {
    let (mut ed, _s) = org("");
    call(&mut ed, "org-table-create-or-convert-from-region", &["3x2"]);
    assert_eq!(text(&ed), "|   |   |   |\n|---+---+---|\n|   |   |   |\n");
    assert_eq!(ed.window_buffer().point(), 2);
    ed.press("a TAB b TAB c TAB").unwrap();
    assert_eq!(text(&ed), "| a | b | c |\n|---+---+---|\n|   |   |   |\n");
}

#[test]
fn typing_after_tab_replaces_a_field() {
    let (mut ed, _s) = org("| one | two |\n");
    ed.window_buffer_mut().set_point(2);
    ed.press("TAB x").unwrap();
    assert_eq!(text(&ed), "| one | x   |\n");
}

#[test]
fn a_subtree_is_cut_and_pasted_at_a_new_level() {
    let (mut ed, _s) = org("* One\n** Sub\ntext\n* Two\n");
    ed.window_buffer_mut().set_point(6);
    ed.press("C-c C-x C-w").unwrap();
    assert_eq!(text(&ed), "* One\n* Two\n");
    ed.press("C-c C-n").unwrap();
    ed.press("C-c C-x C-y").unwrap();
    assert_eq!(text(&ed), "* One\n* Two\n* Sub\ntext\n");
}

#[test]
fn checkboxes_update_their_parent() {
    let (mut ed, _s) = org("- [ ] all [/]\n  - [ ] a\n  - [X] b\n");
    let a = find(&ed, "  - [ ] a") + 2;
    ed.window_buffer_mut().set_point(a);
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "- [X] all [2/2]\n  - [X] a\n  - [X] b\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "- [-] all [1/2]\n  - [ ] a\n  - [X] b\n");
}

#[test]
fn undo_takes_back_a_whole_org_command() {
    let (mut ed, _s) = org("| a | bb |\n| ccc | d |\n");
    ed.window_buffer_mut().set_point(1);
    ed.press("TAB").unwrap();
    assert_eq!(text(&ed), "| a   | bb |\n| ccc | d  |\n");
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "| a | bb |\n| ccc | d |\n");
}

#[test]
fn fontifying_a_large_file_is_quick() {
    let mut big = String::new();
    for i in 0..3000 {
        big.push_str(&format!("* TODO Heading {i} :tag:\nSome *bold* text with a [[https://x.org][link]] <2026-10-28 Wed>.\n"));
    }
    let (mut ed, _s) = org(&big);
    let start = std::time::Instant::now();
    ed.press("M-> M-<").unwrap();
    ed.redisplay();
    ed.type_text("x");
    ed.redisplay();
    assert!(start.elapsed().as_secs_f64() < 2.0, "took {:?}", start.elapsed());
}


/// The heading index follows edits as finding every heading again would:
/// random insertions, deletions and Org commands, checked after each, a
/// heading at a time or all of them.
#[test]
fn the_heading_index_follows_random_edits() {
    let mut text = String::new();
    for i in 0..60 {
        text.push_str(&format!("{} TODO Heading {i} :tag{}:\nBody of {i}.\n", "*".repeat(1 + i % 3), i % 4));
    }
    let (mut ed, s) = org(&text);
    let mut seed = 42u64;
    let mut rand = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize % n.max(1)
    };
    let pieces = ["\n* New ", "x", "\n", "** ", "*", " :a:b:", "TODO ", "\n\n", "é", ""];
    for step in 0..400 {
        let len = ed.buffer().len();
        match rand(6) {
            0 | 1 => {
                let at = rand(len + 1);
                ed.buffer_mut().set_point(at);
                ed.type_text(pieces[rand(pieces.len())]);
            }
            2 => {
                let at = rand(len + 1);
                let n = rand(12).min(len - at.min(len));
                ed.buffer_mut().set_point(at);
                for _ in 0..n {
                    ed.press("C-d").ok();
                }
            }
            3 => {
                let line = rand(ed.buffer().line_count());
                let at = ed.buffer().line_start(line);
                ed.buffer_mut().set_point(at);
                ed.press(["C-c C-t", "M-<down>", "M-<up>", "RET", "C-k", "M-RET"][rand(6)]).ok();
            }
            4 => {
                ed.press("C-/").ok();
            }
            _ => {
                // Narrowed, then widened again.
                let line = rand(ed.buffer().line_count());
                let at = ed.buffer().line_start(line);
                ed.buffer_mut().set_point(at);
                ed.call("org-narrow-to-subtree", vec![]).ok();
                let verdict = s.eval_expression(&mut ed, "e8.funcall('org--headings-verify')").unwrap();
                assert_eq!(verdict, "null", "narrowed, step {step}");
                ed.press("C-x n w").ok();
            }
        }
        ed.take_error();
        // Mostly one heading, read as the element parser reads it, so the
        // shifts for the rest stay pending across steps; now and then all.
        let check = if step % 5 == 4 { String::new() } else { rand(1000).to_string() };
        let verdict = s.eval_expression(&mut ed, &format!("e8.funcall('org--headings-verify', {check})")).unwrap();
        assert_eq!(verdict, "null", "step {step}");
    }
    let verdict = s.eval_expression(&mut ed, "e8.funcall('org--headings-verify')").unwrap();
    assert_eq!(verdict, "null", "at the end");
}

/// Org's markers live only while the command that made them runs: one an
/// error left behind is dropped once the command is over, not moved on
/// every later edit for the rest of the session.
#[test]
fn markers_a_failed_command_leaves_are_dropped_after_it() {
    let (mut ed, s) = org("* One\n");
    s.eval_typescript(
        &mut ed,
        "leak.ts",
        r#"import("org-macs").then((m) => {
             (globalThis as any).orgMacs = m;
             e8.defineCommand({ name: "leak-a-marker", run: () => { m.marker(0); throw new Error("partway"); } });
           });"#
            .to_string(),
    )
    .unwrap();
    // Org keeps a few markers across commands, as its last-indent ones.
    let count = |ed: &mut e8_core::Editor| s.eval_expression(ed, "(globalThis as any).orgMacs.markers.length").unwrap();
    let before = count(&mut ed);
    ed.press("M-x").unwrap();
    ed.type_text("leak-a-marker\n");
    assert_eq!(count(&mut ed), before);
}

/// A fold an edit breaks is shown once the command is over in the buffer
/// it is in, though another is current by then, as when the edit is made
/// from the agenda or capture.
#[test]
fn a_fold_broken_from_another_buffer_is_shown_in_its_own() {
    let (mut ed, s) = org("* A\nbody\n* B\n");
    ed.press("TAB").unwrap();
    ed.redisplay();
    assert!(!rows(&ed).iter().any(|r| r.contains("body")), "folded: {:?}", rows(&ed));
    s.eval_typescript(
        &mut ed,
        "break.ts",
        r#"e8.defineCommand({ name: "break-fold-elsewhere", run: () => {
             e8.call("switch-to-buffer", "other");
             e8.withCurrentBuffer("*scratch*", () => e8.deleteRegion(0, 2));
           } });"#
            .to_string(),
    )
    .unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("break-fold-elsewhere\n");
    ed.call("switch-to-buffer", vec![Arg::Str("*scratch*".into())]).unwrap();
    ed.redisplay();
    assert!(rows(&ed).iter().any(|r| r.contains("body")), "shown: {:?}", rows(&ed));
}

/// The week's agenda reads each file once, not once a day: 10,000 entries
/// with timestamps make their week quickly, each on its day.
#[test]
fn the_week_agenda_reads_each_file_once() {
    let (mut ed, s) = org("");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.org");
    let entries: String = (0..10_000)
        .map(|i| format!("* TODO Task {i}\nSCHEDULED: <2026-11-{:02} Tue>\nBody with <2026-11-{:02} Wed> in it.\n", 2 + i % 7, 2 + (i + 3) % 7))
        .collect();
    std::fs::write(&path, entries).unwrap();
    s.eval_typescript(&mut ed, "files.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]);", path.to_str().unwrap())).unwrap();
    let started = std::time::Instant::now();
    s.eval_typescript(&mut ed, "week.ts", "e8.call(\"org-agenda-list\");".to_string()).unwrap();
    let took = started.elapsed();
    let agenda = text(&ed);
    assert!(agenda.contains("Task 9999"), "{}", &agenda[..agenda.len().min(400)]);
    assert!(took < time_limit(10), "took {took:?}");
}

/// A limit for work that would take minutes if it were done the slow way,
/// as parsing again for each line would: three times as long on CI, whose
/// shared machines are slower and busier than a developer's.
fn time_limit(secs: u64) -> std::time::Duration {
    std::time::Duration::from_secs(if std::env::var_os("CI").is_some() { secs * 3 } else { secs })
}

/// Indenting a region keeps its parse through the indentation it changes,
/// rather than parsing the section again after each line: a section of
/// 2,000 paragraphs indents quickly, each line to the column it belongs.
#[test]
fn indenting_a_long_section_keeps_its_parse() {
    let body: String = (0..2_000).map(|i| format!("   paragraph {i}\n\n")).collect();
    let (mut ed, _s) = org(&format!("* Heading\n{body}"));
    let started = std::time::Instant::now();
    ed.press("M-< C-SPC M-> TAB").unwrap();
    let took = started.elapsed();
    let indented = text(&ed);
    assert!(indented.contains("\nparagraph 1999\n") && !indented.contains("   paragraph"), "{}", &indented[..200]);
    assert!(took < time_limit(10), "took {took:?}");
}

/// Org's errors in what the user did are `user-error`, as Emacs signals
/// them, so code catches them by condition.
#[test]
fn orgs_mistakes_are_user_errors() {
    // Before the first heading, where no entry has links to choose from.
    let (mut ed, s) = org("plain text\n* Heading\n");
    let caught = |ed: &mut Editor, command: &str| {
        let code = format!(r#"e8.conditionCase(() => {{ e8.call("{command}"); return "ran"; }}, {{ "user-error": (e) => "user-error: " + e.message, error: (e) => "error: " + e.message }})"#);
        s.eval_expression(ed, &code).unwrap()
    };
    assert_eq!(caught(&mut ed, "org-open-at-point"), "\"user-error: No link found\"");
    assert_eq!(caught(&mut ed, "org-table-align"), "\"user-error: Not at a table\"");
}

/// The buffer after typing `line` on the second of three lines and pressing `keys`, `|` at point.
fn typed(setup: &str, line: &str, keys: &str) -> String {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    if !setup.is_empty() {
        s.eval_expression(&mut ed, setup).unwrap();
    }
    ed.window_buffer_mut().set_text(&format!("a\n{line}\nb\n"));
    ed.call("org-mode", vec![]).unwrap();
    let end = 2 + line.chars().count();
    ed.window_buffer_mut().set_point(end);
    ed.press(keys).unwrap();
    let mut t = text(&ed);
    let at = t.char_indices().nth(ed.window_buffer().point()).map_or(t.len(), |(i, _)| i);
    t.insert(at, '|');
    t
}

#[test]
fn org_tempo_expands_templates_once_required() {
    let tempo = r#"(e8.require("org-tempo"), e8.setVariable("org-structure-template-alist", [...e8.variable("org-structure-template-alist"), ["el", "src emacs-lisp"]]))"#;
    // As Emacs 30's org-tempo leaves them.
    assert_eq!(typed(tempo, "<s", "TAB"), "a\n#+begin_src |\n\n#+end_src\nb\n");
    assert_eq!(typed(tempo, "<q", "TAB"), "a\n#+begin_quote\n|\n#+end_quote\nb\n");
    assert_eq!(typed(tempo, "  <q", "TAB"), "a\n#+begin_quote\n|\n#+end_quote\nb\n");
    assert_eq!(typed(tempo, "<el", "TAB"), "a\n#+begin_src emacs-lisp\n|\n#+end_src\nb\n");
    assert_eq!(typed(tempo, "<L", "TAB"), "a\n#+latex: |\nb\n");
    assert_eq!(typed(tempo, "x <s", "TAB"), "a\nx <s|\nb\n");
    // Without it, TAB only indents, as in Emacs -Q.
    assert_eq!(typed("", "<s", "TAB"), "a\n<s|\nb\n");
}

#[test]
fn org_insert_structure_template_asks_by_key() {
    // As Emacs 30's C-c C-, leaves them.
    assert_eq!(typed("", "", "C-c C-, q"), "a\n#+begin_quote\n|#+end_quote\nb\n");
    assert_eq!(typed("", "", "C-c C-, s"), "a\n#+begin_src |\n#+end_src\nb\n");
    assert_eq!(typed("", "foo", "C-c C-, q"), "a\nfoo\n#+begin_quote\n|#+end_quote\nb\n");
    assert_eq!(typed("", "  x", "C-c C-, TAB Q U O T E RET"), "a\n  x\n  #+BEGIN_QUOTE\n  |#+END_QUOTE\nb\n");
    assert_eq!(typed("", "", "C-c C-, TAB s r c SPC e m a c s - l i s p RET"), "a\n#+begin_src emacs-lisp\n|#+end_src\nb\n");
    // Around the region, escaping what Org would read as its own.
    let (mut ed, _s) = org("x\n* h\n#+k\ny\n");
    ed.window_buffer_mut().set_point(2);
    ed.press("C-SPC M-> C-c C-, e").unwrap();
    assert_eq!(text(&ed), "x\n#+begin_example\n,* h\n,#+k\ny\n#+end_example\n");
}

#[test]
fn require_loads_a_package_once_from_load_path() {
    let dir = std::env::temp_dir().join(format!("e8-require-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("my-thing.ts"), "import { charCount } from \"subr\";\ne8.setVariable(\"my-thing-loads\", Number(e8.variable(\"my-thing-loads\") ?? 0) + charCount(\"x\"));\n").unwrap();
    let (mut ed, s) = org("");
    ed.set_variable("load-path", Value::List(vec![Value::Str(dir.display().to_string())]));
    s.eval_expression(&mut ed, r#"(e8.require("my-thing"), e8.require("my-thing"))"#).unwrap();
    assert_eq!(ed.variable("my-thing-loads"), Some(Value::Number(1.0)));
    let missing = s
        .eval_expression(&mut ed, r#"e8.conditionCase(() => e8.require("no-such-thing"), { "file-missing": (e) => e.message })"#)
        .unwrap();
    assert_eq!(missing, "\"Cannot open load file: No such file or directory, no-such-thing\"");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tangling_writes_blocks_as_emacs_does() {
    // As Emacs 30's org-babel-tangle writes this file's blocks: header
    // arguments from #+PROPERTY, a drawer and the blocks themselves, a
    // COMMENT heading's left out, indentation and escaping commas taken
    // off, a blank line between blocks but with :padline no, a shebang
    // that makes the file executable, and directories :mkdirp makes.
    let dir = tempfile::tempdir().unwrap();
    let org = dir.path().join("conf.org");
    std::fs::write(&org, include_str!("../data/tangle.org")).unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![Arg::Str(org.display().to_string())]).unwrap();
    ed.press("C-c C-v t").unwrap();
    assert_eq!(ed.echo(), Some("Tangled 5 code blocks from conf.org"));
    let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
    assert_eq!(read("conf.el"), "(setq a 1)\n\n(when t\n  * not a heading\n  (setq b 2))\n");
    assert_eq!(read("out/other.py"), "print(\"one\")\nprint(\"two\")\n");
    assert_eq!(read("run.sh"), "#!/bin/sh\necho hi\n");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir.path().join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    // C-u tangles only the block at point.
    std::fs::remove_file(dir.path().join("conf.el")).unwrap();
    ed.press("M-< C-s r u n . s h RET C-u C-c C-v t").unwrap();
    assert_eq!(ed.echo(), Some("Tangled 1 code block from conf.org"));
    assert!(!dir.path().join("conf.el").exists());
}

/// Each line with its line-prefix and wrap-prefix, as org-indent-mode gives them.
fn prefixes(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(
        ed,
        r#"Array.from({ length: e8.lineCount() - 1 }, (_, l) => {
            const p = e8.lineStart(l);
            const get = (name) => String(e8.getTextProperty(p, name) ?? "");
            return JSON.stringify([e8.lineText(l), get("line-prefix"), get("wrap-prefix")]);
          }).join("\n")"#,
    )
    .unwrap()
}

#[test]
fn org_indent_mode_indents_text_under_headings_as_emacs_does() {
    // What Emacs 30's org-indent-mode gives each line of this text.
    let (mut ed, s) = org("Intro\n* One\nText one\n- item one\n  continued\n** Two\n  indented text\n*** Three\n\nlast\n- tag :: desc\n");
    ed.press("M-x o r g - i n d e n t - m o d e RET").unwrap();
    let expected = [
        r#"["Intro","",""]"#,
        r#"["* One","","* "]"#,
        r#"["Text one","  ","  "]"#,
        r#"["- item one","  ","    "]"#,
        r#"["  continued","  ","    "]"#,
        r#"["** Two","*","*** "]"#,
        r#"["  indented text","    ","      "]"#,
        r#"["*** Three","**","***** "]"#,
        r#"["","      ","      "]"#,
        r#"["last","      ","      "]"#,
        r#"["- tag :: desc","      ","        "]"#,
    ]
    .join("\n");
    assert_eq!(prefixes(&mut ed, &s).trim_matches('"').replace("\\n", "\n").replace("\\\"", "\""), expected);
    // The rows show the indentation, and the leading stars are hidden.
    ed.redisplay();
    assert_eq!(rows(&ed)[2], "  Text one");
    // The prefix stars are drawn in org-indent, the background colour.
    assert_eq!(rows(&ed)[7], "***** Three");
    let face = s.eval_expression(&mut ed, r#"String(e8.getTextProperty(e8.lineStart(7), "face"))"#).unwrap();
    assert_eq!(face.trim_matches('"'), "org-hide");
    // A new heading gives the text after it its level.
    ed.press("M-< C-n C-n C-o * * * SPC N e w").unwrap();
    let p = prefixes(&mut ed, &s);
    assert!(p.contains(r#"[\"Text one\",\"      \",\"      \"]"#), "{p}");
    ed.press("M-x o r g - i n d e n t - m o d e RET").unwrap();
    let left = s.eval_expression(&mut ed, r#"String(Array.from({ length: e8.bufferSize() }, (_, p) => e8.getTextProperty(p, "line-prefix")).filter((v) => v !== undefined).length)"#).unwrap();
    assert_eq!(left.trim_matches('"'), "0", "turning it off takes the prefixes off");
}

#[test]
fn startup_indent_turns_org_indent_mode_on() {
    let (ed, _s) = org("#+STARTUP: indent\n* One\ntext\n");
    assert_eq!(ed.variable("org-indent-mode"), Some(Value::Bool(true)));
    let (ed, _s) = org("* One\ntext\n");
    assert_eq!(ed.variable("org-indent-mode"), Some(Value::Bool(false)));
}

#[test]
fn org_indent_mode_indents_a_big_buffer_a_piece_at_a_time() {
    let mut text = String::new();
    for i in 0..5000 {
        text.push_str(&format!("* Heading {i}\nSome text under it\n"));
    }
    let (mut ed, s) = org(&text);
    ed.call("org-indent-mode", vec![]).unwrap();
    let last = r#"String(e8.getTextProperty(e8.lineStart(e8.lineCount() - 2), "line-prefix"))"#;
    // Until the timers have run, the end has no prefix yet; then it has.
    for _ in 0..1000 {
        if s.eval_expression(&mut ed, last).unwrap().trim_matches('"') == "  " {
            return;
        }
        ed.advance_clock(std::time::Duration::from_millis(60));
    }
    panic!("the end of the buffer was never indented");
}

#[test]
fn refile_targets_with_outline_paths_reach_other_files_as_emacs_does() {
    // config.org's settings; what Emacs 30 offered and did with them.
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::write(dir.path().join("main.org"), "* Projects\n** E8\n*** Docs\n**** Deep\n***** Too deep\n** A/B test\n* TODO Inbox :work:\n** Note one\nbody\n").unwrap();
    std::fs::write(dir.path().join("archive.org"), "* 2025\n** Old\n* 2026\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![Arg::Str(dir.path().join("main.org").display().to_string())]).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"e8.setVariable("org-refile-targets", [[null, ":maxlevel", 4], ["archive.org", ":maxlevel", 1]]);
           e8.setVariable("org-refile-use-outline-path", true);
           e8.setVariable("org-outline-path-complete-in-steps", false);
           import("org-refile").then(({ refileTargets }) => e8.message(JSON.stringify(refileTargets().map((t) => t.name))));"#
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        ed.echo(),
        Some(r#"["Projects","Projects/E8","Projects/E8/Docs","Projects/E8/Docs/Deep","Projects/A\\/B test","Inbox","Inbox/Note one","2025","2026"]"#)
    );
    ed.press("C-s N o t e RET").unwrap();
    ed.press("C-c C-w 2 0 2 6 / SPC ( a r c h i v e . o r g ) RET").unwrap();
    assert_eq!(text(&ed), "* Projects\n** E8\n*** Docs\n**** Deep\n***** Too deep\n** A/B test\n* TODO Inbox :work:\n");
    let archive = ed.buffers().iter().find(|b| b.name == "archive.org").unwrap();
    assert_eq!(archive.slice(0..archive.len()), "* 2025\n** Old\n* 2026\n** Note one\nbody\n");
    assert!(archive.is_modified());
    let file = dir.path().join("archive.org").display().to_string();
    assert_eq!(ed.echo().map(str::to_string), Some(format!("Refile to \"2026/ (archive.org)\" in file {file}: done")));
    // A path typed with its slash names the heading as found.
    ed.press("M-< C-s A / B RET C-c C-w M-DEL M-DEL M-DEL M-DEL P r o j e c t s / E 8 / RET").unwrap();
    assert_eq!(text(&ed), "* Projects\n** E8\n*** Docs\n**** Deep\n***** Too deep\n*** A/B test\n* TODO Inbox :work:\n");
    let main = dir.path().join("main.org").display().to_string();
    assert_eq!(ed.echo().map(str::to_string), Some(format!("Refile to \"Projects/E8\" in file {main}: done")));
}

#[test]
fn org_ellipsis_shows_after_a_folded_heading() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(&mut ed, r#"(e8.setVariable("org-ellipsis", " [+] "), 1)"#).unwrap();
    ed.window_buffer_mut().set_text("* One\nbody\n* Two\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.press("TAB").unwrap();
    ed.redisplay();
    assert_eq!(&rows(&ed)[..2], ["* One [+] ", "* Two"]);
    let (mut plain, _s) = org("* One\nbody\n* Two\n");
    plain.press("TAB").unwrap();
    plain.redisplay();
    assert_eq!(&rows(&plain)[..2], ["* One...", "* Two"]);
}

#[test]
fn a_folded_block_s_ellipsis_takes_its_begin_line_s_background() {
    // As Emacs draws the ellipsis over the face of the hidden text's start,
    // the #+begin line's newline here, and over the default face after a heading.
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(
        &mut ed,
        r##"(e8.setVariable("org-ellipsis", " [+] "), e8.setFaceAttribute("org-block-begin-line", { background: "#3B4252", extend: true }), 1)"##,
    )
    .unwrap();
    ed.window_buffer_mut().set_text("* H\n#+begin_src bash\nls\n#+end_src\n* Two\nbody\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.press("C-n TAB").unwrap();
    ed.redisplay();
    let rows = ed.window_rows(20, true);
    let text: Vec<String> = rows.iter().map(|r| r.segments.iter().map(|s| s.text.as_str()).collect()).collect();
    assert_eq!(&text[..3], ["* H", "#+begin_src bash [+] ", "* Two"]);
    let block = &rows[1].segments;
    let begin = block.iter().find(|s| s.text.contains("begin")).unwrap().style.background;
    assert!(begin.is_some());
    assert!(block.iter().filter(|s| s.ellipsis).all(|s| s.style.background == begin), "{block:?}");
    ed.press("M-> C-p C-p TAB").unwrap();
    ed.redisplay();
    let rows = ed.window_rows(20, true);
    let heading = rows.iter().find(|r| r.segments.iter().any(|s| s.text.contains("Two"))).unwrap();
    assert!(heading.segments.iter().filter(|s| s.ellipsis).all(|s| s.style.background.is_none()), "{heading:?}");
}

/// config.org's TODO states: keys to pick them, and each change logged into LOGBOOK.
fn logging_org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(
        &mut ed,
        r#"(e8.setVariable("org-todo-keywords", [["TODO(t!)", "PROJ(p!)", "DOIN(g!)", "|", "DONE(d!)", "CANCELLED(c!)"]]),
            e8.setVariable("org-log-into-drawer", true), e8.setVariable("org-log-done", "time"),
            e8.setVariable("org-treat-insert-todo-heading-as-state-change", true), e8.setVariable("e8--today", "2026-11-04"), 1)"#,
    )
    .unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    (ed, s)
}

#[test]
fn todo_keys_pick_states_and_changes_are_logged_as_emacs_does() {
    // What Emacs 30 did with these settings, its clock at 12:00.
    let (mut ed, _s) = logging_org("* Task\nbody\n* Other\n");
    ed.press("C-f C-f C-c C-t t").unwrap();
    assert_eq!(text(&ed), "* TODO Task\n:LOGBOOK:\n- State \"TODO\"       from              [2026-11-04 Wed 12:00]\n:END:\nbody\n* Other\n");
    assert_eq!(ed.window_buffer().point(), 7);
    let choices = ed.buffers().iter().find(|b| b.name == " *Org todo*").map(|b| b.slice(0..b.len())).unwrap();
    assert_eq!(choices, "{   [t] TODO        [p] PROJ        [g] DOIN        [d] DONE        \n  [c] CANCELLED   }\n");
    assert_eq!(ed.window_list().len(), 1, "the choices go");
    ed.press("C-c C-t d").unwrap();
    assert_eq!(
        text(&ed),
        "* DONE Task\nCLOSED: [2026-11-04 Wed 12:00]\n:LOGBOOK:\n- State \"DONE\"       from \"TODO\"       [2026-11-04 Wed 12:00]\n- State \"TODO\"       from              [2026-11-04 Wed 12:00]\n:END:\nbody\n* Other\n"
    );
    ed.press("C-c C-t SPC").unwrap();
    assert_eq!(
        text(&ed),
        "* Task\n:LOGBOOK:\n- State \"DONE\"       from \"TODO\"       [2026-11-04 Wed 12:00]\n- State \"TODO\"       from              [2026-11-04 Wed 12:00]\n:END:\nbody\n* Other\n"
    );
    assert_eq!(ed.window_buffer().point(), 2);
    ed.press("S-<right>").unwrap();
    assert!(text(&ed).starts_with("* TODO Task\n:LOGBOOK:\n- State \"TODO\"       from              [2026-11-04 Wed 12:00]\n- State \"DONE\""), "{}", text(&ed));
    assert_eq!(ed.window_buffer().point(), 7);
}

#[test]
fn notes_go_at_the_top_of_an_existing_logbook_and_new_todo_headings_log() {
    let (mut ed, _s) = logging_org("* Task\n:PROPERTIES:\n:ID: x\n:END:\n:LOGBOOK:\n- State \"TODO\"       from              [2026-11-01 Sun 10:00]\n:END:\nbody\n");
    ed.press("C-f C-f C-c C-t g").unwrap();
    assert_eq!(
        text(&ed),
        "* DOIN Task\n:PROPERTIES:\n:ID: x\n:END:\n:LOGBOOK:\n- State \"DOIN\"       from              [2026-11-04 Wed 12:00]\n- State \"TODO\"       from              [2026-11-01 Sun 10:00]\n:END:\nbody\n"
    );
    let (mut ed, _s) = logging_org("* Task\nbody\n");
    ed.press("M-> M-S-<return>").unwrap();
    assert_eq!(text(&ed), "* Task\nbody\n* TODO \n:LOGBOOK:\n- State \"TODO\"       from              [2026-11-04 Wed 12:00]\n:END:");
    assert_eq!(ed.window_buffer().point(), 19);
}

#[test]
fn a_new_logbook_is_folded() {
    let (mut ed, _s) = logging_org("* Task\nbody\n");
    ed.press("C-f C-f C-c C-t t").unwrap();
    ed.redisplay();
    assert_eq!(&rows(&ed)[..3], ["* TODO Task", ":LOGBOOK:...", "body"]);
}

#[test]
fn keywords_and_tags_take_their_own_faces() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(
        &mut ed,
        r##"(e8.setVariable("org-todo-keyword-faces", [["TODO", [":foreground", "#b48ead", ":weight", "bold"]], ["DONE", "#8fbcbb"]]),
            e8.setVariable("org-tag-faces", [["novels", "#D08770"]]), 1)"##,
    )
    .unwrap();
    ed.window_buffer_mut().set_text("* TODO Task :novels:other:\n* DONE Old\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.redisplay();
    let rows = ed.window_rows(2, true);
    let seg = |row: usize, text: &str| rows[row].segments.iter().find(|s| s.text.contains(text)).unwrap_or_else(|| panic!("no {text}")).style.clone();
    let rgb = |c: Option<e8_core::Color>| c.map(|c| (c.r, c.g, c.b));
    let todo = seg(0, "TODO");
    assert_eq!(rgb(todo.foreground), Some((0xb4, 0x8e, 0xad)));
    assert!(todo.bold);
    assert_eq!(rgb(seg(0, "novels").foreground), Some((0xd0, 0x87, 0x70)));
    assert_ne!(rgb(seg(0, "other").foreground), Some((0xd0, 0x87, 0x70)));
    assert_eq!(rgb(seg(1, "DONE").foreground), Some((0x8f, 0xbc, 0xbb)));
}

#[test]
fn capture_files_into_date_trees_and_outline_paths_as_emacs_does() {
    // config.org's templates, and what Emacs 30 made of them with Title typed, its clock at 12:00.
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::write(dir.path().join("meetings.org"), "#+title: Meetings\n* 2026\n** 2026-W44\n*** 2026-10-28 Wednesday\n**** Old meeting\n").unwrap();
    std::fs::write(dir.path().join("people.org"), "* Inbox\n* Projects\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let d = dir.path().display().to_string();
    s.eval_expression(
        &mut ed,
        &format!(
            r#"(e8.setVariable("e8--today", "2026-11-04"), e8.setVariable("org-capture-templates", [
              ["m", "Meeting", "entry", ["file+olp+datetree", "{d}/meetings.org"], "* %?  :meeting:%^g \n:Created: %T\n** Attendees\n*** \n** Notes\n** Action Items\n***   ", ":tree-type", "week", ":empty-lines", 0],
              ["j", "Journal", "entry", ["file+olp+datetree", "{d}/journal.org"], "* %?\nEntered on %U\n  %i\n  %a"],
              ["p", "Person", "entry", ["file+olp", "{d}/people.org", "Inbox"], "* %?  :person: \n:Created: %T\nRun (C-c n h)", ":empty-lines", 0]]), 1)"#
        ),
    )
    .unwrap();
    ed.set_frame_size(80, 24);
    let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
    ed.press("M-x o r g - c a p t u r e RET m w o r k RET T i t l e C-c C-c").unwrap();
    assert_eq!(
        read("meetings.org"),
        "#+title: Meetings\n* 2026\n** 2026-W44\n*** 2026-10-28 Wednesday\n**** Old meeting\n** 2026-W45\n*** 2026-11-04 Wednesday\n**** Title                                                     :meeting:work: \n:Created: <2026-11-04 Wed 12:00>\n***** Attendees\n****** \n***** Notes\n***** Action Items\n******   \n"
    );
    ed.press("M-x o r g - c a p t u r e RET j T i t l e C-c C-c").unwrap();
    assert_eq!(read("journal.org"), "\n* 2026\n** 2026-11 November\n*** 2026-11-04 Wednesday\n**** Title\nEntered on [2026-11-04 Wed 12:00]\n");
    ed.press("M-x o r g - c a p t u r e RET p T i t l e C-c C-c").unwrap();
    assert_eq!(read("people.org"), "* Inbox\n** Title                                                             :person: \n:Created: <2026-11-04 Wed 12:00>\nRun (C-c n h)\n* Projects\n");
}

#[test]
fn clocks_go_into_the_logbook_as_emacs_puts_them() {
    // What Emacs 30 did, its clock stopped at 12:00.
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(&mut ed, r#"(e8.setVariable("e8--today", "2026-11-04"), 1)"#).unwrap();
    ed.window_buffer_mut().set_text("* TODO Task\nSCHEDULED: <2026-11-04 Wed>\nbody\n* Other\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_frame_size(80, 24);
    let entry = |clocks: &str| format!("* TODO Task\nSCHEDULED: <2026-11-04 Wed>\n:LOGBOOK:\n{clocks}:END:\nbody\n* Other\n");
    ed.press("C-f C-f C-f C-f C-f C-f C-f C-c C-x C-i").unwrap();
    assert_eq!(text(&ed), entry("CLOCK: [2026-11-04 Wed 12:00]\n"));
    assert_eq!(ed.window_buffer().point(), 7);
    assert_eq!(ed.echo(), Some("Clock starts at [2026-11-04 Wed 12:00] - "));
    let mode_line = s.eval_expression(&mut ed, r#"String(e8.variable("org-mode-line-string"))"#).unwrap();
    assert_eq!(mode_line.trim_matches('"'), "[0:00] (Task) ");
    ed.press("C-c C-x C-o").unwrap();
    let done = "CLOCK: [2026-11-04 Wed 12:00]--[2026-11-04 Wed 12:00] =>  0:00\n";
    assert_eq!(text(&ed), entry(done));
    assert_eq!(ed.echo(), Some("Clock stopped at [2026-11-04 Wed 12:00] after 0:00"));
    ed.press("C-c C-x C-i").unwrap();
    assert_eq!(text(&ed), entry(&format!("CLOCK: [2026-11-04 Wed 12:00]\n{done}")));
    ed.press("C-c C-x C-q").unwrap();
    assert_eq!(text(&ed), entry(done));
    // Done stops the clock, as org-clock-out-when-done says.
    ed.press("C-c C-x C-i C-c C-t").unwrap();
    assert_eq!(text(&ed), entry(&format!("{done}{done}")).replace("TODO", "DONE"));
}

#[test]
fn capture_clocks_in_and_resumes_the_clock_it_stopped() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::write(dir.path().join("tasks.org"), "* TODO Work\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let d = dir.path().display().to_string();
    s.eval_expression(
        &mut ed,
        &format!(
            r#"(e8.setVariable("e8--today", "2026-11-04"), e8.setVariable("org-capture-templates", [
              ["m", "Meeting", "entry", ["file", "{d}/meetings.org"], "* %?", ":clock-in", true, ":clock-resume", true]]), 1)"#
        ),
    )
    .unwrap();
    ed.set_frame_size(80, 24);
    ed.call("find-file", vec![Arg::Str(format!("{d}/tasks.org"))]).unwrap();
    ed.press("C-c C-x C-i").unwrap();
    ed.press("M-x o r g - c a p t u r e RET m T a l k").unwrap();
    let mode_line = s.eval_expression(&mut ed, r#"String(e8.variable("org-mode-line-string"))"#).unwrap();
    // The heading as it was when the clock started, before its title was typed, as Org takes it.
    assert_eq!(mode_line.trim_matches('"'), "[0:00] () ");
    ed.press("C-c C-c").unwrap();
    let meetings = std::fs::read_to_string(dir.path().join("meetings.org")).unwrap();
    assert_eq!(meetings, "* Talk\n:LOGBOOK:\nCLOCK: [2026-11-04 Wed 12:00]--[2026-11-04 Wed 12:00] =>  0:00\n:END:\n");
    let mode_line = s.eval_expression(&mut ed, r#"String(e8.variable("org-mode-line-string"))"#).unwrap();
    assert_eq!(mode_line.trim_matches('"'), "[0:00] (Work) ");
    assert_eq!(text(&ed), "* TODO Work\n:LOGBOOK:\nCLOCK: [2026-11-04 Wed 12:00]\nCLOCK: [2026-11-04 Wed 12:00]--[2026-11-04 Wed 12:00] =>  0:00\n:END:\n");
}

#[test]
fn org_blank_before_new_entry_nil_adds_no_blank_lines() {
    // Headings and items with blank lines between them: auto follows them, nil does not.
    let (mut ed, _s) = org("* One\n\n* Two\n\n- a\n\n- b\n");
    ed.press("M-< C-e M-RET x").unwrap();
    assert!(text(&ed).starts_with("* One\n\n* x\n"), "{}", text(&ed));
    let (mut ed, s) = org("* One\n\n* Two\n\n- a\n\n- b\n");
    s.eval_expression(&mut ed, r#"(e8.setVariable("org-blank-before-new-entry", [["heading", null], ["plain-list-item", null]]), 1)"#).unwrap();
    ed.press("M-< C-e M-RET x").unwrap();
    assert!(text(&ed).starts_with("* One\n* x\n"), "{}", text(&ed));
    ed.press("M-> C-p C-e M-RET y").unwrap();
    assert!(text(&ed).ends_with("- b\n- y\n"), "{}", text(&ed));
}

#[test]
fn use_short_answers_takes_y_for_yes() {
    let (mut ed, s) = org("x");
    s.eval_expression(&mut ed, r#"(e8.setVariable("use-short-answers", true), 1)"#).unwrap();
    let r = s.eval_expression(&mut ed, r#"(e8.unreadKeys(["y"]), String(e8.yesOrNoP("Really? ")))"#).unwrap();
    assert_eq!(r.trim_matches('"'), "true");
}

#[test]
fn org_agenda_window_setup_current_window_keeps_one_window() {
    let (mut ed, s) = org("");
    ed.set_frame_size(80, 24);
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("a.org");
    std::fs::write(&path, "* TODO Task\n").unwrap();
    s.eval_typescript(&mut ed, "files.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]); e8.setVariable(\"org-agenda-window-setup\", \"current-window\");", path.to_str().unwrap())).unwrap();
    s.eval_typescript(&mut ed, "week.ts", "e8.call(\"org-agenda-list\");".to_string()).unwrap();
    assert_eq!(ed.window_list().len(), 1);
    assert_eq!(ed.window_buffer().name, "*Org Agenda*");
}

#[test]
fn habits_show_today_with_their_graphs_as_emacs_draws_them() {
    let (mut ed, s) = org("");
    ed.set_frame_size(80, 24);
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("h.org");
    std::fs::write(
        &path,
        "* TODO Run\nSCHEDULED: <2026-11-03 Tue .+2d>\n:PROPERTIES:\n:STYLE:    habit\n:END:\n:LOGBOOK:\n- State \"DONE\"       from \"TODO\"       [2026-11-01 Sun 08:00]\n- State \"DONE\"       from \"TODO\"       [2026-10-28 Wed 08:00]\n- State \"DONE\"       from \"TODO\"       [2026-10-20 Tue 08:00]\n:END:\n* TODO Plain\nSCHEDULED: <2026-11-04 Wed>\n",
    )
    .unwrap();
    s.eval_typescript(&mut ed, "files.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]); e8.setVariable(\"e8--today\", \"2026-11-04\");", path.to_str().unwrap())).unwrap();
    s.eval_typescript(&mut ed, "week.ts", "e8.call(\"org-agenda-list\");".to_string()).unwrap();
    // What Emacs 30 shows on 4 November 2026, and the faces of its graph.
    let agenda = text(&ed);
    assert!(agenda.contains("Wednesday   4 November 2026\n  h:          Scheduled:  TODO Plain\n  h:          TODO Run                        *       *   *  !       \nThursday"), "{agenda}");
    let faces = s
        .eval_expression(&mut ed, r#"(() => { const l = e8.lineText(5).startsWith("  h:          TODO Run") ? 5 : 4; const b = e8.lineStart(l); return Array.from({ length: 28 }, (_, i) => String(e8.getTextProperty(b + 40 + i, "face")).replace("org-habit-", "").replace("-face", "")).join(" "); })()"#)
        .unwrap();
    assert_eq!(
        faces.trim_matches('"'),
        "clear-future clear-future clear-future clear-future clear-future clear-future clear clear-future alert-future overdue overdue overdue overdue overdue overdue clear-future alert-future overdue overdue clear-future alert-future overdue overdue-future overdue-future overdue-future overdue-future overdue-future overdue-future"
    );
}

#[test]
fn an_edit_fontifies_what_shows_not_the_folded_rest() {
    // Each edit used to fontify from it to the end of the buffer, through
    // folded subtrees; as in Emacs, only what shows is fontified.
    let body: String = (0..2_000).map(|i| format!("* Heading {i}\n*bold* text\n")).collect();
    let (mut ed, s) = org(&body);
    ed.press("S-TAB").unwrap();
    ed.redisplay();
    ed.press("C-e x").unwrap();
    ed.redisplay();
    let face = |ed: &mut Editor, line: usize| s.eval_expression(ed, &format!(r#"String(e8.getTextProperty(e8.lineStart({line}), "face"))"#)).unwrap();
    // The last body line, hidden, is not fontified yet; the first heading is.
    let face_at = |ed: &mut Editor, line: usize| s.eval_expression(ed, &format!(r#"String(e8.getTextProperty(e8.lineStart({line}) + 1, "face"))"#)).unwrap();
    assert_eq!(face_at(&mut ed, 3999).trim_matches('"'), "undefined");
    assert_eq!(face(&mut ed, 0).trim_matches('"'), "org-level-1");
    // Unfolded and shown, it is.
    ed.press("M-x o u t l i n e - s h o w - a l l RET M->").unwrap();
    ed.redisplay();
    assert_eq!(face_at(&mut ed, 3999).trim_matches('"'), "bold");
}

#[test]
fn fast_tag_selection_keeps_one_tag_of_a_group_as_emacs_does() {
    // An org-tag-alist with a group, and what Emacs 30 did with n e RET.
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(
        &mut ed,
        r#"(e8.setVariable("org-tag-alist", [[":startgroup"], ["contracting", "c"], ["novels", "n"], ["private", "p"], [":endgroup"], ["other", "o"], ["emacs", "e"]]), 1)"#,
    )
    .unwrap();
    ed.window_buffer_mut().set_text("* Parent :work:\n** Task :private:\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_frame_size(80, 24);
    ed.press("C-n C-f C-f C-f C-c C-q n e RET").unwrap();
    assert_eq!(text(&ed), "* Parent :work:\n** Task                                                        :novels:emacs:\n");
    let menu = ed.buffers().iter().find(|b| b.name == " *Org tags*").map(|b| b.slice(0..b.len())).unwrap();
    assert_eq!(menu, "Inherited:  work\nCurrent:    novels emacs\n\n{ [c] contracting   [n] novels        [p] private       }\n  [o] other         [e] emacs         \n");
    assert_eq!(ed.window_list().len(), 1);
}

#[test]
fn exiting_with_a_clock_running_offers_to_stop_it() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("work.org");
    std::fs::write(&path, "* Task\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(&mut ed, r#"(e8.setVariable("e8--today", "2026-11-04"), 1)"#).unwrap();
    ed.set_frame_size(80, 24);
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    ed.press("C-c C-x C-i C-x C-s").unwrap();
    ed.press("C-x C-c y e s RET").unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "* Task\n:LOGBOOK:\nCLOCK: [2026-11-04 Wed 12:00]--[2026-11-04 Wed 12:00] =>  0:00\n:END:\n"
    );
}

#[test]
fn the_agenda_clocks_in_on_the_entry_of_its_line() {
    let (mut ed, s) = org("");
    ed.set_frame_size(80, 24);
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("a.org");
    std::fs::write(&path, "* TODO Task\nSCHEDULED: <2026-11-04 Wed>\n").unwrap();
    s.eval_typescript(&mut ed, "files.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]); e8.setVariable(\"e8--today\", \"2026-11-04\");", path.to_str().unwrap())).unwrap();
    s.eval_typescript(&mut ed, "week.ts", "e8.call(\"org-agenda-list\");".to_string()).unwrap();
    ed.press("M-< C-s T a s k RET I").unwrap();
    let file = ed.buffers().iter().find(|b| b.name == "a.org").map(|b| b.slice(0..b.len())).unwrap();
    assert_eq!(file, "* TODO Task\nSCHEDULED: <2026-11-04 Wed>\n:LOGBOOK:\nCLOCK: [2026-11-04 Wed 12:00]\n:END:\n");
    ed.press("O").unwrap();
    let file = ed.buffers().iter().find(|b| b.name == "a.org").map(|b| b.slice(0..b.len())).unwrap();
    assert!(file.contains("=>  0:00"), "{file}");
}

#[test]
fn agenda_lines_show_inherited_and_file_tags_as_emacs_does() {
    let (mut ed, s) = org("");
    ed.set_frame_size(80, 24);
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("f.org");
    std::fs::write(&path, "#+FILETAGS: :proj:\n* Parent :work:\n** TODO Child :home:\nSCHEDULED: <2026-11-04 Wed>\n* TODO Plain\nSCHEDULED: <2026-11-04 Wed>\n").unwrap();
    s.eval_typescript(&mut ed, "files.ts", format!("e8.setVariable(\"org-agenda-files\", [{:?}]); e8.setVariable(\"e8--today\", \"2026-11-04\");", path.to_str().unwrap())).unwrap();
    s.eval_typescript(&mut ed, "week.ts", "e8.call(\"org-agenda-list\");".to_string()).unwrap();
    // As Emacs 30 shows them.
    let agenda = text(&ed);
    assert!(agenda.contains("  f:          Scheduled:  TODO Child                          :proj:work::home:\n  f:          Scheduled:  TODO Plain                                    :proj::\n"), "{agenda}");
}
