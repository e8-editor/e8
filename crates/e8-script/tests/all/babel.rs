//! Running Org's source blocks, C-c C-c, and loading a literate
//! configuration, org-babel-load-file, with what Emacs 30 gives for
//! Emacs Lisp blocks of the same values.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_variable("org-confirm-babel-evaluate", e8_core::Value::Bool(false));
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The buffer after C-c C-c in a block of `body`, as the block and what follows it.
fn run(body: &str) -> String {
    let (mut ed, _s) = org(&format!("* H\n#+begin_src typescript\n{body}\n#+end_src\nafter\n"));
    ed.window_buffer_mut().set_point(5);
    ed.press("C-c C-c").unwrap();
    text(&ed).trim_start_matches("* H\n#+begin_src typescript\n").to_string()
}

#[test]
fn c_c_c_c_puts_a_block_s_value_under_it_as_emacs_does() {
    // What Emacs 30 puts under emacs-lisp blocks giving the same values.
    assert_eq!(run("e8.message(\"x\");\n40 + 2"), "e8.message(\"x\");\n40 + 2\n#+end_src\n\n#+RESULTS:\n: 42\n\nafter\n");
    assert_eq!(run("\"hi\""), "\"hi\"\n#+end_src\n\n#+RESULTS:\n: hi\n\nafter\n");
    assert_eq!(run("const x: number = 1;"), "const x: number = 1;\n#+end_src\n\n#+RESULTS:\n\nafter\n");
    assert_eq!(run("true"), "true\n#+end_src\n\n#+RESULTS:\n: t\n\nafter\n");
    assert_eq!(run("3.5"), "3.5\n#+end_src\n\n#+RESULTS:\n: 3.5\n\nafter\n");
    assert_eq!(run("[1, 2, 3]"), "[1, 2, 3]\n#+end_src\n\n#+RESULTS:\n| 1 | 2 | 3 |\n\nafter\n");
    assert_eq!(run("[[1, 2], [3, 4]]"), "[[1, 2], [3, 4]]\n#+end_src\n\n#+RESULTS:\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n");
    assert_eq!(run("[1, \"two\", null]"), "[1, \"two\", null]\n#+end_src\n\n#+RESULTS:\n| 1 | two | nil |\n\nafter\n");
    assert_eq!(run("\"a\\nb\""), "\"a\\nb\"\n#+end_src\n\n#+RESULTS:\n: a\n: b\n\nafter\n");
    let twelve: String = (1..=12).map(|n| format!("{n}\n")).collect();
    assert_eq!(
        run("Array.from({ length: 12 }, (_, i) => i + 1).join(\"\\n\")"),
        format!("Array.from({{ length: 12 }}, (_, i) => i + 1).join(\"\\n\")\n#+end_src\n\n#+RESULTS:\n#+begin_example\n{twelve}#+end_example\n\nafter\n"),
    );
}

#[test]
fn running_again_replaces_the_results_and_names_go_with_them() {
    // As Emacs 30 gives it: the named block's results replaced, :results
    // silent only shown, none not even that.
    let (mut ed, _s) = org(
        "#+name: foo\n#+begin_src typescript\n1\n#+end_src\n\n#+RESULTS: foo\n: 0\n\nafter\n\
         #+begin_src typescript :results silent\n7\n#+end_src\n#+begin_src typescript :results none\n8\n#+end_src\n",
    );
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.echo(), Some("Code block evaluation complete."));
    ed.press("C-s s i l e n t RET C-c C-c").unwrap();
    assert_eq!(ed.echo(), Some("\"7\""));
    ed.press("C-s n o n e RET C-c C-c").unwrap();
    assert_eq!(
        text(&ed),
        "#+name: foo\n#+begin_src typescript\n1\n#+end_src\n\n#+RESULTS: foo\n: 1\n\nafter\n\
         #+begin_src typescript :results silent\n7\n#+end_src\n#+begin_src typescript :results none\n8\n#+end_src\n",
    );
    // A table result replaces a fixed-width one, and back, aligned as Org aligns tables.
    let (mut ed, _s) = org("#+begin_src typescript\n[[1, 22], [333, 4]]\n#+end_src\n\n#+RESULTS:\n: old\n: lines\ntext\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "#+begin_src typescript\n[[1, 22], [333, 4]]\n#+end_src\n\n#+RESULTS:\n|   1 | 22 |\n| 333 |  4 |\ntext\n");
}

#[test]
fn a_block_runs_only_once_allowed() {
    let (mut ed, _s) = org("#+begin_src typescript\n42\n#+end_src\n");
    ed.set_variable("org-confirm-babel-evaluate", e8_core::Value::Bool(true));
    ed.press("C-c C-c n o RET").unwrap();
    assert_eq!(ed.echo(), Some("Evaluation of this typescript code block is aborted."));
    assert_eq!(text(&ed), "#+begin_src typescript\n42\n#+end_src\n");
    ed.press("C-c C-c y e s RET").unwrap();
    assert_eq!(text(&ed), "#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS:\n: 42\n");
    // :eval no keeps it from running at all.
    let (mut ed, _s) = org("#+begin_src typescript :eval no\n42\n#+end_src\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.echo(), Some("Evaluation of this typescript code block is disabled."));
    // A language with no org-babel-execute function is an error, as in Emacs.
    let (mut ed, _s) = org("#+begin_src cobol\nx\n#+end_src\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.echo(), Some("No org-babel-execute function for cobol!"));
}

#[test]
fn eval_typescript_gives_the_last_value_and_keeps_declarations_its_own() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let got = s
        .eval_expression(&mut ed, r#"[e8.evalTypescript("const a: number = 2; a * 21"), e8.evalTypescript("const a = 1; a"), e8.evalTypescript("let b = 1;")]"#)
        .unwrap();
    assert_eq!(got, "[42,1,null]");
}

#[test]
fn org_babel_load_file_tangles_typescript_when_newer_and_loads_it() {
    // As Emacs's org-babel-load-file with Emacs Lisp: only the language's
    // blocks, all of them unless :tangle no or under a COMMENT heading,
    // into FILE.ts, tangled again only when the Org file is newer.
    let dir = tempfile::tempdir().unwrap();
    let org_file = dir.path().join("config.org");
    std::fs::write(
        &org_file,
        "#+TITLE: Config\n* Basics\nWhy.\n#+begin_src typescript\nconst n: number = 2;\ne8.setVariable(\"fill-column\", 60 + n);\n#+end_src\n\
         #+begin_src emacs-lisp\n(setq x 1)\n#+end_src\n* COMMENT Off\n#+begin_src typescript\ne8.setVariable(\"fill-column\", 1);\n#+end_src\n\
         * Keys\n#+begin_src typescript :tangle no\ne8.setVariable(\"fill-column\", 2);\n#+end_src\n#+begin_src ts\ne8.setVariable(\"tab-width\", n + 1);\n#+end_src\n",
    )
    .unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.call("org-babel-load-file", vec![Arg::Str(org_file.display().to_string())]).unwrap();
    let tangled = dir.path().join("config.ts");
    assert_eq!(
        std::fs::read_to_string(&tangled).unwrap(),
        "const n: number = 2;\ne8.setVariable(\"fill-column\", 60 + n);\n\ne8.setVariable(\"tab-width\", n + 1);\n",
    );
    assert_eq!(ed.variable("fill-column"), Some(e8_core::Value::Number(62.0)));
    assert_eq!(ed.variable("tab-width"), Some(e8_core::Value::Number(3.0)));
    assert!(ed.echo().is_some_and(|m| m.starts_with("Loaded ") && m.ends_with("config.ts")), "{:?}", ed.echo());
    // Not tangled again while config.ts is newer: a change made to it stays.
    std::fs::write(&tangled, "e8.setVariable(\"tab-width\", 5);\n").unwrap();
    ed.call("org-babel-load-file", vec![Arg::Str(org_file.display().to_string())]).unwrap();
    assert_eq!(ed.variable("tab-width"), Some(e8_core::Value::Number(5.0)));
    // Once the Org file is newer, it is.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
    std::fs::File::options().write(true).open(&org_file).unwrap().set_modified(later).unwrap();
    ed.call("org-babel-load-file", vec![Arg::Str(org_file.display().to_string())]).unwrap();
    assert_eq!(ed.variable("tab-width"), Some(e8_core::Value::Number(3.0)));
}

#[test]
fn tangle_file_takes_a_target_and_a_language_regexp() {
    let dir = tempfile::tempdir().unwrap();
    let org_file = dir.path().join("notes.org");
    std::fs::write(&org_file, "#+begin_src python\nprint(1)\n#+end_src\n#+begin_src typescript\n1;\n#+end_src\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let out = dir.path().join("out.py");
    // As Emacs's (org-babel-tangle-file FILE TARGET-FILE LANG-RE), from a module, which can import it.
    let script = dir.path().join("t.ts");
    std::fs::write(&script, format!("import {{ tangleFile }} from \"ob-tangle\";\ntangleFile({:?}, {:?}, \"python\");\n", org_file.display().to_string(), out.display().to_string())).unwrap();
    s.load_module(&mut ed, &script).unwrap();
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "print(1)\n");
    // With the file alone, as before, blocks with no :tangle stay where they are.
    ed.call("org-babel-tangle-file", vec![Arg::Str(org_file.display().to_string())]).unwrap();
    assert_eq!(ed.echo(), Some("Tangled 0 code blocks from notes.org"));
}

/// The buffer after C-c C-c in its first block.
fn run_first(text: &str) -> String {
    let (mut ed, _s) = org(text);
    ed.window_buffer_mut().set_point(0);
    ed.press("C-s # + b e g i n _ s r c RET C-c C-c").unwrap();
    self::text(&ed)
}

#[test]
fn results_go_where_emacs_puts_them() {
    // Each as Emacs 30 leaves it after C-c C-c in an emacs-lisp block of the same value.
    // A block that never closes after #+RESULTS: is no result: nothing is taken.
    assert_eq!(
        run_first("#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS:\n#+begin_quote\nfoo\n\n* H\nbody\n"),
        "#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS:\n: 42\n#+begin_quote\nfoo\n\n* H\nbody\n",
    );
    // A named block's results are found by name, not in an unnamed #+RESULTS: below it.
    assert_eq!(
        run_first("#+name: foo\n#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS:\n: 1\n\nafter\n"),
        "#+name: foo\n#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS: foo\n: 42\n\n#+RESULTS:\n: 1\n\nafter\n",
    );
    // No second blank line before one that is there, or at the end.
    assert_eq!(
        run_first("#+begin_src typescript\n42\n#+end_src\n\n* Next\n"),
        "#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS:\n: 42\n\n* Next\n",
    );
    assert_eq!(run_first("#+begin_src typescript\n42\n#+end_src\n"), "#+begin_src typescript\n42\n#+end_src\n\n#+RESULTS:\n: 42\n");
    // Indented as the block is, so they stay in the item.
    assert_eq!(
        run_first("- item\n  #+begin_src typescript\n  42\n  #+end_src\n"),
        "- item\n  #+begin_src typescript\n  42\n  #+end_src\n\n  #+RESULTS:\n  : 42\n",
    );
    // An empty string is no lines.
    assert_eq!(run_first("#+begin_src typescript\n\"\"\n#+end_src\nafter\n"), "#+begin_src typescript\n\"\"\n#+end_src\n\n#+RESULTS:\n\nafter\n");
    // :results append and prepend keep what is there.
    assert_eq!(
        run_first("#+begin_src typescript :results append\n42\n#+end_src\n\n#+RESULTS:\n: 1\n\nafter\n"),
        "#+begin_src typescript :results append\n42\n#+end_src\n\n#+RESULTS:\n: 1\n: 42\n\nafter\n",
    );
    assert_eq!(
        run_first("#+begin_src typescript :results prepend\n42\n#+end_src\n\n#+RESULTS:\n: 1\n\nafter\n"),
        "#+begin_src typescript :results prepend\n42\n#+end_src\n\n#+RESULTS:\n: 42\n: 1\n\nafter\n",
    );
}

#[test]
fn blocks_and_loaded_files_can_import_packages() {
    // A block that imports runs as a module, as eval-region runs one, and gives no value.
    let (mut ed, _s) = org("#+begin_src typescript\nimport { truthy } from \"subr\";\ne8.setVariable(\"fill-column\", truthy(1) ? 33 : 0);\n#+end_src\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.variable("fill-column"), Some(e8_core::Value::Number(33.0)));
    assert_eq!(ed.echo(), Some("Code block produced no output."));
    // And a literate config's file, loaded again each time.
    let dir = tempfile::tempdir().unwrap();
    let org_file = dir.path().join("config.org");
    std::fs::write(&org_file, "#+begin_src typescript\nimport { truthy } from \"subr\";\ne8.setVariable(\"tab-width\", (e8.variable(\"tab-width\") as number) + (truthy(1) ? 1 : 0));\n#+end_src\n").unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    let width = |ed: &Editor| ed.variable("tab-width");
    let before = width(&ed).and_then(|v| if let e8_core::Value::Number(n) = v { Some(n) } else { None }).unwrap();
    ed.call("org-babel-load-file", vec![Arg::Str(org_file.display().to_string())]).unwrap();
    ed.call("org-babel-load-file", vec![Arg::Str(org_file.display().to_string())]).unwrap();
    assert_eq!(width(&ed), Some(e8_core::Value::Number(before + 2.0)));
}

/// With :noweb yes, C-c C-c runs the block with its references expanded:
/// a named block's code, and with () its value.
#[test]
fn noweb_references_are_expanded_when_running() {
    let (mut ed, _s) = org("* H\n#+name: two\n#+begin_src typescript\n1 + 1\n#+end_src\n\n#+begin_src typescript :noweb yes\n(<<two>>) * 10 + <<two()>>\n#+end_src\n");
    let at = text(&ed).find("(<<two>>)").unwrap();
    ed.window_buffer_mut().set_point(at);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert!(text(&ed).ends_with("#+RESULTS:\n: 22\n"), "{}", text(&ed));
}

/// A reference that resolves to nothing is an error for the languages
/// org-babel-noweb-error-langs names, else nothing.
#[test]
fn unresolved_references() {
    let (mut ed, s) = org("* H\n#+begin_src typescript :noweb yes\n1 <<nothing>>\n#+end_src\n");
    ed.window_buffer_mut().set_point(5);
    ed.press("C-c C-c").unwrap();
    assert!(text(&ed).contains("#+RESULTS:\n: 1\n"), "{}", text(&ed));
    s.eval_typescript(&mut ed, "t.ts", r#"e8.setVariable("org-babel-noweb-error-langs", ["typescript"]);"#.to_string()).unwrap();
    ed.window_buffer_mut().set_point(5);
    ed.press("C-c C-c").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), Some("Cannot resolve <<nothing>> (see \u{2018}org-babel-noweb-error-langs\u{2019})".into()));
}
