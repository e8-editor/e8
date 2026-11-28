// Timers for Org buffers, after Org's org-timer.el: a relative timer that
// counts up, from 0 or an offset, whose value C-c C-x . inserts and C-c C-x -
// starts a list item with, as notes of a meeting are taken; and a countdown,
// C-c C-x ;, that says when its time is up. C-c C-x , pauses and continues
// either, C-c C-x _ stops it, and the mode line shows it as it runs. Times
// are read from E8's clock, as float seconds.
//
// Copyright (C) 2008-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { durationToMinutes, headingIndex, headings, headingText, indentLine } from "org";
import { agendaLineEntry } from "org-agenda";
import { orgNotify } from "org-clock";
import { entryGet, inItem, insertItemStruct, itemLine, itemParts, listStruct, parentsAlist, prevsAlist, topGet, writeStruct } from "org-list";
import { lineAt } from "org-macs";
import { truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-timer-start-time", null, "Start time for the running timer, in seconds, or nil.");
defvar("org-timer-pause-time", null, "Time when the timer was paused, in seconds, or nil.");
defvar(
  "org-timer-countdown-timer",
  null,
  "Current countdown timer: the timer while a countdown runs, paused while one is paused, and nil otherwise.",
);
defvar("org-timer-countdown-timer-title", null, "Title for the notification displayed when a countdown finishes.");
defvar("org-timer-re", "\\([-+]?[0-9]+\\):\\([0-9]\\{2\\}\\):\\([0-9]\\{2\\}\\)", "Regular expression used to match timer stamps.");
defvar("org-timer-format", "%s ", 'The format to insert the time of the timer, with one "%s", which the timer\'s value replaces.');
defvar("org-timer-default-timer", "0", "The default timer when a timer is set, in minutes or hh:mm:ss format. When 0, the user is asked for a value.");
defvar(
  "org-timer-display",
  e8.intern("mode-line"),
  "Where a running timer is displayed: mode-line, frame-title, both, or nil for nowhere.",
);
defvar("org-timer-mode-line-string", null, "What the mode line shows of the running timer.");
defvar("org-timer-mode-line-timer", null, "The timer that updates the timer in the mode line each second.");
e8.defineHook("org-timer-start-hook", "Hook run after the relative timer is started.");
e8.defineHook("org-timer-stop-hook", "Hook run before the relative or countdown timer is stopped.");
e8.defineHook("org-timer-pause-hook", "Hook run before the relative or countdown timer is paused.");
e8.defineHook("org-timer-continue-hook", "Hook run after the relative or countdown timer is continued.");
e8.defineHook("org-timer-set-hook", "Hook run after the countdown timer is set.");
e8.defineHook("org-timer-done-hook", "Hook run after the countdown timer reaches zero.");

const TIMER_RE = "[-+]?[0-9]+:[0-9]\\{2\\}:[0-9]\\{2\\}";

/** A variable's value as a number of seconds, or undefined for nil. */
function timeVar(name: string): number | undefined {
  const v = e8.variable(name);
  return typeof v === "number" ? v : undefined;
}

/** A time as float-time takes it: now for none. */
const floatTime = (t: number | undefined): number => t ?? e8.currentTime();

/** A symbol's name, or a string, as variables holding symbols are set either way. */
function symbolValue(name: string): string | undefined {
  const v = e8.variable(name);
  if (typeof v === "symbol") return e8.symbolName(v);
  return typeof v === "string" ? v : undefined;
}

/** The countdown: a timer, "paused", or undefined, as org-timer-countdown-timer. */
function countdown(): number | "paused" | undefined {
  const v = e8.variable("org-timer-countdown-timer");
  if (typeof v === "number") return v;
  return truthy(v) ? "paused" : undefined;
}

function setCountdown(v: number | "paused" | undefined): void {
  e8.setVariable("org-timer-countdown-timer", v === undefined ? null : v === "paused" ? e8.intern("paused") : v);
}

/** Starts the relative timer, as org-timer-start. */
export function timerStart(offset: e8.Value = null): void {
  if (Array.isArray(offset) && offset[0] === 16) {
    e8.callInteractively("org-timer-change-times-in-region" as any);
    return;
  }
  if (countdown() !== undefined) e8.userError("Countdown timer is running.  Cancel first");
  let delta: number | undefined;
  if (!truthy(offset)) e8.setVariable("org-timer-start-time", e8.currentTime());
  else {
    if (typeof offset === "number") delta = offset;
    // Not M--, a symbol in Emacs, which asks.
    else if (typeof offset === "string" && offset !== "-") delta = hmsToSecs(offset);
    else {
      const def = inRegexp(String(e8.variable("org-timer-re"))) ?? "0:00:00";
      let s = e8.readString(`Restart timer with offset [${def}]: `);
      if (!/\S/.test(s)) s = def;
      delta = hmsToSecs(fixIncomplete(s));
    }
    e8.setVariable("org-timer-start-time", e8.currentTime() - delta);
  }
  e8.setVariable("org-timer-pause-time", null);
  setModeLine("on");
  e8.message(
    `Timer start time set to ${e8.formatTimeString("%T", timeVar("org-timer-start-time"))}, current value is ${secsToHms(delta ?? 0)}`,
  );
  e8.runHooks("org-timer-start-hook");
}

/** The timer stamp around point, as org-in-regexp finds a match of RE on point's line that point is in or at the end of. */
function inRegexp(re: string): string | undefined {
  const line = lineAt();
  const start = e8.lineStart(line);
  const end = e8.lineEnd(line);
  const pt = e8.point();
  return e8.saveExcursion(() => {
    e8.gotoChar(start);
    while (e8.reSearchForward(re, { bound: end, noerror: true }) !== undefined) {
      const b = e8.matchBeginning(0) ?? 0;
      const f = e8.matchEnd(0) ?? 0;
      if (b > pt) return undefined;
      if (f >= pt) return e8.matchString(0);
      if (f === b) e8.gotoChar(e8.point() + 1);
    }
    return undefined;
  });
}

/** Pauses or continues the relative or countdown timer, or with STOP stops it, as org-timer-pause-or-continue. */
export function timerPauseOrContinue(stop: e8.Value = null): void {
  if (truthy(stop)) return timerStop();
  const start = timeVar("org-timer-start-time");
  const pause = timeVar("org-timer-pause-time");
  if (start === undefined) e8.signal("error", "No timer is running");
  if (pause !== undefined) {
    if (countdown() !== undefined) {
      const newSecs = start - pause;
      setCountdown(runCountdownTimer(newSecs, e8.variable("org-timer-countdown-timer-title") ?? null));
      e8.setVariable("org-timer-start-time", e8.currentTime() + newSecs);
    } else {
      e8.setVariable("org-timer-start-time", e8.currentTime() - (pause - start));
    }
    e8.setVariable("org-timer-pause-time", null);
    setModeLine("on");
    e8.runHooks("org-timer-continue-hook");
    e8.message(`Timer continues at ${valueString()}`);
  } else {
    const timer = countdown();
    if (timer !== undefined) {
      if (typeof timer === "number") e8.cancelTimer(timer);
      setCountdown("paused");
    }
    e8.runHooks("org-timer-pause-hook");
    e8.setVariable("org-timer-pause-time", e8.currentTime());
    setModeLine("paused");
    e8.message(`Timer paused at ${valueString()}`);
  }
}

/** Stops the relative or countdown timer, as org-timer-stop. */
export function timerStop(): void {
  if (timeVar("org-timer-start-time") === undefined) e8.userError("No timer running");
  const timer = countdown();
  if (typeof timer === "number") e8.cancelTimer(timer);
  e8.runHooks("org-timer-stop-hook");
  e8.setVariable("org-timer-start-time", null);
  e8.setVariable("org-timer-pause-time", null);
  setCountdown(undefined);
  setModeLine("off");
  e8.message("Timer stopped");
}

/** Inserts the timer's value, starting it the first time or with C-u, or returns it with NO-INSERT, as org-timer. */
export function orgTimer(restart: e8.Value = null, noInsert = false): string | undefined {
  if (Array.isArray(restart) && restart[0] === 16) {
    timerStart(restart);
    return undefined;
  }
  if ((Array.isArray(restart) && restart[0] === 4) || timeVar("org-timer-start-time") === undefined) timerStart();
  if (noInsert) return valueString();
  e8.insert(valueString());
  return undefined;
}

/** The timer's value as org-timer-format writes it, as org-timer-value-string. */
export function valueString(): string {
  const time = floatTime(timeVar("org-timer-pause-time")) - floatTime(timeVar("org-timer-start-time"));
  return e8.format(String(e8.variable("org-timer-format") ?? "%s "), secsToHms(Math.abs(Math.floor(countdown() !== undefined ? -time : time))));
}

/** Changes every h:mm:ss time between BEG and END by DELTA, by default the first to zero, as org-timer-change-times-in-region. */
export function changeTimesInRegion(beg: number, end: number, delta: string): void {
  if (!/\S/.test(delta)) {
    e8.saveExcursion(() => {
      e8.gotoChar(beg);
      if (e8.reSearchForward(TIMER_RE, { bound: end, noerror: true }) !== undefined) {
        const found = e8.matchString(0) ?? "";
        delta = found.startsWith("-") ? found.slice(1) : `-${found}`;
      }
    });
  }
  const secs = hmsToSecs(fixIncomplete(delta));
  if (secs === 0) e8.signal("error", "No change");
  e8.saveExcursion(() => {
    e8.gotoChar(end);
    while (e8.reSearchBackward(TIMER_RE, { bound: beg, noerror: true }) !== undefined) {
      const p = e8.point();
      e8.replaceMatch(secsToHms(hmsToSecs(e8.matchString(0) ?? "") + secs), { literal: true, fixedCase: true });
      e8.gotoChar(p);
    }
  });
}

/** Whether the item on LINE starts with a timer, as org-at-item-timer-p. */
export function atItemTimerP(line: number): boolean {
  return itemLine(line) && /^[ \t]*(?:[-+*]|(?:[0-9]+|[A-Za-z])[.)])(?:[ \t]+|$)(?:\[@(?:start:)?(?:[0-9]+|[A-Za-z])\][ \t]*)?[0-9]+:[0-9]+:[0-9]+[ \t]+::[ \t]+/.test(e8.lineText(line));
}

/** Inserts a description item with the timer's value, as org-timer-item; ARG goes to org-timer. */
export function timerItem(arg: e8.Value = null): void {
  const itemp = inItem(lineAt());
  const pos = e8.point();
  const restart = truthy(arg) ? [4] : null;
  if (itemp !== undefined) {
    e8.gotoChar(itemp);
    if (!atItemTimerP(lineAt(itemp))) {
      e8.gotoChar(pos);
      e8.signal("error", "This is not a timer list");
    }
    let struct = listStruct(lineAt(itemp));
    const prevs = prevsAlist(struct);
    const s = `${orgTimer(restart, true)}:: `;
    struct = insertItemStruct(pos, struct, prevs, false, s);
    const newLine = lineAt();
    const lines = struct.map((item) => lineAt(item.pos));
    const before = lines.map((l) => itemParts(l)?.bullet);
    writeStruct(struct, parentsAlist(struct));
    // Org's looking-at here fails, point being inside a line, and leaves the
    // match data of the last bullet org-list-write-struct replaced, the
    // topmost it changed, or else the new item's: point goes to the end of
    // that item's bullet and tag, as Org's goto-char (match-end 0) does.
    const changed = lines.find((l, i) => l !== newLine && itemParts(l)?.bullet !== before[i]);
    const parts = itemParts(changed !== undefined && changed < newLine ? changed : newLine);
    if (parts) e8.gotoChar(parts.matchEnd);
    return;
  }
  e8.gotoChar(e8.lineStart(lineAt()));
  indentLine(lineAt());
  e8.insert("- ");
  orgTimer(restart);
  e8.insert(":: ");
}

/** HMS with a missing hour, or hour and minute, filled in, as org-timer-fix-incomplete. */
export function fixIncomplete(hms: string): string {
  const m = /(?:([0-9]+:)?([0-9]+:))?([0-9]+)/.exec(hms);
  if (!m) e8.signal("error", `Cannot parse HMS string "${hms}"`);
  const n = (s: string | undefined): number => (s === undefined ? 0 : parseInt(s, 10));
  const fixed = `${n(m[1])}:${String(n(m[2])).padStart(2, "0")}:${String(n(m[3])).padStart(2, "0")}`;
  return hms.slice(0, m.index) + fixed + hms.slice(m.index + m[0].length);
}

/** Seconds in an h:mm:ss string, negative if it starts with a minus, 0 if it is not one, as org-timer-hms-to-secs. */
export function hmsToSecs(hms: string): number {
  const m = /([-+]?[0-9]+):([0-9]{2}):([0-9]{2})/.exec(hms);
  if (!m) return 0;
  const h = Math.abs(parseInt(m[1], 10));
  const sign = m[1].startsWith("-") ? -1 : 1;
  return sign * (parseInt(m[3], 10) + 60 * (parseInt(m[2], 10) + 60 * h));
}

/** Seconds as h:mm:ss, starting with a minus if negative, as org-timer-secs-to-hms. */
export function secsToHms(s: number): string {
  const sign = s < 0 ? "-" : "";
  s = Math.abs(s);
  let m = Math.trunc(s / 60);
  s -= 60 * m;
  const h = Math.trunc(m / 60);
  m -= 60 * h;
  return `${sign}${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Adds the timer's string to a mode line construct's list, as a string one becomes the first of a list. */
function withTimerString(format: e8.Value | undefined, empty: boolean): e8.Value[] {
  const sym = e8.intern("org-timer-mode-line-string");
  const list = Array.isArray(format) ? format : truthy(format) ? [format as e8.Value] : empty ? [""] : [];
  return list.includes(sym) ? list : [...list, sym];
}

/** Takes the timer's string out of a mode line construct's list. */
function withoutTimerString(format: e8.Value | undefined): e8.Value | undefined {
  const sym = e8.intern("org-timer-mode-line-string");
  return Array.isArray(format) ? format.filter((v) => v !== sym) : format;
}

/** Shows the timer where org-timer-display says, whose string the timer updates. */
function showTimerString(): void {
  const display = symbolValue("org-timer-display");
  if (display === "mode-line" || display === "both") e8.setVariable("global-mode-string", withTimerString(e8.variable("global-mode-string"), true));
  if (display === "frame-title" || display === "both") e8.setVariable("frame-title-format", withTimerString(e8.variable("frame-title-format"), false));
}

/** Sets the mode line's display of the timer on, off or paused, as org-timer-set-mode-line. */
function setModeLine(value: "on" | "off" | "paused"): void {
  showTimerString();
  const display = symbolValue("org-timer-display");
  const cancel = (): void => {
    const timer = e8.variable("org-timer-mode-line-timer");
    if (typeof timer === "number") {
      e8.cancelTimer(timer);
      e8.setVariable("org-timer-mode-line-timer", null);
    }
  };
  if (value === "off") {
    cancel();
    if (display === "mode-line" || display === "both") e8.setVariable("global-mode-string", withoutTimerString(e8.variable("global-mode-string")) ?? null);
    if (display === "frame-title" || display === "both") e8.setVariable("frame-title-format", withoutTimerString(e8.variable("frame-title-format")) ?? null);
    e8.forceModeLineUpdate();
  } else if (value === "paused") {
    cancel();
  } else {
    updateModeLine();
    cancel();
    if (truthy(e8.variable("org-timer-display"))) e8.setVariable("org-timer-mode-line-timer", e8.runWithTimer(1, 1, updateModeLine));
  }
}

/** Updates the timer's time in the mode line, as org-timer-update-mode-line. */
function updateModeLine(): void {
  if (timeVar("org-timer-pause-time") !== undefined) return;
  // A countdown that ran out leaves no start time, as org-timer-value-string would then count from now.
  if (timeVar("org-timer-start-time") === undefined && countdown() === undefined) return;
  e8.setVariable("org-timer-mode-line-string", ` <${valueString().slice(0, -1)}>`);
  e8.forceModeLineUpdate();
}

/** Says how long is left before the countdown ends, as org-timer-show-remaining-time. */
export function showRemainingTime(): void {
  const timer = countdown();
  if (timer === undefined) return e8.message("No timer set");
  if (timer === "paused") e8.signal("wrong-type-argument", "Wrong type argument", [e8.intern("timerp"), e8.intern("paused")]);
  // When the countdown's timer runs out, the start time Org sets just after starting it.
  const due = timeVar("org-timer-start-time") ?? e8.currentTime();
  const left = Math.floor(due - e8.currentTime());
  e8.message(`${Math.floor(left / 60)} minute(s) ${left % 60} seconds left before next time out`);
}

/** The effort of the entry at point in minutes, from the agenda line's or the Org entry's, as org-timer-set-timer reads it. */
function effortMinutes(): number | undefined {
  if (e8.derivedModeP("org-agenda-mode")) return agendaLineEntry()?.effort;
  if (!e8.derivedModeP("org-mode")) return undefined;
  const property = String(e8.variable("org-effort-property") ?? "Effort");
  const all = headings();
  const i = headingIndex(all, lineAt());
  const effort = i === undefined ? topGet(property) : entryGet(all[i].line, property);
  if (effort === undefined || !/\S/.test(effort)) return undefined;
  return Math.floor(durationToMinutes(effort));
}

/** Asks for a duration and sets a countdown, as org-timer-set-timer. */
export function setTimer(opt: e8.Value = null): void {
  if (timeVar("org-timer-start-time") !== undefined && countdown() === undefined) e8.userError("Relative timer is running.  Stop first");
  const def = e8.variable("org-timer-default-timer");
  const defaultTimer = typeof def === "number" ? String(def) : String(def ?? "0");
  const effort = effortMinutes();
  let minutes =
    typeof opt === "number"
      ? String(opt)
      : !(Array.isArray(opt) && opt[0] === 64) && effort !== undefined
        ? String(effort)
        : Array.isArray(opt)
          ? defaultTimer
          : typeof opt === "string" && opt !== "-"
            ? opt
            : e8.readString("How much time left? (minutes or h:mm:ss) ", defaultTimer === "0" ? {} : { initial: defaultTimer });
  if (/^[0-9]+$/.test(minutes)) minutes += ":00";
  if (!/[0-9]+/.test(minutes)) return showRemainingTime();
  const secs = hmsToSecs(fixIncomplete(minutes));
  const timer = countdown();
  if (timer !== undefined && !((Array.isArray(opt) && opt[0] === 16) || e8.yOrNP("Replace current timer? "))) {
    e8.message("No timer set");
    return;
  }
  if (typeof timer === "number") e8.cancelTimer(timer);
  const title = timerTitle();
  e8.setVariable("org-timer-countdown-timer-title", title);
  setCountdown(runCountdownTimer(secs, title));
  e8.runHooks("org-timer-set-hook");
  e8.setVariable("org-timer-start-time", e8.currentTime() + secs);
  e8.setVariable("org-timer-pause-time", null);
  setModeLine("on");
}

/** Starts a countdown of SECS, whose notice ends with TITLE, as org-timer--run-countdown-timer. */
function runCountdownTimer(secs: number, title: e8.Value): number {
  const msg = `${title === null || title === undefined || title === false ? "nil" : String(title)}: time out`;
  const sound = e8.variable("org-clock-sound") ?? null;
  return e8.runWithTimer(secs, null, () => {
    setCountdown(undefined);
    e8.setVariable("org-timer-start-time", null);
    orgNotify(msg, sound);
    setModeLine("off");
    e8.runHooks("org-timer-done-hook");
  });
}

/** The heading of the entry at point, or of an agenda line's, or the buffer's name, as org-timer--get-timer-title. */
function timerTitle(): string | null {
  const heading = (): string | null => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    return i === undefined ? null : headingText(all[i].line);
  };
  if (e8.derivedModeP("org-agenda-mode")) {
    const entry = agendaLineEntry();
    if (entry === undefined || e8.getBuffer(entry.buffer) === undefined) return null;
    return e8.withCurrentBuffer(entry.buffer, () =>
      e8.saveRestriction(() => {
        e8.widen();
        return e8.saveExcursion(() => {
          e8.gotoChar(entry.heading);
          return heading() ?? e8.bufferName(e8.bufferBaseBuffer() ?? e8.currentBuffer()) ?? null;
        });
      }),
    );
  }
  if (e8.derivedModeP("org-mode")) return heading();
  return e8.bufferName(e8.bufferBaseBuffer() ?? e8.currentBuffer()) ?? null;
}

const PREFIX: e8.Param[] = [{ name: "arg", kind: "prefix" }];

e8.defineCommand({
  name: "org-timer-start",
  doc:
    "Set the starting time for the relative timer to now. With a prefix argument, ask for an offset, the timer stamp at point by default; " +
    "with C-u C-u, shift every timer stamp in the region instead, by default making the first 0:00:00.",
  params: PREFIX,
  run: (offset: e8.Value) => timerStart(offset),
});
e8.defineCommand({
  name: "org-timer-pause-or-continue",
  doc: "Pause or continue the relative or countdown timer. With a prefix argument, stop it entirely.",
  params: PREFIX,
  run: (stop: e8.Value) => timerPauseOrContinue(stop),
});
e8.defineCommand({
  name: "org-timer-stop",
  doc: "Stop the relative or countdown timer.",
  run: () => timerStop(),
});
e8.defineCommand({
  name: "org-timer",
  doc:
    "Insert an H:MM:SS string from the timer, starting the timer the first time. With C-u, restart the timer; " +
    "with C-u C-u, change every timer string in the region by a fixed amount, as to put right a timer started at the wrong moment.",
  params: PREFIX,
  run: (restart: e8.Value) => {
    orgTimer(restart);
  },
});
e8.defineCommand({
  name: "org-timer-change-times-in-region",
  doc: "Change every h:mm:ss time in the region by a difference, by default the one that makes the first 0:00:00.",
  params: [
    { name: "beg", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "delta", prompt: 'Enter time difference like "-1:08:26".  Default is first time to zero: ' },
  ],
  run: (beg: number, end: number, delta: string) => changeTimesInRegion(beg, end, String(delta)),
});
e8.defineCommand({
  name: "org-timer-item",
  doc: "Insert a description item with the timer's value, or a new item in a timer list. A prefix argument restarts the timer.",
  params: PREFIX,
  run: (arg: e8.Value) => timerItem(arg),
});
e8.defineCommand({
  name: "org-timer-show-remaining-time",
  doc: "Say how long is left before the countdown timer ends.",
  run: () => showRemainingTime(),
});
e8.defineCommand({
  name: "org-timer-set-timer",
  doc:
    "Ask for a duration in minutes or h:mm:ss and start a countdown, the entry's effort by default. " +
    "A number as prefix argument is the minutes; C-u takes org-timer-default-timer without asking, C-u C-u also replaces a running countdown, " +
    "and C-u C-u C-u ignores the effort.",
  params: PREFIX,
  run: (opt: e8.Value) => setTimer(opt),
});

e8.defun("org-timer-value-string", () => valueString());
e8.defun("org-at-item-timer-p", (pos?: number | null) => atItemTimerP(lineAt(typeof pos === "number" ? pos : e8.point())));
e8.defun("org-timer-hms-to-secs", (hms: string) => hmsToSecs(String(hms)));
e8.defun("org-timer-secs-to-hms", (s: number) => secsToHms(Number(s)));
e8.defun("org-timer-fix-incomplete", (hms: string) => fixIncomplete(String(hms)));

for (const [keys, command] of [
  ["C-c C-x .", "org-timer"],
  ["C-c C-x -", "org-timer-item"],
  ["C-c C-x 0", "org-timer-start"],
  ["C-c C-x _", "org-timer-stop"],
  ["C-c C-x ;", "org-timer-set-timer"],
  ["C-c C-x ,", "org-timer-pause-or-continue"],
] as const) {
  e8.defineKey("org-mode-map", keys, command as any);
}
e8.defineKey("org-agenda-mode-map", ";", "org-timer-set-timer" as any);
e8.defineKey("org-agenda-mode-map", "C-c C-x _", "org-timer-stop" as any);
