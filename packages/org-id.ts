// Global identifiers for Org entries, after Emacs's org-id.el: an entry's
// ID property, made with org-id-get-create, which [[id:...]] links follow
// to the entry, in whatever file has it.
//
// org-id.el keeps where each ID is in org-id-locations-file; E8 looks in
// the Org buffers open, the agenda files and org-id-extra-files, and a
// package such as org-roam, which knows every ID of its directory, advises
// org-id-find to answer first, as org-roam-id.el does.

import { headings, headingIndex, linkSetParameters } from "org";
import { entryGet, entryPut, topGet } from "org-list";

e8.defineVariable({ name: "org-id-extra-files", doc: "Files besides the agenda files that org-id-find looks in for IDs.", value: [] });

/** A new identifier, a random UUID as org-id-uuid makes one. */
export function orgIdUuid(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
e8.defun("org-id-uuid", orgIdUuid);

/** The heading line the entry at point starts on, or undefined before the first heading. */
function entryLine(): number | undefined {
  const all = headings();
  const i = headingIndex(all, e8.lineOf(e8.point()));
  return i === undefined ? undefined : all[i].line;
}

/** The ID of the file-level property drawer at the top of the buffer, before any heading, as org-roam's file nodes keep it. */
function fileLevelDrawer(): { start: number; end: number } | undefined {
  // Where org-data's drawer is: after blank lines, then comment lines.
  let line = 0;
  while (line < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(line))) line++;
  while (line < e8.lineCount() && /^[ \t]*#(?: |$)/.test(e8.lineText(line))) line++;
  if (line >= e8.lineCount() || !/^[ \t]*:PROPERTIES:[ \t]*$/i.test(e8.lineText(line))) return undefined;
  for (let l = line + 1; l < e8.lineCount(); l++) {
    if (/^[ \t]*:END:[ \t]*$/i.test(e8.lineText(l))) return { start: line, end: l };
    if (!/^[ \t]*:\S+:/.test(e8.lineText(l))) return undefined;
  }
  return undefined;
}

/** The ID of the entry at point, or of the file before its first heading, making one if CREATE, as org-id-get. */
export function orgIdGet(create = false): string | undefined {
  const line = entryLine();
  if (line !== undefined) {
    const id = entryGet(line, "ID");
    if (id || !create) return id || undefined;
    const fresh = orgIdUuid();
    e8.saveExcursion(() => entryPut(line, "ID", fresh));
    return fresh;
  }
  const drawer = fileLevelDrawer();
  const id = topGet("ID");
  if (id || !create) return id || undefined;
  const fresh = orgIdUuid();
  e8.saveExcursion(() => {
    // As org-entry-put on org-data: an ID line already there, as ":ID: nil", is replaced.
    if (drawer) entryPut(drawer.start - 1, "ID", fresh);
    else {
      e8.gotoChar(0);
      e8.insert(`:PROPERTIES:\n:ID:       ${fresh}\n:END:\n`);
    }
  });
  return fresh;
}

e8.defineCommand({
  name: "org-id-get-create",
  doc: "Make an ID for the entry at point, or the file before its first heading, if it has none, and copy it to the kill ring.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.Value) => {
    if (force !== null && force !== undefined) {
      const line = entryLine();
      if (line !== undefined) e8.saveExcursion(() => entryPut(line, "ID", orgIdUuid()));
    }
    const id = orgIdGet(true)!;
    e8.message(id);
  },
});

e8.defineCommand({
  name: "org-id-copy",
  doc: "Copy the ID of the entry at point, making one if there is none, to the kill ring.",
  run: () => {
    const id = orgIdGet(true)!;
    e8.killNew(id);
    e8.message(id);
  },
});

/** Where an ID's entry is: its file and position, as org-id-find; a package advises it to know more IDs. */
export function orgIdFind(id: string): [string, number] | undefined {
  return e8.funcall("org-id-find", id) as [string, number] | undefined;
}

/** The files org-id looks in: the Org buffers' files, the agenda files and org-id-extra-files. */
function idFiles(): string[] {
  const files = new Set<string>();
  for (const b of e8.bufferList()) {
    const f = e8.withCurrentBuffer(b, () => (e8.variable("major-mode") === "org-mode" ? e8.bufferFileName() : undefined));
    if (f) files.add(e8.expandFileName(f));
  }
  for (const v of ["org-agenda-files", "org-id-extra-files"]) {
    const list = e8.variable(v);
    if (Array.isArray(list)) for (const f of list) if (typeof f === "string" && e8.fileExists(e8.expandFileName(f))) files.add(e8.expandFileName(f));
  }
  return [...files];
}

e8.defun("org-id-find", (id: string) => {
  const re = new RegExp(`^[ \\t]*:ID:[ \\t]+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "im");
  for (const file of idFiles()) {
    const open = e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === file);
    const text = open ? e8.withCurrentBuffer(open, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax())) : e8.readTextFile(file);
    const m = re.exec(text);
    if (m) return [file, [...text.slice(0, m.index)].length];
  }
  return undefined;
});

/** Goes to an ID's entry, as org-id-goto and following an id: link do. */
export function orgIdGoto(id: string): void {
  const found = orgIdFind(id);
  if (!found) e8.userError(`Cannot find entry with ID "${id}"`);
  const [file, pos] = found!;
  if (e8.bufferFileName() !== file) e8.call("find-file", file);
  e8.gotoChar(pos);
  // To the entry's heading, or the top for a file's ID.
  const line = entryLine();
  e8.gotoChar(line !== undefined ? e8.lineStart(line) : 0);
}

e8.defineCommand({
  name: "org-id-goto",
  doc: "Go to the entry with an ID read.",
  params: [{ name: "id", prompt: "ID: " }],
  run: (id: string) => orgIdGoto(id),
});

linkSetParameters("id", { follow: (path) => orgIdGoto(path.replace(/::.*$/, "")) });
