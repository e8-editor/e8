//! org-lint's checkers on files with mistakes for them, as Emacs 30.2's
//! org-lint.el reports them on the same files: each report's line, trust,
//! message and checker, from `(org-lint)` in batch Emacs, where the oracle
//! can only compare the report buffer's text.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

/// The reports E8 makes on `text`, visited as `name` in a fresh directory, one `line|trust|message|checker` a line.
fn reports(name: &str, text: &str) -> String {
    reports_with(name, text, &[])
}

/// As [reports], with other files beside it.
fn reports_with(name: &str, text: &str, others: &[(&str, &str)]) -> String {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (other, contents) in others {
        std::fs::write(dir.path().join(other), contents).unwrap();
    }
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

/// What the review found: INCLUDE search parts as org-link-search takes
/// them, header-args and Results without case, ATTR_ORG's attributes
/// without case, numbers printed as Lisp prints them, a bracket that
/// does not open a group in a header, a string read as Lisp reads it, and
/// macros from real keywords and a setup file. Emacs also reports go as an
/// unknown language, where E8 has a mode for it (go-mode, an alias of
/// go-ts-mode), so that line is left out of what E8 expects.
#[test]
fn the_reviews_reports_as_org_makes_them() {
    let d = |f: &str| std::fs::read_to_string(format!("{}/tests/data/org-lint/{f}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    compare(
        &reports_with("lint-review.org", &d("lint-review.org"), &[("target.org", &d("target.org")), ("setup.org", &d("setup.org"))]),
        &d("lint-review.reports"),
    );
}

/// An incomplete citation in a heading with nothing under it is reported
/// on the heading's line. Emacs fails there, its title having no
/// contents-begin.
#[test]
fn an_incomplete_citation_in_a_heading_is_on_its_line() {
    assert_eq!(reports("cite.org", "#+TITLE: x\n\n* Heading [cite:@y\n* Next\n"), "3|low|Possibly incomplete citation markup|incomplete-citation");
}

/// A file of a few thousand entries, each scheduled, due, with properties
/// and a logbook, is checked well within the script limit: Emacs took 12 s
/// of CPU for 10,000 such entries. The bound is generous for QuickJS on a
/// loaded machine.
#[test]
fn a_big_file_is_checked_in_time() {
    let text: String = (0..2000)
        .map(|i| format!("* TODO Entry {i}\nSCHEDULED: <2026-11-28 Sat> DEADLINE: <2026-11-30 Mon>\n:PROPERTIES:\n:ID: id-{i}\n:END:\n:LOGBOOK:\n- Note taken on [2026-11-27 Fri 10:00]\n:END:\nSome text {{{{{{macro}}}}}}.\n"))
        .collect();
    let started = std::time::Instant::now();
    let out = reports("big.org", &format!("#+MACRO: macro m\n{text}"));
    let took = started.elapsed();
    eprintln!("checking 2000 entries took {took:?}");
    assert_eq!(out, "");
    let budget = if std::env::var("CI").is_ok() { 3 } else { 1 };
    assert!(took < std::time::Duration::from_secs(30 * budget), "took {took:?}");
}
