//! What was left of the file primitives: directory-files' order, the size
//! verify-visited-file-modtime compares, lock-file asking about a lock
//! another holds, buffers locked by the file's true name, file name
//! handlers for expand-file-name, file-attributes, copy-file and
//! rename-file, and system-type. What Emacs does was checked with Emacs
//! 30.2 in batch on macOS, as each test says.

use std::fs;
use std::time::{Duration, SystemTime};

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    eval(
        &mut ed,
        &s,
        r#"globalThis.res = (f) => e8.conditionCase(() => { const v = f(); return JSON.stringify(v === undefined ? "nil" : v); },
             { error: (e) => JSON.stringify([e.symbol, ...e.data.map((d) => (typeof d === "symbol" ? d.description : d))]) });"#,
    );
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, source: &str) {
    s.eval_typescript(ed, "test.ts", source.to_string()).unwrap();
}

fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

fn js(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// Emacs 30, in a directory readdir lists as ". .. a c d b":
/// (directory-files D nil nil t) is ("b" "d" "c" "a" ".." "."), with COUNT
/// 3 ("." ".." "a"), and NOSORT and COUNT 3 ("a" ".." "."): the first COUNT
/// in the directory's order, then sorted, or backwards with NOSORT.
#[test]
fn directory_files_keep_the_directorys_order() {
    let (mut ed, s) = setup();
    let d = dir();
    for name in ["c", "a", "b", "d"] {
        fs::write(d.path().join(name), "").unwrap();
    }
    let mut listed = vec![".".to_string(), "..".to_string()];
    listed.extend(fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()));
    let dir = js(&d.path().display().to_string());
    let got = |ed: &mut Editor, options: &str| -> Vec<String> { serde_json::from_str(&value(ed, &s, &format!("JSON.stringify(e8.directoryFiles({dir}, {options}))"))).unwrap() };
    let mut reversed = listed.clone();
    reversed.reverse();
    assert_eq!(got(&mut ed, "{ nosort: true }"), reversed);
    let mut first3 = listed[..3].to_vec();
    first3.sort();
    assert_eq!(got(&mut ed, "{ count: 3 }"), first3);
    let mut first3_back = listed[..3].to_vec();
    first3_back.reverse();
    assert_eq!(got(&mut ed, "{ nosort: true, count: 3 }"), first3_back);
    assert_eq!(got(&mut ed, "{}"), vec![".", "..", "a", "b", "c", "d"]);
}

/// Emacs 30 compares the size it took with the time: a file whose text
/// changed but whose time was put back is changed on disk all the same.
#[test]
fn a_change_of_size_alone_is_a_change_on_disk() {
    let (mut ed, s) = setup();
    let d = dir();
    let path = d.path().join("f.txt");
    fs::write(&path, "short\n").unwrap();
    let when = SystemTime::now() - Duration::from_secs(100);
    fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    assert_eq!(value(&mut ed, &s, "String(e8.verifyVisitedFileModtime())"), "true");
    fs::write(&path, "much longer now\n").unwrap();
    fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
    assert_eq!(value(&mut ed, &s, "String(e8.verifyVisitedFileModtime())"), "false");
    // A time given by hand has no size to compare.
    eval(&mut ed, &s, "e8.setVisitedFileModtime(e8.visitedFileModtime());");
    assert_eq!(value(&mut ed, &s, "String(e8.verifyVisitedFileModtime())"), "true");
}

/// Batch Emacs 30: (lock-file F) where another holds the lock signals
/// (file-locked F "someone@elsewhere (pid 42)"), as ask-user-about-lock
/// does with nobody to ask; a buffer's lock is made by the file's true
/// name, so a link and its target share one.
#[test]
fn a_lock_another_holds_is_asked_about_and_buffers_lock_true_names() {
    let (mut ed, s) = setup();
    ed.set_noninteractive(true);
    let d = dir();
    let path = d.path().join("held.txt");
    fs::write(&path, "x\n").unwrap();
    std::os::unix::fs::symlink("someone@elsewhere.42:0", d.path().join(".#held.txt")).unwrap();
    let file = js(&path.display().to_string());
    assert_eq!(res(&mut ed, &s, &format!("e8.lockFile({file})")), format!(r#"["file-locked",{file},"someone@elsewhere (pid 42)"]"#));

    let target = d.path().join("target.txt");
    fs::write(&target, "t\n").unwrap();
    let link = d.path().join("link.txt");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    ed.call("find-file", vec![Arg::Str(link.display().to_string())]).unwrap();
    ed.type_text("y");
    assert!(fs::symlink_metadata(d.path().join(".#target.txt")).is_ok(), "the lock is by the true name");
    assert!(fs::symlink_metadata(d.path().join(".#link.txt")).is_err());
    ed.call("save-buffer", vec![]).unwrap();
    assert!(fs::symlink_metadata(d.path().join(".#target.txt")).is_err(), "saving gives the lock up");
}

fn res(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    value(ed, s, &format!("res(() => {code})"))
}

/// As Emacs's expand-file-name, file-attributes, copy-file and rename-file
/// do, a handler in file-name-handler-alist for the name answers.
#[test]
fn file_name_handlers_answer_for_their_names() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"globalThis.ops = [];
        e8.setVariable("file-name-handler-alist", [["\\`/fake:", (operation: unknown, ...args: unknown[]) => {
          // The operation comes as a symbol, as Emacs gives it.
          const op = typeof operation === "symbol" ? operation.description : operation;
          ops.push([op, ...args]);
          if (op === "expand-file-name") return "/fake:expanded";
          if (op === "file-attributes") return { type: "file", size: 7 } as any;
          return null;
        }]]);"#,
    );
    assert_eq!(value(&mut ed, &s, r#"e8.expandFileName("/fake:x")"#), "/fake:expanded");
    assert_eq!(value(&mut ed, &s, r#"JSON.stringify(e8.fileAttributes("/fake:x"))"#), r#"{"type":"file","size":7}"#);
    let d = dir();
    let other = js(&d.path().join("b").display().to_string());
    eval(&mut ed, &s, &format!(r#"e8.copyFile("/fake:a", {other}); e8.renameFile({other}, "/fake:c");"#));
    let ops = value(&mut ed, &s, "JSON.stringify(ops.map((o) => o[0]))");
    assert_eq!(ops, r#"["expand-file-name","file-attributes","copy-file","rename-file"]"#);
    // Nothing was copied, the handler having done it.
    assert!(!d.path().join("b").exists());
}

/// Emacs's system-type names the system as it does.
#[test]
fn system_type_names_the_system() {
    let (mut ed, s) = setup();
    let want = if cfg!(target_os = "macos") { "darwin" } else if cfg!(target_os = "linux") { "gnu/linux" } else { "gnu" };
    assert_eq!(value(&mut ed, &s, r#"e8.variable("system-type")"#), want);
}

/// Batch Emacs 30: lock-file on a file a buffer visits that changed on disk
/// says the question and signals "Cannot resolve conflict in batch mode",
/// lock files or not.
#[test]
fn lock_file_asks_about_a_file_changed_on_disk() {
    let (mut ed, s) = setup();
    ed.set_noninteractive(true);
    let d = dir();
    let path = d.path().join("c.txt");
    fs::write(&path, "x\n").unwrap();
    ed.call("find-file", vec![Arg::Str(path.display().to_string())]).unwrap();
    fs::write(&path, "changed\n").unwrap();
    let later = SystemTime::now() + Duration::from_secs(5);
    fs::File::options().write(true).open(&path).unwrap().set_modified(later).unwrap();
    let file = js(&path.display().to_string());
    for setup in ["", r#"e8.setVariable("create-lockfiles", false);"#] {
        eval(&mut ed, &s, setup);
        let said = value(&mut ed, &s, &format!(r#"e8.conditionCase(() => {{ e8.lockFile({file}); return "locked"; }}, {{ error: (e) => e.message }})"#));
        assert_eq!(said, "Cannot resolve conflict in batch mode");
    }
    assert!(fs::symlink_metadata(d.path().join(".#c.txt")).is_err());
}
