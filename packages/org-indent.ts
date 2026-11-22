// Indenting Org text by its outline, without changing it, after Org's
// org-indent.el: org-indent-mode gives each line a line-prefix that indents
// it under its heading, and headings one that lines their titles up, and
// hides all but the last star of each heading. org-startup-indented, or
// #+STARTUP: indent, turns it on when a file opens.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { itemParts, twoSpacesAfter } from "org-list";
import { PerBuffer } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-indent-indentation-per-level", 2, "How many columns each level of headings indents the text under it.");
defvar("org-indent-boundary-char", " ", "The character that ends the indentation of text, a space by default; | shows where it ends.");
defvar("org-indent-mode-turns-on-hiding-stars", true, "Whether org-indent-mode turns org-hide-leading-stars on.");
defvar("org-indent-mode-turns-off-org-adapt-indentation", true, "Whether org-indent-mode turns org-adapt-indentation off.");
e8.defineHook("org-indent-post-buffer-init-functions", "Functions called with the buffer once org-indent-mode has indented all of it.");
e8.defineFace({ name: "org-indent", doc: "The indentation org-indent-mode shows.", attributes: { inherit: "org-hide" } });

const DEEPEST = 50;

/** The line prefixes of text and headings at each level, as org-indent--compute-prefixes. */
function computePrefixes(): { text: e8.PropertizedString[]; heading: e8.PropertizedString[] } {
  const per = Number(e8.variable("org-indent-indentation-per-level") ?? 2);
  const boundary = String(e8.variable("org-indent-boundary-char") ?? " ").slice(0, 1) || " ";
  const text: e8.PropertizedString[] = [];
  const heading: e8.PropertizedString[] = [];
  for (let n = 0; n < DEEPEST; n++) {
    const indentation = per <= 0 ? 0 : n <= 1 ? 0 : (per - 1) * (n - 1);
    heading.push(e8.propertize("*".repeat(indentation), { face: "org-indent" }));
    text.push(e8.propertize(" ".repeat(per <= 0 ? 0 : n + indentation) + (per > 0 && n > 0 ? boundary : ""), { face: "org-indent" }));
  }
  return { text, heading };
}

let prefixes = computePrefixes();

/** The column where an item's text starts, as org-list-item-body-column: one after its bullet. */
function itemBodyColumn(text: string): number {
  const m = /^[ \t]*(\S+)/.exec(text);
  return m ? e8.stringWidth(m[0].replace(/\t/g, " ".repeat(Number(e8.variable("tab-width") ?? 8)))) + (twoSpacesAfter(m[1]) ? 2 : 1) : 0;
}

/** The wrap prefixes made so far, by kind, level and indentation, so each is made once. */
let wraps = new Map<string, e8.PropertizedString>();

/** Gives a line its prefixes, as org-indent-set-line-properties. */
function setLineProperties(line: number, level: number, indentation: number, heading: boolean): void {
  const lvl = Math.min(level, DEEPEST - 1);
  const prefix = (heading ? prefixes.heading : prefixes.text)[lvl];
  const key = `${heading ? "h" : "t"}${lvl}:${indentation}`;
  let wrap = wraps.get(key);
  if (wrap === undefined) {
    wrap = e8.propertize(String(prefix) + (heading ? `${"*".repeat(level)} ` : " ".repeat(indentation)), { face: "org-indent" });
    wraps.set(key, wrap);
  }
  const start = e8.lineStart(line);
  const end = line + 1 < e8.lineCount() ? e8.lineStart(line + 1) : e8.bufferSize();
  // Down to the next line, so that empty lines are indented too.
  if (end > start) {
    e8.putTextProperty(start, end, "line-prefix", prefix);
    e8.putTextProperty(start, end, "wrap-prefix", wrap);
  }
}

/** A line's indentation, as current-indentation measures it. */
function indentationOf(text: string): number {
  const tab = Number(e8.variable("tab-width") ?? 8);
  let col = 0;
  for (const c of text) {
    if (c === " ") col++;
    else if (c === "\t") col = (Math.floor(col / tab) + 1) * tab;
    else break;
  }
  return col;
}

const HEADING = /^(\*+)[ \t]/;

/** The level of the heading a line is under, 0 before the first, as org-current-level. */
function levelAt(line: number): number {
  for (let l = line; l >= 0; l--) {
    const m = HEADING.exec(e8.lineText(l));
    if (m) return m[1].length;
  }
  return 0;
}

/**
 * Gives the lines from beg to end their prefixes, as
 * org-indent-add-properties. With a deadline, a time in milliseconds, it
 * stops when the deadline passes and returns where it stopped.
 */
export function addProperties(beg: number, end: number, deadline?: number): number | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    return e8.withSilentModifications(() => {
      const first = e8.lineOf(beg);
      const last = e8.lineOf(Math.min(end, e8.bufferSize()));
      let level = levelAt(first);
      for (let l = first; l <= last && e8.lineStart(l) < e8.bufferSize(); l++) {
        if (deadline !== undefined && (l - first) % 64 === 63 && Date.now() > deadline) return e8.lineStart(l);
        const text = e8.lineText(l);
        const m = HEADING.exec(text);
        if (m) {
          level = m[1].length;
          setLineProperties(l, level, 0, true);
        } else if (itemParts(l) !== undefined) {
          setLineProperties(l, level, itemBodyColumn(text), false);
        } else {
          setLineProperties(l, level, indentationOf(text), false);
        }
      }
      return undefined;
    });
  });
}

/** Where each buffer's first indenting has got to, as org-indent--initial-marker. */
const initial = new PerBuffer<e8.Marker>();

/**
 * Indents the rest of a buffer for at most 50 milliseconds, then lets
 * typing in, carrying on by a timer until it is done, as org-indent's agent
 * does in idle time.
 */
function initializeBuffer(buffer: e8.Buffer): void {
  if (!e8.bufferLiveP(buffer)) return;
  e8.withCurrentBuffer(buffer, () => {
    const marker = initial.get(buffer);
    if (e8.variable("org-indent-mode") !== true || marker === undefined) return;
    const from = e8.markerPosition(marker) ?? 0;
    const stopped = addProperties(from, e8.bufferSize(), Date.now() + 50);
    if (stopped === undefined) {
      e8.deleteMarker(marker);
      initial.delete(buffer);
      e8.runHooks("org-indent-post-buffer-init-functions", buffer);
    } else {
      e8.setMarker(marker, stopped);
      e8.runWithTimer(0.05, null, () => initializeBuffer(buffer));
    }
  });
}

/** Takes the prefixes off, as org-indent-remove-properties. */
function removeProperties(beg: number, end: number): void {
  e8.withSilentModifications(() => {
    e8.removeTextProperty(beg, end, "line-prefix");
    e8.removeTextProperty(beg, end, "wrap-prefix");
  });
}

/** Whether a change starts on or deletes a heading, as org-indent-notify-modified-headline records. */
let modifiedHeadline = false;

function notifyModifiedHeadline(beg: number, end: number): void {
  if (e8.variable("org-indent-mode") !== true) return;
  const first = e8.lineOf(beg);
  const last = e8.lineOf(end);
  const m = HEADING.exec(e8.lineText(first));
  modifiedHeadline = (m !== null && beg < e8.lineStart(first) + m[0].length) ||
    Array.from({ length: last - first }, (_, i) => first + 1 + i).some((l) => HEADING.test(e8.lineText(l)));
}

/** Gives the lines a change touched their prefixes again, up to the next heading if it touched one, as org-indent-refresh-maybe. */
function refreshMaybe(beg: number, end: number): void {
  if (e8.variable("org-indent-mode") !== true) return;
  e8.saveRestriction(() => {
    e8.widen();
    const first = e8.lineOf(beg);
    const last = e8.lineOf(Math.min(end, e8.bufferSize()));
    let touched = modifiedHeadline;
    for (let l = first; !touched && l <= last; l++) touched = HEADING.test(e8.lineText(l));
    if (touched) {
      let next = last + 1;
      while (next < e8.lineCount() && !HEADING.test(e8.lineText(next))) next++;
      modifiedHeadline = false;
      addProperties(beg, next < e8.lineCount() ? e8.lineStart(next) : e8.bufferSize());
    } else {
      addProperties(beg, end);
    }
  });
}

export const orgIndentMode = e8.defineMinorMode({
  name: "org-indent-mode",
  lighter: " Ind",
  doc:
    "Indent Org text under its headings, as it shows, without changing it: each line gets a line-prefix, " +
    "and long lines continue at the text's indentation. Turns org-hide-leading-stars on, so each heading shows its last star.",
  onChange: (enabled) => {
    if (enabled) {
      e8.makeLocalVariable("indent-tabs-mode");
      e8.setVariable("indent-tabs-mode", false);
      if (e8.variable("org-indent-mode-turns-off-org-adapt-indentation") === true && e8.variable("org-adapt-indentation") !== "headline-data") {
        e8.makeLocalVariable("org-adapt-indentation");
        e8.setVariable("org-adapt-indentation", null);
      }
      if (e8.variable("org-indent-mode-turns-on-hiding-stars") === true) {
        e8.makeLocalVariable("org-hide-leading-stars");
        e8.setVariable("org-hide-leading-stars", true);
      }
      prefixes = computePrefixes();
      wraps = new Map();
      e8.addHook("after-change-functions", refreshMaybe, { local: true });
      e8.addHook("before-change-functions", notifyModifiedHeadline, { local: true });
      e8.saveRestriction(() => {
        e8.widen();
        removeProperties(e8.pointMin(), e8.pointMax());
      });
      const old = initial.get(e8.currentBuffer());
      if (old !== undefined) e8.deleteMarker(old);
      initial.set(e8.currentBuffer(), e8.makeMarker(0));
      initializeBuffer(e8.currentBuffer());
    } else {
      const marker = initial.get(e8.currentBuffer());
      if (marker !== undefined) e8.deleteMarker(marker);
      initial.delete(e8.currentBuffer());
      e8.killLocalVariable("org-adapt-indentation");
      e8.killLocalVariable("org-hide-leading-stars");
      e8.removeHook("after-change-functions", refreshMaybe, { local: true });
      e8.removeHook("before-change-functions", notifyModifiedHeadline, { local: true });
      e8.saveRestriction(() => {
        e8.widen();
        removeProperties(e8.pointMin(), e8.pointMax());
      });
    }
    e8.call("font-lock-flush");
  },
});

e8.defineCommand({
  name: "org-indent-indent-buffer",
  doc: "Give the whole buffer org-indent-mode's indentation again.",
  run: () => {
    if (!e8.derivedModeP("org-mode")) e8.signal("error", "Not in Org mode");
    e8.message("Setting buffer indentation.  It may take a few seconds...");
    removeProperties(e8.pointMin(), e8.pointMax());
    addProperties(e8.pointMin(), e8.pointMax());
    e8.message("Indentation of buffer set.");
  },
});

// Text copied out of an indented buffer leaves the prefixes behind, as
// org-indent-remove-properties-from-string sees to in Org.
const excluded = e8.variable("yank-excluded-properties");
if (Array.isArray(excluded)) e8.setVariable("yank-excluded-properties", [...excluded, "line-prefix", "wrap-prefix"]);
