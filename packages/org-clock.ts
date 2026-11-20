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

import { addLogNote, type DateTime, formatTimestamp, type Heading, headingIndex, headings, isDone, logDrawer, today } from "org";
import { toggleDrawerOrBlock } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { truthy } from "subr";

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

/** Minutes as Org writes a duration: 0:05, or 1d 2:03 past a day, as org-duration-from-minutes. */
export function durationFromMinutes(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  const hm = `${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, "0")}`;
  return days > 0 ? `${days}d ${hm}` : hm;
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
  const title = h.title.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, l: string, d?: string) => d ?? l);
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

for (const [keys, command] of [
  ["C-c C-x C-i", "org-clock-in"],
  ["C-c C-x C-o", "org-clock-out"],
  ["C-c C-x C-q", "org-clock-cancel"],
  ["C-c C-x C-j", "org-clock-goto"],
  ["C-c C-x C-x", "org-clock-in-last"],
] as const) {
  e8.defineKey("org-mode-map", keys, command);
}
