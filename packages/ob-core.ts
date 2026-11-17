// Source blocks, after Org's ob-core.el: their header arguments, as
// org-babel-get-src-block-info gathers them from org-babel-default-header-args,
// #+PROPERTY: header-args lines, the header-args properties of the headings
// above a block, and its own #+header: and #+begin_src lines, the nearest
// winning; and running one, C-c C-c, as org-babel-execute-src-block does,
// with the function org-babel-execute:LANGUAGE names, its value put in the
// buffer under #+RESULTS:. TypeScript's is E8's own, as Emacs Lisp's is
// Emacs's in ob-emacs-lisp.el: it runs the block in the editor.

import { headings, keywordLines } from "org";
import { dropMarker, marker } from "org-macs";
import { truthy } from "subr";

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

export type Params = Map<string, string>;

export const pairs = (v: e8.Value | undefined): [string, string][] =>
  Array.isArray(v) ? (v.filter((p) => Array.isArray(p) && p.length >= 2) as [string, string][]).map(([k, x]) => [String(k), String(x)]) : [];

/** Header arguments as a line writes them, ":tangle ~/x.el :mkdirp yes", as org-babel-parse-header-arguments reads them. */
export function parseHeaderArguments(text: string): Params {
  const out: Params = new Map();
  for (const part of ` ${text}`.split(/[ \t]+(?=:\S)/)) {
    const m = /^:(\S+)(?:[ \t]+([\s\S]*))?$/.exec(part.trim());
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    // As org-babel-read reads a quoted string: without its quotes.
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) value = JSON.parse(value) as string;
    out.set(`:${m[1]}`, value);
  }
  return out;
}

/** Merges header arguments, later ones winning, as org-babel-merge-params. */
const merge = (...all: Params[]): Params => new Map(all.flatMap((p) => [...p]));

/** The header arguments #+PROPERTY: lines give the buffer: for all languages, or with `language` for that one. */
function bufferHeaderArgs(language?: string): Params {
  let out: Params = new Map();
  for (const [, , text] of keywordLines()) {
    const m = /^#\+PROPERTY:[ \t]+header-args(?::(\S+?))?(\+)?[ \t]+(.*)$/i.exec(text);
    if (m && m[1] === language) out = merge(out, parseHeaderArguments(m[3]));
  }
  return out;
}

/** A heading's header-args property: for all languages, or with `language` for that one. */
function headingHeaderArgs(line: number, language?: string): Params {
  let out: Params = new Map();
  let k = line + 1;
  // Past the planning line, if any, to the drawer.
  if (/^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/.test(e8.lineText(k))) k++;
  if (!/^[ \t]*:PROPERTIES:[ \t]*$/i.test(e8.lineText(k))) return out;
  for (k++; k < e8.lineCount() && !/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(k)); k++) {
    const m = /^[ \t]*:header-args(?::(\S+?))?(\+)?:[ \t]*(.*)$/i.exec(e8.lineText(k));
    if (m && m[1] === language) out = merge(out, parseHeaderArguments(m[3]));
  }
  return out;
}

/** A source block: the lines it starts and ends on, its language, name, header arguments and code. */
export interface Block {
  line: number;
  end: number;
  /** The first of the #+name: and #+header: lines above it, or its own first line. */
  first: number;
  language: string;
  name?: string;
  params: Params;
  body: string;
}

const BEGIN = /^[ \t]*#\+begin_src(?:[ \t]+(\S+)(.*))?$/i;
const END = /^[ \t]*#\+end_src[ \t]*$/i;
const AFFILIATED = /^[ \t]*#\+(?:headers?|name):[ \t]*(.*)$/i;

/** A block's code: without the indentation its lines share, and Org's escaping commas, as org-babel-get-src-block-info has it. */
function blockBody(lines: string[]): string {
  let out = lines;
  if (!truthy(e8.variable("org-src-preserve-indentation"))) {
    const indents = out.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
    const common = indents.length ? Math.min(...indents) : 0;
    out = out.map((l) => l.slice(Math.min(common, /^[ \t]*/.exec(l)![0].length)));
  }
  // As org-unescape-code-in-string: one comma less before * and #+ at a line's start.
  return out.map((l) => l.replace(/^([ \t]*,*),(?=\*|#\+)/, "$1")).join("\n");
}

/** Whether a heading, or one above it, is commented or archived, as org-in-commented-heading-p and org-in-archived-heading-p ask. */
function skipped(ancestors: { line: number }[]): boolean {
  return ancestors.some(({ line }) => {
    const text = e8.lineText(line);
    return /^\*+[ \t]+(?:\S+[ \t]+)?COMMENT\b/.test(text) || /:ARCHIVE:(?:\S*:)?[ \t]*$/.test(text);
  });
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
    const a = AFFILIATED.exec(text);
    if (!a) break;
    first = k;
    if (/^[ \t]*#\+name:/i.test(text)) name ??= a[1].trim();
    else headers.unshift(parseHeaderArguments(a[1]));
  }
  const langDefaults = new Map(pairs(e8.variable(`org-babel-default-header-args:${language}`)));
  // As org-babel-params-from-properties: the header-args properties,
  // inherited, then the language's, each the buffer's then the headings'.
  const params = merge(
    defaults,
    langDefaults,
    bufferHeaderArgs(),
    ...ancestors.map((a) => headingHeaderArgs(a.line)),
    bufferHeaderArgs(language),
    ...ancestors.map((a) => headingHeaderArgs(a.line, language)),
    ...headers,
    parseHeaderArguments(m[2] ?? ""),
  );
  const lines: string[] = [];
  for (let k = line + 1; k < end; k++) lines.push(e8.lineText(k));
  return { line, end, first, language, name: name || undefined, params, body: blockBody(lines) };
}

const defaultParams = (): Params => new Map(pairs(e8.variable("org-babel-default-header-args")));

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
  for (let line = 0; line < e8.lineCount(); line++) {
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
  const here = e8.lineOf(e8.point());
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

/**
 * The text of a result, as org-babel-insert-result writes it: a list as a
 * table, a row for each element that is itself a list; a scalar's lines
 * each after a colon, or in an example block from
 * org-babel-min-lines-for-block-output lines on; nothing for nil or an
 * empty string. Each line ends in a newline.
 */
function resultText(result: unknown, rp: string[]): { text: string; table: boolean } {
  if (nil(result) || (Array.isArray(result) && result.length === 0)) return { text: "", table: false };
  const scalar = rp.includes("scalar") || rp.includes("verbatim");
  if (Array.isArray(result) && !scalar) {
    const rows = result.every((r) => Array.isArray(r)) ? (result as unknown[][]) : [result];
    return { text: rows.map((r) => `| ${r.map(cell).join(" | ")} |\n`).join(""), table: true };
  }
  const text = scalar && typeof result !== "string" ? e8.prin1ToString(result as e8.Value) : cell(result);
  // As org-babel-examplify-region, which does nothing for an empty result.
  if (text === "") return { text: "", table: false };
  const lines = text.replace(/\n$/, "").split("\n");
  if (rp.includes("raw")) return { text: `${lines.join("\n")}\n`, table: false };
  const min = Number(e8.variable("org-babel-min-lines-for-block-output") ?? 10);
  if (lines.length < min) return { text: lines.map((l) => `: ${l}\n`).join(""), table: false };
  return { text: `#+begin_example\n${lines.map((l) => `${escapeCode(l)}\n`).join("")}#+end_example\n`, table: false };
}

const RESULTS = /^[ \t]*#\+results(?:\[[^\]\n]*\])?:[ \t]*(.*?)[ \t]*$/i;

/**
 * The line of the block's #+RESULTS:, as org-babel-where-is-src-block-result
 * finds it, or undefined: a named block's anywhere by its name, else the
 * unnamed one just after the block.
 */
function resultsLine(block: Block): number | undefined {
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

/**
 * The line after the result under a #+RESULTS: line, as org-babel-result-end
 * finds it: its fixed-width lines, table, block or drawer. A block or drawer
 * that does not close before the next heading is no result, so nothing is
 * taken.
 */
function resultEnd(line: number): number {
  let k = line + 1;
  const text = (n: number) => (n < e8.lineCount() ? e8.lineText(n) : "");
  const begin = /^[ \t]*#\+begin_(\S+)/i.exec(text(k));
  const drawer = /^[ \t]*:([\w-]+):[ \t]*$/.exec(text(k));
  /** The line after the first from `k` that `close` matches, before a heading, or nothing. */
  const closing = (close: RegExp): number => {
    for (let n = k + 1; n < e8.lineCount() && !HEADING.test(text(n)); n++) if (close.test(text(n))) return n + 1;
    return line + 1;
  };
  if (begin) return closing(new RegExp(`^[ \\t]*#\\+end_${begin[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "i"));
  if (drawer && drawer[1].toUpperCase() !== "END") return closing(/^[ \t]*:END:[ \t]*$/i);
  if (/^[ \t]*\|/.test(text(k))) {
    while (k < e8.lineCount() && /^[ \t]*(?:\||#\+TBLFM:)/i.test(text(k))) k++;
    return k;
  }
  while (k < e8.lineCount() && /^[ \t]*:(?: |$)/.test(text(k))) k++;
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
  const { text, table } = resultText(result, rp);
  const back = marker(e8.point());
  try {
    let at: number;
    let indent: string;
    const existing = resultsLine(block);
    if (existing !== undefined) {
      indent = indentationOf(existing);
      const start = lineStartOrEnd(existing + 1);
      const end = lineStartOrEnd(resultEnd(existing));
      if (rp.includes("append")) at = end;
      else if (rp.includes("prepend")) at = start;
      else {
        e8.deleteRegion(start, end);
        at = start;
      }
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

/** Whether the block may run, asking when org-confirm-babel-evaluate says to, as org-babel-confirm-evaluate. */
function confirmEvaluate(block: Block): boolean {
  const named = block.name !== undefined ? ` (${block.name}) ` : " ";
  const evalArg = block.params.get(":eval") ?? (block.params.has(":noeval") ? "no" : undefined);
  if (evalArg === "no" || evalArg === "never") {
    e8.message(`Evaluation of this ${block.language} code block${named}is disabled.`);
    return false;
  }
  const confirm = e8.variable("org-confirm-babel-evaluate");
  const query =
    evalArg === "query" ||
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
export function executeSrcBlock(block = blockAtPoint()): unknown {
  if (block === undefined) e8.userError("Not in a source block");
  if (!confirmEvaluate(block)) return undefined;
  const fn = `org-babel-execute:${block.language}`;
  if (!e8.fboundp(fn)) e8.signal("error", `No org-babel-execute function for ${block.language}!`);
  const rp = resultParams(block.params);
  const at = block.name !== undefined ? `(${block.name})` : `at position ${e8.lineStart(block.line) + 1}`;
  e8.message(`Executing ${block.language.charAt(0).toUpperCase()}${block.language.slice(1).toLowerCase()} code block ${at}...`);
  const started = Date.now();
  let result = e8.saveExcursion(() => e8.funcall(fn, block.body, [...block.params] as unknown as e8.Value)) as unknown;
  if ((rp.includes("table") || rp.includes("vector")) && !Array.isArray(result)) result = [[result]];
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

const executeMaybe = e8.defineCommand({
  name: "org-babel-execute-maybe",
  doc: "Run the source block point is in, if it is in one.",
  run: () => {
    if (blockAtPoint() !== undefined) executeSrcBlock();
  },
});

// As org-babel-execute-safely-maybe on org-ctrl-c-ctrl-c-hook: C-c C-c in a block runs it.
e8.addHook("org-ctrl-c-ctrl-c-hook", () => {
  if (truthy(e8.variable("org-babel-no-eval-on-ctrl-c-ctrl-c"))) return false;
  const block = blockAtPoint();
  if (block === undefined) return false;
  executeSrcBlock(block);
  return true;
});

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
const executeTypescript = (body: string): unknown => {
  if (!isModule(body)) return e8.evalTypescript(body);
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
