// Numbering headings as they show, without changing the text, after Org's
// org-num.el: org-num-mode puts an overlay on each heading's stars whose
// after-string is its number, 1, 1.1, 1.2 and so on, kept up to date as
// headings are added, removed and changed. Commented subtrees, footnote
// sections, subtrees with some tags or an UNNUMBERED property can be left
// out, and levels below org-num-max-level.
//
// Copyright (C) 2018-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { headings, headingIndex, parseHeading, propertyInheritP, reducedLevel, entryGetInherited } from "org";
import { entryGet } from "org-list";
import { lineAt } from "org-macs";
import { PerBuffer, truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "org-num-face",
  null,
  "Face to use for numbering; nil for the heading's own. Ignored where org-num-format-function's string has a face of its own.",
);
defvar(
  "org-num-format-function",
  "org-num-default-format",
  "Function used to display numbering: called with a list of numbers, it returns a string, or nil for none. A face on the string overrides org-num-face.",
);
defvar("org-num-max-level", null, "Level below which headlines are not numbered; nil numbers them all.");
defvar("org-num-skip-commented", false, "Whether commented subtrees are left unnumbered.");
defvar("org-num-skip-footnotes", false, "Whether footnote sections are left unnumbered.");
defvar(
  "org-num-skip-tags",
  [],
  "Tags whose subtrees are left unnumbered, whatever org-use-tag-inheritance says, as ARCHIVE to leave archived subtrees out.",
);
defvar("org-num-skip-unnumbered", false, "Whether numbering obeys the UNNUMBERED property.");

/** A buffer's numbering, as org-num's buffer-local variables hold it. */
interface NumState {
  /** The numbering overlays, in order, as org-num--overlays. */
  overlays: number[];
  /** The level below which the current tree is not numbered, as org-num--skip-level. */
  skipLevel: number | undefined;
  /** The current numbering, reversed: (3 2 1) for 1.2.3, as org-num--numbering. */
  numbering: number[] | undefined;
  /** Where a heading has no overlay yet, as org-num--missing-overlay. */
  missingOverlay: number | undefined;
  /** Whether an overlay became invalid since the last update, as org-num--invalid-flag. */
  invalidFlag: boolean;
}

const states = new PerBuffer<NumState>();

function state(): NumState {
  let s = states.get(e8.currentBuffer());
  if (s === undefined) {
    s = { overlays: [], skipLevel: undefined, numbering: undefined, missingOverlay: undefined, invalidFlag: false };
    states.set(e8.currentBuffer(), s);
  }
  return s;
}

/** The regexp a numbered heading matches, as org-num--headline-regexp. */
function headlineRegexp(): string {
  const max = e8.variable("org-num-max-level");
  if (typeof max !== "number") return "^\\*+ ";
  return `^\\*\\{1,${e8.variable("org-odd-levels-only") === true ? 2 * max - 1 : max}\\} `;
}

/** Whether overlay O is still valid, as org-num--valid-overlay-p. */
const validOverlayP = (o: number): boolean => e8.overlayGet(o, "org-num") !== e8.intern("invalid");

/** Marks overlay O invalid, as org-num--invalidate-overlay. */
function invalidateOverlay(o: number): void {
  // An edit's hooks after it can reach an overlay the update deleted, which keeps no properties in E8.
  if (e8.overlayStart(o) !== undefined) e8.overlayPut(o, "org-num", e8.intern("invalid"));
  state().invalidFlag = true;
}

/** Removes every numbering overlay, as org-num--clear. */
function clear(): void {
  const s = state();
  for (const o of s.overlays) e8.deleteOverlay(o);
  s.overlays = [];
}

/** The face of a heading of LEVEL, as org-num--make-overlay works it out from org-level-faces. */
function levelFaceOf(level: number): string {
  const n = Math.max(1, Math.min(8, Number(e8.variable("org-n-level-faces") ?? 8) || 8));
  return `org-level-${truthy(e8.variable("org-cycle-level-faces") ?? true) ? ((level - 1) % n) + 1 : Math.min(level, n)}`;
}

/** An overlay numbering the heading at point, as org-num--make-overlay. */
function makeOverlay(numbering: number[] | undefined, level: number, skip: boolean): number {
  const bol = e8.lineStart(lineAt());
  let stars = bol;
  while (e8.bufferText(stars, stars + 1) === "*") stars++;
  const o = e8.makeOverlay(bol, stars + 1);
  const hook = (ov: number): void => invalidateOverlay(ov);
  e8.overlayPut(o, "org-num", true);
  e8.overlayPut(o, "skip", skip);
  e8.overlayPut(o, "level", level);
  const face = e8.variable("org-num-face");
  e8.overlayPut(o, "numbering-face", truthy(face) ? (face as e8.Value) : levelFaceOf(level));
  e8.overlayPut(o, "modification-hooks", [hook]);
  e8.overlayPut(o, "insert-in-front-hooks", [hook]);
  refreshDisplay(o, numbering);
  return o;
}

/** Sets OVERLAY's after-string for NUMBERING, or none, as org-num--refresh-display. */
function refreshDisplay(overlay: number, numbering: number[] | undefined): void {
  let display: e8.Value = null;
  if (numbering !== undefined) {
    const fn = e8.variable("org-num-format-function");
    display = (truthy(fn) ? e8.funcall(fn as any, [...numbering].reverse()) : null) ?? null;
  }
  if (display instanceof e8.PropertizedString) {
    if (!display.properties.some(([from, , props]) => from === 0 && props.face !== undefined))
      display = e8.concat(e8.propertize(display.string, { face: e8.overlayGet(overlay, "numbering-face") ?? null }));
  } else if (typeof display === "string") {
    display = e8.propertize(display, { face: e8.overlayGet(overlay, "numbering-face") ?? null });
  }
  e8.overlayPut(overlay, "after-string", display);
}

/** Whether the heading at point is to be left unnumbered, as org-num--skip-value. */
function skipValue(): boolean {
  const line = lineAt();
  const h = parseHeading(line);
  const title = h?.title;
  const tags = h?.tags ?? [];
  const skipTags = e8.variable("org-num-skip-tags");
  const section = e8.variable("org-footnote-section");
  if (truthy(e8.variable("org-num-skip-footnotes")) && typeof section === "string" && title === section) return true;
  const comment = String(e8.variable("org-comment-string") ?? "COMMENT");
  if (truthy(e8.variable("org-num-skip-commented")) && title && (title === comment || title.startsWith(`${comment} `))) return true;
  if (Array.isArray(skipTags) && skipTags.length > 0 && tags.some((t) => skipTags.includes(t))) return true;
  if (truthy(e8.variable("org-num-skip-unnumbered")) && h) {
    const value = propertyInheritP("UNNUMBERED") ? entryGetInherited(h, "UNNUMBERED", false) : entryGet(line, "UNNUMBERED");
    if (value !== undefined) return true;
  }
  return false;
}

/** The numbering of the heading at LEVEL with SKIP, or undefined if it is skipped, as org-num--current-numbering. */
function currentNumbering(level: number, skip: boolean): number[] | undefined {
  const s = state();
  if (s.skipLevel !== undefined && level > s.skipLevel) return undefined;
  if (skip) {
    s.skipLevel = level;
    return undefined;
  }
  s.skipLevel = undefined;
  const numbering = s.numbering;
  const last = numbering?.length ?? 0;
  if (numbering === undefined) s.numbering = [1, ...new Array(level - 1).fill(0)];
  else if (level === last) s.numbering = [numbering[0] + 1, ...numbering.slice(1)];
  else if (level < last) {
    const suffix = numbering.slice(last - level);
    s.numbering = [suffix[0] + 1, ...suffix.slice(1)];
  } else s.numbering = [1, ...new Array(level - last - 1).fill(0), ...numbering];
  return s.numbering;
}

/** Numbers the headings after START up to END, the buffer's ends for undefined, returning the overlays made, newest first, as org-num--number-region. */
function numberRegion(start: number | undefined, end: number | undefined): number[] {
  return e8.saveExcursion(() => {
    e8.gotoChar(start ?? 0);
    // Not the heading at START.
    if (start !== undefined) e8.gotoChar(e8.lineEnd(lineAt()));
    const regexp = headlineRegexp();
    const made: number[] = [];
    while (e8.reSearchForward(regexp, { bound: end, noerror: true }) !== undefined) {
      const level = reducedLevel((e8.matchEnd(0) ?? 0) - (e8.matchBeginning(0) ?? 0) - 1);
      const skip = skipValue();
      const numbering = currentNumbering(level, skip);
      made.unshift(makeOverlay(numbering, level, skip));
    }
    return made;
  });
}

/** Updates the buffer's numbering, making overlays again where they became invalid or are missing, as org-num--update. */
function update(): void {
  const s = state();
  s.skipLevel = undefined;
  s.numbering = undefined;
  // Newest first, as the Lisp pushes them.
  let fresh: number[] = [];
  const pending = s.overlays;
  while (pending.length > 0) {
    const overlay = pending.shift()!;
    if (validOverlayP(overlay)) {
      const next = e8.overlayStart(overlay) ?? 0;
      const last = fresh.length > 0 ? e8.overlayStart(fresh[0]) : undefined;
      if (s.missingOverlay === undefined) {
        // Nothing missing.
      } else if (s.missingOverlay > next) {
        // Further on.
      } else if (last === undefined || s.missingOverlay > last) {
        s.missingOverlay = undefined;
        fresh = [...numberRegion(last, next), ...fresh];
      } else s.missingOverlay = undefined;
      const numbering = currentNumbering(Number(e8.overlayGet(overlay, "level")), truthy(e8.overlayGet(overlay, "skip")));
      refreshDisplay(overlay, numbering);
      fresh.unshift(overlay);
    } else {
      // The headings between the last valid overlay and the next are numbered again.
      e8.deleteOverlay(overlay);
      while (pending.length > 0 && !validOverlayP(pending[0])) e8.deleteOverlay(pending.shift()!);
      const last = fresh.length > 0 ? e8.overlayStart(fresh[0]) : undefined;
      const next = pending.length > 0 ? e8.overlayStart(pending[0]) : undefined;
      fresh = [...numberRegion(last, next), ...fresh];
    }
  }
  if (s.missingOverlay !== undefined) {
    const last = fresh.length > 0 ? e8.overlayStart(fresh[0]) : undefined;
    fresh = [...numberRegion(last, undefined), ...fresh];
  }
  s.invalidFlag = false;
  s.overlays = fresh.reverse();
}

/** The value of the org-num property at POS and the overlay it is on, as get-char-property-and-overlay. */
function numProperty(pos: number): [e8.Value | undefined, number | undefined] {
  for (const o of e8.overlaysAt(pos)) {
    const v = e8.overlayGet(o, "org-num");
    if (v !== undefined && v !== null) return [v, o];
  }
  return [e8.getTextProperty(pos, "org-num") ?? undefined, undefined];
}

/** Checks the numbering after a change, updating it if a heading changed or was made, as org-num--verify. */
function verify(beg: number, end: number): void {
  if (e8.variable("org-num-mode") !== true) return;
  const s = state();
  s.missingOverlay = undefined;
  e8.saveExcursion(() => {
    e8.gotoChar(beg);
    const regexp = headlineRegexp();
    e8.saveExcursion(() => {
      const all = headings();
      const i = headingIndex(all, lineAt());
      if (i === undefined) return;
      e8.gotoChar(all[i].start);
      if (!e8.lookingAt(regexp)) return;
      const [value, o] = numProperty(e8.point());
      if (value === undefined) s.missingOverlay = e8.point();
      else if (value === true && o !== undefined) {
        if (skipValue() !== truthy(e8.overlayGet(o, "skip"))) invalidateOverlay(o);
      }
    });
    // Deleting the newline before a numbering overlay leaves it valid, mid-line.
    if (beg === end && e8.point() !== e8.lineStart(lineAt())) {
      const [value, o] = numProperty(e8.point());
      if (value === true && o !== undefined) invalidateOverlay(o);
    }
    // A change of several lines may have made headings after BEG.
    if (!(s.invalidFlag || s.missingOverlay !== undefined || end <= e8.lineEnd(lineAt()))) {
      const next = lineAt() + 1;
      e8.gotoChar(next < e8.lineCount() ? e8.lineStart(next) : e8.pointMax());
      let found = e8.reSearchForward(regexp, { bound: end, noerror: true }) !== undefined;
      if (!found) {
        // As re-search-forward's MOVE leaves point at END.
        e8.gotoChar(Math.max(e8.point(), Math.min(end, e8.pointMax())));
        while (e8.point() > e8.pointMin() && e8.bufferText(e8.point() - 1, e8.point()) === "*") e8.gotoChar(e8.point() - 1);
        found = e8.lookingAt(regexp);
      }
      if (found) s.missingOverlay = e8.lineStart(lineAt());
    }
  });
  if (s.missingOverlay !== undefined || s.invalidFlag) update();
}

/** The default numbering, as "1.2.3 ", as org-num-default-format. */
export function defaultFormat(numbering: number[]): string {
  return `${numbering.map(String).join(".")} `;
}
e8.defun("org-num-default-format", (numbering: e8.Value) => defaultFormat(Array.isArray(numbering) ? (numbering as number[]) : []));

export const orgNumMode = e8.defineMinorMode({
  name: "org-num-mode",
  lighter: " o#",
  doc: "Dynamic numbering of headlines in an Org buffer.",
  onChange: (enabled) => {
    if (enabled) {
      if (!e8.derivedModeP("org-mode")) e8.userError("Cannot activate headline numbering outside Org mode");
      clear();
      const s = state();
      s.numbering = undefined;
      s.overlays = numberRegion(undefined, undefined).reverse();
      e8.addHook("after-change-functions", verify, { local: true });
      e8.addHook("change-major-mode-hook", clear, { local: true });
    } else {
      clear();
      e8.removeHook("after-change-functions", verify, { local: true });
      e8.removeHook("change-major-mode-hook", clear, { local: true });
    }
  },
});
