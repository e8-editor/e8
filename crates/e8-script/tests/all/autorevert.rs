//! Auto-Revert, after Emacs's autorevert.el, and revert-buffer, after
//! files.el: reverting on a timer and on notifications, Tail mode, Global
//! Auto-Revert with Dired, and revert-buffer's arguments.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

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

fn eval(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

/// Changes a file behind the editor's back, its time a little later, so it
/// differs however fine the clock.
fn change_on_disk(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    let later = SystemTime::now() + Duration::from_secs(5);
    fs::File::options().write(true).open(path).unwrap().set_modified(later).unwrap();
}

/// Runs timers and takes notifications in, without the clock moving, until
/// `done` or two seconds.
fn until(ed: &mut Editor, done: impl Fn(&Editor) -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(2) {
        ed.run_timers();
        if done(ed) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Emacs 30: with auto-revert-use-notify nil, a buffer in auto-revert-mode
/// reverts at the next check, auto-revert-interval seconds on, saying
/// "Reverting buffer ‘log.txt’", and point at the end stays at the end.
#[test]
fn a_buffer_is_checked_every_interval() {
    let (mut ed, s) = setup();
    let dir = dir();
    let path = dir.path().join("log.txt");
    fs::write(&path, "one\n").unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("auto-revert-use-notify", false);"#);
    visit(&mut ed, &path);
    ed.call("auto-revert-mode", vec![]).unwrap();
    ed.press("M->").unwrap();
    change_on_disk(&path, "one\ntwo\n");
    ed.advance_clock(Duration::from_secs(2));
    assert_eq!(text(&ed), "one\n", "not checked before the interval");
    ed.advance_clock(Duration::from_secs(4));
    assert_eq!(text(&ed), "one\ntwo\n");
    assert_eq!(ed.echo(), Some("Reverting buffer \u{2018}log.txt\u{2019}"));
    assert_eq!(ed.window_buffer().point(), ed.window_buffer().len(), "point at the end stays there");
    // Turned off, it is checked no more.
    eval(&mut ed, &s, r#"e8.callWithPrefix(-1, "auto-revert-mode");"#);
    change_on_disk(&path, "changed\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "one\ntwo\n");
    assert_eq!(value(&mut ed, &s, r#"String(e8.variable("auto-revert-buffer-list").length)"#), "0");
}

/// With notifications, as kqueue gives them on macOS, a change reverts the
/// buffer at once, long before the interval.
#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
#[test]
fn a_notification_reverts_at_once() {
    let (mut ed, s) = setup();
    let dir = dir();
    let path = dir.path().join("watched.txt");
    fs::write(&path, "before\n").unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("auto-revert-interval", 1000); e8.setVariable("auto-revert-avoid-polling", true);"#);
    visit(&mut ed, &path);
    ed.call("auto-revert-mode", vec![]).unwrap();
    assert_eq!(value(&mut ed, &s, r#"typeof e8.variable("auto-revert-notify-watch-descriptor")"#), "number");
    change_on_disk(&path, "after\n");
    assert!(until(&mut ed, |ed| text(ed) == "after\n"), "{:?}", text(&ed));
}

/// Emacs 30: auto-revert-tail-mode appends what the file grew by, leaving
/// the buffer's own text, and shows " Tail".
#[test]
fn tail_mode_follows_a_growing_file() {
    let (mut ed, s) = setup();
    let dir = dir();
    let path = dir.path().join("grow.log");
    fs::write(&path, "a\n").unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("auto-revert-use-notify", false);"#);
    visit(&mut ed, &path);
    ed.call("auto-revert-tail-mode", vec![]).unwrap();
    assert_eq!(value(&mut ed, &s, r#"String(e8.variable("auto-revert-tail-mode"))"#), "true");
    assert_eq!(value(&mut ed, &s, r#"String(e8.variable("auto-revert-mode"))"#), "false");
    change_on_disk(&path, "a\nb\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "a\nb\n");
    assert!(!ed.window_buffer().is_modified());
    change_on_disk(&path, "a\nb\nc\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "a\nb\nc\n");
}

/// Emacs 30: global-auto-revert-mode reverts every file buffer, and a Dired
/// buffer only with global-auto-revert-non-file-buffers, when a file is
/// added to its directory.
#[test]
fn global_mode_reverts_files_and_dired_when_asked() {
    let (mut ed, s) = setup();
    let dir = dir();
    let path = dir.path().join("a.txt");
    fs::write(&path, "first\n").unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("auto-revert-use-notify", false);"#);
    visit(&mut ed, &path);
    ed.call("global-auto-revert-mode", vec![]).unwrap();
    change_on_disk(&path, "second\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "second\n");

    ed.call("dired", vec![Arg::Str(dir.path().display().to_string())]).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(dir.path().join("new.txt"), "").unwrap();
    ed.advance_clock(Duration::from_secs(6));
    assert!(!text(&ed).contains("new.txt"), "a Dired buffer is left alone by default");
    eval(&mut ed, &s, r#"e8.setVariable("global-auto-revert-non-file-buffers", true); e8.call("global-auto-revert-mode"); e8.call("global-auto-revert-mode");"#);
    ed.advance_clock(Duration::from_secs(6));
    assert!(text(&ed).contains("new.txt"), "{}", text(&ed));
}

/// Emacs 30: revert-buffer calls revert-buffer-function with IGNORE-AUTO and
/// NOCONFIRM, revert-buffer-in-progress-p bound meanwhile; a read-only state
/// read-only-mode chose survives reverting; PRESERVE-MODES keeps the major
/// mode set by hand.
#[test]
fn revert_buffer_takes_emacs_arguments() {
    let (mut ed, s) = setup();
    let dir = dir();
    let path = dir.path().join("r.txt");
    fs::write(&path, "text\n").unwrap();
    visit(&mut ed, &path);
    eval(
        &mut ed,
        &s,
        r#"globalThis.seen = [];
        e8.makeLocalVariable("revert-buffer-function");
        e8.setVariable("revert-buffer-function", (ignoreAuto: unknown, noconfirm: unknown) => { seen.push([ignoreAuto, noconfirm, e8.variable("revert-buffer-in-progress-p")]); return "done"; });"#,
    );
    assert_eq!(value(&mut ed, &s, r#"String(e8.call("revert-buffer") ?? "")"#), "");
    assert_eq!(value(&mut ed, &s, "JSON.stringify(seen)"), "[[true,false,true]]");
    eval(&mut ed, &s, r#"e8.killLocalVariable("revert-buffer-function");"#);

    ed.call("read-only-mode", vec![]).unwrap();
    change_on_disk(&path, "new\n");
    eval(&mut ed, &s, r#"e8.call("revert-buffer-quick");"#);
    assert_eq!(text(&ed), "new\n");
    assert_eq!(value(&mut ed, &s, "String(e8.bufferReadOnly())"), "true", "read-only-mode's choice is kept");

    // A .txt file's mode is text-mode; one chosen by hand is kept.
    assert_eq!(value(&mut ed, &s, r#"e8.variable("major-mode")"#), "text-mode");
    eval(&mut ed, &s, r#"e8.call("read-only-mode"); e8.call("fundamental-mode");"#);
    change_on_disk(&path, "newer\n");
    ed.call("auto-revert-mode", vec![]).unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("auto-revert-use-notify", false);"#);
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "newer\n");
    assert_eq!(value(&mut ed, &s, r#"e8.variable("major-mode")"#), "fundamental-mode", "auto-revert keeps the modes");
}



/// Emacs 30: a revert by hand runs find-file-hook after normal-mode, so Tail
/// mode's position is the file's size again and Global Auto-Revert still
/// looks after the buffer; Tail mode appends without making a lock file, as
/// Emacs binds buffer-file-name to nil meanwhile.
#[test]
fn reverting_by_hand_keeps_tail_and_global_modes_going() {
    let (mut ed, s) = setup();
    let dir = dir();
    let path = dir.path().join("t.log");
    fs::write(&path, "a\n").unwrap();
    eval(&mut ed, &s, r#"e8.setVariable("auto-revert-use-notify", false);"#);
    visit(&mut ed, &path);
    ed.call("auto-revert-tail-mode", vec![]).unwrap();
    change_on_disk(&path, "a\nb\n");
    eval(&mut ed, &s, r#"e8.call("revert-buffer-quick");"#);
    assert_eq!(text(&ed), "a\nb\n");
    assert_eq!(value(&mut ed, &s, r#"String(e8.variable("auto-revert-tail-pos"))"#), "4");
    change_on_disk(&path, "a\nb\nc\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "a\nb\nc\n", "nothing appended twice");
    assert!(fs::symlink_metadata(dir.path().join(".#t.log")).is_err(), "no lock file left");

    let other = dir.path().join("g.txt");
    fs::write(&other, "one\n").unwrap();
    visit(&mut ed, &other);
    ed.call("global-auto-revert-mode", vec![]).unwrap();
    eval(&mut ed, &s, r#"e8.call("revert-buffer-quick");"#);
    assert_eq!(value(&mut ed, &s, r#"String(e8.variable("auto-revert--global-mode"))"#), "true");
    change_on_disk(&other, "two\n");
    ed.advance_clock(Duration::from_secs(6));
    assert_eq!(text(&ed), "two\n");
}
