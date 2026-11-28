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

import { parseHeading, propertyInheritP, reducedLevel, entryGetInherited } from "org";
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
  /**
   * Each overlay's level, skip value and face, as its properties hold them,
   * kept here too so an update walks them without asking the editor, and
   * what its after-string was made from, its numbering and format
   * function, so an update leaves those that have not changed.
   */
  info: Map<number, { level: number; skip: boolean; face: e8.Value; shownFor?: number[] | null; fn?: e8.Value }>;
  /** The overlays marked invalid, as their org-num property says. */
  invalid: Set<number>;
}

const states = new PerBuffer<NumState>();

function state(): NumState {
  let s = states.get(e8.currentBuffer());
  if (s === undefined) {
    s = { overlays: [], skipLevel: undefined, numbering: undefined, missingOverlay: undefined, invalidFlag: false, info: new Map(), invalid: new Set() };
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
const validOverlayP = (s: NumState, o: number): boolean => !s.invalid.has(o);

/** Marks overlay O invalid, as org-num--invalidate-overlay. */
function invalidateOverlay(o: number): void {
  // An edit's hooks after it can reach an overlay the update deleted, which keeps no properties in E8.
  if (e8.overlayStart(o) !== undefined) e8.overlayPut(o, "org-num", e8.intern("invalid"));
  const s = state();
  s.invalid.add(o);
  s.invalidFlag = true;
}

/** Removes every numbering overlay, as org-num--clear. */
function clear(): void {
  const s = state();
  for (const o of s.overlays) e8.deleteOverlay(o);
  s.overlays = [];
  s.info = new Map();
  s.invalid = new Set();
}

/** What making and refreshing numbers reads of the options, read once for each pass over the headings. */
interface Ctx {
  fn: e8.Value;
  /** Whether the format is org-num-default-format, called here rather than through funcall. */
  defaultFn: boolean;
  numFace: e8.Value;
  cycle: boolean;
  nFaces: number;
  /** Whether any skip option is on, as without one no heading is skipped. */
  skips: boolean;
}

function context(): Ctx {
  const fn = e8.variable("org-num-format-function") ?? null;
  const tags = e8.variable("org-num-skip-tags");
  return {
    fn,
    defaultFn: (typeof fn === "string" ? fn : typeof fn === "symbol" ? e8.symbolName(fn) : undefined) === "org-num-default-format",
    numFace: e8.variable("org-num-face") ?? null,
    cycle: truthy(e8.variable("org-cycle-level-faces") ?? true),
    nFaces: Math.max(1, Math.min(8, Number(e8.variable("org-n-level-faces") ?? 8) || 8)),
    skips:
      truthy(e8.variable("org-num-skip-footnotes")) ||
      truthy(e8.variable("org-num-skip-commented")) ||
      truthy(e8.variable("org-num-skip-unnumbered")) ||
      (Array.isArray(tags) && tags.length > 0),
  };
}

/** The face of a heading of LEVEL, as org-num--make-overlay works it out from org-level-faces. */
function levelFaceOf(level: number, ctx: Ctx): string {
  return `org-level-${ctx.cycle ? ((level - 1) % ctx.nFaces) + 1 : Math.min(level, ctx.nFaces)}`;
}

/** An overlay's hook, the same for all of them, which marks it invalid. */
const invalidateHook = (ov: number): void => invalidateOverlay(ov);

/** An overlay numbering the heading from BOL, its stars and the space after them up to END, as org-num--make-overlay. */
function makeOverlay(bol: number, end: number, numbering: number[] | undefined, level: number, skip: boolean, ctx: Ctx): number {
  const face = truthy(ctx.numFace) ? ctx.numFace : levelFaceOf(level, ctx);
  const o = e8.makeOverlay(bol, end, {
    "org-num": true,
    skip,
    level,
    "numbering-face": face,
    "modification-hooks": [invalidateHook],
    "insert-in-front-hooks": [invalidateHook],
    "after-string": displayFor(numbering, face, ctx),
  });
  state().info.set(o, { level, skip, face, shownFor: numbering ?? null, fn: ctx.fn });
  return o;
}

/** Whether two numberings are the same, none being null. */
function sameNumbering(a: number[] | null | undefined, b: number[] | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The after-string for NUMBERING in FACE, as org-num--refresh-display makes it: nil for none. */
function displayFor(numbering: number[] | undefined, face: e8.Value, ctx: Ctx): e8.Value {
  if (numbering === undefined) return null;
  const numbers = [...numbering].reverse();
  let display: e8.Value = ctx.defaultFn ? defaultFormat(numbers) : truthy(ctx.fn) ? (e8.funcall(ctx.fn as any, numbers) ?? null) : null;
  if (display instanceof e8.PropertizedString) {
    if (!display.properties.some(([from, to, props]) => from <= 0 && 0 < to && props.face !== undefined && props.face !== null)) display = withFace(display, face);
  } else if (typeof display === "string") {
    display = new e8.PropertizedString(display, [[0, ctx.defaultFn ? display.length : Array.from(display).length, { face }]]);
  }
  return display;
}

/** Sets OVERLAY's after-string for NUMBERING, or none, as org-num--refresh-display, unless it shows that already. */
function refreshDisplay(overlay: number, numbering: number[] | undefined, ctx: Ctx): void {

  const info = state().info.get(overlay);
  if (info !== undefined && info.fn === ctx.fn && sameNumbering(info.shownFor, numbering ?? null)) return;
  const face = info?.face ?? e8.overlayGet(overlay, "numbering-face") ?? null;
  if (info !== undefined) {
    info.shownFor = numbering ?? null;
    info.fn = ctx.fn;
  }
  e8.overlayPut(overlay, "after-string", displayFor(numbering, face, ctx));
}

/** TEXT with FACE over all of it, its other properties kept, as org-add-props puts a face. */
function withFace(text: e8.PropertizedString, face: e8.Value): e8.PropertizedString {
  const n = Array.from(text.string).length;
  const cuts = [...new Set([0, n, ...text.properties.flatMap(([a, b]) => [a, b])])].filter((x) => x >= 0 && x <= n).sort((a, b) => a - b);
  const runs: [number, number, Record<string, e8.Value>][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const props: Record<string, e8.Value> = {};
    for (const [x, y, p] of text.properties) if (x <= a && b <= y) Object.assign(props, p);
    props.face = face;
    runs.push([a, b, props]);
  }
  return new e8.PropertizedString(text.string, runs);
}

/** Whether the heading at point is to be left unnumbered, as org-num--skip-value. */
function skipValue(line = lineAt()): boolean {
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
  let next: number[];
  if (numbering === undefined) {
    next = new Array(level).fill(0);
    next[0] = 1;
  } else if (level === last) {
    next = numbering.slice();
    next[0]++;
  } else if (level < last) {
    next = numbering.slice(last - level);
    next[0]++;
  } else {
    next = new Array(level - last).fill(0).concat(numbering);
    next[0] = 1;
  }
  s.numbering = next;
  return s.numbering;
}

/** Numbers the headings after START up to END, the buffer's ends for undefined, returning the overlays made, newest first, as org-num--number-region. */
function numberRegion(start: number | undefined, end: number | undefined): number[] {
  const ctx = context();
  // Each heading line after START's up to END, its stars and the space after them within END, as re-search-forward finds them.
  const from = start === undefined ? 0 : e8.lineEnd(lineAt(start));
  const regexp = headlineRegexp().slice(1);
  const made: number[] = [];
  for (const [line, bol, text] of e8.matchingLines(regexp, end === undefined ? { start: from } : { start: from, end })) {
    if (bol < from && start !== undefined) continue;
    const stars = /^\*+/.exec(text)![0].length;
    if (end !== undefined && bol + stars + 1 > end) break;
    const level = reducedLevel(stars);
    const skip = ctx.skips && skipValue(line);
    const numbering = currentNumbering(level, skip);
    made.push(makeOverlay(bol, bol + stars + 1, numbering, level, skip, ctx));
  }
  // Newest first, as the Lisp pushes them.
  return made.reverse();
}

/** Updates the buffer's numbering, making overlays again where they became invalid or are missing, as org-num--update. */
function update(): void {
  const s = state();
  s.skipLevel = undefined;
  s.numbering = undefined;
  // In order, where the Lisp pushes them newest first and reverses them at the end.
  const fresh: number[] = [];
  const pending = s.overlays;
  const lastStart = (): number | undefined => (fresh.length > 0 ? e8.overlayStart(fresh[fresh.length - 1]) : undefined);
  /** Adds the overlays numberRegion made, newest first, in order. */
  const add = (made: number[]): void => {
    for (let k = made.length - 1; k >= 0; k--) fresh.push(made[k]);
  };
  const drop = (o: number): void => {
    e8.deleteOverlay(o);
    s.info.delete(o);
    s.invalid.delete(o);
  };
  const ctx = context();
  let i = 0;
  while (i < pending.length) {
    const overlay = pending[i++];
    if (validOverlayP(s, overlay)) {
      const next = e8.overlayStart(overlay) ?? 0;
      const last = lastStart();
      if (s.missingOverlay === undefined) {
        // Nothing missing.
      } else if (s.missingOverlay > next) {
        // Further on.
      } else if (last === undefined || s.missingOverlay > last) {
        s.missingOverlay = undefined;
        add(numberRegion(last, next));
      } else s.missingOverlay = undefined;
      const info = s.info.get(overlay);
      const numbering = currentNumbering(info?.level ?? Number(e8.overlayGet(overlay, "level")), info?.skip ?? truthy(e8.overlayGet(overlay, "skip")));
      refreshDisplay(overlay, numbering, ctx);
      fresh.push(overlay);
    } else {
      // The headings between the last valid overlay and the next are numbered again.
      drop(overlay);
      while (i < pending.length && !validOverlayP(s, pending[i])) drop(pending[i++]);
      const next = i < pending.length ? e8.overlayStart(pending[i]) : undefined;
      add(numberRegion(lastStart(), next));
    }
  }
  if (s.missingOverlay !== undefined) add(numberRegion(lastStart(), undefined));
  s.invalidFlag = false;
  s.overlays = fresh;
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
      // Back to the heading, as org-back-to-heading, searching the text rather than asking the heading index, which would be made again on every change.
      e8.gotoChar(e8.lineStart(lineAt()));
      if (!e8.lookingAt("\\*+ ") && e8.reSearchBackward("^\\*+ ", { noerror: true }) === undefined) return;
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
