// Dired, after Emacs's dired.el and dired-aux.el, with the listing drawn as
// Emacs's ls-lisp.el draws it. C-x d lists a directory, one file a line;
// RET visits the file on a line, ^ goes up, and m, d, u and t mark files for
// the commands that act on them: C copies, R renames or moves, D deletes, x
// deletes the files flagged with d, and + makes a directory. g lists the
// directory again, keeping the marks. Deleting goes to the trash, as
// delete-by-moving-to-trash says.

import { defineGuide } from "help-guide";

// Faces.

e8.defineFace({ name: "dired-header", doc: "The directory's name at the top of a listing.", attributes: { inherit: "font-lock-type-face" } });
e8.defineFace({ name: "dired-directory", doc: "The names of directories in a listing.", attributes: { inherit: "font-lock-function-name-face" } });
e8.defineFace({ name: "dired-symlink", doc: "The names of symbolic links in a listing.", attributes: { inherit: "font-lock-keyword-face" } });
e8.defineFace({ name: "dired-mark", doc: "The mark at the start of a marked line.", attributes: { inherit: "font-lock-constant-face" } });
e8.defineFace({ name: "dired-marked", doc: "The names of marked files.", attributes: { inherit: "warning" } });
e8.defineFace({ name: "dired-flagged", doc: "The names of files flagged for deletion.", attributes: { inherit: "error" } });
e8.defineFace({ name: "dired-ignored", doc: "Files of little interest, such as backups.", attributes: { inherit: "shadow" } });

// Variables.

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("dired-listing-switches", "-al", "How Dired lists a directory, as ls's switches: a lists dot files, A all but . and .., t sorts by time, S by size, r reverses, and h writes sizes as 1.2k.");
defvar("dired-recursive-deletes", "top", "Whether deleting a directory with files in it asks: top asks once for each, always never asks, and nil refuses.");
defvar("dired-recursive-copies", "top", "Whether copying a directory copies what it holds: top or always do, and nil refuses.");
defvar("dired-dwim-target", false, "Whether copying and renaming suggest the directory of a Dired buffer in another window.");
defvar("dired-keep-marker-copy", "C", "The mark copies get, or true for the mark the file had, or nil for none.");
defvar("dired-keep-marker-rename", true, "Whether renamed files keep their marks, or a mark they get instead.");
defvar("dired-copy-preserve-time", true, "Whether a copy keeps the modification time of what it copies.");
defvar("dired-trivial-filenames", "\\`\\.\\.?\\'\\|\\`\\.?#", "Names Dired passes over when it puts point on the first file, as a regular expression: . and .., and auto-save and lock files.");
defvar("dired-kill-when-opening-new-dired-buffer", false, "Whether visiting a directory from Dired kills the Dired buffer it came from.");
defvar("dired-auto-revert-buffer", false, "Whether going back to a Dired buffer lists its directory again.");
defvar("dired-directory", null, "The directory a Dired buffer lists.");
defvar("dired-actual-switches", null, "The switches this Dired buffer lists with, which s changes.");

e8.defineHook("dired-after-readin-hook", "Functions called after a Dired buffer lists its directory, in that buffer.");

export const MARKER = "*";
export const DEL_MARKER = "D";

export const on = (name: string): boolean => {
  const v = e8.variable(name);
  return v !== null && v !== false && v !== undefined;
};

// The listing, as ls-lisp formats it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as ls writes it: Oct 29 11:53 within the last six months, else Oct 29  2025. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, " ");
  const age = Date.now() - ms;
  if (age >= 0 && age < 15778476000) {
    return `${MONTHS[d.getMonth()]} ${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${MONTHS[d.getMonth()]} ${day}  ${d.getFullYear()}`;
}

/** A size as ls -h writes it, as Emacs's file-size-human-readable. */
function humanSize(size: number): string {
  const units = ["", "k", "M", "G", "T", "P"];
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? String(n) : n >= 10 ? `${Math.round(n)}${units[i]}` : `${n.toFixed(1).replace(/\.0$/, "")}${units[i]}`;
}

export function switchesOf(): string {
  const own = e8.variable("dired-actual-switches");
  if (typeof own === "string") return own;
  return String(e8.variable("dired-listing-switches") ?? "-al");
}

/** The lines listing a directory, as ls-lisp-insert-directory makes them for ls -l with these switches. */
export function listing(dir: string, switches: string, only?: string[]): string[] {
  const flags = new Set(switches.replace(/--\S+/g, "").replace(/[\s-]/g, ""));
  let names = only ?? e8.directoryFiles(dir);
  if (only === undefined) {
    if (flags.has("A")) names = names.filter((n) => n !== "." && n !== "..");
    else if (!flags.has("a")) names = names.filter((n) => !n.startsWith("."));
  }
  const entries = names
    .map((name) => ({ name, attrs: e8.fileAttributes(dir + name) }))
    .filter((e): e is { name: string; attrs: e8.FileAttributes } => e.attrs !== undefined);
  if (flags.has("t")) entries.sort((a, b) => b.attrs.modified - a.attrs.modified);
  else if (flags.has("S")) entries.sort((a, b) => b.attrs.size - a.attrs.size);
  if (flags.has("r")) entries.reverse();
  const human = flags.has("h");
  const sizeOf = (e: { attrs: e8.FileAttributes }) => (human ? humanSize(e.attrs.size) : String(e.attrs.size));
  const userWidth = Math.max(0, ...entries.map((e) => e.attrs.user.length));
  const groupWidth = Math.max(0, ...entries.map((e) => e.attrs.group.length));
  const sizeWidth = Math.max(0, ...entries.map((e) => sizeOf(e).length));
  return entries.map((e) => {
    const a = e.attrs;
    const link = a.type === "symlink" && a.linkTarget !== null ? ` -> ${a.linkTarget}` : "";
    const group = flags.has("G") ? "" : ` ${a.group.padEnd(groupWidth)}`;
    return `${a.modes}${String(a.links).padStart(3)} ${a.user.padEnd(userWidth)}${group} ${sizeOf(e).padStart(sizeWidth)} ${formatTime(a.modified)} ${e.name}${link}`;
  });
}

// Lines, as dired.el finds its way around them.

/** A file line: two columns for the mark, the details, then the name. */
const LINE = /^(.)\s([-dlbcps][-rwxsStT]{9}[@+.]?\s*\d+ .*? (?:[A-Z][a-z]{2} [ \d]\d (?:\d\d:\d\d| \d{4}))) (.*)$/;

export interface FileLine {
  mark: string;
  /** Where the name starts, in the buffer. */
  start: number;
  name: string;
  isDir: boolean;
  isLink: boolean;
}

export function fileLine(line: number): FileLine | undefined {
  if (line < 0 || line >= e8.lineCount()) return undefined;
  const text = e8.lineText(line);
  const m = LINE.exec(text);
  if (!m) return undefined;
  const isLink = m[2].startsWith("l");
  const shown = m[3];
  const arrow = isLink ? shown.indexOf(" -> ") : -1;
  return {
    mark: m[1],
    start: e8.lineStart(line) + text.length - shown.length,
    name: arrow >= 0 ? shown.slice(0, arrow) : shown,
    isDir: m[2].startsWith("d"),
    isLink,
  };
}

const currentLine = (): number => e8.lineOf(e8.point());

/** Moves to the start of the file name on this line, as dired-move-to-filename: else to the line's start. */
export function moveToFilename(): number | undefined {
  const line = currentLine();
  const f = fileLine(line);
  e8.gotoChar(f ? f.start : e8.lineStart(line));
  return f?.start;
}

/** The directory this buffer lists, ending in a slash. */
export function currentDirectory(): string {
  const dir = e8.variable("dired-directory");
  if (typeof dir !== "string") throw new Error("Not in a Dired buffer");
  return e8.fileNameAsDirectory(e8.expandFileName(dir));
}

export const isDot = (name: string): boolean => name === "." || name === "..";

/** The absolute name of the file on this line, as dired-get-filename, or undefined on a line with none. */
export function filenameAt(line = currentLine()): string | undefined {
  const f = fileLine(line);
  return f === undefined ? undefined : currentDirectory() + f.name;
}

export function requireDired(): void {
  if (e8.variable("major-mode") !== "dired-mode") throw new Error("Not in a Dired buffer");
}

/** Runs `fn` with the read-only buffer writable, as inhibit-read-only. */
export function writable<T>(fn: () => T): T {
  return e8.letBind({ "inhibit-read-only": true }, fn);
}

/** Puts a mark on a line, as dired-mark's delete-char and insert: the buffer is modified even if it had the mark. */
export function setMark(line: number, char: string): void {
  const start = e8.lineStart(line);
  writable(() => {
    const point = e8.point();
    e8.deleteRegion(start, start + 1);
    e8.gotoChar(start);
    e8.insert(char);
    e8.gotoChar(point);
  });
}

/** Repeats over `arg` file lines from this one, as dired-repeat-over-lines, ending at a file name. */
function repeatOverLines(arg: number, fn: (line: number) => void): void {
  let line = currentLine();
  const last = e8.lineCount() - 1;
  const atEnd = (l: number) => l >= last && e8.lineStart(l) >= e8.bufferSize();
  while (arg > 0 && !atEnd(line)) {
    arg--;
    while (!atEnd(line) && fileLine(line) === undefined) line++;
    if (!atEnd(line)) fn(line);
    line = Math.min(line + 1, last);
  }
  while (arg < 0 && line > 0) {
    arg++;
    line--;
    while (line > 0 && fileLine(line) === undefined) line--;
    fn(line);
  }
  e8.gotoChar(e8.lineStart(line));
  if (arg === 0 || e8.lineStart(line) < e8.bufferSize()) moveToFilename();
}

/** The lines with `marker`, from the top. */
export function markedLines(marker = MARKER): number[] {
  const lines: number[] = [];
  for (let l = 0; l < e8.lineCount(); l++) {
    const f = fileLine(l);
    if (f && f.mark === marker) lines.push(l);
  }
  return lines;
}

/**
 * The files a command acts on, as dired-get-marked-files: those marked,
 * else the next `arg` from point if it is a number, else the one at point.
 */
export function markedFiles(
  arg: e8.PrefixArg | null,
  marker = MARKER,
  dotsError = false,
  noFiles = "No file on this line",
): { files: string[]; lines: number[]; marked: boolean } {
  if (typeof arg === "number" || arg === "-") {
    const lines: number[] = [];
    repeatOverLines(arg === "-" ? -1 : arg, (l) => lines.push(l));
    if (arg === "-" || (typeof arg === "number" && arg < 0)) lines.reverse();
    const kept = lines.filter((l) => fileLine(l) !== undefined);
    return { files: kept.map((l) => filenameAt(l)!), lines: kept, marked: false };
  }
  if (arg === null) {
    const lines = markedLines(marker);
    if (lines.length > 0) return { files: lines.map((l) => filenameAt(l)!), lines, marked: true };
  }
  const line = currentLine();
  const file = filenameAt(line);
  if (file === undefined) throw new Error(noFiles);
  if (dotsError && isDot(e8.fileNameNondirectory(file))) throw new Error("Cannot operate on \u2018.\u2019 or \u2018..\u2019");
  return { files: [file], lines: [line], marked: false };
}

/** How a prompt names the files: foo.txt, or * [3 files], as dired-mark-prompt. */
export function markPrompt(arg: e8.PrefixArg | null, files: string[], marker = MARKER): string {
  if (files.length === 1) return e8.fileNameNondirectory(files[0]);
  return typeof arg === "number" ? `[next ${arg} files]` : `${marker} [${files.length} files]`;
}

// Making the buffer.

function insertListing(dir: string): void {
  const header = `  ${e8.directoryFileName(dir)}:`;
  const lines = listing(dir, switchesOf()).map((l) => `  ${l}`);
  e8.insert([header, ...lines].join("\n") + "\n");
}

/** Lists the directory in the current buffer again, as dired-revert: marks and point stay with their files. */
export function readin(keepState: boolean): void {
  const dir = currentDirectory();
  const marks = new Map<string, string>();
  let pointFile: string | undefined;
  let pointLine = currentLine();
  if (keepState) {
    for (let l = 0; l < e8.lineCount(); l++) {
      const f = fileLine(l);
      if (f && f.mark !== " ") marks.set(f.name, f.mark);
    }
    pointFile = fileLine(pointLine)?.name;
  }
  writable(() => {
    e8.deleteRegion(0, e8.bufferSize());
    insertListing(dir);
  });
  e8.runHooks("dired-after-readin-hook");
  // As dired-readin, the new listing is unmodified; restoring marks
  // modifies it again, as dired-mark-remembered does.
  e8.setBufferModified(false);
  writable(() => {
    for (let l = 0; l < e8.lineCount(); l++) {
      const f = fileLine(l);
      const mark = f && marks.get(f.name);
      if (mark !== undefined) setMarkRaw(l, mark);
    }
  });
  if (pointFile !== undefined) {
    const found = findLine(pointFile);
    if (found !== undefined) pointLine = found;
  }
  e8.gotoChar(e8.lineStart(Math.min(pointLine, e8.lineCount() - 1)));
  moveToFilename();
}

function setMarkRaw(line: number, char: string): void {
  const start = e8.lineStart(line);
  e8.deleteRegion(start, start + 1);
  e8.gotoChar(start);
  e8.insert(char);
}

export function findLine(name: string): number | undefined {
  for (let l = 0; l < e8.lineCount(); l++) if (fileLine(l)?.name === name) return l;
  return undefined;
}

/** Puts point on the first file worth visiting, as dired-initial-position. */
function initialPosition(): void {
  const trivial = e8.variable("dired-trivial-filenames");
  const trivialName = (name: string): boolean => typeof trivial === "string" && e8.stringMatch(trivial, name) !== undefined;
  let line = 1;
  while (line < e8.lineCount() && fileLine(line) === undefined && e8.lineStart(line) < e8.bufferSize()) line++;
  while (line < e8.lineCount() && e8.lineStart(line) < e8.bufferSize() && trivialName(fileLine(line)?.name ?? "")) line++;
  e8.gotoChar(e8.lineStart(Math.min(line, e8.lineCount() - 1)));
  moveToFilename();
}

/** A Dired buffer already listing `dir`, as dired-find-buffer-nocreate. */
function findDiredBuffer(dir: string): string | undefined {
  return e8.bufferList().find((b) =>
    e8.withCurrentBuffer(b, () => e8.variable("major-mode") === "dired-mode" && e8.variable("dired-directory") === dir)
  );
}

/** The buffer listing a directory, made if need be, as dired-noselect. */
function diredNoselect(input: string): string {
  const dir = e8.fileNameAsDirectory(e8.expandFileName(input));
  if (!e8.fileDirectoryP(dir)) throw new Error(`${e8.directoryFileName(e8.expandFileName(input))}: No such file or directory`);
  const short = e8.abbreviateFileName(dir);
  const existing = findDiredBuffer(short);
  if (existing !== undefined) {
    if (on("dired-auto-revert-buffer")) e8.withCurrentBuffer(existing, () => readin(true));
    return existing;
  }
  const base = e8.fileNameNondirectory(e8.directoryFileName(dir)) || "/";
  let name = base;
  for (let n = 2; e8.bufferList().includes(name); n++) name = `${base}<${n}>`;
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.call("dired-mode");
    e8.makeLocalVariable("default-directory");
    e8.setVariable("default-directory", dir);
    e8.makeLocalVariable("dired-directory");
    e8.setVariable("dired-directory", short);
    writable(() => insertListing(dir));
    e8.runHooks("dired-after-readin-hook");
    e8.setBufferModified(false);
    initialPosition();
  });
  return name;
}

function showDired(name: string, where: "same" | "other" | "frame"): void {
  if (where === "same") e8.call("switch-to-buffer", name);
  else if (where === "other") e8.call("switch-to-buffer-other-window", name);
  else e8.call("switch-to-buffer-other-frame" as e8.CommandName, name);
}

const dirParam = (prompt: string): e8.Param => ({ name: "dirname", kind: "file", prompt });

e8.defineCommand({
  name: "dired",
  doc:
    "List a directory, one file a line, for visiting, marking and managing its files.\n\n" +
    "RET visits a file, ^ goes up, m marks, d flags for deletion, x deletes what is flagged, " +
    "C copies, R renames, D deletes and + makes a directory. ? sums up the keys.",
  params: [dirParam("Dired (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "same"),
});
e8.defineCommand({
  name: "dired-other-window",
  doc: "List a directory in another window, as dired does.",
  params: [dirParam("Dired in other window (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "other"),
});
e8.defineCommand({
  name: "dired-other-frame",
  doc: "List a directory in another frame, as dired does.",
  params: [dirParam("Dired in other frame (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "frame"),
});

function jump(otherWindow: boolean): void {
  const file = e8.bufferFileName();
  const dir = e8.variable("major-mode") === "dired-mode"
    ? e8.fileNameDirectory(e8.directoryFileName(currentDirectory())) ?? "/"
    : file !== undefined
      ? e8.fileNameDirectory(file)!
      : e8.fileNameAsDirectory(e8.expandFileName("."));
  const target = e8.variable("major-mode") === "dired-mode" ? e8.directoryFileName(currentDirectory()) : file;
  showDired(diredNoselect(dir), otherWindow ? "other" : "same");
  if (target !== undefined) {
    const line = findLine(e8.fileNameNondirectory(target));
    if (line !== undefined) {
      e8.gotoChar(e8.lineStart(line));
      moveToFilename();
    }
  }
}

e8.defineCommand({
  name: "dired-jump",
  doc: "List the directory of the current buffer's file, with point on the file. In Dired, go up a directory.",
  run: () => jump(e8.prefixArg() !== null),
});
e8.defineCommand({
  name: "dired-jump-other-window",
  doc: "List the directory of the current buffer's file in another window, with point on the file.",
  run: () => jump(true),
});

// Fontifying, as dired-font-lock-keywords: marks, names of directories
// and links, and the header. Details are invisible in dired-hide-details-mode.

function fontify(start: number, end: number): void {
  if (e8.variable("major-mode") !== "dired-mode") return;
  e8.removeTextProperty(start, end, "face");
  e8.removeTextProperty(start, end, "invisible");
  for (let line = e8.lineOf(start); line < e8.lineCount() && e8.lineStart(line) < end; line++) {
    const ls = e8.lineStart(line);
    const le = e8.lineEnd(line);
    const f = fileLine(line);
    if (f === undefined) {
      if (/^ {2}\S.*:$/.test(e8.lineText(line))) e8.putTextProperty(ls + 2, le, "face", "dired-header");
      continue;
    }
    e8.putTextProperty(ls + 2, f.start, "invisible", "dired-hide-details-detail");
    const nameEnd = f.start + f.name.length;
    if (f.isLink && nameEnd < le) e8.putTextProperty(nameEnd, le, "invisible", "dired-hide-details-link");
    if (f.mark === DEL_MARKER) {
      e8.putTextProperty(ls, ls + 1, "face", "dired-flagged");
      e8.putTextProperty(f.start, nameEnd, "face", "dired-flagged");
    } else if (f.mark !== " ") {
      e8.putTextProperty(ls, ls + 1, "face", "dired-mark");
      e8.putTextProperty(f.start, nameEnd, "face", "dired-marked");
    } else if (f.isDir) {
      e8.putTextProperty(f.start, nameEnd, "face", "dired-directory");
    } else if (f.isLink) {
      e8.putTextProperty(f.start, nameEnd, "face", "dired-symlink");
    } else if (/~$|^#.*#$/.test(f.name)) {
      e8.putTextProperty(f.start, nameEnd, "face", "dired-ignored");
    }
  }
}

// Moving.

/** Moves down `arg` lines and to the file name there, as dired--trivial-next-line. */
function nextLine(arg: number): void {
  const column = e8.currentColumn();
  const target = Math.max(0, Math.min(e8.lineCount() - 1, currentLine() + arg));
  e8.gotoChar(e8.lineStart(target));
  e8.moveToColumn(column);
  moveToFilename();
}

const count = (): number => e8.prefixNumericValue(e8.prefixArg());

e8.defineCommand({
  name: "dired-next-line",
  doc: "Move down a line, or as many as the prefix argument says, to the file name there.",
  run: () => nextLine(count()),
});
e8.defineCommand({
  name: "dired-previous-line",
  doc: "Move up a line, or as many as the prefix argument says, to the file name there.",
  run: () => nextLine(-count()),
});

function nextDirline(arg: number): void {
  const start = e8.point();
  let line = currentLine();
  let left = Math.abs(arg);
  const step = arg > 0 ? 1 : -1;
  while (left > 0) {
    line += step;
    if (line < 0 || line >= e8.lineCount()) {
      e8.gotoChar(start);
      throw new Error("No more subdirectories");
    }
    if (fileLine(line)?.isDir) left--;
  }
  e8.gotoChar(e8.lineStart(line));
  moveToFilename();
}

e8.defineCommand({
  name: "dired-next-dirline",
  doc: "Move down to the next directory's line, or as many as the prefix argument says.",
  run: () => nextDirline(count()),
});
e8.defineCommand({
  name: "dired-prev-dirline",
  doc: "Move up to the previous directory's line, or as many as the prefix argument says.",
  run: () => nextDirline(-count()),
});

/** Moves to the `arg`th next marked line, as dired-next-marked-file: typed, it wraps around once, saying so. */
function nextMarked(arg: number, wrap: boolean): void {
  const marked: number[] = [];
  for (let l = 0; l < e8.lineCount(); l++) {
    if (/^[^ \n]/.test(e8.lineText(l))) marked.push(l);
  }
  const find = (from: number, back: boolean): number | undefined => {
    let line = from;
    for (let k = 0; k < Math.abs(arg); k++) {
      const next = back ? [...marked].reverse().find((l) => l < line) : marked.find((l) => l > line);
      if (next === undefined) return undefined;
      line = next;
    }
    return line;
  };
  const back = arg < 0;
  let found = find(currentLine(), back);
  if (found === undefined && wrap) {
    e8.message("(Wraparound for next marked file)");
    found = find(back ? e8.lineCount() : -1, back);
  }
  if (found === undefined) throw new Error("No next marked file");
  e8.gotoChar(e8.lineStart(found));
  moveToFilename();
}

e8.defineCommand({
  name: "dired-next-marked-file",
  doc: "Move down to the next marked file, going round to the top if there is none below.",
  run: () => nextMarked(count(), e8.calledInteractively()),
});
e8.defineCommand({
  name: "dired-prev-marked-file",
  doc: "Move up to the previous marked file, going round to the bottom if there is none above.",
  run: () => nextMarked(-count(), e8.calledInteractively()),
});

/** Goes to the line of a file in this listing, as dired-goto-file; false if it is not there. */
export function gotoFile(file: string): boolean {
  const name = e8.fileNameNondirectory(e8.directoryFileName(e8.expandFileName(file)));
  const dir = e8.fileNameDirectory(e8.directoryFileName(e8.expandFileName(file)));
  if (dir !== currentDirectory()) return false;
  const line = findLine(name);
  if (line === undefined) return false;
  e8.gotoChar(e8.lineStart(line));
  moveToFilename();
  return true;
}

e8.defineCommand({
  name: "dired-goto-file",
  doc: "Go to the line of a file in this listing.",
  params: [{ name: "file", kind: "file", prompt: "Goto file: " }],
  run: (file: string) => {
    requireDired();
    if (e8.calledInteractively()) {
      e8.setMark(e8.point());
      e8.message("Mark set");
    }
    gotoFile(file);
  },
});

e8.defineCommand({
  name: "dired-up-directory",
  doc: "List the directory above this one, with point on this one. With a prefix argument, in another window.",
  run: () => {
    requireDired();
    const dir = currentDirectory();
    const up = e8.fileNameDirectory(e8.directoryFileName(dir));
    if (up === undefined || up === dir) return;
    const name = diredNoselect(up);
    showDired(name, e8.prefixArg() !== null ? "other" : "same");
    gotoFile(e8.directoryFileName(dir));
  },
});

// Visiting.

/** The file to visit from this line, as dired-get-file-for-visit. */
function fileForVisit(): string {
  const file = filenameAt();
  if (file === undefined) throw new Error("No file on this line");
  if (!e8.fileExists(file) && e8.fileAttributes(file) === undefined) throw new Error("File no longer exists; type \u2018g\u2019 to update Dired buffer");
  return file;
}

function visit(file: string, where: "same" | "other"): void {
  const target = isDot(e8.fileNameNondirectory(file)) ? e8.expandFileName(file) : file;
  if (e8.fileDirectoryP(target)) {
    const from = e8.bufferName();
    showDired(diredNoselect(target), where);
    if (where === "same" && on("dired-kill-when-opening-new-dired-buffer") && e8.bufferName() !== from) e8.call("kill-buffer", from);
    return;
  }
  e8.call(where === "same" ? "find-file" : "find-file-other-window", target);
}

e8.defineCommand({
  name: "dired-find-file",
  doc: "Visit the file or directory on this line.",
  run: () => visit(fileForVisit(), "same"),
});
e8.defineCommand({
  name: "dired-find-file-other-window",
  doc: "Visit the file or directory on this line in another window.",
  run: () => visit(fileForVisit(), "other"),
});
e8.defineCommand({
  name: "dired-display-file",
  doc: "Show the file on this line in another window, staying in Dired.",
  run: () => {
    const file = fileForVisit();
    const window = e8.selectedWindow();
    visit(file, "other");
    e8.selectWindow(window);
  },
});
e8.defineCommand({
  name: "dired-view-file",
  doc: "Visit the file on this line read-only, or list it if it is a directory.",
  run: () => {
    const file = fileForVisit();
    visit(file, "same");
    if (!e8.fileDirectoryP(file)) e8.setReadOnly(true);
  },
});
e8.defineCommand({
  name: "dired-find-alternate-file",
  doc: "Visit the file or directory on this line in place of this Dired buffer, which is killed.",
  run: () => {
    const file = fileForVisit();
    const from = e8.bufferName();
    visit(file, "same");
    if (e8.bufferName() !== from) e8.call("kill-buffer", from);
  },
});

// Marking.

/** Whether this line is a directory's header, as dired-get-subdir sees it. */
const onHeader = (line = currentLine()): boolean => fileLine(line) === undefined && /^ {2}\S.*:$/.test(e8.lineText(line));

/**
 * Marks lines from point, as dired-mark: the region's files, or on the
 * header every file but . and .., or the next `arg`. `.` and `..` are never flagged.
 */
function mark(char: string, n = e8.prefixNumericValue(e8.prefixArg())): void {
  if (!(e8.regionActive() && e8.mark() !== undefined && e8.mark() !== e8.point()) && onHeader()) {
    for (let l = 0; l < e8.lineCount(); l++) {
      const f = fileLine(l);
      if (f && !isDot(f.name)) setMark(l, char);
    }
    return;
  }
  if (e8.regionActive() && e8.mark() !== undefined && e8.mark() !== e8.point()) {
    const [a, b] = [Math.min(e8.point(), e8.mark()!), Math.max(e8.point(), e8.mark()!)];
    const point = e8.point();
    const first = e8.lineOf(a);
    let last = e8.lineOf(b);
    if (e8.lineStart(last) === b) last--;
    for (let l = first; l <= last; l++) {
      const f = fileLine(l);
      if (f && !isDot(f.name)) setMark(l, char);
    }
    e8.gotoChar(point);
    return;
  }
  repeatOverLines(n, (l) => {
    const f = fileLine(l);
    if (f && (!isDot(f.name) || f.isLink || char !== DEL_MARKER)) setMark(l, char);
  });
}

e8.defineCommand({
  name: "dired-mark",
  doc: "Mark the file on this line, and move down. With a prefix argument, the next that many; in the region, its files.",
  run: () => mark(MARKER),
});
e8.defineCommand({
  name: "dired-unmark",
  doc: "Take the mark or flag off the file on this line, and move down.",
  run: () => mark(" "),
});
e8.defineCommand({
  name: "dired-flag-file-deletion",
  doc: "Flag the file on this line for deletion, which x does, and move down.",
  run: () => mark(DEL_MARKER),
});
e8.defineCommand({
  name: "dired-unmark-backward",
  doc: "Move up a line and take the mark or flag off the file there.",
  // As dired-unmark with a negative count, so on the header line it unmarks every file.
  run: () => mark(" ", -count()),
});

e8.defineCommand({
  name: "dired-toggle-marks",
  doc: "Mark the files that are not marked and unmark those that are. Flags for deletion stay, and . and .. are left alone.",
  run: () => {
    requireDired();
    for (let l = 0; l < e8.lineCount(); l++) {
      const f = fileLine(l);
      if (!f || isDot(f.name)) continue;
      if (f.mark === " ") setMark(l, MARKER);
      else if (f.mark === MARKER) setMark(l, " ");
    }
  },
});

function unmarkAll(which: string | undefined): void {
  let n = 0;
  for (let l = 0; l < e8.lineCount(); l++) {
    const f = fileLine(l);
    if (f && f.mark !== " " && (which === undefined || f.mark === which)) {
      setMark(l, " ");
      n++;
    }
  }
  e8.message(n === 1 ? "1 mark removed" : `${n} marks removed`);
}

e8.defineCommand({
  name: "dired-unmark-all-marks",
  doc: "Take every mark and flag off.",
  run: () => unmarkAll(undefined),
});
e8.defineCommand({
  name: "dired-unmark-all-files",
  doc: "Take a mark off every file that has it: the mark character typed, or every mark for RET.",
  params: [{ name: "mark", prompt: "Remove marks (RET means all): " }],
  run: (char: string) => unmarkAll(char === "" ? undefined : char[0]),
});

/** Marks the files a test picks, as dired-mark-if, saying how many. */
export function markIf(test: (f: FileLine) => boolean, what: string, char = MARKER): void {
  const doing = char === " " ? "Unmarking" : char === DEL_MARKER ? "Flagging" : "Marking";
  e8.message(`${doing} ${what}s${char === DEL_MARKER ? " for deletion" : ""}...`);
  let n = 0;
  for (let l = 0; l < e8.lineCount(); l++) {
    const f = fileLine(l);
    if (f && test(f) && f.mark !== char) {
      setMark(l, char);
      n++;
    }
  }
  const verb = char === " " ? "un" : "";
  e8.message(`${n} ${what}${n === 1 ? "" : "s"} ${verb}${char === DEL_MARKER ? "flagged" : "marked"}`);
}

export const regexpParam = (prompt: string): e8.Param => ({ name: "regexp", prompt, history: "dired-regexp-history" });

e8.defineCommand({
  name: "dired-mark-files-regexp",
  doc: "Mark the files whose names match a regular expression. With a prefix argument, unmark them.",
  params: [regexpParam("Mark files (regexp): ")],
  run: (regexp: string) => {
    markIf((f) => !isDot(f.name) && e8.stringMatch(regexp, f.name) !== undefined, "matching file", e8.prefixArg() !== null ? " " : MARKER);
  },
});
e8.defineCommand({
  name: "dired-flag-files-regexp",
  doc: "Flag for deletion the files whose names match a regular expression.",
  params: [regexpParam("Flag for deletion (regexp): ")],
  run: (regexp: string) => {
    markIf((f) => !isDot(f.name) && e8.stringMatch(regexp, f.name) !== undefined, "matching file", DEL_MARKER);
  },
});
e8.defineCommand({
  name: "dired-mark-directories",
  doc: "Mark the directories, but not . and ... With a prefix argument, unmark them.",
  run: () => markIf((f) => f.isDir && !isDot(f.name), "directory file", e8.prefixArg() !== null ? " " : MARKER),
});
e8.defineCommand({
  name: "dired-mark-symlinks",
  doc: "Mark the symbolic links. With a prefix argument, unmark them.",
  run: () => markIf((f) => f.isLink, "symbolic link", e8.prefixArg() !== null ? " " : MARKER),
});
e8.defineCommand({
  name: "dired-mark-executables",
  doc: "Mark the files anyone can run. With a prefix argument, unmark them.",
  run: () => {
    markIf((f) => {
      const a = e8.fileAttributes(currentDirectory() + f.name);
      return a !== undefined && a.type === "file" && /x/.test(a.modes);
    }, "executable file", e8.prefixArg() !== null ? " " : MARKER);
  },
});
e8.defineCommand({
  name: "dired-flag-backup-files",
  doc: "Flag for deletion the backup files, whose names end in ~. With a prefix argument, unflag them.",
  run: () => markIf((f) => f.name.endsWith("~"), "backup file", e8.prefixArg() !== null ? " " : DEL_MARKER),
});
e8.defineCommand({
  name: "dired-flag-auto-save-files",
  doc: "Flag for deletion the auto-save files, named #like-this#. With a prefix argument, unflag them.",
  run: () => markIf((f) => /^#.*#$/.test(f.name), "auto save file", e8.prefixArg() !== null ? " " : DEL_MARKER),
});
e8.defineCommand({
  name: "dired-change-marks",
  doc: "Change one mark to another on every file that has it.",
  params: [{ name: "old", prompt: "Change (old mark): " }, { name: "new", prompt: (old) => `Change ${old} marks to (new mark): ` }],
  run: (old: string, next: string) => {
    for (let l = 0; l < e8.lineCount(); l++) if (fileLine(l)?.mark === old[0]) setMark(l, next[0] ?? " ");
  },
});
e8.defineCommand({
  name: "dired-number-of-marked-files",
  doc: "Say how many files are marked, and their size.",
  run: () => {
    const files = markedLines(MARKER).map((l) => filenameAt(l)!);
    if (files.length === 0) {
      e8.message("No marked files");
      return;
    }
    const size = files.reduce((sum, f) => sum + (e8.fileAttributes(f)?.size ?? 0), 0);
    e8.message(`${files.length} marked file${files.length === 1 ? "" : "s"} (${humanSize(size)})`);
  },
});

// Acting on files.

/** Takes a file's line out of every Dired buffer listing its directory, as dired-remove-file. */
export function removeEntry(file: string): void {
  const dir = e8.fileNameDirectory(file);
  const name = e8.fileNameNondirectory(file);
  for (const b of e8.bufferList()) {
    e8.withCurrentBuffer(b, () => {
      if (e8.variable("major-mode") !== "dired-mode" || currentDirectory() !== dir) return;
      const line = findLine(name);
      if (line === undefined) return;
      writable(() => e8.deleteRegion(e8.lineStart(line), Math.min(e8.lineStart(line + 1), e8.bufferSize())));
    });
  }
}

/** Adds a line for a new file at point, if this buffer lists its directory, as dired-add-entry. */
export function addEntry(file: string, marker?: string): void {
  const dir = e8.fileNameDirectory(e8.directoryFileName(file));
  const name = e8.fileNameNondirectory(e8.directoryFileName(file));
  if (dir !== currentDirectory()) return;
  const [line] = listing(dir, switchesOf(), [name]);
  if (line === undefined) return;
  writable(() => {
    const at = e8.lineStart(Math.max(currentLine(), 1));
    e8.gotoChar(at);
    e8.insert(`${marker ?? " "} ${line}\n`);
    e8.gotoChar(at);
  });
  moveToFilename();
}

/** Deletes files, asking first, as dired-internal-do-deletions: directories with files in them ask again. */
function doDeletions(files: string[], arg: e8.PrefixArg | null, marker: string): void {
  const trashing = on("delete-by-moving-to-trash");
  if (!e8.yesOrNoP(`${trashing ? "Trash" : "Delete"} ${markPrompt(arg, files, marker)} `)) {
    e8.message("(No deletions performed)");
    return;
  }
  // Point stays with its line, or goes to the next if that line goes, as
  // Emacs's save-excursion keeps it.
  const pointLine = currentLine();
  const pointName = fileLine(pointLine)?.name;
  const linesBefore = files.filter((f) => {
    const l = findLine(e8.fileNameNondirectory(f));
    return l !== undefined && l < pointLine;
  });
  const failures: string[] = [];
  let recursive = e8.variable("dired-recursive-deletes");
  for (const file of files) {
    // As dired-delete-file: a directory with files in it is deleted with
    // them only as dired-recursive-deletes, or the answer, says.
    let rec = false;
    const full = e8.fileAttributes(file)?.type === "directory" && e8.directoryFiles(file).length > 2;
    if (full && recursive === "always") rec = true;
    else if (full && recursive !== null && recursive !== false) {
      const answer = e8.readAnswer(`Recursively ${trashing ? "trash" : "delete"} ${e8.fileNameNondirectory(file)}? `, ["yes", "no", "all", "quit"]);
      if (answer === "quit") throw new Error("Quit");
      if (answer === "all") recursive = "always";
      rec = answer !== "no";
    }
    try {
      if (e8.fileAttributes(file)?.type === "directory") e8.deleteDirectory(file, { recursive: rec, trash: true });
      else e8.deleteFile(file, { trash: true });
      removeEntry(file);
    } catch {
      failures.push(file);
    }
  }
  if (failures.length > 0) {
    e8.message(`${failures.length} of ${files.length} deletion${files.length === 1 ? "" : "s"} failed`);
  } else {
    e8.message(`${trashing ? "Trashing" : "Deleting"}...done`);
  }
  const kept = pointName === undefined ? undefined : findLine(pointName);
  const gone = linesBefore.filter((f) => !failures.includes(f)).length;
  const line = kept ?? Math.max(0, pointLine - gone);
  e8.gotoChar(e8.lineStart(Math.min(line, e8.lineCount() - 1)));
  moveToFilename();
}

e8.defineCommand({
  name: "dired-do-flagged-delete",
  doc: "Delete the files flagged with d, after asking. Deleting goes to the trash, as delete-by-moving-to-trash says.",
  run: () => {
    requireDired();
    const lines = markedLines(DEL_MARKER);
    if (lines.length === 0) {
      e8.message("(No deletions requested)");
      return;
    }
    doDeletions(lines.map((l) => filenameAt(l)!), null, DEL_MARKER);
  },
});
e8.defineCommand({
  name: "dired-do-delete",
  doc: "Delete the marked files, or the one on this line, after asking. With a prefix argument, the next that many.",
  run: () => {
    requireDired();
    const arg = e8.prefixArg();
    const { files, lines } = markedFiles(arg, MARKER, true);
    if (files.some((f) => isDot(e8.fileNameNondirectory(f)))) throw new Error("Cannot operate on \u2018.\u2019 or \u2018..\u2019");
    doDeletions(files, arg, MARKER);
  },
});

/** Where a copy or rename suggests going, as dired-dwim-target-directory. */
export function dwimTarget(): string {
  if (on("dired-dwim-target")) {
    const here = e8.selectedWindow();
    for (const w of e8.windowList()) {
      if (w === here) continue;
      const b = e8.windowBuffer(w);
      const dir = b && e8.withCurrentBuffer(b, () => e8.variable("major-mode") === "dired-mode" ? currentDirectory() : undefined);
      if (dir) return dir;
    }
  }
  return currentDirectory();
}

export type Creator = (from: string, to: string) => void;

/**
 * A question asked of each file in turn, as dired-query: y or SPC says yes
 * and n or DEL no to this one, ! yes and q or ESC no to the rest without
 * asking again.
 */
export function makeQuery(): (prompt: string) => boolean {
  let answer = "";
  return (prompt) => {
    if (answer === "!") return true;
    if (answer === "q" || answer === "\x1b") return false;
    answer = e8.readCharChoice(`${prompt} [Type yn!q or C-h] `, "y n\x7f!q\x1b");
    return answer === "y" || answer === " " || answer === "!";
  };
}

/** States how a command over several files went, as dired-log-summary: one failure shows what was logged for it. */
function logSummary(summary: string, files: string[], logged: string): void {
  if (files.length === 1) e8.message(logged);
  else e8.message(`${summary}--type ? for details (${files.map((f) => e8.fileNameNondirectory(f)).join(" ")})`);
}

/**
 * Makes a new file from each of `files`, as dired-create-files: `nameOf`
 * gives each one's new name, or undefined to skip it; a file already there
 * is overwritten only if you say so; and the new files are listed, marked
 * as `marker` says.
 */
export function createFiles(
  operation: string,
  files: string[],
  nameOf: (from: string) => string | undefined,
  creator: Creator,
  marker: (from: string) => string | undefined,
): void {
  let done = 0;
  const failures: string[] = [];
  const skipped: string[] = [];
  // The last failure, as dired-log writes it.
  let logged = "";
  const overwriteQuery = makeQuery();
  for (const from of files) {
    gotoFile(from);
    let dest = nameOf(from);
    if (dest === from) {
      logged = `Cannot ${operation.toLowerCase()} to same file: ${from}\n`;
      dest = undefined;
    }
    if (dest === undefined) {
      skipped.push(from);
      continue;
    }
    // As dired-create-files, before trying: a directory cannot be copied into itself.
    const destDir = e8.fileNameDirectory(dest) ?? "/";
    if (operation === "Copy" && e8.fileDirectoryP(from)) {
      const real = e8.fileNameAsDirectory(e8.expandFileName(from));
      if (e8.fileNameAsDirectory(e8.expandFileName(destDir)).startsWith(real)) {
        throw new Error(`Cannot copy \u2018${from}\u2019 into its subdirectory \u2018${dest}\u2019`);
      }
    }
    const overwrite = e8.fileExists(dest);
    if (overwrite && !overwriteQuery(`Overwrite \u2018${dest}\u2019?`)) {
      failures.push(from);
      logged = `${operation}: \u2018${from}\u2019 to \u2018${dest}\u2019 failed:\n(file-already-exists File already exists ${dest})\n`;
      continue;
    }
    // As dired-create-files, a file error is a failure to log; anything
    // else, as quitting a question the creator asks, goes on up.
    try {
      const mk = marker(from);
      creator(from, dest);
      if (overwrite) removeEntry(dest);
      done++;
      e8.message(`${operation}: ${done} of ${files.length}`);
      addEntry(dest, mk);
    } catch (e) {
      if (!e8.errorConditions(e).includes("file-error")) throw e;
      failures.push(from);
      const err = e as Partial<e8.SignalledError>;
      const printed = err.symbol ? `(${[err.symbol, ...(err.data ?? []).map(String)].join(" ")})` : String(err.message ?? e);
      logged = `${operation}: \u2018${from}\u2019 to \u2018${dest}\u2019 failed:\n${printed}\n`;
    }
  }
  const total = files.length;
  if (failures.length > 0) logSummary(`${operation}: ${failures.length} of ${total} file${total === 1 ? "" : "s"} failed`, failures, logged);
  else if (skipped.length > 0) logSummary(`${operation}: ${skipped.length} of ${total} file${total === 1 ? "" : "s"} skipped`, skipped, logged);
  else e8.message(`${operation}: ${done} file${done === 1 ? "" : "s"} done`);
  moveToFilename();
}

/**
 * Makes a new file from each marked file, as dired-do-create-files: asking
 * where, a new name for one file or a directory to put several in. Links
 * are made from the name asked for, so their prompts say from, not to.
 */
export function doCreateFiles(operation: string, op1: string, creator: Creator, marker: (from: string) => string | undefined, link = false): void {
  requireDired();
  const arg = e8.prefixArg();
  const { files } = markedFiles(arg, MARKER, false, "No files specified");
  const one = files.length === 1;
  const targetDir = dwimTarget();
  const prompt = `${one ? op1 : operation} ${markPrompt(arg, files)} ${link ? "from" : "to"}: `;
  const dflt = one && !on("dired-dwim-target") ? targetDir + e8.fileNameNondirectory(files[0]) : undefined;
  const target = e8.expandFileName(e8.readFileName(prompt, { dir: targetDir, default: dflt }));
  // A rename that only changes the case of one name, on a file system that
  // ignores case, is a rename, not a move into the directory it names.
  const caseOnly = one && operation === "Move" && files[0].toLowerCase() === target.toLowerCase() &&
    e8.fileNameNondirectory(files[0]) !== e8.fileNameNondirectory(target);
  const intoDir = !caseOnly && e8.fileDirectoryP(target);
  if (!one && !intoDir) throw new Error(`Marked ${operation}: target must be a directory: ${target}`);
  createFiles(
    operation,
    files,
    (from) => intoDir ? e8.fileNameAsDirectory(target) + e8.fileNameNondirectory(from) : e8.directoryFileName(target),
    creator,
    marker,
  );
}

export const markOf = (file: string): string => {
  const line = findLine(e8.fileNameNondirectory(file));
  return line === undefined ? " " : fileLine(line)!.mark;
};

e8.defineCommand({
  name: "dired-do-copy",
  doc:
    "Copy the marked files, or the one on this line, asking where to: a new name for one, a directory for several.\n\n" +
    "Copies are marked C, as dired-keep-marker-copy says, and keep their modification times.",
  run: () => {
    const keep = e8.variable("dired-keep-marker-copy");
    // As dired-copy-file-recursive: a directory is copied with what it
    // holds if dired-recursive-copies is always, or you say so; otherwise
    // copy-file refuses it.
    const recursive = e8.variable("dired-recursive-copies");
    doCreateFiles(
      "Copy",
      "Copy",
      (from, to) => {
        const directory = e8.fileAttributes(from)?.type === "directory";
        if (directory && on("dired-recursive-copies") && (recursive === "always" || e8.yesOrNoP(`Copy ${from} recursively? `))) {
          e8.copyDirectory(from, to, { keepTime: on("dired-copy-preserve-time") });
        } else {
          e8.copyFile(from, to, { okIfExists: true, keepTime: on("dired-copy-preserve-time") });
        }
      },
      (from) => typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined,
    );
  },
});

e8.defineCommand({
  name: "dired-do-rename",
  doc:
    "Rename the marked files, or the one on this line, asking to what: a new name for one, a directory for several, " +
    "to move them there. Buffers visiting them follow.",
  run: () => {
    const { files } = markedFiles(e8.prefixArg(), MARKER, false, "No files specified");
    if (files.some((f) => isDot(e8.fileNameNondirectory(f)))) throw new Error(`Can\u2019t rename "." or ".." files`);
    const keep = e8.variable("dired-keep-marker-rename");
    doCreateFiles("Move", "Rename", (from, to) => {
      e8.renameFile(from, to, { okIfExists: true });
      for (const b of e8.bufferList()) {
        e8.withCurrentBuffer(b, () => {
          if (e8.bufferFileName() === from) e8.setVisitedFileName(to, { alongWithFile: true });
        });
      }
      removeEntry(from);
    }, (from) => typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined);
  },
});

e8.defineCommand({
  name: "dired-create-directory",
  doc: "Make a directory, with any missing above it, and list it here.",
  params: [{ name: "directory", kind: "file", prompt: "Create directory: " }],
  run: (input: string) => {
    requireDired();
    const dir = e8.directoryFileName(e8.expandFileName(input));
    if (e8.fileExists(dir)) throw new Error(`Cannot create directory ${dir}: file exists`);
    // The topmost directory that is new is the one this listing may show.
    let top = dir;
    for (let up = e8.fileNameDirectory(top); up !== undefined && !e8.fileExists(up); up = e8.fileNameDirectory(e8.directoryFileName(up))) {
      top = e8.directoryFileName(up);
    }
    e8.makeDirectory(dir, { parents: true });
    addEntry(top);
  },
});

e8.defineCommand({
  name: "dired-create-empty-file",
  doc: "Make an empty file, with any missing directories above it, and list it here.",
  params: [{ name: "file", kind: "file", prompt: "Create empty file: " }],
  run: (input: string) => {
    requireDired();
    const file = e8.expandFileName(input);
    if (e8.fileExists(file)) throw new Error(`Cannot create file ${file}: file exists`);
    const dir = e8.fileNameDirectory(file);
    if (dir !== undefined) e8.makeDirectory(dir, { parents: true });
    e8.writeTextFile(file, "");
    addEntry(file);
  },
});

e8.defineCommand({
  name: "dired-do-kill-lines",
  doc:
    "Take the marked files' lines out of the listing; with a prefix argument, the next that many lines instead. " +
    "The files stay; g brings the lines back.",
  run: () => {
    requireDired();
    const arg = e8.prefixArg();
    if (arg !== null) {
      // As dired-kill-line: from this line on, or back with a negative count.
      let n = e8.prefixNumericValue(arg);
      writable(() => {
        while (n !== 0) {
          const line = currentLine();
          if (fileLine(line) === undefined) throw new Error("Can only kill file lines");
          e8.deleteRegion(e8.lineStart(line), Math.min(e8.lineStart(line + 1), e8.bufferSize()));
          if (n > 0) n--;
          else {
            n++;
            e8.gotoChar(e8.lineStart(Math.max(0, currentLine() - 1)));
          }
        }
      });
      moveToFilename();
      return;
    }
    const point = e8.point();
    const lines = markedLines(MARKER);
    let shift = 0;
    writable(() => {
      for (const l of [...lines].sort((a, b) => b - a)) {
        const start = e8.lineStart(l);
        const end = Math.min(e8.lineStart(l + 1), e8.bufferSize());
        if (start < point) shift += Math.min(end, point) - start;
        e8.deleteRegion(start, end);
      }
    });
    e8.gotoChar(point - shift);
    e8.message(`Killed ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
  },
});

e8.defineCommand({
  name: "dired-copy-filename-as-kill",
  doc:
    "Put the names of the marked files, or this line's, in the kill ring, separated by spaces.\n\n" +
    "With a zero prefix argument, their whole names; with C-u, relative to this directory.",
  run: () => {
    requireDired();
    // On the header, the directory's whole name, as dired-get-subdir gives it.
    if (onHeader()) {
      const dir = currentDirectory();
      e8.killNew(dir);
      e8.message(dir);
      return;
    }
    const arg = e8.prefixArg();
    const absolute = arg !== null && e8.prefixNumericValue(arg) === 0;
    // With no file here and none marked, there is nothing to copy, as Emacs says nothing.
    if (filenameAt() === undefined && markedLines(MARKER).length === 0) return;
    const { files } = markedFiles(arg === null || absolute || Array.isArray(arg) ? null : arg);
    const names = files.map((f) => (absolute ? f : e8.fileNameNondirectory(f)));
    const text = names.length === 1 ? names[0] : names.map((n) => (/[ "']/.test(n) ? JSON.stringify(n) : n)).join(" ");
    if (text === "") return;
    e8.killNew(text);
    e8.message(text);
  },
});

e8.defineCommand({
  name: "dired-revert",
  doc: "List the directory again, keeping the marks and point on the same file.",
  run: () => {
    requireDired();
    readin(true);
  },
});

e8.defineCommand({
  name: "dired-do-redisplay",
  doc: "List the directory again, as g does.",
  run: () => e8.call("dired-revert"),
});

e8.defineCommand({
  name: "dired-sort-toggle-or-edit",
  doc: "Sort the listing by date if it is sorted by name, else by name. With a prefix argument, type the switches.",
  run: () => {
    requireDired();
    const switches = switchesOf();
    const byDate = /^-\S*t|\s-\S*t/.test(switches);
    const toggled = byDate ? switches.replace(/(-\S*?)t/, "$1").replace(/ -(?=\s|$)/, "") : `${switches}t`;
    e8.makeLocalVariable("dired-actual-switches");
    e8.setVariable("dired-actual-switches", toggled);
    e8.setVariable("mode-name", byDate ? "Dired by name" : "Dired by date");
    readin(true);
  },
});

e8.defineMinorMode({
  name: "dired-hide-details-mode",
  lighter: "",
  doc: "Show only the files' names in Dired, hiding their sizes, dates and the rest.",
  onChange: (enabled) => {
    for (const spec of ["dired-hide-details-detail", "dired-hide-details-link"]) {
      if (enabled) e8.addToInvisibilitySpec(spec);
      else e8.removeFromInvisibilitySpec(spec);
    }
  },
});

e8.defineCommand({
  name: "dired-summary",
  doc: "Sum up Dired's most used keys in the echo area.",
  run: () => e8.message("d-elete, u-ndelete, x-punge, f-ind, o-ther window, R-ename, C-opy, h-elp"),
});

e8.defineCommand({
  name: "dired-undo",
  doc: "Undo marks and flags, as far as the buffer remembers them. Changes to files stay.",
  run: () => writable(() => e8.call("undo")),
});

// The mode.

// What C-h h shows in a Dired buffer (ADR 0068).
defineGuide("dired-mode", {
  title: "Dired",
  summary:
    "Dired lists a directory's files, one to a line, and acts on them: opens, copies, renames and deletes them. " +
    "Mark several files and a command acts on them all; with none marked, it acts on the file point is on.",
  keys: [
    [
      "Moving about",
      [
        ["dired-find-file", "Open the file or directory point is on"],
        ["dired-up-directory", "Go up to the parent directory"],
        ["revert-buffer", "Read the directory again"],
      ],
    ],
    [
      "Marking",
      [
        ["dired-mark", "Mark the file"],
        ["dired-unmark", "Unmark it"],
        ["dired-flag-file-deletion", "Flag it for deletion"],
        ["dired-do-flagged-delete", "Delete the files flagged, after asking"],
      ],
    ],
    [
      "Acting on files",
      [
        ["dired-do-copy", "Copy the marked files, or this one"],
        ["dired-do-rename", "Rename or move them"],
        ["dired-create-directory", "Make a new directory"],
        ["wdired-change-to-wdired-mode", "Edit the names as text, to rename many at once"],
      ],
    ],
  ],
  tryNow: [
    "Move to a file and press \\[dired-find-file] to open it; \\[dired-jump] in that file comes back here.",
    "Press \\[dired-flag-file-deletion] on a file, then \\[dired-unmark] to change your mind.",
  ],
  learnNext: [
    "\\[dired-do-rename] with several files marked moves them all into a directory.",
    "\\[describe-mode] lists every key of Dired.",
  ],
});

e8.defineMajorMode({
  name: "dired-mode",
  modeName: "Dired by name",
  doc:
    "List a directory's files, one a line, for visiting and managing them.\n\n" +
    "RET or f visits the file on a line and o visits it in another window; ^ goes up a directory. " +
    "m marks a file, u unmarks it, t toggles marks and U takes them all off; d flags a file for deletion and x " +
    "deletes what is flagged. C copies, R renames or moves and D deletes the marked files, or the one on the line. " +
    "+ makes a directory, g lists the directory again, s sorts by date or name, and ( hides the details.",
  bindings: {
    RET: "dired-find-file", f: "dired-find-file", e: "dired-find-file", o: "dired-find-file-other-window",
    "C-o": "dired-display-file", v: "dired-view-file", a: "dired-find-alternate-file",
    n: "dired-next-line", p: "dired-previous-line", SPC: "dired-next-line", "S-SPC": "dired-previous-line",
    "C-n": "dired-next-line", "C-p": "dired-previous-line", "<down>": "dired-next-line", "<up>": "dired-previous-line",
    ">": "dired-next-dirline", "<": "dired-prev-dirline", "^": "dired-up-directory", j: "dired-goto-file",
    "M-}": "dired-next-marked-file", "M-{": "dired-prev-marked-file", "* C-n": "dired-next-marked-file", "* C-p": "dired-prev-marked-file",
    m: "dired-mark", "* m": "dired-mark", u: "dired-unmark", "* u": "dired-unmark", d: "dired-flag-file-deletion",
    DEL: "dired-unmark-backward", "* DEL": "dired-unmark-backward", t: "dired-toggle-marks", "* t": "dired-toggle-marks",
    U: "dired-unmark-all-marks", "* !": "dired-unmark-all-marks", "* ?": "dired-unmark-all-files", "M-DEL": "dired-unmark-all-files",
    "% m": "dired-mark-files-regexp", "* %": "dired-mark-files-regexp", "% d": "dired-flag-files-regexp",
    "* /": "dired-mark-directories", "* @": "dired-mark-symlinks", "* *": "dired-mark-executables",
    "~": "dired-flag-backup-files", "#": "dired-flag-auto-save-files", "* c": "dired-change-marks", "* N": "dired-number-of-marked-files",
    x: "dired-do-flagged-delete", D: "dired-do-delete", C: "dired-do-copy", R: "dired-do-rename",
    "+": "dired-create-directory", k: "dired-do-kill-lines", w: "dired-copy-filename-as-kill",
    g: "revert-buffer", l: "dired-do-redisplay", s: "dired-sort-toggle-or-edit", "(": "dired-hide-details-mode",
    "?": "dired-summary", q: "quit-window", "C-/": "dired-undo", "C-_": "dired-undo", "C-x u": "dired-undo",
  },
  setup: () => {
    e8.setReadOnly(true);
    e8.makeLocalVariable("revert-buffer-function");
    e8.setVariable("revert-buffer-function", "dired-revert");
    e8.addHook("jit-lock-functions", fontify, { local: true });
    // As dired-mode does: the spec becomes a list, so the details, whose
    // invisible property names dired-hide-details-detail, show until
    // dired-hide-details-mode adds that name. (dired . t) is what hides
    // a subdirectory with an ellipsis.
    e8.addToInvisibilitySpec("dired", { ellipsis: true });
  },
});

e8.bindKey("C-x d", "dired");
e8.bindKey("C-x 4 d", "dired-other-window");
e8.bindKey("C-x 5 d", "dired-other-frame");
e8.bindKey("C-x C-j", "dired-jump");
e8.bindKey("C-x 4 C-j", "dired-jump-other-window");
