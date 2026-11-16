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

import { DEL_MARKER, currentDirectory, fileLine, findLine, isDot, readin, requireDired, setMark } from "dired";
import { diredRenameFile } from "dired-aux";
import { eraseBuffer, PerBuffer } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("wdired-allow-to-redirect-links", true, "Whether the targets of symbolic links can be edited too, to point them elsewhere.");
defvar("wdired-confirm-overwrite", true, "Whether renaming a file over one that exists asks first.");
defvar("wdired-create-parent-directories", true, "Whether renaming a file into a directory that does not exist makes it.");
e8.defineHook("wdired-mode-hook", "Functions called when a Dired buffer becomes editable.");

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
    readOnly(start, f.start);
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
    for (const name of ["read-only", "front-sticky", "rear-nonsticky", OLD_NAME, OLD_LINK]) e8.removeTextProperty(0, e8.bufferSize(), name);
  });
}

e8.defineKeymap("wdired-mode-map");

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
