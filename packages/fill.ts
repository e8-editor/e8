// Filling, after Emacs's fill.el, with auto-fill-mode, do-auto-fill and
// set-fill-column from simple.el. M-q fills the paragraph at or after point,
// or the region when it is active, so no line passes fill-column; with a
// prefix argument it also justifies, lining both edges up. A paragraph's
// lines keep the prefix they share, such as "> " or "  - ", as Adaptive Fill
// mode finds it. Auto Fill mode breaks a line as you type a space past
// fill-column. Two spaces after a period end a sentence, as
// sentence-end-double-space says, and filling keeps them.

import { commentNormalizeVars, commentSearchForward, commentStringStrip, otherLineBreak } from "newcomment";
import { forwardParagraph as paragraphsForward } from "paragraphs";
import { allMatches, barfIfBufferReadOnly, forwardLine, regexpQuote, truthy, escapeRegExp } from "subr";

e8.defineVariable({
  name: "fill-column",
  doc: "The column filling breaks lines before. Each buffer has its own; C-x f sets it.",
  value: 70,
  local: true,
});
e8.defineVariable({
  name: "fill-prefix",
  doc: "Text filling puts at the start of each line, or nil to work it out from the paragraph when adaptive-fill-mode is on. C-x . sets it.",
  value: null,
  local: true,
});
e8.defineVariable({
  name: "adaptive-fill-mode",
  doc: "Whether filling takes a paragraph's fill prefix from its text, as its second line starts, or its first if it has one line.",
  value: true,
});
e8.defineVariable({
  name: "adaptive-fill-regexp",
  doc: "What a fill prefix in a paragraph's text looks like, as a regular expression matched at the start of a line.",
  value: "[-\u2013!|#%;>*\u00b7\u2022\u2023\u2043\u25e6 \t]*",
});
e8.defineVariable({
  name: "adaptive-fill-function",
  doc: "A function giving the fill prefix of the line at point, or nil to try adaptive-fill-regexp, as Org gives one.",
  value: null,
  local: true,
});
e8.defineVariable({
  name: "adaptive-fill-first-line-regexp",
  doc: "What the prefix of a paragraph's only line must look like for the lines filling makes to take it too; otherwise they take as many spaces.",
  value: "\\`[ \t]*\\'",
});
e8.defineVariable({
  name: "sentence-end-double-space",
  doc: "Whether a sentence ends with two spaces after its period, so a period followed by one space is no end of sentence, and filling keeps two.",
  value: true,
});
e8.defineVariable({
  name: "colon-double-space",
  doc: "Whether filling leaves two spaces after a colon.",
  value: false,
});
e8.defineVariable({
  name: "default-justification",
  doc: "How filling lines lines up: left, full (both edges), or none.",
  value: "left",
  local: true,
});
e8.defineVariable({
  name: "fill-nobreak-predicate",
  doc: "Functions called, with point where a line would break, to say it must not break there; any true stops it, as Org's keep a timestamp whole.",
  value: [],
  local: true,
});
e8.defineVariable({
  name: "normal-auto-fill-function",
  doc: "The command Auto Fill mode puts in auto-fill-function. Some major modes set it.",
  value: "do-auto-fill",
});
e8.defineVariable({
  name: "fill-forward-paragraph-function",
  doc: "The function filling moves over paragraphs with, given how many and returning how many it could not, as Org sets it.",
  value: "forward-paragraph",
  local: true,
});
e8.defineVariable({
  name: "fill-paragraph-handle-comment",
  doc: "Whether M-q fills a comment as a comment, with its comment starts, and keeps code and comments apart.",
  value: true,
  local: true,
});
e8.defineVariable({
  name: "fill-paragraph-function",
  doc: "A command M-q runs instead of filling plain text, as major modes such as Org set it, or nil.",
  value: null,
  local: true,
});

const fillColumn = (): number => {
  const v = e8.variable("fill-column");
  return typeof v === "number" ? v : 70;
};
const charAt = (p: number): string => e8.charAfter(p) ?? "";
const charBefore = (p: number): string => e8.charBefore(p) ?? "";
const bolAt = (p: number): number => e8.lineBeginningPosition(p);
const eolAt = (p: number): number => e8.lineEndPosition(p);
const bolp = (): boolean => e8.point() === bolAt(e8.point());
const eolp = (): boolean => e8.point() === eolAt(e8.point());
const eobp = (): boolean => e8.point() >= e8.bufferSize();

/** Moves forward over characters in `chars`, not past `limit`, as skip-chars-forward. */
const skipForward = (chars: string, limit?: number): number => e8.skipCharsForward(chars, limit);
/** Moves back over characters in `chars`, not before `limit`, as skip-chars-backward. Returns how far it went. */
const skipBackward = (chars: string, limit?: number): number => -e8.skipCharsBackward(chars, limit);
/** Where an Emacs regexp matching at `p`, within its line, ends, as looking-at. */
function lookingAt(regexp: string, p: number): number | undefined {
  const m = e8.search(regexp, { from: p, regexp: true, bound: eolAt(p), caseFold: false });
  return m !== undefined && m.start === p ? m.end : undefined;
}
const marker = (pos: number, advances = false): e8.Marker => e8.makeMarker(pos, { advances });
const at = (m: e8.Marker): number => e8.markerPosition(m)!;
const free = (...ms: e8.Marker[]): void => ms.forEach((m) => e8.deleteMarker(m));
const saveExcursion = <T>(fn: () => T): T => e8.saveExcursion(fn);
function barfIfReadOnly(): void {
  barfIfBufferReadOnly();
}

/** How to justify, as current-justification: undefined for none. */
function currentJustification(): string | undefined {
  const j = e8.variable("default-justification");
  return j === "none" || typeof j !== "string" ? undefined : j;
}

// --- The fill prefix -------------------------------------------------------

/** The adaptive prefix at point, as fill-match-adaptive-prefix: none if as long as the fill column. */
function matchAdaptivePrefix(): string | undefined {
  // The mode's function first, as Org's, then the regexp.
  const fn = e8.variable("adaptive-fill-function");
  let str: string | undefined;
  if (truthy(fn ?? null)) {
    const got = e8.saveExcursion(() => e8.funcall(fn as string));
    if (typeof got === "string") str = got;
  }
  if (str === undefined) {
    const re = e8.variable("adaptive-fill-regexp");
    if (typeof re !== "string") return undefined;
    const end = lookingAt(re, e8.point());
    if (end === undefined) return undefined;
    str = e8.bufferText(e8.point(), end);
  }
  return str.length >= fillColumn() ? undefined : str;
}

/** The longest start two strings share, as fill-common-string-prefix, or undefined if none. */
function commonPrefix(a: string, b: string): string | undefined {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === 0 ? undefined : a.slice(0, i);
}


/** The fill prefix a paragraph's text suggests, as fill-context-prefix. */
export function fillContextPrefix(from: number, to: number): string | undefined {
  return saveExcursion(() => {
    e8.gotoChar(from);
    if (eolp()) forwardLine(1);
    e8.gotoChar(bolAt(e8.point()));
    let first = matchAdaptivePrefix();
    forwardLine(1);
    const paragraphStart = e8.variable("paragraph-start");
    if (e8.point() < to) {
      // None from a line that starts a paragraph.
      const second = typeof paragraphStart === "string" && e8.lookingAt(paragraphStart) ? undefined : matchAdaptivePrefix();
      if (second === undefined) return undefined;
      first ??= "";
      // The second line's prefix if the first has its words in order, as
      // "/* " and " * " do; else what the two share.
      let re = "\\`";
      for (const word of second.match(/[^ \t]+/g) ?? []) re += ".*" + regexpQuote(word);
      return e8.stringMatch(re, first) !== undefined ? second : commonPrefix(first, second);
    }
    if (first === undefined) return undefined;
    // The first line's prefix for every line if it looks like one, as a comment start does; else as many spaces.
    const firstLine = e8.variable("adaptive-fill-first-line-regexp");
    const skip = e8.variable("comment-start-skip");
    const result =
      (typeof firstLine === "string" && e8.stringMatch(firstLine, first) !== undefined) ||
      (typeof skip === "string" && e8.stringMatch(skip, first) !== undefined)
        ? first
        : " ".repeat(e8.stringWidth(first));
    // Not one that would start a paragraph with text after it.
    return typeof paragraphStart === "string" && e8.stringMatch(paragraphStart, result + "a") === 0 ? undefined : result;
  });
}

/** Deletes the fill prefix from each line after the first, as fill-delete-prefix; point goes past the first's. */
function fillDeletePrefix(from: number, to: e8.Marker, prefix: string | undefined): number {
  const words = prefix !== undefined && !/^[ \t]*$/.test(prefix);
  const fpre = words
    ? new RegExp(`^[ \\t]*(?:${escapeRegExp(prefix!).replace(/[ \t]+/g, "[ \\t]*")})?[ \\t]*`)
    : /^[ \t]*/;
  e8.gotoChar(from);
  forwardLine(1);
  while (e8.point() < at(to)) {
    const m = fpre.exec(e8.lineText(e8.lineOf(e8.point())))!;
    if (m[0].length > 0) e8.deleteRegion(e8.point(), e8.point() + m[0].length);
    forwardLine(1);
    if (eobp()) break;
  }
  e8.gotoChar(from);
  const m = fpre.exec(e8.bufferText(from, eolAt(from)))!;
  e8.gotoChar(from + m[0].length);
  return e8.point();
}

// --- Spaces between words and sentences --------------------------------------

/** A sentence's end, as (sentence-end) with its defaults: its punctuation, then two spaces or the end of a line. */
function sentenceEnd(): string {
  const spacing = truthy(e8.variable("sentence-end-double-space"))
    ? "(?:$|[ \u00a0]$|\t|[ \u00a0][ \u00a0])"
    : "(?:$|[\t \u00a0])";
  return `(?:[.?!\u2026\u203d][\\]"'\u201d\u2019)}\u00bb\u203a]*${spacing}|[\u3002\uff0e\uff1f\uff01]+)[ \u00a0\t\n]*`;
}

/**
 * Leaves one space between words and two after a sentence or colon, as
 * sentence-end-double-space and colon-double-space say, and turns tabs into
 * spaces, as canonically-space-region.
 */
function canonicallySpaceRegion(beg: number, endMarker: e8.Marker): void {
  // Tabs become spaces, in place.
  e8.substCharInRegion(beg, at(endMarker), "\t", " ");
  const text = e8.bufferText(beg, at(endMarker));
  const double = truthy(e8.variable("sentence-end-double-space"));
  const colon = truthy(e8.variable("colon-double-space"));
  const re = new RegExp(`(${sentenceEnd()}) *|  +`, "gmu");
  const before = e8.bufferText(bolAt(beg), beg);
  const full = before + text;
  const deletions: [number, number][] = [];
  for (const m of allMatches(re, text)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (m[1] !== undefined) {
      const end1 = start + m[1].length;
      if (end > end1) {
        deletions.push([end1, end]);
      } else {
        // Keep at most two spaces after the sentence.
        let back = end;
        while (back > start && text[back - 1] === " ") back--;
        deletions.push([Math.min(end, back + (double ? 2 : 1)), end]);
      }
    } else {
      // What comes before the spaces, looking past closing brackets, into
      // the line before the region if need be.
      let back = before.length + start;
      while (back > 0 && " ]})\"'".includes(full[back - 1])) back--;
      const prev = back > 0 ? full[back - 1] : "\n";
      const keep = double && ".?!".includes(prev) ? 2 : colon && prev === ":" ? 2 : prev === "\n" ? 0 : 1;
      deletions.push([start + keep, end]);
    }
  }
  // The offsets are UTF-16 units of the text; the buffer counts characters.
  const pos = (i: number): number => beg + [...text.slice(0, i)].length;
  for (const [a, b] of deletions.reverse()) if (b > a) e8.deleteRegion(pos(a), pos(b));
}

/** Joins a paragraph's lines into one, as fill-delete-newlines: two spaces after a sentence ending a line. */
function fillDeleteNewlines(from: number, to: e8.Marker, justify: string | undefined, squeezeAfter?: number): void {
  // A sentence that ends a line gets a second space.
  const end = new RegExp(`[.?!\u2026\u203d][\\]"'\u201d\u2019)}\u00bb\u203a]*$`, "u");
  for (let line = e8.lineOf(at(to)) - 1; line >= e8.lineOf(from); line--) {
    const e = e8.lineEnd(line);
    if (e < at(to) && e >= from && end.test(e8.bufferText(e8.lineStart(line), e))) {
      e8.gotoChar(e);
      e8.insertAndInherit(" ");
    }
  }
  e8.gotoChar(from);
  skipForward(" \t");
  const squeezeFrom = e8.point();
  // Newlines become spaces, in place.
  e8.substCharInRegion(from, at(to), "\n", " ");
  void justify;
  canonicallySpaceRegion(squeezeAfter ?? squeezeFrom, to);
  // No whitespace at the end.
  e8.gotoChar(at(to));
  const n = skipBackward(" \t");
  if (n > 0) e8.deleteRegion(e8.point(), e8.point() + n);
  e8.gotoChar(from);
}

// --- Breaking lines --------------------------------------------------------

/** Whether a line must not break at point, as fill-nobreak-p: after a period and one space, or before what would start a paragraph. */
function fillNobreakP(): boolean {
  if (bolp()) return false;
  const p = e8.point();
  if (truthy(e8.variable("sentence-end-double-space"))) {
    let q = p;
    while (q > 0 && charBefore(q) === " ") q--;
    if (charBefore(q) === "." && charAt(q) === " " && q + 1 < e8.pointMax() && !" \n".includes(charAt(q + 1))) {
      return true;
    }
  }
  // Not where the rest of the line would start a paragraph, as paragraph-start says.
  let q = p;
  while (q < e8.pointMax() && " \t".includes(charAt(q))) q++;
  if (q < e8.pointMax() && charAt(q) !== "\n") {
    const start = e8.variable("paragraph-start");
    if (typeof start === "string" ? e8.lookingAt(start, q) : charAt(q) === "\f") return true;
  }
  // Nor where a mode's fill-nobreak-predicate says not, as Org's keep timestamps and line breaks whole.
  for (const f of (e8.variable("fill-nobreak-predicate") ?? []) as e8.Value[]) {
    if (truthy(e8.funcall(f as string))) return true;
  }
  return false;
}

/** Moves back to where the line should break, after `linebeg`, as fill-move-to-break-point. */
function fillMoveToBreakPoint(linebeg: number): void {
  if (linebeg > e8.point()) e8.gotoChar(linebeg);
  for (;;) {
    let p = e8.point() - 1;
    while (p >= linebeg && !" \t".includes(charAt(p))) p--;
    if (p < linebeg) {
      e8.gotoChar(linebeg);
      break;
    }
    e8.gotoChar(p + 1);
    if (!fillNobreakP()) break;
    skipBackward(" \t", linebeg);
  }
  skipBackward(" \t");
  if (linebeg >= e8.point()) {
    // Keep at least one word on the line.
    const to = eolAt(linebeg);
    let first = true;
    e8.gotoChar(linebeg);
    while (e8.point() < to && (first || fillNobreakP())) {
      skipForward(" \t");
      let q = e8.point();
      while (q < e8.pointMax() && !" \n\t".includes(charAt(q))) q++;
      e8.gotoChar(q);
      first = false;
    }
  }
}

/** Indents the current line to the left margin, column 0, as fill-indent-to-left-margin. */
function indentToLeftMargin(): void {
  const start = bolAt(e8.point());
  const ws = /^[ \t]*/.exec(e8.lineText(e8.lineOf(start)))![0].length;
  if (ws > 0) e8.deleteRegion(start, start + ws);
  e8.gotoChar(start);
}

/** Breaks the line at point and starts the next with the fill prefix, as fill-newline. */
function fillNewline(prefix: string | undefined): void {
  skipBackward(" \t");
  e8.insert("\n");
  indentToLeftMargin();
  if (prefix !== undefined && prefix !== "") e8.insertBeforeMarkers(prefix);
}

/** Spreads the spaces of the line at point so it ends at the fill column, as justify-current-line does for full. */
function justifyCurrentLine(how: string | undefined, eop: boolean, prefix: string | undefined): void {
  if (how !== "full") return;
  saveExcursion(() => {
    const fc = fillColumn();
    e8.gotoChar(eolAt(e8.point()));
    skipBackward(" \t");
    if (bolp() || e8.currentColumn() === fc) return;
    const end = e8.point();
    e8.gotoChar(bolAt(end));
    skipForward(" \t");
    if (prefix !== undefined && prefix !== "" && e8.bufferText(e8.point(), e8.point() + prefix.length) === prefix) {
      e8.gotoChar(e8.point() + prefix.length);
    } else if (truthy(e8.variable("adaptive-fill-mode"))) {
      const re = e8.variable("adaptive-fill-regexp");
      const e = typeof re === "string" ? lookingAt(re, e8.point()) : undefined;
      if (e !== undefined) e8.gotoChar(e);
    }
    skipForward(" \t");
    const beg = e8.point();
    e8.gotoChar(end);
    const ncols = fc - e8.currentColumn();
    const text = e8.bufferText(beg, end);
    // In characters, as the buffer counts them, not UTF-16 units.
    const gaps = allMatches(/ +/g, text).map((m) => beg + [...text.slice(0, m.index! + m[0].length)].length);
    const nspaces = gaps.length;
    if (ncols <= 0 || nspaces === 0 || eop) return;
    let frac = ncols + Math.floor(nspaces / 2);
    const extra: number[] = [];
    for (let i = 0; i < nspaces; i++) {
      extra.push(Math.floor(frac / nspaces));
      frac = (frac % nspaces) + ncols;
    }
    for (let i = nspaces - 1; i >= 0; i--) {
      e8.gotoChar(gaps[i]);
      e8.insertAndInherit(" ".repeat(extra[i]));
    }
  });
}

// --- Filling ---------------------------------------------------------------

/**
 * Fills the text from `from` to `to` as one paragraph, as
 * fill-region-as-paragraph, leaving point at the start of the line after
 * it. Returns the fill prefix it used. Spaces are made canonical only after
 * `squeezeAfter`, when it is given, as code before a comment keeps its own.
 */
export function fillRegionAsParagraph(fromIn: number, toIn: number, justifyIn?: string, squeezeAfter?: number): string | undefined {
  let justify = justifyIn;
  e8.gotoChar(Math.min(fromIn, toIn));
  const toPos = Math.max(fromIn, toIn);
  skipForward(" \t\n");
  const fromPlusIndent = e8.point();
  const from = Math.max(bolAt(e8.point()), Math.min(fromIn, toIn));
  // All but one newline at the end go.
  e8.gotoChar(toPos);
  let oneleft = false;
  while (e8.point() > from && charBefore(e8.point()) === "\n") {
    if (oneleft) e8.deleteRegion(e8.point() - 1, e8.point());
    else {
      e8.gotoChar(e8.point() - 1);
      oneleft = true;
    }
  }
  const to = marker(e8.point(), true);
  e8.gotoChar(fromPlusIndent);
  try {
    if (!(at(to) > e8.point())) return undefined;
    justify ??= currentJustification();
    const fp = e8.variable("fill-prefix");
    let prefix = typeof fp === "string" ? fp : undefined;
    if (truthy(e8.variable("adaptive-fill-mode")) && (prefix === undefined || prefix === null || prefix === "")) {
      prefix = fillContextPrefix(from, at(to));
    }
    if (justify === undefined) return prefix;
    const start = fillDeletePrefix(from, to, prefix);
    fillDeleteNewlines(start, to, justify, squeezeAfter);
    e8.gotoChar(start);
    while (e8.point() < at(to)) {
      const linebeg = e8.point();
      e8.moveToColumn(fillColumn());
      let cut = false;
      if (e8.point() < at(to)) {
        e8.gotoChar(e8.point() + 1);
        fillMoveToBreakPoint(linebeg);
        skipForward(" \t");
        cut = e8.point() < at(to);
      }
      if (cut) {
        fillNewline(prefix);
        if (justify === "full") {
          saveExcursion(() => {
            forwardLine(-1);
            justifyCurrentLine(justify, false, prefix);
          });
        }
      } else {
        e8.gotoChar(at(to));
        justifyCurrentLine(justify, true, prefix);
        break;
      }
    }
    e8.gotoChar(at(to));
    if (!eobp()) e8.gotoChar(e8.point() + 1);
    return prefix;
  } finally {
    free(to);
  }
}

/** Moves over paragraphs as fill-forward-paragraph-function says, forward-paragraph by default, and says how many it could not. */
function forwardParagraph(n: number): number {
  const fn = e8.variable("fill-forward-paragraph-function");
  if ((typeof fn === "string" && fn !== "forward-paragraph") || typeof fn === "function") {
    const left = e8.funcall(fn as string, n);
    return typeof left === "number" ? left : 0;
  }
  return paragraphsForward(n);
}

/** Fills each paragraph from `from` to `to`, as fill-region, and returns the last fill prefix. */
export function fillRegion(from: number, to: number, justify?: string): string | undefined {
  const start = marker(e8.point());
  const max = marker(Math.max(from, to), true);
  const beg = Math.min(from, to);
  let prefix: string | undefined;
  e8.gotoChar(bolAt(beg));
  while (e8.point() < at(max)) {
    const initial = e8.point();
    forwardParagraph(1);
    const end = Math.min(at(max), e8.point());
    forwardParagraph(-1);
    if (e8.point() < beg) e8.gotoChar(beg);
    if (e8.point() >= initial && e8.point() < end) prefix = fillRegionAsParagraph(e8.point(), end, justify);
    else e8.gotoChar(end);
    if (e8.point() <= initial) break;
  }
  e8.gotoChar(at(start));
  free(start, max);
  return prefix;
}

/**
 * Fills the comment on point's line, as fill-comment-paragraph: its lines
 * and the comment lines around it with the same comment start, a paragraph
 * of them, each line starting with the comment's start again. A comment
 * after code fills with the code's line. Returns false when the line has no
 * comment, for M-q to fill it as text.
 */
function fillCommentParagraph(justify: string | undefined): boolean {
  commentNormalizeVars();
  const skip = e8.variable("comment-start-skip");
  if (typeof skip !== "string") return false;
  // What comment is on the line: where it starts, where its text does, and whether code is before it.
  let comstart: number | undefined;
  let comin = 0;
  let hasCode = false;
  saveExcursion(() => {
    const bol = bolAt(e8.point());
    comstart = commentSearchForward(bol, eolAt(bol));
    if (comstart === undefined) return;
    // Past the comment start as comment-start-skip matches it, from the comment back to the line's start.
    comin = e8.point();
    for (let p = comstart; p >= bol; p--) {
      const end = lookingAt(skip, p);
      if (end !== undefined) {
        comin = Math.min(end, eolAt(bol));
        break;
      }
    }
    e8.gotoChar(comstart);
    skipBackward(" \t");
    hasCode = !bolp();
  });
  if (comstart === undefined || e8.stringMatch(skip, e8.bufferText(comstart, comin)) === undefined) return false;
  const commark = commentStringStrip(e8.bufferText(comstart, comin), false, true);
  // Lines with this very comment start, where comment-start-skip lets one be followed by words; else any comment start.
  const commentRe =
    commark !== "" && e8.stringMatch(skip, `\0${commark}a`) !== undefined
      ? `[ \t]*${regexpQuote(commark)}[^${commark.slice(-1)}]`
      : `[ \t]*\\(?:${skip}\\)`;
  const reAt = (p: number): boolean => e8.lookingAt(commentRe, p);
  // The prefix each line takes: the comment start, under the comment after code, else with the line's indentation.
  const commentFillPrefix = saveExcursion(() => {
    e8.gotoChar(comstart!);
    if (!hasCode) return e8.bufferText(bolAt(comstart!), comin);
    const col = e8.currentColumn();
    const tabWidth = Number(e8.variable("tab-width") ?? 8);
    const indent = truthy(e8.variable("indent-tabs-mode"))
      ? "\t".repeat(Math.floor(col / tabWidth)) + " ".repeat(col % tabWidth)
      : " ".repeat(col);
    return indent + e8.bufferText(comstart!, comin);
  });
  const paragraphOf = (name: "paragraph-start" | "paragraph-separate"): string => {
    const value = e8.variable(name);
    const dflt = e8.defaultValue(name);
    return `${typeof value === "string" ? value : ""}\\|[ \t]*\\(?:${skip}\\)\\(?:${typeof dflt === "string" ? dflt : ""}\\)`;
  };
  let beg = 0;
  let end = 0;
  saveExcursion(() => {
    e8.saveRestriction(() => {
      e8.gotoChar(bolAt(e8.point()));
      let from: number;
      if (hasCode) from = bolAt(e8.point());
      else {
        from = saveExcursion(() => {
          while (forwardLine(-1) === 0 && reAt(e8.point()));
          // It may have gone too far: forward again, unless its line is one of the comment's.
          const found = commentSearchForward(e8.point(), eolAt(e8.point()));
          e8.gotoChar(found ?? e8.point());
          const again = reAt(e8.point());
          comstart = e8.point();
          return again ? bolAt(e8.point()) : lineStartAfter(e8.point());
        });
      }
      const to = saveExcursion(() => {
        do forwardLine(1);
        while (!eobp() && reAt(e8.point()));
        return e8.point();
      });
      e8.narrowToRegion(from, to);
      // Paragraphs within the comment, as text's paragraphs start and end.
      const afterLine = hasCode ? lineStartAfter(e8.point()) : undefined;
      e8.letBind({ "paragraph-separate": paragraphOf("paragraph-separate"), "paragraph-start": paragraphOf("paragraph-start") }, () => {
        paragraphsForward(1);
        end = e8.point();
        paragraphsForward(-1);
        if (e8.point() === afterLine) forwardLine(-1);
        beg = e8.point();
      });
    });
  });
  // The prefix: the user's, or the paragraph's own if it is a comment start, else the comment's.
  const fp = e8.variable("fill-prefix");
  let prefix: string;
  if (typeof fp === "string") prefix = fp;
  else {
    const context = truthy(e8.variable("adaptive-fill-mode")) ? fillContextPrefix(beg, end) : undefined;
    prefix = context !== undefined && e8.stringMatch(skip, context) !== undefined ? context : commentFillPrefix;
  }
  // Code before the comment keeps its spaces.
  const squeezeAfter = saveExcursion(() => {
    e8.gotoChar(beg);
    if (e8.lookingAt(prefix)) return undefined;
    return e8.reSearchForward(skip, { noerror: true }) === undefined ? undefined : e8.point();
  });
  // Point where it was, as fill-comment-paragraph fills inside its save-excursion.
  saveExcursion(() => e8.letBind({ "fill-prefix": prefix }, () => fillRegionAsParagraph(Math.max(comstart!, beg), end, justify, squeezeAfter)));
  return true;
}

/** The start of the line after the one `p` is on, or the buffer's end. */
function lineStartAfter(p: number): number {
  const line = e8.lineOf(p) + 1;
  return line < e8.lineCount() ? e8.lineStart(line) : e8.pointMax();
}

const justifyArg = (): string | undefined => (e8.prefixArg() !== null ? "full" : undefined);

e8.defineCommand({
  name: "fill-paragraph",
  barfIfReadOnly: true,
  doc:
    "Fill the paragraph at or after point, breaking lines so none passes fill-column, or each paragraph in the region if it is active.\n\n" +
    "With a prefix argument, justify as well, so the lines end at fill-column too. The lines keep the prefix the paragraph's lines share, as adaptive-fill-mode finds it.",
  run: () => {
    barfIfReadOnly();
    const justify = justifyArg();
    const unmodified = !e8.bufferModified();
    const before = unmodified ? e8.bufferText(0, e8.bufferSize()) : "";
    try {
      if (e8.regionActive() && e8.mark() !== undefined && e8.mark() !== e8.point()) {
        const [a, b] = [Math.min(e8.point(), e8.mark()!), Math.max(e8.point(), e8.mark()!)];
        fillRegion(a, b, justify);
        return;
      }
      const fn = e8.variable("fill-paragraph-function");
      if (typeof fn === "string") {
        e8.callWithPrefix(e8.prefixArg(), fn as e8.CommandName);
        return;
      }
      // A comment as a comment, in modes whose comments end with the line.
      const handleComment = truthy(e8.variable("fill-paragraph-handle-comment"));
      const cs = e8.variable("comment-start");
      if (handleComment && typeof cs === "string" && cs !== "" && e8.variable("comment-end") === "") {
        if (fillCommentParagraph(justify)) return;
      }
      // Else as text, a comment's lines a paragraph apart from the code's.
      const skip = e8.variable("comment-start-skip");
      const paragraphStart = e8.variable("paragraph-start");
      const bindings: Record<string, e8.Value> =
        handleComment && typeof skip === "string"
          ? { "paragraph-start": `${typeof paragraphStart === "string" ? paragraphStart : "\f\\|[ \t]*$"}\\|[ \t]*\\(?:${skip}\\)` }
          : {};
      e8.letBind(bindings, () =>
        saveExcursion(() => {
          const here = marker(e8.point());
          e8.gotoChar(bolAt(e8.point()));
          if (forwardParagraph(1) === 0) {
            const end = e8.point();
            forwardParagraph(-1);
            const beg = e8.point();
            e8.gotoChar(at(here));
            fillRegionAsParagraph(beg, end, justify);
          }
          free(here);
        }),
      );
    } finally {
      if (unmodified && e8.bufferText(0, e8.bufferSize()) === before) e8.setBufferModified(false);
    }
  },
});

e8.defineCommand({
  name: "fill-region",
  barfIfReadOnly: true,
  doc: "Fill each paragraph in the region. With a prefix argument, justify as well.",
  run: () => {
    barfIfReadOnly();
    const mark = e8.mark();
    if (mark === undefined) e8.userError("The mark is not set now, so there is no region");
    fillRegion(Math.min(e8.point(), mark), Math.max(e8.point(), mark), justifyArg());
  },
});

e8.defineCommand({
  name: "fill-region-as-paragraph",
  barfIfReadOnly: true,
  doc: "Fill the region as one paragraph, joining its paragraphs. With a prefix argument, justify as well.",
  run: () => {
    barfIfReadOnly();
    const mark = e8.mark();
    if (mark === undefined) e8.userError("The mark is not set now, so there is no region");
    fillRegionAsParagraph(Math.min(e8.point(), mark), Math.max(e8.point(), mark), justifyArg());
  },
});

e8.defineCommand({
  name: "set-fill-prefix",
  doc: "Make the current line's text before point the fill prefix, which filling puts at the start of each line. At the start of a line, cancel it.",
  run: () => {
    const start = bolAt(e8.point());
    const prefix = e8.point() > start ? e8.bufferText(start, e8.point()) : "";
    e8.setVariable("fill-prefix", prefix === "" ? null : prefix);
    e8.message(prefix === "" ? "fill-prefix canceled" : `fill-prefix: "${prefix}"`);
  },
});

e8.defineCommand({
  name: "set-fill-column",
  doc:
    "Set fill-column, the column filling breaks lines before, as read in the minibuffer. " +
    "Plain C-u sets it to point's column, and C-u with a number to that number.",
  run: () => {
    const set = (n: number) => {
      if (!Number.isInteger(n)) throw new Error("set-fill-column requires an explicit argument");
      e8.message(`Fill column set to ${n} (was ${fillColumn()})`);
      e8.setVariable("fill-column", n);
    };
    const arg = e8.prefixArg();
    // As set-fill-column: C-u for point's column, a number, and nothing else.
    if (arg !== null) return set(Array.isArray(arg) ? e8.currentColumn() : arg === "-" ? NaN : arg);
    // As read-number with the current column as its default.
    const column = e8.currentColumn();
    const text = e8.readString(`Change fill-column from ${fillColumn()} to (default ${column}): `).trim();
    if (text === "") return set(column);
    const n = Number(text);
    if (Number.isNaN(n)) throw new Error("Please enter a number.");
    set(n);
  },
});

// --- Auto Fill mode ----------------------------------------------------------

/** Breaks a line at whitespace and starts the next as fill-prefix or the mode says, as default-indent-new-line. */
function defaultIndentNewLine(prefix: string | undefined): void {
  // A mode's own line breaker, softly, as do-auto-fill calls default-indent-new-line.
  if (otherLineBreak(true)) return;
  // In a comment, the new line continues it, as comment-line-break-function does.
  if (typeof e8.variable("comment-start") === "string" && e8.syntaxPpss().inComment !== null) {
    e8.call("comment-indent-new-line");
    return;
  }
  e8.insertAndInherit("\n");
  // The whitespace either side goes.
  saveExcursion(() => {
    e8.gotoChar(e8.point() - 1);
    deleteHorizontalSpace();
  });
  deleteHorizontalSpace();
  if (prefix !== undefined && prefix !== null) e8.insertAndInherit(prefix);
  else e8.call("indent-according-to-mode");
}

function deleteHorizontalSpace(): void {
  let a = e8.point();
  let b = a;
  while (a > e8.pointMin() && " \t".includes(charBefore(a))) a--;
  while (b < e8.pointMax() && " \t".includes(charAt(b))) b++;
  if (b > a) e8.deleteRegion(a, b);
}

e8.defineCommand({
  name: "do-auto-fill",
  doc: "Break the line before point at whitespace if it passes fill-column, as many times as it takes. Auto Fill mode runs it as you type a space or newline.",
  run: () => {
    const justify = currentJustification();
    const fc = fillColumn();
    if (justify === undefined || (justify === "left" && e8.currentColumn() <= fc)) return;
    let prefix = e8.variable("fill-prefix") as string | null | undefined;
    if (truthy(e8.variable("adaptive-fill-mode")) && (prefix === null || prefix === undefined || prefix === "")) {
      const from = saveExcursion(() => {
        forwardParagraph(-1);
        return e8.point();
      });
      const to = saveExcursion(() => {
        forwardParagraph(1);
        return e8.point();
      });
      const p = fillContextPrefix(from, to);
      if (p !== undefined && p !== "") prefix = p;
    }
    const pfx = prefix ?? undefined;
    let giveUp = false;
    while (!giveUp && e8.currentColumn() > fc) {
      const fillPoint = saveExcursion(() => {
        e8.gotoChar(bolAt(e8.point()));
        if (pfx !== undefined) e8.moveToColumn(e8.stringWidth(pfx));
        const afterPrefix = e8.point();
        e8.moveToColumn(fc + 1);
        fillMoveToBreakPoint(afterPrefix);
        return e8.point();
      });
      // No use breaking at the start or end of the line.
      const useless = saveExcursion(() => {
        e8.gotoChar(fillPoint);
        if (bolp()) return true;
        skipForward(" ");
        return eolp();
      });
      if (useless) {
        giveUp = true;
        continue;
      }
      const prev = e8.currentColumn();
      const atPoint = saveExcursion(() => {
        skipBackward(" \t");
        return e8.point() === fillPoint;
      });
      if (atPoint) defaultIndentNewLine(pfx);
      else {
        saveExcursion(() => {
          e8.gotoChar(fillPoint);
          defaultIndentNewLine(pfx);
        });
      }
      if (e8.currentColumn() >= prev) giveUp = true;
    }
  },
});

e8.defineMinorMode({
  name: "auto-fill-mode",
  lighter: " Fill",
  doc: "Break lines as you type a space or newline past fill-column, as auto-fill-function says.",
  onChange: (on) => {
    e8.setVariable("auto-fill-function", on ? (e8.variable("normal-auto-fill-function") ?? "do-auto-fill") : null);
  },
});

e8.bindKey("M-q", "fill-paragraph");
e8.bindKey("C-x f", "set-fill-column");
e8.bindKey("C-x .", "set-fill-prefix");
