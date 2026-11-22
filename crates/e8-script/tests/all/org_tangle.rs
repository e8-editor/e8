//! Tangling what the Emacs oracle does not record: a narrowed buffer, a
//! block that names itself, and references with IDs not tracked.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn visit(text: &str) -> (Editor, Scripting, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.org");
    std::fs::write(&file, text).unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", dir.path().display())));
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    (ed, s, dir)
}

/// Narrowed, only the blocks it shows are tangled, as Org's.
#[test]
fn a_narrowed_buffer_tangles_what_it_shows() {
    let (mut ed, _s, dir) = visit("* One\n#+begin_src emacs-lisp :tangle out.el\n(one)\n#+end_src\n* Two\n#+begin_src emacs-lisp :tangle out.el\n(two)\n#+end_src\n");
    ed.press("M-> C-p C-p C-x n s C-c C-v t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(std::fs::read_to_string(dir.path().join("out.el")).unwrap(), "(two)\n");
}

/// A block that names itself fails, as Lisp's nesting runs out, and does not hang.
#[test]
fn a_block_naming_itself() {
    let (mut ed, _s, _dir) = visit("* H\n#+name: me\n#+begin_src emacs-lisp :tangle out.el :noweb yes\n(<<me>>)\n#+end_src\n");
    ed.press("C-c C-v t").unwrap();
    let err = ed.take_error().map(|e| e.to_string()).unwrap_or_default();
    assert!(err.contains("max-lisp-eval-depth"), "{err}");
}

/// A reference that is no ID does not need IDs tracked, nor scans files for them.
#[test]
fn references_without_ids_tracked() {
    let (mut ed, _s, dir) = visit("* H\n#+name: x\n#+begin_src emacs-lisp\n(x)\n#+end_src\n#+begin_src emacs-lisp :tangle out.el :noweb yes\n(a <<x>>)\n#+end_src\n");
    ed.set_variable("org-id-track-globally", Value::Bool(false));
    ed.press("C-c C-v t").unwrap();
    assert_eq!(ed.take_error().map(|e| e.to_string()), None);
    assert_eq!(std::fs::read_to_string(dir.path().join("out.el")).unwrap(), "(a (x))\n");
    assert!(!dir.path().join(".org-id-locations").exists());
}
