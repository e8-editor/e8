// Reverting buffers when their files change on disk, after Emacs's
// autorevert.el: auto-revert-mode in a buffer, auto-revert-tail-mode to
// follow a file that grows, and global-auto-revert-mode for every file
// buffer. A buffer is checked every auto-revert-interval seconds and, where
// the system can say, as soon as its file changes, by file notifications
// (filenotify.ts); auto-revert-avoid-polling then stops the checking.

import { revertBuffer } from "files";
import { fileNotifyAddWatch, fileNotifyRmWatch } from "filenotify";
import { truthy } from "subr";

const v = (name: string): e8.Value | undefined => e8.variable(name);

e8.defineVariable({
  name: "auto-revert-interval",
  doc:
    "Time, in seconds, between Auto-Revert Mode file checks. Setting it with setopt, or calling auto-revert-set-timer after, " +
    "makes it take effect at once.",
  value: 5,
});
e8.defineVariable({
  name: "auto-revert-stop-on-user-input",
  doc: "Whether typing interrupts checking buffers, the rest being checked first next time.",
  value: true,
});
e8.defineVariable({ name: "auto-revert-verbose", doc: "Whether reverting a buffer says so.", value: true });
e8.defineVariable({ name: "auto-revert-mode-text", doc: "What the mode line shows while Auto-Revert Mode is on.", value: " ARev" });
e8.defineVariable({ name: "auto-revert-tail-mode-text", doc: "What the mode line shows while Auto-Revert Tail Mode is on.", value: " Tail" });
e8.defineVariable({ name: "global-auto-revert-mode-text", doc: "What the mode line shows while Global Auto-Revert Mode is on.", value: "" });
e8.defineVariable({
  name: "global-auto-revert-non-file-buffers",
  doc:
    "Whether Global Auto-Revert Mode reverts buffers visiting no file that say when they are stale, as Dired's and " +
    "the buffer list do, as well as file buffers.",
  value: false,
});
e8.defineVariable({ name: "global-auto-revert-ignore-modes", doc: "Major modes Global Auto-Revert Mode leaves alone.", value: [] });
e8.defineVariable({
  name: "global-auto-revert-ignore-buffer",
  doc: "When true, Global Auto-Revert Mode leaves this buffer alone; a function is called with the buffer to say.",
  value: false,
  local: true,
});
e8.defineVariable({
  name: "auto-revert-check-vc-info",
  doc: "Whether to update version control information every auto-revert-interval seconds as well as when a buffer reverts.",
  value: false,
});
e8.defineVariable({ name: "auto-revert-remote-files", doc: "Whether remote files are reverted; E8 has none.", value: false });
e8.defineVariable({
  name: "auto-revert-use-notify",
  doc: "Whether Auto-Revert Mode is told by the system when a file changes, as well as looking.",
  value: true,
});
e8.defineVariable({
  name: "mounted-file-systems",
  doc: "A regexp matching the directories where mounted file systems are, which may not tell about changes.",
  value: "^\\(?:/afs/\\|/media/\\|/mnt\\|/net/\\|/tmp_mnt/\\)",
});
e8.defineVariable({
  name: "auto-revert-notify-exclude-dir-regexp",
  doc: "A regexp matching directories whose files are not watched for changes, only looked at.",
  value: String(v("mounted-file-systems")),
});
e8.defineVariable({
  name: "auto-revert-avoid-polling",
  doc:
    "Whether to stop looking at files every auto-revert-interval seconds where the system tells about changes, " +
    "to save power. Files on a file system that does not tell must then match auto-revert-notify-exclude-dir-regexp.",
  value: false,
});
e8.defineVariable({ name: "auto-revert-buffer-list", doc: "The buffers in Auto-Revert Mode.", value: [] });
e8.defineVariable({ name: "auto-revert--global-mode", doc: "Whether Global Auto-Revert Mode looks after this buffer.", value: false, local: true });
e8.defineVariable({ name: "auto-revert-tail-pos", doc: "How long the file was when this buffer last read it, for Auto-Revert Tail Mode.", value: 0 });
e8.defineVariable({ name: "auto-revert-notify-watch-descriptor", doc: "The file watch for this buffer's file.", value: null, local: true });
e8.defineVariable({ name: "auto-revert-notify-modified-p", doc: "Whether a notification said this buffer's file changed.", value: false, local: true });
e8.defineVariable({ name: "auto-revert-debug", doc: "Whether to say what notifications come.", value: false });
e8.put("auto-revert-mode", "permanent-local", true);
e8.put("auto-revert-tail-mode", "permanent-local", true);
e8.put("auto-revert-notify-watch-descriptor", "permanent-local", true);

/** How long to wait after reverting for a notification before reverting again, as auto-revert--lockout-interval. */
const LOCKOUT = 2.5;

let timer: number | undefined;
/** Buffers not checked last time because of input, checked first next time. */
let remaining: e8.Buffer[] = [];
/** The buffer each watch is for, by its descriptor. */
const bufferByWatch = new Map<number, e8.Buffer>();
/** Each buffer's lockout timer, while it waits after a notification. */
const lockouts = new Map<number, number>();

const local = (name: string, buffer: e8.Buffer): e8.Value | undefined => e8.bufferLocalValue(name, buffer);
const bufferList = (): e8.Buffer[] => (v("auto-revert-buffer-list") as e8.Buffer[] | null) ?? [];

function setLocal(name: string, value: e8.Value): void {
  e8.makeLocalVariable(name);
  e8.setVariable(name, value);
}

/** Takes a buffer out of auto-revert-buffer-list, as auto-revert-remove-current-buffer. */
function removeBuffer(buffer: e8.Buffer = e8.currentBuffer()): void {
  e8.setVariable("auto-revert-buffer-list", bufferList().filter((b) => b.id !== buffer.id));
}
const removeCurrentBuffer = (): void => removeBuffer();
e8.defun("auto-revert-remove-current-buffer", (buffer?: e8.Buffer) => removeBuffer(buffer ?? undefined));

e8.defineMinorMode({
  name: "auto-revert-mode",
  lighter: " ARev",
  doc:
    "Revert the buffer when its file changes on disk (Auto-Revert Mode).\n\n" +
    "A message says so each time, unless auto-revert-verbose is nil. Use global-auto-revert-mode for every buffer, " +
    "and auto-revert-tail-mode for a file that only grows.",
  onChange: (on) => {
    const buffer = e8.currentBuffer();
    if (on) {
      if (!e8.bufferBaseBuffer() && !bufferList().some((b) => b.id === buffer.id)) {
        e8.setVariable("auto-revert-buffer-list", [buffer, ...bufferList()]);
        e8.addHook("kill-buffer-hook", removeCurrentBuffer, { local: true });
      }
    } else {
      if (truthy(v("auto-revert-notify-watch-descriptor"))) notifyRmWatch();
      removeBuffer();
    }
    setTimer();
    if (on) {
      autoRevertBuffers();
      setLocal("auto-revert-tail-mode", false);
    }
  },
});

e8.defineCommand({
  name: "turn-on-auto-revert-mode",
  doc: "Turn on Auto-Revert Mode, as a function for hooks.",
  run: () => e8.callWithPrefix(1, "auto-revert-mode"),
});

/** The size of the visited file, or 0. */
const fileSize = (file: string): number => e8.fileAttributes(file)?.size ?? 0;

e8.addHook("find-file-hook", function autoRevertFindFileFunction() {
  const file = e8.bufferFileName();
  if (file !== undefined) setLocal("auto-revert-tail-pos", fileSize(file));
});

e8.defineMinorMode({
  name: "auto-revert-tail-mode",
  lighter: " Tail",
  doc:
    "Follow the end of the visited file as it grows, as tail -f does (Auto-Revert Tail Mode).\n\n" +
    "What is added to the file is added to the buffer; the buffer can be edited meanwhile. Make sure the file " +
    "stops growing before saving it. Use auto-revert-mode for changes other than appends.",
  onChange: (on) => {
    if (!on) return;
    const file = e8.bufferFileName();
    if (file === undefined) {
      setLocal("auto-revert-tail-mode", false);
      e8.signal("error", "This buffer is not visiting a file");
    }
    const pos = Number(v("auto-revert-tail-pos")) || 0;
    if (e8.bufferModified() && pos === 0 && !e8.yOrNP("Buffer is modified, so tail offset may be wrong.  Proceed? ")) {
      setLocal("auto-revert-tail-mode", false);
      return;
    }
    if (pos === 0 && e8.visitedFileChanged() && e8.yOrNP("File changed on disk, content may be missing.  Perform a full revert? ")) {
      autoRevertBuffers();
    }
    // Else what was read would be appended again on saving.
    e8.addHook("before-save-hook", () => e8.callWithPrefix(0, "auto-revert-tail-mode"), { local: true });
    if (!e8.localVariableP("auto-revert-tail-pos")) setLocal("auto-revert-tail-pos", fileSize(file!));
    // auto-revert-mode sets up the checking, and is then not on itself.
    if (!truthy(v("auto-revert-mode"))) e8.callWithPrefix(1, "auto-revert-mode");
    setLocal("auto-revert-tail-mode", true);
    setLocal("auto-revert-mode", false);
  },
});

e8.defineCommand({
  name: "turn-on-auto-revert-tail-mode",
  doc: "Turn on Auto-Revert Tail Mode, as a function for hooks.",
  run: () => e8.callWithPrefix(1, "auto-revert-tail-mode"),
});

e8.defineMinorMode({
  name: "global-auto-revert-mode",
  global: true,
  doc:
    "Revert any buffer visiting a file when the file changes on disk (Global Auto-Revert Mode).\n\n" +
    "With global-auto-revert-non-file-buffers, buffers such as Dired's are reverted too. Buffers in " +
    "global-auto-revert-ignore-modes, or with global-auto-revert-ignore-buffer, are left alone.",
  onChange: (on) => {
    setTimer();
    if (on) {
      for (const b of e8.bufferList()) e8.withCurrentBuffer(b, globalAddCurrentBuffer);
      e8.addHook("find-file-hook", globalAdoptCurrentBuffer);
      e8.addHook("after-change-major-mode-hook", globalPossiblyAdoptCurrentBuffer);
      autoRevertBuffers();
    } else {
      e8.removeHook("after-change-major-mode-hook", globalPossiblyAdoptCurrentBuffer);
      e8.removeHook("find-file-hook", globalAdoptCurrentBuffer);
      for (const b of e8.bufferList()) {
        e8.withCurrentBuffer(b, () => {
          if (!truthy(v("auto-revert--global-mode"))) return;
          setLocal("auto-revert--global-mode", false);
          if (truthy(v("auto-revert-notify-watch-descriptor")) && !truthy(v("auto-revert-mode")) && !truthy(v("auto-revert-tail-mode"))) notifyRmWatch();
        });
      }
    }
  },
});

/** Whether the buffer says when it is stale with a function of its own, as a non-file buffer must for Global Auto-Revert. */
const ownStaleFunction = (): boolean => {
  const f = v("buffer-stale-function");
  return truthy(f) && f !== "buffer-stale--default-function";
};

/** Has Global Auto-Revert look after the current buffer if it should, as auto-revert--global-add-current-buffer. */
function globalAddCurrentBuffer(): void {
  if (truthy(v("auto-revert--global-mode"))) return;
  const name = e8.bufferName();
  const tracked = e8.bufferFileName() !== undefined || (truthy(v("global-auto-revert-non-file-buffers")) && !name.startsWith(" ") && ownStaleFunction());
  if (!tracked) return;
  const ignoreModes = (v("global-auto-revert-ignore-modes") as e8.Value[] | null) ?? [];
  if (ignoreModes.includes(v("major-mode") as string)) return;
  // A function says whether to leave the buffer alone; anything else true does.
  const ignore = v("global-auto-revert-ignore-buffer");
  if (truthy(ignore)) {
    const callable = typeof ignore === "function" || (typeof ignore === "string" && e8.fboundp(ignore));
    if (!callable || truthy(e8.funcall(ignore as string, e8.currentBuffer()))) return;
  }
  setLocal("auto-revert--global-mode", true);
}
e8.defun("auto-revert--global-add-current-buffer", globalAddCurrentBuffer);
function globalAdoptCurrentBuffer(): void {
  globalAddCurrentBuffer();
  setTimer();
}
function globalPossiblyAdoptCurrentBuffer(): void {
  if (truthy(v("global-auto-revert-non-file-buffers"))) globalAdoptCurrentBuffer();
}
e8.defun("auto-revert--global-adopt-current-buffer", globalAdoptCurrentBuffer);
e8.defun("auto-revert--global-possibly-adopt-current-buffer", globalPossiblyAdoptCurrentBuffer);

e8.addHook("after-set-visited-file-name-hook", function autoRevertSetVisitedFileName() {
  // The watch is for the old name.
  if (truthy(v("auto-revert-notify-watch-descriptor"))) notifyRmWatch();
  if (truthy(v("global-auto-revert-mode"))) {
    globalAddCurrentBuffer();
    setTimer();
  } else if (truthy(v("auto-revert-mode")) || truthy(v("auto-revert-tail-mode"))) {
    setTimer();
  }
});

/** Whether a buffer is looked after by one of the modes. */
const tracked = (b: e8.Buffer): boolean =>
  truthy(local("auto-revert--global-mode", b)) || truthy(local("auto-revert-mode", b)) || truthy(local("auto-revert-tail-mode", b));

/** The buffers to look at, as auto-revert--polled-buffers. */
function polledBuffers(): e8.Buffer[] {
  const avoid = truthy(v("auto-revert-avoid-polling"));
  if (truthy(v("global-auto-revert-mode"))) {
    return e8
      .bufferList()
      .map((n) => e8.getBuffer(n)!)
      .filter((b) => b && !(avoid && truthy(local("auto-revert-notify-watch-descriptor", b))) && tracked(b));
  }
  if (avoid) return bufferList().filter((b) => e8.bufferLiveP(b) && !truthy(local("auto-revert-notify-watch-descriptor", b)));
  return bufferList();
}

/** Whether buffers must be looked at every so often, as auto-revert--need-polling-p. */
function needPolling(): boolean {
  const avoid = truthy(v("auto-revert-avoid-polling"));
  if (truthy(v("global-auto-revert-mode"))) {
    return !avoid || e8.bufferList().some((n) => {
      const b = e8.getBuffer(n);
      return b !== undefined && !truthy(local("auto-revert-notify-watch-descriptor", b)) && tracked(b);
    });
  }
  if (avoid) return !bufferList().every((b) => e8.bufferLiveP(b) && truthy(local("auto-revert-notify-watch-descriptor", b)));
  return bufferList().length > 0;
}

/** Starts, restarts or stops the timer that looks at buffers, as auto-revert-set-timer. */
function setTimer(): void {
  if (timer !== undefined) e8.cancelTimer(timer);
  timer = undefined;
  if (needPolling()) {
    const interval = Number(v("auto-revert-interval")) || 5;
    timer = e8.runWithTimer(interval, interval, autoRevertBuffers);
  }
}
e8.defineCommand({
  name: "auto-revert-set-timer",
  doc: "Restart the timer Auto-Revert Mode looks at files with, so a new auto-revert-interval takes effect, or stop it if nothing needs it.",
  run: setTimer,
});
e8.addVariableWatcher("auto-revert-interval", () => {
  if (timer !== undefined) e8.runWithTimer(0, null, setTimer);
});
e8.addVariableWatcher("auto-revert-avoid-polling", () => e8.runWithTimer(0, null, setTimer));

/** Stops watching the current buffer's file, as auto-revert-notify-rm-watch. */
function notifyRmWatch(): void {
  const desc = v("auto-revert-notify-watch-descriptor");
  if (!e8.bufferBaseBuffer() && typeof desc === "number") {
    bufferByWatch.delete(desc);
    e8.conditionCase(() => fileNotifyRmWatch(desc), { error: () => undefined });
    e8.removeHook("kill-buffer-hook", notifyRmWatch, { local: true });
  }
  setLocal("auto-revert-notify-watch-descriptor", null);
  setLocal("auto-revert-notify-modified-p", false);
}
e8.defun("auto-revert-notify-rm-watch", notifyRmWatch);

/** Watches the current buffer's file, or for a buffer visiting none its directory, as auto-revert-notify-add-watch. */
function notifyAddWatch(): void {
  const file = e8.bufferFileName();
  const dir = e8.expandFileName(String(v("default-directory") ?? "."));
  if (truthy(v("auto-revert-notify-watch-descriptor"))) return;
  if (e8.stringMatch(String(v("auto-revert-notify-exclude-dir-regexp") ?? ""), dir) !== undefined && String(v("auto-revert-notify-exclude-dir-regexp")) !== "") return;
  if (e8.fileSymlinkP(file ?? dir) !== undefined) return;
  const watched = file !== undefined ? e8.expandFileName(file, dir) : dir;
  const desc = e8.conditionCase(
    () => fileNotifyAddWatch(watched, file !== undefined ? ["change", "attribute-change"] : ["change"], "auto-revert-notify-handler"),
    { error: () => null },
  );
  if (typeof desc !== "number") return;
  setLocal("auto-revert-notify-watch-descriptor", desc);
  setLocal("auto-revert-notify-modified-p", true);
  bufferByWatch.set(desc, e8.currentBuffer());
  e8.addHook("kill-buffer-hook", notifyRmWatch, { local: true });
}

const nondirectory = (file: string): string => e8.fileNameNondirectory(file);

/** What a notification about a buffer's file does, as auto-revert-notify-handler. */
function notifyHandler(event: e8.Value[]): void {
  e8.conditionCase(
    () => {
      const [descriptor, action, file, file1] = event as [number, string, string, string | undefined];
      if (truthy(v("auto-revert-debug"))) e8.message(`auto-revert-notify-handler ${JSON.stringify(event)}`);
      const buffer = bufferByWatch.get(descriptor);
      if (buffer === undefined || !e8.bufferLiveP(buffer)) return;
      e8.withCurrentBuffer(buffer, () => {
        const visited = e8.bufferFileName();
        if (action === "stopped") {
          // Notifications stopped: looking every so often goes on.
          if (visited === undefined || nondirectory(file) === nondirectory(visited)) {
            notifyRmWatch();
            if (timer === undefined) setTimer();
          }
          return;
        }
        const mine =
          visited !== undefined
            ? (["attribute-changed", "changed", "created"].includes(action) && nondirectory(file) === nondirectory(visited)) ||
              (action === "renamed" && file1 !== undefined && nondirectory(file1) === nondirectory(visited))
            : ["created", "renamed", "deleted"].includes(action);
        if (!mine) return;
        setLocal("auto-revert-notify-modified-p", true);
        // Reverted at once unless one was just done; then once the lockout ends.
        if (!lockouts.has(buffer.id)) {
          handler();
          lockouts.set(buffer.id, e8.runWithTimer(LOCKOUT, null, () => endLockout(buffer)));
        }
      });
    },
    { error: (e) => e8.message(`Error while auto-reverting: ${e.message}`) },
  );
}
e8.defun("auto-revert-notify-handler", notifyHandler);

/** Ends the quiet time after a notification, reverting if another came meanwhile, as auto-revert--end-lockout. */
function endLockout(buffer: e8.Buffer): void {
  lockouts.delete(buffer.id);
  if (!e8.bufferLiveP(buffer)) return;
  e8.withCurrentBuffer(buffer, () => {
    if (truthy(v("auto-revert-notify-modified-p"))) handler();
  });
}

/** Whether one of the modes looks after the current buffer, as auto-revert-active-p. */
const activeP = (): boolean => truthy(v("auto-revert-mode")) || truthy(v("auto-revert-tail-mode")) || truthy(v("auto-revert--global-mode"));

/** Reverts the current buffer if it should be, as auto-revert-handler. */
function handler(): void {
  const buffer = e8.currentBuffer();
  const file = e8.bufferFileName();
  const stale = (): e8.Value => {
    const f = v("buffer-stale-function");
    return truthy(f) ? (e8.funcall(f as string, true) as e8.Value) : truthy(e8.funcall("buffer-stale--default-function", true));
  };
  let size = 0;
  let revert: e8.Value;
  if (file !== undefined) {
    const notified = !truthy(v("auto-revert-notify-watch-descriptor")) || truthy(v("auto-revert-notify-modified-p"));
    if (!notified) revert = false;
    else if (truthy(v("auto-revert-tail-mode"))) {
      revert = e8.fileReadableP(file) && (Number(v("auto-revert-tail-pos")) || 0) !== (size = fileSize(file));
    } else revert = stale();
  } else {
    revert = (truthy(v("auto-revert-mode")) || truthy(v("global-auto-revert-non-file-buffers"))) && truthy(stale());
  }
  setLocal("auto-revert-notify-modified-p", false);
  if (truthy(revert)) {
    if (truthy(v("auto-revert-verbose")) && revert !== "fast") e8.message(`Reverting buffer ‘${e8.bufferName()}’`);
    // A point at the end stays at the end, so a file can be followed.
    let eob = false;
    const atEnd: e8.Window[] = [];
    if (file !== undefined) {
      eob = e8.point() === e8.pointMax();
      for (const w of e8.windowList()) if (e8.windowBuffer(w) === buffer.name && e8.windowPoint(w) === e8.pointMax()) atEnd.push(w);
    }
    if (truthy(v("auto-revert-tail-mode"))) tailHandler(size);
    else {
      // Kept, so C-x C-q is not forgotten.
      const readOnly = e8.bufferReadOnly();
      e8.conditionCase(() => revertBuffer(true, true, true), { error: () => undefined });
      e8.setReadOnly(readOnly);
    }
    if (file !== undefined) {
      if (eob) e8.gotoChar(e8.pointMax());
      for (const w of atEnd) e8.setWindowPoint(w, e8.pointMax());
    }
  }
  if ((truthy(revert) || truthy(v("auto-revert-check-vc-info"))) && e8.fboundp("vc-refresh-state")) {
    e8.letBind({ "revert-buffer-in-progress-p": true }, () => e8.funcall("vc-refresh-state"));
  }
}

/** Appends what the file grew by, as auto-revert-tail-handler. */
function tailHandler(size: number): void {
  const modified = e8.bufferModified();
  const file = e8.bufferFileName()!;
  const pos = Number(v("auto-revert-tail-pos")) || 0;
  if (pos !== size) {
    e8.runHooks("before-revert-hook");
    e8.undoBoundary();
    // The file's time taken now, so adding to the buffer does not ask
    // about the change on disk, as Emacs binds buffer-file-name to nil.
    e8.setVisitedFileModtime();
    // No lock made, as Emacs binds buffer-file-name to nil meanwhile.
    e8.letBind({ "inhibit-read-only": true, "create-lockfiles": false }, () =>
      e8.saveRestriction(() => {
        e8.widen();
        e8.saveExcursion(() => {
          e8.gotoChar(e8.pointMax());
          e8.insertFileContents(file, { beg: pos < size ? pos : undefined, end: size });
        });
      }),
    );
    e8.runHooks("after-revert-hook");
    e8.undoBoundary();
    setLocal("auto-revert-tail-pos", size);
    e8.restoreBufferModifiedP(modified);
  }
  e8.setVisitedFileModtime();
}

/** The buffers to look at, those input stopped last time first, as auto-revert--buffer-candidates. */
function candidates(): e8.Buffer[] {
  const bufs = polledBuffers().filter((b) => e8.bufferLiveP(b));
  const left = remaining.filter((b) => bufs.some((x) => x.id === b.id));
  return [...left, ...bufs.filter((b) => !left.some((x) => x.id === b.id))];
}

/** Reverts one buffer if the modes say it should be, as auto-revert-buffer. */
function autoRevertBuffer(buffer: e8.Buffer): void {
  if (!e8.bufferLiveP(buffer)) {
    removeBuffer(buffer);
    return;
  }
  e8.withCurrentBuffer(buffer, () => {
    // Auto-Revert Mode turned off another way, as by a new major mode.
    if (!truthy(v("auto-revert-mode")) && !truthy(v("auto-revert-tail-mode"))) removeBuffer();
    if (!activeP()) return;
    if (
      truthy(v("auto-revert-use-notify")) &&
      !truthy(v("auto-revert-notify-watch-descriptor")) &&
      (e8.bufferFileName() !== undefined || truthy(v("buffer-auto-revert-by-notification")))
    ) {
      notifyAddWatch();
    }
    handler();
  });
}
e8.defun("auto-revert-buffer", autoRevertBuffer);

/**
 * Reverts the buffers the modes look after, as auto-revert-buffers:
 * stopping when there is input, if auto-revert-stop-on-user-input, those
 * not looked at then looked at first next time; and stopping the timer
 * when nothing needs it.
 */
function autoRevertBuffers(): void {
  const bufs = candidates();
  while (bufs.length > 0 && !(truthy(v("auto-revert-stop-on-user-input")) && e8.inputPendingP())) autoRevertBuffer(bufs.shift()!);
  remaining = bufs;
  if (!needPolling() && timer !== undefined) {
    e8.cancelTimer(timer);
    timer = undefined;
  }
}
e8.defun("auto-revert-buffers", autoRevertBuffers);

/** Whether the user setting `auto-revert-use-notify` to nil stops the watches, as its :set does. */
e8.addVariableWatcher("auto-revert-use-notify", (_symbol: symbol, value: e8.Value) => {
  if (truthy(value)) return;
  for (const n of e8.bufferList()) {
    e8.withCurrentBuffer(n, () => {
      if (truthy(v("auto-revert-notify-watch-descriptor"))) notifyRmWatch();
    });
  }
});
