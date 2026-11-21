// Global identifiers for Org entries, after Emacs's org-id.el: an entry's
// ID property, made with org-id-get-create as org-id-method says, which
// [[id:...]] links follow to the entry, in whatever file has it.
//
// As org-id.el, where each ID is is kept, by file, in org-id-locations,
// saved in org-id-locations-file when E8 exits and read back the first
// time it is wanted. An ID not found where that says has the agenda files,
// org-id-extra-files, the files known to have IDs and the Org files open
// scanned again, as org-id-update-id-locations does. A package such as
// org-roam, which knows every ID of its directory, advises org-id-find to
// answer first, as org-roam-id.el does.

import { headings, headingIndex, linkSetParameters, markRingPush } from "org";
import { elementAt } from "org-element";
import { entryGet, entryPut, topGet } from "org-list";
import { fileRelativeName, findBufferVisiting } from "files";
import { showContext } from "ol";
import { truthy } from "subr";

e8.defineVariable({
  name: "org-id-track-globally",
  doc: "Whether IDs are tracked through files, so that links work globally, in org-id-locations, saved in org-id-locations-file when E8 exits.",
  value: true,
});
e8.defineVariable({
  name: "org-id-locations-file",
  doc: "The file for remembering in which file an ID was defined, or nil for .org-id-locations in user-emacs-directory.",
  value: null,
});
e8.defineVariable({
  name: "org-id-locations-file-relative",
  doc: "Whether the files in org-id-locations-file are written relative to its directory, for folders shared across systems but mounted at different roots.",
  value: false,
});
e8.defineVariable({ name: "org-id-files", doc: "List of files that contain IDs.", value: [] });
e8.defineVariable({
  name: "org-id-extra-files",
  doc: "Files to be searched for IDs, besides the agenda files, or the name of a variable that holds them.",
  value: "org-agenda-text-search-extra-files",
});
e8.defineVariable({
  name: "org-id-method",
  doc:
    "How new IDs are made: uuid (or uuidgen) for a random UUID, org for the time in base 36, reversed, " +
    "ts for the time as org-id-ts-format writes it; org and ts add @ and the machine's name with org-id-include-domain.",
  value: "uuid",
});
e8.defineVariable({ name: "org-id-prefix", doc: "The prefix of new IDs, before a colon, or nil for none.", value: null });
e8.defineVariable({ name: "org-id-ts-format", doc: "How org-id-method ts writes the time, as format-time-string.", value: "%Y%m%dT%H%M%S.%6N" });
e8.defineVariable({ name: "org-id-include-domain", doc: "Whether IDs made by the org and ts methods end in @ and the machine's name.", value: false });
e8.defineVariable({
  name: "org-id-overriding-file-name",
  doc: "The file name org-id-get records a new ID under instead of the buffer's, for contents in a temporary buffer.",
  value: null,
});

/** A new identifier, a random UUID as org-id-uuid makes one. */
export function orgIdUuid(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
e8.defun("org-id-uuid", orgIdUuid);

/** The time in base 36, four digits for each of current-time's high and low seconds and microseconds, as org-id-time-to-b36. */
function timeToB36(): string {
  const now = e8.currentTime();
  const seconds = Math.floor(now);
  const usec = Math.floor((now - seconds) * 1e6);
  return [Math.floor(seconds / 65536), seconds % 65536, usec].map((n) => n.toString(36).padStart(4, "0")).join("");
}

/**
 * A new globally unique ID, as org-id-new: the prefix, org-id-prefix's
 * unless given ("none" for none), and a colon, then the part
 * org-id-method makes.
 */
export function orgIdNew(prefix?: string): string {
  const own = e8.variable("org-id-prefix");
  let head = prefix === "none" ? "" : `${prefix ?? (typeof own === "string" ? own : "")}:`;
  if (head === ":") head = "";
  const method = String(e8.variable("org-id-method"));
  const domain = () => (truthy(e8.variable("org-id-include-domain")) ? `@${e8.systemName()}` : "");
  let unique = "";
  if (method === "uuid" || method === "uuidgen") unique = orgIdUuid();
  else if (method === "org") unique = [...timeToB36()].reverse().join("") + domain();
  else if (method === "ts") unique = e8.formatTimeString(String(e8.variable("org-id-ts-format"))) + domain();
  else e8.signal("error", "Invalid ‘org-id-method’");
  return head + unique;
}
e8.defun("org-id-new", (prefix?: string | null) => orgIdNew(prefix ?? undefined));

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

/** Puts an ID on the entry at point, or the file before its first heading, as org-entry-put does there. */
function putId(id: string): void {
  const line = entryLine();
  if (line !== undefined) return e8.saveExcursion(() => entryPut(line, "ID", id));
  const drawer = fileLevelDrawer();
  e8.saveExcursion(() => {
    // As org-entry-put on org-data: an ID line already there, as ":ID: nil", is replaced.
    if (drawer) entryPut(drawer.start - 1, "ID", id);
    else {
      // After blank lines and comments, as org-get-property-block makes org-data's.
      let line = 0;
      while (line < e8.lineCount() && /^[ \t]*$/.test(e8.lineText(line))) line++;
      while (line < e8.lineCount() && /^[ \t]*#(?: |$)/.test(e8.lineText(line))) line++;
      e8.gotoChar(line < e8.lineCount() ? e8.lineStart(line) : e8.pointMax());
      e8.insert(`:PROPERTIES:\n:ID:       ${id}\n:END:\n`);
    }
  });
}

/** The file of the current buffer, or of the buffer an indirect one shares its text with, as buffer-file-name of buffer-base-buffer. */
function baseFileName(): string | undefined {
  const base = e8.bufferBaseBuffer();
  return base ? e8.withCurrentBuffer(base, () => e8.bufferFileName()) : e8.bufferFileName();
}

/**
 * The ID of the entry at point, or of the file before its first heading,
 * as org-id-get: with CREATE, one is made if it has none, by org-id-new
 * with PREFIX, and its file is recorded in org-id-locations.
 */
export function orgIdGet(create = false, prefix?: string): string | undefined {
  const line = entryLine();
  const id = line !== undefined ? entryGet(line, "ID") : topGet("ID");
  if (id !== undefined && /\S/.test(id)) return id;
  if (!create) return undefined;
  const fresh = orgIdNew(prefix);
  putId(fresh);
  const overriding = e8.variable("org-id-overriding-file-name");
  addLocation(fresh, typeof overriding === "string" ? overriding : baseFileName());
  return fresh;
}

e8.defun("org-id-get", (epom?: e8.Value, create?: e8.Value, prefix?: e8.Value) => {
  const get = () => orgIdGet(truthy(create ?? null), typeof prefix === "string" ? prefix : undefined);
  return typeof epom === "number" ? e8.saveExcursion(() => (e8.gotoChar(epom), get())) : get();
});

e8.defineCommand({
  name: "org-id-get-create",
  doc: "Create an ID for the current entry and return it. If the entry already has an ID, just return it. With a prefix argument, force the creation of a new ID.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.Value) => {
    // As org-entry-put with nil: the ID is emptied, so a new one is made.
    if (force !== null && force !== undefined) putId("");
    orgIdGet(true);
  },
});

e8.defineCommand({
  name: "org-id-copy",
  doc: "Copy the ID of the entry at point to the kill ring. Create an ID if necessary.",
  run: () => {
    e8.killNew(orgIdGet(true)!);
  },
});

// Where IDs are, as org-id-locations.

/** Each ID's file, abbreviated, as the hash table org-id-locations is once loaded; undefined until then. */
let locations: Map<string, string> | undefined;
/** The files scanned last, with when each changed, as org-id--locations-checksum. */
let checksum: string = JSON.stringify([]);

/** The file org-id-locations is kept in: org-id-locations-file, or .org-id-locations in user-emacs-directory. */
function locationsFile(): string {
  const own = e8.variable("org-id-locations-file");
  if (typeof own === "string" && own !== "") return e8.expandFileName(own);
  const dir = e8.variable("user-emacs-directory");
  return e8.expandFileName(".org-id-locations", typeof dir === "string" ? dir : "~/");
}

const tracking = (): boolean => truthy(e8.variable("org-id-track-globally"));
const idFiles = (): string[] => {
  const v = e8.variable("org-id-files");
  return Array.isArray(v) ? v.filter((f): f is string => typeof f === "string") : [];
};

/** Each ID's file as a list of files and their IDs, to write, as org-id-hash-to-alist orders it. */
function hashToAlist(hash: Map<string, string>): string[][] {
  const res: string[][] = [];
  for (const [id, file] of hash) {
    const x = res.find((r) => r[0] === file);
    if (x) x.splice(1, 0, id);
    else res.unshift([file, id]);
  }
  return res;
}

/** The IDs of a list of files and their IDs, each with its file, as org-id-alist-to-hash. */
function alistToHash(alist: string[][]): Map<string, string> {
  const hash = new Map<string, string>();
  for (const [file, ...ids] of alist) for (const id of ids) hash.set(id, file);
  return hash;
}

/** Saves org-id-locations in org-id-locations-file, as org-id-locations-save, in Emacs's form. */
export function locationsSave(): void {
  if (!tracking() || locations === undefined) return;
  writeLocations(hashToAlist(locations));
}
e8.defun("org-id-locations-save", locationsSave);

function writeLocations(alist: string[][]): void {
  const file = locationsFile();
  let out = alist;
  if (truthy(e8.variable("org-id-locations-file-relative")) && out.length > 0) {
    const dir = e8.fileNameDirectory(file) ?? "/";
    out = out.map(([f, ...ids]) => (e8.fileNameAbsoluteP(f) ? [relativeName(f, dir), ...ids] : [f, ...ids]));
  }
  // As print: the list on a line of its own.
  e8.writeTextFile(file, `\n${e8.prin1ToString(out.length === 0 ? null : out)}\n`);
}

/** FILE relative to DIR, as file-relative-name. */
function relativeName(file: string, dir: string): string {
  return fileRelativeName(e8.expandFileName(file), dir);
}

/** Reads org-id-locations from org-id-locations-file, as org-id-locations-load. */
export function locationsLoad(): void {
  locations = new Map();
  if (!tracking()) return;
  const file = locationsFile();
  let alist: string[][] = [];
  try {
    const data = e8.readFromString(e8.readTextFile(file))[0];
    const dir = e8.fileNameDirectory(file) ?? "/";
    if (Array.isArray(data)) {
      alist = data
        .filter((x): x is e8.Value[] => Array.isArray(x) && typeof x[0] === "string")
        .map(([f, ...ids]) => [
          e8.fileNameAbsoluteP(f as string) ? (f as string) : e8.expandFileName(f as string, dir),
          ...ids.filter((i): i is string => typeof i === "string"),
        ]);
    }
  } catch {
    e8.message(`Could not read ‘org-id-locations’ from ${file}, setting it to nil`);
    alist = [];
  }
  e8.setVariable("org-id-files", alist.map((x) => x[0]));
  locations = alistToHash(alist);
}
e8.defun("org-id-locations-load", locationsLoad);

/** Records that ID is in FILE, as org-id-add-location. */
export function addLocation(id: string, file: string | undefined): void {
  // Emacs signals "‘org-id-get’ expects a file-visiting buffer" here; E8
  // leaves the ID made but unrecorded, as packages' buffers with no file
  // (org-roam's tests among them) make IDs.
  if (!file) return;
  const afile = e8.abbreviateFileName(file);
  if (!tracking() || !id) return;
  if (locations === undefined) locationsLoad();
  locations!.set(id, afile);
  if (!idFiles().includes(afile)) e8.setVariable("org-id-files", [afile, ...idFiles()]);
}
e8.defun("org-id-add-location", (id: string, file: string) => addLocation(id, file));

/** The agenda files, expanded in org-directory, as org-agenda-files gives them. */
function agendaFiles(): string[] {
  const files = e8.variable("org-agenda-files");
  if (!Array.isArray(files)) return [];
  const dir = e8.variable("org-directory");
  return files
    .filter((f): f is string => typeof f === "string")
    .map((f) => e8.expandFileName(f, typeof dir === "string" ? e8.expandFileName(dir) : undefined));
}

/** org-id-extra-files: a list of files, or a variable's name whose value is one. */
function extraFiles(): string[] {
  let v = e8.variable("org-id-extra-files");
  if (typeof v === "string") v = e8.boundp(v) ? e8.variable(v) : null;
  return Array.isArray(v) ? v.filter((f): f is string => typeof f === "string") : [];
}

/** The files of the Org buffers open. */
function openOrgFiles(): string[] {
  const files: string[] = [];
  for (const b of e8.bufferList()) {
    const f = e8.withCurrentBuffer(b, () => (e8.derivedModeP("org-mode") ? e8.bufferFileName() : undefined));
    if (f) files.push(f);
  }
  return files;
}

/** A buffer in Org mode to read files into, as with-temp-buffer and org-mode, and to throw away after. */
function withOrgTempBuffer<T>(body: () => T): T {
  const buffer = e8.getBufferCreate(e8.generateNewBufferName(" *temp*"));
  try {
    return e8.withCurrentBuffer(buffer, () => {
      // As delay-mode-hooks: Org mode's parser, without what hooks would turn on.
      const hooks = ["org-mode-hook", "outline-mode-hook", "text-mode-hook", "after-change-major-mode-hook", "change-major-mode-after-body-hook"];
      e8.letBind(Object.fromEntries(hooks.map((h) => [h, null])), () => e8.call("org-mode"));
      return body();
    });
  } finally {
    e8.call("kill-buffer", e8.bufferName(buffer)!);
  }
}

/** The IDs in the current buffer, as node properties, last first, as org-id-update-id-locations finds them. */
function bufferIds(): string[] {
  const ids: string[] = [];
  for (const [line, , text] of e8.matchingLines("^[ \t]*:ID: +[^ ]", { caseFold: true })) {
    if (elementAt(e8.lineStart(line))?.type !== "node-property") continue;
    const m = /^[ \t]*:ID:(?:[ \t]+(.*?))?[ \t]*$/i.exec(text);
    if (m) ids.unshift(m[1] ?? "");
  }
  return ids;
}

/**
 * Scans the agenda files, org-id-extra-files, the files known to have IDs,
 * the Org files open and FILES for IDs, as org-id-update-id-locations,
 * unless none of them has changed since it last did.
 */
export function updateIdLocations(files: string[] = [], silent = false): void {
  if (!tracking()) e8.signal("error", "Please turn on ‘org-id-track-globally’ if you want to track IDs");
  const all = [
    ...new Set([...agendaFiles(), ...extraFiles(), ...idFiles(), ...openOrgFiles(), ...files].map((f) => e8.fileTruename(e8.expandFileName(f)))),
  ];
  const sum = JSON.stringify([...all].sort().map((f) => (e8.fileExists(f) ? [f, e8.fileAttributes(f)?.modified ?? null] : null)));
  if (sum === checksum) return;
  const alist: string[][] = [];
  const seen = new Set<string>();
  let ndup = 0;
  let i = 0;
  withOrgTempBuffer(() => {
    for (const file of all) {
      if (!e8.fileExists(file)) continue;
      if (!silent) e8.message(`Finding ID locations (${++i}/${all.length} files): ${file}`);
      e8.insertFileContents(file, { replace: true });
      const ids = bufferIds();
      if (ids.length === 0) continue;
      alist.unshift([e8.abbreviateFileName(file), ...ids]);
      for (const id of ids) {
        if (!seen.has(id)) seen.add(id);
        else if (!silent) {
          e8.message(`Duplicate ID "${id}"`);
          ndup++;
        }
      }
    }
  });
  e8.setVariable("org-id-files", alist.map((x) => x[0]));
  if (alist.length > 0) writeLocations(alist);
  locations = alistToHash(alist);
  checksum = sum;
  if (!silent && ndup > 0) e8.message(`WARNING: ${ndup} duplicate IDs found, check *Messages* buffer`);
  e8.message(`${all.length} files scanned, ${idFiles().length} files contains IDs, and ${locations.size} IDs found.`);
}

e8.defineCommand({
  name: "org-id-update-id-locations",
  doc:
    "Scan relevant files for IDs. Store the relation between files and corresponding IDs. This will scan all agenda files, " +
    "org-id-extra-files, all open Org files, and all files currently mentioned in org-id-locations.",
  run: () => updateIdLocations(),
});

/** The file org-id-locations says ID is in, else the current buffer's, as org-id-find-id-file. */
export function findIdFile(id: string): string | undefined {
  if (locations === undefined) locationsLoad();
  return locations!.get(id) ?? baseFileName();
}
e8.defun("org-id-find-id-file", (id: string) => findIdFile(id));

/** Where the entry with ID starts in the current buffer, widened, or the top for a file's own, as org-find-entry-with-id. */
function findEntryWithId(id: string): number | undefined {
  return e8.saveRestriction(() => {
    e8.widen();
    const quoted = id.replace(/[[\]*.\\^$+?]/g, "\\$&");
    for (const [line] of e8.matchingLines(`^[ \t]*:ID:[ \t]+${quoted}[ \t]*$`, { caseFold: true })) {
      if (elementAt(e8.lineStart(line))?.type !== "node-property") continue;
      const all = headings();
      const i = headingIndex(all, line);
      return i === undefined ? e8.pointMin() : e8.lineStart(all[i].line);
    }
    return undefined;
  });
}

/** ID's entry in FILE, as its name and position, as org-id-find-id-in-file: in the buffer visiting it, else read afresh. */
export function findIdInFile(id: string, file: string | undefined): [string, number] | undefined {
  if (!file || !e8.fileExists(e8.expandFileName(file))) return undefined;
  const visiting = findBufferVisiting(e8.expandFileName(file));
  const pos = visiting
    ? e8.withCurrentBuffer(visiting, () => {
        if (!e8.derivedModeP("org-mode")) e8.call("org-mode");
        return findEntryWithId(id);
      })
    : withOrgTempBuffer(() => {
        e8.insertFileContents(e8.expandFileName(file), { replace: true });
        return findEntryWithId(id);
      });
  return pos === undefined ? undefined : [file, pos];
}
e8.defun("org-id-find-id-in-file", (id: string, file: string) => findIdInFile(id, file));

/** Where an ID's entry is: its file and position, as org-id-find; a package advises it to know more IDs. */
export function orgIdFind(id: string): [string, number] | undefined {
  return e8.funcall("org-id-find", id) as [string, number] | undefined;
}

e8.defun("org-id-find", (id: string) => {
  let where = findIdInFile(id, findIdFile(id));
  if (!where) {
    // Not where it was: the files are scanned again, quietly, and asked once more.
    updateIdLocations([], true);
    where = findIdInFile(id, findIdFile(id));
  }
  return where;
});

/** Goes to an ID's entry, as org-id-goto and following an id: link do. */
export function orgIdGoto(id: string): void {
  const found = orgIdFind(id);
  if (!found) e8.signal("error", `Cannot find entry with ID "${id}"`);
  const [file, pos] = found!;
  // The buffer visiting it, by its true name too, else the file visited.
  const target = e8.expandFileName(file);
  const buffer = findBufferVisiting(target);
  if (buffer !== undefined) {
    if (buffer !== e8.bufferName(e8.currentBuffer())) e8.call("switch-to-buffer", buffer);
  } else e8.call("find-file", target);
  e8.gotoChar(pos);
  // At the entry's start, as org-id-find gives it; a package's answer may be a line inside it.
  const line = entryLine();
  e8.gotoChar(line !== undefined ? e8.lineStart(line) : e8.pointMin());
  showContext(e8.point());
}

e8.defineCommand({
  name: "org-id-goto",
  doc: "Switch to the buffer containing the entry with id ID. Move the cursor to that entry in that buffer.",
  params: [{ name: "id", prompt: "ID: " }],
  run: (id: string) => orgIdGoto(id),
});

// Org's mark ring remembers where point was, as org-id-open pushes it.
linkSetParameters("id", {
  follow: (path) => {
    markRingPush();
    orgIdGoto(path.replace(/::.*$/, ""));
  },
});

// Saved when E8 exits, as org-id.el adds org-id-locations-save to kill-emacs-hook unless in batch.
if (!truthy(e8.variable("noninteractive"))) e8.addHook("kill-emacs-hook", () => locationsSave());
