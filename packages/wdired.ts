// Editing a Dired listing to rename files, after Emacs's wdired.el: C-x C-q
// in Dired makes the file names editable, and the targets of links; C-c C-c
// renames each file whose name changed, flags for deletion those whose
// names were deleted, and goes back to Dired; C-c C-k takes the edits back.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { DEL_MARKER, currentDirectory, diredLog, fileLine, findLine, isDot, readin, requireDired, setMark } from "dired";
import { diredRenameFile } from "dired-aux";
import { eraseBuffer, PerBuffer } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("wdired-allow-to-redirect-links", true, "Whether the targets of symbolic links can be edited too, to point them elsewhere.");
defvar("wdired-confirm-overwrite", true, "Whether renaming a file over one that exists asks first.");
defvar("wdired-create-parent-directories", true, "Whether renaming a file into a directory that does not exist makes it.");
defvar(
  "wdired-allow-to-change-permissions",
  false,
  "Whether the permission bits can be edited too: t lets each bit be typed, r, w, x or -, or toggled with SPC; " +
    "advanced lets them be edited as any text. C-c C-c then sets the files' modes.",
);
e8.defineHook("wdired-mode-hook", "Functions called when a Dired buffer becomes editable.");

// Permission bits, as wdired--preprocess-perms keeps them.
const OLD_PERM = "wdired-old-perm";
const END_PERM = "wdired-end-perm";
const PERM_CHANGED = "wdired-perm-changed";
/** A line's permission bits, as dired-re-perms matches them. */
const PERMS = /[-bcdlps][-r][-w][-xsS][-r][-w][-xsSl][-r][-w][-xtT]/;

const truthy = (v: e8.Value | undefined): boolean => v !== null && v !== false && v !== undefined;

/** What a buffer was before it became editable, to go back to. */
const saved = new PerBuffer<{ content: string; point: number; modeName: e8.Value }>();

/** Each file line's name, and its link's target, kept on the text before them so editing finds them. */
const OLD_NAME = "wdired-old-name";
const OLD_LINK = "wdired-old-link";

/** Makes all but the names, and the links' targets, read-only, as wdired--preprocess-files and -symlinks. */
function protect(): void {
  const dir = currentDirectory();
  const redirect = truthy(e8.variable("wdired-allow-to-redirect-links"));
  const readOnly = (start: number, end: number) => {
    if (end > start) e8.putTextProperty(start, end, "read-only", true);
  };
  for (let l = 0; l < e8.lineCount(); l++) {
    const start = e8.lineStart(l);
    const end = e8.lineEndPosition(start);
    const f = fileLine(l);
    // The newline is read-only too, so lines stay lines; typing before it is not.
    const lineEnd = Math.min(end + 1, e8.bufferSize());
    // Nor can text go in before a line, as its first character's front-sticky says.
    if (end > start) e8.putTextProperty(start, start + 1, "front-sticky", true);
    if (!f || isDot(f.name)) {
      readOnly(start, lineEnd);
      continue;
    }
    // The permission bits, editable bit by bit or as text, as
    // wdired-allow-to-change-permissions says, for files that are not links.
    const perms = truthy(e8.variable("wdired-allow-to-change-permissions")) && !f.isLink
      ? PERMS.exec(e8.bufferSubstringNoProperties(start, f.start))
      : null;
    if (perms) {
      const begin = start + perms.index;
      const pend = begin + perms[0].length;
      readOnly(start, begin);
      if (e8.variable("wdired-allow-to-change-permissions") === "advanced") {
        if (begin > start) e8.putTextProperty(begin - 1, begin, "rear-nonsticky", true);
      } else {
        readOnly(begin, pend);
        e8.putTextProperty(begin + 1, pend, "keymap", PERM_MAP as unknown as e8.Value);
      }
      e8.putTextProperty(pend, pend + 1, END_PERM, true);
      e8.putTextProperty(begin, begin + 1, OLD_PERM, perms[0]);
      readOnly(pend, f.start);
    } else {
      readOnly(start, f.start);
    }
    // Typing at the start of a name is not typing after read-only text.
    e8.putTextProperty(f.start - 1, f.start, "rear-nonsticky", true);
    e8.putTextProperty(f.start - 1, f.start, OLD_NAME, dir + f.name);
    if (f.isLink) {
      const arrow = f.start + [...f.name].length;
      readOnly(arrow, arrow + 4);
      e8.putTextProperty(arrow + 3, arrow + 4, "rear-nonsticky", true);
      e8.putTextProperty(arrow, arrow + 1, OLD_LINK, e8.bufferSubstringNoProperties(arrow + 4, end));
      if (!redirect) readOnly(arrow + 4, end);
    }
    readOnly(end, lineEnd);
  }
}

/** Takes the properties protect put back off. */
function unprotect(): void {
  e8.letBind({ "inhibit-read-only": true }, () => {
    for (const name of ["read-only", "front-sticky", "rear-nonsticky", "keymap", OLD_NAME, OLD_LINK, OLD_PERM, END_PERM, PERM_CHANGED]) e8.removeTextProperty(0, e8.bufferSize(), name);
  });
}

e8.defineKeymap("wdired-mode-map");

/** Where a line's permission bits start, if it has them. */
function permStart(pos: number): number | undefined {
  const start = e8.lineBeginningPosition(pos);
  const end = e8.lineEndPosition(start);
  for (let p = start; p < end; p++) if (e8.getTextProperty(p, OLD_PERM) !== undefined) return p;
  return undefined;
}

/** Whether a bit may be `c` at position `pos` of the nine, as wdired-perm-allowed-in-pos. */
function permAllowed(c: string, pos: number): boolean {
  if (c === "-") return true;
  if (c === "r") return pos % 3 === 0;
  if (c === "w") return pos % 3 === 1;
  if (c === "x") return pos % 3 === 2;
  if (c === "s" || c === "S") return pos === 2 || pos === 5;
  if (c === "t" || c === "T") return pos === 8;
  if (c === "l") return pos === 5;
  return false;
}

/** Sets the bit at point to `c` if it may be, else moves on, as wdired-set-bit. */
function setBit(c: string): void {
  const begin = permStart(e8.point());
  if (begin === undefined) return;
  const pos = e8.point() - begin - 1;
  if (pos >= 0 && pos < 9 && permAllowed(c, pos)) {
    e8.letBind({ "inhibit-read-only": true }, () => {
      const props = e8.textPropertiesAt(e8.point());
      e8.deleteRegion(e8.point(), e8.point() + 1);
      e8.insert(c);
      for (const [name, value] of Object.entries(props)) e8.putTextProperty(e8.point() - 1, e8.point(), name, value);
      e8.putTextProperty(begin, begin + 1, PERM_CHANGED, true);
    });
  } else {
    e8.gotoChar(e8.point() + 1);
  }
}

e8.defineKeymap("wdired-perm-mode-map");
const PERM_MAP = "wdired-perm-mode-map";
const setBitCommand = e8.defineCommand({
  name: "wdired-set-bit",
  doc: "Set the permission bit at point to the key typed, if it can be that bit.",
  run: () => setBit(e8.lastKey() ?? ""),
});
for (const key of ["r", "w", "x", "-", "S", "T", "t", "s", "l"]) e8.defineKey(PERM_MAP, key, setBitCommand);
e8.defineKey(
  PERM_MAP,
  "SPC",
  e8.defineCommand({
    name: "wdired-toggle-bit",
    doc: "Toggle the permission bit at point: on is r, w or x as its place says, off is -.",
    run: () => {
      const begin = permStart(e8.point());
      if (begin === undefined) return;
      const pos = e8.point() - begin - 1;
      setBit(e8.charAfter(e8.point()) !== "-" ? "-" : ["r", "w", "x"][pos % 3]!);
    },
  }),
);

/** A mode from ten permission characters, as wdired-perms-to-number. */
export function permsToNumber(perms: string): number {
  let n = 0o777;
  if (perms[1] === "-") n -= 0o400;
  if (perms[2] === "-") n -= 0o200;
  if (perms[3] === "-" || perms[3] === "S") n -= 0o100;
  if (perms[3] === "s" || perms[3] === "S") n += 0o4000;
  if (perms[4] === "-") n -= 0o40;
  if (perms[5] === "-") n -= 0o20;
  if (perms[6] === "-" || perms[6] === "S" || perms[6] === "l") n -= 0o10;
  if (perms[6] === "s" || perms[6] === "S" || perms[6] === "l") n += 0o2000;
  if (perms[7] === "-") n -= 4;
  if (perms[8] === "-") n -= 2;
  if (perms[9] === "-" || perms[9] === "T") n -= 1;
  if (perms[9] === "t" || perms[9] === "T") n += 0o1000;
  return n;
}

/** Sets the modes of the files whose bits were changed, as wdired-do-perm-changes. */
function doPermChanges(): { changed: boolean; errors: number } {
  let changed = false;
  let errors = 0;
  const advanced = e8.variable("wdired-allow-to-change-permissions") === "advanced";
  for (let l = 0; l < e8.lineCount(); l++) {
    const begin = permStart(e8.lineStart(l));
    if (begin === undefined || (!advanced && e8.getTextProperty(begin, PERM_CHANGED) === undefined)) continue;
    const old = String(e8.getTextProperty(begin, OLD_PERM));
    const end = e8.nextSinglePropertyChange(begin, END_PERM, e8.lineEndPosition(begin)) ?? e8.lineEndPosition(begin);
    const perms = e8.bufferSubstringNoProperties(begin, end);
    if (perms === old) continue;
    changed = true;
    const file = lineNames(l)?.old;
    if (file === undefined) continue;
    if (perms.length === 10) {
      try {
        e8.setFileModes(file, permsToNumber(perms));
      } catch {
        errors++;
        diredLog(`Setting mode of \u2018${file}\u2019 to \u2018${perms}\u2019 failed\n\n`);
      }
    } else {
      errors++;
      diredLog(`Cannot parse permission \u2018${perms}\u2019 for file \u2018${file}\u2019\n\n`);
    }
  }
  return { changed, errors };
}

e8.defineCommand({
  name: "wdired-change-to-wdired-mode",
  doc:
    "Make this Dired buffer's file names editable, and the targets of its links. C-c C-c renames the files " +
    "whose names you changed and flags for deletion those whose names you deleted; C-c C-k takes the edits back.",
  run: () => {
    requireDired();
    saved.set(e8.currentBuffer(), {
      content: e8.bufferSubstringNoProperties(0, e8.bufferSize()),
      point: e8.point(),
      modeName: e8.variable("mode-name") ?? "Dired by name",
    });
    e8.withSilentModifications(protect);
    // Searching and replacing find only file names, as wdired-mode has
    // isearch and query-replace search with dired-isearch-search-filenames.
    e8.makeLocalVariable("isearch-filter-predicate");
    e8.setVariable("isearch-filter-predicate", inFileName as unknown as e8.Value);
    e8.useLocalMap("wdired-mode-map");
    e8.setReadOnly(false);
    e8.setVariable("major-mode", "wdired-mode");
    e8.setVariable("mode-name", "Editable Dired");
    e8.setBufferModified(false);
    e8.runHooks("wdired-mode-hook");
    e8.message("Press C-c C-c when finished or C-c ESC to abort changes");
  },
});

/** Goes back to Dired, as wdired-change-to-dired-mode. */
function changeToDired(): void {
  if (e8.variable("major-mode") !== "wdired-mode") throw new Error("Not a Wdired buffer");
  e8.withSilentModifications(unprotect);
  e8.killLocalVariable("isearch-filter-predicate");
  e8.useLocalMap("dired-mode-map");
  e8.setReadOnly(true);
  e8.setVariable("major-mode", "dired-mode");
  e8.setVariable("mode-name", saved.get(e8.currentBuffer())?.modeName ?? "Dired by name");
  saved.delete(e8.currentBuffer());
}

e8.defineCommand({
  name: "wdired-abort-changes",
  doc: "Take back the edits to the file names and go back to Dired.",
  run: () => {
    const before = saved.get(e8.currentBuffer());
    if (before === undefined) throw new Error("Not a Wdired buffer");
    e8.letBind({ "inhibit-read-only": true }, () => {
      eraseBuffer();
      e8.insert(before.content);
    });
    e8.gotoChar(before.point);
    changeToDired();
    e8.setBufferModified(false);
    e8.message("Changes aborted");
  },
});

/** Whether a match lies within a file name, as dired-isearch-search-filenames lets it. */
function inFileName(start: number, end: number): boolean {
  const lineStart = e8.lineBeginningPosition(start);
  const lineEnd = e8.lineEndPosition(lineStart);
  if (end > lineEnd) return false;
  let at = lineStart;
  if (e8.getTextProperty(at, OLD_NAME) === undefined) at = e8.nextSinglePropertyChange(lineStart, OLD_NAME, lineEnd) ?? lineEnd;
  if (at >= lineEnd) return false;
  const nameEnd = e8.nextSinglePropertyChange(at + 1, OLD_LINK, lineEnd) ?? lineEnd;
  return start >= at + 1 && end <= nameEnd;
}

/** A line's old and new names, and its link's old and new targets, as wdired-get-filename reads them. */
function lineNames(l: number): { old: string; name: string; oldLink?: string; link?: string } | undefined {
  const start = e8.lineStart(l);
  const end = e8.lineEndPosition(start);
  let at = start;
  if (e8.getTextProperty(at, OLD_NAME) === undefined) at = e8.nextSinglePropertyChange(start, OLD_NAME, end) ?? end;
  const old = at < end ? e8.getTextProperty(at, OLD_NAME) : undefined;
  if (typeof old !== "string") return undefined;
  const arrow = e8.nextSinglePropertyChange(at + 1, OLD_LINK, end) ?? end;
  const oldLink = arrow < end ? e8.getTextProperty(arrow, OLD_LINK) : undefined;
  return {
    old,
    name: e8.bufferSubstringNoProperties(at + 1, arrow),
    ...(typeof oldLink === "string" ? { oldLink, link: e8.bufferSubstringNoProperties(arrow + 4, end) } : {}),
  };
}

/** Renames files all at once, as wdired-do-renames: a file renamed to one that is itself renamed waits for it. */
function doRenames(renames: [string, string][]): { errors: number; renamed: string[] } {
  let residue: [string, string][] = [];
  let progress = false;
  let errors = 0;
  const renamed: string[] = [];
  const confirm = truthy(e8.variable("wdired-confirm-overwrite"));
  for (;;) {
    if (renames.length === 0) {
      if (residue.length === 0) break;
      renames = residue;
      residue = [];
      progress = false;
    }
    const [from, to] = renames.shift()!;
    if (renames.some(([, t]) => t === to)) throw new Error("Trying to rename 2 files to the same name");
    if (renames.some(([f]) => f === to)) {
      residue.push([from, to]);
    } else if (residue.some(([f]) => f === to) && e8.fileExists(to)) {
      if (progress || renames.length > 0) residue.push([from, to]);
      else {
        // A circle of renames: one goes by way of a name of its own.
        e8.message("Circular renaming: using temporary file name");
        const tmp = `${to}${Math.random().toString(36).slice(2, 8)}`;
        renames.unshift([from, tmp]);
        residue.push([tmp, to]);
      }
    } else {
      progress = true;
      try {
        const dir = e8.fileNameDirectory(to);
        if (truthy(e8.variable("wdired-create-parent-directories")) && dir !== undefined && !e8.fileExists(dir)) {
          e8.message(`Creating directory for file ${to}`);
          e8.makeDirectory(dir, { parents: true });
        }
        if (e8.fileExists(to) && confirm && !e8.yesOrNoP(`File ${to} already exists; rename to it anyway? `)) {
          e8.signal("file-already-exists", "File already exists", [to]);
        }
        diredRenameFile(from, to);
        renamed.push(to);
      } catch (e) {
        if (e8.errorConditions(e).includes("quit")) throw e;
        errors++;
      }
    }
  }
  return { errors, renamed };
}

/** Points the links whose targets were edited at their new ones, as wdired-do-symlink-changes. */
function doSymlinkChanges(): { changed: boolean; errors: number } {
  let changed = false;
  let errors = 0;
  for (let l = e8.lineCount() - 1; l >= 0; l--) {
    const names = lineNames(l);
    if (names?.oldLink === undefined || names.link === names.oldLink) continue;
    changed = true;
    try {
      e8.deleteFile(names.old);
      e8.makeSymbolicLink(names.link!, names.old);
    } catch {
      errors++;
    }
  }
  return { changed, errors };
}

e8.defineCommand({
  name: "wdired-finish-edit",
  doc: "Rename the files whose names you edited, point links at their edited targets, flag for deletion the files whose names you deleted, and go back to Dired.",
  run: () => {
    let { changed, errors } = truthy(e8.variable("wdired-allow-to-redirect-links")) ? doSymlinkChanges() : { changed: false, errors: 0 };
    // The modes, as wdired-finish-edit sets them after the links.
    if (truthy(e8.variable("wdired-allow-to-change-permissions"))) {
      const perms = doPermChanges();
      changed ||= perms.changed;
      errors += perms.errors;
    }
    const dir = currentDirectory();
    const renames: [string, string][] = [];
    const deleted: string[] = [];
    for (let l = e8.lineCount() - 1; l >= 0; l--) {
      const names = lineNames(l);
      if (names === undefined) continue;
      const fresh = names.name === "" ? undefined : e8.substituteInFileName(e8.expandFileName(names.name, dir));
      if (fresh === names.old) continue;
      changed = true;
      if (fresh === undefined) deleted.push(names.old);
      else renames.push([names.old, fresh]);
    }
    if (renames.length > 0) {
      errors += doRenames(renames).errors;
      e8.message("Renaming...done");
    }
    changeToDired();
    // Listing again shows the new names in order, keeping their marks.
    readin(true);
    if (!changed) e8.message("(No changes to be performed)");
    for (const file of deleted) {
      const line = findLine(e8.fileNameNondirectory(file));
      if (line !== undefined) setMark(line, DEL_MARKER);
    }
    if (errors > 0) e8.message(`${errors} actions failed--type ? for details`);
    e8.setBufferModified(false);
  },
});

e8.defineCommand({
  name: "wdired-exit",
  doc: "Go back to Dired: if the names were edited, after asking whether to rename the files or take the edits back.",
  run: () => {
    if (e8.bufferModified()) {
      if (e8.yOrNP(`Buffer ${e8.bufferName()} modified; save changes? `)) e8.call("wdired-finish-edit");
      else e8.call("wdired-abort-changes");
      return;
    }
    changeToDired();
    e8.setBufferModified(false);
    e8.message("(No changes need to be saved)");
  },
});

for (const [keys, command] of [
  ["C-x C-s", "wdired-finish-edit"], ["C-c C-c", "wdired-finish-edit"], ["C-c C-k", "wdired-abort-changes"],
  ["C-c ESC", "wdired-abort-changes"], ["C-x C-q", "wdired-exit"], ["RET", "undefined"], ["C-j", "undefined"],
  ["C-o", "undefined"], ["C-(", "dired-hide-details-mode"],
] as const) {
  e8.defineKey("wdired-mode-map", keys, command);
}
e8.defineKey("dired-mode-map", "C-x C-q", "wdired-change-to-wdired-mode");
