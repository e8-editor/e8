# 0080. XML and HTML as Emacs parses them: libxml-parse-html-region

Status: accepted · 2026-11-14

## Context

`libxml-parse-html-region` is the single most needed missing primitive in E8 ([docs/parity/demand.md](../parity/demand.md)): three of Emacs's own libraries, six MELPA packages and three daily ones call it. With `libxml-parse-xml-region` and `libxml-available-p` it makes a group scoring 0.19, and that group is all that lsp-mode, cider, dap-mode, pip-requirements, devdocs and gh-md lack.

Emacs links libxml2 and turns a document into the tree dom.el walks: `(TAG ATTRS . CHILDREN)`, where ATTRS is an alist and each child is such a node or the string a text node holds. `shr` and `eww` read HTML through it, `url` and Gnus read XML, and lsp-mode and the rest parse the HTML a language server sends back.

E8 has nothing for either. Its `e8-web` build is wasm, so a C library is out.

## Options considered

1. **libxml2 itself**, as Emacs links it. It is a system library, differs by platform, and has no web build.
2. **`html5ever` for HTML and `roxmltree` for XML**, both pure Rust. `html5ever` is servo's parser and follows the HTML5 algorithm — the one browsers follow — so a page with missing or crossed tags comes out as a browser reads it, which is what libxml2's recovering parser is reaching for. `roxmltree` is already in the tree through `resvg`.
3. **`html5ever` with `markup5ever_rcdom`**, the DOM in the same repository, which would be less code. It is published as "+unofficial" and described as unsupported, for the parser's own tests.

## Decision

Option 2, with a `TreeSink` of E8's own rather than option 3's DOM: html5ever builds straight into the tree Emacs's primitives give, with nothing in between. The work lands in one pull request, behind `make check` on both engines, a review against xml.c, and the ported packages' tests.

- `libxml-available-p` is always true, on the web too.
- `libxml-parse-html-region` and `libxml-parse-xml-region` take a region of the buffer and give `[tag, attrs, ...children]`, the attributes an alist of name and value as Emacs's are, a comment `["comment", null, text]`, and nil for XML that is not well formed.
- DISCARD-COMMENTS drops every comment, as the docstring says. Emacs 30.2's does not, which looks like a slip in libxml2's hands; a caller passing it wants them gone.
- The HTML5 algorithm always makes a `head` and a `body`; libxml2 makes only what the page has, so one the page did not write and that is empty is dropped, which gives Emacs's tree for a page with either, and keeps an empty one the page wrote.
- A comment outside the root element wraps the whole in a `top` node, as xml.c does.
- Nothing runs scripts, so `<noscript>` holds the elements in it rather than the text the HTML5 algorithm gives it where scripting is on.
- A tree is walked 256 deep, as libxml2 parses HTML, so a document nested deeper gives the tree to that depth rather than running the editor out of stack.

## Consequences

- lsp-mode, cider, dap-mode, pip-requirements, devdocs and gh-md lack nothing more from this group.
- `shr` and `eww` have what they read HTML through, when they are ported.
- Where the HTML5 algorithm and libxml2 differ the trees differ: HTML5 puts a `tbody` around a table's rows, and keeps the whitespace at the start of an element's content that libxml2 drops. Recorded in [differences.md](../differences.md).
- XML's entities differ: E8 expands one the document declares, where Emacs leaves nil, and refuses a document that declares an external entity, where Emacs parses it. CDATA joins the text around it, where Emacs keeps it apart.
- A namespace prefix is dropped from an XML name, as Emacs's tree keeps the local name alone.

## Dependencies introduced

- `html5ever` (MIT or Apache-2.0), with `markup5ever` and `tendril` beneath it: the HTML5 parsing algorithm, pure Rust, so the web build has it too.
- `roxmltree` (MIT or Apache-2.0), already in the tree through `resvg`, made a direct dependency for XML.
