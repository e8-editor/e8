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
  allKeywords,
  combinePlists,
  createDblock,
  type DateTime,
  durationFromMinutes,
  durationToMinutes,
  categories,
  dynamicBlockDefine,
  entryGetAt,
  entryGetInherited,
  findDblock,
  formatTimestamp,
  type Heading,
  headingIndex,
  headings,
  isDone,
  keepMarkerThroughSort,
  keepMarkersThroughMoves,
  levelFace,
  logDrawer,
  makeTagsMatcher,
  matchContexts,
  matcherTime,
  parseDate,
  plistGet,
  propertyInheritP,
  readDateAnswer,
  reducedLevel,
  tableSortLines,
  today,
  orgCurrentTime,
  updateDblock,
} from "org";
import { findBufferVisiting } from "files";
import { linkDisplayFormat, linkHeadingSearchString, linkMakeString } from "ol";
import { elementAt } from "org-element";
import { showEntry, showSetVisibility, toggleDrawerOrBlock } from "org-fold";
import { endOfMetaData, entryGet, entryPut } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { setRunningClock } from "org-refile";
import { allMatches, charCount, eraseBuffer, executableFind, forwardLine, truthy } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-clock-into-drawer", true, "Whether CLOCK: lines go into a drawer: t for LOGBOOK, or org-log-into-drawer's drawer if that names one, or the drawer's name.");
defvar("org-clock-out-when-done", true, "Whether marking the clocked entry done stops the clock.");
defvar("org-clock-out-remove-zero-time-clocks", false, "Whether a clock stopped after no time is taken out.");
defvar("org-log-note-clock-out", false, "Whether stopping a clock asks for a note, put after the CLOCK: line. #+STARTUP: lognoteclock-out or nolognoteclock-out says for a file.");
defvar("org-mode-line-string", "", "What the mode line shows of the running clock: its time and its entry's heading.");
e8.defineHook("org-clock-in-hook", "Functions called when a clock starts.");
e8.defineHook("org-clock-out-hook", "Functions called when a clock stops.");
e8.defineHook("org-clock-cancel-hook", "Functions called when a clock is cancelled.");
e8.defineHook("org-clock-goto-hook", "Functions called after org-clock-goto has gone to the clocked entry.");
e8.defineFace({ name: "org-mode-line-clock", doc: "The running clock in the mode line.", attributes: { inherit: "mode-line" } });
e8.defineFace({ name: "org-mode-line-clock-overrun", doc: "The running clock in the mode line once it has run past the entry's effort.", attributes: { inherit: "mode-line", background: "red" } });
defvar("org-clock-mode-line-total", "auto", 'Which clocked time the mode line shows: "all", "today", "repeat" since LAST_REPEAT, "current" for this clock only, or "auto", since LAST_REPEAT if the entry has one, else all. An entry\'s CLOCK_MODELINE_TOTAL overrides it.');
defvar("org-clock-history-length", 5, "How many recently clocked tasks C-u C-c C-x C-i offers.");
defvar("org-clock-current-task", null, "The running clock's entry's title, without TODO keyword, priority, COMMENT or tags.");
defvar("org-clock-effort", null, "The running clock's entry's effort, shown in the mode line after the time clocked.");
defvar("org-clock-task-overrun-text", null, "Text put before the clock in the mode line once it runs past the effort; nil shows the time in org-mode-line-clock-overrun instead.");
defvar("org-clock-string-limit", 0, "How long the clock in the mode line may be, cut there; 0 for no limit.");
defvar("org-clock-goto-may-find-recent-task", true, "Whether org-clock-goto goes to the task clocked last when no clock runs.");
defvar(
  "org-show-notification-handler",
  null,
  "A function given each Org notification, as a clock running past its effort, or a program run with it; nil shows it on the desktop where E8 can, else in the echo area.",
);
defvar("org-clock-sound", null, "What sounds when the clock runs past the entry's effort: t for the bell twice, a sound file's name, or nil for nothing.");
defvar("org-clock-out-switch-to-state", null, "A TODO state to switch a task to when its clock stops, or a function of its state giving one.");
defvar("org-clock-in-switch-to-state", null, "A TODO state to switch a task to when clocking it in, or a function of its state giving one.");
defvar("org-clock-continuously", false, "Whether clocking in starts from when the clock was last stopped, rather than now.");

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
/** The entries clocked lately, the latest first, as org-clock-history. */
let history: e8.Marker[] = [];
/** The task C-u C-u C-c C-x C-i marked, offered as d, as org-clock-default-task. */
let defaultTask: e8.Marker | undefined;
/** The clock a clock-in stopped, offered as i, as org-clock-interrupted-task. */
let interruptedTask: e8.Marker | undefined;
/** Whether the clock running past its effort has been told already, as org-clock-notification-was-shown. */
let notified = false;
/** When the clock was last stopped, as org-clock-out-time. */
let outTime: DateTime | undefined;

// The clock's markers follow its entry when moved, cut and pasted or refiled, as org-clock-save-markers-for-cut-and-paste.
keepMarkersThroughMoves(() => [clock?.line, clock?.heading, last, defaultTask, interruptedTask, ...history]);
// The clock's line stays in its entry when entries are sorted, as org-sort-entries puts org-clock-marker back; the rest go to the sorted text's start.
keepMarkerThroughSort(() => clock?.line);
let timer: number | undefined;

/** Now, or the day tests fix at noon, as an Org time. */
function now(): DateTime {
  return today(true);
}

e8.defineVariable({
  name: "org-clock-rounding-minutes",
  doc: "Round the times clocking in and out take to this many minutes, a clock-in time to one not after now; 0 does not round.",
  value: 0,
});

/** The time a clock starts or stops, rounded to org-clock-rounding-minutes, with PAST not after now, as org-current-time is called for them. */
function clockTime(past: boolean): DateTime {
  return orgCurrentTime(e8.variable("org-clock-rounding-minutes") ?? null, past);
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
function clockedBefore(all: Heading[], i: number): { minutes: number; extra: string } {
  // From when, as org-clock-get-sum-start: CLOCK_MODELINE_TOTAL or
  // org-clock-mode-line-total says, auto meaning since LAST_REPEAT if there is one.
  const h = all[i];
  const own = entryGet(h.line, "CLOCK_MODELINE_TOTAL");
  // Inherited if org-use-property-inheritance names it, as org-entry-get with 'selective.
  const inherited = propertyInheritP("CLOCK_MODELINE_TOTAL") ? entryGetInherited(h, "CLOCK_MODELINE_TOTAL", false) : own;
  const setting = e8.variable("org-clock-mode-line-total");
  const cmt = inherited ?? (typeof setting === "symbol" ? e8.symbolName(setting) : String(setting ?? "auto"));
  const lr = entryGet(h.line, "LAST_REPEAT");
  let tstart: number | undefined;
  let extra = "";
  if (cmt === "current") {
    extra = "showing time in current clock instance";
    tstart = millis(now()) / 1000;
  } else if (cmt === "today") {
    extra = "showing today's task time.";
    const extend = Number(e8.variable("org-extend-today-until") ?? 0);
    const t = now();
    const day = (t.hour ?? 0) < extend ? t.day - 1 : t.day;
    tstart = e8.encodeTime([0, 0, extend, day, t.month, t.year, null, -1, null]);
  } else if (cmt === "all" || (cmt === "auto" && lr === undefined)) {
    extra = "showing entire task time.";
  } else if (cmt === "repeat" || (cmt === "auto" && lr !== undefined)) {
    extra = "showing task time since last repeat.";
    tstart = lr === undefined ? undefined : matcherTime(lr);
  }
  // The whole subtree's, as org-clock-sum-current-item.
  const minutes = e8.saveExcursion(() =>
    e8.saveRestriction(() => {
      e8.gotoChar(h.start);
      e8.call("org-narrow-to-subtree");
      return clockSum(tstart);
    }),
  );
  return { minutes, extra };
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
  const into = e8.variable("org-clock-into-drawer");
  // A number: a drawer once there would be that many clocks.
  const threshold = typeof into === "number" ? into : undefined;
  const reversed = truthy(e8.variable("org-log-states-order-reversed") ?? null);
  if (drawer !== undefined) {
    const opener = new RegExp(`^[ \\t]*:${drawer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*$`, "i");
    for (let l = h.line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
      if (!opener.test(e8.lineText(l))) continue;
      // Newest first at its top, or oldest first at its end.
      if (!reversed) {
        for (let k = l + 1; k < e8.lineCount() && e8.lineStart(k) < end; k++) {
          if (/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(k))) return e8.lineStart(k);
        }
      }
      return lineStartOrEnd(l + 1);
    }
  }
  // The entry's CLOCK lines, those Org's parser sees as clocks.
  const clocks: number[] = [];
  for (let l = h.line + 1; l < e8.lineCount() && e8.lineStart(l) < end; l++) {
    if (/^[ \t]*CLOCK:/.test(e8.lineText(l)) && elementAt(e8.lineStart(l))?.type === "clock") clocks.push(l);
  }
  if (clocks.length === 0) {
    let at = endOfMetaData(h);
    // Before the markers there, as Org's insert-before-markers-and-inherit puts them.
    if (at !== e8.lineStart(lineAt(at))) {
      e8.gotoChar(at);
      e8.insertBeforeMarkers("\n");
      at = e8.point();
    }
    if (drawer === undefined || (threshold !== undefined && threshold >= 2)) return at;
    e8.gotoChar(at);
    e8.insertBeforeMarkers(`:${drawer}:\n:END:\n`);
    toggleDrawerOrBlock(lineAt(at), true);
    return e8.lineStart(lineAt(at) + 1);
  }
  if (drawer !== undefined && (threshold === undefined || clocks.length + 1 >= threshold)) {
    // As Org: the entry's clocks gathered into a new drawer after its metadata.
    const meta = endOfMetaData(h);
    const texts: string[] = [];
    for (let k = clocks.length - 1; k >= 0; k--) {
      const lineEnd = lineStartOrEnd(clocks[k] + 1);
      let from = e8.lineStart(clocks[k]);
      while (from > meta && /[ \r\t\n]/.test(e8.bufferText(from - 1, from))) from--;
      from = from === meta ? meta : lineStartOrEnd(lineAt(from) + 1);
      // Last first, as Org gathers them.
      texts.push(e8.lineText(clocks[k]).trim());
      e8.deleteRegion(Math.min(from, e8.lineStart(clocks[k])), lineEnd);
    }
    e8.gotoChar(meta);
    e8.insert(`:${drawer}:\n${texts.join("\n")}\n:END:\n`);
    // Not folded, as Emacs shows it after clocking in.
    const opener = lineAt(meta);
    // Org puts the opener in with insert-before-markers inside
    // save-excursion, which carries point past it, then goes a line on: so
    // newest first still comes after the first clock.
    return e8.lineStart(reversed ? opener + 2 : opener + texts.length);
  }
  return e8.lineStart(reversed ? clocks[0] : clocks[clocks.length - 1]);
}

/** The minutes clocked on the running clock's entry, this clock's and before, as org-clock-get-clocked-time. */
function clockedTime(): number {
  return clock ? Math.max(0, Math.floor((millis(now()) - clock.start) / 60000)) + clock.before : 0;
}

/** Shows a notification and plays the sound, as org-notify. */
export function orgNotify(text: string, sound: e8.Value = null): void {
  showNotification(text);
  if (truthy(sound)) playSound(sound);
}
e8.defun("org-notify", (text: string, sound?: e8.Value) => orgNotify(String(text), sound ?? null));

/**
 * Shows a notification, as org-show-notification: through
 * org-show-notification-handler, a function or a program run with it; else
 * on the desktop, by AppleScript in the macOS app or notify-send; else in
 * the echo area.
 */
function showNotification(text: string): void {
  const handler = e8.variable("org-show-notification-handler");
  const name = typeof handler === "symbol" ? e8.symbolName(handler) : undefined;
  if (typeof handler === "function") e8.funcall(handler, text);
  else if (name !== undefined && e8.fboundp(name)) e8.funcall(name, text);
  // Programs not while an agent acts, which would have to ask to run them; the echo area instead.
  else if (e8.agentActing()) e8.message(text);
  else if (typeof handler === "string") e8.makeProcess({ name: "emacs-timer-notification", command: [handler, text] });
  else if (canApplescript()) e8.nsDoApplescript(`display notification "${text.replace(/"/g, "#")}" with title "Org mode notification"`);
  else if (executableFind("notify-send") !== undefined) e8.makeProcess({ name: "emacs-timer-notification", command: ["notify-send", text] });
  else e8.message(text);
}

/** Whether AppleScript can show a notification: in the macOS app, as Emacs's NS build has ns-do-applescript. */
function canApplescript(): boolean {
  return e8.windowSystem() === "ns";
}

/** Plays org-clock-sound, or SOUND: t rings the bell twice; a file plays with aplay, else the bell, as org-clock-play-sound. */
function playSound(sound: e8.Value): void {
  if (sound === true) {
    e8.ding();
    e8.ding();
    return;
  }
  if (typeof sound !== "string") return;
  const file = e8.expandFileName(sound);
  if (!e8.fileExists(file)) return;
  // aplay, not while an agent acts; else play-sound-file, which E8 lacks, as Emacs on a Mac does: the bell.
  if (executableFind("aplay") !== undefined && !e8.agentActing()) e8.makeProcess({ name: "org-clock-play-notification", command: ["aplay", file] });
  else if (e8.fboundp("play-sound-file")) e8.funcall("play-sound-file", file);
  else {
    e8.ding();
    e8.ding();
  }
}

/** Says once that the clock has run past the entry's effort, as org-clock-notify-once-if-expired; returns whether it has. */
function notifyOnceIfExpired(): boolean {
  if (!clock) return false;
  const effort = e8.variable("org-clock-effort");
  const minutes = typeof effort === "string" ? durationToMinutes(effort) : 0;
  const overrun = minutes !== 0 && clockedTime() >= minutes;
  if (!overrun) notified = false;
  else if (!notified) {
    notified = true;
    // A notification that fails says so, but leaves the clock running.
    e8.conditionCase(() => orgNotify(`Task \u2018${clock!.title}\u2019 should be finished by now. (${String(effort)})`, e8.variable("org-clock-sound") ?? null), {
      error: (err) => e8.message(e8.errorMessageString(err)),
    });
  }
  return overrun;
}

/** Shows the clock in every mode line, with the entry's effort if it has one, as org-clock-update-mode-line. */
function updateModeLine(): void {
  if (!clock) return;
  const effort = e8.variable("org-clock-effort");
  const overrun = typeof effort === "string" && notifyOnceIfExpired();
  const overrunText = e8.variable("org-clock-task-overrun-text");
  const face = { face: "org-mode-line-clock" };
  const done = durationFromMinutes(clockedTime());
  let text =
    typeof effort === "string"
      ? e8.concat(
          e8.propertize("[", face),
          e8.propertize(done, { face: overrun && typeof overrunText !== "string" ? "org-mode-line-clock-overrun" : "org-mode-line-clock" }),
          e8.propertize(`/${durationFromMinutes(durationToMinutes(effort))}] (${clock.title}) `, face),
        )
      : e8.propertize(`[${done}] (${clock.title}) `, face);
  const limit = Number(e8.variable("org-clock-string-limit") ?? 0);
  const chars = Array.from(text.string);
  if (limit > 0 && chars.length > limit) {
    text = new e8.PropertizedString(
      chars.slice(0, limit).join(""),
      text.properties.filter(([from]) => from < limit).map(([from, to, props]) => [from, Math.min(to, limit), props]),
    );
  }
  if (overrun && typeof overrunText === "string") text = e8.concat(e8.propertize(overrunText, { face: "org-mode-line-clock-overrun" }), text);
  e8.setVariable("org-mode-line-string", text);
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

/** Where the running clock's CLOCK line is, as org-clock-marker, to tell this clock from another. */
export function runningClockLine(): { buffer: string; pos: number } | undefined {
  const buffer = clock && e8.markerBuffer(clock.line);
  const pos = clock && e8.markerPosition(clock.line);
  return buffer === undefined || pos === undefined ? undefined : { buffer, pos };
}

e8.defineVariable({ name: "org-clock-heading", doc: "The running clock's task as the mode line names it.", value: "" });
e8.defineVariable({
  name: "org-clock-heading-function",
  doc: "A function giving the text the mode line and C-2 C-c C-w name the clocked task by, called at its heading, or nil for its heading.",
  value: null,
});

/**
 * The clocked task's name, as org-clock--mode-line-heading: what
 * org-clock-heading-function gives, else the heading without its state,
 * priority, COMMENT or tags, its links as their descriptions.
 */
function clockModeLineHeading(h: Heading): string {
  const fn = e8.variable("org-clock-heading-function");
  const name = typeof fn === "symbol" ? e8.symbolName(fn) : undefined;
  let title: string;
  // Only a function, as functionp checks: a name not defined yet gives the heading.
  if (typeof fn === "function" || (name !== undefined && e8.fboundp(name))) {
    const v = e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        e8.gotoChar(h.start);
        return e8.funcall(typeof fn === "function" ? fn : (name as string));
      }),
    );
    title = typeof v === "string" ? v : String(v ?? "");
  } else title = linkDescriptions(h.title.replace(/^COMMENT[ \t]+/, ""));
  e8.setVariable("org-clock-heading", title);
  return title;
}

/** A heading's text with each link as its description, or its target if it has none, as the links show. */
function linkDescriptions(text: string): string {
  return text.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, l: string, d?: string) => d ?? l);
}

/** A marker at POS in BUFFER. */
function markerIn(buffer: string, pos: number): e8.Marker {
  return e8.withCurrentBuffer(buffer, () => e8.makeMarker(pos));
}

/** Whether two markers point at the same place, as equal compares them. */
function sameMarker(a: e8.Marker, b: e8.Marker): boolean {
  return e8.markerBuffer(a) === e8.markerBuffer(b) && e8.markerPosition(a) === e8.markerPosition(b);
}

/** Puts a heading at the front of the clock history, once, keeping org-clock-history-length, as org-clock-history-push. */
function historyPush(buffer: string, pos: number): void {
  const length = Math.max(1, Number(e8.variable("org-clock-history-length") ?? 5));
  const m = markerIn(buffer, pos);
  history = history.filter((x) => {
    const keep = e8.markerBuffer(x) !== undefined && !sameMarker(x, m);
    if (!keep) e8.deleteMarker(x);
    return keep;
  });
  for (const x of history.splice(length - 1)) e8.deleteMarker(x);
  history.unshift(m);
}

/** A task's line in *Clock Task Select*: its key, category and heading without tags, as org-clock-insert-selection-line. */
function selectionLine(key: string, m: e8.Marker): string | e8.PropertizedString | undefined {
  const buffer = e8.markerBuffer(m);
  if (buffer === undefined) return undefined;
  return e8.withCurrentBuffer(buffer, () =>
    e8.saveRestriction(() => {
      e8.widen();
      const all = headings();
      const i = headingIndex(all, lineAt(e8.markerPosition(m) ?? 0));
      if (i === undefined) return undefined;
      const h = all[i];
      const task = e8.lineText(h.line).slice(h.level + 1).replace(/[ \t]+:[\p{L}\p{M}\p{Nd}\p{Nl}_@#%:]+:[ \t]*$/u, "").replace(/[ \t]+$/, "");
      // Fontified as in Org: in its level's face, links as their descriptions
      // with org-link-descriptive, else written out in org-link.
      const descriptive = truthy(e8.variable("org-link-descriptive") ?? true);
      // The level's face as org-get-level-face picks it, odd levels and all.
      const face = levelFace(h.level);
      return e8.concat(`[${key}] ${categories(all)[i].padEnd(12)}  `, descriptive ? e8.propertize(linkDisplayFormat(task), { face }) : linksAsShown(task, face), "\n");
    }),
  );
}

/** TEXT in FACE, its bracket links written out in org-link, as Org fontifies them without org-link-descriptive. */
function linksAsShown(text: string, face: string): string | e8.PropertizedString {
  const parts: (string | e8.PropertizedString)[] = [];
  let last = 0;
  for (const m of allMatches(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, text)) {
    const at = m.index ?? 0;
    parts.push(e8.propertize(text.slice(last, at), { face }), e8.propertize(m[0], { face: ["org-link", face] }));
    last = at + m[0].length;
  }
  parts.push(e8.propertize(text.slice(last), { face }));
  return e8.concat(...parts);
}

/**
 * Offers the clocked tasks in *Clock Task Select* and reads one by its
 * key, as org-clock-select-task: d the default task, i the interrupted
 * one, c the running one, and 1 to 9, then A on, the recent ones; q or x
 * gives none.
 */
function selectTask(prompt: string): e8.Marker | undefined {
  const recent = history.filter((m, k) => k === 0 || !sameMarker(m, history[k - 1]));
  if (recent.length === 0) e8.userError("No recent clock");
  const choices: [string, e8.Marker][] = [];
  const parts: (string | e8.PropertizedString)[] = [];
  const add = (header: string | undefined, key: string, m: e8.Marker | undefined) => {
    if (m === undefined || e8.markerBuffer(m) === undefined) return;
    if (header !== undefined) parts.push(e8.propertize(`${header}\n`, { face: "bold" }));
    const line = selectionLine(key, m);
    if (line === undefined) return;
    parts.push(line);
    choices.push([key, m]);
  };
  add("Default Task", "d", defaultTask);
  add("The task interrupted by starting the last one", "i", interruptedTask);
  if (clock) add("Current Clocking Task", "c", clock.line);
  parts.push(e8.propertize("Recent Tasks\n", { face: "bold" }));
  let n = 0;
  for (const m of recent) {
    if (e8.markerBuffer(m) === undefined) continue;
    n++;
    add(undefined, n < 10 ? String.fromCharCode(48 + n) : String.fromCharCode(65 + n - 10), m);
  }
  return e8.saveWindowExcursion(() => {
    const name = "*Clock Task Select*";
    e8.getBufferCreate(name);
    e8.call("switch-to-buffer-other-window", name);
    eraseBuffer();
    e8.insert(e8.concat(...parts));
    e8.runHooks("org-clock-before-select-task-hook");
    e8.gotoChar(e8.pointMin());
    let key: string;
    try {
      e8.message(prompt);
      key = e8.readCharExclusive();
    } finally {
      if (e8.getBuffer(name) !== undefined) e8.call("kill-buffer", name);
    }
    if (key === "q" || key === "x") return undefined;
    const found = choices.find(([k]) => k === key);
    if (found === undefined) e8.userError(`Invalid task choice ${key}`);
    return found![1];
  });
}

/** Marks the entry point is in as the default task, as org-clock-mark-default-task. */
function markDefaultTask(): void {
  const [all, i] = headingHere();
  if (defaultTask !== undefined) e8.deleteMarker(defaultTask);
  defaultTask = e8.makeMarker(all[i].start);
}

/**
 * Starts a clock on the entry at point, stopping one running elsewhere, as
 * org-clock-in: with C-u on a task picked from those clocked lately, and
 * with C-u C-u on the entry at point, marking it the default task.
 */
export function clockIn(select?: e8.PrefixArg, startTime?: DateTime): void {
  const raw = Array.isArray(select) ? select[0] : undefined;
  // Clocks left open resolved first, as org-clock-auto-clock-resolution says; the time a resolved clock stopped, offered.
  const interrupting = !resolvingDueToIdleness && clock !== undefined;
  const leftover = resolving ? undefined : leftoverTime;
  const auto = e8.variable("org-clock-auto-clock-resolution") ?? null;
  if (truthy(auto) && (!interrupting || auto === true) && !clockingIn && !resolving) {
    leftoverTime = undefined;
    clockingIn = true;
    try {
      resolveClocks(false);
    } finally {
      clockingIn = false;
    }
  }
  // C-u C-u C-u: from when the clock was last stopped, as with org-clock-continuously.
  if (raw === 64) {
    e8.letBind({ "org-clock-continuously": true }, () => clockIn(null, outTime));
    return;
  }
  let selected: e8.Marker | undefined;
  if (raw === 4) {
    const task = selectTask("Clock-in on task: ");
    if (task === undefined) throw new Error("Abort");
    selected = task;
  }
  if (raw === 16) markDefaultTask();
  if (selected !== undefined) {
    const buffer = e8.markerBuffer(selected) as string;
    const pos = e8.markerPosition(selected) ?? 0;
    e8.withCurrentBuffer(buffer, () =>
      e8.saveExcursion(() =>
        e8.saveRestriction(() => {
          e8.widen();
          e8.gotoChar(pos);
          clockInHere(pos, startTime, leftover);
        }),
      ),
    );
  } else clockInHere(undefined, startTime, leftover);
}

/**
 * Starts a clock on the entry at point, as org-clock-in once it knows
 * where. A task picked is the same as the running one only when its place,
 * SELECTED, is the running entry's heading, as Org compares it: the
 * running task picked as c is its clock line, so it is clocked again.
 */
function clockInHere(selected?: number, startTime?: DateTime, leftover?: DateTime): void {
  let [all, i] = headingHere();
  let h = all[i];
  notified = false;
  if (clock) {
    // The same place and the same title, as Org compares org-clock-hd-marker and org-clock-current-task.
    const pos = e8.markerPosition(clock.heading);
    const sameTitle = e8.variable("org-clock-current-task") === h.title.replace(/^COMMENT[ \t]+/, "");
    if (e8.markerBuffer(clock.heading) === e8.bufferName() && pos === (selected ?? h.start) && sameTitle) {
      e8.message(`Clock continues in "${clock.title}"`);
      return;
    }
    // The task interrupted, to go back to with i.
    if (interruptedTask !== undefined) e8.deleteMarker(interruptedTask);
    interruptedTask = markerIn(e8.markerBuffer(clock.line) as string, e8.markerPosition(clock.line) ?? 0);
    clockOut();
    // Read again: stopping the clock wrote its end, which may be before this heading.
    [all, i] = headingHere();
    h = all[i];
  } else if (interruptedTask !== undefined) {
    e8.deleteMarker(interruptedTask);
    interruptedTask = undefined;
  }
  historyPush(e8.bufferName(), h.start);
  // The task, before its state is switched, as Org sets it.
  e8.setVariable("org-clock-current-task", h.title.replace(/^COMMENT[ \t]+/, ""));
  // A state to switch the task to, or a function of its state giving one, as org-clock-in-switch-to-state.
  const newState = switchState(e8.variable("org-clock-in-switch-to-state") ?? null, h);
  /** Switches the task's state, its clock not stopped by it, as org-todo does there. */
  const applySwitch = () => {
    if (newState === undefined) return;
    const line = h.line;
    e8.saveExcursion(() =>
      e8.letBind({ "org-clock-out-when-done": null }, () => {
        e8.gotoChar(e8.lineStart(line));
        e8.call("org-todo-set", newState);
      }),
    );
    all = headings();
    i = headingIndex(all, line) as number;
    h = all[i];
  };
  const title = clockModeLineHeading(h);
  const { minutes: before, extra } = clockedBefore(all, i);
  // With org-clock-in-resume, the entry's CLOCK line not closed goes on, from when it started, as org-clock-in resumes it.
  const resume = e8.variable("org-clock-in-resume");
  const open = truthy(resume ?? null) ? unclosedClockLine(h) : undefined;
  if (open === undefined && (resume === "auto-restart" || (typeof resume === "symbol" && e8.symbolName(resume) === "auto-restart"))) {
    // As Org: the task is named, its state switched and its clock's place
    // found, a drawer made if one is due, before giving up.
    applySwitch();
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        findPosition(headings(), headingIndex(headings(), h.line) as number);
      }),
    );
    e8.message("Cannot restart clock because task does not contain unfinished clock");
    e8.ding();
    return;
  }
  // From the last clock-out with org-clock-continuously, else when given, else now, as org-clock-in starts it.
  const continuing = truthy(e8.variable("org-clock-continuously") ?? null) ? outTime : undefined;
  // From when a resolved clock stopped, if the user says so, as org-clock-in offers org-clock-leftover-time.
  const fromLeftover = open === undefined && continuing === undefined && leftover !== undefined &&
    e8.yOrNP(`You stopped another clock ${Math.floor((millis(clockTime(true)) - millis(leftover)) / 60000)} mins ago; start this one from then? `)
    ? leftover
    : undefined;
  const start = open?.start ?? continuing ?? fromLeftover ?? startTime ?? clockTime(true);
  const stamp = open?.stamp ?? `[${formatTimestamp(start, true)}]`;
  e8.saveExcursion(() => {
    e8.saveRestriction(() => {
      e8.widen();
      let at: number;
      if (open !== undefined) {
        e8.message(`Matched ${open.stamp.slice(1, -1)}`);
        at = e8.lineStart(open.line);
      } else {
        at = findPosition(headings(), headingIndex(headings(), h.line) as number);
        e8.gotoChar(at);
        // The markers there after the new line, as Org's newline goes in before them.
        e8.insertBeforeMarkers(`CLOCK: ${stamp}\n`);
      }
      clock = { line: e8.makeMarker(at), heading: e8.makeMarker(h.start), title, start: millis(start), before };
    });
  });
  // Switched after the CLOCK line goes in, so that a note it logs goes
  // where Org's, added after the command, does.
  applySwitch();
  hasBeenUsed = true;
  e8.setVariable("org-clock-current-task", h.title.replace(/^COMMENT[ \t]+/, ""));
  e8.setVariable("org-clock-effort", entryGet(h.line, String(e8.variable("org-effort-property") ?? "Effort")) ?? null);
  if (last) e8.deleteMarker(last);
  last = e8.makeMarker(h.start);
  updateModeLine();
  timer = e8.runWithTimer(60, 60, updateModeLine);
  // Whether the user is idle checked each minute, as org-clock-in sets org-clock-idle-timer.
  if (idleTimer !== undefined) e8.cancelTimer(idleTimer);
  idleTimer = e8.runWithTimer(60, 60, resolveIfIdle);
  e8.message(`Clock starts at ${stamp} - ${extra}`);
  e8.runHooks("org-clock-in-hook");
}

/**
 * The state a clock-in or clock-out switches the task at H to, as
 * org-clock-in-switch-to-state and org-clock-out-switch-to-state say: what
 * a function of its state gives, or the state named unless the task is in
 * it already (case aside, as looking-at matches); "" takes its state away.
 */
function switchState(setting: e8.Value, h: Heading): string | undefined {
  const name = typeof setting === "symbol" ? e8.symbolName(setting) : undefined;
  if (typeof setting === "function" || (name !== undefined && e8.fboundp(name))) {
    const v = e8.funcall(typeof setting === "function" ? setting : (name as string), h.todo ?? null);
    return typeof v === "string" ? v : undefined;
  }
  if (typeof setting !== "string") return undefined;
  // As looking-at the heading for the state, a word or not, case aside.
  const quoted = setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\*+ [ \\t]*${quoted}(?:[ \\t]|$)`, "i").test(e8.lineText(h.line))) return undefined;
  return setting;
}

/**
 * The entry's first CLOCK line not closed, as org-clock-find-position finds
 * it with FIND-UNCLOSED: its line, its timestamp and when it started.
 */
function unclosedClockLine(h: Heading): { line: number; stamp: string; start: DateTime } | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const all = headings();
    const i = headingIndex(all, h.line) as number;
    const end = all[i + 1]?.line ?? e8.lineCount();
    for (let l = h.line + 1; l < end; l++) {
      const m = /^[ \t]*CLOCK: \[((\d{4})-(\d{2})-(\d{2}) *[\p{L}\p{N}]+ +([012]\d):([0-5]\d))\][ \t]*$/u.exec(e8.lineText(l));
      // Only a clock Org's parser sees as one: not one in a block.
      if (m && elementAt(e8.lineStart(l))?.type === "clock") return { line: l, stamp: `[${m[1]}]`, start: { year: +m[2], month: +m[3], day: +m[4], hour: +m[5], minute: +m[6] } };
    }
    return undefined;
  });
}

/** Stops the running clock, writing its end and duration, as org-clock-out. */
export function clockOut(failQuietly = false, askState = false, atTime?: DateTime): void {
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
  // With C-u, a state to switch to, asked from the task's file's states, DONE to start with.
  const outSwitch = askState
    ? e8.withCurrentBuffer(buffer, () => e8.completingRead("Switch to state: ", allKeywords(), { requireMatch: true, initial: "DONE" }))
    : (e8.variable("org-clock-out-switch-to-state") ?? null);
  // At AT-TIME, as a resolved clock is stopped then.
  const end = atTime ?? clockTime(false);
  outTime = end;
  // No idle checks without a clock, as org-clock-out cancels org-clock-idle-timer.
  if (idleTimer !== undefined && atTime === undefined) {
    e8.cancelTimer(idleTimer);
    idleTimer = undefined;
  }
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
        // Negative if it ends before it starts, as Org's floor and mod write it.
        minutes = Math.floor((millis(end) - running.start) / 60000);
        e8.deleteRegion(from, e8.lineEnd(line));
        e8.gotoChar(from);
        const mm = minutes - 60 * Math.floor(minutes / 60);
        e8.insert(`--${te} => ${String(Math.floor(minutes / 60)).padStart(2)}:${String(mm).padStart(2, "0")}`);
        if (minutes === 0 && e8.variable("org-clock-out-remove-zero-time-clocks") === true) {
          removed = true;
          e8.deleteRegion(e8.lineStart(line), lineStartOrEnd(line + 1));
          removeEmptyDrawer(line);
        } else if (truthy(e8.variable("org-log-note-clock-out"))) {
          // A note after the clock, as org-clock-out sets one up, the task named above it.
          // The heading the clock's line is under, as org-clock-out asks org-get-heading there.
          const all = headings();
          const headingLine = all[headingIndex(all, lineAt(e8.markerPosition(running.line) ?? 0)) ?? 0]?.line ?? 0;
          const task = e8.lineText(headingLine).replace(/^\*+[ \t]+/, "").replace(/[ \t]+:[\p{L}\p{M}\p{Nd}\p{Nl}_@#%:]+:[ \t]*$/u, "");
          addLogNote(headingLine, "clock-out", undefined, undefined, { extra: `# Task: ${task}\n\n`, at: e8.lineEnd(line) });
        }
      });
    });
  });
  const headingAt = e8.markerPosition(running.heading);
  e8.deleteMarker(running.line);
  e8.deleteMarker(running.heading);
  clock = undefined;
  e8.setVariable("org-clock-current-task", null);
  clearModeLine();
  // The task's state switched, as org-clock-out-switch-to-state or C-u says, its clock already stopped.
  if (truthy(outSwitch) && headingAt !== undefined) {
    e8.withCurrentBuffer(buffer, () =>
      e8.saveExcursion(() =>
        e8.saveRestriction(() => {
          e8.widen();
          const all = headings();
          const k = headingIndex(all, lineAt(headingAt));
          if (k === undefined) return;
          const state = switchState(outSwitch, all[k]);
          if (state === undefined) return;
          e8.gotoChar(all[k].start);
          e8.letBind({ "org-clock-out-when-done": null }, () => e8.call("org-todo-set", state));
        }),
      ),
    );
  }
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
  doc:
    "Start a clock on the entry point is in: a CLOCK: line in its LOGBOOK drawer, the time shown in the mode line. A clock running elsewhere stops first. " +
    "With C-u, on a task picked from those clocked lately; with C-u C-u, on this entry, marking it the default task.",
  params: [{ name: "select", kind: "prefix" }],
  run: (select: e8.PrefixArg) => clockIn(select),
});

e8.defineHook("org-clock-before-select-task-hook", "Functions called in *Clock Task Select* before a task is read.");
e8.defun("org-clock-update-mode-line", () => updateModeLine());

// The running clock's CLOCK line from FROM to TO given a new start: the clock counts from it, as org-clock-update-time-maybe sets org-clock-start-time.
e8.defun("org-clock--restart-at", (from: number, to: number, seconds: number) => {
  if (clock === undefined || e8.markerBuffer(clock.line) !== e8.bufferName()) return false;
  const pos = e8.markerPosition(clock.line);
  if (pos === undefined || !(pos > from && pos <= to)) return false;
  clock.start = seconds * 1000;
  updateModeLine();
  return true;
});

e8.defineCommand({
  name: "org-clock-mark-default-task",
  doc: "Mark the entry point is in as the default task, which C-u C-c C-x C-i always offers as d.",
  run: () => markDefaultTask(),
});

e8.defineCommand({
  name: "org-clock-modify-effort-estimate",
  doc: "Set the clocked entry's effort, hh:mm or minutes, or with a leading + or - change it by that much; the mode line shows it after the time clocked.",
  run: () => {
    if (!clock) {
      e8.message("Clock is not currently active");
      return;
    }
    const current = e8.variable("org-clock-effort");
    const value = e8.readString(`Set effort (hh:mm or mm${typeof current === "string" ? `, prefix + to add to ${current}` : ""}): `);
    const sign = value[0];
    let minutes: number;
    if (sign === "+" || sign === "-") {
      // Org reads the missing effort as a duration, which signals.
      if (typeof current !== "string") e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil", [e8.intern("stringp"), null]);
      const base = durationToMinutes(current as string);
      const by = durationToMinutes(value.slice(1));
      minutes = sign === "+" ? base + by : base - by;
    } else minutes = durationToMinutes(value);
    const effort = durationFromMinutes(Math.max(0, minutes));
    e8.setVariable("org-clock-effort", effort);
    const running = clock;
    e8.withCurrentBuffer(e8.markerBuffer(running.heading) as string, () =>
      e8.saveExcursion(() => entryPut(lineAt(e8.markerPosition(running.heading) ?? 0), "Effort", effort)),
    );
    updateModeLine();
    e8.message(`Effort is now ${effort}`);
  },
});

e8.defineCommand({
  name: "org-clock-out",
  doc: "Stop the running clock, writing when it stopped and how long it ran. With C-u, switch the task to a state asked for.",
  params: [{ name: "switch-to-state", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => clockOut(false, arg !== null && arg !== undefined),
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
          // Case aside, as org-clock-cancel's looking-back has case-fold-search.
          if (inside && /^[ \t]*CLOCK: /i.test(e8.lineText(line))) {
            e8.deleteRegion(e8.lineStart(line) - 1, e8.lineEnd(line));
            removeEmptyDrawer(line);
          } else e8.message("Clock gone, cancel the timer anyway");
        });
      });
    }
    e8.deleteMarker(running.line);
    e8.deleteMarker(running.heading);
    clock = undefined;
    e8.setVariable("org-clock-current-task", null);
    clearModeLine();
    e8.message("Clock canceled");
    e8.runHooks("org-clock-cancel-hook");
  },
});

e8.defineCommand({
  name: "org-clock-goto",
  doc: "Go to the entry with the running clock, or the last one clocked. With C-u, to a task picked from those clocked lately.",
  params: [{ name: "select", kind: "prefix" }],
  run: (select: e8.PrefixArg) => {
    // A task picked, the clock's line, or the task clocked last, as org-clock-goto takes the one picked, org-clock-marker or the history's first.
    let target: e8.Marker | undefined;
    let recent = false;
    if (select !== null && select !== undefined) {
      target = selectTask("Select task to go to: ");
      if (target === undefined) e8.userError("No task selected");
    } else if (clock) target = clock.line;
    else if (truthy(e8.variable("org-clock-goto-may-find-recent-task"))) {
      target = history[0];
      recent = true;
    }
    const buffer = target === undefined ? undefined : e8.markerBuffer(target);
    if (target === undefined || buffer === undefined) e8.userError("No active or recent clock task");
    e8.call("switch-to-buffer", buffer);
    const pos = e8.markerPosition(target) ?? 0;
    if (pos < e8.pointMin() || pos > e8.pointMax()) e8.widen();
    e8.gotoChar(pos);
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (i !== undefined) {
      showEntry(all, i);
      e8.gotoChar(all[i].start);
    }
    showSetVisibility("lineage");
    if (recent) e8.message("No running clock, this is the most recently clocked task");
    e8.runHooks("org-clock-goto-hook");
  },
});

e8.defineCommand({
  name: "org-clock-in-last",
  doc:
    "Start a clock again on the entry clocked last. With C-u, on a task picked from those clocked lately; with C-u C-u, from when " +
    "the clock was last stopped; with C-u C-u C-u, asking for a TODO state to switch it to.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (Array.isArray(arg) && arg[0] === 4) return clockIn(arg);
    const n = Array.isArray(arg) ? arg[0] : undefined;
    // From the last clock-out with C-u C-u or org-clock-continuously, as org-clock-in-last.
    const start = truthy(e8.variable("org-clock-continuously") ?? null) || n === 16 ? (outTime ?? clockTime(true)) : clockTime(true);
    const head = history[0];
    const buffer = head === undefined ? undefined : e8.markerBuffer(head);
    if (head === undefined || buffer === undefined) {
      e8.message("No last clock");
      return;
    }
    const already = e8.variable("org-clock-current-task");
    // C-u C-u C-u, not clocking: a TODO state to switch to, from the task's file's keywords.
    let state = e8.variable("org-clock-in-switch-to-state") ?? null;
    if (!truthy(already ?? null) && n === 64) state = e8.completingRead("Switch to state: ", e8.withCurrentBuffer(buffer, () => allKeywords()));
    e8.letBind({ "org-clock-in-switch-to-state": state }, () =>
      e8.withCurrentBuffer(buffer, () => {
        e8.saveExcursion(() => {
          e8.gotoChar(e8.markerPosition(head) ?? 0);
          clockIn(null, start);
        });
      }),
    );
    if (!truthy(already ?? null)) e8.message(`Clocking back: ${String(e8.variable("org-clock-current-task"))} (in ${clock ? (e8.markerBuffer(clock.line) ?? buffer) : buffer})`);
  },
});

// Marking the clocked entry done stops its clock, as org-clock-out-if-current does.
// The clock's line must be in this entry, after point and before the next heading, as Org looks for org-clock-marker.
e8.addHook("org-after-todo-state-change-hook", () => {
  const when = e8.variable("org-clock-out-when-done");
  if (!clock || !truthy(when ?? null)) return;
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) return;
  const state = all[i].todo;
  if (!(when === true ? isDone(state) : Array.isArray(when) && state !== undefined && when.includes(state))) return;
  const base = (b: string | undefined) => (b === undefined ? undefined : (e8.bufferBaseBuffer(b)?.name ?? b));
  if (base(e8.markerBuffer(clock.line) as string | undefined) !== base(e8.bufferName())) return;
  const pos = e8.markerPosition(clock.line) ?? -1;
  const entryEnd = e8.saveRestriction(() => (e8.widen(), headings().find((x) => x.start > all[i].start)?.start ?? e8.pointMax()));
  if (!(e8.point() < pos && entryEnd > pos)) return;
  // With no note for the clock, as org-clock-out-if-current binds org-log-note-clock-out.
  e8.letBind({ "org-log-note-clock-out": false }, () => clockOut(true));
});

// Keeping the clock and its history from one session to the next, as
// org-clock-save and org-clock-load do, in the file Emacs writes, so
// either reads the other's.

defvar(
  "org-clock-persist",
  null,
  'Whether the running clock is saved when E8 exits and resumed when it starts again: t for the clock and the history of clocked tasks, "clock" for the clock, "history" for the history. org-clock-persistence-insinuate sets up the saving and loading.',
);
defvar("org-clock-persist-file", null, "The file the clock and its history are saved to; unset, org-clock-save.el in user-emacs-directory.");
defvar("org-clock-persist-query-save", false, "Whether to ask before saving the running clock on exit.");
defvar("org-clock-persist-query-resume", true, "Whether to ask before resuming a saved clock.");
defvar("org-clock-in-resume", false, "Whether clocking into an entry with a CLOCK line not closed goes on with it, from when it started.");

/**
 * org-clock-persist-file, or org-clock-save.el in user-emacs-directory,
 * found when it is used, as packages load before init.ts sets the directory.
 */
function persistFile(): string {
  const file = e8.variable("org-clock-persist-file");
  if (typeof file === "string" && file !== "") return e8.expandFileName(file);
  const dir = e8.variable("user-emacs-directory");
  return e8.expandFileName("org-clock-save.el", typeof dir === "string" && dir !== "" ? dir : "~/.emacs.d/");
}

/** org-clock-persist's value, a symbol read as its name. */
function persistValue(name: string): e8.Value {
  const v = e8.variable(name) ?? null;
  return typeof v === "symbol" ? e8.symbolName(v) : v;
}

/** Whether a clock has run this session, as org-clock-has-been-used, and whether the saved data has been read, as org-clock-loaded. */
let hasBeenUsed = false;
let loaded = false;

/** A file name as Lisp writes it in a string, as format's %S does. */
const lispString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A file and a position from Lisp's ("FILE" . POS), the position 1-based as Emacs's, given 0-based. */
const lispPlace = (text: string): [string, number] | undefined => {
  const m = /^\("((?:[^"\\]|\\.)*)" \. (\d+)\)$/.exec(text.trim());
  return m ? [m[1].replace(/\\(.)/g, "$1"), Math.max(0, Number(m[2]) - 1)] : undefined;
};

/** The base buffer's file of the buffer a marker is in, if it visits one, as org-base-buffer and buffer-file-name. */
function markerFile(m: e8.Marker | undefined): string | undefined {
  const buffer = m === undefined ? undefined : e8.markerBuffer(m);
  if (buffer === undefined) return undefined;
  const base = e8.bufferBaseBuffer(buffer)?.name ?? buffer;
  return e8.withCurrentBuffer(base, () => e8.bufferFileName());
}

/** The buffer visiting a file, found by its true name too, as find-file-noselect finds it, or visiting it. */
const visit = (file: string): string => findBufferVisiting(file) ?? e8.findFileNoselect(file);

/** Where Org's org-clock-marker would be: after the timestamp on the clock's CLOCK line. */
function clockMarkerPosition(line: e8.Marker): number {
  const at = e8.markerPosition(line) ?? 0;
  return e8.withCurrentBuffer(e8.markerBuffer(line) as string, () => {
    const text = e8.lineText(lineAt(at));
    const close = text.indexOf("]");
    return close < 0 ? at : e8.lineStart(lineAt(at)) + charCount(text.slice(0, close + 1));
  });
}

/** Saves the clock and its history to org-clock-persist-file, as org-clock-save does: what org-clock-persist says. */
function clockSave(): void {
  const persist = persistValue("org-clock-persist");
  const file = persistFile();
  if (!truthy(persist) || !(loaded || hasBeenUsed || !e8.fileExists(file))) return;
  const lines = [`;; ${e8.fileNameNondirectory(file)} - ${e8.systemName()} at ${formatTimestamp(now(), true).replace(/^/, "<")}>`];
  const clockFile = clock ? markerFile(clock.line) : undefined;
  if ((persist === true || persist === "clock") && clock && clockFile !== undefined) {
    const save = !truthy(e8.variable("org-clock-persist-query-save")) || e8.yOrNP(`Save current clock (${clock.title})?`);
    if (save) lines.push(`(setq org-clock-stored-resume-clock '(${lispString(clockFile)} . ${clockMarkerPosition(clock.line) + 1}))`);
  }
  // Stored oldest first, to make reading simpler, as Org writes them.
  if ((persist === true || persist === "history") && history.length > 0) {
    const places = [...history].reverse().flatMap((m) => {
      const f = markerFile(m);
      return f === undefined ? [] : [`(${lispString(f)} . ${(e8.markerPosition(m) ?? 0) + 1})`];
    });
    lines.push(`(setq org-clock-stored-history '(${places.join(" ")}))`);
  }
  e8.writeRegion(`${lines.join("\n")}\n`, null, file, { quiet: true });
}

/**
 * Reads what org-clock-save wrote, as org-clock-load does: the history,
 * each task in a file that still exists, and the running clock, resumed
 * in its entry after asking, with org-clock-persist-query-resume.
 */
function clockLoad(): void {
  if (!truthy(persistValue("org-clock-persist")) || loaded) return;
  const file = persistFile();
  if (!e8.fileReadableP(file)) {
    e8.message(`Not restoring clock data; ${lispString(String(e8.variable("org-clock-persist-file") ?? file))} not found`);
    return;
  }
  e8.message("Restoring clock data");
  const text = e8.withCurrentBuffer(e8.getBufferCreate(" *org clock save*"), () => {
    eraseBuffer();
    e8.insertFileContents(file);
    const contents = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
    e8.call("kill-buffer", " *org clock save*");
    return contents;
  });
  loaded = true;
  // Org leaves a space where an entry's buffer had gone, so any spaces between.
  const stored = /\(setq org-clock-stored-history '\(((?:\s*\("(?:[^"\\]|\\.)*" \. \d+\))*)\s*\)\)/.exec(text);
  for (const entry of stored ? (stored[1].match(/\("(?:[^"\\]|\\.)*" \. \d+\)/g) ?? []) : []) {
    const place = lispPlace(entry);
    if (place === undefined || !e8.fileExists(place[0])) continue;
    const buffer = visit(place[0]);
    e8.withCurrentBuffer(buffer, () => {
      const all = headings();
      const i = headingIndex(all, lineAt(Math.min(place[1], e8.bufferSize())));
      if (i !== undefined) historyPush(buffer, all[i].start);
    });
  }
  const resume = /\(setq org-clock-stored-resume-clock '(\("(?:[^"\\]|\\.)*" \. \d+\))\)/.exec(text);
  const place = resume ? lispPlace(resume[1]) : undefined;
  if (place === undefined || !e8.fileExists(place[0])) return;
  e8.withCurrentBuffer(visit(place[0]), () => {
    e8.saveExcursion(() => {
      e8.gotoChar(Math.min(place[1], e8.bufferSize()));
      const all = headings();
      const i = headingIndex(all, lineAt());
      if (i === undefined) return;
      // As org-get-heading t t: with the priority, without the state and tags.
      const heading = all[i].priority === undefined ? all[i].title : `[#${all[i].priority}] ${all[i].title}`;
      if (truthy(e8.variable("org-clock-persist-query-resume")) && !e8.yOrNP(`Resume clock (${heading})?`)) return;
      e8.letBind({ "org-clock-in-resume": "auto-restart" }, () => clockInHere());
    });
  });
}

e8.defun("org-clock-save", () => clockSave());
e8.defun("org-clock-load", () => clockLoad());
// As Org's: the saved clock read as Org mode first starts, and saved as E8 exits.
e8.defun("org-clock-persistence-insinuate", () => {
  e8.addHook("org-mode-hook", clockLoad);
  e8.addHook("kill-emacs-hook", clockSave);
});

defvar(
  "org-clock-ask-before-exiting",
  true,
  "Whether exiting with a clock running asks to stop it and save its file. In Org it takes effect only through customize, which adds org-clock-kill-emacs-query to kill-emacs-query-functions or removes it; here it is read when E8 exits.",
);
// Before exiting, a running clock is offered to be stopped and its file saved, as org-clock-kill-emacs-query.
function killEmacsQuery(): boolean {
  const buffer = clock && e8.markerBuffer(clock.line);
  if (buffer !== undefined && truthy(e8.variable("org-clock-ask-before-exiting") ?? null) && e8.yesOrNoP("Clock out and save? ")) {
    clockOut();
    e8.withCurrentBuffer(buffer, () => e8.call("save-buffer"));
  }
  return true;
}
e8.defun("org-clock-kill-emacs-query", killEmacsQuery);
e8.addHook("kill-emacs-query-functions", killEmacsQuery);

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
    const t = parseDate(readDateAnswer(`${prompt} `), true);
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

/**
 * Names the running clock's task again from its heading, and shows it in
 * the mode line, as org-clock-update-mode-line with REFRESH: as a kept
 * capture's clock does once its heading is written.
 */
export function refreshClockHeading(): void {
  if (!clock) return;
  const buffer = e8.markerBuffer(clock.heading);
  const pos = e8.markerPosition(clock.heading);
  if (buffer === undefined || pos === undefined) return;
  const title = e8.withCurrentBuffer(buffer, () =>
    e8.saveRestriction(() => {
      e8.widen();
      const all = headings();
      const i = headingIndex(all, lineAt(pos));
      return i === undefined ? "???" : clockModeLineHeading(all[i]);
    }),
  );
  clock.title = title;
  e8.setVariable("org-clock-heading", title);
  updateModeLine();
}

// For C-2 C-c C-w: the running clock's entry, named by org-clock-heading.
setRunningClock(() => {
  const entry = runningEntry();
  if (!entry || !clock) return undefined;
  return { ...entry, title: clock.title };
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
      const search = linkHeadingSearchString(headline);
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
  if (recalc) e8.callWithPrefix([4], "org-table-recalculate");
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

// Resolving open clocks, as org-clock.el's org-resolve-clocks: clocks left
// running in a file, found when clocking in or asked for with C-c C-x C-z,
// and the time a running clock was idle, after org-clock-idle-time.

defvar("org-clock-idle-time", null, "Minutes idle after which a running clock asks what to do with the idle time, or nil for never.");
defvar(
  "org-clock-auto-clock-resolution",
  "when-no-clock-is-running",
  "When clocking in resolves clocks left open in Org files: t always, when-no-clock-is-running when none is running, nil never.",
);
defvar("org-clock-resolve-expert", false, "Whether resolving a clock asks without showing the *Org Clock* help first.");

/** While clocks are being resolved, as org-clock-resolving-clocks; and because the clock was idle, as -due-to-idleness. */
let resolving = false;
let resolvingDueToIdleness = false;
/** While clocking in resolves clocks, as org-clock-clocking-in. */
let clockingIn = false;
/** When a clock closed by resolving stopped, for the next clock-in to offer starting from, as org-clock-leftover-time. */
let leftoverTime: DateTime | undefined;
/** The timer checking whether the user is idle, as org-clock-idle-timer. */
let idleTimer: number | undefined;

/** A clock open in a file: where its timestamp ends, and when it started, as org-find-open-clocks gives it. */
type OpenClock = { marker: e8.Marker; start: DateTime };

/** An Org time from milliseconds, in E8's zone, as decode-time. */
function fromMillis(ms: number): DateTime {
  const [, minute, hour, day, month, year] = e8.decodeTime(ms / 1000) as number[];
  return { year, month, day, hour, minute };
}

/** The agenda files and every Org buffer's file, as org-files-list. */
function filesList(): string[] {
  const files = agendaFiles().map((f) => e8.expandFileName(f));
  for (const b of e8.bufferList()) {
    const file = e8.withCurrentBuffer(b, () => (e8.derivedModeP("org-mode") ? e8.bufferFileName() : undefined));
    if (file !== undefined && !files.includes(e8.expandFileName(file))) files.unshift(e8.expandFileName(file));
  }
  return files;
}

/** The clocks open in FILE, last first, as org-find-open-clocks pushes them. */
function findOpenClocks(file: string): OpenClock[] {
  const buffer = e8.getFileBuffer(file) ?? e8.findFileNoselect(file);
  const out: OpenClock[] = [];
  // In the accessible part, as Org searches from point-min without widening; case aside, as case-fold-search has it.
  e8.withCurrentBuffer(buffer, () => {
    for (let l = e8.lineOf(e8.pointMin()); l <= e8.lineOf(e8.pointMax()) && l < e8.lineCount(); l++) {
      const m = /CLOCK: (\[.*?\])$/i.exec(e8.lineText(l));
      // A clock, or a lower-case one, which Org's parser takes for a clock too.
      const type = elementAt(e8.lineStart(l))?.type;
      if (!m || !(type === "clock" || ((type === "paragraph" || type === "drawer") && /^[ \t]*clock: /i.test(e8.lineText(l))))) continue;
      // Its date at midnight without a time, as org-time-string-to-time reads it.
      const t = /\[(\d{4})-(\d{2})-(\d{2})(?:[^\]]*? (\d{1,2}):(\d{2}))?/.exec(m[1]);
      const start = t ? { year: +t[1], month: +t[2], day: +t[3], hour: t[4] === undefined ? 0 : +t[4], minute: t[5] === undefined ? 0 : +t[5] } : { ...today(), hour: 0, minute: 0 };
      out.unshift({ marker: e8.makeMarker(e8.lineEnd(l), { buffer, advances: true }), start });
    }
  });
  return out;
}

/** Whether C is the running clock, as org-is-active-clock. */
function isActiveClock(c: OpenClock): boolean {
  if (!clock) return false;
  return e8.markerBuffer(clock.line) === e8.markerBuffer(c.marker) &&
    e8.withCurrentBuffer(e8.markerBuffer(c.marker) as string, () => lineAt(e8.markerPosition(clock!.line) ?? 0) === lineAt(e8.markerPosition(c.marker) ?? 0));
}

/** Runs F at the start of C's line, its buffer widened, as org-with-clock-position. */
function atClockPosition<T>(c: OpenClock, f: () => T): T {
  return e8.withCurrentBuffer(e8.markerBuffer(c.marker) as string, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        e8.gotoChar(e8.lineStart(lineAt(e8.markerPosition(c.marker) ?? 0)));
        return f();
      }),
    ),
  );
}

/** Runs F with C as the running clock, the running one put back after, as org-with-clock. */
function withClock<T>(c: OpenClock, f: () => T): T {
  const saved = clock;
  const savedTask = e8.variable("org-clock-current-task") ?? null;
  return atClockPosition(c, () => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    const h = i === undefined ? undefined : all[i];
    clock = {
      line: e8.makeMarker(e8.point()),
      heading: e8.makeMarker(h?.start ?? e8.point()),
      title: h?.title ?? "",
      start: millis(c.start),
      before: 0,
    };
    try {
      return f();
    } finally {
      if (clock && clock !== saved) {
        e8.deleteMarker(clock.line);
        e8.deleteMarker(clock.heading);
      }
      clock = saved;
      e8.setVariable("org-clock-current-task", savedTask);
      if (saved) {
        updateModeLine();
        timer ??= e8.runWithTimer(60, 60, updateModeLine);
      }
    }
  });
}

/** Stops clock C, at AT-TIME if given, as org-clock-clock-out. */
function clockClockOut(c: OpenClock, failQuietly: boolean, atTime?: DateTime): void {
  if (isActiveClock(c)) clockOut(failQuietly, false, atTime);
  else withClock(c, () => clockOut(failQuietly, false, atTime));
}

/** Cancels clock C, as org-clock-clock-cancel. */
function clockClockCancel(c: OpenClock): void {
  if (isActiveClock(c)) e8.call("org-clock-cancel");
  else withClock(c, () => e8.call("org-clock-cancel"));
}

/** Clocks in again at C, resuming it, as org-clock-clock-in. */
function clockClockIn(c: OpenClock, resume: boolean, startTime?: DateTime): void {
  atClockPosition(c, () =>
    e8.letBind({ "org-clock-in-resume": resume || truthy(e8.variable("org-clock-in-resume") ?? null) }, () => clockIn(null, startTime)),
  );
}

/**
 * Resolves clock C to RESOLVE-TO, as org-clock-resolve-clock: nil cancels
 * it, "now" keeps it running, a time stops it then, and unless CLOSE, the
 * task is clocked in again, from CLOCK-OUT-TIME's RESOLVE-TO if given.
 */
function resolveClock(c: OpenClock, resolveTo: null | "now" | DateTime, clockOutTime: DateTime | undefined, close: boolean, restart: boolean, failQuietly: boolean): void {
  const outer = resolving;
  resolving = true;
  try {
    const heading = atClockPosition(c, () => {
      const all = headings();
      const i = headingIndex(all, lineAt());
      if (i === undefined) e8.userError(`Before first headline at position ${e8.lineStart(lineAt()) + 1} in buffer ${e8.bufferName()}`);
      return e8.makeMarker(all[i].start);
    });
    const atHeading = (f: () => void) =>
      e8.withCurrentBuffer(e8.markerBuffer(heading) as string, () =>
        e8.saveExcursion(() => {
          e8.gotoChar(e8.markerPosition(heading) ?? 0);
          f();
        }),
      );
    try {
      if (resolveTo === null) {
        clockClockCancel(c);
        if (restart && !clockingIn) atHeading(() => clockIn(null));
      } else if (resolveTo === "now") {
        if (restart) e8.signal("error", "RESTART is not valid here");
        if (close || clockingIn) clockClockOut(c, failQuietly);
        else if (!isActiveClock(c)) clockClockIn(c, true);
      } else {
        if (millis(resolveTo) > millis(now())) e8.signal("error", "RESOLVE-TO must refer to a time in the past");
        if (restart) e8.signal("error", "RESTART is not valid here");
        clockClockOut(c, failQuietly, clockOutTime ?? resolveTo);
        if (clockingIn) {
          // Clocking in goes on as it was.
        } else if (close) leftoverTime = clockOutTime === undefined ? resolveTo : undefined;
        else atHeading(() => clockIn(null, clockOutTime !== undefined ? resolveTo : undefined));
      }
    } finally {
      e8.deleteMarker(heading);
    }
  } finally {
    resolving = outer;
  }
}

/** Shows clock C's entry, its drawer open, as org-clock-jump-to-current-clock. */
function jumpToClock(c: OpenClock): void {
  const buffer = e8.markerBuffer(c.marker);
  if (buffer === undefined) e8.userError("No Org clock is currently running");
  const outer = e8.bufferName();
  e8.call("switch-to-buffer", buffer);
  const pos = e8.markerPosition(c.marker) ?? 0;
  if (pos < e8.pointMin() || pos > e8.pointMax()) e8.widen();
  e8.gotoChar(pos);
  // Its entry shown, as org-clock-goto shows the context, and its hook run.
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i !== undefined) {
    showEntry(all, i);
    // The drawer holding the clock opened, as org-clock-jump-to-current-clock toggles it off.
    const name = drawerName(all[i]);
    if (name !== undefined) {
      const re = new RegExp(`^[ \t]*:${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \t]*$`);
      for (let l = lineAt(pos); l > all[i].line; l--) {
        if (!re.test(e8.lineText(l))) continue;
        if (elementAt(e8.lineStart(l))?.type === "drawer") toggleDrawerOrBlock(l, false);
        break;
      }
    }
  }
  e8.runHooks("org-clock-goto-hook");
  // Back in the buffer it was asked from, as org-with-clock's with-current-buffer leaves it.
  if (outer !== e8.bufferName() && e8.getBuffer(outer)) e8.setBuffer(outer);
}

const RESOLVE_HELP = `Select a Clock Resolution Command:

i/q      Ignore this question; the same as keeping all the idle time.

k/K      Keep X minutes of the idle time (default is all).  If this
         amount is less than the default, you will be clocked out
         that many minutes after the time that idling began, and then
         clocked back in at the present time.

t/T      Like ‘k’, but will ask you to specify a time (when you got
         distracted away), instead of a number of minutes.

g/G      Indicate that you "got back" X minutes ago.  This is quite
         different from ‘k’: it clocks you out from the beginning of
         the idle period and clock you back in X minutes ago.

s/S      Subtract the idle time from the current clock.  This is the
         same as keeping 0 minutes.

C        Cancel the open timer altogether.  It will be as though you
         never clocked in.

j/J      Jump to the current clock, to make manual adjustments.

For all these options, using uppercase makes your final state
to be CLOCKED OUT.`;

/** A number read with DEFAULT for an empty answer, as read-number. */
function readNumber(prompt: string, def: number): number {
  for (;;) {
    const answer = e8.readString(prompt.replace(/: $/, ` (default ${def}): `));
    if (answer.trim() === "") return def;
    const n = Number(answer.trim());
    if (Number.isFinite(n)) return n;
    e8.message("Please enter a number.");
    e8.sitFor(1);
  }
}

/**
 * Asks what to do with clock C, open since LAST-VALID, and does it, as
 * org-clock-resolve: keep the time (k, t), say when you got back (g),
 * subtract it (s), cancel the clock (C), go to it (j) or ignore it (i,
 * q); upper case leaves the clock stopped.
 */
function resolve(c: OpenClock, prompt: string, lastValid: DateTime, failQuietly = false): void {
  const ch = e8.saveWindowExcursion(() =>
    e8.saveExcursion(() => {
      if (!resolvingDueToIdleness) jumpToClock(c);
      if (!truthy(e8.variable("org-clock-resolve-expert") ?? null)) {
        const help = "*Org Clock*";
        e8.withCurrentBuffer(e8.getBufferCreate(help), () =>
          e8.letBind({ "inhibit-read-only": true }, () => {
            eraseBuffer();
            e8.insert(RESOLVE_HELP);
            e8.gotoChar(0);
          }),
        );
        e8.call("display-buffer", help);
        const w = e8.windowList().find((x) => e8.windowBuffer(x) === help);
        if (w !== undefined) {
          const selected = e8.selectedWindow();
          e8.selectWindow(w, true);
          e8.call("shrink-window-if-larger-than-buffer");
          e8.selectWindow(selected, true);
        }
      }
      let key: string;
      for (;;) {
        key = e8.readKey(`${prompt} [jkKtTgGSscCiq]? `);
        if ("kKgGsSCjJiqtT".includes(key) && [...key].length === 1) break;
        e8.ding();
      }
      return key === "i" || key === "q" ? undefined : key;
    }),
  );
  const nowMs = millis(now());
  const def = Math.floor((nowMs - millis(lastValid)) / 60000);
  const keep = ch === "k" || ch === "K" ? readNumber("Keep how many minutes: ", def)
    : ch === "t" || ch === "T" ? Math.floor((millis(parseDate(readDateAnswer("Date+time: "), true)) - millis(lastValid)) / 60000)
    : undefined;
  const gotback = ch === "g" || ch === "G" ? readNumber("Got back how many minutes ago: ", def) : undefined;
  const subtract = ch === "s" || ch === "S";
  const barelyStarted = millis(lastValid) - millis(c.start) < 45000;
  const startOver = subtract && barelyStarted;
  if (ch === "j" || ch === "J") {
    if (ch === "J") resolveClock(c, "now", undefined, true, false, failQuietly);
    jumpToClock(c);
    return;
  }
  if (ch === undefined) {
    e8.message("");
    return;
  }
  let to: null | "now" | DateTime;
  if (ch === "C" || startOver) to = null;
  else if (subtract || gotback === 0) to = lastValid;
  else if ((keep !== undefined && keep === def) || (gotback !== undefined && gotback === def)) to = "now";
  else if (keep !== undefined) to = fromMillis(millis(lastValid) + 60000 * keep);
  else if (gotback !== undefined) to = fromMillis(nowMs - 60000 * gotback);
  else return e8.signal("error", "Unexpected, please report this as a bug");
  resolveClock(c, to, gotback !== undefined ? lastValid : undefined, "KGST".includes(ch), startOver && !"KGSC".includes(ch), failQuietly);
}

/** Resolves the open clocks in the agenda files and Org buffers, with ONLY-DANGLING those not running, as org-resolve-clocks. */
function resolveClocks(onlyDangling: boolean): void {
  if (resolving) return;
  resolving = true;
  try {
    for (const file of filesList()) {
      const clocks = findOpenClocks(file);
      try {
        for (const c of clocks) {
          const dangling = !isActiveClock(c);
          if (!onlyDangling || dangling) {
            const mins = Math.floor((millis(now()) - millis(c.start)) / 60000);
            resolve(c, `Dangling clock started ${mins} mins ago`, c.start);
          }
        }
      } finally {
        for (const c of clocks) e8.deleteMarker(c.marker);
      }
    }
  } finally {
    resolving = false;
  }
}

e8.defineCommand({
  name: "org-resolve-clocks",
  doc: "Resolve the clocks left open in the agenda files and Org buffers, asking what to do with each; with a prefix argument, only those not running.",
  params: [{ name: "onlyDangling", kind: "prefix" }],
  run: (onlyDangling) => resolveClocks(onlyDangling !== null && onlyDangling !== undefined),
});

/** Seconds since the user last typed, as org-user-idle-seconds counts E8's idle time. */
function userIdleSeconds(): number {
  return e8.currentIdleTime() ?? 0;
}

/** Asks what to do with the time the running clock was idle, once org-clock-idle-time minutes pass, as org-resolve-clocks-if-idle. */
function resolveIfIdle(): void {
  const minutes = e8.variable("org-clock-idle-time");
  if (typeof minutes !== "number" || resolving || !clock || e8.markerBuffer(clock.line) === undefined) return;
  const idle = userIdleSeconds();
  if (idle <= 60 * minutes) return;
  if (idleTimer !== undefined) e8.cancelTimer(idleTimer);
  idleTimer = undefined;
  const idleStart = fromMillis(millis(now()) - idle * 1000);
  const running = clock;
  const c: OpenClock = { marker: e8.makeMarker(e8.markerPosition(running.line) ?? 0, { buffer: e8.markerBuffer(running.line) as string }), start: fromMillis(running.start) };
  resolvingDueToIdleness = true;
  try {
    resolve(c, `Clocked in & idle for ${((millis(now()) - millis(idleStart)) / 60000).toFixed(1)} mins`, idleStart);
  } finally {
    resolvingDueToIdleness = false;
    e8.deleteMarker(c.marker);
  }
  if (clock && idleTimer === undefined) idleTimer = e8.runWithTimer(60, 60, resolveIfIdle);
}
