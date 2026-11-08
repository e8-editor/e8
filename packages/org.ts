// Org mode, after Emacs's org.el: headings that fold with TAB and S-TAB,
// structure editing with M-RET and the M-arrow keys, TODO states,
// priorities, tags, timestamps and the mode itself. The rest is in files
// as Org splits it: the element parser in org-element.ts, folding in
// org-fold.ts, plain lists in org-list.ts, refiling in org-refile.ts, links
// in ol.ts, tables in org-table.ts, the agenda in org-agenda.ts and capture
// in org-capture.ts. They import what they use from each other, as Org's
// files require each other.
//
// Org text is styled as it comes into view, by a function on
// jit-lock-functions, as Emacs's font-lock styles it. Folding hides text with
// overlays, as Emacs's org does with org-fold-core-style set to overlays:
// "outline" for subtrees, "org-hide-drawer" for drawers and
// "org-hide-block" for blocks. A link's brackets and target are hidden by
// an "org-link" text property, so [[https://gnu.org][GNU]] shows as GNU.

import { jump, type Link, linkHere, searchInBuffer } from "ol";
import { type Elem, elementAt, endBeforeBlank, keepingParse, parseShifts, startsElement } from "org-element";
import {
  ancestors,
  BLOCK_BEGIN,
  BLOCK_END,
  checkInvisibleEditMaybe,
  contents,
  cycleHeading,
  DRAWER,
  endOfHidden,
  fixFoldsAround,
  flag,
  FOLD_SPECS,
  foldChecksOff,
  folded,
  foldsAfterChange,
  globalCycle,
  hideDrawersIn,
  openerOf,
  overview,
  showChildren,
  showEmptyLines,
  showEntry,
  showHeadingLine,
  showLevels,
  startupVisibility,
  toggleDrawerOrBlock,
  withoutFoldChecks,
} from "org-fold";
import {
  allItems,
  applyStruct,
  blankBeforeNewEntry,
  bottomPoint,
  children,
  copyStruct,
  cycleItemIndentation,
  cycleListBullet,
  DRAWER_RE,
  edReplace,
  endOfMetaData,
  entryPut,
  fixBox,
  fixBul,
  fixInd,
  fixItemEnd,
  getItem,
  hasChild,
  indentLineTo,
  indentString,
  inItem,
  insertDrawer,
  insertListItem,
  ITEM_RE,
  itemEndBeforeBlank,
  itemLine,
  itemParts,
  type ItemParts,
  type ListItem,
  listStruct,
  parentsAlist,
  prevsAlist,
  sameStruct,
  setProperty,
  type Struct,
  textIndentation,
  toggleCheckbox,
  writeStruct,
} from "org-list";
import {
  charAt,
  dropMarker,
  edDelete,
  edInsert,
  lineAt,
  lineStartOrEnd,
  marker,
  type Marker,
  markers,
  orgRegionActive,
  placeMarkers,
} from "org-macs";
import { refileCommand, refileCopyCommand } from "org-refile";
import { atTable, beforeOnLine, blankField, markAligned, needsAlign, restOfLine } from "org-table";
import { allMatches, charCount, escapeRegExp, forwardLine, truthy } from "subr";
export { PLANNING } from "org-element";

// Variables

const variables: [string, string, e8.Value][] = [
  [
    "org-todo-keywords",
    'The TODO states headings cycle through, in order: states before "|" are not done, those after it are. ' +
      "Without a \"|\", the last state is the done one. A #+TODO: line in a file gives that file its own.",
    ["TODO", "|", "DONE"],
  ],
  [
    "org-startup-folded",
    'How much of a file org-mode shows when it starts: "showeverything", "showall" (drawers folded), ' +
      '"content" (all headings) or "overview" (top headings). A #+STARTUP: line in the file says otherwise.',
    "showeverything",
  ],
  ["org-startup-truncated", "Whether org-mode turns on truncate-lines, so long lines run off the window.", true],
  ["org-use-fast-todo-selection", "Whether C-c C-t asks for a state by its key, when the states have keys as TODO(t) gives them: auto does, nil cycles.", "auto"],
  ["org-log-into-drawer", "Whether notes about state changes go into a drawer: t for LOGBOOK, or the drawer's name; nil puts them in the entry.", false],
  ["org-treat-insert-todo-heading-as-state-change", "Whether inserting a TODO heading logs it as a change to that state.", false],
  ["org-todo-keyword-faces", "Faces for TODO keywords, as [keyword, face] lists: a face's name, a colour, or a list of attributes such as [\":foreground\", \"#b48ead\", \":weight\", \"bold\"].", null],
  ["org-tag-faces", "Faces for tags, as [tag, face] lists, as org-todo-keyword-faces gives them for keywords.", null],
  ["org-blank-before-new-entry", 'Whether new headings and list items get a blank line before them: [["heading", v], ["plain-list-item", v]], each v true, nil or "auto" to do as the ones around do.', [["heading", "auto"], ["plain-list-item", "auto"]]],
  ["org-ellipsis", "What a folded heading shows after it in place of ..., a string, or nil for ....", null],
  ["org-return-follows-link", "Whether RET on a link follows it, as C-c C-o does, rather than breaking the line.", false],
  ["org-directory", "Where Org files are kept: relative names in org-agenda-files are in it.", "~/org"],
  ["org-startup-indented", "Whether org-mode turns on org-indent-mode, indenting text under its headings as it shows. #+STARTUP: indent or noindent says otherwise for a file.", false],
  ["org-hide-leading-stars", "Whether a heading shows only its last star, the others in the org-hide face, the colour of the background.", false],
  ["org-adapt-indentation", "Whether text under a heading is indented to line up with its title; org-indent-mode turns it off.", false],
  [
    "org-tags-column",
    "Where tags go on a heading line: a negative column aligns their end there, a positive one their start.",
    -77,
  ],
  [
    "org-cycle-separator-lines",
    "How many empty lines before a heading keep one of them showing when the subtree above it is folded.",
    2,
  ],
  [
    "org-support-shift-select",
    "Whether Shift with an arrow key selects text where it has no Org meaning. When off, it is an error there.",
    false,
  ],
  [
    "org-fold-catch-invisible-edits",
    'What typing or deleting next to folded text does: "smart" unfolds it and goes ahead where the edit is ' +
      'predictable, and otherwise stops so it can be repeated with the text showing; "show" unfolds and goes ahead, ' +
      '"show-and-error" unfolds and stops, "error" stops, and false allows the edit.',
    "smart",
  ],
  ["org-M-RET-may-split-line", "Whether M-RET in the middle of a line splits it, the rest going to the new heading or item.", true],
  [
    "org-loop-over-headlines-in-active-region",
    "Whether commands such as C-c C-t act on every heading in the active region.",
    true,
  ],
  [
    "org-log-repeat",
    'What marking a repeating task done records: "time" for a LAST_REPEAT property and a note of the change, false for nothing.',
    "time",
  ],
  [
    "org-log-done",
    'What marking a heading done records: false for nothing, "time" for a CLOSED: timestamp under it.',
    false,
  ],
  ["org-priority-highest", "The highest priority, a capital letter.", "A"],
  ["org-priority-lowest", "The lowest priority, a capital letter.", "C"],
  ["org-priority-default", "The priority S-<up> and S-<down> start from, and that headings without one count as.", "B"],
  ["org-link-descriptive", "Whether links show only their description, hiding the brackets and target.", true],
  ["org-hide-emphasis-markers", "Whether the markers around emphasised text are hidden, the stars of *bold* and the tildes of ~code~, showing only its face.", false],
  [
    "org-indirect-buffer-display",
    'Where C-c C-x b shows the indirect buffer it makes: "current-window", "other-window", "new-frame" each time, ' +
      'or "dedicated-frame", one frame used again.',
    "other-window",
  ],
  ["org-fontify-done-headline", "Whether the text of a done heading gets the face org-headline-done.", true],
  ["org-fontify-whole-block-delimiter-line", "Whether a block's #+begin and #+end lines take their faces to the line's end, newline and all, so a background with :extend reaches the window's edge.", true],
  [
    "org-time-stamp-rounding-minutes",
    "Minutes are rounded to the first of these when a time is inserted, and S-<up> and S-<down> change them by the second.",
    [0, 5],
  ],
];
for (const [name, doc, value] of variables) e8.defineVariable({ name, doc, value });

e8.defineHook(
  "org-cycle-tab-first-hook",
  "Functions TAB in Org tries first, each until one gives true, which then is all TAB does. Emacs also calls it org-tab-first-hook.",
);
e8.defineHook(
  "org-tab-before-tab-emulation-hook",
  "Functions TAB in Org tries where it would indent, not being on a heading, an item, a table or a block, each until one gives true.",
);

for (const [name, doc] of [
  ["org-cycle-subtree-status", "What TAB last did to a heading: \"folded\", \"children\" or \"subtree\"."],
  ["org-cycle-global-status", "What S-TAB last did: \"overview\", \"contents\" or \"all\"."],
  ["org--todo-sets", "The buffer's TODO state sequences: each a list of the states not done and the states done."],
]) {
  e8.defineVariable({ name, doc, value: null, local: true });
}

{
  const alist = e8.variable("auto-mode-alist");
  if (Array.isArray(alist)) e8.setDefault("auto-mode-alist", [["\\.org\\'", "org-mode"], ...alist]);
}

// Faces

const faces: [string, string, e8.FaceAttributes][] = [
  ["org-todo", "TODO states that are not done.", { foreground: "bad", bold: true }],
  ["org-done", "Done TODO states, such as DONE.", { foreground: "good", bold: true }],
  ["org-headline-done", "The text of a heading that is done.", { foreground: "muted" }],
  ["org-priority", "Priority cookies, such as [#A].", { inherit: "font-lock-keyword-face" }],
  ["org-tag", "Tags at the end of a heading.", { bold: true }],
  ["org-link", "Links.", { inherit: "link" }],
  ["org-date", "Timestamps.", { foreground: "accent-ink", underline: true }],
  ["org-special-keyword", "Keywords such as SCHEDULED: and property names.", { inherit: "font-lock-keyword-face" }],
  ["org-property-value", "Property values.", {}],
  ["org-drawer", "Drawer lines, such as :PROPERTIES: and :END:.", { foreground: "accent-ink" }],
  ["org-table", "Tables.", { foreground: "accent-ink" }],
  ["org-checkbox", "Checkboxes, such as [ ] and [X].", { inherit: "bold" }],
  ["org-checkbox-statistics-todo", "Checkbox counts, such as [1/3], with boxes left to tick.", { inherit: "org-todo" }],
  ["org-checkbox-statistics-done", "Checkbox counts with every box ticked.", { inherit: "org-done" }],
  ["org-list-dt", "The term of a description list item, before ::.", { bold: true }],
  ["org-meta-line", "Lines such as #+STARTUP:.", { inherit: "font-lock-comment-face" }],
  ["org-document-title", "The title from #+TITLE:.", { foreground: "accent-ink", bold: true }],
  ["org-document-info", "Values of #+AUTHOR:, #+DATE: and #+EMAIL:.", { foreground: "accent-ink" }],
  ["org-document-info-keyword", "Keywords such as #+TITLE:.", { inherit: "shadow" }],
  ["org-block", "The text in blocks, such as #+begin_src.", { inherit: "shadow", extend: true }],
  ["org-block-begin-line", "The line starting a block.", { inherit: "org-meta-line" }],
  ["org-block-end-line", "The line ending a block.", { inherit: "org-meta-line" }],
  ["org-quote", "The text in quote blocks.", { inherit: "org-block", italic: true }],
  ["org-verse", "The text in verse blocks.", { inherit: "org-block" }],
  ["org-code", "~Code~.", { inherit: "shadow" }],
  ["org-verbatim", "=Verbatim= text.", { inherit: "shadow" }],
  ["org-strike-through", "+Struck through+ text.", { strike: true }],
  ["org-footnote", "Footnotes, such as [fn:1].", { foreground: "accent-ink", underline: true }],
  ["org-target", "Link targets, such as <<target>>.", { underline: true }],
  ["org-ellipsis", "The text a folded heading shows after it, as org-ellipsis says.", { foreground: "warn", underline: true }],
  ["org-hide", "The leading stars of headings org-hide-leading-stars hides, in the colour of the background.", { foreground: "bg" }],
];
for (const [name, doc, attributes] of faces) e8.defineFace({ name, doc, attributes });
for (let i = 1; i <= 8; i++) {
  e8.defineFace({ name: `org-level-${i}`, doc: `Level ${i} headings, and deeper levels in turn.`, attributes: { inherit: `outline-${i}` } });
}

// Text and positions. Positions count characters; JavaScript strings count
// UTF-16 units, which differ for emoji.


/** The position of index `i` of a line's text. */
export function at(line: number, text: string, i: number): number {
  return e8.lineStart(line) + charCount(text.slice(0, i));
}

/** The index in a line's text of a position on it. */
function indexOf(line: number, text: string, pos: number): number {
  const n = pos - e8.lineStart(line);
  if (!/[\uD800-\uDFFF]/.test(text)) return n;
  return Array.from(text).slice(0, n).join("").length;
}

export function isBlank(text: string): boolean {
  return text.trim() === "";
}

export function indentation(text: string): number {
  return (/^[ \t]*/.exec(text)?.[0] ?? "").replace(/\t/g, "        ").length;
}

/** Replaces text and puts point back where it was, moved along with the text around it. */
function replaceText(start: number, end: number, text: string): void {
  let p = e8.point();
  const delta = charCount(text) - (end - start);
  const saved: [Marker, number][] = markers.map((m) => {
    const x = m.pos;
    return [m, x > end || (x === end && end > start) ? x + delta : x > start ? start : x];
  });
  // As a marker would: text inserted at point goes after it.
  if (p > end || (p === end && start < end)) p += delta;
  else if (p > start) p = Math.min(p, start + charCount(text));
  e8.deleteRegion(start, end);
  e8.gotoChar(start);
  e8.insert(text);
  placeMarkers(saved);
  e8.gotoChar(p);
}

function shiftSelectError(): never {
  throw new Error("To use shift-selection with Org mode, customize \u2018org-support-shift-select\u2019");
}

// TODO states

e8.defineHook("org-after-todo-state-change-hook", "Functions called after a heading's TODO state changes, at the heading.");

interface TodoSet {
  todo: string[];
  done: string[];
  /** Each state's fast-access key, as (t) gives it, in order. */
  keys: [string, string | undefined][];
  /** How entering and leaving a state is logged, as (t!) and (w@/!) say: "time" or "note". */
  logs: [string, string | undefined, string | undefined][];
}

/**
 * Reads a list of states such as TODO NEXT | DONE, as org-set-regexps-and-options
 * does: each may have a fast-access key and logging, as TODO(t!) or WAIT(w@/!).
 */
function todoSetFrom(words: string[]): TodoSet | undefined {
  const keys: [string, string | undefined][] = [];
  const logs: [string, string | undefined, string | undefined][] = [];
  const names: string[] = [];
  for (const w of words) {
    if (w === "") continue;
    if (w === "|") {
      names.push(w);
      continue;
    }
    // As org-extract-log-state-settings reads them.
    const m = /^(.*?)(?:\(([^!@/])?([!@])?(?:\/([!@]))?\))?$/.exec(w)!;
    const name = m[1].replace(/\(.*\)$/, "");
    names.push(name);
    keys.push([name, m[2]]);
    const how = (x?: string) => (x === undefined ? undefined : x === "!" ? "time" : "note");
    if (m[3] !== undefined || m[4] !== undefined) logs.push([name, how(m[3]), how(m[4])]);
  }
  if (names.filter((n) => n !== "|").length === 0) return undefined;
  const bar = names.indexOf("|");
  if (bar >= 0) return { todo: names.slice(0, bar), done: names.slice(bar + 1), keys, logs };
  return names.length === 1 ? { todo: [], done: names, keys, logs } : { todo: names.slice(0, -1), done: names.slice(-1), keys, logs };
}

/** The whole buffer's #+KEYWORD: lines, found in one pass. */
export function keywordLines(): [number, number, string][] {
  return e8.saveRestriction(() => {
    e8.widen();
    return e8.matchingLines("^#\\+", { caseFold: true });
  });
}

/** The buffer's TODO sequences: from #+TODO: lines, else org-todo-keywords. */
function readTodoSets(): TodoSet[] {
  const sets: TodoSet[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+(?:TODO|SEQ_TODO|TYP_TODO):(.*)$/i.exec(text);
    const set = m ? todoSetFrom(m[1].trim().split(/\s+/)) : undefined;
    if (set) sets.push(set);
  }
  if (sets.length === 0) {
    const value = e8.variable("org-todo-keywords");
    const lists = Array.isArray(value) && value.every(Array.isArray) ? (value as e8.Value[][]) : [value as e8.Value[]];
    for (const list of lists) {
      const set = Array.isArray(list) ? todoSetFrom(list.map(String)) : undefined;
      if (set) sets.push(set);
    }
  }
  return sets;
}

function todoSets(): TodoSet[] {
  const value = e8.variable("org--todo-sets");
  if (!Array.isArray(value)) return readTodoSets();
  return (value as unknown as [string[], string[], [string, string | null][], [string, string | null, string | null][]][]).map(([todo, done, keys, logs]) => ({
    todo,
    done,
    keys: (keys ?? []).map(([k, c]) => [k, c ?? undefined] as [string, string | undefined]),
    logs: (logs ?? []).map(([k, a, b]) => [k, a ?? undefined, b ?? undefined] as [string, string | undefined, string | undefined]),
  }));
}

function storeTodoSets(): void {
  e8.setVariable("org--todo-sets", readTodoSets().map((s) => [s.todo, s.done, s.keys.map(([k, c]) => [k, c ?? null]), s.logs.map(([k, a, b]) => [k, a ?? null, b ?? null])]));
}

/** How a change from one state to another is logged, as org-todo works out dolog: "time", "note" or nothing. */
function logHow(state: string | undefined, previous: string | undefined): string | undefined {
  const logs = todoSets().flatMap((s) => s.logs);
  return (state === undefined ? undefined : logs.find(([k]) => k === state)?.[1]) ?? (previous === undefined ? undefined : logs.find(([k]) => k === previous)?.[2]);
}

/** The drawer notes go in, as org-log-into-drawer says: LOGBOOK for t, or the name given. */
function logDrawer(): string | undefined {
  const v = e8.variable("org-log-into-drawer");
  return v === true ? "LOGBOOK" : typeof v === "string" && v !== "" ? v : undefined;
}

export function allKeywords(): string[] {
  return todoSets().flatMap((s) => [...s.todo, ...s.done]);
}

export function isDone(keyword: string | undefined): boolean {
  return keyword !== undefined && todoSets().some((s) => s.done.includes(keyword));
}

// Headings

export interface Heading {
  /** The index's epoch its positions are up to date with, for the index's own use. */
  synced?: number;
  line: number;
  start: number;
  /** The end of the heading line, before its newline. */
  end: number;
  level: number;
  todo?: string;
  todoAt?: number;
  priority?: string;
  priorityAt?: number;
  /** Where the title starts, after the stars, state and priority. */
  titleAt: number;
  title: string;
  tags: string[];
  /** Where the tags start, if there are any. */
  tagsAt?: number;
}

const TAGS = /[ \t](:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u;

/**
 * A heading line, if `line` is one. `text` is the line's text and `sorted`
 * the TODO keywords, longest first, when the caller has them already, as
 * headings() does for every heading in the buffer.
 */
export function parseHeading(line: number, keywords = allKeywords(), text = e8.lineText(line), sorted?: string[]): Heading | undefined {
  const h = parseHeadingText(text, keywords, sorted);
  return h && placeHeading(h, line, e8.lineStart(line));
}

/** A heading parsed from its line's text, its positions counted from the line's start. */
function parseHeadingText(text: string, keywords: string[], sorted?: string[]): Heading | undefined {
  const stars = /^(\*+) /.exec(text);
  if (!stars) return undefined;
  let i = stars[0].length;
  while (text[i] === " ") i++;
  const line = 0;
  const start = 0;
  const at = (_line: number, text: string, i: number): number => start + charCount(text.slice(0, i));
  const h: Heading = {
    line,
    start,
    end: start + charCount(text),
    level: stars[1].length,
    titleAt: 0,
    title: "",
    tags: [],
  };
  for (const kw of sorted ?? [...keywords].sort((a, b) => b.length - a.length)) {
    if (text.startsWith(kw, i) && (i + kw.length === text.length || text[i + kw.length] === " ")) {
      h.todo = kw;
      h.todoAt = at(line, text, i);
      i += kw.length;
      while (text[i] === " ") i++;
      break;
    }
  }
  const priority = /^\[#([A-Z0-9])\](?= |$)/.exec(text.slice(i));
  if (priority) {
    h.priority = priority[1];
    h.priorityAt = at(line, text, i);
    i += priority[0].length;
    while (text[i] === " ") i++;
  }
  let titleEnd = text.length;
  const tags = TAGS.exec(text);
  if (tags && tags.index + 1 >= stars[0].length - 1) {
    h.tags = tags[1].split(":").filter((t) => t !== "");
    h.tagsAt = at(line, text, tags.index + 1);
    titleEnd = tags.index;
  }
  i = Math.min(i, Math.max(titleEnd, stars[0].length));
  h.titleAt = at(line, text, i);
  h.title = text.slice(i, Math.max(i, titleEnd)).trimEnd();
  return h;
}

/** A heading parsed from its text, put at its line and the line's start. */
function placeHeading(h: Heading, line: number, start: number): Heading {
  const placed: Heading = { ...h, line, start, end: start + h.end, titleAt: start + h.titleAt, tags: [...h.tags] };
  if (h.todoAt !== undefined) placed.todoAt = start + h.todoAt;
  if (h.priorityAt !== undefined) placed.priorityAt = start + h.priorityAt;
  if (h.tagsAt !== undefined) placed.tagsAt = start + h.tagsAt;
  return placed;
}

export function isHeadingLine(text: string): boolean {
  return /^\*+ /.test(text);
}

/**
 * Heading lines already parsed, by their text, for the TODO keywords
 * `parsedFor`: a change leaves most headings as they were, so only new or
 * changed ones are parsed again.
 */
const parsed = new Map<string, Readonly<Heading> | null>();
let parsedFor = "";

/**
 * A buffer's headings, the whole buffer's, kept up to date as it changes,
 * as Org's element cache follows changes: after an edit only the lines it
 * touched are looked at again, and the headings after it move only when
 * asked for, as Org's cache shifts its elements lazily
 * (org-element--cache-shift-positions). Each change leaves a shift for
 * the headings from an index on; a heading read through the index is moved
 * by the shifts newer than it, in place, as a cached element is, and
 * headings() moves them all.
 */
interface HeadingIndex {
  /** The buffer's modified tick and size when the index was last up to date. */
  tick: number;
  size: number;
  keywords: string;
  all: Heading[];
  /** The shifts not yet applied to every heading they cover, oldest first. */
  pending: Shift[];
  /** Counts the changes followed: a shift, and a heading made or moved, carries the epoch it is from. */
  epoch: number;
  /** Whether headings() has given out `all`, which is then copied before it changes. */
  shared: boolean;
  /** The headings in the accessible portion, for a narrowing. */
  view?: { min: number; max: number; tick: number; headings: readonly Heading[] };
}

/** Moves the headings from index `from` on by `chars` characters and `lines` lines, those older than `epoch`. */
interface Shift {
  from: number;
  chars: number;
  lines: number;
  epoch: number;
}

/** Past so many shifts, they are applied to every heading, as each read looks at them all. */
const MAX_PENDING = 32;

const headingIndexes = new Map<string, HeadingIndex>();

/** The current buffer's index's key: its id, which outlives a rename, and a buffer killed and made again does not share. */
const indexKey = (): string => String(e8.currentBuffer().id);

/** The changes to each indexed buffer since its index was last brought up to date, as after-change-functions gives them. */
const headingChanges = new Map<string, [number, number, number][]>();

// A killed buffer's index goes with it: indirect buffers, capture and the
// agenda's visits each make one.
e8.addHook("kill-buffer-hook", () => {
  headingIndexes.delete(indexKey());
  headingChanges.delete(indexKey());
});

/** Records a change to an Org buffer, for headings() to follow it, and for the parse org-indent-region keeps. */
function headingsAfterChange(beg: number, end: number, oldLen: number): void {
  if (parseShifts && e8.currentBuffer().id === parseShifts.buffer) parseShifts.changes.push([beg, end, oldLen]);
  const name = indexKey();
  if (!headingIndexes.has(name)) return;
  const list = headingChanges.get(name);
  if (list) list.push([beg, end, oldLen]);
  else headingChanges.set(name, [[beg, end, oldLen]]);
}

/** The heading lines from `start` up to `end`, parsed, in the whole buffer, up to date at `epoch`. */
function scanHeadings(keywords: string[], sorted: string[], start?: number, end?: number, epoch = 0): Heading[] {
  const found: Heading[] = [];
  // The heading lines in one pass in the editor, rather than a call per
  // line or the whole text copied here: much the faster in a large buffer.
  const lines = e8.saveRestriction(() => {
    e8.widen();
    return e8.matchingLines("^\\*+ ", { caseFold: false, start, end });
  });
  for (const [line, lineStart, text] of lines) {
    let h = parsed.get(text);
    if (h === undefined) {
      h = parseHeadingText(text, keywords, sorted) ?? null;
      parsed.set(text, h);
    }
    if (h) {
      const placed = placeHeading(h, line, lineStart);
      placed.synced = epoch;
      found.push(placed);
    }
  }
  return found;
}

/** Moves a heading by `chars` characters and `lines` lines, in place. */
function shiftHeading(h: Heading, chars: number, lines: number): void {
  h.line += lines;
  if (chars === 0) return;
  h.start += chars;
  h.end += chars;
  h.titleAt += chars;
  if (h.todoAt !== undefined) h.todoAt += chars;
  if (h.priorityAt !== undefined) h.priorityAt += chars;
  if (h.tagsAt !== undefined) h.tagsAt += chars;
}

/** How far the pending shifts move heading `k` of `index`: characters, then lines. */
function pendingAt(index: HeadingIndex, k: number): [number, number] {
  const synced = index.all[k].synced ?? 0;
  let chars = 0;
  let lines = 0;
  for (const s of index.pending) {
    if (s.from <= k && s.epoch > synced) {
      chars += s.chars;
      lines += s.lines;
    }
  }
  return [chars, lines];
}

/** Where heading `k` of `index` starts, its pending shifts counted. */
function startAt(index: HeadingIndex, k: number): number {
  return index.all[k].start + pendingAt(index, k)[0];
}

/** Heading `k` of `index`, moved by the shifts pending for it. */
function syncHeading(index: HeadingIndex, k: number): Heading {
  const h = index.all[k];
  if (index.pending.length === 0 || (h.synced ?? 0) >= index.epoch) return h;
  const [chars, lines] = pendingAt(index, k);
  if (chars !== 0 || lines !== 0) shiftHeading(h, chars, lines);
  h.synced = index.epoch;
  return h;
}

/** Applies every pending shift, in one pass over the headings they cover. */
function syncAll(index: HeadingIndex): void {
  const pending = index.pending;
  if (pending.length === 0) return;
  const sorted = [...pending].sort((x, y) => x.from - y.from);
  // A heading older than every shift is moved by all of those at or before
  // it, summed as the pass goes; the few read since are counted alone.
  const oldest = Math.min(...pending.map((s) => s.epoch));
  const hs = index.all;
  let chars = 0;
  let lines = 0;
  let s = 0;
  for (let k = sorted[0].from; k < hs.length; k++) {
    while (s < sorted.length && sorted[s].from <= k) {
      chars += sorted[s].chars;
      lines += sorted[s++].lines;
    }
    const h = hs[k];
    if ((h.synced ?? 0) < oldest) {
      if (chars !== 0 || lines !== 0) shiftHeading(h, chars, lines);
    } else if ((h.synced ?? 0) < index.epoch) {
      const [c, l] = pendingAt(index, k);
      if (c !== 0 || l !== 0) shiftHeading(h, c, l);
    }
  }
  // Each shift to come is newer than every heading, so none needs its epoch set.
  index.pending = [];
}

/**
 * Removes headings `i` up to `j` from the index and puts `found` in their
 * place, keeping each shift on the headings it covered.
 */
function replaceHeadings(index: HeadingIndex, i: number, j: number, found: Heading[]): void {
  if (j === i && found.length === 0) return;
  index.all.splice(i, j - i, ...found);
  for (const s of index.pending) if (s.from >= i) s.from = Math.max(i, s.from - (j - i)) + found.length;
}

/**
 * Brings an index up to date with the changes since, or returns false
 * when they cannot be followed, as when an edit ran no change hooks.
 */
function followChanges(index: HeadingIndex, changes: [number, number, number][], keywords: string[], sorted: string[]): boolean {
  // Past so many, finding every heading again is the quicker.
  if (changes.length > 16) return false;
  // Changes made without the hooks, which the sizes would not account for.
  const grown = changes.reduce((sum, [beg, end, oldLen]) => sum + (end - beg) - oldLen, 0);
  if (index.size + grown !== e8.bufferSize()) return false;
  // A caller may still hold the array.
  if (index.shared) {
    index.all = index.all.slice();
    index.shared = false;
  }
  const epoch = ++index.epoch;
  const hs = index.all;
  // The first heading whose line ends at or after `pos`, by halving, as the
  // headings stay in order however far they moved.
  const firstEndingFrom = (pos: number): number => {
    let [lo, hi] = [0, hs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid].end + pendingAt(index, mid)[0] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Where each heading's line may have moved from, by the change it follows.
  const dirty: [number, number][] = [];
  for (const [beg, end, oldLen] of changes) {
    const oldEnd = beg + oldLen;
    const chars = end - beg - oldLen;
    // Headings whose line the change touched go, to be found again.
    const i = firstEndingFrom(beg);
    let j = i;
    while (j < hs.length && startAt(index, j) <= oldEnd) j++;
    replaceHeadings(index, i, j, []);
    if (chars !== 0 && i < hs.length) index.pending.push({ from: i, chars, lines: 0, epoch });
    for (const r of dirty) {
      if (r[0] > oldEnd) {
        r[0] += chars;
        r[1] += chars;
      } else if (r[1] >= beg) {
        r[1] = Math.max(r[0], r[1] >= oldEnd ? r[1] + chars : end, end);
      }
    }
    dirty.push([beg, end]);
  }
  // Line numbers, which the changes' positions do not give: the headings
  // between one change and the next moved by as many lines as the first of
  // them did, so one lookup does for each such stretch, and a shift holds
  // the difference from the stretch before.
  const bounds = dirty.map((r) => r[1]).sort((x, y) => x - y);
  const stretches: [number, number][] = [];
  let k = firstEndingFrom(Math.min(...dirty.map((r) => r[0])));
  for (const bound of [...bounds, Infinity]) {
    if (k >= hs.length) break;
    if (startAt(index, k) > bound) continue;
    const [chars, lines] = pendingAt(index, k);
    stretches.push([k, e8.lineOf(hs[k].start + chars) - (hs[k].line + lines)]);
    // The first heading past this bound starts the next stretch.
    let [lo, hi] = [k, hs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startAt(index, mid) <= bound) lo = mid + 1;
      else hi = mid;
    }
    k = lo;
  }
  let before = 0;
  for (const [from, lines] of stretches) {
    if (lines !== before) index.pending.push({ from, chars: 0, lines: lines - before, epoch });
    before = lines;
  }
  // The lines the changes touched, looked at again.
  for (const [from, to] of mergeRanges(dirty)) {
    const start = e8.lineStart(e8.lineOf(Math.min(from, e8.bufferSize())));
    const stop = e8.lineEnd(e8.lineOf(Math.min(to, e8.bufferSize())));
    const found = scanHeadings(keywords, sorted, start, stop, epoch);
    let [lo, hi] = [0, hs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startAt(index, mid) < start) lo = mid + 1;
      else hi = mid;
    }
    let j = lo;
    while (j < hs.length && startAt(index, j) <= stop) j++;
    replaceHeadings(index, lo, j, found);
  }
  if (index.pending.length > MAX_PENDING) syncAll(index);
  return true;
}

/** Ranges sorted and joined where they meet or overlap. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.map((r): [number, number] => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/**
 * Whether the current buffer's heading index, as its changes left it,
 * agrees with finding every heading again: nil if so, else where they
 * first differ, as Org's org-element--cache-self-verify checks its cache.
 */
e8.defun("org--headings-verify", (only?: number) => {
  // With an index, only that heading, read as the element parser reads
  // one, leaving the shifts pending for the rest.
  const kept = typeof only === "number" ? headingsAsRead() : headings();
  const keywords = allKeywords();
  const fresh = scanHeadings(keywords, [...keywords].sort((a, b) => b.length - a.length)).filter((h) => h.start >= e8.pointMin() && h.start < e8.pointMax());
  const show = (h?: Heading) => (h === undefined ? "none" : JSON.stringify(h, (key, value) => (key === "synced" ? undefined : value)));
  if (typeof only === "number") {
    if (kept.length !== fresh.length) return `${kept.length} headings kept, ${fresh.length} found`;
    const i = only % Math.max(1, fresh.length);
    return show(kept[i]) === show(fresh[i]) ? null : `heading ${i}: kept ${show(kept[i])}, found ${show(fresh[i])}`;
  }
  for (let i = 0; i < Math.max(kept.length, fresh.length); i++) {
    if (show(kept[i]) !== show(fresh[i])) return `heading ${i}: kept ${show(kept[i])}, found ${show(fresh[i])}`;
  }
  return null;
});

/** The current buffer's index, brought up to date with its changes, its shifts perhaps still pending. */
function currentIndex(): HeadingIndex {
  const keywords = allKeywords();
  const keywordsKey = keywords.join(" ");
  if (keywordsKey !== parsedFor || parsed.size > 100_000) {
    parsed.clear();
    parsedFor = keywordsKey;
  }
  const name = indexKey();
  const tick = e8.bufferModifiedTick();
  let index = headingIndexes.get(name);
  if (!index || index.keywords !== keywordsKey || index.tick !== tick) {
    const sorted = [...keywords].sort((a, b) => b.length - a.length);
    const changes = headingChanges.get(name);
    headingChanges.delete(name);
    const followed = index !== undefined && index.keywords === keywordsKey && changes !== undefined && followChanges(index, changes, keywords, sorted);
    if (!followed) {
      index = { tick, size: e8.bufferSize(), keywords: keywordsKey, all: scanHeadings(keywords, sorted), pending: [], epoch: 0, shared: false };
      headingIndexes.set(name, index);
    }
    index!.tick = tick;
    index!.size = e8.bufferSize();
    index!.view = undefined;
  }
  return index!;
}

/**
 * The buffer's headings, top to bottom, in its accessible portion, as Org's
 * searches find them. Kept up to date as the buffer changes, since the
 * commands and the element parser ask for them many times per key; shared,
 * so not to be changed, and moved in place by later edits once asked for
 * again, as Org's cached elements are.
 */
export function headings(): Heading[] {
  const index = currentIndex();
  syncAll(index);
  index.shared = true;
  const [min, max] = [e8.pointMin(), e8.pointMax()];
  if (min === 0 && max === e8.bufferSize()) return index.all;
  if (index.view?.min !== min || index.view.max !== max) {
    index.view = { min, max, tick: index.tick, headings: index.all.filter((h) => h.start >= min && h.start < max) };
  }
  return index.view.headings as Heading[];
}

/**
 * The headings as headings() gives them, for a caller that reads only a
 * few, as the element parser does: each is moved by the shifts pending for
 * it as it is read, rather than all of them first. Narrowed, it is
 * headings() itself.
 */
export function headingsAsRead(): Heading[] {
  const index = currentIndex();
  if (e8.pointMin() !== 0 || e8.pointMax() !== e8.bufferSize()) return headings();
  // Not marked shared: the parser reads it and lets it go before any edit.
  if (index.pending.length === 0) return index.all;
  return new Proxy(index.all, {
    get(target, key, receiver) {
      if (typeof key === "string") {
        const k = Number(key);
        if (Number.isInteger(k) && k >= 0 && k < target.length) return syncHeading(index, k);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/** The heading whose entry a line is in: the nearest heading at or above it. */
export function headingIndex(all: Heading[], line: number): number | undefined {
  // By halving, as the headings are in order.
  let [lo, hi] = [0, all.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].line <= line) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lo - 1 : undefined;
}

/**
 * The heading point is under, or Org's error, which reports the start of
 * point's line, counting from 1. With `move`, point goes there before the
 * error, as when a command calls org-back-to-heading outside
 * save-excursion.
 */
function backToHeading(move = false): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) {
    const bol = e8.lineStart(lineAt());
    if (move) e8.gotoChar(bol);
    e8.userError(`Before first headline at position ${bol + 1} in buffer ${e8.bufferName()}`);
  }
  return [all, i];
}

/**
 * The heading org-back-to-heading finds without invisible-ok: the one on
 * point's line or above it, or the nearest heading above that which shows.
 */
function visibleHeadingIndex(all: Heading[], line: number): number | undefined {
  const i = headingIndex(all, line);
  if (i === undefined) return undefined;
  for (const a of [i, ...ancestors(all, i)]) if (!e8.invisibleAt(all[a].start)) return a;
  return i;
}

/** The heading on point's line, if it is a heading line. */
function headingHere(): [Heading[], number] | undefined {
  if (!isHeadingLine(e8.lineText(lineAt()))) return undefined;
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : [all, i];
}

/** The index of the first heading starting at or after `pos`, by halving. */
export function firstHeadingFrom(all: Heading[], pos: number): number {
  let [lo, hi] = [0, all.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The index of the heading starting at `pos`, or -1, by halving. */
function headingStartingAt(all: Heading[], pos: number): number {
  const i = firstHeadingFrom(all, pos);
  return all[i]?.start === pos ? i : -1;
}

/** The first heading from index `from` on that `test` accepts, without copying those after it. */
export function findFrom(all: Heading[], from: number, test: (h: Heading) => boolean): Heading | undefined {
  for (let k = from; k < all.length; k++) if (test(all[k])) return all[k];
  return undefined;
}

/** The next heading after `i` at its level or higher, if any. */
export function nextSameOrHigher(all: Heading[], i: number): Heading | undefined {
  const level = all[i].level;
  for (let j = i + 1; j < all.length; j++) if (all[j].level <= level) return all[j];
  return undefined;
}

/**
 * Where a heading's subtree ends for folding: before the newline of the
 * next heading at its level or higher, or at the end of the buffer, as
 * org-fold-subtree takes it.
 */
export function subtreeEnd(all: Heading[], i: number): number {
  const next = nextSameOrHigher(all, i);
  return next ? next.start - 1 : e8.pointMax();
}

/** Where a heading's entry ends for showing it: at the next heading, as org-fold-show-entry takes it. */
export function entryEnd(all: Heading[], i: number): number {
  return all[i + 1]?.start ?? e8.pointMax();
}

/**
 * Where a subtree's text starts and ends for moving or killing it: whole
 * lines, up to the end of the accessible portion if the buffer is narrowed.
 */
export function subtreeRegion(all: Heading[], i: number): [number, number] {
  const next = nextSameOrHigher(all, i);
  return [all[i].start, next ? next.start : e8.pointMax()];
}

// Narrowing, as org.el's org-narrow-to-subtree and its kin.

const narrowToSubtree = e8.defineCommand({
  name: "org-narrow-to-subtree",
  doc: "Narrow the buffer to the current subtree: the heading point is under and everything below it.",
  run: () => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (i === undefined || all[i].start < e8.pointMin()) throw new Error("Before first heading");
    const end = subtreeRegion(all, i)[1];
    // The subtree's last newline stays outside, and an existing narrowing is not widened.
    e8.narrowToRegion(all[i].start, Math.min(e8.pointMax(), end === e8.pointMax() ? end : end - 1));
  },
});

// Subtrees in indirect buffers, as org.el's org-tree-to-indirect-buffer.

/** The buffer the last C-c C-x b made, which the next one kills, as org-last-indirect-buffer. */
let lastIndirectBuffer: e8.Buffer | undefined;
/** The frame "dedicated-frame" shows indirect buffers in, as org-indirect-dedicated-frame. */
let indirectDedicatedFrame: number | undefined;

/** An indirect buffer of `buffer`'s base, named after it and `heading`, as org-get-indirect-buffer. */
function getIndirectBuffer(buffer: e8.Buffer, heading?: string): e8.Buffer {
  const base = e8.bufferBaseBuffer(buffer) ?? buffer;
  const name = e8.generateNewBufferName(`${base.name}${heading === undefined ? "" : `::${heading}`}`);
  return e8.makeIndirectBuffer(base, name, true);
}

/** The window showing `buffer`, if one does. */
function bufferWindow(buffer: e8.Buffer): number | undefined {
  return buffer.live ? e8.windowList().find((w) => e8.windowBuffer(w) === buffer.name) : undefined;
}

const treeToIndirectBuffer = e8.defineCommand({
  name: "org-tree-to-indirect-buffer",
  doc:
    "Show the current subtree in an indirect buffer of its own, narrowed to it: the same text, folded apart.\n\n" +
    "A numeric prefix argument takes the subtree of the heading at that level above, or that many levels up " +
    "if negative. Unless org-indirect-buffer-display is new-frame, the indirect buffer the command made last " +
    "is killed first; with C-u it is kept.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const cbuf = e8.currentBuffer();
    const cwin = e8.selectedWindow();
    const pos = e8.point();
    const display = String(e8.variable("org-indirect-buffer-display"));
    const lastWindow = lastIndirectBuffer && bufferWindow(lastIndirectBuffer);
    const [all, found] = backToHeading();
    let i = found;
    if (typeof arg === "number") {
      const level = arg < 0 ? all[i].level + arg : arg;
      // Up to the heading at that level, as org-up-heading-safe climbs.
      while (all[i].level > level) {
        let parent = i - 1;
        while (parent >= 0 && all[parent].level >= all[i].level) parent--;
        if (parent < 0) break;
        i = parent;
      }
    }
    const h = all[i];
    const heading = [h.todo, h.priority === undefined ? undefined : `[#${h.priority}]`, h.title].filter((x) => x).join(" ");
    const beg = h.start;
    let end = subtreeRegion(all, i)[1];
    // Up to the next heading's line, not its start, as org-end-of-subtree leaves it.
    if (end < e8.pointMax()) end--;
    if (lastIndirectBuffer?.live && display !== "new-frame" && arg === null) e8.call("kill-buffer", lastIndirectBuffer.name ?? "");
    const ibuf = getIndirectBuffer(cbuf, heading);
    lastIndirectBuffer = ibuf;
    if (display === "new-frame" || (arg !== null && display === "dedicated-frame")) {
      e8.makeFrame(ibuf);
    } else if (display === "dedicated-frame") {
      if (indirectDedicatedFrame === undefined || !e8.frameList().includes(indirectDedicatedFrame)) {
        indirectDedicatedFrame = e8.makeFrame(ibuf);
      } else {
        e8.selectFrame(indirectDedicatedFrame);
        e8.setWindowBuffer(undefined, ibuf);
      }
    } else if (display === "current-window") {
      e8.setWindowBuffer(undefined, ibuf);
    } else if (display === "other-window") {
      if (lastWindow !== undefined && e8.windowList().includes(lastWindow)) {
        e8.setWindowBuffer(lastWindow, ibuf);
        e8.selectWindow(lastWindow);
      } else {
        e8.call("pop-to-buffer", ibuf.name ?? "");
      }
    } else {
      throw new Error("Invalid value");
    }
    e8.withCurrentBuffer(ibuf, () => {
      e8.narrowToRegion(beg, end);
      e8.call("org-show-all");
      e8.gotoChar(pos);
    });
    if (e8.windowList().includes(cwin)) e8.selectWindow(cwin);
  },
});

e8.defineCommand({
  name: "org-toggle-narrow-to-subtree",
  doc: "Narrow to the current subtree, or widen if the buffer is narrowed.",
  run: () => {
    if (e8.bufferNarrowedP()) {
      e8.widen();
      e8.message("Buffer widen");
    } else {
      e8.call("org-narrow-to-subtree");
      e8.message("Buffer narrowed to current subtree");
    }
  },
});

const narrowToElement = e8.defineCommand({
  name: "org-narrow-to-element",
  doc: "Narrow the buffer to the element at point: a heading's subtree, a greater element's contents, or the element.",
  run: () => {
    const e = elementAt(e8.point());
    if (!e) e8.userError("No element at point");
    if (e.type !== "headline" && GREATER_ELEMENTS.includes(e.type) && e.contentsBegin !== undefined) {
      e8.narrowToRegion(e.contentsBegin, e.contentsEnd ?? e.end);
    } else {
      e8.narrowToRegion(e.begin, e.end);
    }
  },
});

const narrowToBlock = e8.defineCommand({
  name: "org-narrow-to-block",
  doc: "Narrow the buffer to the block at point.",
  run: () => {
    const e = elementAt(e8.point());
    if (!e || !e.type.includes("block")) e8.userError("Not in a block");
    e8.call("org-narrow-to-element");
  },
});

/** Where notes about state changes go in a heading's entry, as org-log-beginning finds it. */
/** The line of a log drawer logBeginning has just made, to fold once the note is in, as Org folds it. */
let newDrawerLine: number | undefined;

function logBeginning(h: Heading, create = false): number {
  const drawer = logDrawer();
  if (drawer !== undefined) {
    // As org-log-beginning: at the top of the drawer, newest first, made after the entry's metadata if need be.
    const meta = endOfMetaData(h);
    const all = headings();
    const i = headingIndex(all, h.line);
    const end = i === undefined ? e8.bufferSize() : (all[i + 1]?.start ?? e8.bufferSize());
    const opener = new RegExp(`^[ \t]*:${escapeRegExp(drawer)}:[ \t]*$`, "i");
    for (let l = lineAt(meta); l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      if (opener.test(e8.lineText(l))) return lineStartOrEnd(l + 1);
    }
    if (!create) return meta;
    let at = meta;
    // Before the next heading, at the end of the line before it.
    if (at < e8.bufferSize() && at === end) at = Math.max(e8.lineStart(lineAt(at)) - 1, 0);
    // As looking-at "^[ \t]*$": only at the start of a line.
    const atBlank = at === e8.lineStart(lineAt(at)) && /^[ \t]*$/.test(e8.bufferText(at, e8.lineEnd(lineAt(at))));
    const atNonBlankStart = at === e8.lineStart(lineAt(at)) && at < e8.lineEnd(lineAt(at));
    withoutFoldChecks(() => {
      if (at !== e8.lineStart(lineAt(at))) {
        edInsert(at, "\n");
        at++;
      }
      const text = `:${drawer}:\n:END:`;
      edInsert(at, text);
      if (atBlank || atNonBlankStart) edInsert(at + charCount(text), "\n");
    });
    newDrawerLine = lineAt(at);
    return lineStartOrEnd(lineAt(at) + 1);
  }
  const endpos = endOfMetaData(h);
  let p = endpos;
  while (p < e8.bufferSize() && /[ \t\n]/.test(e8.bufferText(p, p + 1))) p++;
  p = e8.lineStart(lineAt(p));
  if (p < endpos) p = endpos;
  return p === e8.lineStart(lineAt(p)) ? p : lineStartOrEnd(lineAt(p) + 1);
}

/** Adds a note about a state change to a heading's entry, as org-store-log-note does for a repeating task. */
function storeStateNote(headingLine: number, state: string, previous: string | undefined): void {
  const h = parseHeading(headingLine);
  if (!h) return;
  const p = marker(e8.point());
  newDrawerLine = undefined;
  withoutFoldChecks(() => {
    let at = logBeginning(h, true);
    if (at !== e8.lineStart(lineAt(at))) {
      edInsert(at, "\n");
      at++;
    } else if (/^[ \t]*\S/.test(e8.bufferText(at, e8.lineEnd(lineAt(at))))) {
      edInsert(at, "\n");
    }
    const pad = (x: string): string => x.padEnd(12, " ");
    const time = `[${formatTimestamp(today(true), true)}]`;
    const note = `State ${pad(`"${state}"`)} from ${pad(previous === undefined ? "" : `"${previous}"`)} ${time}`;
    e8.gotoChar(at);
    indentLine(lineAt(at));
    edInsert(e8.point(), `- ${note}`);
    if (newDrawerLine !== undefined) toggleDrawerOrBlock(newDrawerLine, true);
    newDrawerLine = undefined;
  });
  e8.gotoChar(p.pos);
  dropMarker(p);
}

export const COOKIE = /\[(\d*\/\d*|\d*%)\]/g;
const HAS_COOKIE = /\[(\d*\/\d*|\d*%)\]/;

/**
 * Brings the checkbox statistics cookies of point's section up to date, as
 * org-update-checkbox-count does: a cookie in an item counts its children's
 * boxes, one elsewhere the top items of the section's lists.
 */
export function updateCheckboxCount(): void {
  const saved = marker(e8.point());
  try {
    const all = headings();
    const p = e8.point();
    // From the heading before point, as outline-previous-heading finds it:
    // searching back, so a heading's own stars must end before point.
    const previousHeading = (pos: number) => all.filter((h) => h.start + h.level + 1 <= pos).at(-1)?.start ?? 0;
    const nextHeading = (pos: number) => all.find((h) => h.start > pos)?.start ?? e8.bufferSize();
    const start = previousHeading(p);
    const end = nextHeading(p);
    const cookies: { start: number; end: number; percent: boolean; count: [number, number] }[] = [];
    const countIn = (from: number, to: number, item: number | undefined): [number, number] => {
      let on = 0;
      let total = 0;
      for (let l = lineAt(from); l < e8.lineCount() && e8.lineStart(l) < to; l++) {
        if (e8.lineStart(l) < from) continue;
        if (!/^[ \t]*(?:[-+*]|(?:\d+|[A-Za-z])[.)])[ \t]+(?:\[@(?:start:)?(?:\d+|[A-Za-z])\][ \t]*)?\[[- X]\]/.test(e8.lineText(l))) continue;
        if (!itemLine(l)) continue;
        const s = listStruct(l);
        const items = item !== undefined ? children(item, parentsAlist(s)) : allItems(s[0].pos, prevsAlist(s));
        for (const e of items) {
          const box = getItem(s, e).checkbox;
          if (box === undefined) continue;
          total++;
          if (box === "[X]") on++;
        }
        l = lineAt(Math.min(bottomPoint(s), to)) - 1;
        if (bottomPoint(s) >= to) break;
      }
      return [on, total];
    };
    for (let l = lineAt(start); l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      const text = e8.lineText(l);
      for (const m of allMatches(COOKIE, text)) {
        const cs = e8.lineStart(l) + charCount(text.slice(0, m.index ?? 0));
        if (cs < start || cs >= end) continue;
        const container = inItem(l);
        let count: [number, number];
        if (container !== undefined && !isHeadingLine(text)) {
          const s = listStruct(lineAt(container));
          count = countIn(container, getItem(s, container).end, container);
        } else {
          // A cookie elsewhere counts the boxes in its own section.
          const from = previousHeading(cs + charCount(m[0]));
          count = countIn(from, nextHeading(from), undefined);
        }
        cookies.push({ start: cs, end: cs + charCount(m[0]), percent: m[1].endsWith("%"), count });
      }
    }
    for (const c of cookies.reverse()) {
      const [on, total] = c.count;
      const value = c.percent ? `[${Math.floor((100 * on) / Math.max(1, total))}%]` : `[${on}/${total}]`;
      withoutFoldChecks(() => {
        edInsert(c.start, value);
        edDelete(c.start + charCount(value), c.end + charCount(value));
      });
      const h = parseHeading(lineAt(c.start));
      if (h && h.tagsAt !== undefined) alignTags(h.line);
    }
  } finally {
    e8.gotoChar(saved.pos);
    dropMarker(saved);
  }
}

/** Rewrites the statistics cookies on a line, such as [/] or [50%], for a count. */
function writeCookies(line: number, done: number, total: number): void {
  // As org-update-parent-todo-statistics does, a cookie that changes gets
  // the new text inserted before it and the old deleted after, so point
  // inside it ends up after the new one.
  const pt = marker(e8.point());
  const count = allMatches(COOKIE, e8.lineText(line)).length;
  for (let k = 0; k < count; k++) {
    const text = e8.lineText(line);
    const m = allMatches(COOKIE, text)[k];
    if (!m) break;
    const percent = m[1].endsWith("%");
    const value = percent ? `[${total === 0 ? 0 : Math.floor((100 * done) / total)}%]` : `[${done}/${total}]`;
    if (value === m[0]) continue;
    const start = at(line, text, m.index ?? 0);
    edInsert(start, value);
    edDelete(start + charCount(value), start + charCount(value) + charCount(m[0]));
    // org-fix-tags-on-the-fly, with org-auto-align-tags on.
    if (parseHeading(line)?.tagsAt !== undefined) alignTagsAway(line);
  }
  e8.gotoChar(pt.pos);
  dropMarker(pt);
}

/**
 * Brings a heading's statistics cookies up to date, as
 * org-update-statistics-cookies does there: from checkboxes if its text has
 * any, else from its children's TODO states, else as if complete.
 */
function updateHeadingCookies(all: Heading[], i: number): void {
  const h = all[i];
  const end = all[i + 1]?.start ?? e8.bufferSize();
  let boxes = false;
  for (let l = h.line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    if (/^[ \t]*([-+*]|[0-9]+[.)]) \[[- X]\]/.test(e8.lineText(l))) boxes = true;
  }
  if (boxes) {
    const p = e8.point();
    e8.gotoChar(h.end);
    updateCheckboxCount();
    e8.gotoChar(p);
    return;
  }
  const next = all[i + 1];
  if (next && next.level > h.level) {
    const sub = subtreeRegion(all, i)[1];
    const states: Heading[] = [];
    for (let k = i + 1; k < all.length && all[k].start < sub; k++) if (all[k].level === next.level && all[k].todo !== undefined) states.push(all[k]);
    writeCookies(h.line, states.filter((x) => isDone(x.todo)).length, states.length);
  } else {
    const text = e8.lineText(h.line);
    for (const m of allMatches(COOKIE, text).reverse()) {
      const start = at(h.line, text, m.index ?? 0);
      replaceText(start, start + charCount(m[0]), m[1].endsWith("%") ? "[100%]" : "[0/0]");
    }
  }
}

/** Folds or shows an item, as org-list-set-item-visibility does. */
function setItemVisibility(item: number, struct: Struct, view: "folded" | "children" | "subtree"): void {
  if (view === "folded") flag(e8.lineEnd(lineAt(item)), itemEndBeforeBlank(struct, item), true);
  else if (view === "subtree") flag(item, getItem(struct, item).end, false);
  else {
    setItemVisibility(item, struct, "subtree");
    for (const child of children(item, parentsAlist(struct))) setItemVisibility(child, struct, "folded");
  }
}

// Items as the fontifier and indentation see them: the first line's parts.

interface Item {
  line: number;
  start: number;
  indent: number;
  bullet: string;
  bulletAt: number;
  /** Where the item's text starts, after the bullet and its spaces. */
  contentAt: number;
  /** The column the item's text starts at, which its later lines line up with. */
  contentColumn: number;
  checkbox?: string;
  checkboxAt?: number;
}

const ITEM = /^([ \t]*)([-+*]|\d+[.)])([ \t]+|$)/;

function parseItem(line: number): Item | undefined {
  if (line < 0 || line >= e8.lineCount()) return undefined;
  const text = e8.lineText(line);
  const m = ITEM.exec(text);
  if (!m || (m[1] === "" && m[2] === "*")) return undefined;
  const contentIndex = m[0].length;
  const item: Item = {
    line,
    start: e8.lineStart(line),
    indent: indentation(text),
    bullet: m[2],
    bulletAt: at(line, text, m[1].length),
    contentAt: at(line, text, contentIndex),
    contentColumn: indentation(m[1]) + m[2].length + Math.max(1, m[3].length),
  };
  const box = /^\[([ X-])\](?=[ \t]|$)/.exec(text.slice(contentIndex));
  if (box) {
    item.checkbox = box[1];
    item.checkboxAt = at(line, text, contentIndex);
  }
  return item;
}

/** The innermost item a line is part of, as org-in-item-p finds it. */
function itemAtLine(line: number): Item | undefined {
  const start = inItem(line);
  return start === undefined ? undefined : parseItem(lineAt(start));
}

/** The item on point's line, if the line starts one. */
function itemHere(): Item | undefined {
  return itemLine(lineAt()) ? parseItem(lineAt()) : undefined;
}

// Fontifying

/** Puts a face on a stretch, ahead of the faces already there. */
function face(start: number, end: number, name: string): void {
  if (end > start) e8.addFaceTextProperty(start, end, name);
}

function hide(start: number, end: number, spec = "org-link"): void {
  if (end > start) e8.putTextProperty(start, end, "invisible", spec);
}

export const LINK = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([^\n]+?)\])?\]/g;
export const PLAIN_LINK = /(?:^|(?<=[\s(]))(?:https?|ftp|mailto|file|news|doi):[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g;
export const ANGLE_LINK = /<(?:https?|ftp|mailto|file|news|doi):[^>\n]*>/g;
const TIMESTAMP = /[<[]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[>\]](?:--[<[]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[>\]])?/g;
const EMPHASIS = /(^|[-\s('"{])(([*/_=~+])([^\s]|[^\s].*?[^\s])\3)(?=[-\s.,:!?;'")}[]|$)/g;
const EMPHASIS_FACES: { [marker: string]: string } = {
  "*": "bold",
  "/": "italic",
  _: "underline",
  "=": "org-verbatim",
  "~": "org-code",
  "+": "org-strike-through",
};

/** Styles links, timestamps, emphasis, cookies and footnotes in part of a line. */
function fontifyObjects(line: number, text: string, from: number, to = text.length): void {
  // Matched from `from`, so the stars of a heading cannot start an emphasis.
  const part = text.slice(from, to);
  const pos = (i: number) => at(line, text, i + from);
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);
  for (const m of allMatches(LINK, part)) {
    const i = m.index ?? 0;
    const end = i + m[0].length;
    taken.push([i, end]);
    face(pos(i), pos(end), "org-link");
    if (e8.variable("org-link-descriptive") === true) {
      if (m[2] !== undefined) {
        const desc = i + 2 + m[1].length + 2;
        hide(pos(i), pos(desc));
        hide(pos(desc + m[2].length), pos(end));
      } else {
        hide(pos(i), pos(i + 2));
        hide(pos(end - 2), pos(end));
      }
    }
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of allMatches(re, part)) {
      const i = m.index ?? 0;
      const end = i + m[0].length;
      if (overlaps(i, end)) continue;
      taken.push([i, end]);
      face(pos(i), pos(end), "org-link");
    }
  }
  for (const m of allMatches(TIMESTAMP, part)) {
    const i = m.index ?? 0;
    if (!overlaps(i, i + m[0].length)) face(pos(i), pos(i + m[0].length), "org-date");
  }
  for (const m of allMatches(COOKIE, part)) {
    const i = m.index ?? 0;
    const [a, b] = m[1].endsWith("%") ? [m[1] === "100%" ? 1 : 0, 1] : m[1].split("/").map(Number);
    face(pos(i), pos(i + m[0].length), b > 0 && a === b ? "org-checkbox-statistics-done" : "org-checkbox-statistics-todo");
  }
  for (const m of allMatches(/\[fn:[^\]\s]*\]/g, part)) {
    const i = m.index ?? 0;
    face(pos(i), pos(i + m[0].length), "org-footnote");
  }
  for (const m of allMatches(/<<[^<>\n]+>>/g, part)) {
    const i = m.index ?? 0;
    if (!overlaps(i, i + m[0].length)) face(pos(i), pos(i + m[0].length), "org-target");
  }
  for (const m of allMatches(EMPHASIS, part)) {
    const i = (m.index ?? 0) + m[1].length;
    const end = i + m[2].length;
    if (overlaps(i, end)) continue;
    face(pos(i), pos(end), EMPHASIS_FACES[m[3]]);
    if (e8.variable("org-hide-emphasis-markers") === true) {
      hide(pos(i), pos(i + 1), "org-emphasis");
      hide(pos(end - 1), pos(end), "org-emphasis");
    }
  }
}

/**
 * A face from a face's name, a colour, or a list of attributes, over the
 * face `inherit`, as org-face-from-face-or-color makes one.
 */
function faceFromFaceOrColor(inherit: string, spec: e8.Value | undefined): e8.Value | undefined {
  if (typeof spec === "string") return e8.facep(spec) ? spec : [":inherit", inherit, ":foreground", spec];
  if (Array.isArray(spec)) return [":inherit", inherit, ...spec];
  return undefined;
}

/** The value an alist of [key, value] lists gives a key. */
function alistGet(name: string, key: string): e8.Value | undefined {
  const alist = e8.variable(name);
  if (!Array.isArray(alist)) return undefined;
  const entry = alist.find((e) => Array.isArray(e) && e[0] === key) as e8.Value[] | undefined;
  return entry === undefined ? undefined : entry.length === 2 ? entry[1] : entry.slice(1);
}

function fontifyHeading(h: Heading, text: string): void {
  e8.putTextProperty(h.start, h.end, "face", `org-level-${((h.level - 1) % 8) + 1}`);
  // All but the last star, as org-get-level-face gives them org-hide.
  if (h.level > 1 && e8.variable("org-hide-leading-stars") === true) e8.putTextProperty(h.start, h.start + h.level - 1, "face", "org-hide");
  if (h.todo !== undefined && h.todoAt !== undefined) {
    const done = isDone(h.todo);
    if (done && e8.variable("org-fontify-done-headline") === true) face(h.todoAt, h.end, "org-headline-done");
    // As org-get-todo-face: the keyword's own face from org-todo-keyword-faces, else org-done or org-todo.
    const own = faceFromFaceOrColor("org-todo", alistGet("org-todo-keyword-faces", h.todo));
    if (own !== undefined) e8.addFaceTextProperty(h.todoAt, h.todoAt + charCount(h.todo), own as e8.Value[] | string);
    else face(h.todoAt, h.todoAt + charCount(h.todo), done ? "org-done" : "org-todo");
  }
  if (h.priorityAt !== undefined) face(h.priorityAt, h.priorityAt + 4, "org-priority");
  if (h.tagsAt !== undefined) {
    face(h.tagsAt, h.end, "org-tag");
    // Each tag in its own face from org-tag-faces, as org-get-tag-face gives it.
    if (Array.isArray(e8.variable("org-tag-faces"))) {
      let at = h.tagsAt + 1;
      for (const tag of h.tags) {
        const own = faceFromFaceOrColor("org-tag", alistGet("org-tag-faces", tag));
        if (own !== undefined) e8.addFaceTextProperty(at, at + charCount(tag), own as e8.Value[] | string);
        at += charCount(tag) + 1;
      }
    }
  }
  const titleIndex = indexOf(h.line, text, h.titleAt);
  const tagsIndex = h.tagsAt === undefined ? text.length : indexOf(h.line, text, h.tagsAt);
  fontifyObjects(h.line, text, titleIndex, tagsIndex);
}

/** The block a line is inside, by looking back for its #+begin_ line. */
function blockBefore(line: number): string | undefined {
  for (let l = line - 1; l >= 0; l--) {
    const text = e8.lineText(l);
    if (BLOCK_END.test(text)) return undefined;
    const begin = BLOCK_BEGIN.exec(text);
    if (begin) return begin[1].toLowerCase();
    if (isHeadingLine(text)) return undefined;
  }
  return undefined;
}

const KEYWORD = /^([ \t]*#\+(\w+):)(.*)$/;

/**
 * Fontifies the source block that starts on `beginLine` as its language's
 * mode would, with org-src-fontify-natively, then gives its text the
 * org-block face too, newlines and all, as Emacs does. The line it ends on, if it could.
 */
function fontifySrcNatively(beginLine: number): number | undefined {
  if (!truthy(e8.variable("org-src-fontify-natively")) || !e8.fboundp("org-src-font-lock-fontify-block")) return undefined;
  const lang = /^[ \t]*#\+begin_src[ \t]+(\S+)/i.exec(e8.lineText(beginLine))?.[1];
  if (lang === undefined) return undefined;
  let endLine = beginLine + 1;
  while (endLine < e8.lineCount() && !BLOCK_END.test(e8.lineText(endLine))) endLine++;
  if (endLine >= e8.lineCount()) return undefined;
  if (!truthy(e8.funcall("org-src-font-lock-fontify-block", lang, e8.lineStart(beginLine + 1), e8.lineStart(endLine)))) return undefined;
  if (endLine > beginLine + 1) e8.addFaceTextProperty(e8.lineStart(beginLine + 1), e8.lineStart(endLine), "org-block", { append: true });
  return endLine;
}

/** Where a block's #+begin or #+end line's face ends: after its newline, as org-fontify-whole-block-delimiter-line says. */
function delimiterEnd(lineEnd: number): number {
  return truthy(e8.variable("org-fontify-whole-block-delimiter-line")) ? Math.min(lineEnd + 1, e8.pointMax()) : lineEnd;
}

/** Fontifies whole lines from start to end, for jit-lock-functions. */
function fontify(start: number, end: number): void {
  if (!e8.derivedModeP("org-mode")) return;
  const first = e8.lineOf(start);
  const from = e8.lineStart(first);
  e8.removeTextProperty(from, end, "face");
  e8.removeTextProperty(from, end, "invisible");
  const keywords = allKeywords();
  let block = blockBefore(first);
  let firstLine = first;
  if (block === "src") {
    // In a source block: fontify all of it, from its #+begin_src line.
    let begin = first - 1;
    while (begin >= 0 && !BLOCK_BEGIN.test(e8.lineText(begin))) begin--;
    if (begin >= 0) firstLine = fontifySrcNatively(begin) ?? first;
  }
  for (let line = firstLine; line < e8.lineCount() && e8.lineStart(line) < Math.max(end, from + 1); line++) {
    const text = e8.lineText(line);
    const ls = e8.lineStart(line);
    const le = e8.lineEnd(line);
    if (block !== undefined) {
      // Each face takes the newline too, as Org's does, so a background
      // with :extend goes on to the window's edge.
      if (BLOCK_END.test(text)) {
        face(ls, delimiterEnd(le), "org-block-end-line");
        block = undefined;
      } else {
        face(ls, Math.min(le + 1, e8.pointMax()), block === "quote" ? "org-quote" : block === "verse" ? "org-verse" : "org-block");
      }
      continue;
    }
    const begin = BLOCK_BEGIN.exec(text);
    if (begin) {
      face(ls, delimiterEnd(le), "org-block-begin-line");
      block = begin[1].toLowerCase();
      if (block === "src") {
        const endLine = fontifySrcNatively(line);
        if (endLine !== undefined) line = endLine - 1;
      }
      continue;
    }
    const heading = text.startsWith("*") ? parseHeading(line, keywords) : undefined;
    if (heading) {
      fontifyHeading(heading, text);
      continue;
    }
    const keyword = KEYWORD.exec(text);
    if (keyword) {
      const name = keyword[2].toUpperCase();
      const keyEnd = ls + charCount(keyword[1]);
      if (name === "TITLE") {
        face(ls, keyEnd, "org-document-info-keyword");
        face(keyEnd, le, "org-document-title");
      } else if (name === "AUTHOR" || name === "DATE" || name === "EMAIL") {
        face(ls, keyEnd, "org-document-info-keyword");
        face(keyEnd, le, "org-document-info");
      } else {
        face(ls, le, "org-meta-line");
      }
      continue;
    }
    if (/^[ \t]*#( |$)/.test(text)) {
      face(ls, le, "font-lock-comment-face");
      continue;
    }
    if (/^[ \t]*\|/.test(text)) {
      face(ls + indentation(text), le, "org-table");
      // Links, timestamps and the like are styled in tables too, as Org's font-lock does everywhere.
      fontifyObjects(line, text, 0);
      continue;
    }
    if (DRAWER.test(text)) {
      face(ls + indentation(text), le, "org-drawer");
      continue;
    }
    const property = /^([ \t]*:[\w-]+\+?:)([ \t].*)?$/.exec(text);
    if (property) {
      const keyEnd = ls + charCount(property[1]);
      face(ls + indentation(text), keyEnd, "org-special-keyword");
      face(keyEnd, le, "org-property-value");
      continue;
    }
    for (const m of allMatches(/(?:^|[ \t])((?:SCHEDULED|DEADLINE|CLOSED):)/g, text)) {
      const i = (m.index ?? 0) + m[0].length - m[1].length;
      face(at(line, text, i), at(line, text, i + m[1].length), "org-special-keyword");
    }
    const item = parseItem(line);
    let objectsFrom = 0;
    if (item) {
      if (item.checkboxAt !== undefined) face(item.checkboxAt, item.checkboxAt + 3, "org-checkbox");
      const term = /^(.*?)[ \t]+::(?:[ \t]|$)/.exec(text.slice(indexOf(line, text, item.contentAt)));
      if (term && !/^\d/.test(item.bullet)) {
        const termStart = item.checkboxAt !== undefined ? item.checkboxAt + 4 : item.contentAt;
        face(termStart, item.contentAt + charCount(term[1]), "org-list-dt");
      }
      objectsFrom = indexOf(line, text, item.contentAt);
    }
    const footnote = /^\[fn:[^\]\s]+\]/.exec(text);
    if (footnote) face(ls, ls + footnote[0].length, "org-footnote");
    fontifyObjects(line, text, objectsFrom);
  }
  fontifyLinksAcrossLines(from, Math.min(Math.max(end, from + 1), e8.bufferSize()));
}

/**
 * Styles the bracket links between two positions that hold a newline,
 * which Org's link regexp allows and its font-lock matches across lines.
 */
function fontifyLinksAcrossLines(start: number, end: number): void {
  // A line beyond each end too, as Org's font-lock extends its region for
  // these, so fontifying one line still finds a link it shares with the next.
  const from = e8.lineStart(Math.max(0, lineAt(start) - 1));
  const to = lineStartOrEnd(lineAt(Math.max(start, end - 1)) + 2);
  const text = e8.bufferText(from, to);
  if (!text.includes("\n")) return;
  const linkRe = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([^]+?)\])?\]/g;
  for (const m of allMatches(linkRe, text)) {
    if (!m[0].includes("\n")) continue;
    const linkStart = from + charCount(text.slice(0, m.index ?? 0));
    if (linkStart >= end || linkStart + charCount(m[0]) <= start) continue;
    const pos = (k: number): number => linkStart + charCount(m[0].slice(0, k));
    // A link stays within its paragraph: no line it goes on to may start an element.
    const lines = m[0].split("\n").length - 1;
    const first = lineAt(linkStart);
    let within = true;
    for (let l = first + 1; l <= first + lines; l++) if (startsElement(l, e8.bufferSize())) within = false;
    if (!within) continue;
    face(linkStart, pos(m[0].length), "org-link");
    if (e8.variable("org-link-descriptive") !== true) continue;
    if (m[2] !== undefined) {
      const desc = 2 + m[1].length + 2;
      hide(linkStart, pos(desc));
      hide(pos(desc + m[2].length), pos(m[0].length));
    } else {
      hide(linkStart, pos(2));
      hide(pos(m[0].length - 2), pos(m[0].length));
    }
  }
}

// Indentation

/** The column an item's text starts at, after its bullet, as org-list-item-body-column says. */
function listBodyColumn(pos: number): number {
  const text = e8.lineText(lineAt(pos));
  const m = /^[ \t]*(\S+)/.exec(text);
  return m ? e8.stringWidth(m[0].replace(/\t/g, "        ")) + 1 : 0;
}

const GREATER_ELEMENTS = ["center-block", "drawer", "headline", "item", "plain-list", "property-drawer", "quote-block", "section", "special-block", "table"];

/** The column Org expects a line to start at, given the element it is in, as org--get-expected-indentation works it out. */
function expectedIndent(el: Elem | undefined, contentsp: boolean, line: number): number {
  const type = el?.type;
  const indentOf = (pos: number): number => textIndentation(e8.lineText(lineAt(pos)));
  if (contentsp) {
    if (type === "section") return expectedIndent(el?.parent, true, line);
    if (type === undefined || type === "headline") return 0;
    if (type === "item" || type === "plain-list") return listBodyColumn((el as Elem).begin);
    return indentOf((el as Elem).begin);
  }
  if (!el || type === "headline" || type === "org-data") return isBlank(e8.lineText(line)) ? expectedIndent(el, true, line) : 0;
  const bol = e8.lineStart(line);
  const start = el.begin;
  if (bol < start) return expectedIndent(el.parent, true, line);
  if (bol === start) {
    if (start === 0) return 0;
    let previous = elementAt(start - 1);
    for (let parent = previous; parent && parent.end <= start; parent = parent.parent) previous = parent;
    if (!previous || previous.type === "org-data") return 0;
    if (previous.end > start) return expectedIndent(previous, true, line);
    if (previous.begin === e8.lineStart(lineAt(previous.begin))) return indentOf(previous.begin);
    return expectedIndent(previous.parent, true, line);
  }
  let q = bol;
  while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
  if (type === "plain-list" && lineAt(bol) - lineAt(q) > 2) return indentOf(start);
  if (e8.lineStart(lineAt(q)) < start) return expectedIndent(el.parent, true, line);
  if (e8.lineStart(lineAt(q)) === start) return expectedIndent(el, true, line);
  if (GREATER_ELEMENTS.includes(type ?? "") && el.contentsEnd !== undefined && el.contentsEnd <= bol) {
    if (type === "item" || type === "plain-list") {
      const last = elementAt(q);
      return expectedIndent(last, last?.type === "item", line);
    }
    return indentOf(start);
  }
  return indentOf(q);
}

/** Indents a line as org-indent-line does, keeping point in the text or after the indentation. */
function indentLine(line: number): void {
  const text = e8.lineText(line);
  const ls = e8.lineStart(line);
  const block = elementAt(ls);
  if (block?.type === "src-block" && line > lineAt(block.begin) && line < lineAt(endBeforeBlank(block))) {
    // An empty line gets the block's content indentation, then Org hands
    // the line to the language's mode, with org-src-tab-acts-natively.
    if (!preservesIndentation(block) && text === "" && e8.point() === ls) {
      const ind = textIndentation(e8.lineText(lineAt(block.begin))) + Number(e8.variable("org-edit-src-content-indentation") ?? 2);
      indentLineTo(line, ind);
      e8.gotoChar(e8.lineEnd(line));
    }
    if (truthy(e8.variable("org-src-tab-acts-natively")) && e8.fboundp("org-babel-do-key-sequence-in-edit-buffer")) {
      e8.funcall("org-babel-do-key-sequence-in-edit-buffer", "indent-for-tab-command");
    }
    return;
  }
  if (isHeadingLine(text) || blockBefore(line) !== undefined) return;
  const el = elementAt(ls);
  if (el && (el.type === "plain-list" || el.type === "item") && el.begin === ls) return;
  const want = expectedIndent(el, false, line);
  const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
  const p = e8.point();
  if (lineAt(p) === line && p - ls <= charCount(ws)) {
    indentLineTo(line, want);
    e8.gotoChar(ls + charCount(/^[ \t]*/.exec(e8.lineText(line))?.[0] ?? ""));
  } else {
    const m = marker(p);
    indentLineTo(line, want);
    e8.gotoChar(m.pos);
    dropMarker(m);
  }
  if (el?.type === "node-property") {
    const column = e8.stringWidth(e8.bufferText(ls, e8.point()).replace(/\t/g, "        "));
    alignNodeProperty(line);
    moveToColumn(column);
  }
}

/** Moves point to a column on its line, or to the line's end, as move-to-column does. */
export function moveToColumn(column: number): void {
  const line = lineAt();
  let p = e8.lineStart(line);
  let c = 0;
  for (const ch of e8.lineText(line)) {
    if (c >= column) break;
    c = ch === "\t" ? (Math.floor(c / 8) + 1) * 8 : c + e8.stringWidth(ch);
    p++;
  }
  e8.gotoChar(p);
}

/** A node property line's parts, as org-property-re matches them: indentation, :KEY:, and value. */
const PROPERTY_RE = /^([ \t]*)(:(\S+):)(?:()$|[ \t]+(.*?))([ \t]*)$/;

/** Aligns the node property on a line by org-property-format ("%-10s %s"), as org--align-node-property does. */
export function alignNodeProperty(line: number): void {
  const text = e8.lineText(line);
  const m = PROPERTY_RE.exec(text);
  if (!m) return;
  const key = m[2];
  const formatted = `${key}${" ".repeat(Math.max(0, 10 - e8.stringWidth(key)))} ${m[5] ?? ""}`;
  const replacement = m[1] + formatted.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  const ls = e8.lineStart(line);
  // Deleted and inserted again rather than replaced, so markers in the line go to its start.
  const checks = !foldChecksOff;
  withoutFoldChecks(() => {
    edDelete(ls, ls + charCount(text));
    edInsert(ls, replacement);
  });
  if (checks) fixFoldsAround(ls, ls + charCount(replacement));
}

/** Changes the indentation of the lines from start to end by offset, as indent-rigidly does. */
function indentRigidly(start: number, end: number, offset: number): void {
  const endM = marker(end);
  for (let line = lineAt(start); line < e8.lineCount() && e8.lineStart(line) < endM.pos; line++) {
    const text = e8.lineText(line);
    const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
    const ls = e8.lineStart(line);
    if (ws.length === text.length) edDelete(ls, ls + charCount(ws));
    else {
      const added = indentString(Math.max(0, textIndentation(text) + offset));
      edInsert(ls, added);
      edDelete(ls + charCount(added), ls + charCount(added) + charCount(ws));
    }
  }
  dropMarker(endM);
}

/** Indents the whole of the current buffer, as (indent-region (point-min) (point-max)). */
function indentWholeBuffer(): void {
  e8.setMark(e8.pointMin());
  e8.gotoChar(e8.pointMax());
  e8.call("indent-region");
}

/** Indents the non-blank lines from start to end, each element as a whole, as org-indent-region does. */
function orgIndentRegion(start: number, end: number): void {
  keepingParse(() => indentRegionElements(start, end));
}

e8.defun("org-indent-region", (start: number, end: number) => orgIndentRegion(start, end));

function indentRegionElements(start: number, end: number): void {
  const endM = marker(end);
  const size = (): number => e8.bufferSize();
  let p = start;
  while (p < size() && /[ \r\t\n]/.test(e8.bufferText(p, p + 1))) p++;
  if (p < size()) p = e8.lineStart(lineAt(p));
  // Gives lines up to pos the indentation ind, leaving p after pos.
  const indentTo = (ind: number, pos: number): void => {
    const limit = marker(pos);
    while (p < limit.pos) {
      const line = lineAt(p);
      if (!/^[ \t]*$/.test(e8.lineText(line))) indentLineTo(line, ind);
      p = lineStartOrEnd(line + 1);
      if (line + 1 >= e8.lineCount()) p = size();
    }
    dropMarker(limit);
  };
  while (p < endM.pos) {
    const line = lineAt(p);
    const el = isHeadingLine(e8.lineText(line)) ? undefined : elementAt(p);
    // A blank line after a heading is the headline's: Org indents it, which
    // leaves it blank, then the section, as the lines after it come.
    if (!el || el.type === "headline") {
      p = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : size();
      continue;
    }
    const type = el.type;
    const elementEnd = marker(el.end);
    const ind = expectedIndent(el, false, line);
    if (type === "export-block" || (type === "example-block" && !preservesIndentation(el))) {
      // Indented as a whole, keeping the lines' indentation relative to each other.
      const offset = ind - textIndentation(e8.lineText(lineAt(p)));
      if (offset !== 0) indentRigidly(el.begin, el.end, offset);
      p = elementEnd.pos;
    } else if (type === "src-block" || type === "example-block") {
      // A source block's code is indented in its edit buffer, as its
      // language's mode indents it, with org-src-tab-acts-natively, and goes
      // back org-edit-src-content-indentation in from the block; an example
      // block that keeps its indentation is left alone.
      const lastLine = lineAt(endBeforeBlank(el));
      indentTo(ind, Math.min(lineStartOrEnd(lineAt(el.begin) + 1), endM.pos));
      if (
        type === "src-block" &&
        p < Math.min(e8.lineStart(lastLine), endM.pos) &&
        truthy(e8.variable("org-src-tab-acts-natively")) &&
        e8.fboundp("org-babel-do-in-edit-buffer")
      ) {
        const pm = marker(p);
        e8.gotoChar(p);
        e8.funcall("org-babel-do-in-edit-buffer", indentWholeBuffer);
        p = pm.pos;
        dropMarker(pm);
      }
      p = Math.max(p, Math.min(e8.lineStart(lastLine), endM.pos));
      if (p < endM.pos) indentTo(ind, Math.min(elementEnd.pos, endM.pos));
    } else if (["paragraph", "table", "table-row"].includes(type) || el.contentsBegin === undefined) {
      if (type === "node-property") {
        const pm = marker(p);
        alignNodeProperty(lineAt(p));
        p = e8.lineStart(lineAt(pm.pos));
        dropMarker(pm);
      }
      indentTo(ind, Math.min(elementEnd.pos, endM.pos));
    } else {
      let cb = el.contentsBegin;
      if (type === "item" || type === "plain-list") {
        let q = e8.lineEnd(lineAt(el.begin));
        while (q < size() && /[ \r\t\n]/.test(e8.bufferText(q, q + 1))) q++;
        cb = q >= size() ? q : e8.lineStart(lineAt(q));
      }
      const cbeg = marker(cb);
      const cend = marker(el.contentsEnd ?? el.end, true);
      if (type === "plain-list") {
        const offset = ind - textIndentation(e8.lineText(lineAt(p)));
        if (offset !== 0) indentRigidly(el.begin, elementEnd.pos, offset);
        p = cbeg.pos;
      } else if (type === "item") p = cbeg.pos;
      else indentTo(ind, Math.min(cbeg.pos, endM.pos));
      if (p < endM.pos) {
        if (type !== "verse-block") orgIndentRegion(p, Math.min(cend.pos, endM.pos));
        p = Math.min(cend.pos, endM.pos);
        if (p < endM.pos) indentTo(ind, Math.min(elementEnd.pos, endM.pos));
      }
      dropMarker(cbeg);
      dropMarker(cend);
    }
    dropMarker(elementEnd);
  }
  dropMarker(endM);
}

e8.defineVariable({
  name: "org-edit-src-content-indentation",
  doc: "How far the lines of a source block are indented past its #+begin_src line.",
  value: 2,
});

/** Whether an example block keeps its lines' indentation, with its -i switch or org-src-preserve-indentation. */
function preservesIndentation(el: Elem): boolean {
  return e8.variable("org-src-preserve-indentation") === true || /\s-i(\s|$)/.test(e8.lineText(lineAt(el.begin)));
}

const BLOCK_TYPES = ["comment-block", "center-block", "example-block", "export-block", "quote-block", "special-block", "src-block", "verse-block"];

/** Whether point's line opens a block that is closed, as org-at-block-p checks with org-block-regexp. */
function atBlock(): boolean {
  const line = lineAt();
  const m = /^[ \t]*#\+begin_?([^ \n]+)/i.exec(e8.lineText(line));
  if (!m) return false;
  const close = new RegExp(`^[ \\t]*#\\+end_?${escapeRegExp(m[1])}[ \\t]*$`, "i");
  for (let l = line + 1; l < e8.lineCount(); l++) if (close.test(e8.lineText(l))) return true;
  return false;
}

e8.defineCommand({
  name: "org-indent-block",
  doc: "Indent the block at point.\nSignal an error when not at a block.",
  run: () => {
    const el = elementAt(e8.point());
    if (!el || !BLOCK_TYPES.includes(el.type)) e8.userError("Not at a block");
    const pt = marker(e8.point());
    orgIndentRegion(el.begin, el.end);
    e8.gotoChar(pt.pos);
    dropMarker(pt);
    e8.message("Block at point indented");
  },
});

e8.defineCommand({
  name: "org-indent-drawer",
  doc: "Indent the drawer at point.\nSignal an error when not at a drawer.",
  run: () => {
    const el = elementAt(e8.point());
    if (el?.type !== "drawer" && el?.type !== "property-drawer") e8.userError("Not at a drawer");
    const pt = marker(e8.point());
    orgIndentRegion(el.begin, el.end);
    e8.gotoChar(pt.pos);
    dropMarker(pt);
    e8.message("Drawer at point indented");
  },
});

// Commands: visibility

const cycle = e8.defineCommand({
  name: "org-cycle",
  doc:
    "TAB in Org: fold and unfold.\n\n" +
    "On a heading, cycle its subtree: folded, then its text and its children's headings, then everything. " +
    "On a list item with items under it, the same for the item. On a drawer or block line, fold or unfold it. " +
    "In a table, move to the next field. Anywhere else, indent the line. " +
    "With C-u, cycle the whole buffer as S-TAB does.",
  run: () => orgCycle(e8.prefixArg()),
});

/** TAB in Org, as org-cycle does with prefix argument arg. */
function orgCycle(arg: e8.PrefixArg): void {
  {
    if (e8.runHookWithArgsUntilSuccess("org-cycle-tab-first-hook")) return;
    if (cycleLevel() || cycleItemIndentation()) return;
    if (Array.isArray(arg) && arg[0] === 4) {
      globalCycle();
      return;
    }
    if (Array.isArray(arg) && arg[0] === 16) {
      e8.setVariable("org-cycle-global-status", null);
      startupVisibility();
      e8.message("Startup visibility, plus VISIBILITY properties");
      return;
    }
    if (Array.isArray(arg) && arg[0] === 64) {
      for (const spec of FOLD_SPECS) flag(0, e8.bufferSize(), false, spec);
      e8.message("Entire buffer visible, including drawers");
      return;
    }
    const line = lineAt();
    const text = e8.lineText(line);
    if ((DRAWER.test(text) && !/^[ \t]*:END:/i.test(text)) || BLOCK_BEGIN.test(text)) {
      if (toggleDrawerOrBlock(line)) {
        // As org-fold--hide-wrapper-toggle does, point is left where it shows.
        if (e8.point() > 0 && e8.invisibleAt(e8.point() - 1)) e8.gotoChar(e8.lineStart(line));
        return;
      }
    }
    // On the closing line too, as org-fold--hide-wrapper-toggle allows.
    const opener = openerOf(line);
    if (opener !== undefined && toggleDrawerOrBlock(opener)) {
      if (e8.point() > 0 && e8.invisibleAt(e8.point() - 1)) e8.gotoChar(e8.lineStart(opener));
      return;
    }
    if (/^[ \t]*[|+]/.test(text) && /^[ \t]*\|/.test(text)) {
      e8.call("org-table-justify-field-maybe");
      e8.call("org-table-next-field");
      return;
    }
    const here = headingHere();
    if (here) {
      // On a hidden heading, the one cycled is the nearest that shows above,
      // as org-back-to-heading finds it.
      const [all, at] = here;
      let i = at;
      while (i > 0 && e8.invisibleAt(all[i].start)) i--;
      cycleHeading(all, i, at);
      return;
    }
    if (itemLine(line)) {
      cycleItem(line);
      return;
    }
    // From there TAB emulation, after what else wants TAB, as org-tempo's templates.
    if (e8.runHookWithArgsUntilSuccess("org-tab-before-tab-emulation-hook")) return;
    // TAB as indent-for-tab-command does: the region if it is active, then
    // the mark goes, as indent-region sets deactivate-mark.
    if (orgRegionActive()) {
      const mark = e8.mark() as number;
      const pt = marker(e8.point());
      orgIndentRegion(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
      e8.gotoChar(pt.pos);
      dropMarker(pt);
      e8.deactivateMark();
      return;
    }
    indentLine(line);
  }
}

/** Cycles an item's visibility, as org-cycle-internal-local does for items. */
function cycleItem(line: number): void {
  const struct = listStruct(line);
  const item = e8.lineStart(line);
  const eoh = e8.lineEnd(line);
  const eos = itemEndBeforeBlank(struct, item);
  const hasChildren = hasChild(struct, item) !== undefined;
  const eol = endOfHidden(line);
  const again = e8.lastCommand() === e8.thisCommand();
  const status = e8.variable("org-cycle-subtree-status");
  const all = headings();
  const inSection = headingIndex(all, line) !== undefined;
  const showFollowing = (): void => {
    const next = all.find((h) => h.start > eos);
    if (next && next.start < e8.bufferSize() && e8.invisibleAt(next.start)) showHeadingLine(next);
  };
  if (eos === eoh) {
    e8.message("EMPTY ENTRY");
    e8.setVariable("org-cycle-subtree-status", null);
    showFollowing();
    return;
  }
  const hiddenInOneLine = eol >= eos || /^\s*$/.test(e8.bufferText(eol, eos));
  const skipped = hiddenInOneLine && !hasChildren;
  if (hiddenInOneLine && hasChildren) {
    setItemVisibility(item, struct, "children");
    e8.message("CHILDREN");
    showFollowing();
    e8.setVariable("org-cycle-subtree-status", "children");
    if (inSection) showEmptyLines("children");
  } else if (skipped || (again && status === "children")) {
    flag(eoh, eos, false);
    e8.message(skipped ? "SUBTREE (NO CHILDREN)" : "SUBTREE");
    e8.setVariable("org-cycle-subtree-status", "subtree");
    if (inSection) showEmptyLines("subtree");
  } else {
    flag(eoh, eos, true);
    e8.message("FOLDED");
    e8.setVariable("org-cycle-subtree-status", "folded");
    if (inSection) showEmptyLines("folded");
  }
}

/**
 * Changes the level of an empty heading point is at the end of, as
 * org-cycle-level does for TAB: to a child of the heading above, then up
 * the levels, then back. Returns whether it applied.
 */
export function cycleLevel(): boolean {
  const line = lineAt();
  const h = parseHeading(line);
  if (!h || !/^[ \t]*$/.test(e8.bufferText(e8.point(), h.end))) return false;
  const rest = e8.lineText(line).slice(h.level);
  const keywords = allKeywords().map((k) => escapeRegExp(k)).join("|");
  const m = new RegExp(`^(?: +(?:${keywords}))?(?: +(.*?))?[ \t]*$`).exec(rest);
  if (!m || m[1] !== "") return false;
  e8.setThisCommand("org-cycle-level");
  const cur = h.level;
  let prev = 0;
  if (h.start !== 0) {
    const all = headings();
    const k = headingIndex(all, line - 1);
    prev = k === undefined ? 0 : all[k].level;
  }
  const promote = (n: number): void => {
    for (let i = 0; i < n; i++) e8.call("org-do-promote");
  };
  const demote = (n: number): void => {
    for (let i = 0; i < n; i++) e8.call("org-do-demote");
  };
  if (prev === 0) promote(cur - 1);
  else if (prev === cur) demote(1);
  else if (prev === 1) promote(cur - 1);
  else if (cur === 1) demote(prev - 1);
  else if (cur < prev) promote(1);
  else promote(1 + (cur - prev));
  return true;
}

const shiftTab = e8.defineCommand({
  name: "org-shifttab",
  doc:
    "S-TAB in Org: cycle the whole buffer between its top headings, all its headings and everything.\n\n" +
    "In a table, move to the previous field. With a number as prefix argument, show that many levels of headings.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) {
      e8.call("org-table-previous-field");
      return;
    }
    const prefix = e8.prefixArg();
    if (typeof prefix === "number") {
      e8.message(`Content view to level: ${prefix}`);
      showLevels(prefix);
      showEmptyLines("t");
      e8.setVariable("org-cycle-global-status", "overview");
      return;
    }
    // As org-cycle-global does: C-u means the startup visibility, else C-u TAB.
    orgCycle(Array.isArray(prefix) ? [16] : [4]);
  },
});

e8.defineCommand({
  name: "org-global-cycle",
  doc: "Cycle the whole buffer: top headings only, then all headings, then everything.",
  run: () => orgCycle([4]),
});

e8.defineCommand({
  name: "org-overview",
  doc: "Show only the top headings.",
  run: () => overview(),
});

e8.defineCommand({
  name: "org-content",
  doc: "Show all headings, hiding the text under them.",
  run: () => contents(),
});

e8.defineCommand({
  name: "org-show-all",
  doc: "Show everything accessible, drawers and blocks included.",
  run: () => {
    // As org-fold-show-all: what is outside a narrowing stays as it is.
    for (const spec of ["outline", "org-hide-drawer", "org-hide-block"]) flag(e8.pointMin(), e8.pointMax(), false, spec);
  },
});

e8.defineCommand({
  name: "org-indent-line",
  doc: "Indent the line: text under a heading to the left margin, a list item's lines to its text, others as the line before.",
  run: () => indentLine(lineAt()),
});

const orgReturn = e8.defineCommand({
  name: "org-return",
  doc:
    "RET in Org: in a table, move to the next row; elsewhere start a new line, indented as org-indent-line does.\n\n" +
    "On a heading, the title after point goes to the new line, but the state, priority and tags stay. In a list " +
    "item, the text after point moves to the new line after it is indented.",
  run: () => orgReturnWith(true),
});

e8.defineCommand({
  name: "org-return-and-maybe-indent",
  doc: "C-j in Org: what RET does, but the new line is not indented, as electric-indent-mode leaves C-j alone.",
  run: () => orgReturnWith(false),
});

e8.defineVariable({
  name: "org-special-ctrl-o",
  doc: "Whether C-o in a table inserts a row rather than opening a line.",
  value: true,
});

e8.defineCommand({
  name: "org-open-line",
  doc: "C-o in Org: in a table, insert a row above; elsewhere, or at the very start of the buffer, open-line.",
  run: () => {
    const p = e8.point();
    if (e8.variable("org-special-ctrl-o") === true && p !== 0 && /^[ \t]*\|/.test(e8.lineText(lineAt())))
      e8.call("org-table-insert-row");
    else e8.callWithPrefix(e8.prefixArg(), "open-line");
  },
});

/**
 * RET in Org, as org-return does. Org calls newline interactively for RET,
 * so electric-indent-mode indents the new line, and from code for C-j, so it does not.
 */
function orgReturnWith(electric: boolean): void {
  // Org's newline self-inserts, so the newlines take on the text properties
  // around them, and runs of them undo together.
  const newline = (n: number): void => {
    e8.undoAutoAmalgamate();
    if (electric) electricNewline(n);
    else e8.insertAndInherit("\n".repeat(n));
  };
  checkInvisibleEditMaybe();
  const line = lineAt();
  const p = e8.point();
  const [ls, le] = [e8.lineStart(line), e8.lineEnd(line)];
  const n = Math.max(1, e8.prefixNumericValue());
  if (/^[ \t]*\|/.test(e8.lineText(line))) {
    // Before the first column or after the last, a table is split.
    if (/^[ \t]*$/.test(e8.bufferText(p, le)) || /^[ \t]*$/.test(e8.bufferText(ls, p))) e8.insert("\n");
    else {
      e8.call("org-table-justify-field-maybe");
      e8.call("org-table-next-row");
    }
    return;
  }
  // On a link, RET follows it, as org-return-follows-link says.
  if (e8.variable("org-return-follows-link") === true && linkHere() !== undefined) {
    e8.callInteractively("org-open-at-point");
    return;
  }
  const h = p > ls ? parseHeading(line) : undefined;
  // org-complex-heading-regexp also matches a line of bare stars, which
  // is not a heading, so the entry shown is the one it is in.
  const bareStars = p > ls && /^\*+[ \t]*$/.test(e8.lineText(line));
  if (h || bareStars) {
    const titleEnd = h ? h.titleAt + charCount(h.title) : p;
    const rest = h && h.title !== "" && p >= h.titleAt && p <= titleEnd ? e8.deleteRegion(p, titleEnd) : undefined;
    if (rest !== undefined && h?.tagsAt !== undefined) alignTags(line);
    e8.gotoChar(e8.lineEnd(line));
    const all = headings();
    const i = headingIndex(all, line);
    if (i !== undefined) {
      showEntry(all, i);
      hideDrawersIn(all[i].line + 1, entryEnd(all, i));
    } else {
      // Before the first heading, org-fold-show-entry works from the buffer's start.
      const end = all[0]?.start ?? e8.bufferSize();
      flag(0, end, false);
      hideDrawersIn(0, end);
    }
    newline(n);
    if (rest !== undefined) {
      const q = e8.point();
      e8.insert(rest.trim());
      e8.gotoChar(q);
    }
    return;
  }
  let context = elementAt(p)?.parent;
  while (context && context.type !== "item") context = context.parent;
  if (p < le && context) {
    const rest = e8.deleteRegion(p, le);
    newline(n);
    const q = e8.point();
    e8.insert(rest);
    e8.gotoChar(q);
    return;
  }
  newline(n);
}

/**
 * Inserts newlines and indents the new line, as newline does with
 * electric-indent-mode: spaces left at the end of the line before go.
 */
function electricNewline(n: number): void {
  e8.insertAndInherit("\n".repeat(n));
  const before = e8.point() - 1;
  const text = e8.bufferText(e8.lineStart(lineAt(before)), before);
  const spaces = text.length - text.replace(/[ \t]+$/, "").length;
  if (spaces > 0) e8.deleteRegion(before - spaces, before);
  indentLine(lineAt());
}

// Commands: moving between headings

e8.defineCommand({
  name: "org-end-of-line",
  doc: "Move to the end of the line, staying on a folded heading's line rather than going past its hidden text.",
  run: () => {
    const n = e8.prefixNumericValue();
    if (n !== 1) e8.callWithPrefix(n - 1, "next-line");
    // As move-beginning-of-line does, back to the start of the visible line first.
    e8.gotoChar(e8.lineStart(lineAt()));
    while (e8.point() > 0 && e8.invisibleAt(e8.point() - 1)) {
      let q = e8.point() - 1;
      while (q > 0 && e8.invisibleAt(q - 1)) q--;
      e8.gotoChar(e8.lineStart(lineAt(q)));
    }
    e8.gotoChar(e8.lineEnd(lineAt()));
  },
});

function visible(h: Heading): boolean {
  return h.start === 0 || !e8.invisibleAt(h.start - 1);
}

/**
 * Moves over headings, as org-next-visible-heading: a heading the search
 * finds inside a fold counts too, and the search goes on past the fold.
 * Without enough headings, point goes to the end, or to the start going back.
 */
function nextVisibleHeading(arg: number): void {
  const regexp = "^\\*+ ";
  const searchFails = (found: number | undefined, to: number): boolean => {
    if (found === undefined) e8.gotoChar(to);
    return found === undefined;
  };
  e8.gotoChar(arg < 0 ? e8.lineStart(lineAt()) : e8.lineEnd(lineAt()));
  while (arg < 0 && !searchFails(e8.reSearchBackward(regexp, { noerror: true }), e8.pointMin())) {
    if (e8.point() > e8.pointMin() && folded(e8.point())) {
      e8.gotoChar(e8.previousSingleCharPropertyChange(e8.point(), "invisible"));
      if (!e8.lookingAt(regexp)) searchFails(e8.reSearchBackward(regexp, { noerror: true }), e8.pointMin());
    }
    arg++;
  }
  while (arg > 0 && !searchFails(e8.reSearchForward(regexp, { noerror: true }), e8.pointMax())) {
    if (folded(e8.point())) {
      e8.gotoChar(e8.nextSingleCharPropertyChange(e8.point(), "invisible"));
      e8.skipCharsForward(" \t\n");
      e8.gotoChar(e8.lineEnd(lineAt()));
    }
    arg--;
  }
  e8.gotoChar(arg > 0 ? e8.pointMax() : e8.lineStart(lineAt()));
}

const nextHeading = e8.defineCommand({
  name: "org-next-visible-heading",
  doc: "Move to the next heading that is not hidden, or to the end of the buffer.",
  run: () => nextVisibleHeading(e8.prefixNumericValue()),
});

const previousHeading = e8.defineCommand({
  name: "org-previous-visible-heading",
  doc: "Move to the previous heading that is not hidden, or to the start of the buffer.",
  run: () => nextVisibleHeading(-e8.prefixNumericValue()),
});

/** The sibling `by` headings on from heading i, skipping deeper ones, if any. */
function sibling(all: Heading[], i: number, by: number): number | undefined {
  const level = all[i].level;
  for (let j = i + by; j >= 0 && j < all.length; j += by) {
    if (all[j].level < level) return undefined;
    if (all[j].level === level) return j;
  }
  return undefined;
}

/**
 * Moves `arg` headings at the same level as the one point is under, back
 * if `arg` is negative, stopping at the first or last under its parent, as
 * org-forward-heading-same-level does. Before the first heading it goes to
 * the first heading, or the start of the buffer going back.
 */
function forwardHeadingSameLevel(arg: number): void {
  const backward = arg < 0;
  const all = headings();
  const current = visibleHeadingIndex(all, lineAt());
  if (current === undefined) {
    if (backward) e8.gotoChar(0);
    else e8.gotoChar(all.find((h) => h.start > e8.point())?.start ?? e8.bufferSize());
    return;
  }
  const { level } = all[current];
  let result = backward ? all[current].start : all[current].end;
  let count = Math.abs(arg);
  const step = backward ? -1 : 1;
  for (let k = current + step; k >= 0 && k < all.length; k += step) {
    const h = all[k];
    if (count === 0) break;
    if (h.level < level) break;
    if (h.level === level && visible(h)) {
      count--;
      result = h.start;
    }
  }
  e8.gotoChar(e8.lineStart(lineAt(result)));
}

const forwardSameLevel = e8.defineCommand({
  name: "org-forward-heading-same-level",
  doc: "Move to the next heading at the same level, under the same parent.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardHeadingSameLevel(arg),
});

const backwardSameLevel = e8.defineCommand({
  name: "org-backward-heading-same-level",
  doc: "Move to the previous heading at the same level, under the same parent.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardHeadingSameLevel(-arg),
});

/**
 * Puts point at the start of the element at point and the mark at its end,
 * or with the mark active, moves the mark to the end of the element there,
 * as org-mark-element does.
 */
function markElement(): void {
  const mark = e8.mark();
  const again = e8.lastCommand() === e8.thisCommand() && mark !== undefined;
  if (e8.calledInteractively() && (again || (e8.regionActive() && mark !== undefined))) {
    e8.setMark(elementAt(mark as number)?.end ?? (mark as number));
    return;
  }
  const e = elementAt(e8.point());
  if (!e) return;
  e8.gotoChar(e8.lineEnd(lineAt()));
  e8.pushMark(Math.min(e8.bufferSize(), e.end), { activate: true });
  e8.gotoChar(e.begin);
}

e8.defineCommand({
  name: "org-mark-element",
  doc: "Make the region the element at point; repeated, or with the mark active, take in the next element too.",
  run: () => markElement(),
});

const markSubtree = e8.defineCommand({
  name: "org-mark-subtree",
  doc: "Make the region the subtree point is in: point at its heading, the mark at its end.",
  run: () => {
    const line = lineAt();
    if (parseHeading(line)) e8.gotoChar(e8.lineStart(line));
    else if (headingIndex(headings(), line) === undefined) e8.userError("Not in a subtree");
    else e8.call("org-previous-visible-heading");
    markElement();
  },
});

// Commands: inserting headings and items

function blankLineAt(line: number): boolean {
  return line < e8.lineCount() && e8.lineText(line) === "";
}

/** Whether the line before point's is empty, as org-previous-line-empty-p says. */
function previousLineEmpty(): boolean {
  if (e8.point() === 0) return false;
  return /^[ \t]*$/.test(e8.lineText(Math.max(0, lineAt() - 1)));
}

/**
 * Whether a new heading here should have an empty line before it, as
 * org--blank-before-heading-p decides for org-blank-before-new-entry's
 * "auto": when the heading point is under, or its parent, has one.
 */
export function blankBeforeHeading(parent: boolean): boolean {
  // As org-blank-before-new-entry's heading entry says, auto by default.
  const setting = blankBeforeNewEntry("heading");
  if (setting !== "auto") return setting !== null && setting !== false;
  const all = headings();
  let i = headingIndex(all, lineAt());
  if (i === undefined) {
    // Before the first heading, the next one counts.
    i = all.findIndex((h) => h.start > e8.point());
    if (i < 0) return false;
  }
  if (parent) i = ancestors(all, i)[0] ?? i;
  const h = all[i];
  // Within the accessible portion, as bobp and point-max are.
  const [min, max] = [e8.pointMin(), e8.pointMax()];
  if (h.start !== min) return isBlank(e8.lineText(h.line - 1));
  const next = all[i + 1];
  if (next) return isBlank(e8.lineText(next.line - 1));
  // Trailing spaces on the last line are ignored.
  let q = max;
  while (q > min && /[ \t]/.test(e8.bufferText(q - 1, q))) q--;
  if (q !== e8.lineStart(lineAt(q)) || q === min) return false;
  return isBlank(e8.lineText(lineAt(q) - 1));
}

/** Makes the number of empty lines before point's line exactly n, as org-N-empty-lines-before-current does. */
function emptyLinesBeforeCurrent(n: number): void {
  const column = e8.point() - e8.lineStart(lineAt());
  e8.gotoChar(e8.lineStart(lineAt()));
  if (e8.point() > 0) {
    let q = e8.point();
    while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    const start = e8.lineEnd(lineAt(q));
    if (start < e8.point() - 1) e8.deleteRegion(start, e8.point() - 1);
  }
  e8.insert("\n".repeat(n));
  const line = lineAt();
  e8.gotoChar(e8.lineStart(line) + Math.min(column, e8.lineEnd(line) - e8.lineStart(line)));
}

/** Keeps an empty line before the heading after a new one, as org-insert-heading's maybe-add-blank-after does. */
function maybeAddBlankAfter(blank: boolean): void {
  const p = e8.point();
  const line = lineAt();
  if (line + 1 < e8.lineCount() && blank && isHeadingLine(e8.lineText(line + 1))) {
    e8.gotoChar(e8.lineStart(line + 1));
    e8.insert("\n");
  }
  e8.gotoChar(p);
}

/**
 * Inserts strings one after another, as Emacs's insert does with several
 * arguments: each is a change of its own, so Org's fold checks see the
 * text between them.
 */
function insertPieces(...pieces: string[]): void {
  for (const piece of pieces) if (piece !== "") e8.insert(piece);
}

/**
 * Inserts a heading as org-insert-heading does, leaving point after its
 * stars. `arg` is the raw prefix argument: C-u inserts after the subtree,
 * C-u C-u after the parent's.
 */
function insertHeading(arg: e8.PrefixArg, invisibleOk = false): void {
  const parentEnd = Array.isArray(arg) && arg[0] === 16;
  const blank = blankBeforeHeading(parentEnd);
  const all = headings();
  const current = headingIndex(all, lineAt());
  // As org-current-level, from the whole buffer, so a heading above a narrowing counts.
  const level = e8.saveRestriction(() => {
    e8.widen();
    const wide = headings();
    const i = headingIndex(wide, lineAt());
    return i === undefined ? undefined : wide[i].level;
  });
  const stars = "*".repeat(level ?? 1);
  const p = e8.point();
  const respect =
    e8.variable("org-insert-heading-respect-content") === true ||
    (Array.isArray(arg) && (arg[0] === 4 || arg[0] === 16)) ||
    (!invisibleOk && e8.invisibleAt(Math.max(0, p - 1)));
  const atBol = (): boolean => e8.point() === e8.lineStart(lineAt());
  if (respect) {
    if (current === undefined) {
      const from = atBol() && p < e8.bufferSize() ? p + 1 : p;
      e8.gotoChar(all.find((h) => h.start >= from)?.start ?? e8.bufferSize());
    } else {
      let i = current;
      if (!invisibleOk) {
        // org-back-to-heading goes up to the first heading that is not
        // folded, leaving point at the last one it tried if none is.
        const lineage = [i, ...ancestors(all, i)];
        const shown = lineage.find((a) => !e8.invisibleAt(all[a].start));
        if (shown === undefined) {
          const last = all[lineage[lineage.length - 1]].start;
          e8.gotoChar(last);
          e8.userError(`Before first headline at position ${last + 1} in buffer ${e8.bufferName()}`);
        }
        i = shown;
      }
      if (parentEnd) i = ancestors(all, i)[0] ?? i;
      e8.gotoChar(subtreeRegion(all, i)[1]);
    }
    // At the end of a file with no final newline, the heading gets a line of its own.
    if (!atBol()) e8.insert("\n");
    if (blank && headingIndex(headings(), lineAt(e8.point() - 1)) === undefined) {
      e8.insert("\n");
      e8.gotoChar(e8.point() - 1);
    }
    if (level === undefined && e8.point() < e8.bufferSize() && e8.point() > 0) {
      if (isHeadingLine(e8.lineText(lineAt()))) e8.insert("\n");
      e8.gotoChar(e8.point() - 1);
    }
    if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
    insertPieces(stars, " ", "\n");
    e8.gotoChar(e8.point() - 1);
    maybeAddBlankAfter(blank);
    if (!invisibleOk) {
      const line = lineAt();
      if (folded(Math.max(0, e8.lineStart(line) - 1), "outline")) flag(Math.max(0, e8.lineStart(line) - 1), e8.lineEnd(line), false);
    }
    return;
  }
  const line = lineAt();
  const h = parseHeading(line);
  if (h) {
    if (atBol()) {
      if (blank) {
        e8.insert("\n");
        e8.gotoChar(p);
      }
      insertPieces(stars, " \n");
      e8.gotoChar(p);
      if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
      e8.gotoChar(e8.lineEnd(lineAt()));
      return;
    }
    const titleEnd = h.titleAt + charCount(h.title);
    if (e8.variable("org-M-RET-may-split-line") !== false && h.title !== "" && p >= h.titleAt && p <= titleEnd) {
      const split = e8.deleteRegion(p, titleEnd);
      if (/^[ \t]*$/.test(e8.bufferText(p, e8.lineEnd(line)))) e8.deleteRegion(p, e8.lineEnd(line));
      else alignTags(line);
      e8.gotoChar(e8.lineEnd(line));
      if (blank) e8.insert("\n");
      insertPieces("\n", stars, " ");
      maybeAddBlankAfter(blank);
      if (/\S/.test(split)) e8.insert(split);
      return;
    }
    e8.gotoChar(e8.lineEnd(line));
    if (blank) e8.insert("\n");
    insertPieces("\n", stars, " ");
    maybeAddBlankAfter(blank);
    return;
  }
  if (atBol()) {
    insertPieces(stars, " ");
    if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
    maybeAddBlankAfter(blank);
    return;
  }
  if (e8.variable("org-M-RET-may-split-line") === false) e8.gotoChar(e8.lineEnd(line));
  insertPieces("\n", stars, " ");
  if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
  maybeAddBlankAfter(blank);
}

/**
 * Inserts a heading with a TODO state, as org-insert-todo-heading does:
 * the state of the heading before it, unless that is done, or the first.
 */
function insertTodoHeading(arg: e8.PrefixArg, force: boolean): void {
  if (!force && insertListItem(true)) return;
  insertHeading(force ? [4] : Array.isArray(arg) && arg[0] === 16 ? arg : null);
  const p = e8.point();
  forwardHeadingSameLevel(-1);
  const previous = parseHeading(lineAt());
  e8.gotoChar(p);
  const first = todoSets()[0]?.todo[0] ?? "TODO";
  const state =
    (Array.isArray(arg) && arg[0] === 4) || previous?.todo === undefined || isDone(previous.todo) ? first : previous.todo;
  const line = lineAt();
  const stars = /^\*+ /.exec(e8.lineText(line));
  if (stars) {
    e8.gotoChar(e8.lineStart(line) + stars[0].length);
    e8.insert(`${state} `);
  }
  updateParentTodoStatistics(line);
  // As org-insert-todo-heading logs the new state, when it is treated as a change.
  if (e8.variable("org-treat-insert-todo-heading-as-state-change") === true && logHow(state, undefined) !== undefined) storeStateNote(line, state, undefined);
}

const metaReturn = e8.defineCommand({
  name: "org-meta-return",
  doc:
    "M-RET in Org: insert a heading at the level of the one point is under, or an item in a list.\n\n" +
    "At the start of a line it goes before it; in the middle, the rest of the line goes to the new heading " +
    "(org-M-RET-may-split-line); at the end, after it.",
  run: () => {
    checkInvisibleEditMaybe();
    const prefix = e8.prefixArg();
    if (prefix !== null) {
      insertHeading(prefix);
      return;
    }
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) {
      e8.call("org-table-wrap-region");
      return;
    }
    if (inItem(lineAt()) !== undefined) insertListItem(false);
    else insertHeading(null);
  },
});

e8.defineCommand({
  name: "org-insert-heading",
  doc: "Insert a heading at the level of the one point is under. See org-meta-return.",
  run: () => insertHeading(e8.prefixArg()),
});

const respectContent = e8.defineCommand({
  name: "org-insert-heading-respect-content",
  doc: "Insert a heading after the subtree point is in, at its level.",
  run: () => insertHeading([4]),
});

const todoHeading = e8.defineCommand({
  name: "org-insert-todo-heading",
  doc: "Insert a heading with the first TODO state, as M-RET does; in a list, an item with a checkbox.",
  run: () => insertTodoHeading(e8.prefixArg(), false),
});

const todoHeadingRespectContent = e8.defineCommand({
  name: "org-insert-todo-heading-respect-content",
  doc: "Insert a heading with the first TODO state after the subtree point is in.",
  run: () => insertTodoHeading(e8.prefixArg(), true),
});

e8.defineCommand({
  name: "org-insert-item",
  doc: "Insert an item in the list point is in, at its level: before the item if point is before its text, else after it.",
  run: () => {
    insertListItem(Array.isArray(e8.prefixArg()));
  },
});

// Commands: promoting, demoting and moving

/**
 * Changes a heading's level, as org-promote and org-demote do: the stars
 * and the space after them are replaced, so point inside them goes to the
 * line's start, as save-excursion leaves it.
 */
function changeLevel(h: Heading, by: number): void {
  if (h.level + by < 1) e8.userError("Cannot promote to level 0.  UNDO to recover if necessary");
  // Org checks folds after promoting, but not after demoting.
  const change = (): void => {
    replaceKeepingPoint(h.start, h.start + h.level + 1, `${"*".repeat(h.level + by)} `);
    if (h.tags.length > 0) alignTagsAway(h.line);
  };
  if (by > 0) withoutFoldChecks(change);
  else change();
}

/** Moves point past the space after the stars or TODO state it is at, as org-fix-position-after-promote does. */
function fixPositionAfterPromote(): void {
  const h = parseHeading(lineAt());
  if (!h) return;
  const p = e8.point();
  const starsEnd = h.start + h.level;
  const todoEnd = h.todoAt !== undefined ? h.todoAt + charCount(h.todo ?? "") : undefined;
  if (p !== starsEnd && p !== todoEnd) return;
  if (p === e8.lineEnd(lineAt())) e8.insert(" ");
  else if (e8.bufferText(p, p + 1) === " ") e8.gotoChar(p + 1);
}

function changeSubtreeLevel(by: number): void {
  const [all, i] = backToHeading();
  const end = subtreeRegion(all, i)[1];
  const inside = all.filter((h, k) => k >= i && h.start < end);
  if (inside.some((h) => h.level + by < 1)) e8.userError("Cannot promote to level 0.  UNDO to recover if necessary");
  for (const h of [...inside].reverse()) changeLevel(parseHeading(h.line) ?? h, by);
  fixPositionAfterPromote();
}

/**
 * With the region active, the headings org-map-region goes through: those
 * starting in it, from its beginning on, which may be none.
 */
function headingsInRegion(): Heading[] | undefined {
  if (!orgRegionActive()) return undefined;
  const mark = e8.mark() ?? e8.point();
  const [from, to] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  return headings().filter((h) => h.start >= from && h.start < to);
}

/** Whether the active region begins on a heading's line, as org-metaleft and org-metaright check. */
function regionStartsAtHeading(): boolean {
  if (!orgRegionActive()) return false;
  const mark = e8.mark() ?? e8.point();
  return parseHeading(lineAt(Math.min(mark, e8.point()))) !== undefined;
}

e8.defineCommand({
  name: "org-do-promote",
  doc: "Make the heading point is on one level higher: one star fewer.",
  run: () => {
    const region = headingsInRegion();
    if (region) {
      e8.keepMarkActive(() => {
        // Forward, as org-map-region goes, so an error stops before the rest.
        for (const h of region) changeLevel(parseHeading(h.line) ?? h, -1);
      });
    } else {
      const [all, i] = backToHeading();
      changeLevel(all[i], -1);
    }
    fixPositionAfterPromote();
  },
});

e8.defineCommand({
  name: "org-do-demote",
  doc: "Make the heading point is on one level lower: one star more.",
  run: () => {
    const region = headingsInRegion();
    if (region) {
      e8.keepMarkActive(() => {
        // Forward, as org-map-region goes, so an error stops before the rest.
        for (const h of region) changeLevel(parseHeading(h.line) ?? h, 1);
      });
    } else {
      const [all, i] = backToHeading();
      changeLevel(all[i], 1);
    }
    fixPositionAfterPromote();
  },
});

e8.defineCommand({
  name: "org-promote-subtree",
  doc: "Make the subtree point is in one level higher.",
  run: () => changeSubtreeLevel(-1),
});

e8.defineCommand({
  name: "org-demote-subtree",
  doc: "Make the subtree point is in one level lower.",
  run: () => changeSubtreeLevel(1),
});

/** Ensures the buffer ends with a newline, so whole lines can move. */
function endWithNewline(): void {
  const size = e8.bufferSize();
  if (size > 0 && e8.bufferText(size - 1, size) !== "\n") {
    const p = e8.point();
    e8.gotoChar(size);
    e8.insert("\n");
    e8.gotoChar(p);
  }
}

/**
 * Moves the text from start to end so it begins at `to`, which is outside
 * it, keeping point's offset into it and folding it again if it was.
 */
function moveText(start: number, end: number, to: number, refold?: (start: number) => void): void {
  const offset = e8.point() - start;
  const text = e8.deleteRegion(start, end);
  const target = to > start ? to - (end - start) : to;
  e8.gotoChar(target);
  e8.insert(text);
  e8.gotoChar(target + offset);
  refold?.(target);
}

/** The next heading at the level of the one at pos, if no higher one comes first, as org-get-next-sibling finds it. */
function nextSiblingStart(all: Heading[], pos: number): number | undefined {
  const i = headingStartingAt(all, pos);
  const level = all[i].level;
  let k = i + 1;
  while (k < all.length && all[k].level > level) k++;
  return k < all.length && all[k].level >= level ? all[k].start : undefined;
}

/**
 * The heading before the one at pos at its level, as org-get-previous-sibling
 * finds it: deeper headings are skipped, but one at the start of the buffer
 * counts.
 */
function previousSiblingStart(all: Heading[], pos: number): number | undefined {
  const i = headingStartingAt(all, pos);
  const level = all[i].level;
  let k = i - 1;
  if (k < 0) return undefined;
  // As org-get-previous-sibling climbs with outline-previous-heading: a
  // deeper heading at the very start of the buffer stops it there, but above
  // the first heading is the start of the buffer, which is level 0.
  while (all[k].level > level) {
    if (all[k].start === 0) break;
    if (k === 0) return undefined;
    k--;
  }
  return all[k].level < level ? undefined : all[k].start;
}

/** Moves the subtree at point past arg siblings, back if negative, as org-move-subtree-down does. */
export function moveSubtree(arg: number): void {
  const col = e8.point() - e8.lineStart(lineAt());
  const [all, found] = backToHeading(true);
  const i = visibleHeadingIndex(all, all[found].line) ?? found;
  const beg = all[i].start;
  e8.gotoChar(beg);
  const wasFolded = folded(all[i].end, "outline");
  const end = subtreeRegion(all, i)[1];
  let at = beg;
  for (let n = Math.abs(arg); n > 0; n--) {
    const next = arg > 0 ? nextSiblingStart(all, at) : previousSiblingStart(all, at);
    if (next === undefined) {
      e8.gotoChar(beg);
      e8.userError("Cannot move past superior level or buffer limit");
    }
    at = next;
  }
  let ins = at;
  if (arg > 0) {
    ins = subtreeRegion(all, firstHeadingFrom(all, at))[1];
    // Over any empty lines back to the end of the text, which gets a newline if it has none.
    let q = ins;
    while (q > 0 && /[ \t\n\r]/.test(e8.bufferText(q - 1, q))) q--;
    q = Math.min(lineStartOrEnd(lineAt(q) + 1), ins);
    if (q !== e8.lineStart(lineAt(q))) {
      e8.gotoChar(q);
      e8.insert("\n");
      if (q < ins) ins++;
    }
  }
  const txt = e8.bufferText(beg, end);
  edDelete(beg, end);
  let p = ins > beg ? ins - (end - beg) : ins;
  if (beg > 0) flag(beg - 1, beg, false);
  if (p > 0) flag(p - 1, p, false);
  if (p !== e8.lineStart(lineAt(p)) && e8.bufferText(p, p + 1) === "\n") p++;
  edInsert(p, txt, true);
  if (e8.point() !== e8.lineStart(lineAt())) edInsert(e8.point(), "\n");
  e8.gotoChar(p);
  while (e8.point() < e8.bufferSize() && /[ \t\n\r]/.test(e8.bufferText(e8.point(), e8.point() + 1))) {
    e8.gotoChar(e8.point() + 1);
  }
  const fresh = headings();
  const k = headingIndex(fresh, lineAt());
  if (k !== undefined) {
    if (wasFolded) flag(fresh[k].end, subtreeEnd(fresh, k), true);
    else {
      showEntry(fresh, k);
      hideDrawersIn(fresh[k].line + 1, entryEnd(fresh, k));
      showChildren(fresh, k);
    }
    cleanVisibilityAfterMove(fresh, k);
  }
  const line = lineAt();
  e8.gotoChar(e8.lineStart(line) + Math.min(col, e8.lineEnd(line) - e8.lineStart(line)));
}

/**
 * Folds the drawers of the subtrees around one that moved, and shows the
 * blank lines between them, as org-clean-visibility-after-subtree-move does.
 */
function cleanVisibilityAfterMove(all: Heading[], k: number): void {
  // As org-get-previous-sibling and org-get-next-sibling do, a search that
  // fails still leaves point where it stopped.
  // Each by halving, as the headings are in order.
  const levelAt = (pos: number): number => {
    const h = all[firstHeadingFrom(all, pos)];
    return h?.start === pos ? h.level : 0;
  };
  const before = (pos: number): number => all[firstHeadingFrom(all, pos) - 1]?.start ?? 0;
  const after = (pos: number): number => all[firstHeadingFrom(all, pos + 1)]?.start ?? e8.bufferSize();
  const previous = (pos: number): [number, boolean] => {
    const level = levelAt(pos);
    let p = before(pos);
    if (p === pos || levelAt(p) === 0) return [p, false];
    while (levelAt(p) > level && p !== 0) p = before(p);
    return [p, levelAt(p) >= level];
  };
  const next = (pos: number): [number, boolean] => {
    const level = levelAt(pos);
    let p = after(pos);
    while (p !== e8.bufferSize() && levelAt(p) > level) p = after(p);
    return [p, p !== e8.bufferSize() && levelAt(p) >= level];
  };
  let [from, ok] = previous(all[k].start);
  if (ok) from = previous(from)[0];
  let to = all[k].start;
  [to, ok] = next(to);
  if (ok) [to, ok] = next(to);
  if (ok) [to] = next(to);
  const end = levelAt(to) > 0 ? e8.lineEnd(lineAt(to)) : to;
  const re = new RegExp(`^${"\\*".repeat(all[k].level)} `);
  for (const h of all) {
    if (h.start < from || h.start > end || !re.test(e8.lineText(h.line))) continue;
    if (!e8.invisibleAt(h.start) && e8.invisibleAt(h.end)) showHeadingLine(h);
  }
  hideDrawersIn(lineAt(from), end);
  showEmptyLines("overview", [from, end]);
}

// Subtrees and the kill ring

/**
 * Kills or copies the subtree point is in, and the n - 1 after it, as
 * org-copy-subtree does; point and the mark stay where they were, moving
 * as markers do when the text goes. Called
 * interactively it takes what looks like the subtree, the nearest heading
 * that shows; otherwise, as org-cut-subtree calls it, what is really there.
 */
export function copySubtree(cut: boolean, n: number, visible: boolean): void {
  const p = e8.point();
  const [all, found] = backToHeading(true);
  let i = found;
  for (const a of [found, ...ancestors(all, found)]) {
    i = a;
    if (!visible || !e8.invisibleAt(all[a].start)) break;
  }
  let j = i;
  for (let k = 1; k < n; k++) j = sibling(all, j, 1) ?? j;
  const [beg, end] = [all[i].start, subtreeRegion(all, j)[1]];
  if (end <= beg) return;
  const mark = e8.mark();
  // Whether the tree shows folded, so pasting it back can fold it again.
  const folded = e8.invisibleAt(all[i].end);
  // Point after the mark, as Org passes them in order, so a kill joining
  // an earlier one goes after it.
  e8.setMark(beg);
  e8.gotoChar(end);
  e8.call(cut ? "kill-region" : "kill-ring-save");
  e8.setVariable("org-subtree-clip-folded", folded);
  e8.setVariable("org-subtree-clip", e8.currentKill());
  const moved = (x: number): number => (!cut || x <= beg ? x : x >= end ? x - (end - beg) : beg);
  e8.setMark(mark === undefined ? null : moved(mark));
  e8.gotoChar(moved(p));
  e8.message(`${cut ? "Cut" : "Copied"}: Subtree(s) with ${end - beg} characters`);
}

e8.defineCommand({
  name: "org-cut-subtree",
  doc: "Kill the subtree point is in, so C-c C-x C-y or C-y can put it back.",
  run: () => copySubtree(true, e8.prefixNumericValue(), false),
});

e8.defineCommand({
  name: "org-copy-subtree",
  doc: "Copy the subtree point is in to the kill ring.",
  run: () => copySubtree(false, e8.prefixNumericValue(), e8.calledInteractively()),
});

/** Whether text is one or more subtrees: it starts with a heading and none after is higher, as org-kill-is-subtree-p says. */
function killIsSubtree(text: string): boolean {
  const first = /^(?:[ \t\n\r]*?\n)?(\*+) /.exec(text);
  if (!first) return false;
  const level = first[1].length;
  return allMatches(/^(\*+) /gm, text).every((m) => m[1].length >= level);
}

/** The level of the heading on point's line, or 0 if it is not one. */
function levelHere(): number {
  return parseHeading(lineAt())?.level ?? 0;
}

/**
 * Pastes the last kill as a subtree at the level of the headings around
 * point, as org-paste-subtree does: before the heading point is at the
 * start of, or else before the next visible heading.
 */
export function pasteSubtree(level: e8.PrefixArg): void {
  const txt = e8.currentKill();
  if (!killIsSubtree(txt)) throw new Error("The kill is not a (set of) tree(s).  Use \u2018C-y\u2019 to yank anyway");
  const visible = !e8.invisibleAt(e8.point());
  const old = /^(\*+) /m.exec(txt)?.[1].length ?? -1;
  const c4 = Array.isArray(level) && level[0] === 4;
  const c16 = Array.isArray(level) && level[0] === 16;
  const line = lineAt();
  const text = e8.lineText(line);
  const atBol = e8.point() === e8.lineStart(line);
  let indicator: number | undefined;
  let force: number | undefined;
  if ((level === null || c4 || c16) && /^\*+[ \t]*$/.test(text) && e8.bufferText(e8.point(), e8.point() + 1) !== "*") {
    indicator = (/^\*+/.exec(text) as RegExpExecArray)[0].length;
    force = indicator;
  } else if (c4) force = levelHere();
  else if (typeof level === "number") force = level;
  else if (!c16 && atBol && /^\*+ /.test(text)) force = levelHere();
  const all = headings();
  const shown = all.filter(visible_);
  const prev = parseHeading(line) ? levelHere() : (shown.filter((h) => h.line < line).at(-1)?.level ?? 1);
  const next = shown.find((h) => h.line > line)?.level ?? 1;
  const fresh = force ?? Math.max(c16 ? prev + 1 : 0, prev, next);
  let shift = old === -1 || fresh === -1 || old === fresh ? 0 : fresh - old;
  if (indicator !== undefined) e8.deleteRegion(e8.lineStart(line), lineStartOrEnd(line + 1));
  const here = lineAt();
  if (!(e8.point() === e8.lineStart(here) && parseHeading(here) && !c4 && !c16)) {
    if (c4) {
      const i = headingIndex(headings(), here);
      if (i !== undefined) e8.gotoChar(subtreeEnd(headings(), i));
    }
    const after = headings().filter(visible_).find((h) => h.line > lineAt());
    e8.gotoChar(after ? after.start : e8.bufferSize());
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  }
  let beg = e8.point();
  // Org combines the paste's changes into one, after which its fold checks
  // change nothing here.
  withoutFoldChecks(() => {
    e8.insert(txt);
    if (!txt.endsWith("\n")) e8.insert("\n");
  });
  const end = e8.point();
  e8.gotoChar(beg);
  while (e8.point() < e8.bufferSize() && /[ \t\n\r]/.test(e8.bufferText(e8.point(), e8.point() + 1))) {
    e8.gotoChar(e8.point() + 1);
  }
  beg = e8.point();
  if (e8.invisibleAt(beg) && visible) showHeadingLine(parseHeading(lineAt(beg)) as Heading);
  const endMark = marker(end);
  while (shift !== 0) {
    for (const h of headings().filter((x) => x.start >= beg && x.start < endMark.pos).reverse()) {
      changeLevel(h, shift > 0 ? 1 : -1);
    }
    shift += shift > 0 ? -1 : 1;
  }
  dropMarker(endMark);
  e8.gotoChar(beg);
  e8.message(`Clipboard pasted as level ${fresh} subtree`);
  // A tree folded when it was killed or copied comes back folded.
  if (e8.variable("org-subtree-clip") === e8.currentKill() && e8.variable("org-subtree-clip-folded") === true) {
    foldSubtree(lineAt());
  }
}

/** Hides everything under the heading on a line, as org-fold-subtree does. */
function foldSubtree(line: number): void {
  const all = headings();
  const i = headingIndex(all, line);
  if (i === undefined) return;
  const next = subtreeRegion(all, i)[1];
  const end = next >= e8.bufferSize() ? e8.bufferSize() : next - 1;
  if (end > all[i].end) flag(all[i].end, end, true);
}

e8.defineVariable({
  name: "org-subtree-clip",
  doc: "The last subtree org-cut-subtree or org-copy-subtree put on the kill ring.",
  value: null,
});
e8.defineVariable({
  name: "org-subtree-clip-folded",
  doc: "Whether the subtree in org-subtree-clip was folded when it was cut or copied.",
  value: false,
});
e8.defineVariable({
  name: "org-yank-folded-subtrees",
  doc: "Whether C-y folds the subtrees it yanks, unless folding would hide text after them.",
  value: true,
});

/**
 * Yanks, as org-yank does: a kill that is a set of subtrees, yanked at the
 * start of a line, comes in folded, unless folding would hide text after it.
 */
function orgYank(arg: e8.PrefixArg): void {
  e8.setThisCommand("yank");
  if (arg !== null) {
    e8.callWithPrefix(arg, "yank");
    return;
  }
  const p = e8.point();
  const ls = e8.lineStart(lineAt());
  // As org-kill-is-subtree-p does, an empty kill ring is no subtree.
  let kill = "";
  try {
    kill = e8.currentKill();
  } catch {
    kill = "";
  }
  const subtreep =
    killIsSubtree(kill) &&
    (p === ls || (/^[ \t]*$/.test(e8.bufferText(p, e8.lineEnd(lineAt()))) && /^\*+$/.test(e8.bufferText(ls, p))));
  if (!subtreep || e8.variable("org-yank-folded-subtrees") !== true) {
    e8.call("yank");
    return;
  }
  const beg = p;
  e8.call("yank");
  const end = e8.point();
  e8.gotoChar(beg);
  const swallows = (): boolean => {
    let q = beg;
    while (q < end && !parseHeading(lineAt(q))) q = lineStartOrEnd(lineAt(q) + 1);
    const level = parseHeading(lineAt(Math.min(q, end)))?.level ?? 0;
    let r = end;
    while (r < e8.bufferSize() && /[ \t\r\n\v\f]/.test(e8.bufferText(r, r + 1))) r++;
    if (r >= e8.bufferSize()) return false;
    const h = r === e8.lineStart(lineAt(r)) ? parseHeading(lineAt(r)) : undefined;
    return !(h && h.level <= level);
  };
  if (beg === e8.lineStart(lineAt(beg))) {
    if (swallows()) e8.message("Inserted text not folded because that would swallow text");
    else {
      let q = beg;
      if (!parseHeading(lineAt(q))) {
        while (q < end && !parseHeading(lineAt(q))) q = lineStartOrEnd(lineAt(q) + 1);
        q = Math.min(q, end);
      }
      while (q < end && q === e8.lineStart(lineAt(q)) && parseHeading(lineAt(q))) {
        e8.gotoChar(q);
        foldSubtree(lineAt(q));
        showEmptyLines("folded");
        const all = headings();
        const i = headingIndex(all, lineAt(q)) as number;
        const sibling = all.find((h) => h.start >= subtreeRegion(all, i)[1]);
        q = sibling && sibling.level === all[i].level ? sibling.start : end;
      }
    }
  }
  let r = end;
  while (r < e8.bufferSize() && /[ \t\n\r]/.test(e8.bufferText(r, r + 1))) r++;
  e8.gotoChar(e8.lineStart(lineAt(r)));
  e8.pushMark(beg);
}

e8.defineCommand({
  name: "org-yank",
  doc:
    "C-y in Org: yank, folding the subtrees yanked at the start of a line, as org-yank-folded-subtrees says, " +
    "unless that would hide text after them.",
  run: () => orgYank(e8.prefixArg()),
});

function visible_(h: Heading): boolean {
  return visible(h);
}

e8.defineCommand({
  name: "org-paste-subtree",
  doc: "Paste the last kill as a subtree, its levels changed to fit the headings around point.",
  run: () => pasteSubtree(e8.prefixArg()),
});

e8.defineCommand({
  name: "org-fix-tags-on-the-fly",
  doc: "Align the tags of the heading point is on, if point is before them, as typing on a heading does.",
  run: () => {
    const line = lineAt();
    const m = /^\*+ (?:.*[ \t])?(:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u.exec(e8.lineText(line));
    if (m && e8.point() < e8.lineStart(line) + charCount(e8.lineText(line).slice(0, m[0].length - m[1].length - (/[ \t]*$/.exec(m[0])?.[0].length ?? 0)))) {
      alignTags(line);
    }
  },
});

e8.defineCommand({
  name: "org-paste-special",
  doc: "Paste a subtree at the right level, or in a table, the fields last cut or copied from one.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-paste-rectangle");
    else e8.callWithPrefix(e8.prefixArg(), "org-paste-subtree");
  },
});

e8.defineCommand({
  name: "org-cut-special",
  doc: "Cut the subtree point is in, or in a table, blank the field at point or the fields in the region.",
  run: () => e8.callInteractively(/^[ \t]*\|/.test(e8.lineText(lineAt())) ? "org-table-cut-region" : "org-cut-subtree"),
});

e8.defineCommand({
  name: "org-copy-special",
  doc: "Copy the subtree point is in, or in a table, the field at point or the fields in the region.",
  run: () => e8.callInteractively(/^[ \t]*\|/.test(e8.lineText(lineAt())) ? "org-table-copy-region" : "org-copy-subtree"),
});

// Commands: TODO states, priorities and tags

/**
 * Sets a heading's TODO state, or removes it, as org-todo does: the old
 * keyword and the spaces around it are replaced, so point there moves
 * past the new keyword. Then point near the keyword goes just after it.
 */
export function setTodo(h: Heading, state: string | undefined): void {
  replaceTodoKeyword(h, state);
  fixPositionAfterTodo(h.line);
}

/** Replaces a heading's TODO keyword and the spaces around it, as org-todo does, so point there moves past the new one. */
function replaceTodoKeyword(h: Heading, state: string | undefined): void {
  const from = h.start + h.level;
  const rest = e8.bufferText(from, h.end);
  const kw = h.todo === undefined ? undefined : new RegExp(`^ +${escapeRegExp(h.todo)}(?: +|[ \t]*$)`).exec(rest);
  const old = kw ? kw[0] : (/^ */.exec(rest)?.[0] ?? "");
  const p = marker(e8.point());
  withoutFoldChecks(() => {
    edDelete(from, from + charCount(old));
    edInsert(from, state === undefined ? " " : ` ${state} `, true);
  });
  e8.gotoChar(p.pos);
  dropMarker(p);
}

/**
 * Leaves one space after a heading's TODO keyword, or its stars, as org-todo's
 * last step does. Org moves there inside save-excursion, so point stays
 * where it was, moved only by the edit.
 */
function fixPositionAfterTodo(line: number): void {
  const fresh = parseHeading(line);
  if (!fresh) return;
  const end = fresh.todoAt !== undefined ? fresh.todoAt + charCount(fresh.todo ?? "") : fresh.start + fresh.level;
  const after = e8.bufferText(end, e8.lineEnd(line));
  if (!/^ /.test(after) || /^ *:/.test(after)) return;
  // just-one-space
  const spaces = /^[ \t]*/.exec(after)?.[0].length ?? 0;
  if (spaces > 1) {
    const p = marker(e8.point());
    edDelete(end + 1, end + spaces);
    e8.gotoChar(p.pos);
    dropMarker(p);
  }
}

/** The state after one in a direction, wrapping round through no state. */
function nextState(current: string | undefined, direction: number): string | undefined {
  const sets = todoSets();
  if (sets.length === 0) return undefined;
  if (current === undefined) {
    const set = sets[0];
    const states = [...set.todo, ...set.done];
    return direction > 0 ? states[0] : states.at(-1);
  }
  const set = sets.find((s) => s.todo.includes(current) || s.done.includes(current)) ?? sets[0];
  const states = [...set.todo, ...set.done];
  const k = states.indexOf(current) + direction;
  return k >= 0 && k < states.length ? states[k] : undefined;
}

/**
 * Changes the TODO state of the heading point is under, as org-todo does:
 * the keyword, then the tags, CLOSED, the parent's statistics and a
 * repeat, then point just after the keyword if it was near it.
 */
function todo(direction: number, state?: string): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const before = h.todo;
  const next = state === undefined ? nextState(before, direction) : state === "" ? undefined : state;
  replaceTodoKeyword(h, next);
  if (parseHeading(h.line)?.tagsAt !== undefined) alignTagsAway(h.line);
  const logDone = e8.variable("org-log-done");
  const dolog = logHow(next, before);
  // As org-todo: CLOSED goes when the state does, or goes back to not done; it comes when done.
  if (todoSets().some((s) => s.logs.length > 0) || (logDone !== null && logDone !== false)) {
    const notDone = (k: string | undefined) => k !== undefined && !isDone(k);
    if (next === undefined || (notDone(next) && !notDone(before))) setPlanning(h.line, "CLOSED", undefined);
    if (isDone(next) && !isDone(before) && logDone !== null && logDone !== false) setPlanning(h.line, "CLOSED", `[${formatTimestamp(today(true), true)}]`);
  }
  updateParentTodoStatistics(h.line);
  let note: [string, string | undefined] | undefined;
  if (isDone(next) && !isDone(before)) note = autoRepeat(h.line, before, next as string);
  if (!note && next !== undefined && dolog !== undefined) note = [next, before];
  e8.runHooks("org-after-todo-state-change-hook");
  fixPositionAfterTodo(h.line);
  // Org stores the note from post-command-hook, after the command.
  if (note) storeStateNote(h.line, note[0], note[1]);
}

/**
 * Asks for a state by its fast-access key, as org-fast-todo-selection:
 * the states and their keys show in " *Org todo*" below; SPC clears the
 * state, and C-g or a key no state has quits.
 */
function fastTodoSelection(current: string | undefined): string | undefined {
  const sets = todoSets();
  const keyed = sets.flatMap((s) => s.keys);
  const field = 3 + 1 + 3 + Math.max(...keyed.map(([k]) => e8.stringWidth(k)));
  const name = " *Org todo*";
  e8.getBufferCreate(name);
  return e8.saveWindowExcursion(() => {
    const below = e8.splitWindow(undefined, "below");
    e8.selectWindow(below);
    e8.call("switch-to-buffer", name);
    const perRow = Math.floor(((e8.windowSize()?.width ?? 80) - 4) / field);
    e8.withCurrentBuffer(name, () => {
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.deleteRegion(0, e8.bufferSize());
        let n = 0;
        for (const set of sets) {
          if (n !== 0) {
            n = 0;
            e8.insert("\n");
          }
          e8.insert("{ ");
          set.keys.forEach(([kw, key], j) => {
            if (n === 0) e8.insert("  ");
            const at = e8.point() + 4;
            e8.insert(`[${key ?? ""}] ${kw}${" ".repeat(Math.max(0, field - 4 - charCount(kw)))}`);
            e8.putTextProperty(at, at + charCount(kw), "face", isDone(kw) ? "org-done" : "org-todo");
            n++;
            if (n === perRow && j < set.keys.length - 1) {
              e8.insert("\n");
              n = 0;
            }
          });
          n = 0;
          e8.insert("}\n");
        }
        e8.gotoChar(0);
      });
    });
    e8.call("shrink-window-if-larger-than-buffer");
    const key = e8.readKey("[a-z..]:Set [SPC]:clear");
    if (key === "SPC" || key === " ") return undefined;
    // A key of the current state's sequence wins over another sequence's.
    const own = sets.find((s) => current !== undefined && s.keys.some(([k]) => k === current));
    const found = own?.keys.find(([, k]) => k === key) ?? keyed.find(([, k]) => k === key);
    if (found === undefined || key === "C-g") e8.signal("quit", "Quit");
    return found[0];
  });
}

/**
 * When a heading marked done has a repeating timestamp, puts it back to
 * its state and moves the timestamps on, as org-auto-repeat-maybe does.
 * Returns the note to log, if org-log-repeat says to.
 */
function autoRepeat(line: number, last: string | undefined, done: string): [string, string] | undefined {
  const h = parseHeading(line) as Heading;
  const all = headingsAsRead();
  const end = entryEnd(all, headingIndex(all, line) as number);
  const repeating = /<[0-9]{4}-[0-9][0-9]-[0-9][0-9] [^>\n]*?([.+]?\+([0-9]+)[hdwmy](?:\/[0-9]+[hdwmy])?)/;
  let found = false;
  for (let l = line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    const m = repeating.exec(e8.lineText(l));
    if (m) {
      found = Number(m[2]) !== 0;
      break;
    }
  }
  if (!found) return undefined;
  // Back to the first state of its sequence, or to none.
  const set = todoSets().find((t) => last !== undefined && (t.todo.includes(last) || t.done.includes(last)));
  const to = set ? set.todo[0] ?? set.done[0] : undefined;
  const p = marker(e8.point());
  e8.gotoChar(h.start);
  replaceTodoKeyword(parseHeading(line) as Heading, to);
  if (parseHeading(line)?.tagsAt !== undefined) alignTagsAway(line);
  updateParentTodoStatistics(line);
  setPlanning(line, "CLOSED", undefined);
  const log = e8.variable("org-log-repeat");
  if (log) entryPut(line, "LAST_REPEAT", `[${formatTimestamp(today(true), true)}]`);
  repeatEntry(parseHeading(line) as Heading);
  e8.gotoChar(p.pos);
  dropMarker(p);
  return log ? [done, last ?? ""] : undefined;
}

/**
 * Brings the statistics cookie of a heading's parent up to date with its
 * children's TODO states, as org-update-parent-todo-statistics does: the
 * children at the heading's level with a state, and those done.
 */
function updateParentTodoStatistics(line: number): void {
  const all = headingsAsRead();
  const i = headingIndex(all, line);
  if (i === undefined) return;
  const parent = ancestors(all, i)[0];
  if (parent === undefined || !HAS_COOKIE.test(e8.lineText(all[parent].line))) return;
  if (mapRegionStart && all[parent].start < mapRegionStart.pos) return;
  const level = all[i].level;
  const end = subtreeRegion(all, parent)[1];
  const children: Heading[] = [];
  for (let k = parent + 1; k < all.length && all[k].start < end; k++) if (all[k].level === level) children.push(all[k]);
  const p = marker(e8.point());
  withoutFoldChecks(() => {
    writeCookies(all[parent].line, children.filter((h) => isDone(h.todo)).length, children.filter((h) => h.todo !== undefined).length);
  });
  if (parseHeading(all[parent].line)?.tagsAt !== undefined) alignTagsAway(all[parent].line);
  e8.gotoChar(p.pos);
  dropMarker(p);
}

const todoCommand = e8.defineCommand({
  name: "org-todo",
  doc:
    "Change the TODO state of the heading point is under to the next one: none, TODO, DONE and back to none.\n\n" +
    "The states are org-todo-keywords, or a #+TODO: line's. Marking an entry done whose SCHEDULED or DEADLINE " +
    "date repeats, such as <2026-10-28 Wed +1w>, moves the date on and keeps it to do. With the region active, " +
    "every heading in it changes (org-loop-over-headlines-in-active-region).",
  run: () => {
    const arg = e8.prefixArg();
    // A number picks that state; with fast-access keys, a key does, as org-use-fast-todo-selection says.
    const fast = e8.variable("org-use-fast-todo-selection");
    const change = () => {
      if (typeof arg === "number" && arg > 0) {
        const kw = allKeywords()[arg - 1];
        todo(1, kw ?? "");
      } else if (arg === null && fast !== null && fast !== false && todoSets().some((s) => s.keys.some(([, k]) => k !== undefined))) {
        const [all, i] = backToHeading();
        todo(1, fastTodoSelection(all[i].todo) ?? "");
      } else todo(1);
    };
    if (!forEachHeadingInRegion(change, true)) change();
  },
});

/**
 * Where org-map-entries has narrowed to the region it loops over, if it is
 * looping: headings above it are out of reach, so their cookies stay.
 */
let mapRegionStart: Marker | undefined;

/**
 * Runs body at each visible heading in the active region, as org-map-entries
 * does for commands when org-loop-over-headlines-in-active-region is on.
 * Returns whether it applied.
 */
function forEachHeadingInRegion(body: () => void, todoQuirk = false): boolean {
  const mark = e8.mark();
  if (!orgRegionActive() || mark === undefined || e8.variable("org-loop-over-headlines-in-active-region") !== true) return false;
  const [rb, re] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  if (todoQuirk && e8.invisibleAt(e8.point())) {
    // org-todo gives org-map-entries (when (org-invisible-p) (org-end-of-subtree
    // nil t)) to skip with, which runs once, there and then: point goes to the
    // end of the hidden subtree, and that position skips every heading.
    const all = headings();
    const i = headingIndex(all, lineAt());
    e8.gotoChar(i === undefined ? e8.bufferSize() : subtreeRegion(all, i)[1]);
    return true;
  }
  const outer = mapRegionStart;
  mapRegionStart = marker(rb);
  const atHeadingStart = re === e8.lineStart(lineAt(re)) && parseHeading(lineAt(re)) !== undefined;
  const end = marker(atHeadingStart ? re : (headings().find((h) => h.start > re)?.start ?? e8.bufferSize()));
  const origin = marker(e8.point());
  try {
    let at = marker(rb);
    for (;;) {
      const h = headings().find((x) => x.start >= at.pos && x.start < end.pos);
      if (!h) break;
      dropMarker(at);
      at = marker(h.end);
      if (e8.invisibleAt(h.start)) continue;
      e8.gotoChar(h.start);
      body();
    }
    dropMarker(at);
  } finally {
    e8.gotoChar(origin.pos);
    dropMarker(origin);
    dropMarker(end);
    dropMarker(mapRegionStart);
    mapRegionStart = outer;
  }
  return true;
}

e8.defineCommand({
  name: "org-todo-set",
  doc: "Set the TODO state of the heading point is under, or remove it with an empty state.",
  params: [{ name: "state", prompt: "TODO state: " }],
  run: (state) => todo(1, state),
});

/** Raises (1) or lowers (-1) a heading's priority, as org-priority does for up and down. */
function priority(direction: number): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const highest = String(e8.variable("org-priority-highest") ?? "A").charCodeAt(0);
  const lowest = String(e8.variable("org-priority-lowest") ?? "C").charCodeAt(0);
  const fallback = String(e8.variable("org-priority-default") ?? "B").charCodeAt(0);
  const text = e8.lineText(h.line);
  const cookie = /^.*?(\[#([A-Z0-9]+)\] ?)/.exec(text);
  const again = e8.lastCommand() === e8.thisCommand();
  let next: number;
  if (cookie) next = cookie[2].charCodeAt(0) - direction;
  else next = again ? (direction > 0 ? lowest : highest) : fallback;
  let remove = false;
  if (next < highest || next > lowest) {
    if (!cookie && !again) throw new Error("The default can not be set, see \u2018org-priority-default\u2019 why");
    remove = true;
  }
  const p = marker(e8.point());
  if (cookie) {
    const start = h.start + charCount(cookie[0].slice(0, cookie[0].length - cookie[1].length));
    if (remove) edDelete(start, start + charCount(cookie[1]));
    else {
      // replace-match on the letter alone: point after it stays after it.
      edReplace(start + 2, start + 2 + charCount(cookie[2]), String.fromCharCode(next));
    }
  } else if (remove) {
    dropMarker(p);
    e8.userError("No priority cookie found in line");
  } else if (h.todoAt !== undefined) {
    edInsert(h.todoAt + charCount(h.todo ?? ""), ` [#${String.fromCharCode(next)}]`);
  } else {
    edInsert(h.titleAt, `[#${String.fromCharCode(next)}] `);
  }
  e8.gotoChar(p.pos);
  dropMarker(p);
  if (parseHeading(h.line)?.tagsAt !== undefined) alignTagsAway(h.line);
  e8.message(remove ? "Priority removed" : `Priority of current item set to ${String.fromCharCode(next)}`);
}

e8.defineCommand({
  name: "org-priority-up",
  doc: "Raise the priority of the heading point is under: none starts at the default, and above the highest is none.",
  run: () => priority(1),
});

e8.defineCommand({
  name: "org-priority-down",
  doc: "Lower the priority of the heading point is under: none starts at the default, and below the lowest is none.",
  run: () => priority(-1),
});

e8.defineCommand({
  name: "org-priority",
  doc: "Set the priority of the heading point is under to a letter, or remove it with SPC or an empty answer.",
  params: [{ name: "priority", prompt: "Priority A-C, SPC to remove: " }],
  run: (answer) => {
    const [all, i] = backToHeading();
    const h = all[i];
    const letter = answer.trim().toUpperCase();
    if (h.priorityAt !== undefined) {
      const end = h.priorityAt + 4;
      replaceText(h.priorityAt, letter === "" ? (e8.bufferText(end, end + 1) === " " ? end + 1 : end) : end, letter === "" ? "" : `[#${letter}]`);
    } else if (letter !== "") {
      const at = h.todoAt !== undefined ? h.todoAt + charCount(h.todo ?? "") + 1 : h.start + h.level + 1;
      replaceText(Math.min(at, h.end), Math.min(at, h.end), at > h.end ? ` [#${letter}]` : `[#${letter}] `);
    }
    if (letter === "") {
      if (h.priorityAt !== undefined) e8.message("Priority removed");
    } else e8.message(`Priority of current item set to ${letter}`);
  },
});

/** Puts a heading's tags at org-tags-column, or a space after the title if it is too long. */
export function alignTags(line: number): void {
  const text = e8.lineText(line);
  const m = /^\*+ (?:.*[ \t])?(:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u.exec(text);
  if (!m) return;
  const ls = e8.lineStart(line);
  const tagsIndex = m[0].length - m[1].length - (/[ \t]*$/.exec(m[0])?.[0].length ?? 0);
  const tagsStart = ls + charCount(text.slice(0, tagsIndex));
  const blankIndex = text.slice(0, tagsIndex).replace(/[ \t]+$/, "").length;
  const blankStart = ls + charCount(text.slice(0, blankIndex));
  const column = Number(e8.variable("org-tags-column") ?? -77);
  const blankColumn = e8.stringWidth(text.slice(0, blankIndex));
  const want = Math.max(column >= 0 ? column : -column - e8.stringWidth(m[1]), blankColumn + 1);
  const current = e8.stringWidth(text.slice(0, tagsIndex));
  if (want === current) return;
  // As org--align-tags-here does: point in the blanks keeps its column,
  // and elsewhere it moves as a marker does.
  const p = e8.point();
  const inBlank = lineAt(p) === line && p > blankStart && p <= tagsStart;
  const origin = marker(p);
  edDelete(blankStart, tagsStart);
  edInsert(blankStart, " ".repeat(want - blankColumn));
  if (inBlank) e8.gotoChar(Math.min(ls + (p - ls), e8.lineEnd(line)));
  else e8.gotoChar(origin.pos);
  dropMarker(origin);
}

/** Aligns a heading's tags with point at the heading, as Org does inside save-excursion, so point moves as a marker. */
function alignTagsAway(line: number): void {
  const p = marker(e8.point());
  e8.gotoChar(e8.lineStart(line));
  alignTags(line);
  e8.gotoChar(p.pos);
  dropMarker(p);
}

/** Gives the heading point is under these tags, as org-set-tags does. */
function setTags(tags: string[]): void {
  const [all, i] = backToHeading();
  const h = all[i];
  if (tags.join(":") === h.tags.join(":")) return;
  // The tags go, and the spaces before them, or trailing spaces if there are none.
  const text = e8.lineText(h.line);
  const before = text.slice(0, h.tagsAt !== undefined ? indexOf(h.line, text, h.tagsAt) : text.length).replace(/[ \t]+$/, "");
  replaceText(h.start + charCount(before), h.end, "");
  if (!parseHeading(h.line)) replaceText(e8.lineEnd(h.line), e8.lineEnd(h.line), " ");
  if (tags.length === 0) return;
  const end = e8.lineEnd(h.line);
  replaceText(end, end, ` :${tags.join(":")}:`);
  alignTags(h.line);
}

e8.defineCommand({
  name: "org-set-tags",
  doc: "Give the heading point is under these tags, written as :work:home: or work home; empty removes them.",
  params: [{ name: "tags", prompt: "Tags: ", history: "org-tags-history" }],
  run: (answer: string) => setTags(answer.split(/[:\s,]+/).filter((t) => t !== "")),
});

e8.defineVariable({
  name: "org-tag-alist",
  doc:
    'The tags to offer, as [tag, key] lists, a key a character, or [":startgroup"] and [":endgroup"] around tags ' +
    'of which a heading has only one, and [":newline"]. With keys, C-c C-q picks tags by them.',
  value: [],
});
e8.defineVariable({
  name: "org-use-fast-tag-selection",
  doc: "Whether C-c C-q picks tags by single keys: auto when org-tag-alist gives keys, t always, nil never.",
  value: "auto",
});
e8.defineVariable({
  name: "org-fast-tag-selection-single-key",
  doc: "Whether picking a tag by its key in fast tag selection finishes at once.",
  value: false,
});

/** The tags of the file and the headings above, as org-get-tags gives the inherited ones. */
function inheritedTags(all: Heading[], i: number): string[] {
  const out: string[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+FILETAGS:(.*)$/i.exec(text);
    if (m) for (const t of m[1].split(/[:\s]+/)) if (t !== "" && !out.includes(t)) out.push(t);
  }
  for (const a of ancestors(all, i).reverse()) for (const t of all[a].tags) if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * Picks tags by single keys in " *Org tags*", as org-fast-tag-selection:
 * a key toggles its tag, keeping one tag of a group; SPC clears them, TAB
 * types one, RET accepts and C-g quits. Returns the tags, or undefined.
 */
function fastTagSelection(current: string[], inherited: string[], table: e8.Value[][]): string[] | undefined {
  type Entry = { tag?: string; key?: string; special?: string };
  const entries: Entry[] = table.map((e) => (typeof e[0] === "string" && e[0].startsWith(":") ? { special: e[0] } : { tag: String(e[0]), key: e[1] === undefined || e[1] === null ? undefined : String(e[1]) }));
  const tags = entries.filter((e) => e.tag !== undefined);
  const field = 3 + 1 + 3 + Math.max(0, ...tags.map((e) => e8.stringWidth(e.tag!)));
  // Tags without keys get their first letters, or the next free key, as Org assigns them.
  const pool = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*+-=<>,.?/;|"];
  const used = new Set(tags.map((e) => e.key).filter((k): k is string => k !== undefined));
  for (const e of tags) {
    if (e.key !== undefined) continue;
    const first = e.tag!.replace(/^@/, "")[0]?.toLowerCase();
    e.key = first !== undefined && !used.has(first) ? first : pool.find((c) => !used.has(c)) ?? " ";
    used.add(e.key);
  }
  const groups: string[][] = [];
  let tagsNow = [...current];
  let single = e8.variable("org-fast-tag-selection-single-key") === true;
  const name = " *Org tags*";
  const draw = () => {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(0, e8.bufferSize());
      const put = (text: string, face?: string) => {
        const at = e8.point();
        e8.insert(text);
        if (face) e8.putTextProperty(at, e8.point(), "face", face);
      };
      put(`${"Inherited:".padEnd(12)}`);
      put(inherited.join(" "), "org-done");
      put(`\n${"Current:".padEnd(12)}`);
      put(tagsNow.join(" "), "org-todo");
      put("\n");
      // The third line says when the next key finishes, as org-fast-tag-show-exit.
      if (single) put(`${" ".repeat(Math.max(0, (e8.windowSize()?.width ?? 80) - 19))} Next change exits`, "org-warning");
      put("\n");
      let n = 0;
      let inGroup = false;
      groups.length = 0;
      const perRow = Math.max(1, Math.floor(((e8.windowSize()?.width ?? 80) - 4) / field));
      for (const e of entries) {
        if (e.special === ":startgroup") {
          groups.push([]);
          inGroup = true;
          if (n !== 0) {
            n = 0;
            put("\n");
          }
          put("{ ");
        } else if (e.special === ":endgroup") {
          inGroup = false;
          n = 0;
          put("}\n");
        } else if (e.special === ":newline") {
          if (n !== 0) {
            n = 0;
            put("\n");
          }
        } else if (e.tag !== undefined) {
          if (inGroup) groups[groups.length - 1].push(e.tag);
          if (n === 0 && !inGroup) put("  ");
          put(`[${e.key}] `);
          put(e.tag, tagsNow.includes(e.tag) ? "org-todo" : inherited.includes(e.tag) ? "org-done" : undefined);
          put(" ".repeat(Math.max(0, field - 4 - charCount(e.tag))));
          if (++n === perRow) {
            put("\n");
            if (inGroup) put("  ");
            n = 0;
          }
        }
      }
      put("\n");
      e8.gotoChar(0);
    });
  };
  /** Adds a tag or takes it away; adding one takes away the others of its group, as org--add-or-remove-tag. */
  const toggle = (tag: string) => {
    if (tagsNow.includes(tag)) tagsNow = tagsNow.filter((t) => t !== tag);
    else {
      const group = groups.find((g) => g.includes(tag));
      if (group) tagsNow = tagsNow.filter((t) => !group.includes(t));
      tagsNow.push(tag);
    }
    // In the order of the table, as Org sorts them.
    const order = tags.map((e) => e.tag!);
    tagsNow.sort((a, b) => (order.indexOf(a) < 0 ? 1e6 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 1e6 : order.indexOf(b)));
  };
  return e8.saveWindowExcursion(() => {
    e8.call("switch-to-buffer-other-window", name);
    try {
      for (;;) {
        draw();
        e8.call("shrink-window-if-larger-than-buffer");
        const key = e8.readKey(`[a-z..]:toggle [SPC]:clear [RET]:accept [TAB]:edit [!] ${groups.length === 0 ? "no " : ""}groups [C-c]:${single ? "single" : "multi"}`);
        let changed = false;
        if (key === "RET") return tagsNow;
        if (key === "C-g" || (key === "q" && !tags.some((e) => e.key === "q"))) e8.signal("quit", "Quit");
        if (key === "C-c") single = !single;
        else if (key === "SPC") {
          tagsNow = [];
          changed = true;
        } else if (key === "TAB") {
          const known = [...new Set([...tags.map((e) => e.tag!), ...headings().flatMap((h) => h.tags)])];
          const typed = e8.completingRead("Tag: ", known).trim();
          if (typed !== "") toggle(typed);
          changed = true;
        } else {
          const entry = tags.find((e) => e.key === key);
          if (entry) {
            toggle(entry.tag!);
            changed = true;
          }
        }
        if (changed && single) return tagsNow;
      }
    } finally {
      // The window goes; the buffer stays, as Org leaves it.
      for (const w of e8.windowList()) if (e8.windowBuffer(w) === name && e8.windowList().length > 1) e8.deleteWindow(w);
    }
  });
}

const setTagsCommand = e8.defineCommand({
  name: "org-set-tags-command",
  doc:
    "Set the tags of the heading point is under. With keys in org-tag-alist, pick them by their keys in " +
    "*Org tags*; else type them, as :work:home: or work home, empty for none. With C-u C-u, type them anyway.",
  run: () => {
    const [all, i] = backToHeading();
    const table = e8.variable("org-tag-alist");
    const fast = e8.variable("org-use-fast-tag-selection");
    const keyed = Array.isArray(table) && table.some((e) => Array.isArray(e) && e[1] !== undefined && e[1] !== null && !String(e[0]).startsWith(":"));
    const arg = e8.prefixArg();
    const typed = Array.isArray(arg) && arg[0] === 16;
    if (!typed && Array.isArray(table) && table.length > 0 && (fast === true || (fast === "auto" && keyed))) {
      const chosen = fastTagSelection(all[i].tags, inheritedTags(all, i), table as e8.Value[][]);
      if (chosen !== undefined) setTags(chosen);
      return;
    }
    const answer = e8.readString("Tags: ", { history: "org-tags-history" });
    setTags(answer.split(/[:\s,]+/).filter((t) => t !== ""));
  },
});

e8.defineVariable({ name: "org-tags-history", doc: "Tags answered to org-set-tags-command, newest first.", value: [] });

e8.defineCommand({
  name: "org-align-tags",
  doc: "Put the tags of the heading point is under at org-tags-column; with a prefix argument, every heading's.",
  run: () => {
    if (e8.prefixArg() !== null) {
      for (const h of headings()) if (h.tags.length > 0) alignTags(h.line);
      return;
    }
    const [all, i] = backToHeading();
    alignTags(all[i].line);
  },
});

// Timestamps

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface DateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

export function today(withTime = false): DateTime {
  // Tests fix the day with e8--today, as "YYYY-MM-DD".
  const fixed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e8.variable("e8--today") ?? ""));
  if (fixed) return { year: Number(fixed[1]), month: Number(fixed[2]), day: Number(fixed[3]), ...(withTime ? { hour: 12, minute: 0 } : {}) };
  const now = new Date();
  const d: DateTime = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  if (withTime) {
    d.hour = now.getHours();
    d.minute = now.getMinutes();
  }
  return d;
}

/** A date with its fields carried over, as Emacs's encode-time does: 31 February is 3 March. */
function normalize(d: DateTime): DateTime {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour ?? 0, d.minute ?? 0));
  const out: DateTime = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
  if (d.hour !== undefined) {
    out.hour = t.getUTCHours();
    out.minute = t.getUTCMinutes();
  }
  return out;
}

function weekday(d: DateTime): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

const two = (n: number) => String(n).padStart(2, "0");

/** A timestamp's text without its brackets: 2026-10-28 Wed, or with a time 2026-10-28 Wed 10:00. */
export function formatTimestamp(d: DateTime, withTime = d.hour !== undefined): string {
  const date = `${d.year}-${two(d.month)}-${two(d.day)} ${DAYS[weekday(d)]}`;
  return withTime && d.hour !== undefined ? `${date} ${two(d.hour)}:${two(d.minute ?? 0)}` : date;
}

interface Timestamp {
  start: number;
  end: number;
  active: boolean;
  date: DateTime;
  /** What follows the date and time inside the brackets, such as a repeater " +1w". */
  rest: string;
  /** An end time, as in 10:00-11:00. */
  endTime?: [number, number];
  /** Where each part is, as offsets from the start, for S-<up> to know what to change. */
  dayNameEnd: number;
  hourAt?: number;
  minuteAt?: number;
}

const TS = /([<[])(\d{4})-(\d{2})-(\d{2})((?: +[^\]+0-9>\r\n -]+)?)((?: +(\d{1,2}):(\d{2}))?)((?:-(\d{1,2}):(\d{2}))?)([^\]>\n]*)([>\]])/g;

function timestampsOn(line: number): Timestamp[] {
  const text = e8.lineText(line);
  const found: Timestamp[] = [];
  for (const m of allMatches(TS, text)) {
    const i = m.index ?? 0;
    const date: DateTime = { year: Number(m[2]), month: Number(m[3]), day: Number(m[4]) };
    const ts: Timestamp = {
      start: at(line, text, i),
      end: at(line, text, i + m[0].length),
      active: m[1] === "<",
      date,
      rest: m[12],
      dayNameEnd: 11 + m[5].length,
    };
    if (m[7] !== undefined) {
      date.hour = Number(m[7]);
      date.minute = Number(m[8]);
      ts.hourAt = ts.dayNameEnd + (m[6].length - m[6].trimStart().length);
      ts.minuteAt = ts.hourAt + m[7].length + 1;
    }
    if (m[10] !== undefined) ts.endTime = [Number(m[10]), Number(m[11])];
    found.push(ts);
  }
  return found;
}

/** Whether point is in or just after a timestamp, as org-at-timestamp-p with lax says. */
function timestampHere(): boolean {
  const p = e8.point();
  return tsMatches(lineAt()).some((ts) => ts.start <= p && p <= ts.end);
}

function timestampText(ts: Timestamp): string {
  const [open, close] = ts.active ? ["<", ">"] : ["[", "]"];
  let end = "";
  if (ts.endTime) end = `-${two(ts.endTime[0])}:${two(ts.endTime[1])}`;
  return `${open}${formatTimestamp(ts.date)}${end}${ts.rest}${close}`;
}

/** Where the groups of org-ts-regexp3 match in a timestamp, as positions in the buffer. */
interface TsMatch {
  start: number;
  end: number;
  text: string;
  year: [number, number];
  month: [number, number];
  day: [number, number];
  dayName?: [number, number];
  hour?: [number, number];
  minute?: [number, number];
}

/** The timestamps on a line, matched as Org's org-ts-regexp3 matches them. */
function tsMatches(line: number): TsMatch[] {
  const text = e8.lineText(line);
  const re =
    /[[<](\d{4})-(\d{2})-(\d{2})(?:( *)([^\]+0-9>\r\n -]+))?(?:( )(\d{1,2}):(\d{2}))?[^\]>\n]{0,16}[\]>]/g;
  const out: TsMatch[] = [];
  for (const m of allMatches(re, text)) {
    const i = m.index ?? 0;
    const pos = (k: number): number => at(line, text, k);
    const ts: TsMatch = {
      start: pos(i),
      end: pos(i + m[0].length),
      text: m[0],
      year: [pos(i + 1), pos(i + 5)],
      month: [pos(i + 6), pos(i + 8)],
      day: [pos(i + 9), pos(i + 11)],
    };
    let k = i + 11;
    if (m[5] !== undefined) {
      k += m[4].length;
      ts.dayName = [pos(k), pos(k + m[5].length)];
      k += m[5].length;
    }
    if (m[7] !== undefined) {
      k += 1;
      ts.hour = [pos(k), pos(k + m[7].length)];
      k += m[7].length + 1;
      ts.minute = [pos(k), pos(k + 2)];
    }
    out.push(ts);
  }
  return out;
}

/**
 * What S-<up> changes, by where point is in a timestamp, as
 * org-at-timestamp-p says: a part of the date or time, the brackets, or an
 * offset into what follows the time, such as a repeater.
 */
function timestampCategory(ts: TsMatch, p: number): string | number {
  const inRange = (r?: [number, number]): boolean => r !== undefined && r[0] <= p && p <= r[1];
  if (p === ts.start || p === ts.end - 1) return "bracket";
  if (p === ts.end) return "after";
  if (inRange(ts.year)) return "year";
  if (inRange(ts.month)) return "month";
  if (inRange(ts.hour)) return "hour";
  if (inRange(ts.minute)) return "minute";
  if (inRange(ts.day) || inRange(ts.dayName)) return "day";
  const last = ts.minute?.[1] ?? ts.dayName?.[1];
  if (last !== undefined && p > last && p < ts.end) return p - last;
  return "day";
}

/** Changes an end time or repeater in what follows a timestamp's date, at offset pos, as org-modify-ts-extra does. */
function modifyTsExtra(extra: string, pos: number, n: number, step: number): string {
  const m = /^(?:(-([012][0-9]):([0-5][0-9])))?(?:( +\+)([0-9]+)([dmwy]))?(?:( +-)([0-9]+)([dmwy]))?/.exec(extra);
  if (!m) return extra;
  // Where each group starts and ends in extra.
  const ranges: { [group: number]: [number, number] } = {};
  let k = 0;
  if (m[1] !== undefined) {
    ranges[1] = [0, 6];
    ranges[2] = [1, 3];
    ranges[3] = [4, 6];
    k = 6;
  }
  if (m[5] !== undefined) {
    k += m[4].length;
    ranges[5] = [k, k + m[5].length];
    k += m[5].length;
    ranges[6] = [k, k + 1];
    k += 1;
  }
  if (m[8] !== undefined) {
    k += m[7].length;
    ranges[8] = [k, k + m[8].length];
    k += m[8].length;
    ranges[9] = [k, k + 1];
  }
  const inRange = (g: number): boolean => ranges[g] !== undefined && ranges[g][0] <= pos && pos <= ranges[g][1];
  const units: [string, number][] = [["d", 0], ["w", 1], ["m", 2], ["y", 3], ["d", -1], ["y", 4]];
  const unitAfter = (u: string): string | undefined => {
    const index = (units.find(([name]) => name === u)?.[1] ?? 0) + n;
    return units.find(([, i]) => i === index)?.[0];
  };
  let group: number | undefined;
  let fresh: string | undefined;
  if (inRange(2) || inRange(3)) {
    let hour = Number(m[2]);
    let minute = Number(m[3]);
    if (inRange(2)) hour += n;
    else {
      const rem = minute % step;
      if (rem !== 0) minute += n * step > 0 ? -rem : step - rem;
      minute += n * step;
    }
    if (minute < 0) [minute, hour] = [minute + 60, hour - 1];
    if (minute > 59) [minute, hour] = [minute - 60, hour + 1];
    hour = ((hour % 24) + 24) % 24;
    group = 1;
    fresh = `-${two(hour)}:${two(minute)}`;
  } else if (inRange(6)) {
    group = 6;
    fresh = unitAfter(m[6]);
  } else if (inRange(5)) {
    group = 5;
    fresh = String(Math.max(1, n + Number(m[5])));
  } else if (inRange(9)) {
    group = 9;
    fresh = unitAfter(m[9]);
  } else if (inRange(8)) {
    group = 8;
    fresh = String(Math.max(0, n + Number(m[8])));
  }
  if (group === undefined || fresh === undefined) return extra;
  return extra.slice(0, ranges[group][0]) + fresh + extra.slice(ranges[group][1]);
}

/**
 * Changes the timestamp at point by n of what point is on, or of `what`,
 * as org-timestamp-change does: the date and time are written again with
 * the right day name, keeping only an end time, repeaters and warning
 * periods from what followed them. On a bracket, the timestamp turns
 * between active and inactive.
 */
function changeTimestamp(n: number, what?: string, updown = true): void {
  const origin = e8.point();
  const ts = tsMatches(lineAt()).find((t) => t.start <= origin && origin <= t.end);
  if (!ts) e8.userError("Not at a timestamp");
  const category = timestampCategory(ts, origin);
  if (what === undefined && category === "bracket") {
    const swap: { [c: string]: string } = { "[": "<", "]": ">", "<": "[", ">": "]" };
    replaceText(ts.start, ts.start + 1, swap[ts.text[0]]);
    replaceText(ts.end - 1, ts.end, swap[ts.text[ts.text.length - 1]]);
    e8.message(`Timestamp is now ${ts.text[0] === "[" ? "" : "in"}active`);
    return;
  }
  const field = what ?? category;
  const inactive = ts.text[0] === "[";
  e8.deleteRegion(ts.start, ts.end);
  e8.gotoChar(ts.start);
  const extra = /((?:-[012][0-9]:[0-5][0-9])?(?: +[.+]?-?[-+][0-9]+[hdwmy](?:\/[0-9]+[hdwmy])?)*)[\]>]/.exec(ts.text)?.[1] ?? "";
  const withTime = /^.{10}.*?[0-9]+:[0-9][0-9]/.test(ts.text);
  const parsed = /(\d{4})-(\d{2})-(\d{2})(?: +[^\]+0-9>\r\n -]+)?(?: +(\d{1,2}):(\d{2}))?/.exec(ts.text);
  const d: DateTime = {
    year: Number(parsed?.[1]),
    month: Number(parsed?.[2]),
    day: Number(parsed?.[3]),
    hour: Number(parsed?.[4] ?? 0),
    minute: Number(parsed?.[5] ?? 0),
  };
  let step = Math.max(Number((e8.variable("org-time-stamp-rounding-minutes") as number[] | null)?.[1] ?? 5), 1);
  let increment = n;
  if (updown && field === "minute" && e8.prefixArg() === null) {
    increment = step * Math.sign(n);
    const rem = (d.minute ?? 0) % step;
    if (rem !== 0) d.minute = (d.minute ?? 0) + (n > 0 ? -rem : step - rem);
  } else step = 1;
  if (field === "minute") d.minute = (d.minute ?? 0) + increment;
  if (field === "hour") d.hour = (d.hour ?? 0) + increment;
  if (field === "day") d.day += increment;
  if (field === "month") d.month += increment;
  if (field === "year") d.year += increment;
  let tail = extra;
  if ((field === "hour" || field === "minute") && /-([012][0-9]):([0-5][0-9])/.test(tail)) {
    tail = modifyTsExtra(tail, field === "hour" ? 2 : 5, n, step);
  }
  if (typeof category === "number" && what === undefined) tail = modifyTsExtra(tail, category, n, step);
  const date = normalize(d);
  const [open, close] = inactive ? ["[", "]"] : ["<", ">"];
  // As org-insert-timestamp does, before markers: a mark that was in the
  // old timestamp ends up after the new one.
  e8.insertBeforeMarkers(`${open}${formatTimestamp(date, withTime)}${tail}${close}`);
  const fresh = tsMatches(lineAt(ts.start)).find((t) => t.start === ts.start);
  let target = origin;
  if (fresh) {
    if (category === "day") target = Math.min(fresh.hour ? fresh.hour[0] - 1 + 1 : (fresh.dayName?.[1] ?? fresh.day[1]) - 1, origin);
    else if (category === "hour") target = Math.min(fresh.hour?.[1] ?? origin, origin);
    else if (category === "minute") target = Math.min((fresh.minute?.[1] ?? origin + 1) - 1, origin);
    else if (typeof category === "number") target = Math.min(fresh.end - 1, origin);
    else if (category === "after") target = fresh.end;
  }
  e8.gotoChar(target);
}

for (const [name, n, what, doc] of [
  ["org-timestamp-up", 1, undefined, "Change the part of the timestamp point is on, the year, month, day, hour or minute, one step later."],
  ["org-timestamp-down", -1, undefined, "Change the part of the timestamp point is on one step earlier."],
  ["org-timestamp-up-day", 1, "day", "Move the timestamp point is on a day later."],
  ["org-timestamp-down-day", -1, "day", "Move the timestamp point is on a day earlier."],
] as [string, number, string | undefined, string][]) {
  e8.defineCommand({ name, doc, run: () => changeTimestamp(n * e8.prefixNumericValue(), what) });
}

/**
 * Reads a date as Org's date prompt does, mostly: empty for today; +3 or -2
 * days from today, or +2w, +1m, +1y; 2026-11-03, 11-03 or 3 for the next such
 * date; a weekday such as fri for the next one; and a time such as 10:30.
 */
function parseDate(input: string, withTime = false): DateTime {
  let text = input.trim().toLowerCase();
  const base = today();
  let time: [number, number] | undefined;
  const clock = /(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/.exec(text);
  if (clock) {
    time = [Number(clock[1]), Number(clock[2])];
    text = text.replace(clock[0], " ").trim();
  }
  let d: DateTime;
  let m: RegExpExecArray | null;
  if (text === "" || text === ".") d = base;
  else if ((m = /^([+-])(\d+)([dwmy]?)$/.exec(text))) {
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    const unit = m[3] || "d";
    d = normalize({
      year: base.year + (unit === "y" ? n : 0),
      month: base.month + (unit === "m" ? n : 0),
      day: base.day + (unit === "d" ? n : unit === "w" ? 7 * n : 0),
    });
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) {
    d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  } else if ((m = /^(\d{1,2})-(\d{1,2})$/.exec(text))) {
    d = { year: base.year, month: Number(m[1]), day: Number(m[2]) };
    if (d.month < base.month || (d.month === base.month && d.day < base.day)) d.year += 1;
  } else if ((m = /^(\d{1,2})$/.exec(text))) {
    d = { year: base.year, month: base.month, day: Number(m[1]) };
    if (d.day < base.day) d = normalize({ ...d, month: d.month + 1 });
  } else {
    const k = DAY_NAMES.findIndex((name) => text.length >= 2 && name.startsWith(text));
    if (k < 0) throw new Error(`Cannot read a date from "${input}"`);
    d = normalize({ ...base, day: base.day + ((k - weekday(base) + 7) % 7) });
  }
  if (time) {
    d.hour = time[0];
    d.minute = time[1];
  } else if (withTime) {
    const now = today(true);
    const step = Number((e8.variable("org-time-stamp-rounding-minutes") as number[] | null)?.[0] ?? 0) || 1;
    d.hour = now.hour;
    d.minute = Math.round((now.minute ?? 0) / step) * step;
    d = normalize(d);
  }
  return d;
}

function insertTimestamp(input: string, active: boolean): void {
  const withTime = Array.isArray(e8.prefixArg());
  const date = parseDate(input, withTime);
  const text = active ? `<${formatTimestamp(date)}>` : `[${formatTimestamp(date)}]`;
  const p = e8.point();
  const ts = tsMatches(lineAt()).find((t) => t.start <= p && p <= t.end);
  if (ts) {
    e8.deleteRegion(ts.start, ts.end);
    e8.gotoChar(ts.start);
  }
  e8.insert(text);
}

const timestamp = e8.defineCommand({
  name: "org-timestamp",
  doc:
    "Insert an active timestamp, such as <2026-10-28 Wed>, for a date read in the minibuffer; on a timestamp, change it.\n\n" +
    "Empty is today; +3 is three days on, and +2w, +1m and +1y work too; fri is the next Friday; " +
    "2026-11-03, 11-03 and 3 are the next such date; add a time as 10:30. With C-u, the time now goes in too.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => insertTimestamp(input, true),
});

const inactiveTimestamp = e8.defineCommand({
  name: "org-timestamp-inactive",
  doc: "Insert an inactive timestamp, such as [2026-10-28 Wed], which the agenda leaves out. See org-timestamp.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => insertTimestamp(input, false),
});

e8.defineVariable({ name: "org-read-date-history", doc: "Dates answered to Org's date prompt, newest first.", value: [] });

/** Sets or, with undefined, removes a planning keyword's timestamp on the line after a heading. */
function setPlanning(headingLine: number, keyword: string, ts: string | undefined): void {
  const next = headingLine + 1;
  const planning = next < e8.lineCount() && /^[ \t]*(SCHEDULED|DEADLINE|CLOSED):/.test(e8.lineText(next));
  if (!planning) {
    if (ts === undefined) return;
    const end = e8.lineEnd(headingLine);
    replaceText(end, end, `\n${keyword}: ${ts}`);
    return;
  }
  const text = e8.lineText(next);
  const re = new RegExp(`${keyword}: *[<[][^>\\]\\n]*[>\\]]`);
  let updated: string;
  if (re.test(text)) updated = ts === undefined ? text.replace(re, "") : text.replace(re, `${keyword}: ${ts}`);
  else updated = ts === undefined ? text : `${text.trimEnd()} ${keyword}: ${ts}`;
  updated = updated.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");
  if (updated === text) return;
  const ls = e8.lineStart(next);
  if (updated === "") replaceText(ls - 1, e8.lineEnd(next), "");
  else replaceText(ls, e8.lineEnd(next), updated);
}

function plan(keyword: string, input: string): void {
  const [all, i] = backToHeading();
  if (Array.isArray(e8.prefixArg())) {
    setPlanning(all[i].line, keyword, undefined);
    e8.message(`Item is no longer ${keyword === "DEADLINE" ? "due" : "scheduled"}.`);
    return;
  }
  const date = parseDate(input);
  setPlanning(all[i].line, keyword, `<${formatTimestamp(date)}>`);
}

const schedule = e8.defineCommand({
  name: "org-schedule",
  doc: "Schedule the heading point is under for a date read as org-timestamp reads it. With C-u, unschedule it.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => plan("SCHEDULED", input),
});

const deadline = e8.defineCommand({
  name: "org-deadline",
  doc: "Give the heading point is under a deadline, read as org-timestamp reads it. With C-u, remove it.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => plan("DEADLINE", input),
});

/**
 * Moves an entry's repeating SCHEDULED and DEADLINE dates on, as marking it
 * done does: +1w adds a week, ++1w adds weeks until the date is in the
 * future, .+1w is a week from today. Returns whether any repeated.
 */
function repeatEntry(h: Heading): boolean {
  const all = headings();
  const end = entryEnd(all, headingIndex(all, h.line) as number);
  let repeated = false;
  for (let line = h.line + 1; line < e8.lineCount() && e8.lineStart(line) < end; line++) {
    if (repeatTimestampsOn(line)) repeated = true;
  }
  if (repeated) e8.message(`Entry repeats: ${e8.lineText(h.line + 1).trim()}`);
  return repeated;
}

/** Moves the repeating active timestamps on a line on by their repeaters. Returns whether there were any. */
function repeatTimestampsOn(line: number): boolean {
  let repeated = false;
  for (const ts of timestampsOn(line).reverse()) {
    if (!ts.active) continue;
    const m = /(\.\+|\+\+|\+)(\d+)([hdwmy])/.exec(ts.rest);
    if (!m) continue;
    repeated = true;
    const n = Number(m[2]);
    const add = (d: DateTime): DateTime =>
      normalize({
        ...d,
        year: d.year + (m[3] === "y" ? n : 0),
        month: d.month + (m[3] === "m" ? n : 0),
        day: d.day + (m[3] === "d" ? n : m[3] === "w" ? 7 * n : 0),
        hour: d.hour === undefined ? undefined : d.hour + (m[3] === "h" ? n : 0),
      });
    const now = today();
    const key = (d: DateTime) => d.year * 10000 + d.month * 100 + d.day;
    if (m[1] === ".+") ts.date = add({ ...now, hour: ts.date.hour, minute: ts.date.minute });
    else {
      ts.date = add(ts.date);
      if (m[1] === "++") while (key(ts.date) <= key(now)) ts.date = add(ts.date);
    }
    edDelete(ts.start, ts.end);
    edInsert(ts.start, timestampText(ts), true);
  }
  return repeated;
}

// Imenu, as org.el's org-imenu-get-tree: headings to org-imenu-depth, a
// heading with headings under it a submenu of them.

e8.defineVariable({ name: "org-imenu-depth", doc: "How deep in the outline M-x imenu lists headings.", value: 2 });

/** A heading's text as Imenu lists it: no TODO, priority or tags, links as they read. */
const imenuTitle = (h: Heading): string => h.title.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, link: string, desc?: string) => desc ?? link);

type ImenuItem = [string, number | ImenuItem[]];

const orgImenuGetTree = e8.defun("org-imenu-get-tree", () => {
  const depth = Number(e8.variable("org-imenu-depth") ?? 2);
  const subs: ImenuItem[][] = Array.from({ length: depth + 1 }, () => []);
  let lastLevel = 0;
  for (const h of [...headings()].reverse()) {
    const headline = imenuTitle(h);
    if (h.level > depth || !/\S/.test(headline)) continue;
    if (h.level >= lastLevel) {
      subs[h.level]!.unshift([headline, h.start]);
    } else {
      subs[h.level]!.unshift([headline, subs.slice(h.level + 1).flat()]);
      for (let i = h.level + 1; i <= depth; i++) subs[i] = [];
    }
    lastLevel = h.level;
  }
  return (subs[1] ?? []) as unknown as e8.Value;
});

/**
 * Shows the heading at a position and its ancestors' heading lines, their
 * entries left folded, as org-fold-show-set-visibility's ancestors does:
 * org-fold-heading unfolds from the end of the line before a heading to its end.
 */
function showAncestors(pos: number): void {
  const all = headings();
  let i = headingIndex(all, lineAt(pos));
  if (i === undefined) return;
  // Not at a heading, its entry shows, as org-fold-show-entry.
  if (all[i]!.start !== e8.lineBeginningPosition(pos)) flag(all[i]!.end, entryEnd(all, i), false);
  while (i !== undefined) {
    const h = all[i]!;
    flag(Math.max(0, h.start - 1), h.end, false);
    let parent: number = i - 1;
    while (parent >= 0 && all[parent]!.level >= h.level) parent--;
    i = parent >= 0 ? parent : undefined;
  }
}

e8.addHook("imenu-after-jump-hook", () => {
  if (e8.derivedModeP("org-mode")) showAncestors(e8.point());
});

/** What a link type does, as org-link-set-parameters keeps it: following it. */
export interface LinkParameters {
  follow: (path: string) => void;
}
const linkTypes = new Map<string, LinkParameters>();

/** Says how links of TYPE are followed, as org-link-set-parameters: id: links, as org-id.ts does, or a package's own. */
export function linkSetParameters(type: string, parameters: LinkParameters): void {
  linkTypes.set(type, parameters);
}

function openLink(link: Link): void {
  const path = link.path;
  const type = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(path);
  const handler = type ? linkTypes.get(type[1].toLowerCase()) : undefined;
  if (type && handler) {
    handler.follow(type[2]);
    return;
  }
  const file = /^file:(.*)$/.exec(path)?.[1] ?? (/^(?:\/|~\/|\.\.?\/)/.test(path) ? path : undefined);
  if (file !== undefined) {
    const [name, search] = file.split("::");
    const dir = (e8.bufferFileName() ?? "").replace(/[^/]*$/, "");
    const full = /^[/~]/.test(name) ? name : dir + name;
    e8.call("find-file", full);
    if (search) {
      if (/^\d+$/.test(search)) e8.gotoChar(e8.lineStart(Number(search) - 1));
      else jump(searchInBuffer(search));
    }
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^(id|file):/.test(path)) {
    throw new Error(`E8 cannot open ${path.split(":")[0]} links yet: ${path}`);
  }
  jump(searchInBuffer(path));
}

const openAtPoint = e8.defineCommand({
  name: "org-open-at-point",
  doc:
    "Follow the link point is on: [[*Heading]], [[#custom-id]], [[target]] and [[Heading]] within the buffer, " +
    "and file links such as [[file:notes.org::*Heading]] in another buffer.",
  run: () => openAtPoint_(),
});

/**
 * Follows the link at point, as org-open-at-point does. Elsewhere in an
 * entry Org's context is the heading: it follows the entry's only link,
 * found searching on from point, or says there are none.
 */
function openAtPoint_(): void {
  const link = linkHere();
  if (link) {
    openLink(link);
    return;
  }
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) e8.userError("No link found");
  const h = all[i];
  const p = e8.point();
  if (lineAt() === h.line && h.tagsAt !== undefined && p >= h.tagsAt && p < h.end) {
    throw new Error("E8 cannot show the agenda for a tag yet");
  }
  const end = all[i + 1]?.start ?? e8.bufferSize();
  const { links, last } = linksIn(h.start, end);
  if (links.length === 0) {
    e8.message("No links");
    return;
  }
  if (links.length > 1) throw new Error("E8 cannot choose between an entry's links yet");
  // Org searches on from point to the end of the buffer, and when the link
  // is not there, goes where the last link it found in the entry starts.
  const rest = e8.bufferText(p, e8.bufferSize());
  const at = rest.indexOf(links[0]);
  e8.gotoChar(at < 0 ? last : p + charCount(rest.slice(0, at)));
  openAtPoint_();
}

/**
 * The different links between two positions, in order, as
 * org-offer-links-in-entry finds them, and where the last one found starts.
 */
function linksIn(from: number, to: number): { links: string[]; last: number } {
  const out: string[] = [];
  let last = from;
  for (let l = lineAt(from); l < e8.lineCount() && e8.lineStart(l) < to; l++) {
    const text = e8.lineText(l);
    const found = [LINK, ANGLE_LINK, PLAIN_LINK]
      .flatMap((re) => allMatches(re, text).map((m) => ({ index: m.index ?? 0, text: m[0] })))
      .sort((a, b) => a.index - b.index);
    let after = 0;
    for (const m of found) {
      if (m.index < after) continue;
      after = m.index + m.text.length;
      last = at(l, text, m.index);
      if (!out.includes(m.text)) out.push(m.text);
    }
  }
  return { links: out, last };
}

const insertLink = e8.defineCommand({
  name: "org-insert-link",
  doc: "Insert a link as [[link][description]], or [[link]] without a description; on a link, replace it.",
  params: [
    { name: "link", prompt: "Link: ", history: "org-link-history" },
    { name: "description", prompt: "Description: " },
  ],
  run: (target, description) => {
    if (target.trim() === "") throw new Error("No link given");
    const escaped = target.trim().replace(/([[\]])/g, "\\$1");
    const text = description.trim() === "" ? `[[${escaped}]]` : `[[${escaped}][${description.trim()}]]`;
    const link = linkHere();
    if (link) {
      e8.deleteRegion(link.start, link.end);
      e8.gotoChar(link.start);
    }
    e8.insert(text);
  },
});

e8.defineVariable({ name: "org-link-history", doc: "Links answered to org-insert-link, newest first.", value: [] });

const mouseFollow = e8.defineCommand({
  name: "org-mouse-follow-link",
  doc: "Move point where the mouse was clicked, and follow the link there if there is one, as mouse-1 does on Org links.",
  run: () => {
    e8.call("mouse-set-point");
    if (!e8.derivedModeP("org-mode")) return;
    const link = linkHere();
    if (link) openLink(link);
  },
});

// Typing and deleting, as org.el's org-self-insert-command, org-delete-char
// and org-delete-backward-char do: in a table they keep fields as wide as
// they were, and on a heading the tags aligned. org-mode remaps the typing
// and deleting commands to these.

/** The commands after which typing blanks a field, as org-self-insert-command checks. */
const BLANKING_COMMANDS = ["org-cycle", "org-return", "org-shifttab", "org-ctrl-c-ctrl-c"];

function fixTagsOnTheFly(): void {
  e8.call("org-fix-tags-on-the-fly");
}

/** Deletes n characters forward, or back if n is negative, as delete-char does from Lisp: without killing them. */
function deleteChars(n: number, backward = false): void {
  const command = (n < 0) !== backward ? "delete-backward-char" : "delete-char";
  for (let i = 0; i < Math.abs(n); i++) e8.call(command);
}

e8.defineCommand({
  name: "org-self-insert-command",
  doc:
    "Insert the character typed, as self-insert-command does, keeping a table aligned.\n\n" +
    "In a table field with spaces to spare, a space before the next bar goes as the character goes in. " +
    "Typing right after TAB, S-TAB, RET or C-c C-c moved into a field first blanks it (org-table-auto-blank-field). " +
    "On a heading, the tags are aligned again.",
  run: () => {
    if (speedCommand()) return;
    e8.call("org-fold-check-before-invisible-edit-maybe");
    if (e8.prefixNumericValue() === 1 && !orgRegionActive() && atTable()) {
      if (e8.variable("org-table-auto-blank-field") === true && BLANKING_COMMANDS.includes(e8.lastCommand() ?? "")) {
        blankField();
      }
      if (/^[^|\n]*  \|/.test(restOfLine())) {
        e8.call("self-insert-command");
        const rest = restOfLine();
        const bar = e8.point() + charCount(rest.slice(0, rest.indexOf("|")));
        e8.saveExcursion(() => edDelete(bar - 2, bar - 1));
        return;
      }
    }
    e8.callWithPrefix(e8.prefixArg(), "self-insert-command");
    fixTagsOnTheFly();
  },
});

// Speed commands, as org-keys.el has them: at the start of a heading, with
// org-use-speed-commands on, a key runs a command rather than typing.

e8.defineVariable({
  name: "org-use-speed-commands",
  doc:
    "Whether single keys at the start of a heading run org-speed-commands' commands rather than typing. A function " +
    "is asked, with point where the key was typed, whether they run there too: agent-shell has them run anywhere " +
    "in the transcript, as Org's manual has them run on any of a heading's stars.",
  value: false,
});
e8.defineVariable({
  name: "org-speed-commands",
  doc:
    "The speed commands: [key, command] lists, or [key, [function, ...arguments]] for a function to call; a list of " +
    "one string is a heading for org-speed-command-help.",
  value: [
    ["Outline Navigation"],
    ["n", ["org-speed-move-safe", "org-next-visible-heading"]],
    ["p", ["org-speed-move-safe", "org-previous-visible-heading"]],
    ["f", ["org-speed-move-safe", "org-forward-heading-same-level"]],
    ["b", ["org-speed-move-safe", "org-backward-heading-same-level"]],
    ["F", "org-next-block"],
    ["B", "org-previous-block"],
    ["u", ["org-speed-move-safe", "outline-up-heading"]],
    ["j", "org-goto"],
    ["g", ["org-speed-refile-goto"]],
    ["Outline Visibility"],
    ["c", "org-cycle"],
    ["C", "org-shifttab"],
    [" ", "org-display-outline-path"],
    ["s", "org-toggle-narrow-to-subtree"],
    ["k", "org-cut-subtree"],
    ["=", "org-columns"],
    ["Outline Structure Editing"],
    ["U", "org-metaup"],
    ["D", "org-metadown"],
    ["r", "org-metaright"],
    ["l", "org-metaleft"],
    ["R", "org-shiftmetaright"],
    ["L", "org-shiftmetaleft"],
    ["i", ["org-speed-insert-heading"]],
    ["^", "org-sort"],
    ["w", "org-refile"],
    ["a", "org-archive-subtree-default-with-confirmation"],
    ["@", "org-mark-subtree"],
    ["#", "org-toggle-comment"],
    ["Clock Commands"],
    ["I", "org-clock-in"],
    ["O", "org-clock-out"],
    ["Meta Data Editing"],
    ["t", "org-todo"],
    [",", "org-priority"],
    ["0", ["org-speed-priority", " "]],
    ["1", ["org-speed-priority", "A"]],
    ["2", ["org-speed-priority", "B"]],
    ["3", ["org-speed-priority", "C"]],
    [":", "org-set-tags-command"],
    ["e", "org-set-effort"],
    ["E", "org-inc-effort"],
    ["Agenda Views etc"],
    ["v", "org-agenda"],
    ["/", "org-sparse-tree"],
    ["Misc"],
    ["o", "org-open-at-point"],
    ["?", "org-speed-command-help"],
  ],
});

e8.defun("org-speed-move-safe", (command: e8.Value) => {
  // Moves, but only to a heading, as org-speed-move-safe: else back, with an error.
  const pos = e8.point();
  e8.callInteractively(String(command) as e8.CommandName);
  if (!(e8.point() === e8.lineStart(lineAt()) && parseHeading(lineAt()) !== undefined)) {
    e8.gotoChar(pos);
    e8.signal("error", `Boundary reached while executing ${String(command)}`);
  }
});
e8.defun("org-speed-refile-goto", () => e8.callWithPrefix([4], "org-refile"));
e8.defun("org-speed-insert-heading", () => {
  e8.gotoChar(e8.point() + 1);
  e8.callInteractively("org-insert-heading-respect-content");
});
e8.defun("org-speed-priority", (letter: e8.Value) => e8.call("org-priority", String(letter)));

/**
 * Runs the speed command for the key typed, at the start of a heading, as
 * org-self-insert-command does with org-speed-command-activate; true if it
 * did.
 */
function speedCommand(): boolean {
  const use = e8.variable("org-use-speed-commands");
  if (!truthy(use)) return false;
  const atHeading = e8.point() === e8.lineStart(lineAt()) && /^\*+ /.test(e8.lineText(lineAt()));
  if (!(atHeading || (typeof use === "function" && truthy(e8.funcall(use))))) return false;
  const keys = e8.thisCommandKeys();
  const key = keys === "SPC" ? " " : keys;
  const commands = e8.variable("org-speed-commands");
  const entry = Array.isArray(commands) ? commands.find((e) => Array.isArray(e) && e.length > 1 && e[0] === key) as e8.Value[] | undefined : undefined;
  if (entry === undefined) return false;
  const action = entry[1];
  if (Array.isArray(action)) {
    e8.funcall(String(action[0]), action.slice(1));
    return true;
  }
  const name = String(action);
  if (!e8.commandNames().includes(name)) e8.userError(`E8 does not have ${name} yet`);
  e8.callInteractively(name as e8.CommandName);
  return true;
}

e8.defineCommand({
  name: "org-speed-command-help",
  doc: "Show the speed commands, the keys that run commands at the start of a heading.",
  run: () => {
    if (!truthy(e8.variable("org-use-speed-commands"))) e8.userError("Speed commands are not activated, customize `org-use-speed-commands'");
    const commands = e8.variable("org-speed-commands");
    let text = "Speed commands\n==============\n";
    for (const e of Array.isArray(commands) ? commands : []) {
      if (!Array.isArray(e)) continue;
      if (e.length === 1) text += `\n${String(e[0])}\n${"-".repeat(String(e[0]).length)}\n`;
      else text += `${String(e[0]).padEnd(4)}${Array.isArray(e[1]) ? `(${e[1].map(String).join(" ")})` : String(e[1])}\n`;
    }
    e8.getBufferCreate("*Help*");
    e8.withCurrentBuffer("*Help*", () => {
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.deleteRegion(0, e8.bufferSize());
        e8.insert(text);
      });
      e8.gotoChar(0);
    });
    e8.call("display-buffer", "*Help*");
  },
});

e8.defineCommand({
  name: "org-toggle-comment",
  doc: "Make the heading point is under a comment, with COMMENT after its state and priority, or take that away.",
  run: () => {
    const [all, i] = backToHeading();
    const h = all[i];
    const at = h.titleAt;
    const title = e8.bufferText(at, h.end);
    if (/^COMMENT(?:[ \t]|$)/.test(title)) {
      const m = /^COMMENT[ \t]*/.exec(title)!;
      replaceText(at, at + m[0].length, "");
    } else replaceText(at, at, title === "" ? "COMMENT" : "COMMENT ");
  },
});

e8.defineCommand({
  name: "org-display-outline-path",
  doc: "Say where point is in the outline: its heading and the ones above it.",
  run: () => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (i === undefined) {
      e8.message("");
      return;
    }
    e8.message([...ancestors(all, i).reverse(), i].map((k) => all[k].title).join("/"));
  },
});

e8.defineCommand({
  name: "org-set-effort",
  doc: "Set the Effort property of the entry point is in, as 0:30 or 1h.",
  params: [{ name: "value", prompt: "Effort: " }],
  run: (value: string) => {
    const [all, i] = backToHeading();
    entryPut(all[i].line, "Effort", value);
  },
});

/** Deletes the character after point, putting a space back before the field's bar in a table, as org-delete-char does. */
function orgDeleteChar(n: number): void {
  if (n !== 1 || charAt(e8.point()) === "|" || /^[ \t]*$/.test(beforeOnLine()) || !atTable()) {
    deleteChars(n);
    fixTagsOnTheFly();
    return;
  }
  const m = /^.(.*?)\|/.exec(restOfLine());
  if (m) {
    const update = needsAlign();
    const noalign = /^.*?  \|/.test(restOfLine());
    const p = e8.point();
    const end = p + charCount(m[0]);
    edDelete(p, p + 1);
    // Org goes back two characters from the match's end as it was. Org's
    // after-change functions save and restore the match data as markers,
    // though, which cannot be past the end of the buffer.
    e8.saveExcursion(() => edInsert(Math.min(end, e8.bufferSize()) - 2, " "));
    if (noalign && !update) markAligned();
  } else deleteChars(n);
}

e8.defineCommand({
  name: "org-delete-backward-char",
  doc: "Delete the character before point, as delete-backward-char does, keeping a table's field as wide as it was.",
  run: () => {
    e8.call("org-fold-check-before-invisible-edit-maybe");
    const p = e8.point();
    if (
      e8.prefixNumericValue() === 1 &&
      e8.variable("overwrite-mode") !== true &&
      !orgRegionActive() &&
      p > 0 &&
      charAt(p - 1) !== "|" &&
      /[^ \t]/.test(beforeOnLine()) &&
      restOfLine().includes("|") &&
      atTable()
    ) {
      e8.gotoChar(p - 1);
      orgDeleteChar(1);
      return;
    }
    deleteChars(e8.prefixNumericValue(), true);
    fixTagsOnTheFly();
  },
});

e8.defineCommand({
  name: "org-delete-char",
  doc: "Delete the character after point, as delete-char does, keeping a table's field as wide as it was.",
  run: () => {
    e8.call("org-fold-check-before-invisible-edit-maybe");
    orgDeleteChar(e8.prefixNumericValue());
  },
});

// Commands that depend on where point is, as Org's keys do

const metaLeft = e8.defineCommand({
  name: "org-metaleft",
  doc: "M-<left> in Org: promote a heading, outdent an item, move a table column left, or move back a word.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-move-column-left");
    else if (regionStartsAtHeading() || headingHere()) {
      if (hiddenBelow("headlines")) hiddenTreeError();
      e8.call("org-do-promote");
    } else if (itemHere()) {
      if (hiddenBelow("items")) hiddenTreeError();
      e8.call("org-outdent-item");
    }
    else e8.callWithPrefix(e8.prefixArg(), "backward-word");
  },
});

const metaRight = e8.defineCommand({
  name: "org-metaright",
  doc: "M-<right> in Org: demote a heading, indent an item, move a table column right, or move forward a word.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-move-column-right");
    else if (DRAWER_RE.test(e8.lineText(lineAt()))) e8.call("org-indent-drawer");
    else if (atBlock()) e8.call("org-indent-block");
    else if (regionStartsAtHeading() || headingHere()) {
      if (hiddenBelow("headlines")) hiddenTreeError();
      e8.call("org-do-demote");
    } else if (itemHere()) {
      if (hiddenBelow("items")) hiddenTreeError();
      e8.call("org-indent-item");
    }
    else e8.callWithPrefix(e8.prefixArg(), "forward-word");
  },
});

/** Swaps two stretches of text, as transpose-regions does. */
function transposeRegions(a: number, b: number, c: number, d: number): void {
  let [r1, r2] = [[Math.min(a, b), Math.max(a, b)], [Math.min(c, d), Math.max(c, d)]];
  if (r1[0] > r2[0] || (r1[0] === r2[0] && r1[1] > r2[1])) [r1, r2] = [r2, r1];
  // As transpose-regions does, an empty region next to the other changes nothing.
  if ((r1[0] === r1[1] || r2[0] === r2[1]) && r1[1] === r2[0]) return;
  if (r1[1] > r2[0]) throw new Error("Transposed regions overlap");
  const t1 = e8.bufferText(r1[0], r1[1]);
  const t2 = e8.bufferText(r2[0], r2[1]);
  edDelete(r2[0], r2[1]);
  edInsert(r2[0], t1);
  edDelete(r1[0], r1[1]);
  edInsert(r1[0], t2);
}

/**
 * M-<up> or M-<down> with an active region, as org-metaup and
 * org-metadown do: subtrees in the region move together past the one
 * next to them, and other lines swap with the line next to them.
 * Returns whether it applied.
 */
function metaRegion(up: boolean): boolean {
  const mark = e8.mark();
  if (!orgRegionActive() || mark === undefined) return false;
  const pt = e8.point();
  const [rb, re] = [Math.min(mark, pt), Math.max(mark, pt)];
  if (parseHeading(lineAt(rb))) {
    const origin = marker(pt);
    try {
      const all = headings();
      const level = all[headingIndex(all, lineAt(rb)) as number].level;
      const higher = (from: number, to: number): boolean =>
        all.some((h) => h.level < level && h.start >= from && h.start + h.level + 1 <= to);
      if (up) {
        const end = marker(Math.max(rb, re - 1));
        const before = all.filter((h) => h.level === level && h.start < e8.lineStart(lineAt(rb))).at(-1);
        if ((level > 1 && higher(rb === e8.lineStart(lineAt(rb)) ? rb : lineStartOrEnd(lineAt(rb) + 1), end.pos)) || !before) {
          dropMarker(end);
          e8.userError("Cannot move past superior level or buffer limit");
        }
        e8.gotoChar(before.start);
        while (e8.point() < end.pos) e8.keepMarkActive(() => moveSubtree(1));
        dropMarker(end);
      } else {
        const beg = marker(rb);
        const after = all.find((h) => h.level === level && h.start >= re && h.start + h.level + 1 > re);
        if ((level > 1 && higher(rb === e8.lineStart(lineAt(rb)) ? rb : lineStartOrEnd(lineAt(rb) + 1), re)) || !after) {
          dropMarker(beg);
          e8.userError("Cannot move past superior level or buffer limit");
        }
        e8.gotoChar(after.start);
        while (e8.point() > beg.pos) e8.keepMarkActive(() => moveSubtree(-1));
        dropMarker(beg);
      }
    } finally {
      e8.gotoChar(origin.pos);
      dropMarker(origin);
    }
    return true;
  }
  const a = e8.lineStart(lineAt(rb));
  const atBol = (x: number): boolean => x === e8.lineStart(lineAt(x));
  const b = atBol(re) && re > 0 ? re - 1 : e8.lineEnd(lineAt(re));
  const swap = pt < mark;
  e8.keepMarkActive(() => transposeRegionLines(up, a, b));
  if (swap) e8.call("exchange-point-and-mark");
  return true;
}

/** The region case of org-metaup and org-metadown: the region's lines and the line before or after swap places. */
function transposeRegionLines(up: boolean, a: number, b: number): void {
  const atBol = (x: number): boolean => x === e8.lineStart(lineAt(x));
  if (up) {
    const prev = Math.max(0, lineAt(a) - 1);
    // On the first line, move-beginning-of-line and move-end-of-line with 0 both stay at its start.
    const [c, d] = lineAt(a) === 0 ? [0, 0] : [e8.lineStart(prev), e8.lineEnd(prev)];
    transposeRegions(a, b, c, d);
    e8.setMark(c);
    e8.gotoChar(c + (b - a));
  } else {
    const next = atBol(b) ? lineAt(b) : lineAt(b) + 1;
    const [c, d] = next < e8.lineCount() ? [e8.lineStart(next), e8.lineEnd(next)] : [e8.bufferSize(), e8.bufferSize()];
    transposeRegions(a, b, c, d);
    e8.setMark(1 + a + (d - c));
    e8.gotoChar(1 + a + (d - c) + (b - a));
  }
}

/**
 * In a source block, M-<up> and M-<down> are Babel's first, from
 * org-metaup-hook and org-metadown-hook: they load the block into a session
 * or go to its session. E8 has no Babel sessions, so this fails as Org
 * does for a language without them.
 */
function babelSessionHook(action: "load" | "pop"): void {
  const el = elementAt(e8.point());
  if (el?.type !== "src-block") return;
  const header = e8.lineText(lineAt(el.begin));
  const lang = /^[ \t]*#\+begin_src[ \t]+([^ \t:]\S*)/i.exec(header)?.[1] ?? "nil";
  if (action === "load") throw new Error(`No org-babel-load-session function for ${lang}!`);
  if (!/:session/.test(header)) throw new Error("This block is not using a session!");
  throw new Error(`No org-babel-initiate-session function for ${lang}!`);
}

const metaUp = e8.defineCommand({
  name: "org-metaup",
  doc: "M-<up> in Org: move a subtree, an item or a table row up past the one before it.",
  run: () => {
    babelSessionHook("load");
    if (metaRegion(true)) return;
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-move-row-up");
    else if (headingHere()) e8.call("org-move-subtree-up");
    else if (itemHere()) e8.call("org-move-item-up");
    else e8.call("org-drag-element-backward");
  },
});

const metaDown = e8.defineCommand({
  name: "org-metadown",
  doc: "M-<down> in Org: move a subtree, an item or a table row down past the one after it.",
  run: () => {
    babelSessionHook("pop");
    if (metaRegion(false)) return;
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-move-row-down");
    else if (headingHere()) e8.call("org-move-subtree-down");
    else if (itemHere()) e8.call("org-move-item-down");
    else e8.call("org-drag-element-forward");
  },
});

const shiftMetaLeft = e8.defineCommand({
  name: "org-shiftmetaleft",
  doc: "M-S-<left> in Org: promote a subtree, outdent an item with its children, or delete a table column.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-delete-column");
    else if (headingHere()) e8.call("org-promote-subtree");
    else if (itemHere()) e8.call("org-outdent-item-tree");
    else e8.userError("This command is active in special context like tables, headlines or items");
  },
});

const shiftMetaRight = e8.defineCommand({
  name: "org-shiftmetaright",
  doc: "M-S-<right> in Org: demote a subtree, indent an item with its children, or insert a table column.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-insert-column");
    else if (headingHere()) e8.call("org-demote-subtree");
    else if (itemHere()) e8.call("org-indent-item-tree");
    else e8.userError("This command is active in special context like tables, headlines or items");
  },
});

const shiftMetaUp = e8.defineCommand({
  name: "org-shiftmetaup",
  doc: "M-S-<up> in Org: delete the table row point is on, or drag the line up.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-kill-row");
    else e8.callWithPrefix(e8.prefixArg(), "org-drag-line-backward");
  },
});

const shiftMetaDown = e8.defineCommand({
  name: "org-shiftmetadown",
  doc: "M-S-<down> in Org: insert a table row above the one point is on, or drag the line down.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-insert-row");
    else e8.callWithPrefix(e8.prefixArg(), "org-drag-line-forward");
  },
});

/**
 * Swaps the line before point's with point's, as transpose-lines does,
 * with the insertions and deletions of transpose-subr-1, so folds move as
 * Emacs's overlays do. On an error, the changes are undone, as
 * atomic-change-group does. Leaves point after both lines.
 */
function transposeLinesWithFolds(): void {
  // As transpose-lines' mover: forward a line, adding a newline at the end.
  const mover = (n: number): void => {
    if (n > 0) {
      let short = forwardLine(n);
      if (e8.point() === 0 || e8.bufferText(e8.point() - 1, e8.point()) !== "\n") short++;
      // Through newline, which amalgamates undo as self-insert-command does.
      if (short > 0) {
        e8.undoAutoAmalgamate();
        e8.insert("\n".repeat(short));
      }
    } else forwardLine(n);
  };
  const aux = (x: number): [number, number] => {
    mover(x);
    const a = e8.point();
    mover(-x);
    return [a, e8.point()];
  };
  const pos1 = aux(-1);
  const pos2 = aux(1);
  const sorted = (p: [number, number]): [number, number] => (p[0] > p[1] ? [p[1], p[0]] : p);
  let [a, b] = [sorted(pos1), sorted(pos2)];
  if (a[0] > b[0]) [a, b] = [b, a];
  if (a[1] > b[0]) throw new Error("Don’t have two things to transpose");
  const lenA = a[1] - a[0];
  const textB = e8.bufferText(b[0], b[1]);
  const end = marker(pos2[0]);
  const boundary = marker(b[0]);
  const wasModified = e8.bufferModified();
  const mark = e8.mark();
  // What to undo: insertions as [start, end], deletions as [position, text].
  const undo: ([number, number] | [number, string])[] = [];
  // Each step is recorded before it is made, so one whose fold check fails is undone too.
  try {
    undo.push([a[1], a[1] + charCount(textB)]);
    edInsert(a[1], textB, true);
    const textA = e8.bufferText(a[0], a[0] + lenA);
    undo.push([a[0], textA]);
    edDelete(a[0], a[0] + lenA);
    const at = boundary.pos;
    undo.push([at, at + lenA]);
    edInsert(at, textA);
    undo.push([at + lenA, textB]);
    edDelete(at + lenA, at + lenA + charCount(textB));
    e8.gotoChar(end.pos);
  } catch (e) {
    for (const step of undo.reverse()) {
      if (typeof step[1] === "number") {
        e8.gotoChar(step[0]);
        edDelete(step[0], step[1]);
      } else {
        edInsert(step[0], step[1]);
        e8.gotoChar(step[0]);
      }
    }
    if (!wasModified) e8.setBufferModified(false);
    // Undoing puts the mark back too, as Emacs's undo restores markers.
    if (mark !== undefined) e8.setMark(mark);
    throw e;
  } finally {
    dropMarker(end);
    dropMarker(boundary);
  }
}

/** Drags the line at point `n` lines down, or up if `n` is negative, as org-drag-line-forward does. */
function dragLine(n: number): void {
  for (let i = 0; i < Math.abs(n); i++) {
    // As Org does with current-column and org-move-to-column: hidden link text takes no columns.
    const column = e8.currentColumn();
    if (n > 0) {
      forwardLine(1);
      transposeLinesWithFolds();
      forwardLine(-1);
    } else {
      transposeLinesWithFolds();
      forwardLine(-2);
    }
    e8.moveToColumn(column);
  }
}

e8.defineCommand({
  name: "org-drag-line-forward",
  doc: "Drag the line at point down past the next line, or as many lines as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => dragLine(arg),
});

e8.defineCommand({
  name: "org-drag-line-backward",
  doc: "Drag the line at point up past the line before it, or as many lines as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => dragLine(-arg),
});

/**
 * What S-<left> and S-<right> do on a property, as
 * org-property-next-allowed-value does. E8 has no allowed values for
 * properties yet, so this is Org's error when none are defined.
 */
function nextAllowedValue(): never {
  if (headingIndex(headings(), lineAt()) === undefined) backToHeading();
  throw new Error("Allowed values for this property have not been defined");
}

/**
 * Whether a heading or item on point's line has folded headings or items
 * under it, as org-check-for-hidden says, so M-<left> and M-<right> would
 * change what cannot be seen.
 */
function hiddenBelow(what: "headlines" | "items"): boolean {
  if (orgRegionActive()) return false;
  let l = lineAt() + 1;
  while (l < e8.lineCount() && e8.invisibleAt(e8.lineStart(l) - 1)) l++;
  const end = lineStartOrEnd(l);
  for (let k = lineAt() + 1; k < e8.lineCount() && e8.lineStart(k) < end; k++) {
    const text = e8.lineText(k);
    if ((what === "headlines" ? /^\*+ /.test(text) : ITEM_RE.test(text)) && e8.invisibleAt(e8.lineStart(k))) return true;
  }
  return false;
}

function hiddenTreeError(): never {
  e8.userError("Hidden subtree, open with TAB or use subtree command M-S-<left>/<right>");
}

/**
 * Whether point is in an Org table, as org-at-table-p: its line starts as a
 * table row does, and the parser, which sees the whole buffer, puts point in a table.
 */
function atTableP(): boolean {
  if (!/^[ \t]*\|/.test(e8.lineText(lineAt()))) return false;
  const p = e8.point();
  return e8.saveRestriction(() => {
    e8.widen();
    for (let e = elementAt(p); e; e = e.parent) if (e.type === "table") return true;
    return false;
  });
}

const shiftUp = e8.defineCommand({
  name: "org-shiftup",
  doc: "S-<up> in Org: make a timestamp later, raise a heading's priority, or move to the previous item.",
  run: () => {
    if (timestampHere()) e8.callWithPrefix(e8.prefixArg(), "org-timestamp-up");
    else if (headingHere()) e8.call("org-priority-up");
    else if (itemHere()) e8.call("org-previous-item");
    else if (atTableP()) e8.call("org-table-move-cell-up");
    else shiftSelectError();
  },
});

const shiftDown = e8.defineCommand({
  name: "org-shiftdown",
  doc: "S-<down> in Org: make a timestamp earlier, lower a heading's priority, or move to the next item.",
  run: () => {
    if (timestampHere()) e8.callWithPrefix(e8.prefixArg(), "org-timestamp-down");
    else if (headingHere()) e8.call("org-priority-down");
    else if (itemHere()) e8.call("org-next-item");
    else if (atTableP()) e8.call("org-table-move-cell-down");
    else shiftSelectError();
  },
});

const shiftRight = e8.defineCommand({
  name: "org-shiftright",
  doc: "S-<right> in Org: move a timestamp a day on, change a heading to its next TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) e8.callWithPrefix(e8.prefixArg(), "org-timestamp-up-day");
    // org-todo, which loops over the headings in an active region.
    else if (headingHere()) {
      if (!forEachHeadingInRegion(() => todo(1), true)) todo(1);
    }
    else if (itemLine(lineAt())) cycleListBullet();
    else if (elementAt(e8.point())?.type === "node-property") nextAllowedValue();
    else if (atTableP()) e8.call("org-table-move-cell-right");
    else shiftSelectError();
  },
});

const shiftLeft = e8.defineCommand({
  name: "org-shiftleft",
  doc: "S-<left> in Org: move a timestamp a day back, change a heading to its previous TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) e8.callWithPrefix(e8.prefixArg(), "org-timestamp-down-day");
    // org-todo, which loops over the headings in an active region.
    else if (headingHere()) {
      if (!forEachHeadingInRegion(() => todo(-1), true)) todo(-1);
    }
    else if (itemLine(lineAt())) cycleListBullet("previous");
    else if (elementAt(e8.point())?.type === "node-property") nextAllowedValue();
    else if (atTableP()) e8.call("org-table-move-cell-left");
    else shiftSelectError();
  },
});

function nothingUseful(): never {
  throw new Error("‘C-c C-c’ can do nothing useful here");
}

/** The statistics cookie point is in on its line, if any. */
function cookieHere(): boolean {
  const line = lineAt();
  const text = e8.lineText(line);
  const p = e8.point();
  return allMatches(COOKIE, text).some((m) => {
    const start = at(line, text, m.index ?? 0);
    return start <= p && p <= start + charCount(m[0]);
  });
}

/** C-c C-c on an item's first line, as org-ctrl-c-ctrl-c does: toggles its checkbox, or repairs the list. */
function ctrlCCtrlCItem(line: number, arg: e8.PrefixArg): void {
  const struct = listStruct(line);
  const old = copyStruct(struct);
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const item = getItem(struct, e8.lineStart(line));
  const box = item.checkbox;
  const c4 = Array.isArray(arg) && arg[0] === 4;
  const c16 = Array.isArray(arg) && arg[0] === 16;
  item.checkbox = c16 ? "[-]" : !box && c4 ? "[ ]" : !box || c4 ? undefined : box === "[X]" ? "[ ]" : "[X]";
  fixInd(struct, parents, 2);
  fixItemEnd(struct);
  fixBul(struct, prevs);
  fixInd(struct, parents);
  fixBox(struct, parents);
  if (box && sameStruct(struct, old)) {
    if (c16) e8.message("Checkboxes already reset");
    else e8.userError(`Cannot toggle this checkbox: ${box === "[X]" ? "all subitems checked" : "unchecked subitems"}`);
    return;
  }
  applyStruct(struct, old);
  updateCheckboxCount();
}

/**
 * Whether point is past a heading's title, which ends with a statistics
 * cookie. Org's org-element-context narrows to the title there, so it finds
 * the title's last object, and C-c C-c updates that cookie.
 */
function cookieEndsTitleBeforePoint(): boolean {
  const h = parseHeading(lineAt());
  if (!h || h.title === "") return false;
  const titleEnd = h.titleAt + charCount(h.title);
  if (e8.point() <= titleEnd) return false;
  return new RegExp(`(?:${COOKIE.source})$`).test(h.title);
}

const ctrlCCtrlC = e8.defineCommand({
  name: "org-ctrl-c-ctrl-c",
  doc:
    "C-c C-c in Org: tick or untick a checkbox, align a table, update a statistics cookie, set a heading's tags, " +
    "fix a timestamp, or re-read the buffer's #+ settings on a #+ line.",
  run: () => {
    const line = lineAt();
    const text = e8.lineText(line);
    if (/^[ \t]*$/.test(text)) nothingUseful();
    if (elementAt(e8.point())?.type === "table") {
      // At the table's start, Org recalculates every row and does not align.
      e8.call("org-table-recalculate");
      return;
    }
    if (/^[ \t]*\|/.test(text)) {
      e8.call("org-table-maybe-eval-formula");
      e8.call("org-table-align");
      return;
    }
    if (/^#\+\S*:/.test(text)) {
      storeTodoSets();
      e8.call("font-lock-flush");
      e8.message("Local setup has been refreshed");
      return;
    }
    if (cookieHere() || cookieEndsTitleBeforePoint()) {
      e8.call("org-update-statistics-cookies");
      return;
    }
    if (timestampHere()) {
      changeTimestamp(0, "day");
      return;
    }
    if (headingHere()) {
      // With the region active, Org sets the tags of each heading that starts
      // in it, which may be none.
      const region = e8.variable("org-loop-over-headlines-in-active-region") === true ? headingsInRegion() : undefined;
      if (region && region.length === 0) return;
      if (region) e8.gotoChar(region[0].start);
      e8.callInteractively("org-set-tags-command");
      return;
    }
    if (itemLine(line)) {
      ctrlCCtrlCItem(line, e8.prefixArg());
      return;
    }
    nothingUseful();
  },
});

e8.defineCommand({
  name: "org-toggle-checkbox",
  doc:
    "Tick or untick the checkbox of the item point is on, or of the items in the region or under the heading. " +
    "With C-u, add a checkbox to the item, or remove its checkbox.",
  run: () => toggleCheckbox(e8.prefixArg()),
});

e8.defineCommand({
  name: "org-update-statistics-cookies",
  doc: "Bring the statistics cookies, such as [1/3], of the heading or item point is in up to date.",
  run: () => {
    if (!headingHere()) {
      updateCheckboxCount();
      return;
    }
    // Point goes back where it was, kept by a marker, as in Org: inside a
    // cookie that changed, that is the cookie's start.
    const pos = marker(e8.point());
    const all = headings();
    updateHeadingCookies(all, headingIndex(all, lineAt()) as number);
    e8.gotoChar(pos.pos);
    dropMarker(pos);
  },
});

const ctrlCMinus = e8.defineCommand({
  name: "org-ctrl-c-minus",
  doc: "C-c - in Org: insert a table rule, change a list's bullets, or turn the line into an item.",
  run: () => {
    const line = lineAt();
    if (/^[ \t]*\|/.test(e8.lineText(line))) e8.callWithPrefix(e8.prefixArg(), "org-table-insert-hline");
    else if (orgRegionActive()) e8.call("org-toggle-item");
    else if (inItem(line) !== undefined) cycleListBullet();
    else e8.call("org-toggle-item");
  },
});

/** Replaces text as replace-match does under save-excursion: point inside it goes to its start. */
function replaceKeepingPoint(start: number, end: number, text: string): void {
  const p = marker(e8.point());
  edReplace(start, end, text);
  e8.gotoChar(p.pos);
  dropMarker(p);
}

/** Removes a heading's tags, planning line and property drawer, as org-list--delete-metadata does. */
function deleteMetadata(line: number): void {
  const h = parseHeading(line);
  if (!h) return;
  const text = e8.lineText(line);
  if (h.tagsAt !== undefined) {
    const before = text.slice(0, indexOf(line, text, h.tagsAt)).trimEnd();
    edDelete(e8.lineStart(line) + charCount(before), h.end);
    // As org-set-tags does, a heading that was only tags keeps its space.
    if (!parseHeading(line)) replaceText(e8.lineEnd(line), e8.lineEnd(line), " ");
  }
  const all = headings();
  const i = headingIndex(all, line) as number;
  let meta = endOfMetaData(all[i]);
  while (meta < e8.bufferSize() && /[ \t\n\r]/.test(e8.bufferText(meta, meta + 1))) meta++;
  if (meta < e8.bufferSize()) meta = e8.lineStart(lineAt(meta));
  const next = lineStartOrEnd(line + 1);
  if (meta > next) edDelete(next, meta);
}

/**
 * Indents the lines from point up to end, but not headings or blank ones,
 * so the least indented goes to `ind`, as org-toggle-item's shift-text
 * does. Leaves point at end.
 */
function shiftText(ind: number, end: Marker): void {
  let min = 1000;
  for (let l = lineAt(); l < e8.lineCount() && e8.lineStart(l) < end.pos; l++) {
    const text = e8.lineText(l);
    if (/^[ \t]*$/.test(text) || /^\*+ /.test(text)) continue;
    const i = textIndentation(text);
    if (i === 0) {
      min = 0;
      break;
    }
    min = Math.min(min, i);
  }
  const delta = ind - min;
  while (e8.point() < end.pos) {
    const line = lineAt();
    const text = e8.lineText(line);
    if (!/^[ \t]*$/.test(text) && !/^\*+ /.test(text)) indentLineTo(line, textIndentation(text) + delta);
    if (line + 1 >= e8.lineCount()) {
      e8.gotoChar(e8.bufferSize());
      break;
    }
    e8.gotoChar(e8.lineStart(line + 1));
  }
}

e8.defineCommand({
  name: "org-toggle-item",
  doc:
    "Turn the line, or the lines of the region, into list items; headings into items, their text into the " +
    "items' text; or items back into plain lines.",
  run: () => {
    const mark = e8.mark();
    const region = orgRegionActive() && mark !== undefined;
    let beg: number;
    let end: Marker;
    if (region) {
      const [rb, re] = [Math.min(mark as number, e8.point()), Math.max(mark as number, e8.point())];
      let q = rb;
      while (q < e8.bufferSize() && /[ \r\t\n]/.test(e8.bufferText(q, q + 1))) q++;
      beg = e8.lineStart(lineAt(q));
      end = marker(re);
    } else {
      beg = e8.lineStart(lineAt());
      end = marker(e8.lineEnd(lineAt()));
    }
    const origin = marker(e8.point());
    try {
      e8.gotoChar(beg);
      if (itemLine(lineAt())) {
        while (e8.point() < end.pos) {
          const line = lineAt();
          const parts = itemLine(line) ? itemParts(line) : undefined;
          if (parts) edDelete(parts.bulletAt, parts.bulletAt + charCount(/^\S+[ \t]*/.exec(parts.bullet)?.[0] ?? ""));
          if (line + 1 >= e8.lineCount()) break;
          e8.gotoChar(e8.lineStart(line + 1));
        }
      } else if (parseHeading(lineAt())) {
        deleteMetadata(lineAt());
        let refLevel = (parseHeading(lineAt()) as Heading).level;
        while (e8.point() < end.pos) {
          const line = lineAt();
          const h = parseHeading(line);
          if (!h) break;
          const delta = Math.max(0, h.level - refLevel);
          if (h.level < refLevel) refLevel = h.level;
          deleteMetadata(line);
          // The stars and TODO state go; the title stays.
          const fresh = parseHeading(line) as Heading;
          const titleAt = fresh.title === "" && fresh.priorityAt === undefined ? fresh.end : (fresh.priorityAt ?? fresh.titleAt);
          const ls = e8.lineStart(line);
          // Org checks folds after each change, and the line is neither a
          // heading nor an item between these two.
          edDelete(ls, titleAt);
          edInsert(ls, "- ");
          indentLineTo(line, 2 * delta);
          if (h.todo !== undefined) {
            const struct = listStruct(line);
            const old = copyStruct(struct);
            getItem(struct, e8.lineStart(line)).checkbox = isDone(h.todo) ? "[X]" : "[ ]";
            writeStruct(struct, parentsAlist(struct), old);
          }
          const sectionEnd = headings().find((x) => x.line > line)?.start ?? e8.bufferSize();
          if (line + 1 >= e8.lineCount()) {
            e8.gotoChar(e8.bufferSize());
            break;
          }
          e8.gotoChar(e8.lineStart(line + 1));
          const limit = marker(Math.min(end.pos, sectionEnd));
          shiftText(2 * (delta + 1), limit);
          dropMarker(limit);
        }
      } else {
        while (e8.point() < end.pos) {
          const line = lineAt();
          const text = e8.lineText(line);
          const m = /^([ \t]*)(\S)/.exec(text);
          if (m && !isHeadingLine(text) && !itemLine(line)) {
            const ls = e8.lineStart(line);
            replaceKeepingPoint(ls, ls + charCount(m[0]), `${m[1]}- ${m[2]}`);
          }
          if (line + 1 >= e8.lineCount()) break;
          e8.gotoChar(e8.lineStart(line + 1));
        }
      }
    } finally {
      e8.gotoChar(origin.pos);
      dropMarker(origin);
      dropMarker(end);
    }
  },
});

const ctrlCStar = e8.defineCommand({
  name: "org-ctrl-c-star",
  doc: "C-c * in Org: recalculate a table, or turn the line into a heading as org-toggle-heading does.",
  run: () => {
    if (/^[ \t]*\|/.test(e8.lineText(lineAt()))) e8.call("org-table-recalculate");
    else e8.callWithPrefix(e8.prefixArg(), "org-toggle-heading");
  },
});

const toggleHeading = e8.defineCommand({
  name: "org-toggle-heading",
  doc:
    "Turn lines into headings, or headings into plain text, as org-toggle-heading does.\n\n" +
    "Starting at a heading, take the stars off every heading in the region, or on the line. Starting at an item, " +
    "turn the lists in the region into headings, checkboxes into TODO states. Otherwise make every line of text a " +
    "heading, a level below the one it is under; with a number, at that level; with C-u, only the first line.",
  run: () => orgToggleHeading(e8.prefixArg()),
});

/** Whether a line is a comment, as org-at-comment-p says. */
function commentLine(line: number): boolean {
  return /^[ \t]*#(?: |$)/.test(e8.lineText(line));
}

function orgToggleHeading(nstars: e8.PrefixArg): void {
  // The start of the first line that is not blank or a comment, from pos's.
  const skipBlanks = (pos: number): number => {
    let line = lineAt(pos);
    while (line < e8.lineCount() - 1 && commentLine(line)) line++;
    let q = line === lineAt(pos) ? pos : e8.lineStart(line);
    while (q < e8.bufferSize() && /[ \r\t\n]/.test(e8.bufferText(q, q + 1))) q++;
    return e8.lineStart(lineAt(q));
  };
  if (nstars != null && itemLine(lineAt())) {
    // As org-mark-element does when called from code: the region is the item.
    const el = elementAt(e8.point());
    e8.gotoChar(e8.lineEnd(lineAt()));
    if (el) {
      e8.pushMark(Math.min(e8.bufferSize(), el.end), { activate: true });
      e8.gotoChar(el.begin);
    }
  }
  const mark = e8.mark();
  const region = orgRegionActive() && mark !== undefined;
  let beg: number;
  let end: Marker;
  if (region) {
    const [rb, re] = [Math.min(mark as number, e8.point()), Math.max(mark as number, e8.point())];
    beg = skipBlanks(rb);
    end = marker(re === e8.lineStart(lineAt(re)) ? re : e8.lineEnd(lineAt(re)));
  } else {
    beg = skipBlanks(e8.lineStart(lineAt()));
    end = marker(e8.lineEnd(lineAt()));
  }
  const origin = marker(e8.point());
  let toggled = false;
  let p = beg;
  const forwardLine = (): void => {
    const l = lineAt(p);
    p = l + 1 < e8.lineCount() ? e8.lineStart(l + 1) : e8.bufferSize();
  };
  try {
    if (parseHeading(lineAt(beg))) {
      while (p < end.pos) {
        const m = /^\*+ /.exec(e8.lineText(lineAt(p)));
        if (parseHeading(lineAt(p)) && m) {
          edReplace(p, p + m[0].length, "");
          toggled = true;
        }
        forwardLine();
      }
    } else if (itemLine(lineAt(beg))) {
      while (p < end.pos) {
        if (itemLine(lineAt(p))) {
          const struct = listStruct(lineAt(p));
          p = listToSubtree(p, Math.min(bottomPoint(struct), end.pos + 1));
          toggled = true;
        }
        forwardLine();
      }
    } else {
      const all = headings();
      const i = headingIndex(all, lineAt(beg));
      const count = typeof nstars === "number" ? nstars : i === undefined ? 0 : all[i].level;
      const stars = "*".repeat(count);
      const add = nstars != null ? "" : stars === "" ? "*" : e8.variable("org-odd-levels-only") === true ? "**" : "*";
      const rpl = `${stars}${add} `;
      const limit = Array.isArray(nstars) && nstars[0] === 4 ? marker(e8.lineEnd(lineAt(beg))) : end;
      while (p < limit.pos) {
        const line = lineAt(p);
        const m = /^([ \t]*)(\S)/.exec(e8.lineText(line));
        if (!parseHeading(line) && !itemLine(line) && !commentLine(line) && m) {
          edReplace(p, p + charCount(m[0]), rpl + m[2]);
          toggled = true;
        }
        forwardLine();
      }
      if (limit !== end) dropMarker(limit);
    }
  } finally {
    e8.gotoChar(origin.pos);
    dropMarker(origin);
    dropMarker(end);
  }
  if (!toggled) e8.message("Cannot toggle heading from here");
}

/**
 * Writes timestamps out again from their parts, as org-element-interpret-data
 * does: the day name worked out from the date, and anything else left out.
 */
function interpretTimestamps(text: string): string {
  return text.replace(/([<[])(\d{4})-(\d{2})-(\d{2})( .*?)?[\]>]/g, (_all, open: string, y: string, mo: string, d: string, rest = "") => {
    const time = /([012]?\d):([0-5]\d)/.exec(rest);
    const range = /[012]?\d:[0-5]\d-([012]?\d):([0-5]\d)/.exec(rest);
    const repeat = /[.+]?\+\d+[hdwmy]/.exec(rest);
    const warning = /-?-\d+[hdwmy]/.exec(rest);
    const date: DateTime = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(time?.[1] ?? 0), minute: Number(time?.[2] ?? 0) };
    let body = formatTimestamp(date, time !== null);
    if (range) body += `-${range[1].padStart(2, "0")}:${range[2]}`;
    if (repeat) body += ` ${repeat[0]}`;
    if (warning) body += ` ${warning[0]}`;
    return `${open}${body}${open === "<" ? ">" : "]"}`;
  });
}

/**
 * Turns the list items from pos up to limit into headings, as
 * org-list-to-subtree does with what org-list-to-lisp takes out: an item's
 * depth in the list adds levels, checkboxes become TODO states, and the
 * lines under an item lose their indentation. Returns where the headings end.
 */
function listToSubtree(pos: number, limit: number): number {
  const struct = listStruct(lineAt(pos));
  const parents = parentsAlist(struct);
  const items = struct.filter((e) => e.pos >= pos && e.pos < limit);
  const depth = (e: ListItem): number => {
    const parent = parents.get(e.pos);
    const up = parent === undefined ? undefined : items.find((x) => x.pos === parent);
    return up ? depth(up) + 1 : 1;
  };
  const bottom = Math.min(Math.max(...items.map((e) => e.end)), limit);
  const done = todoSets()[0]?.done[0] ?? "DONE";
  const todo = todoSets()[0]?.todo[0] ?? "TODO";
  // Each item's heading, without its stars, then the lines of text under it.
  const entries: { depth: number; title: string; body: string }[] = [];
  let blanks = 0;
  for (let l = lineAt(pos); l < e8.lineCount() && e8.lineStart(l) < bottom; l++) {
    const text = e8.lineText(l);
    const item = items.find((e) => e.pos === e8.lineStart(l));
    if (item) {
      // Org reads the list narrowed to the limit, so a line it cuts is read as far as it goes.
      const lineEnd = Math.min(e8.lineEnd(l), limit);
      const parts = itemParts(l) as ItemParts;
      const within = parts.matchEnd <= lineEnd;
      const box = parts.checkbox === undefined || !within ? "" : `${parts.checkbox === "[X]" ? done : todo} `;
      const tag = item.tag !== undefined && within ? ` ${item.tag} ` : "";
      const title = within ? e8.bufferText(parts.matchEnd, lineEnd) : "";
      entries.push({ depth: depth(item), title: box + tag + interpretTimestamps(title), body: "" });
      blanks = 0;
    } else if (/^[ \t]*$/.test(text)) blanks++;
    else if (entries.length > 0) {
      entries[entries.length - 1].body += "\n".repeat(blanks + 1) + interpretTimestamps(text.replace(/^[ \t]+/, ""));
      blanks = 0;
    }
  }
  edDelete(pos, bottom);
  const all = headings();
  const above = headingIndex(all, lineAt(pos));
  const level = above === undefined ? 1 : all[above].level + 1;
  // org-blank-before-new-entry's "auto": a blank line before the heading above means one between these.
  const previous = [...all].reverse().find((h) => h.start < pos);
  const blank = previous !== undefined && previous.start > 0 && /^[ \t]*$/.test(e8.lineText(previous.line - 1));
  const text = entries.map((e) => `${"*".repeat(level + e.depth - 1)} ${e.title}${e.body}`).join(blank ? "\n\n" : "\n");
  edInsert(pos, `${text}\n`);
  return pos + charCount(text) + 1;
}

// Structure templates, as org-insert-structure-template

e8.defineVariable({
  name: "org-structure-template-alist",
  doc:
    'The kinds of block C-c C-, offers, each a key and a block type: ["s", "src"] makes #+begin_src and #+end_src. ' +
    "A type in capital letters is inserted in capitals. With org-tempo required, <s and TAB at the start of a line inserts it too.",
  value: [
    ["a", "export ascii"],
    ["c", "center"],
    ["C", "comment"],
    ["e", "example"],
    ["E", "export"],
    ["h", "export html"],
    ["l", "export latex"],
    ["q", "quote"],
    ["s", "src"],
    ["v", "verse"],
  ],
});

/** org-structure-template-alist, as pairs of a key and a block type. */
export function structureTemplates(): [string, string][] {
  const alist = e8.variable("org-structure-template-alist");
  if (!Array.isArray(alist)) return [];
  return alist.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string");
}

/** Whether a block type's first word is in capitals, so its #+BEGIN and #+END are too. */
export function upcaseBlock(type: string): boolean {
  const first = type.split(/\s+/).find((w) => w !== "") ?? "";
  return first === first.toUpperCase();
}

/**
 * Asks for a block type by its key in org-structure-template-alist, as
 * org--insert-structure-template-mks does: a key that starts longer ones
 * is ended with TAB, RET or SPC, and TAB first asks for the type by name.
 */
function readStructureType(): string {
  const templates = structureTemplates();
  const menu = templates.map(([key, type]) => `[${key}] ${type}`).join("  ");
  let typed = "";
  for (;;) {
    const key = e8.readKey(`${menu}  [TAB] write the type\nKey: ${typed}`);
    if (typed === "" && key === "TAB") {
      const type = e8.readString("Structure type: ");
      if (type === "") e8.userError("Empty structure type");
      return type;
    }
    const exact = templates.find(([k]) => k === typed);
    if (exact && (key === "TAB" || key === "RET" || key === "SPC")) return exact[1];
    if ([...key].length !== 1) e8.userError("No such template");
    typed += key;
    const starting = templates.filter(([k]) => k.startsWith(typed));
    if (starting.length === 0) e8.userError("No such template");
    if (starting.length === 1 && starting[0][0] === typed) return starting[0][1];
  }
}

/** Puts a block around the region, or an empty one at point, as org-insert-structure-template. */
export function insertStructureTemplate(type: string): void {
  if (type === "") throw e8.signal("error", `Invalid structure type: "${type}"`);
  const region = orgRegionActive();
  const regionStart = region ? Math.min(e8.point(), e8.mark() as number) : 0;
  const regionEnd = region ? marker(Math.max(e8.point(), e8.mark() as number)) : undefined;
  const extended = /^(src|export)$/i.test(type);
  const verbatim = /^(example|export|src|comment)/i.test(type);
  const up = upcaseBlock(type);
  const first = type.split(/\s+/).find((w) => w !== "") ?? "";
  if (region) e8.gotoChar(regionStart);
  const column = e8.currentIndentation();
  const bol = e8.lineStart(lineAt());
  if (/^[ \t]*$/.test(e8.bufferText(bol, e8.point()))) e8.gotoChar(bol);
  else e8.insert("\n");
  const start = e8.point();
  e8.indentTo(column);
  e8.insert(`#+${up ? "BEGIN" : "begin"}_${type}${extended ? " " : ""}\n`);
  if (regionEnd) {
    // As org-escape-code-in-region: a comma before lines Org would read as its own.
    if (verbatim) {
      let line = lineAt();
      while (e8.lineStart(line) < regionEnd.pos && line < e8.lineCount()) {
        const text = e8.lineText(line);
        const m = /^[ \t]*(?=,*(?:\*|#\+))/.exec(text);
        if (m) edInsert(e8.lineStart(line) + charCount(m[0]), ",");
        line++;
      }
    }
    e8.gotoChar(regionEnd.pos);
    dropMarker(regionEnd);
    e8.skipCharsBackward(" \r\t\n");
    e8.gotoChar(e8.lineEnd(lineAt()));
  }
  if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  e8.indentTo(column);
  e8.insert(`#+${up ? "END" : "end"}_${first}`);
  if (e8.lookingAt("[ \t]*$")) e8.deleteRegion(e8.point(), e8.matchEnd(0)!);
  else e8.insert("\n");
  if (e8.point() === e8.bufferSize() && e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
  e8.gotoChar(start);
  if (extended) e8.gotoChar(e8.lineEnd(lineAt()));
  else {
    forwardLine(1);
    e8.skipCharsForward(" \t");
  }
}

const insertStructureTemplateCommand = e8.defineCommand({
  name: "org-insert-structure-template",
  doc:
    "Insert a block, #+begin_TYPE and #+end_TYPE, around the region if it is active. Asks for its type by the key " +
    "org-structure-template-alist gives it: TAB, RET or SPC ends a key that starts longer ones, and TAB first types the name.",
  run: () => insertStructureTemplate(readStructureType()),
});

// The mode

const keys: { [keys: string]: e8.CommandName | e8.DefinedCommand } = {
  "C-c C-,": insertStructureTemplateCommand,
  TAB: cycle,
  "S-TAB": shiftTab,
  RET: orgReturn,
  "C-y": "org-yank",
  "C-j": "org-return-and-maybe-indent",
  "C-o": "org-open-line",
  "M-RET": metaReturn,
  "C-RET": respectContent,
  "M-S-RET": todoHeading,
  "C-S-RET": todoHeadingRespectContent,
  "M-<left>": metaLeft,
  "M-<right>": metaRight,
  "M-<up>": metaUp,
  "M-<down>": metaDown,
  "M-S-<left>": shiftMetaLeft,
  "M-S-<right>": shiftMetaRight,
  "M-S-<up>": shiftMetaUp,
  "M-S-<down>": shiftMetaDown,
  "S-<up>": shiftUp,
  "S-<down>": shiftDown,
  "S-<left>": shiftLeft,
  "S-<right>": shiftRight,
  "C-c C-t": todoCommand,
  "C-c ,": "org-priority",
  "C-c C-q": setTagsCommand,
  "C-c C-c": ctrlCCtrlC,
  "C-c C-x C-b": "org-toggle-checkbox",
  "C-c C-x p": setProperty,
  "C-c C-x b": treeToIndirectBuffer,
  "C-c C-w": refileCommand,
  "C-c M-w": refileCopyCommand,
  "C-c C-x d": insertDrawer,
  "C-x n s": narrowToSubtree,
  "C-x n e": narrowToElement,
  "C-x n b": narrowToBlock,
  "C-c C-l": insertLink,
  "C-c C-o": openAtPoint,
  "C-c .": timestamp,
  "C-c !": inactiveTimestamp,
  "C-c C-s": schedule,
  "C-c C-d": deadline,
  "C-c C-n": nextHeading,
  "C-c C-p": previousHeading,
  "C-c C-f": forwardSameLevel,
  "C-c C-b": backwardSameLevel,
  "C-c C-u": "outline-up-heading",
  "C-c *": ctrlCStar,
  "C-c -": ctrlCMinus,
  "C-c @": markSubtree,
  "C-c |": "org-table-create-or-convert-from-region",
  "C-c C-x C-w": "org-cut-special",
  "C-c C-x M-w": "org-copy-special",
  "C-c C-x C-y": "org-paste-special",
  "<mouse-1>": mouseFollow,
};

e8.defineMajorMode({
  name: "org-mode",
  modeName: "Org",
  parent: "outline-mode",
  // As org-mode-syntax-table.
  syntax: { '"': '"', "\\": "_", "~": "_", "<": "(>", ">": ")<" },
  doc:
    "The major mode for Org files: notes, plans and lists organised under headings that start with stars.\n\n" +
    "TAB on a heading folds and unfolds it, and S-TAB the whole buffer. M-RET adds a heading or an item, " +
    "M-<left> and M-<right> promote and demote, and M-<up> and M-<down> move a subtree. C-c C-t and S-<right> " +
    "change a heading's TODO state, S-<up> its priority, and C-c C-q its tags. C-c C-c ticks a checkbox. " +
    "C-c . inserts a timestamp, which S-<up> and S-<down> change, and C-c C-s schedules. C-c C-l inserts a " +
    "link and C-c C-o follows it. Lines starting with | are tables: TAB moves between fields and aligns them.",
  bindings: keys,
  setup: () => {
    e8.setVariable("outline-regexp", "\\*+ ");
    e8.setVariable("imenu-create-index-function", orgImenuGetTree);
    e8.addToInvisibilitySpec("org-hide-drawer", { ellipsis: true });
    e8.addToInvisibilitySpec("org-hide-block", { ellipsis: true });
    e8.addToInvisibilitySpec("org-link");
    e8.addToInvisibilitySpec("org-emphasis");
    storeTodoSets();
    if (e8.variable("org-startup-truncated") === true) e8.setVariable("truncate-lines", true);
    // A folded heading ends in org-ellipsis, through the buffer's display table, as org-mode sets it up.
    const ellipsis = e8.variable("org-ellipsis");
    if (typeof ellipsis === "string" && ellipsis !== "") {
      const table = e8.makeCharTable("display-table");
      e8.setCharTableExtraSlot(table, 4, e8.propertize(ellipsis, { face: "org-ellipsis" }));
      e8.setVariable("buffer-display-table", table);
    }
    // As org-mode turns org-indent-mode on, from the variable or a #+STARTUP: line.
    let indented = e8.variable("org-startup-indented") === true;
    for (const [, , text] of keywordLines()) {
      const m = /^#\+STARTUP:(.*)$/i.exec(text);
      for (const word of m ? m[1].trim().split(/\s+/) : []) {
        if (word === "indent") indented = true;
        else if (word === "noindent") indented = false;
      }
    }
    if (indented) e8.callWithPrefix(1, "org-indent-mode");
    // C-M-\ indents the region as Org does, as org-mode sets it.
    e8.makeLocalVariable("indent-region-function");
    e8.setVariable("indent-region-function", "org-indent-region");
    e8.addHook("jit-lock-functions", fontify, { local: true });
    e8.addHook("after-change-functions", foldsAfterChange, { local: true });
    e8.addHook("after-change-functions", headingsAfterChange, { local: true });
    startupVisibility();
  },
});

e8.defineCommand({
  name: "org-force-self-insert",
  doc: "Insert the character typed, as self-insert-command does, without the table handling of org-self-insert-command.",
  run: () => e8.callWithPrefix(e8.prefixArg(), "self-insert-command"),
});
e8.bindKey("|", "org-force-self-insert", "org-mode-map");

e8.remapCommand("org-mode-map", "self-insert-command", "org-self-insert-command");
e8.remapCommand("org-mode-map", "delete-backward-char", "org-delete-backward-char");
e8.remapCommand("org-mode-map", "delete-char", "org-delete-char");
e8.remapCommand("org-mode-map", "move-end-of-line", "org-end-of-line");
