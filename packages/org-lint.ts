// Checking an Org buffer for syntax mistakes, after Org's org-lint.el:
// M-x org-lint runs every checker over the buffer's parse tree and lists
// what they report in *Org Lint*, a line each, with the line it is on and
// how far the check can be trusted. There RET goes to a report's line,
// TAB shows it, h hides the reports of the checker of the one at point and
// i ignores that checker from then on; g checks again. With C-u it runs
// the checkers of one category, with C-u C-u one checker.
//
// Checks that Org makes by evaluating Lisp keep to text here, as E8 has
// no Lisp (ADR 0116): a Babel header value written as Lisp, which Org
// evaluates, is not checked against the values its header allows.
//
// Copyright (C) 2015-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { type Datum, type Node, ALL_ELEMENTS, GREATER_ELEMENTS, contents, lineage, map, mapFirst, parentOf, property, typeOf } from "org-element-ast";
import { interpretData, parseBuffer, restriction } from "org-element";
import { showSetVisibility } from "org-fold";
import { findIdFile, updateIdLocations } from "org-id";
import { currentTemplates, initializeTemplates } from "org-macro";
import { langMode } from "org-src";
import { searchInBuffer } from "ol";
import { type Info, OPTIONS, getPreviousElement, registered, resolveCoderef, resolveFuzzyLink, resolveIdLink, resolveLink } from "ox";
import {
  type Column,
  type Entry,
  tabulatedListGetEntry,
  tabulatedListGetId,
  tabulatedListInitHeader,
  tabulatedListPrint,
} from "tabulated-list";
import { PerBuffer, allMatches, regexpQuote, truthy } from "subr";

// ----- Checkers -----

/** What a checker reports: a buffer position and a one-line message. */
export type Report = [number, string];

/** A checker, as org-lint-checker: its name, summary, function, trust and categories. */
export interface Checker {
  name: string;
  summary: string;
  fn: (ast: Node) => Report[] | Report | undefined | null | false;
  /** "low" or "high", or undefined where Org gives none, which the report shows as nil. */
  trust?: string;
  categories: string[];
}

/** The checkers, as org-lint--checkers: the one added last first. */
let checkers: Checker[] = [];

/**
 * Adds a checker, replacing one of the same name, as org-lint-add-checker:
 * FN is called with the buffer's parse tree, point at its start, and
 * returns reports, each a position and a message.
 */
export function addChecker(name: string, summary: string, fn: Checker["fn"], props: { trust?: string; categories?: string[] } = {}): void {
  if (!name) e8.signal("error", "Name field is mandatory for checkers");
  if (typeof fn !== "function") e8.signal("error", "Checker field is expected to be a valid function");
  checkers = [{ name, summary, fn, trust: props.trust, categories: props.categories ?? [] }, ...checkers.filter((c) => c.name !== name)];
}

/** The checkers there are, the one added last first. */
export const allCheckers = (): Checker[] => checkers;

const name = (v: e8.Value | undefined): string => (typeof v === "symbol" ? e8.symbolName(v) : String(v ?? ""));

e8.defun("org-lint-add-checker", (checker: e8.Value, summary: string, fn: e8.Value, ...props: e8.Value[]) => {
  const opts: { trust?: string; categories?: string[] } = {};
  for (let i = 0; i + 1 < props.length; i += 2) {
    const key = name(props[i]);
    if (key === ":trust") opts.trust = name(props[i + 1]);
    if (key === ":categories") opts.categories = (Array.isArray(props[i + 1]) ? (props[i + 1] as e8.Value[]) : []).map(name);
  }
  addChecker(name(checker), String(summary ?? ""), (ast) => e8.funcall(fn as any, ast as unknown as e8.Value) as Report[], opts);
});

// ----- Reports -----

/** A report as the list shows it: where, how far to trust it, what, and which checker made it. */
interface Shown {
  marker: e8.Marker;
  line: number;
  trust: string;
  message: string;
  checker: Checker;
}

/**
 * Runs CHECKERS over BUFFER and returns their reports, ordered by
 * position, as org-lint--generate-reports: each with a marker at its
 * position and the line it is on.
 */
export function generateReports(buffer: string, list: Checker[]): Shown[] {
  return e8.withCurrentBuffer(buffer, () =>
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMin());
      const ast = parseBuffer();
      const found: { pos: number; trust: string; message: string; checker: Checker }[] = [];
      for (const c of list) {
        const reports = e8.saveExcursion(() => {
          e8.gotoChar(e8.pointMin());
          return c.fn(ast);
        });
        if (!Array.isArray(reports)) continue;
        for (const r of reports as Report[]) found.push({ pos: r[0], trust: c.trust ?? "nil", message: String(r[1]), checker: c });
      }
      // Stable, as Emacs's sort.
      found.sort((a, b) => a.pos - b.pos);
      return found.map((r) => ({
        marker: e8.makeMarker(r.pos),
        line: e8.lineOf(Math.min(r.pos, e8.pointMax())) + 1,
        trust: r.trust,
        message: r.message,
        checker: r.checker,
      }));
    }),
  );
}

e8.defun("org-lint--generate-reports", (buffer: e8.Value, names?: e8.Value) => {
  const wanted = Array.isArray(names) ? names.map(name) : undefined;
  const list = wanted ? checkers.filter((c) => wanted.includes(c.name)) : checkers;
  const buf = typeof buffer === "string" ? buffer : e8.bufferName();
  return generateReports(buf, list).map((r) => [r.line, r.trust, r.message, r.checker.name]) as unknown as e8.Value;
});

/** Each report buffer's source, checkers and reports, as org-lint--source-buffer and org-lint--local-checkers. */
const reportState = new PerBuffer<{ source: string; checkers: Checker[]; reports: Shown[] }>();

const LIST = "*Org Lint*";

/** Checks the source again and lists what is found, as org-lint--refresh-reports. */
function refreshReports(): void {
  const state = reportState.get(e8.currentBuffer());
  if (!state) return;
  for (const r of state.reports) e8.deleteMarker(r.marker);
  state.reports = generateReports(state.source, state.checkers);
  setEntries(state.reports.map((r, i) => i));
  tabulatedListPrint();
}

/** Lists the reports at INDEXES, each its own entry, its id its index. */
function setEntries(indexes: number[]): void {
  const state = reportState.get(e8.currentBuffer());
  if (!state) return;
  const entries: Entry[] = indexes.map((i) => {
    const r = state.reports[i];
    return [i + 1, [String(r.line), r.trust, r.message] as Column[]];
  });
  e8.setVariable("tabulated-list-entries", entries as unknown as e8.Value);
}

/** The report the line at point lists, as tabulated-list-get-entry gives it. */
function currentReport(): Shown {
  const id = tabulatedListGetId();
  const state = reportState.get(e8.currentBuffer());
  const report = typeof id === "number" ? state?.reports[id - 1] : undefined;
  if (!report || tabulatedListGetEntry() === undefined) e8.signal("error", "No report on this line");
  return report;
}

e8.defineMajorMode({
  name: "org-lint--report-mode",
  modeName: "OrgLint",
  parent: "tabulated-list-mode",
  doc:
    "Major mode used to display reports emitted during linting. RET goes to the line a report is about, TAB or C-j shows it; " +
    "h hides the reports of the checker of the report at point, and i ignores that checker from then on.",
  bindings: {
    RET: "org-lint--jump-to-source" as any,
    TAB: "org-lint--show-source" as any,
    "C-j": "org-lint--show-source" as any,
    h: "org-lint--hide-checker" as any,
    i: "org-lint--ignore-checker" as any,
  },
  setup: () => {
    const sym = (s: string) => Symbol.for(s) as unknown as e8.Value;
    const byLine = (a: e8.Value[], b: e8.Value[]) => Number((a[1] as e8.Value[])[0]) < Number((b[1] as e8.Value[])[0]);
    e8.setVariable("tabulated-list-format", [
      ["Line", 6, byLine as unknown as e8.Value, sym(":right-align"), true],
      ["Trust", 5, true],
      ["Warning", 0, true],
    ] as unknown as e8.Value);
    tabulatedListInitHeader();
  },
});

/** Shows the reports of CHECKERS on SOURCE in *Org Lint*, as org-lint--display-reports. */
function displayReports(source: string, list: Checker[]): void {
  e8.getBufferCreate(LIST);
  e8.withCurrentBuffer(LIST, () => {
    e8.call("org-lint--report-mode" as any);
    const old = reportState.get(e8.currentBuffer());
    for (const r of old?.reports ?? []) e8.deleteMarker(r.marker);
    reportState.set(e8.currentBuffer(), { source, checkers: list, reports: [] });
    refreshReports();
    e8.addHook("tabulated-list-revert-hook", refreshReports, { local: true });
  });
  e8.call("pop-to-buffer", LIST);
}

e8.defineCommand({
  name: "org-lint--jump-to-source",
  doc: "Move to source line that generated the report at point.",
  run: () => {
    const report = currentReport();
    const source = reportState.get(e8.currentBuffer())!.source;
    const pos = e8.markerPosition(report.marker) ?? 0;
    e8.call("switch-to-buffer-other-window", source);
    if (pos < e8.pointMin() || pos > e8.pointMax()) e8.widen();
    e8.gotoChar(pos);
    showSetVisibility("local");
    e8.call("recenter");
  },
});

e8.defineCommand({
  name: "org-lint--show-source",
  doc: "Show source line that generated the report at point.",
  run: () => {
    const buffer = e8.bufferName();
    e8.call("org-lint--jump-to-source" as any);
    e8.call("switch-to-buffer-other-window", buffer);
  },
});

/** Hides the reports of the checker of the report at point, as org-lint--hide-checker. */
function hideChecker(): void {
  const c = currentReport().checker;
  const state = reportState.get(e8.currentBuffer())!;
  const shown = (e8.variable("tabulated-list-entries") as unknown as Entry[] | null) ?? [];
  setEntries(shown.map(([id]) => Number(id) - 1).filter((i) => state.reports[i].checker !== c));
  tabulatedListPrint();
}

e8.defineCommand({
  name: "org-lint--hide-checker",
  doc: "Hide all reports from checker that generated the report at point.",
  run: () => hideChecker(),
});

e8.defineCommand({
  name: "org-lint--ignore-checker",
  doc: "Ignore all reports from checker that generated the report at point. Checker will also be ignored in all subsequent reports.",
  run: () => {
    const c = currentReport().checker;
    const state = reportState.get(e8.currentBuffer())!;
    state.checkers = state.checkers.filter((x) => x !== c);
    hideChecker();
  },
});

/** The checkers ARG picks, as org-lint reads it: all, a category's with C-u, one by name with C-u C-u, or those named. */
function pickCheckers(arg: e8.Value): Checker[] {
  if (arg === null || arg === undefined || arg === false) return checkers;
  if (Array.isArray(arg) && arg.length === 1 && arg[0] === 4) {
    // The first category of each checker, as completing-read takes each list's car; nil for those with none.
    const firsts = [...new Set(checkers.map((c) => c.categories[0] ?? "nil"))];
    const category = e8.completingRead("Checker category: ", firsts, { requireMatch: true });
    return checkers.filter((c) => c.categories.includes(category));
  }
  if (Array.isArray(arg) && arg.length === 1 && arg[0] === 16) {
    const wanted = e8.completingRead("Checker name: ", checkers.map((c) => c.name), { requireMatch: true });
    const found = checkers.find((c) => c.name === wanted);
    return found ? [found] : [];
  }
  if (Array.isArray(arg) && arg.length > 0) {
    const names = arg.map(name);
    return checkers.filter((c) => names.includes(c.name));
  }
  return e8.userError(`Invalid argument \`${e8.prin1ToString(arg)}' for \`org-lint'`);
}

e8.defineCommand({
  name: "org-lint",
  doc:
    "Check current Org buffer for syntax mistakes. By default, run all checkers. With a C-u prefix argument, select one " +
    "category of checkers only; with C-u C-u, run one precise checker by its name. The reports are listed in *Org Lint*.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.Value) => {
    if (!e8.derivedModeP("org-mode")) e8.userError("Not in an Org buffer");
    e8.message("Org linting process starting...");
    const list = pickCheckers(arg);
    displayReports(e8.bufferName(), list);
    e8.message("Org linting process completed");
  },
});

// ----- What the checkers share -----

/** The innermost element at POS in AST, as org-element-at-point finds it there. */
function elementAtIn(ast: Node, pos: number): Node | undefined {
  let node: Node = ast;
  let found: Node | undefined;
  const size = e8.pointMax();
  for (;;) {
    const kids = node.contents.filter((d): d is Node => typeof d !== "string" && ALL_ELEMENTS.includes(d.type));
    let next = kids.find((k) => (property("begin", k) as number) <= pos && pos < (property("end", k) as number));
    if (!next && pos === size) next = [...kids].reverse().find((k) => property("end", k) === size);
    if (!next) return found;
    found = next.type === "section" ? found : next;
    if (!GREATER_ELEMENTS.includes(next.type) && next.type !== "section") return found;
    const cb = property("contents-begin", next) as number | undefined;
    const ce = property("contents-end", next) as number | undefined;
    if (cb === undefined || ce === undefined || pos < cb || (pos >= ce && pos !== size)) return found;
    node = next;
  }
}

/** The innermost object at POS in AST, or the element there, as org-element-context. */
function contextAtIn(ast: Node, pos: number): Datum | undefined {
  const element = elementAtIn(ast, pos);
  if (!element) return undefined;
  let found: Datum = element;
  for (;;) {
    const inner = map(
      contents(found),
      true,
      (d) => (typeof d !== "string" && (property("begin", d) as number) <= pos && pos < (property("end", d) as number) ? d : undefined),
      { firstMatch: true, noRecursion: [...ALL_ELEMENTS] },
    )[0] as Node | undefined;
    if (!inner || inner === found) return found;
    found = inner;
  }
}

const typeIn = (d: Datum | undefined, types: string[]): boolean => d !== undefined && types.includes(typeOf(d) ?? "");
const begin = (d: Datum): number => property("begin", d) as number;
const endOf = (d: Datum): number => property("end", d) as number;
const postAffiliated = (d: Datum): number => (property("post-affiliated", d) as number | undefined) ?? begin(d);

/** Whether a string has something other than blanks, as org-string-nw-p. */
const nw = (s: unknown): s is string => typeof s === "string" && /\S/.test(s);

/** A string without the double quotes around it, if both are there, as org-strip-quotes. */
const stripQuotes = (s: string): string => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/** Whether a file name is a remote one, as file-remote-p sees /method:host:file. */
const remoteP = (file: string): boolean => /^\/[^/:]+:[^/]*:/.test(file);

/** Whether S is a URL, as org-url-p asks ffap-url-regexp. */
const urlP = (s: string): boolean =>
  e8.stringMatch("\\(news\\(post\\)?:\\|mailto:\\|file:\\|\\(ftp\\|https?\\|telnet\\|gopher\\|gemini\\|www\\|wais\\)://\\)", s) !== undefined;

/** The reports of the duplicates among TYPE's keys, the first of each too, as org-lint--collect-duplicates. */
function collectDuplicates(
  ast: Node,
  types: string | string[],
  key: (d: Datum) => string | undefined,
  position: (d: Datum, key: string) => number,
  message: (key: string) => string,
): Report[] {
  const keys: [string, number][] = [];
  const originals: [string, number][] = [];
  const reports: Report[] = [];
  map(ast, types, (d) => {
    const k = key(d);
    if (k === undefined) return undefined;
    const seen = keys.find(([x]) => x === k);
    if (seen) {
      if (!originals.includes(seen)) originals.unshift(seen);
      reports.unshift([position(d, k), message(k)]);
    } else keys.unshift([k, position(d, k)]);
    return undefined;
  });
  for (const [k, pos] of originals) reports.unshift([pos, message(k)]);
  return reports;
}

/** Each match of an Emacs regexp in the buffer from point, as a re-search-forward loop sees it, point after it. */
function eachMatch(regexp: string, f: () => void, caseFold = true): void {
  while (e8.reSearchForward(regexp, { noerror: true, caseFold }) !== undefined) f();
}

// ----- Babel's header arguments -----

/** The header arguments Babel knows for all languages, as org-babel-header-arg-names. */
const HEADER_ARG_NAMES = [
  "cache", "cmdline", "colnames", "comments", "dir", "eval", "exports", "epilogue", "file", "file-desc", "file-ext", "file-mode",
  "hlines", "mkdirp", "no-expand", "noeval", "noweb", "noweb-ref", "noweb-sep", "noweb-prefix", "output-dir", "padline", "post",
  "prologue", "results", "rownames", "sep", "session", "shebang", "tangle", "tangle-mode", "var", "wrap",
];

/** A header's allowed values: groups of names and numbers, ":any" for any; undefined for any value at all. */
type Allowed = (string | number)[][] | undefined;

/** The values each header allows, as org-babel-common-header-args-w-values. */
const COMMON_HEADER_VALUES: [string, Allowed][] = [
  ["cache", [["no", "yes"]]],
  ["cmdline", undefined],
  ["colnames", [["nil", "no", "yes"]]],
  ["comments", [["no", "link", "yes", "org", "both", "noweb"]]],
  ["dir", undefined],
  ["eval", [["yes", "no", "no-export", "strip-export", "never-export", "eval", "never", "query"]]],
  ["exports", [["code", "results", "both", "none"]]],
  ["epilogue", undefined],
  ["file", undefined],
  ["file-desc", undefined],
  ["file-ext", undefined],
  ["file-mode", [[493, 365, 292, ":any"]]],
  ["hlines", [["no", "yes"]]],
  ["mkdirp", [["yes", "no"]]],
  ["no-expand", undefined],
  ["noeval", undefined],
  ["noweb", [["yes", "no", "tangle", "strip-tangle", "no-export", "strip-export"]]],
  ["noweb-ref", undefined],
  ["noweb-sep", undefined],
  ["noweb-prefix", [["no", "yes"]]],
  ["output-dir", undefined],
  ["padline", [["yes", "no"]]],
  ["post", undefined],
  ["prologue", undefined],
  [
    "results",
    [
      ["file", "list", "vector", "table", "scalar", "verbatim"],
      ["raw", "html", "latex", "org", "code", "pp", "drawer", "link", "graphics"],
      ["replace", "silent", "none", "discard", "append", "prepend"],
      ["output", "value"],
    ],
  ],
  ["rownames", [["no", "yes"]]],
  ["sep", undefined],
  ["session", undefined],
  ["shebang", undefined],
  ["tangle", [["tangle", "yes", "no", ":any"]]],
  ["tangle-mode", [[493, 365, 292, ":any"]]],
  ["var", undefined],
  ["wrap", undefined],
];

/** The languages Babel runs, as org-babel-load-languages names them. */
function loadLanguages(): string[] {
  const v = e8.variable("org-babel-load-languages");
  return Array.isArray(v) ? v.map((e) => name(Array.isArray(e) ? e[0] : e)) : ["emacs-lisp"];
}

/** A language's own header arguments and their values, as org-babel-header-args:LANG, if it has any. */
function languageHeaderArgs(language: string): [string, Allowed][] | undefined {
  const v = e8.variable(`org-babel-header-args:${language}`);
  if (!Array.isArray(v)) return language === "emacs-lisp" ? [["lexical", undefined]] : undefined;
  return v.map((e) => {
    const pair = Array.isArray(e) ? e : [e];
    const values = pair.slice(1);
    return [name(pair[0]), values.length === 0 || values.some((x) => name(x) === ":any") ? undefined : (values as (string | number)[][])];
  });
}

/** A header argument as Babel reads it: its name, with its colon, and its value: text, a number, or null for none. */
type Header = [string, string | number | null];

/** Splits STRING at a blank followed by a colon, keeping brackets and quotes whole, as org-babel-balanced-split with ((32 9) . 58). */
function balancedSplit(s: string, split: (past: string | undefined, next: string) => boolean, pair: boolean): string[] {
  const result: string[] = [];
  let partial: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (split(i > 0 ? s[i - 1] : undefined, c)) {
      if (pair) partial.pop();
      if (partial.length > 0) {
        result.push(partial.join(""));
        partial = [];
      }
      i++;
    } else if (c === "(" || c === "[") {
      const origin = i;
      const openings = [c];
      let j = i + 1;
      while (openings.length > 0) {
        const m = /[\]()[]/.exec(s.slice(j));
        if (!m) break;
        j += m.index + 1;
        const ch = s[j - 1];
        if (ch === "[" || ch === "(") openings.unshift(ch);
        else if (ch === "]") {
          if (openings[0] === "[") openings.shift();
        } else if (openings[0] === "(") openings.shift();
      }
      if (openings.length === 0) {
        partial.push(...s.slice(origin, j));
        i = j;
      } else {
        partial.push(c);
        i = origin + 1;
      }
    } else if (c === '"' && (i === 0 || s[i - 1] !== "\\")) {
      const m = /[^\\]"/.exec(s.slice(i + 1 > s.length ? s.length : i));
      // Searching from point, as re-search-forward from the quote: the match may start at the quote itself.
      const from = i;
      const close = m ? from + m.index + m[0].length : undefined;
      if (close !== undefined && close > i) {
        partial.push(...s.slice(i, close));
        i = close;
      } else {
        partial.push('"');
        i++;
      }
    } else {
      partial.push(c);
      i++;
    }
  }
  if (partial.length > 0) result.push(partial.join(""));
  return result;
}

/** STRING without the blanks at its end, as org-babel-chomp. */
const chomp = (s: string): string => s.replace(/[ \f\t\n\r\v]+$/, "");

/** Whether a value is Lisp Babel would evaluate, as org-babel-read sees it: starting (, ', ` or [, or *this*. */
const lispValueP = (s: string): boolean => /^[(`'[]/.test(s) || s === "*this*";

/** A value as org-babel-read gives it, without evaluating Lisp: a number, a quoted string's contents, or the text. */
function babelRead(cell: string): string | number {
  if (!nw(cell)) return cell;
  const t = cell.trim();
  if (!/\s/.test(t) && /^[0-9e.+ -]+$/.test(cell)) {
    const n = Number(t);
    if (/^[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[-+]?[0-9]+)?$/.test(t) && Number.isFinite(n)) return n;
  }
  const quoted = /^\s*("(?:[^"\\]|\\.)*")\s*$/.exec(cell);
  if (quoted) {
    try {
      return JSON.parse(quoted[1]) as string;
    } catch {
      return cell;
    }
  }
  return cell;
}

/** Header arguments as Babel reads them, :var's split, as org-babel-parse-header-arguments; Lisp is never evaluated. */
function parseHeaderArguments(text: string | undefined): Header[] {
  if (!nw(text)) return [];
  const raw = balancedSplit(text, (past, next) => (past === " " || past === "\t") && next === ":", true);
  const args = raw.length === 0 ? [] : [raw[0], ...raw.slice(1).map((r) => `:${r}`)];
  const headers: Header[] = args.map((arg) => {
    const m = /([^ \f\t\n\r\v]+)[ \f\t\n\r\v]+([^ \f\t\n\r\v]+[^]*)/.exec(arg);
    return m ? [m[1], babelRead(chomp(m[2]))] : [chomp(arg), null];
  });
  const out: Header[] = [];
  for (const [key, value] of headers) {
    if (key !== ":var") {
      out.push([key, value]);
      continue;
    }
    const parts = joinSplitsNear("=", balancedSplit(value === null ? "" : String(value), (_past, next) => next === " ", false));
    if (parts.length === 0) out.push([":var", null]);
    else for (const v of parts) out.push([":var", v.trim()]);
  }
  return out;
}

/** Joins the strings of LIST where CH ends one or starts the next, as org-babel-join-splits-near-ch. */
function joinSplitsNear(ch: string, list: string[]): string[] {
  const acc: string[] = [];
  for (const el of list) {
    const head = acc[acc.length - 1];
    if (head !== undefined && (head.endsWith(ch) || el.startsWith(ch))) acc[acc.length - 1] = head + el;
    else acc.push(el);
  }
  return acc;
}

/** A value as Lisp's format "%s" prints it. */
const princ = (v: string | number | null): string => (v === null ? "nil" : String(v));

// ----- The checkers -----

function misplacedHeading(ast: Node): Report[] {
  const result: Report[] = [];
  eachMatch("[^\n\r *,]\\*\\*+ ", () => {
    if (typeIn(elementAtIn(ast, e8.point()), ["paragraph", "headline"])) result.unshift([e8.matchBeginning(0) ?? 0, "Possibly misplaced heading line"]);
  });
  return result;
}

const duplicateCustomId = (ast: Node): Report[] =>
  collectDuplicates(
    ast,
    "node-property",
    (p) => (String(property("key", p)).toUpperCase() === "CUSTOM_ID" ? (property("value", p) as string | undefined) : undefined),
    (p) => begin(p),
    (k) => `Duplicate CUSTOM_ID property "${k}"`,
  );

const duplicateName = (ast: Node): Report[] =>
  collectDuplicates(
    ast,
    ALL_ELEMENTS,
    (d) => property("name", d) as string | undefined,
    (d, n) => {
      e8.gotoChar(begin(d));
      e8.reSearchForward(`^[ \t]*#\\+[A-Za-z]+:[ \t]*${regexpQuote(n)}[ \t]*$`);
      return e8.matchBeginning(0) ?? begin(d);
    },
    (k) => `Duplicate NAME "${k}"`,
  );

const duplicateTarget = (ast: Node): Report[] =>
  collectDuplicates(
    ast,
    "target",
    (t) => JSON.stringify(String(property("value", t)).split(/[ \f\t\n\r\v]+/).filter(Boolean)),
    (t) => begin(t),
    (k) => `Duplicate target <<${(JSON.parse(k) as string[]).join(" ")}>>`,
  );

const duplicateFootnoteDefinition = (ast: Node): Report[] =>
  collectDuplicates(
    ast,
    "footnote-definition",
    (d) => property("label", d) as string | undefined,
    (d) => postAffiliated(d),
    (k) => `Duplicate footnote definition "${k}"`,
  );

const AFFILIATED_KEYWORDS = ["CAPTION", "DATA", "HEADER", "HEADERS", "LABEL", "NAME", "PLOT", "RESNAME", "RESULT", "RESULTS", "SOURCE", "SRCNAME", "TBLNAME"];

function orphanedAffiliatedKeywords(ast: Node): Report[] {
  // Not RESULTS, which a source block returning no value can leave alone.
  const keywords = AFFILIATED_KEYWORDS.filter((k) => k !== "RESULT" && k !== "RESULTS");
  return map(ast, "keyword", (k) => {
    const key = String(property("key", k));
    return (/^ATTR_[-_A-Za-z0-9]+$/i.test(key) || keywords.includes(key)) && ([postAffiliated(k), `Orphaned affiliated keyword: "${key}"`] as Report);
  });
}

function regularKeywordBeforeAffiliated(ast: Node): Report[] {
  return map(ast, "keyword", (keyword) => {
    if ((property("post-blank", keyword) ?? 0) !== 0) return undefined;
    const next = elementAtIn(ast, endOf(keyword));
    if (next && begin(next) < postAffiliated(next))
      return [begin(keyword), `Independent keyword ${String(property("key", keyword))} may be confused with affiliated keywords below`] as Report;
    return undefined;
  });
}

function obsoleteAffiliatedKeywords(ast: Node): Report[] {
  const reports: Report[] = [];
  eachMatch("^[ \t]*#\\+\\(DATA\\|HEADERS\\|LABEL\\|RES\\(?:NAME\\|ULT\\)\\|S\\(?:OURCE\\|RCNAME\\)\\|TBLNAME\\):", () => {
    const key = String(e8.matchString(1)).toUpperCase();
    const element = elementAtIn(ast, e8.point());
    if (element && e8.point() < postAffiliated(element))
      reports.unshift([
        e8.lineStart(e8.lineOf(e8.point())),
        `Obsolete affiliated keyword: "${key}".  Use "${key === "HEADERS" ? "HEADER" : key === "RESULT" ? "RESULTS" : "NAME"}" instead`,
      ]);
  });
  return reports;
}

function deprecatedExportBlocks(ast: Node): Report[] {
  const deprecated = ["ASCII", "BEAMER", "HTML", "LATEX", "MAN", "MARKDOWN", "MD", "ODT", "ORG", "TEXINFO"];
  return map(ast, "special-block", (b) => {
    const type = String(property("type", b));
    return deprecated.includes(type.toUpperCase()) && ([postAffiliated(b), `Deprecated syntax for export block.  Use "BEGIN_EXPORT ${type}" instead`] as Report);
  });
}

function deprecatedHeaderSyntax(ast: Node): Report[] {
  // DIR is also used for attachments.
  const deprecated = COMMON_HEADER_VALUES.map(([k]) => k).filter((k) => k !== "dir");
  const re = new RegExp(`^(${deprecated.map((k) => k.replace(/[-]/g, "\\-")).sort((a, b) => b.length - a.length).join("|")})[ \\t]`);
  return map(ast, ["keyword", "node-property"], (d) => {
    const key = String(property("key", d));
    if (typeOf(d) === "keyword") {
      const value = String(property("value", d) ?? "");
      const m = key === "PROPERTY" ? re.exec(value) : null;
      return m && ([begin(d), `Deprecated syntax for "${m[1]}".  Use header-args instead`] as Report);
    }
    return deprecated.includes(key.toLowerCase()) && ([begin(d), `Deprecated syntax for "${key}".  Use :header-args: instead`] as Report);
  });
}

const missingLanguageInSrcBlock = (ast: Node): Report[] =>
  map(ast, "src-block", (b) => !property("language", b) && ([postAffiliated(b), "Missing language in source block"] as Report));

const suspiciousLanguageInSrcBlock = (ast: Node): Report[] =>
  map(ast, "src-block", (b) => {
    const lang = property("language", b) as string | undefined;
    if (!lang || e8.fboundp(`org-babel-execute:${lang}`) || e8.fboundp(langMode(lang))) return undefined;
    return [postAffiliated(b), `Unknown source block language: '${lang}'`] as Report;
  });

const missingBackendInExportBlock = (ast: Node): Report[] =>
  map(ast, "export-block", (b) => !property("type", b) && ([postAffiliated(b), "Missing backend in export block"] as Report));

const invalidBabelCallBlock = (ast: Node): Report[] =>
  map(ast, "babel-call", (b) => {
    if (!property("call", b)) return [postAffiliated(b), "Invalid syntax in babel call block"] as Report;
    const h = property("end-header", b) as string | undefined;
    return h !== undefined && /^\[.*\]$/.test(h) && ([postAffiliated(b), "Babel call's end header must not be wrapped within brackets"] as Report);
  });

function deprecatedCategorySetup(ast: Node): Report[] {
  let seen = false;
  return map(ast, "keyword", (k) => {
    if (property("key", k) !== "CATEGORY") return undefined;
    if (seen) return [postAffiliated(k), "Spurious CATEGORY keyword.  Set :CATEGORY: property instead"] as Report;
    seen = true;
    return undefined;
  });
}

/** Whether F signals, as ignore-errors returning nil. */
function fails(f: () => unknown): boolean {
  try {
    return !truthy(f() as e8.Value);
  } catch {
    return true;
  }
}

function invalidCoderefLink(ast: Node): Report[] {
  const info: Info = { "parse-tree": ast, "id-alist": [] };
  return map(ast, "link", (link) => {
    const ref = String(property("path", link));
    return property("type", link) === "coderef" && fails(() => resolveCoderef(ref, info)) && ([begin(link), `Unknown coderef "${ref}"`] as Report);
  });
}

function invalidCustomIdLink(ast: Node): Report[] {
  const info: Info = { "parse-tree": ast, "id-alist": [] };
  return map(
    ast,
    "link",
    (link) =>
      property("type", link) === "custom-id" &&
      fails(() => resolveIdLink(link as Node, info)) &&
      ([begin(link), `Unknown custom ID "${String(property("path", link))}"`] as Report),
  );
}

function invalidFuzzyLink(ast: Node): Report[] {
  const info: Info = { "parse-tree": ast, "id-alist": [] };
  return map(ast, "link", (link) => {
    if (property("type", link) !== "fuzzy" || !fails(() => resolveFuzzyLink(link as Node, info))) return undefined;
    const path = String(property("path", link));
    return [begin(link), `Unknown fuzzy location "${path.startsWith("*") ? path.slice(1) : path}"`] as Report;
  });
}

function invalidIdLink(ast: Node): Report[] {
  let updated = false;
  return map(ast, "link", (link) => {
    if (property("type", link) !== "id") return undefined;
    const id = String(property("path", link));
    if (!updated) {
      updateIdLocations([], true);
      updated = true;
    }
    return findIdFile(id) === undefined && ([begin(link), `Unknown ID "${id}"`] as Report);
  });
}

const confusingBrackets = (ast: Node): Report[] =>
  map(
    ast,
    "link",
    (link) =>
      e8.saveRestriction(() => (e8.widen(), e8.bufferText(endOf(link), endOf(link) + 1) === "]")) && ([begin(link), "Trailing ']' after link end"] as Report),
  );

function bracketsInsideDescription(ast: Node): Report[] {
  return map(ast, "link", (link) => {
    const cb = property("contents-begin", link) as number | undefined;
    const ce = property("contents-end", link) as number | undefined;
    if (cb === undefined || ce === undefined) return undefined;
    let count = 0;
    for (const c of e8.bufferText(cb, ce)) {
      if (c === "[") count++;
      else if (c === "]") count--;
    }
    return count > 0 && ([begin(link), `No closing ']' matches '[' in link description: ${e8.bufferSubstringNoProperties(cb, ce)}`] as Report);
  });
}

const SPECIAL_PROPERTIES = ["ALLTAGS", "BLOCKED", "CLOCKSUM", "CLOCKSUM_T", "CLOSED", "DEADLINE", "FILE", "ITEM", "PRIORITY", "SCHEDULED", "TAGS", "TIMESTAMP", "TIMESTAMP_IA", "TODO"];

const specialPropertyInPropertiesDrawer = (ast: Node): Report[] =>
  map(ast, "node-property", (p) => {
    const key = String(property("key", p));
    return SPECIAL_PROPERTIES.includes(key.toUpperCase()) && ([begin(p), `Special property "${key}" found in a properties drawer`] as Report);
  });

function obsoletePropertiesDrawer(ast: Node): Report[] {
  // Org looks for what comes before the drawer with assq in its parent's
  // contents, whose elements are never keys there, so it always finds
  // nothing before it and says the drawer's contents are wrong: so here.
  return map(ast, "drawer", (d) => property("drawer-name", d) === "PROPERTIES" && ([postAffiliated(d), "Incorrect contents for PROPERTIES drawer"] as Report));
}

/** Whether S is a duration, as org-duration-p: H:MM or H:MM:SS, units, or units then H:MM. */
function durationP(s: string): boolean {
  const unit = "[ \\t]*([0-9]+(?:\\.[0-9]*)?)[ \\t]*(min|[dhmwy])";
  return (
    new RegExp(`^(?:${unit})+[ \\t]*$`).test(s) ||
    new RegExp(`^(?:${unit})+[ \\t]*[0-9]+(?::[0-9][0-9]){1,2}[ \\t]*$`).test(s) ||
    /^[ \t]*[0-9]+(?::[0-9]{2}){1,2}[ \t]*$/.test(s)
  );
}

const invalidEffortProperty = (ast: Node): Report[] =>
  map(ast, "node-property", (p) => {
    if (property("key", p) !== "EFFORT") return undefined;
    const value = property("value", p);
    return nw(value) && !durationP(value) && ([begin(p), `Invalid effort duration format: ${JSON.stringify(value)}`] as Report);
  });

const invalidIdProperty = (ast: Node): Report[] =>
  map(ast, "node-property", (p) => {
    if (property("key", p) !== "ID") return undefined;
    const value = property("value", p);
    return nw(value) && value.includes("::") && ([begin(p), `IDs should not include "::": ${JSON.stringify(value)}`] as Report);
  });

function linkToLocalFile(ast: Node): Report[] {
  return map(ast, "link", (l) => {
    const type = property("type", l);
    if (type !== "attachment" && type !== "file") return undefined;
    const path = String(property("path", l));
    let file = path;
    if (type === "attachment") {
      // Through org-attach-expand, loading org-attach as org-lint requires it; left alone where there is none.
      try {
        e8.require("org-attach");
      } catch {
        return undefined;
      }
      if (!e8.fboundp("org-attach-expand")) return undefined;
      file = e8.saveExcursion(() => (e8.gotoChar(begin(l)), String(e8.funcall("org-attach-expand", path))));
    }
    file = e8.substituteInFileName(file);
    if (remoteP(file) || e8.fileExistsP(file)) return undefined;
    const inDescription = lineage(l, ["link"]).length > 0;
    return [begin(l), `${inDescription ? "Link to non-existent image file" : "Link to non-existent local file"} ${JSON.stringify(file)}${inDescription ? " in description" : ""}`] as Report;
  });
}

function nonExistentSetupfileParameter(ast: Node): Report[] {
  return map(ast, "keyword", (k) => {
    if (property("key", k) !== "SETUPFILE") return undefined;
    const file = stripQuotes(String(property("value", k) ?? ""));
    return !urlP(file) && !remoteP(file) && !e8.fileExistsP(file) && ([begin(k), `Non-existent setup file ${JSON.stringify(file)}`] as Report);
  });
}

function wrongIncludeLinkParameter(ast: Node): Report[] {
  return map(ast, "keyword", (k) => {
    if (property("key", k) !== "INCLUDE") return undefined;
    const value = String(property("value", k) ?? "");
    const m = /^(".+?"|\S+)[ \t]*/.exec(value);
    const path = m ? stripQuotes(m[1]) : undefined;
    if (!path) return [postAffiliated(k), "Missing location argument in INCLUDE keyword"] as Report;
    const sm = /::(.*)$/.exec(path);
    const file = nw(sm ? path.slice(0, sm.index) : path) ? (sm ? path.slice(0, sm.index) : path) : undefined;
    const search = file !== path && sm && nw(sm[1]) ? sm[1] : undefined;
    if (file !== undefined && urlP(file)) return undefined;
    if (file !== undefined && !remoteP(file) && !e8.fileExistsP(file)) return [postAffiliated(k), "Non-existent file argument in INCLUDE keyword"] as Report;
    if (search === undefined) return undefined;
    const visiting = file === undefined ? e8.bufferName() : e8.getFileBuffer(e8.expandFileName(file))?.name;
    const buffer = visiting ?? e8.findFileNoselect(file!);
    try {
      const found = e8.withCurrentBuffer(buffer, () =>
        e8.saveRestriction(() => {
          e8.widen();
          return e8.saveExcursion(() => !fails(() => includeSearch(search)));
        }),
      );
      return !found && ([postAffiliated(k), `Invalid search part "${search}" in INCLUDE keyword`] as Report);
    } finally {
      if (visiting === undefined) e8.call("kill-buffer", buffer);
    }
  });
}

/** Finds SEARCH as org-link-search does with org-link-search-must-match-exact-headline: a target or NAME, else a heading of that title. */
function includeSearch(search: string): boolean {
  if (/^\/.*\/$/.test(search)) return e8.reSearchForward(search.slice(1, -1), { noerror: true }) !== undefined;
  if (search.startsWith("#")) {
    const id = search.slice(1);
    return e8.reSearchForward(`^[ \t]*:CUSTOM_ID:[ \t]+${regexpQuote(id)}[ \t]*$`, { noerror: true, caseFold: true }) !== undefined;
  }
  if (!search.startsWith("*")) {
    const q = regexpQuote(search);
    e8.gotoChar(e8.pointMin());
    if (e8.reSearchForward(`<<${q}>>\\|^[ \t]*#\\+NAME:[ \t]*${q}[ \t]*$`, { noerror: true, caseFold: true }) !== undefined) return true;
  }
  searchInBuffer(search.startsWith("*") ? search : `*${search}`);
  return true;
}

function obsoleteIncludeMarkup(ast: Node): Report[] {
  const re = /^(?:".+"|\S+)[ \t]+(ASCII|BEAMER|HTML|LATEX|MA(?:N|RKDOWN)|MD|ODT|ORG|TEXINFO)/i;
  return map(ast, "keyword", (k) => {
    if (property("key", k) !== "INCLUDE") return undefined;
    const m = re.exec(String(property("value", k) ?? ""));
    return m && ([postAffiliated(k), `Obsolete markup "${m[1]}" in INCLUDE keyword.  Use "export ${m[1]}" instead`] as Report);
  });
}

/** The backends export knows, as org-export-registered-backends: those org-export-backends names, loaded. */
function registeredBackends(): typeof registered {
  const wanted = e8.variable("org-export-backends");
  for (const b of Array.isArray(wanted) ? wanted : []) {
    try {
      e8.require(`ox-${name(b)}`);
    } catch {
      // A backend that will not load is left out, as Org's require with NOERROR.
    }
  }
  return registered;
}

function unknownOptionsItem(ast: Node): Report[] {
  const allowed = [...OPTIONS.map((o) => o[2]), ...registeredBackends().flatMap((b) => (b.options ?? []).map((o) => o[2]))].filter((x) => x !== undefined);
  const reports: Report[] = [];
  map(ast, "keyword", (k) => {
    if (property("key", k) !== "OPTIONS") return undefined;
    const value = String(property("value", k) ?? "");
    let start = 0;
    const re = /(.+?):(\(.*?\)|\S+)?[ \t]*/y;
    for (;;) {
      // As string-match from START: the first match at or after it.
      let m: RegExpExecArray | null = null;
      for (let s = start; s < value.length && !m; s++) {
        re.lastIndex = s;
        m = re.exec(value);
      }
      if (!m) break;
      start = m.index + m[0].length;
      const item = m[1];
      if (!allowed.includes(item)) reports.unshift([postAffiliated(k), `Unknown OPTIONS item "${item}"`]);
      if (m[2] === undefined) reports.unshift([postAffiliated(k), `Missing value for option item ${JSON.stringify(item)}`]);
    }
    return undefined;
  });
  return reports;
}

const DEFAULT_PROPERTIES = [
  "ARCHIVE", "CATEGORY", "SUMMARY", "DESCRIPTION", "CUSTOM_ID", "LOCATION", "LOGGING", "COLUMNS", "VISIBILITY", "TABLE_EXPORT_FORMAT",
  "TABLE_EXPORT_FILE", "EXPORT_OPTIONS", "EXPORT_TEXT", "EXPORT_FILE_NAME", "EXPORT_TITLE", "EXPORT_AUTHOR", "EXPORT_DATE", "UNNUMBERED",
  "ORDERED", "NOBLOCKING", "COOKIE_DATA", "LOG_INTO_DRAWER", "REPEAT_TO_STATE", "CLOCK_MODELINE_TOTAL", "STYLE", "HTML_CONTAINER_CLASS",
  "ORG-IMAGE-ACTUAL-WIDTH",
];

function exportOptionKeywords(ast: Node): Report[] {
  const common: string[] = [];
  for (const o of OPTIONS) if (typeof o[1] === "string" && !common.includes(o[1])) common.unshift(o[1]);
  const options: string[] = [];
  const optionsAlist: [string, string[]][] = [];
  // Newest first, as org-export-registered-backends lists them.
  for (const b of [...registeredBackends()].reverse()) {
    for (const o of b.options ?? []) {
      if (typeof o[1] !== "string") continue;
      const entry = optionsAlist.find(([k]) => k === o[1]);
      const backend = b.name ?? "anonymous";
      if (entry) {
        if (!entry[1].includes(backend)) entry[1].unshift(backend);
      } else optionsAlist.unshift([o[1], [backend]]);
      if (!options.includes(o[1])) options.unshift(o[1]);
    }
  }
  optionsAlist.reverse();
  const reports: Report[] = [];
  map(ast, "node-property", (node) => {
    const prop = String(property("key", node));
    if (!(options.includes(prop) || common.includes(prop)) || DEFAULT_PROPERTIES.includes(prop)) return undefined;
    const global = common.includes(prop);
    const backends = global ? undefined : optionsAlist.find(([k]) => k.toLowerCase() === prop.toLowerCase())?.[1];
    const where = backends && backends.length > 0 ? ` in ${backends.length === 1 ? backends[0] : `(${backends.join(" ")})`} export ${backends.length > 1 ? "backends" : "backend"}` : "";
    reports.unshift([postAffiliated(node), `Potentially misspelled ${global ? "global " : "nil"}export option "${prop}"${where}.  Consider "EXPORT_${prop}".`]);
    return undefined;
  });
  return reports;
}

function invalidMacroArgumentAndTemplate(ast: Node): Report[] {
  const reports: Report[] = [];
  const placeholders = (template: string): number[] => {
    const args = new Set<number>();
    for (const m of allMatches(/\$([1-9][0-9]*)/g, template)) args.add(Number(m[1]));
    return [...args].sort((a, b) => a - b);
  };
  const checkArity = ([min, max]: [number, number], macro: Datum): void => {
    const key = String(property("key", macro));
    const pos = begin(macro);
    const args = (property("args", macro) as string[] | undefined) ?? [];
    const l = args.length;
    if (l < min - 1) reports.unshift([pos, `Missing arguments in macro ${JSON.stringify(key)}`]);
    else if (l < min) reports.unshift([pos, `Missing argument in macro ${JSON.stringify(key)}`]);
    else if (l > max + 1) reports.unshift([pos, `Spurious arguments in macro ${JSON.stringify(key)}: ${args.slice(max).map((a) => a.trim()).join(", ")}`]);
    else if (l > max) reports.unshift([pos, `Spurious argument in macro ${JSON.stringify(key)}: ${args[l - 1]}`]);
  };
  map(ast, "keyword", (k) => {
    if (property("key", k) !== "MACRO") return undefined;
    const value = String(property("value", k) ?? "");
    const m = /^\S+/m.exec(value);
    const macro = m ? m[0] : undefined;
    const template = macro !== undefined ? value.slice(m!.index + m![0].length).trim() : undefined;
    if (macro === undefined) reports.unshift([postAffiliated(k), "Missing name in MACRO keyword"]);
    // "%s" left as Org leaves it, unformatted.
    else if (!nw(template)) reports.unshift([postAffiliated(k), 'Missing template in macro "%s"']);
    else {
      const args = placeholders(template);
      const last = args[args.length - 1] ?? 0;
      if (args.length !== last || args.some((a, i) => a !== i + 1)) reports.unshift([postAffiliated(k), `Unused placeholders in macro "${macro}"`]);
    }
    return undefined;
  });
  initializeTemplates();
  const templates: [string, unknown][] = [...["author", "date", "email", "title", "results"].map((n): [string, unknown] => [n, "$1"]), ...currentTemplates()];
  map(ast, "macro", (macro) => {
    const key = String(property("key", macro));
    const template = templates.find(([n]) => n.toLowerCase() === key.toLowerCase())?.[1];
    if (template === undefined) reports.unshift([begin(macro), `Undefined macro ${JSON.stringify(key)}`]);
    else if (key === "keyword") checkArity([1, 1], macro);
    else if (key === "modification-time") checkArity([1, 2], macro);
    else if (key === "n") checkArity([0, 2], macro);
    else if (key === "property") checkArity([1, 2], macro);
    else if (key === "time") checkArity([1, 1], macro);
    // Org ignores templates that are functions, as an (eval ...) one is.
    else if (typeof template === "function" || (typeof template === "string" && /^\(eval\b/.test(template))) return undefined;
    else {
      const numbers = placeholders(String(template));
      const max = numbers.length === 0 ? 0 : Math.max(...numbers);
      checkArity([max, max], macro);
    }
    return undefined;
  });
  return reports;
}

function undefinedFootnoteReference(ast: Node): Report[] {
  const definitions = map(
    ast,
    ["footnote-definition", "footnote-reference"],
    (f) => (typeOf(f) === "footnote-definition" || property("type", f) === "inline") && (property("label", f) as string | undefined),
  );
  return map(ast, "footnote-reference", (f) => {
    const label = property("label", f) as string | undefined;
    return property("type", f) === "standard" && !definitions.includes(label!) && ([begin(f), `Missing definition for footnote [${label}]`] as Report);
  });
}

function unreferencedFootnoteDefinition(ast: Node): Report[] {
  const references = map(ast, "footnote-reference", (f) => property("label", f) as string | undefined);
  return map(ast, "footnote-definition", (f) => {
    const label = property("label", f) as string | undefined;
    return label !== undefined && !references.includes(label) && ([postAffiliated(f), `No reference for footnote definition [${label}]`] as Report);
  });
}

function mismatchedPlanningRepeaters(ast: Node): Report[] {
  return map(ast, "planning", (e) => {
    const s = property("scheduled", e) as Node | undefined;
    const d = property("deadline", e) as Node | undefined;
    if (!s || !d) return undefined;
    const st = property("repeater-type", s);
    const dt = property("repeater-type", d);
    const sv = property("repeater-value", s) as number;
    const dv = property("repeater-value", d) as number;
    const kinds = ["cumulate", "catch-up"];
    if (!kinds.includes(st) || !kinds.includes(dt) || !(sv > 0) || !(dv > 0)) return undefined;
    if (st === dt && property("repeater-unit", s) === property("repeater-unit", d) && sv === dv) return undefined;
    return [begin(e), "Different repeaters in SCHEDULED and DEADLINE timestamps."] as Report;
  });
}

const BLOCKS = ["comment-block", "example-block", "export-block", "src-block", "verse-block"];

function misplacedPlanningInfo(ast: Node): Report[] {
  const reports: Report[] = [];
  eachMatch("^[ \t]*\\(\\(?:CLOSED\\|DEADLINE\\|SCHEDULED\\):\\)", () => {
    if (!typeIn(elementAtIn(ast, e8.point()), [...BLOCKS, "planning"])) reports.unshift([e8.lineStart(e8.lineOf(e8.point())), "Misplaced planning info line"]);
  });
  return reports;
}

const DRAWER_RE = "^[\t ]*:\\([_[:word:]-]+\\):[\t ]*$";

function incompleteDrawer(ast: Node): Report[] {
  const reports: Report[] = [];
  eachMatch(DRAWER_RE, () => {
    const drawerName = (e8.matchString(0) ?? "").trim();
    const element = elementAtIn(ast, e8.point());
    switch (typeOf(element)) {
      case "drawer": {
        // Drawer opening lines within non-empty drawers.
        const end = property("contents-end", element) as number | undefined;
        if (end !== undefined)
          while (e8.reSearchForward(DRAWER_RE, { bound: end, noerror: true }) !== undefined)
            reports.unshift([e8.lineStart(e8.lineOf(e8.point())), `Possible misleading drawer entry ${JSON.stringify((e8.matchString(0) ?? "").trim())}`]);
        e8.gotoChar(endOf(element!));
        break;
      }
      case "property-drawer":
        e8.gotoChar(endOf(element!));
        break;
      case "comment-block":
      case "example-block":
      case "export-block":
      case "src-block":
      case "verse-block":
        break;
      default:
        reports.unshift([e8.lineStart(e8.lineOf(e8.point())), `Possible incomplete drawer ${JSON.stringify(drawerName)}`]);
    }
  }, false);
  return reports;
}

function indentedDiarySexp(ast: Node): Report[] {
  const reports: Report[] = [];
  eachMatch("^[ \t]+%%(", () => {
    if (!typeIn(elementAtIn(ast, e8.point()), [...BLOCKS, "diary-sexp"])) reports.unshift([e8.lineStart(e8.lineOf(e8.point())), "Possible indented diary-sexp"]);
  });
  return reports;
}

function invalidBlock(ast: Node): Report[] {
  const reports: Report[] = [];
  eachMatch("^[ \t]*#\\+\\(BEGIN\\|END\\)\\(?::\\|_[^[:space:]]*\\)?[ \t]*", () => {
    const line = e8.lineOf(e8.point());
    const blockName = e8.lineText(line).trim();
    if (/^END/i.test(e8.matchString(1) ?? "") && e8.point() !== e8.lineEnd(line)) reports.unshift([e8.lineStart(line), `Invalid block closing line "${blockName}"`]);
    else if (
      !typeIn(elementAtIn(ast, e8.point()), ["center-block", "comment-block", "dynamic-block", "example-block", "export-block", "quote-block", "special-block", "src-block", "verse-block"])
    )
      reports.unshift([e8.lineStart(line), `Possible incomplete block "${blockName}"`]);
  });
  return reports;
}

function invalidKeywordSyntax(_ast: Node): Report[] {
  const reports: Report[] = [];
  eachMatch("^[ \t]*#\\+\\([^[:space:]:]*\\)\\(?: \\|$\\)", () => {
    const keyword = e8.matchString(1) ?? "";
    const start = e8.matchBeginning(0) ?? 0;
    if (/^BEGIN/i.test(keyword) || /^END/i.test(keyword)) return;
    if (e8.lookingAt("[ \t]*#\\+\\(CAPTION\\|RESULTS\\)\\(\\[.*\\]\\)?:\\(?: \\|$\\)", e8.lineStart(e8.lineOf(start)), { caseFold: true })) return;
    reports.unshift([start, `Possible missing colon in keyword "${keyword}"`]);
  }, false);
  return reports;
}

function invalidImageAlignment(ast: Node): Report[] {
  return map(ast, "paragraph", (p) => {
    const attr = property("attr_org", p);
    const keywordString = Array.isArray(attr) ? (attr[0] as string | undefined) : undefined;
    if (keywordString === undefined) return undefined;
    const reports: Report[] = [];
    const align = /:align[\s]+(\S+)/.exec(keywordString);
    if (align && !["left", "center", "right"].includes(align[1]))
      reports.unshift([begin(p), `"${align[1]}" not a supported value for #+ATTR_ORG keyword attribute ":align".`]);
    const center = /:center[\s]+(\S+)/.exec(keywordString);
    if (center && center[1] !== "t") reports.unshift([begin(p), `"${center[1]}" not a supported value for #+ATTR_ORG keyword attribute ":center".`]);
    return reports;
  }).flat();
}

function extraneousElementInFootnoteSection(ast: Node): Report[] {
  const allowed = ["comment", "comment-block", "footnote-definition", "property-drawer", "section"];
  return map(ast, "headline", (h) => {
    if (!property("footnote-section-p", h)) return undefined;
    const extra = mapFirst(
      contents(h),
      ALL_ELEMENTS.filter((t) => !allowed.includes(t)),
      (e) => !(typeOf(e) === "headline" && property("commentedp", e)),
      { noRecursion: ["footnote-definition", "property-drawer"] },
    );
    return extra && ([begin(h), "Extraneous elements in footnote section are not exported"] as Report);
  });
}

function quoteSection(ast: Node): Report[] {
  const comment = String(e8.variable("org-comment-string") ?? "COMMENT");
  return map(ast, ["headline", "inlinetask"], (h) => {
    const title = String(property("raw-value", h) ?? "");
    return (title.startsWith("QUOTE ") || title.startsWith(`${comment} QUOTE `)) && ([begin(h), "Deprecated QUOTE section"] as Report);
  });
}

const fileApplication = (ast: Node): Report[] =>
  map(ast, "link", (l) => {
    const app = property("application", l);
    return app && ([begin(l), `Deprecated "file+${String(app)}" link type`] as Report);
  });

function percentEncodingLinkEscape(ast: Node): Report[] {
  return map(ast, "link", (l) => {
    if (property("format", l) !== "bracket") return undefined;
    const uri = String(property("path", l));
    let obsolete: boolean | undefined;
    for (const m of allMatches(/%(..)?/g, uri)) {
      if (!["25", "5B", "5D", "20"].includes(m[1] ?? "")) {
        obsolete = false;
        break;
      }
    }
    if (obsolete === undefined) obsolete = uri.includes("%");
    return obsolete && ([begin(l), "Link escaped with obsolete percent-encoding syntax"] as Report);
  });
}

/** The headers of a Babel datum as Babel reads them, from its parameters and #+HEADER: lines. */
function datumHeaders(d: Datum): Header[] {
  switch (typeOf(d)) {
    case "babel-call":
    case "inline-babel-call":
      return [...parseHeaderArguments(property("inside-header", d)), ...parseHeaderArguments(property("end-header", d))];
    case "inline-src-block":
      return parseHeaderArguments(property("parameters", d));
    case "src-block": {
      const header = property("header", d);
      return [property("parameters", d), ...(Array.isArray(header) ? header : [])].flatMap((h) => parseHeaderArguments(h));
    }
  }
  return [];
}

const position = (d: Datum): number => (property("post-affiliated", d) as number | undefined) ?? begin(d);

function wrongHeaderArgument(ast: Node): Report[] {
  const reports: Report[] = [];
  const verify = (d: Datum, language: string | undefined, headers: Header[]): void => {
    const allowed = [...HEADER_ARG_NAMES, ...(language ? [language] : loadLanguages()).flatMap((l) => (languageHeaderArgs(l) ?? []).map(([k]) => k))];
    for (const [h] of headers) {
      if (!h.startsWith(":")) reports.unshift([position(d), `Missing colon in header argument "${h}"`]);
      else if (!allowed.includes(h.slice(1))) reports.unshift([position(d), `Unknown header argument "${h}"`]);
    }
  };
  map(ast, ["babel-call", "inline-babel-call", "inline-src-block", "keyword", "node-property", "src-block"], (d) => {
    switch (typeOf(d)) {
      case "babel-call":
      case "inline-babel-call":
      case "inline-src-block":
      case "src-block":
        verify(d, typeOf(d) === "babel-call" || typeOf(d) === "inline-babel-call" ? undefined : (property("language", d) as string | undefined), datumHeaders(d));
        break;
      case "keyword": {
        if (property("key", d) !== "PROPERTY") break;
        const value = String(property("value", d) ?? "");
        const m = /^header-args(?::(\S+))?\+ */.exec(value) ?? /^header-args(?::(\S+))? */.exec(value);
        if (m) verify(d, m[1], parseHeaderArguments(value.slice(m[0].length)));
        break;
      }
      case "node-property": {
        const key = String(property("key", d));
        const m = /^HEADER-ARGS(?::(\S+))?\+/i.exec(key) ?? /^HEADER-ARGS(?::(\S+))?/i.exec(key);
        if (m) verify(d, m[1], parseHeaderArguments(property("value", d)));
        break;
      }
    }
    return undefined;
  });
  return reports;
}

function emptyHeaderArgument(ast: Node): Report[] {
  const reports: Report[] = [];
  map(ast, ["babel-call", "inline-babel-call", "inline-src-block", "src-block"], (d) => {
    for (const [h, value] of datumHeaders(d)) if (value === null) reports.unshift([position(d), `Empty value in header argument "${h}"`]);
    return undefined;
  });
  return reports;
}

function wrongHeaderValue(ast: Node): Report[] {
  const reports: Report[] = [];
  map(ast, ["babel-call", "inline-babel-call", "inline-src-block", "src-block"], (d) => {
    const language = property("language", d) as string | undefined;
    const allowedValues: [string, Allowed][] = [...((language && languageHeaderArgs(language)) || []), ...COMMON_HEADER_VALUES];
    let text: string;
    switch (typeOf(d)) {
      case "src-block": {
        const header = property("header", d);
        text = [property("parameters", d), ...(Array.isArray(header) ? header : [])].map((x) => (x === undefined ? "nil" : String(x))).join(" ");
        break;
      }
      case "inline-src-block":
        text = property("parameters", d) ?? "";
        break;
      default:
        text = `${property("inside-header", d) ?? ""} ${property("end-header", d) ?? ""}`;
    }
    for (const [h, values] of parseHeaderArguments(text.trim())) {
      const entry = allowedValues.find(([k]) => k === h.slice(1));
      const allowed = entry?.[1];
      if (!entry || allowed === undefined) continue;
      // A value written as Lisp, which Org evaluates first, is left alone: E8 has no Lisp.
      if (typeof values === "string" && lispValueP(values)) continue;
      const groups = new Map<(string | number)[], string | number | null>();
      for (const v of typeof values === "string" ? values.split(/[ \f\t\n\r\v]+/).filter(Boolean) : [values]) {
        let valid = false;
        let forbidden = false;
        for (const group of allowed) {
          const found = typeof v === "string" && group.some((g) => typeof g === "string" && g === v);
          if (!found) {
            if (group.includes(":any")) {
              valid = true;
              groups.set(group, v);
            }
          } else if (groups.has(group)) {
            reports.unshift([position(d), `Forbidden combination in header "${h}": ${princ(groups.get(group) ?? null)}, ${princ(v)}`]);
            forbidden = true;
            break;
          } else {
            groups.set(group, v);
            valid = true;
          }
        }
        if (!forbidden && !valid) reports.unshift([position(d), `Unknown value "${princ(v)}" for header "${h}"`]);
      }
    }
    return undefined;
  });
  return reports;
}

function namedResult(ast: Node): Report[] {
  return map(ast, ALL_ELEMENTS, (el) => {
    const result = property("results", el);
    const resultName = property("name", el);
    if (!result || !resultName) return undefined;
    const first = Array.isArray(result) ? result[0] : typeof result === "object" ? result.value : result;
    let origin: Datum | string | undefined;
    if (nw(first)) {
      try {
        origin = resolveLink(first, { "parse-tree": ast, "id-alist": [] });
      } catch {
        origin = undefined;
      }
    } else origin = getPreviousElement(el, {});
    return (
      typeof origin !== "string" &&
      typeOf(origin) === "src-block" &&
      ([begin(el), `Links to "${String(resultName)}" will not be valid during export unless the parent source block has :exports results or both`] as Report)
    );
  });
}

const spuriousColons = (ast: Node): Report[] =>
  map(ast, ["headline", "inlinetask"], (h) => {
    const tags = property("tags", h);
    return Array.isArray(tags) && tags.includes("") && ([begin(h), "Tags contain a spurious colon"] as Report);
  });

function nonExistentBibliography(ast: Node): Report[] {
  return map(ast, "keyword", (k) => {
    if (property("key", k) !== "BIBLIOGRAPHY") return undefined;
    const file = stripQuotes(String(property("value", k) ?? ""));
    return !remoteP(file) && !e8.fileExistsP(file) && ([begin(k), `Non-existent bibliography ${JSON.stringify(file)}`] as Report);
  });
}

function missingPrintBibliography(ast: Node): Report[] | undefined {
  if (mapFirst(ast, "citation", (c) => c) === undefined) return undefined;
  if (mapFirst(ast, "keyword", (k) => property("key", k) === "PRINT_BIBLIOGRAPHY") !== undefined) return undefined;
  return [[e8.pointMax(), 'Possibly missing "PRINT_BIBLIOGRAPHY" keyword']];
}

/** The citation processors Org ships, one of which a CITE_EXPORT keyword names, where org-cite is not there to ask. */
const SHIPPED_PROCESSORS = ["basic", "biblatex", "bibtex", "csl", "natbib"];

/** A CITE_EXPORT keyword's processor name, as org-cite-read-processor-declaration reads it, or undefined where it is not one. */
function processorName(value: string): string | undefined {
  // One to three tokens, the last two strings or words.
  const m = /^[ \t]*([^\s"()';]+)(?:[ \t]+("(?:[^"\\]|\\.)*"|\S+))?(?:[ \t]+("(?:[^"\\]|\\.)*"|\S+))?[ \t]*$/.exec(value);
  if (!m || /^[0-9]+$/.test(m[1])) return undefined;
  return m[1];
}

function invalidCiteExportDeclaration(ast: Node): Report[] {
  return map(ast, "keyword", (k) => {
    if (property("key", k) !== "CITE_EXPORT") return undefined;
    const value = String(property("value", k) ?? "");
    const source = begin(k);
    if (value === "") return [source, "Missing export processor name"] as Report;
    const processor = processorName(value);
    if (processor === undefined) return [source, "Invalid cite export processor declaration"] as Report;
    const known = e8.fboundp("org-cite-get-processor")
      ? truthy(e8.funcall("org-cite-get-processor", e8.intern(processor))) ||
        (e8.fboundp("org-cite-try-load-processor") && (e8.funcall("org-cite-try-load-processor", e8.intern(processor)), truthy(e8.funcall("org-cite-get-processor", e8.intern(processor)))))
      : SHIPPED_PROCESSORS.includes(processor);
    return !known && ([source, `Unknown cite export processor ${processor}`] as Report);
  });
}

const CITATION_PREFIX = /\[cite(?:\/([/_\p{L}\p{N}-]+))?:[\t\n ]*/u;

const incompleteCitation = (ast: Node): Report[] =>
  map(ast, "plain-text", (text, parent) => {
    if (typeof text !== "string" || !CITATION_PREFIX.test(text)) return undefined;
    const container = parent ?? parentOf(text);
    return [(property("contents-begin", container) as number | undefined) ?? 0, "Possibly incomplete citation markup"] as Report;
  });

function itemNumber(ast: Node): Report[] {
  return map(ast, "item", (item) => {
    if (property("counter", item) !== undefined) return undefined;
    const bullet = String(property("bullet", item) ?? "");
    const letter = /[A-Za-z]/.exec(bullet);
    const digits = /[0-9]+/.exec(bullet);
    const bulletNumber = letter ? letter[0].toUpperCase().charCodeAt(0) - 64 : digits ? Number(digits[0]) : undefined;
    if (bulletNumber === undefined) return undefined;
    // Its place in its list, from the nearest item before it with a counter, as org-list-get-item-number.
    const siblings = contents(parentOf(item)).filter((d) => typeOf(d) === "item");
    let seq = 0;
    let counter: number | undefined;
    for (let i = siblings.indexOf(item); i >= 0; i--) {
      counter = property("counter", siblings[i]) as number | undefined;
      if (counter !== undefined) break;
      if (i > 0) seq++;
    }
    const trueNumber = counter === undefined ? seq + 1 : counter + seq;
    return (
      bulletNumber !== trueNumber &&
      ([begin(item), `Bullet counter "${bullet}" is not the same with item position ${trueNumber}.  Consider adding manual [@${bulletNumber}] counter.`] as Report)
    );
  });
}

const latexDollar = (ast: Node): Report[] =>
  map(
    ast,
    "latex-fragment",
    (f) => /^[$][^$]/m.test(String(property("value", f))) && ([begin(f), "Potentially confusing LaTeX fragment format.  Prefer using more reliable \\(...\\)"] as Report),
  );

function latexDollarAmbiguous(ast: Node): Report[] {
  const report: Report[] = [];
  e8.saveRestriction(() => {
    e8.widen();
    eachMatch("\\$\\.[[:digit:]]", () => {
      const context = contextAtIn(ast, e8.point());
      if (typeOf(context) === "latex-fragment" || (context !== undefined && restriction(context as Node).includes("latex-fragment")))
        report.unshift([e8.point(), "$ symbol potentially matching LaTeX fragment boundary.  Consider using \\dollar entity."]);
    });
  });
  return report;
}

function timestampSyntax(ast: Node): Report[] {
  return map(ast, "timestamp", (timestamp) => {
    const expected = interpretData(timestamp);
    const actual = e8.bufferSubstringNoProperties(begin(timestamp), endOf(timestamp));
    return expected !== actual && ([begin(timestamp), `Potentially malformed timestamp ${actual}.  Parsed as: ${expected}`] as Report);
  });
}

function inactivePlanning(ast: Node): Report[] {
  return map(ast, "planning", (planning) => {
    const inactive = (ts: unknown): boolean => ["inactive", "inactive-range"].includes(property("type", ts as Node));
    if (inactive(property("scheduled", planning))) return [begin(planning), "Inactive timestamp in SCHEDULED will not appear in agenda."] as Report;
    if (inactive(property("deadline", planning))) return [begin(planning), "Inactive timestamp in DEADLINE will not appear in agenda."] as Report;
    return undefined;
  });
}

function beamerFrame(_ast: Node): Report[] {
  const env = e8.variable("org-beamer-frame-environment");
  const frame = typeof env === "string" ? env : "orgframe";
  const result: Report[] = [];
  e8.gotoChar(e8.pointMin());
  eachMatch(`\\\\\\(begin\\|end\\){${frame}}`, () => {
    result.unshift([e8.matchBeginning(0) ?? 0, "Beamer frame name may cause error when exporting.  Consider customizing `org-beamer-frame-environment'."]);
  });
  return result;
}

// ----- The checkers, as Org declares them -----

const CHECKERS: [string, string, Checker["fn"], { trust?: string; categories?: string[] }][] = [
  ["misplaced-heading", "Report accidentally misplaced heading lines.", misplacedHeading, { trust: "low" }],
  ["duplicate-custom-id", "Report duplicates CUSTOM_ID properties", duplicateCustomId, { categories: ["link"] }],
  // Org's categories are (babel 'link), whose second is a list, which no category matches.
  ["duplicate-name", "Report duplicate NAME values", duplicateName, { categories: ["babel"] }],
  ["duplicate-target", "Report duplicate targets", duplicateTarget, { categories: ["link"] }],
  ["duplicate-footnote-definition", "Report duplicate footnote definitions", duplicateFootnoteDefinition, { categories: ["footnote"] }],
  ["orphaned-affiliated-keywords", "Report orphaned affiliated keywords", orphanedAffiliatedKeywords, { trust: "low" }],
  ["combining-keywords-with-affiliated", "Report independent keywords preceding affiliated keywords.", regularKeywordBeforeAffiliated, { trust: "low" }],
  ["obsolete-affiliated-keywords", "Report obsolete affiliated keywords", obsoleteAffiliatedKeywords, { categories: ["obsolete"] }],
  ["deprecated-export-blocks", "Report deprecated export block syntax", deprecatedExportBlocks, { trust: "low", categories: ["obsolete", "export"] }],
  ["deprecated-header-syntax", "Report deprecated Babel header syntax", deprecatedHeaderSyntax, { trust: "low", categories: ["obsolete", "babel"] }],
  ["missing-language-in-src-block", "Report missing language in source blocks", missingLanguageInSrcBlock, { categories: ["babel"] }],
  ["suspicious-language-in-src-block", "Report suspicious language in source blocks", suspiciousLanguageInSrcBlock, { trust: "low", categories: ["babel"] }],
  ["missing-backend-in-export-block", "Report missing backend in export blocks", missingBackendInExportBlock, { categories: ["export"] }],
  ["invalid-babel-call-block", "Report invalid Babel call blocks", invalidBabelCallBlock, { categories: ["babel"] }],
  ["wrong-header-argument", "Report wrong babel headers", wrongHeaderArgument, { categories: ["babel"] }],
  ["wrong-header-value", "Report invalid value in babel headers", wrongHeaderValue, { categories: ["babel"], trust: "low" }],
  ["named-result", "Report results evaluation with #+name keyword.", namedResult, { categories: ["babel"], trust: "high" }],
  ["empty-header-argument", "Report empty values in babel headers", emptyHeaderArgument, { categories: ["babel"], trust: "low" }],
  ["deprecated-category-setup", "Report misuse of CATEGORY keyword", deprecatedCategorySetup, { categories: ["obsolete"] }],
  ["invalid-coderef-link", 'Report "coderef" links with unknown destination', invalidCoderefLink, { categories: ["link"] }],
  ["invalid-custom-id-link", 'Report "custom-id" links with unknown destination', invalidCustomIdLink, { categories: ["link"] }],
  ["invalid-fuzzy-link", 'Report "fuzzy" links with unknown destination', invalidFuzzyLink, { categories: ["link"] }],
  ["invalid-id-link", 'Report "id" links with unknown destination', invalidIdLink, { categories: ["link"] }],
  ["trailing-bracket-after-link", "Report potentially confused trailing ']' after link.", confusingBrackets, { categories: ["link"], trust: "low" }],
  ["unclosed-brackets-in-link-description", "Report potentially confused trailing ']' after link.", bracketsInsideDescription, { categories: ["link"], trust: "low" }],
  ["link-to-local-file", "Report links to non-existent local files", linkToLocalFile, { categories: ["link"], trust: "low" }],
  ["non-existent-setupfile-parameter", "Report SETUPFILE keywords with non-existent file parameter", nonExistentSetupfileParameter, { trust: "low" }],
  ["wrong-include-link-parameter", "Report INCLUDE keywords with misleading link parameter", wrongIncludeLinkParameter, { categories: ["export"], trust: "low" }],
  ["obsolete-include-markup", "Report obsolete markup in INCLUDE keyword", obsoleteIncludeMarkup, { categories: ["obsolete", "export"], trust: "low" }],
  ["unknown-options-item", "Report unknown items in OPTIONS keyword", unknownOptionsItem, { categories: ["export"], trust: "low" }],
  ["misspelled-export-option", "Report potentially misspelled export options in properties.", exportOptionKeywords, { categories: ["export"], trust: "low" }],
  ["invalid-macro-argument-and-template", "Report spurious macro arguments or invalid macro templates", invalidMacroArgumentAndTemplate, { categories: ["export"], trust: "low" }],
  ["special-property-in-properties-drawer", "Report special properties in properties drawers", specialPropertyInPropertiesDrawer, { categories: ["properties"] }],
  ["obsolete-properties-drawer", "Report obsolete syntax for properties drawers", obsoletePropertiesDrawer, { categories: ["obsolete", "properties"] }],
  ["invalid-effort-property", "Report invalid duration in EFFORT property", invalidEffortProperty, { categories: ["properties"] }],
  ["invalid-id-property", 'Report search string delimiter "::" in ID property', invalidIdProperty, { categories: ["properties"] }],
  ["undefined-footnote-reference", "Report missing definition for footnote references", undefinedFootnoteReference, { categories: ["footnote"] }],
  ["unreferenced-footnote-definition", "Report missing reference for footnote definitions", unreferencedFootnoteDefinition, { categories: ["footnote"] }],
  ["extraneous-element-in-footnote-section", "Report non-footnote definitions in footnote section", extraneousElementInFootnoteSection, { categories: ["footnote"] }],
  ["invalid-keyword-syntax", "Report probable invalid keywords", invalidKeywordSyntax, { trust: "low" }],
  ["invalid-image-alignment", "Report unsupported align attribute for keyword", invalidImageAlignment, { trust: "high" }],
  ["invalid-block", "Report invalid blocks", invalidBlock, { trust: "low" }],
  ["mismatched-planning-repeaters", "Report mismatched repeaters in planning info line", mismatchedPlanningRepeaters, { trust: "low" }],
  ["misplaced-planning-info", "Report misplaced planning info line", misplacedPlanningInfo, { trust: "low" }],
  ["incomplete-drawer", "Report probable incomplete drawers", incompleteDrawer, { trust: "low" }],
  ["indented-diary-sexp", "Report probable indented diary-sexps", indentedDiarySexp, { trust: "low" }],
  ["quote-section", "Report obsolete QUOTE section", quoteSection, { categories: ["obsolete"], trust: "low" }],
  ["file-application", 'Report obsolete "file+application" link', fileApplication, { categories: ["link", "obsolete"] }],
  ["percent-encoding-link-escape", "Report obsolete escape syntax in links", percentEncodingLinkEscape, { categories: ["link", "obsolete"], trust: "low" }],
  ["spurious-colons", "Report spurious colons in tags", spuriousColons, { categories: ["tags"] }],
  ["non-existent-bibliography", "Report invalid bibliography file", nonExistentBibliography, { categories: ["cite"] }],
  ["missing-print-bibliography", 'Report missing "print_bibliography" keyword', missingPrintBibliography, { categories: ["cite"] }],
  ["invalid-cite-export-declaration", 'Report invalid value for "cite_export" keyword', invalidCiteExportDeclaration, { categories: ["cite"] }],
  ["incomplete-citation", "Report incomplete citation object", incompleteCitation, { categories: ["cite"], trust: "low" }],
  ["item-number", "Report inconsistent item numbers in lists", itemNumber, { categories: ["plain-list"] }],
  ["LaTeX-$", "Report potentially confusing $...$ LaTeX markup.", latexDollar, { categories: ["markup"] }],
  // The same name again, as in Org, so this one replaces the one before.
  ["LaTeX-$", "Report $ that might be treated as LaTeX fragment boundary.", latexDollarAmbiguous, { categories: ["markup"], trust: "low" }],
  ["beamer-frame", "Report that frame text contains beamer frame environment.", beamerFrame, { categories: ["export"], trust: "low" }],
  ["timestamp-syntax", "Report malformed timestamps.", timestampSyntax, { categories: ["timestamp"], trust: "low" }],
  ["planning-inactive", "Report inactive timestamps in SCHEDULED/DEADLINE.", inactivePlanning, { categories: ["timestamp"], trust: "high" }],
];

for (const [n, summary, fn, props] of CHECKERS) addChecker(n, summary, fn, props);
