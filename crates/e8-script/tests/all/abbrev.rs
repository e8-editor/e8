//! Listing abbrevs as Emacs lists them, and editing them in *Abbrevs*.
//! Emacs's listing has every mode's table, so the Emacs comparison cannot
//! check it; the global table's text here is what Emacs 30.2 writes.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn text_of(ed: &mut Editor, s: &Scripting, buffer: &str) -> String {
    let got = s.eval_expression(ed, &format!("e8.withCurrentBuffer({buffer:?}, () => e8.bufferText(0, e8.bufferSize()))")).unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn list_abbrevs_writes_them_as_emacs_does_and_edits_come_back() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    for (name, expansion) in [("fb", "foobar"), ("longname", "x y z")] {
        ed.call("define-global-abbrev", vec![Arg::Str(name.into()), Arg::Str(expansion.into())]).unwrap();
    }
    ed.type_text("fb");
    ed.press("C-x '").unwrap();
    ed.call("list-abbrevs", vec![]).unwrap();
    let listed = text_of(&mut ed, &s, "*Abbrevs*");
    assert_eq!(listed, "(global-abbrev-table)\n\n\"fb\"\t       1    \"foobar\"\n\"longname\"     0    \"x y z\"\n\n\n");
    // Edited there, C-c C-c makes them the abbrevs.
    ed.call("switch-to-buffer", vec![Arg::Str("*Abbrevs*".into())]).unwrap();
    s.eval_expression(&mut ed, r#"e8.gotoChar(e8.search('"x y z"').start + 1)"#).unwrap();
    ed.press("C-d").unwrap();
    ed.type_text("w");
    ed.press("C-c C-c").unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("*scratch*".into())]).unwrap();
    ed.press("M->").unwrap();
    ed.type_text(" longname");
    ed.press("C-x '").unwrap();
    assert!(text_of(&mut ed, &s, "*scratch*").ends_with("w y z"));
}

/// write-abbrev-file writes what Emacs 30.2's writes for the same abbrevs
/// (tests/emacs/abbrev_defs, written by tests/emacs/abbrev-file.el), and
/// read-abbrev-file reads Emacs's file back.
#[test]
fn the_abbrev_file_is_emacs_s() {
    let emacs = include_str!("../../../../tests/emacs/abbrev_defs");
    let dir = std::env::temp_dir().join(format!("e8-abbrevs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("abbrev_defs");
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(
        &mut ed,
        &format!(
            r#"(e8.setDefault("abbrev-file-name", {file:?}),
                e8.call("define-global-abbrev", "afaik", "as far as I know"),
                e8.call("define-global-abbrev", "q", 'say "hi" \\ there'),
                e8.call("switch-to-buffer", "t"), e8.call("text-mode"),
                e8.call("define-mode-abbrev", "teh", "the"),
                e8.call("define-mode-abbrev", "smorg", "smörgåsbord"), 0)"#,
            file = file.display().to_string()
        ),
    )
    .unwrap();
    // teh used three times.
    for _ in 0..3 {
        ed.type_text("teh");
        ed.press("C-x '").unwrap();
        ed.type_text(" ");
    }
    ed.call("write-abbrev-file", vec![Arg::Str(String::new())]).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), emacs);
    // Read back from Emacs's file into an editor without them.
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    std::fs::write(&file, emacs).unwrap();
    ed.call("read-abbrev-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.call("write-abbrev-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), emacs);
    assert_eq!(s.eval_expression(&mut ed, "e8.variable('abbrevs-changed')").unwrap(), "false");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A mode's abbrevs work in the modes built on it, as define-derived-mode
/// makes the parent's table the child's parent: text-mode's in Org.
#[test]
fn a_mode_inherits_its_parent_mode_s_abbrevs() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_expression(&mut ed, r#"(e8.call("switch-to-buffer", "t"), e8.call("text-mode"), e8.call("define-mode-abbrev", "teh", "the"), e8.call("switch-to-buffer", "o"), e8.call("org-mode"), 0)"#).unwrap();
    ed.type_text("teh");
    ed.press("C-x '").unwrap();
    assert_eq!(text_of(&mut ed, &s, "o"), "the");
}

/// Changed abbrevs are offered for saving by save-some-buffers, as
/// abbrev--possibly-save on save-some-buffers-functions does, once.
#[test]
fn save_some_buffers_offers_to_save_changed_abbrevs() {
    let dir = std::env::temp_dir().join(format!("e8-abbrevs-save-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("abbrev_defs");
    let d = crate::driven::Driven::new(&format!("e8.setDefault('abbrev-file-name', {:?});", file.display().to_string()));
    d.with(|ed| ed.call("define-global-abbrev", vec![Arg::Str("fb".into()), Arg::Str("foobar".into())]).unwrap());
    d.press("C-x s");
    assert_eq!(d.prompt(), Some(format!("Save abbrevs in {}? (y or n) ", file.display())));
    d.press("y");
    assert!(std::fs::read_to_string(&file).unwrap().contains(r#"("fb" "foobar" nil :count 0)"#));
    // Saved, so not asked again.
    d.press("C-x s");
    assert_eq!(d.prompt(), None);
    assert_eq!(d.message().as_deref(), Some("(No files need saving)"));
    let _ = std::fs::remove_dir_all(&dir);
}
