// Inline tasks, after Org's org-inlinetask.el: a heading of at least
// org-inlinetask-min-level stars, 15 by default, is a task inside the text
// of the entry it is in rather than a heading of its own, with a TODO
// keyword, tags and the rest. With an END line of the same stars it holds
// text too, as its planning line and drawers:
//
//   *************** TODO A small task
//   *************** TODO Another small task
//                   DEADLINE: <2009-03-30 Mon>
//                   And here is some extra text
//   *************** END
//
// Not preloaded: requiring it turns inline tasks on, as
// (require 'org-inlinetask) does. Org's parser makes them inlinetask
// elements, and its structure, cycling and navigation commands treat them
// as text, through the checks org.el and the rest make when the library is
// loaded, which E8's make by whether org-inlinetask-min-level is bound
// (inlinetaskStars in org-macs.ts).
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { fixupIndentation, headings, validLevel } from "org";
import { flag, folded } from "org-fold";
import { lineAt, orgRegionActive } from "org-macs";

e8.defineVariable({
  name: "org-inlinetask-min-level",
  value: 15,
  doc: "The fewest stars a heading has to be an inline task, or nil for none. Keep it at 29 or less, as clocking counts no deeper, and org-cycle-max-level unset or below it.",
});
e8.defineVariable({
  name: "org-inlinetask-show-first-star",
  value: false,
  doc: "Whether an inline task shows its first star as well as its last, as a mark that it is one.",
});
e8.defineVariable({
  name: "org-inlinetask-default-state",
  value: null,
  doc: "The TODO keyword org-inlinetask-insert-task gives a new inline task, or nil for none.",
});
e8.defineFace({ name: "org-inlinetask", doc: "An inline task's heading, after its stars.", attributes: { inherit: "shadow" } });

/** The stars an inline task has at least, 2N-1 with org-odd-levels-only. */
function minStars(): number {
  const n = Number(e8.variable("org-inlinetask-min-level"));
  return e8.variable("org-odd-levels-only") === true ? 2 * n - 1 : n;
}

/** The Emacs regexp an inline task's heading line starts with, its stars as group 1, as org-inlinetask-outline-regexp. */
export function outlineRegexp(): string {
  return `^\\(\\*\\{${minStars()},\\}\\)[ \t]+`;
}

/** Whether an Emacs regexp matches at the start of point's line, as org-match-line, its case folded. */
function matchLine(regexp: string): boolean {
  return e8.lookingAt(regexp, e8.lineStart(lineAt()), { caseFold: true });
}

/** Whether point is on an inline task's END line, as org-inlinetask-end-p. */
export function endP(): boolean {
  return matchLine(`${outlineRegexp()}END[ \t]*$`);
}

/** Whether point is on an inline task's heading line, as org-inlinetask-at-task-p. */
export function atTaskP(): boolean {
  return matchLine(`${outlineRegexp()}\\(.*\\)`) && !endP();
}

/** Whether point is in an inline task, on its heading, its END line or between them, as org-inlinetask-in-task-p. */
export function inTaskP(): boolean {
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.lineStart(lineAt()));
    if (e8.lookingAt(`${outlineRegexp()}\\(?:.*\\)`, undefined, { caseFold: true })) return true;
    return e8.reSearchForward("^\\*+[ \t]+", { noerror: true, caseFold: true }) !== undefined && endP();
  });
}

/** Goes to the start of the inline task point is in, as org-inlinetask-goto-beginning. */
export function gotoBeginning(): void {
  e8.gotoChar(e8.lineEnd(lineAt()));
  const re = outlineRegexp();
  e8.reSearchBackward(re, { noerror: true, caseFold: true });
  if (endP()) e8.reSearchBackward(re, { noerror: true, caseFold: true });
}

/** Moves a line on, as forward-line does: to the end of the buffer from the last line. */
function forwardLine(): void {
  const l = lineAt();
  e8.gotoChar(l + 1 < e8.lineCount() ? e8.lineStart(l + 1) : e8.pointMax());
}

/** Goes past the end of the inline task point is in and gives where, as org-inlinetask-goto-end. */
export function gotoEnd(): number {
  e8.gotoChar(e8.lineStart(lineAt()));
  const re = outlineRegexp();
  if (endP()) forwardLine();
  else if (e8.lookingAt(re, undefined, { caseFold: true })) {
    forwardLine();
    if (endP()) forwardLine();
    else if (e8.lookingAt(re, undefined, { caseFold: true })) {
      // The next task starts here.
    } else if (inTaskP()) {
      e8.reSearchForward(re, { noerror: true, caseFold: true });
      forwardLine();
    }
  } else {
    e8.reSearchForward(re, { noerror: true, caseFold: true });
    forwardLine();
  }
  return e8.point();
}

/** The stars of the inline task point is in, as org-inlinetask-get-task-level. */
export function getTaskLevel(): number {
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.lineEnd(lineAt()));
    e8.reSearchBackward(outlineRegexp(), { noerror: true });
    return (e8.matchEnd(1) ?? 0) - (e8.matchBeginning(1) ?? 0);
  });
}

/** Replaces the last match's group 1, as (replace-match text nil t nil 1). */
function replaceGroup1(text: string): void {
  const [b, e] = [e8.matchBeginning(1) as number, e8.matchEnd(1) as number];
  e8.saveExcursion(() => {
    e8.deleteRegion(b, e);
    e8.gotoChar(b);
    e8.insert(text);
  });
}

/** Changes the inline task's level by `by`, its END line's too, as org-inlinetask-promote and org-inlinetask-demote. */
function changeLevel(by: 1 | -1): void {
  if (!inTaskP()) e8.userError("Not in an inline task");
  e8.saveExcursion(() => {
    const lvl = getTaskLevel();
    const next = validLevel(lvl, by);
    const diff = next - lvl;
    const stars = "*".repeat(next);
    if (by < 0 && next < Number(e8.variable("org-inlinetask-min-level"))) e8.userError("Cannot promote an inline task at minimum level");
    gotoBeginning();
    const beg = e8.point();
    replaceGroup1(stars);
    gotoEnd();
    const bol = e8.lineStart(lineAt());
    if (e8.point() === e8.pointMax() && /END\s*$/.test(e8.bufferText(bol, e8.point()))) e8.gotoChar(bol);
    else e8.gotoChar(e8.lineStart(Math.max(0, lineAt() - 1)));
    if (e8.point() !== beg) {
      e8.lookingAt(outlineRegexp());
      replaceGroup1(stars);
      if (e8.variable("org-adapt-indentation") === true) fixupIndentation(lineAt(beg), diff);
    }
  });
}

e8.defineCommand({
  name: "org-inlinetask-promote",
  doc: "Promote the inline task at point, and its END line if it has one; not past org-inlinetask-min-level.",
  run: () => changeLevel(-1),
});

e8.defineCommand({
  name: "org-inlinetask-demote",
  doc: "Demote the inline task at point, and its END line if it has one.",
  run: () => changeLevel(1),
});

const insertTask = e8.defineCommand({
  name: "org-inlinetask-insert-task",
  doc:
    "Insert an inline task, with its END line, and leave point on its heading.\n\n" +
    "It starts with the TODO keyword org-inlinetask-default-state gives, unless called with a prefix argument. " +
    "With an active region, the task holds the region's text.",
  params: [{ name: "no-state", kind: "prefix" }],
  run: (noState: e8.Value) => {
    // Inside a task only at its very start, where the new one goes before it.
    const bol = (): boolean => e8.point() === e8.lineStart(lineAt());
    if (inTaskP() && !(atTaskP() && bol())) e8.userError("Cannot nest inline tasks");
    if (!bol()) e8.insert("\n");
    const indent = "*".repeat(minStars()) + " ";
    const mark = e8.mark();
    const region = orgRegionActive() && mark !== undefined;
    const rbeg = region ? Math.min(mark, e8.point()) : e8.point();
    const rend = region ? Math.max(mark, e8.point()) : e8.point();
    // The task's end first, where the region ends, which leaves its start where it was.
    e8.gotoChar(rend);
    e8.insert(`\n${indent}END\n`);
    e8.gotoChar(rbeg);
    if (!bol()) e8.insert("\n");
    const state = e8.variable("org-inlinetask-default-state");
    const withState = (noState === null || noState === undefined || noState === false) && typeof state === "string";
    e8.insert(indent + (withState ? `${state} ` : ""));
    if (rend !== rbeg) {
      e8.insert("\n");
      e8.gotoChar(e8.lineEnd(lineAt() - 1));
    }
  },
});

e8.defineKey("org-mode-map", "C-c C-x t", insertTask);

/**
 * Hides all but the last two stars of each inline task from point to
 * `limit`, the first too unless org-inlinetask-show-first-star, and shows
 * the rest of its line in the org-inlinetask face, as org-inlinetask-fontify
 * does from org-font-lock-hook.
 */
function fontify(limit: number): void {
  const level = e8.variable("org-inlinetask-min-level");
  const n = typeof level === "number" ? level : 200;
  const nstars = e8.variable("org-odd-levels-only") === true ? 2 * n - 1 : n;
  const re = new RegExp(`^(\\*)(\\*{${Math.max(0, nstars - 3)},})(\\*\\* .*)`);
  const showFirst = e8.variable("org-inlinetask-show-first-star") === true;
  // Virtual indentation puts the warning face on the first star, so then it is only hidden.
  const perLevel = Number(e8.variable("org-indent-indentation-per-level") ?? 2);
  const startFace = e8.variable("org-indent-mode") === true && perLevel > 1 ? "org-hide" : "org-warning";
  for (let line = lineAt(); line < e8.lineCount() && e8.lineStart(line) < limit; line++) {
    const m = re.exec(e8.lineText(line));
    if (!m) continue;
    const ls = e8.lineStart(line);
    const second = ls + 1;
    const third = second + m[2].length;
    if (showFirst) e8.putTextProperty(ls, second, "face", startFace);
    e8.putTextProperty(showFirst ? second : ls, third, "face", "org-hide");
    e8.putTextProperty(third, third + [...m[3]].length, "face", "org-inlinetask");
  }
}

/**
 * Folds or unfolds the text of the inline task at point, its heading line
 * left showing, as org-inlinetask-toggle-visibility: "fold" folds and
 * "unfold" unfolds whatever it was.
 */
export function toggleVisibility(state?: string): void {
  const end = e8.saveExcursion(() => {
    gotoEnd();
    return e8.point() === e8.lineStart(lineAt()) ? e8.point() - 1 : e8.point();
  });
  const start = e8.saveExcursion(() => {
    gotoBeginning();
    return e8.lineEnd(lineAt());
  });
  if (end === start) return;
  if (state !== "fold" && (state === "unfold" || folded(start + 1, "outline"))) flag(start, end, false);
  else flag(start, end, true);
}

/** Folds the inline tasks of the buffer, or of the subtree, after S-TAB's contents and TAB's children, as org-inlinetask-hide-tasks on org-cycle-hook. */
export function hideTasks(state: string): void {
  if (state === "contents") {
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMin());
      while (e8.reSearchForward(outlineRegexp(), { noerror: true, caseFold: true }) !== undefined) {
        toggleVisibility("fold");
        gotoEnd();
      }
    });
  } else if (state === "children") {
    e8.saveExcursion(() => {
      while (atTaskP() || (outlineNextHeading() && atTaskP())) {
        toggleVisibility("fold");
        gotoEnd();
      }
    });
  }
}

/** Goes to the next heading line, an inline task's too, as outline-next-heading: whether there is one, else to the end. */
function outlineNextHeading(): boolean {
  const from = e8.point() === e8.lineStart(lineAt()) && e8.point() < e8.pointMax() ? e8.point() + 1 : e8.point();
  const next = headings().find((h) => h.start >= from);
  e8.gotoChar(next ? next.start : e8.pointMax());
  return next !== undefined;
}

/** Removes an END line, and the blank lines before it, at point, as org-inlinetask-remove-END-maybe. */
export function removeENDMaybe(): void {
  if (e8.lookingAt(`\\([ \t]*\n\\)*\\*\\{${Number(e8.variable("org-inlinetask-min-level"))},\\}[ \t]+END[ \t]*$`)) {
    e8.deleteRegion(e8.matchBeginning() as number, e8.matchEnd() as number);
  }
}

// By their Org names too, for Org's own files to call when this is loaded,
// as they do (featurep 'org-inlinetask).
e8.defun("org-inlinetask-outline-regexp", outlineRegexp);
e8.defun("org-inlinetask-end-p", endP);
e8.defun("org-inlinetask-at-task-p", atTaskP);
e8.defun("org-inlinetask-in-task-p", inTaskP);
e8.defun("org-inlinetask-goto-beginning", gotoBeginning);
e8.defun("org-inlinetask-goto-end", gotoEnd);
e8.defun("org-inlinetask-get-task-level", getTaskLevel);
e8.defun("org-inlinetask-toggle-visibility", (state?: e8.Value) => toggleVisibility(typeof state === "string" ? state : typeof state === "symbol" ? e8.symbolName(state) : undefined));
e8.defun("org-inlinetask-hide-tasks", (state: e8.Value) => hideTasks(typeof state === "symbol" ? e8.symbolName(state) : String(state)));
e8.defun("org-inlinetask-remove-END-maybe", removeENDMaybe);
e8.defun("org-inlinetask-fontify", (limit: e8.Value) => fontify(Number(limit)));

e8.addHook("org-font-lock-hook", "org-inlinetask-fontify");
e8.addHook("org-cycle-hook", "org-inlinetask-hide-tasks");
