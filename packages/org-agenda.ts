// The agenda, after Emacs's org-agenda.el: the week's scheduled items,
// deadlines and timestamps from org-agenda-files, and the list of TODO
// items, in the *Org Agenda* buffer, whose keys act on the entries they show.

import { type DateTime, type Heading, PLANNING, allKeywords, at, entryEnd, headings, isDone, keywordLines, today } from "org";
import { type Habit, buildGraph, habitUrgency, parseHabit } from "org-habit";
import { allMatches, charCount } from "subr";

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
  name: "org-deadline-warning-days",
  doc: "How many days ahead today's agenda warns of a deadline.",
  value: 14,
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

/** The buffer's category, as org-get-category gives it: #+CATEGORY, or the file's name. */
function category(): string {
  for (let l = 0; l < e8.lineCount(); l++) {
    const m = /^#\+CATEGORY:[ \t]*(\S.*?)[ \t]*$/i.exec(e8.lineText(l));
    if (m) return m[1];
  }
  const file = e8.bufferFileName();
  return file ? (file.split("/").pop() ?? file).replace(/\.[^.]*$/, "") : "???";
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

function agendaLine(h: Heading, cat: string, leader: string, removeTimestamp: boolean): string {
  let text = e8.lineText(h.line).replace(/^\*+[ \t]+/, "");
  if (h.tagsAt !== undefined) text = text.slice(0, text.length - (e8.lineEnd(h.line) - h.tagsAt) - 0).replace(/[ \t]+$/, "");
  if (removeTimestamp) text = text.replace(/<\d{4}-\d{2}-\d{2}[^>\n]*>/, "");
  const line = `  ${`${cat}:`.padEnd(12)}${leader === "" ? "" : `${leader} `}${text}`;
  const tags = displayedTags(h);
  if (tags === "") return line;
  const width = (e8.windowSize()?.width ?? 80) - 1;
  return line + " ".repeat(Math.max(1, width - charCount(line) - charCount(tags))) + tags;
}

/** The buffers of org-agenda-files, visited if need be. */
function agendaBuffers(): string[] {
  const files = e8.variable("org-agenda-files");
  if (!Array.isArray(files) || files.length === 0) return [];
  // Relative names are in org-directory, as org-agenda-files expands them.
  const dir = e8.variable("org-directory");
  return (files as string[]).map((file) => e8.findFileNoselect(e8.expandFileName(String(file), typeof dir === "string" ? e8.expandFileName(dir) : undefined)));
}

/** A heading's planning timestamps: when it is scheduled and due, and where those timestamps are. */
function planningOf(h: Heading): {
  scheduled?: number;
  deadline?: number;
  scheduledRepeat?: [number, string];
  scheduledAt?: number;
  deadlineAt?: number;
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
    out.scheduledAt = at(line, text, (s.index ?? 0) + s[0].length - s[1].length);
  }
  const dt = d && activeTimestamp(d[1]);
  if (d && dt) {
    out.deadline = dt.day;
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
  stamps: { ts: { day: number; repeat?: [number, string] }; pos: number; inHeading: boolean }[];
  habit?: Habit;
}

/** The current buffer's headings as the agenda reads them, and its category. */
function scanBuffer(): { cat: string; entries: Scanned[] } {
  const all = headings();
  const stamp = /<\d{4}-\d{2}-\d{2}[^>\n]*>/g;
  const entries = all.map((h, i): Scanned => {
    const stamps: Scanned["stamps"] = [];
    const end = entryEnd(all, i);
    for (let l = h.line; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      if (l === h.line + 1 && PLANNING.test(e8.lineText(l))) continue;
      const text = e8.lineText(l);
      if (!text.includes("<")) continue;
      for (const m of allMatches(stamp, text)) {
        const ts = activeTimestamp(m[0]);
        if (ts) stamps.push({ ts, pos: at(l, text, m.index), inHeading: l === h.line });
      }
    }
    const plan = planningOf(h);
    // Only a scheduled entry can be a habit, so only those have their properties read.
    const habit = plan.scheduled !== undefined ? parseHabit(h) : undefined;
    return { h, done: isDone(h.todo), plan, priority: priorityValue(h), stamps, ...(habit ? { habit } : {}) };
  });
  return { cat: category(), entries };
}

/** The items for a day from the current buffer, scanned once, as org-agenda-get-day-entries collects them. */
function dayItems(scan: { cat: string; entries: Scanned[] }, day: number, today: number, buffer: string): AgendaItem[] {
  const cat = scan.cat;
  const warning = Number(e8.variable("org-deadline-warning-days") ?? 14);
  const deadlines: AgendaItem[] = [];
  const scheduled: AgendaItem[] = [];
  const stamps: AgendaItem[] = [];
  for (const { h, done, plan, priority, stamps: found, habit } of scan.entries) {
    if (plan.deadline !== undefined) {
      const diff = plan.deadline - day;
      let leader: string | undefined;
      if (diff === 0) leader = "Deadline:  ";
      else if (day === today && !done && diff > 0 && diff <= warning) leader = `In ${String(diff).padStart(3)} d.: `;
      else if (day === today && !done && diff < 0) leader = `${String(-diff).padStart(2)} d. ago: `;
      if (leader !== undefined) {
        const item = { cat, leader, removeTimestamp: false, buffer, pos: plan.deadlineAt ?? h.start, heading: h.start };
        deadlines.push({ ...item, text: agendaLine(h, cat, leader, false), urgency: priority - (day === today ? diff : 0) });
      }
    }
    if (plan.scheduled !== undefined) {
      // A repeater's later dates show only after today; up to today, the
      // item counts from its base date, as org-agenda-get-scheduled has it.
      const ts = { day: plan.scheduled, repeat: plan.scheduledRepeat };
      const diff = day - plan.scheduled;
      const onDay = day === plan.scheduled || (day > today && occursOn(ts, day));
      const past = day === today && plan.scheduled < today && !done;
      // A habit shows only today, as org-habit-show-habits-only-for-today says.
      const hidden = habit !== undefined && (done || e8.variable("org-habit-show-habits") !== true ||
        (e8.variable("org-habit-show-habits-only-for-today") === true && day !== today));
      if (((onDay && !(done && plan.scheduled !== day)) || past) && !hidden) {
        // A habit has no leader, its graph saying when it is due, and is as urgent as org-habit-get-urgency says.
        const leader = habit !== undefined ? "" : past ? `Sched.${String(diff).padStart(2)}x: ` : "Scheduled: ";
        const item = { cat, leader, removeTimestamp: false, buffer, pos: plan.scheduledAt ?? h.start, heading: h.start };
        const urgency = habit !== undefined ? habitUrgency(habit, today) : 99 + (past ? diff : 0) + priority;
        scheduled.push({ ...item, text: agendaLine(h, cat, leader, false), urgency, ...(habit ? { habit } : {}) });
      }
    }
    // The first active timestamp in the heading and its entry on the day.
    const stamp = found.find((s) => occursOn(s.ts, day));
    if (stamp) {
      const item = { cat, leader: "", removeTimestamp: stamp.inHeading, buffer, pos: stamp.pos, heading: h.start };
      stamps.push({ ...item, text: agendaLine(h, cat, "", stamp.inHeading), urgency: priority });
    }
  }
  return [...deadlines, ...scheduled, ...stamps];
}

/** Sorts a day's items with habits last, as org-agenda-sorting-strategy's habit-down, then by urgency, most urgent first, keeping their order otherwise. */
function byUrgency(items: AgendaItem[]): AgendaItem[] {
  const habit = (i: AgendaItem) => (i.habit !== undefined ? 1 : 0);
  return items
    .map((item, k) => ({ item, k }))
    .sort((a, b) => habit(a.item) - habit(b.item) || b.item.urgency - a.item.urgency || a.k - b.k)
    .map((x) => x.item);
}

/** What the agenda buffer shows, for its keys to act on and g to rebuild. */
let agendaView: { kind: "week"; start: number } | { kind: "todo" } = { kind: "todo" };
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
    e8.deleteRegion(0, e8.bufferSize());
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
  const scans = new Map(buffers.map((buffer) => [buffer, e8.withCurrentBuffer(buffer, scanBuffer)]));
  for (let day = start; day < start + 7; day++) {
    const d = dayFromNumber(day);
    const wd = new Date(day * 86400000).getUTCDay();
    if (day === today) pointLine = lines.length;
    const week = wd === 1 ? ` W${String(isoWeekOf(day)).padStart(2, "0")}` : "";
    lines.push({ text: `${AGENDA_DAYS[wd].padEnd(10)} ${String(d.day).padStart(2)} ${AGENDA_MONTHS[d.month - 1]} ${d.year}${week}` });
    const items: AgendaItem[] = [];
    for (const buffer of buffers) items.push(...e8.withCurrentBuffer(buffer, () => dayItems(scans.get(buffer)!, day, today, buffer)));
    for (const item of byUrgency(items)) lines.push({ text: item.text, item });
  }
  agendaView = { kind: "week", start };
  showAgenda(lines, pointLine);
}

/** Today, as the agenda counts it. */
function today_(): DateTime {
  return today();
}

/** The week org-agenda-list starts with: the Monday on or before today. */
function weekStart(day: number): number {
  return day - ((new Date(day * 86400000).getUTCDay() + 6) % 7);
}

/** The TODO items that are not done, as org-todo-list shows them. */
function todoList(): void {
  const buffers = agendaBuffers();
  const items: AgendaItem[] = [];
  const keywords = new Set<string>();
  for (const buffer of buffers) {
    e8.withCurrentBuffer(buffer, () => {
      const cat = category();
      for (const k of allKeywords()) keywords.add(k);
      for (const h of headings()) {
        if (h.todo === undefined || isDone(h.todo)) continue;
        const item = { cat, leader: "", removeTimestamp: false, buffer, pos: h.start, heading: h.start };
        items.push({ ...item, text: agendaLine(h, cat, "", false), urgency: 1 + priorityValue(h) });
      }
    });
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

function redoAgenda(): void {
  const line = e8.lineOf(e8.point());
  if (agendaView.kind === "week") weekAgenda(agendaView.start);
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

e8.defineCommand({
  name: "org-agenda",
  doc: "Show an agenda view, asking which by its key in *Agenda Commands*: a for the week's agenda, t for the TODO list.",
  run: () => {
    const key = agendaDispatch();
    if (key === "a") weekAgenda(weekStart(dayNumber(today_())));
    else if (key === "t") todoList();
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
        e8.deleteRegion(0, e8.bufferSize());
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
      const text = e8.withCurrentBuffer(item.buffer, () => {
        const h = headings().find((x) => x.start === heading);
        return h ? agendaLine(h, other.cat, other.leader, other.removeTimestamp) : other.text;
      });
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
    e8.saveExcursion(() => {
      e8.gotoChar(headingOf(item));
      if (interactive) e8.callInteractively(command);
      else e8.call(command);
    });
  });
  redrawEntry(item);
}

for (const [name, command, doc] of [
  ["org-agenda-clock-in", "org-clock-in", "Start a clock on the entry the agenda line at point shows."],
  ["org-agenda-set-tags", "org-set-tags-command", "Set the tags of the entry the agenda line at point shows."],
  ["org-agenda-priority", "org-priority", "Set the priority of the entry the agenda line at point shows."],
  ["org-agenda-refile", "org-refile", "Refile the entry the agenda line at point shows."],
] as const) {
  e8.defineCommand({ name, doc, run: () => atEntry(command as e8.CommandName) });
}
e8.defineCommand({ name: "org-agenda-clock-out", doc: "Stop the running clock, from the agenda.", run: () => e8.call("org-clock-out") });
e8.defineCommand({ name: "org-agenda-clock-cancel", doc: "Cancel the running clock, from the agenda.", run: () => e8.call("org-clock-cancel") });
e8.defineCommand({ name: "org-agenda-clock-goto", doc: "Go to the entry with the running clock, from the agenda.", run: () => e8.call("org-clock-goto") });

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
    e8.gotoChar(posOf(item));
  },
});

const agendaGoto = e8.defineCommand({
  name: "org-agenda-goto",
  doc: "Show the entry the agenda line at point shows in another window, and go there.",
  run: () => {
    const item = agendaItemHere();
    e8.call("pop-to-buffer", item.buffer);
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
    e8.withCurrentBuffer(item.buffer, () => {
      e8.gotoChar(headingOf(item));
      e8.callWithPrefix(e8.prefixArg(), "org-todo");
    });
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
  },
});

void agendaList;
void todoListCommand;
