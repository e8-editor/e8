// Elements, after org-element.el: enough of the parse to drag paragraphs,
// lists, tables and drawers past each other with M-<up> and M-<down>.

import {
  allKeywords,
  cycleLevel,
  type Heading,
  headingIndex,
  headingsAsRead,
  indentation,
  isBlank,
  isHeadingLine,
  moveSubtree,
  subtreeRegion,
} from "org";
import { ancestors, flag, FOLD_SPECS, withoutFoldChecks } from "org-fold";
import {
  type Alist,
  cycleItemIndentation,
  cycleListBullet,
  DRAWER_RE,
  getItem,
  indentItemCommand,
  ITEM_RE,
  itemEndBeforeBlank,
  itemLine,
  itemParts,
  listStruct,
  moveItemDown,
  moveItemUp,
  nextListItem,
  parentsAlist,
  previousItem,
  prevsAlist,
  type Struct,
  structAtItem,
  writeStruct,
} from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { allMatches, escapeRegExp } from "subr";

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
  /** How many of its parent's `shifts` this element has been moved by. */
  applied?: number;
}

export const PLANNING = /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/;

function elem(type: string, begin: number, end: number, parent: Elem, contentsBegin?: number): Elem {
  const e: Elem = { type, begin, end, contentsBegin, children: [], parent };
  parent.children.push(e);
  return e;
}

/** Extends an element's end over the blank lines after it, up to a limit, as its post-blank. */
function postBlank(e: Elem, limit: number): void {
  let l = lineAt(e.end);
  while (e.end < limit && e.end === lineStartOrEnd(l) && l < e8.lineCount() && isBlank(e8.lineText(l))) {
    e.end = Math.min(limit, lineStartOrEnd(l + 1));
    l++;
  }
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

/** A comment line, as org-element reads one: a hash, then a space or nothing. */
const COMMENT_LINE = /^[ \t]*#(?: |$)/;

/** A fixed-width line, as org-element reads one: a colon, then a space or nothing. */
const FIXED_WIDTH = /^[ \t]*:(?: |$)/;

/** Blocks whose contents are elements, which org-element parses inside them. */
const GREATER_BLOCKS = ["center-block", "quote-block", "special-block"];

/** Whether a line starts an element, so a paragraph before it ends. */
export function startsElement(line: number, limit: number): boolean {
  const text = e8.lineText(line);
  return (
    isBlank(text) ||
    isHeadingLine(text) ||
    /^[ \t]*\|/.test(text) ||
    ITEM_RE.test(text) ||
    /^[ \t]*#\+\S*:/.test(text) ||
    FIXED_WIDTH.test(text) ||
    COMMENT_LINE.test(text) ||
    // As org-element-paragraph-separate has them: lines that look like an
    // item, rules, footnote definitions, diary sexps, table.el tables and clocks.
    /^[ \t]*(?:[-+*]|[0-9]+[.)])(?:[ \t]|$)/.test(text) ||
    /^[ \t]*-{5,}[ \t]*$/.test(text) ||
    /^\[fn:[-_\w]+\]/.test(text) ||
    /^%%\(/.test(text) ||
    /^[ \t]*\+(?:-+\+)+[ \t]*$/.test(text) ||
    /^[ \t]*CLOCK:/.test(text) ||
    (DRAWER_RE.test(text) && drawerEnd(line, limit) !== undefined) ||
    blockAt(line, limit) !== undefined
  );
}

/** Parses the elements between from and to into parent, as org-element--parse-elements does. */
function parseElements(
  parent: Elem,
  from: number,
  to: number,
  afterHeadline: boolean,
  list?: [Struct, Alist, Alist],
  firstSection = false,
): void {
  let p = from;
  let previous: string | undefined;
  while (p < to) {
    const line = lineAt(p);
    const text = e8.bufferText(p, e8.lineEnd(line));
    const next = lineStartOrEnd(line + 1);
    let e: Elem;
    if (afterHeadline && previous === undefined && PLANNING.test(text)) {
      e = elem("planning", p, Math.min(next, to), parent);
    } else if (
      (afterHeadline || (firstSection && p === 0)) &&
      (previous === undefined || previous === "planning") &&
      /^[ \t]*:PROPERTIES:[ \t]*$/i.test(text) &&
      drawerEnd(line, to) !== undefined &&
      // As org-property-drawer-re has it, every line inside is a property.
      Array.from({ length: (drawerEnd(line, to) as number) - line - 1 }, (_, k) => e8.lineText(line + 1 + k)).every((l) =>
        /^[ \t]*:\S+:(?:[ \t].*)?[ \t]*$/.test(l),
      )
    ) {
      const close = drawerEnd(line, to) as number;
      e = elem("property-drawer", p, Math.min(lineStartOrEnd(close + 1), to), parent, lineStartOrEnd(line + 1));
      e.contentsEnd = e8.lineStart(close);
      for (let l = line + 1; l < close; l++) elem("node-property", e8.lineStart(l), e8.lineStart(l + 1), e);
    } else if (p === e8.lineStart(line) && /^[ \t]*\|/.test(text)) {
      // Anchored at the line's start, as Org's is: an item's text that starts with a bar is no table.
      let last = line;
      while (last + 1 < e8.lineCount() && lineStartOrEnd(last + 1) < to && /^[ \t]*\|/.test(e8.lineText(last + 1))) last++;
      e = elem("table", p, Math.min(lineStartOrEnd(last + 1), to), parent, p);
      e.contentsEnd = e.end;
      for (let l = line; l <= last; l++) elem("table-row", e8.lineStart(l), Math.min(lineStartOrEnd(l + 1), to), e);
    } else if (p === e8.lineStart(line) && itemLine(line)) {
      const [struct, prevs, parents] = list ?? (() => {
        // Bounded by what holds the list, as org-element--list-struct is, not
        // by the drawer org-list-context may take a line for.
        const s = listStruct(line, { up: from, down: to });
        return [s, prevsAlist(s), parentsAlist(s)] as [Struct, Alist, Alist];
      })();
      // As org-element-plain-list-parser does, the list goes on through the
      // items that follow at the same indentation.
      const items = [p];
      for (let next = struct.find((e) => e.pos === getItem(struct, p).end); next && next.ind === getItem(struct, p).ind; ) {
        items.push(next.pos);
        const after = next.end;
        next = struct.find((e) => e.pos === after);
      }
      const end = Math.min(getItem(struct, items[items.length - 1]).end, to);
      e = elem("plain-list", p, end, parent, p);
      e.contentsEnd = end;
      for (const pos of items) {
        const it = getItem(struct, pos);
        const parts = itemParts(lineAt(pos));
        const cb = parts && parts.matchEnd < e8.lineEnd(lineAt(pos)) ? parts.matchEnd : undefined;
        const item = elem("item", pos, Math.min(it.end, to), e, cb);
        const contentsEnd = Math.min(itemEndBeforeBlank(struct, pos) + 1, item.end, e8.bufferSize());
        item.contentsEnd = contentsEnd;
        const start = cb ?? lineStartOrEnd(lineAt(pos) + 1);
        if (start < contentsEnd) parseElements(item, start, contentsEnd, false, [struct, prevs, parents]);
      }
    } else if (p === e8.lineStart(line) && DRAWER_RE.test(text) && drawerEnd(line, to) !== undefined) {
      const close = drawerEnd(line, to) as number;
      e = elem("drawer", p, Math.min(lineStartOrEnd(close + 1), to), parent, lineStartOrEnd(line + 1));
      e.contentsEnd = e8.lineStart(close);
      if (close > line + 1) parseElements(e, e.contentsBegin as number, e.contentsEnd, false);
      else e.contentsBegin = undefined;
    } else if (p === e8.lineStart(line) && blockAt(line, to) !== undefined) {
      const block = blockAt(line, to) as { type: string; close: number };
      const greater = GREATER_BLOCKS.includes(block.type) || block.type === "verse-block";
      const inside = block.close > line + 1;
      e = elem(block.type, p, Math.min(lineStartOrEnd(block.close + 1), to), parent, greater && inside ? lineStartOrEnd(line + 1) : undefined);
      if (greater && inside) e.contentsEnd = e8.lineStart(block.close);
      if (GREATER_BLOCKS.includes(block.type) && inside) parseElements(e, e.contentsBegin as number, e.contentsEnd as number, false);
    } else if (p === e8.lineStart(line) && /^[ \t]*-{5,}[ \t]*$/.test(text)) {
      e = elem("horizontal-rule", p, Math.min(next, to), parent);
    } else if (p === e8.lineStart(line) && /^[ \t]*CLOCK:/.test(text)) {
      e = elem("clock", p, Math.min(next, to), parent);
    } else if (p === e8.lineStart(line) && /^%%\(/.test(text)) {
      e = elem("diary-sexp", p, Math.min(next, to), parent);
    } else if (p === e8.lineStart(line) && COMMENT_LINE.test(text)) {
      let last = line;
      while (last + 1 < e8.lineCount() && lineStartOrEnd(last + 1) < to && COMMENT_LINE.test(e8.lineText(last + 1))) last++;
      e = elem("comment", p, Math.min(lineStartOrEnd(last + 1), to), parent);
    } else if (p === e8.lineStart(line) && FIXED_WIDTH.test(text)) {
      let last = line;
      while (last + 1 < e8.lineCount() && lineStartOrEnd(last + 1) < to && FIXED_WIDTH.test(e8.lineText(last + 1))) last++;
      e = elem("fixed-width", p, Math.min(lineStartOrEnd(last + 1), to), parent);
    } else if (p === e8.lineStart(line) && /^[ \t]*#\+\S*:/.test(text)) {
      e = elem("keyword", p, Math.min(next, to), parent);
    } else {
      let last = line;
      while (last + 1 < e8.lineCount() && lineStartOrEnd(last + 1) < to && !startsElement(last + 1, to)) last++;
      e = elem("paragraph", p, Math.min(lineStartOrEnd(last + 1), to), parent, p);
    }
    postBlank(e, to);
    if (e.type === "planning") {
      // Org's planning parser skips the blank lines after it, then goes back to
      // the start of the line it stopped on: a last line of only spaces, with
      // no newline, belongs to no element.
      const ls = e8.lineStart(lineAt(e.end));
      if (e.end === e8.bufferSize() && ls < e.end && isBlank(e8.bufferText(ls, e.end))) {
        e.end = ls;
        previous = e.type;
        break;
      }
    }
    previous = e.type;
    if (e.end <= p) break;
    p = e.end;
  }
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
  const all = headingsAsRead();
  const branch = headingIndex(all, lineAt(pos));
  const key = `${e8.bufferName()}\n${allKeywords().join(" ")}\n${branch ?? -1}`;
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
    parseElements(sec, p, to, afterHeadline, undefined, parent.type === "org-data");
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
  // At the end of the accessible portion, the element that ends there.
  const size = e8.pointMax();
  for (;;) {
    // Children do not overlap and come in order: the one that holds pos is
    // the first that ends after it, if it starts at or before it.
    const i = firstEndingAfter(node, pos);
    let found = i < node.children.length ? child(node, i) : undefined;
    if (found && found.begin > pos) found = undefined;
    // At the end of the accessible portion, the one that ends there.
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

e8.defineCommand({
  name: "org-drag-element-backward",
  doc: "Move the element at point, such as a paragraph or a list, before the one above it.",
  run: () => {
    const e = elementAt(e8.point());
    if (!e) e8.userError("No element at point");
    if (e.type === "headline") {
      // Point stays where it was in the subtree, even on blank lines below its heading.
      let q = e8.point();
      while (q > 0 && /[ \t\n]/.test(e8.bufferText(q - 1, q))) q--;
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
    let q = e.begin;
    while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    if (q > 0) {
      prev = elementAt(q);
      for (let up = prev?.parent; prev && up && up.end <= e.begin; up = up.parent) prev = up;
    }
    if (!prev || nested(e, prev)) e8.userError("Cannot drag element backward");
    const pos = e8.point();
    swapElements(prev, e);
    e8.gotoChar(prev.begin + (pos - e.begin));
  },
});

e8.defineCommand({
  name: "org-drag-element-forward",
  doc: "Move the element at point, such as a paragraph or a list, after the one below it.",
  run: () => {
    const pos = e8.point();
    const e = elementAt(pos);
    if (!e) e8.userError("No element at point");
    if (e.end === e8.bufferSize()) e8.userError("Cannot drag element forward");
    const next = elementAt(e.end);
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
