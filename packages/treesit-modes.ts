// Major modes that highlight with tree-sitter grammars, after Emacs's
// rust-ts-mode.el, js.el, json-ts-mode.el, python.el, go-ts-mode.el and
// sh-script.el's bash-ts-mode.
// Each is built on prog-mode and asks for its grammar with
// treesit-parser-create. Go's grammar does not ship with E8: it is
// loaded from libtree-sitter-go.dylib, as Emacs loads its grammars, and
// highlighted by the mode's own font-lock rules.

import { allMatches, charCount, regexpQuote } from "subr";
import { bufferRootNode, defunName, fontLockRules, induceSparseTree, majorModeSetup, nodeText, nodeTopLevel, searchSubtree } from "treesit";

/** C's comments and operators, as c-mode's and js-mode's syntax tables have them. */
const C_SYNTAX: { [chars: string]: string } = {
  "/": ". 124b",
  "*": ". 23",
  "\n": "> b",
  "+-%<>&|=": ".",
  _: "_",
};

/** Python's, as python-mode-syntax-table: symbol characters but _ are punctuation, # starts a comment, ' quotes. */
const PYTHON_SYNTAX: { [chars: string]: string } = {
  "-+*/&|<>=$%": ".",
  "#": "<",
  "\n": ">",
  "'": '"',
  "`": "$",
};

/** Go's, as go-ts-mode--syntax-table: C's comments, ' quotes a rune, \\ escapes. */
const GO_SYNTAX: { [chars: string]: string } = {
  "+-=%&|^!<>": ".",
  "\\": "\\",
  "'": '"',
  "/": ". 124b",
  "*": ". 23",
  "\n": "> b",
};

/** The shell's, as sh-mode-syntax-table: # starts a comment, three kinds of quotes, $ a prefix, most punctuation part of words. */
const BASH_SYNTAX: { [chars: string]: string } = {
  "#": "<",
  "\n": ">#",
  '"': '""',
  "'": "\"'",
  "`": "\"`",
  $: "'",
  "!%:.^~,": "_",
  "=/;|&<>": ".",
};

type ModeSpec = {
  name: string;
  modeName: string;
  language: string;
  pattern: string;
  what: string;
  syntax?: { [chars: string]: string };
  comment?: { start: string; skip: string };
  /** The name Emacs's own mode for the language has, which runs this one, as major-mode-remap-alist can arrange. */
  alias?: string;
  /** Whether indenting may use tabs, as indent-tabs-mode; the language's own modes turn it off for Rust and Python. */
  tabs?: boolean;
};

const modes: ModeSpec[] = [
  {
    name: "rust-ts-mode",
    modeName: "Rust",
    language: "rust",
    pattern: "\\.rs\\'",
    what: "Rust",
    syntax: { ...C_SYNTAX, "'": "." },
    comment: { start: "// ", skip: "\\(?://+\\|/\\*+\\)\\s *" },
    tabs: false,
  },
  {
    name: "js-ts-mode",
    modeName: "JavaScript",
    language: "javascript",
    pattern: "\\.[cm]?js\\'",
    what: "JavaScript",
    syntax: { ...C_SYNTAX, "'`": '"', $: "_" },
    comment: { start: "// ", skip: "\\(?://+\\|/\\*+\\)\\s *" },
    alias: "js-mode",
  },
  { name: "json-ts-mode", modeName: "JSON", language: "json", pattern: "\\.json\\'", what: "JSON" },
  {
    name: "go-ts-mode",
    modeName: "Go",
    language: "go",
    pattern: "\\.go\\'",
    what: "Go",
    syntax: GO_SYNTAX,
    comment: { start: "// ", skip: "\\(?://+\\|/\\*+\\)\\s *" },
    alias: "go-mode",
    tabs: true,
  },
  {
    name: "bash-ts-mode",
    modeName: "Bash",
    language: "bash",
    pattern: "\\.\\(?:ba\\)?sh\\'\\|/\\.bash\\(?:rc\\|_profile\\)\\'",
    what: "shell scripts",
    syntax: BASH_SYNTAX,
    comment: { start: "# ", skip: "#+[\t ]*" },
    alias: "sh-mode",
  },
  {
    name: "python-ts-mode",
    modeName: "Python",
    language: "python",
    pattern: "\\.py[iw]?\\'",
    what: "Python",
    syntax: PYTHON_SYNTAX,
    comment: { start: "# ", skip: "#+\\s-*" },
    alias: "python-mode",
    tabs: false,
  },
];

// --- Python's Imenu, as python.el's python-imenu-treesit-create-index ------

e8.defun("python--treesit-defun-name", (node: e8.TreesitNode) => {
  const type = e8.treesitNodeType(node);
  if (type !== "function_definition" && type !== "class_definition") return undefined;
  return nodeText(e8.treesitNodeChildByFieldName(node, "name"), true) as string | undefined;
});

/** How an item is labelled, as python-imenu-format-item-label: "name (def)". */
const pythonLabel = (type: string, name: string) => `${name} (${type})`;

type PythonSparse = [e8.TreesitNode | null | undefined, ...PythonSparse[]];
type PythonEntry = [string, number | PythonEntry[]];

/** The index from a sparse tree of definitions, as python--imenu-treesit-create-index-1. */
function pythonImenu1([node, ...children]: PythonSparse): PythonEntry[] {
  const subtrees = children.flatMap(pythonImenu1);
  if (node === undefined || node === null) return subtrees;
  const type = e8.treesitNodeType(node) === "class_definition" ? "class" : "def";
  const name = defunName(node) ?? "Anonymous";
  const start = e8.treesitNodeStart(node)!;
  if (subtrees.length === 0) return [[pythonLabel(type, name), start]];
  // As python-imenu-format-parent-item-label and -jump-label.
  return [[`${pythonLabel(type, name)}...`, [[type === "class" ? "*class definition*" : "*function definition*", start], ...subtrees]]];
}

e8.defun("python-imenu-treesit-create-index", () => {
  const tree = induceSparseTree(bufferRootNode("python"), "^\\(?:function\\|class\\)_definition$", 1000) as PythonSparse | undefined;
  return (tree === undefined ? [] : pythonImenu1(tree)) as unknown as e8.Value;
});

// --- Python's blocks for hideshow, as python.el's python-nav functions -------

/** python-rx's block-start: a keyword that starts a block. */
const PY_BLOCK_START =
  "\\_<\\(?:def\\|class\\|if\\|elif\\|else\\|try\\|except\\|finally\\|for\\|while\\|with\\|match\\|case\\|async[[:space:]]+\\(?:def\\|for\\|with\\)\\)\\_>";
/** python-nav-beginning-of-block-regexp: a line that starts a block. */
const PY_BLOCK_START_LINE = `^[[:space:]]*${PY_BLOCK_START}`;

const pyInStringOrComment = (pos = e8.point()): boolean => e8.syntaxPpss(pos).start !== null;
const pyLineText = (pos = e8.point()): string => e8.bufferText(e8.lineBeginningPosition(pos), e8.lineEndPosition(pos));
const pyCommentOrEmptyLine = (): boolean => /^\s*(#.*)?$/.test(pyLineText());

/** Goes to the start of the statement point is in, as python-nav-beginning-of-statement. */
function pyBeginningOfStatement(): void {
  for (;;) {
    e8.gotoChar(e8.lineBeginningPosition());
    if (e8.point() === e8.pointMin()) break;
    const ppss = e8.syntaxPpss();
    const context = ppss.openParens.length > 0 ? ppss.openParens[0] : ppss.inString !== null ? ppss.start : null;
    if (context !== null) e8.gotoChar(context);
    else if (pyLineText(e8.point() - 1).endsWith("\\")) e8.gotoChar(e8.point() - 1);
    else break;
  }
  e8.gotoChar(e8.lineBeginningPosition());
  e8.skipCharsForward(" \t");
}

/** Goes to the end of the statement point is in, as python-nav-end-of-statement: past brackets, strings and backslashes. */
function pyEndOfStatement(): void {
  for (;;) {
    e8.gotoChar(e8.lineEndPosition());
    if (e8.point() >= e8.pointMax()) return;
    const ppss = e8.syntaxPpss();
    if (ppss.depth > 0 || ppss.inString !== null || pyLineText().endsWith("\\")) e8.gotoChar(e8.point() + 1);
    else return;
  }
}

/** Goes to the next or previous line that starts a block, as python-nav-forward-block: whether it did. */
function pyForwardBlock(arg: number): boolean {
  const start = e8.point();
  if (arg > 0) {
    pyEndOfStatement();
    while (e8.reSearchForward(PY_BLOCK_START_LINE, { noerror: true }) != null && pyInStringOrComment());
  } else {
    pyBeginningOfStatement();
    while (e8.reSearchBackward(PY_BLOCK_START_LINE, { noerror: true }) != null && pyInStringOrComment());
  }
  pyBeginningOfStatement();
  if ((arg > 0 && e8.point() < start) || !e8.lookingAt(PY_BLOCK_START)) {
    e8.gotoChar(start);
    return false;
  }
  return e8.point() !== start;
}

/** Goes to the start of the block point is in, as python-nav-beginning-of-block: where, or undefined. */
function pyBeginningOfBlock(): number | undefined {
  const start = e8.point();
  while (e8.point() > e8.pointMin()) {
    pyBeginningOfStatement();
    if (!pyCommentOrEmptyLine()) break;
    e8.gotoChar(e8.lineBeginningPosition() - 1);
  }
  pyBeginningOfStatement();
  if (e8.lookingAt(PY_BLOCK_START)) return e8.point();
  const indent = e8.currentIndentation() - Number(e8.variable("python-indent-offset") ?? 4);
  while (pyForwardBlock(-1) && e8.currentIndentation() > indent);
  if (e8.lookingAt(PY_BLOCK_START) && e8.currentIndentation() === indent) return e8.point();
  e8.gotoChar(start);
  return undefined;
}

/** Goes to the end of the block point is in, as python-nav-end-of-block. */
function pyEndOfBlock(): number | undefined {
  if (pyBeginningOfBlock() === undefined) return undefined;
  const indent = e8.currentIndentation();
  pyEndOfStatement();
  for (;;) {
    const eol = e8.lineEndPosition();
    if (eol >= e8.pointMax()) break;
    e8.gotoChar(eol + 1);
    if (e8.point() >= e8.pointMax()) break;
    if (!pyCommentOrEmptyLine() && e8.currentIndentation() > indent) pyEndOfStatement();
    else if (!pyCommentOrEmptyLine()) break;
  }
  // Back over the comments and blank lines after it, as python-util-forward-comment.
  e8.forwardComment(-e8.bufferSize());
  return e8.point();
}

/** Whether point is at the start of a block, as python-info-looking-at-beginning-of-block. */
function pyLookingAtBeginningOfBlock(): boolean {
  const pos = e8.point();
  return e8.saveExcursion(() => {
    pyBeginningOfStatement();
    e8.gotoChar(e8.lineBeginningPosition());
    return e8.point() <= pos && pos <= e8.point() + e8.currentIndentation() && e8.lookingAt(PY_BLOCK_START_LINE);
  });
}

e8.defun("python-nav-beginning-of-block", () => pyBeginningOfBlock());
e8.defun("python-info-looking-at-beginning-of-block", () => pyLookingAtBeginningOfBlock());
e8.defun("python-hideshow-forward-sexp-function", () => {
  pyEndOfBlock();
  e8.gotoChar(e8.lineEndPosition());
});
e8.defun("python-hideshow-find-next-block", (regexp: string, maxp: number, comments: e8.Value) => {
  const nextBlock = e8.saveExcursion(() => {
    if (pyLookingAtBeginningOfBlock() && e8.reSearchForward(PY_BLOCK_START, { bound: maxp, noerror: true }) != null) return e8.point();
    if (pyForwardBlock(1) && e8.point() < maxp && e8.reSearchForward(PY_BLOCK_START, { bound: maxp, noerror: true }) != null) {
      return e8.point();
    }
    return maxp + 1;
  });
  const nextComment =
    comments !== null && comments !== false && comments !== undefined
      ? e8.saveExcursion(() => {
          while (e8.reSearchForward("#", { bound: maxp, noerror: true }) != null) if (e8.syntaxPpss().inComment !== null) return e8.point();
          return maxp + 1;
        })
      : maxp + 1;
  const next = Math.min(nextBlock, nextComment);
  if (next > maxp) return false;
  e8.gotoChar(next);
  return e8.saveExcursion(() => e8.lookingAt(regexp, e8.lineBeginningPosition()));
});

{
  const alist = e8.variable("hs-special-modes-alist");
  const entries = (mode: string) => [
    mode,
    PY_BLOCK_START_LINE,
    // Empty, so it does not default to "\\s)" and the parens closing a block are hidden too.
    "",
    "#",
    "python-hideshow-forward-sexp-function",
    null,
    "python-nav-beginning-of-block",
    "python-hideshow-find-next-block",
    "python-info-looking-at-beginning-of-block",
  ];
  if (Array.isArray(alist)) e8.setDefault("hs-special-modes-alist", [entries("python-ts-mode"), entries("python-mode"), ...alist]);
}

// --- Indentation -------------------------------------------------------------

for (const [name, value, doc] of [
  ["go-ts-mode-indent-offset", 8, "How far Go indents each level."],
  ["js-indent-level", 4, "How far JavaScript indents each level."],
  ["rust-ts-mode-indent-offset", 4, "How far Rust indents each level."],
  ["json-ts-mode-indent-offset", 2, "How far JSON indents each level."],
  ["python-indent-offset", 4, "How far Python indents each block."],
  ["sh-basic-offset", 4, "How far shell scripts indent each level."],
] as const) {
  e8.defineVariable({ name, value, doc });
}

const charAt = (p: number): string => e8.charAfter(p) ?? "";

const indentationOf = (line: number): number => e8.currentIndentation(e8.lineStart(line));

/** Indents point's line to `column`, point kept with the text after the indentation, as js-indent-line does. */
function indentKeepingPoint(column: number): void {
  const offset = e8.point() - (e8.lineBeginningPosition() + /^[ \t]*/.exec(e8.lineText(e8.lineOf(e8.point())))![0].length);
  e8.indentLineTo(column);
  if (offset > 0) e8.gotoChar(e8.point() + offset);
}

const columnOf = (p: number): number =>
  e8.saveExcursion(() => {
    e8.gotoChar(p);
    return e8.currentColumn();
  });

const offsetFor = (): number => {
  const mode = String(e8.variable("major-mode"));
  const name = mode === "rust-ts-mode" ? "rust-ts-mode-indent-offset" : mode === "json-ts-mode" ? "json-ts-mode-indent-offset" : "js-indent-level";
  return Number(e8.variable(name) ?? 4);
};

/**
 * The column a line of code in braces and parens goes to, as
 * js--proper-indentation reckons it: in a list with nothing after its
 * opening paren, a level deeper than the line the list starts on, or the
 * same for its closing paren; with something after it, under that.
 */
function bracedIndentation(line: number): number | undefined {
  const start = e8.lineStart(line);
  const st = e8.syntaxPpss(start);
  // Strings and comments keep their indentation.
  if (st.inString !== null || st.inComment !== null) return undefined;
  const text = e8.lineText(line);
  const first = start + /^[ \t]*/.exec(text)![0].length;
  const open = st.innermostStart;
  if (open === null) return 0;
  const closing = e8.charSyntax(charAt(first)) === ")";
  // What follows the open paren on its line, if anything but a comment.
  let q = open + 1;
  const lineEnd = e8.lineEnd(e8.lineOf(open));
  while (q < lineEnd && " \t".includes(charAt(q))) q++;
  const rest = e8.bufferText(q, lineEnd);
  if (q >= lineEnd || rest.startsWith("//") || rest.startsWith("/*")) {
    // The line the list starts on, from a condition's open paren if it closes just before.
    let p = open;
    while (p > 0 && " \t".includes(charAt(p - 1))) p--;
    if (charAt(p - 1) === ")") {
      const back = e8.scanLists(p, -1, 0);
      if (back !== null) p = back;
    }
    const base = indentationOf(e8.lineOf(p));
    return closing ? base : base + offsetFor();
  }
  return closing ? columnOf(open) : columnOf(q);
}

e8.defineCommand({
  name: "js-indent-line",
  doc: "Indent the current line of code by the braces and parens it is in, as js-mode does, by js-indent-level, or the mode's own offset.",
  run: () => {
    const line = e8.lineOf(e8.point());
    const column = bracedIndentation(line);
    if (column !== undefined) indentKeepingPoint(column);
  },
});

/** The column a line of Python goes to, as python-indent-line-function does on its first try. */
function pythonIndentation(line: number): number | undefined {
  const start = e8.lineStart(line);
  const st = e8.syntaxPpss(start);
  if (st.inString !== null) return undefined;
  const offset = Number(e8.variable("python-indent-offset") ?? 4);
  const text = e8.lineText(line).trim();
  // In parens: under what follows the open paren, or a block deeper than its line.
  if (st.innermostStart !== null) {
    const open = st.innermostStart;
    let q = open + 1;
    const lineEnd = e8.lineEnd(e8.lineOf(open));
    while (q < lineEnd && " \t".includes(charAt(q))) q++;
    const closing = e8.charSyntax(text[0] ?? "") === ")";
    if (q >= lineEnd || charAt(q) === "#") return indentationOf(e8.lineOf(open)) + (closing ? 0 : offset);
    return closing ? columnOf(open) : columnOf(q);
  }
  // The code line before, not blank or a comment.
  let prev = line - 1;
  while (prev >= 0 && /^\s*(#.*)?$/.test(e8.lineText(prev))) prev--;
  if (prev < 0) return 0;
  // A line ending a list goes from where the list started.
  let from = prev;
  const prevSt = e8.syntaxPpss(e8.lineStart(prev));
  if (prevSt.openParens.length > 0) from = e8.lineOf(prevSt.openParens[0]);
  const prevText = e8.lineText(prev).replace(/\s*#.*$/, "").trimEnd();
  let column = indentationOf(from);
  if (prevText.endsWith(":")) column += offset;
  else if (/^\s*(return|pass|break|continue|raise)\b/.test(e8.lineText(prev))) column = Math.max(0, column - offset);
  // A block's later parts go back to the block they belong to.
  const dedenter = /^(else|elif|except|finally)\b/.exec(text);
  if (dedenter !== null) {
    const opener = { else: /^(if|elif|for|while|try|except)\b/, elif: /^(if|elif)\b/, except: /^(try|except)\b/, finally: /^(try|except|else)\b/ }[dedenter[1] as "else"];
    for (let l = line - 1; l >= 0; l--) {
      const t = e8.lineText(l).trim();
      if (t === "" || t.startsWith("#")) continue;
      if (indentationOf(l) < column && opener.test(t)) return indentationOf(l);
      if (indentationOf(l) < column - offset) break;
    }
    return Math.max(0, column - offset);
  }
  return column;
}

e8.defineCommand({
  name: "python-indent-line-function",
  doc: "Indent the current line of Python as its block says: deeper after a line ending in a colon, back after return, and else, elif, except and finally with their block.",
  run: () => {
    const column = pythonIndentation(e8.lineOf(e8.point()));
    if (column !== undefined) indentKeepingPoint(column);
  },
});

// --- Tree-sitter indentation and navigation, as each mode's file has them ----------

/** Whether a "*" starts the line, as c-ts-common-looking-at-star. */
const lookingAtStar = (_n: unknown, _p: unknown, bol: number): boolean => e8.charAfter(bol) === "*";

/** Just after the "/*" a block comment starts with, as c-ts-common-comment-start-after-first-star. */
const commentStartAfterFirstStar = (_n: unknown, parent: e8.TreesitNode): number => {
  const start = e8.treesitNodeStart(parent)!;
  return e8.bufferText(start, start + 2) === "/*" ? start + 2 : start;
};

const ruleFor = (type: string, offset: string) => [["parent-is", type], "parent-bol", offset];

/** rust-ts-mode--indent-rules. */
const RUST_RULES = [
  [["parent-is", "source_file"], "column-0", 0],
  [["node-is", ")"], "parent-bol", 0],
  [["node-is", "]"], "parent-bol", 0],
  [["node-is", "}"], ["and", "parent", "parent-bol"], 0],
  [["and", ["parent-is", "comment"], lookingAtStar], commentStartAfterFirstStar, -1],
  [["parent-is", "comment"], "prev-adaptive-prefix", 0],
  ...[
    "arguments", "await_expression", "array_expression", "binary_expression", "block", "declaration_list", "enum_variant_list",
    "field_declaration_list", "field_expression", "field_initializer_list", "let_declaration", "macro_definition", "parameters",
    "struct_pattern", "token_tree", "use_list",
  ].map((type) => ruleFor(type, "rust-ts-mode-indent-offset")),
];

/** json-ts--indent-rules. */
const JSON_RULES = [
  [["node-is", "}"], "parent-bol", 0],
  [["node-is", ")"], "parent-bol", 0],
  [["node-is", "]"], "parent-bol", 0],
  ruleFor("object", "json-ts-mode-indent-offset"),
  ruleFor("array", "json-ts-mode-indent-offset"),
];

/** JSX's rules for older or newer grammars, as js-jsx--treesit-indent-compatibility-bb1f97b chooses them. */
function jsxCompatibility(): unknown[] {
  const fragment = e8.conditionCase(
    () => (e8.treesitQueryCompile("javascript", "(jsx_fragment) @capture", true), true),
    { error: () => false },
  );
  return fragment
    ? [[["match", "<", "jsx_fragment"], "parent", 0], ruleFor("jsx_fragment", "js-indent-level").map((x, i) => (i === 1 ? "parent" : x))]
    : [[["match", "<", "jsx_text"], "parent", 0], ruleFor("jsx_text", "js-indent-level").map((x, i) => (i === 1 ? "parent" : x))];
}

/** js--treesit-indent-rules. */
const jsRules = (): unknown[] => {
  const switchCase = "switch_\\(?:case\\|default\\)";
  return [
    [["parent-is", "program"], "parent-bol", 0],
    [["node-is", "}"], "parent-bol", 0],
    [["node-is", ")"], "parent-bol", 0],
    [["node-is", "]"], "parent-bol", 0],
    [["node-is", ">"], "parent-bol", 0],
    [["and", ["parent-is", "comment"], lookingAtStar], commentStartAfterFirstStar, -1],
    [["parent-is", "comment"], "prev-adaptive-prefix", 0],
    ruleFor("ternary_expression", "js-indent-level"),
    ruleFor("member_expression", "js-indent-level"),
    [["node-is", switchCase], "parent-bol", 0],
    [["node-is", "statement_block"], "parent-bol", "js-indent-level"],
    ...["named_imports", "statement_block", "variable_declarator", "arguments", "array", "formal_parameters"].map((t) => ruleFor(t, "js-indent-level")),
    [["parent-is", "template_string"], "no-indent"],
    ...[
      "template_substitution", "object_pattern", "object", "pair", "arrow_function", "parenthesized_expression", "binary_expression",
      "class_body", switchCase, "statement_block",
    ].map((t) => ruleFor(t, "js-indent-level")),
    [["match", "while", "do_statement"], "parent-bol", 0],
    [["match", "else", "if_statement"], "parent-bol", 0],
    ruleFor("\\(?:\\(?:do\\|for\\(?:_in\\)?\\|if\\|while\\)_statement\\|else_clause\\)", "js-indent-level"),
    ...jsxCompatibility(),
    [["node-is", "jsx_closing_element"], "parent", 0],
    [["match", "jsx_element", "statement"], "parent", "js-indent-level"],
    [["parent-is", "jsx_element"], "parent", "js-indent-level"],
    ruleFor("jsx_text", "js-indent-level"),
    [["parent-is", "jsx_opening_element"], "parent", "js-indent-level"],
    ruleFor("jsx_expression", "js-indent-level"),
    [["match", "/", "jsx_self_closing_element"], "parent", 0],
    [["parent-is", "jsx_self_closing_element"], "parent", "js-indent-level"],
    ["no-node", "parent-bol", 0],
  ];
};

const fieldText = (node: e8.TreesitNode, field: string): string =>
  String(nodeText(e8.treesitNodeChildByFieldName(node, field), true) ?? "");

/** rust-ts-mode--defun-name. */
const rustDefunName = (node: e8.TreesitNode): string | null => {
  const type = e8.treesitNodeType(node);
  if (type === "impl_item") {
    const trait = e8.treesitNodeChildByFieldName(node, "trait");
    return `${trait ? `${nodeText(trait, true)} for ` : ""}${fieldText(node, "type")}`;
  }
  return ["enum_item", "function_item", "mod_item", "struct_item", "type_item"].includes(type ?? "") ? fieldText(node, "name") : null;
};

/** js--treesit-defun-name. */
const jsDefunName = (node: e8.TreesitNode): string | null => {
  const type = e8.treesitNodeType(node);
  const named = type === "lexical_declaration" ? searchSubtree(node, "variable_declarator", false, false, 1) : ["function_declaration", "method_definition", "class_declaration"].includes(type ?? "") ? node : undefined;
  return named ? fieldText(named, "name") : null;
};

/** json-ts-mode--defun-name. */
const jsonDefunName = (node: e8.TreesitNode): string | null =>
  ["pair", "object"].includes(e8.treesitNodeType(node) ?? "") ? fieldText(node, "key").replace(/^"/, "").replace(/"$/, "") : null;

/** Any of these names as a whole symbol, as js--regexp-opt-symbol makes a regexp of them. */
const symbolRegexp = (names: string[]): string => `\\_<\\(${names.map(regexpQuote).join("\\|")}\\)\\_>`;

/** js--treesit-valid-imenu-entry, as Emacs has it. */
const jsValidImenuEntry = (node: e8.TreesitNode): unknown =>
  e8.treesitNodeType(node) === "lexical_declaration" ? nodeTopLevel(node) : true;

// --- Go, as go-ts-mode.el ------------------------------------------------------

/** go-ts-mode--indent-rules. */
const GO_RULES = [
  [["parent-is", "source_file"], "column-0", 0],
  [["node-is", ")"], "parent-bol", 0],
  [["node-is", "]"], "parent-bol", 0],
  [["node-is", "}"], "parent-bol", 0],
  [["node-is", "labeled_statement"], "no-indent", 0],
  [["parent-is", "raw_string_literal"], "no-indent", 0],
  ...["argument_list", "block", "communication_case", "const_declaration", "default_case", "expression_case", "selector_expression"].map((t) =>
    ruleFor(t, "go-ts-mode-indent-offset"),
  ),
  [["parent-is", "expression_switch_statement"], "parent-bol", 0],
  ...[
    "field_declaration_list", "import_spec_list", "interface_type", "labeled_statement", "literal_value", "parameter_list",
  ].map((t) => ruleFor(t, "go-ts-mode-indent-offset")),
  [["parent-is", "select_statement"], "parent-bol", 0],
  ...["type_case", "type_declaration", "type_spec"].map((t) => ruleFor(t, "go-ts-mode-indent-offset")),
  [["parent-is", "type_switch_statement"], "parent-bol", 0],
  ...["var_declaration", "var_spec_list"].map((t) => ruleFor(t, "go-ts-mode-indent-offset")),
  ["no-node", "parent-bol", 0],
];

const GO_KEYWORDS = [
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if",
  "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
];
const GO_OPERATORS = [
  "+", "&", "+=", "&=", "&&", "==", "!=", "-", "|", "-=", "|=", "||", "<", "<=", "*", "^", "*=", "^=", "<-", ">", ">=", "/",
  "<<", "/=", "<<=", "++", "=", ":=", "%", ">>", "%=", ">>=", "--", "!", "...", "&^", "&^=", "~",
];
const GO_BUILTINS = [
  "append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make", "max", "min", "new", "panic", "print",
  "println", "real", "recover",
];

/** Whether the grammar has a node type, as go-ts-mode--iota-query-supported-p asks. */
const goHas = (type: string): boolean =>
  e8.conditionCase(() => (e8.treesitQueryCompile("go", `(${type}) @cap`, true), true), { error: () => false });

const quoted = (names: string[]) => names.map((n) => JSON.stringify(n)).join(" ");

/** go-ts-mode--font-lock-settings, its queries in tree-sitter's syntax. */
function goFontLockSettings() {
  return fontLockRules(
    ":language", "go", ":feature", "bracket", `["(" ")" "[" "]" "{" "}"] @font-lock-bracket-face`,
    ":language", "go", ":feature", "comment", "(comment) @font-lock-comment-face",
    ":language", "go", ":feature", "builtin",
    `(call_expression function: ((identifier) @font-lock-builtin-face (#match? @font-lock-builtin-face "^(${GO_BUILTINS.join("|")})$")))`,
    ":language", "go", ":feature", "constant",
    `[(false) (nil) (true)] @font-lock-constant-face ${goHas("iota") ? "(iota) @font-lock-constant-face" : ""}
     (const_declaration (const_spec name: (identifier) @font-lock-constant-face ("," name: (identifier) @font-lock-constant-face)*))`,
    ":language", "go", ":feature", "delimiter", `["," "." ";" ":"] @font-lock-delimiter-face`,
    ":language", "go", ":feature", "operator", `[${quoted(GO_OPERATORS)}] @font-lock-operator-face`,
    ":language", "go", ":feature", "definition",
    `(function_declaration name: (identifier) @font-lock-function-name-face)
     (method_declaration name: (field_identifier) @font-lock-function-name-face)
     (${goHas("method_elem") ? "method_elem" : "method_spec"} name: (field_identifier) @font-lock-function-name-face)
     (field_declaration name: (field_identifier) @font-lock-property-name-face)
     (parameter_declaration name: (identifier) @font-lock-variable-name-face)
     (variadic_parameter_declaration name: (identifier) @font-lock-variable-name-face)
     (short_var_declaration left: (expression_list (identifier) @font-lock-variable-name-face ("," (identifier) @font-lock-variable-name-face)*))
     (var_spec name: (identifier) @font-lock-variable-name-face ("," name: (identifier) @font-lock-variable-name-face)*)
     (range_clause left: (expression_list (identifier) @font-lock-variable-name-face))`,
    ":language", "go", ":feature", "function",
    `(call_expression function: (identifier) @font-lock-function-call-face)
     (call_expression function: (selector_expression field: (field_identifier) @font-lock-function-call-face))`,
    ":language", "go", ":feature", "keyword", `[${quoted(GO_KEYWORDS)}] @font-lock-keyword-face`,
    ":language", "go", ":feature", "label", "(label_name) @font-lock-constant-face",
    ":language", "go", ":feature", "number", "[(float_literal) (imaginary_literal) (int_literal)] @font-lock-number-face",
    ":language", "go", ":feature", "string", "[(interpreted_string_literal) (raw_string_literal) (rune_literal)] @font-lock-string-face",
    ":language", "go", ":feature", "type", "[(package_identifier) (type_identifier)] @font-lock-type-face",
    ":language", "go", ":feature", "property",
    `(selector_expression field: (field_identifier) @font-lock-property-use-face)
     (keyed_element (_ (identifier) @font-lock-property-use-face))`,
    ":language", "go", ":feature", "variable", "(identifier) @font-lock-variable-use-face",
    ":language", "go", ":feature", "escape-sequence", ":override", "t", "(escape_sequence) @font-lock-escape-face",
    ":language", "go", ":feature", "error", ":override", "t", "(ERROR) @font-lock-warning-face",
  );
}

const GO_FEATURES = [
  ["comment", "definition"],
  ["keyword", "string", "type"],
  ["builtin", "constant", "escape-sequence", "label", "number"],
  ["bracket", "delimiter", "error", "function", "operator", "property", "variable"],
];

/** go-ts-mode--defun-name: a method's name with its receiver's type, as (T).name. */
function goDefunName(node: e8.TreesitNode): string | null {
  switch (e8.treesitNodeType(node)) {
    case "function_declaration":
      return (nodeText(e8.treesitNodeChildByFieldName(node, "name"), true) as string | undefined) ?? null;
    case "method_declaration": {
      const field = e8.treesitNodeChildByFieldName(node, "receiver");
      const receiver = field && searchSubtree(field, "type_identifier");
      const method = nodeText(e8.treesitNodeChildByFieldName(node, "name"));
      return `(${nodeText(receiver) ?? ""}).${method ?? ""}`;
    }
    case "type_declaration": {
      const spec = e8.treesitNodeChild(node, 0, true);
      return (nodeText(spec && e8.treesitNodeChildByFieldName(spec, "name"), true) as string | undefined) ?? null;
    }
    default:
      return null;
  }
}

/** Whether a type declaration is of a kind, as go-ts-mode--struct-node-p and its fellows ask. */
const goTypeOf = (node: e8.TreesitNode, type: string, depth: number): boolean =>
  e8.treesitNodeType(node) === "type_declaration" && searchSubtree(node, type, false, false, depth) !== undefined;
const goStruct = (node: e8.TreesitNode) => goTypeOf(node, "struct_type", 2);
const goInterface = (node: e8.TreesitNode) => goTypeOf(node, "interface_type", 2);
const goAlias = (node: e8.TreesitNode) => goTypeOf(node, "type_alias", 1);

// --- Bash, as sh-script.el's bash-ts-mode ------------------------------------

/**
 * How Bash indents. Emacs's bash-ts-mode indents with sh-mode's SMIE rules
 * rather than tree-sitter ones; these put a block's lines sh-basic-offset in
 * from the line it starts on, and its closing word back on that line.
 */
const BASH_RULES = [
  [["parent-is", "program"], "column-0", 0],
  ...["fi", "done", "esac", "then", "else", "elif", "}", ")", "do", "elif_clause", "else_clause"].map((t) => [["node-is", t], "parent-bol", 0]),
  ...["heredoc_body", "heredoc_end", "string", "raw_string"].map((t) => [["parent-is", t], "no-indent", 0]),
  ...["if_statement", "elif_clause", "else_clause", "do_group", "compound_statement", "case_statement", "case_item", "subshell", "while_statement"].map((t) =>
    ruleFor(t, "sh-basic-offset"),
  ),
  ["no-node", "parent-bol", 0],
];

const BASH_KEYWORDS = ["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "unset", "while", "then"];
const BASH_OTHER_KEYWORDS = ["exit", "exec", "continue", "break", "return", "select", "logout", "bye", "until", "type", "trap", "!", "time"];
const BASH_BUILTINS = [
  ".", "alias", "bg", "bind", "builtin", "caller", "compgen", "complete", "declare", "dirs", "disown", "enable", "fc", "fg", "help",
  "history", "jobs", "kill", "let", "local", "popd", "printf", "pushd", "shopt", "source", "suspend", "typeset", "unalias", "mapfile",
  "readarray", "coproc", "command", "hash", "test", "type", "eval", "export", "getopts", "newgrp", "pwd", "read", "readonly", "times",
  "ulimit", "cd", "echo", "set", "shift", "umask", "unset", "wait",
];
const BASH_VARIABLES = [
  "allow_null_glob_expansion", "auto_resume", "BASH", "BASH_ENV", "BASH_VERSINFO", "BASH_VERSION", "cdable_vars", "COMP_CWORD",
  "COMP_LINE", "COMP_POINT", "COMP_WORDS", "COMPREPLY", "DIRSTACK", "ENV", "EUID", "FCEDIT", "FIGNORE", "FUNCNAME",
  "glob_dot_filenames", "GLOBIGNORE", "GROUPS", "histchars", "HISTCMD", "HISTCONTROL", "HISTFILE", "HISTFILESIZE", "HISTIGNORE",
  "history_control", "HISTSIZE", "hostname_completion_file", "HOSTFILE", "HOSTTYPE", "IGNOREEOF", "ignoreeof", "INPUTRC", "LINENO",
  "MACHTYPE", "MAIL_WARNING", "noclobber", "nolinks", "notify", "no_exit_on_failed_exec", "NO_PROMPT_VARS", "OLDPWD", "OPTERR",
  "OSTYPE", "PIPESTATUS", "PPID", "POSIXLY_CORRECT", "PROMPT_COMMAND", "PS3", "PS4", "pushd_silent", "PWD", "RANDOM", "REPLY",
  "SECONDS", "SHELLOPTS", "SHLVL", "TIMEFORMAT", "TMOUT", "UID", "CDPATH", "IFS", "OPTARG", "OPTIND", "PS1", "PS2", "COLUMNS",
  "EDITOR", "HOME", "HUSHLOGIN", "LANG", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LINES",
  "LOGNAME", "MAIL", "MAILCHECK", "MAILPATH", "PAGER", "PATH", "SHELL", "TERM", "TERMCAP", "TERMINFO", "VISUAL",
];
const BASH_OPERATORS = ["|", "|&", "||", "&&", ">", ">>", "<", "<<", "<<-", "<<<", "==", "!=", ";&", ";;&"];
const BASH_DECLARATIONS = ["declare", "typeset", "export", "readonly", "local"];

const anyOf = (words: string[]) => `^(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;

e8.defineFace({ name: "sh-heredoc", doc: "A here-document.", light: { foreground: "tan1" }, dark: { foreground: "yellow1", bold: true } });
e8.defineFace({ name: "sh-quoted-exec", doc: "A command substitution, as $(date).", light: { foreground: "magenta" }, dark: { foreground: "salmon" } });

/** sh-mode--treesit-settings, its queries in tree-sitter's syntax. */
function bashFontLockSettings() {
  return fontLockRules(
    ":language", "bash", ":feature", "comment", "(comment) @font-lock-comment-face",
    ":language", "bash", ":feature", "function", "(function_definition name: (word) @font-lock-function-name-face)",
    ":language", "bash", ":feature", "string", "[(string) (raw_string)] @font-lock-string-face",
    ":language", "bash", ":feature", "string-interpolation", ":override", "t",
    "(command_substitution) @sh-quoted-exec (string (expansion (variable_name) @font-lock-variable-use-face))",
    ":language", "bash", ":feature", "heredoc", "[(heredoc_start) (heredoc_body)] @sh-heredoc",
    ":language", "bash", ":feature", "variable", "(variable_name) @font-lock-variable-name-face",
    ":language", "bash", ":feature", "keyword",
    `[${quoted(BASH_KEYWORDS)}] @font-lock-keyword-face
     (command_name ((word) @font-lock-keyword-face (#match? @font-lock-keyword-face ${JSON.stringify(anyOf(BASH_OTHER_KEYWORDS))})))`,
    ":language", "bash", ":feature", "command",
    `(command_name (word) @font-lock-function-name-face)
     (command_name ((word) @font-lock-builtin-face (#match? @font-lock-builtin-face ${JSON.stringify(anyOf(BASH_BUILTINS))})))`,
    ":language", "bash", ":feature", "declaration-command", `[${quoted(BASH_DECLARATIONS)}] @font-lock-keyword-face`,
    ":language", "bash", ":feature", "constant", "(case_item value: (word) @font-lock-constant-face) (file_descriptor) @font-lock-constant-face",
    ":language", "bash", ":feature", "operator", `[${quoted(BASH_OPERATORS)}] @font-lock-operator-face`,
    ":language", "bash", ":feature", "builtin-variable",
    `((special_variable_name) @font-lock-builtin-face (#match? @font-lock-builtin-face ${JSON.stringify(anyOf(BASH_VARIABLES))}))`,
    ":language", "bash", ":feature", "number", `((word) @font-lock-number-face (#match? @font-lock-number-face "^[0-9]+$"))`,
    ":language", "bash", ":feature", "bracket", `["(" ")" "((" "))" "[" "]" "[[" "]]" "{" "}"] @font-lock-bracket-face`,
    ":language", "bash", ":feature", "delimiter", `[";" ";;"] @font-lock-delimiter-face`,
    ":language", "bash", ":feature", "misc-punctuation", `["$"] @font-lock-misc-punctuation-face`,
  );
}

const BASH_FEATURES = [
  ["comment", "function"],
  ["command", "declaration-command", "keyword", "string"],
  ["builtin-variable", "constant", "heredoc", "number", "string-interpolation", "variable"],
  ["bracket", "delimiter", "misc-punctuation", "operator"],
];

/** What each language's mode sets for treesit.el, as its mode's body does. */
const TREESIT_SETTINGS: Record<
  string,
  {
    rules: () => unknown[];
    defun: string;
    name: (node: e8.TreesitNode) => string | null;
    electric: string;
    imenu: unknown[];
    things?: unknown[];
    /** The mode's font-lock rules and their features by level, for a grammar with no highlighting query of its own. */
    fontLock?: () => { settings: unknown[]; features: string[][] };
  }
> = {
  go: {
    rules: () => GO_RULES,
    defun: "\\(?:function_declaration\\|method_declaration\\|type_declaration\\)",
    name: goDefunName,
    electric: "{}()",
    imenu: [
      ["Function", "\\`function_declaration\\'", null, null],
      ["Method", "\\`method_declaration\\'", null, null],
      ["Struct", "\\`type_declaration\\'", goStruct, null],
      ["Interface", "\\`type_declaration\\'", goInterface, null],
      ["Type", "\\`type_declaration\\'", (n: e8.TreesitNode) => !goStruct(n) && !goInterface(n) && !goAlias(n), null],
      ["Alias", "\\`type_declaration\\'", goAlias, null],
    ],
    fontLock: () => ({ settings: goFontLockSettings(), features: GO_FEATURES }),
  },
  bash: {
    rules: () => BASH_RULES,
    defun: "function_definition",
    name: (node) => (nodeText(e8.treesitNodeChildByFieldName(node, "name"), true) as string | undefined) ?? null,
    electric: "",
    imenu: [["Function", "\\`function_definition\\'", null, null]],
    things: [["sentence", "\\(?:comment\\|heredoc_\\(?:body\\|start\\)\\)"]],
    fontLock: () => ({ settings: bashFontLockSettings(), features: BASH_FEATURES }),
  },
  rust: {
    imenu: [
      ["Module", "\\`mod_item\\'", null, null],
      ["Enum", "\\`enum_item\\'", null, null],
      ["Impl", "\\`impl_item\\'", null, null],
      ["Type", "\\`type_item\\'", null, null],
      ["Struct", "\\`struct_item\\'", null, null],
      ["Fn", "\\`function_item\\'", null, null],
    ],
    rules: () => RUST_RULES,
    defun: "\\(?:enum_item\\|function_item\\|impl_item\\|struct_item\\)",
    name: rustDefunName,
    electric: "{}():;,#",
  },
  javascript: {
    // js-ts-mode's treesit-thing-settings: js--treesit-sexp-nodes and the rest, as js--regexp-opt-symbol makes them.
    things: [
      ["sexp", symbolRegexp([
        "expression", "parenthesized_expression", "formal_parameters", "pattern", "array", "function", "string", "escape", "template",
        "regex", "number", "identifier", "this", "super", "true", "false", "null", "undefined", "arguments", "pair", "jsx",
        "statement_block", "object", "object_pattern", "named_imports", "class_body",
      ])],
      ["sentence", symbolRegexp([
        "import_statement", "debugger_statement", "expression_statement", "if_statement", "switch_statement", "for_statement",
        "for_in_statement", "while_statement", "do_statement", "try_statement", "with_statement", "break_statement",
        "continue_statement", "return_statement", "throw_statement", "empty_statement", "labeled_statement", "variable_declaration",
        "lexical_declaration", "jsx_element", "jsx_self_closing_element",
      ])],
      ["text", symbolRegexp(["comment", "template_string"])],
    ],
    imenu: [
      ["Function", "\\`function_declaration\\'", null, null],
      ["Variable", "\\`lexical_declaration\\'", jsValidImenuEntry, null],
      ["Class", "\\`\\(?:class_declaration\\|method_definition\\)\\'", null, null],
    ],
    rules: jsRules,
    defun: "\\(?:class_declaration\\|function_declaration\\|lexical_declaration\\|method_definition\\)",
    name: jsDefunName,
    electric: "{}():;,<>/",
  },
  json: { rules: () => JSON_RULES, defun: "\\(?:object\\|pair\\)", name: jsonDefunName, electric: "{}():;,", imenu: [[null, "\\`pair\\'", null, null]] },
};

const alist = e8.defaultValue("auto-mode-alist");
const entries = Array.isArray(alist) ? [...alist] : [];

/** A char literal, such as 'a', '"' or '\u{1F600}', rather than a lifetime. */
const RUST_CHAR = /'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/gu;

/**
 * Makes a char literal's quotes delimit a string, as rust-ts-mode's
 * syntax-propertize does, so a quote inside one, as in '"', opens nothing.
 */
function rustSyntaxPropertize(start: number, end: number): void {
  const text = e8.bufferText(start, end);
  for (const m of allMatches(RUST_CHAR, text)) {
    const at = start + charCount(text.slice(0, m.index));
    const close = at + charCount(m[0]) - 1;
    // As syntax-propertize puts them, silently.
    e8.withSilentModifications(() => {
      e8.putTextProperty(at, at + 1, "syntax-table", '"');
      e8.putTextProperty(close, close + 1, "syntax-table", '"');
    });
  }
}

for (const mode of modes) {
  e8.defineMajorMode({
    name: mode.name,
    modeName: mode.modeName,
    parent: "prog-mode",
    doc:
      `The major mode for editing ${mode.what}, highlighted from a tree-sitter syntax tree.\n\n` +
      `Files matching ${mode.pattern} use it; see auto-mode-alist.`,
    syntax: mode.syntax,
    setup: () => {
      // As treesit-ready-p: without the grammar, the mode is prog-mode with a warning.
      if (!e8.treesitLanguageAvailableP(mode.language)) {
        // Not from a buffer of E8's own, such as the one Org fontifies a block in.
        if (!e8.bufferName().startsWith(" ")) e8.message(`Cannot activate tree-sitter, because language grammar for ${mode.language} is unavailable`);
        return;
      }
      e8.treesitSetPrimaryLanguage(mode.language);
      if (mode.comment !== undefined) {
        e8.setVariable("comment-start", mode.comment.start);
        e8.setVariable("comment-end", "");
        e8.setVariable("comment-start-skip", mode.comment.skip);
      }
      e8.setVariable("parse-sexp-ignore-comments", true);
      if (mode.tabs === false) e8.setVariable("indent-tabs-mode", false);
      // Python reindents the line it leaves only by hand, as electric-indent-inhibit says.
      e8.setVariable("electric-indent-inhibit", mode.language === "python");
      const settings = TREESIT_SETTINGS[mode.language];
      if (settings === undefined) {
        e8.setVariable("indent-line-function", "python-indent-line-function");
        e8.setVariable("electric-indent-chars", ["\n"]);
        e8.setVariable("imenu-create-index-function", "python-imenu-treesit-create-index");
        e8.setVariable("treesit-defun-type-regexp", "\\(?:class\\|function\\)_definition");
        e8.setVariable("treesit-defun-name-function", "python--treesit-defun-name");
        majorModeSetup(`${mode.name}-map`);
      } else {
        // Typing these reindents the line, as the mode's electric-indent-chars has them.
        e8.setVariable("electric-indent-chars", ["\n", ...settings.electric]);
        e8.setVariable("treesit-simple-indent-rules", [[mode.language, settings.rules()]] as unknown as e8.Value);
        e8.setVariable("treesit-defun-type-regexp", settings.defun);
        e8.setVariable("treesit-defun-name-function", e8.defun(`${mode.name}--defun-name`, settings.name));
        e8.setVariable("treesit-simple-imenu-settings", settings.imenu as unknown as e8.Value);
        if (settings.things) e8.setVariable("treesit-thing-settings", [[mode.language, settings.things]] as unknown as e8.Value);
        if (settings.fontLock) {
          const { settings: rules, features } = settings.fontLock();
          e8.setVariable("treesit-font-lock-settings", rules as unknown as e8.Value);
          e8.setVariable("treesit-font-lock-feature-list", features);
        }
        majorModeSetup(`${mode.name}-map`);
      }
      if (mode.language === "rust") {
        e8.setVariable("syntax-propertize-function", rustSyntaxPropertize);
        e8.setVariable("parse-sexp-lookup-properties", true);
      }
    },
  });
  if (mode.alias !== undefined) {
    e8.defineCommand({
      name: mode.alias,
      doc: `Edit ${mode.what}, in ${mode.name}: E8's mode for it, as major-mode-remap-alist would have Emacs use.`,
      run: () => e8.call(mode.name as e8.CommandName),
    });
  }
  entries.push([mode.pattern, mode.name]);
}

// As js.el's (defalias 'javascript-mode 'js-mode), which Org's javascript blocks find.
e8.defineCommand({
  name: "javascript-mode",
  doc: "Edit JavaScript, in js-ts-mode, as js-mode does.",
  run: () => e8.call("js-mode" as e8.CommandName),
});
e8.defineKey("python-ts-mode-map", "C-c C-j", "imenu");

e8.setDefault("auto-mode-alist", entries);
