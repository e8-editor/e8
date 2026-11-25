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

import { jump, type Link, linkHere, searchInBuffer, showContext } from "ol";
import { AFFILIATED, type Elem, elementAt, endBeforeBlank, FOOTNOTE_DEFINITION, keepingParse, PLANNING, parseShifts, startsElement, withAffiliated } from "org-element";
import {
  ancestors,
  BLOCK_BEGIN,
  DBLOCK_BEGIN,
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
  foldRegionAt,
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
  showSetVisibility,
  showContext as foldShowContext,
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
  entryDelete,
  entryPut,
  fixBox,
  fixBul,
  fixInd,
  fixItemEnd,
  getItem,
  hasChild,
  indentLineTo,
  indentString,
  alphabetical,
  inItem,
  ITEM_GROUPS,
  insertDrawer,
  insertListItem,
  ITEM_RE,
  itemEndBeforeBlank,
  itemLine,
  itemLineByText,
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
  entryGet,
  propertyLocalValues,
  propertySeparator,
  currentLine,
  orderedHere,
  radioButtonsHere,
  toggleRadioButton,
  topGet,
  ownDrawer,
  propertyDrawerEnd,
  topLocalValues,
  setLineIndenter,
  twoSpacesAfter,
  bulletString,
} from "org-list";
import {
  charAt,
  dropMarker,
  edDelete,
  edInsert,
  invisibleHere,
  lineAt,
  lineStartOrEnd,
  marker,
  type Marker,
  markers,
  orgFitWindowToBuffer,
  orgMks,
  orgPopToBufferSplit,
  orgRegionActive,
  placeMarkers,
} from "org-macs";
import { fillContextPrefix, fillRegionAsParagraph } from "fill";
import { sentenceEnd } from "paragraphs";
import { defineGuide } from "help-guide";
import { withHelpWindow } from "help";
import { refileCommand, refileCopyCommand, refileReverseCommand } from "org-refile";
import { atTable, beforeOnLine, blankField, markAligned, needsAlign, restOfLine } from "org-table";
import { completingReadMultiple } from "crm";
import { allMatches, autoFillAllowed, barfIfBufferReadOnly, charCount, eraseBuffer, escapeRegExp, forwardLine, getBufferWindow, truthy } from "subr";
import { isearchNoUpperCaseP } from "isearch";
import { PARSE_TIME_WEEKDAYS, parseTimeString } from "parse-time";
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
  [
    "org-global-properties",
    "Properties every entry inherits, as [name, value] lists, after those a file gives in #+PROPERTY: lines. " +
      "A property drawer's value comes before these.",
    null,
  ],
  [
    "org-property-separators",
    "What joins a property's values when NAME+ adds to it, as [names, separator] lists, where names is a list of " +
      "property names or a regexp matching them. Others are joined by a space.",
    null,
  ],
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
    "org-odd-levels-only",
    "Whether headings use only odd levels, 1, 3, 5 and on, two stars more for each level down. #+STARTUP: odd or oddeven says for a file.",
    false,
  ],
  [
    "org-loop-over-headlines-in-active-region",
    "Whether commands such as C-c C-t act on every heading in the active region.",
    true,
  ],
  [
    "org-log-reschedule",
    'Whether changing or removing an entry\'s SCHEDULED date is logged: "time" for a note of when, "note" to ask for one too, false for nothing. #+STARTUP: logreschedule, lognotereschedule or nologreschedule says for a file.',
    false,
  ],
  [
    "org-log-redeadline",
    'Whether changing or removing an entry\'s DEADLINE is logged: "time", "note" or false, as org-log-reschedule. #+STARTUP: logredeadline, lognoteredeadline or nologredeadline says for a file.',
    false,
  ],
  [
    "org-log-states-order-reversed",
    "Whether the newest state note goes first, right after the heading or at the top of its drawer; false keeps them in the order they were taken. #+STARTUP: logstatesreversed or nologstatesreversed says for a file.",
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
  ["org-priority-highest", "The highest priority, a capital letter, or a number for numeric priorities.", "A"],
  ["org-priority-lowest", "The lowest priority, a capital letter, or a number for numeric priorities.", "C"],
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
    "org-read-date-prefer-future",
    "Whether a date given without a month or a year is the next one to come: t for that, time for a time earlier today " +
      "to be tomorrow's too, nil for the default date's month and year.",
    true,
  ],
  [
    "org-read-date-force-compatible-dates",
    "Whether a date read from the prompt is brought into the years 1970 to 2037, as older systems need.",
    true,
  ],
  [
    "org-timestamp-rounding-minutes",
    "Minutes are rounded to the first of these when a time is inserted, and S-<up> and S-<down> change them by the second. " +
      "A number alone is both. org-time-stamp-rounding-minutes is its old name.",
    [0, 5],
  ],
];
for (const [name, doc, value] of variables) e8.defineVariable({ name, doc, value });
// Its name before Org 9.6, as org.el keeps it with defvaralias.
e8.defvaralias("org-time-stamp-rounding-minutes", "org-timestamp-rounding-minutes");

/** org-timestamp-rounding-minutes as a pair, a number alone standing for both, as Org normalizes it. */
function roundingMinutes(): [number, number] {
  const v = e8.variable("org-timestamp-rounding-minutes");
  if (typeof v === "number") return [v, v];
  const list = Array.isArray(v) ? v : [];
  return [Number(list[0] ?? 0), Number(list[1] ?? 5)];
}

e8.defineHook("org-insert-heading-hook", "Functions run after a new heading is inserted, with point where its title goes, after any text the heading took from a split line, as M-RET and C-RET insert one.");
e8.defineHook("org-after-demote-entry-hook", "Functions run after a heading is demoted, with point at its start; for a subtree, once for each heading.");
e8.defineHook("org-after-promote-entry-hook", "Functions run after a heading is promoted, with point at its start; for a subtree, once for each heading.");
e8.defineHook(
  "org-cycle-tab-first-hook",
  "Functions TAB in Org tries first, each until one gives true, which then is all TAB does. Emacs also calls it org-tab-first-hook.",
);
e8.defineHook(
  "org-tab-after-check-for-cycling-hook",
  "Functions TAB in Org tries after it has found no heading or item to cycle, each until one gives true.",
);
e8.defineVariable({
  name: "org-cycle-emulate-tab",
  doc:
    "Where TAB in Org indents as TAB does elsewhere, rather than cycling the heading above: t everywhere but on headings, " +
    "exc-hl-bol everywhere but at a heading's start, white only on blank lines, whitestart only before a line's first non-blank, nil nowhere.",
  value: true,
});
e8.defineHook(
  "org-tab-before-tab-emulation-hook",
  "Functions TAB in Org tries where it would indent, not being on a heading, an item, a table or a block, each until one gives true.",
);

for (const [name, doc] of [
  ["org-cycle-subtree-status", "What TAB last did to a heading: \"folded\", \"children\" or \"subtree\"."],
  ["org-cycle-global-status", "What S-TAB last did: \"overview\", \"contents\" or \"all\"."],
  ["org--todo-sets", "The buffer's TODO state sequences: each a list of the states not done and the states done."],
  ["org--tags-lines", "The buffer's TAGS lines' values, as Org mode read them when it started."],
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
e8.defineVariable({ name: "org-fontify-quote-and-verse-blocks", doc: "Whether the text of quote and verse blocks is in the org-quote and org-verse faces; otherwise it is fontified as Org text.", value: false });
e8.defineVariable({ name: "org-protecting-blocks", doc: "The blocks whose text is not Org syntax, which is fontified as org-block, or natively.", value: ["src", "example", "export"] });
e8.defineVariable({
  name: "org-todo-repeat-to-state",
  doc: "The state a repeating entry goes back to when it is marked done: a keyword, t for the state it had, or nil for the first of its sequence. A REPEAT_TO_STATE property says otherwise.",
  value: null,
});
e8.defineVariable({ name: "org-todo-interpretation", doc: "How a flat org-todo-keywords list is read: sequence, or type. Obsolete in Org.", value: "sequence" });
e8.defineVariable({ name: "org-cycle-level-faces", doc: "Whether headings deeper than org-n-level-faces take the level faces again from the first, rather than all the last.", value: true });
e8.defineVariable({ name: "org-n-level-faces", doc: "How many of the eight level faces headings use, from org-level-1.", value: 8 });

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

/** Org's error for a shifted key with nothing to do, as org-shiftselect-error says it, by whether shift-select-mode is on. */
function shiftSelectError(): never {
  if (truthy(e8.variable("shift-select-mode") ?? true)) e8.userError("To use shift-selection with Org mode, customize \u2018org-support-shift-select\u2019");
  e8.userError("This command works only in special context like headlines or timestamps");
}

/** Moves with COMMAND as a shifted key would, starting or extending a region, as org-call-for-shift-select binds this-command-keys-shift-translated. */
function callForShiftSelect(command: e8.CommandName): void {
  e8.handleShiftSelection(true);
  e8.callWithPrefix(e8.prefixArg() ?? null, command);
}

/** org-support-shift-select's setting: off, on, or always. */
function shiftSupport(): "off" | "on" | "always" {
  const v = e8.variable("org-support-shift-select") ?? null;
  return v === "always" || (typeof v === "symbol" && e8.symbolName(v) === "always") ? "always" : truthy(v) ? "on" : "off";
}

// TODO states

e8.defineHook("org-after-todo-state-change-hook", "Functions called after a heading's TODO state changes, at the heading.");
e8.defineHook("org-log-buffer-setup-hook", "Hook that is run after an Org log buffer is created.");
e8.defineHook("org-after-note-stored-hook", "Hook triggered after a note is stored.");
e8.defineVariable({
  name: "org-log-note-headings",
  doc: "Headings for notes added to entries, by purpose: %t the time, %T it active, %d and %D the date, %s the new state, %S the old, %u the user's login and %U name.",
  value: [
    ["done", "CLOSING NOTE %t"],
    ["state", "State %-12s from %-12S %t"],
    ["note", "Note taken on %t"],
    ["reschedule", "Rescheduled from %S on %t"],
    ["delschedule", "Not scheduled, was %S on %t"],
    ["redeadline", "New deadline from %S on %t"],
    ["deldeadline", "Removed deadline, was %S on %t"],
    ["refile", "Refiled on %t"],
    ["clock-out", ""],
  ],
});
e8.defineVariable({ name: "org-finish-function", doc: "Function to be called when C-c C-c is used, as in *Org Note*.", value: null, local: true });
e8.defineVariable({ name: "org-note-abort", doc: "Whether the note being stored was cancelled, while org-finish-function runs.", value: false });
e8.defineVariable({ name: "org-inhibit-startup", doc: "Whether org-mode leaves out its startup visibility and indentation.", value: false });
e8.defineHook("org-ctrl-c-ctrl-c-hook", "Functions C-c C-c tries first, until one returns true, which ends it, as running a source block does.");

interface TodoSet {
  todo: string[];
  done: string[];
  /** Each state's fast-access key, as (t) gives it, in order. */
  keys: [string, string | undefined][];
  /** How entering and leaving a state is logged, as (t!) and (w@/!) say: "time" or "note". */
  logs: [string, string | undefined, string | undefined][];
  /** Whether its keywords are types, as #+TYP_TODO: or a (type ...) list gives them, rather than a sequence. */
  type?: boolean;
}

/**
 * Reads a list of states such as TODO NEXT | DONE, as org-set-regexps-and-options
 * does: each may have a fast-access key and logging, as TODO(t!) or WAIT(w@/!).
 */
/** A TODO keyword with its key and what to log, as WAIT(w@/!). */
const KEYWORD_SPEC = /^(.*?)(?:\(([^!@/])?([!@])?(?:\/([!@]))?\))?$/;

/** What a keyword such as WAIT(w@/!) logs entering and leaving it, as org-extract-log-state-settings reads it. */
function logStateSettings(word: string): [string, string | undefined, string | undefined] | undefined {
  const m = KEYWORD_SPEC.exec(word);
  if (!m || (m[3] === undefined && m[4] === undefined)) return undefined;
  const how = (x?: string) => (x === undefined ? undefined : x === "!" ? "time" : "note");
  return [m[1], how(m[3]), how(m[4])];
}

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
    const m = KEYWORD_SPEC.exec(w)!;
    const name = m[1].replace(/\(.*\)$/, "");
    names.push(name);
    keys.push([name, m[2]]);
    const log = logStateSettings(w);
    if (log !== undefined) logs.push([name, log[1], log[2]]);
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
    // Indented too, and only keywords, not lines in an example or source
    // block, as org-collect-keywords takes them; their text unindented.
    const own = keywordEntries(e8.matchingLines("^[ \t]*#\\+", { caseFold: true }));
    // A #+SETUPFILE: line's file's keywords in its place, as org-collect-keywords follows them; their lines are -1.
    if (!own.some(([, , text]) => /^#\+SETUPFILE:/i.test(text))) return own;
    const base = e8.bufferBaseBuffer();
    const file = base === undefined ? e8.bufferFileName() : e8.withCurrentBuffer(base, () => e8.bufferFileName());
    const chain = file === undefined ? [] : [file];
    return own.flatMap((entry) => [entry, ...setupFileLinesOf(entry[2], e8.variable("default-directory") as string, chain).map((t): [number, number, string] => [-1, -1, t])]);
  });
}

/** Each setup file's keyword lines, by its true name, with its time and size when read, so a file is read again only when it changes. */
const setupFileCache = new Map<string, { modified: number; size: number; lines: string[] }>();

/** The blocks whose lines are no keywords, as Org's parser takes them: example, source, export, comment and verse. */
const VERBATIM_BLOCK = /^[ \t]*#\+begin_(example|src|export|comment|verse)\b/i;

/**
 * The keywords among "#+" lines, in order, unindented: those in an
 * example, source, export, comment or verse block left out, as Org's
 * parser finds no keyword there. The block's own lines are among those
 * given, so one pass over them tells.
 */
function keywordEntries(lines: [number, number, string][]): [number, number, string][] {
  const out: [number, number, string][] = [];
  let inBlock: string | undefined;
  for (const [line, start, text] of lines) {
    if (inBlock !== undefined) {
      if (new RegExp(`^[ \\t]*#\\+end_${inBlock}[ \\t]*$`, "i").test(text)) inBlock = undefined;
      continue;
    }
    const b = VERBATIM_BLOCK.exec(text);
    if (b) inBlock = b[1].toLowerCase();
    else if (/^[ \t]*#\+\S*:/.test(text)) out.push([line, start, text.trimStart()]);
  }
  return out;
}

/** A setup file's keyword lines, as keywordEntries finds them. */
function keywordTextsOf(text: string): string[] {
  return keywordEntries(text.split("\n").map((t, i): [number, number, string] => [i, 0, t])).map(([, , t]) => t);
}

/**
 * The keyword lines a #+SETUPFILE: line brings in, as org--collect-keywords-1
 * reads them: the file named, relative to DIR, unquoted, its own setup
 * files followed in their places, a file not read again within its own
 * chain of setup files (CHAIN). A URL is left out, as E8 fetches none for
 * it; a file that cannot be read is said and left out, as
 * org-file-contents does with NOERROR.
 */
function setupFileLinesOf(text: string, dir: string, chain: string[]): string[] {
  const m = /^#\+SETUPFILE:[ \t]*(.*?)[ \t]*$/i.exec(text);
  if (!m) return [];
  const name = m[1].replace(/^"(.*)"$/, "$1");
  if (/^[a-z][-a-z0-9+.]*:\/\//i.test(name)) return [];
  const file = e8.expandFileName(name, dir);
  if (chain.includes(file)) return [];
  const truename = e8.fileTruename(file);
  const attributes = e8.fileAttributes(truename);
  if (attributes?.type !== "file" || !e8.fileReadableP(truename)) {
    e8.message(`Unable to read file \u201c${file}\u201d`);
    return [];
  }
  let cached = setupFileCache.get(truename);
  if (cached?.modified !== attributes.modified || cached.size !== attributes.size) {
    const buffer = e8.getBufferCreate(e8.generateNewBufferName(" *org setup file*"));
    try {
      const contents = e8.withCurrentBuffer(buffer, () => {
        e8.insertFileContents(truename);
        return e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
      });
      cached = { modified: attributes.modified, size: attributes.size, lines: keywordTextsOf(contents) };
      setupFileCache.set(truename, cached);
    } catch {
      e8.message(`Unable to read file \u201c${file}\u201d`);
      return [];
    } finally {
      e8.call("kill-buffer", buffer.name ?? "");
    }
  }
  const here = e8.fileNameDirectory(file) ?? dir;
  const inner = [...chain, file];
  return cached.lines.flatMap((t) => [t, ...setupFileLinesOf(t, here, inner)]);
}

/** The buffer's TODO sequences: from #+TODO: lines, else org-todo-keywords. */
function readTodoSets(): TodoSet[] {
  // TYP_TODO's sets first, then TODO's, then SEQ_TODO's, as org-set-regexps-and-options appends them.
  const byKind: Record<string, TodoSet[]> = { TYP_TODO: [], TODO: [], SEQ_TODO: [] };
  for (const [, , text] of keywordLines()) {
    const m = /^#\+(TODO|SEQ_TODO|TYP_TODO):(.*)$/i.exec(text);
    const set = m ? todoSetFrom(m[2].trim().split(/\s+/)) : undefined;
    if (m && set) byKind[m[1].toUpperCase()].push(m[1].toUpperCase() === "TYP_TODO" ? { ...set, type: true } : set);
  }
  let sets: TodoSet[] = [...byKind.TYP_TODO, ...byKind.TODO, ...byKind.SEQ_TODO];
  if (sets.length === 0) {
    const value = e8.variable("org-todo-keywords");
    const lists = Array.isArray(value) && value.every(Array.isArray) ? (value as e8.Value[][]) : [value as e8.Value[]];
    const nested = Array.isArray(value) && value.every(Array.isArray);
    for (const list of lists) {
      const words = Array.isArray(list) ? list.map((w) => (typeof w === "symbol" ? e8.symbolName(w) : String(w))) : [];
      // (sequence ...), (type ...) and (priority ...), as Org writes them, the first word saying which; a
      // list of its own without one is keywords all (deliberate). A flat list is all keywords, typed or
      // not as the old org-todo-interpretation says.
      const kind = nested && ["sequence", "type", "priority"].includes(words[0]) ? words.shift() : nested ? undefined : String(e8.variable("org-todo-interpretation") ?? "sequence");
      const set = todoSetFrom(words);
      if (set) sets.push(kind === "type" || kind === "priority" ? { ...set, type: true } : set);
    }
  }
  // With no done keyword in any set, the last keyword is the done one, as org-set-regexps-and-options makes it.
  if (sets.length > 0 && sets.every((set) => set.done.length === 0)) {
    const last = sets.at(-1)!;
    const word = last.todo.at(-1);
    if (word !== undefined) sets = [...sets.slice(0, -1), { ...last, todo: last.todo.slice(0, -1), done: [word] }];
  }
  return sets;
}

function todoSets(): TodoSet[] {
  const value = e8.variable("org--todo-sets");
  if (!Array.isArray(value)) return readTodoSets();
  return (value as unknown as [string[], string[], [string, string | null][], [string, string | null, string | null][], boolean?][]).map(([todo, done, keys, logs, type]) => ({
    todo,
    done,
    keys: (keys ?? []).map(([k, c]) => [k, c ?? undefined] as [string, string | undefined]),
    logs: (logs ?? []).map(([k, a, b]) => [k, a ?? undefined, b ?? undefined] as [string, string | undefined, string | undefined]),
    ...(type === true ? { type: true } : {}),
  }));
}

/**
 * Runs `f` with this buffer's TODO states in whatever buffer it makes
 * current, none of them logging, as org-archive-subtree binds
 * org-todo-keywords-1 and its kin and org-todo-log-states to nil around
 * marking an archived entry done.
 */
export function withTheseTodoStates<T>(): (f: () => T) => T {
  const sets = todoSets().map((s) => [s.todo, s.done, s.keys.map(([k, c]) => [k, c ?? null]), [], s.type === true]);
  return (f) => e8.letBind({ "org--todo-sets": sets as e8.Value }, f);
}

function storeTodoSets(): void {
  e8.setVariable("org--todo-sets", readTodoSets().map((s) => [s.todo, s.done, s.keys.map(([k, c]) => [k, c ?? null]), s.logs.map(([k, a, b]) => [k, a ?? null, b ?? null]), s.type === true]));
}

/** How a change from one state to another is logged, as org-todo works out dolog: "time", "note" or nothing. */
/** The LOGGING property's states, while a state change it covers runs, as org-todo binds org-todo-log-states. */
let localLogStates: [string, string | undefined, string | undefined][] | undefined;

/** What each state logs, as org-todo-log-states: the LOGGING property's, or the keywords'. */
function logStates(): [string, string | undefined, string | undefined][] {
  return localLogStates ?? todoSets().flatMap((s) => s.logs);
}

/**
 * Runs `f` with the logging a LOGGING property's words ask for, as
 * org-todo binds org-log-done, org-log-repeat and org-todo-log-states
 * and org-local-logging sets them: none but what the words name, as
 * logdone, lognoterepeat or WAIT(@).
 */
function withLocalLogging<T>(value: string, f: () => T): T {
  let logDone: e8.Value = false;
  let logRepeat: e8.Value = false;
  const states: [string, string | undefined, string | undefined][] = [];
  const keywords = todoSets().flatMap((s) => [...s.todo, ...s.done]);
  for (const w of value.split(/\s+/).filter((w) => w !== "")) {
    const option = STARTUP_LOG_OPTIONS[w];
    if (option !== undefined) {
      if (option[0] === "org-log-done") logDone = option[1];
      else if (option[0] === "org-log-repeat") logRepeat = option[1];
      continue;
    }
    const log = logStateSettings(w);
    if (log !== undefined && keywords.includes(log[0])) states.unshift(log);
  }
  const outer = localLogStates;
  localLogStates = states;
  try {
    return e8.letBind({ "org-log-done": logDone, "org-log-repeat": logRepeat }, f);
  } finally {
    localLogStates = outer;
  }
}

/** The #+STARTUP: words about logging and levels and the variables they set, as org-startup-options has them. */
const STARTUP_LOG_OPTIONS: Record<string, [string, e8.Value]> = {
  logdone: ["org-log-done", "time"],
  lognotedone: ["org-log-done", "note"],
  nologdone: ["org-log-done", false],
  "lognoteclock-out": ["org-log-note-clock-out", true],
  "nolognoteclock-out": ["org-log-note-clock-out", false],
  logrepeat: ["org-log-repeat", "state"],
  lognoterepeat: ["org-log-repeat", "note"],
  logdrawer: ["org-log-into-drawer", true],
  nologdrawer: ["org-log-into-drawer", false],
  noptag: ["org-tag-persistent-alist", null],
  logstatesreversed: ["org-log-states-order-reversed", true],
  nologstatesreversed: ["org-log-states-order-reversed", false],
  nologrepeat: ["org-log-repeat", false],
  logreschedule: ["org-log-reschedule", "time"],
  lognotereschedule: ["org-log-reschedule", "note"],
  nologreschedule: ["org-log-reschedule", false],
  logredeadline: ["org-log-redeadline", "time"],
  lognoteredeadline: ["org-log-redeadline", "note"],
  nologredeadline: ["org-log-redeadline", false],
  logrefile: ["org-log-refile", "time"],
  lognoterefile: ["org-log-refile", "note"],
  nologrefile: ["org-log-refile", false],
  odd: ["org-odd-levels-only", true],
  oddeven: ["org-odd-levels-only", false],
};

/** The #+STARTUP: words about footnotes and the variables they set, as org-startup-options has them. */
const STARTUP_FOOTNOTE_OPTIONS: Record<string, [string, e8.Value]> = {
  fninline: ["org-footnote-define-inline", true],
  nofninline: ["org-footnote-define-inline", null],
  fnlocal: ["org-footnote-section", null],
  fnauto: ["org-footnote-auto-label", true],
  fnprompt: ["org-footnote-auto-label", null],
  fnconfirm: ["org-footnote-auto-label", "confirm"],
  fnplain: ["org-footnote-auto-label", "plain"],
  fnadjust: ["org-footnote-auto-adjust", true],
  nofnadjust: ["org-footnote-auto-adjust", null],
  fnanon: ["org-footnote-auto-label", "anonymous"],
};

function logHow(state: string | undefined, previous: string | undefined): string | undefined {
  const logs = logStates();
  return (state === undefined ? undefined : logs.find(([k]) => k === state)?.[1]) ?? (previous === undefined ? undefined : logs.find(([k]) => k === previous)?.[2]);
}

/**
 * A property's value for the heading's entry, inherited as
 * org-entry-get-with-inheritance finds it: the first base value going up
 * from the entry through the headings above it to the drawer before the
 * first heading, with every NAME+ value met on the way after it, or else
 * a #+PROPERTY: line's, org-global-properties' or Org's own, all joined by
 * the property's separator. "nil" is no value unless `literalNil`.
 */
export function entryGetInherited(h: Heading, property: string, literalNil = true): string | undefined {
  // As the element lineage, which reaches the headings above a narrowing.
  return e8.saveRestriction(() => {
    e8.widen();
    return entryGetInheritedWide(h, property, literalNil);
  });
}

function entryGetInheritedWide(h: Heading, property: string, literalNil: boolean): string | undefined {
  let values: string[] = [];
  // Takes an element's values in front of those below it, saying whether it had the base value.
  const take = (local: [string | undefined, string[]] | undefined): boolean => {
    if (local === undefined) return false;
    const [base, extra] = local;
    values = base === undefined ? [...extra, ...values] : [base, ...extra, ...values];
    return base !== undefined;
  };
  const all = headings();
  let found = false;
  let i = headingIndex(all, h.line);
  let level = Infinity;
  for (; i !== undefined && i >= 0; i--) {
    if (all[i]!.level >= level) continue;
    level = all[i]!.level;
    if (take(propertyLocalValues(all[i]!.line, property))) {
      found = true;
      break;
    }
    if (level === 1) break;
  }
  if (!found) found = take(topLocalValues(property));
  if (!found) {
    const global = globalProperty(property);
    if (global !== undefined) values = [global, ...values];
  }
  if (values.length === 0) return undefined;
  const value = values.join(propertySeparator(property));
  return literalNil || value !== "nil" ? value : undefined;
}

/** Values every entry inherits that have no drawer of their own, as org-global-properties-fixed holds them. */
const GLOBAL_PROPERTIES_FIXED: [string, string][] = [
  ["VISIBILITY_ALL", "folded children content all"],
  ["CLOCK_MODELINE_TOTAL_ALL", "current today repeat all auto"],
];

/**
 * A property's value from #+PROPERTY: lines, org-global-properties or
 * Org's fixed ones, the first that has it, as
 * org--property-global-or-keyword-value with literal nil finds it.
 */
function globalProperty(property: string): string | undefined {
  const keyword = keywordProperty(property);
  if (keyword !== undefined) return keyword;
  const key = property.toLowerCase();
  const user = e8.variable("org-global-properties");
  if (Array.isArray(user)) {
    for (const e of user) {
      if (Array.isArray(e) && typeof e[0] === "string" && e[0].toLowerCase() === key) return typeof e[1] === "string" ? e[1] : undefined;
    }
  }
  return GLOBAL_PROPERTIES_FIXED.find(([k]) => k.toLowerCase() === key)?.[1];
}

/**
 * A property's value from #+PROPERTY: lines, as org-keyword-properties
 * collects them: a later line replaces an earlier one, and a NAME+ line
 * adds its value after a space.
 */
function keywordProperty(property: string): string | undefined {
  const key = property.toLowerCase();
  let value: string | undefined;
  e8.saveRestriction(() => {
    e8.widen();
    for (const [line, , text] of e8.matchingLines("^[ \t]*#\\+PROPERTY:", { caseFold: true })) {
      // A name and a value, as org-collect-keywords trims them: a name alone is no property.
      const m = /^[ \t]*#\+PROPERTY:[ \t]*(\S+)[ \t]+(\S.*?)[ \t]*$/i.exec(text);
      if (!m) continue;
      const appending = m[1].endsWith("+");
      if ((appending ? m[1].slice(0, -1) : m[1]).toLowerCase() !== key) continue;
      // A keyword, not a line of a block that looks like one.
      if (elementAt(e8.lineStart(line))?.type !== "keyword") continue;
      value = appending && value !== undefined ? `${value} ${m[2]}` : m[2];
    }
  });
  return value;
}

/**
 * The drawer notes go in, as the org-log-into-drawer function says: the
 * LOG_INTO_DRAWER property of the heading or one above it ("t" for
 * LOGBOOK, "nil" for none, or the drawer's name), else the variable.
 */
export function logDrawer(h?: Heading): string | undefined {
  const p = h === undefined ? undefined : entryGetInherited(h, "LOG_INTO_DRAWER");
  if (p !== undefined) return p === "nil" ? undefined : p === "t" ? "LOGBOOK" : p;
  const v = e8.variable("org-log-into-drawer");
  return v === true ? "LOGBOOK" : typeof v === "string" && v !== "" ? v : undefined;
}

export function allKeywords(): string[] {
  return todoSets().flatMap((s) => [...s.todo, ...s.done]);
}

export function isDone(keyword: string | undefined): boolean {
  return keyword !== undefined && todoSets().some((s) => s.done.includes(keyword));
}

/** The buffer's category, as org-refresh-category-properties sets it: the last #+CATEGORY, or the file's name. */
export function category(): string {
  for (let l = e8.lineCount() - 1; l >= 0; l--) {
    const m = /^[ \t]*#\+CATEGORY:[ \t]*(\S.*?)[ \t]*$/i.exec(e8.lineText(l));
    if (m) return m[1];
  }
  const file = e8.bufferFileName();
  return file ? (file.split("/").pop() ?? file).replace(/\.[^.]*$/, "") : "???";
}

/**
 * Each heading's category, as org-agenda-format-item asks org-get-category
 * for it: inherited, with CATEGORY+ adding to it.
 */
export function categories(all: Heading[]): string[] {
  // As org-get-category, org-entry-get-with-inheritance of CATEGORY: the
  // buffer's own is org-data's, the drawer before the first heading's or
  // else the keyword's or the file's name, and "nil" is none, "???".
  const top = topLocalValues("CATEGORY");
  const data = top?.[0] !== undefined ? [top[0], ...top[1]] : [category(), ...(top?.[1] ?? [])];
  const separator = propertySeparator("CATEGORY");
  const stack: { level: number; values: string[] }[] = [];
  return all.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    const local = propertyLocalValues(h.line, "CATEGORY");
    const parent = stack.length > 0 ? stack[stack.length - 1].values : data;
    const values = local?.[0] !== undefined ? [local[0], ...local[1]] : [...parent, ...(local?.[1] ?? [])];
    stack.push({ level: h.level, values });
    const cat = values.join(separator);
    return cat === "nil" ? "???" : cat;
  });
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

const TAGS = /[ \t](:[\p{L}\p{M}\p{Nd}\p{Nl}_@#%:]+:)[ \t]*$/u;

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
  const tick = e8.bufferCharsModifiedTick();
  let index = headingIndexes.get(name);
  if (!index || index.keywords !== keywordsKey || index.tick !== tick) {
    const sorted = [...keywords].sort((a, b) => b.length - a.length);
    const changes = headingChanges.get(name);
    headingChanges.delete(name);
    // Widened, as a change at a narrowing's end may move headings past it.
    const followed =
      index !== undefined &&
      index.keywords === keywordsKey &&
      changes !== undefined &&
      e8.saveRestriction(() => {
        e8.widen();
        return followChanges(index!, changes, keywords, sorted);
      });
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
 * Whether point is under a heading above the narrowing, with none between:
 * org-back-to-heading finds it, through the element parser, and goes to
 * it, which goto-char stops at the narrowing's start.
 */
function underHeadingAboveNarrowing(): boolean {
  if (e8.pointMin() === 0 || headingIndex(headings(), lineAt()) !== undefined) return false;
  return e8.saveRestriction(() => {
    e8.widen();
    return headingIndex(headings(), lineAt()) !== undefined;
  });
}

/**
 * The region org-copy-subtree takes when point is under a heading above
 * the narrowing: from the narrowing's start, past blank lines, where
 * org-forward-heading-same-level goes, the next heading if none is there,
 * else n - 1 headings on, to the end of that one's subtree, or of the
 * narrowing if there is no heading. And whether the line it starts from
 * ends folded.
 */
function subtreeFromNarrowingStart(n: number): [number, number, boolean] {
  const [min, max] = [e8.pointMin(), e8.pointMax()];
  let q = min;
  while (q < max && /[ \t\r\n]/.test(e8.bufferText(q, q + 1))) q++;
  const folded = e8.invisibleAt(e8.lineEnd(lineAt(q)));
  const all = headings();
  let i = headingIndex(all, lineAt(q));
  if (i === undefined) {
    // As outline-next-heading from before the first heading.
    const k = all.findIndex((h) => h.start > q);
    i = k < 0 ? undefined : k;
  } else for (let k = 1; k < n; k++) i = sibling(all, i, 1) ?? i;
  return [min, i === undefined ? max : Math.min(subtreeRegion(all, i)[1], max), folded];
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
let indirectDedicatedFrame: e8.Frame | undefined;

/** An indirect buffer of `buffer`'s base, named after it and `heading`, as org-get-indirect-buffer. */
function getIndirectBuffer(buffer: e8.Buffer, heading?: string): e8.Buffer {
  const base = e8.bufferBaseBuffer(buffer) ?? buffer;
  const name = e8.generateNewBufferName(`${base.name}${heading === undefined ? "" : `::${heading}`}`);
  return e8.makeIndirectBuffer(base, name, true);
}

/** The window showing `buffer`, if one does. */
function bufferWindow(buffer: e8.Buffer): e8.Window | undefined {
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
    // A frame of its own is titled after the heading, as org-set-frame-title names it.
    if (display === "new-frame" || (arg !== null && display === "dedicated-frame")) {
      e8.setFrameParameter(e8.makeFrame(ibuf), "name", heading);
    } else if (display === "dedicated-frame") {
      if (indirectDedicatedFrame === undefined || !e8.frameList().includes(indirectDedicatedFrame)) {
        indirectDedicatedFrame = e8.makeFrame(ibuf);
      } else {
        e8.selectFrame(indirectDedicatedFrame);
        e8.setWindowBuffer(undefined, ibuf);
      }
      e8.setFrameParameter(indirectDedicatedFrame, "name", `Indirect: ${heading}`);
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
      e8.runHooks("org-cycle-hook", "all");
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
  const drawer = logDrawer(h);
  if (drawer !== undefined) {
    // As org-log-beginning: at the top of the drawer, newest first, made after the entry's metadata if need be.
    const meta = endOfMetaData(h);
    const all = headings();
    const i = headingIndex(all, h.line);
    const end = i === undefined ? e8.bufferSize() : (all[i + 1]?.start ?? e8.bufferSize());
    const opener = new RegExp(`^[ \t]*:${escapeRegExp(drawer)}:[ \t]*$`, "i");
    for (let l = lineAt(meta); l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      if (!opener.test(e8.lineText(l))) continue;
      if (truthy(e8.variable("org-log-states-order-reversed"))) return lineStartOrEnd(l + 1);
      // Oldest first, at the end of the drawer, as org-log-beginning goes to its contents' end.
      for (let k = l + 1; k < e8.lineCount() && e8.lineStart(k) < end; k++) {
        if (/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(k))) return e8.lineStart(k);
      }
      return lineStartOrEnd(l + 1);
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
      // Both lines indented as Org indents them, as org-log-beginning's org-indent-region.
      e8.saveExcursion(() => {
        indentLine(lineAt(at));
        indentLine(lineAt(at) + 1);
      });
      at = e8.lineStart(lineAt(at));
    });
    newDrawerLine = lineAt(at);
    return lineStartOrEnd(lineAt(at) + 1);
  }
  const endpos = endOfMetaData(h);
  let p = endpos;
  while (p < e8.bufferSize() && /[ \t\n]/.test(e8.bufferText(p, p + 1))) p++;
  p = e8.lineStart(lineAt(p));
  // Oldest first, after the state notes already there, as org-skip-over-state-notes,
  // then back over the blank lines after them, as org-log-beginning does.
  if (!truthy(e8.variable("org-log-states-order-reversed"))) {
    p = afterStateNotes(p);
    while (p > 0 && /[ \t\n]/.test(e8.bufferText(p - 1, p))) p--;
    p = lineStartOrEnd(lineAt(p) + 1);
  }
  if (p < endpos) p = endpos;
  return p === e8.lineStart(lineAt(p)) ? p : lineStartOrEnd(lineAt(p) + 1);
}

/**
 * Where the list of state notes starting at `p` ends: the start of the
 * line after the last one's text, as org-skip-over-state-notes and the
 * skip back over blank lines after it in org-log-beginning.
 */
function afterStateNotes(p: number): number {
  const headings = (e8.variable("org-log-note-headings") ?? []) as e8.Value[];
  const entry = headings.find((h) => Array.isArray(h) && h[0] === "state") as e8.Value[] | undefined;
  const format = typeof entry?.[1] === "string" ? entry[1] : "";
  const pattern = escapeRegExp(format)
    .replace(/%-?\d*([tTdDsSuU])/g, (_m, c: string) => ({ t: "\\[[^\\]\n]+\\]", d: "\\[[^\\]\n]+\\]", T: "<[^>\n]+>", D: "<[^>\n]+>", s: '(?:"\\S+")?', S: '(?:"\\S+")?', u: ".*?", U: ".*?" })[c]!)
    .replace(/ +/g, " +");
  const note = new RegExp(`^([ \\t]*)- +${pattern}`);
  let line = lineAt(p);
  let last = -1;
  while (line < e8.lineCount()) {
    const m = note.exec(e8.lineText(line));
    if (!m) break;
    // The item's own lines, indented under its bullet, and blank lines inside it.
    let next = line + 1;
    last = line;
    while (next < e8.lineCount()) {
      const text = e8.lineText(next);
      if (/^[ \t]*$/.test(text)) {
        // Two blank lines end the list, as org-list-end-re.
        if (next + 1 < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(next + 1))) return lineStartOrEnd(last + 1);
        next++;
        continue;
      }
      if (/^[ \t]*/.exec(text)![0].length <= m[1].length) break;
      last = next++;
    }
    line = next;
  }
  return last < 0 ? p : lineStartOrEnd(last + 1);
}

/** Adds a note about a state change to a heading's entry, as org-store-log-note does for a repeating task. */
function storeStateNote(headingLine: number, state: string, previous: string | undefined): void {
  storeLogNote(headingLine, "state", state, previous, []);
}

/**
 * The heading of a logged note, as org-log-note-headings has it for the
 * purpose, with its %-escapes put in: %t the time, %s the new state and
 * %S the old one, quoted, padded where the format says (%-12s).
 */
function logNoteHeading(purpose: string, state: string | undefined, previous: string | undefined, time: string): string {
  const headings = (e8.variable("org-log-note-headings") ?? []) as e8.Value[];
  const entry = headings.find((h) => Array.isArray(h) && h[0] === purpose) as e8.Value[] | undefined;
  const format = typeof entry?.[1] === "string" ? entry[1] : "";
  const quote = (x: string | undefined) => (x === undefined ? "" : /^[<[]\d{4}-/.test(x) ? `"[${x.slice(1, -1)}]"` : `"${x}"`);
  const date = time.replace(/ \d{2}:\d{2}\]$/, "]");
  return format.replace(/%(-?\d*)([tTdDsSuU%])/g, (_m, width: string, c: string) => {
    const value =
      { t: time, T: `<${time.slice(1, -1)}>`, d: date, D: `<${date.slice(1, -1)}>`, s: quote(state), S: quote(previous), u: String(e8.getenv("USER") ?? ""), U: String(e8.variable("user-full-name") ?? ""), "%": "%" }[c] ?? "";
    const w = Number(width || "0");
    return w < 0 ? value.padEnd(-w, " ") : value.padStart(w, " ");
  });
}

/**
 * Logs a note in an entry, at the top of its log (or its LOGBOOK drawer),
 * as org-store-log-note: an item headed as org-log-note-headings says for
 * the purpose, the note's lines after it, the heading then ending in \\\\.
 */
function storeLogNote(
  headingLine: number,
  purpose: string,
  state: string | undefined,
  previous: string | undefined,
  lines: string[],
  time = `[${formatTimestamp(today(true), true)}]`,
  place?: number,
): boolean {
  const h = parseHeading(headingLine);
  if (!h) return false;
  let heading = logNoteHeading(purpose, state, previous, time);
  if (heading.trim() === "" && lines.length === 0) return false;
  const items = [...lines];
  if (heading.trim() !== "") {
    if (lines.length > 0) heading += " \\\\";
    items.unshift(heading);
  }
  const p = marker(e8.point());
  newDrawerLine = undefined;
  withoutFoldChecks(() => {
    // A clock's note right after the clock, as org-store-log-note leaves it; else where the log begins.
    let at = place ?? logBeginning(h, true);
    if (at !== e8.lineStart(lineAt(at))) {
      edInsert(at, "\n");
      at++;
    } else if (/^[ \t]*\S/.test(e8.bufferText(at, e8.lineEnd(lineAt(at))))) {
      edInsert(at, "\n");
    }
    e8.gotoChar(at);
    // In a list, as the notes before it, at its top level; else as any line, as org-store-log-note indents.
    const item = inItem(lineAt(at));
    if (item !== undefined) e8.indentLineTo(listStruct(lineAt(item))[0]!.ind);
    else indentLine(lineAt(at));
    // The bullet as org-list-bullet-string makes it, as org-store-log-note inserts it.
    edInsert(e8.point(), bulletString("-") + items[0]);
    // Each further line under the item's text, as org-list-item-body-column puts it.
    const body = listBodyColumn(e8.lineStart(lineAt()));
    for (const line of items.slice(1)) {
      edInsert(e8.point(), "\n");
      if (line !== "") edInsert(e8.point(), " ".repeat(body) + line);
    }
    if (newDrawerLine !== undefined) toggleDrawerOrBlock(newDrawerLine, true);
    newDrawerLine = undefined;
  });
  e8.gotoChar(p.pos);
  dropMarker(p);
  return true;
}

// Notes taken in *Org Note*, as org-add-log-note and org-store-log-note.

/** The note being taken: where it goes, what for, and what to go back to. */
let pendingNote:
  | { heading: e8.Marker; purpose: string; state?: string; previous?: string; time: string; at?: e8.Marker; returnTo: e8.Marker; windows: e8.WindowConfiguration }
  | undefined;

/** The note set up by the command running, opened once it ends, as org-add-log-setup leaves it for post-command-hook. */
let noteSetup:
  | { heading: e8.Marker; purpose: string; state?: string; previous?: string; time: string; how: string; extra?: string; at?: e8.Marker; point?: e8.Marker; command?: string; depth: number }
  | undefined;

/** How many notes have been set up, so a state change can tell whether its hook set up another, which replaces its own, as org-add-log-setup's one setup. */
let setups = 0;

/** Frees a setup's or a note's markers. */
function freeNoteMarkers(n: { heading: e8.Marker; at?: e8.Marker; returnTo?: e8.Marker; point?: e8.Marker }): void {
  e8.deleteMarker(n.heading);
  if (n.point !== undefined) e8.deleteMarker(n.point);
  if (n.at !== undefined) e8.deleteMarker(n.at);
  if (n.returnTo !== undefined) e8.deleteMarker(n.returnTo);
}

/**
 * Sets up a note about the entry at `headingLine`, taken in *Org Note*
 * once the command ends, as org-add-log-setup: a later setup in the same
 * command replaces it, so over a region the last entry gets the note.
 * With `how` "time" or "state" the note is only its heading, stored then;
 * `extra` goes in *Org Note* after its header, and a note `at` a place,
 * as a clock's, is stored there rather than where the log begins.
 */
export function addLogNote(headingLine: number, purpose: string, state?: string, previous?: string, opts: { how?: string; extra?: string; at?: number } = {}): void {
  setups++;
  if (noteSetup !== undefined) freeNoteMarkers(noteSetup);
  noteSetup = {
    heading: e8.makeMarker(e8.lineStart(headingLine)),
    purpose,
    state,
    previous,
    how: opts.how ?? "note",
    extra: opts.extra,
    at: opts.at === undefined ? undefined : e8.makeMarker(opts.at),
    // Where point was, which the entry's window shows while the note is taken, as org-log-note-marker.
    point: e8.makeMarker(e8.point()),
    time: `[${formatTimestamp(today(true), true)}]`,
    command: e8.thisCommand(),
    depth: e8.recursionDepth(),
  };
  e8.removeHook("post-command-hook", openLogNote);
  e8.addHook("post-command-hook", openLogNote);
}

/** Takes the note the command has set up now, rather than once it ends, as code calls org-add-log-note when org-log-setup is set. */
export function addPendingLogNote(): void {
  if (noteSetup !== undefined) openLogNote();
}

/**
 * Opens *Org Note* for the note set up, as org-add-log-note: the frame
 * showing only the entry's buffer, then split for the note; C-c C-c stores
 * it in the entry's log, C-c C-k cancels it.
 */
function openLogNote(): void {
  const setup = noteSetup;
  // Only after the command that set it up, at its depth, as org-add-log-note checks.
  if (setup !== undefined && (setup.command !== e8.thisCommand() || setup.depth !== e8.recursionDepth())) return;
  e8.removeHook("post-command-hook", openLogNote);
  noteSetup = undefined;
  if (setup === undefined) return;
  const { purpose, state, previous } = setup;
  // Only the heading, stored at once, as org-add-log-note does for time and state.
  if (setup.how === "time" || setup.how === "state") {
    const source = e8.markerBuffer(setup.heading);
    if (source !== undefined) {
      const stored = e8.withCurrentBuffer(source, () =>
        e8.saveRestriction(() => {
          e8.widen();
          const stored = storeLogNote(lineAt(e8.markerPosition(setup.heading)!), purpose, state, previous, [], setup.time, setup.at && e8.markerPosition(setup.at));
          if (stored) e8.runHooks("org-after-note-stored-hook");
          return stored;
        }),
      );
      if (stored) e8.message("Note stored");
    }
    freeNoteMarkers(setup);
    return;
  }
  const windows = e8.currentWindowConfiguration();
  const returnTo = e8.makeMarker(e8.point());
  // A note left open, its buffer killed, is forgotten.
  if (pendingNote !== undefined) freeNoteMarkers(pendingNote);
  pendingNote = { ...setup, returnTo, windows };
  const source = e8.markerBuffer(setup.heading);
  if (source !== undefined) {
    // The entry's buffer alone first, as org-display-buffer-full-frame, so the note shows beside it.
    e8.call("pop-to-buffer", source);
    e8.call("delete-other-windows");
    e8.gotoChar(e8.markerPosition(setup.point ?? setup.heading)!);
  }
  const what =
    {
      "clock-out": "stopped clock",
      done: "closed todo item",
      reschedule: "rescheduling",
      delschedule: "no longer scheduled",
      redeadline: "changing deadline",
      deldeadline: "removing deadline",
      refile: "refiling",
      note: "this entry",
      state: `state change from "${previous ?? ""}" to "${state ?? ""}"`,
    }[purpose] ?? "this entry";
  e8.getBufferCreate("*Org Note*");
  // Below it, as org-display-buffer-split.
  e8.call("split-window-below");
  e8.call("other-window", 1);
  e8.call("switch-to-buffer", "*Org Note*");
  e8.letBind({ "inhibit-read-only": true }, () => e8.deleteRegion(e8.pointMin(), e8.pointMax()));
  e8.letBind({ "org-inhibit-startup": true }, () => e8.call("org-mode"));
  e8.insert(`# Insert note for ${what}.\n# Finish with C-c C-c, or cancel with C-c C-k.\n\n`);
  if (setup.extra !== undefined) e8.insert(setup.extra);
  e8.makeLocalVariable("org-finish-function");
  e8.setVariable("org-finish-function", "org-store-log-note");
  e8.runHooks("org-log-buffer-setup-hook");
}

/** Stores the note *Org Note* holds, unless `abort`, and goes back to where it was asked for, as org-store-log-note. */
function storeNoteFromBuffer(abort: boolean): void {
  const note = pendingNote;
  pendingNote = undefined;
  let text = e8.bufferText(e8.pointMin(), e8.pointMax());
  e8.call("kill-buffer", e8.bufferName());
  if (note === undefined) return;
  while (/^# .*\n[ \t\n]*/.test(text)) text = text.replace(/^# .*\n[ \t\n]*/, "");
  text = text.replace(/\s+$/, "");
  const lines = text === "" ? [] : text.split("\n");
  const source = e8.markerBuffer(note.heading);
  if (!abort && source !== undefined) {
    e8.withCurrentBuffer(source, () =>
      e8.saveRestriction(() => {
        e8.widen();
        storeLogNote(lineAt(e8.markerPosition(note.heading)!), note.purpose, note.state, note.previous, lines, note.time, note.at && e8.markerPosition(note.at));
        e8.runHooks("org-after-note-stored-hook");
      }),
    );
    e8.message("Note stored");
  }
  e8.setWindowConfiguration(note.windows);
  const back = e8.markerBuffer(note.returnTo);
  if (back !== undefined) e8.withCurrentBuffer(back, () => e8.gotoChar(e8.markerPosition(note.returnTo)!));
  freeNoteMarkers(note);
}
e8.defun("org-store-log-note", () => storeNoteFromBuffer(truthy(e8.variable("org-note-abort"))));

e8.defineCommand({
  name: "org-add-note",
  doc: "Add a note to the current entry.\nThis is done in the same way as adding a state change note.",
  run: () => {
    const [all, i] = backToHeading();
    addLogNote(all[i].line, "note");
  },
});

/** Shows a heading's line, from the end of the line before it within the narrowing, as org-fold-heading. */
function showHeadingInNarrowing(h: Heading): void {
  flag(h.line > 0 ? Math.max(e8.pointMin(), e8.lineEnd(h.line - 1)) : h.start, h.end, false);
}

/**
 * Hides the text above the first heading in the narrowing, as
 * org-fold-flag-above-first-heading: from the buffer's very start, as its
 * folds take positions in the whole buffer; nothing if the narrowing
 * starts with a heading. Gives where the first heading starts, or the end.
 */
function flagAboveFirstHeading(): number {
  const first = headings().find((h) => h.start >= e8.pointMin() && h.start < e8.pointMax());
  const to = first ? first.start : e8.pointMax();
  if (to > e8.pointMin()) flag(0, to - 1, true);
  return to;
}

/**
 * Hides everything but the headings of the top LEVELS levels, as
 * org-fold-hide-sublevels: from the first heading to the end, the last
 * empty line left showing.
 */
function hideSublevels(levels: number): void {
  if (levels < 1) throw new Error("Must keep at least one level of headers");
  e8.saveExcursion(() => {
    const all = headings().filter((h) => h.start >= e8.pointMin() && h.start < e8.pointMax());
    let beg = all[0]?.start ?? e8.pointMax();
    const max = e8.pointMax();
    let end = Math.max(e8.pointMin(), max > e8.pointMin() && max === e8.lineStart(lineAt(max)) ? max - 1 : max);
    if (end < beg) [beg, end] = [end, beg];
    flag(beg, end, true);
    // Each heading of those levels shown, from the end of the line before it, as org-fold-heading.
    for (const h of all) {
      if (h.start < beg || h.start > end || h.level > levels) continue;
      showHeadingInNarrowing(h);
    }
    if (max > e8.pointMin() && max === e8.lineStart(lineAt(max)) && e8.invisibleAt(max - 1)) flag(max - 1, max, false);
  });
}

e8.defineCommand({
  name: "org-fold-hide-sublevels",
  doc: "Hide everything but the headings of the top levels: as many as the prefix argument says, or the heading point is on's level, or 1.",
  params: [{ name: "levels", kind: "prefix" }],
  run: (levels: e8.PrefixArg) => {
    const h = parseHeading(lineAt());
    hideSublevels(levels !== null && levels !== undefined ? e8.prefixNumericValue() : h ? h.level : 1);
  },
});

/** The heading point is under, as org-back-to-heading finds it, within the narrowing. */
function headingAbove(): { all: Heading[]; i: number } | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined || all[i].start < e8.pointMin() ? undefined : { all, i };
}

/** Where the subtree of heading i ends, as org-end-of-subtree with TO-HEADING: the next heading at its level or above, or the narrowing's end. */
function subtreeEndHere(all: Heading[], i: number): number {
  return Math.min(subtreeRegion(all, i)[1], e8.pointMax());
}

/** Folds the subtree point is under after its heading's line, as org-fold-hide-subtree. */
function hideSubtreeHere(): void {
  const found = headingAbove();
  if (!found) e8.userError("Before first heading");
  const { all, i } = found!;
  const end = subtreeEndHere(all, i);
  flag(all[i].end, end === e8.pointMax() ? end : end - 1, true);
}

/**
 * Shows the subheadings of the heading point is under down to LEVEL levels
 * below it, and the first child however deep, as org-fold-show-children.
 */
function showChildrenHere(level: number): void {
  const found = headingAbove();
  if (!found) return;
  const { all, i } = found;
  const parent = all[i];
  const maxLevel = validLevel(parent.level, level);
  const end = subtreeEndHere(all, i);
  const show = showHeadingInNarrowing;
  show(parent);
  let minDirect = Infinity;
  for (let j = i + 1; j < all.length && all[j].start < end; j++) {
    const h = all[j];
    // Until the first child, any level at or below the parent's; then up to the deeper of it and LEVEL below.
    const upper = minDirect === Infinity ? Infinity : Math.max(minDirect, maxLevel);
    if (h.level < parent.level || h.level > upper) continue;
    if (h.level < minDirect) minDirect = h.level;
    show(h);
  }
}

e8.defineCommand({
  name: "org-ctrl-c-tab",
  doc:
    "C-c TAB in Org: in a table, shrink or widen its columns; before the first heading, hide the text there and show the headings " +
    "of as many levels as the prefix argument says; else fold the subtree and show its children, that many levels of them.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    if (atTableP()) e8.userError("E8 cannot shrink a table's columns yet");
    const all = headings();
    const first = all.find((h) => h.start >= e8.pointMin());
    if (!first || e8.point() < first.start) {
      e8.saveExcursion(() => {
        flagAboveFirstHeading();
        hideSublevels(arg);
      });
      return;
    }
    hideSubtreeHere();
    showChildrenHere(arg);
  },
});

e8.defineCommand({
  name: "org-kill-note-or-show-branches",
  doc: "Abort storing current note, or show just branches.",
  run: () => {
    if (truthy(e8.variable("org-finish-function"))) {
      e8.letBind({ "org-note-abort": true }, () => e8.funcall(e8.variable("org-finish-function") as string));
    } else if (headings().every((h) => h.start > e8.point())) {
      // Before the first heading, every heading in the buffer, as org-fold-show-branches-buffer:
      // the text above them hidden, then each top heading's branches shown.
      const first = flagAboveFirstHeading();
      hideSublevels(1);
      if (first < e8.pointMax()) {
        e8.gotoChar(first);
        for (;;) {
          showChildrenHere(1000);
          const all = headings();
          const i = headingIndex(all, lineAt());
          const next = i === undefined ? undefined : nextSameOrHigher(all, i);
          if (!next || next.level !== all[i!].level || next.start >= e8.pointMax()) break;
          e8.gotoChar(next.start);
        }
      }
      e8.gotoChar(e8.pointMin());
    } else {
      // The subtree folded, then its headings shown, as org-fold-hide-subtree and org-fold-show-branches.
      e8.call("outline-hide-subtree");
      e8.call("outline-show-branches");
    }
  },
});

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
    // Within the accessible text, as Emacs's searches are bounded by it.
    const [min, max] = [e8.pointMin(), e8.pointMax()];
    const previousHeading = (pos: number) => Math.max(min, all.filter((h) => h.start + h.level + 1 <= pos).at(-1)?.start ?? 0);
    const nextHeading = (pos: number) => Math.min(max, all.find((h) => h.start > pos)?.start ?? max);
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
        if (cs < start || cs >= end || cs + charCount(m[0]) > max) continue;
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
    if (truthy(e8.variable("org-auto-align-tags") ?? true) && parseHeading(line)?.tagsAt !== undefined) alignTagsAway(line);
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
    // As org-update-statistics-cookies looks for them: no lettered bullets or counters, whatever org-list-allow-alphabetical says.
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

/** The item a line starts, by org-item-re, lettered bullets taken as the setting says or, for fontifying, always, as org-list-full-item-re takes them. */
function parseItem(line: number, lettered = alphabetical()): Item | undefined {
  if (line < 0 || line >= e8.lineCount()) return undefined;
  const text = e8.lineText(line);
  const m = (lettered ? ITEM_GROUPS.lettered : ITEM_GROUPS.numbered).exec(text);
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

/**
 * A heading's level face, as org-get-level-face picks it: by its level
 * reduced with org-odd-levels-only, in turn with org-cycle-level-faces, else
 * the last of org-n-level-faces for every level past it.
 */
export function levelFace(level: number): string {
  const l = e8.variable("org-odd-levels-only") === true ? 1 + Math.floor(level / 2) : level;
  const n = Math.max(1, Math.min(8, Number(e8.variable("org-n-level-faces") ?? 8) || 8));
  return `org-level-${truthy(e8.variable("org-cycle-level-faces") ?? true) ? ((l - 1) % n) + 1 : Math.min(l, n)}`;
}

function fontifyHeading(h: Heading, text: string): void {
  e8.putTextProperty(h.start, h.end, "face", levelFace(h.level));
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

const KEYWORD = /^([ \t]*#\+(\w+):)(.*)$/;

/**
 * The face org-src-block-faces gives a language's blocks, its name matched
 * ignoring case, "" for blocks with none: a face's name if there is such a
 * face, or an anonymous face, a list of attributes.
 */
function srcBlockFace(lang: string): e8.Value | undefined {
  const alist = e8.variable("org-src-block-faces");
  if (!Array.isArray(alist)) return undefined;
  const entry = alist.find((e) => Array.isArray(e) && typeof e[0] === "string" && e[0].toLowerCase() === lang.toLowerCase()) as e8.Value[] | undefined;
  const face = entry?.[1];
  if (typeof face === "string") return e8.facep(face) ? face : undefined;
  return Array.isArray(face) && face.length > 0 ? face : undefined;
}

/** A block's #+begin_ line as Org's fontification reads it: its type, letters only, and its language, the word after, "" for none. */
const BLOCK_BEGIN_LINE = /^[ \t]*#\+begin_([a-zA-Z]+)[ \t]*(\S*)/i;

/**
 * Where the block whose #+begin_ line is BEGIN ends, as Org's
 * fontification looks for it: the first line after that is #+end_ and the
 * block's type, or a heading, which ends it too. Undefined when there is
 * neither, and Org gives the block no faces at all.
 */
function blockEndFrom(begin: number, type: string): { line: number; heading: boolean } | undefined {
  const end = new RegExp(`^[ \\t]*#\\+end_${escapeRegExp(type)}(?![\\p{L}\\p{N}_])`, "iu");
  for (let l = begin + 1; l < e8.lineCount(); l++) {
    const text = e8.lineText(l);
    if (/^\*+(?:\s|$)/.test(text)) return { line: l, heading: true };
    if (end.test(text)) return { line: l, heading: false };
  }
  return undefined;
}

/** A block as fontify styles it: its #+begin_ line, type, language, where it ends, and how its text is styled. */
interface FontBlock {
  begin: number;
  type: string;
  lang: string;
  end: { line: number; heading: boolean };
  /** native: in its language's mode, as org-src-fontify-natively says; protected: org-block, as a protecting block; quote and verse: their faces; none: as Org text. */
  kind: "native" | "protected" | "quote" | "verse" | "none";
}

/** The blocks whose text Org leaves alone, as org-protecting-blocks. */
function protectingBlocks(): string[] {
  const v = e8.variable("org-protecting-blocks");
  return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : ["src", "example", "export"];
}

/** The block starting on line BEGIN, if it is one that ends, as Org's fontification sorts it. */
function fontBlock(begin: number): FontBlock | undefined {
  const m = BLOCK_BEGIN_LINE.exec(e8.lineText(begin));
  if (!m) return undefined;
  const type = m[1].toLowerCase();
  const end = blockEndFrom(begin, type);
  if (end === undefined) return undefined;
  const quoteAndVerse = truthy(e8.variable("org-fontify-quote-and-verse-blocks") ?? null);
  const kind: FontBlock["kind"] =
    truthy(e8.variable("org-src-fontify-natively") ?? null) && (type === "src" || type === "example")
      ? "native"
      : protectingBlocks().includes(type)
        ? "protected"
        : quoteAndVerse && type === "quote"
          ? "quote"
          : quoteAndVerse && type === "verse"
            ? "verse"
            : "none";
  return { begin, type, lang: m[2], end, kind };
}

/**
 * The block the line is inside, if any, as Org's fontification has found
 * it from the heading above: blocks that end, one after another, a
 * heading ending any.
 */
function enclosingBlock(line: number): FontBlock | undefined {
  if (line <= 0) return undefined;
  let l = line - 1;
  while (l > 0 && !/^\*+(?:\s|$)/.test(e8.lineText(l))) l--;
  for (; l < line; l++) {
    const block = fontBlock(l);
    if (!block) continue;
    if (block.end.line >= line) return block;
    l = block.end.heading ? block.end.line - 1 : block.end.line;
  }
  return undefined;
}

/**
 * Fontifies a source or example block's text as its language's mode
 * would, as org-src-font-lock-fontify-block: from the end of its #+begin_
 * line to the start of the line that ends it, its faces taken off first,
 * whether its language has a mode or not, then the face
 * org-src-block-faces gives its language and org-block appended.
 */
function fontifyNatively(block: FontBlock): void {
  const [start, end] = [e8.lineEnd(block.begin), e8.lineStart(block.end.line)];
  if (end <= start) return;
  e8.removeTextProperty(start, end, "face");
  if (block.lang !== "" && e8.fboundp("org-src-font-lock-fontify-block")) e8.funcall("org-src-font-lock-fontify-block", block.lang, start, end);
  const src = srcBlockFace(block.lang);
  if (src !== undefined) e8.addFaceTextProperty(start, end, src as string, { append: true });
  e8.addFaceTextProperty(start, end, "org-block", { append: true });
}

/**
 * The face org-block-LANG, when there is one, which a protecting block's
 * text inherits before org-block, as Org's fontification gives it.
 */
function protectedLangFace(lang: string): string | undefined {
  const name = `org-block-${lang}`;
  return e8.facep(name) ? name : undefined;
}

/** A block's #+begin_ line's face, put over what is there, as Org's add-text-properties does after fontifying the block. */
function beginLineFace(line: number): void {
  const ls = e8.lineStart(line);
  const to = delimiterEnd(e8.lineEnd(line));
  if (to > ls) e8.putTextProperty(ls, to, "face", "org-block-begin-line");
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
  let block = enclosingBlock(first);
  let firstLine = first;
  // In a block fontified natively: all of it, from its #+begin_ line, as Org does.
  if (block?.kind === "native") {
    fontifyNatively(block);
    beginLineFace(block.begin);
    firstLine = block.end.line;
  }
  for (let line = firstLine; line < e8.lineCount() && e8.lineStart(line) < Math.max(end, from + 1); line++) {
    const text = e8.lineText(line);
    const ls = e8.lineStart(line);
    const le = e8.lineEnd(line);
    if (block !== undefined) {
      if (line === block.end.line) {
        const ended = block;
        block = undefined;
        // The #+end_ line, put over what is there; a heading that ends a block is a heading.
        if (!ended.end.heading) {
          const to = delimiterEnd(le);
          if (to > ls) e8.putTextProperty(ls, to, "face", "org-block-end-line");
          continue;
        }
      } else {
        // Each face takes the newline too, as Org's does, so a background
        // with :extend goes on to the window's edge.
        const nl = Math.min(le + 1, e8.pointMax());
        if (block.kind === "protected") {
          face(ls, nl, "org-block");
          const lang = protectedLangFace(block.lang);
          if (lang !== undefined) face(ls, nl, lang);
          continue;
        }
        // Quote and verse blocks' text in their faces, and any block's but a protecting one's fontified as Org text too.
        if (block.kind === "quote" || block.kind === "verse") face(ls, nl, `org-${block.kind}`);
      }
    }
    if (block === undefined) {
      const begun = fontBlock(line);
      if (begun) {
        block = begun;
        if (begun.kind === "native") {
          fontifyNatively(begun);
          line = begun.end.line - 1;
        }
        beginLineFace(begun.begin);
        continue;
      }
      // A #+begin_ line whose block does not end has no face, as in Org.
      if (BLOCK_BEGIN_LINE.test(text)) continue;
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
    const item = parseItem(line, true);
    let objectsFrom = 0;
    if (item) {
      if (item.checkboxAt !== undefined) face(item.checkboxAt, item.checkboxAt + 3, "org-checkbox");
      const term = /^(.*?)[ \t]+::(?:[ \t]|$)/.exec(text.slice(indexOf(line, text, item.contentAt)));
      // Only an unordered item's term, as Org's font-lock has it.
      if (term && !/^[0-9A-Za-z]/.test(item.bullet)) {
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
  // Past the bullet and a space, or two where org-list-two-spaces-after-bullet-regexp matches, as org-list-item-body-column.
  return m ? e8.stringWidth(m[0].replace(/\t/g, "        ")) + (twoSpacesAfter(m[1]) ? 2 : 1) : 0;
}

// Filling

/**
 * The prefix the line at point takes when it is filled, or undefined
 * where Org fills nothing, as org-adaptive-fill-function: headings,
 * tables, keywords, drawers and blocks other than comment blocks are
 * never filled; paragraphs keep their indentation, or line up under an
 * item's text, comments go on as comments.
 */
function adaptiveFillPrefix(): string | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const line = lineAt();
    if (parseHeading(line) !== undefined) return undefined;
    const p = e8.lineStart(line);
    const el = elementAt(p);
    if (el === undefined) return undefined;
    const indentation = (l: number) => /^[ \t]*/.exec(e8.lineText(l))![0];
    switch (el.type) {
      case "comment":
        return indentation(line) + "# ";
      case "footnote-definition":
        return "";
      case "item":
      case "plain-list":
        return " ".repeat(listBodyColumn(el.begin));
      case "paragraph": {
        if (el.parent?.type === "item") return " ".repeat(listBodyColumn(el.parent.begin));
        // With adaptive-fill-function off, so fill-context-prefix uses the regexp, as Org binds it.
        const context =
          typeof e8.variable("adaptive-fill-regexp") === "string"
            ? e8.letBind({ "adaptive-fill-function": null }, () => fillContextPrefix(el.begin, el.end))
            : undefined;
        return context ?? indentation(line);
      }
      case "comment-block": {
        // Only its contents, between the #+BEGIN and #+END lines.
        if (line <= lineAt(el.begin) || line >= lineAt(endBeforeBlank(el))) return undefined;
        return indentation(line);
      }
      default:
        return undefined;
    }
  });
}

e8.defineCommand({
  name: "org-auto-fill-function",
  doc: "Break the line past fill-column as Auto Fill does, but only where Org fills: never in a heading, a table, a keyword or a block.",
  run: () => {
    const fc = e8.variable("fill-column");
    if (typeof fc !== "number" || e8.currentColumn() <= fc) return;
    const prefix = adaptiveFillPrefix();
    if (prefix === undefined) return;
    // An empty prefix is kept as it is rather than worked out again.
    e8.letBind({ "fill-prefix": prefix, "adaptive-fill-mode": prefix !== "" ? true : null }, () => e8.call("do-auto-fill"));
  },
});

/**
 * Fills from `beg` to `end` as one paragraph, its lines taking the prefix
 * org-adaptive-fill-function gives at its second line (or its first), as
 * fill-region-as-paragraph does with adaptive-fill-function set to it.
 */
function fillAsParagraph(beg: number, end: number, justify: string | undefined): void {
  const prefix = e8.saveExcursion(() => {
    e8.gotoChar(beg);
    // The second line's, if it starts before END, as fill-context-prefix takes TO as exclusive.
    if (lineAt() + 1 < e8.lineCount() && e8.lineStart(lineAt() + 1) < end) e8.gotoChar(e8.lineStart(lineAt() + 1));
    return adaptiveFillPrefix();
  });
  // An empty prefix is kept as it is rather than worked out again, as for Auto Fill.
  e8.letBind({ "fill-prefix": prefix ?? null, "adaptive-fill-mode": prefix === undefined || prefix !== "" ? true : null }, () => fillRegionAsParagraph(beg, end, justify));
}

/**
 * Fills the element at point where Org fills, as org-fill-element: a
 * paragraph, cut at its line breaks (\\\\ at a line's end); a comment's
 * lines between blank comment lines; a comment block's paragraph; and a
 * table, which is aligned instead. A plain list, an item or a footnote
 * definition fill their first paragraph. Anything else is left alone.
 */
function orgFillElement(justify: string | undefined): void {
  const element = e8.saveExcursion(() => {
    e8.gotoChar(e8.lineEnd(lineAt()));
    // An affiliated keyword belongs to the element after it, as org-element-at-point has it.
    while (AFFILIATED.test(e8.lineText(lineAt())) && lineAt() + 1 < e8.lineCount()) e8.gotoChar(e8.lineEnd(lineAt() + 1));
    return elementAt(e8.point());
  });
  if (element === undefined) return;
  const lineEndHere = e8.lineEnd(lineAt());
  switch (element.type) {
    // In the block's own mode, as org-babel-do-in-edit-buffer fills it.
    case "src-block":
      if (e8.fboundp("org-src--fill-paragraph")) e8.funcall("org-src--fill-paragraph", justify ?? null);
      return;
    case "table":
    case "table-row":
      // A table.el table is left as it is.
      if (element.type === "table" && element.tableType === "table.el") return;
      e8.saveExcursion(() => {
        e8.gotoChar(element.begin);
        e8.call("org-table-align");
      });
      return;
    case "paragraph": {
      const beg = Math.max(e8.pointMin(), element.contentsBegin ?? element.begin);
      let end = Math.min(e8.pointMax(), element.contentsEnd ?? endBeforeBlank(element));
      // At an affiliated keyword, nothing.
      if (lineEndHere < beg) return;
      e8.saveExcursion(() => {
        const cuts = [beg];
        const text = e8.bufferText(beg, end);
        // Verbatim and code, where a \\\\ is no line break, over at most two lines, as Org's emphasis.
        const literal = allMatches(/(^|[-\s('"{])([=~])(\S|\S[^]*?\S)\2(?=[-\s.,:!?;'")}[\]]|$)/g, text)
          .filter((m) => (m[3]!.match(/\n/g) ?? []).length <= 1)
          .map((m) => [m.index + m[1]!.length, m.index + m[0].length] as const);
        for (const m of allMatches(/(?<!\\)\\\\[ \t]*\n/g, text)) {
          if (literal.some(([a, b]) => a < m.index && m.index < b)) continue;
          cuts.push(beg + [...text.slice(0, m.index + m[0].length)].length);
        }
        for (const c of cuts.filter((c) => c !== end).reverse()) {
          fillAsParagraph(c, end, justify);
          end = c;
        }
      });
      return;
    }
    case "comment-block": {
      const beg = e8.saveExcursion(() => {
        e8.gotoChar(element.begin);
        e8.reSearchForward("^[ \t]*#\\+begin_comment", { noerror: true, caseFold: true });
        return e8.lineStart(lineAt() + 1);
      });
      const end = e8.saveExcursion(() => {
        e8.gotoChar(element.end);
        e8.reSearchBackward("^[ \t]*#\\+end_comment", { noerror: true, caseFold: true });
        return e8.lineStart(lineAt());
      });
      if (e8.point() < beg || e8.point() > end) return;
      const from = e8.saveExcursion(() => {
        e8.gotoChar(e8.lineEnd(lineAt()));
        if (e8.reSearchBackward("^[ \t]*$", { bound: beg, noerror: true }) === undefined) e8.gotoChar(beg);
        return e8.lineStart(lineAt());
      });
      const to = e8.saveExcursion(() => {
        e8.gotoChar(e8.lineStart(lineAt()));
        if (e8.reSearchForward("^[ \t]*$", { bound: end, noerror: true }) === undefined) e8.gotoChar(end);
        return e8.lineStart(lineAt());
      });
      e8.saveExcursion(() => fillAsParagraph(from, to, justify));
      return;
    }
    case "comment": {
      const begin = element.begin;
      const elementEnd = element.end;
      if (e8.point() < begin || e8.point() > elementEnd) return;
      const from = e8.saveExcursion(() => {
        e8.gotoChar(e8.lineEnd(lineAt()));
        return e8.reSearchBackward("^[ \t]*#[ \t]*$", { bound: begin, noerror: true }) !== undefined ? e8.lineStart(lineAt() + 1) : begin;
      });
      const to = e8.saveExcursion(() => {
        e8.gotoChar(e8.lineEnd(lineAt()));
        if (e8.reSearchForward("^[ \t]*#[ \t]*$", { bound: elementEnd, noerror: true }) !== undefined) return e8.lineStart(lineAt()) - 1;
        e8.gotoChar(elementEnd);
        e8.skipCharsBackward(" \r\t\n");
        return e8.lineEnd(lineAt());
      });
      // Not at a blank comment line.
      if (to <= from) return;
      const prefix = e8.saveExcursion(() => {
        e8.gotoChar(e8.lineStart(lineAt()));
        e8.lookingAt("[ \t]*#");
        const comment = e8.bufferSubstringNoProperties(e8.matchBeginning(0)!, e8.matchEnd(0)!);
        e8.gotoChar(e8.matchEnd(0)!);
        const re = e8.variable("adaptive-fill-regexp");
        return typeof re === "string" && e8.lookingAt(re) ? comment + e8.bufferSubstringNoProperties(e8.matchBeginning(0)!, e8.matchEnd(0)!) : `${comment} `;
      });
      e8.saveExcursion(() => e8.letBind({ "fill-prefix": prefix }, () => fillRegionAsParagraph(from, to, justify)));
      return;
    }
    default:
      return;
  }
}

/**
 * Fills the element at point, or each element in the active region, as
 * org-fill-paragraph: paragraphs, comments and comment blocks are filled,
 * a table is aligned, and headings, keywords, drawers and blocks are left
 * alone. With a prefix argument, justifies too. A buffer unmodified
 * before stays so if nothing changed.
 */
function orgFillParagraph(justify: string | undefined, region: boolean): void {
  const before = e8.bufferModifiedP() ? undefined : e8.bufferText(e8.pointMin(), e8.pointMax());
  const mark = e8.mark();
  // Transient Mark mode is always on in E8, so an active region is enough.
  if (region && e8.regionActive() && mark !== undefined && mark !== e8.point()) {
    const start = Math.min(mark, e8.point());
    const origin = e8.makeMarker(e8.point());
    try {
      e8.gotoChar(Math.max(mark, e8.point()));
      e8.skipCharsBackward(" \t\n");
      while (e8.point() > start) {
        // On a drawer's or block's closing line, into what it holds first, as org-backward-paragraph goes, so its paragraphs are filled.
        const closing = lineAt();
        const holder = elementAt(e8.lineStart(closing));
        if (
          holder !== undefined &&
          // A dynamic block's #+END: too, as Org goes into one.
          /^[ \t]*(?::END:|#\+end(?:_\S+|:))[ \t]*$/i.test(e8.lineText(closing)) &&
          holder.begin < e8.lineStart(closing) &&
          lineAt(holder.begin) + 1 < closing
        ) {
          e8.gotoChar(e8.lineEnd(closing - 1));
          e8.skipCharsBackward(" \t\n");
          continue;
        }
        orgFillElement(justify);
        // Back to the start of the element, as org-backward-paragraph goes, so a
        // comment's blank # lines and its other paragraphs are passed over; in a
        // comment block, to the start of its paragraph, its others filled in turn.
        const el = elementAt(e8.lineStart(lineAt()));
        if (el?.type === "comment-block" && lineAt() > lineAt(el.begin)) {
          let l = lineAt();
          while (l - 1 > lineAt(el.begin) && !/^[ \t]*$/.test(e8.lineText(l - 1))) l--;
          e8.gotoChar(e8.lineStart(l));
        } else e8.gotoChar(Math.max(start, el?.begin ?? e8.lineStart(lineAt())));
        e8.gotoChar(e8.lineStart(lineAt()));
        e8.skipCharsBackward(" \t\n");
      }
    } finally {
      e8.gotoChar(e8.markerPosition(origin)!);
      e8.deleteMarker(origin);
    }
  } else {
    e8.saveExcursion(() => {
      // On a blank line, from the next element, as org-match-line tests the whole line.
      if (/^[ \t]*$/.test(e8.lineText(lineAt()))) e8.skipCharsForward(" \t\n");
      orgFillElement(justify);
    });
  }
  if (before !== undefined && before === e8.bufferText(e8.pointMin(), e8.pointMax())) e8.setBufferModified(false);
}

e8.defineCommand({
  name: "org-fill-paragraph",
  barfIfReadOnly: true,
  doc:
    "Fill element at point, when applicable.\n\nThis function only applies to comment blocks, comments, example blocks and paragraphs. " +
    "Also, as a special case, re-align table when point is at one. With a prefix argument, justify as well. " +
    "With the region active, fill each of the elements in it.",
  params: [{ name: "justify", kind: "prefix" }],
  run: (justify: e8.PrefixArg) => {
    barfIfBufferReadOnly();
    // As a command it fills the region, as Emacs's interactive spec passes REGION t.
    orgFillParagraph(justify === null ? undefined : "full", true);
  },
});
/** Where an Org element starts, as org-element-paragraph-separate without its ^: Emacs 30.2's value in org-mode. */
const ORG_PARAGRAPH_START =
  "\\(?:\\*+ \\|\\[fn:[-_[:word:]]+\\]\\|%%(\\|[ \t]*\\(?:$\\||\\|\\+\\(?:-+\\+\\)+[ \t]*$\\|#\\(?: \\|$\\|\\+\\(?:BEGIN_\\S-+\\|\\S-+\\(?:\\[.*\\]\\)?:[ \t]*\\)\\)\\|:\\(?: \\|$\\|[-_[:word:]]+:[ \t]*$\\)\\|-\\{5,\\}[ \t]*$\\|\\\\begin{\\([A-Za-z0-9*]+\\)}\\|\\(?:^[\t ]*CLOCK:\\(?:[\t ]+\\(?:\\[\\([[:digit:]]\\{4\\}-[[:digit:]]\\{2\\}-[[:digit:]]\\{2\\}\\(?: .*?\\)?\\)\\]\\)\\(?:--\\(?:\\[\\([[:digit:]]\\{4\\}-[[:digit:]]\\{2\\}-[[:digit:]]\\{2\\}\\(?: .*?\\)?\\)\\]\\)[\t ]+=>[\t ]+[[:digit:]]+:[[:digit:]][[:digit:]]\\)?\\|[\t ]+=>[\t ]+[[:digit:]]+:[[:digit:]][[:digit:]]\\)[\t ]*$\\)\\|\\(?:[-+*]\\|\\(?:[0-9]+\\)[.)]\\)\\(?:[ \t]\\|$\\)\\)\\)";

/** A line break here would make an Org line break, \\\\ at a line's end, as org-fill-line-break-nobreak-p. */
e8.defun("org-fill-line-break-nobreak-p", () =>
  e8.saveExcursion(() => {
    e8.skipCharsBackward(" \t");
    e8.skipCharsBackward("\\\\");
    return e8.lookingAt("\\\\\\\\\\($\\|[^\\]\\)");
  }),
);
/** A line break here would make a {{{n}}} macro an item, as org-fill-n-macro-as-item-nobreak-p. */
e8.defun("org-fill-n-macro-as-item-nobreak-p", () => e8.lookingAt("[ \t]*{{{n\\(?:([^\n)]*)\\)?}}}[.)]\\(?:$\\| \\)"));
/** A line break here would split a timestamp, as org-fill-paragraph-with-timestamp-nobreak-p. */
e8.defun("org-fill-paragraph-with-timestamp-nobreak-p", () => {
  const p = e8.point();
  return tsMatches(lineAt()).some((ts) => ts.start < p && p <= ts.end);
});

const GREATER_ELEMENTS = ["center-block", "drawer", "dynamic-block", "footnote-definition", "headline", "item", "plain-list", "property-drawer", "quote-block", "section", "special-block", "table"];

/**
 * The column text under the heading `line` is in starts at, as
 * org-adapt-indentation says: one past its stars when set, else 0.
 */
export function adaptColumn(line: number): number {
  if (!truthy(e8.variable("org-adapt-indentation"))) return 0;
  const all = headings();
  const i = headingIndex(all, line);
  return i === undefined ? 0 : all[i].level + 1;
}

/**
 * Whether the element at `pos` is a heading's data, as
 * org--at-headline-data-p says: its planning line, property drawer, the
 * drawer notes go in, or a clock line right after the heading or its data.
 */
function atHeadlineData(pos: number, el: Elem | undefined = elementAt(pos)): boolean {
  if (!el || el.type === "headline") return false;
  // Only inside a heading.
  let up = el.parent;
  while (up && up.type !== "headline") up = up.parent;
  if (!up) return false;
  let top: Elem = el;
  while (top.parent && top.parent.type !== "section") top = top.parent;
  if (top.type === "planning" || top.type === "property-drawer") return true;
  const text = e8.lineText(lineAt(top.begin));
  const drawer = top.type === "drawer" ? /^[ \t]*:((?:\w|[-_])+):[ \t]*$/.exec(text) : null;
  if (drawer) {
    const all = headings();
    const i = headingIndex(all, lineAt(pos));
    return drawer[1] === logDrawer(i === undefined ? undefined : all[i]);
  }
  if (top.type === "clock" && top.begin > 0) return isHeadingLine(e8.lineText(lineAt(top.begin - 1))) || atHeadlineData(top.begin - 1);
  return false;
}

/**
 * The column Org expects a line to start at, given the element it is in, as
 * org--get-expected-indentation works it out: with the buffer widened, so
 * a narrowing that starts inside an item still lines up with its text.
 */
function expectedIndent(el: Elem | undefined, contentsp: boolean, line: number): number {
  return e8.saveRestriction(() => {
    e8.widen();
    return expectedIndentWide(el, contentsp, line);
  });
}

/** Affiliated keywords, as org-element-affiliated-keywords and ATTR_ ones: they belong to the element after them. */
const AFFILIATED_KEYWORD = /^[ \t]*#\+(?:caption|data|header|headers|label|name|plot|resname|result|results|source|srcname|tblname|attr_[-_\w]+)(?:\[[^\]\n]*\])?:/i;

/** Where an element starting at BEGIN starts with its affiliated keywords, the lines of them right before it. */
function affiliatedBegin(begin: number): number {
  let line = lineAt(begin);
  while (line > 0 && AFFILIATED_KEYWORD.test(e8.lineText(line - 1))) line--;
  return e8.lineStart(line);
}

function expectedIndentWide(el: Elem | undefined, contentsp: boolean, line: number): number {
  const type = el?.type;
  const indentOf = (pos: number): number => textIndentation(e8.lineText(lineAt(pos)));
  if (contentsp) {
    if (type === "section") return expectedIndentWide(el?.parent, true, line);
    if (type === "footnote-definition" || type === "diary-sexp") return 0;
    // One past the stars with org-adapt-indentation, else the margin.
    if (type === undefined || type === "headline") return adaptColumn(line);
    if (type === "item" || type === "plain-list") return listBodyColumn((el as Elem).begin);
    // From its first affiliated keyword, as Org's element begins there.
    return indentOf(affiliatedBegin((el as Elem).begin));
  }
  if (!el || type === "headline" || type === "org-data") return isBlank(e8.lineText(line)) ? expectedIndentWide(el, true, line) : 0;
  if (type === "footnote-definition" || type === "diary-sexp") return 0;
  const bol = e8.lineStart(line);
  const start = el.begin;
  if (bol < start) return expectedIndentWide(el.parent, true, line);
  if (bol === start) {
    // Like the element before, passing over footnote definitions, as Org ignores them there.
    for (let from = start; ; ) {
      if (from === 0) return 0;
      let previous = elementAt(from - 1);
      for (let parent = previous; parent && parent.end <= from; parent = parent.parent) previous = parent;
      if (!previous || previous.type === "org-data") return 0;
      if (previous.end > from) return expectedIndentWide(previous, true, line);
      if (previous.type === "footnote-definition") {
        from = affiliatedBegin(previous.begin);
        continue;
      }
      // With headline-data, what follows the heading's data starts at the margin.
      if (
        e8.variable("org-adapt-indentation") === "headline-data" &&
        !atHeadlineData(from, el) &&
        (isHeadingLine(e8.lineText(lineAt(from - 1))) || atHeadlineData(from - 1, previous))
      )
        return 0;
      // From its affiliated keywords, as Org's previous element begins at them.
      if (previous.begin === e8.lineStart(lineAt(previous.begin))) return indentOf(NO_AFFILIATED.includes(previous.type) ? previous.begin : affiliatedBegin(previous.begin));
      return expectedIndentWide(previous.parent, true, line);
    }
  }
  let q = bol;
  while (q > 0 && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
  if (type === "plain-list" && lineAt(bol) - lineAt(q) > 2) return indentOf(start);
  if (e8.lineStart(lineAt(q)) < start) return expectedIndentWide(el.parent, true, line);
  if (e8.lineStart(lineAt(q)) === start) return expectedIndentWide(el, true, line);
  if (GREATER_ELEMENTS.includes(type ?? "") && el.contentsEnd !== undefined && el.contentsEnd <= bol) {
    if (type === "item" || type === "plain-list") {
      const last = elementAt(q);
      return expectedIndentWide(last, last?.type === "item", line);
    }
    return indentOf(start);
  }
  return indentOf(q);
}

/** Whether org-indent-region moves an element as a whole: an export block, a LaTeX environment, or an example block that does not keep its indentation. */
function indentedAsWhole(el: Elem): boolean {
  return el.type === "export-block" || el.type === "latex-environment" || (el.type === "example-block" && !preservesIndentation(el));
}

/** Indents a line as org-indent-line does, keeping point in the text or after the indentation. */
export function indentLine(line: number): void {
  const text = e8.lineText(line);
  const ls = e8.lineStart(line);
  // Headings are never indented; a block's lines are, as org-indent-line gives them the expected indentation.
  if (isHeadingLine(text)) return;
  const el = elementAt(ls);
  // With headline-data, only the heading's data is indented, not what follows it, as org-indent-line.
  if (
    e8.variable("org-adapt-indentation") === "headline-data" &&
    !atHeadlineData(ls, el) &&
    (el?.type === "headline" || (el !== undefined && el.begin > 0 && (isHeadingLine(e8.lineText(lineAt(el.begin - 1))) || atHeadlineData(el.begin - 1))))
  )
    return;
  // A LaTeX environment's lines are left as they are, as Org leaves a
  // latex-environment's, but not the blank lines after it. Org compares
  // point, which at the end of a buffer with no final newline is not before
  // the line after the environment's last, so that line is indented.
  const here = lineAt() === line ? e8.point() : ls;
  if (el?.type === "latex-environment" && here < lineStartOrEnd(lineAt(endBeforeBlank(el)) + 1)) return;
  // A source block's code, with org-src-tab-acts-natively; without it, its lines are indented as any other.
  if (el?.type === "src-block" && truthy(e8.variable("org-src-tab-acts-natively")) && line > lineAt(el.begin) && line < lineAt(endBeforeBlank(el))) {
    // Indented in the language's mode, as indent-according-to-mode does
    // there; then a line left empty takes the block's content indentation.
    if (e8.fboundp("org-babel-do-key-sequence-in-edit-buffer")) {
      try {
        e8.funcall("org-babel-do-key-sequence-in-edit-buffer", "indent-according-to-mode");
      } catch {
        // As Org's ignore-errors, for a language with no proper mode.
      }
    }
    // The line's start as it is now, as putting the code back may have indented the lines before it.
    if (!preservesIndentation(el) && e8.lineText(line) === "" && e8.point() === e8.lineStart(line)) {
      const ind = textIndentation(e8.lineText(lineAt(affiliatedBegin(el.begin)))) + Number(e8.variable("org-edit-src-content-indentation") ?? 2);
      indentLineTo(line, ind);
      e8.gotoChar(e8.lineEnd(line));
    }
    return;
  }
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
setLineIndenter(indentLine);

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
    let el = isHeadingLine(e8.lineText(line)) ? undefined : elementAt(p);
    // Affiliated keywords are the element's, as #+NAME: above it, so they
    // move with one indented as a whole, from where they start.
    let begin = el?.begin;
    if (el?.type === "keyword") {
      const found = elementWithAffiliated(p);
      if (found && found[1] === e8.lineStart(line) && indentedAsWhole(found[0])) [el, begin] = found;
    }
    // A blank line after a heading is the headline's: Org indents it, which
    // leaves it blank, then the section, as the lines after it come.
    if (!el || el.type === "headline") {
      p = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : size();
      continue;
    }
    const type = el.type;
    const elementEnd = marker(el.end);
    const ind = expectedIndent(el, false, line);
    if (indentedAsWhole(el)) {
      // Indented as a whole, keeping the lines' indentation relative to each other.
      const offset = ind - textIndentation(e8.lineText(lineAt(p)));
      if (offset !== 0) indentRigidly(begin as number, el.end, offset);
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

const BLOCK_TYPES = ["comment-block", "center-block", "dynamic-block", "example-block", "export-block", "quote-block", "special-block", "src-block", "verse-block"];

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
    // With the buffer widened, as Org's org-with-wide-buffer.
    e8.saveRestriction(() => {
      e8.widen();
      orgIndentRegion(el.begin, el.end);
    });
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
    // With the buffer widened, as Org's org-with-wide-buffer.
    e8.saveRestriction(() => {
      e8.widen();
      orgIndentRegion(el.begin, el.end);
    });
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

/** Whether the element at pos is a table or in one, as org-element-lineage finds it. */
function inTable(pos: number): boolean {
  for (let el = elementAt(pos); el !== undefined; el = el.parent) if (el.type === "table" || el.type === "table-row") return true;
  return false;
}

/** Where TAB is cycling the heading above from, where it does not emulate TAB, which Org does by calling itself. */
let cyclingAboveFrom: number | undefined;

/**
 * Where org-back-to-heading goes, without invisible-ok: the heading on
 * point's line or above it that shows, or the narrowing's start under a
 * heading above the narrowing; signalling before the first heading.
 */
function backToShownHeadingPos(): number {
  if (underHeadingAboveNarrowing()) return e8.pointMin();
  const all = headings();
  const i = visibleHeadingIndex(all, lineAt());
  if (i === undefined) backToHeading(true);
  return all[i!].start;
}

/** TAB in Org, as org-cycle does with prefix argument arg. */
function orgCycle(arg: e8.PrefixArg): void {
  {
    if (e8.runHookWithArgsUntilSuccess("org-cycle-tab-first-hook")) return;
    if (cycleLevel() || cycleItemIndentation()) return;
    // Headings deeper than org-cycle-max-level are text to TAB, 2N-1 stars with odd levels only.
    const maxLevel = e8.variable("org-cycle-max-level") ?? null;
    if (truthy(maxLevel) && !(typeof maxLevel === "number" && Number.isInteger(maxLevel) && maxLevel >= 1)) {
      e8.userError("\u2018org-cycle-max-level\u2019 must be a positive integer");
    }
    const nstars = typeof maxLevel === "number" ? (e8.variable("org-odd-levels-only") === true ? 2 * maxLevel - 1 : maxLevel) : Infinity;
    if (Array.isArray(arg) && arg[0] === 4) {
      globalCycle();
      return;
    }
    if (Array.isArray(arg) && arg[0] === 16) {
      e8.setVariable("org-cycle-global-status", null);
      startupVisibility();
      e8.message("Startup visibility, plus VISIBILITY properties", { log: false });
      return;
    }
    if (Array.isArray(arg) && arg[0] === 64) {
      for (const spec of FOLD_SPECS) flag(0, e8.bufferSize(), false, spec);
      e8.message("Entire buffer visible, including drawers", { log: false });
      return;
    }
    // A number: the subtree that many levels up shown, or at that level, as org-cycle does with one.
    if (typeof arg === "number") {
      e8.saveExcursion(() => {
        e8.gotoChar(backToShownHeadingPos());
        const level = parseHeading(lineAt())?.level ?? 0;
        e8.callWithPrefix(arg < 0 ? -arg : level - arg, "outline-up-heading");
        // The subtree shown to the start of the next, newline and all, as org-fold-show-subtree.
        const all = headings();
        const i = headingIndex(all, lineAt());
        if (i !== undefined) flag(e8.point(), nextSameOrHigher(all, i)?.start ?? e8.pointMax(), false);
      });
      return;
    }
    // At the buffer's start, not on a heading, cycle globally with org-cycle-global-at-bob, the window left alone.
    // Not on a heading TAB cycles, one past the limit being text.
    const atBob = parseHeading(lineAt());
    if (truthy(e8.variable("org-cycle-global-at-bob")) && e8.point() === e8.pointMin() && (atBob === undefined || atBob.level > nstars)) {
      // Without the window's optimizing, as Org binds the hook to it remq'd: taken off by name inside the binding.
      e8.letBind({ "org-cycle-hook": e8.variable("org-cycle-hook") ?? null }, () => {
        e8.removeHook("org-cycle-hook", "org-cycle-optimize-window-after-visibility-change");
        globalCycle();
      });
      return;
    }
    const line = lineAt();
    const text = e8.lineText(line);
    if ((DRAWER.test(text) && !/^[ \t]*:END:/i.test(text)) || BLOCK_BEGIN.test(text) || DBLOCK_BEGIN.test(text)) {
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
    // A table's line, as the element there says: a | line in a block is text; a table.el table is left to C-c '.
    if (/^[ \t]*[|+]/.test(text) && tableElTable(elementAt(e8.point()))) {
      e8.message(TABLE_EL_MESSAGE);
      return;
    }
    if (/^[ \t]*[|+]/.test(text) && /^[ \t]*\|/.test(text) && inTable(e8.lineStart(line))) {
      e8.call("org-table-justify-field-maybe");
      e8.call("org-table-next-field");
      return;
    }
    // nil as null or false.
    const emulate = e8.variable("org-cycle-emulate-tab") ?? null;
    const bol = e8.point() === e8.lineStart(line);
    // At a heading's start only, with exc-hl-bol.
    const cycles = bol || emulate !== "exc-hl-bol";
    const here = headingHere();
    if (here && here[0][here[1]].level <= nstars && cycles) {
      // On a hidden heading, the one cycled is the nearest that shows above,
      // as org-back-to-heading finds it.
      const [all, at] = here;
      let i = at;
      while (i > 0 && e8.invisibleAt(all[i].start)) i--;
      cycleHeading(all, i, at);
      return;
    }
    if (itemLine(line) && cycles) {
      cycleItem(line);
      return;
    }
    // In a buffer that cannot change, back to the heading, as Org goes.
    if (e8.bufferReadOnly()) {
      e8.gotoChar(backToShownHeadingPos());
      return;
    }
    if (e8.runHookWithArgsUntilSuccess("org-tab-after-check-for-cycling-hook")) return;
    // From there TAB emulation, after what else wants TAB, as org-tempo's templates.
    if (e8.runHookWithArgsUntilSuccess("org-tab-before-tab-emulation-hook")) return;
    // Where org-cycle-emulate-tab says TAB is TAB; elsewhere the heading above is cycled.
    const lead = /^[ \t]*/.exec(e8.lineText(line))![0];
    const leadEnd = e8.lineStart(line) + charCount(lead);
    const headingAtBol = bol && here !== undefined && here[0][here[1]].line === line && here[0][here[1]].level <= nstars;
    const emulates =
      (emulate === "exc-hl-bol" && !headingAtBol) ||
      emulate === true ||
      (emulate === "white" && leadEnd === e8.lineEnd(line)) ||
      (emulate === "whitestart" && leadEnd >= e8.point());
    if (!emulates) {
      // As Org's org-back-to-heading and org-cycle there, which Org repeats for ever when that cycles nothing.
      e8.saveExcursion(() => {
        const from = backToShownHeadingPos();
        if (cyclingAboveFrom === from) e8.signal("excessive-lisp-nesting", "Lisp nesting exceeds \u2018max-lisp-eval-depth\u2019: 1601");
        const outer = cyclingAboveFrom;
        cyclingAboveFrom = from;
        try {
          e8.gotoChar(from);
          orgCycle(null);
        } finally {
          cyclingAboveFrom = outer;
        }
      });
      return;
    }
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

e8.defineVariable({
  name: "org-cycle-max-level",
  doc: "The deepest level TAB cycles as a heading; deeper headings are text to it. With odd levels only, N means 2N-1 stars. nil for every level.",
  value: null,
});

/**
 * Changes every heading's level, a star at a time, as
 * org-convert-to-odd-levels and org-convert-to-oddeven-levels do with
 * org-odd-levels-only off: by stars(n) for a heading of n stars.
 */
function convertLevels(by: number, steps: (stars: number) => number): void {
  // Within the narrowing, as Org's search from point-min goes; point kept as each change keeps it.
  for (let line = lineAt(e8.pointMin()); line < e8.lineCount() && e8.lineStart(line) < e8.pointMax(); line++) {
    if (e8.lineStart(line) < e8.pointMin()) continue;
    const h = parseHeading(line);
    if (!h || h.level < 2) continue;
    for (let k = steps(h.level); k > 0; k--) changeLevel(parseHeading(line)!, by, false);
  }
}

e8.defineCommand({
  name: "org-convert-to-odd-levels",
  doc: "Make a file's headings use odd levels only: level 2 becomes 3, level 3 becomes 5 and so on, asking first.",
  run: () => {
    if (e8.yesOrNoP("Are you sure you want to globally change levels to odd? ")) convertLevels(1, (n) => n - 1);
  },
});

e8.defineCommand({
  name: "org-convert-to-oddeven-levels",
  doc: "Make a file with odd levels only use every level: level 3 becomes 2, level 5 becomes 3 and so on, asking first. A file with an even level cannot be converted.",
  run: () => {
    e8.gotoChar(e8.pointMin());
    // A heading of an even number of stars, as Org's ^\(\*\*\)+ finds it, point left after it.
    for (let line = lineAt(e8.pointMin()); line < e8.lineCount() && e8.lineStart(line) < e8.pointMax(); line++) {
      if (e8.lineStart(line) < e8.pointMin()) continue;
      const m = /^((?:\*\*)+) /.exec(e8.lineText(line));
      if (m) {
        e8.gotoChar(e8.lineStart(line) + m[0].length);
        showSetVisibility("canonical");
        e8.signal("error", "Not all levels are odd in this file.  Conversion not possible");
      }
    }
    if (e8.yesOrNoP("Are you sure you want to globally change levels to odd-even? ")) convertLevels(-1, (n) => Math.floor((n - 1) / 2));
  },
});

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
    if (inSection) e8.runHooks("org-cycle-pre-hook", "empty");
    e8.message("EMPTY ENTRY", { log: false });
    e8.setVariable("org-cycle-subtree-status", null);
    showFollowing();
    return;
  }
  const hiddenInOneLine = eol >= eos || /^\s*$/.test(e8.bufferText(eol, eos));
  const skipped = hiddenInOneLine && !hasChildren;
  if (hiddenInOneLine && hasChildren) {
    if (inSection) e8.runHooks("org-cycle-pre-hook", "children");
    setItemVisibility(item, struct, "children");
    e8.message("CHILDREN", { log: false });
    showFollowing();
    e8.setVariable("org-cycle-subtree-status", "children");
    if (inSection) e8.runHooks("org-cycle-hook", "children");
  } else if (skipped || (again && status === "children")) {
    if (inSection) e8.runHooks("org-cycle-pre-hook", "subtree");
    flag(eoh, eos, false);
    e8.message(skipped ? "SUBTREE (NO CHILDREN)" : "SUBTREE", { log: false });
    e8.setVariable("org-cycle-subtree-status", "subtree");
    if (inSection) e8.runHooks("org-cycle-hook", "subtree");
  } else {
    // Even before the first heading, as Org runs it there.
    e8.runHooks("org-cycle-pre-hook", "folded");
    flag(eoh, eos, true);
    e8.message("FOLDED", { log: false });
    e8.setVariable("org-cycle-subtree-status", "folded");
    if (inSection) e8.runHooks("org-cycle-hook", "folded");
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
  // Without shifting text, as org-cycle-level binds org-adapt-indentation to nil.
  const promote = (n: number): void => {
    e8.letBind({ "org-adapt-indentation": false }, () => {
      for (let i = 0; i < n; i++) e8.call("org-do-promote");
    });
  };
  const demote = (n: number): void => {
    e8.letBind({ "org-adapt-indentation": false }, () => {
      for (let i = 0; i < n; i++) e8.call("org-do-demote");
    });
  };
  // Counted in steps of two stars with org-odd-levels-only, as org-level-increment says.
  const inc = e8.variable("org-odd-levels-only") === true ? 2 : 1;
  const steps = (n: number) => Math.floor(n / inc);
  if (prev === 0) promote(steps(cur - 1));
  else if (prev === cur) demote(1);
  else if (prev === 1) promote(steps(cur - 1));
  else if (cur === 1) demote(steps(prev - 1));
  else if (cur < prev) promote(1);
  else promote(1 + steps(cur - prev));
  return true;
}

const shiftTab = e8.defineCommand({
  name: "org-shifttab",
  doc:
    "S-TAB in Org: cycle the whole buffer between its top headings, all its headings and everything.\n\n" +
    "In a table, move to the previous field. With a number as prefix argument, show that many levels of headings.",
  run: () => {
    if (atTableP()) {
      e8.call("org-table-previous-field");
      return;
    }
    const prefix = e8.prefixArg();
    if (typeof prefix === "number") {
      e8.message(`Content view to level: ${prefix}`);
      // Twice as many stars with odd levels only, as org-shifttab counts them.
      // A count not above zero shows every heading, as org-cycle-content.
      const levels = e8.variable("org-odd-levels-only") === true ? 2 * prefix - 1 : prefix;
      showLevels(levels > 0 ? levels : Infinity);
      showEmptyLines("t");
      e8.setVariable("org-cycle-global-status", "overview");
      e8.runHooks("org-cycle-hook", "overview");
      return;
    }
    // As org-cycle-global does: C-u means the startup visibility, without org-cycle's checks, else C-u TAB.
    if (Array.isArray(prefix)) {
      startupVisibility();
      e8.message("Startup visibility, plus VISIBILITY properties.", { log: false });
    } else orgCycle([4]);
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
  // Indented as electric-indent-mode does after a typed newline, when it is on.
  run: () => orgReturnWith(electricIndentOn(), false),
});

e8.defineCommand({
  name: "org-return-and-maybe-indent",
  doc:
    "C-j in Org: what RET does, but the new line is not indented, as electric-indent-mode leaves C-j alone; " +
    "with electric-indent-mode off, indented, as org-return-and-maybe-indent passes (not electric-indent-mode).",
  run: () => orgReturnWith(!electricIndentOn(), true),
});

/** Whether electric-indent-mode is on here. */
const electricIndentOn = (): boolean => truthy(e8.variable("electric-indent-mode") ?? true);

e8.defineVariable({
  name: "org-special-ctrl-o",
  doc: "Whether C-o in a table inserts a row rather than opening a line.",
  value: true,
});

e8.defineCommand({
  name: "org-open-line",
  barfIfReadOnly: true,
  doc: "C-o in Org: in a table, insert a row above; elsewhere, or at the very start of the buffer, open-line.",
  run: () => {
    const p = e8.point();
    if (e8.variable("org-special-ctrl-o") === true && p !== 0 && atTableP())
      e8.call("org-table-insert-row");
    else e8.callWithPrefix(e8.prefixArg(), "open-line");
  },
});

/**
 * RET in Org, as org-return does. Org calls newline interactively for RET,
 * so electric-indent-mode indents the new line, and from code for C-j, so it does not.
 */
function orgReturnWith(electric: boolean, prefixless: boolean): void {
  // C-j's org-return-and-maybe-indent takes no argument: one newline, and Auto Fill.
  // No Auto Fill on a property's line, as org-return binds auto-fill-function to nil there.
  const onProperty = elementAt(e8.point())?.type === "node-property";
  // Org's newline self-inserts, so the newlines take on the text properties
  // around them, and runs of them undo together.
  const newline = (n: number): void => {
    // As newline: a negative count is an error, and none inserts nothing.
    if (n < 0) e8.signal("error", "Repetition argument has to be non-negative");
    // None inserts nothing, but point still goes to the line's left margin, as newline's last step does.
    if (n === 0) {
      e8.gotoChar(e8.lineStart(lineAt()));
      return;
    }
    e8.undoAutoAmalgamate();
    e8.insertAndInherit("\n".repeat(n));
    // As self-insert does a newline: Auto Fill fills the line the newline
    // ends, before electric indentation, unless there is a prefix argument,
    // as newline then binds auto-fill-function to nil.
    const fill = e8.variable("auto-fill-function");
    if (typeof fill === "string" && (prefixless || e8.prefixArg() === null) && !onProperty) {
      e8.gotoChar(e8.point() - 1);
      if (autoFillAllowed()) e8.call(fill as e8.CommandName);
      if (e8.point() < e8.bufferSize()) e8.gotoChar(e8.point() + 1);
    }
    if (electric) electricIndentNewline();
  };
  checkInvisibleEditMaybe();
  const line = lineAt();
  const p = e8.point();
  const [ls, le] = [e8.lineStart(line), e8.lineEnd(line)];
  const n = prefixless ? 1 : e8.prefixNumericValue();
  if (atTableP()) {
    // Before the first column or after the last, a table is split.
    if (/^[ \t]*$/.test(e8.bufferText(p, le)) || /^[ \t]*$/.test(e8.bufferText(ls, p))) e8.insert("\n");
    else {
      e8.call("org-table-justify-field-maybe");
      e8.call("org-table-next-row");
    }
    return;
  }
  // On a link or a timestamp, RET follows it, as org-return-follows-link says.
  // As org-return, by the text alone: in a LaTeX environment too, where C-c C-o then finds no link.
  if (e8.variable("org-return-follows-link") === true && (linkHere() !== undefined || onTimestamp())) {
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
/** After a newline, the whitespace before it gone and the new line indented, as electric-indent-mode does. */
function electricIndentNewline(): void {
  const before = e8.point() - 1;
  const text = e8.bufferText(e8.lineStart(lineAt(before)), before);
  const spaces = text.length - text.replace(/[ \t]+$/, "").length;
  if (spaces > 0) e8.deleteRegion(before - spaces, before);
  indentLine(lineAt());
}

// Commands: moving between headings

e8.defineVariable({
  name: "org-special-ctrl-a/e",
  doc:
    "Whether C-a and C-e are special on headings and items: t sends C-a first to a heading's title, after its stars, TODO state and priority, " +
    "or to an item's text, after its bullet and checkbox, and C-e first to before a heading's tags; reversed does so on the second press; " +
    "a pair [C-A, C-E] sets each on its own.",
  value: null,
});

/** org-special-ctrl-a/e's setting for C-a (first) or C-e: undefined for none, "reversed", or "on". */
function specialCtrlAE(first: boolean): "on" | "reversed" | undefined {
  let v: e8.Value = e8.variable("org-special-ctrl-a/e") ?? null;
  // A list of two is the pair (C-A . C-E), as E8 has no dotted pairs; of one, its cdr is nil.
  if (Array.isArray(v)) v = (first ? v[0] : v.length === 2 ? v[1] : v.length > 2 ? v.slice(1) : null) ?? null;
  if (!truthy(v)) return undefined;
  return symbolNamed(v, "reversed") || v === "reversed" ? "reversed" : "on";
}

/** Whether this command repeats the last, as (eq last-command this-command). */
const repeated = (): boolean => e8.lastCommand() !== undefined && e8.lastCommand() === e8.thisCommand();

/**
 * A heading line as org-complex-heading-regexp matches it, case mattering:
 * the stars, a TODO keyword, a priority of any one character, the title,
 * and tags, each after spaces or tabs; a line of bare stars too.
 */
function complexHeading(line: number): { starsEnd: number; todoEnd?: number; priorityEnd?: number; tagsAt?: number } | undefined {
  const words = [...allKeywords()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const re = new RegExp(`^(\\*+)(?: +(${words || "(?!)"}))?(?: +(\\[#.\\]))?(?: +(.*?))??(?:[ \\t]+(:[\\p{L}\\p{N}_@#%:]+:))?[ \\t]*$`, "u");
  const text = e8.lineText(line);
  const m = re.exec(text);
  if (!m) return undefined;
  const ls = e8.lineStart(line);
  const endOf = (group: number): number | undefined => {
    if (m[group] === undefined) return undefined;
    // Each group's place, found after the ones before it.
    let from = 0;
    for (let g = 1; g < group; g++) if (m[g] !== undefined) from = text.indexOf(m[g], from) + m[g].length;
    return ls + charCount(text.slice(0, text.indexOf(m[group], from) + m[group].length));
  };
  const tagsEnd = endOf(5);
  return {
    starsEnd: ls + charCount(m[1]),
    todoEnd: endOf(2),
    priorityEnd: endOf(3),
    tagsAt: tagsEnd === undefined ? undefined : tagsEnd - charCount(m[5]),
  };
}

/** Where a heading's title starts for C-a: one past the TODO keyword, else the priority, else the stars, at most the line's end. */
function headingTitlePosition(line: number): number | undefined {
  const h = complexHeading(line);
  if (!h) return undefined;
  return Math.min((h.priorityEnd ?? h.todoEnd ?? h.starsEnd) + 1, e8.lineEnd(line));
}

/** Where an item's text starts for C-a, as org-beginning-of-line finds it: after the bullet and the spaces after it, and after a checkbox and a space. */
function itemTextPosition(line: number): number | undefined {
  const text = e8.lineText(line);
  // Whatever the case, as Org matches org-list-full-item-re with case-fold-search, so [x] is a box.
  const m = /^[ \t]*((?:[-+*]|(?:[0-9]+|[A-Za-z])[.)])(?:[ \t]+|$))(?:\[@(?:start:)?(?:[0-9]+|[A-Za-z])\][ \t]*)?(?:(\[[ X-]\])(?:[ \t]+|$))?/i.exec(text);
  if (!m || !itemLine(line)) return undefined;
  const ls = e8.lineStart(line);
  if (m[2] === undefined) return ls + charCount(text.slice(0, m.index + m[0].indexOf(m[1]) + m[1].length));
  const boxEnd = ls + charCount(text.slice(0, text.indexOf(m[2], m.index + m[1].length) + 3));
  return e8.bufferText(boxEnd, boxEnd + 1) === " " ? boxEnd + 1 : boxEnd;
}

const visualLineMode = (): boolean => truthy(e8.variable("visual-line-mode"));

const orgBeginningOfLine = e8.defineCommand({
  name: "org-beginning-of-line",
  doc:
    "Move to the start of the line; with org-special-ctrl-a/e, on a heading first to its title, after the stars, " +
    "TODO state and priority, and on an item to its text, after the bullet and checkbox. With a prefix argument, move N - 1 lines first.",
  shiftSelect: true,
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    const origin = e8.point();
    const special = specialCtrlAE(true);
    if (visualLineMode()) {
      if (n !== 1) forwardLine(n - 1);
      e8.call("beginning-of-visual-line");
    } else {
      e8.call("move-beginning-of-line", n);
      e8.gotoChar(e8.lineStart(lineAt()));
    }
    if (!special) return;
    const bol = e8.point();
    if (visualLineMode() && bol !== e8.lineStart(lineAt())) return;
    const line = lineAt();
    const refpos = headingTitlePosition(line);
    if (refpos !== undefined) {
      if (special === "reversed") {
        if (origin === bol && repeated()) e8.gotoChar(refpos);
      } else if (origin > refpos || origin <= bol) e8.gotoChar(refpos);
      return;
    }
    const afterBullet = itemTextPosition(line);
    if (afterBullet === undefined) return;
    if (special === "reversed") {
      if (bol === origin && repeated()) e8.gotoChar(afterBullet);
    } else if (origin > afterBullet || bol >= origin) e8.gotoChar(afterBullet);
  },
});

e8.defineCommand({
  name: "org-end-of-line",
  doc:
    "Move to the end of the line, staying on a folded heading's line rather than going past its hidden text; with org-special-ctrl-a/e, " +
    "on a heading with tags first to before them. With a prefix argument, move N - 1 lines first.",
  // With Shift it selects, as Org's interactive ^p.
  shiftSelect: true,
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    const origin = e8.point();
    const special = specialCtrlAE(false);
    if (visualLineMode()) {
      if (n !== 1) forwardLine(n - 1);
      e8.call("beginning-of-visual-line");
    } else e8.call("move-beginning-of-line", n);
    const line = lineAt();
    const h = special ? complexHeading(line) : undefined;
    if (h?.tagsAt !== undefined) {
      let tags = h.tagsAt;
      while (tags > e8.lineStart(line) && /[ \t]/.test(e8.bufferText(tags - 1, tags))) tags--;
      const le = e8.lineEnd(line);
      const visualEnd = visualLineMode()
        ? e8.saveExcursion(() => {
            e8.call("end-of-visual-line");
            return e8.point();
          })
        : undefined;
      if (visualEnd !== undefined && visualEnd < tags && origin <= visualEnd) e8.gotoChar(visualEnd);
      else if (special === "reversed") e8.gotoChar(origin === le && repeated() ? tags : le);
      else e8.gotoChar(origin < tags || origin >= le ? tags : le);
      return;
    }
    if (visualLineMode()) {
      const bol = e8.lineStart(lineAt());
      e8.call("end-of-visual-line");
      if (bol !== e8.lineStart(lineAt())) e8.gotoChar(e8.lineEnd(lineAt(bol)));
      return;
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
    // From the mark, then to the end of the element there, each within the narrowing, as goto-char keeps to it.
    const from = Math.max(e8.pointMin(), Math.min(e8.pointMax(), mark as number));
    const end = elementWithAffiliated(from)?.[0].end ?? from;
    e8.setMark(Math.max(e8.pointMin(), Math.min(e8.pointMax(), end)));
    return;
  }
  // With its affiliated keywords, as #+NAME: above it, which are its in Org's parse.
  const found = elementWithAffiliated(e8.point());
  if (!found) return;
  const [e, begin] = found;
  e8.gotoChar(e8.lineEnd(lineAt()));
  e8.pushMark(Math.min(e8.pointMax(), e.end), { activate: true });
  // Within the narrowing, as goto-char keeps to it: the element may start before it.
  e8.gotoChar(begin);
}

e8.defineCommand({
  name: "org-mark-element",
  doc: "Make the region the element at point; repeated, or with the mark active, take in the next element too.",
  run: () => markElement(),
});

const markSubtree = e8.defineCommand({
  name: "org-mark-subtree",
  doc: "Make the region the subtree point is in: point at its heading, the mark at its end. With a number, the subtree that many levels up.",
  params: [{ name: "up", kind: "prefix" }],
  run: (up: e8.PrefixArg) => {
    const line = lineAt();
    if (parseHeading(line)) e8.gotoChar(e8.lineStart(line));
    else if (headingIndex(headings(), line) === undefined) e8.userError("Not in a subtree");
    else e8.call("org-previous-visible-heading");
    if (up !== null && up !== undefined) {
      // As Org's (> up 0), which a raw C-u, a list, fails.
      if (typeof up !== "number") e8.signal("wrong-type-argument", `Wrong type argument: number-or-marker-p, (${Array.isArray(up) ? up[0] : String(up)})`, [e8.intern("number-or-marker-p"), up]);
      // Up that many levels, as org-up-heading-safe climbs, while there is a heading above.
      for (let n = up as number; n > 0; n--) {
        const all = headings();
        const i = headingIndex(all, lineAt());
        if (i === undefined) break;
        let j = i - 1;
        while (j >= 0 && all[j].level >= all[i].level) j--;
        if (j < 0 || all[j].start < e8.pointMin()) break;
        e8.gotoChar(all[j].start);
      }
    }
    markElement();
  },
});

// Commands: inserting headings and items

function blankLineAt(line: number): boolean {
  return line < e8.lineCount() && e8.lineText(line) === "";
}

/** Whether the line before point's is empty, as org-previous-line-empty-p says. */
function previousLineEmpty(): boolean {
  if (e8.point() === e8.pointMin()) return false;
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
  // bobp and skip-chars-backward stop at the start of a narrowing.
  const min = e8.pointMin();
  if (e8.point() > min) {
    let q = e8.point();
    while (q > min && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
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
/** Inserts a heading as org-insert-heading does, then runs org-insert-heading-hook. */
function insertHeading(arg: e8.PrefixArg, invisibleOk = false): void {
  insertHeadingOnly(arg, invisibleOk);
  e8.runHooks("org-insert-heading-hook");
}

function insertHeadingOnly(arg: e8.PrefixArg, invisibleOk = false): void {
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
    (!invisibleOk && e8.invisibleAt(Math.max(e8.pointMin(), p - 1)));
  const atBol = (): boolean => e8.point() === e8.lineStart(lineAt());
  if (respect) {
    if (level === undefined) {
      // As outline-next-heading, within the narrowing.
      const from = atBol() && p < e8.pointMax() ? p + 1 : p;
      e8.gotoChar(all.find((h) => h.start >= from)?.start ?? e8.pointMax());
    } else if (current === undefined) {
      // Under a heading above the narrowing: org-back-to-heading stops at
      // the narrowing's start, and org-end-of-subtree goes to that
      // heading's end, or the narrowing's.
      const end = e8.saveRestriction(() => {
        e8.widen();
        const wide = headings();
        let i = headingIndex(wide, lineAt()) as number;
        if (parentEnd) i = ancestors(wide, i)[0] ?? i;
        return subtreeRegion(wide, i)[1];
      });
      e8.gotoChar(Math.min(end, e8.pointMax()));
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
    // Neither eobp nor bobp, which are the narrowing's ends.
    if (level === undefined && e8.point() < e8.pointMax() && e8.point() > e8.pointMin()) {
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
  if (e8.variable("org-treat-insert-todo-heading-as-state-change") === true) {
    const how = logHow(state, undefined);
    if (how === "note") addLogNote(line, "state", state, undefined);
    else if (how !== undefined) storeStateNote(line, state, undefined);
  }
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
    if (atTableP()) {
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

/** A new heading or item, then demoted, as org-insert-subheading and org-insert-todo-subheading end. */
function demoteInserted(): void {
  if (isHeadingLine(e8.lineText(lineAt()))) e8.call("org-do-demote");
  else if (itemLine(lineAt())) e8.call("org-indent-item");
}

e8.defineCommand({
  name: "org-insert-subheading",
  doc:
    "Insert a heading one level below the one point is under, or an item one level below, as org-insert-heading and a demotion. " +
    "At the start of a heading, the new one still goes below it. The prefix argument is org-insert-heading's.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    const p = e8.point();
    if (p === e8.lineBeginningPosition() && p < e8.pointMax() && p !== e8.lineEndPosition()) e8.gotoChar(p + 1);
    insertHeading(arg);
    demoteInserted();
  },
});

e8.defineCommand({
  name: "org-insert-todo-subheading",
  doc:
    "Insert a heading one level below with the TODO state of the heading above, or the first state if that one is done, or an item with a checkbox one level below, " +
    "as org-insert-todo-heading and a demotion.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    insertTodoHeading(arg, false);
    demoteInserted();
  },
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
function changeLevel(h: Heading, by: number, oddLevels = true): void {
  if (by < 0 && h.level === 1) e8.userError("Cannot promote to level 0.  UNDO to recover if necessary");
  // Two stars a level with org-odd-levels-only, an even level made odd, as org-get-valid-level gives it;
  // one star at a time without ODD-LEVELS, as org-paste-subtree binds org-odd-levels-only to nil.
  const level = oddLevels ? validLevel(h.level, by) : Math.max(1, h.level + by);
  // Org checks folds after promoting, but not after demoting.
  const change = (): void => {
    replaceKeepingPoint(h.start, h.start + h.level + 1, `${"*".repeat(level)} `);
    if (h.tags.length > 0 && truthy(e8.variable("org-auto-align-tags") ?? true)) alignTagsAway(h.line);
    if (truthy(e8.variable("org-adapt-indentation"))) e8.saveExcursion(() => fixupIndentation(h.line, level - h.level));
  };
  if (by > 0) withoutFoldChecks(change);
  else change();
  // At the heading, in the whole buffer, as org-promote and org-demote run them; nothing to do with none on it.
  const hook = by > 0 ? "org-after-demote-entry-hook" : "org-after-promote-entry-hook";
  const fns = e8.variable(hook);
  if (!(Array.isArray(fns) ? fns.length > 0 : truthy(fns ?? null))) return;
  e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      // After the new stars and their space, where replacing them leaves point.
      e8.gotoChar(e8.lineStart(h.line) + level + 1);
      e8.runHooks(hook);
    }),
  );
}

/**
 * Shifts an entry's text by `diff` columns after its heading's level
 * changed, as org-fixup-indentation does: the planning line and property
 * drawer indented afresh, the LOGBOOK drawer shifted, and with
 * org-adapt-indentation t the rest shifted too, unless that would take a
 * line past the margin or make it a heading; blank lines, headings and
 * blocks whose indentation is kept are left as they are.
 */
function fixupIndentation(headingLine: number, diff: number): void {
  // In the whole buffer, as org-with-wide-buffer, so a narrowing's end is not the entry's.
  e8.saveRestriction(() => {
    e8.widen();
    fixupIndentationWide(headingLine, diff);
  });
}

function fixupIndentationWide(headingLine: number, diff: number): void {
  const all = headings();
  const i = headingIndex(all, headingLine)!;
  const endLine = i + 1 < all.length ? all[i + 1].line : e8.lineCount();
  let l = headingLine + 1;
  if (l < endLine && PLANNING.test(e8.lineText(l))) indentLine(l++);
  if (l < endLine && /^[ \t]*:PROPERTIES:[ \t]*$/i.test(e8.lineText(l))) {
    let close = l + 1;
    while (close < endLine && !/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(close))) close++;
    if (close < endLine) {
      for (let k = l; k <= close; k++) indentLine(k);
      l = close + 1;
    }
  }
  if (l < endLine && /^[ \t]*:LOGBOOK:[ \t]*$/i.test(e8.lineText(l))) {
    let close = l + 1;
    while (close < endLine && !/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(close))) close++;
    if (close < endLine && textIndentation(e8.lineText(l)) + diff >= 0) {
      for (let k = l; k <= close; k++) {
        if (diff > 0) edInsert(e8.lineStart(k), " ".repeat(diff));
        else e8.deleteRegion(e8.lineStart(k), e8.lineStart(k) + Math.min(-diff, charCount(e8.lineText(k))));
      }
      l = close + 1;
    }
  }
  if (diff === 0 || e8.variable("org-adapt-indentation") !== true) return;
  // The lines to shift: past footnote definitions, blank lines and headings, and the inside of blocks whose indentation is kept.
  const lines: number[] = [];
  for (let k = l; k < endLine; k++) {
    const text = e8.lineText(k);
    if (FOOTNOTE_DEFINITION.test(text)) {
      // A footnote definition, all of it.
      const fd = elementAt(e8.lineStart(k));
      if (fd?.type === "footnote-definition") {
        k = fd.end === e8.lineStart(lineAt(fd.end)) ? lineAt(fd.end) - 1 : endLine;
        continue;
      }
    }
    if (/^[ \t]*$/.test(text) || isHeadingLine(text)) continue;
    lines.push(k);
    if (/^[ \t]*#\+BEGIN_(EXAMPLE|SRC)/i.test(text)) {
      const block = elementAt(e8.lineStart(k));
      if (block !== undefined && preservesIndentation(block)) {
        // The block's last line, its #+END_, is shifted; what is inside is not.
        const last = lineAt(Math.max(endBeforeBlank(block) - 1, block.begin));
        if (last > k) k = last - 1;
      }
    }
  }
  // Shifting left gives up if it would take a line past the margin or make it a heading or a footnote definition.
  if (diff < 0) {
    for (const k of lines) {
      const text = e8.lineText(k);
      const ind = textIndentation(text);
      const rest = text.replace(/^[ \t]*/, "");
      if (ind < -diff || (ind === -diff && (/^\*+ /.test(rest) || FOOTNOTE_DEFINITION.test(rest)))) return;
    }
  }
  for (const k of lines) indentLineTo(k, textIndentation(e8.lineText(k)) + diff);
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

/**
 * Calls fn on the heading starting at `first`, then on each heading after
 * it while `more` says so, found by looking forward from the last one's
 * line after fn ran, as org-map-tree and org-map-region go with
 * outline-next-heading: lines a hook adds on the way are passed over.
 */
function mapHeadingsFrom(first: number, more: (h: Heading) => boolean, fn: (h: Heading) => void, firstAfterStars = false): void {
  // After the first one's stars when org-map-region's search found it there, so a line a hook puts before it is passed over.
  const firstHeading = parseHeading(lineAt(first));
  const at = marker(firstAfterStars && firstHeading !== undefined ? firstHeading.start + firstHeading.level + 1 : first);
  try {
    for (;;) {
      const h = parseHeading(lineAt(at.pos));
      if (!h) return;
      fn(h);
      let next: Heading | undefined;
      for (let l = lineAt(at.pos) + 1; l < e8.lineCount() && e8.lineStart(l) < e8.pointMax(); l++) {
        if (isHeadingLine(e8.lineText(l))) {
          next = parseHeading(l);
          break;
        }
      }
      if (next === undefined || !more(next)) return;
      at.pos = next.start;
    }
  } finally {
    dropMarker(at);
  }
}

/**
 * Shifts the headings from beg to end by `shift` levels, a level at a time
 * and top down each time, as org-paste-subtree does with org-demote or
 * org-promote, a star a level whatever org-odd-levels-only says; their
 * hooks run for each heading at each level.
 */
export function shiftHeadings(beg: number, end: number, shift: number): void {
  const endMark = marker(end);
  try {
    for (let left = shift; left !== 0; left += left > 0 ? -1 : 1) {
      const first = headings().find((x) => x.start >= beg && x.start < endMark.pos);
      if (first !== undefined) mapHeadingsFrom(first.start, (h) => h.start < endMark.pos, (h) => changeLevel(h, left > 0 ? 1 : -1, false), true);
    }
  } finally {
    dropMarker(endMark);
  }
}

function changeSubtreeLevel(by: number): void {
  const [all, i] = backToHeading();
  const end = subtreeRegion(all, i)[1];
  const inside = all.filter((h, k) => k >= i && h.start < end);
  if (by < 0 && inside.some((h) => h.level === 1)) e8.userError("Cannot promote to level 0.  UNDO to recover if necessary");
  // Top down, as org-map-tree goes: the headings below the first deeper than it was.
  const top = all[i].level;
  mapHeadingsFrom(all[i].start, (h) => h.level > top, (h) => changeLevel(h, by));
  fixPositionAfterPromote();
}

/** Calls fn on each heading of the active region, top down, found afresh after each, as org-map-region goes. */
function mapRegionHeadings(region: Heading[], fn: (h: Heading) => void): void {
  if (region.length === 0) return;
  const mark = e8.mark() ?? e8.point();
  const end = marker(Math.max(mark, e8.point()));
  try {
    mapHeadingsFrom(region[0].start, (h) => h.start < end.pos, fn, true);
  } finally {
    dropMarker(end);
  }
}

/**
 * With the region active, the headings org-map-region goes through: those
 * starting in it, from its beginning on, which may be none.
 */
function headingsInRegion(): Heading[] | undefined {
  if (!orgRegionActive()) return undefined;
  const mark = e8.mark() ?? e8.point();
  const [from, to] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  const inside = headings().filter((h) => h.start >= from && h.start < to);
  // None unless the first one's stars and the space after them end before
  // the region does, as org-map-region's search for it must.
  if (inside.length > 0 && !(inside[0].start + inside[0].level + 1 < to)) return [];
  return inside;
}

/** Whether the active region starts on an item's line, as org-at-item-p there. */
function regionStartsAtItem(): boolean {
  if (!orgRegionActive()) return false;
  const mark = e8.mark() ?? e8.point();
  return itemLine(lineAt(Math.min(mark, e8.point())));
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
        mapRegionHeadings(region, (h) => changeLevel(h, -1));
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
        mapRegionHeadings(region, (h) => changeLevel(h, 1));
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
  saveMarkersInRegion(beg, end);
  edDelete(beg, end);
  let p = ins > beg ? ins - (end - beg) : ins;
  if (beg > 0) flag(beg - 1, beg, false);
  if (p > 0) flag(p - 1, p, false);
  if (p !== e8.lineStart(lineAt(p)) && e8.bufferText(p, p + 1) === "\n") p++;
  edInsert(p, txt, true);
  reinstallMarkersInRegion(p);
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

// Markers that move with a subtree, as org-save-markers-in-region keeps
// org-markers-to-move.

/** Functions giving the markers a package keeps, which follow a subtree cut and pasted or moved. */
const markerKeepers: (() => (e8.Marker | undefined)[])[] = [];

/** Has the markers KEEP gives follow subtrees cut and pasted, moved or refiled, as Org checks its clock's, notes' and agenda's. */
export function keepMarkersThroughMoves(keep: () => (e8.Marker | undefined)[]): void {
  markerKeepers.push(keep);
}

/** Markers sorting entries puts back in their entry, as org-sort-entries puts back org-clock-marker. */
const sortKeepers: (() => e8.Marker | undefined)[] = [];

/** Registers a marker sorting entries keeps in its entry, where the others in the sorted text go to its start, as sort-subr leaves them. */
export function keepMarkerThroughSort(keep: () => e8.Marker | undefined): void {
  sortKeepers.push(keep);
}

/** The markers saved from the last subtree cut, each with how far into it it was, as org-markers-to-move. */
let markersToMove: [e8.Marker, number][] = [];

/** Notes the kept markers from BEG to END in this buffer and how far into it each is, as org-save-markers-in-region. */
export function saveMarkersInRegion(beg: number, end: number): void {
  markersToMove = [];
  // This buffer's, or its base buffer's when it is indirect, as org-check-and-save-marker takes.
  const buffers = [e8.bufferName(), e8.bufferBaseBuffer()?.name].filter((b) => b !== undefined);
  for (const keep of markerKeepers) {
    for (const m of keep()) {
      if (m === undefined || !buffers.includes(e8.markerBuffer(m) as string)) continue;
      const pos = e8.markerPosition(m);
      if (pos !== undefined && pos >= beg && pos < end) markersToMove.push([m, pos - beg]);
    }
  }
}

/** Forgets the markers saved, as Org sets org-markers-to-move to nil after archiving cuts a subtree. */
export function clearMarkersToMove(): void {
  markersToMove = [];
}

/** Puts the saved markers back as far into the text now at BEG, in this buffer, as org-reinstall-markers-in-region. */
export function reinstallMarkersInRegion(beg: number): void {
  for (const [m, offset] of markersToMove) e8.setMarker(m, beg + offset, e8.bufferName());
  markersToMove = [];
}

// A note's place moves with its entry, as Org saves org-log-note-marker.
keepMarkersThroughMoves(() => [noteSetup?.heading, noteSetup?.at, pendingNote?.heading, pendingNote?.at]);

// Subtrees and the kill ring

/**
 * The subtree org-copy-subtree takes, and the n - 1 after it, and whether
 * it shows folded, so pasting it back can fold it again. Called
 * interactively (visible), what looks like the subtree: the nearest
 * heading that shows.
 */
function subtreeToCopy(n: number, visible: boolean): [number, number, boolean] {
  const [all, found] = backToHeading(true);
  let i = found;
  for (const a of [found, ...ancestors(all, found)]) {
    i = a;
    if (!visible || !e8.invisibleAt(all[a].start)) break;
  }
  let j = i;
  for (let k = 1; k < n; k++) j = sibling(all, j, 1) ?? j;
  return [all[i].start, subtreeRegion(all, j)[1], e8.invisibleAt(all[i].end)];
}

/**
 * Kills or copies the subtree point is in, and the n - 1 after it, as
 * org-copy-subtree does; point and the mark stay where they were, moving
 * as markers do when the text goes. Called
 * interactively it takes what looks like the subtree, the nearest heading
 * that shows; otherwise, as org-cut-subtree calls it, what is really there.
 */
export function copySubtree(cut: boolean, n: number, visible: boolean, forceStoreMarkers = false): void {
  const p = e8.point();
  const [beg, end, folded] = underHeadingAboveNarrowing() ? subtreeFromNarrowingStart(n) : subtreeToCopy(n, visible);
  if (end <= beg) return;
  // The markers in it go with it when it is pasted, as for a cut or a refile's copy.
  if (cut || forceStoreMarkers) saveMarkersInRegion(beg, end);
  const mark = e8.mark();
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
export function killIsSubtree(text: string): boolean {
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
 * start of, or else before the next visible heading. With forYank, as
 * org-yank calls it, point goes to the pasted text's end and nothing is
 * folded, which org-yank decides. It says what it did for a yank or when
 * INTERACTIVE, the command's own call.
 */
export function pasteSubtree(level: e8.PrefixArg, forYank = false, interactive = false): void {
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
    // As org-outline-level: the stars' own level when they make a heading,
    // with a space after them, else the heading above's, or 0 before the first.
    // In the whole buffer, as org-back-to-heading finds a heading outside a narrowing.
    indicator = e8.saveRestriction(() => {
      e8.widen();
      return [...headings()].reverse().find((h) => h.line <= line)?.level ?? 0;
    });
    force = indicator;
  } else if (c4) {
    // As org-outline-level: the heading point is under, hidden or not, or 0 before the first.
    force = e8.saveRestriction(() => {
      // In the whole buffer, as org-back-to-heading finds a heading outside a narrowing.
      e8.widen();
      return [...headings()].reverse().find((h) => h.line <= line)?.level ?? 0;
    });
  }
  else if (typeof level === "number") force = level;
  else if (!c16 && atBol && /^\*+ /.test(text)) force = levelHere();
  const all = headings();
  const shown = all.filter(visible_);
  const prev = parseHeading(line) ? levelHere() : (shown.filter((h) => h.line < line).at(-1)?.level ?? 1);
  const next = shown.find((h) => h.line > line)?.level ?? 1;
  const fresh = force ?? Math.max(c16 ? prev + 1 : 0, prev, next);
  let shift = old === -1 || fresh === -1 || old === fresh ? 0 : fresh - old;
  if (indicator !== undefined) edDelete(e8.lineStart(line), lineStartOrEnd(line + 1));
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
  reinstallMarkersInRegion(beg);
  const end = e8.point();
  e8.gotoChar(beg);
  while (e8.point() < e8.bufferSize() && /[ \t\n\r]/.test(e8.bufferText(e8.point(), e8.point() + 1))) {
    e8.gotoChar(e8.point() + 1);
  }
  beg = e8.point();
  if (e8.invisibleAt(beg) && visible) showHeadingLine(parseHeading(lineAt(beg)) as Heading);
  const endMark = marker(end);
  shiftHeadings(beg, end, shift);
  const newEnd = endMark.pos;
  dropMarker(endMark);
  e8.gotoChar(beg);
  // Said only for a yank or the command itself, as Org's checks called-interactively-p, so not when archiving or refiling.
  if (forYank || interactive) e8.message(`Clipboard pasted as level ${fresh} subtree`);
  if (forYank) {
    e8.gotoChar(newEnd);
    return;
  }
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
  // To the end of what is accessible, as org-end-of-subtree stops there.
  const end = next >= e8.pointMax() ? e8.pointMax() : next - 1;
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
  name: "org-yank-adjusted-subtrees",
  doc: "Whether C-y pastes a subtree at the level around point, as org-paste-subtree does, rather than as it is.",
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
  // Org calls yank with call-interactively, so its * refuses a read-only buffer first.
  if (arg !== null) {
    barfIfBufferReadOnly();
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
  const adjusted = truthy(e8.variable("org-yank-adjusted-subtrees") ?? null);
  if (!subtreep || !truthy(e8.variable("org-yank-folded-subtrees") ?? null)) {
    if (subtreep && adjusted) {
      // At the level around point, as org-paste-subtree pastes it, the mark at the line's start.
      const lineBeg = e8.lineStart(lineAt());
      pasteSubtree(null, true);
      e8.pushMark(lineBeg);
      return;
    }
    barfIfBufferReadOnly();
    e8.call("yank");
    return;
  }
  const beg = p;
  if (adjusted) pasteSubtree(null, true);
  else {
    barfIfBufferReadOnly();
    e8.call("yank");
  }
  const end = e8.point();
  e8.gotoChar(beg);
  const swallows = (): boolean => {
    let q = beg;
    while (q < end && !parseHeading(lineAt(q))) q = lineStartOrEnd(lineAt(q) + 1);
    const level = parseHeading(lineAt(Math.min(q, end)))?.level ?? 0;
    let r = end;
    // To the end of what is accessible, as eobp is.
    while (r < e8.pointMax() && /[ \t\r\n\v\f]/.test(e8.bufferText(r, r + 1))) r++;
    if (r >= e8.pointMax()) return false;
    const h = r === e8.lineStart(lineAt(r)) ? parseHeading(lineAt(r)) : undefined;
    return !(h && h.level <= level);
  };
  if (beg === e8.lineStart(lineAt(beg))) {
    if (swallows()) e8.message("Inserted text not folded because that would swallow text");
    else {
      // Only from a heading at the start, as Org's re-search-forward to a
      // later one leaves point after its stars, where its loop stops.
      let q = parseHeading(lineAt(beg)) ? beg : end;
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
  // Said only when called interactively, not from org-paste-special, as Org's checks called-interactively-p.
  run: () => pasteSubtree(e8.prefixArg(), false, e8.calledInteractively()),
});

e8.defineCommand({
  name: "org-fix-tags-on-the-fly",
  doc: "Align the tags of the heading point is on, if point is before them, as typing on a heading does.",
  run: () => {
    const line = lineAt();
    const m = /^\*+ (?:.*[ \t])?(:[\p{L}\p{M}\p{Nd}\p{Nl}_@#%:]+:)[ \t]*$/u.exec(e8.lineText(line));
    if (m && e8.point() < e8.lineStart(line) + charCount(e8.lineText(line).slice(0, m[0].length - m[1].length - (/[ \t]*$/.exec(m[0])?.[0].length ?? 0)))) {
      alignTags(line);
    }
  },
});

e8.defineCommand({
  name: "org-paste-special",
  doc: "Paste a subtree at the right level, or in a table, the fields last cut or copied from one.",
  run: () => {
    if (atTableP()) e8.call("org-table-paste-rectangle");
    else e8.callWithPrefix(e8.prefixArg(), "org-paste-subtree");
  },
});

e8.defineCommand({
  name: "org-cut-special",
  doc: "Cut the subtree point is in, or in a table, blank the field at point or the fields in the region.",
  // Interactively, with the prefix on, as call-interactively passes it.
  run: () => {
    e8.funcallInteractively(atTableP() ? "org-table-cut-region" : "org-cut-subtree");
  },
});

e8.defineCommand({
  name: "org-copy-special",
  doc: "Copy the subtree point is in, or in a table, the field at point or the fields in the region.",
  // Interactively, with the prefix on, as call-interactively passes it.
  run: () => {
    e8.funcallInteractively(atTableP() ? "org-table-copy-region" : "org-copy-subtree");
  },
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
function nextState(current: string | undefined, direction: number, across = false): string | undefined {
  const sets = todoSets();
  if (sets.length === 0) return undefined;
  // S-<right> and S-<left> go through every sequence's keywords in turn, as
  // org-todo's right and left walk org-todo-keywords-1.
  if (across) {
    const all = sets.flatMap((set) => [...set.todo, ...set.done]);
    if (current === undefined) return direction > 0 ? all[0] : all.at(-1);
    const k = all.indexOf(current) + direction;
    return k >= 0 && k < all.length ? all[k] : undefined;
  }
  if (current === undefined) {
    const set = sets[0];
    const states = [...set.todo, ...set.done];
    return direction > 0 ? states[0] : states.at(-1);
  }
  const set = sets.find((s) => s.todo.includes(current) || s.done.includes(current)) ?? sets[0];
  const states = [...set.todo, ...set.done];
  const k = states.indexOf(current) + direction;
  // A type goes to the set's first done keyword, or with TAB pressed again
  // to the next type, as org-todo's type interpretation; the last done
  // keyword goes to none.
  if (set.type && direction > 0 && current !== set.done.at(-1) && k < states.length) {
    if (e8.lastCommand() === e8.thisCommand()) return states[k];
    return set.done[0] ?? allKeywords().find((w) => isDone(w));
  }
  return k >= 0 && k < states.length ? states[k] : undefined;
}

// TODO dependencies: what may block a change of state, as org.el's
// org-blocker-hook and its two functions.

e8.defineHook("org-blocker-hook", "Functions that may block a change of TODO state, each given a property list (:type todo-state-change :from :to :position); one returning nil blocks it.");
e8.defineHook("org-trigger-hook", "Functions run after a TODO state changes, each given the property list org-blocker-hook gets.");
e8.defineVariable({ name: "org-enforce-todo-dependencies", doc: "Whether TODO children block marking their parent done, and with an ORDERED property on the parent, earlier siblings not done block a sibling.", value: false });
e8.defineVariable({ name: "org-enforce-todo-checkbox-dependencies", doc: "Whether unchecked boxes in an entry block marking it done.", value: false });
e8.defineVariable({ name: "org-inhibit-blocking", doc: "Whether nothing blocks a change of TODO state, whatever the dependencies.", value: false });
e8.defineVariable({
  name: "org-inhibit-logging",
  doc: "Whether a change of TODO state logs nothing (t), or only a time where it would take a note (note), as code binds it.",
  value: false,
});
e8.defineVariable({ name: "org-track-ordered-property-with-tag", doc: "Whether org-toggle-ordered-property also toggles a tag: t for ORDERED, or the tag to use.", value: false });

/** The heading that blocked the last change, as org-block-entry-blocking, and whether checkboxes did, as org-blocked-by-checkboxes. */
let blockEntryBlocking = "";
let blockedByCheckboxes = false;

/** A heading's TODO state, priority, title and tags, one space between, as org-get-heading gives them. */
function headingText(line: number): string {
  const h = parseHeading(line);
  if (!h) return e8.lineText(line).replace(/^\*+[ \t]*/, "");
  return [h.todo, h.priority === undefined ? undefined : `[#${h.priority}]`, h.title, h.tags.length > 0 ? `:${h.tags.join(":")}:` : undefined]
    .filter((x) => x !== undefined && x !== "")
    .join(" ");
}

/** The parent of heading I, the first before it at a lower level, or undefined at the top. */
function parentIndex(all: Heading[], i: number): number | undefined {
  for (let k = i - 1; k >= 0; k--) if (all[k].level < all[i].level) return k;
  return undefined;
}

/** Whether changes of state made in body only say they are blocked, as Org's org-todo called from code does. */
let blockingFromCode = 0;

/** Runs body as a call of org-todo from code, a blocked change only said. */
export function todoFromCode<T>(body: () => T): T {
  blockingFromCode++;
  try {
    return body();
  } finally {
    blockingFromCode--;
  }
}

/**
 * A change of TODO state as org-blocker-hook and org-trigger-hook are
 * given it, Org's property list: (:type todo-state-change :from FROM :to TO
 * :position POS), FROM and TO keywords, or the symbols todo and done.
 */
export function todoChangePlist(from: e8.Value, to: e8.Value, position: number, positionFirst = false): e8.Value[] {
  const sym = (name: string) => e8.intern(name);
  const head = [sym(":type"), sym("todo-state-change")];
  return positionFirst
    ? [...head, sym(":position"), position, sym(":from"), from, sym(":to"), to]
    : [...head, sym(":from"), from, sym(":to"), to, sym(":position"), position];
}

/** A value's name if it is a symbol. */
const symbolNamed = (v: e8.Value, name: string): boolean => typeof v === "symbol" && e8.symbolName(v) === name;

/**
 * Whether a change of TODO state is one the dependencies look at, as both
 * of Org's functions ask: of type todo-state-change, not from done or a
 * done keyword, to something other than todo, a keyword not done, or nil.
 */
function changeIsToDone(change: e8.Value[]): boolean {
  const from = plistGet(change, ":from");
  const to = plistGet(change, ":to");
  if (!symbolNamed(plistGet(change, ":type"), "todo-state-change")) return false;
  if (symbolNamed(from, "done") || (typeof from === "string" && isDone(from))) return false;
  if (!truthy(to) || symbolNamed(to, "todo") || (typeof to === "string" && allKeywords().includes(to) && !isDone(to))) return false;
  return true;
}

/** Org's org-block-todo-from-children-or-siblings-or-parent, put on org-blocker-hook by name. */
function blockFromHierarchy(change: e8.Value[]): boolean | null {
  if (!truthy(e8.variable("org-enforce-todo-dependencies"))) return true;
  if (!changeIsToDone(change)) return true;
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) return true;
  // A child to do, not done, blocks it.
  for (let k = i + 1; k < all.length && all[k].level > all[i].level; k++) {
    if (all[k].todo !== undefined && !isDone(all[k].todo)) {
      blockEntryBlocking = headingText(all[k].line);
      return null;
    }
  }
  const notDone = (h: Heading) => h.todo !== undefined && !isDone(h.todo);
  // Under an ORDERED parent, the first heading to do from the line after
  // the parent to the child, nephews too, as Org searches for one.
  const orderedBlock = (parent: number, child: number): Heading | undefined => {
    if (entryGet(all[parent].line, "ORDERED") === undefined) return undefined;
    for (let k = parent + 1; k < child; k++) if (notDone(all[k])) return all[k];
    return undefined;
  };
  let child = i;
  let parent = parentIndex(all, child);
  if (parent === undefined) return true;
  const first = orderedBlock(parent, child);
  if (first) {
    blockEntryBlocking = e8.lineText(first.line);
    return null;
  }
  // A blocked ancestor to do blocks it too, named by the heading found.
  for (;;) {
    if (!notDone(all[parent])) return true;
    child = parent;
    parent = parentIndex(all, child);
    if (parent === undefined) return true;
    const found = orderedBlock(parent, child);
    if (found) {
      blockEntryBlocking = headingText(found.line);
      return null;
    }
  }
}
e8.defun("org-block-todo-from-children-or-siblings-or-parent", blockFromHierarchy);

/** Org's org-block-todo-from-checkboxes, put on org-blocker-hook by name. */
function blockFromCheckboxes(change: e8.Value[]): boolean | null {
  if (!truthy(e8.variable("org-enforce-todo-checkbox-dependencies"))) return true;
  if (!changeIsToDone(change)) return true;
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) return true;
  const end = all[i + 1]?.line ?? e8.lineCount();
  for (let l = all[i].line + 1; l < end; l++) {
    // By the text, as org-list-search-forward finds them, not asking the parser.
    if (itemLineByText(l) && /^[ \t]*(?:[-+*]|[0-9]+[.)]|[A-Za-z][.)])[ \t]+(?:\[@(?:start:)?(?:[0-9]+|[A-Za-z])\][ \t]*)?\[[- ]\]/.test(e8.lineText(l))) {
      blockedByCheckboxes = true;
      return null;
    }
  }
  return true;
}
e8.defun("org-block-todo-from-checkboxes", blockFromCheckboxes);

/** The checks org-mode has put on org-blocker-hook, as its add-hook and remove-hook keep them there once. */
const blockersHooked = new Set<(change: e8.Value[]) => boolean | null>();

/** Puts a check on org-blocker-hook, or takes it off, as org-mode does when it starts. */
function hookBlocker(check: (change: e8.Value[]) => boolean | null, on: boolean): void {
  if (on && !blockersHooked.has(check)) {
    e8.addHook("org-blocker-hook", check);
    blockersHooked.add(check);
  } else if (!on && blockersHooked.has(check)) {
    e8.removeHook("org-blocker-hook", check);
    blockersHooked.delete(check);
  }
}

/** Bypasses blocking for the change C-u C-u C-u C-c C-t makes, as org-todo sets org-blocker-hook to nil. */
let blockingBypassed = false;

/**
 * Whether a change of state from BEFORE to NEXT goes ahead, as org-todo
 * asks org-blocker-hook, widened: if not, it signals when the command was
 * called interactively and otherwise says so and does nothing.
 */
function todoChangeAllowed(h: Heading, change: e8.Value, before: string | undefined, next: string | undefined): boolean {
  if (blockingBypassed || truthy(e8.variable("org-inhibit-blocking")) || entryGet(h.line, "NOBLOCKING") !== undefined) return true;
  blockedByCheckboxes = false;
  const allowed = e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.widen();
      e8.gotoChar(h.start);
      return e8.runHookWithArgsUntilFailure("org-blocker-hook", change);
    }),
  );
  if (allowed) return true;
  const reason = blockedByCheckboxes ? "contained checkboxes" : `"${blockEntryBlocking}"`;
  const message = `TODO state change from ${before ?? "nil"} to ${next ?? "nil"} blocked (by ${reason})`;
  // Only said from code, in a keyboard macro and in a loop over the region, which calls org-todo from code, so it goes on.
  if (e8.calledInteractively() && mapRegionStart === undefined && blockingFromCode === 0 && !e8.executingKbdMacro()) e8.userError(message);
  e8.message(message);
  return false;
}

/** Whether the entry at heading H is blocked, as org-entry-blocked-p: not NOBLOCKING, to do, and blocked from being done; asked from AT, the heading's start unless given, as Org asks from point. */
export function entryBlocked(h: Heading, at = h.start): boolean {
  if (entryGet(h.line, "NOBLOCKING") !== undefined || h.todo === undefined || isDone(h.todo)) return false;
  return !e8.saveExcursion(() => {
    e8.gotoChar(at);
    return e8.runHookWithArgsUntilFailure("org-blocker-hook", todoChangePlist(e8.intern("todo"), e8.intern("done"), at, true));
  });
}

/** Whether the entry at point is blocked from being done, as org-entry-blocked-p. */
e8.defun("org-entry-blocked-p", () => {
  const all = headings();
  const i = headingIndex(all, lineAt());
  // From point, which stays where it is, as Org's passes :position (point).
  return i !== undefined && entryBlocked(all[i], e8.point());
});

/**
 * Whether the entry at heading H is blocked, as org-entry-blocked-p, and if
 * so whether by checkboxes, as org-blocked-by-checkboxes says after it:
 * Org's agenda asks this with org-blocked-by-checkboxes bound, so the
 * value it had is kept.
 */
export function entryBlockedBy(h: Heading): "blocked" | "checkboxes" | undefined {
  const saved = blockedByCheckboxes;
  blockedByCheckboxes = false;
  try {
    if (!entryBlocked(h)) return undefined;
    return blockedByCheckboxes ? "checkboxes" : "blocked";
  } finally {
    blockedByCheckboxes = saved;
  }
}

e8.defineCommand({
  name: "org-toggle-ordered-property",
  doc: "Toggle the ORDERED property of the current entry, which makes its children be done in order. With org-track-ordered-property-with-tag, toggle a tag too.",
  run: () => {
    const track = e8.variable("org-track-ordered-property-with-tag");
    const tag = truthy(track ?? null) ? (typeof track === "string" ? track : "ORDERED") : undefined;
    e8.saveExcursion(() => {
      const [all, i] = backToHeading();
      const toggleTag = (on: boolean) => {
        if (tag === undefined) return;
        const h = headings().find((x) => x.start === all[i].start)!;
        const tags = on ? (h.tags.includes(tag) ? h.tags : [...h.tags, tag]) : h.tags.filter((t) => t !== tag);
        e8.gotoChar(h.start);
        e8.call("org-set-tags", tags.join(":"));
      };
      if (entryGet(all[i].line, "ORDERED") !== undefined) {
        e8.call("org-delete-property", "ORDERED");
        toggleTag(false);
        e8.message("Subtasks can be completed in arbitrary order");
      } else {
        entryPut(all[i].line, "ORDERED", "t");
        toggleTag(true);
        e8.message("Subtasks must be completed in sequence");
      }
    });
  },
});

/**
 * Changes the TODO state of the heading point is under, as org-todo does:
 * the keyword, then the tags, CLOSED, the parent's statistics and a
 * repeat, then point just after the keyword if it was near it.
 */
/**
 * How org-todo's prefix arguments change a change of state: a note forced
 * (C-u), a note made a time (0), and the next or previous set of keywords
 * (C-u C-u, nextset and previousset), which logs nothing unless forced.
 */
interface TodoOptions {
  forceLog?: boolean;
  inhibitNote?: boolean;
  set?: 1 | -1;
  /** Whether org-todo was given the state, as by a number, a set or S-<right>, rather than cycling or fast selection. */
  chosen?: boolean;
}

function todo(direction: number, state?: string, across = false, options: TodoOptions = {}): void {
  const [all0, i0] = backToHeading();
  const logging = entryGetInherited(all0[i0], "LOGGING");
  if (logging !== undefined) withLocalLogging(logging, () => todoLogged(direction, state, across, options));
  else todoLogged(direction, state, across, options);
}

/**
 * The first keyword of the set after (or before) the one the state is in,
 * as org-todo's nextset and previousset take it, wrapping round; with no
 * state, from the first set.
 */
function setHead(current: string | undefined, direction: 1 | -1, line: number): string | undefined {
  const sets = todoSets();
  const heads = sets.map((set) => [...set.todo, ...set.done][0]);
  const head = sequenceHead(current, line);
  const at = head === undefined ? -1 : heads.indexOf(head);
  // With no head found, the first set's, or with previousset the last's, as member finds none then.
  if (at < 0) return direction > 0 ? heads[0] : heads.at(-1);
  return heads[(at + direction + heads.length) % heads.length];
}

/**
 * The first keyword of the set a state is in, as org-get-todo-sequence-head:
 * for no state, the set the heading was last in, as org-todo leaves it in
 * the line's org-todo-head property; for a word that is no state, the first
 * keyword of all.
 */
function sequenceHead(kwd: string | undefined, line: number): string | undefined {
  if (kwd === undefined) {
    const [ls, le] = [e8.lineStart(line), e8.lineEnd(line)];
    const here = e8.getTextProperty(ls, "org-todo-head");
    if (typeof here === "string") return here;
    const p = e8.nextSinglePropertyChange(ls, "org-todo-head", le);
    const there = p !== undefined && p < le ? e8.getTextProperty(p, "org-todo-head") : undefined;
    return typeof there === "string" ? there : undefined;
  }
  const set = todoSets().find((t) => t.todo.includes(kwd) || t.done.includes(kwd));
  return set === undefined ? allKeywords()[0] : [...set.todo, ...set.done][0];
}

function todoLogged(direction: number, state?: string, across = false, options: TodoOptions = {}): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const before = h.todo;
  const next =
    options.set !== undefined
      ? setHead(before, options.set, h.line)
      : state === undefined
        ? // From no state, the set the heading was last in, as org-todo's head.
          (before === undefined && direction > 0 && !across ? (sequenceHead(undefined, h.line) ?? nextState(before, direction, across)) : nextState(before, direction, across))
        : state === "" ? undefined : state;
  // The set's head the line remembers, as org-todo leaves org-todo-head: the old state's, or the new one's when it was given and is not done.
  let head = sequenceHead(before, h.line);
  const change: e8.Value = todoChangePlist(before ?? null, next ?? null, h.start);
  if (!todoChangeAllowed(h, change, before, next)) return;
  replaceTodoKeyword(h, next);
  if (parseHeading(h.line)?.tagsAt !== undefined) alignTagsAway(h.line);
  if (next !== undefined && next === before) e8.message(`TODO state was already ${next}`);
  if ((options.chosen || options.set !== undefined) && next !== undefined && !isDone(next)) head = sequenceHead(next, h.line);
  e8.putTextProperty(e8.lineStart(h.line), e8.lineEnd(h.line), "org-todo-head", head ?? null);
  if (options.set !== undefined) {
    // As org-todo says which set it went to: its place among the sets, and its keywords.
    const sets = todoSets();
    const k = sets.findIndex((set) => next !== undefined && [...set.todo, ...set.done][0] === next);
    if (k >= 0) e8.message(`Keyword-Set ${k + 1}/${sets.length}: ${[...sets[k].todo, ...sets[k].done].join(" ")}`);
  }
  const logDone = e8.variable("org-log-done");
  // Logged as the states and org-log-done say, but not for a new set of keywords, unless C-u forces a note.
  // Nothing logged with org-inhibit-logging t, and a note only a time with note, as code binds it.
  const inhibit = e8.variable("org-inhibit-logging") ?? null;
  const logs = ((logStates().length > 0 || truthy(logDone ?? null)) && inhibit !== true && options.set === undefined) || options.forceLog === true;
  if (inhibit === "note") options = { ...options, inhibitNote: true };
  let dolog = !logs ? undefined : options.forceLog ? "note" : logHow(next, before);
  // With a prefix of 0, a note is only a time, as org-inhibit-logging note says.
  if (options.inhibitNote && dolog === "note") dolog = "time";
  // As org-todo: CLOSED goes when the state does, or goes back to not done; it comes when done.
  if (logs) {
    const notDone = (k: string | undefined) => k !== undefined && !isDone(k);
    // No state keeps CLOSED with org-closed-keep-when-no-todo.
    if ((next === undefined && !truthy(e8.variable("org-closed-keep-when-no-todo") ?? null)) || (notDone(next) && !notDone(before))) setPlanning(h.line, "CLOSED", undefined);
    // At the planning line's start, as org-add-planning-info puts a keyword it adds.
    if (isDone(next) && !isDone(before) && logDone !== null && logDone !== false) addPlanningInfo(h.line, "CLOSED", `[${formatTimestamp(today(true), true)}]`, []);
  }
  updateParentTodoStatistics(h.line);
  // What to log, as org-todo's org-add-log-setup calls: a closing note
  // when org-log-done asks for one and the state logs nothing, else the
  // state as its ! or @ says.
  let setup: { purpose: string; how: string; state?: string; previous?: string } | undefined;
  if (logs && dolog === undefined && isDone(next) && !isDone(before) && logDone === "note") setup = { purpose: "done", how: "note", state: next, previous: before };
  if (next !== undefined && dolog !== undefined) setup = { purpose: "state", how: dolog, state: next, previous: before };
  // A repeat, as org-auto-repeat-maybe: a note already set up is taken as
  // a note if org-log-repeat is note, else the repeat is logged as its state.
  const repeat = isDone(next) && !isDone(before) ? autoRepeat(h.line, before, next as string) : undefined;
  // With a LOGGING property, the state the repeat goes back to logs as it
  // says, as org-auto-repeat-maybe's own org-todo reads LOGGING again.
  const back = repeat !== undefined && localLogStates !== undefined ? parseHeading(h.line)?.todo : undefined;
  // A note made a time with a prefix of 0, as the repeat's own org-todo sees org-inhibit-logging note too.
  const backLogged = back !== undefined ? logHow(back, next) : undefined;
  const backLog = options.inhibitNote && backLogged === "note" ? "time" : backLogged;
  if (backLog !== undefined) setup = { purpose: "state", how: backLog, state: back, previous: next };
  const logRepeat = e8.variable("org-log-repeat");
  if (repeat !== undefined && truthy(logRepeat)) {
    if (setup !== undefined) {
      if (logRepeat === "note") setup.how = "note";
    } else setup = { purpose: "state", how: logRepeat === "note" ? "note" : "time", state: repeat[0], previous: repeat[1] };
  }
  const setupsBefore = setups;
  e8.runHooks("org-after-todo-state-change-hook");
  // A note the hook set up, as stopping the clock does, replaces the state's.
  if (setups !== setupsBefore) setup = undefined;
  fixPositionAfterTodo(h.line);
  e8.saveExcursion(() => e8.runHooks("org-trigger-hook", change));
  // Org stores the note from post-command-hook, after the command, asking
  // for one in *Org Note* when the state's @ says so.
  if (setup?.how === "note") addLogNote(h.line, setup.purpose, setup.state, setup.previous);
  else if (setup !== undefined) storeLogNote(h.line, setup.purpose, setup.state, setup.previous, []);
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
        eraseBuffer();
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
 * Returns the state it was marked and the one before, if it repeated.
 */
function autoRepeat(line: number, last: string | undefined, done: string): [string, string] | undefined {
  const h = parseHeading(line) as Heading;
  const all = headingsAsRead();
  const end = entryEnd(all, headingIndex(all, line) as number);
  const repeating = /<[0-9]{4}-[0-9][0-9]-[0-9][0-9] [^>\n]*?([.+]?\+([0-9]+)[hdwmy](?:\/[0-9]+[hdwmy])?)/;
  let found = false;
  // The entry's first repeater, its heading's included, as org-get-repeat looks from the heading.
  for (let l = line; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    const m = repeating.exec(e8.lineText(l));
    if (m) {
      found = Number(m[2]) !== 0;
      break;
    }
  }
  if (!found) return undefined;
  // Back to REPEAT_TO_STATE's state or org-todo-repeat-to-state's, if a keyword; else a type back to
  // itself; else the first state of its sequence, or none, as org-auto-repeat-maybe.
  const set = todoSets().find((t) => last !== undefined && (t.todo.includes(last) || t.done.includes(last)));
  const option = e8.variable("org-todo-repeat-to-state") ?? null;
  const property = propertyInheritP("REPEAT_TO_STATE") ? entryGetInherited(h, "REPEAT_TO_STATE") : entryGet(line, "REPEAT_TO_STATE");
  const wanted = property ?? (typeof option === "string" ? option : truthy(option) ? last : undefined);
  const to = wanted !== undefined && allKeywords().includes(wanted) ? wanted : set?.type ? last : set ? set.todo[0] ?? set.done[0] : undefined;
  const p = marker(e8.point());
  e8.gotoChar(h.start);
  // Back to do, as org-auto-repeat-maybe's own org-todo: asked of org-blocker-hook as a call from code, so a refusal only says
  // so and the entry stays done, its dates moved on all the same; then org-trigger-hook is told of it first.
  const back = todoChangePlist(done, to ?? null, h.start);
  if (todoFromCode(() => todoChangeAllowed(parseHeading(line) as Heading, back, done, to))) {
    replaceTodoKeyword(parseHeading(line) as Heading, to);
    e8.saveExcursion(() => e8.runHooks("org-trigger-hook", back));
  }
  if (parseHeading(line)?.tagsAt !== undefined) alignTagsAway(line);
  updateParentTodoStatistics(line);
  setPlanning(line, "CLOSED", undefined);
  const log = e8.variable("org-log-repeat");
  if (log) entryPut(line, "LAST_REPEAT", `[${formatTimestamp(today(true), true)}]`);
  // A SCHEDULED without a repeater is no longer relevant, and goes, as
  // org-auto-repeat-maybe removes it.
  const planning = line + 1 < e8.lineCount() ? e8.lineText(line + 1) : "";
  const scheduled = /SCHEDULED: *(<[^>\n]*>)/.exec(planning)?.[1];
  if (scheduled !== undefined && !repeating.test(scheduled)) setPlanning(line, "SCHEDULED", undefined);
  repeatEntry(parseHeading(line) as Heading);
  e8.gotoChar(p.pos);
  dropMarker(p);
  return [done, last ?? ""];
}

/**
 * Brings the statistics cookie of a heading's parent up to date with its
 * children's TODO states, as org-update-parent-todo-statistics does: the
 * children at the heading's level with a state, and those done.
 */
export function updateParentTodoStatistics(line: number): void {
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
    let arg = e8.prefixArg();
    const options: TodoOptions = {};
    // C-u C-u goes to the next set of keywords.
    if (Array.isArray(arg) && arg[0] === 16) {
      options.set = 1;
      arg = null;
    }
    // -1 cancels the repeater first, so the entry can be marked done, each heading's as the region loop reaches it; below -1 is no argument org-todo takes.
    let cancel = false;
    if (arg !== null && e8.prefixNumericValue(arg) === -1) {
      cancel = true;
      arg = null;
    }
    if (arg !== null && e8.prefixNumericValue(arg) < -1) e8.userError(`Prefix argument ${e8.prefixNumericValue(arg)} not supported`);
    // C-u C-u C-u changes it whatever blocks it, as org-todo does with (64).
    const bypass = Array.isArray(arg) && arg[0] === 64;
    if (bypass) arg = null;
    // C-u forces a note, and 0 makes a note a time; neither picks a state.
    if (Array.isArray(arg) && arg[0] === 4) {
      options.forceLog = true;
      arg = null;
    }
    if (arg === 0) {
      options.inhibitNote = true;
      arg = null;
    }
    // A number picks that state; with fast-access keys, a key does, as org-use-fast-todo-selection says.
    const fast = e8.variable("org-use-fast-todo-selection");
    const change = () => {
      if (cancel) cancelRepeater();
      if (options.set !== undefined) todo(1, undefined, false, { ...options, chosen: true });
      else if (typeof arg === "number" && arg > 0) {
        const kw = allKeywords()[arg - 1];
        todo(1, kw ?? "", false, { ...options, chosen: true });
      } else if (arg === null && fast !== null && fast !== false && todoSets().some((s) => s.keys.some(([, k]) => k !== undefined))) {
        const [all, i] = backToHeading();
        todo(1, fastTodoSelection(all[i].todo) ?? "", false, options);
      } else todo(1, undefined, false, options);
    };
    const outer = blockingBypassed;
    blockingBypassed = bypass;
    try {
      if (!forEachHeadingInRegion(change, { hiddenPoint: true })) change();
    } finally {
      blockingBypassed = outer;
    }
  },
});

/**
 * Sets the repeater of the entry's first timestamp to 0, as
 * org-cancel-repeater does: the first SCHEDULED, DEADLINE or active
 * timestamp in the entry, and the last repeater from the heading to its end.
 */
function cancelRepeater(): void {
  e8.saveExcursion(() => {
    const [all, i] = backToHeading();
    const start = all[i].start;
    e8.gotoChar(start);
    const end = all[i + 1]?.start ?? e8.pointMax();
    const ts = "\\(\\<SCHEDULED: *<\\([^>]+\\)>\\)\\|\\(\\<DEADLINE: *<\\([^>]+\\)>\\)\\|\\(<\\([0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\} ?[^\r\n>]*?\\)>\\)";
    if (e8.reSearchForward(ts, { bound: end, noerror: true }) === undefined) return;
    if (e8.reSearchBackward("[ \t]+\\(?:[.+]\\)?\\+\\([0-9]+\\)[hdwmy]", { bound: start, noerror: true }) === undefined) return;
    const [b, e] = [e8.matchBeginning(1)!, e8.matchEnd(1)!];
    edReplace(b, e, "0");
  });
}

/** Switches the heading point is under to the next (1) or previous (-1) set of keywords, as org-todo with nextset or previousset. */
export function todoToSet(direction: 1 | -1): void {
  todo(1, undefined, false, { set: direction, chosen: true });
}

e8.defineCommand({ name: "org-cancel-repeater", doc: "Set the repeater of the entry's first timestamp to 0, so marking it done does not repeat it.", run: () => cancelRepeater() });

for (const [name, set, doc, motion] of [
  ["org-shiftcontrolright", 1, "C-S-<right> in Org: switch the heading to the next set of TODO keywords.", "forward-word"],
  ["org-shiftcontrolleft", -1, "C-S-<left> in Org: switch the heading to the previous set of TODO keywords.", "backward-word"],
] as const) {
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const support = shiftSupport();
      if (support !== "off" && orgRegionActive()) callForShiftSelect(motion);
      else if (support !== "always" && headingHere()) {
        // As org-todo with nextset or previousset, over the region's headings too.
        const one = () => todo(1, undefined, false, { set, chosen: true });
        if (!forEachHeadingInRegion(one, { hiddenPoint: true })) one();
      }
      else if (support !== "off") callForShiftSelect(motion);
      else shiftSelectError();
    },
  });
}

/**
 * Where org-map-entries has narrowed to the region it loops over, if it is
 * looping: headings above it are out of reach, so their cookies stay.
 */
let mapRegionStart: Marker | undefined;

/** Where a command's loop over the active region goes, as org-map-entries's scopes region, region-start-level and nil. */
export type RegionScope = "region" | "region-start-level" | "buffer";

/**
 * Runs body at each visible heading in the active region, as org-map-entries
 * does for commands when org-loop-over-headlines-in-active-region is on.
 * Returns whether it applied.
 *
 * With hiddenPoint, a command that gives org-map-entries (when
 * (org-invisible-p) (org-end-of-subtree nil t)) to skip with only moves
 * point to the end of a hidden subtree it starts in. With hidden, headings
 * hidden when reached are visited too. With narrow, the region is narrowed
 * to as org-map-entries narrows, so what body adds at the end of the
 * buffer goes there. A body that returns a position has the next heading
 * looked for from there, as one that sets org-map-continue-from, as
 * org-archive-subtree does before it removes its subtree.
 *
 * Any value of the option but nil loops, a string too, as the commands
 * give org-map-entries no matcher. With start-level, only the headings at
 * the level of the region's first are visited, as org-map-entries's
 * region-start-level scope; scope gives the scope a command asks for
 * instead, as org-archive-to-archive-sibling's "buffer", the whole
 * accessible buffer, where its region scope is lost.
 */
export function forEachHeadingInRegion(
  body: () => number | void,
  { hiddenPoint = false, hidden = false, narrow = false, scope = undefined as ((loop: e8.Value | undefined) => RegionScope) | undefined } = {},
): boolean {
  const mark = e8.mark();
  const option = e8.variable("org-loop-over-headlines-in-active-region");
  if (!orgRegionActive() || mark === undefined || !truthy(option)) return false;
  const how = scope ? scope(option) : option === "start-level" ? "region-start-level" : "region";
  const [rb, re] = how === "buffer" ? [e8.pointMin(), e8.pointMax()] : [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  if (hiddenPoint && e8.invisibleAt(e8.point())) {
    // org-todo gives org-map-entries (when (org-invisible-p) (org-end-of-subtree
    // nil t)) to skip with, which runs once, there and then: point goes to the
    // end of the hidden subtree, and that position skips every heading. A
    // scan of the whole buffer starts from its beginning all the same.
    const all = headings();
    const i = headingIndex(all, lineAt());
    e8.gotoChar(i === undefined ? e8.bufferSize() : subtreeRegion(all, i)[1]);
    if (how !== "buffer") return true;
  }
  const outer = mapRegionStart;
  mapRegionStart = how === "buffer" ? undefined : marker(rb);
  const atHeadingStart = re === e8.lineStart(lineAt(re)) && parseHeading(lineAt(re)) !== undefined;
  const end = marker(how === "buffer" || atHeadingStart ? re : (headings().find((h) => h.start > re)?.start ?? e8.pointMax()));
  // The level of the first heading from the region's start, as org-map-entries reads it before it narrows.
  const level = how === "region-start-level" ? headings().find((h) => h.start >= e8.lineStart(lineAt(rb)))?.level : undefined;
  const origin = marker(e8.point());
  const loop = () => {
    let at = marker(rb);
    for (;;) {
      const h = headings().find((x) => x.start >= at.pos && x.start < end.pos && (level === undefined || x.level === level));
      if (!h) break;
      dropMarker(at);
      at = marker(h.end);
      if (!hidden && e8.invisibleAt(h.start)) continue;
      e8.gotoChar(h.start);
      const tick = e8.bufferCharsModifiedTick();
      const from = body();
      // Not back to where nothing changed, which would go round for ever.
      if (typeof from === "number" && (from > h.start || e8.bufferCharsModifiedTick() !== tick)) at.pos = from;
    }
    dropMarker(at);
  };
  try {
    if (narrow && how !== "buffer")
      e8.saveRestriction(() => {
        e8.narrowToRegion(rb, end.pos);
        loop();
      });
    else loop();
  } finally {
    e8.gotoChar(origin.pos);
    dropMarker(origin);
    dropMarker(end);
    if (mapRegionStart) dropMarker(mapRegionStart);
    mapRegionStart = outer;
  }
  return true;
}

e8.defineCommand({
  name: "org-todo-set",
  doc: "Set the TODO state of the heading point is under, or remove it with an empty state.",
  params: [{ name: "state", prompt: "TODO state: " }],
  run: (state) => todo(1, state, false, { chosen: true }),
});

e8.defineVariable({ name: "org-priority-enable-commands", doc: "Whether the priority commands work; when nil, they refuse, so a priority is never set by accident.", value: true });
e8.defineVariable({
  name: "org-priority-start-cycle-with-default",
  doc: "Whether raising or lowering a heading with no priority starts at org-priority-default, rather than one above or below it.",
  value: true,
});
e8.defineVariable({
  name: "org-priority-get-priority-function",
  doc: "A function of a heading's text giving its priority as a number, instead of its cookie and org-priority-lowest.",
  value: null,
});

/**
 * A priority option as a number, as Org's characters are: a letter's
 * code, or a number as it is, as for numeric priorities.
 */
function priorityOption(name: string, fallback: string): number {
  const v = e8.variable(name) ?? fallback;
  return typeof v === "number" ? v : String(v || fallback).codePointAt(0)!;
}

/** A priority cookie's value, as org-priority-to-value: its number, else its first character's code. */
function priorityToValue(s: string): number {
  const m = /([0-9]+)/.exec(s);
  return m ? Number(m[1]) : s.codePointAt(0)!;
}

/** A priority cookie in a heading, as org-priority-regexp matches it, case folded: the cookie with a space after it, and its value. */
const PRIORITY_COOKIE = /^.*?(\[#([A-Za-z0-9]+)\] ?)/;

/** A heading's priority as a number, as org-get-priority gives it: a thousand for each step below the lowest. */
export function getPriority(s: string): number {
  const fn = e8.variable("org-priority-get-priority-function");
  // Only a function, as Org checks functionp, the cookie read otherwise.
  if (typeof fn === "function" || (typeof fn === "string" && fn !== "" && e8.fboundp(fn))) {
    return Number(e8.funcall(fn as string | ((...args: e8.Value[]) => e8.Value), s));
  }
  const lowest = priorityOption("org-priority-lowest", "C");
  const m = PRIORITY_COOKIE.exec(s);
  return 1000 * (lowest - (m ? priorityToValue(m[2]) : priorityOption("org-priority-default", "B")));
}

/** A key read by read-char-exclusive, as the character it stands for: a control character for C-a and the like. */
export function keyChar(key: string): number {
  const named: Record<string, number> = { SPC: 32, RET: 13, TAB: 9, ESC: 27, DEL: 127 };
  if (named[key] !== undefined) return named[key];
  const control = /^C-([a-z@[\\\]^_])$/.exec(key);
  if (control) return control[1].toUpperCase().charCodeAt(0) & 31;
  return [...key].length === 1 ? key.codePointAt(0)! : -1;
}

/**
 * As Emacs's upcase of a character: its one-character capital, ß as ẞ,
 * and itself where Emacs has none, as dotless ı, or for what is no
 * character.
 */
function upcase(c: number): number {
  if (!Number.isInteger(c) || c < 0 || c > 0x10ffff) return c;
  if (c === 0xdf) return 0x1e9e;
  if (c === 0x131) return c;
  const upper = [...String.fromCodePoint(c).toUpperCase()];
  return upper.length === 1 ? upper[0].codePointAt(0)! : c;
}

/** The action org-priority takes: set, asking for it, up, down, remove, or a priority's character. */
export type PriorityAction = "set" | "up" | "down" | "remove" | number;

/**
 * Changes the priority of the heading point is under, as org-priority:
 * setting it to a character read, or ACTION's, SPC removing it, raising or
 * lowering it, wrapping past the highest or lowest to none, and aligning
 * the tags after.
 */
export function setPriority(action: PriorityAction = "set"): void {
  if (!truthy(e8.variable("org-priority-enable-commands") ?? true)) e8.userError("Priority commands are disabled");
  const highest = priorityOption("org-priority-highest", "A");
  const lowest = priorityOption("org-priority-lowest", "C");
  const fallback = priorityOption("org-priority-default", "B");
  const nump = lowest < 65;
  const [all, i] = backToHeading();
  const h = all[i];
  const cookie = PRIORITY_COOKIE.exec(e8.lineText(h.line));
  const current = cookie ? priorityToValue(cookie[2]) : undefined;
  let remove = false;
  let next: number;
  if (action === "remove") {
    remove = true;
    next = 32;
  } else if (action === "set" || typeof action === "number") {
    if (typeof action === "number") next = action;
    else if (nump) {
      const prompt = `Priority ${highest}-${lowest}, SPC to remove: `;
      let s: string;
      if (lowest > 9) s = e8.readString(prompt);
      else {
        // Said, then a key read, as Org's message and read-char-exclusive.
        e8.message(prompt);
        const c = keyChar(e8.readCharExclusive());
        s = c < 0 ? "" : String.fromCodePoint(c);
      }
      next = s === " " ? 32 : Number.parseInt(s, 10) || 0;
    } else {
      e8.message(`Priority ${String.fromCodePoint(highest)}-${String.fromCodePoint(lowest)}, SPC to remove: `);
      next = keyChar(e8.readCharExclusive());
    }
    if (upcase(highest) === highest && upcase(lowest) === lowest) next = upcase(next);
    if (next === 32) remove = true;
    else if (upcase(next) < highest || upcase(next) > lowest) {
      const show = (c: number) => (nump ? String(c) : String.fromCodePoint(c));
      e8.userError(`Priority must be between \u2018${show(highest)}\u2019 and \u2018${show(lowest)}\u2019`);
    }
  } else {
    const again = e8.lastCommand() === e8.thisCommand();
    const start = truthy(e8.variable("org-priority-start-cycle-with-default") ?? true);
    next = action === "up"
      ? current !== undefined ? current - 1 : again ? lowest : start ? fallback : fallback - 1
      : current !== undefined ? current + 1 : again ? highest : start ? fallback : fallback + 1;
  }
  if (upcase(next) < highest || upcase(next) > lowest) {
    if ((action === "up" || action === "down") && current === undefined && e8.lastCommand() !== e8.thisCommand()) {
      e8.signal("error", "The default can not be set, see \u2018org-priority-default\u2019 why");
    }
    remove = true;
  }
  // A character past 64, else a number, as Org writes it.
  const news = next > 64 && next <= 0x10ffff ? String.fromCodePoint(next) : String(next);
  const p = marker(e8.point());
  try {
    if (cookie) {
      const start = h.start + charCount(cookie[0].slice(0, cookie[0].length - cookie[1].length));
      if (remove) edDelete(start, start + charCount(cookie[1]));
      // replace-match on the value alone: point after it stays after it.
      else edReplace(start + 2, start + 2 + charCount(cookie[2]), news);
    } else if (remove) {
      e8.userError("No priority cookie found in line");
    } else if (h.todoAt !== undefined) {
      edInsert(h.todoAt + charCount(h.todo ?? ""), ` [#${news}]`);
    } else {
      edInsert(h.titleAt, `[#${news}] `);
    }
    if (truthy(e8.variable("org-auto-align-tags") ?? true) && parseHeading(h.line)?.tagsAt !== undefined) alignTagsAway(h.line);
  } finally {
    e8.gotoChar(p.pos);
    dropMarker(p);
  }
  e8.message(remove ? "Priority removed" : `Priority of current item set to ${news}`);
}

/** Says the priority of the heading on point's line, as org-priority-show: -1000 off a heading. */
export function showPriority(): number {
  const text = e8.lineText(lineAt());
  // On a heading, stars alone too, as org-heading-regexp matches it.
  const pri = /^\*+(?:[ \t].*)?$/.test(text) ? getPriority(text) : -1000;
  e8.message(`Priority is ${pri}`);
  return pri;
}

e8.defineCommand({
  name: "org-priority-up",
  doc: "Raise the priority of the heading point is under: none starts at the default, and above the highest is none.",
  run: () => setPriority("up"),
});

e8.defineCommand({
  name: "org-priority-down",
  doc: "Lower the priority of the heading point is under: none starts at the default, and below the lowest is none.",
  run: () => setPriority("down"),
});

e8.defineCommand({
  name: "org-priority",
  doc:
    "Set the priority of the heading point is under to the key typed, or remove it with SPC. With C-u, say its priority instead. " +
    "From code, setPriority from org takes up, down, remove or a character.",
  params: [{ name: "action", kind: "prefix" }],
  run: (action: e8.PrefixArg) => {
    if (Array.isArray(action) && action[0] === 4) showPriority();
    // A number from code or a numeric prefix, as Org takes an integer for the character; C-u C-u or - is no action.
    else if (typeof action === "number") setPriority(action);
    else if (action === null || action === undefined) setPriority("set");
    else e8.userError("Invalid action");
  },
});

e8.defineCommand({
  name: "org-priority-show",
  doc: "Say the priority of the heading on point's line, as a number: a thousand for each step below org-priority-lowest.",
  run: () => {
    showPriority();
  },
});

/** Puts a heading's tags at org-tags-column, or a space after the title if it is too long. */
export function alignTags(line: number): void {
  const text = e8.lineText(line);
  const m = /^\*+ (?:.*[ \t])?(:[\p{L}\p{M}\p{Nd}\p{Nl}_@#%:]+:)[ \t]*$/u.exec(text);
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
  // Unchanged tags are aligned again all the same, as org-set-tags does.
  if (tags.join(":") === h.tags.join(":")) {
    if (tags.length > 0) alignTags(h.line);
    return;
  }
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

/**
 * Toggles TAG on the heading point is under, or with ONOFF "on" or "off"
 * sets it so, as org-toggle-tag: a new tag goes last; whether it is on.
 */
export function toggleTag(tag: string, onoff?: "on" | "off"): boolean {
  return e8.saveExcursion(() => {
    const [all, i] = backToHeading();
    const current = all[i].tags;
    const on = onoff === "on" || (onoff === undefined && !current.includes(tag));
    setTags(on ? (current.includes(tag) ? current : [...current, tag]) : current.filter((t) => t !== tag));
    return on;
  });
}

e8.defun("org-toggle-tag", (tag: e8.Value, onoff?: e8.Value) => {
  const how = typeof onoff === "symbol" ? onoff.description : onoff;
  return toggleTag(String(tag), how === "on" || how === "off" ? how : undefined) || undefined;
});

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
  doc: "Whether picking a tag by its key in fast tag selection finishes at once; expert also leaves the tags unshown until C-c.",
  value: false,
});
e8.defineVariable({
  name: "org-tag-persistent-alist",
  doc: "Tags offered in every file, before org-tag-alist's or a file's TAGS lines', as [tag, key] lists; #+STARTUP: noptag leaves them out.",
  value: [],
});
e8.defineVariable({
  name: "org-fast-tag-selection-maximum-tags",
  doc: "How many tags without keys of their own and outside groups fast tag selection shows, each given a key in turn.",
  value: 56,
});
e8.defineVariable({
  name: "org-fast-tag-selection-include-todo",
  doc: "Whether fast tag selection offers the TODO states with their keys too, a key setting the heading's state.",
  value: false,
});
e8.defineVariable({ name: "org-use-tag-inheritance", doc: "Whether headings inherit the tags of those above them and the file's.", value: true });
e8.defineFace({ name: "org-tag-group", doc: "The tag that names a group of tags.", attributes: { inherit: "org-tag" } });

// Tag tables, as org-tag-alist and the TAGS keyword give them.

/** A tag table's entry: a tag and its key, or a keyword such as :startgroup with a group's name. */
export type TagEntry = [string, string | undefined];
const TAG_KEYWORDS = new Set([":startgroup", ":endgroup", ":startgrouptag", ":endgrouptag", ":grouptags", ":newline"]);
export const isTagKeyword = (tag: string): boolean => TAG_KEYWORDS.has(tag);

/** A tag table from a variable's value: [tag, key] lists, a key a character or its code. */
function tagTable(value: e8.Value): TagEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): TagEntry[] => {
    if (typeof e === "string") return [[e, undefined]];
    if (!Array.isArray(e) || typeof e[0] !== "string") return [];
    const key = e[1];
    return [[e[0], typeof key === "number" ? String.fromCodePoint(key) : typeof key === "string" && key !== "" ? key : undefined]];
  });
}

/**
 * The table a TAGS keyword's value, its lines joined, makes, as
 * org-tag-string-to-alist: { } and [ ] around groups, : after a group's
 * tag, (k) after a tag for its key, and a line's end a :newline.
 */
export function tagStringToAlist(s: string): TagEntry[] {
  const out: TagEntry[] = [];
  let groupFlag = false;
  for (const line of s.split("\n").filter((l) => l !== "")) {
    out.push([":newline", undefined]);
    const tokens = line.split(/[ \t\n\r\f\v]+/).filter((t) => t !== "");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "{" || token === "[") {
        out.push([token === "{" ? ":startgroup" : ":startgrouptag", undefined]);
        if (tokens[i + 2] === ":") groupFlag = true;
      } else if (token === "}" || token === "]") {
        out.push([token === "}" ? ":endgroup" : ":endgrouptag", undefined]);
        groupFlag = false;
      } else if (token === ":") out.push([":grouptags", undefined]);
      else {
        const m = /^([\p{L}\p{M}\p{Nd}\p{Nl}_@#%]+|\{.+?\})(?:\((.)\))?$/u.exec(token);
        // Tags in groups whether or not they came before, as one may be in several.
        if (m && (groupFlag || !out.some(([t]) => t === m[1]))) out.push([m[1], m[2]]);
      }
    }
  }
  return out.slice(1);
}

/** ALIST1's tags before ALIST2's, its tags already in ALIST2 left out unless in a group, as org--tag-add-to-alist. */
export function tagAddToAlist(alist1: TagEntry[], alist2: TagEntry[]): TagEntry[] {
  if (alist2.length === 0) return alist1;
  if (alist1.length === 0) return alist2;
  const add: TagEntry[] = [];
  let groupFlag = false;
  for (const e of alist1) {
    if (e[0] === ":startgrouptag" || e[0] === ":startgroup") groupFlag = true;
    else if (e[0] === ":endgrouptag" || e[0] === ":endgroup") groupFlag = false;
    if (isTagKeyword(e[0]) || groupFlag || !alist2.some(([t]) => t === e[0])) add.push(e);
  }
  return [...add, ...alist2];
}

/**
 * The buffer's tag table, as org-current-tag-alist: org-tag-persistent-alist's
 * tags, then the TAGS lines' or else org-tag-alist's.
 */
export function currentTagAlist(): TagEntry[] {
  // As Org read them when Org mode started, or C-c C-c on a keyword line last refreshed them.
  const cached = e8.variable("org--tags-lines");
  const lines = Array.isArray(cached) ? cached.map(String) : tagsLinesNow();
  const base = lines.length > 0 ? tagStringToAlist(lines.join("\n")) : tagTable(e8.variable("org-tag-alist") ?? null);
  return tagAddToAlist(tagTable(e8.variable("org-tag-persistent-alist") ?? null), base);
}

/** The values of the buffer's TAGS lines, with its setup files' in their places, as org-collect-keywords reads them. */
function tagsLinesNow(): string[] {
  return keywordLines().flatMap(([, , text]) => {
    const m = /^#\+TAGS:(.*)$/i.exec(text);
    return m ? [m[1].trim()] : [];
  });
}

/** Reads the TAGS lines again, as org-mode does when it starts, C-c C-c on a keyword line by restarting it, and the agenda for its files. */
export function storeTagsLines(): void {
  e8.setVariable("org--tags-lines", tagsLinesNow());
}

/** The tags of the file and of every heading, for completion, as org-get-buffer-tags. */
function bufferTags(): TagEntry[] {
  const seen = new Set<string>();
  for (const h of headings()) for (const t of h.tags) seen.add(t);
  for (const t of fileTags()) seen.add(t);
  // Last first, as hash-table-keys gives them.
  return [...seen].reverse().map((t): TagEntry => [t, undefined]);
}

/** The tags of every agenda file, each once, as org-global-tags-completion-table: their headings' and FILETAGS', and their tag lists'. */
export function globalTagsCompletionTable(files: string[] = agendaFiles()): TagEntry[] {
  const seen = new Set<string>();
  for (const file of files) {
    e8.withCurrentBuffer(e8.findFileNoselect(file), () => {
      for (const [t] of [...bufferTags(), ...currentTagAlist()]) if (!isTagKeyword(t)) seen.add(t);
    });
  }
  return [...seen].map((t): TagEntry => [t, undefined]);
}

/** The tags FILETAGS lines give the whole file. */
function fileTags(): string[] {
  const out: string[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+FILETAGS:(.*)$/i.exec(text);
    if (m) for (const t of m[1].split(/[:\s]+/)) if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A TODO state's face, as org-get-todo-face: its own from org-todo-keyword-faces, else org-done or org-todo. */
export function todoFaceOf(kw: string): e8.Value {
  return faceFromFaceOrColor("org-todo", alistGet("org-todo-keyword-faces", kw) ?? null) ?? (isDone(kw) ? "org-done" : "org-todo");
}

/**
 * The states with their fast-access keys, in groups by sequence, as
 * org-todo-key-alist: keys the states do not give are assigned as
 * org-assign-fast-keys does, from their names, else from 0 on.
 */
function todoKeyAlist(): TagEntry[] {
  const alist: TagEntry[] = [];
  for (const set of todoSets()) alist.push([":startgroup", undefined], ...set.keys.map(([k, c]): TagEntry => [k, c]), [":endgroup", undefined]);
  const out: TagEntry[] = [];
  let alt = "0".codePointAt(0)!;
  for (let i = 0; i < alist.length; i++) {
    const e = alist[i];
    if (isTagKeyword(e[0]) || e[1] !== undefined) {
      out.push(e);
      continue;
    }
    const used = [...out, ...alist.slice(i + 1)];
    let chars = [...e[0].toLowerCase()];
    if (chars[0] === "@") chars = chars.slice(1);
    while (chars.length > 0 && used.some(([, k]) => k === chars[0])) chars.shift();
    if (chars.length === 0) while (used.some(([, k]) => k === String.fromCodePoint(alt))) alt++;
    out.push([e[0], chars[0] ?? String.fromCodePoint(alt)]);
  }
  return out;
}

/** The keys fast tag selection gives tags without their own, in turn, as org--fast-tag-selection-keys. */
const FAST_TAG_KEYS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ{|}~"];

/** Tags as a heading writes them: :a:b:, or nothing for none, as org-make-tag-string. */
const makeTagString = (tags: string[]): string => (tags.length === 0 ? "" : `:${tags.join(":")}:`);

/**
 * Picks tags by single keys in " *Org tags*", as org-fast-tag-selection:
 * a key toggles its tag, keeping one tag of a group; SPC clears them, TAB
 * types one, ! turns groups off, C-c makes the next change finish (or,
 * with the expert interface, shows the tags), RET accepts and C-g or q
 * quits. A TODO state's key, with TODO-TABLE, sets the heading's state.
 * Returns the tags as a:b, or undefined.
 */
function fastTagSelection(currentTags: string[], inheritedTags: string[], tagTableIn: TagEntry[], todoTable: TagEntry[]): string | undefined {
  const tagAlist = [...tagTableIn, ...todoTable];
  // Room for "[c]", a space, a group's " : " and the longest tag.
  const fieldWidth = 3 + 1 + 3 + Math.max(0, ...tagAlist.map(([t]) => (isTagKeyword(t) ? 0 : e8.stringWidth(t))));
  const origin = e8.currentBuffer();
  let expert = e8.variable("org-fast-tag-selection-single-key") === "expert";
  let tabTags: string[] | undefined;
  const bindingChars = [...FAST_TAG_KEYS];
  let charsLeft = Number(e8.variable("org-fast-tag-selection-maximum-tags") ?? FAST_TAG_KEYS.length);
  let exitAfterNext: boolean | "now" = truthy(e8.variable("org-fast-tag-selection-single-key"));
  // The groups' tags; nil (empty) when there are none, and after ! nil or t, as Org's.
  let groups: string[][] | true = [];
  const local: TagEntry[] = [];
  const name = " *Org tags*";
  // Tags with keys of their own and tags in groups always show; others while keys are left.
  {
    let ingroup = false;
    for (const [t, k] of tagAlist) {
      if (t === ":startgroup" || t === ":startgrouptag") ingroup = true;
      else if (t === ":endgroup" || t === ":endgrouptag") ingroup = false;
      else if (k !== undefined) charsLeft--;
      else if (t === ":newline" || t === ":grouptags") continue;
      else if (ingroup) charsLeft--;
    }
  }
  // The tags being chosen show on the heading, as org-tags-overlay.
  const line = lineAt();
  const lineText = e8.lineText(line);
  const tagged = /^\*+ (?:.*[ \t])?(:[\p{L}\p{M}\p{Nd}\p{Nl}_@#%:]+:)[ \t]*$/u.exec(lineText);
  let ovStart: number, ovEnd: number, ovPrefix: string;
  if (tagged) {
    ovStart = e8.lineStart(line) + charCount(lineText.slice(0, lineText.lastIndexOf(tagged[1])));
    ovEnd = ovStart + charCount(tagged[1]);
    ovPrefix = "";
  } else {
    ovStart = e8.lineEnd(line) - 1;
    ovEnd = ovStart + 1;
    const column = e8.saveExcursion(() => (e8.gotoChar(e8.lineEnd(line)), e8.currentColumn()));
    const tagsColumn = Number(e8.variable("org-tags-column") ?? -77);
    ovPrefix = e8.bufferSubstringNoProperties(ovStart, ovEnd) + (column > tagsColumn ? " " : " ".repeat(tagsColumn - column));
  }
  const overlay = e8.makeOverlay(Math.max(e8.lineStart(line), ovStart), Math.min(e8.lineEnd(line), ovEnd));
  const showOverlay = () => e8.overlayPut(overlay, "display", e8.concat(ovPrefix, e8.propertize(makeTagString(currentTags), { face: ["secondary-selection", "org-tag"] })));
  showOverlay();
  const width = () => e8.windowSize()?.width ?? 80;
  const fastTagInsert = (kwd: string, tags: string[], face: string, end = "") => {
    e8.insert(`${kwd}:`.padEnd(12));
    e8.insert(e8.propertize(tags.join(" "), { face }));
    e8.insert(end);
  };
  // Says on the third line whether the next change finishes, as org-fast-tag-show-exit.
  const showExit = (flag: boolean | "now") => {
    e8.saveExcursion(() => {
      e8.gotoChar(e8.lineStart(2));
      const text = e8.lineText(2);
      const m = /[ \t]+Next change exits/.exec(text);
      if (m) e8.deleteRegion(e8.lineStart(2) + charCount(text.slice(0, m.index)), e8.lineStart(2) + charCount(text.slice(0, m.index + m[0].length)));
      if (flag) {
        e8.gotoChar(e8.lineEnd(2));
        // As org-move-to-column with FORCE: indented up to the column, with tabs as indent-tabs-mode says.
        if (e8.currentColumn() < width() - 19) e8.indentTo(width() - 19);
        e8.insert(e8.propertize(" Next change exits", { face: "org-warning" }));
      }
    });
  };
  const showWindow = () => {
    orgPopToBufferSplit(name);
    orgFitWindowToBuffer();
  };
  e8.getBufferCreate(name);
  try {
    return e8.saveWindowExcursion(() =>
      e8.saveExcursion(() => {
        if (expert) e8.setBuffer(name);
        else orgPopToBufferSplit(name);
        return e8.letBind({ "inhibit-read-only": true }, () => {
          eraseBuffer();
          fastTagInsert("Inherited", inheritedTags, "org-done", "\n");
          fastTagInsert("Current", currentTags, "org-todo", "\n\n");
          showExit(exitAfterNext);
          let fieldNumber = 0;
          let ingroup = false;
          let intaggroup = false;
          const perRow = Math.floor((width() - 4) / fieldWidth);
          for (let i = 0; i < tagAlist.length; i++) {
            const [tag, key] = tagAlist[i];
            const next = tagAlist[i + 1]?.[0];
            if (tag === ":startgroup") {
              (groups as string[][]).push([]);
              ingroup = true;
              if (fieldNumber !== 0) {
                fieldNumber = 0;
                e8.insert("\n");
              }
              e8.insert(`${key !== undefined ? `${key}: ` : ""}{ `);
            } else if (tag === ":endgroup") {
              ingroup = false;
              fieldNumber = 0;
              e8.insert(`}${key !== undefined ? ` (${key}) ` : ""}\n`);
            } else if (tag === ":startgrouptag") {
              intaggroup = true;
              if (fieldNumber !== 0) {
                fieldNumber = 0;
                e8.insert("\n");
              }
              e8.insert("[ ");
            } else if (tag === ":endgrouptag") {
              intaggroup = false;
              fieldNumber = 0;
              e8.insert("]\n");
            } else if (tag === ":newline") {
              if (fieldNumber !== 0) {
                fieldNumber = 0;
                e8.insert("\n");
                while (tagAlist[i + 1]?.[0] === ":newline") {
                  e8.insert("\n");
                  i++;
                }
              }
            } else if (tag === ":grouptags") {
              // The tag before names the group: its padding ends " : " instead.
              e8.deleteRegion(e8.point() - 3, e8.point());
              e8.insert(" : ");
            } else {
              let ch: string;
              if (key !== undefined) ch = key;
              else {
                if (!ingroup && !intaggroup) charsLeft--;
                // The tag's first letter, after an @, else the first key free.
                const auto = [...(tag.startsWith("@") ? tag.slice(1) : tag).toLowerCase()][0] ?? "";
                const taken = (c: string) => local.some(([, k]) => k === c) || tagTableIn.some(([, k]) => k === c);
                if (taken(auto)) {
                  while (bindingChars.length > 0 && taken(bindingChars[0])) bindingChars.shift();
                  ch = bindingChars[0] ?? " ";
                } else ch = auto;
              }
              if (ingroup) (groups as string[][])[(groups as string[][]).length - 1].push(tag);
              const face: e8.Value | undefined = next === ":grouptags"
                ? "org-tag-group"
                : !tagTableIn.some(([t]) => t === tag)
                  ? e8.withCurrentBuffer(origin, () => todoFaceOf(tag))
                  : currentTags.includes(tag)
                    ? "org-todo"
                    : inheritedTags.includes(tag)
                      ? "org-done"
                      : undefined;
              if (ingroup || intaggroup || key !== undefined || charsLeft > 0) {
                if (fieldNumber === 0 && !ingroup && !intaggroup) e8.insert("  ");
                e8.insert(`[${ch}] `);
                e8.insert(face === undefined ? tag : e8.propertize(tag, { face }));
                e8.insert(" ".repeat(Math.max(0, fieldWidth - 4 - charCount(tag))));
                local.push([tag, ch]);
                if (++fieldNumber === perRow) {
                  if (next !== ":endgroup" && next !== ":endgrouptag") {
                    e8.insert("\n");
                    if (ingroup || intaggroup) e8.insert("  ");
                  }
                  fieldNumber = 0;
                }
              }
            }
          }
          e8.insert("\n");
          e8.gotoChar(e8.pointMin());
          if (!expert) orgFitWindowToBuffer();
          for (;;) {
            const message =
              `[a-z..]:toggle [SPC]:clear [RET]:accept [TAB]:edit [!] ${groups === true || groups.length > 0 ? "" : "no "}groups` +
              (expert ? " [C-c]:window" : exitAfterNext ? " [C-c]:single" : " [C-c]:multi");
            const input = e8.readKey(message);
            if (input === "RET") return currentTags.join(":");
            if (input === "!") {
              // Groups off, and their braces gone, as org-fast-tag-selection's !.
              groups = groups === true || groups.length > 0 ? [] : true;
              for (const [l, , text] of e8.matchingLines("[{}]")) {
                const start = e8.lineStart(l);
                [...text].forEach((c, j) => {
                  if (c === "{" || c === "}") {
                    e8.deleteRegion(start + j, start + j + 1);
                    e8.gotoChar(start + j);
                    e8.insert(" ");
                  }
                });
              }
            } else if (input === "C-c") {
              if (!expert) {
                exitAfterNext = !exitAfterNext;
                showExit(exitAfterNext);
              } else {
                expert = false;
                showWindow();
              }
            } else if (input === "C-g" || (input === "q" && !local.some(([, k]) => k === "q"))) {
              e8.signal("quit", "Quit");
            } else if (input === "SPC" || input === " ") {
              currentTags = [];
              if (exitAfterNext) exitAfterNext = "now";
            } else if (input === "TAB") {
              tabTags ??= tagAddToAlist(e8.withCurrentBuffer(origin, bufferTags), tagTableIn)
                .map(([t]) => t)
                .filter((t) => !isTagKeyword(t));
              const typed = e8.completingRead("Tag: ", tabTags);
              if (/\S/.test(typed)) {
                if (!tabTags.includes(typed)) tabTags.unshift(typed);
                currentTags = addOrRemoveTag(typed, currentTags, groups);
              }
              if (exitAfterNext) exitAfterNext = "now";
            } else {
              const kw = todoTable.find(([t, k]) => !isTagKeyword(t) && k === input)?.[0];
              const tag = kw === undefined ? local.find(([, k]) => k === input)?.[0] : undefined;
              if (kw !== undefined) {
                // From code, as Org's (org-todo todo-keyword): a blocked change is only said.
                e8.withCurrentBuffer(origin, () => e8.saveExcursion(() => todoFromCode(() => todo(0, kw))));
                if (exitAfterNext) exitAfterNext = "now";
              } else if (tag !== undefined) {
                currentTags = addOrRemoveTag(tag, currentTags, groups);
                if (exitAfterNext) exitAfterNext = "now";
              }
            }
            // In the order the tags show, as Org sorts them.
            const order = local.map(([t]) => t);
            // B comes after A in the grid, as Org's predicate says.
            currentTags = sortByPredicate(currentTags, (x, y) => {
              const ix = order.indexOf(x);
              return ix >= 0 && order.indexOf(y) > ix;
            });
            if (exitAfterNext === "now") return currentTags.join(":");
            // The current tags again, on the second line, on the heading and in the grid.
            e8.gotoChar(e8.lineStart(1));
            e8.deleteRegion(e8.point(), e8.lineEnd(1));
            fastTagInsert("Current", currentTags, "org-todo");
            showOverlay();
            const from = e8.point();
            for (const [l, , text] of e8.matchingLines("\\[.\\] [[:alnum:]_@#%]+")) {
              for (const m of allMatches(/\[.\] ([\p{L}\p{M}\p{Nd}\p{Nl}_@#%]+)/gu, text)) {
                const start = e8.lineStart(l) + charCount(text.slice(0, (m.index ?? 0) + 4));
                if (start < from) continue;
                const t = m[1];
                e8.putTextProperty(start, start + charCount(t), "face", currentTags.includes(t) ? "org-todo" : inheritedTags.includes(t) ? "org-done" : "default");
              }
            }
            e8.gotoChar(e8.pointMin());
          }
        });
      }),
    );
  } finally {
    e8.deleteOverlay(overlay);
  }
}

/**
 * LIST sorted by LESS as Emacs's sort does a short list, the same on every
 * engine: its first run, reversed if descending, then each element after
 * it inserted by binary search, as timsort sorts fewer than 64.
 */
function sortByPredicate<T>(list: T[], less: (a: T, b: T) => boolean): T[] {
  const a = [...list];
  if (a.length < 2) return a;
  let run = 2;
  if (less(a[1], a[0])) {
    while (run < a.length && less(a[run], a[run - 1])) run++;
    a.splice(0, run, ...a.slice(0, run).reverse());
  } else while (run < a.length && !less(a[run], a[run - 1])) run++;
  for (let i = run; i < a.length; i++) {
    const pivot = a[i];
    let lo = 0;
    let hi = i;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (less(pivot, a[mid])) hi = mid;
      else lo = mid + 1;
    }
    a.splice(i, 1);
    a.splice(lo, 0, pivot);
  }
  return a;
}

/** Adds TAG or takes it away; added, the others of its group go, as org--add-or-remove-tag. */
function addOrRemoveTag(tag: string, current: string[], groups: string[][] | true): string[] {
  if (current.includes(tag)) return current.filter((t) => t !== tag);
  let out = current;
  // Org signals here when ! has made groups t; E8 takes it as none.
  for (const g of groups === true ? [] : groups) if (g.includes(tag)) out = out.filter((t) => !g.includes(t));
  return [tag, ...out];
}

const setTagsCommand = e8.defineCommand({
  name: "org-set-tags-command",
  doc:
    "Set the tags for the current visible entry. With C-u, realign all tags in the buffer. With C-u C-u, " +
    "do not offer the fast tag selection interface. Tags are picked by their keys in *Org tags* when the table " +
    "gives keys (org-use-fast-tag-selection), else typed with completion.",
  run: () => {
    const arg = e8.prefixArg();
    if (Array.isArray(arg) && arg[0] === 4) return e8.callWithPrefix(arg, "org-align-tags");
    const fast = Array.isArray(arg) && arg[0] === 16 ? null : e8.variable("org-use-fast-tag-selection");
    // With the region active, each heading in it, as Org maps the command over them, passing over hidden subtrees.
    if (!forEachHeadingInRegion(() => setTagsHere(fast), { hiddenPoint: true })) setTagsHere(fast);
    // Point just after the stars goes past the space after them, as Org leaves it once the tags are set.
    const bol = e8.lineStart(lineAt());
    const stars = e8.bufferSubstringNoProperties(bol, e8.point());
    if (/^\*+$/.test(stars) && e8.point() < e8.pointMax() && e8.bufferSubstringNoProperties(e8.point(), e8.point() + 1) === " ") e8.gotoChar(e8.point() + 1);
  },
});

/** Reads tags for the heading point is under and sets them, as one call of org-set-tags-command does. */
function setTagsHere(fast: e8.Value | undefined): void {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) e8.userError("Setting file tags is not supported yet");
  const h = all[i!];
  const localTable0 = currentTagAlist();
  const localTable = localTable0.length > 0 ? localTable0 : bufferTags();
  // The agenda files' tags after this buffer's, with org-complete-tags-always-offer-all-agenda-tags, as Org adds them.
  const agenda = truthy(e8.variable("org-complete-tags-always-offer-all-agenda-tags")) ? globalTagsCompletionTable() : [];
  const table = [...localTable, ...agenda.filter(([t]) => !localTable.some(([u]) => u === t))];
  // As org-get-tags: with inheritance, the file's and the headings' above, then the heading's own,
  // each tag once where it comes last; those of the heading are its current ones.
  let current = h.tags;
  let inherited: string[] = [];
  if (truthy(e8.variable("org-use-tag-inheritance"))) {
    // Those inheritance gives, org-tags-exclude-from-inheritance left out, as org-get-tags's org-remove-uninherited-tags.
    const itags = removeUninheritedTags([...fileTags(), ...ancestors(all, i!).reverse().flatMap((a) => all[a].tags)]);
    const tagged = [...itags.map((t) => [t, true] as const), ...current.map((t) => [t, false] as const)];
    const kept = tagged.filter(([t], j) => !tagged.slice(j + 1).some(([u]) => u === t));
    inherited = kept.filter(([, inh]) => inh).map(([t]) => t);
    current = kept.filter(([, inh]) => !inh).map(([t]) => t);
  }
  let tags: string | undefined;
  if (fast === true || (truthy(fast) && table.some(([, k]) => k !== undefined))) {
    tags = e8.saveExcursion(() => {
      e8.gotoChar(h.start);
      const todo = truthy(e8.variable("org-fast-tag-selection-include-todo")) ? todoKeyAlist() : [];
      return fastTagSelection(current, inherited, table, todo);
    });
  } else {
    // Each tag completed after a colon, as Org's completing-read-multiple with crm-separator bound so.
    const answer = e8.letBind({ "crm-separator": "[ \t]*:[ \t]*" }, () =>
      completingReadMultiple("Tags: ", table.map(([t]) => t).filter((t) => !isTagKeyword(t)), { initial: makeTagString(current), history: "org-tags-history" }),
    );
    tags = answer.join(":");
  }
  // Characters a tag cannot have part tags, as org-set-tags-command's.
  const cleaned = (tags ?? "").replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}_@#%]+/gu, ":");
  e8.saveExcursion(() => {
    e8.gotoChar(h.start);
    setTags(cleaned.split(":").filter((t) => t !== ""));
  });
}

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
  // E8's clock in its own zone, as set-time-zone-rule sets it, as Emacs's decode-time.
  const [, minute, hour, day, month, year] = e8.decodeTime() as number[];
  return { year, month, day, ...(withTime ? { hour, minute } : {}) };
}

/**
 * Whole cycles of 400 years to take off a year, and put back after, so
 * JavaScript's dates, which end at the year 275760, reach any year
 * Emacs's do: the calendar repeats every 400 years, weekdays and all.
 */
function cycles(year: number): number {
  return 400 * Math.floor((year - 2000) / 400);
}

/** A date with its fields carried over, as Emacs's encode-time does: 31 February is 3 March. */
function normalize(d: DateTime): DateTime {
  const shift = cycles(d.year);
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(d.year - shift, d.month - 1, d.day);
  t.setUTCHours(d.hour ?? 0, d.minute ?? 0);
  const out: DateTime = { year: t.getUTCFullYear() + shift, month: t.getUTCMonth() + 1, day: t.getUTCDate() };
  if (d.hour !== undefined) {
    out.hour = t.getUTCHours();
    out.minute = t.getUTCMinutes();
  }
  return out;
}

function weekday(d: DateTime): number {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(d.year - cycles(d.year), d.month - 1, d.day);
  return t.getUTCDay();
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

/**
 * The dates of the date range or the timestamp around a position, as
 * org-at-date-range-p with inactive ones and org-at-timestamp-p with lax
 * find them, for org-follow-timestamp-link: a range's two, as 2026-10-25,
 * or a timestamp's one. At its end counts when INCLUSIVE.
 */
export function timestampDatesAt(p: number, inclusive = true): string[] | undefined {
  const all = tsMatches(lineAt(p));
  const date = (ts: TsMatch) => ts.text.slice(1, 11);
  const within = (start: number, end: number) => start <= p && (inclusive ? p <= end : p < end);
  for (let i = 0; i + 1 < all.length; i++) {
    const [a, b] = [all[i], all[i + 1]];
    if (/^-{1,3}$/.test(e8.bufferText(a.end, b.start)) && within(a.start, b.end)) return [date(a), date(b)];
  }
  const ts = all.find((t) => within(t.start, t.end));
  return ts ? [date(ts)] : undefined;
}

/** Whether point is on a timestamp, as org-return-follows-link has RET follow it: org-in-regexp of a timestamp or a range, visually, not at its end. */
function onTimestamp(): boolean {
  return timestampDatesAt(e8.point(), false) !== undefined;
}

/**
 * Whether a position is on the spaces after a timestamp, or at the end of
 * its line just after one, which the timestamp's object takes in, as Org's
 * objects take the whitespace after them.
 */
function afterTimestamp(p: number): boolean {
  const line = lineAt(p);
  if (p < e8.lineEnd(line) && !/[ \t]/.test(e8.bufferText(p, p + 1))) return false;
  return tsMatches(line).some((t) => t.end <= p && /^[ \t]*$/.test(e8.bufferText(t.end, p)));
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
function changeTimestamp(n: number, what?: string, updown = true): string {
  const origin = e8.point();
  const ts = tsMatches(lineAt()).find((t) => t.start <= origin && origin <= t.end);
  if (!ts) e8.userError("Not at a timestamp");
  const category = timestampCategory(ts, origin);
  if (what === undefined && category === "bracket") {
    const swap: { [c: string]: string } = { "[": "<", "]": ">", "<": "[", ">": "]" };
    replaceText(ts.start, ts.start + 1, swap[ts.text[0]]);
    replaceText(ts.end - 1, ts.end, swap[ts.text[ts.text.length - 1]]);
    e8.message(`Timestamp is now ${ts.text[0] === "[" ? "" : "in"}active`);
    return tsMatches(lineAt(ts.start)).find((t) => t.start === ts.start)?.text ?? "";
  }
  const field = what ?? category;
  const inactive = ts.text[0] === "[";
  e8.deleteRegion(ts.start, ts.end);
  e8.gotoChar(ts.start);
  // Case aside, as string-match is with case-fold-search on, so a +1W repeater is kept.
  const extra = /((?:-[012][0-9]:[0-5][0-9])?(?: +[.+]?-?[-+][0-9]+[hdwmy](?:\/[0-9]+[hdwmy])?)*)[\]>]/i.exec(ts.text)?.[1] ?? "";
  const withTime = /^.{10}.*?[0-9]+:[0-9][0-9]/.test(ts.text);
  const parsed = /(\d{4})-(\d{2})-(\d{2})(?: +[^\]+0-9>\r\n -]+)?(?: +(\d{1,2}):(\d{2}))?/.exec(ts.text);
  const d: DateTime = {
    year: Number(parsed?.[1]),
    month: Number(parsed?.[2]),
    day: Number(parsed?.[3]),
    hour: Number(parsed?.[4] ?? 0),
    minute: Number(parsed?.[5] ?? 0),
  };
  let step = Math.max(roundingMinutes()[1], 1);
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
  // A CLOCK line's duration worked out again, as org-timestamp-change has it.
  clockUpdateTimeMaybe();
  // The new timestamp, as org-last-changed-timestamp holds it.
  return fresh?.text ?? "";
}

/**
 * Moves the timestamp at P, or the active date range it is in, by N of
 * WHAT, a day, hour or minute, as the agenda's org-agenda-date-later
 * changes it with org-timestamp-change, both ends of a range; returns what it wrote,
 * a range as its two timestamps joined by --.
 */
export function shiftTimestampAt(p: number, n: number, what: string): string {
  const range = activeRange(p);
  if (range !== undefined) {
    const [a, b] = range;
    // The end first, so the start's change leaves its place alone.
    e8.gotoChar(b.start);
    const end = changeTimestamp(n, what, false);
    e8.gotoChar(a.start);
    return `${changeTimestamp(n, what, false)}--${end}`;
  }
  e8.gotoChar(p);
  return changeTimestamp(n, what, false);
}

/** The active date range P is in, its two timestamps, as org-at-date-range-p finds one without INACTIVE-OK. */
function activeRange(p: number): [TsMatch, TsMatch] | undefined {
  const all = tsMatches(lineAt(p));
  for (let i = 0; i + 1 < all.length; i++) {
    const [a, b] = [all[i], all[i + 1]];
    if (a.text[0] === "<" && b.text[0] === "<" && /^-{1,3}$/.test(e8.bufferText(a.end, b.start)) && a.start <= p && p <= b.end) return [a, b];
  }
  return undefined;
}

/** Whether P is in an active date range, as org-at-date-range-p. */
export const activeRangeAt = (p: number): boolean => activeRange(p) !== undefined;

/** The timestamp at P, as org-at-timestamp-p finds it with lax, or undefined. */
export function timestampTextAt(p: number): string | undefined {
  return tsMatches(lineAt(p)).find((t) => t.start <= p && p <= t.end)?.text;
}

/** Whether clockUpdateTimeMaybe is writing a CLOCK line's timestamps again, so their change does not call it back, as Org ignores it then. */
let updatingClockLine = false;

/**
 * Writes the timestamps of the CLOCK line point is on again and works out
 * its duration after them, as org-clock-update-time-maybe; on the running
 * clock's line, the clock counts from its timestamp. True if the line is a
 * closed clock, and so was updated.
 */
function clockUpdateTimeMaybe(): boolean {
  if (updatingClockLine) return false;
  const origin = e8.point();
  const keep = marker(origin);
  let updated = false;
  try {
    const line = lineAt();
    const at = e8.lineStart(line) + charCount(/^[ \t]*/.exec(e8.lineText(line))![0]);
    // Case aside, as Org looks at org-clock-string with case-fold-search.
    const re = /^[ \t]*CLOCK: *[[<]([^\]>]+)[\]>](?:-+[[<]([^\]>]+)[\]>]([ \t]*=>.*)?)?/i;
    const read = (): RegExpExecArray | null => (/^CLOCK:/i.test(e8.lineText(line).slice(at - e8.lineStart(line))) ? re.exec(e8.bufferText(at, e8.lineEnd(line))) : null);
    let m = read();
    if (m === null) return false;
    if (m[2] === undefined) {
      // A running clock here counts from its start.
      if (e8.fboundp("org-clock--restart-at")) updated = truthy(e8.funcall("org-clock--restart-at", at, e8.lineEnd(line), timestampSeconds(m[1])));
      return updated;
    }
    // Each timestamp written again, without calling back here.
    const startOf = (match: RegExpExecArray, group: 1 | 2): number => {
      const text = match[0];
      const first = text.indexOf(match[1]);
      const index = group === 1 ? first : text.indexOf(match[2]!, first + match[1].length + 1);
      return at + charCount(text.slice(0, index));
    };
    updatingClockLine = true;
    try {
      e8.gotoChar(startOf(m, 1));
      changeTimestamp(0, "day");
      m = read()!;
      e8.gotoChar(startOf(m, 2));
      changeTimestamp(0, "day");
    } finally {
      updatingClockLine = false;
    }
    m = read()!;
    // The duration after them, worked out again.
    if (m[3] !== undefined) {
      const durationAt = at + charCount(m[0].slice(0, m[0].length - m[3].length));
      e8.deleteRegion(durationAt, durationAt + charCount(m[3]));
    }
    e8.gotoChar(e8.lineEnd(line));
    let s = timestampSeconds(m[2]!) - timestampSeconds(m[1]);
    const neg = s < 0;
    s = Math.abs(s);
    const h = Math.floor(s / 3600);
    const mins = Math.floor((s - h * 3600) / 60);
    e8.insert(` => ${neg ? `-${h}` : String(h).padStart(2)}:${String(mins).padStart(2, "0")}`);
    updated = true;
    return true;
  } finally {
    // Back where it was, but never past the updated clock.
    e8.gotoChar(Math.min(keep.pos, origin));
    dropMarker(keep);
  }
}

/**
 * Whether point is on the -- between a range's timestamps, in text where
 * Org's parser finds timestamp objects: paragraphs, headings, items, verse
 * and the keywords whose values Org parses, not inside a link.
 */
/** Whether point is on the -- between a range's two timestamps on its line. */
function rangeDashesHere(line: number): boolean {
  const p = e8.point();
  const all = tsMatches(line);
  return all.some((a, i) => i + 1 < all.length && e8.bufferText(a.end, all[i + 1].start) === "--" && a.end < p && p < all[i + 1].start);
}

function onRangeDashes(line: number): boolean {
  const p = e8.point();
  if (!rangeDashesHere(line)) return false;
  const type = elementAt(p)?.type;
  const parsedKeyword = type === "keyword" && /^[ \t]*#\+(?:TITLE|DATE|AUTHOR|CAPTION):/i.test(e8.lineText(line));
  if (!parsedKeyword && !["paragraph", "headline", "item", "verse-block"].includes(type ?? "")) return false;
  // A link's description holds no timestamps.
  const text = e8.lineText(line);
  const col = p - e8.lineStart(line);
  for (const m of allMatches(/\[\[[^\]]*\](?:\[[^\]]*\])?\]/g, text)) if (m.index! < col && col < m.index! + m[0].length) return false;
  return true;
}

/** Whether point is on a CLOCK line, as org-at-clock-log-p: one that is a clock element. */
function atClockLog(): boolean {
  // Case aside, as Org's regexps match with case-fold-search.
  return /^[ \t]*CLOCK:/i.test(e8.lineText(lineAt())) && elementAt(e8.point())?.type === "clock";
}

/**
 * Changes the timestamp at point on a CLOCK line by n of its part, and the
 * line's other timestamp by as much, so the clock keeps its length, as
 * org-clock-timestamps-change does.
 */
function clockTimestampsChange(up: boolean, n: e8.PrefixArg): void {
  const origin = e8.point();
  const all = tsMatches(lineAt());
  const at = all.find((t) => t.start <= origin && origin <= t.end);
  if (at === undefined) return;
  const category = timestampCategory(at, origin);
  // The line's first timestamp, and the next one after it, on this line or
  // any below, as Org's re-search-forward finds them.
  const ts1 = all[0];
  let ts2: TsMatch | undefined = all[1];
  for (let l = lineAt() + 1; ts2 === undefined && l < e8.lineCount() && e8.lineStart(l) < e8.pointMax(); l++) ts2 = tsMatches(l)[0];
  // As Org, which compares with the second's start, there must be one.
  if (ts2 === undefined) e8.signal("wrong-type-argument", "Wrong type argument: number-or-marker-p, nil", ["number-or-marker-p", null]);
  const onSecond = ts2.start <= origin;
  const steps = e8.prefixNumericValue(n);
  changeTimestamp(up ? steps : -steps, undefined, true);
  // How far the timestamp moved, in its part's units.
  const changedAt = onSecond ? ts2.start : ts1.start;
  const now = tsMatches(lineAt(changedAt)).find((t) => t.start === changedAt);
  const was = onSecond ? ts2.text : ts1.text;
  const units: { [part: string]: number } = { minute: 60, hour: 3600, day: 24 * 3600, month: 24 * 3600 * 31, year: 24 * 3600 * 365.2 };
  const unit = typeof category === "string" ? units[category] : undefined;
  if (now === undefined || unit === undefined) e8.signal("wrong-type-argument", "Wrong type argument: number-or-marker-p, nil", ["number-or-marker-p", null]);
  const diff = timestampSeconds(now.text) - timestampSeconds(was);
  const back = e8.point();
  const keep = marker(back);
  try {
    e8.gotoChar(onSecond ? ts1.start : ts2.start);
    changeTimestamp(Math.round(diff / unit), category as string, true);
  } finally {
    // Back, as save-excursion keeps it, even when the change fails.
    e8.gotoChar(keep.pos);
    dropMarker(keep);
  }
  // But never past the updated clock.
  if (e8.point() >= back) e8.gotoChar(back);
}

for (const [name, up, doc] of [
  ["org-clock-timestamps-up", true, "Make the CLOCK timestamp point is on later by its part, the year, month, day, hour or minute, and the line's other one with it."],
  ["org-clock-timestamps-down", false, "Make the CLOCK timestamp point is on earlier by its part, and the line's other one with it."],
] as [string, boolean, string][]) {
  e8.defineCommand({
    name,
    doc,
    params: [{ name: "n", kind: "prefix" }],
    run: (n: e8.PrefixArg) => {
      if (tsMatches(lineAt()).some((t) => t.start <= e8.point() && e8.point() <= t.end)) clockTimestampsChange(up, n);
    },
  });
}

const shiftControlUp = e8.defineCommand({
  name: "org-shiftcontrolup",
  doc: "C-S-<up> in Org: on a CLOCK line's timestamp, make it and the other one later together, so the clock keeps its length.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n: e8.PrefixArg) => {
    if (atClockLog() && timestampHere()) clockTimestampsChange(true, n);
    else e8.userError("Not at a clock log");
  },
});
const shiftControlDown = e8.defineCommand({
  name: "org-shiftcontroldown",
  doc: "C-S-<down> in Org: on a CLOCK line's timestamp, make it and the other one earlier together.",
  params: [{ name: "n", kind: "prefix" }],
  run: (n: e8.PrefixArg) => {
    if (atClockLog() && timestampHere()) clockTimestampsChange(false, n);
    else e8.userError("Not at a clock log");
  },
});

for (const [name, n, what, doc] of [
  ["org-timestamp-up", 1, undefined, "Change the part of the timestamp point is on, the year, month, day, hour or minute, one step later."],
  ["org-timestamp-down", -1, undefined, "Change the part of the timestamp point is on one step earlier."],
  ["org-timestamp-up-day", 1, "day", "Move the timestamp point is on a day later."],
  ["org-timestamp-down-day", -1, "day", "Move the timestamp point is on a day earlier."],
] as [string, number, string | undefined, string][]) {
  e8.defineCommand({ name, doc, run: () => void changeTimestamp(n * e8.prefixNumericValue(), what) });
}

/** A year of two digits as one of the 30 years to come or the 70 before, as org-small-year-to-year reads it. */
export function smallYearToYear(year: number): number {
  if (year >= 100) return year;
  const current = today().year;
  const century = Math.trunc(current / 100);
  const offset = year - (current % 100);
  if (offset > 30) return (century - 1) * 100 + year;
  if (offset > -70) return century * 100 + year;
  return (century + 1) * 100 + year;
}

/** A word's start or end, as Emacs's \< and \> find them: a letter or digit on one side only. */
const WORD_START = "(?<![\\p{L}\\p{N}])";
const WORD_END = "(?![\\p{L}\\p{N}])";

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad4 = (n: number): string => String(n).padStart(4, "0");

/** A plain time or a range of times, as org-plain-time-of-day-regexp: group 8 is the range's end, group 7 it with its dash. */
const PLAIN_TIME_OF_DAY = new RegExp(
  `(${WORD_START}[012]?[0-9]((:([0-5][0-9]([AaPp][Mm])?))|([AaPp][Mm]))${WORD_END})` +
    `(--?(${WORD_START}[012]?[0-9]((:([0-5][0-9]([AaPp][Mm])?))|([AaPp][Mm]))${WORD_END}))?`,
  "u",
);

/** The time now, its minutes rounded to org-timestamp-rounding-minutes's first, as org-current-time gives it. */
function currentTime(): DateTime {
  const now = today(true);
  const step = roundingMinutes()[0];
  if (step < 1) return now;
  // Halves to the even step, as Emacs's round of integers does.
  const q = (now.minute ?? 0) / step;
  const down = Math.floor(q);
  const nearest = q - down === 0.5 ? (down % 2 === 0 ? down : down + 1) : Math.round(q);
  return normalize({ ...now, minute: nearest * step });
}

/**
 * The prompt's default when none is given: the time now, or before
 * org-extend-today-until's hour, a minute before midnight yesterday, as
 * org-read-date has it.
 */
function promptDefault(): DateTime {
  const def = currentTime();
  const extend = Number(e8.variable("org-extend-today-until") ?? 0);
  return (def.hour ?? 0) < extend ? normalize({ ...def, hour: -1, minute: 59 }) : def;
}

/** The day and time a timestamp's text says, midnight if it has no time, as org-time-string-to-time reads it. */
function timestampTime(ts: string): DateTime | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[^\]>\d]*?(\d{1,2}):(\d{2}))?/.exec(ts);
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: m[4] === undefined ? 0 : +m[4], minute: m[5] === undefined ? 0 : +m[5] } : undefined;
}

/**
 * A relative date at the start of an answer, as org-read-date-get-relative
 * reads it: +3, -2w, ++1m, +3h, fri, -fri or +2fri, a sign or a day's name
 * needed. Days from today, or with ++ or -- from the default; a day's name
 * is the next such day, a week on if it is that day, or with - the last.
 */
function readDateGetRelative(s: string, now: DateTime, def: DateTime): { n: number; what: string; rel: boolean; length: number } | undefined {
  const names = PARSE_TIME_WEEKDAYS.map(([name]) => name).join("|");
  const m = new RegExp(`^[ \\t]*([-+]{0,2})([0-9]+)?([hdwmy]|(${names}))?([ \\t]|$)`, "i").exec(s);
  if (!m || (m[1] === "" && m[4] === undefined)) return undefined;
  const back = m[1].endsWith("-");
  const rel = m[1].length === 2;
  const n = m[2] === undefined ? 1 : Number(m[2]);
  const what = m[3] ?? "d";
  const wday1 = PARSE_TIME_WEEKDAYS.find(([name]) => name === what.toLowerCase())?.[1];
  const length = m[0].length;
  if (wday1 === undefined) return { n: back ? -n : n, what, rel, length };
  let delta = (7 + wday1 - weekday(rel ? def : now)) % 7;
  if (delta === 0) delta = 7;
  if (back) {
    delta -= 7;
    if (delta === 0) delta = -7;
  }
  if (n > 1) delta += (n - 1) * (back ? -7 : 7);
  return { n: delta, what: "d", rel, length };
}

/** What a date prompt's answer says, as org-read-date-analyze works it out. */
export interface AnalyzedDate {
  date: DateTime;
  /** Whether the answer gave a time, as org-time-was-given says. */
  timeGiven: boolean;
  /** A range's end time as written, as org-end-time-was-given holds it. */
  endTime?: string;
  /** Whether the year was brought into 1970 to 2037, as org-read-date-force-compatible-dates has it. */
  forcedYear: boolean;
}

/**
 * Reads the answer to Org's date prompt as org-read-date-analyze does:
 * relative dates, ISO weeks (w48, 2026-w48-2), dates as 2026-11-24, 11-24,
 * 24.11.2026 or 11/24/26, month and day names, times as 10:30, 3pm or 15h,
 * and ranges as 10:00-11:00 or 10:00+1:30, the parts not given taken from
 * DEF, or chosen in the future, as org-read-date-prefer-future says.
 * WITH_END reads a range's end, as when org-end-time-was-given is bound.
 */
export function readDateAnalyze(input: string, def: DateTime, withEnd = false): AnalyzedDate {
  let ans = input;
  const now = today(true);
  let futurep = false;
  let killYear = false;
  let timeGiven = false;
  let endTime: string | undefined;
  let m: RegExpExecArray | null;
  const replace = (match: RegExpExecArray, text: string): void => {
    ans = ans.slice(0, match.index) + text + ans.slice(match.index + match[0].length);
  };
  if (/^[ \t]*\.[ \t]*$/.test(ans)) ans = "+0";
  const delta = readDateGetRelative(ans, now, def);
  if (delta) ans = ans.slice(delta.length);
  // An ISO week, read once the rest is.
  let isoYear: number | undefined;
  let isoWeekday: number | undefined;
  let isoWeek: number | undefined;
  if ((m = new RegExp(`${WORD_START}(?:([0-9]+)-)?[wW]([0-9]{1,2})(?:-([0-6]))?([ \\t]|$)`, "u").exec(ans))) {
    isoYear = m[1] === undefined ? undefined : smallYearToYear(Number(m[1]));
    isoWeekday = m[3] === undefined ? undefined : Number(m[3]);
    isoWeek = Number(m[2]);
    replace(m, "");
  }
  // ISO dates with one-digit months or days, as 2006-8-11, or none of the year.
  if ((m = /^ *(([0-9]+)-)?([0-1]?[0-9])-([0-3]?[0-9])([^-0-9]|$)/.exec(ans))) {
    let year = m[2] === undefined ? ((killYear = true), now.year) : Number(m[2]);
    year = smallYearToYear(year);
    replace(m, `${pad4(year)}-${pad2(Number(m[3]))}-${pad2(Number(m[4]))}${m[5]}`);
  }
  // European dates, as 24.11.2026 or 24.11.
  if ((m = /^ *(3[01]|0?[1-9]|[12][0-9])\. ?(0?[1-9]|1[012])\.( ?[1-9][0-9]{3})?/.exec(ans))) {
    const year = m[3] === undefined ? ((killYear = true), now.year) : Number(m[3]);
    replace(m, `${pad4(year)}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`);
  }
  // American dates, as 11/24 or 11/24/26.
  if ((m = /^ *(0?[1-9]|1[012])\/(0?[1-9]|[12][0-9]|3[01])(\/([0-9]+))?([^/0-9]|$)/.exec(ans))) {
    let year = m[4] === undefined ? ((killYear = true), now.year) : Number(m[4]);
    year = smallYearToYear(year);
    replace(m, `${pad4(year)}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}${m[5]}`);
  }
  // Times with am or pm, and as 15h or 15h30, made HH:MM, the range's end too, when no time is so already.
  const hasTime = (): boolean => /(?:^|[^+])[012]?[0-9]:[0-9][0-9](?:[ \t\n]|$)/.test(ans);
  for (let i = 0; i < 2; i++) {
    if (hasTime() || !(m = new RegExp(`([012]?[0-9])(:([0-5][0-9]))?(am|pm)${WORD_END}`, "iu").exec(ans))) continue;
    let hour = Number(m[1]);
    const minute = m[3] === undefined ? 0 : Number(m[3]);
    const pm = m[4].toLowerCase().startsWith("p");
    if (hour === 12 && !pm) hour = 0;
    else if (pm && hour < 12) hour += 12;
    replace(m, `${pad2(hour)}:${pad2(minute)}`);
  }
  for (let i = 0; i < 2; i++) {
    if (hasTime() || !(m = new RegExp(`(?:([012]?[0-9])?h([0-5][0-9]))|(?:([012]?[0-9])h([0-5][0-9])?)${WORD_END}`, "iu").exec(ans))) continue;
    const hour = m[1] ?? m[3];
    const minute = m[2] ?? m[4];
    replace(m, `${pad2(hour === undefined ? 0 : Number(hour))}:${pad2(minute === undefined ? 0 : Number(minute))}`);
  }
  // A range given by its length, as 10:00+1:30.
  if ((m = /([012]?[0-9]):([0-6][0-9])\+([012]?[0-9])(:([0-5][0-9]))?/.exec(ans))) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    let h2 = hour + Number(m[3]);
    let m2 = minute + (m[5] === undefined ? 0 : Number(m[5]));
    if (m2 >= 60) [h2, m2] = [h2 + 1, m2 - 60];
    replace(m, `${pad2(hour)}:${pad2(minute)}-${pad2(h2)}:${pad2(m2)}`);
  }
  // A range's end, taken out.
  if (withEnd && (m = PLAIN_TIME_OF_DAY.exec(ans)) && m[8] !== undefined) {
    endTime = m[8];
    const end = m.index + m[0].length;
    ans = ans.slice(0, end - m[7].length) + ans.slice(end);
  }
  const [, tlMinute, tlHour, tlDay, tlMonth, tlYear, tlWday] = parseTimeString(ans);
  const prefer = e8.variable("org-read-date-prefer-future");
  const preferFuture = truthy(prefer);
  let day = tlDay ?? def.day;
  let month: number;
  if (tlMonth !== undefined) month = tlMonth;
  else if (!preferFuture) month = def.month;
  else if (tlDay !== undefined) {
    // A day given: the day and month to come.
    futurep = true;
    month = day < now.day ? now.month + 1 : now.month;
  } else month = def.month;
  let year: number;
  if (!killYear && tlYear !== undefined) year = tlYear;
  else if (!preferFuture) year = def.year;
  else if (futurep) year = month > now.month || day >= now.day ? now.year : now.year + 1;
  else if (tlMonth !== undefined) {
    // A month given: the month and year to come.
    futurep = true;
    if (month > now.month) year = now.year;
    else if (month < now.month) year = now.year + 1;
    else if (day < now.day) year = now.year + 1;
    else year = now.year;
  } else year = def.year;
  let hour = tlHour ?? def.hour ?? 0;
  const minute = tlMinute ?? def.minute ?? 0;
  let wday = tlWday;
  // With org-read-date-prefer-future time, a time earlier today is tomorrow's.
  if (
    (prefer === "time" || (typeof prefer === "symbol" && e8.symbolName(prefer) === "time")) &&
    tlDay === undefined && tlMonth === undefined && tlYear === undefined &&
    day === now.day && month === now.month && year === now.year &&
    tlHour !== undefined &&
    (tlHour < (now.hour ?? 0) || (tlHour === now.hour && tlMinute !== undefined && tlMinute < (now.minute ?? 0)))
  ) {
    day += 1;
    futurep = true;
  }
  if (isoWeek !== undefined) {
    year = isoYear ?? year;
    const isoDay = isoWeekday ?? wday ?? 1;
    wday = undefined;
    // As calendar-iso-to-absolute: the week's Monday, then the day, Sunday its last.
    const jan4 = { year, month: 1, day: 4 };
    const monday = normalize({ ...jan4, day: 4 - ((weekday(jan4) + 6) % 7) + 7 * (isoWeek - 1) + (isoDay === 0 ? 6 : isoDay - 1) });
    [year, month, day] = [monday.year, monday.month, monday.day];
  } else if (delta) {
    if (!delta.rel) [day, month, year] = [now.day, now.month, now.year];
    if (delta.what === "h") {
      timeGiven = true;
      hour += delta.n;
    } else if (delta.what === "d") day += delta.n;
    else if (delta.what === "w") day += 7 * delta.n;
    else if (delta.what === "m") month += delta.n;
    else if (delta.what === "y") year += delta.n;
  } else if (wday !== undefined && tlDay === undefined) {
    // A day's name and no day: that day in the week from the date.
    const wday1 = weekday(normalize({ year, month, day }));
    if (wday !== wday1) day += (wday - wday1 + 7) % 7;
  }
  if (tlHour !== undefined) timeGiven = true;
  if (year < 100) year += 2000;
  let forcedYear = false;
  if (truthy(e8.variable("org-read-date-force-compatible-dates"))) {
    if (year < 1970) [year, forcedYear] = [1970, true];
    if (year > 2037) [year, forcedYear] = [2037, true];
  }
  return { date: normalize({ year, month, day, hour, minute }), timeGiven, endTime, forcedYear };
}

/**
 * Reads a date as Org's date prompt does, as org-read-date-analyze: the
 * time only if the answer gives one, or with WITH_TIME, the default's.
 * DEF is the default, the time now unless a timestamp is being changed.
 * The result has a range's end time, if WITH_END and one was given.
 */
export function parseDate(input: string, withTime = false, def: DateTime = promptDefault(), withEnd = false): DateTime & { endTime?: string } {
  const r = readDateAnalyze(input, { hour: 0, minute: 0, ...def }, withEnd);
  if (r.forcedYear) e8.message("Year was forced into compatible range (1970-2037)");
  const d: DateTime & { endTime?: string } = { year: r.date.year, month: r.date.month, day: r.date.day };
  if (r.timeGiven || withTime) [d.hour, d.minute] = [r.date.hour, r.date.minute];
  if (r.endTime !== undefined) d.endTime = r.endTime;
  return d;
}

/**
 * An answer to the date prompt, as org-read-date takes it with its
 * calendar: what was typed, then a space and no date clicked in the
 * calendar, which E8 does not show. So the answer is never ISO 8601 text
 * alone, which parse-time-string would read whole.
 */
export function readDateAnswer(prompt: string): string {
  return `${e8.readString(prompt, { history: "org-read-date-history" })} `;
}

/** A range's end time as org-insert-timestamp puts it before the bracket, -HH:MM, if it has hours and minutes. */
function endTimeText(endTime: string | undefined): string {
  const m = endTime === undefined ? null : /([0-9]+):([0-9]+)/.exec(endTime);
  return m ? `-${pad2(Number(m[1]))}:${pad2(Number(m[2]))}` : "";
}

/**
 * A timestamp for a date read from the prompt, with its range's end time,
 * as org-insert-timestamp makes it: after the day's name if no time was
 * given, as Org puts it there too.
 */
export function stampFor(d: DateTime & { endTime?: string }, active: boolean): string {
  const end = endTimeText(d.endTime);
  return active ? `<${formatTimestamp(d)}${end}>` : `[${formatTimestamp(d)}${end}]`;
}

/**
 * A timestamp's repeater and warning, such as "+1w -2d", as org-timestamp and
 * org--deadline-or-schedule take them from the one they replace.
 */
function repeaterOf(ts: string | undefined): string | undefined {
  return ts === undefined ? undefined : /([.+-]+[0-9]+[hdwmy](?:[/ ][-+]?[0-9]+[hdwmy])?)/.exec(ts.replace(/^[<[]\d{4}-\d{2}-\d{2}/, ""))?.[1];
}

/** A new timestamp with the repeater of the one it replaces put back before its end. */
function withRepeater(text: string, old: string | undefined): string {
  const repeater = repeaterOf(old);
  return repeater === undefined || repeaterOf(text) !== undefined ? text : `${text.slice(0, -1)} ${repeater}${text.slice(-1)}`;
}

/** The commands that make a range when one follows the other on a timestamp, as org-timestamp checks. */
const TIMESTAMP_COMMANDS = ["org-time-stamp", "org-time-stamp-inactive", "org-timestamp", "org-timestamp-inactive"];

/**
 * Inserts a timestamp for a date read from the prompt, as org-timestamp
 * does: on a timestamp, it replaces it, its repeater and warning kept, or
 * right after one that C-c . or C-c ! just made, it makes a range. With
 * INPUT undefined, as C-u C-u, the time now.
 */
function insertTimestamp(input: string | undefined, active: boolean): void {
  const withTime = Array.isArray(e8.prefixArg());
  const p = e8.point();
  const ts = tsMatches(lineAt()).find((t) => t.start <= p && p <= t.end);
  const old = ts && e8.bufferText(ts.start, ts.end);
  // The parts not given come from the timestamp at point, if any, as Org's default time.
  const def = old === undefined ? undefined : timestampTime(old);
  const date = input === undefined ? today(true) : parseDate(input, withTime, def, true);
  const named = (x: unknown): string => (typeof x === "symbol" ? e8.symbolName(x) : String(x ?? ""));
  if (ts && TIMESTAMP_COMMANDS.includes(named(e8.lastCommand())) && TIMESTAMP_COMMANDS.includes(named(e8.thisCommand()))) {
    e8.insert("--");
    // Before markers, as org-insert-timestamp inserts.
    e8.insertBeforeMarkers(stampFor(date, active));
    return;
  }
  if (ts && old !== undefined) {
    const repeater = /(?:[.+-]+[0-9]+[hdwmy] ?)+/.exec(old)?.[0];
    e8.deleteRegion(ts.start, ts.end);
    e8.gotoChar(ts.start);
    e8.insertBeforeMarkers(stampFor(date, active));
    // Before the bracket, where point stays, as org-timestamp puts it back.
    if (repeater !== undefined) {
      e8.gotoChar(e8.point() - 1);
      e8.insert(` ${repeater}`);
    }
    e8.message("Timestamp updated");
    return;
  }
  e8.insertBeforeMarkers(stampFor(date, active));
}

const timestamp = e8.defineCommand({
  name: "org-timestamp",
  doc:
    "Insert an active timestamp, such as <2026-10-28 Wed>, for a date read in the minibuffer; on a timestamp, change it.\n\n" +
    "Empty is today; +3 is three days on, and +2w, +1m, +1y and +3h work too, ++ counting from the timestamp at point; " +
    "fri is the next Friday; 2026-11-03, 11-03, 3, 3.11.2026, 11/3/26, nov 3 and w45 are the next such date; " +
    "add a time as 10:30, 3pm or 15h, or a range as 10:00-11:00 or 10:00+1:30. With C-u, the time goes in too; " +
    "with C-u C-u, the time now, without asking.",
  params: [{ name: "date", value: () => (doublePrefix() ? "" : readDateAnswer("Date: ")) }],
  run: (input: string) => insertTimestamp(doublePrefix() ? undefined : input, true),
});

const inactiveTimestamp = e8.defineCommand({
  name: "org-timestamp-inactive",
  doc: "Insert an inactive timestamp, such as [2026-10-28 Wed], which the agenda leaves out. See org-timestamp.",
  params: [{ name: "date", value: () => (doublePrefix() ? "" : readDateAnswer("Date: ")) }],
  run: (input: string) => insertTimestamp(doublePrefix() ? undefined : input, false),
});

e8.defineVariable({ name: "org-read-date-history", doc: "Dates answered to Org's date prompt, newest first.", value: [] });

/**
 * Puts `what` with timestamp `ts` at the start of the planning line under
 * a heading, taking out its old one and the keywords `remove` names, each
 * up to the next keyword, as org-add-planning-info does; a new line if
 * there is none. Always rewrites the line, so the buffer is modified.
 */
function addPlanningInfo(headingLine: number, what: string, ts: string, remove: string[]): void {
  const next = headingLine + 1;
  if (!(next < e8.lineCount() && PLANNING.test(e8.lineText(next)))) {
    const end = e8.lineEnd(headingLine);
    // Indented one past the stars with org-adapt-indentation, as org-add-planning-info.
    replaceText(end, end, `\n${" ".repeat(adaptColumn(headingLine))}${what}: ${ts}`);
    return;
  }
  const ind = /^[ \t]*/.exec(e8.lineText(next))![0].length;
  const start = e8.lineStart(next) + ind;
  // Each keyword going, deleted where it is up to the next keyword or the line's end, as Org deletes them.
  for (const type of [what, ...remove]) {
    const rest = e8.bufferText(start, e8.lineEnd(next));
    const m = new RegExp(`\\b${type}: *${type === "CLOSED" ? "\\[[^\\]\\n]+\\]" : "<[^>\\n]+>"}`).exec(rest);
    if (!m) continue;
    const from = start + charCount(rest.slice(0, m.index));
    const after = rest.slice(m.index + m[0].length);
    const k = /(?:SCHEDULED|DEADLINE|CLOSED):[ \t]*[<[]/.exec(after);
    replaceText(from, k ? from + charCount(m[0]) + charCount(after.slice(0, k.index)) : e8.lineEnd(next), "");
  }
  // No space left at the end.
  const left = e8.bufferText(start, e8.lineEnd(next));
  const trimmed = left.replace(/[ \t]+$/, "");
  if (trimmed !== left) replaceText(start + charCount(trimmed), e8.lineEnd(next), "");
  // The keyword and its timestamp at the line's start, the timestamp before markers, as org-insert-timestamp puts it, and a space if more follows.
  replaceText(start, start, `${what}: `);
  const at = start + charCount(`${what}: `);
  insertBeforeMarkersAt(at, ts);
  const end = at + charCount(ts);
  if (end !== e8.lineEnd(next)) replaceText(end, end, " ");
}

/** Inserts TEXT at AT before every marker there, point and Org's own too, as insert-before-markers. */
function insertBeforeMarkersAt(at: number, text: string): void {
  const n = charCount(text);
  let p = e8.point();
  const saved: [Marker, number][] = markers.map((m) => [m, m.pos >= at ? m.pos + n : m.pos]);
  if (p >= at) p += n;
  e8.gotoChar(at);
  e8.insertBeforeMarkers(text);
  placeMarkers(saved);
  e8.gotoChar(p);
}

/** Sets or, with undefined, removes a planning keyword's timestamp on the line after a heading. */
function setPlanning(headingLine: number, keyword: string, ts: string | undefined): void {
  const next = headingLine + 1;
  const planning = next < e8.lineCount() && /^[ \t]*(SCHEDULED|DEADLINE|CLOSED):/.test(e8.lineText(next));
  if (!planning) {
    if (ts === undefined) return;
    const end = e8.lineEnd(headingLine);
    replaceText(end, end, `\n${" ".repeat(adaptColumn(headingLine))}${keyword}: ${ts}`);
    return;
  }
  const text = e8.lineText(next);
  const re = new RegExp(`${keyword}: *[<[][^>\\]\\n]*[>\\]]`);
  let updated: string;
  if (re.test(text)) updated = ts === undefined ? text.replace(re, "") : text.replace(re, `${keyword}: ${ts}`);
  else updated = ts === undefined ? text : `${text.trimEnd()} ${keyword}: ${ts}`;
  // The line's indentation kept, as Org deletes only from the keyword on.
  const indent = /^[ \t]*/.exec(text)![0];
  const rest = updated.slice(indent.length).replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");
  updated = rest === "" ? "" : indent + rest;
  if (updated === text) return;
  const ls = e8.lineStart(next);
  // The whole line and its newline, as Org deletes it, so what pointed into it is left at its start.
  if (updated === "") replaceText(ls, Math.min(e8.pointMax(), e8.lineEnd(next) + 1), "");
  else replaceText(ls, e8.lineEnd(next), updated);
}

/** Whether the prefix argument is C-u C-u. */
function doublePrefix(): boolean {
  const arg = e8.prefixArg();
  return Array.isArray(arg) && arg[0] === 16;
}

/** A date as a count of days, to tell how many lie between two. */
function dayCount(d: DateTime): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86400000);
}

/** Plans the heading point is under, its edits not unfolding what they touch, as org--deadline-or-schedule ignores them. */
function plan(keyword: string, input: string | (() => string)): void {
  withoutFoldChecks(() => planHere(keyword, typeof input === "string" ? () => input : input));
}

/** Plans the heading point is under, reading the date from `input` only once it is needed, as org--deadline-or-schedule reads it. */
function planHere(keyword: string, input: () => string): void {
  const [all, i] = backToHeading();
  const deadline = keyword === "DEADLINE";
  const log = e8.variable(deadline ? "org-log-redeadline" : "org-log-reschedule");
  const next = all[i].line + 1;
  const old = next < e8.lineCount() ? new RegExp(`${keyword}: *([<[][^>\\]\\n]*[>\\]])`).exec(e8.lineText(next))?.[1] : undefined;
  // As org--deadline-or-schedule: the change is logged as org-log-reschedule or org-log-redeadline says.
  // time and state store only the heading; anything else, t included, asks for a note, as org-add-log-note.
  const howOf = (x: e8.Value | undefined) => (x === "time" || x === "state" ? x : "note");
  // C-u C-u: a warning or delay for the date there, as org--deadline-or-schedule asks.
  if (doublePrefix()) {
    const lines = [all[i].line, next].filter((l) => l < e8.lineCount());
    for (const l of lines) {
      const m = new RegExp(`\\b${keyword}: *<([^>]+)>`).exec(e8.lineText(l));
      if (!m) continue;
      const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(m[1]);
      // Read from the old date, as org--deadline-or-schedule gives it as the default.
      const days = d ? Math.abs(dayCount(parseDate(input(), false, timestampTime(`<${m[1]}>`))) - dayCount({ year: +d[1], month: +d[2], day: +d[3] })) : 0;
      const start = e8.lineStart(l) + m.index;
      replaceText(start, start + m[0].length, `${keyword}: <${m[1].replace(/ -[0-9]+[hdwmy]/, "")} -${days}d>`);
      return;
    }
    e8.userError(deadline ? "No deadline information to update" : "No scheduled information to update");
  }
  if (Array.isArray(e8.prefixArg())) {
    if (old === undefined) {
      e8.message(deadline ? "Entry had no deadline to remove" : "Entry was not scheduled");
      return;
    }
    if (truthy(log)) addLogNote(all[i].line, deadline ? "deldeadline" : "delschedule", undefined, old, { how: howOf(log) });
    setPlanning(all[i].line, keyword, undefined);
    e8.message(deadline ? "Entry no longer has a deadline." : "Entry is no longer scheduled.");
    return;
  }
  // The parts not given come from the old date, as its default time.
  const date = parseDate(input(), false, old === undefined ? undefined : timestampTime(old), true);
  // The old date's repeater and warning stay, as org--deadline-or-schedule keeps them.
  const inserted = stampFor(date, true);
  const ts = withRepeater(inserted, old);
  // At the start of the planning line, CLOSED taken out, as org-add-planning-info with closed to remove.
  addPlanningInfo(all[i].line, keyword, ts, ["CLOSED"]);
  if (old !== undefined && truthy(log) && old !== inserted) addLogNote(all[i].line, deadline ? "redeadline" : "reschedule", inserted, old, { how: howOf(log) });
  e8.message(`${deadline ? "Deadline on" : "Scheduled to"} ${ts}`);
}

/**
 * Plans every heading of an active region, as org-schedule and org-deadline
 * give org-map-entries org--deadline-or-schedule, which reads a date for
 * each: the first heading takes the date the command read, the others ask
 * again when they need one, unless code gave the date, as TIME is used for
 * each. Hidden headings are left, as their skip function goes past a
 * hidden subtree.
 */
function planEach(keyword: string, input: string): void {
  const asks = e8.calledInteractively();
  let date: string | undefined = input;
  const once = () => {
    plan(keyword, date ?? (() => readPlanDate(keyword)));
    if (asks) date = undefined;
  };
  if (!forEachHeadingInRegion(once)) plan(keyword, input);
}

/**
 * The date org--deadline-or-schedule reads for a heading: the date to warn
 * or delay from with C-u C-u, refused first if the heading at point has no
 * such date, as it checks before asking, unless not CHECK, as when the
 * region's first heading is not the one at point.
 */
function readPlanDate(keyword: string, check = true): string {
  if (check && doublePrefix()) {
    const all = headings();
    const i = headingIndex(all, lineAt());
    const lines = i === undefined ? [] : [all[i].line, all[i].line + 1].filter((l) => l < e8.lineCount());
    if (i !== undefined && !lines.some((l) => new RegExp(`\\b${keyword}: *<`).test(e8.lineText(l))))
      e8.userError(keyword === "DEADLINE" ? "No deadline information to update" : "No scheduled information to update");
  }
  const prompt = doublePrefix() ? (keyword === "DEADLINE" ? "Warn starting from: " : "Delay until: ") : "Date: ";
  return readDateAnswer(prompt);
}

/**
 * Whether an active region the planning commands loop over has no heading
 * they would visit, so they ask for no date, as Org asks in each heading.
 */
function planLoopsOverNothing(): boolean {
  let any = false;
  return forEachHeadingInRegion(() => {
    any = true;
  }) && !any;
}

/** The date org-schedule or org-deadline reads for KEYWORD as its argument: none with C-u or a region with no heading, as their interactive specs read it. */
export function planDateArgument(keyword: "SCHEDULED" | "DEADLINE"): string {
  return (Array.isArray(e8.prefixArg()) && !doublePrefix()) || planLoopsOverNothing() ? "" : readPlanDate(keyword, !e8.regionActive());
}

const schedule = e8.defineCommand({
  name: "org-schedule",
  doc: "Schedule the heading point is under for a date read as org-timestamp reads it. With C-u, unschedule it, asking for no date. With the region active, every heading in it, asking for each (org-loop-over-headlines-in-active-region).",
  params: [
    {
      name: "date",
      // C-u C-u asks for the date to warn or delay from, C-u for none, as org--deadline-or-schedule.
      value: () => ((Array.isArray(e8.prefixArg()) && !doublePrefix()) || planLoopsOverNothing() ? "" : readPlanDate("SCHEDULED", !e8.regionActive())),
    },
  ],
  run: (input) => planEach("SCHEDULED", input),
});

const deadline = e8.defineCommand({
  name: "org-deadline",
  doc: "Give the heading point is under a deadline, read as org-timestamp reads it. With C-u, remove it. With the region active, every heading in it, asking for each (org-loop-over-headlines-in-active-region).",
  params: [
    {
      name: "date",
      // C-u C-u asks for the date to warn or delay from, C-u for none, as org--deadline-or-schedule.
      value: () => ((Array.isArray(e8.prefixArg()) && !doublePrefix()) || planLoopsOverNothing() ? "" : readPlanDate("DEADLINE", !e8.regionActive())),
    },
  ],
  run: (input) => planEach("DEADLINE", input),
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
  // Every repeating timestamp in the entry, its heading's too, as org-auto-repeat-maybe searches from the heading.
  for (let line = h.line; line < e8.lineCount() && e8.lineStart(line) < end; line++) {
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
    // Levels reduced with org-odd-levels-only, as org-imenu-get-tree counts them.
    const level = reducedLevel(h.level);
    if (level > depth || !/\S/.test(headline)) continue;
    if (level >= lastLevel) {
      subs[level]!.unshift([headline, h.start]);
    } else {
      subs[level]!.unshift([headline, subs.slice(level + 1).flat()]);
      for (let i = level + 1; i <= depth; i++) subs[i] = [];
    }
    lastLevel = level;
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

/**
 * What a link type does, as org-link-set-parameters keeps it: following
 * it; storing a link to point's place, as :store, returning whether it
 * did after org-link-store-props; completing one, as :complete; and the
 * description to offer, as :insert-description.
 */
export interface LinkParameters {
  follow?: (path: string) => void;
  store?: { name: string; run: (interactive: boolean) => unknown };
  complete?: () => string;
  insertDescription?: string | ((link: string, description: string | undefined) => string | undefined);
}
const linkTypes = new Map<string, LinkParameters>();

/** Whether a link type is one Org knows, as org-link-any-re matches only those. */
export function linkTypeKnown(type: string): boolean {
  return linkTypes.has(type.toLowerCase());
}

/** Sets what links of TYPE do, as org-link-set-parameters: id: links, as org-id.ts does, or a package's own; other parameters are kept. */
export function linkSetParameters(type: string, parameters: LinkParameters): void {
  linkTypes.set(type, { ...linkTypes.get(type), ...parameters });
}

/** The link types and their parameters, newest first, as org-link-parameters lists them. */
export function linkTypeEntries(): [string, LinkParameters][] {
  return [...linkTypes.entries()].reverse();
}

// Org's mark ring, as org-mark-ring and org-mark-ring-last-goto: the places
// before jumps, newest first, org-mark-ring-length of them.

e8.defineVariable({ name: "org-mark-ring-length", doc: "How many places Org's mark ring keeps, for C-c & to go back to.", value: 4 });

/** The ring's markers, a slot each, newest at `head`, and where the last C-c & went. */
const markRing: { slots: (e8.Marker | undefined)[]; head: number; lastGoto: number | undefined } = { slots: [], head: 0, lastGoto: undefined };

/** The ring's size, fixed when first used, as org-mark-ring is made when org.el loads. */
function markRingSize(): number {
  if (markRing.slots.length === 0) markRing.slots = new Array(Math.max(1, Number(e8.variable("org-mark-ring-length") ?? 4))).fill(undefined);
  return markRing.slots.length;
}

/**
 * Saves a place in Org's mark ring, point by default, and in the buffer's
 * own mark ring, as org-mark-ring-push does, saying C-c & goes back.
 */
export function markRingPush(pos = e8.point(), buffer: e8.BufferLike = e8.currentBuffer()): void {
  e8.withCurrentBuffer(buffer, () => e8.pushMark(pos));
  const size = markRingSize();
  markRing.head = (markRing.head + size - 1) % size;
  const old = markRing.slots[markRing.head];
  if (old !== undefined) e8.deleteMarker(old);
  markRing.slots[markRing.head] = e8.makeMarker(pos, { buffer: e8.bufferName(buffer) });
  e8.message("Position saved to mark ring, go back with \u2018C-c &\u2019.");
}

e8.defineCommand({
  name: "org-mark-ring-push",
  doc: "Save point in Org's mark ring, for C-c & to come back to.",
  run: () => markRingPush(),
});

e8.defineCommand({
  name: "org-mark-ring-goto",
  doc: "Go back to the place saved last in Org's mark ring; again, to the one before, and so on round the ring. With a count, that many back.",
  params: [{ name: "n", kind: "count" }],
  run: (n) => {
    const size = markRingSize();
    // Going on from the last C-c & when repeated, as org-mark-ring-goto compares last-command.
    const at = e8.lastCommand() === "org-mark-ring-goto" ? ((markRing.lastGoto ?? markRing.head) + n) % size : markRing.head;
    markRing.lastGoto = at;
    const m = markRing.slots[at];
    const buffer = m === undefined ? undefined : e8.markerBuffer(m);
    if (m === undefined || buffer === undefined) e8.signal("error", "Marker does not point anywhere");
    e8.call("pop-to-buffer-same-window", buffer);
    e8.gotoChar(e8.markerPosition(m) ?? e8.point());
    if (invisibleHere()) foldShowContext("mark-goto");
  },
});

/** Goes to an internal link's place, as org-link-open does: Org's mark ring first remembers where point was. */
function followInternal(path: string): void {
  markRingPush();
  const pos = searchInBuffer(path);
  e8.gotoChar(pos);
  showContext(pos);
}

e8.defineCommand({
  name: "org-save-all-org-buffers",
  doc: "Save every Org buffer visiting a file, without asking.",
  run: () => {
    e8.message("Saving all Org buffers...");
    for (const b of e8.bufferList()) {
      e8.withCurrentBuffer(b, () => {
        if (e8.derivedModeP("org-mode") && e8.bufferFileName() !== undefined && e8.bufferModifiedP()) e8.call("save-buffer");
      });
    }
    e8.message("Saving all Org buffers... done");
  },
});

export function openLink(link: Link): void {
  const path = link.path;
  const type = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(path);
  const handler = type ? linkTypes.get(type[1].toLowerCase()) : undefined;
  if (type && handler?.follow) {
    handler.follow(type[2]);
    return;
  }
  const file = /^file:(.*)$/.exec(path)?.[1] ?? (/^(?:\/|~\/|\.\.?\/)/.test(path) ? path : undefined);
  if (file !== undefined) {
    const [name, search] = file.split("::");
    const dir = (e8.bufferFileName() ?? "").replace(/[^/]*$/, "");
    const full = /^[/~]/.test(name) ? name : dir + name;
    // Where point was, kept if the link leads to another place in Org, as org-open-file's save-position-maybe does.
    const [oldBuffer, oldPos, oldOrg] = [e8.currentBuffer(), e8.point(), e8.variable("major-mode") === "org-mode"];
    e8.call("find-file", full);
    if (search) {
      if (/^\d+$/.test(search)) e8.gotoChar(e8.lineStart(Number(search) - 1));
      else jump(searchInBuffer(search));
    }
    if (oldOrg && e8.derivedModeP("org-mode") && (e8.currentBuffer().id !== oldBuffer.id || e8.point() !== oldPos)) markRingPush(oldPos, oldBuffer);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^(id|file):/.test(path)) {
    throw new Error(`E8 cannot open ${path.split(":")[0]} links yet: ${path}`);
  }
  followInternal(path);
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
/** Elements whose text is raw, with no links in it for C-c C-o, as org-element-context finds none there. */
const RAW_TEXT = ["example-block", "export-block", "fixed-width", "latex-environment"];

/** Whether an element's text is raw, holding no links or other objects: as RAW_TEXT's, or a table.el table's. */
function rawTextElement(e: Elem | undefined): boolean {
  return RAW_TEXT.includes(e?.type ?? "") || (e?.type === "table" && e.tableType === "table.el");
}

/** The link point is on, where Org's parser finds links: not in an element whose text is raw. */
function linkAtPoint(): Link | undefined {
  return rawTextElement(elementAt(e8.point())) ? undefined : linkHere();
}

function openAtPoint_(): void {
  const link = linkAtPoint();
  if (link) {
    openLink(link);
    return;
  }
  // On a footnote reference, or a definition's label, its footnote, as Org's footnote context.
  const footnote = e8.funcall("org-footnote--open-context");
  if (footnote === "reference" || footnote === "definition") {
    e8.call("org-footnote-action");
    return;
  }
  // On a timestamp, the agenda for its day, as org-follow-timestamp-link
  // opens it. A planning or clock line has nothing else to follow; a clock's
  // timestamp takes in the spaces after it. Elsewhere the spaces after a
  // timestamp are its object's, with nothing to follow; and an example
  // block or the like has no timestamps, only the entry's links.
  const p0 = e8.point();
  const type = elementAt(p0)?.type;
  if (type === "planning" || type === "clock") {
    if (timestampDatesAt(p0, false) === undefined && !(type === "clock" && afterTimestamp(p0))) e8.userError("No link found");
    e8.funcall("org-follow-timestamp-link");
    return;
  }
  if (!["example-block", "export-block", "fixed-width", "latex-environment", "src-block"].includes(type ?? "")) {
    if (timestampDatesAt(p0, false) !== undefined) {
      e8.funcall("org-follow-timestamp-link");
      return;
    }
    if (afterTimestamp(p0)) e8.userError("No link found");
  }
  // Elsewhere in a footnote definition there is nothing to follow, as Org's context there is the definition.
  if (footnote === "text") e8.userError("No link found");
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
export function linksIn(from: number, to: number): { links: string[]; last: number } {
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
      // Only links Org's parser finds, as org-offer-links-in-entry asks
      // org-element-context: none in raw text or a source block's code.
      const el = elementAt(at(l, text, m.index));
      if (rawTextElement(el) || el?.type === "src-block") continue;
      last = at(l, text, m.index);
      if (!out.includes(m.text)) out.push(m.text);
    }
  }
  return { links: out, last };
}


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
  // As Org's typing and deleting commands do, only with org-auto-align-tags on.
  if (truthy(e8.variable("org-auto-align-tags") ?? true)) e8.call("org-fix-tags-on-the-fly");
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
e8.defun("org-speed-priority", (letter: e8.Value) => setPriority(String(letter).codePointAt(0)!));

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
    // In help-mode, as with-output-to-temp-buffer shows it, even in a *Help* made afresh.
    withHelpWindow(() => e8.insert(text));
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

/**
 * The values a property may take, as org-property-get-allowed-values reads
 * NAME_ALL, inherited: each read as Lisp, so a string's quotes go and a
 * number is written as Lisp writes it; :ETC means others may be typed.
 */
export function allowedValues(h: Heading | undefined, property: string): { values: string[]; restricted: boolean } {
  // Before the first heading, the file's own, as org-entry-get finds them at point-min.
  const all = h === undefined ? topGet(`${property}_ALL`) ?? globalProperty(`${property}_ALL`) : entryGetInherited(h, `${property}_ALL`, false);
  const values: string[] = [];
  let restricted = true;
  for (const m of allMatches(/"((?:[^"\\]|\\.)*)"|(\S+)/g, all ?? "")) {
    if (m[1] !== undefined) values.push(m[1].replace(/\\(.)/g, "$1"));
    else if (m[2] === ":ETC") restricted = false;
    else values.push(/^[-+]?(\d+\.?\d*|\.\d+)$/.test(m[2]) ? String(Number(m[2])) : m[2]);
  }
  return { values, restricted };
}

/** Whether TEXT is a duration Org reads, as org-duration-to-minutes checks: H:MM, H:MM:SS, a number, or units such as 1h 30min. */
function validDuration(text: string): boolean {
  const t = text.trim();
  return /^\d+(?::\d{2}){1,2}$/.test(t) || /^[-+]?\d*\.?\d+$/.test(t) || /^(\s*[-+]?\d*\.?\d+\s*(min|h|d|w|m|y))+(\s+\d+(:\d{2}){1,2})?$/.test(t);
}

/**
 * Sets the entry's Effort, as org-set-effort: to the next of the allowed
 * values with INCREMENT, else to VALUE, else one read, of the allowed ones
 * if there are any.
 */
function setEffort(increment: boolean, value?: string): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const property = String(e8.variable("org-effort-property") ?? "Effort");
  const { values: allowed, restricted } = allowedValues(h, property);
  const current = entryGet(h.line, property);
  let next: string;
  if (increment) {
    if (allowed.length === 0) e8.userError("Allowed effort values are not set");
    const at = current === undefined ? -1 : allowed.indexOf(current);
    if (at < 0 || at + 1 >= allowed.length) e8.userError(`Unknown value ${current === undefined ? "nil" : JSON.stringify(current)} among allowed values`);
    next = allowed[at + 1];
  } else next = value ?? e8.completingRead("Effort: ", allowed, { requireMatch: allowed.length > 0 && restricted });
  if (!validDuration(next)) e8.signal("error", `Invalid duration format: ${JSON.stringify(next)}`);
  if (next !== current) e8.saveExcursion(() => entryPut(h.line, property, next));
  // The clocked task's effort in the mode line too, as Org matches it by title.
  if (h.title.replace(/^COMMENT[ \t]+/, "") === e8.variable("org-clock-current-task") && e8.fboundp("org-clock-update-mode-line")) {
    e8.setVariable("org-clock-effort", next);
    e8.funcall("org-clock-update-mode-line");
  }
  e8.message(`${property} is now ${next}`);
}

e8.defineVariable({ name: "org-effort-property", doc: "The property that holds an entry's estimated effort.", value: "Effort" });

e8.defineCommand({
  name: "org-set-effort",
  doc: "Set the effort property of the current entry, from its allowed values (Effort_ALL) if it has any; with a prefix argument, to the next of them.",
  params: [{ name: "increment", kind: "prefix" }],
  run: (increment: e8.Value) => setEffort(increment !== null && increment !== undefined),
});

e8.defineCommand({
  name: "org-inc-effort",
  doc: "Increment the value of the effort property in the current entry.",
  run: () => setEffort(true),
});

// Blocks, as org-next-block and org-previous-block go to them.

/**
 * Goes N blocks on, or back with BACKWARD, to the line that opens each,
 * as org-next-block: a #+BEGIN line that opens a block element.
 */
function nextBlock(n: number, backward: boolean): void {
  const origin = e8.point();
  let count = n;
  let found: number | undefined;
  let line = lineAt();
  const types = ["center-block", "comment-block", "dynamic-block", "example-block", "export-block", "quote-block", "special-block", "src-block", "verse-block"];
  // From the line's start back, or its end on, as Org starts its search.
  const step = backward ? -1 : 1;
  // Within the narrowing, as Org's search is.
  const first = lineAt(e8.pointMin());
  const last = lineAt(e8.pointMax());
  for (let l = backward ? line - 1 : line + 1; l >= first && l <= last && count > 0; l += step) {
    if (!/^[ \t]*#\+BEGIN/i.test(e8.lineText(l))) continue;
    const el = elementAt(e8.lineStart(l));
    if (el && types.includes(el.type) && e8.lineStart(l) <= el.begin) {
      found = el.begin;
      count--;
    }
  }
  if (count === 0 && found !== undefined) {
    e8.gotoChar(found);
    showContext(found);
    return;
  }
  e8.gotoChar(origin);
  e8.userError(`No ${backward ? "previous" : "further"} code blocks`);
}

e8.defineCommand({
  name: "org-next-block",
  doc: "Jump to the next block; with a count, that many on.",
  params: [{ name: "arg", kind: "count" }],
  run: (n: number) => nextBlock(n, false),
});

e8.defineCommand({
  name: "org-previous-block",
  doc: "Jump to the previous block; with a count, that many back.",
  params: [{ name: "arg", kind: "count" }],
  run: (n: number) => nextBlock(n, true),
});

// Sorting, as org-sort and org-sort-entries.

e8.defineHook("org-after-sorting-entries-or-items-hook", "Run after entries or items have been sorted, point in the parent's line or the first entry.");

/** Text as it shows: emphasis markers and links' brackets gone, as org-sort-remove-invisible, nested ones too. */
function sortRemoveInvisible(s: string): string {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out
      .replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, l: string, d?: string) => d ?? l)
      .replace(/<((?:https?|ftp|mailto|file|doi|id|news|shell|elisp|help|info):[^>\n]*)>/g, "$1")
      .replace(/(^|[\s\-('"{])([*\/_=~+])(\S|\S.*?\S)\2(?=[\s\-.,:!?;'")}\[*\/_=~+]|$)/g, "$1$3");
  }
  return out;
}

/** A string's leading number, as string-to-number reads it, else 0. */
function stringToNumber(s: string): number {
  const m = /^[ \t\n]*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(s);
  return m ? Number(m[1]) : 0;
}

/** A timestamp's time in seconds, as org-time-string-to-seconds. */
function timestampSeconds(ts: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[^\]>\n]*?(\d{1,2}):(\d{2}))?/.exec(ts);
  if (!m) return 0;
  return e8.encodeTime([0, Number(m[5] ?? 0), Number(m[4] ?? 0), Number(m[3]), Number(m[2]), Number(m[1])]);
}

/** The minutes an entry's CLOCK lines add up to, as org-clock-sum counts them: from their timestamps, else their => duration. */
function clockMinutes(text: string): number {
  let minutes = 0;
  for (const line of text.split("\n")) {
    const clock = /^[ \t]*CLOCK:[ \t]*(.*)$/.exec(line);
    if (!clock) continue;
    const range = /\[([^\]]+)\]--\[([^\]]+)\]/.exec(clock[1]);
    if (range) minutes += Math.floor((timestampSeconds(range[2]) - timestampSeconds(range[1])) / 60);
    else {
      const d = /=>[ \t]*(\d+):(\d{2})/.exec(clock[1]);
      if (d) minutes += Number(d[1]) * 60 + Number(d[2]);
    }
  }
  return minutes;
}

/** The properties the buffer's entries and keywords name, and Org's special ones, sorted, as org-buffer-property-keys with specials. */
function bufferPropertyKeys(): string[] {
  const keys = new Set<string>(["ALLTAGS", "BLOCKED", "CLOCKSUM", "CLOCKSUM_T", "CLOSED", "DEADLINE", "FILE", "ITEM", "PRIORITY", "SCHEDULED", "TAGS", "TIMESTAMP", "TIMESTAMP_IA", "TODO"]);
  for (const [, , text] of keywordLines()) {
    const m = /^#\+PROPERTY:[ \t]*(\S+)/i.exec(text);
    if (m) keys.add(m[1].replace(/\+$/, ""));
  }
  let inDrawer = false;
  for (let l = 0; l < e8.lineCount(); l++) {
    const text = e8.lineText(l);
    if (/^[ \t]*:PROPERTIES:[ \t]*$/i.test(text)) inDrawer = true;
    else if (/^[ \t]*:END:[ \t]*$/i.test(text)) inDrawer = false;
    else if (inDrawer) {
      const m = /^[ \t]*:(\S+?):/.exec(text);
      if (m) keys.add(m[1].replace(/\+$/, ""));
    }
  }
  return [...keys].sort();
}

/**
 * Sorts the children of the entry at point, the entries of the region or
 * the top-level entries, as org-sort-entries: by SORTING-TYPE, a
 * character of a, n, p, r, o, t, s, d, c, k or f, a capital reversing it.
 */
/**
 * Takes out a Local Variables list near the widened buffer's end, as
 * org-preserve-local-variables does: from the last line within 3000
 * characters of the end starting "# Local Variables:", in any case, to
 * the end, unrecorded in the undo list. Returns the text taken.
 */
function takeLocalVariables(): e8.PropertizedString | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const max = e8.pointMax();
    const from = Math.max(max - 3000, e8.pointMin());
    const text = e8.bufferSubstringNoProperties(from, max);
    const re = /^[ \t]*# +Local Variables:/gim;
    let found: number | undefined;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // A match at the slice's start counts only where a line starts, as ^ needs.
      if (m.index > 0 || from === e8.lineStart(lineAt(from))) found = m.index;
    }
    if (found === undefined) return undefined;
    const at = from + charCount(text.slice(0, found));
    const taken = e8.bufferSubstring(at, max);
    e8.letBind({ "buffer-undo-list": true }, () => e8.deleteRegion(at, max));
    return taken;
  });
}

/**
 * Runs `f` with a Local Variables list near the buffer's end set aside, put
 * back at the end afterwards, the buffer left unmodified if `f` changed
 * nothing, as org-preserve-local-variables does.
 */
export function preserveLocalVariables<T>(f: () => T): T {
  const taken = takeLocalVariables();
  const tick = e8.bufferModifiedTick();
  try {
    return f();
  } finally {
    if (taken !== undefined) {
      const modified = tick < e8.bufferModifiedTick();
      putBackLocalVariables(taken);
      if (!modified) e8.restoreBufferModifiedP(false);
    }
  }
}

/** Puts back what takeLocalVariables took, at the widened buffer's end after a newline, as org-preserve-local-variables does. */
function putBackLocalVariables(text: e8.PropertizedString): void {
  e8.saveRestriction(() => {
    e8.widen();
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMax());
      if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
      e8.letBind({ "buffer-undo-list": true }, () => e8.insert(text));
    });
  });
}

function sortEntries(withCase: boolean, sortingType?: string): void {
  let start: number;
  let end: number;
  let what: string;
  const all0 = headings();
  const here = headingIndex(all0, lineAt());
  if (orgRegionActive()) {
    const rb = Math.min(e8.point(), e8.mark()!);
    const re = Math.max(e8.point(), e8.mark()!);
    start = all0.find((h) => h.start >= e8.lineStart(lineAt(rb)))?.start ?? e8.pointMax();
    // To the next heading after the subtree the region ends in, as org-end-of-subtree with TO-HEADING.
    const atEnd = headingIndex(all0, lineAt(re));
    end = atEnd === undefined ? e8.pointMax() : subtreeRegion(all0, atEnd)[1];
    what = "region";
    e8.gotoChar(start);
  } else if (here !== undefined) {
    start = all0[here].start;
    e8.gotoChar(subtreeRegion(all0, here)[1]);
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    // Back over blank lines, then the line after them, as org-back-over-empty-lines with forward-line.
    let back = e8.point();
    while (back > start && /^[ \t]*$/.test(e8.lineText(lineAt(back - 1))) && lineAt(back - 1) !== lineAt(back)) back = e8.lineStart(lineAt(back - 1));
    end = back < e8.point() ? e8.lineStart(lineAt(back) + 1) : e8.point();
    what = "children";
    e8.gotoChar(start);
    e8.call("outline-show-subtree");
    const all = headings();
    e8.gotoChar(all[headingIndex(all, lineAt())! + 1]?.start ?? e8.pointMax());
  } else {
    start = all0[0]?.start ?? e8.pointMax();
    // A last line with text gets a newline, as Org's (looking-at ".*?\\S-") asks.
    e8.gotoChar(e8.lineStart(lineAt(e8.pointMax())));
    if (/\S/.test(e8.lineText(lineAt()))) {
      e8.gotoChar(e8.lineEnd(lineAt()));
      e8.insert("\n");
    }
    end = e8.pointMax();
    what = "top-level";
    e8.gotoChar(start);
    e8.call("outline-show-all");
  }
  const beg = e8.point();
  if (beg >= end) {
    e8.gotoChar(start);
    e8.userError("Nothing to sort");
  }
  const stars = /^(\*+)/.exec(e8.lineText(lineAt()))?.[1] ?? "*";
  let txt = e8.bufferSubstringNoProperties(beg, end);
  if (!txt.endsWith("\n")) txt += "\n";
  if (stars !== "*" && new RegExp(`^${stars.slice(1).replace(/\*/g, "\\*")}[ \\t\\n]`, "m").test(txt)) e8.userError("Region to sort contains a level above the first entry");
  let type = sortingType;
  if (type === undefined) {
    e8.message(
      `Sort ${what}: [a]lpha  [n]umeric  [p]riority  p[r]operty  todo[o]rder  [f]unc\n               [t]ime [s]cheduled  [d]eadline  [c]reated  cloc[k]ing\n               A/N/P/R/O/F/T/S/D/C/K means reversed:`,
    );
    type = e8.readCharExclusive();
  }
  const dcst = type.toLowerCase();
  let property: string | undefined;
  let getkey: string | undefined;
  let compare: string | undefined;
  if (dcst === "f") {
    [getkey, compare] = readSortFunctions();
  }
  if (dcst === "r") property = e8.completingRead("Property: ", bufferPropertyKeys(), { requireMatch: true });
  e8.message("Sorting entries...");
  e8.saveRestriction(() => {
    e8.narrowToRegion(start, end);
    // A newline at its end, as Org puts one there before sorting.
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMax());
      if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    });
    // A Local Variables list near the buffer's end is taken out while the entries are sorted and put back
    // after, unrecorded in the undo list, as org-preserve-local-variables does around sort-subr.
    const localVariables = takeLocalVariables();
    try {
      const sortEnd = e8.pointMax();
      const all = headings();
      const level = stars.length;
      const starsRe = new RegExp(`^${stars.replace(/\*/g, "\\*")} +`);
      // The records, as sort-subr finds them: from one of the first's level to
      // the next of that level, or the end when a higher heading comes first,
      // as outline-forward-same-level fails.
      const records: { h: Heading; start: number; end: number }[] = [];
      let pos = beg;
      while (pos < sortEnd) {
        const h = all.find((x) => x.start === pos);
        if (!h) break;
        let recEnd = sortEnd;
        for (const x of all) {
          if (x.start <= pos || x.start >= sortEnd) continue;
          if (x.level < level) break;
          if (x.level === level) {
            recEnd = x.start;
            break;
          }
        }
        records.push({ h, start: pos, end: recEnd });
        const next = all.find((x) => x.start >= recEnd && x.start < sortEnd && starsRe.test(e8.lineText(x.line)) && x.level === level);
        if (!next || recEnd >= sortEnd) break;
        pos = next.start;
      }
      const now = e8.currentTime();
      const caseFn = (s: string) => (withCase ? s : s.toLowerCase());
      const keyOf = (r: (typeof records)[number]): string | number => {
        const text = e8.bufferSubstringNoProperties(r.start, r.end);
        // The entry's own text, to its next heading, as org's searches bound by outline-next-heading.
        const next = all.find((x) => x.start > r.start);
        const entryText = e8.bufferSubstringNoProperties(r.start, next && next.start < r.end ? next.start : r.end);
        const title = sortRemoveInvisible(r.h.title.replace(/^COMMENT[ \t]+/, ""));
        switch (dcst) {
          case "n":
            return stringToNumber(title);
          case "a":
            return caseFn(title);
          case "k":
            return clockMinutes(text);
          case "t": {
            const m = /<\d{4}-\d{2}-\d{2}[^>\n]*>/.exec(entryText) ?? /[[<]\d{4}-\d{2}-\d{2}[^\]>\n]*[\]>]/.exec(entryText);
            return m ? timestampSeconds(m[0]) : now;
          }
          case "c": {
            // An inactive timestamp alone, as org-ts-regexp1: a date, its day and a time, no range or repeater.
            const m = /^[ \t]*\[(\d{4}-\d{2}-\d{2}(?: +[^\]\s\d+>-]+)?(?: +\d{1,2}:\d{2})?)\]/m.exec(entryText);
            return m ? timestampSeconds(m[1]) : now;
          }
          case "s": {
            const m = /SCHEDULED: *<([^>]+)>/.exec(entryText);
            return m ? timestampSeconds(m[1]) : now;
          }
          case "d": {
            const m = /DEADLINE: *<([^>]+)>/.exec(entryText);
            return m ? timestampSeconds(m[1]) : now;
          }
          case "p": {
            // The cookie's first character, or the default as a number, as org-sort-entries has them.
            const m = /\[#([A-Z0-9]+)\]/.exec(e8.lineText(r.h.line));
            return m ? m[1].codePointAt(0)! : priorityOption("org-priority-default", "B");
          }
          case "r":
            return entryGet(r.h.line, property!) ?? "";
          case "o": {
            const kws = allKeywords();
            const m = r.h.todo;
            const tail = m === undefined ? 0 : kws.length - kws.indexOf(m);
            return m !== undefined && isDone(m) ? 99 + tail : 99 - tail;
          }
          case "f": {
            const v = e8.saveExcursion(() => (e8.gotoChar(r.start), e8.funcall(getkey!)));
            return typeof v === "string" ? caseFn(v) : (v as number);
          }
          default:
            return e8.signal("error", `Invalid sorting type \`${type}'`);
        }
      };
      const keyed = records.map((r, i) => ({ i, key: keyOf(r), text: e8.bufferSubstring(r.start, r.end) }));
      // As sort-subr: reversed, the records are taken last first, sorted, and turned round again.
      const reverse = dcst !== type;
      const numeric = typeof keyed[0]?.key === "number";
      const less = (a: string | number, b: string | number): boolean => {
        if (dcst === "a") return e8.stringCollateLessp(String(a), String(b));
        if (dcst === "f" && compare) return truthy(e8.funcall(compare, a, b) ?? null);
        // The first key's kind picks the comparison, as sort-subr's does.
        return numeric ? Number(a) < Number(b) : String(a) < String(b);
      };
      let list = reverse ? [...keyed].reverse() : keyed;
      list = sortByPredicate(list, (x, y) => less(x.key, y.key));
      if (reverse) list.reverse();
      if (records.length > 0) {
        // As sort-reorder-buffer: all but the last character of what is sorted
        // deleted, the sorted text put before that one, and it deleted, so the
        // markers in the text go to its start, and those at its end stay there.
        const min = e8.pointMin();
        const old = e8.bufferSubstringNoProperties(min, sortEnd);
        const sorted = e8.concat(e8.bufferSubstring(min, records[0].start), ...list.map((k) => k.text), e8.bufferSubstring(records[records.length - 1].end, sortEnd));
        // The kept markers, as Org marks the character before the clock's with a text property to find it again.
        const kept: [e8.Marker, number, number][] = [];
        for (const keep of sortKeepers) {
          const m = keep();
          const pos = m === undefined || e8.markerBuffer(m) !== e8.bufferName() ? undefined : e8.markerPosition(m);
          if (m === undefined || pos === undefined || pos <= min || pos > sortEnd) continue;
          const r = records.findIndex((x) => x.start <= pos - 1 && pos - 1 < x.end);
          kept.push([m, r, r < 0 ? pos : pos - records[r].start]);
        }
        const wasModified = e8.bufferModifiedP();
        e8.saveExcursion(() => {
          e8.deleteRegion(min, sortEnd - 1);
          e8.gotoChar(min);
          e8.insert(sorted);
          const last = min + charCount(sorted.string);
          e8.deleteRegion(last, last + 1);
        });
        // Each kept marker at the same place in its record, now where the record went.
        const starts = new Map<number, number>();
        // The text before the first record is as long as it was, as is the whole.
        let at = records[0].start;
        for (const k of list) {
          starts.set(k.i, at);
          at += charCount(k.text.string);
        }
        for (const [m, r, offset] of kept) e8.setMarker(m, r < 0 ? offset : starts.get(r)! + offset, e8.bufferName());
        // Unchanged text leaves the buffer unmodified if it was, as with-buffer-unmodified-if-unchanged.
        if (!wasModified && sorted.string === old) e8.restoreBufferModifiedP(false);
      }
    } finally {
      if (localVariables !== undefined) putBackLocalVariables(localVariables);
    }
  });
  // The drawers folded again, as org-cycle-hide-drawers 'all, and point at the start, as Org leaves it.
  hideDrawersIn(lineAt(start), Math.min(end, e8.pointMax()));
  e8.gotoChar(start);
  e8.runHooks("org-after-sorting-entries-or-items-hook");
  e8.message("Sorting entries...done");
}

e8.defineCommand({
  name: "org-sort-entries",
  doc:
    "Sort entries on a certain level of an outline tree: the region's, else the children of the entry at point, " +
    "else the top-level ones, by a key read: a for alpha, n numeric, p priority, r property, o TODO order, f a " +
    "function, t time, s scheduled, d deadline, c created, k clocking; a capital reverses it. With a prefix argument, case counts.",
  params: [{ name: "with-case", kind: "prefix" }],
  run: (withCase: e8.Value) => sortEntries(withCase !== null && withCase !== undefined),
});

/** Minutes in a duration Org reads, as org-duration-to-minutes: H:MM, H:MM:SS, units such as 1d 3h, or both. */
function durationMinutes(text: string): number | undefined {
  // The units org-duration-units names, longest first, as org-duration-set-regexps orders them.
  const setting = e8.variable("org-duration-units");
  const units: Record<string, number> = Array.isArray(setting)
    ? Object.fromEntries((setting as e8.Value[]).filter(Array.isArray).map((u) => [String((u as e8.Value[])[0]), Number((u as e8.Value[])[1])]))
    : { min: 1, h: 60, d: 1440, w: 10080, m: 43200, y: 525960 };
  const names = Object.keys(units).sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const unit = new RegExp(`([0-9]+(?:\\.[0-9]*)?)[ \\t]*(${names})`, "g");
  const hms = (t: string) => {
    const [h, m, sec] = t.trim().split(":").map(Number);
    return (sec ?? 0) / 60 + m + 60 * h;
  };
  if (/^[ \t]*[0-9]+(?::[0-9]{2}){1,2}[ \t]*$/.test(text)) return hms(text);
  const sum = (t: string) => [...t.matchAll(unit)].reduce((n, m) => n + Number(m[1]) * units[m[2]], 0);
  if (new RegExp(`^(?:[ \\t]*[0-9]+(?:\\.[0-9]*)?[ \\t]*(?:${names}))+[ \\t]*$`).test(text)) return sum(text);
  const mixed = new RegExp(`^((?:[ \\t]*[0-9]+(?:\\.[0-9]*)?[ \\t]*(?:${names}))+)[ \\t]*([0-9]+(?::[0-9]{2}){1,2})[ \\t]*$`).exec(text);
  return mixed ? sum(mixed[1]) + hms(mixed[2]) : undefined;
}

/**
 * Minutes in a duration, as org-duration-to-minutes reads it: what
 * durationMinutes reads, a bare number as minutes, or "" as none; else
 * Org's error.
 */
export function durationToMinutes(text: string): number {
  if (text === "") return 0;
  const minutes = durationMinutes(text);
  if (minutes !== undefined) return minutes;
  if (/^[0-9]+(?:\.[0-9]*)?$/.test(text)) return Number(text);
  return e8.signal("error", `Invalid duration format: ${JSON.stringify(text)}`);
}

/** A sort record: its key and where it is. */
type SortRecord = { key: string | number; start: number; end: number };

/**
 * Puts RECORDS, found in buffer order, in order of their keys, as
 * sort-subr does: stably, REVERSE turning the order round with records of
 * equal keys kept as they were, LESS comparing keys if given, else numbers
 * by < and strings by string<. The text between records stays, and the
 * buffer is left alone if nothing moves. Returns whether anything moved.
 */
function sortRecords(records: SortRecord[], reverse: boolean, less?: (a: string | number, b: string | number) => boolean): boolean {
  if (records.length === 0) return false;
  const indexed = records.map((r, i) => ({ ...r, i }));
  const compare = less ?? ((a: string | number, b: string | number) => (typeof a === "number" && typeof b === "number" ? a < b : String(a) < String(b)));
  let list = reverse ? [...indexed].reverse() : indexed;
  list = sortByPredicate(list, (x, y) => compare(x.key, y.key));
  if (reverse) list.reverse();
  if (list.every((r, i) => r.i === i)) return false;
  const min = records[0].start;
  let text = "";
  for (let k = 0; k < records.length; k++) {
    if (k > 0) text += e8.bufferSubstring(records[k - 1].end, records[k].start);
    text += e8.bufferSubstring(list[k].start, list[k].end);
  }
  e8.deleteRegion(min, records[records.length - 1].end);
  e8.gotoChar(min);
  e8.insert(text);
  return true;
}

/** A function's name, completed from those defined, as org-read-function reads it; empty is none with ALLOW-EMPTY. */
function orgReadFunction(prompt: string, allowEmpty = false): string | undefined {
  const names: string[] = [];
  e8.mapatoms((name) => {
    if (e8.fboundp(name)) names.push(name);
  });
  const answer = e8.completingRead(prompt, names, { requireMatch: true });
  if (answer === "") {
    if (allowEmpty) return undefined;
    e8.userError("Empty input is not valid");
  }
  return answer;
}

/** Reads a key-extracting and a comparing function for sorting by f, as Org's sorting commands ask for them. */
function readSortFunctions(): [string, string | undefined] {
  const getkey = orgReadFunction("Function for extracting keys: ") as string;
  const compare = orgReadFunction("Function for comparing keys (empty for default `sort-subr' predicate): ", true);
  return [getkey, compare];
}

/** The text of field N of a table line, as org-table-get-field reads it, or "". */
function tableField(line: number, n: number): string {
  const fields = e8.lineText(line).replace(/^[ \t]*\|/, "").split("|");
  return n >= 1 && n <= fields.length - (/\|[ \t]*$/.test(e8.lineText(line)) ? 1 : 0) ? fields[n - 1] : "";
}

/**
 * Sorts the table's lines between the rules around point, or the region's,
 * by the column point is in, as org-table-sort-lines: alphabetically,
 * numerically, by time or by a function, a capital reversing it.
 */
export function tableSortLines(withCase: boolean, interactive: boolean, sortingType?: string): void {
  if (orgRegionActive()) e8.gotoChar(Math.min(e8.point(), e8.mark()!));
  // Point must be in a field, or before a data line's first.
  e8.saveExcursion(() => {
    e8.skipCharsBackward(" \t");
    if (e8.point() === e8.lineStart(lineAt())) {
      const bar = e8.lineText(lineAt()).indexOf("|");
      if (bar >= 0) e8.gotoChar(e8.lineStart(lineAt()) + charCount(e8.lineText(lineAt()).slice(0, bar + 1)));
    }
    const before = e8.bufferText(e8.lineStart(lineAt()), e8.point());
    const after = e8.bufferText(e8.point(), e8.lineEnd(lineAt()));
    if (!(atTable() && /[^ \t]/.test(before) && !/^[ \t]*\|-/.test(e8.lineText(lineAt())) && /[^ \t]/.test(after))) e8.userError("Not in table data field");
  });
  const current = (e8.bufferText(e8.lineStart(lineAt()), e8.point()).match(/\|/g) ?? []).length;
  const column = current > 0 ? current : interactive ? Number(e8.readString("Use column N for sorting: ")) : 1;
  const type = sortingType ?? e8.readCharExclusive("Sort Table: [a]lphabetic, [n]umeric, [t]ime, [f]unc.  A/N/T/F means reversed: ");
  const dcst = type.toLowerCase();
  if (!"antf".includes(dcst) || dcst === "") e8.userError(`Invalid sorting type ‘${type}’`);
  let first = lineAt();
  while (first > 0 && /^[ \t]*\|/.test(e8.lineText(first - 1))) first--;
  let last = lineAt();
  while (last + 1 < e8.lineCount() && /^[ \t]*\|/.test(e8.lineText(last + 1))) last++;
  const [tstart, tend] = [e8.lineStart(first), lineStartOrEnd(last + 1)];
  let functions: [string, string | undefined] | undefined;
  if (dcst === "f") {
    if (!interactive) throw new Error("Missing key extractor to sort rows");
    functions = readSortFunctions();
  }
  e8.saveRestriction(() => {
    if (orgRegionActive()) {
      const [rb, re] = [Math.min(e8.point(), e8.mark()!), Math.max(e8.point(), e8.mark()!)];
      e8.gotoChar(rb);
      e8.narrowToRegion(rb, lineStartOrEnd(lineAt(re) + 1));
    } else {
      let from = tstart;
      for (let l = lineAt() - 1; l >= first; l--) {
        if (/^[ \t]*\|-/.test(e8.lineText(l))) {
          from = e8.lineStart(l + 1);
          break;
        }
      }
      let to = tend;
      for (let l = lineAt(); l <= last; l++) {
        if (/^[ \t]*\|-/.test(e8.lineText(l))) {
          to = e8.lineStart(l);
          break;
        }
      }
      e8.narrowToRegion(from, to);
    }
    const row = lineAt() - lineAt(e8.pointMin());
    const col = e8.currentColumn();
    const key = (field: string): string | number => {
      const f = field.trim();
      if (dcst === "n") return stringToNumber(f);
      if (dcst === "a") return sortRemoveInvisible(f);
      if (dcst === "t") {
        const ts = /[[<][0-9]{4}-[0-9]{2}-[0-9]{2}(?: [^\n]*?)?[\]>]/.exec(f);
        if (ts) return timestampSeconds(ts[0]);
        const d = durationMinutes(f);
        if (d !== undefined) return d;
        const hm = /\b[0-9]+:[0-9]{2}\b/.exec(f);
        return hm ? (durationMinutes(hm[0]) ?? 0) : 0;
      }
      return e8.funcall(functions![0], f) as string | number;
    };
    // The records: from point-min, each data line to its end, as sort-subr goes with Org's functions.
    const records: SortRecord[] = [];
    let pos = e8.pointMin();
    while (pos < e8.pointMax()) {
      const line = lineAt(pos);
      const end = Math.min(e8.lineEnd(line), e8.pointMax());
      // A key that is not there is the record's text, as sort-subr takes it.
      records.push({ key: key(tableField(line, column)) ?? e8.bufferSubstringNoProperties(pos, end), start: pos, end });
      let next = line + 1;
      while (lineStartOrEnd(next) < e8.pointMax() && !/^[ \t]*\|(?!-)/.test(e8.lineText(next))) next++;
      pos = lineStartOrEnd(next);
      if (next >= e8.lineCount()) break;
    }
    const less =
      dcst === "a"
        ? // Org asks to ignore case without C-u, which Emacs's collation on macOS, by code point, does not do.
          (a: string | number, b: string | number) => e8.stringCollateLessp(String(a), String(b))
        : dcst === "f"
          ? functions![1] && ((a: string | number, b: string | number) => truthy(e8.funcall(functions![1]!, a, b) ?? null))
          : (a: string | number, b: string | number) => Number(a) < Number(b);
    sortRecords(records, dcst !== type, less || undefined);
    // Back to the field point was in.
    e8.gotoChar(e8.pointMin());
    forwardLine(row);
    e8.moveToColumn(col);
  });
}

/**
 * Sorts the items of the list point is in, sublists moving with their
 * items, as org-sort-list: alphabetically or numerically by their first
 * line, by time, by checkbox or by a function, a capital reversing it.
 */
function sortList(withCase: boolean, interactive: boolean, sortingType?: string): void {
  const caseFn = (s: string) => (withCase ? s : s.toLowerCase());
  const struct = listStruct(lineAt());
  const prevs = prevsAlist(struct);
  const items = allItems(e8.lineStart(lineAt()), prevs);
  const start = items[0];
  const end = getItem(struct, items[items.length - 1]).end;
  let type = sortingType;
  if (type === undefined) {
    e8.message("Sort plain list: [a]lpha  [n]umeric  [t]ime  [f]unc  [x]checked  A/N/T/F/X means reversed:");
    type = e8.readCharExclusive();
  }
  const dcst = type.toLowerCase();
  let functions: [string, string | undefined] | undefined;
  if (dcst === "f") {
    if (!interactive) throw new Error("Missing key extractor");
    functions = readSortFunctions();
  }
  e8.message("Sorting items...");
  e8.saveRestriction(() => {
    e8.narrowToRegion(start, end);
    const now = e8.floatTime();
    const key = (pos: number): string | number | undefined => {
      const line = lineAt(pos);
      const text = e8.lineText(line);
      const m = /^[ \t]*[-+*0-9.)]+([ \t]+\[[- X]\])?[ \t]+/.exec(text);
      if (!m) return undefined;
      const rest = text.slice(m[0].length);
      switch (dcst) {
        case "n":
          return stringToNumber(sortRemoveInvisible(rest));
        case "a":
          return caseFn(sortRemoveInvisible(rest));
        case "t": {
          // After the bullet and any counter, as org-at-item-timer-p looks.
          const timer = /^[ \t]*(?:[-+*]|[0-9]+[.)])[ \t]+(?:\[@(?:start:)?[0-9]+\][ \t]*)?([0-9]+):([0-9]+):([0-9]+)[ \t]+::[ \t]+/.exec(text);
          if (timer) return Number(timer[1]) * 3600 + Number(timer[2]) * 60 + Number(timer[3]);
          const ts = /<[0-9]{4}-[0-9]{2}-[0-9]{2}(?: [^>\n]*?)?>/.exec(text) ?? /[[<][0-9]{4}-[0-9]{2}-[0-9]{2}(?: [^\]>\n]*?)?[\]>]/.exec(text);
          return ts ? timestampSeconds(ts[0]) : now;
        }
        case "x":
          return m[1] ?? "";
        case "f": {
          const v = e8.saveExcursion(() => (e8.gotoChar(pos), e8.funcall(functions![0])));
          return typeof v === "string" ? caseFn(v) : (v as number);
        }
        default:
          throw new Error(`Invalid sorting type ‘${type}’`);
      }
    };
    e8.gotoChar(e8.pointMin());
    const records: SortRecord[] = [];
    for (const pos of items) {
      const recEnd = itemEndBeforeBlank(struct, pos);
      const k = key(pos);
      // A key that is not there is the record's text, as sort-subr takes it.
      records.push({ key: k ?? e8.bufferSubstringNoProperties(pos, recEnd), start: pos, end: recEnd });
    }
    const less =
      dcst === "a"
        ? (a: string | number, b: string | number) => e8.stringCollateLessp(String(a), String(b))
        : dcst === "f"
          ? functions![1] && ((a: string | number, b: string | number) => truthy(e8.funcall(functions![1]!, a, b) ?? null))
          : dcst === "t"
            ? (a: string | number, b: string | number) => Number(a) < Number(b)
            : undefined;
    sortRecords(records, dcst !== type, less || undefined);
    e8.gotoChar(e8.pointMin());
    // The sorted list read and fixed again, as org-list-repair does still narrowed to it.
    const repaired = listStruct(lineAt());
    writeStruct(repaired, parentsAlist(repaired));
    e8.runHooks("org-after-sorting-entries-or-items-hook");
    e8.message("Sorting items...done");
  });
}

e8.defineCommand({
  name: "org-table-sort-lines",
  doc:
    "Sort the table's lines between the rules around point, or the region's, by the column point is in: " +
    "a alphabetically, n numerically, t by time or duration, f by a function; a capital reverses it. With a prefix argument, case counts.",
  params: [{ name: "with-case", kind: "prefix" }],
  run: (withCase: e8.Value) => tableSortLines(withCase !== null && withCase !== undefined, true),
});

e8.defineCommand({
  name: "org-sort-list",
  doc:
    "Sort the items of the list point is in by their first lines: a alphabetically, n numerically, t by time, " +
    "x by checkbox, f by a function; a capital reverses it. Sublists move with their items. With a prefix argument, case counts.",
  params: [{ name: "with-case", kind: "prefix" }],
  run: (withCase: e8.Value) => sortList(withCase !== null && withCase !== undefined, true),
});

const sortCommand = e8.defineCommand({
  name: "org-sort",
  doc: "Sort the entries at point, or the table or plain list there, as org-sort-entries, org-table-sort-lines or org-sort-list do.",
  params: [{ name: "with-case", kind: "prefix" }],
  run: (withCase: e8.Value) => {
    const caseMatters = withCase !== null && withCase !== undefined;
    if (atTableP()) tableSortLines(caseMatters, true);
    // On an item's own line, as org-at-item-p.
    else if (itemLine(lineAt())) sortList(caseMatters, true);
    else sortEntries(caseMatters);
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
    if (atTableP()) e8.call("org-table-move-column-left");
    else if (regionStartsAtHeading() || headingHere()) {
      if (hiddenBelow("headlines")) hiddenTreeError();
      e8.call("org-do-promote");
    } else if (itemHere() || regionStartsAtItem()) {
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
    if (atTableP()) e8.call("org-table-move-column-right");
    else if (DRAWER_RE.test(e8.lineText(lineAt()))) e8.call("org-indent-drawer");
    else if (atBlock()) e8.call("org-indent-block");
    else if (regionStartsAtHeading() || headingHere()) {
      if (hiddenBelow("headlines")) hiddenTreeError();
      e8.call("org-do-demote");
    } else if (itemHere() || regionStartsAtItem()) {
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
    // On the first line, of the buffer or of a narrowing, move-beginning-of-line
    // and move-end-of-line with 0 both stay at its start.
    const first = e8.lineStart(lineAt(a)) <= e8.pointMin();
    const [c, d] = first ? [e8.pointMin(), e8.pointMin()] : [e8.lineStart(prev), e8.lineEnd(prev)];
    transposeRegions(a, b, c, d);
    e8.setMark(c);
    e8.gotoChar(c + (b - a));
  } else {
    const next = atBol(b) ? lineAt(b) : lineAt(b) + 1;
    const [c, d] = next < e8.lineCount() && e8.lineStart(next) < e8.pointMax() ? [e8.lineStart(next), Math.min(e8.lineEnd(next), e8.pointMax())] : [e8.pointMax(), e8.pointMax()];
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
  // From its affiliated keywords too, as Org's element holds them.
  const el = withAffiliated(elementAt(e8.point()));
  if (el?.type !== "src-block") return;
  const header = e8.lineText(lineAt(el.postAffiliated ?? el.begin));
  const lang = /^[ \t]*#\+begin_src[ \t]+([^ \t:]\S*)/i.exec(header)?.[1] ?? "nil";
  if (action === "load") throw new Error(`No org-babel-load-session function for ${lang}!`);
  // The session from the block's line, else its #+HEADER: lines, as org-babel-get-src-block-info merges them; none is no session.
  const headers = [header];
  for (let l = lineAt(el.begin); l < lineAt(el.postAffiliated ?? el.begin); l++) if (/^[ \t]*#\+headers?:/i.test(e8.lineText(l))) headers.push(e8.lineText(l));
  const session = headers.map((h) => /(?:^|[ \t]):session(?:[ \t]+([^ \t:][^ \t]*))?/.exec(h)).find((m) => m !== null);
  if (!session || session[1] === "none") throw new Error("This block is not using a session!");
  throw new Error(`No org-babel-initiate-session function for ${lang}!`);
}

const metaUp = e8.defineCommand({
  name: "org-metaup",
  doc: "M-<up> in Org: move a subtree, an item or a table row up past the one before it.",
  run: () => {
    babelSessionHook("load");
    if (metaRegion(true)) return;
    if (atTableP()) e8.call("org-table-move-row-up");
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
    if (atTableP()) e8.call("org-table-move-row-down");
    else if (headingHere()) e8.call("org-move-subtree-down");
    else if (itemHere()) e8.call("org-move-item-down");
    else e8.call("org-drag-element-forward");
  },
});

const shiftMetaLeft = e8.defineCommand({
  name: "org-shiftmetaleft",
  doc: "M-S-<left> in Org: promote a subtree, outdent an item with its children, or delete a table column.",
  run: () => {
    if (atTableP()) e8.call("org-table-delete-column");
    else if (headingHere()) e8.call("org-promote-subtree");
    // The region's first line, with one, as Org looks at it.
    else if (orgRegionActive() ? regionStartsAtItem() : itemHere()) e8.call("org-outdent-item-tree");
    else e8.userError("This command is active in special context like tables, headlines or items");
  },
});

const shiftMetaRight = e8.defineCommand({
  name: "org-shiftmetaright",
  doc: "M-S-<right> in Org: demote a subtree, indent an item with its children, or insert a table column.",
  run: () => {
    if (atTableP()) e8.call("org-table-insert-column");
    else if (headingHere()) e8.call("org-demote-subtree");
    else if (orgRegionActive() ? regionStartsAtItem() : itemHere()) e8.call("org-indent-item-tree");
    else e8.userError("This command is active in special context like tables, headlines or items");
  },
});

const shiftMetaUp = e8.defineCommand({
  name: "org-shiftmetaup",
  doc: "M-S-<up> in Org: delete the table row point is on, or drag the line up.",
  run: () => {
    if (atTableP()) e8.call("org-table-kill-row");
    else e8.callWithPrefix(e8.prefixArg(), "org-drag-line-backward");
  },
});

const shiftMetaDown = e8.defineCommand({
  name: "org-shiftmetadown",
  doc: "M-S-<down> in Org: insert a table row above the one point is on, or drag the line down.",
  run: () => {
    if (atTableP()) e8.call("org-table-insert-row");
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
 * Sets the property on point's line to its next allowed value, or with
 * PREVIOUS the one before, as org-property-next-allowed-value: of those
 * NAME_ALL and the like give, or a checkbox's; the first after the last.
 */
function propertyNextAllowedValue(previous = false): void {
  // Widened, as Org finds the heading and the allowed values outside a narrowing.
  e8.saveRestriction(() => {
    e8.widen();
    propertyNextAllowedValueWide(previous);
  });
}

function propertyNextAllowedValueWide(previous: boolean): void {
  const key = propertyAtPoint();
  if (key === undefined) e8.userError("Not at a property");
  const line = lineAt();
  const value = /^[ \t]*:\S+?:(?:[ \t]+(.*?))?[ \t]*$/.exec(e8.lineText(line))?.[1] ?? "";
  const all = headings();
  const i = headingIndex(all, line);
  // The heading first, as Org reads its components before the allowed values, so before the first it signals.
  if (i === undefined) backToHeading();
  let allowed = allowedAtPoint(key)?.values ?? (["[ ]", "[-]", "[X]"].includes(value) ? ["[ ]", "[X]"] : []);
  if (allowed.length === 0) e8.userError("Allowed values for this property have not been defined");
  if (previous) allowed = [...allowed].reverse();
  const at = allowed.indexOf(value);
  const next = (at >= 0 ? allowed[at + 1] : undefined) ?? allowed[0];
  if (next === value) e8.userError("Only one allowed value for this property");
  replaceText(e8.lineStart(line), e8.lineEnd(line), ` :${key}: ${next}`);
  e8.call("org-indent-line");
  e8.gotoChar(e8.lineStart(line));
  e8.skipCharsForward(" \t");
  // The running clock's effort too, as Org matches the task by its heading.
  const effort = String(e8.variable("org-effort-property") ?? "Effort");
  if (key === effort && i !== undefined && all[i].title === e8.variable("org-clock-current-task") && e8.fboundp("org-clock-update-mode-line")) {
    e8.setVariable("org-clock-effort", next);
    e8.funcall("org-clock-update-mode-line");
  }
  e8.runHooks("org-property-changed-functions", key, next);
}

e8.defineCommand({
  name: "org-property-next-allowed-value",
  doc: "Set the property on point's line to its next allowed value.",
  run: () => propertyNextAllowedValue(false),
});
e8.defineCommand({
  name: "org-property-previous-allowed-value",
  doc: "Set the property on point's line to its previous allowed value.",
  run: () => propertyNextAllowedValue(true),
});

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
    // An Org table, not a table.el one.
    for (let e = elementAt(p); e; e = e.parent) if (e.type === "table") return e.tableType !== "table.el";
    return false;
  });
}

/**
 * Shifts the :block of the clock table whose #+BEGIN: line point is on,
 * as org-clocktable-try-shift; false if point is on no such line.
 */
function clocktableTryShift(dir: "up" | "down" | "left" | "right"): boolean {
  if (!e8.lookingAt("[ \t]*#\\+BEGIN:[ \t]+clocktable\\>", e8.lineStart(lineAt()), { caseFold: true })) return false;
  e8.funcall("org-clocktable-shift", dir, e8.prefixArg());
  return true;
}

for (const key of ["up", "down", "left", "right"]) {
  e8.defineHook(`org-shift${key}-hook`, `Functions S-<${key}> in Org runs first, the first to give non-nil doing it.`);
  e8.defineHook(`org-shift${key}-final-hook`, `Functions S-<${key}> in Org runs when nothing else it does applies, before selecting or its error.`);
}
e8.defineVariable({
  name: "org-edit-timestamp-down-means-later",
  doc: "Whether S-<down> on a timestamp makes it later and S-<up> earlier, the other way round from the default.",
  value: false,
});

/**
 * Org's S-<up> or S-<down>, as org-shiftup and org-shiftdown: its hook
 * first, a region extended with org-support-shift-select, a timestamp, a
 * heading's priority, an item, a clock table's block, a table's cell, its
 * final hook, then selecting or Org's error.
 */
function shiftVertical(up: boolean): void {
  const key = up ? "up" : "down";
  const support = shiftSupport();
  const motion = up ? "previous-line" : "next-line";
  if (truthy(e8.runHookWithArgsUntilSuccess(`org-shift${key}-hook`))) return;
  if (support !== "off" && orgRegionActive()) return callForShiftSelect(motion);
  if (timestampHere()) {
    const later = up !== truthy(e8.variable("org-edit-timestamp-down-means-later") ?? null);
    return e8.callWithPrefix(e8.prefixArg(), later ? "org-timestamp-up" : "org-timestamp-down");
  }
  if (support !== "always" && truthy(e8.variable("org-priority-enable-commands") ?? true) && headingHere()) return e8.call(up ? "org-priority-up" : "org-priority-down");
  if (support === "off" && itemHere()) return e8.call(up ? "org-previous-item" : "org-next-item");
  if (clocktableTryShift(key)) return;
  if (support !== "always" && atTableP()) return e8.call(up ? "org-table-move-cell-up" : "org-table-move-cell-down");
  if (truthy(e8.runHookWithArgsUntilSuccess(`org-shift${key}-final-hook`))) return;
  if (support !== "off") return callForShiftSelect(motion);
  shiftSelectError();
}

/** Whether point is on an item's bullet, as org-at-item-bullet-p: not on a space, before the text after it. */
function atItemBullet(): boolean {
  const item = itemHere();
  const c = e8.charAfter();
  return item !== undefined && c !== " " && c !== "\t" && e8.point() < item.contentAt;
}

/**
 * Org's S-<right> or S-<left>, as org-shiftright and org-shiftleft: its
 * hook first, a region extended with org-support-shift-select, a
 * timestamp, a heading's TODO state, a list's bullets, a property's value,
 * a clock table's block, a table's cell, its final hook, then selecting or
 * Org's error.
 */
function shiftHorizontal(right: boolean): void {
  const key = right ? "right" : "left";
  const support = shiftSupport();
  const motion = right ? "forward-char" : "backward-char";
  if (truthy(e8.runHookWithArgsUntilSuccess(`org-shift${key}-hook`))) return;
  if (support !== "off" && orgRegionActive()) return callForShiftSelect(motion);
  if (timestampHere()) return e8.callWithPrefix(e8.prefixArg(), right ? "org-timestamp-up-day" : "org-timestamp-down-day");
  if (support !== "always" && headingHere()) {
    // org-todo, which loops over the headings in an active region.
    const one = () => todo(right ? 1 : -1, undefined, true, { chosen: true });
    if (!forEachHeadingInRegion(one, { hiddenPoint: true })) one();
    return;
  }
  if ((support === "on" && atItemBullet()) || (support === "off" && itemLine(lineAt()))) return right ? cycleListBullet() : cycleListBullet("previous");
  if (support !== "always" && propertyAtPoint() !== undefined) return propertyNextAllowedValue(!right);
  if (clocktableTryShift(key)) return;
  if (support !== "always" && atTableP()) return e8.call(right ? "org-table-move-cell-right" : "org-table-move-cell-left");
  if (truthy(e8.runHookWithArgsUntilSuccess(`org-shift${key}-final-hook`))) return;
  if (support !== "off") return callForShiftSelect(motion);
  shiftSelectError();
}

const shiftUp = e8.defineCommand({
  name: "org-shiftup",
  doc: "S-<up> in Org: make a timestamp later, raise a heading's priority, move to the previous item, or select up with org-support-shift-select.",
  run: () => shiftVertical(true),
});
const shiftDown = e8.defineCommand({
  name: "org-shiftdown",
  doc: "S-<down> in Org: make a timestamp earlier, lower a heading's priority, move to the next item, or select down with org-support-shift-select.",
  run: () => shiftVertical(false),
});
const shiftRight = e8.defineCommand({
  name: "org-shiftright",
  doc: "S-<right> in Org: move a timestamp a day on, change a heading to its next TODO state, change list bullets, a property to its next allowed value, or select with org-support-shift-select.",
  run: () => shiftHorizontal(true),
});
const shiftLeft = e8.defineCommand({
  name: "org-shiftleft",
  doc: "S-<left> in Org: move a timestamp a day back, change a heading to its previous TODO state, change list bullets, a property to its previous allowed value, or select with org-support-shift-select.",
  run: () => shiftHorizontal(false),
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
  const blocking = fixBox(struct, parents, orderedHere());
  if (box && sameStruct(struct, old)) {
    if (c16) e8.message("Checkboxes already reset");
    else e8.userError(`Cannot toggle this checkbox: ${box === "[X]" ? "all subitems checked" : "unchecked subitems"}`);
  } else {
    applyStruct(struct, old);
    updateCheckboxCount();
  }
  if (blocking !== undefined) e8.message(`Checkboxes were removed due to empty box at line ${currentLine(blocking)}`);
}

/**
 * C-c C-c on a plain list, from its affiliated keywords, as org-ctrl-c-ctrl-c
 * does: with C-u, every item of the list gets a box, or loses it if the
 * first had one; with C-u C-u every box is [-]; else the list is repaired.
 */
function ctrlCCtrlCPlainList(first: number, arg: e8.PrefixArg): void {
  if (e8.variable("org-list-checkbox-radio-mode") === true) return toggleRadioButton(arg);
  const begin = e8.lineStart(first);
  const struct = listStruct(first);
  const old = copyStruct(struct);
  const firstBox = getItem(struct, begin).checkbox;
  const c4 = Array.isArray(arg) && arg[0] === 4;
  const c16 = Array.isArray(arg) && arg[0] === 16;
  const newBox = c16 ? "[-]" : c4 ? (firstBox ? undefined : "[ ]") : firstBox === "[X]" ? "[ ]" : "[X]";
  if (arg !== null && arg !== undefined) for (const pos of allItems(begin, prevsAlist(struct))) getItem(struct, pos).checkbox = newBox;
  // At the list's start with no argument, the first item's box alone, as Org's convenience.
  else if (firstBox && e8.point() === begin) getItem(struct, begin).checkbox = newBox;
  if (sameStruct(writeStruct(struct, parentsAlist(struct), old), old)) e8.message("Cannot update this checkbox");
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
    // As Org, the hook first: ob-core's function on it runs a source block point is in.
    // In *Org Note* and the like, finish it, as org-finish-function says, before anything else.
    // A sparse tree's highlights and org-clock-display's times go first, as Org takes away its temporary overlays.
    const clockShown = Array.isArray(e8.variable("org-clock-overlays")) && (e8.variable("org-clock-overlays") as e8.Value[]).length > 0;
    if (occurHighlights().length > 0 || clockShown) {
      if (clockShown) e8.call("org-clock-remove-overlays" as e8.CommandName);
      removeOccurHighlights(false);
      e8.message("Temporary highlights/overlays removed from current buffer");
      return;
    }
    const finish = e8.variable("org-finish-function");
    if (truthy(finish)) {
      e8.funcall(finish as string);
      return;
    }
    if (truthy(e8.runHookWithArgsUntilSuccess("org-ctrl-c-ctrl-c-hook"))) return;
    const line = lineAt();
    const text = e8.lineText(line);
    if (/^[ \t]*$/.test(text)) nothingUseful();
    // On a footnote reference or a definition's label, as Org's context is the footnote there.
    const footnote = e8.funcall("org-footnote--context");
    if (footnote !== undefined && footnote !== null) {
      if (typeof footnote === "number") e8.gotoChar(footnote);
      e8.callInteractively("org-footnote-action");
      return;
    }
    // A LaTeX environment's text is raw: a table row or a checkbox in it is
    // no table or item, as Org's context there is the environment.
    if (elementAt(e8.point())?.type === "latex-environment") return holdingItemOrNothing(line);
    const here = elementAt(e8.point());
    const inTable = here?.type === "table" || here?.type === "table-row";
    // A table.el table, its rows between lines of +-+, Org leaves to C-c '.
    if (inTable && tableElTable(here)) {
      // Quoted so, where TAB's message, through substitute-command-keys, quotes the key's own quote.
      e8.message("Use \u2018C-c '\u2019 to edit table.el tables");
      return;
    }
    // A timestamp in a table's cell is an object Org's context finds, which
    // it changes rather than aligning the table.
    if (inTable && /^[ \t]*\|(?!-)/.test(text)) {
      const cell = cellTimestamp(line);
      if (cell === "dashes") e8.userError("Not at a timestamp");
      if (cell) {
        changeTimestamp(0, "day");
        return;
      }
    }
    if (here?.type === "table") {
      // At the table's start, Org recalculates every row and does not align.
      e8.call("org-table-recalculate");
      return;
    }
    if (inTable && /^[ \t]*\|/.test(text)) {
      e8.call("org-table-maybe-eval-formula");
      e8.call("org-table-align");
      return;
    }
    // On a list's affiliated keyword, as #+ATTR_ORG:, Org's context is the list.
    if (AFFILIATED.test(text)) {
      // A caption's value is parsed, so a timestamp in it is one, which is changed.
      if (/^[ \t]*#\+CAPTION(?:\[.*\])?:/i.test(text) && (timestampHere() || rangeDashesHere(line)) && affiliatedOfNext(line)) {
        if (rangeDashesHere(line)) e8.userError("Not at a timestamp");
        changeTimestamp(0, "day");
        return;
      }
      let l = line;
      while (l + 1 < e8.lineCount() && AFFILIATED.test(e8.lineText(l + 1))) l++;
      const first = l + 1;
      let list = first < e8.lineCount() && itemLine(first) ? elementAt(e8.lineStart(first)) : undefined;
      while (list && list.type !== "plain-list") list = list.parent;
      if (list && list.begin === e8.lineStart(first)) {
        ctrlCCtrlCPlainList(first, e8.prefixArg());
        return;
      }
      // Otherwise they are the next element's, as Org's context is: a table
      // is recalculated, a source block run by the hook above, and most others
      // can do nothing. #+PLOT: runs gnuplot in Org, which E8 does not.
      let next = first < e8.lineCount() ? elementAt(e8.lineStart(first)) : undefined;
      while (next?.parent && next.parent.begin === e8.lineStart(first)) next = next.parent;
      if (next && next.begin === e8.lineStart(first) && !/^[ \t]*#\+PLOT:/i.test(text)) {
        // A table.el table is left to C-c ', as Org's table context says.
        if (next.type === "table" && next.tableType === "table.el") {
          e8.message("Use \u2018C-c '\u2019 to edit table.el tables");
          return;
        }
        if (next.type === "table") {
          e8.saveExcursion(() => {
            e8.gotoChar(next!.begin);
            e8.call("org-table-recalculate");
          });
          return;
        }
        const nothing = ["paragraph", "quote-block", "center-block", "special-block", "verse-block", "example-block", "export-block", "comment-block", "drawer", "fixed-width", "latex-environment"];
        if (nothing.includes(next.type)) nothingUseful();
      }
    }
    // Inside an example, export or comment block, a #+ line is the block's text.
    if (/^(?:example|export|comment)-block$/.test(elementAt(e8.point())?.type ?? "") && /^[ \t]*#\+/.test(text)) return holdingItemOrNothing(line);
    const dblock = elementAt(e8.point());
    if (dblock?.type === "dynamic-block") {
      e8.saveExcursion(() => {
        e8.gotoChar(dblock.begin);
        updateDblock();
      });
      return;
    }
    if (/^[ \t]*#\+\S*:/.test(text)) {
      storeTodoSets();
      storeTagsLines();
      e8.call("font-lock-flush");
      e8.message("Local setup has been refreshed");
      return;
    }
    if (cookieHere() || cookieEndsTitleBeforePoint()) {
      e8.call("org-update-statistics-cookies");
      return;
    }
    // A CLOCK line off its timestamps: its duration worked out again, as Org's clock context does.
    if (atClockLog() && !timestampHere()) {
      clockUpdateTimeMaybe();
      return;
    }
    // On the two dashes of a range, which Org takes as one timestamp
    // object where it parses objects, as org-timestamp-change then finds no
    // part of one there.
    if (onRangeDashes(line)) e8.userError("Not at a timestamp");
    // Raw text, verbatim or code, or a link's description, holds no
    // timestamp object, so Org's context there can do nothing.
    if (timestampHere() && (RAW_TIMESTAMP_TYPES.includes(elementAt(e8.point())?.type ?? "") || inVerbatimOrLink(e8.point()))) nothingUseful();
    if (timestampHere()) {
      changeTimestamp(0, "day");
      return;
    }
    if (headingHere()) {
      // Where point is, as Org's fallback for a heading calls it: with the
      // region active, the command sets the tags of each heading in it.
      e8.callInteractively("org-set-tags-command");
      return;
    }
    if (itemLine(line)) {
      // At the very start of a list, Org's context is the list, not its first item.
      const list = elementAt(e8.lineStart(line));
      if (radioButtonsHere()) toggleRadioButton(e8.prefixArg());
      else if (list?.type === "plain-list" && e8.point() === list.begin) ctrlCCtrlCPlainList(line, e8.prefixArg());
      else ctrlCCtrlCItem(line, e8.prefixArg());
      return;
    }
    holdingItemOrNothing(line);
  },
});

/** The contexts C-c C-c acts on, as org-ctrl-c-ctrl-c limits org-element-lineage to them; an element's among them. */
const CTRL_C_CTRL_C_ELEMENTS = ["babel-call", "clock", "dynamic-block", "footnote-definition", "inlinetask", "item", "keyword", "node-property", "paragraph", "plain-list", "planning", "property-drawer", "src-block", "table", "table-row"];

/**
 * Up from an element C-c C-c has nothing for, as a LaTeX environment or a
 * block in an item, to the item holding it, as Org's lineage of the
 * contexts it acts on goes; with none, nothing useful to do.
 */
function holdingItemOrNothing(line: number): void {
  const holder = itemHolding(e8.point());
  if (holder === undefined || isBlank(e8.lineText(line))) nothingUseful();
  e8.saveExcursion(() => {
    e8.gotoChar(holder!);
    if (radioButtonsHere()) toggleRadioButton(e8.prefixArg());
    else ctrlCCtrlCItem(lineAt(holder!), e8.prefixArg());
  });
}

/** Where the item starts that C-c C-c's lineage reaches from a position, past elements it does not act on, if it reaches one. */
function itemHolding(pos: number): number | undefined {
  for (let e = elementAt(pos); e; e = e.parent) {
    if (e.type === "item") return e.begin;
    if (CTRL_C_CTRL_C_ELEMENTS.includes(e.type) || e.type === "headline" || e.type === "section") return undefined;
  }
  return undefined;
}

// Dynamic blocks, as org.el has them: #+BEGIN: NAME PARAMETERS, written
// again by the function org-dblock-write:NAME.

/** A dynamic block's first line, its name in group 1 and its parameters in 3, as org-dblock-start-re. */
export const DBLOCK_START_RE = "^[ \t]*#\\+\\(?:BEGIN\\|begin\\):[ \t]+\\(\\S-+\\)\\([ \t]+\\(.*\\)\\)?";
/** A dynamic block's last line, as org-dblock-end-re. */
export const DBLOCK_END_RE = "^[ \t]*#\\+\\(?:END\\|end\\)\\([: \t\r\n]\\|$\\)";

/** A property list's value for KEY, a keyword's name, as plist-get. */
export function plistGet(plist: e8.Value | undefined, key: string): e8.Value {
  if (!Array.isArray(plist)) return null;
  for (let i = 0; i + 1 < plist.length; i += 2) {
    const k = plist[i];
    if (typeof k === "symbol" && e8.symbolName(k) === key) return plist[i + 1];
  }
  return null;
}

/** Sets KEY in a property list, at the end if it was not there, as plist-put; returns the list. */
export function plistPut(plist: e8.Value[], key: string, value: e8.Value): e8.Value[] {
  for (let i = 0; i + 1 < plist.length; i += 2) {
    const k = plist[i];
    if (typeof k === "symbol" && e8.symbolName(k) === key) {
      plist[i + 1] = value;
      return plist;
    }
  }
  plist.push(e8.intern(key), value);
  return plist;
}

/** Property lists merged, later ones winning, as org-combine-plists. */
export function combinePlists(...plists: (e8.Value | undefined)[]): e8.Value[] {
  const out: e8.Value[] = [];
  for (const p of plists) if (Array.isArray(p)) for (let i = 0; i + 1 < p.length; i += 2) plistPut(out, e8.symbolName(p[i] as symbol), p[i + 1]);
  return out;
}

/**
 * The agenda files, as (org-agenda-files t) lists them: each name
 * expanded in org-directory, a directory standing for its Org files, and
 * each file once.
 */
export function agendaFiles(): string[] {
  const files = e8.variable("org-agenda-files");
  if (!Array.isArray(files)) return [];
  const dir = e8.variable("org-directory");
  const base = typeof dir === "string" ? e8.expandFileName(dir) : undefined;
  const all = (files as e8.Value[]).flatMap((f) => {
    const file = e8.expandFileName(String(f), base);
    return e8.fileDirectoryP(file) ? e8.directoryFiles(file, { full: true, match: "\\`[^.].*\\.org\\'" }) : [file];
  });
  // Each once, the first kept, as org-agenda-files's delete-dups.
  return [...new Set(all)];
}

/** Goes to the first dynamic block named NAME and returns where it starts, as org-find-dblock; stays put if there is none. */
export function findDblock(name: string): number | undefined {
  const pos = e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    return e8.reSearchForward(`^[ \t]*#\\+\\(?:BEGIN\\|begin\\):[ \t]+${name}\\>`, { noerror: true, caseFold: true }) === undefined
      ? undefined
      : e8.matchBeginning(0);
  });
  if (pos !== undefined) e8.gotoChar(pos);
  return pos;
}

/**
 * Makes an empty dynamic block on the line after point's, unless that
 * line is blank, its parameters from PLIST, its name from :name, and
 * leaves point on its first line, as org-create-dblock.
 */
export function createDblock(plist: e8.Value[]): void {
  if (/\S/.test(e8.lineText(lineAt()))) {
    e8.gotoChar(e8.lineEnd(lineAt()));
    e8.insert("\n");
  }
  const col = e8.currentColumn();
  let text = `#+BEGIN: ${String(plistGet(plist, ":name"))}`;
  for (let i = 0; i < plist.length; ) {
    const k = plist[i];
    if (typeof k === "symbol" && e8.symbolName(k) === ":name") i += 2;
    else text += ` ${e8.prin1ToString(plist[i++])}`;
  }
  e8.insert(`${text}\n\n${" ".repeat(col)}#+END:\n`);
  forwardLine(-3);
}

/**
 * Empties the dynamic block point is at the start of, leaving point on
 * the blank line inside, and returns its parameters with :name, its
 * :indentation-column and what it held as :content, as org-prepare-dblock.
 */
export function prepareDblock(): e8.Value[] {
  if (!e8.lookingAt(DBLOCK_START_RE, undefined, { caseFold: true })) e8.userError("Not at a dynamic block");
  const begdel = (e8.matchEnd(0) as number) + 1;
  const name = e8.matchString(1) as string;
  const read = e8.readFromString(`(${e8.matchString(3) ?? ""})`)[0];
  const params: e8.Value[] = [e8.intern(":name"), name, ...(Array.isArray(read) ? read : [])];
  // A key without its value, as plist-put finds it.
  if (params.length % 2 !== 0) e8.signal("wrong-type-argument", `Wrong type argument: plistp, ${e8.prin1ToString(params)}`, [e8.intern("plistp"), params]);
  const col = e8.saveExcursion(() => {
    e8.gotoChar(e8.lineStart(lineAt()));
    e8.skipCharsForward(" \t");
    return e8.currentColumn();
  });
  plistPut(params, ":indentation-column", col);
  if (e8.reSearchForward(DBLOCK_END_RE, { noerror: true, caseFold: true }) === undefined) throw new Error("Dynamic block not terminated");
  const end = e8.matchBeginning(0) as number;
  params.push(e8.intern(":content"), e8.bufferText(begdel, end));
  e8.deleteRegion(begdel, end);
  e8.gotoChar(begdel);
  e8.insert("\n");
  e8.gotoChar(begdel);
  return params;
}

/** Goes to the first line of the dynamic block point is in, as org-beginning-of-dblock, or signals. */
function beginningOfDblock(): void {
  const pos = e8.point();
  e8.gotoChar(e8.lineEnd(lineAt()));
  if (e8.reSearchBackward(DBLOCK_START_RE, { noerror: true, caseFold: true }) !== undefined) {
    const beg = e8.matchBeginning(0) as number;
    if (e8.reSearchForward(DBLOCK_END_RE, { noerror: true, caseFold: true }) !== undefined && (e8.matchEnd(0) as number) > pos) {
      e8.gotoChar(beg);
      return;
    }
  }
  e8.gotoChar(pos);
  throw new Error("Not in a dynamic block");
}

/**
 * Writes the dynamic block point is at the start of again, as
 * org-update-dblock: empties it, calls org-dblock-write:NAME with its
 * parameters, and indents what it wrote as its first line is.
 */
export function updateDblock(): void {
  e8.saveExcursion(() => {
    const pos = e8.point();
    const line = lineAt() - lineAt(e8.pointMin()) + 1;
    const params = prepareDblock();
    const name = plistGet(params, ":name") as string;
    const indent = Number(plistGet(params, ":indentation-column") ?? 0);
    e8.message(`Updating dynamic block ‘${name}’ at line ${line}...`);
    e8.funcall(`org-dblock-write:${name}`, params);
    e8.message(`Updating dynamic block ‘${name}’ at line ${line}...done`);
    e8.gotoChar(pos);
    if (indent > 0) {
      e8.saveExcursion(() => {
        beginningOfDblock();
        forwardLine(1);
        const pad = " ".repeat(indent);
        while (!e8.lookingAt(DBLOCK_END_RE, undefined, { caseFold: true })) {
          e8.insert(pad);
          if (forwardLine(1) !== 0) return;
        }
        if (e8.lookingAt("[ \t]+")) e8.replaceMatch("");
        e8.insert(pad);
      });
    }
  });
}

/** Runs COMMAND at each dynamic block in the buffer, saying so when one fails, as org-map-dblocks. */
function mapDblocks(command: () => void): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    while (e8.reSearchForward(DBLOCK_START_RE, { noerror: true, caseFold: true }) !== undefined) {
      e8.gotoChar(e8.matchBeginning(0) as number);
      e8.saveExcursion(() =>
        e8.conditionCase(command, {
          error: () => e8.message("Error during update of dynamic block"),
        }),
      );
      if (e8.reSearchForward(DBLOCK_END_RE, { noerror: true, caseFold: true }) === undefined) throw new Error("Dynamic block not terminated");
    }
  });
}

/** The kinds of dynamic block C-c C-x x inserts, and the function inserting each, as org-dynamic-block-alist. */
const dynamicBlocks: [string, string | ((...args: e8.Value[]) => unknown)][] = [];

/** Makes TYPE a kind of dynamic block C-c C-x x inserts by calling FUNC, as org-dynamic-block-define. */
export function dynamicBlockDefine(type: string, func: string | ((...args: e8.Value[]) => unknown)): void {
  const known = dynamicBlocks.find(([t]) => t === type);
  if (known) known[1] = func;
  else dynamicBlocks.unshift([type, func]);
}
e8.defun("org-dynamic-block-define", dynamicBlockDefine);

e8.defineCommand({
  name: "org-dblock-update",
  doc: "Update the dynamic block point is in, as its #+BEGIN: line says. With C-u, update every dynamic block in the buffer.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (truthy(arg)) e8.call("org-update-all-dblocks");
    else {
      if (!e8.lookingAt(DBLOCK_START_RE, undefined, { caseFold: true })) beginningOfDblock();
      updateDblock();
    }
  },
});

e8.defineCommand({
  name: "org-update-dblock",
  doc: "Update the dynamic block whose #+BEGIN: line point is at the start of.",
  run: () => updateDblock(),
});

e8.defineCommand({
  name: "org-update-all-dblocks",
  doc: "Update every dynamic block in an Org buffer.",
  run: () => {
    if (e8.derivedModeP("org-mode")) mapDblocks(updateDblock);
  },
});

e8.defineCommand({
  name: "org-dynamic-block-insert-dblock",
  doc: "Insert a dynamic block of a kind read with completion, such as a clock table.",
  params: [{ name: "type", kind: "string", prompt: "Dynamic block: ", collection: () => dynamicBlocks.map(([t]) => t) }],
  run: (type: string) => {
    const f = dynamicBlocks.find(([t]) => t === type)?.[1];
    if (f === undefined) throw new Error(`No such dynamic block: ${e8.prin1ToString(type)}`);
    if (typeof f === "string" && e8.commandp(f)) e8.callInteractively(f as e8.CommandName);
    else e8.funcall(f);
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
    if (atTableP()) e8.callWithPrefix(e8.prefixArg(), "org-table-insert-hline");
    else if (orgRegionActive()) e8.callWithPrefix(e8.prefixArg(), "org-toggle-item");
    else if (inItem(line) !== undefined) cycleListBullet();
    else e8.callWithPrefix(e8.prefixArg(), "org-toggle-item");
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
  // In the whole buffer, as org-list--delete-metadata's org-with-wide-buffer.
  e8.saveRestriction(() => {
    e8.widen();
    deleteMetadataWide(line);
  });
}

function deleteMetadataWide(line: number): void {
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
    "items' text; or items back into plain lines.\n\n" +
    "With a prefix argument, make only the first line of the region an item, the other lines its text.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
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
        // Under the heading above with org-adapt-indentation, as org-toggle-item's start-ind: its stars and a space.
        const above = truthy(e8.variable("org-adapt-indentation") ?? null)
          ? [...headings()].reverse().find((x) => x.line < lineAt())
          : undefined;
        const startInd = above === undefined ? 0 : above.level + 1;
        // Levels reduced with org-odd-levels-only, as org-reduced-level gives them.
        let refLevel = reducedLevel((parseHeading(lineAt()) as Heading).level);
        // The bullet as org-list-bullet-string makes it, each level indented by its length.
        const bul = bulletString("-");
        const bulLen = charCount(bul);
        while (e8.point() < end.pos) {
          const line = lineAt();
          const h = parseHeading(line);
          if (!h) break;
          const level = reducedLevel(h.level);
          const delta = Math.max(0, level - refLevel);
          if (level < refLevel) refLevel = level;
          deleteMetadata(line);
          // The stars and TODO state go; the title stays.
          const fresh = parseHeading(line) as Heading;
          const titleAt = fresh.title === "" && fresh.priorityAt === undefined ? fresh.end : (fresh.priorityAt ?? fresh.titleAt);
          const ls = e8.lineStart(line);
          // Org checks folds after each change, and the line is neither a
          // heading nor an item between these two.
          edDelete(ls, titleAt);
          edInsert(ls, bul);
          indentLineTo(line, startInd + bulLen * delta);
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
          shiftText(startInd + bulLen * (delta + 1), limit);
          dropMarker(limit);
        }
      } else if (arg !== null && arg !== undefined) {
        // The first line an item, the others its text, however little they were indented.
        const bul = bulletString("-");
        const refInd = textIndentation(e8.lineText(lineAt()));
        e8.gotoChar(e8.point() + charCount(/^[ \t]*/.exec(e8.lineText(lineAt()))![0]));
        edInsert(e8.point(), bul);
        if (lineAt() + 1 < e8.lineCount()) {
          e8.gotoChar(e8.lineStart(lineAt() + 1));
          while (e8.point() < end.pos) {
            const sectionEnd = headings().find((x) => x.start > e8.point())?.start ?? e8.bufferSize();
            const limit = marker(Math.min(end.pos, sectionEnd));
            shiftText(refInd + charCount(bul), limit);
            dropMarker(limit);
            if (lineAt() + 1 >= e8.lineCount()) break;
            e8.gotoChar(e8.lineStart(lineAt() + 1));
          }
        }
      } else {
        const bul = bulletString("-");
        while (e8.point() < end.pos) {
          const line = lineAt();
          const text = e8.lineText(line);
          const m = /^([ \t]*)(\S)/.exec(text);
          if (m && !isHeadingLine(text) && !itemLine(line)) {
            const ls = e8.lineStart(line);
            replaceKeepingPoint(ls, ls + charCount(m[0]), `${m[1]}${bul}${m[2]}`);
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
    if (atTableP()) e8.call("org-table-recalculate");
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
      // The level of the heading it is under, from the whole buffer, as
      // org-current-level finds it above a narrowing too.
      const level = e8.saveRestriction(() => {
        e8.widen();
        const all = headings();
        const i = headingIndex(all, lineAt(beg));
        return i === undefined ? 0 : all[i].level;
      });
      const count = typeof nstars === "number" ? nstars : level;
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
  // As org-current-level, from the whole buffer, so a heading above a narrowing counts, its level reduced as org-reduced-level does.
  const level = e8.saveRestriction(() => {
    e8.widen();
    const wide = headings();
    const above = headingIndex(wide, lineAt(pos));
    return above === undefined ? 1 : reducedLevel(wide[above].level) + 1;
  });
  // Two stars a level with org-odd-levels-only, as org-list-to-subtree makes them.
  const stars = (n: number) => (e8.variable("org-odd-levels-only") === true ? 2 * n - 1 : n);
  // org-blank-before-new-entry's "auto": a blank line before the heading above means one between these.
  const previous = [...all].reverse().find((h) => h.start < pos);
  const blank = previous !== undefined && previous.start > 0 && /^[ \t]*$/.test(e8.lineText(previous.line - 1));
  const text = entries.map((e) => `${"*".repeat(stars(level + e.depth - 1))} ${e.title}${e.body}`).join(blank ? "\n\n" : "\n");
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
 * Two-character keys for a submenu's entries, as
 * org--insert-structure-template-unique-keys makes them: a one-letter key
 * gets a TAB after it, a longer one is cut to its first letter and the
 * first of its others not taken, shortest keys first.
 */
function structureTemplateUniqueKeys(keys: string[]): string[] {
  const menu = new Map<string, string>();
  for (const key of [...keys].sort((a, b) => [...a].length - [...b].length)) {
    const chars = [...key];
    const potential =
      chars.length === 1 ? `${key}\t` : chars.length === 2 ? key : chars.slice(1).map((c) => chars[0] + c).find((k) => !menu.has(k));
    if (potential === undefined || menu.has(potential)) e8.userError(`Could not make unique key for \`${key}'`);
    menu.set(potential, key);
  }
  return [...menu.entries()].sort((a, b) => keys.indexOf(a[1]) - keys.indexOf(b[1])).map(([k]) => k);
}

/**
 * Asks for a block type by its key in org-structure-template-alist, as
 * org--insert-structure-template-mks does, in *Org Select*: keys sharing a
 * first letter make a submenu under it, and TAB, RET or SPC asks for the
 * type by name.
 */
function readStructureType(): string {
  const templates: [string, string][] = [...structureTemplates(), ["\t", "Press TAB, RET or SPC to write block name"]];
  const starts: string[] = [];
  for (const [key] of templates) if (!starts.includes([...key][0])) starts.push([...key][0]);
  const table: e8.Value[][] = [];
  for (const letter of starts) {
    const sub = templates.filter(([k]) => k.startsWith(letter));
    if (sub.length === 1) {
      table.push([letter, sub[0][1], ""]);
      continue;
    }
    // A submenu, described by its first three types.
    const long = sub.length > 3;
    table.push([letter, sub.slice(0, long ? 3 : sub.length).map(([, t]) => t).join(", ") + (long ? ", ..." : "")]);
    const keys = structureTemplateUniqueKeys(sub.map(([k]) => k));
    sub.forEach(([, type], i) => table.push([keys[i], type, ""]));
  }
  const chosen = orgMks(table, "Select a key\n============", "Key: ") as e8.Value[];
  if (chosen[0] === "\t") {
    const type = e8.readString("Structure type: ");
    if (type === "") e8.userError("Empty structure type");
    return type;
  }
  return String(chosen[1]);
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
    "Insert a block, #+begin_TYPE and #+end_TYPE, around the region if it is active. Asks for its type in *Org Select* by " +
    "the key org-structure-template-alist gives it, keys with a first letter in common in a submenu under it; TAB, RET or SPC types the name.",
  run: () => insertStructureTemplate(readStructureType()),
});

// Cloning a subtree, as org.el's org-clone-subtree-with-time-shift.

e8.defineVariable({
  name: "org-clone-delete-id",
  doc: "Whether clones of a subtree lose its ID property, rather than each having a new one.",
  value: null,
});

/**
 * A clone of TEMPLATE, the K-th, as org-clone-subtree-with-time-shift
 * makes it in a buffer of its own: a new ID, or none; no clock lines, nor
 * the drawers that leaves empty, except in the 0th; timestamps moved on by
 * K times the shift; and repeaters taken out, unless K is KEEP.
 */
function cloneOf(template: string, k: number, idprop: boolean, shift: [number, string] | undefined, keep: number): string {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => {
      e8.insert(template);
      e8.call("org-mode");
      e8.gotoChar(e8.pointMin());
      if (idprop) {
        if (truthy(e8.variable("org-clone-delete-id") ?? null)) {
          const h = parseHeading(lineAt());
          if (h) entryDelete(h, "ID");
        } else e8.callWithPrefix([4], "org-id-get-create");
      }
      if (k !== 0) {
        // Case aside, as Org searches with case-fold-search on.
        for (let l = e8.lineCount() - 1; l >= 0; l--) {
          if (/^[ \t]*CLOCK:/i.test(e8.lineText(l))) e8.deleteRegion(e8.lineStart(l), lineStartOrEnd(l + 1));
        }
        // Each line that could open or close a drawer, and the drawer the
        // parser sees there taken away if it has nothing in it, as
        // org-remove-empty-drawer-at does.
        for (let l = 0; l < e8.lineCount(); l++) {
          if (!/^[ \t]*:(?:[\p{L}\p{N}_]|[-_])+:[ \t]*$/u.test(e8.lineText(l))) continue;
          const drawer = elementAt(e8.lineEnd(l));
          if (!drawer || (drawer.type !== "drawer" && drawer.type !== "property-drawer")) continue;
          if (drawer.contentsBegin !== undefined && (drawer.contentsEnd === undefined || drawer.contentsBegin < drawer.contentsEnd)) continue;
          // From its start, affiliated keywords and all, to the end of its :END: line.
          let begin = drawer.begin;
          while (lineAt(begin) > 0 && AFFILIATED.test(e8.lineText(lineAt(begin) - 1))) begin = e8.lineStart(lineAt(begin) - 1);
          let end = drawer.end;
          while (end > drawer.begin && /[ \r\t\n]/.test(e8.bufferText(end - 1, end))) end--;
          e8.deleteRegion(begin, lineStartOrEnd(lineAt(end) + 1));
          l = lineAt(begin) - 1;
        }
      }
      e8.gotoChar(e8.pointMin());
      if (shift) {
        // Each timestamp, as org-timestamp-change moves it with point just after it.
        const re = /[[<]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[\]>]/g;
        for (let l = 0; l < e8.lineCount(); l++) {
          let from = 0;
          for (;;) {
            re.lastIndex = from;
            const m = re.exec(e8.lineText(l));
            if (!m) break;
            const end = at(l, e8.lineText(l), m.index + m[0].length);
            e8.gotoChar(end);
            changeTimestamp(k * shift[0], shift[1]);
            // Searching on from where point is left, as re-search-forward does.
            const p = e8.point();
            if (lineAt(p) !== l) break;
            from = indexOf(l, e8.lineText(l), p);
          }
        }
        if (k !== keep) {
          for (let l = 0; l < e8.lineCount(); l++) {
            const text = e8.lineText(l);
            const found = allMatches(/<\d{4}-\d{2}-\d{2}(?: [^>\n]*?)?>/g, text).reverse();
            for (const m of found) {
              const r = /^<[^<>\n]+( +[.+]?\+[0-9]+[hdwmy])/i.exec(text.slice(m.index ?? 0));
              if (r) {
                const start = at(l, text, (m.index ?? 0) + r[0].length - r[1].length);
                e8.deleteRegion(start, start + charCount(r[1]));
              }
            }
          }
        }
      }
      return e8.bufferText(e8.pointMin(), e8.pointMax());
    });
  } finally {
    e8.call("kill-buffer", name);
  }
}

/** The shift argument when none was given, so the command asks for one, as Org's does with SHIFT nil. */
const ASK_SHIFT = "\u0000ask";

e8.defineCommand({
  name: "org-clone-subtree-with-time-shift",
  doc:
    "Clone the subtree at point N times, the clones its siblings after it. If it has a timestamp, ask for a shift per clone, as +1w; " +
    "the clones' timestamps then move on clone by clone. Clones lose their clocking, and get new IDs. A subtree with a repeater is " +
    "cloned once more, unshifted, its clones without repeaters, and the original goes last, past them. With C-u, ask for no shift.",
  params: [
    { name: "n", kind: "number", prompt: "Number of clones to produce: " },
    // Asked for in the command, after the count is checked, as Org asks; code can give it.
    { name: "shift", value: () => ASK_SHIFT },
  ],
  run: (n: number, given: string) => {
    if (!Number.isInteger(n) || n < 0) e8.userError(`Invalid number of replications ${n}`);
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (i === undefined) e8.userError("No subtree to clone");
    const beg = all[i!].start;
    const endOfTree = subtreeRegion(all, i!)[1];
    const prefix = e8.prefixArg();
    const plainCU = Array.isArray(prefix) && prefix[0] === 4;
    const hasTimestamp = /[[<]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[\]>]/.test(e8.bufferText(beg, endOfTree));
    const shift =
      given !== undefined && given !== null && given !== ASK_SHIFT
        ? given
        : !plainCU && hasTimestamp
          ? e8.readString("Date shift per clone (e.g. +1w, empty to copy unchanged): ")
          : "";
    // Case aside, as string-match is with case-fold-search on.
    const m = /[^ \t\r\n]/.test(shift) ? /^[ \t]*([+-]?[0-9]+)([hdwmy])[ \t]*$/i.exec(shift) : undefined;
    if (m === null) e8.userError(`Invalid shift specification ${shift}`);
    e8.gotoChar(endOfTree);
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    let doshift: [number, string] | undefined;
    if (m) {
      // Only lowercase units are known, as Org's pcase compares them exactly.
      const units: Record<string, [number, string]> = { h: [1, "hour"], d: [1, "day"], w: [7, "day"], m: [1, "month"], y: [1, "year"] };
      if (units[m[2]] === undefined) e8.signal("error", "Unsupported time unit");
      const [times, what] = units[m[2]];
      doshift = [Number(m[1]) * times, what];
    }
    let end = e8.point();
    const template = e8.bufferText(beg, end);
    let [nmin, nmax, keep] = [1, n, -1];
    const idprop = entryGet(all[i!].line, "ID") !== undefined;
    if (doshift && /<[^<>\n]+ [.+]?\+[0-9]+[hdwmy][^<>\n]*>/i.test(template)) {
      e8.deleteRegion(beg, end);
      end = beg;
      [nmin, nmax] = [0, n + 1];
      keep = nmax;
    }
    e8.gotoChar(end);
    for (let k = nmin; k <= nmax; k++) e8.insert(cloneOf(template, k, idprop, doshift, keep));
    e8.gotoChar(beg);
  },
});

// The mode

const keys: { [keys: string]: e8.CommandName | e8.DefinedCommand } = {
  "C-c C-,": insertStructureTemplateCommand,
  TAB: cycle,
  "S-TAB": shiftTab,
  RET: orgReturn,
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
  "C-S-<right>": "org-shiftcontrolright",
  "C-S-<left>": "org-shiftcontrolleft",
  "C-c C-t": todoCommand,
  "C-c C-z": "org-add-note",
  "C-c C-k": "org-kill-note-or-show-branches",
  "C-c TAB": "org-ctrl-c-tab",
  "C-c ,": "org-priority",
  "C-c C-q": setTagsCommand,
  "C-c /": "org-sparse-tree",
  "C-c %": "org-mark-ring-push",
  "C-c &": "org-mark-ring-goto",
  "C-c C-j": "org-goto",
  "C-c \\": "org-match-sparse-tree",
  "C-c C-c": ctrlCCtrlC,
  "C-c C-x C-b": "org-toggle-checkbox",
  "C-c C-x C-r": "org-toggle-radio-button",
  "C-c C-x C-u": "org-dblock-update",
  "C-c C-x x": "org-dynamic-block-insert-dblock",
  "C-c C-x p": setProperty,
  "C-c C-x b": treeToIndirectBuffer,
  "C-c C-x o": "org-toggle-ordered-property",
  "C-c C-<tab>": "org-cycle-force-archived",
  "C-c C-w": refileCommand,
  "C-c ^": sortCommand,
  "C-c C-x e": "org-set-effort",
  "C-c C-x E": "org-inc-effort",
  "C-c M-f": "org-next-block",
  "C-c M-b": "org-previous-block",
  "C-c C-M-w": refileReverseCommand,
  "C-c M-w": refileCopyCommand,
  "C-c C-x d": insertDrawer,
  "C-x n s": narrowToSubtree,
  "C-x n e": narrowToElement,
  "C-x n b": narrowToBlock,
  "C-c C-l": "org-insert-link",
  "C-c M-l": "org-insert-last-stored-link",
  "C-c C-M-l": "org-insert-all-links",
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
  "M-h": "org-mark-element",
  "C-c |": "org-table-create-or-convert-from-region",
  "C-c +": "org-table-sum",
  "C-c `": "org-table-edit-field",
  "C-c C-x C-w": "org-cut-special",
  "C-c C-x M-w": "org-copy-special",
  "C-c C-x C-y": "org-paste-special",
  "C-c C-x c": "org-clone-subtree-with-time-shift",
  "C-c C-x f": "org-footnote-action",
  "<mouse-1>": mouseFollow,
};

// What C-h h shows in an Org buffer (ADR 0068).
defineGuide("org-mode", {
  title: "Org mode",
  summary:
    "Org keeps notes, tasks and plans in plain text. A line starting with stars is a heading, and what is under " +
    "it folds away, so a long file reads as an outline.",
  keys: [
    [
      "Folding",
      [
        ["org-cycle", "Fold or unfold the heading point is on"],
        ["org-shifttab", "Fold or unfold them all: outline, contents, everything"],
      ],
    ],
    [
      "Headings",
      [
        ["org-meta-return", "A new heading, or list item, after this one"],
        ["org-metaleft", "Promote: one star fewer"],
        ["org-metaright", "Demote: one star more"],
        ["org-metaup", "Move the heading, and all under it, up"],
        ["org-metadown", "Move it down"],
      ],
    ],
    [
      "Tasks",
      [
        ["org-todo", "TODO, then DONE, then neither"],
        ["org-schedule", "Schedule it for a day"],
        ["org-deadline", "Give it a deadline"],
      ],
    ],
    [
      "Links and the rest",
      [
        ["org-insert-link", "Insert a link, or change the one at point"],
        ["org-open-at-point", "Follow the link at point"],
        ["org-ctrl-c-ctrl-c", "Do what fits here: tick a box, align a table, set tags"],
      ],
    ],
  ],
  tryNow: [
    "Write a heading: a star, a space and a title. \\[org-meta-return] starts the next one.",
    "Press \\[org-todo] on a heading to make it a task, and again to mark it done.",
    "Press \\[org-shifttab] a few times to see the file as an outline.",
  ],
  learnNext: [
    "Tables: start a line with |, type the cells separated by |, and \\[org-cycle] aligns them.",
    "\\[org-agenda] gathers the tasks and dates from your Org files into one view.",
    "\\[describe-mode] lists every key of Org mode.",
  ],
});

// Sparse trees, after org.el's org-sparse-tree, org-occur, org-scan-tags and org-make-tags-matcher.

for (const [name, doc, value] of [
  ["org-highlight-sparse-tree-matches", "Whether a sparse tree highlights what it matched.", true],
  ["org-remove-highlights-with-change", "Whether a sparse tree's highlights go at the next change to the buffer. C-c C-c takes them away too.", true],
  [
    "org-occur-case-fold-search",
    'Whether org-occur ignores case: true, false, or "smart" to ignore it only when the regexp has no capital letters.',
    true,
  ],
  ["org-sparse-tree-open-archived-trees", "Whether a sparse tree shows matches in archived subtrees, which otherwise stay folded.", false],
  [
    "org-sparse-tree-default-date-type",
    'Which timestamps the date sparse trees look at: nil for SCHEDULED and DEADLINE, or "all", "scheduled", "deadline", "active", "inactive" or "closed". c in org-sparse-tree cycles through them.',
    null,
  ],
  ["org-tags-match-list-sublevels", 'Whether a tags match goes on into the subtree of a heading it matched, rather than going past it; "indented" puts dots for its level before each line in the agenda.', true],
  [
    "org-use-property-inheritance",
    "Which properties an entry takes from the headings above it when a match asks for them: true for all, false for none, a list of names, or a regexp.",
    false,
  ],
  ["org-group-tags", "Whether a group tag in a match stands for the tags of its group too, as the TAGS line's { GROUP : TAG ... } gives them.", true],
  [
    "org-tags-exclude-from-inheritance",
    "Tags headings never take from the headings above them or the file.",
    [],
  ],
  ["org-inhibit-highlight-removal", "Whether org-remove-occur-highlights leaves the highlights alone, for code making several sparse trees.", false],
  ["org-occur-highlights", "The overlays highlighting a sparse tree's matches in this buffer.", null],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value });
}
// Kept when the major mode is set again, so the highlights can still be taken away, as Org's are.
e8.put("org-occur-highlights", "permanent-local", true);
e8.defineHook("org-occur-hook", "Run after org-occur has made a sparse tree; by default it goes to the first heading, at the window's top.");

/** Goes to the first heading and shows it at the top of the buffer's window, as org-first-headline-recenter. */
function firstHeadlineRecenter(): void {
  const window = getBufferWindow();
  if (window === undefined) return;
  e8.gotoChar(e8.pointMin());
  if (e8.reSearchForward("^\\(\\*+ \\)", { noerror: true, caseFold: false }) !== undefined) e8.setWindowStart(window, e8.lineStart(lineAt()));
}
e8.defun("org-first-headline-recenter", firstHeadlineRecenter);
e8.addHook("org-occur-hook", firstHeadlineRecenter);

/** The overlays highlighting the sparse tree's matches, as org-occur-highlights. */
function occurHighlights(): number[] {
  const value = e8.variable("org-occur-highlights");
  return Array.isArray(value) ? (value as number[]) : [];
}

/** Highlights a match, as org-highlight-new-match does. */
function highlightNewMatch(beg: number, end: number): void {
  const id = e8.makeOverlay(beg, end, { face: "secondary-selection", "org-type": "org-occur" });
  e8.makeLocalVariable("org-occur-highlights");
  e8.setVariable("org-occur-highlights", [id, ...occurHighlights()]);
}

/** As removeOccurHighlights from before-change-functions, where it then takes itself off. */
function removeOccurHighlightsOnChange(): void {
  removeOccurHighlights(false);
}

/**
 * Takes away the sparse tree's highlights, as org-remove-occur-highlights
 * does, and unless `noremove` stops doing so at each change.
 */
export function removeOccurHighlights(noremove: boolean): void {
  if (truthy(e8.variable("org-inhibit-highlight-removal"))) return;
  for (const id of occurHighlights()) if (e8.overlayStart(id) !== undefined) e8.deleteOverlay(id);
  if (e8.variable("org-occur-highlights") !== null) {
    e8.makeLocalVariable("org-occur-highlights");
    e8.setVariable("org-occur-highlights", null);
  }
  if (!noremove) e8.removeHook("before-change-functions", removeOccurHighlightsOnChange, { local: true });
}

e8.defineCommand({
  name: "org-remove-occur-highlights",
  doc: "Remove the highlights of a sparse tree from the buffer.",
  run: () => removeOccurHighlights(false),
});

// The hooks around TAB's changes of what shows, as org-cycle.el has them.

e8.defineHook("org-cycle-pre-hook", "Functions run before TAB or S-TAB changes what shows, with the state it is about to set: overview, contents, all, folded, children, subtree or empty.");
// Its old name, as org-cycle.el keeps it.
e8.defvaralias("org-pre-cycle-hook", "org-cycle-pre-hook");
e8.defineHook(
  "org-cycle-hook",
  "Functions run after TAB or S-TAB has changed what shows, with the state it set: overview, contents or all after a global change, folded, children or subtree after a local one.",
);
e8.defineVariable({ name: "org-cycle-global-at-bob", doc: "Whether TAB at the very start of the buffer, not on a heading, cycles the whole buffer as S-TAB does.", value: false });
e8.defineVariable({ name: "org-cycle-open-archived-trees", doc: "Whether TAB opens archived subtrees as it does others; nil keeps them closed, as org-cycle-hide-archived-subtrees does.", value: false });
e8.defineVariable({ name: "org-cycle-inline-images-display", doc: "Whether TAB shows the inline images of a subtree it opens, as org-cycle-display-inline-images does. E8 shows no inline images in Org buffers yet, so it does nothing.", value: false });

/** Where the window started when TAB last opened a subtree, so folding it again scrolls back, as org-cycle-scroll-position-to-restore. */
let cycleScrollPosition: number | undefined;

e8.defun("org-cycle-hide-archived-subtrees", (state: string) => {
  if (truthy(e8.variable("org-cycle-open-archived-trees")) || state === "overview" || state === "folded") return;
  const global = state === "contents" || state === "all";
  if (global) hideArchivedSubtrees(e8.pointMin(), e8.pointMax());
  else {
    const all = headings();
    const i = headingIndex(all, lineAt());
    hideArchivedSubtrees(e8.point(), i === undefined ? e8.pointMax() : subtreeRegion(all, i)[1]);
    const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
    if (i !== undefined && all[i].tags.includes(tag)) e8.message(`Subtree is archived and stays closed.  Use \u2018${"C-c C-<tab>"}\u2019 to cycle it anyway.`);
  }
});

e8.defun("org-cycle-show-empty-lines", (state: string) => showEmptyLines(state));

e8.defun("org-cycle-optimize-window-after-visibility-change", (state: string) => {
  if (getBufferWindow() === undefined) return;
  const repeat = e8.lastCommand() === e8.thisCommand();
  if (!repeat) cycleScrollPosition = undefined;
  // Whether the subtree's end shows, as org-subtree-end-visible-p.
  const endShows = () => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    return e8.posVisibleInWindowP(i === undefined ? e8.pointMax() : subtreeRegion(all, i)[1]) !== undefined;
  };
  if (state === "folded" && cycleScrollPosition !== undefined && repeat) e8.setWindowStart(undefined, cycleScrollPosition);
  else if (state === "children" || state === "subtree") {
    if (state === "children" || !repeat) cycleScrollPosition = e8.windowStart();
    if (!endShows()) e8.callWithPrefix(1, "recenter");
  }
});

e8.defun("org-cycle-display-inline-images", (state: string) => {
  if (!truthy(e8.variable("org-cycle-inline-images-display")) || !e8.commandExists("org-display-inline-images")) return;
  if (state === "children" || state === "subtree") e8.call("org-display-inline-images" as e8.CommandName);
});

e8.setDefault("org-cycle-hook", ["org-cycle-hide-archived-subtrees", "org-cycle-show-empty-lines", "org-cycle-optimize-window-after-visibility-change", "org-cycle-display-inline-images"]);

/** TAB on a subtree even if it is archived, as org-cycle-force-archived. */
e8.defineCommand({
  name: "org-cycle-force-archived",
  doc: "Cycle the subtree at point even if it is archived.",
  run: () => {
    e8.setThisCommand("org-cycle");
    e8.letBind({ "org-cycle-open-archived-trees": true }, () => e8.callInteractively("org-cycle"));
  },
});

/** Folds the archived subtrees again, as org-fold-hide-archived-subtrees does after showing matches. */
function hideArchivedSubtrees(beg: number, end: number): void {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    // From the line point is on, not the heading it is under, as Org searches forward from its start.
    for (let i = firstHeadingFrom(all, e8.lineStart(lineAt(beg))); i < all.length && all[i].start < end; i++) {
      if (!all[i].tags.includes(tag)) continue;
      foldSubtree(all[i].line);
      const next = nextSameOrHigher(all, i);
      if (next === undefined) break;
      i = all.indexOf(next) - 1;
    }
  });
}

/**
 * Makes a sparse tree of the matches of `regexp`, as org-occur does: the
 * buffer folded to its top headings, each match shown with as much around
 * it as org-fold-show-context-detail gives occur-tree, and highlighted.
 * With `keepPrevious`, an earlier tree's matches stay as they are. A
 * `callback`, called at each match's end, says whether it counts. Returns
 * how many did.
 */
export function orgOccur(regexp: string, keepPrevious = false, callback?: () => boolean): number {
  if (regexp === "") e8.userError("Regexp cannot be empty");
  if (!keepPrevious) removeOccurHighlights(true);
  let count = 0;
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    if (!keepPrevious || occurHighlights().length === 0) overview();
    const setting = e8.variable("org-occur-case-fold-search");
    const caseFold = setting === "smart" ? isearchNoUpperCaseP(regexp, true) : truthy(setting);
    while (e8.reSearchForward(regexp, { noerror: true, caseFold }) !== undefined) {
      const [beg, end] = [e8.matchBeginning(0)!, e8.matchEnd(0)!];
      // An empty match would be found again where it is, for ever.
      if (beg === end && end < e8.pointMax()) e8.gotoChar(end + 1);
      if (callback !== undefined && !e8.saveExcursion(() => callback())) continue;
      count++;
      if (truthy(e8.variable("org-highlight-sparse-tree-matches"))) highlightNewMatch(beg, end);
      e8.saveExcursion(() => {
        e8.gotoChar(end);
        foldShowContext("occur-tree");
      });
      if (e8.point() >= e8.pointMax()) break;
    }
  });
  if (truthy(e8.variable("org-remove-highlights-with-change"))) e8.addHook("before-change-functions", removeOccurHighlightsOnChange, { local: true });
  if (!truthy(e8.variable("org-sparse-tree-open-archived-trees"))) hideArchivedSubtrees(e8.pointMin(), e8.pointMax());
  e8.runHooks("org-occur-hook");
  return count;
}

e8.defineCommand({
  name: "org-occur",
  doc:
    "Make a compact tree showing the matches of a regexp: the lines matching it and the headings above them, the rest folded. " +
    "With a prefix argument, the matches of an earlier sparse tree stay. C-c C-c removes the highlights.",
  params: [
    { name: "regexp", prompt: "Regexp: " },
    { name: "keep", kind: "prefix" },
  ],
  run: (regexp, keep) => {
    const count = orgOccur(regexp, truthy(keep));
    e8.message(`${count} match(es) for regexp ${regexp}`);
  },
});

/** Goes `n` sparse tree matches on, or back if negative, as org-occur-next-match does for next-error. */
function occurNextMatch(n: number): number {
  const back = n < 0;
  const limit = back ? e8.pointMin() : e8.pointMax();
  const start = e8.point();
  let left = Math.abs(n);
  for (;;) {
    const p = back ? e8.previousSingleCharPropertyChange(e8.point(), "org-type") : e8.nextSingleCharPropertyChange(e8.point(), "org-type");
    if (p === limit) {
      e8.gotoChar(start);
      e8.userError("No more matches");
    }
    if (overlayTypeAt(p) === "org-occur" && --left === 0) {
      e8.gotoChar(p);
      return p;
    }
    e8.gotoChar(p);
  }
}

/** The org-type an overlay gives a position, as get-char-property reads it. */
function overlayTypeAt(pos: number): e8.Value | undefined {
  for (const id of e8.overlaysAt(pos)) {
    const type = e8.overlayGet(id, "org-type");
    if (type !== undefined && type !== null) return type;
  }
  return undefined;
}

e8.defun("org-occur-next-match", (n: number) => occurNextMatch(n));

// Tags and property matches

/** A heading being matched: its state, its tags with those it inherits, as org-get-tags gives them, and its level. */
export type MatchContext = { todo: string | undefined; tags: string[]; level: number; h: Heading; category: () => string };

/** The inherited tags a heading keeps, as org-remove-uninherited-tags. */
function removeUninheritedTags(tags: string[]): string[] {
  const use = e8.variable("org-use-tag-inheritance");
  const exclude = e8.variable("org-tags-exclude-from-inheritance");
  const excluded = Array.isArray(exclude) ? exclude.map(String) : [];
  if (use === true) return tags.filter((t) => !excluded.includes(t));
  if (!truthy(use)) return [];
  // Case folded, as org-scan-tags binds case-fold-search.
  if (typeof use === "string") return tags.filter((t) => e8.stringMatch(use, t, { caseFold: true }) !== undefined && !excluded.includes(t));
  if (Array.isArray(use)) return tags.filter((t) => use.map(String).includes(t));
  return tags;
}

/**
 * Each heading's tags, the file's and those above it first, as org-get-tags
 * gives them: a tag once, where it comes last.
 */
export function allTagsOf(all: Heading[]): string[][] {
  const file = fileTags();
  const stack: Heading[] = [];
  const inherit = truthy(e8.variable("org-use-tag-inheritance"));
  return all.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
    if (!inherit) return h.tags;
    const tags = [...removeUninheritedTags([...file, ...stack.slice(0, -1).flatMap((a) => a.tags)]), ...h.tags];
    return tags.filter((t, j) => !tags.slice(j + 1).includes(t));
  });
}

/** Whether a property is inherited, as org-property-inherit-p. */
export function propertyInheritP(property: string): boolean {
  const use = e8.variable("org-use-property-inheritance");
  if (use === true) return true;
  if (!truthy(use)) return false;
  if (typeof use === "string") return e8.stringMatch(use, property, { caseFold: true }) !== undefined;
  if (Array.isArray(use)) return use.some((p) => String(p).toUpperCase() === property.toUpperCase());
  throw new Error("Invalid setting of `org-use-property-inheritance'");
}

/** The properties Org works out itself, as org-special-properties lists them. */
const SPECIAL_PROPERTIES = [
  "ALLTAGS", "BLOCKED", "CLOCKSUM", "CLOCKSUM_T", "CLOSED", "DEADLINE", "FILE", "ITEM", "PRIORITY", "SCHEDULED", "TAGS", "TIMESTAMP", "TIMESTAMP_IA", "TODO",
];

const tagString = (tags: string[]): string | undefined => (tags.length > 0 ? `:${tags.join(":")}:` : undefined);

/** A special property's value at a heading, as org-entry-properties works it out. */
function specialProperty(ctx: MatchContext, name: string): string | undefined {
  const h = ctx.h;
  switch (name) {
    case "ITEM":
      return h.title.replace(/\t/g, " ");
    case "TODO":
      return h.todo;
    case "PRIORITY": {
      // The first cookie on the line, of any case, as org-priority-regexp finds it from the heading's start.
      const m = /^.*?\[#([A-Z0-9]+)\]/i.exec(e8.lineText(h.line));
      // The default as a character, as char-to-string makes it.
      return m?.[1] ?? String.fromCodePoint(priorityOption("org-priority-default", "B"));
    }
    case "FILE":
      return e8.bufferFileName() ?? undefined;
    case "TAGS":
      return tagString(h.tags);
    case "ALLTAGS":
      return tagString(ctx.tags);
    case "BLOCKED":
      return entryBlocked(h) ? "t" : "";
    case "CLOSED":
    case "DEADLINE":
    case "SCHEDULED": {
      const line = h.line + 1;
      if (line >= e8.lineCount() || !PLANNING.test(e8.lineText(line))) return undefined;
      const m = new RegExp(`${name}:[ \\t]*([[<]\\d{4}-\\d{2}-\\d{2}(?: .*?)?[\\]>])`).exec(e8.lineText(line));
      return m?.[1];
    }
    case "TIMESTAMP":
    case "TIMESTAMP_IA": {
      const open = name === "TIMESTAMP" ? "<" : "[";
      // Timestamps the parser takes as objects, in the heading or in the
      // elements that hold objects, as org-element-context finds them.
      const objects = ["paragraph", "table", "table-row", "verse-block", "item"];
      const found = (line: number, any = false) =>
        tsMatches(line).find((t) => t.text.startsWith(open) && (any || objects.includes(elementAt(t.start)?.type ?? "")))?.text;
      const own = found(h.line, true);
      if (own !== undefined) return own;
      const all = headings();
      const i = headingIndex(all, h.line)!;
      const end = all[i + 1]?.line ?? e8.lineCount();
      let line = h.line + 1;
      if (line < end && PLANNING.test(e8.lineText(line))) line++;
      for (; line < end; line++) {
        const ts = found(line);
        if (ts !== undefined) return ts;
      }
      return undefined;
    }
    case "CLOCKSUM":
    case "CLOCKSUM_T": {
      // As a clock sum left them on the heading: all its time, or today's.
      const minutes = e8.getTextProperty(h.start, name === "CLOCKSUM" ? ":org-clock-minutes" : ":org-clock-minutes-today");
      return typeof minutes === "number" ? durationFromMinutes(minutes) : undefined;
    }
    default:
      return undefined;
  }
}

/** Minutes as Org writes a duration, as org-duration-from-minutes: 0:05, or 1d 2:03 past a day. */
export function durationFromMinutes(minutes: number): string {
  // Whole minutes, halves to even, as Emacs's round.
  if (!Number.isInteger(minutes)) {
    const r = Math.round(minutes);
    minutes = Math.abs(minutes % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  const hm = `${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, "0")}`;
  return days > 0 ? `${days}d ${hm}` : hm;
}

/** A property's value for a match, as org-entry-get with inheritance `selective` reads it. */
function matchProperty(ctx: MatchContext, name: string): string | undefined {
  if (SPECIAL_PROPERTIES.includes(name)) return specialProperty(ctx, name);
  if (propertyInheritP(name)) {
    const value = entryGetInherited(ctx.h, name, false);
    return value === "nil" ? undefined : value;
  }
  return entryGet(ctx.h.line, name);
}

/**
 * Each heading's context as a match sees it, among ALL, the whole
 * buffer's headings, for code that looks at headings outside a scan, as
 * the clock table's :match, :tags and :properties do.
 */
export function matchContexts(all: Heading[]): (i: number) => MatchContext {
  const tags = allTagsOf(all);
  let cats: string[] | undefined;
  return (i) => ({ todo: all[i].todo, tags: tags[i], level: all[i].level, h: all[i], category: () => (cats ??= categories(all))[i] });
}

/** A property's value at a heading as org-entry-get reads it, special ones too, inherited if INHERIT. */
export function entryGetAt(ctx: MatchContext, name: string, inherit: boolean): string | undefined {
  if (SPECIAL_PROPERTIES.includes(name)) return specialProperty(ctx, name);
  if (inherit) {
    const value = entryGetInherited(ctx.h, name, false);
    return value === "nil" ? undefined : value;
  }
  return entryGet(ctx.h.line, name);
}

/** The groups of the tag table, each its tag and those it stands for, as org-tag-alist-to-groups. */
export function tagGroups(): [string, string[]][] {
  const groups: [string, string[]][] = [];
  let status: false | true | "append" = false;
  let current: string[] = [];
  for (const [tag] of currentTagAlist()) {
    if (tag === ":startgroup" || tag === ":startgrouptag") status = true;
    else if (tag === ":endgroup" || tag === ":endgrouptag") {
      if (status === "append") groups.push([current[0], current.slice(1)]);
      status = false;
      current = [];
    } else if (tag === ":grouptags") status = "append";
    else if (status === "append") current.push(tag);
    else if (status === true && !isTagKeyword(tag)) current = [tag];
  }
  return groups;
}

/** A group's tags and those of the groups among them, as org--tags-expand-group. */
export function tagsExpandGroup(group: string[], groups: [string, string[]][], expanded: string[]): string[] {
  for (const tag of group) {
    if (expanded.includes(tag)) continue;
    expanded.unshift(tag);
    const g = groups.find(([k]) => k === tag);
    if (g !== undefined) expanded = tagsExpandGroup(g[1], groups, expanded);
  }
  return expanded;
}

/** Org mode's syntax table with @ and _ word characters, as org-mode-tags-syntax-table, made when first needed. */
let tagsSyntaxTable: string | undefined;

/** Runs body with org-mode-tags-syntax-table, so \\< and \\> in a tag regexp take @ and _ as word characters, as Org matches them. */
function withTagsSyntaxTable<T>(body: () => T): T {
  if (tagsSyntaxTable === undefined) {
    // A child of Org mode's, so a change to that one shows through, as make-syntax-table makes it.
    tagsSyntaxTable = "org-mode-tags-syntax-table";
    e8.makeSyntaxTable(tagsSyntaxTable, "org-mode-syntax-table");
    e8.modifySyntaxEntry("@", "w", tagsSyntaxTable);
    e8.modifySyntaxEntry("_", "w", tagsSyntaxTable);
  }
  const previous = e8.syntaxTable();
  e8.setSyntaxTable(tagsSyntaxTable);
  try {
    return body();
  } finally {
    e8.setSyntaxTable(previous);
  }
}

/** Characters a tag is made of, as org-mode-tags-syntax-table's word characters. */
const TAG_CHAR = /[\p{L}\p{N}_@]/u;

/** An Emacs regexp matching any of some strings, as regexp-opt makes one. */
const regexpOpt = (strings: string[]): string => `\\(?:${strings.map((s) => s.replace(/[[*.\\?+^$]/g, "\\$&")).join("\\|")}\\)`;

/**
 * A match with each group tag in it a regexp for the group's tags, as
 * org-tags-expand does when org-group-tags is on.
 */
function tagsExpand(match: string): string {
  if (!/\S/.test(match)) throw new Error(`Invalid match tag: "${match}"`);
  if (!truthy(e8.variable("org-group-tags"))) return match;
  const groups = tagGroups();
  if (groups.length === 0) return match;
  // Regexps in braces are left as they are.
  const braces: [number, number][] = [];
  for (const m of match.matchAll(/\{.+?\}/g)) braces.push([m.index!, m.index! + m[0].length]);
  let out = "";
  let i = 0;
  while (i < match.length) {
    // The longest key that is a whole word here, as regexp-opt's alternatives try the longer first.
    const before = i > 0 ? match[i - 1] : "";
    const key = TAG_CHAR.test(before)
      ? undefined
      : groups
          .filter(([k]) => match.slice(i, i + k.length).toLowerCase() === k.toLowerCase() && !TAG_CHAR.test(match[i + k.length] ?? ""))
          .sort((a, b) => b[0].length - a[0].length)[0];
    if (key && !braces.some(([a, b]) => a <= i && i < b)) {
      const regexps: string[] = [];
      const regular: string[] = [];
      for (const tag of tagsExpandGroup([match.slice(i, i + key[0].length)], groups, [])) {
        const m = /\{(.+?)\}/.exec(tag);
        if (m) regexps.unshift(m[1]);
        else regular.unshift(tag);
      }
      const words = `\\<${regexpOpt(regular.reverse())}\\>`;
      const re = regexps.reverse().join("\\|");
      out += regular.length === 0 ? `{${re}}` : regexps.length === 0 ? `{${words}}` : `{${words}\\|${re}}`;
      i += key[0].length;
    } else {
      out += match[i];
      i++;
    }
  }
  return out;
}

/** Splits a string at a separator, leaving out one at either end, as org-split-string. */
function splitString(s: string, separator: RegExp): string[] {
  if (!separator.test(s)) return [s];
  const parts = s.split(separator);
  if (parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** A term of a match: a sign, then a regexp in braces, a property comparison, or a tag. */
const MATCH_TERM =
  /^&?([-+:])?(\{[^}]+\}|((?:[\p{L}\p{M}\p{Nd}\p{Nl}_]+|\\\S)+)([<=>]=?|[!/]=|<>)(\*)?(\{[^}]+\}|"[^"]*"|-?[.0-9]+(?:[eE][-+]?[0-9]+)?)|[\p{L}\p{M}\p{Nd}\p{Nl}_@#%]+)/u;

/** A string's leading number, as string-to-number reads it, else 0. */
function leadingNumber(s: string): number {
  const m = /^[ \t\n]*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(s);
  return m ? Number(m[1]) : 0;
}

/** A timestamp's time in seconds, or 0 if it has none, as org-2ft. */
function floatTime(s: string): number {
  return /\d{4}-\d{2}-\d{2}/.test(s) ? timestampSeconds(s) : 0;
}

/** The time a match compares with, as org-matcher-time: a timestamp, <now>, <today>, <tomorrow>, <yesterday> or <+2d>. */
export function matcherTime(s: string): number {
  const now = e8.floatTime();
  const t = today();
  const day = e8.encodeTime([0, 0, 0, t.day, t.month, t.year]);
  if (s === "<now>") return now;
  if (s === "<today>") return day;
  if (s === "<tomorrow>") return day + 86400;
  if (s === "<yesterday>") return day - 86400;
  const m = /^<([-+][0-9]+)([hdwmy])>$/.exec(s);
  if (m) {
    const unit: Record<string, number> = { h: 3600, d: 86400, w: 604800, m: 2678400, y: 31557600 };
    return (m[2] === "h" ? now : day) + Number(m[1]) * unit[m[2]];
  }
  return floatTime(s);
}

/** How an operator compares numbers, strings or times, as org-op-to-function. */
function comparison(op: string, kind: "number" | "string" | "time"): (a: never, b: never) => boolean {
  const name = op === "==" ? "=" : op === "=<" ? "<=" : op === "=>" ? ">=" : op === "!=" || op === "/=" ? "<>" : op;
  if (kind === "time") {
    const both = (f: (a: number, b: number) => boolean) => (a: string, b: number) => {
      const x = floatTime(a);
      return x > 0 && b > 0 && f(x, b);
    };
    // org-time<> compares with =, as its \= reads as the symbol =.
    const ops: Record<string, (a: number, b: number) => boolean> = { "<": (a, b) => a < b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, ">=": (a, b) => a >= b, "=": (a, b) => a === b, "<>": (a, b) => a === b };
    return both(ops[name]) as never;
  }
  const ops: Record<string, (a: number | string, b: number | string) => boolean> = {
    "<": (a, b) => a < b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, ">=": (a, b) => a >= b, "=": (a, b) => a === b, "<>": (a, b) => a !== b,
  };
  return ops[name] as never;
}

/**
 * A level changed by CHANGE levels, odd with org-odd-levels-only, where a
 * level is two stars, as org-get-valid-level gives it: an even level with
 * no change becomes the next odd one.
 */
export function validLevel(level: number, change?: number): number {
  if (e8.variable("org-odd-levels-only") !== true) return Math.max(1, level + (change ?? 0));
  if (!change) return 1 + 2 * Math.floor(level / 2);
  if (change > 0) return 1 + 2 * Math.floor((level - 1 + 2 * change) / 2);
  return Math.max(1, 1 + 2 * Math.floor((level + 2 * change) / 2));
}

/** A heading's level counting only odd ones with org-odd-levels-only, as org-reduced-level. */
export function reducedLevel(level: number): number {
  return e8.variable("org-odd-levels-only") === true ? Math.floor(level / 2) + 1 : level;
}

/** The test a property term makes, as org-make-tags-matcher turns it into Lisp. */
function propertyTest(name: string, op: string, star: boolean, operand: string): (ctx: MatchContext) => boolean {
  const property = name.replace(/\\(.)/g, "$1").toUpperCase();
  const get = (ctx: MatchContext): string | undefined =>
    property === "LEVEL" ? String(reducedLevel(ctx.level)) : property === "CATEGORY" ? ctx.category() : property === "TODO" ? ctx.todo : matchProperty(ctx, property);
  const regexp = operand.startsWith("{");
  const quoted = operand.startsWith('"');
  const timep = /^"[[<](?:[0-9]+|now|today|tomorrow|[+-][0-9]+[dmwy]).*[\]>]"$/.test(operand);
  let test: (ctx: MatchContext) => boolean;
  if (regexp) {
    const re = operand.slice(1, -1);
    const not = ["<>", "!=", "/="].includes(op);
    test = (ctx) => (e8.stringMatch(re, get(ctx) ?? "", { caseFold: true }) !== undefined) !== not;
  } else if (timep) {
    const value = matcherTime(operand.slice(1, -1));
    const f = comparison(op, "time") as unknown as (a: string, b: number) => boolean;
    test = (ctx) => f(get(ctx) ?? "", value);
  } else if (quoted) {
    const value = operand.slice(1, -1);
    const f = comparison(op, "string") as unknown as (a: string, b: string) => boolean;
    test = (ctx) => f(get(ctx) ?? "", value);
  } else {
    const value = leadingNumber(operand);
    const f = comparison(op, "number") as unknown as (a: number, b: number) => boolean;
    test = (ctx) => f(leadingNumber(get(ctx) ?? ""), value);
  }
  return star ? (ctx) => get(ctx) !== undefined && test(ctx) : test;
}

export interface TagsMatcher {
  /** The match as given. */
  match: string;
  /** Whether a heading matches. */
  test: (ctx: MatchContext) => boolean;
  /** Whether the match asks for headings with a TODO state not done only, as /! does. */
  todoOnly: boolean;
}

/** Tags completion for a match: the tag after the last operator, as org-tags-completion-function. */
function tagsCompletion(tags: string[]): (input: string) => string[] {
  return (input) => {
    const m = /^(.*[-+:&,|])([^-+:&,|]*)$/.exec(input);
    const prefix = m ? m[1] : "";
    return tags.map((t) => prefix + t);
  };
}

/**
 * The test a match string makes, as org-make-tags-matcher builds it: tags,
 * +TAG, -TAG, {regexp}, PROP="value", PROP>3, LEVEL<2, TODO="WAIT" and the
 * like joined by & and |, then after a / the TODO states to match, or after
 * /! only those not done, as `todoOnly` asks too. With no match, one is read.
 */
export function makeTagsMatcher(match?: string, todoOnly = false): TagsMatcher {
  if (match === undefined) {
    const tags = bufferTags().map(([t]) => t);
    match = e8.completingRead("Match: ", tagsCompletion(tags), { history: "org-tags-history" });
  }
  const given = match;
  match = tagsExpand(match);
  let start = 0;
  for (const m of match.matchAll(/\/+/g)) start = m.index!;
  const slash = /\/+/.exec(match.slice(start));
  let tagsPart: string;
  let todoPart: string | undefined;
  if (slash !== null && !match.slice(start).includes('"')) {
    tagsPart = match.slice(0, start + slash.index);
    todoPart = match.slice(start + slash.index + slash[0].length);
    if (todoPart.startsWith("!")) {
      todoOnly = true;
      todoPart = todoPart.slice(1);
    }
    if (/^\s*$/.test(todoPart)) todoPart = undefined;
  } else tagsPart = match;
  let tagsTest: ((ctx: MatchContext) => boolean) | undefined;
  if (/\S/.test(tagsPart)) {
    const ors: ((ctx: MatchContext) => boolean)[] = [];
    const terms = splitString(tagsPart, /\|/);
    while (terms.length > 0) {
      let term = terms.shift()!;
      // As (substring term -1) on an empty term between two |.
      if (term === "") e8.signal("args-out-of-range", 'Args out of range: "", -1, nil', ["", -1, null]);
      // A | after a backslash is part of the term.
      while (term.endsWith("\\") && terms.length > 0) term += "|" + terms.shift();
      const ands: ((ctx: MatchContext) => boolean)[] = [];
      for (let m = MATCH_TERM.exec(term); m !== null; m = MATCH_TERM.exec(term)) {
        const minus = m[1] === "-";
        const tag = m[2];
        let test: (ctx: MatchContext) => boolean;
        if (tag.startsWith("{")) {
          const re = tag.slice(1, -1);
          test = (ctx) => withTagsSyntaxTable(() => ctx.tags.some((t) => e8.stringMatch(re, t, { caseFold: true }) !== undefined));
        } else if (m[3] !== undefined) test = propertyTest(m[3], m[4], m[5] !== undefined, m[6]);
        else test = (ctx) => ctx.tags.includes(tag);
        ands.push(minus ? (ctx) => !test(ctx) : test);
        term = term.slice(m[0].length);
      }
      ors.push((ctx) => ands.every((f) => f(ctx)));
    }
    tagsTest = (ctx) => ors.some((f) => f(ctx));
  }
  let todoTest: ((ctx: MatchContext) => boolean) | undefined;
  if (todoPart !== undefined && /\S/.test(todoPart)) {
    const ors: (((ctx: MatchContext) => boolean) | undefined)[] = [];
    for (let term of splitString(todoPart, /\|/)) {
      const ands: ((ctx: MatchContext) => boolean)[] = [];
      for (let m = MATCH_TERM.exec(term); m !== null; m = MATCH_TERM.exec(term)) {
        const minus = m[1] === "-";
        const kwd = m[2];
        const test = kwd.startsWith("{")
          ? (ctx: MatchContext) => {
              // As string-match on a heading with no state, an error.
              if (ctx.todo === undefined) e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil", ["stringp", null]);
              return e8.stringMatch(kwd.slice(1, -1), ctx.todo!, { caseFold: true }) !== undefined;
            }
          : (ctx: MatchContext) => ctx.todo === kwd;
        ands.push(minus ? (ctx) => !test(ctx) : test);
        term = term.slice(m[0].length);
      }
      // A term with nothing in it matches nothing, as (car nil).
      ors.push(ands.length === 0 ? undefined : (ctx) => ands.every((f) => f(ctx)));
    }
    todoTest = (ctx) => ors.some((f) => f !== undefined && f(ctx));
  }
  let test: (ctx: MatchContext) => boolean =
    tagsTest && todoTest ? (ctx) => tagsTest!(ctx) && todoTest!(ctx) : (tagsTest ?? todoTest ?? (() => true));
  if (todoOnly) {
    const inner = test;
    test = (ctx) => ctx.todo !== undefined && !isDone(ctx.todo) && allKeywords().includes(ctx.todo) && inner(ctx);
  }
  return { match: given, test, todoOnly };
}

/**
 * Calls `action` at each heading in the accessible portion that `matcher`
 * matches, with point at its start, as org-scan-tags does, or with
 * "sparse-tree" makes a sparse tree of them. With `todoOnly`, only
 * headings with a TODO state count. Returns what the calls returned.
 */
export function scanTags<T>(action: "sparse-tree" | ((h: Heading) => T), matcher: TagsMatcher | true, todoOnly: boolean): T[] {
  const results: T[] = [];
  const keywords = allKeywords();
  const sublevels = truthy(e8.variable("org-tags-match-list-sublevels"));
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    if (action === "sparse-tree") {
      overview();
      removeOccurHighlights(false);
    }
    const [min, max] = [e8.pointMin(), e8.pointMax()];
    const all = e8.saveRestriction(() => (e8.widen(), headings()));
    const tags = allTagsOf(all);
    let cats: string[] | undefined;
    for (let i = 0; i < all.length; i++) {
      const h = all[i];
      if (h.start < min || h.start >= max) continue;
      const at = i;
      const ctx: MatchContext = { todo: h.todo, tags: tags[i], level: h.level, h, category: () => (cats ??= e8.saveRestriction(() => (e8.widen(), categories(all))))[at] };
      if (todoOnly && (h.todo === undefined || !keywords.includes(h.todo))) continue;
      if (matcher !== true && !matcher.test(ctx)) continue;
      // A TODO-only match leaves out entries the TODO list would, with org-agenda-tags-todo-honor-ignore-options.
      if (todoOnly && truthy(e8.variable("org-agenda-tags-todo-honor-ignore-options") ?? null) && e8.fboundp("org-agenda-check-for-timestamp-as-reason-to-ignore-todo-item")) {
        const ignored = e8.saveExcursion(() => (e8.gotoChar(h.start), e8.funcall("org-agenda-check-for-timestamp-as-reason-to-ignore-todo-item")));
        if (truthy(ignored ?? null)) continue;
      }
      e8.gotoChar(h.start);
      if (action === "sparse-tree") {
        if (truthy(e8.variable("org-highlight-sparse-tree-matches"))) highlightNewMatch(h.start, h.start + h.level);
        foldShowContext("tags-tree");
      } else results.push(e8.saveExcursion(() => action(h)));
      if (!sublevels) {
        const next = nextSameOrHigher(all, i);
        i = next === undefined ? all.length : all.indexOf(next) - 1;
      }
    }
  });
  if (action === "sparse-tree" && !truthy(e8.variable("org-sparse-tree-open-archived-trees"))) hideArchivedSubtrees(e8.pointMin(), e8.pointMax());
  return results;
}

/** Makes a sparse tree of the headings a match picks, as org-match-sparse-tree. */
export function matchSparseTree(todoOnly: boolean, match?: string): void {
  // The prefix argument restricts the match itself to states not done, as org-match-sparse-tree binds org--matcher-tags-todo-only.
  const matcher = makeTagsMatcher(match, todoOnly);
  scanTags("sparse-tree", matcher, matcher.todoOnly);
}

const matchSparseTreeCommand = e8.defineCommand({
  name: "org-match-sparse-tree",
  doc:
    "Make a sparse tree of the headings a match picks: tags (+work-boss, work|home), properties (PRIORITY=\"A\", LEVEL>1, " +
    "Effort<\"1:00\"), and after a / TODO states (/TODO|WAIT, or /! for those not done). With a prefix argument, only headings with a TODO state.",
  params: [{ name: "todoOnly", kind: "prefix" }],
  run: (todoOnly) => matchSparseTree(truthy(todoOnly)),
});
e8.defineCommand({
  name: "org-tags-sparse-tree",
  doc: "Make a sparse tree of the headings a match picks, as org-match-sparse-tree.",
  params: [{ name: "todoOnly", kind: "prefix" }],
  run: (todoOnly) => matchSparseTree(truthy(todoOnly)),
});

/** The TODO states not done, as a regexp alternative, as org-not-done-regexp. */
export function notDoneRegexp(): string {
  return `\\(${todoSets().flatMap((s) => s.todo).map((k) => k.replace(/[[*.\\?+^$]/g, "\\$&")).join("\\|")}\\)`;
}

e8.defineCommand({
  name: "org-show-todo-tree",
  doc:
    "Make a sparse tree of the headings with a TODO state not done. With C-u, of those with a state read, or several as KWD1|KWD2; " +
    "with a number N, of those with the Nth state.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const keywords = todoSets().flatMap((s) => [...s.todo, ...s.done]);
    const quote = (k: string) => k.replace(/[[*.\\?+^$]/g, "\\$&");
    let re: string;
    if (arg === null || arg === undefined) re = `${notDoneRegexp()}\\s-`;
    else if (Array.isArray(arg) && arg[0] === 4) {
      const kwd = e8.completingRead("Keyword (or KWD1|KWD2|...): ", keywords);
      re = `\\(${splitString(kwd, /\|/).map(quote).join("\\|")}\\)\\(?:[ \t]\\|$\\)`;
    } else {
      const n = e8.prefixNumericValue(arg);
      if (n > keywords.length) e8.userError(`Invalid prefix argument: ${Array.isArray(arg) ? `(${arg[0]})` : String(arg)}`);
      // As nth, a count below 1 takes the first.
      re = quote(keywords[Math.max(n, 1) - 1]);
    }
    // org-occur folds case as org-occur-case-fold-search says, whatever org-show-todo-tree binds case-fold-search to.
    const count = orgOccur(`^\\*+  *${re}`);
    e8.message(`${count} TODO entries found`);
  },
});

/** The days from today to a timestamp's date, as org-timestamp-to-now. */
function daysFromToday(ts: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(ts);
  if (!m) throw new Error(`Not an Org time string: ${ts}`);
  const t = today();
  return (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(t.year, t.month - 1, t.day)) / 86400000;
}

/** Whether point's entry is done, as org-entry-is-done-p. */
function entryDoneHere(): boolean {
  const all = headings();
  const i = headingIndex(all, lineAt());
  // At the start, where outline-back-to-heading's search gave up.
  if (i === undefined) throw new Error(`Before first headline at position ${e8.pointMin() + 1} in buffer ${e8.bufferName()}`);
  return isDone(all[i].todo);
}

e8.defineCommand({
  name: "org-check-deadlines",
  doc:
    "Make a sparse tree of the deadlines due within org-deadline-warning-days, or past, in entries not done. " +
    "With a number, within that many days; with C-u, all of them.",
  params: [{ name: "ndays", kind: "prefix" }],
  run: (ndays) => {
    const days = Array.isArray(ndays) && ndays[0] === 4 ? 100000 : ndays !== null && ndays !== undefined ? e8.prefixNumericValue(ndays) : Math.abs(Number(e8.variable("org-deadline-warning-days") ?? 14));
    const count = orgOccur("\\<DEADLINE: *<\\([^>]+\\)>", false, () => {
      const ts = e8.matchString(1) ?? "";
      return daysFromToday(ts) <= days && !entryDoneHere();
    });
    e8.message(`${count} deadlines past-due or due within ${days} days`);
  },
});

/** The date sparse trees' timestamp type, as org-ts-type, which c in org-sparse-tree cycles. */
let tsType: string | null = null;

/** The regexp for timestamps of a type, as org-re-timestamp. */
function reTimestamp(type: string | null): string {
  const date = "[[:digit:]]\\{4\\}-[[:digit:]]\\{2\\}-[[:digit:]]\\{2\\}\\(?: .*?\\)?";
  switch (type) {
    case "all":
      return `[[<]\\(${date}\\)[]>]`;
    case "active":
      return `<\\(${date}\\)>`;
    case "inactive":
      return `\\[\\(${date}\\)\\]`;
    case "scheduled":
      return "\\<SCHEDULED: *<\\([^>]+\\)>";
    case "deadline":
      return "\\<DEADLINE: *<\\([^>]+\\)>";
    case "closed":
      return "\\<CLOSED: *\\[\\([^]]+\\)\\]";
    default:
      return "\\<\\(?:\\(?:DEADLINE\\|SCHEDULED\\):\\) *<\\([^>]+\\)>";
  }
}

/** Elements whose text C-c C-c finds no timestamp object in, as org-element-context: their text is raw. */
const RAW_TIMESTAMP_TYPES = ["comment", "comment-block", "diary-sexp", "example-block", "export-block", "fixed-width"];

/** Whether the affiliated keywords around a line belong to an element after them, as Org's parser attaches them. */
function affiliatedOfNext(line: number): boolean {
  let l = line;
  while (l + 1 < e8.lineCount() && AFFILIATED.test(e8.lineText(l + 1))) l++;
  const first = l + 1;
  const next = first < e8.lineCount() ? elementAt(e8.lineStart(first)) : undefined;
  // Comments, clocks and headings are parsed before affiliated keywords are looked for, so they take none.
  const none = ["headline", "comment", "clock"];
  return next !== undefined && e8.lineStart(first) < e8.bufferSize() && next.begin === e8.lineStart(first) && !none.includes(next.type);
}

/** What TAB says on a table.el table, as substitute-command-keys quotes the key. */
const TABLE_EL_MESSAGE = "Use \u2018C-c \u2019\u2019 to edit table.el tables";

/** Whether an element is in a table.el table, as Org's parser types them. */
function tableElTable(el: Elem | undefined): boolean {
  let table = el;
  while (table && table.type !== "table") table = table.parent;
  return table?.tableType === "table.el";
}

/**
 * The timestamp object point is on in a table row's cell, as Org's context
 * finds it: true for one, "dashes" between a range's two, false for none.
 * Org parses a row's objects up to its last character that is not a space,
 * and each cell's on its own, so verbatim text is a cell's alone.
 */
function cellTimestamp(line: number): boolean | "dashes" {
  const p = e8.point();
  const text = e8.lineText(line);
  const ls = e8.lineStart(line);
  const trimmedEnd = ls + charCount(text.replace(/\s+$/, ""));
  if (p >= trimmedEnd && p !== e8.bufferSize()) return false;
  if (rangeDashesHere(line)) return "dashes";
  if (!timestampHere()) return false;
  // The cell: from the bar before point to the next one, or the row's end.
  const col = p - ls;
  const chars = [...text];
  let from = col;
  while (from > 0 && chars[from - 1] !== "|") from--;
  let to = col;
  while (to < chars.length && chars[to] !== "|") to++;
  return !inVerbatimOrLink(p, chars.slice(from, to).join(""), from);
}

/** Elements whose timestamps org-element-context does not find as timestamp objects: a planning line's are its own, and the others hold only characters. */
const NO_OBJECTS = ["planning", "src-block", "example-block", "export-block", "fixed-width", "latex-environment", "comment", "comment-block", "keyword", "node-property", "property-drawer", "clock"];

/**
 * Whether a position is in verbatim or code text (=...=, ~...~) or a
 * link, where org-element-context finds no timestamp object.
 */
export function inVerbatimOrLink(pos: number, part?: string, partStart = 0): boolean {
  const line = lineAt(pos);
  // Within part of the line, as a table's cell, whose ends are the text's ends.
  const text = part ?? e8.lineText(line);
  const col = pos - e8.lineStart(line) - partStart;
  const inside = (re: RegExp, lead = 0) => {
    for (const m of allMatches(re, text)) {
      const start = charCount(text.slice(0, m.index! + lead));
      const end = charCount(text.slice(0, m.index! + m[0].length));
      if (start <= col && col < end) return true;
    }
    return false;
  };
  return inside(/\[\[(?:[^\][\\]|\\.)+\](?:\[[^\n]+?\])?\]/g) || inside(/(?:^|[\s\-({'"])([=~])\S(?:[^\n]*?\S)?\1(?=[\s\-.,;:!?'")}\[]|$)/g, 1);
}

/**
 * Whether a match counts for a date sparse tree, as their callbacks ask:
 * a timestamp for all, active and inactive, else on a planning line.
 */
function dateMatchCounts(type: string | null): boolean {
  const end = e8.matchEnd(0)!;
  if (type === "all" || type === "active" || type === "inactive") {
    const at = Math.max(e8.pointMin(), end - 1);
    const type = elementAt(at)?.type;
    return (type === undefined || !NO_OBJECTS.includes(type)) && !inVerbatimOrLink(at);
  }
  const line = lineAt(end);
  if (!PLANNING.test(e8.lineText(line)) || line === 0) return false;
  const all = headings();
  const i = headingIndex(all, line);
  return i !== undefined && all[i].line === line - 1;
}

/** A date read as org-read-date reads one, as YYYY-MM-DD with any time after it. */
export function readDate(prompt?: string): string {
  const t = today();
  const def = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  const input = readDateAnswer(`${prompt ?? "Date+time"} [${def}]: `);
  const d = parseDate(input);
  const date = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return d.hour === undefined ? date : `${date} ${String(d.hour).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")}`;
}

/** Makes a sparse tree of the timestamps for which `test` holds of their time in seconds. */
function dateSparseTree(test: (seconds: number) => boolean): number {
  const type = tsType;
  return orgOccur(reTimestamp(type), false, () => {
    const ts = e8.matchString(1) ?? "";
    return dateMatchCounts(type) && test(timestampSeconds(ts));
  });
}

e8.defineCommand({
  name: "org-check-before-date",
  doc: "Make a sparse tree of the deadlines and scheduled dates before a date.",
  params: [{ name: "date", value: () => readDate() }],
  run: (d) => {
    const limit = timestampSeconds(d);
    e8.message(`${dateSparseTree((s) => s < limit)} entries before ${d}`);
  },
});

e8.defineCommand({
  name: "org-check-after-date",
  doc: "Make a sparse tree of the deadlines and scheduled dates on or after a date.",
  params: [{ name: "date", value: () => readDate() }],
  run: (d) => {
    const limit = timestampSeconds(d);
    e8.message(`${dateSparseTree((s) => !(s < limit))} entries after ${d}`);
  },
});

e8.defineCommand({
  name: "org-check-dates-range",
  doc: "Make a sparse tree of the deadlines and scheduled dates from one date up to another.",
  params: [
    { name: "start", value: () => readDate("Range starts") },
    { name: "end", value: () => readDate("Range end") },
  ],
  run: (start, end) => {
    const [from, to] = [timestampSeconds(start), timestampSeconds(end)];
    e8.message(`${dateSparseTree((s) => !(s < from) && s < to)} entries between ${start} and ${end}`);
  },
});

const DATE_TYPES: (string | null)[] = [null, "all", "scheduled", "deadline", "active", "inactive", "closed"];

const DATE_TYPE_NAMES: Record<string, string> = {
  all: "all timestamps",
  scheduled: "only scheduled",
  deadline: "only deadline",
  active: "only active timestamps",
  inactive: "only inactive timestamps",
  closed: "with a closed timestamp",
};

/** Runs a command as call-interactively does, with a prefix argument, its parameters read as keys would. */
function interactively(arg: e8.PrefixArg, command: e8.CommandName | e8.DefinedCommand): void {
  if (arg !== null && arg !== undefined) e8.setPrefixArg(arg);
  e8.callInteractively(command);
}

/** Asks which sparse tree to make and makes it, as org-sparse-tree. */
function sparseTree(arg: e8.PrefixArg, type?: string | null): void {
  const t = type ?? (e8.variable("org-sparse-tree-default-date-type") as string | null) ?? null;
  tsType = t;
  e8.message(
    "Sparse tree: [r]egexp [t]odo [T]odo-kwd [m]atch [p]roperty\n" +
      "             [d]eadlines [b]efore-date [a]fter-date [D]ates range\n" +
      `             [c]ycle through date types: ${(t !== null && DATE_TYPE_NAMES[t]) || "scheduled/deadline"}`,
  );
  const answer = e8.readCharExclusive();
  switch (answer) {
    case "c":
      return sparseTree(arg, DATE_TYPES[DATE_TYPES.indexOf(t) + 1] ?? null);
    case "d":
      return interactively(arg, "org-check-deadlines");
    case "b":
      return interactively(arg, "org-check-before-date");
    case "a":
      return interactively(arg, "org-check-after-date");
    case "D":
      return interactively(arg, "org-check-dates-range");
    case "t":
      return interactively(arg, "org-show-todo-tree");
    case "T":
      return interactively([4], "org-show-todo-tree");
    case "m":
      return interactively(arg, matchSparseTreeCommand);
    case "p":
    case "P": {
      const kwd = e8.completingRead("Property: ", bufferPropertyKeys()).replace(/-/g, "\\-");
      let value = e8.completingRead("Value: ", propertyValues(kwd.replace(/\\-/g, "-")));
      if (!/^\{.*\}$/.test(value)) value = `"${value}"`;
      return matchSparseTree(truthy(arg), `${kwd}=${value}`);
    }
    case "r":
    case "R":
    case "/":
      return interactively(arg, "org-occur");
    default:
      e8.userError(`No such sparse tree command "${answer}"`);
  }
}

/** Every value a property has in the buffer, as org-property-values. */
e8.defun("org--property-values", (key: string) => propertyValues(key));

// Reading a property's name and value, after org.el's org-read-property-name
// and org-read-property-value, for org-set-property.

e8.defineVariable({ name: "org-last-set-property", doc: "The name of the property last set with org-set-property, offered as the default next time.", value: null });
e8.defineVariable({ name: "org-last-set-property-value", doc: "The property and value last set with org-set-property, as \"NAME: VALUE\".", value: null });
e8.defineVariable({
  name: "org-property-set-functions-alist",
  doc: "Functions that read a property's value instead of completing-read, as an alist of property names and functions taking completing-read's arguments.",
  value: [],
});
e8.defineVariable({
  name: "org-properties-postprocess-alist",
  doc: "Functions that turn a property's value as read into the one stored, as an alist of property names and functions of the value.",
  value: [],
});
e8.defineHook("org-property-allowed-value-functions", "Functions given a property's name, the first to give a list of values being its allowed values.");

/** Properties Org uses itself, offered for completion, as org-default-properties lists them. */
const DEFAULT_PROPERTIES = [
  "ARCHIVE", "CATEGORY", "SUMMARY", "DESCRIPTION", "CUSTOM_ID", "LOCATION", "LOGGING", "COLUMNS", "VISIBILITY",
  "TABLE_EXPORT_FORMAT", "TABLE_EXPORT_FILE", "EXPORT_OPTIONS", "EXPORT_TEXT", "EXPORT_FILE_NAME", "EXPORT_TITLE",
  "EXPORT_AUTHOR", "EXPORT_DATE", "UNNUMBERED", "ORDERED", "NOBLOCKING", "COOKIE_DATA", "LOG_INTO_DRAWER",
  "REPEAT_TO_STATE", "CLOCK_MODELINE_TOTAL", "STYLE", "HTML_CONTAINER_CLASS", "ORG-IMAGE-ACTUAL-WIDTH",
];

/**
 * The property names to complete, as org-buffer-property-keys gives them
 * with defaults and columns: the effort property and Org's own, the
 * #+PROPERTY lines', the drawers', those COLUMNS formats name, and NAME
 * for each NAME_ALL, sorted ignoring case.
 */
function propertyNamesToComplete(): string[] {
  const props: string[] = [String(e8.variable("org-effort-property") ?? "Effort"), ...DEFAULT_PROPERTIES];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+PROPERTY:[ \t]*(\S+)/i.exec(text);
    if (m) props.push(m[1]);
  }
  const columns: string[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+COLUMNS:[ \t]*(.*)$/i.exec(text);
    if (m) columns.push(m[1]);
  }
  e8.saveRestriction(() => {
    e8.widen();
    // The keys of the real property drawers, the file's and each entry's, as org-get-property-block finds them, each pushed, so later first.
    const found: string[] = [];
    const drawerKeys = (open: number, close: number) => {
      for (let l = open + 1; l < close; l++) {
        const m = PROPERTY_LINE.exec(e8.lineText(l));
        if (!m) continue;
        found.unshift(m[1].replace(/\+$/, ""));
        if (/^COLUMNS$/i.test(m[1])) columns.push(e8.lineText(l).replace(/^[ \t]*:\S+?:[ \t]*/, ""));
      }
    };
    const top = e8.saveExcursion(() => (e8.gotoChar(0), headings().length > 0 && headings()[0].start === 0 ? undefined : ownDrawer()));
    if (top) drawerKeys(...top);
    for (const h of headings()) {
      let line = h.line + 1;
      if (line < e8.lineCount() && PLANNING.test(e8.lineText(line))) line++;
      const close = propertyDrawerEnd(line);
      if (close !== undefined) drawerKeys(line, close);
    }
    props.unshift(...found);
  });
  // The names COLUMNS formats give, from keywords and drawers, as org-buffer-property-keys takes them.
  for (const value of columns) {
    for (const m of allMatches(/%[0-9]*([\p{L}\p{N}_-]+)(\([^)]+\))?(?:\{[^}]+\})?/gu, value)) {
      if (!SPECIAL_PROPERTIES.some((x) => x.toLowerCase() === m[1].toLowerCase())) props.unshift(m[1]);
    }
  }
  const all = [...new Set([...props, ...props.filter((x) => /._ALL$/.test(x)).map((x) => x.slice(0, -4))])];
  const up = (x: string) => x.toUpperCase();
  return all.sort((a, b) => (up(a) < up(b) ? -1 : up(a) > up(b) ? 1 : 0));
}

/** Trims the whitespace org-trim does: spaces, tabs and newlines at either end. */
const orgTrim = (s: string): string => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");

/** Completing-read as org-completing-read calls it, case ignored, or with SET, a function of org-property-set-functions-alist. */
function readCompleting(set: e8.Value | undefined, prompt: string, collection: string[], requireMatch: boolean, def: string | undefined): string {
  return e8.letBind({ "completion-ignore-case": true }, () => {
    if (set !== undefined && set !== null) {
      const answer = e8.funcall(set as string, prompt, collection.map((x) => [x]), null, requireMatch, null, null, def ?? null);
      return typeof answer === "string" ? answer : "";
    }
    return e8.completingRead(prompt, collection, { requireMatch, ...(def === undefined ? {} : { default: def }) });
  });
}

/** An alist's value for KEY, as assoc, or with FOLD as assoc-string ignoring case. */
function alistValue(name: string, key: string, fold = false): e8.Value | undefined {
  const alist = e8.variable(name);
  if (!Array.isArray(alist)) return undefined;
  const e = alist.find((x) => Array.isArray(x) && typeof x[0] === "string" && (fold ? x[0].toLowerCase() === key.toLowerCase() : x[0] === key));
  return Array.isArray(e) ? e[1] : undefined;
}

/** A property line, its name the shortest followed by a colon and a space or the line's end, as org-property-re matches it. */
const PROPERTY_LINE = /^[ \t]*:(\S+?):(?:[ \t]+.*?)?[ \t]*$/;

/** The property named on point's line in the entry's own drawer, as org-at-property-p finds one. */
function propertyAtPoint(): string | undefined {
  const drawer = ownDrawer();
  const line = lineAt();
  if (drawer === undefined || line <= drawer[0] || line >= drawer[1]) return undefined;
  return PROPERTY_LINE.exec(e8.lineText(line))?.[1];
}

/** Reads a property's name, offering the buffer's and Org's, the one on point's line or the last set the default, as org-read-property-name. */
function readPropertyName(): string {
  const last = e8.variable("org-last-set-property");
  const def = propertyAtPoint() ?? (typeof last === "string" ? last : undefined);
  return readCompleting(undefined, `Property${def === undefined ? "" : ` [${def}]`}: `, propertyNamesToComplete(), false, def);
}
e8.defun("org-read-property-name", () => readPropertyName());

/**
 * The values PROPERTY may take at point, as org-property-get-allowed-values:
 * the TODO keywords and none, the priorities, none for CATEGORY and the
 * special properties, what org-property-allowed-value-functions gives, or
 * NAME_ALL's; and whether others may be typed, as :ETC says.
 */
function allowedAtPoint(property: string): { values: string[]; restricted: boolean } | undefined {
  if (property === "TODO") return { values: [...allKeywords(), ""], restricted: true };
  if (property === "PRIORITY") {
    const values: string[] = [];
    for (let n = priorityOption("org-priority-highest", "A"); n <= priorityOption("org-priority-lowest", "C"); n++) values.push(String.fromCodePoint(n));
    return { values, restricted: true };
  }
  if (property === "CATEGORY" || SPECIAL_PROPERTIES.includes(property)) return undefined;
  const hooked = e8.runHookWithArgsUntilSuccess("org-property-allowed-value-functions", property);
  if (Array.isArray(hooked) && hooked.length > 0) {
    const values = hooked.map(String);
    return values.includes(":ETC") ? { values: values.filter((v) => v !== ":ETC"), restricted: false } : { values, restricted: true };
  }
  const all = headings();
  const i = headingIndex(all, lineAt());
  const allowed = allowedValues(i === undefined ? undefined : all[i], property);
  return allowed.values.length === 0 ? undefined : allowed;
}

/** The entry's own value of PROPERTY at point, as org-entry-get without inheritance: the category and special properties worked out, their names in any case. */
function currentPropertyValue(property: string): string | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  const upper = property.toUpperCase();
  if (upper === "CATEGORY") return i === undefined ? category() : matchContexts(all)(i).category();
  if (SPECIAL_PROPERTIES.includes(upper)) return i === undefined ? undefined : entryGetAt(matchContexts(all)(i), upper, false);
  if (i === undefined) return topGet(property);
  return entryGet(all[i].line, property);
}
e8.defun("org--entry-get-here", (property: string) => currentPropertyValue(property) ?? null);

/**
 * Reads a value for PROPERTY, as org-read-property-value: one of its
 * allowed values if it has any, else completing the values the buffer
 * gives it, its current value the default.
 */
function readPropertyValue(property: string): string {
  const allowed = allowedAtPoint(property);
  const current = currentPropertyValue(property);
  const prompt = `${property} value${current !== undefined && /\S/.test(current) ? ` [${current}]` : ""}: `;
  const set = alistValue("org-property-set-functions-alist", property);
  const answer = allowed
    ? readCompleting(set, prompt, allowed.values, allowed.restricted, undefined)
    : readCompleting(set, prompt, propertyValues(property), false, current);
  return orgTrim(answer);
}
e8.defun("org-read-property-value", (property: string) => readPropertyValue(property));

/** A property's value as stored, through org-properties-postprocess-alist's function for it. */
e8.defun("org--postprocess-property-value", (property: string, value: string) => {
  const fn = alistValue("org-properties-postprocess-alist", property, true);
  return fn === undefined || fn === null ? value : String(e8.funcall(fn as string, value));
});



function propertyValues(key: string): string[] {
  return e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    const out: string[] = [];
    const top = topGet(key);
    if (top !== undefined) out.push(top);
    for (const h of all) {
      const v = entryGet(h.line, key);
      if (v !== undefined && !out.includes(v)) out.push(v);
    }
    return out;
  });
}

e8.defineCommand({
  name: "org-sparse-tree",
  doc:
    "Make a sparse tree, asking which: r a regexp's matches (or /), t the headings with a TODO state not done, T those with a " +
    "state read, m those a tags and properties match picks, p those with a property's value, d the deadlines due soon, b and a " +
    "the dates before and after a date, D those between two; c cycles which timestamps the dates look at.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => sparseTree(arg),
});

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
    // M-g n and M-g p go between a sparse tree's matches.
    e8.makeLocalVariable("next-error-function");
    e8.setVariable("next-error-function", "org-occur-next-match");
    // The dependency checks go on org-blocker-hook, or off it, as the options say now, as org-mode adds them.
    hookBlocker(blockFromHierarchy, truthy(e8.variable("org-enforce-todo-dependencies")));
    hookBlocker(blockFromCheckboxes, truthy(e8.variable("org-enforce-todo-checkbox-dependencies")));
    e8.addToInvisibilitySpec("org-hide-drawer", { ellipsis: true });
    e8.addToInvisibilitySpec("org-hide-block", { ellipsis: true });
    e8.addToInvisibilitySpec("org-link");
    e8.addToInvisibilitySpec("org-emphasis");
    storeTodoSets();
    storeTagsLines();
    if (e8.variable("org-startup-truncated") === true) e8.setVariable("truncate-lines", true);
    // A folded heading ends in org-ellipsis, through the buffer's display table, as org-mode sets it up.
    const ellipsis = e8.variable("org-ellipsis");
    if (typeof ellipsis === "string" && ellipsis !== "") {
      const table = e8.makeCharTable("display-table");
      e8.setCharTableExtraSlot(table, 4, e8.propertize(ellipsis, { face: "org-ellipsis" }));
      e8.setVariable("buffer-display-table", table);
    }
    // visual-line-mode's keymap without its remaps of C-a, C-e and C-k,
    // so Org's stay, as org-mode puts it in minor-mode-overriding-map-alist.
    const visualLineMap = e8.makeSparseKeymap("visual-line-mode-map");
    for (const command of ["move-beginning-of-line", "move-end-of-line", "kill-line"] as const) e8.remapCommand(visualLineMap, command, null);
    e8.makeLocalVariable("minor-mode-overriding-map-alist");
    const overriding = e8.variable("minor-mode-overriding-map-alist");
    e8.setVariable("minor-mode-overriding-map-alist", [["visual-line-mode", visualLineMap], ...(Array.isArray(overriding) ? overriding : [])]);
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
    // The logging #+STARTUP: words set their variables for the buffer, as org-set-regexps-and-options does.
    for (const [, , text] of keywordLines()) {
      const m = /^#\+STARTUP:(.*)$/i.exec(text);
      for (const word of m ? m[1].trim().split(/\s+/) : []) {
        // Any case, as org-set-regexps-and-options's assoc-string.
        const option = STARTUP_LOG_OPTIONS[word.toLowerCase()] ?? STARTUP_FOOTNOTE_OPTIONS[word.toLowerCase()];
        if (option === undefined) continue;
        e8.makeLocalVariable(option[0]);
        e8.setVariable(option[0], option[1]);
      }
    }
    // C-M-\ indents the region as Org does, as org-mode sets it.
    e8.makeLocalVariable("indent-region-function");
    e8.setVariable("indent-region-function", "org-indent-region");
    // Auto Fill breaks lines only where Org fills them, as org-setup-filling sets it.
    e8.makeLocalVariable("normal-auto-fill-function");
    e8.setVariable("normal-auto-fill-function", "org-auto-fill-function");
    // As org-setup-filling: M-x fill-paragraph fills as Org does, and lines
    // never break where the rest would start a new element or split an object.
    for (const [name, value] of [
      ["fill-paragraph-function", "org-fill-paragraph"],
      ["paragraph-start", ORG_PARAGRAPH_START],
      ["paragraph-separate", ORG_PARAGRAPH_START],
      // As org-setup-comments-handling: comments are lines starting with #, found by regexp.
      ["comment-use-syntax", null],
      ["comment-start", "# "],
      ["comment-start-skip", "^\\s-*#\\(?: \\|$\\)"],
      ["comment-insert-comment-function", "org-insert-comment"],
      ["comment-region-function", "org-comment-or-uncomment-region"],
      ["uncomment-region-function", "org-comment-or-uncomment-region"],
      ["adaptive-fill-function", "org-adaptive-fill-function"],
      ["comment-line-break-function", "org-comment-line-break-function"],
      ["fill-forward-paragraph-function", "org--fill-forward-paragraph"],
      ["fill-nobreak-predicate", ["org-fill-line-break-nobreak-p", "org-fill-n-macro-as-item-nobreak-p", "org-fill-paragraph-with-timestamp-nobreak-p"]],
    ] as const) {
      e8.makeLocalVariable(name);
      e8.setVariable(name, value as unknown as e8.Value);
    }
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

// --- Paragraph motion, after org.el's org-forward-paragraph -----------------

/** An element as Org's paragraph motion sees it, with its affiliated keywords, or a pseudo-paragraph of several. */
interface ParagraphElem {
  type: string;
  begin: number;
  end: number;
  postAffiliated: number;
  contentsBegin?: number;
  contentsEnd?: number;
  parent?: Elem;
}

/** Plain lists of one line per item count as one paragraph, as org--single-lines-list-is-paragraph; filling turns it off. */
let singleLinesListIsParagraph = true;

/** Types that take affiliated keywords, as Org's elements other than these do. */
const NO_AFFILIATED = ["headline", "section", "item", "planning", "node-property", "table-row", "clock", "keyword", "diary-sexp", "property-drawer"];

/** The element and where it starts with its affiliated keywords, as org-element-at-point gives them. */
function elementWithAffiliated(pos: number): [Elem, number] | undefined {
  let e = elementAt(pos);
  if (e === undefined) return undefined;
  // An affiliated keyword belongs to the element after it.
  if (e.type === "keyword" && AFFILIATED.test(e8.lineText(lineAt(e.begin)))) {
    let line = lineAt(e.begin);
    while (line + 1 < e8.lineCount() && AFFILIATED.test(e8.lineText(line))) line++;
    const next = AFFILIATED.test(e8.lineText(line)) ? undefined : elementAt(e8.lineStart(line));
    if (next !== undefined && next.begin === e8.lineStart(line) && !NO_AFFILIATED.includes(next.type)) e = next;
  }
  // One that starts inside its line, as an item's first paragraph after its bullet, has none.
  const atBol = e.begin === e8.lineStart(lineAt(e.begin));
  return [e, NO_AFFILIATED.includes(e.type) || !atBol ? e.begin : affiliatedBegin(e.begin)];
}

/** Where a headline's contents start and end, as Org's parser has them: the first line after its own that is not blank. */
function headlineContents(e: Elem): [number | undefined, number | undefined] {
  let p = lineStartOrEnd(lineAt(e.begin) + 1);
  while (p < e.end && /[ \r\t\n]/.test(e8.bufferText(p, p + 1))) p++;
  if (p >= e.end) return [undefined, undefined];
  let q = e.end;
  while (q > p && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
  return [e8.lineStart(lineAt(p)), Math.min(lineStartOrEnd(lineAt(q) + 1), e.end)];
}

/**
 * The element at point as Org's paragraph motion takes it, as
 * org--paragraph-at-point: a table row or property its table or drawer,
 * keywords, clocks and diary sexps in a row one block, and a list of
 * one-line items the whole list.
 */
function paragraphAtPoint(): ParagraphElem | undefined {
  const found = elementWithAffiliated(e8.point());
  if (found === undefined) return undefined;
  const [e, begin] = found;
  const pseudo = (b: number, end: number, parent?: Elem): ParagraphElem => ({ type: "pseudo-paragraph", begin: b, end, postAffiliated: b, parent });
  if (e.type === "table" || e.type === "property-drawer") return pseudo(begin, e.end, e.parent);
  if (e.type === "node-property" || e.type === "table-row") {
    const p = e.parent!;
    return pseudo(NO_AFFILIATED.includes(p.type) ? p.begin : affiliatedBegin(p.begin), p.end, p.parent);
  }
  if (e.type === "clock" || e.type === "diary-sexp" || e.type === "keyword") {
    const re = e.type === "clock" ? /^[ \t]*CLOCK:/ : e.type === "diary-sexp" ? /^%%\(/ : /^[ \t]*#\+\S+?:/;
    const looking = (line: number): boolean => line < e8.lineCount() && re.test(e8.lineText(line));
    const lastLine = lineAt(endBeforeBlank(e));
    let end: number;
    if (lineStartOrEnd(lastLine + 1) < e.end) end = e.end;
    else {
      // The lines after it of the same kind, and the blank lines after them.
      let line = lineAt(e.begin) + 1;
      while (looking(line)) line++;
      let p = lineStartOrEnd(line);
      while (p < e8.bufferSize() && /[ \t\n]/.test(e8.bufferText(p, p + 1))) p++;
      end = e8.lineStart(lineAt(p));
    }
    let line = lineAt(e.begin);
    while (line > 0 && looking(line)) line--;
    const b = looking(line) ? e8.lineStart(line) : lineStartOrEnd(line + 1);
    return pseudo(b, end, e.parent);
  }
  // The whole list, if each of its items, nested ones too, is a line.
  let list: Elem | undefined = e;
  while (list !== undefined && list.type !== "plain-list") list = list.parent;
  if (list !== undefined) {
    while (list.parent !== undefined && (list.parent.type === "item" || list.parent.type === "plain-list")) list = list.parent;
    let items = 0;
    const count = (x: Elem): void => {
      for (const c of x.children) {
        if (c.type === "item") items++;
        count(c);
      }
    };
    count(list);
    const lines = lineAt(list.begin) + items;
    if (singleLinesListIsParagraph && list.contentsEnd !== undefined && lineStartOrEnd(lines) === list.contentsEnd) {
      return pseudo(affiliatedBegin(list.begin), list.end, list.parent);
    }
  }
  const [cb, ce] = e.type === "headline" ? headlineContents(e) : [e.contentsBegin, e.contentsEnd];
  return { type: e.type, begin, end: e.end, postAffiliated: e.begin, contentsBegin: cb, contentsEnd: ce, parent: e.parent };
}

const LINE_BLOCKS = ["comment-block", "example-block", "export-block", "src-block", "verse-block"];

/** Moves forward to the end of a paragraph or what stands for one, once, as org--forward-paragraph-once. */
function forwardParagraphOnce(): void {
  e8.saveRestriction(() => {
    e8.widen();
    e8.skipCharsForward(" \t\n");
    if (e8.point() >= e8.pointMax()) return;
    // Out of a fold point is in.
    const fold = folded(e8.point()) ? foldRegionAt(e8.point()) : undefined;
    if (fold !== undefined) {
      e8.gotoChar(fold[1]);
      forwardLine(1);
      return;
    }
    const el = paragraphAtPoint();
    if (el === undefined) return;
    const postEol = e8.lineEnd(lineAt(el.postAffiliated));
    if (el.type === "plain-list") {
      e8.gotoChar(e8.point() + 1);
      forwardParagraphOnce();
    } else if (folded(postEol)) {
      // A folded element, all of it.
      e8.gotoChar(foldRegionAt(postEol)?.[1] ?? postEol);
      forwardLine(1);
    } else if (el.contentsBegin !== undefined && el.contentsBegin > e8.point() && el.type !== "paragraph") {
      // Into a greater element.
      e8.gotoChar(el.contentsBegin);
      if (e8.point() !== e8.lineBeginningPosition()) forwardParagraphOnce();
      else if (previousLineEmpty()) forwardLine(-1);
    } else if (LINE_BLOCKS.includes(el.type)) {
      // Between empty lines in a block.
      const contentsStart = lineStartOrEnd(lineAt(el.postAffiliated) + 1);
      if (e8.point() < contentsStart) e8.gotoChar(contentsStart);
      else {
        let q = el.end;
        while (q > 0 && /[ \t\n]/.test(e8.bufferText(q - 1, q))) q--;
        const contentsEnd = e8.lineStart(lineAt(q));
        if (e8.point() >= contentsEnd) {
          e8.gotoChar(q);
          forwardLine(1);
        } else if (e8.reSearchForward("^[ \t]*\n", { bound: contentsEnd, noerror: true }) !== undefined) forwardLine(-1);
        else e8.gotoChar(contentsEnd);
      }
    } else {
      // To the element's end.
      let q = el.end;
      while (q > 0 && /[ \t\n]/.test(e8.bufferText(q - 1, q))) q--;
      e8.gotoChar(q);
      forwardLine(1);
    }
  });
}

/** Moves back to the start of a paragraph or what stands for one, once, as org--backward-paragraph-once. */
function backwardParagraphOnce(): void {
  e8.saveRestriction(() => {
    e8.widen();
    if (e8.point() <= e8.pointMin()) return;
    // Blank lines at the start of the buffer.
    if (/^[ \t]*$/.test(e8.lineText(lineAt())) && /^[ \t\n]*$/.test(e8.bufferText(e8.pointMin(), e8.point()))) {
      e8.gotoChar(e8.pointMin());
      return;
    }
    // Out of a fold before point.
    const fold = folded(e8.point() - 1) ? foldRegionAt(e8.point() - 1) : undefined;
    if (fold !== undefined) {
      e8.gotoChar(fold[0] - 1);
      backwardParagraphOnce();
      return;
    }
    const el = paragraphAtPoint();
    if (el === undefined) return;
    const prevLineEnd = (): number => {
      const l = lineAt();
      return l === 0 ? e8.pointMin() : e8.lineEnd(l - 1);
    };
    // To p, or the empty line above it if that shows.
    const reach = (p: number): void => {
      e8.gotoChar(p);
      if (previousLineEmpty()) {
        const end = prevLineEnd();
        if (end === e8.pointMin() || !folded(end - 1)) forwardLine(-1);
      }
    };
    const parent = el.parent;
    if (el.begin === e8.point()) {
      if (previousLineEmpty() && !folded(prevLineEnd() - 1)) forwardLine(-1);
      else if (parent !== undefined && parent.type !== "section" && el.begin === (parent.type === "headline" ? headlineContents(parent)[0] : parent.contentsBegin)) {
        reach(NO_AFFILIATED.includes(parent.type) ? parent.begin : affiliatedBegin(parent.begin));
      } else {
        e8.gotoChar(e8.point() - 1);
        backwardParagraphOnce();
      }
    } else if (el.type === "paragraph" && el.begin !== e8.lineStart(lineAt(el.begin))) {
      // A paragraph at the start of an item or a footnote definition.
      reach(e8.lineStart(lineAt(el.begin)));
    } else if (folded(e8.lineEnd(lineAt(el.postAffiliated)))) {
      reach(el.begin);
    } else if (el.contentsEnd !== undefined && el.contentsEnd <= e8.point() && el.type !== "paragraph") {
      // Into a greater element from its end.
      if (el.type === "footnote-definition" || el.type === "plain-list") {
        e8.skipCharsBackward(" \t\n");
        backwardParagraphOnce();
      } else if (el.contentsEnd === e8.point()) {
        e8.gotoChar(e8.point() - 1);
        backwardParagraphOnce();
      } else e8.gotoChar(el.contentsEnd);
    } else if (LINE_BLOCKS.includes(el.type) && e8.point() > lineStartOrEnd(lineAt(el.postAffiliated) + 1)) {
      // Between empty lines in a block.
      const contentsStart = lineStartOrEnd(lineAt(el.postAffiliated) + 1);
      let q = el.end;
      while (q > 0 && /[ \t\n]/.test(e8.bufferText(q - 1, q))) q--;
      const contentsEnd = e8.lineStart(lineAt(q));
      if (e8.point() > contentsEnd) e8.gotoChar(contentsEnd);
      else {
        e8.skipCharsBackward(" \t\n", el.begin);
        if (e8.reSearchBackward("^[ \t]*\n", { bound: contentsStart, noerror: true }) === undefined) e8.gotoChar(contentsStart);
      }
    } else reach(el.begin);
  });
}

/** Moves over `arg` paragraphs or Org elements, back if negative, as org-forward-paragraph; returns how many it could not. */
function orgForwardParagraph(arg: number): number {
  if (arg < 0) return orgBackwardParagraph(-arg);
  let n = arg;
  while (n > 0 && e8.point() < e8.pointMax()) {
    forwardParagraphOnce();
    n--;
  }
  return n;
}

/** Moves back over `arg` paragraphs or Org elements, as org-backward-paragraph. */
function orgBackwardParagraph(arg: number): number {
  if (arg < 0) return orgForwardParagraph(-arg);
  let n = arg;
  while (n > 0 && e8.point() > e8.pointMin()) {
    backwardParagraphOnce();
    n--;
  }
  return n;
}

const orgForwardParagraphCommand = e8.defineCommand({
  name: "org-forward-paragraph",
  doc:
    "Move forward over a paragraph or what stands for one in Org: an element such as a table or a list, a run of keywords or clocks, " +
    "or the text between empty lines in a block. With a prefix argument, that many; back if negative.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    orgForwardParagraph(arg);
  },
});
const orgBackwardParagraphCommand = e8.defineCommand({
  name: "org-backward-paragraph",
  doc: "Move back over a paragraph or what stands for one in Org, as org-forward-paragraph moves forward. With a prefix argument, that many.",
  shiftSelect: true,
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    orgBackwardParagraph(arg);
  },
});
e8.remapCommand("org-mode-map", "forward-paragraph", orgForwardParagraphCommand);
e8.remapCommand("org-mode-map", "backward-paragraph", orgBackwardParagraphCommand);

/**
 * Where the contents of the element at point begin and end for Org's
 * sentence motion, as Org's parser has them: a headline's after its line,
 * a paragraph's before its blank lines, and a standard table row's between
 * its first bar and the end of its text, a rule having none.
 */
function sentenceContents(e: Elem): [number | undefined, number | undefined] {
  if (e.type === "headline") return headlineContents(e);
  if (e.type === "section") return [e.contentsBegin ?? e.begin, e.end];
  if (e.type === "paragraph") return [e.contentsBegin ?? e.begin, lineStartOrEnd(lineAt(endBeforeBlank(e)) + 1)];
  if (e.type === "table-row") {
    const line = lineAt(e.begin);
    const text = e8.lineText(line);
    if (/^[ \t]*\|-/.test(text)) return [undefined, undefined];
    const bar = /^[ \t]*\|/.exec(text)![0];
    return [e.begin + charCount(bar), e8.lineStart(line) + charCount(text.replace(/[ \t]+$/, ""))];
  }
  return [e.contentsBegin, e.contentsEnd];
}

/** Org's table, holding an element or the element itself, as org-element-lineage with 'table. */
function tableOf(e: Elem | undefined): Elem | undefined {
  for (let x = e; x; x = x.parent) if (x.type === "table") return x;
  return undefined;
}

/** Signals as Org's arithmetic does on a contents bound a table rule does not have. */
function needNumber(n: number | undefined): number {
  if (n === undefined) e8.signal("wrong-type-argument", "Wrong type argument: number-or-marker-p, nil", ["number-or-marker-p", null]);
  return n as number;
}

const orgBackwardSentenceCommand = e8.defineCommand({
  name: "org-backward-sentence",
  doc: "Move to the start of the sentence, kept inside the element point is in, or of the table field, as backward-sentence or org-table-beginning-of-field.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    const el = elementAt(p);
    const [cb, ce] = el ? sentenceContents(el) : [undefined, undefined];
    const table = tableOf(el);
    if (table && p > needNumber(cb) && p <= (table.contentsEnd ?? table.end)) {
      e8.call("org-table-beginning-of-field", arg);
      return;
    }
    // Shift selects as backward-sentence's ^ would, not in a table, as Org's field commands do not.
    e8.handleShiftSelection(e8.thisCommandKeysShiftTranslated());
    e8.saveRestriction(() => {
      if (cb !== undefined && e8.pointMin() < cb && p > cb) e8.narrowToRegion(cb, needNumber(ce));
      e8.call("backward-sentence", arg);
    });
  },
});

const orgForwardSentenceCommand = e8.defineCommand({
  name: "org-forward-sentence",
  doc: "Move to the end of the sentence, kept inside the element point is in or a heading's line, or of the table field, as forward-sentence or org-table-end-of-field.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const p = e8.point();
    const line = lineAt();
    // Shift selects as forward-sentence's ^ would, not in a table, as Org's field commands do not.
    const shiftSelect = (): void => e8.handleShiftSelection(e8.thisCommandKeysShiftTranslated());
    if (isHeadingLine(e8.lineText(line)) && /\S/.test(e8.bufferText(p, e8.lineEnd(line)))) {
      shiftSelect();
      e8.saveRestriction(() => {
        e8.narrowToRegion(e8.lineStart(line), e8.lineEnd(line));
        e8.call("forward-sentence", arg);
      });
      return;
    }
    const el = elementAt(p);
    const [cb, ce] = el ? sentenceContents(el) : [undefined, undefined];
    const table = tableOf(el);
    if (table && p >= (table.contentsBegin ?? table.begin) && p < needNumber(ce)) {
      e8.call("org-table-end-of-field", arg);
      return;
    }
    shiftSelect();
    e8.saveRestriction(() => {
      if (el && ce !== undefined && e8.pointMax() > ce) {
        // Org means to stop at blank lines between elements, but compares
        // the element's end with how many blank characters follow its
        // contents, which skip-chars-forward returns, rather than where
        // they end; so only an element ending that near the buffer's start
        // keeps the motion inside it.
        let q = ce;
        while (q < e8.pointMax() && /[ \r\t\n]/.test(e8.bufferText(q, q + 1))) q++;
        if (el.end + 1 < q - ce) e8.narrowToRegion(needNumber(cb), ce);
      }
      // The end of a heading is the end of a sentence.
      const end = `${sentenceEnd()}\\|^\\*+ .*$`;
      e8.letBind({ "sentence-end": end }, () => e8.call("forward-sentence", arg));
    });
  },
});
e8.remapCommand("org-mode-map", "backward-sentence", orgBackwardSentenceCommand);
e8.remapCommand("org-mode-map", "forward-sentence", orgForwardSentenceCommand);

/** Where an element's contents end, as Org's parser has it: a section's are all of it, a headline's before its blank lines. */
function contentsEndOf(e: Elem): number | undefined {
  if (e.type === "section") return e.end;
  if (e.type === "headline") return headlineContents(e)[1];
  return e.contentsEnd;
}

/** Moves to the next element at the same level, as org-forward-element. */
function orgForwardElement(): void {
  if (e8.point() >= e8.pointMax()) e8.userError("Cannot move further down");
  if (isHeadingLine(e8.lineText(lineAt()))) {
    // Past the subtree of the heading that shows, as org-end-of-subtree
    // goes back to a visible one, to the next heading, or the end if that
    // is on a heading's line.
    const origin = e8.point();
    const all = headings();
    const i = visibleHeadingIndex(all, lineAt());
    const next = i === undefined ? undefined : nextSameOrHigher(all, i);
    e8.gotoChar(next === undefined ? e8.pointMax() : Math.min(next.start, e8.pointMax()));
    if (!isHeadingLine(e8.lineText(lineAt()))) {
      e8.gotoChar(origin);
      e8.userError("Cannot move further down");
    }
    return;
  }
  const found = elementWithAffiliated(e8.point());
  if (found === undefined) {
    e8.message("No element at point");
    return;
  }
  const [e] = found;
  const parent = e.parent;
  if (parent !== undefined && parent.type !== "org-data" && contentsEndOf(parent) === e.end) e8.gotoChar(parent.end);
  else e8.gotoChar(e.end);
}

/** Moves to the previous element at the same level, or the start of this one, as org-backward-element. */
function orgBackwardElement(): void {
  if (e8.point() <= e8.pointMin()) e8.userError("Cannot move further up");
  if (isHeadingLine(e8.lineText(lineAt()))) {
    // The heading before at this level, or the parent heading.
    const origin = e8.point();
    forwardHeadingSameLevel(-1);
    if (e8.point() === origin) {
      const all = headings();
      const i = all.findIndex((h) => h.line === lineAt());
      const parent = i < 0 ? undefined : [...all.slice(0, i)].reverse().find((h) => h.level < all[i].level);
      if (parent === undefined) {
        e8.gotoChar(origin);
        e8.userError("Cannot move further up");
      }
      e8.gotoChar(parent!.start);
    }
    return;
  }
  const found = elementWithAffiliated(e8.point());
  if (found === undefined) {
    e8.message("No element at point");
    return;
  }
  const [, beg] = found;
  if (e8.point() !== beg) {
    e8.gotoChar(beg);
    return;
  }
  e8.skipCharsBackward(" \r\t\n");
  if (e8.point() <= e8.pointMin()) return;
  // The start of the element before, or of what holds it that ends before this one.
  const prevFound = elementWithAffiliated(e8.point());
  if (prevFound === undefined) return;
  let [prev, prevBegin] = prevFound;
  e8.gotoChar(prevBegin);
  for (let p = prev.parent; p !== undefined && p.type !== "org-data" && p.end <= beg; p = p.parent) {
    prev = p;
    prevBegin = NO_AFFILIATED.includes(p.type) ? p.begin : affiliatedBegin(p.begin);
    e8.gotoChar(prevBegin);
  }
}

const orgForwardElementCommand = e8.defineCommand({
  name: "org-forward-element",
  doc: "Move forward to the next element at the same level, or past the subtree from a heading.",
  run: () => orgForwardElement(),
});
const orgBackwardElementCommand = e8.defineCommand({
  name: "org-backward-element",
  doc: "Move back to the start of this element, or the one before at the same level; from a heading, the heading before at its level or its parent.",
  run: () => orgBackwardElement(),
});
e8.bindKey("M-}", orgForwardElementCommand, "org-mode-map");
e8.bindKey("M-{", orgBackwardElementCommand, "org-mode-map");
e8.bindKey("S-RET", "org-table-copy-down", "org-mode-map");

// Keys for terminals, which cannot send some of the keys above, as Org binds
// them without a graphical display or with org-use-extra-keys. ESC RET and
// ESC with an arrow, which Org binds too, are already M-RET and M-<arrow>;
// and C-c C-x c and C-c C-x d are left out, as Org binds them again after
// these, to cloning a subtree and inserting a drawer.
e8.defineVariable({
  name: "org-use-extra-keys",
  doc:
    "Whether Org binds its keys for terminals, as C-c C-x l for M-<left> and C-c <up> for S-<up>, which it does on a terminal anyway. " +
    "Org reads it only when it loads; E8 binds them when it is set too, as init.ts runs after Org has loaded.",
  value: null,
});
const EXTRA_KEYS: [string, e8.CommandName][] = [
  ["C-c C-x m", "org-meta-return"],
  ["C-c C-x M", "org-insert-todo-heading"],
  ["C-c C-x s", "org-insert-structure-template"],
  ["C-c C-x RET", "org-meta-return"],
  ["C-c C-x l", "org-metaleft"],
  ["C-c C-x r", "org-metaright"],
  ["C-c C-x u", "org-metaup"],
  ["C-c C-x L", "org-shiftmetaleft"],
  ["C-c C-x R", "org-shiftmetaright"],
  ["C-c C-x U", "org-shiftmetaup"],
  ["C-c C-x D", "org-shiftmetadown"],
  ["C-c <up>", "org-shiftup"],
  ["C-c <down>", "org-shiftdown"],
  ["C-c <left>", "org-shiftleft"],
  ["C-c <right>", "org-shiftright"],
  ["C-c C-x <right>", "org-shiftcontrolright"],
  ["C-c C-x <left>", "org-shiftcontrolleft"],
];
function bindExtraKeys(): void {
  for (const [key, command] of EXTRA_KEYS) e8.bindKey(key, command, "org-mode-map");
}
if (truthy(e8.variable("org-use-extra-keys") ?? null) || !e8.displayGraphicP()) bindExtraKeys();
e8.addVariableWatcher("org-use-extra-keys", (_symbol, value) => {
  if (truthy(value ?? null)) bindExtraKeys();
});

// Filling's paragraphs, with lists of one-line items not one, as org-setup-filling sets fill-forward-paragraph-function.
e8.defun("org--fill-forward-paragraph", (arg?: e8.Value) => {
  singleLinesListIsParagraph = false;
  try {
    return orgForwardParagraph(typeof arg === "number" ? arg : 1);
  } finally {
    singleLinesListIsParagraph = true;
  }
});

e8.bindKey("C-S-<up>", shiftControlUp, "org-mode-map");
e8.bindKey("C-S-<down>", shiftControlDown, "org-mode-map");
/** Whether point is in a table.el table, as org-at-table.el-p: its line starts with | or + and the parser says so. */
function tableElHere(): boolean {
  return /^[ \t]*[|+]/.test(e8.lineText(lineAt())) && tableElTable(elementAt(e8.point()));
}

const ctrlCRet = e8.defineCommand({
  name: "org-ctrl-c-ret",
  doc: "C-c RET in Org: in a table, insert a rule below the row and move past it; else insert a heading, as org-insert-heading does.",
  run: () => {
    // Org's tables only, as org-at-table-p, not table.el's.
    if (atTable() && !tableElHere()) e8.callWithPrefix(e8.prefixArg(), "org-table-hline-and-move" as e8.CommandName);
    else e8.callWithPrefix(e8.prefixArg(), "org-insert-heading");
  },
});
e8.bindKey("C-c RET", ctrlCRet, "org-mode-map");
// --- Comments, as org-setup-comments-handling sets them up -----------------

/**
 * Whether beg to end lie in a source block's body, after its first line
 * and before its last, as Org's comment commands check to comment in the
 * block's own language; `inclusiveEnd` as the region's check allows the
 * last line's start.
 */
function inSrcBody(beg: number, end: number, inclusiveEnd: boolean): boolean {
  const el = elementAt(beg);
  if (el?.type !== "src-block") return false;
  const last = e8.lineStart(lineAt(endBeforeBlank(el)));
  return e8.lineEnd(lineAt(el.begin)) < beg && (inclusiveEnd ? last >= end : last > end);
}

e8.defun("org-insert-comment", () => {
  // In a source block, as its language comments, in its edit buffer.
  if (inSrcBody(e8.point(), e8.point(), false)) {
    if (e8.fboundp("org-src--comment-dwim")) e8.funcall("org-src--comment-dwim");
    return;
  }
  // A comment above the line, or on it if it is blank.
  e8.gotoChar(e8.lineStart(lineAt()));
  if (/^\s*$/.test(e8.lineText(lineAt()))) e8.deleteRegion(e8.point(), e8.lineEnd(lineAt()));
  else {
    e8.insert("\n");
    e8.gotoChar(e8.point() - 1);
  }
  indentLine(lineAt());
  e8.insert("# ");
});

/** To a column of the line, as move-to-column with FORCE: a tab across it made spaces, and a short line made long enough. */
function moveToColumnForce(column: number): void {
  const got = e8.moveToColumn(column);
  if (got < column) e8.indentTo(column);
  else if (got > column && e8.bufferText(e8.point() - 1, e8.point()) === "\t") {
    // Into the tab: spaces before it up to the column with indent-tabs-mode,
    // else the tab made spaces, as move-to-column does with FORCE.
    const start = e8.point() - 1;
    const before = e8.saveExcursion(() => {
      e8.gotoChar(start);
      return e8.currentColumn();
    });
    e8.gotoChar(start);
    if (truthy(e8.variable("indent-tabs-mode") ?? null)) e8.insert(" ".repeat(column - before));
    else {
      e8.deleteRegion(start, start + 1);
      e8.insert(" ".repeat(got - before));
      e8.moveToColumn(column);
    }
  }
}

e8.defun("org-comment-or-uncomment-region", (beg: number, end: number) => {
  // In a source block, as its language comments, in its edit buffer.
  if (inSrcBody(beg, end, true)) {
    e8.saveExcursion(() => {
      e8.gotoChar(beg);
      if (e8.fboundp("org-src--comment-or-uncomment-region")) e8.funcall("org-src--comment-or-uncomment-region", end - beg);
    });
    return;
  }
  e8.saveRestriction(() => {
    // The region's lines, without blank lines around them.
    let b = beg;
    while (b < end && /[ \r\t\n]/.test(e8.bufferText(b, b + 1))) b++;
    let q = end;
    while (q > beg && /[ \r\t\n]/.test(e8.bufferText(q - 1, q))) q--;
    e8.narrowToRegion(e8.lineStart(lineAt(b)), e8.lineEnd(lineAt(q)));
    // Only comments, with blank lines between: uncomment them.
    const uncomment = e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMin());
      for (;;) {
        if (e8.point() >= e8.pointMax()) return true;
        const el = elementAt(e8.point());
        if (el?.type !== "comment") return false;
        e8.gotoChar(Math.min(e8.pointMax(), el.end));
      }
    });
    e8.saveExcursion(() => {
      const first = lineAt(e8.pointMin());
      const lines: number[] = [];
      for (let l = first; l < e8.lineCount() && e8.lineStart(l) <= e8.pointMax() && !(l > first && e8.lineStart(l) === e8.pointMax()); l++) lines.push(l);
      if (uncomment) {
        for (const l of lines) {
          const m = /^([ \t]*)(#(?: |$))/.exec(e8.lineText(l));
          if (m) e8.deleteRegion(e8.lineStart(l) + m[1].length, e8.lineStart(l) + m[1].length + charCount(m[2]));
        }
        return;
      }
      // Each line commented at the least indentation of those not blank.
      let min = Infinity;
      for (const l of lines) if (!/^[ \t]*$/.test(e8.lineText(l))) min = Math.min(min, textIndentation(e8.lineText(l)));
      if (min === Infinity) min = 0;
      const emptyToo = truthy(e8.variable("comment-empty-lines") ?? null);
      const start = String(e8.variable("comment-start") ?? "# ");
      for (const l of lines) {
        if (!emptyToo && /^[ \t]*$/.test(e8.lineText(l))) continue;
        e8.gotoChar(e8.lineStart(l));
        moveToColumnForce(min);
        e8.insert(start);
      }
    });
  });
});

const orgCommentDwim = e8.defineCommand({
  name: "org-comment-dwim",
  barfIfReadOnly: true,
  doc: "M-; in Org: on a heading, make it a comment or take that away, as org-toggle-comment; elsewhere as comment-dwim.",
  run: () => {
    barfIfBufferReadOnly();
    if (isHeadingLine(e8.lineText(lineAt()))) e8.funcallInteractively("org-toggle-comment");
    else e8.funcallInteractively("comment-dwim");
  },
});
e8.remapCommand("org-mode-map", "comment-dwim", orgCommentDwim);
e8.defun("org-adaptive-fill-function", () => adaptiveFillPrefix() ?? null);

// Breaks the line, the new one starting as org-adaptive-fill-function says, as org-comment-line-break-function does.
e8.defun("org-comment-line-break-function", (soft?: e8.Value) => {
  const prefix = adaptiveFillPrefix();
  // A hard newline as (newline 1) makes it: with an argument, so Auto Fill does not run.
  if (truthy(soft ?? null)) e8.insertAndInherit("\n");
  else e8.callWithPrefix(1, "newline");
  const deleteSpace = (): void => {
    let a = e8.point();
    let b = a;
    while (a > e8.pointMin() && /[ \t]/.test(e8.bufferText(a - 1, a))) a--;
    while (b < e8.pointMax() && /[ \t]/.test(e8.bufferText(b, b + 1))) b++;
    if (b > a) e8.deleteRegion(a, b);
  };
  e8.saveExcursion(() => {
    e8.gotoChar(e8.point() - 1);
    deleteSpace();
  });
  deleteSpace();
  if (prefix !== undefined) e8.insertBeforeMarkers(prefix);
});

e8.remapCommand("org-mode-map", "self-insert-command", "org-self-insert-command");
e8.remapCommand("org-mode-map", "delete-backward-char", "org-delete-backward-char");
e8.remapCommand("org-mode-map", "delete-char", "org-delete-char");
e8.remapCommand("org-mode-map", "fill-paragraph", "org-fill-paragraph" as e8.CommandName);
e8.remapCommand("org-mode-map", "move-end-of-line", "org-end-of-line");
// A remap, as Org's, so C-y is still yank's key to where-is and \[yank].
e8.remapCommand("org-mode-map", "yank", "org-yank");
e8.remapCommand("org-mode-map", "move-beginning-of-line", orgBeginningOfLine);
