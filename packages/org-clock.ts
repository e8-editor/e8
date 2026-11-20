// Clocking time on Org entries, after Org's org-clock.el: C-c C-x C-i
// starts a clock on the entry at point, a CLOCK: line in its LOGBOOK drawer,
// and the mode line shows how long it has run; C-c C-x C-o stops it,
// writing the end and the duration; C-c C-x C-q cancels it and C-c C-x C-j
// goes back to its entry.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { addLogNote, type DateTime, durationFromMinutes, formatTimestamp, type Heading, headingIndex, headings, isDone, logDrawer, parseDate, today } from "org";
import { elementAt } from "org-element";
import { toggleDrawerOrBlock } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { setRunningClock } from "org-refile";
import { charCount, truthy } from "subr";

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
 * lastweek, thismonth, lastmonth, thisyear, lastyear, untilnow or
 * interactive, a key with a shift as today-2 or thisweek-1, or a year,
 * 2026, a month, 2026-11, an ISO week, 2026-W47, or a day, 2026-11-20.
 */
export function clockSpecialRange(key: string, time = millis(now()) / 1000): [number | undefined, number, string] {
  const tm = e8.decodeTime(time) as number[];
  let [m, h, d, month, y, dow] = [tm[1], tm[2], tm[3], tm[4], tm[5], tm[6]];
  let shift = 0;
  let k = key;
  let match: RegExpExecArray | null;
  if (/^[0-9]+$/.test(k)) [y, month, d, k] = [Number(k), 1, 1, "year"];
  else if ((match = /^([0-9]+)-([0-9]{1,2})$/.exec(k))) [y, month, d, k] = [Number(match[1]), Number(match[2]), 1, "month"];
  else if ((match = /^([0-9]+)-[wW]([0-9]{1,2})$/.exec(k))) {
    // The Monday of ISO week W: the week holding 4 January, moved on.
    const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (Number(match[2]) - 1) * 7 * 86400000);
    [d, month, y, dow, k] = [monday.getUTCDate(), monday.getUTCMonth() + 1, monday.getUTCFullYear(), 1, "week"];
  } else if ((match = /^([0-9]+)-([0-9]{1,2})-([0-9]{1,2})$/.exec(k))) [y, month, d, k] = [Number(match[1]), Number(match[2]), Number(match[3]), "day"];
  else if ((match = /([-+][0-9]+)$/.exec(k))) {
    shift = Number(match[1]);
    k = k.slice(0, match.index);
  }
  if (shift === 0) {
    const last: Record<string, string> = { yesterday: "today", lastweek: "week", lastmonth: "month", lastyear: "year" };
    if (k in last) [k, shift] = [last[k], -1];
  }
  const extend = Number(e8.variable("org-extend-today-until") ?? 0);
  let [h1, d1, month1, y1]: (number | undefined)[] = [];
  if (k === "day" || k === "today") [m, h, h1, d] = [0, extend, 24 + extend, d + shift];
  else if (k === "week" || k === "thisweek") {
    const diff = -7 * shift + ((dow + 7 - 1) % 7);
    [m, h, d] = [0, extend, d - diff];
    d1 = d + 7;
  } else if (k === "month" || k === "thismonth") {
    [h, m, d, month] = [extend, 0, 1, month + shift];
    month1 = month + 1;
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
  const text =
    k === "day" || k === "today"
      ? e8.formatTimeString("%A, %B %d, %Y", start)
      : k === "week" || k === "thisweek"
        ? e8.formatTimeString("week %G-W%V", start)
        : k === "month" || k === "thismonth"
          ? e8.formatTimeString("%B %Y", start)
          : k === "year" || k === "thisyear"
            ? e8.formatTimeString("the year %Y", start)
            : k === "untilnow"
              ? "now"
              : `${e8.formatTimeString("%Y-%m-%d", start)}--${e8.formatTimeString("%Y-%m-%d", end)}`;
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
