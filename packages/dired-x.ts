// Extra Dired commands, after Emacs's dired-x.el: omitting uninteresting
// files from listings, and visiting all the marked files at once.
//
// Copyright (C) 1993-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentDirectory, fileLine, markedFiles, readin, requireDired } from "dired";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("dired-omit-files", "\\`[.]?#\\|\\`[.][.]?\\'", "The names Dired-Omit mode leaves out, as a regexp: . and .., and auto-save and lock files.");
defvar("dired-omit-extensions", [
  ...(() => {
    const ignored = e8.variable("completion-ignored-extensions");
    return Array.isArray(ignored) ? ignored.filter((e): e is string => typeof e === "string") : [];
  })(),
  ".idx", ".lof", ".lot", ".glo", ".blg", ".bbl",
  ".cp", ".cps", ".fn", ".fns", ".ky", ".kys", ".pg", ".pgs", ".tp", ".tps", ".vr", ".vrs",
], "The endings of the names Dired-Omit mode leaves out: compiled files, backups and what TeX leaves behind.");
defvar("dired-omit-verbose", true, "Whether Dired-Omit mode says how many lines it left out.");
defvar("dired-omit-size-limit", 300000, "Dired-Omit mode leaves nothing out of a listing bigger than this, in characters, as it would be slow; nil for no limit.");
defvar("dired-omit-case-fold", "filesystem", "Whether omitting ignores case: filesystem as the file system does, else true or nil.");

const truthy = (v: e8.Value | undefined): boolean => v !== null && v !== false && v !== undefined;

/** The regexp of the names to leave out, as dired-omit-regexp. */
function omitRegexp(): string {
  const files = e8.variable("dired-omit-files");
  const exts = e8.variable("dired-omit-extensions");
  const list = Array.isArray(exts) ? exts.filter((e): e is string => typeof e === "string") : [];
  const quoted = list.map((e) => e.replace(/[.*+?^$[\]\\]/g, "\\$&")).join("\\|");
  return (typeof files === "string" && files !== "" ? `\\(${files}\\)` : "") +
    (typeof files === "string" && files !== "" && list.length > 0 ? "\\|" : "") +
    (list.length > 0 ? `.\\(?:${quoted}\\)$` : "");
}

/** Takes the unmarked lines of files whose names match the omit regexp out of the listing, as dired-omit-expunge. */
function omitExpunge(): number {
  if (!truthy(e8.variable("dired-omit-mode"))) return 0;
  const limit = e8.variable("dired-omit-size-limit");
  if (typeof limit === "number" && e8.bufferSize() >= limit) {
    if (truthy(e8.variable("dired-omit-verbose"))) e8.message(`Not omitting: directory larger than ${limit} characters.`);
    e8.callWithPrefix(-1, "dired-omit-mode");
    return 0;
  }
  const regexp = omitRegexp();
  if (regexp === "") return 0;
  const fold = e8.variable("dired-omit-case-fold");
  const caseFold = fold === "filesystem" ? e8.fileNameCaseInsensitiveP(currentDirectory()) : truthy(fold);
  const verbose = truthy(e8.variable("dired-omit-verbose"));
  if (verbose) e8.message("Omitting...");
  const modified = e8.bufferModified();
  let count = 0;
  e8.letBind({ "inhibit-read-only": true }, () => {
    for (let l = e8.lineCount() - 1; l >= 0; l--) {
      const f = fileLine(l);
      if (!f || f.mark !== " " || e8.stringMatch(regexp, f.name, { caseFold }) === undefined) continue;
      e8.deleteRegion(e8.lineStart(l), Math.min(e8.lineStart(l + 1), e8.pointMax()));
      count++;
    }
  });
  if (verbose) {
    e8.message(count === 0 ? "(Nothing to omit)" : `Omitted ${count} line${count === 1 ? "" : "s"} in ${e8.abbreviateFileName(String(e8.variable("dired-directory")))}`);
  }
  e8.setBufferModified(modified);
  return count;
}

e8.defineMinorMode({
  name: "dired-omit-mode",
  lighter: " Omit",
  doc:
    "Leave uninteresting files out of Dired listings: those whose names match dired-omit-files or end in one of " +
    "dired-omit-extensions. Turning it off lists them again.",
  onChange: (enabled) => {
    if (e8.variable("major-mode") !== "dired-mode") return;
    if (enabled) {
      // As called from a command, with no limit on the listing's size.
      e8.letBind({ "dired-omit-size-limit": null }, omitExpunge);
    } else readin(true);
  },
});
e8.addHook("dired-after-readin-hook", omitExpunge);

e8.defineCommand({
  name: "dired-do-find-marked-files",
  doc:
    "Visit all the marked files, each in a window of its own, splitting this one evenly between them. " +
    "With a prefix argument, visit them without showing them.",
  run: () => {
    requireDired();
    const noselect = e8.prefixArg() !== null;
    const { files } = markedFiles(null);
    if (noselect) {
      for (const file of files) e8.findFileNoselect(file);
      return;
    }
    const height = e8.windowSize()?.totalHeight ?? 24;
    const size = Math.floor(height / files.length);
    if (size < Number(e8.variable("window-min-height") ?? 4)) throw new Error("Too many files to visit simultaneously.  Try C-u prefix");
    e8.call("find-file", files[0]);
    for (const file of files.slice(1)) {
      e8.selectWindow(e8.splitWindow(undefined, "below", size));
      e8.call("find-file", file);
    }
  },
});

e8.defineKey("dired-mode-map", "C-x M-o", "dired-omit-mode");
e8.defineKey("dired-mode-map", "F", "dired-do-find-marked-files");

