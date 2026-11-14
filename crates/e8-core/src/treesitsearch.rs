//! Walking a syntax tree with predicates, as Emacs's treesit.c does for
//! `treesit-node-match-p`, `treesit-search-subtree`,
//! `treesit-search-forward`, `treesit-induce-sparse-tree` and
//! `treesit-subtree-stat` ([ADR 0084]).
//!
//! A predicate is an Emacs regexp matched against a node's type, a
//! function called with the node, a thing named in
//! `treesit-thing-settings`, `["not", p]`, `["or", p...]`, or
//! `[regexp, function]`, which needs both. The walk holds its own copy of
//! the tree, so a predicate's function can run code, as Emacs's can.
//!
//! [ADR 0084]: ../../../../docs/adr/0084-tree-sitters-rest-as-emacs-has-it.md

use tree_sitter::{Node, Tree};

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::treesitfns::{path_of, NodeRef, TsObject};
use crate::variables::Value;

/// How deep the walks go when not told, as Emacs's
/// `TREESIT_RECURSION_LIMIT`.
const RECURSION_LIMIT: i64 = 1000;

/// A node's tree, held apart from the editor while a walk calls predicates.
pub(crate) struct Walk {
    pub(crate) tree: Tree,
    buffer: u64,
    parser: u64,
    generation: u64,
    pub(crate) language: String,
}

impl Walk {
    /// The node object for a node of this tree.
    fn value(&self, node: Node) -> Value {
        Value::Treesit(TsObject::Node(NodeRef { buffer: self.buffer, parser: self.parser, generation: self.generation, path: path_of(node) }))
    }
}

/// The node at the end of a path from the root.
pub(crate) fn node_at_path<'t>(tree: &'t Tree, path: &[u32]) -> Option<Node<'t>> {
    let mut node = tree.root_node();
    for &i in path {
        node = node.child(i)?;
    }
    Some(node)
}

/// The operator a predicate list starts with, `not` or `or`, as a string
/// or a symbol.
fn operator(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::Str(s) | Value::Symbol(s)) if s == "not" || s == "or" => Some(s),
        _ => None,
    }
}

/// The next or previous sibling, named only if `named`, as treesit.c's
/// `treesit_traverse_sibling_helper`.
fn sibling(n: Node, forward: bool, named: bool) -> Option<Node> {
    match (forward, named) {
        (true, false) => n.next_sibling(),
        (true, true) => n.next_named_sibling(),
        (false, false) => n.prev_sibling(),
        (false, true) => n.prev_named_sibling(),
    }
}

/// The first or last child, named only if `named`, as
/// `treesit_traverse_child_helper`.
fn edge_child(n: Node, forward: bool, named: bool) -> Option<Node> {
    let count = if named { n.named_child_count() } else { n.child_count() as usize };
    let i = if forward { 0 } else { count.checked_sub(1)? };
    if named { n.named_child(i as u32) } else { n.child(i as u32) }
}

impl Editor {
    /// The tree a node is in, checked to be its current one.
    pub(crate) fn ts_walk(&self, r: &NodeRef) -> Result<Walk> {
        self.with_node(r, |_, parser, _| {
            Ok(Walk {
                tree: parser.last_parsed().expect("with_node found it"),
                buffer: r.buffer,
                parser: r.parser,
                generation: r.generation,
                language: parser.language.clone(),
            })
        })
    }

    /// Whether a value is a function a predicate calls: a function, or a
    /// symbol naming one, as Emacs's `functionp`.
    fn ts_functionp(&self, v: &Value) -> bool {
        match v {
            Value::Function(_) => true,
            Value::Symbol(name) => self.fboundp(name),
            _ => false,
        }
    }

    /// The predicate `treesit-thing-settings` gives a thing in a language.
    fn ts_thing(&self, thing: &str, language: &str) -> Option<Value> {
        let Some(Value::List(settings)) = self.variable("treesit-thing-settings") else { return None };
        // The language's first entry only, and in it the thing's first, as `assq` finds them.
        let things = settings.iter().find_map(|entry| match entry {
            Value::List(entry) if matches!(entry.first(), Some(Value::Str(l) | Value::Symbol(l)) if l == language) => Some(entry.get(1)),
            _ => None,
        })??;
        let Value::List(things) = things else { return None };
        things.iter().find_map(|t| match t {
            Value::List(t) if matches!(t.first(), Some(Value::Str(n) | Value::Symbol(n)) if n == thing) => Some(t.get(1).cloned()),
            _ => None,
        })?
    }

    /// Checks a predicate's form before a walk, as
    /// `treesit_traverse_validate_predicate`: the error is
    /// `treesit-predicate-not-found` for a thing with no definition, and
    /// `treesit-invalid-predicate` for anything malformed.
    fn ts_validate_predicate(&self, pred: &Value, language: &str, level: usize) -> Result<()> {
        let invalid = |message: &str| Error::signal("treesit-invalid-predicate", message, vec![Value::Str(message.into()), pred.clone()]);
        if level > 99 {
            let message = "Predicate recursion level exceeded: it must not exceed 100 levels";
            return Err(Error::signal("treesit-invalid-predicate", message, vec![Value::Str(message.into())]));
        }
        // nil is a symbol in Lisp, a thing never defined.
        let nil = Value::Symbol("nil".into());
        let pred = if pred.is_nil() { &nil } else { pred };
        match pred {
            Value::Str(_) => Ok(()),
            p if self.ts_functionp(p) => Ok(()),
            Value::Symbol(thing) => match self.ts_thing(thing, language) {
                Some(definition) => self.ts_validate_predicate(&definition, language, level + 1),
                None => {
                    let message = "Cannot find the definition of the predicate in `treesit-thing-settings'";
                    Err(Error::signal("treesit-predicate-not-found", message, vec![Value::Str(message.into()), pred.clone()]))
                }
            },
            Value::List(items) => match (operator(items.first()), &items[..]) {
                (Some("not"), [_]) => Err(invalid("Invalid `not' predicate")),
                (Some("not"), [_, p]) => self.ts_validate_predicate(p, language, level + 1),
                (Some("not"), _) => Err(invalid("`not' can only have one argument")),
                (Some(_), [_]) => Err(invalid("`or' must have a list of patterns as arguments ")),
                (Some(_), [_, rest @ ..]) => rest.iter().try_for_each(|p| self.ts_validate_predicate(p, language, level + 1)),
                (None, [Value::Str(_), f]) if self.ts_functionp(f) => Ok(()),
                _ => Err(invalid("Invalid predicate, see `treesit-thing-settings' for valid forms of predicate")),
            },
            _ => Err(invalid("Invalid predicate, see `treesit-thing-settings' for valid forms of predicate")),
        }
    }

    /// Whether a node matches a checked predicate, and is named if
    /// `named`, as `treesit_traverse_match_predicate`.
    fn ts_match(&mut self, node: Node, pred: &Value, walk: &Walk, named: bool) -> Result<bool> {
        if named && !node.is_named() {
            return Ok(false);
        }
        match pred {
            Value::Str(re) => Ok(self.string_match(re, node.kind(), 0, false)?.is_some()),
            p if self.ts_functionp(p) => Ok(self.funcall(p, &[walk.value(node)])?.is_true()),
            Value::Symbol(thing) => match self.ts_thing(thing, &walk.language) {
                Some(definition) => self.ts_match(node, &definition, walk, named),
                None => Ok(false),
            },
            Value::List(items) => match (operator(items.first()), &items[..]) {
                (Some("not"), [_, p]) => Ok(!self.ts_match(node, p, walk, named)?),
                (Some("or"), [_, rest @ ..]) => {
                    for p in rest {
                        if self.ts_match(node, p, walk, named)? {
                            return Ok(true);
                        }
                    }
                    Ok(false)
                }
                (None, [Value::Str(re), f]) => {
                    Ok(self.string_match(re, node.kind(), 0, false)?.is_some() && self.funcall(f, &[walk.value(node)])?.is_true())
                }
                _ => Ok(false),
            },
            _ => Ok(false),
        }
    }

    /// The node a walk starts from, and its predicate checked: `None` for
    /// a thing with no definition, which a search takes as no match.
    fn ts_walk_from(&self, start: &NodeRef, pred: &Value) -> Result<Option<Walk>> {
        let walk = self.ts_walk(start)?;
        match self.ts_validate_predicate(pred, &walk.language, 0) {
            Ok(()) => Ok(Some(walk)),
            Err(e) if e.symbol() == "treesit-predicate-not-found" => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Whether a node matches a predicate, as `treesit-node-match-p`: a
    /// thing with no definition is an error unless `ignore_missing`.
    pub(crate) fn treesit_node_match_p(&mut self, node: &NodeRef, pred: &Value, ignore_missing: bool) -> Result<bool> {
        let walk = self.ts_walk(node)?;
        match self.ts_validate_predicate(pred, &walk.language, 0) {
            Err(e) if ignore_missing && e.symbol() == "treesit-predicate-not-found" => return Ok(false),
            result => result?,
        }
        let n = node_at_path(&walk.tree, &node.path).expect("ts_walk checked it");
        self.ts_match(n, pred, &walk, false)
    }

    /// The first node of a subtree that matches, depth first and to
    /// `depth` levels, named ones only unless `all`, as
    /// `treesit-search-subtree`.
    pub(crate) fn treesit_search_subtree(&mut self, node: &NodeRef, pred: &Value, backward: bool, all: bool, depth: Option<i64>) -> Result<Value> {
        let Some(walk) = self.ts_walk_from(node, pred)? else { return Ok(Value::Null) };
        let n = node_at_path(&walk.tree, &node.path).expect("ts_walk checked it");
        let found = self.ts_search_dfs(n, pred, &walk, !backward, !all, depth.unwrap_or(RECURSION_LIMIT))?;
        Ok(found.map_or(Value::Null, |n| walk.value(n)))
    }

    /// As `treesit_search_dfs`: the node itself, then each child's
    /// subtree in turn, the first child named if `named` and its siblings
    /// any, each matched as named if `named`.
    fn ts_search_dfs<'t>(&mut self, node: Node<'t>, pred: &Value, walk: &Walk, forward: bool, named: bool, limit: i64) -> Result<Option<Node<'t>>> {
        if self.ts_match(node, pred, walk, named)? {
            return Ok(Some(node));
        }
        if limit == 0 {
            return Ok(None);
        }
        let Some(mut child) = edge_child(node, forward, named) else { return Ok(None) };
        loop {
            if let Some(found) = self.ts_search_dfs(child, pred, walk, forward, named, limit - 1)? {
                return Ok(Some(found));
            }
            match sibling(child, forward, false) {
                Some(next) => child = next,
                None => return Ok(None),
            }
        }
    }

    /// The next node after `start` that matches, leaves first and then
    /// their parents, never looking into `start`'s own subtree, as
    /// `treesit-search-forward`.
    pub(crate) fn treesit_search_forward(&mut self, start: &NodeRef, pred: &Value, backward: bool, all: bool) -> Result<Value> {
        let Some(walk) = self.ts_walk_from(start, pred)? else { return Ok(Value::Null) };
        let (forward, named) = (!backward, !all);
        let mut cursor = node_at_path(&walk.tree, &start.path).expect("ts_walk checked it");
        let mut initial = true;
        loop {
            if !initial && self.ts_match(cursor, pred, &walk, named)? {
                return Ok(walk.value(cursor));
            }
            initial = false;
            loop {
                if let Some(next) = sibling(cursor, forward, named) {
                    cursor = next;
                    break;
                }
                let Some(parent) = cursor.parent() else { return Ok(Value::Null) };
                cursor = parent;
                if self.ts_match(cursor, pred, &walk, named)? {
                    return Ok(walk.value(cursor));
                }
            }
            while let Some(child) = edge_child(cursor, forward, false) {
                cursor = child;
            }
        }
    }

    /// The nodes under `root` that match, as a tree of their own, as
    /// `treesit-induce-sparse-tree`: each a list of the node, or what
    /// `process` makes of it, and the matching nodes below it; the top's
    /// node is null, and the whole is null if nothing matches.
    pub(crate) fn treesit_induce_sparse_tree(&mut self, root: &NodeRef, pred: &Value, process: Option<&Value>, depth: Option<i64>) -> Result<Value> {
        if let Some(f) = process
            && !self.ts_functionp(f)
            && !matches!(f, Value::Str(name) if self.fboundp(name))
        {
            return Err(Error::signal("wrong-type-argument", format!("Wrong type argument: functionp, {f}"), vec![Value::Symbol("functionp".into()), f.clone()]));
        }
        let Some(walk) = self.ts_walk_from(root, pred)? else { return Ok(Value::Null) };
        let node = node_at_path(&walk.tree, &root.path).expect("ts_walk checked it");
        let mut top = Vec::new();
        self.ts_sparse_tree(node, pred, process, depth.unwrap_or(RECURSION_LIMIT), &walk, &mut top)?;
        if top.is_empty() {
            return Ok(Value::Null);
        }
        top.insert(0, Value::Null);
        Ok(Value::List(top))
    }

    /// As `treesit_build_sparse_tree`: a matching node is processed before
    /// its children are looked at, as Emacs calls PROCESS-FN.
    fn ts_sparse_tree(&mut self, node: Node, pred: &Value, process: Option<&Value>, limit: i64, walk: &Walk, out: &mut Vec<Value>) -> Result<()> {
        let mut this = None;
        if self.ts_match(node, pred, walk, false)? {
            let value = walk.value(node);
            this = Some(vec![match process {
                Some(f) => self.funcall(f, &[value])?,
                None => value,
            }]);
        }
        if limit > 0 {
            let mut cursor = node.walk();
            let children: Vec<Node> = node.children(&mut cursor).collect();
            for child in children {
                self.ts_sparse_tree(child, pred, process, limit - 1, walk, this.as_mut().unwrap_or(&mut *out))?;
            }
        }
        if let Some(this) = this {
            out.push(Value::List(this));
        }
        Ok(())
    }

    /// The deepest level, the most children of a node and the number of
    /// nodes in a subtree, as `treesit-subtree-stat` counts them.
    pub(crate) fn treesit_subtree_stat(&self, node: &NodeRef) -> Result<Value> {
        let walk = self.ts_walk(node)?;
        let n = node_at_path(&walk.tree, &node.path).expect("ts_walk checked it");
        let mut cursor = n.walk();
        let (mut max_depth, mut max_width, mut count, mut depth) = (1usize, 0usize, 0usize, 0usize);
        // Emacs's walk: a first child is counted going down to it, a
        // later sibling going across.
        loop {
            count += 1;
            while cursor.goto_first_child() {
                depth += 1;
                count += 1;
                let mut width = 1;
                while cursor.goto_next_sibling() {
                    width += 1;
                }
                max_width = max_width.max(width);
                cursor.goto_parent();
                cursor.goto_first_child();
            }
            max_depth = max_depth.max(depth);
            while !cursor.goto_next_sibling() {
                if cursor.goto_parent() {
                    depth -= 1;
                } else {
                    let num = |n: usize| Value::Number(n as f64);
                    return Ok(Value::List(vec![num(max_depth), num(max_width), num(count)]));
                }
            }
        }
    }
}
