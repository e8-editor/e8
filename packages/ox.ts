// Org's generic export engine, after ox.el: backends, the options an
// export reads, the parse tree pruned for it, the transcoding of each
// element and object through a backend's transcoders and filters, the
// tools backends share, and the dispatcher on C-c C-e.
//
// The communication channel Org calls INFO is an object here, its keys
// Org's property names without the colon ("with-toc", "parse-tree").
// Option values read as Lisp data, from #+OPTIONS: or a variable, are
// JavaScript values: t and nil true and false, a symbol its name, a list
// an array. E8 reads them and evaluates nothing (ADR 0116).

import {
  ALL_ELEMENTS,
  ALL_OBJECTS,
  type Datum,
  GREATER_ELEMENTS,
  type Node,
  RECURSIVE_OBJECTS,
  SECONDARY_VALUES,
  ancestor,
  contents,
  create,
  extract,
  insertBefore,
  isObject,
  lineage,
  map,
  mapFirst,
  type MapOptions,
  postBlank,
  property,
  replace,
  setContents,
  adoptElements,
  typeOf,
} from "org-element-ast";
import {
  interpretAffiliatedKeywords,
  interpretData,
  interpretNode,
  linkParser,
  normalizeContents,
  normalizeString,
  forgetSettings,
  parseBuffer,
  parseSecondaryString,
  restriction,
} from "org-element";
import { allKeywords, entryGetInherited, type Heading, headingIndex, headings, keywordLines, linkTypeEntries, subtreeRegion } from "org";
import { allMatches, forwardLine, getBufferWindow, withSelectedWindow } from "subr";
import { keyChar } from "simple";
import { endOfMetaData, entryGet, entryPut } from "org-list";
import { fileRelativeName } from "files";
import { orgIdFind } from "org-id";
import { lineAt, orgFitWindowToBuffer, orgPopToBufferSplit, orgRegionActive } from "org-macs";
import { initializeTemplates, replaceAll as macroReplaceAll } from "org-macro";
import { processBuffer as babelExpProcessBuffer } from "ob-exp";
import { DICTIONARY } from "ox-dictionary";

// --- Values ----------------------------------------------------------------

/** Signal an error, as Lisp's error. */
export function err(message: string): never {
  return e8.signal("error", message);
}

/** Whether a value is non-nil as Lisp takes it: not undefined, null, false or an empty list. */
export function nonNil(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0);
}

/** An export command's optional argument as a flag: "" (what M-x passes for one it does not ask) is nil. */
export function flag(v: unknown): boolean {
  return v !== "" && nonNil(v);
}

/** A variable's or Lisp datum's value as a plain JavaScript value: symbols as their names, nil as false. */
export function lispValue(v: unknown): any {
  if (typeof v === "symbol") {
    const name = e8.symbolName(v as any);
    return name === "nil" ? false : name === "t" ? true : name;
  }
  if (Array.isArray(v)) return v.map(lispValue);
  if (v === null || v === undefined) return false;
  return v;
}

/** A variable's value, as lispValue makes it. */
export function varValue(name: string): any {
  return lispValue(e8.variable(name));
}

/** Whether a number is a natural number, as wholenump. */
const wholenump = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Lisp data read from text, as `read` reads an option's value: numbers,
 * strings, symbols (t and nil as true and false, others by name) and
 * lists. Returns the datum and where reading stopped.
 */
export function readDatum(text: string, start = 0): [any, number] {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return [false, i];
  const c = text[i];
  if (c === "(") {
    const list: any[] = [];
    i++;
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length) return [list, i];
      if (text[i] === ")") return [list, i + 1];
      if (text[i] === "." && /\s/.test(text[i + 1] ?? "")) {
        // A dotted pair: its tail joins the list.
        const [tail, j] = readDatum(text, i + 1);
        if (Array.isArray(tail)) list.push(...tail);
        else list.push(tail);
        i = j;
        continue;
      }
      const [d, j] = readDatum(text, i);
      list.push(d);
      if (j === i) return [list, j + 1];
      i = j;
    }
  }
  if (c === '"') {
    let s = "";
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\" && i + 1 < text.length) {
        const n = text[++i];
        s += n === "n" ? "\n" : n === "t" ? "\t" : n;
      } else s += text[i];
      i++;
    }
    return [s, i + 1];
  }
  if (c === "'") {
    const [d, j] = readDatum(text, i + 1);
    return [d, j];
  }
  let j = i;
  while (j < text.length && !/[\s()"']/.test(text[j])) j++;
  const atom = text.slice(i, j);
  if (/^[-+]?\d+$/.test(atom)) return [parseInt(atom, 10), j];
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+(\.\d*)?e[-+]?\d+)$/.test(atom)) return [parseFloat(atom), j];
  if (atom === "nil") return [false, j];
  if (atom === "t") return [true, j];
  return [atom.replace(/\\(.)/g, "$1"), j];
}

// --- Variables ---------------------------------------------------------------

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
const sym = (name: string) => e8.intern(name);

defvar("org-export-with-archived-trees", sym("headline"), "Whether subtrees with the ARCHIVE tag are exported: headline exports only their headings, t all of them, nil none.");
defvar("org-export-with-author", true, "Whether the author's name is exported.");
defvar("org-export-with-clocks", false, "Whether CLOCK lines are exported.");
defvar("org-export-with-creator", false, "Whether the creator sentence is exported.");
defvar("org-export-with-date", true, "Whether the date is exported.");
defvar("org-export-process-citations", true, "Whether citations are processed.");
defvar("org-export-date-timestamp-format", null, "The format of a DATE that is a timestamp, as format-time-string's, or nil to keep it as written.");
defvar("org-export-creator-string", "E8 (Org mode)", "Who made the document, as the creator keyword and the {{{creator}}} macro say.");
defvar("org-export-with-drawers", [sym("not"), "LOGBOOK"], "Which drawers are exported: t all, nil none, a list of names those, or (not NAME...) all but those.");
defvar("org-export-with-email", false, "Whether the author's email is exported.");
defvar("org-export-with-emphasize", true, "Whether *bold*, /italic/, _underline_ and +strike-through+ are interpreted.");
defvar("org-export-exclude-tags", ["noexport"], "Tags that leave a subtree out of the export.");
defvar("org-export-with-fixed-width", true, "Whether lines starting with a colon are exported.");
defvar("org-export-with-footnotes", true, "Whether footnotes are exported.");
defvar("org-export-with-latex", true, "Whether LaTeX environments and fragments are exported: t processes them, verbatim keeps them as written, nil leaves them out.");
defvar("org-export-headline-levels", 3, "The deepest level still exported as a heading; deeper ones become lists.");
defvar("org-export-default-language", "en", "The language of exported documents, for translations.");
defvar("org-export-preserve-breaks", false, "Whether every line break is kept.");
defvar("org-export-with-entities", true, "Whether entities such as \\alpha are interpreted.");
defvar("org-export-with-inlinetasks", true, "Whether inline tasks are exported.");
defvar("org-export-with-planning", false, "Whether planning lines (SCHEDULED, DEADLINE, CLOSED) are exported.");
defvar("org-export-with-priority", false, "Whether priority cookies are exported.");
defvar("org-export-with-properties", false, "Whether property drawers are exported: t all, a list of property names those.");
defvar("org-export-with-section-numbers", true, "Whether headings are numbered: t all, a number down to that level.");
defvar("org-export-select-tags", ["export"], "Tags that select the subtrees to export, when any heading has one.");
defvar("org-export-with-smart-quotes", false, "Whether quotes are made typographic.");
defvar("org-export-with-special-strings", true, "Whether \\-, -- , --- and ... are interpreted.");
defvar("org-export-with-statistics-cookies", true, "Whether statistics cookies are exported.");
defvar("org-export-with-sub-superscripts", true, "Whether _ and ^ make subscripts and superscripts: t, nil, or {} for only braced ones.");
defvar("org-export-with-toc", true, "Whether a table of contents is made: t, nil, or a number of levels.");
defvar("org-export-with-tables", true, "Whether tables are exported.");
defvar("org-export-with-tags", true, "Whether tags are exported: t, nil, or not-in-toc.");
defvar("org-export-with-tasks", true, "Which TODO entries are exported: t all, nil none, todo or done those, or a list of keywords.");
defvar("org-export-with-title", true, "Whether the title is exported.");
defvar("org-export-timestamp-file", true, "Whether the time of the export is put in the exported file.");
defvar("org-export-with-timestamps", true, "Which timestamps are exported: t all, nil none, active or inactive those.");
defvar("org-export-with-todo-keywords", true, "Whether TODO keywords are exported.");
defvar("org-export-allow-bind-keywords", false, "Whether #+BIND: keywords set variables for the export.");
defvar("org-export-with-broken-links", false, "What a link that cannot be resolved does: nil fails the export, mark marks it, t ignores it.");
defvar("org-export-expand-links", true, "Whether environment variables in file links are expanded.");
defvar("org-export-snippet-translation-alist", [], "Export snippet backend names and the backends they stand for, as [[\"h\", \"html\"]].");
defvar("org-export-global-macros", [], "Macros every export knows, as [[name, template]].");
defvar("org-export-coding-system", null, "The coding system exported files are written in, or nil for the buffer's.");
defvar("org-export-copy-to-kill-ring", false, "Whether an export's output is pushed onto the kill ring: t, nil, or if-interactive.");
defvar("org-export-initial-scope", sym("buffer"), "The dispatcher's starting scope: buffer or subtree.");
defvar("org-export-show-temporary-export-buffer", true, "Whether exporting to a buffer shows it.");
defvar("org-export-body-only", false, "Whether the dispatcher starts with Body only on.");
defvar("org-export-visible-only", false, "Whether the dispatcher starts with Visible only on.");
defvar("org-export-force-publishing", false, "Whether the dispatcher starts with Force publishing on.");
defvar("org-export-in-background", false, "Whether the dispatcher starts with Async export on; E8 exports in the foreground.");
defvar("org-export-dispatch-use-expert-ui", false, "Whether the dispatcher only prompts, without its menu.");
defvar("org-export-before-processing-functions", [], "Functions called with the backend's name in the copy of the buffer, before anything is expanded.");
defvar("org-export-before-parsing-functions", [], "Functions called with the backend's name in the copy of the buffer, just before it is parsed.");
defvar("org-export-current-backend", null, "The name of the backend an export runs, while it runs.");
defvar("org-export-use-babel", true, "Whether source blocks are processed by Babel when exporting.");
defvar("org-export-smart-quotes-alist", null, "Smart quotes by language; E8 reads its own table.");

// --- Backends ----------------------------------------------------------------

export type Info = { [key: string]: any };
/** A transcoder: the datum, its contents transcoded (undefined for none), and the export's information. */
export type Transcoder = (datum: any, contents: any, info: Info) => string | undefined | null | false;
/** A filter: the value, the backend's name, the information; a string replaces the value, "" drops it. */
export type Filter = (value: any, backend: string | undefined, info: Info) => any;
/** An option, as an entry of org-export-options-alist: the property, its keyword, its #+OPTIONS: item, its default (a variable's name, or a function), and how several keywords combine. */
export type OptionEntry = [string, string | undefined, string | undefined, string | (() => any) | undefined, ("parse" | "split" | "space" | "newline" | "replace" | undefined)?];
export type MenuEntry = [string, string, ([string, string, (...args: any[]) => any][] | ((...args: any[]) => any))?];

export interface Backend {
  name?: string;
  parent?: string | Backend;
  /** Each type's transcoder: (datum, contents, info), plain text's (text, info), and template and inner-template (contents, info). */
  transcoders: { [type: string]: (...args: any[]) => any };
  options?: OptionEntry[];
  filters?: { [filter: string]: Filter | Filter[] };
  blocks?: string[];
  menu?: MenuEntry;
}

/** The backends defined, as org-export-registered-backends. */
export const registered: Backend[] = [];

export function getBackend(name: string | Backend | undefined): Backend | undefined {
  if (name === undefined || typeof name !== "string") return name;
  return registered.find((b) => b.name === name);
}

export function registerBackend(backend: Backend): void {
  if (!backend.name) throw new Error("Cannot register a unnamed export backend");
  if (typeof backend.parent === "string" && !getBackend(backend.parent)) throw new Error(`Cannot use unknown "${backend.parent}" backend as a parent`);
  const old = registered.findIndex((b) => b.name === backend.name);
  if (old >= 0) registered[old] = backend;
  else registered.unshift(backend);
}

/** Define a backend, as org-export-define-backend. */
export function defineBackend(name: string, transcoders: Backend["transcoders"], opts: { filters?: Backend["filters"]; menu?: MenuEntry; options?: OptionEntry[] } = {}): Backend {
  const b: Backend = { name, transcoders, filters: opts.filters, menu: opts.menu, options: opts.options };
  registerBackend(b);
  return b;
}

/** Define a backend from another, its transcoders taking the other's place where given, as org-export-define-derived-backend. */
export function defineDerivedBackend(name: string, parent: string, opts: { translate?: Backend["transcoders"]; filters?: Backend["filters"]; menu?: MenuEntry; options?: OptionEntry[] } = {}): Backend {
  const b: Backend = { name, parent, transcoders: opts.translate ?? {}, filters: opts.filters, menu: opts.menu, options: opts.options };
  registerBackend(b);
  return b;
}

/** A backend made on the spot, as org-export-create-backend. */
export function createBackend(b: Backend): Backend {
  return b;
}

function chain(backend: string | Backend | undefined): Backend[] {
  const out: Backend[] = [];
  let b = getBackend(backend);
  while (b) {
    out.push(b);
    b = b.parent === undefined ? undefined : getBackend(b.parent);
  }
  return out;
}

/** Whether a backend is one of `names` or derives from one, as org-export-derived-backend-p. */
export function derivedBackendP(backend: string | Backend | undefined, ...names: string[]): boolean {
  return chain(backend).some((b) => b.name !== undefined && names.includes(b.name));
}

export function getAllTranscoders(backend: string | Backend | undefined): Backend["transcoders"] {
  const out: Backend["transcoders"] = {};
  for (const b of chain(backend).reverse()) Object.assign(out, b.transcoders);
  return out;
}

export function getAllOptions(backend: string | Backend | undefined): OptionEntry[] {
  return chain(backend).flatMap((b) => b.options ?? []);
}

export function getAllFilters(backend: string | Backend | undefined): [string, Filter | Filter[]][] {
  return chain(backend).flatMap((b) => Object.entries(b.filters ?? {}));
}

// --- Options -------------------------------------------------------------------

/** The options every backend knows, as org-export-options-alist. */
export const OPTIONS: OptionEntry[] = [
  ["title", "TITLE", undefined, undefined, "parse"],
  ["date", "DATE", undefined, undefined, "parse"],
  ["author", "AUTHOR", undefined, "user-full-name", "parse"],
  ["email", "EMAIL", undefined, "user-mail-address", "replace"],
  ["language", "LANGUAGE", undefined, "org-export-default-language", "replace"],
  ["select-tags", "SELECT_TAGS", undefined, "org-export-select-tags", "split"],
  ["exclude-tags", "EXCLUDE_TAGS", undefined, "org-export-exclude-tags", "split"],
  ["creator", "CREATOR", undefined, "org-export-creator-string"],
  ["headline-levels", undefined, "H", "org-export-headline-levels"],
  ["preserve-breaks", undefined, "\\n", "org-export-preserve-breaks"],
  ["section-numbers", undefined, "num", "org-export-with-section-numbers"],
  ["time-stamp-file", undefined, "timestamp", "org-export-timestamp-file"],
  ["with-archived-trees", undefined, "arch", "org-export-with-archived-trees"],
  ["with-author", undefined, "author", "org-export-with-author"],
  ["expand-links", undefined, "expand-links", "org-export-expand-links"],
  ["with-broken-links", undefined, "broken-links", "org-export-with-broken-links"],
  ["with-clocks", undefined, "c", "org-export-with-clocks"],
  ["with-creator", undefined, "creator", "org-export-with-creator"],
  ["with-date", undefined, "date", "org-export-with-date"],
  ["with-drawers", undefined, "d", "org-export-with-drawers"],
  ["with-email", undefined, "email", "org-export-with-email"],
  ["with-emphasize", undefined, "*", "org-export-with-emphasize"],
  ["with-entities", undefined, "e", "org-export-with-entities"],
  ["with-fixed-width", undefined, ":", "org-export-with-fixed-width"],
  ["with-footnotes", undefined, "f", "org-export-with-footnotes"],
  ["with-inlinetasks", undefined, "inline", "org-export-with-inlinetasks"],
  ["with-latex", undefined, "tex", "org-export-with-latex"],
  ["with-planning", undefined, "p", "org-export-with-planning"],
  ["with-priority", undefined, "pri", "org-export-with-priority"],
  ["with-properties", undefined, "prop", "org-export-with-properties"],
  ["with-smart-quotes", undefined, "'", "org-export-with-smart-quotes"],
  ["with-special-strings", undefined, "-", "org-export-with-special-strings"],
  ["with-special-rows", undefined, undefined, undefined],
  ["with-statistics-cookies", undefined, "stat", "org-export-with-statistics-cookies"],
  ["with-sub-superscript", undefined, "^", "org-export-with-sub-superscripts"],
  ["with-toc", undefined, "toc", "org-export-with-toc"],
  ["with-tables", undefined, "|", "org-export-with-tables"],
  ["with-tags", undefined, "tags", "org-export-with-tags"],
  ["with-tasks", undefined, "tasks", "org-export-with-tasks"],
  ["with-timestamps", undefined, "<", "org-export-with-timestamps"],
  ["with-title", undefined, "title", "org-export-with-title"],
  ["with-todo-keywords", undefined, "todo", "org-export-with-todo-keywords"],
  ["with-cite-processors", undefined, undefined, () => false],
  ["cite-export", "CITE_EXPORT", undefined, undefined],
];

/** The filters every export installs, by property, and the variable holding the user's, as org-export-filters-alist. */
const FILTER_TYPES = [
  "body", "bold", "babel-call", "center-block", "clock", "code", "diary-sexp", "drawer", "dynamic-block", "entity",
  "example-block", "export-block", "export-snippet", "final-output", "fixed-width", "footnote-definition",
  "footnote-reference", "headline", "horizontal-rule", "inline-babel-call", "inline-src-block", "inlinetask", "italic",
  "item", "keyword", "latex-environment", "latex-fragment", "line-break", "link", "node-property", "options",
  "paragraph", "parse-tree", "plain-list", "plain-text", "planning", "property-drawer", "quote-block", "radio-target",
  "section", "special-block", "src-block", "statistics-cookie", "strike-through", "subscript", "superscript", "table",
  "table-cell", "table-row", "target", "timestamp", "underline", "verbatim", "verse-block",
];
for (const t of FILTER_TYPES) defvar(`org-export-filter-${t}-functions`, [], `Functions filtering the transcoded ${t} of every export: each takes the text, the backend's name and the export's information, and returns the new text, nil to keep it, or "" to drop it.`);

function optionDefault(entry: OptionEntry): any {
  const d = entry[3];
  if (d === undefined) return undefined;
  const v = typeof d === "function" ? d() : varValue(d);
  return entry[4] === "parse" ? (typeof v === "string" ? parseSecondaryString(v, restriction("keyword")) : v === false ? undefined : v) : v;
}

/** An #+OPTIONS: line's items, as org-export--parse-option-keyword reads them. */
export function parseOptionKeyword(options: string, backend?: string | Backend): Info {
  const line: [string, any][] = [];
  const re = /\s*(.+?):/y;
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    // As re-search-forward: the next ITEM: wherever it starts.
    const m = /\s*(.+?):/g;
    m.lastIndex = i;
    const found = m.exec(options);
    if (!found) break;
    const after = found.index + found[0].length;
    if (after < options.length && /\S/.test(options[after])) {
      const [datum, j] = readDatum(options, after);
      line.unshift([found[1], datum]);
      i = j;
    } else i = after;
  }
  const out: Info = {};
  if (line.length === 0) return out;
  for (const entry of [...getAllOptions(backend), ...OPTIONS]) {
    const item = entry[2];
    if (item === undefined) continue;
    const v = line.find(([k]) => k.toLowerCase() === item.toLowerCase());
    if (v && !(entry[0] in out)) out[entry[0]] = v[1];
  }
  return out;
}

/** A property of the heading at a line as org-entry-get reads it with 'selective inheritance. */
function entryGetSelective(h: Heading, name: string): string | undefined {
  const inherit = varValue("org-use-property-inheritance");
  const inherits = inherit === true || (Array.isArray(inherit) && inherit.includes(name)) || (typeof inherit === "string" && e8.stringMatch(inherit, name) !== undefined);
  return inherits ? entryGetInherited(h, name) : entryGet(h.line, name);
}

/** The heading at or before point, as org-back-to-heading finds it. */
function headingAtPoint(): Heading | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : all[i];
}

function getSubtreeOptions(backend?: string | Backend): Info {
  return e8.saveRestriction(() => {
    e8.widen();
    const h = headingAtPoint();
    if (!h) return {};
    const o = entryGetSelective(h, "EXPORT_OPTIONS");
    const plist: Info = o ? parseOptionKeyword(o, backend) : {};
    const cache = new Map<string, string | undefined>();
    cache.set("TITLE", entryGetSelective(h, "EXPORT_TITLE") ?? h.title);
    for (const option of [...getAllOptions(backend), ...OPTIONS]) {
      const keyword = option[1];
      if (!keyword) continue;
      let value = cache.get(keyword);
      if (!cache.has(keyword)) {
        value = entryGetSelective(h, `EXPORT_${keyword}`);
        cache.set(keyword, value);
      }
      if (value !== undefined && !(option[0] in plist))
        plist[option[0]] = option[4] === "parse" ? parseSecondaryString(value, restriction("keyword")) : option[4] === "split" ? value.split(/\s+/).filter(Boolean) : value;
    }
    return plist;
  });
}

/** The values of keywords in the buffer, as org-collect-keywords: each name with its values in order. */
export function collectKeywords(names: string[]): [string, string[]][] {
  const upper = names.map((n) => n.toUpperCase());
  const out = new Map<string, string[]>();
  for (const [, , text] of keywordLines()) {
    const m = /^#\+(\S+?):[ \t]*(.*?)[ \t]*$/.exec(text);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (!upper.includes(key)) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(m[2]);
  }
  return [...out];
}

function getInbufferOptions(backend?: string | Backend): Info {
  const options = [...getAllOptions(backend), ...OPTIONS];
  let plist: Info = {};
  const toParse: string[] = [];
  const keywords = options.map((o) => o[1]).filter((k): k is string => k !== undefined);
  for (const [keyword, values] of collectKeywords([...keywords, "FILETAGS", "OPTIONS"])) {
    if (keyword === "OPTIONS") {
      for (const v of values) plist = { ...plist, ...parseOptionKeyword(v, backend) };
    } else if (keyword === "FILETAGS") {
      const tags: string[] = [];
      for (const v of values) for (const t of v.split(":")) if (t !== "" && !tags.includes(t)) tags.push(t);
      plist["filetags"] = tags;
    } else {
      const properties: string[] = [];
      for (const o of options) if (o[1] === keyword && !properties.includes(o[0])) properties.push(o[0]);
      for (const p of properties) {
        const behavior = options.find((o) => o[0] === p)![4];
        let value: any;
        if (behavior === "parse") {
          if (!toParse.includes(p)) toParse.push(p);
          value = values.join("\n");
        } else if (behavior === "space") value = values.join(" ");
        else if (behavior === "newline") value = values.join("\n");
        else if (behavior === "split") value = values.flatMap((v) => v.split(/\s+/).filter(Boolean));
        else if (behavior === "replace") value = values[values.length - 1];
        else value = values[0];
        plist[p] = value;
      }
    }
  }
  for (const p of toParse) {
    const value = parseSecondaryString(plist[p], restriction("keyword"));
    map(value, "plain-text", (s, parent) => {
      if (typeof s === "string" && s.includes("\n")) {
        const list = parent ? parent.contents : value;
        const i = list.indexOf(s);
        if (i >= 0) list[i] = s.replace(/\n/g, " ");
      }
      return undefined;
    });
    for (let i = 0; i < value.length; i++) if (typeof value[i] === "string") value[i] = (value[i] as string).replace(/\n/g, " ");
    plist[p] = value;
  }
  return plist;
}

function getGlobalOptions(backend?: string | Backend): Info {
  const plist: Info = {};
  for (const cell of [...getAllOptions(backend), ...OPTIONS]) if (!(cell[0] in plist)) plist[cell[0]] = optionDefault(cell);
  return plist;
}

/** The #+BIND: keywords' variables and values, as org-export--list-bound-variables, when org-export-allow-bind-keywords lets them. */
function listBoundVariables(): [string, any][] {
  if (!nonNil(varValue("org-export-allow-bind-keywords"))) return [];
  const found = collectKeywords(["BIND"])[0];
  return (found?.[1] ?? []).map((v) => {
    const [list] = readDatum(`(${v})`);
    return [String(list[0]), list[1]] as [string, any];
  });
}

/** The export's options from everywhere they can be set, as org-export-get-environment. */
export function getEnvironment(backend?: string | Backend, subtreep = false, extPlist: Info = {}): Info {
  return { ...getGlobalOptions(backend), ...extPlist, ...getInbufferOptions(backend), ...(subtreep ? getSubtreeOptions(backend) : {}) };
}

// --- Tree properties ---------------------------------------------------------

function collectTreeProperties(data: Node, info: Info): Info {
  info["parse-tree"] = data;
  info["headline-offset"] = 1 - getMinLevel(data, info);
  info["headline-numbering"] = collectHeadlineNumbering(data, info);
  // Each id: link's file, when the ID is known elsewhere, as Org finds it with org-id-find.
  info["id-alist"] = map(data, "link", (l) => {
    if (property("type", l) !== "id") return undefined;
    const id = property("path", l) as string;
    const found = orgIdFind(id);
    return found ? ([id, fileRelativeName(found[0])] as [string, string]) : undefined;
  });
  return info;
}

function getMinLevel(data: Node, info: Info): number {
  let min = 10000;
  for (const d of data.contents) {
    if (typeOf(d) === "headline" && !property("footnote-section-p", d) && !isIgnored(d, info)) {
      min = Math.min(property("level", d), min);
      if (min === 1) return 1;
    }
  }
  return min === 10000 ? 1 : min;
}

const MAX_DEPTH = 19;

function collectHeadlineNumbering(data: Node, info: Info): Map<Node, number[]> {
  const numbering = new Array(MAX_DEPTH).fill(0);
  const out = new Map<Node, number[]>();
  map(
    data,
    "headline",
    (h) => {
      const headline = h as Node;
      if (numberedHeadlineP(headline, info) && !property("footnote-section-p", headline)) {
        const relative = getRelativeLevel(headline, info) - 1;
        const number: number[] = [];
        for (let idx = 0; idx < MAX_DEPTH; idx++) {
          if (idx < relative) number.push(numbering[idx]);
          else if (idx === relative) number.push(++numbering[idx]);
          else numbering[idx] = 0;
        }
        out.set(headline, number);
      }
      return undefined;
    },
    mapOpts(info),
  );
  return out;
}

/** The map options an export walks with: what it ignores. */
export function mapOpts(info: Info, more: MapOptions = {}): MapOptions {
  return { ignore: ignoreSet(info), ...more };
}

function isIgnored(d: Datum, info: Info): boolean {
  return ignoreSet(info)?.has(d) ?? false;
}

/** The ignore list as a set, made again when a filter has added to :ignore-list, as Org's API lets it. */
function ignoreSet(info: Info): Set<Datum> | undefined {
  const list: Datum[] | undefined = info["ignore-list"];
  let set: Set<Datum> | undefined = info["ignore-set"];
  if (list && (!set || set.size !== list.length)) {
    set = new Set(list);
    info["ignore-set"] = set;
  }
  return set;
}

/** Tags as org-tags-expand reads a tag for export: a group tag stands for its members. */
function tagsExpand(tag: string): string[] {
  return [tag];
}

function selectedTrees(data: Node, info: Info): Node[] {
  const select = (info["select-tags"] ?? []).flatMap(tagsExpand);
  const filetags: string[] = info["filetags"] ?? [];
  if (filetags.some((t) => select.includes(t))) return map(data, ["headline", "inlinetask"], (d) => d as Node);
  const selected: Node[] = [];
  const walk = (d: Datum, genealogy: Node[]): void => {
    const type = typeOf(d);
    if (type === "headline" || type === "inlinetask") {
      const tags: string[] = property("tags", d) ?? [];
      if (tags.some((t) => select.includes(t))) selected.push(...genealogy, ...map(d, ["headline", "inlinetask"], (x) => x as Node));
      else if (type === "headline") for (const el of contents(d)) walk(el, [d as Node, ...genealogy]);
    } else if (type === "org-data" || GREATER_ELEMENTS.includes(type!)) for (const el of contents(d)) walk(el, genealogy);
  };
  walk(data, []);
  return selected;
}

function skipP(datum: Datum, parent: Node | undefined, options: Info, selected: Set<Node> | undefined, excluded: string[]): boolean {
  switch (typeOf(datum)) {
    case "comment":
    case "comment-block": {
      const previous = getPreviousElement(datum, options, parent);
      const before = postBlank(previous);
      const after = postBlank(datum);
      if (previous && typeof previous !== "string") previous.p["post-blank"] = Math.max(before, after, 1);
      return true;
    }
    case "clock":
      return !nonNil(options["with-clocks"]);
    case "drawer": {
      const w = options["with-drawers"];
      if (!nonNil(w)) return true;
      if (Array.isArray(w)) {
        const name = String(property("drawer-name", datum)).toLowerCase();
        if (w[0] === "not") return w.slice(1).some((n: string) => String(n).toLowerCase() === name);
        return !w.some((n: string) => String(n).toLowerCase() === name);
      }
      return false;
    }
    case "fixed-width":
      return !nonNil(options["with-fixed-width"]);
    case "footnote-definition":
    case "footnote-reference":
      return !nonNil(options["with-footnotes"]);
    case "headline":
    case "inlinetask": {
      const withTasks = options["with-tasks"];
      const todo = property("todo-keyword", datum);
      const todoType = property("todo-type", datum);
      const archived = options["with-archived-trees"];
      const tags = getTags(datum as Node, options, [], true);
      return (
        (typeOf(datum) === "inlinetask" && !nonNil(options["with-inlinetasks"])) ||
        tags.some((t) => excluded.includes(t)) ||
        (selected !== undefined && !selected.has(datum as Node)) ||
        nonNil(property("commentedp", datum)) ||
        (!nonNil(archived) && nonNil(property("archivedp", datum))) ||
        (todo !== undefined &&
          (!nonNil(withTasks) ||
            ((withTasks === "todo" || withTasks === "done") && todoType !== withTasks) ||
            (Array.isArray(withTasks) && !withTasks.includes(todo))))
      );
    }
    case "latex-environment":
    case "latex-fragment":
      return !nonNil(options["with-latex"]);
    case "node-property": {
      const set = options["with-properties"];
      if (!nonNil(set)) return true;
      if (Array.isArray(set)) return !set.some((p: string) => String(p).toLowerCase() === String(property("key", datum)).toLowerCase());
      return false;
    }
    case "planning":
      return !nonNil(options["with-planning"]);
    case "property-drawer":
      return !nonNil(options["with-properties"]);
    case "statistics-cookie":
      return !nonNil(options["with-statistics-cookies"]);
    case "table":
      return !nonNil(options["with-tables"]);
    case "table-cell":
      return tableHasSpecialColumnP(ancestor(datum, ["table"]) as Node) && firstSiblingP(datum, options);
    case "table-row":
      return !nonNil(options["with-special-rows"]) && tableRowIsSpecialP(datum as Node, options);
    case "timestamp": {
      const parentElement = ancestor(datum, ALL_ELEMENTS, false, parent) as Node | undefined;
      const alone =
        parentElement !== undefined &&
        (parentElement.type === "paragraph" || parentElement.type === "verse-block") &&
        !mapFirst(parentElement, ["plain-text", ...ALL_OBJECTS.filter((t) => t !== "timestamp")], (obj) => typeof obj !== "string" || /\S/.test(obj), mapOpts(options));
      if (!alone) return false;
      const w = options["with-timestamps"];
      const type = property("type", datum);
      if (!nonNil(w)) return true;
      if (w === "active") return type !== "active" && type !== "active-range";
      if (w === "inactive") return type !== "inactive" && type !== "inactive-range";
      return false;
    }
  }
  return false;
}

/** Remove what is not exported from the tree, as org-export--prune-tree, and note the special rows and cells it keeps but ignores. */
function pruneTree(data: Node, info: Info): void {
  const ignore: Datum[] = [];
  const selectedList = selectedTrees(data, info);
  const selected = selectedList.length ? new Set(selectedList) : undefined;
  const excluded: string[] = (info["exclude-tags"] ?? []).flatMap(tagsExpand);
  const walk = (d: Datum, parent: Node | undefined): void => {
    const type = typeOf(d);
    if (skipP(d, parent, info, selected, excluded)) {
      if (type === "table-cell" || type === "table-row") ignore.push(d);
      else {
        const keep = keepSpaces(d, info, parent);
        if (keep) replace(d, keep, parent);
        else extract(d, parent);
      }
      return;
    }
    if (typeof d === "string") return;
    if (type === "headline" && info["with-archived-trees"] === "headline" && nonNil(property("archivedp", d))) setContents(d);
    else for (const c of [...d.contents]) walk(c, d);
    for (const p of SECONDARY_VALUES[type!] ?? []) {
      const s = d.p[p];
      if (Array.isArray(s)) for (const c of [...s]) walk(c, d);
    }
  };
  const definitions = map(data, ["footnote-definition", "footnote-reference"], (f) =>
    typeOf(f) === "footnote-definition" ? (f as Node) : property("type", f) === "inline" && property("label", f) ? (f as Node) : undefined,
  );
  if (selected) {
    const first = data.contents[0];
    if (typeOf(first) === "section") extract(first, data);
  }
  info["ignore-set"] = new Set<Datum>();
  walk(data, undefined);
  for (const entry of [...getAllOptions(info["back-end"]), ...OPTIONS]) {
    if (entry[4] === "parse" && Array.isArray(info[entry[0]])) {
      const value: Datum[] = info[entry[0]];
      // A secondary string with no parent: walk its data in place.
      const holder = create("anonymous", {});
      holder.contents = value;
      for (const c of [...value]) walk(c, holder);
      info[entry[0]] = holder.contents;
    }
  }
  const missing = missingDefinitions(data, definitions);
  for (const m of missing) walk(m, undefined);
  installFootnoteDefinitions(missing, data);
  info["ignore-list"] = ignore;
  info["ignore-set"] = new Set(ignore);
}

function missingDefinitions(tree: Node, definitions: Node[]): Node[] {
  const listLabels = (data: Datum | Datum[]) =>
    map(data, "footnote-reference", (r) => (property("type", r) === "standard" ? (property("label", r) as string) : undefined));
  const defined: string[] = [];
  const undefinedLabels: string[] = [];
  const known = map(tree, ["footnote-reference", "footnote-definition"], (f) =>
    typeOf(f) === "footnote-definition" || property("type", f) === "inline" ? (property("label", f) as string | undefined) : undefined,
  );
  for (const l of listLabels(tree)) {
    if (known.includes(l)) defined.unshift(l);
    else undefinedLabels.unshift(l);
  }
  const missing: Node[] = [];
  const wide: { tree?: Node } = {};
  while (undefinedLabels.length) {
    const label = undefinedLabels.shift()!;
    let definition: Node | undefined = definitions.find((d) => property("label", d) === label);
    if (!definition) definition = footnoteDefinitionFromBuffer(label, wide);
    if (!definition) e8.userError(`Definition not found for footnote ${label}`);
    defined.unshift(label);
    missing.unshift(definition);
    for (const l of listLabels(definition)) if (!defined.includes(l) && !undefinedLabels.includes(l)) undefinedLabels.unshift(l);
  }
  return missing.map((d) =>
    typeOf(d) === "footnote-definition" ? d : create("footnote-definition", { label: property("label", d), "post-blank": 1 }, ...d.contents),
  );
}

/** A footnote definition outside the part exported, parsed from the whole buffer, as org-footnote-get-definition finds it. */
function footnoteDefinitionFromBuffer(label: string, wide: { tree?: Node }): Node | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const tree = (wide.tree ??= parseBuffer());
    return mapFirst(tree, ["footnote-definition", "footnote-reference"], (f) =>
      property("label", f) === label && (typeOf(f) === "footnote-definition" || property("type", f) === "inline") ? (f as Node) : undefined,
    );
  });
}

function installFootnoteDefinitions(definitions: Node[], tree: Node): void {
  if (definitions.length === 0) return;
  const section = mapFirst(tree, "headline", (h) => (nonNil(property("footnote-section-p", h)) ? (h as Node) : undefined));
  if (section) {
    adoptElements(section, ...[...definitions].reverse());
    return;
  }
  const name = varValue("org-footnote-section");
  if (typeof name === "string") {
    adoptElements(
      tree,
      create("headline", { "footnote-section-p": true, level: 1, title: name, "raw-value": name }, create("section", {}, ...[...definitions].reverse())),
    );
    return;
  }
  const seen: string[] = [];
  const insert = (data: Datum): void => {
    map(data, "footnote-reference", (r) => {
      if (property("type", r) !== "standard") return undefined;
      const label = property("label", r);
      if (seen.includes(label)) return undefined;
      seen.push(label);
      const definition = definitions.find((d) => property("label", d) === label);
      const section = ancestor(r, ["section"]) as Node | undefined;
      if (definition && section) {
        adoptElements(section, definition);
        insert(definition);
      }
      return undefined;
    });
  };
  insert(tree);
}

/** Put back as text what the options say not to interpret, as org-export--remove-uninterpreted-data. */
function removeUninterpretedData(data: Datum[] | Node | undefined, info: Info): any {
  if (data === undefined) return data;
  const holder: Node | undefined = Array.isArray(data) ? create("anonymous", {}) : undefined;
  if (holder) holder.contents = data as Datum[];
  map(
    holder ?? (data as Node),
    ["entity", "bold", "italic", "latex-environment", "latex-fragment", "strike-through", "subscript", "superscript", "underline"],
    (d, parentGiven) => {
      const datum = d as Node;
      const parent = datum.parent ?? parentGiven ?? holder;
      const type = datum.type;
      const blank = datum.p["post-blank"];
      const postBlankStr = blank === undefined ? "" : (type === "latex-environment" ? "\n" : " ").repeat(blank);
      let neu: Datum[] | undefined;
      if (type === "entity") {
        if (!nonNil(info["with-entities"])) neu = [expand(datum, undefined) + postBlankStr];
      } else if (type === "bold" || type === "italic" || type === "strike-through" || type === "underline") {
        if (!nonNil(info["with-emphasize"])) {
          const marker = { bold: "*", italic: "/", "strike-through": "+", underline: "_" }[type];
          neu = [marker, ...datum.contents, marker + postBlankStr];
        }
      } else if (type === "latex-environment" || type === "latex-fragment") {
        if (info["with-latex"] === "verbatim") neu = [expand(datum, undefined) + postBlankStr];
      } else {
        const subSuper = info["with-sub-superscript"];
        const bracketp = nonNil(datum.p["use-brackets-p"]);
        if (!nonNil(subSuper) || (subSuper === "{}" && !bracketp))
          neu = [(type === "subscript" ? "_" : "^") + (bracketp ? "{" : ""), ...datum.contents, (bracketp ? "}" : "") + postBlankStr];
      }
      if (neu && parent) {
        for (const e of neu) if (e !== "") insertBefore(e, datum, parent);
        extract(datum, parent);
      }
      return undefined;
    },
    mapOpts(info, { withAffiliated: true }),
  );
  return holder ? holder.contents : data;
}

/** Expand environment variables in file links, as org-export--expand-links. */
function expandLinks(tree: Node, info: Info): void {
  if (!nonNil(info["expand-links"])) return;
  map(
    tree,
    "link",
    (l) => {
      const link = l as Node;
      if (link.p.type === "file") link.p.path = e8.substituteInFileName ? e8.substituteInFileName(link.p.path) : link.p.path;
      return undefined;
    },
    mapOpts(info),
  );
}

// --- Transcoding ---------------------------------------------------------------

/** The transcoder of a datum's type in the export's backend, as org-export-transcoder. */
export function transcoder(d: Datum, info: Info): Transcoder | undefined {
  const type = typeOf(d)!;
  if (type === "org-data") return (_d, c) => c;
  const t = (info["translate-alist"] as Backend["transcoders"])[type];
  return typeof t === "function" ? (t as Transcoder) : undefined;
}

/** The spaces to keep in place of an object left out, as org-export--keep-spaces. */
function keepSpaces(data: Datum, info: Info, parent?: Node): string | undefined {
  const blank = postBlank(data);
  if (blank === 0 || !isObject(data, parent)) return undefined;
  const previous = getPreviousElement(data, info, parent);
  if (previous === undefined) return undefined;
  if (typeof previous === "string" ? /[ \t\r\n]$/.test(previous) : postBlank(previous) > 0) return undefined;
  return " ".repeat(blank);
}

class BrokenLink extends Error {
  path: string;
  constructor(path: string) {
    super(`Unable to resolve link: ${JSON.stringify(path)}`);
    this.path = path;
  }
}

/** Signal a link that cannot be resolved, as Org's org-link-broken error. */
export function brokenLink(path: string): never {
  throw new BrokenLink(path);
}

function withBrokenLinks<T>(info: Info, body: () => T): T | string | undefined {
  try {
    return body();
  } catch (e) {
    if (!(e instanceof BrokenLink)) throw e;
    const w = info["with-broken-links"];
    if (!nonNil(w)) e8.userError(`Org export aborted.  Unable to resolve link: ${JSON.stringify(e.path)}\nSee \`org-export-with-broken-links'`);
    if (w === "mark") return data(`[BROKEN LINK: ${e.path}]`, info);
    return undefined;
  }
}

/** Where a string being transcoded sits, for the transcoders that ask, as smart quotes do. */
export interface TextPlace {
  parent: Node | undefined;
  /** The array it is in: its parent's contents or a secondary string. */
  list: Datum[] | undefined;
  index: number;
}

let currentText: TextPlace | undefined;

/** Where the plain text being transcoded is, as Org reads a string's parent from its text properties. */
export function currentTextPlace(): TextPlace | undefined {
  return currentText;
}

/**
 * Transcode data into a string, as org-export-data: an element, an
 * object, plain text, or a secondary string (an array of them), through
 * the backend's transcoders and the export's filters, memoized.
 */
export function data(d: Datum | Datum[] | undefined | null | false, info: Info, place?: TextPlace): string {
  if (d === undefined || d === null || d === false) return "";
  if (Array.isArray(d)) return d.map((x, i) => data(x, info, { parent: undefined, list: d, index: i })).join("");
  const memo = info["exported-data"] as Map<Datum, string>;
  if (typeof d !== "string") {
    const cached = memo.get(d);
    if (cached !== undefined) return cached;
  }
  const type = typeOf(d)!;
  let results: string | undefined | null | false;
  if (isIgnored(d, info)) results = undefined;
  else if (type === "raw") results = (d as Node).contents[0] as string;
  else if (type === "plain-text") {
    const t = transcoder(d, info) as any;
    const saved = currentText;
    currentText = place;
    try {
      results = applyFilters(info["filter-plain-text"], t ? t(d, info) : d, info);
    } finally {
      currentText = saved;
    }
  } else {
    const node = d as Node;
    const t = transcoder(node, info);
    if (node.contents.length === 0 || (type === "headline" && info["with-archived-trees"] === "headline" && nonNil(node.p.archivedp))) {
      if (t) results = type === "link" ? (withBrokenLinks(info, () => t(node, undefined, info)) as any) : t(node, undefined, info);
    } else if (t) {
      const greaterp = GREATER_ELEMENTS.includes(type);
      const objectp = !greaterp && RECURSIVE_OBJECTS.includes(type);
      const parent = node.parent;
      const source =
        greaterp || objectp
          ? node
          : normalizeContents(
              node,
              type === "paragraph" &&
                (parent?.type === "footnote-definition" || parent?.type === "item") &&
                parent.contents[0] === node &&
                parent.p["pre-blank"] === 0,
            );
      const c = source.contents.map((el, i) => data(el, info, { parent: node, list: source.contents, index: i })).join("");
      results = withBrokenLinks(info, () => t(node, greaterp ? normalizeString(c) : c, info)) as any;
    }
  }
  let out: string;
  if (results === undefined || results === null || results === false) out = keepSpaces(d, info, place?.parent) ?? "";
  else if (type === "org-data" || type === "plain-text" || type === "raw") out = results;
  else {
    const blank = postBlank(d);
    const text = isObject(d, place?.parent) ? results + " ".repeat(blank) : normalizeString(results) + "\n".repeat(blank);
    out = applyFilters(info[`filter-${type}`], text, info);
  }
  if (typeof d !== "string") memo.set(d, out);
  return out;
}

/** Transcode data with another backend, as org-export-data-with-backend. */
export function dataWithBackend(d: Datum | Datum[], backend: string | Backend, info: Info): string {
  const b = getBackend(backend)!;
  const newInfo: Info = { ...info, "back-end": b, "translate-alist": getAllTranscoders(b), "exported-data": new Map() };
  const out = data(d, newInfo);
  info["internal-references"] = newInfo["internal-references"];
  return out;
}

/** A datum written back as Org syntax around its transcoded contents, as org-export-expand. */
export function expand(blob: Node, c: string | undefined, withAffiliated = false): string {
  return (withAffiliated && !isObject(blob) ? interpretAffiliatedKeywords(blob) : "") + interpretNode(blob, c);
}

/** Call the filters on a value in turn, as org-export-filter-apply-functions. */
export function applyFilters(filters: Filter[] | undefined, value: any, info: Info): any {
  const backend = info["back-end"] as Backend | undefined;
  for (const f of filters ?? []) {
    const result = f(value, backend?.name, info);
    if (result === undefined || result === null || result === false) continue;
    if (result === "") return "";
    value = result;
  }
  return value;
}

function asFunctions(v: any): Filter[] {
  const list = Array.isArray(v) ? v : nonNil(v) ? [v] : [];
  return list
    .map((f: any) => (typeof f === "function" ? f : typeof f === "string" || typeof f === "symbol" ? (...args: any[]) => e8.funcall(typeof f === "symbol" ? e8.symbolName(f) : f, ...args) : undefined))
    .filter((f: any): f is Filter => f !== undefined);
}

/** Install the user's and the backend's filters, as org-export-install-filters. */
function installFilters(info: Info): Info {
  const plist: Info = {};
  for (const t of FILTER_TYPES) {
    const key = `filter-${t}`;
    plist[key] = [...asFunctions(info[key]), ...asFunctions(e8.variable(`org-export-filter-${t}-functions`))];
  }
  for (const [key, value] of getAllFilters(info["back-end"])) {
    const k = key.replace(/^:/, "");
    plist[k] = [...asFunctions(value), ...(plist[k] ?? [])];
  }
  return { ...info, ...plist };
}

// --- The export ------------------------------------------------------------------

/**
 * The buffer's text in a buffer of its own, in Org mode, with its text
 * properties, its folding (overlays that hide text), its local variables
 * and its narrowing, as org-export-copy-buffer.
 */
export function withBufferCopy<T>(body: () => T): T {
  const bind = listBoundVariables();
  const source = e8.bufferName();
  const size = e8.bufferSize();
  const hidden: [number, number, e8.Value][] = e8.saveRestriction(() => {
    e8.widen();
    const out: [number, number, e8.Value][] = [];
    for (const ov of e8.overlaysIn(0, size)) {
      const inv = e8.overlayGet(ov, "invisible");
      const from = e8.overlayStart(ov);
      const to = e8.overlayEnd(ov);
      if (inv !== undefined && inv !== null && inv !== false && from !== undefined && to !== undefined && to > from) out.push([from, to, inv]);
    }
    return out;
  });
  const min = e8.pointMin();
  const max = e8.pointMax();
  const pt = e8.point();
  const locals = e8.bufferLocalVariables();
  const file = e8.bufferFileName();
  const name = e8.generateNewBufferName(" *Org Export copy*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      // Org mode without its startup, as the copy Org makes runs it.
      e8.letBind({ "org-inhibit-startup": true }, () => e8.call("org-mode"));
      for (const [variable, value] of locals) {
        if (COPY_SKIPS.has(variable) || variable.startsWith("org-element--cache")) continue;
        try {
          e8.makeLocalVariable(variable);
          e8.setVariable(variable, value);
        } catch {
          // A variable the copy cannot take, such as a read-only one.
        }
      }
      // From the whole of the source, its narrowing aside, as the copy is narrowed after.
      e8.withCurrentBuffer(source, () => e8.saveRestriction(() => {
        e8.widen();
        e8.withCurrentBuffer(name, () => e8.insertBufferSubstring(source, 0, size));
      }));
      for (const [from, to, inv] of hidden) e8.makeOverlay(from, to, { invisible: inv });
      e8.narrowToRegion(min, max);
      e8.gotoChar(pt);
      for (const [variable, value] of bind) {
        e8.makeLocalVariable(variable);
        e8.setVariable(variable, value);
      }
      return e8.letBind({ "e8--export-source-buffer": source, "e8--export-source-file": file ?? null }, body);
    });
  } finally {
    e8.call("kill-buffer", name);
    forgetSettings();
  }
}

const COPY_SKIPS = new Set([
  "buffer-undo-list", "buffer-file-name", "buffer-file-truename", "buffer-read-only", "buffer-saved-size",
  "buffer-display-count", "buffer-display-time", "mark-active", "point-before-scroll", "buffer-auto-save-file-name",
  "buffer-file-number", "major-mode", "mode-name", "font-lock-mode",
  "jit-lock-functions", "after-change-functions", "before-change-functions", "change-major-mode-hook", "kill-buffer-hook",
  "write-contents-functions", "local-write-file-hooks", "auto-save-default", "buffer-auto-save-file-format",
]);
defvar("e8--export-source-buffer", null, "The buffer an export reads from, while it reads its copy.");
defvar("e8--export-source-file", null, "The file the buffer an export reads from visits, while it reads its copy.");

/** The commented subtrees deleted from the copy, as org-export--delete-comment-trees. */
function deleteCommentTrees(): void {
  e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    for (let i = all.length - 1; i >= 0; i--) {
      if (/^COMMENT(?:[ \t]|$)/.test(all[i].title ?? "") ) {
        const [from, to] = subtreeRegion(all, i);
        e8.deleteRegion(from, to);
      }
    }
  });
}

/**
 * Export the current buffer, or the region or subtree, as a string with a
 * backend, as org-export-as.
 */
export function exportAs(backendName: string | Backend, subtreep = false, visibleOnly = false, bodyOnly = false, extPlist: Info = {}): string {
  const backend = getBackend(backendName);
  if (!backend) e8.userError(`Unknown "${String(backendName)}" backend: Aborting export`);
  return e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      if (orgRegionActive()) e8.narrowToRegion(Math.min(e8.point(), e8.mark()!), Math.max(e8.point(), e8.mark()!));
      else if (subtreep) {
        e8.call("org-narrow-to-subtree");
        const h = headingAtPoint();
        if (h) {
          let pos = endOfMetaData(h);
          if (pos > e8.pointMin() && e8.lineStart(e8.lineOf(pos)) === pos && pos > e8.lineStart(e8.lineOf(pos - 1))) pos -= 1;
          e8.narrowToRegion(Math.min(Math.max(pos, e8.pointMin()), e8.pointMax()), e8.pointMax());
        }
      }
      let info: Info = {
        "export-options": [subtreep && "subtree", visibleOnly && "visible-only", bodyOnly && "body-only"].filter(Boolean),
        "back-end": backend,
        "translate-alist": getAllTranscoders(backend),
        "exported-data": new Map(),
        "input-buffer": baseBufferName(),
        "input-file": baseFileName(),
      };
      return e8.letBind({ "org-export-current-backend": backend!.name ?? null }, () =>
        withBufferCopy(() => {
          info = annotateInfo(backend!, info, subtreep, visibleOnly, extPlist);
          const body = normalizeString(data(info["parse-tree"], info) ?? "");
          const translate = info["translate-alist"];
          const inner = translate["inner-template"];
          const fullBody = applyFilters(info["filter-body"], typeof inner === "function" ? inner(body, info) : body, info);
          const template = translate["template"];
          const output = typeof template !== "function" || bodyOnly ? fullBody : template(fullBody, info);
          return applyFilters(info["filter-final-output"], output, info);
        }),
      );
    }),
  );
}

function runHook(name: string, ...args: e8.Value[]): void {
  for (const f of asFunctions(e8.variable(name))) f(args[0], undefined as any, undefined as any);
}

function annotateInfo(backend: Backend, info: Info, subtreep: boolean, visibleOnly: boolean, extPlist: Info): Info {
  const parsedKeywords = [...getAllOptions(backend), ...OPTIONS].filter((o) => o[4] === "parse" && o[1]).map((o) => o[1]!);
  runHook("org-export-before-processing-functions", backend.name ?? null);
  expandIncludeKeyword(undefined, undefined, undefined, undefined, nonNil(info["expand-links"]));
  deleteCommentTrees();
  initializeTemplates(varValue("org-export-global-macros"));
  macroReplaceAll(undefined, parsedKeywords);
  if (nonNil(varValue("org-export-use-babel"))) {
    babelExpProcessBuffer();
    macroReplaceAll([["results", "$1"]], parsedKeywords);
  }
  e8.gotoChar(e8.pointMin());
  e8.saveExcursion(() => runHook("org-export-before-parsing-functions", backend.name ?? null));
  info = { ...info, ...getEnvironment(backend, subtreep, extPlist) };
  for (const entry of [...getAllOptions(backend), ...OPTIONS])
    if (entry[4] === "parse" && Array.isArray(info[entry[0]])) info[entry[0]] = removeUninterpretedData(info[entry[0]], info);
  info = installFilters(info);
  for (const f of info["filter-options"] ?? []) {
    const result = f(info, backend.name, info);
    if (result && typeof result === "object") info = result;
  }
  let tree = parseBuffer(undefined, visibleOnly);
  pruneTree(tree, info);
  removeUninterpretedData(tree, info);
  expandLinks(tree, info);
  tree = applyFilters(info["filter-parse-tree"], tree, info);
  return collectTreeProperties(tree, info);
}

/** Export a string of Org text, as org-export-string-as. */
export function stringAs(text: string, backend: string | Backend, bodyOnly = false, extPlist: Info = {}): string {
  const name = e8.generateNewBufferName(" *Org Export string*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      e8.insert(text);
      e8.letBind({ "org-inhibit-startup": true }, () => e8.call("org-mode"));
      return exportAs(backend, false, false, bodyOnly, extPlist);
    });
  } finally {
    e8.call("kill-buffer", name);
  }
}

function copyToKillRingP(): boolean {
  const v = varValue("org-export-copy-to-kill-ring");
  if (v === "if-interactive") return !nonNil(varValue("noninteractive")) && !nonNil(varValue("executing-kbd-macro"));
  return v === true;
}

/** Export to a buffer, erased first, and show it, as org-export-to-buffer. */
export function toBuffer(backend: string | Backend, buffer: string, subtreep = false, visibleOnly = false, bodyOnly = false, extPlist: Info = {}, postProcess?: () => void): string {
  const output = exportAs(backend, subtreep, visibleOnly, bodyOnly, extPlist);
  e8.getBufferCreate(buffer);
  if (/\S/.test(output) && copyToKillRingP()) e8.killNew(output);
  e8.withCurrentBuffer(buffer, () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.insert(output);
    });
    e8.gotoChar(0);
    postProcess?.();
  });
  if (nonNil(varValue("org-export-show-temporary-export-buffer"))) e8.call("switch-to-buffer-other-window", buffer);
  return buffer;
}

/** Export to a file, as org-export-to-file; returns the file, or what post-processing returns. */
export function toFile(backend: string | Backend, file: string, subtreep = false, visibleOnly = false, bodyOnly = false, extPlist: Info = {}, postProcess?: (file: string) => any): any {
  if (!e8.fileWritableP(file)) err("Output file not writable");
  const output = exportAs(backend, subtreep, visibleOnly, bodyOnly, { ...extPlist, "output-file": file });
  const coding = varValue("org-export-coding-system");
  const name = e8.generateNewBufferName(" *Org Export file*");
  e8.getBufferCreate(name);
  try {
    e8.withCurrentBuffer(name, () => {
      e8.insert(output);
      if (!output.endsWith("\n")) e8.insert("\n");
      e8.letBind(nonNil(coding) ? { "coding-system-for-write": coding } : {}, () => e8.writeRegion(null, null, file, { quiet: true }));
    });
  } finally {
    e8.call("kill-buffer", name);
  }
  if (copyToKillRingP() && /\S/.test(output)) e8.killNew(output);
  return (postProcess && postProcess(file)) || file;
}

/** The name of the buffer an indirect buffer shares its text with, or the current buffer's, as (buffer-name (buffer-base-buffer)). */
export function baseBufferName(): string {
  const base = e8.bufferBaseBuffer();
  return (base && e8.bufferName(base)) || e8.bufferName();
}

/** The file of the buffer an indirect buffer shares its text with, or the current buffer's, as (buffer-file-name (buffer-base-buffer)). */
export function baseFileName(): string | undefined {
  const base = e8.bufferBaseBuffer();
  return base ? e8.withCurrentBuffer(base, () => e8.bufferFileName()) : e8.bufferFileName();
}

/** The file to export to, with an extension, as org-export-output-file-name. */
export function outputFileName(extension: string, subtreep = false, pubDir?: string): string {
  const visited = baseFileName();
  let base: string | undefined;
  if (subtreep) {
    const h = headingAtPoint();
    if (h) base = entryGetSelective(h, "EXPORT_FILE_NAME");
  }
  if (base === undefined) {
    const found = collectKeywords(["EXPORT_FILE_NAME"])[0];
    if (found && found[1].length) base = found[1][0];
  }
  if (base === undefined && visited) base = e8.fileNameNondirectory(visited.replace(/\.gpg$/, ""));
  if (base === undefined) base = e8.readFileName("Output file: ", pubDir ? { dir: pubDir } : {});
  const sansExt = base.replace(/\.[^./]*$/, "");
  base = sansExt + extension;
  const output = pubDir ? e8.fileNameAsDirectory(pubDir) + e8.fileNameNondirectory(base) : base;
  if (visited && e8.expandFileName(visited) === e8.expandFileName(output)) return output + extension;
  return output;
}

// --- #+INCLUDE ------------------------------------------------------------------

interface IncludeParameters {
  file?: string;
  location?: string;
  onlyContents: boolean;
  lines?: string;
  env?: "literal";
  minlevel?: number;
  args?: string;
  block?: string;
}

/** An #+INCLUDE: value read, as org-export-parse-include-value. */
export function parseIncludeValue(value: string, dir?: string, inducedLevel?: number): IncludeParameters {
  let location: string | undefined;
  let file: string | undefined;
  value = value.replace(/:coding +(\S+)>/, "");
  const fm = /^(".+?"|\S+)(?:\s+|$)/.exec(value);
  if (fm) {
    let matched = fm[1];
    value = value.slice(0, fm.index) + value.slice(fm.index + fm[0].length);
    const loc = /(::(.*?))"?$/.exec(matched);
    if (loc) {
      location = loc[2];
      matched = matched.slice(0, loc.index) + matched.slice(loc.index + loc[1].length);
    }
    const stripped = matched.replace(/^"(.*)"$/, "$1");
    file = /^[a-z][-a-z0-9+.]*:\/\//i.test(stripped) ? stripped : e8.expandFileName(stripped, dir);
  }
  let onlyContents = false;
  const oc = /:only-contents *([^: \r\t\n]\S*)?/.exec(value);
  if (oc) {
    onlyContents = oc[1] !== undefined && oc[1] !== "nil";
    value = value.replace(oc[0], "");
  }
  let lines: string | undefined;
  const lm = /:lines +"([0-9]*-[0-9]*)"/.exec(value);
  if (lm) {
    lines = lm[1];
    value = value.replace(lm[0], "");
  }
  let env: "literal" | undefined;
  let envMatch: RegExpExecArray | null = null;
  if ((envMatch = /\bexample\b/.exec(value))) env = "literal";
  else if ((envMatch = /\bexport(?: +(.*))?/.exec(value))) env = "literal";
  else if ((envMatch = /\bsrc(?: +(.*))?/.exec(value))) env = "literal";
  let minlevel: number | undefined;
  if (!env) {
    const ml = /:minlevel +([0-9]+)/.exec(value);
    if (ml) {
      minlevel = parseInt(ml[1], 10);
      value = value.replace(ml[0], "");
    } else minlevel = inducedLevel;
  }
  let args: string | undefined;
  if (env === "literal" && envMatch && envMatch[1] !== undefined) {
    args = envMatch[1];
    value = value.slice(0, envMatch.index + envMatch[0].length - envMatch[1].length) + value.slice(envMatch.index + envMatch[0].length);
  }
  let block: string | undefined;
  const bm = /"(\S+)"/.exec(value) ?? /\b(\S+)\b/.exec(value);
  if (bm && (bm.index === 0 || value[bm.index - 1] !== ":")) block = bm[1];
  return { file, location, onlyContents, lines, env, minlevel, args, block };
}


/** A link's path written from the includer's directory rather than the included file's, as org-export--update-included-link. */
function rebasedPath(path: string, fileDir: string, includerDir: string): string {
  if (path.startsWith("/") || path.startsWith("~") || /^\/[^/:]+:/.test(path)) return path;
  return fileRelativeName(e8.expandFileName(path, fileDir), includerDir);
}

/**
 * The lines of a file to include, as org-export--prepare-file-contents:
 * those LINES says, file links rebased on the includer's directory,
 * trimmed of blank lines around, indented, with levels shifted, and with
 * footnote labels made the file's own, the definitions of those outside
 * the lines kept in `footnotes` for the end of the document.
 */
function prepareFileContents(file: string, lines?: string, ind = 0, minlevel?: number, id?: number, footnotes?: Map<string, string>, includer?: string): string {
  const full = fileContents(file);
  const all = full.split(/(?<=\n)/);
  let first = 0;
  let last = all.length;
  if (lines) {
    const [b, e] = lines.split("-").map((n) => parseInt(n || "0", 10));
    first = b ? Math.min(b - 1, all.length) : 0;
    last = e ? Math.min(Math.max(e - 1, first), all.length) : all.length;
  }
  let text = all.slice(first, last).join("");
  if (includer) {
    const fileDir = e8.fileNameDirectory(e8.expandFileName(file)) ?? "/";
    const includerDir = e8.fileNameDirectory(e8.expandFileName(includer)) ?? "/";
    if (fileDir !== includerDir) {
      // Bracket links to files, with or without file:, and plain file: links.
      text = text.replace(/\[\[(file:)?([^\]]+?)\](\[|\])/g, (m, typed: string | undefined, path: string, after: string) => {
        if (!typed && !/^\.\.?\//.test(path)) return m;
        const [p, search] = path.split("::");
        return `[[file:${rebasedPath(p, fileDir, includerDir)}${search !== undefined ? `::${search}` : ""}]${after}`;
      });
      text = text.replace(/(^|[\s(])file:([^\s<>()[\]]+)/g, (_m, pre: string, path: string) => `${pre}file:${rebasedPath(path, fileDir, includerDir)}`);
    }
  }
  text = text.replace(/^(?:[ \t]*\n)+/, "").replace(/[ \r\t\n]*$/, "");
  if (text !== "") text += "\n";
  if (ind > 0) {
    const pad = " ".repeat(ind);
    const out: string[] = [];
    let heading = false;
    for (const line of text.split(/(?<=\n)/)) {
      if (/^\*+ /.test(line)) heading = true;
      out.push(heading || /^\[fn:[^\]\s]+\]/.test(line) || line === "" ? line : pad + line);
    }
    text = out.join("");
  }
  if (minlevel !== undefined) {
    const levels = allMatches(/^(\*+) /gm, text).map((m) => m[1].length);
    if (levels.length) {
      let offset = minlevel - Math.min(...levels);
      if (offset !== 0 && nonNil(varValue("org-odd-levels-only"))) offset *= 2;
      if (offset !== 0)
        text = text.replace(/^(\*+) /gm, (_m, stars: string) => (offset < 0 ? stars.slice(-offset) : stars + "*".repeat(offset)) + " ");
    }
  }
  if (id !== undefined && footnotes) {
    const seen = new Map<string, string>();
    text = text.replace(/\[fn:([-_\w]+)([\]:])/g, (_m, label: string, after: string) => {
      let neu = seen.get(label);
      if (!neu) {
        neu = `-${id}-${label}`;
        seen.set(label, neu);
        // A definition outside the lines included goes to the end of the document.
        const def = footnoteDefinitionIn(all, label);
        if (def && (def.line < first || def.line >= last)) footnotes.set(neu, normalizeString(def.text));
      }
      return `[fn:${neu}${after}`;
    });
  }
  return normalizeString(text);
}

/** A footnote's definition among a file's lines, as org-footnote-get-definition finds it: its line and its text, up to the next definition, heading or two blank lines. */
function footnoteDefinitionIn(lines: string[], label: string): { line: number; text: string } | undefined {
  const head = `[fn:${label}]`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(head)) continue;
    const body = [lines[i].slice(head.length)];
    let blanks = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\[fn:[^\]\s]+\]/.test(l) || /^\*+ /.test(l)) break;
      blanks = /^[ \t]*\n?$/.test(l) ? blanks + 1 : 0;
      if (blanks >= 2) break;
      body.push(l);
    }
    return { line: i, text: body.join("").trim() };
  }
  return undefined;
}

function fileContents(file: string): string {
  if (/^[a-z][-a-z0-9+.]*:\/\//i.test(file)) err(`Cannot include ${file}: E8 does not fetch files to include from the web`);
  const name = e8.generateNewBufferName(" *Org Export include*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      e8.insertFileContents(file);
      return e8.bufferText();
    });
  } finally {
    e8.call("kill-buffer", name);
  }
}

/**
 * Replace each #+INCLUDE: keyword with what it includes, as
 * org-export-expand-include-keyword: each line's level for :minlevel is
 * taken before any is expanded, and those under commented headings are
 * left, as the commented trees are deleted after.
 */
export function expandIncludeKeyword(included: [string, string | undefined][] = [], dir?: string, footnotes = new Map<string, string>(), includer?: string, expandEnv = false): void {
  const filePrefix = new Map<string, number>();
  const top = included.length === 0;
  const includerFile = includer ?? (typeof e8.variable("e8--export-source-file") === "string" ? (e8.variable("e8--export-source-file") as string) : e8.bufferFileName());
  const found: [number, number][] = [];
  e8.saveRestriction(() => {
    e8.widen();
    const odd = nonNil(varValue("org-odd-levels-only"));
    const todo = allKeywords().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const commented = new RegExp(`^\\*+[ \\t]+(?:(?:${todo || "\\u0000"})[ \\t]+)?(?:\\[#.\\][ \\t]+)?COMMENT(?:[ \\t]|$)`);
    let level = 0;
    let commentedLevel: number | undefined;
    let open: string | undefined;
    for (let l = 0; l < e8.lineCount(); l++) {
      const t = e8.lineText(l);
      const h = /^(\*+)[ \t]/.exec(t);
      if (h && !open) {
        level = h[1].length;
        if (commentedLevel !== undefined && level <= commentedLevel) commentedLevel = undefined;
        if (commentedLevel === undefined && commented.test(t)) commentedLevel = level;
        continue;
      }
      if (open) {
        if (new RegExp(`^[ \\t]*#\\+end_${open}\\b`, "i").test(t)) open = undefined;
        continue;
      }
      const b = /^[ \t]*#\+begin_(src|example|export|comment|verse)\b/i.exec(t);
      if (b) open = b[1].toLowerCase();
      else if (/^[ \t]*#\+INCLUDE:/i.test(t) && commentedLevel === undefined) found.push([l, 1 + (odd ? Math.floor((level + 1) / 2) : level)]);
    }
  });
  // From the last, so the lines of those before stay where they are.
  for (let k = found.length - 1; k >= 0; k--) {
    const [line, induced] = found[k];
    if (line < e8.lineOf(e8.pointMin()) || line > e8.lineOf(e8.pointMax())) continue;
    const text = e8.lineText(line);
    const ind = /^[ \t]*/.exec(text)![0].length;
    const value = text.replace(/^[ \t]*#\+INCLUDE:[ \t]*/i, "").trim();
    const params = parseIncludeValue(value, dir, induced);
    let file = params.file;
    if (file && expandEnv) file = e8.substituteInFileName(file);
    const start = e8.lineStart(line);
    const lineEnd = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : e8.pointMax();
    e8.deleteRegion(start, lineEnd);
    e8.gotoChar(start);
    if (!file) continue;
    if (!/^[a-z][-a-z0-9+.]*:\/\//i.test(file) && !e8.fileReadableP(file)) err(`Cannot include file ${file}`);
    if (included.some(([f, l]) => f === file && l === params.lines)) err(`Recursive file inclusion: ${file}`);
    const indStr = " ".repeat(ind);
    if (params.env === "literal") {
      const block = params.block ?? "example";
      const body = prepareFileContents(file, params.lines).replace(/^([ \t]*)(\*|#\+)/gm, "$1,$2");
      e8.insert(`${indStr}#+BEGIN_${block}${params.args ? ` ${params.args}` : ""}\n${body}${indStr}#+END_${block}\n`);
    } else if (params.block) {
      e8.insert(`${indStr}#+BEGIN_${params.block}\n${prepareFileContents(file, params.lines)}${indStr}#+END_${params.block}\n`);
    } else {
      if (!filePrefix.has(file)) filePrefix.set(file, filePrefix.size);
      const lines = params.location ? inclusionAbsoluteLines(file, params.location, params.onlyContents, params.lines) : params.lines;
      const body = prepareFileContents(file, lines, ind, params.minlevel, filePrefix.get(file), footnotes, includerFile);
      const name = e8.generateNewBufferName(" *Org Export include*");
      e8.getBufferCreate(name);
      let expanded: string;
      try {
        expanded = e8.withCurrentBuffer(name, () => {
          e8.insert(body);
          expandIncludeKeyword([[file!, lines], ...included], e8.fileNameDirectory(file!), footnotes, includerFile, expandEnv);
          return e8.bufferText();
        });
      } finally {
        e8.call("kill-buffer", name);
      }
      e8.insert(expanded);
    }
  }
  if (top && footnotes.size) {
    e8.saveRestriction(() => {
      e8.widen();
      e8.gotoChar(e8.pointMax());
      for (const [k, v] of footnotes) e8.insert(`\n[fn:${k}] ${v}\n`);
    });
  }
}


function inclusionAbsoluteLines(file: string, location: string, onlyContents: boolean, lines?: string): string {
  const text = fileContents(file);
  const all = text.split("\n");
  let start = -1;
  let end = all.length;
  const target = location.replace(/^\*/, "").trim();
  for (let i = 0; i < all.length; i++) {
    const m = /^(\*+)\s+(.*?)\s*$/.exec(all[i]);
    const custom = location.startsWith("#") && /^[ \t]*:CUSTOM_ID:[ \t]+(.*?)[ \t]*$/i.exec(all[i])?.[1] === location.slice(1);
    if ((m && m[2].replace(/\s+:[\w@#%:]+:$/, "").replace(/^(?:\S+ )?/, (w) => (allKeywords().includes(w.trim()) ? "" : w)) === target) || custom) {
      let h = i;
      if (custom) while (h > 0 && !/^\*+ /.test(all[h])) h--;
      const level = /^(\*+)/.exec(all[h])![1].length;
      start = onlyContents ? h + 1 : h;
      for (let j = h + 1; j < all.length; j++) {
        const n = /^(\*+) /.exec(all[j]);
        if (n && n[1].length <= level) {
          end = j;
          break;
        }
      }
      if (onlyContents) {
        if (start < end && /^[ \t]*(SCHEDULED|DEADLINE|CLOSED):/.test(all[start])) start++;
        if (start < end && /^[ \t]*:PROPERTIES:[ \t]*$/i.test(all[start])) {
          while (start < end && !/^[ \t]*:END:[ \t]*$/i.test(all[start])) start++;
          start++;
        }
      }
      break;
    }
  }
  if (start < 0) err(`Unable to resolve link: "${location}" for ${file}::${location}`);
  if (lines) {
    const [b, e] = lines.split("-").map((n) => parseInt(n || "0", 10));
    const s = b ? start + b - 1 : start;
    const t = e ? start + e - 1 : end;
    start = s;
    end = Math.min(t, end);
  }
  return `${start + 1}-${end + 1}`;
}

// --- Tools for backends ------------------------------------------------------

/** An element's ATTR_ keyword read as properties, as org-export-read-attribute. */
export function readAttribute(attribute: string, element: Datum, prop?: string): any {
  const value: string[] | undefined = property(attribute, element);
  const prepare = (s: string): any => {
    if (s === "" || s === "nil") return undefined;
    const m = /^"("+)?"$/.exec(s);
    if (m) return m[1] ?? "";
    return s;
  };
  let attributes: Info | undefined;
  if (value) {
    attributes = {};
    let s = value.join(" ");
    let first = true;
    let key: string | undefined;
    for (;;) {
      const m = /(?:^|[ \t]+)(:[-a-zA-Z0-9_]+)([ \t]+|$)/.exec(s);
      if (!m) break;
      const before = prepare(s.slice(0, m.index));
      if (!first && key !== undefined) attributes[key] = before;
      first = false;
      key = m[1];
      s = s.slice(m.index + m[0].length);
    }
    if (key !== undefined) attributes[key] = prepare(s);
  }
  return prop === undefined ? attributes : attributes?.[prop];
}

/** An element's caption, as a secondary string, or its short one, as org-export-get-caption. */
export function getCaption(element: Datum, short = false): Datum[] | undefined {
  const full: { value: Datum[]; secondary?: Datum[] }[] = property("caption", element) ?? [];
  let caption: Datum[] | undefined;
  for (const line of full) {
    const c = short ? line.secondary : line.value;
    if (!c) continue;
    caption = caption ? [...caption, " ", ...c] : [...c];
  }
  return caption;
}

/** Transcode a datum with another backend's transcoder, as org-export-with-backend. */
export function withBackend(backend: string | Backend, d: Datum, c?: string, info: Info = {}): string | undefined {
  const b = getBackend(backend);
  const type = typeOf(d);
  if (type === "org-data" || type === "raw") err("No foreign transcoder available");
  const all = getAllTranscoders(b);
  const t = all[type!];
  if (typeof t !== "function") err("No foreign transcoder available");
  const newInfo: Info = { ...info, "back-end": b, "translate-alist": all, "exported-data": new Map() };
  const out = type === "plain-text" ? (t as any)(d, newInfo) : (t as Transcoder)(d, c, newInfo);
  info["internal-references"] = newInfo["internal-references"];
  return out ?? undefined;
}

/** The backend an export snippet is for, as org-export-snippet-backend. */
export function snippetBackend(snippet: Datum): string {
  const backend = property("back-end", snippet);
  const alist = varValue("org-export-snippet-translation-alist");
  const found = Array.isArray(alist) ? alist.find((e: any) => Array.isArray(e) && e[0] === backend) : undefined;
  return found ? String(found[1]) : backend;
}

// Footnotes.

/** A footnote reference's definition: its contents, or "" when empty, as org-export-get-footnote-definition. */
export function getFootnoteDefinition(reference: Node, info: Info): Datum[] | string {
  const label = reference.p.label;
  if (!label) return reference.contents;
  let cache: Map<string, any> = info["footnote-definition-cache"];
  if (!cache) {
    cache = new Map();
    map(
      info["parse-tree"],
      ["footnote-definition", "footnote-reference"],
      (f) => {
        if (property("type", f) !== "standard") cache.set(`element:${property("label", f)}`, f);
        return undefined;
      },
      mapOpts(info),
    );
    info["footnote-definition-cache"] = cache;
  }
  if (cache.has(label)) return cache.get(label);
  const hashed: Node | undefined = cache.get(`element:${label}`);
  if (hashed) {
    const value = hashed.contents.length ? hashed.contents : "";
    cache.set(label, value);
    return value;
  }
  return err(`Definition not found for footnote ${label}`);
}

function footnoteReferenceMap(fn: (f: Node) => void, d: Datum | Datum[], info: Info, bodyFirst = false): void {
  const definitions: (Datum[] | string)[] = [];
  const seen: string[] = [];
  const search = (dd: Datum | Datum[] | string, delayp: boolean): void => {
    if (typeof dd === "string") return;
    map(
      dd,
      "footnote-reference",
      (f) => {
        const ref = f as Node;
        fn(ref);
        const label = ref.p.label;
        if (!(label && seen.includes(label))) {
          if (label) seen.push(label);
          if (delayp) definitions.push(getFootnoteDefinition(ref, info));
          else if (ref.p.type !== "inline") search(getFootnoteDefinition(ref, info), false);
        }
        return undefined;
      },
      mapOpts(info, { noRecursion: delayp ? ["footnote-definition", "footnote-reference"] : ["footnote-definition"] }),
    );
  };
  search(d, bodyFirst);
  for (const def of definitions) search(def, false);
}

/** Each footnote's number, label and definition, in the order of their first references, as org-export-collect-footnote-definitions. */
export function collectFootnoteDefinitions(info: Info, d?: Datum | Datum[], bodyFirst = false): [number, string | undefined, Datum[] | string][] {
  let n = 0;
  const labels: string[] = [];
  const out: [number, string | undefined, Datum[] | string][] = [];
  footnoteReferenceMap(
    (f) => {
      const l = f.p.label;
      if (!(l && labels.includes(l))) {
        n++;
        out.push([n, l, getFootnoteDefinition(f, info)]);
      }
      if (l) labels.push(l);
    },
    d ?? info["parse-tree"],
    info,
    bodyFirst,
  );
  return out;
}

/** Whether a reference is the first to its footnote, as org-export-footnote-first-reference-p. */
export function footnoteFirstReferenceP(reference: Node, info: Info, d?: Datum | Datum[], bodyFirst = false): boolean {
  const label = reference.p.label;
  if (!label) return true;
  let result: boolean | undefined;
  try {
    footnoteReferenceMap(
      (f) => {
        if (f.p.label === label) {
          result = f === reference;
          throw STOP;
        }
      },
      d ?? info["parse-tree"],
      info,
      bodyFirst,
    );
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return result ?? false;
}

const STOP = Symbol("stop");

/** A footnote's number, as org-export-get-footnote-number. */
export function getFootnoteNumber(footnote: Node, info: Info, d?: Datum | Datum[], bodyFirst = false): number | undefined {
  let count = 0;
  const seen: string[] = [];
  const label = footnote.p.label;
  let result: number | undefined;
  try {
    footnoteReferenceMap(
      (f) => {
        const l = f.p.label;
        if (!l && !label && footnote === f) {
          result = count + 1;
          throw STOP;
        } else if (label && l && label === l) {
          result = count + 1;
          throw STOP;
        } else if (!l) count++;
        else if (!seen.includes(l)) {
          seen.push(l);
          count++;
        }
      },
      d ?? info["parse-tree"],
      info,
      bodyFirst,
    );
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return result;
}

// Headlines.

export function getRelativeLevel(headline: Node, info: Info): number {
  return headline.p.level + (info["headline-offset"] ?? 0);
}

/** How far below the levels exported as headings a heading is, or undefined, as org-export-low-level-p. */
export function lowLevelP(headline: Node, info: Info): number | undefined {
  const limit = info["headline-levels"];
  if (!wholenump(limit)) return undefined;
  const level = getRelativeLevel(headline, info);
  return level > limit ? level - limit : undefined;
}

export function getHeadlineNumber(headline: Node, info: Info): number[] | undefined {
  return numberedHeadlineP(headline, info) ? (info["headline-numbering"] as Map<Node, number[]>).get(headline) : undefined;
}

export function numberedHeadlineP(headline: Node, info: Info): boolean {
  const unnumbered = getNodeProperty("UNNUMBERED", headline, true);
  if (unnumbered !== undefined && unnumbered !== "nil") return false;
  const sec = info["section-numbers"];
  const level = getRelativeLevel(headline, info);
  return wholenump(sec) ? level <= sec : nonNil(sec);
}

export function numberToRoman(n: number): string {
  const roman: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  if (n <= 0) return String(n);
  let res = "";
  for (const [v, s] of roman) while (n >= v) {
    n -= v;
    res += s;
  }
  return res;
}

/** A heading's tags, without those in `tags`, inherited ones too with `inherited`, as org-export-get-tags. */
export function getTags(element: Node, info: Info, tags: string[] = [], inherited = false): string[] {
  let list: string[];
  if (!inherited) list = element.p.tags ?? [];
  else {
    const current: string[] = [...(element.p.tags ?? [])];
    for (const parent of lineage(element)) {
      if (parent.type !== "headline" && parent.type !== "inlinetask") continue;
      for (const tag of parent.p.tags ?? []) if (!current.includes(tag)) current.unshift(tag);
    }
    list = [];
    for (const t of [...(info["filetags"] ?? []), ...current]) if (!list.includes(t)) list.push(t);
  }
  return list.filter((t) => !tags.includes(t));
}

/** A node property of a datum's heading, inherited from those above with `inherited`, as org-export-get-node-property. */
export function getNodeProperty(name: string, datum: Datum, inherited = false): any {
  if (!inherited) return property(name, datum);
  for (const d of lineage(datum, undefined, true)) {
    if (typeOf(d) !== "headline" && typeOf(d) !== "inlinetask" && typeOf(d) !== "org-data") continue;
    const v = property(name, d);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function getCategory(blob: Datum, info: Info): string {
  return (
    getNodeProperty("CATEGORY", blob, true) ??
    mapFirst(info["parse-tree"], "keyword", (k) => (property("key", k) === "CATEGORY" ? (property("value", k) as string) : undefined), mapOpts(info)) ??
    (info["input-file"] ? e8.fileNameNondirectory(info["input-file"]).replace(/\.[^.]*$/, "") : undefined) ??
    "???"
  );
}

/** A heading's ALT_TITLE parsed, or its title, as org-export-get-alt-title. */
export function getAltTitle(headline: Node, _info?: Info): Datum[] {
  const alt = headline.p.ALT_TITLE;
  return alt ? parseSecondaryString(alt, restriction("headline"), headline) : headline.p.title;
}

export function firstSiblingP(blob: Datum, info: Info, parent?: Node): boolean {
  const previous = getPreviousElement(blob, info, parent);
  return previous === undefined || typeOf(previous) === "section";
}

export function lastSiblingP(datum: Datum, info: Info, parent?: Node): boolean {
  const next = getNextElement(datum, info, parent);
  return next === undefined || (typeOf(datum) === "headline" && property("level", datum) > property("level", next));
}

/** The document's date, formatted when it is a timestamp alone and a format is given, as org-export-get-date. */
export function getDate(info: Info, fmt?: string): any {
  const date = info["date"];
  const format = fmt ?? (nonNil(varValue("org-export-date-timestamp-format")) ? varValue("org-export-date-timestamp-format") : undefined);
  if (!nonNil(date)) return undefined;
  if (format && Array.isArray(date) && date.length === 1 && typeOf(date[0]) === "timestamp") return formatTimestamp(date[0] as Node, format);
  return date;
}

/** A timestamp formatted with format-time-string, as org-format-timestamp: its start, or its end with `end`. */
export function formatTimestamp(ts: Node, format: string, end = false): string {
  const p = ts.p;
  const k = end ? "end" : "start";
  const time = e8.encodeTime([0, p[`minute-${k}`] ?? 0, p[`hour-${k}`] ?? 0, p[`day-${k}`], p[`month-${k}`], p[`year-${k}`]]);
  return e8.formatTimeString(format, time);
}

// Links.

/** What a link type's :export function makes of a link, as org-export-custom-protocol-maybe. */
export function customProtocolMaybe(link: Node, desc: string | undefined, backend: string | undefined, info?: Info): string | undefined {
  const type = link.p.type;
  if (["coderef", "custom-id", "fuzzy", "radio", undefined].includes(type) || !backend) return undefined;
  const protocol = linkTypeEntries().find(([t]) => t === type)?.[1].export;
  if (!protocol) return undefined;
  const out = protocol(link.p.path, desc, backend, info ?? {});
  return typeof out === "string" ? out : undefined;
}

export function getCoderefFormat(path: string, desc?: string): string {
  if (!desc) return "%s";
  const target = `(${path})`;
  const i = desc.indexOf(target);
  return i >= 0 ? desc.slice(0, i) + "%s" + desc.slice(i + target.length) : desc;
}

const DEFAULT_INLINE_IMAGE_RULE: [string, RegExp][] = [["file", /\.(png|jpeg|jpg|gif|tiff|tif|xbm|xpm|pbm|pgm|ppm)$/i]];

/** Whether a link with no description is an inline image by `rules`, as org-export-inline-image-p. */
export function inlineImageP(link: Node, rules?: [string, RegExp | string][]): boolean {
  if (link.contents.length) return false;
  return (rules ?? DEFAULT_INLINE_IMAGE_RULE).some(([type, re]) => link.p.type === type && (typeof re === "string" ? e8.stringMatch(re, link.p.path, { caseFold: true }) !== undefined : re.test(link.p.path)));
}

/** Links whose description is a link to an image, the image made the description, as org-export-insert-image-links. */
export function insertImageLinks(d: Datum, info: Info, rules?: [string, RegExp | string][]): Datum {
  map(
    d,
    "link",
    (l) => {
      const link = l as Node;
      const c = interpretData(link.contents);
      const m = /^(?:([a-z][-a-z0-9+.]*):([^\s]*)|<([a-z][-a-z0-9+.]*):([^>\n]*)>)$/i.exec(c);
      if (!m) return undefined;
      const type = m[1] ?? m[3];
      const path = m[2] ?? m[4];
      if ((rules ?? DEFAULT_INLINE_IMAGE_RULE).some(([t, re]) => t === type && (typeof re === "string" ? e8.stringMatch(re, path, { caseFold: true }) !== undefined : re.test(path)))) {
        const parsed = linkParser(c);
        if (parsed) setContents(link, parsed);
      }
      return undefined;
    },
    mapOpts(info, { withAffiliated: true }),
  );
  return d;
}

/** The line a code reference names, or the label itself, as org-export-resolve-coderef. */
export function resolveCoderef(ref: string, info: Info): string | number {
  const found = mapFirst(
    info["parse-tree"],
    ["example-block", "src-block"],
    (el) => {
      const value = String(property("value", el)).trim();
      const fmt = property("label-fmt", el) ?? (varValue("org-coderef-label-format") || "(ref:%s)");
      const re = coderefRegexp(fmt, ref);
      const lines = value.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (re.test(lines[i])) return nonNil(property("use-labels", el)) ? ref : (getLoc(el as Node, info) ?? 0) + i + 1;
      }
      return undefined;
    },
    mapOpts(info),
  );
  if (found === undefined) brokenLink(ref);
  return found;
}

/** The regexp matching a code reference label, as org-src-coderef-regexp: group 1 the label with the space before it, group 3 its name. */
export function coderefRegexp(fmt: string, label?: string): RegExp {
  const pattern = escapeRegExp(fmt).replace("%s", label ? `(${escapeRegExp(label)})` : "([-a-zA-Z0-9_][-a-zA-Z0-9_ ]*)");
  return new RegExp(`([ \\t]*(${pattern})[ \\t]*)$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The cells a datum can be found by, as org-export-search-cells. */
export function searchCells(datum: Datum): string[] {
  switch (typeOf(datum)) {
    case "headline": {
      const title = String(property("raw-value", datum))
        .replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, " ")
        .split(/[ \f\t\n\r\v]+/)
        .filter(Boolean)
        .map((w) => w.toUpperCase());
      const out = [cell("headline", title), cell("other", title)];
      const customId = property("custom-id", datum);
      if (customId) out.push(cell("custom-id", customId));
      return out;
    }
    case "target":
      return [cell("target", String(property("value", datum)).split(/[ \f\t\n\r\v]+/).filter(Boolean).map((w) => w.toUpperCase()))];
  }
  const name = property("name", datum) ?? property("results", datum)?.value;
  return name ? [cell("other", String(name).split(/[ \f\t\n\r\v]+/).filter(Boolean))] : [];
}

const cell = (kind: string, value: string | string[]) => JSON.stringify([kind, value]);

/** The cells a link's search string looks for, as org-export-string-to-search-cell. */
export function stringToSearchCell(s: string): string[] {
  if (s.startsWith("*")) return [cell("headline", s.slice(1).split(/[ \f\t\n\r\v]+/).filter(Boolean).map((w) => w.toUpperCase()))];
  if (s.startsWith("#")) return [cell("custom-id", s.slice(1))];
  const search = s.split(/[ \f\t\n\r\v]+/).filter(Boolean);
  const out = [cell("target", search), cell("other", search), cell("target", search.map((w) => w.toUpperCase())), cell("other", search.map((w) => w.toUpperCase()))];
  return [...new Set(out)];
}

export function matchSearchCellP(datum: Datum, cells: string[]): boolean {
  const targets = searchCells(datum);
  return targets.some((t) => cells.includes(t));
}

/** The element or object a fuzzy link points to, as org-export-resolve-fuzzy-link. */
export function resolveFuzzyLink(link: Node, info: Info, ...pseudoTypes: string[]): Datum {
  const wanted = stringToSearchCell(link.p.path);
  let table: Map<string, Datum[]> = info["resolve-fuzzy-link-cache"];
  if (!table) {
    table = new Map();
    map(info["parse-tree"], [...pseudoTypes, "target", ...ALL_ELEMENTS], (d) => {
      for (const c of searchCells(d)) {
        const list = table.get(c);
        if (list) list.unshift(d);
        else table.set(c, [d]);
      }
      return undefined;
    });
    info["resolve-fuzzy-link-cache"] = table;
  }
  const key = "result:" + wanted.join("\u0000");
  const cached = table.get(key);
  if (cached) return cached[0];
  const matches = wanted.flatMap((c) => table.get(c) ?? []);
  if (matches.length === 0) brokenLink(link.p.path);
  const result = matches.find((d) => typeOf(d) !== "headline") ?? matches[0];
  table.set(key, [result]);
  return result;
}

/** The heading an id or custom-id link points to, or the file it is in, as org-export-resolve-id-link. */
export function resolveIdLink(link: Node, info: Info): Datum | string {
  const id = link.p.path;
  let local: Map<string, Node> = info["id-local-cache"];
  if (!local) {
    local = new Map();
    map(
      info["parse-tree"],
      "headline",
      (h) => {
        const ID = property("ID", h);
        const customId = property("CUSTOM_ID", h);
        if (ID && !local.has(ID)) local.set(ID, h as Node);
        if (customId && !local.has(customId)) local.set(customId, h as Node);
        return undefined;
      },
      mapOpts(info),
    );
    info["id-local-cache"] = local;
  }
  const found = local.get(id);
  if (found) return found;
  const elsewhere = (info["id-alist"] as [string, string][]).find(([k]) => k === id);
  if (elsewhere) return elsewhere[1];
  return brokenLink(id);
}

/** The radio target a radio link points to, as org-export-resolve-radio-link. */
export function resolveRadioLink(link: Node, info: Info): Node | undefined {
  const clean = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const path = clean(link.p.path);
  return mapFirst(info["parse-tree"], "radio-target", (r) => (clean(String(property("value", r))) === path ? (r as Node) : undefined), mapOpts(info));
}

/** What an internal link points to, as org-export-resolve-link: a link, or a link written as a string. */
export function resolveLink(given: Node | string, info: Info): Datum | string {
  let link: Node;
  if (typeof given === "string") {
    const parsed = linkParser(`[[${given.replace(/([\\\]])/g, "\\$1")}]]`);
    if (!parsed) return brokenLink(given);
    link = parsed;
  } else link = given;
  switch (link.p.type) {
    case "custom-id":
    case "id":
      return resolveIdLink(link, info);
    case "fuzzy":
      return resolveFuzzyLink(link, info);
  }
  return brokenLink(link.p.path);
}

/** A file name as a URI, as org-export-file-uri. */
export function fileUri(filename: string): string {
  if (filename.startsWith("//")) return "file:" + filename;
  if (!filename.startsWith("/") && !filename.startsWith("~")) return filename;
  const full = e8.expandFileName(filename);
  return (full.startsWith("/") ? "file://" : "file:///") + full;
}

/** A timestamp as text, with the blanks after it, as org-timestamp-translate writes it without custom times. */
export function timestampTranslate(ts: Node): string {
  return interpretData(ts);
}

// References.

/** A new reference among those used, as org-export-new-reference: random, or the next free one for the oracle. */
export function newReference(references: Map<any, any>): number {
  const used = new Set<number>();
  for (const v of references.values()) if (typeof v === "number") used.add(v);
  if (nonNil(varValue("e8--export-sequential-references"))) {
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }
  let n = Math.floor(Math.random() * 0x10000000);
  while (used.has(n)) n = Math.floor(Math.random() * 0x10000000);
  return n;
}
defvar("e8--export-sequential-references", false, "Whether an export numbers its references 1, 2, 3 rather than at random, as E8's oracle compares them with Emacs's.");

export function formatReference(reference: number): string {
  return "org" + reference.toString(16).padStart(7, "0");
}

/**
 * A reference for a datum, unique in the document, as
 * org-export-get-reference. The cache holds, as Org's
 * :internal-references, each search cell with its number and each
 * reference string with its datum.
 */
export function getReference(datum: Datum, info: Info): string {
  let cache: Map<any, any> = info["internal-references"];
  if (!cache) {
    cache = new Map();
    info["internal-references"] = cache;
  }
  let refs: Map<Datum, string> = info["reference-of"];
  if (!refs || info["reference-cache"] !== cache) {
    refs = new Map();
    for (const [k, v] of cache) if (typeof k === "string" && k.startsWith("org") && !refs.has(v)) refs.set(v, k);
    info["reference-of"] = refs;
    info["reference-cache"] = cache;
  }
  const known = refs.get(datum);
  if (known !== undefined) return known;
  const cells = searchCells(datum);
  const crossrefs: [string, number][] = info["crossrefs"] ?? [];
  let neu: number | undefined;
  for (const c of cells) {
    const stored = crossrefs.find(([k]) => k === c)?.[1];
    if (stored !== undefined && !cache.has(formatReference(stored))) {
      neu = stored;
      break;
    }
  }
  if (neu === undefined) neu = newReference(cache);
  const ref = formatReference(neu);
  for (const c of cells) cache.set("cell:" + c, neu);
  cache.set(ref, datum);
  refs.set(datum, ref);
  return ref;
}

/** A datum's ordinal among its kind, as org-export-get-ordinal. */
export function getOrdinal(element: Datum, info: Info, types?: string[], predicate?: (el: Datum, info: Info) => boolean): any {
  if (typeOf(element) === "target") element = ancestor(element, ["footnote-definition", "footnote-reference", "headline", "item", "table"]) as Datum;
  switch (typeOf(element)) {
    case "headline":
      return getHeadlineNumber(element as Node, info);
    case "item":
      return itemNumber(element as Node);
    case "footnote-definition":
    case "footnote-reference":
      return getFootnoteNumber(element as Node, info);
  }
  let counter = 0;
  const kinds = types ? [typeOf(element)!, ...types] : [typeOf(element)!];
  return mapFirst(
    info["parse-tree"],
    kinds,
    (el) => {
      if (el === element && (!predicate || predicate(el, info))) return counter + 1;
      if (!predicate || predicate(el, info)) counter++;
      return undefined;
    },
    mapOpts(info),
  );
}

/** An item's number and those of the items it is under, as org-list-get-item-number: [1, 2] for the second item under the first. */
export function itemNumber(item: Node): number[] {
  const out: number[] = [];
  let at: Node | undefined = item;
  while (at && at.type === "item") {
    const list: Node = at.parent!;
    let n = 0;
    for (const sibling of list.contents) {
      if (typeOf(sibling) !== "item") continue;
      const counter = property("counter", sibling);
      n = typeof counter === "number" ? counter : n + 1;
      if (sibling === at) break;
    }
    out.unshift(n);
    at = ancestor(list, ["item"]) as Node | undefined;
  }
  return out;
}

/** Raw text, which an export puts out as it is, as org-export-raw-string. */
export function rawString(s: string): Node {
  return create("raw", {}, s);
}

// Source blocks.

/** The number the first line of a block shows, as org-export-get-loc, when it numbers its lines. */
export function getLoc(element: Node, info: Info): number | undefined {
  const nl = element.p["number-lines"];
  if (!nl) return undefined;
  if (nl[0] === "new") return nl[1];
  let loc = 0;
  return mapFirst(
    info["parse-tree"],
    ["src-block", "example-block"],
    (el) => {
      if (el === element) return loc + nl[1];
      const linum = property("number-lines", el);
      if (linum) {
        const lines = countLines(String(property("value", el)));
        if (linum[0] === "new") loc = linum[1] + lines;
        else loc += linum[1] + lines;
      }
      return undefined;
    },
    mapOpts(info),
  );
}

function countLines(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

/** Whether a block keeps its indentation, as org-src-preserve-indentation-p. */
export function srcPreserveIndentationP(element: Node): boolean {
  return nonNil(varValue("org-src-preserve-indentation")) || nonNil(element.p["preserve-indent"]);
}

/** Text with its common indentation removed, as org-remove-indentation. */
export function removeIndentation(code: string): string {
  const lines = code.split("\n");
  let min = Infinity;
  for (const l of lines) {
    if (!/\S/.test(l)) continue;
    let w = 0;
    for (const ch of l) {
      if (ch === " ") w++;
      else if (ch === "\t") w = (Math.floor(w / 8) + 1) * 8;
      else break;
    }
    min = Math.min(min, w);
  }
  if (min === Infinity || min === 0) return code;
  return lines
    .map((l) => {
      let w = 0;
      let i = 0;
      while (i < l.length && w < min) {
        if (l[i] === " ") w++;
        else if (l[i] === "\t") w = (Math.floor(w / 8) + 1) * 8;
        else break;
        i++;
      }
      return (w > min ? " ".repeat(w - min) : "") + l.slice(i);
    })
    .join("\n");
}

/** A block's code without its labels, and each label's line, as org-export-unravel-code. */
export function unravelCode(element: Node): [string, [number, string][]] {
  const value: string = element.p.value ?? "";
  const code = (srcPreserveIndentationP(element) ? value : removeIndentation(value)).replace(/\n$/, "");
  const fmt = element.p["label-fmt"] ?? (varValue("org-coderef-label-format") || "(ref:%s)");
  const re = coderefRegexp(fmt);
  const refs: [number, string][] = [];
  let line = 0;
  const out = code.split("\n").map((loc) => {
    line++;
    const m = re.exec(loc);
    if (!m) return loc;
    const name = /\(([^)]*)\)/.exec(m[2]);
    refs.unshift([line, m[3] ?? name?.[1] ?? ""]);
    return loc.slice(0, m.index) + loc.slice(m.index + m[1].length);
  });
  return [out.join("\n"), refs];
}

/** Each line of code through a function, as org-export-format-code. */
export function formatCode(code: string, fn: (loc: string, lineNum: number | undefined, ref: string | undefined) => string, numLines?: number, refs: [number, string][] = []): string {
  let line = 0;
  return (
    code
      .split("\n")
      .map((loc) => {
        line++;
        const ref = refs.find(([n]) => n === line)?.[1];
        return fn(loc, numLines !== undefined ? numLines + line : undefined, ref);
      })
      .join("\n") + "\n"
  );
}

/** A block's code with its line numbers and labels as Org shows them, as org-export-format-code-default. */
export function formatCodeDefault(element: Node, info: Info): string {
  const [code, allRefs] = unravelCode(element);
  const lines = code.split("\n");
  const refs = nonNil(element.p["retain-labels"]) ? allRefs : [];
  const numStart = getLoc(element, info);
  const numWidth = numStart !== undefined ? String(lines.length + numStart).length : 0;
  const numFmt = (n: number) => String(n).padStart(numWidth) + "  ";
  const maxWidth = Math.max(...lines.map((l) => l.length)) + (numStart === undefined ? 0 : numFmt(numStart).length);
  return formatCode(
    code,
    (loc, lineNum, ref) => {
      const numberStr = numStart !== undefined && lineNum !== undefined ? numFmt(lineNum) : "";
      return numberStr + loc + (ref ? " ".repeat(6 + maxWidth - (loc.length + numberStr.length)) + `(${ref})` : "");
    },
    numStart,
    refs,
  );
}

// Tables.

const SPECIAL_MARKS = ["/", "#", "!", "$", "*", "_", "^"];

function cellValue(c: Datum | undefined): Datum[] {
  return contents(c);
}

const isOnly = (v: Datum[], s: string) => v.length === 1 && v[0] === s;

/** Whether a table's first column marks special rows, as org-export-table-has-special-column-p. */
export function tableHasSpecialColumnP(table: Node | undefined): boolean {
  if (!table) return false;
  let special: "empty" | "special" = "empty";
  for (const row of table.contents) {
    if (property("type", row) !== "standard") continue;
    const value = cellValue(contents(row)[0]);
    if (SPECIAL_MARKS.some((m) => isOnly(value, m))) special = "special";
    else if (value.length === 0) continue;
    else return false;
  }
  return special === "special";
}

export function tableHasHeaderP(table: Node, info: Info): boolean {
  let cache: Map<Node, boolean> = info["table-header-cache"];
  if (!cache) {
    cache = new Map();
    info["table-header-cache"] = cache;
  }
  const cached = cache.get(table);
  if (cached !== undefined) return cached;
  let rowgroup = 1;
  let rowFlag = false;
  const result = nonNil(
    mapFirst(
      table,
      "table-row",
      (row) => {
        if (rowgroup > 1) return true;
        if (rowFlag && property("type", row) === "rule") {
          rowgroup++;
          rowFlag = false;
        } else if (!rowFlag && property("type", row) === "standard") rowFlag = true;
        return undefined;
      },
      mapOpts(info),
    ),
  );
  cache.set(table, result);
  return result;
}

export function tableRowIsSpecialP(row: Node, _info?: Info): boolean {
  if (row.p.type !== "standard") return false;
  const first = cellValue(row.contents[0]);
  if (isOnly(first, "/")) return true;
  if (row.parent && tableHasSpecialColumnP(row.parent) && ["^", "_", "$", "!"].some((m) => isOnly(first, m))) return true;
  let special: "empty" | "cookie" = "empty";
  for (const c of row.contents) {
    const value = cellValue(c);
    if (value.length === 0) continue;
    if (value.length === 1 && typeof value[0] === "string" && /^<[lrc]?([0-9]+)?>$/.test(value[0])) special = "cookie";
    else return false;
  }
  return special === "cookie";
}

export function tableRowGroup(row: Node, info: Info): number | undefined {
  if (row.p.type !== "standard") return undefined;
  let cache: Map<Node, number> = info["table-row-group-cache"];
  if (!cache) {
    cache = new Map();
    info["table-row-group-cache"] = cache;
  }
  if (!cache.has(row)) {
    let group = 0;
    let rowFlag = false;
    map(
      row.parent,
      "table-row",
      (r) => {
        if (property("type", r) === "rule") rowFlag = false;
        else {
          if (!rowFlag) {
            group++;
            rowFlag = true;
          }
          cache.set(r as Node, group);
        }
        return undefined;
      },
      mapOpts(info),
    );
  }
  return cache.get(row);
}

function columnOf(cell: Node): number {
  return cell.parent!.contents.indexOf(cell);
}

/** A column's width cookie, as org-export-table-cell-width. */
export function tableCellWidth(cell: Node, info: Info): number | undefined {
  const row = cell.parent!;
  const table = row.parent!;
  const column = columnOf(cell);
  let cache: Map<Node, (number | undefined | "empty")[]> = info["table-cell-width-cache"];
  if (!cache) {
    cache = new Map();
    info["table-cell-width-cache"] = cache;
  }
  let widths = cache.get(table);
  if (!widths) {
    widths = [];
    cache.set(table, widths);
  }
  if (column in widths && widths[column] !== "empty") return widths[column] as number | undefined;
  for (const r of table.contents) {
    if (!tableRowIsSpecialP(r as Node, info)) continue;
    const value = cellValue(contents(r)[column]);
    if (value.length === 1 && typeof value[0] === "string") {
      const m = /^<[lrc]?([0-9]+)>$/.exec(value[0]);
      if (m) return (widths[column] = parseInt(m[1], 10));
    }
  }
  widths[column] = undefined;
  return undefined;
}

/** A column's alignment, from its cookie or the share of numbers in it, as org-export-table-cell-alignment. */
export function tableCellAlignment(cell: Node, info: Info): "left" | "right" | "center" {
  const row = cell.parent!;
  const table = row.parent!;
  const column = columnOf(cell);
  let cache: Map<Node, string[]> = info["table-cell-alignment-cache"];
  if (!cache) {
    cache = new Map();
    info["table-cell-alignment-cache"] = cache;
  }
  let aligns = cache.get(table);
  if (!aligns) {
    aligns = [];
    cache.set(table, aligns);
  }
  if (aligns[column]) return aligns[column] as any;
  let numberCells = 0;
  let totalCells = 0;
  let cookieAlign: string | undefined;
  let previousNumber = false;
  const numberRe = String(e8.variable("org-table-number-regexp") ?? "");
  for (const r of table.contents) {
    if (tableRowIsSpecialP(r as Node, info)) {
      const value = cellValue(contents(r)[column]);
      if (value.length === 1 && typeof value[0] === "string") {
        const m = /^<([lrc])?([0-9]+)?>$/.exec(value[0]);
        if (m && m[1]) cookieAlign = m[1];
      }
    } else if (property("type", r) === "rule") {
      // Rules have no cells.
    } else if (!cookieAlign) {
      const value = data(cellValue(contents(r)[column]), info);
      totalCells++;
      if (!(e8.stringMatch(numberRe, value) !== undefined || (value === "" && previousNumber))) previousNumber = false;
      else {
        previousNumber = true;
        numberCells++;
      }
    }
  }
  const fractionValue = e8.variable("org-table-number-fraction");
  const fraction = typeof fractionValue === "number" ? fractionValue : 0.5;
  const align =
    cookieAlign === "l" ? "left" : cookieAlign === "r" ? "right" : cookieAlign === "c" ? "center" : numberCells / totalCells >= fraction ? "right" : "left";
  aligns[column] = align;
  return align;
}

e8.defineVariable({
  name: "org-table-number-regexp",
  value: "^\\([<>]?[-+^.0-9]*[0-9][-+^.0-9eEdDx()%:]*\\|[<>]?[-+]?0[xX][[:xdigit:].]+\\|[<>]?[-+]?[0-9]+#[0-9a-zA-Z.]+\\|nan\\|[-+u]?inf\\)$",
  doc: "The Emacs regexp a table field that is a number matches, as export counts them to align a column.",
});

/** The borders around a cell, as org-export-table-cell-borders: top, above, bottom, below, left and right. */
export function tableCellBorders(cell: Node, info: Info): string[] {
  const row = cell.parent!;
  const table = ancestor(cell, ["table"]) as Node;
  const borders: string[] = [];
  const rows = table.contents as Node[];
  const at = rows.indexOf(row);
  {
    let ruleFlag = false;
    let exited = false;
    for (let i = at - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.p.type === "rule") ruleFlag = true;
      else if (!tableRowIsSpecialP(r, info)) {
        if (ruleFlag) borders.unshift("above");
        exited = true;
        break;
      }
    }
    if (!exited) {
      if (ruleFlag) borders.unshift("above");
      borders.unshift("top");
    }
  }
  {
    let ruleFlag = false;
    let exited = false;
    for (let i = at + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.p.type === "rule") ruleFlag = true;
      else if (!tableRowIsSpecialP(r, info)) {
        if (ruleFlag) borders.unshift("below");
        exited = true;
        break;
      }
    }
    if (!exited) {
      if (ruleFlag) borders.unshift("below");
      borders.unshift("bottom");
    }
  }
  const column = columnOf(cell);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.p.type === "rule") continue;
    if (!isOnly(cellValue(r.contents[0]), "/")) continue;
    const groups = r.contents.map((c) => {
      const v = cellValue(c);
      if (v.length === 0) return undefined;
      return v.length === 1 && ["<", "<>", ">"].includes(v[0] as string) ? (v[0] as string) : null;
    });
    if ((column !== 0 && [">", "<>"].includes(groups[column - 1] as string)) || ["<", "<>"].includes(groups[column] as string)) borders.unshift("left");
    if ((column + 1 !== groups.length && ["<", "<>"].includes(groups[column + 1] as string)) || [">", "<>"].includes(groups[column] as string)) borders.unshift("right");
    break;
  }
  return borders;
}

export function tableCellStartsColgroupP(cell: Node, info: Info): boolean {
  return mapFirst(cell.parent, "table-cell", (c) => c, mapOpts(info)) === cell || tableCellBorders(cell, info).includes("left");
}

export function tableCellEndsColgroupP(cell: Node, info: Info): boolean {
  const cells = cell.parent!.contents;
  return cells[cells.length - 1] === cell || tableCellBorders(cell, info).includes("right");
}

export function tableRowStartsRowgroupP(row: Node, info: Info): boolean {
  if (row.p.type === "rule" || tableRowIsSpecialP(row, info)) return false;
  const borders = tableCellBorders(row.contents[0] as Node, info);
  return borders.includes("top") || borders.includes("above");
}

export function tableRowEndsRowgroupP(row: Node, info: Info): boolean {
  if (row.p.type === "rule" || tableRowIsSpecialP(row, info)) return false;
  const borders = tableCellBorders(row.contents[0] as Node, info);
  return borders.includes("bottom") || borders.includes("below");
}

export function tableRowInHeaderP(row: Node, info: Info): boolean {
  return tableHasHeaderP(ancestor(row, ["table"]) as Node, info) && tableRowGroup(row, info) === 1;
}

export function tableRowStartsHeaderP(row: Node, info: Info): boolean {
  return tableRowInHeaderP(row, info) && tableRowStartsRowgroupP(row, info);
}

export function tableRowEndsHeaderP(row: Node, info: Info): boolean {
  return tableRowInHeaderP(row, info) && tableRowEndsRowgroupP(row, info);
}

export function tableRowNumber(row: Node, info: Info): number | undefined {
  if (row.p.type !== "standard") return undefined;
  let cache: Map<Node, number> = info["table-row-number-cache"];
  if (!cache) {
    cache = new Map();
    info["table-row-number-cache"] = cache;
  }
  if (!cache.has(row)) {
    let n = -1;
    map(
      ancestor(row, ["table"]),
      "table-row",
      (r) => {
        if (property("type", r) === "standard") cache.set(r as Node, ++n);
        return undefined;
      },
      mapOpts(info),
    );
  }
  return cache.get(row);
}

/** How many rows and columns a table has, as org-export-table-dimensions. */
export function tableDimensions(table: Node, info: Info): [number, number] {
  let first: Node | undefined;
  let rows = 0;
  map(
    table,
    "table-row",
    (r) => {
      if (property("type", r) === "standard") {
        rows++;
        first ??= r as Node;
      }
      return undefined;
    },
    mapOpts(info),
  );
  const columns = first ? map(first, "table-cell", () => true, mapOpts(info)).length : 0;
  return [rows, columns];
}

export function tableCellAddress(cell: Node, info: Info): [number, number] | undefined {
  const row = cell.parent!;
  const n = tableRowNumber(row, info);
  if (n === undefined) return undefined;
  let col = 0;
  return [n, mapFirst(row, "table-cell", (c) => (c === cell ? col : (col++, undefined)), mapOpts(info))!];
}

export function getTableCellAt(address: [number, number], table: Node, info: Info): Node | undefined {
  let rowCount = 0;
  const row = mapFirst(
    table,
    "table-row",
    (r) => {
      if (property("type", r) === "rule") return undefined;
      if (rowCount === address[0]) return r as Node;
      rowCount++;
      return undefined;
    },
    mapOpts(info),
  );
  let colCount = 0;
  return mapFirst(row, "table-cell", (c) => (colCount === address[1] ? (c as Node) : (colCount++, undefined)), mapOpts(info));
}

// Collecting.

/** The headings of the table of contents, down to `n` levels below `scope`, as org-export-collect-headlines. */
export function collectHeadlines(info: Info, n?: number, scope?: Datum): Node[] {
  const sc: Node =
    !scope ? info["parse-tree"] : typeOf(scope) === "headline" ? (scope as Node) : ((ancestor(scope, ["headline"]) as Node) ?? info["parse-tree"]);
  const limit = info["headline-levels"];
  const depth = !wholenump(n) ? limit : Math.min(sc.type === "org-data" ? n : getRelativeLevel(sc, info) + n, limit);
  return map(
    sc.contents,
    "headline",
    (h) => {
      const headline = h as Node;
      return !nonNil(headline.p["footnote-section-p"]) && getNodeProperty("UNNUMBERED", headline, true) !== "notoc" && depth >= getRelativeLevel(headline, info) ? headline : undefined;
    },
    mapOpts(info),
  );
}

export function collectElements(type: string, info: Info, predicate?: (el: Node) => boolean): Node[] {
  return map(info["parse-tree"], type, (el) => (nonNil(property("caption", el)) && (!predicate || predicate(el as Node)) ? (el as Node) : undefined), mapOpts(info));
}

export const collectTables = (info: Info) => collectElements("table", info);
export const collectFigures = (info: Info, predicate: (el: Node) => boolean) => collectElements("paragraph", info, predicate);
export const collectListings = (info: Info) => collectElements("src-block", info);

export function excludedFromTocP(headline: Node, info: Info): boolean {
  return nonNil(headline.p["footnote-section-p"]) || lowLevelP(headline, info) !== undefined || getNodeProperty("UNNUMBERED", headline, true) === "notoc";
}

/** A backend for a heading in a table of contents: no footnotes, targets or links' destinations, as org-export-toc-entry-backend. */
export function tocEntryBackend(parent: string | Backend, transcoders: Backend["transcoders"] = {}): Backend {
  return createBackend({
    parent,
    transcoders: {
      ...transcoders,
      "footnote-reference": () => undefined,
      link: (l: Node, c: string | undefined, i: Info) => c || data(l.p["raw-link"], i),
      "radio-target": (_r: Node, c: string | undefined) => c,
      target: () => undefined,
    } as Backend["transcoders"],
  });
}

// Smart quotes.

const QUOTES: { [lang: string]: { [status: string]: { [encoding: string]: string } } } = DICTIONARY.quotes;

/** Each quote's status in a container's plain text, as org-export--smart-quote-status computes them. */
function smartQuoteStatus(place: TextPlace, info: Info): string[] | undefined {
  const list = place.list;
  if (!list) return undefined;
  let cache: Map<Datum[], Map<number | string, string[]>> = info["smart-quote-cache"];
  if (!cache) {
    cache = new Map();
    info["smart-quote-cache"] = cache;
  }
  let found = cache.get(list);
  if (!found) {
    found = new Map();
    let level1Open = false;
    const full: [Datum[], number, string[]][] = [];
    const walk = (l: Datum[], parent: Node | undefined) => {
      l.forEach((text, index) => {
        if (typeof text !== "string") {
          if (RECURSIVE_OBJECTS.includes(text.type)) return;
          if (isIgnored(text, info)) return;
          walk(text.contents, text);
          return;
        }
        const statuses: string[] = [];
        for (let start = 0; start < text.length; start++) {
          const ch = text[start];
          if (ch !== '"' && ch !== "'") continue;
          if (ch === '"') {
            level1Open = !level1Open;
            statuses.push(level1Open ? "primary-opening" : "primary-closing");
          } else if (!level1Open) statuses.push("apostrophe");
          else {
            const previous: string | undefined =
              start > 0
                ? text[start - 1]
                : (() => {
                    const p = index > 0 ? l[index - 1] : undefined;
                    if (p === undefined) return undefined;
                    if (typeof p === "string") return p.slice(-1);
                    return postBlank(p) === 0 ? "no-blank" : "blank";
                  })();
            const next: string | undefined =
              start + 1 < text.length
                ? text[start + 1]
                : (() => {
                    const n = l[index + 1];
                    if (n === undefined) return undefined;
                    if (typeof n === "string") return n[0];
                    return "no-blank";
                  })();
            const isChar = (s: string | undefined) => s !== undefined && s.length === 1;
            const allowOpen =
              (isChar(previous) ? /["\s([{]/.test(previous!) : previous === "blank" || previous === undefined) &&
              (isChar(next) ? /[\p{L}\p{N}.,;:!?_]/u.test(next!) : next === "no-blank");
            const allowClose =
              (isChar(previous) ? /[\p{L}\p{N}.,;:!?_]/u.test(previous!) : previous === "no-blank") &&
              (isChar(next) ? /[\s)\]}.,;:!?"]/.test(next!) : next === "blank" || next === undefined);
            statuses.push(allowOpen && !allowClose ? "secondary-opening" : allowClose && !allowOpen ? "secondary-closing" : "apostrophe");
          }
        }
        if (statuses.length) full.push([l, index, statuses]);
      });
      void parent;
    };
    walk(list, place.parent);
    const primaryOpenings: [string[], number][] = [];
    const secondaryOpenings: [string[], number][] = [];
    for (const [, , status] of full) {
      for (let i = 0; i < status.length; i++) {
        switch (status[i]) {
          case "primary-opening":
            primaryOpenings.unshift([status, i]);
            break;
          case "secondary-opening":
            secondaryOpenings.unshift([status, i]);
            break;
          case "secondary-closing":
            if (secondaryOpenings.length) secondaryOpenings.shift();
            else status[i] = "apostrophe";
            break;
          case "primary-closing":
            for (const [s, j] of secondaryOpenings) s[j] = "apostrophe";
            secondaryOpenings.length = 0;
            primaryOpenings.shift();
            break;
        }
      }
    }
    if (primaryOpenings.length) {
      const [s0, j0] = primaryOpenings[0];
      s0[j0] = "";
      let after = false;
      for (const [, , status] of full)
        for (let i = 0; i < status.length; i++) {
          if (status === s0 && i === j0) after = true;
          if (after && (status[i] === "secondary-opening" || status[i] === "secondary-closing")) status[i] = "apostrophe";
        }
    }
    for (const [l, index, status] of full) if (l === list) found.set(index, status);
    cache.set(list, found);
  }
  return found.get(place.index);
}

/** Replace quotes with typographic ones for an encoding, as org-export-activate-smart-quotes. */
export function activateSmartQuotes(s: string, encoding: string, info: Info, original?: TextPlace): string {
  const place = original ?? currentText;
  const status = place ? [...(smartQuoteStatus(place, info) ?? [])] : [];
  const table = QUOTES[info["language"]];
  return s.replace(/['"]/g, (m) => {
    const st = status.shift();
    return (st && table?.[st]?.[encoding]) ?? m;
  });
}

// Topology.

export function getParentHeadline(blob: Datum): Node | undefined {
  return ancestor(blob, ["headline"]) as Node | undefined;
}

export function getParentTable(object: Datum): Node | undefined {
  return ancestor(object, ["table"]) as Node | undefined;
}

function siblingsOf(blob: Datum, parent?: Node): Datum[] | undefined {
  const up = parent ?? (typeof blob === "string" ? undefined : blob.parent);
  if (!up) return undefined;
  if (up.contents.includes(blob)) return up.contents;
  for (const name of SECONDARY_VALUES[up.type] ?? []) {
    const s = up.p[name];
    if (Array.isArray(s) && s.includes(blob)) return s;
  }
  return up.contents;
}

/** The datum before another, skipping ignored ones, as org-export-get-previous-element; a string's parent must be given. */
export function getPreviousElement(blob: Datum, info: Info, parent?: Node): Datum | undefined {
  const siblings = siblingsOf(blob, parent);
  if (!siblings) return undefined;
  for (let i = siblings.indexOf(blob) - 1; i >= 0; i--) if (!isIgnored(siblings[i], info)) return siblings[i];
  return undefined;
}

/** The datum after another, skipping ignored ones, as org-export-get-next-element. */
export function getNextElement(blob: Datum, info: Info, parent?: Node): Datum | undefined {
  const siblings = siblingsOf(blob, parent);
  if (!siblings) return undefined;
  const at = siblings.indexOf(blob);
  if (at < 0) return undefined;
  for (let i = at + 1; i < siblings.length; i++) if (!isIgnored(siblings[i], info)) return siblings[i];
  return undefined;
}

/** All the data after one, as org-export-get-next-element with N t. */
export function getNextElements(blob: Datum, info: Info, parent?: Node): Datum[] {
  const siblings = siblingsOf(blob, parent);
  if (!siblings) return [];
  return siblings.slice(siblings.indexOf(blob) + 1).filter((d) => !isIgnored(d, info));
}

// Translation.

const PHRASES: { [phrase: string]: { [lang: string]: { [encoding: string]: string } } } = DICTIONARY.dictionary;

/** A phrase in the export's language and an encoding, as org-export-translate. */
export function translate(s: string, encoding: string, info: Info): string {
  const t = PHRASES[s]?.[info["language"]];
  return t?.[encoding] ?? t?.["default"] ?? s;
}

// --- The dispatcher ---------------------------------------------------------------

defvar("org-export-dispatch-last-action", null, "The dispatcher's last action, which C-u C-c C-e repeats.");

let lastAction: { action: (...args: any[]) => any; options: string[] } | undefined;
let lastPosition: e8.Marker | undefined;

interface Entry {
  key: string;
  name: string;
  sub: [string, string, (...args: any[]) => any][] | ((...args: any[]) => any) | undefined;
}

function menuEntries(): Entry[] {
  // The backends org-export-backends names, loaded, as Org loads them with ox.
  const wanted = e8.variable("org-export-backends");
  for (const b of Array.isArray(wanted) ? wanted : []) {
    const name = typeof b === "symbol" ? e8.symbolName(b) : String(b);
    if (!getBackend(name)) e8.require(`ox-${name}`);
  }
  const out: Entry[] = [];
  for (const b of registered) {
    if (!b.menu) continue;
    const [key, name, sub] = b.menu;
    out.push({ key, name, sub: sub as Entry["sub"] });
  }
  return out.sort((a, b) => a.key.codePointAt(0)! - b.key.codePointAt(0)!);
}

const KEY_NAMES: { [key: string]: string } = { "\u0002": "body", "\u0016": "visible", "\u0013": "subtree", "\u0006": "force", "\u0001": "async" };

function dispatchHelp(options: string[], firstKey: string | undefined, entries: Entry[]): string {
  const on = (o: string, yes: string, no: string) => (options.includes(o) ? yes : no);
  let help =
    `[C-b] Body only:    ${on("body", "On ", "Off")}           [C-v] Visible only:     ${on("visible", "On ", "Off")}\n` +
    `[C-s] Export scope: ${on("subtree", "Subtree", "Buffer ")}       [C-f] Force publishing: ${on("force", "On ", "Off")}\n` +
    `[C-a] Async export: ${on("async", "On ", "Off")}\n\n`;
  let lastKey: string | undefined;
  for (const entry of entries) {
    if (entry.key !== lastKey) {
      lastKey = entry.key;
      help += `\n[${entry.key}] ${entry.name}\n`;
    }
    if (Array.isArray(entry.sub)) {
      let index = -1;
      for (const sub of entry.sub) {
        index++;
        help += index % 2 === 0 ? `    [${sub[0]}] ${sub[1].padEnd(26)}` : `[${sub[0]}] ${sub[1]}\n`;
      }
      if (index % 2 === 0) help += "\n";
    }
  }
  help +=
    "\n[P] Publish\n    [f] Current file              [p] Current project\n    [x] Choose project            [a] All projects\n\n\n" +
    "[&] Export stack                  [#] Insert template\n" +
    `[q] ${firstKey ? "Main menu" : "Exit"}`;
  return help;
}

function dispatchUi(options: string[], firstKey: string | undefined, expertp: boolean): { action: any; options: string[] } {
  const entries = menuEntries();
  const allowed = new Set<string>(Object.keys(KEY_NAMES));
  if (!firstKey) for (const e of entries) allowed.add(e.key);
  else for (const e of entries) if (e.key === firstKey && Array.isArray(e.sub)) for (const s of e.sub) allowed.add(s[0]);
  if (firstKey === "P") for (const k of ["f", "p", "x", "a"]) allowed.add(k);
  else if (!firstKey) allowed.add("P");
  allowed.add("&");
  allowed.add("#");
  if (expertp) allowed.add("?");
  allowed.add("q");
  let key: string;
  if (expertp) {
    const flags = ["b", "v", "s", "f", "a"].map((k) => (options.includes(KEY_NAMES[String.fromCharCode(k.charCodeAt(0) - 96)]) ? k.toUpperCase() : k)).join("");
    const keys = [...allowed].filter((k) => k.charCodeAt(0) >= 27).join("");
    key = keyChar(e8.readCharExclusive(`Export command (C-${flags}) [${keys}]: `)) ?? "";
  } else {
    const buffer = "*Org Export Dispatcher*";
    const help = dispatchHelp(options, firstKey, entries);
    key = e8.saveWindowExcursion(() => {
      if (!e8.getBuffer(buffer)) {
        orgPopToBufferSplit(buffer);
        e8.withCurrentBuffer(buffer, () => e8.setVariable("cursor-type", false));
      }
      e8.withCurrentBuffer(buffer, () => {
        const pt = e8.point();
        e8.deleteRegion(e8.pointMin(), e8.pointMax());
        e8.insert(help);
        e8.gotoChar(Math.min(pt, e8.pointMax()));
      });
      const w = getBufferWindow(buffer);
      if (w) orgFitWindowToBuffer(w);
      let k: string;
      for (;;) {
        // As a character: C-s as "\u0013", as read-char-exclusive returns it.
        k = keyChar(e8.readCharExclusive("Export command: ")) ?? "";
        if (["\u000e", "\u0010", " ", "\u007f"].includes(k)) {
          e8.withCurrentBuffer(buffer, () => forwardLine(k === "\u000e" || k === " " ? 1 : -1));
          continue;
        }
        break;
      }
      return k;
    });
  }
  if (!allowed.has(key)) {
    e8.ding();
    if (!expertp) {
      e8.message("Invalid key");
      e8.sitFor(1);
    }
    return dispatchUi(options, firstKey, expertp);
  }
  if (key === "q") {
    if (!firstKey) e8.userError("Export aborted");
    return dispatchUi(options, undefined, expertp);
  }
  if (key === "?") return dispatchUi(options, firstKey, false);
  if (key === "#") return { action: "template", options: options.filter((o) => o === "subtree") };
  if (key === "&") return { action: "stack", options: [] };
  if (KEY_NAMES[key]) {
    const option = KEY_NAMES[key];
    return dispatchUi(options.includes(option) ? options.filter((o) => o !== option) : [option, ...options], firstKey, expertp);
  }
  const entry = entries.find((e) => e.key === key);
  if (firstKey || typeof entry?.sub === "function") {
    let action: any;
    if (!firstKey) action = entry!.sub;
    else if (firstKey === "P") action = { f: "publish-current-file", p: "publish-current-project", x: "publish-choose-project", a: "publish-all" }[key];
    else
      for (const e of entries.slice(entries.findIndex((x) => x.key === firstKey))) {
        const match = Array.isArray(e.sub) ? e.sub.find((s) => s[0] === key) : undefined;
        if (match) {
          action = match[2];
          break;
        }
      }
    return { action, options };
  }
  return dispatchUi(options, key, expertp);
}

const dispatch = e8.defineCommand({
  name: "org-export-dispatch",
  doc: "Export dispatcher for Org mode.\n\nIt offers the export commands of every backend, and options: body only, visible only, subtree, force publishing and async. With C-u, repeat the last export action, with the same options, on the current buffer.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    let input: { action: any; options: string[] };
    if (Array.isArray(arg) && arg[0] === 16) input = { action: "stack", options: [] };
    else if (arg !== null && arg !== undefined && lastAction) input = lastAction;
    else {
      try {
        lastPosition = e8.makeMarker(e8.point());
        const initial = varValue("org-export-initial-scope") === "subtree" ? ["subtree"] : [];
        if (nonNil(varValue("org-export-body-only"))) initial.push("body");
        if (nonNil(varValue("org-export-visible-only"))) initial.push("visible");
        if (nonNil(varValue("org-export-force-publishing"))) initial.push("force");
        input = dispatchUi(initial, undefined, nonNil(varValue("org-export-dispatch-use-expert-ui")));
        lastAction = input;
      } finally {
        const w = getBufferWindow("*Org Export Dispatcher*");
        if (w) withSelectedWindow(w, () => e8.call("quit-window", true));
        if (e8.getBuffer("*Org Export Dispatcher*")) e8.call("kill-buffer", "*Org Export Dispatcher*");
      }
    }
    const { action, options } = input;
    if (!options.includes("subtree")) lastPosition = undefined;
    const at = lastPosition ? e8.markerPosition(lastPosition) : undefined;
    if (action === "template") e8.call("org-export-insert-default-template" as any, null, options.includes("subtree"));
    else if (action === "stack") e8.message("E8 exports in the foreground, so the export stack is empty");
    else if (typeof action === "string" && action.startsWith("publish")) {
      const force = options.includes("force");
      const async = options.includes("async");
      if (action === "publish-choose-project") {
        const projects = (varValue("org-publish-project-alist") as any[]) ?? [];
        e8.call("org-publish" as any, e8.completingRead("Publish project: ", projects.map((p) => String(p[0])), { requireMatch: true }), force, async);
      } else e8.call(`org-${action}` as any, force, async);
    }
    else if (typeof action === "function")
      e8.saveExcursion(() => {
        if (arg !== null && arg !== undefined && lastPosition && e8.markerBuffer(lastPosition) === e8.bufferName() && at !== undefined) e8.gotoChar(at);
        action(options.includes("async"), options.includes("subtree"), options.includes("visible"), options.includes("body"));
      });
  },
});
void dispatch;

e8.defineCommand({
  name: "org-export-insert-default-template",
  doc: "Insert all export keywords with default values at beginning of line, for a backend; with SUBTREEP, as properties of the current subtree.",
  params: [
    { name: "backend", collection: () => ["default", ...registered.map((b) => b.name!).filter(Boolean)], requireMatch: true, prompt: "Options category: " },
    { name: "subtreep", value: () => "" },
  ],
  run: (backendName: string | null, subtreep: any) => {
    const sub = flag(subtreep);
    if (varValue("major-mode") !== "org-mode") e8.userError("Not in an Org mode buffer");
    const node = sub ? headingAtPoint() : undefined;
    if (sub && !node) e8.userError("No subtree to set export options for");
    const name = backendName || e8.completingRead("Options category: ", ["default", ...registered.map((b) => b.name!)], { requireMatch: true });
    const entries = name === "default" ? OPTIONS : getBackend(name)?.options ?? [];
    const options: [string, any][] = [];
    const keywords: [string, any][] = [];
    for (const entry of entries) {
      const [, keyword, option] = entry;
      if (keyword) {
        if (!keywords.some(([k]) => k === keyword)) {
          const v = entry[3] === undefined ? undefined : typeof entry[3] === "function" ? entry[3]() : varValue(entry[3]);
          keywords.push([keyword, entry[4] === "split" && Array.isArray(v) ? v.join(" ") : v]);
        }
      } else if (option && !options.some(([o]) => o === option)) options.push([option, entry[3] === undefined ? false : typeof entry[3] === "function" ? entry[3]() : varValue(entry[3])]);
    }
    if (!node) e8.gotoChar(e8.lineStart(lineAt()));
    const print = (v: any): string => (v === true ? "t" : v === false || v === undefined ? "nil" : typeof v === "string" ? (/^[-\w{}]+$/.test(v) && !/^\d/.test(v) ? v : JSON.stringify(v)) : Array.isArray(v) ? `(${v.map(print).join(" ")})` : String(v));
    const items = options.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([o, v]) => `${o}:${print(v)}`);
    const fill = Number(e8.variable("fill-column") ?? 70);
    // For a subtree, as its EXPORT_ properties, as org-entry-put sets them.
    if (node && items.length) entryPut(node.line, "EXPORT_OPTIONS", items.splice(0).join(" "));
    while (items.length) {
      e8.insert("#+options:");
      let width = 10;
      while (items.length && width + items[0].length + 1 < fill) {
        const item = items.shift()!;
        e8.insert(" " + item);
        width += item.length + 1;
      }
      e8.insert("\n");
    }
    for (const [key, value] of keywords) {
      let val = value;
      if (key === "DATE" && !nonNil(val)) val = e8.formatTimeString("<%Y-%m-%d %a>");
      else if (key === "TITLE" && !nonNil(val)) val = e8.bufferFileName() ? e8.fileNameNondirectory(e8.bufferFileName()!).replace(/\.[^.]*$/, "") : e8.bufferName();
      const s = typeof val === "string" ? val : nonNil(val) ? print(val) : "";
      if (node) entryPut(node.line, `EXPORT_${key}`, s);
      else e8.insert(`#+${key.toLowerCase()}:${/\S/.test(s) ? ` ${s}` : ""}\n`);
    }
  },
});
