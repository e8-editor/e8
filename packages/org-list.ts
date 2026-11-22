// Plain lists, after org-list.el. A list is read into a structure, an
// array of its items with their indentation, bullet, counter, checkbox,
// description tag and end, which commands change and then write back,
// fixing bullets, indentation and checkboxes across the whole list as
// org-list-write-struct does.

import {
  allKeywords,
  type Heading,
  headingIndex,
  headings,
  isBlank,
  isHeadingLine,
  moveToColumn,
  parseHeading,
  setTodo,
  updateCheckboxCount,
} from "org";
import { AFFILIATED, drawerEnd, elementAt, PLANNING } from "org-element";
import { fixFoldsAround, flag, FOLD_SPECS, foldChecksOff, hideOverlay, withoutFoldChecks } from "org-fold";
import {
  dropMarker,
  edDelete,
  edInsert,
  lastingMarker,
  lineAt,
  lineStartOrEnd,
  marker,
  type Marker,
  markers,
  orgRegionActive,
  placeMarkers,
} from "org-macs";
import { charCount, escapeRegExp } from "subr";

export interface ListItem {
  /** Where the item's line starts. */
  pos: number;
  ind: number;
  /** The bullet with the spaces after it, such as "- " or "1. ". */
  bullet: string;
  counter?: string;
  checkbox?: string;
  tag?: string;
  /** Where the item ends: the start of the line after its last, or of the next item. */
  end: number;
}

export type Struct = ListItem[];
export type Alist = Map<number, number | undefined>;

/** org-item-re, at the start of a line. */
export const ITEM_RE = /^(?:[ \t]*(?:[-+]|\d+[.)])|[ \t]+\*)(?:[ \t]+|$)/;
export const DRAWER_RE = /^[ \t]*:((?:\w|[-_])+):[ \t]*$/;
const LIST_FORBIDDEN_BLOCKS = ["example", "verse", "src", "export"];

/** The column a line's text starts at, counting tabs to tab stops, as org-current-text-indentation does. */
export function textIndentation(text: string): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col = (Math.floor(col / 8) + 1) * 8;
    else break;
  }
  return col;
}

/** The whitespace that indents to a column, with tabs if indent-tabs-mode is on. */
export function indentString(col: number, from = 0): string {
  // As indent-to does, a column at or before where it starts adds nothing.
  if (col <= from) return "";
  if (e8.variable("indent-tabs-mode") === true) {
    const width = Number(e8.variable("tab-width") ?? 8);
    let s = "";
    let c = from;
    while (Math.floor(c / width) < Math.floor(col / width)) {
      s += "\t";
      c = (Math.floor(c / width) + 1) * width;
    }
    return s + " ".repeat(col - c);
  }
  return " ".repeat(Math.max(0, col - from));
}

/**
 * Replaces text as replace-match does: markers inside it go to its start,
 * and those at its end or after move with the text after it.
 */
export function edReplace(from: number, to: number, text: string): void {
  const n = charCount(text);
  const delta = n - (to - from);
  const mark = e8.mark();
  const saved: [Marker, number][] = markers.map((m) => [m, m.pos]);
  // One change, as replace-match is, so folds are checked once, after it.
  const checks = !foldChecksOff;
  withoutFoldChecks(() => {
    e8.deleteRegion(from, to);
    e8.gotoChar(from);
    e8.insert(text);
  });
  const moved = (x: number): number => (x >= to ? x + delta : x > from ? from : x);
  placeMarkers(saved.map(([m, p]) => [m, moved(p)]));
  if (mark !== undefined) e8.setMark(moved(mark));
  if (checks) fixFoldsAround(from, from + n);
}

/** Sets a line's indentation, as indent-line-to does: only the difference is inserted or deleted. */
export function indentLineTo(line: number, col: number): void {
  const ls = e8.lineStart(line);
  const ws = /^[ \t]*/.exec(e8.lineText(line))?.[0] ?? "";
  const end = ls + charCount(ws);
  const cur = textIndentation(ws);
  const width = Number(e8.variable("tab-width") ?? 8);
  if (cur < col) {
    let from = cur;
    let at = end;
    if (col - Math.floor(cur / width) * width >= width) {
      const spaces = / *$/.exec(ws)?.[0].length ?? 0;
      edDelete(end - spaces, end);
      at = end - spaces;
      from = textIndentation(ws.slice(0, ws.length - spaces));
    }
    edInsert(at, indentString(col, from));
  } else if (cur > col) {
    // move-to-column with force: a tab it lands inside becomes spaces.
    let c = 0;
    let i = 0;
    while (i < ws.length) {
      const next = ws[i] === "\t" ? (Math.floor(c / 8) + 1) * 8 : c + 1;
      if (next > col) {
        if (c < col) {
          edDelete(ls + i, ls + i + 1);
          edInsert(ls + i, " ".repeat(next - c));
          edDelete(ls + i + (col - c), ls + charCount(/^[ \t]*/.exec(e8.lineText(line))?.[0] ?? ""));
          return;
        }
        break;
      }
      c = next;
      i++;
    }
    edDelete(ls + i, end);
  }
}

/**
 * The region lists are read in around a line, and what it is, as
 * org-list-context finds it: the section between headings, or a drawer or
 * block inside it. Lists are not recognized in example, verse, source and
 * export blocks.
 */
function listContext(line: number): { up: number; down: number; type?: string } {
  const pos = e8.lineStart(line);
  const all = headings();
  const h = headingIndex(all, line);
  // Within the narrowing, as org-list-context bounds the list by point-min and point-max.
  let up = h === undefined ? e8.pointMin() : all[h].start;
  let down = all.find((x) => x.start > pos)?.start ?? e8.pointMax();
  let type: string | undefined;
  const text = e8.lineText(line);
  const upLine = lineAt(up);
  const downLine = lineAt(down);
  if (!DRAWER_RE.test(text) && !/^[ \t]*:END:/i.test(text)) {
    let beg: number | undefined;
    for (let l = line - 1; l >= upLine && e8.lineStart(l) >= up; l--) {
      if (DRAWER_RE.test(e8.lineText(l))) {
        beg = l;
        break;
      }
    }
    if (beg !== undefined) {
      let end = down;
      for (let l = beg; l <= downLine && l < e8.lineCount(); l++) {
        if (e8.lineStart(l) >= down) break;
        if (/^[ \t]*:END:/i.test(e8.lineText(l))) {
          end = e8.lineStart(l) - 1;
          break;
        }
      }
      if (end >= pos) [up, down, type] = [e8.lineStart(beg + 1), end, "drawer"];
    }
  }
  const BLOCK = /^[ \t]*#\+(begin|end)_/i;
  if (!BLOCK.test(e8.lineText(line))) {
    let beg: number | undefined;
    for (let l = line - 1; l >= 0 && e8.lineStart(l) >= up; l--) {
      if (BLOCK.test(e8.lineText(l))) {
        beg = l;
        break;
      }
    }
    const open = beg === undefined ? null : /^[ \t]*#\+begin_(\S+)/i.exec(e8.lineText(beg));
    if (beg !== undefined && open) {
      let end = down;
      let closes = false;
      for (let l = beg + 1; l < e8.lineCount() && e8.lineStart(l) < down; l++) {
        const m = BLOCK.exec(e8.lineText(l));
        if (m) {
          end = e8.lineStart(l) - 1;
          closes = m[1].toLowerCase() === "end";
          break;
        }
      }
      if (end >= pos && closes) {
        [up, down] = [e8.lineStart(beg + 1), end];
        type = LIST_FORBIDDEN_BLOCKS.includes(open[1].toLowerCase()) ? "invalid" : "block";
      }
    }
  }
  return { up, down, type };
}

/** Whether a line and the one after it are blank, which ends a list (org-list-end-re). */
function atListEnd(line: number): boolean {
  return line + 1 < e8.lineCount() && isBlank(e8.lineText(line)) && isBlank(e8.lineText(line + 1));
}

/** Whether a line starts an item: org-at-item-p for that line. */
export function itemLine(line: number): boolean {
  if (line < 0 || line >= e8.lineCount()) return false;
  if (!ITEM_RE.test(e8.lineText(line))) return false;
  return listContext(line).type !== "invalid";
}

/** The start of the item a line is in, if any, as org-in-item-p finds it. */
export function inItem(line: number): number | undefined {
  const ctx = listContext(line);
  if (ctx.type === "invalid") return undefined;
  if (ITEM_RE.test(e8.lineText(line))) return e8.lineStart(line);
  let indRef = isBlank(e8.lineText(line)) ? 10000 : textIndentation(e8.lineText(line));
  let l = line;
  // Between the two blank lines that end a list, start from the first.
  if (l > 0 && atListEnd(l - 1)) l -= 2;
  else if (atListEnd(l)) l -= 1;
  for (;;) {
    if (l < 0) return undefined;
    const text = e8.lineText(l);
    const ind = textIndentation(text);
    if (ITEM_RE.test(text) && ind < indRef) return e8.lineStart(l);
    if (e8.lineStart(l) <= ctx.up) return undefined;
    if (atListEnd(l)) return undefined;
    if (/^[ \t]*#\+end_/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && e8.lineStart(k) >= ctx.up && !/^[ \t]*#\+begin_/i.test(e8.lineText(k))) k--;
      if (k >= 0 && e8.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (/^[ \t]*:END:/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && e8.lineStart(k) >= ctx.up && !DRAWER_RE.test(e8.lineText(k))) k--;
      if (k >= 0 && e8.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (isBlank(text)) {
      l--;
      continue;
    }
    if (ind === 0) return undefined;
    if (ind < indRef) indRef = ind;
    l--;
  }
}

/** Where the parts of an item's first line are, as org-list-full-item-re's groups find them. */
export interface ItemParts {
  bulletAt: number;
  bullet: string;
  counter?: string;
  /** Just after the counter's closing bracket. */
  counterEnd?: number;
  checkbox?: string;
  boxAt?: number;
  tag?: string;
  tagAt?: number;
  tagEnd?: number;
  /** Where the whole match ends: after the bullet, counter, checkbox and tag. */
  matchEnd: number;
}

export function itemParts(line: number): ItemParts | undefined {
  const text = e8.lineText(line);
  const base = e8.lineStart(line);
  const pos = (i: number): number => base + charCount(text.slice(0, i));
  const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
  let i = ws.length;
  const b = /^(?:[-+*]|(?:\d+|[A-Za-z])[.)])(?:[ \t]+|$)/.exec(text.slice(i));
  if (!b) return undefined;
  const parts: ItemParts = { bulletAt: pos(i), bullet: b[0], matchEnd: 0 };
  i += b[0].length;
  const c = /^\[@(?:start:)?(\d+|[A-Za-z])\][ \t]*/.exec(text.slice(i));
  if (c) {
    parts.counter = c[1];
    parts.counterEnd = pos(i + c[0].indexOf("]") + 1);
    i += c[0].length;
  }
  const x = /^(\[[ X-]\])(?:[ \t]+|$)/.exec(text.slice(i));
  if (x) {
    parts.checkbox = x[1];
    parts.boxAt = pos(i);
    i += x[0].length;
  }
  const d = /^(.*)[ \t]+::(?:[ \t]+|$)/.exec(text.slice(i));
  if (d) {
    parts.tag = d[1];
    parts.tagAt = pos(i);
    parts.tagEnd = pos(i + d[1].length);
    i += d[0].length;
  }
  parts.matchEnd = pos(i);
  return parts;
}

function readItem(line: number, ind: number): ListItem {
  const m = itemParts(line);
  const bullet = m?.bullet ?? "";
  return {
    pos: e8.lineStart(line),
    ind,
    bullet,
    counter: m?.counter,
    checkbox: m?.checkbox,
    tag: /[-+*]/.test(bullet) ? m?.tag : undefined,
    end: 0,
  };
}

/** The structure of the list the item on a line is in, as org-list-struct reads it. */
export function listStruct(line: number, ctx: { up: number; down: number; type?: string } = listContext(line)): Struct {
  let textMinInd = 10000;
  let begCell: [number, number] = [e8.lineStart(line), textIndentation(e8.lineText(line))];
  let itmLst: Struct = [];
  const endLst: [number, number][] = [];
  const fromBeg = (): Struct => {
    const k = itmLst.findIndex((e) => e.pos === begCell[0]);
    return k < 0 ? [] : itmLst.slice(k);
  };
  // 1. Up from the item to the start of the list.
  for (let l = line; ; ) {
    const pos = e8.lineStart(l);
    const text = e8.lineText(l);
    const ind = textIndentation(text);
    if (pos <= ctx.up) {
      if (!ITEM_RE.test(text)) itmLst = fromBeg();
      else {
        begCell = [pos, ind];
        itmLst.unshift(readItem(l, ind));
      }
      break;
    }
    if (atListEnd(l)) {
      itmLst = fromBeg();
      break;
    }
    if (ITEM_RE.test(text)) {
      itmLst.unshift(readItem(l, ind));
      endLst.unshift([ind, pos]);
      if (ind < textMinInd) begCell = [pos, ind];
      l--;
      continue;
    }
    if (/^[ \t]*#\+end_/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && e8.lineStart(k) >= ctx.up && !/^[ \t]*#\+begin_/i.test(e8.lineText(k))) k--;
      if (k >= 0 && e8.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (/^[ \t]*:END:/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && e8.lineStart(k) >= ctx.up && !DRAWER_RE.test(e8.lineText(k))) k--;
      if (k >= 0 && e8.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (isBlank(text)) {
      l--;
      continue;
    }
    if (ind === 0) {
      itmLst = fromBeg();
      break;
    }
    if (ind < textMinInd) textMinInd = ind;
    endLst.unshift([ind, pos]);
    l--;
  }
  // 2. Down from the item to the end of the list.
  const itmLst2: Struct = [];
  const endLst2: [number, number][] = [];
  const endBeforeBlank = (pos: number): number => {
    let q = pos;
    while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    return Math.min(e8.lineEnd(lineAt(q)) + 1, ctx.down);
  };
  for (let l = line; ; ) {
    const pos = lineStartOrEnd(l);
    if (pos >= ctx.down) {
      endLst2.unshift([0, endBeforeBlank(pos)]);
      break;
    }
    const text = e8.lineText(l);
    const ind = textIndentation(text);
    if (atListEnd(l)) {
      endLst2.unshift([0, pos]);
      break;
    }
    if (ITEM_RE.test(text)) {
      itmLst2.unshift(readItem(l, ind));
      endLst2.unshift([ind, pos]);
      l++;
      continue;
    }
    if (isBlank(text)) {
      l++;
      continue;
    }
    if (ind <= begCell[1]) {
      endLst2.unshift([0, endBeforeBlank(pos)]);
      break;
    }
    if (itmLst2.length > 0 && ind <= itmLst2[0].ind) endLst2.unshift([ind, pos]);
    if (/^[ \t]*#\+begin_/i.test(text)) {
      let k = l + 1;
      while (k < e8.lineCount() && lineStartOrEnd(k) < ctx.down && !/^[ \t]*#\+end_/i.test(e8.lineText(k))) k++;
      if (k < e8.lineCount() && lineStartOrEnd(k) < ctx.down) l = k;
    } else if (DRAWER_RE.test(text)) {
      let k = l + 1;
      while (k < e8.lineCount() && lineStartOrEnd(k) < ctx.down && !/^[ \t]*:END:/i.test(e8.lineText(k))) k++;
      if (k < e8.lineCount() && lineStartOrEnd(k) < ctx.down) l = k;
    }
    l++;
  }
  const struct = [...itmLst, ...itmLst2.reverse().slice(1)];
  assocEnd(struct, [...endLst, ...endLst2.reverse().slice(1)]);
  return struct;
}

/** Gives each item its end from candidate (indentation, position) ends, as org-list-struct-assoc-end does. */
function assocEnd(struct: Struct, endList: [number, number][]): void {
  let endings = endList;
  for (const e of struct) {
    while (endings.length > 0 && endings[0][1] <= e.pos) endings = endings.slice(1);
    e.end = endings.find(([ind]) => ind <= e.ind)?.[1] ?? e.end;
  }
}

export function getItem(struct: Struct, pos: number): ListItem {
  const e = struct.find((x) => x.pos === pos);
  if (!e) throw new Error(`No item at ${pos}`);
  return e;
}

export function prevsAlist(struct: Struct): Alist {
  // The first entry for a position wins, as assq finds it.
  const out: Alist = new Map();
  for (const e of struct) if (!out.has(e.pos)) out.set(e.pos, struct.find((x) => x.end === e.pos)?.pos);
  return out;
}

export function parentsAlist(struct: Struct): Alist {
  let indToOri: [number, number | undefined][] = [[struct[0].ind, undefined]];
  const prevPos = [struct[0].pos];
  // A structure Org has just edited can hold two items at one position;
  // assq finds the first, so the first one's entry is kept here too.
  const out: Alist = new Map([[struct[0].pos, undefined]]);
  const set = out.set.bind(out);
  out.set = (key: number, value: number | undefined) => (out.has(key) ? out : set(key, value));
  for (const item of struct.slice(1)) {
    const prevInd = indToOri[0][0];
    prevPos.unshift(item.pos);
    if (prevInd > item.ind) {
      let k = indToOri.findIndex((e) => e[0] === item.ind);
      if (k < 0) k = indToOri.findIndex((e) => e[0] < item.ind);
      indToOri = k >= 0 ? indToOri.slice(k) : [[item.ind, undefined]];
      out.set(item.pos, indToOri[0][1]);
    } else if (prevInd < item.ind) {
      indToOri.unshift([item.ind, prevPos[1]]);
      out.set(item.pos, prevPos[1]);
    } else out.set(item.pos, indToOri[0][1]);
  }
  return out;
}

function nextItem(item: number, prevs: Alist): number | undefined {
  for (const [pos, prev] of prevs) if (prev === item) return pos;
  return undefined;
}

function prevItem(item: number, prevs: Alist): number | undefined {
  return prevs.get(item);
}

export function itemEndBeforeBlank(struct: Struct, item: number): number {
  let q = getItem(struct, item).end;
  while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
  return e8.lineEnd(lineAt(q));
}

export function hasChild(struct: Struct, item: number): number | undefined {
  const k = struct.findIndex((e) => e.pos === item);
  const next = struct[k + 1];
  return next && struct[k].ind < next.ind ? next.pos : undefined;
}

function subtreeItems(struct: Struct, item: number): number[] {
  const e = getItem(struct, item);
  return struct.filter((x) => x.pos > item && x.pos < e.end).map((x) => x.pos);
}

export function allItems(item: number, prevs: Alist): number[] {
  const before: number[] = [];
  for (let p = prevItem(item, prevs); p !== undefined; p = prevItem(p, prevs)) before.unshift(p);
  const after: number[] = [];
  for (let n = nextItem(item, prevs); n !== undefined; n = nextItem(n, prevs)) after.push(n);
  return [...before, item, ...after];
}

export function children(item: number, parents: Alist): number[] {
  return [...parents].filter(([, parent]) => parent === item).map(([pos]) => pos);
}

export function bottomPoint(struct: Struct): number {
  return Math.max(...struct.map((e) => e.end));
}

function firstItem(item: number, prevs: Alist): number {
  let first = item;
  for (let p = prevItem(first, prevs); p !== undefined; p = prevItem(first, prevs)) first = p;
  return first;
}

function lastItem(item: number, prevs: Alist): number {
  let last = item;
  for (let n = nextItem(last, prevs); n !== undefined; n = nextItem(last, prevs)) last = n;
  return last;
}

export function copyStruct(struct: Struct): Struct {
  return struct.map((e) => ({ ...e }));
}

function sameItem(a: ListItem | undefined, b: ListItem | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.pos === b.pos &&
    a.ind === b.ind &&
    a.bullet === b.bullet &&
    a.counter === b.counter &&
    a.checkbox === b.checkbox &&
    a.tag === b.tag &&
    a.end === b.end
  );
}

export function sameStruct(a: Struct, b: Struct): boolean {
  return a.length === b.length && a.every((e, k) => sameItem(e, b[k]));
}

e8.defineVariable({
  name: "org-list-two-spaces-after-bullet-regexp",
  doc: "A regexp matching the bullets that take two spaces after them, rather than one, as \"[0-9]\" for numbered items. nil for none.",
  value: null,
});

/** Whether a bullet takes two spaces after it, as org-list-two-spaces-after-bullet-regexp says. */
export function twoSpacesAfter(bullet: string): boolean {
  const regexp = e8.variable("org-list-two-spaces-after-bullet-regexp");
  return typeof regexp === "string" && e8.stringMatch(regexp, bullet) !== undefined;
}

/** A bullet with one space after it, or two as org-list-two-spaces-after-bullet-regexp says, as org-list-bullet-string makes it. */
export function bulletString(bullet: string): string {
  const m = /\S+([ \t]*)/.exec(bullet);
  if (!m) return bullet;
  const at = (m.index ?? 0) + m[0].length - m[1].length;
  // One space after it, or two where org-list-two-spaces-after-bullet-regexp matches, as org-list-bullet-string.
  return bullet.slice(0, at) + (twoSpacesAfter(bullet) ? "  " : " ") + bullet.slice(at + m[1].length);
}

function incBulletMaybe(bullet: string): string {
  const n = /\d+/.exec(bullet);
  if (n) return bullet.replace(/\d+/, String(Number(n[0]) + 1));
  const a = /[A-Za-z]/.exec(bullet);
  if (a) return bullet.replace(/[A-Za-z]/, String.fromCharCode(a[0].charCodeAt(0) + 1));
  return bullet;
}

/** Numbers ordered lists from 1 or their counters, and gives items their list's bullet, as org-list-struct-fix-bul does. */
export function fixBul(struct: Struct, prevs: Alist): void {
  for (const e of struct) {
    const prev = prevItem(e.pos, prevs);
    const prevBul = prev === undefined ? undefined : getItem(struct, prev).bullet;
    const { counter, bullet } = e;
    let fixed: string;
    if (prevBul !== undefined && counter && /[a-zA-Z]/.test(counter) && /[a-zA-Z]/.test(prevBul)) {
      fixed = prevBul.replace(/[a-zA-Z]/, /[a-z]/.test(prevBul) ? counter.toLowerCase() : counter.toUpperCase());
    } else if (prevBul !== undefined && counter && /\d+/.test(counter) && /\d+/.test(prevBul)) {
      fixed = prevBul.replace(/\d+/, counter);
    } else if (prevBul !== undefined) {
      fixed = incBulletMaybe(prevBul);
    } else if (counter && /\d+/.test(counter) && /\d+/.test(bullet)) {
      fixed = bullet.replace(/\d+/, counter);
    } else if (/\d+|[A-Za-z]/.test(bullet)) {
      fixed = bullet.replace(/\d+|[A-Za-z]/, "1");
    } else fixed = bullet;
    e.bullet = bulletString(fixed);
  }
}

/** Indents items under their parents' text, or as the first item, as org-list-struct-fix-ind does. */
export function fixInd(struct: Struct, parents: Alist, bulletSize?: number): void {
  const topInd = struct[0].ind;
  // By position, as Org goes, setting the first item there, as assq finds it.
  for (const { pos } of struct.slice(1)) {
    const e = getItem(struct, pos);
    const parent = parents.get(e.pos);
    if (parent === undefined) e.ind = topInd;
    else {
      const p = getItem(struct, parent);
      e.ind = (bulletSize ?? charCount(p.bullet)) + p.ind;
    }
  }
}

/**
 * Gives parents with checkboxes the state of their children's, as
 * org-list-struct-fix-box does. With ORDERED, a box can be ticked only
 * after every box before it: those after the first empty one are emptied
 * again, and the first empty one's item is returned.
 */
export function fixBox(struct: Struct, parents: Alist, ordered = false): number | undefined {
  const parentList: number[] = [];
  for (const e of struct) {
    const parent = parents.get(e.pos);
    if (parent !== undefined && getItem(struct, parent).checkbox && !parentList.includes(parent)) parentList.unshift(parent);
  }
  parentList.sort((a, b) => getItem(struct, b).ind - getItem(struct, a).ind);
  for (const item of parentList) {
    const boxes = children(item, parents).map((c) => getItem(struct, c).checkbox);
    const e = getItem(struct, item);
    if (boxes.includes("[ ]") && boxes.includes("[X]")) e.checkbox = "[-]";
    else if (boxes.includes("[-]")) e.checkbox = "[-]";
    else if (boxes.includes("[X]")) e.checkbox = "[X]";
    else if (boxes.includes("[ ]")) e.checkbox = "[ ]";
  }
  if (!ordered) return undefined;
  const index = struct.findIndex((e) => e.checkbox === "[ ]");
  if (index < 0 || !struct.slice(index).some((e) => e.checkbox === "[X]")) return undefined;
  for (const e of struct.slice(index)) if (e.checkbox) e.checkbox = "[ ]";
  fixBox(struct, parents);
  return struct[index].pos;
}

/** Whether the entry point is in has an ORDERED property, as (org-entry-get nil "ORDERED") reads it. */
export function orderedHere(): boolean {
  const h = entryHeading();
  return (h ? entryGet(h.line, "ORDERED") : topGet("ORDERED")) !== undefined;
}

/** A position's line number, counted from the buffer's start even when narrowed, as org-current-line. */
export function currentLine(pos: number): number {
  return lineAt(pos) + 1;
}

/** Works out items' ends again after their indentation changed, as org-list-struct-fix-item-end does. */
export function fixItemEnd(struct: Struct): void {
  const endList: [number, number][] = [];
  const accEnd: [number, number][] = [];
  for (const e of struct) {
    if (!struct.some((x) => x.pos === e.end)) {
      const up = accEnd.find(([end]) => end > e.end)?.[1];
      endList.unshift([up !== undefined ? getItem(struct, up).ind + 2 : 0, e.end]);
    }
    endList.unshift([e.ind, e.pos]);
    accEnd.unshift([e.end, e.pos]);
  }
  endList.sort((a, b) => a[1] - b[1]);
  assocEnd(struct, endList);
}

/** Writes the differences between a structure and the old one to the buffer, as org-list-struct-apply-struct does. */
export function applyStruct(struct: Struct, old: Struct): void {
  const origin = marker(e8.point());
  const shiftBodyInd = (end: number, beg: number, delta: number): void => {
    let q = end;
    while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    let l = lineAt(q);
    while (e8.lineStart(l) > beg || (e8.lineStart(l) === beg && !ITEM_RE.test(e8.lineText(l)))) {
      const text = e8.lineText(l);
      if (/^[ \t]*\S/.test(text)) indentLineTo(l, textIndentation(text) + delta);
      if (l === 0) break;
      l--;
    }
  };
  const modifyItem = (item: number): void => {
    const e = getItem(struct, item);
    const line = lineAt(item);
    const newBul = bulletString(e.bullet);
    const reindent = (): void => {
      if (e.ind !== textIndentation(e8.lineText(line))) {
        const ls = e8.lineStart(line);
        const ws = /^[ \t]*/.exec(e8.lineText(line))?.[0] ?? "";
        edDelete(ls, ls + charCount(ws));
        edInsert(ls, indentString(e.ind));
      }
    };
    // Org's structure can hold a position partway along a line, which its
    // anchored regexp then fails to match: only the indentation, worked out
    // from the line's start, changes.
    if (item !== e8.lineStart(line)) {
      reindent();
      return;
    }
    let m = itemParts(line);
    if (!m) return;
    if (getItem(old, item).bullet !== newBul) {
      const bulletEnd = m.bulletAt + charCount(m.bullet);
      let keep = "";
      if (m.bulletAt <= origin.pos && origin.pos <= bulletEnd) {
        keep = /^[ \t]+/.exec(e8.bufferText(origin.pos, e8.lineEnd(line)))?.[0] ?? "";
      }
      edDelete(m.bulletAt, bulletEnd);
      edInsert(m.bulletAt, newBul, true);
      edInsert(m.bulletAt + charCount(newBul), keep);
    }
    m = itemParts(line);
    if (!m) return;
    if (m.checkbox === e.checkbox) {
      // The checkbox is right.
    } else if (m.checkbox !== undefined && e.checkbox !== undefined && m.boxAt !== undefined) {
      edReplace(m.boxAt, m.boxAt + 3, e.checkbox);
    } else if (m.checkbox !== undefined) {
      // The box goes, with the spaces before it.
      const text = e8.lineText(line);
      for (let k = 0; k < text.length; k++) {
        const box = /^[ \t]*\[[ X-]\]/.exec(text.slice(k));
        if (box) {
          const start = item + charCount(text.slice(0, k));
          edDelete(start, start + charCount(box[0]));
          break;
        }
      }
    } else if (e.checkbox !== undefined) {
      const at = m.counterEnd ?? m.bulletAt + charCount(m.bullet);
      edInsert(at, e.checkbox + (m.counterEnd !== undefined ? "" : " "));
    }
    reindent();
  };
  const endList: [number, number | undefined][] = [];
  let accEnd: [number, number][] = [];
  const itmShift = new Map<number, number>();
  for (const { pos } of old) {
    // Looked up by position, as Org does with assq, so two items at one
    // position both read the first.
    const now = getItem(struct, pos);
    const was = getItem(old, pos);
    itmShift.set(pos, now.ind + charCount(now.bullet) - (was.ind + charCount(was.bullet)));
    if (!old.some((x) => x.pos === was.end)) {
      const up = accEnd.find(([end]) => end > was.end)?.[1];
      endList.unshift([was.end, up]);
    }
    accEnd.unshift([was.end, pos]);
  }
  // Only the ends that are not at items are made unique, as in Org.
  const allEnds = [...old.map((e) => e.pos), ...new Set(endList.map(([end]) => end))].sort((a, b) => a - b);
  accEnd = accEnd.reverse();
  const sliced: [number, number, number][] = [];
  while (allEnds.length > 1) {
    const up = allEnds.shift() as number;
    const down = allEnds[0];
    let delta: number;
    if (struct.some((x) => x.pos === up)) delta = itmShift.get(up) ?? 0;
    else {
      const child = accEnd.find(([end]) => end === up)?.[1];
      const ind = child === undefined ? 0 : getItem(struct, child).ind;
      let minInd = Infinity;
      for (let l = lineAt(up); l < e8.lineCount() && e8.lineStart(l) < down; l++) {
        const text = e8.lineText(l);
        if (isBlank(text)) continue;
        minInd = Math.min(minInd, textIndentation(text));
        const block = /^#\+BEGIN(:|_\S+)/i.exec(text);
        if (block) {
          const close = new RegExp(`^[ \\t]*#\\+END${block[1].replace(/[^\w:]/g, "")}[ \\t]*$`, "i");
          for (let k = l + 1; k < e8.lineCount() && e8.lineStart(k) < down; k++) {
            if (close.test(e8.lineText(k))) {
              l = k;
              break;
            }
          }
        } else if (DRAWER_RE.test(text)) {
          for (let k = l + 1; k < e8.lineCount() && e8.lineStart(k) < down; k++) {
            if (/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(k))) {
              l = k;
              break;
            }
          }
        }
      }
      delta = minInd === Infinity ? 0 : ind - minInd;
    }
    sliced.unshift([down, up, delta]);
  }
  for (const [down, up, delta] of sliced) {
    if (delta !== 0) shiftBodyInd(down, up, delta);
    const cell = struct.find((x) => x.pos === up);
    if (cell && !sameItem(cell, old.find((x) => x.pos === up))) modifyItem(up);
  }
  e8.gotoChar(origin.pos);
  dropMarker(origin);
}

/** Fixes a list's bullets, indentation and checkboxes and writes it back, as org-list-write-struct does. */
export function writeStruct(struct: Struct, parents: Alist, old?: Struct): Struct {
  const reference = old ?? copyStruct(struct);
  fixInd(struct, parents, 2);
  fixItemEnd(struct);
  const prevs = prevsAlist(struct);
  fixBul(struct, prevs);
  fixInd(struct, parents);
  fixBox(struct, parents);
  applyStruct(struct, reference);
  return struct;
}

/** Swaps two items of a sub-list, leaving their blank lines where they were, as org-list-swap-items does. */
function swapItems(begA: number, begB: number, struct: Struct): Struct {
  return withoutFoldChecks(() => swapItemsChecked(begA, begB, struct));
}

function swapItemsChecked(begA: number, begB: number, struct: Struct): Struct {
  const p = marker(e8.point());
  const endANoBlank = itemEndBeforeBlank(struct, begA);
  const endBNoBlank = itemEndBeforeBlank(struct, begB);
  const endA = getItem(struct, begA).end;
  const endB = getItem(struct, begB).end;
  const sizeA = endANoBlank - begA;
  const sizeB = endBNoBlank - begB;
  const bodyA = e8.bufferText(begA, endANoBlank);
  const bodyB = e8.bufferText(begB, endBNoBlank);
  const between = e8.bufferText(endANoBlank, begB);
  const subA = [begA, ...subtreeItems(struct, begA)];
  const subB = [begB, ...subtreeItems(struct, begB)];
  // Folds inside the items move with them.
  const folds = (from: number, to: number): [number, number, string][] =>
    e8
      .overlaysIn(from, to)
      .filter((id) => FOLD_SPECS.includes(String(e8.overlayGet(id, "invisible"))))
      .map((id) => [(e8.overlayStart(id) ?? from) - from, (e8.overlayEnd(id) ?? from) - from, String(e8.overlayGet(id, "invisible"))]);
  const foldsA = folds(begA, endA);
  const foldsB = folds(begB, endB);
  for (const spec of FOLD_SPECS) flag(begA, endBNoBlank, false, spec);
  edDelete(begA, endBNoBlank);
  edInsert(begA, bodyB + between + bodyA);
  for (const [s, e, spec] of foldsB) flag(begA + s, begA + e, true, spec);
  const at = begA + sizeB + charCount(between);
  for (const [s, e, spec] of foldsA) flag(at + s, at + e, true, spec);
  for (const e of struct) {
    const { pos, end } = e;
    if (pos < begA) continue;
    if (subA.includes(pos)) {
      e.pos = pos + (endBNoBlank - endANoBlank);
      e.end = end === endA ? endB : end + (endBNoBlank - endANoBlank);
    } else if (subB.includes(pos)) {
      e.pos = pos + begA - begB;
      e.end = end === endB ? begA + sizeB + (endA - endANoBlank) : end + (begA - begB);
    } else if (pos < begB) {
      e.pos = pos + (sizeB - sizeA);
      e.end = end + (sizeB - sizeA);
    }
  }
  struct.sort((a, b) => a.pos - b.pos);
  e8.gotoChar(p.pos);
  dropMarker(p);
  return struct;
}

/** How many blank lines go between items when one is inserted, as org-list-separating-blank-lines-number guesses. */
function separatingBlankLines(pos: number, item: number, struct: Struct, prevs: Alist): number {
  // As org-blank-before-new-entry's plain-list-item says: nil for none, a number for that many, auto to follow the list.
  const setting = blankBeforeNewEntry("plain-list-item");
  if (setting === null || setting === false) return 0;
  if (typeof setting === "number") return setting;
  const countBlanks = (at: number): number => {
    const bol = e8.lineStart(lineAt(at));
    let q = bol;
    while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    const after = lineStartOrEnd(lineAt(q) + 1);
    const [a, b] = [Math.min(bol, after), Math.max(bol, after)];
    return (e8.bufferText(a, b).match(/\n/g) ?? []).length;
  };
  const next = nextItem(item, prevs);
  if (next !== undefined) return countBlanks(next);
  if (prevItem(item, prevs) !== undefined) return countBlanks(item);
  if (pos > itemEndBeforeBlank(struct, item)) {
    const blanks = countBlanks(pos);
    if (blanks > 0) return blanks;
  }
  const top = lineAt(struct[0].pos);
  const limit = itemEndBeforeBlank(struct, item);
  for (let l = top; l < e8.lineCount() && e8.lineStart(l) <= limit; l++) {
    if (/^[ \t]*$/.test(e8.lineText(l)) && e8.lineEnd(l) <= limit) return 1;
  }
  return 0;
}

/** What org-blank-before-new-entry says for headings or list items: "auto" unless it says otherwise. */
export function blankBeforeNewEntry(kind: "heading" | "plain-list-item"): e8.Value {
  const alist = e8.variable("org-blank-before-new-entry");
  const entry = Array.isArray(alist) ? (alist.find((e) => Array.isArray(e) && e[0] === kind) as e8.Value[] | undefined) : undefined;
  return entry === undefined ? "auto" : (entry[1] ?? null);
}

/**
 * Inserts an item at pos, before the item there if pos is before its text,
 * as org-list-insert-item does, leaving point at the new item's start.
 */
function insertItemStruct(pos: number, struct: Struct, prevs: Alist, checkbox: boolean, afterBullet = ""): Struct {
  let item: number | undefined;
  for (const e of struct) {
    if (e.pos > pos) break;
    if (e.end < pos) continue;
    item = e.pos;
  }
  if (item === undefined) item = struct[struct.length - 1].pos;
  const it = getItem(struct, item);
  const itemEnd = it.end;
  const itemEndNoBlank = itemEndBeforeBlank(struct, item);
  const parts = itemParts(lineAt(item));
  // Before the text after the bullet, checkbox and tag, the new item goes before this one.
  let bodyStart = parts?.matchEnd ?? item;
  if (parts?.tagAt !== undefined && parts.tagEnd !== undefined) {
    if (/[.)]/.test(parts.bullet)) bodyStart = parts.tagAt;
    else {
      bodyStart = parts.tagEnd;
      while (/[ \t]/.test(e8.bufferText(bodyStart, bodyStart + 1))) bodyStart++;
    }
  }
  const beforep = pos <= bodyStart;
  const split = e8.variable("org-M-RET-may-split-line") !== false;
  const blankNb = separatingBlankLines(pos, item, struct, prevs);
  const { ind } = it;
  const tab = Number(e8.variable("tab-width") ?? 8);
  const indSize = e8.variable("indent-tabs-mode") === true ? Math.floor(ind / tab) + (ind % tab) : ind;
  const bullet = bulletString(it.bullet);
  const box = checkbox ? "[ ]" : undefined;
  let textCut: string | undefined;
  if (!beforep && split) {
    let q = pos;
    if (itemEnd < pos) {
      edDelete(itemEnd - 1, e8.lineEnd(lineAt(pos)));
      q = itemEnd - 1;
    }
    while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    let after = q;
    while (after < e8.bufferSize() && /[ \t]/.test(e8.bufferText(after, after + 1))) after++;
    pos = after;
    textCut = edDelete(q, Math.max(q, itemEndNoBlank));
  }
  const body = bullet + (box ? `${box} ` : "") + afterBullet + (textCut === undefined ? "" : textCut.replace(/^[ \t]+/, ""));
  const sep = "\n".repeat(blankNb + 1);
  const itemSize = indSize + charCount(body) + charCount(sep);
  const sizeOffset = itemSize - charCount(textCut ?? "");
  edInsert(item, indentString(ind) + body + sep);
  for (const e of struct) {
    const { pos: p, end } = e;
    if (p < item) {
      if (end > item) e.end = end + sizeOffset;
    } else if (p === item && !beforep && split) {
      e.pos = p + itemSize;
      e.end = end + sizeOffset;
    } else if (split && !beforep && p >= pos && p <= itemEndNoBlank) {
      const offset = pos - item - ind - charCount(bullet) - charCount(afterBullet);
      e.pos = p - offset;
      e.end = end - offset;
    } else {
      e.pos = p + sizeOffset;
      e.end = end + sizeOffset;
    }
  }
  struct.push({ pos: item, ind, bullet, checkbox: box, end: item + itemSize });
  struct.sort((a, b) => a.pos - b.pos);
  if (beforep) e8.gotoChar(item);
  else {
    struct = swapItems(item, item + itemSize, struct);
    e8.gotoChar(nextItem(item, prevsAlist(struct)) ?? item);
  }
  return struct;
}

/** The parents items between start and end get when outdented, as org-list-struct-outdent works them out. */
function structOutdent(start: number, end: number, struct: Struct, parents: Alist): Alist {
  const acc = new Map<number, number | undefined>();
  const out: Alist = new Map();
  for (const [item, parent] of parents) {
    if (item < start) out.set(item, parent);
    else if (item >= end) out.set(item, parent !== undefined && acc.has(parent) ? acc.get(parent) : parent);
    else if (parent === undefined) throw new Error("Cannot outdent top-level items");
    else if (parent >= start) {
      acc.set(parent, item);
      out.set(item, parent);
    } else {
      acc.set(parent, item);
      out.set(item, parents.get(parent));
    }
  }
  void struct;
  return out;
}

/** The parents items between start and end get when indented, as org-list-struct-indent works them out. */
function structIndent(start: number, end: number, struct: Struct, parents: Alist, prevs: Alist): Alist {
  const acc = new Map<number, number | undefined>();
  const out: Alist = new Map();
  for (const [item, parent] of parents) {
    if (item < start) out.set(item, parent);
    else if (item >= end) out.set(item, parent !== undefined && acc.has(parent) ? acc.get(parent) : parent);
    else {
      const prev = prevItem(item, prevs);
      if (prev === undefined && (parent === undefined || parent < start)) e8.userError("Cannot indent the first item of a list");
      let now: number | undefined;
      if (prev === undefined) now = parent;
      else if (prev < start) now = prev;
      else now = acc.get(prev);
      acc.set(item, now);
      out.set(item, now);
    }
  }
  void struct;
  return out;
}

/** Where the last M-S-<left> or M-S-<right> began and ended, so repeating it moves the same items, as Org's markers keep them. */
const lastIndentBegin = lastingMarker(0);
const lastIndentEnd = lastingMarker(0);

/**
 * Indents (arg > 0) or outdents an item, with its children unless
 * noSubtree, or the items in the region, as org-list-indent-item-generic
 * does. At the first item, the whole list moves.
 */
function indentItemGeneric(arg: number, noSubtree: boolean, struct: Struct): void {
  const saved = marker(e8.point());
  const region = orgRegionActive() && e8.mark() !== undefined;
  const mark = e8.mark() ?? e8.point();
  const [rbeg, rend] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  const top = struct[0].pos;
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const bol = e8.lineStart(lineAt());
  let special = false;
  if (!region && top === bol) {
    if (noSubtree) e8.userError("At first item: use S-M-<left/right> to move the whole list");
    special = true;
  }
  const shiftMeta = ["org-shiftmetaright", "org-shiftmetaleft"];
  if (!(shiftMeta.includes(e8.lastCommand() ?? "") && shiftMeta.includes(e8.thisCommand() ?? ""))) {
    lastIndentBegin.pos = region ? rbeg : bol;
    lastIndentEnd.pos = region ? rend : special ? bottomPoint(struct) : noSubtree ? bol + 1 : getItem(struct, bol).end;
  }
  const beg = lastIndentBegin.pos;
  const end = lastIndentEnd.pos;
  try {
    // As Org binds deactivate-mark to nil, a region stays active.
    e8.keepMarkActive(() => {
      if (special) {
        // Two columns with org-odd-levels-only, as org-level-increment says.
        const step = e8.variable("org-odd-levels-only") === true ? 2 : 1;
        const offset = arg < 0 ? -step : step;
        const first = struct.find((e) => e.pos === beg) ?? struct[0];
        const old = copyStruct(struct);
        if (first.ind + offset < 0) throw new Error("Cannot outdent beyond margin");
        if (first.ind + offset === 0 && first.bullet.includes("*")) first.bullet = bulletString("-");
        for (const e of struct) e.ind += offset;
        fixBul(struct, prevs);
        applyStruct(struct, old);
      } else if (
        arg < 0 &&
        ((noSubtree && !region && hasChild(struct, beg) !== undefined) ||
          hasChild(struct, [...struct].reverse().find((e) => e.pos < end)?.pos ?? beg) !== undefined)
      ) {
        throw new Error("Cannot outdent an item without its children");
      } else {
        const old = copyStruct(struct);
        const newParents = arg < 0 ? structOutdent(beg, end, struct, parents) : structIndent(beg, end, struct, parents, prevs);
        writeStruct(struct, newParents, old);
        updateCheckboxCount();
      }
    });
  } finally {
    e8.gotoChar(saved.pos);
    dropMarker(saved);
  }
}

/** The item point's line starts, for commands that need one, or an error. */
export function structAtItem(error = "Not at an item"): Struct {
  if (!itemLine(lineAt())) throw new Error(error);
  return listStruct(lineAt());
}

export function indentItemCommand(arg: number, noSubtree: boolean): void {
  const region = orgRegionActive() && e8.mark() !== undefined;
  const regionStart = region ? Math.min(e8.mark() ?? 0, e8.point()) : 0;
  if (itemLine(lineAt()) || (region && itemLine(lineAt(regionStart)))) {
    const struct = listStruct(region ? lineAt(regionStart) : lineAt());
    indentItemGeneric(arg, noSubtree, struct);
  } else if (region) throw new Error("Region not starting at an item");
  else throw new Error("Not at an item");
}

let tabIndState: [number, string] | undefined;

/**
 * Cycles an empty item's indentation, as org-cycle-item-indentation does
 * for TAB: in, then out a level at a time, then back where it was.
 * Returns whether it applied.
 */
export function cycleItemIndentation(): boolean {
  const line = lineAt();
  if (!itemLine(line)) return false;
  const struct = listStruct(line);
  const item = e8.lineStart(line);
  const { ind } = getItem(struct, item);
  const again = e8.lastCommand() === "org-cycle-item-indentation";
  const parts = itemParts(line);
  let end = getItem(struct, item).end;
  while (end > 0 && /[ \t\n]/.test(e8.bufferText(end - 1, end))) end--;
  if (!(again || (parts && parts.matchEnd >= end))) return false;
  e8.setThisCommand("org-cycle-item-indentation");
  const prevs = prevsAlist(struct);
  const parents = parentsAlist(struct);
  if (again && tabIndState) {
    const [oldInd, oldBul] = tabIndState;
    const allowOutdent = (s: Struct, pv: Alist, pa: Alist): boolean =>
      nextItem(item, pv) === undefined && hasChild(s, item) === undefined && pa.get(item) !== undefined;
    if (ind > oldInd && prevItem(item, prevs) !== undefined) indentItemGeneric(1, true, struct);
    else if (ind < oldInd && allowOutdent(struct, prevs, parents)) indentItemGeneric(-1, true, struct);
    else {
      edDelete(item, e8.lineEnd(line));
      edInsert(item, indentString(oldInd) + oldBul + " ");
      e8.gotoChar(e8.lineEnd(line));
      const fresh = listStruct(line);
      const freshParents = parentsAlist(fresh);
      if (ind > oldInd && allowOutdent(fresh, prevsAlist(fresh), freshParents)) indentItemGeneric(-1, true, fresh);
      else {
        writeStruct(fresh, freshParents);
        e8.setThisCommand("identity" as e8.CommandName);
      }
    }
    return true;
  }
  tabIndState = [ind, e8.lineText(line).trim()];
  if (prevItem(item, prevs) !== undefined) indentItemGeneric(1, true, struct);
  else if (nextItem(item, prevs) === undefined && parents.get(item) !== undefined) indentItemGeneric(-1, true, struct);
  else {
    e8.setThisCommand("identity" as e8.CommandName);
    e8.userError("Cannot move item");
  }
  return true;
}

/** Changes the bullets of the list at point, as org-cycle-list-bullet does. `which` is a bullet, "previous", or undefined for the next. */
export function cycleListBullet(which?: string): void {
  if (!itemLine(lineAt())) throw new Error("Not at an item");
  const origin = marker(e8.point());
  const line = lineAt();
  const bol = e8.lineStart(line);
  const struct = listStruct(line);
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const listBeg = firstItem(bol, prevs);
  const here = getItem(struct, bol);
  const offset = origin.pos - (bol + here.ind);
  const offset2 = origin.pos - (bol + here.ind + charCount(here.bullet));
  const bullet = getItem(struct, listBeg).bullet;
  const current = /\./.test(bullet) ? "1." : /\)/.test(bullet) ? "1)" : bullet.trim();
  const description = itemParts(line)?.tag !== undefined;
  const choices = ["-", "+", ...(/^\S/.test(e8.lineText(line)) ? [] : ["*"]), ...(description ? [] : ["1.", "1)"])];
  const k = choices.indexOf(current);
  const index = k < 0 ? choices.length : k;
  const get = (i: number): string => choices[((i % choices.length) + choices.length) % choices.length];
  const next = which !== undefined && choices.includes(which) ? which : which === "previous" ? get(index - 1) : get(index + 1);
  const old = copyStruct(struct);
  getItem(struct, listBeg).bullet = bulletString(next);
  fixBul(struct, prevs);
  fixInd(struct, parents);
  e8.gotoChar(bol);
  applyStruct(struct, old);
  const fresh = listStruct(lineAt(origin.pos));
  const at = e8.lineStart(lineAt(origin.pos));
  const item = fresh.find((e) => e.pos === at);
  if (item && offset2 >= 0) e8.gotoChar(at + item.ind + charCount(item.bullet) + offset2);
  else if (item && offset >= 0) e8.gotoChar(at + item.ind + offset);
  else e8.gotoChar(origin.pos);
  dropMarker(origin);
}

/** Inserts an item, with a checkbox if asked, as org-insert-item does. Returns whether point was in an item. */
export function insertListItem(checkbox: boolean): boolean {
  const start = inItem(lineAt());
  if (start === undefined || e8.invisibleAt(start)) return false;
  const pos = e8.point();
  let struct = listStruct(lineAt(start));
  const prevs = prevsAlist(struct);
  const first = getItem(struct, firstItem(start, prevs));
  const description = !/[0-9A-Za-z]/.test(first.bullet) && first.tag !== undefined;
  struct = insertItemStruct(pos, struct, prevs, checkbox, description ? " :: " : "");
  writeStruct(struct, parentsAlist(struct));
  if (checkbox) updateCheckboxCount();
  const line = lineAt();
  e8.gotoChar(e8.lineStart(line));
  const parts = itemParts(line);
  if (parts) e8.gotoChar(parts.matchEnd);
  if (description) e8.gotoChar(e8.point() - 1);
  return true;
}

export function moveItemDown(): void {
  if (!itemLine(lineAt())) throw new Error("Not at an item");
  const col = e8.point() - e8.lineStart(lineAt());
  const item = e8.lineStart(lineAt());
  let struct = listStruct(lineAt());
  const next = nextItem(item, prevsAlist(struct));
  if (next === undefined) e8.userError("Cannot move this item further down");
  struct = swapItems(item, next, struct);
  e8.gotoChar(nextItem(item, prevsAlist(struct)) ?? item);
  writeStruct(struct, parentsAlist(struct));
  moveToColumn(col);
}

export function moveItemUp(): void {
  if (!itemLine(lineAt())) throw new Error("Not at an item");
  const col = e8.point() - e8.lineStart(lineAt());
  const item = e8.lineStart(lineAt());
  let struct = listStruct(lineAt());
  const prev = prevItem(item, prevsAlist(struct));
  if (prev === undefined) e8.userError("Cannot move this item further up");
  struct = swapItems(prev, item, struct);
  writeStruct(struct, parentsAlist(struct));
  moveToColumn(col);
}

export function previousItem(): void {
  const item = inItem(lineAt());
  if (item === undefined) throw new Error("Not in an item");
  e8.gotoChar(item);
  const prev = prevItem(item, prevsAlist(listStruct(lineAt(item))));
  if (prev === undefined) throw new Error("On first item");
  e8.gotoChar(prev);
}

export function nextListItem(): void {
  const item = inItem(lineAt());
  if (item === undefined) throw new Error("Not in an item");
  e8.gotoChar(item);
  const next = nextItem(item, prevsAlist(listStruct(lineAt(item))));
  if (next === undefined) throw new Error("On last item");
  e8.gotoChar(next);
}

/**
 * Ticks or unticks the checkbox on point's item line, or the first one
 * under a heading or in the region and the rest like it, as
 * org-toggle-checkbox does. With C-u, adds or removes checkboxes.
 */
export function toggleCheckbox(arg: e8.PrefixArg): void {
  if (atRadioList()) return toggleRadioButton(arg);
  const saved = marker(e8.point());
  const presence = Array.isArray(arg) && arg[0] === 4;
  const ordered = orderedHere();
  let single = false;
  try {
    let limUp: number;
    let limDown: Marker;
    const firstItemFrom = (from: number, limit: number): number | undefined => {
      for (let l = lineAt(from); l < e8.lineCount() && e8.lineStart(l) < limit; l++) {
        if (e8.lineStart(l) >= from && itemLine(l)) return e8.lineStart(l);
      }
      return undefined;
    };
    if (orgRegionActive() && e8.mark() !== undefined) {
      const [rb, re] = [Math.min(e8.mark() ?? 0, e8.point()), Math.max(e8.mark() ?? 0, e8.point())];
      const found = firstItemFrom(e8.lineStart(lineAt(rb)), re);
      if (found === undefined) throw new Error("No item in region");
      limUp = found;
      limDown = marker(re);
    } else if (parseHeading(lineAt())) {
      const all = headings();
      const i = headingIndex(all, lineAt()) as number;
      const limit = all[i + 1]?.start ?? e8.bufferSize();
      const found = firstItemFrom(endOfMetaData(all[i], true), limit);
      if (found === undefined) throw new Error("No item in subtree");
      limUp = found;
      limDown = marker(limit);
    } else if (itemLine(lineAt())) {
      single = true;
      limUp = e8.lineStart(lineAt());
      limDown = marker(e8.lineEnd(lineAt()));
    } else throw new Error("Not at an item or heading, and no active region");
    // As org-at-item-checkbox-p sees it: a box needs blanks after it.
    const parts = itemParts(lineAt(limUp));
    const box = parts?.boxAt !== undefined && /^[ \t]/.test(e8.bufferText(parts.boxAt + 3, parts.boxAt + 4)) ? parts.checkbox : undefined;
    const ref = Array.isArray(arg) && arg[0] === 16 ? "[-]" : presence ? (box ? undefined : "[ ]") : box === "[X]" ? "[ ]" : "[X]";
    let at = limUp;
    while (at < limDown.pos) {
      const found = firstItemFrom(at, limDown.pos);
      if (found === undefined) break;
      const struct = listStruct(lineAt(found));
      const old = copyStruct(struct);
      const parents = parentsAlist(struct);
      const bottom = marker(bottomPoint(struct));
      for (const e of struct) {
        if (e.pos < limUp || e.pos > limDown.pos) continue;
        if (e.checkbox !== undefined || presence) e.checkbox = ref;
      }
      const blocking = fixBox(struct, parents, ordered);
      // An ORDERED entry's box ticked out of turn, as Org reports it.
      if (single && blocking !== undefined && limUp > blocking) {
        dropMarker(bottom);
        dropMarker(limDown);
        throw new Error(`Checkbox blocked because of unchecked box at line ${currentLine(blocking)}`);
      }
      if (blocking !== undefined) e8.message(`Checkboxes were removed due to unchecked box at line ${currentLine(blocking)}`);
      applyStruct(struct, old);
      at = bottom.pos;
      dropMarker(bottom);
    }
    dropMarker(limDown);
  } finally {
    e8.gotoChar(saved.pos);
    dropMarker(saved);
  }
  updateCheckboxCount();
}

// Radio buttons: a list whose checkboxes allow one ticked, as Org's
// #+ATTR_ORG: :radio t and org-list-checkbox-radio-mode make them.

/**
 * Whether point's line is an item of a radio list: the innermost list it
 * is in has `:radio` other than nil in an #+ATTR_ORG: line among its
 * affiliated keywords, as org-at-radio-list-p.
 */
export function atRadioList(): boolean {
  const line = lineAt();
  if (!itemLine(line)) return false;
  let e = elementAt(e8.lineStart(line));
  while (e && e.type !== "plain-list") e = e.parent;
  if (!e) return false;
  // The keywords directly above the list, the nearest first, as Org searches back from its first item.
  for (let l = lineAt(e.begin) - 1; l >= 0 && AFFILIATED.test(e8.lineText(l)); l--) {
    const m = /^[ \t]*#\+attr_org:.* :radio (\S+)/i.exec(e8.lineText(l));
    if (m) return m[1] !== "nil";
  }
  return false;
}

/**
 * Ticks the item at point and unticks the others of its list, as
 * org-toggle-radio-button: C-u takes the item's box away, or with no box
 * gives every item an empty one; C-u C-u makes it [-].
 */
export function toggleRadioButton(arg: e8.PrefixArg): void {
  const line = lineAt();
  if (!itemLine(line)) e8.userError("Cannot toggle checkbox outside of a list");
  const cpos = e8.lineStart(line);
  const struct = listStruct(line);
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const old = copyStruct(struct);
  const cbox = getItem(struct, cpos).checkbox;
  const items = allItems(cpos, prevs);
  const c4 = Array.isArray(arg) && arg[0] === 4;
  const c16 = Array.isArray(arg) && arg[0] === 16;
  // Org leaves out the empty boxes only for C-u on the list's first item with a box.
  const fresh = cbox && c4 && items[0] === cpos ? undefined : "[ ]";
  for (const pos of items) getItem(struct, pos).checkbox = fresh;
  if (fresh !== undefined) getItem(struct, cpos).checkbox = c4 ? (cbox ? undefined : "[ ]") : c16 ? (cbox ? undefined : "[-]") : cbox === "[X]" ? "[ ]" : "[X]";
  fixBox(struct, parents, orderedHere());
  applyStruct(struct, old);
  updateCheckboxCount();
}

e8.defineMinorMode({
  name: "org-list-checkbox-radio-mode",
  doc: "Make the checkboxes of Org's lists radio buttons: C-c C-c on an item ticks it and unticks the others.",
  lighter: " CheckBoxRadio",
  onChange: () => {
    if (e8.variable("major-mode") !== "org-mode") e8.userError("Cannot turn this mode outside org-mode buffers");
  },
});

/** Whether C-c C-c treats point's list as radio buttons, as its list says or org-list-checkbox-radio-mode. */
export function radioButtonsHere(): boolean {
  return atRadioList() || e8.variable("org-list-checkbox-radio-mode") === true;
}

e8.defineCommand({
  name: "org-toggle-radio-button",
  doc: "Tick the checkbox of the item at point and untick the others of its list. With C-u, take its box away; with C-u C-u, make it [-].",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => toggleRadioButton(arg),
});

/**
 * Where a heading's planning line and property drawer end, as
 * org-end-of-meta-data does: with `full`, clock lines, blank lines and the
 * logbook too, and with `true` any drawer.
 */
export function endOfMetaData(h: Heading, full: boolean | "logbook" = false): number {
  let l = h.line + 1;
  if (l < e8.lineCount() && PLANNING.test(e8.lineText(l))) l++;
  const close = propertyDrawerEnd(l);
  if (close !== undefined) l = close + 1;
  if (full && !(l < e8.lineCount() && isHeadingLine(e8.lineText(l)))) {
    while (l < e8.lineCount()) {
      const text = e8.lineText(l);
      if (/^[ \t]*$/.test(text) || /^[ \t]*CLOCK:/.test(text)) {
        if (l === e8.lineCount() - 1) return e8.bufferSize();
        l++;
      } else if (/^[ \t]*:LOGBOOK:[ \t]*$/i.test(text) || (full === true && DRAWER_RE.test(text))) {
        const e = drawerEnd(l, e8.bufferSize());
        if (e === undefined) break;
        l = e + 1;
      } else break;
    }
  }
  return lineStartOrEnd(l);
}

/** The closing line of a property drawer starting at a line, as org-property-drawer-re matches one. */
function propertyDrawerEnd(line: number): number | undefined {
  if (line >= e8.lineCount() || !/^[ \t]*:PROPERTIES:[ \t]*$/i.test(e8.lineText(line))) return undefined;
  for (let l = line + 1; l < e8.lineCount(); l++) {
    const text = e8.lineText(l);
    if (/^[ \t]*:END:[ \t]*$/i.test(text)) return l;
    if (!/^[ \t]*:\S+:(?:[ \t].*)?[ \t]*$/.test(text)) return undefined;
  }
  return undefined;
}

/** Indents a line as org-indent-line does; org.ts, which has it, sets it. */
let lineIndenter: (line: number) => void = () => {};

export function setLineIndenter(f: (line: number) => void): void {
  lineIndenter = f;
}

/**
 * Sets a property in a heading's property drawer, adding the drawer after
 * its planning line, folded, if there is none, as org-entry-put does.
 */
export function entryPut(headingLine: number, property: string, value: string): void {
  withoutFoldChecks(() => {
    let line = headingLine + 1;
    if (line < e8.lineCount() && PLANNING.test(e8.lineText(line))) line++;
    if (propertyDrawerEnd(line) === undefined) {
      let at = lineStartOrEnd(line);
      if (at === e8.lineStart(lineAt(at)) && at > 0 && (line < e8.lineCount() || e8.bufferText(at - 1, at) === "\n")) at--;
      const begin = at === 0 ? 0 : at + 1;
      e8.gotoChar(at);
      if (at > 0) edInsert(at, "\n");
      edInsert(e8.point(), ":PROPERTIES:\n:END:");
      const endPos = e8.point();
      hideOverlay(e8.lineEnd(lineAt(endPos) - 1), endPos, "org-hide-drawer");
      if (endPos === e8.bufferSize() || begin === 0) edInsert(endPos, "\n");
      line = lineAt(begin);
      // Indented as Org indents it, as org-insert-property-drawer's org-indent-region.
      e8.saveExcursion(() => {
        for (const l of [line, line + 1]) lineIndenter(l);
      });
    }
    const close = propertyDrawerEnd(line) as number;
    const re = new RegExp(`^[ \\t]*:${escapeRegExp(property)}:`, "i");
    let at: number | undefined;
    for (let l = line + 1; l < close; l++) {
      if (re.test(e8.lineText(l))) {
        at = e8.lineStart(l);
        edDelete(at, e8.lineEnd(l));
        break;
      }
    }
    if (at === undefined) {
      at = e8.lineStart(close);
      edInsert(at, "\n");
    }
    edInsert(at, `:${property}: ${value}`);
    // As org-entry-put ends with org-indent-line, which indents the line and aligns a property's value.
    const propertyLine = lineAt(at);
    e8.saveExcursion(() => {
      e8.gotoChar(e8.lineStart(propertyLine));
      lineIndenter(propertyLine);
    });
  });
}

/**
 * A property's values in the property drawer under `headingLine`, as
 * org--property-local-values reads them with literal nil: the base value,
 * the last NAME line's, and each NAME+ line's in order, ignoring case.
 * Undefined when the drawer has neither.
 */
export function propertyLocalValues(headingLine: number, property: string): [string | undefined, string[]] | undefined {
  let line = headingLine + 1;
  if (line < e8.lineCount() && PLANNING.test(e8.lineText(line))) line++;
  const close = propertyDrawerEnd(line);
  if (close === undefined) return undefined;
  const re = new RegExp(`^[ \\t]*:${escapeRegExp(property)}(\\+?):(?:[ \\t]+(.*?))?[ \\t]*$`, "i");
  let base: string | undefined;
  const extra: string[] = [];
  for (let l = line + 1; l < close; l++) {
    const m = re.exec(e8.lineText(l));
    if (!m) continue;
    // As the parser's plist-put: a later NAME line replaces an earlier one.
    if (m[1] === "+") extra.push(m[2] ?? "");
    else base = m[2] ?? "";
  }
  return base === undefined && extra.length === 0 ? undefined : [base, extra];
}

/**
 * A property's values in the drawer before the first heading, as the
 * org-data element has them: the drawer comes first in the buffer, after
 * blank lines and then comment lines only.
 */
export function topLocalValues(property: string): [string | undefined, string[]] | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const n = e8.lineCount();
    let l = 0;
    // As org-skip-whitespace, then comments as org-at-comment-p sees them.
    while (l < n && /^[ \t]*$/.test(e8.lineText(l))) l++;
    while (l < n && /^[ \t]*#(?: |$)/.test(e8.lineText(l))) l++;
    if (l >= n || !/^[ \t]*:PROPERTIES:[ \t]*$/i.test(e8.lineText(l))) return undefined;
    // propertyLocalValues looks under a heading line, so ask from the line before the drawer.
    return propertyLocalValues(l - 1, property);
  });
}

/** What joins a property's values, as org--property-get-separator finds it in org-property-separators, else a space. */
export function propertySeparator(property: string): string {
  const specs = e8.variable("org-property-separators");
  if (!Array.isArray(specs)) return " ";
  const caseFold = e8.variable("case-fold-search");
  for (const spec of specs) {
    if (!Array.isArray(spec) || typeof spec[1] !== "string") continue;
    const key = spec[0];
    // As string-match-p, which leaves the match data alone.
    if (Array.isArray(key) ? key.includes(property) : typeof key === "string" && e8.emacsRegexp(key, { caseFold: caseFold !== false && caseFold !== null }).test(property)) {
      return spec[1];
    }
  }
  return " ";
}

/**
 * A property's value in a heading's property drawer, as org-entry-get
 * reads it without inheritance, ignoring case: the base value and the
 * NAME+ values joined by the property's separator. "nil" is no value
 * unless `literalNil`.
 */
export function entryGet(headingLine: number, property: string, literalNil = false): string | undefined {
  return localValue(propertyLocalValues(headingLine, property), property, literalNil);
}

/** A property's value in the drawer before the first heading, as org-entry-get reads it there without inheritance. */
export function topGet(property: string, literalNil = false): string | undefined {
  return localValue(topLocalValues(property), property, literalNil);
}

/** One value from an element's base and NAME+ values, as org-entry-get joins them. */
function localValue(local: [string | undefined, string[]] | undefined, property: string, literalNil: boolean): string | undefined {
  if (local === undefined) return undefined;
  const [base, extra] = local;
  const values = (literalNil || base !== "nil") && base !== undefined ? [base, ...extra] : extra;
  if (values.length === 0) return undefined;
  const value = values.join(propertySeparator(property));
  return literalNil || value !== "nil" ? value : undefined;
}

/** The properties Org works out itself, which org-entry-put cannot set, as org-special-properties lists them. */
const SPECIAL_PROPERTIES = [
  "ALLTAGS", "BLOCKED", "CLOCKSUM", "CLOCKSUM_T", "CLOSED", "FILE", "ITEM", "TAGS", "TIMESTAMP", "TIMESTAMP_IA",
];

/** The heading whose entry point is in, as org-back-to-heading with invisible-ok finds it. */
export function entryHeading(): Heading | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : all[i];
}

export const setProperty = e8.defineCommand({
  name: "org-set-property",
  doc: "In the current entry, set a property to a value, adding a property drawer if there is none.",
  params: [
    { name: "property", kind: "string", prompt: "Property: " },
    { name: "value", kind: "string", prompt: "Value: " },
  ],
  run: (property, value) => {
    if (property === "" || /\s/.test(property)) throw new Error(`Invalid property name: "${property}"`);
    const h = entryHeading();
    if (!h) throw new Error("Before first headline at position 1 in buffer " + e8.bufferName());
    const upper = property.toUpperCase();
    if (upper === "TODO") {
      if (value !== "" && !allKeywords().includes(value)) throw new Error(`"${value}" is not a valid TODO state`);
      // As org-todo, as org-entry-put changes it, so dependencies and logging apply.
      e8.saveExcursion(() => {
        e8.gotoChar(h.start);
        e8.call("org-todo-set", value);
      });
      return;
    }
    if (SPECIAL_PROPERTIES.includes(upper)) throw new Error(`The ${property} property cannot be set with \`org-entry-put'`);
    if (entryGet(h.line, property) === value) return;
    const p = marker(e8.point());
    entryPut(h.line, property, value);
    e8.gotoChar(p.pos);
    dropMarker(p);
  },
});

e8.defineCommand({
  name: "org-delete-property",
  doc: "In the current entry, delete a property, and the property drawer with it if that leaves it empty.",
  params: [{ name: "property", kind: "string", prompt: "Property: " }],
  run: (property) => {
    const h = entryHeading();
    if (!h) throw new Error("Before first headline at position 1 in buffer " + e8.bufferName());
    let line = h.line + 1;
    if (line < e8.lineCount() && PLANNING.test(e8.lineText(line))) line++;
    const close = propertyDrawerEnd(line);
    if (close === undefined) {
      e8.message("No property to delete in this entry");
      return;
    }
    const p = marker(e8.point());
    // The property and its accumulated form, PROPERTY+, as org-entry-delete removes them.
    const re = new RegExp(`^[ \\t]*:${escapeRegExp(property)}\\+?:`, "i");
    let end = close;
    for (let l = line + 1; l < end; ) {
      if (re.test(e8.lineText(l))) {
        edDelete(e8.lineStart(l), e8.lineStart(l + 1));
        end--;
      } else l++;
    }
    // An emptied drawer goes altogether.
    if (end === line + 1) edDelete(e8.lineStart(line), lineStartOrEnd(line + 2));
    e8.gotoChar(p.pos);
    dropMarker(p);
    e8.message(`Property "${property}" deleted`);
  },
});

e8.defineCommand({
  name: "org--insert-named-drawer",
  doc: "Insert a drawer of the name given at point, with point inside it, as org-insert-drawer does without a prefix argument.",
  params: [{ name: "drawer", kind: "string", prompt: "Drawer: " }],
  run: (drawer) => {
    if (!/^[\w-]+$/.test(drawer)) e8.userError("Invalid drawer name");
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    e8.insert(`:${drawer}:\n\n:END:\n`);
    e8.gotoChar(e8.lineStart(lineAt() - 2));
  },
});

export const insertDrawer = e8.defineCommand({
  name: "org-insert-drawer",
  doc:
    "Insert a drawer at point, asking for its name, with point inside it.\n\n" +
    "With a prefix argument, insert the entry's property drawer instead.",
  run: () => {
    if (e8.prefixArg() === null) {
      // The name is asked for only without a prefix argument, as Org's interactive form does.
      e8.callInteractively("org--insert-named-drawer");
      return;
    }
    {
      const h = entryHeading();
      if (!h) throw new Error("Before first headline at position 1 in buffer " + e8.bufferName());
      let line = h.line + 1;
      if (line < e8.lineCount() && PLANNING.test(e8.lineText(line))) line++;
      if (propertyDrawerEnd(line) === undefined) {
        // An empty drawer made and opened, with a line inside it, as
        // org-insert-property-drawer and org-insert-drawer leave it.
        entryPut(h.line, "X", "");
        const close = propertyDrawerEnd(line) as number;
        edDelete(e8.lineStart(close - 1), e8.lineStart(close));
      }
      const close = propertyDrawerEnd(line) as number;
      flag(e8.lineEnd(line), e8.lineStart(close), false, "org-hide-drawer");
      e8.gotoChar(e8.lineStart(close));
      if (close === line + 1) {
        e8.insert("\n");
        e8.gotoChar(e8.point() - 1);
      }
    }
  },
});
