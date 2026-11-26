// Footnotes in Org, after Org's org-footnote.el: references such as
// [fn:1], [fn:name:inline definition] and [fn::anonymous], definitions
// starting a line with [fn:name], and the commands that make, find, sort,
// renumber, normalize and delete them. Org reads footnotes through its
// parser's objects and elements; E8's parser has neither for footnotes, so
// they are found here by Org's rules: a definition runs to the next
// heading, the next definition or two blank lines, and an inline
// definition to the bracket closing its own.

import { headings, isHeadingLine, markRingPush, parseHeading, preserveLocalVariables } from "org";
import { AFFILIATED, elementAt, FOOTNOTE_LABEL } from "org-element";
import { showContext } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { allMatches, charCount, escapeRegExp, truthy } from "subr";

e8.defineVariable({
  name: "org-footnote-section",
  doc: "The heading new footnote definitions go under, made at the end of the buffer if missing, or nil to put each at the end of its own section.",
  value: "Footnotes",
});
e8.defineVariable({
  name: "org-footnote-define-inline",
  doc: "Whether a new footnote is defined where it is referenced, as [fn:label:definition], rather than in a definition of its own.",
  value: null,
});
e8.defineVariable({
  name: "org-footnote-auto-label",
  doc:
    "How a new footnote gets its label: t the first number not in use, nil asking, confirm asking with that number offered, " +
    "anonymous none, random a random one.",
  value: true,
});
e8.defineVariable({
  name: "org-footnote-auto-adjust",
  doc: "Whether footnotes are renumbered and sorted after one is made or deleted: t for both, renumber or sort for one, nil for neither.",
  value: null,
});
e8.defineVariable({
  name: "org-footnote-fill-after-inline-note-extraction",
  doc: "Whether normalizing fills the paragraphs it took inline definitions out of.",
  value: null,
});

/** A label's characters, as Org's [-_[:word:]]. */
const LABEL = FOOTNOTE_LABEL;
/**
 * A definition's first line, as org-footnote-definition-re, whatever the
 * case, as Org searches for definitions with case-fold-search; references
 * are read in lower case only, as its object parser reads them.
 */
const DEFINITION = new RegExp(`^\\[fn:(${LABEL})\\]`, "iu");

/** Whether two labels are the same, whatever their case, as Org's searches for a label's definition find them. */
function sameLabel(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** A footnote reference, as Org's parser reads one. */
export interface Reference {
  /** Its label, or undefined for an anonymous one. */
  label: string | undefined;
  begin: number;
  /** Where it ends, before the spaces after it. */
  end: number;
  /** Where its object ends, the spaces after it included, as Org's :end. */
  objectEnd: number;
  /** An inline one's definition, between its second colon and its closing bracket. */
  inline?: { begin: number; end: number };
}

/** A footnote definition, as Org's parser reads one. */
export interface Definition {
  label: string;
  /** Where it starts, affiliated keywords and all. */
  begin: number;
  /** Where its [fn:label] line starts. */
  postAffiliated: number;
  /** Where it ends, as Org's :end. */
  end: number;
  contentsBegin?: number;
  contentsEnd?: number;
}

/** The text between two positions and a way back from an index in it to a position. */
function textFrom(from: number, to: number): { text: string; pos: (i: number) => number } {
  const text = e8.bufferText(from, to);
  return { text, pos: (i: number) => from + charCount(text.slice(0, i)) };
}

/** Whether a position is inside a link, or inside code or verbatim text, on its line, where no reference can be. */
function inLinkOrCode(line: number, pos: number): boolean {
  const text = e8.lineText(line);
  const at = pos - e8.lineStart(line);
  const inside = (start: number, stop: number) => at > charCount(text.slice(0, start)) && at < charCount(text.slice(0, stop));
  for (const m of allMatches(/\[\[(?:[^[\]]|\\.)+\](?:\[[^\n]*?\])?\]/g, text)) {
    if (inside(m.index ?? 0, (m.index ?? 0) + m[0].length)) return true;
  }
  for (const m of allMatches(/(^|[\s({'"-])([=~])(\S|\S.*?\S)\2(?=[\s.,;:!?'")}\[-]|$)/g, text)) {
    if (inside((m.index ?? 0) + m[1].length, (m.index ?? 0) + m[0].length)) return true;
  }
  return false;
}

/**
 * The kind of object of its own a position is in inside an inline
 * definition, emphasis, a link or a timestamp, where Org's context is that
 * object rather than the footnote.
 */
function innerObject(line: number, pos: number): "markup" | "link" | "timestamp" | undefined {
  const text = e8.lineText(line);
  const at = pos - e8.lineStart(line);
  const within = (start: number, stop: number) => at >= charCount(text.slice(0, start)) && at < charCount(text.slice(0, stop));
  const res: ["markup" | "link" | "timestamp", RegExp][] = [
    ["link", /()\[\[(?:[^[\]]|\\.)+\](?:\[[^\n]*?\])?\]/g],
    ["timestamp", /()[[<]\d{4}-\d{2}-\d{2}[^\]>\n]*[\]>]/g],
    ["markup", /(^|[\s({'"-])([*/_+=~])(\S|\S.*?\S)\2(?=[\s.,;:!?'")}\[\]-]|$)/g],
  ];
  for (const [kind, re] of res) {
    for (const m of allMatches(re, text)) {
      if (within((m.index ?? 0) + m[1].length, (m.index ?? 0) + m[0].length)) return kind;
    }
  }
  return undefined;
}

/** Where a heading's title ends, before its tags, for objects on its line. */
function titleBounds(line: number): [number, number] | undefined {
  const h = parseHeading(line);
  if (!h) return undefined;
  return [h.titleAt, h.tagsAt ?? h.end];
}

/**
 * Where objects, footnote references among them, can be at a position, and
 * how far they go, as Org's parser reads objects only in some elements'
 * text: a paragraph's, a heading's title, a table's cells and a verse
 * block's; and not inside a link or a code or verbatim object.
 */
function objectsLimit(pos: number): number | undefined {
  const line = lineAt(pos);
  const text = e8.lineText(line);
  let limit: number | undefined;
  if (isHeadingLine(text)) {
    const t = titleBounds(line);
    if (!t || pos < t[0] || pos >= t[1]) return undefined;
    limit = t[1];
  } else {
    let e = elementAt(pos);
    while (e && e.type !== "paragraph" && e.type !== "table" && e.type !== "verse-block" && e.type !== "item") e = e.parent;
    // A table.el table's text holds no objects.
    if (!e || (e.type === "table" && e.tableType === "table.el")) return undefined;
    // An item's bullet and checkbox hold no objects.
    if (e.type === "item" && pos - e8.lineStart(line) < charCount(/^[ \t]*\S+(?:[ \t]+\[[ X-]\])?[ \t]*/.exec(text)?.[0] ?? "")) return undefined;
    // In a cell: after the row's first bar and before its last.
    const before = text.slice(0, Math.max(0, pos - e8.lineStart(line)));
    if (e.type === "table" && (/^[ \t]*\|-/.test(text) || !before.includes("|") || !text.slice(before.length).includes("|"))) return undefined;
    limit = e.type === "item" || e.type === "table" ? e8.lineEnd(line) : (e.contentsEnd ?? e.end);
  }
  return inLinkOrCode(line, pos) ? undefined : limit;
}

/**
 * The reference starting at a position, as Org's parser reads one: the
 * text from [fn: to the bracket closing it, counting brackets in an inline
 * definition, within what holds objects there.
 */
function referenceStartingAt(s: number): Reference | undefined {
  const line = lineAt(s);
  const limit = objectsLimit(s);
  if (limit === undefined) return undefined;
  const { text, pos } = textFrom(s, Math.max(s, limit));
  const m = new RegExp(`^\\[fn:(?:(${LABEL})?:|(${LABEL})\\])`, "u").exec(text);
  if (!m) return undefined;
  let end: number;
  let inline: Reference["inline"];
  if (m[2] !== undefined) {
    // A definition's label at a line's start is no reference.
    if (s === e8.lineStart(line)) return undefined;
    end = pos(m[0].length);
  } else {
    let depth = 0;
    let close = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) return undefined;
    end = pos(close + 1);
    inline = { begin: pos(m[0].length), end: pos(close) };
  }
  const after = /^[ \t]*/.exec(e8.bufferText(end, Math.min(e8.pointMax(), end + 200)))![0];
  return { label: m[2] ?? m[1], begin: s, end, objectEnd: end + charCount(after), inline };
}

/**
 * The innermost reference whose object holds a position, its spaces after
 * it included, as org-element-context finds one.
 */
function referenceObjectAt(p: number, through: ("markup" | "link" | "timestamp")[] = []): Reference | undefined {
  const line = lineAt(p);
  const head = isHeadingLine(e8.lineText(line));
  let e = head ? undefined : elementAt(p);
  while (e && e.type !== "paragraph" && e.type !== "table" && e.type !== "verse-block" && e.type !== "item") e = e.parent;
  const from = head || !e ? e8.lineStart(line) : e.type === "table" || e.type === "item" ? e8.lineStart(line) : (e.contentsBegin ?? e.begin);
  const { text, pos } = textFrom(from, Math.min(e8.pointMax(), p + 4));
  for (let i = text.lastIndexOf("[fn:"); i >= 0; i = i === 0 ? -1 : text.lastIndexOf("[fn:", i - 1)) {
    const r = referenceStartingAt(pos(i));
    // Just after one with no space after it counts too, as org-element-context finds the object ending there.
    if (!r || r.begin > p || p > r.objectEnd || (p === r.objectEnd && r.objectEnd !== r.end)) continue;
    // Not on an object of its own in an inline definition, unless the
    // caller looks up through it, as C-c C-c's and C-c C-o's lineages do.
    if (r.inline && p >= r.inline.begin && p < r.inline.end) {
      const inner = innerObject(lineAt(p), p);
      if (inner !== undefined && !through.includes(inner)) return undefined;
    }
    return r;
  }
  return undefined;
}

/**
 * The reference C-c ' edits the definition of from point, as
 * org-edit-footnote-reference finds it: the reference around point, up to
 * its end, and where its definition is, a definition's label line or an
 * inline reference, found as org-footnote-goto-definition finds it, with its
 * mark and message.
 */
export function footnoteToEdit(p = e8.point()): { ref: Reference; definition?: Definition; inline?: Reference } | undefined {
  const ref = referenceObjectAt(p);
  if (!ref) return undefined;
  // On the blanks after it, Org's context is the reference, though C-c ' then refuses it.
  if (!ref.label || p > ref.end) return { ref };
  const at = wide(() =>
    e8.saveExcursion(() => {
      gotoDefinition(ref.label!);
      return e8.point() - 1;
    }),
  );
  return wide(() => ({ ref, definition: definitionLabelAt(at), inline: definitionLabelAt(at) ? undefined : referenceObjectAt(at) }));
}

/** The reference point is on, not on the spaces after it, as org-footnote-at-reference-p finds it. */
export function referenceAt(p = e8.point()): Reference | undefined {
  const r = referenceObjectAt(p);
  return r && p < r.end ? r : undefined;
}

/** The definition whose [fn:label] line is LINE, as the parser's footnote-definition element, if one starts there. */
function definitionStartingAt(line: number): Definition | undefined {
  const m = DEFINITION.exec(e8.lineText(line));
  if (!m) return undefined;
  // Not inside a block or the like, where the line is the block's text.
  const e = elementAt(e8.lineStart(line));
  if (e?.type !== "footnote-definition" || e.begin !== e8.lineStart(line)) return undefined;
  const postAffiliated = e.begin;
  let begin = postAffiliated;
  while (lineAt(begin) > 0 && AFFILIATED.test(e8.lineText(lineAt(begin) - 1))) begin = e8.lineStart(lineAt(begin) - 1);
  return { label: m[1], begin, postAffiliated, end: e.end, contentsBegin: e.contentsBegin, contentsEnd: e.contentsEnd };
}

/** From a position, back over blank space, then to the start of the next line, as Org finds an element's last line's end. */
function afterBlankBack(p: number): number {
  let q = p;
  while (q > e8.pointMin() && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
  return lineStartOrEnd(lineAt(q) + 1);
}

/** The definition a position is in, as the footnote-definition element around it. */
export function definitionAt(p = e8.point()): Definition | undefined {
  // On affiliated keywords, the definition they belong to below.
  let below = lineAt(p);
  while (below < e8.lineCount() - 1 && AFFILIATED.test(e8.lineText(below))) below++;
  if (below !== lineAt(p) && DEFINITION.test(e8.lineText(below))) {
    const d = definitionStartingAt(below);
    if (d && p >= d.begin) return d;
  }
  for (let l = lineAt(p); l >= 0; l--) {
    const text = e8.lineText(l);
    if (DEFINITION.test(text)) {
      const d = definitionStartingAt(l);
      return d && p >= d.begin && p < Math.max(d.end, d.postAffiliated + 1) ? d : undefined;
    }
    if (isHeadingLine(text)) return undefined;
  }
  return undefined;
}

/** Whether point is on a definition's label, where Org's context is the definition itself rather than its text. */
export function definitionLabelAt(p = e8.point()): Definition | undefined {
  const d = definitionAt(p);
  // Its affiliated keywords too, as Org's context there is the definition.
  return d && p >= d.begin && p < (d.contentsBegin ?? d.end) ? d : undefined;
}

/** A label without fn:, or undefined for nothing but spaces, as org-footnote-normalize-label. */
function normalizeLabel(label: string): string | undefined {
  const trimmed = label.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  if (trimmed === "") return undefined;
  return trimmed.startsWith("fn:") ? label.slice(3) : label;
}

/** Runs `f` with the whole buffer visible and point kept, as org-with-wide-buffer. */
function wide<T>(f: () => T): T {
  return e8.saveExcursion(() => e8.saveRestriction(() => (e8.widen(), f())));
}

/** Each place [fn: is, whatever its case, from a position, for searching through the buffer, positions counted on from the last, not from the start each time. */
function fnStarts(from = e8.pointMin(), to = e8.pointMax()): number[] {
  const text = e8.bufferText(from, to);
  const out: number[] = [];
  let [index, position] = [0, from];
  const fn = /\[fn:/gi;
  for (let m = fn.exec(text); m; m = fn.exec(text)) {
    const i = m.index;
    position += charCount(text.slice(index, i));
    index = i;
    out.push(position);
  }
  return out;
}

/** Every definition in the buffer, in order. */
function allDefinitions(): Definition[] {
  const out: Definition[] = [];
  for (let l = 0; l < e8.lineCount(); l++) {
    if (!/^\[fn:/i.test(e8.lineText(l))) continue;
    const d = definitionStartingAt(l);
    if (d) out.push(d);
  }
  return out;
}

/** The definition among DEFS, in order, that holds a position, found by halving. */
function definitionHolding(defs: Definition[], p: number): Definition | undefined {
  let [lo, hi] = [0, defs.length - 1];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (defs[mid].begin > p) hi = mid - 1;
    else if (defs[mid].end <= p) lo = mid + 1;
    else return defs[mid];
  }
  return undefined;
}

/** The labels of every reference and definition in the buffer, as org-footnote-all-labels lists them. */
function allLabels(): string[] {
  return wide(() => {
    const all: string[] = [];
    const seen = new Set<string>();
    // The definitions read in one pass, by where their labels start.
    const definitions = new Map(allDefinitions().map((d) => [d.postAffiliated, d.label]));
    for (const s of fnStarts()) {
      const line = lineAt(s);
      const label = s === e8.lineStart(line) && DEFINITION.test(e8.lineText(line)) ? definitions.get(s) : referenceStartingAt(s)?.label;
      if (label !== undefined && !seen.has(label)) {
        seen.add(label);
        all.unshift(label);
      }
    }
    return all;
  });
}

/** The first number not a label, as org-footnote-unique-label. */
function uniqueLabel(current = allLabels()): string {
  let n = 1;
  while (current.includes(String(n))) n++;
  return String(n);
}

/**
 * The first definition of a label in the buffer, a definition of its own or
 * an inline reference's, with its text, as org-footnote-get-definition.
 */
function getDefinition(label: string): { begin: number; end: number; contents: string } | undefined {
  const l = normalizeLabel(label);
  if (l === undefined) return undefined;
  return wide(() => {
    for (const s of fnStarts()) {
      const line = lineAt(s);
      if (s === e8.lineStart(line)) {
        const d = sameLabel(DEFINITION.exec(e8.lineText(line))?.[1], l) ? definitionStartingAt(line) : undefined;
        if (d) {
          const contents = d.contentsBegin === undefined ? "" : e8.bufferText(d.contentsBegin, d.contentsEnd!).replace(/[ \t\n]*$/, "");
          return { begin: d.begin, end: d.end, contents };
        }
        continue;
      }
      if (!e8.bufferText(s, Math.min(e8.pointMax(), s + 5 + l.length)).startsWith(`[fn:${l}:`)) continue;
      const r = referenceStartingAt(s);
      if (r && r.label === l) return { begin: r.begin, end: r.objectEnd, contents: r.inline ? e8.bufferText(r.inline.begin, r.inline.end).replace(/[ \t\n]*$/, "") : "" };
    }
    return undefined;
  });
}

/** The next reference, of a label or any, or the previous with BACKWARD, as org-footnote-get-next-reference. */
function nextReference(label?: string, backward = false, limit?: number): Reference | undefined {
  const p = e8.point();
  const starts = backward ? fnStarts(limit ?? e8.pointMin(), p).reverse() : fnStarts(p, limit ?? e8.pointMax());
  for (const s of starts) {
    if (label !== undefined && !new RegExp(`^\\[fn:${escapeRegExp(label)}[\\]:]`, "u").test(e8.bufferText(s, Math.min(e8.pointMax(), s + 6 + label.length)))) continue;
    if (!backward && s < p) continue;
    const r = referenceStartingAt(s);
    if (r && (label === undefined || r.label === label)) return r;
  }
  return undefined;
}

const MESSAGE_GO_BACK = "Edit definition and go back with ‘C-c &’ or, if unique, with ‘C-c C-c’.";

/** Moves to a label's definition, as org-footnote-goto-definition, signalling when there is none or it is out of reach. */
function gotoDefinition(label: string, location?: number): true {
  const l = normalizeLabel(label) ?? "";
  const start = location ?? getDefinition(l)?.begin;
  if (start === undefined) e8.userError(`Cannot find definition of footnote ${l}`);
  if (start! > e8.pointMax() || start! < e8.pointMin()) e8.userError("Definition is outside narrowed part of buffer");
  markRingPush();
  e8.gotoChar(start!);
  const m = new RegExp(`^\\[fn:${escapeRegExp(l)}[\\]:]`, "iu").exec(e8.bufferText(start!, Math.min(e8.pointMax(), start! + 6 + l.length)));
  if (m) e8.gotoChar(start! + charCount(m[0]));
  showContext("link-search");
  if (e8.derivedModeP("org-mode")) e8.message(MESSAGE_GO_BACK);
  return true;
}

/** Moves to the reference of a label nearest before point, or after it, as org-footnote-goto-previous-reference. */
function gotoPreviousReference(label: string): void {
  const l = normalizeLabel(label) ?? "";
  const r = e8.saveExcursion(
    () =>
      nextReference(l, true) ??
      nextReference(l) ??
      (e8.bufferSize() !== e8.pointMax() - e8.pointMin() ? wide(() => nextReference(l, true) ?? nextReference(l)) : undefined),
  );
  if (!r) e8.userError(`Cannot find reference of footnote "${l}"`);
  if (r!.begin > e8.pointMax() || r!.begin < e8.pointMin()) e8.userError("Reference is outside narrowed part of buffer");
  markRingPush();
  e8.gotoChar(r!.begin);
  showContext("link-search");
}

/** Moves back over blank lines to the first of them and says how many there were, as org-back-over-empty-lines. */
function backOverEmptyLines(): number {
  const p = e8.point();
  const blank = e8.variable("org-blank-before-new-entry");
  const heading = Array.isArray(blank) ? blank.find((c) => Array.isArray(c) && c[0] === "heading") : undefined;
  if (Array.isArray(heading) && truthy(heading[1] ?? null)) {
    while (e8.point() > e8.pointMin() && /[ \t\n\r]/.test(e8.bufferText(e8.point() - 1, e8.point()))) e8.gotoChar(e8.point() - 1);
  } else if (e8.point() < e8.pointMax()) e8.gotoChar(e8.lineStart(Math.max(0, lineAt() - 1)));
  e8.gotoChar(Math.min(lineStartOrEnd(lineAt() + 1), p));
  return e8.bufferText(e8.point(), p).split("\n").length - 1 + (e8.point() < p && !e8.bufferText(e8.point(), p).endsWith("\n") ? 1 : 0);
}

/** The footnote section's heading line regexp, any case, as Org searches with case-fold-search on. */
function sectionRegexp(section: string): RegExp {
  return new RegExp(`^\\*+[ \\t]+${escapeRegExp(section)}[ \\t]*$`, "i");
}

/**
 * Removes every footnote section and makes one at the end of the buffer,
 * point left in it, as org-footnote--clear-footnote-section.
 */
function clearFootnoteSection(): void {
  const section = e8.variable("org-footnote-section");
  if (typeof section !== "string") return;
  const re = new RegExp(`^\\*+ +${escapeRegExp(section)}[ \\t]*$`, "i");
  for (let l = 0; l < e8.lineCount(); l++) {
    if (!re.test(e8.lineText(l))) continue;
    const all = headings();
    const i = all.findIndex((h) => h.line === l);
    const next = i >= 0 ? all.slice(i + 1).find((h) => h.level <= all[i].level) : undefined;
    e8.deleteRegion(e8.lineStart(l), next ? next.start : e8.pointMax());
    l--;
  }
  e8.gotoChar(e8.pointMax());
  while (e8.point() > e8.pointMin() && /[ \r\t\n]/.test(e8.bufferText(e8.point() - 1, e8.point()))) e8.gotoChar(e8.point() - 1);
  if (e8.point() > e8.pointMin()) {
    // forward-line, then a newline if that is a line's end.
    e8.gotoChar(lineStartOrEnd(lineAt() + 1));
    if (e8.point() === e8.lineEnd(lineAt())) e8.insert("\n");
  }
  e8.deleteRegion(e8.point(), e8.pointMax());
  const blank = e8.variable("org-blank-before-new-entry");
  const heading = Array.isArray(blank) ? blank.find((c) => Array.isArray(c) && c[0] === "heading") : undefined;
  if (Array.isArray(heading) && truthy(heading[1] ?? null) && e8.saveExcursion(() => backOverEmptyLines()) === 0) e8.insert("\n");
  e8.insert(`* ${section}\n`);
}

/** Goes to where a local definition goes: before the next heading, after the text there, as org-footnote--goto-local-insertion-point. */
function gotoLocalInsertionPoint(): void {
  let next = e8.pointMax();
  for (let l = lineAt() + 1; l < e8.lineCount(); l++) {
    if (isHeadingLine(e8.lineText(l)) && e8.lineStart(l) < e8.pointMax()) {
      next = e8.lineStart(l);
      break;
    }
  }
  e8.gotoChar(next);
  while (e8.point() > e8.pointMin() && /[ \t\n]/.test(e8.bufferText(e8.point() - 1, e8.point()))) e8.gotoChar(e8.point() - 1);
  if (e8.point() > e8.pointMin()) e8.gotoChar(lineStartOrEnd(lineAt() + 1));
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
}

/** Starts a label's definition and says where, point kept, as org-footnote-create-definition. */
function createDefinition(label: string): number {
  const l = normalizeLabel(label) ?? "";
  return e8.letBind({ "electric-indent-mode": null }, () =>
    preserveLocalVariables(() =>
      wide(() => {
        const section = e8.variable("org-footnote-section");
        if (typeof section !== "string") gotoLocalInsertionPoint();
        else {
          const re = sectionRegexp(section);
          let found: number | undefined;
          for (let line = 0; line < e8.lineCount(); line++) {
            if (re.test(e8.lineText(line))) {
              found = line;
              break;
            }
          }
          if (found !== undefined) {
            const h = parseHeading(found)!;
            e8.gotoChar(endOfMetaData(h, true));
            if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
          } else clearFootnoteSection();
        }
        if (backOverEmptyLines() === 0) e8.insert("\n");
        e8.insert(`[fn:${l}] \n`);
        return e8.lineStart(lineAt() - 1);
      }),
    ),
  );
}

/**
 * Whether a reference can go at a position, as org-footnote--allow-reference-p
 * says: not at a line's start, and in text that holds objects, the blank
 * lines after an element, or just after a definition's label.
 */
function allowReference(p = e8.point()): boolean {
  const line = lineAt(p);
  if (p === e8.lineStart(line)) return false;
  const text = e8.lineText(line);
  if (isHeadingLine(text)) {
    if (/^\*+ END[ \t]*$/i.test(text)) return false;
    const t = titleBounds(line);
    const h = parseHeading(line);
    return t !== undefined && h !== undefined && h.title !== "" && p >= t[0] && (h.tagsAt === undefined || p < h.tagsAt) && !inLinkOrCode(line, p);
  }
  if (/^[ \t]*$/.test(text)) {
    // Blank lines at the top, or after an element, but not inside one, as a block's.
    const e = elementAt(p);
    return !e || e.type === "paragraph" || p >= afterBlankBack(e.end);
  }
  const def = definitionLabelAt(p);
  if (def) return /^\s/.test(e8.bufferText(p, Math.min(e8.pointMax(), p + 1)));
  return objectsLimit(p) !== undefined;
}

/** Renumbers and sorts footnotes as org-footnote-auto-adjust says, as org-footnote-auto-adjust-maybe. */
function autoAdjustMaybe(): void {
  const adjust = e8.variable("org-footnote-auto-adjust");
  if (adjust === true || adjust === "renumber") renumber();
  if (adjust === true || adjust === "sort") {
    const label = definitionAt()?.label;
    sort();
    if (label !== undefined) {
      // From the buffer's start, where point stays if the label is not found again.
      e8.gotoChar(e8.pointMin());
      const re = new RegExp(`^\\[fn:${escapeRegExp(label)}\\]`, "iu");
      for (let l = 0; l < e8.lineCount(); l++) {
        const m = re.exec(e8.lineText(l));
        if (m) {
          e8.gotoChar(e8.lineStart(l) + charCount(m[0]));
          e8.insert(" ");
          e8.call("just-one-space");
          break;
        }
      }
    }
  }
}

/** Inserts a new reference at point, and its definition, as org-footnote-new. */
function newFootnote(): void {
  if (!allowReference()) e8.userError("Cannot insert a footnote here");
  const all = allLabels();
  const auto = e8.variable("org-footnote-auto-label");
  let label: string | undefined;
  if (auto !== "anonymous") {
    if (auto === "random") label = Math.floor(Math.random() * 0x7fffffff).toString(16);
    else {
      const propose = uniqueLabel(all);
      label = normalizeLabel(
        auto === true
          ? propose
          : e8.completingRead("Label (leave empty for anonymous): ", all, { initial: auto === "confirm" ? propose : undefined }),
      );
    }
  }
  if (label === undefined) {
    e8.insert("[fn::]");
    e8.gotoChar(e8.point() - 1);
  } else if (all.includes(label)) {
    e8.insert(`[fn:${label}]`);
    e8.message("New reference to existing note");
  } else if (truthy(e8.variable("org-footnote-define-inline") ?? null)) {
    e8.insert(`[fn:${label}:]`);
    e8.gotoChar(e8.point() - 1);
    autoAdjustMaybe();
  } else {
    e8.insert(`[fn:${label}]`);
    const p = createDefinition(label);
    let reached = false;
    try {
      reached = gotoDefinition(label, p);
    } catch {
      reached = false;
    }
    autoAdjustMaybe();
    // A definition out of the narrowed part of the buffer is edited remotely, in a buffer of its own.
    if (!reached) e8.call("org-edit-footnote-reference");
  }
}

/** Deletes every reference to a label and says how many, as org-footnote-delete-references. */
function deleteReferences(label: string): number {
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    let n = 0;
    for (let r = nextReference(label); r; r = nextReference(label)) {
      e8.gotoChar(r.begin);
      e8.deleteRegion(r.begin, r.end);
      n++;
    }
    return n;
  });
}

/** Deletes every definition of a label, with the blank lines before it, and says how many, as org-footnote-delete-definitions. */
function deleteDefinitions(label: string): number {
  return e8.saveExcursion(() => {
    const re = new RegExp(`^\\[fn:${escapeRegExp(label)}\\]`, "iu");
    let n = 0;
    for (let l = 0; l < e8.lineCount(); l++) {
      if (!re.test(e8.lineText(l))) continue;
      const d = definitionAt(e8.lineStart(l) + 1);
      if (!d) continue;
      const end = afterBlankBack(d.end);
      e8.gotoChar(d.postAffiliated);
      while (e8.point() > e8.pointMin() && /[ \r\t\n]/.test(e8.bufferText(e8.point() - 1, e8.point()))) e8.gotoChar(e8.point() - 1);
      const start = e8.point() === e8.pointMin() ? e8.point() : lineStartOrEnd(lineAt() + 1);
      e8.deleteRegion(start, Math.max(start, end));
      n++;
      l = lineAt(start) - 1;
    }
    return n;
  });
}

/** Deletes the footnote at point, or LABEL's: its references and definitions, as org-footnote-delete. */
function deleteFootnote(label?: string): void {
  preserveLocalVariables(() => {
    let l = label;
    if (l === undefined) {
      const r = referenceAt();
      if (r) {
        if (r.label === undefined) {
          e8.deleteRegion(r.begin, r.end);
          e8.message("Anonymous footnote removed");
          return;
        }
        l = r.label;
      } else {
        const d = definitionAt();
        if (!d) e8.signal("error", "Don\u2019t know which footnote to remove");
        l = d!.label;
      }
    }
    const nref = deleteReferences(l!);
    const ndef = deleteDefinitions(l!);
    autoAdjustMaybe();
    e8.message(`${ndef} definition(s) of and ${nref} reference(s) of footnote ${l} removed`);
  });
}

/** A reference found in the buffer, its start kept by a marker, and whether it is not inside a definition. */
interface Collected {
  label: string | undefined;
  marker: e8.Marker;
  topLevel: boolean;
  size?: number;
}

/**
 * Every labelled reference in the buffer, or anonymous ones too, in the
 * order they are read with the references in a definition read where that
 * definition's first reference is, as org-footnote--collect-references.
 */
function collectReferences(anonymous = false): Collected[] {
  return wide(() => {
    const references: Collected[] = [];
    const nested = new Map<string, string[]>();
    const defs = allDefinitions();
    for (const s of fnStarts()) {
      const line = lineAt(s);
      if (s === e8.lineStart(line) && DEFINITION.test(e8.lineText(line))) continue;
      const r = referenceStartingAt(s);
      if (!r || (r.label === undefined && !anonymous)) continue;
      const d = definitionHolding(defs, r.begin);
      const size = r.inline ? r.inline.end - r.inline.begin : undefined;
      references.unshift({ label: r.label, marker: e8.makeMarker(r.begin), topLevel: !d, size });
      if (d) {
        const labels = nested.get(d.label);
        if (labels) labels.unshift(r.label as string);
        else nested.set(d.label, [r.label as string]);
      }
    }
    const ordered: Collected[] = [];
    // The first in Org's list for each label, its last in the buffer, as assoc finds it.
    const byLabel = new Map<string | undefined, Collected>();
    for (const r of references) if (!byLabel.has(r.label)) byLabel.set(r.label, r);
    const add = (ref: Collected | undefined, allowNested: boolean): void => {
      if (!ref || !(allowNested || ref.topLevel)) return;
      ordered.push(ref);
      for (const l of [...(nested.get(ref.label as string) ?? [])].reverse()) add(byLabel.get(l), true);
    };
    for (const r of [...references].reverse()) add(r, false);
    return ordered;
  });
}

/** Every definition's label and text, the first of each label, deleting them with DELETE, as org-footnote--collect-definitions. */
function collectDefinitions(del = false): [string, string][] {
  return wide(() => {
    const definitions: [string, string][] = [];
    const regions: [number, number][] = [];
    const seen = new Set<string>();
    for (const d of allDefinitions()) {
      if (seen.has(d.label)) continue;
      seen.add(d.label);
      // From after the blank space before it to the end of its last line.
      let q = d.begin;
      while (q > e8.pointMin() && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
      const beg = q === e8.pointMin() ? q : lineStartOrEnd(lineAt(q) + 1);
      const end = afterBlankBack(d.end);
      definitions.unshift([d.label, e8.bufferText(beg, end).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "")]);
      regions.push([beg, end]);
    }
    // From the last, so the others stay where they are.
    if (del) for (const [beg, end] of regions.reverse()) e8.deleteRegion(beg, Math.max(beg, end));
    return definitions;
  });
}

/** Gives the reference or definition at point a label, as org-footnote--set-label: after [fn:, inserting one or replacing the one there. */
function setLabel(label: string): void {
  e8.gotoChar(e8.point() + 4);
  const rest = e8.bufferText(e8.point(), Math.min(e8.pointMax(), e8.point() + 200));
  if (rest.startsWith(":")) e8.insert(label);
  else {
    const m = new RegExp(`^${LABEL}`, "u").exec(rest);
    if (m) {
      e8.deleteRegion(e8.point(), e8.point() + charCount(m[0]));
      e8.insert(label);
    }
  }
}

function dropMarkers(refs: Collected[]): void {
  for (const r of refs) e8.deleteMarker(r.marker);
}

/** Numbers the numbered footnotes in the order they are read, as org-footnote-renumber-fn:N. */
function renumber(): void {
  const references = collectReferences();
  try {
    const numbered = references.filter((r) => /^[0-9]+$/.test(r.label ?? ""));
    const alist = new Map<string, string>();
    let c = 0;
    for (const r of numbered) if (!alist.has(r.label!)) alist.set(r.label!, String(++c));
    wide(() => {
      for (const r of numbered) {
        e8.gotoChar(e8.markerPosition(r.marker) as number);
        setLabel(alist.get(r.label!)!);
      }
      for (let l = 0; l < e8.lineCount(); l++) {
        const m = /^\[fn:([0-9]+)\]/.exec(e8.lineText(l));
        if (!m) continue;
        const start = e8.lineStart(l) + 4;
        e8.deleteRegion(start, start + m[1].length);
        e8.gotoChar(start);
        // Definitions no reference has get the numbers after them.
        e8.insert(alist.get(m[1]) ?? String(++c));
      }
    });
  } finally {
    dropMarkers(references);
  }
}

/**
 * Puts definitions in the order of their first references, at the end of
 * their sections or in the footnote section, as org-footnote-sort; inline
 * ones are left where they are.
 */
function sort(): void {
  const references = collectReferences();
  try {
    preserveLocalVariables(() => {
      const definitions = collectDefinitions(true);
      wide(() => {
        clearFootnoteSection();
        const inserted = new Set<string>();
        const texts = new Map<string, string>();
        for (const [l, t] of definitions) if (!texts.has(l)) texts.set(l, t);
        const section = e8.variable("org-footnote-section");
        for (const cell of references) {
          const label = cell.label!;
          if (inserted.has(label) || cell.size !== undefined) continue;
          inserted.add(label);
          if (typeof section !== "string" && cell.topLevel) {
            e8.gotoChar(e8.markerPosition(cell.marker) as number);
            gotoLocalInsertionPoint();
          }
          e8.insert(`\n${texts.get(label) ?? `[fn:${label}] DEFINITION NOT FOUND.`}\n`);
        }
        // In the order Org's list has them, the last found first.
        for (const [label, definition] of definitions) if (!inserted.has(label)) e8.insert(`\n${definition}\n`);
      });
    });
  } finally {
    dropMarkers(references);
  }
}

/** Makes every footnote a numbered one with a definition of its own, inline ones included, as org-footnote-normalize. */
function normalize(): void {
  const references = collectReferences(true);
  try {
    preserveLocalVariables(() => {
      let n = 0;
      const translations = new Map<string, string>();
      const extracted: [string | number, string][] = [];
      // The new label of each, anonymous ones by number to tell them apart.
      const anonymousLabels = new Map<Collected, number>();
      wide(() => {
        for (const cell of references) {
          let next: string;
          if (cell.label === undefined) {
            const k = ++n;
            anonymousLabels.set(cell, k);
            next = String(k);
          } else if (translations.has(cell.label)) next = translations.get(cell.label)!;
          else {
            next = String(++n);
            translations.set(cell.label, next);
          }
          e8.gotoChar(e8.markerPosition(cell.marker) as number);
          setLabel(next);
          if (cell.size !== undefined) {
            const start = e8.point();
            const removed = e8.bufferText(start, start + cell.size + 1);
            e8.deleteRegion(start, start + cell.size + 1);
            const def = `[fn:${next}] ${removed.slice(1).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "")}`;
            extracted.unshift([cell.label === undefined ? anonymousLabels.get(cell)! : cell.label, def]);
            if (truthy(e8.variable("org-footnote-fill-after-inline-note-extraction") ?? null)) e8.call("org-fill-paragraph");
          }
        }
        const definitions: [string | number, string][] = [...extracted, ...collectDefinitions(true)];
        const inserted: (string | number)[] = [];
        clearFootnoteSection();
        const section = e8.variable("org-footnote-section");
        for (const cell of references) {
          const key: string | number = cell.label === undefined ? anonymousLabels.get(cell)! : cell.label;
          if (typeof section !== "string" && cell.topLevel) {
            e8.gotoChar(e8.markerPosition(cell.marker) as number);
            gotoLocalInsertionPoint();
          }
          if (inserted.includes(key)) continue;
          inserted.push(key);
          const stored = definitions.find(([l]) => l === key)?.[1];
          const fresh = typeof key === "number" ? String(key) : translations.get(key)!;
          const text = stored === undefined ? `[fn:${fresh}] DEFINITION NOT FOUND.` : typeof key === "number" ? stored : stored.replace(/^\[fn:(.*?)\]/, `[fn:${fresh}]`);
          e8.insert(`\n${text}\n`);
        }
        for (const [label, definition] of definitions) {
          if (inserted.includes(label)) continue;
          // Each line's label, as ^ matches at every line's start in replace-regexp-in-string.
          const fresh = `[fn:${++n}]`;
          e8.insert(`\n${definition.replace(new RegExp(`^\\[fn:(${LABEL})\\]`, "gmu"), () => fresh)}\n`);
        }
      });
    });
  } finally {
    dropMarkers(references);
  }
}

/** The footnote menu, as org-footnote-action offers it. */
function footnoteMenu(): void {
  // A message, then the key, so the message stays, as Org asks.
  e8.message("Footnotes: [s]ort | [r]enumber fn:N | [S]=r+s | [n]ormalize | [d]elete");
  const key = e8.readCharExclusive();
  if (key === "s") sort();
  else if (key === "r") renumber();
  else if (key === "S") {
    renumber();
    sort();
  } else if (key === "n") normalize();
  else if (key === "d") deleteFootnote();
  else {
    // The character itself, as %c writes it.
    const named: Record<string, string> = { SPC: " ", RET: "\r", TAB: "\t", ESC: "\u001b", DEL: "\u007f" };
    e8.signal("error", `No such footnote command ${named[key] ?? key}`);
  }
}

/**
 * Does what fits the footnote at point, as org-footnote-action: from a
 * reference to its definition, or makes one; from a definition to its
 * reference; elsewhere a new footnote, or the menu where none can go or
 * with a prefix argument.
 */
function action(special: boolean): void {
  const p = e8.point();
  if (special) return footnoteMenu();
  const r = referenceObjectAt(p);
  if (r && p > r.end) return newFootnote();
  // On spaces after an element's last text, as at the buffer's end with no newline.
  const e = r ? undefined : elementAt(p);
  if (e && !definitionLabelAt(p)) {
    let end = Math.min(e.end, e8.pointMax());
    while (end > e.begin && /[ \t]/.test(e8.bufferText(end - 1, end))) end--;
    if (p > end) return newFootnote();
  }
  if (r) {
    if (r.label === undefined) {
      e8.gotoChar(r.inline!.begin);
      return;
    }
    const def = getDefinition(r.label);
    if (def) {
      gotoDefinition(r.label, def.begin);
      return;
    }
    if (e8.yesOrNoP(`No definition for ${r.label}.  Create one? `)) {
      const at = createDefinition(r.label);
      try {
        gotoDefinition(r.label, at);
      } catch {
        // Out of the narrowed part of the buffer: edited remotely, in a buffer of its own.
        e8.call("org-edit-footnote-reference");
      }
    }
    return;
  }
  // On its label, or on its blank lines after its contents, as Org's context is the definition there.
  const d = definitionLabelAt(p) ?? (e?.type === "footnote-definition" && e.contentsEnd !== undefined && p >= e.contentsEnd ? definitionAt(p) : undefined);
  if (d) return gotoPreviousReference(d.label);
  if (!allowReference(p)) return footnoteMenu();
  newFootnote();
}

e8.defineCommand({
  name: "org-footnote-action",
  doc:
    "Do the right thing for footnotes: on a reference, go to its definition, offering to make one; on a definition, go to its " +
    "reference; elsewhere make a new footnote. With a prefix argument, or where none can go, offer to sort, renumber, normalize or delete them.",
  params: [{ name: "special", kind: "prefix" }],
  run: (special: e8.PrefixArg) => action(special !== null && special !== undefined),
});

e8.defineCommand({
  name: "org-footnote-new",
  doc: "Insert a new footnote reference at point, and its definition, labelled as org-footnote-auto-label says.",
  run: () => newFootnote(),
});

e8.defineCommand({
  name: "org-footnote-goto-definition",
  doc: "Go to the definition of a footnote, by its label.",
  params: [{ name: "label", kind: "string", prompt: "Label: " }],
  run: (label: string) => {
    gotoDefinition(label);
  },
});

e8.defineCommand({
  name: "org-footnote-goto-previous-reference",
  doc: "Go to the reference of a footnote, by its label, nearest before point, or else after it.",
  params: [{ name: "label", kind: "string", prompt: "Label: " }],
  run: (label: string) => gotoPreviousReference(label),
});

e8.defineCommand({
  name: "org-footnote-delete",
  doc: "Delete the footnote at point, or a label's: every reference to it and every definition of it.",
  run: () => deleteFootnote(),
});

e8.defineCommand({
  name: "org-footnote-renumber-fn:N",
  doc: "Number the numbered footnotes in the order they are referenced.",
  run: () => renumber(),
});

e8.defineCommand({
  name: "org-footnote-sort",
  doc: "Put footnote definitions in the order of their references, in the footnote section or at the end of their sections.",
  run: () => sort(),
});

e8.defineCommand({
  name: "org-footnote-normalize",
  doc: "Make every footnote a numbered one, inline and anonymous ones given definitions of their own.",
  run: () => normalize(),
});

// For org.ts's C-c C-c and C-c C-o, which find footnotes through these, as
// Org's context does.
e8.defun("org-footnote-at-reference-p", () => {
  const r = referenceAt();
  return r ? [r.label ?? null, r.begin, r.end, r.inline ? e8.bufferText(r.inline.begin, r.inline.end) : null] : undefined;
});
e8.defun("org-footnote-at-definition-p", () => {
  const d = definitionAt();
  if (!d) return undefined;
  const contents = d.contentsBegin === undefined ? "" : e8.bufferText(d.contentsBegin, d.contentsEnd!).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  return [d.label, d.postAffiliated, afterBlankBack(d.end), contents];
});
/**
 * What C-c C-o follows here, as org-open-at-point: "reference", or
 * "definition" on a label, the spaces after it included unless the text
 * follows on its line, or "text" elsewhere in a definition, where Org says
 * there is no link.
 */
e8.defun("org-footnote--open-context", () => {
  const p = e8.point();
  // Up through emphasis to the footnote, as Org's lineage of supported types goes; a link or a timestamp is followed itself.
  if (referenceObjectAt(p, ["markup"])) return "reference";
  const d = definitionAt(p);
  if (!d) return undefined;
  let q = p;
  while (/[ \t]/.test(e8.bufferText(q, Math.min(e8.pointMax(), q + 1)))) q++;
  const onLabel = d.contentsBegin !== undefined ? q < d.contentsBegin : d.postAffiliated === e8.lineStart(lineAt(q));
  return onLabel ? "definition" : "text";
});

/** Whether point is where Org's context is a footnote: on a reference or its spaces, or on a definition's label; and where that definition's label starts. */
e8.defun("org-footnote--context", () => {
  // Up through emphasis and links to the footnote, as C-c C-c's lineage goes; a timestamp is changed itself.
  if (referenceObjectAt(e8.point(), ["markup", "link"])) return "reference";
  const d = definitionLabelAt();
  return d ? d.postAffiliated : undefined;
});
