//! Files: saving with backups, codings, files changed on disk, reverting,
//! auto-saving and recovering, and quitting or killing with unsaved changes.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::driven::Driven;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

/// Visits a file on a driven editor, whose questions wait for their answers.
fn visit_driven(d: &Driven, path: &Path) {
    let path = path.display().to_string();
    d.with(move |ed| ed.call("find-file", vec![Arg::Str(path)]).unwrap());
}

/// Answers the open question on a driven editor.
fn answer_driven(d: &Driven, keys: &str) {
    assert!(d.prompt().is_some(), "a question is open");
    d.press(keys);
}

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// A directory outside the temporary one, where Emacs makes backups.
fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn visit(ed: &mut Editor, path: &Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

/// Changes a file behind the editor's back, a little later than now, so
/// its modification time differs however fine the clock.
fn change_on_disk(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    let later = SystemTime::now() + Duration::from_secs(5);
    fs::File::options().write(true).open(path).unwrap().set_modified(later).unwrap();
}

#[test]
fn find_file_edit_and_save() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("notes.txt");
    fs::write(&path, "first line\n").unwrap();
    ed.press("C-x C-f").unwrap();
    // The prompt starts in the default directory; typing an absolute path
    // after it starts over from the root, as in Emacs.
    assert!(ed.minibuffer_input().ends_with('/'));
    ed.type_text(&format!("/{}", path.display()));
    ed.press("RET").unwrap();
    assert_eq!(ed.window_buffer().name, "notes.txt");
    ed.press("M->").unwrap();
    ed.type_text("second line\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(ed.echo(), Some(format!("Wrote {}", path.display()).as_str()));
    assert_eq!(fs::read_to_string(&path).unwrap(), "first line\nsecond line\n");
    assert!(!ed.window_buffer().is_modified());
    ed.press("C-x C-s").unwrap();
    assert_eq!(ed.echo(), Some("(No changes need to be saved)"));
}

#[test]
fn a_new_file_is_created_on_save() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("new.org");
    visit(&mut ed, &path);
    assert_eq!(ed.echo(), Some("(New file)"));
    ed.type_text("* Heading\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "* Heading\n");
    assert!(!dir.path().join("new.org~").exists(), "nothing to back up");
}

#[test]
fn the_first_save_keeps_a_backup() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "original\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    visit(&mut ed, &path);
    ed.type_text("one ");
    ed.press("C-x C-s").unwrap();
    ed.type_text("two ");
    ed.press("C-x C-s").unwrap();
    let backup = dir.path().join("a.txt~");
    assert_eq!(fs::read_to_string(&backup).unwrap(), "original\n", "only the first save backs up");
    assert_eq!(fs::read_to_string(&path).unwrap(), "one two original\n");
    // The new file was written in place of the renamed one, with its permissions.
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn hard_links_are_backed_up_by_copying() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("linked.txt");
    let link = dir.path().join("other-name.txt");
    fs::write(&path, "shared\n").unwrap();
    fs::hard_link(&path, &link).unwrap();
    visit(&mut ed, &path);
    ed.type_text("more ");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&link).unwrap(), "more shared\n", "the link still shares the file");
    assert_eq!(fs::read_to_string(dir.path().join("linked.txt~")).unwrap(), "shared\n");
}

#[test]
fn files_in_the_temporary_directory_are_not_backed_up() {
    let (mut ed, _s) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scratch.txt");
    fs::write(&path, "x\n").unwrap();
    visit(&mut ed, &path);
    ed.type_text("y");
    ed.press("C-x C-s").unwrap();
    assert!(!dir.path().join("scratch.txt~").exists());
}

#[test]
fn line_ends_and_charsets_are_kept() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let dos = dir.path().join("dos.txt");
    fs::write(&dos, "one\r\ntwo\r\n").unwrap();
    visit(&mut ed, &dos);
    assert_eq!(text(&ed), "one\ntwo\n");
    assert_eq!(ed.variable("buffer-file-coding-system"), Some(e8_core::Value::Str("undecided-dos".into())));
    assert_eq!(ed.window_buffer().coding_mnemonic(), "-\\");
    ed.press("M-> t h r e e RET C-x C-s").unwrap();
    assert_eq!(fs::read(&dos).unwrap(), b"one\r\ntwo\r\nthree\r\n");

    let latin = dir.path().join("latin.txt");
    fs::write(&latin, b"caf\xe9\n").unwrap();
    visit(&mut ed, &latin);
    assert_eq!(text(&ed), "café\n");
    assert_eq!(ed.window_buffer().coding_mnemonic(), "1:");
    ed.press("M->").unwrap();
    ed.type_text("été\n");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read(&latin).unwrap(), b"caf\xe9\n\xe9t\xe9\n");

    // A coding chosen by name, keeping the line ends unless it says otherwise.
    let plain = dir.path().join("plain.txt");
    fs::write(&plain, "a\nb\n").unwrap();
    visit(&mut ed, &plain);
    ed.call("set-buffer-file-coding-system", vec![Arg::Str("utf-8-dos".into())]).unwrap();
    assert!(ed.window_buffer().is_modified());
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read(&plain).unwrap(), b"a\r\nb\r\n");
    let failed = ed.call("set-buffer-file-coding-system", vec![Arg::Str("klingon".into())]);
    assert_eq!(failed.unwrap_err().to_string(), "Invalid coding system: klingon");
}

#[test]
fn text_files_get_a_final_newline() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let prose = dir.path().join("prose.txt");
    visit(&mut ed, &prose);
    ed.type_text("no newline");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&prose).unwrap(), "no newline\n");
    // Fundamental mode leaves the end alone, as require-final-newline is off.
    let data = dir.path().join("data");
    visit(&mut ed, &data);
    ed.type_text("raw");
    ed.press("C-x C-s").unwrap();
    assert_eq!(fs::read_to_string(&data).unwrap(), "raw");
}

#[test]
fn saving_over_a_file_changed_on_disk_asks_first() {
    let d = Driven::new("");
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "mine\n").unwrap();
    visit_driven(&d, &path);
    d.type_text("edited ");
    change_on_disk(&path, "theirs\n");
    d.press("C-x C-s");
    assert_eq!(d.prompt().as_deref(), Some("a.txt has changed since visited or saved.  Save anyway? (yes or no) "));
    d.type_text("no\n");
    assert_eq!(d.message().as_deref(), Some("Save not confirmed"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "theirs\n");
    d.press("C-x C-s");
    d.type_text("maybe\n");
    assert_eq!(d.message().as_deref(), Some("Please answer yes or no."));
    d.type_text("yes\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited mine\n");
}

#[test]
fn editing_a_buffer_whose_file_changed_asks_first() {
    let d = Driven::new("");
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "mine\n").unwrap();
    visit_driven(&d, &path);
    change_on_disk(&path, "theirs\n");
    d.type_text("x");
    assert_eq!(d.prompt().as_deref(), Some("a.txt changed on disk; really edit the buffer? (y, n, r or C-h) "));
    assert!(d.with(|ed| ed.prompt_reads_char()));
    answer_driven(&d, "n");
    assert_eq!(d.message(), Some(format!("File changed on disk: {}", e8_core::abbreviate_path(&path))));
    assert_eq!(d.text(), "mine\n", "the edit was not made");
    // Keys other than the answers ask again.
    d.type_text("x");
    answer_driven(&d, "z");
    assert!(d.prompt().is_some());
    answer_driven(&d, "y");
    assert_eq!(d.text(), "xmine\n", "the edit was made after all");
    assert_eq!(d.message().as_deref(), Some("File on disk now will become a backup file if you save these changes."));
    // Once modified, further edits go ahead.
    d.type_text("y");
    assert_eq!(d.text(), "xymine\n");
    assert!(d.prompt().is_none());
}

#[test]
fn r_reverts_a_buffer_whose_file_changed() {
    let d = Driven::new("");
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "mine\n").unwrap();
    visit_driven(&d, &path);
    change_on_disk(&path, "theirs\n");
    d.type_text("x");
    answer_driven(&d, "r");
    assert_eq!(d.text(), "theirs\n");
    assert_eq!(d.message(), Some(format!("File reverted: {}", e8_core::abbreviate_path(&path))));
    // A file changed to the same text is no threat.
    change_on_disk(&path, "theirs\n");
    d.type_text("y");
    assert_eq!(d.text(), "ytheirs\n");
}

#[test]
fn reverting_keeps_point_where_it_can() {
    let d = Driven::new("");
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "one\ntwo\nthree\n").unwrap();
    visit_driven(&d, &path);
    d.with(|ed| ed.window_buffer_mut().set_point(10));
    change_on_disk(&path, "one\nTWO\nthree\nfour\n");
    d.press("C-x x g");
    assert_eq!(d.message().as_deref(), Some("Reverted buffer"));
    assert_eq!(d.text(), "one\nTWO\nthree\nfour\n");
    // Emacs's proportional place in what changed.
    assert_eq!(d.point(), 13);
    assert!(!d.with(|ed| ed.window_buffer().is_modified()));
    // A modified buffer asks first.
    d.type_text("!");
    d.press("C-x x g");
    assert_eq!(d.prompt(), Some(format!("Discard edits and reread from {}? (yes or no) ", path.display())));
    d.type_text("yes\n");
    assert_eq!(d.text(), "one\nTWO\nthree\nfour\n");
    // And reverting can be undone.
    d.press("C-/");
    assert_eq!(d.text(), "one\nTWO\nthree!\nfour\n");
}

#[test]
fn buffers_auto_save_after_keys_or_idle_time() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    let auto = dir.path().join("#a.txt#");
    fs::write(&path, "saved\n").unwrap();
    visit(&mut ed, &path);
    // Not more often than every 20 keys, whatever auto-save-interval says.
    ed.set_variable("auto-save-interval", e8_core::Value::Number(5.0));
    ed.type_text("abcdefghijklmnopqrst");
    assert!(!auto.exists());
    ed.type_text("e");
    assert_eq!(fs::read_to_string(&auto).unwrap(), "abcdefghijklmnopqrstesaved\n");
    assert_eq!(ed.echo(), Some("Auto-saving...done"));
    // And after auto-save-timeout seconds idle.
    ed.type_text("f");
    ed.advance_clock(Duration::from_secs(29));
    assert_eq!(fs::read_to_string(&auto).unwrap(), "abcdefghijklmnopqrstesaved\n");
    ed.advance_clock(Duration::from_secs(2));
    assert_eq!(fs::read_to_string(&auto).unwrap(), "abcdefghijklmnopqrstefsaved\n");
    // Saving deletes the auto-save file.
    ed.press("C-x C-s").unwrap();
    assert!(!auto.exists());
}

#[test]
fn an_auto_save_file_can_be_recovered() {
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "saved\n").unwrap();
    {
        // A session that auto-saved and then went away.
        let (mut ed, _s) = setup();
        visit(&mut ed, &path);
        ed.type_text("lost work ");
        ed.call("do-auto-save", vec![]).unwrap();
    }
    let d = Driven::new("");
    visit_driven(&d, &path);
    assert_eq!(d.message().as_deref(), Some("a.txt has auto save data; consider M-x recover-this-file"));
    d.start(|ed| {
        let _ = ed.call("recover-this-file", vec![]);
    });
    let auto = dir.path().join("#a.txt#");
    assert_eq!(d.prompt(), Some(format!("Recover auto save file {}? (yes, no, diff) ", auto.display())));
    d.type_text("yes\n");
    assert_eq!(d.text(), "lost work saved\n");
    assert!(d.with(|ed| ed.window_buffer().is_modified()));
    d.press("C-x C-s");
    assert!(!auto.exists());
    let failed = d.with(|ed| ed.call("recover-this-file", vec![]).map_err(|e| e.to_string()));
    assert_eq!(failed.unwrap_err(), format!("Auto save file {} does not exist", e8_core::abbreviate_path(&auto)));
}

#[test]
fn killing_a_modified_buffer_asks() {
    let d = Driven::new("");
    let dir = dir();
    let path = dir.path().join("a.txt");
    visit_driven(&d, &path);
    d.type_text("unsaved");
    d.press("C-x k RET");
    assert_eq!(d.prompt().as_deref(), Some("Buffer a.txt modified; kill anyway? (yes, no, save and then kill) "));
    d.type_text("no\n");
    assert_eq!(d.buffer_name(), "a.txt");
    d.press("C-x k RET");
    d.type_text("save and then kill\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), "unsaved\n");
    assert!(d.with(|ed| ed.find_buffer("a.txt").is_none()));
    visit_driven(&d, &path);
    d.type_text("more ");
    d.press("C-x k RET");
    d.type_text("yes\n");
    assert!(d.with(|ed| ed.find_buffer("a.txt").is_none()));
    assert_eq!(fs::read_to_string(&path).unwrap(), "unsaved\n");
    // Code does not kill unsaved work.
    visit_driven(&d, &path);
    d.type_text("x");
    assert!(d.with(|ed| ed.call("kill-buffer", vec![Arg::Str("a.txt".into())]).is_err()));
}

#[test]
fn quitting_offers_to_save_each_file() {
    let d = Driven::new("");
    let dir = dir();
    let (a, b) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    visit_driven(&d, &a);
    d.type_text("A");
    visit_driven(&d, &b);
    d.type_text("B");
    d.press("C-x C-c");
    // The buffer list's order, most recently selected first, as Emacs asks.
    assert_eq!(d.prompt(), Some(format!("Save file {}? (y, n, !, ., q, C-r, C-f, d or C-h) ", b.display())));
    answer_driven(&d, "n");
    answer_driven(&d, "y");
    assert_eq!(fs::read_to_string(&a).unwrap(), "A\n");
    assert!(!b.exists());
    assert_eq!(d.prompt().as_deref(), Some("Modified buffers exist; exit anyway? (yes or no) "));
    d.type_text("no\n");
    assert!(!d.with(|ed| ed.should_quit()));
    d.press("C-x C-c");
    // The answer ends the editor's loop, which says so as it stops.
    d.0.run(|ed| {
        let _ = ed.press("!");
    });
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !d.0.published().exit {
        assert!(std::time::Instant::now() < until, "the editor exits");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_to_string(&b).unwrap(), "B\n");
}

#[test]
fn save_some_buffers_saves_as_told() {
    let d = Driven::new("");
    let dir = dir();
    let files: Vec<PathBuf> = ["a.txt", "b.txt", "c.txt"].iter().map(|n| dir.path().join(n)).collect();
    for f in &files {
        visit_driven(&d, f);
        d.type_text("x");
    }
    d.press("C-x s");
    answer_driven(&d, "n");
    answer_driven(&d, ".");
    assert!(d.prompt().is_none());
    assert_eq!(files.iter().map(|f| f.exists()).collect::<Vec<_>>(), [false, true, false]);
    d.press("C-u C-x s");
    assert!(files.iter().all(|f| f.exists()));
    d.press("C-x s");
    assert_eq!(d.message().as_deref(), Some("(No files need saving)"));
}

#[test]
fn write_file_visits_the_new_file_and_asks_before_overwriting() {
    let d = Driven::new("");
    let dir = dir();
    let (a, b) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    fs::write(&b, "existing\n").unwrap();
    visit_driven(&d, &a);
    d.type_text("text");
    d.press("C-x C-w");
    d.press("C-a C-k");
    d.type_text(&format!("{}\n", b.display()));
    assert_eq!(d.prompt(), Some(format!("File \u{2018}{}\u{2019} exists; overwrite? (y or n) ", b.display())));
    answer_driven(&d, "y");
    assert_eq!(fs::read_to_string(&b).unwrap(), "text\n");
    assert_eq!(d.buffer_name(), "b.txt");
    assert!(!a.exists());
}

#[test]
fn auto_revert_mode_follows_the_file() {
    let (mut ed, _s) = setup();
    let dir = dir();
    let path = dir.path().join("log.txt");
    fs::write(&path, "line 1\n").unwrap();
    visit(&mut ed, &path);
    ed.call("auto-revert-mode", vec![]).unwrap();
    change_on_disk(&path, "line 1\nline 2\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "line 1\nline 2\n");
    assert_eq!(ed.echo(), Some("Reverting buffer \u{2018}log.txt\u{2019}"));
    // A buffer with unsaved changes is left alone.
    ed.type_text("mine ");
    change_on_disk(&path, "line 1\nline 2\nline 3\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "mine line 1\nline 2\n");
}

#[test]
fn scripts_can_ask_and_set_timers() {
    let d = Driven::new(
        r#"
        e8.defineCommand({ name: "ask-me", run: () => e8.insert(e8.yOrNP("Really? ") ? "yes" : "no") });
        e8.runWithTimer(2, null, () => e8.insert("[timer]"));
        e8.runWithIdleTimer(5, true, () => e8.insert("[idle]"));
        "#,
    );
    // Show Paren mode's idle timer would come first.
    d.with(|ed| ed.call_with_prefix("show-paren-mode", vec![], Some(e8_core::PrefixArg::Number(-1))).unwrap());
    d.mx("ask-me");
    assert_eq!(d.prompt().as_deref(), Some("Really? (y or n) "));
    answer_driven(&d, "q");
    assert_eq!(d.prompt().as_deref(), Some("Please answer y or n.  Really? (y or n) "));
    answer_driven(&d, "y");
    assert_eq!(d.text(), "yes");
    assert_eq!(d.with(|ed| ed.next_timer_in().map(|t| t.as_secs_f64().round())), Some(2.0));
    let advance = |secs: u64| {
        d.with(move |ed| ed.advance_clock(Duration::from_secs(secs)));
        d.0.settle();
    };
    advance(3);
    assert_eq!(d.text(), "yes[timer]");
    advance(3);
    assert_eq!(d.text(), "yes[timer][idle]");
    // An idle timer runs once in each idle spell.
    advance(10);
    assert_eq!(d.text(), "yes[timer][idle]");
    d.press("C-e");
    advance(6);
    assert_eq!(d.text(), "yes[timer][idle][idle]");
    // C-g quits a question.
    d.mx("ask-me");
    d.press("C-g");
    assert!(d.prompt().is_none());
}

#[test]
fn expand_file_name_keeps_a_directory_name_s_slash() {
    let (mut ed, s) = setup();
    let value = s
        .eval_expression(
            &mut ed,
            r#"[e8.expandFileName("foo/", "/tmp/"), e8.expandFileName("foo", "/tmp/"), e8.expandFileName("/tmp/"), e8.expandFileName("./", "/tmp/"), e8.expandFileName(".", "/tmp/")]"#,
        )
        .unwrap();
    assert_eq!(value, r#"["/tmp/foo/","/tmp/foo","/tmp/","/tmp/","/tmp"]"#);
}
