//! org-goto, on a driver as its recursive edit waits for keys (ADR 0053),
//! and isearch opening Org's folds, which org-goto's typing searches in.
//! The oracle's org-goto, isearch and hideshow cases check the rest.

use crate::driven::Driven;

const NOTES: &str = "#+TITLE: Notes\n* Project\nMentions beta here.\n** Task A :work:\ntext a\n** Task B\ntext b\n*** Deep\ndeep text\n* Beta things\n* Other :beta:\nother text\n";

fn org(text: &str) -> Driven {
    let d = Driven::new("");
    let text = text.to_string();
    d.with(move |ed| {
        ed.window_buffer_mut().set_text(&text);
        ed.call("org-mode", Vec::new()).unwrap();
        ed.window_buffer_mut().set_point(0);
    });
    d
}

/// The overlays that hide text, as [start, end] pairs.
fn folds(d: &Driven) -> String {
    d.eval_expression(r#"JSON.stringify(e8.overlaysIn(0, e8.pointMax()).filter((o) => e8.overlayGet(o, "invisible")).map((o) => [e8.overlayStart(o), e8.overlayEnd(o)]))"#)
}

#[test]
fn quitting_isearch_hides_the_fold_it_opened() {
    let d = org("* One\nalpha text\n** Sub\nneedle here\n* Two\n");
    d.press("S-TAB");
    let folded = folds(&d);
    d.press("C-s n e e d l e");
    assert_eq!(d.point(), 30);
    assert_eq!(d.eval_expression("e8.invisibleAt(25)"), "false", "the match shows while the search is in it");
    d.press("C-g");
    assert_eq!(d.point(), 0);
    assert_eq!(folds(&d), folded, "C-g leaves the folds as they were");
}

#[test]
fn org_goto_types_to_search_again_after_a_goto_without() {
    // org-goto-map is made afresh for each org-goto, as Emacs's is: the
    // single-key bindings of a goto with org-goto-auto-isearch off must not
    // keep the typing of the next from searching.
    let d = org(NOTES);
    d.eval(r#"e8.setVariable("org-goto-auto-isearch", false);"#);
    d.press("C-c C-j n q");
    assert_eq!(d.message().as_deref(), Some("Quit"));
    assert_eq!(d.buffer_name(), "*scratch*");
    d.eval(r#"e8.setVariable("org-goto-auto-isearch", true);"#);
    d.press("C-c C-j");
    assert_eq!(d.buffer_name(), "*org-goto*");
    d.press("b");
    assert_eq!(d.message().as_deref(), Some("I-search: b"));
    d.press("e t a RET RET");
    assert_eq!(d.buffer_name(), "*scratch*");
    assert_eq!(d.point(), 111, "at Beta things, the first heading with beta before its tags");
}

#[test]
fn org_goto_leaves_no_copy_or_help_behind() {
    let d = org(NOTES);
    d.press("C-c C-j <down> RET");
    let buffers = d.eval_expression("JSON.stringify(e8.bufferList())");
    assert!(!buffers.contains("*org-goto*"), "{buffers}");
    assert_eq!(d.eval_expression("e8.windowList().length"), "1");
    // And again, a C-g one.
    d.press("C-c C-j C-g");
    assert_eq!(d.message().as_deref(), Some("Quit"));
    assert_eq!(d.eval_expression("e8.windowList().length"), "1");
}
