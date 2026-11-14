# 0084. Tree-sitter's rest as Emacs has it: searches, query objects, included ranges and notifiers

Status: accepted · 2026-11-14

## Context

With keymaps and the minibuffer done ([ADRs 0082](0082-keymaps-rest-as-emacs-has-them.md) and [0083](0083-the-minibuffers-odds-as-emacs-has-them.md)), what is left of treesit.c leads the parity ranking at 0.12 ([docs/parity/demand.md](../parity/demand.md)). [ADR 0036](0036-tree-sitter-for-scripts.md) gave scripts parsers, nodes and queries, and wrote treesit.el's searches in `treesit.ts`. Seventeen of treesit.c's primitives were still not in `e8`, the ones Emacs's own modes and the packages the corpus reads call:

- **Walking with predicates**: `treesit-node-match-p`, `treesit-search-subtree`, `treesit-search-forward` and `treesit-induce-sparse-tree`. treesit.ts had its own versions of these, which a package could only reach by importing treesit.ts. They differed from treesit.c in small ways: the sparse tree's shape and which children it visits, and where `named` is checked.
- **Queries as objects**: `treesit-query-p`, `treesit-compiled-query-p` and `treesit-query-language`. `treesit-query-compile` returned its string, and Lisp-form queries (`treesit-query-expand`, `treesit-pattern-expand`) were not read.
- **Embedded languages**: `treesit-parser-set-included-ranges` and `treesit-parser-included-ranges`, on which `treesit-range-settings` is built.
- **Parser notifiers**: `treesit-parser-add-notifier`, `-remove-notifier` and `-notifiers`, which tell a function what each parse changed.
- **The odds**: `treesit-subtree-stat`, `treesit-library-abi-version` and `treesit-language-abi-version`.

## Options considered

1. **Leave the walks in TypeScript** and have the prelude reach them, adding only what is missing in Rust. But the prelude cannot import a package. A walk that calls a primitive for each node is slow on QuickJS, and two versions of a search would drift apart.
2. **All of it in Rust, as treesit.c is in C.** treesit.ts's functions become wrappers over `e8`'s, so there is one search, written as treesit.c writes it.

## Decision

Option 2. Rust is for what Emacs does in C (ADR 0005).

- **Walks** (`treesitsearch.rs`) are treesit.c's own:
  - **Checking first.** A predicate is checked before the walk, as `treesit_traverse_validate_predicate` does. A thing with no definition makes a search find nothing, and `treesit-node-match-p` signal `treesit-predicate-not-found` unless told to ignore it. Anything malformed signals `treesit-invalid-predicate`.
  - **Order.** Children are visited, and `named` checked, exactly as `treesit_search_dfs` and `treesit_search_forward` do.
  - **Sparse trees.** `treesit-induce-sparse-tree` gives Lisp's `(NODE CHILD...)` as `[node, ...children]`, with a null node at the top. It calls PROCESS-FN on a node before looking at its children, as Emacs does.
  - **A copy of the tree.** A walk holds its own copy of the tree, so a predicate's function can run any code.
- **Predicates** are as `treesit-thing-settings` writes them: an Emacs regexp over the node's type, a function or a symbol naming one, a thing's name as `Symbol.for("defun")`, `["not", p]`, `["or", ...]`, and `[regexp, function]`.
- **Compiled queries** are values (`TsObject::Query`), the prelude's `TreesitCompiledQuery`.
  - **When they compile.** `treesitQueryCompile` compiles at once only with EAGER, as Emacs's does, so a bad query signals `treesit-query-error` when first used.
  - **What capture takes.** `treesitQueryCapture` takes a string, a compiled query or Lisp patterns. It refuses a compiled query for another language, which Emacs passes on to tree-sitter unchecked.
- **Lisp-form queries.** `treesitPatternExpand` and `treesitQueryExpand` write them as treesit.c does:
  - symbols by name (`Symbol.for("@name")`, `Symbol.for("name:")`);
  - the keywords `:anchor`, `:?`, `:*`, `:+`, `:equal`, `:match` and `:pred` as tree-sitter's operators;
  - arrays as lists, and strings quoted.
  - JavaScript has no Lisp vector, so an array starting with `Symbol.for("[")` stands for one.
- **Included ranges** are set on tree-sitter's parser in bytes, as Emacs gives them, and the next parse uses them. They are checked as Emacs checks them, signalling `treesit-range-invalid`, and given back as they were set.
- **Notifiers** are a parser's list of function names, newest first, given oldest first. Each parse records what it changed: the whole buffer on a first parse, else tree-sitter's changed ranges. The editor calls the notifiers after the primitive that parsed, or after the command for a parse redisplay made. An error in one is muted, as Emacs's `safe_calln` mutes it.
- **ABI versions** are those of the tree-sitter crate and each grammar compiled in.

## Consequences

- **Packages reach Emacs's names.** Everything Emacs's tree-sitter modes and the corpus's packages call in treesit.c is in `e8`, under its own name.
- **One search.** treesit.ts's searches are treesit.c's.
- **Faster walks.** A walk on QuickJS no longer calls a primitive per node.
- **Recorded in [differences.md](../differences.md):**
  - Lisp vectors in queries are written as arrays starting with `Symbol.for("[")`.
  - Notifiers run after the primitive or command that parsed, not from inside redisplay.
  - Emacs 30.2 never defines `treesit-predicate-not-found` as an error, so `condition-case` on `error` does not catch it there. E8 does catch it.
- **Not done:**
  - Highlighting does not yet follow `treesit-range-settings`, so an embedded language's parser is not highlighted.
  - Narrowing still does not limit what is parsed.

## Dependencies introduced

None.
