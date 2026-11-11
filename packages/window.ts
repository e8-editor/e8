// Commands for windows, after Emacs's window.el. The primitives they use,
// splitting, deleting, selecting and resizing windows, are in the core.

/** The size a prefix argument asks a split for, as split-window-below reads it. */
function splitSize(): number | undefined {
  const arg = e8.prefixArg();
  return arg === null ? undefined : e8.prefixNumericValue(arg);
}

const splitBelow = e8.defineCommand({
  name: "split-window-below",
  doc:
    "Split the selected window into two, one above the other.\n\n" +
    "The selected window stays on top and the new one below shows the same buffer at the same place. " +
    "A prefix argument gives the selected window that many lines, or the new one if it is negative.",
  run: () => {
    e8.splitWindow(undefined, "below", splitSize());
  },
});

const splitRight = e8.defineCommand({
  name: "split-window-right",
  doc:
    "Split the selected window into two, side by side.\n\n" +
    "The selected window stays on the left and the new one on the right shows the same buffer at the same place. " +
    "A prefix argument gives the selected window that many columns, or the new one if it is negative.",
  run: () => {
    e8.splitWindow(undefined, "right", splitSize());
  },
});

const otherWindow = e8.defineCommand({
  name: "other-window",
  doc:
    "Select another window, the next in cyclic order.\n\n" +
    "A prefix argument says how many windows on to go; a negative one goes back.",
  run: () => {
    const windows = e8.windowList();
    const count = e8.prefixNumericValue(e8.prefixArg());
    const i = windows.indexOf(e8.selectedWindow());
    const n = windows.length;
    e8.selectWindow(windows[(((i + count) % n) + n) % n]);
  },
});

const deleteWindow = e8.defineCommand({
  name: "delete-window",
  doc:
    "Delete the selected window, giving its space to its neighbour.\n\n" +
    "The most recently used of the other windows is selected.",
  run: () => e8.deleteWindow(),
});

const deleteOtherWindows = e8.defineCommand({
  name: "delete-other-windows",
  doc: "Make the selected window fill the frame, deleting the others.",
  run: () => {
    const selected = e8.selectedWindow();
    for (const window of e8.windowList()) {
      if (window !== selected) e8.deleteWindow(window);
    }
  },
});

// Displaying buffers, as display-buffer does with its default actions.

/**
 * How to undo showing a buffer in a window, as display-buffer-record-window
 * writes the quit-restore window parameter: `["window", "window", SELECTED,
 * BUFFER]` for a window made to show BUFFER, `["frame", "frame", ...]` for
 * one on a frame made for it, `["other", [PREVIOUS, START, POINT, HEIGHT],
 * SELECTED, BUFFER]` for a window that showed PREVIOUS from START with POINT,
 * and `"same"` first once BUFFER is shown in it again. SELECTED is the window
 * selected then.
 */
type QuitRestore = [string, string | [string, number, number, number], e8.Window, string];

function quitRestore(window: e8.Window): QuitRestore | undefined {
  const v = e8.windowParameter(window, "quit-restore");
  return Array.isArray(v) && v.length === 4 ? (v as unknown as QuitRestore) : undefined;
}

/**
 * Notes in a window's quit-restore parameter how to undo showing `buffer`
 * in it, as display-buffer-record-window: `type` is "reuse" for a window
 * that was there, else "window" or "frame" for one made for the buffer.
 */
function recordWindow(type: "reuse" | "window" | "frame", window: e8.Window, buffer: string): void {
  const selected = e8.selectedWindow();
  if (type !== "reuse") {
    e8.setWindowParameter(window, "quit-restore", [type, type, selected, buffer]);
  } else if (e8.windowBuffer(window) === buffer) {
    const restore = quitRestore(window);
    if (restore) {
      restore[0] = "same";
      if (window !== selected && window !== restore[2]) restore[2] = selected;
      e8.setWindowParameter(window, "quit-restore", restore as unknown as e8.Value);
    }
  } else {
    const previous = [e8.windowBuffer(window) ?? "", e8.windowStart(window), e8.windowPoint(window), size(window).totalHeight];
    e8.setWindowParameter(window, "quit-restore", ["other", previous, selected, buffer]);
  }
}

/**
 * Shows a buffer in the window display-buffer chose, as window--display-buffer:
 * notes how to undo it, frees a reused window of a dedication, and gives a
 * new window no previous buffers.
 */
function showInWindow(buffer: string, window: e8.Window, type: "reuse" | "window" | "frame"): e8.Window {
  recordWindow(type, window, buffer);
  if (e8.windowBuffer(window) !== buffer) {
    e8.setWindowDedicatedP(window, null);
    e8.setWindowBuffer(window, buffer);
  }
  if (type !== "reuse") e8.setWindowPrevBuffers(window, []);
  return window;
}

/** Whether a window is dedicated to its buffer, which display-buffer does not take for another. */
const dedicated = (window: e8.Window): boolean => e8.windowDedicatedP(window) !== undefined && e8.windowDedicatedP(window) !== false;

function size(window: e8.Window) {
  return e8.windowSize(window) ?? { width: 0, height: 0, totalWidth: 0, totalHeight: 0, fullWidth: true };
}

/**
 * The least recently used window, as get-lru-window finds it: one that
 * spans the frame's width if there is any, else any other; the selected
 * window only last, and not at all with `notSelected`; a dedicated one
 * only with `dedicatedOk`.
 */
function lruWindow(notSelected: boolean, dedicatedOk = false): e8.Window | undefined {
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let bestTime = Infinity;
  let second: e8.Window | undefined;
  let secondTime = Infinity;
  for (const window of e8.windowList()) {
    if ((notSelected && window === selected) || (!dedicatedOk && dedicated(window))) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (window === selected || !size(window).fullWidth) {
      if (time < secondTime) [second, secondTime] = [window, time];
    } else if (time < bestTime) {
      [best, bestTime] = [window, time];
    }
  }
  return best ?? second;
}

/** The largest window by area, as get-largest-window finds it. */
function largestWindow(notSelected: boolean, dedicatedOk = false): e8.Window | undefined {
  let best: e8.Window | undefined;
  let bestArea = -1;
  for (const window of e8.windowList()) {
    if ((notSelected && window === e8.selectedWindow()) || (!dedicatedOk && dedicated(window))) continue;
    const s = size(window);
    const area = s.totalWidth * s.totalHeight;
    if (area > bestArea) [best, bestArea] = [window, area];
  }
  return best;
}

const WINDOW_MIN_HEIGHT = 4;
const WINDOW_MIN_WIDTH = 10;

e8.defineVariable({
  name: "split-height-threshold",
  doc: "How tall a window must be, in lines, for display-buffer to split it into one above the other; nil never.",
  value: 80,
});
e8.defineVariable({
  name: "split-width-threshold",
  doc: "How wide a window must be, in columns, for display-buffer to split it side by side; nil never.",
  value: 160,
});

/** Whether a window is big enough to split, as window-splittable-p decides: a threshold of nil never is. */
function splittable(window: e8.Window, horizontal: boolean, heightThreshold?: number): boolean {
  const s = size(window);
  if (horizontal) {
    const threshold = e8.variable("split-width-threshold");
    if (typeof threshold !== "number") return false;
    return s.width >= Math.max(threshold, 2 * Math.max(WINDOW_MIN_WIDTH, 2));
  }
  const threshold = heightThreshold ?? e8.variable("split-height-threshold");
  if (typeof threshold !== "number") return false;
  return s.totalHeight >= Math.max(threshold, 2 * Math.max(WINDOW_MIN_HEIGHT, 2));
}

/**
 * Splits a window the way that suits its size, as split-window-sensibly:
 * below it if it is tall enough, else to its right if it is wide enough,
 * else below it anyway if it is the only window. Returns the new window.
 */
function splitSensibly(window: e8.Window): e8.Window | undefined {
  if (splittable(window, false)) return e8.splitWindow(window, "below");
  if (splittable(window, true)) return e8.splitWindow(window, "right");
  if (e8.windowList().length === 1 && splittable(window, false, 0)) return e8.splitWindow(window, "below");
  return undefined;
}

/**
 * Shows a buffer in some window and returns it, as display-buffer does with
 * its default actions: a window already showing it, the selected one first
 * unless `inhibitSameWindow`; else a new window split off the largest or
 * least recently used one; else the least recently used window.
 */
function displayBuffer(buffer: string, inhibitSameWindow = false): e8.Window {
  e8.getBufferCreate(buffer);
  const selected = e8.selectedWindow();
  const showing = e8.windowList().filter((w) => e8.windowBuffer(w) === buffer && !(inhibitSameWindow && w === selected));
  const reuse = showing.includes(selected) ? selected : showing[0];
  if (reuse !== undefined) return showInWindow(buffer, reuse, "reuse");
  // A dedicated window may be split, though not reused, as get-largest-window's DEDICATED allows.
  const candidates = [largestWindow(false, true), lruWindow(true, true)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const made = splitSensibly(candidate);
    if (made !== undefined) return showInWindow(buffer, made, "window");
  }
  const window = lruWindow(inhibitSameWindow) ?? largestWindow(inhibitSameWindow);
  if (window !== undefined) return showInWindow(buffer, window, "reuse");
  // Every window is dedicated or ruled out: a new frame, as display-buffer-pop-up-frame.
  e8.makeFrame(buffer);
  return showInWindow(buffer, e8.selectedWindow(), "frame");
}

/** Shows a buffer in some window, as display-buffer does, and selects it. */
function popToBuffer(buffer: string, inhibitSameWindow = false): void {
  e8.selectWindow(displayBuffer(buffer, inhibitSameWindow));
}

const displayBufferCommand = e8.defineCommand({
  name: "display-buffer",
  doc:
    "Show a buffer in some window without selecting it.\n\n" +
    "A window that already shows it is used, else a new window split off a large enough one, " +
    "else the least recently used window.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Display buffer: " }],
  run: (buffer) => {
    displayBuffer(buffer);
  },
});

e8.defineCommand({
  name: "pop-to-buffer",
  doc: "Show a buffer in some window, as display-buffer does, and select that window.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Pop to buffer: " }],
  run: (buffer) => popToBuffer(buffer),
});

const switchToBufferOtherWindow = e8.defineCommand({
  name: "switch-to-buffer-other-window",
  doc: "Show a buffer in another window and select it, creating the buffer if there is none.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other window: " }],
  run: (buffer) => popToBuffer(buffer === "" ? (e8.windowBuffer() ?? "*scratch*") : buffer, true),
});

const findFileOtherWindow = e8.defineCommand({
  name: "find-file-other-window",
  doc: "Visit a file in another window and select it.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other window: " }],
  run: (file) => e8.fileDirectoryP(file) ? e8.call("dired-other-window", file) : popToBuffer(e8.findFileNoselect(file), true),
});

const killBufferAndWindow = e8.defineCommand({
  name: "kill-buffer-and-window",
  doc: "Kill the current buffer and delete the selected window.",
  run: () => {
    const buffer = e8.windowBuffer() ?? "";
    const window = e8.selectedWindow();
    if (e8.windowList().length > 1) {
      e8.setWindowParameter(window, "quit-restore", null);
      e8.deleteWindow(window);
    }
    e8.call("kill-buffer", buffer);
  },
});

/**
 * Deletes a window if it can be, as window--delete: with `dedicatedOnly`,
 * only one dedicated to its buffer. The only window of a frame goes with
 * the frame if there are others and its buffer is being killed; Emacs
 * would hide such a frame otherwise, which E8 cannot. Says whether it went.
 */
function windowDelete(window: e8.Window, dedicatedOnly: boolean, kill: boolean): boolean {
  if (dedicatedOnly && !dedicated(window)) return false;
  if (e8.windowList().length > 1) {
    e8.deleteWindow(window);
    return true;
  }
  if (kill && e8.frameList().length > 1) {
    e8.deleteFrame();
    return true;
  }
  return false;
}

/** Selects the window selected when a quit window's buffer was shown, if it is still there. */
function reselect(window: e8.Window | undefined): void {
  if (window !== undefined && window !== e8.selectedWindow() && e8.windowList().includes(window)) e8.selectWindow(window);
}

/**
 * Quits a window, as quit-restore-window: deletes it if it is dedicated or
 * was made for its buffer, else shows what it showed before, as its
 * quit-restore parameter or its previous buffers say. `buryOrKill` says
 * what becomes of its buffer: "kill" kills it, "bury" puts it last in the
 * buffer list and forgets it in the window, and "append" moves it to the
 * end of the window's previous buffers.
 */
function quitRestoreWindow(window: e8.Window, buryOrKill?: "bury" | "kill" | "append"): void {
  const buffer = e8.windowBuffer(window) ?? "";
  const restore = quitRestore(window);
  const selectedThen = restore?.[2];
  const prevBuffer = e8.windowPrevBuffers(window).find(([b]) => b !== buffer)?.[0];
  const flag = e8.windowDedicatedP(window);
  const kill = buryOrKill === "kill";
  if (dedicated(window) && flag !== "side" && windowDelete(window, true, kill)) {
    reselect(selectedThen);
  } else if (
    prevBuffer === undefined &&
    (restore?.[1] === "frame" || (restore?.[1] === "window" && e8.windowList().length > 1)) &&
    restore?.[3] === buffer &&
    windowDelete(window, false, kill)
  ) {
    reselect(selectedThen);
  } else if (restore && Array.isArray(restore[1]) && e8.getBuffer(restore[1][0]) !== undefined && restore[3] === buffer) {
    const [previous, start, point] = restore[1];
    // Where the window was in it, from its previous buffers, which follow
    // edits as the markers Emacs keeps here do.
    const entry = e8.windowPrevBuffers(window).find(([b]) => b === previous);
    e8.setWindowDedicatedP(window, null);
    e8.setWindowBuffer(window, previous);
    e8.setWindowStart(window, entry?.[1] ?? start);
    e8.setWindowPoint(window, entry?.[2] ?? point);
    if (flag === "side") e8.setWindowDedicatedP(window, "side");
    const appended = buryOrKill === "append" ? e8.windowPrevBuffers(window).find(([b]) => b === buffer) : undefined;
    if (buryOrKill) {
      e8.setWindowPrevBuffers(window, e8.windowPrevBuffers(window).filter(([b]) => b !== buffer));
      e8.setWindowNextBuffers(window, e8.windowNextBuffers(window).filter((b) => b !== buffer));
    }
    if (appended) e8.setWindowPrevBuffers(window, [...e8.windowPrevBuffers(window), appended]);
    e8.setWindowParameter(window, "quit-restore", null);
    reselect(selectedThen);
  } else {
    e8.setWindowParameter(window, "quit-restore", null);
    e8.setWindowDedicatedP(window, null);
    if (e8.switchToPrevBuffer(window, buryOrKill) !== undefined) {
      if (flag === "side") e8.setWindowDedicatedP(window, "side");
    } else {
      windowDelete(window, false, kill);
    }
    reselect(selectedThen);
  }
  if (e8.getBuffer(buffer) === undefined) return;
  if (kill) e8.call("kill-buffer", buffer);
  else if (buryOrKill) e8.buryBufferInternal(buffer);
}

e8.defineCommand({
  name: "quit-window",
  doc:
    "Quit the selected window and bury its buffer.\n\n" +
    "A window made to show the buffer is deleted; one that showed another buffer before shows it again, where it was. " +
    "Then the window that was selected when the buffer was shown is selected again. With a prefix argument, the buffer is killed.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill) => {
    const window = e8.selectedWindow();
    e8.withCurrentBuffer(e8.windowBuffer(window) ?? "", () => e8.runHooks("quit-window-hook"));
    quitRestoreWindow(window, kill !== null && kill !== undefined ? "kill" : "bury");
  },
});

e8.defineCommand({
  name: "bury-buffer",
  doc:
    "Put a buffer last in the buffer list, the current one by default.\n\n" +
    "Burying the current buffer shown in the selected window also takes it out of the window: " +
    "a window dedicated to it is deleted, and any other shows the buffer it showed before.",
  run: () => {
    const buffer = e8.bufferName();
    e8.buryBufferInternal(buffer);
    const window = e8.selectedWindow();
    if (window === e8.minibufferWindow() || e8.windowBuffer(window) !== buffer) return;
    if (windowDelete(window, true, false)) return;
    e8.setWindowDedicatedP(window, null);
    e8.switchToPrevBuffer(window, "bury");
  },
});

/** The window C-M-v scrolls, as other-window-for-scrolling: the next one. */
function otherWindowForScrolling(): e8.Window {
  const windows = e8.windowList();
  if (windows.length === 1) throw new Error("There is no other window");
  return windows[(windows.indexOf(e8.selectedWindow()) + 1) % windows.length];
}

function scrollOther(command: e8.CommandName): void {
  const selected = e8.selectedWindow();
  e8.selectWindow(otherWindowForScrolling());
  try {
    e8.callWithPrefix(e8.prefixArg(), command);
  } finally {
    e8.selectWindow(selected);
  }
}

const scrollOtherWindow = e8.defineCommand({
  name: "scroll-other-window",
  doc: "Scroll the next window up a screen, as C-v does in the selected one. A prefix argument says how many lines.",
  run: () => scrollOther("scroll-up-command"),
});

const scrollOtherWindowDown = e8.defineCommand({
  name: "scroll-other-window-down",
  doc: "Scroll the next window down a screen, as M-v does in the selected one. A prefix argument says how many lines.",
  run: () => scrollOther("scroll-down-command"),
});

// The buffers a window showed before, as window.el's previous-buffer and next-buffer.

/** Why the selected window cannot switch buffers, if it cannot, as previous-buffer checks. */
function cannotSwitch(): void {
  if (e8.selectedWindow() === e8.minibufferWindow()) e8.userError("Cannot switch buffers in minibuffer window");
  if (e8.windowDedicatedP() === true) e8.userError("Window is strongly dedicated to its buffer");
}

const previousBuffer = e8.defineCommand({
  name: "previous-buffer",
  doc:
    "Show in the selected window the buffer it showed before this one, as switch-to-prev-buffer.\n\n" +
    "Repeated, it goes further back, then through the buffer list; next-buffer comes forward again. A prefix argument goes that many back.",
  params: [{ name: "count", kind: "count" }],
  run: (count) => {
    cannotSwitch();
    const interactive = e8.calledInteractively() && !e8.executingKbdMacro();
    for (let n = count; n > 0; n--) {
      if (e8.switchToPrevBuffer() === undefined && interactive) e8.userError("No previous buffer");
    }
  },
});

const nextBuffer = e8.defineCommand({
  name: "next-buffer",
  doc: "Show in the selected window the buffer previous-buffer went back from, as switch-to-next-buffer. A prefix argument goes that many on.",
  params: [{ name: "count", kind: "count" }],
  run: (count) => {
    cannotSwitch();
    const interactive = e8.calledInteractively() && !e8.executingKbdMacro();
    for (let n = count; n > 0; n--) {
      if (e8.switchToNextBuffer() === undefined && interactive) e8.userError("No next buffer");
    }
  },
});

// Resizing, as window.el's enlarge-window and shrink-window.

/**
 * Grows the selected window by the prefix argument's lines or columns, or
 * shrinks it when `shrink`. As in Emacs, the commands themselves fail when
 * the windows around cannot give up that much; otherwise it goes as far as
 * it can.
 */
function resize(command: string, horizontal: boolean, shrink: boolean): void {
  const count = e8.prefixNumericValue(e8.prefixArg());
  const delta = shrink ? -count : count;
  if (delta === 0) return;
  if (e8.resizeWindow(undefined, delta, horizontal, false) === delta) {
    e8.resizeWindow(undefined, delta, horizontal);
    return;
  }
  if (e8.thisCommand() === command) {
    throw new Error(`Cannot ${shrink ? "shrink" : "enlarge"} selected window ${horizontal ? "horizontally" : "vertically"}`);
  }
  e8.resizeWindow(undefined, delta, horizontal);
}

const enlargeWindow = e8.defineCommand({
  name: "enlarge-window",
  doc: "Make the selected window taller by the prefix argument's lines, taking them from its neighbour.",
  run: () => resize("enlarge-window", false, false),
});

e8.defineCommand({
  name: "shrink-window",
  doc: "Make the selected window shorter by the prefix argument's lines, giving them to its neighbour.",
  run: () => resize("shrink-window", false, true),
});

const enlargeWindowHorizontally = e8.defineCommand({
  name: "enlarge-window-horizontally",
  doc: "Make the selected window wider by the prefix argument's columns, taking them from its neighbour.",
  run: () => resize("enlarge-window-horizontally", true, false),
});

const shrinkWindowHorizontally = e8.defineCommand({
  name: "shrink-window-horizontally",
  doc: "Make the selected window narrower by the prefix argument's columns, giving them to its neighbour.",
  run: () => resize("shrink-window-horizontally", true, true),
});

const balanceWindows = e8.defineCommand({
  name: "balance-windows",
  doc: "Make windows side by side the same width and windows one above another the same height.",
  run: () => e8.balanceWindows(),
});

const shrinkIfLarger = e8.defineCommand({
  name: "shrink-window-if-larger-than-buffer",
  doc:
    "Shrink the selected window to fit its buffer, if the buffer is shorter than the window.\n\n" +
    "The window keeps at least window-min-height lines, and a window alone in its column is left as it is.",
  run: () => {
    const s = size(e8.selectedWindow());
    const needed = Math.max(WINDOW_MIN_HEIGHT, e8.lineCount() + 1);
    if (s.totalHeight > needed) e8.resizeWindow(undefined, needed - s.totalHeight, false);
  },
});

// Frames, as frame.el's commands, on C-x 5.

const makeFrameCommand = e8.defineCommand({
  name: "make-frame-command",
  doc: "Make a new frame showing the current buffer, and select it.",
  run: () => {
    e8.makeFrame();
  },
});

const otherFrame = e8.defineCommand({
  name: "other-frame",
  doc: "Select another frame, the next in frame-list's order; a prefix argument says how many on to go.",
  run: () => {
    const frames = e8.frameList();
    const count = e8.prefixNumericValue(e8.prefixArg());
    const i = frames.indexOf(e8.selectedFrame());
    const n = frames.length;
    e8.selectFrame(frames[(((i + count) % n) + n) % n]);
  },
});

const deleteFrameCommand = e8.defineCommand({
  name: "delete-frame",
  doc: "Delete the selected frame and its windows. The only frame cannot be deleted.",
  run: () => e8.deleteFrame(),
});

const deleteOtherFrames = e8.defineCommand({
  name: "delete-other-frames",
  doc: "Delete every frame but the selected one.",
  run: () => {
    const selected = e8.selectedFrame();
    for (const frame of e8.frameList()) if (frame !== selected) e8.deleteFrame(frame);
  },
});

const switchToBufferOtherFrame = e8.defineCommand({
  name: "switch-to-buffer-other-frame",
  doc: "Show a buffer in a new frame and select it, creating the buffer if there is none.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other frame: " }],
  run: (buffer) => {
    const name = buffer === "" ? (e8.windowBuffer() ?? "*scratch*") : buffer;
    e8.getBufferCreate(name);
    e8.makeFrame(name);
  },
});

const findFileOtherFrame = e8.defineCommand({
  name: "find-file-other-frame",
  doc: "Visit a file in a new frame and select it.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other frame: " }],
  run: (file) => {
    e8.makeFrame(e8.findFileNoselect(file));
  },
});

const displayBufferOtherFrame = e8.defineCommand({
  name: "display-buffer-other-frame",
  doc: "Show a buffer in a new frame, leaving the selected frame selected.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Display buffer in other frame: " }],
  run: (buffer) => {
    const selected = e8.selectedFrame();
    e8.getBufferCreate(buffer);
    e8.makeFrame(buffer);
    e8.selectFrame(selected);
  },
});

e8.bindKey("C-x 5 2", makeFrameCommand);
e8.bindKey("C-x 5 o", otherFrame);
e8.bindKey("C-x 5 0", deleteFrameCommand);
e8.bindKey("C-x 5 1", deleteOtherFrames);
e8.bindKey("C-x 5 b", switchToBufferOtherFrame);
e8.bindKey("C-x 5 f", findFileOtherFrame);
e8.bindKey("C-x 5 C-f", findFileOtherFrame);
e8.bindKey("C-x 5 C-o", displayBufferOtherFrame);

e8.bindKey("C-x <left>", previousBuffer);
e8.bindKey("C-x <right>", nextBuffer);
const splitRootBelow = e8.defineCommand({
  name: "split-root-window-below",
  doc:
    "Split the frame's root window in two, the new window below taking the frame's whole width. " +
    "A prefix argument gives the windows above that many lines, or the new one if it is negative.",
  run: () => {
    e8.splitRootWindow("below", splitSize());
  },
});

const splitRootRight = e8.defineCommand({
  name: "split-root-window-right",
  doc:
    "Split the frame's root window in two, the new window on the right taking the frame's whole height. " +
    "A prefix argument gives the windows on the left that many columns, or the new one if it is negative.",
  run: () => {
    e8.splitRootWindow("right", splitSize());
  },
});

e8.bindKey("C-x w 2", splitRootBelow);
e8.bindKey("C-x w 3", splitRootRight);
e8.bindKey("C-x 2", splitBelow);
e8.bindKey("C-x 3", splitRight);
e8.bindKey("C-x o", otherWindow);
e8.bindKey("C-x 0", deleteWindow);
e8.bindKey("C-x 1", deleteOtherWindows);
e8.bindKey("C-x 4 b", switchToBufferOtherWindow);
e8.bindKey("C-x 4 f", findFileOtherWindow);
e8.bindKey("C-x 4 C-f", findFileOtherWindow);
e8.bindKey("C-x 4 C-o", displayBufferCommand);
e8.bindKey("C-x 4 0", killBufferAndWindow);
e8.bindKey("C-M-v", scrollOtherWindow);
e8.bindKey("C-M-S-v", scrollOtherWindowDown);
e8.bindKey("C-x ^", enlargeWindow);
e8.bindKey("C-x }", enlargeWindowHorizontally);
e8.bindKey("C-x {", shrinkWindowHorizontally);
e8.bindKey("C-x +", balanceWindows);
e8.bindKey("C-x -", shrinkIfLarger);

// C-l, after window.el's recenter-top-bottom: the line with point to the
// middle, then the top, then the bottom of the window, each time in a row.

e8.defineVariable({
  name: "recenter-positions",
  doc: "Where C-l puts the line with point each time in a row: middle, top, bottom, or a line of the window.",
  value: ["middle", "top", "bottom"],
});

let recenterLastOp: e8.Value | undefined;

e8.defineCommand({
  name: "recenter-top-bottom",
  doc:
    "Scroll so the line with point is in the middle of the window; again, at the top; again, at the bottom, " +
    "as recenter-positions says. With a prefix argument, put it on that line of the window, as recenter does.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (arg !== null) {
      e8.callWithPrefix(arg, "recenter");
      return;
    }
    const positions = (e8.variable("recenter-positions") ?? ["middle"]) as e8.Value[];
    if (e8.lastCommand() === "recenter-top-bottom") {
      const i = positions.findIndex((p) => JSON.stringify(p) === JSON.stringify(recenterLastOp));
      recenterLastOp = i >= 0 && i + 1 < positions.length ? positions[i + 1] : positions[0];
    } else {
      recenterLastOp = positions[0];
    }
    const margin = Math.max(0, Number(e8.variable("scroll-margin") ?? 0));
    const op = recenterLastOp;
    if (op === "middle") e8.callWithPrefix(null, "recenter");
    else if (op === "top") e8.callWithPrefix(margin, "recenter");
    else if (op === "bottom") e8.callWithPrefix(-1 - margin, "recenter");
    else if (typeof op === "number" && Number.isInteger(op)) e8.callWithPrefix(op, "recenter");
  },
});
e8.bindKey("C-l", "recenter-top-bottom");

e8.defineCommand({
  name: "move-to-window-line-top-bottom",
  doc:
    "Move point to the line in the middle of the window; again, the top line; again, the bottom one, " +
    "as recenter-positions says. With a prefix argument, to that line of the window, as move-to-window-line does.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg) => {
    if (arg !== null) {
      e8.callWithPrefix(arg, "move-to-window-line");
      return;
    }
    // It goes through recenter-positions as C-l does, sharing where it is.
    const positions = (e8.variable("recenter-positions") ?? ["middle"]) as e8.Value[];
    if (e8.lastCommand() === "move-to-window-line-top-bottom") {
      const i = positions.findIndex((p) => JSON.stringify(p) === JSON.stringify(recenterLastOp));
      recenterLastOp = i >= 0 && i + 1 < positions.length ? positions[i + 1] : positions[0];
    } else {
      recenterLastOp = positions[0];
    }
    const margin = Math.max(0, Number(e8.variable("scroll-margin") ?? 0));
    const op = recenterLastOp;
    if (op === "middle") e8.callWithPrefix(null, "move-to-window-line");
    else if (op === "top") e8.callWithPrefix(margin, "move-to-window-line");
    else if (op === "bottom") e8.callWithPrefix(-1 - margin, "move-to-window-line");
    else if (typeof op === "number" && Number.isInteger(op)) e8.callWithPrefix(op, "move-to-window-line");
  },
});
e8.bindKey("M-r", "move-to-window-line-top-bottom");

// --- Window states, as window.el's window-state-get and window-state-put ----

/** One window's part of a window state: its buffer, by name and file, and where it starts and its point. */
interface WindowLeafState {
  buffer: string;
  file?: string;
  point: number;
  start: number;
  selected: boolean;
}
/** The selected frame's windows as data, which can be written out and read back, as window-state-get with WRITABLE. */
export type WindowState = WindowLeafState | { sideBySide: boolean; firstSize: number | null; first: WindowState; second: WindowState };

export function windowStateGet(): WindowState {
  const selected = e8.selectedWindow();
  const node = (t: e8.WindowTreeNode): WindowState => {
    if (!Array.isArray(t)) {
      const buffer = e8.windowBuffer(t) ?? "*scratch*";
      const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName());
      return { buffer, ...(file ? { file } : {}), point: e8.windowPoint(t), start: e8.windowStart(t), selected: t === selected };
    }
    const [sideBySide, firstSize, first, second] = t;
    return { sideBySide, firstSize, first: node(first), second: node(second) };
  };
  return node(e8.windowTree());
}

/**
 * Makes the selected frame's windows as a state says, as window-state-put:
 * each shows its buffer, or the buffer visiting its file, or else the
 * current buffer, at its point.
 */
export function windowStatePut(state: WindowState): void {
  e8.call("delete-other-windows");
  let toSelect: e8.Window | undefined;
  const fill = (window: e8.Window, s: WindowState): void => {
    if ("buffer" in s) {
      const visiting = (file: string) => e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === file);
      const byFile = s.file ? visiting(s.file) : undefined;
      const live = e8.getBuffer(byFile ?? s.buffer);
      if (live) {
        e8.setWindowBuffer(window, live.name!);
        e8.setWindowStart(window, Math.min(s.start, e8.withCurrentBuffer(live, () => e8.bufferSize())));
        e8.setWindowPoint(window, Math.min(s.point, e8.withCurrentBuffer(live, () => e8.bufferSize())));
      }
      if (s.selected) toSelect = window;
      return;
    }
    let other: e8.Window;
    try {
      other = e8.splitWindow(window, s.sideBySide ? "right" : "below", s.firstSize ?? undefined);
    } catch {
      other = e8.splitWindow(window, s.sideBySide ? "right" : "below");
    }
    fill(window, s.first);
    fill(other, s.second);
  };
  fill(e8.selectedWindow(), state);
  if (toSelect !== undefined) e8.selectWindow(toSelect);
}

// window-configuration-change-hook: run after a command that changed which
// windows the selected frame has or which buffers they show, where Emacs
// runs it as redisplay finds the change.
e8.defineHook("window-configuration-change-hook", "Functions called after the selected frame's windows, or the buffers they show, change.");
let lastConfiguration: string | undefined;
e8.addHook("post-command-hook", () => {
  const now = e8.windowList().map((w) => `${w}:${e8.windowBuffer(w)}`).join(" ");
  if (now === lastConfiguration) return;
  const changed = lastConfiguration !== undefined;
  lastConfiguration = now;
  if (changed) e8.runHooks("window-configuration-change-hook");
});
