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
        &format!(r#"(e8.require("org-attach"), e8.letBind({{ "org-attach-method": e8.intern("lns") }}, () => e8.call("org-attach-attach" as any, {:?}, null)), "")"#, file.to_str().unwrap()),
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
    eval(&mut ed, &s, &format!(r#"(e8.require("org-attach"), e8.gotoChar(e8.pointMax()), e8.call("org-attach-attach" as any, {:?}, null), "")"#, file.to_str().unwrap()));
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
