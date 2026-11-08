//! The file primitives scripts call: handlers in file-name-handler-alist,
//! lock files, and the predicates and names Emacs gives Lisp.

use crate::driven::Driven;
use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let cd = format!("(e8.makeLocalVariable(\"default-directory\"), e8.setVariable(\"default-directory\", {:?}))", format!("{}/", dir.path().display()));
    scripting.eval_expression(&mut ed, &cd).unwrap();
    (ed, scripting, dir)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn a_handler_serves_names_of_its_own() {
    // A handler for /fake: names keeping files in memory, as TRAMP keeps
    // them on another machine; anything else it hands back to the real
    // operation, which it reaches by inhibiting itself.
    let (mut ed, s, _dir) = setup();
    s.eval_typescript(
        &mut ed,
        "handler.ts",
        r#"
        globalThis.store = new Map([["/fake:notes.txt", "remote text\n"]]);
        globalThis.seen = [];
        const handler = e8.defun("fake-file-handler", (op, ...args) => {
          const name = typeof op === "symbol" ? op.description : op;
          seen.push(name);
          switch (name) {
            case "file-exists-p": return store.has(args[0]);
            case "insert-file-contents": {
              const text = store.get(args[0]) ?? "";
              e8.insert(text);
              e8.gotoChar(e8.point() - text.length);
              return [args[0], text.length];
            }
            case "write-region": {
              store.set(args[2], e8.bufferSubstring(0, e8.bufferSize()).string);
              if (args[4] === true) e8.setBufferModified(false);
              return null;
            }
            default:
              return e8.letBind({ "inhibit-file-name-handlers": [handler], "inhibit-file-name-operation": name },
                () => e8.funcall(name, ...args));
          }
        });
        e8.setVariable("file-name-handler-alist", [["\\`/fake:", handler]]);
        "#
        .into(),
    )
    .unwrap();
    assert_eq!(eval(&mut ed, &s, r#"e8.fileExistsP("/fake:notes.txt")"#), "true");
    assert_eq!(eval(&mut ed, &s, r#"e8.fileExistsP("/fake:other.txt")"#), "false");
    ed.call("find-file", vec![Arg::Str("/fake:notes.txt".into())]).unwrap();
    assert_eq!(text(&ed), "remote text\n");
    assert!(!ed.window_buffer().is_modified());
    ed.type_text("more ");
    ed.call("save-buffer", vec![]).unwrap();
    assert_eq!(eval(&mut ed, &s, r#"store.get("/fake:notes.txt")"#), r#""more remote text\n""#);
    assert!(!ed.window_buffer().is_modified());
    assert_eq!(eval(&mut ed, &s, r#"e8.findFileNameHandler("/fake:x", "file-exists-p")"#), r#""fake-file-handler""#);
    assert_eq!(eval(&mut ed, &s, r#"e8.findFileNameHandler("/real/x", "file-exists-p") ?? "none""#), r#""none""#);
}

#[test]
fn a_lock_another_holds_is_asked_about() {
    // The question waits for its answer, so on the editor's own thread.
    let d = Driven::new("");
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    let lock = dir.path().join(".#a.txt");
    // Held by a process on another machine, which E8 cannot tell is gone.
    std::os::unix::fs::symlink("someone@elsewhere.1:0", &lock).unwrap();
    let visit = file.display().to_string();
    d.with(move |ed| ed.call("find-file", vec![Arg::Str(visit)]).unwrap());
    d.type_text("x");
    let prompt = d.prompt().unwrap_or_default();
    assert!(prompt.ends_with("a.txt locked by someone@elsewhere (pid 1): (s, q, p, ?)? "), "{prompt}");
    assert_eq!(d.text(), "one\n", "nothing typed yet");
    // q leaves the file alone.
    d.type_text("q");
    let echo = d.message().unwrap_or_default();
    assert!(echo.starts_with("File is locked: "), "{echo:?}");
    assert_eq!(d.text(), "one\n");
    // p edits without the lock, s takes it.
    d.type_text("x");
    d.type_text("p");
    assert_eq!(d.text(), "xone\n");
    assert_eq!(std::fs::read_link(&lock).unwrap().display().to_string(), "someone@elsewhere.1:0");
    d.press("C-/");
    d.type_text("x");
    d.type_text("s");
    assert_eq!(d.text(), "xone\n");
    let mine = std::fs::read_link(&lock).unwrap().display().to_string();
    assert!(mine.contains(&format!(".{}", std::process::id())), "{mine}");
    assert_eq!(d.eval_expression(&format!("e8.fileLockedP({:?})", file.display().to_string())), "true");
    // Saving gives it up.
    d.with(|ed| ed.call("save-buffer", vec![]).unwrap());
    assert!(std::fs::symlink_metadata(&lock).is_err());
}

#[test]
fn a_stale_lock_is_taken_over() {
    let (mut ed, _s, dir) = setup();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    let lock = dir.path().join(".#a.txt");
    // A process on this machine that is no longer running.
    std::os::unix::fs::symlink(format!("{}@{}.999999999", e8_core::filelock::user_login_name(), e8_core::filelock::system_name()), &lock).unwrap();
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.type_text("x");
    assert!(ed.prompt().is_none());
    assert_eq!(text(&ed), "xone\n");
    assert!(std::fs::read_link(&lock).unwrap().display().to_string().contains(&format!(".{}", std::process::id())));
    // Killing the buffer gives the lock up.
    ed.kill_buffer_unsaved("a.txt").unwrap();
    assert!(std::fs::symlink_metadata(&lock).is_err());
}

#[test]
fn a_lock_that_cannot_be_read_or_deleted_does_not_hang_editing() {
    let (mut ed, _s, dir) = setup();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    // Neither a link nor a file to read, and not deleted as a stale lock is.
    std::fs::create_dir(dir.path().join(".#a.txt")).unwrap();
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.type_text("x");
    assert_eq!(text(&ed), "xone\n");
}

#[test]
fn names_and_predicates_as_emacs_gives_them() {
    // What Emacs 30.2 gives for the same names.
    let (mut ed, s, dir) = setup();
    std::fs::write(dir.path().join("a.txt"), "hello\nworld\n").unwrap();
    std::os::unix::fs::symlink("a.txt", dir.path().join("link")).unwrap();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          e8.fileExistsP("link"), e8.fileSymlinkP("link"), e8.fileRegularP("link"), e8.fileReadableP("a.txt"),
          e8.fileWritableP("new.txt"), e8.fileExecutableP("."), e8.fileModes("a.txt") === 0o644 || e8.fileModes("a.txt") === 0o664,
          e8.fileNewerThanFileP("a.txt", "nope"),
          e8.substituteInFileName("/a/b//c/d"), e8.substituteInFileName("/a/~/b$$c"),
          e8.fileNameConcat("a", "b/", "c"), e8.fileNameConcat("/x/", "", "y"),
          e8.fileNameAbsoluteP("/a"), e8.fileNameAbsoluteP("~/a"), e8.fileNameAbsoluteP("a"),
          e8.directoryFiles(".", { match: "\\.txt\\'" }),
          e8.fileTruename("link") === e8.fileTruename("a.txt"),
        ])"#,
    );
    assert_eq!(got, r#""[true,\"a.txt\",true,true,true,true,true,true,\"/c/d\",\"~/b$c\",\"a/b/c\",\"/x/y\",true,true,false,[\"a.txt\"],true]""#);
    let temp = eval(&mut ed, &s, r#"e8.makeTempFile("e8-", { suffix: ".txt", text: "made" })"#);
    let temp: String = serde_json::from_str(&temp).unwrap();
    assert!(temp.ends_with(".txt") && std::path::Path::new(&temp).file_name().unwrap().to_string_lossy().starts_with("e8-"));
    assert_eq!(std::fs::read_to_string(&temp).unwrap(), "made");
    std::fs::remove_file(temp).unwrap();
    // insert-file-contents leaves point before the text, and returns what it read.
    ed.window_buffer_mut().set_text("XY");
    ed.window_buffer_mut().set_point(1);
    let read = eval(&mut ed, &s, r#"JSON.stringify(e8.insertFileContents("a.txt").map((x) => typeof x === "string" ? x.replace(/.*\//, "") : x))"#);
    assert_eq!(read, r#""[\"a.txt\",12]""#);
    assert_eq!((text(&ed), ed.window_buffer().point()), ("Xhello\nworld\nY".to_string(), 1));
    let err = s.eval_expression(&mut ed, r#"e8.writeRegion("x", null, "a.txt", { mustbenew: true })"#).unwrap_err();
    assert!(err.to_string().contains("File exists"), "{err}");
}

#[test]
fn default_directory_is_each_buffers_and_a_visited_files_directory() {
    let (mut ed, s, dir) = setup();
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::fs::write(sub.join("one.txt"), "one\n").unwrap();
    let file = sub.join("one.txt").display().to_string();
    let want = eval(&mut ed, &s, &format!("e8.fileNameAsDirectory(e8.abbreviateFileName({:?}))", sub.display().to_string()));
    // Visited without being shown, from a buffer whose own directory is
    // another: its default-directory is its file's, as Emacs's find-file
    // sets it, and relative names expand there.
    let b = eval(&mut ed, &s, &format!("e8.findFileNoselect({file:?})"));
    assert_eq!(eval(&mut ed, &s, &format!("e8.withCurrentBuffer({b}, () => e8.variable(\"default-directory\"))")), want);
    assert_eq!(eval(&mut ed, &s, &format!("e8.withCurrentBuffer({b}, () => e8.expandFileName(\"two.txt\"))")), format!("{:?}", sub.join("two.txt").display().to_string()));
    // A buffer may set its own, as Dired and shell do.
    eval(&mut ed, &s, &format!("e8.withCurrentBuffer({b}, () => e8.setVariable(\"default-directory\", \"/tmp/\"))"));
    assert_eq!(eval(&mut ed, &s, &format!("e8.withCurrentBuffer({b}, () => e8.variable(\"default-directory\"))")), r#""/tmp/""#);
    // Each buffer has its own, as in Emacs: a new buffer takes the current
    // buffer's, and setting it in one leaves the others.
    eval(&mut ed, &s, r#"e8.call("switch-to-buffer", "*other*")"#);
    eval(&mut ed, &s, r#"e8.setVariable("default-directory", "/var/")"#);
    eval(&mut ed, &s, r#"e8.call("switch-to-buffer", "*third*")"#);
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("default-directory")"#), r#""/var/""#);
    eval(&mut ed, &s, r#"e8.setVariable("default-directory", "/usr/")"#);
    assert_eq!(eval(&mut ed, &s, r#"e8.withCurrentBuffer("*other*", () => e8.variable("default-directory"))"#), r#""/var/""#);
}
