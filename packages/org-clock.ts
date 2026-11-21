// Clocking time on Org entries, after Org's org-clock.el: C-c C-x C-i
// starts a clock on the entry at point, a CLOCK: line in its LOGBOOK drawer,
// and the mode line shows how long it has run; C-c C-x C-o stops it,
// writing the end and the duration; C-c C-x C-q cancels it and C-c C-x C-j
// goes back to its entry. Clock tables, the dynamic block
// #+BEGIN: clocktable, sum the clocked time by heading.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import {
  addLogNote,
  agendaFiles,
  combinePlists,
  createDblock,
  type DateTime,
  durationFromMinutes,
  dynamicBlockDefine,
  entryGetAt,
  findDblock,
  formatTimestamp,
  type Heading,
  headingIndex,
  headings,
  isDone,
  logDrawer,
  makeTagsMatcher,
  matchContexts,
  matcherTime,
  parseDate,
  plistGet,
  reducedLevel,
  tableSortLines,
  today,
  updateDblock,
} from "org";
import { elementAt } from "org-element";
import { showEntry, toggleDrawerOrBlock } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { setRunningClock } from "org-refile";
import { charCount, forwardLine, truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-clock-into-drawer", true, "Whether CLOCK: lines go into a drawer: t for LOGBOOK, or org-log-into-drawer's drawer if that names one, or the drawer's name.");
defvar("org-clock-out-when-done", true, "Whether marking the clocked entry done stops the clock.");
defvar("org-clock-out-remove-zero-time-clocks", false, "Whether a clock stopped after no time is taken out.");
defvar("org-log-note-clock-out", false, "Whether stopping a clock asks for a note, put after the CLOCK: line. #+STARTUP: lognoteclock-out or nolognoteclock-out says for a file.");
defvar("org-mode-line-string", "", "What the mode line shows of the running clock: its time and its entry's heading.");
e8.defineHook("org-clock-in-hook", "Functions called when a clock starts.");
e8.defineHook("org-clock-out-hook", "Functions called when a clock stops.");
e8.defineHook("org-clock-cancel-hook", "Functions called when a clock is cancelled.");
e8.defineFace({ name: "org-mode-line-clock", doc: "The running clock in the mode line.", attributes: { inherit: "mode-line" } });

/** The running clock: its CLOCK: line, its heading's title, and when it started. */
interface Clock {
  line: e8.Marker;
  heading: e8.Marker;
  title: string;
  start: number;
  /** Minutes clocked on the entry before, for the mode line, as org-clock-total-time. */
  before: number;
}

let clock: Clock | undefined;
/** Where the last clock ran, for C-c C-x C-j and C-c C-x C-x after it stops. */
let last: e8.Marker | undefined;
let timer: number | undefined;

/** Now, or the day tests fix at noon, as an Org time. */
function now(): DateTime {
  return today(true);
}

/** An Org time as milliseconds, to count minutes between, in E8's zone as Emacs's encode-time. */
function millis(t: DateTime): number {
  return e8.encodeTime([0, t.minute ?? 0, t.hour ?? 0, t.day, t.month, t.year, null, -1, null]) * 1000;
}


/**
 * The drawer CLOCK: lines go in, as org-clock-drawer-name: nil for none;
 * with org-clock-into-drawer t, the drawer notes go in, as the heading's
 * LOG_INTO_DRAWER or org-log-into-drawer names it, else LOGBOOK.
 */
function drawerName(h?: Heading): string | undefined {
  const into = e8.variable("org-clock-into-drawer");
  if (typeof into === "string" && into !== "") return into;
  if (into === null || into === false) return undefined;
  return logDrawer(h) ?? "LOGBOOK";
}

const CLOCK_LINE = /^[ \t]*CLOCK: \[(\d{4})-(\d\d)-(\d\d) \S+ (\d\d):(\d\d)\](?:--\[[^\]]*\] =>\s+(?:(\d+)d )?(\d+):(\d\d))?[ \t]*$/;

/** The heading point is in, or the error Org gives before the first. */
function headingHere(): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) e8.userError("Before first headline at position " + (e8.point() + 1) + " in buffer " + e8.bufferName());
  return [all, i];
}

/** The minutes the entry's closed clocks add up to, as org-clock-sum-current-item. */
function clockedBefore(all: Heading[], i: number): number {
  const end = all[i + 1]?.start ?? e8.bufferSize();
  let minutes = 0;
  for (let l = all[i].line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    const m = CLOCK_LINE.exec(e8.lineText(l));
    if (m && m[7] !== undefined) minutes += Number(m[6] ?? 0) * 1440 + Number(m[7]) * 60 + Number(m[8]);
  }
  return minutes;
}

/**
 * Where a new CLOCK: line goes, as org-clock-find-position: at the top of
 * the entry's drawer, which is made, folded, after its metadata if need be.
 * Returns the start of the line to put it before.
 */
function findPosition(all: Heading[], i: number): number {
  const h = all[i];
  const end = all[i + 1]?.start ?? e8.bufferSize();
  const drawer = drawerName(h);
  if (drawer !== undefined) {
    const opener = new RegExp(`^[ \\t]*:${drawer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*$`, "i");
    for (let l = h.line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      if (opener.test(e8.lineText(l))) return lineStartOrEnd(l + 1);
    }
  }
  // Without a drawer, before the entry's first CLOCK: line, if it has one.
  for (let l = h.line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    if (drawer === undefined && CLOCK_LINE.test(e8.lineText(l))) return e8.lineStart(l);
  }
  let at = endOfMetaData(h);
  if (at !== e8.lineStart(lineAt(at))) {
    e8.gotoChar(at);
    e8.insert("\n");
    at = e8.point();
  }
  if (drawer === undefined) return at;
  e8.gotoChar(at);
  e8.insert(`:${drawer}:\n:END:\n`);
  toggleDrawerOrBlock(lineAt(at), true);
  return e8.lineStart(lineAt(at) + 1);
}

/** Shows the clock in every mode line, as org-clock-update-mode-line. */
function updateModeLine(): void {
  if (!clock) return;
  const minutes = Math.max(0, Math.floor((millis(now()) - clock.start) / 60000)) + clock.before;
  e8.setVariable("org-mode-line-string", e8.propertize(`[${durationFromMinutes(minutes)}] (${clock.title}) `, { face: "org-mode-line-clock" }));
  const global = e8.variable("global-mode-string");
  const sym = e8.intern("org-mode-line-string");
  const list = Array.isArray(global) ? global : [""];
  if (!list.includes(sym)) e8.setVariable("global-mode-string", [...list, sym]);
}

/** Takes the clock out of the mode line. */
function clearModeLine(): void {
  const global = e8.variable("global-mode-string");
  const sym = e8.intern("org-mode-line-string");
  if (Array.isArray(global)) e8.setVariable("global-mode-string", global.filter((v) => v !== sym));
  if (timer !== undefined) e8.cancelTimer(timer);
  timer = undefined;
}

/** Whether a clock is running, as org-clocking-p. */
export const clockingP = (): boolean => clock !== undefined;

/** Where the running clock's entry is, its buffer and heading, or undefined. */
export function runningEntry(): { buffer: string; start: number } | undefined {
  const buffer = clock && e8.markerBuffer(clock.heading);
  const start = clock && e8.markerPosition(clock.heading);
  return buffer === undefined || start === undefined ? undefined : { buffer, start };
}

/** A heading's text with each link as its description, or its target if it has none, as the links show. */
function linkDescriptions(text: string): string {
  return text.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, l: string, d?: string) => d ?? l);
}

/** Starts a clock on the entry at point, stopping one running elsewhere, as org-clock-in. */
export function clockIn(): void {
  const [all, i] = headingHere();
  const h = all[i];
  if (clock) {
    const pos = e8.markerPosition(clock.heading);
    if (e8.markerBuffer(clock.heading) === e8.bufferName() && pos === h.start) {
      e8.message(`Clock continues in "${clock.title}"`);
      return;
    }
    clockOut();
  }
  const title = linkDescriptions(h.title);
  const before = clockedBefore(all, i);
  const start = now();
  const stamp = `[${formatTimestamp(start, true)}]`;
  e8.saveExcursion(() => {
    e8.saveRestriction(() => {
      e8.widen();
      const at = findPosition(headings(), headingIndex(headings(), h.line) as number);
      e8.gotoChar(at);
      e8.insert(`CLOCK: ${stamp}\n`);
      clock = { line: e8.makeMarker(at), heading: e8.makeMarker(h.start), title, start: millis(start), before };
    });
  });
  if (last) e8.deleteMarker(last);
  last = e8.makeMarker(h.start);
  updateModeLine();
  timer = e8.runWithTimer(60, 60, updateModeLine);
  e8.message(`Clock starts at ${stamp} - `);
  e8.runHooks("org-clock-in-hook");
}

/** Stops the running clock, writing its end and duration, as org-clock-out. */
export function clockOut(failQuietly = false): void {
  if (!clock) {
    clearModeLine();
    if (failQuietly) return;
    e8.userError("No active clock");
  }
  const running = clock;
  const buffer = e8.markerBuffer(running.line);
  if (buffer === undefined) {
    clock = undefined;
    clearModeLine();
    e8.signal("error", "Clock start time is gone");
  }
  const end = now();
  const te = `[${formatTimestamp(end, true)}]`;
  let removed = false;
  let minutes = 0;
  e8.withCurrentBuffer(buffer, () => {
    e8.saveExcursion(() => {
      e8.saveRestriction(() => {
        e8.widen();
        const line = lineAt(e8.markerPosition(running.line) ?? 0);
        const m = /^([ \t]*CLOCK: \[[^\]]*\])/.exec(e8.lineText(line));
        if (!m) e8.signal("error", "Clock start time is gone");
        const from = e8.lineStart(line) + m[1].length;
        minutes = Math.max(0, Math.floor((millis(end) - running.start) / 60000));
        e8.deleteRegion(from, e8.lineEnd(line));
        e8.gotoChar(from);
        e8.insert(`--${te} => ${String(Math.floor(minutes / 60)).padStart(2)}:${String(minutes % 60).padStart(2, "0")}`);
        if (minutes === 0 && e8.variable("org-clock-out-remove-zero-time-clocks") === true) {
          removed = true;
          e8.deleteRegion(e8.lineStart(line), lineStartOrEnd(line + 1));
          removeEmptyDrawer(line);
        } else if (truthy(e8.variable("org-log-note-clock-out"))) {
          // A note after the clock, as org-clock-out sets one up, the task named above it.
          const headingLine = lineAt(e8.markerPosition(running.heading) ?? 0);
          const task = e8.lineText(headingLine).replace(/^\*+[ \t]+/, "").replace(/[ \t]+:[\p{L}\p{N}_@#%:]+:[ \t]*$/u, "");
          addLogNote(headingLine, "clock-out", undefined, undefined, { extra: `# Task: ${task}\n\n`, at: e8.lineEnd(line) });
        }
      });
    });
  });
  e8.deleteMarker(running.line);
  e8.deleteMarker(running.heading);
  clock = undefined;
  clearModeLine();
  e8.message(`Clock stopped at ${te} after ${durationFromMinutes(minutes)}${removed ? " => LINE REMOVED" : ""}`);
  e8.runHooks("org-clock-out-hook");
}

/** Takes away the drawer the line before `line` opened, if it is now empty, as org-remove-empty-drawer-at: any drawer, whatever its name. */
function removeEmptyDrawer(line: number): void {
  if (line < 1) return;
  // In the whole buffer, as org-remove-empty-drawer-at's org-with-wide-buffer.
  e8.saveRestriction(() => {
    e8.widen();
    if (/^[ \t]*:[\w-]+:[ \t]*$/.test(e8.lineText(line - 1)) && !/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(line - 1)) && /^[ \t]*:END:[ \t]*$/i.test(e8.lineText(line))) {
      e8.deleteRegion(e8.lineStart(line - 1), lineStartOrEnd(line + 1));
    }
  });
}

e8.defineCommand({
  name: "org-clock-in",
  doc: "Start a clock on the entry point is in: a CLOCK: line in its LOGBOOK drawer, the time shown in the mode line. A clock running elsewhere stops first.",
  run: () => clockIn(),
});

e8.defineCommand({
  name: "org-clock-out",
  doc: "Stop the running clock, writing when it stopped and how long it ran.",
  run: () => clockOut(),
});

e8.defineCommand({
  name: "org-clock-cancel",
  doc: "Cancel the running clock, taking its CLOCK: line away.",
  run: () => {
    if (!clock) {
      e8.message("No active clock");
      return;
    }
    const running = clock;
    const buffer = e8.markerBuffer(running.line);
    if (buffer !== undefined) {
      e8.withCurrentBuffer(buffer, () => {
        e8.saveExcursion(() => {
          const pos = e8.markerPosition(running.line) ?? 0;
          const line = lineAt(pos);
          // A clock line outside the narrowing stays, as goto-char cannot
          // reach it in org-clock-cancel, which says so and stops anyway.
          // It goes with the newline before it, as org-clock-cancel deletes it.
          const inside = e8.lineStart(line) - 1 >= e8.pointMin() && e8.lineEnd(line) <= e8.pointMax() && pos <= e8.pointMax();
          if (inside && /^[ \t]*CLOCK: \[[^\]]*\][ \t]*$/.test(e8.lineText(line))) {
            e8.deleteRegion(e8.lineStart(line) - 1, e8.lineEnd(line));
            removeEmptyDrawer(line);
          } else e8.message("Clock gone, cancel the timer anyway");
        });
      });
    }
    e8.deleteMarker(running.line);
    e8.deleteMarker(running.heading);
    clock = undefined;
    clearModeLine();
    e8.message("Clock canceled");
    e8.runHooks("org-clock-cancel-hook");
  },
});

e8.defineCommand({
  name: "org-clock-goto",
  doc: "Go to the entry with the running clock, or the last one clocked.",
  run: () => {
    const target = clock?.heading ?? last;
    const buffer = target === undefined ? undefined : e8.markerBuffer(target);
    if (target === undefined || buffer === undefined) e8.userError("No active or recent clock task");
    e8.call("switch-to-buffer", buffer);
    e8.gotoChar(e8.markerPosition(target) ?? 0);
    e8.message(clock ? "Clock is running" : "No running clock, this is the most recently clocked task");
  },
});

e8.defineCommand({
  name: "org-clock-in-last",
  doc: "Start a clock again on the entry clocked last.",
  run: () => {
    if (clock) {
      e8.message(`Already clocking in on "${clock.title}"`);
      return;
    }
    const buffer = last === undefined ? undefined : e8.markerBuffer(last);
    if (last === undefined || buffer === undefined) e8.userError("No last clock");
    e8.withCurrentBuffer(buffer, () => {
      e8.saveExcursion(() => {
        e8.gotoChar(e8.markerPosition(last!) ?? 0);
        clockIn();
      });
    });
  },
});

// Marking the clocked entry done stops its clock, as org-clock-out-if-current does.
e8.addHook("org-after-todo-state-change-hook", () => {
  if (!clock || e8.variable("org-clock-out-when-done") !== true) return;
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined || e8.markerBuffer(clock.heading) !== e8.bufferName() || e8.markerPosition(clock.heading) !== all[i].start) return;
  // With no note for the clock, as org-clock-out-if-current binds org-log-note-clock-out.
  if (isDone(all[i].todo)) e8.letBind({ "org-log-note-clock-out": false }, () => clockOut(true));
});

// Before exiting, a running clock is offered to be stopped and its file saved, as org-clock-kill-emacs-query.
e8.addHook("kill-emacs-query-functions", () => {
  const buffer = clock && e8.markerBuffer(clock.line);
  if (buffer !== undefined && e8.yesOrNoP("Clock out and save? ")) {
    clockOut();
    e8.withCurrentBuffer(buffer, () => e8.call("save-buffer"));
  }
  return true;
});

// Summing clocked time and showing it on the headings, as org-clock-sum and org-clock-display do.

defvar(
  "org-clock-display-default-range",
  "thisyear",
  'The time org-clock-display sums with no prefix argument: "today", "yesterday", "thisweek", "lastweek", "thismonth", "lastmonth", "thisyear", "lastyear" or "untilnow".',
);
defvar("org-extend-today-until", 0, "The hour before which a time counts as the day before, for clock ranges.");
defvar("org-clock-report-include-clocking-task", false, "Whether the running clock's time counts in a clock sum over a range.");
defvar("org-clock-file-total-minutes", null, "The minutes the last clock sum in this buffer found in the whole file.");
defvar("org-clock-overlays", null, "The overlays org-clock-display shows the headings' times with, in this buffer.");
// Kept when the major mode is set again, so the times can still be taken away, as Org's are.
e8.put("org-clock-overlays", "permanent-local", true);
e8.defineFace({
  name: "org-clock-overlay",
  doc: "The times org-clock-display shows after the headings.",
  attributes: { inherit: "secondary-selection" },
});

/**
 * The start and end, in seconds, of a range a key names, and how it is
 * written, as org-clock-special-range: today, yesterday, thisweek,
 * lastweek, thismonth, lastmonth, thisq, lastq, thisyear, lastyear,
 * untilnow or interactive, a key with a shift as today-2 or thisweek-1,
 * or a year, 2026, a month, 2026-11, an ISO week, 2026-W47, a quarter,
 * 2026-Q4, or a day, 2026-11-20. Weeks start on WSTART's day, 1 for
 * Monday, and months on MSTART's.
 */
export function clockSpecialRange(key: string, time = millis(now()) / 1000, wstart?: number, mstart?: number): [number | undefined, number, string] {
  const tm = e8.decodeTime(time) as number[];
  let [m, h, d, month, y, dow] = [tm[1], tm[2], tm[3], tm[4], tm[5], tm[6]];
  let shift = 0;
  let q = month >= 10 ? 4 : month >= 7 ? 3 : month >= 4 ? 2 : 1;
  let k = key;
  let match: RegExpExecArray | null;
  if (/^[0-9]+$/.test(k)) [y, month, d, k] = [Number(k), 1, 1, "year"];
  else if ((match = /^([0-9]+)-([0-9]{1,2})$/.exec(k))) [y, month, d, k] = [Number(match[1]), Number(match[2]), 1, "month"];
  else if ((match = /^([0-9]+)-[wW]([0-9]{1,2})$/.exec(k))) {
    // The Monday of ISO week W: the week holding 4 January, moved on.
    const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (Number(match[2]) - 1) * 7 * 86400000);
    [d, month, y, dow, k] = [monday.getUTCDate(), monday.getUTCMonth() + 1, monday.getUTCFullYear(), 1, "week"];
  } else if ((match = /^([0-9]+)-[qQ]([1-4])$/.exec(k))) {
    // The quarter's own first day, as org-quarter-to-date's ISO date comes to.
    [q, y, dow, k] = [Number(match[2]), Number(match[1]), 1, "quarter"];
  } else if ((match = /^([0-9]+)-([0-9]{1,2})-([0-9]{1,2})$/.exec(k))) [y, month, d, k] = [Number(match[1]), Number(match[2]), Number(match[3]), "day"];
  else if ((match = /([-+][0-9]+)$/.exec(k))) {
    shift = Number(match[1]);
    k = k.slice(0, match.index);
    if ((k === "quarter" || k === "thisq") && shift > 0) throw new Error("Looking forward with quarters isn’t implemented");
  }
  if (shift === 0) {
    const last: Record<string, string> = { yesterday: "today", lastweek: "week", lastmonth: "month", lastyear: "year", lastq: "quarter" };
    if (k in last) [k, shift] = [last[k], -1];
  }
  const extend = Number(e8.variable("org-extend-today-until") ?? 0);
  let [h1, d1, month1, y1, shiftedy, shiftedq]: (number | undefined)[] = [];
  if (k === "day" || k === "today") [m, h, h1, d] = [0, extend, 24 + extend, d + shift];
  else if (k === "week" || k === "thisweek") {
    const diff = -7 * shift + (((dow + 7 - (wstart ?? 1)) % 7) + 7) % 7;
    [m, h, d] = [0, extend, d - diff];
    d1 = d + 7;
  } else if (k === "month" || k === "thismonth") {
    [h, m, d, month] = [extend, 0, mstart ?? 1, month + shift];
    month1 = month + 1;
  } else if (k === "quarter" || k === "thisq") {
    if (q - 1 + shift < 0) {
      // A shift into earlier years, as Org works it out with cl-floor.
      const interval = -(q - 1 + shift);
      const [years, quarters] = [Math.floor(interval / 4), interval % 4];
      const shiftedm = quarters === 0 ? 1 : 13 - 3 * quarters;
      [shiftedy, shiftedq] = quarters === 0 ? [y - years, 1] : [y - (1 + years), 5 - quarters];
      [m, h, d, month, y] = [0, extend, 1, shiftedm, shiftedy];
      month1 = 3 + shiftedm;
    } else if (q + shift > 0) {
      [shiftedq, shiftedy] = [q + shift, y];
      const qshift = 3 * (q + shift - 1);
      [m, h, d, month] = [0, extend, 1, 1 + qshift];
      month1 = 4 + qshift;
    }
  } else if (k === "year" || k === "thisyear") {
    [m, h, d, month, y] = [0, extend, 1, 1, y + shift];
    y1 = y + 1;
  } else if (k !== "interactive" && k !== "untilnow") e8.userError(`No such time block ${k}`);
  const encode = (min: number, hour: number, day: number, mon: number, year: number) => e8.encodeTime([0, min, hour, day, mon, year, null, -1, null]);
  const readDate = (prompt: string) => {
    const t = parseDate(e8.readString(`${prompt} `), true);
    return encode(t.minute ?? 0, t.hour ?? 0, t.day, t.month, t.year);
  };
  const start = k === "interactive" ? readDate("Range start?") : k === "untilnow" ? undefined : encode(m, h, d, month, y);
  const end = k === "interactive" ? readDate("Range end?") : k === "untilnow" ? time : encode(m, h1 ?? h, d1 ?? d, month1 ?? month, y1 ?? y);
  const ordinal = (n: number | undefined) => (n === undefined ? "" : (["1st", "2nd", "3rd", "4th"][n - 1] ?? ""));
  const text =
    k === "day" || k === "today"
      ? e8.formatTimeString("%A, %B %d, %Y", start)
      : k === "week" || k === "thisweek"
        ? e8.formatTimeString("week %G-W%V", start)
        : k === "month" || k === "thismonth"
          ? e8.formatTimeString("%B %Y", start)
          : k === "year" || k === "thisyear"
            ? e8.formatTimeString("the year %Y", start)
            : k === "quarter" || k === "thisq"
              ? `${ordinal(shiftedq)} quarter of ${shiftedy ?? ""}`
              : k === "untilnow"
                ? "now"
                : "(Range interactively set)";
  return [start, end, text];
}

/** A CLOCK: line's start and end in seconds, or undefined if they are not times. */
function clockTimes(text: string): [number, number] | undefined {
  // Two dashes only, as the clock element reads a range; Org counts nothing for others.
  const ts = /\[(\d{4})-(\d{2})-(\d{2})[^\]]*?(\d{1,2}):(\d{2})[^\]]*\]--\[(\d{4})-(\d{2})-(\d{2})[^\]]*?(\d{1,2}):(\d{2})[^\]]*\]/.exec(text);
  if (!ts) return undefined;
  const n = ts.slice(1).map(Number);
  return [e8.encodeTime([0, n[4], n[3], n[2], n[1], n[0], null, -1, null]), e8.encodeTime([0, n[9], n[8], n[7], n[6], n[5], null, -1, null])];
}

/**
 * Sums each subtree's clocked time, as org-clock-sum does, putting the
 * minutes on its heading line as the `prop` text property: the CLOCK:
 * lines' time within `tstart` and `tend` (seconds), or all of it, and the
 * lines giving only => H:MM. `filter`, called at a heading, leaves out
 * those for which it is false. Returns the file's total.
 */
export function clockSum(tstart?: number, tend?: number, filter?: () => boolean, prop = ":org-clock-minutes"): number {
  let total = 0;
  e8.withSilentModifications(() => {
    const [min, max] = [e8.pointMin(), e8.pointMax()];
    for (const name of [prop, ":org-clock-force-headline-inclusion"]) e8.removeTextProperty(min, max, name);
    const all = headings();
    const lines = e8.matchingLines("^\\*+[ \t]\\|^[ \t]*CLOCK:[ \t]*\\(?:\\[.*?\\]-+\\[.*?\\]\\|=>[ \t]+[0-9]+:[0-9]+\\)", { caseFold: false, start: min, end: max });
    let ltimes: number[] = new Array(30).fill(0);
    let t1 = 0;
    const running = runningEntry();
    for (let k = lines.length - 1; k >= 0; k--) {
      const [line, start, text] = lines[k];
      const hi = headingIndex(all, line);
      const isHeading = hi !== undefined && all[hi].line === line;
      const naked = /^[ \t]*CLOCK:[ \t]*=>[ \t]+([0-9]+):([0-9]+)/.exec(text);
      if (!isHeading && !naked && elementAt(start)?.type === "clock") {
        const times = clockTimes(text);
        if (times !== undefined) {
          const dt = (tend !== undefined ? Math.min(times[1], tend) : times[1]) - (tstart !== undefined ? Math.max(times[0], tstart) : times[0]);
          if (dt > 0) t1 += Math.floor(dt / 60);
        }
      } else if (naked && !isHeading) t1 += Number(naked[2]) + 60 * Number(naked[1]);
      else if (isHeading) {
        const h = all[hi];
        if (
          truthy(e8.variable("org-clock-report-include-clocking-task")) &&
          running !== undefined &&
          running.buffer === e8.bufferName() &&
          running.start === h.start &&
          tstart !== undefined &&
          tend !== undefined &&
          clock !== undefined &&
          clock.start / 1000 >= tstart &&
          clock.start / 1000 <= tend
        ) {
          t1 += Math.floor((millis(now()) - clock.start) / 60000);
        }
        const forced = truthy(e8.getTextProperty(h.start, ":org-clock-force-headline-inclusion"));
        const included = filter === undefined || e8.saveExcursion(() => (e8.gotoChar(h.start), filter()));
        const level = h.level;
        while (level >= ltimes.length) ltimes = [...ltimes, ...new Array(ltimes.length).fill(0)];
        if (t1 > 0 || ltimes[level] > 0) {
          if (included || forced) {
            if (included) for (let l = 0; l <= level; l++) ltimes[l] += t1;
            e8.putTextProperty(h.start, h.end, prop, ltimes[level]);
            if (filter !== undefined) for (const a of ancestorsOf(all, hi)) e8.putTextProperty(all[a].start, all[a].end, ":org-clock-force-headline-inclusion", true);
          }
          t1 = 0;
          for (let l = level; l < ltimes.length; l++) ltimes[l] = 0;
        }
      }
    }
    total = ltimes[0];
  });
  e8.makeLocalVariable("org-clock-file-total-minutes");
  e8.setVariable("org-clock-file-total-minutes", total);
  return total;
}

/** The headings above heading i, nearest first. */
function ancestorsOf(all: Heading[], i: number): number[] {
  const found: number[] = [];
  let level = all[i].level;
  for (let j = i - 1; j >= 0 && level > 1; j--) {
    if (all[j].level < level) {
      found.push(j);
      level = all[j].level;
    }
  }
  return found;
}

/** The clock overlays in this buffer. */
function clockOverlays(): number[] {
  const value = e8.variable("org-clock-overlays");
  return Array.isArray(value) ? (value as number[]) : [];
}

/** Whether org-clock-display's times show in this buffer. */
export const clockOverlaysShown = (): boolean => clockOverlays().length > 0;

/**
 * Shows a heading's time after its title, as org-clock-put-overlay does:
 * the title, dots in the shadow face up to column 60, and the time.
 */
function putClockOverlay(h: Heading, minutes: number): void {
  const col = e8.bufferSubstringNoProperties(h.start, h.titleAt).length;
  // org-indent-mode's prefix, a propertized string.
  const prefix = e8.getTextProperty(h.start, "line-prefix");
  const prefixLength = prefix === undefined || prefix === null ? 0 : charCount(String(prefix));
  // The title as it shows, its links as their descriptions, measured as org-string-width measures what is visible.
  const title = truthy(e8.variable("org-link-descriptive") ?? true) ? linkDescriptions(h.title) : h.title;
  const dots = Math.max(60 - col - e8.stringWidth(title) - prefixLength, 0);
  const text = e8.concat(title, e8.propertize("\u00b7".repeat(dots), { face: "shadow" }), e8.propertize(` ${durationFromMinutes(minutes).padStart(9)} `, { face: "org-clock-overlay" }));
  const id = e8.makeOverlay(h.titleAt, h.end, { display: text });
  e8.makeLocalVariable("org-clock-overlays");
  e8.setVariable("org-clock-overlays", [id, ...clockOverlays()]);
}

/** As removeClockOverlays from before-change-functions, where it then takes itself off. */
function removeClockOverlaysOnChange(): void {
  removeClockOverlays(false);
}

/** Takes away org-clock-display's times, as org-clock-remove-overlays does. */
export function removeClockOverlays(noremove: boolean): void {
  if (truthy(e8.variable("org-inhibit-highlight-removal"))) return;
  for (const id of clockOverlays()) if (e8.overlayStart(id) !== undefined) e8.deleteOverlay(id);
  if (e8.variable("org-clock-overlays") !== null) {
    e8.makeLocalVariable("org-clock-overlays");
    e8.setVariable("org-clock-overlays", null);
  }
  if (!noremove) e8.removeHook("before-change-functions", removeClockOverlaysOnChange, { local: true });
}

e8.defineCommand({
  name: "org-clock-remove-overlays",
  doc: "Take away the times org-clock-display shows after the headings.",
  run: () => removeClockOverlays(false),
});

const RANGES = ["today", "yesterday", "thisweek", "lastweek", "thismonth", "lastmonth", "thisyear", "lastyear", "interactive"];

e8.defineCommand({
  name: "org-clock-display",
  doc:
    "Show each subtree's clocked time after its heading, over org-clock-display-default-range, and the file's in the echo area. " +
    "With C-u, today's time; with C-u C-u, a range read; with C-u C-u C-u, all the time, in the echo area only. A change, or C-c C-c, takes the times away.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    removeClockOverlays(false);
    // Only C-u's forms, not the numbers typed: C-4 sums all the time, as Org compares with '(4).
    const raw = Array.isArray(arg) ? arg[0] : undefined;
    const todayp = raw === 4;
    const customp = raw === 16;
    const prop = arg === null || arg === undefined ? ":org-clock-minutes-default" : todayp ? ":org-clock-minutes-today" : customp ? ":org-clock-minutes-custom" : ":org-clock-minutes";
    let range: [number | undefined, number, string];
    if (arg === null || arg === undefined) range = clockSpecialRange(String(e8.variable("org-clock-display-default-range") ?? "thisyear"));
    else if (todayp) range = clockSpecialRange("today");
    else if (customp) {
      const key = e8.completingRead("Range: ", RANGES, { requireMatch: true });
      range = clockSpecialRange(key);
    } else range = [undefined, Infinity, ""];
    const total = arg === null || arg === undefined || todayp || customp ? clockSum(range[0], range[1], undefined, prop) : clockSum(undefined, undefined, undefined, prop);
    if (raw !== 64) {
      for (const h of headings()) {
        const time = e8.getTextProperty(h.start, prop);
        // Not on a heading with no title, where org-clock-put-overlay fails.
        if (typeof time === "number" && h.title !== "") putClockOverlay(h, time);
      }
      if (truthy(e8.variable("org-remove-highlights-with-change"))) e8.addHook("before-change-functions", removeClockOverlaysOnChange, { local: true });
    }
    const [hh, mm] = [Math.floor(total / 60), total % 60];
    const what = todayp ? "Total file time for today" : customp ? "Total file time (custom)" : "Total file time";
    e8.message(`${what}: ${durationFromMinutes(total)} (${hh} hours and ${mm} minutes)`);
  },
});

for (const [keys, command] of [
  ["C-c C-x C-i", "org-clock-in"],
  ["C-c C-x C-o", "org-clock-out"],
  ["C-c C-x C-q", "org-clock-cancel"],
  ["C-c C-x C-j", "org-clock-goto"],
  ["C-c C-x C-x", "org-clock-in-last"],
  ["C-c C-x C-d", "org-clock-display"],
] as const) {
  e8.defineKey("org-mode-map", keys, command);
}

// C-2 C-c C-w refiles to the running clock's entry, as org-refile reads org-clock-hd-marker.
setRunningClock(() => {
  const entry = runningEntry();
  if (!entry) return undefined;
  const title = e8.withCurrentBuffer(entry.buffer, () => headings().find((h) => h.start === entry.start)?.title ?? "");
  return { ...entry, title };
});

// Clock tables, as org-clock.el writes them: the dynamic block
// #+BEGIN: clocktable, which C-c C-x C-r makes or brings up to date.

const kw = (name: string) => e8.intern(name);

/** The date of an absolute day, as calendar-gregorian-from-absolute counts them from 1 January of year 1: [month, day, year]. */
function gregorianFromAbsolute(n: number): [number, number, number] {
  const t = new Date((n - 719163) * 86400000);
  return [t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCFullYear()];
}

/** The absolute day of an ISO week's day in a year, 0 being Sunday, as calendar-iso-to-absolute. */
function isoToAbsolute(week: number, day: number, year: number): number {
  const jan1 = new Date(0);
  jan1.setUTCFullYear(year, 0, 1);
  const jan4 = Math.floor(jan1.getTime() / 86400000) + 719163 + 3;
  // The Monday on or before 4 January, as calendar-dayname-on-or-before; absolute day 0 is a Sunday.
  const monday = jan4 - ((((jan4 - 1) % 7) + 7) % 7);
  return monday + 7 * (week - 1) + (day === 0 ? 6 : day - 1);
}

defvar(
  "org-clocktable-defaults",
  [
    kw(":maxlevel"), 2, kw(":lang"), "en", kw(":scope"), kw("file"), kw(":block"), null, kw(":wstart"), 1, kw(":mstart"), 1,
    kw(":tstart"), null, kw(":tend"), null, kw(":step"), null, kw(":stepskip0"), null, kw(":fileskip0"), null, kw(":tags"), null,
    kw(":match"), null, kw(":emphasize"), null, kw(":link"), null, kw(":narrow"), kw("40!"), kw(":indent"), true,
    kw(":filetitle"), null, kw(":hidefiles"), null, kw(":formula"), null, kw(":timestamp"), null, kw(":level"), null,
    kw(":tcolumns"), null, kw(":formatter"), null,
  ],
  "Default properties for clock tables, which a clock table's own parameters override.",
);
defvar("org-clock-clocktable-default-properties", [kw(":maxlevel"), 2], "The properties a new clock table's #+BEGIN: line starts with.");
defvar("org-clock-clocktable-formatter", "org-clocktable-write-default", "The function writing a clock table from its data, which a table's :formatter overrides.");
defvar(
  "org-clock-clocktable-language-setup",
  [
    ["en", "File", "L", "Timestamp", "Headline", "Time", "ALL", "Total time", "File time", "Clock summary at"],
    ["de", "Datei", "E", "Zeitstempel", "Kopfzeile", "Dauer", "GESAMT", "Gesamtdauer", "Dateizeit", "Erstellt am"],
    ["es", "Archivo", "N", "Fecha y hora", "Tarea", "Duración", "TODO", "Duración total", "Tiempo archivo", "Generado el"],
    ["fr", "Fichier", "N", "Horodatage", "En-tête", "Durée", "TOUT", "Durée totale", "Durée fichier", "Horodatage sommaire à"],
    ["nl", "Bestand", "N", "Tijdstip", "Hoofding", "Duur", "ALLES", "Totale duur", "Bestandstijd", "Klok overzicht op"],
    ["nn", "Fil", "N", "Tidspunkt", "Overskrift", "Tid", "ALLE", "Total tid", "Filtid", "Tidsoversyn"],
    ["pl", "Plik", "P", "Data i godzina", "Nagłówek", "Czas", "WSZYSTKO", "Czas całkowity", "Czas pliku", "Poddumowanie zegara na"],
    ["pt-BR", "Arquivo", "N", "Data e hora", "Título", "Hora", "TODOS", "Hora total", "Hora do arquivo", "Resumo das horas em"],
    ["sk", "Súbor", "L", "Časová značka", "Záhlavie", "Čas", "VŠETKO", "Celkový čas", "Čas súboru", "Časový súhrn pre"],
  ],
  "The words clock tables are written with, in each language :lang names.",
);
defvar("org-clock-total-time-cell-format", "*%s*", "How a clock table writes its total time and the words before it.");
defvar("org-clock-file-time-cell-format", "*%s*", "How a clock table writes a file's time and the words before it.");

/** A clock table's word in LANG, as org-clock--translate. */
function translate(s: string, lang: string): string {
  const i = ["File", "L", "Timestamp", "Headline", "Time", "ALL", "Total time", "File time", "Clock summary at"].indexOf(s) + 1;
  const setup = e8.variable("org-clock-clocktable-language-setup");
  const row = Array.isArray(setup) ? setup.find((r) => Array.isArray(r) && typeof r[0] === "string" && r[0].toLowerCase() === lang.toLowerCase()) : undefined;
  const word = Array.isArray(row) ? row[i] : undefined;
  return typeof word === "string" ? word : s;
}

/** A parameter's value as Org formats it with %s: a symbol's name, a number's digits. */
function str(v: e8.Value | undefined): string | undefined {
  if (v === null || v === undefined || v === false) return undefined;
  if (typeof v === "symbol") return e8.symbolName(v);
  return typeof v === "string" ? v : e8.prin1ToString(v, true);
}

/** Org's timestamp formats, as org-time-stamp-format: with a time or not, active or inactive. */
function stampFormat(withTime: boolean, inactive: boolean): string {
  const f = withTime ? "%Y-%m-%d %a %H:%M" : "%Y-%m-%d %a";
  return inactive ? `[${f}]` : `<${f}>`;
}

/** A clock table's start or end as seconds: an Org time string, an absolute day as the agenda counts them, or a (MONTH DAY YEAR) list. */
function tableTime(v: e8.Value): number | undefined {
  if (v === null || v === undefined || v === false) return undefined;
  if (typeof v === "number") {
    v = gregorianFromAbsolute(v);
  }
  if (Array.isArray(v)) {
    const [mo, da, yr] = v as number[];
    return matcherTime(`${String(yr).padStart(4, " ")}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`);
  }
  return matcherTime(String(str(v)));
}

/** Shortens S to MAX characters at a space if it can, ending it with ..., as org-shorten-string. */
function shortenString(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const n = Math.max(max - 4, 1);
  const m = new RegExp(`^([^\\n]{1,${n}}[^ ])(?: |$)`, "u").exec(s);
  return m ? `${m[1]}...` : `${chars.slice(0, Math.max(max - 3, 0)).join("")}...`;
}

/** Org's bracket link, its target in group 1 and description in 2, as org-link-bracket-re. */
const LINK_BRACKET = /\[\[((?:[^\][\\]|\\(?:\\\\)*[\][]|\\+[^\][])+)\](?:\[([\s\S]+?)\])?\]/g;

/** A link as Org writes one, its target's brackets escaped, as org-link-make-string. */
function linkMakeString(link: string, description: string): string {
  const desc = /\S/.test(description) ? description.trim().replace(/\]$/, "]​").replace(/(\])(\])/g, "$1​$2") : undefined;
  const escaped = link.replace(/(\\*)([\][]|$)/g, (_m, bs: string, c: string) => `${bs}${bs}${c === "" ? "" : "\\"}${c}`);
  return `[[${escaped}]${desc === undefined ? "" : `[${desc}]`}]`;
}

/** A heading's title without TODO keyword, priority, COMMENT or tags, as org-get-heading t t t t. */
function bareHeadline(h: Heading): string {
  return h.title.replace(/^COMMENT[ \t]+/, "");
}

/** One heading's row in a clock table, as org-clock-get-table-data lists it. */
type TableEntry = [level: number, headline: string, tags: string[], timestamp: string | null, minutes: number, properties: [string, string][]];
/** One file's part of a clock table: its name, its time and its headings. */
type TableData = [file: string | null, minutes: number, entries: TableEntry[]];

/**
 * The clocked headings of the accessible part of the buffer, as
 * org-clock-get-table-data: each heading with time, to :maxlevel, its
 * title made a link with :link, its tags with :tags, its first planning or
 * other timestamp with :timestamp and the :properties asked for.
 */
function clockTableData(file: string | null, params: e8.Value[]): TableData {
  const maxlevel = Number(plistGet(params, ":maxlevel") ?? 3);
  const block = str(plistGet(params, ":block"));
  let ts = tableTime(plistGet(params, ":tstart"));
  let te = tableTime(plistGet(params, ":tend"));
  if (block !== undefined) {
    const range = clockSpecialRange(block, undefined, Number(plistGet(params, ":wstart") ?? 1), Number(plistGet(params, ":mstart") ?? 1));
    // Org takes the range as strings, to the minute.
    [ts, te] = [range[0] === undefined ? undefined : Math.floor(range[0] / 60) * 60, Math.floor(range[1] / 60) * 60];
  }
  const link = truthy(plistGet(params, ":link"));
  const tags = truthy(plistGet(params, ":tags"));
  const timestamp = truthy(plistGet(params, ":timestamp"));
  const properties = propertyNames(plistGet(params, ":properties"));
  const inherit = truthy(plistGet(params, ":inherit-props"));
  const match = plistGet(params, ":match");
  const wide = e8.saveRestriction(() => (e8.widen(), headings()));
  const contexts = matchContexts(wide);
  const matcher = typeof match === "string" ? makeTagsMatcher(match) : undefined;
  const total = clockSum(ts, te, matcher && (() => matcher.test(contexts(headingIndex(wide, lineAt()) as number))));
  const entries: TableEntry[] = [];
  const [min, max] = [e8.pointMin(), e8.pointMax()];
  const fileName = e8.bufferFileName() ?? undefined;
  for (let i = 0; i < wide.length; i++) {
    const h = wide[i];
    if (h.start < min || h.start >= max) continue;
    const time = e8.getTextProperty(h.start, ":org-clock-minutes");
    if (typeof time !== "number" || time <= 0) continue;
    const level = reducedLevel(h.level);
    if (level > maxlevel) continue;
    const headline = bareHeadline(h);
    let hdl = headline;
    if (link) {
      const search = `*${headline.replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, " ").replace(/[ \t]+/g, " ").trim()}`;
      const description = headline.replace(/\[[0-9]*(?:%|\/[0-9]*)\]/g, "").replace(LINK_BRACKET, (_m, target: string, desc?: string) => desc ?? target).trim();
      hdl = linkMakeString(fileName === undefined ? search : `file:${fileName}::${search}`, description);
    }
    const ctx = contexts(i);
    const tsp = timestamp ? (["SCHEDULED", "DEADLINE", "TIMESTAMP", "TIMESTAMP_IA"].map((p) => entryGetAt(ctx, p, false)).find((v) => v !== undefined) ?? null) : null;
    const props: [string, string][] = [];
    for (const p of properties) {
      const v = entryGetAt(ctx, p, inherit);
      if (v !== undefined) props.push([p, v]);
    }
    entries.push([level, hdl, tags ? ctx.tags : [], tsp, time, props]);
  }
  return [file, total, entries];
}

/** Moves to the heading whose subtree a clock table's tree or treeN scope covers, as Org climbs with org-up-heading-safe. */
function climbToTree(level?: number): void {
  const all = headings();
  let i = headingIndex(all, lineAt());
  if (i === undefined) return;
  const parentOf = (j: number) => {
    for (let k = j - 1; k >= 0; k--) if (all[k].level < all[j].level) return k;
    return undefined;
  };
  for (;;) {
    const p = parentOf(i);
    if (p === undefined || all[p].start < e8.pointMin()) break;
    i = p;
    if (level !== undefined && reducedLevel(all[i].level) <= level) break;
  }
  e8.gotoChar(all[i].start);
}

/** The names of :properties, which must be strings, as Org's mapconcat and org-entry-get need. */
function propertyNames(v: e8.Value): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => (typeof p === "string" ? p : e8.signal("wrong-type-argument", `Wrong type argument: stringp, ${e8.prin1ToString(p)}`, [e8.intern("stringp"), p])));
}

/**
 * Writes the clock table whose #+BEGIN: line gave PARAMS at point, as
 * org-dblock-write:clocktable: the time clocked in the file, the subtree,
 * the tree or the agenda files, over :block or :tstart to :tend, in steps
 * with :step. Returns the total minutes.
 */
function writeClocktable(params: e8.Value[]): number | undefined {
  params = combinePlists(e8.variable("org-clocktable-defaults"), params);
  const scope = plistGet(params, ":scope");
  const scopeName = typeof scope === "symbol" ? e8.symbolName(scope) : undefined;
  const treeLevel = scopeName !== undefined ? /^tree([0-9]+)$/.exec(scopeName) : null;
  let files: string[] | undefined;
  if (scopeName === "agenda") files = agendaFiles();
  else if (scopeName === "agenda-with-archives") files = e8.funcall("org-add-archive-files", agendaFiles()) as string[];
  else if (scopeName === "file-with-archives") {
    const base = e8.bufferFileName();
    files = base ? (e8.funcall("org-add-archive-files", [base]) as string[]) : [];
  } else if (scope === null || scopeName === "nil" || scopeName === "file" || scopeName === "subtree" || scopeName === "tree" || treeLevel) files = undefined;
  else if (Array.isArray(scope)) files = scope.map(String);
  else if (typeof scope === "function" || (scopeName !== undefined && e8.fboundp(scopeName))) files = (e8.funcall((scopeName ?? scope) as string) ?? []) as string[];
  else e8.userError(`Unknown scope: ${e8.prin1ToString(scope)}`);
  const block = str(plistGet(params, ":block"));
  let ts = plistGet(params, ":tstart");
  let te = plistGet(params, ":tend");
  if (block !== undefined) {
    const range = clockSpecialRange(block, undefined, Number(plistGet(params, ":wstart") ?? 1), Number(plistGet(params, ":mstart") ?? 1));
    [ts, te] = [range[0] ?? null, range[1]];
  }
  if (truthy(plistGet(params, ":step"))) {
    if (block === undefined && !(truthy(ts) && truthy(te))) e8.userError("Clocktable ‘:step’ can only be used with ‘:block’ or ‘:tstart’, ‘:tend’");
    clocktableSteps(params);
    return undefined;
  }
  const origin = e8.point();
  let tables: TableData[];
  if (files !== undefined) {
    tables = files.map((file) =>
      e8.withCurrentBuffer(e8.findFileNoselect(file), () => e8.saveExcursion(() => e8.saveRestriction(() => clockTableData(file, params)))),
    );
  } else {
    tables = [
      e8.saveRestriction(() => {
        if (scopeName === "file") e8.widen();
        else if (scopeName === "subtree") e8.call("org-narrow-to-subtree");
        else if (scopeName === "tree" || treeLevel) {
          climbToTree(treeLevel ? Number(treeLevel[1]) : undefined);
          e8.call("org-narrow-to-subtree");
        }
        return clockTableData(null, params);
      }),
    ];
  }
  const multifile = !truthy(plistGet(params, ":hidefiles")) && files !== undefined && scopeName !== "file-with-archives";
  const formatter = plistGet(params, ":formatter") ?? e8.variable("org-clock-clocktable-formatter") ?? "org-clocktable-write-default";
  const name = typeof formatter === "symbol" ? e8.symbolName(formatter) : formatter;
  const all = combinePlists(params, [kw(":multifile"), multifile]);
  if (name === "org-clocktable-write-default") return writeClocktableDefault(origin, tables, all);
  return e8.funcall(name as string, origin, tables as unknown as e8.Value, all) as number;
}

/** A file's #+TITLE:, as org-get-title reads it. */
function fileTitle(file: string): string | undefined {
  return e8.withCurrentBuffer(e8.findFileNoselect(file), () => {
    const titles = e8.matchingLines("^[ \t]*#\\+TITLE:", { caseFold: true, start: e8.pointMin(), end: e8.pointMax() })
      .map(([, , text]) => text.replace(/^[ \t]*#\+TITLE:[ \t]*/i, "").trim())
      .filter((t) => t !== "");
    return titles.length > 0 ? titles.join(" ") : undefined;
  });
}

/**
 * Writes a clock table at IPOS from TABLES, as org-clocktable-write-default:
 * a caption, a header line, the total, and each file's time and headings,
 * with the columns PARAMS ask for; then aligns it.
 */
function writeClocktableDefault(ipos: number, tables: TableData[], params: e8.Value[]): number {
  const p = (key: string) => plistGet(params, key);
  const lang = str(p(":lang")) ?? "en";
  const multifile = truthy(p(":multifile"));
  const block = str(p(":block"));
  const header = p(":header");
  const link = truthy(p(":link"));
  const maxlevel = Number(p(":maxlevel") ?? 3);
  const emph = truthy(p(":emphasize"));
  const compact = truthy(p(":compact"));
  let narrow: e8.Value = p(":narrow") ?? (compact ? kw("40!") : null);
  const filetitle = truthy(p(":filetitle"));
  const level = !compact && truthy(p(":level"));
  const timestamp = truthy(p(":timestamp"));
  const tags = truthy(p(":tags"));
  const properties = propertyNames(p(":properties"));
  const tcolumns = p(":tcolumns");
  let timeColumns = 1;
  if (!compact && maxlevel >= 2) {
    const levels = tables.filter(([, t]) => typeof t === "number" && t !== 0).flatMap(([, , entries]) => entries.map((e) => e[0]));
    timeColumns = Math.min(maxlevel, typeof tcolumns === "number" ? tcolumns : 100, levels.length === 0 ? 1 : Math.max(...levels));
  }
  const indent = compact || truthy(p(":indent"));
  const formula = p(":formula");
  const percent = typeof formula === "symbol" && e8.symbolName(formula) === "%";
  const totalTime = tables.reduce((sum, [, t]) => sum + (t ?? 0), 0);
  const totalFormat = String(e8.variable("org-clock-total-time-cell-format") ?? "*%s*");
  const fileFormat = String(e8.variable("org-clock-file-time-cell-format") ?? "*%s*");
  let narrowCut = false;
  if (typeof narrow === "number" && link) {
    e8.message("Using hard narrowing in clocktable to allow for links");
    narrow = kw(`${narrow}!`);
  }
  if (narrow !== null && typeof narrow !== "number") {
    const m = typeof narrow === "symbol" ? /^([0-9]+)!$/.exec(e8.symbolName(narrow)) : null;
    if (!m) e8.userError(`Invalid value ${str(narrow)} of :narrow property in clock table`);
    narrowCut = true;
    narrow = Number(m[1]);
  }
  const bars = (n: number) => "|".repeat(Math.max(0, n));
  e8.gotoChar(ipos);
  const put = (text: string) => e8.insertBeforeMarkers(text);
  if (typeof header === "string") put(header);
  else {
    const range = block === undefined ? "" : `, for ${clockSpecialRange(block, undefined, Number(p(":wstart") ?? 1), Number(p(":mstart") ?? 1))[2]}.`;
    put(`#+CAPTION: ${translate("Clock summary at", lang)} ${e8.formatTimeString(stampFormat(true, true), millis(now()) / 1000)}${range}\n`);
  }
  if (typeof narrow === "number" && !narrowCut) {
    put(`|${multifile ? "|" : ""}${level ? "|" : ""}${timestamp ? "|" : ""}${tags ? "|" : ""}${bars(properties.length)}<${narrow}>| |\n`);
  }
  put(
    "|" +
      (multifile ? `${translate("File", lang)}|` : "") +
      (level ? `${translate("L", lang)}|` : "") +
      (timestamp ? `${translate("Timestamp", lang)}|` : "") +
      (tags ? "Tags |" : "") +
      (properties.length > 0 ? `${properties.join("|")}|` : "") +
      `${translate("Headline", lang)}|` +
      `${translate("Time", lang)}|` +
      bars(timeColumns - 1) +
      (percent ? "%|\n" : "\n"),
  );
  put(
    "|-\n|" +
      (multifile ? `| ${translate("ALL", lang)} ` : "") +
      (level ? "|" : "") +
      (timestamp ? "|" : "") +
      (tags ? "|" : "") +
      bars(properties.length) +
      `${e8.format(totalFormat, translate("Total time", lang))}| ` +
      e8.format(totalFormat, durationFromMinutes(totalTime)) +
      "|" +
      bars(timeColumns - 1) +
      (!percent ? "" : totalTime === 0 ? "0.0|" : "100.0|") +
      "\n",
  );
  if (totalTime > 0) {
    for (const [fileName, fileTime, entries] of tables) {
      if (!(fileTime > 0) && truthy(p(":fileskip0"))) continue;
      put("|-\n");
      if (multifile) {
        const name = String(fileName ?? "");
        const shown = filetitle ? (fileTitle(name) ?? e8.fileNameNondirectory(name)) : e8.fileNameNondirectory(name);
        put(
          `| ${shown} ${level ? "| " : ""} | ${timestamp ? "| " : ""}${tags ? "| " : ""}${bars(properties.length)}` +
            `${e8.format(fileFormat, translate("File time", lang))} | *${durationFromMinutes(fileTime)}*|${bars(timeColumns - 1)}` +
            (percent ? ` ${e8.format("%.1f", (100 * fileTime) / totalTime)} |` : "") +
            "\n",
        );
      }
      if (maxlevel > 0) {
        for (const [lvl, headline0, tgs, tsp, time, props] of entries) {
          let headline = headline0;
          if (narrowCut) {
            const whole = new RegExp(`^${LINK_BRACKET.source}$`).exec(headline);
            headline = whole && whole[2] !== undefined ? `[[${whole[1]}][${shortenString(whole[2], narrow as number)}]]` : shortenString(headline, narrow as number);
          }
          const field = (f: string) => (!emph ? `${f} |` : lvl === 1 ? `*${f}* |` : lvl === 2 ? `/${f}/ |` : `${f} |`);
          put(
            "|" +
              (multifile ? "|" : "") +
              (level ? `${lvl}|` : "") +
              (timestamp ? `${tsp ?? ""}|` : "") +
              (tags ? `${tgs.join(", ")}|` : "") +
              (properties.length > 0 ? `${properties.map((name) => props.find(([k]) => k === name)?.[1] ?? "").join("|")}|` : "") +
              (indent ? (lvl === 1 ? "" : `\\_${" ".repeat(2 * (lvl - 1))}`) : "") +
              field(headline) +
              bars(Math.min(timeColumns, lvl) - 1) +
              field(durationFromMinutes(time)) +
              bars(timeColumns - lvl) +
              (percent ? e8.format("%.1f |", (100 * time) / totalTime) : "") +
              "\n",
          );
        }
      }
    }
  }
  e8.deleteRegion(e8.point() - 1, e8.point());
  let recalc = false;
  if (formula === null || percent) {
    const contents = p(":content");
    const m = typeof contents === "string" && /\S/.test(contents) ? /^([ \t]*#\+tblfm:.*)/im.exec(contents) : null;
    if (m) {
      recalc = true;
      e8.insert(`\n${m[1]}`);
      forwardLine(-1);
    }
  } else if (typeof formula === "string") {
    e8.insert(`\n#+TBLFM: ${formula}`);
    recalc = true;
  } else e8.userError("Invalid :formula parameter in clocktable");
  e8.gotoChar(ipos);
  e8.skipCharsForward("^|");
  e8.call("org-table-align");
  const sort = p(":sort");
  if (Array.isArray(sort) && sort.length >= 2) {
    // From the third data line, the first after the total, by its column, as Org sorts with org-table-sort-lines.
    e8.saveExcursion(() => {
      let rows = 0;
      for (let line = lineAt(); line < e8.lineCount() && /^[ \t]*\|/.test(e8.lineText(line)); line++) {
        if (/^[ \t]*\|-/.test(e8.lineText(line)) || ++rows < 3) continue;
        const text = e8.lineText(line);
        let bars = 0;
        let i = 0;
        for (; i < text.length && bars < Number(sort[0]); i++) if (text[i] === "|") bars++;
        e8.gotoChar(e8.lineStart(line) + charCount(text.slice(0, Math.min(i + 1, text.length))));
        const type = sort[1];
        tableSortLines(false, false, typeof type === "number" ? String.fromCodePoint(type) : String(str(type)));
        return;
      }
    });
  }
  if (recalc) e8.call("org-table-recalculate");
  return totalTime;
}

/**
 * Writes a clock table for each step of :step, day, week, semimonth,
 * month, quarter or year, through :block or from :tstart to :tend, as
 * org-clocktable-steps, leaving out empty ones with :stepskip0.
 */
function clocktableSteps(params: e8.Value[]): void {
  const skipEmpty = truthy(plistGet(params, ":stepskip0"));
  const step = str(plistGet(params, ":step")) ?? "";
  const headers: Record<string, string> = {
    day: "Daily report: ",
    week: "Weekly report starting on: ",
    semimonth: "Semimonthly report starting on: ",
    month: "Monthly report starting on: ",
    year: "Annual report starting on: ",
    quarter: "Quarterly report starting on: ",
  };
  const stepHeader = headers[step];
  if (stepHeader === undefined) e8.userError(`Unknown ‘:step’ specification: ${e8.prin1ToString(plistGet(params, ":step"))}`);
  const weekStart = Number(plistGet(params, ":wstart") ?? 1);
  const monthStart = Number(plistGet(params, ":mstart") ?? 1);
  const block = str(plistGet(params, ":block"));
  const range = block === undefined ? undefined : clockSpecialRange(block, undefined, weekStart, monthStart);
  const extend = Number(e8.variable("org-extend-today-until") ?? 0);
  const encode = (min: number, hour: number, day: number, mon: number, year: number) => e8.encodeTime([0, min, hour, day, mon, year, null, -1, null]);
  const fromDay = (n: number) => {
    const [mo, da, yr] = gregorianFromAbsolute(n);
    return encode(0, extend, da, mo, yr);
  };
  // Times from the range are taken as Org writes them, to the minute.
  const minute = (t: number) => Math.floor(t / 60) * 60;
  const startValue = range ? range[0] : plistGet(params, ":tstart");
  let start = typeof startValue === "number" ? (range ? minute(startValue) : fromDay(startValue)) : matcherTime(str(startValue) ?? "<2003-01-01 Thu 00:00>");
  const endValue = range ? range[1] : plistGet(params, ":tend");
  const end = typeof endValue === "number" ? (range ? minute(endValue) : fromDay(endValue)) : matcherTime(str(endValue) ?? "");
  while (start < end) {
    if (e8.point() !== e8.lineStart(lineAt())) e8.insert("\n");
    e8.insert(`\n${stepHeader}${e8.formatTimeString(stampFormat(false, true), start)}\n`);
    const [, , , d, m, y, dow] = e8.decodeTime(start) as number[];
    let next: number;
    if (step === "day") next = encode(0, extend, d + 1, m, y);
    else if (step === "week") next = encode(0, extend, d + (dow === weekStart ? 7 : (((weekStart - dow) % 7) + 7) % 7), m, y);
    else if (step === "semimonth") next = encode(0, 0, d < 16 ? 16 : 1, d < 16 ? m : m + 1, y);
    else if (step === "month") next = encode(0, 0, monthStart, m + 1, y);
    else if (step === "quarter") next = encode(0, 0, monthStart, m + 3, y);
    else next = encode(0, extend, 1, 1, y + 1);
    const tableBegin = e8.lineStart(lineAt() - 1);
    const stepTime = writeClocktable(
      combinePlists(params, [
        kw(":header"), "", kw(":step"), null, kw(":block"), null,
        kw(":tstart"), e8.formatTimeString(stampFormat(true, true), start),
        kw(":tend"), e8.formatTimeString(stampFormat(true, true), end < next ? end : next),
      ]),
    );
    e8.reSearchForward("^[ \t]*#\\+END:", { caseFold: true });
    if (skipEmpty && stepTime === 0) e8.deleteRegion(tableBegin, e8.lineStart(lineAt()));
    start = next;
    forwardLine(-1);
    e8.gotoChar(e8.lineEnd(lineAt()));
  }
}

e8.defun("org-dblock-write:clocktable", (params: e8.Value[]) => writeClocktable(params));
e8.defun("org-clocktable-write-default", (ipos: number, tables: TableData[], params: e8.Value[]) => writeClocktableDefault(ipos, tables, params));

/** Where the clock table point is in starts, as org-in-clocktable-p. */
function inClocktable(): number | undefined {
  const pos = e8.point();
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.lineEnd(lineAt()));
    if (e8.reSearchBackward("^[ \t]*#\\+BEGIN:[ \t]+clocktable", { noerror: true, caseFold: true }) === undefined) return undefined;
    const start = e8.matchBeginning(0) as number;
    if (e8.reSearchForward("^[ \t]*#\\+END:.*", { noerror: true, caseFold: true }) === undefined) return undefined;
    return (e8.matchEnd(0) as number) >= pos ? start : undefined;
  });
}

e8.defineCommand({
  name: "org-clock-report",
  doc:
    "Bring the clock table point is in up to date, or make one: of the subtree, or of the file before the first heading, " +
    "its other parameters from org-clock-clocktable-default-properties. With C-u, update the buffer's first clock table.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    removeClockOverlays(false);
    if (truthy(arg)) {
      findDblock("clocktable");
      const all = headings();
      const i = headingIndex(all, lineAt());
      if (i !== undefined) showEntry(all, i);
    }
    const start = inClocktable();
    if (start === undefined) {
      const first = headings()[0];
      const before = first === undefined || first.start > e8.point();
      createDblock(
        combinePlists([kw(":scope"), kw(before ? "file" : "subtree")], e8.variable("org-clock-clocktable-default-properties"), [kw(":name"), "clocktable"]),
      );
    } else e8.gotoChar(start);
    updateDblock();
  },
});

dynamicBlockDefine("clocktable", "org-clock-report");

/**
 * Moves the :block of the clock table whose #+BEGIN: line point is on N
 * steps of its own size, back for left and down, on for right and up,
 * and writes the table again, as org-clocktable-shift.
 */
function clocktableShift(dir: string, arg: e8.PrefixArg): boolean {
  let n = e8.prefixNumericValue(arg);
  if (dir === "left" || dir === "down") n = -n;
  return e8.saveExcursion(() => {
    e8.gotoChar(e8.lineStart(lineAt()));
    if (!e8.lookingAt("^[ \t]*#\\+BEGIN:[ \t]+clocktable\\>.*?:block[ \t]+\\(\\S-+\\)", undefined, { caseFold: true })) {
      e8.userError("Line needs a :block definition before this command works");
    }
    const [b, e] = [e8.matchBeginning(1) as number, e8.matchEnd(1) as number];
    let s = e8.matchString(1) as string;
    const renamed: Record<string, string> = { yesterday: "today-1", lastweek: "thisweek-1", lastmonth: "thismonth-1", lastyear: "thisyear-1", lastq: "thisq-1" };
    s = renamed[s] ?? s;
    let ins: string | undefined;
    let m: RegExpExecArray | null;
    const encode = (day: number, mon: number, year: number) => e8.encodeTime([0, 0, 0, day, mon, year, null, -1, null]);
    if ((m = /^(today|thisweek|thismonth|thisyear|thisq)([-+][0-9]+)?$/.exec(s))) {
      const shift = (m[2] === undefined ? 0 : Number(m[2])) + n;
      ins = shift === 0 ? m[1] : `${m[1]}${shift > 0 ? "+" : ""}${shift}`;
    } else if ((m = /([0-9]+)(-([wWqQ]?)([0-9]{1,2})(-([0-9]{1,2}))?)?/.exec(s))) {
      let y = Number(m[1]);
      const wp = m[3];
      let mw = m[4] === undefined ? undefined : Number(m[4]);
      const d = m[6] === undefined ? undefined : Number(m[6]);
      // Org encodes the day with no month, which signals.
      if (d !== undefined) e8.signal("wrong-type-argument", "Wrong type argument: fixnump, nil", [e8.intern("fixnump"), null]);
      else if (wp !== undefined && /[wW]/.test(wp) && mw !== undefined) {
        const [mo, da, yr] = gregorianFromAbsolute(isoToAbsolute(mw + n, 1, y));
        ins = e8.formatTimeString("%G-W%V", encode(da, mo, yr));
      } else if (wp !== undefined && /[qQ]/.test(wp) && mw !== undefined) {
        if (mw + n > 4) [mw, y] = [0, y + 1];
        if (mw + n === 0) [mw, y] = [5, y - 1];
        ins = `${y}-Q${mw + n}`;
      } else if (mw !== undefined) ins = e8.formatTimeString("%Y-%m", encode(1, mw + n, y));
      else ins = String(y + n);
    } else e8.userError("Cannot shift clocktable block");
    e8.gotoChar(b);
    e8.insert(ins);
    e8.deleteRegion(e8.point(), e8.point() + (e - b));
    e8.gotoChar(e8.lineStart(lineAt()));
    updateDblock();
    return true;
  });
}

e8.defun("org-clocktable-shift", clocktableShift);

