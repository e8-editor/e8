//! desktop-save-mode: the buffers, their places, some globals and the
//! windows saved to a file and read back in a later session.

use std::fs;

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn setup(config: &std::path::Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.display())));
    ed.set_frame_size(80, 23);
    (ed, scripting)
}

fn visit(ed: &mut Editor, path: &std::path::Path) {
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
}

/// Each window's buffer and point, in cyclic order.
fn windows(ed: &Editor) -> Vec<(String, usize)> {
    ed.windows().iter().map(|w| (w.buffer.name.clone(), w.point)).collect()
}

#[test]
fn a_saved_desktop_comes_back_in_the_next_session() {
    let config = dir();
    let files = dir();
    let (a, b) = (files.path().join("a.txt"), files.path().join("b.org"));
    fs::write(&a, "one\ntwo\nthree\n").unwrap();
    fs::write(&b, "* Heading\ntext\n").unwrap();
    {
        let (mut ed, _s) = setup(config.path());
        visit(&mut ed, &b);
        ed.press("C-n C-e").unwrap();
        ed.press("C-x 2").unwrap();
        visit(&mut ed, &a);
        ed.press("C-n C-n").unwrap();
        ed.set_variable("file-name-history", Value::List(vec![Value::Str("~/x".into())]));
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
        // Saving claims the desktop for this E8.
        let lock = fs::read_to_string(config.path().join(".e8.desktop.lock")).unwrap();
        assert_eq!(lock, std::process::id().to_string());
    }
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    // C-x 2 kept the top window selected, which then visited a.txt.
    assert_eq!(windows(&ed), [("a.txt".into(), 8), ("b.org".into(), 14)]);
    assert_eq!(ed.window_buffer().name, "a.txt", "the window selected then is selected");
    assert_eq!(ed.variable("file-name-history"), Some(Value::List(vec![Value::Str("~/x".into())])));
    ed.call("switch-to-buffer", vec![Arg::Str("b.org".into())]).unwrap();
    assert_eq!(ed.variable("major-mode"), Some(Value::Str("org-mode".into())));
    assert!(ed.echo().is_some_and(|m| m.starts_with("Desktop: 1 frame, 2 buffers restored")), "{:?}", ed.echo());
}

#[test]
fn quitting_saves_a_desktop_that_was_read_and_releases_it() {
    let config = dir();
    let files = dir();
    let a = files.path().join("a.txt");
    fs::write(&a, "one\n").unwrap();
    {
        let (mut ed, _s) = setup(config.path());
        visit(&mut ed, &a);
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    ed.press("M->").unwrap();
    ed.type_text("more");
    ed.run_hooks("kill-emacs-hook").unwrap();
    let saved = fs::read_to_string(config.path().join(".e8.desktop")).unwrap();
    assert!(saved.contains("\"point\": 8"), "{saved}");
    assert!(!config.path().join(".e8.desktop.lock").exists(), "quitting released the lock");
}

#[test]
fn a_desktop_another_e8_holds_is_not_loaded_without_asking() {
    let config = dir();
    let files = dir();
    let a = files.path().join("a.txt");
    fs::write(&a, "one\n").unwrap();
    {
        let (mut ed, _s) = setup(config.path());
        visit(&mut ed, &a);
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    // Held by a process that is running: this test's parent.
    fs::write(config.path().join(".e8.desktop.lock"), std::os::unix::process::parent_id().to_string()).unwrap();
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-load-locked-desktop", Value::Bool(false));
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    assert_eq!(ed.echo(), Some("Desktop file in use; not loaded."));
    assert!(ed.windows().iter().all(|w| w.buffer.name != "a.txt"));
    // check-pid loads it once that process is gone.
    fs::write(config.path().join(".e8.desktop.lock"), "999999").unwrap();
    ed.set_variable("desktop-load-locked-desktop", Value::Str("check-pid".into()));
    ed.call("desktop-read", vec![Arg::Prefix(None)]).unwrap();
    assert!(ed.windows().iter().any(|w| w.buffer.name == "a.txt"));
}

/// Each window's lines, columns and buffer, in cyclic order.
fn sizes(ed: &mut Editor, s: &Scripting) -> String {
    s.eval_expression(ed, "JSON.stringify(e8.windowList().map((w) => [e8.windowTotalHeight(w), e8.windowTotalWidth(w), e8.windowBuffer(w)]))").unwrap()
}

#[test]
fn the_windows_come_back_at_their_sizes_and_older_desktops_still_read() {
    let config = dir();
    let files = dir();
    let (a, b) = (files.path().join("a.txt"), files.path().join("b.txt"));
    fs::write(&a, "one\ntwo\nthree\n").unwrap();
    fs::write(&b, "four\n").unwrap();
    let before;
    {
        let (mut ed, s) = setup(config.path());
        visit(&mut ed, &a);
        ed.press("C-u 8 C-x 2 C-u 3 0 C-x 3").unwrap();
        ed.press("C-x o C-x o").unwrap();
        visit(&mut ed, &b);
        before = sizes(&mut ed, &s);
        assert_eq!(before, r#""[[8,30,\"a.txt\"],[8,50,\"a.txt\"],[15,80,\"b.txt\"]]""#);
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    // Kept as window-state-get's writable state, printed as Lisp.
    let saved = fs::read_to_string(config.path().join(".e8.desktop")).unwrap();
    assert!(saved.contains(r#""windows": "(((min-height "#), "{saved}");
    let (mut ed, s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    assert_eq!(sizes(&mut ed, &s), before);
    assert_eq!(ed.window_buffer().name, "b.txt", "the window selected then is selected");
    drop(ed);
    // A desktop E8 wrote before keeps its windows as an object of its own.
    let mut desktop: serde_json::Value = serde_json::from_str(&saved).unwrap();
    desktop["windows"] = serde_json::json!({
        "sideBySide": false, "firstSize": 8,
        "first": { "buffer": "a.txt", "file": a.display().to_string(), "point": 4, "start": 0, "selected": false },
        "second": { "buffer": "b.txt", "file": b.display().to_string(), "point": 0, "start": 0, "selected": true }
    });
    fs::write(config.path().join(".e8.desktop"), desktop.to_string()).unwrap();
    fs::remove_file(config.path().join(".e8.desktop.lock")).ok();
    let (mut ed, s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    assert_eq!(sizes(&mut ed, &s), r#""[[8,80,\"a.txt\"],[15,80,\"b.txt\"]]""#);
    assert_eq!(windows(&ed), [("a.txt".into(), 4), ("b.txt".into(), 0)]);
    assert_eq!(ed.window_buffer().name, "b.txt");
}

#[test]
fn a_frame_in_a_window_comes_back_where_it_was_and_as_big() {
    let config = dir();
    {
        let (mut ed, _s) = setup(config.path());
        ed.set_in_a_window();
        let frame = ed.selected_frame();
        ed.set_frame_geometry(frame, e8_core::FrameGeometry { native: (90.0, 30.0), position: (120.0, 45.0), scale: 2.0, outer: (0.0, 0.0) });
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    let saved = fs::read_to_string(config.path().join(".e8.desktop")).unwrap();
    assert!(saved.contains("\"frame\""), "{saved}");
    let (mut ed, _s) = setup(config.path());
    ed.set_in_a_window();
    // A frame a different size from the one saved, as a new window is.
    ed.set_frame_size(60, 20);
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    let frame = ed.selected_frame();
    // Headless a cell is 1 by 1: the text area was 80 wide and its 23
    // lines' windows and the echo area tall.
    assert_eq!(
        ed.take_frame_requests(),
        vec![
            e8_core::FrameRequest::Size { frame, width: 80.0, height: 24.0 },
            e8_core::FrameRequest::Position { frame, x: 120.0, y: 45.0 },
        ]
    );
}

#[test]
fn a_frame_is_not_put_back_on_a_terminal_or_without_desktop_restore_frames() {
    let config = dir();
    {
        let (mut ed, _s) = setup(config.path());
        ed.set_in_a_window();
        let frame = ed.selected_frame();
        ed.set_frame_geometry(frame, e8_core::FrameGeometry { native: (90.0, 30.0), position: (120.0, 45.0), scale: 2.0, outer: (0.0, 0.0) });
        ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    }
    {
        let (mut ed, _s) = setup(config.path());
        ed.set_in_a_window();
        ed.set_variable("desktop-restore-frames", Value::Bool(false));
        ed.set_variable("desktop-save-mode", Value::Bool(true));
        ed.run_hooks("after-init-hook").unwrap();
        assert!(ed.take_frame_requests().is_empty());
    }
    // A terminal's characters are not a window's pixels.
    let (mut ed, _s) = setup(config.path());
    ed.set_variable("desktop-save-mode", Value::Bool(true));
    ed.run_hooks("after-init-hook").unwrap();
    assert!(ed.take_frame_requests().is_empty());
    // Nor does a terminal save a frame of its own.
    ed.call("desktop-save", vec![Arg::Str(config.path().display().to_string()), Arg::Prefix(None)]).unwrap();
    let saved = fs::read_to_string(config.path().join(".e8.desktop")).unwrap();
    assert!(!saved.contains("\"frame\""), "{saved}");
}
