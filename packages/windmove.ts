// Moving between windows by direction, after Emacs's windmove.el: S-<left>
// and the rest once windmove-default-keybindings binds them, selecting,
// displaying a buffer in, deleting and swapping with the window that way,
// found by window.el's window-in-direction (window.ts). Preloaded, as
// Emacs autoloads its commands; windmove-mode, turned on as they are
// first bound, holds the keys the *-default-keybindings functions bind.

import { keyBinding } from "help";
import { windowInDirection, splitWindow, deleteWindow, displayBufferOverrideNextCommand, maybeRaiseFrame, alistGet } from "window";

e8.defineVariable({
  name: "windmove-wrap-around",
  doc:
    "Whether moving off the edge of the frame wraps around: left from the leftmost window finds the rightmost one, " +
    "and so on. The minibuffer's window is skipped moving up or down unless it is active.",
  value: null,
});
e8.defineVariable({
  name: "windmove-create-window",
  doc:
    "Whether moving off the edge of the frame makes a new window that way. It can be a function, given the " +
    "direction, the prefix argument and the selected window, giving the window to select or the symbol no-select.",
  value: null,
});
e8.defineVariable({
  name: "windmove-window-distance-delta",
  doc: "No longer used, as in Emacs since 27.1.",
  value: 1,
});
e8.defineVariable({
  name: "windmove-allow-all-windows",
  doc: "Whether the windmove commands may go to windows whose no-other-window parameter is set.",
  value: null,
});
e8.defineVariable({
  name: "windmove-display-no-select",
  doc:
    "Whether windmove-display-left and the rest leave the window the buffer goes to unselected: nil selects it, " +
    "ignore selects neither and leaves it to the next command, anything else selects the window selected before. " +
    "A prefix argument of C-u reverses it.",
  value: null,
});

const nil = (v: unknown): boolean => v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0);
const symName = (v: unknown): string | undefined => (typeof v === "symbol" ? v.description : typeof v === "string" ? v : undefined);
const prefixValue = (arg: e8.PrefixArg | undefined): number | undefined => (arg === null || arg === undefined ? undefined : e8.prefixNumericValue(arg));
/** Whether a window is the minibuffer's and no minibuffer is open, as (and (window-minibuffer-p W) (not (minibuffer-window-active-p W))). */
const inactiveMinibuffer = (w: e8.Window): boolean => w === e8.minibufferWindow() && e8.minibufferDepth() === 0;
/** Whether a value is a function, or names one, as functionp. */
const functionp = (v: unknown): boolean =>
  typeof v === "function" || ((typeof v === "symbol" || (typeof v === "string" && v !== "")) && e8.fboundp(symName(v)!));
/** window.el's directions for split-window's side: up and down are above and below. */
const splitSide = (dir: string): string => (dir === "up" ? "above" : dir === "down" ? "below" : dir);

/**
 * The window in a direction from a window, the selected one by default,
 * as windmove-find-other-window: `arg` negative measures from its right
 * or bottom edge, positive from its left or top edge, else from point;
 * windmove-wrap-around and windmove-allow-all-windows apply.
 */
export function windmoveFindOtherWindow(dir: string, arg?: number | null, window?: e8.Window | null): e8.Window | undefined {
  return windowInDirection(dir, window, e8.variable("windmove-allow-all-windows"), arg, e8.variable("windmove-wrap-around"), true);
}
e8.defun("windmove-find-other-window", (dir: e8.Value, arg?: number, window?: e8.Window) => windmoveFindOtherWindow(symName(dir) ?? "", arg, window) ?? null);

/**
 * Selects the window in a direction, as windmove-do-window-select,
 * making one with windmove-create-window if there is none, and signalling
 * a user error if there is still none.
 */
export function windmoveDoWindowSelect(dir: string, arg?: number | null, window?: e8.Window | null): void {
  let other: e8.Window | symbol | undefined = windmoveFindOtherWindow(dir, arg, window);
  const create = e8.variable("windmove-create-window");
  if (!nil(create) && (other === undefined || inactiveMinibuffer(other as e8.Window))) {
    if (!functionp(create)) {
      other = splitWindow(window, null, splitSide(dir));
    } else {
      const got = e8.funcall(create as string, Symbol.for(dir), arg ?? null, window ?? null);
      other = e8.windowp(got) ? got : symName(got) === "no-select" ? Symbol.for("no-select") : undefined;
    }
  }
  if (other === undefined) e8.userError(`No window ${dir} from selected window`);
  if (typeof other === "symbol") return;
  if (inactiveMinibuffer(other)) e8.userError("Minibuffer is inactive");
  e8.selectWindow(other);
}
e8.defun("windmove-do-window-select", (dir: e8.Value, arg?: number, window?: e8.Window) => {
  windmoveDoWindowSelect(symName(dir) ?? "", arg, window);
  return null;
});

const DIRECTIONS = ["left", "right", "up", "down"] as const;
const WHERE: Record<string, string> = { left: "to the left of", right: "to the right of", up: "above", down: "below" };
const EDGE: Record<string, string> = { left: "top edge (for positive ARG) or the bottom edge", right: "top edge (for positive ARG) or the bottom edge", up: "left edge (for positive ARG) or the right edge", down: "left edge (for positive ARG) or the right edge" };

for (const dir of DIRECTIONS) {
  e8.defineCommand({
    name: `windmove-${dir}`,
    doc:
      `Select the window ${WHERE[dir]} the current one.\n\n` +
      `With no prefix argument, or a prefix argument of zero, "${dir}" is from point in the window; otherwise from the ` +
      `${EDGE[dir]} (for negative ARG) of the window. With no window there, a user error, unless windmove-create-window makes one.`,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.PrefixArg) => windmoveDoWindowSelect(dir, prefixValue(arg)),
  });
}

// windmove-mode, whose keymap holds the keys the functions below bind.

let windmoveLoaded = false;
e8.defineMinorMode({
  name: "windmove-mode",
  global: true,
  doc: "Global minor mode for the windmove commands' keys, which windmove-default-keybindings and its kin bind in windmove-mode-map.",
  onChange: () => {
    windmoveLoaded = true;
  },
});
// On from the start in Emacs, where windmove.el loads only when one of its
// commands is first used: preloaded here, it turns on when its keys are
// first bound, so it shows among the modes that are on only once in use,
// and stays off after that if it is turned off, as in Emacs.
function windmoveLoad(): void {
  if (windmoveLoaded) return;
  windmoveLoaded = true;
  if (nil(e8.variable("windmove-mode"))) e8.call("windmove-mode");
}

/** A modifier's prefix in a key's description, as Emacs writes them. */
const MODIFIER: Record<string, string> = { alt: "A-", control: "C-", hyper: "H-", meta: "M-", shift: "S-", super: "s-" };
const MODIFIER_ORDER = ["alt", "control", "hyper", "meta", "shift", "super"];

/** A key's description from modifiers and a key, as (vector (append MODIFIERS KEY)) reads: ["shift"] and "left" are S-<left>. */
function keyWith(modifiers: string[], key: string): string {
  const mods = MODIFIER_ORDER.filter((m) => modifiers.includes(m))
    .map((m) => MODIFIER[m])
    .join("");
  return mods + (key.length === 1 ? key : `<${key}>`);
}

/** Modifiers as the *-default-keybindings functions take them: one, a list, or none for bare keys. */
function modifierList(modifiers: e8.Value | undefined, otherwise: string[]): string[] {
  if (nil(modifiers)) return otherwise;
  if (symName(modifiers) === "none") return [];
  return (Array.isArray(modifiers) ? modifiers : [modifiers]).map((m) => symName(m) ?? "");
}

/**
 * Binds keys in windmove-mode-map as windmove-install-defaults does: each
 * [COMMAND, KEY] of `alist` on `prefix` then the modifiers and KEY,
 * after taking away the keys the command had there. With `uninstall`,
 * only takes them away.
 */
export function windmoveInstallDefaults(prefix: string | undefined, modifiers: string[], alist: [string, string][], uninstall = false): void {
  const map = "windmove-mode-map";
  windmoveLoad();
  for (const [command, key] of alist) {
    for (const [old, bound] of e8.keymapBindings(map)) if (bound === command) e8.keymapUnset(map, old, true);
    if (uninstall) continue;
    // E8's keys have no alt, hyper or super modifier, so those bind nothing.
    if (modifiers.some((m) => m === "alt" || m === "hyper" || m === "super")) {
      e8.message(`Warning (emacs): ${command} not bound: E8's keys have no ${modifiers.filter((m) => ["alt", "hyper", "super"].includes(m)).join(" or ")} modifier`);
      continue;
    }
    const keys = (prefix ? `${prefix} ` : "") + keyWith(modifiers, key);
    const bound = keyBinding(keys) ?? ([...keys].length === 1 ? "self-insert-command" : undefined);
    if (bound === "self-insert-command") e8.message(`Warning (emacs): Command ${command} is shadowing self-insert-key`);
    const oldFn = e8.lookupKey(map, keys);
    if (typeof oldFn === "string") e8.message(`Warning (emacs): Overriding ${oldFn} with ${command}`);
    e8.defineKey(map, keys, command as e8.CommandName);
  }
}

const MOVE: [string, string][] = DIRECTIONS.map((d) => [`windmove-${d}`, d]);
const DISPLAY: [string, string][] = [
  ...DIRECTIONS.map((d): [string, string] => [`windmove-display-${d}`, d]),
  ["windmove-display-same-window", "0"],
  ["windmove-display-new-frame", "f"],
  ["windmove-display-new-tab", "t"],
];
const DELETE: [string, string][] = DIRECTIONS.map((d) => [`windmove-delete-${d}`, d]);
const SWAP: [string, string][] = DIRECTIONS.map((d) => [`windmove-swap-states-${d}`, d]);

/**
 * Binds MODIFIERS-<left> and the rest to windmove-left and the rest, as
 * windmove-default-keybindings: a modifier or a list of them, shift by
 * default, or none for the bare keys. The commands of this name and its
 * kin bind the default keys; init.ts imports these to pass others.
 */
export function windmoveDefaultKeybindings(modifiers?: e8.Value): void {
  windmoveInstallDefaults(undefined, modifierList(modifiers, ["shift"]), MOVE);
}
e8.defineCommand({
  name: "windmove-default-keybindings",
  doc:
    "Bind MODIFIERS-<left>, <right>, <up> and <down> to windmove-left and the rest, in windmove-mode-map. " +
    "MODIFIERS is a modifier or a list of them, shift by default; none binds the bare arrow keys.",
  run: () => windmoveDefaultKeybindings(),
});

// Displaying the next command's buffer in a direction.

/**
 * Has the next command show its buffer in the window in a direction, as
 * windmove-display-in-direction: left, right, up, down, same-window,
 * new-frame or new-tab, splitting the selected window if there is none
 * that way. The window is then selected, or not, as
 * windmove-display-no-select and a C-u prefix say.
 */
export function windmoveDisplayInDirection(dir: string, arg?: e8.PrefixArg): void {
  const noSelect = Array.isArray(arg) !== !nil(e8.variable("windmove-display-no-select"));
  displayBufferOverrideNextCommand(
    (_buffer, alist) => {
      let type: "reuse" | "window" | "frame" | "tab" = "reuse";
      let window: e8.Window | undefined;
      if (dir === "new-tab") {
        e8.letBind({ "tab-bar-new-tab-choice": true }, () => e8.call("tab-bar-new-tab"));
        type = "tab";
        window = e8.selectedWindow();
      } else if (dir === "new-frame") {
        // pop-up-frame-parameters and pop-up-frame-alist are not read: E8's frames take none.
        const frame = e8.makeFrame();
        if (nil(alistGet(alist, "inhibit-switch-frame"))) maybeRaiseFrame(frame);
        type = "frame";
        window = e8.frameSelectedWindow(frame);
      } else if (dir === "same-window") {
        window = e8.selectedWindow();
      } else {
        window = windowInDirection(dir, null, e8.variable("windmove-allow-all-windows"), prefixValue(arg), e8.variable("windmove-wrap-around"), Symbol.for("nomini"));
      }
      if (window === undefined) {
        window = splitWindow(null, null, splitSide(dir));
        type = "window";
      }
      return [window, type];
    },
    (oldWindow, newWindow) => {
      const target = noSelect ? oldWindow : newWindow;
      if (symName(e8.variable("windmove-display-no-select")) !== "ignore" && target !== undefined && e8.windowLiveP(target)) e8.selectWindow(target);
    },
  );
}
e8.defun("windmove-display-in-direction", (dir: e8.Value, arg?: e8.PrefixArg) => {
  windmoveDisplayInDirection(symName(dir) ?? "", arg ?? null);
  return null;
});

const DISPLAY_WHERE: Record<string, string> = {
  left: "in window to the left of the current one",
  right: "in window to the right of the current one",
  up: "in window above the current one",
  down: "in window below the current one",
  "same-window": "in the same window",
  "new-frame": "in a new frame",
  "new-tab": "in a new tab",
};
for (const dir of [...DIRECTIONS, "same-window", "new-frame", "new-tab"]) {
  e8.defineCommand({
    name: `windmove-display-${dir}`,
    doc: `Display the next buffer ${DISPLAY_WHERE[dir]}. See windmove-display-in-direction for the prefix argument and windmove-display-no-select.`,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.PrefixArg) => windmoveDisplayInDirection(dir, arg),
  });
}

export function windmoveDisplayDefaultKeybindings(modifiers?: e8.Value): void {
  windmoveInstallDefaults(undefined, modifierList(modifiers, ["shift", "meta"]), DISPLAY);
}
e8.defineCommand({
  name: "windmove-display-default-keybindings",
  doc:
    "Bind MODIFIERS-<left>, <right>, <up>, <down>, 0, f and t to windmove-display-left and the rest, in windmove-mode-map. " +
    "MODIFIERS is a modifier or a list of them, shift and meta by default; none binds the bare keys.",
  run: () => windmoveDisplayDefaultKeybindings(),
});

// Deleting the window in a direction.

/**
 * Deletes the window in a direction, as windmove-delete-in-direction:
 * with C-u, also kills its buffer; with M-0, deletes the selected window
 * and selects that one.
 */
export function windmoveDeleteInDirection(dir: string, arg?: e8.PrefixArg): void {
  const other = windowInDirection(dir, null, e8.variable("windmove-allow-all-windows"), typeof arg === "number" ? arg : null, e8.variable("windmove-wrap-around"), Symbol.for("nomini"));
  if (other === undefined) e8.userError(`No window ${dir} from selected window`);
  if (Array.isArray(arg) && arg[0] === 4) e8.call("kill-buffer", e8.windowBuffer(other)!);
  if (arg !== 0) {
    deleteWindow(other);
  } else {
    deleteWindow(e8.selectedWindow());
    e8.selectWindow(other);
  }
}
e8.defun("windmove-delete-in-direction", (dir: e8.Value, arg?: e8.PrefixArg) => {
  windmoveDeleteInDirection(symName(dir) ?? "", arg ?? null);
  return null;
});

for (const dir of DIRECTIONS) {
  e8.defineCommand({
    name: `windmove-delete-${dir}`,
    doc: `Delete the window ${WHERE[dir]} the current one. With C-u, also kill its buffer; with M-0, delete the selected window and select that one.`,
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.PrefixArg) => windmoveDeleteInDirection(dir, arg),
  });
}

export function windmoveDeleteDefaultKeybindings(prefix?: e8.Value, modifiers?: e8.Value): void {
  const keys = nil(prefix) ? "C-x" : symName(prefix) === "none" ? undefined : Array.isArray(prefix) ? prefix.join(" ") : String(prefix);
  windmoveInstallDefaults(keys, modifierList(modifiers, ["shift"]), DELETE);
}
e8.defineCommand({
  name: "windmove-delete-default-keybindings",
  doc:
    "Bind PREFIX MODIFIERS-<left>, <right>, <up> and <down> to windmove-delete-left and the rest, in windmove-mode-map. " +
    "PREFIX is C-x by default, none for no prefix; MODIFIERS is a modifier or a list of them, shift by default, none for the bare keys.",
  run: () => windmoveDeleteDefaultKeybindings(),
});

// Swapping states with the window in a direction.

/**
 * Swaps what two live windows show, as window.el's window-swap-states
 * without SIZE: each one's buffer, start, point, dedication and previous and next buffers, and overlays' window
 * properties; the selected one's selection goes with its state. Here,
 * private to windmove, until window.ts has window-state-get and
 * window-state-put in Emacs's shape and window-swap-states with them.
 */
function windowSwapStates(window1: e8.Window, window2: e8.Window): void {
  if (window1 === window2) return;
  const state = (w: e8.Window) => ({
    buffer: e8.windowBuffer(w)!,
    start: e8.windowStart(w),
    point: e8.windowPoint(w),
    dedicated: e8.windowDedicatedP(w) ?? null,
    prev: e8.windowPrevBuffers(w),
    next: e8.windowNextBuffers(w),
    selected: w === e8.selectedWindow(),
  });
  const put = (s: ReturnType<typeof state>, w: e8.Window): void => {
    e8.setWindowDedicatedP(w, null);
    e8.setWindowBuffer(w, s.buffer);
    e8.setWindowStart(w, s.start);
    e8.setWindowPoint(w, s.point);
    e8.setWindowDedicatedP(w, s.dedicated);
    e8.setWindowPrevBuffers(w, s.prev);
    e8.setWindowNextBuffers(w, s.next);
  };
  const s1 = state(window1);
  const s2 = state(window2);
  put(s1, window2);
  put(s2, window1);
  for (const buffer of new Set([s1.buffer, s2.buffer])) {
    e8.withCurrentBuffer(buffer, () => {
      for (const overlay of e8.overlaysIn(e8.pointMin(), e8.pointMax())) {
        const w = e8.overlayGet(overlay, "window");
        if (w === window1) e8.overlayPut(overlay, "window", window2);
        else if (w === window2) e8.overlayPut(overlay, "window", window1);
      }
    });
  }
  if (s1.selected) e8.selectWindow(window2);
  else if (s2.selected) e8.selectWindow(window1);
}

/** Swaps the selected window's state with the window's in a direction, as windmove-swap-states-in-direction. */
export function windmoveSwapStatesInDirection(dir: string): void {
  const other = windowInDirection(dir, null, e8.variable("windmove-allow-all-windows"), null, e8.variable("windmove-wrap-around"), Symbol.for("nomini"));
  if (other === undefined || other === e8.minibufferWindow()) e8.userError(`No window ${dir} from selected window`);
  if (e8.selectedWindow() === e8.minibufferWindow()) e8.userError("Can't swap window with the minibuffer");
  windowSwapStates(e8.selectedWindow(), other);
}
e8.defun("windmove-swap-states-in-direction", (dir: e8.Value) => {
  windmoveSwapStatesInDirection(symName(dir) ?? "");
  return null;
});

const SWAP_WHERE: Record<string, string> = { left: "on the left from", right: "on the right from", up: "above from", down: "below from" };
for (const dir of DIRECTIONS) {
  e8.defineCommand({
    name: `windmove-swap-states-${dir}`,
    doc: `Swap the states with the window ${SWAP_WHERE[dir]} the current one.`,
    run: () => windmoveSwapStatesInDirection(dir),
  });
}

export function windmoveSwapStatesDefaultKeybindings(modifiers?: e8.Value): void {
  windmoveInstallDefaults(undefined, modifierList(modifiers, ["shift", "super"]), SWAP);
}
e8.defineCommand({
  name: "windmove-swap-states-default-keybindings",
  doc:
    "Bind MODIFIERS-<left>, <right>, <up> and <down> to windmove-swap-states-left and the rest, in windmove-mode-map. " +
    "MODIFIERS is a modifier or a list of them, shift and super by default; none binds the bare arrow keys.",
  run: () => windmoveSwapStatesDefaultKeybindings(),
});
