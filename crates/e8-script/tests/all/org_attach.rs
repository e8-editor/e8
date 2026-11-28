//! org-attach where the Emacs oracle cannot follow it: symbolic links,
//! whose name batch Emacs's answer leaves relative, opening attachments and
//! following attachment: links, which batch Emacs will not open, exporting
//! them, which its export dispatcher cannot be driven to, showing them as
//! images, and making an ID for an entry. The expected results are Emacs
//! 30.2's org-attach.el on the same files.

use std::path::{Path, PathBuf};

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

/// Visits `notes.org`, holding TEXT, in a fresh directory, with `files` written there first.
fn visit(text: &str, files: &[(&str, &str)]) -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (name, contents) in files {
        let path = dir.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    let file = dir.path().join("notes.org");
    std::fs::write(&file, text).unwrap();
    ed.set_variable("org-id-locations-file", Value::Str(dir.path().join(".org-id-locations").to_str().unwrap().into()));
    ed.call("find-file", vec![Arg::Str(file.to_str().unwrap().into())]).unwrap();
    (ed, s, dir)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let out = s.eval_expression(ed, code).unwrap();
    serde_json::from_str::<String>(&out).unwrap_or(out)
}

/// TEXT with the directory, as it is or with symbolic links resolved, written as DIR.
fn without_dir(text: &str, dir: &Path) -> String {
    let real: PathBuf = std::fs::canonicalize(dir).unwrap();
    text.replace(&real.display().to_string(), "DIR").replace(&dir.display().to_string(), "DIR")
}

/// A frame that shows images, as the GUI's.
struct Graphical;

impl e8_core::layout::TextMetrics for Graphical {
    fn advance(&self, font: &e8_core::layout::FontSpec, _c: char) -> f32 {
        7.0 * font.scale
    }
    fn line_height(&self, font: &e8_core::layout::FontSpec) -> f32 {
        14.0 * font.scale
    }
    fn char_width(&self) -> f32 {
        7.0
    }
    fn char_height(&self) -> f32 {
        14.0
    }
    fn ascent(&self, font: &e8_core::layout::FontSpec) -> f32 {
        11.0 * font.scale
    }
    fn font_size(&self) -> f32 {
        12.0
    }
    fn images(&self) -> bool {
        true
    }
}

const TASK: &str = "* Task\n:PROPERTIES:\n:ID: abcdef\n:END:\n";

/// Attaching by a symbolic link links to the file, tags the entry and stores an attachment: link.
#[test]
fn a_symbolic_link_is_attached() {
    let (mut ed, s, dir) = visit(TASK, &[("s.txt", "s\n")]);
    let file = dir.path().join("s.txt");
    eval(
        &mut ed,
        &s,
        &format!(r#"(e8.require("org-attach"), e8.letBind({{ "org-attach-method": e8.intern("lns") }}, () => e8.call("org-attach-attach" as any, {:?}, null, null)), "")"#, file.to_str().unwrap()),
    );
    let link = std::fs::read_link(dir.path().join("data/ab/cdef/s.txt")).unwrap();
    assert_eq!(without_dir(link.to_str().unwrap(), dir.path()), "DIR/s.txt");
    assert_eq!(eval(&mut ed, &s, "e8.lineText(0)"), "* Task                                                               :ATTACH:");
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("org-stored-links") as e8.Value[])[0])"#), r#"["attachment:s.txt","s.txt"]"#);
    assert_eq!(ed.messages().last().unwrap(), r#"File "s.txt" is now an attachment"#);
}

/// org-attach-dir, autoloaded, and org-attach-expand give the entry's directory.
#[test]
fn the_directory_comes_from_the_id() {
    let (mut ed, s, dir) = visit(TASK, &[("data/ab/cdef/a.txt", "a\n")]);
    assert_eq!(without_dir(&eval(&mut ed, &s, r#"e8.funcall("org-attach-dir")"#), dir.path()), "DIR/data/ab/cdef");
    assert_eq!(without_dir(&eval(&mut ed, &s, r#"e8.funcall("org-attach-expand", "x.png")"#), dir.path()), "DIR/data/ab/cdef/x.png");
}

/// An entry with neither ID nor DIR gets an ID, and its directory from it.
#[test]
fn an_entry_without_an_id_gets_one() {
    let (mut ed, s, dir) = visit("* Task\n", &[]);
    eval(&mut ed, &s, r#"(e8.require("org-attach"), "")"#);
    ed.press("M-x o r g - a t t a c h - d i r - g e t - c r e a t e RET").unwrap();
    let text = eval(&mut ed, &s, "e8.bufferText(e8.pointMin(), e8.pointMax())");
    let id = text.lines().find_map(|l| l.strip_prefix(":ID:")).unwrap_or_default().trim().to_string();
    assert!(id.len() > 2, "{id}");
    let expected = format!("DIR/data/{}/{}", &id[..2], &id[2..]);
    assert_eq!(without_dir(&eval(&mut ed, &s, r#"e8.funcall("org-attach-dir")"#), dir.path()), expected);
    assert!(dir.path().join(format!("data/{}/{}", &id[..2], &id[2..])).is_dir());
}

/// Before the first heading, the file's DIR is used, and nothing is tagged.
#[test]
fn before_the_first_heading_the_file_is_attached_to() {
    let (mut ed, s, dir) = visit(":PROPERTIES:\n:DIR: top\n:END:\nText\n", &[("a.txt", "a\n")]);
    let file = dir.path().join("a.txt");
    eval(&mut ed, &s, &format!(r#"(e8.require("org-attach"), e8.gotoChar(e8.pointMax()), e8.call("org-attach-attach" as any, {:?}, null, null), "")"#, file.to_str().unwrap()));
    assert!(dir.path().join("top/a.txt").exists());
    assert_eq!(eval(&mut ed, &s, "e8.bufferText(e8.pointMin(), e8.pointMax())"), ":PROPERTIES:\n:DIR: top\n:END:\nText\n");
}

/// o opens the entry's one attachment.
#[test]
fn the_one_attachment_is_opened() {
    let (mut ed, s, _dir) = visit(TASK, &[("data/ab/cdef/a.txt", "attached text\n")]);
    ed.press("C-c C-a o").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferName()"), "a.txt");
    assert_eq!(eval(&mut ed, &s, "e8.bufferText(e8.pointMin(), e8.pointMax())"), "attached text\n");
}

/// C-c C-o on an attachment: link visits the file in the entry's directory.
#[test]
fn an_attachment_link_is_followed() {
    let (mut ed, s, _dir) = visit(&format!("{TASK}See [[attachment:a.txt]].\n"), &[("data/ab/cdef/a.txt", "attached text\n")]);
    ed.press("C-c C-a q M-> C-p C-e C-b C-b C-b C-c C-o").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferName()"), "a.txt");
}

/// Exported, attachment: links are file links to the attachment directory.
#[test]
fn attachment_links_export_as_file_links() {
    let (mut ed, s, dir) = visit(&format!("{TASK}See [[attachment:a.txt][the file]] and [[attachment:b.txt]].\n"), &[("data/ab/cdef/a.txt", "attached\n")]);
    ed.set_variable("org-export-copy-to-kill-ring", Value::Null);
    eval(&mut ed, &s, r#"(e8.require("org-attach"), e8.call("org-md-export-as-markdown" as any), "")"#);
    let out = without_dir(&eval(&mut ed, &s, "e8.bufferText(e8.pointMin(), e8.pointMax())"), dir.path());
    assert!(out.contains("See [the file](file://DIR/data/ab/cdef/a.txt) and <file://DIR/data/ab/cdef/b.txt>."), "{out}");
}

/// An attachment: link to an image shows the image from the attachment directory.
#[test]
fn attachment_images_are_shown_inline() {
    let image = std::fs::read(format!("{}/../e8-core/tests/images/dot.png", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (mut ed, s, dir) = visit(&format!("{TASK}[[attachment:dot.png]]\n"), &[]);
    ed.set_text_metrics(std::sync::Arc::new(Graphical));
    std::fs::create_dir_all(dir.path().join("data/ab/cdef")).unwrap();
    std::fs::write(dir.path().join("data/ab/cdef/dot.png"), image).unwrap();
    eval(&mut ed, &s, r#"(e8.call("org-display-inline-images" as any), "")"#);
    let shown = eval(&mut ed, &s, r#"e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "org-image-overlay")).map((o) => e8.bufferText(e8.overlayStart(o)!, e8.overlayEnd(o)!)).join(";")"#);
    assert_eq!(shown, "[[attachment:dot.png]]");
}

/// Downloading is not there yet.
#[test]
fn a_url_is_refused() {
    let (mut ed, s, _dir) = visit(TASK, &[]);
    eval(&mut ed, &s, r#"(e8.require("org-attach"), "")"#);
    let err = ed.call("org-attach-url", vec![Arg::Str("https://example.com/x".into())]).unwrap_err();
    assert_eq!(err.to_string(), "E8 cannot download attachments yet");
}

/// Answers each prompt from ANSWERS in turn, as a person types them: a
/// minibuffer's whole input, or a key read.
fn answering(ed: &mut Editor, answers: &[&str]) {
    let mut left: std::collections::VecDeque<String> = answers.iter().map(|a| a.to_string()).collect();
    ed.set_input_source(move |ed| {
        let Some(answer) = left.pop_front() else { return false };
        if ed.minibuffer_depth() > 0 {
            ed.set_minibuffer_input(&answer);
            ed.unread_keys(&[e8_core::Key::parse("RET").unwrap()]);
        } else {
            ed.unread_keys(&[e8_core::Key::char(answer.chars().next().unwrap())]);
        }
        true
    });
}

/// s with a relative DIR starts the prompt there, in the file's directory;
/// answered with a new directory, as a person types it, it sets DIR
/// relative with org-attach-dir-relative and moves the attachments: Emacs
/// writes ":DIR:      new/", has new/a.txt and no att.
#[test]
fn a_new_directory_takes_the_attachments() {
    let (mut ed, s, dir) = visit("* Task\n:PROPERTIES:\n:DIR: att\n:END:\n", &[("att/a.txt", "a\n")]);
    ed.set_variable("org-attach-dir-relative", Value::Bool(true));
    let new = format!("{}/new/", dir.path().display());
    answering(&mut ed, &["s", &new, "yes", "yes"]);
    ed.press("C-c C-a").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferText(e8.pointMin(), e8.pointMax())"), "* Task\n:PROPERTIES:\n:DIR:      new/\n:END:\n");
    assert!(dir.path().join("new/a.txt").exists());
    assert!(!dir.path().join("att").exists());
}

/// lns over an attachment there asks, and on yes makes the link: Emacs's points to DIR/a.txt.
#[test]
fn a_symbolic_link_replaces_a_file_when_asked() {
    let (mut ed, s, dir) = visit(TASK, &[("a.txt", "new\n"), ("data/ab/cdef/a.txt", "old\n")]);
    let file = dir.path().join("a.txt");
    answering(&mut ed, &["yes"]);
    eval(
        &mut ed,
        &s,
        &format!(r#"(e8.require("org-attach"), e8.call("org-attach-attach" as any, {:?}, null, "lns"), "")"#, file.to_str().unwrap()),
    );
    let link = std::fs::read_link(dir.path().join("data/ab/cdef/a.txt")).unwrap();
    assert_eq!(without_dir(link.to_str().unwrap(), dir.path()), "DIR/a.txt");
}

/// METHOD from code, and with org-attach-store-link-p t the file as given
/// is stored: Emacs stores ("file:a.txt" "a.txt") and moves the file; its
/// org-attach-file-list then gives ("a.txt"), and org-attach-dir-from-id
/// "xyzzy" is DIR/data/xy/zzy.
#[test]
fn a_method_from_code_and_the_link_as_given() {
    let (mut ed, s, dir) = visit(TASK, &[("a.txt", "a\n")]);
    ed.set_variable("org-attach-store-link-p", Value::Bool(true));
    eval(&mut ed, &s, r#"(e8.require("org-attach"), e8.call("org-attach-attach" as any, "a.txt", null, "mv"), "")"#);
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify((e8.variable("org-stored-links") as e8.Value[])[0])"#), r#"["file:a.txt","a.txt"]"#);
    assert!(!dir.path().join("a.txt").exists());
    assert_eq!(eval(&mut ed, &s, r#"JSON.stringify(e8.funcall("org-attach-file-list", e8.funcall("org-attach-dir")))"#), r#"["a.txt"]"#);
    assert_eq!(without_dir(&eval(&mut ed, &s, r#"e8.funcall("org-attach-dir-from-id", "xyzzy")"#), dir.path()), "DIR/data/xy/zzy");
}

/// Exporting loads org-attach, as ox.el requires it, so attachment: links
/// become file links though nothing loaded it before.
#[test]
fn exporting_loads_org_attach() {
    let (mut ed, s, dir) = visit(&format!("{TASK}See [[attachment:a.txt][the file]] and [[attachment:b.txt]].\n"), &[("data/ab/cdef/a.txt", "attached\n")]);
    ed.set_variable("org-export-copy-to-kill-ring", Value::Null);
    eval(&mut ed, &s, r#"(e8.call("org-md-export-as-markdown" as any), "")"#);
    let out = without_dir(&eval(&mut ed, &s, "e8.bufferText(e8.pointMin(), e8.pointMax())"), dir.path());
    assert!(out.contains("See [the file](file://DIR/data/ab/cdef/a.txt) and <file://DIR/data/ab/cdef/b.txt>."), "{out}");
}

/// org-attach-dired-to-subtree takes FILES from code.
#[test]
fn dired_files_from_code_are_attached() {
    let (mut ed, s, dir) = visit(TASK, &[("a.txt", "a\n")]);
    let file = dir.path().join("a.txt");
    eval(&mut ed, &s, r#"(e8.require("org-attach"), "")"#);
    ed.press("C-x 3").unwrap();
    ed.call("dired", vec![Arg::Str(dir.path().to_str().unwrap().into())]).unwrap();
    eval(&mut ed, &s, &format!(r#"(e8.call("org-attach-dired-to-subtree" as any, [{:?}]), "")"#, file.to_str().unwrap()));
    assert!(dir.path().join("data/ab/cdef/a.txt").exists());
}

