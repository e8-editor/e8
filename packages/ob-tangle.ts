// Tangling, after Org's ob-tangle.el: C-c C-v t writes the source blocks of
// an Org file whose :tangle header argument names a file, or is yes for
// the Org file's name with the language's extension, into those files, as
// a literate configuration is turned into the code it describes. Header
// arguments come from org-babel-default-header-args, #+PROPERTY: header-args
// lines, the header-args properties of the headings above a block, and the
// block's own #+begin_src line and #+header: lines, the nearest winning.

import { type Block, blockAtPoint, collectBlocks, commentIn, commentLinks, expandNowebReferences, nowebP, nowebWrap, pairs } from "ob-core";
import { fileRelativeName } from "files";
import { headingIndex, headings } from "org";
import { truthy } from "subr";

e8.defineVariable({
  name: "org-babel-tangle-lang-exts",
  doc: "The extension a language's code is tangled to with :tangle yes: pairs of a language and an extension, else the language's name.",
  value: [
    ["emacs-lisp", "el"],
    ["elisp", "el"],
    ["python", "py"],
    ["shell", "sh"],
    ["sh", "sh"],
    ["bash", "sh"],
    ["javascript", "js"],
    ["js", "js"],
    ["typescript", "ts"],
    ["rust", "rs"],
    ["julia", "jl"],
    ["ruby", "rb"],
    ["haskell", "hs"],
    ["latex", "tex"],
    ["C", "c"],
    ["C++", "cpp"],
  ],
});
for (const [name, doc] of [
  ["org-babel-pre-tangle-hook", "Run before tangling."],
  ["org-babel-post-tangle-hook", "Run in each file tangled, visited, after tangling."],
  ["org-babel-tangle-finished-hook", "Run once tangling is done."],
] as const) {
  e8.defineHook(name, doc);
}


/** The file a block tangles to, or undefined for :tangle no, as org-babel-effective-tangled-filename. */
function tangledFile(block: Block, orgFile: string): string | undefined {
  const tangle = block.params.get(":tangle") ?? "no";
  if (tangle === "no" || tangle === "") return undefined;
  const dir = e8.fileNameDirectory(orgFile) ?? undefined;
  if (tangle === "yes") {
    const exts = new Map(pairs(e8.variable("org-babel-tangle-lang-exts")));
    const base = e8.fileNameNondirectory(orgFile).replace(/\.[^./]*$/, "");
    return e8.expandFileName(`${base}.${exts.get(block.language) ?? block.language}`, dir);
  }
  return e8.expandFileName(tangle, dir);
}

/** Text without the indentation its lines share, as org-remove-indentation. */
function removeIndentation(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => /\S/.test(l)).map((l) => /^[ \t]*/.exec(l)![0].length);
  const n = indents.length === 0 ? 0 : Math.min(...indents);
  return n === 0 ? text : lines.map((l) => l.slice(Math.min(n, /^[ \t]*/.exec(l)![0].length))).join("\n");
}

/** A block's name, or its heading's title and its place among the heading's blocks, as org-babel-tangle-single-block names it. */
function sourceName(block: Block, single = false): string {
  if (block.name !== undefined) return block.name;
  const all = headings();
  const i = headingIndex(all, block.line);
  let counter = 0;
  for (let l = i === undefined ? 0 : all[i].line + 1; l <= block.line; l++) {
    if (/^[ \t]*#\+begin_src[ \t]/i.test(e8.lineText(l))) counter++;
  }
  // A block tangled on its own is the first, as org-babel-tangle passes its counter.
  return `${i === undefined ? "No heading" : all[i].title}:${single ? 1 : counter}`;
}

/** The Org text before a block, from its heading or the block before, for :comments org, as org-babel-tangle-single-block takes it. */
function orgCommentText(block: Block): string {
  const all = headings();
  const i = headingIndex(all, block.line);
  // After the heading's stars, as (re-search-forward org-outline-regexp) leaves point.
  const afterStars = i === undefined ? e8.pointMin() : all[i].start + all[i].level + 1;
  // The end of the last block before it that has a language, as Org's src block regexp needs one.
  let prevEnd = e8.pointMin();
  for (let l = block.line - 1; l >= 0; l--) {
    if (!/^[ \t]*#\+begin_src[ \t]+\S/i.test(e8.lineText(l))) continue;
    let end = l + 1;
    while (end < block.line && !/^[ \t]*#\+end_src/i.test(e8.lineText(end))) end++;
    if (end < block.line) {
      prevEnd = e8.lineEnd(end);
      break;
    }
  }
  const text = e8.bufferSubstringNoProperties(Math.max(afterStars, prevEnd), e8.lineStart(block.line));
  // As org-babel-process-comment-text says: org-remove-indentation by default.
  const process = e8.variable("org-babel-process-comment-text");
  const name = typeof process === "symbol" ? e8.symbolName(process) : process;
  if (typeof process === "function" || (typeof name === "string" && name !== "org-remove-indentation" && e8.fboundp(name))) {
    return String(e8.funcall(typeof process === "function" ? process : (name as string), text) ?? "");
  }
  const lines = text.split("\n");
  const indents = lines.filter((l) => /\S/.test(l)).map((l) => /^[ \t]*/.exec(l)![0].length);
  const n = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(Math.min(n, /^[ \t]*/.exec(l)![0].length))).join("\n");
}

/**
 * A block's tangled text, as org-babel-spec-to-string writes it: with
 * :comments org or both, the Org text before it; with link, yes, noweb or
 * both, a link to it before and its name after, each commented out in its
 * language; its code, noweb references expanded as :noweb says.
 */
function specToString(block: Block, single = false): string {
  const comments = block.params.get(":comments") ?? "";
  const link = ["both", "link", "yes", "noweb"].includes(comments);
  const insertComment = (text: string): string => {
    if (comments === "" || comments === "no" || !/\S/.test(text)) return "";
    if (truthy(e8.variable("org-babel-tangle-uncomment-comments") ?? null)) return text;
    // Commented, then a newline at the end of the line point is on, as Org's end-of-line and newline leave it.
    return `${commentIn(block.language, text, false)}\n`;
  };
  let body = block.body;
  if (nowebP(block.params, ":tangle")) {
    // strip-tangle when it is the whole value, as Org compares it.
    body = (block.params.get(":noweb") ?? "") === "strip-tangle" ? body.replace(new RegExp(nowebWrap(), "g"), "") : expandNowebReferences(block);
  }
  // Trimmed, as org-trim: with its indentation kept, as -i or
  // org-src-preserve-indentation says, leading blank lines only; else
  // without the indentation its lines share.
  body = block.preserveIndent
    ? body.replace(/^([ \t]*\n)+/, "").replace(/[ \t\n\r]+$/, "")
    : removeIndentation(body).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  let out = "";
  if (comments === "both" || comments === "org") out += insertComment(orgCommentText(block));
  // Its start line after the #+begin_src line's, and the Org file relative, as org-babel-tangle-single-block gives them.
  const orgFile = e8.bufferFileName() ?? "";
  const file = truthy(e8.variable("org-babel-tangle-use-relative-file-links") ?? true) ? fileRelativeName(orgFile) : orgFile;
  const [beg, end] = link ? commentLinks(block, { sourceName: sourceName(block, single), startLine: block.line + 2, file }) : ["", ""];
  if (link) out += insertComment(beg);
  out += `${body}\n`;
  if (link) out += insertComment(end);
  return out;
}

/** A file mode as :tangle-mode writes it, "o755" or 0o755, as org-babel-interpret-file-mode reads the common ones. */
function fileMode(value: string): number | undefined {
  const m = /^(?:o|#o)?0?([0-7]{3})$/.exec(value.trim());
  return m ? parseInt(m[1], 8) : undefined;
}

/**
 * Tangles the buffer's blocks, or with `only` some of them, as
 * org-babel-tangle: each file gets its blocks' code in order, a blank line
 * between blocks unless :padline no, a :shebang first, and is written only
 * if it changed. With `targetFile`, blocks that name no file go there, as
 * org-babel-tangle's TARGET-FILE. The files written.
 */
export function tangle(only?: (block: Block, file: string) => boolean, targetFile?: string, single = false): string[] {
  e8.runHooks("org-babel-pre-tangle-hook");
  const orgFile = e8.bufferFileName();
  if (!orgFile) e8.userError("Buffer is not visiting a file");
  // The blocks the narrowing shows, as org-babel-map-src-blocks goes through them.
  const blocks = collectBlocks(targetFile);
  const byFile = new Map<string, Block[]>();
  for (const block of blocks) {
    const file = tangledFile(block, orgFile);
    if (file === undefined || (only && !only(block, file))) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(block);
  }
  let count = 0;
  const written: string[] = [];
  for (const [file, fileBlocks] of byFile) {
    if (file === orgFile) e8.signal("error", "Not allowed to tangle into the same file as self");
    let text = "";
    let shebanged = false;
    let first = true;
    let mode: number | undefined;
    let mkdirp = false;
    for (const block of fileBlocks) {
      const shebang = block.params.get(":shebang") ?? "";
      const tangleMode = block.params.get(":tangle-mode");
      if (shebang !== "" && mode === undefined) mode = 0o755;
      if (tangleMode !== undefined) mode = fileMode(tangleMode) ?? mode;
      const m = block.params.get(":mkdirp");
      if (m !== undefined && m !== "no") mkdirp = true;
      if (block.params.get(":padline") !== "no" && !first) text += "\n";
      first = false;
      if (shebang !== "" && !shebanged) {
        text += `${shebang}\n`;
        shebanged = true;
      }
      text += specToString(block, single);
      count++;
    }
    const dir = e8.fileNameDirectory(file);
    if (mkdirp && dir && !e8.fileExists(dir)) e8.makeDirectory(dir, { parents: true });
    if (!(e8.fileExists(file) && e8.readTextFile(file) === text)) {
      e8.writeTextFile(file, text);
      if (mode !== undefined) e8.setFileModes(file, mode);
    }
    written.push(file);
  }
  e8.message(`Tangled ${count} code block${count === 1 ? "" : "s"} from ${e8.fileNameNondirectory(orgFile)}`);
  // Each file is visited only for functions on the hook, as Emacs does.
  const postTangle = e8.variable("org-babel-post-tangle-hook");
  if (truthy(postTangle) && !(Array.isArray(postTangle) && postTangle.length === 0)) {
    for (const file of written) {
      const buffer = e8.findFileNoselect(file);
      e8.withCurrentBuffer(buffer, () => e8.runHooks("org-babel-post-tangle-hook"));
    }
  }
  e8.runHooks("org-babel-tangle-finished-hook");
  return written;
}

const tangleCommand = e8.defineCommand({
  name: "org-babel-tangle",
  doc:
    "Write the source blocks whose :tangle header argument names a file into their files. With C-u, only the block at " +
    "point; with C-u C-u, the blocks that tangle to the same file as it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const prefix = Array.isArray(arg) ? arg[0] : undefined;
    if (prefix === 4 || prefix === 16) {
      const head = blockAtPoint()?.line;
      if (head === undefined) e8.userError("Point is not in a source code block");
      const orgFile = e8.bufferFileName() ?? "";
      const target = e8.saveRestriction(() => {
        e8.widen();
        return collectBlocks().find((b) => b.line === head);
      });
      const targetFile = target && tangledFile(target, orgFile);
      if (prefix === 16 && targetFile === undefined) e8.userError("Point is not in a source code block");
      tangle((block, file) => (prefix === 4 ? block.line === head : file === targetFile), undefined, prefix === 4);
    } else tangle();
  },
});

/**
 * Tangles an Org file, as org-babel-tangle-file: with `targetFile`, the
 * blocks that name no file of their own go there; with `langRe`, an Emacs
 * regexp, only the blocks whose language it matches. The files written.
 */
export function tangleFile(file: string, targetFile?: string, langRe?: string): string[] {
  const buffer = e8.findFileNoselect(file);
  return e8.withCurrentBuffer(buffer, () =>
    tangle(langRe ? (block) => e8.stringMatch(langRe, block.language) !== undefined : undefined, targetFile),
  );
}

e8.defineCommand({
  name: "org-babel-tangle-file",
  doc: "Tangle an Org file's source blocks into their files. Code that wants a target file or a language regexp, as Emacs's optional arguments, uses tangleFile from ob-tangle.",
  params: [{ name: "file", kind: "file", prompt: "File to tangle: " }],
  run: (file) => {
    tangleFile(file);
  },
});

/**
 * Tangles an Org file's TypeScript into a .ts file of the same name, if the
 * Org file is newer, and loads that, as org-babel-load-file does with Emacs
 * Lisp: a literate init file, as `config.org` that init.ts loads.
 */
e8.defineCommand({
  name: "org-babel-load-file",
  doc:
    "Load the TypeScript source blocks of an Org file: tangle them into FILE.ts, if the Org file is newer than it, " +
    "and load that, as a literate configuration is loaded.",
  params: [{ name: "file", kind: "file", prompt: "File to load: " }],
  run: (file) => {
    const org = e8.expandFileName(file);
    const tangled = `${org.replace(/\.[^./]*$/, "")}.ts`;
    if (!e8.fileExists(org)) e8.signal("error", `File to tangle does not exist: ${org}`);
    if (!e8.fileExists(tangled) || e8.fileNewerThanFileP(org, tangled)) {
      tangleFile(org, tangled, "\\`\\(?:typescript\\|ts\\)\\'");
      // So a change to the Org file that left the code alone is not tangled again each time.
      if (e8.fileExists(tangled)) e8.setFileTimes(tangled);
    }
    e8.call("load-file", tangled);
  },
});

e8.defineKey("org-mode-map", "C-c C-v t", tangleCommand);
e8.defineKey("org-mode-map", "C-c C-v C-t", tangleCommand);
