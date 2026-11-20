// Outlines: headings that fold, after Emacs's outline.el.
//
// A heading is a line that starts with a match of outline-regexp, and the
// length of the match is its level: * is level 1, ** level 2. Folding hides
// text with overlays whose invisible property is "outline", shown as "...",
// as Emacs does it.

e8.defineVariable({
  name: "outline-regexp",
  doc:
    "What starts a heading line: an Emacs regular expression matched at the start of a line. " +
    "The length of the match is the heading's level.",
  // A star or a form feed, as Emacs's "[*\^L]+": in an Emacs regexp a
  // backslash in brackets is itself, so "\\f" there would make every line
  // starting with f a heading.
  value: "[*\f]+",
  local: true,
});

const levelFaces = [
  "font-lock-function-name-face",
  "font-lock-variable-name-face",
  "font-lock-keyword-face",
  "font-lock-comment-face",
  "font-lock-type-face",
  "font-lock-constant-face",
  "font-lock-builtin-face",
  "font-lock-string-face",
];
levelFaces.forEach((inherit, i) => {
  e8.defineFace({ name: `outline-${i + 1}`, doc: `Level ${i + 1} headings, and deeper levels in turn.`, attributes: { inherit } });
});

interface Heading {
  line: number;
  start: number;
  /** The end of the heading line, before its newline. */
  end: number;
  level: number;
}

/** How long the heading at the start of `line` is, as outline-regexp matches it there with looking-at, or 0. */
function headingMatch(line: number): string {
  const start = e8.lineStart(line);
  const regexp = `\\(?:${String(e8.variable("outline-regexp"))}\\)`;
  return e8.lookingAt(regexp, start) ? e8.bufferText(start, e8.matchEnd(0)!) : "";
}

function headings(): Heading[] {
  const found: Heading[] = [];
  // Only the lines outline-regexp can match at the start of, found in one
  // pass, rather than a search at every line.
  const regexp = `\\(?:${String(e8.variable("outline-regexp"))}\\)`;
  const lines = e8.saveRestriction(() => {
    e8.widen();
    return e8.matchingLines(regexp);
  });
  for (const [line] of lines) {
    const match = headingMatch(line);
    // Only spaces and tabs are trimmed: a form feed is a heading of its own.
    const level = match.replace(/[ \t]+$/, "").length;
    if (level > 0) {
      // The match's length is the level, not counting a space after the stars, as in org-mode's "\\*+ ".
      found.push({ line, start: e8.lineStart(line), end: e8.lineEnd(line), level });
    }
  }
  return found;
}

/** The heading point is under: the nearest heading line at or before it. */
function currentHeading(all: Heading[]): number | undefined {
  const line = e8.lineOf(e8.point());
  let found: number | undefined;
  all.forEach((h, i) => {
    if (h.line <= line) found = i;
  });
  return found;
}

/**
 * Where a heading's subtree ends: before the newline of the next heading at
 * the same level or higher, or at the end of the buffer, leaving a final
 * newline visible.
 */
function subtreeEnd(all: Heading[], i: number): number {
  const next = all.slice(i + 1).find((h) => h.level <= all[i].level);
  if (next) {
    return Math.max(all[i].end, next.start - 1);
  }
  const last = e8.lineCount() - 1;
  const end = e8.lineStart(last) === e8.lineEnd(last) && last > 0 ? e8.lineStart(last) - 1 : e8.bufferSize();
  return Math.max(all[i].end, end);
}

/** Where a heading's own text ends: before the next heading of any level. */
function entryEnd(all: Heading[], i: number): number {
  return i + 1 < all.length ? Math.max(all[i].end, all[i + 1].start - 1) : subtreeEnd(all, i);
}

/**
 * Hides or shows the text from start up to end, as Emacs's
 * outline-flag-region does: outline overlays there are removed, cut back
 * where they reach outside it, and a new one hides it.
 */
function flag(start: number, end: number, hide: boolean): void {
  for (const id of e8.overlaysIn(start, end)) {
    if (e8.overlayGet(id, "invisible") !== "outline") continue;
    const [from, to] = [e8.overlayStart(id) ?? start, e8.overlayEnd(id) ?? end];
    e8.deleteOverlay(id);
    if (from < start) outlineOverlay(from, start);
    if (to > end) outlineOverlay(end, to);
  }
  if (hide && end > start) outlineOverlay(start, end);
}

function outlineOverlay(start: number, end: number): void {
  // Front-advance, as outline-flag-region makes its overlays.
  e8.makeOverlay(start, end, { invisible: "outline", evaporate: true }, { frontAdvance: true });
}

/** The heading at point, or an error as in Emacs. */
function heading(): [Heading[], number] {
  const all = headings();
  const i = currentHeading(all);
  if (i === undefined) throw new Error("Before first heading");
  return [all, i];
}

function showChildren(all: Heading[], i: number): void {
  flag(all[i].end, subtreeEnd(all, i), true);
  const end = subtreeEnd(all, i);
  const childLevel = Math.min(...all.slice(i + 1).filter((h) => h.start <= end).map((h) => h.level), Infinity);
  for (const child of all.slice(i + 1).filter((h) => h.start <= end && h.level === childLevel)) {
    // The newline before the child's heading, and the heading line.
    flag(child.start - 1, child.end, false);
  }
}

const commands: { [name: string]: [string, () => void] } = {
  "outline-hide-subtree": ["Hide everything under the heading point is under.", () => {
    const [all, i] = heading();
    flag(all[i].end, subtreeEnd(all, i), true);
  }],
  "outline-show-subtree": ["Show everything under the heading point is under.", () => {
    const [all, i] = heading();
    flag(all[i].end, subtreeEnd(all, i), false);
  }],
  "outline-hide-entry": ["Hide the text of the heading point is under, but not its subheadings.", () => {
    const [all, i] = heading();
    flag(all[i].end, entryEnd(all, i), true);
  }],
  "outline-show-entry": ["Show the text of the heading point is under, but not its subheadings.", () => {
    const [all, i] = heading();
    flag(all[i].end, entryEnd(all, i), false);
  }],
  "outline-show-children": ["Show the headings directly under the heading point is under, hiding their text.", () => {
    const [all, i] = heading();
    showChildren(all, i);
  }],
  "outline-show-branches": ["Show all subheadings of this heading, but not their bodies.", () => {
    const [all, i] = heading();
    const end = subtreeEnd(all, i);
    // Every heading under it shown, hiding nothing, as (outline-show-children 1000).
    for (const h of all.slice(i + 1).filter((h) => h.start <= end)) flag(h.start - 1, h.end, false);
  }],
  "outline-hide-body": ["Hide all text except headings.", () => {
    const all = headings();
    all.forEach((_, i) => flag(all[i].end, entryEnd(all, i), true));
  }],
  "outline-show-all": ["Show all text.", () => flag(0, e8.bufferSize(), false)],
  "outline-next-visible-heading": ["Move to the next heading that is not hidden.", () => moveToHeading(1)],
  "outline-previous-visible-heading": ["Move to the previous heading that is not hidden.", () => moveToHeading(-1)],
};

function moveToHeading(direction: number): void {
  const here = e8.lineOf(e8.point());
  const visible = headings().filter((h) => h.start === 0 || !e8.invisibleAt(h.start - 1));
  const target = direction > 0 ? visible.find((h) => h.line > here) : visible.reverse().find((h) => h.line < here);
  if (target === undefined) {
    e8.gotoChar(direction > 0 ? e8.bufferSize() : 0);
    return;
  }
  e8.gotoChar(target.start);
}

for (const [name, [doc, run]] of Object.entries(commands)) {
  e8.defineCommand({ name, doc, run });
}

e8.defineCommand({
  name: "outline-cycle",
  doc:
    "On a heading, cycle its visibility: folded, then its children, then its whole subtree.\n\n" +
    "Anywhere else, indent as TAB usually does.",
  run: () => {
    const all = headings();
    const i = currentHeading(all);
    if (i === undefined || all[i].line !== e8.lineOf(e8.point())) {
      e8.call("indent-for-tab-command");
      return;
    }
    const end = subtreeEnd(all, i);
    if (end <= all[i].end) {
      e8.message("EMPTY ENTRY");
      return;
    }
    const children = all.slice(i + 1).filter((h) => h.start <= end);
    const anyChildShown = children.some((h) => !e8.invisibleAt(h.start - 1));
    const anyHidden = e8.overlaysIn(all[i].end, end).some((id) => e8.overlayGet(id, "invisible") === "outline");
    if (e8.invisibleAt(all[i].end) && !anyChildShown) {
      showChildren(all, i);
      e8.message(children.length > 0 ? "CHILDREN" : "SUBTREE");
    } else if (anyHidden) {
      flag(all[i].end, end, false);
      e8.message("SUBTREE");
    } else {
      flag(all[i].end, end, true);
      e8.message("FOLDED");
    }
  },
});

e8.defineVariable({ name: "outline--cycle-buffer-state", value: null, local: true });

e8.defineCommand({
  name: "outline-cycle-buffer",
  doc: "Cycle the whole buffer: top-level headings only, then all headings, then everything.",
  run: () => {
    const all = headings();
    const state = e8.lastCommand() === "outline-cycle-buffer" ? e8.variable("outline--cycle-buffer-state") : null;
    if (state === "top level") {
      flag(0, e8.bufferSize(), false);
      all.forEach((_, i) => flag(all[i].end, entryEnd(all, i), true));
      e8.setVariable("outline--cycle-buffer-state", "all headings");
      e8.message("All headings");
    } else if (state === "all headings") {
      flag(0, e8.bufferSize(), false);
      e8.setVariable("outline--cycle-buffer-state", "show all");
      e8.message("Show all");
    } else {
      const top = Math.min(...all.map((h) => h.level), Infinity);
      all.forEach((h, i) => {
        if (h.level === top) flag(h.end, subtreeEnd(all, i), true);
      });
      e8.setVariable("outline--cycle-buffer-state", "top level");
      e8.message("Top level headings");
    }
  },
});

e8.defineCommand({
  name: "outline-up-heading",
  doc: "Move to the heading above the one point is under, a level higher, or as many levels as the prefix argument says.",
  run: () => {
    // As in Emacs, the mark is pushed and point goes to the start of its
    // line before anything can fail.
    if (e8.thisCommand() === "outline-up-heading" && e8.lastCommand() !== "outline-up-heading") e8.pushMark(e8.point());
    e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
    const all = headings();
    let current = currentHeading(all);
    if (current === undefined) throw new Error("Before first heading");
    // From the nearest heading that shows, as outline-back-to-heading finds it.
    while (current > 0 && e8.invisibleAt(all[current].start)) current--;
    // As in Emacs, only a top-level heading is an error; a deeper one with
    // no heading above it goes to the start of the buffer.
    e8.gotoChar(all[current].start);
    if (all[current].level === 1) throw new Error("Already at top level of the outline");
    let target = all[current].start;
    let i: number | undefined = current;
    for (let n = e8.prefixNumericValue(); n > 0 && i !== undefined; n--) {
      const level: number = all[i].level;
      let parent: number | undefined;
      for (let k = i - 1; k >= 0 && parent === undefined; k--) {
        if (all[k].level < level && !e8.invisibleAt(all[k].start)) parent = k;
      }
      i = parent;
      target = parent === undefined ? 0 : all[parent].start;
    }
    e8.gotoChar(target);
  },
});

const outlineKeys: { [keys: string]: e8.CommandName } = {
  "C-d": "outline-hide-subtree",
  "C-s": "outline-show-subtree",
  "C-c": "outline-hide-entry",
  "C-e": "outline-show-entry",
  TAB: "outline-show-children",
  "C-t": "outline-hide-body",
  "C-a": "outline-show-all",
  "C-n": "outline-next-visible-heading",
  "C-p": "outline-previous-visible-heading",
};
const withPrefix = (prefix: string) =>
  Object.fromEntries(Object.entries(outlineKeys).map(([keys, command]) => [`${prefix} ${keys}`, command]));

/**
 * Gives the heading lines from start to end their level's face, as
 * outline-mode's font-lock keywords do. Modes built on outline-mode, such as
 * org-mode, fontify in their own way, so this only works in outline-mode.
 */
function fontifyHeadings(start: number, end: number): void {
  if (e8.variable("major-mode") !== "outline-mode") return;
  e8.removeTextProperty(start, end, "face");
  for (let line = e8.lineOf(start); line < e8.lineCount() && e8.lineStart(line) < end; line++) {
    const match = headingMatch(line);
    if (match.length > 0) {
      e8.putTextProperty(e8.lineStart(line), e8.lineEnd(line), "face", `outline-${((match.length - 1) % 8) + 1}`);
    }
  }
}

e8.defineMinorMode({
  name: "outline-minor-mode",
  lighter: " Outl",
  doc: "Fold text under headings, in any major mode. The keys start with C-c @, such as C-c @ C-d to hide a subtree.",
  bindings: withPrefix("C-c @"),
  onChange: (enabled) => {
    if (enabled) {
      e8.addToInvisibilitySpec("outline", { ellipsis: true });
    } else {
      flag(0, e8.bufferSize(), false);
      e8.removeFromInvisibilitySpec("outline");
    }
  },
});

e8.defineMajorMode({
  name: "outline-mode",
  modeName: "Outline",
  parent: "text-mode",
  doc:
    "The major mode for outlines: text organised under headings that start with stars.\n\n" +
    "TAB on a heading cycles it between folded, its children and its whole subtree; " +
    "S-TAB cycles the whole buffer. The other keys start with C-c, such as C-c C-d to hide a subtree.",
  bindings: { ...withPrefix("C-c"), TAB: "outline-cycle", "S-TAB": "outline-cycle-buffer" },
  setup: () => {
    e8.addToInvisibilitySpec("outline", { ellipsis: true });
    e8.addHook("jit-lock-functions", fontifyHeadings, { local: true });
    // M-x imenu lists the headings, as outline-imenu-generic-expression.
    e8.setVariable("imenu-generic-expression", [[null, `^\\(?:${String(e8.variable("outline-regexp"))}\\).*$`, 0]]);
  },
});
