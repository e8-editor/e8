//! Syntax trees from tree-sitter, for highlighting, as Emacs's treesit.el
//! does it. A buffer with a language keeps a tree that edits update
//! incrementally; it is reparsed when a window next needs it. Highlighting
//! queries only the rows being drawn, and the grammar's captures, such as
//! `keyword` or `string`, become the `font-lock-*` faces.

use std::cell::{Cell, OnceCell, RefCell};
use std::rc::Rc;

use ropey::Rope;
use tree_sitter::{InputEdit, Language, Parser, Point, Query, QueryCursor, StreamingIterator, Tree};

use crate::error::{Error, Result};
use crate::variables::Value;

/// A language E8 can parse: a grammar and its highlighting query.
pub(crate) struct Grammar {
    pub(crate) language: Language,
    highlights_source: &'static str,
    /// Compiled on first use, since compiling takes a while.
    highlights: OnceCell<Rc<Query>>,
    /// The shared library a grammar loaded at run time is in, kept open
    /// while the language is used.
    #[cfg(not(target_arch = "wasm32"))]
    _library: Option<libloading::Library>,
}

impl Grammar {
    fn new(language: Language, highlights_source: &'static str) -> Grammar {
        Grammar {
            language,
            highlights_source,
            highlights: OnceCell::new(),
            #[cfg(not(target_arch = "wasm32"))]
            _library: None,
        }
    }

    /// The grammar in a shared library built from a grammar's sources, such
    /// as libtree-sitter-go.dylib, by the function `symbol` that gives its
    /// language, as Emacs's treesit loads one. It has no highlighting query
    /// of its own: a mode gives its font-lock rules.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn load(_path: &std::path::Path, _symbol: &str) -> std::result::Result<Grammar, String> {
        Err("a browser cannot load grammars from shared libraries".into())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn load(path: &std::path::Path, symbol: &str) -> std::result::Result<Grammar, String> {
        // SAFETY: as Emacs does, the library is trusted to be a tree-sitter
        // grammar whose function returns its language; the library stays
        // open as long as the language can be used.
        unsafe {
            let library = libloading::Library::new(path).map_err(|e| e.to_string())?;
            let language: libloading::Symbol<unsafe extern "C" fn() -> *const ()> = library.get(symbol.as_bytes()).map_err(|e| e.to_string())?;
            let language = Language::new(tree_sitter_language::LanguageFn::from_raw(*language));
            if !(tree_sitter::MIN_COMPATIBLE_LANGUAGE_VERSION..=tree_sitter::LANGUAGE_VERSION).contains(&language.abi_version()) {
                return Err(format!("its ABI version {} is not one tree-sitter here reads", language.abi_version()));
            }
            Ok(Grammar { language, highlights_source: "", highlights: OnceCell::new(), _library: Some(library) })
        }
    }

    fn highlights(&self) -> Result<Rc<Query>> {
        if let Some(query) = self.highlights.get() {
            return Ok(query.clone());
        }
        let query = Query::new(&self.language, self.highlights_source)
            .map_err(|e| Error::new(format!("The highlighting query does not compile: {e}")))?;
        Ok(self.highlights.get_or_init(|| Rc::new(query)).clone())
    }
}

/// How a font-lock rule's faces go over those rules before it gave, as
/// treesit-font-lock-rules' `:override`: not over any (nil), over all (t),
/// after them (append), before them (prepend), or only where there are
/// none (keep). A character here has one face, so append and keep fill
/// in, and prepend and t replace.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Override {
    Nil,
    T,
    Append,
    Prepend,
    Keep,
}

impl Override {
    pub(crate) fn of(value: &crate::variables::Value) -> Override {
        match value.as_str() {
            Some("t") => Override::T,
            Some("append") => Override::Append,
            Some("prepend") => Override::Prepend,
            Some("keep") => Override::Keep,
            _ if matches!(value, crate::variables::Value::Bool(true)) => Override::T,
            _ => Override::Nil,
        }
    }
}

/// A mode's font-lock rules as the core runs them: each query, compiled,
/// with its override, in order.
pub(crate) type Rules = Vec<(Rc<Query>, Override)>;

/// A face named by a capture, as a name that lives as long as the program:
/// each name is kept once.
fn interned(name: &str) -> &'static str {
    static NAMES: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    let mut names = NAMES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(n) = names.iter().find(|n| **n == name) {
        return n;
    }
    let n: &'static str = Box::leak(name.to_string().into_boxed_str());
    names.push(n);
    n
}

/// The grammars that ship with E8, by the names Emacs uses for them.
pub(crate) fn builtin_grammars() -> Vec<(&'static str, Grammar)> {
    vec![
        ("javascript", Grammar::new(tree_sitter_javascript::LANGUAGE.into(), tree_sitter_javascript::HIGHLIGHT_QUERY)),
        ("json", Grammar::new(tree_sitter_json::LANGUAGE.into(), tree_sitter_json::HIGHLIGHTS_QUERY)),
        ("python", Grammar::new(tree_sitter_python::LANGUAGE.into(), tree_sitter_python::HIGHLIGHTS_QUERY)),
        ("rust", Grammar::new(tree_sitter_rust::LANGUAGE.into(), tree_sitter_rust::HIGHLIGHTS_QUERY)),
    ]
}

/// A buffer's syntax tree, and the parser that keeps it, as Emacs's
/// tree-sitter parser objects.
pub(crate) struct SyntaxTree {
    /// Its id, which parser and node objects refer to it by.
    pub(crate) id: u64,
    pub(crate) language: String,
    /// The tag code gave it, as `treesit-parser-create`'s TAG.
    pub(crate) tag: Option<String>,
    /// Whether it is the one the major mode made, which highlights.
    pub(crate) primary: bool,
    /// Counts the trees parsed, so a node from an earlier one is known to
    /// be out of date, as Emacs's node timestamps.
    pub(crate) generation: Cell<u64>,
    parser: RefCell<Parser>,
    tree: RefCell<Option<Tree>>,
    /// Whether edits since the last parse are waiting to be parsed.
    stale: Cell<bool>,
    query: Rc<Query>,
    /// The mode's font-lock rules, which highlight in place of the
    /// grammar's query once a mode gives them, as Emacs's
    /// treesit-font-lock-settings do.
    rules: RefCell<Option<Rules>>,
}

impl SyntaxTree {
    pub(crate) fn new(name: &str, grammar: &Grammar, tag: Option<String>, primary: bool) -> Result<SyntaxTree> {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let mut parser = Parser::new();
        parser
            .set_language(&grammar.language)
            .map_err(|e| Error::new(format!("Cannot use the {name} grammar: {e}")))?;
        Ok(SyntaxTree {
            id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            language: name.to_string(),
            tag,
            primary,
            generation: Cell::new(0),
            parser: RefCell::new(parser),
            tree: RefCell::new(None),
            stale: Cell::new(true),
            query: grammar.highlights()?,
            rules: RefCell::new(None),
        })
    }

    /// Tells the tree about an edit, so the next parse can reuse what did not change.
    pub(crate) fn edit(&self, edit: &InputEdit) {
        if let Some(tree) = self.tree.borrow_mut().as_mut() {
            tree.edit(edit);
        }
        self.stale.set(true);
    }

    pub(crate) fn reset(&self) {
        *self.tree.borrow_mut() = None;
        self.stale.set(true);
    }

    /// The tree as last parsed, with the edits since applied to it but not
    /// parsed again, as a node taken from it still sees it in Emacs.
    pub(crate) fn last_parsed(&self) -> Option<Tree> {
        self.tree.borrow().clone()
    }

    /// The tree for the text, parsing first if it is out of date.
    pub(crate) fn parsed(&self, text: &Rope) -> Option<Tree> {
        if self.stale.get() || self.tree.borrow().is_none() {
            let old = self.tree.borrow().clone();
            let len = text.len_bytes();
            let mut read = |byte: usize, _: Point| -> &[u8] {
                if byte >= len {
                    return &[];
                }
                let (chunk, start, _, _) = text.chunk_at_byte(byte);
                &chunk.as_bytes()[byte - start..]
            };
            let tree = self.parser.borrow_mut().parse_with_options(&mut read, old.as_ref(), None);
            *self.tree.borrow_mut() = tree;
            self.stale.set(false);
            self.generation.set(self.generation.get() + 1);
        }
        self.tree.borrow().clone()
    }

    /// Highlights with a mode's font-lock rules, in order, in place of the
    /// grammar's query, or with the grammar's again for `None`.
    pub(crate) fn set_rules(&self, rules: Option<Rules>) {
        *self.rules.borrow_mut() = rules;
    }

    /// The faces the mode's font-lock rules give, as Emacs's
    /// treesit-font-lock-fontify-region does: each rule in turn, its
    /// captures in the order of the text, each face over the capture's
    /// node as the rule's override says.
    fn faces_by_rules(&self, rules: &Rules, tree: &Tree, text: &Rope, start: usize, end: usize) -> Vec<Option<&'static str>> {
        let mut faces: Vec<Option<&'static str>> = vec![None; end.saturating_sub(start)];
        let (start_byte, end_byte) = (text.char_to_byte(start), text.char_to_byte(end));
        let source = |node: tree_sitter::Node| text.byte_slice(node.byte_range()).chunks().map(str::as_bytes);
        for (query, over) in rules {
            let mut cursor = QueryCursor::new();
            cursor.set_byte_range(start_byte..end_byte);
            let names = query.capture_names();
            let mut captures = cursor.captures(query, tree.root_node(), source);
            while let Some((m, i)) = captures.next() {
                let capture = m.captures()[*i];
                let name = names[capture.index as usize];
                // Captures a rule uses for its predicates, as @_name, give no face.
                if name.starts_with('_') {
                    continue;
                }
                let face = interned(name);
                let range = capture.node.byte_range();
                let from = text.byte_to_char(range.start.max(start_byte)).max(start) - start;
                let to = text.byte_to_char(range.end.min(end_byte)).min(end) - start;
                let Some(slots) = faces.get_mut(from..to) else { continue };
                match over {
                    Override::Nil if slots.iter().all(Option::is_none) => slots.fill(Some(face)),
                    Override::Nil => {}
                    Override::T | Override::Prepend => slots.fill(Some(face)),
                    Override::Append | Override::Keep => slots.iter_mut().filter(|s| s.is_none()).for_each(|s| *s = Some(face)),
                }
            }
        }
        faces
    }

    /// The faces of the characters from `start` up to `end`, one for each,
    /// from the mode's font-lock rules, else the highlighting query. With
    /// the query, where captures overlap, the innermost wins, and among
    /// captures of the same text the query's first.
    pub(crate) fn faces(&self, text: &Rope, start: usize, end: usize) -> Vec<Option<&'static str>> {
        let mut faces = vec![None; end.saturating_sub(start)];
        let Some(tree) = self.parsed(text) else { return faces };
        if let Some(rules) = self.rules.borrow().as_ref() {
            return self.faces_by_rules(rules, &tree, text, start, end);
        }
        let (start_byte, end_byte) = (text.char_to_byte(start), text.char_to_byte(end));
        let mut cursor = QueryCursor::new();
        cursor.set_byte_range(start_byte..end_byte);
        let source = |node: tree_sitter::Node| text.byte_slice(node.byte_range()).chunks().map(str::as_bytes);
        let names = self.query.capture_names();
        let mut spans = Vec::new();
        let mut captures = cursor.captures(&self.query, tree.root_node(), source);
        while let Some((m, i)) = captures.next() {
            let capture = m.captures()[*i];
            if let Some(face) = capture_face(names[capture.index as usize]) {
                spans.push((capture.node.byte_range(), m.pattern_index, face));
            }
        }
        // Longer spans first, so shorter ones inside them are painted over;
        // for the same text, the query's first pattern is painted last.
        spans.sort_by_key(|a| std::cmp::Reverse((a.0.len(), a.1)));
        for (range, _, face) in spans {
            let from = text.byte_to_char(range.start.max(start_byte)).max(start) - start;
            let to = text.byte_to_char(range.end.min(end_byte)).min(end) - start;
            for slot in &mut faces[from..to] {
                *slot = Some(face);
            }
        }
        faces
    }

    /// The kind of the smallest named node at a character position, and its range.
    pub(crate) fn node_at(&self, text: &Rope, pos: usize) -> Option<(String, usize, usize)> {
        let tree = self.parsed(text)?;
        let byte = text.char_to_byte(pos.min(text.len_chars()));
        let node = tree.root_node().named_descendant_for_byte_range(byte, byte)?;
        let range = node.byte_range();
        Some((node.kind().to_string(), text.byte_to_char(range.start), text.byte_to_char(range.end)))
    }
}

/// The face for a capture name, trying `keyword.control.rust`, then
/// `keyword.control`, then `keyword`.
fn capture_face(name: &str) -> Option<&'static str> {
    let mut name = name;
    loop {
        let face = match name {
            "comment" => Some("font-lock-comment-face"),
            "string" | "character" | "string.special" => Some("font-lock-string-face"),
            "escape" | "string.escape" | "string.regexp" => Some("font-lock-escape-face"),
            "keyword" | "conditional" | "repeat" | "include" | "exception" => Some("font-lock-keyword-face"),
            "function.macro" | "attribute" | "preproc" => Some("font-lock-builtin-face"),
            "function" | "method" | "function.method" | "function.call" | "constructor.call" => {
                Some("font-lock-function-call-face")
            }
            "type" | "constructor" | "module" | "namespace" => Some("font-lock-type-face"),
            "number" | "float" => Some("font-lock-number-face"),
            "constant" | "boolean" | "label" => Some("font-lock-constant-face"),
            "variable.builtin" | "type.builtin" | "function.builtin" => Some("font-lock-builtin-face"),
            "variable.parameter" | "parameter" => Some("font-lock-variable-name-face"),
            "property" | "field" | "tag" => Some("font-lock-property-name-face"),
            "operator" => Some("font-lock-operator-face"),
            "punctuation" => Some("font-lock-punctuation-face"),
            _ => None,
        };
        if face.is_some() {
            return face;
        }
        // Built-in variants fall back to the plain capture: "constant.builtin" to "constant".
        name = name.rsplit_once('.')?.0;
    }
}

impl crate::editor::Editor {
    /// The languages E8 has grammars for.
    pub fn treesit_languages(&self) -> Vec<&'static str> {
        self.grammars.keys().copied().collect()
    }

    /// Makes sure a language's grammar is there, loading one that does not
    /// ship with E8 as Emacs's treesit does: libtree-sitter-LANG.dylib,
    /// or .so, in a directory of `treesit-extra-load-path` or the
    /// tree-sitter directory of `user-emacs-directory`, by its function
    /// tree_sitter_LANG, unless `treesit-load-name-override-list` names
    /// others. The reason there is none, if there is none.
    pub(crate) fn ensure_grammar(&mut self, language: &str) -> std::result::Result<(), String> {
        if self.grammars.contains_key(language) {
            return Ok(());
        }
        let strings = |v: Option<Value>| match v {
            Some(Value::List(items)) => items,
            _ => Vec::new(),
        };
        let (mut library, mut symbol) = (format!("libtree-sitter-{language}"), format!("tree_sitter_{}", language.replace('-', "_")));
        for entry in strings(self.variable("treesit-load-name-override-list")) {
            if let Value::List(parts) = entry
                && parts.first().and_then(Value::as_str) == Some(language)
            {
                library = parts.get(1).and_then(Value::as_str).unwrap_or(&library).to_string();
                symbol = parts.get(2).and_then(Value::as_str).unwrap_or(&symbol).to_string();
            }
        }
        let mut dirs: Vec<std::path::PathBuf> =
            strings(self.variable("treesit-extra-load-path")).iter().filter_map(|d| d.as_str().map(crate::files::expand_file_name)).collect();
        if let Some(dir) = self.variable("user-emacs-directory").and_then(|d| d.as_str().map(str::to_string)) {
            dirs.push(crate::files::expand_file_name(&dir).join("tree-sitter"));
        }
        let mut reason = format!("No grammar for {language}");
        for dir in dirs {
            for ext in ["dylib", "so"] {
                let path = dir.join(format!("{library}.{ext}"));
                if !crate::vfs::path_is_file(&path) {
                    continue;
                }
                match Grammar::load(&path, &symbol) {
                    Ok(grammar) => {
                        // Languages are few and loaded once, so their names can live on.
                        self.grammars.insert(Box::leak(language.to_string().into_boxed_str()), grammar);
                        return Ok(());
                    }
                    Err(e) => reason = format!("{}: {e}", path.display()),
                }
            }
        }
        Err(reason)
    }

    /// Gives the primary parsers of a language in the current buffer a
    /// mode's font-lock rules, each a query and its override, in order, as
    /// treesit-font-lock-settings enabled them; they highlight in place of
    /// the grammar's own query.
    pub(crate) fn set_font_lock_rules(&mut self, language: &str, rules: Rules) {
        for parser in self.buffer().parsers.iter().filter(|p| p.primary && p.language == language) {
            parser.set_rules(Some(rules.clone()));
        }
    }

    /// Gives the current buffer a syntax tree in a language, as a major mode
    /// does with Emacs's `treesit-parser-create`. `None` removes it.
    pub fn set_buffer_language(&mut self, language: Option<&str>) -> Result<()> {
        if let Some(name) = language {
            self.ensure_grammar(name).map_err(Error::new)?;
        }
        let syntax = match language {
            Some(name) => {
                let grammar = self
                    .grammars
                    .get(name)
                    .ok_or_else(|| Error::new(format!("No grammar for {name}")))?;
                Some(SyntaxTree::new(name, grammar, None, true)?)
            }
            None => None,
        };
        let b = self.buffer_mut();
        b.parsers.retain(|p| !p.primary);
        if let Some(syntax) = syntax {
            b.parsers.insert(0, syntax);
        }
        Ok(())
    }

    /// Puts the faces the current buffer's syntax tree gives the text from
    /// `start` to `end` on it as `face` properties, as Emacs's
    /// treesit-font-lock-fontify-region does, for code that copies faces
    /// from a buffer, as Org's source blocks do. Redisplay draws them from
    /// the tree without this.
    pub fn treesit_font_lock_fontify_region(&mut self, start: usize, end: usize) {
        let b = self.buffer();
        let end = end.min(b.len());
        let Some(syntax) = b.primary_syntax() else { return };
        if start >= end {
            return;
        }
        let faces = syntax.faces(b.text(), start, end);
        let mut runs: Vec<(usize, usize, &'static str)> = Vec::new();
        for (i, face) in faces.iter().enumerate() {
            let Some(face) = face else { continue };
            match runs.last_mut() {
                Some((_, e, f)) if *e == start + i && f == face => *e += 1,
                _ => runs.push((start + i, start + i + 1, face)),
            }
        }
        let b = self.buffer_mut();
        for (s, e, face) in runs {
            b.change_text_property(s..e, "face", Some(Value::Str(face.to_string())));
        }
    }

    /// The current buffer's language, if it has a syntax tree.
    pub fn buffer_language(&self) -> Option<&str> {
        self.buffer().primary_syntax().map(|s| s.language.as_str())
    }

    /// The kind and range of the smallest named syntax node at a position.
    pub fn syntax_node_at(&self, pos: usize) -> Option<(String, usize, usize)> {
        let b = self.buffer();
        b.primary_syntax()?.node_at(b.text(), pos)
    }
}

/// Where a character position is, for tree-sitter: its byte offset, and its
/// line and byte column.
pub(crate) fn point_at(text: &Rope, pos: usize) -> (usize, Point) {
    let byte = text.char_to_byte(pos);
    let line = text.char_to_line(pos);
    (byte, Point { row: line, column: byte - text.line_to_byte(line) })
}

pub(crate) fn input_edit(start: (usize, Point), old_end: (usize, Point), new_end: (usize, Point)) -> InputEdit {
    InputEdit {
        start_byte: start.0,
        old_end_byte: old_end.0,
        new_end_byte: new_end.0,
        start_position: start.1,
        old_end_position: old_end.1,
        new_end_position: new_end.1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn faces_of(language: &str, source: &str) -> Vec<(String, &'static str)> {
        let grammars = builtin_grammars();
        let grammar = &grammars.iter().find(|(n, _)| *n == language).unwrap().1;
        let tree = SyntaxTree::new(language, grammar, None, true).unwrap();
        let text = Rope::from_str(source);
        let faces = tree.faces(&text, 0, text.len_chars());
        // Runs of the same face, with their text.
        let mut runs: Vec<(String, &'static str)> = Vec::new();
        for (i, face) in faces.iter().enumerate() {
            let Some(face) = face else { continue };
            match runs.last_mut() {
                Some((s, f)) if f == face && faces[i - 1] == Some(face) => s.push(text.char(i)),
                _ => runs.push((text.char(i).to_string(), face)),
            }
        }
        runs
    }

    #[test]
    fn highlights_rust() {
        let runs = faces_of("rust", "fn main() { let s = \"hi\"; // note\n}");
        assert!(runs.contains(&("fn".into(), "font-lock-keyword-face")), "{runs:?}");
        assert!(runs.contains(&("\"hi\"".into(), "font-lock-string-face")), "{runs:?}");
        assert!(runs.contains(&("// note".into(), "font-lock-comment-face")), "{runs:?}");
        assert!(runs.iter().any(|(s, f)| s == "main" && f.contains("function")), "{runs:?}");
    }

    #[test]
    fn highlights_json_and_python() {
        let json = faces_of("json", r#"{"a": 1, "b": true}"#);
        assert!(json.iter().any(|(_, f)| *f == "font-lock-number-face"), "{json:?}");
        let python = faces_of("python", "def f():\n    return None  # done\n");
        assert!(python.contains(&("def".into(), "font-lock-keyword-face")), "{python:?}");
        assert!(python.contains(&("# done".into(), "font-lock-comment-face")), "{python:?}");
    }

    #[test]
    fn capture_names_fall_back() {
        assert_eq!(capture_face("keyword.control.rust"), Some("font-lock-keyword-face"));
        assert_eq!(capture_face("constant.builtin"), Some("font-lock-constant-face"));
        assert_eq!(capture_face("variable"), None);
    }
}
