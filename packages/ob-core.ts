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
import { AFFILIATED as ANY_AFFILIATED } from "org-element";
import { dropMarker, lineAt, marker } from "org-macs";
import { commentRegion } from "newcomment";
import { langMode } from "org-src";
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
  /** Whether its indentation is kept, as org-src-preserve-indentation or its -i switch says. */
  preserveIndent: boolean;
}

const BEGIN = /^[ \t]*#\+begin_src(?:[ \t]+(\S+)(.*))?$/i;
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
  // The switches before the header arguments, -i among them, as org-src-preserve-indentation-p reads it.
  const switches = /^[^:]*/.exec(m[2] ?? "")![0];
  const preserveIndent = truthy(e8.variable("org-src-preserve-indentation")) || /(?:^|[ \t])-i(?:[ \t]|$)/.test(switches);
  return { line, end, first, language, name: name || undefined, params, body: blockBody(lines, preserveIndent), preserveIndent };
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

/**
 * The line after the result under a #+RESULTS: line, as org-babel-result-end
 * finds it: its fixed-width lines, table, block or drawer. A block or drawer
 * that does not close before the next heading is no result, so nothing is
 * taken.
 */
export function resultEnd(line: number): number {
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
  // Its noweb references expanded first, as :noweb allows when evaluating, the confirmation seeing them.
  const expanded = nowebP(block.params, ":eval") ? { ...block, body: expandNowebReferences(block) } : block;
  if (!confirmEvaluate(expanded)) return undefined;
  const fn = `org-babel-execute:${block.language}`;
  if (!e8.fboundp(fn)) e8.signal("error", `No org-babel-execute function for ${block.language}!`);
  const rp = resultParams(block.params);
  const at = block.name !== undefined ? `(${block.name})` : `at position ${e8.lineStart(block.line) + 1}`;
  e8.message(`Executing ${block.language.charAt(0).toUpperCase()}${block.language.slice(1).toLowerCase()} code block ${at}...`);
  const started = Date.now();
  const body = expanded.body;
  let result = e8.saveExcursion(() => e8.funcall(fn, body, [...block.params] as unknown as e8.Value)) as unknown;
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
  const all = () => (blocks ??= nowebBlocks());
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
      const head = headlineBody(id);
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
