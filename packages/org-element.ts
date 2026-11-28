// Org's parser, after org-element.el: the full parse of
// org-element-parse-buffer, every element and object, as Org's exporter
// reads a document, and, from it, what the editing commands ask:
// org-element-at-point's element, the full parser reading the entry it is
// in into a tree kept through edits (elementAt), and org-element-context's
// object (objectAt).

import {
  allKeywords,
  cycleLevel,
  type Heading,
  headingIndex,
  headingsAsRead,
  indentation,
  isBlank,
  isDone,
  isHeadingLine,
  limitedHeadings,
  linkTypeEntries,
  moveSubtree,
  parseHeading,
  subtreeRegion,
} from "org";
import { ancestors, flag, FOLD_SPECS, withoutFoldChecks } from "org-fold";
import {
  cycleItemIndentation,
  cycleListBullet,
  DRAWER_RE,
  indentItemCommand,
  separatesParagraph,
  listSyntaxKey,
  moveItemDown,
  moveItemUp,
  nextListItem,
  parentsAlist,
  previousItem,
  structAtItem,
  writeStruct,
  bulletString,
} from "org-list";
import { inlinetaskStars, limitedStars, lineAt, lineStartOrEnd } from "org-macs";
import { allMatches, charCount, escapeRegExp } from "subr";
import { ALL_OBJECTS, type Datum, GREATER_ELEMENTS, isObject, type Node, RECURSIVE_OBJECTS } from "org-element-ast";
import { entityGet } from "org-entities";

export interface Elem {
  type: string;
  begin: number;
  end: number;
  contentsBegin?: number;
  contentsEnd?: number;
  children: Elem[];
  parent?: Elem;
  /**
   * Shifts the kept parse owes this element's children, as shiftParse
   * defers them: the i-th change moves the children from index `from[i]`
   * on by `sums[i + 1] - sums[i]`. The indexes never go down, so the
   * changes a child is owed are the first of them.
   */
  shifts?: { from: number[]; sums: number[] };
  /** Where it starts after its affiliated keywords, as :post-affiliated, in an element withAffiliated gives with them. */
  postAffiliated?: number;
  /** A table's kind, as Org's :type: an Org table, or a table.el one, which has no rows. */
  tableType?: "org" | "table.el";
  /** How many of its parent's `shifts` this element has been moved by. */
  applied?: number;
}

/**
 * A clock's line, as org-element-clock-line-re: an inactive timestamp, or a
 * range of two and its duration, or a duration alone, and nothing else,
 * whatever the case of CLOCK, as Org matches it with case-fold-search.
 */
export const CLOCK_LINE =
  /^[ \t]*CLOCK:(?:[ \t]+\[\d{4}-\d{2}-\d{2}(?: .*?)?\](?:--\[\d{4}-\d{2}-\d{2}(?: .*?)?\][ \t]+=>[ \t]+\d+:\d\d)?|[ \t]+=>[ \t]+\d+:\d\d)[ \t]*$/i;

export const PLANNING = /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/;

function elem(type: string, begin: number, end: number, parent: Elem, contentsBegin?: number): Elem {
  const e: Elem = { type, begin, end, contentsBegin, children: [], parent };
  parent.children.push(e);
  return e;
}

/** The line after a drawer opening at line, before limit, that closes it, if any. */
export function drawerEnd(line: number, limit: number): number | undefined {
  for (let l = line + 1; l < e8.lineCount() && e8.lineStart(l) < limit; l++) {
    if (/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(l))) return l;
    if (isHeadingLine(e8.lineText(l))) return undefined;
  }
  return undefined;
}

/** The block a line opens, and the line that closes it, before limit and the next heading. */
function blockAt(line: number, limit: number): { type: string; close: number } | undefined {
  const m = /^[ \t]*#\+begin_(\S+)/i.exec(e8.lineText(line));
  if (!m) return undefined;
  const close = new RegExp(`^[ \\t]*#\\+end_${escapeRegExp(m[1])}[ \\t]*$`, "i");
  for (let l = line + 1; l < e8.lineCount() && e8.lineStart(l) < limit; l++) {
    if (close.test(e8.lineText(l))) {
      const name = m[1].toLowerCase();
      const known = ["center", "quote", "comment", "example", "export", "src", "verse"];
      return { type: known.includes(name) ? `${name}-block` : "special-block", close: l };
    }
    if (isHeadingLine(e8.lineText(l))) return undefined;
  }
  return undefined;
}

/**
 * What latexEnvironmentEnd last found for each environment name, while
 * the text is as it was: from line `from` on, before `limit`, the first
 * line closing it, or none. Each environment left open would otherwise
 * search to the section's end again, many of them in one section taking
 * the square of its length.
 */
let latexEnds: { buffer: number; tick: number; found: Map<string, { from: number; limit: number; close: number | undefined }> } | undefined;

/**
 * The line that closes a LaTeX environment a line opens, as
 * org-element-latex-environment-parser finds it: `\begin{NAME}`, then
 * `\end{NAME}` at the end of a line, the same one or one after, before
 * limit, as its search runs to the section's end. Both are matched
 * whatever their case, as Org's case-fold-search has them.
 */
export function latexEnvironmentEnd(line: number, limit: number): number | undefined {
  const text = e8.lineText(line);
  const m = /^[ \t]*\\begin\{([A-Za-z0-9*]+)\}/i.exec(text);
  if (!m) return undefined;
  if (e8.lineStart(line) + m[0].length >= limit) return undefined;
  const close = new RegExp(`\\\\end\\{${escapeRegExp(m[1])}\\}[ \\t]*$`, "i");
  // The match ends at the line's end, which must not be past limit.
  if (close.test(text.slice(m[0].length))) return e8.lineEnd(line) <= limit ? line : undefined;
  const buffer = e8.currentBuffer().id;
  const tick = e8.bufferCharsModifiedTick();
  if (latexEnds?.buffer !== buffer || latexEnds.tick !== tick) latexEnds = { buffer, tick, found: new Map() };
  const key = m[1].toLowerCase();
  const start = line + 1;
  const known = latexEnds.found.get(key);
  if (known && known.limit === limit && known.from <= start && (known.close === undefined || start <= known.close)) return known.close;
  let found: number | undefined;
  for (let l = start; l < e8.lineCount() && e8.lineEnd(l) <= limit; l++) {
    if (close.test(e8.lineText(l))) {
      found = l;
      break;
    }
  }
  latexEnds.found.set(key, { from: start, limit, close: found });
  return found;
}

/**
 * An affiliated keyword's line, as org-element--affiliated-re: CAPTION
 * and RESULTS with an optional [secondary value], the other keywords
 * Org lists, and export attributes.
 */
export const AFFILIATED = /^[ \t]*#\+(?:(?:CAPTION|RESULTS)(?:\[.*\])?|DATA|HEADERS?|LABEL|NAME|PLOT|RESNAME|RESULT|SOURCE|SRCNAME|TBLNAME|ATTR_[-_A-Za-z0-9]+):/i;

/**
 * A footnote label's characters, as Org's [-_[:word:]]: what Org mode's
 * syntax table makes words, Unicode's letters, marks and numbers with $, %,
 * ', ¥ and ·, but not ª, º or the fractions ¼, ½ and ¾. Beyond Latin-1 a
 * few that Emacs does not take, as circled numbers, are taken.
 */
export const FOOTNOTE_LABEL = "(?:(?![\\u00AA\\u00BA\\u00BC-\\u00BE])[-_$%'\\p{L}\\p{M}\\p{N}\\u00A5\\u00B7])+";

/**
 * A footnote definition's first line, as org-footnote-definition-re, at
 * the margin, whatever the case, as the parser matches it with
 * case-fold-search.
 */
export const FOOTNOTE_DEFINITION = new RegExp(`^\\[fn:(${FOOTNOTE_LABEL})\\]`, "iu");

/** A comment line, as org-element reads one: a hash, then a space or nothing. */
const COMMENT_LINE = /^[ \t]*#(?: |$)/;

/** A fixed-width line, as org-element reads one: a colon, then a space or nothing. */
const FIXED_WIDTH = /^[ \t]*:(?: |$)/;

/** A table.el table's rule, as Org's parser recognises one: + and runs of - between +, alone on its line. */
const TABLE_EL_RULE = /^[ \t]*\+(?:-+\+)+[ \t]*$/;

/** Whether a line starts an element, so a paragraph before it ends. */
export function startsElement(line: number, limit: number): boolean {
  const text = e8.lineText(line);
  return (
    isBlank(text) ||
    isHeadingLine(text) ||
    /^[ \t]*\|/.test(text) ||
    /^[ \t]*#\+\S*:/.test(text) ||
    FIXED_WIDTH.test(text) ||
    COMMENT_LINE.test(text) ||
    // As org-element-paragraph-separate has them: lines that look like an
    // item, rules, footnote definitions, diary sexps, table.el tables and clocks.
    separatesParagraph(text) ||
    /^[ \t]*-{5,}[ \t]*$/.test(text) ||
    FOOTNOTE_DEFINITION.test(text) ||
    /^%%\(/.test(text) ||
    /^[ \t]*\+(?:-+\+)+[ \t]*$/.test(text) ||
    CLOCK_LINE.test(text) ||
    (DRAWER_RE.test(text) && drawerEnd(line, limit) !== undefined) ||
    blockAt(line, limit) !== undefined ||
    latexEnvironmentEnd(line, limit) !== undefined
  );
}

/**
 * The last parse and what it was made for, as headings are kept: its
 * buffer, keywords and branch in `key`, the buffer's change count and
 * accessible portion, and how many of `parseShifts` it has moved by.
 */
let parseCache: { key: string; tick: number; min: number; max: number; shifted: number; root: Elem } | undefined;

/**
 * The changes made while org-indent-region runs, as after-change-functions
 * gives them: it changes only indentation and spacing, as its parse says,
 * so the parse is kept, its positions moved by each change, as Org's
 * element cache moves by its changes, rather than made again a line at a
 * time.
 */
export let parseShifts: { buffer: number; changes: [number, number, number][] } | undefined;

/** Whether a change at `pos` is in a list or a footnote definition, or on the line after one ends, whose extent the indentation decides. */
function indentationSensitive(root: Elem, pos: number): boolean {
  const fragile = ["plain-list", "item", "footnote-definition"];
  let node = root;
  for (;;) {
    // The children that end at or before pos, the last first, while pos is
    // on or before the line after one ends.
    const after = firstEndingAfter(node, pos);
    for (let i = after - 1; i >= 0; i--) {
      const c = child(node, i);
      if (pos > lineStartOrEnd(lineAt(c.end) + 1)) break;
      if (fragile.includes(c.type)) return true;
    }
    if (after >= node.children.length) return false;
    const c = child(node, after);
    if (!(c.begin <= pos && pos < c.end)) return false;
    if (fragile.includes(c.type)) return true;
    node = c;
  }
}

/** Runs `body` with the parse kept through the changes it makes, as org-indent-region does; inside another such body, as that one. */
export function keepingParse(body: () => void): void {
  if (parseShifts) return body();
  parseShifts = { buffer: e8.currentBuffer().id, changes: [] };
  try {
    body();
  } finally {
    parseShifts = undefined;
    parseCache = undefined;
  }
}

/** Moves an element and everything in it by `delta`, as one shift owed to all of it. */
function addDelta(e: Elem, delta: number): void {
  e.begin += delta;
  e.end += delta;
  if (e.contentsBegin !== undefined) e.contentsBegin += delta;
  if (e.contentsEnd !== undefined) e.contentsEnd += delta;
  for (const c of e.children) addDelta(c, delta);
}

/** How many of `shifts` a child at index `i` is owed: those whose first index is i or less. */
function owedCount(shifts: { from: number[] }, i: number): number {
  let lo = 0;
  for (let hi = shifts.from.length; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (shifts.from[mid] <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What child `i` is owed of the shifts deferred on `parent`, without moving it. */
function owed(parent: Elem, i: number): number {
  const s = parent.shifts;
  if (!s) return 0;
  const k = parent.children[i].applied ?? 0;
  const n = owedCount(s, i);
  return n > k ? s.sums[n] - s.sums[k] : 0;
}

/** Child `i` of `parent`, moved by the shifts it is owed, so its positions are where its text is. */
function child(parent: Elem, i: number): Elem {
  const c = parent.children[i];
  const s = parent.shifts;
  if (s) {
    const n = owedCount(s, i);
    const k = c.applied ?? 0;
    if (n > k) {
      addDelta(c, s.sums[n] - s.sums[k]);
      c.applied = n;
    }
  }
  return c;
}

/** Moves every child by what it is owed and forgets the deferred shifts. */
function settleChildren(e: Elem): void {
  if (!e.shifts) return;
  for (let i = 0; i < e.children.length; i++) child(e, i).applied = 0;
  e.shifts = undefined;
}

/** The index of the first child that ends after `pos`, as its text stands. */
function firstEndingAfter(e: Elem, pos: number): number {
  let lo = 0;
  for (let hi = e.children.length; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (e.children[mid].end + owed(e, mid) <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Moves the parse's positions by a change, as after-change-functions gave
 * it: the elements it is in or touches at once, and the children wholly
 * after it as a shift deferred on their parent, which a child takes when
 * it is next looked at. Moving every later element at each change cost
 * the length of the section for each line org-indent-region indented.
 */
function shiftParse(root: Elem, change: [number, number, number]): void {
  const [beg, end, oldLen] = change;
  const delta = end - beg - oldLen;
  const move = (x: number): number => (x <= beg ? x : x >= beg + oldLen ? x + delta : beg);
  const walk = (e: Elem): void => {
    e.begin = move(e.begin);
    e.end = move(e.end);
    if (e.contentsBegin !== undefined) e.contentsBegin = move(e.contentsBegin);
    if (e.contentsEnd !== undefined) e.contentsEnd = move(e.contentsEnd);
    // Those wholly before the change stay where they are; those it is in
    // or touches move now; those wholly after it are owed the delta.
    let i = firstEndingAfter(e, beg);
    for (; i < e.children.length; i++) {
      const begin = e.children[i].begin + owed(e, i);
      if (begin > beg && begin >= beg + oldLen) break;
      walk(child(e, i));
    }
    if (delta === 0 || i >= e.children.length) return;
    let s = e.shifts;
    // A change before one already deferred, as org-indent-region going
    // back into a list, settles the deferred shifts first.
    if (s && i < s.from[s.from.length - 1]) {
      settleChildren(e);
      s = undefined;
    }
    s ??= e.shifts = { from: [], sums: [0] };
    s.from.push(i);
    s.sums.push(s.sums[s.sums.length - 1] + delta);
  };
  walk(root);
}

/**
 * The buffer's elements as far as the element at `pos` needs them: the
 * heading whose entry holds it with its ancestors and their sections, or
 * the text before the first heading. Other subtrees are left out, so the
 * parse costs what the entry does, not the buffer. Kept until the text, the
 * TODO keywords or that heading change.
 */
function parseFor(pos: number): Elem {
  // As org-element-at-point, the parse is of the whole buffer, however it
  // is narrowed: an item's paragraph narrowed to is still in the item.
  if (e8.pointMin() !== 0 || e8.pointMax() !== e8.bufferSize())
    return e8.saveRestriction(() => {
      e8.widen();
      return parseWide(pos);
    });
  return parseWide(pos);
}

function parseWide(pos: number): Elem {
  // Inline tasks, with org-inlinetask, are elements of the section they are in.
  const all = limitedHeadings(headingsAsRead());
  const branch = headingIndex(all, lineAt(pos));
  const key = `${e8.bufferName()}\n${allKeywords().join(" ")}\n${branch ?? -1}\n${listSyntaxKey()}\n${inlinetaskStars()}`;
  const tick = e8.bufferCharsModifiedTick();
  const [min, max] = [e8.pointMin(), e8.pointMax()];
  if (parseCache?.key === key && parseCache.tick !== tick && parseShifts && parseCache.shifted <= parseShifts.changes.length) {
    const cache = parseCache;
    const changes = parseShifts.changes.slice(cache.shifted);
    // A change in or just after a list or a footnote definition can move
    // where it ends, as the indentation of the lines after a bullet says
    // what is the item's: those the parse is made again for.
    const kept = changes.every((change) => {
      if (indentationSensitive(cache.root, change[0])) return false;
      shiftParse(cache.root, change);
      const moved = { begin: cache.min, end: cache.max, children: [] } as unknown as Elem;
      shiftParse(moved, change);
      [cache.min, cache.max] = [moved.begin, moved.end];
      return true;
    });
    if (kept) [cache.tick, cache.shifted] = [tick, parseShifts.changes.length];
    else parseCache = undefined;
  }
  if (parseCache?.key !== key || parseCache.tick !== tick || parseCache.min !== min || parseCache.max !== max)
    parseCache = { key, tick, min, max, shifted: parseShifts?.changes.length ?? 0, root: parseBranch(all, branch) };
  return parseCache.root;
}

function parseBranch(all: Heading[], branch: number | undefined): Elem {
  const root: Elem = { type: "org-data", begin: 0, end: e8.bufferSize(), children: [] };
  const section = (parent: Elem, from: number, to: number, afterHeadline: boolean): void => {
    let p = from;
    while (p < to && isBlank(e8.lineText(lineAt(p))) && p === e8.lineStart(lineAt(p))) p = lineStartOrEnd(lineAt(p) + 1);
    if (p >= to) return;
    const sec = elem("section", p, to, parent, p);
    sec.contentsEnd = to;
    // Before the first heading, a property drawer may start the buffer.
    sectionElements(sec, p, to, afterHeadline);
  };
  if (branch === undefined) {
    section(root, 0, all[0]?.start ?? e8.bufferSize(), false);
    return root;
  }
  // The headings holding the branch, outermost first, each with its section.
  let parent = root;
  for (const i of [...ancestors(all, branch).reverse(), branch]) {
    const h = all[i];
    const end = subtreeRegion(all, i)[1];
    const e = elem("headline", h.start, end, parent);
    section(e, lineStartOrEnd(h.line + 1), Math.min(all[i + 1]?.start ?? end, end), true);
    parent = e;
  }
  return root;
}

/**
 * A section's elements, read by the full parser, the one Org's
 * org-element-parse-buffer is, as the editing parse holds them: from
 * `from` to `to`, after a headline or before the first one. Only that
 * text is read, with the line before it, which says whether a planning
 * line or a property drawer may start it, so the parse costs what the
 * entry does.
 */
function sectionElements(sec: Elem, from: number, to: number, afterHeadline: boolean): void {
  const base = afterHeadline ? e8.lineStart(Math.max(0, lineAt(from) - 1)) : 0;
  const text = e8.bufferSubstringNoProperties(base, to);
  const acc = withText(
    text,
    () => {
      const acc = node("section", { begin: 0, end: text.length });
      parseElementsInto(indexOf_(text, base, from), text.length, afterHeadline ? "planning" : "top-comment", undefined, "element", acc);
      convertPositions(acc, positionsOf(text, base));
      return acc;
    },
    elementSettings,
  );
  toElems(acc.contents, sec);
}

/**
 * The full parse's elements as the editing parse holds them: an element's
 * affiliated keywords, as #+NAME:, as keyword elements of their own before
 * it, which withAffiliated puts back together, and a #+CALL: line as a
 * keyword, as the editing commands read them.
 */
function toElems(nodes: Datum[], parent: Elem): void {
  for (const d of nodes) {
    if (typeof d === "string" || isObject(d)) continue;
    const n = d as Node;
    const begin: number = n.p.begin;
    const pa: number = n.p["post-affiliated"] ?? begin;
    // A last line of only blanks, with no newline, which the full parse
    // makes a paragraph, is no element to org-element-at-point.
    if (n.type === "paragraph" && n.p.end === e8.bufferSize() && !/\S/.test(e8.bufferText(begin, n.p.end))) continue;
    for (let q = begin; q < pa; ) {
      const next = Math.min(lineStartOrEnd(lineAt(q) + 1), pa);
      elem("keyword", q, next, parent);
      if (next <= q) break;
      q = next;
    }
    const e = elem(n.type === "babel-call" ? "keyword" : n.type, pa, n.p.end, parent, n.p["contents-begin"]);
    // A paragraph's contents end is left out, as the editing commands take
    // its end, and a table row's contents, its cells, are no elements; an
    // empty property drawer's contents are the empty text inside it.
    if (n.type === "table-row") e.contentsBegin = undefined;
    else if (n.p["contents-end"] !== undefined && n.type !== "paragraph") e.contentsEnd = n.p["contents-end"];
    if (n.type === "property-drawer" && e.contentsBegin === undefined) e.contentsBegin = e.contentsEnd = lineStartOrEnd(lineAt(pa) + 1);
    if (n.type === "table") e.tableType = n.p.type === "table.el" ? "table.el" : "org";
    toElems(n.contents, e);
  }
}

/** Keywords whose values hold objects, as org-element-parsed-keywords. */
const PARSED_KEYWORDS = ["CAPTION"];

/**
 * The innermost object around a position, as org-element-context finds
 * it: in the element there, only where it holds objects (a paragraph's
 * contents, a table row's cells, a verse block's, a heading's title, an
 * item's tag, a parsed affiliated keyword's value), and, right after an
 * object with no space after it, that object if no other starts there.
 * Undefined where Org's context is the element itself. Positions are the
 * buffer's; each object's parent is the object it is in, the outermost's
 * none.
 */
export function objectAt(pos: number): Node | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const region = objectRegion(pos);
    if (!region) return undefined;
    const { from, to, type } = region;
    const text = e8.bufferSubstringNoProperties(from, to);
    return withText(
      text,
      () => {
        const at = indexOf_(text, from, pos);
        let restrict = restriction(type);
        let parent: Node | undefined;
        let last: Node | undefined;
        let q = 0;
        let result: Node | undefined;
        for (;;) {
          const next = objectLex(q - OFF, restrict);
          if (next) next.parent = parent;
          if (!next || next.p.begin > at) {
            result = last ?? parent;
            break;
          }
          const end: number = next.p.end;
          const cb: number | undefined = next.p["contents-begin"];
          const ce: number | undefined = next.p["contents-end"];
          const max = OFF + S.length;
          if (end <= at && max !== end) {
            q = end;
            if (end === at && !/[ \t]/.test(S[end - OFF - 1] ?? "")) last = next;
          } else if (cb !== undefined && ce !== undefined && at >= cb && (at < ce || (at === ce && (max === at || !/[ \t]/.test(S[at - OFF - 1] ?? ""))))) {
            S = S.slice(cb - OFF, ce - OFF);
            OFF = cb;
            sliced.clear();
            q = cb;
            parent = next;
            last = undefined;
            restrict = restriction(next.type);
          } else {
            result = next;
            break;
          }
        }
        if (result) {
          const toBuffer = positionsOf(text, from);
          for (let n: Node | undefined = result; n; n = n.parent) convertPositions({ ...n, contents: [] } as Node, toBuffer);
        }
        return result;
      },
      bufferSettings,
    );
  });
}

/**
 * Where objects can be around a position, as org-element-context narrows
 * to them, and the type whose restriction says which: a paragraph's
 * contents, a table row's cells, a verse block's, a heading's title, an
 * item's tag, a parsed affiliated keyword's value; undefined elsewhere.
 * The buffer is taken whole.
 */
export function objectRegion(pos: number): { from: number; to: number; type: string } | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const found = elementAt(pos);
    if (!found) return undefined;
    const e = withAffiliated(found)!;
    const line = lineAt(pos);
    let from: number;
    let to: number;
    let type = e.type;
    if (e.postAffiliated !== undefined && pos < e.postAffiliated) {
      // On an affiliated keyword: its value, or a dual value in brackets, if it holds objects.
      const text = e8.lineText(line);
      const m = /^[ \t]*#\+((?:CAPTION|RESULTS)(?:\[(.*)\])?|[A-Z_]+[^:]*):[ \t]*/i.exec(text);
      if (!m) return undefined;
      const name = m[1].replace(/\[.*$/, "").toUpperCase();
      if (!PARSED_KEYWORDS.includes(name)) return undefined;
      const ls = e8.lineStart(line);
      const valueAt = ls + charCount(m[0]);
      if (valueAt <= pos) [from, to] = [valueAt, e8.lineEnd(line)];
      else if (m[2] !== undefined) {
        const dual = ls + charCount(m[0].slice(0, m[0].indexOf("[") + 1));
        if (!(pos >= dual && pos < dual + charCount(m[2]))) return undefined;
        [from, to] = [dual, dual + charCount(m[2])];
      } else return undefined;
      type = "keyword";
    } else if (e.type === "item") {
      // Only in its tag, on its first line.
      if (line !== lineAt(e.begin)) return undefined;
      const m = /^([ \t]*(?:[-+*]|[0-9]+[.)]|[A-Za-z][.)])(?:[ \t]+\[@(?:[0-9]+|[A-Za-z])\])?(?:[ \t]+\[[ X-]\])?[ \t]+)(.*?)[ \t]+::(?:[ \t]|$)/.exec(e8.lineText(line));
      if (!m) return undefined;
      from = e8.lineStart(line) + charCount(m[1]);
      to = from + charCount(m[2]);
      if (!(pos >= from && pos < to)) return undefined;
    } else if (e.type === "headline") {
      const h = parseHeading(lineAt(e.begin));
      if (!h || !h.title) return undefined;
      from = h.titleAt;
      to = h.titleAt + charCount(h.title);
      if (h.title.startsWith("COMMENT")) from += 7;
      if (from >= to) return undefined;
    } else if (e.type === "paragraph" || e.type === "table-row" || e.type === "verse-block") {
      if (e.type === "paragraph") [from, to] = [e.contentsBegin ?? e.begin, lineStartOrEnd(lineAt(endBeforeBlank(e)) + 1)];
      else if (e.type === "verse-block") {
        if (e.contentsBegin === undefined) return undefined;
        [from, to] = [e.contentsBegin, e.contentsEnd!];
      } else {
        // A standard row's cells, from after its first bar to its last non-blank character; a rule has none.
        const text = e8.lineText(lineAt(e.begin));
        if (/^[ \t]*\|-/.test(text)) return undefined;
        from = e8.lineStart(lineAt(e.begin)) + charCount(text.slice(0, text.indexOf("|") + 1));
        to = e8.lineStart(lineAt(e.begin)) + charCount(text.replace(/[ \t]+$/, ""));
      }
      if (!(pos >= from && (pos < to || (pos === to && pos === e8.bufferSize())))) return undefined;
    } else return undefined;
    return { from, to, type };
  });
}

/** The settings an element parse needs, made again only when they change: radio targets are objects, so no text is read for them. */
let lastElementSettings: { key: string; settings: ParseSettings } | undefined;
function elementSettings(): ParseSettings {
  const key = [
    allKeywords().join(" "),
    linkTypeEntries().length,
    String(e8.variable("org-plain-list-ordered-item-terminator")),
    String(e8.variable("org-list-allow-alphabetical")),
    String(e8.defaultValue("org-plain-list-ordered-item-terminator")),
    String(e8.defaultValue("org-list-allow-alphabetical")),
    String(e8.variable("org-odd-levels-only")),
    String(inlinetaskStars()),
  ].join("\0");
  if (lastElementSettings?.key !== key) lastElementSettings = { key, settings: settings("") };
  return lastElementSettings.settings;
}

/**
 * Fails as Org's timestamp parser does on a planning line's timestamp that
 * only its loose form matches, <N-N-N ... +Nw>, and that holds no date.
 */
function checkPlanningTimestamps(line: number): void {
  const text = e8.lineText(line);
  for (const m of allMatches(/(?:SCHEDULED|DEADLINE|CLOSED):[ \t]*/g, text)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    if (/^[<[]\d{4}-\d{2}-\d{2}(?: .*?)?[\]>]/.test(rest)) continue;
    if (!/^<[0-9]+-[0-9]+-[0-9]+[^>\n]+?\+[0-9]+[dwmy]>/.test(rest)) continue;
    const start = /^[<[].*?(?=[\]>])/.exec(rest)?.[0] ?? rest;
    if (!/\d{4}-\d{2}-\d{2}/.test(start)) throw new Error(`Not an Org time string: ${start}`);
  }
}

/** The element at a position, as org-element-at-point finds it: the innermost, but not inside one starting there. */
export function elementAt(pos: number): Elem | undefined {
  const found = elementAt_(pos);
  if (found?.type === "planning") checkPlanningTimestamps(lineAt(found.begin));
  return found;
}

function elementAt_(pos: number): Elem | undefined {
  let node = parseFor(pos);
  // At the end of the buffer, the element that ends there: the whole
  // buffer's end, as org-element--parse-to works widened.
  const size = e8.bufferSize();
  for (;;) {
    // Children do not overlap and come in order: the one that holds pos is
    // the first that ends after it, if it starts at or before it.
    const i = firstEndingAfter(node, pos);
    let found = i < node.children.length ? child(node, i) : undefined;
    if (found && found.begin > pos) found = undefined;
    // At the end of the buffer, the one that ends there.
    for (let j = node.children.length - 1; !found && pos === size && j >= 0; j--) {
      const c = child(node, j);
      if (c.end !== size) break;
      if (c.begin < size) found = c;
    }
    if (!found) return node.type === "org-data" || node.type === "section" ? undefined : node;
    if (found.type !== "section" && pos === found.begin) return found;
    node = found;
  }
}

function nested(a: Elem, b: Elem): boolean {
  return (a.begin >= b.begin && a.end <= b.end) || (b.begin >= a.begin && b.end <= a.end);
}

/** Where an element's text ends, before the blank lines after it. */
export function endBeforeBlank(e: Elem): number {
  let q = e.end;
  while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
  return e8.lineEnd(lineAt(q));
}

/** Swaps two elements, a before b, leaving their blank lines, as org-element-swap-A-B does. */
function swapElements(a: Elem, b: Elem): void {
  withoutFoldChecks(() => swapElementsUnchecked(a, b));
}

function swapElementsUnchecked(a: Elem, b: Elem): void {
  const special = a.begin !== e8.lineStart(lineAt(a.begin));
  if (special && (b.type !== "paragraph" || b.begin !== b.contentsBegin)) {
    e8.gotoChar(a.begin);
    throw new Error("Cannot swap elements");
  }
  const indB = special ? indentation(e8.lineText(lineAt(b.begin))) : 0;
  const [begA, endA, begB, endB] = [a.begin, endBeforeBlank(a), b.begin, endBeforeBlank(b)];
  // As buffer-substring, before anything is changed: an element reaching
  // past the narrowing is not there to swap. Org has gone to its start
  // first, which goto-char stops at the narrowing's.
  if (begA < e8.pointMin() || endB > e8.pointMax()) e8.gotoChar(Math.max(begA, e8.pointMin()));
  if (begA < e8.pointMin()) e8.signal("args-out-of-range", `Args out of range: ${begA + 1}, ${endA + 1}`, [begA + 1, endA + 1]);
  if (endB > e8.pointMax()) e8.signal("args-out-of-range", `Args out of range: ${begB + 1}, ${endB + 1}`, [begB + 1, endB + 1]);
  const bodyA = e8.bufferText(begA, endA);
  let bodyB = e8.bufferText(begB, endB);
  // As in Org, the folds each element is in, whole, go with it, placed
  // relative to where it now starts.
  const foldsOf = (from: number, to: number): [number, number, string][] =>
    e8
      .overlaysIn(from, to)
      .filter((id) => FOLD_SPECS.includes(String(e8.overlayGet(id, "invisible"))))
      .map((id) => [(e8.overlayStart(id) ?? from) - from, (e8.overlayEnd(id) ?? from) - from, String(e8.overlayGet(id, "invisible"))]);
  const restore = (folds: [number, number, string][], at: number): void => {
    for (const [s0, e0, spec] of folds) {
      const [from, to] = [Math.max(0, at + s0), Math.min(e8.bufferSize(), at + e0)];
      if (to > from) flag(from, to, true, spec);
    }
  };
  const foldsA = foldsOf(begA, endA);
  const foldsB = foldsOf(begB, endB);
  for (const spec of FOLD_SPECS) {
    flag(begA, endA, false, spec);
    flag(begB, endB, false, spec);
  }
  e8.deleteRegion(begB, endB);
  e8.gotoChar(begB);
  if (special) {
    bodyB = bodyB.replace(/^[ \t]*/, "");
    e8.insert(" ".repeat(indB));
  }
  e8.insert(bodyA);
  restore(foldsA, begB);
  e8.deleteRegion(begA, endA);
  e8.gotoChar(begA);
  e8.insert(bodyB);
  restore(foldsB, begA);
  e8.gotoChar(b.end);
}

/**
 * The elements that take no affiliated keywords: those Org parses before
 * it collects any, and a comment, before which they are orphans, as
 * org-element--collect-affiliated-keywords leaves them.
 */
const NO_AFFILIATED = ["headline", "section", "item", "planning", "property-drawer", "node-property", "table-row", "clock", "comment"];

/**
 * An element with its affiliated keywords, as #+NAME: and #+CAPTION:, as
 * Org's parser makes it, its begin the first keyword's line: from a
 * keyword's line, the element they belong to, the next after them with no
 * blank line between; a keyword left alone, before a blank line or the
 * end, is one of its own. E8's parser keeps them apart, so the drag
 * commands put them together here.
 */
export function withAffiliated(e: Elem | undefined): Elem | undefined {
  if (!e) return e;
  let owner = e;
  const end = e.parent?.contentsEnd ?? e.parent?.end ?? e8.bufferSize();
  // From a keyword's line, or a paragraph's E8 reads as one, as #+CAPTION[short title]: with a space in its brackets.
  const keywordLine = e.type === "keyword" || (e.type === "paragraph" && e.begin === e8.lineStart(lineAt(e.begin)));
  if (keywordLine && AFFILIATED.test(e8.lineText(lineAt(e.begin)))) {
    let k = lineAt(e.begin);
    while (k < e8.lineCount() && lineStartOrEnd(k) < end && AFFILIATED.test(e8.lineText(k))) k++;
    const at = lineStartOrEnd(k);
    const found = at < end && k < e8.lineCount() && !isBlank(e8.lineText(k)) ? elementAt(at) : undefined;
    if (!found || found.begin !== at || NO_AFFILIATED.includes(found.type)) return e;
    owner = found;
  }
  if (NO_AFFILIATED.includes(owner.type)) return owner;
  const start = owner.parent?.contentsBegin ?? owner.parent?.begin ?? 0;
  let l = lineAt(owner.begin);
  if (owner.begin !== e8.lineStart(l)) return owner;
  while (l > 0 && e8.lineStart(l - 1) >= start && AFFILIATED.test(e8.lineText(l - 1))) l--;
  return e8.lineStart(l) === owner.begin ? owner : { ...owner, begin: e8.lineStart(l), postAffiliated: owner.begin };
}

e8.defineCommand({
  name: "org-drag-element-backward",
  doc: "Move the element at point, such as a paragraph or a list, with its affiliated keywords, before the one above it.",
  run: () => {
    const e = withAffiliated(elementAt(e8.point()));
    if (!e) e8.userError("No element at point");
    if (e.type === "headline") {
      // Point stays where it was in the subtree, even on blank lines below its heading.
      let q = e8.point();
      while (q > e8.pointMin() && /[ \t\n]/.test(e8.bufferText(q - 1, q))) q--;
      const offset = e8.point() - q;
      e8.gotoChar(q);
      try {
        moveSubtree(-1);
      } finally {
        e8.gotoChar(e8.point() + offset);
      }
      return;
    }
    let prev: Elem | undefined;
    // Back to the element before, within the narrowing, as bobp says.
    let q = e.begin;
    while (q > e8.pointMin() && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    if (q > e8.pointMin()) {
      prev = elementAt(q);
      for (let up = prev?.parent; prev && up && up.end <= e.begin; up = up.parent) prev = up;
      prev = withAffiliated(prev);
    }
    if (!prev || nested(e, prev)) e8.userError("Cannot drag element backward");
    const pos = e8.point();
    swapElements(prev, e);
    e8.gotoChar(prev.begin + (pos - e.begin));
  },
});

e8.defineCommand({
  name: "org-drag-element-forward",
  doc: "Move the element at point, such as a paragraph or a list, with its affiliated keywords, after the one below it.",
  run: () => {
    const pos = e8.point();
    const e = withAffiliated(elementAt(pos));
    if (!e) e8.userError("No element at point");
    if (e.end >= e8.pointMax()) e8.userError("Cannot drag element forward");
    const next = withAffiliated(elementAt(e.end));
    if (!next || nested(e, next) || (next.type === "headline" && e.type !== "headline")) {
      e8.gotoChar(pos);
      e8.userError("Cannot drag element forward");
    }
    let q = endBeforeBlank(next);
    q = lineStartOrEnd(lineAt(q) + 1);
    if (q === e8.lineEnd(lineAt(q)) && q !== e8.lineStart(lineAt(q))) q++;
    const sizeNext = q - next.begin;
    const sizeBlank = e.end - lineStartOrEnd(lineAt(endBeforeBlank(e)) + 1);
    swapElements(e, next);
    e8.gotoChar(pos + sizeNext + sizeBlank);
  },
});

e8.defineCommand({
  name: "org-move-subtree-up",
  doc: "Swap the subtree point is in with the one before it at the same level.",
  run: () => moveSubtree(-1),
});

e8.defineCommand({
  name: "org-move-subtree-down",
  doc: "Swap the subtree point is in with the one after it at the same level.",
  run: () => moveSubtree(1),
});

/** Changes the indentation of lines, keeping point with the text. */
e8.defineCommand({
  name: "org-indent-item",
  doc: "Make the item point is on a child of the item before it, leaving its children where they are.",
  run: () => indentItemCommand(1, true),
});
e8.defineCommand({
  name: "org-outdent-item",
  doc: "Make the item point is on a sibling of its parent, leaving its children where they are.",
  run: () => indentItemCommand(-1, true),
});
e8.defineCommand({
  name: "org-indent-item-tree",
  doc: "Make the item point is on, with the items under it, a child of the item before it.",
  run: () => indentItemCommand(1, false),
});
e8.defineCommand({
  name: "org-outdent-item-tree",
  doc: "Make the item point is on, with the items under it, a sibling of its parent.",
  run: () => indentItemCommand(-1, false),
});

e8.defineCommand({
  name: "org-move-item-up",
  doc: "Swap the item point is on, with the items under it, with the one before it.",
  run: () => moveItemUp(),
});
e8.defineCommand({
  name: "org-move-item-down",
  doc: "Swap the item point is on, with the items under it, with the one after it.",
  run: () => moveItemDown(),
});

e8.defineCommand({
  name: "org-previous-item",
  doc: "Move to the item before the one point is in.",
  run: () => previousItem(),
});

e8.defineCommand({
  name: "org-next-item",
  doc: "Move to the item after the one point is in.",
  run: () => nextListItem(),
});

e8.defineCommand({
  name: "org-cycle-list-bullet",
  doc: "Change the bullets of the list point is in to the next kind: -, +, *, 1. and 1).",
  run: () => cycleListBullet(),
});

e8.defineCommand({
  name: "org-cycle-item-indentation",
  doc: "Indent an empty item, then outdent it a level at a time, then put it back, as repeated TAB does.",
  run: () => {
    cycleItemIndentation();
  },
});

e8.defineCommand({
  name: "org-cycle-level",
  doc: "Change the level of an empty heading: a child of the heading above, then up the levels, as repeated TAB does.",
  run: () => {
    cycleLevel();
  },
});

e8.defineCommand({
  name: "org-list-repair",
  doc: "Fix the indentation, bullets and checkboxes of the list point is in.",
  run: () => {
    const struct = structAtItem("This is not a list");
    writeStruct(struct, parentsAlist(struct));
  },
});

e8.defineCommand({
  name: "org-element-update-syntax",
  doc:
    "Bring the parser up to date with Org's syntax settings, as org-list-allow-alphabetical, after changing them. " +
    "E8's parser reads them as it goes, so there is nothing to do; Org's compiles them when it loads.",
  run: () => {},
});

// ---------------------------------------------------------------------------
// The full parse, after org-element.el's org-element-parse-buffer: every
// element and object of the buffer as the tree org-element-ast.ts defines,
// for Org's exporter and whatever else reads a document whole.
//
// The accessible text is read once and parsed as a string, Org's parsers
// ported to work on it: a position here is an index into that string until
// the tree is finished, when each becomes a buffer position as e8 counts
// them. Objects are parsed with the string cut down to their container, as
// Org narrows the buffer to it, so ^, $ and the string's ends are the
// container's.

/** The text being parsed: the accessible text, or the container objects are parsed in. */
let S = "";
/** Where S starts in the accessible text, so a position in S plus OFF is one in the whole. */
let OFF = 0;

interface ParseSettings {
  todoRe?: RegExp;
  done: Set<string>;
  odd: boolean;
  /** The fewest stars an inline task has, with org-inlinetask loaded. */
  inlinetask?: number;
  /** The most stars a heading that ends a section has, as org-get-limited-outline-regexp: Infinity without org-inlinetask. */
  limited: number;
  footnoteSection?: string;
  typesSource: string;
  plainRe: RegExp;
  angleRe: RegExp;
  typesRe: RegExp;
  objectRe: RegExp;
  radioRe?: RegExp;
  itemRe: RegExp;
  separate: RegExp;
  abbrevs: [string, string][];
}

let P: ParseSettings;

const WS = " \t\n\r\f";
const BLANK_NL = " \r\t\n";
const NOT_SPACE = "[^ \\t\\n\\r\\f]";
const WORD = "[\\p{L}\\p{N}]";

const regexps = new Map<string, RegExp>();

/** A regexp, made once: sticky ("y") for looking-at, global ("g") for searching. */
function re(source: string, flags: string): RegExp {
  const key = `${flags}/${source}`;
  let r = regexps.get(key);
  if (!r) {
    r = new RegExp(source, flags);
    regexps.set(key, r);
  }
  return r;
}

/** Whether `r` (sticky) matches at `p`, as looking-at, with its match. */
function la(r: RegExp, p: number): RegExpExecArray | null {
  r.lastIndex = p;
  return r.exec(S);
}

const sliced = new Map<number, string>();

/**
 * The first match of `r` (global) from `p` ending by `limit`, as
 * re-search-forward with a bound: one ending later is looked for again in
 * the text cut at the bound, as Emacs's matcher stops there.
 */
function search(r: RegExp, p: number, limit = S.length): RegExpExecArray | null {
  if (p > limit) return null;
  r.lastIndex = p;
  const m = r.exec(S);
  if (!m) return null;
  if (m.index + m[0].length <= limit) return m;
  if (m.index > limit) return null;
  let cut = sliced.get(limit);
  if (cut === undefined) {
    cut = S.slice(0, limit);
    sliced.clear();
    sliced.set(limit, cut);
  }
  r.lastIndex = p;
  return r.exec(cut);
}

function lbp(p: number): number {
  return p <= 0 ? 0 : S.lastIndexOf("\n", p - 1) + 1;
}

function lep(p: number): number {
  const i = S.indexOf("\n", p);
  return i < 0 ? S.length : i;
}

/** Where the next line starts, or the end, as forward-line and (line-beginning-position 2). */
function nextLine(p: number): number {
  const i = S.indexOf("\n", p);
  return i < 0 ? S.length : i + 1;
}

/** Where the line before starts, as (line-beginning-position 0); the first line's start on the first line. */
function prevLine(p: number): number {
  const b = lbp(p);
  return b === 0 ? 0 : lbp(b - 1);
}

function bolp(p: number): boolean {
  return p <= 0 || S[p - 1] === "\n";
}

function eolp(p: number): boolean {
  return p >= S.length || S[p] === "\n";
}

function skipF(p: number, chars: string, limit = S.length): number {
  while (p < limit && chars.includes(S[p])) p++;
  return p;
}

function skipB(p: number, chars: string, limit = 0): number {
  while (p > limit && chars.includes(S[p - 1])) p--;
  return p;
}

/** The lines from a to b, as count-lines: the newlines, and a last line with none. */
function countLines(a: number, b: number): number {
  if (b < a) [a, b] = [b, a];
  if (b === a) return 0;
  let n = 0;
  for (let i = S.indexOf("\n", a); i >= 0 && i < b; i = S.indexOf("\n", i + 1)) n++;
  return S[b - 1] === "\n" ? n : n + 1;
}

/** Where the element ends after its blank lines: the next non-blank line's start, or the limit's end. */
function endAfterBlank(p: number, limit: number): number {
  const q = skipF(p, BLANK_NL, limit);
  return q >= S.length ? q : lbp(q);
}

function trim(s: string): string {
  return s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

/** Whether a string has something other than white space, as org-string-nw-p. */
function nw(s: string | undefined): s is string {
  return s !== undefined && /[^ \t\n\r]/.test(s);
}

/** The column the text at p is at on its line, tabs to tab stops of 8, as org-current-text-column there. */
function column(p: number): number {
  let col = 0;
  for (let i = lbp(p); i < p; i++) col = S[i] === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
  return col;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function on(v: e8.Value | undefined): boolean {
  return v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0);
}

/** The link types, as org-link-types: Org's own, and those packages add. */
function orgLinkTypes(): string[] {
  const own = ["eww", "rmail", "mhe", "irc", "info", "gnus", "docview", "bibtex", "bbdb", "w3m", "doi", "id", "file+sys", "file+emacs", "shell", "news", "mailto", "https", "http", "ftp", "help", "file", "elisp"];
  let added: string[] = [];
  try {
    added = linkTypeEntries().map(([t]) => t);
  } catch {
    added = [];
  }
  return [...new Set([...own, ...added])];
}

/** Org's regexps for the current buffer's settings, as org-element--set-regexps and its kin make them. */
function settings(text: string): ParseSettings {
  const keywords = allKeywords();
  const done = new Set(keywords.filter((k) => isDone(k)));
  const todoRe = keywords.length
    ? new RegExp(`(${[...keywords].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?: |$)`, "ym")
    : undefined;
  const types = orgLinkTypes()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
  // org-link-plain-re.
  const A = "[^\\]\\[ \\t\\n()<>]";
  const B = `[(<\\[](?:${A}|[(<\\[]${A}*[\\])>])*[\\])>]`;
  const plain = `(?<!${WORD})(${types}):((?:${A}|${B})+(?:[^\\p{P}\\p{S} \\t\\n]|/|${B}))`;
  const angle = `<(${types}):([^>\\n]*(?:\\n[ \\t]*[^> \\t\\n][^>\\n]*)*)>`;
  const object =
    `[_^][-{(*+.,\\p{L}\\p{N}]|[*+/=_~]${NOT_SPACE}|(?<!${WORD})(?:${types}):` +
    `|\\[(?:cite[:/]|fn:|(?:[0-9]|(?:%|/[0-9]*)\\])|\\[)|@@|\\{\\{\\{|<(?:%%|<|[0-9]|(?:${types}))|\\$` +
    `|\\\\(?:[a-zA-Z[(]|\\\\[ \\t]*$|_ +)|(?:call|src)_`;
  // Radio targets, as org-update-radio-target-regexp finds them.
  const targets: string[] = [];
  for (const m of allMatches(/<<<([^<>\n \t]|[^<>\n \t][^<>\n]*[^<>\n \t])>>>/g, text)) if (!targets.includes(m[1])) targets.push(m[1]);
  targets.sort((a, b) => b.length - a.length);
  const radioRe = targets.length
    ? new RegExp(`(^|[^\\p{L}\\p{N}])(${targets.map((t) => escapeRe(t).replace(/ +/g, "[ \\t\\n\\r\\f]+")).join("|")})(?:$|[^\\p{L}\\p{N}])`, "yimu")
    : undefined;
  // Items, as org-item-re, from the buffer's settings.
  const tv = e8.variable("org-plain-list-ordered-item-terminator") ?? true;
  const term = tv === 41 || tv === ")" ? "\\)" : tv === 46 || tv === "." ? "\\." : "[.)]";
  const alpha = on(e8.variable("org-list-allow-alphabetical")) ? "|[A-Za-z]" : "";
  const itemRe = new RegExp(`(?:[ \\t]*(?:[-+]|(?:[0-9]+${alpha})${term})|[ \\t]+\\*)(?:[ \\t]+|$)`, "ym");
  // The paragraph separator, from the global values, as Org makes it.
  const gtv = e8.defaultValue("org-plain-list-ordered-item-terminator") ?? true;
  const gterm = gtv === 41 || gtv === ")" ? "\\)" : gtv === 46 || gtv === "." ? "\\." : "[.)]";
  const galpha = on(e8.defaultValue("org-list-allow-alphabetical")) ? "|[A-Za-z]" : "";
  const separate = new RegExp(
    `^(?:\\*+ |\\[fn:${FOOTNOTE_LABEL}\\]|%%` + "\\(|[ \\t]*(?:$|\\||\\+(?:-+\\+)+[ \\t]*$" +
      `|#(?: |$|\\+(?:BEGIN_${NOT_SPACE}+|${NOT_SPACE}+(?:\\[[^\\n]*\\])?:[ \\t]*))` +
      "|:(?: |$|[-_\\p{L}\\p{N}]+:[ \\t]*$)|-{5,}[ \\t]*$|\\\\begin\\{([A-Za-z0-9*]+)\\}" +
      `|${CLOCK_RE_SOURCE}|(?:[-+*]|(?:[0-9]+${galpha})${gterm})(?:[ \\t]|$)))`,
    "gimu",
  );
  // Link abbreviations, from the buffer's #+LINK keywords and org-link-abbrev-alist.
  const abbrevs: [string, string][] = [];
  for (const m of allMatches(/^[ \t]*#\+LINK:[ \t]+(\S+)[ \t]+(.*?)[ \t]*$/gim, text)) abbrevs.push([m[1], m[2]]);
  const global = e8.variable("org-link-abbrev-alist");
  if (Array.isArray(global))
    for (const e of global) if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") abbrevs.push([e[0], e[1]]);
  const fs = e8.variable("org-footnote-section");
  return {
    todoRe,
    done,
    odd: on(e8.variable("org-odd-levels-only")),
    inlinetask: inlinetaskStars(),
    limited: limitedStars(),
    footnoteSection: typeof fs === "string" ? fs : undefined,
    typesSource: types,
    plainRe: new RegExp(plain, "yiu"),
    angleRe: new RegExp(angle, "yiu"),
    typesRe: new RegExp(`^(${types}):`, "iu"),
    objectRe: new RegExp(object, "gimu"),
    radioRe,
    itemRe,
    separate,
    abbrevs,
  };
}

const TS_DATE = "\\d{4}-\\d{2}-\\d{2}(?: [^\\n]*?)?";
const CLOCK_RE_SOURCE = `^[ \\t]*CLOCK:(?:[ \\t]+\\[(?:${TS_DATE})\\](?:--\\[(?:${TS_DATE})\\][ \\t]+=>[ \\t]+\\d+:\\d\\d)?|[ \\t]+=>[ \\t]+\\d+:\\d\\d)[ \\t]*$`;
const RX = {
  clockLine: CLOCK_RE_SOURCE,
  comment: "^[ \\t]*#(?: |$)",
  planningLine: "^[ \\t]*(CLOSED:|DEADLINE:|SCHEDULED:)",
  planningKeyword: "CLOSED:|DEADLINE:|SCHEDULED:",
  drawer: "^[ \\t]*:([-_\\p{L}\\p{N}]+):[ \\t]*$",
  propertyDrawer: `^[ \\t]*:PROPERTIES:[ \\t]*\\n(?:[ \\t]*:${NOT_SPACE}+:(?:[ \\t][^\\n]*)?[ \\t]*\\n)*?[ \\t]*:END:[ \\t]*$`,
  property: `^([ \\t]*)(:(${NOT_SPACE}+):)(?:()$|[ \\t]+([^\\n]*?))([ \\t]*)$`,
  latexBegin: "^[ \\t]*\\\\begin\\{([A-Za-z0-9*]+)\\}",
  footnoteDefinition: `^\\[fn:(${FOOTNOTE_LABEL})\\]`,
  fullItem:
    "^[ \\t]*((?:[-+*]|(?:[0-9]+|[A-Za-z])[.)])(?:[ \\t]+|$))(?:\\[@(?:start:)?([0-9]+|[A-Za-z])\\][ \\t]*)?(?:(\\[[ X-]\\])(?:[ \\t]+|$))?(?:([^\\n]*)([ \\t]+::(?:[ \\t]+|$)))?",
  affiliated:
    "[ \\t]*#\\+(?:(CAPTION|RESULTS)(?:\\[([^\\n]*)\\])?|(DATA|HEADERS?|LABEL|NAME|PLOT|RESNAME|RESULT|SOURCE|SRCNAME|TBLNAME)|(ATTR_[-_A-Za-z0-9]+)):[ \\t]*",
  tsBoth: `[[<](${TS_DATE})[\\]>]`,
  target: "<<([^<>\\n \\t]|[^<>\\n \\t][^<>\\n]*[^<>\\n \\t])>>",
  radioTarget: "<<<([^<>\\n \\t]|[^<>\\n \\t][^<>\\n]*[^<>\\n \\t])>>>",
  linkBracket: "\\[\\[((?:[^\\]\\[\\\\]|\\\\(?:\\\\\\\\)*[\\]\\[]|\\\\+[^\\]\\[])+)\\](?:\\[([\\s\\S]+?)\\])?\\]",
  footnote: `\\[fn:(?:(${FOOTNOTE_LABEL})?(:)|(${FOOTNOTE_LABEL})\\])`,
  substring:
    `(${NOT_SPACE})([_^])((?:\\{([^{}]*?|(?:[^{}]*?\\{[^{}]*?\\})+[^{}]*?|(?:[^{}]*?\\{(?:[^{}]*?\\{[^{}]*?\\})+[^{}]*?\\})+[^{}]*?)\\})` +
    "|(?:\\(([^()]*?|(?:[^()]*?\\([^()]*?\\))+[^()]*?|(?:[^()]*?\\((?:[^()]*?\\([^()]*?\\))+[^()]*?\\))+[^()]*?)\\))|(?:\\*|[+-]?[\\p{L}\\p{N}.,\\\\]*[\\p{L}\\p{N}]))",
  citationKey: "@([\\p{L}\\p{N}\\-.:?!`'/*@+|(){}<>&_^$#%~]+)",
  citationPrefix: "\\[cite(?:/([/_\\-\\p{L}\\p{N}]+))?:[\\t\\n ]*",
};

/** Position p of S as one in the whole accessible text. */
function abs(p: number): number {
  return p + OFF;
}

function node(type: string, p: { [name: string]: any }): Node {
  for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === null || p[k] === false) delete p[k];
  return { type, p, contents: [] };
}

interface Affiliated {
  begin: number;
  kw?: { [name: string]: any };
}

function addAffiliated(n: Node, aff: Affiliated): Node {
  if (aff.kw)
    for (const [k, v] of Object.entries(aff.kw)) {
      n.p[k] = v;
      if (k === "caption")
        for (const entry of v as { value: Datum[]; secondary?: Datum[] }[]) {
          for (const d of entry.value) if (typeof d !== "string") d.parent = n;
          for (const d of entry.secondary ?? []) if (typeof d !== "string") d.parent = n;
        }
    }
  return n;
}

// ----- Elements -----

/** A block that ends with END_NAME: where its last line starts, or undefined when it is not closed. */
function blockEnd(name: string, p: number, limit: number): number | undefined {
  const m = search(re(`^[ \\t]*#\\+END_${escapeRe(name)}[ \\t]*$`, "gimu"), p, limit);
  return m ? m.index : undefined;
}

function greaterBlock(type: string, endName: string, p: number, limit: number, aff: Affiliated, extra: { [name: string]: any } = {}): Node {
  const close = blockEnd(endName, p, limit);
  if (close === undefined) return paragraphParser(p, limit, aff);
  let cb: number | undefined = nextLine(p);
  if (cb >= close) cb = undefined;
  const before = nextLine(close);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node(type, {
      ...extra,
      begin: aff.begin,
      end,
      "contents-begin": cb,
      "contents-end": cb === undefined ? undefined : close,
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function drawerParser(p: number, limit: number, aff: Affiliated): Node {
  const close = search(re("^[ \\t]*:END:[ \\t]*$", "gim"), Math.min(limit, lep(p)), limit);
  if (!close) return paragraphParser(p, limit, aff);
  const name = la(re(RX.drawer, "ymu"), p)![1];
  let cb: number | undefined = nextLine(p);
  if (cb >= close.index) cb = undefined;
  const before = nextLine(close.index);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("drawer", {
      begin: aff.begin,
      end,
      "drawer-name": name,
      "contents-begin": cb,
      "contents-end": cb === undefined ? undefined : close.index,
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function dynamicBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const close = search(re("^[ \\t]*#\\+END:?[ \\t]*$", "gim"), p, limit);
  if (!close) return paragraphParser(p, limit, aff);
  const m = la(re(`^[ \\t]*#\\+BEGIN:[ \\t]*(${WORD}+)(?:[ \\t]+([^\\n]+))?`, "yimu"), p)!;
  let cb: number | undefined = nextLine(p);
  if (cb >= close.index) cb = undefined;
  const before = nextLine(close.index);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("dynamic-block", {
      begin: aff.begin,
      end,
      "block-name": m[1],
      arguments: m[2],
      "contents-begin": cb,
      "contents-end": cb === undefined ? undefined : close.index,
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function footnoteDefinitionParser(p: number, limit: number, aff: Affiliated): Node {
  const label = la(re(RX.footnoteDefinition, "ymui"), p)![1];
  const begin = aff.begin;
  let end: number;
  const sep = search(re(`^\\*+ |${RX.footnoteDefinition}|^(?:[ \\t]*\\n){2,}`, "gmui"), lep(p), limit);
  if (!sep) end = limit;
  else if (S[sep.index] === "[") {
    let q = prevLine(sep.index + sep[0].length);
    while (q > p && la(re(RX.affiliated, "yi"), q)) q = prevLine(q);
    end = nextLine(q);
  } else if (S[sep.index] === "*") end = sep.index;
  else {
    const q = skipF(sep.index + sep[0].length, BLANK_NL, limit);
    end = q === limit ? limit : lbp(q);
  }
  let preBlank = 0;
  let cb: number | undefined = skipF(S.indexOf("]", p) + 1, BLANK_NL, end);
  if (cb === end) cb = undefined;
  else if (lbp(cb) !== p) {
    preBlank = countLines(lbp(cb), begin);
    cb = lbp(cb);
  }
  const ce = nextLine(skipB(end, BLANK_NL));
  return addAffiliated(
    node("footnote-definition", {
      label,
      begin,
      end,
      "contents-begin": cb,
      "contents-end": cb === undefined ? undefined : ce,
      "pre-blank": preBlank,
      "post-blank": countLines(ce, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

/** A headline's or inlinetask's level as shown, as org-reduced-level. */
function reducedLevel(l: number): number {
  return P.odd && l > 0 ? 1 + Math.floor(l / 2) : l;
}

/** The node properties in the property drawer after a headline or at p, as org-element--get-node-properties: upper-case names, those ending in + gathered. */
function nodeProperties(p: number, atPoint: boolean): { [name: string]: any } | undefined {
  let q = p;
  if (!atPoint) {
    q = nextLine(q);
    if (la(re(RX.planningLine, "ym"), q)) q = nextLine(q);
  }
  const drawer = la(re(RX.propertyDrawer, "yim"), q);
  if (!drawer) return undefined;
  const end = q + drawer[0].length;
  const props: { [name: string]: any } = {};
  q = nextLine(q);
  while (lep(q) < end) {
    const m = la(re(RX.property, "ym"), q);
    if (m) {
      const name = m[3].toUpperCase();
      const value = m[4] ?? m[5] ?? "";
      if (name in props && name.endsWith("+")) props[name] = Array.isArray(props[name]) ? [...props[name], value] : [props[name], value];
      else props[name] = value;
    }
    q = nextLine(q);
  }
  return props;
}

/** The planning line after a headline at p, as org-element--get-time-properties. */
function timeProperties(p: number): { [name: string]: Node } {
  const out: { [name: string]: Node } = {};
  const q = nextLine(p);
  if (!la(re(RX.planningLine, "ym"), q)) return out;
  const end = lep(q);
  const r = re(RX.planningKeyword, "g");
  let from = q;
  let m: RegExpExecArray | null;
  while ((m = search(r, from, end))) {
    from = m.index + m[0].length;
    const time = timestampParser(skipF(from, " \t"));
    if (time) out[m[0] === "SCHEDULED:" ? "scheduled" : m[0] === "DEADLINE:" ? "deadline" : "closed"] = time;
  }
  return out;
}

function headlineParser(p: number, raw: boolean): Node {
  const begin = p;
  const trueLevel = skipF(p, "*") - p;
  const h = re(`^\\*{1,${trueLevel}} `, "gm");
  const next = search(h, p + trueLevel);
  const end = next ? next.index : S.length;
  let cb: number | undefined = skipF(nextLine(p), BLANK_NL, end);
  cb = cb === end ? undefined : lbp(cb);
  const n = node("headline", {
    begin,
    end,
    "pre-blank": cb === undefined ? 0 : countLines(begin, cb) - 1,
    "contents-begin": cb,
    "contents-end": cb === undefined ? undefined : end,
    "true-level": trueLevel,
  });
  headlineTitle(n, raw);
  n.p["post-blank"] = cb !== undefined ? 0 : countLines(begin, end) - 1;
  n.p["post-affiliated"] = begin;
  Object.assign(n.p, timeProperties(begin));
  const np = nodeProperties(begin, false);
  if (np) Object.assign(n.p, np);
  return n;
}

/**
 * A headline's or an inline task's title and what its line says, as
 * org-element--headline-parse-title puts them on the node.
 */
function headlineTitle(n: Node, raw: boolean): void {
  const begin: number = n.p.begin;
  const trueLevel = skipF(begin, "*") - begin;
  let q = skipF(begin + trueLevel, " \t");
  let todo: string | undefined;
  if (P.todoRe) {
    const m = la(P.todoRe, q);
    if (m) {
      todo = m[1];
      q = skipF(q + m[0].length, " \t");
    }
  }
  let priority: number | undefined;
  const pm = la(re("\\[#[^\\n]\\][ \\t]*", "yu"), q);
  if (pm) {
    priority = pm[0].codePointAt(2);
    q += pm[0].length;
  }
  let commented = false;
  const cm = la(re("COMMENT(?: |$)", "ym"), q);
  if (cm) {
    commented = true;
    q = skipF(q + cm[0].length, " \t");
  }
  const titleStart = q;
  const lineEnd = lep(q);
  let tags: string[] | undefined;
  let titleEnd = lineEnd;
  const tm = search(re("(:[\\p{L}\\p{N}_@#%:]+:)[ \\t]*$", "gmu"), q, lineEnd);
  if (tm) {
    titleEnd = tm.index;
    tags = splitString(tm[1], ":");
  }
  const rawValue = trim(S.slice(titleStart, titleEnd));
  const props: { [name: string]: any } = {
    "raw-value": rawValue,
    level: reducedLevel(trueLevel),
    priority,
    tags,
    "todo-keyword": todo,
    "todo-type": todo === undefined ? undefined : P.done.has(todo) ? "done" : "todo",
    "footnote-section-p": P.footnoteSection !== undefined && P.footnoteSection === rawValue,
    archivedp: tags?.includes("ARCHIVE") ?? false,
    commentedp: commented,
  };
  for (const k of Object.keys(props)) if (props[k] !== undefined && props[k] !== null && props[k] !== false) n.p[k] = props[k];
  n.p.title = raw ? rawValue : parseObjects(skipF(titleStart, " \t"), skipB(titleEnd, " \t"), undefined, restriction(n.type), n);
  if (Array.isArray(n.p.title) && n.p.title.length === 0) delete n.p.title;
}

/**
 * An inline task, as org-element-inlinetask-parser: its heading line, and
 * up to an END line of stars before limit, if there is one, what it holds;
 * its planning and properties only then.
 */
function inlinetaskParser(p: number, limit: number, raw: boolean): Node {
  const begin = p;
  const next = search(re("^\\*+ ", "gm"), nextLine(p), limit);
  const taskEnd = next && la(re("[ \\t]*END[ \\t]*$", "yim"), next.index + next[0].length) ? next.index : undefined;
  const cb = taskEnd === undefined ? undefined : lbp(skipF(nextLine(begin), " \t\n"));
  const ce = cb === undefined ? undefined : taskEnd;
  const after = skipF(nextLine(taskEnd ?? begin), BLANK_NL, limit);
  const end = after >= S.length ? after : lbp(after);
  const n = node("inlinetask", {
    begin,
    end,
    "pre-blank": cb === undefined ? 0 : countLines(begin, cb) - 1,
    "contents-begin": cb,
    "contents-end": ce,
  });
  headlineTitle(n, raw);
  n.p["post-blank"] = countLines(taskEnd ?? begin, end) - 1;
  n.p["post-affiliated"] = begin;
  if (taskEnd !== undefined) {
    Object.assign(n.p, timeProperties(begin));
    const np = nodeProperties(begin, false);
    if (np) Object.assign(n.p, np);
  }
  return n;
}

/** STRING split at SEP, separators at its ends dropped, as org-split-string. */
function splitString(s: string, sep: string): string[] {
  const parts = s.split(sep);
  if (parts.length > 1 && parts[0] === "") parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** A list's structure: for each item its start, indentation, bullet, counter, checkbox, tag and end, as org-list-struct. */
type StructItem = [number, number, string, string | undefined, string | undefined, string | undefined, number];

function listStructAt(p: number, limit: number): StructItem[] {
  let items: StructItem[] = [];
  const struct: StructItem[] = [];
  const done = (): StructItem[] => [...items, ...struct].sort((a, b) => a[0] - b[0]);
  let q = p;
  for (;;) {
    if (q >= limit) {
      const end = nextLine(skipB(q, BLANK_NL));
      for (const it of items) it[6] = end;
      return done();
    }
    if (la(re("^[ \\t]*\\n[ \\t]*\\n", "ym"), q)) {
      for (const it of items) it[6] = q;
      return done();
    }
    if (la(P.itemRe, q)) {
      const ind = column(skipF(q, " \t"));
      while (items.length && ind <= items[0][1]) {
        const it = items.shift()!;
        it[6] = q;
        struct.push(it);
      }
      const m = la(re(RX.fullItem, "ym"), q)!;
      const bullet = m[1];
      items.unshift([q, ind, bullet, m[2], m[3], /[-+*]/.test(bullet) ? m[4] : undefined, 0]);
      q = nextLine(q);
      continue;
    }
    if (la(re("^[ \\t]*$", "ym"), q)) {
      q = nextLine(q);
      continue;
    }
    const ind = column(skipF(q, " \t"));
    const end = nextLine(skipB(q, BLANK_NL));
    while (items.length && ind <= items[0][1]) {
      const it = items.shift()!;
      it[6] = end;
      struct.push(it);
      if (!items.length) return struct.sort((a, b) => a[0] - b[0]);
    }
    const block = la(re(`[ \\t]*#\\+BEGIN(:|_${NOT_SPACE}+)`, "yi"), q);
    if (block) {
      const close = search(re(`^[ \\t]*#\\+END${escapeRe(block[1])}[ \\t]*$`, "gim"), q, limit);
      if (close) q = close.index + close[0].length;
    } else if (la(re(RX.drawer, "ymu"), q)) {
      const close = search(re("^[ \\t]*:END:[ \\t]*$", "gim"), q, limit);
      if (close) q = close.index + close[0].length;
    }
    q = nextLine(q);
  }
}

const structIndexes = new WeakMap<StructItem[], Map<number, StructItem>>();

/** A structure's items by where they start, as assq finds them. */
function structIndex(struct: StructItem[]): Map<number, StructItem> {
  let index = structIndexes.get(struct);
  if (!index) {
    index = new Map();
    for (const it of struct) if (!index.has(it[0])) index.set(it[0], it);
    structIndexes.set(struct, index);
  }
  return index;
}

function itemParser(p: number, limit: number, struct: StructItem[], raw: boolean): Node {
  p = lbp(p);
  const m = la(re(RX.fullItem, "ym"), p)!;
  const begin = p;
  const bullet = m[1];
  const tagBegin = m[4] === undefined ? undefined : p + m[0].length - m[5].length - m[4].length;
  const checkbox = m[3] === "[ ]" ? "off" : m[3] === "[X]" ? "on" : m[3] === "[-]" ? "trans" : undefined;
  const entry = structIndex(struct).get(begin)!;
  const itemEnd = entry[6];
  const end = Math.min(limit, bolp(itemEnd) ? itemEnd : nextLine(itemEnd));
  let preBlank = 0;
  let cb: number | undefined = skipF(m[4] !== undefined && /[.)]/.test(bullet) ? tagBegin! : p + m[0].length, BLANK_NL, end);
  if (cb === end) cb = undefined;
  else if (lbp(cb) !== begin) {
    preBlank = countLines(lbp(cb), begin);
    cb = lbp(cb);
  }
  const ce = cb === undefined ? undefined : nextLine(skipB(end, BLANK_NL));
  let counter: number | undefined;
  if (m[2] !== undefined) counter = /[A-Za-z]/.test(m[2]) ? m[2].toUpperCase().charCodeAt(0) - 64 : Number(/[0-9]+/.exec(m[2])![0]);
  const n = node("item", {
    bullet,
    begin,
    end,
    "contents-begin": cb,
    "contents-end": ce,
    checkbox,
    counter,
    structure: struct,
    "pre-blank": preBlank,
    "post-blank": countLines(ce ?? begin, end),
    "post-affiliated": begin,
  });
  const tag = entry[5];
  if (tag !== undefined) {
    if (raw) n.p.tag = tag;
    else {
      const t = parseObjects(abs(tagBegin!), abs(tagBegin! + m[4].length), undefined, restriction("item"), n);
      if (t.length) n.p.tag = t;
    }
  }
  return n;
}

function plainListParser(p: number, limit: number, aff: Affiliated, structure: StructItem[]): Node {
  const struct = structure;
  const index = structIndex(struct);
  const entry = index.get(p);
  const type = la(re("[ \\t]*[A-Za-z0-9]", "y"), p) ? "ordered" : entry && entry[5] !== undefined ? "descriptive" : "unordered";
  const cb = p;
  let item = entry!;
  const ind = item[1];
  let pos = item[6];
  for (;;) {
    const nextItem = index.get(pos);
    if (!nextItem || nextItem[1] !== ind) break;
    pos = nextItem[6];
    item = nextItem;
  }
  const back = skipB(pos, BLANK_NL);
  const ce = bolp(back) ? back : nextLine(back);
  const q = skipF(ce, BLANK_NL, limit);
  const end = q === limit ? limit : lbp(q);
  return addAffiliated(
    node("plain-list", {
      type,
      begin: aff.begin,
      end,
      "contents-begin": cb,
      "contents-end": ce,
      structure: struct,
      "post-blank": countLines(ce, end),
      "post-affiliated": cb,
    }),
    aff,
  );
}

function propertyDrawerParser(p: number, limit: number): Node {
  const begin = p;
  const cb = nextLine(p);
  const close = search(re("^[ \\t]*:END:[ \\t]*$", "gim"), p, limit)!;
  const ce = close.index > cb ? close.index : undefined;
  const before = nextLine(close.index);
  const end = endAfterBlank(before, limit);
  return node("property-drawer", {
    begin,
    end,
    "contents-begin": ce === undefined ? undefined : cb,
    "contents-end": ce,
    "post-blank": countLines(before, end),
    "post-affiliated": begin,
  });
}

/** The headings that end a section, as org-get-limited-outline-regexp with bol: not inline tasks. */
function limitedHeadingRe(): RegExp {
  if (P.limited === Infinity) return re("^\\*+ ", "gm");
  return P.limited < 1 ? re("(?!)", "gm") : re(`^\\*{1,${P.limited}} `, "gm");
}

function sectionParser(p: number): Node {
  const m = search(limitedHeadingRe(), p);
  const end = m ? m.index : S.length;
  return node("section", { begin: p, end, "contents-begin": p, "contents-end": end, "post-blank": 0, "post-affiliated": p });
}

function specialBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const m = la(re(`[ \\t]*#\\+BEGIN_(${NOT_SPACE}+)[ \\t]*([^\\n]*)[ \\t]*$`, "yim"), p)!;
  const type = m[1];
  return greaterBlock("special-block", type, p, limit, aff, { type, parameters: nw(m[2]) ? trim(m[2]) : undefined });
}

/** The text in the brackets at p, as org-element--parse-paired-brackets: their contents and the position after them, only that kind of bracket nesting. */
function pairedBrackets(p: number, open: string): { text: string; end: number } | undefined {
  if (S[p] !== open) return undefined;
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (let i = p; i < S.length; i++) {
    if (S[i] === open) depth++;
    else if (S[i] === close) {
      depth--;
      if (depth === 0) return { text: S.slice(p + 1, i), end: i + 1 };
    }
  }
  return undefined;
}

/** Where the bracket at p closes, as scan-lists with only those brackets paired: after it, or undefined. */
function closingBracket(p: number): number | undefined {
  return pairedBrackets(p, S[p])?.end;
}

function babelCallParser(p: number, limit: number, aff: Affiliated): Node {
  const before = nextLine(p);
  const colon = S.indexOf(":", p);
  let q = colon >= 0 && colon < before ? skipF(colon + 1, " \t") : p;
  const value = trim(S.slice(q, lep(q)));
  const callEnd = (() => {
    let i = q;
    while (i < before && !"[]()".includes(S[i])) i++;
    return i;
  })();
  const call = nw(S.slice(q, callEnd)) ? S.slice(q, callEnd) : undefined;
  q = callEnd;
  const inside = pairedBrackets(q, "[");
  if (inside) q = inside.end;
  const args = pairedBrackets(q, "(");
  if (args) q = args.end;
  const endHeader = trim(S.slice(q, lep(q)));
  const end = endAfterBlank(nextLine(p), limit);
  return addAffiliated(
    node("babel-call", {
      call,
      "inside-header": inside?.text,
      arguments: nw(args?.text) ? args!.text : undefined,
      "end-header": nw(endHeader) ? endHeader : undefined,
      begin: aff.begin,
      end,
      value,
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

/** Where the blank lines after a one-line element end, as the clock and planning parsers find it. */
function oneLineEnd(p: number, limit: number): { before: number; end: number } {
  const before = nextLine(p);
  let q = skipF(before, BLANK_NL, limit);
  q = skipB(q, " \t");
  if (!bolp(q)) q = skipF(q, " \t");
  return { before, end: q };
}

function clockParser(p: number, limit: number): Node {
  const begin = p;
  const le = lep(p);
  const c = S.indexOf("CLOCK:", p);
  const at = skipF(c + 6, " \t");
  const value = timestampParser(at);
  let duration: string | undefined;
  const arrow = S.indexOf("=> ", at);
  if (arrow >= 0 && arrow + 3 <= le) {
    const m = la(re("([^ \\t\\n\\r\\f]+)[ \\t]*$", "ym"), skipF(arrow + 3, " \t"));
    if (m) duration = m[1];
  }
  const { before, end } = oneLineEnd(p, limit);
  return node("clock", {
    status: duration ? "closed" : "running",
    value,
    duration,
    begin,
    end,
    "post-blank": countLines(before, end),
    "post-affiliated": begin,
  });
}

function commentParser(p: number, limit: number): Node {
  const begin = p;
  const r = re("^[ \\t]*#(?: |$)", "ym");
  let m = la(r, p)!;
  let value = S.slice(p + m[0].length, lep(p));
  let q = nextLine(p);
  while (q < limit && (m = la(r, q)!)) {
    value += "\n" + S.slice(q + m[0].length, lep(q));
    q = nextLine(q);
  }
  const end = endAfterBlank(q, limit);
  return node("comment", { begin, end, value, "post-blank": countLines(q, end), "post-affiliated": begin });
}

function commentBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const close = blockEnd("COMMENT", p, limit);
  if (close === undefined) return paragraphParser(p, limit, aff);
  const cb = nextLine(p);
  const before = nextLine(close);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("comment-block", {
      begin: aff.begin,
      end,
      value: S.slice(cb, close),
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function diarySexpParser(p: number, limit: number, aff: Affiliated): Node {
  const m = la(re("(%%\\([^\\n]*)[ \\t]*$", "ym"), p);
  const before = nextLine(p);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("diary-sexp", { value: m?.[1], begin: aff.begin, end, "post-blank": countLines(before, end), "post-affiliated": p }),
    aff,
  );
}

/** A block's switches, as the example and source block parsers read them. */
function switchesProps(switches: string | undefined): { [name: string]: any } {
  if (switches === undefined)
    return { "number-lines": undefined, "preserve-indent": undefined, "retain-labels": true, "use-labels": true, "label-fmt": undefined };
  const n = /([-+])n(?: *([0-9]+))?(?![\p{L}\p{N}])/u.exec(switches);
  const numberLines = n ? [n[1] === "-" ? "new" : "continued", n[2] === undefined ? 0 : Number(n[2]) - 1] : undefined;
  const word = (s: string) => new RegExp(`${s}(?![\\p{L}\\p{N}])`, "u").test(switches);
  const retain = !word("-r") || (numberLines !== undefined && word("-k"));
  return {
    "number-lines": numberLines,
    "preserve-indent": word("-i"),
    "retain-labels": retain,
    "use-labels": retain && !word("-k"),
    "label-fmt": /-l +"([^"\n]+)"/.exec(switches)?.[1],
  };
}

/** Code with the comma taken off lines escaped so, as org-unescape-code-in-string. */
export function unescapeCode(s: string): string {
  return s.replace(/^([ \t]*,*),(\*|#\+)/gm, "$1$2");
}

/** Code with a comma put before lines Org would read as its own, as org-escape-code-in-string. */
export function escapeCode(s: string): string {
  return s.replace(/^([ \t]*)(,*(?:\*|#\+))/gm, "$1,$2");
}

function exampleBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const close = blockEnd("EXAMPLE", p, limit);
  if (close === undefined) return paragraphParser(p, limit, aff);
  const switches = la(re("^[ \\t]*#\\+BEGIN_EXAMPLE(?: +([^\\n]*))?", "yim"), p)![1];
  const cb = nextLine(p);
  const before = nextLine(close);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("example-block", {
      begin: aff.begin,
      end,
      value: unescapeCode(S.slice(cb, close)),
      switches,
      ...switchesProps(switches),
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function exportBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const close = blockEnd("EXPORT", p, limit);
  if (close === undefined) return paragraphParser(p, limit, aff);
  const backend = la(re(`[ \\t]*#\\+BEGIN_EXPORT(?:[ \\t]+(${NOT_SPACE}+))?[ \\t]*$`, "yim"), p)?.[1];
  const cb = nextLine(p);
  const before = nextLine(close);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("export-block", {
      type: backend?.toUpperCase(),
      begin: aff.begin,
      end,
      value: unescapeCode(S.slice(cb, close)),
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function fixedWidthParser(p: number, limit: number, aff: Affiliated): Node {
  let q = p;
  const r = re("[ \\t]*:( |$)", "ym");
  while (q < limit && la(r, q)) q = nextLine(q);
  const endArea = bolp(q) && q > p && S[q - 1] === "\n" ? q - 1 : q;
  const end = endAfterBlank(endArea, limit);
  return addAffiliated(
    node("fixed-width", {
      begin: aff.begin,
      end,
      value: S.slice(p, endArea).replace(/^[ \t]*: ?/gm, ""),
      "post-blank": countLines(endArea, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function horizontalRuleParser(p: number, limit: number, aff: Affiliated): Node {
  const post = nextLine(p);
  const end = endAfterBlank(post, limit);
  return addAffiliated(node("horizontal-rule", { begin: aff.begin, end, "post-blank": countLines(post, end), "post-affiliated": p }), aff);
}

function keywordParser(p: number, limit: number, aff: Affiliated | undefined): Node {
  // (\S-*): matches greedily, backing off to the last colon it can end at.
  const greedy = la(re(`[ \\t]*#\\+(${NOT_SPACE}*):`, "y"), p)!;
  const key = greedy[1].toUpperCase();
  const value = trim(S.slice(p + greedy[0].length, lep(p)));
  const before = nextLine(p);
  const end = endAfterBlank(before, limit);
  const n = node("keyword", { key, value, begin: aff?.begin ?? p, end, "post-blank": countLines(before, end), "post-affiliated": p });
  return aff ? addAffiliated(n, aff) : n;
}

function latexEnvironmentParser(p: number, limit: number, aff: Affiliated): Node {
  const m = la(re(RX.latexBegin, "yim"), p)!;
  const close = search(re(`\\\\end\\{${escapeRe(m[1])}\\}[ \\t]*$`, "gim"), p, limit);
  if (!close) return paragraphParser(p, limit, aff);
  const codeEnd = nextLine(close.index);
  const end = endAfterBlank(codeEnd, limit);
  return addAffiliated(
    node("latex-environment", { begin: aff.begin, end, value: S.slice(p, codeEnd), "post-blank": countLines(codeEnd, end), "post-affiliated": p }),
    aff,
  );
}

function nodePropertyParser(p: number): Node {
  const m = la(re(RX.property, "ym"), p)!;
  return node("node-property", {
    key: m[3],
    value: m[4] ?? m[5],
    begin: p,
    end: Math.min(S.length, p + m[0].length + 1),
    "post-blank": 0,
    "post-affiliated": p,
  });
}

function paragraphParser(p: number, limit: number, aff: Affiliated): Node {
  const cb = p;
  let q = lep(p);
  for (;;) {
    const m = search(P.separate, q, limit);
    if (!m) {
      q = limit;
      break;
    }
    q = lbp(m.index + m[0].length);
    let ends: boolean;
    let b: RegExpExecArray | null;
    if (la(re(RX.drawer, "ymu"), q)) ends = !!search(re("^[ \\t]*:END:[ \\t]*$", "gim"), nextLine(q), limit);
    else if ((b = la(re(`[ \\t]*#\\+BEGIN_(${NOT_SPACE}+)`, "yi"), q))) ends = blockEnd(b[1], q, limit) !== undefined;
    else if ((b = la(re(RX.latexBegin, "yim"), q))) ends = !!search(re(`\\\\end\\{${escapeRe(b[1])}\\}[ \\t]*$`, "gim"), q, limit);
    else if ((b = la(re(`[ \\t]*#\\+(${NOT_SPACE}+)\\[[^\\n]*\\]:`, "yi"), q))) ends = ["CAPTION", "RESULTS"].includes(b[1].toUpperCase());
    else ends = true;
    if (ends) break;
    q = lep(q);
  }
  const before = q === limit ? limit : lbp(q);
  const ce = nextLine(skipB(before, BLANK_NL, cb));
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("paragraph", {
      begin: aff.begin,
      end,
      "contents-begin": cb,
      "contents-end": ce,
      "post-blank": countLines(before, end),
      "post-affiliated": cb,
    }),
    aff,
  );
}

function planningParser(p: number, limit: number): Node {
  const begin = p;
  const { before, end } = oneLineEnd(p, limit);
  const props: { [name: string]: any } = {};
  const r = re(RX.planningKeyword, "g");
  let from = p;
  let m: RegExpExecArray | null;
  while ((m = search(r, from, end))) {
    from = m.index + m[0].length;
    const time = timestampParser(skipF(from, " \t", end));
    props[m[0] === "CLOSED:" ? "closed" : m[0] === "DEADLINE:" ? "deadline" : "scheduled"] = time;
  }
  return node("planning", {
    closed: props.closed,
    deadline: props.deadline,
    scheduled: props.scheduled,
    begin,
    end,
    "post-blank": countLines(before, end),
    "post-affiliated": begin,
  });
}

function srcBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const close = blockEnd("SRC", p, limit);
  if (close === undefined) return paragraphParser(p, limit, aff);
  const m = la(
    re(`^[ \\t]*#\\+BEGIN_SRC(?: +(${NOT_SPACE}+))?((?: +(?:-(?:l "[^\\n]+"|[ikr])|[-+]n(?: *[0-9]+)?))+)?([^\\n]*)[ \\t]*$`, "yim"),
    p,
  )!;
  const switches = m[2];
  const before = nextLine(close);
  const end = endAfterBlank(before, limit);
  const sw = switchesProps(switches);
  return addAffiliated(
    node("src-block", {
      language: m[1],
      switches: nw(switches) ? trim(switches) : undefined,
      parameters: nw(m[3]) ? trim(m[3]) : undefined,
      begin: aff.begin,
      end,
      "number-lines": sw["number-lines"],
      "preserve-indent": sw["preserve-indent"],
      "retain-labels": sw["retain-labels"],
      "use-labels": sw["use-labels"],
      "label-fmt": sw["label-fmt"],
      value: unescapeCode(S.slice(nextLine(p), close)),
      "post-blank": countLines(before, end),
      "post-affiliated": p,
    }),
    aff,
  );
}

function tableParser(p: number, limit: number, aff: Affiliated): Node {
  const tableBegin = p;
  const org = !!la(re("[ \\t]*\\|", "y"), p);
  const m = search(re(org ? "^[ \\t]*(?:$|[^| \\t])" : "^[ \\t]*(?:$|[^| \\t+])", "gm"), p, limit);
  const tableEnd = m ? m.index : limit;
  let q = tableEnd;
  const tblfm: string[] = [];
  let f: RegExpExecArray | null;
  while ((f = la(re("[ \\t]*#\\+TBLFM: +([^\\n]*)[ \\t]*$", "yim"), q))) {
    tblfm.unshift(f[1]);
    q = nextLine(q);
  }
  const before = q;
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("table", {
      begin: aff.begin,
      end,
      type: org ? "org" : "table.el",
      tblfm: tblfm.length ? tblfm : undefined,
      "contents-begin": org ? tableBegin : undefined,
      "contents-end": org ? tableEnd : undefined,
      value: org ? undefined : S.slice(tableBegin, tableEnd),
      "post-blank": countLines(before, end),
      "post-affiliated": tableBegin,
    }),
    aff,
  );
}

function tableRowParser(p: number): Node {
  const rule = !!la(re("^[ \\t]*\\|-", "ym"), p);
  const bar = S.indexOf("|", p);
  return node("table-row", {
    type: rule ? "rule" : "standard",
    begin: p,
    end: nextLine(p),
    "contents-begin": rule ? undefined : bar + 1,
    "contents-end": rule ? undefined : skipB(lep(p), " \t"),
    "post-blank": 0,
    "post-affiliated": p,
  });
}

function verseBlockParser(p: number, limit: number, aff: Affiliated): Node {
  const close = blockEnd("VERSE", p, limit);
  if (close === undefined) return paragraphParser(p, limit, aff);
  const cb = nextLine(p);
  const before = nextLine(close);
  const end = endAfterBlank(before, limit);
  return addAffiliated(
    node("verse-block", { begin: aff.begin, end, "contents-begin": cb, "contents-end": close, "post-blank": countLines(before, end), "post-affiliated": p }),
    aff,
  );
}

const KEYWORD_TRANSLATIONS: { [kwd: string]: string } = {
  DATA: "NAME",
  LABEL: "NAME",
  RESNAME: "NAME",
  SOURCE: "NAME",
  SRCNAME: "NAME",
  TBLNAME: "NAME",
  RESULT: "RESULTS",
  HEADERS: "HEADER",
};

/** The affiliated keywords from p, as org-element--collect-affiliated-keywords: where they start, their values, and where the element starts after them. */
function collectAffiliated(p: number, limit: number, parse: boolean): { aff: Affiliated; p: number } {
  if (!bolp(p)) return { aff: { begin: p }, p };
  const origin = p;
  const restrict = parse ? restriction("keyword") : [];
  let kw: { [name: string]: any } | undefined;
  let m: RegExpExecArray | null;
  const r = re(RX.affiliated, "yi");
  while (p < limit && (m = la(r, p))) {
    const raw = (m[1] ?? m[3] ?? m[4]).toUpperCase();
    const kwd = KEYWORD_TRANSLATIONS[raw] ?? raw;
    const parsed = kwd === "CAPTION";
    const dual = kwd === "CAPTION" || kwd === "RESULTS";
    let vb = p + m[0].length;
    let ve = skipB(lep(p), " \t");
    if (ve < vb) [vb, ve] = [ve, vb];
    let dualValue: any;
    if (dual && m[2] !== undefined) {
      const db = p + m[0].indexOf("[") + 1;
      dualValue = parsed ? parseObjects(abs(db), abs(db + m[2].length), undefined, restrict) : m[2];
    }
    let value: any = parsed ? parseObjects(abs(vb), abs(ve), undefined, restrict) : trim(S.slice(vb, ve));
    if (dual) value = { value, secondary: dualValue };
    kw ??= {};
    const prop = kwd.toLowerCase();
    if (kwd === "CAPTION" || kwd === "HEADER" || kwd.startsWith("ATTR_")) (kw[prop] ??= []).push(value);
    else kw[prop] = value;
    p = nextLine(p);
  }
  if (
    kw &&
    (la(re("[ \\t]*$", "ym"), p) || la(re(RX.comment, "ym"), p) || la(re("^[ \\t]*CLOCK:", "ymi"), p) || la(re("^\\*+ ", "ym"), p))
  ) {
    return { aff: { begin: origin }, p: origin };
  }
  return { aff: { begin: origin, kw }, p };
}

type Mode = "first-section" | "item" | "node-property" | "planning" | "property-drawer" | "section" | "table-row" | "top-comment" | undefined;

/** The element at p, as org-element--current-element. */
function currentElement(p: number, limit: number, granularity: string | undefined, mode: Mode, structure: StructItem[] | undefined): Node {
  const raw = granularity !== undefined && granularity !== "object";
  if (mode === "item") return itemParser(p, limit, structure!, raw);
  if (mode === "table-row") return tableRowParser(p);
  if (mode === "node-property") return nodePropertyParser(p);
  // A heading line, an inline task's when org-inlinetask is loaded and it
  // has enough stars, which is parsed further down, as Org's at-task?.
  const atTask = la(re("^\\*+ ", "ym"), p) !== null;
  if (atTask && (P.inlinetask === undefined || skipF(p, "*") - p < P.inlinetask)) return headlineParser(p, raw);
  if (mode === "section" || mode === "first-section") return sectionParser(p);
  if (la(re(RX.comment, "ym"), p)) return commentParser(p, limit);
  const prevStar = S[prevLine(p)] === "*";
  if (mode === "planning" && prevStar && la(re(RX.planningLine, "ym"), p)) return planningParser(p, limit);
  let drawerHere = false;
  if (mode === "planning") drawerHere = prevStar;
  else if (mode === "property-drawer" || mode === "top-comment") {
    const q = skipF(prevLine(p), " \t");
    drawerHere = !eolp(q) || skipB(q, " \t\n\r") === 0;
  }
  if (drawerHere && la(re(RX.propertyDrawer, "yim"), p)) return propertyDrawerParser(p, limit);
  if (!bolp(p)) return paragraphParser(p, limit, { begin: p });
  if (la(re(RX.clockLine, "yim"), p)) return clockParser(p, limit);
  if (atTask) return inlinetaskParser(p, limit, raw);
  const collected = collectAffiliated(p, limit, granularity === undefined || granularity === "object");
  const aff = collected.aff;
  p = collected.p;
  if (aff.kw && p >= limit) return keywordParser(aff.begin, limit, undefined);
  let m: RegExpExecArray | null;
  if (la(re("^[ \\t]*\\\\begin\\{[A-Za-z0-9*]+\\}", "yim"), p)) return latexEnvironmentParser(p, limit, aff);
  if (la(re(RX.drawer, "ymu"), p)) return drawerParser(p, limit, aff);
  if (la(re("[ \\t]*:( |$)", "ym"), p)) return fixedWidthParser(p, limit, aff);
  if (la(re(`^[ \\t]*#\\+BEGIN:[ \\t]*${WORD}`, "yimu"), p)) return dynamicBlockParser(p, limit, aff);
  if ((m = la(re(`[ \\t]*#\\+(?:BEGIN_(${NOT_SPACE}+)|(CALL:)|(${NOT_SPACE}+:))`, "yi"), p))) {
    if (m[1] !== undefined) {
      switch (m[1].toUpperCase()) {
        case "CENTER":
          return greaterBlock("center-block", "CENTER", p, limit, aff);
        case "COMMENT":
          return commentBlockParser(p, limit, aff);
        case "EXAMPLE":
          return exampleBlockParser(p, limit, aff);
        case "EXPORT":
          return exportBlockParser(p, limit, aff);
        case "QUOTE":
          return greaterBlock("quote-block", "QUOTE", p, limit, aff);
        case "SRC":
          return srcBlockParser(p, limit, aff);
        case "VERSE":
          return verseBlockParser(p, limit, aff);
        default:
          return specialBlockParser(p, limit, aff);
      }
    }
    if (m[2] !== undefined) return babelCallParser(p, limit, aff);
    return keywordParser(p, limit, aff);
  }
  if (la(re(RX.footnoteDefinition, "ymui"), p)) return footnoteDefinitionParser(p, limit, aff);
  if (la(re("[ \\t]*-----+[ \\t]*$", "ym"), p)) return horizontalRuleParser(p, limit, aff);
  if (la(re("%%\\(", "y"), p)) return diarySexpParser(p, limit, aff);
  if (la(re("[ \\t]*\\|", "y"), p) || tableElHere(p, limit)) return tableParser(p, limit, aff);
  if (la(P.itemRe, p)) return plainListParser(p, limit, aff, structure ?? listStructAt(p, limit));
  return paragraphParser(p, limit, aff);
}

/** Whether a table.el table starts at p: a full rule, and another at its end. */
function tableElHere(p: number, limit: number): boolean {
  const rule = re("[ \\t]*\\+(?:-+\\+)+[ \\t]*$", "ym");
  if (!la(rule, p)) return false;
  const next = nextLine(p);
  if (!(next < limit)) return false;
  const m = search(re("^[ \\t]*(?:$|[^+| \\t])", "gm"), lep(p), limit);
  if (!m) {
    const q = limit;
    const at = bolp(q) ? prevLine(q) : lbp(q);
    return !!la(rule, at);
  }
  const q = m.index + m[0].length;
  if (lbp(q) === next) return false;
  return !!la(rule, prevLine(q));
}

function nextMode(mode: Mode | "org-data", type: string, parent: boolean): Mode {
  if (parent) {
    switch (type) {
      case "headline":
        return "section";
      case "section":
        return mode === "first-section" ? "top-comment" : "planning";
      case "org-data":
        return "first-section";
      case "inlinetask":
        return "planning";
      case "plain-list":
        return "item";
      case "property-drawer":
        return "node-property";
      case "table":
        return "table-row";
      default:
        return undefined;
    }
  }
  switch (mode) {
    case "item":
      return "item";
    case "node-property":
      return "node-property";
    case "planning":
      return type === "planning" ? "property-drawer" : undefined;
    case "table-row":
      return "table-row";
    case "top-comment":
      return type === "comment" ? "property-drawer" : undefined;
    default:
      return undefined;
  }
}

/** Hidden text, as org-invisible-p with folding only: set while a visible-only parse runs, positions in S. */
let invisible: ((p: number) => number | undefined) | undefined;

function parseElementsInto(beg: number, end: number, mode: Mode, structure: StructItem[] | undefined, granularity: string | undefined, acc: Node): void {
  let p = beg;
  if (granularity === "headline" && !la(re("^\\*+ ", "ym"), p)) {
    const m = search(limitedHeadingRe(), bolp(p) && p < S.length ? p + 1 : p);
    p = m ? m.index : S.length;
  }
  const elements: Node[] = [];
  while (p < end) {
    if (invisible) {
      const visible = invisible(p);
      if (visible !== undefined) {
        p = visible;
        if (eolp(p) && p < S.length) p++;
        continue;
      }
    }
    const el = currentElement(p, end, granularity, mode, structure);
    const type = el.type;
    const cb = el.p["contents-begin"];
    p = Math.max(el.p.end, p + 1);
    if (cb !== undefined) {
      if (
        GREATER_ELEMENTS.includes(type) &&
        (granularity === undefined || granularity === "element" || granularity === "object" || (granularity === "greater-element" && type === "section") || type === "headline")
      ) {
        parseElementsInto(cb, el.p["contents-end"], nextMode(mode, type, true), type === "item" || type === "plain-list" ? el.p.structure : undefined, granularity, el);
      } else if (granularity === undefined || granularity === "object") {
        parseObjects(cb, el.p["contents-end"], el, restriction(type));
      }
    }
    el.parent = acc;
    elements.push(el);
    mode = nextMode(mode, type, false);
  }
  acc.contents = elements;
}

// ----- Objects -----

function emphasis(q: number, mark: string, type: string): Node | undefined {
  const origin = q;
  const at = bolp(q) ? q : q - 1;
  const m = escapeRe(mark);
  if (!la(re(`(?:^|[ \\t\\n\\r\\f\\-('"{])${m}${NOT_SPACE}`, "ym"), at)) return undefined;
  const close = search(re(`${NOT_SPACE}(${m})(?:[ \\t\\n\\r\\f\\-.,;:!?'")}\\\\\\[]|$)`, "gm"), origin + 1);
  if (!close) return undefined;
  const closing = close.index + 2;
  const end = skipF(closing, " \t");
  const cb = origin + 1;
  const ce = closing - 1;
  if (type === "code" || type === "verbatim")
    return node(type, { begin: abs(origin), end: abs(end), "post-blank": end - closing, value: S.slice(cb, ce) });
  return node(type, { begin: abs(origin), end: abs(end), "post-blank": end - closing, "contents-begin": abs(cb), "contents-end": abs(ce) });
}

function citationParser(q: number): Node | undefined {
  const m = la(re(RX.citationPrefix, "yu"), q);
  if (!m) return undefined;
  const begin = q;
  const style = m[1];
  const start = q + m[0].length;
  const closing = closingBracket(begin);
  if (closing === undefined) return undefined;
  const key = search(re(RX.citationKey, "gu"), start, closing);
  if (!key) return undefined;
  const firstKeyEnd = key.index + key[0].length;
  const types = restriction("citation-reference");
  const end = skipF(closing, " \t");
  const cite = node("citation", { style, begin: abs(begin), "post-blank": end - closing, end: abs(end) });
  const semi = S.lastIndexOf(";", firstKeyEnd - 1);
  if (semi < start) cite.p["contents-begin"] = abs(start);
  else {
    if (start < semi) cite.p.prefix = parseObjects(abs(start), abs(semi), undefined, types, cite);
    cite.p["contents-begin"] = abs(semi + 1);
  }
  const last = skipB(closing - 1, BLANK_NL);
  const semi2 = S.lastIndexOf(";", last - 1);
  if (semi2 < firstKeyEnd || search(re(RX.citationKey, "gu"), semi2, last)) cite.p["contents-end"] = abs(last);
  else {
    if (semi2 + 1 < last) cite.p.suffix = parseObjects(abs(semi2 + 1), abs(last), undefined, types, cite);
    cite.p["contents-end"] = abs(semi2 + 1);
  }
  if (!cite.p.prefix?.length) delete cite.p.prefix;
  if (!cite.p.suffix?.length) delete cite.p.suffix;
  return cite;
}

function citationReferenceParser(q: number): Node | undefined {
  const begin = q;
  const key = search(re(RX.citationKey, "gu"), q);
  if (!key) return undefined;
  const keyStart = key.index;
  const keyEnd = key.index + key[0].length;
  const semi = S.indexOf(";", keyEnd);
  const end = semi >= 0 ? semi + 1 : S.length;
  const suffixEnd = semi >= 0 ? end - 1 : end;
  const types = restriction("citation-reference");
  const ref = node("citation-reference", { key: key[1], begin: abs(begin), end: abs(end), "post-blank": 0 });
  if (begin < keyStart) ref.p.prefix = parseObjects(abs(begin), abs(keyStart), undefined, types, ref);
  if (keyEnd < suffixEnd) ref.p.suffix = parseObjects(abs(keyEnd), abs(suffixEnd), undefined, types, ref);
  if (!ref.p.prefix?.length) delete ref.p.prefix;
  if (!ref.p.suffix?.length) delete ref.p.suffix;
  return ref;
}

function entityParser(q: number): Node | undefined {
  const m = la(re("\\\\(?:(_ +)|(there4|sup[123]|frac[13][24]|[a-zA-Z]+)($|\\{\\}|[^\\p{L}]))", "ymu"), q);
  if (!m) return undefined;
  const name = m[1] ?? m[2];
  const e = entityGet(name);
  if (!e) return undefined;
  const brackets = m[3] === "{}";
  const after = q + 1 + name.length + (brackets ? 2 : 0);
  const end = skipF(after, " \t");
  return node("entity", {
    name: e[0],
    latex: e[1],
    "latex-math-p": e[2],
    html: e[3],
    ascii: e[4],
    latin1: e[5],
    "utf-8": e[6],
    begin: abs(q),
    end: abs(end),
    "use-brackets-p": brackets,
    "post-blank": end - after,
  });
}

function exportSnippetParser(q: number): Node | undefined {
  const m = la(re("@@([-A-Za-z0-9]+):", "y"), q);
  if (!m) return undefined;
  const cb = q + m[0].length;
  const ce = S.indexOf("@@", cb);
  if (ce < 0) return undefined;
  const end = skipF(ce + 2, " \t");
  return node("export-snippet", { "back-end": m[1], value: S.slice(cb, ce), begin: abs(q), end: abs(end), "post-blank": end - ce - 2 });
}

function footnoteReferenceParser(q: number): Node | undefined {
  const m = la(re(RX.footnote, "yu"), q);
  if (!m) return undefined;
  const closing = closingBracket(q);
  if (closing === undefined) return undefined;
  const inline = m[2] !== undefined;
  const end = skipF(closing, " \t");
  return node("footnote-reference", {
    label: m[1] ?? m[3],
    type: inline ? "inline" : "standard",
    begin: abs(q),
    end: abs(end),
    "contents-begin": inline ? abs(q + m[0].length) : undefined,
    "contents-end": inline ? abs(closing - 1) : undefined,
    "post-blank": end - closing,
  });
}

function bracketArg(text: string | undefined): string | undefined {
  return nw(text) ? trim(text).replace(/\n[ \t]*/g, " ") : undefined;
}

function inlineBabelCallParser(q: number): Node | undefined {
  const m = la(re(`(?<!${WORD})call_([^ \\t\\n[(]+)[([]`, "yu"), q);
  if (!m) return undefined;
  let p = q + 5 + m[1].length;
  const inside = pairedBrackets(p, "[");
  if (inside) p = inside.end;
  const args = pairedBrackets(p, "(");
  if (!args) return undefined;
  p = args.end;
  const endHeader = pairedBrackets(p, "[");
  if (endHeader) p = endHeader.end;
  const value = S.slice(q, p);
  const end = skipF(p, " \t");
  return node("inline-babel-call", {
    call: m[1],
    "inside-header": bracketArg(inside?.text),
    arguments: nw(args.text) ? args.text : undefined,
    "end-header": bracketArg(endHeader?.text),
    begin: abs(q),
    end: abs(end),
    value,
    "post-blank": end - p,
  });
}

function inlineSrcBlockParser(q: number): Node | undefined {
  const m = la(re(`(?<!${WORD})src_([^ \\t\\n[{]+)[{[]`, "yu"), q);
  if (!m) return undefined;
  let p = q + 4 + m[1].length;
  const params = pairedBrackets(p, "[");
  if (params) p = params.end;
  const value = pairedBrackets(p, "{");
  if (!value) return undefined;
  p = value.end;
  const end = skipF(p, " \t");
  return node("inline-src-block", {
    language: m[1],
    value: value.text,
    parameters: bracketArg(params?.text),
    begin: abs(q),
    end: abs(end),
    "post-blank": end - p,
  });
}

function latexFragmentParser(q: number): Node | undefined {
  let after: number | undefined;
  if (S[q] !== "$") {
    const c = S[q + 1];
    if (c === "(") {
      const i = S.indexOf("\\)", q);
      after = i < 0 ? undefined : i + 2;
    } else if (c === "[") {
      const i = S.indexOf("\\]", q);
      after = i < 0 ? undefined : i + 2;
    } else {
      const m = la(re("\\\\[a-zA-Z]+\\*?(?:(\\[[^\\]\\[\\n{}]*\\])|(\\{[^{}\\n]*\\}))*", "y"), q);
      after = m ? q + m[0].length : undefined;
    }
  } else if (S[q + 1] === "$") {
    const i = S.indexOf("$$", q + 1);
    after = i < 0 ? undefined : i + 2;
  } else if (q > 0 && S[q - 1] === "$") after = undefined;
  else if (" \t\n,.;".includes(S[q + 1] ?? " ") || q + 1 >= S.length) after = undefined;
  else {
    const i = S.indexOf("$", q + 1);
    if (i >= 0 && !" \t\n,.".includes(S[i - 1])) {
      const next = S[i + 1];
      if (next === undefined || next === "\n" || !/[\p{L}\p{N}_\-+*/&|=\\~@]/u.test(next)) after = i + 1;
    }
  }
  if (after === undefined) return undefined;
  const end = skipF(after, " \t");
  return node("latex-fragment", { value: S.slice(q, after), begin: abs(q), end: abs(end), "post-blank": end - after });
}

function lineBreakParser(q: number): Node | undefined {
  if (!la(re("\\\\\\\\[ \\t]*$", "ym"), q) || (q > 0 && S[q - 1] === "\\")) return undefined;
  return node("line-break", { begin: abs(q), end: abs(nextLine(q)), "post-blank": 0 });
}

/** A link with its escapes taken out, as org-link-unescape. */
function linkUnescapeString(link: string): string {
  return link.replace(/(\\+)(?=[\][]|$)/g, (bs: string) => "\\".repeat(Math.floor(bs.length / 2)));
}

/** A link with its abbreviation expanded, as org-link-expand-abbrev. */
function linkExpandAbbrev(link: string): string {
  const m = /^([^:]*)(::?(.*))?$/.exec(link);
  if (!m) return link;
  const as = P.abbrevs.find(([k]) => k === m[1]);
  if (!as) return link;
  const tag = m[2] === undefined ? undefined : m[3];
  const rpl = as[1];
  if (rpl.includes("%s")) return rpl.replace("%s", tag ?? "");
  if (rpl.includes("%h")) return rpl.replace("%h", encodeURIComponent(tag ?? ""));
  return rpl + (tag ?? "");
}

function linkParser_(q: number): Node | undefined {
  const begin = q;
  let type: string;
  let path: string;
  let format: string;
  let rawLink: string | undefined;
  let cb: number | undefined;
  let ce: number | undefined;
  let linkEnd: number;
  let explicit = false;
  let m: RegExpExecArray | null = null;
  if (P.radioRe && (m = la(P.radioRe, bolp(q) ? q : q - 1))) {
    type = "radio";
    format = "plain";
    const start = m.index + m[1].length;
    linkEnd = start + m[2].length;
    path = m[2];
    cb = start;
    ce = linkEnd;
  } else if ((m = la(re(RX.linkBracket, "y"), q))) {
    format = "bracket";
    if (m[2] !== undefined) {
      cb = q + m[0].length - 1 - m[2].length - 1;
      ce = cb + m[2].length;
    }
    linkEnd = q + m[0].length;
    rawLink = linkExpandAbbrev(linkUnescapeString(m[1].replace(/[ \t]*\n[ \t]*/g, " ")));
    let t: RegExpExecArray | null;
    if (rawLink.startsWith("/") || rawLink.startsWith("~") || /^\.\.?\//.test(rawLink)) {
      type = "file";
      path = rawLink;
    } else if ((t = P.typesRe.exec(rawLink))) {
      type = t[1];
      explicit = true;
      path = rawLink.slice(t[0].length);
    } else if (rawLink.startsWith("(") && rawLink.endsWith(")")) {
      type = "coderef";
      path = rawLink.slice(1, -1);
    } else if (rawLink.startsWith("#")) {
      type = "custom-id";
      path = rawLink.slice(1);
    } else {
      type = "fuzzy";
      path = rawLink;
    }
  } else if ((m = la(P.plainRe, q))) {
    format = "plain";
    rawLink = m[0];
    type = m[1];
    explicit = true;
    linkEnd = q + m[0].length;
    path = m[2];
  } else if ((m = la(P.angleRe, q))) {
    format = "angle";
    type = m[1];
    explicit = true;
    linkEnd = q + m[0].length;
    rawLink = S.slice(q + 1, linkEnd - 1);
    path = m[2].replace(/[ \t]*\n[ \t]*/g, "");
  } else return undefined;
  const end = skipF(linkEnd, " \t");
  let application: string | undefined;
  let searchOption: string | undefined;
  const f = /^file(?:\+(.+))?$/i.exec(type);
  if (f) {
    application = f[1];
    type = "file";
    const so = /::([^\n]*)$/.exec(path);
    if (so) {
      searchOption = so[1];
      path = path.slice(0, so.index);
    }
    path = path.replace(/^\/\/\/*(.:)?\//, "$1/");
  }
  return node("link", {
    type,
    "type-explicit-p": explicit,
    path,
    format,
    "raw-link": rawLink ?? path,
    application,
    "search-option": searchOption,
    begin: abs(begin),
    end: abs(end),
    "contents-begin": cb === undefined ? undefined : abs(cb),
    "contents-end": ce === undefined ? undefined : abs(ce),
    "post-blank": end - linkEnd,
  });
}

/** Macro arguments split at their commas, escaped ones kept, as org-macro-extract-arguments. */
export function macroExtractArguments(s: string): string[] {
  return s
    .replace(/(\\*),/g, (_all, bs: string) => "\\".repeat(Math.floor(bs.length / 2)) + (bs.length % 2 === 0 ? "\0" : ","))
    .split("\0");
}

/** Macro arguments joined with commas, escaped, as org-macro-escape-arguments. */
export function macroEscapeArguments(...args: string[]): string {
  let s = "";
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    const trailing = s !== "" ? /\\+$/.exec(arg)?.[0] ?? "" : "";
    s = "," + (arg + trailing).replace(/(\\*),/g, (_all, bs: string) => "\\".repeat(1 + 2 * bs.length) + ",") + s;
  }
  return s.slice(1);
}

function macroParser(q: number): Node | undefined {
  const m = la(re("\\{\\{\\{([a-zA-Z][-a-zA-Z0-9_]*)(\\(([\\s\\S]*?)\\))?\\}\\}\\}", "y"), q);
  if (!m) return undefined;
  const after = q + m[0].length;
  const end = skipF(after, " \t");
  return node("macro", {
    key: m[1].toLowerCase(),
    value: m[0],
    args: m[3] === undefined ? undefined : macroExtractArguments(trim(m[3]).replace(/[ \t\r\n]+/g, " ")),
    begin: abs(q),
    end: abs(end),
    "post-blank": end - after,
  });
}

function radioTargetParser(q: number): Node | undefined {
  const m = la(re(RX.radioTarget, "y"), q);
  if (!m) return undefined;
  const after = q + m[0].length;
  const end = skipF(after, " \t");
  return node("radio-target", {
    begin: abs(q),
    end: abs(end),
    "contents-begin": abs(q + 3),
    "contents-end": abs(q + 3 + m[1].length),
    "post-blank": end - after,
    value: m[1],
  });
}

function statisticsCookieParser(q: number): Node | undefined {
  const m = la(re("\\[[0-9]*(%|/[0-9]*)\\]", "y"), q);
  if (!m) return undefined;
  const after = q + m[0].length;
  const end = skipF(after, " \t");
  return node("statistics-cookie", { begin: abs(q), end: abs(end), value: m[0], "post-blank": end - after });
}

function scriptParser(q: number, type: string): Node | undefined {
  if (type === "subscript" && bolp(q)) return undefined;
  const at = bolp(q) ? q : q - 1;
  const m = la(re(RX.substring, "yu"), at);
  if (!m) return undefined;
  const begin = at + m[1].length;
  const after = at + m[0].length;
  const brackets = m[4] !== undefined;
  const scriptStart = begin + 1;
  const cb = brackets ? scriptStart + 1 : scriptStart;
  const ce = brackets ? cb + m[4].length : scriptStart + m[3].length;
  const end = skipF(after, " \t");
  return node(type, {
    begin: abs(begin),
    end: abs(end),
    "use-brackets-p": brackets,
    "contents-begin": abs(cb),
    "contents-end": abs(ce),
    "post-blank": end - after,
  });
}

function tableCellParser(q: number): Node {
  const m = la(re("[ \\t]*([^\\n]*?)[ \\t]*(?:\\||$)", "ym"), q)!;
  const cb = q + /^[ \t]*/.exec(m[0])![0].length;
  return node("table-cell", {
    begin: abs(q),
    end: abs(q + m[0].length),
    "contents-begin": abs(cb),
    "contents-end": abs(cb + m[1].length),
    "post-blank": 0,
  });
}

function targetParser(q: number): Node | undefined {
  const m = la(re(RX.target, "y"), q);
  if (!m) return undefined;
  const after = q + m[0].length;
  const end = skipF(after, " \t");
  return node("target", { begin: abs(q), end: abs(end), value: m[1], "post-blank": end - after });
}

const TS_ELEMENT = `${RX.tsBoth}|(?:<[0-9]+-[0-9]+-[0-9]+[^>\\n]+?\\+[0-9]+[dwmy]>)|(?:<%%(?:\\([^>\\n]+\\))([^\\n>]*)>)`;
const TS_RAW = `([<[](%%)?[^\\n]*?)[\\]>](?:--(${RX.tsBoth}))?`;
const UNITS: { [c: string]: string } = { h: "hour", d: "day", w: "week", m: "month", y: "year" };

/** A date and time in a timestamp, as org-parse-time-string with NODEFAULT: year, month, day, and hour and minute when written. */
function parseTimeString(s: string): [number, number, number, number | undefined, number | undefined] | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})( +[^\]+0-9>\r\n -]+)?( +(\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[6] === undefined ? undefined : Number(m[6]), m[7] === undefined ? undefined : Number(m[7])];
}

function timestampParser(q: number): Node | undefined {
  if (!la(re(TS_ELEMENT, "y"), q)) return undefined;
  const raw = la(re(TS_RAW, "y"), q)!;
  const active = S[q] === "<";
  const rawValue = raw[0];
  const diary = raw[2] !== undefined;
  let diarySexp: string | undefined;
  let dateStart: string;
  if (diary) {
    const d = la(re(TS_ELEMENT, "y"), q)!;
    const g2 = d[2] ?? "";
    const g2Start = q + d[0].length - 1 - g2.length;
    diarySexp = S.slice(q + 3, g2Start);
    dateStart = g2;
  } else dateStart = raw[1];
  const dateEnd = raw[3];
  const after = q + raw[0].length;
  const end = skipF(after, " \t");
  const tr = /[012]?[0-9]:[0-5][0-9](-([012]?[0-9]):([0-5][0-9]))/.exec(dateStart);
  const timeRange = tr ? [Number(tr[2]), Number(tr[3])] : undefined;
  const type = diary ? "diary" : active && (dateEnd || timeRange) ? "active-range" : active ? "active" : dateEnd || timeRange ? "inactive-range" : "inactive";
  const props: { [name: string]: any } = {
    type,
    "range-type": dateEnd ? "daterange" : timeRange ? "timerange" : undefined,
    "raw-value": rawValue,
  };
  if (!diary) {
    const s = parseTimeString(dateStart);
    if (s) [props["year-start"], props["month-start"], props["day-start"], props["hour-start"], props["minute-start"]] = s;
    const e = dateEnd ? parseTimeString(dateEnd) : undefined;
    props["year-end"] = e?.[0] ?? props["year-start"];
    props["month-end"] = e?.[1] ?? props["month-start"];
    props["day-end"] = e?.[2] ?? props["day-start"];
    props["hour-end"] = e?.[3] ?? timeRange?.[0] ?? props["hour-start"];
    props["minute-end"] = e?.[4] ?? timeRange?.[1] ?? props["minute-start"];
  } else {
    const t = /([012]?[0-9]):([0-5][0-9])(-([012]?[0-9]):([0-5][0-9]))?/.exec(dateStart);
    if (t) {
      props["hour-start"] = Number(t[1]);
      props["minute-start"] = Number(t[2]);
      if (t[4] !== undefined) props["hour-end"] = Number(t[4]);
      if (t[5] !== undefined) props["minute-end"] = Number(t[5]);
    }
  }
  props.begin = abs(q);
  props.end = abs(end);
  props["post-blank"] = end - after;
  if (diarySexp !== undefined) props["diary-sexp"] = diarySexp;
  if (!diary) {
    const r = /(\+\+|\.\+|\+)(\d+)([hdwmy])(?:\/(\d+)([hdwmy]))?/.exec(rawValue);
    if (r) {
      props["repeater-type"] = r[1] === "++" ? "catch-up" : r[1] === ".+" ? "restart" : "cumulate";
      props["repeater-value"] = Number(r[2]);
      props["repeater-unit"] = UNITS[r[3]];
      if (r[4] !== undefined) {
        props["repeater-deadline-value"] = Number(r[4]);
        props["repeater-deadline-unit"] = UNITS[r[5]];
      }
    }
    const w = /(-)?-(\d+)([hdwmy])/.exec(rawValue);
    if (w) {
      props["warning-type"] = w[1] ? "first" : "all";
      props["warning-value"] = Number(w[2]);
      props["warning-unit"] = UNITS[w[3]];
    }
  }
  return node("timestamp", props);
}

/** The next object from q among `allowed`, as org-element--object-lex. */
function objectLex(q: number, allowed: string[]): Node | undefined {
  if (!allowed.length) return undefined;
  if (allowed.includes("table-cell")) return tableCellParser(q);
  if (allowed.includes("citation-reference")) return citationReferenceParser(q);
  let limit: number | undefined;
  if (P.radioRe && allowed.includes("link")) {
    const r = new RegExp(P.radioRe.source, "gimu");
    const from = bolp(q) ? q : q - 1;
    const m = search(r, from);
    if (m) {
      const g1 = m.index + m[1].length;
      if (q === lbp(q) + 1 && q === g1 + m[2].length) {
        const m2 = search(r, m.index + m[0].length);
        limit = m2 ? m2.index + m2[1].length + 1 : undefined;
      } else limit = g1 + 1;
    }
  }
  const objectRe = P.objectRe;
  let p = q;
  for (;;) {
    const m = search(objectRe, p, limit ?? S.length);
    if (!m) break;
    const at = m.index;
    const found = tryObject(at, m[0], allowed);
    if (found) return found;
    p = at + 1;
    if (p > S.length) break;
  }
  if (limit !== undefined) return linkParser_(limit - 1);
  return undefined;
}

function tryObject(at: number, result: string, allowed: string[]): Node | undefined {
  const has = (t: string) => allowed.includes(t);
  const lower = result.toLowerCase();
  if (lower.startsWith("call_")) return has("inline-babel-call") ? inlineBabelCallParser(at) : undefined;
  if (lower.startsWith("src_")) return has("inline-src-block") ? inlineSrcBlockParser(at) : undefined;
  switch (S[at]) {
    case "^":
      return has("superscript") ? scriptParser(at, "superscript") : undefined;
    case "_":
      return (has("underline") ? emphasis(at, "_", "underline") : undefined) ?? (has("subscript") ? scriptParser(at, "subscript") : undefined);
    case "*":
      return has("bold") ? emphasis(at, "*", "bold") : undefined;
    case "/":
      return has("italic") ? emphasis(at, "/", "italic") : undefined;
    case "~":
      return has("code") ? emphasis(at, "~", "code") : undefined;
    case "=":
      return has("verbatim") ? emphasis(at, "=", "verbatim") : undefined;
    case "+":
      return has("strike-through") ? emphasis(at, "+", "strike-through") : undefined;
    case "@":
      return has("export-snippet") ? exportSnippetParser(at) : undefined;
    case "{":
      return has("macro") ? macroParser(at) : undefined;
    case "$":
      return has("latex-fragment") ? latexFragmentParser(at) : undefined;
    case "<":
      if (result[1] === "<") return (has("radio-target") ? radioTargetParser(at) : undefined) ?? (has("target") ? targetParser(at) : undefined);
      return (has("timestamp") ? timestampParser(at) : undefined) ?? (has("link") ? linkParser_(at) : undefined);
    case "\\":
      if (result[1] === "\\") return has("line-break") ? lineBreakParser(at) : undefined;
      return (has("entity") ? entityParser(at) : undefined) ?? (has("latex-fragment") ? latexFragmentParser(at) : undefined);
    case "[":
      if (result[1] === "[") return has("link") ? linkParser_(at) : undefined;
      if (result[1] === "f" && has("footnote-reference")) return footnoteReferenceParser(at);
      if (result[1] === "c" && has("citation")) return citationParser(at);
      if ((result[1] === "%" || result[1] === "/") && has("statistics-cookie")) return statisticsCookieParser(at);
      return (has("timestamp") ? timestampParser(at) : undefined) ?? (has("statistics-cookie") ? statisticsCookieParser(at) : undefined);
    default:
      return has("link") ? linkParser_(at) : undefined;
  }
}

/**
 * The objects between beg and end, positions in the whole text, as
 * org-element--parse-objects: the contents of `acc` when given, else a
 * secondary string whose objects have `parent` as theirs.
 */
function parseObjects(beg: number, end: number, acc: Node | undefined, allowed: string[], parent?: Node): Datum[] {
  if (end < beg) {
    // Org narrows to the blanks between, left of point, and takes the
    // empty text from point to END, as a title of tags alone gets.
    const empty = [""];
    if (acc) acc.contents = empty;
    return empty;
  }
  const savedS = S;
  const savedOff = OFF;
  S = savedS.slice(beg - OFF, end - OFF);
  OFF = beg;
  sliced.clear();
  const contents: Datum[] = [];
  try {
    let q = 0;
    while (q < S.length) {
      const next = objectLex(q, allowed);
      if (!next) break;
      const objBeg = next.p.begin - OFF;
      if (q !== objBeg) contents.push(S.slice(q, objBeg));
      next.parent = acc ?? parent;
      const cb = next.p["contents-begin"];
      if (cb !== undefined) parseObjects(cb, next.p["contents-end"], next, restriction(next.type));
      contents.push(next);
      q = Math.max(next.p.end - OFF, q + 1);
    }
    if (q < S.length) contents.push(S.slice(q));
  } finally {
    S = savedS;
    OFF = savedOff;
    sliced.clear();
  }
  if (acc) acc.contents = contents;
  return contents;
}

const MINIMAL_SET = ["bold", "code", "entity", "italic", "latex-fragment", "strike-through", "subscript", "superscript", "underline", "verbatim"];
const STANDARD_SET = ALL_OBJECTS.filter((t) => t !== "citation-reference" && t !== "table-cell");
const STANDARD_NO_LINE_BREAK = STANDARD_SET.filter((t) => t !== "line-break");
const STANDARD_FOR_CITATIONS = STANDARD_NO_LINE_BREAK.filter((t) => !["citation", "citation-reference", "footnote-reference", "link"].includes(t));

/** The objects each type may contain, as org-element-object-restrictions. */
export const OBJECT_RESTRICTIONS: { [type: string]: string[] } = {
  bold: STANDARD_SET,
  citation: ["citation-reference"],
  "citation-reference": STANDARD_FOR_CITATIONS,
  "footnote-reference": STANDARD_SET,
  headline: STANDARD_NO_LINE_BREAK,
  inlinetask: STANDARD_NO_LINE_BREAK,
  italic: STANDARD_SET,
  item: STANDARD_NO_LINE_BREAK,
  keyword: STANDARD_SET.filter((t) => t !== "footnote-reference"),
  link: ["export-snippet", "inline-babel-call", "inline-src-block", "macro", "statistics-cookie", ...MINIMAL_SET],
  paragraph: STANDARD_SET,
  "radio-target": MINIMAL_SET,
  "strike-through": STANDARD_SET,
  subscript: STANDARD_SET,
  superscript: STANDARD_SET,
  "table-cell": ["citation", "export-snippet", "footnote-reference", "link", "macro", "radio-target", "target", "timestamp", ...MINIMAL_SET],
  "table-row": ["table-cell"],
  underline: STANDARD_SET,
  "verse-block": STANDARD_SET,
};

/** The objects a type may contain, as org-element-restriction: none for a type not listed. */
export function restriction(type: string | Node): string[] {
  return OBJECT_RESTRICTIONS[typeof type === "string" ? type : type.type] ?? [];
}

// ----- Positions -----

const POSITION_PROPS = ["begin", "end", "contents-begin", "contents-end", "post-affiliated"];

/** Every position in the tree made a buffer position: `toBuffer` of each, each list structure once. */
function convertPositions(root: Datum | Datum[], toBuffer: (i: number) => number): void {
  const structures = new Set<StructItem[]>();
  const visit = (d: any): void => {
    if (d === undefined || d === null || typeof d === "string") return;
    if (Array.isArray(d)) {
      for (const x of d) visit(x);
      return;
    }
    if (typeof d !== "object") return;
    if (!("type" in d)) {
      visit(d.value);
      visit(d.secondary);
      return;
    }
    const n = d as Node;
    for (const k of POSITION_PROPS) if (typeof n.p[k] === "number") n.p[k] = toBuffer(n.p[k]);
    const st = n.p.structure as StructItem[] | undefined;
    if (st && !structures.has(st)) {
      structures.add(st);
      for (const it of st) {
        it[0] = toBuffer(it[0]);
        it[6] = toBuffer(it[6]);
      }
    }
    for (const k of ["title", "tag", "prefix", "suffix", "caption", "scheduled", "deadline", "closed"]) visit(n.p[k]);
    if (n.type === "clock" || n.type === "planning") visit(n.p.value);
    for (const c of n.contents) visit(c);
  };
  visit(root);
}

/** A function from an index into `text` to a buffer position, as e8 counts characters, the text starting at `base`. */
function positionsOf(text: string, base: number): (i: number) => number {
  const pairs: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        pairs.push(i + 1);
        i++;
      }
    }
  }
  if (!pairs.length) return (i) => base + i;
  return (i) => {
    // The pairs whose second half is before i.
    let lo = 0;
    let hi = pairs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return base + i - lo;
  };
}

/** The index into `text` of a buffer position, the inverse of positionsOf. */
function indexOf_(text: string, base: number, pos: number): number {
  let n = base;
  let i = 0;
  while (i < text.length && n < pos) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
    n++;
  }
  return i;
}

/** Run `body` with `text` as the text parsed, from `settingsText`'s settings. */
let lastSettings: { key: string; settings: ParseSettings } | undefined;

/** Forget the settings kept for the last buffer parsed, as when the exporter kills a buffer whose name may be used again. */
export function forgetSettings(): void {
  lastSettings = undefined;
}

/**
 * The current buffer's settings, made again only when its text, its
 * narrowing or the settings read from elsewhere have changed since, as
 * the exporter parses many strings in one buffer.
 */
function bufferSettings(): ParseSettings {
  const fs = e8.variable("org-footnote-section");
  const key = [
    e8.bufferName(),
    e8.bufferCharsModifiedTick(),
    e8.pointMin(),
    e8.pointMax(),
    allKeywords().join(" "),
    typeof fs === "string" ? fs : "",
    linkTypeEntries().length,
    String(e8.variable("org-plain-list-ordered-item-terminator")),
    String(e8.variable("org-list-allow-alphabetical")),
    String(e8.variable("org-odd-levels-only")),
    String(inlinetaskStars()),
  ].join("\0");
  if (lastSettings?.key !== key) lastSettings = { key, settings: settings(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())) };
  return lastSettings.settings;
}

function withText<T>(text: string, body: () => T, made: () => ParseSettings = () => settings(text)): T {
  const savedS = S;
  const savedOff = OFF;
  const savedP = P;
  const savedInvisible = invisible;
  S = text;
  OFF = 0;
  P = made();
  invisible = undefined;
  sliced.clear();
  try {
    return body();
  } finally {
    S = savedS;
    OFF = savedOff;
    P = savedP;
    invisible = savedInvisible;
    sliced.clear();
  }
}

/** The buffer's category, as org-element--get-category: its last #+CATEGORY, or its file's name without the extension. */
function categoryOf(text: string): string | undefined {
  let category: string | undefined;
  for (const m of allMatches(/^[ \t]*#\+CATEGORY:[ \t]*(.*?)[ \t]*$/gim, text)) category = m[1];
  if (category !== undefined) return category;
  const v = e8.variable("org-category");
  if (typeof v === "string") return v;
  if (typeof v === "symbol") return e8.symbolName(v);
  const file = e8.bufferFileName();
  return file === undefined ? undefined : e8.fileNameNondirectory(file).replace(/\.[^.]*$/, "");
}

/**
 * The accessible part of the current buffer parsed, as
 * org-element-parse-buffer: an "org-data" node holding its elements and
 * objects. GRANULARITY stops it at headlines, at greater elements, at
 * elements, or goes down to objects (the default); visibleOnly leaves out
 * folded text.
 */
export function parseBuffer(granularity?: "headline" | "greater-element" | "element" | "object", visibleOnly = false): Node {
  const base = e8.pointMin();
  const text = e8.bufferSubstringNoProperties(base, e8.pointMax());
  return withText(text, () => {
    const position = positionsOf(S, base);
    if (visibleOnly)
      invisible = (p: number) => {
        const pos = position(p);
        if (!e8.invisibleAt(pos)) return undefined;
        const next = e8.nextSingleCharPropertyChange(pos, "invisible", e8.pointMax());
        return indexOf_(S, base, next);
      };
    const cb = lbp(skipF(0, " \t\n\r"));
    const data = node("org-data", {
      begin: 0,
      "contents-begin": cb,
      "contents-end": S.length,
      end: S.length,
      "post-blank": 0,
      "post-affiliated": 0,
    });
    // The properties of the whole document, from a drawer before any heading.
    let q = lbp(skipF(0, " \t\n\r"));
    while (la(re(RX.comment, "ym"), q) && q < S.length) q = nextLine(q);
    const props = nodeProperties(q, true);
    if (props) Object.assign(data.p, props);
    if (data.p.CATEGORY === undefined) {
      const c = categoryOf(text);
      if (c !== undefined) data.p.CATEGORY = c;
    }
    const path = e8.bufferFileName();
    if (path !== undefined) data.p.path = path;
    parseElementsInto(lbp(skipF(0, " \t\n\r")), S.length, "first-section", undefined, granularity === "object" ? undefined : granularity, data);
    convertPositions(data, positionsOf(text, base));
    return data;
  });
}

/**
 * The objects in STRING, as org-element-parse-secondary-string: only those
 * of `allowed`, their parent `parent`. Positions count from 0 in STRING.
 */
export function parseSecondaryString(s: string, allowed: string[], parent?: Node): Datum[] {
  if (!s) return [];
  return withText(
    s,
    () => {
      const out = parseObjects(0, s.length, undefined, allowed, parent);
      convertPositions(out, positionsOf(s, 0));
      return out;
    },
    bufferSettings,
  );
}

/** A link written out as TEXT parsed, as org-element-link-parser at the start of a buffer holding it, or undefined when it is none. */
export function linkParser(text: string): Node | undefined {
  return withText(text, () => {
    const n = linkParser_(0);
    if (!n) return undefined;
    const cb = n.p["contents-begin"];
    if (cb !== undefined) parseObjects(cb, n.p["contents-end"], n, restriction("link"));
    convertPositions(n, positionsOf(text, 0));
    return n;
  });
}

// ----- Interpreters -----

function boolVar(name: string): boolean {
  return on(e8.variable(name));
}

function numberVar(name: string, fallback: number): number {
  const v = e8.variable(name);
  return typeof v === "number" ? v : fallback;
}

/** Code without the indentation its lines share, as org-remove-indentation. */
export function removeIndentation(code: string): string {
  const lines = code.split("\n");
  const width = (l: string) => {
    let col = 0;
    for (const c of l) {
      if (c === " ") col++;
      else if (c === "\t") col = (Math.floor(col / 8) + 1) * 8;
      else break;
    }
    return col;
  };
  let min = Infinity;
  for (const l of lines) if (/\S/.test(l)) min = Math.min(min, width(l));
  if (min === Infinity || min === 0) return code;
  const out: string[] = [];
  for (const l of lines) {
    const w = width(l);
    const lead = /^[ \t]*/.exec(l)![0];
    if (w < min) {
      if (lead.length === l.length) out.push("");
      else return code;
    } else out.push(indentTo(w - min) + l.slice(lead.length));
  }
  return out.join("\n");
}

/** White space reaching column n, tabs then spaces, as indent-to makes it with indent-tabs-mode. */
function indentTo(n: number): string {
  return "\t".repeat(Math.floor(n / 8)) + " ".repeat(n % 8);
}

/** Whether a block keeps its code's indentation, as org-src-preserve-indentation-p. */
function preserveIndentation(n: Node): boolean {
  return boolVar("org-src-preserve-indentation") || on(n.p["preserve-indent"]);
}

function blockCode(n: Node): string {
  const val: string = n.p.value ?? "";
  if (preserveIndentation(n)) return val;
  const ind = numberVar("org-edit-src-content-indentation", 2);
  if (ind === 0) return removeIndentation(val);
  return removeIndentation(val).replace(/^[ \t]*\S/gm, (s) => " ".repeat(ind) + s);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A date as a timestamp writes it, without brackets, as org-time-stamp-format with format-time-string. */
function formatDate(y: number, m: number, d: number, h?: number, min?: number): string {
  const date = new Date(Date.UTC(y, m - 1, d, h ?? 0, min ?? 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${WEEKDAYS[date.getUTCDay()]}`;
  return h !== undefined && min !== undefined ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : day;
}

const UNIT_CHARS: { [u: string]: string } = { hour: "h", day: "d", week: "w", month: "m", year: "y" };

/** A timestamp written out, as org-element-timestamp-interpreter. */
export function interpretTimestamp(ts: Node): string {
  const p = ts.p;
  const type = p.type;
  if (!((p["day-start"] && p["month-start"] && p["year-start"]) || type === "diary")) return "";
  const repeat = ({ cumulate: "+", "catch-up": "++", restart: ".+" } as { [k: string]: string })[p["repeater-type"]] ?? "";
  const repeatString =
    repeat +
    (p["repeater-value"] !== undefined ? String(p["repeater-value"]) : "") +
    (UNIT_CHARS[p["repeater-unit"]] ?? "") +
    (p["repeater-deadline-value"] !== undefined && p["repeater-deadline-unit"] !== undefined
      ? `/${p["repeater-deadline-value"]}${UNIT_CHARS[p["repeater-deadline-unit"]] ?? ""}`
      : "");
  const warningString =
    (p["warning-type"] === "first" ? "--" : p["warning-type"] === "all" ? "-" : "") +
    (p["warning-value"] !== undefined ? String(p["warning-value"]) : "") +
    (UNIT_CHARS[p["warning-unit"]] ?? "");
  const hs = p["hour-start"];
  const ms = p["minute-start"];
  const [open, close] = type === "inactive" || type === "inactive-range" ? ["[", "]"] : ["<", ">"];
  const tsEnd = (nw(repeatString) ? " " + repeatString : "") + (nw(warningString) ? " " + warningString : "") + close;
  const pad = (n: number) => String(n).padStart(2, "0");
  let s = open;
  if (type === "diary") s += "%%" + (p["diary-sexp"] ?? "") + (ms !== undefined && hs !== undefined ? ` ${pad(hs)}:${pad(ms)}` : "");
  else s += formatDate(p["year-start"], p["month-start"], p["day-start"], ms !== undefined && hs !== undefined ? hs : undefined, ms !== undefined && hs !== undefined ? ms : undefined);
  const he = p["hour-end"];
  const me = p["minute-end"];
  const range = p["range-type"];
  if (type === "active" || type === "inactive") {
    if (range === undefined && hs !== undefined && he !== undefined && ms !== undefined && me !== undefined && (hs !== he || ms !== me)) s += `-${pad(he)}:${pad(me)}`;
  } else if (type === "active-range" || type === "inactive-range" || (type === "diary" && range === "timerange")) {
    if (range === "timerange") s += `-${pad(he ?? hs)}:${pad(me ?? ms)}`;
    else {
      s +=
        tsEnd +
        "--" +
        open +
        formatDate(
          p["year-end"] ?? p["year-start"],
          p["month-end"] ?? p["month-start"],
          p["day-end"] ?? p["day-start"],
          me !== undefined && he !== undefined ? he : undefined,
          me !== undefined && he !== undefined ? me : undefined,
        );
    }
  }
  return s + tsEnd;
}

function tagsString(tags: string[] | undefined): string | undefined {
  return tags && tags.length ? `:${tags.join(":")}:` : undefined;
}

function alignTags(heading: string, tags: string): string {
  const column = numberVar("org-tags-column", -77);
  if (column === 0) return ` ${tags}`;
  if (column < 0) return " ".repeat(Math.max(-(column + heading.length + tags.length), 1)) + tags;
  return " ".repeat(Math.max(column - heading.length, 1)) + tags;
}

/** The format string %-10s %s applied, as org-property-format with format. */
function propertyFormat(key: string, value: string): string {
  const f = e8.variable("org-property-format");
  const fmt = typeof f === "string" ? f : "%-10s %s";
  let i = 0;
  const args = [key, value];
  return fmt.replace(/%(-?)(\d*)s/g, (_all, left: string, width: string) => {
    const a = args[i++] ?? "";
    const w = width ? Number(width) : 0;
    return left ? a.padEnd(w) : a.padStart(w);
  });
}

/**
 * A list's items written out with the bullets org-list-repair gives them:
 * each item at the left margin takes the first item's kind of bullet,
 * numbered in order (from a counter where an item gives one) when that is
 * a number, and the item's other lines move with its bullet's width.
 */
function repairList(contents: string): string {
  const lines = contents.split("\n");
  const ITEM = /^([-+*]|[0-9]+([.)]))( +)(\[@([0-9]+)\] )?/;
  const first = lines.map((l) => ITEM.exec(l)).find((m) => m);
  if (!first) return contents;
  const ordered = first[2] !== undefined;
  const term = first[2] ?? "";
  let n = 0;
  let delta = 0;
  return lines
    .map((line) => {
      const m = ITEM.exec(line);
      if (!m) {
        if (delta > 0 && line !== "") return " ".repeat(delta) + line;
        if (delta < 0) return line.replace(new RegExp(`^ {0,${-delta}}`), "");
        return line;
      }
      n = m[5] !== undefined ? Number(m[5]) : n + 1;
      const bullet = (ordered ? `${n}${term}` : first[1]) + " ";
      const old = m[1] + m[3];
      delta = bullet.length - old.length;
      return bullet + line.slice(old.length);
    })
    .join("\n");
}

/** NODE written out as Org syntax with its contents already written, as its type's org-element-TYPE-interpreter. */
export function interpretNode(n: Node, contents: string | undefined): string {
  const p = n.p;
  const c = contents ?? "";
  // What Org's interpreters that format CONTENTS with %s write for none.
  const f = contents ?? "nil";
  switch (n.type) {
    case "center-block":
      return `#+begin_center\n${f}#+end_center`;
    case "drawer":
      return `:${p["drawer-name"]}:\n${f}:END:`;
    case "dynamic-block":
      return `#+begin: ${p["block-name"]}${p.arguments ? " " + p.arguments : ""}\n${f}#+end:`;
    case "footnote-definition": {
      const pre = Math.min(p["pre-blank"] ?? 1, 2);
      return `[fn:${p.label}]` + (pre === 0 ? " " + trim(c) : "\n".repeat(pre) + c);
    }
    case "headline":
    case "inlinetask": {
      const level: number = p.level;
      const title = interpretData(p.title ?? []);
      const tags = tagsString(p.tags);
      if (n.type === "inlinetask") {
        const task = "*".repeat(level) + (p["todo-keyword"] ? " " + p["todo-keyword"] : "") + (p.priority ? ` [#${String.fromCodePoint(p.priority)}]` : "") + (title ? " " + title : "");
        return task + (tags ? alignTags(task, tags) : "") + (contents ? "\n" + contents + "*".repeat(level) + " end" : "");
      }
      const fs = e8.variable("org-footnote-section");
      const heading =
        "*".repeat(boolVar("org-odd-levels-only") ? level * 2 - 1 : level) +
        (p["todo-keyword"] ? " " + p["todo-keyword"] : "") +
        (p.commentedp ? " COMMENT" : "") +
        (p.priority ? ` [#${String.fromCodePoint(p.priority)}]` : "") +
        " " +
        (typeof fs === "string" && p["footnote-section-p"] ? fs : title);
      return heading + (tags ? alignTags(heading, tags) : "") + "\n".repeat((p["pre-blank"] ?? 0) + 1) + c;
    }
    case "item": {
      const tag = p.tag === undefined ? undefined : `${interpretData(p.tag)} :: `;
      const term = e8.variable("org-plain-list-ordered-item-terminator");
      const bullet = bulletString(!/[0-9a-zA-Z]/.test(p.bullet) ? "- " : term === 41 || term === ")" ? "1)" : "1.");
      const box = p.checkbox === "on" ? "[X] " : p.checkbox === "off" ? "[ ] " : p.checkbox === "trans" ? "[-] " : "";
      let s = bullet + (p.counter !== undefined ? `[@${p.counter}] ` : "") + box + (tag ?? "");
      if (contents) {
        const ind = " ".repeat(tag ? 5 : bullet.length);
        const pre = Math.min(p["pre-blank"] ?? 1, 2);
        const body = contents.replace(/^(?=[ \t]*\S)/gm, ind);
        s += pre === 0 ? trim(body) : "\n".repeat(pre) + body;
      }
      return s;
    }
    case "plain-list":
      return repairList(c);
    case "property-drawer":
      return `:PROPERTIES:\n${f}:END:`;
    case "quote-block":
      return `#+begin_quote\n${f}#+end_quote`;
    case "section":
    case "org-data":
    case "paragraph":
      return c;
    case "special-block":
      return `#+begin_${p.type}${p.parameters ? " " + p.parameters : ""}\n${c}#+end_${p.type}`;
    case "babel-call":
      return `#+call: ${p.call}${p["inside-header"] ? `[${p["inside-header"]}]` : ""}(${p.arguments ?? ""})${p["end-header"] ? " " + p["end-header"] : ""}`;
    case "clock": {
      const d: string | undefined = p.duration;
      return (
        "CLOCK: " +
        interpretTimestamp(p.value) +
        (d ? " => " + (() => {
          const [h, m] = splitString(d, ":");
          return `${(h ?? "").padStart(2)}:${(m ?? "").padStart(2, "0")}`;
        })() : "")
      );
    }
    case "comment":
      return (p.value as string).replace(/^/gm, "# ");
    case "comment-block":
      return `#+begin_comment\n${normalizeString(removeIndentation(p.value))}#+end_comment`;
    case "diary-sexp":
      return p.value;
    case "example-block":
      return `#+begin_example${p.switches ? " " + p.switches : ""}\n${normalizeString(escapeCode(blockCode(n)))}#+end_example`;
    case "export-block":
      return `#+begin_export ${p.type}\n${p.value}#+end_export`;
    case "fixed-width": {
      const v: string | undefined = p.value;
      if (v === undefined) return "";
      return v === "" ? ":\n" : v.replace(/^/gm, ": ");
    }
    case "horizontal-rule":
      return "-----";
    case "keyword":
      return `#+${String(p.key).toLowerCase()}: ${p.value}`;
    case "latex-environment":
      return p.value;
    case "node-property":
      return propertyFormat(`:${p.key}:`, p.value ?? "");
    case "planning":
      return [
        p.deadline ? "DEADLINE: " + interpretTimestamp(p.deadline) : undefined,
        p.scheduled ? "SCHEDULED: " + interpretTimestamp(p.scheduled) : undefined,
        p.closed ? "CLOSED: " + interpretTimestamp(p.closed) : undefined,
      ]
        .filter((x) => x !== undefined)
        .join(" ");
    case "src-block": {
      const head = (p.language ? " " + p.language : "") + (p.switches ? " " + p.switches : "") + (p.parameters ? " " + p.parameters : "");
      return `#+begin_src${head}\n${normalizeString(escapeCode(blockCode(n)))}#+end_src`;
    }
    case "table":
      if (p.type === "table.el") return removeIndentation(p.value);
      return alignTable(c) + ((p.tblfm as string[] | undefined) ?? []).slice().reverse().map((f) => `#+TBLFM: ${f}`).join("\n");
    case "table-row":
      return p.type === "rule" ? "|-" : "|" + c;
    case "verse-block":
      return `#+begin_verse\n${f}#+end_verse`;
    case "bold":
      return `*${f}*`;
    case "citation": {
      const prefix = p.prefix ? interpretData(p.prefix) + ";" : "";
      return `[cite${p.style ? "/" + p.style : ""}:${prefix}${p.suffix ? c + interpretData(p.suffix) : c.slice(0, -1)}]`;
    }
    case "citation-reference":
      return `${interpretData(p.prefix ?? [])}@${p.key}${interpretData(p.suffix ?? [])};`;
    case "code":
      return `~${p.value}~`;
    case "entity":
      return `\\${p.name}${p["use-brackets-p"] ? "{}" : ""}`;
    case "export-snippet":
      return `@@${p["back-end"]}:${p.value}@@`;
    case "footnote-reference":
      return `[fn:${p.label ?? ""}${contents !== undefined ? ":" + contents : ""}]`;
    case "inline-babel-call":
      return `call_${p.call}${p["inside-header"] ? `[${p["inside-header"]}]` : ""}(${p.arguments ?? ""})${p["end-header"] ? `[${p["end-header"]}]` : ""}`;
    case "inline-src-block":
      return `src_${p.language}${p.parameters ? `[${p.parameters}]` : ""}{${p.value}}`;
    case "italic":
      return `/${f}/`;
    case "latex-fragment":
      return p.value;
    case "line-break":
      return "\\\\\n";
    case "link":
      return interpretLink(n, contents);
    case "macro":
      return `{{{${p.key}${p.args ? `(${macroEscapeArguments(...p.args)})` : ""}}}}`;
    case "radio-target":
      return `<<<${f}>>>`;
    case "statistics-cookie":
      return p.value;
    case "strike-through":
      return `+${f}+`;
    case "subscript":
      return p["use-brackets-p"] ? `_{${f}}` : `_${f}`;
    case "superscript":
      return p["use-brackets-p"] ? `^{${f}}` : `^${f}`;
    case "table-cell":
      return ` ${c} |`;
    case "target":
      return `<<${p.value}>>`;
    case "timestamp":
      return interpretTimestamp(n);
    case "underline":
      return `_${f}_`;
    case "verbatim":
      return `=${p.value}=`;
    default:
      return c;
  }
}

function interpretLink(n: Node, contents: string | undefined): string {
  const p = n.p;
  const type: string = p.type;
  const path: string = p.path;
  if (type === "radio") return path;
  let fmt: string;
  if (contents) fmt = `[[%s][${contents}]]`;
  else if (p.format === "bracket" || p.format === undefined || ["coderef", "custom-id", "fuzzy"].includes(type)) fmt = "[[%s]]";
  else if (p.format === "angle") fmt = "<%s>";
  else fmt = "%s";
  let target: string;
  if (type === "coderef") target = `(${path})`;
  else if (type === "custom-id") target = "#" + path;
  else if (type === "file") {
    const explicit = on(p["type-explicit-p"]);
    target = (explicit ? type : "") + (explicit && p.application ? "+" + p.application : "") + (explicit ? ":" : "") + path + (p["search-option"] ? "::" + p["search-option"] : "");
  } else if (type === "fuzzy") target = path;
  else target = `${type}:${path}`;
  return fmt.replace("%s", target);
}

/** A table's rows aligned, as org-table-align leaves them. */
/** A table's rows aligned by org-table-align in a buffer of their own, as Org's table interpreter aligns them. */
function alignTable(rows: string): string {
  const buffer = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(buffer);
  try {
    return e8.withCurrentBuffer(buffer, () => {
      e8.insert(rows);
      e8.gotoChar(e8.pointMin());
      e8.call("org-table-align");
      return e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    });
  } finally {
    e8.call("kill-buffer", buffer);
  }
}

/** An element's affiliated keywords written out, as org-element--interpret-affiliated-keywords; "" for none. */
export function interpretAffiliatedKeywords(element: Node): string {
  const one = (key: string, value: any): string => {
    let dual: any;
    if (key === "CAPTION" || key === "RESULTS") {
      dual = value?.secondary;
      value = value?.value;
    }
    return (
      "#+" +
      key.toLowerCase() +
      (dual !== undefined && dual !== null ? `[${typeof dual === "string" ? dual : interpretData(dual)}]` : "") +
      ": " +
      (key === "CAPTION" ? interpretData(value ?? []) : value) +
      "\n"
    );
  };
  let out = "";
  for (const [prop, value] of Object.entries(element.p)) {
    if (value === undefined || value === null) continue;
    const key = prop.toUpperCase();
    const affiliated = key.startsWith("ATTR_") || ["CAPTION", "HEADER", "NAME", "PLOT", "RESULTS"].includes(key);
    if (!affiliated || prop !== prop.toLowerCase()) continue;
    if (key === "CAPTION" || key === "HEADER" || key.startsWith("ATTR_")) for (const line of value as any[]) out += one(key, line);
    else out += one(key, value);
  }
  return out;
}

/** S ending in one newline, as org-element-normalize-string: "" stays "". */
export function normalizeString(s: string): string;
export function normalizeString<T>(s: T): T;
export function normalizeString(s: any): any {
  if (typeof s !== "string" || s === "") return s;
  return s.replace(/(?:\n[ \t]*)*$/, "\n");
}

/**
 * ELEMENT, which holds plain text and objects, with the indentation its
 * lines share taken off its strings, as org-element-normalize-contents;
 * with ignoreFirst the first line's indentation does not count.
 */
export function normalizeContents(element: Node, ignoreFirst = false): Node {
  const width = (s: string) => {
    let col = 0;
    for (const c of s) col = c === "\t" ? (Math.floor(col / 8) + 1) * 8 : col + 1;
    return col;
  };
  // Each string's indentation runs, as Org marks them with org-ind: where
  // a run starts, how long it is, and its width, or none for a blank line.
  interface Mark {
    at: number;
    len: number;
    width?: number;
  }
  const marks = new Map<Node, Map<number, Mark[]>>();
  let min = Infinity;
  const ZERO = {};
  const findMin = (blob: Node, firstFlag: boolean): void => {
    blob.contents.forEach((datum, i) => {
      const found: Mark[] = [];
      if (firstFlag) {
        firstFlag = false;
        if (typeof datum !== "string") throw ZERO;
        const m = /^([ \t]+)([^ \t\n]|\n|$)/.exec(datum);
        if (!m) throw ZERO;
        if (m[2] === "\n") found.push({ at: 0, len: m[1].length });
        else {
          found.push({ at: 0, len: m[1].length, width: width(m[1]) });
          min = Math.min(min, width(m[1]));
        }
      }
      if (typeof datum === "string") {
        const r = /\n([ \t]*)([^ \t\n]|\n|$)/g;
        let m: RegExpExecArray | null;
        while ((m = r.exec(datum))) {
          r.lastIndex = m.index + 1 + m[1].length;
          if (m[1] === "") {
            if (m[2] !== "" && m[2] !== "\n") throw ZERO;
          } else if (m[2] === "\n") found.push({ at: m.index + 1, len: m[1].length });
          else {
            found.push({ at: m.index + 1, len: m[1].length, width: width(m[1]) });
            min = Math.min(min, width(m[1]));
          }
          if (r.lastIndex >= datum.length) break;
        }
        if (found.length) {
          let own = marks.get(blob);
          if (!own) marks.set(blob, (own = new Map()));
          own.set(i, found);
        }
      } else if (datum.type === "line-break") firstFlag = true;
      else if (RECURSIVE_OBJECTS.includes(datum.type)) findMin(datum, false);
    });
  };
  try {
    findMin(element, !ignoreFirst);
  } catch (e) {
    if (e !== ZERO) throw e;
    min = 0;
  }
  // The element itself, its strings shortened in place, as Org's
  // org-element-set-contents does: the export's references, footnotes and
  // ignored cells know its objects by identity.
  if (min === 0 || min === Infinity) return element;
  const build = (blob: Node): Node => {
    const out = blob;
    const own = marks.get(blob);
    out.contents = blob.contents.map((datum, i) => {
      if (typeof datum === "string") {
        const found = own?.get(i);
        if (!found) return datum;
        let s = "";
        let prev = 0;
        for (const m of found) {
          s += datum.slice(prev, m.at);
          if (m.width !== undefined) s += indentTo(m.width - min);
          prev = m.at + m.len;
        }
        return s + datum.slice(prev);
      }
      if (RECURSIVE_OBJECTS.includes(datum.type)) {
        const c = build(datum);
        c.parent = out;
        return c;
      }
      return datum;
    });
    return out;
  };
  return build(element);
}

/** DATA written out as Org syntax, as org-element-interpret-data. */
export function interpretData(data: Datum | Datum[] | undefined): string {
  const walk = (d: Datum | Datum[], parent: Node | undefined): string => {
    if (Array.isArray(d)) return d.map((x) => walk(x, parent)).join("");
    if (typeof d === "string") return d;
    if (d.type === "org-data") return d.contents.map((x) => walk(x, d)).join("");
    let results: string;
    if (!d.contents.length) results = interpretNode(d, undefined);
    else {
      let src = d;
      if (d.type === "paragraph" || d.type === "verse-block") {
        const ignoreFirst =
          d.type === "paragraph" && parent !== undefined && (parent.type === "footnote-definition" || parent.type === "item") && parent.contents[0] === d && parent.p["pre-blank"] === 0;
        src = normalizeContents(d, ignoreFirst);
      }
      results = interpretNode(d, src.contents.map((x) => walk(x, d)).join(""));
    }
    const blank = d.p["post-blank"] ?? 0;
    if (isObject(d, parent)) return results + " ".repeat(blank);
    return interpretAffiliatedKeywords(d) + normalizeString(results) + "\n".repeat(blank);
  };
  if (data === undefined) return "";
  return walk(data, Array.isArray(data) || typeof data === "string" ? undefined : data.parent);
}
