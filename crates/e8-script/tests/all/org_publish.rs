//! Publishing, ox-publish: projects of Org files published to text, Org
//! and HTML, with sitemaps, an index, links between the files and
//! timestamps. Each expected output is what Emacs 30's Org 9.7 publishes
//! from the same files and projects.

use std::path::PathBuf;

use e8_core::{Editor, Value};
use e8_script::Scripting;

struct Site {
    _dir: tempfile::TempDir,
    root: PathBuf,
    ed: Editor,
    s: Scripting,
}

/// Three Org files and a stylesheet, in a directory with no symbolic link
/// on its way, as the index is kept by the files' true names.
fn site() -> Site {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let src = root.join("src");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("a.org"), "#+TITLE: Alpha\n#+OPTIONS: toc:nil author:nil\n* One\nSee [[file:b.org::*Two][two]] and [[file:sub/c.org][c]].\n#+INDEX: Apple\n#+INDEX: Apple!Green\n").unwrap();
    std::fs::write(src.join("b.org"), "#+TITLE: Beta\n#+DATE: <2024-01-02 Tue>\n#+OPTIONS: toc:nil author:nil\n* Two\n:PROPERTIES:\n:CUSTOM_ID: two\n:END:\nText.\n#+INDEX: Banana\n* Three\n#+INDEX: Apple!Red\n").unwrap();
    std::fs::write(src.join("sub/c.org"), "#+TITLE: Gamma\n#+OPTIONS: toc:nil author:nil\nC text.\n").unwrap();
    std::fs::write(src.join("style.css"), "body {}\n").unwrap();
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-full-name", Value::Str("A. Writer".into()));
    ed.set_variable("org-export-timestamp-file", Value::Bool(false));
    ed.set_variable("org-html-postamble", Value::Bool(false));
    ed.set_variable("org-export-copy-to-kill-ring", Value::Bool(false));
    ed.set_variable("e8--export-sequential-references", Value::Bool(true));
    ed.set_variable("org-publish-timestamp-directory", Value::Str(format!("{}/ts/", root.display())));
    let (src, out) = (format!("{}/", src.display()), format!("{}/out/", root.display()));
    let projects = format!(
        r#"e8.setVariable("org-publish-project-alist", [
          ["txt", ":base-directory", "{src}", ":publishing-directory", "{out}txt/", ":recursive", true,
           ":publishing-function", "org-ascii-publish-to-utf8", ":auto-sitemap", true, ":sitemap-title", "Site"],
          ["list", ":base-directory", "{src}", ":publishing-directory", "{out}list/", ":recursive", true,
           ":publishing-function", e8.intern("org-org-publish-to-org"), ":auto-sitemap", true, ":sitemap-style", e8.intern("list"),
           ":sitemap-sort-folders", "first", ":sitemap-filename", "map.org", ":makeindex", true],
          ["html", ":base-directory", "{src}", ":publishing-directory", "{out}html/", ":recursive", true,
           ":publishing-function", "org-html-publish-to-html", ":html-head", "", ":html-head-include-default-style", false,
           ":html-head-include-scripts", false, ":with-title", false, ":section-numbers", false],
          ["css", ":base-directory", "{src}", ":base-extension", "css", ":publishing-directory", "{out}html/",
           ":publishing-function", "org-publish-attachment"],
          ["site", ":components", ["html", "css"]],
        ])"#
    );
    let mut site = Site { _dir: dir, root, ed, s };
    site.s.eval_expression(&mut site.ed, &projects).unwrap();
    site
}

impl Site {
    fn publish(&mut self, project: &str, force: bool) {
        let force = if force { "true" } else { "false" };
        self.s.eval_expression(&mut self.ed, &format!("e8.call(\"org-publish\", {project:?}, {force})")).unwrap();
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn remove(&self, path: &str) {
        std::fs::remove_file(self.root.join(path)).unwrap();
    }
}

/// What has been said, each message on a line of its own.
fn messages(ed: &mut Editor) -> String {
    ed.messages().join("\n") + "\n"
}

#[test]
fn a_project_is_published_as_text_with_a_sitemap_of_its_tree() {
    let mut site = site();
    site.publish("txt", true);
    assert_eq!(
        site.read("out/txt/a.txt"),
        "                                ━━━━━━━\n                                 ALPHA\n                                ━━━━━━━\n\n\n1 One\n═════\n\n  See [two] and [c].\n\n\n[two] <file:b.org::*Two>\n\n[c] <file:sub/c.org>\n"
    );
    assert_eq!(site.read("out/txt/sub/c.txt"), "                                ━━━━━━━\n                                 GAMMA\n                                ━━━━━━━\n\n\nC text.\n");
    assert_eq!(site.read("src/sitemap.org"), "#+TITLE: Site\n\n- [[file:a.org][Alpha]]\n- [[file:b.org][Beta]]\n- sub\n  - [[file:sub/c.org][Gamma]]");
    assert_eq!(
        site.read("out/txt/sitemap.txt"),
        "                              ━━━━━━━━━━━\n                                  SITE\n\n                               A. Writer\n                              ━━━━━━━━━━━\n\n\nTable of Contents\n─────────────────\n\n\n\n\n• [Alpha]\n• [Beta]\n• sub\n  • [Gamma]\n\n\n[Alpha] <file:a.org>\n\n[Beta] <file:b.org>\n\n[Gamma] <file:sub/c.org>\n"
    );
}

#[test]
fn a_list_sitemap_with_folders_first_org_files_and_an_index() {
    let mut site = site();
    site.publish("list", true);
    assert_eq!(site.read("src/map.org"), "#+TITLE: Sitemap for project list\n\n- sub/\n- [[file:a.org][Alpha]]\n- [[file:b.org][Beta]]\n- [[file:sub/c.org][Gamma]]");
    assert_eq!(
        site.read("src/theindex.inc"),
        "* A\n  - [[file:a.org::*One][Apple]]\n    - [[file:a.org::*One][Green]]\n    - [[file:b.org::*Three][Red]]\n* B\n  - [[file:b.org::#two][Banana]]\n"
    );
    assert_eq!(site.read("src/theindex.org"), "#+TITLE: Index\n\n#+INCLUDE: \"theindex.inc\"\n\n");
    assert_eq!(
        site.read("out/list/a.org"),
        "#+options: toc:nil author:nil\n#+title: Alpha\n* One\nSee [[file:b.org::*Two][two]] and [[file:sub/c.org][c]].\n#+index: Apple\n#+index: Apple!Green\n"
    );
    assert_eq!(
        site.read("out/list/theindex.org"),
        "#+title: Index\n#+author: A. Writer\n* A\n- [[file:a.org::*One][Apple]]\n  - [[file:a.org::*One][Green]]\n  - [[file:b.org::*Three][Red]]\n* B\n- [[file:b.org::#two][Banana]]\n"
    );
}

/// Each piece of a text from START up to and including END.
fn all(text: &str, start: &str, end: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = text;
    while let Some(i) = rest.find(start) {
        let tail = &rest[i..];
        let stop = start.len() + tail[start.len()..].find(end).unwrap() + end.len();
        out.push(tail[..stop].to_string());
        rest = &tail[stop..];
    }
    out
}

#[test]
fn links_between_the_files_of_a_site_find_their_targets() {
    let mut site = site();
    site.publish("site", true);
    let a = site.read("out/html/a.html");
    assert_eq!(all(&a, "<a href=", "</a>"), ["<a href=\"b.html#two\">two</a>", "<a href=\"sub/c.html\">c</a>"]);
    let b = site.read("out/html/b.html");
    assert_eq!(
        all(&b, " id=\"", "\""),
        [" id=\"content\"", " id=\"outline-container-two\"", " id=\"two\"", " id=\"text-two\"", " id=\"outline-container-org0000001\"", " id=\"org0000001\"", " id=\"text-org0000001\""]
    );
    // The stylesheet, published by the other component.
    assert_eq!(site.read("out/html/style.css"), "body {}\n");
}

#[test]
fn files_unchanged_since_they_were_published_are_skipped() {
    let mut site = site();
    site.publish("txt", true);
    site.remove("out/txt/a.txt");
    let before = messages(&mut site.ed).len();
    site.publish("txt", false);
    let src = site.root.join("src");
    let said = messages(&mut site.ed)[before..].to_string();
    for f in ["a.org", "b.org", "sub/c.org"] {
        assert!(said.contains(&format!("Skipping unmodified file {}\n", src.join(f).display())), "{said}");
    }
    // The sitemap is made again, so it is published again.
    assert!(said.contains(&format!("Publishing file {} using `org-ascii-publish-to-utf8'", src.join("sitemap.org").display())), "{said}");
    assert!(!site.root.join("out/txt/a.txt").exists());
    // A file changed since is published again.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
    std::fs::File::options().write(true).open(src.join("b.org")).unwrap().set_modified(later).unwrap();
    let before = messages(&mut site.ed).len();
    site.publish("txt", false);
    let said = messages(&mut site.ed)[before..].to_string();
    assert!(said.contains(&format!("Publishing file {} using", src.join("b.org").display())), "{said}");
    assert!(said.contains(&format!("Skipping unmodified file {}\n", src.join("a.org").display())), "{said}");
    // With force, everything.
    site.publish("txt", true);
    assert!(site.root.join("out/txt/a.txt").exists());
}

#[test]
fn the_dispatcher_publishes_the_project_chosen() {
    let mut site = site();
    let file = site.root.join("src/a.org");
    site.ed.call("find-file", vec![e8_core::Arg::Str(file.display().to_string())]).unwrap();
    site.ed.press("C-c C-e C-f P x t x t RET").unwrap();
    assert!(site.root.join("out/txt/b.txt").exists());
    // P f publishes the file visited, in the project it belongs to.
    site.remove("out/txt/a.txt");
    site.ed.press("C-c C-e C-f P f").unwrap();
    assert!(site.root.join("out/txt/a.txt").exists());
}

#[test]
fn a_file_in_no_project_is_an_error() {
    let mut site = site();
    let stray = site.root.join("stray.org");
    std::fs::write(&stray, "* Stray\n").unwrap();
    site.ed.call("find-file", vec![e8_core::Arg::Str(stray.display().to_string())]).unwrap();
    let err = site.ed.call("org-publish-current-file", vec![]).unwrap_err().to_string();
    assert!(err.contains("is not part of any known project"), "{err}");
}
