// Source blocks, after Org's ob-core.el: their header arguments, as
// org-babel-get-src-block-info gathers them from org-babel-default-header-args,
// #+PROPERTY: header-args lines, the header-args properties of the headings
// above a block, and its own #+header: and #+begin_src lines, the nearest
// winning; and running one, C-c C-c, as org-babel-execute-src-block does,
// with the function org-babel-execute:LANGUAGE names, its value put in the
// buffer under #+RESULTS:. TypeScript's is E8's own, as Emacs Lisp's is
// Emacs's in ob-emacs-lisp.el: it runs the block in the editor.

import { fileRelativeName } from "files";
import { storeLink } from "ol";
import { endOfMetaData, entryGet } from "org-list";
import { headings, keywordLines, parseHeading } from "org";
import { AFFILIATED as ANY_AFFILIATED, elementAt, endBeforeBlank, macroEscapeArguments, objectAt, parseBuffer, removeIndentation } from "org-element";
import {
  type Datum,
  begin as astBegin,
  contents as astContents,
  contentsBegin as astContentsBegin,
  contentsEnd as astContentsEnd,
  end as astEnd,
  postAffiliated as astPostAffiliated,
  postBlank as astPostBlank,
  property as astProperty,
  typeOf,
} from "org-element-ast";
import { dropMarker, lineAt, marker } from "org-macs";
import { atTable, convertRegion, parseRow } from "org-table";
import { commentRegion } from "newcomment";
import { langMode } from "org-src";
import { eraseBuffer, executableFind, truthy } from "subr";

e8.defineVariable({
  name: "org-babel-default-header-args",
  doc: "The header arguments every source block has unless it says otherwise: pairs of an argument and its value.",
  value: [
    [":session", "none"],
    [":results", "replace"],
    [":exports", "code"],
    [":cache", "no"],
    [":noweb", "no"],
    [":hlines", "no"],
    [":tangle", "no"],
  ],
});
e8.defineVariable({
  name: "org-src-preserve-indentation",
  doc: "Whether a source block's code keeps its indentation when tangled, rather than losing what all its lines share.",
  value: false,
});
e8.defineVariable({
  name: "org-confirm-babel-evaluate",
  doc:
    "Whether C-c C-c asks before running a source block: true asks, false runs it, and a function of the block's " +
    "language and code decides.",
  value: true,
});
e8.defineVariable({
  name: "org-babel-no-eval-on-ctrl-c-ctrl-c",
  doc: "Whether C-c C-c leaves source blocks alone; C-c C-v e still runs one.",
  value: false,
});
e8.defineVariable({
  name: "org-babel-min-lines-for-block-output",
  doc: "Results of this many lines or more go in an example block, fewer each after a colon.",
  value: 10,
});
e8.defineHook("org-babel-after-execute-hook", "Run after a source block has run and its results are in the buffer.");

/**
 * Header arguments by name, ":results" to "output replace". A block may
 * have several :var arguments, which are kept under ":var" one to a line,
 * as varsOf gives them back.
 */
export type Params = Map<string, string>;

/** Header arguments in the order they were written, :var as often as given, as an alist of Org's. */
export type Alist = [string, string][];

export const pairs = (v: e8.Value | undefined): [string, string][] =>
  Array.isArray(v) ? (v.filter((p) => Array.isArray(p) && p.length >= 2) as [string, string][]).map(([k, x]) => [String(k), String(x)]) : [];

/** The :var assignments in PARAMS, as org-babel--get-vars gives them, unresolved: "x=tbl". */
export const varsOf = (params: Params): string[] => {
  const v = params.get(":var");
  return v === undefined || v === "" ? [] : v.split("\n");
};

/**
 * STRING split at each place SPLIT says, outside brackets and double
 * quotes, as org-babel-balanced-split: SPLIT is given the characters
 * before and after a place. With `two`, the character before is a
 * separator too, and left out.
 */
export function balancedSplit(s: string, split: (past: string | undefined, next: string) => boolean, two = false): string[] {
  const out: string[] = [];
  let partial = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (split(i > 0 ? s[i - 1] : undefined, c)) {
      if (two) partial = partial.slice(0, -1);
      if (partial !== "") out.push(partial);
      partial = "";
      i++;
    } else if (c === "(" || c === "[") {
      // Everything to the bracket that balances it, ( and [ counted as Org counts them.
      const openings = [c];
      let j = i + 1;
      while (openings.length && j < s.length) {
        const m = /[\]()]/.exec(s.slice(j));
        if (!m) {
          j = s.length;
          break;
        }
        j += m.index + 1;
        const ch = m[0];
        if (ch === "(") openings.push(ch);
        else if (ch === "]") {
          if (openings[openings.length - 1] === "[") openings.pop();
        } else if (openings[openings.length - 1] === "(") openings.pop();
      }
      if (openings.length === 0) {
        partial += s.slice(i, j);
        i = j;
      } else {
        partial += c;
        i++;
      }
    } else if (c === '"' && (i === 0 || s[i - 1] !== "\\")) {
      const m = /[^\\]"/.exec(s.slice(i));
      if (m) {
        const j = i + m.index + 2;
        partial += s.slice(i, j);
        i = j;
      } else {
        partial += c;
        i++;
      }
    } else {
      partial += c;
      i++;
    }
  }
  if (partial !== "") out.push(partial);
  return out;
}

/** STRING without the whitespace at its end, as org-babel-chomp. */
const chomp = (s: string): string => s.replace(/[ \f\t\n\r\v]+$/, "");

/** A header argument's value as org-babel-read reads it without evaluating: a quoted string without its quotes. */
function readHeaderValue(value: string): string {
  return /^\s*"(?:[^"\\]|\\.)*"\s*$/.test(value) ? (JSON.parse(value.trim()) as string) : value;
}

/**
 * Header arguments as a line writes them, ":tangle ~/x.el :mkdirp yes", as
 * org-babel-parse-header-arguments reads them: split at a colon after a
 * blank, outside brackets and quotes, and :var's assignments each one of
 * its own, as org-babel-parse-multiple-vars splits "x=1 y=2".
 */
export function parseHeaderArgumentList(text: string | undefined): Alist {
  if (text === undefined || text.trim() === "") return [];
  // Trimmed, as Org's parser gives a block's parameters.
  const raw = balancedSplit(text.trim(), (past, next) => (past === " " || past === "\t") && next === ":", true);
  const out: Alist = [];
  raw.forEach((r, k) => {
    const arg = k === 0 ? r : `:${r}`;
    const m = /([^ \f\t\n\r\v]+)[ \f\t\n\r\v]+([^ \f\t\n\r\v]+.*)/.exec(arg);
    const key = m ? m[1] : chomp(arg);
    // Switches before the arguments, as -n, are not arguments.
    if (!key.startsWith(":")) return;
    const value = m ? readHeaderValue(chomp(m[2])) : "";
    if (key !== ":var") {
      out.push([key, value]);
      // Lisp, which Org evaluates here and E8 does not: noted, so running the block is refused.
      if (/^[(`]/.test(value)) out.push([LISP, value]);
      return;
    }
    // As org-babel-join-splits-near-ch joins "a=" and "1".
    const joined: string[] = [];
    for (const piece of balancedSplit(value, (_p, next) => next === " ")) {
      const head = joined[joined.length - 1];
      if (head !== undefined && (head.endsWith("=") || piece.startsWith("="))) joined[joined.length - 1] = head + piece;
      else joined.push(piece);
    }
    if (joined.length === 0) out.push([":var", ""]);
    for (const v of joined) out.push([":var", v.trim()]);
  });
  return out;
}

/** Where header arguments note a value written as Lisp, which running the block refuses. */
export const LISP = ":e8-lisp";

/** Header arguments as a line writes them, merged, as org-babel-parse-header-arguments and org-babel-merge-params give them. */
export function parseHeaderArguments(text: string): Params {
  return mergeParams(parseHeaderArgumentList(text));
}

/** The values of :results that exclude each other, as org-babel-common-header-args-w-values groups them. */
const RESULTS_GROUPS = [
  ["file", "list", "vector", "table", "scalar", "verbatim"],
  ["raw", "html", "latex", "org", "code", "pp", "drawer", "link", "graphics"],
  ["replace", "silent", "none", "discard", "append", "prepend"],
  ["output", "value"],
];
const EXPORTS_GROUPS = [["code", "results", "both", "none"]];

/** Words merged so each group keeps only its latest, newest first, as org-babel-merge-params merges :results. */
function mergeWords(groups: string[][], old: string[], words: string[]): string[] {
  let out = [...old];
  for (const w of words) {
    for (const g of groups) if (g.includes(w)) out = out.filter((o) => !g.includes(o));
    out.unshift(w);
  }
  return out.filter((w, k) => out.indexOf(w) === k);
}

const asAlist = (p: Params | Alist): Alist =>
  Array.isArray(p) ? p : [...p].flatMap(([k, v]): Alist => (k === ":var" ? varsOf(p).map((x): [string, string] => [":var", x]) : [[k, v]]));

/**
 * Header arguments merged, later ones winning, as org-babel-merge-params:
 * :results and :exports word by word, a later word replacing those of its
 * group, and :var by the variable's name, one without a name taking the
 * place of the variables before it in order.
 */
export function mergeParams(...all: (Params | Alist)[]): Params {
  const params: Params = new Map();
  const vars: [string, string][] = [];
  let index = 0;
  let results: string[] = [];
  let exports: string[] = [];
  for (const p of all)
    for (const [key, value] of asAlist(p)) {
      if (key === ":var") {
        const name = /^([^= \f\t\n\r\v]+)[ \t]*=/.exec(value)?.[1];
        if (name !== undefined) {
          const k = vars.findIndex(([n]) => n === name);
          if (k >= 0) vars.splice(k, 1);
          vars.push([name, value]);
        } else if (index < vars.length) {
          vars[index][1] = `${vars[index][0]}=${value}`;
          index++;
        } else e8.signal("error", `Variable "${value}" must be assigned a default value`);
      } else if (key === ":results") results = mergeWords(RESULTS_GROUPS, results, value.split(/[ \f\t\n\r\v]+/).filter((w) => w !== ""));
      else if (key === ":exports") exports = mergeWords(EXPORTS_GROUPS, exports, value.split(/[ \f\t\n\r\v]+/).filter((w) => w !== ""));
      else {
        params.delete(key);
        params.set(key, value);
      }
    }
  const out: Params = new Map([
    [":results", results.join(" ")],
    [":exports", exports.join(" ")],
  ]);
  if (vars.length) out.set(":var", vars.map(([, v]) => v).join("\n"));
  for (const [k, v] of params) out.set(k, v);
  return out;
}

const merge = mergeParams;

/** The values #+PROPERTY: lines give header-args, or header-args:LANGUAGE: the last plain one, then those with a + after it. */
function bufferHeaderArgValues(language?: string): string[] {
  let out: string[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+PROPERTY:[ \t]+header-args(?::(\S+?))?(\+)?[ \t]+(.*)$/i.exec(text);
    if (!m || m[1] !== language) continue;
    if (m[2]) out.push(m[3]);
    else out = [m[3]];
  }
  return out;
}

/** A heading's own header-args, or header-args:LANGUAGE, property: its plain value, if any, and those with a + after it. */
function headingHeaderArgValues(line: number, language?: string): { plain?: string; plus: string[] } {
  const out: { plain?: string; plus: string[] } = { plus: [] };
  let k = line + 1;
  // Past the planning line, if any, to the drawer.
  if (/^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/.test(e8.lineText(k))) k++;
  if (!/^[ \t]*:PROPERTIES:[ \t]*$/i.test(e8.lineText(k))) return out;
  for (k++; k < e8.lineCount() && !/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(k)); k++) {
    const m = /^[ \t]*:header-args(?::(\S+?))?(\+)?:[ \t]*(.*)$/i.exec(e8.lineText(k));
    if (!m || m[1] !== language) continue;
    if (m[2]) out.plus.push(m[3]);
    else out.plain = m[3];
  }
  return out;
}

/**
 * The header-args property, or header-args:LANGUAGE, a place under
 * ANCESTORS inherits, as org-entry-get with inheritance reads it: the
 * nearest heading's that has it, with what headings and lines with a +
 * add, the #+PROPERTY: lines' only when no heading above has it.
 */
function inheritedHeaderArgs(ancestors: { line: number }[], language?: string): Params {
  const parts: string[] = [];
  let stopped = false;
  for (let i = ancestors.length - 1; i >= 0 && !stopped; i--) {
    const { plain, plus } = headingHeaderArgValues(ancestors[i].line, language);
    parts.unshift(...(plain !== undefined ? [plain] : []), ...plus);
    stopped = plain !== undefined;
  }
  if (!stopped) parts.unshift(...bufferHeaderArgValues(language));
  return parseHeaderArguments(parts.join(" "));
}

/**
 * The header arguments the headings above LINE and the buffer's
 * #+PROPERTY: lines give a block of LANGUAGE there, as
 * org-babel-params-from-properties: for all languages, then for that one.
 */
function propertyParams(line: number, language: string, ancestors: { line: number }[] = ancestorsOf(headings(), line)): Params[] {
  return [inheritedHeaderArgs(ancestors), inheritedHeaderArgs(ancestors, language)];
}

/** What is run: a source block, a #+CALL: line, or an inline source block or call in a paragraph, as Org's executor types. */
export type Executor = "src-block" | "babel-call" | "inline-src-block" | "inline-babel-call";

/**
 * A source block: the lines it starts and ends on, its language, name,
 * header arguments and code. A #+CALL: line, or an inline source block or
 * call, is described the same way, as org-babel-get-src-block-info and
 * org-babel-lob-get-info describe them alike: a call by the block it runs.
 */
export interface Block {
  line: number;
  end: number;
  /** The first of the #+name: and #+header: lines above it, or its own first line. */
  first: number;
  language: string;
  name?: string;
  params: Params;
  body: string;
  /** Whether its indentation is kept, as org-src-preserve-indentation or its -i switch says. */
  preserveIndent: boolean;
  /** What it is, a source block unless it says. */
  type?: Executor;
  /** An inline one's place: where it starts, and where it ends before the blanks after it. */
  begin?: number;
  objectEnd?: number;
  /** A block's switches and header arguments as its #+begin_src line writes them. */
  switches?: string;
  parameters?: string;
  /** How its code references are written, as org-src-coderef-format gives it: -l's format, or org-coderef-label-format. */
  coderef?: string;
}

const inline = (b: Block): boolean => b.type === "inline-src-block" || b.type === "inline-babel-call";

const BEGIN = /^[ \t]*#\+begin_src(?:[ \t]+(\S+)(.*))?$/i;

/**
 * A #+begin_src line's switches and header arguments, as org-element's
 * parser splits them: only -l "FORMAT", -i, -k, -r and -n or +n with a
 * number are switches, the rest is the header arguments.
 */
export function srcLineParts(text: string): { switches: string; parameters: string } {
  const m = /^[ \t]*#\+BEGIN_SRC(?: +(\S+))?((?: +(?:-(?:l ".+"|[ikr])|[-+]n(?: *[0-9]+)?))+)?(.*)[ \t]*$/i.exec(text);
  return { switches: (m?.[2] ?? "").trim(), parameters: (m?.[3] ?? "").trim() };
}
const END = /^[ \t]*#\+end_src[ \t]*$/i;
const AFFILIATED = /^[ \t]*#\+(?:headers?|name):[ \t]*(.*)$/i;

/** A block's code: without the indentation its lines share, and Org's escaping commas, as org-babel-get-src-block-info has it. */
function blockBody(lines: string[], preserve: boolean): string {
  let out = lines;
  if (!preserve) {
    const indents = out.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
    const common = indents.length ? Math.min(...indents) : 0;
    out = out.map((l) => l.slice(Math.min(common, /^[ \t]*/.exec(l)![0].length)));
  }
  // As org-unescape-code-in-string: one comma less before * and #+ at a line's start.
  return out.map((l) => l.replace(/^([ \t]*,*),(?=\*|#\+)/, "$1")).join("\n");
}

/** Whether a heading, or one above it, is commented or archived, as org-in-commented-heading-p and org-in-archived-heading-p ask. */
function skipped(ancestors: { line: number }[]): boolean {
  return ancestors.some(({ line }) => commentedLine(line) || (parseHeading(line)?.tags.includes(String(e8.variable("org-archive-tag") ?? "ARCHIVE")) ?? false));
}

/** Whether the heading on LINE is commented: COMMENT its first word after its state and priority, as org-in-commented-heading-p reads it. */
function commentedLine(line: number): boolean {
  const h = parseHeading(line);
  return h !== undefined && /^COMMENT(?:[ \t]|$)/.test(h.title);
}

type Ancestor = { line: number; level: number };

/** The headings a line is under, outermost first. */
function ancestorsOf(all: { line: number; level: number }[], line: number): Ancestor[] {
  const ancestors: Ancestor[] = [];
  for (const h of all) {
    if (h.line > line) break;
    while (ancestors.length && ancestors[ancestors.length - 1].level >= h.level) ancestors.pop();
    ancestors.push({ line: h.line, level: h.level });
  }
  return ancestors;
}

/** The block starting on `line`, which ends on `end`, with its header arguments over `defaults`. */
function blockAt(line: number, end: number, ancestors: Ancestor[], defaults: Params): Block {
  const m = BEGIN.exec(e8.lineText(line))!;
  const language = m[1] ?? "";
  // #+header: lines just before the block add to its own arguments; #+name: names it.
  const headers: Params[] = [];
  let name: string | undefined;
  let first = line;
  for (let k = line - 1; k >= 0; k--) {
    const text = e8.lineText(k);
    // Any affiliated keyword, as #+caption:, keeps the block's own above it.
    if (!ANY_AFFILIATED.test(text)) break;
    first = k;
    const a = AFFILIATED.exec(text);
    if (!a) continue;
    if (/^[ \t]*#\+name:/i.test(text)) name ??= a[1].trim();
    else headers.unshift(parseHeaderArguments(a[1]));
  }
  const langDefaults = pairs(e8.variable(`org-babel-default-header-args:${language}`));
  // As org-babel-params-from-properties: the header-args properties,
  // inherited, then the language's, each the buffer's then the headings'.
  const { switches, parameters } = srcLineParts(e8.lineText(line));
  // The block's own line's arguments, then its #+header: lines', which win, as org-babel-get-src-block-info merges them.
  const params = merge(defaults, langDefaults, ...propertyParams(line, language, ancestors), parseHeaderArgumentList(parameters), ...headers);
  const lines: string[] = [];
  for (let k = line + 1; k < end; k++) lines.push(e8.lineText(k));
  // As org-src-preserve-indentation-p reads the -i switch.
  const preserveIndent = truthy(e8.variable("org-src-preserve-indentation")) || /(?:^|[ \t])-i(?:[ \t]|$)/.test(switches);
  const labelFmt = /-l +"([^"\n]+)"/.exec(switches)?.[1];
  return { line, end, first, language, name: name || undefined, params, body: blockBody(lines, preserveIndent), preserveIndent, switches, parameters, coderef: labelFmt ?? String(e8.variable("org-coderef-label-format") ?? "(ref:%s)") };
}

const defaultParams = (): Params => merge(pairs(e8.variable("org-babel-default-header-args")));

/**
 * The buffer's source blocks with their header arguments, in order, as
 * org-babel-map-src-blocks finds them, leaving out those under commented
 * or archived headings, as tangling does. With `targetFile`, a block
 * tangles there unless it says otherwise, as org-babel-tangle's TARGET-FILE.
 */
export function collectBlocks(targetFile?: string): Block[] {
  const all = headings();
  const blocks: Block[] = [];
  const defaults = defaultParams();
  if (targetFile !== undefined) defaults.set(":tangle", targetFile);
  // The lines the narrowing shows, as org-babel-map-src-blocks searches them.
  const last = lineAt(e8.pointMax());
  for (let line = lineAt(e8.pointMin()); line <= last && line < e8.lineCount(); line++) {
    const m = BEGIN.exec(e8.lineText(line));
    if (!m) continue;
    let end = line + 1;
    while (end < e8.lineCount() && !END.test(e8.lineText(end))) end++;
    if (end >= e8.lineCount()) break;
    const ancestors = ancestorsOf(all, line);
    if (!skipped(ancestors) && (m[1] ?? "") !== "") blocks.push(blockAt(line, end, ancestors, defaults));
    line = end;
  }
  return blocks;
}

/**
 * The source block point is in, from its #+name: or #+header: lines to its
 * #+end_src, as org-babel-get-src-block-info finds it, or undefined.
 */
export function blockAtPoint(): Block | undefined {
  let here = e8.lineOf(e8.point());
  // On the blank lines after a block, which Org counts part of it.
  if (/^[ \t]*$/.test(e8.lineText(here))) {
    let k = here;
    while (k > 0 && /^[ \t]*$/.test(e8.lineText(k))) k--;
    if (k < here && END.test(e8.lineText(k))) here = k;
    else return undefined;
  }
  // Down past the block's #+name: and #+header: lines, to its #+begin_src.
  let begin = here;
  while (begin < e8.lineCount() && AFFILIATED.test(e8.lineText(begin))) begin++;
  if (!BEGIN.test(e8.lineText(begin))) {
    // Else up to the #+begin_src of a block point is inside.
    begin = here;
    while (begin >= 0 && !BEGIN.test(e8.lineText(begin))) {
      if (END.test(e8.lineText(begin)) && begin !== here) return undefined;
      begin--;
    }
    if (begin < 0) return undefined;
  }
  let end = begin + 1;
  while (end < e8.lineCount() && !END.test(e8.lineText(end))) end++;
  if (end >= e8.lineCount() || here > end) return undefined;
  return blockAt(begin, end, ancestorsOf(headings(), begin), defaultParams());
}

// --- Running a block, as org-babel-execute-src-block -------------------------

/** What :results says, as org-babel-process-params splits it into result-params. */
const resultParams = (params: Params): string[] => (params.get(":results") ?? "").split(/[ \t]+/).filter((w) => w !== "");

const nil = (v: unknown): boolean => v === undefined || v === null || v === false;

/** A value as Lisp's format "%s" writes it into a table cell or a line. */
function cell(v: unknown): string {
  if (nil(v)) return "nil";
  if (v === true) return "t";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "function") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // A value that refers to itself.
    return String(v);
  }
}

/** Escapes lines Org would read as headings or keywords, as org-escape-code-in-region. */
const escapeCode = (line: string): string => line.replace(/^([ \t]*)(,*(?:\*|#\+))/, "$1,$2");

/** Whether a result can be written as a table, as org-babel-insert-result's tabulablep: a list of atoms and lists. */
const tabulable = (r: unknown): r is unknown[] => Array.isArray(r);

/** A table as Org writes it, before it is aligned, as orgtbl-to-orgtbl: a rule for each hline. */
const tableText = (rows: unknown[]): string =>
  (rows.every((r) => r === "hline" || Array.isArray(r)) ? rows : [rows]).map((r) => (r === "hline" ? "|-\n" : `| ${(r as unknown[]).map(cell).join(" | ")} |\n`)).join("");

/**
 * The text of a result, as org-babel-insert-result writes it for a block:
 * a list as a table, or as a plain list with :results list; a scalar
 * after colons, or in an example block from
 * org-babel-min-lines-for-block-output lines on, or as :wrap, drawer,
 * html, latex, org or code say; raw as it is; nothing for nil. Inline,
 * as the {{{results(...)}}} macro holds it. Each line of a block's ends
 * in a newline; `table` says whether to align it as a table.
 */
/**
 * A result that names a file as a link to it, as org-babel-result-to-file
 * makes one: relative to the Org file when the block ran in another
 * directory, with :file-desc's description, or the name itself for
 * :file-desc with no value.
 */
function resultToFile(result: string, params: Params): string {
  let path = result;
  const own = e8.bufferFileName();
  const dir = own !== undefined ? e8.fileNameDirectory(own) : undefined;
  if (own !== undefined && dir && e8.expandFileName(String(e8.variable("default-directory") ?? "")) !== e8.expandFileName(dir)) {
    const full = e8.expandFileName(result);
    const type = e8.variable("org-link-file-path-type") ?? "adaptive";
    path = (typeof type === "symbol" ? Symbol.keyFor(type) : String(type)) === "adaptive" ? fileRelativeName(full, dir) : full;
  }
  const desc = params.has(":file-desc") ? params.get(":file-desc") || result : undefined;
  return `[[file:${path}]${desc !== undefined ? `[${desc}]` : ""}]`;
}

function resultText(value: unknown, rp: string[], params: Params, isInline: boolean, lang: string): { text: string; table: boolean } {
  let result: unknown = value;
  if (typeof result === "string" && rp.includes("file")) result = resultToFile(result, params);
  else if (Array.isArray(result) && result.length === 0) result = null;
  else if (!nil(result) && typeof result !== "string" && !Array.isArray(result)) result = typeof result === "number" ? String(result) : cell(result);
  if (nil(result)) result = null;
  if (typeof result === "string" && !isInline && result.trim() !== "" && !result.endsWith("\n")) result += "\n";
  let body: string;
  let table = false;
  if (result === null) body = "";
  else if (rp.includes("list")) {
    const items = Array.isArray(result) ? result : (result as string).split("\n").filter((l) => l !== "");
    body = `${items.map((e) => `- ${Array.isArray(e) ? cell(e[0]) : cell(e)}`).join("\n")}\n`;
  } else if (tabulable(result)) {
    body = tableText(result);
    table = true;
  } else if (rp.includes("file")) body = result as string;
  else if (isInline && !rp.includes("raw")) body = macroEscapeArguments((result as string).replace(/\n+$/, ""));
  else body = result as string;
  // Wrapped as org-babel-insert-result's wrap: lines escaped unless a block holds Org.
  const wrap = (start: string, finish: string, noEscape: boolean, inlineStart: string, inlineFinish: string): string =>
    isInline ? `${inlineStart}${body}${inlineFinish}` : `${start}\n${noEscape ? body : escapeCodeIn(body)}${finish}\n`;
  const switches = params.get(":results_switches") ? ` ${params.get(":results_switches")}` : "";
  if (params.has(":wrap")) {
    const full = params.get(":wrap") || "results";
    const split = full.split(/[ \t\n]+/).filter((w) => w !== "");
    const type = split[0];
    const open = `#+begin_${full}`;
    const close = `#+end_${type}`;
    if (/^export$/i.test(type)) return { text: wrap(open, close, false, `{{{results(@@${split[1] ?? "none"}:`, "@@)}}}"), table: false };
    if (/^example$/i.test(type)) return { text: wrap(open, close, false, "{{{results(=", "=)}}}"), table: false };
    if (/^src$/i.test(type)) {
      const inlineOpen = split.length === 1 ? "{{{results(src_none{" : split.length === 2 ? `{{{results(src_${split[1]}{` : `{{{results(src_${split[1]}[${split.slice(2).join(" ")}]{`;
      return { text: wrap(open, close, false, inlineOpen, "})}}}"), table: false };
    }
    return { text: wrap(open, close, true, "{{{results(", ")}}}"), table };
  }
  if (rp.includes("html")) return { text: wrap("#+begin_export html", "#+end_export", false, "{{{results(@@html:", "@@)}}}"), table: false };
  if (rp.includes("latex")) return { text: wrap("#+begin_export latex", "#+end_export", false, "{{{results(@@latex:", "@@)}}}"), table: false };
  if (rp.includes("org")) return { text: wrap("#+begin_src org", "#+end_src", false, "{{{results(src_org{", "})}}}"), table: false };
  if (rp.includes("code"))
    return { text: wrap(`#+begin_src ${lang || "none"}${switches}`, "#+end_src", false, `{{{results(src_${lang || "none"}[${switches}]{`, "})}}}"), table: false };
  if (rp.includes("raw")) return { text: body, table: /^[ \t]*\|/.test(body) };
  if (rp.includes("drawer") || rp.includes("wrap")) return { text: wrap(":results:", ":end:", true, "{{{results(", ")}}}"), table: /^[ \t]*\|/.test(body) };
  if (isInline && rp.includes("file")) return { text: wrap("", "", true, "{{{results(", ")}}}"), table: false };
  if (!tabulable(result) && result !== null && !rp.includes("file")) {
    // As org-babel-examplify-region.
    if (isInline) return { text: `{{{results(${String(e8.variable("org-babel-inline-result-wrap") ?? "=%s=").split("%s").join(body)})}}}`, table: false };
    const lines = body === "" ? [] : body.replace(/\n$/, "").split("\n");
    if (lines.length === 0) return { text: "", table: false };
    const min = Number(e8.variable("org-babel-min-lines-for-block-output") ?? 10);
    if (lines.length < min) return { text: lines.map((l) => `: ${l}\n`).join(""), table: false };
    const example = truthy(e8.variable("org-babel-uppercase-example-markers") ?? null) ? ["#+BEGIN_EXAMPLE", "#+END_EXAMPLE"] : ["#+begin_example", "#+end_example"];
    return { text: `${example[0]}${switches}\n${lines.map((l) => `${escapeCode(l)}\n`).join("")}${example[1]}\n`, table: false };
  }
  return { text: body, table };
}

/** Each line of TEXT escaped, as org-escape-code-in-region. */
const escapeCodeIn = (text: string): string => text.split("\n").map(escapeCode).join("\n");

const RESULTS = /^[ \t]*#\+results(?:\[[^\]\n]*\])?:[ \t]*(.*?)[ \t]*$/i;

/**
 * The line of the block's #+RESULTS:, as org-babel-where-is-src-block-result
 * finds it, or undefined: a named block's anywhere by its name, else the
 * unnamed one just after the block.
 */
export function resultsLine(block: Block): number | undefined {
  if (block.name !== undefined) {
    for (let k = 0; k < e8.lineCount(); k++) {
      const m = RESULTS.exec(e8.lineText(k));
      if (m && m[1] === block.name) return k;
    }
    return undefined;
  }
  let k = block.end + 1;
  while (k < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(k))) k++;
  const m = k < e8.lineCount() ? RESULTS.exec(e8.lineText(k)) : null;
  return m && m[1] === "" ? k : undefined;
}

const HEADING = /^\*+[ \t]/;

/** The elements a result can be, as org-babel-result-end knows them. */
const RESULT_TYPES = ["drawer", "example-block", "export-block", "fixed-width", "special-block", "src-block", "item", "plain-list", "table", "latex-environment"];

/**
 * The line after the result under a #+RESULTS: line, as org-babel-result-end
 * finds it: nothing on a blank line, a link's line, or the element there
 * that a result can be, a block, a drawer, fixed-width lines, a list or a
 * table, to its end before the blank lines after it. Anything else is no
 * result, so nothing is taken.
 */
export function resultEnd(line: number): number {
  const k = line + 1;
  if (k >= e8.lineCount()) return k;
  const text = e8.lineText(k);
  if (/^[ \t]*$/.test(text)) return k;
  if (/^[ \t]*\[\[(?:[^\][\\]|\\.)+\](?:\[[^\n]*?\])?\][ \t]*$/.test(text)) return k + 1;
  const e = elementAt(e8.lineStart(k));
  if (e !== undefined && RESULT_TYPES.includes(e.type)) return lineAt(endBeforeBlank(e)) + 1;
  return k;
}

/** The position a line starts at, or the buffer's end, after a newline put there, past the last line. */
function lineStartOrEnd(line: number): number {
  if (line < e8.lineCount()) return e8.lineStart(line);
  const end = e8.pointMax();
  if (end > e8.pointMin() && e8.charBefore(end) !== "\n") {
    e8.gotoChar(end);
    e8.insert("\n");
  }
  return e8.pointMax();
}

const indentationOf = (line: number): string => /^[ \t]*/.exec(e8.lineText(line))![0];

/**
 * Puts a result in the buffer under the block, as org-babel-insert-result:
 * in place of the one there, or after it with :results append, before it
 * with prepend; else under a new #+RESULTS: line after the block, followed
 * by a blank line unless one or the buffer's end follows already. The
 * keyword and result are indented as the block is, as in a list item.
 */
function insertResult(block: Block, result: unknown, rp: string[]): void {
  if (inline(block)) {
    insertInlineResult(block, result, rp);
    return;
  }
  const { text, table } = resultText(result, rp, block.params, false, block.language);
  const back = marker(e8.point());
  try {
    let at: number;
    let indent: string;
    const existing = resultsLine(block);
    if (existing !== undefined) {
      indent = indentationOf(existing);
      const start = lineStartOrEnd(existing + 1);
      const end = lineStartOrEnd(resultEnd(existing));
      if (rp.includes("replace")) {
        e8.deleteRegion(start, end);
        at = start;
      } else at = rp.includes("append") ? end : start;
    } else {
      indent = indentationOf(block.line);
      const after = lineStartOrEnd(block.end + 1);
      e8.gotoChar(after);
      e8.insert(`\n${indent}#+RESULTS:${block.name !== undefined ? ` ${block.name}` : ""}\n`);
      at = e8.point();
      if (at < e8.pointMax() && !/^[ \t]*$/.test(e8.lineText(e8.lineOf(at)))) {
        e8.insert("\n");
      }
    }
    e8.gotoChar(at);
    e8.insert(text.replace(/^(?=.)/gm, indent));
    if (table) {
      e8.gotoChar(at);
      e8.call("org-table-align");
    }
  } finally {
    e8.gotoChar(back.pos);
    dropMarker(back);
  }
}

/**
 * Where an inline source block's or call's result is, as
 * org-babel-where-is-src-block-result finds it: a {{{results(...)}}}
 * macro after it in its paragraph, past blanks. Its start and end, or
 * undefined.
 */
export function inlineResultAt(objectEnd: number): [number, number] | undefined {
  // Past blanks, but not a blank line, which ends the paragraph.
  let p = objectEnd;
  let newlines = 0;
  for (; p < e8.pointMax(); p++) {
    const c = e8.bufferText(p, p + 1);
    if (c === "\n") newlines++;
    else if (c !== " " && c !== "\t") break;
  }
  if (newlines > 1 || p >= e8.pointMax()) return undefined;
  const o = objectAt(p);
  if (typeOf(o) !== "macro" || astProperty("key", o) !== "results") return undefined;
  return [p, astEnd(o)! - astPostBlank(o)];
}

/**
 * Puts an inline source block's or call's result after it, as
 * org-babel-insert-result: in a {{{results(...)}}} macro, in place of the
 * one there, or after a space. A table, a list, a drawer or a result of
 * several lines cannot be inline.
 */
function insertInlineResult(block: Block, value: unknown, rp: string[]): void {
  const warning =
    (rp.includes("table") && "`:results table'") ||
    (rp.includes("drawer") && "`:results drawer'") ||
    (Array.isArray(value) && value.length > 0 && "list result") ||
    (typeof value === "string" && /\n./.test(value) && "multiline result") ||
    (rp.includes("list") && "`:results list'");
  if (warning) e8.userError(`Inline error: ${warning} cannot be used`);
  const { text, table } = resultText(value, rp, block.params, true, block.language);
  e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      const existing = inlineResultAt(block.objectEnd!);
      let at: number;
      if (existing) {
        e8.deleteRegion(existing[0], existing[1]);
        at = existing[0];
      } else {
        e8.gotoChar(block.objectEnd!);
        e8.insert(" ");
        at = e8.point();
      }
      e8.gotoChar(at);
      e8.insert(text);
      if (table) {
        e8.gotoChar(at);
        if (atTable()) e8.call("org-table-align");
      }
    }),
  );
}

/** Whether the block may run at all, as org-babel-check-evaluate: not with :eval no or never, nor no-export or never-export while exporting. */
function checkEvaluate(block: Block): boolean {
  const named = block.name !== undefined ? ` (${block.name}) ` : " ";
  const evalArg = block.params.get(":eval") ?? (block.params.has(":noeval") ? "no" : undefined);
  // While exporting, as org-babel-check-confirm-evaluate tells by the export's backend, never-export and no-export are never too.
  const exporting = truthy(e8.variable("org-export-current-backend"));
  if (evalArg === "no" || evalArg === "never" || (exporting && (evalArg === "no-export" || evalArg === "never-export"))) {
    e8.message(`Evaluation of this ${block.language} code block${named}is disabled.`);
    return false;
  }
  return true;
}

/** Whether the block may run, asking when org-confirm-babel-evaluate says to, as org-babel-confirm-evaluate. */
function confirmEvaluate(block: Block): boolean {
  const named = block.name !== undefined ? ` (${block.name}) ` : " ";
  const evalArg = block.params.get(":eval") ?? (block.params.has(":noeval") ? "no" : undefined);
  const exporting = truthy(e8.variable("org-export-current-backend"));
  const confirm = e8.variable("org-confirm-babel-evaluate");
  const query =
    evalArg === "query" ||
    (exporting && evalArg === "query-export") ||
    (typeof confirm === "function" || (typeof confirm === "string" && e8.fboundp(confirm))
      ? truthy(e8.funcall(confirm as string, block.language, block.body))
      : truthy(confirm));
  if (!query) return true;
  if (e8.yesOrNoP(`Evaluate this ${block.language} code block${named}on your system? `)) return true;
  e8.message(`Evaluation of this ${block.language} code block${named}is aborted.`);
  return false;
}

/**
 * Runs the source block point is in with the org-babel-execute: function
 * of its language, and puts its value under it, as
 * org-babel-execute-src-block does, after asking as
 * org-confirm-babel-evaluate says. Returns the value.
 */
/** CODE without its code references, written as FMT says, and the blanks before them, as org-src-coderef-regexp finds them. */
export function removeCoderefs(code: string, fmt: string): string {
  const label = "([-a-zA-Z0-9_][-a-zA-Z0-9_ ]*)";
  const re = new RegExp(`([ \\t]*(${fmt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split("%s").join(label)})[ \\t]*)$`, "gm");
  return code.replace(re, "");
}

export function executeSrcBlock(given = blockAtPoint(), extra?: Params | Alist): unknown {
  if (given === undefined) e8.userError("Not in a source block");
  // Header arguments given by the caller merged in, as PARAMS.
  const block = extra === undefined ? given : { ...given, params: merge(given.params, extra) };
  // Lisp in its header arguments, which Org evaluates as it reads them, refused before anything runs.
  const lisp = block.params.get(LISP);
  if (lisp !== undefined) e8.userError(`${lisp} is Lisp, which E8 does not evaluate`);
  if (!checkEvaluate(block)) return undefined;
  // Its variables resolved, which may run other blocks, before it is confirmed, as org-babel-process-params.
  const processed = processParams(block.params);
  // Its noweb references expanded, as :noweb allows when evaluating, the confirmation seeing them.
  const nowebbed = nowebP(block.params, ":eval") ? expandNowebReferences(block) : block.body;
  // Its code references taken out, as org-babel--expand-body does.
  const expanded = { ...block, body: block.coderef !== undefined ? removeCoderefs(nowebbed, block.coderef) : nowebbed };
  if (!confirmEvaluate(expanded)) return undefined;
  const fn = `org-babel-execute:${block.language}`;
  if (!e8.fboundp(fn)) e8.signal("error", `No org-babel-execute function for ${block.language}!`);
  const rp = resultParams(block.params);
  const kind = { "src-block": "code block", "babel-call": "call", "inline-src-block": "inline code block", "inline-babel-call": "inline call" }[block.type ?? "src-block"];
  const where = block.begin ?? e8.lineStart(block.line);
  const at = block.name !== undefined ? `(${block.name})` : `at position ${where + 1}`;
  e8.message(`Executing ${block.language.charAt(0).toUpperCase()}${block.language.slice(1).toLowerCase()} ${kind} ${at}...`);
  const started = Date.now();
  const body = expanded.body;
  // In :dir, made first with :mkdirp, as default-directory.
  const dir = block.params.get(":dir");
  let directory: string | undefined;
  if (dir !== undefined && dir !== "") {
    directory = e8.fileNameAsDirectory(e8.expandFileName(dir));
    const mkdirp = block.params.get(":mkdirp");
    if (mkdirp !== undefined && mkdirp !== "" && mkdirp !== "no" && mkdirp !== "nil") e8.makeDirectory(directory, { parents: true });
  }
  const run = (): unknown => e8.saveExcursion(() => e8.funcall(fn, body, processed as unknown as e8.Value)) as unknown;
  let result = directory === undefined ? run() : e8.letBind({ "default-directory": directory }, run);
  if (Array.isArray(result) && result.length === 0) result = null;
  if (assq(processed, ":result-type") === "value" && (rp.includes("table") || rp.includes("vector")) && !Array.isArray(result) && !nil(result)) result = [[result]];
  if (rp.includes("silent")) {
    e8.message(e8.prin1ToString((Array.isArray(result) ? result : cell(result)) as e8.Value));
  } else if (!rp.includes("none")) {
    insertResult(block, result, rp);
    const seconds = (Date.now() - started) / 1000;
    const took = seconds > 0.05 ? ` (took ${seconds.toFixed(1)}s)` : "";
    if (nil(result)) e8.message(rp.includes("value") ? `Code block returned no value${took}.` : `Code block produced no output${took}.`);
    else e8.message(`Code block evaluation complete${took}.`);
  }
  e8.runHooks("org-babel-after-execute-hook");
  return result;
}

e8.defineCommand({
  name: "org-babel-execute-src-block",
  doc: "Run the source block point is in and put its value under it, after #+RESULTS:.",
  run: () => {
    executeSrcBlock();
  },
});

/**
 * Runs the source block, #+CALL: line, or inline source block or call
 * point is on, as org-babel-execute-maybe does, its error output's buffer
 * emptied first. Whether there was one.
 */
export function executeMaybe_(): boolean {
  const block = blockAtPoint() ?? inlineAtPoint("inline-src-block");
  if (block !== undefined) {
    wipeErrorBuffer();
    executeSrcBlock(block);
    return true;
  }
  const call = callAtPoint() ?? inlineAtPoint("inline-babel-call");
  if (call === undefined) return false;
  executeSrcBlock(call);
  return true;
}

const executeMaybe = e8.defineCommand({
  name: "org-babel-execute-maybe",
  doc: "Run the source block or call point is in, if it is in one.",
  run: () => {
    executeMaybe_();
  },
});

e8.defineCommand({
  name: "org-babel-lob-execute-maybe",
  doc: "Run the #+CALL: line or inline call point is on, if it is on one.",
  run: () => {
    const call = callAtPoint() ?? inlineAtPoint("inline-babel-call");
    if (call !== undefined) executeSrcBlock(call);
  },
});

// As org-ctrl-c-ctrl-c runs them: C-c C-c in a block, on a #+CALL: line, or on an inline block or call.
e8.addHook("org-ctrl-c-ctrl-c-hook", () => {
  if (truthy(e8.variable("org-babel-no-eval-on-ctrl-c-ctrl-c"))) return false;
  return executeMaybe_();
});

// --- Header arguments as a language gets them, as org-babel-process-params ---

/**
 * Header arguments as they reach a language's org-babel-execute: function,
 * as org-babel-process-params makes them: an alist, each :var a pair of
 * the variable's name and its value, with :result-params, :result-type,
 * :colname-names and :rowname-names worked out. A table is a list of rows,
 * each a list of cells or "hline".
 */
export type Processed = [string, e8.Value][];

/** A header argument's value in processed PARAMS, as (cdr (assq KEY params)). */
export const assq = (params: Processed | e8.Value, key: string): e8.Value | undefined => {
  if (!Array.isArray(params)) return undefined;
  const found = (params as e8.Value[]).find((p) => Array.isArray(p) && p[0] === key) as e8.Value[] | undefined;
  return found === undefined ? undefined : found[1];
};

/** The variables in processed PARAMS, each its name and value, as org-babel--get-vars. */
export const getVars = (params: Processed | e8.Value): [string, e8.Value][] =>
  Array.isArray(params) ? ((params as e8.Value[]).filter((p) => Array.isArray(p) && p[0] === ":var").map((p) => (p as e8.Value[])[1]) as [string, e8.Value][]) : [];

const nilString = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v);

/**
 * Variables taken apart as org-babel-disassemble-tables: a table's column
 * names off, as :colnames says or as a rule under its first row has them,
 * its row names off with :rownames, and its rules gone unless :hlines yes.
 */
function disassembleTables(vars: [string, e8.Value][], hlines?: string, colnames?: string, rownames?: string): [[string, e8.Value][], [string, e8.Value][], [string, e8.Value][]] {
  const cnames: [string, e8.Value][] = [];
  const rnames: [string, e8.Value][] = [];
  const out = vars.map(([name, value0]): [string, e8.Value] => {
    let value = value0;
    if (!Array.isArray(value)) return [name, value];
    const t = value as e8.Value[];
    if (colnames !== "no" && (colnames !== undefined || (t.length > 1 && t[0] !== "hline" && t[1] === "hline" && !t.slice(2).includes("hline")))) {
      let rows = t;
      while (rows[0] === "hline") rows = rows.slice(1);
      cnames.push([name, rows[0] ?? null]);
      value = rows[1] === "hline" ? rows.slice(2) : rows.slice(1);
    }
    if (rownames !== undefined && rownames !== "no") {
      const rows = (value as e8.Value[]).filter((r) => r !== "hline");
      rnames.push([name, rows.map((r) => (Array.isArray(r) ? (r[0] ?? null) : null))]);
      value = rows.map((r) => (Array.isArray(r) ? r.slice(1) : r));
    }
    if (hlines !== undefined && hlines !== "yes") value = (value as e8.Value[]).filter((r) => r !== "hline");
    return [name, value];
  });
  return [out, cnames, rnames];
}

/** Names picked for a table, as org-babel-pick-name: SELECTOR's list itself, the variable's of that number, or the last variable's. */
export function pickName(names: e8.Value | undefined, selector: e8.Value | undefined): e8.Value | undefined {
  if (selector === undefined || selector === null || selector === "" || Array.isArray(selector)) return Array.isArray(selector) ? selector : undefined;
  if (!Array.isArray(names) || names.length === 0) return undefined;
  const list = names as [string, e8.Value][];
  if (typeof selector === "number" || /^-?\d+$/.test(String(selector))) return list[Number(selector) - 1]?.[1];
  return list[list.length - 1][1];
}

/** A table with its column and row names put back, as org-babel-reassemble-table. */
export function reassembleTable(table: e8.Value, colnames: e8.Value | undefined, rownames: e8.Value | undefined): e8.Value {
  if (!Array.isArray(table)) return table;
  let t = table as e8.Value[];
  if (Array.isArray(rownames) && rownames.length > 0 && t.length === rownames.length) {
    const names = [...(rownames as e8.Value[])];
    t = t.map((row) => (Array.isArray(row) ? [names.shift() ?? "", ...row] : row));
  }
  if (Array.isArray(colnames) && colnames.length > 0 && Array.isArray(t[0]) && (t[0] as e8.Value[]).length === colnames.length) t = [colnames, "hline", ...t];
  return t;
}

/** The header arguments a block runs with, its variables resolved, as org-babel-process-params. */
export function processParams(params: Params): Processed {
  const vars = varsOf(params).map(refParse);
  const [dvars, cnames, rnames] = disassembleTables(vars, nilString(params.get(":hlines")), nilString(params.get(":colnames")), nilString(params.get(":rownames")));
  const rp = resultParams(params).filter((w, k, all) => all.indexOf(w) === k);
  const rest = [...params].filter(([k]) => ![":var", ":colname-names", ":rowname-names", ":result-params", ":result-type"].includes(k));
  return [
    ...dvars.map((v): [string, e8.Value] => [":var", v]),
    [":colname-names", cnames],
    [":rowname-names", rnames],
    [":result-params", rp],
    [":result-type", rp.includes("output") ? "output" : "value"],
    ...rest.map(([k, v]): [string, e8.Value] => [k, header(k, v)]),
  ];
}

/** A header argument's value as a language reads it: :colnames and :rownames as a list when written as one. */
function header(key: string, value: string): e8.Value {
  if ((key === ":colnames" || key === ":rownames") && /^'\(/.test(value)) return lispData(value);
  return value;
}

/**
 * A block's code with its :prologue, the lines VARLINES assigning its
 * variables, and its :epilogue, as org-babel-expand-body:generic.
 */
export function expandBodyGeneric(body: string, params: Processed | e8.Value, varLines: string[] = []): string {
  const pro = assq(params, ":prologue");
  const epi = assq(params, ":epilogue");
  return [...(pro !== undefined && pro !== null ? [String(pro)] : []), ...varLines, body, ...(epi !== undefined && epi !== null ? [String(epi)] : [])].join("\n");
}

/**
 * A program's output as RESULT-PARAMS want it, as org-babel-result-cond:
 * nothing with discard; the text itself when they want it whole (scalar,
 * verbatim, html, code, pp, file, or output, raw, org or drawer without
 * table); else TABLE's reading of it.
 */
export function resultCond(rp: e8.Value | undefined, scalar: string, table: () => e8.Value): e8.Value {
  const p = Array.isArray(rp) ? (rp as string[]) : [];
  if (p.includes("discard")) return null;
  const whole = ["scalar", "verbatim", "html", "code", "pp", "file"].some((w) => p.includes(w)) || (["output", "raw", "org", "drawer"].some((w) => p.includes(w)) && !p.includes("table"));
  return whole ? scalar : table();
}

// --- Reading values, as org-babel-read ---------------------------------------

/**
 * A number written as STRING, as org-babel--string-to-number reads one,
 * or undefined: a whole number, or a float, which a whole float keeps
 * written as Lisp prints it, "2.0".
 */
export function stringToNumber(s: string): number | string | undefined {
  const t = s.trim();
  if (/\s/.test(t) || !/^[0-9e.+ -]+$/.test(s)) return undefined;
  if (/^[+-]?\d+\.?$/.test(t)) return Number(t.replace(/\.$/, ""));
  if (/^[+-]?(?:\d+\.\d+|\.\d+|\d+(?:\.\d*)?e[+-]?\d+|\.\d+e[+-]?\d+)$/.test(t)) {
    const n = Number(t);
    if (!Number.isFinite(n)) return undefined;
    return Number.isInteger(n) ? (Math.abs(n) >= 1e21 ? String(n) : `${n}.0`) : n;
  }
  return undefined;
}

/** Lisp data as written, read without evaluating, as data a quote or a vector gives; other Lisp is an error, as E8 evaluates none. */
function lispData(text: string): e8.Value {
  const t = text.trim();
  // A vector is itself, which Babel's values, lists and atoms, can only hold as it prints: "[1 2]".
  if (t.startsWith("[")) {
    const [datum] = e8.readFromString(t);
    return `[${(Array.isArray(datum) ? datum : []).map((x) => e8.prin1ToString(x)).join(" ")}]`;
  }
  if (t.startsWith("'")) {
    let [datum] = e8.readFromString(t);
    if (Array.isArray(datum) && datum.length === 2 && typeof datum[0] === "symbol" && Symbol.keyFor(datum[0] as symbol) === "quote") datum = datum[1];
    return plain(datum);
  }
  return e8.userError(`${t} is Lisp, which E8 does not evaluate`);
}

/** Lisp data as Babel's values: symbols as their names, nil as nothing. */
function plain(v: e8.Value): e8.Value {
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "symbol") return Symbol.keyFor(v) ?? v.description ?? "";
  return v;
}

/**
 * A cell or a value as org-babel-read reads it: a number as a number, a
 * quoted string as the string, Lisp data unless `inhibitLisp`, else the
 * text as it is.
 */
export function babelRead(cell: string, inhibitLisp = false): e8.Value {
  if (cell.trim() === "") return cell;
  const n = stringToNumber(cell);
  if (n !== undefined) return n;
  if (!inhibitLisp && /^[('`[]/.test(cell)) return lispData(cell);
  if (/^\s*"[\s\S]*"\s*$/.test(cell)) {
    try {
      const [v, end] = e8.readFromString(cell);
      if (typeof v === "string" && cell.slice(end).trim() === "") return v;
    } catch {
      // Not one string.
    }
  }
  return cell;
}

/** A cell without the quotes around it, read, as org-babel-string-read. */
const stringRead = (cell: string): e8.Value => babelRead(/^\s*"(.+)"\s*$/.exec(cell)?.[1] ?? cell, true);

/**
 * Output read as a table, as org-babel-import-elisp-from-file reads it:
 * split into fields as org-table-convert-region guesses, each read as a
 * number or a string; a table of one cell is that cell, and nothing is
 * nil.
 */
export function importTable(text: string): e8.Value {
  if (text === "") return null;
  const buffer = e8.generateNewBufferName(" *org-babel-import*");
  e8.getBufferCreate(buffer);
  let rows: e8.Value[];
  try {
    rows = e8.withCurrentBuffer(buffer, () => {
      e8.insert(text);
      convertRegion(e8.pointMin(), e8.pointMax(), "babel-auto");
      const out: e8.Value[] = [];
      for (let l = 0; l < e8.lineCount(); l++) {
        const t = e8.lineText(l);
        if (!/^[ \t]*\|/.test(t)) continue;
        const row = parseRow(t);
        if (row !== "hline") out.push(row.map(stringRead));
      }
      return out;
    });
  } finally {
    e8.call("kill-buffer", buffer);
  }
  if (rows.length === 0) return null;
  if (rows.length === 1 && (rows[0] as e8.Value[]).length === 1) return (rows[0] as e8.Value[])[0];
  return rows;
}

// --- References, as ob-ref.el ------------------------------------------------

e8.defineVariable({ name: "org-babel-update-intermediate", doc: "Whether blocks run to resolve references put their results in the buffer too.", value: false });

/** The buffer references are looked up in while exporting, a copy of the document as it was, as org-babel-exp-reference-buffer. */
let referenceBuffer: string | undefined;

/** Runs BODY with references looked up in BUFFER, as ob-exp binds org-babel-exp-reference-buffer. */
export function withReferenceBuffer<T>(buffer: string | undefined, body: () => T): T {
  const old = referenceBuffer;
  referenceBuffer = buffer;
  try {
    return body();
  } finally {
    referenceBuffer = old;
  }
}

/** Runs BODY in the buffer references are looked up in, widened, with point kept. */
function inReferenceBuffer<T>(body: () => T): T {
  const run = () => e8.saveExcursion(() => e8.saveRestriction(() => (e8.widen(), body())));
  return referenceBuffer !== undefined && e8.bufferLiveP(e8.getBuffer(referenceBuffer)) ? e8.withCurrentBuffer(referenceBuffer, run) : run();
}

/** A :var assignment, "x=tbl", as its name and value, as org-babel-ref-parse: a literal read, else a reference resolved. */
export function refParse(assignment: string): [string, e8.Value] {
  const m = /^(.+?)=/.exec(assignment);
  if (!m) e8.signal("error", `Variable "${assignment}" must be assigned a default value`);
  const name = m[1].trim();
  const ref = assignment.slice(m[0].length).trim();
  const out = babelRead(ref);
  // Lisp data is its value even when it reads as its own text, as a vector does.
  if (out !== ref || /^[('`[]/.test(ref)) return [name, out];
  if (ref.startsWith('"') && ref.endsWith('"') && ref.length > 1) return [name, e8.readFromString(ref)[0]];
  return [name, refResolve(ref)];
}

/** The arguments of a call, "a=1, b=2", split at commas outside brackets and quotes, as org-babel-ref-split-args. */
export const splitArgs = (s: string): string[] => balancedSplit(s, (_p, next) => next === ",").map((a) => a.trim());

const NAME_LINE = (name: string) => new RegExp(`^[ \\t]*#\\+(?:NAME|TBLNAME):[ \\t]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "i");

/**
 * The element a #+NAME: line names, parsed as org-element-at-point would
 * have it, from that line to the next heading, or undefined when that
 * line names nothing, as one followed by a blank line.
 */
function namedElementAt(line: number): any {
  const all = headings();
  const next = all.find((h) => h.line > line);
  const end = next !== undefined ? e8.lineStart(next.line) : e8.pointMax();
  return e8.saveRestriction(() => {
    e8.narrowToRegion(e8.lineStart(line), end);
    const data = parseBuffer("element");
    const first = astContents(data)[0];
    const el = first !== undefined && typeOf(first) === "section" ? astContents(first)[0] : first;
    return typeof el === "object" ? el : undefined;
  });
}

/** Whether a line is under a commented heading, as org-in-commented-heading-p asks. */
const inCommentedHeading = (line: number): boolean => ancestorsOf(headings(), line).some(({ line: l }) => commentedLine(l));

/** The text of a list's items, without what is nested in them, as org-babel-read-list reads them. */
function readList(list: any): e8.Value[] {
  return astContents(list)
    .filter((i: any) => typeOf(i) === "item")
    .map((item: any) => {
      const sub = astContents(item).find((c: any) => typeOf(c) === "plain-list");
      const from = astBegin(item)!;
      const to = sub !== undefined ? astBegin(sub)! : (astContentsEnd(item) ?? astEnd(item)!);
      const text = e8.bufferSubstringNoProperties(from, Math.max(from, to));
      const [first, ...rest] = text.replace(/^[ \t]*(?:[-+*]|\d+[.)]|[A-Za-z][.)])[ \t]+/, "").split("\n");
      const tail = removeIndentation(rest.join("\n"));
      return babelRead(`${first}${rest.length ? `\n${tail}` : ""}`.replace(/[ \t\n]+$/, ""), true);
    });
}

/** The table at LINE, its rules "hline" and each cell read, as org-babel-read-table. */
function readTable(line: number): e8.Value[] {
  const rows: e8.Value[] = [];
  for (let l = line; l < e8.lineCount() && /^[ \t]*\|/.test(e8.lineText(l)); l++) {
    const row = parseRow(e8.lineText(l));
    rows.push(row === "hline" ? "hline" : row.map((c) => babelRead(c, true)));
  }
  return rows;
}

/** An element's value as org-babel-read-element reads it, or undefined for one that holds none. */
function readElement(el: any): e8.Value | undefined {
  const type = typeOf(el);
  const post = astPostAffiliated(el)!;
  switch (type) {
    case "fixed-width": {
      const v = String(astProperty("value", el) ?? "").trim();
      return stringToNumber(v) ?? v;
    }
    case "table":
      return readTable(e8.lineOf(post));
    case "plain-list":
      return readList(el);
    case "example-block":
    case "src-block": {
      const v = String(astProperty("value", el) ?? "");
      const preserve = truthy(e8.variable("org-src-preserve-indentation")) || truthy(astProperty("preserve-indent", el));
      return preserve ? v : removeIndentation(v);
    }
    case "export-block":
      return removeIndentation(String(astProperty("value", el) ?? ""));
    case "paragraph": {
      const text = e8.bufferSubstringNoProperties(astContentsBegin(el)!, astContentsEnd(el)!);
      const link = /^[ \t]*\[\[([^\]]+)\](?:\[[^\]]*\])?\][ \t\n]*$/.exec(text);
      if (link) {
        const raw = link[1];
        const file = /^file(?:[^:]*):(.+)$/.exec(raw);
        if (file) return e8.expandFileName(file[1]);
        return /^[a-zA-Z][-a-zA-Z0-9+.]*:/.test(raw) ? raw : e8.expandFileName(raw);
      }
      return text;
    }
    case "center-block":
    case "quote-block":
    case "verse-block":
    case "special-block":
      return removeIndentation(e8.bufferSubstringNoProperties(astContentsBegin(el)!, astContentsEnd(el)!));
    default:
      return undefined;
  }
}

/**
 * The value REF refers to, as org-babel-ref-resolve: the named block's
 * value, run with ARGS, a named call's, a named table, list or other
 * element read, or a heading's body by its CUSTOM_ID or ID, or a block in
 * the Library of Babel; FILE:NAME looks in that file. An index in
 * brackets after it picks rows and columns, as tbl[1,2:3].
 */
let refDepth = 0;

export function refResolve(ref0: string): e8.Value {
  // A reference that comes back to itself, as Lisp's recursion runs out.
  if (refDepth > 40) e8.signal("excessive-lisp-nesting", "Lisp nesting exceeds ‘max-lisp-eval-depth’");
  refDepth++;
  try {
    return refResolve_(ref0);
  } finally {
    refDepth--;
  }
}

function refResolve_(ref0: string): e8.Value {
  let ref = ref0;
  let index: string | undefined;
  let contents = false;
  const ix = /\[([^[]*)\]$/.exec(ref);
  if (ix) {
    const before = ref.slice(0, ix.index);
    if ((before.match(/\(/g) ?? []).length === (before.match(/\)/g) ?? []).length) {
      if (ix[1].length > 0) index = ix[1];
      else contents = true;
      ref = before;
    }
  }
  let args: Alist = [];
  const call = /^(.+?)(\[(.*)\]|())\((.*)\)$/s.exec(ref);
  if (call && call[1].length > 0) {
    if (call[5].length > 0) args = splitArgs(call[5]).map((r): [string, string] => [":var", r]);
    if (call[3] !== undefined && call[3].length > 0) args = [...parseHeaderArgumentList(call[3]), ...args];
    ref = call[1];
  }
  let file: string | undefined;
  const split = /^(.+):(.+)$/.exec(ref);
  if (split && e8.fileExistsP(split[1])) {
    file = split[1];
    ref = split[2];
  }
  const resolve = (): e8.Value =>
    inReferenceBuffer(() => {
      const params: Alist = [...args, [":results", "none"]];
      const re = NAME_LINE(ref);
      for (let line = 0; line < e8.lineCount(); line++) {
        if (!re.test(e8.lineText(line)) || inCommentedHeading(line)) continue;
        const el = namedElementAt(line);
        if (el === undefined || astProperty("name", el) !== ref) continue;
        const post = e8.lineOf(astPostAffiliated(el)!);
        const type = typeOf(el);
        if (type === "babel-call") {
          const info = callAt(post);
          if (info === undefined) e8.userError(`Unknown Babel reference: ${String(astProperty("call", el))}`);
          return toValue(executeSrcBlock(info, params));
        }
        if (type === "src-block" && !contents) {
          e8.gotoChar(e8.lineStart(post));
          const block = blockAtPoint();
          if (block !== undefined) return toValue(executeSrcBlock(block, truthy(e8.variable("org-babel-update-intermediate")) ? undefined : params));
        }
        const v = readElement(el);
        if (v === undefined) e8.signal("error", "Reference not found");
        return v;
      }
      const body = headlineBody(ref);
      if (body !== undefined) return body;
      const lib = library.get(ref);
      if (lib !== undefined) return toValue(executeSrcBlock(lib, params));
      return e8.signal("error", `Reference \u2018${ref}\u2019 not found in this buffer`);
    });
  const result = file !== undefined ? e8.withCurrentBuffer(e8.findFileNoselect(file), resolve) : resolve();
  if (result === true) return "t";
  if (index !== undefined && Array.isArray(result)) return indexList(index, result as e8.Value[]);
  return result;
}

const toValue = (v: unknown): e8.Value => (v === undefined ? null : (v as e8.Value));

/**
 * The part of LIST INDEX picks, as org-babel-ref-index-list: indexes from
 * 0, negative ones from the end, a range as 1:3, all of it as * or
 * nothing, and after a comma the next dimension.
 */
export function indexList(index: string, lis: e8.Value[]): e8.Value {
  if (index.length === 0) return lis;
  const m = /^([^,]*),?/.exec(index)!;
  const portion = m[1];
  const remainder = index.slice(m[0].length);
  const wrap = (n: number) => (n < 0 ? lis.length + n : n);
  const open = (ls: e8.Value[]): e8.Value => (ls.length === 1 ? ls[0] : ls);
  // As Lisp's nth: an index before the start is the first.
  const nth = (n: number): e8.Value => lis[Math.max(n, 0)] ?? null;
  const range = /([-0-9]+):([-0-9]+)|\*/.exec(portion);
  let picked: e8.Value[];
  if (portion.length === 0 || range) {
    const [from, to] = portion.length > 0 && range![1] !== undefined ? [wrap(parseInt(range![1], 10) || 0), wrap(parseInt(range![2], 10) || 0)] : [0, lis.length - 1];
    picked = [];
    for (let n = from; n <= to; n++) picked.push(nth(n));
  } else picked = [nth(wrap(parseInt(portion, 10) || 0))];
  return open(picked.map((sub) => (Array.isArray(sub) ? indexList(remainder, sub as e8.Value[]) : sub)));
}

// --- Calls, as ob-lob.el -----------------------------------------------------

e8.defineVariable({
  name: "org-babel-default-lob-header-args",
  doc: "The header arguments a #+CALL: line or inline call takes over those of the block it calls.",
  value: [[":exports", "results"]],
});

/** The Library of Babel: blocks by name, which org-babel-lob-ingest adds from a file. */
const library = new Map<string, Block>();

e8.defineCommand({
  name: "org-babel-lob-ingest",
  doc: "Add the named source blocks of FILE to the Library of Babel, for #+CALL: lines and references in any file.",
  params: [{ name: "file", kind: "file", prompt: "File: " }],
  run: (file?: string) => {
    let count = 0;
    const blocks = file ? e8.withCurrentBuffer(e8.findFileNoselect(file), () => findNowebBlocks()) : findNowebBlocks();
    for (const b of blocks) {
      if (b.name === undefined) continue;
      library.set(b.name, nowebP(b.params, ":eval") ? { ...b, body: expandNowebReferences(b) } : b);
      count++;
    }
    e8.message(`${count} source block${count > 1 ? "s" : ""} added to Library of Babel`);
  },
});

/**
 * The block a call names, as org-babel-lob--src-info finds it: a source
 * block of that name in the buffer, or in FILE for FILE:NAME, or the call
 * of that name, or else the Library of Babel's.
 */
function lobSrcInfo(ref: string): Block | undefined {
  let name = ref;
  let file: string | undefined;
  const split = /^(.+):(.+)$/s.exec(ref);
  if (split) {
    file = split[1];
    name = split[2];
  }
  const find = (): Block | undefined | null => {
    const re = NAME_LINE(name);
    for (let line = 0; line < e8.lineCount(); line++) {
      if (!re.test(e8.lineText(line))) continue;
      const el = namedElementAt(line);
      if (el === undefined || astProperty("name", el) !== name) continue;
      const post = e8.lineOf(astPostAffiliated(el)!);
      if (typeOf(el) === "src-block") {
        e8.gotoChar(e8.lineStart(post));
        return blockAtPoint();
      }
      if (typeOf(el) === "babel-call") return callAt(post) ?? null;
      // Other data of that name: as names are unique, no block.
      return null;
    }
    return undefined;
  };
  const found = file !== undefined ? e8.withCurrentBuffer(e8.findFileNoselect(file), () => e8.saveExcursion(() => e8.saveRestriction(() => (e8.widen(), find())))) : inReferenceBuffer(find);
  if (found === null) return undefined;
  return found ?? library.get(ref);
}

/**
 * The #+CALL: line on LINE as the block it runs, as org-babel-lob-get-info
 * describes it: the block's language and code, its header arguments under
 * org-babel-default-lob-header-args, the properties where the call is,
 * the call's own inside header arguments, its arguments as variables, and
 * its end header arguments. Its name is the call's own #+NAME:.
 */
export function callAt(line: number): Block | undefined {
  if (!/^[ \t]*#\+call:/i.test(e8.lineText(line))) return undefined;
  let first = line;
  while (first > 0 && ANY_AFFILIATED.test(e8.lineText(first - 1))) first--;
  const node = e8.saveRestriction(() => {
    e8.narrowToRegion(e8.lineStart(first), e8.lineEnd(line));
    const data = parseBuffer("element");
    const sec = astContents(data)[0];
    const el = sec !== undefined && typeOf(sec) === "section" ? astContents(sec)[0] : sec;
    return typeOf(el) === "babel-call" ? (el as any) : undefined;
  });
  if (node === undefined) return undefined;
  return lobGetInfo(
    {
      call: astProperty("call", node),
      inside: astProperty("inside-header", node),
      args: astProperty("arguments", node),
      end: astProperty("end-header", node),
      name: astProperty("name", node),
    },
    { line, end: line, first, type: "babel-call" },
  );
}

/** A call's parts as org-element gives them: what it calls, its inside header, its arguments, its end header and its name. */
interface CallParts {
  call?: string;
  inside?: string;
  args?: string;
  end?: string;
  name?: string;
}

function lobGetInfo(parts: CallParts, place: Pick<Block, "line" | "end" | "first" | "type" | "begin" | "objectEnd">): Block | undefined {
  if (parts.call === undefined) return undefined;
  const src = e8.saveExcursion(() => lobSrcInfo(parts.call!));
  if (src === undefined) return undefined;
  const params = merge(
    src.params,
    pairs(e8.variable("org-babel-default-lob-header-args")),
    ...propertyParams(place.line, src.language),
    parseHeaderArgumentList(parts.inside),
    parts.args ? splitArgs(parts.args).map((r): [string, string] => [":var", r]) : [],
    parseHeaderArgumentList(parts.end),
  );
  return { ...place, language: src.language, body: src.body, params, name: parts.name || undefined, preserveIndent: src.preserveIndent, coderef: src.coderef };
}

/** The #+CALL: line point is on, or on the keywords above, as the block it runs, or undefined. */
export function callAtPoint(): Block | undefined {
  let line = e8.lineOf(e8.point());
  while (line < e8.lineCount() - 1 && ANY_AFFILIATED.test(e8.lineText(line)) && !/^[ \t]*#\+call:/i.test(e8.lineText(line))) line++;
  return callAt(line);
}

// --- Inline source blocks and calls ------------------------------------------

/** An inline source block or call, as org-element-context finds it, with where it starts and ends before the blanks after it. */
export type InlineObject = { node: any; begin: number; end: number };

/** The inline source block or call at POS, of TYPE if given, as org-element-context finds it, or undefined. */
export function inlineObjectAt(pos: number, type?: "inline-src-block" | "inline-babel-call"): InlineObject | undefined {
  for (let n: any = objectAt(pos); n !== undefined; n = n.parent) {
    const t = typeOf(n);
    if ((t === "inline-src-block" || t === "inline-babel-call") && (type === undefined || t === type))
      return { node: n, begin: astBegin(n)!, end: astEnd(n)! - astPostBlank(n) };
  }
  return undefined;
}

/** An inline source block or call described as a block, as org-babel-get-src-block-info and org-babel-lob-get-info describe one. */
export function inlineInfo(o: InlineObject, line: number): Block | undefined {
  const node = o.node;
  if (typeOf(node) === "inline-babel-call")
    return lobGetInfo(
      { call: astProperty("call", node), inside: astProperty("inside-header", node), args: astProperty("arguments", node), end: astProperty("end-header", node) },
      { line, end: line, first: line, type: "inline-babel-call", begin: o.begin, objectEnd: o.end },
    );
  const language = String(astProperty("language", node));
  const value = String(astProperty("value", node) ?? "");
  const params = merge(
    pairs(e8.variable("org-babel-default-inline-header-args")),
    pairs(e8.variable(`org-babel-default-header-args:${language}`)),
    ...propertyParams(line, language),
    parseHeaderArgumentList(astProperty("parameters", node)),
  );
  return {
    line,
    end: line,
    first: line,
    language,
    body: value.replace(/\n$/, "").replace(/\n[ \t]*/g, " "),
    params,
    preserveIndent: false,
    type: "inline-src-block",
    begin: o.begin,
    objectEnd: o.end,
  };
}

/** The inline source block or call of TYPE point is on, as the block it runs, or undefined. */
export function inlineAtPoint(type: "inline-src-block" | "inline-babel-call"): Block | undefined {
  const pos = e8.point();
  // Only where the line could hold one, so C-c C-c elsewhere stays quick.
  if (!e8.lineText(e8.lineOf(pos)).includes(type === "inline-src-block" ? "src_" : "call_")) return undefined;
  const o = inlineObjectAt(pos, type);
  return o === undefined ? undefined : inlineInfo(o, e8.lineOf(o.begin));
}

// --- Errors, as ob-eval.el ---------------------------------------------------

e8.defineVariable({ name: "org-babel-error-buffer-name", doc: "The buffer a block's error output is shown in.", value: "*Org-Babel Error Output*" });

/** Empties the buffer of error output, as org-babel-eval-wipe-error-buffer. */
export function wipeErrorBuffer(): void {
  const name = String(e8.variable("org-babel-error-buffer-name") ?? "*Org-Babel Error Output*");
  if (e8.getBuffer(name) !== undefined) e8.withCurrentBuffer(name, () => e8.deleteRegion(e8.pointMin(), e8.pointMax()));
}

/**
 * Shows a program's error output and its exit code, as
 * org-babel-eval-error-notify: added to the error buffer, which is shown,
 * and said in the echo area.
 */
export function evalErrorNotify(exitCode: number | undefined, stderr: string): void {
  const name = String(e8.variable("org-babel-error-buffer-name") ?? "*Org-Babel Error Output*");
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.gotoChar(e8.pointMax());
    e8.saveExcursion(() => {
      if (e8.point() > e8.pointMin() && e8.charBefore(e8.point()) !== "\n") e8.insert("\n");
      e8.insert(stderr);
      e8.insert(exitCode !== undefined ? `[ Babel evaluation exited with code ${exitCode} ]` : "[ Babel evaluation exited abnormally ]");
    });
  });
  e8.call("display-buffer", name);
  e8.message(exitCode !== undefined ? `Babel evaluation exited with code ${exitCode}` : "Babel evaluation exited abnormally");
}

/**
 * Runs COMMAND in a shell with QUERY as its input, as org-babel-eval:
 * what it writes to its standard output; what it writes to its standard
 * error, or a failing exit code, is shown with evalErrorNotify.
 */
export function babelEval(command: string, query: string): string {
  const input = e8.makeTempFile("ob-input-", { text: `${query}\n` });
  const errors = e8.makeTempFile("ob-error-");
  const shell = String(e8.variable("shell-file-name") ?? "/bin/sh");
  const program = executableFind(shell) !== undefined ? shell : "/bin/sh";
  const buffer = e8.generateNewBufferName(" *org-babel-eval*");
  e8.getBufferCreate(buffer);
  try {
    const exit = e8.withCurrentBuffer(buffer, () => e8.callProcess(program, input, [true, errors], null, String(e8.variable("shell-command-switch") ?? "-c"), command));
    const output = e8.withCurrentBuffer(buffer, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
    const stderr = e8.fileExistsP(errors) ? e8.withCurrentBuffer(buffer, () => (eraseBuffer(), e8.insertFileContents(errors), e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()))) : "";
    if (typeof exit !== "number" || exit > 0 || stderr !== "") evalErrorNotify(typeof exit === "number" ? exit : undefined, stderr);
    return output;
  } finally {
    e8.call("kill-buffer", buffer);
    for (const f of [input, errors]) if (e8.fileExistsP(f)) e8.deleteFile(f);
  }
}

e8.defineKey("org-mode-map", "C-c C-v e", executeMaybe);
e8.defineKey("org-mode-map", "C-c C-v C-e", executeMaybe);

// --- TypeScript, E8's own language, as ob-emacs-lisp.el runs Emacs Lisp -------

/** Whether TypeScript text imports or exports, which only a module can. */
const isModule = (text: string): boolean => /^[ \t]*(?:import[ \t{]|export[ \t])/m.test(text);

/**
 * Runs a TypeScript block in the editor and gives its value: the last
 * statement's, as evalTypescript returns it. A block that imports or
 * exports runs as a module, from a file of its own, as eval-region runs
 * one, and gives no value.
 */
const executeTypescript = (body: string, params?: e8.Value): unknown => {
  if (!isModule(body)) {
    const value = e8.evalTypescript(body);
    // As ob-emacs-lisp.el writes a value :results scalar or verbatim keeps whole: as Lisp prints it.
    const rp = assq(params ?? null, ":result-params");
    const scalar = Array.isArray(rp) && (rp.includes("scalar") || rp.includes("verbatim"));
    return scalar && typeof value !== "string" && !nil(value) ? e8.prin1ToString(value as e8.Value) : value;
  }
  const file = e8.makeTempFile("e8-babel-", { suffix: ".ts", text: body });
  try {
    e8.call("load-file", file);
  } finally {
    e8.deleteFile(file);
  }
  return undefined;
};
e8.defun("org-babel-execute:typescript", executeTypescript);
e8.defun("org-babel-execute:ts", executeTypescript);

// --- Noweb references, as org-babel-expand-noweb-references ----------------

e8.defineVariable({ name: "org-babel-noweb-wrap-start", doc: "What starts a noweb reference.", value: "<<" });
e8.defineVariable({ name: "org-babel-noweb-wrap-end", doc: "What ends a noweb reference.", value: ">>" });
e8.defineVariable({ name: "org-babel-noweb-error-langs", doc: "Languages for which a noweb reference that resolves to nothing is an error.", value: [] });
e8.defineVariable({ name: "org-babel-noweb-error-all-langs", doc: "Whether a noweb reference that resolves to nothing is an error in every language.", value: false });
e8.defineVariable({ name: "org-babel-tangle-uncomment-comments", doc: "Whether tangled comments are inserted as they are, not commented out with a newline after.", value: false });
e8.defineVariable({ name: "org-babel-tangle-use-relative-file-links", doc: "Whether links in tangled comments name the Org file relative to the tangled one.", value: true });
e8.defineVariable({
  name: "org-babel-tangle-comment-format-beg",
  doc: "The comment before a tangled block's code: %link, %source-name, %file and %start-line are filled in.",
  value: "[[%link][%source-name]]",
});
e8.defineVariable({ name: "org-babel-tangle-comment-format-end", doc: "The comment after a tangled block's code, filled in as the one before it.", value: "%source-name ends here" });

/** Whether PARAMS's :noweb asks for references to be expanded in CONTEXT, as org-babel-noweb-p. */
export function nowebP(params: Params, context: ":tangle" | ":eval" | ":export"): boolean {
  const allowed = {
    ":tangle": ["yes", "tangle", "no-export", "strip-export", "strip-tangle"],
    ":eval": ["yes", "no-export", "strip-export", "eval", "strip-tangle"],
    ":export": ["yes", "strip-tangle"],
  }[context];
  return (params.get(":noweb") ?? "").split(/[ \t\n]+/).some((v) => allowed.includes(v));
}

/** A noweb reference, its name in group 1, as org-babel-noweb-wrap's regexp. */
export function nowebWrap(): string {
  const start = String(e8.variable("org-babel-noweb-wrap-start") ?? "<<");
  const end = String(e8.variable("org-babel-noweb-wrap-end") ?? ">>");
  const quote = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${quote(start)}([^ \\t\\n](?:.*?[^ \\t\\n])?)${quote(end)}`;
}

/** The blocks found last, for the buffer and its text as it was, as Org caches them by the modification tick. */
let nowebCache: { buffer: string; tick: number; blocks: Block[] } | undefined;

/** The buffer's source blocks not under a commented heading, as noweb expansion looks through them. */
function nowebBlocks(): Block[] {
  const buffer = e8.bufferName(e8.currentBuffer()) as string;
  const tick = e8.bufferCharsModifiedTick();
  if (nowebCache && nowebCache.buffer === buffer && nowebCache.tick === tick) return nowebCache.blocks;
  const blocks = findNowebBlocks();
  nowebCache = { buffer, tick, blocks };
  return blocks;
}

function findNowebBlocks(): Block[] {
  return e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    const blocks: Block[] = [];
    const defaults = defaultParams();
    for (let line = 0; line < e8.lineCount(); line++) {
      if (!BEGIN.test(e8.lineText(line))) continue;
      let end = line + 1;
      while (end < e8.lineCount() && !END.test(e8.lineText(end))) end++;
      if (end >= e8.lineCount()) break;
      const ancestors = ancestorsOf(all, line);
      const commented = ancestors.some(({ line: l }) => commentedLine(l));
      if (!commented) blocks.push(blockAt(line, end, ancestors, defaults));
      line = end;
    }
    return blocks;
  });
}

/**
 * The body of the heading whose CUSTOM_ID (case aside) or ID is ID, after
 * its meta data, as org-babel-ref-goto-headline-id and
 * org-babel-ref-headline-body find it: the ID where org-id-locations says
 * it is, or in this file, without scanning the files again.
 */
function headlineBody(id: string): string | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    const want = id.toLowerCase();
    const i = all.findIndex((h) => entryGet(h.line, "CUSTOM_ID")?.toLowerCase() === want);
    if (i >= 0) return subtreeBody(all[i].line);
    if (!e8.fboundp("org-id-find-id-file") || !e8.fboundp("org-id-find-id-in-file")) return undefined;
    const file = e8.funcall("org-id-find-id-file", id);
    if (typeof file !== "string") return undefined;
    const found = e8.funcall("org-id-find-id-in-file", id, file);
    if (!Array.isArray(found) || typeof found[1] !== "number") return undefined;
    const pos = found[1] as number;
    const own = e8.bufferFileName();
    if (own !== undefined && e8.fileTruename(own) === e8.fileTruename(e8.expandFileName(file))) return subtreeBody(lineAt(pos));
    return e8.withCurrentBuffer(e8.findFileNoselect(file), () => e8.saveRestriction(() => (e8.widen(), subtreeBody(lineAt(pos)))));
  });
}

/** A subtree's text after its heading's meta data, to its end before the newline, as org-narrow-to-subtree ends it. */
function subtreeBody(line: number): string {
  const all = headings();
  const i = all.findIndex((h) => h.line === line);
  if (i < 0) e8.signal("error", "Before first headline");
  const h = all[i];
  let k = i + 1;
  while (k < all.length && all[k].level > h.level) k++;
  const end = k < all.length ? Math.max(all[k].start - 1, h.start) : e8.pointMax();
  return e8.bufferSubstringNoProperties(Math.min(endOfMetaData(h), end), end);
}

/** A template with %KEY filled in from DATA, the longest keys first, as org-fill-template. */
export function fillTemplate(template: string, data: [string, string][]): string {
  let out = template;
  for (const [key, value] of [...data].sort((a, b) => b[0].length - a[0].length)) out = out.split(`%${key}`).join(value);
  return out;
}

/** A link to the block, without brackets, as org-babel-tangle--unbracketed-link: relative to the tangled file with org-babel-tangle-use-relative-file-links. */
export function unbracketedLink(block: Block, paramsOf: Block = block): string | undefined {
  if ((paramsOf.params.get(":comments") ?? "") === "no") return undefined;
  const link = e8.saveExcursion(() => {
    e8.gotoChar(e8.lineStart(block.line));
    // Without the link types' store functions, as Org binds them to none.
    return storeLink([16], false);
  });
  const bare = typeof link === "string" ? /^\[\[((?:[^\][\\]|\\.)+)\]/.exec(link)?.[1] : undefined;
  if (bare === undefined) return undefined;
  if (truthy(e8.variable("org-babel-tangle-use-relative-file-links") ?? true) && bare.startsWith("file:")) {
    const tangle = paramsOf.params.get(":tangle") ?? "";
    const dir = e8.fileNameDirectory(tangle) ?? undefined;
    return `file:${fileRelativeName(bare.slice(5), dir)}`;
  }
  return bare;
}

/**
 * The comments before and after a block's code, as
 * org-babel-tangle-comment-links makes them for noweb: its start line, the
 * file, a link to where point is, LINK-BLOCK's place, and its name. Tangling
 * gives its own start line, relative file and source name, as
 * org-babel-tangle-single-block does.
 */
export function commentLinks(
  block: Block,
  opts: { sourceName?: string; startLine?: number; file?: string; linkBlock?: Block } = {},
): [string, string] {
  const data: [string, string][] = [
    ["start-line", String(opts.startLine ?? block.line + 1)],
    ["file", opts.file ?? e8.bufferFileName() ?? ""],
    ["link", unbracketedLink(opts.linkBlock ?? block, block) ?? ""],
    ["source-name", opts.sourceName ?? block.name ?? ""],
  ];
  return [
    fillTemplate(String(e8.variable("org-babel-tangle-comment-format-beg") ?? ""), data),
    fillTemplate(String(e8.variable("org-babel-tangle-comment-format-end") ?? ""), data),
  ];
}

/** How the Emacs modes for languages E8 has no mode of comment, as c-mode and css-mode do. */
const COMMENT_SYNTAX: Record<string, [string, string]> = {
  c: ["/* ", " */"],
  "c++": ["// ", ""],
  cpp: ["// ", ""],
  css: ["/* ", " */"],
  java: ["// ", ""],
};

/** TEXT commented out in LANGUAGE's mode and trimmed, as noweb's comments are; or as it is with org-babel-tangle-uncomment-comments. */
export function commentIn(language: string, text: string, trim = true): string {
  if (truthy(e8.variable("org-babel-tangle-uncomment-comments") ?? null)) return text;
  const buffer = e8.bufferName(e8.getBufferCreate(e8.generateNewBufferName(" *org-babel comment*"))) as string;
  try {
    return e8.withCurrentBuffer(buffer, () => {
      const mode = langMode(language);
      if (e8.fboundp(mode) || e8.commandp(mode)) {
        try {
          e8.call(mode as e8.CommandName);
        } catch {
          // As ignore-errors around the mode.
        }
      }
      // Languages whose Emacs modes E8 lacks comment as those modes do.
      const start = e8.variable("comment-start");
      if (typeof start !== "string" || start === "") {
        const c = COMMENT_SYNTAX[language.toLowerCase()];
        if (c) {
          e8.makeLocalVariable("comment-start");
          e8.makeLocalVariable("comment-end");
          e8.setVariable("comment-start", c[0]);
          e8.setVariable("comment-end", c[1]);
        }
      }
      e8.insert(text);
      commentRegion(e8.pointMin(), e8.pointMax(), null);
      const out = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
      return trim ? out.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "") : out;
    });
  } finally {
    e8.call("kill-buffer", buffer);
  }
}

/**
 * The block's body with its noweb references replaced, as
 * org-babel-expand-noweb-references: by the body of the heading whose
 * CUSTOM_ID or ID it is, the block of that name, or every block whose
 * :noweb-ref it is, joined by their :noweb-sep; with (), the named block's
 * value. Text before a reference on its line goes before each line of
 * what replaces it, unless :noweb-prefix no.
 */
let nowebDepth = 0;

export function expandNowebReferences(block: Block): string {
  // A block that names itself, as Lisp's recursion runs out.
  if (nowebDepth > 40) e8.signal("excessive-lisp-nesting", "Lisp nesting exceeds \u2018max-lisp-eval-depth\u2019");
  nowebDepth++;
  try {
    return expandNowebReferences_(block);
  } finally {
    nowebDepth--;
  }
}

function expandNowebReferences_(block: Block): string {
  const comment = (block.params.get(":comments") ?? "") === "noweb";
  const prefixParam = block.params.get(":noweb-prefix");
  const noweb_prefix = prefixParam === undefined || (prefixParam !== "no" && prefixParam !== "nil");
  const re = new RegExp(`(.*?)(${nowebWrap()})`, "g");
  let blocks: Block[] | undefined;
  // While exporting, the document as it was, as ob-exp gives Org the reference buffer.
  const all = () => (blocks ??= referenceBuffer !== undefined ? inReferenceBuffer(nowebBlocks) : nowebBlocks());
  const expandBody = (b: Block, linkBlock: Block): string => {
    const body = nowebP(b.params, ":eval") ? expandNowebReferences(b) : b.body;
    if (!comment) return body;
    // Linked to where point is: the named block, which Org's search went to, or else the referencing block.
    const [beg, end] = commentLinks(b, { linkBlock });
    // With org-babel-tangle-uncomment-comments, c-wrap gives nothing.
    if (truthy(e8.variable("org-babel-tangle-uncomment-comments") ?? null)) return `\n${body}\n\n`;
    return `${commentIn(block.language, beg)}\n${body}\n${commentIn(block.language, end)}\n`;
  };
  return block.body.replace(re, (_m, prefix: string, _ref: string, id: string) => {
    let expansion: string;
    const call = /^(.*?)\((.*)\)$/s.exec(id);
    if (call) {
      // The named block's value, run with its language's function.
      // Its name exactly, as org-babel-ref-resolve compares it.
      const named = all().find((b) => b.name === call[1]);
      if (!named) e8.signal("error", `Reference \`${call[1]}' not found in this buffer`);
      if (call[2].trim() !== "") e8.signal("error", "E8 does not pass arguments to noweb references yet");
      // Its results put nowhere, as org-babel-ref-resolve runs it with :results none.
      const results = named.params.get(":results");
      const value = executeSrcBlock({ ...named, params: new Map([...named.params, [":results", results ? `${results} none` : "none"]]) });
      expansion = typeof value === "string" ? value : e8.prin1ToString((value ?? null) as e8.Value);
    } else {
      const head = referenceBuffer !== undefined ? inReferenceBuffer(() => headlineBody(id)) : headlineBody(id);
      const named = head === undefined ? all().find((b) => b.name !== undefined && b.name.toLowerCase() === id.toLowerCase()) : undefined;
      if (head !== undefined) expansion = head;
      else if (named) expansion = expandBody(named, named);
      else {
        const refs = all().filter((b) => b.params.get(":noweb-ref") === id);
        if (refs.length > 0) {
          expansion = refs.map((b, k) => expandBody(b, block) + (k < refs.length - 1 ? (b.params.get(":noweb-sep") ?? "\n") : "")).join("");
        } else {
          const langs = e8.variable("org-babel-noweb-error-langs");
          if (truthy(e8.variable("org-babel-noweb-error-all-langs") ?? null) || (Array.isArray(langs) && langs.includes(block.language))) {
            const start = String(e8.variable("org-babel-noweb-wrap-start") ?? "<<");
            const end = String(e8.variable("org-babel-noweb-wrap-end") ?? ">>");
            e8.signal("error", `Cannot resolve ${start}${id}${end} (see \u2018org-babel-noweb-error-langs\u2019)`);
          }
          expansion = "";
        }
      }
    }
    // Each line of what replaces it after the text before it on its line.
    return prefix + (noweb_prefix ? expansion.split(/[\n\r]/).join(`\n${prefix}`) : expansion);
  });
}
