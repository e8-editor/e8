// What Emacs's treesit.el builds on the tree-sitter primitives: the node
// at a position, walking up and searching the tree, indenting by rules
// (treesit-simple-indent-rules), and moving by defuns and other things
// (treesit-thing-settings), which treesit-major-mode-setup turns on.
//
// Predicates for nodes are as Emacs's: a string is an Emacs regexp matched
// against a node's type, a function is called with the node, ["or", ...]
// and ["not", p] combine them, [regexp, function] needs both, and a symbol,
// Symbol.for("defun"), names a thing in treesit-thing-settings.

import { forwardSexpDefault } from "lisp";
import { forwardLine, regexpQuote } from "subr";

type Node = e8.TreesitNode;
type Parser = e8.TreesitParser;
type Predicate = string | symbol | ((node: Node) => unknown) | Predicate[];

const nil = (v: unknown): boolean => v === null || v === undefined || v === false;

for (const [name, doc, value, local] of [
  ["treesit-simple-indent-rules", "How tree-sitter modes indent: for each language, [language, rules], each rule [matcher, anchor, offset].", null, true],
  ["treesit-defun-type-regexp", "An Emacs regexp matching the types of the nodes that are defuns, for C-M-a and C-M-e.", null, true],
  ["treesit-defun-name-function", "A function that gives the name of a defun node, or nil.", null, true],
  ["treesit-defun-tactic", 'How C-M-a and C-M-e treat defuns inside defuns: "nested" visits them, "top-level" only the outermost.', "nested", true],
  ["treesit-defun-skipper", "A function called after moving by defuns, to put point at a line's start or after a defun.", null, true],
  ["treesit-thing-settings", "For each language, [language, [[thing, predicate], ...]]: what a sexp, sentence, defun or other thing is.", null, true],
  ["treesit-indent-function", "The function treesit-indent asks for [anchor, offset], given the node, its parent and the line's start.", null, true],
] as const) {
  e8.defineVariable({ name, doc, value, local });
}

/** The language at a position: the first parser's, as treesit-language-at without a mode's function. */
export function languageAt(_pos?: number): string | undefined {
  const parser = e8.treesitParserList()[0];
  return parser && e8.treesitParserLanguage(parser);
}

/** The root of a language's tree, or the first parser's, as treesit-buffer-root-node. */
export function bufferRootNode(language?: string, tag?: string): Node {
  if (language !== undefined) return e8.treesitParserRootNode(e8.treesitParserCreate(language, null, false, tag ?? null));
  const parser = e8.treesitParserList()[0];
  if (parser === undefined) e8.signal("treesit-no-parser", "No tree-sitter parser in this buffer", [e8.currentBuffer()]);
  return e8.treesitParserRootNode(parser!);
}

function rootFor(parserOrLang: Parser | string | undefined, pos: number): Node | undefined {
  if (e8.treesitParserP(parserOrLang)) return e8.treesitParserRootNode(parserOrLang);
  const language = (parserOrLang as string | undefined) ?? languageAt(pos);
  if (language === undefined) return undefined;
  return bufferRootNode(language);
}

/**
 * The leaf node at a position, as treesit-node-at: the one covering it, or
 * ending at it, or else the first after it, or the last before it.
 */
export function nodeAt(pos: number, parserOrLang?: Parser | string, named = false): Node | undefined {
  const root = rootFor(parserOrLang, pos);
  if (root === undefined) return undefined;
  let node = root;
  let nodeBefore = root;
  const pos1 = Math.max(pos - 1, e8.pointMin());
  let next: Node | undefined;
  while ((next = e8.treesitNodeFirstChildForPos(node, pos, named))) node = next;
  if (e8.treesitNodeEq(node, root)) {
    while ((next = e8.treesitNodeChild(node, -1, named))) node = next;
    return node;
  }
  if (e8.treesitNodeStart(node)! <= pos) return node;
  while ((next = e8.treesitNodeFirstChildForPos(nodeBefore, pos1, named))) nodeBefore = next;
  return e8.treesitNodeEnd(nodeBefore) === pos ? nodeBefore : node;
}

/** The smallest node covering beg to end, as treesit-node-on. */
export function nodeOn(beg: number, end?: number, parserOrLang?: Parser | string, named = false): Node | undefined {
  const root = rootFor(parserOrLang, beg);
  return root && e8.treesitNodeDescendantForRange(root, beg, end ?? beg, named);
}

/** A node's text, with its properties unless noProperty, as treesit-node-text. */
export function nodeText(node: Node | undefined, noProperty = false): string | e8.PropertizedString | undefined {
  if (node === undefined) return undefined;
  const [start, end] = [e8.treesitNodeStart(node)!, e8.treesitNodeEnd(node)!];
  return e8.withCurrentBuffer(e8.treesitParserBuffer(e8.treesitNodeParser(node)), () =>
    noProperty ? e8.bufferSubstringNoProperties(start, end) : e8.bufferSubstring(start, end),
  );
}

/** The predicate a thing names for a language, as treesit-thing-definition. */
export function thingDefinition(thing: string, language?: string): Predicate | undefined {
  const settings = (e8.variable("treesit-thing-settings") ?? []) as unknown as [string, [string, Predicate][]][];
  for (const [lang, things] of settings) {
    if (language !== undefined && lang !== language) continue;
    const found = things.find(([name]) => name === thing);
    if (found) return found[1];
  }
  return undefined;
}

/** Whether a node matches a predicate, as treesit-node-match-p; a missing thing is an error unless ignoreMissing. */
export function nodeMatchP(node: Node | undefined, pred: Predicate, ignoreMissing = false): boolean {
  return e8.treesitNodeMatchP(node, pred, ignoreMissing);
}

/** The first ancestor that matches, the node itself too with includeNode, as treesit-parent-until. */
export function parentUntil(node: Node | undefined, pred: Predicate, includeNode = false): Node | undefined {
  let n = includeNode ? node : node && e8.treesitNodeParent(node);
  while (n !== undefined && !nodeMatchP(n, pred)) n = e8.treesitNodeParent(n);
  return n;
}

/** The last of the node and its ancestors that match, while they do, as treesit-parent-while. */
export function parentWhile(node: Node | undefined, pred: Predicate): Node | undefined {
  let last: Node | undefined;
  let n = node;
  while (n !== undefined && nodeMatchP(n, pred)) {
    last = n;
    n = e8.treesitNodeParent(n);
  }
  return last;
}

/** The highest ancestor of the node's type, or that matches pred, as treesit-node-top-level. */
export function nodeTopLevel(node: Node, pred?: Predicate, includeNode = false): Node | undefined {
  const p = pred ?? `\\\`${regexpQuote(e8.treesitNodeType(node)!)}\\'`;
  let result: Node | undefined;
  for (let n = includeNode ? node : e8.treesitNodeParent(node); n !== undefined; n = e8.treesitNodeParent(n)) {
    if (nodeMatchP(n, p, true)) result = n;
  }
  return result;
}

export function nodeChildren(node: Node, named = false): Node[] {
  const count = e8.treesitNodeChildCount(node, named) ?? 0;
  return Array.from({ length: count }, (_, i) => e8.treesitNodeChild(node, i, named)!);
}

export function filterChild(node: Node, pred: (child: Node) => unknown, named = false): Node[] {
  return nodeChildren(node, named).filter((c) => !nil(pred(c)));
}

/** A node's index among its siblings, as treesit-node-index. */
export function nodeIndex(node: Node, named = false): number {
  let count = 0;
  for (let n = e8.treesitNodePrevSibling(node, named); n !== undefined; n = e8.treesitNodePrevSibling(n, named)) count++;
  return count;
}

/** The field a node is in its parent, as treesit-node-field-name. */
export function nodeFieldName(node: Node): string | undefined {
  const parent = e8.treesitNodeParent(node);
  return parent && e8.treesitNodeFieldNameForChild(parent, nodeIndex(node));
}

type Span = Node | [number, number];
const spanOf = (x: Span): [number, number] => (Array.isArray(x) ? x : [e8.treesitNodeStart(x)!, e8.treesitNodeEnd(x)!]);

/** Whether smaller lies inside larger, strictly with strict, or not equal with "partial", as treesit-node-enclosed-p. */
export function nodeEnclosedP(smaller: Span, larger: Span, strict: boolean | "partial" = false): boolean {
  const [ls, le] = spanOf(larger);
  const [ss, se] = spanOf(smaller);
  if (strict === true) return ls < ss && se < le;
  if (strict === "partial") return (ls !== ss || le !== se) && ls <= ss && ss <= se && se <= le;
  return ls <= ss && ss <= se && se <= le;
}

// Searching, as treesit.c's treesit-search-forward and treesit-search-subtree.

/**
 * The next node after start that matches, leaves first and then their
 * parents, not looking into start's own subtree, as treesit-search-forward.
 * Only named nodes unless all.
 */
export function searchForward(start: Node, pred: Predicate, backward = false, all = false): Node | undefined {
  return e8.treesitSearchForward(start, pred, backward, all);
}

/** The first node in a subtree that matches, depth first, to depth levels, as treesit-search-subtree. */
export function searchSubtree(node: Node, pred: Predicate, backward = false, all = false, depth = 1000): Node | undefined {
  return e8.treesitSearchSubtree(node, pred, backward, all, depth);
}

/** Searches on from a node, going to the end of the one found, or its start with start, as treesit-search-forward-goto. */
export function searchForwardGoto(node: Node, pred: Predicate, start = false, backward = false, all = false): Node | undefined {
  const edge = (n: Node) => (start ? e8.treesitNodeStart(n)! : e8.treesitNodeEnd(n)!);
  const startPos = edge(node);
  let current = startPos;
  let n: Node | undefined = node;
  while (n !== undefined && (backward ? current >= startPos : current <= startPos)) {
    n = searchForward(n, pred, backward, all);
    if (n !== undefined) current = edge(n);
  }
  if (n !== undefined && (backward ? current < e8.point() : current > e8.point())) e8.gotoChar(current);
  return n;
}

// Indenting by rules, as treesit.el's treesit-simple-indent.

type IndentFn = (node: Node | undefined, parent: Node, bol: number) => unknown;
const startOf = (n: Node | undefined): number | undefined => (n === undefined ? undefined : e8.treesitNodeStart(n));
/** Emacs's string-match-p, folding case as case-fold-search says. */
const matchP = (regexp: string, text: string): boolean =>
  e8.stringMatch(regexp, text, { caseFold: !nil(e8.variable("case-fold-search")) }) !== undefined;
const typeIs = (re: string | null | undefined, n: Node | undefined) => re === null || re === undefined || matchP(re, e8.treesitNodeType(n) ?? "");

/** Back to indentation from a position, as (save-excursion (goto-char pos) (back-to-indentation) (point)). */
const indentationAt = (pos: number): number =>
  e8.saveExcursion(() => {
    e8.gotoChar(e8.lineBeginningPosition(pos));
    e8.skipCharsForward(" \t", e8.lineEndPosition());
    return e8.point();
  });

/** The presets rules are written with, as treesit-simple-indent-presets: each a function, or one that makes one. */
export const simpleIndentPresets: Record<string, (...args: never[]) => unknown> = {
  match:
    (nodeType?: string | null, parentType?: string | null, nodeField?: string | null, min?: number | null, max?: number | null): IndentFn =>
    (node, parent) =>
      (nodeType === "null" ? node === undefined : nodeType === null || nodeType === undefined || matchP(nodeType, e8.treesitNodeType(node) ?? "")) &&
      typeIs(parentType, parent) &&
      (nodeField === null || nodeField === undefined || matchP(nodeField, (node && nodeFieldName(node)) ?? "")) &&
      (min === null || min === undefined || (node !== undefined && nodeIndex(node) >= min)) &&
      (max === null || max === undefined || (node !== undefined && nodeIndex(node) <= max)),
  "n-p-gp":
    (nodeType: string | null, parentType: string | null, grandType: string | null): IndentFn =>
    (node, parent) =>
      (nodeType === null || matchP(nodeType, e8.treesitNodeType(node) ?? "")) &&
      typeIs(parentType, parent) &&
      (grandType === null || (e8.treesitNodeParent(parent) !== undefined && typeIs(grandType, e8.treesitNodeParent(parent)))),
  "no-node": ((node: Node | undefined) => node === undefined) as never,
  "parent-is": (type: string): IndentFn => (_n, parent) => matchP(type, e8.treesitNodeType(parent) ?? ""),
  "node-is": (type: string): IndentFn => (node) => matchP(type, e8.treesitNodeType(node) ?? ""),
  "field-is": (name: string): IndentFn => (node) => matchP(name, (node && nodeFieldName(node)) ?? ""),
  "comment-end": ((_n: unknown, _p: unknown, bol: number) =>
    e8.saveExcursion(() => e8.lookingAt(String(e8.variable("comment-end-skip") ?? "\\s>"), bol) === true)) as never,
  "catch-all": (() => true) as never,
  query:
    (pattern: string): IndentFn =>
    (node, parent) =>
      e8.treesitQueryCapture(parent, pattern).some(([, n]) => e8.treesitNodeEq(node, n)),
  "first-sibling": ((_n: unknown, parent: Node) => startOf(e8.treesitNodeChild(parent, 0))) as never,
  "nth-sibling":
    (n: number, named?: boolean): IndentFn =>
    (_n, parent) =>
      startOf(e8.treesitNodeChild(parent, n, named)),
  parent: ((_n: unknown, parent: Node) => startOf(parent)) as never,
  "comment-start": ((_n: unknown, parent: Node) =>
    e8.saveExcursion(() => {
      e8.gotoChar(startOf(parent)!);
      e8.reSearchForward(String(e8.variable("comment-start-skip")));
      e8.skipSyntaxBackward("-");
      return e8.point();
    })) as never,
  "prev-adaptive-prefix": ((_n: unknown, parent: Node, bol: number) => prevAdaptivePrefix(parent, bol)) as never,
  "grand-parent": ((_n: unknown, parent: Node) => startOf(e8.treesitNodeParent(parent))) as never,
  "great-grand-parent": ((_n: unknown, parent: Node) => {
    const grand = e8.treesitNodeParent(parent);
    return startOf(grand && e8.treesitNodeParent(grand));
  }) as never,
  "parent-bol": ((_n: unknown, parent: Node) => indentationAt(startOf(parent)!)) as never,
  "standalone-parent": ((_n: unknown, parent: Node | undefined) => {
    for (let p = parent; p !== undefined; p = e8.treesitNodeParent(p)) {
      const start = startOf(p)!;
      if (/^[ \t]*$/.test(e8.bufferText(e8.lineBeginningPosition(start), start))) return start;
    }
    return undefined;
  }) as never,
  "prev-sibling": ((node: Node | undefined, parent: Node, bol: number) =>
    startOf(
      (node && e8.treesitNodePrevSibling(node, true)) ??
        e8.treesitNodePrevSibling(e8.treesitNodeFirstChildForPos(parent, bol) as Node, true) ??
        e8.treesitNodeChild(parent, -1, true),
    )) as never,
  "no-indent": ((_n: unknown, _p: unknown, bol: number) => bol) as never,
  "prev-line": ((_n: unknown, _p: unknown, bol: number) =>
    e8.saveExcursion(() => {
      e8.gotoChar(bol);
      forwardLine(-1);
      e8.skipCharsForward(" \t");
      return e8.point();
    })) as never,
  "column-0": ((_n: unknown, _p: unknown, bol: number) => e8.lineBeginningPosition(bol)) as never,
  and:
    (...fns: IndentFn[]): IndentFn =>
    (node, parent, bol) => {
      let result: unknown;
      for (const fn of fns) {
        result = fn(node, parent, bol);
        if (nil(result)) return result;
      }
      return result;
    },
  or:
    (...fns: IndentFn[]): IndentFn =>
    (node, parent, bol) => {
      for (const fn of fns) {
        const result = fn(node, parent, bol);
        if (!nil(result)) return result;
      }
      return false;
    },
  not:
    (fn: IndentFn): IndentFn =>
    (node, parent, bol) =>
      nil(fn(node, parent, bol)),
  list:
    (...fns: IndentFn[]): IndentFn =>
    (node, parent, bol) =>
      fns.map((fn) => fn(node, parent, bol)),
};

/** The combinators, whose arguments are matchers or anchors themselves. */
const COMBINATORS = new Set(["and", "or", "not", "list"]);

/** A matcher, anchor or offset as a function of node, parent and bol, as treesit--simple-indent-eval. */
function indentFunction(exp: unknown): IndentFn | unknown {
  if (Array.isArray(exp)) {
    const [head, ...args] = exp;
    const fn = typeof head === "function" ? head : simpleIndentPresets[head as string];
    if (fn === undefined) e8.signal("error", `Unknown indent preset: ${String(head)}`);
    const evaluated = COMBINATORS.has(head as string) ? args.map(indentFunction) : args;
    return (fn as (...a: unknown[]) => unknown)(...evaluated);
  }
  if (typeof exp === "string" && exp in simpleIndentPresets) return simpleIndentPresets[exp];
  return exp;
}

const call = (fn: unknown, node: Node | undefined, parent: Node, bol: number): unknown =>
  typeof fn === "function" ? (fn as IndentFn)(node, parent, bol) : fn;

/** Where a comment line's prefix is, as the prev-adaptive-prefix anchor finds it. */
function prevAdaptivePrefix(parent: Node, bol: number): number | undefined {
  const regexp = e8.variable("adaptive-fill-regexp");
  if (typeof regexp !== "string") return undefined;
  return e8.saveExcursion(() => {
    const commentStartBol = e8.lineBeginningPosition(startOf(parent)!);
    e8.gotoChar(bol);
    const thisLineHasPrefix = e8.lookingAt(regexp) === true && !/^\s*$/.test(e8.matchString(0) ?? "");
    forwardLine(-1);
    if (e8.point() < commentStartBol || e8.lookingAt(regexp) !== true || e8.lookingAt("[ \t]*$") === true) return undefined;
    e8.lookingAt(regexp);
    return (thisLineHasPrefix ? e8.matchBeginning(1) : undefined) ?? e8.matchEnd(0);
  });
}

/** [anchor, offset] for a line, by treesit-simple-indent-rules, as treesit-simple-indent. */
export function simpleIndent(node: Node | undefined, parent: Node | undefined, bol: number): [number | undefined, number | undefined] {
  if (parent === undefined) return [undefined, undefined];
  const language = e8.treesitParserLanguage(e8.treesitNodeParser(parent));
  const all = (e8.variable("treesit-simple-indent-rules") ?? []) as unknown as [string, unknown[][]][];
  const rules = all.find(([lang]) => lang === language)?.[1] ?? [];
  for (const [matcher, anchor, offset] of rules) {
    if (nil(call(indentFunction(matcher), node, parent, bol))) continue;
    const anchorPos = call(indentFunction(anchor), node, parent, bol) as number | undefined;
    // A number, a variable's name, or a preset or function to call.
    let offsetValue: unknown = offset;
    if (typeof offset === "string" && typeof e8.variable(offset) === "number") offsetValue = e8.variable(offset);
    else if (typeof offset !== "number") offsetValue = call(indentFunction(offset), node, parent, bol);
    return [anchorPos ?? undefined, typeof offsetValue === "number" ? offsetValue : undefined];
  }
  return [undefined, undefined];
}

/** The node starting a line, its parent and the line's start, then [anchor, offset], as treesit--indent-1. */
function indent1(): [number | undefined, number | undefined] {
  const bol = indentationAt(e8.point());
  if (e8.treesitParserList().length === 0) return [undefined, undefined];
  const smallest = nodeAt(bol);
  const root = smallest && e8.treesitParserRootNode(e8.treesitNodeParser(smallest));
  const node = parentWhile(smallest, (n) => e8.treesitNodeStart(n) === bol && !e8.treesitNodeEq(n, root));
  const parent = node !== undefined ? e8.treesitNodeParent(node) : nodeOn(bol, bol);
  const fn = e8.variable("treesit-indent-function");
  if (typeof fn === "function" || typeof fn === "string") {
    const result = e8.funcall(fn, node ?? null, parent ?? null, bol) as unknown as [number, number] | null;
    return result ? [result[0], result[1]] : [undefined, undefined];
  }
  return simpleIndent(node, parent, bol);
}

/** Indents the line by the mode's rules, as treesit-indent. */
export const treesitIndent = e8.defun("treesit-indent", () => {
  const [anchor, offset] = indent1();
  if (anchor === undefined || offset === undefined) return;
  const column = e8.saveExcursion(() => {
    e8.gotoChar(anchor);
    return e8.currentColumn();
  }) + offset;
  const delta = e8.pointMax() - e8.point();
  e8.indentLineTo(column);
  if (e8.pointMax() - delta > e8.point()) e8.gotoChar(e8.pointMax() - delta);
});

// Things and defuns, as treesit.el's treesit-navigate-thing.

/** The smallest thing around pos, its start before pos if strict, as treesit-thing-at. */
export function thingAt(pos: number, thing: Predicate, strict = false): Node | undefined {
  return parentUntil(
    nodeAt(pos),
    (n: Node) => {
      const [start, end] = [e8.treesitNodeStart(n)!, e8.treesitNodeEnd(n)!];
      return nodeMatchP(n, thing, true) && (strict ? start < pos : start <= pos) && pos < end;
    },
    true,
  );
}

/** The next thing after pos, or with prev the previous one before it, as treesit--thing-sibling. */
function thingSibling(pos: number, thing: Predicate, prev: boolean): Node | undefined {
  let cursor = nodeAt(pos);
  const posPred = (n: Node) => (prev ? e8.treesitNodeEnd(n)! <= pos : e8.treesitNodeStart(n)! >= pos);
  const iterPred = (n: Node) => nodeMatchP(n, thing, true) && posPred(n);
  let found: Node | undefined;
  if (cursor === undefined) return undefined;
  e8.saveExcursion(() => {
    while (cursor !== undefined && !posPred(cursor)) cursor = searchForwardGoto(cursor, "", prev, prev, true);
  });
  while (cursor !== undefined && posPred(cursor) && found === undefined) {
    found = nodeTopLevel(cursor, iterPred, true);
    cursor = searchForward(cursor, thing, prev, prev);
  }
  return found;
}

/**
 * Where `arg` things on from pos are, back if negative, at their starts or
 * ends as side says, or undefined if there are not enough, as
 * treesit-navigate-thing.
 */
export function navigateThing(posIn: number, arg: number, side: "beg" | "end", thing: Predicate, tactic = "nested", recursing = false): number | undefined {
  let pos = posIn;
  let counter = Math.abs(arg);
  const advance = (n: Node | undefined): number => {
    if (n === undefined) throw new Done();
    return side === "beg" ? e8.treesitNodeStart(n)! : e8.treesitNodeEnd(n)!;
  };
  class Done extends Error {}
  try {
    while (counter > 0) {
      let prev = thingSibling(pos, thing, true);
      let next = thingSibling(pos, thing, false);
      let parent = thingAt(pos, thing, true);
      if (parent && prev && !nodeEnclosedP(prev, parent)) prev = undefined;
      if (parent && next && !nodeEnclosedP(next, parent)) next = undefined;
      if (tactic === "top-level" && parent) {
        parent = nodeTopLevel(parent, thing, true);
        prev = next = undefined;
      }
      if (tactic === "restricted") {
        pos = advance(next === undefined && prev === undefined ? parent : arg > 0 ? next : prev);
      } else if (arg > 0) {
        if (side === "beg" && (next ? !recursing && pos === advance(next) : parent !== undefined)) {
          const found = navigateThing(e8.treesitNodeEnd((next ?? parent)!)!, 1, "beg", thing, tactic, true);
          if (found === undefined) throw new Done();
          pos = found;
        } else {
          pos = advance(next ?? parent);
        }
      } else if (side === "end" && (prev ? !recursing && pos === advance(prev) : parent !== undefined)) {
        const found = navigateThing(e8.treesitNodeStart((prev ?? parent)!)!, -1, "end", thing, tactic, true);
        if (found === undefined) throw new Done();
        pos = found;
      } else {
        pos = advance(prev ?? parent);
      }
      counter--;
    }
  } catch (e) {
    if (e instanceof Done) return undefined;
    throw e;
  }
  return counter === 0 ? pos : undefined;
}

export function beginningOfThing(thing: Predicate, arg = 1, tactic?: string): boolean {
  const dest = navigateThing(e8.point(), -arg, "beg", thing, tactic);
  if (dest !== undefined) e8.gotoChar(dest);
  return dest !== undefined;
}

export function endOfThing(thing: Predicate, arg = 1, tactic?: string): boolean {
  const dest = navigateThing(e8.point(), arg, "end", thing, tactic);
  if (dest !== undefined) e8.gotoChar(dest);
  return dest !== undefined;
}

/** After moving by a defun: to the next line from a defun's end, or a line's start, as treesit-default-defun-skipper. */
export const defaultDefunSkipper = e8.defun("treesit-default-defun-skipper", () => {
  const bol = e8.lineBeginningPosition();
  if (e8.lookingAt("[ \t]*\n") === true && e8.point() !== bol) forwardLine(1);
  else if (e8.point() !== bol && /^[ \t]+$/.test(e8.bufferText(bol, e8.point()))) e8.gotoChar(bol);
});

const defunPredicate = (): Predicate => (e8.variable("treesit-defun-type-regexp") as string | null) ?? Symbol.for("defun");
const defunTactic = (): string => String(e8.variable("treesit-defun-tactic") ?? "nested");

function skipDefun(): void {
  const skipper = e8.variable("treesit-defun-skipper");
  if (!nil(skipper)) e8.funcall(skipper as string);
}

/** Moves back to the start of a defun, forward if negative, as treesit-beginning-of-defun. */
export function treesitBeginningOfDefun(argIn = 1): boolean {
  let arg = argIn;
  const orig = e8.point();
  let success = false;
  for (let i = 0; i < 2; i++) {
    if (beginningOfThing(defunPredicate(), arg, defunTactic()) && !nil(e8.variable("treesit-defun-skipper"))) {
      skipDefun();
      success = true;
    }
    if (arg === 0 || orig !== e8.point()) return success;
    arg = arg > 0 ? arg + 1 : arg - 1;
  }
  return success;
}

/** Moves forward to the end of a defun, back if negative, as treesit-end-of-defun. */
export function treesitEndOfDefun(argIn = 1): void {
  let arg = argIn === 0 ? 1 : argIn;
  const orig = e8.point();
  for (let i = 0; i < 2; i++) {
    if (endOfThing(defunPredicate(), arg, defunTactic())) skipDefun();
    if (arg === 0 || orig !== e8.point()) return;
    arg = arg > 0 ? arg + 1 : arg - 1;
  }
}

/** Pushes the mark before a run of a movement command, as the defun commands do. */
function markBeforeMoving(command: string): void {
  if (e8.thisCommand() === command && e8.lastCommand() !== command && !e8.regionActive()) e8.pushMark(e8.point());
}

e8.defineCommand({
  name: "treesit-beginning-of-defun",
  doc: "Move back to the beginning of a defun, by the syntax tree, or as many as the prefix argument says; forward if negative.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => {
    markBeforeMoving("treesit-beginning-of-defun");
    treesitBeginningOfDefun(arg);
  },
});

e8.defineCommand({
  name: "treesit-end-of-defun",
  doc: "Move forward to the end of a defun, by the syntax tree, or as many as the prefix argument says; back if negative.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => {
    markBeforeMoving("treesit-end-of-defun");
    treesitEndOfDefun(arg);
  },
});

/**
 * Moves over `arg` sexps by the tree, as treesit-forward-sexp: within the
 * thing around point, the next or previous sexp thing; in text, such as a
 * comment, as forward-sexp does by the syntax table. With none left, a
 * scan error, as forward-sexp gives.
 */
export function treesitForwardSexp(arg = 1): void {
  const pred = Symbol.for("sexp");
  const here = nodeAt(e8.point(), languageAt(e8.point()));
  if (here !== undefined && e8.treesitNodeStart(here)! < e8.point() && e8.point() < e8.treesitNodeEnd(here)! && nodeMatchP(here, Symbol.for("text"), true)) {
    forwardSexpDefault(arg);
    return;
  }
  const moved = arg > 0 ? endOfThing(pred, Math.abs(arg), "restricted") : beginningOfThing(pred, Math.abs(arg), "restricted");
  if (moved) return;
  const parent = thingAt(e8.point(), pred, true);
  const boundary = parent && e8.treesitNodeChild(parent, arg > 0 ? -1 : 0);
  if (boundary !== undefined) {
    e8.signal("scan-error", "No more sexp to move across", [
      "No more sexp to move across",
      e8.treesitNodeStart(boundary)! + 1,
      e8.treesitNodeEnd(boundary)! + 1,
    ]);
  }
}

/** The defun around point, the outermost with the top-level tactic, as treesit-defun-at-point. */
export function defunAtPoint(): Node | undefined {
  const node = thingAt(e8.point(), defunPredicate());
  return node && defunTactic() === "top-level" ? nodeTopLevel(node, defunPredicate(), true) : node;
}

/** A defun's name, by treesit-defun-name-function, as treesit-defun-name. */
export function defunName(node: Node | undefined): string | undefined {
  const fn = e8.variable("treesit-defun-name-function");
  if (nil(fn) || node === undefined) return undefined;
  return (e8.funcall(fn as string, node) as string | null) ?? undefined;
}

// Imenu from the tree, as treesit.el's treesit-simple-imenu.

e8.defineVariable({
  name: "treesit-simple-imenu-settings",
  doc: "What M-x imenu lists in a tree-sitter mode: a list of [category, regexp, pred, name-fn], nodes whose type matches regexp, grouped under category.",
  value: null,
  local: true,
});

/** A node and the matching nodes below it, [node, ...children], as treesit-induce-sparse-tree makes them. */
type Sparse = [Node | null | undefined, ...Sparse[]];

/** The nodes under `root` that match, as a tree of their own, as treesit-induce-sparse-tree. */
export function induceSparseTree(root: Node, pred: Predicate, depth = 1000): Sparse | undefined {
  return e8.treesitInduceSparseTree(root, pred, null, depth) as Sparse | undefined;
}

type ImenuEntry = [string, number | ImenuEntry[]];

/** An index from a sparse tree, as treesit--simple-imenu-1: a defun with defuns inside is a submenu, " " itself. */
function simpleImenu1(tree: Sparse | undefined, pred: ((n: Node) => unknown) | null, nameFn: ((n: Node) => string | null) | null): ImenuEntry[] {
  if (tree === undefined) return [];
  const [node, ...children] = tree;
  const subtrees = children.flatMap((c) => simpleImenu1(c, pred, nameFn));
  if (node === undefined || node === null) return subtrees;
  if (pred && nil(pred(node))) return subtrees;
  const name = (nameFn ? nameFn(node) : defunName(node)) ?? "Anonymous";
  const start = e8.treesitNodeStart(node)!;
  return subtrees.length > 0 ? [[name, [[" ", start], ...subtrees]]] : [[name, start]];
}

/** The buffer's index by treesit-simple-imenu-settings, as treesit-simple-imenu. */
export const simpleImenu = e8.defun("treesit-simple-imenu", () => {
  const root = bufferRootNode();
  const settings = (e8.variable("treesit-simple-imenu-settings") ?? []) as unknown as [string | null, string, unknown, unknown][];
  const call = (f: unknown) => (typeof f === "function" || typeof f === "string" ? (n: Node) => e8.funcall(f as string, n) : null);
  return settings.flatMap(([category, regexp, pred, nameFn]): ImenuEntry[] => {
    const index = simpleImenu1(induceSparseTree(root, regexp), call(pred), call(nameFn) as ((n: Node) => string | null) | null);
    if (index.length === 0) return [];
    return category === null ? index : [[category, index] as ImenuEntry];
  }) as unknown as e8.Value;
});

/**
 * Turns on what the mode's tree-sitter settings ask for, as
 * treesit-major-mode-setup: indenting by treesit-simple-indent-rules,
 * M-x imenu by treesit-simple-imenu-settings, and C-M-a and C-M-e by
 * treesit-defun-type-regexp or a defun thing.
 */
// --- Font-lock rules, as treesit-font-lock-rules ----------------------------

for (const [name, doc, value, local] of [
  ["treesit-font-lock-settings", "The current mode's font-lock rules, as treesit-font-lock-rules makes them.", null, true],
  ["treesit-font-lock-feature-list", "The features of the mode's rules by level: a list of lists, the first level's first.", null, true],
  ["treesit-font-lock-level", "How many levels of treesit-font-lock-feature-list highlight: 1 to 4.", 3, false],
  ["treesit-extra-load-path", "More directories to look for grammars in, as libtree-sitter-LANG.dylib, before the tree-sitter directory of user-emacs-directory.", [], false],
  ["treesit-load-name-override-list", "Grammars whose library or function is not named after their language, each [language, library, function].", [], false],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value, local });
}

/** A font-lock rule: its query, whether it is enabled, its feature, its override and language, as Emacs's settings hold them. */
export type FontLockSetting = [query: string, enabled: boolean, feature: string, override: string | boolean | null, language: string];

/**
 * Font-lock rules from Emacs's keyword form, as treesit-font-lock-rules:
 * ":language", ":feature" and ":override" set what the queries after them
 * have, each query a string of tree-sitter's syntax whose captures name faces.
 */
export function fontLockRules(...args: string[]): FontLockSetting[] {
  const out: FontLockSetting[] = [];
  let language = "";
  let feature = "";
  let override: string | boolean | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === ":language") language = args[++i];
    else if (a === ":feature") feature = args[++i];
    else if (a === ":override") override = args[++i] === "nil" ? null : args[i];
    else if (a === ":default-language") language ||= args[++i];
    else {
      if (!language) e8.signal("treesit-font-lock-error", "Language unspecified");
      out.push([a, true, feature, override, language]);
      feature = "";
      override = null;
    }
  }
  return out;
}

/**
 * Enables the rules whose features the first treesit-font-lock-level levels
 * of treesit-font-lock-feature-list name, and gives them to the parsers to
 * highlight with, as treesit-font-lock-recompute-features.
 */
export function fontLockRecomputeFeatures(): void {
  const settings = e8.variable("treesit-font-lock-settings") as unknown as FontLockSetting[] | null;
  if (!Array.isArray(settings) || settings.length === 0) return;
  const levels = e8.variable("treesit-font-lock-feature-list");
  const level = Number(e8.variable("treesit-font-lock-level") ?? 3);
  const enabled = new Set(Array.isArray(levels) ? (levels as e8.Value[][]).slice(0, level).flat().map(String) : settings.map((s) => s[2]));
  const updated = settings.map(([q, , feature, over, lang]): FontLockSetting => [q, enabled.has(feature), feature, over, lang]);
  e8.setVariable("treesit-font-lock-settings", updated as unknown as e8.Value);
  for (const language of new Set(updated.map((s) => s[4]))) {
    e8.treesitSetFontLockRules(
      language,
      updated.filter((s) => s[1] && s[4] === language).map((s) => [s[0], s[3]]),
    );
  }
}
e8.defun("treesit-font-lock-recompute-features", () => fontLockRecomputeFeatures());

export function majorModeSetup(keymap: string): void {
  fontLockRecomputeFeatures();
  if (nil(e8.variable("treesit-defun-skipper"))) e8.setVariable("treesit-defun-skipper", defaultDefunSkipper);
  if (!nil(e8.variable("treesit-simple-indent-rules")) || !nil(e8.variable("treesit-indent-function"))) {
    e8.setVariable("indent-line-function", treesitIndent);
  }
  if (!nil(e8.variable("treesit-simple-imenu-settings"))) e8.setVariable("imenu-create-index-function", simpleImenu);
  if (thingDefinition("sexp") !== undefined) {
    e8.setVariable("forward-sexp-function", e8.defun("treesit-forward-sexp", (arg: number) => treesitForwardSexp(arg)));
  }
  if (!nil(e8.variable("treesit-defun-type-regexp")) || thingDefinition("defun") !== undefined) {
    e8.remapCommand(keymap, "beginning-of-defun", "treesit-beginning-of-defun");
    e8.remapCommand(keymap, "end-of-defun", "treesit-end-of-defun");
    e8.setVariable("beginning-of-defun-function", e8.defun("treesit-beginning-of-defun-function", (arg: number) => treesitBeginningOfDefun(arg)));
    e8.setVariable("end-of-defun-function", e8.defun("treesit-end-of-defun-function", () => treesitEndOfDefun()));
  }
}
