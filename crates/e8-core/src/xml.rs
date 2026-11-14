//! Parsing HTML and XML, as Emacs's xml.c does with libxml2: a document
//! becomes the tree `(TAG ATTRS . CHILDREN)` that dom.el walks, which E8
//! hands scripts as `[tag, attrs, ...children]` ([ADR 0080]).
//!
//! HTML is parsed by `html5ever`, the HTML5 algorithm browsers follow, so
//! a page with missing or crossed tags comes out as a browser reads it,
//! as libxml2's recovering parser does for Emacs. XML is parsed by
//! `roxmltree`, which `resvg` already brings.
//!
//! [ADR 0080]: ../../../../docs/adr/0080-xml-and-html-as-emacs-parses-them.md

use std::cell::{Ref, RefCell};

use html5ever::tendril::TendrilSink;
use html5ever::{Attribute, QualName, tendril::StrTendril};
use html5ever::interface::{ElementFlags, NodeOrText, QuirksMode, TreeSink};

use crate::variables::Value;

/// A node of the tree being built: an element with its name, attributes
/// and children, or the text, comment or processing instruction it holds.
#[derive(Debug)]
struct Node {
    name: QualName,
    attrs: Vec<(String, String)>,
    kind: Kind,
    children: Vec<usize>,
    parent: Option<usize>,
    /// Whether the tree builder made it an HTML integration point, which
    /// it asks about again while it parses MathML.
    integration_point: bool,
}

#[derive(Debug, PartialEq)]
enum Kind {
    Document,
    Element,
    Text(String),
    Comment(String),
}

/// The tree html5ever builds into: nodes in a vector, a handle being an
/// index, so a node can be moved about without any reference counting.
struct Sink {
    nodes: RefCell<Vec<Node>>,
}

fn element_name(local: &str) -> QualName {
    QualName::new(None, html5ever::ns!(), local.into())
}

impl Sink {
    fn new() -> Sink {
        let document =
            Node { name: element_name("document"), attrs: Vec::new(), kind: Kind::Document, children: Vec::new(), parent: None, integration_point: false };
        Sink { nodes: RefCell::new(vec![document]) }
    }

    fn push(&self, node: Node) -> usize {
        let mut nodes = self.nodes.borrow_mut();
        nodes.push(node);
        nodes.len() - 1
    }

    fn new_node(&self, name: QualName, attrs: Vec<Attribute>, kind: Kind) -> usize {
        let attrs = attrs.into_iter().map(|a| (a.name.local.to_string(), a.value.to_string())).collect();
        self.push(Node { name, attrs, kind, children: Vec::new(), parent: None, integration_point: false })
    }

    /// Takes a node out of the children of whatever holds it.
    fn detach(&self, node: usize) {
        let mut nodes = self.nodes.borrow_mut();
        if let Some(parent) = nodes[node].parent.take() {
            nodes[parent].children.retain(|&c| c != node);
        }
    }

    /// Puts `child` among `parent`'s children at `at`, or at the end.
    fn insert(&self, parent: usize, child: usize, at: Option<usize>) {
        self.detach(child);
        let mut nodes = self.nodes.borrow_mut();
        nodes[child].parent = Some(parent);
        match at {
            Some(i) => nodes[parent].children.insert(i, child),
            None => nodes[parent].children.push(child),
        }
    }

    /// Adds text to a node's children, joining it to the text already
    /// there at `at`, as the tree builder asks of `append`.
    fn insert_text(&self, parent: usize, text: &str, at: Option<usize>) {
        {
            let mut nodes = self.nodes.borrow_mut();
            let neighbour = match at {
                Some(0) => None,
                Some(i) => nodes[parent].children.get(i - 1).copied(),
                None => nodes[parent].children.last().copied(),
            };
            if let Some(neighbour) = neighbour
                && let Kind::Text(had) = &mut nodes[neighbour].kind
            {
                had.push_str(text);
                return;
            }
        }
        let node = self.push(Node {
            name: element_name("text"),
            attrs: Vec::new(),
            kind: Kind::Text(text.to_string()),
            children: Vec::new(),
            parent: None,
            integration_point: false,
        });
        self.insert(parent, node, at);
    }

    /// Where a node sits among its parent's children.
    fn index_of(&self, node: usize) -> Option<(usize, usize)> {
        let nodes = self.nodes.borrow();
        let parent = nodes[node].parent?;
        let at = nodes[parent].children.iter().position(|&c| c == node)?;
        Some((parent, at))
    }

    /// The tree as Emacs's: the first element under the document, which
    /// for HTML is always `html`, with comments dropped if asked.
    ///
    /// The HTML5 algorithm always makes a `head` and a `body`; libxml2
    /// makes only what the page has, so an empty one is dropped, which
    /// leaves the tree Emacs gives for every page that has one.
    fn into_value(mut self, source: &str, discard_comments: bool) -> Option<Value> {
        let nodes = self.nodes.get_mut();
        let root = *nodes[0].children.iter().find(|&&c| nodes[c].kind == Kind::Element)?;
        // The HTML5 algorithm always makes a `head` and a `body`; libxml2
        // makes only what the page has, so one the page did not write and
        // that is empty is dropped, which gives Emacs's tree.
        let written = |tag: &str| {
            let tag = format!("<{tag}");
            source.as_bytes().windows(tag.len()).any(|w| w.eq_ignore_ascii_case(tag.as_bytes()))
        };
        let empty: Vec<usize> = nodes[root]
            .children
            .iter()
            .copied()
            .filter(|&c| {
                let tag = nodes[c].name.local.as_ref();
                matches!(tag, "head" | "body") && nodes[c].children.is_empty() && !written(tag)
            })
            .collect();
        nodes[root].children.retain(|c| !empty.contains(c));
        // What is outside the root element — a comment before or after it
        // — makes Emacs wrap the whole document in a `top` node.
        let kept: Vec<usize> = nodes[0]
            .children
            .iter()
            .copied()
            .filter(|&c| c == root || !(discard_comments && matches!(nodes[c].kind, Kind::Comment(_))))
            .collect();
        let mut trees = kept.iter().map(|&c| node_value(nodes, c, discard_comments, 0));
        if kept.len() == 1 {
            return trees.next();
        }
        Some(Value::List(vec![Value::Str("top".into()), Value::Null].into_iter().chain(trees).collect()))
    }
}

/// How deep a tree is walked, as libxml2 parses HTML 256 deep: past it a
/// node is given without its children, so neither the tree nor the walk
/// over it can run away.
const MAX_DEPTH: usize = 256;

/// One node as the list Emacs gives: `[tag, attrs, ...children]`, or the
/// string a text node is.
fn node_value(nodes: &[Node], node: usize, discard_comments: bool, depth: usize) -> Value {
    let node = &nodes[node];
    if let Kind::Text(text) = &node.kind {
        return Value::Str(text.clone());
    }
    let (tag, children) = match &node.kind {
        Kind::Comment(text) => ("comment".to_string(), vec![Value::Str(text.clone())]),
        _ => {
            // Past the depth libxml2 parses to, a node has no children,
            // so neither the tree nor this recursion can run away.
            let children = if depth >= MAX_DEPTH {
                Vec::new()
            } else {
                node.children
                    .iter()
                    .filter(|&&c| !(discard_comments && matches!(nodes[c].kind, Kind::Comment(_))))
                    .map(|&c| node_value(nodes, c, discard_comments, depth + 1))
                    .collect()
            };
            (node.name.local.to_string(), children)
        }
    };
    let attrs = if node.attrs.is_empty() {
        Value::Null
    } else {
        Value::List(node.attrs.iter().map(|(k, v)| Value::List(vec![Value::Str(k.clone()), Value::Str(v.clone())])).collect())
    };
    Value::List(std::iter::once(Value::Str(tag)).chain(std::iter::once(attrs)).chain(children).collect())
}

impl TreeSink for Sink {
    type Handle = usize;
    type Output = Sink;
    type ElemName<'a> = Ref<'a, QualName>;

    fn finish(self) -> Sink {
        self
    }

    fn parse_error(&self, _message: std::borrow::Cow<'static, str>) {}

    fn get_document(&self) -> usize {
        0
    }

    fn elem_name<'a>(&'a self, target: &'a usize) -> Ref<'a, QualName> {
        Ref::map(self.nodes.borrow(), |nodes| &nodes[*target].name)
    }

    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> usize {
        let node = self.new_node(name, attrs, Kind::Element);
        self.nodes.borrow_mut()[node].integration_point = flags.mathml_annotation_xml_integration_point;
        node
    }

    fn create_comment(&self, text: StrTendril) -> usize {
        self.new_node(element_name("comment"), Vec::new(), Kind::Comment(text.to_string()))
    }

    fn create_pi(&self, target: StrTendril, data: StrTendril) -> usize {
        // Emacs's tree has no processing instructions; one reads as a
        // comment, which is what libxml2 leaves in an HTML document.
        self.new_node(element_name("comment"), Vec::new(), Kind::Comment(format!("{target} {data}")))
    }

    fn append(&self, parent: &usize, child: NodeOrText<usize>) {
        match child {
            NodeOrText::AppendNode(node) => self.insert(*parent, node, None),
            NodeOrText::AppendText(text) => self.insert_text(*parent, &text, None),
        }
    }

    fn append_based_on_parent_node(&self, element: &usize, prev_element: &usize, child: NodeOrText<usize>) {
        if self.nodes.borrow()[*element].parent.is_some() {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }

    fn append_doctype_to_document(&self, _name: StrTendril, _public: StrTendril, _system: StrTendril) {}

    fn get_template_contents(&self, target: &usize) -> usize {
        *target
    }

    fn same_node(&self, x: &usize, y: &usize) -> bool {
        x == y
    }

    fn set_quirks_mode(&self, _mode: QuirksMode) {}

    fn is_mathml_annotation_xml_integration_point(&self, handle: &usize) -> bool {
        self.nodes.borrow()[*handle].integration_point
    }

    fn append_before_sibling(&self, sibling: &usize, new_node: NodeOrText<usize>) {
        let Some((parent, at)) = self.index_of(*sibling) else { return };
        match new_node {
            NodeOrText::AppendNode(node) => {
                // Detaching it first can move the sibling along, so where
                // it sits is worked out again.
                self.detach(node);
                let at = self.index_of(*sibling).map_or(at, |(_, at)| at);
                self.insert(parent, node, Some(at));
            }
            NodeOrText::AppendText(text) => self.insert_text(parent, &text, Some(at)),
        }
    }

    fn add_attrs_if_missing(&self, target: &usize, attrs: Vec<Attribute>) {
        let mut nodes = self.nodes.borrow_mut();
        for attr in attrs {
            let name = attr.name.local.to_string();
            if !nodes[*target].attrs.iter().any(|(had, _)| *had == name) {
                nodes[*target].attrs.push((name, attr.value.to_string()));
            }
        }
    }

    fn remove_from_parent(&self, target: &usize) {
        self.detach(*target);
    }

    fn reparent_children(&self, node: &usize, new_parent: &usize) {
        let moved = std::mem::take(&mut self.nodes.borrow_mut()[*node].children);
        for child in moved {
            self.nodes.borrow_mut()[child].parent = None;
            self.insert(*new_parent, child, None);
        }
    }
}

/// Parses HTML as a browser would, as `libxml-parse-html-region`: the
/// `html` element, with a `head` and `body` supplied as the HTML5
/// algorithm supplies them. Returns `None` only for text with no element
/// at all, which cannot happen for HTML.
pub fn parse_html(text: &str, discard_comments: bool) -> Option<Value> {
    // Nothing runs scripts, so `<noscript>` holds elements rather than
    // the text the spec gives it where scripting is on.
    let options = html5ever::ParseOpts {
        tree_builder: html5ever::tree_builder::TreeBuilderOpts { scripting_enabled: false, ..Default::default() },
        ..Default::default()
    };
    let sink: Sink = html5ever::parse_document(Sink::new(), options).one(text);
    sink.into_value(text, discard_comments)
}

/// Parses XML, as `libxml-parse-xml-region`: the root element, or `None`
/// where the text is not well-formed XML, as Emacs answers nil.
///
/// A name's namespace prefix is dropped, as Emacs's tree keeps the local
/// name alone.
pub fn parse_xml(text: &str, discard_comments: bool) -> Option<Value> {
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let document = roxmltree::Document::parse_with_options(text, options).ok()?;
    Some(xml_value(document.root_element(), discard_comments, 0))
}

fn xml_value(node: roxmltree::Node<'_, '_>, discard_comments: bool, depth: usize) -> Value {
    if node.is_text() {
        return Value::Str(node.text().unwrap_or_default().to_string());
    }
    if let Some(text) = node.is_comment().then(|| node.text().unwrap_or_default()) {
        return Value::List(vec![Value::Str("comment".into()), Value::Null, Value::Str(text.to_string())]);
    }
    let attrs: Vec<Value> = node
        .attributes()
        .map(|a| Value::List(vec![Value::Str(a.name().to_string()), Value::Str(a.value().to_string())]))
        .collect();
    let attrs = if attrs.is_empty() { Value::Null } else { Value::List(attrs) };
    let children: Vec<Value> = if depth >= MAX_DEPTH {
        Vec::new()
    } else {
        node.children()
            .filter(|c| c.is_element() || c.is_text() || c.is_pi() || (c.is_comment() && !discard_comments))
            // A processing instruction is nil in Emacs's tree, which keeps
            // the children of a node in the places they were in.
            .map(|c| if c.is_pi() { Value::Null } else { xml_value(c, discard_comments, depth + 1) })
            .collect()
    };
    Value::List(std::iter::once(Value::Str(node.tag_name().name().to_string())).chain(std::iter::once(attrs)).chain(children).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &Value) -> String {
        match value {
            Value::Str(s) => format!("{s:?}"),
            Value::Null => "nil".into(),
            Value::List(items) => format!("({})", items.iter().map(text).collect::<Vec<_>>().join(" ")),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn html_comes_out_as_emacs_gives_it() {
        let got = parse_html("<p>a<!--c-->b</p>", false).unwrap();
        // Emacs: (html nil (body nil (p nil "a" (comment nil "c") "b")))
        assert_eq!(text(&got), r#"("html" nil ("body" nil ("p" nil "a" ("comment" nil "c") "b")))"#);
        let dropped = parse_html("<p>a<!--c-->b</p>", true).unwrap();
        assert_eq!(text(&dropped), r#"("html" nil ("body" nil ("p" nil "a" "b")))"#);
    }

    #[test]
    fn a_page_with_tags_left_open_reads_as_a_browser_reads_it() {
        let got = parse_html("<p>hello", false).unwrap();
        assert_eq!(text(&got), r#"("html" nil ("body" nil ("p" nil "hello")))"#);
        let attrs = parse_html("<a href='x'>t</a> tail", false).unwrap();
        assert_eq!(text(&attrs), r#"("html" nil ("body" nil ("a" (("href" "x")) "t") " tail"))"#);
    }

    #[test]
    fn a_document_nested_deeper_than_emacs_parses_does_not_run_away() {
        // libxml2 gives up at 256 deep; E8 gives the tree to that depth
        // rather than walking a document of any depth at all, which took
        // the editor's stack with it.
        let deep = parse_html(&"<div>".repeat(2000), false).unwrap();
        let drawn = text(&deep);
        assert!(drawn.starts_with(r#"("html" nil ("body" nil ("div" nil ("div" "#));
        assert!((1..=MAX_DEPTH).contains(&drawn.matches("div").count()), "{} deep", drawn.matches("div").count());
        let deep_xml = parse_xml(&format!("<r>{}x{}</r>", "<a>".repeat(1000), "</a>".repeat(1000)), false).unwrap();
        let drawn = text(&deep_xml);
        assert!((1..=MAX_DEPTH).contains(&drawn.matches(r#""a""#).count()));
    }

    #[test]
    fn xml_comes_out_as_emacs_gives_it() {
        let got = parse_xml("<r>a<!--c-->b</r>", false).unwrap();
        assert_eq!(text(&got), r#"("r" nil "a" ("comment" nil "c") "b")"#);
        // Emacs answers nil for text that is no XML.
        assert!(parse_xml("not xml <<<", false).is_none());
        let ns = parse_xml("<R xmlns:k='u'><k:c a='1'/></R>", false).unwrap();
        assert_eq!(text(&ns), r#"("R" nil ("c" (("a" "1"))))"#);
    }
}
