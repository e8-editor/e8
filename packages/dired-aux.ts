// The less used Dired commands, after Emacs's dired-aux.el: links, renaming
// by regexp and by case, running shell commands on the marked files,
// changing their modes, owners and times, compressing them, marking those
// whose text matches, and searching them.
//
// Copyright (C) 1985-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import {
  MARKER, type Creator, caseFoldSearch, createFiles, currentDirectory, doCreateFiles, filenameAt, isDot, makeQuery, markIf, markOf,
  markedFiles, markPrompt, on, readin, removeEntry, requireDired, diredLog, logSummary,
} from "dired";
import { fileloopContinue, fileloopInitializeReplace, fileloopInitializeSearch } from "fileloop";
import { executableFind } from "subr";
import { matchesInFiles } from "xref";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar("dired-keep-marker-symlink", "Y", "The mark symbolic links get, or true for the mark the file had, or nil for none.");
defvar("dired-keep-marker-relsymlink", "S", "The mark relative symbolic links get, or true for the mark the file had, or nil for none.");
defvar("dired-keep-marker-hardlink", "H", "The mark hard links get, or true for the mark the file had, or nil for none.");
defvar("dired-always-read-filesystem", false, "Whether searching the marked files reads them from disk even when a buffer visits them.");
defvar("dired-confirm-shell-command", true, "Whether ! asks first when a * or ? in the command is not on its own, and so not a file name.");
defvar("dired-touch-program", "touch", "The program T runs to change the files' times.");
defvar("dired-chown-program", "chown", "The program O runs to change the files' owners.");
defvar("dired-compress-directory-default-suffix", ".tar.gz", "The suffix Z gives the archive it makes of a directory.");

/** The mark a keep-marker variable gives a new file made from `from`. */
const keptMark = (variable: string) => (from: string): string | undefined => {
  const keep = e8.variable(variable);
  return typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined;
};

/** A word for the shell, as shell-quote-argument: each character that is not plain gets a backslash. */
export function shellQuoteArgument(arg: string): string {
  if (arg === "") return "''";
  return arg.replace(/[^-0-9a-zA-Z_./\n]/g, "\\$&").replace(/\n/g, "'\n'");
}

// Links.

/** Makes `link` a link to `file` by the shortest relative name, as dired-make-relative-symlink. */
export function makeRelativeSymlink(file: string, link: string, okIfExists = false): void {
  const file1 = e8.expandFileName(file);
  const file2 = e8.expandFileName(link);
  // The longest leading directory the two names share.
  let index = 0;
  for (;;) {
    const slash = file1.indexOf("/", index);
    if (slash < 0) break;
    const next = slash + 1;
    if (next >= Math.min(file1.length, file2.length) || file1.slice(0, next) !== file2.slice(0, next)) break;
    index = next;
  }
  let name1: string;
  if (file1.slice(0, index) === "/") name1 = file1;
  else {
    const ups = [...file2.slice(index)].filter((c) => c === "/").length;
    name1 = "../".repeat(ups) + file1.slice(index);
  }
  e8.makeSymbolicLink(e8.directoryFileName(name1), file2, okIfExists);
}

const symlink: Creator = (from, to) => e8.makeSymbolicLink(from, to, true);
const relsymlink: Creator = (from, to) => makeRelativeSymlink(from, to, true);
const hardlink: Creator = (from, to) => e8.addNameToFile(from, to, true);

e8.defineCommand({
  name: "dired-do-symlink",
  doc:
    "Make symbolic links to the marked files, or the one on this line: a new name for one, a directory for several, " +
    "where links of the same names are made. The links name the files absolutely; Y makes relative ones.",
  run: () => doCreateFiles("Symlink", "Symlink", symlink, keptMark("dired-keep-marker-symlink"), true),
});
e8.defineCommand({
  name: "dired-do-relsymlink",
  doc: "Make relative symbolic links to the marked files, or the one on this line, as foo -> ../bar/foo rather than an absolute name.",
  run: () => doCreateFiles("RelSymLink", "RelSymLink", relsymlink, keptMark("dired-keep-marker-relsymlink")),
});
e8.defineCommand({
  name: "dired-do-hardlink",
  doc: "Give the marked files, or the one on this line, other names, as hard links: a new name for one, a directory for several.",
  run: () => doCreateFiles("Hardlink", "Hardlink", hardlink, keptMark("dired-keep-marker-hardlink"), true),
});

// Acting on files by regexp.

/** Renames a file and the buffers visiting it, as dired-rename-file. */
export const diredRenameFile: Creator = (from, to) => {
  e8.renameFile(from, to, { okIfExists: true });
  for (const b of e8.bufferList()) {
    e8.withCurrentBuffer(b, () => {
      if (e8.bufferFileName() === from) e8.setVisitedFileName(to, { alongWithFile: true });
    });
  }
  removeEntry(from);
};

const copy: Creator = (from, to) => e8.copyFile(from, to, { okIfExists: true, keepTime: on("dired-copy-preserve-time") });

/**
 * Makes a new file from each marked file whose name matches `regexp`, named
 * by replacing the match with `newname`, asking about each, as
 * dired-do-create-files-regexp. With `wholeName`, the regexp matches the
 * whole file name, else the part after the directory.
 */
function createFilesRegexp(creator: Creator, operation: string, arg: e8.PrefixArg | null, regexp: string, newname: string, wholeName: boolean, marker: (from: string) => string | undefined): void {
  requireDired();
  const { files } = markedFiles(arg, MARKER, false, "No files specified");
  const ask = makeQuery();
  const replaced = (name: string) => stringReplaceMatch(regexp, name, newname);
  createFiles(operation, files, (from) => {
    const relative = e8.fileNameNondirectory(from);
    const fromName = wholeName ? from : relative;
    const newName = replaced(fromName);
    if (newName === undefined) return undefined;
    const to = wholeName ? newName : e8.expandFileName(newName, e8.fileNameDirectory(from));
    const shown = wholeName ? to : e8.fileNameNondirectory(to);
    return ask(`${operation} \u2018${wholeName ? from : relative}\u2019 to \u2018${shown}\u2019?`) ? to : undefined;
  }, creator, marker);
}

/**
 * `string` with the first match of `regexp` replaced by `newtext`, where \\&
 * stands for the match and \\N for its groups, as dired-string-replace-match:
 * undefined if it does not match.
 */
export function stringReplaceMatch(regexp: string, string: string, newtext: string): string | undefined {
  if (e8.stringMatch(regexp, string, { caseFold: caseFoldSearch() }) === undefined) return undefined;
  const chars = [...string];
  const group = (n: number): string => {
    const start = e8.matchBeginning(n);
    return start === undefined ? "" : chars.slice(start, e8.matchEnd(n)).join("");
  };
  const replacement = newtext.replace(/\\([&\d\\])/g, (_, c: string) => (c === "&" ? group(0) : c === "\\" ? "\\" : group(Number(c))));
  return chars.slice(0, e8.matchBeginning(0)).join("") + replacement + chars.slice(e8.matchEnd(0)).join("");
}

/** Asks for a regexp and what to replace it with, as dired-mark-read-regexp: with a zero prefix argument, the whole file name. */
function readRegexpOperation(operation: string, run: (regexp: string, newname: string, arg: e8.PrefixArg | null, whole: boolean) => void): void {
  const raw = e8.prefixArg();
  const whole = raw !== null && e8.prefixNumericValue(raw) === 0;
  const arg = whole ? null : raw;
  const abs = whole ? "Abs. " : "";
  const regexp = e8.readString(`${abs}${operation} from (regexp): `, { history: "dired-regexp-history" });
  const newname = e8.readString(`${abs}${operation} ${regexp} to: `);
  run(regexp, newname, arg, whole);
}

for (const [name, operation, creator, keep, doc] of [
  ["dired-do-rename-regexp", "Rename", diredRenameFile, "dired-keep-marker-rename", "Rename the marked files whose names match a regexp, asking about each."],
  ["dired-do-copy-regexp", "Copy", copy, "dired-keep-marker-copy", "Copy the marked files whose names match a regexp to names made from the match, asking about each."],
  ["dired-do-hardlink-regexp", "HardLink", hardlink, "dired-keep-marker-hardlink", "Hard link the marked files whose names match a regexp to names made from the match."],
  ["dired-do-symlink-regexp", "SymLink", symlink, "dired-keep-marker-symlink", "Symlink the marked files whose names match a regexp to names made from the match."],
  ["dired-do-relsymlink-regexp", "RelSymLink", relsymlink, "dired-keep-marker-relsymlink", "Relative symlink the marked files whose names match a regexp to names made from the match."],
] as const) {
  e8.defineCommand({
    name,
    doc: `${doc}\n\nThe new name may hold \\\\& and \\\\N for the match and its groups, as in query-replace-regexp. With a zero prefix argument, the regexp matches the whole file name.`,
    run: () => {
      readRegexpOperation(operation, (regexp, newname, arg, whole) => {
        // As dired-do-copy-regexp, a copy says whether it keeps times, and copies no directories.
        const op = operation === "Copy" && on("dired-copy-preserve-time") ? "Copy [-p]" : operation;
        createFilesRegexp(creator, op, arg, regexp, newname, whole, keptMark(keep));
      });
    },
  });
}

/** Renames each marked file to a name made from the old, asking about each, as dired-rename-non-directory. */
function renameNonDirectory(basename: (name: string) => string, operation: string): void {
  requireDired();
  const { files } = markedFiles(e8.prefixArg());
  const ask = makeQuery();
  createFiles(operation, files, (from) => {
    const to = (e8.fileNameDirectory(from) ?? "") + basename(e8.fileNameNondirectory(from));
    return ask(`${operation} \u2018${e8.fileNameNondirectory(from)}\u2019 to \u2018${e8.fileNameNondirectory(to)}\u2019`) ? to : undefined;
  }, diredRenameFile, keptMark("dired-keep-marker-rename"));
}

e8.defineCommand({
  name: "dired-upcase",
  doc: "Rename the marked files, or the next prefix-argument many, to upper case.",
  run: () => renameNonDirectory((n) => n.toUpperCase(), "Rename upcase"),
});
e8.defineCommand({
  name: "dired-downcase",
  doc: "Rename the marked files, or the next prefix-argument many, to lower case.",
  run: () => renameNonDirectory((n) => n.toLowerCase(), "Rename downcase"),
});

// Marking by what files hold.

/** The buffer visiting a file, as get-file-buffer. */
function fileBuffer(file: string): string | undefined {
  return e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName() === file));
}

e8.defineCommand({
  name: "dired-mark-files-containing-regexp",
  doc:
    "Mark the files whose text matches a regexp; with a prefix argument, unmark them. A file a buffer visits is " +
    "searched in its buffer, unless dired-always-read-filesystem says to read it from disk.",
  params: [{ name: "regexp", prompt: () => `${e8.prefixArg() !== null ? "Unmark" : "Mark"} files containing (regexp): `, history: "dired-regexp-history" }],
  run: (regexp: string) => {
    requireDired();
    const dir = currentDirectory();
    markIf((f) => {
      if (isDot(f.name)) return false;
      const file = dir + f.name;
      if (!e8.fileReadableP(file) || e8.fileDirectoryP(file)) return false;
      e8.message(`Checking ${file}`);
      const buffer = on("dired-always-read-filesystem") ? undefined : fileBuffer(file);
      const text = buffer !== undefined
        ? e8.withCurrentBuffer(buffer, () => e8.bufferSubstringNoProperties(0, e8.bufferSize()))
        : e8.readTextFile(file);
      return e8.stringMatch(regexp, text, { caseFold: caseFoldSearch() }) !== undefined;
    }, "matching file", e8.prefixArg() !== null ? " " : MARKER);
  },
});

// Shell commands.

/** Where `*` or `?` stands alone in a command, as dired--star-or-qmark-p: else -1. */
function isolated(command: string, chars: string): number {
  const re = new RegExp(`(^|[ \\t])([${chars.replace(/./g, "\\$&")}])(?=[ \\t]|$)`);
  const m = re.exec(command);
  if (m) return m.index + m[1].length;
  if (chars.includes("?")) return command.indexOf("`?`");
  return -1;
}

/** Where `char` appears in a command not on its own, which ! asks about first, as dired--need-confirm-positions. */
function needConfirm(command: string, char: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== char) continue;
    const before = i === 0 || /[ \t]/.test(command[i - 1]);
    const after = i === command.length - 1 || /[ \t]/.test(command[i + 1]);
    const quoted = char === "?" && command[i - 1] === "`" && command[i + 1] === "`";
    if (!(before && after) && !quoted) return true;
  }
  return false;
}

/** The shell command line that runs `command` on the files, as dired-shell-stuff-it. */
export function shellStuffIt(command: string, files: string[], onEach: boolean): string {
  const background = /[ \t]*&[ \t]*$/.exec(command);
  if (background) command = command.slice(0, background.index);
  const sequential = /[ \t]*;[ \t]*$/.exec(command);
  if (sequential) command = command.slice(0, sequential.index);
  const parallel = background !== null && sequential === null;
  const separator = parallel ? "& " : "; ";
  const stuff = isolated(command, "*?") >= 0
    ? (x: string) => {
      let result = command;
      for (let at = isolated(result, "*?"); at >= 0; at = isolated(result, "*?")) {
        const len = result.startsWith("`?`", at) ? 3 : 1;
        result = result.slice(0, at) + x + result.slice(at + len);
      }
      return result;
    }
    : (x: string) => `${command} ${x}`;
  const quoted = files.map((f) => shellQuoteArgument(f.startsWith("-") ? `./${f}` : f));
  const line = onEach
    ? quoted.map(stuff).join(separator) + (parallel ? " & wait" : "")
    : stuff(quoted.join(" ")) + (background ? " & wait" : "");
  return line + (background ? "& " : "");
}

/** Runs a shell command on files, as dired-do-shell-command. */
function doShellCommand(command: string, files: string[]): void {
  const onEach = isolated(command, "*") < 0;
  const noSubst = isolated(command, "?") < 0;
  if (!onEach && !noSubst) throw new Error("You can not combine `*' and `?' substitution marks");
  if (on("dired-confirm-shell-command")) {
    for (const char of ["*", "?"]) {
      if (needConfirm(command, char) && !e8.yOrNP(`Confirm--do you mean to use \u2018${char}\u2019 as a wildcard? `)) {
        e8.message("Command canceled");
        return;
      }
    }
  }
  const line = shellStuffIt(command, files, onEach);
  // As shell-command, a line ending in & runs in the background.
  e8.withCurrentBuffer(e8.currentBuffer(), () => e8.call("shell-command", line));
}

// Guessing the command to run, after dired-aux.el's
// dired-guess-shell-alist-default and shell-command-guess.

for (const [name, doc, value] of [
  ["dired-guess-shell-gzip-quiet", "Whether the guessed gzip and gunzip commands are given -q.", true],
  ["dired-guess-shell-znew-switches", "Switches the guessed znew command is given, or nil.", null],
  ["dired-guess-shell-case-fold-search", "Whether the guessing regexps match file names case loosely.", true],
  ["dired-guess-shell-alist-user", "Commands to guess for files, before the default ones: a list of [regexp, command...], each command a string, or a function of the file name giving one.", []],
  ["shell-command-guess-functions", "Functions that guess commands for files, each given the list so far and the files and giving it back with its own added first.", ["shell-command-guess-dired-optional", "shell-command-guess-mailcap", "shell-command-guess-xdg", "shell-command-guess-dired-default", "shell-command-guess-dired-user"]],
  ["dired-shell-command-history", "Commands run with ! and & in Dired, newest first.", []],
] as const) {
  e8.defineVariable({ name, doc, value: value as e8.Value });
}

let gnutarFound: string | null | undefined;
/** GNU tar's name, as dired-guess-shell-gnutar finds it: tar or gtar, if either is GNU's; else nil. */
function gnutar(): string | null {
  if (gnutarFound === undefined) {
    const v = e8.variable("dired-guess-shell-gnutar");
    if (v !== undefined && v !== null && v !== false) gnutarFound = String(v);
    else {
      gnutarFound = null;
      for (const exe of ["tar", "gtar"]) {
        const out = e8.conditionCase(() => e8.callProcess([exe, "--version"]).output, { error: () => "" });
        if (out.includes("GNU tar")) {
          gnutarFound = exe;
          break;
        }
      }
    }
  }
  return gnutarFound;
}
e8.defineVariable({ name: "dired-guess-shell-gnutar", doc: "GNU tar's name if it is installed, as tar or gtar; nil to find it.", value: null });

const gzq = (): string => (e8.variable("dired-guess-shell-gzip-quiet") === false ? "" : " -q");
const znew = (): string => `znew${gzq()} ${String(e8.variable("dired-guess-shell-znew-switches") ?? "")}`.trimEnd();
const sansExt = (file: string): string => file.replace(/\.[^./]*$/, "");
type Guess = string | ((file: string) => string);

/** The default guesses, as dired-guess-shell-alist-default, regexps being Emacs's. */
const GUESS_DEFAULT: [string, ...Guess[]][] = [
  ["\\.tar\\'", () => (gnutar() ? `${gnutar()} xvf` : "tar xvf"),
    (f) => (gnutar() ? `mkdir ${sansExt(f)}; ${gnutar()} -C ${sansExt(f)} -xvf` : `mkdir ${sansExt(f)}; tar -C ${sansExt(f)} -xvf`),
    () => (gnutar() ? `${gnutar()} tvf` : "tar tvf")],
  ["\\.tar\\.Z\\'", () => (gnutar() ? `${gnutar()} zxvf` : "zcat * | tar xvf -"), znew],
  ["\\.t\\(ar\\.\\)?gz\\'", () => (gnutar() ? `${gnutar()} zxvf` : "gunzip -qc * | tar xvf -"),
    (f) => (gnutar() ? `mkdir ${sansExt(f)}; ${gnutar()} -C ${sansExt(f)} -zxvf` : `mkdir ${sansExt(f)}; gunzip -qc * | tar -C ${sansExt(f)} -xvf -`),
    () => `gunzip${gzq()}`, () => (gnutar() ? `${gnutar()} ztvf` : "gunzip -qc * | tar tvf -")],
  ["\\.t\\(ar\\.bz2\\|bz\\)\\'", "bunzip2 -c * | tar xvf -", (f) => `mkdir ${sansExt(f)}; bunzip2 -c * | tar -C ${sansExt(f)} -xvf -`, "bunzip2"],
  ["\\.t\\(ar\\.\\)?xz\\'", "unxz -c * | tar xvf -", (f) => `mkdir ${sansExt(f)}; unxz -c * | tar -C ${sansExt(f)} -xvf -`, "unxz"],
  ["\\(?:\\.tar\\.zst\\|\\.tzst\\)\\'", "unzstd -c ? | tar -xf -"],
  ["\\.zst\\'", "unzstd --rm"],
  ["\\.shar\\.Z\\'", "zcat * | unshar"],
  ["\\.shar\\.g?z\\'", "gunzip -qc * | unshar"],
  ["\\.e?ps\\'", "ghostview", "xloadimage", "lpr"],
  ["\\.e?ps\\.g?z\\'", "gunzip -qc * | ghostview -", () => `gunzip${gzq()}`],
  ["\\.e?ps\\.Z\\'", "zcat * | ghostview -", znew],
  ["\\.patch\\'", () => (e8.fileDirectoryP(String(e8.variable("default-directory") ?? ".") + ".git") ? "cat * | git apply" : "cat * | patch")],
  ["\\.patch\\.g?z\\'", "gunzip -qc * | patch", () => `gunzip${gzq()}`],
  ["\\.patch\\.Z\\'", "zcat * | patch", znew],
  ["\\.\\(?:[0-9]\\|man\\)\\'", () => manCommand("cat * | tbl | nroff -man -h | col -b")],
  ["\\.\\(?:[0-9]\\|man\\)\\.g?z\\'", () => manCommand("gunzip -qc * | tbl | nroff -man -h | col -b"), () => `gunzip${gzq()}`],
  ["\\.[0-9]\\.Z\\'", () => manCommand("zcat * | tbl | nroff -man -h | col -b"), znew],
  ["\\.pod\\'", "perldoc", "pod2man * | nroff -man"],
  ["\\.uu\\'", "uudecode"],
  ["\\.sh\\'", "sh"],
  ["\\.tex\\'", "latex", "tex"],
  ["\\.texi\\(nfo\\)?\\'", "makeinfo", "texi2dvi"],
  ["\\.rpm\\'", "rpm -qilp", "rpm -ivh"],
  ["\\.dia\\'", "dia"],
  ["\\.mgp\\'", "mgp"],
  ["\\.zip\\'", "unzip", "unzip -l", (f) => `unzip${gzq()} -d ${sansExt(f)}`],
  ["\\.zoo\\'", "zoo x//"],
  ["\\.lzh\\'", "lharc x"],
  ["\\.arc\\'", "arc x"],
  ["\\.shar\\'", "unshar"],
  ["\\.rar\\'", "unrar x"],
  ["\\.7z\\'", "7z x"],
  ["\\.g?z\\'", () => `gunzip${gzq()}`],
  ["\\.dz\\'", "dictunzip"],
  ["\\.bz2\\'", "bunzip2"],
  ["\\.xz\\'", "unxz"],
  ["\\.Z\\'", "uncompress", znew],
  ["\\.sign?\\'", "gpg --verify"],
];

/** The optional guesses, viewers and players, as dired-guess-shell-alist-optional. */
const GUESS_OPTIONAL: [string, ...Guess[]][] = [
  ["\\.dvi\\'", "xdvi", "dvips"], ["\\.au\\'", "play"], ["\\.mpe?g\\'\\|\\.avi\\'", "xine -p"], ["\\.ogg\\'", "ogg123"],
  ["\\.mp3\\'", "mpg123"], ["\\.wav\\'", "play"], ["\\.hqx\\'", "mcvert"], ["\\.xbm\\'", "bitmap"], ["\\.gp\\'", "gnuplot"],
  ["\\.p[bgpn]m\\'", "xloadimage"], ["\\.gif\\'", "xloadimage"], ["\\.tif\\'", "xloadimage"], ["\\.png\\'", "display"],
  ["\\.jpe?g\\'", "xloadimage"], ["\\.fig\\'", "xfig"], ["\\.out\\'", "xgraph"], ["\\.pdf\\'", "xpdf"], ["\\.doc\\'", "antiword", "strings"],
];

/** How man reads a local page, as dired's guess for one asks Man-support-local-filenames: man-db's -l, else nroff. */
function manCommand(fallback: string): string {
  const help = e8.conditionCase(() => e8.callProcess(["man", "--help"]).output, { error: () => "" });
  return /--local-file|-l/.test(help) ? "man -l" : fallback;
}

/** The commands an alist guesses for every one of `files`, as dired-guess-default, without repeats. */
function guessFrom(alist: [string, ...Guess[]][], files: string[]): string[] {
  const fold = e8.variable("dired-guess-shell-case-fold-search") !== false;
  const out: string[] = [];
  for (const [regexp, ...commands] of alist) {
    if (!files.every((f) => e8.stringMatch(regexp, f, { caseFold: fold }) !== undefined)) continue;
    for (const c of commands) {
      const command = typeof c === "function" ? c(files[0]!) : typeof c === "string" ? c : String(e8.funcall(c as string, files[0]!));
      if (!out.includes(command)) out.push(command);
    }
  }
  return out;
}

const userAlist = (): [string, ...Guess[]][] => ((e8.variable("dired-guess-shell-alist-user") as unknown as [string, ...Guess[]][] | null) ?? []);
e8.defun("shell-command-guess-dired-user", (commands: string[], files: string[]) => [...guessFrom(userAlist(), files), ...(commands ?? [])]);
e8.defun("shell-command-guess-dired-default", (commands: string[], files: string[]) => [...guessFrom(GUESS_DEFAULT, files), ...(commands ?? [])]);
e8.defun("shell-command-guess-dired-optional", (commands: string[], files: string[]) => [...guessFrom(GUESS_OPTIONAL, files), ...(commands ?? [])]);

/** The file's MIME type, as the file program gives it, for the system's guesses. */
function mimeType(file: string): string | undefined {
  const out = e8.conditionCase(() => e8.callProcess(["file", "--brief", "--mime-type", file]).output.trim(), { error: () => "" });
  return out === "" ? undefined : out;
}

/**
 * What ~/.mailcap and /etc/mailcap say views the files' type, as
 * shell-command-guess-mailcap: each entry's command, "%s" taken out, as
 * mailcap-file-default-commands gives it.
 */
e8.defun("shell-command-guess-mailcap", (commands: string[], files: string[]) => {
  const type = files[0] !== undefined ? mimeType(files[0]) : undefined;
  if (type === undefined) return commands ?? [];
  const found: string[] = [];
  for (const file of [`${e8.getenv("HOME") ?? ""}/.mailcap`, "/etc/mailcap", "/usr/etc/mailcap", "/usr/local/etc/mailcap"]) {
    if (!e8.fileReadableP(file)) continue;
    for (const line of e8.readTextFile(file).split("\n")) {
      if (line.startsWith("#") || !line.includes(";")) continue;
      const [kind, view] = line.split(";").map((p) => p.trim());
      const [major, minor] = (kind ?? "").split("/");
      const [tmajor, tminor] = type.split("/");
      if (major === tmajor && (minor === undefined || minor === "*" || minor === tminor) && view) {
        const command = view.replace(/\s*['"]?%s['"]?/, "").trim();
        if (command && !found.includes(command)) found.push(command);
      }
    }
  }
  return [...found, ...(commands ?? [])];
});

/** The desktop applications XDG says open the files' type, as shell-command-guess-xdg: each one's Exec, its arguments taken off. */
e8.defun("shell-command-guess-xdg", (commands: string[], files: string[]) => {
  if (files[0] === undefined || !executableFind("xdg-mime")) return commands ?? [];
  const run = (args: string[]) => e8.conditionCase(() => e8.callProcess(["xdg-mime", ...args]).output.trim(), { error: () => "" });
  const type = run(["query", "filetype", files[0]]);
  if (type === "") return commands ?? [];
  const desktops = run(["query", "default", type]).split(";").filter((d) => d !== "");
  const dirs = [`${e8.getenv("XDG_DATA_HOME") ?? `${e8.getenv("HOME") ?? ""}/.local/share`}`, ...(e8.getenv("XDG_DATA_DIRS") ?? "/usr/local/share:/usr/share").split(":")];
  const found: string[] = [];
  for (const desktop of desktops) {
    for (const dir of dirs) {
      const path = `${dir}/applications/${desktop}`;
      if (!e8.fileReadableP(path)) continue;
      const exec = /^Exec=(\S+)/m.exec(e8.readTextFile(path));
      if (exec && !found.includes(exec[1]!)) found.push(exec[1]!);
      break;
    }
  }
  return [...found, ...(commands ?? [])];
});

e8.defineVariable({
  name: "shell-command-guess-open",
  doc: "A command that opens a file with the program the system chooses: xdg-open if there is one, else open on macOS.",
  value: (executableFind("xdg-open") ? "xdg-open" : e8.variable("system-type") === "darwin" || e8.variable("system-type") === "gnu/linux" ? "open" : null) as e8.Value,
});
/** The system's own opener, as shell-command-guess-open. */
e8.defun("shell-command-guess-open", (commands: string[]) => {
  const open = e8.variable("shell-command-guess-open");
  return typeof open === "string" ? [open, ...(commands ?? [])] : (commands ?? []);
});

/** The commands guessed for files, as shell-command-guess: each of shell-command-guess-functions in turn. */
export function shellCommandGuess(files: string[]): string[] {
  let commands: string[] = [];
  const fns = (e8.variable("shell-command-guess-functions") as string[] | null) ?? [];
  for (const fn of fns) commands = (e8.funcall(fn, commands as unknown as e8.Value, files as unknown as e8.Value) as unknown as string[]) ?? commands;
  return commands;
}

/**
 * Reads a shell command for files, as dired-guess-shell-command: with
 * guesses, the first in the prompt, "{N guesses}" if more, all on M-n,
 * and empty input taking the first.
 */
function guessShellCommand(prompt: string, files: string[]): string {
  const guesses = shellCommandGuess(files);
  if (guesses.length === 0) return e8.readString(prompt, { history: "dired-shell-command-history" });
  let p = prompt.replace(/: $/, " ");
  if (guesses.length > 1) p += `{${guesses.length} guesses} `;
  p += `[${guesses[0]}]: `;
  const value = e8.completingRead(p, guesses, { history: "dired-shell-command-history", default: guesses[0] });
  return value === "" ? guesses[0]! : value;
}

/** Reads a command to run on the marked files, as dired-read-shell-command, then runs it. */
function readAndRunShellCommand(prefix: string, async: boolean): void {
  requireDired();
  const arg = e8.prefixArg();
  const dir = currentDirectory();
  const { files } = markedFiles(arg, MARKER, false, "No files specified");
  const relative = files.map((f) => f.startsWith(dir) ? f.slice(dir.length) : f);
  let command = guessShellCommand(`${prefix} on ${markPrompt(arg, files)}: `, relative);
  if (async && !/&[ \t]*$/.test(command)) command += " &";
  doShellCommand(command, relative);
}

e8.defineCommand({
  name: "dired-do-shell-command",
  doc:
    "Run a shell command on the marked files, or the one on this line.\n\n" +
    "A * on its own in the command stands for all the files, and runs it once; a ? on its own runs it on each file, " +
    "standing for its name; otherwise each file's name goes on the end, a run for each. A command ending in & runs " +
    "in the background.",
  run: () => readAndRunShellCommand("!", false),
});
e8.defineCommand({
  name: "dired-do-async-shell-command",
  doc: "Run a shell command on the marked files in the background, as ! does with & on the end.",
  run: () => readAndRunShellCommand("&", true),
});

e8.defineCommand({
  name: "dired-show-file-type",
  doc: "Say what kind of file is on this line, as the file program tells it. With a prefix argument, what a link points to.",
  run: () => {
    requireDired();
    const file = filenameAt();
    if (file === undefined) throw new Error("No file on this line");
    const name = e8.fileNameNondirectory(file);
    const args = e8.prefixArg() !== null ? ["-L", "--", name] : ["--", name];
    const { output } = e8.callProcess(["file", ...args], { directory: currentDirectory() });
    e8.message(output.endsWith("\n") ? output.slice(0, -1) : output);
  },
});

// Modes, owners and times.

/** A mode from a symbolic one as chmod takes it, u+x,go=r, applied to `from`, as file-modes-symbolic-to-number. */
export function fileModesSymbolicToNumber(modes: string, from = 0): number {
  let mode = from;
  for (const clause of modes.split(",")) {
    const m = /^([ugoa]*)((?:[-+=](?:[rwxXst]*|[ugo]))+)$/.exec(clause);
    if (!m) throw new Error(`Parse error in modes near \u2018${clause}\u2019`);
    const who = m[1] === "" || m[1].includes("a") ? "ugo" : m[1];
    const whoMask = (who.includes("u") ? 0o4700 : 0) | (who.includes("g") ? 0o2070 : 0) | (who.includes("o") ? 0o1007 : 0);
    for (const action of m[2].match(/[-+=][^-+=]*/g) ?? []) {
      const op = action[0];
      const perms = action.slice(1);
      let bits = 0;
      if (/^[ugo]$/.test(perms)) {
        const shift = perms === "u" ? 6 : perms === "g" ? 3 : 0;
        const p = (mode >> shift) & 7;
        bits = p | (p << 3) | (p << 6);
      } else {
        for (const c of perms) {
          if (c === "r") bits |= 0o444;
          else if (c === "w") bits |= 0o222;
          else if (c === "x") bits |= 0o111;
          else if (c === "X" && (mode & 0o111 || (from & 0o40000))) bits |= 0o111;
          else if (c === "s") bits |= 0o6000;
          else if (c === "t") bits |= 0o1000;
        }
      }
      bits &= whoMask;
      if (op === "+") mode |= bits;
      else if (op === "-") mode &= ~bits;
      else mode = (mode & ~(whoMask & 0o7777)) | bits;
    }
  }
  return mode;
}

/** The files a change acts on, and their lines listed again afterwards, as dired-do-redisplay. */
function changeFiles(change: (files: string[]) => void): void {
  requireDired();
  const { files } = markedFiles(e8.prefixArg());
  change(files);
  readin(true);
}

e8.defineCommand({
  name: "dired-do-chmod",
  doc: "Change the mode of the marked files, or the one on this line: octal, as 644, or symbolic, as g+w. M-n brings this file's.",
  run: () => {
    changeFiles((files) => {
      const here = filenameAt();
      const modes = here === undefined ? undefined : e8.fileAttributes(here)?.modes;
      const m = modes && /^.(...)(...)(...)$/.exec(modes);
      const dflt = m ? `u=${m[1]},g=${m[2]},o=${m[3]}`.replace(/-/g, "") : undefined;
      const input = e8.readString(`Change mode of ${markPrompt(e8.prefixArg(), files)} to: `, { default: dflt });
      if (input === "") throw new Error("No file mode specified");
      const octal = /^[0-7]+/.test(input) ? parseInt(input, 8) : undefined;
      for (const file of files) {
        e8.setFileModes(file, octal ?? fileModesSymbolicToNumber(input, e8.fileModes(file) ?? 0));
      }
    });
  },
});

/** A time as touch -t takes it, as format-time-string's %Y%m%d%H%M.%S. */
function touchTime(ms: number): string {
  return e8.formatTimeString("%Y%m%d%H%M.%S", ms / 1000);
}

/** Changes an attribute of the marked files by running a program on them, as dired-do-chxxx. */
function doChxxx(attribute: string, program: string, op: "touch" | "chown" | "chgrp"): void {
  changeFiles((files) => {
    const dir = currentDirectory();
    const here = filenameAt();
    const attrs = here === undefined ? undefined : e8.fileAttributes(here);
    let dflt: string | undefined;
    if (attrs && op === "touch") dflt = touchTime(attrs.modified);
    else if (attrs && op === "chown") dflt = attrs.user;
    else if (attrs && op === "chgrp") dflt = attrs.group;
    const prompt = op === "touch" ? `Change ${attribute} of ${markPrompt(e8.prefixArg(), files)} to (default now): ` : `Change ${attribute} of ${markPrompt(e8.prefixArg(), files)} to: `;
    const value = e8.readString(prompt, { default: op === "touch" ? undefined : dflt });
    const args = value === "" ? [] : op === "touch" ? ["-t", value] : [value];
    const relative = files.map((f) => f.startsWith(dir) ? f.slice(dir.length) : f);
    const { exit, output } = e8.callProcess([program, ...args, ...relative], { directory: dir });
    if (exit !== 0) e8.message(`${program} ${value}: error${output.trim() === "" ? "" : `: ${output.trim()}`}`);
  });
}

e8.defineCommand({ name: "dired-do-touch", doc: "Change the times of the marked files, or the one on this line, with touch: to now, or a time written as touch -t takes it.", run: () => doChxxx("Timestamp", String(e8.variable("dired-touch-program")), "touch") });
e8.defineCommand({ name: "dired-do-chown", doc: "Change the owner of the marked files, or the one on this line.", run: () => doChxxx("Owner", String(e8.variable("dired-chown-program")), "chown") });
e8.defineCommand({ name: "dired-do-chgrp", doc: "Change the group of the marked files, or the one on this line.", run: () => doChxxx("Group", "chgrp", "chgrp") });

// Compressing.

/** How Z treats names, as dired-compress-file-suffixes: [regexp, what replaces it, the program that uncompresses]. */
const COMPRESS_SUFFIXES: [RegExp, string, string | undefined][] = [
  [/\.tar\.gz$/, "", "gzip -dc %i | tar -xf -"],
  [/\.tar\.xz$/, "", "xz -dc %i | tar -xf -"],
  [/\.tgz$/, "", "gzip -dc %i | tar -xf -"],
  [/\.gz$/, "", "gzip -d"],
  [/\.lz$/, "", "lzip -d"],
  [/\.Z$/, "", "uncompress"],
  [/\.z$/, "", "gzip -d"],
  [/\.tbz$/, ".tar", "bunzip2"],
  [/\.bz2$/, "", "bunzip2"],
  [/\.xz$/, "", "unxz"],
  [/\.zip$/, "", "unzip -o -d %o %i"],
  [/\.tar\.zst$/, "", "unzstd -c %i | tar -xf -"],
  [/\.tzst$/, "", "unzstd -c %i | tar -xf -"],
  [/\.zst$/, "", "unzstd --rm"],
  [/\.7z$/, "", "7z x -aoa -o%o %i"],
  [/\.tar$/, ".tgz", undefined],
];

/** Runs a shell command in `dir`, failing with its output if it fails. */
function runShell(command: string, dir: string): void {
  const shell = String(e8.variable("shell-file-name"));
  const { exit, output } = e8.callProcess([shell, "-c", command], { directory: dir });
  if (exit !== 0) throw new Error(`${command}: ${output.trim()}`);
}

/** Compresses or uncompresses a file, as dired-compress-file: the new file's name, or undefined if nothing changed. */
export function compressFile(file: string): string | undefined {
  if (e8.fileSymlinkP(file) !== undefined) return undefined;
  const dir = e8.fileNameDirectory(file) ?? "/";
  const rule = COMPRESS_SUFFIXES.find(([re]) => re.test(file));
  const newname = rule ? file.replace(rule[0], rule[1]) : undefined;
  if (rule && rule[2] !== undefined && newname !== undefined) {
    const command = rule[2];
    if (/%[io]/.test(command)) {
      const out = e8.fileNameAsDirectory(newname);
      runShell(command.replace("%o", shellQuoteArgument(out)).replace("%i", shellQuoteArgument(file)), dir);
      return out;
    }
    e8.message(`Uncompressing ${file}`);
    runShell(`${command} ${shellQuoteArgument(file)}`, dir);
    return newname;
  }
  if (e8.fileDirectoryP(file)) {
    const out = file + String(e8.variable("dired-compress-directory-default-suffix"));
    runShell(`tar -cf - ${shellQuoteArgument(e8.fileNameNondirectory(file))} | gzip -c9 > ${shellQuoteArgument(out)}`, dir);
    return out;
  }
  const out = newname ?? `${file}.gz`;
  e8.message(`Compressing ${file}`);
  if (newname !== undefined) runShell(`gzip -c9 < ${shellQuoteArgument(file)} > ${shellQuoteArgument(newname)} && rm -f ${shellQuoteArgument(file)}`, dir);
  else runShell(`gzip -f9 ${shellQuoteArgument(file)}`, dir);
  return out;
}

e8.defineCommand({
  name: "dired-do-compress",
  doc:
    "Compress or uncompress the marked files, or the one on this line: gzip a file, make a directory a .tar.gz, " +
    "and unpack an archive, .tar.gz, .zip and the like.",
  run: () => {
    requireDired();
    const arg = e8.prefixArg();
    const { files } = markedFiles(arg);
    let done = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        if (compressFile(file) !== undefined) done++;
      } catch (e) {
        // Logged, as dired-map-over-marks-check logs each failure.
        failures.push(file);
        diredLog(`Compress or uncompress \u2018${e8.fileNameNondirectory(file)}\u2019 failed:\n${String((e as Error).message ?? e)}\n`);
      }
    }
    readin(true);
    const total = files.length;
    if (failures.length > 0) logSummary(`Compress or uncompress: ${failures.length} of ${total} file${total === 1 ? "" : "s"} failed`, failures);
    else e8.message(`Compress or uncompress: ${done} file${done === 1 ? "" : "s"}`);
  },
});

// Searching the marked files.

/** The marked files that are not directories, to search. */
function searchFiles(): string[] {
  requireDired();
  return markedFiles(e8.prefixArg()).files.filter((f) => !e8.fileDirectoryP(f));
}

e8.defineCommand({
  name: "dired-do-find-regexp",
  doc: "Find the matches of a regexp in the marked files, listing them in an *xref* buffer.",
  params: [{ name: "regexp", prompt: "Search marked files (regexp): ", history: "regexp-history" }],
  run: (regexp: string) => {
    const dir = currentDirectory();
    const files = searchFiles().map((f) => f.startsWith(dir) ? f.slice(dir.length) : f);
    const xrefs = matchesInFiles(regexp, files, dir);
    if (xrefs.length === 0) e8.userError(`No matches for: ${regexp}`);
    e8.funcall("xref-show-xrefs", xrefs);
  },
});

e8.defineCommand({
  name: "dired-do-query-replace-regexp",
  doc:
    "Replace the matches of a regexp in the marked files, asking about each, as query-replace-regexp does, file by file.\n\n" +
    "Y replaces the rest in every file without asking, N goes on to the next file. If you stop, " +
    "M-x fileloop-continue goes on where you left off. With a prefix argument, only whole words.",
  params: [
    { name: "from", prompt: "Query replace regexp in marked files: ", history: "query-replace-history" },
    { name: "to", prompt: (from) => `Query replace regexp in marked files ${from} with: `, history: "query-replace-history" },
    { name: "delimited", kind: "prefix" },
  ],
  run: (from: string, to: string, delimited: e8.PrefixArg) => {
    const files = searchFiles();
    // As dired-do-query-replace-regexp: a file visited read-only is refused.
    for (const file of files) {
      const buffer = fileBuffer(file);
      if (buffer !== undefined && e8.withCurrentBuffer(buffer, () => e8.bufferReadOnly())) {
        throw new Error(`File \u2018${file}\u2019 is visited read-only`);
      }
    }
    fileloopInitializeReplace(from, to, files, from === from.toLowerCase() ? false : "default", delimited !== null);
    fileloopContinue();
  },
});

e8.defineCommand({
  name: "dired-do-search",
  doc: "Search the marked files for a regexp, stopping at the first match; M-x fileloop-continue finds the next.",
  params: [{ name: "regexp", prompt: "Search marked files (regexp): ", history: "regexp-history" }],
  run: (regexp: string) => {
    fileloopInitializeSearch(regexp, searchFiles(), "default");
    fileloopContinue();
  },
});

const auxBindings: [string, e8.CommandName][] = [
  ["S", "dired-do-symlink"], ["Y", "dired-do-relsymlink"], ["H", "dired-do-hardlink"],
  ["% R", "dired-do-rename-regexp"], ["% r", "dired-do-rename-regexp"], ["% C", "dired-do-copy-regexp"], ["% c", "dired-do-copy-regexp"],
  ["% H", "dired-do-hardlink-regexp"], ["% h", "dired-do-hardlink-regexp"], ["% S", "dired-do-symlink-regexp"], ["% s", "dired-do-symlink-regexp"],
  ["% Y", "dired-do-relsymlink-regexp"], ["% y", "dired-do-relsymlink-regexp"],
  ["% u", "dired-upcase"], ["% l", "dired-downcase"], ["% g", "dired-mark-files-containing-regexp"],
  ["!", "dired-do-shell-command"], ["X", "dired-do-shell-command"], ["&", "dired-do-async-shell-command"],
  ["y", "dired-show-file-type"], ["M", "dired-do-chmod"], ["O", "dired-do-chown"], ["G", "dired-do-chgrp"], ["T", "dired-do-touch"],
  ["Z", "dired-do-compress"], ["A", "dired-do-find-regexp"], ["Q", "dired-do-query-replace-regexp"],
];
for (const [keys, command] of auxBindings) e8.defineKey("dired-mode-map", keys, command);
