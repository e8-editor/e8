// Folding, after org-fold.el and org-cycle.el

import {
  entryEnd,
  findFrom,
  firstHeadingFrom,
  type Heading,
  headingIndex,
  headings,
  isBlank,
  isHeadingLine,
  keywordLines,
  nextSameOrHigher,
  subtreeEnd,
} from "org";
import { elementAt } from "org-element";
import { DRAWER_RE, ITEM_RE } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { charCount, escapeRegExp } from "subr";

export function hideOverlay(start: number, end: number, spec: string): void {
  // Text inserted at either end goes outside, as with org-fold-core's
  // overlays, which advance at the front only.
  e8.makeOverlay(start, end, { invisible: spec, evaporate: true }, { frontAdvance: true });
}

/**
 * Hides or shows the text from start up to end, as Emacs's org-fold-region
 * does: overlays hiding it with `spec` are removed, cut back where they
 * reach outside it, and a new one hides it.
 */
export function flag(start: number, end: number, hide: boolean, spec = "outline"): void {
  // Positions outside the buffer are brought inside, as make-overlay does,
  // so folds that reached past an item, restored relative to its new
  // place, are cut short rather than failing.
  start = Math.min(Math.max(start, 0), e8.bufferSize());
  end = Math.min(Math.max(end, start), e8.bufferSize());
  for (const id of e8.overlaysIn(start, end)) {
    if (e8.overlayGet(id, "invisible") !== spec) continue;
    const [from, to] = [e8.overlayStart(id) ?? start, e8.overlayEnd(id) ?? end];
    e8.deleteOverlay(id);
    if (from < start) hideOverlay(from, start, spec);
    if (to > end) hideOverlay(end, to, spec);
  }
  if (hide && end > start) hideOverlay(start, end, spec);
}

export const FOLD_SPECS = ["outline", "org-hide-drawer", "org-hide-block"];

/** Whether a heading, drawer or block fold hides the character at pos, or one with `spec` if given. */
export function folded(pos: number, spec?: string): boolean {
  return e8.overlaysAt(pos).some((id) => {
    const value = e8.overlayGet(id, "invisible");
    return spec === undefined ? FOLD_SPECS.includes(String(value)) : value === spec;
  });
}

/** Shows a heading's own line, as org-fold-heading does. */
export function showHeadingLine(h: Heading): void {
  flag(Math.max(0, h.start - 1), h.end, false);
}

/** Shows a heading's line and its text up to the next heading, as org-fold-show-entry does. */
export function showEntry(all: Heading[], i: number): void {
  flag(Math.max(0, all[i].start - 1), entryEnd(all, i), false);
}

/**
 * Shows the heading lines of a heading's children, as org-fold-show-children
 * does: the shallowest headings under it, and any as deep as the first one
 * if that is deeper. Returns whether it has any.
 */
export function showChildren(all: Heading[], i: number): boolean {
  const parent = all[i].level;
  const next = nextSameOrHigher(all, i);
  const end = next ? next.start : e8.bufferSize();
  showHeadingLine(all[i]);
  let min = Infinity;
  let max = Infinity;
  let any = false;
  for (let k = i + 1; k < all.length; k++) {
    const h = all[k];
    if (h.start >= end) break;
    if (h.level > max) continue;
    if (h.level < min) {
      min = h.level;
      max = Math.max(min, parent + 1);
    }
    showHeadingLine(h);
    any = true;
  }
  return any;
}

/** The headings above heading i, nearest first. */
export function ancestors(all: Heading[], i: number): number[] {
  const found: number[] = [];
  let level = all[i].level;
  // No heading is above a top-level one.
  for (let j = i - 1; j >= 0 && level > 1; j--) {
    if (all[j].level < level) {
      found.push(j);
      level = all[j].level;
    }
  }
  return found;
}

/**
 * Where the blank lines before headings are, as showEmptyLines' search
 * finds them for one or two separator lines, from the heading index and
 * the lines matchingLines finds in one pass in the editor: for each, from
 * the end of the line before the last blank one to the space after the
 * stars. Undefined where the search must be done on the text, as for
 * other counts or a range starting partway through a line.
 */
function separatorLines(range: [number, number], k: number): [number, number][] | undefined {
  if ((k !== 1 && k !== 2) || e8.lineStart(lineAt(range[0])) !== range[0]) return undefined;
  const all = headings();
  const headingOn = (line: number): Heading | undefined => {
    let [lo, hi] = [0, all.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].line < line) lo = mid + 1;
      else hi = mid;
    }
    return all[lo]?.line === line ? all[lo] : undefined;
  };
  const pattern = k === 2 ? "^[ \t]*\n[ \t]*\n\\*+ " : "^[ \t]*\n\\*+ ";
  const found: [number, number][] = [];
  for (const [line, start, text] of e8.matchingLines(pattern, { caseFold: false, start: range[0], end: range[1] })) {
    const h = headingOn(line + k);
    if (!h) continue;
    // From the newline before the last blank line: for one separator line, the one before it.
    const b = k === 2 ? start + charCount(text) : start - 1;
    if (b >= range[0]) found.push([b, h.start + h.level]);
  }
  return found;
}

/**
 * Shows blank lines before headings and at the end of the buffer after a
 * change of folding, as org-cycle-show-empty-lines does from org-cycle-hook.
 * `state` is the new state, and for "folded" and "children" the lines are
 * those of the subtree point is in.
 */
export function showEmptyLines(state: string, narrowed?: [number, number]): void {
  const n = Number(e8.variable("org-cycle-separator-lines") ?? 2);
  let range: [number, number] | undefined;
  if (["overview", "contents", "t"].includes(state)) range = narrowed ?? [0, e8.bufferSize()];
  else if (state === "children" || state === "folded") {
    const all = headings();
    const i = headingIndex(all, lineAt());
    const next = i === undefined ? undefined : nextSameOrHigher(all, i);
    const to = next ? (next.line + 1 < e8.lineCount() ? e8.lineStart(next.line + 1) : e8.bufferSize()) : e8.bufferSize();
    range = [e8.point(), to];
  }
  if (n !== 0 && range) {
    const k = Math.abs(n);
    const fast = separatorLines(range, k);
    const re =
      k === 1
        ? /(\n[ \t]*\n\*+) /g
        : k === 2
          ? /^[ \t]*(\n[ \t]*\n\*+) /gm
          : new RegExp(`^(?:[ \\t]*\\n){${k - 2}}[ \\t]*(\\n[ \\t]*\\n\\*+) `, "gm");
    const text = fast ? "" : e8.bufferText(range[0], range[1]);
    const shown: [number, number][] = fast?.filter(([, e]) => !e8.invisibleAt(e)) ?? [];
    // Characters counted on from the last match, not from the start each time.
    let [counted, chars] = [0, 0];
    for (let m = fast ? null : re.exec(text); m; m = re.exec(text)) {
      const at = m.index + m[0].length - 1;
      chars += charCount(text.slice(counted, at));
      counted = at;
      const e = range[0] + chars;
      const b = e - charCount(m[1]);
      if (!e8.invisibleAt(e)) shown.push([b, e]);
    }
    for (const [b, e] of shown) {
      if (n >= 0) flag(b, e, false);
      else {
        // A negative count shows all the blank lines.
        let l = lineAt(b);
        while (l > 0 && isBlank(e8.lineText(l))) l--;
        flag(e8.lineEnd(l), e, false);
      }
    }
  }
  // Never hide empty lines at the end of the file.
  const size = narrowed ? narrowed[1] : e8.bufferSize();
  const all = headings();
  const lastAt = firstHeadingFrom(all, size) - 1;
  const last = lastAt >= 0 && all[lastAt].start >= (narrowed?.[0] ?? 0) ? all[lastAt] : undefined;
  const eoh = last ? last.end : e8.lineEnd(lineAt(narrowed?.[0] ?? 0));
  if (eoh < size && /^[ \t\n]+$/.test(e8.bufferText(eoh, size))) flag(eoh, size, false);
}

/** Whether any of the text from `start` to `end` is folded. */
function anyFolded(start: number, end: number): boolean {
  for (let p = start; p < end; p++) if (folded(p)) return true;
  return false;
}

/** Where the text hidden from the line after `line` ends, as org-cycle-internal-local finds it. */
export function endOfHidden(line: number): number {
  const size = e8.bufferSize();
  let p = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : size;
  while (p < size && folded(p - 1)) {
    while (p < size && folded(p) === folded(p - 1)) p++;
    if (p < size && p === e8.lineEnd(lineAt(p))) p = lineAt(p) + 1 < e8.lineCount() ? e8.lineStart(lineAt(p) + 1) : size;
  }
  return p;
}

/**
 * Cycles heading i's subtree, as org-cycle-internal-local does. Org works
 * out the subtree from the heading that shows, but shows the children view
 * around point, which may be on a hidden heading `at` below it.
 */
export function cycleHeading(all: Heading[], i: number, at = i): void {
  const h = all[i];
  const eoh = h.end;
  const eos = subtreeEnd(all, i);
  const hasChildren = all[i + 1] !== undefined && all[i + 1].level > h.level;
  const eol = endOfHidden(h.line);
  const again = e8.lastCommand() === e8.thisCommand();
  const status = e8.variable("org-cycle-subtree-status");
  let skipped = false;
  /** Shows the heading after the subtree if it is hidden. */
  const showFollowing = (): void => {
    const next = findFrom(all, i + 1, (x) => x.start > eos);
    if (next && e8.invisibleAt(next.start)) showHeadingLine(next);
  };
  if (eos === eoh) {
    e8.message("EMPTY ENTRY");
    e8.setVariable("org-cycle-subtree-status", null);
    showFollowing();
    return;
  }
  // Org takes an entry of only blank lines for folded whether they show or
  // not, so once shown TAB never folds it again; E8 folds it when none of
  // it is hidden (docs/differences.md).
  const shownBlank = !hasChildren && eol < eos && /^\s*$/.test(e8.bufferText(eoh, eos)) && !anyFolded(eoh, eos);
  const hiddenInOneLine = !shownBlank && (eol >= eos || /^\s*$/.test(e8.bufferText(eol, eos)));
  if (hiddenInOneLine && !hasChildren) skipped = true;
  if (hiddenInOneLine && hasChildren) {
    showEntry(all, at);
    showChildren(all, at);
    showHeadingLine(all[at]);
    for (const a of ancestors(all, at)) {
      showHeadingLine(all[a]);
      showChildren(all, a);
    }
    e8.message("CHILDREN");
    const next = findFrom(all, i + 1, (x) => x.start > eos);
    if (next && next.start < e8.bufferSize() && e8.invisibleAt(next.start)) showHeadingLine(next);
    e8.setVariable("org-cycle-subtree-status", "children");
    showEmptyLines("children");
  } else if (skipped || (again && status === "children")) {
    flag(eoh, eos, false);
    e8.message(skipped ? "SUBTREE (NO CHILDREN)" : "SUBTREE");
    e8.setVariable("org-cycle-subtree-status", "subtree");
    showEmptyLines("subtree");
  } else {
    flag(eoh, eos, true);
    e8.message("FOLDED");
    e8.setVariable("org-cycle-subtree-status", "folded");
    showEmptyLines("folded");
  }
}

/** Hides the drawers before the first heading, as overview and contents do. */
function hideTopDrawers(): void {
  const first = headings()[0];
  const end = first ? first.line : e8.lineCount();
  // From the start of the accessible portion, as org-cycle-hide-drawers.
  for (let line = lineAt(e8.pointMin()); line < end; line++) {
    const m = DRAWER.exec(e8.lineText(line));
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

/** Shows only the top-level headings, as org-cycle-overview does. */
export function overview(): void {
  hideTopDrawers();
  const all = headings();
  if (all.length === 0) return;
  let last = all[0].end;
  let level = all[0].level;
  for (const h of all.slice(1)) {
    if (h.level > level) continue;
    flag(last, h.start - 1, true);
    last = h.end;
    level = h.level;
  }
  // Up to the end of the accessible portion, where Org's search stops.
  flag(last, e8.pointMax(), true);
}

/** Shows the headings up to a level, or all of them, as org-cycle-content does. */
export function showLevels(levels: number): void {
  flag(e8.pointMin(), e8.pointMax(), false);
  hideTopDrawers();
  let last = e8.pointMax();
  for (const h of [...headings()].reverse()) {
    if (h.level > levels) continue;
    flag(h.end, last, true);
    last = Math.max(0, h.start - 1);
  }
}

export function contents(): void {
  showLevels(Infinity);
}

/** Cycles the whole buffer, as org-cycle-internal-global does. */
export function globalCycle(): void {
  const again = e8.lastCommand() === e8.thisCommand();
  const status = e8.variable("org-cycle-global-status");
  if (again && status === "overview") {
    contents();
    e8.message("CONTENTS...done");
    e8.setVariable("org-cycle-global-status", "contents");
    showEmptyLines("contents");
  } else if (again && status === "contents") {
    flag(0, e8.bufferSize(), false);
    flag(0, e8.bufferSize(), false, "org-hide-block");
    e8.message("SHOW ALL");
    e8.setVariable("org-cycle-global-status", "all");
    showEmptyLines("all");
  } else {
    overview();
    e8.message("OVERVIEW");
    e8.setVariable("org-cycle-global-status", "overview");
    showEmptyLines("overview");
  }
}

/**
 * Shows what is around a position: its entry, any fold it is in, and the
 * next heading, as org-fold-show-set-visibility does for `local`.
 */
function showAround(pos: number): void {
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i === undefined) flag(0, all[0]?.start ?? e8.bufferSize(), false);
  else showEntry(all, i);
  if (e8.invisibleAt(pos)) {
    for (const id of e8.overlaysAt(pos)) {
      const spec = String(e8.overlayGet(id, "invisible"));
      if (FOLD_SPECS.includes(spec)) flag(e8.overlayStart(id) ?? pos, e8.overlayEnd(id) ?? pos, false, spec);
    }
  }
  if (i !== undefined) {
    const next = all.find((h) => h.start > pos);
    if (next) showHeadingLine(next);
  }
}

/**
 * Stops an edit next to folded text, or unfolds it first, as
 * org-fold-check-before-invisible-edit does. `kind` is "insert", "delete"
 * or "delete-backward".
 */
function checkBeforeInvisibleEdit(kind: string): void {
  const mode = e8.variable("org-fold-catch-invisible-edits");
  const p = e8.point();
  if (!mode || !(e8.invisibleAt(p) || e8.invisibleAt(Math.max(0, p - 1)))) return;
  const atPoint = folded(p);
  const beforePoint = p > 0 && folded(p - 1);
  if (!atPoint && !beforePoint) return;
  if (mode === "error") e8.userError("Editing in invisible areas is prohibited, make them visible first");
  showAround(p);
  if (beforePoint) showAround(p - 1);
  const predictable = atPoint && !beforePoint && (kind === "insert" || kind === "delete-backward");
  if (mode === "show" || (mode === "smart" && predictable)) e8.message("Unfolding invisible region around point before editing");
  else e8.userError("Edit in invisible region aborted, repeat to confirm with text visible");
}

/** The commands checked before they edit next to folded text, as in org-fold-catch-invisible-edits-commands. */
const INVISIBLE_EDIT_COMMANDS: { [command: string]: string } = {
  "org-self-insert-command": "insert",
  "org-delete-backward-char": "delete-backward",
  "org-delete-char": "delete",
  "org-meta-return": "insert",
  "org-return": "insert",
};

/** Checks the command being run, if it is one of those, as Org's advice on them does. */
export function checkInvisibleEditMaybe(): void {
  const kind = INVISIBLE_EDIT_COMMANDS[e8.thisCommand() ?? ""];
  if (kind) checkBeforeInvisibleEdit(kind);
}

e8.defineCommand({
  name: "org-fold-check-before-invisible-edit-maybe",
  doc: "Stop or unfold before an edit next to folded text, if the running command is one Org checks.",
  run: () => checkInvisibleEditMaybe(),
});

/**
 * Unfolds folds near a change that no longer match what they hide, as
 * Org's fragile folding specs do from after-change-functions: a subtree
 * fold must follow a heading or item line and never hides a top-level
 * heading, and a drawer or block fold must still run from its first line
 * to its last.
 */
export function foldsAfterChange(beg: number, end: number): void {
  fixFoldsAround(beg, end);
}

/** Whether edits skip the fold checks, as org-fold-core-ignore-modifications makes them. */
export let foldChecksOff = false;

/** Runs body with no fold checks after its edits, as Org's org-fold-core-ignore-modifications does. */
export function withoutFoldChecks<T>(body: () => T): T {
  const was = foldChecksOff;
  foldChecksOff = true;
  try {
    return body();
  } finally {
    foldChecksOff = was;
  }
}

/** Checks the folds near a change, as org-fold-core--fix-folded-region does after each one. */
export function fixFoldsAround(from: number, to: number): void {
  if (foldChecksOff) return;
  const a = e8.lineStart(Math.max(0, lineAt(from) - 1));
  const b = lineStartOrEnd(lineAt(to) + 2);
  for (const id of e8.overlaysIn(a, b)) checkFold(id);
}

/**
 * Shows a line from the newline before it, as org-fold--reveal-headline-at-point
 * does. Blank lines after it would show too, but Org compares their end
 * with what skip-chars-forward returns after org-end-of-subtree, a count
 * of characters, so they rarely do.
 */
function revealHeadlineAt(line: number): void {
  const size = e8.bufferSize();
  const blank = /[\n\t\r ]/;
  const endl = e8.lineEnd(line);
  let q = endl;
  while (q < size && blank.test(e8.bufferText(q, q + 1))) q++;
  const all = headings();
  const i = headingIndex(all, line);
  let skipped = -1;
  if (i !== undefined) {
    let e = nextSameOrHigher(all, i)?.start ?? size;
    for (let k = 0; k < 2 && e > 0 && /[\n\r]/.test(e8.bufferText(e - 1, e)); k++) e--;
    skipped = 0;
    while (e + skipped < size && blank.test(e8.bufferText(e + skipped, e + skipped + 1))) skipped++;
  }
  flag(Math.max(0, e8.lineStart(line) - 1), q + 1 === skipped ? q : endl, false);
}

/** Unfolds a fold that no longer matches what it hides. */
function checkFold(id: number): void {
  const spec = String(e8.overlayGet(id, "invisible"));
  if (!FOLD_SPECS.includes(spec)) return;
  let start = e8.overlayStart(id);
  let end = e8.overlayEnd(id);
  if (start === undefined || end === undefined) return;
  // Folds that touch make one region, as Org's text-property folds do.
  const ids = [id];
  for (let grew = true; grew; ) {
    grew = false;
    const near: number[] = e8.overlaysIn(Math.max(0, start - 1), Math.min(e8.bufferSize(), end + 1));
    for (const other of near) {
      if (ids.includes(other) || e8.overlayGet(other, "invisible") !== spec) continue;
      const s0: number = e8.overlayStart(other) ?? start;
      const e0: number = e8.overlayEnd(other) ?? end;
      if (e0 < start || s0 > end) continue;
      ids.push(other);
      [start, end] = [Math.min(start, s0), Math.max(end, e0)];
      grew = true;
    }
  }
  const size = e8.bufferSize();
  // Org's checks step back from the fold's start, which fails there.
  if (start === 0) throw new Error("Beginning of buffer");
  const before = lineAt(Math.max(0, start - 1));
  const opener = e8.lineText(before);
  const lastLine = lineAt(end);
  let valid: boolean;
  if (spec === "outline") {
    // The line before the fold shows whole, as org-fold--reveal-outline-maybe
    // makes sure first, unless it is folded itself.
    const openerStart = e8.lineStart(before);
    if (!folded(openerStart, "outline")) {
      revealHeadlineAt(before);
      start = Math.max(start, e8.lineEnd(before));
    }
    valid = start > 0 && (ITEM_RE.test(opener) || /^\*+ /.test(opener));
    if (valid) {
      // A top-level heading is never hidden, nor one partly hidden at the end.
      for (let l = before + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
        if (/^\* /.test(e8.lineText(l))) revealHeadlineAt(l);
      }
      // The heading on the line where the fold ends shows.
      if (isHeadingLine(e8.lineText(lastLine)) && !folded(e8.lineStart(lastLine), "outline")) revealHeadlineAt(lastLine);
    }
  } else {
    const block = /^[ \t]*#\+begin(?::|_(\S+))/i.exec(opener);
    const close =
      spec === "org-hide-drawer"
        ? /^[ \t]*:END:[ \t]*$/i
        : new RegExp(`^[ \\t]*#\\+end${block?.[1] ? `_${escapeRegExp(block[1])}[ \\t]*$` : ":?[ \\t]*$"}`, "i");
    valid = start > 0 && (spec === "org-hide-drawer" ? DRAWER_RE.test(opener) : block !== null) && close.test(e8.lineText(lastLine));
    for (let l = before + 1; valid && l < lastLine; l++) {
      if (close.test(e8.lineText(l)) || isHeadingLine(e8.lineText(l))) valid = false;
    }
  }
  if (!valid) revealAfterCommand(start, end);
}

/**
 * Regions to show once the command is over, each held by an overlay that
 * hides nothing, so it moves with the text as Org's markers do.
 */
let delayedReveals: { buffer: e8.Buffer; id: number }[] = [];

/**
 * Shows a region, every kind of fold in it, once the command is over, as
 * org-fold-core--region-delayed does: Org's fragility checks run from
 * after-change-functions, and commands may assume those leave what shows
 * alone.
 */
function revealAfterCommand(start: number, end: number): void {
  delayedReveals.push({ buffer: e8.currentBuffer(), id: e8.makeOverlay(start, end) });
}

// Each in the buffer it was made in, which need not be current once the
// command is over: a change made from the agenda or capture is to another.
e8.addHook("post-command-hook", () => {
  const reveals = delayedReveals;
  delayedReveals = [];
  for (const { buffer, id } of reveals) {
    if (!e8.bufferLiveP(buffer)) continue;
    e8.withCurrentBuffer(buffer, () => {
      const [start, end] = [e8.overlayStart(id), e8.overlayEnd(id)];
      e8.deleteOverlay(id);
      if (start === undefined || end === undefined || start >= end) return;
      for (const spec of FOLD_SPECS) flag(start, end, false, spec);
    });
  }
});

export const DRAWER = /^[ \t]*:([\w-]+):[ \t]*$/;
export const BLOCK_BEGIN = /^[ \t]*#\+begin_(\S+)/i;
export const BLOCK_END = /^[ \t]*#\+end_(\S+)/i;

/** The lines a drawer or block starting at a line runs to, or undefined if it is not closed. */
function closingLine(line: number): number | undefined {
  const text = e8.lineText(line);
  const block = BLOCK_BEGIN.exec(text);
  for (let l = line + 1; l < e8.lineCount(); l++) {
    const t = e8.lineText(l);
    if (block ? BLOCK_END.test(t) : /^[ \t]*:END:[ \t]*$/i.test(t)) return l;
    if (isHeadingLine(t)) return undefined;
  }
  return undefined;
}

/** Folds or unfolds the drawer or block starting at a line, showing its first line. */
export function toggleDrawerOrBlock(line: number, hide?: boolean): boolean {
  const close = closingLine(line);
  if (close === undefined) return false;
  const spec = BLOCK_BEGIN.test(e8.lineText(line)) ? "org-hide-block" : "org-hide-drawer";
  const start = e8.lineEnd(line);
  flag(start, e8.lineEnd(close), hide ?? !folded(start, spec), spec);
  return true;
}

/** The line opening the drawer or block a closing line ends, if it is one. */
export function openerOf(line: number): number | undefined {
  const text = e8.lineText(line);
  const end = BLOCK_END.exec(text);
  if (!end && !/^[ \t]*:END:[ \t]*$/i.test(text)) return undefined;
  for (let l = line - 1; l >= 0; l--) {
    const t = e8.lineText(l);
    if (isHeadingLine(t)) return undefined;
    if (end ? BLOCK_BEGIN.test(t) : DRAWER.test(t) && !/^[ \t]*:END:/i.test(t)) return closingLine(l) === line ? l : undefined;
    if (!end && /^[ \t]*:END:/i.test(t)) return undefined;
  }
  return undefined;
}

/** Folds the drawers whose first lines are from a line up to a position, as org-fold--hide-drawers does. */
export function hideDrawersIn(fromLine: number, to: number): void {
  for (let line = fromLine; line < e8.lineCount() && e8.lineStart(line) < to; line++) {
    const m = DRAWER.exec(e8.lineText(line));
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

function hideAllDrawers(): void {
  // The lines of the accessible portion that can open a drawer, found in one pass.
  const lines = e8.matchingLines("^[ \t]*:[-_[:alnum:]]+:[ \t]*$", { caseFold: false });
  for (const [line, , text] of lines) {
    const m = DRAWER.exec(text);
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

/**
 * Folds subtrees as their VISIBILITY properties say, after the startup
 * folding, as org-cycle-set-visibility-according-to-property does:
 * folded, children (the entry and its children's headings), content (every
 * heading under it) or all, in order, so one inside a subtree another
 * showed has its say after it. One outside a property drawer passes over
 * the rest of its entry.
 */
function visibilityFromProperties(): void {
  const lines = e8.matchingLines("^[ \t]*:VISIBILITY:[ \t]+[^ \t]", { caseFold: true });
  if (lines.length === 0) return;
  const all = headings();
  let skipTo = -1;
  for (const [line, , text] of lines) {
    const pos = e8.lineStart(line);
    if (pos < skipTo) continue;
    const i = headingIndex(all, line);
    if (i === undefined) continue;
    if (elementAt(pos)?.type !== "node-property") {
      skipTo = entryEnd(all, i);
      continue;
    }
    const state = /:VISIBILITY:[ \t]+(.*?)[ \t]*$/i.exec(text)?.[1];
    const end = subtreeEnd(all, i);
    flag(all[i].end, end, true);
    if (state === "children") {
      showEntry(all, i);
      showChildren(all, i);
    } else if (state === "content") {
      // Every heading line in the subtree, as org-cycle-content narrowed to it.
      flag(Math.max(0, all[i].start - 1), end, false);
      let k = i + 1;
      while (k < all.length && all[k].level > all[i].level) k++;
      let last = end;
      for (k--; k >= i; k--) {
        flag(all[k].end, last, true);
        last = Math.max(0, all[k].start - 1);
      }
    } else if (state === "all" || state === "showall") {
      flag(Math.max(0, all[i].start - 1), end, false);
    }
  }
}

/** Folds the buffer as org-startup-folded or a #+STARTUP: line says. */
export function startupVisibility(): void {
  let how = String(e8.variable("org-startup-folded") ?? "showeverything");
  for (const [, , text] of keywordLines()) {
    const m = /^#\+STARTUP:(.*)$/i.exec(text);
    for (const word of m ? m[1].trim().split(/\s+/) : []) {
      if (/^(overview|fold|content|showall|nofold|showeverything|show[2-5]levels)$/.test(word)) how = word;
    }
  }
  if (how === "showeverything") return;
  if (how === "overview" || how === "fold") overview();
  else if (how === "content") contents();
  else if (/^show[2-5]levels$/.test(how)) showLevels(Number(how[4]));
  visibilityFromProperties();
  hideAllDrawers();
  showEmptyLines("t");
}

e8.defineVariable({
  name: "org-fold-show-context-detail",
  doc:
    "How much is shown around a place Org goes to in folded text, as [context, span] lists, a context being agenda, " +
    "org-goto, occur-tree, tags-tree, link-search, mark-goto, bookmark-jump, isearch or default. A span is minimal " +
    "(the heading, and the entry if not on it), local (the heading, entry and next heading), ancestors (minimal and " +
    "the headings above), ancestors-full (ancestors and the whole subtree), lineage (local, the headings above and " +
    "their siblings), tree (ancestors with each one's children), or canonical (tree with each one's entry). One span " +
    "alone is used everywhere.",
  value: [
    ["agenda", "local"],
    ["bookmark-jump", "lineage"],
    ["isearch", "lineage"],
    ["default", "ancestors"],
  ],
});

/** The heading whose entry the position is in, as org-back-to-heading finds it. */
function headingAtOrBefore(all: Heading[], pos: number): number | undefined {
  return headingIndex(all, lineAt(pos));
}

/** Shows the heading lines of a heading's siblings, as org-fold-show-siblings does. */
function showSiblings(all: Heading[], i: number): void {
  const level = all[i].level;
  for (let k = i + 1; k < all.length && all[k].level >= level; k++) if (all[k].level === level) showHeadingLine(all[k]);
  for (let k = i - 1; k >= 0 && all[k].level >= level; k--) if (all[k].level === level) showHeadingLine(all[k]);
}

/**
 * Shows what DETAIL says around point, as org-fold-show-set-visibility
 * does: nil, minimal, local, ancestors, ancestors-full, lineage, tree,
 * canonical or t.
 */
export function showSetVisibility(detail: string | null): void {
  const pos = e8.point();
  const all = headings();
  const i = headingAtOrBefore(all, pos);
  const atHeading = i !== undefined && all[i].line === lineAt(pos);
  if (atHeading && detail !== "local") showHeadingLine(all[i]);
  else {
    // org-fold-show-entry: from the end of the line before the heading, or the buffer's start, to the next heading.
    if (i === undefined) flag(e8.pointMin(), all.find((h) => h.start > pos)?.start ?? e8.pointMax(), false);
    else showEntry(all, i);
    // A fold of a drawer or block point is in opens too.
    if (e8.invisibleAt(pos)) {
      for (const id of e8.overlaysAt(pos)) {
        const spec = String(e8.overlayGet(id, "invisible"));
        if (FOLD_SPECS.includes(spec)) flag(e8.overlayStart(id) ?? pos, e8.overlayEnd(id) ?? pos, false, spec);
      }
    }
    if (i !== undefined) {
      if (detail === "tree" || detail === "canonical" || detail === "t") showChildren(all, i);
      else if (detail !== null && detail !== "minimal" && detail !== "ancestors" && detail !== "ancestors-full") {
        // outline-next-heading, then org-fold-heading there: the last heading's own line if there is none after.
        const next = all.find((h) => h.start > pos);
        showHeadingLine(next ?? all[all.length - 1]);
      }
    }
  }
  if (i === undefined) return;
  // The rest of the subtree from point, as org-fold-show-subtree.
  if (detail === "ancestors-full") flag(pos, nextSameOrHigher(all, i)?.start ?? e8.pointMax(), false);
  if (detail === "lineage") showSiblings(all, i);
  if (detail === "ancestors" || detail === "ancestors-full" || detail === "lineage" || detail === "tree" || detail === "canonical" || detail === "t") {
    for (const a of ancestors(all, i)) {
      showHeadingLine(all[a]);
      if (detail === "canonical" || detail === "t") showEntry(all, a);
      if (detail === "tree" || detail === "canonical" || detail === "t") showChildren(all, a);
    }
  }
}

/**
 * Makes point and what is around it show, as org-fold-show-context does,
 * as much as org-fold-show-context-detail gives `key`, or its default.
 */
export function showContext(key?: string): void {
  const detail = e8.variable("org-fold-show-context-detail");
  let span: e8.Value | undefined;
  if (!Array.isArray(detail)) span = detail;
  else {
    const find = (k: string) => (detail.find((e) => Array.isArray(e) && e[0] === k) as e8.Value[] | undefined)?.[1];
    span = (key !== undefined ? find(key) : undefined) ?? find("default");
  }
  showSetVisibility(span === null || span === undefined || span === false ? null : span === true ? "t" : String(span));
}
