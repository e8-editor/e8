//! htmlize, and the coloured source blocks Org's HTML export makes with
//! it: spans with classes or inline styles, as htmlize writes them, from
//! E8's own faces. The colours are E8's, so each is checked against the
//! face it comes from rather than written out.

use e8_core::{Editor, Value};
use e8_script::Scripting;

struct Session {
    ed: Editor,
    s: Scripting,
    /// The buffer the session started in.
    name: String,
}

fn session(text: &str, mode: &str) -> Session {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call(mode, vec![]).unwrap();
    ed.set_variable("user-full-name", Value::Str("A. Writer".into()));
    ed.set_variable("org-export-copy-to-kill-ring", Value::Bool(false));
    let name = ed.window_buffer().name.clone();
    Session { ed, s, name }
}

impl Session {
    /// What a script expression gives, as JSON.
    fn eval(&mut self, source: &str) -> serde_json::Value {
        serde_json::from_str(&self.s.eval_expression(&mut self.ed, source).unwrap()).unwrap()
    }

    /// What a script expression gives, a string.
    fn string(&mut self, source: &str) -> String {
        self.eval(source).as_str().unwrap_or_else(|| panic!("not a string: {source}")).to_string()
    }

    /// The HTML export of the buffer the session started in, its body only unless `extra` gives options.
    fn export(&mut self, body_only: bool, extra: &str) -> String {
        let name = &self.name;
        self.string(&format!(
            r#"(e8.require("ox-html"), e8.withCurrentBuffer({name:?}, () => e8.call("org-html-export-as-html", null, null, null, {body_only}, {extra})), e8.withCurrentBuffer("*Org HTML Export*", () => e8.bufferText()))"#
        ))
    }

    /// A face's foreground as htmlize writes it: the colour E8 draws, as #rrggbb, laid over the default background if translucent.
    fn color(&mut self, face: &str) -> String {
        self.string(&format!(
            r##"(() => {{
              const hex = (bs: number[]) => "#" + bs.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
              const [r, g, b, a] = e8.colorRgba(String(e8.faceAttribute({face:?}, ":foreground", true)))!;
              const bg = e8.colorRgba("bg")!;
              return hex([r, g, b].map((c, i) => (c * a + bg[i] * (255 - a)) / 255));
            }})()"##
        ))
    }
}

const BLOCK: &str = "#+OPTIONS: toc:nil author:nil\n#+begin_src typescript\nconst a = \"<b>\" & 1; // é\n#+end_src\n";

#[test]
fn a_source_block_is_coloured_with_inline_styles_by_default() {
    let mut s = session(BLOCK, "org-mode");
    let html = s.export(true, "null");
    let (keyword, string, number, comment) = (s.color("font-lock-keyword-face"), s.color("font-lock-string-face"), s.color("font-lock-number-face"), s.color("font-lock-comment-face"));
    // The keyword is in the keyword face, the comment italic as well; text is escaped, beyond ASCII as an entity.
    let line = format!(
        r#"<span style="color: {keyword};">const</span> <span style="color: {}">a</span> = <span style="color: {string};">"&lt;b&gt;"</span> &amp; <span style="color: {number};">1</span>; <span style="color: {comment}; font-style: italic;">// &#233;</span>"#,
        s.color("font-lock-variable-name-face") + ";",
    );
    assert_eq!(html, format!("<div class=\"org-src-container\">\n<pre class=\"src src-typescript\">{line}\n</pre>\n</div>\n"));
}

#[test]
fn with_css_a_source_block_has_classes_named_after_its_faces() {
    let mut s = session(BLOCK, "org-mode");
    s.ed.set_variable("org-html-htmlize-output-type", Value::Str("css".into()));
    let html = s.export(true, "null");
    assert!(
        html.contains(r#"<pre class="src src-typescript"><span class="org-keyword">const</span> <span class="org-variable-name">a</span> = <span class="org-string">"&lt;b&gt;"</span> &amp; <span class="org-number">1</span>; <span class="org-comment">// &#233;</span>"#),
        "{html}"
    );
    s.ed.set_variable("org-html-htmlize-font-prefix", Value::Str("src-".into()));
    assert!(s.export(true, "null").contains(r#"<span class="src-keyword">const</span>"#));
}

#[test]
fn generate_css_makes_a_class_for_each_face() {
    let mut s = session("", "fundamental-mode");
    s.eval(r#"(e8.require("ox-html"), e8.call("org-html-htmlize-generate-css"), 0)"#);
    assert_eq!(s.ed.window_buffer().name, "*html*");
    let css = s.string("e8.bufferText()");
    let keyword = s.color("font-lock-keyword-face");
    assert!(css.starts_with("<style type=\"text/css\">\n    <!--\n      body {\n        color: "), "{css}");
    assert!(css.contains(&format!("      .org-keyword {{\n        /* font-lock-keyword-face */\n        color: {keyword};\n      }}\n")), "{css}");
    assert!(css.contains("      .org-bold {\n        /* bold */\n        font-weight: bold;\n      }\n"), "{css}");
    assert!(css.ends_with("    -->\n</style>\n"), "{css}");
}

#[test]
fn a_block_is_plain_with_no_output_type_or_mode() {
    let mut s = session(BLOCK, "org-mode");
    s.ed.set_variable("org-html-htmlize-output-type", Value::Bool(false));
    assert_eq!(s.export(true, "null"), "<div class=\"org-src-container\">\n<pre class=\"src src-typescript\">const a = \"&lt;b&gt;\" &amp; 1; // é\n</pre>\n</div>\n");
    let mut s = session("#+begin_src nosuchlang\na < b\n#+end_src\n", "org-mode");
    assert_eq!(s.export(true, "null"), "<div class=\"org-src-container\">\n<pre class=\"src src-nosuchlang\">a &lt; b\n</pre>\n</div>\n");
}

#[test]
fn htmlize_buffer_makes_a_document_and_leaves_the_buffer_as_it_was() {
    let mut s = session("if (x)\n\tf(); // Local Variables:\n", "typescript-ts-mode");
    let name = s.name.clone();
    let html_name = s.string(&format!(r#"(e8.require("htmlize"), e8.withCurrentBuffer({name:?}, () => e8.call("htmlize-buffer")), e8.bufferList().find((b) => b === "*html*")!)"#));
    let html = s.string(&format!("e8.withCurrentBuffer({html_name:?}, () => e8.bufferText())"));
    let keyword = s.color("font-lock-keyword-face");
    let head = format!("<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\">\n<!-- Created by htmlize-1.57 in css mode. -->\n<html>\n  <head>\n    <title>{name}</title>\n    <style type=\"text/css\">\n    <!--\n      body {{\n");
    assert!(html.starts_with(&head), "{html}");
    assert!(html.contains(&format!("      .keyword {{\n        /* font-lock-keyword-face */\n        color: {keyword};\n      }}\n")), "{html}");
    // The tab as spaces, to the next tab stop, and the local variables defanged.
    assert!(html.ends_with("  <body>\n    <pre>\n<span class=\"keyword\">if</span> (x)\n        f(); <span class=\"comment\">// Local Variables&#58;</span>\n</pre>\n  </body>\n</html>\n"), "{html}");
    // Where its parts are, for Org and others to take the text from.
    let content = s.string(&format!(
        r#"e8.withCurrentBuffer({html_name:?}, () => {{ const p = e8.variable("htmlize-buffer-places") as e8.Value[]; const at = (n: string) => p[p.findIndex((x) => typeof x === "symbol" && e8.symbolName(x) === n) + 1] as number; return e8.bufferText(at("content-start"), at("content-end")); }})"#
    ));
    assert!(content.starts_with("<pre>\n<span class=\"keyword\">if</span>") && content.ends_with("</pre>"), "{content}");
    // The syntax tree's faces were read from a copy: the buffer has no face properties.
    assert_eq!(s.eval(&format!(r#"e8.withCurrentBuffer({name:?}, () => e8.getTextProperty(0, "face") ?? null)"#)), serde_json::Value::Null);
    // With inline CSS, the body has the default face's colours.
    s.eval(&format!(r#"(e8.setVariable("htmlize-output-type", e8.intern("inline-css")), e8.withCurrentBuffer({name:?}, () => e8.call("htmlize-buffer")), 0)"#));
    let inline = s.string(r#"e8.withCurrentBuffer("*html*<2>", () => e8.bufferText())"#);
    assert!(inline.contains("<!-- Created by htmlize-1.57 in inline-css mode. -->\n<html>\n  <head>\n    <title>"), "{inline}");
    assert!(inline.contains("  </head>\n  <body style=\"color: #"), "{inline}");
    assert!(inline.contains(&format!("<pre>\n<span style=\"color: {keyword};\">if</span>")), "{inline}");
}

#[test]
fn htmlize_file_writes_the_html_beside_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.ts");
    std::fs::write(&file, "let x = 1;\n").unwrap();
    let mut s = session("", "fundamental-mode");
    s.eval(&format!(r#"(e8.require("htmlize"), e8.call("htmlize-file", {:?}), 0)"#, file.display().to_string()));
    let html = std::fs::read_to_string(dir.path().join("a.ts.html")).unwrap();
    assert!(html.contains("<title>a.ts</title>"), "{html}");
    assert!(html.contains("<pre>\n<span class=\"keyword\">let</span> "), "{html}");
    // No buffer is left visiting the file.
    assert!(s.eval(r#"e8.bufferList().some((b) => b.includes("a.ts"))"#) == serde_json::Value::Bool(false));
}

#[test]
fn publishing_with_htmlized_source_writes_the_org_file_as_html() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.org"), "* One\n#+begin_src typescript\nconst a = 1;\n#+end_src\n").unwrap();
    let mut s = session("", "fundamental-mode");
    s.ed.set_variable("org-publish-timestamp-directory", Value::Str(format!("{}/ts/", root.display())));
    let (src, out) = (format!("{}/src/", root.display()), format!("{}/out/", root.display()));
    s.eval(&format!(
        r#"(e8.setVariable("org-publish-project-alist", [["p", ":base-directory", "{src}", ":publishing-directory", "{out}",
           ":publishing-function", e8.intern("org-org-publish-to-org"), ":htmlized-source", true]]), e8.call("org-publish", "p", true), 0)"#
    ));
    assert!(root.join("out/a.org").exists());
    let html = std::fs::read_to_string(root.join("out/a.org.html")).unwrap();
    assert!(html.contains("<!-- Created by htmlize-1.57 in css mode. -->\n"), "{html}");
    assert!(html.contains("<title>a.org</title>"), "{html}");
    assert!(html.contains("    <style type=\"text/css\">\n"), "{html}");
    assert!(html.contains("<pre>\n<span class=\"org-level-1\">* One</span>\n"), "{html}");
    assert!(html.contains("<span class=\"org-block\"><span class=\"keyword\">const</span></span>"), "{html}");
    // With org-org-htmlized-css-url, a link to it in place of the style sheet.
    s.ed.set_variable("org-org-htmlized-css-url", Value::Str("org.css".into()));
    s.eval(r#"(e8.call("org-publish", "p", true), 0)"#);
    let html = std::fs::read_to_string(root.join("out/a.org.html")).unwrap();
    assert!(html.contains("    <title>a.org</title>\n    <link rel=\"stylesheet\" type=\"text/css\" href=\"org.css\">\n  </head>"), "{html}");
}

#[test]
fn a_projects_htmlized_css_url_is_linked_from_html_with_css_classes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.org"), "#+begin_src typescript\nlet x;\n#+end_src\n").unwrap();
    let mut s = session("", "fundamental-mode");
    s.ed.set_variable("org-publish-timestamp-directory", Value::Str(format!("{}/ts/", root.display())));
    s.ed.set_variable("org-html-htmlize-output-type", Value::Str("css".into()));
    let (src, out) = (format!("{}/src/", root.display()), format!("{}/out/", root.display()));
    s.eval(&format!(
        r#"(e8.setVariable("org-publish-project-alist", [["p", ":base-directory", "{src}", ":publishing-directory", "{out}",
           ":publishing-function", "org-html-publish-to-html", ":html-htmlized-css-url", "code.css", ":html-head-include-default-style", false]]), e8.call("org-publish", "p", true), 0)"#
    ));
    let html = std::fs::read_to_string(root.join("out/a.html")).unwrap();
    assert!(html.contains("<link rel=\"stylesheet\" href=\"code.css\" type=\"text/css\" />\n"), "{html}");
    assert!(html.contains(r#"<pre class="src src-typescript"><span class="org-keyword">let</span> "#), "{html}");
    // Inline CSS has no style sheet to link.
    s.ed.set_variable("org-html-htmlize-output-type", Value::Str("inline-css".into()));
    s.eval(r#"(e8.call("org-publish", "p", true), 0)"#);
    assert!(!std::fs::read_to_string(root.join("out/a.html")).unwrap().contains("code.css"));
}
