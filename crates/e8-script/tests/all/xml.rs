//! Parsing HTML and XML as scripts do, checked against what GNU Emacs
//! 30.2's libxml-parse-html-region and libxml-parse-xml-region give for
//! the same text (its buffer positions count from 1, scripts' from 0).

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// What parsing the whole buffer gives, as JSON.
fn parsed(ed: &mut Editor, s: &Scripting, text: &str, html: bool, discard: bool) -> String {
    s.eval_expression(ed, "(e8.widen(), e8.deleteRegion(0, e8.pointMax()), true)").unwrap();
    ed.type_text(text);
    let which = if html { "libxmlParseHtmlRegion" } else { "libxmlParseXmlRegion" };
    let code = format!("JSON.stringify(e8.{which}(0, e8.pointMax(), null, {discard}) ?? null)");
    let got = s.eval_expression(ed, &code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

#[test]
fn html_comes_out_as_the_tree_emacs_gives() {
    let (mut ed, s) = setup();
    // Emacs: (html nil (body nil (p ((class . "a")) "hi" (comment nil "c") (br nil) "there")))
    assert_eq!(
        parsed(&mut ed, &s, r#"<p class="a">hi<!--c--><br/>there</p>"#, true, false),
        r#"["html",null,["body",null,["p",[["class","a"]],"hi",["comment",null,"c"],["br",null],"there"]]]"#
    );
    // Emacs: (html nil (body nil (p nil "hello"))) — a tag left open is closed.
    assert_eq!(parsed(&mut ed, &s, "<p>hello", true, false), r#"["html",null,["body",null,["p",null,"hello"]]]"#);
    // Emacs: (html nil (head nil (title nil "t"))) — no body where there is nothing in one.
    assert_eq!(parsed(&mut ed, &s, "<title>t</title>", true, false), r#"["html",null,["head",null,["title",null,"t"]]]"#);
    // Emacs: (html nil (head nil (title nil "t")) (body nil (p nil "x")))
    assert_eq!(
        parsed(&mut ed, &s, "<head><title>t</title></head><p>x</p>", true, false),
        r#"["html",null,["head",null,["title",null,"t"]],["body",null,["p",null,"x"]]]"#
    );
    // Emacs: (html nil (body nil (a ((href . "x")) "t") " tail"))
    assert_eq!(
        parsed(&mut ed, &s, "<a href='x'>t</a> tail", true, false),
        r#"["html",null,["body",null,["a",[["href","x"]],"t"]," tail"]]"#
    );
}

#[test]
fn xml_comes_out_as_the_tree_emacs_gives() {
    let (mut ed, s) = setup();
    // Emacs: (r ((a . "1")) (k nil "v"))
    assert_eq!(parsed(&mut ed, &s, r#"<r a="1"><k>v</k></r>"#, false, false), r#"["r",[["a","1"]],["k",null,"v"]]"#);
    // Emacs: (r nil "a" (comment nil "c") "b")
    assert_eq!(parsed(&mut ed, &s, "<r>a<!--c-->b</r>", false, false), r#"["r",null,"a",["comment",null,"c"],"b"]"#);
    // Emacs answers nil for text that is no XML.
    assert_eq!(parsed(&mut ed, &s, "not xml <<<", false, false), "null");
    // Emacs: (R nil (c ((a . "1")))) — a namespace prefix is dropped, case kept.
    assert_eq!(parsed(&mut ed, &s, "<R xmlns:k='u'><k:c a='1'/></R>", false, false), r#"["R",null,["c",[["a","1"]]]]"#);
}

#[test]
fn comments_are_dropped_when_they_are_not_wanted() {
    let (mut ed, s) = setup();
    assert_eq!(parsed(&mut ed, &s, "<p>a<!--c-->b</p>", true, true), r#"["html",null,["body",null,["p",null,"a","b"]]]"#);
    assert_eq!(parsed(&mut ed, &s, "<r>a<!--c-->b</r>", false, true), r#"["r",null,"a","b"]"#);
}

#[test]
fn parsing_is_available_and_a_region_past_the_end_is_refused() {
    let (mut ed, s) = setup();
    assert_eq!(s.eval_expression(&mut ed, "e8.libxmlAvailableP()").unwrap(), "true");
    assert!(s.eval_expression(&mut ed, "e8.libxmlParseHtmlRegion(10, 20)").is_err());
}

#[test]
fn what_is_outside_the_root_element_wraps_the_tree_in_a_top_node() {
    let (mut ed, s) = setup();
    // Emacs: (top nil (comment nil "top") (html nil (body nil (p nil "x"))))
    assert_eq!(
        parsed(&mut ed, &s, "<!--top--><p>x", true, false),
        r#"["top",null,["comment",null,"top"],["html",null,["body",null,["p",null,"x"]]]]"#
    );
    // Emacs: (top nil (html nil (body nil "x")) (comment nil "t"))
    assert_eq!(
        parsed(&mut ed, &s, "<html><body>x</body></html><!--t-->", true, false),
        r#"["top",null,["html",null,["body",null,"x"]],["comment",null,"t"]]"#
    );
    // With the comments dropped there is nothing outside, so no wrapper.
    assert_eq!(parsed(&mut ed, &s, "<!--c--><r>x</r>", false, true), r#"["r",null,"x"]"#);
}

#[test]
fn a_head_or_body_the_page_wrote_is_kept_even_when_it_is_empty() {
    let (mut ed, s) = setup();
    // Emacs: (html nil (head nil) (body nil))
    assert_eq!(parsed(&mut ed, &s, "<html><head></head><body></body></html>", true, false), r#"["html",null,["head",null],["body",null]]"#);
    // Emacs: (html nil (head nil (title nil "t")) (body nil))
    assert_eq!(
        parsed(&mut ed, &s, "<html><head><title>t</title></head><body></body></html>", true, false),
        r#"["html",null,["head",null,["title",null,"t"]],["body",null]]"#
    );
}

#[test]
fn noscript_and_mathml_hold_the_elements_in_them() {
    let (mut ed, s) = setup();
    // Nothing runs scripts, so noscript holds elements, not text.
    // Emacs: (html nil (body nil (p nil "a") (noscript nil (b nil "y"))))
    assert_eq!(
        parsed(&mut ed, &s, "<p>a</p><noscript><b>y</b></noscript>", true, false),
        r#"["html",null,["body",null,["p",null,"a"],["noscript",null,["b",null,"y"]]]]"#
    );
    // Emacs: (html nil (body nil (math nil (annotation-xml ((encoding . "text/html")) (p nil "x")))))
    assert_eq!(
        parsed(&mut ed, &s, "<math><annotation-xml encoding='text/html'><p>x</p></annotation-xml></math>", true, false),
        r#"["html",null,["body",null,["math",null,["annotation-xml",[["encoding","text/html"]],["p",null,"x"]]]]]"#
    );
}

#[test]
fn a_processing_instruction_keeps_its_place_as_nil() {
    let (mut ed, s) = setup();
    // Emacs: (r nil nil "x")
    assert_eq!(parsed(&mut ed, &s, "<r><?pi data?>x</r>", false, false), r#"["r",null,null,"x"]"#);
}

#[test]
fn the_region_is_the_accessible_part_of_the_buffer() {
    let (mut ed, s) = setup();
    ed.type_text("<p>abc</p>");
    // Emacs signals for a region outside what narrowing leaves accessible.
    s.eval_expression(&mut ed, "e8.narrowToRegion(3, 6)").unwrap();
    assert!(s.eval_expression(&mut ed, "e8.libxmlParseHtmlRegion(0, 10)").is_err());
    // With no arguments it parses what is accessible, as Emacs's does.
    let got = s.eval_expression(&mut ed, "JSON.stringify(e8.libxmlParseHtmlRegion())").unwrap();
    assert_eq!(serde_json::from_str::<String>(&got).unwrap_or(got), r#"["html",null,["body",null,"abc"]]"#);
}
