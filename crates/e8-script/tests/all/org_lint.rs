//! org-lint's checkers on files with mistakes for them, as Emacs 30.2's
//! org-lint.el reports them on the same files: each report's line, trust,
//! message and checker, from `(org-lint)` in batch Emacs, where the oracle
//! can only compare the report buffer's text.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

/// The reports E8 makes on `text`, visited as `name` in a fresh directory, one `line|trust|message|checker` a line.
fn reports(name: &str, text: &str) -> String {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(name);
    std::fs::write(&file, text).unwrap();
    // No ID locations kept from other runs.
    ed.set_variable("org-id-locations-file", Value::Str(dir.path().join(".org-id-locations").to_str().unwrap().into()));
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    let out = s
        .eval_expression(
            &mut ed,
            r#"(e8.require("org-lint"), (e8.funcall("org-lint--generate-reports", e8.bufferName()) as e8.Value[][]).map((r) => r.join("|")).join("\n"))"#,
        )
        .unwrap();
    serde_json::from_str::<String>(&out).unwrap()
}

fn compare(got: &str, expected: &str) {
    let missing: Vec<&str> = expected.lines().filter(|l| !got.lines().any(|g| g == *l)).collect();
    let extra: Vec<&str> = got.lines().filter(|l| !expected.lines().any(|e| e == *l)).collect();
    assert!(missing.is_empty() && extra.is_empty(), "missing:\n{}\n\nextra:\n{}", missing.join("\n"), extra.join("\n"));
    assert_eq!(got, expected.trim_end());
}

#[test]
fn each_checker_reports_as_org_does() {
    compare(&reports("lint-sample.org", include_str!("../data/org-lint/lint-sample.org")), include_str!("../data/org-lint/lint-sample.reports"));
}

/// The rest of the checkers' messages. Emacs also reports LATEX_CLASS as a
/// LaTeX and Beamer export option, as it has those backends; E8 has not,
/// so that line is left out of what it expects.
#[test]
fn more_reports_as_org_makes_them() {
    compare(&reports("lint-more.org", include_str!("../data/org-lint/lint-more.org")), include_str!("../data/org-lint/lint-more.reports"));
}

#[test]
fn a_clean_file_reports_nothing() {
    assert_eq!(reports("clean.org", "#+TITLE: Clean\n\n* Heading\nSome text.\n"), "");
}

/// A package's own checker, added as org-lint-add-checker adds one, reports with the rest.
#[test]
fn a_package_adds_a_checker() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* TODO fix\n* Done\n");
    ed.call("org-mode", vec![]).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"e8.require("org-lint");
           e8.funcall("org-lint-add-checker", e8.intern("todo-left"), "Report TODO headings", (_ast: unknown) => [[0, "A TODO is left"]], e8.intern(":trust"), e8.intern("high"), e8.intern(":categories"), [e8.intern("mine")]);"#
            .to_string(),
    )
    .unwrap();
    let out = s
        .eval_expression(&mut ed, r#"(e8.funcall("org-lint--generate-reports", e8.bufferName(), [e8.intern("todo-left")]) as e8.Value[][]).map((r) => r.join("|")).join("\n")"#)
        .unwrap();
    assert_eq!(out, r#""1|high|A TODO is left|todo-left""#);
}
