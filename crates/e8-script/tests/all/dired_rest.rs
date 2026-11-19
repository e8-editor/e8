//! What was left of Dired: the *Dired log* of failures, the commands ! and
//! & guess, query-replace and search over the marked files by fileloop,
//! with Y and N, and wdired's permission bits and its search confined to
//! file names. Marks read by a key (* c, M-DEL) are oracle cases.

use std::fs;
use std::path::Path;

use crate::driven::Driven;
use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("delete-by-moving-to-trash", Value::Bool(false));
    let dir = tempfile::tempdir().unwrap();
    let module = dir.path().join("globals.ts");
    fs::write(&module, r#"import * as dired from "dired"; Object.assign(globalThis, { dired });"#).unwrap();
    s.load_module(&mut ed, &module).unwrap();
    (ed, s)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

fn value(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let got = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

fn sample() -> tempfile::TempDir {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::write(dir.path().join("a.txt"), "apple and apple\n").unwrap();
    fs::write(dir.path().join("b.txt"), "apple pie\n").unwrap();
    fs::write(dir.path().join("pack.tar.gz"), "").unwrap();
    dir
}

fn dired(ed: &mut Editor, dir: &Path) {
    ed.call("dired", vec![Arg::Str(format!("{}/", dir.display()))]).unwrap();
}

fn js(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

/// Emacs 30: a copy that fails is logged in *Dired log* with the time and
/// buffer at the start of its group and a formfeed after; one failure is
/// shown in the echo area as logged, several as "--type ? for details".
#[test]
fn failures_are_logged_in_the_dired_log() {
    let (mut ed, s) = setup();
    let dir = sample();
    dired(&mut ed, dir.path());
    eval_log(&mut ed, &s, &dir);
    let log = value(&mut ed, &s, r#"e8.withCurrentBuffer("*Dired log*", () => e8.bufferText())"#);
    assert!(log.contains("Copy: \u{2018}"), "{log}");
    assert!(log.contains("\tBuffer \u{2018}"), "{log}");
    assert!(log.ends_with("\u{c}\n"), "{log:?}");
    let message = ed.messages().last().cloned().unwrap_or_default();
    assert!(message.starts_with("Copy: \u{2018}") && message.contains("failed"), "{message}");
}

fn eval_log(ed: &mut Editor, s: &Scripting, dir: &tempfile::TempDir) {
    let from = js(&dir.path().join("a.txt").display().to_string());
    let to = js(&dir.path().join("no-such-dir/x/a.txt").display().to_string());
    s.eval_typescript(
        ed,
        "test.ts",
        format!(
            r#"dired.createFiles("Copy", [{from}], () => {to}, (f, t) => e8.copyFile(f, t), () => undefined);"#
        ),
    )
    .unwrap();
}

/// Emacs 30's dired-guess-shell-alist-default: for a .tar.gz, ! offers
/// GNU tar's zxvf if tar is GNU's, else "gunzip -qc * | tar xvf -", among
/// several guesses, the first in the prompt.
#[test]
fn bang_guesses_the_command_for_the_files() {
    let d = Driven::new("");
    let dir = sample();
    let path = format!("{}/", dir.path().display());
    d.start(move |ed| ed.call("dired", vec![Arg::Str(path)]).unwrap());
    d.eval(r#"e8.gotoChar(0); e8.reSearchForward("pack\\.tar\\.gz"); e8.gotoChar(e8.matchBeginning(0)!);"#);
    d.press("!");
    let prompt = d.prompt().unwrap_or_default();
    assert!(prompt.starts_with("! on pack.tar.gz {"), "{prompt}");
    assert!(prompt.contains("guesses} [") && (prompt.contains("zxvf]: ") || prompt.contains("gunzip -qc * | tar xvf -]: ")), "{prompt}");
    d.press("C-g");
}

/// Emacs 30: Q in Dired query-replaces through the marked files by
/// fileloop: y here, Y replaces the rest in every file without asking.
#[test]
fn query_replace_goes_through_the_marked_files() {
    let d = Driven::new("");
    let dir = sample();
    let path = format!("{}/", dir.path().display());
    d.start(move |ed| ed.call("dired", vec![Arg::Str(path)]).unwrap());
    d.eval(r#"e8.call("dired-mark-files-regexp", "\\.txt\\'");"#);
    d.press("Q");
    d.type_text("apple");
    d.press("RET");
    d.type_text("pear");
    d.press("RET");
    d.press("y");
    d.press("Y");
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "apple and apple\n", "nothing is saved");
    let a = d.eval_expression(r#"e8.withCurrentBuffer("a.txt", () => e8.bufferText())"#);
    let b = d.eval_expression(r#"e8.withCurrentBuffer("b.txt", () => e8.bufferText())"#);
    assert_eq!(a, r#""pear and pear\n""#);
    assert_eq!(b, r#""pear pie\n""#);
}

/// With wdired-allow-to-change-permissions, a bit is typed in place or
/// toggled with SPC, and C-c C-c sets the file's mode; searching and
/// replacing in wdired find only file names.
#[test]
fn wdired_edits_permission_bits_and_searches_only_names() {
    let (mut ed, s) = setup();
    let dir = sample();
    let file = dir.path().join("a.txt");
    fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
    ed.set_variable("wdired-allow-to-change-permissions", Value::Bool(true));
    dired(&mut ed, dir.path());
    ed.call("wdired-change-to-wdired-mode", vec![]).unwrap();
    // To the group's write bit of a.txt's line: -rw-r--r--, the sixth.
    s.eval_typescript(&mut ed, "t.ts", r#"e8.gotoChar(0); e8.reSearchForward("-rw-r--r--.* a\\.txt"); e8.gotoChar(e8.matchBeginning(0)! + 5);"#.into()).unwrap();
    ed.press("w").unwrap();
    s.eval_typescript(&mut ed, "t.ts", r#"e8.gotoChar(e8.point() + 2);"#.into()).unwrap();
    ed.press("SPC").unwrap();
    assert!(text(&ed).lines().any(|l| l.contains("-rw-rw-rw-") && l.ends_with("a.txt")), "{}", text(&ed));
    // Only names: "txt" in a name is found, nothing else on the line.
    assert_eq!(
        value(&mut ed, &s, r#"String((e8.variable("isearch-filter-predicate") as any)(e8.saveExcursion(() => { e8.gotoChar(0); e8.reSearchForward("a\\.txt"); return e8.matchBeginning(0)!; }), e8.saveExcursion(() => { e8.gotoChar(0); e8.reSearchForward("a\\.txt"); return e8.matchEnd(0)!; })))"#),
        "true"
    );
    assert_eq!(
        value(&mut ed, &s, r#"String((e8.variable("isearch-filter-predicate") as any)(e8.saveExcursion(() => { e8.gotoChar(0); e8.reSearchForward("rw-rw-rw"); return e8.matchBeginning(0)!; }), e8.saveExcursion(() => { e8.gotoChar(0); e8.reSearchForward("rw-rw-rw"); return e8.matchEnd(0)!; })))"#),
        "false"
    );
    ed.call("wdired-finish-edit", vec![]).unwrap();
    let mode = std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&file).unwrap().permissions()) & 0o777;
    assert_eq!(mode, 0o666);
}
