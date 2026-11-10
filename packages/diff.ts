// Comparing files, after Emacs's diff.el and diff-mode.el: M-x diff runs
// diff on two files into *Diff*, diff-buffer-with-file compares a buffer
// with its file, and diff-mode colours the hunks, moves between them with
// n and p, and goes to the source with RET.

import { escapeRegExp, PerBuffer } from "subr";

for (const [name, doc, value] of [
  ["diff-command", "The program M-x diff runs.", "diff"],
  ["diff-switches", "The options M-x diff gives diff: a string or a list of strings.", "-u"],
] as const) {
  e8.defineVariable({ name, doc, value });
}

// As diff-mode.el's, a background for light frames and one for dark: on a
// dark theme's background the light ones leave the text unreadable.
for (const [name, doc, attributes, light, dark] of [
  ["diff-header", "Hunk headers in diff-mode.", { extend: true }, { background: "#d9d9d9" }, { background: "#737373" }],
  ["diff-file-header", "The lines naming the files in diff-mode.", { bold: true, extend: true }, { background: "#bfbfbf" }, { background: "#999999" }],
  ["diff-hunk-header", "The @@ line starting each hunk in diff-mode.", { inherit: "diff-header" }, {}, {}],
  ["diff-removed", "Lines a diff takes away.", { extend: true }, { background: "#ffdddd" }, { background: "#553333" }],
  ["diff-added", "Lines a diff adds.", { extend: true }, { background: "#ddffdd" }, { background: "#335533" }],
  ["diff-context", "Lines a diff leaves as they are.", {}, {}, {}],
] as const) {
  e8.defineFace({ name, doc, attributes: attributes as e8.FaceAttributes, light, dark });
}
e8.defineFace({ name: "diff-indicator-removed", doc: "The - starting a line a diff takes away.", attributes: { inherit: "diff-removed" } as e8.FaceAttributes });
e8.defineFace({ name: "diff-indicator-added", doc: "The + starting a line a diff adds.", attributes: { inherit: "diff-added" } as e8.FaceAttributes });

/** The current time as current-time-string writes it: "Sat Oct 31 03:30:00 2026". */
function currentTimeString(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}

/** A shell word quoted as shell-quote-argument quotes it. */
const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * Runs diff on two files into a buffer, as diff-no-select: the command on
 * the first line, then diff's output, then whether they differed. `labels`
 * names files that stand for something else, as --label does.
 */
export function diffNoSelect(oldFile: string, newFile: string, labels?: [string, string], buffer = "*Diff*"): string {
  const switchesValue = e8.variable("diff-switches");
  const switches = Array.isArray(switchesValue) ? switchesValue.map(String) : typeof switchesValue === "string" ? switchesValue.split(/\s+/).filter(Boolean) : [];
  const args = [...switches, ...(labels ? ["--label", labels[0], "--label", labels[1]] : []), oldFile, newFile];
  const program = String(e8.variable("diff-command") ?? "diff");
  const command = [program, ...args.map(shellQuote)].join(" ");
  const dir = e8.expandFileName(".");
  e8.getBufferCreate(buffer);
  const result = e8.callProcess([program, ...args]);
  e8.withCurrentBuffer(buffer, () => {
    if (e8.variable("major-mode") !== "diff-mode") e8.call("diff-mode");
    e8.setVariable("default-directory", dir.endsWith("/") ? dir : `${dir}/`);
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.insert(`${command}\n`);
      e8.insert(result.output);
      const status = result.exit === 0 ? " (no differences)" : result.exit === 1 ? "" : ` (diff error, exit status ${result.exit})`;
      e8.insert(`\nDiff finished${status}.  ${currentTimeString()}\n`);
    });
    e8.gotoChar(e8.pointMin());
    e8.setBufferModified(false);
    diffBuffers.set(buffer, { oldFile, newFile, labels });
  });
  return buffer;
}

/** What each diff buffer compared, to make it again with g. */
const diffBuffers = new PerBuffer<{ oldFile: string; newFile: string; labels?: [string, string] }>();

/** The newest numbered or plain backup of a file, as diff-latest-backup-file finds it. */
function latestBackup(file: string): string | undefined {
  const dir = file.replace(/[^/]*$/, "");
  const base = file.replace(/.*\//, "");
  const names = e8.directoryFiles(dir).filter((n) => n === `${base}~` || new RegExp(`^${escapeRegExp(base)}\\.~\\d+~$`).test(n));
  if (names.length === 0) return undefined;
  const version = (n: string) => Number(/\.~(\d+)~$/.exec(n)?.[1] ?? 0);
  names.sort((a, b) => version(b) - version(a));
  return dir + names[0];
}

e8.defineCommand({
  name: "diff",
  doc: "Compare two files with diff, showing the differences in *Diff*. The new file is this buffer's by default, the old one its backup.",
  run: async () => {
    const own = e8.bufferFileName();
    const newFile = e8.expandFileName(await e8.readFileName("Diff new file: ", { default: own, initial: own === undefined ? undefined : "" }) || own || "");
    const backup = latestBackup(newFile);
    const oldAnswer = await e8.readFileName(`Diff original file${backup === undefined ? "" : ` (default ${backup.replace(/.*\//, "")})`}: `, { default: backup });
    const oldFile = e8.expandFileName(oldAnswer || backup || "");
    if (e8.fileDirectoryP(newFile) || e8.fileDirectoryP(oldFile)) e8.userError("diff of directories is not supported here");
    e8.call("display-buffer", diffNoSelect(oldFile, newFile));
  },
});

e8.defineCommand({
  name: "diff-backup",
  doc: "Compare a file with its newest backup.",
  params: [{ name: "file", kind: "file", prompt: "Diff (file with backup): " }],
  run: (file: string) => {
    const path = e8.expandFileName(file);
    const backup = latestBackup(path);
    if (backup === undefined) e8.userError(`No backup found for ${path}`);
    e8.call("display-buffer", diffNoSelect(backup!, path));
  },
});

e8.defineCommand({
  name: "diff-buffer-with-file",
  doc: "Compare a buffer with the file it visits, to see what saving would change.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Buffer: " }],
  run: (buffer: string) => {
    const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName());
    if (file === undefined) e8.userError(`Buffer ${buffer} has no associated file on disk`);
    const text = e8.withCurrentBuffer(buffer, () => e8.saveRestriction(() => {
      e8.widen();
      return e8.bufferText(e8.pointMin(), e8.pointMax());
    }));
    const temp = e8.makeTempFile("buffer-content-", { text });
    try {
      e8.call("display-buffer", diffNoSelect(file!, temp, [file!, buffer]));
    } finally {
      // Gone for good, as a temporary file of diff's own, not to the trash.
      e8.deleteFile(temp);
    }
  },
});

// diff-mode.

const HUNK = "^@@ -\\([0-9]+\\)\\(?:,\\([0-9]+\\)\\)? \\+\\([0-9]+\\)\\(?:,\\([0-9]+\\)\\)? @@";
const FILE = "^--- ";

/** Colours the lines of a diff from start to end, as diff-mode's font-lock keywords. */
function fontify(start: number, end: number): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.lineBeginningPosition(start));
    while (e8.point() < end && e8.point() < e8.pointMax()) {
      const bol = e8.point();
      const eol = e8.lineEndPosition();
      const line = e8.bufferSubstringNoProperties(bol, eol);
      const to = Math.min(eol + 1, e8.pointMax());
      let face: string | undefined;
      if (/^@@ /.test(line)) face = "diff-hunk-header";
      else if (/^(---|\+\+\+) /.test(line)) face = "diff-file-header";
      else if (/^-/.test(line)) face = "diff-removed";
      else if (/^\+/.test(line)) face = "diff-added";
      else if (/^(diff |Only in |Diff finished)/.test(line)) face = "diff-header";
      if (face !== undefined) e8.putTextProperty(bol, to, "face", face);
      e8.gotoChar(to);
      if (to >= e8.pointMax()) break;
    }
  });
}

/** Moves to the `n`th next hunk header, back if negative, as diff-hunk-next. */
function hunkNext(n: number, regexp = HUNK, what = "hunk"): void {
  for (let i = 0; i < Math.abs(n); i++) {
    if (n > 0) {
      const at = e8.saveExcursion(() => {
        if (e8.lookingAt(regexp)) e8.gotoChar(e8.lineEndPosition());
        return e8.reSearchForward(regexp, { noerror: true }) === undefined ? undefined : e8.matchBeginning(0);
      });
      if (at === undefined) e8.userError(`No next ${what}`);
      e8.gotoChar(at!);
    } else {
      const at = e8.saveExcursion(() => (e8.reSearchBackward(regexp, { noerror: true }) === undefined ? undefined : e8.point()));
      if (at === undefined) e8.userError(`No previous ${what}`);
      e8.gotoChar(at!);
    }
  }
}

/** The file a diff names, without the date diff puts after a tab. */
const fileName = (line: string): string => line.slice(4).replace(/\t.*$/, "");

/** The file and line in it the diff's line at point stands for, in the new file or with `old` the old one, as diff-find-source-location. */
function sourceLocation(old: boolean): [string, number] {
  return e8.saveExcursion(() => {
    const here = e8.lineBeginningPosition();
    if (!e8.lookingAt(HUNK) && e8.reSearchBackward(HUNK, { noerror: true }) === undefined) e8.userError("Not in a hunk");
    e8.gotoChar(e8.lineBeginningPosition());
    e8.lookingAt(HUNK);
    let line = Number(e8.matchString(old ? 1 : 3));
    const hunkStart = e8.point();
    const files = e8.saveExcursion(() => {
      if (e8.reSearchBackward(FILE, { noerror: true }) === undefined) e8.userError("Can't find the file this hunk is for");
      const from = fileName(e8.bufferSubstringNoProperties(e8.point(), e8.lineEndPosition()));
      e8.gotoChar(Math.min(e8.lineEndPosition() + 1, e8.pointMax()));
      const to = fileName(e8.bufferSubstringNoProperties(e8.point(), e8.lineEndPosition()));
      return [from, to];
    });
    // Count the lines before point in the hunk that are in the file wanted.
    e8.gotoChar(Math.min(e8.lineEndPosition() + 1, e8.pointMax()));
    while (e8.point() < here && e8.point() > hunkStart) {
      const c = e8.charAfter(e8.point());
      if (c === " " || (old ? c === "-" : c === "+")) line++;
      e8.gotoChar(Math.min(e8.lineEndPosition() + 1, e8.pointMax()));
    }
    return [old ? files[0]! : files[1]!, line];
  });
}

/** Goes to the source of the diff's line at point, in another window, as diff-goto-source. */
function gotoSource(old: boolean, select: boolean): void {
  const [file, line] = sourceLocation(old);
  const dir = String(e8.variable("default-directory") ?? "");
  const path = e8.expandFileName(file, dir || undefined);
  if (!e8.fileExistsP(path)) e8.userError(`Can't find the source file ${file}`);
  const buffer = e8.findFileNoselect(path);
  const diffWindow = e8.selectedWindow();
  e8.call("switch-to-buffer-other-window", buffer);
  e8.gotoChar(e8.lineStart(Math.max(0, Math.min(line - 1, e8.lineCount() - 1))));
  if (!select) e8.selectWindow(diffWindow);
}

for (const [name, doc, run] of [
  ["diff-hunk-next", "Move to the next hunk; with a prefix argument, that many.", () => hunkNext(e8.prefixNumericValue())],
  ["diff-hunk-prev", "Move to the hunk before; with a prefix argument, that many back.", () => hunkNext(-e8.prefixNumericValue())],
  ["diff-file-next", "Move to the next file's part of the diff.", () => hunkNext(e8.prefixNumericValue(), FILE, "file")],
  ["diff-file-prev", "Move to the file's part of the diff before.", () => hunkNext(-e8.prefixNumericValue(), FILE, "file")],
  ["diff-goto-source", "Go to the line of the source this line of the diff is for, in another window; with a prefix argument, in the old file.", () => gotoSource(e8.prefixArg() !== null, true)],
  ["diff-revert-buffer", "Run the diff again.", () => {
    const d = diffBuffers.get(e8.bufferName());
    if (d !== undefined) diffNoSelect(d.oldFile, d.newFile, d.labels, e8.bufferName());
  }],
] as const) {
  e8.defineCommand({ name, doc, run });
}

e8.defineMajorMode({
  name: "diff-mode",
  modeName: "Diff",
  doc: "The mode of a diff: n and p go between hunks, N and P between files, RET and o go to the source line, g runs the diff again, q quits.",
  bindings: {
    n: "diff-hunk-next",
    p: "diff-hunk-prev",
    "M-n": "diff-hunk-next",
    "M-p": "diff-hunk-prev",
    N: "diff-file-next",
    P: "diff-file-prev",
    "}": "diff-file-next",
    "{": "diff-file-prev",
    RET: "diff-goto-source",
    o: "diff-goto-source",
    "C-c C-c": "diff-goto-source",
    g: "diff-revert-buffer",
    q: "quit-window",
  } as Record<string, e8.CommandName>,
  setup: () => {
    e8.setReadOnly(true);
    e8.addHook("jit-lock-functions", fontify, { local: true });
  },
});
// Files named as diffs and patches open in diff-mode, as auto-mode-alist has them.
const alist = e8.defaultValue("auto-mode-alist");
e8.setDefault("auto-mode-alist", [...(Array.isArray(alist) ? alist : []), ["\\.\\(?:diffs?\\|patch\\|rej\\)\\'", "diff-mode"]]);
