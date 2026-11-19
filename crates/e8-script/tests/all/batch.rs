//! Batch mode, as `emacs --batch`, and ERT (packages/ert.ts): a package's
//! tests run from the command line and exit with their status
//! (ADR 0059).

use std::fs;

use e8_core::{Editor, Value};
use e8_script::{Scripting, batch, config};

fn run(files: &[(&str, &str)], args: &[&str]) -> (i32, Editor, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    for (name, text) in files {
        fs::write(dir.path().join(name), text).unwrap();
    }
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let args: Vec<String> = args
        .iter()
        .map(|a| if a.ends_with(".ts") { dir.path().join(a).display().to_string() } else { a.to_string() })
        .collect();
    let status = batch::run_with(&mut ed, &s, &args);
    (status, ed, dir)
}

fn logged(ed: &Editor) -> String {
    ed.messages().join("\n")
}

const PASSING: &str = r#"
import { ertDeftest, should, shouldEqual, shouldError, shouldNot } from "ert";
import { charCount } from "subr";

ertDeftest("counts-characters", () => shouldEqual(charCount("åäö"), 3));
ertDeftest("checks-values", () => {
  should(() => 1 + 1 === 2);
  shouldNot(false);
  shouldError(() => e8.signal("wrong-type-argument", "nope"), { type: "error" });
});
"#;

#[test]
fn passing_tests_exit_with_status_0() {
    let (status, ed, _dir) = run(&[("a-tests.ts", PASSING)], &["-l", "a-tests.ts", "-f", "ert-run-tests-batch-and-exit"]);
    let log = logged(&ed);
    assert_eq!(status, 0, "{log}");
    assert!(log.contains("Running 2 tests (selector t)"), "{log}");
    assert!(log.contains("passed  1/2  counts-characters"), "{log}");
    assert!(log.contains("Ran 2 tests, 2 results as expected, 0 unexpected"), "{log}");
    assert_eq!(ed.variable("noninteractive"), Some(Value::Bool(true)));
}

const FAILING: &str = r#"
import { ertDeftest, should, shouldEqual, skipUnless } from "ert";

ertDeftest("adds-wrongly", () => shouldEqual(1 + 1, 3));
ertDeftest("shows-its-form", () => should(() => [1, 2].length > 5));
ertDeftest("known-to-fail", () => should(false, "known"), { expectedResult: "failed" });
ertDeftest("skipped", () => skipUnless(false, "never"));
ertDeftest("throws", () => { throw new Error("boom"); });
"#;

#[test]
fn unexpected_results_exit_with_status_1_and_say_why() {
    let (status, ed, _dir) = run(&[("b-tests.ts", FAILING)], &["-l", "b-tests.ts", "-f", "ert-run-tests-batch-and-exit"]);
    let log = logged(&ed);
    assert_eq!(status, 1, "{log}");
    assert!(log.contains(":actual 2 :expected 3"), "{log}");
    assert!(log.contains("(should [1, 2].length > 5) :value false"), "{log}");
    assert!(log.contains("Ran 5 tests, 1 results as expected, 3 unexpected, 1 skipped"), "{log}");
    assert!(log.contains("   FAILED  adds-wrongly"), "{log}");
    assert!(log.contains("boom"), "{log}");
    assert!(!log.contains("   FAILED  known-to-fail"), "{log}");
}

#[test]
fn eval_and_kill_emacs_give_the_status() {
    let (status, ed, _dir) = run(&[], &["--eval", "e8.message(\"hi \" + e8.variable(\"e8-version\"))", "--eval", "e8.killEmacs(7)", "--eval", "e8.message(\"not reached\")"]);
    let log = logged(&ed);
    assert_eq!(status, 7);
    assert!(log.contains(&format!("hi {}", env!("CARGO_PKG_VERSION"))), "{log}");
    assert!(!log.contains("not reached"), "{log}");
}

#[test]
fn errors_exit_with_status_255() {
    assert_eq!(run(&[], &["-f", "no-such-function"]).0, 255);
    assert_eq!(run(&[], &["-l", "missing.ts"]).0, 255);
    assert_eq!(run(&[("bad.ts", "throw new Error(\"no\");")], &["-l", "bad.ts"]).0, 255);
    assert_eq!(run(&[], &["--frobnicate"]).0, 255);
    assert_eq!(run(&[], &["-l"]).0, 255);
}

#[test]
fn the_arguments_done_it_exits_with_status_0() {
    let (status, ed, _dir) = run(&[("c.ts", "e8.message(\"loaded\");")], &["-l", "c.ts"]);
    assert_eq!(status, 0);
    assert!(ed.should_quit());
}

#[test]
fn m_x_ert_shows_the_results_in_a_buffer() {
    let mut ed = Editor::new();
    ed.set_frame_size(80, 24);
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("d-tests.ts");
    fs::write(&file, FAILING).unwrap();
    s.load_module(&mut ed, &file).unwrap();
    ed.call("ert", vec![e8_core::Arg::Str("adds".into())]).unwrap();
    let b = &ed.buffers()[ed.find_buffer("*ert*").unwrap()];
    let text = b.slice(0..b.len());
    assert!(text.contains("FAILED  adds-wrongly"), "{text}");
    assert!(!text.contains("throws"), "{text}");
}

#[test]
fn declarations_are_written_for_a_package_to_check_against() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("types");
    config::write_declarations(&ed, &out).unwrap();
    let dts = fs::read_to_string(out.join("e8.d.ts")).unwrap();
    assert!(dts.contains(&format!("// E8 {}:", env!("CARGO_PKG_VERSION"))), "{}", &dts[..400]);
    assert!(fs::read_to_string(out.join("shipped/subr.ts")).unwrap().contains("export function charCount"));
    assert!(out.join("shipped/ert.ts").is_file());
    assert!(out.join("shipped/package-vc.ts").is_file());
}

#[test]
fn l_puts_a_directory_on_load_path_for_tests_to_import_from() {
    let pkg = tempfile::tempdir().unwrap();
    fs::write(pkg.path().join("mine.ts"), "export const answer = 42;\n").unwrap();
    let test = r#"
import { ertDeftest, shouldEqual } from "ert";
import { answer } from "mine";
ertDeftest("mine-answers", () => shouldEqual(answer, 42));
"#;
    let dir = pkg.path().display().to_string();
    let (status, ed, _dir) = run(&[("mine-tests.ts", test)], &["-L", &dir, "-l", "mine-tests.ts", "-f", "ert-run-tests-batch-and-exit"]);
    assert_eq!(status, 0, "{}", logged(&ed));
    let Some(Value::List(path)) = ed.variable("load-path") else { panic!() };
    assert_eq!(path[0], Value::Str(dir));
}

#[test]
fn execute_kbd_macro_drives_the_editor_as_typed_keys() {
    let test = r#"
import { ertDeftest, shouldEqual, shouldError } from "ert";
ertDeftest("keys-edit-and-undo", () => {
  e8.call("switch-to-buffer", "keys");
  e8.executeKbdMacro("a C-a b C-a c");
  shouldEqual(e8.bufferText(), "cba");
  // Each command is a step of its own, as typed: undo takes back the c.
  e8.executeKbdMacro("C-/");
  shouldEqual(e8.bufferText(), "ba");
  e8.executeKbdMacro("x", 3);
  shouldEqual(e8.bufferText(), "xxxba");
  shouldError(() => e8.executeKbdMacro("C-x C-q x"), { type: "error" });
});
"#;
    let (status, ed, _dir) = run(&[("keys-tests.ts", test)], &["-l", "keys-tests.ts", "-f", "ert-run-tests-batch-and-exit"]);
    assert_eq!(status, 0, "{}", logged(&ed));
}

/// sleep-for and sit-for wait without reading input in batch mode, as
/// batch Emacs's do, running timers and process output meanwhile: there is
/// no keyboard to read, and reading standard input would fail.
const SLEEPING: &str = r#"
const start = Date.now();
let ran = false;
e8.runWithTimer(0.01, null, () => { ran = true; });
e8.sleepFor(0.05);
const slept = Date.now() - start;
const sat = e8.sitFor(0.02);
e8.message(`slept ${slept >= 45} timer ${ran} sat ${sat}`);
const p = e8.makeProcess({ name: "echo", buffer: "*echo*", command: ["sh", "-c", "echo hello"] });
for (let i = 0; i < 200 && !e8.withCurrentBuffer("*echo*", () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())).includes("hello"); i++) e8.sleepFor(0.01);
e8.message(`output ${JSON.stringify(e8.withCurrentBuffer("*echo*", () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())).trim().split("\n")[0])}`);
"#;

#[test]
fn sleep_for_and_sit_for_wait_without_reading_input() {
    let (status, ed, _dir) = run(&[("sleep.ts", SLEEPING)], &["-l", "sleep.ts"]);
    let log = logged(&ed);
    assert_eq!(status, 0, "{log}");
    assert!(log.contains("slept true timer true sat true"), "{log}");
    assert!(log.contains("output \"hello\""), "{log}");
}

/// Batch Emacs exits there and then on kill-emacs, with its status, and
/// on an error command-error-default-function reports, with 255: nothing
/// after either runs, and a handler for `error` does not stop it.
#[test]
fn kill_emacs_and_unhandled_errors_exit_at_once() {
    let killing = r#"
e8.conditionCase(() => e8.killEmacs(3), { error: () => e8.message("caught") });
e8.message("after");
"#;
    let (status, ed, _dir) = run(&[("kill.ts", killing)], &["-l", "kill.ts", "--eval", "e8.message('next')"]);
    let log = logged(&ed);
    assert_eq!(status, 3, "{log}");
    assert!(!log.contains("after") && !log.contains("caught") && !log.contains("next"), "{log}");
    let erring = r#"
e8.commandErrorDefaultFunction("Something broke", "context: ");
e8.message("after");
"#;
    let (status, ed, _dir) = run(&[("err.ts", erring)], &["-l", "err.ts"]);
    let log = logged(&ed);
    assert_eq!(status, 255, "{log}");
    assert!(!log.contains("after"), "{log}");
}

/// kill-emacs from a sentinel while a batch script waits for output exits
/// with its status, as batch Emacs would have exited in the sentinel.
#[test]
fn kill_emacs_in_a_sentinel_exits_a_waiting_script() {
    let waiting = r#"
const p = e8.makeProcess({ name: "t", command: ["true"], sentinel: () => e8.killEmacs(4) });
for (;;) e8.acceptProcessOutput(p, 0.05);
"#;
    let (status, ed, _dir) = run(&[("wait.ts", waiting)], &["-l", "wait.ts"]);
    let log = logged(&ed);
    assert_eq!(status, 4, "{log}");
    assert!(!log.contains("error in process sentinel"), "{log}");
}
