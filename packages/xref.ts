// The *xref* buffer, after Emacs's xref.el: places found in files, grouped
// by file, each line its line number and text. n and p move between them,
// showing each in another window; RET visits one, TAB visits it and quits
// the buffer, and next-error steps through them. project-find-regexp (C-x
// p g) fills it.

import { eraseBuffer } from "subr";

e8.defineFace({ name: "xref-file-header", doc: "The file names heading *xref*'s groups.", attributes: { inherit: "compilation-info" } });
e8.defineFace({ name: "xref-line-number", doc: "Line numbers in *xref*.", attributes: { inherit: "compilation-line-number" } });
e8.defineFace({ name: "xref-match", doc: "What matched, in *xref*.", attributes: { inherit: "match" } });

/** A place found: its file, line and column, and the text shown for it. */
export type Xref = { file: string; line: number; col: number; length: number; summary: string; group: string };

/** Grep's extended regexps for Emacs's, as xref--regexp-to-extended: groups and alternatives unescaped. */
const toExtended = (re: string): string => re.replace(/\\([(){}|])|([(){}|])/g, (_, escaped, plain) => (escaped ?? `\\${plain}`));

/**
 * The matches of an Emacs regexp in files, named relative to `dir`, as
 * xref-matches-in-files: grep over the files, their names from standard
 * input, grouped by file.
 */
export function matchesInFiles(regexp: string, files: string[], dir: string, fold = false): Xref[] {
  const result = e8.callProcess(
    ["xargs", "-0", "grep", ...(fold ? ["-i"] : []), "--null", "-snHE", "-e", toExtended(regexp)],
    { directory: dir, input: files.join("\0") },
  );
  // grep says 1 for no matches; more is a failure, as of the regexp.
  if (result.exit > 1 && !/\0\d+:/.test(result.output)) e8.userError(`Search failed with status ${result.exit}: ${result.output.trim()}`);
  let js: RegExp | undefined;
  try {
    js = new RegExp(toExtended(regexp).replace(/\\</g, "\\b").replace(/\\>/g, "\\b"), fold ? "iu" : "u");
  } catch {
    js = undefined;
  }
  return result.output
    .split("\n")
    .map((line) => /^([^\0]+)\0(\d+):(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const hit = js?.exec(m[3]);
      // In characters, as buffer positions count them.
      const col = hit ? [...m[3].slice(0, hit.index)].length : 0;
      const length = hit ? [...hit[0]].length : 0;
      return { file: m[1].startsWith("/") ? m[1] : dir + m[1], line: Number(m[2]), col, length, summary: m[3], group: m[1] };
    });
}

/** What each *xref* buffer shows, kept by buffer so renaming it keeps it. */
const shown = new Map<e8.Buffer, { byLine: Map<number, Xref>; current?: number }>();
e8.addHook("kill-buffer-hook", () => shown.delete(e8.currentBuffer()));

/** Shows places in *xref*, grouped by file as xref--insert-xrefs does, and selects it. */
function showXrefs(xrefs: Xref[]): void {
  const name = "*xref*";
  e8.getBufferCreate(name);
  const byLine = new Map<number, Xref>();
  e8.withCurrentBuffer(name, () => {
    e8.setReadOnly(false);
    eraseBuffer();
    e8.call("xref--xref-buffer-mode");
    const groups = new Map<string, Xref[]>();
    for (const x of xrefs) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
    for (const [group, items] of groups) {
      const start = e8.point();
      e8.insert(`${group}\n`);
      e8.putTextProperty(start, start + group.length, "face", "xref-file-header");
      const width = String(Math.max(...items.map((x) => x.line))).length;
      let previous: number | undefined;
      for (const x of items) {
        // Hits on one line share it, as xref shows them.
        if (x.line === previous) continue;
        previous = x.line;
        const at = e8.point();
        const prefix = `${String(x.line).padStart(width)}:`;
        e8.insert(`${prefix}${x.summary}\n`);
        e8.putTextProperty(at, at + width, "face", "xref-line-number");
        const matchAt = at + prefix.length + x.col;
        if (x.length > 0) e8.addFaceTextProperty(matchAt, matchAt + x.length, "xref-match");
        byLine.set(e8.lineOf(at), x);
      }
    }
    e8.setReadOnly(true);
    e8.setBufferModified(false);
    e8.gotoChar(0);
  });
  shown.set(e8.getBuffer(name)!, { byLine });
  e8.setVariable("next-error-last-buffer", e8.getBuffer(name) ?? null);
  e8.call("pop-to-buffer", name);
}

// For code that finds places, as project-find-regexp: a list of { file, line, col, length, summary, group }.
e8.defun("xref-show-xrefs", showXrefs);

function items(buffer: e8.BufferLike = e8.currentBuffer()) {
  const b = e8.getBuffer(buffer);
  const s = b === undefined ? undefined : shown.get(b);
  if (s === undefined) throw new Error("Not in an xref buffer");
  return s;
}

/** Goes to a place's line and to its column there, counted in characters as forward-char goes. */
function gotoXref(x: Xref): void {
  const line = Math.min(x.line - 1, e8.lineCount() - 1);
  e8.gotoChar(Math.min(e8.lineStart(line) + x.col, e8.lineEnd(line)));
}

/** Shows a place in another window, selecting it if `select`, as xref--show-location. */
function showLocation(x: Xref, select: boolean): void {
  const from = e8.selectedWindow();
  const buffer = e8.findFileNoselect(x.file);
  e8.call("pop-to-buffer", buffer);
  // Not the xref window itself.
  if (e8.selectedWindow() === from) e8.call("switch-to-buffer-other-window", buffer);
  gotoXref(x);
  if (!select) e8.selectWindow(from);
}

/** Moves to the next or earlier place from point's line, as xref--search-property. */
function moveToItem(n: number): Xref {
  const s = items();
  const lines = [...s.byLine.keys()].sort((a, b) => a - b);
  const here = e8.lineOf(e8.point());
  const target = n > 0 ? lines.filter((l) => l > here)[n - 1] : lines.filter((l) => l < here).reverse()[-n - 1];
  if (target === undefined) throw new Error(n > 0 ? "No next xref" : "No previous xref");
  e8.gotoChar(e8.lineStart(target));
  return s.byLine.get(target)!;
}

const itemAtPoint = (): Xref => {
  const x = items().byLine.get(e8.lineOf(e8.point()));
  if (x === undefined) e8.userError("No reference at point");
  return x;
};

e8.defineCommand({
  name: "xref-next-line",
  doc: "Move to the next place and show it in another window.",
  run: () => showLocation(moveToItem(e8.prefixNumericValue(e8.prefixArg())), false),
});
e8.defineCommand({
  name: "xref-prev-line",
  doc: "Move to the place before and show it in another window.",
  run: () => showLocation(moveToItem(-e8.prefixNumericValue(e8.prefixArg())), false),
});
e8.defineCommand({
  name: "xref-goto-xref",
  doc: "Visit the place at point in another window.",
  run: () => showLocation(itemAtPoint(), true),
});
e8.defineCommand({
  name: "xref-show-location-at-point",
  doc: "Show the place at point in another window, keeping this one selected.",
  run: () => showLocation(itemAtPoint(), false),
});
e8.defineCommand({
  name: "xref-quit-and-goto-xref",
  doc: "Quit *xref* and visit the place at point.",
  run: () => {
    const x = itemAtPoint();
    e8.call("quit-window");
    const buffer = e8.findFileNoselect(x.file);
    e8.call("switch-to-buffer", buffer);
    gotoXref(x);
  },
});

/** Moves to the next file's group, as xref-next-group. */
function moveGroup(n: number): void {
  const s = items();
  const lines = [...s.byLine.keys()].sort((a, b) => a - b);
  const group = (l: number) => s.byLine.get(l)!.group;
  const here = e8.lineOf(e8.point());
  const current = s.byLine.has(here) ? group(here) : undefined;
  const firsts = lines.filter((l, i) => i === 0 || group(lines[i - 1]) !== group(l));
  const target = n > 0 ? firsts.find((l) => l > here && group(l) !== current) : firsts.filter((l) => l < here && group(l) !== current).pop();
  if (target !== undefined) {
    e8.gotoChar(e8.lineStart(target));
    showLocation(s.byLine.get(target)!, false);
  }
}
e8.defineCommand({ name: "xref-next-group", doc: "Move to the first place in the next file.", run: () => moveGroup(1) });
e8.defineCommand({ name: "xref-prev-group", doc: "Move to the first place in the file before.", run: () => moveGroup(-1) });

/** Visits the place `n` places on in an xref buffer, from the first if `reset`, as next-error does there. */
function xrefNextError(n: number, reset: boolean): void {
  const buffer = e8.bufferName();
  const s = items(buffer);
  const lines = [...s.byLine.keys()].sort((a, b) => a - b);
  const from = reset || s.current === undefined ? -1 : s.current;
  const target =
    n === 0 && s.current !== undefined
      ? s.current
      : n >= 0
        ? lines.filter((l) => l > from)[Math.max(n, 1) - 1]
        : lines.filter((l) => l < from).reverse()[-n - 1];
  if (target === undefined) throw new Error(n < 0 ? "No previous xref" : "No next xref");
  s.current = target;
  const window = e8.windowList().find((w) => e8.windowBuffer(w) === buffer);
  if (window !== undefined) {
    const selected = e8.selectedWindow();
    e8.selectWindow(window);
    e8.gotoChar(e8.lineStart(target));
    e8.selectWindow(selected);
  }
  const x = s.byLine.get(target)!;
  const file = e8.findFileNoselect(x.file);
  if (window === e8.selectedWindow()) e8.call("pop-to-buffer", file);
  else e8.call("switch-to-buffer", file);
  gotoXref(x);
}
e8.defun("xref--next-error-function", xrefNextError);

e8.defineMajorMode({
  name: "xref--xref-buffer-mode",
  modeName: "XREF",
  doc: "The mode of *xref*: places found, by file. n and p show the next and previous, RET visits one, TAB visits it and quits, q quits.",
  bindings: {
    n: "xref-next-line",
    p: "xref-prev-line",
    ".": "xref-next-line",
    ",": "xref-prev-line",
    N: "xref-next-group",
    P: "xref-prev-group",
    RET: "xref-goto-xref",
    TAB: "xref-quit-and-goto-xref",
    "C-o": "xref-show-location-at-point",
    q: "quit-window",
  },
  setup: () => {
    e8.setVariable("next-error-function", "xref--next-error-function");
  },
});

// --- Finding definitions and references, as xref.el's xref-find-definitions --

/**
 * What a backend does, as xref's generic functions: the identifier at
 * point, and the places that define it or refer to it. eglot is one.
 */
export interface XrefBackend {
  identifierAtPoint(): string | undefined;
  definitions(identifier: string): Xref[];
  references(identifier: string): Xref[];
}

const backends = new Map<string, XrefBackend>();

/** Names a backend, which a function on xref-backend-functions gives by name, as cl-defmethod defines one. */
export function defineXrefBackend(name: string, backend: XrefBackend): void {
  backends.set(name, backend);
}

e8.defineHook(
  "xref-backend-functions",
  "Functions that give the name of the xref backend for the current buffer, tried in turn, as defineXrefBackend names them.",
);

/** The symbol at point, by the syntax table, as the default backend's identifier. */
function symbolAtPoint(): string | undefined {
  return e8.saveExcursion(() => {
    e8.skipSyntaxBackward("w_");
    const start = e8.point();
    e8.skipSyntaxForward("w_");
    return e8.point() > start ? e8.bufferText(start, e8.point()) : undefined;
  });
}

/** The backend for the current buffer, as xref-find-backend asks xref-backend-functions. */
function findBackend(): XrefBackend {
  const name = e8.runHookWithArgsUntilSuccess("xref-backend-functions");
  const backend = typeof name === "string" ? backends.get(name) : undefined;
  return backend ?? { identifierAtPoint: symbolAtPoint, definitions: () => [], references: () => [] };
}

/** Where M-. was typed, for M-, to go back to, and where M-, came from, for C-M-, as xref--history. */
const history: { back: e8.Marker[]; forward: e8.Marker[] } = { back: [], forward: [] };

function pushMarker(stack: e8.Marker[]): void {
  stack.unshift(e8.makeMarker(e8.point()));
  const max = Number(e8.variable("xref-history-max") ?? 16);
  for (const m of stack.splice(max)) e8.deleteMarker(m);
}

e8.defineVariable({ name: "xref-history-max", doc: "How many places M-, can go back to.", value: 16 });

e8.defineVariable({
  name: "xref-show-xrefs-function",
  doc: "The function that shows the places references are found, called with them: xref-show-xrefs lists them in *xref*; consult-xref reads one.",
  value: "xref-show-xrefs",
});
e8.defineVariable({
  name: "xref-show-definitions-function",
  doc: "The function that shows several definitions, called with them, as xref-show-xrefs-function shows references.",
  value: "xref-show-xrefs",
});

/** Shows places with the function a variable names, as xref--show-xrefs does. */
function showWith(variable: string, xrefs: Xref[]): void {
  const fn = e8.variable(variable);
  if (fn === "xref-show-xrefs" || fn === null || fn === undefined) showXrefs(xrefs);
  else e8.funcall(fn as string, xrefs);
}

/** Goes to one place, or lists several, as xref--show-xrefs does for definitions. */
function showOrGo(xrefs: Xref[], kind: string, identifier: string): void {
  if (xrefs.length === 0) e8.userError(`No ${kind} found for: ${identifier}`);
  pushMarker(history.back);
  for (const m of history.forward.splice(0)) e8.deleteMarker(m);
  if (xrefs.length === 1) {
    e8.call("switch-to-buffer", e8.findFileNoselect(xrefs[0].file));
    gotoXref(xrefs[0]);
  } else showWith("xref-show-definitions-function", xrefs);
}

/** Reads the identifier, asking with a prompt when there is none at point or with a prefix argument, as xref--read-identifier. */
function readIdentifier(prompt: string, ask: boolean): string {
  const at = findBackend().identifierAtPoint();
  if (at !== undefined && !ask) return at;
  const answer = e8.readString(at ? `${prompt} (default ${at}): ` : `${prompt}: `, { default: at });
  if (answer === "") e8.userError("There is no default identifier");
  return answer;
}

e8.defineCommand({
  name: "xref-find-definitions",
  doc: "Go to where the identifier at point is defined, or list the places if there are several. With a prefix argument, ask for it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const id = readIdentifier("Find definitions of", arg !== null && arg !== undefined);
    showOrGo(findBackend().definitions(id), "definitions", id);
  },
});

e8.defineCommand({
  name: "xref-find-references",
  doc: "List the places that refer to the identifier at point. With a prefix argument, ask for it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const id = readIdentifier("Find references to", arg !== null && arg !== undefined);
    const xrefs = findBackend().references(id);
    if (xrefs.length === 0) e8.userError(`No references found for: ${id}`);
    pushMarker(history.back);
    showWith("xref-show-xrefs-function", xrefs);
  },
});

/** Goes to a marker of a history stack, keeping where point was on the other, as xref-go-back and xref-go-forward. */
function goAlong(from: e8.Marker[], to: e8.Marker[], none: string): void {
  const m = from.shift();
  if (!m) e8.userError(none);
  pushMarker(to);
  const buffer = e8.markerBuffer(m);
  if (buffer) {
    e8.call("switch-to-buffer", buffer);
    e8.gotoChar(e8.markerPosition(m)!);
  }
  e8.deleteMarker(m);
}

e8.defineCommand({
  name: "xref-go-back",
  doc: "Go back to where M-. or M-? was typed.",
  run: () => goAlong(history.back, history.forward, "At start of xref history"),
});
e8.defineCommand({
  name: "xref-go-forward",
  doc: "Go forward again to where M-, came from.",
  run: () => goAlong(history.forward, history.back, "At end of xref history"),
});

e8.bindKey("M-.", "xref-find-definitions");
e8.bindKey("M-?", "xref-find-references");
e8.bindKey("M-,", "xref-go-back");
e8.bindKey("C-M-,", "xref-go-forward");
