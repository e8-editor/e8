// Indentation, after Emacs's indent.el. A major mode says how to indent a
// line by setting indent-line-function; indent-according-to-mode runs it.
// The default, indent-relative, is for tabbing rather than indenting, so
// indent-according-to-mode indents such lines as the line before them.

import { numberValue as num } from "subr";

e8.defineVariable({
  name: "indent-line-function",
  doc: "The command that indents the current line, as the major mode says. indent-according-to-mode runs it.",
  value: "indent-relative",
  local: true,
});
e8.defineVariable({
  name: "indent-region-function",
  doc: "A function of the region's start and end that indents it, as the major mode says, as Org mode's org-indent-region; nil to indent it a line at a time with indent-line-function.",
  value: null,
  local: true,
});
e8.defineVariable({
  name: "indent-line-ignored-functions",
  doc: "Values of indent-line-function that only tab, so indent-according-to-mode indents as the line before instead.",
  value: ["indent-relative", "indent-relative-maybe", "indent-relative-first-indent-point"],
});


/** The column a line's text starts at, as current-indentation. */
const currentIndentation = (line: number): number => e8.currentIndentation(e8.lineStart(line));

e8.defineCommand({
  name: "indent-according-to-mode",
  doc: "Indent the current line as the major mode says, through indent-line-function.",
  run: () => {
    const fn = e8.variable("indent-line-function");
    const ignored = e8.variable("indent-line-ignored-functions");
    if (typeof fn === "string" && !(Array.isArray(ignored) && ignored.includes(fn))) {
      // A function or a command, as Emacs funcalls it.
      e8.funcall(fn);
      return;
    }
    // As the line before, or none after a blank line.
    const line = e8.lineOf(e8.point());
    const column = line === 0 || /^[ \t]*$/.test(e8.lineText(line - 1)) ? 0 : currentIndentation(line - 1);
    if (e8.currentColumn() <= currentIndentation(line)) {
      e8.indentLineTo(column);
    } else {
      const p = e8.makeMarker();
      e8.indentLineTo(column);
      e8.gotoChar(e8.markerPosition(p)!);
      e8.deleteMarker(p);
    }
  },
});

e8.defineVariable({
  name: "tab-always-indent",
  doc: "Whether TAB always indents the line, as t; nil indents only in the indentation and inserts a tab elsewhere.",
  value: true,
});


/** Moves to the next tab stop, deleting the whitespace before point first, as tab-to-tab-stop. */
function tabToTabStop(): void {
  const tab = num("tab-width", 8);
  const next = (Math.floor(e8.currentColumn() / tab) + 1) * tab;
  let a = e8.point();
  while (a > e8.lineBeginningPosition() && " \t".includes(e8.bufferText(a - 1, a))) a--;
  e8.deleteRegion(a, e8.point());
  e8.gotoChar(a);
  e8.indentTo(next);
}

e8.defineCommand({
  name: "tab-to-tab-stop",
  doc: "Insert whitespace up to the next tab stop, every tab-width columns.",
  run: () => tabToTabStop(),
});

e8.defineCommand({
  name: "indent-relative",
  doc:
    "Indent from point to under the next start of a word on the line above, or to the next tab stop if there is none. " +
    "This is how Fundamental and Text mode indent.",
  run: () => {
    const start = e8.currentColumn();
    let indent: number | undefined;
    // The nearest line above that is not empty.
    let line = e8.lineOf(e8.point()) - 1;
    while (line >= 0 && e8.lineText(line) === "") line--;
    if (line >= 0) {
      const here = e8.point();
      const end = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : e8.bufferSize();
      e8.gotoChar(e8.lineStart(line));
      e8.moveToColumn(start);
      if (e8.currentColumn() > start) e8.gotoChar(e8.point() - 1);
      let p = e8.point();
      const at = (q: number) => e8.bufferText(q, q + 1);
      if (!" \t".includes(at(p))) while (p < end && !" \t\n".includes(at(p))) p++;
      while (p < end && " \t".includes(at(p))) p++;
      e8.gotoChar(p);
      if (p < end && at(p) !== "\n") indent = e8.currentColumn();
      e8.gotoChar(here);
    }
    if (indent !== undefined) {
      const m = e8.makeMarker();
      e8.indentTo(indent);
      if (e8.markerPosition(m)! > e8.point()) e8.gotoChar(e8.markerPosition(m)!);
      e8.deleteMarker(m);
    } else {
      tabToTabStop();
    }
  },
});

/**
 * The lines from the region's start to its end, the end's own line left out
 * if the end is at its start. With `whole`, the start's line too is left
 * out unless the region starts at its beginning, as indent-rigidly's
 * (or (bolp) (forward-line 1)) does.
 */
function regionLines(whole = false): [number, number] {
  const mark = e8.mark();
  if (mark === undefined) e8.userError("The mark is not set now, so there is no region");
  const [a, b] = [Math.min(e8.point(), mark), Math.max(e8.point(), mark)];
  let last = e8.lineOf(b);
  if (b === e8.lineStart(last) && last > e8.lineOf(a)) last--;
  const first = e8.lineOf(a) + (whole && a !== e8.lineStart(e8.lineOf(a)) ? 1 : 0);
  return [first, last];
}

/** Indents each line of the region that is not empty, as indent-region does line by line. */
function indentRegion(first: number, last: number): void {
  const p = e8.makeMarker();
  for (let line = first; line <= last; line++) {
    e8.gotoChar(e8.lineStart(line));
    if (e8.lineText(line) === "") continue;
    e8.call("indent-according-to-mode");
  }
  e8.gotoChar(e8.markerPosition(p)!);
  e8.deleteMarker(p);
}

/** Moves each line of the region by `n` columns, as indent-rigidly. */
function indentRigidly(first: number, last: number, n: number): void {
  const p = e8.makeMarker();
  for (let line = first; line <= last; line++) {
    const text = e8.lineText(line);
    e8.gotoChar(e8.lineStart(line));
    const ws = /^[ \t]*/.exec(text)![0].length;
    const target = Math.max(0, currentIndentation(line) + n);
    e8.deleteRegion(e8.point(), e8.point() + ws);
    // Lines with nothing on them stay empty.
    if (ws < text.length) e8.indentTo(target);
  }
  e8.gotoChar(e8.markerPosition(p)!);
  e8.deleteMarker(p);
}

const regionFunction = () => e8.variable("indent-region-function");

e8.defineCommand({
  name: "indent-region",
  doc:
    "Indent each non-empty line of the region as the major mode says. " +
    "With a prefix argument, indent each to that column instead.",
  run: () => {
    const arg = e8.prefixArg();
    const [first, last] = regionLines(arg !== null);
    if (arg !== null) {
      const column = e8.prefixNumericValue(arg);
      for (let line = first; line <= last; line++) indentRigidly(line, line, column - currentIndentation(line));
    } else {
      const mark = e8.mark() as number;
      indentRegionBetween(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
    }
    e8.deactivateMark();
  },
});

/**
 * Indents each non-empty line from `start` to `end` as the major mode says,
 * by its indent-region-function or line by line, with the buffer widened,
 * as Emacs's indent-region does without a column.
 */
export function indentRegionBetween(start: number, end: number): void {
  if (typeof regionFunction() === "string" || typeof regionFunction() === "function") {
    const pt = e8.makeMarker();
    e8.saveRestriction(() => {
      e8.widen();
      e8.funcall(regionFunction() as string, start, end);
    });
    e8.gotoChar(e8.markerPosition(pt)!);
    e8.deleteMarker(pt);
    return;
  }
  let last = e8.lineOf(end);
  if (end === e8.lineStart(last) && last > e8.lineOf(start)) last--;
  e8.saveRestriction(() => {
    e8.widen();
    indentRegion(e8.lineOf(start), last);
  });
}

/** One step of indent-rigidly's keys: a column, or to the tab stop before or after the least indentation. */
function rigidStep(n: number | "left-tab" | "right-tab"): void {
  const [first, last] = regionLines(true);
  const tab = num("tab-width", 8);
  const lines = [...Array(last - first + 1).keys()].map((i) => first + i).filter((l) => e8.lineText(l).trim() !== "");
  const least = lines.length === 0 ? 0 : Math.min(...lines.map(currentIndentation));
  const delta = n === "left-tab" ? -(least % tab || tab) : n === "right-tab" ? tab - (least % tab) : n;
  indentRigidly(first, last, delta);
  e8.activateMark();
  armRigidMap();
}

const rigidKeys = {
  "<left>": e8.defineCommand({ name: "indent-rigidly-left", doc: "Move the region's lines left a column.", run: () => rigidStep(-1) }),
  "<right>": e8.defineCommand({ name: "indent-rigidly-right", doc: "Move the region's lines right a column.", run: () => rigidStep(1) }),
  "S-<left>": e8.defineCommand({
    name: "indent-rigidly-left-to-tab-stop",
    doc: "Move the region's lines left to a tab stop.",
    run: () => rigidStep("left-tab"),
  }),
  "S-<right>": e8.defineCommand({
    name: "indent-rigidly-right-to-tab-stop",
    doc: "Move the region's lines right to a tab stop.",
    run: () => rigidStep("right-tab"),
  }),
};
const armRigidMap = (): void => e8.setTransientMap(rigidKeys);

e8.defineCommand({
  name: "indent-rigidly",
  doc:
    "Move the region's lines right by as many columns as the prefix argument says, or left if negative. " +
    "Without one, adjust them with <left> and <right>, by one column, or S-<left> and S-<right> to tab stops.",
  run: () => {
    const arg = e8.prefixArg();
    if (arg !== null) {
      const [first, last] = regionLines(true);
      indentRigidly(first, last, e8.prefixNumericValue(arg));
      return;
    }
    e8.message("Indent region with <left>, <right>, <S-left>, or <S-right>.");
    e8.activateMark();
    armRigidMap();
  },
});

e8.defineCommand({
  name: "indent-for-tab-command",
  doc:
    "Indent the current line as the major mode says, or the region if it is active. " +
    "With tab-always-indent nil, insert a tab instead when point is past the indentation.",
  run: () => {
    if (e8.regionActive() && e8.mark() !== undefined && e8.mark() !== e8.point()) {
      // indent-region, so a mode's indent-region-function, as Org's, does it.
      e8.call("indent-region");
      e8.deactivateMark();
      return;
    }
    const fn = e8.variable("indent-line-function");
    const always = e8.variable("tab-always-indent");
    const line = e8.lineOf(e8.point());
    if (
      fn === "indent-to-left-margin" ||
      (always === false && (e8.currentColumn() > currentIndentation(line) || e8.lastCommand() === e8.thisCommand()))
    ) {
      e8.insert("\t".repeat(Math.max(1, e8.prefixNumericValue(e8.prefixArg()))));
      return;
    }
    e8.funcall(typeof fn === "string" ? fn : "indent-relative");
  },
});

e8.bindKey("C-M-\\", "indent-region");
e8.bindKey("C-x TAB", "indent-rigidly");
e8.bindKey("M-i", "tab-to-tab-stop");
