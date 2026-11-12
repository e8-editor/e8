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
//
// E8's windows have no internal windows yet (ADR 0069, stage 3). Where
// window.el takes an internal window, such as the frame's main window
// beside its side windows, this takes the live windows it holds, a part,
// and splits the smallest part of the tree that holds them.

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

/**
 * The windows on the frames an ALL-FRAMES value says, in window-list-1's
 * order from `start` (the selected window by default): t every frame,
 * `visible` and 0 those shown, iconified ones too for 0, a frame that
 * one, and anything else the selected frame.
 */
function windowsOnFrames(frames: e8.Value | undefined, start?: e8.Window, minibuffer = false): e8.Window[] {
  const all = e8.windowList1(start, minibuffer, true);
  if (frames === true) return all;
  if (e8.framep(frames)) return all.filter((w) => e8.windowFrame(w) === frames);
  if (symName(frames) === "visible" || frames === 0) {
    return all.filter((w) => {
      const visible = e8.frameVisibleP(e8.windowFrame(w));
      return visible === true || (frames === 0 && visible === "icon");
    });
  }
  return all.filter((w) => e8.windowFrame(w) === e8.selectedFrame());
}

/** The windows showing a buffer, the selected one first, as get-buffer-window-list. */
export function getBufferWindowList(buffer: e8.BufferLike, minibuffer = false, allFrames?: e8.Value): e8.Window[] {
  const name = e8.bufferName(buffer);
  return windowsOnFrames(allFrames, undefined, minibuffer).filter((w) => e8.windowBuffer(w) === name);
}

/** Whether a window is dedicated to its buffer, which display-buffer does not take for another. */
const dedicated = (window: e8.Window): boolean => !isNil(e8.windowDedicatedP(window));
/** Whether a window is a side window, as its window-side parameter says. */
const isSide = (window: e8.Window): boolean => !isNil(e8.windowParameter(window, "window-side"));

function size(window: e8.Window) {
  return e8.windowSize(window) ?? { width: 0, height: 0, totalWidth: 0, totalHeight: 0, fullWidth: true };
}

/**
 * The least recently used window, as get-lru-window: on the frames
 * `allFrames` says, one that spans its frame's width if there is any; the
 * selected window only last, and not at all with `notSelected`; a
 * dedicated one only with `dedicatedOk`; one with a no-other-window
 * parameter not with `noOther`.
 */
export function getLruWindow(allFrames?: e8.Value, dedicatedOk = false, notSelected = false, noOther = false): e8.Window | undefined {
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let bestTime = Infinity;
  let second: e8.Window | undefined;
  let secondTime = Infinity;
  for (const window of windowsOnFrames(allFrames)) {
    if ((notSelected && window === selected) || (!dedicatedOk && dedicated(window))) continue;
    if (noOther && !isNil(e8.windowParameter(window, "no-other-window"))) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (window === selected || !size(window).fullWidth) {
      if (time < secondTime) [second, secondTime] = [window, time];
    } else if (time < bestTime) {
      [best, bestTime] = [window, time];
    }
  }
  return best ?? second;
}

/** The most recently used window, as get-mru-window, with get-lru-window's conditions. */
export function getMruWindow(allFrames?: e8.Value, dedicatedOk = false, notSelected = false, noOther = false): e8.Window | undefined {
  const selected = e8.selectedWindow();
  let best: e8.Window | undefined;
  let bestTime = -Infinity;
  for (const window of windowsOnFrames(allFrames)) {
    if ((notSelected && window === selected) || (!dedicatedOk && dedicated(window))) continue;
    if (noOther && !isNil(e8.windowParameter(window, "no-other-window"))) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (time > bestTime) [best, bestTime] = [window, time];
  }
  return best;
}

/** The largest window by area, as get-largest-window, with get-lru-window's conditions. */
export function getLargestWindow(allFrames?: e8.Value, dedicatedOk = false, notSelected = false, noOther = false): e8.Window | undefined {
  let best: e8.Window | undefined;
  let bestArea = -1;
  for (const window of windowsOnFrames(allFrames)) {
    if ((notSelected && window === e8.selectedWindow()) || (!dedicatedOk && dedicated(window))) continue;
    if (noOther && !isNil(e8.windowParameter(window, "no-other-window"))) continue;
    const s = size(window);
    const area = s.totalWidth * s.totalHeight;
    if (area > bestArea) [best, bestArea] = [window, area];
  }
  return best;
}

/** Whether a window is `ancestor` or inside it. */
function within(window: e8.Window, ancestor: e8.Window): boolean {
  for (let w: e8.Window | undefined = window; w !== undefined; w = e8.windowParent(w)) if (w === ancestor) return true;
  return false;
}

/** The live windows a window holds: itself if it is live, else its children's. */
function liveWindowsIn(window: e8.Window): e8.Window[] {
  return e8.windowList().filter((w) => within(w, window));
}

/** How many children an internal window has, as window-child-count. */
function windowChildCount(window: e8.Window): number {
  let n = 0;
  for (let c = e8.windowTopChild(window) ?? e8.windowLeftChild(window); c !== undefined; c = e8.windowNextSibling(c)) n++;
  return n;
}

/** Calls `fn` on a frame's live windows, or with `any` its internal ones too, parents before children, as walk-window-tree. */
export function walkWindowTree(fn: (window: e8.Window) => void, frame?: e8.Frame, any = false): void {
  const walk = (w: e8.Window): void => {
    const first = e8.windowTopChild(w) ?? e8.windowLeftChild(w);
    if (first === undefined || any) fn(w);
    for (let c = first; c !== undefined; c = e8.windowNextSibling(c)) walk(c);
  };
  walk(e8.frameRootWindow(frame));
}

/**
 * Sets every window's new sizes to its own and clears its new normal
 * size, as window--resize-reset, before window.el works out new sizes and
 * window-resize-apply gives them.
 */
export function windowResizeReset(frame?: e8.Frame, horizontal = false): void {
  for (const w of [...newNormals.keys()]) if (!e8.windowValidP(w)) newNormals.delete(w);
  walkWindowTree((w) => {
    e8.setWindowNewPixel(w, horizontal ? e8.windowPixelWidth(w) : e8.windowPixelHeight(w));
    e8.setWindowNewTotal(w, horizontal ? e8.windowTotalWidth(w) : e8.windowTotalHeight(w));
    setWindowNewNormal(w);
  }, frame, true);
}
e8.defun("window--resize-reset", (frame?: e8.Frame, horizontal?: boolean) => {
  windowResizeReset(frame ?? undefined, horizontal === true);
  return null;
});

/** Whether a window is part of a combination one above another, or side by side with `horizontal`, as window-combined-p. */
export function windowCombinedP(window: e8.Window, horizontal = false): boolean {
  const parent = e8.windowParent(window);
  return parent !== undefined && (horizontal ? e8.windowLeftChild(parent) : e8.windowTopChild(parent)) !== undefined;
}

/** The edges of the part of the frame a set of windows covers, as window-edges gives an internal window's. */
function partEdges(windows: e8.Window[]): [number, number, number, number] {
  const all = windows.map((w) => e8.windowEdges(w));
  return [Math.min(...all.map((e) => e[0])), Math.min(...all.map((e) => e[1])), Math.max(...all.map((e) => e[2])), Math.max(...all.map((e) => e[3]))];
}

/** Splits a part of the frame: a live window as split-window does, several as their internal window would be. */
function splitPart(part: e8.Window[], side: "below" | "right" | "above" | "left", size?: number): e8.Window {
  return part.length === 1 ? e8.splitWindow(part[0], side, size) : e8.splitWindowsEnclosing(part, side, size);
}

/** Splits a part as split-window-no-error does: undefined where it cannot be. */
const splitPartNoError = (part: e8.Window[], side: "below" | "right" | "above" | "left", size?: number): e8.Window | undefined =>
  e8.conditionCase<e8.Window | undefined>(() => splitPart(part, side, size), { error: () => undefined });

/**
 * The window next to one in a direction, as window-in-direction: above,
 * below, left or right of it, the nearest along the line or column its
 * point is on, else the nearest one that direction; none at the frame's
 * edge. The minibuffer's window, and windows with a no-other-window
 * parameter unless `ignore`, are not taken.
 */
export function windowInDirection(direction: string, window: e8.Window = e8.selectedWindow(), ignore = false): e8.Window | undefined {
  const dir = direction === "up" ? "above" : direction === "down" ? "below" : direction;
  if (!["above", "below", "left", "right"].includes(dir)) e8.signal("error", `Wrong direction ${direction}`);
  const [l, t, r, b] = e8.windowEdges(window);
  const hor = dir === "left" || dir === "right";
  // Along the row or column point is on, as Emacs's posn-at-point gives it.
  const posn = e8.posnAtPoint(e8.windowPoint(window), window);
  const along = hor ? t + (posn?.row ?? 0) : l + (posn?.col ?? 0);
  let best: e8.Window | undefined;
  let bestDistance = Infinity;
  let second: e8.Window | undefined;
  let secondDistance: [number, number] = [Infinity, Infinity];
  for (const w of e8.windowList1(e8.frameFirstWindow(e8.windowFrame(window)), false, false)) {
    if (w === window || (!ignore && !isNil(e8.windowParameter(w, "no-other-window")))) continue;
    const [wl, wt, wr, wb] = e8.windowEdges(w);
    const distance =
      dir === "left" ? l - wr : dir === "right" ? wl - r : dir === "above" ? t - wb : wt - b;
    // Only windows beyond the edge, and that overlap the window along it.
    const overlaps = hor ? wt < b && wb > t : wl < r && wr > l;
    if (distance < 0 || !overlaps) continue;
    const covers = hor ? wt <= along && along < wb : wl <= along && along < wr;
    if (covers) {
      if (distance < bestDistance) [best, bestDistance] = [w, distance];
    } else {
      const off = hor ? Math.min(Math.abs(wt - along), Math.abs(wb - 1 - along)) : Math.min(Math.abs(wl - along), Math.abs(wr - 1 - along));
      if (distance < secondDistance[0] || (distance === secondDistance[0] && off < secondDistance[1])) [second, secondDistance] = [w, [distance, off]];
    }
  }
  return best ?? second;
}

/** The windows along an edge of a part of the frame, in a direction, as windows-sharing-edge: those whose opposite edge touches it. */
function windowsSharingEdge(part: e8.Window[], direction: string): e8.Window[] {
  const [l, t, r, b] = partEdges(part);
  return e8.windowList1(e8.frameFirstWindow(), false, false).filter((w) => {
    if (part.includes(w)) return false;
    const [wl, wt, wr, wb] = e8.windowEdges(w);
    if (direction === "left") return wr === l && wt < b && wb > t;
    if (direction === "right") return wl === r && wt < b && wb > t;
    if (direction === "above") return wb === t && wl < r && wr > l;
    return wt === b && wl < r && wr > l;
  });
}

/** The live windows that make up the frame's main window, as window-main-window: all but its side windows and the minibuffer's. */
function mainWindows(): e8.Window[] {
  return e8.windowList().filter((w) => w !== e8.minibufferWindow() && !isSide(w));
}

/**
 * The frame's main window, as window-main-window: its only window not a
 * side window. E8 has no internal windows yet (ADR 0069, stage 3): with
 * several such windows, the selected one stands for them.
 */
export function windowMainWindow(): e8.Window {
  const others = mainWindows();
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
  name: "window-combination-limit",
  doc: "If t, splitting a window makes a new internal window holding it and the new one, rather than a sibling in its parent.",
  value: null,
});
e8.defineVariable({
  name: "window-combination-resize",
  doc: "How splitting and deleting windows resize the others; `side' lets display-buffer split side windows for their slots.",
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

/** The fewest lines and columns a window may have, as window-min-height and window-min-width, and window-safe-min-height and -width below them. */
const minHeight = (): number => {
  const v = e8.variable("window-min-height");
  return typeof v === "number" ? Math.max(v, 1) : 4;
};
const minWidth = (): number => {
  const v = e8.variable("window-min-width");
  return typeof v === "number" ? Math.max(v, 2) : 10;
};

/** Whether a window is big enough to split, as window-splittable-p: never a side window, and a threshold of nil never is. */
export function windowSplittableP(window: e8.Window, horizontal = false): boolean {
  if (!e8.windowLiveP(window) || isSide(window)) return false;
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
  const split = (side: "below" | "right") => splitPartNoError([window], side);
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
  return e8.windowp(made) && e8.windowLiveP(made) ? made : undefined;
}

/**
 * Evens a window and the selected one, as window--even-window-sizes, when
 * they are the two windows of one split: the selected one gives the other
 * half of what it has more.
 */
function evenWindowSizes(window: e8.Window): void {
  const how = e8.variable("even-window-sizes");
  const selected = e8.selectedWindow();
  if (isNil(how) || window === selected) return;
  const parent = e8.windowParent(window);
  if (parent === undefined || e8.windowParent(selected) !== parent || windowChildCount(parent) !== 2) return;
  const sideBySide = e8.windowLeftChild(parent) !== undefined;
  const [s, w] = [size(selected), size(window)];
  if (sideBySide && symName(how) !== "height-only" && s.totalWidth > w.totalWidth) {
    e8.conditionCase(() => e8.resizeWindow(window, Math.trunc((s.totalWidth - w.totalWidth) / 2), true), { error: () => 0 });
  } else if (!sideBySide && symName(how) !== "width-only" && s.totalHeight > w.totalHeight) {
    e8.conditionCase(() => e8.resizeWindow(window, Math.trunc((s.totalHeight - w.totalHeight) / 2), false), { error: () => 0 });
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
 * its window-height and window-width, sets its window-parameters, and
 * with bump-use-time makes it the most recently used after the selected one.
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
  if (alistTrue(alist, "bump-use-time")) e8.windowBumpUseTime(window);
  const body = alistGet(alist, "body-function");
  if (typeof body === "function" || (typeof body === "string" && body !== "") || typeof body === "symbol") {
    e8.letBind({ "inhibit-read-only": true, "inhibit-modification-hooks": true }, () => fcall(body, window));
  }
  const restore = quitRestore(window);
  const made = type === "window" || (restore?.[0] === "same" && restore?.[1] === "window");
  if (made) {
    applySize(window, alistGet(alist, "window-height"), false);
    applySize(window, alistGet(alist, "window-width"), true);
    // (WIDTH . HEIGHT): whether to keep each, as window-preserve-size.
    const preserve = alistGet(alist, "preserve-size");
    if (Array.isArray(preserve)) {
      windowPreserveSize(window, true, preserve[0] ?? null);
      windowPreserveSize(window, false, preserve[1] ?? null);
    }
  }
  const parameters = alistGet(alist, "window-parameters");
  const pairs = Array.isArray(parameters) && parameters.every(Array.isArray) ? parameters : (assq(alist, "window-parameters")?.slice(1) ?? []);
  for (const p of pairs) {
    if (Array.isArray(p) && p.length >= 1) e8.setWindowParameter(window, symName(p[0]) ?? String(p[0]), p.length === 2 ? (p[1] ?? null) : p.slice(1));
  }
  return window;
}

/** Sizes a window display-buffer made, as window--display-buffer does with window-height or window-width: lines or columns, a fraction of the frame, [body-lines, N], or a function given the window. */
function applySize(window: e8.Window, value: e8.Value | undefined, horizontal: boolean): void {
  if (isNil(value)) return;
  if (typeof value === "function" || typeof value === "string" || typeof value === "symbol") {
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
// the alist, giving the window it used or nil. Each is a function under
// Emacs's name, and display-buffer and the actions that use others call
// them by name, so advice and redefinitions take, as in Emacs.

type ActionResult = e8.Window | symbol | undefined;
type ActionFunction = (buffer: e8.Buffer, alist: Alist) => ActionResult;

/** What an action function gave: its window, the symbol fail, or undefined. */
function actionResult(got: unknown): ActionResult {
  if (e8.windowp(got)) return got;
  return typeof got === "symbol" && got.description === "fail" ? got : undefined;
}

/** Defines an action function under Emacs's name, and gives a function calling it by that name. */
function defineAction(name: string, fn: ActionFunction): ActionFunction {
  e8.defun(name, (buffer: e8.Value, alist: e8.Value) => fn(e8.getBuffer(buffer as e8.BufferLike)!, Array.isArray(alist) ? alist : []) ?? null);
  return (buffer, alist) => actionResult(fcall(name, buffer, alist));
}

/** The window an action gave, if it gave one. */
const windowOf = (r: ActionResult): e8.Window | undefined => (e8.windowp(r) ? r : undefined);

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
  // As window.el pushes each window onto its group, the last of a group comes first.
  const groups: e8.Window[][] = [[], [], [], []];
  for (const window of windowsOnFrames(frames)) {
    if (inhibitSame && window === e8.selectedWindow()) continue;
    const kind = e8.withCurrentBuffer(e8.windowBuffer(window)!, () => {
      const mode = symName(e8.variable("major-mode"));
      if (mode !== undefined && allowed.includes(mode)) return 0;
      return e8.derivedModeP(...allowed) ? 2 : -1;
    });
    if (kind < 0) continue;
    groups[kind + (e8.windowFrame(window) === e8.selectedFrame() ? 0 : 1)].unshift(window);
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
  for (const window of windowsOnFrames(reusableFrames(alist), e8.frameFirstWindow())) {
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
  if (e8.windowp(previous) && e8.windowLiveP(previous) && (e8.windowBuffer(previous) === buffer.name || !dedicated(previous))) {
    if (previous === selected) {
      if (!inhibitSame) second = previous;
    } else {
      best = previous;
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
    if (dedicated(window) || (notThis && window === selected) || isSide(window)) continue;
    const time = e8.windowUseTime(window) ?? 0;
    if (typeof lruTime === "number" && time > lruTime) continue;
    const s = size(window);
    const [, top, , bottom] = e8.windowEdges(window);
    const small =
      (typeof minW === "number" && s.totalWidth < minW) ||
      (symName(minW) === "full-width" && !s.fullWidth) ||
      (typeof minH === "number" && s.totalHeight < minH) ||
      (symName(minH) === "full-height" && !(top === 0 && bottom === partEdges(e8.windowList().filter((w) => w !== e8.minibufferWindow()))[3]));
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
  else if (typeof method === "function" || typeof method === "string" || typeof method === "symbol") {
    const got = fcall(method, buffer, alist);
    window = e8.windowp(got) ? got : undefined;
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
  let window = windowOf(reuseWindow(buffer, a));
  if (window === undefined) {
    const lru = lruWindowFor(a);
    if (lru !== undefined && e8.windowLiveP(lru)) {
      restoreHeight(lru);
      window = windowDisplayBuffer(buffer, lru, "reuse", a);
      evenWindowSizes(lru);
      if (!alistTrue(a, "inhibit-switch-frame")) maybeRaiseFrame(e8.windowFrame(lru));
    }
  }
  window ??= windowOf(popUpWindow(buffer, a));
  // So the next call takes another window, as Emacs bumps the one it used.
  if (window !== undefined) e8.windowBumpUseTime(window);
  return window;
});

defineAction("display-buffer-below-selected", (buffer, alist) => {
  const minH = alistGet(alist, "window-min-height");
  const tallEnough = (w: e8.Window) => typeof minH !== "number" || size(w).totalHeight >= minH;
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
    if (windowInDirection("below", window) !== undefined) continue;
    if (!showsBuffer && e8.windowBuffer(window) === buffer.name) {
      showsBuffer = true;
      bottom = window;
    } else if (bottom === undefined) {
      bottom = window;
    }
  }
  if (showsBuffer && bottom !== undefined) return windowDisplayBuffer(buffer, bottom, "reuse", alist);
  if (isNil(e8.frameParameter(undefined, "unsplittable"))) {
    const made = splitPartNoError(mainWindows(), "below");
    if (made !== undefined) return windowDisplayBuffer(buffer, made, "window", alist);
  }
  if (bottom !== undefined && !dedicated(bottom)) return windowDisplayBuffer(buffer, bottom, "reuse", alist);
  return undefined;
});

defineAction("display-buffer--maybe-at-bottom", (buffer, alist) => {
  const a: Alist = [...alist, ["window-height", "fit-window-to-buffer"]];
  return maybeSameWindow(buffer, a) ?? reuseWindow(buffer, a) ?? maybePopUpFrame(buffer, a) ?? atBottom(buffer, a);
});

defineAction("display-buffer-in-direction", (buffer, alist) => {
  const direction0 = symName(alistGet(alist, "direction"));
  if (direction0 === undefined) return undefined;
  const whichWindow = alistGet(alist, "window");
  let part: e8.Window[];
  if (symName(whichWindow) === "main" || ["top", "bottom", "leftmost", "rightmost"].includes(direction0)) part = mainWindows();
  else if (symName(whichWindow) === "root") part = e8.windowList().filter((w) => w !== e8.minibufferWindow());
  else if (e8.windowp(whichWindow) && e8.windowLiveP(whichWindow)) part = [whichWindow];
  else part = [e8.selectedWindow()];
  const direction: "below" | "right" | "above" | "left" =
    direction0 === "left" || direction0 === "leftmost" ? "left"
    : direction0 === "above" || direction0 === "top" || direction0 === "up" ? "above"
    : direction0 === "right" || direction0 === "rightmost" ? "right"
    : "below";
  const a: Alist = [...alist, ["window-height", "fit-window-to-buffer"]];
  let other: e8.Window | undefined;
  let otherShows = false;
  for (const w of windowsSharingEdge(part, direction)) {
    if (!otherShows && e8.windowBuffer(w) === buffer.name) {
      otherShows = true;
      other = w;
    } else if (other === undefined) {
      other = w;
    }
  }
  if (otherShows && other !== undefined) return windowDisplayBuffer(buffer, other, "reuse", a);
  if (isNil(e8.frameParameter(undefined, "unsplittable"))) {
    const made = splitPartNoError(part, direction);
    if (made !== undefined) return windowDisplayBuffer(buffer, made, "window", a);
  }
  if (other !== undefined && !dedicated(other) && other !== e8.minibufferWindow()) return windowDisplayBuffer(buffer, other, "reuse", a);
  return undefined;
});

defineAction("display-buffer-full-frame", (buffer, alist) => {
  const window = windowOf(reuseWindow(buffer, alist) ?? sameWindow(buffer, alist) ?? popUpWindow(buffer, alist) ?? useSomeWindow(buffer, alist));
  if (window === undefined) return undefined;
  for (const w of e8.windowList()) if (w !== window && w !== e8.minibufferWindow()) e8.deleteWindow(w);
  return window;
});

defineAction("display-buffer-use-some-frame", (buffer, alist) => {
  const predicate = alistGet(alist, "frame-predicate");
  const notThis = alistTrue(alist, "inhibit-same-window");
  const frame = e8
    .frameList()
    .find((f) => (isNil(predicate) ? f !== e8.selectedFrame() && getLruWindow(f) !== undefined : !isNil(fcall(predicate, f))));
  const window = frame === undefined ? undefined : getLruWindow(frame, false, notThis);
  if (window === undefined) return undefined;
  const shown = windowDisplayBuffer(buffer, window, "reuse", alist);
  if (!alistTrue(alist, "inhibit-switch-frame")) maybeRaiseFrame(frame);
  return shown;
});

defineAction("display-buffer-no-window", (_buffer, alist) => (alistTrue(alist, "allow-no-window") ? Symbol.for("fail") : undefined));

// Side windows, as window.el makes them: windows along a side of the
// frame, each with window-side and window-slot parameters, dedicated to
// their buffers as `side`.

const SIDES = ["left", "top", "right", "bottom"] as const;

/** The side windows on a side, in the frame's order, which is their order along it. */
function sideWindows(side: string): e8.Window[] {
  return e8.windowList1(e8.frameFirstWindow(), false, false).filter((w) => symName(e8.windowParameter(w, "window-side")) === side);
}

/** The windows of the part of the frame next to the side or sides `side` is split off, as window--make-major-side-window-next-to. */
function sideNextTo(side: string): e8.Window[] {
  const all = e8.windowList().filter((w) => w !== e8.minibufferWindow());
  const vertical = !isNil(e8.variable("window-sides-vertical"));
  /** The window beside the major side window on `other`, toward the frame's middle, as window--make-major-side-window-next-to takes its sibling: its live windows. */
  const besides = (other: string): e8.Window[] | undefined => {
    const windows = sideWindows(other);
    if (windows.length === 0) return undefined;
    const major = windows.length === 1 ? windows[0] : e8.windowParent(windows[0]);
    if (major === undefined) return undefined;
    const sibling = other === "left" || other === "top" ? e8.windowNextSibling(major) : e8.windowPrevSibling(major);
    return sibling === undefined ? undefined : liveWindowsIn(sibling);
  };
  const opposite = { left: "right", right: "left", top: "bottom", bottom: "top" }[side]!;
  const across = side === "left" || side === "right" ? ["top", "bottom"] : ["left", "right"];
  const leftOrRight = side === "left" || side === "right";
  return (
    besides(opposite) ??
    // Left and right windows go beside top and bottom ones unless window-sides-vertical, top and bottom ones beside left and right ones only with it.
    (leftOrRight !== vertical ? (besides(across[0]) ?? besides(across[1])) : undefined) ??
    all
  );
}

/**
 * Shows a buffer in a window along a side of the frame, as
 * display-buffer-in-side-window: the alist's `side` (bottom by default)
 * and `slot` (0) say which. A window already in that slot is reused; a
 * side with no window gets one along the frame's edge, a quarter of the
 * frame; a new slot goes before the side's window with the next higher
 * slot, or after the one with the next lower, sharing the side evenly;
 * when the side has all the slots window-sides-slots allows, the window
 * with the nearest slot is reused and takes the slot.
 */
defineAction("display-buffer-in-side-window", (buffer, alist0) => {
  const side = symName(alistGet(alist0, "side")) ?? "bottom";
  const slot = alistGet(alist0, "slot") ?? 0;
  if (!(SIDES as readonly string[]).includes(side)) e8.signal("error", `Invalid side ${side} specified`);
  if (typeof slot !== "number") e8.signal("error", `Invalid slot ${String(slot)} specified`);
  const leftOrRight = side === "left" || side === "right";
  const slots = e8.variable("window-sides-slots");
  const maxSlots = Array.isArray(slots) ? slots[(SIDES as readonly string[]).indexOf(side)] : null;
  if (typeof maxSlots === "number" && maxSlots <= 0) return undefined;
  const alist: Alist = assq(alist0, "dedicated") ? alist0 : [["dedicated", e8.variable("display-buffer-mark-dedicated") ?? "side"], ...alist0];
  const windows = sideWindows(side);
  const along = (before: boolean) => (leftOrRight ? (before ? "above" : "below") : before ? "left" : "right");
  if (windows.length === 0) {
    // A major side window, beside the main window, a quarter of the frame by default.
    const total = leftOrRight ? e8.frameWidth() : e8.frameHeight();
    const sized = !isNil(alistGet(alist, leftOrRight ? "window-width" : "window-height"));
    const rootSide = side === "top" ? "above" : side === "bottom" ? "below" : (side as "left" | "right");
    const window = splitPartNoError(sideNextTo(side), rootSide, sized ? undefined : -Math.max(2, Math.trunc(total / 4)));
    if (window === undefined) return undefined;
    e8.setWindowParameter(window, "window-side", side);
    e8.setWindowParameter(window, "window-slot", slot);
    return windowDisplayBuffer(buffer, window, "window", alist);
  }
  let thisWindow: e8.Window | undefined;
  let prevWindow: e8.Window | undefined;
  let nextWindow: e8.Window | undefined;
  let bestWindow: e8.Window | undefined;
  let bestSlot: number | undefined;
  for (const window of windows) {
    const thisSlot = e8.windowParameter(window, "window-slot");
    if (typeof thisSlot !== "number") continue;
    if (thisSlot === slot) {
      thisWindow = window;
      break;
    }
    const absSlot = (thisSlot > 0 && slot > 0) || (thisSlot < 0 && slot < 0) ? Math.abs(slot - thisSlot) : Math.abs(slot) + Math.abs(thisSlot);
    if (bestSlot === undefined || absSlot < bestSlot) [bestWindow, bestSlot] = [window, absSlot];
    if (thisSlot <= slot) prevWindow = window;
    else nextWindow ??= window;
  }
  if (thisWindow !== undefined) return windowDisplayBuffer(buffer, thisWindow, "reuse", alist);
  if (typeof maxSlots !== "number" || windows.length < maxSlots) {
    const made =
      e8.letBind({ "window-combination-resize": "side" }, () =>
        (nextWindow !== undefined ? splitPartNoError([nextWindow], along(true)) : undefined) ??
        (prevWindow !== undefined ? splitPartNoError([prevWindow], along(false)) : undefined),
      );
    if (made !== undefined) {
      e8.setWindowParameter(made, "window-side", side);
      e8.setWindowParameter(made, "window-slot", slot);
      shareEvenly(sideWindows(side), leftOrRight);
      return windowDisplayBuffer(buffer, made, "window", alist);
    }
  }
  if (bestWindow === undefined) return undefined;
  e8.setWindowParameter(bestWindow, "window-slot", slot);
  return windowDisplayBuffer(buffer, bestWindow, "reuse", alist);
});

/** Gives the windows along a side the same share of it, as window.el's splits with window-combination-resize `side` leave them. */
function shareEvenly(windows: e8.Window[], leftOrRight: boolean): void {
  const total = windows.reduce((n, w) => n + (leftOrRight ? size(w).totalHeight : size(w).totalWidth), 0);
  const each = Math.floor(total / windows.length);
  // What does not divide evenly goes to the outer windows first, as Emacs's proportional resize leaves it.
  const extras = new Set<number>();
  for (let i = 0, n = total - each * windows.length; i < n; i++) extras.add(i % 2 === 0 ? i / 2 : windows.length - 1 - (i - 1) / 2);
  for (const [i, w] of windows.slice(0, -1).entries()) {
    const wanted = each + (extras.has(i) ? 1 : 0);
    const now = leftOrRight ? size(w).totalHeight : size(w).totalWidth;
    if (wanted !== now) e8.conditionCase(() => e8.resizeWindow(w, wanted - now, !leftOrRight), { error: () => 0 });
  }
}

/**
 * Whether a buffer matches a condition of display-buffer-alist's, as
 * buffer-match-p: a regexp its name matches, a function or a symbol naming
 * one given the buffer and `args`, t, or [category, NAME] for
 * display-buffer's action naming that category, [major-mode, MODE],
 * [derived-mode, MODE], [not, ...], [or, ...] and [and, ...].
 */
export function bufferMatchP(condition: e8.Value, bufferOrName: e8.BufferLike, ...args: e8.Value[]): boolean {
  const buffer = e8.getBuffer(bufferOrName);
  const name = buffer?.name ?? (typeof bufferOrName === "string" ? bufferOrName : "");
  const one = (c: e8.Value): boolean => {
    if (c === true) return true;
    if (typeof c === "string") return e8.stringMatch(c, name) !== undefined;
    if (typeof c === "function" || typeof c === "symbol") return !isNil(fcall(c, bufferOrName, ...args));
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
        return !rest.some(one);
      case "or":
        return rest.some(one);
      case "and":
        return rest.every(one);
      default:
        return false;
    }
  };
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
  const buffer = e8.getBuffer(bufferOrName);
  if (buffer === undefined || !e8.bufferLiveP(buffer)) e8.signal("error", "Invalid buffer");
  const name = buffer.name ?? "";
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
  let result: ActionResult;
  for (const fn of functions) {
    result = actionResult(fcall(fn, buffer, alist));
    if (result !== undefined) break;
  }
  const window = windowOf(result);
  const select = assq(alist, "post-command-select-window");
  if (select !== undefined && window !== undefined) {
    const oldSelected = e8.selectedWindow();
    const postfun = () => {
      if (!isNil(select[1])) {
        if (e8.windowLiveP(window)) e8.selectWindow(window);
      } else if (e8.windowLiveP(oldSelected)) {
        e8.selectWindow(oldSelected);
      }
      e8.removeHook("post-command-hook", postfun);
    };
    e8.addHook("post-command-hook", postfun);
  }
  return window;
}

/**
 * Shows a buffer in some window, as display-buffer, and selects that
 * window and its frame, as pop-to-buffer. `norecord` leaves the buffer
 * list as it is. E8 scripts have no set-buffer, so a buffer with no
 * window used does not become current.
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
    "else a new window split off a large enough one, else the least recently used window. " +
    "Code passing an action calls window.ts's displayBuffer.",
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
    e8.letBind({ "pop-up-windows": true }, () => popToBuffer(buffer, true));
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

// Window sizes and resizing, window.el's, from window-total-size to
// minimize-window, in its shape (ADR 0069, stage 4). Sizes are in the
// front end's units, "pixels": cells on a terminal, points in the GUI.
// window.el keeps symbols and conses in a window's new normal size while
// it works (`ignore`, `skip`, (MIN-DELTA . FACTOR)); window.c applies only
// numbers, so the core holds those and `newNormals` the rest. E8 has no
// scroll bars and no right or bottom dividers as frame parameters, so they
// count as nothing here; the frame's root window is never resized by
// resizing the frame through window.el, and the minibuffer's window sizes
// itself, as resize-mini-windows says, so window--resize-mini-window does
// nothing.

e8.defineVariable({
  name: "window-size-fixed",
  doc:
    "Non-nil in a buffer means windows showing it keep their size: height only their height, width only their width, t both. " +
    "Emacs changes them only when it has no other choice, as when a neighbouring window is deleted.",
  value: null,
  local: true,
});
e8.defineVariable({
  name: "window-resize-pixelwise",
  doc: "Non-nil means resize windows by the front end's units rather than whole lines and columns.",
  value: null,
});

/** A window's first child, as window-child; undefined for a live window. */
const windowChild = (window: e8.Window): e8.Window | undefined => e8.windowTopChild(window) ?? e8.windowLeftChild(window);
/** An internal window's last child, as window-last-child. */
function windowLastChild(window: e8.Window): e8.Window | undefined {
  let c = windowChild(window);
  for (let n = c && e8.windowNextSibling(c); n !== undefined; n = e8.windowNextSibling(n)) c = n;
  return c;
}
/** The window after one in its parent, as window-right. */
const windowRight = (window: e8.Window): e8.Window | undefined => e8.windowNextSibling(window);
/** The window before one in its parent, as window-left. */
const windowLeft = (window: e8.Window): e8.Window | undefined => e8.windowPrevSibling(window);
/** Whether an internal window's children are side by side with `horizontal`, else one above another, as window-combination-p. */
const windowCombinationP = (window: e8.Window, horizontal: boolean): boolean =>
  (horizontal ? e8.windowLeftChild(window) : e8.windowTopChild(window)) !== undefined;
/** The left and top edges of a window, live or internal, as window-pixel-left and window-pixel-top. */
const windowPixelLeft = (window: e8.Window): number => e8.windowPixelEdges(window)[0];
const windowPixelTop = (window: e8.Window): number => e8.windowPixelEdges(window)[1];
/** Whether a window is the minibuffer's, as window-minibuffer-p. */
const windowMinibufferP = (window: e8.Window): boolean => window === e8.minibufferWindow();
/** The minibuffer's window while a minibuffer is open, as active-minibuffer-window. */
const activeMinibufferWindow = (): e8.Window | undefined => (e8.minibufferDepth() > 0 ? e8.minibufferWindow() : undefined);

/** A column's width, or with `horizontal` false a line's height, as frame-char-size. */
function frameCharSize(horizontal = false): number {
  const [width, height] = e8.frameCharSize();
  return horizontal ? width : height;
}
/** A number variable's value, or `otherwise`. */
const numberVariable = (name: string, otherwise: number): number => {
  const v = e8.variable(name);
  return typeof v === "number" ? v : otherwise;
};
const windowSafeMinHeight = 1;
const windowSafeMinWidth = 2;

// What window.el keeps in a new normal size that is not a number.
const newNormals = new Map<e8.Window, unknown>();
/** A window's new normal size, as window-new-normal: a number, nil, or what window.el put there. */
function windowNewNormal(window: e8.Window): unknown {
  return newNormals.has(window) ? newNormals.get(window) : (e8.windowNewNormal(window) ?? null);
}
/** Sets a window's new normal size, as set-window-new-normal: a number window-resize-apply gives it, or a mark of window.el's own. */
function setWindowNewNormal(window: e8.Window, size?: unknown): void {
  if (typeof size === "number") {
    newNormals.delete(window);
    e8.setWindowNewNormal(window, size);
    return;
  }
  e8.setWindowNewNormal(window);
  if (isNil(size)) newNormals.delete(window);
  else newNormals.set(window, size);
}
const newNormalIs = (window: e8.Window, ...names: string[]): boolean => names.includes(symName(windowNewNormal(window)) ?? "");

/** A window's total height in lines, or width in columns with `horizontal`, as window-total-size. */
export function windowTotalSize(window: e8.Window = e8.selectedWindow(), horizontal = false): number {
  return horizontal ? e8.windowTotalWidth(window) : e8.windowTotalHeight(window);
}
e8.defun("window-total-size", (window?: e8.Window, horizontal?: e8.Value) => windowTotalSize(window ?? undefined, !isNil(horizontal)));

/** A window's total height or with `horizontal` width, in lines and columns or with `pixelwise` the front end's units, as window-size. */
export function windowSize(window: e8.Window = e8.selectedWindow(), horizontal = false, pixelwise = false): number {
  if (pixelwise) return horizontal ? e8.windowPixelWidth(window) : e8.windowPixelHeight(window);
  return windowTotalSize(window, horizontal);
}
e8.defun("window-size", (window?: e8.Window, horizontal?: e8.Value, pixelwise?: e8.Value) =>
  windowSize(window ?? undefined, !isNil(horizontal), !isNil(pixelwise)),
);

/** The height or with `horizontal` width of a window's text area, as window-body-size. */
export function windowBodySize(window: e8.Window = e8.selectedWindow(), horizontal = false, pixelwise = false): number {
  if (pixelwise) return horizontal ? e8.windowBodyPixelWidth(window) : e8.windowBodyPixelHeight(window);
  const s = e8.windowSize(window);
  return s === undefined ? 0 : horizontal ? s.width : s.height;
}
e8.defun("window-body-size", (window?: e8.Window, horizontal?: e8.Value, pixelwise?: e8.Value) =>
  windowBodySize(window ?? undefined, !isNil(horizontal), !isNil(pixelwise)),
);

/**
 * Keeps a live window's body height, or width with `horizontal`, as it is
 * now while windows are resized, or with `preserve` nil stops keeping it,
 * as window-preserve-size: kept in its window-preserved-size parameter as
 * [BUFFER, WIDTH, HEIGHT], for as long as it shows that buffer.
 */
export function windowPreserveSize(window: e8.Window = e8.selectedWindow(), horizontal = false, preserve: unknown = null): void {
  const parameter = e8.windowParameter(window, "window-preserved-size");
  const old = Array.isArray(parameter) ? parameter : [];
  const width = horizontal ? (isNil(preserve) ? null : e8.windowBodyPixelWidth(window)) : (old[1] ?? null);
  const height = horizontal ? (old[2] ?? null) : isNil(preserve) ? null : e8.windowBodyPixelHeight(window);
  e8.setWindowParameter(window, "window-preserved-size", [e8.getBuffer(e8.windowBuffer(window) ?? "") ?? null, width, height]);
}
e8.defun("window-preserve-size", (window?: e8.Window, horizontal?: e8.Value, preserve?: e8.Value) => {
  windowPreserveSize(window ?? undefined, !isNil(horizontal), preserve ?? null);
  return null;
});

/** The body height, or width with `horizontal`, a window keeps, as window-preserved-size; undefined if it keeps none. */
export function windowPreservedSize(window: e8.Window = e8.selectedWindow(), horizontal = false): e8.Value | undefined {
  const parameter = e8.windowParameter(window, "window-preserved-size");
  // The buffer itself, as Emacs compares it with eq, so a renamed buffer keeps it and a new one of the name does not.
  if (Array.isArray(parameter) && parameter[0] === e8.getBuffer(e8.windowBuffer(window) ?? "")) return parameter[horizontal ? 1 : 2] ?? undefined;
  return undefined;
}
e8.defun("window-preserved-size", (window?: e8.Window, horizontal?: e8.Value) => windowPreservedSize(window ?? undefined, !isNil(horizontal)) ?? null);

/** Whether a window's height, or width, is kept now, as window--preserve-size: the size kept is the size it has. */
function windowPreserveSize_(window: e8.Window, horizontal: boolean): boolean {
  const size = windowPreservedSize(window, horizontal);
  return typeof size === "number" && size === windowBodySize(window, horizontal, true);
}

/** The least size a window can safely have, as window-safe-min-size: a line or two columns. */
export function windowSafeMinSize(window: e8.Window = e8.selectedWindow(), horizontal = false, pixelwise = false): number {
  void window;
  if (pixelwise) return Math.round(horizontal ? windowSafeMinWidth * frameCharSize(true) : windowSafeMinHeight * frameCharSize(false));
  return horizontal ? windowSafeMinWidth : windowSafeMinHeight;
}
e8.defun("window-safe-min-size", (window?: e8.Window, horizontal?: e8.Value, pixelwise?: e8.Value) =>
  windowSafeMinSize(window ?? undefined, !isNil(horizontal), !isNil(pixelwise)),
);

/** The least height of a window in units, as window-min-pixel-height: window-min-height lines, one for the minibuffer's. */
const windowMinPixelHeight = (window: e8.Window): number =>
  Math.round(Math.max(windowMinibufferP(window) ? 1 : numberVariable("window-min-height", 4), windowSafeMinHeight) * frameCharSize(false));
/** The least width of a window in units, as window-min-pixel-width. */
const windowMinPixelWidth = (): number => Math.round(Math.max(numberVariable("window-min-width", 10), windowSafeMinWidth) * frameCharSize(true));

/**
 * The least height, or width with `horizontal`, a window can have, as
 * window-min-size: for a live window window-min-height lines or
 * window-min-width columns, and what it needs beside its text; for an
 * internal window its children's together, or the largest across them.
 * `ignore` is as window-resizable's.
 */
export function windowMinSize(window: e8.Window = e8.selectedWindow(), horizontal = false, ignore: unknown = null, pixelwise = false): number {
  return windowMinSize1(window, horizontal, ignore, pixelwise);
}
e8.defun("window-min-size", (window?: e8.Window, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) =>
  windowMinSize(window ?? undefined, !isNil(horizontal), ignore ?? null, !isNil(pixelwise)),
);

/** Whether `ignore` says to ignore a window's restrictions, as window--min-size-ignore-p. */
function windowMinSizeIgnoreP(window: e8.Window, ignore: unknown): boolean {
  if (e8.windowValidP(ignore)) return window === ignore;
  return !(isNil(ignore) || symName(ignore) === "preserved");
}

function windowMinSize1(window: e8.Window, horizontal: boolean, ignore: unknown, pixelwise: boolean): number {
  let sub = windowChild(window);
  if (sub !== undefined) {
    let value = 0;
    if (windowCombinedP(sub, horizontal)) {
      // An iso-combination needs its children's together.
      for (; sub !== undefined; sub = windowRight(sub)) value += windowMinSize1(sub, horizontal, ignore, pixelwise);
    } else {
      // An ortho-combination needs the most any of them needs.
      for (; sub !== undefined; sub = windowRight(sub)) value = Math.max(value, windowMinSize1(sub, horizontal, ignore, pixelwise));
    }
    return value;
  }
  return e8.withCurrentBuffer(e8.windowBuffer(window) ?? e8.currentBuffer(), () => {
    if (windowSizeFixedP(window, horizontal, ignore)) return windowSize(window, horizontal, pixelwise);
    if (symName(ignore) === "safe") return windowSafeMinSize(window, horizontal, pixelwise);
    const ignored = windowMinSizeIgnoreP(window, ignore);
    const resizePixelwise = !isNil(e8.variable("window-resize-pixelwise"));
    if (horizontal) {
      const charSize = frameCharSize(true);
      const [leftFringe, rightFringe] = e8.windowFringes(window);
      const [leftMargin, rightMargin] = e8.windowMargins(window);
      // A min-margins parameter (LEFT . RIGHT) stands for the margins.
      const minMargins = e8.windowParameter(window, "min-margins");
      const leftMin = Array.isArray(minMargins) && typeof minMargins[0] === "number" ? minMargins[0] : undefined;
      const rightMin = Array.isArray(minMargins) && typeof minMargins[1] === "number" ? minMargins[1] : undefined;
      // No scroll bars or right dividers in E8.
      const pixelWidth =
        windowSafeMinSize(window, true, true) + (leftMin ?? leftMargin ?? 0) * charSize + (rightMin ?? rightMargin ?? 0) * charSize + leftFringe + rightFringe;
      if (pixelwise) {
        return Math.max(resizePixelwise ? Math.round(pixelWidth) : Math.round(Math.ceil(pixelWidth / charSize) * charSize), ignored ? 0 : windowMinPixelWidth());
      }
      return Math.max(Math.ceil(pixelWidth / charSize), ignored ? 0 : numberVariable("window-min-width", 10));
    }
    const charSize = frameCharSize(false);
    // A line, and the window's tab line, header line and mode line: what of it is not text.
    const pixelHeight = windowSafeMinSize(window, false, true) + (e8.windowPixelHeight(window) - e8.windowBodyPixelHeight(window));
    if (pixelwise) {
      return Math.max(resizePixelwise ? Math.round(pixelHeight) : Math.round(Math.ceil(pixelHeight / charSize) * charSize), ignored ? 0 : windowMinPixelHeight(window));
    }
    return Math.max(Math.ceil(pixelHeight / charSize), ignored ? 0 : numberVariable("window-min-height", 4));
  });
}

/**
 * How far a window can grow by `delta`, or shrink by a negative one,
 * looking only at it and its children, as window-sizable: `delta` if it
 * can, else the most between 0 and `delta` it can.
 */
export function windowSizable(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, ignore: unknown = null, pixelwise = false): number {
  if (delta < 0) {
    const minSize = windowMinSize(window, horizontal, ignore, pixelwise);
    const size = windowSize(window, horizontal, pixelwise);
    return size <= minSize ? 0 : Math.max(minSize - size, delta);
  }
  if (delta > 0) return windowSizeFixedP(window, horizontal, ignore) ? 0 : delta;
  return 0;
}
e8.defun("window-sizable", (window: e8.Window, delta: number, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) =>
  windowSizable(window ?? undefined, delta, !isNil(horizontal), ignore ?? null, !isNil(pixelwise)),
);

/** Whether a window alone can be resized by `delta`, as window-sizable-p. */
export function windowSizableP(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, ignore: unknown = null, pixelwise = false): boolean {
  const got = windowSizable(window, delta, horizontal, ignore, pixelwise);
  return delta > 0 ? got >= delta : got <= delta;
}
e8.defun("window-sizable-p", (window: e8.Window, delta: number, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) =>
  windowSizableP(window ?? undefined, delta, !isNil(horizontal), ignore ?? null, !isNil(pixelwise)),
);

function windowSizeFixed1(window: e8.Window, horizontal: boolean, ignore: unknown): boolean {
  let sub = windowChild(window);
  if (sub !== undefined) {
    if (windowCombinedP(sub, horizontal)) {
      // An iso-combination is fixed if all its children are.
      for (; sub !== undefined; sub = windowRight(sub)) if (!windowSizeFixed1(sub, horizontal, ignore)) return false;
      return true;
    }
    // An ortho-combination is fixed if any of its children is.
    for (; sub !== undefined; sub = windowRight(sub)) if (windowSizeFixed1(sub, horizontal, ignore)) return true;
    return false;
  }
  if (e8.windowp(ignore) && window === ignore) return false;
  if (symName(ignore) !== "preserved" && windowPreserveSize_(window, horizontal)) return true;
  const fixed = e8.withCurrentBuffer(e8.windowBuffer(window) ?? e8.currentBuffer(), () => e8.variable("window-size-fixed"));
  return fixed === true || symName(fixed) === (horizontal ? "width" : "height");
}

/**
 * Whether a window's height, or width with `horizontal`, is fixed, as
 * window-size-fixed-p: by window-size-fixed in its buffer or a size it
 * keeps; for an internal window, by its children's.
 */
export function windowSizeFixedP(window: e8.Window = e8.selectedWindow(), horizontal = false, ignore: unknown = null): boolean {
  if (e8.windowp(ignore) || isNil(ignore) || symName(ignore) === "preserved") return windowSizeFixed1(window, horizontal, ignore);
  return false;
}
e8.defun("window-size-fixed-p", (window?: e8.Window, horizontal?: e8.Value, ignore?: e8.Value) =>
  windowSizeFixedP(window ?? undefined, !isNil(horizontal), ignore ?? null),
);

type Trail = "before" | "after" | undefined;
const trailOf = (v: unknown): Trail => (symName(v) === "before" ? "before" : symName(v) === "after" ? "after" : undefined);

function windowMinDelta1(window: e8.Window, delta: number, horizontal = false, ignore: unknown = null, trail?: Trail, noup = false, pixelwise = false): number {
  const parent = e8.windowParent(window);
  // Nothing to take at the top.
  if (parent === undefined) return 0;
  let sub = windowChild(parent);
  if (windowCombinedP(sub!, horizontal)) {
    // In an iso-combination, DELTA if a sibling not fixed in size can take it.
    let skip = trail === "after";
    for (; sub !== undefined; sub = windowRight(sub)) {
      if (sub === window) skip = trail === "before";
      else if (skip) continue;
      else if (windowSizeFixedP(sub, horizontal, ignore)) continue;
      else return delta;
    }
  } else {
    // In an ortho-combination, as little as the others can shrink.
    for (; sub !== undefined; sub = windowRight(sub)) {
      if (sub !== window) delta = Math.min(delta, Math.max(windowSize(sub, horizontal, pixelwise) - windowMinSize(sub, horizontal, ignore, pixelwise), 0));
    }
  }
  return noup ? delta : windowMinDelta1(parent, delta, horizontal, ignore, trail, false, pixelwise);
}

/**
 * How far a window can shrink, as window-min-delta: 0 if it cannot.
 * `trail` "before" lets only windows above or left of it grow, "after"
 * only those below or right; `noup` keeps to its own combination, and
 * `nodown` asks only whether the others could take all of it.
 */
export function windowMinDelta(
  window: e8.Window = e8.selectedWindow(),
  horizontal = false,
  ignore: unknown = null,
  trail?: Trail,
  noup = false,
  nodown = false,
  pixelwise = false,
): number {
  const size = windowSize(window, horizontal, pixelwise);
  const minimum = windowMinSize(window, horizontal, ignore, pixelwise);
  if (nodown) return windowMinDelta1(window, size, horizontal, ignore, trail, noup, pixelwise);
  if (size <= minimum) return 0;
  return windowMinDelta1(window, size - minimum, horizontal, ignore, trail, noup, pixelwise);
}
e8.defun(
  "window-min-delta",
  (window?: e8.Window, horizontal?: e8.Value, ignore?: e8.Value, trail?: e8.Value, noup?: e8.Value, nodown?: e8.Value, pixelwise?: e8.Value) =>
    windowMinDelta(window ?? undefined, !isNil(horizontal), ignore ?? null, trailOf(trail), !isNil(noup), !isNil(nodown), !isNil(pixelwise)),
);

/** The least height, or width, a frame's windows can have, as frame-windows-min-size. */
export function frameWindowsMinSize(frame?: e8.Frame, horizontal = false, ignore: unknown = null, pixelwise = false): number {
  const root = e8.frameRootWindow(frame);
  // The minibuffer's window, the root's sibling in Emacs, which E8 keeps
  // apart from the tree: as window-min-size gives it there, a line, or
  // without PIXELWISE window-min-height lines.
  const mini = pixelwise ? Math.round(frameCharSize(false)) : minHeight();
  return windowMinSize(root, horizontal, ignore, pixelwise) + (!horizontal ? mini : 0);
}
e8.defun("frame-windows-min-size", (frame?: e8.Frame, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) =>
  frameWindowsMinSize(frame ?? undefined, !isNil(horizontal), ignore ?? null, !isNil(pixelwise)),
);

function windowMaxDelta1(window: e8.Window, delta: number, horizontal = false, ignore: unknown = null, trail?: Trail, noup = false, pixelwise = false): number {
  const parent = e8.windowParent(window);
  // At the top, DELTA is all there is.
  if (parent === undefined) return delta;
  let sub = windowChild(parent);
  if (windowCombinedP(sub!, horizontal)) {
    // In an iso-combination, what the others can give.
    let skip = trail === "after";
    for (; sub !== undefined; sub = windowRight(sub)) {
      if (sub === window) skip = trail === "before";
      else if (!skip) delta += Math.max(windowSize(sub, horizontal, pixelwise) - windowMinSize(sub, horizontal, ignore, pixelwise), 0);
    }
  } else {
    // In an ortho-combination, nothing more if another child is fixed in size.
    for (; sub !== undefined; sub = windowRight(sub)) if (sub !== window && windowSizeFixedP(sub, horizontal, ignore)) return delta;
  }
  return noup ? delta : windowMaxDelta1(parent, delta, horizontal, ignore, trail, false, pixelwise);
}

/** How far a window can grow, as window-max-delta: 0 if it cannot; the arguments as window-min-delta's. */
export function windowMaxDelta(
  window: e8.Window = e8.selectedWindow(),
  horizontal = false,
  ignore: unknown = null,
  trail?: Trail,
  noup = false,
  nodown = false,
  pixelwise = false,
): number {
  if (!nodown && windowSizeFixedP(window, horizontal, ignore)) return 0;
  return windowMaxDelta1(window, 0, horizontal, ignore, trail, noup, pixelwise);
}
e8.defun(
  "window-max-delta",
  (window?: e8.Window, horizontal?: e8.Value, ignore?: e8.Value, trail?: e8.Value, noup?: e8.Value, nodown?: e8.Value, pixelwise?: e8.Value) =>
    windowMaxDelta(window ?? undefined, !isNil(horizontal), ignore ?? null, trailOf(trail), !isNil(noup), !isNil(nodown), !isNil(pixelwise)),
);

/** How far a window can be resized by `delta`, as window--resizable; the arguments as window-min-delta's. */
function windowResizable_(
  window: e8.Window = e8.selectedWindow(),
  delta: number,
  horizontal = false,
  ignore: unknown = null,
  trail?: Trail,
  noup = false,
  nodown = false,
  pixelwise = false,
): number {
  if (delta < 0) return Math.max(-windowMinDelta(window, horizontal, ignore, trail, noup, nodown, pixelwise), delta);
  if (delta > 0) return Math.min(windowMaxDelta(window, horizontal, ignore, trail, noup, nodown, pixelwise), delta);
  return 0;
}

/** Whether a window can be resized by all of `delta`, as window--resizable-p. */
function windowResizableP_(
  window: e8.Window = e8.selectedWindow(),
  delta: number,
  horizontal = false,
  ignore: unknown = null,
  trail?: Trail,
  noup = false,
  nodown = false,
  pixelwise = false,
): boolean {
  const got = windowResizable_(window, delta, horizontal, ignore, trail, noup, nodown, pixelwise);
  return delta > 0 ? got >= delta : got <= delta;
}

/**
 * How far a window can grow by `delta` lines, or columns with
 * `horizontal`, or shrink by a negative one, taking from or giving to
 * other windows, as window-resizable: `delta` if it can, else the most
 * between 0 and `delta` it can. `ignore` t ignores window-size-fixed and
 * the least sizes, `safe` too and lets windows go down to a line or two
 * columns, `preserved` ignores only sizes windows keep, and a window
 * ignores that window's restrictions.
 */
export function windowResizable(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, ignore: unknown = null, pixelwise = false): number {
  return windowResizable_(window, delta, horizontal, ignore, undefined, false, false, pixelwise);
}
e8.defun("window-resizable", (window: e8.Window, delta: number, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) =>
  windowResizable(window ?? undefined, delta, !isNil(horizontal), ignore ?? null, !isNil(pixelwise)),
);

/** Whether a window can be resized by all of `delta`, as window-resizable-p. */
export function windowResizableP(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, ignore: unknown = null, pixelwise = false): boolean {
  return windowResizableP_(window, delta, horizontal, ignore, undefined, false, false, pixelwise);
}
e8.defun("window-resizable-p", (window: e8.Window, delta: number, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) =>
  windowResizableP(window ?? undefined, delta, !isNil(horizontal), ignore ?? null, !isNil(pixelwise)),
);

/** Whether a window is as tall as its frame's root window, as window-full-height-p. */
export function windowFullHeightP(window: e8.Window = e8.selectedWindow()): boolean {
  if (windowMinibufferP(window)) return window === e8.frameRootWindow(e8.windowFrame(window));
  return e8.windowPixelHeight(window) === e8.windowPixelHeight(e8.frameRootWindow(e8.windowFrame(window)));
}
e8.defun("window-full-height-p", (window?: e8.Window) => windowFullHeightP(window ?? undefined));

/** Whether a window is as wide as its frame's root window, as window-full-width-p. */
export function windowFullWidthP(window: e8.Window = e8.selectedWindow()): boolean {
  return e8.windowPixelWidth(window) === e8.windowPixelWidth(e8.frameRootWindow(e8.windowFrame(window)));
}
e8.defun("window-full-width-p", (window?: e8.Window) => windowFullWidthP(window ?? undefined));

/**
 * A number of lines, or columns with `horizontal`, in the front end's
 * units, as window--size-to-pixel; with `pixelwise` the size is in those
 * units already, rounded to whole lines or columns with `roundMaybe`
 * unless window-resize-pixelwise.
 */
function windowSizeToPixel(window: e8.Window, size: number, horizontal = false, pixelwise = false, roundMaybe = false): number {
  void window;
  const charSize = frameCharSize(horizontal);
  if (pixelwise) {
    return roundMaybe && isNil(e8.variable("window-resize-pixelwise")) ? Math.round(Math.round(size / charSize) * charSize) : size;
  }
  return Math.round(size * charSize);
}

/**
 * Gives windows total sizes from their pixel sizes, as window--pixel-to-total:
 * E8 works them out from pixel sizes itself, so window-resize-apply-total
 * is all there is to it.
 */
function windowPixelToTotal(frame?: e8.Frame, horizontal = false): void {
  e8.windowResizeApplyTotal(frame, horizontal);
}

/**
 * Resizes the minibuffer's window, as window--resize-mini-window. E8's
 * minibuffer window sizes itself to what it shows, as resize-mini-windows
 * says, and is not part of the frame's window tree, so this does nothing.
 */
function windowResizeMiniWindow(window: e8.Window, delta: number): void {
  void window;
  void delta;
}

/** Whether a window on a frame is to change size, as window--resize-apply-p. */
function windowResizeApplyP(frame?: e8.Frame, horizontal = false): boolean {
  let apply = false;
  walkWindowTree(
    (w) => {
      if (e8.windowNewPixel(w) !== windowSize(w, horizontal, true)) apply = true;
    },
    frame,
    true,
  );
  return apply;
}

/**
 * Resizes a window by `delta` lines, or columns with `horizontal`, or with
 * `pixelwise` the front end's units, as window-resize: other windows give
 * or take the difference, its neighbour alone if it can and
 * window-combination-resize is not t, else the others in its combination
 * in proportion, and its parent's if they cannot. `ignore` is as
 * window-resizable's. An error if the window cannot be resized that much.
 */
export function windowResize(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, ignore: unknown = null, pixelwise = false): void {
  const frame = e8.windowFrame(window);
  const minibufferWindow = e8.minibufferWindow();
  delta = windowSizeToPixel(window, delta, horizontal, pixelwise, true);
  if (window === e8.frameRootWindow(frame)) e8.signal("error", "Cannot resize the root window of a frame");
  if (!pixelwise && !windowMinibufferP(window)) {
    // Lines or columns of a font whose width is not a whole number of units,
    // as a GUI's may be, can come to a unit more than can go: no further
    // than the windows around allow, as whole units would have stopped.
    // Only that rounding is taken back; asking for more stays an error.
    const unit = frameCharSize(horizontal);
    const most = delta > 0 ? windowMaxDelta(window, horizontal, ignore, undefined, false, false, true) : -windowMinDelta(window, horizontal, ignore, undefined, false, false, true);
    if (Math.abs(delta) > Math.abs(most) && Math.abs(delta) - Math.abs(most) < unit) delta = most;
  }
  if (windowMinibufferP(window)) {
    if (horizontal) e8.signal("error", "Cannot resize minibuffer window horizontally");
    windowResizeMiniWindow(window, delta);
    return;
  }
  if (
    !horizontal &&
    windowFullHeightP(window) &&
    (isNil(e8.variable("resize-mini-windows")) || minibufferWindow === activeMinibufferWindow())
  ) {
    // Emacs resizes the minibuffer's window here.
    windowResizeMiniWindow(minibufferWindow, -delta);
    return;
  }
  if (
    windowResizableP_(window, delta, horizontal, ignore, undefined, false, false, true) ||
    (isNil(ignore) && ((ignore = Symbol.for("preserved")), windowResizableP_(window, delta, horizontal, ignore, undefined, false, false, true)))
  ) {
    windowResizeReset(frame, horizontal);
    windowResizeThisWindow(window, delta, horizontal, ignore, true);
    const sibling = windowCombinedP(window, horizontal) ? (windowRight(window) ?? windowLeft(window)) : undefined;
    if (e8.variable("window-combination-resize") !== true && sibling !== undefined && windowSizableP(sibling, -delta, horizontal, ignore, true)) {
      // Its neighbour after it, or before it if it is the last, gives or takes it all.
      const normalDelta = delta / windowSize(e8.windowParent(window)!, horizontal, true);
      windowResizeThisWindow(sibling, -delta, horizontal, null, true);
      setWindowNewNormal(window, e8.windowNormalSize(window, horizontal) + normalDelta);
      setWindowNewNormal(sibling, e8.windowNormalSize(sibling, horizontal) - normalDelta);
    } else {
      // Otherwise all the others in its combination do.
      windowResizeSiblings(window, delta, horizontal, ignore);
    }
    if (windowResizeApplyP(frame, horizontal)) {
      if (e8.windowResizeApply(frame, horizontal)) windowPixelToTotal(frame, horizontal);
      else e8.signal("error", `Failed to apply resizing ${String(window)}`);
    }
    return;
  }
  e8.signal("error", `Cannot resize window ${String(window)}`);
}
e8.defun("window-resize", (window: e8.Window, delta: number, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) => {
  windowResize(window ?? undefined, delta, !isNil(horizontal), ignore ?? null, !isNil(pixelwise));
  return null;
});

/** Resizes a window as window-resize does if it can be resized by all of `delta`, else leaves it, as window-resize-no-error. */
export function windowResizeNoError(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, ignore: unknown = null, pixelwise = false): void {
  if (windowResizableP_(window, delta, horizontal, ignore, undefined, false, false, pixelwise)) windowResize(window, delta, horizontal, ignore, pixelwise);
}
e8.defun("window-resize-no-error", (window: e8.Window, delta: number, horizontal?: e8.Value, ignore?: e8.Value, pixelwise?: e8.Value) => {
  windowResizeNoError(window ?? undefined, delta, !isNil(horizontal), ignore ?? null, !isNil(pixelwise));
  return null;
});

/** Whether the resizing functions leave a window alone, as window--resize-child-windows-skip-p. */
const windowResizeChildWindowsSkipP = (window: e8.Window): boolean => newNormalIs(window, "ignore", "stuck", "skip");

/**
 * Sets new normal sizes for a parent's children once one of them,
 * `window`, is resized by `thisDelta`, as
 * window--resize-child-windows-normal; `otherDelta` was taken from or
 * given to the parent's own ancestors.
 */
function windowResizeChildWindowsNormal(parent: e8.Window, horizontal: boolean, window: e8.Window, thisDelta: number, trail: Trail, otherDelta: number): void {
  const parentSize = windowSize(parent, horizontal, true);
  // When WINDOW goes and its siblings take all of it, its normal size is the delta.
  let deltaNormal = -thisDelta === windowSize(window, horizontal, true) && otherDelta === 0 ? -e8.windowNormalSize(window, horizontal) : thisDelta / parentSize;
  let parentNormal = 0;
  let skip = trail === "after";
  for (let sub = windowChild(parent); sub !== undefined; sub = windowRight(sub)) {
    if (sub === window) skip = trail === "before";
    else if (!skip) parentNormal += e8.windowNormalSize(sub, horizontal);
  }
  // Each sibling's share of what WINDOW took or gave.
  skip = trail === "after";
  for (let sub = windowChild(parent); sub !== undefined; sub = windowRight(sub)) {
    if (sub === window) skip = trail === "before";
    else if (!skip) {
      const oldNormal = e8.windowNormalSize(sub, horizontal);
      setWindowNewNormal(sub, Math.min(1, Math.max(oldNormal - (oldNormal / parentNormal) * deltaNormal, 0)));
    }
  }
  if (typeof otherDelta === "number") {
    // And of what came from or went to the ancestors.
    deltaNormal = parentSize / (parentSize + otherDelta);
    skip = trail === "after";
    for (let sub = windowChild(parent); sub !== undefined; sub = windowRight(sub)) {
      if (sub === window) skip = trail === "before";
      else if (!skip) setWindowNewNormal(sub, Math.min(1, Math.max((windowNewNormal(sub) as number) * deltaNormal, 0)));
    }
  }
  // WINDOW has what its siblings leave.
  let sum = 0;
  for (let sub = windowChild(parent); sub !== undefined; sub = windowRight(sub)) {
    if (sub === window) continue;
    const n = windowNewNormal(sub);
    sum += typeof n === "number" ? n : e8.windowNormalSize(sub, horizontal);
  }
  setWindowNewNormal(window, Math.min(1, Math.max(1 - sum, 0)));
}

/**
 * Resizes a parent's children by `delta` units together, as
 * window--resize-child-windows: those next to `edge` alone if `trail` and
 * `edge` say so and they can, else all of them a line or column at a time,
 * shrinking first those largest for their normal sizes and growing those
 * smallest. Says "normalized" if it set the new normal sizes itself.
 */
function windowResizeChildWindows(
  parent: e8.Window,
  delta: number,
  horizontal = false,
  window?: e8.Window,
  ignore: unknown = null,
  trail?: Trail,
  edge?: number,
  charSize?: number,
): "normalized" | undefined {
  const first = windowChild(parent)!;
  const last = windowLastChild(parent)!;
  const parentTotal = windowSize(parent, horizontal, true) + delta;
  const step = charSize ?? (isNil(e8.variable("window-resize-pixelwise")) ? Math.max(1, Math.round(frameCharSize(horizontal))) : 1);
  let sub: e8.Window | undefined;
  const adjacent = (): boolean => {
    if (edge === undefined || trail === undefined) return false;
    sub = first;
    for (;;) {
      const right: e8.Window | undefined = windowRight(sub!);
      if (right === undefined) break;
      if (trail === "before" ? !windowResizeChildWindowsSkipP(right) : windowResizeChildWindowsSkipP(sub!)) sub = right;
      else break;
    }
    const s = sub!;
    const at = horizontal
      ? trail === "before"
        ? windowPixelLeft(s) + e8.windowPixelWidth(s) === edge
        : windowPixelLeft(s) === edge
      : trail === "before"
        ? windowPixelTop(s) + e8.windowPixelHeight(s) === edge
        : windowPixelTop(s) === edge;
    return at && windowSizableP(s, delta, horizontal, ignore, true);
  };
  if (adjacent()) {
    // Resize only the window next to EDGE.
    const s = sub!;
    windowResizeThisWindow(s, delta, horizontal, ignore, true, trail, edge);
    if (window !== undefined && e8.windowParent(s) === parent) {
      setWindowNewNormal(s, e8.windowNewPixel(s) / parentTotal);
      setWindowNewNormal(window, e8.windowNormalSize(window, horizontal) - ((windowNewNormal(s) as number) - e8.windowNormalSize(s, horizontal)));
    } else {
      windowResizeChildWindowsNormal(parent, horizontal, s, 0, trail, delta);
    }
    return "normalized";
  }
  // Resize all of them in proportion.
  for (sub = last; sub !== undefined; sub = windowLeft(sub)) {
    if (windowResizeChildWindowsSkipP(sub)) continue;
    if (isNil(ignore) && windowSizeFixedP(sub, horizontal, ignore)) {
      // Leave windows fixed in size alone.
      setWindowNewNormal(sub, Symbol.for("ignore"));
    } else if (delta < 0) {
      // Shrinking: what it can give, and how large it is for its normal size.
      setWindowNewNormal(sub, [
        windowMinDelta(sub, horizontal, ignore, trail, true, false, true),
        windowSize(sub, horizontal, true) / parentTotal - e8.windowNormalSize(sub, horizontal),
      ]);
    } else if (delta > 0) {
      // Growing: how large it is for its normal size.
      setWindowNewNormal(sub, windowSize(sub, horizontal, true) / parentTotal - e8.windowNormalSize(sub, horizontal));
    }
  }
  // As window.el: only a delta to share out makes the last pass, once it is all shared.
  let bestWindow: e8.Window | true | undefined;
  if (delta < 0) {
    bestWindow = true;
    while (bestWindow !== undefined && delta !== 0) {
      bestWindow = undefined;
      let bestValue: number | undefined;
      for (sub = last; sub !== undefined; sub = windowLeft(sub)) {
        const n = windowNewNormal(sub);
        if (Array.isArray(n) && !(n[0] <= 0) && (bestValue === undefined || n[1] > bestValue)) {
          bestWindow = sub;
          bestValue = n[1];
        }
      }
      if (bestWindow !== undefined) {
        const n = windowNewNormal(bestWindow) as [number, number];
        const bestDelta = Math.min(n[0], step, -delta);
        delta += bestDelta;
        e8.setWindowNewPixel(bestWindow, -bestDelta, true);
        setWindowNewNormal(
          bestWindow,
          n[0] === bestDelta
            ? Symbol.for("skip") // It cannot shrink any further.
            : [n[0] - bestDelta, e8.windowNewPixel(bestWindow) / parentTotal - e8.windowNormalSize(bestWindow, horizontal)],
        );
      }
    }
  } else if (delta > 0) {
    bestWindow = true;
    while (bestWindow !== undefined && delta !== 0) {
      bestWindow = undefined;
      let bestValue: number | undefined;
      for (sub = last; sub !== undefined; sub = windowLeft(sub)) {
        const n = windowNewNormal(sub);
        if (typeof n === "number" && (bestValue === undefined || n < bestValue)) {
          bestWindow = sub;
          bestValue = n;
        }
      }
      if (bestWindow !== undefined) {
        const bestDelta = Math.min(delta, step);
        delta -= bestDelta;
        e8.setWindowNewPixel(bestWindow, bestDelta, true);
        setWindowNewNormal(bestWindow, e8.windowNewPixel(bestWindow) / parentTotal - e8.windowNormalSize(bestWindow, horizontal));
      }
    }
  }
  if (bestWindow !== undefined) {
    for (sub = last; sub !== undefined; sub = windowLeft(sub)) {
      const n = windowNewNormal(sub);
      // Clear the factors so window-resize-apply does not take them for normal sizes.
      if (Array.isArray(n) || typeof n === "number") setWindowNewNormal(sub);
      if (!newNormalIs(sub, "ignore")) {
        // Resize its children by what it changed by.
        const d = e8.windowNewPixel(sub) - windowSize(sub, horizontal, true);
        if (!(d === 0 && trail === undefined)) windowResizeThisWindow(sub, d, horizontal, ignore, false, trail, edge);
      }
    }
  }
  return undefined;
}

/**
 * Resizes the windows around one resized by `delta` units, as
 * window--resize-siblings, but not the window itself: its siblings, then
 * its parent's for what they could not give, going up the tree. `trail`
 * and `edge` keep to the windows before or after an edge, as
 * adjust-window-trailing-edge moves it.
 */
function windowResizeSiblings(window: e8.Window, delta: number, horizontal = false, ignore: unknown = null, trail?: Trail, edge?: number, charSize?: number): void {
  const parent = e8.windowParent(window);
  if (parent === undefined) return;
  let sub = windowChild(parent);
  if (windowCombinedP(sub!, horizontal)) {
    // In an iso-combination, take DELTA from WINDOW's siblings.
    let skip = trail === "after";
    let found = false;
    for (; sub !== undefined; sub = windowRight(sub)) {
      if (sub === window) {
        // WINDOW itself is left alone.
        setWindowNewNormal(sub, Symbol.for("ignore"));
        skip = trail === "before";
      } else if (skip) {
        setWindowNewNormal(sub, Symbol.for("ignore"));
      } else if (!windowSizeFixedP(sub, horizontal, ignore)) {
        found = true;
      }
    }
    let thisDelta: number;
    if (-delta === windowSize(window, horizontal, true)) {
      // A deletion, presumably: its siblings take all of it if any can.
      thisDelta = found ? delta : 0;
    } else {
      thisDelta = windowResizable_(window, delta, horizontal, ignore, trail, true, false, true);
    }
    // What the parent's ancestors must give.
    const otherDelta = delta - thisDelta;
    if (otherDelta !== 0) e8.setWindowNewPixel(parent, otherDelta, true);
    if (thisDelta === 0) {
      windowResizeChildWindowsNormal(parent, horizontal, window, thisDelta, trail, otherDelta);
    } else {
      if (windowResizeChildWindows(parent, -thisDelta, horizontal, window, ignore, trail, edge, charSize) !== "normalized") {
        windowResizeChildWindowsNormal(parent, horizontal, window, thisDelta, trail, otherDelta);
      }
      delta = otherDelta;
    }
  } else {
    // In an ortho-combination, every sibling changes by DELTA.
    e8.setWindowNewPixel(parent, delta, true);
    for (; sub !== undefined; sub = windowRight(sub)) if (sub !== window) windowResizeThisWindow(sub, delta, horizontal, ignore, true);
  }
  if (delta !== 0) windowResizeSiblings(parent, delta, horizontal, ignore, trail, edge, charSize);
}

/**
 * Resizes a window by `delta` units, adding it to its new size with `add`,
 * and its children to fit, as window--resize-this-window, but not its
 * siblings or parent; window-resize-apply gives the new sizes.
 */
function windowResizeThisWindow(
  window: e8.Window,
  delta: number,
  horizontal = false,
  ignore: unknown = null,
  add = false,
  trail?: Trail,
  edge?: number,
  charSize?: number,
): void {
  if (add) e8.setWindowNewPixel(window, delta, true);
  let sub = windowChild(window);
  if (sub === undefined) return;
  if (windowCombinedP(sub, horizontal)) {
    // In an iso-combination by their normal sizes.
    windowResizeChildWindows(window, delta, horizontal, undefined, ignore, trail, edge, charSize);
  } else {
    // In an ortho-combination each by DELTA.
    for (; sub !== undefined; sub = windowRight(sub)) windowResizeThisWindow(sub, delta, horizontal, ignore, true, trail, edge, charSize);
  }
}

/**
 * Makes every window on the selected frame at least its least size if it
 * can, as window--sanitize-window-sizes; says whether all are.
 */
export function windowSanitizeWindowSizes(horizontal = false): boolean {
  let value = true;
  walkWindowTree((window) => {
    const delta = windowMinSize(window, horizontal, null, true) - windowSize(window, horizontal, true);
    if (delta > 0) {
      if (windowResizableP(window, delta, horizontal, null, true)) windowResize(window, delta, horizontal, null, true);
      else value = false;
    }
  });
  return value;
}

/** The window before an edge to move: `window`, or the nearest before it up the tree, as adjust-window-trailing-edge steps left. */
function stepLeft(left: e8.Window, horizontal: boolean): e8.Window | undefined {
  const before = windowLeft(left);
  if (before !== undefined) return before;
  let w: e8.Window | undefined = left;
  while ((w = e8.windowParent(w)) !== undefined && !windowCombinedP(w, horizontal));
  return w && windowLeft(w);
}
/** The window after an edge, stepping right as adjust-window-trailing-edge does. */
function stepRight(right: e8.Window, horizontal: boolean): e8.Window | undefined {
  const after = windowRight(right);
  if (after !== undefined) return after;
  let w: e8.Window | undefined = right;
  while ((w = e8.windowParent(w)) !== undefined && !windowCombinedP(w, horizontal));
  return w && windowRight(w);
}

/**
 * Moves a window's bottom edge, or right edge with `horizontal`, by
 * `delta` lines or columns, or with `pixelwise` units, down or right for a
 * positive one, as adjust-window-trailing-edge: the windows before the
 * edge and after it change, as far as they can.
 */
export function adjustWindowTrailingEdge(window: e8.Window = e8.selectedWindow(), delta: number, horizontal = false, pixelwise = false): void {
  const frame = e8.windowFrame(window);
  const minibufferWindow = e8.minibufferWindow();
  let right: e8.Window | undefined = window;
  let ignore: unknown = null;
  if (!pixelwise) {
    pixelwise = true;
    delta = Math.round(delta * frameCharSize(horizontal));
  }
  // Find the edge to move.
  while (right !== undefined && (!windowCombinedP(right, horizontal) || windowRight(right) === undefined)) right = e8.windowParent(right);
  if (
    right === undefined &&
    !horizontal &&
    (isNil(e8.variable("resize-mini-windows")) || minibufferWindow === activeMinibufferWindow()) &&
    // The minibuffer's window just below it: E8's has no edges of its own.
    e8.conditionCase(() => e8.windowPixelEdges(minibufferWindow)[1] === e8.windowPixelEdges(window)[3], { error: () => false })
  ) {
    windowResizeMiniWindow(minibufferWindow, -delta);
    return;
  }
  let left: e8.Window | undefined = right;
  if (left === undefined || (right = windowRight(left)) === undefined) {
    e8.userError(horizontal ? "No window on the right of this one" : "No window below this one");
  }
  // The first window before the edge that can be resized.
  const firstLeft: e8.Window | undefined = left;
  while (
    left !== undefined &&
    (windowSizeFixedP(left, horizontal) || (delta < 0 && windowSize(left, horizontal, true) <= windowMinSize(left, horizontal, null, true)))
  ) {
    left = stepLeft(left, horizontal);
  }
  if (left === undefined) {
    // One keeping its size must be resized.
    ignore = Symbol.for("preserved");
    left = firstLeft;
    while (
      left !== undefined &&
      (windowSizeFixedP(left, horizontal, ignore) || (delta < 0 && windowSize(left, horizontal, true) <= windowMinSize(left, horizontal, ignore, true)))
    ) {
      left = stepLeft(left, horizontal);
    }
    if (left === undefined) e8.userError(horizontal ? "No resizable window on the left of this one" : "No resizable window above this one");
  }
  // And the first after it.
  const firstRight: e8.Window | undefined = right;
  while (
    right !== undefined &&
    (windowSizeFixedP(right, horizontal) ||
      (delta > 0 && windowSize(right, horizontal, true) <= windowMinSize(right, horizontal, Symbol.for("preserved"), true)))
  ) {
    right = stepRight(right, horizontal);
  }
  if (right === undefined) {
    ignore = Symbol.for("preserved");
    right = firstRight;
    while (
      right !== undefined &&
      (windowSizeFixedP(right, horizontal, ignore) || (delta > 0 && windowSize(right, horizontal, true) <= windowMinSize(right, horizontal, ignore, true)))
    ) {
      right = stepRight(right, horizontal);
    }
    if (right === undefined) e8.userError(horizontal ? "No resizable window on the right of this one" : "No resizable window below this one");
  }
  const l = left!;
  const r = right!;
  if (delta > 0) {
    const maxDelta = windowMaxDelta1(l, 0, horizontal, ignore, "after", false, pixelwise);
    const minDelta = windowMinDelta1(r, -delta, horizontal, ignore, "before", false, pixelwise);
    // As far as it can if not all the way.
    if (maxDelta < delta || minDelta > -delta) delta = Math.min(maxDelta, -minDelta);
    if (delta !== 0) {
      windowResizeReset(frame, horizontal);
      // LEFT grows first.
      const thisDelta = windowResizable_(l, delta, horizontal, ignore, "after", false, false, pixelwise);
      if (thisDelta !== 0) {
        windowResizeThisWindow(
          l,
          thisDelta,
          horizontal,
          ignore,
          true,
          "before",
          horizontal ? windowPixelLeft(l) + e8.windowPixelWidth(l) : windowPixelTop(l) + e8.windowPixelHeight(l),
        );
      }
      // The windows after it shrink.
      windowResizeSiblings(l, delta, horizontal, ignore, "after", horizontal ? windowPixelLeft(r) : windowPixelTop(r));
    }
  } else if (delta < 0) {
    const maxDelta = windowMaxDelta1(r, 0, horizontal, ignore, "before", false, pixelwise);
    const minDelta = windowMinDelta1(l, delta, horizontal, ignore, "after", false, pixelwise);
    if (maxDelta < -delta || minDelta > delta) delta = Math.max(-maxDelta, minDelta);
    if (delta !== 0) {
      windowResizeReset(frame, horizontal);
      // RIGHT grows.
      const thisDelta = windowResizable_(r, -delta, horizontal, ignore, "before", false, false, pixelwise);
      if (thisDelta !== 0) windowResizeThisWindow(r, thisDelta, horizontal, ignore, true, "after", horizontal ? windowPixelLeft(r) : windowPixelTop(r));
      // The windows before it shrink.
      windowResizeSiblings(
        r,
        -delta,
        horizontal,
        ignore,
        "before",
        horizontal ? windowPixelLeft(l) + e8.windowPixelWidth(l) : windowPixelTop(l) + e8.windowPixelHeight(l),
      );
    }
  }
  if (delta !== 0 && windowResizeApplyP(frame, horizontal)) {
    if (e8.windowResizeApply(frame, horizontal)) windowPixelToTotal(frame, horizontal);
    else e8.signal("error", `Failed adjusting window ${String(window)}`);
  }
}
e8.defun("adjust-window-trailing-edge", (window: e8.Window, delta: number, horizontal?: e8.Value, pixelwise?: e8.Value) => {
  adjustWindowTrailingEdge(window ?? undefined, delta, !isNil(horizontal), !isNil(pixelwise));
  return null;
});

/**
 * Makes the selected window `delta` lines taller, or columns wider with
 * `horizontal`, or smaller for a negative one, as enlarge-window: the
 * commands themselves fail when the windows around cannot give that much;
 * called otherwise, it goes as far as it can.
 */
export function enlargeWindow(delta: number, horizontal = false): void {
  const minibufferWindow = e8.minibufferWindow();
  if (windowPreservedSize(undefined, horizontal) !== undefined) windowPreserveSize(undefined, horizontal, null);
  if (delta === 0) return;
  if (windowSizeFixedP(undefined, horizontal)) e8.userError("Selected window has fixed size");
  if (windowMinibufferP(e8.selectedWindow())) {
    if (horizontal) e8.userError("Cannot resize minibuffer window horizontally");
    windowResizeMiniWindow(e8.selectedWindow(), Math.round(delta * frameCharSize(false)));
  } else if (!horizontal && windowFullHeightP() && isNil(e8.variable("resize-mini-windows"))) {
    windowResizeMiniWindow(minibufferWindow, Math.round(-delta * frameCharSize(false)));
  } else if (windowResizableP_(undefined, delta, horizontal)) {
    windowResize(undefined, delta, horizontal);
  } else if (windowResizableP_(undefined, delta, horizontal, Symbol.for("preserved"))) {
    windowResize(undefined, delta, horizontal, Symbol.for("preserved"));
  } else if (e8.thisCommand() === (horizontal ? "enlarge-window-horizontally" : "enlarge-window")) {
    // Only the commands themselves fail, as Emacs keeps it for other callers.
    e8.userError(horizontal ? "Cannot enlarge selected window horizontally" : "Cannot enlarge selected window vertically");
  } else {
    windowResize(undefined, delta > 0 ? windowMaxDelta(undefined, horizontal) : -windowMinDelta(undefined, horizontal), horizontal);
  }
}

/** Makes the selected window `delta` lines shorter, or columns narrower with `horizontal`, as shrink-window. */
export function shrinkWindow(delta: number, horizontal = false): void {
  const minibufferWindow = e8.minibufferWindow();
  if (windowPreservedSize(undefined, horizontal) !== undefined) windowPreserveSize(undefined, horizontal, null);
  if (delta === 0) return;
  if (windowSizeFixedP(undefined, horizontal)) e8.userError("Selected window has fixed size");
  if (windowMinibufferP(e8.selectedWindow())) {
    if (horizontal) e8.userError("Cannot resize minibuffer window horizontally");
    windowResizeMiniWindow(e8.selectedWindow(), Math.round(-delta * frameCharSize(false)));
  } else if (!horizontal && windowFullHeightP() && isNil(e8.variable("resize-mini-windows"))) {
    windowResizeMiniWindow(minibufferWindow, Math.round(delta * frameCharSize(false)));
  } else if (windowResizableP_(undefined, -delta, horizontal)) {
    windowResize(undefined, -delta, horizontal);
  } else if (windowResizableP_(undefined, -delta, horizontal, Symbol.for("preserved"))) {
    windowResize(undefined, -delta, horizontal, Symbol.for("preserved"));
  } else if (e8.thisCommand() === (horizontal ? "shrink-window-horizontally" : "shrink-window")) {
    e8.userError(horizontal ? "Cannot shrink selected window horizontally" : "Cannot shrink selected window vertically");
  } else {
    windowResize(undefined, delta > 0 ? -windowMinDelta(undefined, horizontal) : windowMaxDelta(undefined, horizontal), horizontal);
  }
}

const enlargeWindowCommand = e8.defineCommand({
  name: "enlarge-window",
  doc: "Make the selected window DELTA lines taller, the prefix argument's, or shorter for a negative one, taking them from the windows around.",
  params: [{ name: "delta", kind: "count" }],
  run: (delta: number) => enlargeWindow(delta),
});

e8.defineCommand({
  name: "shrink-window",
  doc: "Make the selected window DELTA lines shorter, the prefix argument's, or taller for a negative one, giving them to the windows around.",
  params: [{ name: "delta", kind: "count" }],
  run: (delta: number) => shrinkWindow(delta),
});

const enlargeWindowHorizontally = e8.defineCommand({
  name: "enlarge-window-horizontally",
  doc: "Make the selected window DELTA columns wider, the prefix argument's, taking them from the windows around.",
  params: [{ name: "delta", kind: "count" }],
  run: (delta: number) => enlargeWindow(delta, true),
});

const shrinkWindowHorizontally = e8.defineCommand({
  name: "shrink-window-horizontally",
  doc: "Make the selected window DELTA columns narrower, the prefix argument's, giving them to the windows around.",
  params: [{ name: "delta", kind: "count" }],
  run: (delta: number) => shrinkWindow(delta, true),
});

/** Makes a window as large as it can be without deleting any, as maximize-window. */
export function maximizeWindow(window: e8.Window = e8.selectedWindow()): void {
  const pixelwise = !isNil(e8.variable("window-resize-pixelwise"));
  windowResize(window, windowMaxDelta(window, false, null, undefined, false, false, pixelwise), false, null, pixelwise);
  windowResize(window, windowMaxDelta(window, true, null, undefined, false, false, pixelwise), true, null, pixelwise);
}
e8.defineCommand({
  name: "maximize-window",
  doc: "Make the selected window as large as it can be without deleting any windows.",
  run: () => maximizeWindow(),
});

/** Makes a window as small as it can be without deleting any, as minimize-window. */
export function minimizeWindow(window: e8.Window = e8.selectedWindow()): void {
  const pixelwise = !isNil(e8.variable("window-resize-pixelwise"));
  windowResize(window, -windowMinDelta(window, false, null, undefined, false, false, pixelwise), false, null, pixelwise);
  windowResize(window, -windowMinDelta(window, true, null, undefined, false, false, pixelwise), true, null, pixelwise);
}
e8.defineCommand({
  name: "minimize-window",
  doc: "Make the selected window as small as it can be without deleting any windows.",
  run: () => minimizeWindow(),
});

// Balancing windows, as window.el's balance-windows and balance-windows-area.

/** Lisp's `/`: whole numbers divided give a whole number, toward zero. */
const lispDivide = (a: number, b: number): number => (Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b);

/**
 * Gives the children of `window`, a combination one above another, or
 * side by side with `horizontal`, new sizes as nearly the same as they
 * can have, as balance-windows-2, then balances their children.
 */
function balanceWindows2(window: e8.Window, horizontal: boolean): void {
  const charSize = isNil(e8.variable("window-resize-pixelwise")) ? frameCharSize(horizontal) : 1;
  const first = windowChild(window)!;
  let numberOfChildren = 0;
  let rest = 0;
  const parentSize = e8.windowNewPixel(window);
  let totalSum = parentSize;
  for (let sub: e8.Window | undefined = first; sub !== undefined; sub = windowRight(sub)) {
    if (windowSizeFixedP(sub, horizontal)) {
      totalSum -= windowSize(sub, horizontal, true);
      setWindowNewNormal(sub, Symbol.for("ignore"));
    } else numberOfChildren++;
  }
  let failed = true;
  while (failed && numberOfChildren > 0) {
    const size = lispDivide(totalSum, numberOfChildren);
    failed = false;
    for (let sub: e8.Window | undefined = first; sub !== undefined && !failed; sub = windowRight(sub)) {
      // Children to be ignored or stuck are left out.
      if (windowResizeChildWindowsSkipP(sub)) continue;
      const subTotal = windowSize(sub, horizontal, true);
      const subDelta = size - subTotal;
      const subAmount = windowSizable(sub, subDelta, horizontal, null, true);
      e8.setWindowNewPixel(sub, subTotal + subAmount);
      if (subAmount !== subDelta) {
        totalSum -= subTotal + subAmount;
        numberOfChildren--;
        // Another round, without this one.
        failed = true;
        setWindowNewNormal(sub, Symbol.for("skip"));
      }
    }
  }
  if (numberOfChildren > 0) {
    rest = totalSum % numberOfChildren;
    // What rounding left over goes a line or column at a time to the
    // children, as window.el asks whether the parent, not each child,
    // is to be skipped.
    for (let sub: e8.Window | undefined = first; sub !== undefined && rest > 0; sub = windowRight(sub)) {
      if (!windowResizeChildWindowsSkipP(window)) {
        e8.setWindowNewPixel(sub, Math.min(rest, charSize), true);
        rest -= charSize;
      }
    }
  }
  // And what is left after that to the stuck ones.
  for (let sub: e8.Window | undefined = first; sub !== undefined && rest > 0; sub = windowRight(sub)) {
    if (!newNormalIs(sub, "ignore")) {
      e8.setWindowNewPixel(sub, Math.min(rest, charSize), true);
      rest -= charSize;
    }
  }
  for (let sub: e8.Window | undefined = first; sub !== undefined; sub = windowRight(sub)) {
    setWindowNewNormal(sub, (newNormalIs(sub, "ignore") ? windowSize(sub, horizontal, true) : e8.windowNewPixel(sub)) / parentSize);
    balanceWindows1(sub, horizontal);
  }
}

/** Balances the children of `window`, and theirs, one above another, or side by side with `horizontal`, as balance-windows-1. */
function balanceWindows1(window: e8.Window, horizontal = false): void {
  let sub = windowChild(window);
  if (sub === undefined) return;
  if (windowCombinedP(sub, horizontal)) {
    balanceWindows2(window, horizontal);
    return;
  }
  const size = e8.windowNewPixel(window);
  for (; sub !== undefined; sub = windowRight(sub)) {
    e8.setWindowNewPixel(sub, size);
    balanceWindows1(sub, horizontal);
  }
}

/**
 * Makes windows one above another the same height and windows side by
 * side the same width, as balance-windows: the windows of a frame's root
 * window, the selected frame's by default, or those within `windowOrFrame`.
 * A window whose size is fixed or kept keeps it.
 */
export function balanceWindows(windowOrFrame?: e8.Window | e8.Frame | null): void {
  let window: e8.Window;
  if (isNil(windowOrFrame) || e8.frameLiveP(windowOrFrame)) window = e8.frameRootWindow((windowOrFrame ?? undefined) as e8.Frame | undefined);
  else if (e8.windowLiveP(windowOrFrame) || (e8.windowValidP(windowOrFrame) && windowChild(windowOrFrame as e8.Window) !== undefined)) {
    window = windowOrFrame as e8.Window;
  } else return e8.signal("error", `Not a window or frame ${String(windowOrFrame)}`);
  const frame = e8.windowFrame(window);
  // Heights.
  windowResizeReset(frame);
  balanceWindows1(window);
  if (windowResizeApplyP(frame)) {
    e8.windowResizeApply(frame);
    windowPixelToTotal(frame);
  }
  // Widths.
  windowResizeReset(frame, true);
  balanceWindows1(window, true);
  if (windowResizeApplyP(frame, true)) {
    e8.windowResizeApply(frame, true);
    windowPixelToTotal(frame, true);
  }
}
// A command and a function cannot share a name, so Lisp's (balance-windows WINDOW-OR-FRAME) is window.ts's balanceWindows.
const balanceWindowsCommand = e8.defineCommand({
  name: "balance-windows",
  doc:
    "Balance the sizes of windows shown on the selected frame.\n\n" +
    "Windows one above another get the same height and windows side by side the same width, " +
    "but for windows whose size is fixed or preserved.",
  run: () => balanceWindows(),
});

/** Whether a window's buffer fixes its size, as window-fixed-size-p: in any direction, or with `direction` "height" or "width" in that one. */
export function windowFixedSizeP(window: e8.Window = e8.selectedWindow(), direction?: "height" | "width"): boolean {
  const fixed = e8.withCurrentBuffer(e8.windowBuffer(window) ?? e8.currentBuffer(), () => e8.variable("window-size-fixed"));
  if (isNil(fixed)) return false;
  return !(direction !== undefined && ((direction === "height" && symName(fixed) === "width") || (direction === "width" && symName(fixed) === "height")));
}
e8.defun("window-fixed-size-p", (window?: e8.Window, direction?: e8.Value) =>
  windowFixedSizeP(window ?? undefined, symName(direction) === "height" ? "height" : symName(direction) === "width" ? "width" : undefined),
);

e8.defineVariable({
  name: "window-area-factor",
  doc: "Factor by which the window area should be over-estimated, as balance-windows-area reads it in each window's buffer.",
  value: 1,
  local: true,
});

/** Moves a window's trailing edge by `delta`, halving it until it can, as balance-windows-area-adjust. */
function balanceWindowsAreaAdjust(window: e8.Window, delta: number, horizontal: boolean, pixelwise: boolean): void {
  while (Math.abs(delta) >= 1) {
    e8.conditionCase(
      () => {
        adjustWindowTrailingEdge(window, delta, horizontal, pixelwise);
        delta = 0;
      },
      {
        error: () => {
          delta = lispDivide(delta, 2);
        },
      },
    );
  }
}

/**
 * Makes the windows of the selected frame about the same area, as
 * balance-windows-area: each in turn moves its edge with the next
 * window's, round and round until nothing changes, scaled by
 * window-area-factor in their buffers. Windows whose buffers fix their
 * size are left as they are.
 */
export function balanceWindowsArea(): void {
  let unchanged = 0;
  let carry = 0;
  // Fixed-size windows are left out.
  const wins = e8.windowList1(e8.selectedWindow(), false).filter((w) => !windowFixedSizeP(w));
  const changelog = new Map<e8.Window, string[]>();
  const pixelwise = !isNil(e8.variable("window-resize-pixelwise"));
  const factor = (w: e8.Window): number => {
    const f = e8.bufferLocalValue("window-area-factor", e8.windowBuffer(w) ?? e8.currentBuffer());
    return typeof f === "number" ? f : 1;
  };
  const nextWindow = (w: e8.Window): e8.Window => e8.windowList1(w, false)[1] ?? w;
  while (unchanged < 2) {
    unchanged++;
    for (const win of wins) {
      let next = win;
      do next = nextWindow(next);
      while (windowFixedSizeP(next));
      const horiz = e8.windowPixelEdges(win)[0] < e8.windowPixelEdges(next)[0];
      const areadiff = lispDivide(
        windowSize(next, false, pixelwise) * windowSize(next, true, pixelwise) * factor(next) -
          windowSize(win, false, pixelwise) * windowSize(win, true, pixelwise) * factor(win),
        Math.max(factor(win), factor(next)),
      );
      const edgesize = horiz
        ? windowSize(win, false, pixelwise) + windowSize(next, false, pixelwise)
        : windowSize(win, true, pixelwise) + windowSize(next, true, pixelwise);
      let diff = lispDivide(areadiff, edgesize);
      // Maybe diff is closer to 1 than to 0.
      if (diff === 0) diff = lispDivide(3 * areadiff, 2 * edgesize);
      if (diff === 0 && areadiff !== 0) {
        diff = lispDivide(areadiff + carry, edgesize);
        // Changing things smoothly.
        if (diff > 1 || diff < -1) diff = lispDivide(diff, 2);
      }
      if (diff === 0) {
        // So that negligible differences do not add up.
        carry += areadiff;
      } else {
        balanceWindowsAreaAdjust(win, diff, horiz, pixelwise);
        // The same change seen before for this window is most likely an
        // endless loop, so it does not count as a change.
        const change = JSON.stringify(e8.windowPixelEdges(win));
        const seen = changelog.get(win) ?? [];
        if (!seen.includes(change)) {
          changelog.set(win, [...seen, change]);
          unchanged = 0;
          carry = 0;
        }
      }
    }
  }
}
e8.defineCommand({
  name: "balance-windows-area",
  doc: "Make all visible windows the same area (approximately).\n\nSee also window-area-factor to change the relative size of specific buffers.",
  run: () => balanceWindowsArea(),
});

// Fitting a window to its buffer, as window.el's fit-window-to-buffer.

e8.defineVariable({
  name: "fit-window-to-buffer-horizontally",
  doc:
    "Non-nil means fit-window-to-buffer can resize windows horizontally.\n" +
    "If this is nil, it never does; if `only', it resizes windows horizontally only; " +
    "any other value means it can resize windows in both dimensions.",
  value: null,
});
e8.defineVariable({
  name: "fit-frame-to-buffer",
  doc: "Non-nil means fit-window-to-buffer can fit a frame to its buffer. E8 does not size frames to their buffers, so a frame's only window is left as it is.",
  value: null,
});

/** A live window, the selected one if none is given, as window-normalize-window with LIVE-ONLY. */
function windowNormalizeLiveWindow(window?: e8.Window | null): e8.Window {
  if (isNil(window)) return e8.selectedWindow();
  if (!e8.windowLiveP(window)) e8.signal("wrong-type-argument", "Wrong type argument: window-live-p", [window as e8.Value]);
  return window as e8.Window;
}

/** A frame's width, or height with the minibuffer's window, in the front end's units, as frame-pixel-width and frame-pixel-height. */
function framePixelSize(frame: e8.Frame | undefined, horizontal: boolean): number {
  const root = e8.frameRootWindow(frame);
  return horizontal ? e8.windowPixelWidth(root) : e8.windowPixelHeight(root) + e8.windowPixelHeight(e8.minibufferWindow());
}

/**
 * The number of screen lines from `beg` to `end` in the current buffer,
 * as count-screen-lines: lines long enough to wrap count each row; a
 * newline at the end is left out unless `countFinalNewline`. Rows are
 * as `window`, the selected one by default, shows them when it shows the
 * current buffer, else the buffer's lines unwrapped.
 */
export function countScreenLines(beg?: number | null, end?: number | null, countFinalNewline = false, window?: e8.Window | null): number {
  const w = isNil(window) ? e8.selectedWindow() : (window as e8.Window);
  const b = beg ?? e8.pointMin();
  const f = end ?? e8.pointMax();
  if (b === f) return 0;
  const start = Math.min(b, f);
  const finish = Math.max(b, f);
  const last = !countFinalNewline && e8.charBefore(finish) === "\n" ? finish - 1 : finish;
  const lineHeight = frameCharSize(false);
  // vertical-motion's rows, from the height of the text they hold.
  if (e8.getBuffer(e8.windowBuffer(w) ?? "") === e8.getBuffer(e8.currentBuffer())) {
    return Math.max(1, Math.round(e8.windowTextPixelSize(w, start, last)[1] / lineHeight));
  }
  return e8.saveRestriction(() => {
    e8.narrowToRegion(start, last);
    return Math.max(1, Math.round(e8.bufferTextPixelSize(e8.bufferName(e8.currentBuffer()))[1] / lineHeight));
  });
}
e8.defun("count-screen-lines", (beg?: number, end?: number, countFinalNewline?: e8.Value, window?: e8.Window) =>
  countScreenLines(beg, end, !isNil(countFinalNewline), window),
);

/** How many screen lines a live window's buffer takes, as window-buffer-height: a newline at its end left out unless point is after it. */
export function windowBufferHeight(window?: e8.Window | null): number {
  const w = windowNormalizeLiveWindow(window);
  return e8.withCurrentBuffer(e8.windowBuffer(w)!, () => Math.max(1, countScreenLines(e8.pointMin(), e8.pointMax(), e8.point() === e8.pointMax(), w)));
}
e8.defun("window-buffer-height", (window?: e8.Window) => windowBufferHeight(window));

/**
 * The end of the last line of a buffer's accessible text that is not
 * blank, as window-text-pixel-size takes a TO of t: before the spaces,
 * tabs and newlines at its end.
 */
function endOfLastNonBlankLine(): number {
  let end = e8.pointMax();
  const min = e8.pointMin();
  while (end > min && " \t\n\r".includes(e8.charBefore(end) ?? "x")) end--;
  return end;
}

/**
 * The height of a window's buffer's text, as fit-window-to-buffer measures
 * it with window-text-pixel-size: from the start of its accessible text to
 * the end of its last line that is not blank, rows wrapped as the window
 * wraps them, its mode line and header line counted, no taller than its
 * frame.
 */
function windowTextHeight(window: e8.Window): number {
  const [from, to] = e8.withCurrentBuffer(e8.windowBuffer(window)!, () => [e8.pointMin(), endOfLastNonBlankLine()]);
  const text = Math.min(e8.windowTextPixelSize(window, from, to)[1], framePixelSize(e8.windowFrame(window), false));
  // What of the window is not text: its mode line and header line, and
  // the room the front end leaves around the text.
  return text + e8.windowPixelHeight(window) - e8.windowBodyPixelHeight(window);
}

/**
 * The width of a window's buffer's text, as fit-window-to-buffer measures
 * it with window-text-pixel-size fitting horizontally: the widest of the
 * lines from the window's start that reach `yLimit` in the front end's
 * units, the line there counted too, no wider than its frame. The lines
 * are measured unwrapped.
 */
function windowTextWidth(window: e8.Window, yLimit: number): number {
  const lines = Math.floor(yLimit / frameCharSize(false)) + 1;
  const buffer = e8.windowBuffer(window)!;
  const start = e8.windowStart(window);
  const width = e8.withCurrentBuffer(buffer, () => {
    let end = e8.lineEndPosition(Math.max(start, e8.pointMin()));
    for (let n = 1; n < lines && end < e8.pointMax(); n++) end = e8.lineEndPosition(end + 1);
    return e8.saveRestriction(() => {
      e8.narrowToRegion(Math.max(start, e8.pointMin()), end);
      return e8.bufferTextPixelSize(buffer)[0];
    });
  });
  return Math.min(width, framePixelSize(e8.windowFrame(window), true));
}

/**
 * Makes a live window, the selected one by default, the size its buffer's
 * text needs, as fit-window-to-buffer. A window one above others gets the
 * height of the buffer's accessible text, as wrapped, its mode line and
 * header line counted, no less than `minHeight` (window-min-height) and no
 * more than `maxHeight` or what the windows around can give, in lines. A
 * window beside others, when fit-window-to-buffer-horizontally is non-nil,
 * gets the width of the widest line from its start down, between
 * `minWidth` (window-min-width) and `maxWidth` columns. With
 * `preserveSize`, it keeps the size it was given (window-preserve-size).
 * Fits by the front end's units when window-resize-pixelwise is non-nil.
 * A window alone on its frame is left as it is, as Emacs leaves it with
 * fit-frame-to-buffer nil.
 */
export function fitWindowToBuffer(
  window?: e8.Window | null,
  maxHeight?: number | null,
  minHeight_?: number | null,
  maxWidth?: number | null,
  minWidth_?: number | null,
  preserveSize = false,
): void {
  const w = windowNormalizeLiveWindow(window);
  const frame = e8.windowFrame(w);
  // Emacs fits the frame to the buffer here when fit-frame-to-buffer is
  // non-nil; E8 does not size frames to buffers.
  if (w === e8.frameRootWindow(frame)) return;
  const pixelwise = !isNil(e8.variable("window-resize-pixelwise"));
  const charHeight = frameCharSize(false);
  const horizontally = e8.variable("fit-window-to-buffer-horizontally");
  // window.el passes `preserved' as window-size-fixed-p's HORIZONTAL here,
  // so a width kept stops the height being fitted, and a height kept not.
  if (symName(horizontally) !== "only" && !windowSizeFixedP(w, true) && windowCombinedP(w)) {
    const lineHeight = charHeight;
    const totalHeight = windowSize(w, false, pixelwise);
    const least =
      typeof minHeight_ === "number"
        ? // No less than window-safe-min-height.
          Math.max(pixelwise ? lineHeight * minHeight_ : minHeight_, pixelwise ? windowSafeMinSize(w, false, true) : windowSafeMinHeight)
        : // Keeping the mode line and header line.
          Math.max(pixelwise ? lineHeight * numberVariable("window-min-height", 4) : numberVariable("window-min-height", 4), windowMinSize(w, false, w, pixelwise));
    const most =
      typeof maxHeight === "number"
        ? Math.min(totalHeight + windowMaxDelta(w, false, w, undefined, true, false, pixelwise), pixelwise ? lineHeight * maxHeight : maxHeight)
        : totalHeight + windowMaxDelta(w, false, w, undefined, true, false, pixelwise);
    let height = windowTextHeight(w);
    if (!pixelwise) height = Math.ceil(height / charHeight);
    height = Math.max(least, Math.min(most, height));
    if (height !== totalHeight) {
      windowPreserveSize(w);
      windowResizeNoError(w, height - totalHeight, false, w, pixelwise);
      if (preserveSize) windowPreserveSize(w, false, true);
    }
  } else if (!isNil(horizontally) && !windowSizeFixedP(w, true, Symbol.for("preserved")) && windowCombinedP(w, true)) {
    const charWidth = frameCharSize(true);
    const totalWidth = windowSize(w, true, pixelwise);
    const least =
      typeof minWidth_ === "number"
        ? // No less than window-safe-min-width.
          Math.max(pixelwise ? charWidth * minWidth_ : minWidth_, pixelwise ? windowSafeMinSize(w, true, true) : windowSafeMinWidth)
        : // window.el asks window-min-size for the height here, not the width.
          Math.max(pixelwise ? charWidth * numberVariable("window-min-width", 10) : numberVariable("window-min-width", 10), windowMinSize(w, false, w, pixelwise));
    const most =
      typeof maxWidth === "number"
        ? Math.min(totalWidth + windowMaxDelta(w, true, w, undefined, true, false, pixelwise), pixelwise ? charWidth * maxWidth : maxWidth)
        : totalWidth + windowMaxDelta(w, true, w, undefined, true, false, pixelwise);
    // The window's start stays where it is, and its height as it is.
    let width =
      windowTextWidth(w, windowBodySize(w, false, pixelwise) * (pixelwise ? 1 : charHeight)) +
      (totalWidth * (pixelwise ? 1 : charWidth) - e8.windowBodyPixelWidth(w));
    if (!pixelwise) width = Math.ceil(width / charWidth);
    width = Math.max(least, Math.min(most, width));
    if (width !== totalWidth) {
      windowPreserveSize(w, true);
      windowResizeNoError(w, width - totalWidth, true, w, pixelwise);
      if (preserveSize) windowPreserveSize(w, true, true);
    }
  }
}
e8.defun(
  "fit-window-to-buffer",
  (window?: e8.Window, maxHeight?: number, minHeight?: number, maxWidth?: number, minWidth?: number, preserveSize?: e8.Value) => {
    fitWindowToBuffer(window, maxHeight, minHeight, maxWidth, minWidth, !isNil(preserveSize));
    return null;
  },
);

/**
 * Shrinks a live window, the selected one by default, to its buffer's
 * text, as shrink-window-if-larger-than-buffer: fit-window-to-buffer no
 * taller than it is, if it is one above others and the start of the
 * current buffer shows in it.
 */
export function shrinkWindowIfLargerThanBuffer(window?: e8.Window | null): void {
  const w = windowNormalizeLiveWindow(window);
  // That point-min shows: the current buffer's, as window.el asks.
  if (windowCombinedP(w) && e8.posVisibleInWindowP(e8.pointMin(), w)) fitWindowToBuffer(w, windowTotalSize(w));
}
// As balance-windows, code passing a window calls shrinkWindowIfLargerThanBuffer.
const shrinkIfLarger = e8.defineCommand({
  name: "shrink-window-if-larger-than-buffer",
  doc:
    "Shrink the selected window to fit its buffer, if the buffer is shorter than the window.\n\n" +
    "The window keeps at least window-min-height lines, and a window alone in its column, " +
    "or whose buffer's start is scrolled out of view, is left as it is.",
  run: () => shrinkWindowIfLargerThanBuffer(),
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
e8.bindKey("C-x ^", enlargeWindowCommand);
e8.bindKey("C-x }", enlargeWindowHorizontally);
e8.bindKey("C-x {", shrinkWindowHorizontally);
e8.bindKey("C-x +", balanceWindowsCommand);
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
