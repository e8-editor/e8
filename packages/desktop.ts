// Saving and restoring sessions, after Emacs's desktop.el: with
// desktop-save-mode on, the buffers visiting files and Dired buffers, with
// their modes, points and marks, some global variables such as
// file-name-history, and the selected frame's windows are saved when E8
// exits and every so often while idle, and read back when it starts. The
// first save asks for a directory, as Emacs's does; M-x desktop-save saves
// at once. The file is JSON, where Emacs writes Lisp, and a lock file next
// to it keeps two E8s from using it at once.

import { truthy } from "subr";
import { type WindowState, windowStateGet, windowStatePut } from "window";

for (const [name, value, doc] of [
  ["desktop-path", [], "The directories desktop-read looks for a desktop file in, in order: user-emacs-directory and ~ when empty."],
  ["desktop-dirname", null, "The directory the desktop was last read from or saved in, where it is saved again."],
  ["desktop-base-file-name", ".e8.desktop", "The desktop file's name, in desktop-dirname."],
  ["desktop-base-lock-name", ".e8.desktop.lock", "The lock file's name, which holds the process id of the E8 using the desktop."],
  [
    "desktop-save",
    "ask-if-new",
    'Whether quitting saves the desktop: t always, "ask-if-new" asking if there is no desktop file yet, "ask", "if-exists", "ask-if-exists", or nil never.',
  ],
  ["desktop-load-locked-desktop", "ask", 'What to do with a desktop another E8 has locked: t load it, nil do not, "ask", or "check-pid" load it if that E8 is not running.'],
  [
    "desktop-globals-to-save",
    ["desktop-missing-file-warning", "search-ring", "regexp-search-ring", "register-alist", "file-name-history"],
    "The global variables saved in the desktop.",
  ],
  [
    "desktop-locals-to-save",
    ["truncate-lines", "case-fold-search", "fill-column", "overwrite-mode", "indent-tabs-mode", "tab-width", "show-trailing-whitespace"],
    "The buffer-local variables saved for each buffer, where the buffer has its own value.",
  ],
  ["desktop-buffers-not-to-save", "\\` ", "A regexp for the names of buffers not visiting files that are not saved."],
  ["desktop-files-not-to-save", "\\`/[^/:]*:", "A regexp for the names of files whose buffers are not saved: remote ones."],
  ["desktop-modes-not-to-save", ["tags-table-mode"], "Major modes whose buffers are not saved."],
  ["desktop-restore-frames", true, "Whether the desktop saves and restores the selected frame's windows."],
  ["desktop-auto-save-timeout", 30, "Seconds idle after which the desktop is saved, if it has changed; nil or 0 for never."],
  ["desktop-missing-file-warning", null, "Whether a desktop buffer whose file is gone is made anyway, with a warning."],
  ["desktop-file-modes", 0o600, "The permissions the desktop file gets: only you can read it, as it lists your files."],
] as const) {
  e8.defineVariable({ name, value: value as e8.Value, doc });
}
for (const [name, doc] of [
  ["desktop-after-read-hook", "Run after the desktop is read."],
  ["desktop-save-hook", "Run before the desktop is saved."],
  ["desktop-no-desktop-file-hook", "Run when desktop-read finds no desktop file, in the directory it looked in."],
  ["desktop-not-loaded-hook", "Run when a desktop locked by another E8 is not loaded."],
] as const) {
  e8.defineHook(name, doc);
}

const strings = (v: e8.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A buffer as the desktop file records it, as desktop-buffer-info does. */
interface SavedBuffer {
  file?: string;
  directory?: string;
  name: string;
  mode: string;
  minorModes: string[];
  point: number;
  mark?: number;
  markActive: boolean;
  readOnly: boolean;
  locals: { [name: string]: e8.Value };
}

interface Desktop {
  version: 1;
  globals: { [name: string]: e8.Value };
  buffers: SavedBuffer[];
  /**
   * The selected frame's windows, as window-state-get with WRITABLE gives
   * them, printed as Lisp, as Emacs's frameset keeps them. Desktops E8
   * saved before held an object of its own, `OldWindows`, read still.
   */
  windows?: string | OldWindows;
}

/** The windows as desktops before window-state-get kept them: a window, or two side by side or one above the other. */
type OldWindows =
  | { buffer: string; file?: string; point: number; start: number; selected: boolean }
  | { sideBySide: boolean; firstSize: number | null; first: OldWindows; second: OldWindows };

/**
 * A window state, as window-state-get gives it, for windows an older
 * desktop kept: each split's first window at its size in lines or
 * columns then, as a share of the frame's root window now, and each
 * window showing its buffer, or the buffer visiting its file.
 */
function fromOldWindows(old: OldWindows): WindowState {
  const sym = (name: string) => Symbol.for(name);
  const visiting = (file: string) => e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === file);
  const node = (w: OldWindows, normalHeight: number, normalWidth: number, height: number, width: number, last: boolean): e8.Value[] => {
    const sizes: e8.Value[] = [...(last ? [[sym("last"), true]] : []), [sym("normal-height"), normalHeight], [sym("normal-width"), normalWidth]];
    if ("buffer" in w) {
      const buffer = (w.file ? visiting(w.file) : undefined) ?? w.buffer;
      const place = [...(w.selected ? [[sym("selected"), true]] : [[sym("selected")]]), [sym("point"), w.point], [sym("start"), w.start]];
      return [sym("leaf"), ...sizes, [sym("buffer"), buffer, ...place]];
    }
    const total = w.sideBySide ? width : height;
    const first = Math.min(Math.max(w.firstSize ?? Math.floor(total / 2), 1), total - 1);
    const share = first / total;
    const [h1, w1, h2, w2] = w.sideBySide ? [height, first, height, total - first] : [first, width, total - first, width];
    const children = w.sideBySide
      ? [node(w.first, 1, share, h1, w1, false), node(w.second, 1, 1 - share, h2, w2, true)]
      : [node(w.first, share, 1, h1, w1, false), node(w.second, 1 - share, 1, h2, w2, true)];
    return [sym(w.sideBySide ? "hc" : "vc"), ...sizes, [sym("combination-limit")], ...children];
  };
  const root = e8.frameRootWindow();
  return [[], ...node(old, 1, 1, e8.windowTotalHeight(root), e8.windowTotalWidth(root), true)];
}

/** The windows a desktop kept, as a window state. */
function savedWindows(windows: string | OldWindows): WindowState | undefined {
  if (typeof windows !== "string") return fromOldWindows(windows);
  const [state] = e8.readFromString(windows);
  return Array.isArray(state) ? state : undefined;
}

function desktopPath(): string[] {
  const path = strings(e8.variable("desktop-path"));
  const own = e8.variable("user-emacs-directory");
  return path.length > 0 ? path : [...(typeof own === "string" ? [own] : []), "~"];
}

/** The desktop file in a directory, desktop-dirname by default, as desktop-full-file-name. */
function fullFileName(dir = e8.variable("desktop-dirname")): string | undefined {
  return typeof dir === "string" ? e8.expandFileName(String(e8.variable("desktop-base-file-name")), dir) : undefined;
}

function lockFileName(dir = e8.variable("desktop-dirname")): string | undefined {
  return typeof dir === "string" ? e8.expandFileName(String(e8.variable("desktop-base-lock-name")), dir) : undefined;
}

/** The process id the desktop's lock holds, as desktop-owner. */
function owner(dir?: string): number | undefined {
  const lock = lockFileName(dir ?? e8.variable("desktop-dirname"));
  if (!lock || !e8.fileExists(lock)) return undefined;
  const pid = Number(e8.readTextFile(lock).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function claimLock(dir: string): void {
  e8.writeTextFile(lockFileName(dir)!, `${e8.emacsPid()}`);
}

function releaseLock(dir: string | undefined = e8.variable("desktop-dirname") as string | undefined): void {
  const lock = lockFileName(dir);
  if (lock && owner(dir) === e8.emacsPid()) e8.deleteFile(lock, { trash: false });
}

/** Whether a buffer is saved, as desktop-save-buffer-p. */
function saveBufferP(file: string | undefined, name: string, mode: string, directory: string): boolean {
  const notBuffers = e8.variable("desktop-buffers-not-to-save");
  const notFiles = e8.variable("desktop-files-not-to-save");
  const matches = (re: e8.Value | undefined, s: string) => typeof re === "string" && e8.stringMatch(re, s) !== undefined;
  if (!file && matches(notBuffers, name)) return false;
  if (strings(e8.variable("desktop-modes-not-to-save")).includes(mode)) return false;
  if (file) return !matches(notFiles, file);
  return mode === "dired-mode" && !matches(notFiles, directory);
}

/** What the desktop file holds now, as desktop-save gathers it. */
function gather(): Desktop {
  const globals: { [name: string]: e8.Value } = {};
  for (const name of strings(e8.variable("desktop-globals-to-save"))) {
    const value = e8.variable(name);
    if (value !== undefined) globals[name] = value;
  }
  const buffers: SavedBuffer[] = [];
  for (const name of e8.bufferList()) {
    const saved = e8.withCurrentBuffer(name, (): SavedBuffer | undefined => {
      const file = e8.bufferFileName();
      const mode = String(e8.variable("major-mode"));
      const directory = String(e8.variable("default-directory") ?? "");
      if (!saveBufferP(file, name, mode, directory)) return undefined;
      const locals: { [name: string]: e8.Value } = {};
      for (const local of strings(e8.variable("desktop-locals-to-save"))) {
        if (e8.isLocalVariable(local)) locals[local] = e8.variable(local) ?? null;
      }
      const mark = e8.mark();
      return {
        ...(file ? { file } : { directory }),
        name,
        mode,
        minorModes: e8.localMinorModes(),
        point: e8.point(),
        ...(typeof mark === "number" ? { mark } : {}),
        markActive: e8.regionActive(),
        readOnly: e8.bufferReadOnly(),
        locals,
      };
    });
    if (saved) buffers.push(saved);
  }
  return { version: 1, globals, buffers, ...(truthy(e8.variable("desktop-restore-frames")) ? { windows: e8.prin1ToString(windowStateGet(null, true)) } : {}) };
}

/** The text last written, so auto-saving a desktop that did not change writes nothing, as desktop-file-checksum. */
let lastSaved: string | undefined;

/** Saves the desktop in a directory, as desktop-save; with `onlyIfChanged`, as auto-saving does. */
function save(dir: string, release = false, onlyIfChanged = false): void {
  dir = e8.fileNameAsDirectory(e8.expandFileName(dir));
  e8.runHooks("desktop-save-hook");
  const text = `${JSON.stringify(gather(), null, 1)}\n`;
  if (!(onlyIfChanged && text === lastSaved)) {
    if (!e8.fileExists(dir)) e8.makeDirectory(dir, { parents: true });
    const modes = e8.variable("desktop-file-modes");
    e8.writeTextFile(fullFileName(dir)!, text, { mode: typeof modes === "number" ? modes : undefined });
    lastSaved = text;
  }
  if (release) releaseLock(dir);
  else if (owner(dir) !== e8.emacsPid()) claimLock(dir);
  e8.setVariable("desktop-dirname", dir);
}

/** Whether to load a desktop another process holds, as desktop--load-locked-desktop-p. */
function loadLockedP(pid: number): boolean {
  if (pid === e8.emacsPid()) return true;
  const choice = e8.variable("desktop-load-locked-desktop");
  if (choice === "check-pid") return !e8.processAliveP(pid);
  if (choice === "ask") {
    return e8.yOrNP(
      `Warning: desktop file appears to be in use by process with PID ${pid}.\n` +
        "Using it may cause conflicts if the other process also saves it.  Use it anyway? ",
    );
  }
  return truthy(choice);
}

/** Makes a buffer from what the desktop recorded, as desktop-create-buffer. Whether it could. */
function restoreBuffer(saved: SavedBuffer): boolean {
  let name: string | undefined;
  if (saved.file) {
    if (!e8.fileExists(saved.file)) {
      if (!truthy(e8.variable("desktop-missing-file-warning"))) {
        e8.message(`Desktop: File "${saved.file}" no longer exists.`);
        return false;
      }
    }
    name = e8.findFileNoselect(saved.file);
  } else if (saved.directory && saved.mode === "dired-mode") {
    if (!e8.fileExists(saved.directory)) return false;
    e8.saveExcursion(() => {
      e8.call("dired", saved.directory!);
      name = e8.currentBuffer().name;
    });
  }
  if (!name) return false;
  e8.withCurrentBuffer(name, () => {
    if (e8.variable("major-mode") !== saved.mode && e8.commandExists(saved.mode)) e8.call(saved.mode as e8.CommandName);
    for (const mode of saved.minorModes) {
      if (e8.commandExists(mode) && !truthy(e8.variable(mode))) e8.callWithPrefix(1, mode as e8.CommandName);
    }
    for (const [local, value] of Object.entries(saved.locals)) {
      e8.makeLocalVariable(local);
      e8.setVariable(local, value);
    }
    if (saved.readOnly) e8.setReadOnly(true);
    if (saved.mark !== undefined) e8.setMark(Math.min(saved.mark, e8.bufferSize()));
    if (saved.markActive) e8.activateMark();
    e8.gotoChar(Math.min(saved.point, e8.bufferSize()));
  });
  return true;
}

/** Reads the desktop in a directory, or the first in desktop-path that has one, as desktop-read. Whether one was read. */
function read(dirname?: string): boolean {
  if (owner() === e8.emacsPid() && dirname === undefined) {
    e8.message("Not reloading the desktop; already loaded");
    return false;
  }
  const dir =
    dirname && dirname !== ""
      ? dirname
      : (desktopPath().find((d) => e8.fileExists(fullFileName(d)!)) ?? desktopPath()[0] ?? String(e8.variable("user-emacs-directory")));
  e8.setVariable("desktop-dirname", e8.fileNameAsDirectory(e8.expandFileName(dir)));
  const file = fullFileName()!;
  if (!e8.fileExists(file)) {
    e8.letBind({ "default-directory": e8.variable("desktop-dirname") ?? null }, () => e8.runHooks("desktop-no-desktop-file-hook"));
    e8.message("No desktop file.");
    return false;
  }
  const locker = owner();
  if (locker !== undefined && !loadLockedP(locker)) {
    e8.setVariable("desktop-dirname", null);
    e8.runHooks("desktop-not-loaded-hook");
    if (e8.variable("desktop-dirname") === null) e8.message("Desktop file in use; not loaded.");
    return false;
  }
  const desktop = JSON.parse(e8.readTextFile(file)) as Desktop;
  for (const [name, value] of Object.entries(desktop.globals ?? {})) e8.setVariable(name, value);
  let ok = 0;
  let failed = 0;
  for (const saved of desktop.buffers ?? []) {
    if (restoreBuffer(saved)) ok++;
    else failed++;
  }
  if (locker !== e8.emacsPid()) claimLock(String(e8.variable("desktop-dirname")));
  const windows = desktop.windows && truthy(e8.variable("desktop-restore-frames")) ? savedWindows(desktop.windows) : undefined;
  // As frameset.el puts a frame's windows: safely, and a state that no longer fits leaves them as they are.
  if (windows) e8.conditionCase(() => windowStatePut(windows, undefined, Symbol.for("safe")), { error: (e) => e8.message(`Desktop: windows not restored: ${e.message}`) });
  else if (desktop.buffers?.length) {
    const first = desktop.buffers.find((b) => e8.getBuffer(b.name));
    if (first) e8.call("switch-to-buffer", first.name);
  }
  lastSaved = `${JSON.stringify(gather(), null, 1)}\n`;
  e8.runHooks("desktop-after-read-hook");
  const s = (n: number) => (n === 1 ? "" : "s");
  e8.message(`Desktop: ${desktop.windows ? "1 frame, " : ""}${ok} buffer${s(ok)} restored${failed > 0 ? `, ${failed} failed to restore` : ""}.`);
  return true;
}

/** Kills the buffers the desktop would save, as desktop-clear. */
function clear(): void {
  for (const name of strings(e8.variable("desktop-globals-to-save"))) {
    if (name === "file-name-history" || name.endsWith("-ring")) e8.setVariable(name, []);
  }
  for (const name of e8.bufferList()) {
    if (/^\*(scratch|Messages)\*$/.test(name) || name.startsWith(" ")) continue;
    e8.call("kill-buffer", name);
  }
  e8.call("delete-other-windows");
}

/** What quitting does with the desktop, as desktop-kill: saves it as desktop-save says, asking for a directory the first time. */
function kill(): void {
  if (!truthy(e8.variable("desktop-save-mode"))) return;
  const file = fullFileName();
  const exists = file !== undefined && e8.fileExists(file);
  const choice = e8.variable("desktop-save");
  const dirname = e8.variable("desktop-dirname");
  const wanted =
    choice === true ||
    (exists && choice === "if-exists") ||
    (exists && typeof dirname === "string" && choice === "ask-if-new") ||
    ((choice === "ask" || choice === "ask-if-new" || (exists && choice === "ask-if-exists")) && e8.yOrNP("Save desktop? "));
  if (wanted) {
    const dir = typeof dirname === "string" ? dirname : e8.readFileName("Directory for desktop file: ", { mustMatch: true });
    save(dir, true);
  } else releaseLock();
}

let autoSaveTimer: number | undefined;

/** Saves the desktop after desktop-auto-save-timeout seconds idle, if it has a directory and changed, as desktop-auto-save. */
function autoSaveEnable(): void {
  if (autoSaveTimer !== undefined) e8.cancelTimer(autoSaveTimer);
  autoSaveTimer = undefined;
  const timeout = e8.variable("desktop-auto-save-timeout");
  if (typeof timeout !== "number" || timeout <= 0) return;
  autoSaveTimer = e8.runWithIdleTimer(timeout, true, () => {
    const dir = e8.variable("desktop-dirname");
    if (truthy(e8.variable("desktop-save-mode")) && typeof dir === "string" && owner(dir) === e8.emacsPid()) {
      e8.letBind({ "inhibit-message": true }, () => save(dir, false, true));
    }
  });
}

e8.defineMinorMode({
  name: "desktop-save-mode",
  global: true,
  doc:
    "Save the desktop, the buffers visiting files with their modes and places, some global variables and the windows, " +
    "when E8 exits and while it is idle, and read it back when E8 starts. M-x desktop-save saves it now, asking " +
    "where the first time; M-x desktop-read reads it.",
  onChange: (enabled) => {
    if (enabled) autoSaveEnable();
    else if (autoSaveTimer !== undefined) {
      e8.cancelTimer(autoSaveTimer);
      autoSaveTimer = undefined;
    }
  },
});

e8.addHook("kill-emacs-hook", () => kill());
// As desktop.el adds to after-init-hook: once init.ts has turned the mode on.
e8.addHook("after-init-hook", () => {
  if (truthy(e8.variable("desktop-save-mode"))) read();
});

e8.defineCommand({
  name: "desktop-save",
  doc: "Save the desktop in a directory, which then is where it is saved again; with a prefix argument, release its lock too.",
  params: [
    { name: "dirname", kind: "file", prompt: "Directory to save desktop file in: ", initial: () => {
      const dir = [e8.variable("desktop-dirname"), e8.variable("user-emacs-directory")].find((d) => typeof d === "string");
      return typeof dir === "string" ? dir : "~/";
    } },
    { name: "release", kind: "prefix" },
  ],
  run: (dirname, release) => save(dirname, release !== null && release !== undefined),
});

e8.defineCommand({
  name: "desktop-save-in-desktop-dir",
  doc: "Save the desktop in desktop-dirname, or ask for a directory if it has none.",
  run: () => {
    const dir = e8.variable("desktop-dirname");
    if (typeof dir === "string") {
      save(dir);
      e8.message(`Desktop saved in ${e8.abbreviateFileName(dir)}`);
    } else e8.callInteractively("desktop-save");
  },
});

e8.defineCommand({
  name: "desktop-read",
  doc: "Read the desktop from the first directory of desktop-path that has one, or with a prefix argument from one asked for.",
  params: [{ name: "ask", kind: "prefix" }],
  run: (ask) => {
    read(ask !== null && ask !== undefined ? e8.readFileName("Directory for desktop file: ", { mustMatch: true }) : undefined);
  },
});

e8.defineCommand({
  name: "desktop-clear",
  doc: "Kill the buffers the desktop holds and empty its histories, leaving *scratch* and *Messages*.",
  run: () => clear(),
});

e8.defineCommand({
  name: "desktop-revert",
  doc: "Put the desktop back as it was last read or saved.",
  run: () => {
    const dir = e8.variable("desktop-dirname");
    if (typeof dir !== "string" || !e8.fileExists(fullFileName(dir)!)) e8.userError("Unknown desktop directory");
    releaseLock(dir);
    clear();
    read(dir);
  },
});

e8.defineCommand({
  name: "desktop-change-dir",
  doc: "Save the desktop where it is, if desktop-save-mode would, then read the one in another directory.",
  params: [{ name: "dirname", kind: "file", prompt: "Desktop directory: " }],
  run: (dirname) => {
    kill();
    clear();
    read(dirname);
  },
});

e8.defineCommand({
  name: "desktop-remove",
  doc: "Delete the desktop file and stop saving the desktop until one is saved again.",
  run: () => {
    const file = fullFileName();
    releaseLock();
    e8.setVariable("desktop-dirname", null);
    if (file && e8.fileExists(file)) e8.deleteFile(file, { trash: false });
  },
});
