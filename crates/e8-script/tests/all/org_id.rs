//! org-id: where IDs are, kept in org-id-locations-file as Emacs keeps it,
//! made as org-id-method says, and found again when they have moved.

use e8_core::{Editor, Value};
use e8_script::Scripting;

struct Fixture {
    ed: Editor,
    s: Scripting,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let mut ed = Editor::new();
        let s = Scripting::new(&mut ed).unwrap();
        let dir = tempfile::tempdir().unwrap();
        // Locations are kept in user-emacs-directory: a fresh one.
        ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", dir.path().display())));
        Fixture { ed, s, dir }
    }
    fn path(&self, name: &str) -> String {
        format!("{}/{name}", self.dir.path().display())
    }
    fn write(&self, name: &str, text: &str) -> String {
        std::fs::write(self.path(name), text).unwrap();
        self.path(name)
    }
    fn eval(&mut self, code: &str) -> String {
        self.s.eval_expression(&mut self.ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
    }
    fn visit(&mut self, file: &str) {
        self.ed.call("find-file", vec![e8_core::Arg::Str(file.into())]).unwrap();
    }
    fn locations(&self) -> String {
        std::fs::read_to_string(self.path(".org-id-locations")).unwrap_or_default()
    }
}

#[test]
fn a_new_id_is_recorded_and_saved_as_emacs_saves_it() {
    let mut f = Fixture::new();
    let b = f.write("b.org", "* B\n");
    f.visit(&b);
    f.ed.call("org-id-get-create", vec![]).unwrap();
    let id = f.eval(r#"e8.funcall("org-id-get")"#).trim_matches('"').to_string();
    assert!(f.ed.window_buffer().slice(0..f.ed.window_buffer().len()).contains(&format!(":ID:       {id}")));
    f.eval(r#"e8.funcall("org-id-locations-save")"#);
    let abbreviated = f.eval(&format!(r#"e8.abbreviateFileName({b:?})"#));
    assert_eq!(f.locations(), format!("\n(({abbreviated} \"{id}\"))\n"));
    assert_eq!(f.eval(r#"e8.variable("org-id-files")[0]"#), abbreviated);
}

#[test]
fn ids_are_found_from_the_locations_file_and_by_scanning_again() {
    let mut f = Fixture::new();
    // Known only from the locations file, as Emacs wrote it, its file not open.
    let c = f.write("c.org", "* C\n:PROPERTIES:\n:ID: id-c\n:END:\n");
    f.write(".org-id-locations", &format!("\n((\"{c}\" \"id-c\"))\n"));
    f.ed.call("org-id-goto", vec![e8_core::Arg::Str("id-c".into())]).unwrap();
    assert_eq!(f.eval("e8.bufferFileName()"), format!("{c:?}"));
    assert_eq!(f.eval("e8.point()"), "0");
    // Moved to another file, an agenda file: found by scanning again, and the file updated.
    f.eval("e8.call(\"kill-buffer\", e8.bufferName(e8.currentBuffer()))");
    let a = f.write("a.org", "Intro\n* A\n:PROPERTIES:\n:ID: id-c\n:END:\n");
    f.write("c.org", "* C\n");
    f.eval(&format!(r#"e8.setVariable("org-agenda-files", [{a:?}])"#));
    f.ed.call("org-id-goto", vec![e8_core::Arg::Str("id-c".into())]).unwrap();
    // The files scanned are their true names, as file-truename gives them.
    let true_a = f.eval(&format!("e8.fileTruename({a:?})"));
    assert_eq!(f.eval("e8.bufferFileName()"), true_a);
    assert_eq!(f.eval("e8.point()"), "6");
    assert!(f.locations().contains("\"id-c\""), "{}", f.locations());
    assert!(f.locations().contains("a.org"), "{}", f.locations());
    assert_eq!(f.ed.echo(), Some("2 files scanned, 1 files contains IDs, and 1 IDs found."));
}

#[test]
fn update_id_locations_says_what_it_found_and_finds_duplicates() {
    let mut f = Fixture::new();
    let a = f.write("a.org", "* A\n:PROPERTIES:\n:ID: one\n:END:\n* B\n:PROPERTIES:\n:ID: two\n:END:\n:ID: not-in-a-drawer\n");
    let b = f.write("b.org", "* C\n:PROPERTIES:\n:ID: one\n:END:\n");
    f.eval(&format!(r#"e8.setVariable("org-id-extra-files", [{a:?}, {b:?}])"#));
    f.ed.call("org-id-update-id-locations", vec![]).unwrap();
    assert_eq!(f.ed.echo(), Some("2 files scanned, 2 files contains IDs, and 2 IDs found."));
    let messages = f.ed.messages();
    assert!(messages.iter().any(|m| m == r#"Duplicate ID "one""#), "{messages:?}");
    assert!(!f.locations().contains("not-in-a-drawer"), "{}", f.locations());
}

#[test]
fn ids_are_made_as_org_id_method_and_org_id_prefix_say() {
    let mut f = Fixture::new();
    let uuid = f.eval(r#"e8.funcall("org-id-new")"#);
    assert!(regex_like(&uuid, 36), "{uuid}");
    f.eval(r#"e8.setVariable("org-id-prefix", "Org")"#);
    let id = f.eval(r#"e8.funcall("org-id-new")"#);
    assert!(id.starts_with("\"Org:"), "{id}");
    assert_eq!(f.eval(r#"e8.funcall("org-id-new", "none")"#).len(), 38);
    f.eval(r#"e8.setVariable("org-id-method", "ts")"#);
    let ts = f.eval(r#"e8.funcall("org-id-new", "T")"#);
    // T:20261120T123703.348636
    assert!(ts.starts_with("\"T:20") && ts.len() == "\"T:20261120T123703.348636\"".len() && ts.contains('.'), "{ts}");
    f.eval(r#"e8.setVariable("org-id-method", "org")"#);
    let org = f.eval(r#"e8.funcall("org-id-new", "none")"#);
    assert_eq!(org.len(), 14, "{org}");
    assert!(org.trim_matches('"').chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()), "{org}");
}

fn regex_like(quoted: &str, len: usize) -> bool {
    let s = quoted.trim_matches('"');
    s.len() == len && s.chars().filter(|c| *c == '-').count() == 4
}

#[test]
fn an_id_without_a_file_is_not_recorded_and_the_locations_can_be_relative() {
    let mut f = Fixture::new();
    f.ed.window_buffer_mut().set_text("* H\n");
    f.ed.call("org-mode", vec![]).unwrap();
    // Emacs signals here; E8 makes the ID and records no file for it.
    f.ed.call("org-id-get-create", vec![]).unwrap();
    assert!(f.ed.window_buffer().slice(0..f.ed.window_buffer().len()).contains(":ID:"));
    assert_eq!(f.eval(r#"JSON.stringify(e8.variable("org-id-files"))"#), r#""[]""#);
    let b = f.write("b.org", "* B\n");
    f.visit(&b);
    f.eval(r#"e8.setVariable("org-id-locations-file-relative", true)"#);
    f.ed.call("org-id-get-create", vec![]).unwrap();
    f.eval(r#"e8.funcall("org-id-locations-save")"#);
    assert!(f.locations().starts_with("\n((\"b.org\" \""), "{:?}", f.locations());
    // C-u makes a new one in place of the old.
    let before = f.eval(r#"e8.funcall("org-id-get")"#);
    f.ed.call_with_prefix("org-id-get-create", vec![], Some(e8_core::PrefixArg::Universal(4))).unwrap();
    let after = f.eval(r#"e8.funcall("org-id-get")"#);
    assert_ne!(before, after);
    let text = f.ed.window_buffer().slice(0..f.ed.window_buffer().len());
    assert_eq!(text.matches(":ID:").count(), 1, "{text}");
}

#[test]
fn a_file_visited_through_a_symlink_is_gone_to_in_its_own_buffer() {
    let mut f = Fixture::new();
    std::fs::create_dir(f.path("real")).unwrap();
    std::os::unix::fs::symlink(f.path("real"), f.path("link")).unwrap();
    f.write("real/s.org", "* S\n:PROPERTIES:\n:ID: s1\n:END:\n");
    let link = f.path("link/s.org");
    f.visit(&link);
    f.ed.call("org-id-update-id-locations", vec![]).unwrap();
    f.eval(r#"e8.call("switch-to-buffer", "*scratch*")"#);
    f.ed.call("org-id-goto", vec![e8_core::Arg::Str("s1".into())]).unwrap();
    assert_eq!(f.eval("e8.bufferName(e8.currentBuffer())"), "\"s.org\"");
    let names = f.eval("JSON.stringify(e8.bufferList().map((b) => e8.bufferName(b)))");
    assert!(!names.contains("s.org<2>"), "{names}");
}

#[test]
fn a_files_own_id_goes_after_its_first_comments_and_an_empty_scan_says_nothing() {
    let mut f = Fixture::new();
    let x = f.write("x.org", "# c\n#+title: X\nText\n");
    f.visit(&x);
    f.ed.call("org-id-get-create", vec![]).unwrap();
    let text = f.ed.window_buffer().slice(0..f.ed.window_buffer().len());
    assert!(text.starts_with("# c\n:PROPERTIES:\n:ID:"), "{text:?}");
    // No files to scan: nothing is said, as Emacs's checksum of none matches its first.
    let mut g = Fixture::new();
    g.ed.clear_message();
    assert_eq!(g.eval(r#"JSON.stringify(e8.funcall("org-id-find", "nope") ?? null)"#), r#""null""#);
    assert_ne!(g.ed.echo(), Some("0 files scanned, 0 files contains IDs, and 0 IDs found."));
}
