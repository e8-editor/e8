// Attachments to Org entries, after Org's org-attach.el: C-c C-a shows a
// dispatcher whose keys attach a file to the entry at point, by copying,
// moving or linking it into the entry's attachment directory, open and
// delete its attachments, or synchronise them. The directory is the
// entry's DIR property, or one made from its ID under org-attach-id-dir,
// as org-attach-id-to-path-function-list says, and an entry with
// attachments is tagged ATTACH. attachment: links name a file there; they
// are followed, exported as file links and shown as inline images.
//
// Copyright (C) 2008-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { entryGetInherited, globalProperty, headingIndex, headings, linkSetParameters, openLink, propertyInheritP, toggleTag } from "org";
import { entryDelete, entryGet, entryPutHere, topGet } from "org-list";
import { lineAt } from "org-macs";
import { orgIdGet } from "org-id";
import { linkHere, linkMakeString } from "ol";
import { eraseBuffer, truthy } from "subr";
import { markedFiles } from "dired";
import { fileRelativeName } from "files";
import { getBufferWindowList, quitWindow } from "window";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("org-attach-id-dir", "data/", "The directory where attachments are stored; a relative one is in the directory of the Org file.");
defvar("org-attach-dir-relative", false, "Whether a DIR property set by org-attach-set-directory is written relative to the file's directory, rather than absolute.");
defvar("org-attach-auto-tag", "ATTACH", "The tag an entry with attachments gets, or nil for none.");
defvar(
  "org-attach-preferred-new-method",
  e8.intern("id"),
  "How an entry with neither ID nor DIR property gets an attachment directory: id makes an ID, dir asks for a DIR, ask asks which, nil makes neither.",
);
defvar("org-attach-method", e8.intern("cp"), "How a file is attached: cp copies it, mv moves it, ln makes a hard link and lns a symbolic link.");
defvar("org-attach-expert", false, "Whether the dispatcher leaves out its list of commands.");
defvar(
  "org-attach-use-inheritance",
  e8.intern("selective"),
  "Whether an entry without attachments of its own uses those of the entry above with some: t, nil, or selective, as org-use-property-inheritance says for DIR and ID.",
);
defvar(
  "org-attach-store-link-p",
  e8.intern("attached"),
  "Whether attaching a file stores a link: t to where it was, file to the attached file, attached an attachment: link to it, nil none.",
);
defvar("org-attach-archive-delete", false, "Whether archiving a subtree deletes its attachments: t, nil, or query to ask.");
defvar(
  "org-attach-id-to-path-function-list",
  ["org-attach-id-uuid-folder-format", "org-attach-id-ts-folder-format", "org-attach-id-fallback-folder-format"],
  "Functions that turn an ID into the attachment directory's path under org-attach-id-dir, tried in turn: the first existing folder, else the first answer.",
);
defvar(
  "org-attach-sync-delete-empty-dir",
  e8.intern("query"),
  "What org-attach-sync does with an empty attachment directory: delete it with t, leave it with nil, or ask with query.",
);
e8.defineHook("org-attach-after-change-hook", "Functions called with the attachment directory when files have been added to it or removed.");
e8.defineHook("org-attach-open-hook", "Functions called with the file org-attach-open opens.");

/** The commands of the dispatcher: their keys, the first shown, the command and what it does, as org-attach-commands. */
defvar(
  "org-attach-commands",
  [
    [["a", "\u0001"], "org-attach-attach", "Select a file and attach it to the task, using `org-attach-method'."],
    [["c", "\u0003"], "org-attach-attach-cp", "Attach a file using copy method."],
    [["m", "\r"], "org-attach-attach-mv", "Attach a file using move method."],
    [["l", "\f"], "org-attach-attach-ln", "Attach a file using link method."],
    [["y", "\u0019"], "org-attach-attach-lns", "Attach a file using symbolic-link method."],
    [["u", "\u0015"], "org-attach-url", "Attach a file from URL (downloading it)."],
    [["b"], "org-attach-buffer", "Select a buffer and attach its contents to the task."],
    [["n", "\u000e"], "org-attach-new", "Create a new attachment, as an Emacs buffer."],
    [["z", "\u001a"], "org-attach-sync", "Synchronize the current node with its attachment\n directory, in case you added attachments yourself.\n"],
    [["o", "\u000f"], "org-attach-open", "Open current node's attachments."],
    [["O"], "org-attach-open-in-emacs", 'Like "o", but force opening in Emacs.'],
    [["f", "\u0006"], "org-attach-reveal", "Open current node's attachment directory.  Create if missing."],
    [["F"], "org-attach-reveal-in-emacs", 'Like "f", but force using Dired in Emacs.\n'],
    [["d", "\u0004"], "org-attach-delete-one", "Delete one attachment, you will be prompted for a file name."],
    [["D"], "org-attach-delete-all", "Delete all of a node's attachments.  A safer way is\n to open the directory in dired and delete from there.\n"],
    [["s", "\u0013"], "org-attach-set-directory", "Set a specific attachment directory for this entry. Sets DIR property."],
    [["S", "\u0013"], "org-attach-unset-directory", "Unset the attachment directory for this entry.  Removes DIR property."],
    [["q"], "org-attach--abort", "Abort."],
  ],
  "The commands of the attachment dispatcher: for each, its keys, the first shown, the command run, and what it does.",
);

/** A symbol's name, or a string, as variables holding symbols are set either way. */
const name = (v: e8.Value | undefined): string | undefined => (typeof v === "symbol" ? e8.symbolName(v) : typeof v === "string" ? v : v === true ? "t" : undefined);

// ----- The attachment directory -----

/** The ID's folder from its first two characters, as org-attach-id-uuid-folder-format. */
e8.defun("org-attach-id-uuid-folder-format", (id: string) => (id.length > 2 ? `${id.slice(0, 2)}/${id.slice(2)}` : null));
/** The ID's folder from its first six characters, the year and month of a timestamp, as org-attach-id-ts-folder-format. */
e8.defun("org-attach-id-ts-folder-format", (id: string) => (id.length > 6 ? `${id.slice(0, 6)}/${id.slice(6)}` : null));
/** __/X/ID, X the ID's first character, as org-attach-id-fallback-folder-format. */
e8.defun("org-attach-id-fallback-folder-format", (id: string) => `__/${id.slice(0, 1)}/${id}`);

/** PROPERTY of the entry at point, inherited as INHERIT says: t, nil, or selective, as org-use-property-inheritance says, as org-entry-get. */
function entryGetHere(property: string, inherit: e8.Value | undefined): string | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  const how = name(inherit);
  const inherited = how === "t" || (how === "selective" && propertyInheritP(property));
  // Before the first heading, the file's drawer, then with inheritance #+PROPERTY: lines and org-global-properties, as org-entry-get-with-inheritance.
  if (i === undefined) {
    const value = topGet(property) ?? (inherited ? globalProperty(property) : undefined);
    return value === "nil" ? undefined : value;
  }
  return inherited ? entryGetInherited(all[i], property, false) : entryGet(all[i].line, property);
}

/** Whether the attachment directory can be rooted, as org-attach-check-absolute-path: an absolute DIR or org-attach-id-dir, or a file. */
function checkAbsolutePath(dir: string | undefined): void {
  if (dir !== undefined && e8.fileNameAbsoluteP(dir)) return;
  if (e8.fileNameAbsoluteP(String(e8.variable("org-attach-id-dir") ?? "data/"))) return;
  if (e8.withCurrentBuffer(e8.bufferBaseBuffer() ?? e8.currentBuffer(), () => e8.bufferFileName()) !== undefined) return;
  // An export's copy of the buffer has its source's file, as Org's copy keeps buffer-file-name.
  if (typeof e8.variable("e8--export-source-file") === "string") return;
  e8.signal("error", "Need absolute `org-attach-id-dir' to attach in buffers without filename");
}

/**
 * The entry's attachment directory, from its DIR property, else its ID, as
 * org-attach-dir: undefined if there is none, or with no fsCheck if it is
 * not made yet; made if need be with create.
 */
export function attachDir(create = false, noFsCheck = false): string | undefined {
  let dir: string | undefined;
  const inherit = e8.variable("org-attach-use-inheritance");
  if (create) dir = dirGetCreate();
  else if ((dir = entryGetHere("DIR", inherit)) !== undefined) checkAbsolutePath(dir);
  // ATTACH_DIR is deprecated, but still works, as in Org.
  else if ((dir = entryGetHere("ATTACH_DIR", inherit)) !== undefined) checkAbsolutePath(dir);
  else {
    const id = entryGetHere("ID", inherit);
    if (id !== undefined) {
      checkAbsolutePath(undefined);
      dir = dirFromId(id, true);
    }
  }
  if (noFsCheck) return dir;
  return dir !== undefined && e8.fileDirectoryP(dir) ? dir : undefined;
}

e8.defun("org-attach-dir", (create?: e8.Value, noFsCheck?: e8.Value) => attachDir(truthy(create ?? null), truthy(noFsCheck ?? null)) ?? null);

/** The entry's attachment directory, made, with an ID or a DIR property for it if it has neither, as org-attach-dir-get-create. */
function dirGetCreate(): string {
  let dir = attachDir(false, true);
  if (dir === undefined) {
    const method = name(e8.variable("org-attach-preferred-new-method"));
    let answer: string | undefined;
    if (method === "ask") {
      e8.message("Create new ID [1] property or DIR [2] property for attachments?");
      answer = e8.readCharExclusive();
    }
    if (method === "id" || answer === "1") {
      const id = orgIdGet(true)!;
      dir = dirFromId(id);
      if (dir === undefined) e8.signal("error", `Failed to get folder for id ${id}, adjust \`org-attach-id-to-path-function-list'`);
    } else if (method === "dir" || answer === "2") dir = setDirectory();
    else if (method === undefined) e8.signal("error", "No existing directory.  DIR or ID property has to be explicitly created");
  }
  if (dir === undefined) e8.signal("error", "No attachment directory is associated with the current node");
  if (!e8.fileDirectoryP(dir)) e8.makeDirectory(dir, { parents: true });
  return dir;
}

/**
 * The folder for ID under org-attach-id-dir, from the first function of
 * org-attach-id-to-path-function-list that gives one, or with existing the
 * first that is there, trying "data/" too, as org-attach-dir-from-id.
 */
export function dirFromId(id: string, existing = false): string | undefined {
  const functions = e8.variable("org-attach-id-to-path-function-list");
  const base = e8.expandFileName(String(e8.variable("org-attach-id-dir") ?? "data/"));
  const defaultBase = e8.expandFileName("data/");
  let preferred: string | undefined;
  let first: string | undefined;
  for (const f of Array.isArray(functions) ? functions : []) {
    if (preferred !== undefined) break;
    const folder = e8.funcall(f as any, id);
    if (typeof folder !== "string") continue;
    const candidate = e8.expandFileName(folder, base);
    const candidate2 = base !== defaultBase ? e8.expandFileName(folder, defaultBase) : undefined;
    if (!existing || e8.fileDirectoryP(candidate)) preferred = candidate;
    else if (first === undefined) first = candidate;
    if (existing && candidate2 !== undefined && !e8.fileDirectoryP(candidate) && e8.fileDirectoryP(candidate2)) preferred = candidate2;
  }
  return preferred ?? first;
}

e8.defineCommand({
  name: "org-attach-dir-get-create",
  doc: "Return the attachment directory of the current entry, made, with an ID or DIR property for it as org-attach-preferred-new-method says if it has neither.",
  run: () => {
    dirGetCreate();
  },
});

/** The heading at point and the index of it, or undefined before the first. */
function headingHere(): { all: ReturnType<typeof headings>; i: number } | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : { all, i };
}

/** Asks for the entry's DIR property, sets it, and offers to move the old directory's files there, as org-attach-set-directory. */
function setDirectory(): string {
  const old = attachDir();
  const given = e8.readFileName("Attachment directory: ", { dir: entryGetHere("DIR", null) });
  const attachDirName = e8.expandFileName(given);
  const currentDir = e8.fileNameDirectory(String(e8.variable("default-directory") ?? e8.bufferFileName() ?? "")) ?? "";
  // A directory's name keeps its slash, as file-relative-name keeps it.
  const relative = fileRelativeName(attachDirName, currentDir) + (given.endsWith("/") && !fileRelativeName(attachDirName, currentDir).endsWith("/") ? "/" : "");
  entryPutHere("DIR", truthy(e8.variable("org-attach-dir-relative")) ? relative : given);
  const fresh = given;
  if (old !== undefined && old !== fresh) {
    if (e8.yesOrNoP("Copy over attachments from old directory? ")) copyDirectoryContents(old, fresh);
    if (e8.yesOrNoP(`Delete ${old}`)) e8.deleteDirectory(old, { recursive: true });
  }
  return fresh;
}

/** Copies the files of OLD into NEW, made if need be, as copy-directory with COPY-CONTENTS. */
function copyDirectoryContents(old: string, fresh: string): void {
  if (!e8.fileDirectoryP(fresh)) e8.makeDirectory(fresh, { parents: true });
  for (const f of e8.directoryFiles(old, { full: true }).filter((x) => !/\/\.\.?$/.test(x))) {
    const to = e8.expandFileName(e8.fileNameNondirectory(f), fresh);
    if (e8.fileDirectoryP(f)) e8.copyDirectory(f, to, { keepTime: true });
    else e8.copyFile(f, to, { okIfExists: true, keepTime: true });
  }
}

e8.defineCommand({
  name: "org-attach-set-directory",
  doc: "Set the entry's DIR property, the directory of its attachments, and offer to move the files of the old one there.",
  run: () => {
    setDirectory();
  },
});

e8.defineCommand({
  name: "org-attach-unset-directory",
  doc: "Remove the entry's DIR property, and offer to move its attachments to the directory it has without it.",
  run: () => {
    const old = attachDir();
    const here = headingHere();
    if (here) {
      entryDelete(here.all[here.i], "DIR");
      // ATTACH_DIR is deprecated, but still works, as in Org.
      const again = headingHere();
      if (again) entryDelete(again.all[again.i], "ATTACH_DIR");
    }
    const fresh = attachDir();
    if (old !== undefined && old !== fresh) {
      if (fresh !== undefined && e8.yesOrNoP("Copy over attachments from old directory? ")) copyDirectoryContents(old, fresh);
      if (e8.yesOrNoP(`Delete ${old}`)) e8.deleteDirectory(old, { recursive: true });
    }
  },
});

/** Tags the entry with org-attach-auto-tag, or with OFF untags it, as org-attach-tag; nothing before the first heading. */
function attachTag(off = false): void {
  const tag = e8.variable("org-attach-auto-tag");
  if (typeof tag !== "string" || headingHere() === undefined) return;
  toggleTag(tag, off ? "off" : "on");
}
e8.defun("org-attach-tag", (off?: e8.Value) => attachTag(truthy(off ?? null)));
e8.defun("org-attach-untag", () => attachTag(true));
e8.defun("org-attach-check-absolute-path", (dir?: e8.Value) => (checkAbsolutePath(typeof dir === "string" ? dir : undefined), true));
e8.defun("org-attach-dir-from-id", (id: e8.Value, existing?: e8.Value) => dirFromId(String(id), truthy(existing ?? null)) ?? null);

// ----- Attaching -----

/** Where a file to attach is read from: a Dired window's directory with dired-dwim-target, else the default, as Org asks dired-dwim-target-directory. */
function dwimDirectory(): string {
  if (truthy(e8.variable("dired-dwim-target"))) {
    for (const w of e8.windowList()) {
      if (w === e8.selectedWindow()) continue;
      const b = e8.windowBuffer(w);
      const dir = b && e8.withCurrentBuffer(b, () => (e8.derivedModeP("dired-mode") ? String(e8.variable("default-directory")) : undefined));
      if (dir) return dir;
    }
  }
  return String(e8.variable("default-directory") ?? "");
}

/** Attaches FILE to the entry at point by METHOD, org-attach-method's by default, as org-attach-attach; with visitDir, shows the directory. */
export function attachFile(given: string, visitDir = false, method?: string): void {
  method ??= name(e8.variable("org-attach-method")) ?? "cp";
  // FILE as given, relative to default-directory, as Org passes it on.
  let file = given;
  if (e8.fileDirectoryP(file)) file = e8.directoryFileName(file);
  const source = e8.expandFileName(file);
  const basename = e8.fileNameNondirectory(file);
  const dir = attachDir(true)!;
  const attached = e8.expandFileName(basename, dir);
  switch (method) {
    case "mv":
      e8.renameFile(source, attached);
      break;
    case "cp":
      if (e8.fileDirectoryP(source)) {
        // As copy-directory with COPY-CONTENTS, which makes the directory and so fails where it is.
        if (e8.fileExistsP(attached)) e8.signal("file-already-exists", `File exists: ${attached}`, ["File exists", attached]);
        e8.copyDirectory(source, attached);
      } else e8.copyFile(source, attached);
      break;
    case "ln":
      e8.addNameToFile(source, attached);
      break;
    case "lns":
      // As make-symbolic-link with an integer, which asks before replacing a file there.
      if (e8.fileExistsP(attached) || e8.fileSymlinkP(attached) !== undefined) {
        if (!e8.yesOrNoP(`File ${attached} already exists; make it a link anyway? `))
          e8.signal("file-already-exists", `File already exists: ${attached}`, ["File already exists", attached]);
        e8.makeSymbolicLink(file, attached, true);
      } else e8.makeSymbolicLink(file, attached);
      break;
    case "url":
      e8.userError("E8 cannot download attachments yet");
      break;
  }
  e8.runHooks("org-attach-after-change-hook", dir);
  attachTag();
  const store = name(e8.variable("org-attach-store-link-p"));
  const stored = e8.variable("org-stored-links");
  const links = Array.isArray(stored) ? stored : [];
  if (store === "attached") e8.setVariable("org-stored-links", [[`attachment:${e8.fileNameNondirectory(attached)}`, e8.fileNameNondirectory(attached)], ...links]);
  else if (store === "t") e8.setVariable("org-stored-links", [[`file:${file}`, e8.fileNameNondirectory(file)], ...links]);
  else if (store === "file") e8.setVariable("org-stored-links", [[`file:${attached}`, e8.fileNameNondirectory(attached)], ...links]);
  if (visitDir) e8.call("dired", dir);
  else e8.message(`File ${e8.prin1ToString(basename)} is now an attachment`);
}

const FILE_PARAMS: e8.Param[] = [
  { name: "file", kind: "file", prompt: "File to keep as an attachment: ", initial: () => dwimDirectory() },
  { name: "visit-dir", kind: "prefix" },
];

e8.defineCommand({
  name: "org-attach-attach",
  doc: "Attach a file to the current entry, by org-attach-method: copying, moving or linking it into the entry's attachment directory. With a prefix argument, visit the directory.",
  // METHOD only from code, which passes all three, nil for org-attach-method's, as Org's interactive spec gives nil.
  params: [...FILE_PARAMS, { name: "method", value: () => "" }],
  run: (file: string, visitDir: e8.Value, method?: e8.Value) => {
    const how = typeof method === "string" || typeof method === "symbol" ? name(method) : undefined;
    attachFile(String(file), truthy(visitDir), how === "" || how === "nil" ? undefined : how);
  },
});

for (const [method, how] of [
  ["cp", "copying it"],
  ["mv", "moving (renaming) it"],
  ["ln", "creating a hard link to it"],
  ["lns", "creating a symbolic link to it"],
] as const) {
  e8.defineCommand({
    name: `org-attach-attach-${method}`,
    doc: `Attach a file by ${how}.`,
    run: () => e8.letBind({ "org-attach-method": e8.intern(method) }, () => e8.callInteractively("org-attach-attach" as any)),
  });
}

e8.defineCommand({
  name: "org-attach-url",
  doc: "Attach a file from a URL, downloading it. E8 cannot download attachments yet.",
  params: [{ name: "url", prompt: "URL of the file to attach: " }],
  run: (url: string) => attachFile(String(url), false, "url"),
});

e8.defineCommand({
  name: "org-attach-buffer",
  doc: "Attach a buffer's contents to the current entry, as a file of the buffer's name. Signals file-already-exists if there is one.",
  params: [{ name: "buffer-name", kind: "buffer", prompt: "Buffer whose contents should be attached: " }],
  run: (bufferName: string) => {
    const dir = attachDir(true)!;
    const output = e8.expandFileName(String(bufferName), dir);
    if (e8.fileExistsP(output)) e8.signal("file-already-exists", `File exists: ${output}`, ["File exists", output]);
    e8.runHooks("org-attach-after-change-hook", dir);
    attachTag();
    const text = e8.withCurrentBuffer(String(bufferName), () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
    e8.writeRegion(text, null, output, { quiet: true });
  },
});

e8.defineCommand({
  name: "org-attach-new",
  doc: "Create a new attachment of the current entry, as a buffer visiting it.",
  params: [{ name: "file", prompt: "Create attachment named: " }],
  run: (file: string) => {
    const dir = attachDir(true)!;
    attachTag();
    e8.call("find-file", e8.expandFileName(String(file), dir));
    e8.message(`New attachment ${String(file)}`);
  },
});

/** The files in an attachment directory, those ending in ~ left out, as org-attach-file-list. */
export function fileList(dir: string): string[] {
  return e8.directoryFiles(dir, { match: "[^~]\\'" }).filter((f) => f !== "." && f !== "..");
}
e8.defun("org-attach-file-list", (dir: e8.Value) => {
  if (typeof dir !== "string") e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil", [e8.intern("stringp"), null]);
  return fileList(dir);
});

e8.defineCommand({
  name: "org-attach-delete-one",
  doc: "Delete one of the current entry's attachments, asked for.",
  params: [{ name: "attachment", value: () => "" }],
  run: (given: string) => {
    const dir = attachDir();
    if (dir === undefined) e8.signal("wrong-type-argument", "Wrong type argument: stringp, nil", [e8.intern("stringp"), null]);
    const files = fileList(dir);
    const chosen = typeof given === "string" && given !== "" ? given : e8.completingRead("Delete attachment: ", files.map((f) => e8.fileNameNondirectory(f)));
    const attachment = e8.expandFileName(chosen, dir);
    if (!e8.fileExistsP(attachment)) e8.signal("error", `No such attachment: ${attachment}`);
    e8.deleteFile(attachment);
    e8.runHooks("org-attach-after-change-hook", dir);
  },
});

/** Deletes the entry's attachment directory, asking unless FORCE, as org-attach-delete-all. */
function deleteAll(force: boolean): void {
  const dir = attachDir();
  if (dir === undefined || !(force || e8.yesOrNoP("Really remove all attachments of this entry? "))) return;
  e8.deleteDirectory(dir, { recursive: force || e8.yesOrNoP("Recursive?"), trash: true });
  e8.message("Attachment directory removed");
  e8.runHooks("org-attach-after-change-hook", dir);
  attachTag(true);
}

e8.defineCommand({
  name: "org-attach-delete-all",
  doc: "Delete all of the current entry's attachments, its whole attachment directory, asking first. With a prefix argument, without asking.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.Value) => deleteAll(truthy(force)),
});

e8.defineCommand({
  name: "org-attach-sync",
  doc: "Tag the current entry as having attachments or not, as its directory says, after files were added or removed there by hand; an empty directory is deleted as org-attach-sync-delete-empty-dir says.",
  run: () => {
    const dir = attachDir();
    if (dir === undefined) return attachTag(true);
    e8.runHooks("org-attach-after-change-hook", dir);
    attachTag(fileList(dir).length === 0);
    const del = e8.variable("org-attach-sync-delete-empty-dir");
    if (!truthy(del)) return;
    const empty = e8.directoryFiles(dir).every((f) => f === "." || f === "..");
    if (empty && (name(del) !== "query" || e8.yesOrNoP("Attachment directory is empty.  Delete?"))) e8.deleteDirectory(dir);
  },
});

e8.defineCommand({
  name: "org-attach-reveal",
  doc: "Show the current entry's attachment directory, made, with an ID or DIR property, if need be.",
  run: () => e8.call("find-file", dirGetCreate()),
});

e8.defineCommand({
  name: "org-attach-reveal-in-emacs",
  doc: "Show the current entry's attachment directory in Dired, made, with an ID or DIR property, if need be.",
  run: () => e8.call("dired", dirGetCreate()),
});

/** Opens one of the entry's attachments, asking which if there are several, as org-attach-open. */
function attachOpen(_inEmacs: boolean): void {
  const dir = attachDir();
  if (dir === undefined) e8.signal("error", "No attachment directory exist");
  const files = fileList(dir);
  const file = files.length === 1 ? files[0] : e8.completingRead("Open attachment: ", files, { requireMatch: true });
  const path = e8.expandFileName(file, dir);
  e8.runHooks("org-attach-open-hook", path);
  e8.call("find-file", path);
}

e8.defineCommand({
  name: "org-attach-open",
  doc: "Open an attachment of the current entry, asking which if it has several.",
  params: [{ name: "in-emacs", kind: "prefix" }],
  // IN-EMACS or not, E8 opens it itself, as it opens file links, without org-file-apps.
  run: (inEmacs: e8.Value) => attachOpen(truthy(inEmacs)),
});

e8.defineCommand({
  name: "org-attach-open-in-emacs",
  doc: "Open an attachment of the current entry in E8.",
  run: () => attachOpen(true),
});

e8.defineCommand({
  name: "org-attach--abort",
  doc: "Leave the attachment dispatcher.",
  run: () => e8.message("Abort"),
});

/** FILE in the entry's attachment directory, as org-attach-expand. */
export function attachExpand(file: string): string {
  return e8.expandFileName(file, attachDir());
}
e8.defun("org-attach-expand", (file: string) => attachExpand(String(file)));

/** Makes the buffer's attachment: links file: links, as org-attach-expand-links does before an export parses the buffer. */
function expandLinks(): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    while (e8.reSearchForward("attachment:", { noerror: true }) !== undefined) {
      const link = linkHere();
      if (!link || !/^attachment:/i.test(link.path)) continue;
      const file = link.path.replace(/^attachment:/i, "");
      const fresh = linkMakeString(`file:${attachExpand(file)}`, link.description ?? null);
      e8.deleteRegion(link.start, link.end);
      e8.gotoChar(link.start);
      e8.insert(fresh);
    }
  });
}
e8.defun("org-attach-expand-links", () => expandLinks());

/** Suggests an attachment: link to a file in the entry's attachment directory, as org-attach-complete-link. */
function completeLink(): string {
  const dir = attachDir();
  if (dir === undefined) e8.signal("error", "No attachment directory exist");
  const attached = e8.expandFileName(dir);
  const file = e8.readFileName("File: ", { dir: attached });
  const pwd = e8.fileNameAsDirectory(attached);
  const pwdRelative = e8.fileNameAsDirectory(e8.abbreviateFileName(attached));
  if (file.startsWith(pwdRelative) && file.length > pwdRelative.length) return `attachment:${file.slice(pwdRelative.length)}`;
  const full = e8.expandFileName(file);
  if (full.startsWith(pwd) && full.length > pwd.length) return `attachment:${full.slice(pwd.length)}`;
  return `attachment:${file}`;
}

linkSetParameters("attachment", {
  // As org-link-open-as-file, a search after :: too.
  follow: (path) => openLink({ start: e8.point(), end: e8.point(), path: `file:${attachExpand(path)}`, kind: "bracket" }),
  complete: completeLink,
});

/** Deletes an archived subtree's attachments as org-attach-archive-delete says, as org-attach-archive-delete-maybe. */
function archiveDeleteMaybe(): void {
  const how = e8.variable("org-attach-archive-delete");
  if (truthy(how)) deleteAll(name(how) !== "query");
}
e8.defun("org-attach-archive-delete-maybe", () => archiveDeleteMaybe());
e8.addHook("org-archive-hook", "org-attach-archive-delete-maybe");
// Before an export parses the buffer, as Org adds it to org-export-before-parsing-functions, which ox.ts defines when it loads.
{
  const v = e8.variable("org-export-before-parsing-functions");
  const list = Array.isArray(v) ? v : [];
  if (!list.includes("org-attach-expand-links")) e8.setVariable("org-export-before-parsing-functions", [...list, "org-attach-expand-links"]);
}

e8.defineCommand({
  name: "org-attach-dired-to-subtree",
  doc: "Attach the marked files of Dired, or the one at point, to the entry at point in a window showing an Org buffer, by org-attach-method.",
  // FILES from code, or Dired's marked files, as its interactive spec reads them.
  params: [{ name: "files", value: () => "" }],
  run: (given: e8.Value) => {
    if (!Array.isArray(given) && !e8.derivedModeP("dired-mode")) e8.userError("This command must be triggered in a `dired' buffer");
    const files = Array.isArray(given) ? given.map(String) : markedFiles(null).files;
    const start = e8.selectedWindow();
    const other = e8.windowList().find((w) => {
      const b = e8.windowBuffer(w);
      return b !== undefined && e8.withCurrentBuffer(b, () => e8.variable("major-mode") === "org-mode");
    });
    if (!other) e8.userError("Can't attach to subtree.  No window displaying an Org buffer");
    e8.selectWindow(other);
    for (const f of files) attachFile(f);
    e8.selectWindow(start);
    if (name(e8.variable("org-attach-method")) === "mv") e8.call("revert-buffer");
  },
});

// ----- The dispatcher -----

/** The dispatcher's text: the directory, and each command's first key and what it does, as org-attach's splash buffer. */
function splash(dir: string | undefined, commands: e8.Value[][]): string {
  const lines = commands.map((entry) => {
    const keys = entry[0];
    const key = Array.isArray(keys) ? String(keys[0]) : undefined;
    if (key === undefined || typeof entry[2] !== "string") e8.userError(`Invalid \`org-attach-commands' item: ${e8.prin1ToString(entry as e8.Value)}`);
    return `${key}       ${String(entry[2]).replace(/\n[\t ]*/g, "\n        ")}`;
  });
  return (
    `Attachment folder:\n${dir ?? "Can't find an existing attachment-folder"}${dir !== undefined && e8.fileDirectoryP(dir) ? "" : "\n(Not yet created)"}\n\n` +
    `Select an Attachment Command:\n\n${lines.join("\n")}`
  );
}

e8.defineCommand({
  name: "org-attach",
  doc: "The dispatcher for attachment commands: show them, and run the one whose key is typed next.",
  // Point comes back after the command, as org-with-point-at saves it.
  run: () => e8.saveExcursion(() => dispatch()),
});

/** Shows the commands, reads a key and runs its command, at the entry's heading, as org-attach. */
function dispatch(): void {
  {
    const commands = ((e8.variable("org-attach-commands") as e8.Value[][] | null) ?? []).filter(Array.isArray);
    const dir = attachDir(false, true);
    // At the entry's heading, or the buffer's start before the first, as org-back-to-heading-or-point-min.
    const here = headingHere();
    e8.gotoChar(here ? here.all[here.i].start : e8.pointMin());
    let c = "";
    e8.saveExcursion(() =>
      e8.saveWindowExcursion(() => {
        const buffer = "*Org Attach*";
        if (!truthy(e8.variable("org-attach-expert"))) {
          e8.call("switch-to-buffer-other-window", buffer);
          eraseBuffer();
          e8.setVariable("cursor-type", null);
          e8.setVariable("header-line-format", "Use C-v, M-v, C-n or C-p to navigate.");
          e8.insert(splash(dir, commands));
          e8.gotoChar(e8.pointMin());
        }
        try {
          e8.message(`Select command: [${commands.map((e) => String((e[0] as e8.Value[])[0])).join("")}]`);
          // C-n, C-p and C-v scroll the list, as org-scroll does.
          const scroll: Record<string, string> = { "\u000e": "scroll-up-line", "\u0010": "scroll-down-line", "\u0016": "scroll-up-command" };
          // The list's window is the selected one, as switch-to-buffer-other-window leaves it.
          for (c = e8.readCharExclusive(); scroll[c] !== undefined; c = e8.readCharExclusive())
            e8.conditionCase(() => e8.call(scroll[c] as any), { error: () => undefined });
        } finally {
          const w = e8.getBuffer(buffer) ? getBufferWindowList(buffer, false, true)[0] : undefined;
          if (w) quitWindow(true, w);
          if (e8.getBuffer(buffer)) e8.call("kill-buffer", buffer);
        }
      }),
    );
    const command = commands.find((e) => Array.isArray(e[0]) && (e[0] as e8.Value[]).includes(c))?.[1];
    if (typeof command === "string" && e8.commandp(command)) e8.callInteractively(command as any);
    else if (typeof command === "function") (command as () => void)();
    else e8.signal("error", `No such attachment command: ${c}`);
  }
}
