// Org Cite, after Org's oc.el: citations, [cite/style:prefix @key suffix;
// ...], handled by citation processors. A processor registers what it
// can do: activate citations in the buffer (fontify them), export them
// and the bibliography a #+print_bibliography: keyword asks for, follow
// them (C-c C-o) and insert them (C-c C-x @). org-cite-activate-processor,
// org-cite-export-processors, org-cite-follow-processor and
// org-cite-insert-processor choose the processor for each; "basic"
// (oc-basic.ts) is the one Org ships that needs nothing else. The
// bibliography is the #+bibliography: files and org-cite-global-bibliography.
//
// Export runs through ox.ts, which loads this file: it stores the
// bibliography and the processor in the export's information, replaces
// each citation and #+print_bibliography: keyword in the parse tree with
// what the processor makes of it, and lets the processor finish the
// output. ox.ts gives this file the export functions it needs
// (setExportFunctions), so that activating and inserting citations do not
// load the exporter.
//
// Not loaded at startup: org-loaddefs.ts's stubs load it.

import {
  contents,
  contentsBegin,
  contentsEnd,
  create,
  type Datum,
  end as endOf,
  extract,
  insertBefore,
  lineage,
  map,
  type Node,
  postBlank,
  property,
  putProperty,
  replace,
  typeOf,
  begin as beginOf,
  adoptElements,
  SECONDARY_VALUES,
} from "org-element-ast";
import { elementAt, normalizeString, objectAt, parseBuffer, parseSecondaryString, restriction, withAffiliated } from "org-element";
import { keywordLines, parseHeading } from "org";
import { fileRelativeName } from "files";

type Info = { [key: string]: any };

e8.defineVariable({
  name: "org-cite-global-bibliography",
  value: null,
  doc: "List of bibliography files available in all documents. File names must be absolute.",
});
e8.defineVariable({ name: "org-cite-activate-processor", value: e8.intern("basic"), doc: "Processor used for activating citations, as a symbol." });
e8.defineVariable({
  name: "org-cite-export-processors",
  value: [[true, e8.intern("basic")]],
  doc:
    "Processor used for exporting citations, as a triplet, or nil. When nil, citations and bibliography are not exported. " +
    "Otherwise, a list of entries [BACKEND, NAME, BIBLIOGRAPHY-STYLE, CITATION-STYLE], BACKEND the name of an export " +
    "backend or t, NAME the processor's name and the styles strings or nil, both optional. The processor of the current " +
    "backend, or of the closest one it is derived from, else t's, is used. A CITE_EXPORT keyword, as " +
    '"#+CITE_EXPORT: basic note numeric", sets the triplet for every backend.',
});
e8.defineVariable({ name: "org-cite-follow-processor", value: e8.intern("basic"), doc: "Processor used for following citations, as a symbol." });
e8.defineVariable({ name: "org-cite-insert-processor", value: e8.intern("basic"), doc: "Processor used for inserting citations, as a symbol." });
e8.defineVariable({
  name: "org-cite-adjust-note-numbers",
  value: true,
  doc:
    "When non-nil, allow process to modify location of note numbers: a citation turned into a footnote, and the " +
    "punctuation around it, are moved as org-cite-note-rules says.",
});
e8.defineVariable({
  name: "org-cite-note-rules",
  value: [
    ["en-us", e8.intern("inside"), e8.intern("outside"), e8.intern("after")],
    ["fr", e8.intern("adaptive"), e8.intern("same"), e8.intern("before")],
  ],
  doc:
    "Typographic rules for citations in note style by language: [LANGUAGE-TAG, PUNCTUATION, NUMBER, ORDER], " +
    "PUNCTUATION inside, outside or adaptive, NUMBER inside, outside or same, and ORDER after or before. Languages not " +
    "listed take [adaptive, outside, after].",
});
e8.defineVariable({
  name: "org-cite-punctuation-marks",
  value: [".", ",", ";", ":", "!", "?"],
  doc: "List of strings that can be moved around when placing note numbers.",
});

e8.defineFace({ name: "org-cite", doc: "Face for citations.", attributes: { inherit: "link" } });
e8.defineFace({ name: "org-cite-key", doc: "Face for citation keys.", attributes: { inherit: "link" } });

const v = (name: string): e8.Value => e8.variable(name) ?? null;
const truthy = (x: unknown): boolean => x !== null && x !== undefined && x !== false;
/** A symbol's name, or the string itself. */
export const symbolString = (x: unknown): string | undefined =>
  typeof x === "symbol" ? e8.symbolName(x) : typeof x === "string" ? x : x === true ? "t" : undefined;
/** A string with something besides blanks, else undefined, as org-string-nw-p. */
const nw = (s: unknown): string | undefined => (typeof s === "string" && /[^ \t\n\r]/.test(s) ? s : undefined);
/** A string without the blanks at its ends, as org-trim. */
const orgTrim = (s: string): string => s.replace(/[ \t\n\r]+$/, "").replace(/^[ \t\n\r]+/, "");
/** A string, unless it is "nil", as org-not-nil. */
const notNil = (s: string | undefined): string | undefined => (s === "nil" ? undefined : s);

// The export functions ox.ts gives this file when it loads.

export interface ExportFunctions {
  data: (d: Datum | Datum[] | undefined, info: Info) => string;
  rawString: (s: string) => Node;
  derivedBackendP: (backend: any, ...names: string[]) => boolean;
  getPreviousElement: (blob: Datum, info: Info, parent?: Node) => Datum | undefined;
  getNextElement: (blob: Datum, info: Info, parent?: Node) => Datum | undefined;
}

let exporter: ExportFunctions | undefined;

/** Called by ox.ts as it loads, with the functions of the exporter citations are exported through. */
export function setExportFunctions(f: ExportFunctions): void {
  exporter = f;
}

/** The exporter's functions, which are there once ox.ts has loaded, as during an export. */
export function exportFunctions(): ExportFunctions {
  if (!exporter) e8.require("ox");
  return exporter!;
}

// Processors

/** A citation processor, as org-cite-processor: its name and what it can do. */
export interface Processor {
  name: string;
  /** Called with a citation object from the buffer; may put text properties there. */
  activate?: (citation: Node) => void;
  /** The styles and variants it knows, as [[style, ...shortcuts], ...[variant, ...shortcuts]] lists, or a function giving them. */
  citeStyles?: string[][][] | (() => string[][][]);
  /** Renders a bibliography: keys, files, style, the keyword's properties, the backend and the export's information. */
  exportBibliography?: (keys: string[], files: string[], style: string | undefined, props: e8.Value[], backend: any, info: Info) => string | Datum | Datum[] | undefined;
  /** Renders a citation: the citation, its style as [name, variant], the backend and the export's information. */
  exportCitation?: (citation: Node, style: [string | undefined, string | undefined], backend: any, info: Info) => string | Datum | Datum[] | undefined | null;
  /** Called with the export's output, keys, files, bibliography style, backend and information; returns the output. */
  exportFinalizer?: (output: string, keys: string[], files: string[], style: string | undefined, backend: any, info: Info) => string;
  /** Follows a citation or citation reference, with the prefix argument. */
  follow?: (datum: Node, arg: e8.PrefixArg) => void;
  /** Inserts or edits a citation: the citation or reference at point, or undefined, and the prefix argument. */
  insert?: (context: Node | undefined, arg: e8.PrefixArg) => void;
}

const processors: Processor[] = [];

/** Marks citation processor NAME as available, replacing one of the same name, as org-cite-register-processor. */
export function registerProcessor(name: string, body: Omit<Processor, "name">): void {
  if (!name) e8.signal("error", `Invalid processor name: ${name}`);
  const i = processors.findIndex((p) => p.name === name);
  if (i >= 0) processors.splice(i, 1);
  processors.unshift({ name, ...body });
}

/** Loads oc-NAME unless processor NAME is registered, as org-cite-try-load-processor. */
export function tryLoadProcessor(name: string): void {
  if (getProcessor(name)) return;
  try {
    e8.require(`oc-${name}`);
  } catch (e) {
    if (!e8.errorConditions(e).includes("file-missing")) throw e;
  }
}

/** The processor named NAME, as org-cite-get-processor. */
export function getProcessor(name: string | undefined): Processor | undefined {
  return name === undefined ? undefined : processors.find((p) => p.name === name);
}

/** Unregisters processor NAME, as org-cite-unregister-processor. */
export function unregisterProcessor(name: string): boolean {
  const i = processors.findIndex((p) => p.name === name);
  if (i < 0) e8.signal("error", `Processor ${name} not registered`);
  processors.splice(i, 1);
  return true;
}

/** Whether processor NAME can activate, export, follow or insert, as org-cite-processor-has-capability-p. */
export function processorHasCapabilityP(name: string, capability: "activate" | "export" | "follow" | "insert"): boolean {
  const p = getProcessor(name);
  if (!p) return false;
  switch (capability) {
    case "activate":
      return typeof p.activate === "function";
    case "export":
      return typeof p.exportCitation === "function";
    case "follow":
      return typeof p.follow === "function";
    case "insert":
      return typeof p.insert === "function";
  }
}

// Internal functions
//
// Plain text is a string here, which has no identity of its own, so text
// is changed where it is: as a slot, the list holding it and its index,
// never looked for by its value, which another string may share.

/** Where a datum is: the list holding it, its contents or a secondary string, and its index there. */
interface Slot {
  list: Datum[];
  index: number;
  parent: Node;
}

/** The slot of a node, in its parent's contents or the secondary string holding it. */
function slotOf(node: Node): Slot | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  let i = parent.contents.indexOf(node);
  if (i >= 0) return { list: parent.contents, index: i, parent };
  for (const name of SECONDARY_VALUES[parent.type] ?? []) {
    const s = parent.p[name];
    if (Array.isArray(s) && (i = s.indexOf(node)) >= 0) return { list: s, index: i, parent };
  }
  return undefined;
}

/** Whether the export ignores a datum. */
function ignored(d: Datum, info: Info): boolean {
  const list: Datum[] | undefined = info["ignore-list"];
  return typeof d !== "string" && list !== undefined && list.includes(d);
}

/** The slot of the datum before a node, skipping ignored ones, as org-export-get-previous-element finds it. */
function previousSlot(node: Node, info: Info): Slot | undefined {
  const slot = slotOf(node);
  if (!slot) return undefined;
  for (let i = slot.index - 1; i >= 0; i--) if (!ignored(slot.list[i], info)) return { ...slot, index: i };
  return undefined;
}

/** The slot of the datum after a node, skipping ignored ones, as org-export-get-next-element finds it. */
function nextSlot(node: Node, info: Info): Slot | undefined {
  const slot = slotOf(node);
  if (!slot) return undefined;
  for (let i = slot.index + 1; i < slot.list.length; i++) if (!ignored(slot.list[i], info)) return { ...slot, index: i };
  return undefined;
}

/** Sets the blanks after the datum in a slot, as org-cite--set-post-blank: a string's trailing blanks become BLANKS spaces. */
function setPostBlank(slot: Slot, blanks: number): void {
  const datum = slot.list[slot.index];
  if (typeof datum !== "string") putProperty(datum, "post-blank", blanks);
  else slot.list[slot.index] = datum.replace(/[ \t\n]*$/, " ".repeat(blanks));
}

/** Sets the blanks after a node's datum, as org-cite--set-post-blank on an element or object. */
function setNodePostBlank(node: Node, blanks: number): void {
  putProperty(node, "post-blank", blanks);
}

/** Sets the blanks after what comes before a node, as org-cite--set-previous-post-blank. */
function setPreviousPostBlank(node: Node, blanks: number, info: Info): void {
  const slot = previousSlot(node, info);
  if (slot) setPostBlank(slot, blanks);
}

/** Where a regexp's group N starts in S's match, for the groups of the previous-punctuation regexp. */
function groupStart(m: RegExpExecArray, n: number): number {
  if (n === 0) return m.index;
  // Groups 1 (punctuation), 2 (the quote) and 3 (spacing) run in order with blanks before the quote.
  const g1 = m[1]?.length ?? 0;
  const g2 = m[2]?.length ?? 0;
  const g3 = m[3]?.length ?? 0;
  const before = m[0].length - g1 - g2 - g3;
  return n === 1 ? m.index : n === 2 ? m.index + g1 + before : m.index + m[0].length - g3;
}

/**
 * Splits the string in a slot at group N of REGEXP's match and puts
 * CITATION between the parts, as org-cite--insert-at-split. The slot is
 * before the citation.
 */
function insertAtSplit(slot: Slot, citation: Node, n: number, regexp: RegExp): void {
  const s = slot.list[slot.index] as string;
  // When extracting the citation, remove white spaces before it, but preserve those after it.
  const blank = postBlank(citation);
  if (blank > 0) insertBefore(" ".repeat(blank), citation);
  extract(citation);
  putProperty(citation, "post-blank", 0);
  // The string is where it was, the citation's place being after it.
  slot.list.splice(slot.index, 0, citation);
  citation.parent = slot.parent;
  const m = regexp.exec(s)!;
  const split = groupStart(m, n);
  const first = s.slice(0, split);
  // Trailing white spaces are taken off, as they are before the citation.
  const last = s.slice(split).replace(/[\t\p{Zs}\n]+$/u, "");
  let at = slot.index + 1;
  if (nw(first)) {
    slot.list.splice(slot.index, 0, first);
    at++;
  }
  slot.list[at] = last;
}

/** Moves PUNCT, from the string in a slot after CITATION, before it, as org-cite--move-punct-before. */
function movePunctBefore(punct: string, citation: Node, slot: Slot, info: Info): void {
  const s = slot.list[slot.index] as string;
  if (s === punct) slot.list.splice(slot.index, 1);
  else slot.list[slot.index] = s.slice(punct.length);
  setPreviousPostBlank(citation, 0, info);
  // Blanks between citation and punct are now before punct and citation.
  insertBefore(" ".repeat(postBlank(citation)) + punct, citation);
}

/** A string read as a property list of keywords and string values, as org-cite--parse-as-plist. */
export function parseAsPlist(s: string | undefined): e8.Value[] | undefined {
  if (s === undefined || s === null) return undefined;
  const results: e8.Value[] = [];
  let i = 0;
  let valueFlag = false;
  const skipBlanks = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  const token = () => {
    const origin = i;
    while (i < s.length && s[i] !== " " && s[i] !== "\t") i++;
    return s.slice(origin, i);
  };
  skipBlanks();
  while (i < s.length) {
    if (s[i] === ":") {
      results.push(token());
      valueFlag = true;
    } else if (!valueFlag) token();
    else if (s[i] === '"') {
      const close = /^"((?:[^"\\]|\\.)*)"/s.exec(s.slice(i));
      if (close) {
        results.push(close[1].replace(/\\(.)/gs, "$1"));
        i += close[0].length;
      } else results.push(token());
      valueFlag = false;
    } else {
      results.push(token());
      valueFlag = false;
    }
    skipBlanks();
  }
  return results;
}

/** The default region of languages whose region is not the language again, as org-cite--default-region-alist. */
const DEFAULT_REGIONS: Record<string, string> = {
  af: "za", ca: "ad", cs: "cz", cy: "gb", da: "dk", el: "gr", et: "ee", fa: "ir", he: "ir", ja: "jp", km: "kh",
  ko: "kr", nb: "no", nn: "no", sl: "si", sr: "rs", sv: "se", uk: "ua", vi: "vn", zh: "cn",
};

/** The punctuation rule for the export's language, as org-cite--get-note-rule. */
function getNoteRule(info: Info): string[] {
  const parts = String(info["language"] ?? "en").split(/[-_]/);
  if (parts.length > 2) e8.signal("error", `Invalid language identifier: ${parts}`);
  const tags = parts.length === 1 ? [parts[0], DEFAULT_REGIONS[parts[0]] ?? parts[0]] : parts;
  const languageRegion = tags.map((t) => t.toLowerCase()).join("-");
  const rules = v("org-cite-note-rules");
  const find = (tag: string) => (Array.isArray(rules) ? (rules as e8.Value[][]).find((r) => Array.isArray(r) && r[0] === tag) : undefined);
  const rule = find(languageRegion) ?? find(tags[0]);
  return rule ? rule.slice(1).map((x) => symbolString(x) ?? "") : ["adaptive", "outside", "after"];
}

// Generic tools

/** Quotes taken off a string, as org-strip-quotes. */
function stripQuotes(s: string): string {
  return /^".*"$/s.test(s) ? s.slice(1, -1) : s;
}

/** A setup file's #+BIBLIOGRAPHY: values, each with the directory it is in, those of the setup files it names in their place. */
function setupFileBibliographies(value: string, dir: string, seen: string[]): [string, string][] {
  const file = e8.expandFileName(stripQuotes(value.trim()), dir);
  if (seen.includes(file) || !e8.fileReadableP(file)) return [];
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  let text: string;
  try {
    text = e8.withCurrentBuffer(name, () => (e8.insertFileContents(file), e8.bufferText()));
  } finally {
    e8.call("kill-buffer", name);
  }
  const here = e8.fileNameDirectory(file) ?? dir;
  const out: [string, string][] = [];
  for (const line of text.split("\n")) {
    const m = /^[ \t]*#\+(BIBLIOGRAPHY|SETUPFILE):[ \t]*(.*?)[ \t]*$/i.exec(line);
    if (!m) continue;
    if (m[1].toUpperCase() === "BIBLIOGRAPHY") out.push([m[2], here]);
    else out.push(...setupFileBibliographies(m[2], here, [...seen, file]));
  }
  return out;
}

/**
 * The bibliography files the buffer names, then org-cite-global-bibliography's,
 * as org-cite-list-bibliography-files: one a #+SETUPFILE in another
 * directory names relative to it, made relative to the buffer's.
 */
export function listBibliographyFiles(): string[] {
  const dir = String(e8.variable("default-directory") ?? "");
  const pairs: [string, string][] = [];
  for (const [line, , text] of keywordLines()) {
    // A setup file's lines, which keywordLines gives without their directory, are read here.
    if (line < 0) continue;
    const m = /^#\+(BIBLIOGRAPHY|SETUPFILE):[ \t]*(.*?)[ \t]*$/i.exec(text);
    if (!m) continue;
    if (m[1].toUpperCase() === "BIBLIOGRAPHY") pairs.push([m[2], dir]);
    else pairs.push(...setupFileBibliographies(m[2], dir, []));
  }
  const files = pairs.map(([value, d]) => {
    const f = stripQuotes(value);
    if (e8.fileNameAbsoluteP(f) || e8.expandFileName(d) === e8.expandFileName(dir)) return f;
    return fileRelativeName(e8.expandFileName(f, d), dir);
  });
  const global = v("org-cite-global-bibliography");
  if (Array.isArray(global)) for (const f of global) if (typeof f === "string") files.push(f);
  return [...new Set(files)];
}

/**
 * A citation's references, or their keys, as org-cite-get-references: a
 * citation found at point, whose references are not parsed, has them
 * read from the buffer between its contents' ends.
 */
export function getReferences(citation: Node): Node[];
export function getReferences(citation: Node, keysOnly: true): string[];
export function getReferences(citation: Node, keysOnly = false): Node[] | string[] {
  let refs = contents(citation).filter((c): c is Node => typeof c !== "string" && c.type === "citation-reference");
  const [cb, ce] = [contentsBegin(citation), contentsEnd(citation)];
  if (contents(citation).length === 0 && cb !== undefined && ce !== undefined) {
    refs = parseSecondaryString(e8.bufferText(cb, ce), ["citation-reference"]).filter((c): c is Node => typeof c !== "string");
    for (const ref of refs) {
      map(ref, true, (x) => {
        if (typeof x !== "string") for (const key of ["begin", "end", "contents-begin", "contents-end"]) if (typeof x.p[key] === "number") x.p[key] += cb;
        return undefined;
      });
      ref.parent = citation;
    }
    citation.contents = refs;
  }
  return keysOnly ? refs.map((r) => String(property("key", r))) : refs;
}

/** Where a citation starts and ends, without the blanks after it, as org-cite-boundaries. */
export function boundaries(citation: Node): [number, number] {
  return [beginOf(citation)!, endOf(citation)! - postBlank(citation)];
}

/** Where a reference's key, with its @, starts and ends, as org-cite-key-boundaries. */
export function keyBoundaries(reference: Node): [number, number] {
  const b = beginOf(reference)!;
  const text = e8.bufferText(b, endOf(reference)!);
  const m = /@[\p{L}\p{N}\-.:?!`'/*@+|(){}<>&_^$#%~]+/u.exec(text);
  return m ? [b + m.index, b + m.index + m[0].length] : [b, b];
}

/** The affixes of a citation with one reference, else the citation's own, as org-cite-main-affixes. */
export function mainAffixes(citation: Node): [Datum[] | undefined, Datum[] | undefined] {
  const refs = getReferences(citation);
  const source = refs.length === 1 ? refs[0] : citation;
  return [property("prefix", source), property("suffix", source)];
}

/** The styles and variants the export processors know, merged, as org-cite-supported-styles. */
export function supportedStyles(names?: string[]): [string[], ...string[][]][] {
  const chosen =
    names ??
    ((v("org-cite-export-processors") as e8.Value[][] | null) ?? []).map((entry) => symbolString(Array.isArray(entry) ? entry[1] : undefined) ?? "");
  const collection: string[][][] = [];
  for (const name of chosen) {
    const styles = getProcessor(name)?.citeStyles;
    collection.push(...(typeof styles === "function" ? styles() : (styles ?? [])));
  }
  const result: [string, string[], string[][]][] = [];
  for (const [[style, ...shortcuts], ...variants] of collection) {
    const entry = result.find((r) => r[0] === style);
    if (!entry) result.push([style, [...shortcuts], [...variants]]);
    else {
      entry[1] = [...new Set([...shortcuts, ...entry[1]])];
      entry[2] = [...variants, ...entry[2]];
    }
  }
  return result.map(([style, shortcuts, variants]) => {
    const merged: string[][] = [];
    for (const [variant, ...cuts] of variants) {
      const entry = merged.find((m) => m[0] === variant);
      if (!entry) merged.unshift([variant, ...cuts]);
      else entry.splice(1, entry.length - 1, ...new Set([...cuts, ...entry.slice(1)]));
    }
    return [[style, ...shortcuts], ...merged] as [string[], ...string[][]];
  });
}

/** Deletes a citation or a citation reference, the citation too with its last reference, as org-cite-delete-citation. */
export function deleteCitation(datum: Node): void {
  if (datum.type === "citation") {
    const [begin, end] = boundaries(datum);
    let before = begin;
    while (before > e8.pointMin() && /[ \t]/.test(e8.bufferText(before - 1, before))) before--;
    const after = endOf(datum)!;
    const bol = e8.lineStart(e8.lineOf(before));
    const firstOnLine = before === bol;
    const lastOnLine = after === e8.lineEnd(e8.lineOf(after));
    if (firstOnLine && lastOnLine) {
      const line = e8.lineOf(bol);
      e8.deleteRegion(bol, line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : e8.pointMax());
    } else if (firstOnLine) e8.deleteRegion(begin, after);
    else if (lastOnLine) e8.deleteRegion(before, e8.lineEnd(e8.lineOf(before)));
    else {
      e8.deleteRegion(before, end);
      if (after === end) e8.saveExcursion(() => (e8.gotoChar(before), e8.insert(" ")));
    }
  } else if (datum.type === "citation-reference") {
    const citation = datum.parent!;
    const references = getReferences(citation);
    const begin = beginOf(datum)!;
    const end = endOf(datum)!;
    if (references.length === 1) deleteCitation(citation);
    else if (begin === contentsBegin(citation) && !property("prefix", citation)) {
      let p = begin;
      while (p > e8.pointMin() && /[ \t]/.test(e8.bufferText(p - 1, p))) p--;
      e8.deleteRegion(p, end);
    } else if (end === contentsEnd(citation) && !property("suffix", citation)) e8.deleteRegion(begin - 1, boundaries(citation)[1] - 1);
    else e8.deleteRegion(begin, end);
  } else e8.signal("error", `Invalid object type: ${datum.type}`);
}

// Finding citations in the buffer, where Org's parser finds the objects at point.

/** The citations in the text from START to END, their positions the buffer's, parsed as a paragraph's objects. */
export function citationsIn(start: number, end: number): Node[] {
  const text = e8.bufferText(start, end);
  if (!text.includes("[cite")) return [];
  const data = parseSecondaryString(text, restriction("paragraph"));
  const found = map(data, "citation", (d) => d as Node) as Node[];
  const shift = (d: Datum) => {
    map(
      d,
      true,
      (x) => {
        if (typeof x === "string") return undefined;
        for (const key of ["begin", "end", "contents-begin", "contents-end"]) if (typeof x.p[key] === "number") x.p[key] += start;
        return undefined;
      },
    );
  };
  for (const c of found) shift(c);
  return found;
}

/** The text around a position that a citation at it lies in: its paragraph, heading or the like, as elements bound objects. */
function objectContainer(pos: number): [number, number] {
  let line = e8.lineOf(pos);
  // A paragraph's lines: up to blank lines, headings and the like, a few dozen at most.
  const stop = (l: number) => /^[ \t]*$|^\*+ /.test(e8.lineText(l));
  if (/^\*+ /.test(e8.lineText(line))) return [e8.lineStart(line), e8.lineEnd(line)];
  let first = line;
  while (first > 0 && line - first < 50 && !stop(first - 1)) first--;
  let last = line;
  while (last + 1 < e8.lineCount() && last - line < 50 && !stop(last + 1)) last++;
  return [e8.lineStart(first), e8.lineEnd(last)];
}

/**
 * The citation or citation reference at a position, if Org's context
 * there, as org-element-context finds it, is one: not in an example or
 * source block, or other text with no objects; a reference's parent its
 * citation.
 */
export function citationContext(pos = e8.point()): Node | undefined {
  const context = objectAt(pos);
  return context?.type === "citation" || context?.type === "citation-reference" ? context : undefined;
}

// Tools only available during export

/** The style of a citation as [name, variant], as org-cite-citation-style. */
export function citationStyle(citation: Node, info: Info): [string | undefined, string | undefined] {
  const separate = (s: string | undefined): [string | undefined, string | undefined] => {
    if (s === undefined || s === null) return [undefined, undefined];
    const i = s.indexOf("/");
    return i < 0 ? [s, undefined] : [s.slice(0, i), nw(s.slice(i + 1))];
  };
  const local = separate(property("style", citation));
  const cite = info["cite-export"];
  const global = separate(Array.isArray(cite) ? cite[2] : undefined);
  if (nw(local[0])) return [notNil(local[0]), local[1]];
  return [notNil(global[0]), local[1] ?? global[1]];
}

/** A processor declaration, "NAME [BIBLIOGRAPHY-STYLE [CITATION-STYLE]]", read, as org-cite-read-processor-declaration. */
export function readProcessorDeclaration(s: string): [string, string | undefined, string | undefined] {
  let i = 0;
  const skip = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  const token = (): string | undefined => {
    skip();
    if (i >= s.length) return undefined;
    if (s[i] === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/s.exec(s.slice(i));
      if (!m) e8.signal("end-of-file", "End of file during parsing");
      i += m[0].length;
      return m[1].replace(/\\(.)/gs, "$1");
    }
    const origin = i;
    while (i < s.length && s[i] !== " " && s[i] !== "\t") i++;
    return s.slice(origin, i);
  };
  const name = token();
  if (name === undefined) e8.signal("end-of-file", "End of file during parsing");
  const bib = notNil(token());
  const cite = notNil(token());
  skip();
  if (i < s.length) e8.signal("error", `Trailing garbage following cite export processor declaration ${JSON.stringify(s)}`);
  return [name!, bib, cite];
}

/** The export's citation processor's name, as org-cite-processor. */
export function processorName(info: Info): string | undefined {
  return info["cite-export"]?.[0];
}

/** The expected bibliography style, as org-cite-bibliography-style. */
export function bibliographyStyle(info: Info): string | undefined {
  return info["cite-export"]?.[1];
}

/** A #+print_bibliography: keyword's properties, as org-cite-bibliography-properties. */
export function bibliographyProperties(keyword: Node): e8.Value[] | undefined {
  return parseAsPlist(property("value", keyword));
}

/** The map options of an export: what it ignores. */
function ignoring(info: Info): { ignore?: Datum[] } {
  return { ignore: info["ignore-list"] };
}

/**
 * The citations in the exported document, in order, footnotes' where
 * their references are, as org-cite-list-citations.
 */
export function listCitations(info: Info): Node[] {
  if (info["citations"]) return info["citations"];
  const cites: Node[] = [];
  const tree = info["parse-tree"];
  const cache = new Map<string, Datum[] | string>();
  let definitions: Node[] | undefined;
  const findDefinition = (label: string): Datum[] | string | undefined => {
    if (cache.has(label)) return cache.get(label);
    definitions ??= map(tree, "footnote-definition", (d) => d as Node, ignoring(info));
    for (const d of definitions) {
      if (property("label", d) === label) {
        const c = contents(d).length > 0 ? contents(d) : "";
        cache.set(label, c);
        return c;
      }
    }
    return undefined;
  };
  const search = (data: Datum | Datum[] | undefined): void => {
    map(
      data,
      ["citation", "footnote-reference"],
      (datum) => {
        const node = datum as Node;
        if (node.type === "citation") cites.push(node);
        else if (property("type", node) !== "inline") {
          const found = findDefinition(property("label", node));
          if (Array.isArray(found)) search(found);
        }
        return undefined;
      },
      { ...ignoring(info), noRecursion: ["footnote-definition"], withAffiliated: true },
    );
  };
  search(tree);
  info["citations"] = cites;
  return cites;
}

/** The keys cited in the exported document, first appearance first, as org-cite-list-keys. */
export function listKeys(info: Info): string[] {
  const keys = map(listCitations(info), "citation-reference", (r) => String(property("key", r)), ignoring(info));
  return [...new Set(keys)];
}

/** A key's number, by first citation or as PREDICATE sorts the keys, as org-cite-key-number. */
export function keyNumber(key: string, info: Info, predicate?: (a: string, b: string) => boolean): number | undefined {
  const keys = listKeys(info);
  const sorted = predicate ? stableSort(keys, predicate) : keys;
  const i = sorted.indexOf(key);
  return i < 0 ? undefined : i + 1;
}

/** Sorts a list as Emacs's sort does, stably, with a "less than" predicate. */
export function stableSort<T>(list: T[], less: (a: T, b: T) => boolean): T[] {
  const indexed = list.map((x, i) => [x, i] as [T, number]);
  indexed.sort(([a, i], [b, j]) => (less(a, b) ? -1 : less(b, a) ? 1 : i - j));
  return indexed.map(([x]) => x);
}

/** The footnote holding a citation, if one does, as org-cite-inside-footnote-p; with STRICT, only as its whole contents. */
export function insideFootnoteP(citation: Node, strict = false): Node | undefined {
  const footnote = lineage(citation, ["footnote-definition", "footnote-reference"])[0];
  if (!footnote) return undefined;
  if (strict) {
    const c = contents(citation.parent);
    if (!(c.length === 1 && c[0] === citation)) return undefined;
  }
  return footnote;
}

/** Wraps an anonymous inline footnote around a citation in the parse tree, as org-cite-wrap-citation. */
export function wrapCitation(citation: Node, info: Info): Node {
  const footnote = create("footnote-reference", {
    type: "inline",
    "contents-begin": beginOf(citation),
    "contents-end": endOf(citation),
    "post-blank": postBlank(citation),
  });
  // Remove any white space before the citation.
  setPreviousPostBlank(citation, 0, info);
  insertBefore(footnote, citation);
  adoptElements(footnote, extract(citation));
  return footnote;
}

/** A regexp matching any of the strings, as regexp-opt. */
function regexpOpt(strings: string[]): string {
  return strings.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/**
 * Moves a citation about to become a footnote, and the punctuation around
 * it, as the export's language's rule says, as org-cite-adjust-note.
 */
export function adjustNote(citation: Node, info: Info, givenRule?: string[], givenPunct?: string[]): void {
  if (!truthy(v("org-cite-adjust-note-numbers"))) return;
  let rule: (string | undefined)[] = givenRule ?? getNoteRule(info);
  const marks = givenPunct ?? (((v("org-cite-punctuation-marks") as string[] | null) ?? []) as string[]);
  const punctRe = regexpOpt(marks);
  // Blanks as Emacs's [[:blank:]] has them, Unicode's spaces and the tab, and newlines.
  const previousPunctRe = new RegExp(`(?:([\\t\\p{Zs}\\n]*(?:${punctRe})))?(?:[\\t\\p{Zs}\\n]*("))?([\\t\\p{Zs}\\n]+)?$`, "u");
  const nextPunctRe = new RegExp(`^([\\t\\p{Zs}\\n]*(?:${punctRe}))`, "u");
  const nextAt = nextSlot(citation, info);
  const next = nextAt?.list[nextAt.index];
  let finalPunct = typeof next === "string" ? nextPunctRe.exec(next)?.[1] : undefined;
  const previousAt = lastTerminal(previousSlot(citation, info), info);
  const previous = previousAt?.list[previousAt.index];
  let punct: string | undefined;
  let quote: string | undefined;
  let spacing: string | undefined;
  if (typeof previous === "string") {
    const m = previousPunctRe.exec(previous);
    if (m) [punct, quote, spacing] = [m[1], m[2], m[3]];
  }
  // Bail out when there is no quote and either no punctuation, or punctuation on both sides.
  if (!(quote || (punct === undefined) !== (finalPunct === undefined))) return;
  // Phase 1: the punctuation rule.
  if (quote) {
    const where = rule[0];
    const prev = previousAt!;
    if (where === "inside" || (where === "adaptive" && !spacing)) {
      // Only when there is a quotation before the citation not ending with punctuation.
      if (!punct && finalPunct) {
        const s = prev.list[prev.index] as string;
        const m = previousPunctRe.exec(s)!;
        const at = groupStart(m, 2);
        prev.list[prev.index] = s.slice(0, at) + finalPunct + '"' + s.slice(at + 1);
        nextAt!.list[nextAt!.index] = (next as string).slice(finalPunct.length);
        punct = finalPunct;
        finalPunct = undefined;
      }
    } else if (where === "outside" || where === "adaptive") {
      // Only when there is inner punctuation and no final punctuation already.
      if (punct && !finalPunct) {
        const s = prev.list[prev.index] as string;
        const m = previousPunctRe.exec(s)!;
        prev.list[prev.index] = s.slice(0, m.index) + s.slice(m.index + (m[1]?.length ?? 0));
        if (typeof next === "string") nextAt!.list[nextAt!.index] = punct + next;
        else if (next !== undefined) nextAt!.list.splice(nextAt!.index, 0, punct);
        else adoptElements(citation.parent!, punct);
        finalPunct = punct;
        punct = undefined;
      }
    } else e8.signal("error", `Invalid punctuation rule: ${rule}`);
  }
  // Phase 2: the citation moved to its place, its relative place made definite first.
  if (rule[1] === "same") rule = [rule[0], punct && finalPunct ? "outside" : punct ? "inside" : finalPunct ? "outside" : undefined, rule[2]];
  const [, number, order] = rule;
  if (number === undefined) return;
  // The text after the citation, where any final punctuation is.
  const after = () => nextSlot(citation, info)!;
  if (number === "inside" && order === "after") {
    if (quote) insertAtSplit(previousAt!, citation, 2, previousPunctRe);
    else if (finalPunct) movePunctBefore(finalPunct, citation, after(), info);
  } else if (number === "inside" && order === "before") {
    if (punct || quote) insertAtSplit(previousAt!, citation, 0, previousPunctRe);
  } else if (number === "outside" && order === "after") {
    if (finalPunct) movePunctBefore(finalPunct, citation, after(), info);
  } else if (number === "outside" && order === "before") {
    if (punct && !quote) insertAtSplit(previousAt!, citation, 0, previousPunctRe);
  } else e8.signal("error", `Invalid punctuation rule: ${rule}`);
}

/** The types adjustNote takes for terminal objects, as org-cite-adjust-note's map lists them. */
const TERMINAL = [
  "citation", "code", "entity", "export-snippet", "footnote-reference", "line-break", "latex-fragment", "link",
  "plain-text", "radio-target", "statistics-cookie", "timestamp", "verbatim",
];

/**
 * The slot of the last terminal datum in the one in SLOT, itself
 * included, walked as org-element-map walks: citations, subscripts and
 * superscripts not entered.
 */
function lastTerminal(slot: Slot | undefined, info: Info): Slot | undefined {
  if (!slot) return undefined;
  let found: Slot | undefined;
  const walk = (s: Slot): void => {
    const d = s.list[s.index];
    if (ignored(d, info)) return;
    const type = typeof d === "string" ? "plain-text" : d.type;
    if (TERMINAL.includes(type)) found = s;
    if (typeof d === "string" || ["citation", "subscript", "superscript"].includes(type)) return;
    for (const name of SECONDARY_VALUES[type] ?? []) {
      const list = d.p[name];
      if (Array.isArray(list)) for (let i = 0; i < list.length; i++) walk({ list, index: i, parent: d });
    }
    for (let i = 0; i < d.contents.length; i++) walk({ list: d.contents, index: i, parent: d });
  };
  walk(slot);
  return found;
}

// Tools generating or operating on parsed data

/** A string parsed as Org elements, to replace a #+print_bibliography: keyword, as org-cite-parse-elements. */
export function parseElements(s: string): Datum[] {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      e8.insert(s);
      const tree = parseBuffer();
      const c = contents(tree);
      if (c.length === 0) return [];
      if (c.length === 1 && typeOf(c[0]) === "section") return contents(c[0]);
      e8.signal("error", "Headlines cannot replace a keyword");
    });
  } finally {
    e8.call("kill-buffer", name);
  }
}

/** A string parsed as a secondary string, to replace a citation, as org-cite-parse-objects. */
export function parseObjects(s: string, affix = false): Datum[] {
  return parseSecondaryString(s, restriction(affix ? "citation-reference" : "paragraph"));
}

/** A paragraph of DATA, as org-cite-make-paragraph. */
export function makeParagraph(...data: (Datum | Datum[] | undefined | null)[]): Node {
  return create("paragraph", {}, ...concat(...data));
}

/** DATA in an emphasis of TYPE, as org-cite-emphasize. */
export function emphasize(type: "bold" | "italic" | "strike-through" | "underline", ...data: (Datum | Datum[] | undefined | null)[]): Node {
  return create(type, {}, ...concat(...data));
}

/** Strings, objects and secondary strings joined into one secondary string, as org-cite-concat. */
export function concat(...data: (Datum | Datum[] | undefined | null | false)[]): Datum[] {
  const results: Datum[] = [];
  for (const datum of data) {
    if (datum === undefined || datum === null || datum === false) continue;
    if (Array.isArray(datum)) results.push(...datum);
    else results.push(datum);
  }
  return results;
}

/** FUNCTION's results on each of DATA joined by SEPARATOR, as org-cite-mapconcat. */
export function mapconcat<T>(fn: (x: T) => Datum | Datum[], data: T[], separator: Datum | Datum[]): Datum[] | undefined {
  if (data.length === 0) return undefined;
  let result: Datum[] = concat(fn(data[0]));
  for (const datum of data.slice(1)) result = concat(result, separator, fn(datum));
  return result;
}

/** Capitalizes each word, as Emacs's capitalize. */
export function capitalizeWords(s: string): string {
  return s.replace(/[\p{L}\p{N}]+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** A string or raw string capitalized, as org-cite-capitalize. */
export function capitalize(str: Datum): Datum {
  if (typeof str === "string") return capitalizeWords(str);
  if (typeOf(str) === "raw") return exportFunctions().rawString(capitalizeWords(contents(str).join("")));
  return e8.signal("error", `${JSON.stringify(str)} must be either a string or raw string object`);
}

// Activation, as fontification

/** Fontifies a citation with org-cite, and its keys with org-cite-key, as org-cite-fontify-default. */
export function fontifyDefault(cite: Node): void {
  const [beg, end] = boundaries(cite);
  e8.putTextProperty(beg, end, "font-lock-multiline", true);
  e8.addFaceTextProperty(beg, end, "org-cite");
  for (const reference of getReferences(cite)) {
    const [b, e] = keyBoundaries(reference);
    e8.addFaceTextProperty(b, e, "org-cite-key");
  }
}

/** Activates the citations from START to END with org-cite-activate-processor's function, as org-cite-activate. */
export function activate(start: number, end: number): void {
  const name = symbolString(v("org-cite-activate-processor"));
  if (name !== undefined) tryLoadProcessor(name);
  const fn = (name !== undefined && processorHasCapabilityP(name, "activate") ? getProcessor(name)!.activate : undefined) ?? fontifyDefault;
  const from = e8.lineStart(e8.lineOf(start));
  const to = Math.min(e8.lineEnd(e8.lineOf(Math.max(from, end - 1))), e8.pointMax());
  const [cstart] = objectContainer(from);
  const [, cend] = objectContainer(to);
  e8.withSilentModifications(() => {
    for (const cite of citationsIn(cstart, cend)) if (endOf(cite)! > from && beginOf(cite)! < to) fn(cite);
  });
}

// The interface with the exporter

/** Stores the bibliography files in the export's information, as org-cite-store-bibliography. */
export function storeBibliography(info: Info): void {
  info["bibliography"] = listBibliographyFiles();
}

/**
 * Stores the export's citation processor as [name, bibliography style,
 * citation style] in its information, from a CITE_EXPORT keyword or
 * org-cite-export-processors, as org-cite-store-export-processor.
 */
export function storeExportProcessor(info: Info): void {
  const err = (s: unknown): never => e8.userError(`Invalid cite export processor declaration: ${JSON.stringify(s)}`);
  const value = info["cite-export"];
  let processor: [string, string | undefined, string | undefined] | undefined;
  if (value === undefined || value === null || value === false || value === "") processor = undefined;
  else if (typeof value === "string") processor = readProcessorDeclaration(value);
  else if (Array.isArray(value)) {
    const backend = info["back-end"];
    const { derivedBackendP } = exportFunctions();
    const key = (entry: e8.Value): string | undefined => (Array.isArray(entry) ? symbolString(entry[0]) : undefined);
    const candidates = stableSort(
      (value as e8.Value[]).filter((entry) => key(entry) !== "t" && key(entry) !== undefined && derivedBackendP(backend, key(entry)!)),
      (a, b) => derivedBackendP(key(a), key(b)!),
    );
    const chosen = candidates[0] ?? (value as e8.Value[]).find((entry) => key(entry) === "t");
    if (chosen !== undefined) {
      const p = (chosen as e8.Value[]).slice(1);
      const name = symbolString(p[0]);
      const ok = (x: e8.Value | undefined) => x === undefined || x === null || typeof x === "string";
      if (name === undefined || p.length > 3 || !ok(p[1]) || !ok(p[2])) err(p);
      processor = [name!, (p[1] as string | null) ?? undefined, (p[2] as string | null) ?? undefined];
    }
  } else err(value);
  if (processor) {
    const name = processor[0];
    tryLoadProcessor(name);
    if (!getProcessor(name)) e8.userError(`Unknown processor ${name}`);
    if (!processorHasCapabilityP(name, "export")) e8.userError(`Processor ${name} is unable to handle citation export`);
  }
  info["cite-export"] = processor;
}

/** What the export's processor makes of a citation, as org-cite-export-citation. */
export function exportCitation(citation: Node, info: Info): string | Datum | Datum[] | undefined | null {
  const p = info["cite-export"];
  if (!p) return undefined;
  return getProcessor(p[0])!.exportCitation!(citation, citationStyle(citation, info), info["back-end"], info);
}

/** What the export's processor makes of a #+print_bibliography: keyword, as org-cite-export-bibliography. */
export function exportBibliography(keyword: Node, info: Info): string | Datum | Datum[] | undefined {
  const p = info["cite-export"];
  if (!p) return undefined;
  const f = getProcessor(p[0])!.exportBibliography;
  if (!f) return undefined;
  return f(listKeys(info), info["bibliography"] ?? [], bibliographyStyle(info), bibliographyProperties(keyword) ?? [], info["back-end"], info);
}

/** Replaces each citation in the parse tree with what the processor makes of it, as org-cite-process-citations. */
export function processCitations(info: Info): void {
  const { rawString } = exportFunctions();
  for (const cite of listCitations(info)) {
    const replacement = exportCitation(cite, info);
    const blanks = postBlank(cite);
    if (replacement === undefined || replacement === null || (Array.isArray(replacement) && replacement.length === 0)) {
      // The citation's blanks go to what is before it.
      setPreviousPostBlank(cite, blanks, info);
    } else {
      // A space between a quotation mark and a citation, for the adaptive note rule.
      const at = previousSlot(cite, info);
      const previous = at?.list[at.index];
      if (nw(previous) && (previous as string).endsWith('"')) setPreviousPostBlank(cite, 1, info);
      if (typeof replacement === "string") insertBefore(rawString(orgTrim(replacement) + " ".repeat(blanks)), cite);
      else if (!Array.isArray(replacement)) {
        setNodePostBlank(replacement, blanks);
        insertBefore(replacement, cite);
      } else {
        // Spliced in the citation's place, its blanks after the last.
        for (const datum of replacement) insertBefore(datum, cite);
        const slot = slotOf(cite)!;
        setPostBlank({ ...slot, index: slot.index - 1 }, blanks);
      }
    }
    extract(cite);
  }
}

/** Replaces each #+print_bibliography: keyword in the parse tree, as org-cite-process-bibliography. */
export function processBibliography(info: Info): void {
  const { rawString } = exportFunctions();
  const keywords = map(info["parse-tree"], "keyword", (k) => (property("key", k) === "PRINT_BIBLIOGRAPHY" ? (k as Node) : undefined), ignoring(info));
  for (const keyword of keywords) {
    const replacement = exportBibliography(keyword, info);
    const blanks = postBlank(keyword);
    if (replacement === undefined || replacement === null) {
      setPreviousPostBlank(keyword, blanks, info);
      extract(keyword);
    } else if (typeof replacement === "string") {
      replace(keyword, rawString(normalizeString(replacement) + "\n".repeat(blanks)));
    } else if (Array.isArray(replacement)) {
      // Spliced in the keyword's place, its blank lines after the last.
      for (const datum of replacement) insertBefore(datum, keyword);
      const slot = slotOf(keyword)!;
      if (replacement.length > 0) setPostBlank({ ...slot, index: slot.index - 1 }, blanks);
      extract(keyword);
    } else {
      setNodePostBlank(replacement, blanks);
      replace(keyword, replacement);
    }
  }
}


/** The export's output, through the processor's finalizer if it has one, as org-cite-finalize-export. */
export function finalizeExport(output: string, info: Info): string {
  const p = info["cite-export"];
  if (!p) return output;
  const f = getProcessor(p[0])!.exportFinalizer;
  return f ? f(output, listKeys(info), info["bibliography"] ?? [], bibliographyStyle(info), info["back-end"], info) : output;
}

// Following, from org-open-at-point

/** Follows a citation or reference with org-cite-follow-processor, as org-cite-follow. */
export function follow(datum: Node, arg: e8.PrefixArg): void {
  const name = symbolString(v("org-cite-follow-processor"));
  if (name === undefined) e8.userError("No processor set to follow citations");
  tryLoadProcessor(name!);
  if (!getProcessor(name)) e8.userError(`Unknown processor ${name}`);
  if (!processorHasCapabilityP(name!, "follow")) e8.userError(`Processor ${name} cannot follow citations`);
  getProcessor(name)!.follow!(datum, arg);
}

// Inserting citations

/** The keywords whose values Org parses, as org-element-parsed-keywords. */
const PARSED_KEYWORDS = ["CAPTION"];

/**
 * Whether a citation can be inserted at point, as org-cite--allowed-p
 * judges Org's context there: the object at point, as org-element-context
 * finds it, else the element.
 */
function allowedP(): boolean {
  const pos = e8.point();
  const object = objectAt(pos);
  const found = elementAt(pos);
  const element = found ? withAffiliated(found) : undefined;
  const bol = e8.lineStart(e8.lineOf(pos));
  const type = object?.type ?? element?.type;
  // On an affiliated keyword: only in a parsed keyword's value.
  if (!object && element?.postAffiliated !== undefined && pos < element.postAffiliated) {
    return new RegExp(`^[ \\t]*#\\+(?:${PARSED_KEYWORDS.join("|")}):.*$`, "i").test(e8.bufferText(bol, pos));
  }
  // Paragraphs and blank lines at the top of the document.
  if (type === undefined || type === "paragraph") return true;
  // A verse block's contents.
  if (!object && type === "verse-block") return pos >= (element!.contentsBegin ?? Infinity) && pos < (element!.contentsEnd ?? -Infinity);
  // On a heading or inline task, its title, or the blank lines below it.
  if (!object && (type === "headline" || type === "inlinetask")) {
    const line = e8.lineText(e8.lineOf(pos));
    if (!/^\*+ /.test(line)) return true;
    if (/^\*+ END[ \t]*$/i.test(line)) return false;
    const h = parseHeading(e8.lineOf(pos));
    if (!h) return false;
    const from = h.title !== "" ? h.titleAt : h.priorityAt !== undefined ? h.priorityAt + 4 : h.todoAt !== undefined ? h.todoAt + h.todo!.length : h.start + h.level + 1;
    return pos >= from && (h.tagsAt === undefined || pos < h.tagsAt);
  }
  // White space after an object, or blank lines after an element.
  const contextEnd = object ? endOf(object)! : element!.end;
  let back = contextEnd;
  while (back > e8.pointMin() && /[ \r\t\n]/.test(e8.bufferText(back - 1, back))) back--;
  const after = object ? back : e8.lineOf(back) + 1 < e8.lineCount() ? e8.lineStart(e8.lineOf(back) + 1) : e8.pointMax();
  if (pos >= after) return true;
  // Right after a footnote definition's label.
  if (!object && type === "footnote-definition") return /^\s/.test(e8.bufferText(pos, Math.min(pos + 1, e8.pointMax())));
  // At the start of an item, after its bullet and checkbox.
  if (!object && type === "item") {
    const line = e8.lineText(e8.lineOf(element!.begin));
    const indentation = /^[ \t]*/.exec(line)![0].replace(/\t/g, "        ").length;
    const checkbox = /^[ \t]*(?:[-+*]|(?:[0-9]+|[A-Za-z])[.)])(?:[ \t]+\[@(?:start:)?(?:[0-9]+|[A-Za-z])\])?[ \t]+\[[ X-]\]/.test(line);
    return pos > element!.begin + indentation + (checkbox ? 5 : 1);
  }
  // Other elements.
  if (!object) return false;
  // Just before an object.
  if (pos === beginOf(object)) return true;
  if (type === "link") return false;
  if (type === "table-cell") {
    let p = pos;
    while (p > e8.pointMin() && /[ \t]/.test(e8.bufferText(p - 1, p))) p--;
    return contentsEnd(object) !== undefined && p <= contentsEnd(object)!;
  }
  const [cb, ce] = [contentsBegin(object), contentsEnd(object)];
  return cb !== undefined && ce !== undefined && pos >= cb && pos <= ce;
}

/** Inserts STRING and a semicolon before a reference, as org-cite--insert-string-before. */
function insertStringBefore(s: string, reference: Node): void {
  e8.saveExcursion(() => {
    e8.gotoChar(beginOf(reference)!);
    e8.insert(s + ";");
  });
}

/** Inserts STRING after a reference, as org-cite--insert-string-after. */
function insertStringAfter(s: string, reference: Node): void {
  e8.saveExcursion(() => {
    const at = endOf(reference)!;
    e8.gotoChar(at);
    // Moving forward when inserting at point, so the insertion can happen again.
    if (e8.bufferText(at - 1, at) === ";") e8.insertBeforeMarkers(s + ";");
    else e8.insertBeforeMarkers(";" + s);
  });
}

/** A citation made of keys, as org-cite--keys-to-citation. */
function keysToCitation(keys: string[]): Node {
  return create("citation", {}, ...keys.map((k) => create("citation-reference", { key: k })));
}

/**
 * An insert processor from a function selecting keys and one selecting a
 * style, as org-cite-make-insert-processor: on a citation's style it
 * edits the style, on its prefix or suffix it adds a reference before the
 * first or after the last, on a reference it replaces the key, or adds one
 * before or after it, and elsewhere it inserts a citation, its style too
 * with a prefix argument, which on a citation or reference deletes it.
 */
export function makeInsertProcessor(
  selectKey: (multiple: boolean) => string | string[] | undefined,
  selectStyle: (citation: Node) => string | undefined,
): (context: Node | undefined, arg: e8.PrefixArg) => void {
  return (context, arg) => {
    const pos = e8.point();
    if (context?.type === "citation") {
      const [b, e] = boundaries(context);
      if (pos < e && pos > b) {
        if (truthy(arg)) {
          deleteCitation(context);
          return;
        }
        const begin = beginOf(context)!;
        const styleEnd = begin + e8.bufferText(begin, e).indexOf(":");
        if (styleEnd >= pos) {
          const styleStart = begin + 5;
          const style = selectStyle(context);
          if (style === undefined || style === null) e8.userError("Aborted");
          e8.saveExcursion(() => {
            e8.deleteRegion(styleStart, styleEnd);
            e8.gotoChar(styleStart);
            if (nw(style)) e8.insert("/" + style);
          });
        } else {
          const references = getReferences(context);
          const key = "@" + String(selectKey(false) ?? "");
          if (pos < contentsBegin(context)!) insertStringBefore(key, references[0]);
          else insertStringAfter(key, references[references.length - 1]);
        }
        return;
      }
    } else if (context?.type === "citation-reference") {
      if (truthy(arg)) {
        deleteCitation(context);
        return;
      }
      const [start, end] = keyBoundaries(context);
      const selected = selectKey(false);
      if (selected === undefined || selected === null) e8.userError("Aborted");
      const key = "@" + String(selected);
      // Right before the "@", a new reference before this one.
      if (start >= pos) insertStringBefore(key, context);
      else if (end <= pos) insertStringAfter(key, context);
      else
        e8.saveExcursion(() => {
          e8.deleteRegion(start, end);
          e8.gotoChar(start);
          e8.insert(key);
        });
      return;
    }
    const keys = selectKey(true) as string[] | undefined;
    if (!keys || keys.length === 0) e8.userError("Aborted");
    let style = "";
    if (truthy(arg)) {
      const s = selectStyle(keysToCitation(keys!));
      if (nw(s)) style = "/" + s;
    }
    e8.insert(`[cite${style}:${keys!.map((k) => "@" + k).join("; ")}]`);
  };
}

/** Inserts a citation at point, or edits the one there, with org-cite-insert-processor, as org-cite-insert. */
export function insert(arg: e8.PrefixArg): void {
  const name = symbolString(v("org-cite-insert-processor"));
  if (name === undefined) e8.userError("No processor set to insert citations");
  tryLoadProcessor(name!);
  if (!getProcessor(name)) e8.userError(`Unknown processor ${name}`);
  if (!processorHasCapabilityP(name!, "insert")) e8.userError(`Processor ${name} cannot insert citations`);
  const context = citationContext();
  const fn = getProcessor(name)!.insert!;
  if (context) fn(context, arg);
  else if (allowedP()) fn(undefined, arg);
  else e8.userError("Cannot insert a citation here");
}

e8.defineCommand({
  name: "org-cite-insert",
  doc: "Insert a citation at point, as org-cite-insert-processor does; with a prefix argument, its style too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => insert(arg),
});

/** Follows the citation at point, if there is one, for org-open-at-point; whether there was. */
e8.defun("org-cite--follow-at-point", (arg?: e8.PrefixArg) => {
  const context = citationContext();
  if (!context) return false;
  follow(context, arg ?? null);
  return true;
});

/** Activates the citations between two positions, for jit-lock. */
e8.defun("org-cite-activate", (start: number, end: number) => activate(start, end));
