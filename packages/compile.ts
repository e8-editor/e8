// Compiling and finding errors, after Emacs's compile.el and grep.el, with
// next-error from simple.el. M-x compile runs a shell command, make -k by
// default, in the background, its output going into *compilation*, where
// the error messages it finds are highlighted; M-g n (next-error) visits
// the next one's file at its line, and M-g p the one before. M-x grep does
// the same for grep's hits, in *grep*. In those buffers RET visits the
// message at point, n and p visit the next and previous while keeping the
// buffer selected, M-n and M-p move between messages, g runs the command
// again, and C-c C-k kills it.

import { truthy, numberValue as num } from "subr";

// --- Faces and variables ----------------------------------------------------

for (const [name, doc, attributes] of [
  ["compilation-error", "Error messages' file names in compilation buffers.", { foreground: "bad", bold: true }],
  ["compilation-warning", "Warnings' file names in compilation buffers.", { foreground: "warn", bold: true }],
  ["compilation-info", "Notes' file names, and grep's hits, in compilation buffers.", { foreground: "good" }],
  ["compilation-line-number", "Line numbers in compilation messages.", { foreground: "accent-ink" }],
  ["compilation-column-number", "Column numbers in compilation messages.", { foreground: "muted" }],
  ["compilation-mode-line-exit", "How a compilation that succeeded ended.", { foreground: "good", bold: true }],
  ["compilation-mode-line-fail", "How a compilation that failed ended.", { foreground: "bad", bold: true }],
  ["next-error", "The line next-error goes to, for a moment.", { inherit: "region" }],
  ["grep-match", "What grep matched.", { inherit: "match" }],
] as const) {
  e8.defineFace({ name, doc, attributes });
}

const defvar = (name: string, value: e8.Value, doc: string, local = false) => e8.defineVariable({ name, value, doc, local });
defvar("compile-command", "make -k ", "The command M-x compile offers to run.");
defvar("compilation-read-command", true, "Whether M-x compile asks for the command, rather than running compile-command.");
defvar("compilation-ask-about-save", true, "Whether M-x compile asks before saving modified buffers; if nil, it saves them without asking.");
defvar("compilation-scroll-output", false, "Whether the compilation buffer's window follows the output as it comes; first-error stops at the first error.");
defvar("compilation-always-kill", false, "Whether starting a compilation kills one still running without asking.");
defvar(
  "compilation-skip-threshold",
  1,
  "Which messages next-error and M-n go to: 2 errors only, 1 warnings and errors, 0 notes as well.",
);
defvar(
  "compilation-error-regexp-alist",
  ["gnu", "python-tracebacks-and-caml", "typescript-tsc-pretty", "cargo"],
  "The names of the message formats in compilation-error-regexp-alist-alist that compilation buffers look for.",
  true,
);
defvar("compilation-directory", null, "The directory the compilation ran in, which its messages' file names are relative to.", true);
defvar("compilation-arguments", null, "The command and mode of this compilation buffer's compilation, for recompile.", true);
defvar("compilation-error", "error", "What a message is called, in \"Past last error\".", true);
defvar("compilation-first-column", 1, "The number of a line's first column in messages: 1, or 0 for grep.", true);
defvar("compilation-environment", [], "Variables to set in the compilation's environment, as \"NAME=value\" strings.");
defvar("compilation-buffer-name-function", null, "A command naming the compilation buffer, or nil for *compilation*, *grep* and so on.");
defvar(
  "next-error-function",
  null,
  "The function, named with e8.defun, that visits the next message's place in this buffer, as next-error calls it, in this buffer: with a count, and whether to start over.",
  true,
);
defvar("next-error-last-buffer", null, "The buffer next-error used last, which it uses again.");
defvar("next-error-highlight", 0.5, "How many seconds next-error highlights the line it goes to, t to keep it until the next command, or nil not to.");
defvar("next-error-verbose", true, "Whether next-error always says which buffer it used.");
defvar("grep-command", "grep --color=auto -nH --null -e ", "The command M-x grep offers to run.");
e8.defineHook("compilation-start-hook", "Run with the process just started, in its compilation buffer.");
e8.defineHook("compilation-finish-functions", "Called with the compilation buffer and how it ended, as \"finished\\n\", when a compilation ends.");
e8.defineHook("compilation-filter-hook", "Run in the compilation buffer after output is inserted.");
e8.defineHook("next-error-hook", "Run after next-error visits a message's place.");

/** How many characters, as buffer positions count them, the first `i` UTF-16 units of `s` are. */
const chars = (s: string, i = s.length): number => [...s.slice(0, i)].length;


// --- Message formats ---------------------------------------------------------

/** A message format: a regexp with named groups file, line, col and warn or info, and what a match is. */
type Format = { re: RegExp; type: 0 | 1 | 2 };

/**
 * The formats, as Emacs's compilation-error-regexp-alist-alist, written as
 * JavaScript regexps. cargo is rust-mode's, which Emacs leaves to it.
 */
const FORMATS: { [name: string]: Format } = {
  // [PROGRAM:]FILE:LINE[-ENDLINE][:COL[-ENDCOL]]: [warning|note|error] MESSAGE
  gnu: {
    re: new RegExp(
      "^(?:[A-Za-z][A-Za-z0-9.-]+: ?| +\\|)?" +
        "(?<file>(?:[^0-9\\n\\t ]|[0-9]+[^0-9\\n])(?:[^\\n :]| [^\\-/\\n]|:[^ \\n])*?): ?" +
        "(?<line>[0-9]+)(?:-[0-9]+(?:\\.[0-9]+)?|[.:](?<col>[0-9]+)(?:-(?:[0-9]+\\.)?[0-9]+)?)?:" +
        "(?: *(?<warn>FutureWarning|RuntimeWarning|Warning|warning|W:)" +
        "| *(?<info>Informational|informational|Information|information|Info|info|I:|instantiated from|required from|Note|note|\\[ skipping .+ \\])" +
        "| *(?:Error|error)|[0-9]?(?:[^0-9\\n]|$)|[0-9]{3})",
    ),
    type: 2,
  },
  "python-tracebacks-and-caml": {
    re: /^[ \t]*File ("?)(?<file>[^," \n\t<>]+)\1, lines? (?<line>[0-9]+)/,
    type: 2,
  },
  "typescript-tsc-pretty": {
    re: /^(?<file>[^\s:][^:\n]*):(?<line>[0-9]+):(?<col>[0-9]+) - (?:error|(?<warn>warning)|(?<info>info|message)) TS[0-9]+:/,
    type: 2,
  },
  cargo: { re: /^ *--> (?<file>[^:\n]+):(?<line>[0-9]+):(?<col>[0-9]+)/, type: 2 },
  // grep's, as grep-regexp-alist: FILE\0LINE: or FILE:LINE:.
  grep: { re: /^(?:(?<file>[^\0\n]+)\0(?<line>[0-9]+):|(?<file2>[^\n:]+?[^\n/:]):[\t ]*(?<line2>[1-9][0-9]*)[\t ]*:)/, type: 2 },
  "grep-binary": { re: /^Binary file (?<file>.+) matches/, type: 0 },
};

/** A message found in a compilation buffer: where it is, and where it points. */
type Message = {
  start: number;
  end: number;
  file: string;
  line: number;
  col?: number;
  type: 0 | 1 | 2;
  /** Where it points, once its file has been visited, moving with edits there as compile.el's markers do. */
  marker?: e8.Marker;
};

/**
 * Each compilation buffer's messages, in order, and how far it has been
 * read, kept by buffer rather than name, as a buffer-local variable would
 * be, so renaming the buffer keeps them.
 */
const buffers = new Map<e8.Buffer, { messages: Message[]; parsed: number; current?: number; started: number; matches: number }>();

// A killed buffer's messages go with it, as its buffer-local variables would.
e8.addHook("kill-buffer-hook", () => {
  const key = e8.currentBuffer();
  for (const m of buffers.get(key)?.messages ?? []) if (m.marker !== undefined) e8.deleteMarker(m.marker);
  buffers.delete(key);
});

function state(buffer: e8.BufferLike = e8.currentBuffer()) {
  const key = e8.getBuffer(buffer) ?? e8.signal("error", `No such buffer ${buffer}`);
  let s = buffers.get(key);
  if (s === undefined) {
    s = { messages: [], parsed: 0, started: Date.now(), matches: 0 };
    buffers.set(key, s);
  }
  return s;
}

const faceFor = (type: number): string => (type === 2 ? "compilation-error" : type === 1 ? "compilation-warning" : "compilation-info");

/** Finds the messages in the lines output has completed, highlighting them, as compilation--parse-region. */
function parseNewLines(): void {
  const s = state();
  const formats = (e8.variable("compilation-error-regexp-alist") as e8.Value[] | null ?? [])
    .filter((n): n is string => typeof n === "string" && FORMATS[n] !== undefined)
    .map((n) => FORMATS[n]);
  const grep = e8.derivedModeP("grep-mode");
  let line = e8.lineOf(s.parsed);
  const last = e8.lineCount() - 1;
  while (line < last) {
    const start = e8.lineStart(line);
    const text = e8.lineText(line);
    for (const f of formats) {
      const m = f.re.exec(text);
      if (m === null || m.groups === undefined) continue;
      const g = m.groups;
      const file = g.file ?? g.file2;
      if (file === undefined) continue;
      const lineNo = Number(g.line ?? g.line2 ?? 1);
      let type: 0 | 1 | 2 = g.warn !== undefined ? 1 : g.info !== undefined ? 0 : f.type;
      // cargo says what it is on the line before the arrow.
      if (f === FORMATS.cargo && line > 0) {
        for (let l = line - 1; l >= 0 && l >= line - 3; l--) {
          const t = e8.lineText(l);
          if (/^warning/.test(t)) type = 1;
          if (/^(?:note|help)/.test(t)) type = 0;
          if (/^(?:warning|error|note|help)/.test(t)) break;
        }
      }
      const fileAt = start + chars(text, m.index + m[0].indexOf(file));
      s.messages.push({ start, end: e8.lineEnd(line), file, line: lineNo, col: g.col === undefined ? undefined : Number(g.col), type });
      if (grep) s.matches++;
      // As compilation-mode's font-lock puts them: silently.
      e8.withSilentModifications(() => {
        e8.putTextProperty(fileAt, fileAt + chars(file), "face", grep ? "compilation-info" : faceFor(type));
        const lineText = String(lineNo);
        const lineAt = text.indexOf(lineText, m.index + m[0].indexOf(file) + file.length);
        if (lineAt >= 0) {
          const at = start + chars(text, lineAt);
          e8.putTextProperty(at, at + lineText.length, "face", "compilation-line-number");
        }
      });
      break;
    }
    line++;
  }
  s.parsed = e8.lineStart(last);
}

// --- Running a compilation ---------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The time as (substring (current-time-string) 0 19) writes it: "Wed Oct 29 21:05:00". */
function timeString(d = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Runs `fn` with the buffer writable, as inhibit-read-only. */
function writable<T>(fn: () => T): T {
  return e8.letBind({ "inhibit-read-only": true }, fn);
}

/** The mode's name without -mode, as it goes in the -*- line: compilation or grep. */
const modeStem = (mode: string): string => mode.replace(/-mode$/, "");

/** Strips the colour codes programs write, which a dumb terminal would not show. */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** What a compilation's end says, as compilation-exit-message-function or grep-exit-message. */
function exitMessage(event: string, matches: number, grep: boolean): string {
  if (!grep) return event;
  const code = /code (\d+)/.exec(event)?.[1];
  if (event === "finished\n") return `finished with ${matches} match${matches === 1 ? "" : "es"} found\n`;
  if (code === "1") return "finished with no matches found\n";
  return event;
}

/**
 * Starts a compilation of `command` in a buffer of `mode`, as
 * compilation-start: the buffer is cleared and headed with the command,
 * shown, and filled as the output comes.
 */
async function compilationStart(command: string, mode: string, directory: string): Promise<void> {
  const modeName = mode === "grep-mode" ? "Grep" : "Compilation";
  const bufferName = `*${modeStem(mode)}*`;
  const existing = e8.getBufferProcess(bufferName);
  const start = () => {
    if (existing !== undefined && e8.processStatus(existing) === "run") e8.deleteProcess(existing);
    e8.getBufferCreate(bufferName);
    e8.withCurrentBuffer(bufferName, () => {
      writable(() => e8.deleteRegion(0, e8.bufferSize()));
      e8.call(mode as e8.CommandName);
      e8.setVariable("default-directory", directory);
      e8.setVariable("compilation-directory", directory);
      // And for recompile from anywhere, as compile sets its default.
      e8.setDefault("compilation-directory", directory);
      e8.setVariable("compilation-arguments", [command, mode]);
      const key = e8.currentBuffer();
      for (const m of buffers.get(key)?.messages ?? []) if (m.marker !== undefined) e8.deleteMarker(m.marker);
      buffers.set(key, { messages: [], parsed: 0, started: Date.now(), matches: 0 });
      writable(() => {
        e8.insert(
          `-*- mode: ${modeStem(mode)}; default-directory: ${JSON.stringify(e8.abbreviateFileName(directory))} -*-\n` +
            `${modeName} started at ${timeString()}\n\n${command}\n`,
        );
      });
      state().parsed = e8.bufferSize();
      e8.setBufferModified(false);
      e8.gotoChar(truthy(e8.variable("compilation-scroll-output")) ? e8.bufferSize() : 0);
    });
    e8.setVariable("next-error-last-buffer", e8.getBuffer(bufferName) ?? null);
    const env: { [k: string]: string } = { INSIDE_EMACS: "e8,compile" };
    for (const e of (e8.variable("compilation-environment") as e8.Value[] | null) ?? []) {
      if (typeof e === "string" && e.includes("=")) env[e.slice(0, e.indexOf("="))] = e.slice(e.indexOf("=") + 1);
    }
    const proc = e8.makeProcess({
      name: modeStem(mode),
      buffer: bufferName,
      command: ["/bin/sh", "-c", command],
      directory,
      env,
      filter: (p, output) => compilationFilter(p, output),
      sentinel: (p, event) => compilationSentinel(p, event, modeName),
    });
    e8.withCurrentBuffer(bufferName, () => e8.runHooks("compilation-start-hook", proc));
    e8.call("display-buffer", bufferName);
  };
  if (existing !== undefined && e8.processStatus(existing) === "run" && !truthy(e8.variable("compilation-always-kill"))) {
    if (!(await e8.yesOrNoP(`A ${modeStem(mode)} process is running; kill it? `))) {
      e8.signal("error", `Cannot have two processes in ‘${bufferName}’ at once`);
    }
  }
  start();
}

/** Inserts output at the process mark, as compilation-filter, and finds the messages in it. */
function compilationFilter(proc: e8.Process, output: string): void {
  const buffer = e8.processBuffer(proc);
  if (buffer === undefined || !e8.bufferList().includes(buffer)) return;
  e8.withCurrentBuffer(buffer, () => {
    const mark = e8.processMark(proc)!;
    const at = e8.markerPosition(mark) ?? e8.bufferSize();
    const moving = e8.point() === at;
    const point = e8.makeMarker();
    const text = stripAnsi(output);
    writable(() => {
      e8.gotoChar(at);
      e8.insert(text);
      e8.setMarker(mark, e8.point());
    });
    e8.gotoChar(moving ? e8.markerPosition(mark)! : e8.markerPosition(point)!);
    e8.deleteMarker(point);
    parseNewLines();
    // grep separates the file name with a NUL, shown as a colon, as grep-mode's display property does.
    // Only in the lines read, so an unfinished one is still read with its NUL.
    if (e8.derivedModeP("grep-mode")) writable(() => e8.substCharInRegion(at, Math.max(at, state().parsed), "\0", ":"));
    e8.setBufferModified(false);
    e8.runHooks("compilation-filter-hook");
  });
}

/** Notes how the compilation ended, as compilation-handle-exit. */
function compilationSentinel(proc: e8.Process, event: string, modeName: string): void {
  const buffer = e8.processBuffer(proc);
  if (buffer === undefined || !e8.bufferList().includes(buffer)) return;
  let message = "";
  e8.withCurrentBuffer(buffer, () => {
    // Output not yet ended by a newline is a line too.
    if (e8.bufferSize() > 0 && e8.bufferText(e8.bufferSize() - 1, e8.bufferSize()) !== "\n") {
      writable(() => {
        e8.gotoChar(e8.bufferSize());
        e8.insert("\n");
      });
    }
    parseNewLines();
    const s = state();
    const status = exitMessage(event, s.matches, e8.derivedModeP("grep-mode"));
    const point = e8.makeMarker();
    writable(() => {
      e8.gotoChar(e8.bufferSize());
      const from = e8.point();
      e8.insert(`\n${modeName} ${status.replace(/\n$/, "")} at ${timeString()}, duration ${duration(Date.now() - s.started)}\n`);
      const failed = !event.startsWith("finished") && !(e8.derivedModeP("grep-mode") && /code 1\n/.test(event));
      // Emacs inserts these propertized, so they are no change of their own.
      e8.withSilentModifications(() => {
        e8.putTextProperty(from + 1, from + 1 + modeName.length, "face", "compilation-info");
        const word = from + 2 + modeName.length;
        e8.putTextProperty(word, word + status.replace(/\n$/, "").length, "face", failed ? "compilation-error" : "compilation-info");
      });
    });
    e8.gotoChar(e8.markerPosition(point)!);
    e8.deleteMarker(point);
    e8.setBufferModified(false);
    message = `${modeName} ${status.replace(/\n$/, "")}`;
  });
  e8.message(message);
  e8.runHooks("compilation-finish-functions", buffer, event);
}

/** The directory a buffer's commands run in, ending in a slash. */
const currentDirectory = (): string => e8.fileNameAsDirectory(e8.expandFileName("."));

/** Saves modified buffers, asking as compilation-ask-about-save says. */
function saveSomeBuffers(): void {
  if (truthy(e8.variable("compilation-ask-about-save"))) {
    e8.call("save-some-buffers");
  } else {
    e8.callWithPrefix([4], "save-some-buffers");
  }
}

e8.defineCommand({
  name: "compile",
  doc:
    "Run a shell command in the background, make -k by default, showing its output in *compilation*, where error messages are found and highlighted. " +
    "M-g n (next-error) then visits each error's place in turn. Asks to save modified buffers first.",
  run: async () => {
    const directory = currentDirectory();
    let command = String(e8.variable("compile-command") ?? "");
    // As compilation-read-command says, or always with a prefix argument.
    if (truthy(e8.variable("compilation-read-command")) || e8.prefixArg() !== null) {
      command = await e8.readString("Compile command: ", { initial: command, history: "compile-history" });
    }
    e8.setDefault("compile-command", command);
    saveSomeBuffers();
    compilationStart(command, "compilation-mode", directory);
  },
});

e8.defineCommand({
  name: "recompile",
  doc: "Run the last compilation again, or this buffer's, in the directory it ran in.",
  run: () => {
    const args = e8.variable("compilation-arguments");
    const command = Array.isArray(args) && typeof args[0] === "string" ? args[0] : String(e8.variable("compile-command") ?? "");
    const mode = Array.isArray(args) && typeof args[1] === "string" ? args[1] : "compilation-mode";
    const dir = e8.variable("compilation-directory");
    const directory = typeof dir === "string" ? dir : currentDirectory();
    saveSomeBuffers();
    compilationStart(command, mode, directory);
  },
});

e8.defineCommand({
  name: "kill-compilation",
  doc: "Kill the compilation this buffer shows, or the last one.",
  run: () => {
    const buffer = e8.derivedModeP("compilation-mode") ? e8.bufferName() : String(e8.variable("next-error-last-buffer") ?? "*compilation*");
    const proc = e8.getBufferProcess(buffer);
    if (proc === undefined || e8.processStatus(proc) !== "run") {
      throw new Error(`The ${buffer.replace(/^\*|\*$/g, "")} process is not running`);
    }
    e8.interruptProcess(proc);
  },
});

// --- Moving among messages and visiting them ------------------------------------

/** The messages next-error goes to: those at least as serious as compilation-skip-threshold says. */
const counted = (m: Message): boolean => m.type >= num("compilation-skip-threshold", 1);

/**
 * The message `n` messages on from position `from` in the current
 * compilation buffer, as compilation-next-error: forward past messages at
 * or before it, back to ones before it. Throws as Emacs does at the ends.
 */
function nthMessage(n: number, from: number): Message {
  const s = state();
  const word = String(e8.variable("compilation-error") ?? "error");
  const list = s.messages.filter(counted);
  // From the message containing `from`, if any.
  const here = s.messages.findIndex((m) => m.start <= from && from <= m.end);
  const pos = here >= 0 ? s.messages[here].start : from;
  if (n === 0) {
    const m = s.messages.find((m) => m.start <= from && from <= m.end);
    if (m === undefined) throw new Error(`No ${word} here`);
    return m;
  }
  if (n > 0) {
    const after = list.filter((m) => m.start > pos);
    if (after.length < n) {
      const running = e8.getBufferProcess(e8.bufferName()) !== undefined;
      throw new Error(running ? `No more ${word}s yet` : `Past last ${word}`);
    }
    return after[n - 1];
  }
  const before = list.filter((m) => m.start < pos);
  if (before.length < -n) throw new Error(`Moved back before first ${word}`);
  return before[before.length + n];
}

function compilationNextError(n: number): void {
  if (!e8.derivedModeP("compilation-mode")) throw new Error("Not in a compilation buffer");
  e8.gotoChar(nthMessage(n, e8.point()).start);
}

e8.defineCommand({
  name: "compilation-next-error",
  doc: "Move to the next error message, or as many as the prefix argument says, without visiting it.",
  run: () => compilationNextError(e8.prefixNumericValue(e8.prefixArg())),
});
e8.defineCommand({
  name: "compilation-previous-error",
  doc: "Move to the error message before, or as many back as the prefix argument says, without visiting it.",
  run: () => compilationNextError(-e8.prefixNumericValue(e8.prefixArg())),
});

/** The file a message names, relative to the directory its compilation ran in. */
function messageFile(m: Message): string {
  const dir = e8.variable("compilation-directory");
  const base = typeof dir === "string" ? dir : currentDirectory();
  return e8.expandFileName(m.file.startsWith("/") || m.file.startsWith("~") ? m.file : base + m.file);
}

let highlight: number | undefined;
let highlightBuffer: string | undefined;

function clearHighlight(): void {
  if (highlight !== undefined && highlightBuffer !== undefined && e8.bufferList().includes(highlightBuffer)) {
    const o = highlight;
    e8.withCurrentBuffer(highlightBuffer, () => e8.deleteOverlay(o));
  }
  highlight = undefined;
}

/**
 * Shows a message's place: its compilation buffer with point on it, and
 * its file at its line and column, as compilation-goto-locus.
 */
function gotoLocus(compilation: string, m: Message): void {
  const file = e8.withCurrentBuffer(compilation, () => messageFile(m));
  if (!e8.fileExists(file)) throw new Error(`Cannot find file ${file}`);
  const firstColumn = e8.withCurrentBuffer(compilation, () => num("compilation-first-column", 1));
  const fromCompilation = e8.windowBuffer() === compilation;
  let window = e8.windowList().find((w) => e8.windowBuffer(w) === compilation);
  if (!(fromCompilation && window !== undefined)) {
    e8.call("display-buffer", compilation);
    window = e8.windowList().find((w) => e8.windowBuffer(w) === compilation);
  }
  // The message at the top of its window's view, point on it.
  if (window !== undefined) {
    const selected = e8.selectedWindow();
    e8.selectWindow(window);
    e8.gotoChar(m.start);
    e8.selectWindow(selected);
  }
  const target = e8.findFileNoselect(file);
  // The first time a file's message is visited, every message in that file
  // gets a marker, so edits there before going to the next keep them right.
  if (m.marker === undefined || e8.markerBuffer(m.marker) !== target) {
    const all = e8.withCurrentBuffer(compilation, () => state().messages.filter((x) => x.marker === undefined && messageFile(x) === file));
    e8.withCurrentBuffer(target, () => {
      for (const x of all.includes(m) ? all : [...all, m]) {
        e8.saveExcursion(() => {
          e8.gotoChar(e8.lineStart(Math.max(0, Math.min(x.line - 1, e8.lineCount() - 1))));
          if (x.col !== undefined) e8.moveToColumn(Math.max(0, x.col - firstColumn));
          x.marker = e8.makeMarker();
        });
      }
    });
  }
  if (fromCompilation || e8.selectedWindow() === window) e8.call("pop-to-buffer", target);
  else e8.call("switch-to-buffer", target);
  e8.gotoChar(e8.markerPosition(m.marker!)!);
  // The line flashes, as next-error-highlight says.
  clearHighlight();
  const secs = e8.variable("next-error-highlight");
  if (truthy(secs)) {
    const line = e8.lineOf(e8.point());
    highlight = e8.makeOverlay(e8.lineStart(line), e8.lineEnd(line), { face: "next-error", priority: 1000 });
    highlightBuffer = e8.bufferName();
    if (typeof secs === "number") e8.runWithTimer(secs, null, clearHighlight);
  }
}

/** Moves `n` messages in a compilation buffer and visits the place, as compilation-next-error-function. */
function compilationNextErrorFunction(n: number, reset: boolean): void {
  const buffer = e8.bufferName();
  const s = state();
  if (reset) s.current = undefined;
  const from = s.current ?? (n === 0 ? e8.point() : 0);
  const m = nthMessage(n, from);
  s.current = m.start;
  // The overlay arrow at the message's line: a triangle in the fringe, or
  // nothing on a terminal, its string being empty here.
  const at = e8.lineStart(e8.lineOf(m.start));
  const arrow = e8.variable("overlay-arrow-position");
  if (arrow instanceof e8.Marker) e8.setMarker(arrow, at);
  else e8.setVariable("overlay-arrow-position", e8.makeMarker(at));
  gotoLocus(buffer, m);
}

e8.defun("compilation-next-error-function", compilationNextErrorFunction);

/** Whether a buffer has messages next-error can go to, as next-error-buffer-p. */
function nextErrorBuffer(b: e8.BufferLike): boolean {
  const buffer = e8.getBuffer(b);
  return buffer !== undefined && e8.withCurrentBuffer(buffer, () => typeof e8.variable("next-error-function") === "string");
}

/** The buffer next-error uses, as next-error-find-buffer. */
function findNextErrorBuffer(): e8.Buffer {
  // The buffer it used last, kept as a buffer, so renaming it does not lose it.
  const last = e8.variable("next-error-last-buffer");
  if ((typeof last === "string" || e8.bufferLiveP(last)) && nextErrorBuffer(last as e8.BufferLike)) return e8.getBuffer(last as e8.BufferLike)!;
  if (nextErrorBuffer(e8.currentBuffer())) return e8.currentBuffer();
  const any = e8.bufferList().find(nextErrorBuffer);
  if (any !== undefined) return e8.getBuffer(any)!;
  throw new Error("No buffers contain error message locations");
}

/** Goes to the `n`th next message's place, as next-error. */
function nextError(n: number, reset: boolean, select = true): void {
  const buffer = findNextErrorBuffer();
  const selected = e8.selectedWindow();
  const fn = e8.withCurrentBuffer(buffer, () => String(e8.variable("next-error-function")));
  // In that buffer, as Emacs calls it; the windows it changes stay changed.
  e8.withCurrentBuffer(buffer, () => e8.funcall(fn, n, reset));
  const previous = e8.variable("next-error-last-buffer");
  e8.setVariable("next-error-last-buffer", buffer);
  e8.runHooks("next-error-hook");
  if (truthy(e8.variable("next-error-verbose")) || previous !== buffer) {
    const which = reset ? "First" : n === 0 ? "Current" : n < 0 ? "Previous" : "Next";
    e8.message(`${which} locus from ${buffer.name}`);
  }
  if (!select) e8.selectWindow(selected);
}

const prefixCount = (): [number, boolean] => {
  const arg = e8.prefixArg();
  return Array.isArray(arg) ? [1, true] : [e8.prefixNumericValue(arg), false];
};

e8.defineCommand({
  name: "next-error",
  doc:
    "Visit the place of the next error message, or grep hit, in the compilation or grep buffer used last: its file, at its line. " +
    "With a prefix argument, that many on; plain C-u starts again from the first.",
  run: () => {
    const [n, reset] = prefixCount();
    nextError(n, reset);
  },
});
e8.defineCommand({
  name: "previous-error",
  doc: "Visit the place of the error message before, or as many back as the prefix argument says.",
  run: () => nextError(-e8.prefixNumericValue(e8.prefixArg()), false),
});
e8.defineCommand({
  name: "first-error",
  doc: "Visit the place of the first error message.",
  run: () => nextError(e8.prefixNumericValue(e8.prefixArg()), true),
});
e8.defineCommand({
  name: "next-error-no-select",
  doc: "Show the next error message's place, keeping this window selected.",
  run: () => nextError(e8.prefixNumericValue(e8.prefixArg()), false, false),
});
e8.defineCommand({
  name: "previous-error-no-select",
  doc: "Show the place of the error message before, keeping this window selected.",
  run: () => nextError(-e8.prefixNumericValue(e8.prefixArg()), false, false),
});

e8.defineCommand({
  name: "compile-goto-error",
  doc: "Visit the place of the error message at point.",
  run: () => {
    if (!e8.derivedModeP("compilation-mode")) throw new Error("Not in a compilation buffer");
    const m = nthMessage(0, e8.point());
    state().current = m.start;
    e8.setVariable("next-error-last-buffer", e8.currentBuffer());
    gotoLocus(e8.bufferName(), m);
  },
});

e8.defineCommand({
  name: "compilation-display-error",
  doc: "Show the place of the error message at point in another window, keeping this one selected.",
  run: () => {
    const window = e8.selectedWindow();
    e8.call("compile-goto-error");
    e8.selectWindow(window);
  },
});

// --- The modes ------------------------------------------------------------------

e8.defineMajorMode({
  name: "compilation-mode",
  modeName: "Compilation",
  doc:
    "The mode of *compilation*: the output of a compilation, its error messages highlighted. " +
    "RET visits the message at point, n and p the next and previous, M-n and M-p move between them, g runs the compilation again, and C-c C-k kills it.",
  bindings: {
    RET: "compile-goto-error",
    "C-c C-c": "compile-goto-error",
    "C-o": "compilation-display-error",
    "C-c C-k": "kill-compilation",
    "M-n": "compilation-next-error",
    "M-p": "compilation-previous-error",
    TAB: "compilation-next-error",
    "<backtab>": "compilation-previous-error",
    n: "next-error-no-select",
    p: "previous-error-no-select",
    g: "recompile",
    q: "quit-window",
    SPC: "scroll-up-command",
    DEL: "scroll-down-command",
  },
  setup: () => {
    e8.setReadOnly(true);
    e8.setVariable("next-error-function", "compilation-next-error-function");
    e8.setVariable("truncate-lines", false);
    e8.makeLocalVariable("overlay-arrow-position");
    e8.makeLocalVariable("overlay-arrow-string");
    e8.setVariable("overlay-arrow-string", "");
  },
});

e8.defineMajorMode({
  name: "grep-mode",
  modeName: "Grep",
  parent: "compilation-mode",
  doc: "The mode of *grep*: grep's hits, each a place next-error can visit. RET visits the hit at point, n and p the next and previous, g runs the search again.",
  setup: () => {
    e8.setVariable("compilation-error-regexp-alist", ["grep", "grep-binary"]);
    e8.setVariable("compilation-error", "grep hit");
    e8.setVariable("compilation-first-column", 0);
  },
});

e8.defineCommand({
  name: "grep",
  doc:
    "Run grep, with the arguments you give, in the background, showing its hits in *grep*. " +
    "M-g n (next-error) then visits each in turn.",
  params: [{
    name: "command",
    prompt: "Run grep (like this): ",
    initial: () => String(e8.variable("grep-command") ?? ""),
    history: "grep-history",
  }],
  run: (command: string) => compilationStart(command, "grep-mode", currentDirectory()),
});

for (const [keys, command] of [
  ["C-x `", "next-error"],
  ["M-g n", "next-error"],
  ["M-g M-n", "next-error"],
  ["M-g p", "previous-error"],
  ["M-g M-p", "previous-error"],
] as const) {
  e8.bindKey(keys, command);
}
