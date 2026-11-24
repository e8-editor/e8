// The agenda, after Emacs's org-agenda.el: the week's scheduled items,
// deadlines and timestamps from org-agenda-files, and the list of TODO
// items, in the *Org Agenda* buffer, whose keys act on the entries they show.

import {
  agendaFiles,
  storeTagsLines,
  type DateTime,
  type Heading,
  PLANNING,
  allKeywords,
  at,
  categories,
  category,
  currentTagAlist,
  durationToMinutes,
  globalTagsCompletionTable,
  isTagKeyword,
  keyChar,
  tagAddToAlist,
  type TagEntry,
  tagGroups,
  tagsExpandGroup,
  entryBlockedBy,
  entryEnd,
  headingIndex,
  headings,
  inVerbatimOrLink,
  allTagsOf,
  linkTypeKnown,
  linksIn,
  openLink,
  isDone,
  keywordLines,
  makeTagsMatcher,
  notDoneRegexp,
  parseDate,
  readDate,
  reducedLevel,
  type PriorityAction,
  getPriority,
  todoToSet,
  scanTags,
  setPriority,
  showPriority,
  smallYearToYear,
  subtreeRegion,
  timestampDatesAt,
  shiftTimestampAt,
  timestampTextAt,
  today,
  updateDblock,
} from "org";
import { linkUnescape, setAgendaEntryHere, storeLink } from "ol";
import { entryGet } from "org-list";
import { addArchiveFiles, archivingFromAgenda } from "org-archive";
import { flag, hideDrawersIn, showContext, showEntry } from "org-fold";
import { type Habit, buildGraph, habitUrgency, parseHabit } from "org-habit";
import { getLocation, gotoLastStored, refile } from "org-refile";
import { multiOccur } from "replace";
import { allMatches, charCount, eraseBuffer, regexpQuote, truthy } from "subr";

e8.defineVariable({
  name: "org-agenda-window-setup",
  doc: "Where the agenda shows: reorganize-frame, this window and the agenda's; current-window; only-window; or other-window.",
  value: "reorganize-frame",
});
e8.defineVariable({
  name: "org-agenda-files",
  doc: "The files the agenda collects entries from, as a list of file names.",
  value: [],
});
e8.defineVariable({
  name: "org-agenda-show-inherited-tags",
  doc: "Whether agenda lines show the tags their headings inherit, from the file and the headings above, before their own.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-skip-archived-trees",
  doc: "Whether the agenda leaves out entries in subtrees tagged ARCHIVE.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-skip-comment-trees",
  doc: "Whether the agenda leaves out entries in subtrees whose heading starts with COMMENT.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-dim-blocked-tasks",
  doc:
    "Whether the agenda dims the TODO entries that org-blocker-hook blocks from being done, as the TODO dependencies do. " +
    "invisible hides them instead, but for those blocked only by checkboxes, which are dimmed.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-start-with-archives-mode",
  doc: "Whether a new agenda shows archived trees: nil, trees for the trees tagged ARCHIVE, or t for the agenda files' archive files too.",
  value: null,
});
e8.defineFace({ name: "org-agenda-dimmed-todo-face", doc: "Blocked tasks in the agenda.", attributes: { foreground: "#7f7f7f" } });
e8.defineVariable({
  name: "org-deadline-warning-days",
  doc: "How many days ahead today's agenda warns of a deadline, unless its timestamp says, as -3d does; 0 or less applies whatever it says.",
  value: 14,
});
e8.defineVariable({
  name: "org-agenda-use-time-grid",
  doc: "Whether today's agenda draws a time grid among the entries with times, as org-agenda-time-grid says.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-use-tag-inheritance",
  doc: "Which agenda views take the tags their items inherit: a list of agenda, todo and search, or t for all.",
  value: [e8.intern("todo"), e8.intern("search"), e8.intern("agenda")],
});
e8.defineVariable({
  name: "org-agenda-log-mode-items",
  doc: "What log mode shows: closed for entries closed, clock for clocked time, state for changes of TODO state logged.",
  value: [e8.intern("closed"), e8.intern("clock")],
});
e8.defineVariable({
  name: "org-agenda-log-mode-add-notes",
  doc: "Whether log mode adds the first line of a state change's or a clock's note to its line.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-start-with-log-mode",
  doc: "Whether a new agenda starts in log mode: t for org-agenda-log-mode-items, only for nothing else, or a list of kinds.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-clockreport-parameter-plist",
  doc: "The clock table's parameters in the agenda's clock report (R), as a dynamic block's: the agenda's days and files are added.",
  value: [e8.intern(":link"), true, e8.intern(":maxlevel"), 2],
});
e8.defineVariable({
  name: "org-agenda-clock-report-header",
  doc: "Text put before the agenda's clock report, or nil for none.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-start-with-clockreport-mode",
  doc: "Whether a new agenda starts with its clock report, a clock table of its days at the end.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-entry-text-maxlines",
  doc: "How many lines of each entry's text entry text mode (E) shows under its agenda line.",
  value: 5,
});
e8.defineVariable({
  name: "org-agenda-entry-text-exclude-regexps",
  doc: "Regexps whose matches are taken out of the entry text entry text mode shows.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-entry-text-leaders",
  doc: "The text before each line of entry text in the agenda.",
  value: "    > ",
});
e8.defineVariable({
  name: "org-agenda-start-with-entry-text-mode",
  doc: "Whether a new agenda starts in entry text mode, showing some of each entry's text under its line.",
  value: null,
});
e8.defineHook("org-agenda-entry-text-cleanup-hook", "Functions run in a buffer holding an entry's text, before entry text mode shows it, to clean it up.");
e8.defineVariable({
  name: "org-agenda-start-with-follow-mode",
  doc: "Whether a new agenda starts in follow mode, showing each line's entry in another window as point moves.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-include-deadlines",
  doc: "Whether the agenda shows deadlines; v ! toggles it.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-include-inactive-timestamps",
  doc: "Whether the agenda shows entries for their inactive timestamps too, as [ in an agenda turns on for one rebuilding.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-inactive-leader",
  doc: "The text before an agenda item that an inactive timestamp brought in.",
  value: "[",
});
e8.defineVariable({
  name: "org-agenda-time-grid",
  doc: "The time grid: when it is drawn, its times as HHMM, the string after a time, and the line drawn.",
  value: [["daily", "today", "require-timed"], [800, 1000, 1200, 1400, 1600, 1800, 2000], "......", "----------------"],
});
e8.defineVariable({
  name: "org-agenda-show-current-time-in-grid",
  doc: "Whether the time grid shows the time now, as org-agenda-current-time-string.",
  value: true,
});
e8.defineVariable({
  name: "org-agenda-current-time-string",
  doc: "What the time grid's line for the time now says.",
  value: "now - - - - - - - - - - - - - - - - - - - - - - - - -",
});
e8.defineVariable({
  name: "org-scheduled-delay-days",
  doc: "How many days after its date a scheduled entry waits to show, unless its timestamp says, as -2d does; less than 0 applies whatever it says.",
  value: 0,
});

e8.defineVariable({
  name: "org-agenda-span",
  doc: "How many days the agenda shows: day, week, fortnight, month, year, or a number of days.",
  value: "week",
});
e8.defineVariable({
  name: "org-agenda-start-on-weekday",
  doc: "The day of the week an agenda of 7 or 14 days starts on, 0 for Sunday and 1 for Monday, or nil to start on the day itself.",
  value: 1,
});
e8.defineVariable({
  name: "org-agenda-start-day",
  doc:
    "The day the agenda starts on, as a date org-read-date reads, such as \"2026-11-01\" or \"+2d\", or nil for today. " +
    "An agenda of 7 or 14 days still starts on org-agenda-start-on-weekday before it.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-show-all-dates",
  doc: "Whether the agenda shows every day in its span, or only the days with entries.",
  value: true,
});

const AGENDA = "*Org Agenda*";

/** The name org-follow-timestamp-link gives the agenda it makes, as org-agenda-buffer-tmp-name; the others are *Org Agenda*. */
let bufferTmpName: string | undefined;
/** The buffer the last agenda was put in. */
let agendaBuffer = AGENDA;
const AGENDA_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const AGENDA_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A day as a count of days, for comparing and stepping through dates. */
function dayNumber(d: DateTime): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86400000);
}

function dayFromNumber(n: number): DateTime {
  const t = new Date(n * 86400000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** The ISO week number of a day, as the agenda shows it. */
function isoWeekOf(n: number): number {
  const wd = (new Date(n * 86400000).getUTCDay() + 6) % 7;
  const thursday = n - wd + 3;
  const year = new Date(thursday * 86400000).getUTCFullYear();
  return Math.floor((thursday - Math.floor(Date.UTC(year, 0, 1) / 86400000)) / 7) + 1;
}

/** The day of the week of a day, 0 for Sunday, as calendar-day-of-week counts. */
function weekday(n: number): number {
  return new Date(n * 86400000).getUTCDay();
}

function leapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The day of a month, day and year, as calendar-absolute-from-gregorian
 * counts it: a month past 12, or before 1, runs on into the years around,
 * and a day past its month's end into the months after, as org-agenda-later
 * relies on.
 */
function gregorianDay(month: number, day: number, year: number): number {
  let n = day + 31 * (month - 1);
  if (month > 2) {
    n -= Math.trunc((23 + 4 * month) / 10);
    if (leapYear(year)) n++;
  }
  const y = year - 1;
  // Day 0 is 1970-01-01, absolute day 719163.
  return n + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 719163;
}

/** The year a day's ISO week is in, as calendar-iso-from-absolute gives it. */
function isoYearOf(n: number): number {
  return new Date((n - ((weekday(n) + 6) % 7) + 3) * 86400000).getUTCFullYear();
}

/** The Monday of an ISO week, as calendar-iso-to-absolute finds it. */
function isoWeekMonday(week: number, year: number): number {
  const jan4 = gregorianDay(1, 4, year);
  return jan4 - ((weekday(jan4) + 6) % 7) + 7 * (week - 1);
}

/** How many days an agenda shows: day, week, fortnight, month, year, or a number of days, as org-agenda-span takes. */
type Span = "day" | "week" | "fortnight" | "month" | "year" | number;

/** A span's name for a number of days that has one, as org-agenda-ndays-to-span gives it. */
function ndaysToSpan(n: Span): Span {
  return n === 1 ? "day" : n === 7 ? "week" : n === 14 ? "fortnight" : n;
}

/** How many days a span is from a day, as org-agenda-span-to-ndays counts them. */
function spanToNdays(span: Span, start: number): number {
  if (typeof span === "number") return span;
  if (span === "day") return 1;
  if (span === "week") return 7;
  if (span === "fortnight") return 14;
  const d = dayFromNumber(start);
  if (span === "month") return new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
  return leapYear(d.year) ? 366 : 365;
}

/** The span's name in the agenda's header and mode line, as org-agenda-span-name writes it. */
function spanName(span: Span | undefined): string {
  if (span === undefined) return "";
  return typeof span === "number" ? `${span} days` : span[0].toUpperCase() + span.slice(1);
}

/** A span from a variable's value: a symbol's name or a number. */
function spanOf(value: e8.Value | undefined): Span {
  if (typeof value === "number") return value;
  if (value === "day" || value === "week" || value === "fortnight" || value === "month" || value === "year") return value;
  return "week";
}

/** org-agenda-start-on-weekday: the day of the week a week's or a fortnight's agenda starts on, or none. */
function startOnWeekday(): number | null {
  const v = e8.variable("org-agenda-start-on-weekday");
  return typeof v === "number" ? v : null;
}

/** An active timestamp's day and repeater, from text such as <2026-10-28 Wed +1w>. */
function activeTimestamp(text: string): { day: number; repeat?: [number, string] } | undefined {
  const m = /^<(\d{4})-(\d{2})-(\d{2})[^>\n]*>/.exec(text);
  if (!m) return undefined;
  const day = dayNumber({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  const r = /(?:\.\+|\+\+|\+)(\d+)([dwmy])/.exec(m[0]);
  return { day, repeat: r ? [Number(r[1]), r[2]] : undefined };
}

/** Whether a timestamp falls on a day, counting its repeats on or after its date. */
function occursOn(ts: { day: number; repeat?: [number, string] }, day: number): boolean {
  if (day === ts.day) return true;
  if (!ts.repeat || day < ts.day) return false;
  const [n, unit] = ts.repeat;
  if (unit === "d" || unit === "w") return (day - ts.day) % (unit === "w" ? 7 * n : n) === 0;
  const a = dayFromNumber(ts.day);
  const b = dayFromNumber(day);
  if (a.day !== b.day) return false;
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  return unit === "m" ? months % n === 0 : a.month === b.month && (b.year - a.year) % n === 0;
}

/** A heading's priority as org-get-priority gives it, as Org's agenda ranks its lines by. */
function priorityValue(h: Heading): number {
  return getPriority(e8.lineText(h.line));
}

/**
 * One line of the agenda: its text, how urgent it is, and the entry it
 * shows: where in it the line points, as Org's org-marker (a scheduled
 * item's timestamp, say), and its heading, as org-hd-marker. The line's
 * category and leader are kept to write it again when the entry changes.
 */
interface AgendaItem {
  text: string;
  urgency: number;
  buffer: string;
  /** Where the line points and the heading, when the agenda was made. */
  pos: number;
  heading: number;
  cat: string;
  leader: string;
  /** Its time of day as the line shows it, " 9:30......" or "10:00-11:30", and in minutes, for sorting. */
  time?: { field: string; minutes: number };
  /** The habit a scheduled line is, whose graph the line shows. */
  habit?: Habit;
  /** The timestamp its time comes from, as Org's dotime, whose copy in the heading the line leaves out. */
  dotime?: string;
  /** Markers at `pos` and `heading`, once the agenda shows the line, so they follow edits there. */
  marks?: { pos: e8.Marker; heading: e8.Marker };
  /** Whether its entry was blocked when the agenda was made, and the line is dimmed or hidden for it, as org-todo-blocked marks the line. */
  blocked?: "dim" | "hide";
  /** The kind of line it is for its tags, as the item maker that made it names it. */
  tagType?: TagType;
}

/** Where the line's entry is now: its marker's place, as Org's org-marker follows edits. */
function posOf(item: AgendaItem): number {
  return (item.marks && e8.markerPosition(item.marks.pos)) ?? item.pos;
}

/** Where the entry's heading is now, as org-hd-marker. */
function headingOf(item: AgendaItem): number {
  return (item.marks && e8.markerPosition(item.marks.heading)) ?? item.heading;
}

/** The string after a time on the grid and on entries, as org-agenda-time-grid's third element. */
function gridDots(): string {
  const grid = e8.variable("org-agenda-time-grid");
  return Array.isArray(grid) && typeof grid[2] === "string" ? grid[2] : "......";
}

/** A time of day as the agenda writes it: hours padded to two, as " 9:30". */
const clockTime = (h: number, m: number): string => `${String(h).padStart(2)}:${String(m).padStart(2, "0")}`;

/**
 * A timestamp's time of day as an agenda line shows it, as
 * org-agenda-format-item does: " 9:30......", or a range "10:00-11:30".
 */
function timeOf(ts: string): AgendaItem["time"] {
  const m = /^[<[]\d{4}-\d{2}-\d{2}[^>\]\n]*? (\d{1,2}):(\d{2})(?:-(\d{1,2}):(\d{2}))?/.exec(ts);
  if (m === null) return undefined;
  const [h, min] = [Number(m[1]), Number(m[2])];
  const field = m[3] === undefined ? clockTime(h, min) + gridDots() : `${clockTime(h, min)}-${Number(m[3])}:${m[4]}`;
  return { field, minutes: h * 60 + min };
}

/**
 * An agenda line for a heading, as org-agenda-format-item makes one: the
 * category, padded with its colon to 12 columns, a leader such as
 * "Scheduled: ", the heading's text without its tags, and the tags against
 * the window's right edge.
 */
/** Each heading's inherited tags, the file's #+FILETAGS: first, kept for the buffer as it is now. */
let inheritedCache: { buffer: number; tick: number; map: Map<number, string[]> } | undefined;

/**
 * The tags a heading inherits, as org-get-tags gives them with inheritance:
 * the file's, then each ancestor's, as org-use-tag-inheritance allows, a
 * tag once, where it comes last.
 */
function inheritedTags(h: Heading): string[] {
  const buffer = e8.currentBuffer().id;
  const tick = e8.bufferCharsModifiedTick();
  if (!inheritedCache || inheritedCache.buffer !== buffer || inheritedCache.tick !== tick) {
    const map = new Map<number, string[]>();
    const all = headings();
    const tags = allTagsOf(all);
    all.forEach((x, i) => map.set(x.start, tags[i].filter((t) => !x.tags.includes(t))));
    inheritedCache = { buffer, tick, map };
  }
  return inheritedCache.map.get(h.start) ?? [];
}

/** The kinds of line Org's item makers tell apart for tags: agenda items, TODO-like ones (the TODO list's, the search view's and logged items), and the tags view's. */
type TagType = "agenda" | "todo" | "tags";
/** The kind of the lines being made, as each of Org's item makers names its own. */
let lineTagType: TagType = "agenda";

/** A value that is a list, nil among them, as listp; and whether a list names a view type, as memq. */
const isList = (v: e8.Value | undefined): boolean => Array.isArray(v) || v === null || v === undefined || v === false;
const names = (v: e8.Value | undefined, type: string): boolean =>
  Array.isArray(v) && v.some((x) => (typeof x === "symbol" ? e8.symbolName(x) : String(x)) === type);

/**
 * Whether the lines of TYPE take inherited tags, as each of Org's item
 * makers decides from org-agenda-show-inherited-tags and
 * org-agenda-use-tag-inheritance; the tags view's always do, as
 * org-scan-tags takes them all, and show them while
 * org-agenda-show-inherited-tags is on.
 */
function takesInheritedTags(type: TagType): boolean {
  const show = e8.variable("org-agenda-show-inherited-tags");
  if (type === "tags") return truthy(show ?? null);
  const use = e8.variable("org-agenda-use-tag-inheritance");
  const showName = typeof show === "symbol" ? e8.symbolName(show) : show;
  return showName === "always" || names(show, type) || (show === true && (use === true || names(use, type)));
}

/** A line's tags as the agenda shows them, inherited ones first and :: before the heading's own, as org-agenda-fix-displayed-tags writes them. */
function displayedTags(h: Heading): string {
  const inherited = takesInheritedTags(lineTagType) ? inheritedTags(h).filter((t) => !h.tags.includes(t)) : [];
  if (inherited.length === 0) return h.tags.length === 0 ? "" : `:${h.tags.join(":")}:`;
  return `:${inherited.join(":")}:${h.tags.length === 0 ? ":" : `:${h.tags.join(":")}:`}`;
}

function agendaLine(
  h: Heading,
  cat: string,
  leader: string,
  removeTimestamp: boolean,
  time?: AgendaItem["time"],
  prefix = "",
  dotime?: string,
  extra?: string,
): string {
  let text = prefix + e8.lineText(h.line).replace(/^\*+[ \t]+/, "");
  if (h.tagsAt !== undefined) text = text.slice(0, text.length - (e8.lineEnd(h.line) - h.tagsAt) - 0).replace(/[ \t]+$/, "");
  // A log item's note, as org-agenda-get-progress puts it after the heading, before its tags.
  if (extra !== undefined) text = `${text} - ${extra}`;
  if (time !== undefined && dotime !== undefined) text = withoutPrefixTime(text, dotime);
  // Every active timestamp, as org-ts-regexp is removed until none is left.
  if (removeTimestamp) text = text.replace(/<\d{4}-\d{2}-\d{2}[^>\n]*>/g, "");
  const line = `  ${(cat === "" ? "" : `${cat}:`).padEnd(12)}${time === undefined ? "" : `${time.field.padEnd(11)} `}${leader === "" ? "" : `${leader} `}${text}`;
  const tags = displayedTags(h);
  if (tags === "") return line;
  const width = (e8.windowSize()?.width ?? 80) - 1;
  return line + " ".repeat(Math.max(1, width - charCount(visibleText(line)) - charCount(tags))) + tags;
}

/**
 * Whether the agenda shows archived trees, as org-agenda-archives-mode:
 * null for neither, trees for the trees tagged ARCHIVE, true for those and
 * the agenda files' archive files.
 */
let archivesMode: null | "trees" | true = null;

/** The files the agenda reads: org-agenda-files, and their archive files in archives mode t, as (org-agenda-files nil 'ifmode). */
function agendaFilesIfMode(): string[] {
  const files = agendaFiles();
  return archivesMode === true ? addArchiveFiles(files) : files;
}

/** A timestamp with a time of day or a range of times, as org-stamp-time-of-day-regexp. */
const STAMP_TIME = /<(\d{4}-\d{2}-\d{2} +[\p{L}\p{N}_]+ +)([012][0-9]:[0-5][0-9])(-([012][0-9]:[0-5][0-9]))?[^\n\r>]*?>(--?<\1([012][0-9]:[0-5][0-9])>)?/u;

/**
 * TEXT without the timestamp whose time the line shows before it, and the
 * spaces after it, as org-agenda-format-item takes it out with
 * org-agenda-remove-times-when-in-prefix: the first timed timestamp in
 * DOTIME or else in the heading's other text, unless a ] follows it.
 */
function withoutPrefixTime(text: string, dotime: string): string {
  const option = e8.variable("org-agenda-remove-times-when-in-prefix") ?? true;
  if (!truthy(option)) return text;
  const ts = dotime + text.replace(/[<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]]/g, "");
  const m = STAMP_TIME.exec(ts);
  if (m === null) return text;
  const at = text.indexOf(m[0]);
  if (at < 0 || (option === "beg" && at !== 0)) return text;
  let end = at + m[0].length;
  while (text[end] === " ") end++;
  if (text[end] === "]") return text;
  return text.slice(0, at) + text.slice(end);
}

/** The buffers of org-agenda-files, or of FILES, visited if need be. */
function agendaBuffers(files = agendaFilesIfMode()): string[] {
  // Relative names are in org-directory, and directories stand for their Org files, as org-agenda-files expands them.
  // Each file's TAGS lines read again, as org-agenda-prepare-buffers does with org-set-regexps-and-options.
  return files.map((file) => {
    const buffer = e8.findFileNoselect(file);
    e8.withCurrentBuffer(buffer, () => {
      if (e8.derivedModeP("org-mode")) storeTagsLines();
    });
    return buffer;
  });
}

/**
 * How many days before a deadline it is warned of, or after a scheduled date
 * the entry waits, as org-get-wdays: a negative or, for deadlines, zero
 * variable applies whatever the timestamp says, else its own -Nd, -Nw, -Nm
 * or -Ny, else the variable.
 */
function wdays(ts: string, delay: boolean): number {
  const tv = Number(e8.variable(delay ? "org-scheduled-delay-days" : "org-deadline-warning-days") ?? (delay ? 0 : 14));
  if ((delay && tv < 0) || (!delay && tv <= 0)) return -tv;
  const m = /-([0-9]+)([hdwmy])(?=$|>| )/.exec(ts);
  if (m === null) return tv;
  const unit: Record<string, number> = { d: 1, w: 7, m: 30.4, y: 365.25, h: 0.041667 };
  return Math.floor(Number(m[1]) * unit[m[2]]);
}

/** A heading's planning timestamps: when it is scheduled and due, and where those timestamps are. */
function planningOf(h: Heading): {
  scheduled?: number;
  deadline?: number;
  scheduledRepeat?: [number, string];
  deadlineRepeat?: [number, string];
  scheduledAt?: number;
  deadlineAt?: number;
  scheduledText?: string;
  deadlineText?: string;
  /** Days before a deadline its warning starts, as org-get-wdays gives them. */
  warning?: number;
  /** Days after its date a scheduled entry waits to show, as org-get-wdays gives them with DELAY. */
  delay?: number;
} {
  const line = h.line + 1;
  if (line >= e8.lineCount() || !PLANNING.test(e8.lineText(line))) return {};
  const text = e8.lineText(line);
  const out: ReturnType<typeof planningOf> = {};
  const s = /SCHEDULED:[ \t]*(<[^>\n]*>)/.exec(text);
  const d = /DEADLINE:[ \t]*(<[^>\n]*>)/.exec(text);
  const st = s && activeTimestamp(s[1]);
  if (s && st) {
    [out.scheduled, out.scheduledRepeat] = [st.day, st.repeat];
    out.delay = wdays(s[1], true);
    out.scheduledText = s[1];
    out.scheduledAt = at(line, text, (s.index ?? 0) + s[0].length - s[1].length);
  }
  const dt = d && activeTimestamp(d[1]);
  if (d && dt) {
    out.deadline = dt.day;
    out.deadlineRepeat = dt.repeat;
    out.warning = wdays(d[1], false);
    out.deadlineText = d[1];
    out.deadlineAt = at(line, text, (d.index ?? 0) + d[0].length - d[1].length);
  }
  return out;
}

/** A heading as the agenda reads it, once for every day it shows: its planning, its priority and its entry's active timestamps. */
interface Scanned {
  h: Heading;
  done: boolean;
  plan: ReturnType<typeof planningOf>;
  priority: number;
  /** The entry's active timestamps but its planning line's, in order, and its inactive ones with org-agenda-include-inactive-timestamps: where each is, and whether it is in the heading. */
  stamps: { ts: { day: number; repeat?: [number, string] }; pos: number; inHeading: boolean; text: string; inactive?: boolean }[];
  /** The entry's date ranges, <a>--<b>, or [a]--[b] as for stamps: their first and last days, the timestamps at either end, and where they are. */
  ranges: { first: number; last: number; from: string; to: string; pos: number; inactive?: boolean }[];
  habit?: Habit;
  /** Its category, as org-get-category gives it at the heading. */
  cat: string;
  /** What the entry logs, for log mode: what kind, on which day, its timestamp and the rest, as org-agenda-get-progress reads them. */
  logs: LogLine[];
}

/** A line log mode shows: CLOSED:, CLOCK: or a "- State" note, with the inactive timestamp it is dated by. */
interface LogLine {
  kind: "closed" | "clock" | "state";
  /** The days it is dated by: the timestamp after it, or for a state change any on its line after it, as Org's .*? reaches them. */
  days: number[];
  /** Its line, of which a day shows only the first log, as org-agenda-get-progress goes on from the line's end. */
  line: number;
  /** The timestamp, a clock's with its end time as 08:00-09:00, as Org's timestr. */
  stamp: string;
  /** A clock's duration, or - while it runs; a state change's new state. */
  clocked?: string;
  state?: string;
  /** The first line of its note. */
  note?: string;
  pos: number;
}

/**
 * The log lines of a line of text, and the line after for their notes, as
 * org-agenda-get-progress finds them: CLOSED: and CLOCK: after a word's
 * start, and "- State" with a TODO keyword, each dated by the inactive
 * timestamp after it.
 */
/** The regexp of log lines, as org-agenda-get-progress makes it from the buffer's TODO keywords; \\< after a letter or digit only, as _ is no word's. */
function logRegexp(keywords: string[]): RegExp {
  const kw = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:(?<![\\p{L}\\p{N}])(CLOSED:|CLOCK:)|- +State "(${kw === "" ? "(?!)" : kw})".*?) *\\[(\\d{4})-(\\d{2})-(\\d{2})`, "gu");
}

function logLinesOf(line: number, re: RegExp): LogLine[] {
  const text = e8.lineText(line);
  if (!/CLOSED:|CLOCK:|State/.test(text)) return [];
  const out: LogLine[] = [];
  const next = line + 1 < e8.lineCount() ? e8.lineText(line + 1) : "";
  for (const m of allMatches(re, text)) {
    const kind = m[1] === "CLOSED:" ? "closed" : m[1] === "CLOCK:" ? "clock" : "state";
    const day = dayNumber({ year: Number(m[3]), month: Number(m[4]), day: Number(m[5]) });
    const days = [day];
    // A state change is dated by any timestamp after it on the line, as .*? goes on to one of the day.
    if (kind === "state") {
      for (const d of allMatches(/\[(\d{4})-(\d{2})-(\d{2})/g, text.slice((m.index ?? 0) + m[0].length))) {
        days.push(dayNumber({ year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) }));
      }
    }
    // The timestamp, up to its bracket, and what follows it.
    const from = (m.index ?? 0) + m[0].length - 11;
    const ts = /^\[\d{4}-\d{2}-\d{2}[^\]\n>]*?\]/.exec(text.slice(from));
    let stamp = ts ? ts[0] : text.slice(from);
    let clocked: string | undefined;
    if (kind === "clock") {
      const rest = text.slice(from + stamp.length);
      const r = /(\d{1,2}:\d{2})\].*?(\d{1,2}:\d{2})/.exec(rest);
      if (r) {
        stamp = `${stamp.slice(0, -1)}-${r[1]}]`;
        clocked = r[2];
      } else clocked = "-";
    }
    let note: string | undefined;
    if (truthy(e8.variable("org-agenda-log-mode-add-notes") ?? null)) {
      const after = text.slice((m.index ?? 0) + m[0].length);
      // A line ending with a backslash, as a note's \\ does, then the note.
      if (kind === "state" && /\\$/.test(after)) note = /^[ \t]*([^-\n \t].*?)[ \t]*$/.exec(next)?.[1];
      if (kind === "clock") note = /^[ \t]*-[ \t]+([^-\n \t].*?)[ \t]*$/.exec(next)?.[1];
    }
    out.push({ kind, days, line, stamp, pos: at(line, text, m.index ?? 0), ...(clocked !== undefined ? { clocked } : {}), ...(kind === "state" ? { state: m[2] } : {}), ...(note !== undefined ? { note } : {}) });
  }
  return out;
}

/** Runs `f` with the current buffer widened, as Org's agenda reads and edits files whole, however they are narrowed. */
const widened = <T>(f: () => T): T =>
  e8.saveRestriction(() => {
    e8.widen();
    return f();
  });

/** A date range of either kind, <a>--<b> or [a]--[b], or one end of each, joined by one to three dashes, as org-tr-regexp-both matches one. */
const RANGE_BOTH = /([<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]])-{1,3}([<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]])/g;

/** A timestamp of either kind's day, its repeater only if it is active. */
function eitherTimestamp(text: string): { day: number; repeat?: [number, string] } | undefined {
  return text.startsWith("[") ? inactiveTimestamp(text) : activeTimestamp(text);
}

/** An inactive timestamp's day, from text such as [2026-10-28 Wed], which never repeats in the agenda. */
function inactiveTimestamp(text: string): { day: number } | undefined {
  const m = /^\[(\d{4})-(\d{2})-(\d{2})[^\]\n]*\]/.exec(text);
  return m ? { day: dayNumber({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }) } : undefined;
}

/** The current buffer's headings as the agenda reads them, and its category. */
function scanBuffer(): { cat: string; entries: Scanned[] } {
  notOrg();
  const all = headings();
  const cats = categories(all);
  // Archived and commented trees left out, as org-agenda-skip leaves them.
  const skipped = skippedHeadings(all);
  // Inactive timestamps too, as org-agenda-include-inactive-timestamps asks.
  const inactive = truthy(e8.variable("org-agenda-include-inactive-timestamps") ?? null);
  const stamp = inactive ? /[<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]]/g : /<\d{4}-\d{2}-\d{2}[^>\n]*>/g;
  const logRe = logRegexp(allKeywords());
  const entries = all.map((h, i): Scanned => {
    const logs: LogLine[] = [];
    const stamps: Scanned["stamps"] = [];
    const ranges: Scanned["ranges"] = [];
    const end = entryEnd(all, i);
    let inSrc = false;
    // In an example, export or comment block, or on a fixed-width line, a
    // timestamp is no timestamp object, as org-at-timestamp-p's context
    // says, so it brings no item; a range there still does.
    let rawBlock: string | undefined;
    for (let l = h.line; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      // The planning line's CLOSED: too, which the timestamps leave to the planning.
      if (l === h.line + 1 && PLANNING.test(e8.lineText(l))) {
        if (showLog !== null) logs.push(...logLinesOf(l, logRe));
        continue;
      }
      const text = e8.lineText(l);
      // Comment lines and the inside of source blocks left out, as org-agenda-skip leaves them.
      if (inSrc) {
        if (/^[ \t]*#\+end_src\b/i.test(text)) inSrc = false;
        continue;
      }
      if (/^[ \t]*#\+begin_src\b/i.test(text)) inSrc = true;
      if (/^[ \t]*#(?: |$)/.test(text)) continue;
      // Not in a comment or a source block, as org-agenda-skip leaves them, but in an example block.
      if (showLog !== null) logs.push(...logLinesOf(l, logRe));
      const raw = rawBlock !== undefined || /^[ \t]*:(?: |$)/.test(text);
      if (rawBlock !== undefined) {
        if (new RegExp(`^[ \\t]*#\\+end_${rawBlock}\\b`, "i").test(text)) rawBlock = undefined;
      } else rawBlock = /^[ \t]*#\+begin_(example|export|comment)\b/i.exec(text)?.[1]?.toLowerCase();
      if (!text.includes("<") && !(inactive && text.includes("["))) continue;
      // A clock's inactive timestamps are left out, as org-agenda-get-timestamps skips clock lines.
      const clockLine = /^[ \t]*CLOCK:/.test(text);
      // A range's ends belong to the range, which shows on every day of it, as org-agenda-get-blocks has it.
      const inRange: [number, number][] = [];
      for (const m of allMatches(RANGE_BOTH, text)) {
        // Inactive by its first end, as org-agenda-get-blocks looks at the first bracket.
        const off = m[1].startsWith("[");
        const mixed = off !== m[2].startsWith("[");
        const [a, b] = [eitherTimestamp(m[1]), eitherTimestamp(m[2])];
        if (a === undefined || b === undefined) continue;
        // Its ends are no timestamps of their own, either way.
        inRange.push([m.index, m.index + m[0].length]);
        // Only active ones without org-agenda-include-inactive-timestamps, as org-tr-regexp matches.
        if (!inactive && (off || mixed)) continue;
        // Pointing after the range, where org-agenda-get-blocks' search leaves its marker.
        ranges.push({ first: a.day, last: b.day, from: m[1], to: m[2], pos: at(l, text, m.index + m[0].length), ...(off ? { inactive: true } : {}) });
      }
      for (const m of allMatches(stamp, text)) {
        if (inRange.some(([a, b]) => m.index >= a && m.index < b)) continue;
        if (raw || inVerbatimOrLink(at(l, text, m.index) + 1)) continue;
        const off = m[0].startsWith("[");
        if (off && clockLine) continue;
        const ts = off ? inactiveTimestamp(m[0]) : activeTimestamp(m[0]);
        if (ts) stamps.push({ ts, pos: at(l, text, m.index), inHeading: l === h.line, text: m[0], ...(off ? { inactive: true } : {}) });
      }
    }
    const plan = planningOf(h);
    // Only a scheduled entry can be a habit, so only those have their properties read.
    const habit = plan.scheduled !== undefined ? parseHabit(h) : undefined;
    return { h, done: isDone(h.todo), plan, priority: priorityValue(h), stamps, ranges, cat: cats[i], logs, ...(habit ? { habit } : {}) };
  });
  return { cat: category(), entries: entries.filter((_, i) => !skipped[i]) };
}

/** org-agenda-inactive-leader, as the agenda puts it before what an inactive timestamp brought in. */
function inactiveLeader(): string {
  const v = e8.variable("org-agenda-inactive-leader");
  return typeof v === "string" ? v : "";
}

/** The items for a day from the current buffer, scanned once, as org-agenda-get-day-entries collects them. */
function dayItems(scan: { cat: string; entries: Scanned[] }, day: number, today: number, buffer: string): AgendaItem[] {
  const deadlines: AgendaItem[] = [];
  const scheduled: AgendaItem[] = [];
  const stamps: AgendaItem[] = [];
  const blocks: AgendaItem[] = [];
  const logged: AgendaItem[] = [];
  const items = logItems();
  for (const { h, done, plan, priority, stamps: found, ranges, habit, cat, logs } of scan.entries) {
    // What the entry logged that day, as org-agenda-get-progress gives it.
    const linesDone = new Set<number>();
    for (const log of logs) {
      if (!log.days.includes(day) || !items.includes(log.kind) || linesDone.has(log.line)) continue;
      linesDone.add(log.line);
      const leader = log.kind === "closed" ? "Closed:    " : log.kind === "state" ? `State:     (${log.state})` : `Clocked:   (${log.clocked})`;
      const time = timeOf(log.stamp);
      const item = { cat, leader, buffer, pos: log.pos, heading: h.start, ...(time ? { time, dotime: log.stamp } : {}) };
      // Logged items take tags as TODO items do, as org-agenda-get-progress decides with todo.
      const outer = lineTagType;
      lineTagType = "todo";
      const text = agendaLine(h, cat, leader, false, time, "", log.stamp, log.note);
      lineTagType = outer;
      logged.push({ ...item, text, urgency: 100000, tagType: "todo" });
    }
    // Only those, with C-u C-u l or the clock check.
    if (showLog === "only" || showLog === "clockcheck") continue;
    // Each day of a range, numbered, with the time it starts on its first
    // day and ends on its last, as org-agenda-get-blocks has them.
    for (const r of ranges) {
      if (day < r.first || day > r.last) continue;
      const leader = (r.inactive ? inactiveLeader() : "") + (r.first === r.last ? "" : `(${day - r.first + 1}/${r.last - r.first + 1}): `);
      const [from, to] = [timeOf(r.from), timeOf(r.to)];
      const time = r.first === day && r.last === day && from && to
        ? { field: `${from.field.replace(gridDots(), "")}-${to.field.replace(gridDots(), "").trim()}`, minutes: from.minutes }
        : r.first === day ? from : r.last === day ? to : undefined;
      // The timestamps its times come from, as org-agenda-get-blocks gives them.
      const dotime = r.first === day && r.last === day ? `${r.from}--${r.to}` : r.first === day ? r.from : r.last === day ? r.to : undefined;
      const item = { cat, leader, buffer, pos: r.pos, heading: h.start, ...(time ? { time, dotime } : {}) };
      blocks.push({ ...item, text: agendaLine(h, cat, leader, false, time, "", dotime), urgency: priority });
    }
    // Not with org-agenda-include-deadlines nil, as org-agenda-list leaves :deadline out of the entry types.
    if (plan.deadline !== undefined && truthy(e8.variable("org-agenda-include-deadlines") ?? null)) {
      const diff = plan.deadline - day;
      let leader: string | undefined;
      // Its date, and after today each of its repeats, as org-agenda-show-future-repeats has it.
      const repeatDay = day > today && !done && plan.deadlineRepeat !== undefined && occursOn({ day: plan.deadline, repeat: plan.deadlineRepeat }, day);
      if (diff === 0 || repeatDay) leader = "Deadline:  ";
      else if (day === today && !done && diff > 0 && diff <= (plan.warning ?? 14)) leader = `In ${String(diff).padStart(3)} d.: `;
      else if (day === today && !done && diff < 0) leader = `${String(-diff).padStart(2)} d. ago: `;
      if (leader !== undefined) {
        // Its time shows on its date and its repeats, not in a warning.
        const time = (diff === 0 || repeatDay) && plan.deadlineText !== undefined ? timeOf(plan.deadlineText) : undefined;
        const dotime = plan.deadlineText;
        const item = { cat, leader, buffer, pos: plan.deadlineAt ?? h.start, heading: h.start, ...(time ? { time, dotime } : {}) };
        deadlines.push({ ...item, text: agendaLine(h, cat, leader, false, time, "", dotime), urgency: priority - (day === today ? diff : 0) });
      }
    }
    if (plan.scheduled !== undefined) {
      // A repeater's later dates show only after today; up to today, the
      // item counts from its base date, as org-agenda-get-scheduled has it.
      const ts = { day: plan.scheduled, repeat: plan.scheduledRepeat };
      const diff = day - plan.scheduled;
      const onDay = day === plan.scheduled || (day > today && occursOn(ts, day));
      // A delay keeps it out of the agenda until that many days after its date.
      const delay = plan.delay ?? 0;
      const past = day === today && plan.scheduled < today && !done && !(delay > 0 && today - plan.scheduled < delay);
      // A habit shows only today, as org-habit-show-habits-only-for-today says.
      const hidden = habit !== undefined && (done || e8.variable("org-habit-show-habits") !== true ||
        (e8.variable("org-habit-show-habits-only-for-today") === true && day !== today));
      const delayed = delay > 0 && diff < delay;
      if (((onDay && !(done && plan.scheduled !== day) && !delayed) || past) && !hidden) {
        // A habit has no leader, its graph saying when it is due, and is as urgent as org-habit-get-urgency says.
        const leader = habit !== undefined ? "" : past ? `Sched.${String(diff).padStart(2)}x: ` : "Scheduled: ";
        const time = !past && plan.scheduledText !== undefined ? timeOf(plan.scheduledText) : undefined;
        const dotime = plan.scheduledText;
        const item = { cat, leader, buffer, pos: plan.scheduledAt ?? h.start, heading: h.start, ...(time ? { time, dotime } : {}) };
        const urgency = habit !== undefined ? habitUrgency(habit, today) : 99 + (past ? diff : 0) + priority;
        scheduled.push({ ...item, text: agendaLine(h, cat, leader, false, time, "", dotime), urgency, ...(habit ? { habit } : {}) });
      }
    }
    // The first active timestamp in the heading and its entry on the day,
    // the heading's active timestamps left out, as org-agenda-get-timestamps
    // gives org-ts-regexp to take out.
    // Each timestamp on the day is an item, as org-agenda-skip-additional-timestamps-same-entry nil has it.
    for (const stamp of found.filter((s) => occursOn(s.ts, day))) {
      const time = timeOf(stamp.text);
      const dotime = stamp.text;
      // An inactive one's item has org-agenda-inactive-leader before it.
      const leader = stamp.inactive ? inactiveLeader() : "";
      const item = { cat, leader, buffer, pos: stamp.pos, heading: h.start, ...(time ? { time, dotime } : {}) };
      stamps.push({ ...item, text: agendaLine(h, cat, leader, true, time, "", dotime), urgency: priority });
    }
  }
  return [...logged, ...deadlines, ...scheduled, ...blocks, ...stamps];
}

/**
 * Whether the agenda shows what was logged, as org-agenda-show-log: null
 * for not, true for org-agenda-log-mode-items, "only" for nothing else,
 * or the kinds, as C-u l shows them all.
 */
let showLog: null | true | "only" | "clockcheck" | string[] = null;

/** The kinds of lines log mode shows, as org-agenda-get-progress's items: the clock's alone for the clock check. */
function logItems(): string[] {
  if (Array.isArray(showLog)) return showLog;
  if (showLog === "clockcheck") return ["clock"];
  const v = e8.variable("org-agenda-log-mode-items");
  return Array.isArray(v) ? v.map((x) => (typeof x === "symbol" ? e8.symbolName(x) : String(x))) : [];
}

/** A new agenda's log mode, as org-agenda-start-with-log-mode says. */
function startLogMode(): void {
  const v = e8.variable("org-agenda-start-with-log-mode") ?? null;
  const name = typeof v === "symbol" ? e8.symbolName(v) : v;
  showLog = Array.isArray(v)
    ? v.map((x) => (typeof x === "symbol" ? e8.symbolName(x) : String(x)))
    : name === "only" || name === "clockcheck" ? name : truthy(v) ? true : null;
}

/**
 * Sorts a day's items as org-agenda-sorting-strategy's habit-down time-up
 * urgency-down: habits last, then those with a time, earliest first, before
 * those without, then by urgency, most urgent first, keeping their order
 * otherwise.
 */
function byUrgency(items: AgendaItem[]): AgendaItem[] {
  const habit = (i: AgendaItem) => (i.habit !== undefined ? 1 : 0);
  // Without a time is late, as org-agenda-sort-notime-is-late has it.
  const time = (i: AgendaItem) => i.time?.minutes ?? 24 * 60;
  return items
    .map((item, k) => ({ item, k }))
    .sort((a, b) => habit(a.item) - habit(b.item) || time(a.item) - time(b.item) || b.item.urgency - a.item.urgency || a.k - b.k)
    .map((x) => x.item);
}

/** What the agenda buffer shows, for its keys to act on and g to rebuild. */
let agendaView:
  // What org-agenda-list was given, as its org-last-args: the prefix argument, the day asked for and the span.
  | { kind: "agenda"; arg: e8.PrefixArg | null; startDay?: number; span: Span }
  | { kind: "todo" }
  | { kind: "tags"; todoOnly: boolean; match: string }
  | { kind: "search"; todoOnly: boolean; todoOnlyArg: boolean; string: string; boolean: boolean } = { kind: "todo" };
let agendaLines: (AgendaItem | undefined)[] = [];
/** Each line's day, and the count of the days shown up to it, as org-agenda-list puts day and org-day-cnt on them; the header has none. */
let agendaLineDays: ({ day: number; cnt: number } | undefined)[] = [];

/**
 * Puts each habit's graph on its line at org-habit-graph-column, over what
 * is there, as org-habit-insert-consistency-graphs does: three weeks before
 * today and a week after.
 */
function insertHabitGraphs(lines: { text: string; item?: AgendaItem }[]): void {
  const now = dayNumber(today_());
  const column = Number(e8.variable("org-habit-graph-column") ?? 40);
  const before = Number(e8.variable("org-habit-preceding-days") ?? 21);
  const after = Number(e8.variable("org-habit-following-days") ?? 7);
  lines.forEach((l, line) => {
    const habit = l.item?.habit;
    if (habit === undefined) return;
    const graph = buildGraph(habit, now - before, now, now + after);
    const start = e8.lineStart(line);
    const end = e8.lineEnd(line);
    const length = end - start;
    const at = start + Math.min(column, length);
    e8.gotoChar(at);
    if (length < column) e8.insert(" ".repeat(column - length));
    const from = e8.point();
    e8.deleteRegion(from, Math.min(from + before + after + 1, e8.lineEnd(line)));
    e8.insert(`${graph.text} `);
    graph.faces.forEach((face, k) => e8.putTextProperty(from + k, from + k + 1, "face", face));
  });
}

/** Puts lines into the agenda buffer and shows it, as org-agenda-prepare and org-agenda-finalize do. */
/** An agenda's lines: each line's text and its item. */
type AgendaLines = { text: string; item?: AgendaItem }[];

/** A bracket link, its target and its description up to the ]] that ends it, as org-link-bracket-re. */
const AGENDA_LINK = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([\s\S]+?)\])?\]/g;

/** Whether links show only their descriptions, as org-link-descriptive says. */
const linksDescriptive = (): boolean => truthy(e8.variable("org-link-descriptive") ?? null);

/** Text as it shows with its links' descriptions, or their targets, alone, for lining up tags, as Emacs's widths leave out invisible text. */
function visibleText(text: string): string {
  return linksDescriptive() ? text.replace(AGENDA_LINK, (_m, link: string, desc?: string) => desc ?? link) : text;
}

/** Hides a line's link brackets and targets, as org-agenda-finalize's org-activate-links makes them invisible, leaving descriptions. */
function hideLinksOn(line: number): void {
  const text = e8.lineText(line);
  const ls = e8.lineStart(line);
  const pos = (k: number) => ls + charCount(text.slice(0, k));
  for (const m of allMatches(AGENDA_LINK, text)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const shown = m[2] === undefined ? [start + 2, start + 2 + m[1].length] : [start + 2 + m[1].length + 2, end - 2];
    e8.putTextProperty(pos(start), pos(shown[0]), "invisible", "org-link");
    e8.putTextProperty(pos(shown[1]), pos(end), "invisible", "org-link");
  }
}

function showAgenda(given: AgendaLines | ((maxChars: number) => AgendaLines), pointLine: number, days: typeof agendaLineDays = []): void {
  agendaBuffer = bufferTmpName ?? AGENDA;
  agendaLineDays = days;
  e8.getBufferCreate(agendaBuffer);
  // Lines that depend on the agenda window's width are made once it is placed, as org-agenda-prepare selects it first.
  if (typeof given === "function") placeAgendaWindow();
  const lines = typeof given === "function" ? given((e8.windowSize()?.width ?? 80) - 1) : given;
  markBlocked(lines);
  e8.withCurrentBuffer(agendaBuffer, () => {
    e8.setReadOnly(false);
    eraseBuffer();
    e8.insert(lines.map((l) => l.text).join("\n") + "\n");
    insertHabitGraphs(lines);
    if (e8.variable("major-mode") !== "org-agenda-mode") e8.call("org-agenda-mode");
    setModeName();
    lines.forEach((l, line) => dimLine(line, l.item));
    // Every line's links, as org-agenda-finalize activates them in the whole buffer.
    if (linksDescriptive()) lines.forEach((_l, line) => hideLinksOn(line));
    e8.setReadOnly(true);
    e8.gotoChar(e8.lineStart(pointLine));
  });
  // The lines' markers, made in the entries' buffers, as Org makes
  // org-marker and org-hd-marker; the last agenda's are freed.
  for (const old of agendaLines) {
    if (old?.marks) {
      e8.deleteMarker(old.marks.pos);
      e8.deleteMarker(old.marks.heading);
    }
  }
  agendaLines = lines.map((l) => l.item);
  for (const item of agendaLines) if (item) item.tagType ??= lineTagType;
  for (const item of agendaLines) {
    if (item && e8.getBuffer(item.buffer)) {
      item.marks = {
        pos: e8.makeMarker(item.pos, { buffer: item.buffer }),
        heading: e8.makeMarker(item.heading, { buffer: item.buffer }),
      };
    }
  }
  // Each line's entry text, in entry text mode, as org-agenda-finalize shows it again.
  if (entryTextMode) {
    entryTextHide();
    entryTextShow(entryTextMaxlines());
  }
  // The filters in force and the presets, as org-agenda-finalize applies them.
  readFilterPresets();
  e8.withCurrentBuffer(agendaBuffer, reapplyFilters);
  placeAgendaWindow();
  const setup = e8.variable("org-agenda-window-setup");
  if (setup === undefined || setup === null || setup === "reorganize-frame") fitAgendaWindow(lines.length);
}

/** Shows the agenda's buffer as org-agenda-window-setup says, unless the selected window shows it. */
function placeAgendaWindow(): void {
  const setup = e8.variable("org-agenda-window-setup");
  if (e8.windowBuffer() === agendaBuffer) return;
  if (setup === "current-window") e8.call("switch-to-buffer", agendaBuffer);
  else if (setup === "only-window") {
    e8.call("delete-other-windows");
    e8.call("switch-to-buffer", agendaBuffer);
  } else if (setup === "other-window") e8.call("switch-to-buffer-other-window", agendaBuffer);
  else {
    // As org-agenda-window-setup's reorganize-frame: this window and the agenda's.
    if (!e8.windowList().some((w) => e8.windowBuffer(w) === agendaBuffer)) e8.call("delete-other-windows");
    e8.call("pop-to-buffer", agendaBuffer);
  }
}

/** Whether org-blocker-hook has anything on it, as Org tests it before dimming. */
function blockerHookSet(): boolean {
  const hook = e8.variable("org-blocker-hook");
  return Array.isArray(hook) ? hook.length > 0 : truthy(hook ?? null);
}

/**
 * Marks the lines whose entries are blocked, as org-agenda--mark-blocked-entry
 * does while org-agenda-dim-blocked-tasks is on and org-blocker-hook is set:
 * those with a TODO state that org-entry-blocked-p says are blocked.
 */
function markBlocked(lines: { item?: AgendaItem }[]): void {
  const option = e8.variable("org-agenda-dim-blocked-tasks") ?? null;
  // Not the search view's lines, which have no todo-state for Org to look at.
  if (!truthy(option) || !blockerHookSet() || agendaView.kind === "search") return;
  for (const { item } of lines) {
    if (!item) continue;
    const blocked = e8.withCurrentBuffer(item.buffer, () => widened(() => {
      const h = headings().find((x) => x.start === item.heading);
      return h === undefined || h.todo === undefined ? undefined : entryBlockedBy(h);
    }));
    // Hidden only when not blocked by checkboxes, which the agenda does not show.
    if (blocked) item.blocked = blocked === "blocked" && option === "invisible" ? "hide" : "dim";
  }
}

/**
 * Dims line L of the agenda if its entry is blocked, or hides it, as
 * org-agenda-dim-blocked-tasks does from the lines' marks: an overlay in
 * org-agenda-dimmed-todo-face, and with org-agenda-dim-blocked-tasks
 * invisible, the line and the newline before it made invisible, as
 * org-agenda-filter-hide-line does, unless checkboxes block it.
 */
function dimLine(l: number, item: AgendaItem | undefined): void {
  const start = e8.lineStart(l);
  const end = e8.lineEnd(l);
  for (const o of e8.overlaysIn(start, end)) {
    if (e8.overlayGet(o, "face") === "org-agenda-dimmed-todo-face") e8.deleteOverlay(o);
  }
  if (!item?.blocked) return;
  e8.makeOverlay(start, end, { face: "org-agenda-dimmed-todo-face", priority: 50 });
  if (item.blocked === "hide") {
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.putTextProperty(Math.max(e8.pointMin(), start - 1), end, "invisible", "org-filtered");
      e8.putTextProperty(Math.max(e8.pointMin(), start - 1), end, "org-filter-type", "todo-blocked");
    });
  }
}

/**
 * The agenda's mode name, as org-agenda-set-mode-name writes it: the span
 * of a day agenda (none for the other views), that deadlines are shown, as
 * E8's agenda always shows them, whether the time grid and habits are, and
 * which archives are.
 */
function setModeName(): void {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const span = agendaView.kind === "agenda" ? spanName(agendaView.span) : "";
  const grid = truthy(e8.variable("org-agenda-use-time-grid") ?? null) ? " Grid" : "";
  const habit = truthy(e8.variable("org-habit-show-habits") ?? null) ? " Habit" : "";
  const archives = archivesMode === true ? " Archives" : archivesMode === "trees" ? ` :${tag}:` : "";
  const log = Array.isArray(showLog) ? " LogAll" : showLog === "clockcheck" ? " ClkCk" : showLog !== null ? " Log" : "";
  e8.makeLocalVariable("mode-name");
  const ddl = truthy(e8.variable("org-agenda-include-deadlines") ?? null) ? " Ddl" : "";
  const follow = `${followMode ? " Follow" : ""}${entryTextMode ? " ETxt" : ""}`;
  const clock = clockreportMode ? " Clock" : "";
  e8.setVariable("mode-name", `Org-Agenda ${span}${follow}${ddl}${grid}${habit}${log}${filterModeName()}${archives}${clock}`);
}

/**
 * Fits the agenda's window to its lines, between half and three quarters
 * of the frame, as org-agenda-window-frame-fractions has it.
 */
function fitAgendaWindow(lines: number): void {
  const windows = e8.windowList();
  if (windows.length < 2) return;
  const frame = windows.reduce((sum, w) => sum + (e8.windowSize(w)?.fullWidth ? (e8.windowSize(w)?.totalHeight ?? 0) : 0), 0) + 1;
  const wanted = Math.min(Math.floor(frame * 0.75), Math.max(Math.floor(frame * 0.5), lines + 1));
  const now = e8.windowSize()?.totalHeight ?? wanted;
  if (wanted !== now) e8.resizeWindow(undefined, wanted - now);
}

/**
 * The agenda of a span of days, as org-agenda-list makes it: ARG, a
 * positive number, is the span; the days start at START-DAY, or today,
 * or for a week or a fortnight on org-agenda-start-on-weekday before it;
 * point goes to today, else to START-DAY.
 */
function agendaList(arg: e8.PrefixArg | null, startDay?: number, spanArg?: Span, weekdayStart = startOnWeekday()): void {
  lineTagType = "agenda";
  if (typeof arg === "number" && arg > 0) {
    spanArg = arg;
    arg = null;
  }
  if (typeof spanArg === "number" && !(spanArg > 0)) e8.userError(`Agenda creation impossible for this span(=${spanArg} days)`);
  // org-agenda-start-day, read as a date when the agenda is made, and kept as the day it read for making it again.
  const startVar = e8.variable("org-agenda-start-day");
  if (startDay === undefined && typeof startVar === "string") startDay = dayNumber(parseDate(startVar));
  const span = ndaysToSpan(spanArg ?? spanOf(e8.variable("org-agenda-span")));
  const today = dayNumber(today_());
  const sd = startDay ?? today;
  const ndays = spanToNdays(span, sd);
  const sow = ndays === 7 || ndays === 14 ? weekdayStart : null;
  let start = sd;
  if (sow !== null && ndays >= 7) {
    const d = weekday(sd) - sow;
    start = sd - ((d < 0 ? 7 : 0) + d);
  }
  const last = start + ndays - 1;
  const [w1, w2] = [isoWeekOf(start), isoWeekOf(last)];
  const two = (n: number) => String(n).padStart(2, "0");
  const weeks = last - start >= 350 ? "" : w1 === w2 ? ` (W${two(w1)})` : ` (W${two(w1)}-W${two(w2)})`;
  const lines: AgendaLines = [{ text: `${spanName(span)}-agenda${weeks}:` }];
  // Log mode with nothing to log fails once the header is written, as org-agenda-get-progress does.
  if (showLog !== null && logItems().length === 0) {
    agendaView = { kind: "agenda", arg, startDay, span };
    showAgenda(lines, 1, [undefined]);
    e8.signal("error", "\u2018org-agenda-log-mode-items\u2019 is empty");
  }
  const days: typeof agendaLineDays = [undefined];
  const showAll = truthy(e8.variable("org-agenda-show-all-dates") ?? null);
  let pointLine: number | undefined;
  let cnt = 0;
  const buffers = agendaBuffers();
  // Each file read once for the span, not once a day.
  const scans = new Map(buffers.map((buffer) => [buffer, e8.withCurrentBuffer(buffer, () => widened(scanBuffer))]));
  for (let day = start; day <= last; day++) {
    if (day === today || (pointLine === undefined && day === sd)) pointLine = lines.length;
    const items: AgendaItem[] = [];
    for (const buffer of buffers) items.push(...e8.withCurrentBuffer(buffer, () => dayItems(scans.get(buffer)!, day, today, buffer)));
    if (items.length === 0 && !showAll) continue;
    cnt++;
    const first = lines.length;
    const d = dayFromNumber(day);
    const wd = weekday(day);
    const week = wd === 1 ? ` W${two(isoWeekOf(day))}` : "";
    lines.push({ text: `${AGENDA_DAYS[wd].padEnd(10)} ${String(d.day).padStart(2)} ${AGENDA_MONTHS[d.month - 1]} ${d.year}${week}` });
    const sorted = byUrgency(items);
    const grid = timeGrid(sorted, day === today, ndays);
    // Each grid line after the entries at its time or earlier, as a stable sort puts it.
    for (const item of sorted) {
      while (grid.length > 0 && item.time !== undefined && grid[0].minutes < item.time.minutes) lines.push({ text: grid.shift()!.text });
      if (item.time === undefined) while (grid.length > 0) lines.push({ text: grid.shift()!.text });
      lines.push({ text: item.text, item });
    }
    for (const g of grid) lines.push({ text: g.text });
    for (let l = first; l < lines.length; l++) days[l] = { day, cnt };
  }
  // The clock report, after the days, as org-agenda-list inserts it.
  if (clockreportMode) {
    const header = e8.variable("org-agenda-clock-report-header");
    if (typeof header === "string") for (const l of header.replace(/\n$/, "").split("\n")) lines.push({ text: l });
    const table = clockReport(start, last + 1);
    for (const l of table.replace(/\n$/, "").split("\n")) if (table !== "") lines.push({ text: l });
  }
  agendaView = { kind: "agenda", arg, startDay, span };
  startingDay = start;
  showAgenda(lines, pointLine ?? 0, days);
  // The clock check goes over the clocked lines, as org-agenda-show-clocking-issues does, leaving point after the last.
  if (showLog === "clockcheck") {
    e8.withCurrentBuffer(agendaBuffer, () => {
      let end: number | undefined;
      for (let l = 0; l < e8.lineCount(); l++) {
        const m = / Clocked: +\((?:-|[0-9]+:[0-9]+)\)/.exec(e8.lineText(l));
        if (m) end = e8.lineStart(l) + charCount(e8.lineText(l).slice(0, m.index + m[0].length));
      }
      e8.gotoChar(end ?? 0);
    });
  }
}

/** The first day the last day agenda showed, as org-starting-day. */
let startingDay = 0;

/**
 * Today's time grid, as org-agenda-add-time-grid-maybe draws it with the
 * default org-agenda-time-grid: a line at each of its times, and one for
 * the time now, when the day has entries with times.
 */
function timeGrid(items: AgendaItem[], todayp: boolean, ndays: number): { text: string; minutes: number }[] {
  if (e8.variable("org-agenda-use-time-grid") === null || e8.variable("org-agenda-use-time-grid") === false) return [];
  const spec = e8.variable("org-agenda-time-grid");
  const [when, times, , rule] = Array.isArray(spec) ? spec : [];
  const conditions = Array.isArray(when) ? when.map(String) : [];
  // Today's, a one-day agenda's or every day's, as its conditions say.
  const drawn = (todayp && conditions.includes("today")) || (ndays === 1 && conditions.includes("daily")) || conditions.includes("weekly");
  if (!drawn) return [];
  if (conditions.includes("require-timed") && !items.some((i) => i.time !== undefined)) return [];
  const blank = " ".repeat(14);
  const out: { text: string; minutes: number }[] = (Array.isArray(times) ? times : []).map((t) => {
    const [h, m] = [Math.floor(Number(t) / 100), Number(t) % 100];
    return { text: `${blank}${clockTime(h, m)}${gridDots()} ${typeof rule === "string" ? rule : "----------------"}`, minutes: h * 60 + m };
  });
  const showNow = e8.variable("org-agenda-show-current-time-in-grid");
  if (todayp && showNow !== null && showNow !== false) {
    const now = today(true);
    const minutes = (now.hour ?? 0) * 60 + (now.minute ?? 0);
    const text = `${blank}${clockTime(now.hour ?? 0, now.minute ?? 0)}${gridDots()} ${String(e8.variable("org-agenda-current-time-string") ?? "")}`;
    const at = out.findIndex((g) => g.minutes > minutes);
    out.splice(at === -1 ? out.length : at, 0, { text, minutes });
  }
  return out;
}

/** Today, as the agenda counts it. */
function today_(): DateTime {
  return today();
}

// Leaving TODO entries out of the TODO list for their timestamps, as
// org-agenda-check-for-timestamp-as-reason-to-ignore-todo-item does.

for (const [name, doc] of [
  ["org-agenda-todo-ignore-with-date", "Whether the TODO list leaves out entries with an active timestamp, a planning one or not."],
  [
    "org-agenda-todo-ignore-timestamp",
    "Whether the TODO list leaves out entries with an active timestamp that is not a planning one: t for any, future, past, or a number of days (from today, before it when negative).",
  ],
  ["org-agenda-todo-ignore-scheduled", "Whether the TODO list leaves out scheduled entries: t for all, future, past, or a number of days."],
  [
    "org-agenda-todo-ignore-deadlines",
    "Whether the TODO list leaves out entries with a deadline: t for those due soon, as the agenda warns of them, all, far for those not due soon, future, past, or a number of days.",
  ],
  ["org-agenda-todo-ignore-time-comparison-use-seconds", "Whether future and past compare timestamps by the second rather than the day."],
  ["org-agenda-tags-todo-honor-ignore-options", "Whether tags-todo views and TODO-only tag matches leave out entries as the TODO list's ignore options say."],
] as const) {
  e8.defineVariable({ name, doc, value: null });
}
e8.defineVariable({
  name: "org-agenda-todo-list-sublevels",
  doc: "Whether the TODO list shows TODO entries below another, or only the first of each subtree.",
  value: true,
});

/** An option's value, a symbol read as its name. */
const optionValue = (name: string): e8.Value => {
  const v = e8.variable(name) ?? null;
  return typeof v === "symbol" ? e8.symbolName(v) : v;
};

/** Days, or seconds with org-agenda-todo-ignore-time-comparison-use-seconds, from now to a timestamp, as org-timestamp-to-now. */
function timestampToNow(ts: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[^\d]*?(\d{1,2}):(\d{2}))?/.exec(ts);
  if (!m) return 0;
  const now = today(true);
  if (truthy(e8.variable("org-agenda-todo-ignore-time-comparison-use-seconds") ?? null)) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
    const n = Date.UTC(now.year, now.month - 1, now.day, now.hour ?? 0, now.minute ?? 0);
    return (t - n) / 1000;
  }
  return (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(now.year, now.month - 1, now.day)) / 86400000;
}

/** Whether a timestamp is N days or more away, or for a negative N that many days or more ago, as org-agenda-todo-custom-ignore-p. */
function customIgnore(ts: string, n: number): boolean {
  const days = timestampToNow(ts);
  return n >= 0 ? days >= n : days <= n;
}

/** Whether an option's future, past, number or other value says to ignore the timestamp. */
function ignoredBy(option: e8.Value, ts: string): boolean {
  if (option === "future") return timestampToNow(ts) > 0;
  if (option === "past") return timestampToNow(ts) <= 0;
  if (typeof option === "number") return customIgnore(ts, option);
  return true;
}

/**
 * Whether the TODO entry at START is left out of the TODO list for its
 * timestamps, up to END, as org-agenda-check-for-timestamp-as-reason-to-ignore-todo-item.
 */
export function ignoreTodoForTimestamp(start: number, end: number, done: boolean): boolean {
  const withDate = optionValue("org-agenda-todo-ignore-with-date");
  const scheduled = optionValue("org-agenda-todo-ignore-scheduled");
  const deadlines = optionValue("org-agenda-todo-ignore-deadlines");
  const stamps = optionValue("org-agenda-todo-ignore-timestamp");
  if (!truthy(withDate) && !truthy(scheduled) && !truthy(deadlines) && !truthy(stamps)) return false;
  const text = e8.bufferSubstringNoProperties(start, end);
  // Each search goes on from where the one before left point, as Org's
  // re-search-forward calls do one after another in one save-excursion.
  let at = 0;
  const search = (re: RegExp): RegExpExecArray | null => {
    const g = new RegExp(re.source, "g");
    g.lastIndex = at;
    const m = g.exec(text);
    if (m) at = m.index + m[0].length;
    return m;
  };
  const anyStamp = /<([0-9]{4}-[0-9]{2}-[0-9]{2}(?: .*?)?)>/;
  if (truthy(withDate) && search(anyStamp)) return true;
  if (truthy(scheduled)) {
    const m = search(/\bSCHEDULED: *<([^>]+)>/);
    if (m && ignoredBy(scheduled, m[1])) return true;
  }
  if (truthy(deadlines)) {
    const m = search(/\bDEADLINE: *<([^>]+)>/);
    if (m) {
      // Due soon, as org-deadline-close-p: within its warning days, and not done.
      const close = () => timestampToNow(m[1]) <= wdays(m[1], false) && !done;
      if (deadlines === "all") return true;
      if (deadlines === "far") {
        if (!close()) return true;
      } else if (deadlines === "future" || deadlines === "past" || typeof deadlines === "number") {
        if (ignoredBy(deadlines, m[1])) return true;
      } else if (close()) return true;
    }
  }
  if (truthy(stamps)) {
    // From point, without planning timestamps: the first other one.
    const other = anyStamp.exec(text.slice(at).replace(/\bSCHEDULED: *<[^>]+>|\bDEADLINE: *<[^>]+>/g, ""));
    if (other && ignoredBy(stamps, other[1])) return true;
  }
  return false;
}

// For org-scan-tags, which org.ts has, with org-agenda-tags-todo-honor-ignore-options.
e8.defun("org-agenda-check-for-timestamp-as-reason-to-ignore-todo-item", (end?: number | null) => {
  const all = headings();
  const i = headingIndex(all, e8.lineOf(e8.point()));
  // From point, as Org searches.
  const start = e8.point();
  const stop = typeof end === "number" ? end : (all[(i ?? -1) + 1]?.start ?? e8.pointMax());
  return ignoreTodoForTimestamp(start, stop, i !== undefined && isDone(all[i].todo)) || null;
});

/**
 * Signals unless the current buffer is in Org mode, as the agenda does of
 * each of its files, the agenda left empty, as org-agenda-prepare erased it
 * before the files were read.
 */
function notOrg(): void {
  if (e8.variable("major-mode") === "org-mode" || e8.derivedModeP("org-mode")) return;
  const file = e8.bufferFileName();
  if (e8.getBuffer(AGENDA)) {
    e8.withCurrentBuffer(AGENDA, () => e8.letBind({ "inhibit-read-only": true }, () => eraseBuffer()));
    for (const old of agendaLines) {
      if (old?.marks) {
        e8.deleteMarker(old.marks.pos);
        e8.deleteMarker(old.marks.heading);
      }
    }
    agendaLines = [];
    agendaLineDays = [];
  }
  throw new Error(`Agenda file ${file} is not in Org mode`);
}

/** The TODO items that are not done, as org-todo-list shows them. */
function todoList(): void {
  lineTagType = "todo";
  const buffers = agendaBuffers();
  const items: AgendaItem[] = [];
  const keywords = new Set<string>();
  const sublevels = truthy(e8.variable("org-agenda-todo-list-sublevels") ?? null);
  for (const buffer of buffers) {
    e8.withCurrentBuffer(buffer, () => widened(() => {
      notOrg();
      for (const k of allKeywords()) keywords.add(k);
      const all = headings();
      const cats = categories(all);
      const skipped = skippedHeadings(all);
      // Below a TODO entry, without org-agenda-todo-list-sublevels: the level its subtree is at.
      let below: number | undefined;
      for (const [i, h] of all.entries()) {
        if (below !== undefined && h.level > below) continue;
        below = undefined;
        if (skipped[i]) continue;
        if (h.todo === undefined || isDone(h.todo)) continue;
        const end = all[i + 1]?.start ?? e8.pointMax();
        if (ignoreTodoForTimestamp(h.start, end, false)) {
          if (!sublevels) below = h.level;
          continue;
        }
        if (!sublevels) below = h.level;
        const cat = cats[i];
        const item = { cat, leader: "", buffer, pos: h.start, heading: h.start };
        items.push({ ...item, text: agendaLine(h, cat, "", false), urgency: 1 + priorityValue(h) });
      }
    }));
  }
  // Newest first, as org-prepare-agenda-buffers pushes each keyword it has not seen.
  const sorted = [...keywords].reverse();
  agendaView = { kind: "todo" };
  // The keywords wrapped before the agenda window's last column, as org-todo-list inserts them there.
  showAgenda((max) => {
    const lines: AgendaLines = [{ text: "Global list of TODO items of type: ALL" }];
    let header = "Press \u2018N r\u2019 (e.g. \u20180 r\u2019) to search again: (0)[ALL]";
    sorted.forEach((k, i) => {
      const word = `(${i + 1})${k}`;
      if (e8.stringWidth(header) + e8.stringWidth(word) + 1 > max) {
        lines.push({ text: header });
        header = " ".repeat(21);
      }
      header += ` ${word}`;
    });
    lines.push({ text: header });
    for (const item of byUrgency(items)) lines.push({ text: item.text, item });
    return lines;
  }, 0);
}

/**
 * The headings the agenda leaves out, as org-agenda-skip does: those in a
 * subtree tagged ARCHIVE, or every one with ARCHIVE among the file's tags,
 * while org-agenda-skip-archived-trees is on, and those in a COMMENT
 * subtree while org-agenda-skip-comment-trees is.
 */
function skippedHeadings(all: Heading[]): boolean[] {
  // A heading is archived by the ARCHIVE tag itself, as org-element's :archivedp has it; a file by org-archive-tag among its FILETAGS.
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const archived = truthy(e8.variable("org-agenda-skip-archived-trees") ?? null) && archivesMode === null;
  const comments = e8.variable("org-agenda-skip-comment-trees") !== false && e8.variable("org-agenda-skip-comment-trees") !== null;
  const fileArchived = archived && keywordLines().some(([, , text]) => {
    const m = /^#\+FILETAGS:(.*)$/i.exec(text);
    return m !== null && m[1].split(/[:\s]+/).includes(tag);
  });
  const stack: { level: number; skip: boolean }[] = [];
  return all.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    const skip =
      fileArchived ||
      (stack.length > 0 && stack[stack.length - 1].skip) ||
      (archived && h.tags.includes("ARCHIVE")) ||
      (comments && /^COMMENT(?:[ \t]|$)/.test(h.title));
    stack.push({ level: h.level, skip });
    return skip;
  });
}

/**
 * The headings a tags, properties and TODO match picks in org-agenda-files,
 * as org-tags-view shows them, in the files' order. With `todoOnly`, only
 * those whose TODO state is not done.
 */
function tagsView(todoOnly: boolean, match?: string): void {
  lineTagType = "tags";
  if (match !== undefined && !/\S/.test(match)) match = undefined;
  // Read where org-agenda was called from, as org-make-tags-matcher reads it before the agenda is prepared.
  const matcher = makeTagsMatcher(match, todoOnly);
  const items: AgendaItem[] = [];
  for (const buffer of agendaBuffers()) {
    e8.withCurrentBuffer(buffer, () =>
      widened(() => {
        notOrg();
        const all = headings();
        const cats = categories(all);
        const skipped = skippedHeadings(all);
        const indented = e8.variable("org-tags-match-list-sublevels") === "indented";
        scanTags(
          (h) => {
            const i = headingIndex(all, h.line)!;
            if (skipped[i]) return;
            const cat = cats[i];
            // Dots for the level reduced with org-odd-levels-only, as org-scan-tags takes the element's.
            const prefix = indented ? ".".repeat(reducedLevel(h.level) - 1) : "";
            const item = { cat, leader: "", buffer, pos: h.start, heading: h.start };
            // No urgency, as org-scan-tags gives its lines none: they keep the files' order.
            items.push({ ...item, text: agendaLine(h, cat, "", false, undefined, prefix), urgency: 0 });
          },
          matcher,
          matcher.todoOnly,
        );
      }),
    );
  }
  const lines: { text: string; item?: AgendaItem }[] = [
    { text: `Headlines with TAGS match: ${matcher.match}` },
    { text: "Press \u2018C-u r\u2019 to search again" },
  ];
  for (const item of items) lines.push({ text: item.text, item });
  agendaView = { kind: "tags", todoOnly: matcher.todoOnly, match: matcher.match };
  showAgenda(lines, 0);
}

for (const [name, value, doc] of [
  [
    "org-agenda-search-view-always-boolean",
    false,
    "Whether the search view's string is always a Boolean search of words, \"quoted phrases\" and {regexps}, each needed, or with - not wanted; when nil, the default, it is one phrase unless it starts with +, - or {.",
  ],
  ["org-agenda-search-view-force-full-words", false, "Whether the search view's words match only whole words, not parts of words."],
  ["org-agenda-search-view-max-outline-level", 0, "The deepest level of heading the search view shows: a match deeper shows its heading at this level. 0, the default, for any."],
  ["org-agenda-text-search-extra-files", [], "Files the search view searches besides org-agenda-files."],
  ["org-agenda-search-history", [], "The strings searched for in the search view, most recent first."],
] as const) {
  e8.defineVariable({ name, value: value as unknown as e8.Value, doc });
}

/** Splits the search string into its words, a word ending in \ joined to the next and a {regexp} kept whole, as org-search-view does. */
function searchWords(string: string): string[] {
  // On the whitespace split-string's default takes, not every Unicode space.
  const split = string.split(/[ \f\t\n\r\v]+/).filter((w) => w !== "");
  const joined: string[] = [];
  while (split.length > 0) {
    let w = split.shift()!;
    while (/\\$/.test(w) && split.length > 0) w = `${w.slice(0, -1)} ${split.shift()}`;
    joined.push(w);
  }
  const words: string[] = [];
  while (joined.length > 0) {
    let w = joined.shift()!;
    if (/^[-+]?\{/.test(w) && !/\}$/.test(w)) {
      while (joined.length > 0 && !/\}$/.test(joined[0])) w = `${w} ${joined.shift()}`;
      w = `${w} ${joined.shift() ?? ""}`;
    }
    words.push(w);
  }
  return words;
}

/**
 * The entries in org-agenda-files, and org-agenda-text-search-extra-files,
 * a phrase or a Boolean search of words and regexps picks, as
 * org-search-view shows them. A string starting with * looks in headings
 * only, with ! at TODO entries not done only, as `todoOnly` does too, and
 * with : matches whole words. `editAt` asks for the string again with
 * point there, counting from 1, as [ and ] do.
 */
function searchView(todoOnlyArg: boolean, string?: string, editAt?: number): void {
  // The search view's items decide their tags as TODO items do.
  lineTagType = "todo";
  let todoOnly = todoOnlyArg;
  let fullWords = truthy(e8.variable("org-agenda-search-view-force-full-words"));
  if (editAt !== undefined || string === undefined || !/\S/.test(string)) {
    const prompt = truthy(e8.variable("org-agenda-search-view-always-boolean")) ? "[+-]Word/{Regexp} ...: " : "Phrase or [+-]Word/{Regexp} ...: ";
    const at = editAt;
    const place = () => {
      e8.removeHook("minibuffer-setup-hook", place);
      if (at !== undefined) e8.gotoChar(Math.min(e8.minibufferPromptEnd() + at - 1, e8.pointMax()));
    };
    if (at !== undefined) e8.addHook("minibuffer-setup-hook", place);
    try {
      string = e8.readString(prompt, { initial: editAt !== undefined ? string : undefined, history: "org-agenda-search-history" });
    } finally {
      e8.removeHook("minibuffer-setup-hook", place);
    }
  }
  const query = string;
  let words = query;
  let headlinesOnly = false;
  if (words.startsWith("*")) [headlinesOnly, words] = [true, words.slice(1)];
  if (words.startsWith("!")) [todoOnly, words] = [true, words.slice(1)];
  if (words.startsWith(":")) [fullWords, words] = [true, words.slice(1)];
  // Read in the agenda buffer, as org-agenda-prepare has made it current by then.
  const alwaysBoolean = e8.withCurrentBuffer(e8.getBufferCreate(AGENDA), () => truthy(e8.variable("org-agenda-search-view-always-boolean")));
  const boolean = alwaysBoolean || /^[-+{]/.test(words);
  let list = searchWords(words);
  if (boolean) {
    // "Quoted words" are one, with their spaces.
    const quoted: string[] = [];
    while (list.length > 0) {
      let w = list.shift()!;
      if (w.startsWith('"') || (w.length > 1 && "+-".includes(w[0]) && w[1] === '"')) {
        while (list.length > 0 && !w.endsWith('"')) w = `${w} ${list.shift()}`;
      }
      w = w.replace(/^([-+]?)"/, "$1");
      if (w.endsWith('"')) w = w.slice(0, -1);
      quoted.push(w);
    }
    list = quoted;
  }
  const plus: string[] = [];
  const minus: string[] = [];
  if (boolean) {
    for (let w of list) {
      let neg = false;
      if (w.startsWith("-")) [neg, w] = [true, w.slice(1)];
      else if (w.startsWith("+")) w = w.slice(1);
      const re = /^\{.*\}$/s.test(w) ? w.slice(1, -1) : fullWords ? `\\<${regexpQuote(w.toLowerCase())}\\>` : regexpQuote(w.toLowerCase());
      (neg ? minus : plus).unshift(re);
    }
  } else plus.push(list.map((w) => regexpQuote(w)).join("\\s-+"));
  // The longest searched for, the others checked in each entry it finds.
  plus.sort((a, b) => b.length - a.length);
  let regexp = "^\\*+ ";
  if (plus.length > 0) {
    regexp = plus.shift()!;
    if (headlinesOnly) regexp = `^\\*+ .*?${regexp}`;
  }
  const extra = e8.variable("org-agenda-text-search-extra-files");
  const extras = Array.isArray(extra) ? extra : [];
  // Led by agenda-archives, the agenda files' archive files too, as org-search-view adds them.
  const withArchives = extras[0] === "agenda-archives" || extras[0] === Symbol.for("agenda-archives");
  const files = (withArchives ? extras.slice(1) : extras).filter((f): f is string => typeof f === "string");
  const buffers = agendaBuffers(withArchives ? addArchiveFiles(agendaFilesIfMode()) : agendaFilesIfMode());
  for (const file of files) {
    const buffer = e8.findFileNoselect(e8.expandFileName(file));
    if (!buffers.includes(buffer)) buffers.push(buffer);
  }
  const items: AgendaItem[] = [];
  for (const buffer of buffers) {
    e8.withCurrentBuffer(buffer, () =>
      widened(() =>
        e8.saveExcursion(() => {
          notOrg();
          const all = headings();
          if (all.length === 0) return;
          const cats = categories(all);
          const skipped = skippedHeadings(all);
          const maxLevel = Number(e8.variable("org-agenda-search-view-max-outline-level") ?? 0);
          const tooDeep = (k: number) => maxLevel !== 0 && reducedLevel(all[k].level) > maxLevel;
          // Any line of the entry, ignoring case, as org-search-view matches it against the entry's text.
          const todoRegexp = `^\\*+[ \t]+${notDoneRegexp()}`;
          e8.gotoChar(Math.max(e8.pointMin(), all[0].start - 1));
          while (e8.reSearchForward(regexp, { noerror: true, caseFold: true }) !== undefined) {
            const lastSearchEnd = e8.point();
            let i = headingIndex(all, e8.lineOf(e8.point()));
            if (i === undefined) continue;
            while (i > 0 && tooDeep(i)) i--;
            const h = all[i];
            const beg = e8.lineStart(h.line);
            let next = i + 1;
            while (next < all.length && tooDeep(next)) next++;
            const end = all[next]?.start ?? e8.pointMax();
            if (skipped[i]) {
              // On from the end of the subtree, as org-agenda-skip goes there.
              let after = i + 1;
              while (after < all.length && all[after].level > h.level) after++;
              e8.gotoChar(Math.max(e8.point(), (all[after]?.start ?? e8.pointMax() + 1) - 1));
              continue;
            }
            const text = e8.bufferSubstringNoProperties(beg, headlinesOnly ? e8.lineEnd(h.line) : end);
            const has = (re: string) => e8.stringMatch(re, text, { caseFold: true }) !== undefined;
            const wanted = minus.every((re) => !has(re)) && plus.every(has) && (!todoOnly || has(todoRegexp));
            if (wanted) {
              const cat = cats[i];
              const item = { cat, leader: "", buffer, pos: h.start, heading: h.start };
              items.push({ ...item, text: agendaLine(h, cat, "", false), urgency: 1000 });
            }
            e8.gotoChar(Math.max(end - 1, lastSearchEnd));
          }
        }),
      ),
    );
  }
  const lines: { text: string; item?: AgendaItem }[] = [
    { text: `Search words: ${query}` },
    { text: "Press \u2018[\u2019, \u2018]\u2019 to add/sub word, \u2018{\u2019, \u2018}\u2019 to add/sub regexp, \u2018C-u r\u2019 for a fresh search" },
  ];
  for (const item of items) lines.push({ text: item.text, item });
  // The argument, not what ! made it, for C-u r, as the redo command is made before ! is read; the query's own for [ and ].
  agendaView = { kind: "search", todoOnly, todoOnlyArg, string: query, boolean };
  showAgenda(lines, 0);
}

/** Makes the agenda again, as org-agenda-redo does, with point on the same line. */
function redoAgenda(): void {
  e8.message("Rebuilding agenda buffer...");
  redoView();
  e8.message("Rebuilding agenda buffer...done");
}

function redoView(): void {
  const line = e8.lineOf(e8.point());
  if (agendaView.kind === "agenda") agendaList(agendaView.arg, agendaView.startDay, agendaView.span);
  // C-u r asks for the match again, as the tags view's redo command does.
  else if (agendaView.kind === "tags") tagsView(agendaView.todoOnly, e8.prefixArg() !== null && e8.prefixArg() !== undefined ? undefined : agendaView.match);
  // And the search view's, for the string.
  else if (agendaView.kind === "search") searchView(agendaView.todoOnlyArg, e8.prefixArg() !== null && e8.prefixArg() !== undefined ? undefined : agendaView.string);
  else todoList();
  e8.gotoChar(e8.lineStart(Math.min(line, e8.lineCount() - 1)));
}

/** A new agenda's archives mode, org-agenda-start-with-archives-mode, as org-agenda-mode sets it for each new agenda but not when it is made again. */
function freshAgenda(): void {
  // No filters unless org-agenda-persistent-filter keeps them, as org-agenda-prepare-window sets them; the top headline's stays, as there.
  if (!truthy(e8.variable("org-agenda-persistent-filter") ?? null)) for (const t of ["tag", "category", "regexp", "effort"] as const) agendaFilters[t] = [];
  followMode = truthy(e8.variable("org-agenda-start-with-follow-mode") ?? null);
  clockreportMode = truthy(e8.variable("org-agenda-start-with-clockreport-mode") ?? null);
  entryTextMode = truthy(e8.variable("org-agenda-start-with-entry-text-mode") ?? null);
  startLogMode();
  const start = e8.variable("org-agenda-start-with-archives-mode") ?? null;
  archivesMode = start === true ? true : truthy(start) ? "trees" : null;
}

const agendaListCommand = e8.defineCommand({
  name: "org-agenda-list",
  doc:
    "Show the agenda: what is scheduled, due and timestamped each day, from org-agenda-files, for the days org-agenda-span says. " +
    "With a numeric prefix argument, for that many days.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    freshAgenda();
    agendaList(arg ?? null);
  },
});

/**
 * The agenda for the days of the timestamp or date range at point, as
 * org-follow-timestamp-link opens it, in a buffer named after them: a
 * range's from its first day, whatever org-agenda-start-on-weekday says.
 */
e8.defun("org-follow-timestamp-link", () => {
  const dates = timestampDatesAt(e8.point());
  if (dates === undefined) return undefined;
  const day = (date: string) => dayNumber({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
  const [first, last] = [day(dates[0]), day(dates[dates.length - 1])];
  // A range that ends before it starts signals before anything is made, as org-agenda-list checks the span first.
  if (last < first) e8.userError(`Agenda creation impossible for this span(=${last - first + 1} days)`);
  freshAgenda();
  bufferTmpName = `*Org Agenda(a:${dates.join("--")})`;
  try {
    agendaList(null, first, last - first + 1, dates.length > 1 ? null : startOnWeekday());
  } finally {
    bufferTmpName = undefined;
  }
  return undefined;
});

const todoListCommand = e8.defineCommand({
  name: "org-todo-list",
  doc: "Show the TODO items that are not done in org-agenda-files, most urgent first.",
  run: () => {
    freshAgenda();
    todoList();
  },
});

const tagsViewCommand = e8.defineCommand({
  name: "org-tags-view",
  doc:
    "Show the headings in org-agenda-files a match picks: tags, properties and TODO states, as C-c \\ in Org reads it. " +
    "With a prefix argument, only those with a TODO state not done.",
  params: [{ name: "todoOnly", kind: "prefix" }],
  run: (todoOnly) => {
    freshAgenda();
    tagsView(todoOnly !== null && todoOnly !== undefined);
  },
});

const searchViewCommand = e8.defineCommand({
  name: "org-search-view",
  doc:
    "Show the entries in org-agenda-files that a phrase picks, or a Boolean search: words and {regexps} each needed, or with - " +
    "not wanted, \"quoted\" for spaces. Starting with * looks in headings only, ! at TODO entries only, : for whole words. " +
    "With a prefix argument, only TODO entries not done.",
  params: [{ name: "todoOnly", kind: "prefix" }],
  run: (todoOnly) => {
    freshAgenda();
    searchView(todoOnly !== null && todoOnly !== undefined);
  },
});

/**
 * Adds to the search view's string and asks for it again, as
 * org-agenda-manipulate-query: in a Boolean search, " +" or " -" for a
 * word, " +{}" or " -{}" for a regexp, with point inside the braces.
 */
function manipulateQuery(char: string): void {
  if (agendaView.kind === "agenda") {
    includeInactiveOnce();
    return;
  }
  if (agendaView.kind !== "search") {
    const type = agendaView.kind;
    throw new Error(`Cannot manipulate query for ${type}-type agenda buffers`);
  }
  const view = agendaView;
  // What earlier calls added and was not used.
  let string = view.string.replace(/(?: +| +[-+](?:\{\})?)$/, "");
  const added: Record<string, string> = { "[": " +", "]": " -", "{": " +{}", "}": " -{}" };
  string += view.boolean ? added[char] : " ";
  searchView(view.todoOnly, string, charCount(string) + (char === "{" || char === "}" ? 0 : 1));
}

const queryCommands = ([["add", "[", "a word"], ["subtract", "]", "a word not wanted"], ["add-re", "{", "a regexp"], ["subtract-re", "}", "a regexp not wanted"]] as const).map(
  ([name, char, what]) =>
    [
      char,
      e8.defineCommand({
        name: `org-agenda-manipulate-query-${name}`,
        doc: `Add ${what} to the search view's string, and ask for it again.`,
        run: () => manipulateQuery(char),
      }),
    ] as const,
);

const occurInAgendaFiles = e8.defineCommand({
  name: "org-occur-in-agenda-files",
  doc:
    "List the lines matching a regexp in every agenda file, and in org-agenda-text-search-extra-files, with the agenda files' archives " +
    "when that list starts with agenda-archives, in *Occur*, as multi-occur does, each file widened.",
  params: [{ name: "regexp", prompt: "Org-files matching: " }],
  run: (regexp: string) => {
    let files = agendaFiles();
    const truenames = files.map((f) => e8.fileTruename(f));
    const value = e8.variable("org-agenda-text-search-extra-files");
    let extra = Array.isArray(value) ? value : [];
    if (extra[0] === "agenda-archives" || extra[0] === Symbol.for("agenda-archives")) {
      extra = extra.slice(1);
      files = addArchiveFiles(files);
    }
    for (const f of extra) {
      if (typeof f !== "string") continue;
      const truename = e8.fileTruename(f);
      if (truenames.includes(truename)) continue;
      if (!files.includes(f)) files = [...files, f];
      truenames.push(truename);
    }
    const buffers = files.map((f) => {
      const buffer = e8.getFileBuffer(f) ?? e8.findFileNoselect(f);
      e8.withCurrentBuffer(buffer, () => e8.widen());
      return buffer;
    });
    multiOccur(buffers, regexp);
  },
});

e8.defineCommand({
  name: "org-occur-link-in-agenda-files",
  doc: "Make a link to here, as org-store-link does, and list its places in the agenda files and org-agenda-text-search-extra-files, as org-occur-in-agenda-files.",
  run: () => {
    // As Org's condition-case: the error's message stands for the link.
    const link = e8.conditionCase(() => storeLink(null, false), { error: () => "Unable to create a link to here" });
    if (typeof link !== "string") e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil");
    e8.call(occurInAgendaFiles, regexpQuote(link as string));
  },
});

e8.defineCommand({
  name: "org-agenda",
  doc:
    "Show an agenda view, asking which by its key in *Agenda Commands*: a for the week's agenda, t for the TODO list, m for the headings a tags match picks, " +
    "M for those with a TODO state not done, s for the entries a search picks, S for those with a TODO state not done.",
  run: () => {
    const key = agendaDispatch();
    freshAgenda();
    if (key === "a") e8.callWithPrefix(e8.prefixArg(), agendaListCommand);
    else if (key === "t") todoList();
    // With the prefix argument org-agenda had, as call-interactively hands on current-prefix-arg.
    else if (key === "m") e8.callWithPrefix(e8.prefixArg(), tagsViewCommand);
    else if (key === "M") e8.callWithPrefix(e8.prefixArg() ?? [4], tagsViewCommand);
    else if (key === "s") e8.callWithPrefix(e8.prefixArg(), searchViewCommand);
    else if (key === "S") e8.callWithPrefix(e8.prefixArg() ?? [4], searchViewCommand);
    else if (key === "/") e8.callInteractively(occurInAgendaFiles);
    else e8.userError(`E8 does not have that agenda view yet: ${key}`);
  },
});

/** The menu of agenda views, as org-agenda-get-restriction-and-command shows it. */
const DISPATCH_HEADER = `Press key for an agenda command:
--------------------------------        <   Buffer, subtree/region restriction
a   Agenda for current week or day      >   Remove restriction
/   Multi-occur                         e   Export agenda views
t   List of all TODO entries            T   Entries with special TODO kwd
m   Match a TAGS/PROP/TODO query        M   Like m, but only TODO entries
s   Search for keywords                 S   Like s, but only TODO entries
?   Find :FLAGGED: entries              C   Configure custom agenda commands
*   Toggle sticky agenda views          #   List stuck projects (!=configure)
`;

/** Asks for an agenda view by its key, showing the menu in *Agenda Commands*: q or C-g aborts. */
function agendaDispatch(): string {
  const name = "*Agenda Commands*";
  return e8.saveWindowExcursion(() => {
    e8.call("delete-other-windows");
    e8.call("switch-to-buffer-other-window", name);
    try {
      e8.letBind({ "inhibit-read-only": true }, () => {
        eraseBuffer();
        e8.insert(DISPATCH_HEADER);
        // The keys in bold, as Org shows them.
        const text = DISPATCH_HEADER;
        for (const m of allMatches(/(^|   |\()(\S)( |=)/gm, text)) {
          const at = charCount(text.slice(0, m.index + m[1].length));
          e8.putTextProperty(at, at + 1, "face", "bold");
        }
      });
      e8.gotoChar(0);
      e8.call("shrink-window-if-larger-than-buffer");
      const key = e8.readKey("Press key for agenda command:");
      if (key === "q" || key === "C-g") e8.userError("Abort");
      return key;
    } finally {
      if (e8.bufferList().includes(name)) e8.call("kill-buffer", name);
    }
  });
}

/** Writes the lines showing an entry again where they are, as org-agenda-change-all-lines does, rather than the agenda rebuilt. */
function redrawEntry(item: AgendaItem): void {
  const heading = headingOf(item);
  e8.withCurrentBuffer(agendaBuffer, () => e8.letBind({ "inhibit-read-only": true }, () => {
    // Point kept on its line and column, as org-agenda-change-all-lines keeps it with save-excursion and org-move-to-column.
    const pointLine = e8.lineOf(e8.point());
    const column = e8.point() - e8.lineStart(pointLine);
    for (const [l, other] of agendaLines.entries()) {
      if (!other || other.buffer !== item.buffer || headingOf(other) !== heading) continue;
      const text = e8.withCurrentBuffer(item.buffer, () => widened(() => {
        const h = headings().find((x) => x.start === heading);
        // Without the tags view's dots, as org-agenda-change-all-lines writes the line from the heading alone.
        // With the heading's timestamp, as org-agenda-change-all-lines formats it without org-agenda-format-item's remove-re.
        return h ? agendaLine(h, other.cat, other.leader, false, other.time, "", other.dotime) : other.text;
      }));
      other.text = text;
      e8.deleteRegion(e8.lineStart(l), e8.lineEnd(l));
      e8.gotoChar(e8.lineStart(l));
      e8.insert(text);
      // Dimmed or hidden again from its mark, as org-agenda-change-all-lines finalizes the line.
      if (truthy(e8.variable("org-agenda-dim-blocked-tasks") ?? null) && blockerHookSet()) dimLine(l, other);
    }
    e8.gotoChar(Math.min(e8.lineStart(pointLine) + column, e8.lineEnd(pointLine)));
  }));
}

/**
 * Runs a command at the heading of the entry the line at point shows, as
 * the agenda's commands do with org-agenda-with-point-at, then writes the
 * entry's lines again, its heading changed.
 */
function atEntry(command: e8.CommandName, interactive = true): void {
  const item = agendaItemHere();
  e8.withCurrentBuffer(item.buffer, () => {
    e8.saveExcursion(() => widened(() => {
      e8.gotoChar(headingOf(item));
      if (interactive) e8.callInteractively(command);
      else e8.call(command);
    }));
  });
  redrawEntry(item);
}

for (const [name, command, doc] of [
  ["org-agenda-clock-in", "org-clock-in", "Start a clock on the entry the agenda line at point shows."],
  ["org-agenda-set-tags", "org-set-tags-command", "Set the tags of the entry the agenda line at point shows."],
] as const) {
  e8.defineCommand({ name, doc, run: () => atEntry(command as e8.CommandName) });
}

/**
 * Changes the priority of the entry the line at point shows, as
 * org-agenda-priority: in the entry's buffer, as org-priority does there,
 * or with C-u saying it, then writes the entry's lines again.
 */
function agendaPriority(action: PriorityAction | "show" | "invalid"): void {
  if (!truthy(e8.variable("org-priority-enable-commands") ?? true)) e8.userError("Priority commands are disabled");
  const item = agendaItemHere();
  e8.withCurrentBuffer(item.buffer, () => {
    e8.saveExcursion(() => widened(() => {
      e8.gotoChar(headingOf(item));
      if (action === "show") showPriority();
      else if (action === "invalid") e8.userError("Invalid action");
      else setPriority(action);
    }));
  });
  redrawEntry(item);
}

e8.defineCommand({
  name: "org-agenda-priority",
  doc: "Set the priority of the entry the agenda line at point shows, to the key typed, or remove it with SPC. With C-u, say its priority.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.PrefixArg) => {
    if (Array.isArray(force) && force[0] === 4) agendaPriority("show");
    else if (typeof force === "number") agendaPriority(force);
    else if (force === null || force === undefined) agendaPriority("set");
    // C-u C-u or -, which org-priority takes as no action, after the agenda's checks.
    else agendaPriority("invalid");
  },
});
for (const [name, direction, doc] of [
  ["org-agenda-todo-nextset", 1, "Switch the entry the agenda line at point shows to the next set of TODO keywords."],
  ["org-agenda-todo-previousset", -1, "Switch the entry the agenda line at point shows to the previous set of TODO keywords."],
] as const) {
  e8.defineCommand({
    name,
    doc,
    run: () => {
      // As org-agenda-todo with nextset or previousset: in the entry's buffer, the line written again.
      const item = agendaItemHere();
      e8.withCurrentBuffer(item.buffer, () => widened(() => {
        e8.gotoChar(headingOf(item));
        todoToSet(direction);
      }));
      redrawEntry(item);
    },
  });
}
e8.defineCommand({ name: "org-agenda-priority-up", doc: "Raise the priority of the entry the agenda line at point shows.", run: () => agendaPriority("up") });
e8.defineCommand({ name: "org-agenda-priority-down", doc: "Lower the priority of the entry the agenda line at point shows.", run: () => agendaPriority("down") });
e8.defineCommand({ name: "org-agenda-clock-out", doc: "Stop the running clock, from the agenda.", run: () => e8.call("org-clock-out") });
e8.defineCommand({ name: "org-agenda-clock-cancel", doc: "Cancel the running clock, from the agenda.", run: () => e8.call("org-clock-cancel") });
e8.defineCommand({ name: "org-agenda-clock-goto", doc: "Go to the entry with the running clock, from the agenda.", run: () => e8.call("org-clock-goto") });

// org-store-link in the agenda links the line's entry, by its heading as org-hd-marker.
setAgendaEntryHere(() => {
  const item = agendaLines[e8.lineOf(e8.point())];
  return item && { buffer: item.buffer, pos: headingOf(item) };
});

/** The entry the agenda line at point shows, or Org's error if it shows none. */
function agendaItemHere(): AgendaItem {
  const item = agendaLines[e8.lineOf(e8.point())];
  if (!item) e8.userError("Command not allowed in this line");
  return item;
}

/** Whether the agenda ends with a clock table of its days, as org-agenda-clockreport-mode. */
let clockreportMode = false;

/** A value written as Lisp prints it, as org-create-dblock writes a block's parameters. */
function prin1(v: e8.Value): string {
  if (v === true) return "t";
  if (v === null || v === undefined || v === false) return "nil";
  if (typeof v === "symbol") return e8.symbolName(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `(${v.map(prin1).join(" ")})`;
  return String(v);
}

/**
 * The clock table of the agenda files from day START to before END, as
 * org-clock-get-clocktable makes it with org-agenda-clockreport-parameter-plist:
 * a dynamic block made and updated in an Org buffer of its own, and its
 * table, without the block's first line and caption.
 */
function clockReport(start: number, end: number): string {
  const given = e8.variable("org-agenda-clockreport-parameter-plist");
  const plist: e8.Value[] = Array.isArray(given) ? [...given] : [];
  // Keys as symbols, or as strings, as an E8 config may write them.
  const name = (x: e8.Value): string | undefined => (typeof x === "symbol" ? e8.symbolName(x) : typeof x === "string" ? x : undefined);
  const put = (key: string, value: e8.Value): void => {
    const i = plist.findIndex((x, k) => k % 2 === 0 && name(x) === key);
    if (i >= 0) plist[i + 1] = value;
    else plist.push(e8.intern(key), value);
  };
  const del = (key: string): void => {
    const i = plist.findIndex((x, k) => k % 2 === 0 && name(x) === key);
    if (i >= 0) plist.splice(i, 2);
  };
  // The agenda's days as absolute ones, as calendar-absolute-from-gregorian counts them.
  del(":block");
  put(":tstart", start + 719163);
  put(":tend", end + 719163);
  put(":scope", e8.intern("agenda"));
  if (!plist.some((x, k) => k % 2 === 0 && name(x) === ":maxlevel")) put(":maxlevel", 2);
  const params: string[] = [];
  for (let k = 0; k + 1 < plist.length; k += 2) params.push(`${name(plist[k]) ?? prin1(plist[k])} ${prin1(plist[k + 1])}`);
  // The agenda's files, archives too in their mode, as org-agenda-files 'ifmode.
  return e8.letBind({ "org-agenda-files": agendaFilesIfMode() }, () =>
    withTempBuffer(() => {
      e8.call("org-mode");
      e8.insert(`#+BEGIN: clocktable ${params.join(" ")}\n\n#+END:\n`);
      e8.gotoChar(0);
      updateDblock();
      const from = e8.lineStart(Math.min(2, e8.lineCount() - 1));
      let to = e8.bufferSize();
      for (let l = 2; l < e8.lineCount(); l++) {
        if (/^[ \t]*#\+END/i.test(e8.lineText(l))) {
          to = e8.lineStart(l);
          break;
        }
      }
      return e8.bufferText(from, to);
    }),
  );
}

const clockreportModeCommand = e8.defineCommand({
  name: "org-agenda-clockreport-mode",
  doc: "Toggle the agenda's clock report: a clock table of the time clocked in its days, at its end.",
  run: () => {
    checkAgendaType();
    clockreportMode = !clockreportMode;
    setModeName();
    redoAgenda();
    e8.message(`Clocktable mode is ${clockreportMode ? "on" : "off"}`);
  },
});

/** Whether the agenda shows some of each entry's text under its line, as org-agenda-entry-text-mode. */
let entryTextMode = false;

/** A line with its tabs made spaces to the next tab stop, by display columns, as untabify makes them with the default tab-width. */
function untabify(line: string): string {
  if (!line.includes("\t")) return line;
  const v = e8.defaultValue("tab-width");
  const width = typeof v === "number" && v > 0 ? v : 8;
  let out = "";
  let column = 0;
  for (const c of line) {
    if (c === "\t") {
      const n = width - (column % width);
      out += " ".repeat(n);
      column += n;
    } else {
      out += c;
      column += e8.charWidth(c.codePointAt(0) as number);
    }
  }
  return out;
}

/** A line's indentation, as current-indentation counts it. */
const indentationOf = (line: string): number => charCount(/^[ \t]*/.exec(untabify(line))![0]);

/**
 * Up to N_LINES lines of an entry's text, each after INDENT, as
 * org-agenda-get-some-entry-text gives them: from the line after its
 * heading to the next heading, without drawers, planning and clock lines
 * or what org-agenda-entry-text-exclude-regexps matches, the blank lines
 * at its end and the indentation its lines share.
 */
function someEntryText(heading: number, nLines: number, indent: string): string {
  const headLine = e8.lineOf(heading);
  const all = headings();
  const i = headingIndex(all, headLine);
  const next = all[i === undefined ? 0 : i + 1];
  const from = Math.min(e8.lineEnd(headLine) + 1, e8.bufferSize());
  let txt = e8.bufferText(from, next ? next.start : e8.bufferSize());
  // Drawers, to their :END: or the text's end.
  txt = txt.replace(/^[ \t]*:[-_\p{L}\p{N}]+:[ \t]*$[^]*?(?:^[ \t]*:END:.*\n?|(?![^]))/gimu, "");
  // Planning and clock lines, whatever their case, as the search in Org's temporary buffer has it.
  txt = txt.replace(/^[ \t]*(?<![\p{L}\p{N}])(?:CLOCK:|CLOSED:|DEADLINE:|SCHEDULED:) *[[<][^\]>]+[\]>].*\n?/gimu, "");
  const excluded = e8.variable("org-agenda-entry-text-exclude-regexps");
  if (Array.isArray(excluded)) {
    for (const re of excluded) {
      if (typeof re !== "string") continue;
      // Searched for again from where each match was taken out, as Org's
      // re-search-forward and replace-match go on in the changed text.
      const r = e8.emacsRegexp(re, { caseFold: true });
      const g = new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`);
      for (let from = 0; from <= txt.length; ) {
        g.lastIndex = from;
        const m = g.exec(txt);
        if (!m) break;
        txt = txt.slice(0, m.index) + txt.slice(m.index + m[0].length);
        // An empty match would be found again for ever, where Emacs's loop never ends: go on past it.
        from = m[0].length === 0 ? m.index + 1 : m.index;
      }
    }
  }
  txt = txt.replace(/[ \t\n]+$/, "");
  let lines = txt.split("\n").map(untabify);
  // The indentation the lines share, counting the first line's even if it is blank, as Org starts from it.
  let ind = indentationOf(lines[0] ?? "");
  for (const l of lines) if (!/^[ \t]*$/.test(l)) ind = Math.min(ind, indentationOf(l));
  lines = lines.map((l) => (/^[ \t]*$/.test(l) ? l : l.slice(ind)));
  txt = lines.join("\n");
  if (e8.isHook("org-agenda-entry-text-cleanup-hook")) {
    txt = withTempBuffer(() => {
      e8.insert(txt);
      e8.runHooks("org-agenda-entry-text-cleanup-hook");
      return e8.bufferText(e8.pointMin(), e8.pointMax());
    });
  }
  // Each line after the leader, then at most N_LINES of them.
  if (txt !== "") txt = txt.split("\n").map((l) => indent + l).join("\n");
  txt = txt.replace(/^(?:[ \t]*\n)+/, "");
  const kept = txt.split("\n");
  return kept.length > nLines ? kept.slice(0, nLines).join("\n") : txt;
}

/** A buffer of its own for F, killed after, as with-temp-buffer gives. */
function withTempBuffer<T>(f: () => T): T {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, f);
  } finally {
    e8.call("kill-buffer", name);
  }
}

/** Puts some of each line's entry text under it, as org-agenda-entry-text-show does, MAX_LINES each. */
function entryTextShow(maxLines: number): void {
  const leaders = e8.variable("org-agenda-entry-text-leaders");
  const indent = typeof leaders === "string" ? leaders : "";
  // No lines at all fails as Org's going back before the text's first line does.
  if (maxLines <= 0 && agendaLines.some((item) => item !== undefined)) e8.signal("beginning-of-buffer", "Beginning of buffer");
  e8.withCurrentBuffer(agendaBuffer, () => {
    agendaLines.forEach((item, line) => {
      if (item === undefined) return;
      const text = `\n${e8.withCurrentBuffer(item.buffer, () => widened(() => someEntryText(headingOf(item), maxLines, indent)))}`;
      if (!/\S/.test(text)) return;
      const o = e8.makeOverlay(e8.lineStart(line), e8.lineEnd(line));
      e8.overlayPut(o, "evaporate", true);
      e8.overlayPut(o, "org-overlay-type", e8.intern("agenda-entry-content"));
      e8.overlayPut(o, "after-string", text);
    });
  });
}

/** Takes away the entry text shown, as org-agenda-entry-text-hide. */
function entryTextHide(): void {
  e8.withCurrentBuffer(agendaBuffer, () => {
    for (const o of e8.overlaysIn(e8.pointMin(), e8.pointMax())) {
      const type = e8.overlayGet(o, "org-overlay-type");
      if (typeof type === "symbol" && e8.symbolName(type) === "agenda-entry-content") e8.deleteOverlay(o);
    }
  });
}

/** The maximum lines of entry text, org-agenda-entry-text-maxlines. */
function entryTextMaxlines(): number {
  const v = e8.variable("org-agenda-entry-text-maxlines");
  return typeof v === "number" ? v : 5;
}

const entryTextModeCommand = e8.defineCommand({
  name: "org-agenda-entry-text-mode",
  doc:
    "Toggle entry text mode: under each agenda line, some of its entry's text, at most org-agenda-entry-text-maxlines lines. " +
    "With a number, turn it on with that many lines.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    // Not with lines filtered out, but by effort, as Org's checks.
    if (agendaFilters.tag.length > 0 || agendaFilters.category.length > 0 || agendaFilters.regexp.length > 0 || topHeadlineFilter !== undefined) {
      e8.userError("Can\u2019t show entry text in filtered views");
    }
    const n = typeof arg === "number" ? arg : undefined;
    entryTextMode = n !== undefined || !entryTextMode;
    entryTextHide();
    if (entryTextMode) entryTextShow(n ?? entryTextMaxlines());
    setModeName();
    e8.message(`Entry text mode is ${entryTextMode ? "on" : "off"}${entryTextMode ? ` (maximum number of lines is ${n ?? entryTextMaxlines()})` : ""}`);
  },
});

/** Whether the agenda shows each line's entry in another window as point moves, as org-agenda-follow-mode. */
let followMode = false;
/** The windows before follow mode was turned on, put back when it is turned off. */
let preFollowWindows: e8.WindowConfiguration | undefined;

/** Shows the entry of the line point moved to, in follow mode, as org-agenda-do-context-action. */
function doContextAction(): void {
  if (followMode && agendaLines[e8.lineOf(e8.point())] !== undefined) agendaShow();
}

/** Shows the entry the line at point shows in another window, staying in the agenda, as org-agenda-show: with FULL_ENTRY, all of the entry. */
function agendaShow(fullEntry = false): void {
  const win = e8.selectedWindow();
  gotoItem();
  if (fullEntry) {
    const all = headings();
    const i = headingIndex(all, e8.lineOf(e8.point()));
    if (i !== undefined) showEntry(all, i);
  }
  e8.selectWindow(win);
}

const agendaNext = e8.defineCommand({
  name: "org-agenda-next-line",
  doc: "Move to the next line of the agenda, showing its entry in follow mode.",
  run: () => {
    e8.callWithPrefix(e8.prefixArg(), "next-line");
    doContextAction();
  },
});
const agendaPrevious = e8.defineCommand({
  name: "org-agenda-previous-line",
  doc: "Move to the previous line of the agenda, showing its entry in follow mode.",
  run: () => {
    e8.callWithPrefix(e8.prefixArg(), "previous-line");
    doContextAction();
  },
});

e8.defineCommand({
  name: "org-agenda-show",
  doc: "Show the entry the agenda line at point shows in another window, staying in the agenda; with C-u, all of the entry.",
  params: [{ name: "fullEntry", kind: "prefix" }],
  run: (fullEntry) => agendaShow(fullEntry !== null && fullEntry !== undefined),
});

const logModeCommand = e8.defineCommand({
  name: "org-agenda-log-mode",
  doc:
    "Toggle log mode: the agenda shows what was closed and clocked each day, as org-agenda-log-mode-items says. " +
    "With C-u, every kind, state changes too; with C-u C-u, only what was logged.",
  params: [{ name: "special", kind: "prefix" }],
  run: (special) => setLogMode(special),
});

/** Sets log mode as org-agenda-log-mode's SPECIAL says, rebuilds the agenda and says so. */
function setLogMode(special: e8.PrefixArg | "clockcheck" | null | undefined): void {
  checkAgendaType();
  if (special === "clockcheck") showLog = showLog === "clockcheck" ? null : "clockcheck";
  else if (Array.isArray(special) && special[0] === 16) showLog = "only";
  else if (special !== null && special !== undefined) showLog = ["closed", "clock", "state"];
  else showLog = showLog === null ? true : null;
  setModeName();
  redoAgenda();
  e8.message(`Log mode is ${showLog !== null ? "on" : "off"}`);
}

const followModeCommand = e8.defineCommand({
  name: "org-agenda-follow-mode",
  doc: "Toggle follow mode: moving to a line with n or p shows its entry in another window. Turning it off puts the windows back.",
  run: () => {
    if (!followMode) preFollowWindows = e8.currentWindowConfiguration();
    followMode = !followMode;
    if (!followMode && preFollowWindows !== undefined) e8.setWindowConfiguration(preFollowWindows);
    setModeName();
    doContextAction();
    e8.message(`Follow mode is ${followMode ? "on" : "off"}`);
  },
});

/** The agenda line of the next or previous item after point's, as org-agenda-next-item and org-agenda-previous-item find it, or undefined. */
function itemLineFrom(line: number, step: 1 | -1): number | undefined {
  for (let l = line + step; l >= 0 && l < agendaLines.length; l += step) if (agendaLines[l] !== undefined) return l;
  return undefined;
}

/** Moves N items on, or back with STEP -1, keeping the column, as org-agenda-next-item does, then follows; a count below one moves nowhere, as its dotimes. */
function moveByItems(n: number, step: 1 | -1): void {
  const column = e8.currentColumn();
  for (let k = 0; k < n; k++) {
    const to = itemLineFrom(e8.lineOf(e8.point()), step);
    if (to !== undefined) e8.gotoChar(e8.lineStart(to));
  }
  e8.moveToColumn(column);
  doContextAction();
}

e8.defineCommand({
  name: "org-agenda-next-item",
  doc: "Move to the next line of the agenda that shows an entry, keeping the column.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => moveByItems(n, 1),
});
e8.defineCommand({
  name: "org-agenda-previous-item",
  doc: "Move to the previous line of the agenda that shows an entry, keeping the column.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => moveByItems(n, -1),
});

e8.defineCommand({
  name: "org-agenda-show-tags",
  doc: "Say the tags of the entry the agenda line at point shows, inherited ones too as the agenda shows them.",
  run: () => {
    const item = agendaLines[e8.lineOf(e8.point())];
    const tags = item === undefined ? [] : lineTags(item);
    e8.message(tags.length > 0 ? `Tags are :${tags.join(":")}:` : "No tags associated with this line");
  },
});

// Filtering the agenda's lines, after org-agenda.el's org-agenda-filter and
// its kin: lines that fail a filter are hidden with the invisible property
// org-filtered, as org-agenda-filter-hide-line hides them, until the filter
// is removed.

/** The kinds of filter that org-agenda-filter-variables lists, and the top headline's. */
type FilterType = "tag" | "category" | "regexp" | "effort";

/** The filters in force, each a list of +X and -X, as org-agenda-tag-filter and its kin hold them. */
const agendaFilters: Record<FilterType, string[]> = { tag: [], category: [], regexp: [], effort: [] };
/** The presets of the agenda being shown, as org-agenda-filters-preset, read from org-agenda-tag-filter-preset and its kin. */
let filterPresets: Record<FilterType, string[]> = { tag: [], category: [], regexp: [], effort: [] };
/** The top headline whose lines are kept, as org-agenda-top-headline-filter. */
let topHeadlineFilter: string | undefined;
/** Whether < filtered to the category at point, as org-agenda-filtered-by-category, so that < again removes it. */
let filteredByCategory = false;
/** Whether ^ filtered by top headline, as org-agenda-filtered-by-top-headline, so that ^ again removes it. */
let filteredByTopHeadline = false;
/** The tags and categories of the agenda's lines, as org-agenda-represented-tags and -categories keep them until it is made again. */
let representedTagsCache: string[] | undefined;
let representedCategoriesCache: string[] | undefined;

e8.defineVariable({ name: "org-agenda-persistent-filter", doc: "Whether filters stay from one agenda view to the next.", value: false });
e8.defineHook("org-agenda-filter-hook", "Run just after filtering with org-agenda-filter.");
e8.defineVariable({
  name: "org-agenda-auto-exclude-function",
  doc:
    "A function given each tag of the agenda's lines, which returns \"-TAG\" to hide the lines with it, or nil, " +
    "for RET in the tag filter and C-u C-u C-u / to use.",
  value: null,
});
e8.defineVariable({
  name: "org-agenda-sort-noeffort-is-high",
  doc: "Whether an entry with no effort counts as taking very long, rather than no time, when sorting and filtering by effort.",
  value: true,
});
for (const type of ["tag", "category", "regexp", "effort"] as const) {
  e8.defineVariable({
    name: `org-agenda-${type}-filter-preset`,
    doc: `A ${type} filter every agenda starts with, a list of strings each starting with + or -, as agenda custom commands bind it.`,
    value: [],
  });
}

/** A list variable's strings. */
const stringList = (v: e8.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Reads the presets, as org-agenda-prepare sets org-agenda-filters-preset for each agenda it makes. */
function readFilterPresets(): void {
  filterPresets = {
    tag: stringList(e8.variable("org-agenda-tag-filter-preset")),
    category: stringList(e8.variable("org-agenda-category-filter-preset")),
    regexp: stringList(e8.variable("org-agenda-regexp-filter-preset")),
    effort: stringList(e8.variable("org-agenda-effort-filter-preset")),
  };
}

/** Whether any filter but the top headline's is in force, as org-agenda-filter-any. */
function filterAny(): boolean {
  return (["category", "tag", "effort", "regexp"] as const).some((t) => agendaFilters[t].length > 0 || filterPresets[t].length > 0);
}

/** What the mode name says of the filters, as org-agenda-set-mode-name writes them: [categories], tags, efforts and /regexps/. */
function filterModeName(): string {
  const all = (t: FilterType) => [...filterPresets[t], ...agendaFilters[t]];
  const cats = all("category");
  return (
    (filterAny() ? " " : "") +
    (cats.length > 0 ? `[${cats.join("")}]` : "") +
    all("tag").join("") +
    all("effort").join("") +
    all("regexp").map((x) => `${x[0]}/${x.slice(1)}/`).join("")
  );
}

/** The headings of the current buffer, and the index of an agenda line's entry's heading among them, found by halving. */
function itemHeading(item: AgendaItem): { all: Heading[]; i: number } | undefined {
  const all = headings();
  const pos = headingOf(item);
  const i = headingIndex(all, e8.lineOf(pos));
  return i === undefined || all[i].start !== pos ? undefined : { all, i };
}

/**
 * The tags of an agenda line's entry, as its tags property holds them:
 * all of them, inherited ones too, as org-agenda-finalize puts them
 * unless org-agenda-show-inherited-tags keeps what the item maker took,
 * which for the tags view is all of them too.
 */
function lineTags(item: AgendaItem): string[] {
  const view = agendaView.kind;
  const show = e8.variable("org-agenda-show-inherited-tags");
  const use = e8.variable("org-agenda-use-tag-inheritance");
  const showName = typeof show === "symbol" ? e8.symbolName(show) : show;
  // As org-agenda-finalize's test, use's list not naming the view among it.
  const kept = showName === "always" || names(show, view) || (show === true && (use === true || (isList(use) && !names(use, view))));
  const all = !kept || takesInheritedTags(item.tagType ?? "agenda");
  return e8.withCurrentBuffer(item.buffer, () =>
    widened(() => {
      const found = itemHeading(item);
      if (found === undefined) return [];
      const h = found.all[found.i];
      return all ? [...inheritedTags(h), ...h.tags] : h.tags;
    }),
  );
}

/** An agenda line's text after its prefix: the heading as the line shows it, with its tags, as the line's txt property. */
function lineTxt(item: AgendaItem, line: number): string {
  const prefix = `  ${(item.cat === "" ? "" : `${item.cat}:`).padEnd(12)}${item.time === undefined ? "" : `${item.time.field.padEnd(11)} `}${item.leader === "" ? "" : `${item.leader} `}`;
  return e8.lineText(line).slice(prefix.length);
}

/** The effort of an agenda line's entry in minutes, as its txt's effort-minutes property, or undefined; the search view's lines have none. */
function lineEffort(item: AgendaItem): number | undefined {
  if (agendaView.kind === "search") return undefined;
  return e8.withCurrentBuffer(item.buffer, () =>
    widened(() => {
      const found = itemHeading(item);
      const effort = found && entryGet(found.all[found.i].line, String(e8.variable("org-effort-property") ?? "Effort"));
      if (effort === undefined) return undefined;
      try {
        return durationToMinutes(effort);
      } catch {
        return undefined;
      }
    }),
  );
}

/** The title of the topmost heading above an agenda line's entry, without a statistics cookie at its start, as org-find-top-headline. */
function topHeadlineOf(item: AgendaItem): string | undefined {
  return e8.withCurrentBuffer(item.buffer, () =>
    widened(() => {
      const found = itemHeading(item);
      if (found === undefined) return undefined;
      const { all } = found;
      let i = found.i;
      // Up through each parent, as org-up-heading-safe climbs while it can.
      for (let k = i - 1; k >= 0 && all[i].level > 1; k--) if (all[k].level < all[i].level) i = k;
      return all[i].title.replace(/^\[[0-9]+\/[0-9]+\] *|^\[%[0-9]+\] */, "");
    }),
  );
}

/** The tag groups of the agenda files, as org-tag-groups-alist-for-agenda merges them. */
function agendaTagGroups(): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const file of agendaFiles()) {
    e8.withCurrentBuffer(e8.findFileNoselect(file), () => {
      for (const [key, members] of tagGroups()) {
        const old = out.find(([k]) => k === key);
        if (old) old[1] = [...new Set([...old[1], ...members])];
        else out.unshift([key, members]);
      }
    });
  }
  return out;
}

/** The tags of the agenda files with their selection keys, as org-tag-alist-for-agenda gathers them. */
function agendaTagAlist(): TagEntry[] {
  let alist: TagEntry[] = [];
  for (const file of agendaFiles()) e8.withCurrentBuffer(e8.findFileNoselect(file), () => (alist = tagAddToAlist(currentTagAlist(), alist)));
  return alist;
}

/** The lines of the agenda with entries, and the entries, as Org's filters walk the lines that have org-hd-marker or org-marker. */
function itemLines(): [number, AgendaItem][] {
  const out: [number, AgendaItem][] = [];
  agendaLines.forEach((item, line) => item !== undefined && out.push([line, item]));
  return out;
}

/** The tags of the agenda's lines, each once, and the groups any of them is in, as org-agenda-get-represented-tags. */
function representedTags(): string[] {
  if (representedTagsCache === undefined) {
    const tags = [...new Set(itemLines().flatMap(([, item]) => lineTags(item)))];
    const groups = truthy(e8.variable("org-group-tags")) ? agendaTagGroups() : [];
    for (const tag of [...tags]) for (const [key, members] of groups) if (key === tag || members.includes(tag)) tags.unshift(key);
    representedTagsCache = tags;
  }
  return representedTagsCache;
}

/** The categories of the agenda's lines, each once, one with a hyphen in quotes, as org-agenda-get-represented-categories. */
function representedCategories(): string[] {
  representedCategoriesCache ??= [...new Set(itemLines().map(([, item]) => item.cat))].map((c) => (c.includes("-") ? `"${c}"` : c));
  return representedCategoriesCache;
}

/** Whether case is ignored in the agenda's regexps, as case-fold-search there says. */
const foldCase = (): boolean => truthy(e8.variable("case-fold-search") ?? null);

/** A tag filter's tags with each group's tags, as org-agenda-filter-expand-tags does with no operator. */
function expandTags(x: string): string[] {
  if (!truthy(e8.variable("org-group-tags"))) return [x];
  const m = /^([+-])(.+)/.exec(x);
  const [dir, tag] = m ? [m[1], m[2]] : ["", x];
  return tagsExpandGroup([tag], agendaTagGroups(), []).map((t) => dir + t);
}

/**
 * The test of a line for FILTER of TYPE, with the preset of its type, as
 * org-agenda-filter-make-matcher makes the form: every element must pass,
 * but with two categories to keep, either may.
 */
function filterMatcher(filter: string[], type: FilterType, expand: boolean): (item: AgendaItem, line: number) => boolean {
  const all = [...new Set([...filterPresets[type], ...filter])];
  if (type === "tag") {
    const tests = all.map((x) => {
      const neg = x[0] === "-";
      const tags = (expand ? expandTags(x) : [x]).map((t) => t.slice(1));
      const one = (t: string, have: string[]) =>
        t === "" ? have.length > 0 : /^\{.*\}$/.test(t) ? have.some((h) => e8.stringMatch(t.slice(1, -1), h, { caseFold: foldCase() }) !== undefined) : have.includes(t);
      // Any of the tags for +, none of them for -, as org-agenda-filter-make-matcher-tag-exp.
      return (have: string[]) => (neg ? tags.every((t) => !one(t, have)) : tags.some((t) => one(t, have)));
    });
    return (item) => {
      const have = lineTags(item);
      return tests.every((t) => t(have));
    };
  }
  if (type === "category") {
    // Either of two categories, as multi-pos-cats looks at the filter before the preset joins it.
    const multiPos = filter.filter((x) => x[0] === "+").length > 1;
    const tests = all.map((x) => (cat: string) => (x[0] === "-" ? cat !== x.slice(1) : cat === x.slice(1)));
    return (item) => (multiPos ? tests.some((t) => t(item.cat)) : tests.every((t) => t(item.cat)));
  }
  if (type === "regexp") {
    const tests = all.map((x) => (txt: string) => (e8.stringMatch(x.slice(1), txt, { caseFold: foldCase() }) !== undefined) !== (x[0] === "-"));
    return (item, line) => {
      const txt = lineTxt(item, line);
      return tests.every((t) => t(txt));
    };
  }
  // Effort: the sign is dropped, as org-agenda-filter-effort-form drops it, so a - condition keeps what it matches too.
  const tests = all.map((x) => {
    const op = x[1];
    const value = durationToMinutes(x.slice(2));
    return (effort: number) => (op === "<" ? effort <= value : op === ">" ? effort >= value : effort === value);
  });
  return (item) => {
    const effort = lineEffort(item) ?? (truthy(e8.variable("org-agenda-sort-noeffort-is-high") ?? null) ? 32767 : -1);
    return tests.every((t) => t(effort));
  };
}

/** Hides agenda line L and the newline before it, as org-agenda-filter-hide-line does, marked with TYPE. */
function hideLine(l: number, type: FilterType | "top-headline"): void {
  const start = Math.max(e8.pointMin(), e8.lineStart(l) - 1);
  e8.letBind({ "inhibit-read-only": true }, () => {
    e8.putTextProperty(start, e8.lineEnd(l), "invisible", "org-filtered");
    e8.putTextProperty(start, e8.lineEnd(l), "org-filter-type", type);
  });
}

/**
 * Moves off a line just hidden, as Org's filters go to the previous line
 * when point is on one, calling it interactively, so with the filter's own
 * prefix argument; errors ignored unless SIGNAL, as the top headline's
 * filter does not ignore them.
 */
function leaveHiddenLine(signal = false): void {
  if (e8.getTextProperty(e8.point(), "invisible") === undefined) return;
  try {
    e8.callWithPrefix(e8.prefixArg() ?? null, "org-agenda-previous-line");
  } catch (e) {
    if (signal) throw e;
  }
}

/** Applies FILTER of TYPE to the agenda's lines, hiding those that fail it, as org-agenda-filter-apply; entry text mode goes off first. */
function filterApply(filter: string[], type: FilterType, expand = false): void {
  if (entryTextMode) e8.call("org-agenda-entry-text-mode");
  const test = filterMatcher(filter, type, expand);
  // Set only when one category is kept, as org-agenda-filter-apply sets it from the filter's first element.
  filteredByCategory = type === "category" && filter[0]?.[0] !== "-";
  setModeName();
  for (const [line, item] of itemLines()) if (!test(item, line)) hideLine(line, type);
  leaveHiddenLine();
}

/** Hides the lines not under top headline HL, or with NEGATIVE those under it, as org-agenda-filter-top-headline-apply. */
function topHeadlineApply(hl: string, negative = false): void {
  setModeName();
  for (const [line, item] of itemLines()) {
    const top = topHeadlineOf(item);
    if (top !== undefined && (negative ? top === hl : top !== hl)) hideLine(line, "top-headline");
  }
  leaveHiddenLine(true);
  topHeadlineFilter = hl;
  filteredByTopHeadline = true;
}

/** Applies every filter in force, as org-agenda-finalize does when the agenda is made or a filter removed. */
function reapplyFilters(): void {
  representedTagsCache = undefined;
  representedCategoriesCache = undefined;
  if (topHeadlineFilter !== undefined) topHeadlineApply(topHeadlineFilter);
  if (agendaFilters.tag.length > 0) filterApply(agendaFilters.tag, "tag", true);
  if (filterPresets.tag.length > 0) filterApply(filterPresets.tag, "tag", true);
  if (agendaFilters.category.length > 0) filterApply(agendaFilters.category, "category");
  if (filterPresets.category.length > 0) filterApply(filterPresets.category, "category");
  if (agendaFilters.regexp.length > 0) filterApply(agendaFilters.regexp, "regexp");
  if (filterPresets.regexp.length > 0) filterApply(filterPresets.regexp, "regexp");
  if (agendaFilters.effort.length > 0) filterApply(agendaFilters.effort, "effort");
  if (filterPresets.effort.length > 0) filterApply(filterPresets.effort, "effort");
}

/** Finishes the agenda again after a filter is removed, as org-agenda-finalize: its entry text, and the filters left. */
function refinalize(): void {
  // Links' brackets and blocked lines hidden again, as org-agenda-finalize activates links and dims blocked tasks, which a filter's removal showed.
  e8.letBind({ "inhibit-read-only": true }, () => {
    if (linksDescriptive()) agendaLines.forEach((_item, line) => hideLinksOn(line));
  });
  agendaLines.forEach((item, line) => dimLine(line, item));
  if (entryTextMode) {
    entryTextHide();
    entryTextShow(entryTextMaxlines());
  }
  reapplyFilters();
}

/** Shows the lines a filter of TYPE hid and drops the filter, as org-agenda-remove-filter, then finishes the agenda again. */
function removeFilter(type: FilterType | "top-headline"): void {
  e8.letBind({ "inhibit-read-only": true }, () => {
    let pos: number | undefined;
    while ((pos = e8.textPropertyAny(e8.pointMin(), e8.pointMax(), "org-filter-type", type)) !== undefined) {
      const end = e8.nextSinglePropertyChange(pos, "org-filter-type") ?? e8.pointMax();
      e8.removeTextProperty(pos, end, "invisible");
      e8.removeTextProperty(pos, end, "org-filter-type");
    }
  });
  if (type === "top-headline") topHeadlineFilter = undefined;
  else agendaFilters[type] = [];
  setModeName();
  refinalize();
}

/** The agenda line's item at point, or undefined. */
const itemHere = (): AgendaItem | undefined => agendaLines[e8.lineOf(e8.point())];

/** A character read as read-char-exclusive gives it, a key such as TAB as its character. */
const readCharString = (prompt?: string): string => {
  const c = keyChar(e8.readCharExclusive(prompt));
  return c < 0 ? "" : String.fromCodePoint(c);
};

/** Whether a prefix argument is C-u pressed N times, as (equal arg '(4)) and its kin test. */
const isUniversal = (arg: e8.PrefixArg | null | undefined, n: number): boolean => Array.isArray(arg) && arg[0] === 4 ** n;

e8.defineCommand({
  name: "org-agenda-filter-by-category",
  doc: "Keep only the agenda lines of the category of the line at point; with C-u, hide those instead. Pressed again, show every line.",
  params: [{ name: "strip", kind: "prefix" }],
  run: (strip) => {
    if (filteredByCategory && agendaFilters.category.length > 0) return removeFilter("category");
    const cat = itemHere()?.cat;
    if (cat === undefined) e8.signal("error", "No category at point");
    if (strip !== null && strip !== undefined) agendaFilters.category.unshift(`-${cat}`);
    else agendaFilters.category = [`+${cat}`];
    filterApply(agendaFilters.category, "category");
  },
});

e8.defineCommand({
  name: "org-agenda-filter-by-top-headline",
  doc: "Keep only the agenda lines under the same top headline as the line at point; with C-u, hide those instead. Pressed again, show every line.",
  params: [{ name: "strip", kind: "prefix" }],
  run: (strip) => {
    if (filteredByTopHeadline) {
      filteredByTopHeadline = false;
      topHeadlineFilter = undefined;
      return removeFilter("top-headline");
    }
    const item = itemHere();
    const top = item && topHeadlineOf(item);
    if (top === undefined) e8.signal("error", "No top-level headline at point");
    topHeadlineApply(top, strip !== null && strip !== undefined);
  },
});

e8.defineCommand({
  name: "org-agenda-filter-by-regexp",
  doc:
    "Keep only the agenda lines matching a regexp; with C-u, hide those instead. With a regexp filter in force, remove it, " +
    "or with C-u C-u add another regexp to it.",
  params: [{ name: "strip", kind: "prefix" }],
  run: (arg) => {
    const strip = isUniversal(arg, 1);
    if (agendaFilters.regexp.length > 0 && !isUniversal(arg, 2)) {
      removeFilter("regexp");
      e8.message("Regexp filter removed");
      return;
    }
    const flt = e8.readString(strip ? "Hide entries matching regexp: " : "Narrow to entries matching regexp: ");
    agendaFilters.regexp.unshift(`${strip ? "-" : "+"}${flt}`);
    filterApply(agendaFilters.regexp, "regexp");
  },
});

/** The efforts to choose from, Effort_ALL in org-global-properties or Org's own, as org-agenda-filter-by-effort lists them. */
function effortValues(): string[] {
  const key = `${String(e8.variable("org-effort-property") ?? "Effort")}_ALL`.toLowerCase();
  const props = e8.variable("org-global-properties");
  const own = Array.isArray(props) ? props.find((e) => Array.isArray(e) && typeof e[0] === "string" && e[0].toLowerCase() === key) : undefined;
  const value = Array.isArray(own) && typeof own[1] === "string" ? own[1] : "0 0:10 0:30 1:00 2:00 3:00 4:00 5:00 6:00 7:00";
  return value.split(/[ \f\t\n\r\v]+/).filter((s) => s !== "");
}

e8.defineCommand({
  name: "org-agenda-filter-by-effort",
  doc:
    "Keep only the agenda lines whose effort is below, above or equal to one chosen with a digit; _ again removes the filter. " +
    "With C-u C-u, add the condition to those in force.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const efforts = effortValues();
    const allowed = efforts.map((_e, i) => (i + 1) % 10);
    const keep = isUniversal(arg, 2);
    const negative = isUniversal(arg, 1);
    const current = agendaFilters.effort;
    let op = "";
    while (!["<", ">", "=", "_"].includes(op)) op = readCharString("Effort operator? (> = or <)     or press `_' again to remove filter");
    if (op === "_") {
      removeFilter("effort");
      e8.message("Effort filter removed");
      return;
    }
    const prompt = `Effort ${op} ${efforts.map((s, i) => `[${allowed[i]}]${s}`).join(" ")}`;
    let eff = -1;
    while (!allowed.includes(eff)) {
      e8.message(prompt);
      eff = keyChar(e8.readCharExclusive()) - 48;
    }
    removeFilter("effort");
    agendaFilters.effort = [`${negative ? "-" : "+"}${op}${efforts[(((eff - 1) % 10) + 10) % 10]}`, ...(keep ? current : [])];
    filterApply(agendaFilters.effort, "effort");
  },
});

/** Hides the lines with the tags org-agenda-auto-exclude-function names, as RET in the tag filter does. */
function autoExclude(fn: e8.Value, expand: boolean): void {
  agendaFilters.tag = [];
  for (const tag of representedTags()) {
    const modifier = e8.funcall(fn as string, tag);
    if (typeof modifier === "string") agendaFilters.tag.unshift(modifier);
  }
  if (agendaFilters.tag.length > 0) filterApply(agendaFilters.tag, "tag", expand);
}

/** Completes the parts of a filter after its last operator, categories and tags or efforts, as org-agenda-filter-completion-function. */
function filterCompletions(input: string): string[] {
  const m = /^(.*([-+<>=]))[^-+<>=]*$/s.exec(input);
  const [prefix, operator] = m ? [m[1], m[2]] : ["", ""];
  const table = ["<", ">", "="].includes(operator) ? effortValues() : [...representedCategories(), ...representedTags()];
  return table.map((t) => prefix + t);
}

/** Adds X to the end of LIST unless it is there, as org-pushnew-to-end. */
const pushnewToEnd = (x: string, list: string[]): void => void (list.includes(x) || list.push(x));

e8.defineCommand({
  name: "org-agenda-filter",
  doc:
    "Filter the agenda by a string of +category, +tag, +<effort and +/regexp/, each with - instead to hide what matches. " +
    "With C-u, the other way round; with C-u C-u, or a string starting with + and + or -, added to the filters in force; " +
    "with C-u C-u C-u, hide the tags org-agenda-auto-exclude-function names.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    if (isUniversal(arg, 3)) {
      const fn = e8.variable("org-agenda-auto-exclude-function") ?? null;
      if (!truthy(fn)) e8.userError("‘org-agenda-auto-exclude-function’ is undefined");
      removeFilter("tag");
      autoExclude(fn, true);
      return;
    }
    const tagList = representedTags();
    const categoryList = representedCategories();
    const negate = isUniversal(arg, 1);
    const rf = (agendaFilters.regexp[0] ?? "").replace(/^\+/, "");
    const ff =
      agendaFilters.category.join("") + agendaFilters.tag.join("") + (agendaFilters.effort[0] ?? "").replace(/^\+/, "") + (rf === "" ? "" : `/${rf}/`);
    let f = e8.completingRead(`${negate ? "Negative filter" : "Filter"} [+cat-tag<0:10-/regexp/]: `, filterCompletions, { initial: ff });
    let keep = isUniversal(arg, 2);
    if (/^\+[+-]/.test(f)) {
      f = f.slice(1);
      keep = true;
    }
    const fc = keep ? [...agendaFilters.category] : [];
    const ft = keep ? [...agendaFilters.tag] : [];
    const fe = keep ? [...agendaFilters.effort] : [];
    const fr = keep ? [...agendaFilters.regexp] : [];
    // A hyphen in double quotes is part of the name, not an operator.
    f = f.replace(/"([^"]*)-([^"]*)"/g, '"$1~~~$2"');
    const part = /^[ \t]*([-+])?(([^-+<>=/ \t]+)|([<>=][0-9:]+)|(\/([^/]+)\/?))/;
    for (let m = part.exec(f); m !== null; m = part.exec(f)) {
      let pm = m[1] ?? "+";
      if (negate) pm = pm === "+" ? "-" : "+";
      if (m[3] !== undefined) {
        const s = m[3].replace(/~~~/g, "-");
        if (tagList.includes(s)) pushnewToEnd(pm + s, ft);
        else if (categoryList.includes(s)) pushnewToEnd(pm + s.replace(/"(.*)"/, "$1"), fc);
        else e8.message(`‘${pm}${s}’ filter ignored because tag/category is not represented`);
      } else if (m[4] !== undefined) pushnewToEnd(pm + m[4], fe);
      else pushnewToEnd(pm + m[6], fr);
      f = f.slice(m[0].length);
    }
    removeAllFilters();
    if (fc.length > 0) filterApply((agendaFilters.category = fc), "category");
    if (ft.length > 0) filterApply((agendaFilters.tag = ft), "tag", true);
    if (fe.length > 0) filterApply((agendaFilters.effort = fe), "effort");
    if (fr.length > 0) filterApply((agendaFilters.regexp = fr), "regexp");
    e8.runHooks("org-agenda-filter-hook");
  },
});

/** Removes every filter, as org-agenda-filter-remove-all, and finishes the agenda again. */
function removeAllFilters(): void {
  if (agendaFilters.tag.length > 0) removeFilter("tag");
  if (agendaFilters.category.length > 0) removeFilter("category");
  if (agendaFilters.regexp.length > 0) removeFilter("regexp");
  if (topHeadlineFilter !== undefined) removeFilter("top-headline");
  if (agendaFilters.effort.length > 0) removeFilter("effort");
  refinalize();
}

e8.defineCommand({
  name: "org-agenda-filter-remove-all",
  doc: "Remove every filter from the agenda.",
  run: () => {
    removeAllFilters();
    if (e8.calledInteractively()) e8.message("All agenda filters removed");
  },
});

e8.defineCommand({
  name: "org-agenda-filter-by-tag",
  doc:
    "Keep only the agenda lines with a tag chosen by its key, or with TAB by name; - and + switch to hiding them and back. " +
    "With C-u, hide them; with C-u C-u, add the tag to the filter in force; with C-u C-u C-u, not the tags of its group. " +
    ". keeps the tags of the line at point, SPC any tag, \\ removes the filter, RET hides what org-agenda-auto-exclude-function names, q quits.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const alist = agendaTagAlist();
    const seen: string[] = [];
    for (const [tag, key] of alist) if (!isTagKeyword(tag) && key !== undefined && !seen.includes(key)) seen.push(key);
    const tagChars = seen.join("");
    const valid = ["\t", "\r", "\\", ".", " ", "q", ...seen];
    let exclude = isUniversal(arg, 1);
    const accumulate = isUniversal(arg, 2);
    const expand = !isUniversal(arg, 3);
    const current = agendaFilters.tag;
    const autoFn = e8.variable("org-agenda-auto-exclude-function") ?? null;
    let char = "";
    while (!valid.includes(char)) {
      // The prompt unlogged, as org-unlogged-message shows it.
      char = readCharString(
        `${exclude ? "Exclude[+]" : "Filter[-]"} by tag${expand ? "" : " (no grouptag expand)"}: [${tagChars} ]tag-char [TAB]tag ${truthy(autoFn) ? "[RET] " : ""}[\\]off [q]uit`,
      );
      if (char === "-") exclude = true;
      else if (char === "+") exclude = false;
    }
    let tag: string | undefined;
    if (char === "\t") {
      tag = e8.letBind({ "completion-ignore-case": true }, () =>
        e8.completingRead("Tag: ", globalTagsCompletionTable().map(([t]) => t), { requireMatch: true }),
      );
    }
    if (char === "\r") {
      removeFilter("tag");
      if (truthy(autoFn)) autoExclude(autoFn, expand);
    } else if (char === "\\") {
      removeFilter("tag");
      if (filterPresets.tag.length > 0) filterApply(agendaFilters.tag, "tag", expand);
    } else if (char === ".") {
      const item = itemHere();
      agendaFilters.tag = (item ? lineTags(item) : []).map((t) => `+${t}`);
      filterApply(agendaFilters.tag, "tag", expand);
    } else if (char === "q") {
      // Nothing, even with a q key for a tag.
    } else {
      const entry = char === " " ? undefined : alist.find(([, key]) => key === char);
      if (char !== " " && entry === undefined && tag === undefined) e8.signal("error", `Invalid tag selection character ${char}`);
      removeFilter("tag");
      const chosen = char === " " ? "" : (entry?.[0] ?? tag ?? "");
      agendaFilters.tag = [`${exclude ? "-" : "+"}${chosen}`, ...(accumulate ? current : [])];
      filterApply(agendaFilters.tag, "tag", expand);
    }
  },
});

// Changing an entry's dates from the agenda, after org-agenda.el's
// org-agenda-date-later, org-agenda-date-prompt, org-agenda-schedule and
// org-agenda-deadline: the change is made in the Org file, and the line
// says what it became, as org-agenda-show-new-time does, until the agenda
// is made again.

e8.defineVariable({
  name: "org-agenda-move-date-from-past-immediately-to-today",
  doc: "Whether S-<right> on an agenda line whose timestamp is in the past moves it to today, rather than a day on.",
  value: true,
});

/**
 * Shows STAMP, after PREFIX and =>, at the end of every agenda line that
 * points where ITEM's does, over the line's last columns, as
 * org-agenda-show-new-time does with a display property, a short line
 * padded with spaces to reach them.
 */
function showNewTime(item: AgendaItem, stamp: string, prefix = ""): void {
  const text = `${prefix} => ${stamp} `;
  // As window-max-chars-per-line, a column short of the window's width.
  const column = Math.max(1, (e8.windowSize()?.width ?? 80) - 1 - charCount(text));
  const pos = posOf(item);
  e8.withCurrentBuffer(agendaBuffer, () =>
    e8.saveExcursion(() =>
      e8.letBind({ "inhibit-read-only": true }, () => {
        for (let l = agendaLines.length - 1; l >= 0; l--) {
          const other = agendaLines[l];
          if (!other || other.buffer !== item.buffer || posOf(other) !== pos) continue;
          e8.removeTextProperty(e8.lineStart(l), e8.lineEnd(l), "display");
          // To the column, spaces added to a short line, as org-move-to-column with force.
          e8.gotoChar(e8.lineEnd(l));
          if (e8.currentColumn() < column) e8.insert(" ".repeat(column - e8.currentColumn()));
          else {
            e8.gotoChar(e8.lineStart(l));
            e8.moveToColumn(column);
          }
          e8.putTextProperty(e8.point() - 1, e8.lineEnd(l), "display", e8.propertize(text, { face: ["secondary-selection", "default"] }));
        }
      }),
    ),
  );
}

/** Runs a command as call-interactively does from the running one, with its prefix argument, the command's parameters read as keys would. */
function interactively(command: e8.CommandName): void {
  const arg = e8.prefixArg();
  if (arg !== null && arg !== undefined) e8.setPrefixArg(arg);
  e8.callInteractively(command);
}

/** Day number of a timestamp's date, YYYY-MM-DD. */
const stampDay = (date: string): number => dayNumber({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });

/**
 * Moves the timestamp of the agenda line at point N days on, or N of
 * WHAT, as org-agenda-date-later: in the Org file, both ends of a range;
 * a day on from the past goes to today, with
 * org-agenda-move-date-from-past-immediately-to-today.
 */
function dateLater(n: number, what?: "hour" | "minute"): void {
  checkAgendaType();
  const item = agendaItemHere();
  const stamp = e8.withCurrentBuffer(item.buffer, () => {
    e8.widen();
    const pos = posOf(item);
    e8.gotoChar(pos);
    const dates = timestampDatesAt(pos);
    if (dates === undefined) e8.signal("error", "Cannot find time stamp");
    if (truthy(e8.variable("org-agenda-move-date-from-past-immediately-to-today") ?? null) && n === 1 && what === undefined && dates.length === 1) {
      const today = dayNumber(today_());
      const day = stampDay(dates[0]);
      if (today > day) n = today - day;
    }
    return shiftTimestampAt(pos, n, what ?? "day");
  });
  showNewTime(item, stamp);
  e8.message(`Time stamp changed to ${stamp}`);
}

/** The minutes S-<right> moves a time by, org-timestamp-rounding-minutes' second. */
function roundingStep(): number {
  const v = e8.variable("org-timestamp-rounding-minutes");
  return Array.isArray(v) && typeof v[1] === "number" ? v[1] : typeof v === "number" ? v : 5;
}

for (const [name, sign, doc] of [
  ["org-agenda-date-later", 1, "Move the timestamp of the agenda line at point a day later, or with a number that many."],
  ["org-agenda-date-earlier", -1, "Move the timestamp of the agenda line at point a day earlier, or with a number that many."],
] as const) {
  e8.defineCommand({ name, doc, params: [{ name: "n", kind: "count" }], run: (n: number) => dateLater(sign * n) });
}
for (const [name, sign, what, doc] of [
  ["org-agenda-date-later-hours", 1, "hour", "Move the time of the agenda line at point an hour later, or with a number that many."],
  ["org-agenda-date-earlier-hours", -1, "hour", "Move the time of the agenda line at point an hour earlier, or with a number that many."],
  ["org-agenda-date-later-minutes", 1, "minute", "Move the time of the agenda line at point later by org-timestamp-rounding-minutes, or with a number that many times."],
  ["org-agenda-date-earlier-minutes", -1, "minute", "Move the time of the agenda line at point earlier by org-timestamp-rounding-minutes, or with a number that many times."],
] as const) {
  e8.defineCommand({
    name,
    doc,
    params: [{ name: "n", kind: "count" }],
    run: (n: number) => dateLater(sign * n * (what === "minute" ? roundingStep() : 1), what),
  });
}

const HOUR_COMMANDS = ["org-agenda-date-later-hours", "org-agenda-date-earlier-hours"];
const MINUTE_COMMANDS = ["org-agenda-date-later-minutes", "org-agenda-date-earlier-minutes"];

/**
 * S-<right> and S-<left> in the agenda, as org-agenda-do-date-later: a day
 * on, or with C-u an hour and with C-u C-u the rounding minutes, which
 * pressing it again goes on doing.
 */
function doDateLater(arg: e8.PrefixArg | null | undefined, sign: 1 | -1): void {
  const last = e8.lastCommand() ?? "";
  const later = sign > 0;
  if (isUniversal(arg, 2) || MINUTE_COMMANDS.includes(last)) {
    e8.setThisCommand(later ? "org-agenda-date-later-minutes" : "org-agenda-date-earlier-minutes");
    dateLater(sign * roundingStep(), "minute");
  } else if (isUniversal(arg, 1) || HOUR_COMMANDS.includes(last)) {
    e8.setThisCommand(later ? "org-agenda-date-later-hours" : "org-agenda-date-earlier-hours");
    dateLater(sign, "hour");
  } else dateLater(sign * e8.prefixNumericValue(arg ?? null));
}

e8.defineCommand({
  name: "org-agenda-do-date-later",
  doc: "Move the timestamp of the agenda line at point a day later; with C-u, an hour; with C-u C-u, by org-timestamp-rounding-minutes, as pressing it again then does too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => doDateLater(arg, 1),
});
e8.defineCommand({
  name: "org-agenda-do-date-earlier",
  doc: "Move the timestamp of the agenda line at point a day earlier; with C-u, an hour; with C-u C-u, by org-timestamp-rounding-minutes, as pressing it again then does too.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => doDateLater(arg, -1),
});

e8.defineCommand({
  name: "org-agenda-date-prompt",
  doc: "Change the timestamp of the agenda line at point to a date read as org-timestamp reads it; with C-u, with the time too.",
  run: () => {
    checkAgendaType();
    const item = agendaItemHere();
    const stamp = e8.withCurrentBuffer(item.buffer, () => {
      e8.widen();
      const pos = posOf(item);
      e8.gotoChar(pos);
      const old = timestampTextAt(pos);
      if (old === undefined) e8.signal("error", "Cannot find time stamp");
      // The prefix argument passed on, as Org gives org-timestamp its ARG, an inactive one kept so.
      interactively(old.startsWith("[") ? "org-timestamp-inactive" : "org-timestamp");
      return timestampTextAt(pos) ?? "";
    });
    showNewTime(item, stamp);
    e8.message(`Time stamp changed to ${stamp}`);
  },
});

/**
 * Schedules the entry of the agenda line at point, or gives it a deadline,
 * with COMMAND from where the line points, as org-agenda-schedule and
 * org-agenda-deadline pass the prefix argument on; the line says what the
 * command said.
 */
function agendaPlan(command: "org-schedule" | "org-deadline", prefix: string): void {
  const item = agendaItemHere();
  // Scheduling moves the line's mark past what goes in where it points, as org-agenda-schedule makes it advance; a deadline does not.
  if (command === "org-schedule" && item.marks) e8.setMarkerInsertionType(item.marks.pos, true);
  const said = e8.withCurrentBuffer(item.buffer, () => {
    e8.widen();
    e8.gotoChar(posOf(item));
    interactively(command);
    // What it returns, which is what it said.
    return e8.currentMessage() ?? "nil";
  });
  showNewTime(item, said, prefix);
  e8.message(said);
}

e8.defineCommand({
  name: "org-agenda-schedule",
  doc: "Schedule the entry of the agenda line at point, as org-schedule does; with C-u, unschedule it.",
  run: () => agendaPlan("org-schedule", " S"),
});
e8.defineCommand({
  name: "org-agenda-deadline",
  doc: "Give the entry of the agenda line at point a deadline, as org-deadline does; with C-u, remove it.",
  run: () => agendaPlan("org-deadline", " D"),
});

/**
 * Where the Nth line starting a day is from position FROM, as
 * re-search-forward finds ^\\S- with a count, back with a negative one,
 * or undefined: forward, a line starting at FROM or after; back, one
 * starting before it.
 */
function dateLineFrom(from: number, n: number): number | undefined {
  let found: number | undefined;
  let left = Math.abs(n);
  const starts = (l: number) => /^\S/.test(e8.lineText(l));
  if (n > 0) {
    for (let l = e8.lineOf(from); l < e8.lineCount() && left > 0; l++) if (e8.lineStart(l) >= from && starts(l)) [found, left] = [l, left - 1];
  } else {
    for (let l = e8.lineOf(from); l >= 0 && left > 0; l--) if (e8.lineStart(l) < from && starts(l)) [found, left] = [l, left - 1];
  }
  return left === 0 ? found : undefined;
}

/** Goes N lines starting a day on from point, or back with BACK, as org-agenda-next-date-line and org-agenda-previous-date-line. */
function dateLineMove(n: number, back: boolean): void {
  checkAgendaType();
  const line = e8.lineOf(e8.point());
  const ls = e8.lineStart(line);
  if (back) {
    // From the line's start, as Org's forward-line 0 before re-search-backward.
    e8.gotoChar(ls);
    if (n === 0) return;
    const to = dateLineFrom(ls, -n);
    if (to === undefined) e8.signal("error", "No previous date before this line in this buffer");
    // A negative count searches forward, leaving point after the match, as re-search-backward then does.
    e8.gotoChar(e8.lineStart(to) + (n < 0 ? 1 : 0));
    return;
  }
  // Past the first character of a line starting a day, as Org's forward-char.
  const from = ls + (/^\S/.test(e8.lineText(line)) ? 1 : 0);
  if (n === 0) {
    e8.gotoChar(from);
    return;
  }
  const to = dateLineFrom(from, n);
  if (to === undefined) {
    // Back a character from where the search began, as Org's backward-char leaves it.
    e8.gotoChar(Math.max(0, from - 1));
    e8.signal("error", "No next date after this line in this buffer");
  }
  e8.gotoChar(e8.lineStart(to));
}

e8.defineCommand({
  name: "org-agenda-next-date-line",
  doc: "Move to the next line of the agenda that starts a day.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => dateLineMove(n, false),
});
e8.defineCommand({
  name: "org-agenda-previous-date-line",
  doc: "Move to the previous line of the agenda that starts a day.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => dateLineMove(n, true),
});

e8.defineCommand({
  name: "org-agenda-recenter",
  doc: "Show the entry the agenda line at point shows in another window, with its line in the middle of it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const win = e8.selectedWindow();
    gotoItem();
    e8.callWithPrefix(arg, "recenter");
    e8.selectWindow(win);
  },
});

/** The window SPC showed an entry in, which SPC again scrolls, as org-agenda-show-window. */
let agendaShowWindow: e8.Window | undefined;

e8.defineCommand({
  name: "org-agenda-show-and-scroll-up",
  doc: "Show the entry the agenda line at point shows in another window, all of it, drawers too; pressed again, scroll that window. With C-u, its drawers folded.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const win = e8.selectedWindow();
    if (agendaShowWindow !== undefined && e8.windowLiveP(agendaShowWindow) && e8.thisCommand() === e8.lastCommand()) {
      e8.selectWindow(agendaShowWindow);
      try {
        e8.call("scroll-up");
      } catch {
        // At the end, as ignore-errors has it.
      }
    } else {
      gotoItem();
      const all = headings();
      const i = headingIndex(all, e8.lineOf(e8.point()));
      if (i !== undefined) {
        showEntry(all, i);
        // Its drawers open too, or with C-u folded, as org-agenda-show-and-scroll-up shows them.
        if (arg === null || arg === undefined) flag(all[i].start, entryEnd(all, i), false, "org-hide-drawer");
        else hideDrawersIn(all[i].line, entryEnd(all, i));
      }
      agendaShowWindow = e8.selectedWindow();
    }
    e8.selectWindow(win);
  },
});

e8.defineCommand({
  name: "org-agenda-show-scroll-down",
  doc: "Scroll back the window SPC showed an entry in.",
  run: () => {
    const win = e8.selectedWindow();
    if (agendaShowWindow !== undefined && e8.windowLiveP(agendaShowWindow)) {
      e8.selectWindow(agendaShowWindow);
      try {
        e8.call("scroll-down");
      } catch {
        // At the start, as ignore-errors has it.
      }
      e8.selectWindow(win);
    }
  },
});

e8.defineVariable({
  name: "org-agenda-confirm-kill",
  doc: "Whether C-k in the agenda asks first: t always, a number when the entry has more lines than that, nil never.",
  value: 1,
});

e8.defineCommand({
  name: "org-agenda-kill",
  doc: "Delete the entry, with its subtree, the agenda line at point shows, and its lines in the agenda, asking first as org-agenda-confirm-kill says.",
  run: () => {
    if (e8.variable("major-mode") !== "org-agenda-mode") e8.userError("Not in agenda");
    const item = agendaLines[e8.lineOf(e8.point())];
    if (item === undefined) e8.userError("Command not allowed in this line");
    const [beg, end, n] = e8.withCurrentBuffer(item.buffer, () => widened(() => {
      const all = headings();
      const i = headingIndex(all, e8.lineOf(posOf(item)));
      if (i === undefined) return [e8.lineStart(e8.lineOf(posOf(item))), Math.min(e8.pointMax(), e8.lineEnd(e8.lineOf(posOf(item))) + 1), 1];
      const [b, e] = subtreeRegion(all, i);
      let count = 0;
      for (let l = e8.lineOf(b); l < e8.lineCount() && e8.lineStart(l) < e; l++) if (/^[ \t]*\S/.test(e8.lineText(l))) count++;
      return [b, e, count];
    }));
    const confirm = e8.variable("org-agenda-confirm-kill");
    if (confirm === true || (typeof confirm === "number" && n > confirm)) {
      if (!e8.yOrNP(`Delete entry with ${n} lines in buffer "${item.buffer}"? `)) e8.signal("error", "Abort");
    }
    removeSubtreeEntries(item.buffer, beg, end);
    e8.withCurrentBuffer(item.buffer, () => widened(() => e8.deleteRegion(beg, end)));
    e8.message("Agenda item and source killed");
  },
});

e8.defineCommand({
  name: "org-agenda-open-link",
  doc: "Open the link of the entry the agenda line at point shows: the one in the line, or the only one in the entry.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const line = e8.lineOf(e8.point());
    const item = agendaLines[line];
    const text = e8.lineText(line);
    const bracket = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([\s\S]+?)\])?\]/;
    let links: string[] = [];
    let entryEnd = 0;
    let haveZero = false;
    if (item !== undefined) {
      // The line's own link, then the entry's, as org-offer-links-in-entry has them.
      const zero = bracket.exec(text)?.[0];
      haveZero = zero !== undefined;
      const [entry, end] = e8.withCurrentBuffer(item.buffer, () => widened(() => {
        const all = headings();
        const i = headingIndex(all, e8.lineOf(headingOf(item)));
        const to = i === undefined ? e8.bufferSize() : (all[i + 1]?.start ?? e8.bufferSize());
        return [i === undefined ? [] : linksIn(all[i].start, to).links, to] as const;
      }));
      entryEnd = end;
      links = [...(zero !== undefined ? [zero] : []), ...entry].filter((l, k, a) => a.indexOf(l) === k);
    }
    // The Nth with a number, the line's own counting as the 0th, as org-offer-links-in-entry's NTH.
    if (links.length > 1 && typeof arg === "number" && links.length >= (haveZero ? arg + 1 : arg) && (haveZero ? arg : arg - 1) >= 0) {
      links = [links[haveZero ? arg : arg - 1]];
    }
    if (links.length > 1) throw new Error("E8 cannot choose between an entry's links yet");
    if (item !== undefined && links.length === 1) {
      const l = links[0];
      const target = bracket.exec(l)?.[1];
      // A link of a type Org knows, as org-link-any-re matches, is opened
      // from the entry's buffer, any other in another window, as
      // org-agenda-open-link does: searched for from the heading to the
      // entry's end.
      const type = target === undefined ? undefined : /^([A-Za-z][-A-Za-z0-9+.]*):/.exec(target)?.[1];
      const external = target === undefined || (type !== undefined && linkTypeKnown(type));
      const open = (): void => {
        e8.widen();
        e8.gotoChar(headingOf(item));
        const found = e8.search(l, { from: headingOf(item) });
        if (found && found.end <= entryEnd) {
          e8.gotoChar(found.start);
          e8.call("org-open-at-point");
        }
      };
      if (external) e8.withCurrentBuffer(item.buffer, () => e8.saveExcursion(() => e8.saveRestriction(open)));
      else {
        e8.call("switch-to-buffer-other-window", item.buffer);
        open();
      }
      return;
    }
    const here = bracket.exec(text);
    // A link in a line with no entry, as the clock report's, as org-link-open-from-string opens it.
    if (here) openLink({ start: 0, end: 0, path: linkUnescape(here[1]), description: here[2], kind: "bracket" });
    else e8.message("No link to open here");
  },
});

const agendaSwitchTo = e8.defineCommand({
  name: "org-agenda-switch-to",
  doc: "Go to the entry the agenda line at point shows, in this window.",
  run: () => {
    const item = agendaItemHere();
    e8.call("switch-to-buffer", item.buffer);
    // The whole file, as org-agenda-switch-to widens before going there.
    e8.widen();
    e8.gotoChar(posOf(item));
  },
});

const agendaGoto = e8.defineCommand({
  name: "org-agenda-goto",
  doc: "Show the entry the agenda line at point shows in another window, and go there.",
  run: () => gotoItem(),
});

/** Goes to the entry the agenda line at point shows, in another window, as org-agenda-goto. */
function gotoItem(): void {
  {
    const item = agendaItemHere();
    e8.call("pop-to-buffer", item.buffer);
    e8.widen();
    e8.pushMark(e8.point());
    // As push-mark says, but not in a keyboard macro.
    if (!e8.executingKbdMacro()) e8.message("Mark set");
    e8.gotoChar(posOf(item));
    // Unfolded around it as org-fold-show-context-detail says for the agenda, as org-agenda-goto shows it.
    showContext("agenda");
    // At the heading's title, as org-agenda-goto leaves it.
    const heading = headingOf(item);
    const h = headings().find((x) => x.start === heading);
    if (h) e8.gotoChar(h.titleAt);
  }
}

const agendaTodo = e8.defineCommand({
  name: "org-agenda-todo",
  doc: "Change the TODO state of the entry the agenda line at point shows, as C-c C-t does there.",
  run: () => {
    const item = agendaItemHere();
    e8.withCurrentBuffer(item.buffer, () => widened(() => {
      e8.gotoChar(headingOf(item));
      // Interactively, with the agenda's prefix argument, as Org's call-interactively: a blocked change is then an error.
      e8.funcallInteractively("org-todo");
    }));
    redrawEntry(item);
  },
});

const agendaRedo = e8.defineCommand({
  name: "org-agenda-redo",
  doc: "Rebuild the agenda from the files, as they are now.",
  run: () => redoAgenda(),
});

/** The day agenda the agenda buffer shows, or an error for another view, as org-agenda-check-type with agenda. */
function checkAgendaType(): Extract<typeof agendaView, { kind: "agenda" }> {
  // With the quotes format-message curves.
  if (agendaView.kind !== "agenda") e8.signal("error", `Not allowed in \u2019${agendaView.kind}\u2019-type agenda buffer or component`);
  return agendaView as Extract<typeof agendaView, { kind: "agenda" }>;
}

/** The day and day count of point's line, as org-get-at-bol reads day and org-day-cnt. */
function dayHere(): { day: number; cnt: number } | undefined {
  return agendaLineDays[e8.lineOf(e8.point())];
}

/** Makes the day agenda again from another day or for another span, as org-agenda-redo with org-agenda-overriding-arguments. */
function redoFrom(arg: e8.PrefixArg | null, startDay: number, span: Span): void {
  e8.message("Rebuilding agenda buffer...");
  agendaList(arg, startDay, span);
  e8.message("Rebuilding agenda buffer...done");
}

/**
 * Goes to the day shown CNT-th, or to today, or to the agenda's start, as
 * org-agenda-find-same-or-today-or-agenda does.
 */
function findSameOrToday(cnt?: number): void {
  const today = dayNumber(today_());
  let line = cnt === undefined ? -1 : agendaLineDays.findIndex((d) => d?.cnt === cnt);
  if (line < 0) line = agendaLineDays.findIndex((d) => d?.day === today);
  e8.gotoChar(line < 0 ? e8.pointMin() : e8.lineStart(line));
}

/**
 * Moves the agenda on by its span ARG times, as org-agenda-later does:
 * from the day it was asked to start on, else from point's day, a month
 * or a year on keeping the day of the month, which runs on into the next
 * month past the month's end; point goes to the day shown as many days in.
 */
function agendaLater(arg: number): void {
  const view = checkAgendaType();
  const here = dayHere();
  const span = view.span;
  let sd = view.startDay ?? here?.day ?? startingDay;
  const g = dayFromNumber(sd);
  if (typeof span === "number") sd += span * arg;
  else if (span === "day") sd += arg;
  else if (span === "week") sd += 7 * arg;
  else if (span === "fortnight") sd += 14 * arg;
  else if (span === "month") sd = gregorianDay(g.month + arg, g.day, g.year);
  else sd = gregorianDay(g.month, g.day, g.year + arg);
  redoFrom(view.arg, sd, span);
  findSameOrToday(here?.cnt);
}

/**
 * The day an agenda of SPAN with SD in it starts on, as
 * org-agenda-compute-starting-span finds it; N picks the day of SD's
 * month, the ISO week of its year, the month of its year or the year, and
 * past 99 a week's or a month's number has the year before it, as 202612.
 */
function computeStartingSpan(sd: number, span: Span, n?: number): number {
  const g = dayFromNumber(sd);
  if (span === "day") return n === undefined ? sd : gregorianDay(g.month, 1, g.year) + n - 1;
  if (span === "week" || span === "fortnight") {
    const sow = startOnWeekday();
    const d = sow === null ? 0 : weekday(sd) - sow;
    sd -= (d < 0 ? 7 : 0) + d;
    if (n === undefined) return sd;
    let year: number | undefined;
    if (n > 99) [year, n] = [smallYearToYear(Math.trunc(n / 100)), n % 100];
    return isoWeekMonday(n, year ?? isoYearOf(sd));
  }
  if (span === "month") {
    let year: number | undefined;
    if (n !== undefined && n > 99) [year, n] = [smallYearToYear(Math.trunc(n / 100)), n % 100];
    return gregorianDay(n ?? g.month, 1, year ?? g.year);
  }
  if (span === "year") return gregorianDay(1, 1, n ?? g.year);
  return sd;
}

/** Shows the agenda for SPAN around point's day, as org-agenda-change-time-span does. */
function changeTimeSpan(span: Span, n?: number): void {
  const view = checkAgendaType();
  if (n === undefined && view.span === span) e8.signal("error", `Viewing span is already "${span}"`);
  const sd = computeStartingSpan(dayHere()?.day ?? view.startDay ?? startingDay, span, n);
  redoFrom(view.arg, sd, span);
  findSameOrToday();
  e8.message(`Switched to ${span} view`);
}

/** A view command's raw prefix argument as the number it uses, which Org adds to, so C-u or M-- signals. */
function viewNumber(raw: e8.PrefixArg | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "number") return raw;
  return e8.signal("wrong-type-argument", `Wrong type argument: number-or-marker-p, ${Array.isArray(raw) ? `(${raw[0]})` : String(raw)}`, [
    "number-or-marker-p",
    raw as e8.Value,
  ]);
}

const agendaLaterCommand = e8.defineCommand({
  name: "org-agenda-later",
  doc: "Show the agenda for the days after it, by its span. With a prefix argument, that many spans on.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => agendaLater(arg),
});
const agendaEarlier = e8.defineCommand({
  name: "org-agenda-earlier",
  doc: "Show the agenda for the days before it, by its span. With a prefix argument, that many spans back.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg) => agendaLater(-arg),
});
const agendaToday = e8.defineCommand({
  name: "org-agenda-goto-today",
  doc: "Go to today in the agenda, showing the days around it if they are not shown.",
  run: () => {
    const view = checkAgendaType();
    const today = dayNumber(today_());
    const line = agendaLineDays.findIndex((d) => d?.day === today);
    if (line >= 0) {
      e8.gotoChar(e8.lineStart(line));
      return;
    }
    redoFrom(view.arg, computeStartingSpan(today, view.span), view.span);
    findSameOrToday();
  },
});

/**
 * Shows the agenda from a date, for as many days as its span has from
 * there, as org-agenda-goto-date does: in the same buffer, with a prefix
 * argument as org-agenda-list takes one, and goes to the date's line, or
 * the last line if the agenda leaves it out.
 */
e8.defineCommand({
  name: "org-agenda-goto-date",
  doc: "Show the agenda from a date read as org-read-date reads it, for its span's days, and go to the date.",
  params: [{ name: "date", value: () => readDate() }],
  run: (date: string) => {
    const view = checkAgendaType();
    const day = dayNumber(parseDate(date));
    const arg = e8.prefixArg() ?? view.arg;
    bufferTmpName = e8.bufferName();
    try {
      redoFrom(arg, day, spanToNdays(view.span, day));
    } finally {
      bufferTmpName = undefined;
    }
    let line = 0;
    while (agendaLineDays[line]?.day !== day && line + 1 < e8.lineCount() - 1) line++;
    e8.gotoChar(e8.lineStart(line));
  },
});

e8.defineCommand({
  name: "org-agenda-reset-view",
  doc: "Show the agenda for org-agenda-span's days.",
  run: () => changeTimeSpan(spanOf(e8.variable("org-agenda-span"))),
});
const dayView = e8.defineCommand({
  name: "org-agenda-day-view",
  doc: "Show a day's agenda, point's day. With a prefix argument, that day of the month.",
  params: [{ name: "dayOfMonth", kind: "prefix" }],
  run: (n) => {
    // The agenda's type checked first, as org-agenda-change-time-span checks it before using the number.
    checkAgendaType();
    changeTimeSpan("day", viewNumber(n));
  },
});
const weekView = e8.defineCommand({
  name: "org-agenda-week-view",
  doc: "Show a week's agenda, point's week. With a prefix argument, that ISO week of the year; past 99, its last two digits are the week and those before them the year, as 202612.",
  params: [{ name: "isoWeek", kind: "prefix" }],
  run: (n) => {
    // The agenda's type checked first, as org-agenda-change-time-span checks it before using the number.
    checkAgendaType();
    changeTimeSpan("week", viewNumber(n));
  },
});
const fortnightView = e8.defineCommand({
  name: "org-agenda-fortnight-view",
  doc: "Show two weeks' agenda, from point's week. With a prefix argument, from that ISO week, as org-agenda-week-view reads it.",
  params: [{ name: "isoWeek", kind: "prefix" }],
  run: (n) => {
    // The agenda's type checked first, as org-agenda-change-time-span checks it before using the number.
    checkAgendaType();
    changeTimeSpan("fortnight", viewNumber(n));
  },
});
const monthView = e8.defineCommand({
  name: "org-agenda-month-view",
  doc: "Show a month's agenda, point's month. With a prefix argument, that month; past 99, its last two digits are the month and those before them the year, as 202612.",
  params: [{ name: "month", kind: "prefix" }],
  run: (n) => {
    // The agenda's type checked first, as org-agenda-change-time-span checks it before using the number.
    checkAgendaType();
    changeTimeSpan("month", viewNumber(n));
  },
});
const yearView = e8.defineCommand({
  name: "org-agenda-year-view",
  doc: "Show a year's agenda, point's year, after asking. With a prefix argument, that year, two digits being one of the next 30 years or the 70 before.",
  params: [{ name: "year", kind: "prefix" }],
  run: (raw) => {
    let year = viewNumber(raw);
    if (year !== undefined) year = smallYearToYear(year);
    if (e8.yOrNP("Are you sure you want to compute the agenda for an entire year? ")) changeTimeSpan("year", year);
    else e8.signal("error", "Abort");
  },
});

const agendaQuit = e8.defineCommand({
  name: "org-agenda-quit",
  doc: "Leave the agenda: its window goes, or another buffer takes its place.",
  run: () => {
    if (e8.windowList().length > 1) e8.deleteWindow();
    else e8.call("switch-to-buffer", "");
  },
});

e8.defineMajorMode({
  name: "org-agenda-mode",
  modeName: "Org-Agenda",
  doc:
    "The mode of the *Org Agenda* buffer. n and p move between lines, RET goes to an entry and TAB shows it in " +
    "another window, t changes its TODO state, g rebuilds the agenda, f and b move by its span, . goes to today, " +
    "d, w and y show a day, a week or a year, and q leaves.",
  // Lines run off the window, and n and p move by them, as org-agenda-mode sets up.
  setup: () => {
    if (truthy(e8.variable("org-startup-truncated"))) e8.setVariable("truncate-lines", true);
    e8.makeLocalVariable("line-move-visual");
    e8.setVariable("line-move-visual", null);
    // Lines hidden as filtered, blocked tasks among them, as org-agenda-mode adds org-filtered.
    e8.addToInvisibilitySpec("org-filtered");
    // Links show their descriptions, as org-agenda-finalize activates them.
    e8.addToInvisibilitySpec("org-link");
  },
  bindings: {
    n: agendaNext,
    p: agendaPrevious,
    // And whatever moves by lines elsewhere, as org-agenda-mode-map takes over next-line's and previous-line's keys.
    "C-n": agendaNext,
    "C-p": agendaPrevious,
    "<down>": agendaNext,
    "<up>": agendaPrevious,
    RET: agendaSwitchTo,
    TAB: agendaGoto,
    t: agendaTodo,
    g: agendaRedo,
    r: agendaRedo,
    f: agendaLaterCommand,
    b: agendaEarlier,
    d: dayView,
    j: "org-agenda-goto-date",
    w: weekView,
    y: yearView,
    ".": agendaToday,
    q: agendaQuit,
    x: agendaQuit,
    I: "org-agenda-clock-in",
    O: "org-agenda-clock-out",
    X: "org-agenda-clock-cancel",
    J: "org-agenda-clock-goto",
    ":": "org-agenda-set-tags",
    ",": "org-agenda-priority",
    $: "org-agenda-archive",
    a: "org-agenda-archive-default-with-confirmation",
    v: "org-agenda-view-mode-dispatch",
    G: "org-agenda-toggle-time-grid",
    F: "org-agenda-follow-mode",
    l: "org-agenda-log-mode",
    E: "org-agenda-entry-text-mode",
    R: "org-agenda-clockreport-mode",
    "!": "org-agenda-toggle-deadlines",
    "#": "org-agenda-dim-blocked-tasks",
    ...Object.fromEntries(queryCommands),
  },
});

void agendaListCommand;
void todoListCommand;
void tagsViewCommand;

e8.defineCommand({
  name: "org-agenda-refile",
  doc: "Refile the item at point. With C-u, go to the target instead; with C-u C-u, to where the last refile put its entry; with C-0 or C-u C-u C-u, clear the targets kept.",
  params: [{ name: "goto", kind: "prefix" }],
  run: (goto: e8.PrefixArg) => {
    const g = goto ?? null;
    const list = Array.isArray(g) ? (g as number[])[0] : undefined;
    if (g === 0 || list === 64) return refile(0);
    if (list === 16) return gotoLastStored();
    // Asked from the agenda, of the entry's buffer, as org-agenda-refile does.
    const item = agendaItemHere();
    const rfloc = getLocation(g !== null ? "Goto" : "Refile to", item.buffer, e8.variable("org-refile-allow-creating-parent-nodes") ?? null);
    if (!rfloc) return;
    if (g !== null) return refile(g, item.buffer, rfloc);
    e8.withCurrentBuffer(item.buffer, () => {
      e8.saveExcursion(() => widened(() => {
        e8.gotoChar(headingOf(item));
        refile(null, item.buffer, rfloc);
      }));
    });
    e8.call("org-agenda-redo");
  },
});

// Archiving from the agenda, as org-agenda.el's org-agenda-archive-with
// and its commands.

/**
 * Takes out of the agenda the lines whose entries are in BUFFER between
 * BEG and END, as org-remove-subtree-entries-from-agenda: by where each
 * line points, as its org-marker, from the last line up, the first left.
 */
function removeSubtreeEntries(buffer: string, beg: number, end: number): void {
  e8.withCurrentBuffer(agendaBuffer, () => e8.letBind({ "inhibit-read-only": true }, () => {
    for (let l = agendaLines.length - 1; l > 0; l--) {
      const item = agendaLines[l];
      if (!item || item.buffer !== buffer) continue;
      const p = posOf(item);
      if (p < beg || p >= end) continue;
      e8.deleteRegion(e8.lineStart(l), Math.min(e8.lineEnd(l) + 1, e8.pointMax()));
      if (item.marks) {
        e8.deleteMarker(item.marks.pos);
        e8.deleteMarker(item.marks.heading);
      }
      agendaLines.splice(l, 1);
      agendaLineDays.splice(l, 1);
    }
  }));
}

/**
 * Archives the entry the line at point shows with COMMAND, as
 * org-agenda-archive-with: asking first with CONFIRM, its subtree's lines
 * taken out of the agenda, which is not made again, and the command run at
 * its heading as archiving from the agenda.
 */
function archiveWith(command: e8.CommandName, confirm: boolean): void {
  if (e8.variable("major-mode") !== "org-agenda-mode") e8.userError("Not in agenda");
  const item = agendaItemHere();
  const pos = posOf(item);
  e8.withCurrentBuffer(item.buffer, () => {
    if (!e8.derivedModeP("org-mode")) e8.signal("error", "Archiving works only in Org files");
    if (confirm && !e8.yOrNP("Archive this subtree or entry? ")) e8.signal("error", "Abort");
    e8.saveWindowExcursion(() => {
      e8.gotoChar(pos);
      // The subtree at the line's place, widened, as org-back-to-heading and org-end-of-subtree find it.
      const heading = widened(() => {
        const all = headings();
        let i = -1;
        for (let k = 0; k < all.length && all[k].start <= pos; k++) i = k;
        if (i < 0) e8.signal("error", `Before first headline at position ${pos + 1} in buffer ${item.buffer}`);
        const [beg, end] = subtreeRegion(all, i);
        removeSubtreeEntries(item.buffer, beg, end);
        return all[i].start;
      });
      e8.gotoChar(heading);
      archivingFromAgenda(() => e8.call(command));
    });
  });
}

for (const [name, command, confirm, doc] of [
  ["org-agenda-archive-default", undefined, false, "Archive the entry or subtree of the agenda line at point, with org-archive-default-command."],
  [
    "org-agenda-archive-default-with-confirmation",
    undefined,
    true,
    "Archive the entry or subtree of the agenda line at point, with org-archive-default-command, asking first.",
  ],
  ["org-agenda-archive", "org-archive-subtree", false, "Archive the subtree of the agenda line at point, with org-archive-subtree."],
  ["org-agenda-archive-to-archive-sibling", "org-archive-to-archive-sibling", false, "Move the entry of the agenda line at point to its archive sibling."],
] as const) {
  e8.defineCommand({
    name,
    doc,
    run: () => archiveWith((command ?? String(e8.variable("org-archive-default-command") ?? "org-archive-subtree")) as e8.CommandName, confirm),
  });
}

e8.defineCommand({
  name: "org-agenda-toggle-archive-tag",
  doc: "Toggle the ARCHIVE tag of the entry the agenda line at point shows.",
  run: () => atEntry("org-toggle-archive-tag"),
});

// More of Org's keys, as org-agenda.el binds them.
for (const [key, command] of [
  ["T", "org-agenda-show-tags"],
  ["N", "org-agenda-next-item"],
  ["P", "org-agenda-previous-item"],
  ["SPC", "org-agenda-show-and-scroll-up"],
  ["DEL", "org-agenda-show-scroll-down"],
  ["<backspace>", "org-agenda-show-scroll-down"],
  ["o", "delete-other-windows"],
  ["L", "org-agenda-recenter"],
  ["C-c C-n", "org-agenda-next-date-line"],
  ["C-c C-p", "org-agenda-previous-date-line"],
  ["C-c C-t", "org-agenda-todo"],
  ["C-c C-q", "org-agenda-set-tags"],
  ["C-k", "org-agenda-kill"],
  ["C-c C-o", "org-agenda-open-link"],
  ["s", "org-save-all-org-buffers"],
  ["C-x C-s", "org-save-all-org-buffers"],
  ...[..."0123456789"].map((d) => [d, "digit-argument"] as const),
  ["C-c C-x C-a", "org-agenda-archive-default"],
  ["C-c C-x a", "org-agenda-toggle-archive-tag"],
  ["C-c C-x A", "org-agenda-archive-to-archive-sibling"],
  ["C-c C-x C-s", "org-agenda-archive"],
  ["C-c $", "org-agenda-archive"],
  ["C-c ,", "org-agenda-priority"],
  ["C-S-<right>", "org-agenda-todo-nextset"],
  ["C-S-<left>", "org-agenda-todo-previousset"],
  ["+", "org-agenda-priority-up"],
  ["-", "org-agenda-priority-down"],
  ["S-<up>", "org-agenda-priority-up"],
  ["S-<down>", "org-agenda-priority-down"],
  ["C-c C-x <up>", "org-agenda-priority-up"],
  ["C-c C-x <down>", "org-agenda-priority-down"],
  ["C-c C-w", "org-agenda-refile"],
  ["\\", "org-agenda-filter-by-tag"],
  ["_", "org-agenda-filter-by-effort"],
  ["=", "org-agenda-filter-by-regexp"],
  ["/", "org-agenda-filter"],
  ["|", "org-agenda-filter-remove-all"],
  ["<", "org-agenda-filter-by-category"],
  ["^", "org-agenda-filter-by-top-headline"],
  ["S-<right>", "org-agenda-do-date-later"],
  ["S-<left>", "org-agenda-do-date-earlier"],
  ["C-c C-x <right>", "org-agenda-do-date-later"],
  ["C-c C-x <left>", "org-agenda-do-date-earlier"],
  [">", "org-agenda-date-prompt"],
  ["C-c C-s", "org-agenda-schedule"],
  ["C-c C-d", "org-agenda-deadline"],
] as const) e8.defineKey("org-agenda-mode-map", key, command);

/** Toggles archives mode, as org-agenda-archives-mode: archived trees in and out, or with WITH-FILES the archive files too. */
function toggleArchivesMode(withFiles: boolean): void {
  archivesMode = withFiles && archivesMode === true ? null : withFiles ? true : archivesMode !== null ? null : "trees";
  setModeName();
  redoAgenda();
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  e8.message(
    archivesMode === null
      ? "No archives are included"
      : archivesMode === "trees"
        ? `Trees with :${tag}: tag are included`
        : `Trees with :${tag}: tag and all active archive files are included`,
  );
}

e8.defineCommand({
  name: "org-agenda-archives-mode",
  doc:
    "Toggle whether the agenda shows the trees tagged ARCHIVE. With a prefix argument, toggle whether it shows them " +
    "and the agenda files' archive files too.",
  params: [{ name: "withFiles", kind: "prefix" }],
  run: (withFiles) => toggleArchivesMode(withFiles !== null && withFiles !== undefined),
});

/** The view modes org-agenda-view-mode-dispatch offers that E8 does not have yet. */
const VIEW_MODES_NOT_YET = "D";

/** Rebuilds the agenda with its inactive timestamps too, this once, as [ and v [ do. */
function includeInactiveOnce(): void {
  e8.letBind({ "org-agenda-include-inactive-timestamps": true }, () => {
    checkAgendaType();
    redoAgenda();
  });
  e8.message("Display now includes inactive timestamps as well");
}

/** Toggles a variable the agenda reads, rebuilds it and says so, as org-agenda-toggle-time-grid and org-agenda-toggle-deadlines do. */
function toggleAgendaVariable(name: string, message: string): void {
  checkAgendaType();
  e8.setVariable(name, truthy(e8.variable(name) ?? null) ? null : true);
  redoAgenda();
  setModeName();
  e8.message(`${message} ${truthy(e8.variable(name) ?? null) ? "on" : "off"}`);
}

const toggleTimeGrid = e8.defineCommand({
  name: "org-agenda-toggle-time-grid",
  doc: "Toggle the agenda's time grid, org-agenda-use-time-grid, and rebuild it.",
  run: () => toggleAgendaVariable("org-agenda-use-time-grid", "Time-grid turned"),
});

const toggleDeadlines = e8.defineCommand({
  name: "org-agenda-toggle-deadlines",
  doc: "Toggle whether the agenda shows deadlines, org-agenda-include-deadlines, and rebuild it.",
  run: () => toggleAgendaVariable("org-agenda-include-deadlines", "Deadlines inclusion turned"),
});

e8.defineCommand({
  name: "org-agenda-view-mode-dispatch",
  doc:
    "Change how the agenda shows its entries, by a key: d, w, t, m and y for a day's, a week's, two weeks', a month's or a year's agenda, " +
    "SPC for org-agenda-span's, a to toggle archived trees, A to toggle archive files too, G the time grid, ! deadlines, " +
    "[ to show inactive timestamps too, q to abort.",
  run: () => {
    const key = e8.readCharExclusive(
      "View: [d]ay  [w]eek  for[t]night  [m]onth  [y]ear  [SPC]reset  [q]uit/abort\n" +
        "       time[G]rid   [[]inactive  [f]ollow      [l]og    [L]og-all   [c]lockcheck\n" +
        "       [a]rch-trees [A]rch-files clock[R]eport include[D]iary       [E]ntryText",
    );
    const char = key === "SPC" ? " " : key;
    const views: Record<string, e8.DefinedCommand | e8.CommandName> = {
      " ": "org-agenda-reset-view",
      d: dayView,
      w: weekView,
      t: fortnightView,
      m: monthView,
      y: yearView,
    };
    // With the prefix argument v had, as call-interactively hands on current-prefix-arg.
    if (views[char] !== undefined) e8.callWithPrefix(e8.prefixArg(), views[char]);
    else if (char === "a") toggleArchivesMode(e8.prefixArg() !== null && e8.prefixArg() !== undefined);
    else if (char === "A") toggleArchivesMode(true);
    else if (char === "G") e8.callInteractively(toggleTimeGrid);
    else if (char === "f" || char === "F") e8.callInteractively("org-agenda-follow-mode");
    // With the prefix argument v had, as call-interactively hands on current-prefix-arg.
    else if (char === "l") e8.callWithPrefix(e8.prefixArg(), logModeCommand);
    else if (char === "E" || char === "e") e8.callWithPrefix(e8.prefixArg(), entryTextModeCommand);
    else if (char === "R" || char === "r") e8.callWithPrefix(e8.prefixArg(), clockreportModeCommand);
    else if (char === "L") e8.callWithPrefix([4], logModeCommand);
    else if (char === "c") setLogMode("clockcheck");
    else if (char === "!") e8.callInteractively(toggleDeadlines);
    else if (char === "[") includeInactiveOnce();
    else if (char === "q") e8.message("Abort");
    else if ([...char].length === 1 && VIEW_MODES_NOT_YET.includes(char)) e8.userError(`E8 does not have that view mode yet: ${char}`);
    // As a number, as Org's %s formats the character read.
    else e8.userError(`Invalid key: ${[...char].length === 1 ? char.codePointAt(0) : key}`);
  },
});

e8.defineCommand({
  name: "org-agenda-dim-blocked-tasks",
  doc: "Dim the agenda's blocked TODO entries again, or hide them, as the agenda marked them when it was made.",
  run: () => {
    // As (called-interactively-p 'interactive), not from a keyboard macro.
    const interactive = e8.calledInteractively() && !e8.executingKbdMacro();
    if (interactive) e8.message("Dim or hide blocked tasks...");
    // Only the agenda's lines carry the marks it reads.
    if (e8.bufferName() === agendaBuffer) agendaLines.forEach((item, l) => dimLine(l, item));
    if (interactive) e8.message("Dim or hide blocked tasks...done");
  },
});
