//! Org export, C-c C-e: what the oracle's export cases cannot show, as
//! the dispatcher's keys, TypeScript blocks run for their results, a
//! user's filters and derived backends, #+INCLUDE and files written.

use e8_core::{Editor, Value};
use e8_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_variable("org-confirm-babel-evaluate", Value::Bool(false));
    ed.set_variable("user-full-name", Value::Str("A. Writer".into()));
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The text of a buffer by name.
fn buffer_text(ed: &mut Editor, name: &str) -> String {
    let id = ed.find_buffer(name).unwrap_or_else(|| panic!("no buffer {name}"));
    let b = &ed.buffers()[id];
    b.slice(0..b.len())
}

#[test]
fn the_dispatcher_exports_to_a_buffer_and_shows_it() {
    let (mut ed, _s) = org("#+TITLE: T\n#+OPTIONS: toc:nil author:nil\n* One\nText.\n");
    ed.press("C-c C-e t A").unwrap();
    assert_eq!(ed.window_buffer().name, "*Org ASCII Export*");
    // As Emacs 30's Org 9.7 exports it.
    assert_eq!(text(&ed), "                                  ___\n\n                                   T\n                                  ___\n\n\n1 One\n=====\n\n  Text.\n");
    // The dispatcher's own buffer is gone.
    assert!(ed.find_buffer("*Org Export Dispatcher*").is_none());
}

#[test]
fn c_u_c_c_c_e_repeats_the_last_export() {
    let (mut ed, _s) = org("#+OPTIONS: toc:nil author:nil\n* One\n");
    ed.press("C-c C-e C-b t U").unwrap();
    ed.press("C-x o").unwrap();
    ed.window_buffer_mut().set_text("#+OPTIONS: toc:nil author:nil\n* Two\n");
    ed.press("C-u C-c C-e").unwrap();
    assert_eq!(buffer_text(&mut ed, "*Org ASCII Export*"), "1 Two\n═════\n");
}

#[test]
fn q_leaves_the_dispatcher() {
    let (mut ed, _s) = org("* One\n");
    ed.press("C-c C-e q").unwrap();
    assert_eq!(ed.echo(), Some("Export aborted"));
    assert!(ed.find_buffer("*Org Export Dispatcher*").is_none());
}

#[test]
fn typescript_blocks_run_for_their_results_and_none_leaves_a_block_out() {
    let (mut ed, _s) = org(
        "#+OPTIONS: toc:nil author:nil\n#+begin_src typescript :exports results\n6 * 7\n#+end_src\n\n#+begin_src typescript :exports none\nsecret\n#+end_src\nEnd.\n",
    );
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    // As Emacs exports an Emacs Lisp block of the same value.
    assert_eq!(text(&ed), ",----\n| 42\n`----\n\n\nEnd.\n");
}

#[test]
fn a_lisp_macro_is_an_error() {
    let (mut ed, _s) = org("#+MACRO: two (eval (+ 1 1))\n{{{two}}}\n");
    let err = ed.call("org-ascii-export-as-ascii", vec![]).unwrap_err().to_string();
    assert!(err.contains("Lisp"), "{err}");
}

#[test]
fn options_written_as_lisp_data_are_read() {
    let (mut ed, _s) = org(
        "#+OPTIONS: toc:nil author:nil d:(\"NOTES\") ^:{}\n* H\n:NOTES:\nkept\n:END:\n:LOGBOOK:\ngone\n:END:\na_b and a_{b}\n",
    );
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "1 H\n===\n\n  kept\n  a_b and a_{b}\n");
}

#[test]
fn a_derived_backend_and_a_filter_of_ones_own() {
    let dir = tempfile::tempdir().unwrap();
    let module = dir.path().join("shout.ts");
    std::fs::write(
        &module,
        "import { defineDerivedBackend, stringAs } from \"ox\";\n\
         e8.require(\"ox-ascii\");\n\
         defineDerivedBackend(\"shout\", \"ascii\", { translate: { bold: (_b: unknown, c: string) => c.toUpperCase() } });\n\
         e8.defun(\"shout-export\", (s: string) => stringAs(s, \"shout\", true, { \"with-toc\": false }));\n",
    )
    .unwrap();
    let (mut ed, s) = org("");
    s.load_module(&mut ed, &module).unwrap();
    let out = s.eval_expression(&mut ed, "e8.funcall(\"shout-export\", \"Say *loud* things.\")").unwrap();
    assert_eq!(out, "\"Say LOUD things.\\n\"");
}

#[test]
fn include_brings_in_a_file_at_the_level_asked() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("part.org"), "* Part\nIncluded text.\n").unwrap();
    let (mut ed, _s) = org(&format!(
        "#+OPTIONS: toc:nil author:nil num:nil\n* Main\n#+INCLUDE: \"{}\" :minlevel 2\n",
        dir.path().join("part.org").display()
    ));
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "Main\n====\n\nPart\n~~~~\n\n  Included text.\n");
}

#[test]
fn exporting_to_a_file_writes_it_beside_the_org_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.org");
    std::fs::write(&file, "#+OPTIONS: toc:nil author:nil\n* Note\nBody.\n").unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![e8_core::Arg::Str(file.display().to_string())]).unwrap();
    ed.call("org-md-export-to-markdown", vec![]).unwrap();
    let md = std::fs::read_to_string(dir.path().join("notes.md")).unwrap();
    // As Emacs writes it: the output ends in a blank line.
    assert_eq!(md, "\n\n# Note\n\nBody.\n\n");
}

// From the review: each as Emacs 30's Org 9.7 exports the same text.

#[test]
fn visible_only_leaves_out_folded_text() {
    let (mut ed, _s) = org("#+OPTIONS: toc:nil author:nil\n* A\nshown\n* B\nhidden\n** C\nalso hidden\n");
    let b = text(&ed).find("* B").unwrap();
    ed.window_buffer_mut().set_point(b);
    ed.press("TAB").unwrap();
    ed.window_buffer_mut().set_point(0);
    ed.press("C-c C-e C-v t A").unwrap();
    assert_eq!(text(&ed), "1 A\n===\n\n  shown\n\n\n2 B\n===\n");
}

#[test]
fn a_property_macro_reads_its_own_entry() {
    let (mut ed, _s) = org("#+OPTIONS: toc:nil author:nil\n* A\n:PROPERTIES:\n:X: 1\n:END:\nValue {{{property(X)}}}.\n* B\n:PROPERTIES:\n:X: 2\n:END:\nValue {{{property(X)}}}.\n");
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "1 A\n===\n\n  Value 1.\n\n\n2 B\n===\n\n  Value 2.\n");
}

#[test]
fn macro_arguments_are_trimmed_and_captions_expand_theirs() {
    let (mut ed, _s) = org("#+OPTIONS: toc:nil author:nil\n#+MACRO: greet Hello, $1!\n{{{greet(  big   World )}}}\n\n#+CAPTION: Table {{{n(t)}}}\n| a |\n");
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "Hello, big World!\n\n a \nTable 1: Table 1\n");
}

#[test]
fn never_export_blocks_do_not_run() {
    let (mut ed, _s) = org("#+OPTIONS: toc:nil author:nil\n#+begin_src typescript :exports results :eval never-export\n6 * 7\n#+end_src\nEnd.\n");
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "End.\n");
}

#[test]
fn includes_take_their_levels_before_any_is_expanded() {
    let dir = tempfile::tempdir().unwrap();
    let one = dir.path().join("one.org");
    let two = dir.path().join("two.org");
    std::fs::write(&one, "* X\n** Y\nunder y\n").unwrap();
    std::fs::write(&two, "* Z\nunder z\n").unwrap();
    let (mut ed, _s) = org(&format!(
        "#+OPTIONS: toc:nil author:nil num:nil\n* A\n#+INCLUDE: \"{}\"\n#+INCLUDE: \"{}\"\n",
        one.display(),
        two.display()
    ));
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "A\n=\n\nX\n~\n\nY\n-\n\n  under y\n\n\nZ\n~\n\n  under z\n");
}

#[test]
fn an_included_section_keeps_a_footnote_defined_outside_it() {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes.org");
    std::fs::write(&notes, "* Part\nText[fn:1].\n* Other\nmore\n* Footnotes\n[fn:1] The note.\n").unwrap();
    let (mut ed, _s) = org(&format!("#+OPTIONS: toc:nil author:nil num:nil\n* Main\n#+INCLUDE: \"{}::*Part\"\n", notes.display()));
    ed.call("org-ascii-export-as-ascii", vec![]).unwrap();
    assert_eq!(text(&ed), "Main\n====\n\nPart\n~~~~\n\n  Text[1].\n\n\n\nFootnotes\n_________\n\n[1] The note.\n");
}

#[test]
fn the_template_for_a_subtree_sets_its_export_properties() {
    let (mut ed, _s) = org("* H\nbody\n");
    ed.window_buffer_mut().set_point(3);
    // As the dispatcher's C-s # calls it, the backend's options asked for.
    ed.call("org-export-insert-default-template", vec![e8_core::Arg::Str("default".into()), e8_core::Arg::Str("t".into())]).unwrap();
    let t = text(&ed);
    assert!(t.starts_with("* H\n:PROPERTIES:\n:EXPORT_OPTIONS: "), "{t}");
    assert!(t.contains(":EXPORT_TITLE: H\n") || t.contains(":EXPORT_TITLE:"), "{t}");
    assert!(t.ends_with(":END:\nbody\n"), "{t}");
}
