//! File notifications, as Emacs's kqueue.c and filenotify.el give them.
//! Each expectation is what Emacs 30.2 on macOS gave for the same changes
//! made to the same files, its descriptor written D and the directory
//! watched DIR.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript, giving what it returns as JSON, or `ERR condition message`.
fn run(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            "globalThis.ev ??= []; globalThis.result = (() => {{ try {{ return JSON.stringify((() => {{ {code} }})()) ?? 'undefined'; }} catch (e: any) {{ return `ERR ${{e.symbol}} ${{e.message}}`; }} }})();"
        ),
    )
    .unwrap();
    serde_json::from_str::<String>(&s.eval_expression(ed, "globalThis.result").unwrap()).unwrap()
}

/// Waits up to five seconds for `want` events, then a moment more for any
/// that follow, and gives those that came, as JSON with each descriptor in
/// `globalThis.ds` written D and `dir` written DIR, and forgets them.
#[cfg_attr(not(any(target_os = "macos", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")), allow(dead_code))]
fn events(ed: &mut Editor, s: &Scripting, dir: &str, want: usize) -> String {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        ed.run_timers();
        let n: usize = run(ed, s, "return ev.length;").parse().unwrap();
        if n >= want || std::time::Instant::now() >= until {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        ed.run_timers();
    }
    let got = run(
        ed,
        s,
        "const out = ev.map(([d, ...rest]: any[]) => [(globalThis.ds ?? []).includes(d) ? 'D' : d, ...rest]); ev = []; return out;",
    );
    got.replace(dir, "DIR")
}

#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
mod watching {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// A temporary directory, its name as Emacs gives it, without a final slash.
    fn temp() -> (tempfile::TempDir, String) {
        let t = tempfile::tempdir().unwrap();
        let name = t.path().display().to_string();
        (t, name)
    }

    fn watch(ed: &mut Editor, s: &Scripting, file: &str, flags: &str) -> String {
        run(ed, s, &format!("const d = e8.kqueueAddWatch({file:?}, {flags}, (e) => ev.push(e)); (globalThis.ds ??= []).push(d); return d;"))
    }

    fn append(file: &str, text: &str) {
        fs::OpenOptions::new().append(true).open(file).unwrap().write_all(text.as_bytes()).unwrap();
    }

    fn chmod(file: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn a_watched_file_reports_what_is_done_to_it() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        let f = format!("{dir}/a.txt");
        fs::write(&f, "x").unwrap();
        let d = watch(&mut ed, &s, &f, r#"["create", "delete", "write", "extend", "attrib", "link", "rename", "revoke"]"#);
        // As Emacs, its descriptor the file's, a number.
        assert!(d.parse::<u32>().is_ok(), "{d}");
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueValidP({d});")), "true");
        // As Emacs: ((7 (extend write) ".../a.txt")).
        append(&f, "more");
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["extend","write"],"DIR/a.txt"]]"#);
        // Truncated and written: ((7 (attrib extend write) ".../a.txt")).
        fs::write(&f, "new").unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["attrib","extend","write"],"DIR/a.txt"]]"#);
        chmod(&f, 0o600);
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["attrib"],"DIR/a.txt"]]"#);
        fs::hard_link(&f, format!("{dir}/hard")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["link"],"DIR/a.txt"]]"#);
        // A rename ends the watch: valid-p nil, and rm-watch an error.
        fs::rename(&f, format!("{dir}/b.txt")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["rename"],"DIR/a.txt"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueValidP({d});")), "undefined");
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueRmWatch({d});")), format!("ERR file-notify-error Not a watch descriptor, {d}"));
    }

    #[test]
    fn only_the_events_asked_for_are_reported() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        let f = format!("{dir}/c.txt");
        fs::write(&f, "x").unwrap();
        let d = watch(&mut ed, &s, &f, r#"["write"]"#);
        // As Emacs: ((7 (write) ".../c.txt")), the extend and attrib left out.
        append(&f, "more");
        chmod(&f, 0o644);
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["write"],"DIR/c.txt"]]"#);
        // Deleted, unasked: nothing, and the watch stays, as in Emacs.
        fs::remove_file(&f).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 0), "[]");
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueValidP({d});")), "true");
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueRmWatch({d});")), "true");
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueValidP({d});")), "undefined");
        // Deleted, asked for: ((8 (delete) ".../e.txt")), and the watch gone.
        let g = format!("{dir}/e.txt");
        fs::write(&g, "x").unwrap();
        let d = watch(&mut ed, &s, &g, r#"["delete"]"#);
        fs::remove_file(&g).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["delete"],"DIR/e.txt"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueValidP({d});")), "undefined");
    }

    #[test]
    fn a_watched_directory_reports_the_files_in_it() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        watch(&mut ed, &s, &dir, r#"["create", "delete", "write", "extend", "attrib", "link", "rename", "revoke"]"#);
        // As Emacs, by their names in the directory: ((8 (create) "new1")).
        fs::write(format!("{dir}/new1"), "").unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["create"],"new1"]]"#);
        // ((8 (create) "new2") (8 (write) "new2")).
        fs::write(format!("{dir}/new2"), "abc").unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 2), r#"[["D",["create"],"new2"],["D",["write"],"new2"]]"#);
        // ((8 (rename) "new2" "new3")).
        fs::rename(format!("{dir}/new2"), format!("{dir}/new3")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["rename"],"new2","new3"]]"#);
        // ((8 (delete) "new1")).
        fs::remove_file(format!("{dir}/new1")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["delete"],"new1"]]"#);
        // Written to in place, the directory unchanged: nothing yet.
        append(&format!("{dir}/new3"), "zz");
        assert_eq!(events(&mut ed, &s, &dir, 0), "[]");
        // When the directory next changes, the listings compared find that
        // too, the old files first, then the new, then the directory's own
        // events, as Emacs: ((8 (write) "new3") (8 (attrib) "new3")) and
        // ((8 (create) "sub") (8 (write) "sub") (8 (link) ".../dir")).
        fs::create_dir(format!("{dir}/sub")).unwrap();
        assert_eq!(
            events(&mut ed, &s, &dir, 5),
            r#"[["D",["write"],"new3"],["D",["attrib"],"new3"],["D",["create"],"sub"],["D",["write"],"sub"],["D",["link"],"DIR"]]"#
        );
        // Two at once, last name first: ((8 (create) "z1") (8 (write) "z1") (8 (create) "a1")).
        fs::write(format!("{dir}/z1"), "1").unwrap();
        fs::write(format!("{dir}/a1"), "").unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 3), r#"[["D",["create"],"z1"],["D",["write"],"z1"],["D",["create"],"a1"]]"#);
    }

    #[test]
    fn a_directory_watch_needs_write_and_ends_when_it_goes() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        // Watching for create alone, Emacs never hears of the directory's writes: nil.
        let d = watch(&mut ed, &s, &dir, r#"["create"]"#);
        fs::write(format!("{dir}/q"), "abc").unwrap();
        fs::remove_file(format!("{dir}/q")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 0), "[]");
        run(&mut ed, &s, &format!("return e8.kqueueRmWatch({d});"));
        // A watched directory deleted: ((8 (delete) ".../sub")), and the watch gone.
        let sub = format!("{dir}/sub");
        fs::create_dir(&sub).unwrap();
        let d = watch(&mut ed, &s, &sub, r#"["create", "delete", "write", "rename"]"#);
        fs::remove_dir(&sub).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["delete"],"DIR/sub"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.kqueueValidP({d});")), "undefined");
    }

    #[test]
    fn watches_are_checked_as_emacs_checks_them() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        let mut r = |code: &str| run(&mut ed, &s, code);
        assert_eq!(
            r(r#"return e8.kqueueAddWatch("/nonexistent/x", ["write"], () => {});"#),
            "ERR file-missing File does not exist: No such file or directory, /nonexistent/x"
        );
        assert_eq!(r(&format!("return e8.kqueueAddWatch({dir:?}, 3 as any, () => {{}});")), "ERR wrong-type-argument Wrong type argument: listp, 3");
        assert_eq!(r(&format!("return e8.kqueueAddWatch({dir:?}, [\"write\"], 3 as any);")), "ERR wrong-type-argument Wrong type argument: invalid-function, 3");
        assert_eq!(r(r#"return e8.kqueueAddWatch(3 as any, ["write"], () => {});"#), "ERR wrong-type-argument Wrong type argument: stringp, 3");
        assert_eq!(r("return e8.kqueueRmWatch(9999);"), "ERR file-notify-error Not a watch descriptor, 9999");
        assert_eq!(r(r#"return e8.kqueueRmWatch("x" as any);"#), "ERR file-notify-error Not a watch descriptor, x");
        assert_eq!(r(r#"return e8.conditionCase(() => e8.kqueueRmWatch(9999), { "file-error": () => "a file-error" });"#), r#""a file-error""#);
        assert_eq!(r("return e8.kqueueValidP(9999);"), "undefined");
        // Flags it does not know are taken, as Emacs takes them.
        assert_eq!(r(&format!("const d = e8.kqueueAddWatch({dir:?}, [\"bogus\"], () => {{}}); return e8.kqueueRmWatch(d);")), "true");
    }

    #[test]
    fn a_relative_name_is_reported_absolute() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        fs::write(format!("{dir}/new3"), "x").unwrap();
        // As Emacs: ((8 (write) ".../new3")).
        run(&mut ed, &s, &format!("e8.setVariable(\"default-directory\", {:?}); return null;", format!("{dir}/")));
        watch(&mut ed, &s, "new3", r#"["write"]"#);
        append(&format!("{dir}/new3"), "q");
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D",["write"],"DIR/new3"]]"#);
    }

    fn file_notify_watch(ed: &mut Editor, s: &Scripting, file: &str, flags: &str) -> String {
        run(
            ed,
            s,
            &format!("const d = e8.funcall(\"file-notify-add-watch\", {file:?}, {flags}, (e: any) => ev.push(e)); (globalThis.ds ??= []).push(d); return d;"),
        )
    }

    #[test]
    fn file_notify_watches_files_as_emacs_does() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        let f = format!("{dir}/a.txt");
        fs::write(&f, "x").unwrap();
        let d = file_notify_watch(&mut ed, &s, &f, r#"["change"]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.funcall(\"file-notify-valid-p\", {d});")), "true");
        // As Emacs: ((7 changed ".../a.txt")).
        append(&f, "more");
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D","changed","DIR/a.txt"]]"#);
        // Attributes, unasked: nil.
        chmod(&f, 0o600);
        assert_eq!(events(&mut ed, &s, &dir, 0), "[]");
        // ((7 deleted ".../a.txt") (7 stopped ".../a.txt")), and no longer valid.
        fs::rename(&f, format!("{dir}/b.txt")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 2), r#"[["D","deleted","DIR/a.txt"],["D","stopped","DIR/a.txt"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.funcall(\"file-notify-valid-p\", {d});")), "undefined");
        // ((7 attribute-changed ".../c.txt")), then ((7 deleted ...) (7 stopped ...)).
        let g = format!("{dir}/c.txt");
        fs::write(&g, "x").unwrap();
        let d = file_notify_watch(&mut ed, &s, &g, r#"["change", "attribute-change"]"#);
        chmod(&g, 0o600);
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D","attribute-changed","DIR/c.txt"]]"#);
        fs::remove_file(&g).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 2), r#"[["D","deleted","DIR/c.txt"],["D","stopped","DIR/c.txt"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.funcall(\"file-notify-valid-p\", {d});")), "undefined");
        // Removed: ((7 stopped ".../h.txt")), once; removing it again does nothing.
        let h = format!("{dir}/h.txt");
        fs::write(&h, "x").unwrap();
        let d = file_notify_watch(&mut ed, &s, &h, r#"["change"]"#);
        run(&mut ed, &s, &format!("e8.funcall(\"file-notify-rm-watch\", {d}); e8.funcall(\"file-notify-rm-watch\", {d}); return null;"));
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D","stopped","DIR/h.txt"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.funcall(\"file-notify-valid-p\", {d});")), "undefined");
    }

    #[test]
    fn file_notify_watches_directories_as_emacs_does() {
        let (mut ed, s) = setup();
        let (_t, dir) = temp();
        let d = file_notify_watch(&mut ed, &s, &dir, r#"["change"]"#);
        // As Emacs, by absolute names: ((7 created ".../n1") (7 changed ".../n1")).
        fs::write(format!("{dir}/n1"), "abc").unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 2), r#"[["D","created","DIR/n1"],["D","changed","DIR/n1"]]"#);
        // ((7 renamed ".../n1" ".../n2")).
        fs::rename(format!("{dir}/n1"), format!("{dir}/n2")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D","renamed","DIR/n1","DIR/n2"]]"#);
        // ((7 deleted ".../n2")).
        fs::remove_file(format!("{dir}/n2")).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D","deleted","DIR/n2"]]"#);
        // ((7 stopped ".../dir")).
        run(&mut ed, &s, &format!("e8.funcall(\"file-notify-rm-watch\", {d}); return null;"));
        assert_eq!(events(&mut ed, &s, &dir, 1), r#"[["D","stopped","DIR"]]"#);
        // A watched directory deleted: ((7 deleted ".../sub") (7 stopped ".../sub")).
        let sub = format!("{dir}/sub");
        fs::create_dir(&sub).unwrap();
        let d = file_notify_watch(&mut ed, &s, &sub, r#"["change"]"#);
        fs::remove_dir(&sub).unwrap();
        assert_eq!(events(&mut ed, &s, &dir, 2), r#"[["D","deleted","DIR/sub"],["D","stopped","DIR/sub"]]"#);
        assert_eq!(run(&mut ed, &s, &format!("return e8.funcall(\"file-notify-valid-p\", {d});")), "undefined");
        // Errors, as Emacs signals them.
        let mut r = |code: &str| run(&mut ed, &s, code);
        assert_eq!(
            r(r#"return e8.funcall("file-notify-add-watch", "/nonexistent/x", ["change"], () => {});"#),
            "ERR file-notify-error Directory does not exist, /nonexistent"
        );
        assert_eq!(
            r(&format!("return e8.funcall(\"file-notify-add-watch\", {:?}, [\"change\"], () => {{}});", format!("{dir}/missing"))),
            format!("ERR file-missing File does not exist: No such file or directory, {dir}/missing")
        );
        assert_eq!(r(&format!("try {{ e8.funcall(\"file-notify-add-watch\", {dir:?}, [\"bogus\"], () => {{}}); }} catch (e: any) {{ return e.symbol; }}")), r#""wrong-type-argument""#);
        assert_eq!(r(&format!("try {{ e8.funcall(\"file-notify-add-watch\", {dir:?}, [], () => {{}}); }} catch (e: any) {{ return e.symbol; }}")), r#""wrong-type-argument""#);
        assert_eq!(r(&format!("try {{ e8.funcall(\"file-notify-add-watch\", {dir:?}, [\"change\"], 3); }} catch (e: any) {{ return e.symbol; }}")), r#""wrong-type-argument""#);
        assert_eq!(r("return [e8.funcall(\"file-notify-valid-p\", 9999), e8.funcall(\"file-notify-rm-watch\", 9999)];"), "[null,null]");
    }
}

/// Where there is no kqueue, adding a watch signals, as kqueue.c does
/// when it cannot make one, and nothing is a watch.
#[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")))]
#[test]
fn without_kqueue_nothing_can_be_watched() {
    let (mut ed, s) = setup();
    let mut r = |code: &str| run(&mut ed, &s, code);
    assert_eq!(r(r#"return e8.kqueueAddWatch("/", ["write"], () => {});"#), "ERR file-notify-error File watching is not available");
    assert_eq!(r("return e8.kqueueValidP(3);"), "undefined");
    assert_eq!(r("return e8.kqueueRmWatch(3);"), "ERR file-notify-error Not a watch descriptor, 3");
}
