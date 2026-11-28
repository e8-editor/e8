// Source blocks when exporting, after ob-exp.el: each block's, inline
// block's and call's :exports header argument says whether the export
// shows its code (code, a block's default), its results (results, the
// default of inline blocks and calls), both, or nothing (none). Code is
// written again from org-babel-exp-code-template; results come from
// running it, as C-c C-c would, with references looked up in a copy of
// the document as it was before the export changed it.

import {
  type Block,
  blockAtPoint,
  callAt,
  executeSrcBlock,
  expandNowebReferences,
  inlineInfo,
  inlineObjectAt,
  nowebP,
  nowebWrap,
  inlineResultAt,
  resultEnd,
  resultsLine,
  wipeErrorBuffer,
  withReferenceBuffer,
} from "ob-core";
import { parseBuffer } from "org-element";
import { type Datum, SECONDARY_VALUES, contents, postAffiliated, property, typeOf, begin as nodeBegin } from "org-element-ast";

e8.defineVariable({
  name: "org-babel-exp-code-template",
  value: "#+begin_src %lang%switches%header-args\n%body\n#+end_src",
  doc: "The template a source block is exported with: %lang, %name, %body, %switches, %flags and %header-args, and any header argument by its name.",
});
e8.defineVariable({
  name: "org-babel-exp-inline-code-template",
  value: "src_%lang[%switches%header-args]{%body}",
  doc: "The template an inline source block is exported with, as org-babel-exp-code-template.",
});
e8.defineVariable({ name: "org-babel-exp-call-line-template", value: "", doc: "The template a #+CALL: line is exported with: %line is the call." });
e8.defineVariable({ name: "org-babel-default-inline-header-args", value: [[":session", "none"], [":results", "replace"], [":exports", "results"], [":hlines", "yes"]], doc: "The header arguments inline source blocks start with." });

/** A template filled from an alist, as org-fill-template: each %KEY, longest keys first. */
function fillTemplate(template: string, data: [string, string][]): string {
  const sorted = [...data].sort((a, b) => b[0].length - a[0].length);
  let out = template;
  for (const [key, value] of sorted) out = out.split(`%${key}`).join(value);
  return out;
}

/** Commas before * and #+ at a line's start, so code is not read as Org, as org-escape-code-in-string. */
export function escapeCode(s: string): string {
  return s.replace(/^([ \t]*)(,*)(\*|,|#\+)/gm, (m, ind: string, commas: string, what: string) => (what === "," ? m : `${ind}${commas},${what}`));
}

/** A block's code as exported, as org-babel-exp-code: from the inline template for an inline block, its code then not escaped. */
function expCode(block: Block, switches: string, parameters: string | undefined, isInline: boolean): string {
  // Its noweb references taken out with :noweb strip-export, or expanded as :noweb allows when exporting.
  const noweb = block.params.get(":noweb");
  const body = noweb === "strip-export" ? block.body.replace(new RegExp(nowebWrap(), "g"), "") : nowebP(block.params, ":export") ? expandNowebReferences(block) : block.body;
  const params: [string, string][] = [...block.params].map(([k, v]) => [k.replace(/^:/, ""), JSON.stringify(v)]);
  const flags = block.params.get(":flags");
  return fillTemplate(String(e8.variable(isInline ? "org-babel-exp-inline-code-template" : "org-babel-exp-code-template")), [
    ["lang", block.language],
    ["body", isInline ? body : escapeCode(body)],
    ["switches", switches ? ` ${switches}` : ""],
    ["flags", flags !== undefined ? ` ${flags}` : ""],
    ["header-args", parameters ? ` ${parameters}` : ""],
    ...params,
    ["name", block.name ?? ""],
  ]);
}

/** The lines of a block's result, from its #+RESULTS: line to the line after it, or undefined. */
function resultLines(block: Block): [number, number] | undefined {
  const line = resultsLine(block);
  return line === undefined ? undefined : [line, resultEnd(line)];
}

function deleteLines(from: number, to: number): void {
  const start = e8.lineStart(from);
  const end = to < e8.lineCount() ? e8.lineStart(to) : e8.pointMax();
  e8.deleteRegion(start, end);
}

/** Whether a block can be run, as org-babel-exp-results checks, saying so when it cannot. */
function runnable(block: Block): boolean {
  if (e8.fboundp(`org-babel-execute:${block.language}`)) return true;
  e8.message(`org-export: No org-babel-execute function for ${block.language}.  Not updating exported results.`);
  return false;
}

/**
 * Runs a block, inline block or call for the export, as
 * org-babel-exp-results: its results replacing those in the buffer, or
 * with SILENT nowhere, as for a session's sake.
 */
function expResults(block: Block, silent: boolean): void {
  if (!runnable(block)) return;
  wipeErrorBuffer();
  executeSrcBlock(block, [[":results", silent ? "silent" : "replace"]]);
}

/** Runs a block silently when it has a session, so the session sees it, as org-babel-exp-do-export does for code and none. */
function silently(block: Block): void {
  const session = block.params.get(":session");
  if (session !== undefined && session !== "none") expResults(block, true);
}

/** Removes a call's results, and the blank lines before them, as org-babel-remove-result. */
function removeResult(block: Block): void {
  const r = resultLines(block);
  if (!r) return;
  let from = r[0];
  while (from > 0 && /^[ \t]*$/.test(e8.lineText(from - 1))) from--;
  deleteLines(from, r[1]);
}

/** Removes an inline block's or call's results, and the blanks before them, as org-babel-remove-inline-result. */
function removeInlineResult(block: Block): void {
  const r = inlineResultAt(block.objectEnd!);
  if (r) e8.deleteRegion(block.objectEnd!, r[1]);
}

/** A source block for the export, as org-babel-exp-src-block and the part of org-babel-exp-process-buffer for blocks. */
function exportSrcBlock(block: Block): void {
  const exports = String(block.params.get(":exports") || "code");
  const [switches, parameters] = [block.switches ?? "", block.parameters ?? ""];
  const ind = /^[ \t]*/.exec(e8.lineText(block.line))![0];
  if (exports === "results" || exports === "both") {
    e8.gotoChar(e8.lineStart(block.line));
    expResults(block, false);
  } else if (exports === "none" || exports === "code") {
    e8.gotoChar(e8.lineStart(block.line));
    silently(block);
    const r = resultLines(block);
    if (r && r[0] > block.end) {
      let to = r[1];
      while (to < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(to))) to++;
      deleteLines(r[0], to);
    }
  }
  if (exports === "none" || exports === "results") {
    // The block and its keywords, and the blank lines after it, gone.
    let to = block.end + 1;
    while (to < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(to))) to++;
    deleteLines(block.first, to);
    return;
  }
  if (exports === "code" || exports === "both") {
    const code = expCode(block, switches, parameters, false);
    const replacement = block.preserveIndent ? code.replace(/^/, ind).replace(/\n([^\n]*)$/, `\n${ind}$1`) : code.replace(/^(?=.)/gm, ind);
    const start = e8.lineStart(block.line);
    const end = e8.lineEnd(block.end);
    if (e8.bufferText(start, end) !== replacement) {
      e8.deleteRegion(start, end);
      e8.gotoChar(start);
      e8.insert(replacement);
    }
  } else e8.message(`Unknown value of src block parameter :exports ${JSON.stringify(exports)}`);
}

/**
 * An inline source block or call for the export, as
 * org-babel-exp-process-buffer handles them: run for its results, which
 * take its place, or written again as code, or left out.
 */
function exportInline(block: Block, parameters: string | undefined): void {
  const exports = String(block.params.get(":exports") || "code");
  const begin = block.begin!;
  const end = block.objectEnd!;
  const code = (): string => expCode(block, "", parameters, true);
  let replacement: string | undefined;
  if (exports === "none" || exports === "code") {
    silently(block);
    removeInlineResult(block);
    replacement = exports === "none" ? "" : code();
  } else if (exports === "results") {
    expResults(block, false);
    replacement = "";
  } else if (exports === "both") {
    expResults(block, false);
    replacement = code();
  } else e8.message(`Unknown value of src block parameter :exports ${JSON.stringify(exports)}`);
  // An inline call's code is never shown: only its results.
  if (block.type === "inline-babel-call") replacement = fillTemplate(String(e8.variable("org-babel-exp-call-line-template") ?? ""), [["line", e8.bufferText(begin, end)]]);
  if (replacement === undefined) return;
  if (replacement === "") {
    // The block gone, with the blanks after it.
    let to = end;
    while (to < e8.pointMax() && /[ \t]/.test(e8.bufferText(to, to + 1))) to++;
    e8.deleteRegion(begin, to);
  } else if (replacement !== e8.bufferText(begin, end)) {
    e8.deleteRegion(begin, end);
    e8.gotoChar(begin);
    e8.insert(replacement);
  }
}

/** A #+CALL: line for the export, as org-babel-exp-process-buffer handles one: run as :exports says, then written as org-babel-exp-call-line-template, or left out. */
function exportCall(block: Block, value: string): void {
  const exports = String(block.params.get(":exports") || "code");
  e8.gotoChar(e8.lineStart(block.line));
  if (exports === "none" || exports === "code") {
    silently(block);
    removeResult(block);
  } else if (exports === "results" || exports === "both") expResults(block, false);
  else e8.message(`Unknown value of src block parameter :exports ${JSON.stringify(exports)}`);
  const rep = fillTemplate(String(e8.variable("org-babel-exp-call-line-template") ?? ""), [["line", value]]);
  const start = e8.lineStart(block.first);
  if (rep === "") {
    // The call and its keywords gone, with the blank lines after it.
    let to = block.end + 1;
    while (to < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(to))) to++;
    deleteLines(block.first, to);
  } else {
    e8.deleteRegion(start, e8.lineEnd(block.end));
    e8.gotoChar(start);
    e8.insert(rep);
  }
}

type Found = { type: string; at: e8.Marker; value?: string; parameters?: string };

/** The buffer's source blocks, calls and inline ones, in order, leaving out those under archived or commented headings, as org-babel-exp-process-buffer finds them. */
function babelNodes(): Found[] {
  const out: Found[] = [];
  const walk = (data: Datum[], skipped: boolean) => {
    for (const d of data) {
      if (typeof d === "string") continue;
      const type = typeOf(d)!;
      const skip = skipped || (type === "headline" && (property("archivedp", d) || property("commentedp", d)));
      if (!skip) {
        if (type === "src-block" && property("language", d)) out.push({ type, at: e8.makeMarker(postAffiliated(d)!) });
        else if (type === "babel-call") out.push({ type, at: e8.makeMarker(postAffiliated(d)!), value: String(property("value", d) ?? "") });
        else if (type === "inline-src-block" || type === "inline-babel-call") out.push({ type, at: e8.makeMarker(nodeBegin(d)!), parameters: property("parameters", d) });
      }
      for (const key of SECONDARY_VALUES[type] ?? []) {
        const v = property(key, d);
        if (Array.isArray(v)) walk(v, skip);
      }
      walk(contents(d), skip);
    }
  };
  walk(contents(parseBuffer("object")), false);
  return out;
}

/** A copy of the buffer as it is, in Org mode, where references are looked up while the export changes the buffer, as org-export-copy-buffer makes one. */
function referenceCopy(): string {
  const text = e8.saveRestriction(() => (e8.widen(), e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())));
  const dir = e8.variable("default-directory");
  const name = e8.generateNewBufferName(" *Org-Babel reference*");
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.insert(text);
    e8.call("org-mode");
    e8.makeLocalVariable("default-directory");
    e8.setVariable("default-directory", dir ?? null);
  });
  return name;
}

/** Process the buffer's source blocks, calls and inline ones for export, as org-babel-exp-process-buffer. */
export function processBuffer(): void {
  if (e8.variable("org-export-use-babel") === false) return;
  const reference = referenceCopy();
  try {
    withReferenceBuffer(reference, () =>
      e8.saveExcursion(() => {
        // From the first to the last, as Org evaluates them, each found again where it now is.
        for (const found of babelNodes()) {
          const pos = e8.markerPosition(found.at);
          e8.deleteMarker(found.at);
          if (pos === undefined) continue;
          const line = e8.lineOf(pos);
          if (found.type === "src-block") {
            e8.gotoChar(e8.lineStart(line));
            const block = blockAtPoint();
            if (block !== undefined && block.line === line) exportSrcBlock(block);
          } else if (found.type === "babel-call") {
            const block = callAt(line);
            if (block === undefined) e8.userError(`Unknown Babel reference: ${found.value}`);
            exportCall(block, found.value ?? "");
          } else {
            const type = found.type as "inline-src-block" | "inline-babel-call";
            const o = inlineObjectAt(pos, type);
            if (o === undefined || o.begin !== pos) continue;
            const block = inlineInfo(o, line);
            if (block === undefined) e8.userError(`Unknown Babel reference: ${String(property("call", o.node))}`);
            exportInline(block, found.parameters);
          }
        }
      }),
    );
  } finally {
    e8.call("kill-buffer", reference);
  }
}
