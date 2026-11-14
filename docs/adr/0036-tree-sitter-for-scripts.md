# 0036. Tree-sitter for scripts

Status: accepted · 2026-10-30

## Context

E8 parsed buffers with tree-sitter only to highlight them ([ADR 0008](0008-tree-sitter-highlighting.md)), and scripts could ask for little more than the type of the node at a position. Emacs's tree-sitter modes do much more with the tree:
- they indent by rules over it (`treesit-simple-indent-rules`);
- they move by defuns and other "things";
- they name the defun at point;
- they query it for whatever a package needs.

All of that is written in Lisp (treesit.el and each mode's file) over the primitives of treesit.c. E8's ts-modes had hand-written indentation instead: brace counting borrowed from js-mode, which only approximates what the tree says. There was no `C-M-a` or `C-M-e` at all. [docs/plan.md](../plan.md) lists these ninth among the gaps in the core.

## Options considered

1. **More special cases in the core,** such as an indentation engine in Rust. It would be fast, but packages could not write rules of their own, and every mode would need Rust.
2. **The primitives in the core, treesit.el in TypeScript,** as Emacs splits them: parsers and nodes as values, queries, and the rest ported from Lisp.

## Decision

Option 2.

**Parsers** (`syntax.rs`, `treesitfns.rs`):
- A buffer has a list of parsers, newest first, each with a language and an optional tag, as `treesit-parser-create`, `-delete`, `-list`, `-buffer`, `-language`, `-tag` and `-root-node` have them.
- An indirect buffer's parsers are its base's.
- The parser a major mode makes is the one that highlights.
- Parsers and nodes are values (`Value::Treesit`), the prelude's `TreesitParser` and `TreesitNode`.

**Nodes:**
- **How a node is held.** As the child indices from its tree's root, with the tree's generation.
- **Out of date.** A node goes out of date when its tree is parsed again, as asking for a root does after an edit, and using it then is `treesit-node-outdated`. Until then it reads the tree it came from, as Emacs's do.
- **The functions:** type, start, end, string, parent, child (negative from the end, named or not), child count, child by field name, field name for child, siblings, `first-child-for-pos` (Emacs's own, which works around a tree-sitter bug), `descendant-for-range`, `check` and `eq`.

**Queries** are tree-sitter's syntax, compiled once for each language and source. `treesitQueryCapture` takes a node, a parser or a language, and returns `[name, node]` pairs, or nodes alone with NODE-ONLY, between BEG and END, and grouped by match with GROUPED. Emacs's predicates are there: `(#equal @a @b)`, `(#match "regexp" @a)` with an Emacs regexp, and `(#pred function @a)`. E8 renames them to names tree-sitter's parser accepts, and tree-sitter's own `#eq?` and `#match?` work as tree-sitter defines them.

**treesit.el** (`packages/treesit.ts`):
- **Finding nodes and walking the tree:** `nodeAt`, `nodeOn`, `bufferRootNode`, `nodeText`, `parentUntil`, `parentWhile`, `nodeTopLevel`, `nodeChildren`, `filterChild`, `nodeIndex`, `nodeFieldName` and `nodeEnclosedP`.
- **Searching, as treesit.c orders it:** `searchForward` (leaves first, then their parents), `searchSubtree` (depth first, to a depth) and `searchForwardGoto`.
- **Predicates:** `nodeMatchP` takes Emacs's predicate forms. A string is a regexp over node types, a function is called with the node, `["or", ...]`, `["not", p]` and `[regexp, function]` combine them, and `Symbol.for("defun")` names a thing in `treesit-thing-settings`.
- **Simple indentation:** `treesit-simple-indent-rules` with every preset (`match`, `n-p-gp`, `parent-is`, `node-is`, `field-is`, `query`, `parent-bol`, `standalone-parent`, `prev-sibling`, `prev-adaptive-prefix`, `and`, `or` and the rest), and `treesit-indent` as the mode's `indent-line-function`.
- **Things:** `thingAt`, `navigateThing`, `beginningOfThing` and `endOfThing`. On them, `treesit-beginning-of-defun` and `treesit-end-of-defun`, with `treesit-defun-type-regexp`, `-tactic`, `-skipper` and `-name-function`.
- **Mode setup:** `majorModeSetup` turns these on as `treesit-major-mode-setup` does.

**The modes:**
- **Indentation and defuns.** `rust-ts-mode`, `js-ts-mode` and `json-ts-mode` now indent by Emacs's own rules for them (`rust-ts-mode--indent-rules`, `js--treesit-indent-rules`, `json-ts--indent-rules`). They move by defuns with Emacs's defun types and name them as Emacs does. Their `electric-indent-chars` are Emacs's.
- **Python** keeps its own indentation, as `python-ts-mode` keeps `python-indent-line-function`.

**Defuns everywhere** (`lisp.ts`): `beginning-of-defun` and `end-of-defun` on `C-M-a` and `C-M-e`, from lisp.el. They work by an open paren in column 0, `defun-prompt-regexp`, or the mode's `beginning-of-defun-function` and `end-of-defun-function`. `indent-according-to-mode` now funcalls `indent-line-function`, which may be a function rather than a command, as in Emacs.

**Checking against Emacs 30.2:**
- **The Emacs comparison** has 20 cases in `treesit.json`, all matching: indenting regions of Rust, JavaScript (with tabs, as js-mode's default) and JSON, a newline in Rust, and `C-M-a` and `C-M-e` with counts in each mode and by parens.
- **The tests** in `tests/treesit.rs` hold the probe's answers for the node functions, queries, searches, parsers and nodes going out of date.

## Consequences

A package can write a tree-sitter mode as Emacs's are written, rules and all, and query trees for its own ends. Two things limit what can be added:
- Grammars are compiled in, so only the four languages ship.
- Scripts reach treesit.ts's functions by `import("treesit")`, as `init.ts` is not a module.

Not done yet:
- **Embedded languages:** `treesit-range-settings`. `treesit-parser-set-included-ranges` came with [ADR 0084](0084-tree-sitters-rest-as-emacs-has-it.md).
- **Highlighting** by `treesit-font-lock-rules`: highlighting still uses each grammar's own query.
- **Sentences** by `treesit-thing-settings`: `forward-sentence-function` is not set. Sexps came later: `forward-sexp` now goes through `forward-sexp-function`, which `treesit-forward-sexp` is when a mode defines a sexp thing, as js-ts-mode does, so `C-M-f`, `C-M-b` and `C-M-k` move by its nodes. Seven more cases check them.
- **Lisp-form queries** came with [ADR 0084](0084-tree-sitters-rest-as-emacs-has-it.md).
- **The rest of treesit.c:** Outline from the tree and `treesit-explore-mode`. Imenu came later, and parser notifiers and `treesit-induce-sparse-tree` with [ADR 0084](0084-tree-sitters-rest-as-emacs-has-it.md).
- **Narrowing:** Emacs parses only a narrowed buffer's accessible part; E8 parses all of it.

## Dependencies introduced

None.
