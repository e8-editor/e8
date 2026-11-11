// Writing a file's local variables, after Emacs's files-x.el:
// add-file-local-variable and delete-file-local-variable change the Local
// Variables list at the end of the file, adding it if need be, and
// add-file-local-variable-prop-line and delete-file-local-variable-prop-line
// change the -*- line at its start; add-dir-local-variable and
// delete-dir-local-variable change a directory's .dir-locals.el.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { dirLocalsAllFiles, dirLocalsFileFor, propLineBounds } from "files";
import { commentRegion } from "newcomment";
import { forwardLine, regexpQuote } from "subr";

const v = (name: string): e8.Value | undefined => e8.variable(name);
const truthy = (value: e8.Value | undefined): boolean => value !== undefined && value !== null && value !== false;

type Op = "add-or-replace" | "delete";

/** The variables a file may set, to complete against, as read-file-local-variable offers them. */
function variableNames(): string[] {
  return [...new Set(["mode", "eval", "coding", "unibyte", ...e8.variableNames()])].sort();
}

/** The modes `mode:` may name, without -mode. */
function modeNames(): string[] {
  return e8.commandNames().filter((c) => /-mode$/.test(c) && !/-minor-mode$/.test(c)).map((c) => c.replace(/-mode$/, ""));
}

/** The prompt for a variable's value, as read-file-local-variable-value asks. */
const valuePrompt = (variable: string): string =>
  variable === "eval" ? "Add eval with expression: " : `Add ${variable} with value: `;

/** A value typed for a variable, read as Lisp, as read-file-local-variable-value reads it: a mode without -mode. */
function readValue(variable: string, text: string): e8.Value {
  if (variable === "mode") return text === "" ? null : e8.intern(text.replace(/-mode$/, ""));
  const current = variable === "unibyte" ? true : (v(variable) ?? null);
  return e8.readFromString(text.trim() === "" ? e8.prin1ToString(current) : text)[0];
}

const variableParam = (prompt: string): e8.Param => ({ name: "variable", prompt: `${prompt}: `, collection: variableNames });
const valueParam: e8.Param = {
  name: "value",
  prompt: valuePrompt,
  collection: (variable: string) => (variable === "mode" ? modeNames() : []),
};

/** Says how to make a change take effect, as modify-file-local-variable-message. */
function changedMessage(): void {
  const file = e8.bufferFileName();
  const keys = (command: string) => e8.whereIs(command) ?? `M-x ${command}`;
  e8.message(
    file !== undefined && e8.fileExistsP(file)
      ? `For this change to take effect revisit file using ${keys("revert-buffer")}`
      : `For this change to take effect use ${keys("normal-mode")}`,
  );
}

/** Puts lines in comments, as comment-region does, with comment-start ";; " when the mode has none. */
function commentLines(beg: number, end: number, fallback: string): void {
  const start = v("comment-start");
  e8.letBind({ "comment-start": typeof start === "string" && start !== "" ? start : fallback }, () => {
    e8.saveExcursion(() => commentRegion(beg, end, 1));
  });
}

/** Changes a variable in the Local Variables list, as modify-file-local-variable. */
export function modifyFileLocalVariable(variable: string, value: e8.Value, op: Op, interactive = false): void {
  if (!truthy(v("enable-local-variables"))) {
    e8.message("File-local variables are disabled");
    return;
  }
  const origin = e8.point();
  e8.widen();
  const max = e8.pointMax();
  const from = Math.max(max - 3000, e8.pointMin());
  const page = e8.search("\n\f", { from: max, backward: true, bound: from });
  let found = e8.search("Local Variables:", { from: page === undefined ? from : page.start, caseFold: true });
  if (found === undefined) {
    if (op === "delete") {
      e8.gotoChar(origin);
      e8.message("Local Variables not found");
      return;
    }
    const beg = e8.pointMax();
    e8.gotoChar(beg);
    e8.insert("\nLocal Variables:\nEnd:\n");
    commentLines(beg, e8.point(), ";; ");
    found = e8.search("Local Variables:", { from: beg, caseFold: true });
    if (found === undefined) {
      e8.message("Can't add file-local variables");
      return;
    }
  }
  const prefix = e8.bufferSubstringNoProperties(e8.lineBeginningPosition(found.start), found.start);
  const suffix = e8.bufferSubstringNoProperties(found.end, e8.lineEndPosition(found.end));
  const prefixRe = `^${regexpQuote(prefix)}`;
  const suffixRe = `${regexpQuote(suffix)}$`;
  const beg = e8.lineEndPosition(found.end) + 1;
  e8.gotoChar(Math.min(beg, e8.pointMax()));
  let end: e8.Marker;
  e8.saveExcursion(() => {
    if (e8.reSearchForward(`${prefixRe}[ \t]*End:[ \t]*${suffixRe}`, { noerror: true, caseFold: true }) === undefined) {
      e8.saveExcursion(() => e8.insert(`${prefix}End:${suffix}\n`));
    }
  });
  e8.saveExcursion(() => {
    e8.reSearchForward(`${prefixRe}[ \t]*End:[ \t]*${suffixRe}`, { noerror: true, caseFold: true });
    end = e8.makeMarker(e8.lineBeginningPosition());
  });
  let replaced: number | undefined;
  const special = variable === "mode" || variable === "eval";
  if (!(op === "add-or-replace" && special)) {
    e8.gotoChar(beg);
    const re = `${prefixRe}${regexpQuote(e8.prin1ToString(e8.intern(variable)))}:.*${suffixRe}`;
    while (e8.reSearchForward(re, { bound: e8.markerPosition(end!), noerror: true }) !== undefined) {
      e8.deleteRegion(e8.matchBeginning(0)!, e8.matchEnd(0)! + 1);
      replaced = e8.point();
    }
  } else e8.gotoChar(e8.markerPosition(end!)!);
  if (op === "add-or-replace") {
    e8.gotoChar(variable === "mode" ? beg : (replaced ?? e8.markerPosition(end!)!));
    e8.insert(`${prefix}${e8.prin1ToString(e8.intern(variable))}: ${e8.prin1ToString(value)}${suffix}\n`);
  }
  e8.deleteMarker(end!);
  if (interactive) changedMessage();
}

/** Changes a variable on the -*- line, adding the line if need be, as modify-file-local-variable-prop-line. */
export function modifyFileLocalVariablePropLine(variable: string, value: e8.Value, op: Op, interactive = false): void {
  if (!truthy(v("enable-local-variables"))) {
    e8.message("File-local variables are disabled");
    return;
  }
  const origin = e8.point();
  e8.widen();
  let bounds = propLineBounds();
  let beg: e8.Marker;
  let end: e8.Marker;
  if (bounds !== undefined) {
    beg = e8.makeMarker(bounds[0]);
    end = e8.makeMarker(bounds[1]);
    e8.gotoChar(bounds[0]);
  } else {
    if (op === "delete") {
      e8.gotoChar(origin);
      e8.message("The -*- line not found");
      return;
    }
    e8.gotoChar(e8.pointMin());
    if (e8.lookingAt(String(v("file-auto-mode-skip") ?? "^#!")) || e8.lookingAt("<\\?xml[^>\n]*>$")) forwardLine(1);
    const lineStart = e8.point();
    e8.insert("-*-");
    beg = e8.makeMarker(e8.point());
    end = e8.makeMarker(e8.point());
    e8.insert("-*-\n");
    commentLines(lineStart, e8.point(), ";;; ");
    bounds = propLineBounds();
    if (bounds !== undefined) {
      e8.setMarker(beg, bounds[0]);
      e8.setMarker(end, bounds[1]);
    }
    e8.gotoChar(e8.markerPosition(beg)!);
  }
  const lineEnd = e8.lineEndPosition();
  const simple = /^[ \t]*([^ \t\n\r:;]+)([ \t]*-\*-)/.exec(e8.bufferSubstringNoProperties(e8.point(), lineEnd));
  const name = e8.prin1ToString(e8.intern(variable));
  if (simple) {
    // The simple form, -*- MODENAME -*-.
    const nameStart = e8.point() + simple[0].indexOf(simple[1]);
    const nameEnd = nameStart + simple[1].length;
    if (variable === "mode") {
      e8.deleteRegion(nameStart, nameEnd);
      if (op === "add-or-replace") {
        e8.gotoChar(nameStart);
        e8.insert(e8.prin1ToString(value));
      }
    } else {
      e8.gotoChar(nameEnd);
      e8.insert(`; ${name}: ${e8.prin1ToString(value)}; `);
      e8.gotoChar(nameStart);
      e8.insert(" mode: ");
    }
  } else {
    let replaced: number | undefined;
    if (!(op === "add-or-replace" && (variable === "mode" || variable === "eval"))) {
      e8.gotoChar(e8.markerPosition(beg)!);
      while (e8.point() < e8.markerPosition(end)!) {
        const text = e8.bufferSubstringNoProperties(e8.point(), e8.markerPosition(end)!);
        const m = /^[ \t]*([^ \t\n:]+)[ \t]*:[ \t]*/.exec(text);
        if (!m) {
          e8.message("Malformed -*- line");
          e8.deleteMarker(beg);
          e8.deleteMarker(end);
          return;
        }
        const entryStart = e8.point();
        const after = e8.readFromString(text, m[0].length)[1];
        e8.gotoChar(entryStart + after);
        e8.skipCharsForward(" \t;");
        if (m[1] === name) {
          e8.deleteRegion(entryStart, e8.point());
          replaced = e8.point();
        }
      }
    }
    if (op === "add-or-replace") {
      e8.gotoChar(variable === "mode" ? e8.markerPosition(beg)! : (replaced ?? e8.markerPosition(end)!));
      const atBeg = e8.point() === e8.markerPosition(beg);
      const before = e8.saveExcursion(() => {
        e8.skipCharsBackward(" \t");
        return e8.charBefore();
      });
      if (before !== ";" && !atBeg && !(e8.markerPosition(beg)! > e8.markerPosition(end)!)) e8.insert(";");
      if (e8.charBefore() !== " ") e8.insert(" ");
      e8.insert(`${name}: ${e8.prin1ToString(value)};`);
      if (e8.charAfter() !== " ") e8.insert(" ");
    }
  }
  e8.deleteMarker(beg);
  e8.deleteMarker(end);
  if (interactive) changedMessage();
}

e8.defineCommand({
  name: "add-file-local-variable",
  doc:
    "Add a file-local variable with its value, read as Lisp, to the Local Variables list at the end of the file, adding " +
    "the list if there is none and taking out the variable's other settings. For the -*- line, use " +
    "add-file-local-variable-prop-line.",
  params: [variableParam("Add file-local variable"), valueParam],
  run: (variable: string, value: string) => {
    if (variable === "lexical-binding") e8.userError("Use ‘add-file-local-variable-prop-line’ to add the ‘lexical-binding’ variable");
    modifyFileLocalVariable(variable, readValue(variable, value), "add-or-replace", true);
  },
});

e8.defineCommand({
  name: "delete-file-local-variable",
  doc: "Delete every setting of a file-local variable from the Local Variables list.",
  params: [variableParam("Delete file-local variable")],
  run: (variable: string) => modifyFileLocalVariable(variable, null, "delete", true),
});

e8.defineCommand({
  name: "add-file-local-variable-prop-line",
  doc: "Add a file-local variable with its value, read as Lisp, to the -*- line at the start of the file, adding the line if there is none.",
  params: [variableParam("Add -*- file-local variable"), valueParam],
  run: (variable: string, value: string) => modifyFileLocalVariablePropLine(variable, readValue(variable, value), "add-or-replace", true),
});

e8.defineCommand({
  name: "delete-file-local-variable-prop-line",
  doc: "Delete every setting of a file-local variable from the -*- line.",
  params: [variableParam("Delete -*- file-local variable")],
  run: (variable: string) => modifyFileLocalVariablePropLine(variable, null, "delete", true),
});

// Directory-local variables.

const sym = (name: string): symbol => e8.intern(name);
const nameOf = (s: e8.Value): string => (typeof s === "symbol" ? e8.symbolName(s) : String(s));

/** A dir-locals entry: a mode (a symbol), nil, or a subdirectory, and its (VAR . VALUE) settings. */
type DirEntry = { key: e8.Value; pairs: [symbol, e8.Value][] };

const isEval = (x: e8.Value): boolean => typeof x === "symbol" && e8.symbolName(x) === "eval";

/** The entries of a .dir-locals.el as E8 reads it, (VAR . VALUE) pairs being lists of the variable and the rest. */
function entriesOf(data: e8.Value): DirEntry[] {
  if (!Array.isArray(data)) return [];
  return data.filter(Array.isArray).map((e) => ({
    key: e[0] ?? null,
    pairs: e
      .slice(1)
      .filter((p): p is e8.Value[] => Array.isArray(p) && typeof p[0] === "symbol")
      .map((p) => [p[0] as symbol, isEval(p[0]) ? p.slice(1) : p.length === 2 ? p[1] : p.length === 1 ? null : p.slice(1)]),
  }));
}

/** The dir-locals entries written as Lisp, in dotted pair notation, as dir-locals-to-string. */
function dirLocalsToString(entries: DirEntry[]): string {
  const prin1 = (x: e8.Value) => e8.prin1ToString(x);
  return `(${entries
    .map((e) => `(${prin1(e.key)} . (${e.pairs.map(([variable, value]) => `(${prin1(variable)} . ${prin1(value)})`).join("\n")}))`)
    .join("\n")})`;
}

/** The mode or subdirectory a directory-local variable is for, as read-file-local-variable-mode reads it. */
function modeOrSubdirectory(text: string): e8.Value {
  if (text === "nil" || text === "") return null;
  return e8.commandExists(text) ? sym(text) : text;
}

/** Changes a variable in the directory's .dir-locals.el, visiting it, as modify-dir-local-variable. */
export function modifyDirLocalVariable(mode: e8.Value, variable: string, value: e8.Value, op: Op, fileIn?: string): void {
  if (!truthy(v("enable-local-variables"))) {
    e8.message("Directory-local variables are disabled");
    return;
  }
  let file = fileIn;
  if (file === undefined) {
    const visited = e8.bufferFileName();
    const found = visited === undefined ? undefined : dirLocalsFileFor(visited);
    if (typeof found === "string") file = dirLocalsAllFiles(found).pop();
    else if (Array.isArray(found)) {
      const mtime = found[2];
      if (mtime !== null && mtime !== undefined && mtime !== false) file = dirLocalsAllFiles(String(found[0])).pop();
      else {
        e8.message("Directory locals were not set from a file");
        return;
      }
    } else file = e8.expandFileName(String(v("dir-locals-file") ?? ".dir-locals.el"));
  }
  if (op === "delete" && (file === undefined || !e8.fileExistsP(file))) {
    e8.message("No .dir-locals.el file was found");
    return;
  }
  e8.call("find-file", file!);
  e8.widen();
  e8.gotoChar(e8.pointMin());
  let entries: DirEntry[] = [];
  try {
    const text = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    const [data, end] = e8.readFromString(text);
    entries = entriesOf(data);
    e8.deleteRegion(e8.pointMin(), e8.pointMin() + end);
  } catch {
    // An empty or unreadable file is started afresh.
  }
  const variableSym = sym(variable);
  const at = entries.findIndex((e) => (e.key === null ? mode === null : typeof e.key === "string" ? e.key === mode : e.key === mode));
  if (at >= 0) {
    const entry = entries[at];
    const others = entries.filter((_, i) => i !== at);
    const rest = op === "delete" || !["mode", "eval"].includes(variable) ? entry.pairs.filter((p) => p[0] !== variableSym) : entry.pairs;
    entries = [{ key: entry.key, pairs: op === "delete" ? rest : [[variableSym, value], ...rest] }, ...others];
  } else entries = [{ key: mode, pairs: [[variableSym, value]] }, ...entries];
  // Forget the cached reading, as the file may be saved within the same second.
  const directory = e8.fileNameDirectory(file!);
  e8.setDefault("dir-locals-directory-cache", (e8.defaultValue("dir-locals-directory-cache") as e8.Value[] ?? []).filter((e) => !(Array.isArray(e) && e[0] === directory)));
  const rank = (k: e8.Value) => (k === null ? 0 : typeof k === "symbol" ? 1 : 2);
  entries.sort((a, b) => rank(a.key) - rank(b.key) || (nameOf(a.key ?? "") < nameOf(b.key ?? "") ? -1 : nameOf(a.key ?? "") > nameOf(b.key ?? "") ? 1 : 0));
  e8.insert(";;; Directory Local Variables            -*- no-byte-compile: t -*-\n");
  e8.insert(";;; For more information see (info \"(emacs) Directory Variables\")\n\n");
  e8.insert(dirLocalsToString(entries));
  if (e8.point() === e8.pointMax()) e8.insert("\n");
  // indent-sexp from the list, past the comments before it.
  e8.gotoChar(e8.pointMin());
  e8.forwardComment(Number.MAX_SAFE_INTEGER);
  e8.call("indent-sexp");
  e8.gotoChar(e8.pointMin());
}

const modeParam: e8.Param = {
  name: "mode",
  prompt: () => `Mode or subdirectory (default ${String(v("major-mode") ?? "nil")}): `,
  collection: () => e8.commandNames().filter((c) => /-mode$/.test(c) && !/-minor-mode$/.test(c)),
};

/** The dir-locals file to change: asked for with a prefix argument, as read-dir-locals-file. */
function dirLocalsFileParam(prefix: e8.PrefixArg): string | undefined {
  if (prefix === null) return undefined;
  return e8.expandFileName(e8.readFileName("File: ", { initial: String(v("dir-locals-file") ?? ".dir-locals.el") }));
}

e8.defineCommand({
  name: "add-dir-local-variable",
  doc:
    "Add a directory-local variable with its value, read as Lisp, for a mode or subdirectory, to the .dir-locals.el " +
    "of the visited file's directory or the one above it, making it in this directory if there is none. With a prefix " +
    "argument, ask which file.",
  params: [modeParam, { name: "variable", prompt: "Add directory-local variable: ", collection: variableNames }, valueParam, { name: "file", kind: "prefix" }],
  run: (mode: string, variable: string, value: string, prefix: e8.PrefixArg) => {
    const m = modeOrSubdirectory(mode === "" ? String(v("major-mode") ?? "nil") : mode);
    modifyDirLocalVariable(m, variable, readValue(variable, value), "add-or-replace", dirLocalsFileParam(prefix));
  },
});

e8.defineCommand({
  name: "delete-dir-local-variable",
  doc: "Delete every setting of a directory-local variable for a mode or subdirectory from the .dir-locals.el. With a prefix argument, ask which file.",
  params: [modeParam, { name: "variable", prompt: "Delete directory-local variable: ", collection: variableNames }, { name: "file", kind: "prefix" }],
  run: (mode: string, variable: string, prefix: e8.PrefixArg) => {
    const m = modeOrSubdirectory(mode === "" ? String(v("major-mode") ?? "nil") : mode);
    modifyDirLocalVariable(m, variable, null, "delete", dirLocalsFileParam(prefix));
  },
});

e8.defineCommand({
  name: "copy-file-locals-to-dir-locals",
  doc: "Copy the file's local variables, for its major mode, to the .dir-locals.el. With a prefix argument, ask which file.",
  params: [{ name: "file", kind: "prefix" }],
  run: (prefix: e8.PrefixArg) => {
    const file = dirLocalsFileParam(prefix);
    const mode = sym(String(v("major-mode")));
    const pairs = (v("file-local-variables-alist") as [symbol, e8.Value][] | null) ?? [];
    const dirPairs = (v("dir-local-variables-alist") as [symbol, e8.Value][] | null) ?? [];
    const source = e8.currentBuffer();
    for (const [variable, value] of pairs) {
      if (dirPairs.some((p) => p[0] === variable)) continue;
      e8.withCurrentBuffer(source, () => modifyDirLocalVariable(mode, e8.symbolName(variable), value, "add-or-replace", file));
    }
  },
});

e8.defineCommand({
  name: "copy-dir-locals-to-file-locals",
  doc: "Copy the directory-local variables to the file's Local Variables list.",
  run: () => {
    for (const [variable, value] of (v("dir-local-variables-alist") as [symbol, e8.Value][] | null) ?? []) {
      modifyFileLocalVariable(e8.symbolName(variable), value, "add-or-replace");
    }
  },
});

e8.defineCommand({
  name: "copy-dir-locals-to-file-locals-prop-line",
  doc: "Copy the directory-local variables to the file's -*- line.",
  run: () => {
    for (const [variable, value] of (v("dir-local-variables-alist") as [symbol, e8.Value][] | null) ?? []) {
      modifyFileLocalVariablePropLine(e8.symbolName(variable), value, "add-or-replace");
    }
  },
});
