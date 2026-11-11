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
  doc:
    "Make the selected window fill the frame, deleting the others.\n\n" +
    "As in Emacs, a window's delete-other-windows parameter can be a function to call instead, windows with a " +
    "no-delete-other-windows parameter stay, and in a side window this is an error.",
  run: () => {
    const selected = e8.selectedWindow();
    const fn = e8.variable("ignore-window-parameters") ? undefined : e8.windowParameter(selected, "delete-other-windows");
    if (fn !== undefined && fn !== null && fn !== true) {
      e8.funcall((typeof fn === "symbol" ? fn.description : fn) as string, selected);
      return;
    }
    if (fn !== true && !e8.variable("ignore-window-parameters")) {
      if (e8.windowParameter(selected, "window-side") != null) e8.signal("error", "Cannot make side window the only window");
      if (selected === e8.minibufferWindow()) e8.signal("error", "Can't expand minibuffer to full frame");
    }
    const keep = (w: e8.Window) => !e8.variable("ignore-window-parameters") && e8.windowParameter(w, "no-delete-other-windows") != null;
    for (const window of e8.windowList()) {
      if (window !== selected && !keep(window)) e8.deleteWindow(window);
    }
  },
});

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

// Displaying buffers, as window.el's display-buffer does: the actions in
// display-buffer-alist, display-buffer-base-action and the rest, each a
// list of action functions and an alist, tried in turn (ADR 0069).
//
// Lisp's data is held as E8 holds it: a list is an array, an alist entry
// (KEY . VALUE) is [KEY, VALUE], and an action (FUNCTIONS . ALIST) is
// [FUNCTIONS, ...ALIST], so a display-buffer-alist entry (CONDITION
// FUNCTIONS . ALIST) is [CONDITION, FUNCTIONS, ...ALIST]. Symbols may be
// strings or Symbol.for(name): `["side", "right"]` and `["side",
// Symbol.for("right")]` are the same entry.

/** Lisp's nil: null, undefined, false or an empty list. */
const isNil = (v: unknown): boolean => v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0);
/** A symbol's or string's name; undefined for anything else. */
const symName = (v: unknown): string | undefined => (typeof v === "symbol" ? v.description : typeof v === "string" ? v : undefined);

/** Calls a function a Lisp value names: a function, or a symbol or string naming one, as funcall. */
const fcall = (f: unknown, ...args: unknown[]): any => e8.funcall((typeof f === "symbol" ? f.description : f) as string, ...args);

/** An alist as display-buffer passes it to action functions. */
export type Alist = e8.Value[];

/** The first entry of an alist whose key is `key`, as assq. */
function assq(alist: Alist, key: string): e8.Value[] | undefined {
  for (const entry of alist) {
    if (Array.isArray(entry) && entry.length > 0 && symName(entry[0]) === key) return entry;
  }
  return undefined;
}

/** The value of an alist's entry for `key`, as (cdr (assq KEY ALIST)): [KEY, V] gives V, [KEY, A, B] gives [A, B]. */
export function alistGet(alist: Alist, key: string): e8.Value | undefined {
  const entry = assq(alist, key);
  if (entry === undefined) return undefined;
  return entry.length === 2 ? entry[1] : entry.slice(1);
}

/** Whether an alist's entry for `key` is there and not nil. */
const alistTrue = (alist: Alist, key: string): boolean => !isNil(alistGet(alist, key));

/** The windows on the frames a `reusable-frames` or ALL-FRAMES value says, as window-list-1 takes them: nil the selected frame, t every frame, `visible` and 0 those shown, a frame that one. */
function windowsOnFrames(frames: e8.Value | undefined, minibuffer = false): e8.Window[] {
  const all = e8.windowList1(undefined, minibuffer, true);
  if (isNil(frames)) return all.filter((w) => e8.windowFrame(w) === e8.selectedFrame());
  if (frames === true) return all;
  if (e8.framep(frames)) return all.filter((w) => e8.windowFrame(w) === frames);
  // visible and 0: frames that are shown, iconified ones too for 0.
  return all.filter((w) => {
    const visible = e8.frameVisibleP(e8.windowFrame(w));
    return visible === true || (frames === 0 && visible === "icon");
  });
}

/** The windows showing a buffer, the selected one first, as get-buffer-window-list. */
export function getBufferWindowList(buffer: e8.BufferLike, minibuffer = false, allFrames?: e8.Value): e8.Window[] {
  const name = e8.bufferName(buffer);
  return windowsOnFrames(allFrames, minibuffer).filter((w) => e8.windowBuffer(w) === name);
}

/** Whether a window is dedicated to its buffer, which display-buffer does not take for another. */
const dedicated = (window: e8.Window): boolean => !isNil(e8.windowDedicatedP(window));

function size(window: e8.Window) {
  return e8.windowSize(window) ?? { width: 0, height: 0, totalWidth: 0, totalHeight: 0, fullWidth: true };
}

/**
 * The least recently used window, as get-lru-window: on the frames
 * `allFrames` says, one that spans its frame's width if there is any;
 * the selected window only last, and not at all with `notSelected`; a
 * dedicated one only with `dedicatedOk`; never a side window or one with a
 * no-other-window parameter.
 */
export function getLruWindow(allFrames?: e8.Value, dedicatedOk = false, notSelected = false): e8.Window | undefined {
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let bestTime = Infinity;
  let second: e8.Window | undefined;
  let secondTime = Infinity;
  for (const window of windowsOnFrames(allFrames)) {
    if ((notSelected && window === selected) || (!dedicatedOk && dedicated(window))) continue;
    if (!isNil(e8.windowParameter(window, "no-other-window")) || !isNil(e8.windowParameter(window, "window-side"))) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (window === selected || !size(window).fullWidth) {
      if (time < secondTime) [second, secondTime] = [window, time];
    } else if (time < bestTime) {
      [best, bestTime] = [window, time];
    }
  }
  return best ?? second;
}

/** The most recently used window other than the selected one, unless only it is left, as get-mru-window. */
export function getMruWindow(allFrames?: e8.Value, dedicatedOk = false, notSelected = false): e8.Window | undefined {
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let bestTime = -Infinity;
  for (const window of windowsOnFrames(allFrames)) {
    if ((notSelected && window === selected) || (!dedicatedOk && dedicated(window))) continue;
    if (!isNil(e8.windowParameter(window, "no-other-window"))) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (time > bestTime) [best, bestTime] = [window, time];
  }
  return best;
}

/** The largest window by area, as get-largest-window, with get-lru-window's conditions. */
export function getLargestWindow(allFrames?: e8.Value, dedicatedOk = false, notSelected = false): e8.Window | undefined {
  let best: e8.Window | undefined;
  let bestArea = -1;
  for (const window of windowsOnFrames(allFrames)) {
    if ((notSelected && window === e8.selectedWindow()) || (!dedicatedOk && dedicated(window))) continue;
    if (!isNil(e8.windowParameter(window, "no-other-window")) || !isNil(e8.windowParameter(window, "window-side"))) continue;
    const s = size(window);
    const area = s.totalWidth * s.totalHeight;
    if (area > bestArea) [best, bestArea] = [window, area];
  }
  return best;
}

/** The split above a window in its frame's tree, and whether the window is its first part. */
function parentSplit(window: e8.Window): { sideBySide: boolean; first: boolean } | undefined {
  const walk = (t: e8.WindowTreeNode): { sideBySide: boolean; first: boolean } | undefined => {
    if (!Array.isArray(t)) return undefined;
    const [sideBySide, , first, second] = t;
    if (first === window) return { sideBySide, first: true };
    if (second === window) return { sideBySide, first: false };
    return walk(first) ?? walk(second);
  };
  return walk(e8.windowTree());
}

/** Whether a window is part of a combination one above another, or side by side with `horizontal`, as window-combined-p. */
export function windowCombinedP(window: e8.Window, horizontal = false): boolean {
  const parent = parentSplit(window);
  return parent !== undefined && parent.sideBySide === horizontal;
}

/** A window's edges, as window-edges. */
const edges = (window: e8.Window): [number, number, number, number] => e8.windowEdges(window);

/**
 * The window next to one in a direction, as window-in-direction: above,
 * below, left or right of it, along the line or column its point is on;
 * none at the frame's edge. The minibuffer's window and windows with a
 * no-other-window parameter, unless `ignore`, are not taken.
 */
export function windowInDirection(direction: string, window: e8.Window = e8.selectedWindow(), ignore = false): e8.Window | undefined {
  const dir = direction === "up" ? "above" : direction === "down" ? "below" : direction;
  if (!["above", "below", "left", "right"].includes(dir)) e8.signal("error", `Wrong direction ${direction}`);
  const [l, t, r, b] = edges(window);
  const hor = dir === "left" || dir === "right";
  // Along the row or column point is on, as Emacs's posn-at-point gives it.
  const posn = e8.posnAtPoint(e8.windowPoint(window), window);
  const along = hor ? t + (posn?.row ?? 0) : l + (posn?.col ?? 0);
  let best: e8.Window | undefined;
  let bestEdge = dir === "below" || dir === "right" ? Infinity : -Infinity;
  for (const w of e8.windowList1(window, false, false)) {
    if (w === window || (!ignore && !isNil(e8.windowParameter(w, "no-other-window")))) continue;
    const [wl, wt, wr, wb] = edges(w);
    if (hor ? !(wt <= along && along < wb) : !(wl <= along && along < wr)) continue;
    if (dir === "left" && wr <= l && wl > bestEdge) [best, bestEdge] = [w, wl];
    else if (dir === "right" && wl >= r && wl < bestEdge) [best, bestEdge] = [w, wl];
    else if (dir === "above" && wb <= t && wt > bestEdge) [best, bestEdge] = [w, wt];
    else if (dir === "below" && wt >= b && wt < bestEdge) [best, bestEdge] = [w, wt];
  }
  return best;
}

/** The windows along an edge of `window`, in a direction, as windows-sharing-edge: those whose opposite edge touches it. */
function windowsSharingEdge(window: e8.Window, direction: string): e8.Window[] {
  const [l, t, r, b] = edges(window);
  return e8.windowList1(window, false, false).filter((w) => {
    if (w === window) return false;
    const [wl, wt, wr, wb] = edges(w);
    if (direction === "left") return wr === l && wt < b && wb > t;
    if (direction === "right") return wl === r && wt < b && wb > t;
    if (direction === "above") return wb === t && wl < r && wr > l;
    return wt === b && wl < r && wr > l;
  });
}

/**
 * The frame's main window, as window-main-window: the window that is not
 * a side window next to the side windows, the frame's only part not a side
 * window. E8 has no internal windows yet (ADR 0069, stage 3): with several
 * windows besides the side windows, the selected one stands for them.
 */
export function windowMainWindow(): e8.Window {
  const others = e8.windowList().filter((w) => w !== e8.minibufferWindow() && isNil(e8.windowParameter(w, "window-side")));
  if (others.length === 1) return others[0];
  const selected = e8.selectedWindow();
  return others.includes(selected) ? selected : (others[0] ?? selected);
}

e8.defineVariable({
  name: "ignore-window-parameters",
  doc: "If non-nil, the window commands pay no attention to window parameters such as delete-other-windows and window-side.",
  value: null,
});
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
e8.defineVariable({
  name: "window-min-height",
  doc: "The fewest lines a window may have, its mode line included, when it is split or resized.",
  value: 4,
});
e8.defineVariable({
  name: "window-min-width",
  doc: "The fewest columns a window may have when it is split or resized.",
  value: 10,
});
e8.defineVariable({
  name: "display-buffer-alist",
  doc:
    "How display-buffer shows buffers: a list of entries [CONDITION, FUNCTIONS, ...ALIST], as Emacs's (CONDITION . ACTION). " +
    "CONDITION is matched by buffer-match-p: a regexp the buffer's name matches, a function, or [\"major-mode\", MODE], " +
    "[\"derived-mode\", MODE], [\"category\", NAME], [\"not\", ...], [\"or\", ...] or [\"and\", ...]. " +
    "FUNCTIONS is an action function or a list of them, tried in turn; each ALIST entry is [KEY, VALUE], such as [\"side\", \"right\"].",
  value: null,
});
e8.defineVariable({
  name: "display-buffer-base-action",
  doc: "The action display-buffer tries after the caller's and display-buffer-alist's: [FUNCTIONS, ...ALIST].",
  value: [null],
});
e8.defineVariable({
  name: "display-buffer-overriding-action",
  doc: "The action display-buffer tries before all others, for code to bind: [FUNCTIONS, ...ALIST].",
  value: [null],
});
e8.defineVariable({
  name: "display-buffer-fallback-action",
  doc: "The action display-buffer tries when all others fail, as Emacs's; not to be changed.",
  value: [
    [
      "display-buffer--maybe-same-window",
      "display-buffer-reuse-window",
      "display-buffer--maybe-pop-up-frame-or-window",
      "display-buffer-in-previous-window",
      "display-buffer-use-some-window",
      "display-buffer-pop-up-frame",
    ],
  ],
});
e8.defineVariable({ name: "display-buffer-reuse-frames", doc: "Whether display-buffer reuses windows on other visible frames; obsolete in Emacs, kept as it reads it.", value: null });
e8.defineVariable({ name: "pop-up-frames", doc: "Whether display-buffer makes a new frame for a buffer rather than a window: t always, graphic-only on a graphical display.", value: null });
e8.defineVariable({ name: "pop-up-windows", doc: "Whether display-buffer may split a window to show a buffer.", value: true });
e8.defineVariable({ name: "split-window-preferred-function", doc: "The function display-buffer splits a window with, given the window, giving the new window or nil.", value: "split-window-sensibly" });
e8.defineVariable({ name: "pop-up-frame-function", doc: "The function display-buffer makes a new frame with, giving the frame.", value: null });
e8.defineVariable({ name: "same-window-buffer-names", doc: "Names of buffers display-buffer shows in the selected window.", value: null });
e8.defineVariable({ name: "same-window-regexps", doc: "Regexps for names of buffers display-buffer shows in the selected window.", value: null });
e8.defineVariable({
  name: "even-window-sizes",
  doc: "Whether showing a buffer in another window evens the two windows' sizes: t, width-only, height-only or nil.",
  value: true,
});
e8.defineVariable({ name: "display-buffer-mark-dedicated", doc: "If non-nil, the windows display-buffer makes are dedicated, with this as the flag.", value: null });
e8.defineVariable({
  name: "window-sides-slots",
  doc: "How many side windows each side may have: [LEFT, TOP, RIGHT, BOTTOM], each a number or nil for any.",
  value: [null, null, null, null],
});
e8.defineVariable({ name: "window-sides-vertical", doc: "Whether side windows on the left and right take the frame's whole height.", value: null });

/** The fewest lines and columns a window may have, as window-min-height and window-min-width. */
const minHeight = (): number => Math.max(1, Number(e8.variable("window-min-height") ?? 4) || 4);
const minWidth = (): number => Math.max(2, Number(e8.variable("window-min-width") ?? 10) || 10);

/** Whether a window is big enough to split, as window-splittable-p: never a side window, and a threshold of nil never is. */
export function windowSplittableP(window: e8.Window, horizontal = false): boolean {
  if (!e8.windowLiveP(window) || !isNil(e8.windowParameter(window, "window-side"))) return false;
  const s = size(window);
  if (horizontal) {
    const threshold = e8.variable("split-width-threshold");
    return typeof threshold === "number" && s.width >= Math.max(threshold, 2 * Math.max(minWidth(), 2));
  }
  const threshold = e8.variable("split-height-threshold");
  const modeLine = e8.withCurrentBuffer(e8.windowBuffer(window) ?? e8.currentBuffer(), () => !isNil(e8.variable("mode-line-format")));
  return typeof threshold === "number" && s.totalHeight >= Math.max(threshold, 2 * Math.max(minHeight(), modeLine ? 2 : 1));
}

/**
 * Splits a window the way that suits its size, as split-window-sensibly:
 * below it if it is tall enough, else to its right if it is wide enough,
 * else below it anyway if it is its frame's only window, or all the
 * others are dedicated. Returns the new window.
 */
export function splitWindowSensibly(window: e8.Window = e8.selectedWindow()): e8.Window | undefined {
  const split = (side: "below" | "right") => e8.conditionCase<e8.Window | undefined>(() => e8.splitWindow(window, side), { error: () => undefined });
  if (windowSplittableP(window)) return split("below");
  if (windowSplittableP(window, true)) return split("right");
  const others = windowsOnFrames(e8.windowFrame(window)).filter((w) => w !== window && !dedicated(w));
  if (others.length === 0 && window !== e8.minibufferWindow()) {
    return e8.letBind({ "split-height-threshold": 0 }, () => (windowSplittableP(window) ? split("below") : undefined));
  }
  return undefined;
}
e8.defun("split-window-sensibly", (window?: e8.Window) => splitWindowSensibly(window ?? e8.selectedWindow()) ?? null);

/** Splits a window for display-buffer, as window--try-to-split-window, with split-window-preferred-function. */
function tryToSplitWindow(window: e8.Window | undefined): e8.Window | undefined {
  if (window === undefined || !e8.windowLiveP(window) || !isNil(e8.frameParameter(e8.windowFrame(window), "unsplittable"))) return undefined;
  const fn = e8.variable("split-window-preferred-function") ?? "split-window-sensibly";
  const made = e8.conditionCase<e8.Value | undefined>(() => fcall(fn, window), { error: () => undefined });
  return e8.windowp(made) && e8.windowLiveP(made) ? (made as e8.Window) : undefined;
}

/** Evens two windows side by side or one above the other, as window--even-window-sizes. */
function evenWindowSizes(window: e8.Window): void {
  const how = e8.variable("even-window-sizes");
  const selected = e8.selectedWindow();
  const parent = parentSplit(window);
  if (isNil(how) || parent === undefined) return;
  const other = parentSplit(selected);
  if (other === undefined || other.sideBySide !== parent.sideBySide || e8.windowList().length !== 2) return;
  const [s, w] = [size(selected), size(window)];
  if (parent.sideBySide && symName(how) !== "height-only" && s.totalWidth > w.totalWidth) {
    e8.conditionCase(() => e8.resizeWindow(selected, -Math.trunc((s.totalWidth - w.totalWidth) / 2), true), { error: () => 0 });
  } else if (!parent.sideBySide && symName(how) !== "width-only" && s.totalHeight > w.totalHeight) {
    e8.conditionCase(() => e8.resizeWindow(selected, -Math.trunc((s.totalHeight - w.totalHeight) / 2), false), { error: () => 0 });
  }
}

/** Shows and raises the frame a window is on, unless it is the selected one, as window--maybe-raise-frame. */
function maybeRaiseFrame(frame: e8.Frame | undefined): void {
  if (frame === undefined) return;
  e8.makeFrameVisible(frame);
  if (frame !== e8.selectedFrame() && isNil(e8.frameParameter(frame, "no-focus-on-map")) && isNil(e8.frameParameter(frame, "no-accept-focus"))) {
    e8.raiseFrame(frame);
  }
}

/** The frames display-buffer reuses windows on, from the alist and the options, as display-buffer-reuse-window works them out. */
function reusableFrames(alist: Alist): e8.Value | undefined {
  const entry = assq(alist, "reusable-frames");
  if (entry !== undefined) return entry[1];
  if (popUpFrames(alist)) return 0;
  if (!isNil(e8.variable("display-buffer-reuse-frames"))) return 0;
  return null;
}

/** Whether display-buffer should pop up a frame, as window--pop-up-frames. */
function popUpFrames(alist: Alist): boolean {
  const entry = assq(alist, "pop-up-frames");
  const v = entry !== undefined ? entry[1] : e8.variable("pop-up-frames");
  if (symName(v) === "graphic-only") return e8.displayGraphicP();
  return !isNil(v);
}

/**
 * Shows a buffer in a window an action function chose, as
 * window--display-buffer: notes how to undo it in the window's
 * quit-restore parameter, shows the buffer, marks the window dedicated as
 * the alist or display-buffer-mark-dedicated says, gives a new window no
 * previous buffers, calls the alist's body-function, sizes a new window by
 * its window-height and window-width, and sets its window-parameters.
 */
export function windowDisplayBuffer(buffer: e8.BufferLike, window: e8.Window | undefined, type: "reuse" | "window" | "frame", alist: Alist = []): e8.Window | undefined {
  const name = e8.bufferName(buffer);
  if (name === undefined || window === undefined || !e8.windowLiveP(window)) return undefined;
  recordWindow(type, window, name);
  if (e8.windowBuffer(window) !== name) {
    e8.setWindowDedicatedP(window, null);
    e8.setWindowBuffer(window, name);
  }
  const dedicatedEntry = assq(alist, "dedicated");
  if (dedicated(window) || (type === "reuse" && symName(dedicatedEntry?.[1]) !== "side")) {
    // A dedicated window stays as it is, and a reused one is not made dedicated.
  } else if (dedicatedEntry !== undefined) {
    e8.setWindowDedicatedP(window, dedicatedEntry[1] ?? null);
  } else if (!isNil(e8.variable("display-buffer-mark-dedicated"))) {
    e8.setWindowDedicatedP(window, e8.variable("display-buffer-mark-dedicated") ?? null);
  }
  if (type !== "reuse") e8.setWindowPrevBuffers(window, []);
  const body = alistGet(alist, "body-function");
  if (typeof body === "function" || (typeof body === "string" && body !== "")) {
    e8.letBind({ "inhibit-read-only": true, "inhibit-modification-hooks": true }, () => fcall(body, window));
  }
  const restore = quitRestore(window);
  const made = type === "window" || (restore?.[0] === "same" && restore?.[1] === "window");
  if (made) {
    applySize(window, alistGet(alist, "window-height"), false);
    applySize(window, alistGet(alist, "window-width"), true);
    const preserve = alistGet(alist, "preserve-size");
    if (Array.isArray(preserve)) e8.setWindowParameter(window, "window-preserved-size", preserve);
  }
  const parameters = alistGet(alist, "window-parameters");
  const pairs = Array.isArray(parameters) && parameters.every(Array.isArray) ? parameters : assq(alist, "window-parameters")?.slice(1) ?? [];
  for (const p of pairs) {
    if (Array.isArray(p) && p.length >= 1) e8.setWindowParameter(window, symName(p[0]) ?? String(p[0]), p.length === 2 ? (p[1] ?? null) : p.slice(1));
  }
  return window;
}

/** Sizes a window display-buffer made, as window--display-buffer does with window-height or window-width: lines or columns, a fraction of the frame, [body-lines, N], or a function given the window. */
function applySize(window: e8.Window, value: e8.Value | undefined, horizontal: boolean): void {
  if (isNil(value)) return;
  if (typeof value === "function" || typeof value === "string") {
    e8.conditionCase(() => fcall(value, window), { error: () => null });
    return;
  }
  if (!windowCombinedP(window, horizontal)) return;
  const s = size(window);
  const total = horizontal ? s.totalWidth : s.totalHeight;
  let wanted: number | undefined;
  if (typeof value === "number") {
    const frame = horizontal ? e8.frameWidth() : e8.frameHeight();
    wanted = Number.isInteger(value) ? value : Math.round(frame * value);
  } else if (Array.isArray(value) && (symName(value[0]) === "body-lines" || symName(value[0]) === "body-columns") && typeof value[1] === "number") {
    wanted = value[1] + total - (horizontal ? s.width : s.height);
  }
  if (wanted === undefined || wanted === total) return;
  const delta = wanted - total;
  e8.conditionCase(() => e8.resizeWindow(window, delta, horizontal), { error: () => 0 });
}

/** Whether display-buffer should show a buffer in the selected window, as same-window-p: its name is in same-window-buffer-names, or matches same-window-regexps. */
export function sameWindowP(bufferName: string): boolean {
  const names = e8.variable("same-window-buffer-names");
  const regexps = e8.variable("same-window-regexps");
  const listOf = (v: e8.Value | undefined) => (Array.isArray(v) ? v : []);
  return (
    listOf(names).some((n) => (Array.isArray(n) ? n[0] : n) === bufferName) ||
    listOf(regexps).some((r) => {
      const re = Array.isArray(r) ? r[0] : r;
      return typeof re === "string" && e8.stringMatch(re, bufferName) !== undefined;
    })
  );
}

// The action functions, as window.el has them, each given the buffer and
// the alist, giving the window it used or nil.

type ActionFunction = (buffer: e8.Buffer, alist: Alist) => e8.Window | symbol | undefined;
const actions = new Map<string, ActionFunction>();

/** Defines an action function under Emacs's name, for display-buffer-alist and code to name. */
function defineAction(name: string, fn: ActionFunction): ActionFunction {
  actions.set(name, fn);
  e8.defun(name, (buffer: e8.Value, alist: e8.Value) => fn(e8.getBuffer(buffer as e8.BufferLike)!, Array.isArray(alist) ? alist : []) ?? null);
  return fn;
}

const sameWindow = defineAction("display-buffer-same-window", (buffer, alist) => {
  if (alistTrue(alist, "inhibit-same-window") || e8.selectedWindow() === e8.minibufferWindow() || dedicated(e8.selectedWindow())) return undefined;
  return windowDisplayBuffer(buffer, e8.selectedWindow(), "reuse", alist);
});

const maybeSameWindow = defineAction("display-buffer--maybe-same-window", (buffer, alist) =>
  sameWindowP(buffer.name ?? "") ? sameWindow(buffer, alist) : undefined,
);

const reuseWindow = defineAction("display-buffer-reuse-window", (buffer, alist) => {
  const frames = reusableFrames(alist);
  let window: e8.Window | undefined;
  if (e8.windowBuffer() === buffer.name && !alistTrue(alist, "inhibit-same-window")) {
    window = e8.selectedWindow();
  } else {
    const windows = getBufferWindowList(buffer, false, frames).filter((w) => w !== e8.selectedWindow());
    window = windows.find((w) => e8.windowFrame(w) === e8.selectedFrame()) ?? windows[0];
  }
  if (window === undefined || !e8.windowLiveP(window)) return undefined;
  const shown = windowDisplayBuffer(buffer, window, "reuse", alist);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(e8.windowFrame(window));
  return shown;
});

defineAction("display-buffer-reuse-mode-window", (buffer, alist) => {
  const frames = reusableFrames(alist);
  const inhibitSame = alistTrue(alist, "inhibit-same-window");
  const modeEntry = assq(alist, "mode");
  const bufferMode = symName(e8.withCurrentBuffer(buffer, () => e8.variable("major-mode")));
  const raw = modeEntry !== undefined ? alistGet(alist, "mode") : bufferMode;
  const allowed = (Array.isArray(raw) ? raw : [raw]).map(symName).filter((m): m is string => m !== undefined);
  const groups: e8.Window[][] = [[], [], [], []];
  for (const window of windowsOnFrames(frames)) {
    if (inhibitSame && window === e8.selectedWindow()) continue;
    const kind = e8.withCurrentBuffer(e8.windowBuffer(window)!, () => {
      const mode = symName(e8.variable("major-mode"));
      if (mode !== undefined && allowed.includes(mode)) return 0;
      return e8.derivedModeP(...allowed) ? 2 : -1;
    });
    if (kind < 0) continue;
    groups[kind + (e8.windowFrame(window) === e8.selectedFrame() ? 0 : 1)].push(window);
  }
  const window = groups.flat()[0];
  if (window === undefined) return undefined;
  const shown = windowDisplayBuffer(buffer, window, "reuse", alist);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(e8.windowFrame(window));
  return shown;
});

const popUpFrame = defineAction("display-buffer-pop-up-frame", (buffer, alist) => {
  const fn = e8.variable("pop-up-frame-function");
  const frame = isNil(fn) ? e8.withCurrentBuffer(buffer, () => e8.makeFrame(buffer)) : e8.withCurrentBuffer(buffer, () => fcall(fn));
  if (!e8.framep(frame)) return undefined;
  const window = e8.frameSelectedWindow(frame as e8.Frame);
  const shown = windowDisplayBuffer(buffer, window, "frame", alist);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(frame as e8.Frame);
  return shown;
});

const popUpWindow = defineAction("display-buffer-pop-up-window", (buffer, alist) => {
  const frame = e8.selectedFrame();
  if (!isNil(e8.frameParameter(frame, "unsplittable"))) return undefined;
  const window = tryToSplitWindow(getLargestWindow(frame, true)) ?? tryToSplitWindow(getLruWindow(frame, true));
  if (window === undefined) return undefined;
  const shown = windowDisplayBuffer(buffer, window, "window", alist);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(e8.windowFrame(window));
  return shown;
});

const maybePopUpFrame = defineAction("display-buffer--maybe-pop-up-frame", (buffer, alist) => (popUpFrames(alist) ? popUpFrame(buffer, alist) : undefined));
const maybePopUpWindow = defineAction("display-buffer--maybe-pop-up-window", (buffer, alist) =>
  isNil(e8.variable("pop-up-windows")) ? undefined : popUpWindow(buffer, alist),
);
defineAction("display-buffer--maybe-pop-up-frame-or-window", (buffer, alist) => maybePopUpFrame(buffer, alist) ?? maybePopUpWindow(buffer, alist));

defineAction("display-buffer-in-previous-window", (buffer, alist) => {
  const inhibitSame = alistTrue(alist, "inhibit-same-window");
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let second: e8.Window | undefined;
  for (const window of windowsOnFrames(reusableFrames(alist))) {
    if (dedicated(window) || !e8.windowPrevBuffers(window).some(([b]) => b === buffer.name)) continue;
    if (window === selected) {
      if (!inhibitSame) second = window;
    } else {
      best = window;
      break;
    }
  }
  let previous = alistGet(alist, "previous-window");
  if (typeof previous === "string" || typeof previous === "symbol") previous = e8.variable(symName(previous)!);
  if (e8.windowp(previous) && e8.windowLiveP(previous) && (e8.windowBuffer(previous) === buffer.name || !dedicated(previous as e8.Window))) {
    if (previous === selected) {
      if (!inhibitSame) second = previous as e8.Window;
    } else {
      best = previous as e8.Window;
    }
  }
  const window = best ?? second;
  return window === undefined ? undefined : windowDisplayBuffer(buffer, window, "reuse", alist);
});

/** The least recently used window display-buffer may take, as display-buffer--lru-window. */
function lruWindowFor(alist: Alist): e8.Window | undefined {
  const lruTime = alistGet(alist, "lru-time");
  const minW = alistGet(alist, "window-min-width");
  const minH = alistGet(alist, "window-min-height");
  const notThis = alistTrue(alist, "inhibit-same-window");
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let bestTime = Infinity;
  let second: e8.Window | undefined;
  let secondTime = Infinity;
  for (const window of windowsOnFrames(alistGet(alist, "lru-frames"))) {
    if (dedicated(window) || (notThis && window === selected) || !isNil(e8.windowParameter(window, "window-side"))) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (typeof lruTime === "number" && time > lruTime) continue;
    const s = size(window);
    const small =
      (typeof minW === "number" && s.width < minW) ||
      (symName(minW) === "full-width" && !s.fullWidth) ||
      (typeof minH === "number" && s.height < minH);
    if (window === selected || small) {
      if (time < secondTime) [second, secondTime] = [window, time];
    } else if (time < bestTime) {
      [best, bestTime] = [window, time];
    }
  }
  return best ?? second;
}

/** Takes back the height a window had before display-buffer reused it, as its quit-restore parameter says. */
function restoreHeight(window: e8.Window): void {
  const restore = quitRestore(window);
  const quad = restore?.[1];
  if (Array.isArray(quad) && typeof quad[3] === "number" && quad[3] > size(window).totalHeight) {
    e8.conditionCase(() => e8.resizeWindow(window, (quad[3] as number) - size(window).totalHeight, false), { error: () => 0 });
  }
}

const useSomeWindow = defineAction("display-buffer-use-some-window", (buffer, alist) => {
  const notThis = alistTrue(alist, "inhibit-same-window");
  const method = alistGet(alist, "some-window");
  const frame = e8.selectedFrame();
  const selected = e8.selectedWindow();
  const notSelected = (w: e8.Window | undefined) => (w !== undefined && !(notThis && w === selected) ? w : undefined);
  let window: e8.Window | undefined;
  if (isNil(method) || symName(method) === "lru") window = lruWindowFor([...alist, ["lru-frames", frame], ["window-min-width", "full-width"]]);
  else if (symName(method) === "mru") window = getMruWindow(undefined, false, true);
  else if (typeof method === "function" || typeof method === "string") {
    const got = fcall(method, buffer, alist);
    window = e8.windowp(got) ? (got as e8.Window) : undefined;
  }
  window ??=
    notSelected(getBufferWindowList(buffer, false, "visible")[0]) ??
    getLargestWindow("visible", false, notThis) ??
    notSelected(getBufferWindowList(buffer, false, 0)[0]) ??
    getLargestWindow(0, false, notThis);
  if (window === undefined || !e8.windowLiveP(window)) return undefined;
  restoreHeight(window);
  const shown = windowDisplayBuffer(buffer, window, "reuse", alist);
  evenWindowSizes(window);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(e8.windowFrame(window));
  return shown;
});

defineAction("display-buffer-use-least-recent-window", (buffer, alist) => {
  const a: Alist = [["inhibit-same-window", true], ...alist];
  let window = reuseWindow(buffer, a) as e8.Window | undefined;
  if (window === undefined) {
    const lru = lruWindowFor(a);
    if (lru !== undefined && e8.windowLiveP(lru)) {
      restoreHeight(lru);
      window = windowDisplayBuffer(buffer, lru, "reuse", a);
      evenWindowSizes(lru);
      if (!alistTrue(a, "inhibit-switch-frame")) maybeRaiseFrame(e8.windowFrame(lru));
    }
  }
  return window ?? (popUpWindow(buffer, a) as e8.Window | undefined);
});

defineAction("display-buffer-below-selected", (buffer, alist) => {
  const minH = alistGet(alist, "window-min-height");
  const tallEnough = (w: e8.Window) => typeof minH !== "number" || size(w).height >= minH;
  const below = windowInDirection("below");
  if (below !== undefined && e8.windowBuffer(below) === buffer.name && tallEnough(below)) return windowDisplayBuffer(buffer, below, "reuse", alist);
  if (isNil(e8.frameParameter(undefined, "unsplittable")) && (typeof minH !== "number" || size(e8.selectedWindow()).totalHeight - minH >= minHeight())) {
    const made = e8.letBind({ "split-height-threshold": 0, "split-width-threshold": null }, () => tryToSplitWindow(e8.selectedWindow()));
    if (made !== undefined) return windowDisplayBuffer(buffer, made, "window", alist);
  }
  if (below !== undefined && !dedicated(below) && tallEnough(below)) return windowDisplayBuffer(buffer, below, "reuse", alist);
  return undefined;
});

const atBottom = defineAction("display-buffer-at-bottom", (buffer, alist) => {
  let bottom: e8.Window | undefined;
  let showsBuffer = false;
  for (const window of e8.windowList1(e8.frameFirstWindow(), false, false)) {
    if (windowInDirection("below", window, true) !== undefined) continue;
    if (!showsBuffer && e8.windowBuffer(window) === buffer.name) {
      showsBuffer = true;
      bottom = window;
    } else if (bottom === undefined) {
      bottom = window;
    }
  }
  if (showsBuffer && bottom !== undefined) return windowDisplayBuffer(buffer, bottom, "reuse", alist);
  if (isNil(e8.frameParameter(undefined, "unsplittable"))) {
    const made = e8.conditionCase<e8.Window | undefined>(() => splitBelowMain(), { error: () => undefined });
    if (made !== undefined) return windowDisplayBuffer(buffer, made, "window", alist);
  }
  if (bottom !== undefined && !dedicated(bottom)) return windowDisplayBuffer(buffer, bottom, "reuse", alist);
  return undefined;
});

/** Splits the frame's main window at its bottom, as (split-window (window-main-window)): the whole frame's width when there are no side windows. */
function splitBelowMain(): e8.Window {
  const sides = e8.windowList().some((w) => !isNil(e8.windowParameter(w, "window-side")));
  return sides || e8.windowList().length === 1 ? e8.splitWindow(windowMainWindow(), "below") : e8.splitRootWindow("below");
}

defineAction("display-buffer--maybe-at-bottom", (buffer, alist) => {
  const a: Alist = [...alist, ["window-height", "fit-window-to-buffer"]];
  return maybeSameWindow(buffer, a) ?? reuseWindow(buffer, a) ?? maybePopUpFrame(buffer, a) ?? atBottom(buffer, a);
});

defineAction("display-buffer-in-direction", (buffer, alist) => {
  const direction0 = symName(alistGet(alist, "direction"));
  if (direction0 === undefined) return undefined;
  const whichWindow = alistGet(alist, "window");
  let window: e8.Window;
  if (symName(whichWindow) === "main" || ["top", "bottom", "leftmost", "rightmost"].includes(direction0)) window = windowMainWindow();
  else if (e8.windowp(whichWindow) && e8.windowLiveP(whichWindow)) window = whichWindow as e8.Window;
  else window = e8.selectedWindow();
  const direction =
    ["left", "above", "right", "below"].includes(direction0) ? direction0
    : direction0 === "leftmost" ? "left"
    : direction0 === "top" || direction0 === "up" ? "above"
    : direction0 === "rightmost" ? "right"
    : "below";
  const a: Alist = [...alist, ["window-height", "fit-window-to-buffer"]];
  let other: e8.Window | undefined;
  let otherShows = false;
  for (const w of windowsSharingEdge(window, direction)) {
    if (!otherShows && e8.windowBuffer(w) === buffer.name) {
      otherShows = true;
      other = w;
    } else if (other === undefined) {
      other = w;
    }
  }
  if (otherShows && other !== undefined) return windowDisplayBuffer(buffer, other, "reuse", a);
  // The whole frame's edge for a direction beyond the windows, as Emacs splits the main window.
  const made = e8.conditionCase<e8.Window | undefined>(
    () =>
      ["top", "bottom", "leftmost", "rightmost"].includes(direction0) && e8.windowList().length > 1
        ? e8.splitRootWindow(direction as "below" | "right" | "above" | "left")
        : e8.splitWindow(window, direction as "below" | "right" | "above" | "left"),
    { error: () => undefined },
  );
  if (made !== undefined && isNil(e8.frameParameter(undefined, "unsplittable"))) return windowDisplayBuffer(buffer, made, "window", a);
  if (other !== undefined && !dedicated(other) && other !== e8.minibufferWindow()) return windowDisplayBuffer(buffer, other, "reuse", a);
  return undefined;
});

defineAction("display-buffer-full-frame", (buffer, alist) => {
  const window = (reuseWindow(buffer, alist) ?? sameWindow(buffer, alist) ?? popUpWindow(buffer, alist) ?? useSomeWindow(buffer, alist)) as e8.Window | undefined;
  if (window === undefined) return undefined;
  for (const w of e8.windowList()) if (w !== window && w !== e8.minibufferWindow()) e8.deleteWindow(w);
  return window;
});

defineAction("display-buffer-use-some-frame", (buffer, alist) => {
  const predicate = alistGet(alist, "frame-predicate");
  const frame = e8
    .frameList()
    .find((f) => (isNil(predicate) ? f !== e8.selectedFrame() : !isNil(fcall(predicate, f))));
  const window = frame === undefined ? undefined : getLruWindow(frame, false, alistTrue(alist, "inhibit-same-window"));
  if (window === undefined) return undefined;
  const shown = windowDisplayBuffer(buffer, window, "reuse", alist);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(frame);
  return shown;
});

defineAction("display-buffer-no-window", (_buffer, alist) => (alistTrue(alist, "allow-no-window") ? Symbol.for("fail") : undefined));

// Side windows, as window.el makes them: windows along a side of the
// frame, each with window-side and window-slot parameters, dedicated to
// their buffers as `side`, which delete-other-windows leaves.

/** The side windows on a side, in slot order. */
function sideWindows(side: string): e8.Window[] {
  return e8
    .windowList()
    .filter((w) => symName(e8.windowParameter(w, "window-side")) === side)
    .sort((a, b) => Number(e8.windowParameter(a, "window-slot") ?? 0) - Number(e8.windowParameter(b, "window-slot") ?? 0));
}

/**
 * Shows a buffer in a window along a side of the frame, as
 * display-buffer-in-side-window: the alist's `side` (bottom by default)
 * and `slot` (0) say which. A window already in that slot is reused; a
 * side with no window gets one along the frame's whole edge; a new slot
 * splits the side's windows, slots in order along the side.
 */
const inSideWindow = defineAction("display-buffer-in-side-window", (buffer, alist0) => {
  const side = symName(alistGet(alist0, "side")) ?? "bottom";
  const slot = alistGet(alist0, "slot") ?? 0;
  if (!["top", "bottom", "left", "right"].includes(side)) e8.signal("error", `Invalid side ${side} specified`);
  if (typeof slot !== "number") e8.signal("error", `Invalid slot ${String(slot)} specified`);
  const leftOrRight = side === "left" || side === "right";
  const slots = e8.variable("window-sides-slots");
  const maxSlots = Array.isArray(slots) ? slots[["left", "top", "right", "bottom"].indexOf(side)] : null;
  if (typeof maxSlots === "number" && maxSlots <= 0) return undefined;
  const alist: Alist = assq(alist0, "dedicated") ? alist0 : [["dedicated", e8.variable("display-buffer-mark-dedicated") ?? "side"], ...alist0];
  const windows = sideWindows(side);
  const mark = (window: e8.Window) => {
    e8.setWindowParameter(window, "window-side", side);
    e8.setWindowParameter(window, "window-slot", slot);
  };
  if (windows.length === 0) {
    // A major side window, along the frame's whole edge.
    const total = leftOrRight ? e8.frameWidth() : e8.frameHeight();
    const sized = alistGet(alist, leftOrRight ? "window-width" : "window-height") !== undefined;
    const rootSide = side === "top" ? "above" : side === "bottom" ? "below" : side;
    const window = e8.conditionCase<e8.Window | undefined>(
      () => e8.splitRootWindow(rootSide as "below" | "right" | "above" | "left", sized ? undefined : -Math.max(2, Math.trunc(total / 4))),
      { error: () => undefined },
    );
    if (window === undefined) return undefined;
    mark(window);
    return windowDisplayBuffer(buffer, window, "window", alist);
  }
  const same = windows.find((w) => e8.windowParameter(w, "window-slot") === slot);
  if (same !== undefined) return windowDisplayBuffer(buffer, same, "reuse", alist);
  if (typeof maxSlots === "number" && windows.length >= maxSlots) {
    // No new slot: the window with the nearest slot shows it.
    const nearest = windows.reduce((a, b) =>
      Math.abs(Number(e8.windowParameter(a, "window-slot")) - slot) <= Math.abs(Number(e8.windowParameter(b, "window-slot")) - slot) ? a : b,
    );
    return windowDisplayBuffer(buffer, nearest, "reuse", alist);
  }
  // A new slot, before or after the side window with the nearest slot, along the side.
  const after = windows.filter((w) => Number(e8.windowParameter(w, "window-slot")) < slot).pop();
  const next = after ?? windows[0];
  const before = after === undefined;
  const along = leftOrRight ? (before ? "above" : "below") : before ? "left" : "right";
  const window = e8.conditionCase<e8.Window | undefined>(() => e8.splitWindow(next, along as "below" | "right" | "above" | "left"), { error: () => undefined });
  if (window === undefined) return windowDisplayBuffer(buffer, next, "reuse", alist);
  mark(window);
  return windowDisplayBuffer(buffer, window, "window", alist);
});
void inSideWindow;

/**
 * Whether a buffer matches a condition of display-buffer-alist's, as
 * buffer-match-p: a regexp its name matches, a function given the buffer
 * name and `args`, t, or [category, NAME] for display-buffer's action
 * naming that category, [major-mode, MODE], [derived-mode, MODE], [not,
 * ...], [or, ...] and [and, ...].
 */
export function bufferMatchP(condition: e8.Value, bufferOrName: e8.BufferLike, ...args: e8.Value[]): boolean {
  const buffer = e8.getBuffer(bufferOrName);
  const name = buffer?.name ?? (typeof bufferOrName === "string" ? bufferOrName : "");
  const one = (c: e8.Value): boolean => {
    if (c === true) return true;
    if (typeof c === "string") return e8.stringMatch(c, name) !== undefined;
    if (typeof c === "function") return !isNil(fcall(c, bufferOrName, ...args));
    if (!Array.isArray(c) || c.length === 0) return false;
    const [head, ...rest] = c;
    switch (symName(head)) {
      case "category": {
        const action = args[0];
        const alist = Array.isArray(action) ? action.slice(1) : [];
        return symName(alistGet(alist as Alist, "category")) === symName(rest[0]);
      }
      case "major-mode":
        return buffer !== undefined && symName(e8.withCurrentBuffer(buffer, () => e8.variable("major-mode"))) === symName(rest[0]);
      case "derived-mode":
        return buffer !== undefined && e8.withCurrentBuffer(buffer, () => e8.derivedModeP(...rest.map((m) => symName(m) ?? "")));
      case "not":
        return !any(rest);
      case "or":
        return any(rest);
      case "and":
        return rest.every((x) => any([x]));
      default:
        // A function given by name, as a symbol in Lisp.
        return typeof head === "symbol" || typeof head === "string" ? false : false;
    }
  };
  const any = (cs: e8.Value[]): boolean => cs.some(one);
  if (typeof condition === "symbol") return !isNil(fcall(condition.description ?? "", bufferOrName, ...args));
  return one(condition);
}

/**
 * Shows a buffer in some window, as window.el's display-buffer, and gives
 * the window, or undefined if none was used. The actions tried, in order:
 * display-buffer-overriding-action, the first entry of
 * display-buffer-alist whose condition the buffer matches, `action`,
 * display-buffer-base-action and display-buffer-fallback-action. An
 * `action` that is not a list, such as true, means another window than the
 * selected one, as the prefix argument of the command does; `frame` adds
 * [reusable-frames, FRAME].
 */
export function displayBuffer(bufferOrName: e8.BufferLike, action?: e8.Value, frame?: e8.Value): e8.Window | undefined {
  const buffer = typeof bufferOrName === "string" ? e8.getBuffer(bufferOrName) : bufferOrName;
  const name = typeof bufferOrName === "string" ? bufferOrName : bufferOrName.name ?? "";
  const inhibitSameWindow = !isNil(action) && !Array.isArray(action);
  const callerAction: e8.Value[] = Array.isArray(action) ? action : [null];
  const alistVar = e8.variable("display-buffer-alist");
  let userAction: e8.Value[] = [null];
  for (const entry of Array.isArray(alistVar) ? alistVar : []) {
    if (Array.isArray(entry) && entry.length > 0 && bufferMatchP(entry[0] ?? null, name, callerAction)) {
      userAction = entry.slice(1);
      break;
    }
  }
  const extra: e8.Value[] = [null, ...(inhibitSameWindow ? [["inhibit-same-window", true]] : []), ...(isNil(frame) ? [] : [["reusable-frames", frame ?? null]])];
  const asAction = (v: e8.Value | undefined): e8.Value[] => (Array.isArray(v) && v.length > 0 ? v : [null]);
  const all = [
    asAction(e8.variable("display-buffer-overriding-action")),
    asAction(userAction),
    asAction(callerAction),
    extra,
    asAction(e8.variable("display-buffer-base-action")),
    asAction(e8.variable("display-buffer-fallback-action")),
  ];
  const functions = all.flatMap((a) => (isNil(a[0]) ? [] : Array.isArray(a[0]) ? a[0] : [a[0]]));
  const alist: Alist = all.flatMap((a) => a.slice(1));
  if (buffer === undefined || !e8.bufferLiveP(buffer)) e8.signal("error", "Invalid buffer");
  let window: unknown;
  for (const fn of functions) {
    const own = typeof fn === "string" || typeof fn === "symbol" ? actions.get(symName(fn) ?? "") : undefined;
    window = own ? own(buffer, alist) : fcall(fn, buffer, alist);
    if (!isNil(window)) break;
  }
  const select = assq(alist, "post-command-select-window");
  if (select !== undefined && e8.windowp(window)) {
    const oldSelected = e8.selectedWindow();
    const shown = window as e8.Window;
    const postfun = () => {
      if (!isNil(select[1])) {
        if (e8.windowLiveP(shown)) e8.selectWindow(shown);
      } else if (e8.windowLiveP(oldSelected)) {
        e8.selectWindow(oldSelected);
      }
      e8.removeHook("post-command-hook", postfun);
    };
    e8.addHook("post-command-hook", postfun);
  }
  return e8.windowp(window) ? (window as e8.Window) : undefined;
}

/**
 * Shows a buffer in some window, as display-buffer, and selects that
 * window and its frame, as pop-to-buffer; a buffer with no window used
 * becomes current. `norecord` leaves the buffer list as it is.
 */
export function popToBuffer(bufferOrName: e8.BufferLike, action?: e8.Value, norecord = false): e8.Buffer {
  const buffer = e8.getBufferCreate(bufferOrName === "" ? (e8.windowBuffer() ?? "*scratch*") : bufferOrName);
  const oldFrame = e8.selectedFrame();
  const window = displayBuffer(buffer, action);
  if (window !== undefined) {
    const frame = e8.windowFrame(window);
    if (frame !== undefined && frame !== oldFrame) e8.selectFrame(frame);
    e8.selectWindow(window, norecord);
  }
  return buffer;
}

/** The action to show a buffer in the selected window, as display-buffer--same-window-action. */
export const sameWindowAction: e8.Value[] = ["display-buffer-same-window", ["inhibit-same-window", null]];
/** The action to show a buffer in another frame, as display-buffer--other-frame-action. */
export const otherFrameAction: e8.Value[] = [["display-buffer-reuse-window", "display-buffer-pop-up-frame"], ["reusable-frames", 0], ["inhibit-same-window", true]];

/** Shows a buffer in the selected window and selects it, as pop-to-buffer-same-window. */
export const popToBufferSameWindow = (buffer: e8.BufferLike, norecord = false): e8.Buffer => popToBuffer(buffer, sameWindowAction, norecord);

/** The action a prefix argument asks for: another window than the selected one, as display-buffer's interactive form. */
const prefixAction = (prefix: e8.PrefixArg): e8.Value | undefined => (prefix === null || prefix === undefined ? undefined : true);

const displayBufferCommand = e8.defineCommand({
  name: "display-buffer",
  doc:
    "Show a buffer in some window without selecting it, as display-buffer-alist and the other actions say.\n\n" +
    "With a prefix argument, another window than the selected one. By default a window that already shows it is used, " +
    "else a new window split off a large enough one, else the least recently used window.",
  params: [
    { name: "buffer", kind: "buffer", prompt: "Display buffer: " },
    { name: "action", kind: "prefix" },
  ],
  run: (buffer, action) => {
    displayBuffer(buffer, prefixAction(action));
  },
});

e8.defineCommand({
  name: "pop-to-buffer",
  doc: "Show a buffer in some window, as display-buffer does, and select that window. With a prefix argument, another window than the selected one.",
  params: [
    { name: "buffer", kind: "buffer", prompt: "Pop to buffer: " },
    { name: "action", kind: "prefix" },
  ],
  run: (buffer, action) => {
    popToBuffer(buffer, prefixAction(action));
  },
});

e8.defineCommand({
  name: "pop-to-buffer-same-window",
  doc: "Show a buffer in the selected window, unless display-buffer-alist says otherwise, and select its window.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Pop to buffer: " }],
  run: (buffer) => {
    popToBufferSameWindow(buffer);
  },
});

const switchToBufferOtherWindow = e8.defineCommand({
  name: "switch-to-buffer-other-window",
  doc: "Show a buffer in another window and select it, creating the buffer if there is none.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other window: " }],
  run: (buffer) => {
    popToBuffer(buffer, true);
  },
});

const findFileOtherWindow = e8.defineCommand({
  name: "find-file-other-window",
  doc: "Visit a file in another window and select it.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other window: " }],
  run: (file) => {
    if (e8.fileDirectoryP(file)) e8.call("dired-other-window", file);
    else popToBuffer(e8.findFileNoselect(file), true);
  },
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
    const needed = Math.max(minHeight(), e8.lineCount() + 1);
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
  doc: "Show a buffer in another frame and select it, creating the buffer if there is none: a frame showing it already, else a new one.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Switch to buffer in other frame: " }],
  run: (buffer) => {
    popToBuffer(buffer, otherFrameAction);
  },
});

const findFileOtherFrame = e8.defineCommand({
  name: "find-file-other-frame",
  doc: "Visit a file in another frame and select it.",
  params: [{ name: "file", kind: "file", prompt: "Find file in other frame: " }],
  run: (file) => {
    popToBuffer(e8.findFileNoselect(file), otherFrameAction);
  },
});

const displayBufferOtherFrame = e8.defineCommand({
  name: "display-buffer-other-frame",
  doc: "Show a buffer in another frame, leaving the selected frame selected.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Display buffer in other frame: " }],
  run: (buffer) => {
    displayBuffer(e8.getBufferCreate(buffer), otherFrameAction);
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
