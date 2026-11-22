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
  entryEnd,
  headingIndex,
  headings,
  isDone,
  keywordLines,
  makeTagsMatcher,
  notDoneRegexp,
  reducedLevel,
  scanTags,
  today,
} from "org";
import { setAgendaEntryHere, storeLink } from "ol";
import { addArchiveFiles } from "org-archive";
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

const AGENDA = "*Org Agenda*";
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

/** A heading's priority as org-get-priority gives it: 1000 for the default B, more for A. */
function priorityValue(h: Heading): number {
  const p = h.priority ?? "B";
  return 1000 * ("C".charCodeAt(0) - p.charCodeAt(0));
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
  removeTimestamp: boolean;
  /** Its time of day as the line shows it, " 9:30......" or "10:00-11:30", and in minutes, for sorting. */
  time?: { field: string; minutes: number };
  /** The habit a scheduled line is, whose graph the line shows. */
  habit?: Habit;
  /** Markers at `pos` and `heading`, once the agenda shows the line, so they follow edits there. */
  marks?: { pos: e8.Marker; heading: e8.Marker };
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

/** The tags a heading inherits, as org-get-tags gives them with inheritance: the file's, then each ancestor's. */
function inheritedTags(h: Heading): string[] {
  const buffer = e8.currentBuffer().id;
  const tick = e8.bufferCharsModifiedTick();
  if (!inheritedCache || inheritedCache.buffer !== buffer || inheritedCache.tick !== tick) {
    const map = new Map<number, string[]>();
    const file: string[] = [];
    for (const [, , text] of keywordLines()) {
      const m = /^#\+FILETAGS:(.*)$/i.exec(text);
      if (m) for (const t of m[1].split(/[:\s]+/)) if (t !== "" && !file.includes(t)) file.push(t);
    }
    const stack: Heading[] = [];
    for (const x of headings()) {
      while (stack.length > 0 && stack[stack.length - 1].level >= x.level) stack.pop();
      const tags = [...file];
      for (const a of stack) for (const t of a.tags) if (!tags.includes(t)) tags.push(t);
      map.set(x.start, tags);
      stack.push(x);
    }
    inheritedCache = { buffer, tick, map };
  }
  return inheritedCache.map.get(h.start) ?? [];
}

/** A line's tags as the agenda shows them, inherited ones first and :: before the heading's own, as org-agenda-fix-displayed-tags writes them. */
function displayedTags(h: Heading): string {
  const show = e8.variable("org-agenda-show-inherited-tags");
  const inherited = show === null || show === false ? [] : inheritedTags(h).filter((t) => !h.tags.includes(t));
  if (inherited.length === 0) return h.tags.length === 0 ? "" : `:${h.tags.join(":")}:`;
  return `:${inherited.join(":")}:${h.tags.length === 0 ? ":" : `:${h.tags.join(":")}:`}`;
}

function agendaLine(h: Heading, cat: string, leader: string, removeTimestamp: boolean, time?: AgendaItem["time"], prefix = ""): string {
  let text = prefix + e8.lineText(h.line).replace(/^\*+[ \t]+/, "");
  if (h.tagsAt !== undefined) text = text.slice(0, text.length - (e8.lineEnd(h.line) - h.tagsAt) - 0).replace(/[ \t]+$/, "");
  if (removeTimestamp) text = text.replace(/<\d{4}-\d{2}-\d{2}[^>\n]*>/, "");
  const line = `  ${(cat === "" ? "" : `${cat}:`).padEnd(12)}${time === undefined ? "" : `${time.field.padEnd(11)} `}${leader === "" ? "" : `${leader} `}${text}`;
  const tags = displayedTags(h);
  if (tags === "") return line;
  const width = (e8.windowSize()?.width ?? 80) - 1;
  return line + " ".repeat(Math.max(1, width - charCount(line) - charCount(tags))) + tags;
}

/** The buffers of org-agenda-files, visited if need be. */
function agendaBuffers(): string[] {
  // Relative names are in org-directory, and directories stand for their Org files, as org-agenda-files expands them.
  // Each file's TAGS lines read again, as org-agenda-prepare-buffers does with org-set-regexps-and-options.
  return agendaFiles().map((file) => {
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
  /** The entry's active timestamps but its planning line's, in order: where each is, and whether it is in the heading. */
  stamps: { ts: { day: number; repeat?: [number, string] }; pos: number; inHeading: boolean; text: string }[];
  /** The entry's date ranges, <a>--<b>: their first and last days, the timestamps at either end, and where they are. */
  ranges: { first: number; last: number; from: string; to: string; pos: number }[];
  habit?: Habit;
  /** Its category, as org-get-category gives it at the heading. */
  cat: string;
}

/** Runs `f` with the current buffer widened, as Org's agenda reads and edits files whole, however they are narrowed. */
const widened = <T>(f: () => T): T =>
  e8.saveRestriction(() => {
    e8.widen();
    return f();
  });

/** A date range, <a>--<b>, as org-tr-regexp matches one. */
const RANGE = /(<\d{4}-\d{2}-\d{2}[^>\n]*>)--(<\d{4}-\d{2}-\d{2}[^>\n]*>)/g;

/** The current buffer's headings as the agenda reads them, and its category. */
function scanBuffer(): { cat: string; entries: Scanned[] } {
  const all = headings();
  const cats = categories(all);
  const stamp = /<\d{4}-\d{2}-\d{2}[^>\n]*>/g;
  const entries = all.map((h, i): Scanned => {
    const stamps: Scanned["stamps"] = [];
    const ranges: Scanned["ranges"] = [];
    const end = entryEnd(all, i);
    for (let l = h.line; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      if (l === h.line + 1 && PLANNING.test(e8.lineText(l))) continue;
      const text = e8.lineText(l);
      if (!text.includes("<")) continue;
      // A range's ends belong to the range, which shows on every day of it, as org-agenda-get-blocks has it.
      const inRange: [number, number][] = [];
      for (const m of allMatches(RANGE, text)) {
        const [a, b] = [activeTimestamp(m[1]), activeTimestamp(m[2])];
        if (a === undefined || b === undefined) continue;
        inRange.push([m.index, m.index + m[0].length]);
        ranges.push({ first: a.day, last: b.day, from: m[1], to: m[2], pos: at(l, text, m.index) });
      }
      for (const m of allMatches(stamp, text)) {
        if (inRange.some(([a, b]) => m.index >= a && m.index < b)) continue;
        const ts = activeTimestamp(m[0]);
        if (ts) stamps.push({ ts, pos: at(l, text, m.index), inHeading: l === h.line, text: m[0] });
      }
    }
    const plan = planningOf(h);
    // Only a scheduled entry can be a habit, so only those have their properties read.
    const habit = plan.scheduled !== undefined ? parseHabit(h) : undefined;
    return { h, done: isDone(h.todo), plan, priority: priorityValue(h), stamps, ranges, cat: cats[i], ...(habit ? { habit } : {}) };
  });
  return { cat: category(), entries };
}

/** The items for a day from the current buffer, scanned once, as org-agenda-get-day-entries collects them. */
function dayItems(scan: { cat: string; entries: Scanned[] }, day: number, today: number, buffer: string): AgendaItem[] {
  const deadlines: AgendaItem[] = [];
  const scheduled: AgendaItem[] = [];
  const stamps: AgendaItem[] = [];
  const blocks: AgendaItem[] = [];
  for (const { h, done, plan, priority, stamps: found, ranges, habit, cat } of scan.entries) {
    // Each day of a range, numbered, with the time it starts on its first
    // day and ends on its last, as org-agenda-get-blocks has them.
    for (const r of ranges) {
      if (day < r.first || day > r.last) continue;
      const leader = r.first === r.last ? "" : `(${day - r.first + 1}/${r.last - r.first + 1}): `;
      const [from, to] = [timeOf(r.from), timeOf(r.to)];
      const time = r.first === day && r.last === day && from && to
        ? { field: `${from.field.replace(gridDots(), "")}-${to.field.replace(gridDots(), "").trim()}`, minutes: from.minutes }
        : r.first === day ? from : r.last === day ? to : undefined;
      const item = { cat, leader, removeTimestamp: false, buffer, pos: r.pos, heading: h.start, ...(time ? { time } : {}) };
      blocks.push({ ...item, text: agendaLine(h, cat, leader, false, time), urgency: priority });
    }
    if (plan.deadline !== undefined) {
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
        const item = { cat, leader, removeTimestamp: false, buffer, pos: plan.deadlineAt ?? h.start, heading: h.start, ...(time ? { time } : {}) };
        deadlines.push({ ...item, text: agendaLine(h, cat, leader, false, time), urgency: priority - (day === today ? diff : 0) });
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
        const item = { cat, leader, removeTimestamp: false, buffer, pos: plan.scheduledAt ?? h.start, heading: h.start, ...(time ? { time } : {}) };
        const urgency = habit !== undefined ? habitUrgency(habit, today) : 99 + (past ? diff : 0) + priority;
        scheduled.push({ ...item, text: agendaLine(h, cat, leader, false, time), urgency, ...(habit ? { habit } : {}) });
      }
    }
    // The first active timestamp in the heading and its entry on the day.
    const stamp = found.find((s) => occursOn(s.ts, day));
    if (stamp) {
      const time = timeOf(stamp.text);
      const item = { cat, leader: "", removeTimestamp: stamp.inHeading, buffer, pos: stamp.pos, heading: h.start, ...(time ? { time } : {}) };
      stamps.push({ ...item, text: agendaLine(h, cat, "", stamp.inHeading, time), urgency: priority });
    }
  }
  return [...deadlines, ...scheduled, ...blocks, ...stamps];
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
  | { kind: "week"; start: number }
  | { kind: "todo" }
  | { kind: "tags"; todoOnly: boolean; match: string }
  | { kind: "search"; todoOnly: boolean; todoOnlyArg: boolean; string: string; boolean: boolean } = { kind: "todo" };
let agendaLines: (AgendaItem | undefined)[] = [];

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
function showAgenda(lines: { text: string; item?: AgendaItem }[], pointLine: number): void {
  e8.getBufferCreate(AGENDA);
  e8.withCurrentBuffer(AGENDA, () => {
    e8.setReadOnly(false);
    eraseBuffer();
    e8.insert(lines.map((l) => l.text).join("\n") + "\n");
    insertHabitGraphs(lines);
    if (e8.variable("major-mode") !== "org-agenda-mode") e8.call("org-agenda-mode");
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
  for (const item of agendaLines) {
    if (item && e8.getBuffer(item.buffer)) {
      item.marks = {
        pos: e8.makeMarker(item.pos, { buffer: item.buffer }),
        heading: e8.makeMarker(item.heading, { buffer: item.buffer }),
      };
    }
  }
  const setup = e8.variable("org-agenda-window-setup");
  if (e8.windowBuffer() !== AGENDA) {
    if (setup === "current-window") e8.call("switch-to-buffer", AGENDA);
    else if (setup === "only-window") {
      e8.call("delete-other-windows");
      e8.call("switch-to-buffer", AGENDA);
    } else if (setup === "other-window") e8.call("switch-to-buffer-other-window", AGENDA);
    else {
      // As org-agenda-window-setup's reorganize-frame: this window and the agenda's.
      if (!e8.windowList().some((w) => e8.windowBuffer(w) === AGENDA)) e8.call("delete-other-windows");
      e8.call("pop-to-buffer", AGENDA);
    }
  }
  if (setup === undefined || setup === null || setup === "reorganize-frame") fitAgendaWindow(lines.length);
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

/** The week's agenda from a day, as org-agenda-list shows it for org-agenda-span week. */
function weekAgenda(start: number): void {
  const today = dayNumber(today_());
  const buffers = agendaBuffers();
  const lines: { text: string; item?: AgendaItem }[] = [{ text: `Week-agenda (W${String(isoWeekOf(start)).padStart(2, "0")}):` }];
  let pointLine = 0;
  // Each file read once for the week, not once a day.
  const scans = new Map(buffers.map((buffer) => [buffer, e8.withCurrentBuffer(buffer, () => widened(scanBuffer))]));
  for (let day = start; day < start + 7; day++) {
    const d = dayFromNumber(day);
    const wd = new Date(day * 86400000).getUTCDay();
    if (day === today) pointLine = lines.length;
    const week = wd === 1 ? ` W${String(isoWeekOf(day)).padStart(2, "0")}` : "";
    lines.push({ text: `${AGENDA_DAYS[wd].padEnd(10)} ${String(d.day).padStart(2)} ${AGENDA_MONTHS[d.month - 1]} ${d.year}${week}` });
    const items: AgendaItem[] = [];
    for (const buffer of buffers) items.push(...e8.withCurrentBuffer(buffer, () => dayItems(scans.get(buffer)!, day, today, buffer)));
    const sorted = byUrgency(items);
    const grid = day === today ? timeGrid(sorted) : [];
    // Each grid line after the entries at its time or earlier, as a stable sort puts it.
    for (const item of sorted) {
      while (grid.length > 0 && item.time !== undefined && grid[0].minutes < item.time.minutes) lines.push({ text: grid.shift()!.text });
      if (item.time === undefined) while (grid.length > 0) lines.push({ text: grid.shift()!.text });
      lines.push({ text: item.text, item });
    }
    for (const g of grid) lines.push({ text: g.text });
  }
  agendaView = { kind: "week", start };
  showAgenda(lines, pointLine);
}

/**
 * Today's time grid, as org-agenda-add-time-grid-maybe draws it with the
 * default org-agenda-time-grid: a line at each of its times, and one for
 * the time now, when the day has entries with times.
 */
function timeGrid(items: AgendaItem[]): { text: string; minutes: number }[] {
  if (e8.variable("org-agenda-use-time-grid") === null || e8.variable("org-agenda-use-time-grid") === false) return [];
  const spec = e8.variable("org-agenda-time-grid");
  const [when, times, , rule] = Array.isArray(spec) ? spec : [];
  const conditions = Array.isArray(when) ? when.map(String) : [];
  if (conditions.includes("require-timed") && !items.some((i) => i.time !== undefined)) return [];
  const blank = " ".repeat(14);
  const out: { text: string; minutes: number }[] = (Array.isArray(times) ? times : []).map((t) => {
    const [h, m] = [Math.floor(Number(t) / 100), Number(t) % 100];
    return { text: `${blank}${clockTime(h, m)}${gridDots()} ${typeof rule === "string" ? rule : "----------------"}`, minutes: h * 60 + m };
  });
  const showNow = e8.variable("org-agenda-show-current-time-in-grid");
  if (showNow !== null && showNow !== false) {
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

/** The week org-agenda-list starts with: the Monday on or before today. */
function weekStart(day: number): number {
  return day - ((new Date(day * 86400000).getUTCDay() + 6) % 7);
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
  const anyStamp = /<([0-9]{4}-[0-9]{2}-[0-9]{2}(?: .*?)?)>/;
  if (truthy(withDate) && anyStamp.test(text)) return true;
  const sched = /\bSCHEDULED: *<([^>]+)>/.exec(text);
  if (truthy(scheduled) && sched && ignoredBy(scheduled, sched[1])) return true;
  const dl = /\bDEADLINE: *<([^>]+)>/.exec(text);
  if (truthy(deadlines) && dl) {
    // Due soon, as org-deadline-close-p: within its warning days, and not done.
    const close = () => timestampToNow(dl[1]) < wdays(dl[1], false) && !done;
    if (deadlines === "all") return true;
    if (deadlines === "far") {
      if (!close()) return true;
    } else if (deadlines === "future" || deadlines === "past" || typeof deadlines === "number") {
      if (ignoredBy(deadlines, dl[1])) return true;
    } else if (close()) return true;
  }
  if (truthy(stamps)) {
    // The first timestamp that is no planning one.
    const other = anyStamp.exec(text.replace(/\bSCHEDULED: *<[^>]+>|\bDEADLINE: *<[^>]+>/g, ""));
    if (other && ignoredBy(stamps, other[1])) return true;
  }
  return false;
}

// For org-scan-tags, which org.ts has, with org-agenda-tags-todo-honor-ignore-options.
e8.defun("org-agenda-check-for-timestamp-as-reason-to-ignore-todo-item", (end?: number | null) => {
  const all = headings();
  const i = headingIndex(all, e8.lineOf(e8.point()));
  const start = i === undefined ? e8.point() : all[i].start;
  const stop = typeof end === "number" ? end : (all[(i ?? -1) + 1]?.start ?? e8.pointMax());
  return ignoreTodoForTimestamp(start, stop, i !== undefined && isDone(all[i].todo)) || null;
});

/** The TODO items that are not done, as org-todo-list shows them. */
function todoList(): void {
  const buffers = agendaBuffers();
  const items: AgendaItem[] = [];
  const keywords = new Set<string>();
  const sublevels = truthy(e8.variable("org-agenda-todo-list-sublevels") ?? null);
  for (const buffer of buffers) {
    e8.withCurrentBuffer(buffer, () => widened(() => {
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
        const item = { cat, leader: "", removeTimestamp: false, buffer, pos: h.start, heading: h.start };
        items.push({ ...item, text: agendaLine(h, cat, "", false), urgency: 1 + priorityValue(h) });
      }
    }));
  }
  const sorted = [...keywords].sort();
  const lines: { text: string; item?: AgendaItem }[] = [
    { text: "Global list of TODO items of type: ALL" },
    { text: `Press \u2018N r\u2019 (e.g. \u20180 r\u2019) to search again: (0)[ALL] ${sorted.map((k, i) => `(${i + 1})${k}`).join(" ")}` },
  ];
  for (const item of byUrgency(items)) lines.push({ text: item.text, item });
  agendaView = { kind: "todo" };
  showAgenda(lines, 0);
}

/**
 * The headings the agenda leaves out, as org-agenda-skip does: those in a
 * subtree tagged ARCHIVE, or every one with ARCHIVE among the file's tags,
 * while org-agenda-skip-archived-trees is on, and those in a COMMENT
 * subtree while org-agenda-skip-comment-trees is.
 */
function skippedHeadings(all: Heading[]): boolean[] {
  const tag = String(e8.variable("org-archive-tag") ?? "ARCHIVE");
  const archived = e8.variable("org-agenda-skip-archived-trees") !== false && e8.variable("org-agenda-skip-archived-trees") !== null;
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
      (archived && h.tags.includes(tag)) ||
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
  if (match !== undefined && !/\S/.test(match)) match = undefined;
  // Read where org-agenda was called from, as org-make-tags-matcher reads it before the agenda is prepared.
  const matcher = makeTagsMatcher(match, todoOnly);
  const items: AgendaItem[] = [];
  for (const buffer of agendaBuffers()) {
    e8.withCurrentBuffer(buffer, () =>
      widened(() => {
        if (e8.variable("major-mode") !== "org-mode" && !e8.derivedModeP("org-mode")) throw new Error(`Agenda file ${e8.bufferFileName()} is not in Org mode`);
        const all = headings();
        const cats = categories(all);
        const skipped = skippedHeadings(all);
        const indented = e8.variable("org-tags-match-list-sublevels") === "indented";
        scanTags(
          (h) => {
            const i = headingIndex(all, h.line)!;
            if (skipped[i]) return;
            const cat = cats[i];
            const prefix = indented ? ".".repeat(h.level - 1) : "";
            const item = { cat, leader: "", removeTimestamp: false, buffer, pos: h.start, heading: h.start };
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
  const files = (Array.isArray(extra) ? extra : []).filter((f): f is string => typeof f === "string");
  const buffers = agendaBuffers();
  for (const file of files) {
    const buffer = e8.findFileNoselect(e8.expandFileName(file));
    if (!buffers.includes(buffer)) buffers.push(buffer);
  }
  const items: AgendaItem[] = [];
  for (const buffer of buffers) {
    e8.withCurrentBuffer(buffer, () =>
      widened(() =>
        e8.saveExcursion(() => {
          if (e8.variable("major-mode") !== "org-mode" && !e8.derivedModeP("org-mode")) throw new Error(`Agenda file ${e8.bufferFileName()} is not in Org mode`);
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
              const item = { cat, leader: "", removeTimestamp: false, buffer, pos: h.start, heading: h.start };
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

function redoAgenda(): void {
  const line = e8.lineOf(e8.point());
  if (agendaView.kind === "week") weekAgenda(agendaView.start);
  // C-u r asks for the match again, as the tags view's redo command does.
  else if (agendaView.kind === "tags") tagsView(agendaView.todoOnly, e8.prefixArg() !== null && e8.prefixArg() !== undefined ? undefined : agendaView.match);
  // And the search view's, for the string.
  else if (agendaView.kind === "search") searchView(agendaView.todoOnlyArg, e8.prefixArg() !== null && e8.prefixArg() !== undefined ? undefined : agendaView.string);
  else todoList();
  e8.gotoChar(e8.lineStart(Math.min(line, e8.lineCount() - 1)));
}

const agendaList = e8.defineCommand({
  name: "org-agenda-list",
  doc: "Show the week's agenda: what is scheduled, due and timestamped each day, from org-agenda-files.",
  run: () => weekAgenda(weekStart(dayNumber(today_()))),
});

const todoListCommand = e8.defineCommand({
  name: "org-todo-list",
  doc: "Show the TODO items that are not done in org-agenda-files, most urgent first.",
  run: () => todoList(),
});

const tagsViewCommand = e8.defineCommand({
  name: "org-tags-view",
  doc:
    "Show the headings in org-agenda-files a match picks: tags, properties and TODO states, as C-c \\ in Org reads it. " +
    "With a prefix argument, only those with a TODO state not done.",
  params: [{ name: "todoOnly", kind: "prefix" }],
  run: (todoOnly) => tagsView(todoOnly !== null && todoOnly !== undefined),
});

const searchViewCommand = e8.defineCommand({
  name: "org-search-view",
  doc:
    "Show the entries in org-agenda-files that a phrase picks, or a Boolean search: words and {regexps} each needed, or with - " +
    "not wanted, \"quoted\" for spaces. Starting with * looks in headings only, ! at TODO entries only, : for whole words. " +
    "With a prefix argument, only TODO entries not done.",
  params: [{ name: "todoOnly", kind: "prefix" }],
  run: (todoOnly) => searchView(todoOnly !== null && todoOnly !== undefined),
});

/**
 * Adds to the search view's string and asks for it again, as
 * org-agenda-manipulate-query: in a Boolean search, " +" or " -" for a
 * word, " +{}" or " -{}" for a regexp, with point inside the braces.
 */
function manipulateQuery(char: string): void {
  if (agendaView.kind !== "search") {
    const type = agendaView.kind === "week" ? "agenda" : agendaView.kind;
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
    const link = e8.conditionCase(
      () => storeLink(null, false),
      { error: () => e8.signal("error", "Unable to create a link to here") as never },
    );
    e8.call(occurInAgendaFiles, regexpQuote(typeof link === "string" ? link : ""));
  },
});

e8.defineCommand({
  name: "org-agenda",
  doc:
    "Show an agenda view, asking which by its key in *Agenda Commands*: a for the week's agenda, t for the TODO list, m for the headings a tags match picks, " +
    "M for those with a TODO state not done, s for the entries a search picks, S for those with a TODO state not done.",
  run: () => {
    const key = agendaDispatch();
    if (key === "a") weekAgenda(weekStart(dayNumber(today_())));
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
  e8.withCurrentBuffer(AGENDA, () => e8.letBind({ "inhibit-read-only": true }, () => {
    const point = e8.point();
    for (const [l, other] of agendaLines.entries()) {
      if (!other || other.buffer !== item.buffer || headingOf(other) !== heading) continue;
      const text = e8.withCurrentBuffer(item.buffer, () => widened(() => {
        const h = headings().find((x) => x.start === heading);
        // Without the tags view's dots, as org-agenda-change-all-lines writes the line from the heading alone.
        return h ? agendaLine(h, other.cat, other.leader, other.removeTimestamp, other.time) : other.text;
      }));
      other.text = text;
      e8.deleteRegion(e8.lineStart(l), e8.lineEnd(l));
      e8.gotoChar(e8.lineStart(l));
      e8.insert(text);
    }
    e8.gotoChar(point);
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
  ["org-agenda-priority", "org-priority", "Set the priority of the entry the agenda line at point shows."],
] as const) {
  e8.defineCommand({ name, doc, run: () => atEntry(command as e8.CommandName) });
}
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

const agendaNext = e8.defineCommand({
  name: "org-agenda-next-line",
  doc: "Move to the next line of the agenda.",
  run: () => e8.callWithPrefix(e8.prefixArg(), "next-line"),
});
const agendaPrevious = e8.defineCommand({
  name: "org-agenda-previous-line",
  doc: "Move to the previous line of the agenda.",
  run: () => e8.callWithPrefix(e8.prefixArg(), "previous-line"),
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
  run: () => {
    const item = agendaItemHere();
    e8.call("pop-to-buffer", item.buffer);
    e8.widen();
    e8.pushMark(e8.point());
    e8.gotoChar(posOf(item));
    // At the heading's title, as org-agenda-goto leaves it.
    const heading = headingOf(item);
    const h = headings().find((x) => x.start === heading);
    if (h) e8.gotoChar(h.titleAt);
  },
});

const agendaTodo = e8.defineCommand({
  name: "org-agenda-todo",
  doc: "Change the TODO state of the entry the agenda line at point shows, as C-c C-t does there.",
  run: () => {
    const item = agendaItemHere();
    e8.withCurrentBuffer(item.buffer, () => widened(() => {
      e8.gotoChar(headingOf(item));
      e8.callWithPrefix(e8.prefixArg(), "org-todo");
    }));
    redrawEntry(item);
  },
});

const agendaRedo = e8.defineCommand({
  name: "org-agenda-redo",
  doc: "Rebuild the agenda from the files, as they are now.",
  run: () => redoAgenda(),
});

/** Which day of the week view point's line is under, counting from 0. */
function agendaDayIndex(): number {
  let index = -1;
  for (let l = 1; l <= e8.lineOf(e8.point()); l++) if (agendaLines[l] === undefined) index++;
  return Math.max(0, index);
}

/** Moves the week view by weeks, to the same day of the week, as org-agenda-later does. */
function shiftWeek(weeks: number): void {
  if (agendaView.kind !== "week") throw new Error("Not allowed in this agenda");
  const index = agendaDayIndex();
  weekAgenda(agendaView.start + 7 * weeks);
  let seen = -1;
  for (let l = 1; l < agendaLines.length; l++) {
    if (agendaLines[l] === undefined && ++seen === index) {
      e8.gotoChar(e8.lineStart(l));
      break;
    }
  }
}

const agendaLater = e8.defineCommand({
  name: "org-agenda-later",
  doc: "Show the next week in the agenda.",
  run: () => shiftWeek(e8.prefixNumericValue()),
});
const agendaEarlier = e8.defineCommand({
  name: "org-agenda-earlier",
  doc: "Show the week before in the agenda.",
  run: () => shiftWeek(-e8.prefixNumericValue()),
});
const agendaToday = e8.defineCommand({
  name: "org-agenda-goto-today",
  doc: "Show the week with today in it, and go to today.",
  run: () => {
    if (agendaView.kind !== "week") throw new Error("Not allowed in this agenda");
    weekAgenda(weekStart(dayNumber(today_())));
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
    "another window, t changes its TODO state, g rebuilds the agenda, f and b move a week, . goes to today, " +
    "and q leaves.",
  // Lines run off the window, and n and p move by them, as org-agenda-mode sets up.
  setup: () => {
    if (truthy(e8.variable("org-startup-truncated"))) e8.setVariable("truncate-lines", true);
    e8.makeLocalVariable("line-move-visual");
    e8.setVariable("line-move-visual", null);
  },
  bindings: {
    n: agendaNext,
    p: agendaPrevious,
    RET: agendaSwitchTo,
    TAB: agendaGoto,
    t: agendaTodo,
    g: agendaRedo,
    r: agendaRedo,
    f: agendaLater,
    b: agendaEarlier,
    ".": agendaToday,
    q: agendaQuit,
    x: agendaQuit,
    I: "org-agenda-clock-in",
    O: "org-agenda-clock-out",
    X: "org-agenda-clock-cancel",
    J: "org-agenda-clock-goto",
    ":": "org-agenda-set-tags",
    ",": "org-agenda-priority",
    w: "org-agenda-refile",
    ...Object.fromEntries(queryCommands),
  },
});

void agendaList;
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
