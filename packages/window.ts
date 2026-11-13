// Commands for windows, after Emacs's window.el. The primitives they use,
// window.c's, are in the core: split-window-internal and
// delete-window-internal, selecting windows and applying new sizes.

/**
 * How to undo showing a buffer in a window, as display-buffer-record-window
 * writes the quit-restore window parameter, a list of four as window.el's:
 * `[window, window, SELECTED, BUFFER]` for a window made to show BUFFER,
 * `[frame, frame, ...]` for one on a frame made for it, `[other, [PREVIOUS,
 * START, POINT, SIZE], SELECTED, BUFFER]` for a window that showed the
 * buffer PREVIOUS from START with POINT a marker, SIZE its height, or its
 * width if it was not in a column, and `same` first once BUFFER is shown in
 * it again. The kinds are symbols and the buffers buffer objects; SELECTED
 * is the window selected then.
 */
type QuitRestore = e8.Value[];

function quitRestore(window: e8.Window): QuitRestore | undefined {
  const v = e8.windowParameter(window, "quit-restore");
  return Array.isArray(v) && v.length === 4 ? v : undefined;
}

/** The name of the live buffer a value is, a buffer object or a name; undefined for a killed buffer or anything else. */
const liveBufferName = (v: unknown): string | undefined =>
  typeof v === "string" ? (e8.getBuffer(v) !== undefined ? v : undefined) : typeof v === "object" && v !== null && "live" in v ? (v as e8.Buffer).name : undefined;

/** Whether a quit-restore parameter's buffer, a buffer object or a name, is `buffer`. */
const sameBuffer = (a: unknown, buffer: string | undefined): boolean => buffer !== undefined && liveBufferName(a) === buffer;

/**
 * Sets a window's quit-restore parameter. Emacs keeps the previous
 * buffer's point as a marker, which its collector frees; E8 keeps the
 * position, and quitting takes where the window was in that buffer from
 * its previous buffers, which follow edits as the marker would.
 */
function setQuitRestore(window: e8.Window, value: QuitRestore | null): void {
  e8.setWindowParameter(window, "quit-restore", value);
}

/**
 * Notes in a window's quit-restore parameter how to undo showing `buffer`
 * in it, as display-buffer-record-window: `type` is "reuse" for a window
 * that was there, else "window" or "frame" for one made for the buffer.
 */
function recordWindow(type: "reuse" | "window" | "frame" | "tab", window: e8.Window, buffer: string): void {
  const selected = e8.selectedWindow();
  const object = e8.getBuffer(buffer) ?? buffer;
  if (type !== "reuse") {
    setQuitRestore(window, [Symbol.for(type), Symbol.for(type), selected, object]);
  } else if (e8.windowBuffer(window) === buffer) {
    // It shows the buffer already: say so, and note the window selected now.
    const restore = quitRestore(window);
    if (restore) {
      restore[0] = Symbol.for("same");
      if (window !== selected && window !== restore[2]) restore[2] = selected;
      e8.setWindowParameter(window, "quit-restore", restore);
    }
  } else {
    const shown = e8.windowBuffer(window) ?? "";
    const point = e8.windowPoint(window);
    const size = windowCombinedP(window) ? e8.windowTotalHeight(window) : e8.windowTotalWidth(window);
    setQuitRestore(window, [Symbol.for("other"), [e8.getBuffer(shown) ?? shown, e8.windowStart(window), point, size], selected, object]);
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
// Some of display-buffer's actions still take the live windows an
// internal window holds, a part, where window.el takes the internal window
// itself, and split the smallest window holding them.

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

/** The smallest window holding all of `windows`: the window itself for one, else the internal window that holds them. */
function windowEnclosing(windows: e8.Window[]): e8.Window {
  const chain = (w: e8.Window): e8.Window[] => {
    const out: e8.Window[] = [];
    for (let x: e8.Window | undefined = w; x !== undefined; x = e8.windowParent(x)) out.unshift(x);
    return out;
  };
  const chains = windows.map(chain);
  let common: e8.Window | undefined;
  for (let i = 0; chains.length > 0 && i < chains[0].length && chains.every((c) => c[i] === chains[0][i]); i++) common = chains[0][i];
  return common ?? e8.frameRootWindow();
}

/** Splits a part of the frame, the window holding a set of windows, as split-window does. */
function splitPart(part: e8.Window[], side: "below" | "right" | "above" | "left", size?: number): e8.Window {
  return splitWindow(windowEnclosing(part), size, side);
}

/** Splits a part as split-window-no-error does: undefined where it cannot be. */
const splitPartNoError = (part: e8.Window[], side: "below" | "right" | "above" | "left", size?: number): e8.Window | undefined =>
  e8.conditionCase<e8.Window | undefined>(() => splitPart(part, side, size), { error: () => undefined });

/**
 * Whether a window is at a side of its frame, as window-at-side-p: its
 * left, top, right or bottom edge, the default, that of the frame's root
 * window.
 */
export function windowAtSideP(window: e8.Window = e8.selectedWindow(), side?: string | null): boolean {
  const edge = side === "left" ? 0 : side === "top" ? 1 : side === "right" ? 2 : 3;
  return e8.windowPixelEdges(window)[edge] === e8.windowPixelEdges(e8.frameRootWindow(e8.windowFrame(window)))[edge];
}
e8.defun("window-at-side-p", (window?: e8.Window, side?: e8.Value) => windowAtSideP(window ?? undefined, symName(side)));

/** How far a window is from a row or column it does not cover, as window--in-direction-2. */
function windowInDirection2(window: e8.Window, posn: number, horizontal: boolean): number {
  const [left, top] = e8.windowPixelEdges(window);
  if (horizontal) return top > posn ? top - posn : posn - top - e8.windowPixelHeight(window);
  return left > posn ? left - posn : posn - left - e8.windowPixelWidth(window);
}

/**
 * The window next to one in a direction, as window-in-direction: above
 * (or up), below (or down), left or right of it, the nearest along the
 * row or column its point is on, else the nearest that way. A window
 * whose no-other-window parameter is set is taken only with `ignore`.
 * `sign` negative measures from the window's right or bottom edge rather
 * than its point, positive from its left or top edge; `wrap` goes round
 * the frame's edges, the minibuffer's window lying above the top; and
 * `minibuf` true takes the minibuffer's window even when it is not
 * active, nil only when it is, and anything else never. Undefined if
 * there is none.
 */
export function windowInDirection(
  direction: string,
  window0?: e8.Window | null,
  ignore: unknown = null,
  sign?: number | null,
  wrap: unknown = null,
  minibuf: unknown = null,
): e8.Window | undefined {
  const window = window0 ?? e8.selectedWindow();
  if (!e8.windowLiveP(window)) e8.signal("wrong-type-argument", "Wrong type argument: window-live-p", [window]);
  const dir = direction === "up" ? "above" : direction === "down" ? "below" : direction;
  if (!["above", "below", "left", "right"].includes(dir)) e8.signal("error", `Wrong direction ${direction}`);
  const frame = e8.windowFrame(window);
  const hor = dir === "left" || dir === "right";
  const [wLeft, wTop] = e8.windowPixelEdges(window);
  const first = hor ? wLeft : wTop;
  const last = first + (hor ? e8.windowPixelWidth(window) : e8.windowPixelHeight(window));
  let posn: number;
  if (typeof sign === "number" && sign < 0) {
    posn = hor ? wTop + e8.windowPixelHeight(window) - 1 : wLeft + e8.windowPixelWidth(window) - 1;
  } else if (typeof sign === "number" && sign > 0) {
    posn = hor ? wTop : wLeft;
  } else {
    // posn-at-point's (X . Y), in the front end's units, from the text area.
    const at = e8.posnAtPoint(e8.windowPoint(window), window);
    posn = hor ? (at?.y ?? 1) + wTop : (at?.x ?? 1) + wLeft;
  }
  let bestEdge = dir === "below" ? framePixelSize(frame, false) : dir === "right" ? framePixelSize(frame, true) : -1;
  let bestEdge2 = bestEdge;
  let bestDiff2 = hor ? framePixelSize(frame, false) : framePixelSize(frame, true);
  let best: e8.Window | undefined;
  let best2: e8.Window | undefined;
  const active = activeMinibufferWindow();
  // walk-window-tree with MINIBUF: t always, nil while active, else never.
  const withMini = minibuf === true || (isNil(minibuf) && active !== undefined);
  for (const w of e8.windowList1(e8.frameFirstWindow(frame), withMini, false)) {
    if (w === window || (!isNil(e8.windowParameter(w, "no-other-window")) && isNil(ignore))) continue;
    const [wl, wt] = e8.windowPixelEdges(w);
    const ww = e8.windowPixelWidth(w);
    const wh = e8.windowPixelHeight(w);
    if (hor) {
      if (wt <= posn && posn < wt + wh) {
        if (
          (dir === "left" && ((wl <= first && wl > bestEdge) || (!isNil(wrap) && windowAtSideP(window, "left") && windowAtSideP(w, "right")))) ||
          (dir === "right" && ((wl >= last && wl < bestEdge) || (!isNil(wrap) && windowAtSideP(window, "right") && windowAtSideP(w, "left"))))
        ) {
          bestEdge = wl;
          best = w;
        }
      } else if ((dir === "left" && wl + ww <= first) || (dir === "right" && last <= wl)) {
        const diff = windowInDirection2(w, posn, true);
        if (diff < bestDiff2 || (diff === bestDiff2 && (dir === "left" ? wl > bestEdge2 : wl < bestEdge2))) {
          bestEdge2 = wl;
          bestDiff2 = diff;
          best2 = w;
        }
      }
    } else if (wl <= posn && posn < wl + ww) {
      if (
        (dir === "above" &&
          ((wt <= first && wt > bestEdge) ||
            (!isNil(wrap) && windowAtSideP(window, "top") && (active !== undefined ? w === active : windowAtSideP(w, "bottom"))))) ||
        (dir === "below" &&
          ((wt >= first && wt < bestEdge) ||
            (!isNil(wrap) && (active !== undefined ? window === active : windowAtSideP(window, "bottom")) && windowAtSideP(w, "top"))))
      ) {
        bestEdge = wt;
        best = w;
      }
    } else if ((dir === "above" && wt + wh <= first) || (dir === "below" && last <= wt)) {
      const diff = windowInDirection2(w, posn, false);
      if (diff < bestDiff2 || (diff === bestDiff2 && (dir === "above" ? wt > bestEdge2 : wt < bestEdge2))) {
        bestEdge2 = wt;
        bestDiff2 = diff;
        best2 = w;
      }
    }
  }
  return best ?? best2;
}
e8.defun("window-in-direction", (direction: e8.Value, window?: e8.Window, ignore?: e8.Value, sign?: number, wrap?: e8.Value, minibuf?: e8.Value) =>
  windowInDirection(symName(direction) ?? "", window, ignore, sign, wrap, minibuf) ?? null,
);

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
 * A frame's main window, as window-main-window: its root window if it has
 * no side windows, else the window, live or internal, that is not a side
 * window and has side windows beside it, holding the frame's other windows.
 */
export function windowMainWindow(frame?: e8.Frame): e8.Window {
  let main: e8.Window | undefined;
  walkWindowTree(
    (window) => {
      if (isSide(window)) return;
      const prev = e8.windowPrevSibling(window);
      const next = e8.windowNextSibling(window);
      if ((prev !== undefined && isSide(prev)) || (next !== undefined && isSide(next))) main = window;
    },
    frame,
    true,
  );
  return main ?? e8.frameRootWindow(frame);
}
e8.defun("window-main-window", (frame?: e8.Frame) => windowMainWindow(frame ?? undefined));

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
export function maybeRaiseFrame(frame: e8.Frame | undefined): void {
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
export function windowDisplayBuffer(buffer: e8.BufferLike, window: e8.Window | undefined, type: "reuse" | "window" | "frame" | "tab", alist: Alist = []): e8.Window | undefined {
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
  const made = type === "window" || (symName(restore?.[0]) === "same" && symName(restore?.[1]) === "window");
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
  deleteOtherWindows(window);
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
    addPersistentParameter("window-side");
    e8.setWindowParameter(window, "window-slot", slot);
    addPersistentParameter("window-slot");
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
      addPersistentParameter("window-side");
      e8.setWindowParameter(made, "window-slot", slot);
      addPersistentParameter("window-slot");
      return windowDisplayBuffer(buffer, made, "window", alist);
    }
  }
  if (bestWindow === undefined) return undefined;
  e8.setWindowParameter(bestWindow, "window-slot", slot);
  return windowDisplayBuffer(buffer, bestWindow, "reuse", alist);
});


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

e8.defineVariable({
  name: "switch-to-buffer-obey-display-actions",
  doc: "If non-nil, switch-to-buffer shows the buffer as display-buffer-alist and the other display actions say, as pop-to-buffer-same-window does.",
  value: null,
});

let overrideCount = 0;

/**
 * Has the next command's first display-buffer show its buffer where
 * `preFunction` says, as display-buffer-override-next-command: given the
 * buffer and the alist, it gives [WINDOW, TYPE], TYPE being reuse, window,
 * frame or tab as for window--display-buffer. After that command,
 * `postFunction` is called with the window selected before and the one
 * the buffer went to. Commands in a minibuffer the next command opens
 * neither use nor end it. Gives a function that ends it early.
 */
export function displayBufferOverrideNextCommand(
  preFunction: (buffer: e8.Buffer, alist: Alist) => [e8.Window | undefined, "reuse" | "window" | "frame" | "tab"],
  postFunction?: (oldWindow: e8.Window, newWindow: e8.Window | undefined) => void,
): () => void {
  const oldWindow = e8.minibufferSelectedWindow() ?? e8.selectedWindow();
  let newWindow: e8.Window | undefined;
  const depth = e8.minibufferDepth();
  const obeyDisplay = e8.variable("switch-to-buffer-obey-display-actions") ?? null;
  const command = e8.thisCommand();
  const clear = (): void => {
    e8.setVariable("switch-to-buffer-obey-display-actions", obeyDisplay);
    if (e8.fboundp(action)) e8.fmakunbound(action);
    const overriding = e8.variable("display-buffer-overriding-action");
    if (!Array.isArray(overriding)) return;
    const functions = Array.isArray(overriding[0]) ? overriding[0].filter((f) => f !== action) : overriding[0] === action ? null : (overriding[0] ?? null);
    e8.setVariable("display-buffer-overriding-action", [functions, ...overriding.slice(1)]);
  };
  // An uninterned symbol in Lisp; here a function under a name of its own,
  // which the overriding action holds and clearing takes out and unbinds again.
  const action = e8.defun(`display-buffer-override-next-command--${++overrideCount}`, (buffer: e8.Value, alist: e8.Value) => {
    if (e8.minibufferDepth() > depth) return null;
    const b = e8.getBuffer(buffer as e8.BufferLike)!;
    const list = Array.isArray(alist) ? alist : [];
    const [window, type] = preFunction(b, list);
    newWindow = windowDisplayBuffer(b, window, type, list);
    // Only the first display-buffer is overridden (bug#39722).
    clear();
    return newWindow ?? null;
  });
  const post = (): void => {
    // After the next command, not this one, nor those in its minibuffer (bug#49057).
    if (e8.minibufferDepth() > depth || e8.thisCommand() === command) return;
    exit();
  };
  const exit = (): void => {
    clear();
    e8.removeHook("post-command-hook", post);
    if (postFunction !== undefined) postFunction(oldWindow, newWindow);
  };
  e8.addHook("post-command-hook", post);
  e8.setVariable("switch-to-buffer-obey-display-actions", true);
  const overriding = e8.variable("display-buffer-overriding-action");
  const [functions, ...alist] = Array.isArray(overriding) && overriding.length > 0 ? overriding : [null];
  const list = isNil(functions) ? [] : Array.isArray(functions) ? functions : [functions];
  e8.setVariable("display-buffer-overriding-action", [[action, ...list], ...alist]);
  return exit;
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
    setQuitRestore(window, null);
    e8.conditionCase(() => deleteWindow(window), { error: () => null });
    e8.call("kill-buffer", buffer);
    // As Emacs, delete-window again to show why it could not be deleted.
    if (e8.getBuffer(buffer) === undefined && e8.selectedWindow() === window) deleteWindow();
  },
});

e8.defun("display-buffer-record-window", (type: e8.Value, window: e8.Window, buffer: e8.BufferLike) => {
  recordWindow(symName(type) as "reuse" | "window" | "frame" | "tab", window, e8.bufferName(buffer) ?? "");
  return null;
});

e8.defineVariable({
  name: "frame-auto-hide-function",
  doc:
    "Function called to automatically hide frames.\nThe function is called with one argument - a frame.\n\n" +
    "Functions affected by this option are those that bury a buffer shown in a separate frame like `quit-window' and `bury-buffer'.",
  value: Symbol.for("iconify-frame"),
});
e8.defun("iconify-frame", (frame?: e8.Frame) => (e8.iconifyFrame(frame ?? undefined), null));
// C-z and C-x C-z, after frame.el's suspend-frame.
const suspendFrame = e8.defineCommand({
  name: "suspend-frame",
  doc: "Iconify the selected frame in a window, or in a terminal stop E8 and go back to the shell, as suspend-emacs does.",
  run: () => {
    if (e8.windowSystem() !== undefined) e8.iconifyFrame();
    else e8.call("suspend-emacs");
  },
});
e8.bindKey("C-z", suspendFrame);
e8.bindKey("C-x C-z", suspendFrame);
e8.defun("make-frame-invisible", (frame?: e8.Frame) => (e8.makeFrameInvisible(frame ?? undefined), null));
e8.defineHook("quit-window-hook", "Hook run before performing any other actions in the `quit-window' command.");

/**
 * Deletes a window if it can be, as window--delete: with `dedicatedOnly`,
 * only one dedicated to its buffer. A window window-deletable-p says can
 * go goes with delete-window. The only window of a frame takes its frame
 * with it if its buffer is being killed, else the frame is hidden by its
 * auto-hide-function parameter or frame-auto-hide-function, iconify-frame
 * by default. Gives true when the window went, "frame" when its frame
 * did or was hidden, and false otherwise.
 */
function windowDelete(window0: e8.Window | undefined, dedicatedOnly: boolean, kill: boolean): boolean | "frame" {
  const window = windowNormalizeWindow(window0);
  if (dedicatedOnly && !dedicated(window)) return false;
  const deletable = windowDeletableP(window);
  if (deletable === "frame") {
    const frame = e8.windowFrame(window)!;
    const own = e8.frameParameter(frame, "auto-hide-function");
    if (kill) e8.deleteFrame(frame);
    else if (functionp(own)) fcall(own);
    else if (functionp(e8.variable("frame-auto-hide-function"))) fcall(e8.variable("frame-auto-hide-function"), frame);
    return "frame";
  }
  if (!deletable) return false;
  deleteWindow(window);
  return true;
}
e8.defun("window--delete", (window?: e8.Window, dedicatedOnly?: e8.Value, kill?: e8.Value) => {
  const got = windowDelete(window ?? undefined, !isNil(dedicatedOnly), !isNil(kill));
  return got === "frame" ? Symbol.for("frame") : got || null;
});

/** Selects a window after quitting another, as window--quit-restore-select-window: not an inactive minibuffer window. */
function quitRestoreSelectWindow(window: e8.Value | undefined): void {
  if (e8.windowp(window) && e8.windowLiveP(window) && (window !== e8.minibufferWindow() || e8.minibufferDepth() > 0)) e8.selectWindow(window);
}

/** Shows a buffer in a window from a start and with a point, as set-window-buffer-start-and-point; a dedicated side window stays one. */
export function setWindowBufferStartAndPoint(window: e8.Window, buffer: e8.BufferLike, start?: e8.Value, point?: e8.Value): void {
  const side = symName(e8.windowDedicatedP(window)) === "side";
  e8.setWindowBuffer(window, buffer);
  if (side) e8.setWindowDedicatedP(window, Symbol.for("side"));
  const position = (v: e8.Value | undefined): number | undefined => (typeof v === "number" ? v : v instanceof e8.Marker ? v.position : undefined);
  const size = e8.withCurrentBuffer(buffer, () => e8.bufferSize());
  const s = position(start);
  if (s !== undefined) e8.setWindowStart(window, Math.max(0, Math.min(s, size)));
  const p = position(point);
  if (p !== undefined) e8.setWindowPoint(window, Math.max(0, Math.min(p, size)));
}
e8.defun("set-window-buffer-start-and-point", (window: e8.Window, buffer: e8.BufferLike, start?: e8.Value, point?: e8.Value) => {
  setWindowBufferStartAndPoint(windowNormalizeWindow(window), buffer, start ?? undefined, point ?? undefined);
  return null;
});

/**
 * Quits a window, the selected one by default, as quit-restore-window:
 * as its quit-restore parameter says, deletes it and its frame, deletes
 * it alone, shows the buffer it showed before at its old start and point
 * and with its old size, or shows some other buffer, then selects the
 * window selected when its buffer was shown. A dedicated window is deleted
 * if it can be. `buryOrKill` says what becomes of its buffer: "kill" kills
 * it, "bury" puts it last in the buffer list and forgets it in the window,
 * and "append" moves it to the end of the window's previous buffers.
 */
export function quitRestoreWindow(window0?: e8.Window | null, buryOrKill?: "bury" | "kill" | "append" | null): void {
  const window = windowNormalizeWindow(window0);
  const buffer = e8.windowBuffer(window) ?? "";
  const restore = quitRestore(window);
  const selectedThen = restore?.[2];
  const prevBuffer = e8.windowPrevBuffers(window).find(([b]) => b !== buffer)?.[0];
  const flag = e8.windowDedicatedP(window);
  const kill = buryOrKill === "kill";
  const kind = symName(restore?.[1]);
  const quad = Array.isArray(restore?.[1]) ? (restore[1] as e8.Value[]) : undefined;
  if (!isNil(flag) && symName(flag) !== "side" && windowDelete(window, true, kill)) {
    // A dedicated window, not a side window, went.
    quitRestoreSelectWindow(selectedThen);
  } else if (prevBuffer === undefined && kind === "tab" && sameBuffer(restore?.[3], buffer)) {
    e8.call("tab-bar-close-tab");
    quitRestoreSelectWindow(selectedThen);
  } else if (
    prevBuffer === undefined &&
    // A window made on a frame that was there, now the frame's only one, stays (Bug#12764).
    (kind === "frame" || (kind === "window" && !frameRootWindowP(window))) &&
    sameBuffer(restore?.[3], buffer) &&
    windowDelete(window, false, kill)
  ) {
    quitRestoreSelectWindow(selectedThen);
  } else if (quad !== undefined && liveBufferName(quad[0]) !== undefined && sameBuffer(restore?.[3], buffer)) {
    // Show the buffer it showed before, at its size then if it can have it.
    const size = (): number => (windowCombinedP(window) ? e8.windowTotalHeight(window) : e8.windowTotalWidth(window));
    if (typeof quad[3] === "number" && quad[3] !== size()) {
      e8.conditionCase(() => windowResize(window, (quad[3] as number) - size(), windowCombinedP(window, true)), { error: () => null });
    }
    e8.setWindowDedicatedP(window, null);
    // The start as noted, a number as in Emacs; the point from the window's
    // previous buffers, which follow edits as Emacs's marker does.
    const previous = liveBufferName(quad[0])!;
    const was = e8.windowPrevBuffers(window).find(([b]) => b === previous);
    setWindowBufferStartAndPoint(window, previous, quad[1], was?.[2] ?? quad[2]);
    if (symName(flag) === "side") e8.setWindowDedicatedP(window, Symbol.for("side"));
    const entry = buryOrKill === "append" ? e8.windowPrevBuffers(window).find(([b]) => b === buffer) : undefined;
    if (buryOrKill) {
      e8.setWindowPrevBuffers(window, e8.windowPrevBuffers(window).filter(([b]) => b !== buffer));
      e8.setWindowNextBuffers(window, e8.windowNextBuffers(window).filter((b) => b !== buffer));
    }
    // Last in its previous buffers, where display-buffer-in-previous-window can still find it.
    if (entry) e8.setWindowPrevBuffers(window, [...e8.windowPrevBuffers(window), entry]);
    setQuitRestore(window, null);
    quitRestoreSelectWindow(selectedThen);
  } else {
    setQuitRestore(window, null);
    e8.setWindowDedicatedP(window, null);
    // Delete the window only if no previous buffer can be shown in it (Bug#48367).
    if (e8.switchToPrevBuffer(window, buryOrKill ?? undefined) !== undefined) {
      if (symName(flag) === "side") e8.setWindowDedicatedP(window, Symbol.for("side"));
    } else {
      windowDelete(window, false, kill);
      quitRestoreSelectWindow(selectedThen);
    }
  }
  if (e8.getBuffer(buffer) === undefined) return;
  if (kill) e8.call("kill-buffer", buffer);
  else if (buryOrKill) e8.buryBufferInternal(buffer);
}
e8.defun("quit-restore-window", (window?: e8.Window, buryOrKill?: e8.Value) => {
  quitRestoreWindow(window ?? undefined, (symName(buryOrKill) as "bury" | "kill" | "append" | undefined) ?? null);
  return null;
});

/**
 * Quits a window, the selected one by default, and buries its buffer, or
 * with `kill` kills it, as quit-window: runs quit-window-hook in the
 * window's buffer, then quit-restore-window.
 */
export function quitWindow(kill?: e8.Value, window0?: e8.Window | null): void {
  const window = windowNormalizeWindow(window0);
  e8.withCurrentBuffer(e8.windowBuffer(window) ?? "", () => e8.runHooks("quit-window-hook"));
  quitRestoreWindow(window, isNil(kill) ? "bury" : "kill");
}

e8.defineCommand({
  name: "quit-window",
  doc:
    "Quit WINDOW and bury its buffer.\n\n" +
    "WINDOW must be a live window and defaults to the selected one. With prefix argument KILL non-nil, kill the buffer instead of burying it.\n\n" +
    "This calls quit-restore-window to delete WINDOW or show some other buffer in it, as its quit-restore parameter says: " +
    "a window made for the buffer is deleted, one that showed another buffer shows it again where it was and at its size then. " +
    "The functions in quit-window-hook run before anything else. Code passes a window to window.ts's quitWindow.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill) => quitWindow(kill ?? null),
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

e8.defineVariable({
  name: "minibuffer-scroll-window",
  value: null,
  doc: "The window C-M-v scrolls while the minibuffer is selected, such as the one showing completions; nil for the next window.",
});
e8.defineVariable({
  name: "other-window-scroll-buffer",
  value: null,
  doc: "A buffer for C-M-v to scroll, shown in a window if it is in none; nil for the next window.",
});
e8.defineVariable({
  name: "other-window-scroll-default",
  value: null,
  doc: "A function giving the window C-M-v scrolls when minibuffer-scroll-window and other-window-scroll-buffer do not say; nil for the next window.",
});

/**
 * The window C-M-v scrolls, as other-window-for-scrolling: in the
 * minibuffer, minibuffer-scroll-window; else one showing
 * other-window-scroll-buffer, shown if need be; else what
 * other-window-scroll-default gives; else the next window, on this frame
 * or another visible one.
 */
export function otherWindowForScrolling(): e8.Window {
  const selected = e8.selectedWindow();
  const scrollWindow = e8.variable("minibuffer-scroll-window");
  const scrollBuffer = e8.variable("other-window-scroll-buffer");
  const scrollDefault = e8.variable("other-window-scroll-default");
  let window: e8.Value | undefined;
  if (selected === e8.minibufferWindow() && !isNil(scrollWindow)) window = scrollWindow;
  // A buffer, not a name, as Emacs's BUFFERP asks.
  else if (typeof scrollBuffer === "object" && scrollBuffer !== null && e8.bufferLiveP(scrollBuffer as e8.BufferLike)) {
    window = getBufferWindowList(scrollBuffer as e8.BufferLike)[0] ?? displayBuffer(scrollBuffer as e8.BufferLike, true);
  } else if (typeof scrollDefault === "function" || (typeof scrollDefault === "string" && e8.fboundp(scrollDefault))) {
    window = e8.funcall(scrollDefault as string);
  }
  if (window === undefined) {
    window = nextWindow(selected, sym("lambda"));
    if (window === selected) window = nextWindow(selected, sym("lambda"), sym("visible"));
  }
  if (!e8.windowLiveP(window)) e8.signal("wrong-type-argument", "Not a live window", [sym("window-live-p"), window ?? null]);
  if (window === selected) e8.signal("error", "There is no other window");
  return window as e8.Window;
}
e8.defun("other-window-for-scrolling", () => otherWindowForScrolling());

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
      // No scroll bars in E8, and the divider a window really loses is
      // counted by windowSafeMinSize, not by its frame's parameter.
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
  // A whole number of units, as Emacs's frame-char-size is, so what is shared out adds up.
  const charSize = isNil(e8.variable("window-resize-pixelwise")) ? Math.max(1, Math.floor(frameCharSize(horizontal))) : 1;
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
  // As Emacs, BEG and END may lie outside the narrowing.
  return e8.saveRestriction(() => {
    e8.widen();
    return countScreenLinesWidened(b, f, countFinalNewline, w);
  });
}

function countScreenLinesWidened(b: number, f: number, countFinalNewline: boolean, w: e8.Window): number {
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
  while (end > min && " \t\n".includes(e8.charBefore(end) ?? "x")) end--;
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
  // No further than a frame's height of lines, as Emacs's Y-LIMIT stops it, so a long buffer is not laid out whole.
  const frameHeight = framePixelSize(e8.windowFrame(window), false);
  const lines = Math.ceil(frameHeight / frameCharSize(false)) + 1;
  const [from, to] = e8.withCurrentBuffer(e8.windowBuffer(window)!, () => {
    let limit = e8.pointMin();
    for (let n = 0; n < lines && limit < e8.pointMax(); n++) limit = e8.lineEndPosition(limit) + 1;
    return [e8.pointMin(), Math.min(endOfLastNonBlankLine(), limit)];
  });
  // An empty text is no rows, as Emacs measures it.
  const text = from >= to ? 0 : Math.min(e8.windowTextPixelSize(window, from, to)[1], frameHeight);
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
    // In lines: the lines to add or take for the units the text needs, so
    // a window whose units are not whole lines shows its last line whole.
    if (!pixelwise) height = totalHeight + Math.ceil((height - e8.windowPixelHeight(w)) / charHeight);
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

// Atomic and side windows' checks, splitting and deleting windows, and
// other-window, as window.el has them (ADR 0069, stage 4), on window.c's
// split-window-internal and delete-window-internal. E8's core deletes
// and splits only the selected frame's windows this way: a window on
// another frame is deleted by the core's own deleteWindow, which gives its
// space to a sibling.

e8.defineVariable({
  name: "window--sides-inhibit-check",
  doc: "Non-nil means do not check side windows, as window--sides-check does after splitting and deleting windows.",
  value: null,
});
e8.defineVariable({
  name: "delete-window-choose-selected",
  doc:
    "How to choose a frame's selected window after its selected window is deleted: " +
    "`mru' the most recently used window, `pos' the window at the deleted window's point, nil the frame's first window. " +
    "A window with a no-other-window parameter is chosen only if all the frame's windows have one.",
  value: "mru",
});
e8.defineVariable({
  name: "split-window-keep-point",
  doc: "If non-nil, split-window-below keeps point where it is in both windows; if nil, it moves point so as to scroll less.",
  value: true,
});

/** A window argument as window-normalize-window takes it: the selected window for none, else a window that is live or internal. */
function windowNormalizeWindow(window?: e8.Value | null): e8.Window {
  if (isNil(window)) return e8.selectedWindow();
  if (!e8.windowValidP(window)) e8.signal("wrong-type-argument", "Wrong type argument: window-valid-p", [window as e8.Value]);
  return window as e8.Window;
}

/** Whether a value is a function, or names one, as functionp. */
const functionp = (v: unknown): boolean =>
  typeof v === "function" || ((typeof v === "symbol" || (typeof v === "string" && v !== "")) && e8.fboundp(symName(v)!));

/** Lisp's equal for the values window parameters hold: symbols and strings by name, the rest as data. */
const lispEqual = (a: unknown, b: unknown): boolean => {
  const [x, y] = [symName(a), symName(b)];
  if (x !== undefined || y !== undefined) return x === y;
  return a === b || JSON.stringify(a) === JSON.stringify(b);
};

/** Whether `ignore-window-parameters` is on. */
const ignoringParameters = (): boolean => !isNil(e8.variable("ignore-window-parameters"));

/** Whether a window is its frame's root window, as frame-root-window-p. */
const frameRootWindowP = (window: e8.Window): boolean => window === e8.frameRootWindow(e8.windowFrame(window));

/** Rounds to the nearest whole number, halves to the even one, as Lisp's round. */
const lispRound = (x: number): number => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/**
 * Calls `fn` on the window `window` and what it holds, as
 * walk-window-subtree: its live windows, or with `any` its internal ones
 * too, parents first.
 */
export function walkWindowSubtree(fn: (window: e8.Window) => void, window: e8.Window = e8.selectedWindow(), any = false): void {
  const walk = (w: e8.Window | undefined, subOnly: boolean): void => {
    while (w !== undefined) {
      const live = e8.windowLiveP(w);
      if (live || any) fn(w);
      if (!live) {
        walk(e8.windowLeftChild(w), false);
        walk(e8.windowTopChild(w), false);
      }
      w = subOnly ? undefined : e8.windowNextSibling(w);
    }
  };
  walk(window, true);
}

/**
 * The first window on a frame whose parameter `parameter` is not nil, as
 * window-with-parameter: one whose value is `value` if that is given,
 * live windows only unless `any`.
 */
export function windowWithParameter(parameter: string, value?: e8.Value | null, frame?: e8.Frame, any = false): e8.Window | undefined {
  const found: e8.Window[] = [];
  walkWindowTree(
    (w) => {
      const v = e8.windowParameter(w, parameter);
      if (!isNil(v) && (isNil(value) || lispEqual(value, v))) found.push(w);
    },
    frame,
    any,
  );
  return found[0];
}
e8.defun("window-with-parameter", (parameter: e8.Value, value?: e8.Value, frame?: e8.Frame, any?: e8.Value) =>
  windowWithParameter(symName(parameter) ?? "", value ?? null, frame ?? undefined, !isNil(any)) ?? null,
);

// Atomic windows.

/** The root of the atomic window `window` is part of, as window-atom-root; undefined if it is part of none. */
export function windowAtomRoot(window?: e8.Window | null): e8.Window | undefined {
  let w: e8.Window | undefined = windowNormalizeWindow(window);
  let root: e8.Window | undefined;
  while (w !== undefined && !isNil(e8.windowParameter(w, "window-atom"))) {
    root = w;
    w = e8.windowParent(w);
  }
  return root;
}
e8.defun("window-atom-root", (window?: e8.Window) => windowAtomRoot(window) ?? null);

/** Makes an internal window atomic, as window-make-atom: it and all it holds get a window-atom parameter. */
export function windowMakeAtom(window: e8.Window): e8.Window {
  if (windowChild(window) === undefined) e8.signal("error", `Window ${String(window)} is not an internal window`);
  walkWindowSubtree((w) => {
    if (isNil(e8.windowParameter(w, "window-atom"))) e8.setWindowParameter(w, "window-atom", true);
  }, window, true);
  return window;
}
e8.defun("window-make-atom", (window: e8.Window) => windowMakeAtom(window));

/**
 * Shows a buffer in a new window combined with an existing one into an
 * atomic window, as display-buffer-in-atom-window: the alist's `window`,
 * the selected one by default, and its `side`, below by default, say
 * where. Splitting or deleting a part of an atomic window splits or
 * deletes all of it.
 */
defineAction("display-buffer-in-atom-window", (buffer, alist) =>
  e8.letBind({ "ignore-window-parameters": true, "window-combination-limit": true, "window-combination-resize": "atom" }, () => {
    const given = alistGet(alist, "window");
    const side = symName(alistGet(alist, "side")) ?? "below";
    const atom = e8.windowp(given) ? e8.windowParameter(given, "window-atom") : undefined;
    const window = windowNormalizeWindow(given);
    const root = windowAtomRoot(window);
    const made = splitWindowNoError(window, undefined, side);
    if (made === undefined) return undefined;
    // Rooted at the old root when the window was part of an atomic window, else at the window's new parent.
    windowMakeAtom(root !== undefined && root !== window ? root : e8.windowParent(window)!);
    if (isNil(atom) && e8.windowLiveP(window)) e8.setWindowParameter(window, "window-atom", "main");
    e8.setWindowParameter(made, "window-atom", side);
    return windowDisplayBuffer(buffer, made, "window", alist);
  }),
);

/** Dissolves wrongly made atomic windows from `window` on, as window--atom-check-1. */
function windowAtomCheck1(window: e8.Window | undefined): void {
  for (let w = window; w !== undefined; w = e8.windowNextSibling(w)) {
    if (!isNil(e8.windowParameter(w, "window-atom"))) {
      let count = 0;
      let reset = false;
      walkWindowSubtree((sub) => {
        if (reset) return;
        if (!isNil(e8.windowParameter(sub, "window-atom"))) count++;
        else reset = true;
      }, w, true);
      // One with no other window, or holding one that is not atomic, is no atomic window.
      if (reset || count === 1) walkWindowSubtree((sub) => e8.setWindowParameter(sub, "window-atom", null), w, true);
    } else if (!e8.windowLiveP(w)) {
      windowAtomCheck1(e8.windowLeftChild(w));
      windowAtomCheck1(e8.windowTopChild(w));
    }
  }
}

/** Checks a frame's atomic windows, dissolving any wrongly made, as window--atom-check. */
export function windowAtomCheck(frame?: e8.Frame): void {
  windowAtomCheck1(e8.frameRootWindow(frame));
}

// Side windows' checks.

/** Signals an error if a frame's side windows are not as window.el makes them, as window--sides-check-failed. */
function windowSidesCheckFailed(frame?: e8.Frame): boolean {
  for (const side of SIDES) {
    const window = windowWithParameter("window-side", side, frame, true);
    if (window === undefined) continue;
    const onSide = (w: e8.Window) => symName(e8.windowParameter(w, "window-side")) === side;
    if (e8.windowLiveP(window)) {
      walkWindowTree((t) => {
        if (onSide(t) && t !== window) e8.signal("error", `Window ${String(t)} has same side ${side} as window ${String(window)} but no common parent`);
      }, frame, true);
    } else {
      walkWindowTree((t) => {
        if (e8.windowParent(t) === window) {
          if (!onSide(t)) e8.signal("error", `Window ${String(t)} has not same side ${side} as its parent ${String(window)}`);
        } else if (onSide(t) && t !== window) {
          e8.signal("error", `Window ${String(t)} has same side ${side} as major side window ${String(window)} but its parent is ${String(e8.windowParent(t))}`);
        }
      }, frame, true);
    }
  }
  return false;
}

/**
 * Checks a frame's side windows, as window--sides-check: at most one
 * internal side window on each side, all its children on that side, and
 * no other window on it; else at most one window on the side.
 */
export function windowSidesCheck(frame?: e8.Frame): void {
  if (isNil(e8.variable("window--sides-inhibit-check")) && windowWithParameter("window-side", null, frame, true) !== undefined && windowSidesCheckFailed(frame)) {
    walkWindowTree((w) => e8.setWindowParameter(w, "window-side", null), frame, true);
    e8.message(`Side windows configuration reset for frame ${String(frame ?? e8.selectedFrame())}`);
  }
}

/** Checks a frame's atomic and side windows, as window--check. */
export function windowCheck(frame?: e8.Frame): void {
  windowSidesCheck(frame);
  windowAtomCheck(frame);
}

// Cycling through windows.

/** Whether next-window's MINIBUF counts the minibuffer's window: t always, nil while it is active, anything else never. */
const countsMinibuffer = (minibuf: e8.Value | undefined): boolean => minibuf === true || (isNil(minibuf) && e8.minibufferDepth() > 0);

/** The window after `window` in cyclic order, as next-window, on the frames `allFrames` says. */
export function nextWindow(window: e8.Window = e8.selectedWindow(), minibuf?: e8.Value | null, allFrames?: e8.Value | null): e8.Window {
  return windowsOnFrames(allFrames ?? undefined, window, countsMinibuffer(minibuf ?? undefined))[1] ?? window;
}

/** The window before `window` in cyclic order, as previous-window. */
export function previousWindow(window: e8.Window = e8.selectedWindow(), minibuf?: e8.Value | null, allFrames?: e8.Value | null): e8.Window {
  const list = windowsOnFrames(allFrames ?? undefined, window, countsMinibuffer(minibuf ?? undefined));
  return list.length > 1 ? list[list.length - 1] : window;
}

/**
 * Selects another window, `count` on in cyclic order, or back with a
 * negative count, as other-window: windows with a no-other-window
 * parameter are passed over, and a window's other-window parameter can be
 * a function to call instead with `count` and `allFrames`, which is as
 * next-window's.
 */
export function otherWindow(count: number, allFrames?: e8.Value | null, interactive = false): null {
  let window = e8.selectedWindow();
  const original = window;
  const fn = ignoringParameters() ? undefined : e8.windowParameter(window, "other-window");
  if (functionp(fn)) {
    fcall(fn, count, allFrames ?? null);
    return null;
  }
  let oldWindow: e8.Window | undefined;
  let oldCount = 0;
  const step = (next: (w: e8.Window) => e8.Window, by: number): boolean => {
    window = next(window);
    if (window === oldWindow) {
      // Round the windows without a change: all are passed over.
      if (count === oldCount) return false;
    } else if (!isNil(e8.windowParameter(window, "no-other-window"))) {
      if (oldWindow === undefined) [oldWindow, oldCount] = [window, count];
    } else {
      count += by;
    }
    return true;
  };
  while (count > 0) if (!step((w) => nextWindow(w, null, allFrames), -1)) return null;
  while (count < 0) if (!step((w) => previousWindow(w, null, allFrames), 1)) return null;
  if (window === original && interactive && !e8.executingKbdMacro() && isNil(e8.variable("noninteractive"))) e8.message("No other window to select");
  e8.selectWindow(window);
  return null;
}

/** Whether the selected window is the only one, as one-window-p: the minibuffer's counts while active, unless `nomini`. */
export function oneWindowP(nomini = false, allFrames?: e8.Value | null): boolean {
  let base = e8.selectedWindow();
  if (nomini && base === e8.minibufferWindow()) base = nextWindow(base);
  return base === nextWindow(base, nomini ? "arg" : null, allFrames);
}
e8.defun("one-window-p", (nomini?: e8.Value, allFrames?: e8.Value) => oneWindowP(!isNil(nomini), allFrames ?? null));

const otherWindowCommand = e8.defineCommand({
  name: "other-window",
  doc:
    "Select another window in cyclic ordering of windows.\n\n" +
    "A prefix argument says how many windows on to go; a negative one goes back. Windows with a no-other-window " +
    "parameter are passed over, and the selected window's other-window parameter can be a function to call instead. " +
    "Code passing ALL-FRAMES calls window.ts's otherWindow.",
  params: [{ name: "count", kind: "count" }],
  run: (count) => {
    otherWindow(count, null, e8.calledInteractively());
  },
});

// Deleting windows.

/** The window at frame-relative units `x` and `y`, as window-at-x-y; with `noOther`, none if it has a no-other-window parameter. */
export function windowAtXY(x: number, y: number, frame?: e8.Frame, noOther = false): e8.Window | undefined {
  const [, , rootRight, rootBottom] = e8.windowPixelEdges(e8.frameRootWindow(frame));
  const found: e8.Window[] = [];
  walkWindowTree((w) => {
    const [l, t, r, b] = e8.windowPixelEdges(w);
    if (x >= l && (x < r || x === rootRight) && y >= t && (y < b || y === rootBottom)) found.push(w);
  }, frame);
  const window = found[0];
  return window !== undefined && noOther && !isNil(e8.windowParameter(window, "no-other-window")) ? undefined : window;
}

/**
 * Whether a window can be deleted, as window-deletable-p: true, "frame"
 * for a frame's root window whose frame can go as there are others, or
 * false, as for the minibuffer's window and the frame's main window
 * beside side windows. Part of an atomic window answers for its root.
 */
export function windowDeletableP(window0?: e8.Window | null): boolean | "frame" {
  let window = windowNormalizeWindow(window0);
  if (!(ignoringParameters() || e8.windowParameter(window, "delete-window") === true) && !isNil(e8.windowParameter(window, "window-atom"))) {
    window = windowAtomRoot(window) ?? window;
  }
  const frame = e8.windowFrame(window);
  if (frameRootWindowP(window)) {
    // E8 has one minibuffer for every frame, so no frame holds another's.
    const others = e8.frameList().some((f) => f !== frame && e8.frameVisibleP(f) !== false);
    return others ? "frame" : false;
  }
  if (windowMinibufferP(window)) return false;
  return ignoringParameters() || window !== windowMainWindow(frame);
}
e8.defun("window-deletable-p", (window?: e8.Window) => windowDeletableP(window));

/** Makes a window its frame's selected one, as set-frame-selected-window: selecting it on the selected frame. */
function setFrameSelectedWindow(frame: e8.Frame | undefined, window: e8.Window): void {
  if (frame === undefined || frame === e8.selectedFrame()) e8.selectWindow(window);
}

/**
 * Deletes a window, the selected one by default, as delete-window: its
 * space goes to the sibling before it, or after it if it is the first, or
 * with window-combination-resize t to all its siblings. Its
 * delete-window parameter can be a function to call instead; a part of an
 * atomic window deletes the whole of it; and the last window, a side
 * window's frame's main window or an atomic window filling its frame
 * cannot be deleted. If the frame's selected window goes,
 * delete-window-choose-selected says which is selected next.
 */
export function deleteWindow(window0?: e8.Window | null): unknown {
  const window = windowNormalizeWindow(window0);
  const frame = e8.windowFrame(window);
  const fn = e8.windowParameter(window, "delete-window");
  const parent = e8.windowParent(window);
  windowCheck(frame);
  if (ignoringParameters() || fn === true) {
    // Parameters are not looked at.
  } else if (functionp(fn)) {
    return fcall(fn, window);
  } else if (!isNil(e8.windowParameter(window, "window-atom"))) {
    const atomRoot = windowAtomRoot(window);
    if (atomRoot !== undefined && atomRoot !== window) {
      if (atomRoot === e8.frameRootWindow(frame)) e8.signal("error", "Root of atomic window is root window of its frame");
      return deleteWindow(atomRoot);
    }
  }
  if (parent === undefined) e8.signal("error", "Attempt to delete minibuffer or sole ordinary window");
  if (!(ignoringParameters() || fn === true) && window === windowMainWindow(frame)) e8.signal("error", `Attempt to delete main window of frame ${String(frame)}`);
  if (frame !== e8.selectedFrame()) {
    e8.deleteWindow(window);
    return null;
  }
  const horizontal = e8.windowLeftChild(parent) !== undefined;
  const size = windowSize(window, horizontal, true);
  const resize = e8.variable("window-combination-resize");
  return e8.letBind({ "window-combination-resize": isNil(resize) ? (e8.windowParameter(parent, "window-side") ?? null) : (resize ?? null) }, () => {
    const frameSelectedWindow = e8.frameSelectedWindow(frame)!;
    // Emacs 23 gives the space preferably to the sibling on the left.
    const sibling = windowLeft(window) ?? windowRight(window);
    windowResizeReset(frame, horizontal);
    if (e8.variable("window-combination-resize") !== true && sibling !== undefined && windowSizableP(sibling, size, horizontal, null, true)) {
      windowResizeThisWindow(sibling, size, horizontal, null, true);
      setWindowNewNormal(sibling, e8.windowNormalSize(sibling, horizontal) + e8.windowNormalSize(window, horizontal));
    } else if (windowResizableP_(window, -size, horizontal, null, undefined, false, true, true)) {
      windowResizeSiblings(window, -size, horizontal);
    } else {
      windowResizeSiblings(window, -size, horizontal, true);
    }
    let at: [number, number] | undefined;
    if (symName(e8.variable("delete-window-choose-selected")) === "pos") {
      // Where point is in the selected window, from the frame's top left.
      const [left, top] = e8.windowPixelEdges(frameSelectedWindow);
      const posn = e8.posnAtPoint(e8.windowPoint(frameSelectedWindow), frameSelectedWindow);
      if (posn !== undefined) at = [left + posn.col * frameCharSize(true), top + posn.row * frameCharSize(false)];
    }
    e8.deleteWindowInternal(window);
    windowPixelToTotal(frame, horizontal);
    const choose = symName(e8.variable("delete-window-choose-selected"));
    let chosen: e8.Window | undefined;
    if (e8.windowLiveP(frameSelectedWindow)) {
      // The selected window stays selected.
    } else if (at !== undefined && (chosen = windowAtXY(at[0], at[1], frame, true)) !== undefined) {
      setFrameSelectedWindow(frame, chosen);
    } else if (choose === "mru" && (chosen = getMruWindow(frame, false, false, true)) !== undefined) {
      setFrameSelectedWindow(frame, chosen);
    } else if (!isNil(e8.windowParameter(e8.frameSelectedWindow(frame)!, "no-other-window"))) {
      const other = windowsOnFrames(frame, e8.frameFirstWindow(frame)).find((w) => isNil(e8.windowParameter(w, "no-other-window")));
      setFrameSelectedWindow(frame, other ?? e8.frameSelectedWindow(frame)!);
    } else {
      setFrameSelectedWindow(frame, e8.frameSelectedWindow(frame)!);
    }
    windowCheck(frame);
    return null;
  });
}

/**
 * Makes a window fill its frame, the selected one by default, as
 * delete-other-windows: its delete-other-windows parameter can be a
 * function to call instead, a part of an atomic window makes the whole of
 * it fill the frame, a side window cannot, and windows with a
 * no-delete-other-windows parameter stay, the main window then filling
 * the space within the side windows.
 */
export function deleteOtherWindows(window0?: e8.Window | null, interactive = false): unknown {
  const window = windowNormalizeWindow(window0);
  const frame = e8.windowFrame(window);
  const fn = e8.windowParameter(window, "delete-other-windows");
  let atomRoot: e8.Window | undefined;
  windowCheck(frame);
  if (ignoringParameters() || fn === true) {
    // Parameters are not looked at.
  } else if (functionp(fn)) {
    return fcall(fn, window);
  } else if (!isNil(e8.windowParameter(window, "window-atom")) && (atomRoot = windowAtomRoot(window)) !== undefined && atomRoot !== window) {
    if (atomRoot === e8.frameRootWindow(frame)) e8.signal("error", "Root of atomic window is root window of its frame");
    return deleteOtherWindows(atomRoot);
  } else if (isSide(window)) {
    e8.signal("error", "Cannot make side window the only window");
  } else if (windowMinibufferP(window) && window !== e8.frameRootWindow(frame)) {
    e8.signal("error", "Can't expand minibuffer to full frame");
  }
  let main: e8.Window;
  const noDelete = (w: e8.Window) => !isNil(e8.windowParameter(w, "no-delete-other-windows"));
  if (ignoringParameters() || windowWithParameter("no-delete-other-windows", null, frame) === undefined) {
    main = e8.frameRootWindow(frame);
  } else {
    let all = true;
    walkWindowTree((other) => {
      if ((isSide(other) && !noDelete(other)) || (!isSide(other) && noDelete(other))) all = false;
    }, frame);
    if (all) {
      main = windowMainWindow(frame);
    } else {
      // Window by window, as a deletable side window or a non-side window to keep was found.
      for (const other of windowsOnFrames(frame ?? e8.selectedFrame(), e8.frameFirstWindow(frame))) {
        if (e8.windowLiveP(other) && other !== window && !noDelete(other) && (atomRoot === undefined || windowAtomRoot(other) !== atomRoot)) {
          e8.conditionCase(() => deleteWindow(other), { error: () => null });
        }
      }
      return null;
    }
  }
  if (window === main) {
    if (interactive && !e8.executingKbdMacro() && isNil(e8.variable("noninteractive"))) e8.message("No other windows to delete");
  } else if (frame !== undefined && frame !== e8.selectedFrame()) {
    // The core deletes this way on the selected frame only: on another, window by window.
    for (const other of windowsOnFrames(frame, e8.frameFirstWindow(frame))) {
      if (other !== window && e8.windowLiveP(other) && !within(other, window)) e8.conditionCase(() => e8.deleteWindow(other), { error: () => null });
    }
  } else {
    e8.deleteOtherWindowsInternal(window, main);
    windowCheck(frame);
  }
  return null;
}

/** Deletes the other windows in a window's column, the selected one's by default, as delete-other-windows-vertically. */
export function deleteOtherWindowsVertically(window0?: e8.Window | null): void {
  const window = window0 ?? e8.selectedWindow();
  const [left, , right] = e8.windowEdges(window);
  const delenda: e8.Window[] = [];
  for (let w = nextWindow(window, 1); w !== window; w = nextWindow(w, 1)) {
    const e = e8.windowEdges(w);
    if (e[0] === left && e[2] === right) delenda.unshift(w);
  }
  for (const w of delenda) deleteWindow(w);
}

const deleteWindowCommand = e8.defineCommand({
  name: "delete-window",
  doc:
    "Delete the selected window, giving its space to its neighbours.\n\n" +
    "Its delete-window parameter can be a function to call instead; part of an atomic window deletes the whole of it, " +
    "and the frame's only window or its main window beside side windows cannot be deleted. " +
    "delete-window-choose-selected says which window is selected next. Code deletes another window with window.ts's deleteWindow.",
  run: () => {
    deleteWindow();
  },
});

const deleteOtherWindowsCommand = e8.defineCommand({
  name: "delete-other-windows",
  doc:
    "Make the selected window fill its frame, deleting the others.\n\n" +
    "A window's delete-other-windows parameter can be a function to call instead, windows with a " +
    "no-delete-other-windows parameter stay, part of an atomic window keeps the whole of it, and in a side window this is an error.",
  run: () => {
    deleteOtherWindows(undefined, e8.calledInteractively());
  },
});

e8.defineCommand({
  name: "delete-other-windows-vertically",
  doc: "Delete the windows in the same column as the selected window, but not the window itself.",
  run: () => deleteOtherWindowsVertically(),
});

/**
 * Deletes the windows showing a buffer, the current one by default, as
 * delete-windows-on: on all frames, or as `frame` says, t the selected
 * frame only and otherwise as next-window's ALL-FRAMES. A frame's root
 * window goes with its frame if it is dedicated and there are others,
 * and a window that cannot be deleted shows another buffer. Windows not
 * showing the buffer forget it.
 */
export function deleteWindowsOn(bufferOrName?: e8.BufferLike | null, frame?: e8.Value | null): void {
  const buffer = e8.getBuffer(bufferOrName ?? e8.currentBuffer());
  if (buffer === undefined || !e8.bufferLiveP(buffer)) e8.signal("error", `No such live buffer ${String(bufferOrName)}`);
  const allFrames = isNil(frame) ? true : frame === true ? null : frame;
  for (const window of windowsOnFrames(allFrames ?? undefined, undefined, e8.minibufferDepth() > 0)) {
    if (!e8.windowLiveP(window)) continue;
    if (e8.windowBuffer(window) === buffer.name) {
      const deletable = windowDeletableP(window);
      const flag = e8.windowDedicatedP(window);
      if (deletable === "frame" && !isNil(flag)) {
        e8.deleteFrame(e8.windowFrame(window));
      } else if (deletable === true) {
        deleteWindow(window);
      } else {
        e8.setWindowDedicatedP(window, null);
        e8.switchToPrevBuffer(window, "bury");
        if (symName(flag) === "side") e8.setWindowDedicatedP(window, "side");
      }
    } else if (window !== e8.minibufferWindow()) {
      // As unrecord-window-buffer.
      e8.setWindowPrevBuffers(window, e8.windowPrevBuffers(window).filter(([b]) => b !== buffer.name));
      e8.setWindowNextBuffers(window, e8.windowNextBuffers(window).filter((b) => b !== buffer.name));
    }
  }
}

e8.defineCommand({
  name: "delete-windows-on",
  doc:
    "Delete all windows showing a buffer.\n\n" +
    "With a prefix argument of 0, only windows on visible and iconified frames; with another, only the selected frame's. " +
    "A window that cannot be deleted shows another buffer instead.",
  params: [
    { name: "buffer", kind: "buffer", prompt: "Delete windows on (buffer): " },
    { name: "frame", kind: "prefix" },
  ],
  run: (buffer, prefix) => {
    deleteWindowsOn(buffer, prefix === 0 ? 0 : isNil(prefix) ? null : true);
  },
});

// Splitting windows.

/** How much of a combination's size a new child could take from its children that can be resized, as window--combination-resizable. */
function windowCombinationResizable(parent: e8.Window, horizontal = false): number {
  let number = 0;
  let total = 0;
  for (let sub = windowChild(parent); sub !== undefined; sub = windowRight(sub)) {
    if (!windowSizeFixedP(sub, horizontal)) {
      number++;
      total += windowSize(sub, horizontal, true);
    }
  }
  return lispDivide(total, number + 1);
}

/** The most windows one above another in a window, or side by side with `horizontal`, as window-combinations. */
export function windowCombinations(window: e8.Window, horizontal = false, ignoreFixed = false): number {
  if (e8.windowLiveP(window)) return 1;
  const iso = horizontal ? e8.windowLeftChild(window) : e8.windowTopChild(window);
  let count = iso !== undefined ? 0 : 1;
  for (let child = windowChild(window); child !== undefined; child = windowRight(child)) {
    if (ignoreFixed && windowSizeFixedP(child, horizontal)) continue;
    const n = windowCombinations(child, horizontal, ignoreFixed);
    count = iso !== undefined ? count + n : Math.max(count, n);
  }
  return count;
}
e8.defun("window-combinations", (window?: e8.Window, horizontal?: e8.Value, ignoreFixed?: e8.Value) =>
  windowCombinations(windowNormalizeWindow(window), !isNil(horizontal), !isNil(ignoreFixed)),
);

/**
 * Makes a new window beside a window, the selected one by default, as
 * split-window, and gives it. `size` gives the window that many lines, or
 * columns beside it, or with a negative size the new window; half each by
 * default. `side` is below (nil), above, left or right (t). `pixelwise`
 * takes `size` in the front end's units. window-combination-resize t
 * takes the new window's space from the window's siblings too, and
 * window-combination-limit t always makes a new internal window. Its
 * split-window parameter can be a function to call instead; part of an
 * atomic window splits the whole of it, and a side window is split only
 * with window-combination-resize `side'.
 */
export function splitWindow(window0?: e8.Window | null, size?: number | null, side0?: e8.Value | null, pixelwise = false): e8.Window {
  const window = windowNormalizeWindow(window0);
  const name = symName(side0);
  const side =
    isNil(side0) ? "below"
    : name === "up" ? "above"
    : name === "down" ? "below"
    : name === "below" || name === "above" || name === "right" || name === "left" ? name
    : "right";
  const horizontal = side === "right" || side === "left";
  const frame = e8.windowFrame(window);
  const parent = e8.windowParent(window);
  const fn = e8.windowParameter(window, "split-window");
  const windowSide = e8.windowParameter(window, "window-side");
  let limit = e8.variable("window-combination-limit") ?? null;
  const resizeVar = e8.variable("window-combination-resize") ?? null;
  const charSize = frameCharSize(horizontal);
  const pixelSize = typeof size === "number" ? windowSizeToPixel(window, size, horizontal, pixelwise, true) : undefined;
  const dividerWidth = 0;
  let ignore: unknown = null;
  windowCheck(frame);
  if (ignoringParameters() || fn === true) {
    // Parameters are not looked at.
  } else if (functionp(fn)) {
    return fcall(fn, window, size ?? null, side);
  } else if (!isNil(e8.windowParameter(window, "window-atom"))) {
    const atomRoot = windowAtomRoot(window);
    if (atomRoot !== undefined && atomRoot !== window) return splitWindow(atomRoot, size, side, pixelwise);
  }
  if (!(ignoringParameters() || fn === true)) {
    if (symName(resizeVar) !== "side" && !isNil(windowSide)) {
      e8.signal("error", "Cannot split side window or parent of side window");
    }
    const prev = e8.windowPrevSibling(window);
    const next = e8.windowNextSibling(window);
    if (symName(resizeVar) !== "side" && ((prev !== undefined && isSide(prev)) || (next !== undefined && isSide(next)))) limit = true;
  }
  if (resizeVar === true && pixelSize !== undefined && pixelSize > 0) limit = true;
  const parentPixelSize = parent !== undefined ? windowSize(parent, horizontal, true) : 0;
  // Whether to resize the other windows in the window's combination.
  const resize = !isNil(resizeVar) && (!isNil(windowSide) || symName(resizeVar) !== "side") && limit !== true && windowCombinedP(window, horizontal);
  const oldPixelSize = windowSize(window, horizontal, true);
  let newPixelSize: number;
  if (pixelSize === undefined) {
    newPixelSize = resize
      ? Math.max(
          Math.min(parentPixelSize - windowMinSize(parent!, horizontal, null, true), windowCombinationResizable(parent!, horizontal)),
          windowMinPixelHeight(e8.selectedWindow()),
        )
      : lispDivide(oldPixelSize, 2);
    // Whole units, as Emacs's frame-char-size is, so the two sizes add up.
    if (isNil(e8.variable("window-resize-pixelwise"))) newPixelSize = Math.round(charSize * lispRound(newPixelSize / charSize));
  } else if (pixelSize >= 0) {
    newPixelSize = oldPixelSize - pixelSize;
  } else {
    newPixelSize = -pixelSize;
  }
  const tooSmall = (w: e8.Window) => e8.signal("error", `Window ${String(w)} too small for splitting`);
  const parentSizable = () =>
    windowSizableP(parent!, -(newPixelSize + dividerWidth), horizontal, null, true) ||
    windowSizableP(parent!, -(newPixelSize + dividerWidth), horizontal, (ignore = Symbol.for("preserved")), true);
  const safe = windowSafeMinSize(window, horizontal, true);
  if (pixelSize === undefined) {
    if (resize) {
      if (!parentSizable()) tooSmall(parent!);
    } else if (
      newPixelSize + dividerWidth + windowMinSize(window, horizontal, null, true) > oldPixelSize &&
      newPixelSize + dividerWidth + windowMinSize(window, horizontal, (ignore = Symbol.for("preserved")), true) > oldPixelSize
    ) {
      tooSmall(window);
    }
  } else if (pixelSize >= 0 && (pixelSize >= oldPixelSize || newPixelSize < safe)) {
    tooSmall(window);
  } else if (resize) {
    if (!parentSizable()) tooSmall(parent!);
  } else if (newPixelSize < safe || oldPixelSize - newPixelSize < safe) {
    tooSmall(window);
  }
  windowResizeReset(frame, horizontal);
  // A new internal window, to nest, or as the window is not in a combination this way.
  const newParent = limit === true || !windowCombinedP(window, horizontal);
  const newNormal =
    pixelSize !== undefined ? newPixelSize / (newParent ? oldPixelSize : parentPixelSize)
    : newParent ? 0.5
    : resize ? 1.0 / (1 + windowCombinations(parent!, horizontal, true))
    : e8.windowNormalSize(window, horizontal) / 2.0;
  if (resize) {
    // The space from the window's siblings, which do not go up the tree, as that could not be given back.
    windowResizeChildWindows(parent!, -newPixelSize, horizontal, undefined, ignore);
    const normal = 1.0 - newNormal;
    for (let sub = windowChild(parent!); sub !== undefined; sub = windowRight(sub)) setWindowNewNormal(sub, e8.windowNormalSize(sub, horizontal) * normal);
  } else {
    // All of it from the window.
    e8.setWindowNewPixel(window, oldPixelSize - newPixelSize);
    windowResizeThisWindow(window, -newPixelSize, horizontal, ignore);
    setWindowNewNormal(window, (newParent ? 1.0 : e8.windowNormalSize(window, horizontal)) - newNormal);
  }
  const made = e8.letBind({ "window-combination-limit": limit }, () => e8.splitWindowInternal(window, newPixelSize, side, newNormal));
  windowPixelToTotal(frame, horizontal);
  if (symName(resizeVar) === "side") {
    const newSide = !isNil(windowSide) ? windowSide! : side === "above" ? "top" : side === "below" ? "bottom" : side;
    e8.setWindowParameter(made, "window-side", newSide);
    // Splitting a side root window gives the new parent its side.
    if (newParent && !isNil(e8.windowParameter(window, "window-side"))) e8.setWindowParameter(e8.windowParent(made)!, "window-side", newSide);
  } else if (symName(resizeVar) === "atom") {
    // So window--check keeps an atomic window the new one is nested in.
    if (isNil(e8.windowParameter(window, "window-atom"))) e8.setWindowParameter(window, "window-atom", true);
    if (newParent) e8.setWindowParameter(e8.windowParent(made)!, "window-atom", true);
    e8.setWindowParameter(made, "window-atom", true);
  }
  const minMargins = e8.windowParameter(window, "min-margins");
  if (!isNil(minMargins)) e8.setWindowParameter(made, "min-margins", minMargins!);
  if (size === undefined || size === null) windowSanitizeWindowSizes(horizontal);
  windowCheck(frame);
  return made;
}
e8.defun("split-window", (window?: e8.Window, size?: number, side?: e8.Value, pixelwise?: e8.Value) => splitWindow(window, size, side, !isNil(pixelwise)));

/** Splits a window as split-window does, giving undefined rather than an error where it cannot be, as split-window-no-error. */
export function splitWindowNoError(window?: e8.Window | null, size?: number | null, side?: e8.Value | null, pixelwise = false): e8.Window | undefined {
  return e8.conditionCase<e8.Window | undefined>(() => splitWindow(window, size, side, pixelwise), { error: () => undefined });
}
e8.defun("split-window-no-error", (window?: e8.Window, size?: number, side?: e8.Value, pixelwise?: e8.Value) =>
  splitWindowNoError(window, size, side, !isNil(pixelwise)) ?? null,
);

const verticalMotion = (lines: number): number => e8.verticalMotion(lines);

/**
 * Splits a window, the selected one by default, into two one above the
 * other, as split-window-below, and gives the new one, below. `size` as
 * split-window's; a new window less than window-min-height is refused.
 * With split-window-keep-point nil, splitting the selected window puts
 * the new window's start after the old one's text, so neither scrolls,
 * and selects the new window if point is in its part.
 */
export function splitWindowBelow(size?: number | null, windowToSplit?: e8.Window | null): e8.Window {
  const oldPoint = e8.windowPoint();
  if (typeof size === "number" && size < 0 && -size < numberVariable("window-min-height", 4)) e8.signal("error", "Size of new window too small");
  const made = splitWindow(windowToSplit, size);
  if (isNil(e8.variable("split-window-keep-point")) && (isNil(windowToSplit) || windowToSplit === e8.selectedWindow())) {
    const selected = e8.selectedWindow();
    const height = e8.windowTotalHeight(selected);
    let byHeight = false;
    let bottom = 0;
    e8.saveExcursion(() => {
      e8.gotoChar(e8.windowStart(selected));
      const moved = verticalMotion(height);
      e8.setWindowStart(made, e8.point());
      if (e8.point() > e8.windowPoint(made)) e8.setWindowPoint(made, e8.point());
      if (moved === height) {
        byHeight = true;
        verticalMotion(-1);
      }
      bottom = e8.point();
    });
    if (byHeight && bottom <= e8.point()) e8.setWindowPoint(selected, bottom - 1);
    if (byHeight && e8.windowStart(made) <= oldPoint) {
      e8.setWindowPoint(made, oldPoint);
      e8.selectWindow(made);
    }
  }
  // The new window quits as the old one does.
  const quitRestore = e8.windowParameter(windowToSplit ?? undefined, "quit-restore");
  if (!isNil(quitRestore)) e8.setWindowParameter(made, "quit-restore", quitRestore!);
  return made;
}

/** Splits a window, the selected one by default, into two side by side, as split-window-right, and gives the new one, on the right. */
export function splitWindowRight(size?: number | null, windowToSplit?: e8.Window | null): e8.Window {
  if (typeof size === "number" && size < 0 && -size < numberVariable("window-min-width", 10)) e8.signal("error", "Size of new window too small");
  const made = splitWindow(windowToSplit, size, true);
  const quitRestore = e8.windowParameter(windowToSplit ?? undefined, "quit-restore");
  if (!isNil(quitRestore)) e8.setWindowParameter(made, "quit-restore", quitRestore!);
  return made;
}

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
    "A prefix argument gives the selected window that many lines, or the new one if it is negative. " +
    "With split-window-keep-point nil, point is moved so that neither window scrolls.",
  run: () => {
    splitWindowBelow(splitSize(), e8.selectedWindow());
  },
});

const splitRight = e8.defineCommand({
  name: "split-window-right",
  doc:
    "Split the selected window into two, side by side.\n\n" +
    "The selected window stays on the left and the new one on the right shows the same buffer at the same place. " +
    "A prefix argument gives the selected window that many columns, or the new one if it is negative.",
  run: () => {
    splitWindowRight(splitSize(), e8.selectedWindow());
  },
});

const splitRootBelow = e8.defineCommand({
  name: "split-root-window-below",
  doc:
    "Split the frame's root window in two, the new window below taking the frame's whole width. " +
    "A prefix argument gives the windows above that many lines, or the new one if it is negative.",
  run: () => {
    splitWindowBelow(splitSize(), e8.frameRootWindow());
  },
});

const splitRootRight = e8.defineCommand({
  name: "split-root-window-right",
  doc:
    "Split the frame's root window in two, the new window on the right taking the frame's whole height. " +
    "A prefix argument gives the windows on the left that many columns, or the new one if it is negative.",
  run: () => {
    splitWindowRight(splitSize(), e8.frameRootWindow());
  },
});

// Hiding and showing side windows.

/** Deletes the markers a window state holds, one no longer kept, as Emacs's collector would. */
function freeStateMarkers(v: unknown): void {
  if (v instanceof e8.Marker) e8.deleteMarker(v);
  else if (Array.isArray(v)) v.forEach(freeStateMarkers);
}

/**
 * Hides or shows a frame's side windows, the selected frame's by default,
 * as window-toggle-side-windows: with side windows, keeps the frame's
 * state in its window-state parameter, as window-state-get gives it, and
 * deletes all but the main window; without, puts the state kept there
 * back and the main window's state into its main window.
 */
export function windowToggleSideWindows(frame0?: e8.Frame | null): void {
  const frame = frame0 ?? e8.selectedFrame();
  e8.letBind({ "window--sides-inhibit-check": true }, () => {
    if (windowWithParameter("window-side", null, frame) !== undefined) {
      freeStateMarkers(e8.frameParameter(frame, "window-state"));
      e8.setFrameParameter(frame, "window-state", windowStateGet(e8.frameRootWindow(frame)));
      e8.letBind({ "ignore-window-parameters": true }, () => deleteOtherWindows(windowMainWindow(frame)));
      return;
    }
    const state = e8.frameParameter(frame, "window-state");
    if (!Array.isArray(state) || state.length === 0) e8.signal("error", "No side windows state found");
    e8.letBind({ "window-combination-resize": true }, () => {
      const mainState = windowStateGet(e8.frameRootWindow(frame));
      windowStatePut(state as WindowState, e8.frameRootWindow(frame), true);
      windowStatePut(mainState, windowMainWindow(frame));
      freeStateMarkers(mainState);
    });
  });
}

/** Makes a window parameter one window-state-get keeps, written out too, as display-buffer-in-side-window does with add-to-list. */
function addPersistentParameter(name: string): void {
  const now = e8.variable("window-persistent-parameters");
  const list = Array.isArray(now) ? now : [];
  if (list.some((entry) => Array.isArray(entry) && entry.length === 2 && symName(entry[0]) === name && symName(entry[1]) === "writable")) return;
  e8.setVariable("window-persistent-parameters", [[Symbol.for(name), Symbol.for("writable")], ...list]);
}

e8.defineCommand({
  name: "window-toggle-side-windows",
  doc:
    "Toggle display of side windows on the selected frame.\n\n" +
    "With side windows, they are deleted after the frame's state is kept in its window-state parameter, as window-state-get gives it; " +
    "without, the state kept there is put back, with the main window as it is now.",
  run: () => windowToggleSideWindows(),
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
e8.bindKey("C-x w 2", splitRootBelow);
e8.bindKey("C-x w 3", splitRootRight);
e8.bindKey("C-x 2", splitBelow);
e8.bindKey("C-x 3", splitRight);
e8.bindKey("C-x o", otherWindowCommand);
e8.bindKey("C-x 0", deleteWindowCommand);
e8.bindKey("C-x 1", deleteOtherWindowsCommand);
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
//
// A window state is Lisp data, as window.el's, held as E8 holds Lisp's
// data: a list is an array, an alist entry (KEY . VALUE) is [KEY, VALUE]
// and (KEY . nil) is [KEY], symbols are Symbol.for(name), t is true and nil
// null. So `(window-state-get nil t)` prints with e8.prin1ToString and
// reads back with e8.readFromString, and a state Emacs printed reads as
// one. A state is [HEAD, TYPE, ...ENTRIES]: HEAD the least sizes of the
// window as an alist, TYPE `leaf` for a live window, `vc` for a column
// and `hc` for a row, and ENTRIES its sizes, parameters, buffer and, for an
// internal window, the states of its children, each [TYPE, ...ENTRIES].

/** A window state, as window-state-get gives it. */
export type WindowState = e8.Value[];

e8.defineVariable({
  name: "window-persistent-parameters",
  doc:
    "Alist of persistent window parameters.\n\nEach entry is (PARAMETER . PERSISTENCE): PERSISTENCE t means window-state-get keeps PARAMETER, " +
    "and current-window-configuration does, unless it is asked for a state to write out; `writable' means it is kept in that too.",
  value: [
    [Symbol.for("context"), Symbol.for("writable")],
    [Symbol.for("clone-of"), true],
  ],
});
e8.defineVariable({
  name: "window-restore-killed-buffer-windows",
  doc:
    "What window-state-put and set-window-configuration do with a window whose buffer was killed.\n\n" +
    "nil or `delete' deletes it, `dedicated' deletes it if it was dedicated, t keeps it showing another buffer, " +
    "and a function is called with the frame, a list of (WINDOW BUFFER START POINT DEDICATED nil) for such windows, and `state'.",
  value: null,
});
for (const name of ["window-state-put-list", "window-state-put-stale-windows", "window-state-put-kept-windows", "window-state-put-selected-window"]) {
  e8.defineVariable({ name, doc: "Helper variable for `window-state-put'.", value: null });
}

const sym = (name: string): symbol => Symbol.for(name);
/** An alist entry (KEY . VALUE), as [KEY] when VALUE is nil, as Lisp prints it. */
const cons = (key: string, value: e8.Value | undefined): e8.Value[] => (isNil(value) ? [sym(key)] : [sym(key), value!]);
/** The rest of an alist entry whose value is a list, as (cdr (assq KEY ALIST)) of (KEY A B ...). */
const assqRest = (alist: e8.Value[], key: string): e8.Value[] => assq(alist, key)?.slice(1) ?? [];
/** A number in an alist, as (cdr (assq KEY ALIST)); 0 if it has none. */
const alistNumber = (alist: e8.Value[], key: string): number => {
  const v = alistGet(alist, key);
  return typeof v === "number" ? v : 0;
};
/** Where a state's position is: a number, or a marker's position. */
const statePosition = (v: e8.Value | undefined): number | undefined => (typeof v === "number" ? v : v instanceof e8.Marker ? v.position : undefined);

/** A window's part of its state, as window--state-get-1. */
function windowStateGet1(window: e8.Window, writable: boolean): e8.Value[] {
  const type = e8.windowTopChild(window) !== undefined ? "vc" : e8.windowLeftChild(window) !== undefined ? "hc" : "leaf";
  const live = e8.windowLiveP(window);
  const buffer = live ? e8.windowBuffer(window) : undefined;
  const selected = window === e8.selectedWindow();
  const nextBuffers = live ? e8.windowNextBuffers(window).filter((b) => e8.getBuffer(b) !== undefined) : [];
  const prevBuffers = live ? e8.windowPrevBuffers(window).filter(([b]) => e8.getBuffer(b) !== undefined) : [];
  const head: e8.Value[] = [sym(type)];
  // A frame's root window has the minibuffer's window after it in Emacs, so is not last.
  if (e8.windowNextSibling(window) === undefined && !frameRootWindowP(window)) head.push([sym("last"), true]);
  head.push(
    [sym("pixel-width"), e8.windowPixelWidth(window)],
    [sym("pixel-height"), e8.windowPixelHeight(window)],
    [sym("total-width"), e8.windowTotalWidth(window)],
    [sym("total-height"), e8.windowTotalHeight(window)],
    [sym("normal-height"), e8.windowNormalSize(window)],
    [sym("normal-width"), e8.windowNormalSize(window, true)],
  );
  if (!live) head.push(cons("combination-limit", e8.windowCombinationLimit(window) || null));
  // The parameters window-persistent-parameters keeps: with `writable',
  // only those whose persistence is `writable'.
  const persistent = (Array.isArray(e8.variable("window-persistent-parameters")) ? e8.variable("window-persistent-parameters") : []) as e8.Value[];
  const persistence = (name: string): e8.Value | undefined => {
    const v = alistGet(persistent, name);
    return isNil(v) ? undefined : v;
  };
  const keeps = (name: string): boolean => {
    const pers = persistence(name);
    return pers !== undefined && (!writable || symName(pers) === "writable");
  };
  const parameters: e8.Value[] = [];
  for (const [name, value] of Object.entries(e8.windowParameters(window))) if (keeps(name)) parameters.push(cons(name, value));
  if (keeps("clone-of") && !parameters.some((p) => Array.isArray(p) && symName(p[0]) === "clone-of")) parameters.unshift([sym("clone-of"), window]);
  if (parameters.length > 0) head.push([sym("parameters"), ...parameters]);
  if (buffer !== undefined) {
    const point = e8.windowPoint(window);
    const start = e8.windowStart(window);
    const [leftMargin, rightMargin] = e8.windowMargins(window);
    const fringes = e8.windowFringes(window).map((v) => (v === false ? null : v));
    // E8 has no scroll bar widths, which Emacs says as nil; the kinds
    // are the window's, which are the frame's unless it was told.
    const [, scrollColumns, scrollVertical, , scrollLines, scrollHorizontal, scrollPersistent] = e8.windowScrollBars(window);
    head.push([
      sym("buffer"),
      writable ? buffer : (e8.getBuffer(buffer) ?? buffer),
      cons("selected", selected),
      [sym("hscroll"), e8.windowHscroll(window)],
      [sym("fringes"), ...fringes],
      [sym("margins"), leftMargin ?? null, ...(rightMargin !== undefined ? [rightMargin] : [])],
      // E8 draws no scroll bars, but gives back the kinds the window
      // was told, as window-scroll-bars does.
      [sym("scroll-bars"), null, scrollColumns, scrollVertical, null, scrollLines, scrollHorizontal, scrollPersistent || null],
      [sym("vscroll"), e8.windowVscroll(window)],
      cons("dedicated", e8.windowDedicatedP(window)),
      [
        sym("point"),
        writable
          ? point
          : e8.makeMarker(point, { buffer, advances: !isNil(e8.withCurrentBuffer(buffer, () => e8.variable("window-point-insertion-type"))) }),
      ],
      [sym("start"), writable ? start : e8.makeMarker(start, { buffer })],
    ]);
  }
  if (nextBuffers.length > 0) head.push([sym("next-buffers"), ...(writable ? nextBuffers : nextBuffers.map((b) => e8.getBuffer(b)!))]);
  if (prevBuffers.length > 0) {
    head.push([sym("prev-buffers"), ...prevBuffers.map(([b, start, point]) => [writable ? b : e8.getBuffer(b)!, start, point])]);
  }
  const tail: e8.Value[] = [];
  for (let c = windowChild(window); c !== undefined; c = windowRight(c)) tail.push(windowStateGet1(c, writable));
  return [...head, ...tail];
}

/**
 * The state of a window, the selected frame's root window by default, as
 * window-state-get: its least sizes and, as windowStateGet1 gives them,
 * its sizes, persistent parameters, buffer and children. With `writable`
 * the state can be written out and read back in another session: buffers
 * by name, positions as numbers rather than markers, and only parameters
 * window-persistent-parameters makes `writable'.
 */
export function windowStateGet(window0?: e8.Window | null, writable = false): WindowState {
  let window: e8.Window;
  if (isNil(window0)) window = e8.frameRootWindow();
  else if (e8.windowValidP(window0)) window = window0!;
  else e8.signal("error", `${e8.prin1ToString(window0 as e8.Value)} is not a live or internal window`);
  const min = (horizontal: boolean, ignore: unknown, pixelwise: boolean) => windowMinSize(window, horizontal, ignore, pixelwise);
  const safe = sym("safe");
  return [
    [
      [sym("min-height"), min(false, null, false)],
      [sym("min-width"), min(true, null, false)],
      [sym("min-height-ignore"), min(false, true, false)],
      [sym("min-width-ignore"), min(true, true, false)],
      [sym("min-height-safe"), min(false, safe, false)],
      [sym("min-width-safe"), min(true, safe, false)],
      [sym("min-pixel-height"), min(false, null, true)],
      [sym("min-pixel-width"), min(true, null, true)],
      [sym("min-pixel-height-ignore"), min(false, true, true)],
      [sym("min-pixel-width-ignore"), min(true, true, true)],
      [sym("min-pixel-height-safe"), min(false, safe, true)],
      [sym("min-pixel-width-safe"), min(true, safe, true)],
    ],
    ...windowStateGet1(window, writable),
  ];
}
e8.defun("window-state-get", (window?: e8.Window, writable?: e8.Value) => windowStateGet(window, !isNil(writable)));

/** What window--state-put-1 leaves window--state-put-2 to do: each window with its entries, the last found first. */
let statePutList: [e8.Window, e8.Value[]][] = [];
let statePutStaleWindows: e8.Window[] = [];
let statePutKeptWindows: e8.Value[][] = [];
let statePutSelectedWindow: e8.Window | undefined;

/** Splits a window into the windows a state's part has, as window--state-put-1, noting what each is to hold. */
function windowStatePut1(state: e8.Value[], window: e8.Window | undefined, ignore: unknown, totals: boolean, pixelwise = false): void {
  const type = symName(state[0]);
  const rest = state.slice(1);
  if (type === "leaf") {
    statePutList.unshift([window!, rest]);
    return;
  }
  if (type !== "vc" && type !== "hc") return;
  const horizontal = type === "hc";
  const total = windowSize(window!, horizontal, pixelwise);
  let first = true;
  // A combination inside one of the same kind gets a parent of its own (Bug#50867, Bug#64405).
  let limit: true | null = alistGet(rest, "combination-limit") === true || windowCombinedP(window!, horizontal) ? true : null;
  for (const item of rest) {
    if (!Array.isArray(item) || !["leaf", "vc", "hc"].includes(symName(item[0]) ?? "")) continue;
    let next: e8.Window | undefined;
    if (assq(item, "last") !== undefined) {
      next = undefined;
    } else {
      // The new and final size of the window split, which is safe, as it is resized later.
      let size = totals
        ? alistNumber(item, pixelwise ? (horizontal ? "pixel-width" : "pixel-height") : horizontal ? "total-width" : "total-height")
        : lispRound(total * alistNumber(item, horizontal ? "normal-width" : "normal-height"));
      size = Math.max(size, horizontal ? windowSafeMinWidth * (pixelwise ? frameCharSize(true) : 1) : windowSafeMinHeight * (pixelwise ? frameCharSize(false) : 1));
      if (windowSizableP(window!, -size, horizontal, sym("safe"), pixelwise)) {
        const l = limit;
        next = e8.letBind({ "window-combination-limit": l }, () => splitWindowNoError(window, size, horizontal ? true : null, pixelwise));
        limit = null;
      } else {
        e8.signal("error", `Cannot resize window ${e8.prin1ToString(window!)}`);
      }
      if (first) {
        first = false;
        statePutList.unshift([e8.windowParent(window!)!, rest]);
      }
    }
    // As window.el, the children are put at total sizes, not pixels.
    windowStatePut1(item, window, ignore, totals);
    window = next;
  }
}

/** Gives the windows window--state-put-1 made their parameters, buffers and sizes, as window--state-put-2. */
function windowStatePut2(ignore: unknown, pixelwise: boolean): void {
  for (const [window, item] of statePutList) {
    if (!e8.windowValidP(window)) continue;
    const parameters = assqRest(item, "parameters");
    const state = assq(item, "buffer")?.slice(1);
    const nextBuffers = assqRest(item, "next-buffers");
    const prevBuffers = assqRest(item, "prev-buffers");
    if (!isNil(alistGet(item, "combination-limit"))) e8.setWindowCombinationLimit(window, true);
    for (const name of Object.keys(e8.windowParameters(window))) e8.setWindowParameter(window, name, null);
    for (const p of parameters) {
      if (Array.isArray(p) && p.length > 0) e8.setWindowParameter(window, symName(p[0]) ?? String(p[0]), p.length === 2 ? (p[1] ?? null) : p.length === 1 ? null : p.slice(1));
    }
    if (state === undefined) continue;
    const oldBufferOrName = state[0];
    const name = liveBufferName(oldBufferOrName);
    const s = state.slice(1);
    const dedicatedFlag = isNil(alistGet(s, "dedicated")) ? null : alistGet(s, "dedicated")!;
    if (name !== undefined) {
      e8.withCurrentBuffer(name, () => {
        e8.setWindowBuffer(window, name);
        const hscroll = alistGet(s, "hscroll");
        e8.setWindowHscroll(window, typeof hscroll === "number" ? hscroll : 0);
        const vscroll = alistGet(s, "vscroll");
        const margins = assqRest(s, "margins");
        if (!isNil(margins[0]) || !isNil(margins[1]) || e8.windowMargins(window).some((m) => m !== undefined)) {
          e8.setWindowMargins(window, (margins[0] as number | null) ?? undefined, (margins[1] as number | null) ?? undefined);
        }
        const fixed = symName(e8.variable("window-size-fixed"));
        const adjust = (horizontal: boolean) => {
          if (fixed === "t" || e8.variable("window-size-fixed") === true || fixed === (horizontal ? "width" : "height") || !isNil(windowPreservedSize(window, horizontal))) {
            // A window of fixed size: try to give it its size back.
            const delta =
              alistNumber(item, pixelwise ? (horizontal ? "pixel-width" : "pixel-height") : horizontal ? "total-width" : "total-height") -
              windowSize(window, horizontal, pixelwise);
            e8.letBind({ "window-size-fixed": null }, () => {
              if (windowResizableP_(window, delta, horizontal, null, undefined, false, false, pixelwise)) windowResize(window, delta, horizontal, null, pixelwise);
            });
          } else {
            // Else see that it is not too small.
            const delta = windowMinSize(window, horizontal, ignore, pixelwise) - windowSize(window, horizontal, pixelwise);
            if (delta > 0 && windowResizableP_(window, delta, horizontal, ignore, undefined, false, false, pixelwise)) windowResize(window, delta, horizontal, ignore, pixelwise);
          }
        };
        adjust(false);
        adjust(true);
        e8.setWindowDedicatedP(window, dedicatedFlag);
        const size = e8.bufferSize();
        const start = statePosition(alistGet(s, "start"));
        const point = statePosition(alistGet(s, "point"));
        if (start !== undefined) e8.setWindowStart(window, Math.max(0, Math.min(start, size)));
        if (point !== undefined) e8.setWindowPoint(window, Math.max(0, Math.min(point, size)));
        if (!isNil(alistGet(s, "selected"))) {
          e8.selectWindow(window);
          statePutSelectedWindow = window;
        }
        // Once the start is back, as the vscroll lasts only while it is.
        e8.setWindowVscroll(window, typeof vscroll === "number" ? vscroll : 0);
        e8.setWindowNextBuffers(window, nextBuffers.map(liveBufferName).filter((b): b is string => b !== undefined));
        const prev: [string, number, number][] = [];
        for (const entry of prevBuffers) {
          if (!Array.isArray(entry)) continue;
          const b = liveBufferName(entry[0]);
          if (b !== undefined) prev.push([b, statePosition(entry[1]) ?? 0, statePosition(entry[2]) ?? 0]);
        }
        e8.setWindowPrevBuffers(window, prev);
      });
    } else if (!windowMinibufferP(window)) {
      // Its buffer was killed: preferably show a buffer it showed before.
      e8.switchToPrevBuffer(window);
      const how = e8.variable("window-restore-killed-buffer-windows");
      if (functionp(how)) {
        statePutKeptWindows.unshift([window, oldBufferOrName ?? null, statePosition(alistGet(s, "start")) ?? null, statePosition(alistGet(s, "point")) ?? null, dedicatedFlag, null]);
      } else if ((!isNil(dedicatedFlag) && symName(how) === "dedicated") || isNil(how) || symName(how) === "delete") {
        statePutStaleWindows.unshift(window);
      }
      e8.setWindowDedicatedP(window, null);
    }
  }
}

/** Runs `f` with a buffer of its own current, killed afterwards, as with-temp-buffer. */
function withTempBuffer<T>(f: (name: string) => T): T {
  const name = e8.generateNewBufferName(" *temp*");
  e8.getBufferCreate(name);
  try {
    return e8.withCurrentBuffer(name, () => f(name));
  } finally {
    if (e8.getBuffer(name) !== undefined) e8.call("kill-buffer", name);
  }
}

/**
 * Puts a state window-state-get gave into a window, as window-state-put:
 * a live window is split into the windows the state has, sized as they
 * were if the window is as large as the state's was, else in proportion;
 * an internal window is first made one live window, and with no window
 * the frame's windows are replaced. Each window gets its buffer, start,
 * point, dedication and parameters back, and the window selected then is
 * selected. A window whose buffer was killed is deleted, or kept as
 * window-restore-killed-buffer-windows says. `ignore` non-nil ignores
 * least sizes and fixed sizes, and `safe` lets windows be as small as
 * window-safe-min-height and -width.
 */
export function windowStatePut(state: WindowState, window0?: e8.Window | null, ignore: unknown = null): void {
  statePutStaleWindows = [];
  statePutKeptWindows = [];
  let window: e8.Window;
  if (!isNil(window0) && e8.windowLiveP(window0)) {
    window = window0!;
  } else {
    // Reduce an internal window, or the frame, to one live window, and put a new one in its place.
    const root = isNil(window0) ? undefined : window0!;
    let live: e8.Window | undefined;
    if (root !== undefined) {
      walkWindowSubtree(
        (w) => {
          if (live === undefined && e8.windowLiveP(w) && isNil(e8.windowParameter(w, "window-side"))) live = w;
        },
        root,
      );
    }
    const kept = live ?? e8.selectedWindow();
    e8.deleteOtherWindowsInternal(kept, root);
    const made = splitWindow(kept, windowSafeMinWidth, true);
    deleteWindow(kept);
    window = made;
  }
  e8.setWindowDedicatedP(window, null);
  const frame = e8.windowFrame(window);
  const head = Array.isArray(state[0]) ? (state[0] as e8.Value[]) : [];
  const pixelwise = !isNil(alistGet(state, "pixel-width")) && !isNil(alistGet(state, "pixel-height"));
  const totals =
    (pixelwise && e8.windowPixelWidth(window) === alistGet(state, "pixel-width") && e8.windowPixelHeight(window) === alistGet(state, "pixel-height")) ||
    (e8.windowTotalWidth(window) === alistGet(state, "total-width") && e8.windowTotalHeight(window) === alistGet(state, "total-height"));
  let minHeight = alistNumber(head, pixelwise ? "min-pixel-height" : "min-height");
  let minWidth = alistNumber(head, pixelwise ? "min-pixel-width" : "min-width");
  const tooSmall = () => minHeight > windowSize(window, false, pixelwise) || minWidth > windowSize(window, true, pixelwise);
  e8.letBind({ "window-combination-limit": null, "window-combination-resize": null }, () => {
    if (
      !totals &&
      tooSmall() &&
      (isNil(ignore) ||
        ((minHeight = alistNumber(head, pixelwise ? "min-pixel-height-ignore" : "min-height-ignore")),
        (minWidth = alistNumber(head, pixelwise ? "min-pixel-width-ignore" : "min-width-ignore")),
        tooSmall() &&
          (symName(ignore) !== "safe" ||
            ((minHeight = alistNumber(head, pixelwise ? "min-pixel-height-safe" : "min-height-safe")),
            (minWidth = alistNumber(head, pixelwise ? "min-pixel-width-safe" : "min-width-safe")),
            tooSmall()))))
    ) {
      e8.signal("error", `Window ${e8.prin1ToString(window)} too small to accommodate state`);
    }
    statePutList = [];
    statePutSelectedWindow = undefined;
    // On a buffer of its own, so no buffer's window-size-fixed stops the splitting.
    withTempBuffer((temp) => {
      e8.setWindowBuffer(window, temp);
      windowStatePut1(state.slice(1), window, null, totals, pixelwise);
      windowStatePut2(ignore, pixelwise);
    });
    statePutList = [];
    if (statePutSelectedWindow !== undefined && e8.windowLiveP(statePutSelectedWindow)) e8.selectWindow(statePutSelectedWindow);
    while (statePutStaleWindows.length > 0) {
      const stale = statePutStaleWindows.shift()!;
      if (e8.windowValidP(stale) && windowDeletableP(stale) === true) deleteWindow(stale);
    }
    const how = e8.variable("window-restore-killed-buffer-windows");
    if (functionp(how)) {
      fcall(how, frame, statePutKeptWindows, sym("state"));
      statePutKeptWindows = [];
    }
    windowCheck(frame);
  });
}
e8.defun("window-state-put", (state: e8.Value, window?: e8.Window, ignore?: e8.Value) => {
  if (!Array.isArray(state)) e8.signal("wrong-type-argument", "Wrong type argument: listp", [state]);
  windowStatePut(state as WindowState, window, ignore ?? null);
  return null;
});

/** The buffers a window state shows, as window-state-buffers. */
export function windowStateBuffers(state: e8.Value[]): e8.Value[] {
  const buffer = assq(state, "buffer")?.[1];
  const items = Array.isArray(state[0]) ? state.slice(2) : state.slice(1);
  const buffers = items.flatMap((item) =>
    Array.isArray(item) && ["leaf", "vc", "hc"].includes(symName(item[0]) ?? "") ? windowStateBuffers(item) : [],
  );
  return buffer !== undefined ? [buffer, ...buffers] : buffers;
}
e8.defun("window-state-buffers", (state: e8.Value) => windowStateBuffers(Array.isArray(state) ? state : []));

/**
 * Swaps the states of two live windows, as window-swap-states: the
 * selected window and the next one by default. `size` `height`, `width`
 * or t swaps their heights, widths or both, as far as they can be.
 */
export function windowSwapStates(window10?: e8.Window | null, window20?: e8.Window | null, size: e8.Value = null): void {
  const window1 = windowNormalizeWindow(window10);
  if (!e8.windowLiveP(window1)) e8.signal("error", `${e8.prin1ToString(window1)} is not a live window`);
  let window2: e8.Window;
  if (!isNil(window20)) {
    if (!e8.windowLiveP(window20)) e8.signal("error", `${e8.prin1ToString(window20 as e8.Value)} is not a live window`);
    window2 = window20!;
  } else {
    window2 = nextWindow(window1, sym("nomini"), sym("visible"));
  }
  if (window1 === window2) return;
  const height = size === true || symName(size) === "height";
  const width = size === true || symName(size) === "width";
  const state1 = windowStateGet(window1);
  const width1 = width ? e8.windowBodyPixelWidth(window1) : 0;
  const height1 = height ? e8.windowBodyPixelHeight(window1) : 0;
  const state2 = windowStateGet(window2);
  const width2 = width ? e8.windowBodyPixelWidth(window2) : 0;
  const height2 = height ? e8.windowBodyPixelHeight(window2) : 0;
  windowStatePut(state1, window2, true);
  windowStatePut(state2, window1, true);
  // Overlays shown in one window only follow it.
  const swapOverlays = (buffer: string) =>
    e8.withCurrentBuffer(buffer, () => {
      for (const overlay of e8.overlaysIn(0, e8.bufferSize())) {
        const w = e8.overlayGet(overlay, "window");
        if (w === window1) e8.overlayPut(overlay, "window", window2);
        else if (w === window2) e8.overlayPut(overlay, "window", window1);
      }
    });
  swapOverlays(e8.windowBuffer(window1)!);
  if (e8.windowBuffer(window1) !== e8.windowBuffer(window2)) swapOverlays(e8.windowBuffer(window2)!);
  if (isNil(size)) return;
  let old: number;
  if (width) {
    if ((old = e8.windowBodyPixelWidth(window1)) !== width2) windowResizeNoError(window1, width2 - old, true, true, true);
    if ((old = e8.windowBodyPixelWidth(window2)) !== width1) {
      const preserved = windowPreservedSize(window1, true);
      windowPreserveSize(window1, true, true);
      windowResizeNoError(window2, width1 - old, true, true, true);
      windowPreserveSize(window1, true, preserved ?? null);
    }
  }
  if (height) {
    if ((old = e8.windowBodyPixelHeight(window1)) !== height2) windowResizeNoError(window1, height2 - old, false, true, true);
    if ((old = e8.windowBodyPixelHeight(window2)) !== height1) {
      const preserved = windowPreservedSize(window1);
      windowPreserveSize(window1, false, true);
      windowResizeNoError(window2, height1 - old, false, true, true);
      windowPreserveSize(window1, false, preserved ?? null);
    }
  }
}

e8.defineCommand({
  name: "window-swap-states",
  doc:
    "Swap the states of live windows WINDOW-1 and WINDOW-2.\n\n" +
    "Interactively, the selected window and the window following it in the cyclic ordering of windows on visible frames, " +
    "each taking the other's buffer, start, point and parameters. Code passes the windows and SIZE (height, width or t, " +
    "to swap their sizes too) to window.ts's windowSwapStates.",
  run: () => windowSwapStates(),
});

// window-configuration-change-hook: run after a command that changed which
// windows the selected frame has or which buffers they show, where Emacs
// runs it as redisplay finds the change.
e8.defineHook("window-configuration-change-hook", "Functions called after the selected frame's windows, or the buffers they show, change.");
// Taken as window.ts loads, so the first command that changes them runs it.
const windowsNow = (): string => e8.windowList().map((w) => `${w}:${e8.windowBuffer(w)}`).join(" ");
let lastConfiguration = windowsNow();
e8.addHook("post-command-hook", () => {
  const now = windowsNow();
  if (now === lastConfiguration) return;
  lastConfiguration = now;
  e8.runHooks("window-configuration-change-hook");
});
