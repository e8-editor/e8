// Source blocks when exporting, after ob-exp.el: each block's :exports
// header argument says whether the export shows its code (code, the
// default), its results (results), both, or nothing (none). The block is
// written again from org-babel-exp-code-template, without its header
// arguments; results come from running it, which E8 can for TypeScript.
//
// Inline source blocks and #+CALL: lines are exported as their code or
// left out: E8 does not run them yet (docs/differences.md).

import { type Block, collectBlocks, executeSrcBlock, resultEnd, resultsLine } from "ob-core";
import { allMatches } from "subr";

e8.defineVariable({ name: "org-babel-exp-code-template", value: "#+begin_src %lang%switches%flags\n%body\n#+end_src", doc: "The template a source block is exported with: %lang, %name, %body, %switches, %flags and %header-args, and any header argument by its name." });
e8.defineVariable({ name: "org-babel-exp-inline-code-template", value: "src_%lang[%switches%flags]{%body}", doc: "The template an inline source block is exported with, as org-babel-exp-code-template." });
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

/** A block's switches, as -n or -l "(ref:%s)" before its header arguments. */
function switchesOf(line: string): string {
  const m = /^[ \t]*#\+begin_src[ \t]+\S+[ \t]*(.*)$/i.exec(line);
  if (!m) return "";
  const out: string[] = [];
  const re = /\s*([-+][A-Za-z](?:\s+"[^"]*")?)/y;
  let rest = m[1];
  let s: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((s = re.exec(rest))) out.push(s[1]);
  rest = rest.slice(re.lastIndex);
  return out.join(" ");
}

/** A block's code as exported, as org-babel-exp-code. */
function expCode(block: Block, switches: string): string {
  const params: [string, string][] = [...block.params].map(([k, v]) => [k.replace(/^:/, ""), typeof v === "string" ? JSON.stringify(v) : String(v)]);
  const flags = block.params.get(":flags");
  return fillTemplate(String(e8.variable("org-babel-exp-code-template")), [
    ["lang", block.language],
    ["body", escapeCode(block.body)],
    ["switches", switches ? ` ${switches}` : ""],
    ["flags", flags ? ` ${flags}` : ""],
    ["header-args", ""],
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

/** Process the buffer's source blocks for export, as org-babel-exp-process-buffer. */
export function processBuffer(): void {
  if (e8.variable("org-export-use-babel") === false) return;
  e8.saveExcursion(() => {
    const blocks = collectBlocks();
    // From the last, so the lines of those before stay where they are.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const exports = String(block.params.get(":exports") ?? "code");
      const switches = switchesOf(e8.lineText(block.line));
      const ind = /^[ \t]*/.exec(e8.lineText(block.line))![0];
      if (exports === "results" || exports === "both") {
        if (e8.fboundp(`org-babel-execute:${block.language}`)) {
          e8.gotoChar(e8.lineStart(block.line));
          executeSrcBlock(block);
        } else e8.message(`org-export: No org-babel-execute function for ${block.language}.  Not updating exported results.`);
      }
      if (exports === "none" || exports === "code") {
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
      } else if (exports === "code" || exports === "both") {
        const code = expCode(block, switches);
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
    processInline();
  });
}

const INLINE = /\bsrc_([^\s[{]+)(\[[^\]\n]*\])?\{([^}\n]*)\}/g;

/** Inline source blocks and #+CALL: lines: their code, or nothing, as Org exports them with what E8 can run. */
function processInline(): void {
  for (let l = e8.lineCount() - 1; l >= 0; l--) {
    const text = e8.lineText(l);
    if (/^[ \t]*#\+CALL:/i.test(text)) {
      const template = String(e8.variable("org-babel-exp-call-line-template") ?? "");
      const rep = template === "" ? "" : template.split("%line").join(text.replace(/^[ \t]*#\+CALL:[ \t]*/i, ""));
      const start = e8.lineStart(l);
      const end = l + 1 < e8.lineCount() ? e8.lineStart(l + 1) : e8.pointMax();
      e8.deleteRegion(start, end);
      if (rep !== "") {
        e8.gotoChar(start);
        e8.insert(rep + "\n");
      }
      continue;
    }
    if (!text.includes("src_") || /^[ \t]*(#|:( |$))/.test(text)) continue;
    const matches = allMatches(INLINE, text).reverse();
    for (const m of matches) {
      const header = m[2] ? m[2].slice(1, -1) : "";
      const exp = /:exports\s+(\S+)/.exec(header)?.[1] ?? "results";
      const start = e8.lineStart(l) + [...text.slice(0, m.index)].length;
      const end = start + [...m[0]].length;
      let replacement: string;
      if (exp === "code" || exp === "both")
        replacement = fillTemplate(String(e8.variable("org-babel-exp-inline-code-template")), [
          ["lang", m[1]],
          ["body", m[3]],
          ["switches", ""],
          ["flags", ""],
          ["header-args", ""],
          ["name", ""],
        ]);
      else {
        if (exp !== "none") e8.message(`org-export: No org-babel-execute function for ${m[1]}.  Not updating exported results.`);
        replacement = "";
      }
      let to = end;
      if (replacement === "") while (to < e8.lineEnd(l) && /[ \t]/.test(e8.bufferText(to, to + 1))) to++;
      e8.deleteRegion(start, to);
      e8.gotoChar(start);
      e8.insert(replacement);
    }
  }
}
